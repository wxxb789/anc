/**
 * The public route model, and the versioned redirect map derived from it.
 *
 * This module is the in-repo record of every public route the site owns. It is
 * deliberately pure: it imports no artifact and holds no state, so every
 * function here can be exercised against synthetic fixtures, and so a client
 * script may import a route helper without pulling the content artifact into
 * the browser bundle. Pages pass `entries` in; this module never reaches for it.
 *
 * Two properties are load-bearing:
 *
 * 1. **Route keys are stable.** A note's route is a pure function of its slug,
 *    and a tag's route key is a pure function of that one tag's text. Nothing
 *    here disambiguates by position or by corpus size, so publishing a new note
 *    or a new tag can never silently move an existing public URL.
 * 2. **Grouping is never invented.** Tags and collections come from artifact
 *    fields. When the artifact carries none, the facet lists are empty and the
 *    index routes say so; no grouping is derived from anything else.
 */

import { slug as slugify } from 'github-slugger';
import type { ContentEntry } from './schema.ts';
import { NOTES_SEGMENT, noteRoute, noteSlugFromPath } from './route-path.ts';

/**
 * Re-exported so pages have one route module to import. The definitions live in
 * `route-path.ts` because `link-preview.ts` needs them in the browser, and
 * importing this module there would ship the whole site map as dead code.
 */
export { NOTES_SEGMENT, noteRoute, noteSlugFromPath };

/** The top-level segment tag pages live under. Reserved by TK-01. */
export const TAGS_SEGMENT = 'tags';
/** The top-level segment collection pages live under. Reserved by TK-01. */
export const COLLECTIONS_SEGMENT = 'collections';

/**
 * The route notes were published at before TK-04. Kept as the redirect source
 * so an already-shared URL keeps working; see {@link redirectRules}.
 */
export function legacyNoteRoute(slug: string): string {
  return `/${slug}/`;
}

export function tagRoute(key: string): string {
  return `/${TAGS_SEGMENT}/${key}/`;
}

export function collectionRoute(key: string): string {
  return `/${COLLECTIONS_SEGMENT}/${key}/`;
}

/** A tag or collection, with the notes that carry it. */
export interface Facet {
  /** URL-safe route key. Stable for a given label. */
  key: string;
  /** The label exactly as the artifact spells it. */
  label: string;
  /** Notes carrying this facet, sorted by title then slug. */
  entries: ContentEntry[];
}

/** Total order over notes: title, then the unique slug so no tie is left open. */
function byTitleThenSlug(a: ContentEntry, b: ContentEntry): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.slug < b.slug ? -1 : 1;
}

/**
 * Group entries by one metadata field.
 *
 * Labels differing only by case are one facet: `Gardening` and `gardening` are
 * the same tag, and splitting them would publish two pages saying the same
 * thing. The surviving label is the lexicographically smallest, so it does not
 * depend on the order entries appear in the artifact.
 *
 * Labels that genuinely differ but collapse to the same route key are a build
 * failure rather than a silent merge: `C++` and `C#` both slug to `c`, and
 * quietly folding them would put one tag's notes on the other tag's page. The
 * alternative — disambiguating with a numeric suffix — would make an existing
 * tag's public URL depend on what other tags exist, which breaks the stable
 * identity requirement. Failing names both labels so the exporter can fix it.
 */
