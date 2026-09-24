/**
 * A real built site served under the shipped CSP, for browser gates.
 *
 * Goal 0003's evidence needs an actual generated site with the intended policy
 * applied by the test server; a header file merely present on disk does not
 * enforce CSP. Each browser gate would otherwise repeat the same corpus build,
 * header parse, and static server, so this is that code once. The server
 * applies the matching `public/_headers` rules to each response — per path, not
 * flattened onto every path — which is what makes a test that exercises the
 * Worker, WASM, and snapshot a CSP test as well.
 *
 * `serve` is switchable on purpose: a static deployment's snapshot change
 * arrives as a new build served at the same origin, and `serve(newDist)` is the
 * test-side equivalent of that replacement. Tests own their workspaces and
 * remove them with `removeWorkspace`.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'anc.mjs');
const SOURCE_HEADERS = join(ROOT, 'public', '_headers');

/**
 * What Cloudflare Pages serves on a 200 whose path no `_headers` rule names.
 *
 * `public/_headers` deliberately does not restate it: a rule there would be one
 * more thing to keep in sync with the platform, and the shipped comments say
 * so. The harness has to stand in for the platform to demonstrate what that
 * default *is* — revalidation rather than the immutable caching only `/_astro/*`
 * grants — so it is written down once, here, with the conditional-request
 * behavior a real host gives it.
 */
const PLATFORM_REVALIDATION = 'public, max-age=0, must-revalidate';

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

export const WORKER_CHUNK_PATTERN = /\/_astro\/snapshot-worker-[\w-]+\.js$/;

/** One `_headers` rule: a path pattern and the headers it sets. */
export interface HeaderRule {
  matcher: RegExp;
  headers: Record<string, string>;
}

/**
 * Parse the Cloudflare Pages `_headers` grammar: an unindented line is a path
 * pattern, an indented `Name: value` line attaches to the pattern above it, and
 * `#` starts a comment. Patterns keep their path structure: the shipped file
 * grants immutable caching to `/_astro/*` alone, and applying that rule to every
 * response would make the harness stricter about caching than the deployment it
 * stands in for.
 */
