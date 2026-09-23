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
 * The characters a note slug is made of: letters, numbers, and combining marks,
 * in any script.
 *
 * One definition, shared with `routes.ts`'s tag route-key vocabulary (which adds
 * `_`) and with `schema.ts`'s `isSlug`, so the producer, the contract, the
 * renderer's href rewrite, the Worker's lookup guard, and the publish-set
 * ledger cannot disagree about what a slug is. Kept in this browser-safe module
 * because `link-preview.ts` parses a slug out of `location.pathname`.
 *
 * Underscore is deliberately **not** a slug character, unlike in a tag key: a
 * slug is derived from a filename by replacing every run of anything else with
 * one hyphen, so `first_note.md` becomes `first-note` and `first_note` is not a
 * slug a producer could emit.
 */
export const SLUG_CHARACTERS = String.raw`\p{L}\p{N}\p{M}`;

const SLUG_SHAPE = new RegExp(`^[${SLUG_CHARACTERS}]+(?:-[${SLUG_CHARACTERS}]+)*$`, 'u');
/** At least one visible letter or digit; a slug of only combining marks is an invisible URL. */
const SLUG_SUBSTANCE = /[\p{L}\p{N}]/u;
/**
 * Code points a renderer draws as nothing. U+FE0F is a nonspacing mark, so
 * `\p{M}` alone would admit it; the rule is stated separately for that reason.
 */
export const INVISIBLE_CODE_POINTS = /\p{Default_Ignorable_Code_Point}/gu;
const INVISIBLE_CODE_POINT = /\p{Default_Ignorable_Code_Point}/u;

/**
 * The longest slug, in **UTF-8 bytes**, not UTF-16 units.
 *
 * A slug is a directory name in the output (`notes/<slug>/index.html`), and the
 * filesystems a site is built or served from cap a name at 255 bytes (ext4,
 * APFS) or 255 UTF-16 units (NTFS). Counted in UTF-16 units, a 128-character CJK
 * slug is 384 UTF-8 bytes and fails to write on Linux. 128 bytes is 128 ASCII
 * characters or about 42 CJK characters, and its percent-encoded URL form is at
 * most 384 characters.
 */
export const SLUG_MAX_BYTES = 128;

const UTF8 = new TextEncoder();

/** UTF-8 length, the unit {@link SLUG_MAX_BYTES} is stated in. */
export function utf8Length(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Whether a string is a canonical note slug.
 *
 * Lowercase (`toLowerCase` is the identity on it), NFC, free of invisible code
 * points, hyphen-separated runs of {@link SLUG_CHARACTERS}, at least one letter
 * or digit, and at most {@link SLUG_MAX_BYTES} bytes. The byte bound is part of
 * the grammar rather than a separate limit so that a browser-side parse and the
 * build agree on the same set.
 */
export function isNoteSlug(value: string): boolean {
  return (
    SLUG_SHAPE.test(value) &&
    SLUG_SUBSTANCE.test(value) &&
    !INVISIBLE_CODE_POINT.test(value) &&
    value === value.normalize('NFC') &&
    value === value.toLowerCase() &&
    utf8Length(value) <= SLUG_MAX_BYTES
  );
}

/**
 * One path segment (a folder or a filename stem) as slug text.
 *
 * NFC, Unicode lowercase, invisible code points removed, and every run of
 * anything that is not a letter, number, or mark replaced with one hyphen,
 * trimmed at both ends. `今天` stays `今天`, `Projects` becomes `projects`,
 * `Three laws` becomes `three-laws`, and `___` or `🌱` becomes `''` — which
 * the producer answers with a hash slug rather than inventing text.
 */
export function slugSegment(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .normalize('NFC')
    .replace(INVISIBLE_CODE_POINTS, '')
    .replace(new RegExp(`[^${SLUG_CHARACTERS}]+`, 'gu'), '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The canonical slug order: Unicode code point order.
 *
 * Not JavaScript's `<`, which compares UTF-16 code units and so sorts an astral
 * character (`𠀀`, U+20000, stored as surrogates D840 DC00) *before* U+FF41.
 * SQLite's `BINARY` collation compares UTF-8 bytes, which is code point order,
 * and every `ORDER BY slug` and `slug > :after` cursor in the snapshot uses it.
 * IDs are assigned in this order so that `ORDER BY id` and `ORDER BY slug`
 * agree; the publish-set ledger and the artifact's edge lists use it too.
 */
export function compareSlugs(a: string, b: string): number {
  if (a === b) return 0;
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
}

/**
 * The slug a single URL path segment names, or `undefined`.
 *
 * A browser presents `location.pathname` and `HTMLAnchorElement.pathname`
 * percent-encoded (`/notes/%E4%BB%8A%E5%A4%A9/`), while a build-time href may
 * carry the raw characters. Both are accepted: the segment is decoded (a
 * malformed escape is not a slug), NFC-normalised, and then validated, so an
 * encoded `/` or anything outside the grammar is refused.
 */
export function slugFromSegment(segment: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  const slug = decoded.normalize('NFC');
  return isNoteSlug(slug) ? slug : undefined;
}

/**
 * A path that only looks like a note route is not treated as one. The trailing
 * slash is optional because a browser may present either form before the
 * host's own normalization runs.
 */
const NOTE_PATH = new RegExp(`^/${NOTES_SEGMENT}/([^/]+)/?$`);

/** The slug in a `/notes/<slug>/` path, raw or percent-encoded, or `undefined` for any other path. */
export function noteSlugFromPath(pathname: string): string | undefined {
  const segment = NOTE_PATH.exec(pathname)?.[1];
  return segment === undefined ? undefined : slugFromSegment(segment);
}
