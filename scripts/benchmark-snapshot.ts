/**
 * Transfer, startup, preview, query, and ordinary-reading measurement for the
 * snapshot runtime.
 *
 * This is goal 0008's **instrument**, not its acceptance. It measures a real
 * built candidate in a real browser and writes a private JSON report under
 * `<git-dir>/publish-report/`, but the named physical mobile device and the
 * maintainer's policy decision are external and are not invented here. Every
 * report states its candidate identity, host, browser version, OS, throttling
 * (labeled simulation when used), cache definitions, sample counts, quantile
 * method, corpus generator seed, and fixture identity.
 * Where the runtime measurement seam did not supply `sqlMs` or `phases`, the
 * field is `null` with a note; no value is interpolated.
 *
 * Each workload is one (size, topology) pair: a seeded corpus from
 * `scripts/generate-corpus.ts`, built by the CLI named on the command line
 * (`--cli`, default `bin/anc.mjs`; pass the installed package's bin to measure
 * the packaged-tarball candidate), served over loopback under the output's own
 * `_headers` with gzip negotiation, and driven in Chromium through hover
 * preview, the local-graph control, the tag browser, the site graph, and a
 * driver Worker constructed from the built chunk.
 *
 * The SQLite-asset definition in section F is imported from
 * `tests/support/browser-site.ts` (`sqliteAssetRequests`,
 * `WORKER_CHUNK_PATTERN`) rather than restated, so this instrument cannot
 * drift from the gate that defines the class.
 *
 * Usage: `node scripts/benchmark-snapshot.ts [--sizes 100,1000,10000]
 * [--topologies sparse,hub] [--samples 30] [--throttle 4] [--cli bin/anc.mjs]
 * [--seed 7] [--out <report.json>]`
 *
 * `hub` names this harness's workload and maps to the generator's `skewed`
 * topology; `sparse` is the generator's `sparse`.
 */

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
import { createServer, type Server } from 'node:http';
import { arch, cpus, release as osRelease, tmpdir, totalmem, type as osType } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { GLOBAL_NODE_LIMIT, LOCAL_NODE_LIMIT } from '../src/lib/graph-selection.ts';
import { MAX_PAGE_SIZE } from '../src/lib/snapshot-queries.ts';
import { SNAPSHOT_FILE_PATTERN } from '../src/lib/snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { sqliteAssetRequests, WORKER_CHUNK_PATTERN, workerScriptPath } from '../tests/support/browser-site.ts';
import {
  generateCorpus,
  type CorpusOptions,
  type CorpusTopology,
  type GeneratedCorpus,
} from './generate-corpus.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILD_TIMEOUT_MS = 20 * 60_000;
const VIEWPORT = { width: 1280, height: 800 } as const;
const HOVER_TIMEOUT_MS = 30_000;
const WARM_PREVIEW_TIMEOUT_MS = 15_000;
const DRIVER_COLD_TIMEOUT_MS = 60_000;
const DRIVER_WARM_TIMEOUT_MS = 10_000;
const HEAP_POLL_INTERVAL_MS = 50;
const STEADY_SETTLE_MS = 1_000;
const MAX_WALK_PAGES = 500;
/** Total driver requests one cursor operation may spend across its repetitions. */
const WALK_REQUEST_BUDGET = 400;
/** Cloudflare Pages' default for a 200 no `_headers` rule names. */
const PLATFORM_REVALIDATION = 'public, max-age=0, must-revalidate';

type Topology = 'sparse' | 'hub';

interface Options {
  sizes: number[];
  topologies: Topology[];
  samples: number;
  throttle: number;
  cli: string | undefined;
  seed: number;
  out: string | undefined;
}

/**
 * The generator request this harness sends, named as the generator's own
 * option fields so a renamed, removed, or retyped option is a type error here
 * rather than a silently ignored field.
 */
type GeneratorRequest = Required<Pick<CorpusOptions, 'notes' | 'seed' | 'topology' | 'metadata'>>;

function parseOptions(argv: readonly string[]): Options {
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    return value;
  };
  const sizes = (option('sizes') ?? '100,1000,10000')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (sizes.length === 0) throw new Error('--sizes needs at least one positive integer');
  const requestedTopologies = (option('topologies') ?? 'sparse,hub').split(',').map((value) => value.trim());
  const topologies = requestedTopologies.filter(
    (value): value is Topology => value === 'sparse' || value === 'hub',
  );
  if (topologies.length !== requestedTopologies.length) {
    throw new Error('--topologies accepts only sparse and hub');
  }
  const samples = Number(option('samples') ?? '30');
  if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples needs a positive integer');
  const throttle = Number(option('throttle') ?? '4');
  if (!Number.isFinite(throttle) || throttle < 1) throw new Error('--throttle needs a number >= 1');
  const seed = Number(option('seed') ?? '7');
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  return { sizes, topologies, samples, throttle, cli: option('cli'), seed, out: option('out') };
}

function generatorTopology(topology: Topology): CorpusTopology {
  return topology === 'hub' ? 'skewed' : 'sparse';
}

/** Host paths that must never reach stdout; registered per workload. */
const scrubPaths: string[] = [ROOT, tmpdir()];

function scrub(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const path of scrubPaths) text = text.split(path).join('<workspace>');
  return text;
}

function round(value: number, places: number): number {
  return Number(value.toFixed(places));
}

/** Nearest-rank percentile over the finite values; method stated in the report. */
function percentile(values: readonly number[], fraction: number): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return round(sorted[rank]!, 3);
}

interface Series {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  values: number[];
}

function seriesOf(values: readonly number[]): Series {
  const finite = values.filter((value) => Number.isFinite(value)).map((value) => round(value, 3));
  return {
    n: finite.length,
    min: percentile(finite, 0),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: percentile(finite, 1),
    values: finite,
  };
}

interface NumericDistribution {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
  total: number | null;
}

function distributionOf(values: readonly number[]): NumericDistribution {
  const finite = values.filter((value) => Number.isFinite(value));
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    n: finite.length,
    min: percentile(finite, 0),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: percentile(finite, 1),
    mean: finite.length === 0 ? null : round(total / finite.length, 3),
    total: finite.length === 0 ? null : round(total, 3),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  visit(root);
  return found;
}

interface FixtureIdentity {
  sha256: string;
  files: number;
  method: string;
}

/** SHA-256 over every regular file with length-framed paths and contents. */
function fixtureIdentity(directory: string): FixtureIdentity {
  const relativePaths = walkFiles(directory)
    .map((file) => relative(directory, file).split(sep).join('/'))
    .sort();
  const hash = createHash('sha256');
  for (const path of relativePaths) {
    const contents = readFileSync(join(directory, path));
    hash.update(`${Buffer.byteLength(path, 'utf8')}:`, 'utf8');
    hash.update(path, 'utf8');
    hash.update(`${contents.byteLength}:`, 'utf8');
    hash.update(contents);
  }
  return {
    sha256: hash.digest('hex'),
    files: relativePaths.length,
    method: 'sha256(path byte length + path bytes + file byte length + file bytes), regular files sorted by relative path',
  };
}

/** Keep a small withheld slice while making `size` mean published DB nodes. */
function generatorNotesForPublishedSize(size: number): number {
  return size + Math.max(1, Math.ceil(size * 0.04));
}

function generatorRequest(options: Options, size: number, topology: Topology): GeneratorRequest {
  return {
    notes: generatorNotesForPublishedSize(size),
    seed: options.seed,
    topology: generatorTopology(topology),
    metadata: true,
  };
}

interface CorpusFinalization {
  result: GeneratedCorpus;
  promoted: number;
  demoted: number;
}

function markdownFiles(directory: string): { file: string; relativePath: string }[] {
  return walkFiles(directory)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, relativePath: relative(directory, file).split(sep).join('/') }))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

function hasPublishFalse(text: string): boolean {
  const frontmatter = /^(?:---\r?\n)([\s\S]*?)(?:\r?\n---\r?\n?)/.exec(text);
  return frontmatter !== null && /^publish:\s*false\s*$/m.test(frontmatter[1]!);
}

/** Toggle only the generator's publication flag, preserving authored content. */
function setPublishFalse(file: string, withheld: boolean): number {
  const before = readFileSync(file, 'utf8');
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (end < 0) {
    if (!withheld) throw new Error(`cannot publish a Markdown file without frontmatter: ${basename(file)}`);
    lines.unshift('---', 'publish: false', '---', '');
  } else {
    const flag = lines.findIndex((line, index) => index > 0 && index < end && /^publish:\s*false\s*$/.test(line));
    if (withheld && flag < 0) lines.splice(1, 0, 'publish: false');
    if (!withheld && flag >= 0) lines.splice(flag, 1);
  }
  const after = lines.join(newline);
  if (after !== before) writeFileSync(file, after, 'utf8');
  return Buffer.byteLength(after, 'utf8') - Buffer.byteLength(before, 'utf8');
}

/**
 * The generator's random withholding is useful coverage, but its count is not
 * a workload size contract. Normalize the publication flags after generation
 * so the finalized DB has exactly the requested published-node count while the
 * raw generator request and return value remain visible in the report.
 */
function finalizeCorpus(
  directory: string,
  requestedPublished: number,
  generated: GeneratedCorpus,
): CorpusFinalization {
  const files = markdownFiles(directory);
  if (requestedPublished < 1 || requestedPublished >= files.length) {
    throw new Error(`requested ${requestedPublished} published notes from ${files.length} generated Markdown files`);
  }
  const classified = files.map((entry) => ({ ...entry, withheld: hasPublishFalse(readFileSync(entry.file, 'utf8')) }));
  const withheld = classified.filter((entry) => entry.withheld);
  const published = classified.filter((entry) => !entry.withheld);
  if (published.length !== generated.published || withheld.length !== generated.withheld) {
    throw new Error(
      `generator result ${generated.published}/${generated.withheld} disagrees with generated Markdown ${published.length}/${withheld.length}`,
    );
  }
  const promoted = Math.max(0, requestedPublished - generated.published);
  const demoted = Math.max(0, generated.published - requestedPublished);
  if (promoted > withheld.length || demoted > published.length) {
    throw new Error(
      `cannot finalize ${requestedPublished} published notes from generator result ${generated.published}/${generated.withheld}`,
    );
  }
  let bytes = generated.bytes;
  for (const { file } of withheld.slice(0, promoted)) bytes += setPublishFalse(file, false);
  for (const { file } of published.slice(0, demoted)) bytes += setPublishFalse(file, true);
  const result: GeneratedCorpus = {
    ...generated,
    published: requestedPublished,
    withheld: files.length - requestedPublished,
    bytes,
  };
  return { result, promoted, demoted };
}

/**
 * Note text statistics over the corpus Markdown.
 *
 * Scope is every `.md` file the generator wrote, withheld ones included, and
 * the method is recorded beside the numbers: this describes the workload the
 * build was handed, not a DB projection (a withheld note has no DB row).
 */
function corpusTextStats(directory: string): {
  scope: string;
  files: number;
  noteBytes: NumericDistribution;
  paragraphs: NumericDistribution;
} {
  const markdown = walkFiles(directory).filter((file) => file.endsWith('.md'));
  const bytes: number[] = [];
  const paragraphs: number[] = [];
  for (const file of markdown) {
    const text = readFileSync(file, 'utf8');
    bytes.push(Buffer.byteLength(text, 'utf8'));
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    paragraphs.push(body.split(/\r?\n\s*\r?\n/).filter((block) => block.trim() !== '').length);
  }
  return {
    scope: 'all generator-written Markdown files, withheld included',
    files: markdown.length,
    noteBytes: distributionOf(bytes),
    paragraphs: distributionOf(paragraphs),
  };
}

