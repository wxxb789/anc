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
 * Mirrors the slug shape TK-01 enforces, so a path that only looks like a note
 * route is not treated as one. The trailing slash is optional because a browser
 * may present either form before the host's own normalization runs.
 */
const NOTE_PATH = new RegExp(`^/${NOTES_SEGMENT}/([a-z0-9]+(?:-[a-z0-9]+)*)/?$`);

/** The slug in a `/notes/<slug>/` path, or `undefined` for any other path. */
export function noteSlugFromPath(pathname: string): string | undefined {
  return NOTE_PATH.exec(pathname)?.[1];
}
