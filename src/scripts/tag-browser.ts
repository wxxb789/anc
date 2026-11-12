/**
 * Reader-facing tag browsing over the shared lazy snapshot runtime.
 *
 * `byTag` is a named operation with cursor pagination; this is its reader-facing
 * consumer. It is mounted on `/tags/` (a tag chooser) and `/tags/<tag>/` (one
 * fixed tag), and every chrome string arrives as a `data-` attribute the build
 * wrote, so no locale table ships to the browser and no tag is normalized here —
 * the key is sent exactly as the static route spells it.
 *
 * The static `NoteList`/`FacetIndex` above it remains the complete no-JS route;
 * this region is hidden until the script runs and unhides the static list on any
 * failure.
 *
 * The enhanced list keeps the **logical** collection in `entries` and renders
 * only a bounded window of it. Every rendered row carries `aria-setsize` (the
 * complete logical count) and `aria-posinset` (its 1-based position), so the
 * accessibility tree still describes the whole collection while the DOM stays
 * at `TAG_WINDOW_SIZE` rows plus two spacers. Without this, every continuation
 * paid a style/layout cost proportional to the number of rows loaded so far:
 * measured 10.1 ms at 100 rows and 57.2 ms at 1,000 rows (1,000-note corpus),
 * with SQL and Worker time flat below 1 ms.
 *
 * A continuation at the tail mutates only its edges — drop the rows that left
 * the window, append the new ones, update `aria-setsize` — because recreating
 * the window on every page puts a fixed 120-node cost back into each dispatch.
 */

import { noteRoute } from '../lib/route-path.ts';
import {
  classifyTagPage,
  TAG_PAGE_SIZE,
  TAG_WINDOW_SIZE,
  tagWindow,
  type TagBrowseState,
} from '../lib/tag-browser-model.ts';
import type { NoteSummary } from '../lib/snapshot-queries.ts';
import { partLanguage, TAG_BROWSE_DATASET } from '../lib/translations.ts';
import { requestByTag } from './snapshot-client.ts';

/** A row's one-line height, used only until a rendered row measures itself. */
const DEFAULT_ROW_HEIGHT = 24;

/**
 * `KeyboardEvent.key` values that scroll the list. These are input vocabulary —
 * the names of keys on a keyboard — not chrome labels, so they are not
 * translated and must not be resolved from the translation contract.
 */
const SCROLL_GESTURE_KEYS: readonly string[] = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];

const root = document.querySelector<HTMLElement>('#tag-browser');
if (root) install(root);

