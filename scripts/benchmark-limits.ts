/**
 * Goal 0008's overload controls: push every configured finite policy past its
 * bound against the real built site in a real Chromium, and record what the
 * reader is left with.
 *
 * `docs/goals/0008-acceptable-browser-cost.md` states the requirement in one
 * row — "Exceed each configured boundary and verify bounded failure, cleanup,
 * static usability and successful later retry" — and
 * `docs/core-design/build-and-runtime.md` owns the policies themselves. The
 * cost side of the same goal is `scripts/benchmark-snapshot.ts`; this file is
 * the wall side, and the two deliberately share a corpus generator, a browser
 * host, and a report directory so a comparison between them is not a
 * comparison between two harnesses.
 *
 * ## What makes an observation here load-bearing
 *
 * - **The policy values are imported, not restated.** `WORKER_LIMITS`,
 *   `MAX_PAGE_SIZE`, `DEFAULT_PAGE_SIZE`, `LOCAL_NODE_LIMIT`, and
 *   `GLOBAL_NODE_LIMIT` come from the modules that enforce them, so a changed
 *   bound changes what this runner expects to exceed.
 * - **The Worker-side WASM counter is installed before any request is
 *   delivered.** The page probe holds `postMessage` until the runner has
 *   patched `WebAssembly.instantiate*` inside the real Worker, so a zero
 *   counter cannot mean "the patch was late"; the probe's `patched` flag is
 *   the positive control.
 * - **Route switching lives in this file's own static server**, as a mutable
 *   table keyed by pathname. `dist/` is never patched, so the artifact under
 *   test is byte-for-byte the one the build produced.
 * - **Every control restores what it changed and then retries.** The retry is
 *   asserted, not assumed: a failure that leaves a poisoned initialization
 *   promise is exactly the defect this runner exists to catch.
 *
 * A control that throws records `fail` with its message and the run continues;
 * a control that cannot be driven at all records `not-implemented` with its
 * reason, never a silent pass. The client-level pending bound also runs
 * `tests/snapshot-client.test.ts` and records its outcome, because a browser
 * gate that happens to be infeasible must still leave the module-level
 * evidence behind.
 *
 * Usage: `node scripts/benchmark-limits.ts [--cli <path>] [--browser chromium|chrome|edge]
 * [--device "Pixel 7"]`
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { arch, cpus, release as osRelease, tmpdir, totalmem, type as osType } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page, Worker as PlaywrightWorker } from 'playwright';

import { generateCorpus, type CorpusTopology } from './generate-corpus.ts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../src/lib/snapshot-queries.ts';
import { GLOBAL_NODE_LIMIT, LOCAL_NODE_LIMIT } from '../src/lib/graph-selection.ts';
import { WORKER_LIMITS } from '../src/lib/worker-protocol.ts';
import {
  benchmarkBrowserOptionsFromValues,
  parseBenchmarkOptions,
  resolveBenchmarkBrowser,
  type BenchmarkBrowserReport,
} from './benchmark-browser.ts';
import {
  assertCandidateIdentityStable,
  candidateIdentity,
  type CandidateIdentity,
} from './benchmark-snapshot.ts';
import {
  assertRepositoryIdentityClean,
  benchmarkReportDirectory,
  BenchmarkIdentityDriftError,
  repositoryIdentity,
  sha256File,
  type RepositoryIdentity,
} from './benchmark-identity.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'anc.mjs');
const CLIENT_BOUND_TEST_PATH = 'tests/snapshot-client.test.ts';
const CLIENT_BOUND_TEST_FILE = resolve(ROOT, CLIENT_BOUND_TEST_PATH);

// A measured 300-note build's busiest published node had 11 distinct
// neighbours. At 600 notes, the same seed/topology produced 15, so this lean
// workload exercises the local truncation branch without inventing a graph.
const CORPUS_NOTES = 600;
const CORPUS_SEED = 7;
/** The generator's default hub-heavy graph: goal 0008's skew/hub topology. */
const CORPUS_TOPOLOGY: CorpusTopology = 'skewed';
/** Deterministic tags, aliases, and mixed-script headings for every note. */
const CORPUS_METADATA = true;
/**
 * Must match `OPEN_DELAY_MS` in `src/scripts/link-preview.ts`, which is not
 * exported. The retry gestures below move the pointer away and wait past this
 * delay so a hover is a fresh intent rather than a continuation.
 */
const HOVER_DELAY_MS = 120;
/** Extra wall-clock room past a deadline before a timeout is called unbounded. */
const DEADLINE_MARGIN_MS = 2_000;
/** Keep the synthetic over-limit stream paced so the peer can abort at the cap. */
const PACED_BODY_CHUNK_BYTES = 64 * 1024;
const PACED_BODY_DELAY_MS = 4;
const PACED_BODY_ABORT_SLACK_BYTES = PACED_BODY_CHUNK_BYTES * 16;

/** The exact set of browser controls required for a successful limits run. */
export const REQUIRED_CONTROL_IDS = [
  'snapshot-byte-cap',
  'wasm-byte-cap',
  'startup-deadline',
  'query-deadline',
  'page-size-clamp',
  'rendering-policy',
  'pending-bound',
] as const;

export interface LimitsOptions {
  cli: string;
  browser: 'chromium' | 'chrome' | 'edge';
  device: string | undefined;
}

/** Parse the complete limits-runner argv, resolving exactly one candidate CLI. */
export function parseLimitsOptions(argv: readonly string[], cwd = process.cwd()): LimitsOptions {
  const values = parseBenchmarkOptions(argv, ['cli', 'browser', 'device']);
  const browser = benchmarkBrowserOptionsFromValues(values);
  const requestedCli = values.get('cli');
  const cli = requestedCli === undefined ? BINARY : isAbsolute(requestedCli) ? requestedCli : resolve(cwd, requestedCli);
  return { cli, browser: browser.browser, device: browser.device };
}

type RouteOverride =
  | { kind: 'stall' }
  | { kind: 'body'; body?: Buffer; contentType?: string; delivery?: BodyDelivery }
  | {
      kind: 'paced-body';
      bodyBytes: number;
      fill: number;
      contentType: string;
      pace: { chunkBytes: number; delayMs: number };
      delivery: BodyDelivery;
    };

export interface BodyDeliveryObservation {
  bodyBytes: number;
  bytesWritten: number;
  chunksWritten: number;
  peerAborted: boolean;
  completed: boolean;
}

interface BodyDelivery extends BodyDeliveryObservation {
  settled: Promise<void>;
  settle: () => void;
}

interface Site {
  origin: string;
  dist: string;
  headers: { source: string; sha256: string };
  /** Exact-pathname overrides; an absent pathname serves the built file. */
  routes: Map<string, RouteOverride>;
  /** Request count per pathname, for vacuity checks. */
  hits: Map<string, number>;
  close(): Promise<void>;
}

interface HeaderRule {
  matcher: RegExp;
  headers: Record<string, string>;
}

export interface SiteHeaders {
  source: 'dist/_headers';
  sha256: string;
  rules: HeaderRule[];
}

/**
 * Parse the Cloudflare Pages `_headers` grammar: an unindented line is a path
 * pattern and an indented `Name: value` line attaches to the pattern above it.
 * The shipped file carries no `:placeholder` patterns, so unlike the browser
 * tests' copy this one does not need to translate them.
 */
function headerRules(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const escaped = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      rules.push({ matcher: new RegExp(`^${escaped.replace(/\*/g, '.*')}$`), headers: {} });
      continue;
    }
    const rule = rules.at(-1);
    if (rule === undefined) continue;
    const trimmed = line.trim();
    const separator = trimmed.indexOf(':');
    if (separator > 0) rule.headers[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).trim();
  }
  return rules;
}

/** Read the headers emitted by the candidate build, never the checkout source. */
export function loadSiteHeaders(dist: string): SiteHeaders {
  const path = join(dist, '_headers');
  const bytes = readFileSync(path);
  return {
    source: 'dist/_headers',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    rules: headerRules(bytes.toString('utf8')),
  };
}

function createBodyDelivery(bodyBytes: number): BodyDelivery {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    bodyBytes,
    bytesWritten: 0,
    chunksWritten: 0,
    peerAborted: false,
    completed: false,
    settled,
    settle,
  };
}

/**
 * Prove that an over-limit body was stopped by the imported byte cap rather
 * than downloaded in full and rejected later by its digest.
 */
export function assertPacedBodyBound(delivery: BodyDeliveryObservation, capBytes: number): void {
  assert.ok(delivery.bodyBytes > capBytes, 'the synthetic body did not exceed the imported cap');
  assert.ok(delivery.bytesWritten >= capBytes, `the peer closed before reaching the imported cap: ${delivery.bytesWritten}`);
  assert.ok(delivery.bytesWritten < delivery.bodyBytes, 'the peer received the full oversized body');
  assert.equal(delivery.peerAborted, true, 'the peer did not observe the fetch cancellation');
  assert.equal(delivery.completed, false, 'the oversized response completed instead of being aborted');
  assert.ok(
    delivery.bytesWritten <= capBytes + PACED_BODY_ABORT_SLACK_BYTES,
    `the peer received too far past the imported cap: ${delivery.bytesWritten} > ${capBytes + PACED_BODY_ABORT_SLACK_BYTES}`,
  );
}

function observeBodyDelivery(delivery: BodyDelivery): BodyDeliveryObservation {
  return {
    bodyBytes: delivery.bodyBytes,
    bytesWritten: delivery.bytesWritten,
    chunksWritten: delivery.chunksWritten,
    peerAborted: delivery.peerAborted,
    completed: delivery.completed,
  };
}

async function waitForBodyDelivery(delivery: BodyDelivery, timeoutMs = 30_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      delivery.settled,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('paced body delivery did not settle')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForWritable(response: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      response.off('error', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
    response.once('error', done);
  });
}

