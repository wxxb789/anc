/**
 * The collection navigation an explorer rail renders.
 *
 * Two levels, both of which the artifact actually carries: a curated collection,
 * and the notes inside it. Every published note belongs to exactly one group — a
 * note with no `collection` lands in a final group rather than being dropped,
 * because a navigation tree that silently omits part of the corpus is a map with
 * a hole in it rather than a smaller map.
 *
 * **Membership is complete; what a group *draws* is bounded.** A group larger
 * than {@link GROUP_WINDOW} renders a window of its members around the reader
 * rather than all of them, and states its full size beside its label. That is
 * the fix for a rail that was quadratic in the corpus — it renders on every page
 * and listed every note, so a site paid n × n bytes — and the bound's own
 * comment carries the measurements. Nothing becomes unreachable: a bounded group
 * links its collection index, which lists every member, and the home page lists
 * the whole corpus.
 *
 * Pure, like `routes.ts` and `relations.ts`: nothing here imports the artifact.
 * The caller passes the corpus and the path being viewed, so every rule below is
 * exercisable against synthetic fixtures without building the site.
 *
 * **What a deeper hierarchy would change, and what it would not.** `collection`
 * is validated as a *flat* slug (`src/lib/schema.ts`) and `routes.ts` has no
 * notion of nesting, so a collection inside a collection has no data behind it
 * and is not invented here. When the exporter grows that field, the change is
 * this one function splitting a key into segments and emitting a group per
 * ancestor — the group shape, the component, and the stylesheet are unchanged,
 * because a nested group is the same disclosure with a different label and a
 * `depth`. TK-19 owns the contract conversation; nothing here anticipates its
 * outcome.
 */

import type { ContentEntry } from './schema.ts';
import { collectionFacets, collectionRoute } from './routes.ts';
import { byTitleThenSlug } from './relations.ts';
import { noteRoute, noteSlugFromPath } from './route-path.ts';

/** One note, as the rail lists it. */
export interface ExplorerNote {
  slug: string;
  title: string;
  route: string;
  /** The page being viewed. Rendered with `aria-current="page"`. */
  isCurrent: boolean;
  /**
   * The note's own language, so the rail can mark a title whose language
   * differs from the page's. The rail draws a window of every group on every
   * route, so on a bilingual site most pages list titles in both languages —
   * and a screen reader reads a Chinese title in an English voice unless the
   * title says what it is. `partLanguage` decides when the attribute is needed.
   */
  language?: string;
}

/** One collection, or the notes belonging to none. */
export interface ExplorerGroup {
  /**
   * The label a reader sees. For a collection this is the artifact's own
   * spelling, which is also its route key — TK-01 validates `collection` as a
   * slug, so there is no second form to reconcile.
   */
  label: string;
  /**
   * `/collections/<key>/`. Absent for the uncollected group, which has no index
   * route to link: nothing in the route model addresses "notes with no
   * collection", and inventing a route for it would publish a page the artifact
   * never asked for.
   */
  route?: string;
  /**
   * The notes the rail *draws*, which on a large group is a window around the
   * reader rather than the whole membership. See {@link GROUP_WINDOW}.
   */
  notes: ExplorerNote[];
  /**
   * How many notes this group holds in total, drawn or not.
   *
   * Always the full membership, so the count beside a group's label stays the
   * size of the collection rather than the size of the slice below it. A count
   * that shrank with the window would be the rail telling a reader their
   * collection had fewer notes in it than it does — and it is the number that
   * tells them whether opening the group costs three lines or thirty.
   */
  total: number;
  /**
   * Whether this group holds the page being viewed. The component opens exactly
   * this one, which is what makes the rail contextual at zero JavaScript: a
   * reader inside a collection sees its siblings, while the other groups stay
   * one-line disclosures rather than a wall of every title on the site.
   */
  isCurrent: boolean;
}