function install(root: HTMLElement): void {
  const mode = root.dataset['mode'] === 'switch' ? 'switch' : 'fixed';
  const pageSize = Number(root.dataset['pageSize']) || TAG_PAGE_SIZE;
  const staticList = document.querySelector<HTMLElement>('#tag-static-list');
  const chooser = root.querySelector<HTMLSelectElement>('#tag-browser-select');
  const start = root.querySelector<HTMLButtonElement>('#tag-browse-start');
  const more = root.querySelector<HTMLButtonElement>('#tag-browse-more');
  const results = root.querySelector<HTMLOListElement>('#tag-browser-results')!;
  const status = root.querySelector<HTMLElement>('#tag-browser-status')!;
  const current = root.querySelector<HTMLElement>('#tag-browser-current')!;

  const string = (key: (typeof TAG_BROWSE_DATASET)[keyof typeof TAG_BROWSE_DATASET]): string =>
    root.dataset[key] ?? '';

  let generation = 0;
  let tagKey = mode === 'fixed' ? (root.dataset['tagKey'] ?? '') : '';
  let cursor: string | null = null;

  /** Every note the logical list contains, including rows currently released. */
  const entries: NoteSummary[] = [];
  let windowStart = 0;
  let windowEnd = 0;
  /**
   * The real height of every row this list has rendered, keyed by logical
   * index. The list's titles wrap, so no single sample stands for the list:
   * the released-range spacers and the estimate used when the viewport sits
   * inside one are built from these measurements.
   */
  const rowHeights = new Map<number, number>();
  /**
   * Fenwick prefix index over `rowHeights`.
   *
   * `heightTree` stores each measured row's height as measured and
   * `countTree` stores 1 for that row, so the estimated height of the logical
   * range `[from, to)` is `measuredHeight(from, to) + (to - from -
   * measuredCount(from, to)) * meanRowHeight`. The range queries and the
   * inverse "offset → index" descent are O(log n), which is what keeps a
   * reposition independent of how far the window has moved: the linear walks
   * that used to size the spacers grew with `windowStart`.
   *
   * Storing the raw height, not a delta from the mean, is deliberate. Rows that
   * were rendered are exact at every mean; a mean change only moves the rows
   * that have never been measured, so the structure never needs rewriting when
   * a measurement lands. `heightCapacity` is the tree size, a power of two;
   * index 0 is unused.
   */
  let heightTree = new Float64Array(1);
  let countTree = new Int32Array(1);
  let heightCapacity = 0;
  let measuredHeightSum = 0;
  let measuredHeightCount = 0;
  /** Mean of the measured rows, for an index that has never been rendered. */
  let meanRowHeight = DEFAULT_ROW_HEIGHT;
  /** The viewport width the cache belongs to; a resize invalidates it. */
  let measuredWidth = 0;
  let lastObservedScrollY = window.scrollY;
  /** Largest scroll delta since the last reposition, for the layout-scroll guard. */
  let pendingScrollDelta = 0;

  const language = document.documentElement.lang || 'en';

  let staticParent: HTMLElement | null = null;
  let staticAnchor: ChildNode | null = null;
  let staticDetached = false;

  /**
   * Release the complete static route once the enhanced page has rendered.
   *
   * Its rows cost page-side work on every later continuation even while
   * `display: none`: measured 12.3 → 24.2 ms p50 dispatch with 10,000 hidden
   * nodes present, and `content-visibility: hidden` did not remove it. The
   * element is kept whole for the failure path, which reinserts it and reveals
   * it exactly as before.
   */
  function detachStatic(): void {
    if (staticList === null || staticDetached || staticList.parentElement === null) return;
    staticParent = staticList.parentElement;
    staticAnchor = staticList.nextSibling;
    staticList.remove();
    staticDetached = true;
  }

  function restoreStatic(): void {
    if (staticList === null) return;
    if (staticDetached && staticParent !== null) {
      staticParent.insertBefore(staticList, staticAnchor);
      staticDetached = false;
    }
    staticList.hidden = false;
  }

  const numberedRows = (): HTMLElement[] => [
    ...results.querySelectorAll<HTMLElement>('li[aria-posinset]'),
  ];

  /** A rendered row's height, or the mean of the measured rows until it has one. */
  function heightOf(index: number): number {
    return rowHeights.get(index) ?? meanRowHeight;
  }

  /**
   * Make room for `size` logical rows, rebuilding the trees from the retained
   * measurements when the logical list outgrows the current capacity. Capacity
   * doubles, so the rebuild is amortised O(1) per appended row.
   */
  function rebuildHeightIndex(size: number): void {
    if (size <= heightCapacity) return;
    let capacity = Math.max(1, heightCapacity);
    while (capacity < size) capacity *= 2;
    heightTree = new Float64Array(capacity + 1);
    countTree = new Int32Array(capacity + 1);
    heightCapacity = capacity;
    for (const [index, height] of rowHeights) addMeasurement(index, height);
  }

  /** Fold one measured row into the trees. */
  function addMeasurement(index: number, height: number): void {
    for (let node = index + 1; node <= heightCapacity; node += node & -node) {
      heightTree[node] += height;
      countTree[node] += 1;
    }
  }

  /** Estimated height of the logical rows `[0, end)`. */
  function prefixHeight(end: number): number {
    let measured = 0;
    let measuredCount = 0;
    for (let node = end; node > 0; node -= node & -node) {
      measured += heightTree[node];
      measuredCount += countTree[node];
    }
    return measured + (end - measuredCount) * meanRowHeight;
  }

  /**
   * The logical index whose row covers `offset` pixels of estimated height
   * from the list's top: the largest index whose row starts at or before the
   * offset, clamped to the last row. Fenwick descent over both trees, O(log n).
   */
  function indexAtOffset(offset: number, size: number): number {
    if (size <= 0 || offset <= 0) return 0;
    let step = 1;
    while (step * 2 <= heightCapacity) step *= 2;
    let position = 0;
    let measured = 0;
    let measuredCount = 0;
    for (; step > 0; step >>= 1) {
      const next = position + step;
      if (next > size) continue;
      const nextMeasured = measured + heightTree[next];
      const nextCount = measuredCount + countTree[next];
      if (nextMeasured + (next - nextCount) * meanRowHeight <= offset) {
        position = next;
        measured = nextMeasured;
        measuredCount = nextCount;
      }
    }
    return Math.min(size - 1, position);
  }

  function clearMeasurements(): void {
    rowHeights.clear();
    measuredHeightSum = 0;
    measuredHeightCount = 0;
    meanRowHeight = DEFAULT_ROW_HEIGHT;
    heightTree = new Float64Array(1);
    countTree = new Int32Array(1);
    heightCapacity = 0;
  }

  /** A width change rewraps titles, so every cached height is stale. */
  function syncMeasurementWidth(): void {
    if (measuredWidth === window.innerWidth) return;
    measuredWidth = window.innerWidth;
    clearMeasurements();
  }

  /**
   * Record the real height of every rendered row that has none yet.
   *
   * A row is rendered from the same title at the same width every time, so a
   * height already in `rowHeights` is still its height; a continuation at the
   * tail therefore reads the ten rows it added, not the 120 the window holds.
   * One batched read: the first read flushes layout and the rest observe the
   * same pass. `render()` measures before the spacers resize, so a first
   * render sizes them from measurements; the tail path sizes them first,
   * because the rows that just entered are inside the window and cannot move
   * a spacer — and a resize after the read would dirty the layout it flushed.
   */
  function rememberRenderedRows(): void {
    // Rows are appended at the tail, so the logical list outgrows the tree
    // only by growing; `rebuildHeightIndex` doubles it. A list still inside
    // one window allocates nothing, and the measurements it records in
    // `rowHeights` are folded in by the first rebuild a spacer triggers.
    if (heightCapacity > 0) rebuildHeightIndex(entries.length);
    for (const row of numberedRows()) {
      const index = Number(row.getAttribute('aria-posinset')) - 1;
      if (rowHeights.has(index)) continue;
      const height = row.getBoundingClientRect().height;
      if (!(height > 0)) continue;
      rowHeights.set(index, height);
      measuredHeightSum += height;
      measuredHeightCount += 1;
      addMeasurement(index, height);
    }
    if (measuredHeightCount > 0) meanRowHeight = measuredHeightSum / measuredHeightCount;
  }

  interface RenderedLayout {
    rows: HTMLElement[];
    rects: DOMRect[];
    listTop: number;
    listBottom: number;
  }

  /** One batched read of the rendered rows and the list's client box. */
  function measureLayout(): RenderedLayout {
    const rows = numberedRows();
    const rects = rows.map((row) => row.getBoundingClientRect());
    const list = results.getBoundingClientRect();
    return { rows, rects, listTop: list.top, listBottom: list.bottom };
  }

  /**
   * The logical index whose row covers a client-space point.
   *
   * Rendered rows are contiguous in logical order, so binary-searching their
   * real rects identifies the row. A point inside a released range has no
   * rect; it falls back to the same per-index heights that sized the spacer.
   */
  function indexAtClientY(clientY: number, layout: RenderedLayout, total: number): number {
    if (layout.rows.length === 0) return 0;
    if (clientY <= layout.listTop) return 0;
    if (clientY >= layout.listBottom) return total - 1;
    const firstRect = layout.rects[0]!;
    const lastRect = layout.rects[layout.rects.length - 1]!;
    // A point in either spacer has no rect; the spacer's height is the prefix
    // index for exactly those released rows, so the descent that built it
    // answers the position without walking to the window.
    if (clientY < firstRect.top || clientY >= lastRect.bottom) {
      return indexAtOffset(clientY - layout.listTop, total);
    }
    let low = 0;
    let high = layout.rects.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (layout.rects[middle]!.top <= clientY) low = middle;
      else high = middle - 1;
    }
    return Number(layout.rows[low]!.getAttribute('aria-posinset')) - 1;
  }

  /** A row's client top, measured when rendered and reconstructed in a spacer. */
  function clientTopOf(index: number, layout: RenderedLayout): number {
    const position = index + 1;
    for (let offset = 0; offset < layout.rows.length; offset += 1) {
      if (Number(layout.rows[offset]!.getAttribute('aria-posinset')) === position) {
        return layout.rects[offset]!.top;
      }
    }
    // Both spacers are prefix heights, so a released row's top is the prefix
    // up to it — independent of which side of the window it is on.
    return layout.listTop + prefixHeight(index);
  }

  function rowFor(note: NoteSummary, position: number, total: number): HTMLLIElement {
    const item = document.createElement('li');
    // The DOM holds a window; these two attributes describe the complete
    // collection to assistive technology (W3C ARIA APG listbox/lazy-load rule).
    item.setAttribute('aria-setsize', String(total));
    item.setAttribute('aria-posinset', String(position + 1));
    const link = document.createElement('a');
    link.href = noteRoute(note.slug);
    link.textContent = note.title;
    // The static tag list marks a foreign title through `partLanguage`;
    // calling it here keeps the enhanced list from drifting from it.
    const lang = partLanguage(note.language, language);
    if (lang !== undefined) link.lang = lang;
    item.append(link);
    return item;
  }

  function spacerFor(which: 'before' | 'after', height: number): HTMLLIElement {
    const item = document.createElement('li');
    item.dataset['windowSpacer'] = which;
    item.setAttribute('aria-hidden', 'true');
    item.style.height = `${Math.max(0, Math.round(height))}px`;
    return item;
  }

  /** Keep the released ranges represented without rendering their rows. */
  function updateSpacers(start: number, end: number, total: number): void {
    // The list's CSS counter starts where the window starts, so the visible
    // marker equals the row's logical position (`aria-posinset`), not a
    // window-local 1..n that would renumber on every shift.
    results.style.setProperty('--tag-window-start', String(start));
    // Only a released range needs heights; a list that fits one window never
    // builds the index.
    if (start > 0 || end < total) rebuildHeightIndex(total);
    const first = results.firstElementChild;
    if (start > 0) {
      const spacer =
        first instanceof HTMLElement && first.dataset['windowSpacer'] === 'before'
          ? first
          : spacerFor('before', 0);
      if (!spacer.isConnected) results.prepend(spacer);
      spacer.style.height = `${Math.max(0, Math.round(prefixHeight(start)))}px`;
    } else if (first instanceof HTMLElement && first.dataset['windowSpacer'] === 'before') {
      first.remove();
    }

    const last = results.lastElementChild;
    if (end < total) {
      const spacer =
        last instanceof HTMLElement && last.dataset['windowSpacer'] === 'after'
          ? last
          : spacerFor('after', 0);
      if (!spacer.isConnected) results.append(spacer);
      spacer.style.height = `${Math.max(0, Math.round(prefixHeight(total) - prefixHeight(end)))}px`;
    } else if (last instanceof HTMLElement && last.dataset['windowSpacer'] === 'after') {
      last.remove();
    }
  }

  function setSetsize(total: number): void {
    for (const row of numberedRows()) row.setAttribute('aria-setsize', String(total));
  }

  /**
   * Replace the rendered window. Used for the initial page, a tag reset, and a
   * scroll reposition; page appends mutate the window's edges instead. The
   * caller that repositions for a scroll anchors the row under the viewport
   * itself, because that row may currently be inside a spacer.
   */
  function render(start: number): void {
    const total = entries.length;
    const range = tagWindow(total, start);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activePosition = active?.closest<HTMLElement>('[aria-posinset]')?.getAttribute('aria-posinset') ?? null;

    syncMeasurementWidth();

    const fragment = document.createDocumentFragment();
    for (let index = range.start; index < range.end; index += 1) {
      fragment.append(rowFor(entries[index]!, index, total));
    }
    results.replaceChildren(fragment);
    windowStart = range.start;
    windowEnd = range.end;
    rememberRenderedRows();
    updateSpacers(range.start, range.end, total);
    markWindowMutation();

    if (activePosition !== null && !results.contains(document.activeElement)) {
      results
        .querySelector<HTMLElement>(`[aria-posinset="${activePosition}"] a`)
        ?.focus({ preventScroll: true });
    }
  }

  /**
   * A reader at the tail follows new rows: release the rows that left the
   * window, append the new page, and update the logical description. No full
   * re-render, so the per-continuation cost tracks the page size, not the
   * window bound.
   */
  function appendAtTail(firstNew: number): void {
    // A width check reads the layout viewport, so it runs while the list is
    // still the previous frame's tree; after the row edits it would flush a
    // layout that the measurement below has to flush again.
    syncMeasurementWidth();
    const total = entries.length;
    const last = results.lastElementChild;
    if (last instanceof HTMLElement && last.dataset['windowSpacer'] === 'after') last.remove();

    const range = tagWindow(total, total);
    if (range.start > windowStart) {
      for (const row of numberedRows().slice(0, range.start - windowStart)) row.remove();
      windowStart = range.start;
    }
    for (let index = Math.max(windowStart, firstNew); index < total; index += 1) {
      results.append(rowFor(entries[index]!, index, total));
    }
    windowEnd = total;
    setSetsize(total);
    // The rows just appended are inside the window, so they cannot move a
    // spacer. Size the released ranges first and measure afterwards: the
    // measurement's rect read then flushes the one layout the frame needs,
    // instead of a layout the spacer resize immediately dirties again.
    updateSpacers(windowStart, total, total);
    const releasedHeight = prefixHeight(windowStart);
    rememberRenderedRows();
    // Only a row that had never been measured — or a changed mean, which moves
    // the unmeasured rows above the window — can alter that height.
    if (prefixHeight(windowStart) !== releasedHeight) updateSpacers(windowStart, total, total);
    markWindowMutation();
  }

  /**
   * A reader looking at an earlier window keeps their place: the new rows are
   * below it, so only the bottom spacer and the logical count change.
   */
  function appendBelowWindow(): void {
    const total = entries.length;
    setSetsize(total);
    updateSpacers(windowStart, windowEnd, total);
    markWindowMutation();
  }

  let lastUserScroll = Number.NEGATIVE_INFINITY;
  /** When this script last changed the list; a scroll caused by that is not intent. */
  let lastWindowMutation = Number.NEGATIVE_INFINITY;
  let syncFrame: number | undefined;

  function markWindowMutation(): void {
    lastWindowMutation = performance.now();
  }

  const markUserScroll = (): void => {
    lastUserScroll = performance.now();
  };

  /**
   * Reposition the window from the reader's scroll offset, not from a counter
   * that can only move when a scroll event fires. A tall `before` spacer puts
   * the viewport inside the rows it represents; at `scrollY 0` there is no
   * further upward event, so the window must be derived from the position.
   *
   * Rows wrap, so the position comes from the rendered rows' own rects and the
   * window grows by a viewport of *measured* heights on each side; dividing
   * one offset by one sampled height would let a tall row hide rows that are
   * still visible. After a rebuild the row under the viewport top is put back
   * at the same client coordinate, so the visible content does not jump.
   */
  function syncWindowToScroll(): void {
    const total = entries.length;
    const delta = pendingScrollDelta;
    pendingScrollDelta = 0;
    if (total <= TAG_WINDOW_SIZE) return;
    // A small scroll produced by this list's own layout or by restoring focus
    // is not a reader request. A wheel/touch/key/scrollbar gesture bypasses
    // this, and so does a deliberate jump larger than the viewport (scrollTo).
    if (performance.now() - lastUserScroll > 750 && performance.now() - lastWindowMutation < 100 && delta < window.innerHeight) {
      return;
    }

    syncMeasurementWidth();
    const layout = measureLayout();
    if (layout.rows.length === 0) return;
    const indexAt = (clientY: number): number => indexAtClientY(clientY, layout, total);
    const anchor = indexAt(0);
    const bottom = indexAt(window.innerHeight);

    // One viewport of measured rows above the anchor and below the viewport
    // bottom, so neither spacer can enter the viewport.
    let wantedStart = anchor;
    let covered = 0;
    while (wantedStart > 0 && covered < window.innerHeight) {
      wantedStart -= 1;
      covered += heightOf(wantedStart);
    }
    let wantedEnd = bottom + 1;
    covered = 0;
    while (wantedEnd < total && covered < window.innerHeight) {
      covered += heightOf(wantedEnd);
      wantedEnd += 1;
    }

    const maxStart = Math.max(0, total - TAG_WINDOW_SIZE);
    // Cover both prefetch margins when 120 rows can; otherwise prefer the top.
    const start = Math.min(maxStart, Math.max(0, Math.min(wantedStart, wantedEnd - TAG_WINDOW_SIZE)));
    if (start >= windowStart && wantedEnd <= windowEnd) return;

    const anchorClientY = clientTopOf(anchor, layout);
    render(start);
    const moved = results.querySelector<HTMLElement>(`[aria-posinset="${anchor + 1}"]`);
    if (moved !== null) {
      const rect = moved.getBoundingClientRect();
      const drift = rect.top - anchorClientY;
      // A replacement row is placed from its own measurement, so the anchor
      // usually does not move. Correct real drift, but do not cancel a smooth
      // scroll for a sub-row difference; half the row's own height is smaller
      // than the jump a reader would notice.
      if (Math.abs(drift) >= rect.height / 2) {
        window.scrollBy(0, drift);
        lastObservedScrollY = window.scrollY;
        pendingScrollDelta = 0;
      }
    }
  }

  /** Coalesce every scroll/gesture in a frame into one reposition. */
  function scheduleSync(): void {
    syncFrame ??= requestAnimationFrame(() => {
      syncFrame = undefined;
      syncWindowToScroll();
    });
  }

  window.addEventListener(
    'wheel',
    () => {
      markUserScroll();
      scheduleSync();
    },
    { passive: true },
  );
  window.addEventListener(
    'touchmove',
    () => {
      markUserScroll();
      scheduleSync();
    },
    { passive: true },
  );
  window.addEventListener('keydown', (event) => {
    if (SCROLL_GESTURE_KEYS.includes(event.key)) {
      markUserScroll();
      scheduleSync();
    }
  });
  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY;
      const delta = Math.abs(y - lastObservedScrollY);
      lastObservedScrollY = y;
      // Skip the frame entirely for a small scroll this list's own layout or
      // focus produced; syncing would only read geometry to decide not to move.
      if (performance.now() - lastUserScroll > 750 && performance.now() - lastWindowMutation < 100 && delta < window.innerHeight) {
        return;
      }
      pendingScrollDelta = Math.max(pendingScrollDelta, delta);
      scheduleSync();
    },
    { passive: true },
  );

  root.hidden = false;

  const reset = (): void => {
    entries.length = 0;
    windowStart = 0;
    windowEnd = 0;
    clearMeasurements();
    lastUserScroll = Number.NEGATIVE_INFINITY;
    results.replaceChildren();
    markWindowMutation();
    if (more !== null) more.hidden = true;
    current.hidden = true;
    status.textContent = '';
  };

  async function load(after: string | null, forGeneration: number): Promise<void> {
    if (tagKey === '') {
      reset();
      return;
    }
    // One continuation may be in flight at a time. `#tag-browse-more` is the only
    // way to dispatch one, and a second click before the first reply lands would
    // send the same cursor again — both replies pass the generation guard below
    // and append the same page. Marked busy synchronously, before the first
    // await, so a double click cannot get two handlers in; the cursor advances
    // only when a reply lands, and the `finally` clears the mark for the next
    // explicit continuation.
    //
    // `aria-disabled` plus the click handler's own check, **not** `disabled`.
    // Disabling the button that holds focus drops focus to `<body>`, so a
    // keyboard reader who pressed Enter on "Load more" was thrown back to the
    // top of the tab order on every page. `tests/tag-browser.test.ts` asserts
    // `document.activeElement` across a continuation.
    if (more !== null) more.setAttribute('aria-disabled', 'true');
    status.textContent = string(TAG_BROWSE_DATASET.loading);
    let page;
    try {
      page = (await requestByTag(tagKey, after, pageSize)).page;
    } catch {
      if (forGeneration !== generation) return;
      // The static list is never removed before page 1 renders, so a failure
      // leaves the complete no-JS list on screen.
      restoreStatic();
      status.textContent = string(TAG_BROWSE_DATASET.failed);
      return;
    } finally {
      if (more !== null) more.removeAttribute('aria-disabled');
    }
    if (forGeneration !== generation) return; // a stale tag's reply cannot replace this one

    const state: TagBrowseState = classifyTagPage(page);
    if (state.kind === 'unknown') {
      if (more !== null) more.hidden = true;
      status.textContent = string(TAG_BROWSE_DATASET.unknown);
      return;
    }
    if (state.kind === 'empty') {
      if (more !== null) more.hidden = true;
      status.textContent = string(TAG_BROWSE_DATASET.empty);
      return;
    }

    // New rows join the logical list. A reader already looking at an earlier
    // window keeps their place; one at the tail follows the new rows.
    const previousTotal = entries.length;
    const atTail = windowEnd >= previousTotal;
    entries.push(...state.notes);
    if (atTail) appendAtTail(previousTotal);
    else appendBelowWindow();
    if (previousTotal === 0) detachStatic();

    if (page.known) {
      current.textContent = page.tag.label;
      current.hidden = false;
    }
    cursor = state.nextCursor;
    if (cursor === null) {
      // Hiding the focused button would drop focus to `<body>` just as above,
      // so a reader who reached the last page from "Load more" continues at
      // the first result that page added.
      if (more !== null && document.activeElement === more) {
        if (windowEnd < entries.length) render(entries.length - TAG_WINDOW_SIZE);
        results
          .querySelector<HTMLElement>(`[aria-posinset="${previousTotal + 1}"] a`)
          ?.focus();
      }
      if (more !== null) more.hidden = true;
      status.textContent = string(TAG_BROWSE_DATASET.exhausted);
    } else {
      if (more !== null) more.hidden = false;
      status.textContent = '';
    }
  }

  /** Explicit intent: choosing a tag or pressing Start. */
  function select(nextKey: string): void {
    const forGeneration = ++generation; // invalidates any in-flight reply
    tagKey = nextKey;
    cursor = null;
    reset();
    // The complete static route stays visible while page 1 is in flight; the
    // successful render detaches it, and a failure has nothing to reveal.
    void load(null, forGeneration);
  }

  start?.addEventListener('click', () => select(mode === 'fixed' ? (root.dataset['tagKey'] ?? '') : ''));
  chooser?.addEventListener('change', () => select(chooser.value));
  more?.addEventListener('click', () => {
    if (more.getAttribute('aria-disabled') === 'true') return; // a continuation is in flight
    const forGeneration = generation;
    void load(cursor, forGeneration);
  });
}
