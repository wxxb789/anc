/**
 * The site's absolute public identity, and the two XML artifacts derived from it.
 *
 * Everything above this module speaks in routes — `/notes/<slug>/`. A canonical
 * link, a feed entry, and a sitemap entry all need the same thing instead: the
 * one absolute URL that names a page for the rest of the internet. That
 * conversion, and the escaping every consumer of it needs, live here once.
 *
 * Three properties are load-bearing:
 *
 * 1. **Neither the origin nor the site name is written here.** The origin is
 *    `site:` in `astro.config.mjs`, and it arrives as the `URL` Astro derives
 *    from it; the name arrives through {@link SITE_TITLE_VARIABLE}. Both are the
 *    *user's*, not this project's — a stranger builds their own notes with this
 *    tool, and a module that hardcoded either would put one owner's identity on
 *    every site built with it. That is plan decision D2, and it is why
 *    {@link SITE_NAME} is a lookup rather than a literal.
 * 2. **Output is deterministic.** Nothing here reads a clock. Every timestamp
 *    comes from an artifact field, and the one case the artifact cannot supply
 *    is a named sentinel rather than "now" — see {@link UNDATED}.
 * 3. **Escaping is total.** {@link escapeXml} is the only path text takes into
 *    an XML document, and it handles the characters XML cannot represent at all
 *    as well as the five it represents with entities.
 */

import type { ContentEntry } from './schema.ts';
import { noteRoute } from './route-path.ts';
import { NAV_LANGUAGE, translate } from './translations.ts';
import {
  FIXED_ROUTES,
  collectionFacets,
  collectionRoute,
  recentFirst,
  tagFacets,
  tagRoute,
} from './routes.ts';

/**
 * The environment variable carrying the configured site title into the build.
 *
 * **A seam rather than an import, and the import was tried and measured to be
 * impossible.** The obvious shape is
 * `export const SITE_NAME = configForBuild().title`, reading
 * `scripts/load-config.ts` directly. It fails the build, and not on style:
 * Astro bundles this module into `dist/.prerender/`, so every module it pulls
 * in is evaluated from *there*. `load-config.ts` imports `write-report.ts`,
 * which reads `../package.json` at module scope through `import.meta.url` —
 * and from inside the prerender directory that resolves to
 * `dist/.prerender/package.json`, which does not exist. Measured: the build
 * reaches "generating static routes" and dies with
 * `ENOENT: … dist\.prerender\package.json`.
 *
 * That is the same hazard `src/lib/artifact-source.ts` documents for the
 * artifact path and answers the same way, which is why this is the existing
 * pattern rather than a new one: `CONTENT_ARTIFACT` crosses this boundary
 * already, is read at module scope exactly like this, and is set by whoever
 * starts the build. `astro.config.mjs` is where that happens, because it is the
 * one place that has both the loaded configuration and a guarantee of running
 * before any page module is evaluated.
 */
export const SITE_TITLE_VARIABLE = 'PUBLISH_SITE_TITLE';

/**
 * The site name a build gets when nothing has configured one.
 *
 * **This is a second copy of `scripts/load-config.ts`'s `DEFAULT_TITLE`, and
 * the duplication is deliberate, measured, and gated.** That module owns the
 * default for a *configured* build and cannot be imported here for the reason
 * {@link SITE_TITLE_VARIABLE} records. The repository's own answer to that
 * situation is already written down one directory away: `theme-init.js` and
 * `preferences.ts` duplicate their storage keys because one of them cannot
 * import, and `tests/design-tokens.test.ts` asserts the two agree. This follows
 * it — `tests/config.test.ts` reads this constant out of this file and fails if
 * it ever differs from the loader's, so a rename cannot be half-applied.
 *
 * **A generic noun, and it belongs to nobody.** It is not this project's name,
 * which is the whole of plan decision D2: a stranger who has written notes and
 * configured nothing gets a site that is honest about being unnamed rather than
 * one that is confidently wrong about whose it is. `Notes` is legible, is
 * obviously a placeholder to anyone who sees it in a browser tab, and names the
 * thing on the page.
 */
