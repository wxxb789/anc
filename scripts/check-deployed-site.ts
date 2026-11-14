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
 * No credentials, no writes. GET only, in both passes.
 *
 * That default pass reads the served bytes, so it proves what a host returns
 * and nothing about what a browser then does with them. `--browser` adds an
 * opt-in leg that drives the same origin in Chromium and asserts the three
 * reader-visible behaviours the HTTP pass cannot reach: a hover preview renders
 * the target note's title (which needs the Worker, the WASM module, and the
 * snapshot to have all resolved), the page reports no console error and no
 * failed request while doing it, and tag browsing renders rows from the live
 * origin, continuing the list where a tag offers one. It launches the Chromium
 * this repository's browser suite already uses — nothing is downloaded at run
 * time — and costs a browser launch, one page per examined tag route, and,
 * because Playwright is a devDependency, an explicit install wherever the
 * package is consumed rather than cloned. It is emulated at 1280x800, which is
 * neither a mobile profile nor a real device; the origin is the one a reader
 * reaches, so latency and cache state are the live ones.
 *
 * Usage:
 *   node scripts/check-deployed-site.ts --origin https://example.org/
 *   node scripts/check-deployed-site.ts --origin https://example.org/ --browser
 *
 * Exits 0 when every assertion passes, 1 otherwise. Informational lines
 * (`INFO`) report measured host behaviour and never fail the run.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Browser, Page, Response } from 'playwright';

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

/**
 * Parsed command line. `origin` is normalized to a bare `scheme://host[:port]`.
 *
 * `browser` is opt-in and off by default: the HTTP pass is what a pipeline
 * runs, and a browser launch is a cost and a dependency that request does not
 * imply.
 */
export interface DeployedCheckArguments {
  origin: string;
  timeoutMs: number;
  browser: boolean;
}

/** Parse `--origin` (required), `--timeout` (milliseconds), and `--browser`. */
export function parseArguments(argv: readonly string[]): DeployedCheckArguments {
  let origin: string | undefined;
  let timeoutMs = 15_000;
  let browser = false;
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
    } else if (argument === '--browser') {
      browser = true;
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
  return { origin: url.origin, timeoutMs, browser };
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

/**
 * The stored title inside a panel title, with the alias group `previewTitle`
 * appends and the ellipsis a long title is truncated with removed.
 *
 * The panel renders the note's stored title, plus `" (<aliases>)"` when the
 * note has aliases; the note's own static page carries the stored title alone.
 * Cutting at the first `" ("` therefore compares the two sources on the one
 * string they share. A stored title that itself contains a parenthetical is cut
 * early, which only makes the containment assertion weaker and never false: the
 * remainder is still a prefix of the served title.
 */
export function previewTitleBase(panelTitle: string): string {
  const text = panelTitle.endsWith('…') ? panelTitle.slice(0, -1) : panelTitle;
  const aliasGroup = text.indexOf(' (');
  return (aliasGroup === -1 ? text : text.slice(0, aliasGroup)).trim();
}

/** First line of an error: Playwright's messages carry the cause there. */
function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0];
}

/** Playwright's installed version, or `unknown` when its manifest cannot be read. */
function playwrightVersion(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(createRequire(import.meta.url).resolve('playwright/package.json'), 'utf8'),
    );
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string') {
      return manifest.version;
    }
  } catch {
    // An unreadable manifest or a blocked `./package.json` export leaves the
    // version informational; it is not what any assertion turns on.
  }
  return 'unknown';
}

/** What the browser observed over the session, for the assertions that read it. */
interface BrowserLog {
  consoleErrors: string[];
  pageErrors: string[];
  failed: string[];
  nonGet: string[];
  responses: number;
  worker: number;
  snapshot: number;
  wasm: number;
}