export function headerRules(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      rules.push({
        matcher: new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/:\w+/g, '[^/]+')}$`),
        headers: {},
      });
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

/**
 * Apply already-parsed rules to one request path.
 *
 * Cloudflare joins same-named headers from every matching rule with a comma;
 * `tests/deployment.test.ts` forbids the shipped file from relying on that, so
 * this merge is indistinguishable for the file actually served.
 */
export function applyRules(rules: readonly HeaderRule[], pathname: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.matcher.test(pathname)) continue;
    Object.assign(headers, rule.headers);
  }
  return headers;
}

/** The headers `public/_headers` declares for one request path. */
export function headersFor(pathname: string): Record<string, string> {
  return applyRules(headerRules(readFileSync(SOURCE_HEADERS, 'utf8')), pathname);
}

/** The site-wide headers (the `/*` rule) `public/_headers` declares. */
export function shippedHeaders(): Record<string, string> {
  return headersFor('/');
}

export interface BuiltSite {
  workspace: string;
  dist: string;
}

export interface ServedSite {
  origin: string;
  /** The directory currently served; `serve` replaces it. */
  dist: string;
  /** Serve a different built output at this origin; a snapshot change. */
  serve(dist: string): void;
  close(): Promise<void>;
}

export type RunningSite = BuiltSite & ServedSite;

/** Write a corpus into a workspace and build it with the shipped binary. */
export function buildIn(workspace: string, files: Record<string, string>, out: string): BuiltSite {
  const notes = join(workspace, 'notes');
  mkdirSync(notes, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(notes, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  const build = spawnSync(process.execPath, [BINARY, 'build', '--content', 'notes', '--out', out], {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`anc build failed (${build.status}):\n${build.stdout}${build.stderr}`);
  return { workspace, dist: join(workspace, out) };
}

/**
 * Create a workspace, write a corpus, and build it.
 *
 * Keys are paths relative to the corpus root, so a gate can add subdirectories.
 * A failed build throws with the producer's streams rather than a bare status.
 */
export function buildSite(files: Record<string, string>, out = 'dist'): BuiltSite {
  return buildIn(mkdtempSync(join(tmpdir(), 'anc-site-')), files, out);
}

/**
 * Serve a built output on loopback with a `_headers` policy applied per path.
 *
 * The document defaults to the repository's `public/_headers`; `headersFile`
 * points the same server at another built output's generated `_headers`, which
 * is what serving a foreign or otherwise separately built artifact needs.
 * Responses whose path no rule names still carry the platform's revalidating
 * default and a validator, so a caller can demonstrate that HTML and stable
 * Pagefind metadata revalidate rather than inheriting `immutable`.
 */
export async function serveDist(
  initial: string,
  options: { headersFile?: string } = {},
): Promise<ServedSite> {
  // Parsed once per server: every request applies the same rules, and a browser
  // gate makes hundreds of them.
  const rules = headerRules(readFileSync(options.headersFile ?? SOURCE_HEADERS, 'utf8'));
  let current = initial;
  const running = createServer((request, response) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400, applyRules(rules, '/'));
      response.end('bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const headers = applyRules(rules, pathname);
    const root = resolve(current);
    const file = resolve(root, `.${pathname}`);
    // Directory boundary, not a string prefix: `/tmp/x/dist2/...` starts with
    // `/tmp/x/dist`, so a prefix test would serve a sibling directory's bytes
    // through this origin even though the comment above promises containment.
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403, headers);
      response.end();
      return;
    }
    try {
      // Streamed, not read whole: the oversized-data gates deliberately serve a
      // snapshot of `maxSnapshotBytes + 1` (~64 MiB), and buffering it would
      // block the server's event loop for the duration of every such request.
      // The catch swallows the client's cap-abort, which is the expected
      // premature close in those gates.
      const stat = statSync(file);
      if (headers['Cache-Control'] === undefined) headers['Cache-Control'] = PLATFORM_REVALIDATION;
      const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, { ...headers, ETag: etag });
        response.end();
        return;
      }
      response.writeHead(200, {
        ...headers,
        'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        'Content-Length': String(stat.size),
        ETag: etag,
      });
      void pipeline(createReadStream(file), response).catch(() => {
        // The client aborted, or the file vanished after the stat; either way
        // the response is already unusable and there is nothing to report.
      });
    } catch {
      response.writeHead(404, headers);
      response.end('not found');
    }
  });
  const server: Server = await new Promise((done) =>
    running.listen(0, '127.0.0.1', () => done(running)),
  );
  const site: ServedSite = {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    dist: initial,
    serve(dist: string): void {
      site.dist = dist;
      current = dist;
    },
    close(): Promise<void> {
      return new Promise((done) => server.close(() => done()));
    },
  };
  return site;
}

/**
 * Build a corpus and serve it under the shipped policy.
 *
 * The returned object is the live server handle, so a caller that later calls
 * `serve()` on it reads the replaced `dist` rather than a stale copy.
 */
export async function buildAndServe(files: Record<string, string>): Promise<RunningSite> {
  const built = buildSite(files);
  const served = await serveDist(built.dist);
  return Object.assign(served, built);
}

/** Remove a workspace after its server has closed. */
export function removeWorkspace(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true });
}

/**
 * Requests that belong to the SQLite runtime: the Worker entry chunk, the
 * pinned WASM, and the snapshot itself.
 *
 * The Worker chunk is included because "ordinary reading downloads no SQLite
 * JS" is only proven if the instrument would catch the Worker being created;
 * a filter that watches the DB and WASM alone reports zero for a page that
 * eagerly started its Worker.
 */
