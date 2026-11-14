/**
 * Unit coverage for the post-deployment check's parsing and derivation, and for
 * the opt-in browser leg.
 *
 * The script itself is exercised against a live origin; these fixtures cover
 * the parts that decide *what* to request and *whether* a response is the right
 * kind of file. The "no reference found" case is a failure, not a skip — a
 * discovery step that quietly yields nothing would turn the check into a green
 * run that never looked at the snapshot.
 *
 * `--browser` is covered at every level it can fail: that it stays opt-in;
 * against real builds served on loopback, where the hover preview, the tag
 * list, and continuations all have to work — once with a tag small enough for
 * the list to render whole, once with one larger than the client's rendered
 * window, where only the loaded position keeps advancing; against the HTTP-only
 * fixture above, whose pages carry no preview panel and no tag region; against
 * a tag page whose list stalls with its continuation still on offer; and with
 * no Chromium installed, where the requested leg has to fail the run. A browser
 * leg that cannot fail would prove nothing, so the fixture cases assert the leg
 * fails a site the HTTP pass calls green.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  DeployedCheckError,
  collectScriptUrls,
  findNoteRoutes,
  findSnapshotUrl,
  findTagRoutes,
  findTitle,
  findWasmUrl,
  findWorkerChunk,
  hasNonEmptyNoteList,
  hasSqliteMagic,
  hasWasmMagic,
  isPlausibleSnapshotContentType,
  isPlausibleWasmContentType,
  normalizeHeaders,
  parseArguments,
  previewTitleBase,
  requireReference,
} from '../scripts/check-deployed-site.ts';
import { PREVIEW_TITLE_LIMIT, previewTitle } from '../src/lib/preview-model.ts';
import { TAG_PAGE_SIZE, TAG_WINDOW_SIZE } from '../src/lib/tag-browser-model.ts';
import { buildAndServe, removeWorkspace } from './support/browser-site.ts';

const SNAPSHOT = '65a6ea8ce3e2abd69f21f8e48dba0942f9b9b107afd48d782d4f116bb9f4e87e';
const WASM = '2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752';

const ROOT_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><title>Example &amp; notes</title>
<script src="/_astro/theme-init.CZu62CeA.js"></script>
<link rel="stylesheet" href="/_astro/Layout.B6lCtURH.css">
<script type="module" src="/_astro/Layout.astro_astro_type_script_index_0_lang.CSj7qfff.js"></script>
</head><body>
<a href="/notes/first-note/">First note</a>
<a href="/notes/second-note/">Second note</a>
<a href="/notes/first-note/">First note again</a>
<a href="/recent/">Recent</a>
</body></html>`;

const LAYOUT_JS = `const worker = new Worker("/_astro/snapshot-worker-BVa-dMgA.js", { type: "module" });`;

const WORKER_JS = `const snapshot = "/data/site.${SNAPSHOT}.sqlite";
const wasm = "/wasm/sqlite3.${WASM}.wasm";`;

const TAG_INDEX_HTML = `<html><head><title>Tags</title></head><body>
<nav class="site-nav"><a href="/tags/">Tags</a><a href="/graph/">Graph</a></nav>
<ul class="facet-list">
<li><a href="/tags/agent/">agent</a><span class="facet-count">1 note</span></li>
<li><a href="/tags/windows/">windows</a><span class="facet-count">1 note</span></li>
</ul>
</body></html>`;

const TAG_HTML = `<html><head><title>Tag: agent</title></head><body>
<div class="note-grid"><article class="note-card"><h2>First note</h2></article></div>
</body></html>`;

const EMPTY_TAG_INDEX_HTML = `<html><head><title>Tags</title></head><body>
<div class="section-heading"><h1 id="tags-title">Tags</h1><span>0 tags</span></div>
<p class="empty-state">This site has no tags yet.</p>
</body></html>`;

const EMPTY_TAG_STATE = /PASS tag-index — .*tag-routes=0, empty-state present/;

/**
 * A tag page whose enhanced list never loads its next page: one row is already
 * rendered, the region is visible, and the continuation button stays visible
 * without ever adding a row. The static page around it is well formed, so the
 * HTTP pass calls this route green and only the browser leg objects.
 */