/**
 * Attach every listener before the first navigation.
 *
 * A failed request is one the browser could not complete at all
 * (`requestfailed`) or one the origin answered with an error status. Both are
 * recorded, and neither is filtered: a request the page aborted because a
 * navigation cancelled it is a request the page did not get, and treating it as
 * noise is how a flaky origin reads as a healthy one.
 */
function watchBrowser(page: Page): BrowserLog {
  const log: BrowserLog = {
    consoleErrors: [],
    pageErrors: [],
    failed: [],
    nonGet: [],
    responses: 0,
    worker: 0,
    snapshot: 0,
    wasm: 0,
  };
  page.on('console', (entry) => {
    if (entry.type() === 'error') log.consoleErrors.push(entry.text());
  });
  page.on('pageerror', (error) => log.pageErrors.push(reason(error)));
  page.on('request', (request) => {
    if (request.method() !== 'GET') log.nonGet.push(`${request.method()} ${request.url()}`);
    // The same finders the HTTP pass uses, so one definition of each chunk name
    // governs both passes and a renamed chunk cannot pass one of them.
    const path = new URL(request.url()).pathname;
    if (findWorkerChunk(path) !== undefined) log.worker += 1;
    else if (findSnapshotUrl(path) !== undefined) log.snapshot += 1;
    else if (findWasmUrl(path) !== undefined) log.wasm += 1;
  });
  page.on('requestfailed', (request) => {
    log.failed.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`);
  });
  page.on('response', (response) => {
    log.responses += 1;
    if (response.status() >= 400) log.failed.push(`${response.status()} ${response.url()}`);
  });
  return log;
}

/** One browser session's shared state, so each assertion reads as one step. */
interface BrowserLeg {
  origin: string;
  timeoutMs: number;
  /** The served `/` HTML: its note links are the preview targets. */
  rootHtml: string;
  /** Tag routes the served tag index listed, in the order it listed them. */
  tagRoutes: readonly string[];
  record: (name: string, ok: boolean, detail: string) => void;
  info: (name: string, detail: string) => void;
}

/** A browser-observed panel state, for the failure detail as well as the pass. */
async function panelState(page: Page): Promise<string> {
  const panel = page.locator('#link-preview');
  if ((await panel.count()) === 0) return 'absent';
  return (await panel.isVisible()) ? 'visible' : 'hidden';
}

/**
 * How many continuations one tag route may offer before this check stops.
 *
 * A bound on the check, not on the product: a list still offering rows after
 * this many pages is reported as a failure rather than as an exhausted list, so
 * no run claims completion it did not observe.
 */
const TAG_CONTINUATION_CAP = 200;

/** Observation of one tag route, before and after every continuation. */
interface TagRouteMeasurement {
  route: string;
  label: string;
  /** The enhanced region's own status line (`#tag-browser-status`) — not an HTTP status. */
  regionStatus: string;
  /** The enhanced region as the client left it: `visible` when it installed. */
  state: string;
  /** The complete no-JS list's note hrefs, deduplicated, read before the click. */
  staticHrefs: string[];
  /** The enhanced list's rendered note hrefs as the client left them. */
  rows: string[];
  /** The highest logical position the list had loaded, from `aria-posinset`. */
  loaded: number;
  /** Continuations the list offered and this run took, sliding windows included. */
  moreClicks: number;
  firstRowsMs: number;
}

/**
 * Open one tag route, start its list, and take every continuation it offers.
 *
 * The region ships `hidden` and the client script unhides it at install, so a
 * visible region is the runtime having run rather than markup that happens to
 * exist. The static list is read before the list is started because a successful
 * first render is what releases it.
 *
 * Progress is the list's own loaded position — the highest `aria-posinset` it
 * has rendered — and not the number of rows in the DOM. The client keeps a
 * bounded window of `TAG_WINDOW_SIZE` rendered rows and slides it, so a tag with
 * more notes than the bound keeps adding logical rows while its rendered row
 * count stops growing; an assertion that the rows grew would time out on a
 * healthy origin. `aria-setsize` cannot serve here either: it is the tag's
 * complete membership and does not change as pages load. Both attributes are the
 * page's own published description of the list, so the check observes the
 * product rather than a signal added for it.
 */
async function measureTagRoute(page: Page, leg: BrowserLeg, route: string): Promise<TagRouteMeasurement> {
  const started = Date.now();
  const response = await page.goto(`${leg.origin}${route}`, { waitUntil: 'load', timeout: leg.timeoutMs });
  const status = navigationStatus(response);
  if (status !== '200') throw new DeployedCheckError(`the route answered ${status}`);
  await page.locator('#tag-browser').waitFor({ state: 'visible', timeout: leg.timeoutMs });
  const staticHrefs = await noteHrefs(page, '#tag-static-list');
  const start = page.locator('#tag-browse-start');
  if ((await start.count()) > 0) await start.click({ timeout: leg.timeoutMs });
  await page.waitForFunction(
    () => document.querySelectorAll('#tag-browser-results a[href^="/notes/"]').length > 0,
    undefined,
    { timeout: leg.timeoutMs },
  );
  const firstRows = await noteHrefs(page, '#tag-browser-results');
  const firstRowsMs = Date.now() - started;

  let rows = firstRows;
  let loaded = await loadedPosition(page);
  let moreClicks = 0;
  const more = page.locator('#tag-browse-more');
  while (await more.isVisible()) {
    if (moreClicks >= TAG_CONTINUATION_CAP) {
      throw new DeployedCheckError(
        `still offered a continuation after ${moreClicks} pages (loaded ${loaded}); ` +
          `this check stops at ${TAG_CONTINUATION_CAP} and will not report the list exhausted`,
      );
    }
    const before = loaded;
    await more.click({ timeout: leg.timeoutMs });
    try {
      await page.waitForFunction(
        (position) =>
          [...document.querySelectorAll('#tag-browser-results li[aria-posinset]')].some(
            (row) => Number(row.getAttribute('aria-posinset')) > position,
          ) || document.querySelector('#tag-browse-more')?.hasAttribute('hidden') === true,
        before,
        { timeout: leg.timeoutMs },
      );
    } catch (error) {
      throw new DeployedCheckError(
        `did not load past row ${before} on continuation ${moreClicks + 1} (${reason(error)})`,
      );
    }
    loaded = Math.max(loaded, await loadedPosition(page));
    rows = await noteHrefs(page, '#tag-browser-results');
    moreClicks += 1;
  }

  const region = await tagRegion(page);
  return {
    route,
    label: region.label,
    regionStatus: region.status,
    state: region.state,
    staticHrefs,
    rows,
    loaded,
    moreClicks,
    firstRowsMs,
  };
}

/**
 * The tag region's own text as it stands, read in one pass through `evaluate`.
 *
 * A locator read would wait out Playwright's default 30-second timeout on a
 * region this fixture never rendered, which is the opposite of what a failure
 * detail is for: the observation has to be taken while the assertion fails, not
 * thirty seconds later.
 */
async function tagRegion(page: Page): Promise<{ label: string; status: string; state: string }> {
  return page.evaluate(() => {
    const region = document.querySelector('#tag-browser');
    return {
      label: document.querySelector('#tag-browser-current')?.textContent ?? '',
      status: document.querySelector('#tag-browser-status')?.textContent ?? '',
      state: region === null ? 'absent' : region.checkVisibility() ? 'visible' : 'hidden',
    };
  });
}

/**
 * The highest logical position the enhanced list has rendered, or 0.
 *
 * `aria-posinset` is the row's 1-based position in the tag's complete
 * collection, so the largest one rendered is how far the list has loaded; the
 * rendered row count is bounded by the client's window and stops moving.
 */
async function loadedPosition(page: Page): Promise<number> {
  return page.evaluate(() => {
    let position = 0;
    for (const row of document.querySelectorAll('#tag-browser-results li[aria-posinset]')) {
      position = Math.max(position, Number(row.getAttribute('aria-posinset')) || 0);
    }
    return position;
  });
}

/** The tag region as it stands, for a failure detail rather than a bare timeout. */
async function tagState(page: Page): Promise<string> {
  const region = await tagRegion(page);
  const rows = await page.locator('#tag-browser-results a[href^="/notes/"]').count();
  const loaded = await loadedPosition(page);
  return `region=${region.state} browser-rows=${rows} loaded=${loaded} status=${JSON.stringify(region.status)}`;
}

/** The `/notes/<slug>/` hrefs inside one region, deduplicated, in DOM order. */
async function noteHrefs(page: Page, region: string): Promise<string[]> {
  const hrefs = await page.locator(`${region} a[href^="/notes/"]`).evaluateAll((links) =>
    links.map((link) => link.getAttribute('href') ?? ''),
  );
  return [...new Set(hrefs.filter((href) => href.startsWith('/notes/')))];
}

function sample(values: readonly string[], limit = 3): string {
  return values.length === 0 ? '' : ` first=${JSON.stringify(values.slice(0, limit))}`;
}

/** The status one navigation produced, or `no response` when it produced none. */
function navigationStatus(response: Response | null): string {
  return response === null ? 'no response' : String(response.status());
}

/** Load the served `/` and compare the title a browser reads with the bytes. */
async function checkRoot(page: Page, leg: BrowserLeg): Promise<void> {
  const started = Date.now();
  let status: string;
  try {
    status = navigationStatus(await page.goto(`${leg.origin}/`, { waitUntil: 'load', timeout: leg.timeoutMs }));
  } catch (error) {
    status = reason(error);
  }
  const title = await page.title();
  const servedTitle = findTitle(leg.rootHtml);
  leg.record(
    'browser-root',
    status === '200' && title !== '' && (servedTitle === undefined || title === servedTitle),
    `status=${status} title=${JSON.stringify(title)} served-title=${JSON.stringify(servedTitle ?? '')} ms=${Date.now() - started}`,
  );
}

/**
 * Hover a note link the served `/` names and require the panel it opens to
 * carry that note's own title.
 *
 * The cross-check is against the note's *static* page — a different producer
 * and a different request — so a panel rendering a stale row, another note's
 * row, or the source page's own title fails. The run also requires the runtime
 * assets to have been requested: a panel that rendered without the Worker, the
 * WASM module, and the snapshot would not be evidence of the chain this leg
 * exists to follow.
 */
async function checkPreview(page: Page, leg: BrowserLeg, log: BrowserLog): Promise<void> {
  const noteRoutes = findNoteRoutes(leg.rootHtml);
  if (noteRoutes.length === 0) {
    leg.record('browser-preview', false, 'the served / links to no /notes/<slug>/ route to hover');
    return;
  }
  const route = noteRoutes[0];
  const link = page.locator(`a[href="${route}"]`).first();
  const started = Date.now();
  let panelTitle = '';
  let observed = '';
  try {
    await link.hover({ timeout: leg.timeoutMs });
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: leg.timeoutMs });
    panelTitle = ((await page.locator('#link-preview strong').first().textContent({ timeout: leg.timeoutMs })) ?? '').trim();
  } catch (error) {
    observed = ` panel=${await panelState(page)} after ${Date.now() - started} ms (${reason(error)})`;
  }
  const describedBy = await page.evaluate(
    (href) => document.querySelector(`a[href="${href}"]`)?.getAttribute('aria-describedby') ?? '',
    route,
  );
  const base = previewTitleBase(panelTitle);

  let targetStatus: string;
  let targetTitle = '';
  try {
    const response = await page.goto(`${leg.origin}${route}`, { waitUntil: 'load', timeout: leg.timeoutMs });
    targetStatus = navigationStatus(response);
    targetTitle = await page.title();
  } catch (error) {
    targetStatus = reason(error);
  }

  const assets = `worker=${log.worker} snapshot=${log.snapshot} wasm=${log.wasm}`;
  leg.record(
    'browser-preview',
    base !== '' &&
      targetStatus === '200' &&
      targetTitle.startsWith(base) &&
      describedBy === 'link-preview' &&
      log.worker > 0 &&
      log.snapshot > 0 &&
      log.wasm > 0,
    `${route} panel-title=${JSON.stringify(panelTitle)} panel-title-base=${JSON.stringify(base)} ` +
      `describedby=${JSON.stringify(describedBy)} target-status=${targetStatus} ` +
      `target-title=${JSON.stringify(targetTitle)} runtime-requests=[${assets}] ms=${Date.now() - started}${observed}`,
  );
}

