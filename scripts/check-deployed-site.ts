/**
 * Post-deployment check against a live origin.
 *
 * The build's gates prove what `dist/` contains. They cannot prove that the
 * origin a reader reaches serves that same artifact: a site can stay on an
 * older release while every CI job is green, and a static host can answer 200
 * with a `Content-Type` or a compression choice the build never chose. This
 * script reads only what the origin actually returns.
 *
 * Every asset URL is discovered rather than assumed. The snapshot and WASM
 * filenames are content hashes, so a hard-coded URL would test a past deploy;
 * the chain followed here is the one a browser follows —
 *
 *   `/` HTML -> `/_astro/Layout*.js` -> `/_astro/snapshot-worker-*.js`
 *       -> `/data/site.<sha256>.sqlite` and `/wasm/sqlite3.<sha256>.wasm`
 *
 * — and every link in it comes from the served bytes.
 *
 * `public/_headers` is a Cloudflare Pages file. GitHub Pages serves it as an
 * ordinary file and applies none of it, so this script never asserts those
 * headers; it reports the ones the origin actually sent and says whether the
 * policy was applied or only survived as the page's `<meta>` tag.
 *
 * No credentials, no writes. GET only.
 *
 * Usage:
 *   node scripts/check-deployed-site.ts --origin https://example.org/
 *
 * Exits 0 when every assertion passes, 1 otherwise. Informational lines
 * (`INFO`) report measured host behaviour and never fail the run.
 */

import { fileURLToPath } from 'node:url';

/** A named assertion failed to find what the served artifact must reference. */
export class DeployedCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployedCheckError';
  }
}

/** Lowercase header names, last value wins, as a `Headers` object presents them. */
export function normalizeHeaders(headers: Iterable<[string, string]>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [name, value] of headers) normalized.set(name.toLowerCase(), value);
  return normalized;
}

/** Entity decode the small set an HTML `<title>` can carry. */
function decodeEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

/** The document's `<title>`, or `undefined` when absent or blank. */
export function findTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;
  const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  return title === '' ? undefined : title;
}

/**
 * Root-relative script URLs the page loads, in document order: classic and
 * module `<script src>` plus `<link rel="modulepreload">`.
 */
export function collectScriptUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    if (match[1].toLowerCase() === 'link' && !/rel="(?:modulepreload|preload)"/i.test(tag)) continue;
    const attribute = /(?:\bsrc|\bhref)="([^"]+)"/i.exec(tag);
    if (!attribute) continue;
    const value = attribute[1];
    if (!/\.js(?:\?|$)/.test(value)) continue;
    if (!/^(?:\.{1,2}\/|\/)/.test(value)) continue;
    urls.add(value);
  }
  return [...urls];
}

/** The snapshot URL a served chunk names, or `undefined`. */
export function findSnapshotUrl(text: string): string | undefined {
  return /(\/data\/site\.[0-9a-f]{64}\.sqlite)/.exec(text)?.[1];
}

/** The WASM URL a served chunk names, or `undefined`. */
export function findWasmUrl(text: string): string | undefined {
  return /(\/wasm\/sqlite3\.[0-9a-f]{64}\.wasm)/.exec(text)?.[1];
}

/** The worker chunk a served chunk names, or `undefined`. */
export function findWorkerChunk(text: string): string | undefined {
  return /((?:\/|\.{1,2}\/)?(?:_astro\/)?snapshot-worker-[A-Za-z0-9_-]+\.js)/.exec(text)?.[1];
}

/** The next-hop note route a page links to, or `undefined`. */
export function findNoteRoutes(html: string): string[] {
  const routes = new Set<string>();
  for (const match of html.matchAll(/href="(\/notes\/[^"?#]+\/)"/g)) routes.add(match[1]);
  return [...routes];
}

/** Tag routes listed in the static tag index's facet list. */
export function findTagRoutes(tagIndexHtml: string): string[] {
  const list = /<ul\b[^>]*class="[^"]*\bfacet-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i.exec(tagIndexHtml);
  if (!list) return [];
  const routes = new Set<string>();
  for (const match of list[1].matchAll(/href="(\/tags\/[^"/]+\/)"/g)) routes.add(match[1]);
  return [...routes];
}

/** The tag index renders the supported empty state instead of a facet list. */
export function hasEmptyFacetState(tagIndexHtml: string): boolean {
  return /<p\b[^>]*class="[^"]*\bempty-state\b[^"]*"/i.test(tagIndexHtml);
}

/** The static tag page renders at least one note card inside its grid. */
export function hasNonEmptyNoteList(html: string): boolean {
  return (
    /<[a-z]+\b[^>]*class="[^"]*\bnote-grid\b[^"]*"/i.test(html) &&
    /<article\b[^>]*class="[^"]*\bnote-card\b[^"]*"/i.test(html)
  );
}

/** `SQLite format 3\0`, the 16-byte file header every SQLite database opens with. */
export function hasSqliteMagic(bytes: Uint8Array): boolean {
  const magic = 'SQLite format 3\u0000';
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index++) {
    if (bytes[index] !== magic.charCodeAt(index)) return false;
  }
  return true;
}

