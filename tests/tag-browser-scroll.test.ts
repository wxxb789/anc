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

/**
 * A second tag whose rows rewrap when the viewport widens. Every title has the
 * same character length, so the rows are uniform at a given width and the
 * reference geometry is a single measured height.
 */
const RESIZE_TAG = 'resize';
const RESIZE_MEMBERS = 400;
const RESIZE_OLD_WIDTH = 412;
const RESIZE_NEW_WIDTH = 900;
const RESIZE_HEIGHT = 839;
const RESIZE_PHRASE = 'a viewport width change leaves every measured row height behind';

function resizeTitle(index: number): string {
  return `Resize ${String(index).padStart(4, '0')} — ${RESIZE_PHRASE}`;
}

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

interface RowGeometry {
  position: number;
  setsize: number;
  top: number;
  bottom: number;
  height: number;
}

interface SpacerGeometry {
  which: string;
  top: number;
  bottom: number;
}

interface ListGeometry {
  scrollY: number;
  innerHeight: number;
  /** The list's content box top in document coordinates: where row 1 starts. */
  origin: number;
  rows: RowGeometry[];
  spacers: SpacerGeometry[];
  windowStart: string;
}

async function listGeometry(page: Page): Promise<ListGeometry> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('#tag-browser-results')!;
    const style = getComputedStyle(list);
    const box = list.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      origin:
        box.top + window.scrollY + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop),
      rows: [...list.querySelectorAll<HTMLElement>('li[aria-posinset]')].map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          position: Number(row.getAttribute('aria-posinset')),
          setsize: Number(row.getAttribute('aria-setsize')),
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
        };
      }),
      spacers: [...list.querySelectorAll<HTMLElement>('li[data-window-spacer]')].map((spacer) => {
        const rect = spacer.getBoundingClientRect();
        return { which: spacer.dataset['windowSpacer'] ?? '', top: rect.top, bottom: rect.bottom };
      }),
      windowStart: list.style.getPropertyValue('--tag-window-start'),
    };
  });
}

/** A rendered row covers the viewport top and no spacer crosses the viewport. */
function settledAtViewport(state: ListGeometry): boolean {
  const covered = state.rows.some((row) => row.top <= 0 && row.bottom > 0);
  const clear = state.spacers.every(
    (spacer) => spacer.bottom <= 0.5 || spacer.top >= state.innerHeight - 0.5,
  );
  return covered && clear;
}

/** Let the scroll handler and its anchor correction finish, then read once. */
async function settle(page: Page, timeout = 4_000): Promise<ListGeometry> {
  const deadline = Date.now() + timeout;
  let state = await listGeometry(page);
  let previousScrollY = state.scrollY;
  let stable = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(50);
    state = await listGeometry(page);
    if (state.scrollY === previousScrollY) stable += 1;
    else stable = 0;
    previousScrollY = state.scrollY;
    if (settledAtViewport(state) && stable >= 2) break;
  }
  return state;
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