export const DEFAULT_SITE_TITLE = 'Notes';

/**
 * The site's own name: the user's configured `title`, or the neutral default.
 *
 * A proper noun of the *user's* site rather than of this tool, so it is not
 * chrome TK-16 translates — a site called `Notes` is called that on its Chinese
 * pages too, exactly as a site called `Foundry` would be.
 *
 * `||` rather than `??`, and `src/lib/artifact-source.ts` records the same
 * choice for the same measured reason: an *empty* environment variable is how a
 * shell unsets one for a single command, and `??` would accept `''` as a title —
 * producing `<title> · </title>` and an Atom feed whose required `atom:title`
 * is blank. The loader has already refused an empty configured title; this
 * refuses an empty *seam*, which is a different failure with the same output.
 */
export const SITE_NAME: string = process.env[SITE_TITLE_VARIABLE] || DEFAULT_SITE_TITLE;

/**
 * A page's description, or the fallback its own language gives it.
 *
 * The fallback is passed in rather than read from a module constant because it
 * is chrome, and chrome is per document since TK-16: a Chinese note with an
 * empty excerpt must describe itself in Chinese. `Layout.astro` passes
 * `t.siteDescription`, resolved from the document's own `language`.
 *
 * Reachable, not defensive. `excerpt` is the one required string the content
 * contract admits empty (`src/lib/schema.ts` exempts it from the non-empty
 * check), the note page passes it straight through as the page description, and
 * a default parameter only fires on `undefined` — so a note with an empty
 * excerpt shipped `<meta name="description" content="">` and would have shipped
 * an empty `og:description` beside it. The fixture corpus has exactly one such
 * note, `minimal-note`, and no gate had ever looked.
 *
 * An empty description is worse than a generic one: a search engine and a social
 * card both fall back to scraping the page when the tag is absent, and both
 * render nothing when it is present and empty.
 */
export function describe(description: string | undefined, fallback: string): string {
  return description === undefined || description.trim() === '' ? fallback : description;
}

/** Where the Atom feed is served. `rss` is a reserved route segment (TK-01). */
export const FEED_PATH = '/rss.xml';

/** Where the sitemap is served. `sitemap` is a reserved route segment (TK-01). */
export const SITEMAP_PATH = '/sitemap.xml';

/**
 * The social card a site serves, when it has one — and no site has one yet.
 *
 * **`undefined` is the shipped state, and it is a decision rather than a gap.**
 * A card lived at `/og-card.png` and shipped inside the package, so every site
 * built with this tool served *one owner's* wordmark as its `og:image`. TK-24
 * measured that and kept it, reasoning that excluding the file would make every
 * build 404 its own card and that a broken card is worse than a borrowed one.
 * The first half of that is right and the second does not follow: the choice is
 * not between a broken card and a bland one, it is between a broken card and
 * **no card**, and an absent `og:image` is a well-defined thing every consumer
 * already handles by falling back to the page's title and description — both of
 * which now carry the user's own configured name.
 *
 * So the tags are emitted only when this is a path, and a build with no card
 * emits no `og:image`, no `og:image:alt`, and no `twitter:card`. See
 * `src/components/SiteMetadata.astro` for why the third goes with the other two.
 *
 * **Typed as `string | undefined` against a value that is always `undefined`
 * today**, which would ordinarily be speculative generality. It is not, for a
 * reason worth stating: this is the seam a user's own configured card arrives
 * on, plan §4.2's `brand.socialCard`, and the alternative to naming it is
 * deleting every card-shaped line and rediscovering the conditional later. The
 * config key deliberately does **not** exist yet — an unread key is worse than
 * an absent one — so the follow-up is to read it here and nothing else.
 */
export const SOCIAL_CARD_PATH: string | undefined = undefined;

/**
 * Said whenever the origin is needed and `site:` is not configured.
 *
 * A missing origin is not a degradation to route-relative output: a canonical
 * link, a feed id, and a `<loc>` are absolute by definition, and emitting a
 * relative one produces a document that is valid and wrong. Failing the build
 * is the only honest answer, and it names the file to edit.
 */