/** `\0asm`, the 4-byte WebAssembly module header. */
export function hasWasmMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d
  );
}

const SNAPSHOT_CONTENT_TYPES: Readonly<Record<string, true>> = {
  'application/octet-stream': true,
  'application/vnd.sqlite3': true,
  'application/x-sqlite3': true,
  'application/sqlite': true,
  'application/sqlite3': true,
  'application/x-sqlite': true,
  'binary/octet-stream': true,
};

/** A media type a static host may honestly use for the SQLite snapshot. */
export function isPlausibleSnapshotContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return SNAPSHOT_CONTENT_TYPES[value.split(';')[0].trim().toLowerCase()] === true;
}

/** A media type a static host may honestly use for the WASM module. */
export function isPlausibleWasmContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const type = value.split(';')[0].trim().toLowerCase();
  return type === 'application/wasm' || type === 'application/octet-stream';
}

const JAVASCRIPT_CONTENT_TYPES: Readonly<Record<string, true>> = {
  'application/javascript': true,
  'text/javascript': true,
};

/**
 * A media type a static host may honestly use for a JavaScript asset.
 *
 * Both types are registered and both are accepted by browsers for classic and
 * module scripts; this repository's own fixtures serve `text/javascript`.
 */
export function isPlausibleJavaScriptContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return JAVASCRIPT_CONTENT_TYPES[value.split(';')[0].trim().toLowerCase()] === true;
}

/**
 * The first reference found across the served texts.
 *
 * Throws rather than returning an empty value: "not found" must fail the run,
 * never silently skip the assertion that depends on it.
 */
export function requireReference(
  name: string,
  finder: (text: string) => string | undefined,
  texts: readonly string[],
): string {
  for (const text of texts) {
    const found = finder(text);
    if (found !== undefined) return found;
  }
  throw new DeployedCheckError(`no ${name} reference found in the served HTML/JS`);
}

/** Parsed command line. `origin` is normalized to a bare `scheme://host[:port]`. */
export interface DeployedCheckArguments {
  origin: string;
  timeoutMs: number;
}

