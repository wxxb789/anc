/**
 * The collection navigation an explorer rail renders.
 *
 * Two levels, both of which the artifact actually carries: a curated collection,
 * and the notes inside it. Every published note appears exactly once — a note
 * with no `collection` lands in a final group rather than being dropped, because
 * a navigation tree that silently omits part of the corpus is a map with a hole
 * in it rather than a smaller map.
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
   * differs from the page's. Every route renders the whole corpus in this rail,
   * so on a bilingual site most pages list titles in both languages — and a
   * screen reader reads a Chinese title in an English voice unless the title
   * says what it is. `partLanguage` decides when the attribute is needed.
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
  notes: ExplorerNote[];
  /**
   * Whether this group holds the page being viewed. The component opens exactly
   * this one, which is what makes the rail contextual at zero JavaScript: a
   * reader inside a collection sees its siblings, while the other groups stay
   * one-line disclosures rather than a wall of every title on the site.
   */
  isCurrent: boolean;
}

/**
 * The label for notes carrying no `collection`, in the navigation language.
 *
 * The default rather than the only value: `collectionNavigation` takes the
 * resolved label as a parameter so the rail on a Chinese note reads
 * "未归入合集" while the same group on an English note reads "Uncollected", in
 * one build. This constant keeps the module pure — it imports no locale table,
 * so it stays exercisable against synthetic fixtures — and gives a caller with
 * no opinion the navigation language. `Layout.astro` always has an opinion,
 * because it has resolved the document's own.
 *
 * Four of the thirty-two fixture notes reach this group; on the published
 * one-note corpus it is the only group.
 */
export const UNCOLLECTED_LABEL = 'Uncollected';

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
 */
export function collectionNavigation(
  entries: readonly ContentEntry[],
  currentPath: string,
  uncollectedLabel: string = UNCOLLECTED_LABEL,
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
    notes: facet.entries.map(note),
  }));

  const uncollected = entries.filter((entry) => entry.collection === undefined);
  if (uncollected.length > 0) {
    // The same comparator `collectionFacets` gives a facet's members, imported
    // rather than restated so the last group cannot come to read differently
    // from every group above it.
    const notes = [...uncollected].sort(byTitleThenSlug).map(note);
    groups.push({
      label: uncollectedLabel,
      notes,
      // Marked only by the note being read: this group has no index route, so a
      // path can never select it on its own.
      isCurrent: notes.some((member) => member.isCurrent),
    });
  }

  return groups;
}