/**
 * Start a tag route's list and take every continuation it offers.
 *
 * Routes are examined in the order the served index listed them and the
 * examination stops at the first route that offers a continuation, so the
 * load-more behaviour is exercised wherever a site has a tag large enough for
 * it. Rows must come from the Worker: a dead runtime leaves this list empty and
 * reveals the static one instead, so an empty list is a failure even though the
 * page still shows notes — and every row must be one the static list names, so
 * rows that arrived for the wrong tag fail too.
 *
 * Every continuation the list offers is taken, counted, and followed to the
 * loaded position it names; a list still offering rows at the safety cap is a
 * failure, never a silent claim that the list ended.
 */
async function checkTagBrowsing(page: Page, leg: BrowserLeg): Promise<void> {
  if (leg.tagRoutes.length === 0) {
    leg.record('browser-tags', false, 'the served tag index listed no /tags/<tag>/ route to open');
    return;
  }
  const measurements: TagRouteMeasurement[] = [];
  for (const route of leg.tagRoutes) {
    let measured: TagRouteMeasurement;
    try {
      measured = await measureTagRoute(page, leg, route);
    } catch (error) {
      leg.record(
        'browser-tags',
        false,
        `${route}: ${reason(error)}; observed ${await tagState(page)} ` +
          `(examined ${measurements.length + 1} of ${leg.tagRoutes.length} routes)`,
      );
      return;
    }
    measurements.push(measured);
    if (measured.moreClicks > 0) break;
  }

  const continued = measurements.find((entry) => entry.moreClicks > 0);
  const chosen = continued ?? measurements[0];
  const invented = chosen.rows.filter((href) => !chosen.staticHrefs.includes(href));
  leg.record(
    'browser-tags',
    chosen.rows.length > 0 && chosen.staticHrefs.length > 0 && invented.length === 0,
    `${chosen.route} label=${JSON.stringify(chosen.label)} rows=${chosen.rows.length} ` +
      `static-rows=${chosen.staticHrefs.length} loaded=${chosen.loaded} pages=${chosen.moreClicks + 1} ` +
      `more-clicks=${chosen.moreClicks} first-rows-ms=${chosen.firstRowsMs} region=${chosen.state} ` +
      `routes-examined=${measurements.length}${
        invented.length === 0 ? '' : ` row-not-in-static-list=${JSON.stringify(invented)}`
      } status=${JSON.stringify(chosen.regionStatus)}`,
  );
  leg.info(
    'browser-tags-continuation',
    continued === undefined
      ? `examined ${measurements.length} of ${leg.tagRoutes.length} tag route(s); every one fitted a single page ` +
          `(loaded ${measurements.map((entry) => entry.loaded).join('/')} rows against static rows ` +
          `${measurements.map((entry) => entry.staticHrefs.length).join('/')}), so no continuation was offered to take`
      : `${continued.route} continued ${continued.moreClicks} time(s), ending at ${continued.loaded} rows ` +
          `(static rows ${continued.staticHrefs.length})`,
  );
}