const STALL_TAG_INDEX_HTML = `<html><head><title>Tags</title></head><body>
<ul class="facet-list">
<li><a href="/tags/stalled/">stalled</a><span class="facet-count">30 notes</span></li>
</ul>
</body></html>`;

const STALL_TAG_HTML = `<html><head><title>Tag: stalled</title></head><body>
<div class="note-grid"><article class="note-card"><h2>First note</h2></article></div>
<div id="tag-static-list"><a href="/notes/first-note/">First note</a></div>
<section id="tag-browser">
<p id="tag-browser-current">stalled</p>
<p id="tag-browser-status"></p>
<ol id="tag-browser-results">
<li aria-setsize="30" aria-posinset="1"><a href="/notes/first-note/">First note</a></li>
</ol>
<button id="tag-browse-more" type="button">Load more</button>
</section>
</body></html>`;

const SCRIPT = fileURLToPath(new URL('../scripts/check-deployed-site.ts', import.meta.url));

/**
 * One tag larger than the client renders at once (`TAG_WINDOW_SIZE`) by more
 * than one page (`TAG_PAGE_SIZE`).
 *
 * A tag of exactly window + one page would slide its window on its final page,
 * where the continuation button hides anyway; five more notes put two
 * continuations past the first slide, so the rendered row count stops growing
 * while rows keep loading — the case the leg has to follow by loaded position.
 */
const BIG_TAG_NOTES = TAG_WINDOW_SIZE + TAG_PAGE_SIZE + 5;
/** Page loads a tag of `BIG_TAG_NOTES` takes at the client's page size. */
const BIG_TAG_PAGES = Math.ceil(BIG_TAG_NOTES / TAG_PAGE_SIZE);

interface ServedFixture {
  contentType: string;
  body: string | Uint8Array;
}

interface SiteOptions {
  scriptContentType?: string;
  workerContentType?: string;
  tagIndexHtml?: string;
  /** Tag routes served with their own page instead of the default `TAG_HTML`. */
  tagPages?: Record<string, string>;
  /** Run the opt-in browser leg against the fixture. */
  browser?: boolean;
  /** Bound the browser leg's navigation and wait timeouts. */
  timeoutMs?: number;
  /** Paths the fixture answers with 404, for a leg that must notice a broken request. */
  missing?: readonly string[];
}

const SQLITE_HEADER = new TextEncoder().encode('SQLite format 3\u0000');

function siteRoutes(options: SiteOptions = {}): Record<string, ServedFixture> {
  const scriptContentType = options.scriptContentType ?? 'application/javascript; charset=utf-8';
  const routes: Record<string, ServedFixture> = {
    '/': { contentType: 'text/html; charset=utf-8', body: ROOT_HTML },
    // The root links this stylesheet. The HTTP pass never asks for it — it
    // reads scripts, not styles — but a browser does, so the fixture serves it
    // or the browser leg would report the fixture's own gap as the site's.
    '/_astro/Layout.B6lCtURH.css': { contentType: 'text/css; charset=utf-8', body: '/* layout */' },
    '/_astro/theme-init.CZu62CeA.js': { contentType: scriptContentType, body: '/* theme */' },
    '/_astro/Layout.astro_astro_type_script_index_0_lang.CSj7qfff.js': {
      contentType: scriptContentType,
      body: LAYOUT_JS,
    },
    '/_astro/snapshot-worker-BVa-dMgA.js': {
      contentType: options.workerContentType ?? scriptContentType,
      body: WORKER_JS,
    },
    [`/data/site.${SNAPSHOT}.sqlite`]: { contentType: 'application/octet-stream', body: SQLITE_HEADER },
    [`/wasm/sqlite3.${WASM}.wasm`]: {
      contentType: 'application/wasm',
      body: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    },
    '/tags/': { contentType: 'text/html; charset=utf-8', body: options.tagIndexHtml ?? TAG_INDEX_HTML },
    '/tags/agent/': { contentType: 'text/html; charset=utf-8', body: TAG_HTML },
    '/notes/first-note/': {
      contentType: 'text/html; charset=utf-8',
      body: '<html><head><title>First note</title></head><body></body></html>',
    },
  };
  for (const path of options.missing ?? []) delete routes[path];
  for (const [path, body] of Object.entries(options.tagPages ?? {})) {
    routes[path] = { contentType: 'text/html; charset=utf-8', body };
  }
  return routes;
}

