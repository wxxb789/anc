/**
 * The windowed enhanced tag list: a bounded DOM over a complete logical list.
 *
 * `src/scripts/tag-browser.ts` renders only a window of the rows it has loaded,
 * because page-clock dispatch grew with the rendered list (10.1 ms at 100 rows,
 * 57.2 ms at 1,000 — the 0008 campaign). The bound is a rendering decision, so
 * these are the properties a reader keeps from it, asserted in a real browser
 * over a corpus larger than one window:
 *
 * - the DOM stays bounded while the logical collection keeps growing;
 * - every rendered row carries `aria-setsize` (the tag's complete membership,
 *   which does not change as pages load) and `aria-posinset` (its 1-based
 *   position in that collection), and those positions are contiguous and end at
 *   the newest loaded row — the APG lazy-load contract;
 * - the visible number equals the logical position, not the window-local one,
 *   because a windowed `<ol>` would otherwise renumber itself at every shift;
 * - the released rows are represented by one spacer and nothing else, and the
 *   spacer carries no position;
 * - "Load more" keeps keyboard focus on itself, and the final page moves it to
 *   the first row that page added rather than to `<body>`;
 * - scrolling back re-renders the earlier rows and leaves positions correct.
 *
 * The corpus is authored here with an independent expectation (145 members at
 * 10 a page) so the gate does not ask the browser what its own answer is.
 */

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, Page } from 'playwright';

import { TAG_WINDOW_SIZE } from '../src/lib/tag-browser-model.ts';
import { buildAndServe, removeWorkspace, type RunningSite } from './support/browser-site.ts';

const TAG_KEY = 'bulk';
const MEMBERS = 145;
const PAGE_SIZE = 10;
const WINDOW = TAG_WINDOW_SIZE;
/** Pages after the first one, to reach 140 logical rows: 13 more at 10 a page. */
const CONTINUATIONS = 13;
const BEFORE_LAST = PAGE_SIZE * (CONTINUATIONS + 1);

let site: RunningSite;
let browser: Browser;

/** The list's rendered rows, in DOM order, with the attributes under test. */
async function rows(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#tag-browser-results > li')].map((item) => ({
      posinset: item.getAttribute('aria-posinset'),
      setsize: item.getAttribute('aria-setsize'),
      hidden: item.getAttribute('aria-hidden'),
      spacer: item.dataset['windowSpacer'] ?? null,
      href: item.querySelector('a')?.getAttribute('href') ?? null,
    })),
  );
}

/** Start a fixed tag page and wait for the first page's rows. */
async function openTag(page: Page): Promise<void> {
  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  await page.locator('#tag-browse-start').click();
  await page.waitForSelector('#tag-browser-results [aria-posinset]');
}

/** The newest loaded logical position, which is the only thing a page changes. */
async function loadedPosition(page: Page): Promise<number> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#tag-browser-results [aria-posinset]')].reduce(
      (max, item) => Math.max(max, Number(item.getAttribute('aria-posinset') ?? 0)),
      0,
    ),
  );
}

/** One continuation, waiting for the logical collection to grow. */
async function loadMore(page: Page): Promise<void> {
  const before = await loadedPosition(page);
  await page.locator('#tag-browse-more').click();
  await page.waitForFunction(
    (count) =>
      [...document.querySelectorAll('#tag-browser-results [aria-posinset]')].some(
        (item) => Number(item.getAttribute('aria-posinset') ?? 0) > count,
      ),
    before,
  );
}

/**
 * Assert the window's shape for a loaded total and return its positions: a
 * bounded DOM, one `setsize` (the tag's membership, always), contiguous absolute
 * positions, and one hidden spacer per released range. A tail window must also
 * end at the newest loaded row; a window shifted back by the reader ends earlier
 * and carries a bottom spacer.
 */
async function assertWindow(page: Page, loaded: number, endAtNewest = true): Promise<number[]> {
  const list = await rows(page);
  const numbered = list.filter((row) => row.posinset !== null);
  const positions = numbered.map((row) => Number(row.posinset));
  assert.ok(numbered.length > 0, 'no numbered rows rendered');
  assert.ok(numbered.length <= WINDOW, `the DOM kept ${numbered.length} rows, above the ${WINDOW}-row window`);
  for (const row of numbered) {
    assert.equal(row.setsize, String(MEMBERS), `a row reported setsize ${row.setsize}, not the tag's ${MEMBERS} members`);
  }
  positions.forEach((position, index) => {
    assert.equal(position, (positions[0] ?? 0) + index, `positions jumped: ${positions.join(',')}`);
  });
  if (endAtNewest) assert.equal(positions.at(-1), loaded, 'the window does not end at the newest loaded logical row');

  const spacers = list.filter((row) => row.spacer !== null);
  const releasedAbove = (positions[0] ?? 1) > 1;
  const releasedBelow = (positions.at(-1) ?? 0) < loaded;
  if (releasedAbove) {
    assert.equal(list[0]?.spacer, 'before', 'the released range above the window has no spacer');
  } else {
    assert.notEqual(list[0]?.spacer, 'before', 'a spacer rendered above a window that starts at the first row');
  }
  if (releasedBelow) {
    assert.equal(list.at(-1)?.spacer, 'after', 'the released range below the window has no spacer');
  } else {
    assert.notEqual(list.at(-1)?.spacer, 'after', 'a spacer sits below a window that ends at the newest row');
  }
  assert.equal(
    spacers.length,
    Number(releasedAbove) + Number(releasedBelow),
    `${spacers.length} spacers rendered for ${releasedAbove ? 'a' : 'no'} released range above and ${releasedBelow ? 'a' : 'no'} below`,
  );
  for (const spacer of spacers) assert.equal(spacer.hidden, 'true', 'a spacer is exposed to assistive technology');
  assert.equal(
    list.filter((row) => row.posinset === null && row.spacer === null).length,
    0,
    'a rendered row carries neither a position nor the spacer marker',
  );
  return positions;
}