async function writePacedBody(
  response: ServerResponse,
  bodyBytes: number,
  fill: number,
  headers: Record<string, string>,
  contentType: string,
  pace: { chunkBytes: number; delayMs: number },
  delivery: BodyDelivery,
): Promise<void> {
  try {
    response.writeHead(200, {
      ...headers,
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
    });
    const reusableChunk = Buffer.alloc(Math.min(pace.chunkBytes, bodyBytes), fill);
    for (let offset = 0; offset < bodyBytes; offset += pace.chunkBytes) {
      if (response.destroyed || response.writableEnded) return;
      const chunkBytes = Math.min(pace.chunkBytes, bodyBytes - offset);
      const chunk = chunkBytes === reusableChunk.length ? reusableChunk : reusableChunk.subarray(0, chunkBytes);
      const ready = response.write(chunk);
      delivery.bytesWritten += chunk.length;
      delivery.chunksWritten += 1;
      if (!ready) await waitForWritable(response);
      if (response.destroyed || response.writableEnded) return;
      if (offset + chunk.length < bodyBytes) {
        await new Promise<void>((resolve) => setTimeout(resolve, pace.delayMs));
      }
    }
    if (!response.destroyed && !response.writableEnded) response.end();
  } catch {
    if (!response.destroyed && !response.writableEnded) response.destroy();
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.sqlite': 'application/octet-stream',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Await one loopback listen and surface bind errors to the caller. */
export function listenServer(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, '127.0.0.1');
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Serve a built site with the shipped headers, plus this runner's mutable
 * routes.
 *
 * Synthetic bodies are served `no-store` so a retry after the route is cleared
 * must reach the server again; a cached 64 MiB refusal would make the retry
 * case untestable. Real files keep the candidate's emitted `dist/_headers`
 * rules that name them and the platform's revalidating default otherwise, so a
 * packaged CLI is measured under its own deployment policy.
 *
 * A `stall` route writes no response head at all: the reader stays in download
 * until its own deadline fires, which is the only thing this control is about.
 */
export async function startSite(dist: string): Promise<Site> {
  const loadedHeaders = loadSiteHeaders(dist);
  const rules = loadedHeaders.rules;
  const routes = new Map<string, RouteOverride>();
  const hits = new Map<string, number>();
  const stalled = new Set<ServerResponse>();
  const server: Server = createServer((request, response) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400);
      response.end('bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const headers: Record<string, string> = {};
    for (const rule of rules) if (rule.matcher.test(pathname)) Object.assign(headers, rule.headers);
    if (headers['Cache-Control'] === undefined) {
      headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
    }
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);

    const override = routes.get(pathname);
    if (override !== undefined && override.kind === 'stall') {
      stalled.add(response);
      response.on('close', () => stalled.delete(response));
      return;
    }
    if (override !== undefined && (override.kind === 'body' || override.kind === 'paced-body')) {
      const delivery = override.delivery;
      if (delivery !== undefined) {
        response.once('finish', () => {
          delivery.completed = true;
          delivery.settle();
        });
        response.once('close', () => {
          if (!delivery.completed) delivery.peerAborted = true;
          delivery.settle();
        });
      }
      if (override.kind === 'body') {
        const body = override.body ?? Buffer.alloc(0);
        response.writeHead(200, {
          ...headers,
          'Cache-Control': 'no-store',
          'Content-Type': override.contentType ?? 'application/octet-stream',
          'Content-Length': String(body.length),
        });
        response.end(body);
        if (delivery !== undefined) {
          delivery.bytesWritten = body.length;
          delivery.chunksWritten = body.length === 0 ? 0 : 1;
        }
      } else {
        void writePacedBody(
          response,
          override.bodyBytes,
          override.fill,
          headers,
          override.contentType,
          override.pace,
          override.delivery,
        );
      }
      return;
    }

    const root = resolve(dist);
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403, headers);
      response.end();
      return;
    }
    try {
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        ...headers,
        'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        'Content-Length': String(stat.size),
      });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404, headers);
      response.end('not found');
    }
  });
  try {
    await listenServer(server, 0);
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    dist,
    headers: { source: loadedHeaders.source, sha256: loadedHeaders.sha256 },
    routes,
    hits,
    close(): Promise<void> {
      server.closeAllConnections();
      return new Promise((done) => server.close(() => done()));
    },
  };
}

/** A deterministic identity over a corpus directory: sorted paths plus bytes. */
function hashDirectory(directory: string): { sha256: string; files: number } {
  const hash = createHash('sha256');
  let files = 0;
  const walk = (current: string, prefix: string): void => {
    for (const name of [...readdirSync(current)].sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path, `${prefix}${name}/`);
      } else {
        files += 1;
        hash.update(`${prefix}${name}\0`);
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  walk(directory, '');
  return { sha256: hash.digest('hex'), files };
}

function countFiles(directory: string): number {
  let files = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files += countFiles(path);
    else files += 1;
  }
  return files;
}

function gitOutput(args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

interface ProbeReply {
  id?: number;
  ok?: boolean;
  code?: string;
}

export interface ProbeIntent {
  type?: string;
  at: number;
  sentAt?: number;
  dropped?: boolean;
  held?: boolean;
}

export interface ProbeSnapshot {
  workers: number;
  terminations: number;
  replies: ProbeReply[];
  admitted: number;
  sent: number;
  dropped: number;
  held: number;
  pageWasmCalls: number;
  pageWasmPatched: boolean;
  intents: ProbeIntent[];
  terminationTimes: number[];
}

/** Compute a duration from the page-clock intent and termination timestamps. */
export function elapsedFromIntent(intentAt: number | undefined, terminationAt: number | undefined): number {
  assert.ok(Number.isFinite(intentAt), 'the probe did not record the intercepted request intent');
  assert.ok(Number.isFinite(terminationAt), 'the probe did not record the Worker termination');
  assert.ok(terminationAt! >= intentAt!, 'the page-clock termination preceded the request intent');
  return terminationAt! - intentAt!;
}

/**
 * Install the page-side instrument before any page script runs.
 *
 * `admitted` counts every `postMessage` the page's client attempted;
 * `sent` counts the ones the real Worker received. Holding between the two is
 * what lets the runner patch the Worker's `WebAssembly` before the first
 * request is delivered, and counting both is what makes "the extra request was
 * rejected without dispatch" a measurement rather than an absence.
 */
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface LimitsState {
      workers: number;
      terminations: number;
      replies: { id?: number; ok?: boolean; code?: string }[];
      intents: ProbeIntent[];
      admitted: number;
      sent: number;
      dropped: number;
      dropTypes: string[] | null;
      hold: boolean;
      held: { worker: Worker; message: unknown; transfer: unknown[]; intent: ProbeIntent }[];
      pageWasmCalls: number;
      pageWasmPatched: boolean;
      terminationTimes: number[];
    }
    const state: LimitsState = {
      workers: 0,
      terminations: 0,
      replies: [],
      intents: [],
      admitted: 0,
      sent: 0,
      dropped: 0,
      dropTypes: null,
      hold: false,
      held: [],
      pageWasmCalls: 0,
      pageWasmPatched: false,
      terminationTimes: [],
    };
    (window as unknown as { __limits: LimitsState }).__limits = state;

    // Page-level WASM instrumentation: the runtime's WASM belongs to the
    // Worker, but a document-level counter distinguishes "the page itself
    // instantiated something" from "nothing in this document ever did".
    const wasm = WebAssembly as unknown as Record<string, unknown>;
    for (const name of ['instantiate', 'compile', 'instantiateStreaming']) {
      const original = wasm[name];
      if (typeof original !== 'function') continue;
      wasm[name] = function (...args: unknown[]): unknown {
        state.pageWasmCalls += 1;
        return Reflect.apply(original as (...inner: unknown[]) => unknown, wasm, args);
      };
    }
    state.pageWasmPatched = true;

    const OriginalWorker = window.Worker;
    // The prototype must be captured before `window.Worker` is replaced:
    // after the replacement the global `Worker` names the wrapper, and the
    // wrapper's prototype is not in the chain of any instance it constructs.
    // Patching late silently leaves the counters at zero, which reads exactly
    // like the behavior they exist to measure.
    const workerPrototype = OriginalWorker.prototype;
    const wrappedWorker = function (scriptURL: string | URL, options?: WorkerOptions): Worker {
      const worker = new OriginalWorker(scriptURL, options);
      state.workers += 1;
      worker.addEventListener('message', (event: MessageEvent) => {
        const reply = event.data as { id?: number; ok?: boolean; code?: string } | null;
        if (reply !== null && reply !== undefined && typeof reply.ok === 'boolean') {
          state.replies.push({ id: reply.id, ok: reply.ok, code: reply.code });
        }
      });
      return worker;
    };
    window.Worker = wrappedWorker as unknown as typeof Worker;

    const realPostMessage = workerPrototype.postMessage;
    workerPrototype.postMessage = function (this: Worker, message: unknown, ...transfer: unknown[]): void {
      state.admitted += 1;
      const type = (message as { type?: string } | null)?.type;
      const intent: ProbeIntent = { type, at: performance.now() };
      state.intents.push(intent);
      if (state.dropTypes !== null && type !== undefined && state.dropTypes.includes(type)) {
        intent.dropped = true;
        state.dropped += 1;
        return;
      }
      if (state.hold) {
        intent.held = true;
        state.held.push({ worker: this, message, transfer, intent });
        return;
      }
      state.sent += 1;
      intent.sentAt = performance.now();
      (realPostMessage as (this: Worker, inner: unknown, ...rest: unknown[]) => void).call(
        this,
        message,
        ...transfer,
      );
    };
    const realTerminate = workerPrototype.terminate;
    workerPrototype.terminate = function (this: Worker): void {
      state.terminations += 1;
      state.terminationTimes.push(performance.now());
      realTerminate.call(this);
    };
    (window as unknown as { __limitsRelease: () => void }).__limitsRelease = () => {
      state.hold = false;
      for (const entry of state.held.splice(0)) {
        state.sent += 1;
        entry.intent.sentAt = performance.now();
        (realPostMessage as (this: Worker, inner: unknown, ...rest: unknown[]) => void).call(
          entry.worker,
          entry.message,
          ...entry.transfer,
        );
      }
    };
  });
}

async function probeOf(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __limits: {
          workers: number;
          terminations: number;
          replies: { id?: number; ok?: boolean; code?: string }[];
          intents: ProbeIntent[];
          admitted: number;
          sent: number;
          dropped: number;
          held: unknown[];
          pageWasmCalls: number;
          pageWasmPatched: boolean;
          terminationTimes: number[];
        };
      }
    ).__limits;
    return {
      workers: state.workers,
      terminations: state.terminations,
      replies: state.replies.slice(),
      intents: state.intents.map((intent) => ({ ...intent })),
      admitted: state.admitted,
      sent: state.sent,
      dropped: state.dropped,
      held: state.held.length,
      pageWasmCalls: state.pageWasmCalls,
      pageWasmPatched: state.pageWasmPatched,
      terminationTimes: state.terminationTimes.slice(),
    };
  });
}

async function setHold(page: Page, hold: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __limits: { hold: boolean } }).__limits.hold = value;
  }, hold);
}

async function setDropTypes(page: Page, types: string[] | null): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __limits: { dropTypes: string[] | null } }).__limits.dropTypes = value;
  }, types);
}

async function releaseHeld(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __limitsRelease: () => void }).__limitsRelease());
}

async function patchWorkerWasm(worker: PlaywrightWorker): Promise<void> {
  await worker.evaluate(() => {
    const scope = self as unknown as { __limitsWasmCalls: number; __limitsWasmPatched: boolean };
    scope.__limitsWasmCalls = 0;
    scope.__limitsWasmPatched = false;
    const wasm = WebAssembly as unknown as Record<string, unknown>;
    for (const name of ['instantiate', 'compile', 'instantiateStreaming']) {
      const original = wasm[name];
      if (typeof original !== 'function') continue;
      wasm[name] = function (...args: unknown[]): unknown {
        scope.__limitsWasmCalls += 1;
        return Reflect.apply(original as (...inner: unknown[]) => unknown, wasm, args);
      };
    }
    scope.__limitsWasmPatched = true;
  });
}

async function readWorkerWasm(worker: PlaywrightWorker): Promise<{ calls: number; patched: boolean }> {
  return worker.evaluate(() => {
    const scope = self as unknown as { __limitsWasmCalls: number; __limitsWasmPatched: boolean };
    return { calls: scope.__limitsWasmCalls, patched: scope.__limitsWasmPatched };
  });
}

/** One message down the real built Worker chunk, with no client wrapper. */
async function askWorker(
  page: Page,
  scriptPath: string,
  message: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ({ path, sent, timeout }) => {
      const worker = new Worker(path, { type: 'module' });
      try {
        return await new Promise<Record<string, unknown>>((done, failed) => {
          const timer = setTimeout(() => failed(new Error('direct worker timeout')), timeout);
          worker.addEventListener('message', (event: MessageEvent) => {
            const reply = event.data as { id?: number } | null;
            if (reply?.id === sent['id']) {
              clearTimeout(timer);
              done(reply as unknown as Record<string, unknown>);
            }
          });
          worker.addEventListener('error', () => {
            clearTimeout(timer);
            failed(new Error('direct worker error'));
          });
          worker.postMessage(sent);
        });
      } finally {
        worker.terminate();
      }
    },
    { path: scriptPath, sent: message, timeout: timeoutMs },
  );
}

interface ClientChunk {
  url: string;
  source: string;
}