async function serve(
  routes: Record<string, ServedFixture>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const fixture = routes[path];
    if (fixture === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': fixture.contentType });
    response.end(fixture.body);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      const closing = Promise.withResolvers<void>();
      server.close((error) => (error ? closing.reject(error) : closing.resolve()));
      await closing.promise;
    },
  };
}

/** Run the real CLI against the fixture; stdout and stderr are the assertion message. */
async function runCheck(
  origin: string,
  extra: readonly string[] = [],
  env: Record<string, string> = {},
): Promise<{ status: number | null; output: string }> {
  const child = spawn(process.execPath, [SCRIPT, '--origin', origin, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk;
  });
  const completion = Promise.withResolvers<number | null>();
  child.on('error', completion.reject);
  child.on('close', completion.resolve);
  return { status: await completion.promise, output };
}

async function checkSite(options: SiteOptions): Promise<{ status: number | null; output: string }> {
  const site = await serve(siteRoutes(options));
  const extra = [
    ...(options.browser === true ? ['--browser'] : []),
    ...(options.timeoutMs === undefined ? [] : ['--timeout', String(options.timeoutMs)]),
  ];
  try {
    return await runCheck(site.origin, extra);
  } finally {
    await site.close();
  }
}

test('parseArguments accepts a bare origin and optional timeout', () => {
  assert.deepEqual(parseArguments(['--origin', 'https://example.org/']), {
    origin: 'https://example.org',
    timeoutMs: 15_000,
    browser: false,
  });
  assert.deepEqual(parseArguments(['--origin=https://example.org', '--timeout=2500']), {
    origin: 'https://example.org',
    timeoutMs: 2500,
    browser: false,
  });
});

test('parseArguments opts the browser leg in only when it is named', () => {
  assert.deepEqual(parseArguments(['--origin', 'https://example.org/', '--browser']), {
    origin: 'https://example.org',
    timeoutMs: 15_000,
    browser: true,
  });
  // `--browser` is a flag, not a key that takes a value: anything else is an
  // unknown argument rather than a silently ignored word.
  assert.throws(() => parseArguments(['--origin', 'https://example.org/', '--browser=false']), /unknown argument/);
});

test('previewTitleBase keeps the stored title and drops the alias group', () => {
  assert.equal(previewTitleBase('Note title'), 'Note title');
  assert.equal(previewTitleBase('Note title (alpha, beta)'), 'Note title');
  assert.equal(previewTitleBase('Interval (half-open)'), 'Interval');
  assert.equal(previewTitleBase('A title long enough to be truncated…'), 'A title long enough to be truncated');
  assert.equal(previewTitleBase('Truncated (alpha, be…'), 'Truncated');
  assert.equal(previewTitleBase('  Spaced title  '), 'Spaced title');
  assert.equal(previewTitleBase('…'), '');
});

test('previewTitleBase keeps its prefix of the title previewTitle produces', () => {
  // The panel title's format belongs to `previewTitle`; asserting the
  // agreement against that producer is what fails when the separator or the
  // truncation marker moves, instead of pinning a copy of the format here.
  const cases = [
    { title: 'Note title', excerpt: '' },
    { title: 'Note title', excerpt: '', aliases: ['alpha', 'beta'] },
    { title: 'Interval (half-open)', excerpt: '', aliases: ['alias'] },
    { title: 'L'.repeat(PREVIEW_TITLE_LIMIT + 200), excerpt: '' },
    { title: 'L'.repeat(PREVIEW_TITLE_LIMIT + 200), excerpt: '', aliases: ['alpha', 'beta'] },
  ];
  for (const entry of cases) {
    const base = previewTitleBase(previewTitle(entry));
    assert.ok(base !== '', `no base in ${JSON.stringify(entry.title.slice(0, 24))}`);
    assert.ok(entry.title.startsWith(base), `${JSON.stringify(base)} is not a prefix of the stored title`);
    assert.ok(previewTitle(entry).length <= PREVIEW_TITLE_LIMIT, 'the producer bounded the panel title');
  }
  // An aliased long title truncates inside the alias group, so the marker has to
  // be dropped before the group is cut.
  assert.equal(previewTitleBase(previewTitle(cases[4])), 'L'.repeat(PREVIEW_TITLE_LIMIT - 1));
});

