/**
 * Unit coverage for the post-deployment check's parsing and derivation.
 *
 * The script itself is exercised against a live origin; these fixtures cover
 * the parts that decide *what* to request and *whether* a response is the right
 * kind of file. The "no reference found" case is a failure, not a skip — a
 * discovery step that quietly yields nothing would turn the check into a green
 * run that never looked at the snapshot.
 */

import assert from 'node:assert/strict';
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
  requireReference,
} from '../scripts/check-deployed-site.ts';

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

test('parseArguments accepts a bare origin and optional timeout', () => {
  assert.deepEqual(parseArguments(['--origin', 'https://example.org/']), {
    origin: 'https://example.org',
    timeoutMs: 15_000,
  });
  assert.deepEqual(parseArguments(['--origin=https://example.org', '--timeout=2500']), {
    origin: 'https://example.org',
    timeoutMs: 2500,
  });
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
