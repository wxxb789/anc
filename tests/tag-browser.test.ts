/**
 * Complete tag browsing in a real browser and without scripting.
 *
 * The corpus is authored here with independent expected membership, so the gate
 * does not derive its answer from `tagFacets` or `tagPage`. It is served with the
 * headers `public/_headers` declares, so the shared Worker, the WASM, and the
 * snapshot are exercised under the deployed CSP.
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

const TAG_KEY = 'gardening';
const TAG_LABEL = 'Gardening';
const OTHER_TAG_KEY = 'notebook';
const EXPECTED = Array.from({ length: 21 }, (_, index) => `tag-${String(index + 1).padStart(2, '0')}`);
const NOTEBOOK = ['tag-01', 'tag-02', 'tag-03'];
const PAGE_SIZE = 10;

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
      response.writeHead(200, {
        ...headers,
        'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404, headers);
      response.end('not found');
    }
  });
  return new Promise((done) => running.listen(0, '127.0.0.1', () => done(running)));
}

async function seenSlugs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('#tag-browser-results a[href^="/notes/"]')].map(
      (link) => link.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
    ),
  );
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'anc-tags-'));
  const notes = join(workspace, 'notes');
  mkdirSync(notes, { recursive: true });
  for (let index = 1; index <= EXPECTED.length; index += 1) {
    const slug = `tag-${String(index).padStart(2, '0')}`;
    const label = index % 2 === 0 ? 'gardening' : 'Gardening';
    const tags = index <= NOTEBOOK.length ? `[${label}, notebook]` : `[${label}]`;
    const language = index === 7 ? 'language: zh-CN\n' : '';
    // Titles reverse slug order, so static title order differs from cursor order.
    const title = `Title ${String(EXPECTED.length - index).padStart(2, '0')}`;
    writeFileSync(
      join(notes, `${slug}.md`),
      `---\ntitle: "${title}"\n${language}tags: ${tags}\n---\n\n# ${title}\n\nBody for ${slug}.\n`,
      'utf8',
    );
  }
  writeFileSync(join(notes, 'island.md'), '# Island\n\nNo tags, no links.\n', 'utf8');
  writeFileSync(
    join(notes, 'secret.md'),
    '---\npublish: false\ntags: [withheld-only]\n---\n\n# Secret\n\nNot published.\n',
    'utf8',
  );

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

test('the tag chooser enumerates every matching note across pages, in cursor order', async () => {
  const page = await browser.newPage();
  await page.goto(`${origin}/tags/`, { waitUntil: 'load' });
  await page.selectOption('#tag-browser-select', TAG_KEY);
  await page.waitForSelector('#tag-browser-results a');

  const collected = await seenSlugs(page);
  const pageSizes: number[] = [collected.length];
  while (await page.locator('#tag-browse-more').isVisible()) {
    await page.locator('#tag-browse-more').click();
    await page.waitForTimeout(150);
    const next = await seenSlugs(page);
    pageSizes.push(next.length - collected.length);
    collected.length = 0;
    collected.push(...next);
  }

  assert.deepEqual(collected, EXPECTED, 'the browser did not enumerate the tag in cursor order');
  assert.equal(new Set(collected).size, collected.length, 'a note was enumerated twice');
  assert.deepEqual(pageSizes, [PAGE_SIZE, PAGE_SIZE, 1], `unexpected page boundaries: ${pageSizes.join(',')}`);
  assert.equal(
    await page.locator('#tag-browser-current').textContent(),
    TAG_LABEL,
    'the snapshot label disagrees with the static label',
  );
  const status = await page.locator('#tag-browser-status').textContent();
  assert.ok(status && status.length > 0, 'exhaustion produced no status sentence');

  // Language metadata travels with the browser result, matching static rendering.
  assert.equal(
    await page.locator('#tag-browser-results a[href="/notes/tag-07/"]').getAttribute('lang'),
    'zh-CN',
    'a foreign-language result did not carry its lang',
  );
  assert.equal(
    await page.locator('#tag-browser-results a[href="/notes/tag-01/"]').getAttribute('lang'),
    null,
    'a default-language result carried a redundant lang',
  );

  // An unknown key is distinct from exhaustion: the panel must render the
  // unknown sentence, driven through the real handler.
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('#tag-browser-select')!;
    select.append(new Option('zzq-not-a-tag', 'zzq-not-a-tag'));
    select.value = 'zzq-not-a-tag';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Wait for the state this test names rather than a fixed sleep: `tag-browser.ts`
  // writes the loading sentence synchronously before awaiting the Worker, so a
  // "not exhaustion" probe also passes while the reply is still in flight and the
  // list is empty — the regression this gate exists to catch would stay green.
  const unknownSentence = await page.locator('#tag-browser').getAttribute('data-tag-browse-unknown');
  assert.ok(unknownSentence, '#tag-browser does not carry the unknown sentence to render');
  await page.waitForFunction(
    (expected) => document.querySelector('#tag-browser-status')?.textContent === expected,
    unknownSentence,
    { timeout: 10_000 },
  );
  assert.equal(
    await page.locator('#tag-browser-status').textContent(),
    unknownSentence,
    'an unknown tag did not render the unknown sentence',
  );
  assert.equal((await seenSlugs(page)).length, 0, 'an unknown tag produced results');
  await page.close();
}, 120_000);

test('two Load more clicks before the first reply cannot duplicate a page', async () => {
  const page = await browser.newPage();
  // Count the `byTag` messages the page actually dispatches. The snapshot is
  // fetched once and reused, so a delayed `**/data/site.*` route never holds a
  // continuation open — the Worker message is the boundary that matters.
  await page.addInitScript(() => {
    const state = window as unknown as { byTagDispatches: number };
    state.byTagDispatches = 0;
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      ...rest: unknown[]
    ): void {
      if ((message as { type?: string }).type === 'byTag') state.byTagDispatches += 1;
      (original as (this: Worker, ...args: unknown[]) => void).call(this, message, ...rest);
    };
  });
  const dispatches = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { byTagDispatches: number }).byTagDispatches);

  await page.goto(`${origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  await page.click('#tag-browse-start');
  await page.waitForSelector('#tag-browser-results a');
  assert.equal(await dispatches(), 1, 'the first page should be one byTag request');

  // Two synchronous clicks, the way a double click arrives: the button disables
  // itself inside the first handler, so the second click hits a disabled control
  // and dispatches nothing. Neither reply can be handled until this turn ends,
  // so the dispatch count is final here rather than racing the Worker.
  await page.evaluate(() => {
    const more = document.querySelector<HTMLButtonElement>('#tag-browse-more')!;
    more.click();
    more.click();
  });
  assert.equal(await dispatches(), 2, 'a second Load more click dispatched the same cursor again');

  // Then wait for the continuation's reply and enumerate the last page, so the
  // list is read only after every dispatched reply has rendered.
  await page.waitForFunction(
    (expected) => document.querySelectorAll('#tag-browser-results a').length === expected,
    PAGE_SIZE * 2,
    { timeout: 10_000 },
  );
  const exhaustedSentence = await page.locator('#tag-browser').getAttribute('data-tag-browse-exhausted');
  assert.ok(exhaustedSentence, '#tag-browser does not carry the exhaustion sentence to render');
  await page.locator('#tag-browse-more').click();
  await page.waitForFunction(
    (expected) => document.querySelector('#tag-browser-status')?.textContent === expected,
    exhaustedSentence,
    { timeout: 10_000 },
  );

  const collected = await seenSlugs(page);
  assert.deepEqual(collected, EXPECTED, 'the browser did not enumerate the tag in cursor order');
  assert.equal(new Set(collected).size, collected.length, 'a note was enumerated twice');
  await page.close();
}, 120_000);