const NO_SITE =
  'astro.config.mjs declares no `site:`, so no canonical URL can be formed. ' +
  'Set it to the origin this projection is served from.';

/**
 * The absolute URL of a site-relative route.
 *
 * `new URL` rather than string concatenation, and that is not a style
 * preference: a route key may be any script the artifact carries, so
 * `/tags/笔记/` is an ordinary public route here. `URL` percent-encodes the path
 * to RFC 3986, which is what a `<loc>`, an `<id>`, and a canonical `<link>` all
 * require, and it resolves the origin's own trailing slash correctly whether
 * `site:` was written with one or without.
 */
export function canonicalUrl(site: URL | undefined, path: string): string {
  if (site === undefined) throw new Error(NO_SITE);
  return new URL(path, site).href;
}

/**
 * Characters XML 1.0 cannot carry at all, under any escaping.
 *
 * The `Char` production admits `#x9 | #xA | #xD | [#x20-#xD7FF] |
 * [#xE000-#xFFFD] | [#x10000-#x10FFFF]`. Everything outside it — the C0
 * controls other than tab, newline, and carriage return, the two BMP
 * noncharacters, and any unpaired surrogate — makes a document ill-formed. There
 * is no entity for them: `&#1;` is itself illegal in XML 1.0. They can only be
 * removed.
 *
 * This is reachable rather than theoretical. `src/lib/schema.ts` rejects control
 * characters in `tags` and `aliases` only; `title`, `excerpt`, and `description`
 * are checked for emptiness and for privacy markers, so a title carrying U+0001
 * validates cleanly and would then produce a feed no reader can parse.
 *
 * Written with `\u` escapes rather than the literal characters, deliberately: a
 * source file containing a literal NUL is *binary* to `grep`, to `git diff`, and
 * to a reviewer's editor — so the one file that most needs reading during a
 * security review would be the one nobody can read. This was not hypothetical;
 * the first draft of this file had exactly that defect.
 *
 * The surrogate clauses match a high surrogate not followed by a low one, and a
 * low surrogate not preceded by a high one — a well-formed pair encodes a
 * character in `[#x10000-#x10FFFF]`, which is admitted, and must survive.
 */
// oxlint-disable-next-line no-control-regex -- removing them is the entire point
const XML_FORBIDDEN = new RegExp(
  [
    // C0 controls, minus the tab, line feed, and carriage return XML admits.
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]',
    // The two BMP noncharacters the `Char` production excludes.
    '[\\uFFFE\\uFFFF]',
    // A high surrogate with no low surrogate following it.
    '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])',
    // A low surrogate with no high surrogate preceding it.
    '(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  ].join('|'),
  'g',
);

/**
 * Text, as an XML document may carry it.
 *
 * One function for element content and for attribute values rather than two.
 * The split is a real distinction in the specification — `"` only has to be
 * escaped inside an attribute — but a codebase with two escapers has a place to
 * call the wrong one, and the extra four characters cost nothing.
 *
 * `&` is replaced first. Replacing it after `<` would rewrite the `&` of the
 * `&lt;` just produced into `&amp;lt;`, which renders the literal text `&lt;`.
 * The removal pass runs before all of them, so a forbidden character cannot
 * survive inside an entity this function wrote.
 *
 * `]]>` needs no special case: `>` is escaped unconditionally, so the sequence
 * cannot appear in output and no CDATA section can be closed early. Nothing here
 * emits CDATA either.
 *
 * The carriage return is escaped rather than passed through, and it is the one
 * character here that is not about markup injection. XML 1.0 §2.11 requires a
 * parser to normalize line endings *before* the application sees them: a literal
 * `\r\n` and a literal `\r` both arrive as `\n`. So a title containing a
 * carriage return would produce a perfectly well-formed document that parses
 * back to **different text than the artifact holds** — silent corruption rather
 * than a loud failure. `&#13;` survives normalization, because a character
 * reference is resolved after it. `\n` and `\t` need no such treatment in
 * element content, which is where they are already the thing they mean.
 */