test('parseArguments rejects a missing, pathed, or unsupported origin', () => {
  assert.throws(() => parseArguments([]), DeployedCheckError);
  assert.throws(() => parseArguments(['--origin', 'https://example.org/notes/']), /no path/);
  assert.throws(() => parseArguments(['--origin', 'ftp://example.org/']), /http or https/);
  assert.throws(() => parseArguments(['--origin', 'not a url']), /not a URL/);
  assert.throws(() => parseArguments(['--origin', 'https://example.org/', '--verbose']), /unknown argument/);
  assert.throws(() => parseArguments(['--origin', 'https://example.org/', '--timeout', '0']), /positive number/);
});

test('normalizeHeaders lowercases names and keeps the last value', () => {
  const headers = normalizeHeaders([
    ['Content-Type', 'text/html; charset=utf-8'],
    ['Cache-Control', 'max-age=600'],
    ['content-type', 'application/octet-stream'],
  ]);
  assert.equal(headers.get('content-type'), 'application/octet-stream');
  assert.equal(headers.get('cache-control'), 'max-age=600');
  assert.equal(headers.get('missing'), undefined);
});

test('findTitle reads, trims, and entity-decodes a non-empty title', () => {
  assert.equal(findTitle(ROOT_HTML), 'Example & notes');
  assert.equal(findTitle('<title> Tag: agent · Notes </title>'), 'Tag: agent · Notes');
  assert.equal(findTitle('<title>   </title>'), undefined);
  assert.equal(findTitle('<html><body>no title</body></html>'), undefined);
});

test('collectScriptUrls keeps local scripts and skips stylesheets and external scripts', () => {
  const urls = collectScriptUrls(ROOT_HTML);
  assert.deepEqual(urls, [
    '/_astro/theme-init.CZu62CeA.js',
    '/_astro/Layout.astro_astro_type_script_index_0_lang.CSj7qfff.js',
  ]);

  const external = collectScriptUrls(
    '<script src="https://cdn.example.org/lib.js"></script><script src="/app.js"></script>',
  );
  assert.deepEqual(external, ['/app.js']);
});

test('findSnapshotUrl matches only the 64-hex content-addressed name', () => {
  assert.equal(findSnapshotUrl(WORKER_JS), `/data/site.${SNAPSHOT}.sqlite`);
  assert.equal(findSnapshotUrl(`/data/site.${SNAPSHOT.slice(1)}.sqlite`), undefined);
  assert.equal(findSnapshotUrl(`/data/site.${SNAPSHOT.toUpperCase()}.sqlite`), undefined);
  assert.equal(findSnapshotUrl('/data/site.sqlite'), undefined);
});

test('findWasmUrl matches only the 64-hex content-addressed name', () => {
  assert.equal(findWasmUrl(WORKER_JS), `/wasm/sqlite3.${WASM}.wasm`);
  assert.equal(findWasmUrl('/wasm/sqlite3.wasm'), undefined);
});

test('findWorkerChunk accepts the absolute and relative reference shapes', () => {
  assert.equal(findWorkerChunk(LAYOUT_JS), '/_astro/snapshot-worker-BVa-dMgA.js');
  assert.equal(
    findWorkerChunk('new URL("./snapshot-worker-BVa-dMgA.js", import.meta.url)'),
    './snapshot-worker-BVa-dMgA.js',
  );
  assert.equal(findWorkerChunk('no worker here'), undefined);
});

test('requireReference fails loudly when no served text names the asset', () => {
  assert.equal(requireReference('snapshot', findSnapshotUrl, [ROOT_HTML, LAYOUT_JS, WORKER_JS]), `/data/site.${SNAPSHOT}.sqlite`);
  assert.throws(
    () => requireReference('snapshot', findSnapshotUrl, [ROOT_HTML, LAYOUT_JS]),
    (error: unknown) =>
      error instanceof DeployedCheckError && /no snapshot reference found/.test(error.message),
  );
});