/**
 * The built chunk that owns the shared client state.
 *
 * The client's `pending` map is module scope, so the only way to measure its
 * bound from a page is to import the exact chunk the page's own scripts
 * imported — an import of the same URL returns the same module instance.
 * `busy` and `maxPendingRequests` together are unique to that chunk in this
 * build; two matches are treated as ambiguity and reported, not guessed.
 */
function findClientChunk(dist: string): ClientChunk | null {
  const directory = join(dist, '_astro');
  const matches: string[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(join(directory, name), 'utf8');
    if (source.includes('busy') && source.includes('maxPendingRequests')) matches.push(name);
  }
  if (matches.length !== 1) return null;
  return { url: `/_astro/${matches[0]}`, source: readFileSync(join(directory, matches[0]!), 'utf8') };
}

/**
 * The exported name of the function that dispatches one operation.
 *
 * Production minification renames exports (`requestGlobalGraph` is `n` in the
 * measured build), so the mapping is read from the built chunk itself: find
 * the function whose body carries the operation's `type:` discriminator, then
 * find that local name's `export { local as exported }` pair. No hashes or
 * minified names are hardcoded, so a rebuild cannot silently bind this runner
 * to a stale artifact.
 */
function exportedDispatch(source: string, operation: string): string | undefined {
  const statement = /export\{([^}]*)\}/.exec(source);
  if (statement === null) return undefined;
  const exported = new Map<string, string>();
  for (const part of statement[1]!.split(',')) {
    const pair = /^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part);
    if (pair !== null) exported.set(pair[1]!, pair[2]!);
  }
  for (const quoted of [`type:\`${operation}\``, `type:"${operation}"`, `type:'${operation}'`]) {
    const index = source.indexOf(quoted);
    if (index < 0) continue;
    const prefix = source.slice(0, index);
    const declarations = [...prefix.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
    const local = declarations.at(-1)?.[1];
    if (local === undefined) continue;
    const name = exported.get(local);
    if (name !== undefined) return name;
  }
  return undefined;
}

/** Call one exported client helper in the page and settle its promise. */
async function clientCall(
  page: Page,
  url: string,
  exportName: string,
  args: unknown[],
): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ({ moduleUrl, name, callArgs }) => {
      const module = (await import(moduleUrl)) as Record<string, unknown>;
      const fn = module[name];
      if (typeof fn !== 'function') return { error: 'missing-export' };
      try {
        const result = await (fn as (...inner: unknown[]) => Promise<unknown>).apply(module, callArgs);
        return { result };
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        return { error: failure.code ?? failure.message ?? 'unknown' };
      }
    },
    { moduleUrl: url, name: exportName, callArgs: args },
  );
}

interface Harness {
  site: Site;
  origin: string;
  hubSlug: string;
  publishedSlugs: Set<string>;
  tagMemberCounts: ReadonlyMap<string, number>;
  paths: {
    snapshot: string;
    wasm: string;
    worker: string;
  };
  client: ClientChunk | null;
  notePath(slug: string): string;
  newContext(): Promise<BrowserContext>;
  newPage(context: BrowserContext): Promise<Page>;
  pickLink(page: Page, currentPath: string): Promise<string>;
}

function notePath(slug: string): string {
  return `/notes/${slug}/`;
}

/**
 * Collect the first published cross-note link on a page.
 *
 * The corpus's withheld links are rewritten to `/private/` at build time, so a
 * link matching `/notes/<slug>/` whose route directory exists is a link whose
 * preview must succeed once the runtime is healthy. That published-route check
 * is the difference between a retry that proves recovery and a retry that
 * proves the snapshot has no such note.
 */
function collectLink(page: Page, currentPath: string, published: Set<string>): Promise<string> {
  return page
    .$$eval('a[href^="/notes/"]', (anchors) => anchors.map((anchor) => anchor.getAttribute('href')))
    .then((hrefs) => {
      const href = hrefs.find((candidate): candidate is string => {
        if (typeof candidate !== 'string' || candidate === currentPath) return false;
        const match = /^\/notes\/([a-z0-9-]+)\/$/.exec(candidate);
        return match !== null && published.has(match[1]!);
      });
      assert.ok(href !== undefined, 'the page exposed no published cross-note link to preview');
      return href;
    });
}

async function hoverLink(page: Page, href: string): Promise<void> {
  await page.mouse.move(0, 0);
  // Past the open delay and the pointer-out grace, so each call is a fresh
  // intent rather than a continuation of the previous one.
  await page.waitForTimeout(HOVER_DELAY_MS + 130);
  await page.locator(`a[href="${href}"]`).first().hover();
}

async function articleChars(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('article')?.textContent?.length ?? 0);
}

interface StaticFallback {
  panelHidden: boolean;
  ariaDescribedBy: string | null;
  hrefPreserved: boolean;
  articleCharsBefore: number;
  articleCharsAfter: number;
}

/**
 * What every blocked phase owes the reader: a hidden panel, no stale
 * `aria-describedby`, the anchor unchanged, and the static article text intact.
 */
async function staticFallbackRecord(
  page: Page,
  href: string,
  articleCharsBefore: number,
): Promise<StaticFallback> {
  const state = await page.evaluate((expected) => {
    const link = [...document.querySelectorAll('a[href]')].find(
      (anchor) => anchor.getAttribute('href') === expected,
    );
    const panel = document.querySelector('#link-preview') as HTMLElement | null;
    return {
      panelHidden: panel?.hidden ?? false,
      ariaDescribedBy: link?.getAttribute('aria-describedby') ?? null,
      href: link?.getAttribute('href') ?? null,
      articleChars: document.querySelector('article')?.textContent?.length ?? 0,
    };
  }, href);
  const record: StaticFallback = {
    panelHidden: state.panelHidden,
    ariaDescribedBy: state.ariaDescribedBy,
    hrefPreserved: state.href === href,
    articleCharsBefore,
    articleCharsAfter: state.articleChars,
  };
  assert.equal(record.panelHidden, true, 'a failed preview left the panel visible');
  assert.equal(record.ariaDescribedBy, null, 'a hidden panel still described the link');
  assert.equal(record.hrefPreserved, true, 'the anchor lost its static href');
  assert.ok(record.articleCharsBefore > 0, 'the baseline article had no text to preserve');
  assert.ok(
    record.articleCharsAfter >= record.articleCharsBefore,
    `the static article text shrank across a failed preview: ${record.articleCharsBefore} -> ${record.articleCharsAfter}`,
  );
  return record;
}

interface ControlRecord {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'not-implemented';
  observations: Record<string, unknown>;
  failure?: string;
}

interface ControlOutcome {
  observations: Record<string, unknown>;
  notImplemented?: string;
}

interface ClientBoundTest {
  status: 'pass' | 'fail';
  total: number | null;
  passed: number | null;
  failed: number | null;
  detail: string;
}

export interface VitestJsonRun {
  status: number | null;
  stdout: string;
}

function testCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Parse the JSON reporter without treating unreadable output as a pass. */
export function parseVitestJsonResult(run: VitestJsonRun): ClientBoundTest {
  const failed = (detail: string): ClientBoundTest => ({
    status: 'fail',
    total: null,
    passed: null,
    failed: null,
    detail,
  });
  const exitDetail = `exit=${run.status}`;
  const start = run.stdout.indexOf('{');
  if (start < 0) return failed(`${exitDetail}; missing Vitest JSON reporter output`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout.slice(start));
  } catch {
    return failed(`${exitDetail}; malformed Vitest JSON reporter output`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    return failed(`${exitDetail}; Vitest JSON reporter output was not an object`);
  }
  const report = parsed as {
    success?: unknown;
    numTotalTests?: unknown;
    numPassedTests?: unknown;
    numFailedTests?: unknown;
    numPendingTests?: unknown;
    numSkippedTests?: unknown;
    numTodoTests?: unknown;
    testResults?: unknown;
  };
  if (
    typeof report.success !== 'boolean' ||
    !testCount(report.numTotalTests) ||
    !testCount(report.numPassedTests) ||
    !testCount(report.numFailedTests) ||
    !testCount(report.numPendingTests) ||
    (report.numSkippedTests !== undefined && !testCount(report.numSkippedTests)) ||
    !testCount(report.numTodoTests)
  ) {
    return failed(`${exitDetail}; incomplete Vitest JSON reporter output`);
  }

  const targetPath = process.platform === 'win32' ? CLIENT_BOUND_TEST_FILE.toLowerCase() : CLIENT_BOUND_TEST_FILE;
  const testResults = Array.isArray(report.testResults) ? report.testResults : [];
  const targetResult = testResults.find((result) => {
    if (result === null || typeof result !== 'object') return false;
    const name = (result as { name?: unknown }).name;
    if (typeof name !== 'string') return false;
    const candidate = resolve(ROOT, name);
    return (process.platform === 'win32' ? candidate.toLowerCase() : candidate) === targetPath;
  }) as { assertionResults?: unknown; status?: unknown } | undefined;
  const assertions = targetResult !== undefined && Array.isArray(targetResult.assertionResults)
    ? targetResult.assertionResults
    : [];
  const fullyPassed =
    run.status === 0 &&
    report.success &&
    report.numTotalTests > 0 &&
    report.numPassedTests === report.numTotalTests &&
    report.numFailedTests === 0 &&
    report.numPendingTests === 0 &&
    (report.numSkippedTests ?? 0) === 0 &&
    report.numTodoTests === 0 &&
    testResults.length === 1 &&
    targetResult?.status === 'passed' &&
    assertions.length === report.numTotalTests &&
    assertions.every(
      (assertion) =>
        assertion !== null &&
        typeof assertion === 'object' &&
        (assertion as { status?: unknown }).status === 'passed',
    );
  return {
    status: fullyPassed ? 'pass' : 'fail',
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    detail: `${exitDetail}; success=${report.success}; pending=${report.numPendingTests}; skipped=${report.numSkippedTests ?? 0}; todo=${report.numTodoTests}`,
  };
}