export function sqliteAssetRequests(page: Page): string[] {
  const found: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/data/site.') || url.includes('/wasm/') || WORKER_CHUNK_PATTERN.test(url)) found.push(url);
  });
  return found;
}

/** The built Worker entry's URL path, for driving the real Worker directly. */
export function workerScriptPath(dist: string): string {
  const name = readdirSync(join(dist, '_astro')).find(
    (file) => file.startsWith('snapshot-worker-') && file.endsWith('.js'),
  );
  if (name === undefined) throw new Error(`no Worker chunk in ${join(dist, '_astro')}`);
  return `/_astro/${name}`;
}

/** Press Tab until `matches` accepts the focused element; report whether it did. */
async function tabUntil(
  page: Page,
  matches: (expected: string) => boolean,
  expected: string,
  maxPresses: number,
): Promise<boolean> {
  for (let press = 0; press < maxPresses; press += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(matches, expected)) return true;
  }
  return false;
}

/**
 * Tab until the element with `href` holds focus, and report whether it was
 * reached.
 *
 * Real presses, not `locator.focus()`: the preview client gates on
 * `:focus-visible`, and programmatic focus does not set it, so a gate that
 * focused directly would pass while every keyboard reader got nothing.
 */
export async function focusByTab(page: Page, href: string, maxPresses = 80): Promise<boolean> {
  return tabUntil(
    page,
    (expected) => document.activeElement?.getAttribute('href') === expected,
    href,
    maxPresses,
  );
}

/**
 * Tab until the element matching `selector` holds focus, and report whether it
 * was reached.
 *
 * A companion to `focusByTab` for controls addressed by selector rather than
 * href — the tag chooser and its buttons. `focusByTab` cannot serve them: it
 * compares `activeElement.href`, which a `<select>` or `<button>` does not
 * have. Real presses either way, so a control is only reached if the page's
 * own tab order exposes it.
 */
export async function tabTo(page: Page, selector: string, maxPresses = 80): Promise<boolean> {
  return tabUntil(page, (expected) => document.activeElement?.matches(expected) ?? false, selector, maxPresses);
}

/**
 * Record the Worker messages of one type the page posts.
 *
 * The tag browser's request identity is what a double-click or a tag switch
 * turns on — a cursor resent, or a caller's continuation reused — so requests
 * are recorded as posted and read back with `workerMessages`; callers narrow
 * the recorded shape themselves.
 */
export async function recordWorkerMessages(page: Page, type: string): Promise<void> {
  await page.addInitScript((messageType: string) => {
    const state = window as unknown as { __workerMessages: unknown[] };
    state.__workerMessages = [];
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      ...rest: unknown[]
    ): void {
      if ((message as { type?: string }).type === messageType) state.__workerMessages.push(message);
      (original as (this: Worker, ...args: unknown[]) => void).call(this, message, ...rest);
    };
  }, type);
}

/** The messages `recordWorkerMessages` has recorded so far. */
export async function workerMessages<T>(page: Page): Promise<T[]> {
  return page.evaluate(() => (window as unknown as { __workerMessages: unknown[] }).__workerMessages) as Promise<T[]>;
}

/**
 * Count the Worker terminations the page performs.
 *
 * The count is read with `workerTerminations`; a test waiting on a transition
 * can `waitForFunction` over the same `window.__terminateCount` the wrapper
 * maintains.
 */
export async function countWorkerTerminations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { __terminateCount: number };
    state.__terminateCount = 0;
    const original = Worker.prototype.terminate;
    Worker.prototype.terminate = function (this: Worker): void {
      state.__terminateCount += 1;
      original.call(this);
    };
  });
}

/** The termination count `countWorkerTerminations` has recorded so far. */
export async function workerTerminations(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __terminateCount: number }).__terminateCount);
}

/**
 * Collect `pageerror` events so a test can assert the page stayed clean.
 *
 * A failure path that throws past an async caller, or leaves an unhandled
 * rejection, surfaces here rather than as an assertion about the panel.
 */
export function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}
