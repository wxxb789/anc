/**
 * The lazy snapshot runtime in a real browser under the deployed CSP.
 *
 * Serves an actual build with the headers `public/_headers` declares, so the
 * Worker, the WASM import, and the snapshot fetch are exercised under
 * `worker-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, and
 * `connect-src 'self'`. A skipped run is not evidence, so these tests fail when
 * Chromium is absent rather than skipping silently. The build, the per-path
 * header rules, and the server come from `tests/support/browser-site.ts`.
 */

import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';

import {
  buildAndServe,
  removeWorkspace,
  sqliteAssetRequests,
  type RunningSite,
} from './support/browser-site.ts';

/**
 * alpha links to beta, to a markup-titled note, and to a withheld one; beta is
 * Chinese so the preview must carry its language.
 */
const CORPUS = {
  'alpha.md': '# Alpha Note\n\nEnglish alpha body. Links to [[beta]], [[markup]] and [[withheld]].\n',
  'beta.md': '---\nlanguage: zh-CN\n---\n# 测试笔记\n\n这是中文正文，用于预览。\n',
  'markup.md':
    '---\ntitle: "<i>Title</i>"\naliases: ["<em>Older"]\n---\n# Markup Title\n\nA note whose metadata only an HTML parser would treat as elements.\n',
  'withheld.md': '---\npublish: false\n---\n# Withheld Secret\n\nzzqwithheldbody\n',
};

let site: RunningSite;
let browser: Browser;

beforeAll(async () => {
  site = await buildAndServe(CORPUS);
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
});

test('ordinary reading downloads no SQLite assets and an intentional hover previews from the snapshot', async () => {
  const page = await browser.newPage();
  const requests = sqliteAssetRequests(page);
  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
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
  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
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