// --- Static server ---------------------------------------------------------------

interface HeaderRule {
  matcher: RegExp;
  headers: Record<string, string>;
}

/**
 * Parse the Cloudflare Pages `_headers` grammar, exactly as
 * `tests/support/browser-site.ts` does: an unindented line is a path pattern,
 * an indented `Name: value` line attaches to it, `#` starts a comment. Keeping
 * the rules per path is what makes the server under test the deployment's
 * policy rather than one flattened header set.
 */
function headerRules(text: string): HeaderRule[] {
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

function applyHeaderRules(rules: readonly HeaderRule[], pathname: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.matcher.test(pathname)) continue;
    Object.assign(headers, rule.headers);
  }
  return headers;
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
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

interface ServerRecord {
  path: string;
  method: string;
  status: number;
  cacheControl: string;
  contentEncoding: string | null;
  contentLength: string | null;
  bytesServed: number;
  startedAtMs: number;
  endedAtMs: number;
}

interface StaticServer {
  origin: string;
  headersSource: string;
  records: ServerRecord[];
  close(): Promise<void>;
}

/**
 * Serve `dist/` on loopback with per-path `_headers`, gzip negotiation, and a
 * response log.
 *
 * gzip is applied whenever the request's `Accept-Encoding` names it, and the
 * same `gzipSync` result is reused for the dependency table, so the wire bytes
 * the server reports and the compressed bytes the report classifies are one
 * computation rather than two that can disagree. `Content-Length` is always
 * the bytes of the body actually written.
 */
async function startStaticServer(dist: string): Promise<StaticServer> {
  const outputHeaders = join(dist, '_headers');
  const headersSource = existsSync(outputHeaders) ? 'dist/_headers' : 'public/_headers';
  const rules = headerRules(readFileSync(existsSync(outputHeaders) ? outputHeaders : join(ROOT, 'public', '_headers'), 'utf8'));
  const records: ServerRecord[] = [];
  const gzipCache = new Map<string, Buffer>();
  const root = resolve(dist);
  const serverStart = Date.now();
  const server: Server = createServer((request, response) => {
    const startedAtMs = Date.now();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400);
      response.end('bad request');
      records.push({
        path: request.url ?? '/',
        method: request.method ?? 'GET',
        status: 400,
        cacheControl: '',
        contentEncoding: null,
        contentLength: null,
        bytesServed: 0,
        startedAtMs,
        endedAtMs: Date.now(),
      });
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const headers = applyHeaderRules(rules, pathname);
    if (headers['Cache-Control'] === undefined) headers['Cache-Control'] = PLATFORM_REVALIDATION;
    const record = (status: number, bodyBytes: number, contentEncoding: string | null): void => {
      records.push({
        path: pathname,
        method: request.method ?? 'GET',
        status,
        cacheControl: headers['Cache-Control'] ?? '',
        contentEncoding,
        contentLength: headers['Content-Length'] ?? null,
        bytesServed: bodyBytes,
        startedAtMs: Date.now() - serverStart,
        endedAtMs: Date.now() - serverStart,
      });
    };
    const file = resolve(root, `.${pathname}`);
    // Directory boundary, not a string prefix: `/tmp/x/dist2/...` starts with
    // `/tmp/x/dist`, so a prefix test would serve a sibling's bytes.
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403, headers);
      response.end('forbidden');
      record(403, 0, null);
      return;
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      response.writeHead(404, headers);
      response.end('not found');
      record(404, 0, null);
      return;
    }
    const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    if (request.headers['if-none-match'] === etag) {
      headers['ETag'] = etag;
      response.writeHead(304, headers);
      response.end();
      record(304, 0, null);
      return;
    }
    let body: Buffer = readFileSync(file);
    let contentEncoding: string | null = null;
    if ((request.headers['accept-encoding'] ?? '').includes('gzip')) {
      const key = `${file}:${stat.size}:${stat.mtimeMs}`;
      let compressed = gzipCache.get(key);
      if (compressed === undefined) {
        compressed = gzipSync(body);
        gzipCache.set(key, compressed);
      }
      body = compressed;
      contentEncoding = 'gzip';
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    }
    headers['Content-Type'] = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    headers['Content-Length'] = String(body.length);
    headers['ETag'] = etag;
    response.writeHead(200, headers);
    response.end(body);
    record(200, body.length, contentEncoding);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    headersSource,
    records,
    close(): Promise<void> {
      return new Promise((done) => server.close(() => done()));
    },
  };
}

// --- Database analysis -----------------------------------------------------------

interface DegreeRow {
  slug: string;
  degree: number;
}

interface DatabaseIdentity {
  file: string;
  sha256: string;
  digestMatchesFileName: boolean;
  rows: { nodes: number; edges: number; aliases: number; tags: number; nodeTags: number };
  notesPublished: number;
  notesWithheld: number | null;
  inDegree: { distribution: NumericDistribution; top: DegreeRow[] };
  outDegree: { distribution: NumericDistribution; top: DegreeRow[] };
  corpus: ReturnType<typeof corpusTextStats>;
}

interface WorkloadPlan {
  pageSlug: string;
  previewSlug: string;
  backlinkAnchor: string;
  outgoingAnchor: string;
  localCenter: string;
  tagKey: string | null;
  tagLabel: string | null;
  tagMembers: number;
  nodeCount: number;
  edgeCount: number;
}

interface DatabaseAnalysis {
  identity: DatabaseIdentity;
  plan: WorkloadPlan;
  inDegree: Map<string, number>;
  outDegree: Map<string, number>;
}

function queryRows<T>(db: DatabaseSync, sql: string, params: readonly (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function queryValue(
  db: DatabaseSync,
  sql: string,
  params: readonly (string | number | null)[] = [],
): unknown {
  const row = queryRows<Record<string, unknown>>(db, sql, params)[0];
  return row === undefined ? undefined : Object.values(row)[0];
}

function topDegrees(degrees: ReadonlyMap<string, number>, nodes: readonly string[]): DegreeRow[] {
  return [...nodes]
    .map((slug) => ({ slug, degree: degrees.get(slug) ?? 0 }))
    .sort((a, b) => (b.degree !== a.degree ? b.degree - a.degree : a.slug < b.slug ? -1 : 1))
    .slice(0, 5);
}

/** Everything section A asks about the finalized DB, plus the plan the runs use. */
function analyseDatabase(
  db: DatabaseSync,
  fileName: string,
  fileDigest: string,
  corpus: ReturnType<typeof corpusTextStats>,
  finalized: GeneratedCorpus | null,
): DatabaseAnalysis {
  const rows = {
    nodes: Number(queryValue(db, 'SELECT COUNT(*) FROM nodes') ?? 0),
    edges: Number(queryValue(db, 'SELECT COUNT(*) FROM edges') ?? 0),
    aliases: Number(queryValue(db, 'SELECT COUNT(*) FROM aliases') ?? 0),
    tags: Number(queryValue(db, 'SELECT COUNT(*) FROM tags') ?? 0),
    nodeTags: Number(queryValue(db, 'SELECT COUNT(*) FROM node_tags') ?? 0),
  };
  const nodes = queryRows<{ slug: string }>(db, 'SELECT slug FROM nodes').map((row) => row.slug);
  // Seed every published node so isolated nodes contribute zero to the
  // distribution, not only to the top-list fallback.
  const inDegree = new Map<string, number>(nodes.map((slug): [string, number] => [slug, 0]));
  const outDegree = new Map<string, number>(nodes.map((slug): [string, number] => [slug, 0]));
  for (const row of queryRows<{ slug: string; degree: number }>(
    db,
    `SELECT n.slug AS slug, COUNT(*) AS degree
     FROM edges AS e JOIN nodes AS n ON n.id = e.target_id
     GROUP BY n.id`,
  )) {
    inDegree.set(row.slug, Number(row.degree));
  }
  for (const row of queryRows<{ slug: string; degree: number }>(
    db,
    `SELECT n.slug AS slug, COUNT(*) AS degree
     FROM edges AS e JOIN nodes AS n ON n.id = e.source_id
     GROUP BY n.id`,
  )) {
    outDegree.set(row.slug, Number(row.degree));
  }
  const total = new Map<string, number>();
  for (const slug of nodes) total.set(slug, (inDegree.get(slug) ?? 0) + (outDegree.get(slug) ?? 0));
  const byTotal = [...nodes].sort((a, b) =>
    (total.get(b) ?? 0) !== (total.get(a) ?? 0) ? (total.get(b) ?? 0) - (total.get(a) ?? 0) : a < b ? -1 : 1,
  );
  const byIn = [...nodes].sort((a, b) =>
    (inDegree.get(b) ?? 0) !== (inDegree.get(a) ?? 0) ? (inDegree.get(b) ?? 0) - (inDegree.get(a) ?? 0) : a < b ? -1 : 1,
  );
  const byOut = [...nodes].sort((a, b) =>
    (outDegree.get(b) ?? 0) !== (outDegree.get(a) ?? 0) ? (outDegree.get(b) ?? 0) - (outDegree.get(a) ?? 0) : a < b ? -1 : 1,
  );
  const busiestTag = queryRows<{ key: string; label: string; members: number }>(
    db,
    `SELECT t.key AS key, t.label AS label, COUNT(*) AS members
     FROM tags AS t JOIN node_tags AS nt ON nt.tag_id = t.id
     GROUP BY t.id
     ORDER BY members DESC, t.key ASC
     LIMIT 1`,
  )[0];
  const pageSlug = byTotal[0];
  if (pageSlug === undefined) throw new Error('the finalized DB has no published nodes');
  const digestMatch = /^site\.([0-9a-f]{64})\.sqlite$/.exec(fileName);
  return {
    identity: {
      file: `/data/${fileName}`,
      sha256: fileDigest,
      digestMatchesFileName: digestMatch?.[1] === fileDigest,
      rows,
      notesPublished: rows.nodes,
      notesWithheld: finalized === null ? null : finalized.withheld,
      inDegree: { distribution: distributionOf([...inDegree.values()]), top: topDegrees(inDegree, nodes) },
      outDegree: { distribution: distributionOf([...outDegree.values()]), top: topDegrees(outDegree, nodes) },
      corpus,
    },
    plan: {
      pageSlug,
      previewSlug: pageSlug,
      backlinkAnchor: byIn[0] ?? pageSlug,
      outgoingAnchor: byOut[0] ?? pageSlug,
      localCenter: pageSlug,
      tagKey: busiestTag?.key ?? null,
      tagLabel: busiestTag?.label ?? null,
      tagMembers: Number(busiestTag?.members ?? 0),
      nodeCount: rows.nodes,
      edgeCount: rows.edges,
    },
    inDegree,
    outDegree,
  };
}

interface DependencyFile {
  kind: 'snapshot' | 'wasm-binary' | 'wasm-glue' | 'worker-chunk';
  path: string;
  file: string;
}

/** The complete SQLite dependency set the build wrote, classified by kind. */
function dependencyFiles(dist: string): DependencyFile[] {
  const found: DependencyFile[] = [];
  const dataDirectory = join(dist, 'data');
  if (existsSync(dataDirectory)) {
    for (const name of readdirSync(dataDirectory).filter((entry) => SNAPSHOT_FILE_PATTERN.test(entry))) {
      found.push({ kind: 'snapshot', path: `/data/${name}`, file: join(dataDirectory, name) });
    }
  }
  const wasmDirectory = join(dist, 'wasm');
  if (existsSync(wasmDirectory)) {
    for (const name of readdirSync(wasmDirectory)) {
      found.push({
        kind: name.endsWith('.wasm') ? 'wasm-binary' : 'wasm-glue',
        path: `/wasm/${name}`,
        file: join(wasmDirectory, name),
      });
    }
  }
  const astroDirectory = join(dist, '_astro');
  if (existsSync(astroDirectory)) {
    for (const name of readdirSync(astroDirectory)) {
      if (WORKER_CHUNK_PATTERN.test(`/_astro/${name}`)) {
        found.push({ kind: 'worker-chunk', path: `/_astro/${name}`, file: join(astroDirectory, name) });
      }
    }
  }
  return found;
}

// --- Page-side recorder and driver ----------------------------------------------

interface WorkerPhases {
  totalMs: number | null;
  fetchMs: number | null;
  digestMs: number | null;
  wasmInitMs: number | null;
  importMs: number | null;
  wasmMemoryBytes: number | null;
}

function normalizePhases(value: unknown): WorkerPhases | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    totalMs: numberOrNull(record['totalMs']),
    fetchMs: numberOrNull(record['fetchMs']),
    digestMs: numberOrNull(record['digestMs']),
    wasmInitMs: numberOrNull(record['wasmInitMs']),
    importMs: numberOrNull(record['importMs']),
    wasmMemoryBytes: numberOrNull(record['wasmMemoryBytes']),
  };
}