/**
 * How many notes one group may draw.
 *
 * The bound exists because the rail was **quadratic in the corpus**: it renders
 * on every page and listed every published note, so a site paid n entries × n
 * pages in bytes its host serves and its reader downloads. Measured through the
 * shipped binary: at 100 notes the rail was 7,817 B of a 17,245 B page, and at
 * 300 it was 23,126 B of 32,566 B — 71% of the page a reader asked for spent on
 * a list of the pages they did not. Projected at 77 B/entry, 10,000 notes is
 * 732 KB per page across 10,000 pages.
 *
 * **Twelve is the rail's own row budget, measured rather than chosen, with the
 * headroom a wrapped title needs.** The rail on desktop is
 * `max-height: calc(100vh - 7rem)` with `overflow-y: auto`
 * (`src/styles/global.css`), so there is a real number of rows it can show
 * before the reader has to scroll the rail itself. At 1280×720 — the narrowest
 * viewport at which the rail is a column at all, since the two-column layout
 * switches on at 64rem — the rail's box is 608 px, and a group's summary takes
 * 50 of it.
 *
 * A row is **not one height**. Measured over 384 rendered rows in Chromium at
 * the rail's 240 px: 330 were 34 px and 54 were 59 px, because a title longer
 * than the rail wraps to two lines. So the budget is 16 rows if every title is
 * short and 9 if every one wraps, and no single number is "the" row count.
 *
 * Sixteen was the first bound tried and the rendered gate refused it, on a note
 * whose neighbours happened to wrap. Bisected afterwards **with that gate as the
 * instrument** — 300 notes, seed 7, 1280×720, 40 pages strided across the
 * corpus: 13 is the largest window where every sampled page keeps the marker
 * inside the box, and 14 loses one.
 *
 * Twelve rather than thirteen because thirteen is the cliff edge itself, found
 * on one synthetic corpus at one viewport with one group. A bound sitting
 * exactly on a measured limit is one that a longer title or a shorter viewport
 * puts back over it — and **a second group costs another 50 px of summary**, so
 * a four-collection site has 408 px rather than 558 for its open group's rows.
 * That case is real and is not what the bisection measured, since the corpus the
 * CLI produces has exactly one group; the margin is what covers it.
 *
 * Twelve is also what {@link LOCAL_NODE_LIMIT} is bounded at, which keeps two
 * bounded views in this project at one number rather than two arbitrary ones.
 *
 * **This value is constrained by exactly one gate** — "the rail shows the reader
 * their own position without scrolling", in `tests/adoption.test.ts`. Every
 * other gate over the window asserts its *shape* and is written in terms of this
 * constant, so all of them stay green at any value: measured, with the window at
 * 40 the whole of `tests/collection-navigation.test.ts` passes. That is
 * deliberate — a shape should not depend on a number — but it means the rendered
 * gate is the only thing standing behind the twelve.
 *
 * **What made this a correctness fix and not only a bytes fix.** The rail's
 * whole contextual claim is `aria-current="page"`, and past its own row budget
 * that marker renders *below the fold of the rail's scroll container*. Measured
 * over 40 note pages at 1280×720 before this bound: at 100 notes 31 of 40
 * pages put the marker outside the visible box, and at 300 notes 40 of 40 did.
 * A reader on a 300-note site was shown a wall of titles that never included
 * the one they were on. Windowing puts it back on every page by construction.
 *
 * **Nothing is hidden by it.** A bounded group states how many of its notes it
 * drew, the same shown-of-total sentence `NoteGraph.astro` gives its own bound.
 * A collection group links its index, which lists every member; the uncollected
 * group has no index to link and so links the home page, which lists the whole
 * corpus. That branch is the important one rather than the fallback: the CLI
 * derives no `collection` (`scripts/markdown-to-artifact.ts`), so every corpus
 * this tool actually builds is one uncollected group.
 *
 * A 32-note fixture corpus's groups are 11, 10, 7, and 4, so every one of them
 * draws whole and a small site's rail is byte-for-byte what it was.
 */
export const GROUP_WINDOW = 12;

/**
 * The window of `notes` a group draws, centred on the reader where it holds
 * them.
 *
 * Centred rather than truncated from the front, and that is the property the
 * bound exists for: a group's first {@link GROUP_WINDOW} notes are an
 * alphabetical slice that on most pages does not contain the reader, which would
 * strand `aria-current="page"` exactly the way an unbounded rail does. Clamped
 * at both ends so a reader near the start or the end of a collection still gets
 * a full window rather than a half one.
 *
 * A group not holding the reader has no centre to take, so it draws its first
 * {@link GROUP_WINDOW}. Every group but one is in that case on any page, and
 * they are all closed — a closed `<details>` shows its label and its count, so
 * which of its members the markup happens to carry is not something the reader
 * sees until they open it, and what they get when they do is the collection's
 * beginning.
 */