async function runControl(
  id: string,
  name: string,
  body: () => Promise<ControlOutcome>,
): Promise<ControlRecord> {
  try {
    const outcome = await body();
    if (outcome.notImplemented !== undefined) {
      return { id, name, status: 'not-implemented', observations: outcome.observations, failure: outcome.notImplemented };
    }
    return { id, name, status: 'pass', observations: outcome.observations };
  } catch (error) {
    return {
      id,
      name,
      status: 'fail',
      observations: (error as { observations?: Record<string, unknown> }).observations ?? {},
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

function withObservations(error: unknown, observations: Record<string, unknown>): never {
  (error as { observations?: Record<string, unknown> }).observations = observations;
  throw error;
}

function pacedOverLimitBody(capBytes: number, fill: number): {
  bodyBytes: number;
  fill: number;
  delivery: BodyDelivery;
} {
  const extra = Math.max(PACED_BODY_CHUNK_BYTES * 32, Math.ceil(capBytes / 8));
  const bodyBytes = capBytes + extra;
  return { bodyBytes, fill, delivery: createBodyDelivery(bodyBytes) };
}

async function controlDecodedByteCap(harness: Harness, asset: 'snapshot' | 'wasm'): Promise<ControlOutcome> {
  const observations: Record<string, unknown> = {};
  const isWasm = asset === 'wasm';
  const path = harness.paths[asset];
  const capBytes = isWasm ? WORKER_LIMITS.maxWasmBytes : WORKER_LIMITS.maxSnapshotBytes;
  const contentType = isWasm ? 'application/wasm' : 'application/octet-stream';
  const fill = isWasm ? 0x57 : 0x41;
  const context = await harness.newContext();
  try {
    const page = await harness.newPage(context);
    const currentPath = harness.notePath(harness.hubSlug);
    await page.goto(harness.origin + currentPath, { waitUntil: 'load' });
    const href = await harness.pickLink(page, currentPath);
    const baseline = await articleChars(page);

    const body = pacedOverLimitBody(capBytes, fill);
    const hitsBefore = harness.site.hits.get(path) ?? 0;
    harness.site.routes.set(path, {
      kind: 'paced-body',
      contentType,
      bodyBytes: body.bodyBytes,
      fill: body.fill,
      pace: { chunkBytes: PACED_BODY_CHUNK_BYTES, delayMs: PACED_BODY_DELAY_MS },
      delivery: body.delivery,
    });

    await setHold(page, true);
    const workerCreated = page.waitForEvent('worker', { timeout: 30_000 });
    await hoverLink(page, href);
    const worker = await workerCreated;
    await patchWorkerWasm(worker);
    await releaseHeld(page);
    await page.waitForFunction(
      () => ((window as unknown as { __limits?: { replies: unknown[] } }).__limits?.replies.length ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    );
    await waitForBodyDelivery(body.delivery);

    const firstProbe = await probeOf(page);
    const first = firstProbe.replies[0]!;
    const workerWasm = await readWorkerWasm(worker);
    const fallback = await staticFallbackRecord(page, href, baseline);
    const afterFailure = isWasm ? firstProbe : await probeOf(page);
    const deliveryEvidence = observeBodyDelivery(body.delivery);

    observations['capBytes'] = capBytes;
    observations['bodyBytes'] = body.bodyBytes;
    observations['routeHits'] = (harness.site.hits.get(path) ?? 0) - hitsBefore;
    observations['firstReply'] = first;
    observations['workerWasm'] = workerWasm;
    observations['delivery'] = deliveryEvidence;
    if (!isWasm) {
      observations['pageWasm'] = {
        calls: afterFailure.pageWasmCalls,
        patched: afterFailure.pageWasmPatched,
      };
    }
    observations['staticFallback'] = fallback;

    const assetLabel = isWasm ? 'WASM' : 'snapshot';
    assert.equal(first.ok, false, `an oversized ${assetLabel} produced a successful reply: ${JSON.stringify(first)}`);
    assert.equal(
      first.code,
      'integrity',
      isWasm
        ? `the WASM cap failed with the wrong verdict: ${JSON.stringify(first)}`
        : `the cap failed with the wrong verdict: ${JSON.stringify(first)}`,
    );
    assert.ok(
      (observations['routeHits'] as number) >= 1,
      isWasm
        ? 'the synthetic WASM was never requested, so this case is vacuous'
        : 'the synthetic body was never requested, so this case is vacuous',
    );
    assertPacedBodyBound(deliveryEvidence, capBytes);
    assert.equal(workerWasm.patched, true, 'the Worker WASM patch did not install, so a zero counter proves nothing');
    assert.equal(
      workerWasm.calls,
      0,
      isWasm
        ? 'the oversized WASM was instantiated despite the decoded-byte cap'
        : 'the oversized snapshot reached WebAssembly despite the decoded-byte cap',
    );
    if (!isWasm) {
      assert.equal(afterFailure.pageWasmCalls, 0, 'the page itself instantiated WebAssembly');
      assert.equal(afterFailure.pageWasmPatched, true, 'the page WASM patch did not install');
    }

    // Restore the real route and retry in the same document: the same Worker
    // instance must run a fresh `load()` rather than inherit the failure.
    harness.site.routes.delete(path);
    await hoverLink(page, href);
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 20_000 });
    const retryText = (await page.locator('#link-preview').textContent()) ?? '';
    const afterRetry = await probeOf(page);
    observations['retry'] = {
      panelTextLength: retryText.length,
      lastReply: afterRetry.replies.at(-1),
      workers: afterRetry.workers,
      terminations: afterRetry.terminations,
    };
    assert.ok(retryText.length > 0, `the restored ${assetLabel} produced an empty preview`);
    assert.equal(afterRetry.replies.at(-1)?.ok, true, 'the retry did not settle with a successful reply');
    return { observations };
  } catch (error) {
    return withObservations(error, observations);
  } finally {
    harness.site.routes.delete(path);
    await context.close();
  }
}

/**
 * Control 1 — decoded snapshot-byte cap.
 *
 * A body over `maxSnapshotBytes` must reject while the cap is still streaming,
 * never reach WASM, preserve the static page, and retry in the same Worker.
 */
async function controlSnapshotByteCap(harness: Harness): Promise<ControlOutcome> {
  return controlDecodedByteCap(harness, 'snapshot');
}

/** Control 2 — apply the same decoded-byte proof to the WASM asset. */
async function controlWasmByteCap(harness: Harness): Promise<ControlOutcome> {
  return controlDecodedByteCap(harness, 'wasm');
}

/**
 * Control 3 — startup deadline.
 *
 * A snapshot response that never sends its head keeps the Worker in
 * `loading`; the main-thread startup deadline must terminate it, in bounded
 * time, with no reply and the static page intact. Clearing the stall must let
 * the next intent construct a fresh Worker, which is the cleanup half:
 * `terminations` is 1 before the retry and `workers` is 2 after it.
 */
async function controlStartupDeadline(harness: Harness): Promise<ControlOutcome> {
  const observations: Record<string, unknown> = {};
  const context = await harness.newContext();
  try {
    const page = await harness.newPage(context);
    const currentPath = harness.notePath(harness.hubSlug);
    await page.goto(harness.origin + currentPath, { waitUntil: 'load' });
    const href = await harness.pickLink(page, currentPath);
    const baseline = await articleChars(page);

    harness.site.routes.set(harness.paths.snapshot, { kind: 'stall' });
    await hoverLink(page, href);
    await page.waitForFunction(
      () => ((window as unknown as { __limits?: { terminations: number } }).__limits?.terminations ?? 0) >= 1,
      undefined,
      { timeout: WORKER_LIMITS.startupDeadlineMs + DEADLINE_MARGIN_MS + 15_000 },
    );
    const whileStalled = await probeOf(page);
    const startupIntent = whileStalled.intents.findLast((intent) => intent.type === 'preview');
    const startupTermination = whileStalled.terminationTimes.at(-1);
    const elapsedMs = elapsedFromIntent(startupIntent?.at, startupTermination);
    const fallback = await staticFallbackRecord(page, href, baseline);

    observations['deadlineMs'] = WORKER_LIMITS.startupDeadlineMs;
    observations['elapsedMs'] = elapsedMs;
    observations['whileStalled'] = {
      workers: whileStalled.workers,
      terminations: whileStalled.terminations,
      replies: whileStalled.replies.length,
      sent: whileStalled.sent,
      intents: whileStalled.intents,
      terminationTimes: whileStalled.terminationTimes,
    };
    observations['staticFallback'] = fallback;

    assert.ok(elapsedMs >= WORKER_LIMITS.startupDeadlineMs, `the Worker was terminated before its startup deadline: ${elapsedMs}ms`);
    assert.ok(
      elapsedMs < WORKER_LIMITS.startupDeadlineMs + DEADLINE_MARGIN_MS + 15_000,
      `the startup deadline was not bounded in any useful sense: ${elapsedMs}ms`,
    );
    assert.equal(whileStalled.terminations, 1, 'the stalled Worker was not terminated exactly once');
    assert.equal(whileStalled.replies.length, 0, 'the stalled Worker answered, so the stall never happened');
    assert.equal(whileStalled.workers, 1, 'a second Worker was constructed without an explicit intent');

    harness.site.routes.delete(harness.paths.snapshot);
    await hoverLink(page, href);
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 20_000 });
    const retryText = (await page.locator('#link-preview').textContent()) ?? '';
    const afterRetry = await probeOf(page);
    observations['retry'] = {
      panelTextLength: retryText.length,
      lastReply: afterRetry.replies.at(-1),
      workers: afterRetry.workers,
      terminations: afterRetry.terminations,
    };
    assert.ok(retryText.length > 0, 'a later intent after the startup deadline produced an empty preview');
    assert.equal(afterRetry.replies.at(-1)?.ok, true, 'the retry after a startup deadline did not settle successfully');
    assert.equal(afterRetry.workers, 2, 'the retry reused the terminated Worker instead of constructing a fresh one');
    assert.equal(afterRetry.terminations, 1, 'the recovery terminated a Worker, so cleanup was not settled');
    return { observations };
  } catch (error) {
    return withObservations(error, observations);
  } finally {
    harness.site.routes.delete(harness.paths.snapshot);
    await context.close();
  }
}

/**
 * Control 4 — query deadline.
 *
 * After readiness, one dispatched `preview` is swallowed before the Worker
 * sees it, so no reply can ever come. The shorter request deadline must
 * terminate the Worker, `dropped` must stay 1 (no automatic retry), and
 * restoring dispatch must let the next explicit intent build a live Worker.
 */
async function controlQueryDeadline(harness: Harness): Promise<ControlOutcome> {
  const observations: Record<string, unknown> = {};
  const context = await harness.newContext();
  try {
    const page = await harness.newPage(context);
    const currentPath = harness.notePath(harness.hubSlug);
    await page.goto(harness.origin + currentPath, { waitUntil: 'load' });
    const href = await harness.pickLink(page, currentPath);

    // Warm first: the planted request below must be judged by the request
    // deadline, which only governs an initialized client.
    await hoverLink(page, href);
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 20_000 });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    const warm = await probeOf(page);
    assert.equal(warm.replies.at(-1)?.ok, true, 'the warm preview did not settle successfully');
    assert.equal(warm.workers, 1, 'the warm preview did not use exactly one Worker');

    const baseline = await articleChars(page);
    await setDropTypes(page, ['preview']);
    await hoverLink(page, href);
    await page.waitForFunction(
      () => ((window as unknown as { __limits?: { dropped: number } }).__limits?.dropped ?? 0) >= 1,
      undefined,
      { timeout: 10_000 },
    );
    assert.equal(await page.locator('#link-preview').isHidden(), true, 'the dropped request showed a panel before its deadline');
    await page.waitForFunction(
      () => ((window as unknown as { __limits?: { terminations: number } }).__limits?.terminations ?? 0) >= 1,
      undefined,
      { timeout: WORKER_LIMITS.requestDeadlineMs + DEADLINE_MARGIN_MS + 15_000 },
    );
    const blocked = await probeOf(page);
    const queryIntent = blocked.intents.findLast((intent) => intent.type === 'preview' && intent.dropped === true);
    const queryTermination = blocked.terminationTimes.at(-1);
    const elapsedMs = elapsedFromIntent(queryIntent?.at, queryTermination);
    const fallback = await staticFallbackRecord(page, href, baseline);

    observations['deadlineMs'] = WORKER_LIMITS.requestDeadlineMs;
    observations['elapsedMs'] = elapsedMs;
    observations['blocked'] = {
      dropped: blocked.dropped,
      workers: blocked.workers,
      terminations: blocked.terminations,
      replies: blocked.replies.length,
      sent: blocked.sent,
      intents: blocked.intents,
      terminationTimes: blocked.terminationTimes,
    };
    observations['staticFallback'] = fallback;

    assert.ok(elapsedMs >= WORKER_LIMITS.requestDeadlineMs, `the request was terminated before its deadline: ${elapsedMs}ms`);
    assert.ok(
      elapsedMs < WORKER_LIMITS.requestDeadlineMs + DEADLINE_MARGIN_MS + 15_000,
      `the request deadline was not bounded in any useful sense: ${elapsedMs}ms`,
    );
    assert.equal(blocked.dropped, 1, 'a second preview was dispatched without an explicit intent, so something retried automatically');
    assert.equal(blocked.terminations, 1, 'the request deadline did not terminate the unresponsive Worker exactly once');
    assert.equal(blocked.replies.length, warm.replies.length, 'a reply arrived for a request the Worker never saw');

    await setDropTypes(page, null);
    await hoverLink(page, href);
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 20_000 });
    const retryText = (await page.locator('#link-preview').textContent()) ?? '';
    const afterRetry = await probeOf(page);
    observations['retry'] = {
      panelTextLength: retryText.length,
      lastReply: afterRetry.replies.at(-1),
      workers: afterRetry.workers,
      terminations: afterRetry.terminations,
      dropped: afterRetry.dropped,
    };
    assert.ok(retryText.length > 0, 'a later intent after the request deadline produced an empty preview');
    assert.equal(afterRetry.replies.at(-1)?.ok, true, 'the retry after a request deadline did not settle successfully');
    assert.equal(afterRetry.workers, 2, 'the retry reused the terminated Worker instead of constructing a fresh one');
    assert.equal(afterRetry.dropped, 1, 'the recovery dispatched an extra request');
    return { observations };
  } catch (error) {
    return withObservations(error, observations);
  } finally {
    await context.close();
  }
}

