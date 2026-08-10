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
import { noteRoute, noteSlugFromPath } from './route-path.ts';

/** One note, as the rail lists it. */
export interface ExplorerNote {
  slug: string;
  title: string;
  route: string;
  /** The page being viewed. Rendered with `aria-current="page"`. */
  isCurrent: boolean;
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
 * The label for notes carrying no `collection`.
 *
 * Named rather than written inline because it is the one string in this module a
 * reader meets, and TK-16 translates it in one place. Four of the thirty-two
 * fixture notes reach it; on the published one-note corpus it is the only group.
 */
export const UNCOLLECTED_LABEL = 'Uncollected';

/** Total order over notes: title, then the unique slug so no tie is left open. */
function byTitleThenSlug(a: ContentEntry, b: ContentEntry): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.slug < b.slug ? -1 : 1;
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
 */
export function collectionNavigation(
  entries: readonly ContentEntry[],
  currentPath: string,
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
    const notes = [...uncollected].sort(byTitleThenSlug).map(note);
    groups.push({
      label: UNCOLLECTED_LABEL,
      notes,
      // Marked only by the note being read: this group has no index route, so a
      // path can never select it on its own.
      isCurrent: notes.some((member) => member.isCurrent),
    });
  }

  return groups;
}
