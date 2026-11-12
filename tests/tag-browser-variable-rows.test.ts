/**
 * The tag window positions itself from the rows it actually rendered.
 *
 * The list permits titles to wrap, so rows are not one uniform height. A window
 * that divides a scroll offset by a single sampled `rowHeight` throws the
 * viewport into the wrong logical row once a mixture of short and wrapped
 * titles exists: the spacer can enter the viewport, and the anchor correction
 * uses the same wrong index. This builds a corpus larger than `TAG_WINDOW_SIZE`
 * whose titles produce four distinct measured heights, derives the true logical
 * offsets from the complete static route, then jumps into tall rows and mixed
 * runs and asserts the rendered geometry still describes the position.
 *
 * The reference rows are built with the enhanced list's own markup because the
 * static route renders cards (`NoteList.astro`), whose geometry is not the
 * enhanced row's. The static route supplies the complete membership and order;
 * its links are used unchanged as row text.
 */

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';

import { TAG_WINDOW_SIZE } from '../src/lib/tag-browser-model.ts';
import { buildAndServe, removeWorkspace, type RunningSite } from './support/browser-site.ts';

const TAG_KEY = 'wrapped';
const MEMBERS = 180;

/** A phrase long enough that repeated copies cross several lines at 412 px. */
const PHRASE = 'wrapped rows need measured geometry';

function titleFor(index: number): string {
  const ordinal = String(index).padStart(3, '0');
  switch (index % 4) {
    case 0:
      return `Short ${ordinal}`;
    case 1:
      return `Wrapped ${ordinal} — ${PHRASE} ${PHRASE}`;
    case 2:
      return `Tall ${ordinal} — ${PHRASE} ${PHRASE} ${PHRASE} ${PHRASE}`;
    default:
      return `Mixed ${ordinal} — ${PHRASE} ${PHRASE} ${PHRASE}`;
  }
}

interface ReferenceRow {
  /** Document offset from the list's own top. */
  top: number;
  height: number;
}

interface RowState {
  position: number;
  setsize: number;
  top: number;
  bottom: number;
  height: number;
}

interface SpacerState {
  which: string;
  top: number;
  bottom: number;
}

interface ListState {
  scrollY: number;
  innerHeight: number;
  rows: RowState[];
  spacers: SpacerState[];
  counterReset: string;
  windowStart: string;
}

let site: RunningSite;
let browser: Browser;
let context: BrowserContext;

async function logicalSize(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(document.querySelector('#tag-browser-results [aria-setsize]')?.getAttribute('aria-setsize') ?? 0),
  );
}

/**
 * Measure the complete logical list as enhanced rows.
 *
 * This runs before Start, while the results list is empty and visible. Every
 * static-route link becomes one row with the enhanced markup, so the measured
 * heights are the heights the enhanced list will lay out. The rows are removed
 * again before the reader starts the enhanced path.
 */
async function referenceGeometry(page: Page): Promise<ReferenceRow[]> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    const notes = [
      ...document.querySelectorAll<HTMLAnchorElement>('#tag-static-list a[href^="/notes/"]'),
    ]
      .filter((link) => {
        const href = link.getAttribute('href') ?? '';
        if (seen.has(href)) return false;
        seen.add(href);
        return true;
      })
      .map((link) => ({
        href: link.getAttribute('href') ?? '',
        title: link.textContent ?? '',
      }));
    // The static route sorts by title (`notesForSlugs`); `byTag` pages by slug.
    // The logical list is slug-ordered, so the reference rows are too.
    notes.sort((left, right) => (left.href < right.href ? -1 : left.href > right.href ? 1 : 0));
    const titles = notes.map((note) => note.title);
    const list = document.querySelector<HTMLOListElement>('#tag-browser-results')!;
    const fragment = document.createDocumentFragment();
    titles.forEach((title, index) => {
      const item = document.createElement('li');
      item.setAttribute('aria-setsize', String(titles.length));
      item.setAttribute('aria-posinset', String(index + 1));
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = title;
      item.append(link);
      fragment.append(item);
    });
    list.replaceChildren(fragment);
    const listTop = list.getBoundingClientRect().top + window.scrollY;
    const rects = [...list.querySelectorAll<HTMLElement>('li')].map((row) => row.getBoundingClientRect());
    const geometry = rects.map((rect) => ({
      top: rect.top + window.scrollY - listTop,
      height: rect.height,
    }));
    list.replaceChildren();
    return geometry;
  });
}

