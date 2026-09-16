/**
 * The lazy snapshot runtime in a real browser under the deployed CSP.
 *
 * Serves an actual build with the headers `public/_headers` declares, so the
 * Worker, the WASM import, and the snapshot fetch are exercised under
 * `worker-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, and
 * `connect-src 'self'`. A skipped run is not evidence, so these tests fail when
 * Chromium is absent rather than skipping silently; the shared runner in
 * `tests/support` is not used because this file owns its corpus build.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, Page } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'anc.mjs');

/** Headers `public/_headers` declares, applied by the test server. */
function shippedHeaders(): Record<string, string> {
  const text = readFileSync(join(ROOT, 'public', '_headers'), 'utf8');
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(' ') || line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const trimmed = line.trim();
    const separator = trimmed.indexOf(':');
    if (separator > 0) headers[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).trim();
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
};

let workspace: string;
let server: Server;
let origin: string;
let browser: Browser;

function startServer(dist: string): Promise<Server> {
  const headers = shippedHeaders();
  const running = createServer((request, response) => {
    let pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(dist, `.${pathname}`);
    if (!file.startsWith(dist)) {
      response.writeHead(403, headers);
      response.end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, { ...headers, 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404, headers);
      response.end('not found');
    }
  });
  return new Promise((done) => running.listen(0, '127.0.0.1', () => done(running)));
}

function sqliteRequests(page: Page): string[] {
  const found: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/data/site.') || url.includes('/wasm/')) found.push(url);
  });
  return found;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'anc-runtime-'));
  const notes = join(workspace, 'notes');
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'alpha.md'), '# Alpha Note\n\nEnglish alpha body. Links to [[beta]], [[markup]] and [[withheld]].\n', 'utf8');
  writeFileSync(
    join(notes, 'beta.md'),
    ['---', 'language: zh-CN', '---', '# 测试笔记', '', '这是中文正文，用于预览。', ''].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(notes, 'markup.md'),
    [
      '---',
      'title: "<i>Title</i>"',
      'aliases: ["<em>Older"]',
      '---',
      '# Markup Title',
      '',
      'A note whose metadata only an HTML parser would treat as elements.',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(notes, 'withheld.md'), '---\npublish: false\n---\n# Withheld Secret\n\nzzqwithheldbody\n', 'utf8');

  const build = spawnSync(process.execPath, [BINARY, 'build', '--content', 'notes', '--out', 'dist'], {
    cwd: workspace,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stdout + build.stderr);

  server = await startServer(join(workspace, 'dist'));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
  rmSync(workspace, { recursive: true, force: true });
});

test('ordinary reading downloads no SQLite assets and an intentional hover previews from the snapshot', async () => {
  const page = await browser.newPage();
  const requests = sqliteRequests(page);
  await page.goto(`${origin}/notes/alpha/`, { waitUntil: 'load' });
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(300);
  assert.deepEqual(requests, [], 'ordinary reading requested SQLite assets');

  const link = page.locator('a[href="/notes/beta/"]').first();
  assert.equal(await link.count(), 1, 'the corpus build did not render the cross-note link');
  await link.hover();
  const panel = page.locator('#link-preview');
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  const text = (await panel.textContent()) ?? '';
  assert.ok(text.includes('测试笔记'), `preview did not show the target title: ${text}`);
  assert.ok(text.includes('这是中文正文'), `preview did not show the target excerpt: ${text}`);
  const titleLang = await panel.locator('strong').getAttribute('lang');
  assert.equal(titleLang, 'zh-CN', 'a foreign-language preview title did not carry its lang');
  assert.ok(requests.length >= 2, 'the preview did not use the snapshot runtime');

  // Metadata reaches the panel as text: a title and alias only an HTML parser
  // would treat as elements must not become elements in the DOM.
  await page.mouse.move(0, 0);
  await panel.waitFor({ state: 'hidden', timeout: 5_000 });
  const markupLink = page.locator('a[href="/notes/markup/"]').first();
  assert.equal(await markupLink.count(), 1, 'the markup note link is absent, so the text gate is vacuous');
  await markupLink.hover();
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  const markup = await panel.evaluate((node) => ({
    elements: [...node.querySelectorAll('*')].map((child) => child.localName).sort(),
    title: node.querySelector('strong')?.textContent ?? '',
  }));
  assert.deepEqual(markup.elements, ['p', 'strong'], 'preview metadata became elements, so it was parsed as markup');
  assert.equal(markup.title, '<i>Title</i> (<em>Older)', 'title and alias were not rendered verbatim');

  // The withheld target renders as a live `/private/` link, which is not a note
  // route, so it is never previewable and its metadata cannot surface.
  const withheld = page.locator('a[href="/private/"]').first();
  assert.equal(await withheld.count(), 1, 'the withheld link is absent, so the negative control is vacuous');
  await page.mouse.move(0, 0);
  await panel.waitFor({ state: 'hidden', timeout: 5_000 });
  await withheld.hover();
  await page.waitForTimeout(400);
  assert.equal(await panel.isHidden(), true, 'a withheld link produced a preview panel');
  await page.close();
}, 120_000);

test('a blocked snapshot leaves static reading intact and a later intent retries', async () => {
  const page = await browser.newPage();
  await page.route('**/data/site.*', (route) => route.abort());
  await page.goto(`${origin}/notes/alpha/`, { waitUntil: 'load' });
  const link = page.locator('a[href="/notes/beta/"]').first();
  await link.hover();
  await page.waitForTimeout(1_500);
  assert.equal(await page.locator('#link-preview').isHidden(), true, 'a failed snapshot still showed a panel');
  // Static reading is intact: the anchor is real and its text is present.
  assert.equal(await link.getAttribute('href'), '/notes/beta/');
  assert.ok((await page.locator('article').textContent())?.includes('English alpha body'));

  await page.unroute('**/data/site.*');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  await link.hover();
  await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 10_000 });
  assert.ok(((await page.locator('#link-preview').textContent()) ?? '').includes('测试笔记'), 'retry did not succeed');
  await page.close();
}, 120_000);