function windowAround(notes: readonly ExplorerNote[]): ExplorerNote[] {
  if (notes.length <= GROUP_WINDOW) return [...notes];
  const at = notes.findIndex((note) => note.isCurrent);
  if (at < 0) return notes.slice(0, GROUP_WINDOW);
  // Half the window either side, clamped into range. `Math.min` before
  // `Math.max` so a reader near the end is pulled back to a full window rather
  // than given a short one.
  const start = Math.max(0, Math.min(at - Math.floor(GROUP_WINDOW / 2), notes.length - GROUP_WINDOW));
  return notes.slice(start, start + GROUP_WINDOW);
}

/**
 * The collection groups, in the order `/collections/` lists them, with the
 * uncollected notes last.
 *
 * `currentPath` is the pathname being rendered. It marks a note
 * (`/notes/<slug>/`) and, through it, that note's group; a collection index
 * (`/collections/<key>/`) marks the group alone. Any other route — the home
 * page, `/tags/`, the 404 — marks nothing, and every group renders closed. That
 * is deliberate: on a page with no collection context there is no group the
 * reader is "in", and opening an arbitrary one would be a guess presented as a
 * location.
 *
 * Grouping comes from {@link collectionFacets} rather than a second pass over
 * `entry.collection`, so a group here is exactly a page under `/collections/`:
 * same members, same order, same key. A private second grouping would let the
 * rail show a collection the site does not publish.
 *
 * `uncollectedLabel` is required rather than defaulted, and it is the one string
 * a reader meets that this module does not get from the artifact. Taking it as a
 * parameter is what keeps the module pure — it imports no locale table, so every
 * rule here stays exercisable against synthetic fixtures — while letting the rail
 * on a Chinese note read "未归入合集" and the same group on an English note read
 * "Uncollected", in one build. A default would have been a second copy of a
 * translated string living outside the contract, which is exactly the drift
 * `tests/translations.test.ts` exists to prevent.
 *
 * Four of the thirty-two fixture notes land in that group; on the published
 * one-note corpus it is the only group.
 */
export function collectionNavigation(
  entries: readonly ContentEntry[],
  currentPath: string,
  uncollectedLabel: string,
): ExplorerGroup[] {
  const currentSlug = noteSlugFromPath(currentPath);
  // The collection holding the note being read, when a note is being read.
  // Resolved from the entry rather than from the path, because a note route
  // never carries its collection in the URL.
  const openCollection = entries.find((entry) => entry.slug === currentSlug)?.collection;

  const note = (entry: ContentEntry): ExplorerNote => ({
    slug: entry.slug,
    title: entry.title,
    route: noteRoute(entry.slug),
    isCurrent: entry.slug === currentSlug,
    language: entry.language,
  });

  const groups: ExplorerGroup[] = collectionFacets(entries).map((facet) => ({
    label: facet.label,
    route: collectionRoute(facet.key),
    // Compared against the built route rather than a second regex over the
    // path: `collectionRoute` is where that shape is defined, so the two cannot
    // drift into disagreeing about a trailing slash.
    isCurrent: collectionRoute(facet.key) === currentPath || facet.key === openCollection,
    notes: windowAround(facet.entries.map(note)),
    total: facet.entries.length,
  }));

  const uncollected = entries.filter((entry) => entry.collection === undefined);
  if (uncollected.length > 0) {
    // The same comparator `collectionFacets` gives a facet's members, imported
    // rather than restated so the last group cannot come to read differently
    // from every group above it.
    const notes = [...uncollected].sort(byTitleThenSlug).map(note);
    groups.push({
      label: uncollectedLabel,
      notes: windowAround(notes),
      total: notes.length,
      // Marked only by the note being read, and from the *whole* group rather
      // than from the window: a reader whose note the window happened to drop
      // would otherwise land in a group that closed itself around them.
      isCurrent: notes.some((member) => member.isCurrent),
    });
  }

  return groups;
}
