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
import type { NavLabelKey } from './translations.ts';
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
/** The site-wide graph route. Reserved by TK-01, filled by TK-17. */
export const GRAPH_SEGMENT = 'graph';

export function tagRoute(key: string): string {
  return `/${TAGS_SEGMENT}/${key}/`;
}

export function collectionRoute(key: string): string {
  return `/${COLLECTIONS_SEGMENT}/${key}/`;
}

/**
 * The vocabulary a public route key may use.
 *
 * Wider than the `[a-z0-9-]` slug shape TK-01 enforces, because a tag is free
 * text in any script: `笔记`, `हिन्दी`, and `tiếng việt` must all produce a
 * readable key. Combining marks are admitted for exactly that reason — Devanagari
 * vowel signs and Vietnamese tone marks are `\p{M}`, and excluding them would
 * reject those languages outright.
 *
 * What it excludes is what a public route segment must never carry: a leading or
 * trailing hyphen, a doubled hyphen, and anything that is not a letter, digit,
 * mark, or underscore.
 *
 * Underscore is a word character here, not a separator, so it is neither
 * trimmed nor collapsed: `snake_case_tag` and `_ops_` are readable keys a
 * reader would recognize, and `github-slugger` preserves them from the label
 * rather than manufacturing them from punctuation. The hyphen rules exist
 * because a hyphen is what the slugger *substitutes* for stripped characters,
 * which is how a gap becomes a separator nobody wrote.
 */
const ROUTE_KEY = /^[\p{L}\p{N}\p{M}_]+(?:-[\p{L}\p{N}\p{M}_]+)*$/u;

/**
 * At least one visible letter or digit. A key of only combining marks satisfies
 * {@link ROUTE_KEY} but is an invisible public URL.
 */
const ROUTE_KEY_SUBSTANCE = /[\p{L}\p{N}]/u;

/**
 * Characters a renderer draws as nothing: the emoji variation selector U+FE0F,
 * the zero-width joiner, soft hyphens, and the bidi controls.
 *
 * U+FE0F is why this is a separate rule rather than a clause of
 * {@link ROUTE_KEY}: it is a *nonspacing mark*, so `\p{M}` admits it, and
 * `⚠️ warning` would otherwise key a route whose first character is invisible.
 */
const INVISIBLE_IN_KEY = /\p{Default_Ignorable_Code_Point}/gu;

/** Whether a string is usable, as-is, as a public route segment. */
export function isRouteKey(key: string): boolean {
  return ROUTE_KEY.test(key) && ROUTE_KEY_SUBSTANCE.test(key);
}

/**
 * A label's public route key: slugified, then cleaned into the route vocabulary.
 *
 * `github-slugger` strips emoji and most punctuation *without* closing the gap
 * they leave, so `🌱 seedling` becomes `-seedling`, `seedling 🌱` becomes
 * `seedling-`, and `Ops & SRE` becomes `ops--sre` — a leading, a trailing, and a
 * doubled separator, all of which were emittable public URLs. A tag of `---`
 * survived whole and routed to `/tags/---/`.
 *
 * Cleaning rather than rejecting, because an emoji tag is ordinary in a digital
 * garden and `🌱 seedling` has one obvious, readable answer. What matters is not
 * that the key is unaltered but that it stays a **pure function of this one
 * label**: nothing here reads another tag, a position, or a corpus size, so
 * publishing a new tag can never move an existing tag's URL. That is the same
 * property that rules out a numeric disambiguating suffix.
 *
 * Unicode is normalized to NFC first, so a label typed with a combining accent
 * and one typed with the precomposed character produce the same key rather than
 * two indistinguishable public URLs. That is also a build-correctness matter:
 * these keys become directory names, and macOS normalizes filenames, so the two
 * forms would collide on disk on one platform and not on another.
 *
 * When cleaning leaves nothing addressable — `---`, `...`, `½` — there is no
 * answer to invent, and {@link facets} fails the build.
 */