/**
 * The visible number is the logical position: the list's counter starts where
 * the window does, and the browser never renumbers from 1 inside the window.
 */
async function assertNumbering(page: Page, firstPosition: number): Promise<void> {
  const state = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('#tag-browser-results')!;
    return {
      counterReset: getComputedStyle(list).counterReset,
      start: list.style.getPropertyValue('--tag-window-start'),
    };
  });
  assert.equal(state.start, String(firstPosition - 1), `the counter variable is ${state.start}, not ${firstPosition - 1}`);
  assert.equal(
    state.counterReset,
    `tag-row ${firstPosition - 1}`,
    `the list counter restarts at ${state.counterReset}; the window would renumber visibly`,
  );
}

beforeAll(async () => {
  const corpus: Record<string, string> = {};
  for (let index = 1; index <= MEMBERS; index += 1) {
    const slug = `bulk-${String(index).padStart(3, '0')}`;
    corpus[`${slug}.md`] = `---\ntitle: "Bulk ${String(index).padStart(3, '0')}"\ntags: [${TAG_KEY}]\n---\n\n# ${slug}\n\nBody.\n`;
  }
  site = await buildAndServe(corpus);
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
}, 240_000);

test('the rendered window stays bounded while the logical list grows', async () => {
  const page = await browser.newPage();
  await openTag(page);
  await assertWindow(page, PAGE_SIZE);

  let loaded = PAGE_SIZE;
  for (let index = 0; index < CONTINUATIONS; index += 1) {
    await loadMore(page);
    loaded += PAGE_SIZE;
    await assertWindow(page, loaded);
  }
  assert.equal(loaded, BEFORE_LAST, 'the continuations did not reach the expected logical count');

  // The last page carries five members and exhausts the cursor.
  await loadMore(page);
  const positions = await assertWindow(page, MEMBERS);
  assert.equal(positions.length, WINDOW, `the full window rendered ${positions.length} rows`);
  assert.equal(positions[0], MEMBERS - WINDOW + 1, 'the window did not slide to the newest rows');
  await assertNumbering(page, positions[0]!);
  assert.equal(await page.locator('#tag-browse-more').isHidden(), true, 'Load more survived the last page');
  await page.close();
});

test('the announced set size is the tag, not the rows loaded so far', async () => {
  // A screen reader reads the first row's `setsize` for the list announcement
  // (Orca 46: scripts/web/speech_generator.py `_generateNumberOfChildren`). A
  // loaded count would announce a 145-note tag as a 10-note list, then change
  // that number on every continuation.
  const page = await browser.newPage();
  await openTag(page);
  const first = (await rows(page)).filter((row) => row.posinset !== null);
  assert.equal(first.length, PAGE_SIZE, `the first page rendered ${first.length} rows`);
  for (const row of first) {
    assert.equal(row.setsize, String(MEMBERS), `the first page announced setsize ${row.setsize}, not ${MEMBERS}`);
  }
  await loadMore(page);
  const second = (await rows(page)).filter((row) => row.posinset !== null);
  assert.equal(second.length, PAGE_SIZE * 2, `the second page rendered ${second.length} rows`);
  for (const row of second) {
    assert.equal(row.setsize, String(MEMBERS), `a continuation changed the announced size to ${row.setsize}`);
  }
  await page.close();
});

test('the last page moves focus to the first row it added, never to body', async () => {
  const page = await browser.newPage();
  await openTag(page);
  for (let index = 0; index < CONTINUATIONS; index += 1) await loadMore(page);

  // The next continuation is the last one: it exhausts the cursor and hides the
  // button, so the keyboard reader must land on the first row it added.
  await page.locator('#tag-browse-more').focus();
  await page.locator('#tag-browse-more').click();
  await page.waitForFunction(() => document.getElementById('tag-browse-more')?.hasAttribute('hidden') === true);

  const after = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      isBody: active === document.body || active === document.documentElement,
      posinset: active?.closest('[aria-posinset]')?.getAttribute('aria-posinset') ?? null,
    };
  });
  assert.equal(after.isBody, false, 'the last continuation dropped focus to <body>');
  assert.equal(after.posinset, String(BEFORE_LAST + 1), `focus landed on position ${after.posinset}`);
  await page.close();
});

test('scrolling back renders the earlier rows and keeps positions contiguous', async () => {
  const page = await browser.newPage();
  await openTag(page);
  for (let index = 0; index < CONTINUATIONS; index += 1) await loadMore(page);
  const atTail = await assertWindow(page, BEFORE_LAST);
  assert.equal(atTail[0], BEFORE_LAST - WINDOW + 1);

  // Down first, so the following scroll up is the reader's own movement; the
  // handler ignores a delta under 2 px and reads direction from the change.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(120);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(
    () => {
      const first = document.querySelector('#tag-browser-results [aria-posinset]');
      return window.scrollY === 0 && Number(first?.getAttribute('aria-posinset') ?? 0) === 1;
    },
    undefined,
  );

  const positions = await assertWindow(page, BEFORE_LAST, false);
  assert.ok(
    (positions.at(-1) ?? 0) < BEFORE_LAST,
    'the shifted window still ends at the newest row, so it did not move back',
  );
  assert.equal(positions[0], 1, 'scrollTo(0) did not reach the first row');
  await assertNumbering(page, positions[0]!);
  await page.close();
});