interface SnapshotEvent {
  type: string;
  ms: number | null;
  operationMs: number | null;
  sqlMs: number | null;
  phases: WorkerPhases | null;
}

interface GraphRenderEvent {
  scope: string;
  ms: number | null;
}

interface PreviewObservation {
  intentAt: number;
  href: string;
  slug: string | null;
  visibleAt: number | null;
  text: string | null;
}

interface RecorderState {
  snapshot: SnapshotEvent[];
  graphRender: GraphRenderEvent[];
  preview: PreviewObservation[];
}

/**
 * Arm the page-side instrument on every document in a context.
 *
 * `__snapshotMeasurement` is the runtime's existing armed flag; the recorder's
 * listeners are passive and carry no corpus data. The preview observer records
 * the `pointerover` intent and the panel's own unhide on the page's clock, so
 * the hover delay is observed rather than a constant subtracted from the
 * harness's timing.
 */
async function installRecorder(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const state = window as unknown as {
      __snapshotMeasurement?: boolean;
      __benchSnapshot: SnapshotEvent[];
      __benchGraphRender: GraphRenderEvent[];
      __benchPreview: PreviewObservation[];
    };
    state.__snapshotMeasurement = true;
    state.__benchSnapshot = [];
    state.__benchGraphRender = [];
    state.__benchPreview = [];

    const slugOf = (href: string): string | null => {
      try {
        const match = /^\/notes\/([^/]+)\/$/.exec(new URL(href, location.origin).pathname);
        return match === null ? null : match[1]!;
      } catch {
        return null;
      }
    };
    const eligible = (link: HTMLAnchorElement): boolean => {
      try {
        const url = new URL(link.href, location.origin);
        return url.origin === location.origin && url.pathname !== location.pathname && slugOf(url.pathname) !== null;
      } catch {
        return false;
      }
    };

    document.addEventListener(
      'pointerover',
      (event) => {
        const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!(target instanceof HTMLAnchorElement) || !eligible(target)) return;
        const href = target.getAttribute('href') ?? '';
        state.__benchPreview.push({ intentAt: performance.now(), href, slug: slugOf(href), visibleAt: null, text: null });
      },
      true,
    );

    document.addEventListener(
      'snapshot-result',
      (event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        state.__benchSnapshot.push({
          type: typeof detail['type'] === 'string' ? detail['type'] : 'unknown',
          ms: typeof detail['ms'] === 'number' ? detail['ms'] : null,
          operationMs: typeof detail['operationMs'] === 'number' ? detail['operationMs'] : null,
          sqlMs: typeof detail['sqlMs'] === 'number' ? detail['sqlMs'] : null,
          phases: (detail['phases'] ?? null) as WorkerPhases | null,
        });
      },
      true,
    );

    document.addEventListener(
      'graph-render',
      (event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        state.__benchGraphRender.push({
          scope: typeof detail['scope'] === 'string' ? detail['scope'] : 'unknown',
          ms: typeof detail['ms'] === 'number' ? detail['ms'] : null,
        });
      },
      true,
    );

    const observer = new MutationObserver(() => {
      const panel = document.querySelector<HTMLElement>('#link-preview');
      if (panel === null || panel.hidden) return;
      const last = state.__benchPreview.at(-1);
      if (last === undefined || last.visibleAt !== null) return;
      last.visibleAt = performance.now();
      last.text = (panel.textContent ?? '').slice(0, 2000);
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  });
}

/** Read one page's recorder arrays as plain data. */
async function readRecorder(page: Page): Promise<RecorderState> {
  return page.evaluate(() => {
    const state = window as unknown as {
      __benchSnapshot?: SnapshotEvent[];
      __benchGraphRender?: GraphRenderEvent[];
      __benchPreview?: PreviewObservation[];
    };
    const snapshot = (state.__benchSnapshot ?? []).map((event) => ({
      ...event,
      phases: event.phases ?? null,
    }));
    return {
      snapshot,
      graphRender: state.__benchGraphRender ?? [],
      preview: state.__benchPreview ?? [],
    };
  });
}

/**
 * Mark and return the first previewable note link on the page.
 *
 * Eligibility mirrors `link-preview.ts`: same origin, not the page's own
 * route, and a `/notes/<slug>/` path. The link is marked with a data attribute
 * so the hover target is one element rather than a selector re-derived from a
 * value that could be quoted.
 */
async function firstEligibleLink(page: Page): Promise<{ href: string; slug: string } | null> {
  return page.evaluate(() => {
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (link.origin !== location.origin) continue;
      const match = /^\/notes\/([^/]+)\/$/.exec(link.pathname);
      if (match === null || link.pathname === location.pathname) continue;
      link.setAttribute('data-bench-target-link', '');
      return { href: link.getAttribute('href') ?? '', slug: match[1]! };
    }
    return null;
  });
}

/** The installed class definition, imported from the gate that owns it. */
function sqliteAssetDefinition(): string {
  return "url includes '/data/site.', '/wasm/', or matches WORKER_CHUNK_PATTERN (/\\/_astro\\/snapshot-worker-[\\w-]+\\.js$/); imported from tests/support/browser-site.ts";
}

interface RenderTiming {
  domContentLoadedEventEnd: number | null;
  loadEventEnd: number | null;
  firstContentfulPaint: number | null;
  transferredBytes: number | null;
  documentTransferBytes: number | null;
  resourceTransferBytes: number | null;
  resourceCount: number;
}

async function navigationTiming(page: Page): Promise<RenderTiming> {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint');
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const resourceTransfer = resources.reduce((sum, entry) => sum + (entry.transferSize ?? 0), 0);
    const documentTransfer = navigation?.transferSize ?? 0;
    return {
      domContentLoadedEventEnd: navigation?.domContentLoadedEventEnd ?? null,
      loadEventEnd: navigation?.loadEventEnd ?? null,
      firstContentfulPaint: paint === undefined ? null : paint.startTime ?? null,
      transferredBytes: documentTransfer + resourceTransfer,
      documentTransferBytes: documentTransfer,
      resourceTransferBytes: resourceTransfer,
      resourceCount: resources.length,
    };
  });
}

interface ResourceEntry {
  source: 'page' | 'worker';
  page: string;
  path: string;
  encodedBodySize: number | null;
  decodedBodySize: number | null;
  transferSize: number | null;
  duration: number | null;
  responseStatus: number | null;
  initiatorType: string | null;
}

/**
 * Collect the page's and its workers' resource timings.
 *
 * The page's own timeline carries the Worker chunk (a page-initiated
 * construction) but not the DB, WASM binary, or glue, because those are
 * fetched *inside* the Worker and Chrome attributes them to the worker's own
 * timeline; both are collected here under `source` so the dependency table can
 * use the real numbers instead of a page-side absence reported as zero.
 */
async function collectResources(page: Page, label: string, out: ResourceEntry[]): Promise<void> {
  const readEntries = (): Omit<ResourceEntry, 'source' | 'page'>[] => {
    return (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((entry) => {
      let path: string;
      try {
        path = new URL(entry.name).pathname;
      } catch {
        path = entry.name;
      }
      return {
        path,
        encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
        decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
        transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
        duration: Number.isFinite(entry.duration) ? entry.duration : null,
        responseStatus:
          typeof (entry as { responseStatus?: unknown }).responseStatus === 'number'
            ? ((entry as { responseStatus: number }).responseStatus)
            : null,
        initiatorType: entry.initiatorType ?? null,
      };
    });
  };
  for (const entry of await page.evaluate(readEntries).catch(() => [])) {
    out.push({ source: 'page', page: label, ...entry });
  }
  for (const worker of page.workers()) {
    for (const entry of await worker.evaluate(readEntries).catch(() => [])) {
      out.push({ source: 'worker', page: label, ...entry });
    }
  }
}

interface HeapSummary {
  samples: number;
  arrayBufferObserved: boolean;
  peakJsHeapBytes: number | null;
  steadyJsHeapBytes: number | null;
  peakArrayBufferBytes: number | null;
  steadyArrayBufferBytes: number | null;
}

/** Poll CDP `Performance.getMetrics` until stopped; the last sample is steady. */
function startHeapPolling(session: CDPSession): { stop: () => Promise<HeapSummary> } {
  const values: { jsHeap: number | null; arrayBuffer: number | null }[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const metrics = await session.send('Performance.getMetrics').catch(() => null);
      if (metrics !== null) {
        const find = (name: string): number | null => {
          const metric = metrics.metrics.find((entry) => entry.name === name);
          return metric === undefined || !Number.isFinite(metric.value) ? null : Math.round(metric.value);
        };
        values.push({ jsHeap: find('JSHeapUsedSize'), arrayBuffer: find('ArrayBufferBytes') });
      }
      await new Promise((resolve) => setTimeout(resolve, HEAP_POLL_INTERVAL_MS));
    }
  })();
  return {
    async stop(): Promise<HeapSummary> {
      stopped = true;
      await loop;
      const jsHeap = values.map((sample) => sample.jsHeap).filter((value): value is number => value !== null);
      const arrayBuffer = values.map((sample) => sample.arrayBuffer).filter((value): value is number => value !== null);
      return {
        samples: values.length,
        arrayBufferObserved: values.some((sample) => sample.arrayBuffer !== null),
        peakJsHeapBytes: jsHeap.length === 0 ? null : Math.max(...jsHeap),
        steadyJsHeapBytes: jsHeap.at(-1) ?? null,
        peakArrayBufferBytes: arrayBuffer.length === 0 ? null : Math.max(...arrayBuffer),
        steadyArrayBufferBytes: arrayBuffer.at(-1) ?? null,
      };
    },
  };
}

// --- Driver Worker ----------------------------------------------------------------

