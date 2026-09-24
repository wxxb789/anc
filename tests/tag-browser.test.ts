/**
 * Complete tag browsing in a real browser and without scripting.
 *
 * The corpus is authored here with independent expected membership, so the gate
 * does not derive its answer from `tagFacets` or `tagPage`. It is served with the
 * headers `public/_headers` declares, so the shared Worker, the WASM, and the
 * snapshot are exercised under the deployed CSP. The build and the server come
 * from `tests/support/browser-site.ts`.
 */

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, Page } from 'playwright';

import {
  buildAndServe,
  collectPageErrors,
  countWorkerTerminations,
  focusByTab,
  removeWorkspace,
  recordWorkerMessages,
  sqliteAssetRequests,
  tabTo,
  workerMessages,
  workerTerminations,
  type RunningSite,
} from './support/browser-site.ts';
import { snapshotTags } from './support/snapshot.ts';

const TAG_KEY = 'gardening';
const TAG_LABEL = 'Gardening';
const OTHER_TAG_KEY = 'notebook';
const EXPECTED = Array.from({ length: 21 }, (_, index) => `tag-${String(index + 1).padStart(2, '0')}`);
const NOTEBOOK = ['tag-01', 'tag-02', 'tag-03'];
const PAGE_SIZE = 10;

let site: RunningSite;
let browser: Browser;

async function seenSlugs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('#tag-browser-results a[href^="/notes/"]')].map(
      (link) => link.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
    ),
  );
}

/** The static route's note slugs, deduplicated, whether or not the list is hidden. */
async function slugsInStaticList(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll<HTMLAnchorElement>('#tag-static-list a[href^="/notes/"]')].map((link) =>
        link.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
      ),
    ),
  ]);
}

/** Click Load more and wait until the reply has appended at least one result. */
async function loadMore(page: Page): Promise<string[]> {
  const before = (await seenSlugs(page)).length;
  await page.locator('#tag-browse-more').click();
  await page.waitForFunction(
    (count) => document.querySelectorAll('#tag-browser-results a').length > count,
    before,
  );
  return seenSlugs(page);
}

/** Click Load more and wait for the second page's end: 21 members at 10 a page. */
async function loadSecondPage(page: Page): Promise<void> {
  const before = (await seenSlugs(page)).length;
  await page.locator('#tag-browse-more').click();
  await page.waitForFunction(
    (count) => document.querySelectorAll('#tag-browser-results a').length >= count,
    before + PAGE_SIZE,
  );
}

/** The shared runtime must be downloaded once, however many pages are read. */
function assertRuntimeFetchedOnce(requests: readonly string[]): void {
  const count = (fragment: string): number => requests.filter((url) => url.includes(fragment)).length;
  assert.equal(count('/data/site.'), 1, `the snapshot was downloaded ${count('/data/site.')} times`);
  assert.equal(requests.filter((url) => url.endsWith('.wasm')).length, 1, 'a second WASM body was fetched');
  assert.equal(count('/_astro/snapshot-worker-'), 1, 'a second Worker chunk was fetched');
}

/** A recorded `byTag` request, as the page posted it. */
interface ByTagRequest {
  tagKey: string;
  cursor: string | null;
}

beforeAll(async () => {
  const corpus: Record<string, string> = {
    'island.md': '# Island\n\nNo tags, no links.\n',
    'secret.md': '---\npublish: false\ntags: [withheld-only]\n---\n\n# Secret\n\nNot published.\n',
  };
  for (let index = 1; index <= EXPECTED.length; index += 1) {
    const slug = `tag-${String(index).padStart(2, '0')}`;
    const label = index % 2 === 0 ? 'gardening' : 'Gardening';
    const tags = index <= NOTEBOOK.length ? `[${label}, notebook]` : `[${label}]`;
    const language = index === 7 ? 'language: zh-CN\n' : '';
    // Titles reverse slug order, so static title order differs from cursor order.
    const title = `Title ${String(EXPECTED.length - index).padStart(2, '0')}`;
    corpus[`${slug}.md`] =
      `---\ntitle: "${title}"\n${language}tags: ${tags}\n---\n\n# ${title}\n\nBody for ${slug}.\n`;
  }

  site = await buildAndServe(corpus);
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
}, 180_000);