export function escapeXml(value: string): string {
  return value
    .replace(XML_FORBIDDEN, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\r', '&#13;');
}

/**
 * The timestamp for a note the artifact carries no date for.
 *
 * Atom requires `atom:updated` on every entry and on the feed, so there is no
 * option to omit it. The three candidates were: the build clock, which destroys
 * determinism — the property this ticket is measured on; dropping undated notes
 * from the feed, which on the artifact as it stands today would publish an empty
 * feed, since the exporter emits no dates at all; and a sentinel.
 *
 * The sentinel wins because it is the only one that is both deterministic and
 * complete. The epoch is chosen precisely because no reader will mistake it for
 * a real publication date. Undated notes already sort last in
 * {@link recentFirst}, so they appear at the end of the feed as well.
 *
 * The exporter's missing date fields are the actual defect; it is TK-19's.
 */
export const UNDATED = '1970-01-01T00:00:00Z';

/**
 * An artifact date as the RFC 3339 timestamp Atom requires.
 *
 * A value carrying a time is already RFC 3339 — `src/lib/schema.ts` validates
 * exactly that shape — and is passed through byte for byte. A date-only value is
 * widened to midnight UTC.
 *
 * Deliberately not parsed and reformatted. Round-tripping through `Date` renders
 * `2026-05-18T22:40:00+08:00` in the build machine's zone, so the same artifact
 * would produce different bytes on two machines; and a date-only value parsed as
 * UTC midnight and formatted locally shifts to the previous day west of
 * Greenwich. Taking the artifact's own bytes is both deterministic and correct.
 */
export function rfc3339(value: string): string {
  return value.length === 10 ? `${value}T00:00:00Z` : value;
}

/** The instant a feed entry is stamped with: `updated`, else `created`, else the sentinel. */
function entryTimestamp(entry: ContentEntry): string {
  const value = entry.updated ?? entry.created;
  return value === undefined ? UNDATED : rfc3339(value);
}

/**
 * One XML element with text content.
 *
 * `required` distinguishes the two cases Atom actually has, and getting it wrong
 * is how a hand-written feed becomes non-conformant. `atom:title` has cardinality
 * exactly 1 on both the feed and every entry, so omitting it on empty text would
 * emit a document no conforming reader accepts; `atom:summary` is optional, so an
 * entry with an empty excerpt is better off with no element than with an empty
 * one. The default is `false` because omission is the safe direction for
 * everything optional.
 *
 * The empty-text case for a required element falls back to a single space rather
 * than to an empty element: `<title></title>` is legal XML but an empty Atom
 * title, which readers render as a blank row. This is unreachable through the
 * real loader — `src/lib/schema.ts` rejects an empty `title` — and it is handled
 * anyway because this module is pure and fixture-driven, and `src/lib/routes.ts`
 * states the governing principle: it must not depend on a caller having
 * validated first.
 */
function element(name: string, text: string, attributes = '', required = false): string[] {
  if (text === '') return required ? [`<${name}${attributes}> </${name}>`] : [];
  return [`<${name}${attributes}>${escapeXml(text)}</${name}>`];
}

/**
 * A timestamp, escaped like every other value this module writes.
 *
 * The module's own contract is that {@link escapeXml} is the *only* path text
 * takes into an XML document, and a date is text: `src/lib/schema.ts` validates
 * the shape, but this module is pure and fixture-driven and must not depend on a
 * caller having validated first. `renderSitemap` already escapes the same
 * primitive, and one artifact date receiving two treatments in one file is
 * exactly the inconsistency that outlives the reasoning behind it.
 */
function timestamp(value: string): string {
  return escapeXml(value);
}

/**
 * Whether an entry is published, as opposed to withdrawn.
 *
 * `status` is optional in the contract and absent from the artifact the exporter
 * emits today, so "no status" means published — which is what every entry in
 * `src/data/content.json` relies on.
 *
 * **This filter is deliberately narrow, and the narrowness is the honest part.**
 * TK-08's acceptance criterion is that the feed and the sitemap "contain only
 * published routes", so those two artifacts are filtered here. A withdrawn note's
 * *page* is still built and is still listed on `/` and `/recent/`, because that
 * is open owner decision D4 — "does a published-but-unlisted state exist?" — and
 * `docs/plans/quartz-parity-plan.md` recommends answering it by making withdrawal
 * remove the entry from the manifest entirely rather than by adding a
 * hide-from-some-surfaces state, which is the security-by-obscurity pattern it
 * criticizes in Quartz.
 *
 * So this is not access control and must not be mistaken for it. A sitemap is a
 * crawl *instruction* and a feed is a broadcast; not advertising withdrawn
 * content through either is correct regardless of how D4 lands. Suppressing the
 * page itself is a corpus-wide question with one answer, and it belongs to
 * whoever closes D4.
 */
export function isPublished(entry: ContentEntry): boolean {
  return entry.status !== 'tombstone';
}

/**
 * A feed entry's permanent identity.
 *
 * `public_id` when the artifact carries one, the canonical URL otherwise.
 *
 * This is the difference between a rename and a republication. RFC 4287 requires
 * an entry id that never changes for the life of the entry, and requirements
 * §9.3 states the two halves that make the URL unsuitable: "`public_id` is
 * immutable. `slug` is unique but **mutable** through an explicit redirect
 * record." So a slug rename — which owner decision Q4 explicitly permits —
 * changes the URL, and every reader that keys on the id shows the note a second
 * time as though it were new.
 *
 * A `tag:` URI rather than the bare identifier, because an Atom id must be an
 * IRI. The host is the site's own, so the identifier stays scoped to this
 * projection, and `public_id` is already a public field.
 *
 * The URL fallback keeps the feed working for the artifact as it stands today,
 * which carries no `public_id` at all — at the cost this comment names, for
 * exactly the entries the exporter has not yet given a stable identity.
 */
function entryId(entry: ContentEntry, url: string): string {
  if (entry.public_id === undefined) return url;
  return `tag:${new URL(url).host},2026:${entry.public_id}`;
}

/**
 * The Atom 1.0 feed of every published note.
 *
 * **Atom rather than RSS 2.0**, for one reason that matters to this corpus and
 * one that matters to this artifact. Atom carries `xml:lang` per entry, so a
 * bilingual projection can declare each note's own language — RSS 2.0 has a
 * single channel-level `<language>` and would have to pick one. And Atom's
 * timestamps are RFC 3339, which is the format the artifact already stores,
 * while RSS 2.0 requires RFC 822 with English month and day abbreviations: a
 * formatting step, with a locale hazard, for no gain.
 *
 * **Hand-written rather than a dependency**, per the ticket. The whole document
 * is forty lines. What makes that safe rather than the correctness hazard it
 * usually is: every piece of text goes through {@link escapeXml}, and
 * `tests/metadata.test.ts` proves the property directly — every `&` in the
 * output opens a known entity, no character outside XML's `Char` production
 * survives, and each escaped title decodes back to the artifact's title exactly.
 *
 * **`<summary>`, never `<content>`.** The summary is the artifact's `excerpt`,
 * which is the same public projection already served in
 * `public/content-index.json`. Putting the rendered body in a feed would publish
 * the article through a second channel with none of the page's sanitization
 * context, and the requirement is public-safe summaries only. An entry whose
 * excerpt is empty gets no `<summary>` at all rather than an empty one.
 */
export function renderFeed(site: URL | undefined, entries: readonly ContentEntry[]): string {
  // Withdrawn notes are not broadcast. See `isPublished` for why this filter is
  // here and not also over the page itself.
  const ordered = recentFirst(entries.filter(isPublished));
  const home = canonicalUrl(site, '/');
  const self = canonicalUrl(site, FEED_PATH);

  // `recentFirst` sorts by parsed instant with dated notes first, so the head of
  // the list carries the latest instant in the corpus. Reading it back out is
  // what keeps the feed's own `<updated>` off the build clock.
  const updated = ordered[0] === undefined ? UNDATED : entryTimestamp(ordered[0]);

  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    ...element('title', SITE_NAME, '', true),
    // The feed is the whole corpus rather than one document, so its own chrome
    // is the navigation language — the same rule every non-document route
    // follows. Each `<entry>` still carries its own `xml:lang` below, so a
    // reader's client knows which language each note is in.
    ...element('subtitle', translate(NAV_LANGUAGE).siteSubtitle),
    `<id>${escapeXml(home)}</id>`,
    `<link rel="alternate" type="text/html" href="${escapeXml(home)}"/>`,
    `<link rel="self" type="application/atom+xml" href="${escapeXml(self)}"/>`,
    `<updated>${timestamp(updated)}</updated>`,
    // Atom requires an author on every entry unless the feed declares one. The
    // site is the author: this projection names no person, and a feed is not the
    // place to start.
    `<author><name>${escapeXml(SITE_NAME)}</name></author>`,
  ];

  for (const entry of ordered) {
    const url = canonicalUrl(site, noteRoute(entry.slug));
    lines.push(
      entry.language === undefined ? '<entry>' : `<entry xml:lang="${escapeXml(entry.language)}">`,
      // Required with cardinality exactly 1 on an entry, so never omitted.
      ...element('title', entry.title, '', true),
      `<id>${escapeXml(entryId(entry, url))}</id>`,
      `<link rel="alternate" type="text/html" href="${escapeXml(url)}"/>`,
      `<updated>${timestamp(entryTimestamp(entry))}</updated>`,
      ...(entry.created === undefined
        ? []
        : [`<published>${timestamp(rfc3339(entry.created))}</published>`]),
      ...element('summary', entry.excerpt, ' type="text"'),
      '</entry>',
    );
  }

  lines.push('</feed>', '');
  return lines.join('\n');
}