interface DriverReply {
  id?: number;
  ok: boolean;
  code?: string;
  result?: {
    type: string;
    known?: boolean;
    page?: { notes: { slug: string; title: string; language: string }[]; nextCursor: string | null };
    preview?: { slug: string; title: string; excerpt: string } | null;
    graph?: {
      center?: { slug: string };
      nodes: { slug: string; title: string; language: string }[];
      edges: { from: string; to: string }[];
      omitted: number;
    } | null;
  };
  operationMs?: number;
  sqlMs?: number;
  phases?: unknown;
  dispatchMs: number;
}

async function installDriver(page: Page, workerPath: string): Promise<void> {
  await page.evaluate((script: string) => {
    const state = window as unknown as {
      __benchDriver?: {
        request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
      };
    };
    if (state.__benchDriver !== undefined) return;
    const pending = new Map<number, (reply: unknown) => void>();
    let nextId = 1;
    const worker = new Worker(script, { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent) => {
      const reply = event.data as { id?: unknown };
      if (typeof reply?.id !== 'number') return;
      const settle = pending.get(reply.id);
      if (settle === undefined) return;
      pending.delete(reply.id);
      settle(reply);
    });
    state.__benchDriver = {
      request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
        const id = nextId;
        nextId += 1;
        const started = performance.now();
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ id, ok: false, code: 'timeout', dispatchMs: performance.now() - started });
          }, timeoutMs);
          pending.set(id, (reply) => {
            clearTimeout(timer);
            resolve({ ...(reply as Record<string, unknown>), dispatchMs: performance.now() - started });
          });
          worker.postMessage({ ...message, id, measure: true });
        });
      },
    };
  }, workerPath);
}

function driverRequest(
  page: Page,
  type: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<DriverReply> {
  return page.evaluate(
    async (input: { type: string; args: Record<string, unknown>; timeoutMs: number }) => {
      const driver = (
        window as unknown as {
          __benchDriver?: { request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown> };
        }
      ).__benchDriver;
      if (driver === undefined) return { ok: false, code: 'no-driver', dispatchMs: 0 };
      return (await driver.request({ type: input.type, ...input.args }, input.timeoutMs)) as {
        ok: boolean;
        code?: string;
        result?: unknown;
        operationMs?: number;
        sqlMs?: number;
        phases?: unknown;
        dispatchMs: number;
      };
    },
    { type, args, timeoutMs },
  ) as Promise<DriverReply>;
}

interface OperationTiming {
  repetitions: number;
  dispatchMs: number[];
  operationMs: number[];
  sqlMs: number[];
  phases: WorkerPhases | null;
  dispatchSummary: Series;
  opSummary: Series;
}

function timingOf(): OperationTiming {
  return { repetitions: 0, dispatchMs: [], operationMs: [], sqlMs: [], phases: null, dispatchSummary: seriesOf([]), opSummary: seriesOf([]) };
}

function absorbTiming(timing: OperationTiming, reply: DriverReply): void {
  if (Number.isFinite(reply.dispatchMs)) timing.dispatchMs.push(round(reply.dispatchMs, 3));
  if (typeof reply.operationMs === 'number') timing.operationMs.push(round(reply.operationMs, 3));
  if (typeof reply.sqlMs === 'number') timing.sqlMs.push(round(reply.sqlMs, 3));
  if (timing.phases === null && reply.phases != null) timing.phases = normalizePhases(reply.phases);
}

function finalizeTiming(timing: OperationTiming, repetitions: number): OperationTiming {
  timing.repetitions = repetitions;
  timing.dispatchSummary = seriesOf(timing.dispatchMs);
  timing.opSummary = seriesOf(timing.operationMs);
  return timing;
}

interface WalkOutcome {
  timing: OperationTiming;
  pagesPerWalk: number;
  notes: { slug: string; title: string; language: string }[];
  failures: string[];
}

/** Drive one cursor operation across repetitions, walking `nextCursor` to null. */
async function driveWalk(
  page: Page,
  type: 'backlinks' | 'outgoing' | 'byTag',
  args: Record<string, unknown>,
  pageSize: number,
  repetitions: number,
): Promise<WalkOutcome> {
  const timing = timingOf();
  const failures: string[] = [];
  const notes: { slug: string; title: string; language: string }[] = [];
  let pagesPerWalk = 0;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const reply = await driverRequest(page, type, { ...args, cursor, pageSize }, DRIVER_WARM_TIMEOUT_MS);
      if (!reply.ok || reply.result === undefined) {
        failures.push(`${type} repetition ${repetition} page ${pages}: ${reply.code ?? 'failed'}`);
        break;
      }
      absorbTiming(timing, reply);
      const walkPage = reply.result.page;
      if (walkPage === undefined) {
        failures.push(`${type} repetition ${repetition}: reply carried no page`);
        break;
      }
      if (walkPage.notes.length > pageSize) {
        failures.push(`${type} returned ${walkPage.notes.length} notes for page size ${pageSize}`);
      }
      if (repetition === 0) notes.push(...walkPage.notes);
      cursor = walkPage.nextCursor;
      pages += 1;
      if (cursor === null) break;
      if (pages >= MAX_WALK_PAGES) {
        failures.push(`${type} cursor did not terminate within ${MAX_WALK_PAGES} pages`);
        break;
      }
    }
    if (repetition === 0) pagesPerWalk = pages;
  }
  return { timing: finalizeTiming(timing, repetitions), pagesPerWalk, notes, failures };
}

// --- Workload measurement ---------------------------------------------------------

interface GeneratorIdentity {
  name: string;
  seed: number;
  options: GeneratorRequest;
  result: GeneratedCorpus | null;
  finalized: CorpusFinalization | null;
}

interface BuildIdentity {
  seconds: number | null;
  cli: { basename: string; sha256: string };
}