function facets(
  entries: readonly ContentEntry[],
  labelsOf: (entry: ContentEntry) => readonly string[],
  keyOf: (label: string) => string,
  what: string,
  base: string,
): Facet[] {
  const groups = new Map<string, Facet>();
  for (const entry of entries) {
    for (const label of labelsOf(entry)) {
      const key = keyOf(label);
      if (key === '') {
        throw new Error(`${what} ${JSON.stringify(label)} has no URL-safe route key under ${base}`);
      }
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { key, label, entries: [entry] });
        continue;
      }
      if (existing.label.toLowerCase() !== label.toLowerCase()) {
        throw new Error(
          `${what}s ${JSON.stringify(existing.label)} and ${JSON.stringify(label)} ` +
            `both route to ${base}${key}/`,
        );
      }
      // The smallest label wins, so which spelling survives does not depend on
      // the order entries appear in the artifact.
      if (label < existing.label) existing.label = label;
      // One entry carrying two spellings of the same tag (`Gardening` and
      // `gardening`) is one note on that page, not two. TK-01's duplicate check
      // compares exact strings, so it admits the pair; the case merge is what
      // turns them into one facet, and this is what stops the note being listed
      // and counted twice on it. Entries arrive grouped by the outer loop, so
      // checking the last one is enough.
      if (existing.entries.at(-1) !== entry) existing.entries.push(entry);
    }
  }

  return [...groups.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((facet) => ({ ...facet, entries: [...facet.entries].sort(byTitleThenSlug) }));
}

/**
 * Tag facets, keyed by a slugified form of the tag text.
 *
 * Slugified rather than percent-encoded: a tag may be any text TK-01 admits,
 * including mixed zh-CN and English, and a percent-encoded route key would be
 * unreadable and awkward as a filename in static output.
 */
export function tagFacets(entries: readonly ContentEntry[]): Facet[] {
  return facets(entries, (entry) => entry.tags ?? [], slugify, 'tag', `/${TAGS_SEGMENT}/`);
}

/** Collection facets. TK-01 already validates `collection` as a slug, so it is its own key. */
export function collectionFacets(entries: readonly ContentEntry[]): Facet[] {
  return facets(
    entries,
    (entry) => (entry.collection === undefined ? [] : [entry.collection]),
    (label) => label,
    'collection',
    `/${COLLECTIONS_SEGMENT}/`,
  );
}

/**
 * The instant `/recent/` orders by: `updated` when present, else `created`.
 *
 * Parsed rather than compared as text, because an artifact may mix a date-only
 * value with a timestamp carrying an explicit offset, and `2026-08-06T12:00+08:00`
 * sorts before `2026-08-06T05:00:00Z` lexically while being the later instant.
 *
 * An unparseable value is reported as undated rather than as `NaN`. TK-01 has
 * already proven both fields parse, so this is unreachable through the real
 * loader — but `NaN !== NaN`, so leaving it would send a comparator down its
 * numeric branch and return `NaN`, which makes the sort order
 * implementation-defined. This module is pure and fixture-driven; it must not
 * depend on a caller having validated first.
 */
