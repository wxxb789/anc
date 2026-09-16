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