interface FailoverRecord {
  phase: string;
  message: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface PreviewSample {
  intentToVisibleMs: number | null;
  hoverDelayMs: number | null;
  hoverDelaySource: string;
  visible: boolean;
  nonEmpty: boolean;
  targetSlug: string | null;
  targetTitle: string | null;
  titleMatched: boolean | null;
  panelTextSample: string | null;
  error: string | null;
}

interface PreviewReport {
  targetFromDb: { slug: string; title: string } | null;
  cold: PreviewSample;
  warm: PreviewSample;
}

interface StartupReport {
  instrument: string;
  blindSpots: string[];
  heap: HeapSummary | null;
  heapPeakNote: string;
  worker: {
    firstReplyMs: number | null;
    phases: WorkerPhases | null;
    phasesNote: string | null;
    wasmMemoryBytes: number | null;
  };
}

interface UiLocalGraphReport {
  activations: number;
  dispatchMs: number[];
  operationMs: number[];
  sqlMs: number[];
  phases: WorkerPhases | null;
  renderMs: number[];
  dispatchSummary: Series;
}

interface TagBrowseReport {
  tagKey: string;
  pages: number;
  notesShown: number;
  dispatchMs: number[];
  operationMs: number[];
  sqlMs: number[];
  phases: WorkerPhases | null;
  dispatchSummary: Series;
}

interface GlobalGraphUiReport {
  unfilteredMs: number[];
  filteredMs: number[];
  operationMs: number[];
  renderMs: number[];
  phases: WorkerPhases | null;
  filteredTag: string | null;
}

interface DriverOperationReport extends OperationTiming {
  pagesPerWalk?: number;
  notesWalked?: number;
  failures: string[];
}

interface QueriesReport {
  definitions: string[];
  ui: {
    localGraph: UiLocalGraphReport | null;
    tagBrowse: TagBrowseReport | null;
    globalGraph: GlobalGraphUiReport | null;
  };
  driver: Record<string, DriverOperationReport | null>;
  driverColdStart: {
    ok: boolean;
    code: string | null;
    dispatchMs: number | null;
    operationMs: number | null;
    sqlMs: number | null;
    phases: WorkerPhases | null;
  } | null;
  seam: { sqlMsObserved: boolean; phasesObserved: boolean };
}

interface DependencyReport {
  kind: DependencyFile['kind'];
  path: string;
  decodedBytes: number;
  gzipBytes: number;
  http: ServerRecord | null;
  /**
   * The cold observation: the resource-timing entry whose `transferSize`
   * includes the encoded body. Cache-hit observations (reported as a
   * header-only `transferSize` on Chromium) are counted separately rather
   * than replacing it.
   */
  resource: ResourceEntry | null;
  resourceObservations: number;
  cacheHitObservations: number;
  requests: number;
  cacheState: 'network' | 'revalidated' | 'cache' | 'not-requested' | 'unknown';
}

interface TransferReport {
  headersSource: string;
  definitions: string[];
  dependencies: DependencyReport[];
  serverRecords: ServerRecord[];
  resources: ResourceEntry[];
}

interface ReadingReport {
  definition: string;
  zeroRequests: {
    readingPage: { beforeIntent: boolean; urls: string[] };
    mainPage: { beforeIntent: boolean; urls: string[] };
  };
  active: RenderTiming | null;
  inactiveJavaScript: RenderTiming | null;
  delta: {
    domContentLoadedEventEnd: number | null;
    loadEventEnd: number | null;
    firstContentfulPaint: number | null;
    transferredBytes: number | null;
  };
  regressionNote: string;
}

interface WorkloadReport {
  id: string;
  size: number;
  topology: Topology;
  generator: GeneratorIdentity;
  fixture: FixtureIdentity | null;
  build: BuildIdentity | null;
  database: DatabaseIdentity | null;
  transfer: TransferReport | null;
  startup: StartupReport | null;
  preview: PreviewReport | null;
  queries: QueriesReport | null;
  reading: ReadingReport | null;
  checks: CheckResult[];
  failures: FailoverRecord[];
  elapsedSeconds: number;
}

function emptyPreviewSample(): PreviewSample {
  return {
    intentToVisibleMs: null,
    hoverDelayMs: null,
    hoverDelaySource:
      'page observer: pointerover on the eligible link to #link-preview unhidden with text; no constant subtracted',
    visible: false,
    nonEmpty: false,
    targetSlug: null,
    targetTitle: null,
    titleMatched: null,
    panelTextSample: null,
    error: null,
  };
}

async function withFailure(
  workload: WorkloadReport,
  phase: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    workload.failures.push({ phase, message: scrub(error) });
  }
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The browser version the workload runs observed; the report records one. */
let observedBrowserVersion: string | null = null;

/**
 * Measure one (size, topology) workload end to end.
 *
 * A failure inside a phase is recorded on the workload and later phases still
 * run, because a benchmark that stops at the first timeout measures less than
 * the one failure. The corpus directory is removed in `finally`; the report
 * keeps only its hash.
 */
async function measureWorkload(
  options: Options,
  cliPath: string,
  size: number,
  topology: Topology,
): Promise<WorkloadReport> {
  const startedAt = Date.now();
  const id = `${size}-${topology}`;
  const request = generatorRequest(options, size, topology);
  const workload: WorkloadReport = {
    id,
    size,
    topology,
    generator: {
      name: 'scripts/generate-corpus.ts#generateCorpus',
      seed: options.seed,
      options: request,
      result: null,
      finalized: null,
    },
    fixture: null,
    build: null,
    database: null,
    transfer: null,
    startup: null,
    preview: null,
    queries: null,
    reading: null,
    checks: [],
    failures: [],
    elapsedSeconds: 0,
  };
  const root = mkdtempSync(join(tmpdir(), `anc-bench-${id}-`));
  scrubPaths.push(root);
  let server: StaticServer | undefined;
  let browser: Browser | undefined;
  let db: DatabaseSync | undefined;
  try {
    const contentDirectory = join(root, 'notes');
    mkdirSync(contentDirectory, { recursive: true });
    const generated = await generateCorpus(contentDirectory, workload.generator.options);
    workload.generator.result = {
      files: generated.files,
      published: generated.published,
      withheld: generated.withheld,
      assets: generated.assets,
      bytes: generated.bytes,
    };
    const corpusFinalization = finalizeCorpus(contentDirectory, size, workload.generator.result);
    workload.generator.finalized = corpusFinalization;
    workload.fixture = fixtureIdentity(contentDirectory);
    const corpusText = corpusTextStats(contentDirectory);

    const buildStarted = Date.now();
    const build = spawnSync(process.execPath, [cliPath, 'build', '--content', 'notes', '--out', 'dist'], {
      cwd: root,
      encoding: 'utf8',
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    workload.build = {
      seconds: round((Date.now() - buildStarted) / 1000, 2),
      cli: { basename: basename(cliPath), sha256: sha256File(cliPath) },
    };
    if (build.status !== 0) {
      throw new Error(`build exited ${String(build.status)}: ${(build.stderr || build.stdout).slice(0, 4000)}`);
    }

    const dist = join(root, 'dist');
    const dataDirectory = join(dist, 'data');
    const snapshots = existsSync(dataDirectory)
      ? readdirSync(dataDirectory).filter((name) => SNAPSHOT_FILE_PATTERN.test(name))
      : [];
    if (snapshots.length !== 1) throw new Error(`expected one finalized snapshot, found ${snapshots.length}`);
    const fileName = snapshots[0]!;
    const fileDigest = sha256File(join(dataDirectory, fileName));
    db = new DatabaseSync(join(dataDirectory, fileName), { readOnly: true });
    const finalized = corpusFinalization.result;
    const analysis = analyseDatabase(db, fileName, fileDigest, corpusText, finalized);
    workload.database = analysis.identity;
    if (!analysis.identity.digestMatchesFileName) {
      workload.failures.push({ phase: 'database', message: 'snapshot file name digest does not match its bytes' });
    }
    if (finalized.published !== analysis.identity.rows.nodes) {
      workload.failures.push({
        phase: 'database',
        message: `finalized corpus published ${finalized.published}, DB nodes ${analysis.identity.rows.nodes}`,
      });
    }
    if (size !== analysis.identity.rows.nodes) {
      workload.failures.push({
        phase: 'database',
        message: `requested ${size} published notes, DB nodes ${analysis.identity.rows.nodes}`,
      });
    }
    const plan = analysis.plan;

    const dependencies = dependencyFiles(dist).map((dependency) => {
      const bytes = readFileSync(dependency.file);
      return { ...dependency, decodedBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
    });
    const workerChunk = (() => {
      try {
        return workerScriptPath(dist);
      } catch {
        return null;
      }
    })();

    server = await startStaticServer(dist);
    const resources: ResourceEntry[] = [];
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    observedBrowserVersion = browser.version();
    const pageUrl = `${server.origin}/notes/${plan.pageSlug}/`;
    const inactiveUrl = `${server.origin}/notes/${plan.pageSlug}/`;

    // --- F. Ordinary reading: inactive first, in its own fresh context ---
    const reading: ReadingReport = {
      definition: sqliteAssetDefinition(),
      zeroRequests: {
        readingPage: { beforeIntent: false, urls: [] },
        mainPage: { beforeIntent: false, urls: [] },
      },
      active: null,
      inactiveJavaScript: null,
      delta: {
        domContentLoadedEventEnd: null,
        loadEventEnd: null,
        firstContentfulPaint: null,
        transferredBytes: null,
      },
      regressionNote:
        'positive delta = the enhancement build renders later than the no-JS build under the same host, viewport, and throttle; the enhancements are lazy by contract, so a material positive delta implicates script download/evaluation rather than SQLite work',
    };
    workload.reading = reading;

    const inactiveContext = await browser.newContext({ javaScriptEnabled: false, viewport: VIEWPORT });
    try {
      const page = await inactiveContext.newPage();
      const session = await inactiveContext.newCDPSession(page);
      if (options.throttle > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: options.throttle });
      await page.goto(inactiveUrl, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      reading.inactiveJavaScript = await navigationTiming(page);
    } finally {
      await inactiveContext.close();
    }

    const context = await browser.newContext({ viewport: VIEWPORT });
    await installRecorder(context);
    try {
      // Active initial render, no intent of any kind, under the same throttle
      // as the inactive measurement so the delta is one variable.
      const readingPage = await context.newPage();
      const readingSession = await context.newCDPSession(readingPage);
      if (options.throttle > 1) {
        await readingSession.send('Emulation.setCPUThrottlingRate', { rate: options.throttle });
      }
      const readingRequests = sqliteAssetRequests(readingPage);
      await readingPage.goto(pageUrl, { waitUntil: 'load' });
      await readingPage.waitForTimeout(300);
      await readingPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await readingPage.waitForTimeout(300);
      reading.active = await navigationTiming(readingPage);
      reading.zeroRequests.readingPage = {
        beforeIntent: readingRequests.length === 0,
        urls: readingRequests.map(urlPath),
      };
      const delta = (active: number | null, inactive: number | null): number | null =>
        active === null || inactive === null ? null : round(active - inactive, 3);
      reading.delta = {
        domContentLoadedEventEnd: delta(reading.active.domContentLoadedEventEnd, reading.inactiveJavaScript?.domContentLoadedEventEnd ?? null),
        loadEventEnd: delta(reading.active.loadEventEnd, reading.inactiveJavaScript?.loadEventEnd ?? null),
        firstContentfulPaint: delta(reading.active.firstContentfulPaint, reading.inactiveJavaScript?.firstContentfulPaint ?? null),
        transferredBytes: delta(reading.active.transferredBytes, reading.inactiveJavaScript?.transferredBytes ?? null),
      };
      if (readingRequests.length > 0) {
        workload.failures.push({
          phase: 'ordinary-reading',
          message: `reading page requested SQLite assets before intent: ${readingRequests.map(urlPath).join(', ')}`,
        });
      }
      await readingPage.close();

      let mainPage: Page | undefined;
      // --- B/C/D/E on the main page ---
      await withFailure(workload, 'preview-and-startup', async () => {
        const page = await context.newPage();
        mainPage = page;
        const session = await context.newCDPSession(page);
        if (options.throttle > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: options.throttle });
        await session.send('Performance.enable');
        const pageRequests = sqliteAssetRequests(page);
        const startup: StartupReport = {
          instrument:
            'CDP Performance.getMetrics on the page target: JSHeapUsedSize (main-thread JS heap) and ArrayBufferBytes when the browser reports it',
          blindSpots: [
            'main-thread JS heap only; not process RSS, not the Worker heap, not WASM linear memory',
            'the Worker target is not surfaced by Performance.getMetrics on the page session, so its heap and WASM memory are only visible through the runtime seam (phases.wasmMemoryBytes)',
            'CPU throttling (CDP Emulation.setCPUThrottlingRate) applies to the page target; the Worker target is not independently throttled, so this is simulation, never a physical device',
          ],
          heap: null,
          heapPeakNote: 'peak over the cold-intent polling window; steady is the last sample after the settle',
          worker: {
            firstReplyMs: null,
            phases: null,
            phasesNote: null,
            wasmMemoryBytes: null,
          },
        };
        workload.startup = startup;

        await page.goto(pageUrl, { waitUntil: 'load' });
        await page.waitForTimeout(300);
        reading.zeroRequests.mainPage = {
          beforeIntent: pageRequests.length === 0,
          urls: pageRequests.map(urlPath),
        };
        if (pageRequests.length > 0) {
          workload.failures.push({
            phase: 'ordinary-reading',
            message: `main page requested SQLite assets before intent: ${pageRequests.map(urlPath).join(', ')}`,
          });
        }

        workload.preview = { targetFromDb: null, cold: emptyPreviewSample(), warm: emptyPreviewSample() };
        workload.queries = {
          definitions: [
            'dispatch→result: armed request posted to observed successful snapshot-result on the page clock (event.ms)',
            'operationMs: the Worker reply’s own named-operation span after initialization',
            'sqlMs/phases: present only when the runtime measurement seam supplies them; null otherwise',
            'graph render: the graph client’s graph-render event, reported apart from query and messaging cost',
          ],
          ui: { localGraph: null, tagBrowse: null, globalGraph: null },
          driver: {},
          driverColdStart: null,
          seam: { sqlMsObserved: false, phasesObserved: false },
        };
        await withFailure(workload, 'cold-warm-preview', async () => {
        const target = await firstEligibleLink(page);
        if (target === null) throw new Error('no eligible published note link on the measured page');
        const polling = startHeapPolling(session);
        let coldSample = emptyPreviewSample();
        try {
          const coldStarted = Date.now();
          await page.locator('[data-bench-target-link]').hover();
          await page.locator('#link-preview').waitFor({ state: 'visible', timeout: HOVER_TIMEOUT_MS });
          coldSample.intentToVisibleMs = Date.now() - coldStarted;
          const coldRecorder = await readRecorder(page);
          const coldVisible =
            coldRecorder.preview.filter((observation) => observation.visibleAt !== null).at(-1) ?? null;
          if (coldVisible === null || coldVisible.slug !== target.slug) {
            throw new Error('the cold hover did not produce an observed preview for the marked link');
          }
          const coldText = coldVisible.text ?? '';
          coldSample = {
            ...coldSample,
            hoverDelayMs: round(coldVisible.visibleAt! - coldVisible.intentAt, 3),
            visible: true,
            nonEmpty: coldText.trim() !== '',
            targetSlug: coldVisible.slug,
            panelTextSample: coldText.slice(0, 200),
          };
          const firstReply = coldRecorder.snapshot.find((event) => event.ms !== null) ?? null;
          startup.worker.firstReplyMs = firstReply?.ms ?? null;
          const phasesEvent = coldRecorder.snapshot.find((event) => event.phases !== null) ?? null;
          startup.worker.phases = phasesEvent === null ? null : normalizePhases(phasesEvent.phases);
          startup.worker.wasmMemoryBytes = startup.worker.phases?.wasmMemoryBytes ?? null;
          startup.worker.phasesNote =
            phasesEvent === null
              ? 'no snapshot-result detail carried phases; the runtime measurement seam was not present at this run'
              : 'phases from the first armed snapshot-result detail that carried them';
        } catch (error) {
          coldSample.error = scrub(error);
          workload.failures.push({ phase: 'preview-cold', message: coldSample.error });
          startup.worker.phasesNote ??= 'the cold preview failed before any measured reply was observed';
        } finally {
          await page.waitForTimeout(STEADY_SETTLE_MS);
          startup.heap = await polling.stop();
        }

        // Warm preview: the same link after readiness.
        const warmSample = emptyPreviewSample();
        try {
          await page.mouse.move(0, 0);
          await page.locator('#link-preview').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(200);
          const warmStarted = Date.now();
          await page.locator('[data-bench-target-link]').hover();
          await page.locator('#link-preview').waitFor({ state: 'visible', timeout: WARM_PREVIEW_TIMEOUT_MS });
          warmSample.intentToVisibleMs = Date.now() - warmStarted;
          const warmRecorder = await readRecorder(page);
          const warmVisible =
            warmRecorder.preview.filter((observation) => observation.visibleAt !== null).at(-1) ?? null;
          if (warmVisible === null) throw new Error('the warm hover produced no observed visible panel');
          warmSample.hoverDelayMs = round(warmVisible.visibleAt! - warmVisible.intentAt, 3);
          warmSample.visible = true;
          warmSample.nonEmpty = (warmVisible.text ?? '').trim() !== '';
          warmSample.targetSlug = warmVisible.slug;
          warmSample.panelTextSample = (warmVisible.text ?? '').slice(0, 200);
        } catch (error) {
          warmSample.error = scrub(error);
          workload.failures.push({ phase: 'preview-warm', message: warmSample.error });
        }
        workload.preview = { targetFromDb: null, cold: coldSample, warm: warmSample };
        });

        // --- E(1) real UI flow: repeated local-graph activation ---
        await withFailure(workload, 'ui-local-graph', async () => {
        const localGraph = {
          activations: 0,
          dispatchMs: [] as number[],
          operationMs: [] as number[],
          sqlMs: [] as number[],
          phases: null as WorkerPhases | null,
          renderMs: [] as number[],
          dispatchSummary: seriesOf([]),
        };
        const activate = page.locator('[data-graph-activate]');
        if ((await activate.count()) > 0) {
          for (let index = 0; index < options.samples; index += 1) {
            try {
              await activate.click();
              await page.waitForFunction(
                (expected) =>
                  ((window as unknown as { __benchSnapshot?: { type: string; ms: number | null }[] }).__benchSnapshot ?? [])
                    .filter((event) => event.type === 'localGraph' && event.ms !== null).length >= expected,
                index + 1,
                { timeout: 15_000 },
              );
              localGraph.activations += 1;
            } catch {
              workload.failures.push({
                phase: 'ui-local-graph',
                message: `activation ${index + 1} produced no armed localGraph reply`,
              });
              break;
            }
          }
          // A render follows its reply; wait with a bound for the drawings to
          // catch up rather than reading early and dropping the slowest draw.
          await page
            .waitForFunction(
              (expected) =>
                ((window as unknown as { __benchGraphRender?: { scope: string }[] }).__benchGraphRender ?? [])
                  .filter((event) => event.scope === 'local').length >= expected,
              localGraph.activations,
              { timeout: 5_000 },
            )
            .catch(() => {});
          const events = await readRecorder(page);
          for (const event of events.snapshot.filter((entry) => entry.type === 'localGraph')) {
            if (event.ms !== null) localGraph.dispatchMs.push(round(event.ms, 3));
            if (event.operationMs !== null) localGraph.operationMs.push(round(event.operationMs, 3));
            if (event.sqlMs !== null) localGraph.sqlMs.push(round(event.sqlMs, 3));
            if (localGraph.phases === null && event.phases !== null) localGraph.phases = normalizePhases(event.phases);
          }
          localGraph.renderMs = events.graphRender
            .filter((event) => event.scope === 'local' && event.ms !== null)
            .map((event) => round(event.ms!, 3));
          localGraph.dispatchSummary = seriesOf(localGraph.dispatchMs);
        }
        workload.queries!.ui.localGraph =
          localGraph.activations === 0 && localGraph.dispatchMs.length === 0 ? null : localGraph;
        workload.queries!.seam = {
          sqlMsObserved: localGraph.sqlMs.length > 0,
          phasesObserved: localGraph.phases !== null,
        };
        });
      });

      // --- E(1) real UI flow: tag browser on its own page ---
      await withFailure(workload, 'ui-tag-browse', async () => {
        if (plan.tagKey === null || workload.queries === null) throw new Error('the corpus has no tag to browse');
        const page = await context.newPage();
        try {
          await page.goto(`${server!.origin}/tags/`, { waitUntil: 'load' });
          await page.waitForSelector('#tag-browser-select', { timeout: 15_000 });
          const dispatchMs: number[] = [];
          const operationMs: number[] = [];
          const sqlMs: number[] = [];
          let phases: WorkerPhases | null = null;
          // A page's recorder accumulates every reply; each read absorbs only
          // the events that arrived since the last one, or a ten-page walk would
          // re-record page one ten times and report its duration as a trend.
          let absorbed = 0;
          let byTagTotal = 0;
          const absorb = (events: SnapshotEvent[]): void => {
            for (const event of events.slice(absorbed)) {
              if (event.type !== 'byTag') continue;
              byTagTotal += 1;
              if (event.ms !== null) dispatchMs.push(round(event.ms, 3));
              if (event.operationMs !== null) operationMs.push(round(event.operationMs, 3));
              if (event.sqlMs !== null) sqlMs.push(round(event.sqlMs, 3));
              if (phases === null && event.phases !== null) phases = normalizePhases(event.phases);
            }
            absorbed = events.length;
          };
          await page.selectOption('#tag-browser-select', plan.tagKey);
          await page.waitForFunction(
            () =>
              ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).some(
                (event) => event.type === 'byTag',
              ),
            undefined,
            { timeout: 30_000 },
          );
          absorb((await readRecorder(page)).snapshot);
          let pages = 1;
          while (pages < MAX_WALK_PAGES && (await page.locator('#tag-browse-more').isVisible())) {
            const expected = byTagTotal;
            await page.locator('#tag-browse-more').click();
            await page
              .waitForFunction(
                (count) =>
                  ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).filter(
                    (event) => event.type === 'byTag',
                  ).length > count,
                expected,
                { timeout: 15_000 },
              )
              .catch(() => {});
            absorb((await readRecorder(page)).snapshot);
            if (byTagTotal === expected) break;
            pages += 1;
          }
          const notesShown = await page.locator('#tag-browser-results li').count();
          workload.queries!.ui.tagBrowse = {
            tagKey: plan.tagKey,
            pages,
            notesShown,
            dispatchMs,
            operationMs,
            sqlMs,
            phases,
            dispatchSummary: seriesOf(dispatchMs),
          };
          await collectResources(page, 'ui-tag-browse', resources);
        } finally {
          await page.close();
        }
      });

      // --- E(1) real UI flow: site graph, unfiltered then tag-filtered ---
      await withFailure(workload, 'ui-global-graph', async () => {
        if (workload.queries === null) throw new Error('query report was not initialized');
        const page = await context.newPage();
        try {
          await page.goto(`${server!.origin}/graph/`, { waitUntil: 'load' });
          const activate = page.locator('[data-graph-activate]');
          if ((await activate.count()) === 0) throw new Error('the site graph exposes no activation control');
          await activate.click();
          await page.waitForFunction(
            () =>
              ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).some(
                (event) => event.type === 'globalGraph',
              ),
            undefined,
            { timeout: 30_000 },
          );
          if (plan.tagKey !== null) {
            await page.selectOption('[data-graph-tag]', plan.tagKey);
            await page.waitForFunction(
              () =>
                ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).filter(
                  (event) => event.type === 'globalGraph',
                ).length >= 2,
              undefined,
              { timeout: 30_000 },
            );
          }
          await page
            .waitForFunction(
              () =>
                ((window as unknown as { __benchGraphRender?: { scope: string }[] }).__benchGraphRender ?? []).filter(
                  (event) => event.scope === 'global',
                ).length >= 1,
              undefined,
              { timeout: 5_000 },
            )
            .catch(() => {});
          const events = await readRecorder(page);
          const globals = events.snapshot.filter((event) => event.type === 'globalGraph');
          workload.queries!.ui.globalGraph = {
            unfilteredMs: globals.slice(0, 1).flatMap((event) => (event.ms === null ? [] : [round(event.ms, 3)])),
            filteredMs: globals.slice(1).flatMap((event) => (event.ms === null ? [] : [round(event.ms, 3)])),
            operationMs: globals.flatMap((event) => (event.operationMs === null ? [] : [round(event.operationMs, 3)])),
            renderMs: events.graphRender
              .filter((event) => event.scope === 'global' && event.ms !== null)
              .map((event) => round(event.ms!, 3)),
            phases: globals.find((event) => event.phases !== null)?.phases ?? null,
            filteredTag: plan.tagKey,
          };
          await collectResources(page, 'ui-global-graph', resources);
        } finally {
          await page.close();
        }
      });

      // --- E(2) driver Worker: armed named operations, cursor walks, invariants ---
      await withFailure(workload, 'driver', async () => {
        if (mainPage === undefined || workload.queries === null) throw new Error('the main page was not measured');
        if (workerChunk === null) throw new Error('the build carries no snapshot-worker chunk');
        await installDriver(mainPage, workerChunk);
        const driverReports: Record<string, DriverOperationReport | null> = {};
        const pageSize = MAX_PAGE_SIZE;

        const cold = await driverRequest(mainPage, 'preview', { slug: plan.previewSlug }, DRIVER_COLD_TIMEOUT_MS);
        workload.queries.driverColdStart = {
          ok: cold.ok,
          code: cold.code ?? null,
          dispatchMs: Number.isFinite(cold.dispatchMs) ? round(cold.dispatchMs, 3) : null,
          operationMs: numberOrNull(cold.operationMs),
          sqlMs: numberOrNull(cold.sqlMs),
          phases: normalizePhases(cold.phases),
        };
        if (!cold.ok) workload.failures.push({ phase: 'driver', message: `cold driver preview failed: ${cold.code ?? 'unknown'}` });
        if (cold.phases != null && workload.startup !== null && workload.startup.worker.phases === null) {
          workload.startup.worker.phases = normalizePhases(cold.phases);
          workload.startup.worker.wasmMemoryBytes = workload.startup.worker.phases?.wasmMemoryBytes ?? null;
          workload.startup.worker.phasesNote = 'phases from the driver Worker’s first armed reply (the page Worker’s seam was absent)';
        }

        const single = async (
          type: 'preview' | 'localGraph' | 'globalGraph',
          args: Record<string, unknown>,
          repetitions: number,
        ): Promise<{ timing: OperationTiming; first: DriverReply; failures: string[] }> => {
          const timing = timingOf();
          const failures: string[] = [];
          let first: DriverReply = cold;
          for (let index = 0; index < repetitions; index += 1) {
            const reply = await driverRequest(mainPage!, type, args, DRIVER_WARM_TIMEOUT_MS);
            if (!reply.ok) failures.push(`${type} repetition ${index}: ${reply.code ?? 'failed'}`);
            absorbTiming(timing, reply);
            if (index === 0) first = reply;
          }
          return { timing: finalizeTiming(timing, repetitions), first, failures };
        };

        const preview = await single('preview', { slug: plan.previewSlug }, options.samples);
        driverReports['preview'] = { ...preview.timing, failures: preview.failures };

        const backlinkRepetitions = Math.max(
          1,
          Math.min(options.samples, Math.floor(WALK_REQUEST_BUDGET / Math.max(1, Math.ceil(((analysis.inDegree.get(plan.backlinkAnchor) ?? 0) + 1) / pageSize)))),
        );
        const backlinks = await driveWalk(mainPage, 'backlinks', { slug: plan.backlinkAnchor }, pageSize, backlinkRepetitions);
        driverReports['backlinks'] = { ...backlinks.timing, pagesPerWalk: backlinks.pagesPerWalk, notesWalked: backlinks.notes.length, failures: backlinks.failures };

        const outgoingRepetitions = Math.max(
          1,
          Math.min(options.samples, Math.floor(WALK_REQUEST_BUDGET / Math.max(1, Math.ceil(((analysis.outDegree.get(plan.outgoingAnchor) ?? 0) + 1) / pageSize)))),
        );
        const outgoing = await driveWalk(mainPage, 'outgoing', { slug: plan.outgoingAnchor }, pageSize, outgoingRepetitions);
        driverReports['outgoing'] = { ...outgoing.timing, pagesPerWalk: outgoing.pagesPerWalk, notesWalked: outgoing.notes.length, failures: outgoing.failures };

        let tagWalk: WalkOutcome | null = null;
        if (plan.tagKey !== null) {
          const tagRepetitions = Math.max(
            1,
            Math.min(options.samples, Math.floor(WALK_REQUEST_BUDGET / Math.max(1, Math.ceil((plan.tagMembers + 1) / pageSize)))),
          );
          tagWalk = await driveWalk(mainPage, 'byTag', { tagKey: plan.tagKey }, pageSize, tagRepetitions);
          driverReports['byTag'] = { ...tagWalk.timing, pagesPerWalk: tagWalk.pagesPerWalk, notesWalked: tagWalk.notes.length, failures: tagWalk.failures };
        } else {
          driverReports['byTag'] = null;
        }

        const local = await single('localGraph', { slug: plan.localCenter }, options.samples);
        driverReports['localGraph'] = { ...local.timing, failures: local.failures };
        const global = await single('globalGraph', {}, options.samples);
        driverReports['globalGraph'] = { ...global.timing, failures: global.failures };
        const globalTag = plan.tagKey === null ? null : await single('globalGraph', { tagKey: plan.tagKey }, options.samples);
        driverReports['globalGraphTag'] = globalTag === null ? null : { ...globalTag.timing, failures: globalTag.failures };

        workload.queries.driver = driverReports;
        for (const [operation, driverReport] of Object.entries(driverReports)) {
          if (driverReport === null) continue;
          for (const failure of driverReport.failures) {
            workload.failures.push({ phase: `driver-${operation}`, message: failure });
          }
        }
        workload.queries.seam = {
          sqlMsObserved: Object.values(driverReports).some(
            (report) => report !== null && report.sqlMs.length > 0,
          ),
          phasesObserved:
            Object.values(driverReports).some((report) => report !== null && report.phases !== null) ||
            workload.startup?.worker.phases !== null,
        };

        // Structural invariants and DB spot-checks, recorded rather than thrown.
        const check = (name: string, ok: boolean, detail: string): void => {
          workload.checks.push({ name, ok, detail });
          if (!ok) workload.failures.push({ phase: `check:${name}`, message: detail });
        };
        const dbTitle = (slug: string): string | null => {
          const value = queryValue(db!, 'SELECT title FROM nodes WHERE slug = ?', [slug]);
          return value === undefined ? null : String(value);
        };
        const dbSlugs = (sql: string, params: readonly (string | number | null)[]): string[] =>
          queryRows<{ slug: string }>(db!, sql, params).map((row) => row.slug);

        const previewReply = preview.first;
        if (previewReply.result?.preview != null) {
          const returned = previewReply.result.preview;
          check(
            'driver-preview',
            returned.slug === plan.previewSlug && returned.title === dbTitle(plan.previewSlug),
            `preview returned ${JSON.stringify(returned.slug)} / ${JSON.stringify(returned.title)} for ${plan.previewSlug}`,
          );
        } else {
          check('driver-preview', false, `preview returned no entry for ${plan.previewSlug}`);
        }

        const backlinkDb = dbSlugs(
          `SELECT s.slug AS slug FROM edges AS e
           JOIN nodes AS n ON n.id = e.target_id JOIN nodes AS s ON s.id = e.source_id
           WHERE n.slug = ? ORDER BY s.slug`,
          [plan.backlinkAnchor],
        );
        check(
          'driver-backlinks-walk',
          backlinks.failures.length === 0 &&
            backlinks.notes.length === backlinkDb.length &&
            backlinks.notes.every((note, index) => note.slug === backlinkDb[index]) &&
            backlinks.pagesPerWalk >= 1,
          `backlinks walk returned ${backlinks.notes.length} over ${backlinks.pagesPerWalk} pages; DB has ${backlinkDb.length}` +
            (backlinks.failures.length === 0 ? '' : `; ${backlinks.failures.join('; ')}`),
        );
        const outgoingDb = dbSlugs(
          `SELECT t.slug AS slug FROM edges AS e
           JOIN nodes AS n ON n.id = e.source_id JOIN nodes AS t ON t.id = e.target_id
           WHERE n.slug = ? ORDER BY t.slug`,
          [plan.outgoingAnchor],
        );
        check(
          'driver-outgoing-walk',
          outgoing.failures.length === 0 &&
            outgoing.notes.length === outgoingDb.length &&
            outgoing.notes.every((note, index) => note.slug === outgoingDb[index]),
          `outgoing walk returned ${outgoing.notes.length} over ${outgoing.pagesPerWalk} pages; DB has ${outgoingDb.length}` +
            (outgoing.failures.length === 0 ? '' : `; ${outgoing.failures.join('; ')}`),
        );

        if (tagWalk !== null && plan.tagKey !== null) {
          const tagDb = dbSlugs(
            `SELECT n.slug AS slug FROM tags AS t
             JOIN node_tags AS nt ON nt.tag_id = t.id JOIN nodes AS n ON n.id = nt.node_id
             WHERE t.key = ? ORDER BY n.slug`,
            [plan.tagKey],
          );
          check(
            'driver-byTag-walk',
            tagWalk.failures.length === 0 &&
              tagWalk.notes.length === tagDb.length &&
              tagWalk.notes.every((note, index) => note.slug === tagDb[index]),
            `byTag walk returned ${tagWalk.notes.length} over ${tagWalk.pagesPerWalk} pages for ${plan.tagKey}; DB has ${tagDb.length}` +
              (tagWalk.failures.length === 0 ? '' : `; ${tagWalk.failures.join('; ')}`),
          );
        }

        const dbNeighbours = dbSlugs(
          `SELECT n.slug AS slug FROM edges AS e
           JOIN nodes AS s ON s.id = e.source_id JOIN nodes AS n ON n.id = e.target_id
           WHERE s.slug = ?
           UNION
           SELECT n.slug AS slug FROM edges AS e
           JOIN nodes AS s ON s.id = e.target_id JOIN nodes AS n ON n.id = e.source_id
           WHERE s.slug = ?
           ORDER BY slug`,
          [plan.localCenter, plan.localCenter],
        );
        const localReply = local.first;
        const localGraph = localReply.result?.graph ?? null;
        if (localGraph !== null) {
          const center = localGraph.center?.slug ?? null;
          const nodes = localGraph.nodes.map((node) => node.slug);
          const uniqueNodes = new Set(nodes);
          const neighbourSet = new Set(dbNeighbours);
          const drawnSet = new Set([center, ...nodes]);
          const edgesValid = localGraph.edges.every((edge) => drawnSet.has(edge.from) && drawnSet.has(edge.to));
          check(
            'driver-localGraph',
            center === plan.localCenter &&
              nodes.length <= LOCAL_NODE_LIMIT &&
              uniqueNodes.size === nodes.length &&
              nodes.every((slug) => neighbourSet.has(slug)) &&
              localGraph.omitted === dbNeighbours.length - nodes.length &&
              edgesValid,
            `localGraph center ${String(center)} nodes ${nodes.length}/${LOCAL_NODE_LIMIT} omitted ${localGraph.omitted} ` +
              `DB neighbours ${dbNeighbours.length} edges ${localGraph.edges.length} edgesValid ${String(edgesValid)}`,
          );
        } else {
          check('driver-localGraph', false, `localGraph returned no selection for ${plan.localCenter}`);
        }

        const globalReply = global.first;
        if (globalReply.ok && globalReply.result?.graph != null) {
          const graph = globalReply.result.graph;
          const nodes = new Set(graph.nodes.map((node) => node.slug));
          const edgesValid = graph.edges.every((edge) => nodes.has(edge.from) && nodes.has(edge.to));
          check(
            'driver-globalGraph',
            graph.nodes.length <= GLOBAL_NODE_LIMIT &&
              graph.omitted === analysis.plan.nodeCount - graph.nodes.length &&
              edgesValid,
            `globalGraph nodes ${graph.nodes.length}/${GLOBAL_NODE_LIMIT} omitted ${graph.omitted} DB nodes ${analysis.plan.nodeCount} edgesValid ${String(edgesValid)}`,
          );
        } else {
          check('driver-globalGraph', false, `globalGraph did not answer: ${globalReply.code ?? 'unknown'}`);
        }

        if (globalTag !== null) {
          const graph = globalTag.first.result?.graph ?? null;
          if (graph !== null) {
            const nodes = new Set(graph.nodes.map((node) => node.slug));
            const members = new Set(
              dbSlugs(
                `SELECT n.slug AS slug FROM tags AS t
                 JOIN node_tags AS nt ON nt.tag_id = t.id JOIN nodes AS n ON n.id = nt.node_id
                 WHERE t.key = ? ORDER BY n.slug`,
                [plan.tagKey!],
              ),
            );
            const edgesValid = graph.edges.every((edge) => nodes.has(edge.from) && nodes.has(edge.to));
            check(
              'driver-globalGraphTag',
              graph.nodes.length <= GLOBAL_NODE_LIMIT &&
                graph.omitted === members.size - graph.nodes.length &&
                graph.nodes.every((node) => members.has(node.slug)) &&
                edgesValid,
              `globalGraph(${plan.tagKey}) nodes ${graph.nodes.length}/${GLOBAL_NODE_LIMIT} omitted ${graph.omitted} members ${members.size} edgesValid ${String(edgesValid)}`,
            );
          } else {
            check('driver-globalGraphTag', false, `tag-filtered globalGraph returned no selection`);
          }
        }

        // Preview correctness against the snapshot's own title, read after the run.
        const previewReport = workload.preview;
        if (previewReport !== null) {
          const targetSlug = previewReport.cold.targetSlug;
          const title = targetSlug === null ? null : dbTitle(targetSlug);
          previewReport.targetFromDb = targetSlug === null || title === null ? null : { slug: targetSlug, title };
          const matches = (sample: PreviewSample): boolean | null => {
            if (title === null) return null;
            if (sample.panelTextSample === null) return null;
            return sample.panelTextSample.includes(title);
          };
          for (const [label, sample] of [
            ['cold', previewReport.cold],
            ['warm', previewReport.warm],
          ] as const) {
            sample.targetTitle = title;
            sample.titleMatched = matches(sample);
            if (sample.visible && !sample.nonEmpty) {
              workload.failures.push({ phase: 'preview', message: `${label} preview panel was empty` });
            }
            if (sample.titleMatched === false) {
              workload.failures.push({
                phase: 'preview',
                message: `${label} preview text does not contain the DB title ${JSON.stringify(title)} for ${String(targetSlug)}`,
              });
            }
            if (sample.titleMatched === null && sample.visible) {
              workload.failures.push({
                phase: 'preview',
                message: `${label} preview could not be checked: target or title absent from the DB`,
              });
            }
          }
        }

      });

      // Resource timings belong to the transfer evidence, so a driver failure
      // must not take them with it.
      await withFailure(workload, 'main-page-resources', async () => {
        if (mainPage !== undefined) await collectResources(mainPage, 'main-page', resources);
      });

      workload.transfer = {
        headersSource: server.headersSource,
        definitions: [
          'fresh browser + context per workload: empty HTTP cache at every cold measurement',
          'the page Worker is shared within the document for preview, graph, and tag consumers; each document gets its own Worker, so a first UI operation on a later page includes that Worker’s cold start',
          'cacheState network = a 200 the server wrote to the wire; revalidated = a 304; cache = a resource-timing transferSize of 0 with decoded bytes',
          'dependency `resource` is the cold observation whose transferSize includes the encoded body; Chromium reports a cache hit as a header-only transferSize, and those observations are counted in cacheHitObservations',
        ],
        dependencies: dependencies.map((dependency) => {
          const http = server!.records.find((record) => record.path === dependency.path) ?? null;
          const observed = resources.filter((entry) => entry.path === dependency.path);
          const resource =
            observed.find(
              (entry) => (entry.encodedBodySize ?? 0) > 0 && (entry.transferSize ?? 0) >= (entry.encodedBodySize ?? 0),
            ) ??
            observed[0] ??
            null;
          const cacheHits = observed.filter(
            (entry) => (entry.transferSize ?? 0) < (entry.encodedBodySize ?? 0),
          ).length;
          const requests = server!.records.filter((record) => record.path === dependency.path).length;
          let cacheState: DependencyReport['cacheState'] = 'not-requested';
          if (http !== null && http.status === 200) cacheState = 'network';
          else if (http !== null && http.status === 304) cacheState = 'revalidated';
          else if (resource !== null && (resource.transferSize ?? 0) < (resource.encodedBodySize ?? 0)) cacheState = 'cache';
          else if (http !== null || resource !== null) cacheState = 'unknown';
          return {
            kind: dependency.kind,
            path: dependency.path,
            decodedBytes: dependency.decodedBytes,
            gzipBytes: dependency.gzipBytes,
            http,
            resource,
            resourceObservations: observed.length,
            cacheHitObservations: cacheHits,
            requests,
            cacheState,
          };
        }),
        serverRecords: server!.records,
        resources,
      };
    } finally {
      await context.close();
    }
  } finally {
    workload.elapsedSeconds = round((Date.now() - startedAt) / 1000, 2);
    try {
      db?.close();
    } catch {
      // The original failure, if any, is the diagnosis.
    }
    try {
      await browser?.close();
    } catch {
      // A closed browser is not a measurement failure.
    }
    try {
      await server?.close();
    } catch {
      // A closed server is not a measurement failure.
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  return workload;
}

// --- Report and entry point -------------------------------------------------------

interface CandidateIdentity {
  repositoryHead: { commit: string | null; scope: string };
  cli: { basename: string; sha256: string; scope: string };
  installedPackage: { name: string; version: string } | null;
  installedPackageTree: {
    sha256: string;
    files: number;
    scope: string;
    method: string;
  } | null;
}

function candidateIdentity(cliPath: string): CandidateIdentity {
  const probe = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  let installedPackage: { name: string; version: string } | null = null;
  let installedPackageTree: CandidateIdentity['installedPackageTree'] = null;
  if (cliPath.includes(`${sep}node_modules${sep}`)) {
    let directory = dirname(cliPath);
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        let parsed: { name?: unknown; version?: unknown };
        try {
          parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown };
        } catch {
          // A manifest that cannot be read leaves the version unknown.
          break;
        }
        if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
          installedPackage = { name: parsed.name, version: parsed.version };
          const tree = fixtureIdentity(directory);
          installedPackageTree = {
            sha256: tree.sha256,
            files: tree.files,
            scope: 'installed package directory only, recursively hashed regular files; parent node_modules excluded',
            method: tree.method,
          };
        }
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return {
    repositoryHead: {
      commit: probe.status === 0 ? probe.stdout.trim() || null : null,
      scope: 'benchmark harness repository HEAD; identifies the candidate only when --cli belongs to this repository',
    },
    cli: {
      basename: basename(cliPath),
      sha256: sha256File(cliPath),
      scope: 'sha256 of the --cli executable file bytes only',
    },
    installedPackage,
    installedPackageTree,
  };
}