test('SQLite magic is the exact 16-byte header and nothing shorter', () => {
  const header = new TextEncoder().encode('SQLite format 3\u0000');
  assert.equal(header.length, 16);
  assert.equal(hasSqliteMagic(header), true);
  assert.equal(hasSqliteMagic(new TextEncoder().encode('SQLite format 3\u0000rest')), true);
  assert.equal(hasSqliteMagic(new TextEncoder().encode('SQLite format 3')), false);
  assert.equal(hasSqliteMagic(new Uint8Array(0)), false);
  assert.equal(hasSqliteMagic(new TextEncoder().encode('SQLite format 2\u0000')), false);
});

test('WASM magic is exactly \\0asm', () => {
  assert.equal(hasWasmMagic(new Uint8Array([0x00, 0x61, 0x73, 0x6d])), true);
  assert.equal(hasWasmMagic(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01])), true);
  assert.equal(hasWasmMagic(new Uint8Array([0x00, 0x61, 0x73])), false);
  assert.equal(hasWasmMagic(new TextEncoder().encode('asm')), false);
  assert.equal(hasWasmMagic(new Uint8Array(0)), false);
});

test('snapshot content types accept what static hosts honestly serve and reject HTML', () => {
  assert.equal(isPlausibleSnapshotContentType('application/octet-stream'), true);
  assert.equal(isPlausibleSnapshotContentType('application/vnd.sqlite3'), true);
  assert.equal(isPlausibleSnapshotContentType('application/octet-stream; charset=binary'), true);
  assert.equal(isPlausibleSnapshotContentType('text/html; charset=utf-8'), false);
  assert.equal(isPlausibleSnapshotContentType(undefined), false);
});

test('WASM content types accept application/wasm and reject HTML', () => {
  assert.equal(isPlausibleWasmContentType('application/wasm'), true);
  assert.equal(isPlausibleWasmContentType('application/octet-stream'), true);
  assert.equal(isPlausibleWasmContentType('text/html'), false);
  assert.equal(isPlausibleWasmContentType(undefined), false);
});

test('findTagRoutes reads only the facet list, not the surrounding navigation', () => {
  assert.deepEqual(findTagRoutes(TAG_INDEX_HTML), ['/tags/agent/', '/tags/windows/']);
  assert.deepEqual(findTagRoutes('<nav><a href="/tags/agent/">agent</a></nav>'), []);
});

test('hasNonEmptyNoteList requires both the grid and a card inside it', () => {
  assert.equal(hasNonEmptyNoteList(TAG_HTML), true);
  assert.equal(hasNonEmptyNoteList('<div class="note-grid"></div>'), false);
  assert.equal(hasNonEmptyNoteList('<article class="note-card"></article>'), false);
});

test('findNoteRoutes returns unique note routes and ignores other links', () => {
  assert.deepEqual(findNoteRoutes(ROOT_HTML), ['/notes/first-note/', '/notes/second-note/']);
});

test('a site serving JavaScript as text/javascript passes every asset check', async () => {
  const result = await checkSite({ scriptContentType: 'text/javascript; charset=utf-8' });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /PASS hashed-asset — .*content-type=text\/javascript/);
  assert.match(result.output, /PASS asset-chain — .*snapshot-worker-BVa-dMgA\.js/);
  assert.match(result.output, /9 passed, 0 failed/);
});

test('a worker served as text/plain fails the asset chain', async () => {
  const result = await checkSite({ workerContentType: 'text/plain; charset=utf-8' });
  assert.notEqual(result.status, 0, result.output);
  assert.match(
    result.output,
    /FAIL asset-chain — snapshot worker \/_astro\/snapshot-worker-BVa-dMgA\.js is not a JavaScript module: .*content-type=text\/plain/,
  );
});

test('a tag index with the supported empty state passes without a tag route', async () => {
  const result = await checkSite({ tagIndexHtml: EMPTY_TAG_INDEX_HTML });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, EMPTY_TAG_STATE);
  assert.doesNotMatch(result.output, /FAIL tag-route —/);
  assert.match(result.output, /8 passed, 0 failed/);
});

/**
 * 21 notes on one tag: two full pages and a one-row third, so the tag leg has a
 * continuation to take. Every note carries an alias, so the panel title the
 * preview leg reads always carries the alias group `previewTitleBase` strips —
 * whichever note the site root happens to link to first.
 */