/**
 * Control 5 — page-size clamp.
 *
 * The metadata corpus tags every published note with one CJK tag, so that
 * tag's member list is larger than `MAX_PAGE_SIZE`. `pageSize: 10000` must
 * come back as a full clamped page with a continuation and no error; the same
 * page with `MAX_PAGE_SIZE` and `MAX_PAGE_SIZE + 1` must be identical, which
 * is the clamp's observable signature; `pageSize: 0` must resolve to the
 * documented default; and paging the clamped result must enumerate exactly the
 * tag's published members. A tag whose first page is not full means no tag
 * saturated the clamp, so the control records `not-implemented` rather than
 * widening the assertion until it passes.
 */
interface PageAnswer {
  notes: unknown[];
  nextCursor: unknown;
  transport: string;
}

/** A full page plus a continuation is the proof that membership exceeds the cap. */
export function assertSaturatedPage(
  page: { notes: readonly unknown[]; nextCursor: unknown },
  maxPageSize: number = MAX_PAGE_SIZE,
): void {
  assert.equal(page.notes.length, maxPageSize, `the page did not saturate the ${maxPageSize}-note limit`);
  assert.ok(
    typeof page.nextCursor === 'string' && page.nextCursor.length > 0,
    `the page did not saturate the ${maxPageSize}-note limit: no continuation was returned`,
  );
}