interface BenchmarkReport {
  kind: 'anc-snapshot-benchmark';
  goal: '0008-acceptable-browser-cost';
  note: string;
  generatedAt: string;
  candidate: CandidateIdentity | null;
  host: {
    platform: string;
    osType: string;
    osRelease: string;
    arch: string;
    cpus: number;
    totalMemoryBytes: number;
  };
  browser: string | null;
  viewport: { width: number; height: number };
  throttling: { cpuRate: number; label: string } | null;
  quantileMethod: 'nearest-rank';
  cacheDefinitions: string[];
  measurementSeam: { requested: string; observed: { sqlMs: boolean; phases: boolean } | null };
  workloads: WorkloadReport[];
  failures: string[];
  elapsedSeconds: number;
}

function gitReportDirectory(): string {
  const probe = spawnSync('git', ['rev-parse', '--git-path', 'publish-report'], { cwd: ROOT, encoding: 'utf8' });
  const path = probe.status === 0 ? probe.stdout.trim() : '';
  return path === '' ? join(ROOT, '.publish-report') : resolve(ROOT, path);
}

function kib(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? 'n/a' : `${(bytes / 1024).toFixed(1)}KiB`;
}

/** One line per workload on stdout: counts and durations only, never a path. */
function printWorkload(workload: WorkloadReport): void {
  const dependencies = workload.transfer?.dependencies ?? [];
  const snapshot = dependencies.find((dependency) => dependency.kind === 'snapshot');
  const cold = workload.preview?.cold.intentToVisibleMs ?? null;
  const warm = workload.preview?.warm.intentToVisibleMs ?? null;
  const local = workload.queries?.ui.localGraph;
  const driverLocal = workload.queries?.driver['localGraph'] ?? null;
  const readingDelta = workload.reading?.delta.transferredBytes ?? null;
  process.stdout.write(
    `${workload.id}: published=${workload.database?.notesPublished ?? 'n/a'} ` +
      `withheld=${workload.database?.notesWithheld ?? 'n/a'} ` +
      `nodes=${workload.database?.rows.nodes ?? 'n/a'} edges=${workload.database?.rows.edges ?? 'n/a'} ` +
      `db=${kib(snapshot?.decodedBytes)} gzip=${kib(snapshot?.gzipBytes)} ` +
      `build=${workload.build?.seconds ?? 'n/a'}s coldPreview=${cold ?? 'n/a'}ms warmPreview=${warm ?? 'n/a'}ms ` +
      `uiLocalGraph p50=${local?.dispatchSummary.p50 ?? 'n/a'}ms p95=${local?.dispatchSummary.p95 ?? 'n/a'}ms n=${local?.dispatchMs.length ?? 0} ` +
      `driverLocalGraph p50=${driverLocal?.dispatchSummary.p50 ?? 'n/a'}ms p95=${driverLocal?.dispatchSummary.p95 ?? 'n/a'}ms n=${driverLocal?.dispatchMs.length ?? 0} ` +
      `readingTransferDelta=${readingDelta ?? 'n/a'}B failures=${workload.failures.length}\n`,
  );
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const out = options.out ?? join(gitReportDirectory(), `benchmark-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const report: BenchmarkReport = {
    kind: 'anc-snapshot-benchmark',
    goal: '0008-acceptable-browser-cost',
    note:
      'This is goal 0008’s measurement instrument, not its acceptance: the physical mobile device and the recorded maintainer decision are external. Nulls mean the runtime seam did not supply the value, never an invented zero.',
    generatedAt: new Date().toISOString(),
    candidate: null,
    host: {
      platform: process.platform,
      osType: osType(),
      osRelease: osRelease(),
      arch: arch(),
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    browser: null,
    viewport: VIEWPORT,
    throttling:
      options.throttle > 1
        ? {
            cpuRate: options.throttle,
            label:
              'simulation (CDP Emulation.setCPUThrottlingRate on the page target only), not a physical mid-range mobile device',
          }
        : null,
    quantileMethod: 'nearest-rank',
    cacheDefinitions: [
      'cold: fresh browser and fresh context for the workload, so the HTTP cache is empty when intent begins',
      'warm: the same ready Worker and imported snapshot within the same document',
      'each page gets its own Worker; the Worker is shared within one document across preview, tag, and graph consumers',
    ],
    measurementSeam: {
      requested:
        'armed requests carry measure: true; armed snapshot-result details may carry { type, ms, operationMs, sqlMs?, phases? } where phases = { totalMs, fetchMs, digestMs, wasmInitMs, importMs, wasmMemoryBytes }',
      observed: null,
    },
    workloads: [],
    failures: [],
    elapsedSeconds: 0,
  };
  const startedAt = Date.now();
  let exitCode = 0;
  try {
    const cliPath = options.cli === undefined ? join(ROOT, 'bin', 'anc.mjs') : isAbsolute(options.cli) ? options.cli : resolve(process.cwd(), options.cli);
    if (!existsSync(cliPath)) throw new Error(`--cli does not exist: ${basename(cliPath)}`);
    if (extname(cliPath).toLowerCase() === '.tgz') {
      throw new Error('--cli must point to an executable CLI, not a .tgz package archive');
    }
    report.candidate = candidateIdentity(cliPath);
    for (const size of options.sizes) {
      for (const topology of options.topologies) {
        process.stdout.write(`benchmark ${size}/${topology}: generating and measuring\n`);
        try {
          const workload = await measureWorkload(options, cliPath, size, topology);
          report.workloads.push(workload);
          if (workload.failures.length > 0) exitCode = 1;
          printWorkload(workload);
        } catch (error) {
          const failure: WorkloadReport = {
            id: `${size}-${topology}`,
            size,
            topology,
            generator: {
              name: 'scripts/generate-corpus.ts#generateCorpus',
              seed: options.seed,
              options: generatorRequest(options, size, topology),
              result: null,
              finalized: null,
            },
            fixture: null,
            build: null,
            database: null,
            transfer: null,
            startup: null,
            preview: null,
            queries: null,
            reading: null,
            checks: [],
            failures: [{ phase: 'workload', message: scrub(error) }],
            elapsedSeconds: 0,
          };
          report.workloads.push(failure);
          report.failures.push(`${failure.id}: ${scrub(error)}`);
          exitCode = 1;
          printWorkload(failure);
        }
      }
    }
  } catch (error) {
    report.failures.push(scrub(error));
    exitCode = 1;
    process.stderr.write(`benchmark: ${scrub(error)}\n`);
  } finally {
    report.elapsedSeconds = round((Date.now() - startedAt) / 1000, 2);
    report.browser = observedBrowserVersion;
    const workloads = report.workloads;
    report.measurementSeam.observed = {
      sqlMs: workloads.some((workload) => workload.queries?.seam.sqlMsObserved === true),
      phases: workloads.some((workload) => workload.queries?.seam.phasesObserved === true || workload.startup?.worker.phases !== null),
    };
    try {
      const body = `${JSON.stringify(report, null, 2)}\n`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, body, 'utf8');
      const digest = createHash('sha256').update(body).digest('hex').slice(0, 12);
      const failureCount = report.workloads.reduce((sum, workload) => sum + workload.failures.length, 0) + report.failures.length;
      console.log(`benchmark: ${report.workloads.length} workloads, ${failureCount} failures, report sha256=${digest}`);
    } catch (error) {
      process.stderr.write(`benchmark: report write failed: ${scrub(error)}\n`);
      exitCode = 1;
    }
  }
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(scrub(error));
      process.exit(1);
    },
  );
}