/** A public page, and the date the artifact says it last changed. */
export interface PublicRoute {
  path: string;
  lastmod?: string;
}

/**
 * Every route a search engine should know about.
 *
 * The fixed routes, then notes in slug order, then tag and collection facets —
 * which {@link tagFacets} already returns in key order. Constructed rather than
 * sorted afterwards, so the order is a property of this function rather than of
 * a comparator, and two builds of one artifact list the same URLs in the same
 * places.
 *
 * `/404.html` is absent: it is the host's fallback for an unmatched request, not
 * a destination, and listing it invites a search engine to index it. `/rss.xml`
 * and `/sitemap.xml` are absent because a sitemap enumerates pages.
 *
 * `lastmod` is emitted for note routes only. A facet page changes whenever any
 * of its members does, and a fixed route changes when this repository does —
 * neither has a date in the artifact, and inventing one from the corpus would be
 * a guess a crawler would then trust. The element is optional; omitting it says
 * nothing, which is what is actually known.
 *
 * Notes are ordered by slug here while {@link renderFeed} orders by recency, and
 * the divergence is intentional: a sitemap is an unordered set a crawler reads
 * whole, so a stable alphabetical order keeps the diff between two builds
 * readable, while a feed is a timeline a reader consumes from the top. Both are
 * total orders, so both are deterministic.
 *
 * Facet routes are computed from the *unfiltered* corpus, deliberately. A tag
 * page lists only its published members, but the page itself exists as long as
 * any note carries the tag — deriving facets from the filtered set would drop a
 * live page from the sitemap whenever its last remaining member was withdrawn.
 */
