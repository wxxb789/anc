/**
 * The tag window follows the reader's scroll position.
 *
 * A window that only moves when a scroll event fires cannot reach rows held by
 * a tall `before` spacer: at `scrollY 0` the viewport is inside the spacer and
 * there is no further upward event. These tests load more than a window of
 * logical rows, jump to the top, and wheel from the tail, asserting that the
 * rendered `aria-posinset` window reaches row 1 and never leaves a spacer in
 * the viewport.
 */

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';

import { TAG_WINDOW_SIZE } from '../src/lib/tag-browser-model.ts';
import { buildAndServe, removeWorkspace, type RunningSite } from './support/browser-site.ts';

const TAG_KEY = 'bulk';
const MEMBERS = 2_050;
const JUMPS = [810, 2_010] as const;

let site: RunningSite;
let browser: Browser;
let context: BrowserContext;

async function logicalSize(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(document.querySelector('#tag-browser-results [aria-setsize]')?.getAttribute('aria-setsize') ?? 0),
  );
}

async function loadUntil(page: Page, target: number): Promise<void> {
  let total = await logicalSize(page);
  while (total < target) {
    await page.evaluate(() => document.getElementById('tag-browse-more')?.click());
    await page.waitForFunction(
      (before) =>
        Number(document.querySelector('#tag-browser-results [aria-setsize]')?.getAttribute('aria-setsize') ?? 0) >
        before,
      total,
      { timeout: 15_000 },
    );
    total = await logicalSize(page);
  }
}

interface WindowState {
  positions: number[];
  setsize: number;
  firstTop: number;
  firstBottom: number;
  lastTop: number;
  innerHeight: number;
}

async function windowState(page: Page): Promise<WindowState> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('#tag-browser-results li[aria-posinset]')];
    const first = rows[0]!;
    const last = rows.at(-1)!;
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    return {
      positions: rows.map((row) => Number(row.getAttribute('aria-posinset'))),
      setsize: Number(first.getAttribute('aria-setsize')),
      firstTop: firstRect.top,
      firstBottom: firstRect.bottom,
      lastTop: lastRect.top,
      innerHeight: window.innerHeight,
    };
  });
}

function assertContiguous(state: WindowState, label: string): void {
  state.positions.forEach((position, index) => {
    assert.equal(position, state.positions[0]! + index, `${label}: positions jump: ${state.positions.join(',')}`);
  });
}

async function openTag(page: Page): Promise<void> {
  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  await page.locator('#tag-browse-start').click();
  await page.waitForFunction(() => document.querySelectorAll('#tag-browser-results li[aria-posinset]').length > 0);
}

/** Put the page at the bottom, then jump to the top in one instant scroll. */
async function jumpToTop(page: Page, target: number): Promise<WindowState> {
  await loadUntil(page, target);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(120);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(
    () => {
      const first = document.querySelector('#tag-browser-results [aria-posinset]');
      return window.scrollY === 0 && Number(first?.getAttribute('aria-posinset') ?? 0) === 1;
    },
    undefined,
    { timeout: 10_000 },
  );
  return windowState(page);
}

beforeAll(async () => {
  const corpus: Record<string, string> = {};
  for (let index = 1; index <= MEMBERS; index += 1) {
    const slug = `bulk-${String(index).padStart(4, '0')}`;
    corpus[`${slug}.md`] =
      `---\ntitle: "Bulk ${String(index).padStart(4, '0')}"\ntags: [${TAG_KEY}]\n---\n\n# ${slug}\n\nBody.\n`;
  }
  site = await buildAndServe(corpus);
  browser = await chromium.launch();
  const { defaultBrowserType: _ignored, ...profile } = devices['Pixel 7'];
  context = await browser.newContext(profile);
}, 300_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
}, 300_000);

for (const target of JUMPS) {
  test(`an instant jump to the top lands on rows 1..${TAG_WINDOW_SIZE} at ${target} logical rows`, async () => {
    const page = await context.newPage();
    await openTag(page);
    const state = await jumpToTop(page, target);
    assert.equal(state.setsize, target);
    assert.equal(state.positions[0], 1, 'the window did not reach row 1');
    assert.equal(state.positions.length, TAG_WINDOW_SIZE, `the window rendered ${state.positions.length} rows`);
    assertContiguous(state, `top ${target}`);
    assert.ok(state.firstTop < state.innerHeight, 'row 1 is below the viewport');
    assert.ok(state.firstBottom > 0, 'row 1 is above the viewport');
    await page.close();
  }, 120_000);
}

test('a continuous wheel-up run reaches row 1 without a gap or a visible spacer', async () => {
  const page = await context.newPage();
  await openTag(page);
  const target = JUMPS[0];
  await loadUntil(page, target);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(120);
  await page.mouse.move(200, 400);

  const covered = new Set<number>();
  let reachedZero = false;
  for (let step = 0; step < 80; step += 1) {
    await page.mouse.wheel(0, -900);
    // The scroll handler and the reposition are frame work; let both settle.
    await page.waitForTimeout(50);
    const state = await windowState(page);
    assert.ok(state.positions.length > 0, `step ${step}: no rows rendered`);
    assertContiguous(state, `wheel step ${step}`);
    for (const position of state.positions) covered.add(position);

    // A spacer may not be in the viewport: when rows exist on a side, the
    // rendered window must extend past the viewport edge on that side.
    if (state.positions[0]! > 1) {
      assert.ok(
        state.firstBottom <= 0,
        `wheel step ${step}: the before spacer entered the viewport (first row bottom ${state.firstBottom})`,
      );
    }
    if (state.positions.at(-1)! < state.setsize) {
      assert.ok(
        state.lastTop >= state.innerHeight,
        `wheel step ${step}: the after spacer entered the viewport (last row top ${state.lastTop})`,
      );
    }

    if ((await page.evaluate(() => window.scrollY)) === 0) {
      reachedZero = true;
      break;
    }
  }

  assert.equal(reachedZero, true, 'the wheel run did not reach scrollY 0');
  await page.waitForFunction(
    () =>
      window.scrollY === 0 &&
      Number(
        document.querySelector('#tag-browser-results [aria-posinset]')?.getAttribute('aria-posinset') ?? 0,
      ) === 1,
    undefined,
    { timeout: 10_000 },
  );
  const final = await windowState(page);
  assert.equal(final.positions[0], 1, 'the wheel run did not leave row 1 rendered');

  const ordered = [...covered].sort((a, b) => a - b);
  assert.equal(ordered[0], 1, 'the covered range does not start at row 1');
  assert.equal(ordered.at(-1), target, 'the covered range does not reach the loaded tail');
  ordered.forEach((position, index) => {
    assert.equal(position, index + 1, `the covered range has a gap at ${index + 1}`);
  });
  await page.close();
}, 180_000);