test('switching tags resets the continuation and a stale reply cannot win', async () => {
  const page = await browser.newPage();
  // Delay the snapshot so both selections are in flight when the data arrives.
  await page.route('**/data/site.*', async (route) => {
    await new Promise((resume) => setTimeout(resume, 700));
    await route.continue();
  });
  await page.goto(`${origin}/tags/`, { waitUntil: 'load' });
  await page.selectOption('#tag-browser-select', TAG_KEY);
  await page.selectOption('#tag-browser-select', OTHER_TAG_KEY);
  await page.waitForSelector('#tag-browser-results a');
  await page.waitForTimeout(1200);

  const collected = await seenSlugs(page);
  assert.deepEqual(collected, NOTEBOOK, 'a stale tag reply replaced the newer selection');
  assert.equal(await page.locator('#tag-browser-current').textContent(), OTHER_TAG_KEY);
  await page.close();
}, 120_000);

test('the static tag route is complete and usable with scripting disabled', async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  assert.equal(await page.locator('#tag-browser').isVisible(), false, 'the enhanced region is visible without scripting');
  const staticSlugs = await page.evaluate(() =>
    [
      ...new Set(
        [...document.querySelectorAll<HTMLAnchorElement>('#tag-static-list a[href^="/notes/"]')].map((link) =>
          link.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
        ),
      ),
    ],
  );
  assert.deepEqual([...staticSlugs].sort(), [...EXPECTED].sort(), 'the static tag route is incomplete');
  const pageText = (await page.locator('body').textContent()) ?? '';
  assert.ok(!pageText.includes('withheld-only'), 'a withheld-only tag surfaced on the static page');
  await context.close();
}, 120_000);