/** Parse `--origin` (required) and `--timeout` (milliseconds). */
export function parseArguments(argv: readonly string[]): DeployedCheckArguments {
  let origin: string | undefined;
  let timeoutMs = 15_000;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--origin') {
      origin = argv[++index];
    } else if (argument.startsWith('--origin=')) {
      origin = argument.slice('--origin='.length);
    } else if (argument === '--timeout') {
      timeoutMs = Number(argv[++index]);
    } else if (argument.startsWith('--timeout=')) {
      timeoutMs = Number(argument.slice('--timeout='.length));
    } else {
      throw new DeployedCheckError(`unknown argument: ${argument}`);
    }
  }
  if (origin === undefined || origin === '') {
    throw new DeployedCheckError('--origin is required, e.g. --origin https://example.org/');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DeployedCheckError(`--timeout must be a positive number of milliseconds, got ${String(timeoutMs)}`);
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new DeployedCheckError(`--origin is not a URL: ${origin}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DeployedCheckError(`--origin must be http or https, got ${url.protocol}`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new DeployedCheckError(`--origin must be a bare origin with no path, query, or fragment: ${origin}`);
  }
  return { origin: url.origin, timeoutMs };
}

interface Probe {
  requestUrl: string;
  finalUrl: string;
  status: number;
  headers: Map<string, string>;
  bytes: Uint8Array;
  text: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const BROWSER_ACCEPT_ENCODING = 'gzip, deflate, br';

function contentType(probe: Probe): string | undefined {
  return probe.headers.get('content-type');
}

function isHtml(probe: Probe): boolean {
  return /^text\/html\b/i.test(contentType(probe) ?? '');
}

function describe(probe: Probe): string {
  return [
    `status=${probe.status}`,
    `content-type=${contentType(probe) ?? '(none)'}`,
    `content-encoding=${probe.headers.get('content-encoding') ?? 'identity'}`,
    `cache-control=${probe.headers.get('cache-control') ?? '(none)'}`,
    `content-length=${probe.headers.get('content-length') ?? '(none)'}`,
    `decoded-bytes=${probe.bytes.length}`,
  ].join(' ');
}

async function probe(url: string, timeoutMs: number, acceptEncoding = BROWSER_ACCEPT_ENCODING): Promise<Probe> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/javascript,application/wasm,*/*;q=0.8',
      'accept-encoding': acceptEncoding,
      'user-agent': 'anc-check-deployed-site/1',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    requestUrl: url,
    finalUrl: response.url === '' ? url : response.url,
    status: response.status,
    headers: normalizeHeaders(response.headers),
    bytes,
    text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
  };
}

interface TextSource {
  sourceUrl: string;
  text: string;
}

interface Discovery {
  snapshotUrl: string;
  wasmUrl: string;
  chain: string[];
  scripts: Array<{ url: string; probe: Probe }>;
}

async function discover(
  origin: string,
  root: Probe,
  timeoutMs: number,
): Promise<Discovery> {
  const chain = ['/'];
  const sources: TextSource[] = [{ sourceUrl: `${origin}/`, text: root.text }];
  const scripts: Array<{ url: string; probe: Probe }> = [];

  for (const reference of collectScriptUrls(root.text)) {
    const url = new URL(reference, `${origin}/`).href;
    const asset = await probe(url, timeoutMs);
    scripts.push({ url, probe: asset });
    chain.push(new URL(url).pathname);
    sources.push({ sourceUrl: url, text: asset.text });
  }

  const findWithSource = (
    finder: (text: string) => string | undefined,
  ): { value: string; sourceUrl: string } | undefined => {
    for (const source of sources) {
      const value = finder(source.text);
      if (value !== undefined) return { value, sourceUrl: source.sourceUrl };
    }
    return undefined;
  };

  const worker = findWithSource(findWorkerChunk);
  if (worker !== undefined) {
    const workerUrl = new URL(worker.value, worker.sourceUrl).href;
    const asset = await probe(workerUrl, timeoutMs);
    chain.push(new URL(workerUrl).pathname);
    if (asset.status !== 200 || !isPlausibleJavaScriptContentType(contentType(asset))) {
      throw new DeployedCheckError(
        `snapshot worker ${new URL(workerUrl).pathname} is not a JavaScript module: ` +
          `${describe(asset)} (followed ${chain.join(' -> ')})`,
      );
    }
    sources.push({ sourceUrl: workerUrl, text: asset.text });
  }

  const texts = sources.map((source) => source.text);
  try {
    return {
      snapshotUrl: requireReference('snapshot', findSnapshotUrl, texts),
      wasmUrl: requireReference('WASM', findWasmUrl, texts),
      chain,
      scripts,
    };
  } catch (error) {
    throw new DeployedCheckError(
      `${error instanceof Error ? error.message : String(error)} (followed ${chain.join(' -> ')})`,
    );
  }
}

function usage(): string {
  return [
    'Usage: node scripts/check-deployed-site.ts --origin <url> [--timeout <ms>]',
    '',
    'Read-only post-deployment check: GET requests only, no credentials, no writes.',
    'Exits 0 when every assertion passes, 1 otherwise.',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return 0;
  }

  const { origin, timeoutMs } = parseArguments(argv);
  const checks: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
  };
  const info = (name: string, detail: string): void => {
    console.log(`INFO ${name} — ${detail}`);
  };

  console.log(`origin: ${origin}`);

  const root = await probe(`${origin}/`, timeoutMs);
  record(
    'site-root',
    root.status === 200 && isHtml(root),
    `${describe(root)} title=${JSON.stringify(findTitle(root.text) ?? '')}`,
  );

  const title = findTitle(root.text);
  record('site-root-title', title !== undefined, `title=${JSON.stringify(title ?? '')}`);

  let discovery: Discovery | undefined;
  try {
    discovery = await discover(origin, root, timeoutMs);
    record(
      'asset-chain',
      true,
      `${discovery.chain.join(' -> ')} -> ${discovery.snapshotUrl} ; ${discovery.wasmUrl}`,
    );
  } catch (error) {
    record('asset-chain', false, error instanceof Error ? error.message : String(error));
  }

  if (discovery !== undefined) {
    const snapshot = await probe(`${origin}${discovery.snapshotUrl}`, timeoutMs);
    record(
      'snapshot',
      snapshot.status === 200 &&
        isPlausibleSnapshotContentType(contentType(snapshot)) &&
        snapshot.bytes.length > 0 &&
        hasSqliteMagic(snapshot.bytes),
      `${describe(snapshot)} magic=${JSON.stringify(
        new TextDecoder('latin1').decode(snapshot.bytes.slice(0, 16)),
      )}`,
    );

    const wasm = await probe(`${origin}${discovery.wasmUrl}`, timeoutMs);
    record(
      'wasm',
      wasm.status === 200 &&
        isPlausibleWasmContentType(contentType(wasm)) &&
        wasm.bytes.length > 0 &&
        hasWasmMagic(wasm.bytes),
      `${describe(wasm)} magic=${JSON.stringify(
        new TextDecoder('latin1').decode(wasm.bytes.slice(0, 4)),
      )}`,
    );

    const hashed = discovery.scripts.find((script) => /\/_astro\/Layout[^/]*\.js$/.test(script.url));
    if (hashed === undefined) {
      record('hashed-asset', false, 'no /_astro/Layout*.js was referenced by the served page');
    } else {
      const cache = hashed.probe.headers.get('cache-control') ?? '(none)';
      record(
        'hashed-asset',
        hashed.probe.status === 200 && isPlausibleJavaScriptContentType(contentType(hashed.probe)),
        `${describe(hashed.probe)} immutable=${/\bimmutable\b/i.test(cache) ? 'yes' : 'no'}`,
      );
    }
  }

  const tagIndex = await probe(`${origin}/tags/`, timeoutMs);
  const tagIndexOk = tagIndex.status === 200 && isHtml(tagIndex);
  const tagRoutes = tagIndexOk ? findTagRoutes(tagIndex.text) : [];
  const tagEmpty = tagRoutes.length === 0 && hasEmptyFacetState(tagIndex.text);
  record(
    'tag-index',
    tagIndexOk && (tagRoutes.length > 0 || tagEmpty),
    `${describe(tagIndex)} tag-routes=${tagRoutes.length}${
      tagRoutes.length === 0 ? `, empty-state ${tagEmpty ? 'present' : 'absent'}` : ''
    }`,
  );

  if (tagRoutes.length > 0) {
    const route = tagRoutes[0];
    const tag = await probe(`${origin}${route}`, timeoutMs);
    record(
      'tag-route',
      tag.status === 200 && isHtml(tag) && hasNonEmptyNoteList(tag.text) && findTitle(tag.text) !== undefined,
      `${route} ${describe(tag)} title=${JSON.stringify(findTitle(tag.text) ?? '')} note-list=${
        hasNonEmptyNoteList(tag.text) ? 'non-empty' : 'empty-or-absent'
      }`,
    );
  }

  const noteRoutes = findNoteRoutes(root.text);
  if (noteRoutes.length > 0) {
    const route = noteRoutes[0];
    const note = await probe(`${origin}${route}`, timeoutMs);
    record(
      'note-route',
      note.status === 200 && isHtml(note) && findTitle(note.text) !== undefined,
      `${route} ${describe(note)} title=${JSON.stringify(findTitle(note.text) ?? '')}`,
    );
  } else {
    record('note-route', false, 'no /notes/<slug>/ link on / to follow');
  }

  const cspHeader = root.headers.get('content-security-policy');
  const cspMeta = /<meta\b[^>]*http-equiv="Content-Security-Policy"/i.test(root.text);
  info(
    '_headers',
    cspHeader !== undefined
      ? 'Content-Security-Policy response header is present (the host applied public/_headers)'
      : `no Content-Security-Policy response header${cspMeta ? '; only the page <meta> policy survives' : ''} (public/_headers is a Cloudflare Pages file; this host did not apply it)`,
  );

  const brotliOnly = await probe(`${origin}/`, timeoutMs, 'br');
  const brotliEncoding = brotliOnly.headers.get('content-encoding') ?? 'identity';
  info(
    'compression',
    `Accept-Encoding: br alone -> content-encoding=${brotliEncoding}; ` +
      `Accept-Encoding: ${BROWSER_ACCEPT_ENCODING} -> content-encoding=${root.headers.get('content-encoding') ?? 'identity'}` +
      `${brotliEncoding === 'br' ? '' : ' (brotli not negotiated)'}`,
  );

  const failed = checks.filter((check) => !check.ok).length;
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