/** Console and page errors over the whole session, samples included. */
function checkConsole(leg: BrowserLeg, log: BrowserLog): void {
  leg.record(
    'browser-console',
    log.consoleErrors.length === 0 && log.pageErrors.length === 0,
    `console-errors=${log.consoleErrors.length} page-errors=${log.pageErrors.length}` +
      sample([...log.pageErrors, ...log.consoleErrors]),
  );
}

/**
 * Failed requests and non-GET methods over the whole session.
 *
 * Both halves are failures: a request the browser could not complete or the
 * origin answered with 4xx/5xx is a reader-visible break, and a method other
 * than GET would mean this read-only check changed something.
 */
function checkRequests(leg: BrowserLeg, log: BrowserLog): void {
  leg.record(
    'browser-requests',
    log.failed.length === 0 && log.nonGet.length === 0,
    `responses=${log.responses} failed=${log.failed.length} non-get=${log.nonGet.length}` +
      sample([...log.failed, ...log.nonGet]),
  );
}

/**
 * The one Playwright binding this leg uses.
 *
 * Typed structurally rather than by `import()` on the module, because the
 * driver has to stay a runtime import: Playwright is a devDependency, so a
 * static import would make the default GET-only pass — which a consumer runs
 * from an install that has no Playwright — fail to load.
 */