function browserCorpus(): Record<string, string> {
  const files: Record<string, string> = {
    'home-note.md': [
      '---',
      'title: "Home note"',
      'aliases: ["home-alias"]',
      '---',
      '',
      '# Home note',
      '',
      'Body of the home note.',
      '',
    ].join('\n'),
  };
  for (let index = 1; index <= 21; index += 1) {
    const id = String(index).padStart(2, '0');
    files[`browser-note-${id}.md`] = [
      '---',
      `title: "Browser note ${id}"`,
      `aliases: ["alias-${id}"]`,
      'tags: [browser-tag]',
      '---',
      '',
      `# Browser note ${id}`,
      '',
      `Body for browser note ${id}.`,
      '',
    ].join('\n');
  }
  return files;
}

/**
 * `BIG_TAG_NOTES` notes on one tag, against a window the list cannot grow into.
 *
 * The client renders `TAG_WINDOW_SIZE` rows and slides them, so past the first
 * slide the rendered row count is the bound while the loaded position keeps
 * advancing; a leg that keys on the row count fails this corpus and a leg that
 * keys on the loaded position passes it.
 */
function bigTagCorpus(): Record<string, string> {
  const files: Record<string, string> = {
    'home-note.md': [
      '---',
      'title: "Home note"',
      'aliases: ["home-alias"]',
      '---',
      '',
      '# Home note',
      '',
      'Body of the home note.',
      '',
    ].join('\n'),
  };
  for (let index = 1; index <= BIG_TAG_NOTES; index += 1) {
    const id = String(index).padStart(3, '0');
    files[`big-note-${id}.md`] = [
      '---',
      `title: "Big note ${id}"`,
      'tags: [big-tag]',
      '---',
      '',
      `# Big note ${id}`,
      '',
      `Body for big note ${id}.`,
      '',
    ].join('\n');
  }
  return files;
}

test('the browser leg is opt-in: the default run reports no browser line', async () => {
  const result = await checkSite({});
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /browser/);
});

test('the browser leg passes a real build and takes a tag continuation', async () => {
  const site = await buildAndServe(browserCorpus());
  try {
    const result = await runCheck(site.origin, ['--browser']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /PASS browser-root — status=200 title="[^"]+" served-title="[^"]+"/);
    assert.match(
      result.output,
      /PASS browser-preview — \/notes\/[A-Za-z0-9-]+\/ panel-title="[^"]+ \([A-Za-z0-9-]+\)" panel-title-base="[^"]+" describedby="link-preview" target-status=200 target-title=".*" runtime-requests=\[worker=1 snapshot=1 wasm=1\]/,
    );
    assert.match(
      result.output,
      /PASS browser-tags — \/tags\/browser-tag\/ label="[^"]+" rows=21 static-rows=21 loaded=21 pages=3 more-clicks=2/,
    );
    assert.match(result.output, /INFO browser-tags-continuation — \/tags\/browser-tag\/ continued 2 time\(s\), ending at 21 rows/);
    assert.match(result.output, /PASS browser-console — console-errors=0 page-errors=0/);
    assert.match(result.output, /PASS browser-requests — responses=\d+ failed=0 non-get=0/);
    assert.match(result.output, /14 passed, 0 failed/);
  } finally {
    await site.close();
    removeWorkspace(site.workspace);
  }
}, 180_000);

test('the browser leg follows a tag larger than the client renders at once', async () => {
  const site = await buildAndServe(bigTagCorpus());
  try {
    const result = await runCheck(site.origin, ['--browser']);
    assert.equal(result.status, 0, result.output);
    // The rendered rows stop at the client's window while the list keeps
    // loading to the last note: `rows` is the bound, `loaded` is the tag.
    assert.match(
      result.output,
      new RegExp(
        `PASS browser-tags — /tags/big-tag/ label="[^"]+" rows=${TAG_WINDOW_SIZE} ` +
          `static-rows=${BIG_TAG_NOTES} loaded=${BIG_TAG_NOTES} pages=${BIG_TAG_PAGES} ` +
          `more-clicks=${BIG_TAG_PAGES - 1} `,
      ),
    );
    assert.match(
      result.output,
      new RegExp(
        `INFO browser-tags-continuation — /tags/big-tag/ continued ${BIG_TAG_PAGES - 1} ` +
          `time\\(s\\), ending at ${BIG_TAG_NOTES} rows`,
      ),
    );
    assert.match(result.output, /PASS browser-console — console-errors=0 page-errors=0/);
    assert.match(result.output, /PASS browser-requests — responses=\d+ failed=0 non-get=0/);
    assert.match(result.output, /14 passed, 0 failed/);
  } finally {
    await site.close();
    removeWorkspace(site.workspace);
  }
}, 300_000);