test('the tag chooser enumerates every matching note across pages, in cursor order', async () => {
  const page = await browser.newPage();
  await page.goto(`${site.origin}/tags/`, { waitUntil: 'load' });
  await page.selectOption('#tag-browser-select', TAG_KEY);
  await page.waitForSelector('#tag-browser-results a');

  let collected = await seenSlugs(page);
  const pageSizes: number[] = [collected.length];
  while (await page.locator('#tag-browse-more').isVisible()) {
    const next = await loadMore(page);
    pageSizes.push(next.length - collected.length);
    collected = next;
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
  await recordWorkerMessages(page, 'byTag');
  const dispatches = async (): Promise<number> => (await workerMessages(page)).length;

  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  await page.click('#tag-browse-start');
  await page.waitForSelector('#tag-browser-results a');
  assert.equal(await dispatches(), 1, 'the first page should be one byTag request');

  // Two synchronous clicks, the way a double click arrives: the button marks
  // itself busy inside the first handler, so the second click hits a busy control
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
  await page.goto(`${site.origin}/tags/`, { waitUntil: 'load' });
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
  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  assert.equal(await page.locator('#tag-browser').isVisible(), false, 'the enhanced region is visible without scripting');
  const staticSlugs = await slugsInStaticList(page);
  assert.deepEqual(staticSlugs.sort(), [...EXPECTED].sort(), 'the static tag route is incomplete');
  const pageText = (await page.locator('body').textContent()) ?? '';
  assert.ok(!pageText.includes('withheld-only'), 'a withheld-only tag surfaced on the static page');
  await context.close();
}, 120_000);

test('a preview and a tag query share one Worker, one snapshot, and one WASM body', async () => {
  const page = await browser.newPage();
  const requests = sqliteAssetRequests(page);
  await countWorkerTerminations(page);
  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  const panel = page.locator('#link-preview');
  // A static card link on this very page is previewable, so the preview starts
  // the shared runtime before the tag query asks for its first page.
  await page.locator('#tag-static-list a[href="/notes/tag-01/"]').first().hover();
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  await page.mouse.move(0, 0);
  await panel.waitFor({ state: 'hidden', timeout: 5_000 });

  await page.click('#tag-browse-start');
  await page.waitForSelector('#tag-browser-results a');
  await loadSecondPage(page);

  assertRuntimeFetchedOnce(requests);
  assert.equal(await workerTerminations(page), 0, 'the page replaced its Worker instead of sharing it');
  await page.close();
}, 120_000);

test('a tag used only by a withheld note reaches neither the snapshot nor the chooser', async () => {
  // The corpus above tags the withheld note, so a regression that emitted
  // unused tags would surface here rather than in an all-published corpus.
  const keys = snapshotTags(site.dist).map((tag) => tag.key);
  assert.deepEqual(keys, [TAG_KEY, OTHER_TAG_KEY], 'the snapshot carries a tag no published note uses');

  const page = await browser.newPage();
  await page.goto(`${site.origin}/tags/`, { waitUntil: 'load' });
  const options = await page
    .locator('#tag-browser-select option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  assert.deepEqual(
    options,
    ['', TAG_KEY, OTHER_TAG_KEY],
    'the chooser offered a key the snapshot does not carry',
  );

  const missing = await page.goto(`${site.origin}/tags/withheld-only/`, { waitUntil: 'load' });
  assert.equal(missing?.status(), 404, 'a withheld-only tag produced a static route');
  await page.close();
}, 120_000);

test('tag browsing downloads the shared runtime once, and not before intent', async () => {
  const page = await browser.newPage();
  const requests = sqliteAssetRequests(page);
  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  // The enhanced region unhides when the script runs, and the static list must
  // make the page genuinely scrollable: otherwise "scrolling does not prefetch"
  // would pass without a scroll having happened.
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#tag-browser')?.hidden === false);
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight,
  );
  assert.equal(scrollable, true, 'the tag page does not scroll, so the zero-request probe measured nothing');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  // `requests.length` rather than `assert.deepEqual(requests, [])`: the
  // assertion's `asserts actual is T` signature would narrow the array to
  // `never[]` and make the later `.filter` calls type errors.
  assert.equal(requests.length, 0, 'loading and scrolling the tag page fetched the SQLite runtime');

  await page.click('#tag-browse-start');
  await page.waitForSelector('#tag-browser-results a');
  await loadSecondPage(page);
  // 21 members at 10 a page: the second page is another Worker request over the
  // same document. The snapshot, the WASM body, and the Worker chunk are each
  // downloaded exactly once, and the continuation must not re-download any.
  assertRuntimeFetchedOnce(requests);
  await page.close();
}, 120_000);

test('a failed snapshot leaves the complete static route on screen', async () => {
  const page = await browser.newPage();
  const errors = collectPageErrors(page);
  await page.route('**/data/site.*', (route) => route.abort());
  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  await page.click('#tag-browse-start');
  const failedSentence = await page.locator('#tag-browser').getAttribute('data-tag-browse-failed');
  assert.ok(failedSentence, '#tag-browser does not carry the failure sentence to render');
  await page.waitForFunction(
    (expected) => document.querySelector('#tag-browser-status')?.textContent === expected,
    failedSentence,
    { timeout: 10_000 },
  );

  const staticList = page.locator('#tag-static-list');
  assert.equal(await staticList.isVisible(), true, 'the static list stayed hidden after the runtime failed');
  const staticSlugs = await slugsInStaticList(page);
  assert.deepEqual(staticSlugs.sort(), [...EXPECTED].sort(), 'the fallback list is incomplete');
  assert.equal((await seenSlugs(page)).length, 0, 'a failed runtime rendered results');
  assert.deepEqual(errors, [], 'the failure path raised a page error');
  await page.close();
}, 120_000);