/** Read the finalized DB's exact published membership for every tag. */
export function readTagMemberCounts(snapshotFile: string): Map<string, number> {
  const db = new DatabaseSync(snapshotFile, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT t.key AS tagKey, COUNT(*) AS members
         FROM tags AS t
         JOIN node_tags AS nt ON nt.tag_id = t.id
         GROUP BY t.id, t.key
         ORDER BY t.key`,
      )
      .all() as unknown as { tagKey: string; members: number }[];
    return new Map(rows.map((row) => [row.tagKey, Number(row.members)]));
  } finally {
    db.close();
  }
}

async function tagRequest(
  harness: Harness,
  page: Page,
  tagKey: string,
  cursor: string | null,
  pageSize: number,
): Promise<PageAnswer> {
  const exportName = harness.client === null ? undefined : exportedDispatch(harness.client.source, 'byTag');
  if (harness.client !== null && exportName !== undefined) {
    const reply = await clientCall(page, harness.client.url, exportName, [tagKey, cursor, pageSize]);
    if (typeof reply['error'] === 'string') {
      throw new Error(`byTag through the built client rejected: ${reply['error']}`);
    }
    const result = reply['result'] as { page: { notes: unknown[]; nextCursor: unknown } };
    return { notes: result.page.notes, nextCursor: result.page.nextCursor, transport: 'client-export' };
  }
  const reply = await askWorker(page, harness.paths.worker, {
    id: 1,
    type: 'byTag',
    tagKey,
    cursor,
    pageSize,
  });
  assert.equal(reply['ok'], true, `byTag direct reply was not ok: ${JSON.stringify(reply)}`);
  const result = reply['result'] as { page: { notes: unknown[]; nextCursor: unknown } };
  return { notes: result.page.notes, nextCursor: result.page.nextCursor, transport: 'direct-worker' };
}

async function controlPageSizeClamp(harness: Harness): Promise<ControlOutcome> {
  const observations: Record<string, unknown> = {};
  const context = await harness.newContext();
  try {
    const page = await harness.newPage(context);
    await page.goto(harness.origin + '/graph/', { waitUntil: 'load' });
    const tags = await page.$$eval(
      '[data-graph-region="site-graph"] [data-graph-tag] option',
      (options) => options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== ''),
    );
    observations['candidateTags'] = tags.length;

    const saturatedTag =
      [...tags].sort().find((tagKey) => (harness.tagMemberCounts.get(tagKey) ?? 0) > MAX_PAGE_SIZE) ?? null;

    if (saturatedTag !== null) {
      const expectedMembers = harness.tagMemberCounts.get(saturatedTag);
      assert.ok(expectedMembers !== undefined, `the finalized DB has no membership count for tag ${saturatedTag}`);
      assert.ok(
        expectedMembers > MAX_PAGE_SIZE,
        `the finalized DB says tag ${saturatedTag} has only ${expectedMembers} members`,
      );
      // Confirm the browser result saturates before issuing an over-limit request.
      const first = await tagRequest(harness, page, saturatedTag, null, MAX_PAGE_SIZE);
      assertSaturatedPage(first, MAX_PAGE_SIZE);
      observations['transport'] = first.transport;
      const large = await tagRequest(harness, page, saturatedTag, null, 10_000);
      const atMax = await tagRequest(harness, page, saturatedTag, null, MAX_PAGE_SIZE);
      const overMax = await tagRequest(harness, page, saturatedTag, null, MAX_PAGE_SIZE + 1);
      const atDefault = await tagRequest(harness, page, saturatedTag, null, 0);
      const pages = [large];
      const seenCursors = new Set<string>();
      let cursor = typeof large.nextCursor === 'string' ? large.nextCursor : null;
      while (cursor !== null) {
        assert.ok(!seenCursors.has(cursor), `the saturated tag repeated cursor ${cursor}`);
        seenCursors.add(cursor);
        const next = await tagRequest(harness, page, saturatedTag, cursor, 10_000);
        pages.push(next);
        cursor = typeof next.nextCursor === 'string' ? next.nextCursor : null;
      }
      const next = pages[1];
      assert.ok(next !== undefined, 'the saturated tag returned no continuation page');

      observations['mode'] = 'tag-saturated';
      observations['saturated'] = true;
      observations['requestedPageSize'] = 10_000;
      observations['maxPageSize'] = MAX_PAGE_SIZE;
      observations['defaultPageSize'] = DEFAULT_PAGE_SIZE;
      observations['returnedNotes'] = large.notes.length;
      observations['nextCursor'] = large.nextCursor;
      observations['clampedEqualsMax'] = JSON.stringify(large) === JSON.stringify(atMax);
      observations['clampedEqualsOverMax'] = JSON.stringify(large) === JSON.stringify(overMax);
      observations['defaultReturnedNotes'] = atDefault.notes.length;
      observations['defaultApplied'] = atDefault.notes.length === DEFAULT_PAGE_SIZE;
      observations['pagesEnumerated'] = pages.reduce((total, current) => total + current.notes.length, 0);
      observations['expectedTagMembers'] = expectedMembers;

      assert.equal(large.notes.length, MAX_PAGE_SIZE, 'the saturating tag did not return a full clamped page');
      assert.ok(large.nextCursor !== null, 'the saturating tag returned no continuation');
      assert.equal(observations['clampedEqualsMax'], true, 'pageSize 10000 and MAX_PAGE_SIZE selected different pages');
      assert.equal(observations['clampedEqualsOverMax'], true, 'pageSize 10000 and MAX_PAGE_SIZE + 1 selected different pages');
      assert.equal(atDefault.notes.length, DEFAULT_PAGE_SIZE, 'pageSize 0 did not resolve to the default page size');
      assert.equal(
        observations['pagesEnumerated'],
        expectedMembers,
        'paging the clamped result did not enumerate every member of the saturated tag',
      );
      return { observations };
    }

    observations['mode'] = 'tag-not-saturated';
    observations['saturated'] = false;
    observations['maxPageSize'] = MAX_PAGE_SIZE;
    return {
      observations,
      notImplemented:
        `no deterministic metadata tag exceeded the ${MAX_PAGE_SIZE}-note page-size limit; refusing an unsaturated pagination pass`,
    };
  } catch (error) {
    return withObservations(error, observations);
  } finally {
    await context.close();
  }
}

interface GraphAnswer {
  nodes: { slug: string }[];
  omitted: number;
  transport: string;
}

async function graphRequest(
  page: Page,
  harness: Harness,
  operation: 'localGraph' | 'globalGraph',
  slug?: string,
): Promise<GraphAnswer> {
  const exportName = harness.client === null ? undefined : exportedDispatch(harness.client.source, operation);
  if (harness.client !== null && exportName !== undefined) {
    const reply = await clientCall(
      page,
      harness.client.url,
      exportName,
      operation === 'localGraph' ? [slug] : [null],
    );
    if (typeof reply['error'] === 'string') {
      throw new Error(`${operation} through the built client rejected: ${reply['error']}`);
    }
    const result = reply['result'] as { graph: { nodes?: unknown; omitted?: unknown } | null };
    const graph = result.graph;
    assert.ok(graph !== null && graph !== undefined, `${operation} returned no graph`);
    return {
      nodes: (graph.nodes ?? []) as { slug: string }[],
      omitted: Number(graph.omitted ?? 0),
      transport: 'client-export',
    };
  }
  const message: Record<string, unknown> =
    operation === 'localGraph' ? { id: 1, type: operation, slug } : { id: 1, type: operation };
  const reply = await askWorker(page, harness.paths.worker, message);
  assert.equal(reply['ok'], true, `${operation} direct reply was not ok: ${JSON.stringify(reply)}`);
  const result = reply['result'] as { graph: { nodes?: unknown; omitted?: unknown } | null };
  assert.ok(result.graph !== null && result.graph !== undefined, `${operation} returned no graph`);
  return {
    nodes: (result.graph.nodes ?? []) as { slug: string }[],
    omitted: Number(result.graph.omitted ?? 0),
    transport: 'direct-worker',
  };
}

/** Arm the measurement seam and the graph client's own render event. */
async function armRenderInstrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __snapshotMeasurement: boolean }).__snapshotMeasurement = true;
    const renders: { scope: string; ms: number }[] = [];
    (window as unknown as { __graphRenders: { scope: string; ms: number }[] }).__graphRenders = renders;
    document.addEventListener('graph-render', (event) => {
      const detail = (event as CustomEvent<{ scope: string; ms: number }>).detail;
      renders.push({ scope: detail.scope, ms: detail.ms });
    });
  });
}

interface RenderObservation {
  scope: string;
  ms: number;
  drawnNodes: number;
  status: string;
}

async function measureRender(page: Page, region: string, expectedScope: string): Promise<RenderObservation> {
  const activate = page.locator(`[data-graph-region="${region}"] [data-graph-activate]`);
  assert.equal(await activate.count(), 1, `the ${region} region exposed no graph activate control`);
  await activate.click();
  await page.waitForFunction(
    () => ((window as unknown as { __graphRenders?: unknown[] }).__graphRenders?.length ?? 0) > 0,
    undefined,
    { timeout: 30_000 },
  );
  const measured = await page.evaluate((selector) => {
    const state = window as unknown as {
      __graphRenders: { scope: string; ms: number }[];
    };
    return {
      render: state.__graphRenders.at(-1)!,
      drawnNodes: document.querySelectorAll(`${selector} .graph-nodes > a`).length,
      status: document.querySelector(`${selector} [data-graph-status]`)?.textContent ?? '',
    };
  }, `[data-graph-region="${region}"]`);
  assert.equal(measured.render.scope, expectedScope, `the ${region} render event named a different scope`);
  assert.ok(
    Number.isFinite(measured.render.ms) && measured.render.ms >= 0 && measured.render.ms < 60_000,
    `the ${region} render span was not a finite bounded duration: ${measured.render.ms}`,
  );
  assert.ok(measured.drawnNodes > 0, `the ${region} live drawing contained no nodes`);
  return {
    scope: measured.render.scope,
    ms: measured.render.ms,
    drawnNodes: measured.drawnNodes,
    status: measured.status,
  };
}

/**
 * Control 6 — rendering policy.
 *
 * The selection bounds must hold at the reply (`12` local, `60` global for a
 * saturated corpus) and the omitted count must reconcile with the candidates:
 * the local graph's
 * candidate set is checked against the union of the page's own static outgoing
 * and backlink lists, and the global graph's `shown + omitted` against the
 * number of published note routes in the artifact. The real graph UI then
 * draws the same selection, and its render span must be finite.
 */
async function controlRenderingPolicy(harness: Harness): Promise<ControlOutcome> {
  const observations: Record<string, unknown> = {};
  const context = await harness.newContext();
  try {
    const page = await harness.newPage(context);
    await page.goto(harness.origin + harness.notePath(harness.hubSlug), { waitUntil: 'load' });

    const local = await graphRequest(page, harness, 'localGraph', harness.hubSlug);
    const global = await graphRequest(page, harness, 'globalGraph');
    const publishedCount = harness.publishedSlugs.size;

    const unionSize = await page.evaluate(() => {
      const hrefs = new Set<string>();
      for (const aside of document.querySelectorAll('aside[aria-labelledby$="-title"]')) {
        const id = aside.getAttribute('aria-labelledby') ?? '';
        if (!id.startsWith('outgoing') && !id.startsWith('backlinks')) continue;
        for (const anchor of aside.querySelectorAll('a[href^="/notes/"]')) {
          hrefs.add(anchor.getAttribute('href')!);
        }
      }
      return hrefs.size;
    });

    const localTotal = local.nodes.length + local.omitted;
    const globalTotal = global.nodes.length + global.omitted;
    observations['local'] = {
      transport: local.transport,
      shown: local.nodes.length,
      omitted: local.omitted,
      total: localTotal,
      staticListUnion: unionSize,
      limit: LOCAL_NODE_LIMIT,
    };
    observations['global'] = {
      transport: global.transport,
      shown: global.nodes.length,
      omitted: global.omitted,
      total: globalTotal,
      publishedNotes: publishedCount,
      limit: GLOBAL_NODE_LIMIT,
    };

    assert.ok(localTotal > LOCAL_NODE_LIMIT, 'the deterministic limits corpus did not exceed the local graph limit');
    assert.equal(
      local.nodes.length,
      LOCAL_NODE_LIMIT,
      `a saturated local graph drew ${local.nodes.length} neighbours instead of ${LOCAL_NODE_LIMIT}`,
    );
    assert.equal(
      local.omitted,
      localTotal - LOCAL_NODE_LIMIT,
      `the local graph omitted ${local.omitted} of ${localTotal - LOCAL_NODE_LIMIT} neighbours`,
    );
    assert.equal(localTotal, unionSize, 'the local graph total did not match the published outgoing/backlink union');
    assert.equal(
      global.nodes.length,
      Math.min(GLOBAL_NODE_LIMIT, publishedCount),
      'the global graph drew the wrong number of nodes',
    );
    assert.equal(global.omitted, globalTotal - global.nodes.length, 'the global graph omitted count did not reconcile');
    assert.equal(globalTotal, publishedCount, 'the global graph total did not match the published note count');

    const globalPage = await harness.newPage(context);
    await armRenderInstrument(globalPage);
    await globalPage.goto(harness.origin + '/graph/', { waitUntil: 'load' });
    const globalRender = await measureRender(globalPage, 'site-graph', 'global');
    assert.equal(
      globalRender.drawnNodes,
      global.nodes.length,
      `the live global drawing contained ${globalRender.drawnNodes} nodes instead of ${global.nodes.length}`,
    );
    const globalStatus = /(\d+) of (\d+) published notes drawn/.exec(globalRender.status);
    assert.ok(globalStatus !== null, `the global status did not state its counts: ${JSON.stringify(globalRender.status)}`);
    assert.equal(Number(globalStatus[2]), publishedCount, 'the live global status stated a different total');
    assert.equal(Number(globalStatus[1]), global.nodes.length, 'the live global status disagreed with the query reply');

    const localPage = await harness.newPage(context);
    await armRenderInstrument(localPage);
    await localPage.goto(harness.origin + harness.notePath(harness.hubSlug), { waitUntil: 'load' });
    const localRender = await measureRender(localPage, 'note-graph', 'local');
    assert.equal(
      localRender.drawnNodes,
      local.nodes.length + 1,
      `the live local drawing contained ${localRender.drawnNodes} nodes including its center instead of ${local.nodes.length + 1}`,
    );
    const localStatus = /(\d+) of (\d+) neighbouring notes drawn/.exec(localRender.status);
    assert.ok(localStatus !== null, `the local status did not state its counts: ${JSON.stringify(localRender.status)}`);
    assert.equal(Number(localStatus[1]), local.nodes.length, 'the live local status disagreed with the query reply');
    assert.equal(Number(localStatus[2]), localTotal, 'the live local status stated a different total');
    assert.equal(Number(localStatus[1]), LOCAL_NODE_LIMIT, 'the local status did not show the saturated limit');
    assert.equal(Number(localStatus[2]), localTotal, 'the local status did not preserve the exact candidate total');

    observations['globalRender'] = globalRender;
    observations['localRender'] = localRender;
    observations['reconciliation'] = {
      localTotalEqualsStaticUnion: localTotal === unionSize,
      globalTotalEqualsPublishedRoutes: globalTotal === publishedCount,
    };
    return { observations };
  } catch (error) {
    return withObservations(error, observations);
  } finally {
    await context.close();
  }
}

/**
 * Control 7 — pending bound.
 *
 * The built client's exports are imported by URL so the page's own module
 * instance — the one its hover handler uses — is filled past
 * `maxPendingRequests` while every message is held (so no reply can free a
 * slot). The next call must reject `busy` and must not reach `postMessage`.
 * The page's own hover is then the shared-instance check: if the UI's request
 * were a second module instance, it would dispatch instead of rejecting.
 */
async function controlPendingBound(harness: Harness): Promise<ControlOutcome> {
  const observations: Record<string, unknown> = {};
  const context = await harness.newContext();
  try {
    const page = await harness.newPage(context);
    const currentPath = harness.notePath(harness.hubSlug);
    await page.goto(harness.origin + currentPath, { waitUntil: 'load' });
    const href = await harness.pickLink(page, currentPath);

    if (harness.client === null) {
      observations['reason'] = 'no unique built client chunk carried both `busy` and `maxPendingRequests`';
      return { observations, notImplemented: observations['reason'] as string };
    }
    const exportName = exportedDispatch(harness.client.source, 'globalGraph');
    if (exportName === undefined) {
      observations['reason'] = 'the built client chunk exposed no globalGraph dispatch export';
      return { observations, notImplemented: observations['reason'] as string };
    }

    await setHold(page, true);
    const heldSettlement = page.evaluate(
      async ({ url, name, bound }) => {
        const module = (await import(url)) as Record<string, unknown>;
        const fn = module[name] as (...inner: unknown[]) => Promise<unknown>;
        const promises: Promise<unknown>[] = [];
        for (let index = 0; index < bound; index += 1) promises.push(fn.call(module, null));
        const results = await Promise.allSettled(promises);
        return results.map((result) =>
          result.status === 'fulfilled'
            ? { status: result.status }
            : { status: result.status, reason: String(result.reason) },
        );
      },
      { url: harness.client.url, name: exportName, bound: WORKER_LIMITS.maxPendingRequests },
    );
    await page.waitForFunction(
      (bound) => ((window as unknown as { __limits: { admitted: number } }).__limits.admitted ?? 0) >= bound,
      WORKER_LIMITS.maxPendingRequests,
      { timeout: 30_000 },
    );
    const rejected = await page.evaluate(
      async ({ url, name }) => {
        const module = (await import(url)) as Record<string, unknown>;
        const fn = module[name] as (...inner: unknown[]) => Promise<unknown>;
        let code: string | null = null;
        try {
          await fn.call(module, null);
        } catch (error) {
          code = (error as { code?: string }).code ?? 'unknown';
        }
        return code;
      },
      { url: harness.client.url, name: exportName },
    );

    const atBound = await probeOf(page);
    observations['maxPendingRequests'] = WORKER_LIMITS.maxPendingRequests;
    observations['clientExport'] = exportName;
    observations['rejectedCode'] = rejected;
    observations['atBound'] = {
      admitted: atBound.admitted,
      sent: atBound.sent,
      workers: atBound.workers,
      held: atBound.held,
    };

    assert.equal(rejected, 'busy', `the request past the pending bound rejected with ${JSON.stringify(rejected)}`);
    assert.equal(atBound.workers, 1, 'the bounded requests did not share one Worker');
    assert.equal(
      atBound.admitted,
      WORKER_LIMITS.maxPendingRequests,
      `the bound admitted ${atBound.admitted} requests, not ${WORKER_LIMITS.maxPendingRequests}`,
    );
    assert.equal(atBound.sent, 0, 'a held request reached the Worker, so the hold instrument was not in effect');

    // Shared-instance check through the real UI: the page's own hover request
    // must also be rejected by the same full pending map.
    await hoverLink(page, href);
    await page.waitForTimeout(600);
    const afterHover = await probeOf(page);
    const panelHidden = await page.locator('#link-preview').isHidden();
    observations['uiCrossCheck'] = {
      panelHidden,
      admitted: afterHover.admitted,
      sent: afterHover.sent,
      workers: afterHover.workers,
    };
    assert.equal(panelHidden, true, 'a preview succeeded while the pending bound was full');
    assert.equal(afterHover.admitted, WORKER_LIMITS.maxPendingRequests, 'the UI request dispatched past the full pending bound');
    assert.equal(afterHover.workers, 1, 'the UI request constructed a second Worker instead of sharing the client module');

    // Release all held requests, wait for every promise/reply to settle, then
    // prove the same client and Worker can admit a fresh operation.
    await releaseHeld(page);
    const settled = await heldSettlement;
    const released = await probeOf(page);
    const settledFulfilled = settled.filter((result) => result.status === 'fulfilled').length;
    observations['released'] = {
      sent: released.sent,
      held: released.held,
      settled: settled.length,
      fulfilled: settledFulfilled,
      rejected: settled.length - settledFulfilled,
    };
    assert.equal(released.sent, WORKER_LIMITS.maxPendingRequests, 'the held requests were not released to the Worker');
    assert.equal(released.held, 0, 'released requests remained in the page hold queue');
    assert.equal(settled.length, WORKER_LIMITS.maxPendingRequests, 'not every held promise settled');
    assert.equal(
      settledFulfilled,
      WORKER_LIMITS.maxPendingRequests,
      'a released pending request did not settle successfully',
    );
    const retried = await page.evaluate(
      async ({ url, name }) => {
        const module = (await import(url)) as Record<string, unknown>;
        const fn = module[name] as (...inner: unknown[]) => Promise<unknown>;
        try {
          return { ok: true, result: await fn.call(module, null) };
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          return { ok: false, error: failure.code ?? failure.message ?? 'unknown' };
        }
      },
      { url: harness.client.url, name: exportName },
    );
    const afterRetry = await probeOf(page);
    observations['retry'] = {
      ok: retried.ok,
      sent: afterRetry.sent,
      workers: afterRetry.workers,
      reply: afterRetry.replies.at(-1),
    };
    assert.equal(retried.ok, true, `the fresh operation after release failed: ${JSON.stringify(retried)}`);
    assert.equal(afterRetry.sent, WORKER_LIMITS.maxPendingRequests + 1, 'the fresh operation was not dispatched');
    assert.equal(afterRetry.workers, 1, 'the fresh operation constructed a second Worker');
    assert.equal(afterRetry.replies.at(-1)?.ok, true, 'the fresh operation did not settle successfully');
    return { observations };
  } catch (error) {
    return withObservations(error, observations);
  } finally {
    await context.close();
  }
}

/**
 * The module-level half of the pending-bound evidence, run unconditionally.
 *
 * The browser control above is the stronger instrument when it applies; the
 * Node gate is the one that can see a promise that never settles, so its
 * result is recorded beside the browser's rather than replaced by it.
 */
function runClientBoundTest(): ClientBoundTest {
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', CLIENT_BOUND_TEST_PATH, '--reporter=json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  return parseVitestJsonResult({ status: run.status, stdout: typeof run.stdout === 'string' ? run.stdout : '' });
}

export function benchmarkExitCode(
  controls: readonly Pick<ControlRecord, 'id' | 'status'>[],
  clientBoundTest: Pick<ClientBoundTest, 'status'>,
): 0 | 1 {
  if (controls.length !== REQUIRED_CONTROL_IDS.length || clientBoundTest.status !== 'pass') return 1;
  const observed = new Set(controls.map((control) => control.id));
  const complete =
    observed.size === REQUIRED_CONTROL_IDS.length && REQUIRED_CONTROL_IDS.every((id) => observed.has(id));
  return complete && controls.every((control) => control.status === 'pass') ? 0 : 1;
}

/**
 * Discover the workload's busiest node and the artifact's own note count.
 *
 * The busiest node is the local-graph center the rendering control needs; the
 * build rank puts the highest combined-degree node first in the unfiltered
 * global graph, so this reads the same selection the site would draw rather
 * than reimplementing degree counting here.
 */
async function discoverReadiness(
  harness: Harness,
): Promise<{ hubSlug: string; publishedNotes: number; globalShown: number; globalOmitted: number }> {
  const context = await harness.newContext();
  try {
    const page = await harness.newPage(context);
    const firstSlug = [...harness.publishedSlugs][0]!;
    await page.goto(harness.origin + harness.notePath(firstSlug), { waitUntil: 'load' });
    const reply = await askWorker(page, harness.paths.worker, { id: 1, type: 'globalGraph' });
    assert.equal(reply['ok'], true, 'the built Worker did not answer an unfiltered globalGraph');
    const result = reply['result'] as { graph: { nodes: { slug: string }[]; omitted: number } };
    assert.ok(result.graph.nodes.length > 0, 'the built snapshot answered globalGraph with no nodes');
    return {
      hubSlug: result.graph.nodes[0]!.slug,
      publishedNotes: harness.publishedSlugs.size,
      globalShown: result.graph.nodes.length,
      globalOmitted: result.graph.omitted,
    };
  } finally {
    await context.close();
  }
}

interface LimitAssetIdentity {
  name: string;
  sha256: string;
  bytes: number;
}

interface LimitAssets {
  snapshot: LimitAssetIdentity;
  wasm: LimitAssetIdentity;
  worker: LimitAssetIdentity;
}

interface LimitsCandidate {
  gitHead: string | null;
  worktreeDirty: boolean;
  changedFiles: number;
  packageVersion: string;
  repository: RepositoryIdentity | null;
  repositoryHead: CandidateIdentity['repositoryHead'] | null;
  repositoryTree: CandidateIdentity['repositoryTree'] | null;
  cli: CandidateIdentity['cli'] | null;
  installedPackage: CandidateIdentity['installedPackage'] | null;
  installedPackageTree: CandidateIdentity['installedPackageTree'] | null;
  runtimeDependencyTree: CandidateIdentity['runtimeDependencyTree'] | null;
  lockfile: CandidateIdentity['lockfile'] | null;
  tarball: CandidateIdentity['tarball'] | null;
  runtime: CandidateIdentity['runtime'] | null;
  assets: LimitAssets | null;
}

interface LimitsFailure {
  phase: string;
  message: string;
}

export interface LimitsReport {
  kind: 'anc-limits-benchmark';
  generatedAt: string;
  instrument: {
    sources: Record<string, string>;
    repository: RepositoryIdentity | null;
  };
  candidate: LimitsCandidate;
  host: {
    platform: string;
    osType: string;
    osRelease: string;
    arch: string;
    cpus: number;
    totalMemoryBytes: number;
  };
  browser: {
    engine: string | null;
    version: string | null;
    requestedDevice: string | null;
    profile: BenchmarkBrowserReport | null;
    network: string;
  };
  corpus: Record<string, unknown> | null;
  workload: Record<string, unknown> | null;
  policies: Record<string, number>;
  readiness: Record<string, unknown> | null;
  controls: ControlRecord[];
  limitations: string[];
  clientBoundTest: ClientBoundTest | null;
  failures: LimitsFailure[];
  elapsedSeconds: number;
}

interface LimitsIdentity {
  repository: RepositoryIdentity;
  cliPath: string;
  candidate: CandidateIdentity;
  assets: LimitAssets | null;
}

function hostIdentity(): LimitsReport['host'] {
  return {
    platform: process.platform,
    osType: osType(),
    osRelease: osRelease(),
    arch: arch(),
    cpus: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}

function emptyCandidate(): LimitsCandidate {
  return {
    gitHead: null,
    worktreeDirty: false,
    changedFiles: 0,
    packageVersion: 'unknown',
    repository: null,
    repositoryHead: null,
    repositoryTree: null,
    cli: null,
    installedPackage: null,
    installedPackageTree: null,
    runtimeDependencyTree: null,
    lockfile: null,
    tarball: null,
    runtime: null,
    assets: null,
  };
}

export function createLimitsReportSkeleton(): LimitsReport {
  return {
    kind: 'anc-limits-benchmark',
    generatedAt: new Date().toISOString(),
    instrument: { sources: {}, repository: null },
    candidate: emptyCandidate(),
    host: hostIdentity(),
    browser: {
      engine: null,
      version: null,
      requestedDevice: null,
      profile: null,
      network: 'loopback static server; no network throttling',
    },
    corpus: null,
    workload: null,
    policies: {
      ...WORKER_LIMITS,
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
      localNodeLimit: LOCAL_NODE_LIMIT,
      globalNodeLimit: GLOBAL_NODE_LIMIT,
      hoverDelayMs: HOVER_DELAY_MS,
      deadlineMarginMs: DEADLINE_MARGIN_MS,
    },
    readiness: null,
    controls: [],
    limitations: [],
    clientBoundTest: null,
    failures: [],
    elapsedSeconds: 0,
  };
}

/** Keep private evidence useful without copying host filesystem paths into it. */
export function scrubBenchmarkFailure(error: unknown, roots: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const root of [ROOT, ...roots]) {
    if (root === '') continue;
    text = text.split(root).join('<host-path>');
    text = text.split(root.replaceAll('\\', '/')).join('<host-path>');
  }
  return text
    .replace(/[A-Za-z]:[\\/][^\r\n"'`]+/g, '<host-path>')
    .replace(/(^|[\s("'`])\/(?:[^\s"'`]+\/)+[^\s"'`]+/g, '$1<host-path>');
}

export function recordLimitsFailure(
  report: LimitsReport,
  phase: string,
  error: unknown,
  roots: readonly string[] = [],
): void {
  report.failures.push({ phase, message: scrubBenchmarkFailure(error, roots) });
}

function assetIdentity(directory: string, matcher: (name: string) => boolean, label: string): LimitAssetIdentity {
  const names = readdirSync(directory).filter(matcher);
  assert.equal(names.length, 1, `the build produced ${names.length} ${label} assets instead of exactly one`);
  const name = names[0]!;
  const path = join(directory, name);
  return { name, sha256: sha256File(path), bytes: statSync(path).size };
}

function builtAssetIdentity(dist: string): LimitAssets {
  return {
    snapshot: assetIdentity(join(dist, 'data'), (name) => name.endsWith('.sqlite'), 'snapshot'),
    wasm: assetIdentity(join(dist, 'wasm'), (name) => name.endsWith('.wasm'), 'WASM'),
    worker: assetIdentity(
      join(dist, '_astro'),
      (name) => name.startsWith('snapshot-worker-') && name.endsWith('.js'),
      'Worker',
    ),
  };
}

function assertAssetIdentityStable(expected: LimitAssets, dist: string, boundary: string): void {
  const actual = {
    snapshot: { ...expected.snapshot, sha256: sha256File(join(dist, 'data', expected.snapshot.name)) },
    wasm: { ...expected.wasm, sha256: sha256File(join(dist, 'wasm', expected.wasm.name)) },
    worker: { ...expected.worker, sha256: sha256File(join(dist, '_astro', expected.worker.name)) },
  };
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new BenchmarkIdentityDriftError(boundary);
}

function assertLimitsIdentityStable(
  expected: LimitsIdentity,
  dist: string | undefined,
  boundary: string,
  check: 'state' | 'full' = 'full',
): void {
  assertCandidateIdentityStable(expected.candidate, expected.cliPath, boundary, check);
  if (check === 'full' && expected.assets !== null) {
    if (dist === undefined) throw new BenchmarkIdentityDriftError(boundary);
    assertAssetIdentityStable(expected.assets, dist, boundary);
  }
}

function sanitizeForStream(text: string, workspace: string | undefined): string {
  return scrubBenchmarkFailure(text, workspace === undefined ? [] : [workspace]);
}

async function main(): Promise<number> {
  const started = Date.now();
  const report = createLimitsReportSkeleton();
  const reportDirectory = benchmarkReportDirectory(ROOT);
  mkdirSync(reportDirectory, { recursive: true });
  const reportPath = join(reportDirectory, `benchmark-limits-${Date.now()}.json`);
  let workspace: string | undefined;
  let site: Site | undefined;
  let browser: Browser | undefined;
  let expectedIdentity: LimitsIdentity | undefined;
  let dist: string | undefined;
  let phase = 'parse';
  let exitCode = 1;
  let identityFailureRecorded = false;
  try {
    const options = parseLimitsOptions(process.argv.slice(2));
    report.browser.engine = options.browser;
    report.browser.requestedDevice = options.device ?? null;

    phase = 'resolve-browser';
    const { devices } = await import('playwright');
    const browserSettings = resolveBenchmarkBrowser(options.browser, options.device, devices);
    report.browser.profile = browserSettings.report;

    phase = 'identify-candidate';
    const repository = repositoryIdentity(ROOT);
    const cliPath = options.cli;
    if (!existsSync(cliPath)) throw new Error(`--cli does not exist: ${basename(cliPath)}`);
    if (!statSync(cliPath).isFile()) throw new Error(`--cli is not a file: ${basename(cliPath)}`);
    if (extname(cliPath).toLowerCase() === '.tgz') {
      throw new Error('--cli must point to an executable CLI, not a .tgz package archive');
    }
    const candidate = candidateIdentity(cliPath, repository);
    const packageVersion =
      candidate.installedPackage?.version ??
      (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const changedFiles = gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
      .split('\n')
      .filter((line) => line.trim() !== '').length;
    report.instrument.repository = repository;
    report.instrument.sources = {
      'scripts/benchmark-limits.ts': sha256File(fileURLToPath(import.meta.url)),
      'scripts/benchmark-browser.ts': sha256File(join(ROOT, 'scripts', 'benchmark-browser.ts')),
      'scripts/benchmark-identity.ts': sha256File(join(ROOT, 'scripts', 'benchmark-identity.ts')),
      'scripts/generate-corpus.ts': sha256File(join(ROOT, 'scripts', 'generate-corpus.ts')),
    };
    report.candidate = {
      ...candidate,
      gitHead: repository.gitHead,
      worktreeDirty: repository.worktreeDirty,
      changedFiles,
      packageVersion,
      repository,
      assets: null,
    };
    expectedIdentity = { repository, cliPath, candidate, assets: null };
    assertRepositoryIdentityClean(repository);

    phase = 'generate-corpus';
    workspace = mkdtempSync(join(tmpdir(), 'anc-bench-limits-'));
    const corpusDirectory = join(workspace, 'notes');
    const corpus = await generateCorpus(corpusDirectory, {
      notes: CORPUS_NOTES,
      seed: CORPUS_SEED,
      topology: CORPUS_TOPOLOGY,
      metadata: CORPUS_METADATA,
    });
    const corpusHash = hashDirectory(corpusDirectory);
    const generatorDigest = report.instrument.sources['scripts/generate-corpus.ts']!;

    report.corpus = {
      generator: 'scripts/generate-corpus.ts',
      generatorSha256: generatorDigest,
      seed: CORPUS_SEED,
      requestedNotes: CORPUS_NOTES,
      topology: CORPUS_TOPOLOGY,
      metadata: CORPUS_METADATA,
      generated: corpus,
      contentSha256: corpusHash.sha256,
      hashedFiles: corpusHash.files,
    };

    phase = 'build';
    const buildStarted = Date.now();
    const build = spawnSync(process.execPath, [cliPath, 'build', '--content', 'notes', '--out', 'dist'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 20 * 60_000,
    });
    if (build.status !== 0) {
      throw new Error(`the workload build failed (${build.status}): ${build.stdout}${build.stderr}`);
    }
    const buildMs = Date.now() - buildStarted;
    dist = join(workspace, 'dist');
    const assets = builtAssetIdentity(dist);
    expectedIdentity.assets = assets;
    report.candidate.assets = assets;
    assertLimitsIdentityStable(expectedIdentity, dist, 'after build', 'state');

    const snapshotName = assets.snapshot.name;
    const wasmName = assets.wasm.name;
    const workerName = assets.worker.name;
    const publishedSlugs = new Set(readdirSync(join(dist, 'notes')));
    const tagMemberCounts = readTagMemberCounts(join(dist, 'data', snapshotName));
    assert.ok(publishedSlugs.size > 0, 'the build published no note routes');
    report.workload = {
      buildCommand: `node ${basename(cliPath)} build --content notes --out dist`,
      buildMs,
      outputFiles: countFiles(dist),
      publishedNoteRoutes: publishedSlugs.size,
      assets,
    };

    phase = 'serve';
    site = await startSite(dist);
    report.instrument.sources[site.headers.source] = site.headers.sha256;
    phase = 'browser-launch';
    const { chromium } = await import('playwright');
    const launchedBrowser = await chromium.launch(browserSettings.launchOptions);
    browser = launchedBrowser;
    report.browser.version = launchedBrowser.version();
    const harness: Harness = {
      site,
      origin: site.origin,
      hubSlug: '',
      publishedSlugs,
      tagMemberCounts,
      paths: {
        snapshot: `/data/${snapshotName}`,
        wasm: `/wasm/${wasmName}`,
        worker: `/_astro/${workerName}`,
      },
      client: findClientChunk(dist),
      notePath,
      newContext(): Promise<BrowserContext> {
        return launchedBrowser.newContext(browserSettings.contextOptions);
      },
      newPage(context: BrowserContext): Promise<Page> {
        return (async () => {
          const page = await context.newPage();
          await installProbe(page);
          return page;
        })();
      },
      pickLink(page: Page, currentPath: string): Promise<string> {
        return collectLink(page, currentPath, publishedSlugs);
      },
    };
    assertLimitsIdentityStable(expectedIdentity, dist, 'before readiness', 'state');
    phase = 'readiness';
    const readiness = await discoverReadiness(harness);
    harness.hubSlug = readiness.hubSlug;
    report.readiness = readiness;

    const controls: ControlRecord[] = [];
    const controlDefinitions: readonly [string, string, () => Promise<ControlOutcome>][] = [
      [REQUIRED_CONTROL_IDS[0], 'Decoded snapshot-byte cap', () => controlSnapshotByteCap(harness)],
      [REQUIRED_CONTROL_IDS[1], 'Decoded WASM-byte cap', () => controlWasmByteCap(harness)],
      [REQUIRED_CONTROL_IDS[2], 'Worker startup deadline', () => controlStartupDeadline(harness)],
      [REQUIRED_CONTROL_IDS[3], 'Query deadline', () => controlQueryDeadline(harness)],
      [REQUIRED_CONTROL_IDS[4], 'Page-size clamp', () => controlPageSizeClamp(harness)],
      [REQUIRED_CONTROL_IDS[5], 'Rendering policy', () => controlRenderingPolicy(harness)],
      [REQUIRED_CONTROL_IDS[6], 'Pending request bound', () => controlPendingBound(harness)],
    ];
    for (const [id, name, body] of controlDefinitions) {
      phase = `control:${id}`;
      const control = await runControl(id, name, body);
      controls.push(control);
      report.controls = controls;
      assertLimitsIdentityStable(expectedIdentity, dist, `after ${id}`, 'state');
    }

    phase = 'client-bound-test';
    const clientBoundTest = runClientBoundTest();
    report.clientBoundTest = clientBoundTest;
    assertLimitsIdentityStable(expectedIdentity, dist, 'after client-bound test', 'state');

    report.limitations = [];
    report.controls = controls.map((control) => ({
      ...control,
      observations: { ...control.observations, summary: summarize(control) },
    }));
    phase = 'identity-finalization';
    assertLimitsIdentityStable(expectedIdentity, dist, 'report finalization', 'full');
    exitCode = benchmarkExitCode(controls, clientBoundTest);
  } catch (error) {
    if (error instanceof BenchmarkIdentityDriftError) identityFailureRecorded = true;
    recordLimitsFailure(report, phase, error, workspace === undefined ? [] : [workspace]);
    process.stderr.write(`benchmark: ${scrubBenchmarkFailure(error, workspace === undefined ? [] : [workspace])}\n`);
    exitCode = 1;
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      recordLimitsFailure(report, 'browser-close', error, workspace === undefined ? [] : [workspace]);
      exitCode = 1;
    }
    try {
      await site?.close();
    } catch (error) {
      recordLimitsFailure(report, 'site-close', error, workspace === undefined ? [] : [workspace]);
      exitCode = 1;
    }
    if (workspace !== undefined) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch (error) {
        recordLimitsFailure(report, 'workspace-cleanup', error, [workspace]);
        exitCode = 1;
      }
    }
    report.elapsedSeconds = Number(((Date.now() - started) / 1000).toFixed(2));
    try {
      if (!identityFailureRecorded && expectedIdentity !== undefined) {
        try {
          assertLimitsIdentityStable(expectedIdentity, undefined, 'report write', 'state');
        } catch (error) {
          identityFailureRecorded = true;
          recordLimitsFailure(report, 'identity-report-write', error);
          exitCode = 1;
        }
      }
      const failureRoots = workspace === undefined ? [] : [workspace];
      report.controls = report.controls.map((control) => ({
        ...control,
        ...(control.failure === undefined
          ? {}
          : { failure: scrubBenchmarkFailure(control.failure, failureRoots) }),
      }));
      const reportBody = `${JSON.stringify(report, null, 2)}\n`;
      writeFileSync(reportPath, reportBody, 'utf8');
      const digest = createHash('sha256').update(reportBody).digest('hex');
      const passed = report.controls.filter((control) => control.status === 'pass').length;
      const failed = report.controls.filter((control) => control.status === 'fail').length;
      const notImplemented = report.controls.filter((control) => control.status === 'not-implemented').length;
      console.log(
        `benchmark-limits: ${report.controls.length} controls, ${passed} pass, ${failed} fail, ${notImplemented} not-implemented, ${report.failures.length} setup failures`,
      );
      for (const control of report.controls) {
        const summary = summarize(control);
        const failure =
          control.status === 'fail' && control.failure !== undefined
            ? ` (${sanitizeForStream(control.failure, workspace)})`
            : '';
        console.log(`  ${control.id}: ${control.status}${summary === '' ? '' : ` [${summary}]`}${failure}`);
      }
      if (report.clientBoundTest !== null) {
        console.log(`client-bound-test: ${report.clientBoundTest.status} (${report.clientBoundTest.detail})`);
      }
      console.log(`report sha256: ${digest}`);
    } catch (error) {
      process.stderr.write(`benchmark: report write failed: ${scrubBenchmarkFailure(error)}\n`);
      exitCode = 1;
    }
  }
  return exitCode;
}

/** A path-free numeric summary for the stream, one line per control. */
function summarize(control: ControlRecord): string {
  const observations = control.observations;
  switch (control.id) {
    case REQUIRED_CONTROL_IDS[0]:
    case REQUIRED_CONTROL_IDS[1]: {
      const delivery = observations['delivery'] as BodyDeliveryObservation | undefined;
      return `body=${observations['bodyBytes']} written=${delivery?.bytesWritten ?? '?'} aborted=${delivery?.peerAborted ?? '?'} cap=${observations['capBytes']} code=${(observations['firstReply'] as ProbeReply | undefined)?.code ?? '?'} wasmCalls=${(observations['workerWasm'] as { calls?: number } | undefined)?.calls ?? '?'}`;
    }
    case REQUIRED_CONTROL_IDS[2]:
      return `deadline=${observations['deadlineMs']}ms elapsed=${observations['elapsedMs']}ms terminations=${(observations['whileStalled'] as { terminations?: number } | undefined)?.terminations ?? '?'}`;
    case REQUIRED_CONTROL_IDS[3]:
      return `deadline=${observations['deadlineMs']}ms elapsed=${observations['elapsedMs']}ms dropped=${(observations['blocked'] as { dropped?: number } | undefined)?.dropped ?? '?'}`;
    case REQUIRED_CONTROL_IDS[4]:
      return `mode=${observations['mode']} pageSize=${observations['requestedPageSize']} returned=${observations['returnedNotes']} max=${observations['maxPageSize']}`;
    case REQUIRED_CONTROL_IDS[5]: {
      const local = observations['local'] as { shown?: number; omitted?: number } | undefined;
      const global = observations['global'] as { shown?: number; omitted?: number } | undefined;
      return `local=${local?.shown ?? '?'}/${(local?.shown ?? 0) + (local?.omitted ?? 0)} global=${global?.shown ?? '?'}/${(global?.shown ?? 0) + (global?.omitted ?? 0)}`;
    }
    case REQUIRED_CONTROL_IDS[6]:
      return `bound=${observations['maxPendingRequests']} rejected=${String(observations['rejectedCode'])} admitted=${(observations['atBound'] as { admitted?: number } | undefined)?.admitted ?? '?'}`;
    default:
      return '';
  }
}

// `process.exitCode` rather than `process.exit`: the latter can truncate a
// piped stdout, and this runner's stream is the compact record a caller reads.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