async function openTag(page: Page): Promise<void> {
  await page.goto(`${site.origin}/tags/${TAG_KEY}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#tag-browser')?.hidden === false);
}

async function loadAll(page: Page): Promise<void> {
  let total = await logicalSize(page);
  while (total < MEMBERS) {
    await page.locator('#tag-browse-more').click();
    await page.waitForFunction(
      (before) =>
        Number(
          document.querySelector('#tag-browser-results [aria-setsize]')?.getAttribute('aria-setsize') ?? 0,
        ) > before,
      total,
      { timeout: 15_000 },
    );
    total = await logicalSize(page);
  }
}

async function listState(page: Page): Promise<ListState> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('#tag-browser-results')!;
    return {
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
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
      counterReset: getComputedStyle(list).counterReset,
      windowStart: list.style.getPropertyValue('--tag-window-start'),
    };
  });
}

/** A rendered row covers the viewport top and neither spacer crosses it. */
function settled(state: ListState): boolean {
  const covered = state.rows.some((row) => row.top <= 0 && row.bottom > 0);
  const clear = state.spacers.every(
    (spacer) => spacer.bottom <= 0.5 || spacer.top >= state.innerHeight - 0.5,
  );
  return covered && clear;
}

/** Let the scroll handler and its anchor correction finish, then read once. */
async function settle(page: Page, timeout = 4_000): Promise<ListState> {
  const deadline = Date.now() + timeout;
  let state = await listState(page);
  let previousScrollY = state.scrollY;
  let stable = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(50);
    state = await listState(page);
    if (state.scrollY === previousScrollY) stable += 1;
    else stable = 0;
    previousScrollY = state.scrollY;
    if (settled(state) && stable >= 2) break;
  }
  return state;
}

function assertWindowShape(state: ListState): void {
  assert.ok(state.rows.length > 0, 'no numbered rows rendered');
  assert.ok(
    state.rows.length <= TAG_WINDOW_SIZE,
    `the DOM kept ${state.rows.length} rows, above the ${TAG_WINDOW_SIZE}-row window`,
  );
  const positions = state.rows.map((row) => row.position);
  positions.forEach((position, index) => {
    assert.equal(position, positions[0]! + index, `positions jumped: ${positions.join(',')}`);
  });
  for (const row of state.rows) {
    assert.equal(row.setsize, MEMBERS, `a row reported setsize ${row.setsize}, not ${MEMBERS}`);
  }
  assert.equal(
    state.windowStart,
    String(positions[0]! - 1),
    `the counter variable is ${state.windowStart}, not ${positions[0]! - 1}`,
  );
  assert.equal(
    state.counterReset,
    `tag-row ${positions[0]! - 1}`,
    `the list counter restarts at ${state.counterReset}; the window would renumber visibly`,
  );
}

beforeAll(async () => {
  const corpus: Record<string, string> = {};
  for (let index = 1; index <= MEMBERS; index += 1) {
    const slug = `wrapped-${String(index).padStart(3, '0')}`;
    const title = titleFor(index);
    corpus[`${slug}.md`] =
      `---\ntitle: "${title}"\ntags: [${TAG_KEY}]\n---\n\n# ${title}\n\nBody for ${slug}.\n`;
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

test('a jump into wrapped and mixed rows keeps the visible row rendered and still', async () => {
  const page = await context.newPage();
  await openTag(page);

  const geometry = await referenceGeometry(page);
  assert.equal(geometry.length, MEMBERS, 'the static route did not carry the complete logical list');
  const distinct = [...new Set(geometry.map((row) => Math.round(row.height)))].sort((a, b) => a - b);
  assert.ok(distinct.length >= 3, `the corpus rendered only ${distinct.length} distinct row heights`);
  assert.ok(
    distinct.at(-1)! >= distinct[0]! * 2,
    `the tallest row (${distinct.at(-1)}px) is not at least twice the shortest (${distinct[0]}px)`,
  );

  await page.locator('#tag-browse-start').click();
  await page.waitForSelector('#tag-browser-results li[aria-posinset]');
  await loadAll(page);

  // The list's document top is fixed once the static route is detached and the
  // exhausted sentence is written; every jump below is relative to it.
  const listTop = await page.evaluate(() => {
    const list = document.querySelector('#tag-browser-results')!;
    return list.getBoundingClientRect().top + window.scrollY;
  });

  const tallest = Math.max(...geometry.map((row) => row.height));
  const tall = geometry
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => row.height >= tallest - 1 && index >= 20 && index <= MEMBERS - 20)
    .map(({ index }) => index);
  const mixed = geometry
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row, index }) =>
        row.height > distinct[0]! + 1 &&
        row.height < tallest - 1 &&
        index >= 20 &&
        index <= MEMBERS - 20,
    )
    .map(({ index }) => index);
  assert.ok(tall.length > 0, 'the corpus produced no tall rows to jump into');
  assert.ok(mixed.length > 0, 'the corpus produced no intermediate-height rows to jump into');

  const targets = [
    tall[Math.floor(tall.length * 0.2)]!,
    tall[Math.floor(tall.length * 0.5)]!,
    tall[Math.floor(tall.length * 0.8)]!,
    mixed[Math.floor(mixed.length * 0.6)]!,
  ];

  for (const target of targets) {
    const reference = geometry[target]!;
    // Land the viewport top inside the row, not on its boundary.
    const fraction = 0.35;
    const offset = listTop + reference.top + reference.height * fraction;
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), offset);

    const state = await settle(page);
    const label = `row ${target + 1} (${Math.round(reference.height)}px) at offset ${Math.round(offset)}`;

    assertWindowShape(state);
    for (const spacer of state.spacers) {
      assert.ok(
        spacer.bottom <= 0.5 || spacer.top >= state.innerHeight - 0.5,
        `${label}: the ${spacer.which} spacer intersects the viewport (${spacer.top}..${spacer.bottom})`,
      );
    }

    const covering = state.rows.find((row) => row.top <= 0 && row.bottom > 0);
    assert.ok(covering, `${label}: no rendered row covers the viewport top`);
    const renderedTarget = state.rows.find((row) => row.position === target + 1);
    assert.equal(
      covering.position,
      target + 1,
      `${label}: row ${covering.position} (top ${covering.top.toFixed(1)}, h ${covering.height.toFixed(1)}) ` +
        `covers the viewport top instead of the true row ${target + 1}; ` +
        `scrollY ${state.scrollY.toFixed(1)}, submitted ${offset.toFixed(1)}, ` +
        `target rendered ${renderedTarget ? `top ${renderedTarget.top.toFixed(1)} h ${renderedTarget.height.toFixed(1)}` : 'no'}`,
    );

    const rendered = renderedTarget;
    assert.ok(rendered, `${label}: the row under the viewport top is not rendered (spacer)`);
    const expectedTop = reference.top - (state.scrollY - listTop);
    assert.ok(
      Math.abs(rendered.top - expectedTop) <= rendered.height / 2,
      `${label}: the row under the viewport top moved ${Math.round(rendered.top - expectedTop)}px, ` +
        `more than half its ${Math.round(rendered.height)}px height`,
    );
  }

  await page.close();
}, 180_000);