test('the browser leg fails a site with no client runtime that the HTTP pass calls green', async () => {
  const result = await checkSite({
    browser: true,
    timeoutMs: 2500,
    // One asset the root links is withheld, so this run also contains a request
    // a reader's browser would report as failed. A counter that only ever reads
    // zero proves nothing; this is the case that makes it read non-zero.
    missing: ['/_astro/Layout.B6lCtURH.css'],
  });
  assert.notEqual(result.status, 0, result.output);
  // The HTTP assertions in the same run are green, so the failure belongs to
  // the browser leg rather than to a site it could not reach, and the root
  // assertion still passes: the page loads and its title matches the bytes.
  assert.match(result.output, /PASS site-root —/);
  assert.match(result.output, /PASS asset-chain —/);
  assert.match(result.output, /PASS tag-route —/);
  assert.match(result.output, /PASS browser-root — status=200/);
  assert.match(result.output, /FAIL browser-preview — \/notes\/first-note\/ .*panel=absent/);
  // The static tag page is served and HTTP-green; what is missing is the
  // enhanced list, and the failure detail says so.
  assert.match(result.output, /FAIL browser-tags — \/tags\/agent\/: .*observed region=absent browser-rows=0/);
  assert.match(result.output, /FAIL browser-console — console-errors=1 page-errors=0/);
  assert.match(
    result.output,
    /FAIL browser-requests — responses=\d+ failed=2 non-get=0 first=\["404 .*_astro\/Layout\.B6lCtURH\.css"/,
  );
  assert.match(result.output, /10 passed, 4 failed/);
}, 120_000);

test('the browser leg fails a tag list that never loads past its first page', async () => {
  const result = await checkSite({
    browser: true,
    timeoutMs: 2500,
    tagIndexHtml: STALL_TAG_INDEX_HTML,
    tagPages: { '/tags/stalled/': STALL_TAG_HTML },
  });
  assert.notEqual(result.status, 0, result.output);
  // The static page is served and the HTTP pass calls it green; what stalls is
  // the enhanced list, with its continuation button still on offer.
  assert.match(result.output, /PASS tag-route — \/tags\/stalled\//);
  assert.match(
    result.output,
    /FAIL browser-tags — \/tags\/stalled\/: did not load past row 1 on continuation 1 \(page\.waitForFunction: Timeout 2500ms exceeded\.\); observed region=visible browser-rows=1 loaded=1/,
  );
  assert.match(result.output, /PASS browser-console — console-errors=0 page-errors=0/);
  assert.match(result.output, /PASS browser-requests — responses=\d+ failed=0 non-get=0/);
  assert.match(result.output, /12 passed, 2 failed/);
}, 60_000);

test('a requested browser leg fails the run when no Chromium is installed', async () => {
  // The empty cache is this run's own: a leg that silently skipped when the
  // browser was absent would leave a consumer's gate green without ever
  // driving the origin.
  const cache = mkdtempSync(join(tmpdir(), 'anc-no-browsers-'));
  const site = await serve(siteRoutes({}));
  try {
    const result = await runCheck(site.origin, ['--browser'], { PLAYWRIGHT_BROWSERS_PATH: cache });
    assert.notEqual(result.status, 0, result.output);
    // The HTTP pass is unchanged — same origin, same nine assertions — so the
    // failure is the browser leg's and not a site the check could not reach.
    assert.match(result.output, /PASS site-root —/);
    assert.match(result.output, /PASS asset-chain —/);
    assert.match(result.output, /PASS tag-route —/);
    assert.match(result.output, /FAIL browser-launch — Chromium did not launch/);
    assert.doesNotMatch(result.output, /PASS browser-root/);
    assert.match(result.output, /9 passed, 1 failed/);
  } finally {
    await site.close();
    rmSync(cache, { recursive: true, force: true });
  }
}, 60_000);
