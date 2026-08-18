/**
 * The note-route path shape, split out so a browser script can import it.
 *
 * `routes.ts` holds the site's navigation, its facet grouping, and its redirect
 * map — none of which a client script needs. Importing it into one shipped a
 * dead copy of the whole site map to every reader: Rolldown could not drop the
 * `SITE_MAP` array literal, so it landed in the bundle as a no-op expression.
 *
 * This module is the part `link-preview.ts` actually needs, and nothing else.
 * `routes.ts` re-exports from here, so the route shape is still defined once.
 */

/** The top-level segment notes live under. Reserved by TK-01's slug validation. */
export const NOTES_SEGMENT = 'notes';

/** The canonical route for a published note. */
export function noteRoute(slug: string): string {
  return `/${NOTES_SEGMENT}/${slug}/`;
}

/**
 * Where a link to a note this build did not publish points.
 *
 * A single page, identical for every withheld target, saying that the note is
 * not published. It says nothing about *which* note — it cannot, because it is
 * one static page — so the only thing a reader learns here is what the link they
 * clicked already told them.
 *
 * **The segment is reserved, and that is not tidiness.** `markdown.ts`'s
 * `INTERNAL_HREF` rewrites any single-segment `/<slug>/` href through
 * `routeForSlug`, so without the reservation a user publishing a note named
 * `private` would have every withheld link on their site silently redirected to
 * *that note*. Measured against the regex: `/private/` matches it and
 * `/notes/x/` does not. `src/lib/schema.ts` carries the reservation and
 * `tests/route-model.test.ts` holds the pairing.
 *
 * Defined here rather than in `routes.ts` for the same reason {@link noteRoute}
 * is: `scripts/resolve-links.ts` needs it while writing a body, and importing
 * the site map into a traversal would tie the producer to the navigation.
 */
export const WITHHELD_ROUTE = '/private/';

/**
 * The accessible name a withheld link gets when the author wrote none.
 *
 * `[](note.md)` and `![](chart.png)` have no label at all, and under the rule
 * this replaced they degraded to nothing, so the case did not arise. Now they
 * become anchors, and an anchor with no text is one a screen reader announces as
 * its URL and a pointer user cannot see. The resolved branch has had the same
 * guard since TK-27, falling back to the target's slug; a withheld target has no
 * slug to fall back to, so the fallback is what the destination says about
 * itself.
 *
 * **Not resolved from `translations.ts`, and that is the same boundary
 * `resolve-links.ts` already keeps.** This text is written into the author's
 * *Markdown body*, which has one language — theirs — while chrome is resolved
 * per document at render time. Threading a locale into the traversal would make
 * the producer's output depend on a page's language, which is a different thing
 * from the label a body carries. English matches `NAV_LANGUAGE`, the fallback
 * every route that is not one document already renders.
 */
export const WITHHELD_LINK_TEXT = 'a note that is not published';

/**
 * Mirrors the slug shape TK-01 enforces, so a path that only looks like a note
 * route is not treated as one. The trailing slash is optional because a browser
 * may present either form before the host's own normalization runs.
 */
const NOTE_PATH = new RegExp(`^/${NOTES_SEGMENT}/([a-z0-9]+(?:-[a-z0-9]+)*)/?$`);

/** The slug in a `/notes/<slug>/` path, or `undefined` for any other path. */
export function noteSlugFromPath(pathname: string): string | undefined {
  return NOTE_PATH.exec(pathname)?.[1];
}