async function openTag(page: Page, key: string = TAG_KEY): Promise<void> {
  await page.goto(`${site.origin}/tags/${key}/`, { waitUntil: 'load' });
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
  for (let index = 1; index <= RESIZE_MEMBERS; index += 1) {
    const slug = `resize-${String(index).padStart(4, '0')}`;
    corpus[`${slug}.md`] =
      `---\ntitle: "${resizeTitle(index)}"\ntags: [${RESIZE_TAG}]\n---\n\n# ${slug}\n\nBody.\n`;
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

/**
 * A width change rewraps every row, so the cached heights and the Fenwick
 * index built over them are both invalid. The index must be usable again
 * before the next query: a reader whose viewport sits inside a released range
 * asks the descent "which row is at this offset", and a cleared index used to
 * answer row 0 at every offset — rendering the head of the list far above the
 * reader and leaving the spacer that was under them on screen.
 *
 * The window is left at the loaded tail (the only released region a settled
 * window has), the viewport is then widened — every row relaid out, the scroll
 * offset unchanged — and one jump lands the viewport inside the released
 * range's spacer. The resize may or may not schedule a sync of its own: on the
 * cleared index that pass only invalidates, so the jump's pass is the one that
 * queries, and it must not read the cleared index.
 */
test('a viewport width change leaves the position index usable for the next jump', async () => {
  // The shared context is a phone, where a viewport change is emulated; this
  // test resizes an ordinary desktop viewport instead.
  const resizeContext = await browser.newContext({
    viewport: { width: RESIZE_OLD_WIDTH, height: RESIZE_HEIGHT },
  });
  const page = await resizeContext.newPage();
  try {
    await openTag(page, RESIZE_TAG);
    await loadUntil(page, RESIZE_MEMBERS);
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    const tail = await settle(page);
    assert.equal(tail.rows.at(-1)?.position, RESIZE_MEMBERS, 'the window did not settle at the loaded tail');

    const oldHeight = tail.rows[0]!.height;
    const releasedStart = tail.rows[0]!.position - 1;
    assert.ok(releasedStart > 0, 'the tail window released no rows above it');
    // The reference geometry is uniform rows packed from the list's content
    // top. Confirm that model against the settled window before resizing, so
    // the expectation below is a measurement rather than a guess.
    assert.ok(
      Math.abs(tail.rows[0]!.top + tail.scrollY - (tail.origin + releasedStart * oldHeight)) <= 1,
      'the settled window does not start where uniform rows put it',
    );
    const tailSpacer = tail.spacers.find((spacer) => spacer.which === 'before');
    assert.ok(tailSpacer, 'the released range above the tail window has no spacer');
    assert.ok(
      tailSpacer.bottom - tailSpacer.top > 2 * tail.innerHeight,
      'the released range is not taller than the viewport',
    );

    await page.setViewportSize({ width: RESIZE_NEW_WIDTH, height: RESIZE_HEIGHT });
    await page.waitForTimeout(250);

    const resized = await listGeometry(page);
    const newHeight = resized.rows[0]!.height;
    assert.ok(
      Math.abs(newHeight - oldHeight) > 1,
      `the rows stayed ${oldHeight}px tall across the width change; the corpus does not rewrap`,
    );
    for (const row of resized.rows) {
      assert.ok(
        Math.abs(row.height - newHeight) <= 0.5,
        `rows are not uniform after the resize (${row.height}px against ${newHeight}px)`,
      );
    }
    assert.ok(
      Math.abs(resized.rows[1]!.top - resized.rows[0]!.top - newHeight) <= 0.5,
      'consecutive rows are not packed at one row height',
    );

    const releasedRows = resized.rows[0]!.position - 1;
    assert.ok(releasedRows > 0, 'the window lost its released range across the width change');
    const spacer = resized.spacers.find((candidate) => candidate.which === 'before');
    assert.ok(spacer, 'the released range lost its spacer across the width change');
    // Mid-row of the released range in the new geometry: an offset the reader
    // can hold, inside the spacer that still stands for those rows.
    const target = resized.origin + (releasedRows / 2 + 0.5) * newHeight;
    const spacerTop = spacer.top + resized.scrollY;
    const spacerBottom = spacer.bottom + resized.scrollY;
    assert.ok(
      target > spacerTop && target < spacerBottom,
      `the jump target ${target} is outside the released range (${spacerTop}..${spacerBottom})`,
    );

    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), target);
    const state = await settle(page);

    const positions = state.rows.map((row) => row.position);
    assert.ok(positions.length > 0, 'no numbered rows rendered');
    assert.ok(positions.length <= TAG_WINDOW_SIZE, `the DOM kept ${positions.length} rows`);
    positions.forEach((position, index) => {
      assert.equal(position, positions[0]! + index, `positions jumped: ${positions.join(',')}`);
    });
    for (const row of state.rows) {
      assert.equal(row.setsize, RESIZE_MEMBERS, `a row reported setsize ${row.setsize}`);
    }
    assert.equal(
      state.windowStart,
      String(positions[0]! - 1),
      `the counter variable is ${state.windowStart}, not ${positions[0]! - 1}`,
    );
    assert.ok(
      positions[0]! > 1,
      `the window jumped to the head of the list after the width change (rows ${positions[0]}..${positions.at(-1)}, ` +
        `scrollY ${state.scrollY.toFixed(1)}, spacers ${state.spacers.map((candidate) => `${candidate.which} ${candidate.top.toFixed(0)}..${candidate.bottom.toFixed(0)}`).join(', ')})`,
    );
    for (const candidate of state.spacers) {
      assert.ok(
        candidate.bottom <= 0.5 || candidate.top >= state.innerHeight - 0.5,
        `the ${candidate.which} spacer intersects the viewport (${candidate.top}..${candidate.bottom})`,
      );
    }
    const covering = state.rows.find((row) => row.top <= 0 && row.bottom > 0);
    const expected = Math.floor((state.scrollY - resized.origin) / newHeight);
    assert.ok(covering, 'no rendered row covers the viewport top; a spacer is under the reader');
    assert.equal(
      covering.position,
      expected + 1,
      `row ${covering.position} covers the viewport top instead of row ${expected + 1} ` +
        `(scrollY ${state.scrollY.toFixed(1)}, ${newHeight}px rows, window ${positions[0]}..${positions.at(-1)})`,
    );
  } finally {
    await resizeContext.close();
  }
}, 180_000);