test('a keyboard reader can choose a tag and open a result', async () => {
  const page = await browser.newPage();
  await page.goto(`${site.origin}/tags/`, { waitUntil: 'load' });
  assert.equal(await tabTo(page, '#tag-browser-select'), true, 'the chooser was not reachable by Tab');
  // The chooser's first real option is the first facet in key order.
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('#tag-browser-results a');
  assert.equal(
    await page.locator('#tag-browser-current').textContent(),
    TAG_LABEL,
    'the arrow key did not select the first facet',
  );
  assert.equal(await focusByTab(page, '/notes/tag-01/'), true, 'the first result was not reachable by Tab');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/notes/tag-01/');
  await page.close();
}, 120_000);

test('the first and next pages are operable from the keyboard alone', async () => {
  const page = await browser.newPage();
  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  assert.equal(await tabTo(page, '#tag-browse-start'), true, 'the start button was not reachable by Tab');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#tag-browser-results a');
  assert.equal(await tabTo(page, '#tag-browse-more'), true, 'Load more was not reachable by Tab');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (count) => document.querySelectorAll('#tag-browser-results a').length === count,
    PAGE_SIZE * 2,
  );
  // Focus stays on the control the reader pressed. Disabling the focused
  // button while the reply is in flight drops focus to <body>, which sends a
  // keyboard reader back to the top of the page on every continuation.
  assert.equal(
    await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName),
    'tag-browse-more',
    'a continuation took keyboard focus away from Load more',
  );
  // The last page hides the button; focus moves to the first result it added
  // rather than falling to <body>.
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (count) => document.querySelectorAll('#tag-browser-results a').length === count,
    EXPECTED.length,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('href') ?? document.activeElement?.tagName),
    `/notes/${EXPECTED[PAGE_SIZE * 2]}/`,
    'the last continuation hid Load more and dropped focus instead of moving it to the first new result',
  );
  await page.close();
}, 120_000);

test('the enhanced list and the static list agree on the same membership', async () => {
  const page = await browser.newPage();
  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  await page.click('#tag-browse-start');
  await page.waitForSelector('#tag-browser-results a');
  // Selection must hide the static list, not merely sit beside it: the failure
  // test's "the static list returns" wording only means something if the
  // successful path takes it away.
  assert.equal(
    await page.locator('#tag-static-list').isVisible(),
    false,
    'the static route stayed visible under the enhanced list',
  );
  let collected = await seenSlugs(page);
  while (await page.locator('#tag-browse-more').isVisible()) {
    collected = await loadMore(page);
  }
  // The static list stays in the DOM behind the enhanced region; reading it
  // here compares the two renderings of one snapshot in one document.
  const staticSlugs = await slugsInStaticList(page);
  assert.deepEqual([...collected].sort(), [...EXPECTED].sort());
  assert.deepEqual(staticSlugs.sort(), [...collected].sort(), 'static and enhanced lists disagree');
  await page.close();
}, 120_000);

test('switching tags after a continuation starts the new tag at its first page', async () => {
  const page = await browser.newPage();
  await recordWorkerMessages(page, 'byTag');
  // The raw message carries an id, the operation, and the page size; the two
  // fields this test is about are normalized out of it.
  const requests = async (): Promise<ByTagRequest[]> =>
    (await workerMessages<Partial<ByTagRequest>>(page)).map((request) => ({
      tagKey: request.tagKey ?? '',
      cursor: request.cursor ?? null,
    }));

  await page.goto(`${site.origin}/tags/`, { waitUntil: 'load' });
  await page.selectOption('#tag-browser-select', TAG_KEY);
  await page.waitForSelector('#tag-browser-results a');
  // Advance the first tag to a real, non-null continuation...
  await loadSecondPage(page);
  assert.deepEqual(
    (await requests()).map((request) => request.cursor),
    [null, 'tag-10'],
    'the continuation did not resume from the last returned slug',
  );

  // ...then switch subjects. The new tag must start at page one rather than
  // inherit the old tag's cursor; the delayed-route test above owns the
  // late-reply half of the same property. The label is written after the new
  // reply's results are appended, so this waits for the state read below.
  await page.selectOption('#tag-browser-select', OTHER_TAG_KEY);
  await page.waitForFunction(
    (expected) => document.querySelector('#tag-browser-current')?.textContent === expected,
    OTHER_TAG_KEY,
  );
  assert.deepEqual(await seenSlugs(page), NOTEBOOK, 'the new tag did not start from its first page');
  assert.deepEqual(
    (await requests()).at(-1),
    { tagKey: OTHER_TAG_KEY, cursor: null },
    'the switch reused the previous tag continuation',
  );
  assert.equal(await page.locator('#tag-browser-current').textContent(), OTHER_TAG_KEY);
  await page.close();
}, 120_000);
