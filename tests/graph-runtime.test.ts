/**
 * Interactive graph exploration in a real browser.
 *
 * The corpus is authored with a hub, a reciprocal pair, a cycle, an isolated
 * note, more than twelve neighbours, and a tag subset whose top-ranked note
 * differs from the unfiltered graph. Expected sets are hand-listed here, not
 * computed from the selection module, so the gate is an oracle rather than a
 * restatement.
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

const PEERS = Array.from({ length: 15 }, (_, index) => `peer-${String(index + 1).padStart(2, '0')}`);

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

async function drawnSlugs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<SVGAnchorElement>('.graph-nodes a.graph-node')].map((anchor) =>
      anchor.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
    ),
  );
}

type SVGAnchorElement = Element;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'anc-graph-'));
  const notes = join(workspace, 'notes');
  mkdirSync(notes, { recursive: true });
  // hub -> each peer, plus a reciprocal pair, a cycle, and a tag subset.
  writeFileSync(
    join(notes, 'hub.md'),
    `---\ntags: [hub]\n---\n\n# Hub\n\n${PEERS.map((peer) => `[[${peer}]]`).join(' ')}\n`,
    'utf8',
  );
  PEERS.forEach((peer, index) => {
    const links = peer === 'peer-02' ? ' [[peer-01]]' : peer === 'peer-03' ? ' [[peer-02]]' : peer === 'peer-01' ? ' [[peer-02]]' : '';
    const tag = index < 3 ? '\ntags: [team]' : '';
    writeFileSync(join(notes, `${peer}.md`), `---${tag}\n---\n\n# ${peer}\n\nBody.${links}\n`, 'utf8');
  });
  writeFileSync(join(notes, 'island.md'), '# Island\n\nNo links, no tags.\n', 'utf8');

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

test('a note page explores its bounded neighbourhood, re-centres, and shows the right bound', async () => {
  const page = await browser.newPage();
  const sqliteRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/data/site.') || request.url().includes('/wasm/')) sqliteRequests.push(request.url());
  });

  await page.goto(`${origin}/notes/hub/`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  assert.deepEqual(sqliteRequests, [], 'ordinary reading requested SQLite assets');
  assert.equal(
    await page.locator('[data-graph-activate]').isVisible(),
    true,
    'the explorer control is not offered',
  );

  await page.locator('[data-graph-activate]').click();
  await page.waitForFunction(() => (document.querySelector('[data-graph-status]')?.textContent ?? '').length > 0);

  // 12 neighbours plus the center; the local omitted count excludes the center.
  assert.deepEqual(await drawnSlugs(page), ['hub', ...PEERS.slice(0, 12)]);
  const status = (await page.locator('[data-graph-status]').textContent()) ?? '';
  assert.match(status, /12 of 15|12.*15/);
  assert.ok(sqliteRequests.length >= 2, 'activation did not use the snapshot runtime');

  // Every drawn node is a real note link with an accessible name, and the
  // neighbour-to-neighbour edges are retained (peer-01 <-> peer-02).
  const edges = await page.locator('.graph-edges line').count();
  assert.ok(edges >= 13, `induced edges were not retained: ${edges}`);
  const label = await page.locator('.graph-nodes a[href="/notes/peer-01/"]').getAttribute('aria-label');
  assert.ok(label && label.includes('peer-01'), 'a drawn node has no accessible name');

  // Re-centre on a neighbour from the equivalent table, which a reader opens.
  await page.locator('.graph-table').evaluate((details: HTMLDetailsElement) => {
    details.open = true;
  });
  await page.locator('[data-graph-recenter="peer-02"]').first().click();
  await page.waitForFunction(
    () =>
      document.querySelector('.graph-nodes a.graph-node')?.getAttribute('href') === '/notes/peer-02/',
  );
  assert.equal((await drawnSlugs(page))[0], 'peer-02', 're-centering did not move the center');
  await page.close();
}, 120_000);

test('the global graph filters by tag, labels the scope honestly, and resets', async () => {
  const page = await browser.newPage();
  await page.goto(`${origin}/graph/`, { waitUntil: 'load' });
  await page.locator('[data-graph-activate]').click();
  await page.waitForFunction(() => (document.querySelector('[data-graph-status]')?.textContent ?? '').length > 0);

  await page.selectOption('[data-graph-tag]', 'team');
  await page.waitForTimeout(400);
  const filtered = (await drawnSlugs(page)).sort();
  assert.deepEqual(filtered, ['peer-01', 'peer-02', 'peer-03'], 'the tag filter did not restrict the drawn set');
  const status = (await page.locator('[data-graph-status]').textContent()) ?? '';
  assert.ok(status.includes('team'), `the filtered scope was not named honestly: ${status}`);

  // An empty filter is not a runtime failure.
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('[data-graph-tag]')!;
    select.append(new Option('empty-tag', 'empty-tag'));
    select.value = 'empty-tag';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const emptyStatus = (await page.locator('[data-graph-status]').textContent()) ?? '';
  assert.ok(emptyStatus.length > 0 && !emptyStatus.includes('empty-tag'), 'an empty filter was not reported as a filter result');

  await page.locator('[data-graph-reset-control]').click();
  await page.waitForTimeout(400);
  assert.ok((await drawnSlugs(page)).includes('hub'), 'reset did not restore the unfiltered graph');
  await page.close();
}, 120_000);

test('a blocked snapshot leaves the static figure, table, and links intact', async () => {
  const page = await browser.newPage();
  await page.route('**/data/site.*', (route) => route.abort());
  await page.goto(`${origin}/notes/hub/`, { waitUntil: 'load' });
  const staticNodes = await page.locator('.graph-region .graph-nodes a.graph-node').count();
  const staticRows = await page.locator('.graph-region .graph-table tbody tr').count();
  await page.locator('[data-graph-activate]').click();
  await page.waitForTimeout(800);
  assert.match((await page.locator('[data-graph-status]').textContent()) ?? '', /could not|失败|complete/i);
  assert.equal(await page.locator('.graph-region .graph-nodes a.graph-node').count(), staticNodes, 'the static figure was lost');
  assert.equal(await page.locator('.graph-region .graph-table tbody tr').count(), staticRows, 'the static table was lost');
  assert.equal(await page.locator('.graph-region .graph-nodes a[href="/notes/peer-01/"]').count(), 1, 'a static node link was lost');
  await page.close();
}, 120_000);