export function publicRoutes(entries: readonly ContentEntry[]): PublicRoute[] {
  // Withdrawn notes are not advertised to crawlers; their pages are still built.
  // See `isPublished`.
  const notes = entries
    .filter(isPublished)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((entry) => ({ path: noteRoute(entry.slug), lastmod: entry.updated ?? entry.created }));

  return [
    ...FIXED_ROUTES.map((path) => ({ path })),
    ...notes,
    ...tagFacets(entries).map((facet) => ({ path: tagRoute(facet.key) })),
    ...collectionFacets(entries).map((facet) => ({ path: collectionRoute(facet.key) })),
  ];
}

/**
 * The sitemap, in the `sitemaps.org` 0.9 schema.
 *
 * `<lastmod>` takes the artifact's date verbatim: the W3C Datetime profile the
 * schema names admits a bare `YYYY-MM-DD`, so unlike Atom there is nothing to
 * widen, and widening would state a precision the artifact does not have.
 *
 * `<changefreq>` and `<priority>` are deliberately absent. Google has stated it
 * ignores both, and a number nobody reads is a number that goes stale silently.
 */
export function renderSitemap(site: URL | undefined, routes: readonly PublicRoute[]): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const route of routes) {
    lines.push(
      '<url>',
      `<loc>${escapeXml(canonicalUrl(site, route.path))}</loc>`,
      ...(route.lastmod === undefined ? [] : [`<lastmod>${escapeXml(route.lastmod)}</lastmod>`]),
      '</url>',
    );
  }

  lines.push('</urlset>', '');
  return lines.join('\n');
}

