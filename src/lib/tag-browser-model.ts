/**
 * The tag browser's pure classification, testable without a browser.
 *
 * `byTag` distinguishes three reader-visible outcomes that a single empty list
 * would conflate: the tag is not in the snapshot at all, the tag exists but the
 * page is empty, and the page is exhausted. The UI must not present "no more
 * results" for a tag that was never there.
 */

import type { NoteSummary, TagPage } from './snapshot-queries.ts';

/** How many notes one browser result page carries. Chosen for the reader. */
export const TAG_PAGE_SIZE = 10;

/**
 * How many logical rows the enhanced list keeps in the DOM at once.
 *
 * Measured page-clock dispatch at 1,000 notes was 10.1 ms with 100 rendered
 * rows and 57.2 ms with 1,000, while SQL and Worker time stayed below 1 ms, so
 * the cost was style/layout over the accumulated list. This bound keeps that
 * cost constant; the static list remains the complete no-JS route and every
 * rendered row carries `aria-setsize`/`aria-posinset`.
 */
export const TAG_WINDOW_SIZE = 120;

/**
 * The rendered window for `total` logical entries starting near `start`.
 *
 * A window never shrinks below the limit unless the collection itself is
 * smaller, and `start` is clamped so the window never runs past the end.
 */
export function tagWindow(
  total: number,
  start: number,
  size: number = TAG_WINDOW_SIZE,
): { start: number; end: number } {
  const span = Math.min(Math.max(0, total), Math.max(1, size));
  const first = Math.max(0, Math.min(Math.trunc(start), total - span));
  return { start: first, end: first + span };
}

export type TagBrowseState =
  | { kind: 'unknown' }
  | { kind: 'empty' }
  | { kind: 'page'; notes: NoteSummary[]; nextCursor: string | null };

/** Map a Worker tag result to the three states above. */
export function classifyTagPage(page: TagPage): TagBrowseState {
  if (!page.known) return { kind: 'unknown' };
  if (page.notes.length === 0) return { kind: 'empty' };
  return { kind: 'page', notes: page.notes, nextCursor: page.nextCursor };
}