export function noteTimestamp(entry: ContentEntry): number | undefined {
  const value = entry.updated ?? entry.created;
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Notes in `/recent/` order: most recently updated first.
 *
 * The documented fallback for the artifact as it stands today, which carries
 * neither `updated` nor `created`: undated notes follow every dated note, in
 * ascending slug order. Slug is unique, so the result is a total order and two
 * builds of the same artifact produce the same page.
 */
export function recentFirst(entries: readonly ContentEntry[]): ContentEntry[] {
  return [...entries].sort((a, b) => {
    const left = noteTimestamp(a);
    const right = noteTimestamp(b);
    if (left !== right) {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return right - left;
    }
    return a.slug < b.slug ? -1 : 1;
  });
}

/** One permanent redirect from a legacy note path to its canonical route. */
export interface Redirect {
  from: string;
  to: string;
  status: 301;
}

/**
 * A permanent redirect for every published slug, sorted by source.
 *
 * Both `/<slug>/` and `/<slug>` are emitted. Cloudflare Pages compares a rule
 * source against the request path, and its documented trailing-slash behavior
 * covers its own `.html` normalization rather than user rules — so the
 * slash-less form of an already-shared URL is not guaranteed to reach the
 * slash form's rule. Two literal rules cost one line each and remove the
 * question; the alternative is discovering it against production.
 *
 * Cycles are impossible by construction rather than by check: every target
 * begins `/notes/`, and no source can, because a slug cannot contain `/`. The
 * test walks the emitted map anyway, so a future change to either route shape
 * fails loudly instead of shipping a redirect loop.
 */
export function redirectRules(entries: readonly ContentEntry[]): Redirect[] {
  return entries
    .flatMap((entry) => {
      const to = noteRoute(entry.slug);
      const slashed = legacyNoteRoute(entry.slug);
      return [
        { from: slashed, to, status: 301 as const },
        { from: slashed.slice(0, -1), to, status: 301 as const },
      ];
    })
    .sort((a, b) => (a.from < b.from ? -1 : 1));
}

/**
 * Cloudflare Pages' documented ceiling: 2,000 static plus 100 dynamic rules.
 * Past it the host rejects the file rather than truncating quietly, so the
 * build fails first, naming the count.
 */
export const REDIRECT_LIMIT = 2000;

/**
 * The rules as a Cloudflare Pages `_redirects` file.
 *
 * Format: `[source] [destination] [code]`, one rule per line, `#` for comments.
 * Emitted into the build output rather than committed, so it cannot drift from
 * the artifact it describes; `tests/built-routes.test.ts` asserts the built file
 * is exactly this projection.
 *
 * The header carries the schema and content version of the artifact the map was
 * generated from, per requirements section 20 ("Every artifact records
 * `schema_version` and `content_version`") — a deployed map is otherwise
 * impossible to tie back to the artifact that produced it. Both are comments,
 * which Cloudflare ignores, and both are public values: a schema number and a
 * hash of already-published content.
 */
export function renderRedirects(
  rules: readonly Redirect[],
  version: { schema: number; content: string },
): string {
  if (rules.length > REDIRECT_LIMIT) {
    throw new Error(
      `${rules.length} redirect rules exceeds the Cloudflare Pages limit of ${REDIRECT_LIMIT}`,
    );
  }
  return [
    '# Generated from the content artifact at build time. Do not edit by hand.',
    '# Legacy /<slug>/ paths move permanently to the canonical /notes/<slug>/ route.',
    `# schema_version: ${version.schema}`,
    `# content_version: ${version.content}`,
    ...rules.map((rule) => `${rule.from} ${rule.to} ${rule.status}`),
    '',
  ].join('\n');
}

/** A link rendered in the site chrome. */
export interface NavItem {
  href: string;
  label: string;
}

/**
 * Every route that exists for any artifact, including an empty one, with the
 * label the footer site map gives it.
 *
 * This list is why the site has no orphan route: the footer renders all of it
 * on every page, and the footer survives reader mode, which hides the header's
 * secondary links. Note, tag, and collection routes are absent because they
 * depend on the artifact — each is linked from the index that owns it.
 *
 * `404` is deliberately absent: it is the host's fallback for an unmatched
 * request, so it is reachable by definition and must not be linked as though it
 * were a destination a reader could choose.
 */
export const SITE_MAP: readonly NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/recent/', label: 'Recent' },
  { href: `/${TAGS_SEGMENT}/`, label: 'Tags' },
  { href: `/${COLLECTIONS_SEGMENT}/`, label: 'Collections' },
  { href: '/about/', label: 'About' },
  { href: '/privacy/', label: 'Privacy' },
];

/** The routes every build emits regardless of what the artifact contains. */
export const FIXED_ROUTES: readonly string[] = SITE_MAP.map((item) => item.href);

/**
 * Header navigation: the routes a reader moves between while reading.
 *
 * `/#notes` rather than a `/notes/` index — the home page already lists every
 * published note, and requirements section 9.1 defines no `/notes/` route, so a
 * second full listing would be one more page saying the same thing. About and
 * Privacy are read once, so they live in the footer site map only.
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/#notes', label: 'Notes' },
  { href: '/recent/', label: 'Recent' },
  { href: `/${TAGS_SEGMENT}/`, label: 'Tags' },
  { href: `/${COLLECTIONS_SEGMENT}/`, label: 'Collections' },
];