/**
 * `robots.txt`, generated rather than committed under `public/`.
 *
 * The `Sitemap:` directive takes an absolute URL, so a committed file would be
 * a second place the origin is written down — and the origin is the *user's*,
 * arriving from their configuration, which makes "the origin lives in exactly
 * one place" the difference between a build that follows the config and one
 * that ships a stale literal to every reader.
 *
 * The policy is to allow everything. Every page here is one the build was asked
 * to publish: the corpus is what discovery found minus what the user excluded,
 * so a page that exists is a page meant to be read, and a `Disallow` would be
 * theatre — it withholds nothing, since a rule naming a route also names it.
 * `/pagefind/` is left crawlable for the same reason: it is a search index
 * built from pages that are already public.
 */
export function renderRobots(site: URL | undefined): string {
  return ['User-agent: *', 'Allow: /', '', `Sitemap: ${canonicalUrl(site, SITEMAP_PATH)}`, ''].join('\n');
}

/**
 * The Open Graph locale for a BCP 47 language tag, or `undefined`.
 *
 * Open Graph defines the value as `language_TERRITORY`, so `zh-CN` becomes
 * `zh_CN`. A tag carrying no territory has **no valid Open Graph form**, and the
 * two honest options are to invent one or to say nothing.
 *
 * Saying nothing wins. Inventing `en_US` would assert a territory the artifact
 * never stated — this projection is bilingual zh-CN and English and is not
 * American — and emitting a bare `en` produces a value consumers discard, which
 * is the same outcome as omission plus a tag that looks answered. `<html lang>`
 * carries the exact BCP 47 tag on every page either way, and it is the
 * standardized signal a consumer should be reading.
 */
export function openGraphLocale(language: string): string | undefined {
  return language.includes('-') ? language.replaceAll('-', '_') : undefined;
}

/** The suffix every page's `<title>` carries, so a browser tab names the site. */
export const TITLE_SUFFIX = ` · ${SITE_NAME}`;

/**
 * A page's `<title>` as `og:title` should state it: without the site suffix.
 *
 * A social card renders `og:title` directly above `og:site_name`, so a page
 * whose `og:title` is "About · Notes" produces a card reading "About · Notes"
 * over "Notes". The suffix belongs in the `<title>`, where it names the browser
 * tab, and not in the card, where a separate field already carries it.
 *
 * Stripped rather than threaded through as a second prop. Every page composes
 * its title from the same literal, so the suffix is a property of the convention
 * rather than a guess — and the alternative widens `Layout`'s props and makes
 * every future page responsible for remembering a second title.
 *
 * The home page's title is the bare site name and carries no suffix, so it is
 * returned unchanged.
 */
export function socialTitle(title: string): string {
  return title.endsWith(TITLE_SUFFIX) ? title.slice(0, -TITLE_SUFFIX.length) : title;
}

/**
 * Whether a route may be indexed, and may therefore claim a canonical URL.
 *
 * `/404/` is the whole exception. The host serves that document's *body* in
 * response to any unmatched address, so the page has no address of its own: a
 * `rel="canonical"` on it would tell a crawler that every mistyped URL on this
 * site is canonically `/404/`, which is an instruction to index the error page
 * under arbitrary names. `noindex` says the true thing instead.
 */
export function isIndexable(path: string): boolean {
  return path !== '/404/' && path !== '/404.html';
}