export function routeKey(label: string): string {
  return slugify(label.normalize('NFC'))
    .normalize('NFC')
    .replace(INVISIBLE_IN_KEY, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Whether two labels are spellings of the same thing rather than a collision.
 *
 * Compared after the same normalizations {@link routeKey} applies, because the
 * two questions have to agree: if `café` and `café` produce one key, they
 * must also count as one label, or the merge that key implies becomes a build
 * failure the exporter cannot fix — the two are indistinguishable on screen.
 *
 * Case folding is what makes `Gardening` and `gardening` one tag. It is
 * `toLowerCase`, which is ASCII-shaped: `straße` and `STRASSE` stay separate.
 * They also produce different keys, so the outcome is two pages rather than a
 * wrong merge — the safe direction.
 */
function sameLabel(a: string, b: string): boolean {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
}

/**
 * Said by both facet failures, because neither has a fix available here.
 *
 * The exporter authors tag text, and this repository never edits the artifact
 * by hand, so the only remedy is to change the label at the source. Saying so
 * in the message is the difference between a build failure someone can act on
 * and one they will try to patch in the wrong repository.
 */
const EXPORTER_OWNS_LABELS =
  'The label is authored by the exporter, so the fix belongs there: rename it in the ' +
  'private vault and re-export. Do not edit the generated artifact by hand.';

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
 *
 * Both failures name {@link EXPORTER_OWNS_LABELS}, because neither is fixable
 * from this repository: the exporter authors the tag text, so the only remedy
 * is to change it there and re-export.
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
      if (!isRouteKey(key)) {
        throw new Error(
          `${what} ${JSON.stringify(label)} has no URL-safe route key under ${base}: ` +
            `it reduces to ${JSON.stringify(key)}, which is not an addressable public route segment. ` +
            EXPORTER_OWNS_LABELS,
        );
      }
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { key, label, entries: [entry] });
        continue;
      }
      if (sameLabel(existing.label, label)) {
        // The smallest label wins, so which spelling survives does not depend on
        // the order entries appear in the artifact.
        if (label < existing.label) existing.label = label;
      } else {
        throw new Error(
          `${what}s ${JSON.stringify(existing.label)} and ${JSON.stringify(label)} ` +
            `both route to ${base}${key}/. ` +
            EXPORTER_OWNS_LABELS,
        );
      }
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
  return facets(entries, (entry) => entry.tags ?? [], routeKey, 'tag', `/${TAGS_SEGMENT}/`);
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

/** One permanent redirect from an old public path to its current route. */
export interface Redirect {
  from: string;
  to: string;
  status: 301;
}

/**
 * Every public path this site has stranded, and where it goes now.
 *
 * **Empty, and that is the correct state.** TK-04 generated a pair of rules per
 * note migrating `/<slug>/` to `/notes/<slug>/`, but `/<slug>/` was never
 * publicly served: it was introduced at `3831ad0` and superseded at `04f8d9c`,
 * entirely within unpushed history, with no `site:` configured and no canonical
 * URL ever emitted. Redirecting from a URL nobody could hold is two rules per
 * note of pure cost, and it took a rule limit, a cycle walk, and forty lines of
 * comment with it. TK-12 deleted the rules and kept the mechanism.
 *
 * A rename that genuinely orphans a public URL adds its rule here. Owner
 * decision 3 — renames are delete-and-recreate, old URLs may 404 — means that
 * may never happen, which is why this is a literal rather than a derivation.
 *
 * ponytail: the deleted machinery included a `REDIRECT_LIMIT = 2000` guard for
 * Cloudflare Pages' rule ceiling, which existed because the old rules were
 * *derived* — two per note, so a large corpus could cross it without anyone
 * writing a line. A hand-written literal cannot: reaching 2,000 entries here
 * means typing 2,000 entries. Reinstate the check if rules ever become derived
 * again.
 */
export const REDIRECT_RULES: readonly Redirect[] = [];

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
  return [
    '# Generated from the content artifact at build time. Do not edit by hand.',
    `# schema_version: ${version.schema}`,
    `# content_version: ${version.content}`,
    ...rules.map((rule) => `${rule.from} ${rule.to} ${rule.status}`),
    '',
  ].join('\n');
}

/**
 * A link rendered in the site chrome.
 *
 * `label` names a translation key rather than holding the text, so this module
 * stays the record of *where* the site's routes are and never becomes a second
 * place one of its languages is written down. The key type admits only the
 * `nav*` entries, so a route cannot accidentally point at a sentence.
 */
export interface NavItem {
  href: string;
  label: NavLabelKey;
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
  { href: '/', label: 'navHome' },
  { href: '/recent/', label: 'navRecent' },
  { href: `/${TAGS_SEGMENT}/`, label: 'navTags' },
  { href: `/${COLLECTIONS_SEGMENT}/`, label: 'navCollections' },
  { href: `/${GRAPH_SEGMENT}/`, label: 'navGraph' },
  { href: '/about/', label: 'navAbout' },
  { href: '/privacy/', label: 'navPrivacy' },
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
  { href: '/#notes', label: 'navNotes' },
  { href: '/recent/', label: 'navRecent' },
  { href: `/${TAGS_SEGMENT}/`, label: 'navTags' },
  { href: `/${COLLECTIONS_SEGMENT}/`, label: 'navCollections' },
];