interface PlaywrightDriver {
  chromium: { launch: () => Promise<Browser> };
}

/** Load the browser driver, or record why the requested leg cannot run. */
async function loadPlaywright(record: BrowserLeg['record']): Promise<PlaywrightDriver | undefined> {
  try {
    return await import('playwright');
  } catch (error) {
    record(
      'browser-launch',
      false,
      `playwright is not installed (${reason(error)}); it is a devDependency of this repository, so an ` +
        'installed copy of the package must add it before --browser can run',
    );
    return undefined;
  }
}

/**
 * The `--browser` leg: the same origin, driven by Chromium.
 *
 * Nothing here is a retry. Every wait has an explicit timeout and every failure
 * records what was observed instead of a bare timeout, so an unreachable or
 * half-broken origin fails the run rather than producing a shorter one.
 */
async function runBrowserLeg(leg: BrowserLeg): Promise<void> {
  const playwright = await loadPlaywright(leg.record);
  if (playwright === undefined) return;

  let browser: Browser;
  try {
    browser = await playwright.chromium.launch();
  } catch (error) {
    leg.record(
      'browser-launch',
      false,
      `Chromium did not launch (${reason(error)}); install it with \`npx playwright install chromium\`, ` +
        'or run the check without --browser',
    );
    return;
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const log = watchBrowser(page);
    leg.info(
      'browser',
      `chromium=${browser.version()} playwright=${playwrightVersion()} viewport=1280x800 (emulated) read-only=GET`,
    );

    await checkRoot(page, leg);
    await checkPreview(page, leg, log);
    await checkTagBrowsing(page, leg);
    checkConsole(leg, log);
    checkRequests(leg, log);
  } finally {
    await browser.close();
  }
}

function usage(): string {
  return [
    'Usage: node scripts/check-deployed-site.ts --origin <url> [--timeout <ms>] [--browser]',
    '',
    'Read-only post-deployment check: GET requests only, no credentials, no writes.',
    '--browser adds a Chromium leg (Playwright) asserting a hover preview, no console',
    'or request error, and tag browsing against the same origin.',
    'Exits 0 when every assertion passes, 1 otherwise.',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return 0;
  }

  const { origin, timeoutMs, browser: browserLeg } = parseArguments(argv);
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

  // Last, so the HTTP pass a pipeline reads is unchanged and complete whether or
  // not a browser is available, and so a browser failure cannot hide a host
  // observation the earlier assertions already made.
  if (browserLeg) {
    await runBrowserLeg({ origin, timeoutMs, rootHtml: root.text, tagRoutes, record, info });
  }

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
