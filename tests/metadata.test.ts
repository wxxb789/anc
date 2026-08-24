/**
 * Canonical metadata, the Atom feed, the sitemap, and `robots.txt`.
 *
 * Two halves, deliberately. The unit half exercises `src/lib/site.ts` against
 * synthetic entries carrying input no corpus has yet produced — the escaping
 * tests are the reason this file exists, and they are written against hostile
 * strings rather than against the fixture corpus, which is well-behaved by
 * construction. The built half reads `dist/` and proves the emitted documents
 * describe the site that was actually built.
 *
 * The escaping property is the one worth stating plainly: a feed carries titles
 * and excerpts drawn from note content, and the artifact admits any text in
 * `title`, `excerpt`, and `description` — `src/lib/schema.ts` checks those three
 * for emptiness and for privacy markers, not for characters XML can represent.
 * So the gate below is not "does the happy path escape an ampersand" but "is
 * there any string for which this emits a document a parser rejects".
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { entries } from '../src/lib/content.ts';
import type { ContentEntry } from '../src/lib/schema.ts';
import { WITHHELD_ROUTE, noteRoute } from '../src/lib/routes.ts';
import {
  FEED_PATH,
  SITEMAP_PATH,
  SITE_NAME,
  SOCIAL_CARD_PATH,
  TITLE_SUFFIX,
  UNDATED,
  canonicalUrl,
  describe,
  escapeXml,
  isIndexable,
  isPublished,
  openGraphLocale,
  publicRoutes,
  renderFeed,
  renderRobots,
  renderSitemap,
  rfc3339,
  socialTitle,
} from '../src/lib/site.ts';
import { translate } from '../src/lib/translations.ts';

const DIST = new URL('../dist/', import.meta.url);

/** A stand-in origin. Never the configured one: these are unit tests. */
const SITE = new URL('https://example.test/');

/** A minimal valid entry; every field the metadata layer reads is overridable. */
function entry(slug: string, overrides: Partial<ContentEntry> = {}): ContentEntry {
  return {
    slug,
    title: slug,
    excerpt: '',
    markdown: `# ${slug}\n`,
    outgoing: [],
    backlinks: [],
    ...overrides,
  };
}

// --- Escaping -----------------------------------------------------------------

/**
 * Strings chosen to break a naive emitter, each for a different reason.
 *
 * The first four are what the ticket names — CJK, quotes, ampersands, angle
 * brackets — and the rest are the cases a template-literal feed gets wrong:
 * an already-escaped entity that must not be double-escaped into visible
 * `&amp;lt;`, a CDATA terminator, an XML declaration inside text, and the
 * characters XML 1.0 cannot carry under any escaping.
 */
const HOSTILE: readonly string[] = [
  'Ops & SRE',
  'A "quoted" title',
  "Someone's note",
  '<script>alert(1)</script>',
  '设计 · Design & 笔记',
  'a < b && c > d',
  '&amp; already escaped',
  'closing ]]> a section',
  '<?xml version="1.0"?>',
  'ampersand at end &',
  '&#0;&#x1;',
  'controlcharhere',
  'verticaltab',
  'noncharacter￾￿',
  'lone high \uD800 surrogate',
  'lone low \uDC00 surrogate',
  'emoji 🌱 seedling',
  'Step-by-Step, --no-verify, e-mail',
  // A carriage return is legal XML *and* silently rewritten by every parser:
  // §2.11 normalizes `\r\n` and bare `\r` to `\n` before the application sees
  // them, so passing one through emits a well-formed document that reads back as
  // different text than the artifact holds. `\n` and `\t` must survive as-is.
  'carriage\rreturn',
  'windows\r\nnewline',
  'tab\tand\nnewline',
];

/**
 * Decode the entities `escapeXml` produces, and nothing else.
 *
 * Written as a single pass with a lookup rather than five sequential
 * `replaceAll`s: decoding `&amp;` first would turn the escaped form of the
 * literal text `&lt;` back into a `<`, so a round-trip test built that way
 * would report a passing result for an emitter that had lost information.
 */
function decodeXml(value: string): string {
  const named: Readonly<Record<string, string>> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#13;': '\r',
  };
  return value.replace(/&(?:amp|lt|gt|quot|apos|#13);/g, (match) => named[match]!);
}

/** The characters XML 1.0's `Char` production admits. Mirrors `XML_FORBIDDEN`. */
function isXmlSafe(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const legal =
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    if (!legal) return false;
  }
  return true;
}

test('escaped text round-trips to the original, minus what XML cannot carry', () => {
  for (const value of HOSTILE) {
    const escaped = escapeXml(value);

    // Nothing survives that XML 1.0 forbids — not as a character, and not as a
    // numeric entity, which is itself illegal in XML 1.0 for these code points.
    assert.ok(isXmlSafe(escaped), `escaped form of ${JSON.stringify(value)} is not XML-safe`);

    // Every `&` in the output opens one of the entities this emitter writes: the
    // five named ones, or the `&#13;` a carriage return becomes. A stray bare
    // `&` is the single most common feed defect.
    for (const [index, character] of [...escaped].entries()) {
      if (character !== '&') continue;
      assert.match(
        escaped.slice(index),
        /^&(?:amp|lt|gt|quot|apos|#13);/,
        `${JSON.stringify(value)}: a bare "&" survives at ${index} in ${JSON.stringify(escaped)}`,
      );
    }

    // No markup can be opened, and no CDATA section closed.
    assert.doesNotMatch(escaped, /[<>]/, `${JSON.stringify(value)}: raw angle bracket survives`);
    assert.ok(!escaped.includes(']]>'), `${JSON.stringify(value)}: a CDATA terminator survives`);

    // Safe as an *attribute value* too, which is a distinct property from being
    // safe as element content. `escapeXml` is deliberately one function used in
    // both positions, and the feed does use it in both — `xml:lang="…"` and
    // every `href="…"` are attributes — so a quote surviving would terminate the
    // attribute and inject one. Without this the escaper could stop escaping
    // quotes entirely and every other assertion here would still pass; verified
    // by mutation.
    assert.ok(!escaped.includes('"'), `${JSON.stringify(value)}: a raw double quote survives`);
    assert.ok(!escaped.includes("'"), `${JSON.stringify(value)}: a raw single quote survives`);

    // And the text is preserved: decoding returns the input with exactly the
    // XML-illegal characters dropped. This is what stops the removal pass being
    // an escape hatch that silently eats content.
    const expected = [...value].filter(isXmlSafe).join('');
    assert.equal(decodeXml(escaped), expected, `${JSON.stringify(value)} did not round-trip`);
  }
});

test('escaping is idempotent in the sense that matters: escaped output re-parses', () => {
  // Escaping twice is not a no-op — `&` becomes `&amp;` becomes `&amp;amp;` —
  // and that is correct. What must hold is that the second pass still produces
  // a well-formed document, so an accidental double call is a visible defect
  // rather than a parse failure.
  for (const value of HOSTILE) {
    const twice = escapeXml(escapeXml(value));
    assert.ok(isXmlSafe(twice), `double-escaped ${JSON.stringify(value)} is not XML-safe`);
    assert.equal(decodeXml(decodeXml(twice)), [...value].filter(isXmlSafe).join(''));
  }
});

test('a hostile title reaches the feed and the sitemap escaped, not raw', () => {
  for (const value of HOSTILE) {
    const corpus = [entry('hostile', { title: value, excerpt: value, language: 'zh-CN' })];
    for (const document of [
      renderFeed(SITE, corpus),
      renderSitemap(SITE, publicRoutes(corpus)),
    ]) {
      assert.ok(isXmlSafe(document), `${JSON.stringify(value)}: emitted a document XML cannot carry`);
      // Balanced tags: every `<` opens a tag that closes. A raw `<` from the
      // payload would leave one open.
      const opens = (document.match(/</g) ?? []).length;
      const closes = (document.match(/>/g) ?? []).length;
      assert.equal(opens, closes, `${JSON.stringify(value)}: unbalanced angle brackets`);
      assert.ok(!document.includes('<script'), `${JSON.stringify(value)}: raw markup reached the document`);
    }
  }
});

/**
 * A deliberately strict well-formedness check over the emitted documents.
 *
 * Not a full XML parser — there is no parser in this dependency tree and the
 * ticket rules out adding one for this. What it does check is the class of
 * defect a hand-written emitter actually produces: unbalanced or misnested
 * elements, and text that escaped its element.
 */
function assertWellFormed(document: string, what: string): void {
  const stack: string[] = [];
  const body = document.replace(/^<\?xml[^?]*\?>\n/, '');
  assert.ok(!body.includes('<?'), `${what}: a processing instruction appears after the declaration`);

  // The third group is deliberately not destructured: whether a tag is
  // self-closing is read off the full match, because `[^>]*?` can end before a
  // trailing `/` and the group would then be empty on a tag that is self-closing.
  for (const [tag, closing, name] of body.matchAll(/<(\/?)([a-zA-Z][\w:.-]*)[^>]*?\/?>/g)) {
    const selfClosing = tag.endsWith('/>');
    if (closing === '/') {
      assert.equal(stack.pop(), name, `${what}: </${name}> does not close the open element`);
    } else if (!selfClosing) {
      stack.push(name!);
    }
  }
  assert.deepEqual(stack, [], `${what}: elements left open: ${stack.join(', ')}`);
}

// --- The feed -----------------------------------------------------------------

test('the feed is well-formed and lists every note once, in /recent/ order', () => {
  const corpus = [
    entry('b-note', { title: 'B', updated: '2026-01-02' }),
    entry('a-note', { title: 'A', updated: '2026-03-04' }),
    entry('c-note', { title: 'C' }),
  ];
  const feed = renderFeed(SITE, corpus);
  assertWellFormed(feed, 'the feed');

  const ids = [...feed.matchAll(/<id>([^<]*)<\/id>/g)].map(([, id]) => id!);
  assert.deepEqual(ids, [
    'https://example.test/',
    'https://example.test/notes/a-note/',
    'https://example.test/notes/b-note/',
    'https://example.test/notes/c-note/',
  ], 'the feed is not the corpus in /recent/ order, most recent first');

  // The feed's own `<updated>` is the newest entry's, never a build clock.
  assert.match(feed, /<feed[\s\S]*?<updated>2026-03-04T00:00:00Z<\/updated>/);
});

test('the feed carries a public-safe summary and never the note body', () => {
  const corpus = [
    entry('with-body', {
      title: 'Has a body',
      excerpt: 'The public excerpt.',
      markdown: '# Has a body\n\nA paragraph that must not be syndicated.\n',
    }),
  ];
  const feed = renderFeed(SITE, corpus);

  assert.match(feed, /<summary type="text">The public excerpt\.<\/summary>/);
  assert.ok(!feed.includes('must not be syndicated'), 'the feed carries the rendered note body');
  assert.ok(!feed.includes('<content'), 'the feed carries a <content> element');
});

test('an empty excerpt produces no summary element rather than an empty one', () => {
  const feed = renderFeed(SITE, [entry('bare', { excerpt: '' })]);
  assert.ok(!feed.includes('<summary'), 'an entry with no excerpt still emitted a summary');
  assertWellFormed(feed, 'the feed');
});

test('each entry declares its own language, and an entry without one declares none', () => {
  const feed = renderFeed(SITE, [
    entry('zh', { language: 'zh-CN' }),
    entry('en', { language: 'en' }),
    entry('none'),
  ]);
  assert.ok(feed.includes('<entry xml:lang="zh-CN">'), 'a zh-CN note does not declare its language');
  assert.ok(feed.includes('<entry xml:lang="en">'), 'an en note does not declare its language');
  assert.ok(feed.includes('<entry>\n<title>none'), 'a note with no language invented one');
});

test('dates come from the artifact, and an undated note gets the named sentinel', () => {
  const feed = renderFeed(SITE, [
    entry('dated', { created: '2025-11-02', updated: '2026-08-01T09:15:00Z' }),
    entry('created-only', { created: '2026-01-11' }),
    entry('undated'),
  ]);

  // An offset-bearing timestamp is passed through byte for byte: reformatting
  // it through `Date` would render it in the build machine's zone.
  const offset = renderFeed(SITE, [entry('tz', { updated: '2026-05-18T22:40:00+08:00' })]);
  assert.ok(offset.includes('<updated>2026-05-18T22:40:00+08:00</updated>'), 'an offset was rewritten');

  assert.ok(feed.includes('<published>2025-11-02T00:00:00Z</published>'), 'a date-only value was not widened');
  assert.ok(feed.includes('<updated>2026-08-01T09:15:00Z</updated>'));
  // `created` with no `updated` stamps both, from the one date the artifact has.
  assert.ok(feed.includes('<updated>2026-01-11T00:00:00Z</updated>'));
  assert.ok(feed.includes(`<updated>${UNDATED}</updated>`), 'an undated note got no sentinel');
  assert.equal(rfc3339('2026-01-11'), '2026-01-11T00:00:00Z');
  assert.equal(rfc3339('2026-01-11T05:00:00Z'), '2026-01-11T05:00:00Z');
});

test('an empty corpus produces a valid, empty feed rather than a throw', () => {
  const feed = renderFeed(SITE, []);
  assertWellFormed(feed, 'the empty feed');
  assert.ok(!feed.includes('<entry'), 'an empty corpus produced an entry');
  assert.ok(feed.includes(`<updated>${UNDATED}</updated>`), 'the empty feed has no <updated>');
});

test('a hostile language tag cannot break out of the xml:lang attribute', () => {
  // `language` is the one artifact field that reaches an *attribute* in the
  // feed. The content contract validates it as BCP 47, so this shape cannot
  // arrive today — but the escaper is what makes that a defence in depth rather
  // than a single point of failure, and an escaper is only proven by the input
  // it was not given.
  const feed = renderFeed(SITE, [
    entry('injected', { language: 'en" onload="alert(1)' as string }),
  ]);
  assert.ok(!feed.includes('onload="'), 'a quote in a language tag opened a new attribute');
  assert.ok(feed.includes('&quot;'), 'the quote was not escaped');
  assertWellFormed(feed, 'the feed with an injected language tag');
});

test('a carriage return survives XML line-ending normalization', () => {
  // The subtlest defect in a hand-written emitter, because the output is
  // *well-formed* either way. XML 1.0 §2.11 makes a parser translate `\r\n` and
  // bare `\r` to `\n` before the application sees the text, so a literal `\r`
  // round-trips to different text than the artifact holds — silent corruption,
  // not a parse error. A character reference is resolved after normalization and
  // therefore survives.
  assert.ok(escapeXml('a\rb').includes('&#13;'), 'a carriage return was passed through literally');
  assert.ok(!escapeXml('a\rb').includes('\r'), 'a literal carriage return survives');

  // A newline and a tab mean themselves in element content and must NOT be
  // escaped — doing so would be the mirror-image defect.
  assert.equal(escapeXml('a\nb\tc'), 'a\nb\tc', 'a newline or tab was needlessly escaped');
});

// --- The sitemap and robots.txt -----------------------------------------------

test('the sitemap lists every public route once, and no non-route', () => {
  const corpus = [
    entry('b-note', { tags: ['Gardening'], collection: 'engineering', updated: '2026-02-02' }),
    entry('a-note', { tags: ['gardening'] }),
  ];
  const sitemap = renderSitemap(SITE, publicRoutes(corpus));
  assertWellFormed(sitemap, 'the sitemap');

  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map(([, loc]) => loc!);
  assert.equal(new Set(locs).size, locs.length, 'the sitemap lists a URL twice');

  for (const path of ['/', '/recent/', '/tags/', '/collections/', '/about/', '/privacy/']) {
    assert.ok(locs.includes(`https://example.test${path}`), `the sitemap omits ${path}`);
  }
  assert.ok(locs.includes('https://example.test/notes/a-note/'));
  assert.ok(locs.includes('https://example.test/tags/gardening/'), 'a tag facet is missing');
  assert.ok(locs.includes('https://example.test/collections/engineering/'), 'a collection is missing');

  // Neither the error document nor the metadata files are destinations.
  for (const absent of ['/404', FEED_PATH, SITEMAP_PATH, '/robots.txt']) {
    assert.ok(
      !locs.some((loc) => loc.includes(absent)),
      `the sitemap lists ${absent}, which is not a page`,
    );
  }
});

test('lastmod is the artifact date, on note routes only', () => {
  const corpus = [
    entry('dated', { created: '2025-11-02', updated: '2026-02-02', tags: ['t'] }),
    entry('undated', { tags: ['t'] }),
  ];
  const sitemap = renderSitemap(SITE, publicRoutes(corpus));

  const blocks = [...sitemap.matchAll(/<url>\n<loc>([^<]*)<\/loc>\n(?:<lastmod>([^<]*)<\/lastmod>\n)?<\/url>/g)];
  const lastmod = new Map(blocks.map(([, loc, value]) => [loc!, value]));

  // Verbatim, not widened: the sitemap schema admits a bare calendar date, and
  // widening it would state a precision the artifact does not have.
  assert.equal(lastmod.get('https://example.test/notes/dated/'), '2026-02-02');
  assert.equal(lastmod.get('https://example.test/notes/undated/'), undefined);
  // A facet page has no date in the artifact, so it claims none.
  assert.equal(lastmod.get('https://example.test/tags/t/'), undefined);
  assert.equal(lastmod.get('https://example.test/'), undefined);
});

test('robots.txt allows everything and points at the sitemap', () => {
  const robots = renderRobots(SITE);
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/example\.test\/sitemap\.xml$/m);
  assert.ok(!robots.includes('Disallow'), 'the policy disallows a path but every page is reviewed');
});

// --- The origin ---------------------------------------------------------------

test('a URL is formed from the origin, with non-ASCII route keys encoded', () => {
  assert.equal(canonicalUrl(SITE, '/notes/a/'), 'https://example.test/notes/a/');
  // A tag route may be any script the artifact carries. `<loc>`, `<id>`, and a
  // canonical link all require the percent-encoded form.
  assert.equal(canonicalUrl(SITE, '/tags/笔记/'), 'https://example.test/tags/%E7%AC%94%E8%AE%B0/');
  // The origin's own trailing slash must not double the path's.
  assert.equal(canonicalUrl(new URL('https://example.test'), '/a/'), 'https://example.test/a/');
});

test('an unconfigured origin fails loudly and names the file to edit', () => {
  for (const render of [
    () => canonicalUrl(undefined, '/'),
    () => renderFeed(undefined, []),
    () => renderSitemap(undefined, [{ path: '/' }]),
    () => renderRobots(undefined),
  ]) {
    assert.throws(render, /astro\.config\.mjs/, 'a missing origin did not name the file to fix');
  }
});

test('the site suffix is stripped from a social title but not from a bare one', () => {
  assert.equal(socialTitle(`About${TITLE_SUFFIX}`), 'About');
  assert.equal(socialTitle(SITE_NAME), SITE_NAME);
  assert.equal(socialTitle(`A note about ${SITE_NAME}`), `A note about ${SITE_NAME}`);
});

test('an Open Graph locale needs a territory, and is omitted rather than invented', () => {
  assert.equal(openGraphLocale('zh-CN'), 'zh_CN');
  assert.equal(openGraphLocale('zh-Hans-CN'), 'zh_Hans_CN');
  // Open Graph's value is `language_TERRITORY`; a bare `en` has no valid form,
  // so the tag is omitted rather than shipped invalid or paired with an
  // invented `en_US` the artifact never stated.
  assert.equal(openGraphLocale('en'), undefined);
  assert.equal(openGraphLocale('zh'), undefined);
});

test('a withdrawn note is excluded from the feed and the sitemap, and only those', () => {
  const live = entry('live', { title: 'Live note' });
  const gone = entry('gone', { title: 'Withdrawn note', status: 'tombstone' });

  assert.equal(isPublished(live), true);
  assert.equal(isPublished(gone), false);
  // No `status` means published: the exporter does not emit the field today, so
  // reading its absence as "withdrawn" would empty the feed.
  assert.equal(isPublished(entry('bare')), true);

  const feed = renderFeed(SITE, [live, gone]);
  assert.ok(feed.includes('/notes/live/'), 'the live note is missing from the feed');
  assert.ok(!feed.includes('/notes/gone/'), 'a withdrawn note was broadcast');
  assert.ok(!feed.includes('Withdrawn note'), 'a withdrawn title was broadcast');

  const paths = publicRoutes([live, gone]).map((route) => route.path);
  assert.ok(paths.includes('/notes/live/'));
  assert.ok(!paths.includes('/notes/gone/'), 'a withdrawn note was advertised to crawlers');
});

test('a facet page survives its last published member being withdrawn', () => {
  // The page is still built and still reachable, so dropping it from the
  // sitemap would unlist a live route. Facets are computed from the whole
  // corpus for exactly this reason.
  const paths = publicRoutes([entry('gone', { status: 'tombstone', tags: ['orphaned'] })]).map(
    (route) => route.path,
  );
  assert.ok(paths.includes('/tags/orphaned/'), 'the tag page was dropped from the sitemap');
  assert.ok(!paths.includes('/notes/gone/'), 'the withdrawn note was listed');
});

test('a feed entry is identified by public_id when the artifact carries one', () => {
  // RFC 4287 requires an id that never changes, and requirements 9.3 makes the
  // slug explicitly mutable — so a URL id would duplicate the entry in every
  // reader after a rename.
  const feed = renderFeed(SITE, [
    entry('renameable', { public_id: 'pub-0001' }),
    entry('no-id'),
  ]);
  assert.ok(feed.includes('<id>tag:example.test,2026:pub-0001</id>'), 'public_id is not the entry id');
  // The fallback keeps the feed working for the artifact as it stands, which
  // carries no `public_id` at all.
  assert.ok(feed.includes('<id>https://example.test/notes/no-id/</id>'), 'no fallback id');
});

test('a required Atom element is never omitted, even for empty text', () => {
  // `atom:title` has cardinality exactly 1 on the feed and on every entry;
  // omitting it emits a document no conforming reader accepts. Unreachable
  // through the loader — the schema rejects an empty title — and handled because
  // this module is fixture-driven and must not assume a validated caller.
  const feed = renderFeed(SITE, [entry('empty', { title: '' })]);
  const titles = [...feed.matchAll(/<title>/g)];
  assert.equal(titles.length, 2, 'the feed or the entry lost its required title');
  assertWellFormed(feed, 'a feed with an empty title');
});

test('the error document and the withheld page are the only non-indexable routes', () => {
  // **Was "only the error document is non-indexable", which stopped being true
  // on 2026-08-17** when `/private/` joined it — and the name outlived the fact
  // by exactly as long as it took review to read it.
  //
  // The two are excluded for different reasons, and the difference is why this
  // gate names both rather than iterating a list. `/404/` has no address of its
  // own: the host serves its body for any unmatched request, so a canonical URL
  // on it would be false. `/private/` *is* served at its address; it is excluded
  // because every link to a withheld note points there carrying the target's
  // path as its text, so an indexed copy would be listed by a search engine
  // under the text of every withheld link on the site — the disclosure gathered
  // into one crawlable record rather than scattered across the bodies that
  // wrote it.
  //
  // **Asserted here as well as through the built sitemap**, because the sitemap
  // gate computes its expectation *with* `isIndexable` and `SiteMetadata.astro`
  // renders *with* `isIndexable`, so the two agree however this function
  // answers. Deleting the `WITHHELD_ROUTE` clause does turn that gate red — but
  // via a route-set mismatch, which is lesson 2 of `docs/gate-reading.md`: a red
  // for a reason other than the property named. This is the assertion that
  // fails for the right reason.
  assert.equal(isIndexable('/404/'), false);
  assert.equal(isIndexable('/404.html'), false);
  assert.equal(isIndexable(WITHHELD_ROUTE), false, 'the withheld page may not be indexed');
  for (const path of ['/', '/about/', '/notes/a/', '/tags/t/']) {
    assert.equal(isIndexable(path), true, `${path} is not indexable`);
  }
});

/**
 * An empty description is worse than a generic one.
 *
 * `excerpt` is the one required string the content contract admits empty, and
 * the note page passes it straight through — so this is a live artifact shape,
 * not a defensive check. A default parameter does not catch it, because a
 * default only fires on `undefined`.
 *
 * Since TK-16 the fallback is passed in rather than read from a module
 * constant, because it is chrome and chrome is per document — so the second
 * assertion below is the one that matters now: a Chinese note with an empty
 * excerpt must fall back to the Chinese sentence, not across a language.
 */
test('an empty or blank description falls back to the given fallback, never to nothing', () => {
  for (const language of ['en', 'zh-CN']) {
    const fallback = translate(language).siteDescription;
    for (const empty of [undefined, '', '   ', '\n\t']) {
      assert.equal(
        describe(empty, fallback),
        fallback,
        `${language}: ${JSON.stringify(empty)} did not fall back`,
      );
    }
  }
  // The two fallbacks are genuinely different sentences, or the loop above
  // proves only that one string equals itself twice.
  assert.notEqual(
    translate('en').siteDescription,
    translate('zh-CN').siteDescription,
    'the two locales share a fallback description, so the per-language check is vacuous',
  );
  assert.equal(
    describe('A real excerpt.', translate('en').siteDescription),
    'A real excerpt.',
    'a real description was replaced',
  );
});

// --- What the build actually emitted ------------------------------------------

function built(name: string): string {
  try {
    return readFileSync(new URL(name, DIST), 'utf8');
  } catch {
    return assert.fail(`dist/${name} is missing — run \`pnpm run build\` before \`pnpm test\``);
  }
}

/** Every HTML page the build wrote, excluding Pagefind's own bundle. */
function pages(): { route: string; html: string }[] {
  const found: { route: string; html: string }[] = [];
  const walk = (dir: URL, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'pagefind') continue;
      const child = new URL(name, dir);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, dir), `${prefix}${name}/`);
      else if (name === 'index.html') found.push({ route: prefix === '' ? '/' : `/${prefix}`, html: readFileSync(child, 'utf8') });
      else if (name.endsWith('.html')) found.push({ route: `/${prefix}${name}`, html: readFileSync(child, 'utf8') });
    }
  };
  walk(DIST, '');
  assert.ok(found.length > 0, 'the build produced no pages');
  return found;
}

const PAGES = pages();

/** The configured origin, read from the build's own output rather than restated. */
const ORIGIN = new URL(
  /<link rel="canonical" href="([^"]*)"/.exec(built('index.html'))?.[1] ??
    assert.fail('the home page declares no canonical URL'),
).origin;

test('every indexable page declares its own canonical URL, and the 404 declares none', () => {
  for (const { route, html } of PAGES) {
    const canonical = /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
    if (!isIndexable(route)) {
      assert.equal(canonical, undefined, `${route}: the error document claims a canonical URL`);
      assert.match(html, /<meta name="robots" content="noindex/, `${route}: is indexable`);
      continue;
    }
    assert.ok(canonical, `${route}: declares no canonical URL`);
    // Compared as an encoded URL, not as the raw route: a tag route may be any
    // script the artifact carries, and `/tags/开发笔记/` must reach the head as
    // the percent-encoded form a crawler can dereference. Comparing raw strings
    // here would demand the wrong thing.
    assert.equal(
      canonical,
      canonicalUrl(new URL(ORIGIN), route),
      `${route}: declares a canonical URL that is not its own`,
    );
    assert.equal(
      (html.match(/<link rel="canonical"/g) ?? []).length,
      1,
      `${route}: declares more than one canonical URL`,
    );
  }
});

test('every page carries complete Open Graph and Twitter card metadata', () => {
  for (const { route, html } of PAGES) {
    const meta = new Map(
      [...html.matchAll(/<meta (?:property|name)="((?:og|twitter|article):[^"]*)" content="([^"]*)"/g)].map(
        ([, key, value]) => [key!, value!],
      ),
    );

    for (const required of [
      'og:type',
      'og:site_name',
      'og:title',
      'og:description',
      'og:url',
    ]) {
      const value = meta.get(required);
      assert.ok(value !== undefined && value !== '', `${route}: ${required} is missing or empty`);
    }

    assert.equal(meta.get('og:site_name'), SITE_NAME);

    /**
     * The three card tags are present exactly when a card is configured, and
     * absent together when one is not.
     *
     * **A stronger assertion than the unconditional one it replaces, which is
     * what TK-31 traded for it.** `og:image` used to be required on every route
     * and pointed at a card shipped inside this package — so every site built
     * with this tool served one owner's wordmark. The card is gone and
     * `SOCIAL_CARD_PATH` is `undefined`; a user's own card is a later ticket,
     * and this row is written to be correct under both.
     *
     * The tags travel as a set deliberately: `og:image:alt` labelling a
     * non-existent image, or `twitter:card=summary_large_image` reserving a
     * large image region with nothing to put in it, are each worse than
     * silence. So the check is that all three agree, not that each is present.
     */
    for (const tag of ['og:image', 'og:image:alt', 'twitter:card']) {
      const value = meta.get(tag);
      if (SOCIAL_CARD_PATH === undefined) {
        assert.equal(value, undefined, `${route}: emits ${tag} while no social card is configured`);
      } else {
        assert.ok(value !== undefined && value !== '', `${route}: ${tag} is missing or empty`);
      }
    }
    if (SOCIAL_CARD_PATH !== undefined) {
      assert.equal(meta.get('og:image'), `${ORIGIN}${SOCIAL_CARD_PATH}`);
      assert.equal(meta.get('twitter:card'), 'summary_large_image');
    }

    // `og:url` agrees with the canonical link wherever there is one.
    const canonical = /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
    if (canonical !== undefined) {
      assert.equal(meta.get('og:url'), canonical, `${route}: og:url and the canonical link disagree`);
    }

    // `og:locale` is the document's own declared language, and is present
    // exactly when that language names a territory — Open Graph has no valid
    // form for a bare `en`, so the tag is omitted rather than shipped invalid.
    const lang = /<html[^>]*\slang="([^"]+)"/.exec(html)?.[1];
    assert.ok(lang, `${route}: declares no language`);
    assert.equal(
      meta.get('og:locale'),
      openGraphLocale(lang),
      `${route}: og:locale does not match <html lang="${lang}">`,
    );

    // The title in the card is not the tab title: the suffix would print the
    // site's name twice, directly above `og:site_name`.
    assert.ok(
      !meta.get('og:title')!.includes(TITLE_SUFFIX.trim()) || meta.get('og:title') === SITE_NAME,
      `${route}: og:title carries the site suffix that og:site_name already states`,
    );
  }
});

test('a note page types itself as an article and states the dates the artifact carries', () => {
  // Guarded, not assumed: every assertion below is inside a `for` over the
  // corpus, so an empty artifact would pass this test having checked nothing.
  // `built-routes.test.ts:425` guards exactly this case for the same reason.
  assert.ok(entries.length > 0, 'the artifact has no notes, so no article metadata can be checked');
  for (const note of entries) {
    const html = built(`notes/${note.slug}/index.html`);
    const meta = new Map(
      [...html.matchAll(/<meta property="((?:og|article):[^"]*)" content="([^"]*)"/g)].map(
        ([, key, value]) => [key!, value!],
      ),
    );

    assert.equal(meta.get('og:type'), 'article', `${note.slug}: a note is not typed as an article`);
    assert.equal(
      meta.get('article:published_time'),
      note.created === undefined ? undefined : rfc3339(note.created),
      `${note.slug}: article:published_time does not match the artifact`,
    );
    assert.equal(
      meta.get('article:modified_time'),
      note.updated === undefined ? undefined : rfc3339(note.updated),
      `${note.slug}: article:modified_time does not match the artifact`,
    );
  }

  // Every page that is not a note is a website, not an article.
  for (const { route, html } of PAGES) {
    if (route.startsWith('/notes/')) continue;
    assert.match(html, /<meta property="og:type" content="website"/, `${route}: is typed as an article`);
    assert.ok(!html.includes('article:published_time'), `${route}: states an article publication date`);
  }
});

test('every page offers the feed, and the card image was actually built', () => {
  for (const { route, html } of PAGES) {
    // The feed's title is chrome, so since TK-16 it is in the page's own
    // language — a Chinese note offers "anc — 全部笔记". The href and
    // the type are what make the link a feed and are the same everywhere; the
    // title is resolved from the document rather than restated in English, or
    // this gate would fail on every Chinese page for a reason that has nothing
    // to do with feed discovery.
    const lang = /<html lang="([^"]+)"/.exec(html)?.[1];
    assert.ok(lang !== undefined, `${route}: declares no language`);
    assert.ok(
      html.includes(
        `<link rel="alternate" type="application/atom+xml" ` +
          `title="${translate(lang).feedTitle(SITE_NAME)}" href="${ORIGIN}${FEED_PATH}">`,
      ),
      `${route}: does not offer the feed in its own language (lang="${lang}")`,
    );
  }
  /**
   * `og:image` names a file that exists, or there is no `og:image`.
   *
   * **The assertion's subject moved with TK-31 and the property it protects did
   * not.** It used to be "the social card is present and non-empty", because a
   * card that 404s is worse than no card — a consumer renders a broken image
   * rather than falling back to text. That argument is sound and was being used
   * to justify shipping *this owner's* card inside the package, which every site
   * built with this tool then served.
   *
   * The card is gone. What survives is the same rule stated as a biconditional:
   * whatever `og:image` says, that file is in `dist/`. Today `SOCIAL_CARD_PATH`
   * is `undefined`, so the branch taken is that nothing points at a card and no
   * card ships; when a user configures one, the other branch checks the file
   * they named is really there. Neither branch admits a dangling `og:image`,
   * which is the whole of what the original gate was for.
   */
  if (SOCIAL_CARD_PATH === undefined) {
    assert.ok(
      !built('index.html').includes('og:image'),
      'a page declares og:image while no social card is configured, so it points at nothing',
    );
    assert.ok(
      !existsSync(new URL('og-card.png', DIST)),
      'a social card ships in dist/ that nothing points at — a default card belonging to this ' +
        "package is exactly the identity leak TK-31 removed",
    );
  } else {
    assert.ok(
      statSync(new URL(SOCIAL_CARD_PATH.slice(1), DIST)).size > 0,
      'og:image names a social card that is missing or empty',
    );
  }
});

test('the built sitemap is exactly the built route set, minus what must not be crawled', () => {
  const locs = [...built('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map(([, loc]) =>
    decodeURIComponent(new URL(loc!).pathname),
  );

  // The sitemap is computed from the artifact and `dist/` is written by Astro,
  // so the two agreeing is a real property rather than a restatement. Two
  // classes of route are built but deliberately unlisted: the 404, which is the
  // host's fallback rather than a destination, and a withdrawn note, which is
  // still served but must not be advertised to a crawler.
  const withdrawn = new Set(
    entries.filter((note) => !isPublished(note)).map((note) => noteRoute(note.slug)),
  );
  const routes = PAGES.map(({ route }) => route).filter(
    (route) => isIndexable(route) && !withdrawn.has(route),
  );

  assert.deepEqual([...locs].sort(), [...routes].sort(), 'the sitemap is not the built route set');
  assert.ok(PAGES.some(({ route }) => !isIndexable(route)), 'no 404 was built, so its exclusion proves nothing');
});

test('a withdrawn note is served but is advertised nowhere', () => {
  // Only the fixture corpus carries a tombstone; the published artifact has
  // none, so this states that fact rather than skipping silently.
  const withdrawn = entries.filter((note) => !isPublished(note));
  if (withdrawn.length === 0) {
    assert.ok(
      entries.every((note) => note.status === undefined || note.status === 'published'),
      'the corpus has no withdrawn note, so exclusion cannot be checked',
    );
    return;
  }

  const feed = built(FEED_PATH.slice(1));
  const sitemap = built('sitemap.xml');
  for (const note of withdrawn) {
    const route = noteRoute(note.slug);
    assert.ok(!sitemap.includes(route), `${note.slug}: withdrawn, but listed in the sitemap`);
    assert.ok(!feed.includes(route), `${note.slug}: withdrawn, but broadcast in the feed`);
    assert.ok(!feed.includes(note.title), `${note.slug}: its title is in the feed`);
    // Still served: withdrawal is not this ticket's to implement, and a page
    // that vanished from `dist/` while the home page still linked it would be a
    // broken link. Open owner decision D4 owns the rest.
    assert.ok(
      PAGES.some((page) => page.route === route),
      `${note.slug}: the page is gone, which is beyond this ticket's scope`,
    );
  }
});

test('the built feed carries every published note, at its canonical URL', () => {
  assert.ok(entries.length > 0, 'the artifact has no notes, so the feed proves nothing');
  const feed = built(FEED_PATH.slice(1));
  assertWellFormed(feed, 'the built feed');

  // Every entry's `<link rel="alternate">` is its canonical URL. The `<id>` is
  // checked separately, because it is `public_id` when the artifact carries one
  // — a permanent identity that deliberately is NOT the mutable slug URL.
  const linked = [...feed.matchAll(/<link rel="alternate" type="text\/html" href="([^"]*)"\/>/g)]
    .map(([, href]) => href!)
    // The first is the feed's own alternate link to the home page.
    .slice(1);
  assert.deepEqual(
    [...linked].sort(),
    entries.filter(isPublished).map((note) => `${ORIGIN}${noteRoute(note.slug)}`).sort(),
    'the feed is not the published corpus',
  );

  // Nothing outside the public projection: the feed's summaries are the same
  // `excerpt` strings `public/content-index.json` already serves.
  //
  // Compared by *decoding the feed* rather than by escaping the artifact with
  // `escapeXml`. Computing the expected value with the function under test is
  // self-fulfilling — it would keep passing if the escaper broke in a way that
  // is stable — so the direction is reversed: pull the summary out of the
  // emitted document, decode it, and require the artifact's own bytes back.
  let compared = 0;
  for (const note of entries) {
    if (note.excerpt === '' || !isPublished(note)) continue;
    // Anchored on the entry's alternate link rather than its `<id>`, which may
    // be a `public_id` URN rather than the URL.
    const summary = new RegExp(
      `href="${ORIGIN}${noteRoute(note.slug)}"/>[\\s\\S]*?<summary type="text">([\\s\\S]*?)</summary>`,
    ).exec(feed);
    assert.ok(summary, `${note.slug}: has an excerpt but no feed summary`);
    assert.equal(
      decodeXml(summary[1]!),
      note.excerpt,
      `${note.slug}: the feed summary is not its excerpt`,
    );
    compared += 1;
  }
  assert.ok(compared > 0, 'no entry carried an excerpt, so no summary was compared');
});

test('the built robots.txt points at the sitemap that was built', () => {
  const robots = built('robots.txt');
  const sitemap = /^Sitemap: (.*)$/m.exec(robots)?.[1];
  assert.ok(sitemap, 'robots.txt names no sitemap');
  assert.equal(sitemap, `${ORIGIN}${SITEMAP_PATH}`);
  assert.ok(statSync(new URL(SITEMAP_PATH.slice(1), DIST)).size > 0, 'the named sitemap was not built');
});

/**
 * The origin is configured in one place, so changing it is a one-line change.
 *
 * This is the gate behind the placeholder decision: no public domain has been
 * assigned, so the configured origin is a deliberate `.invalid` placeholder, and
 * what makes that safe is that nothing else in the tree writes an origin down.
 * If a second copy ever appears, this fails and names it.
 *
 * TK-30 made the origin configurable, and the property is unchanged: the value
 * `astro.config.mjs` falls back to when a user has configured nothing is still
 * the only place it is written. What moved is the spelling — `site:` is now
 * `config.origin ?? DEFAULT_ORIGIN`, so the literal is read from that constant
 * rather than from the key. `scripts/load-config.ts` deliberately returns
 * `undefined` for an unconfigured origin rather than defaulting, which is what
 * keeps the count at one; `tests/config.test.ts` holds that end.
 */
test('no source file hardcodes the origin that astro.config.mjs configures', () => {
  const root = new URL('../', import.meta.url);
  const config = readFileSync(new URL('astro.config.mjs', root), 'utf8');
  const configured = /DEFAULT_ORIGIN = '([^']*)'/.exec(config)?.[1];
  assert.ok(configured, 'astro.config.mjs declares no default origin');
  assert.match(config, /site:\s*config\.origin \?\? DEFAULT_ORIGIN/, 'site: is not derived from that default');
  assert.equal(new URL(configured).origin, ORIGIN, 'the built pages do not use the configured origin');

  const host = new URL(configured).host;
  const sources: string[] = [];
  /**
   * Every committed file that could carry an origin.
   *
   * Widened from a source-extension allowlist to "everything except generated
   * and binary content", because the narrower version made a claim it did not
   * check: `public/_headers` has no extension at all, and a `Sitemap:` line or a
   * CSP `connect-src` naming the host would have sat there unseen. The exclusion
   * list is the generated and binary directories, which is a shape that stays
   * correct as files are added rather than one that silently stops covering them.
   */
  const SKIP = new Set(['node_modules', 'dist', '.git', '.astro', '.tmp']);
  const walk = (dir: URL): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const child = new URL(name, dir);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, dir));
      // `fileURLToPath`, not `pathname`: on Windows the latter yields
      // `/Q:/repo/...`, which `readFileSync` resolves against the drive root.
      else if (!/\.(png|jpe?g|webp|avif|ico|woff2?|lock|yaml)$/.test(name)) {
        sources.push(fileURLToPath(child));
      }
    }
  };
  for (const directory of ['src/', 'scripts/', 'tests/', 'public/']) walk(new URL(directory, root));
  assert.ok(sources.length > 0, 'no file was scanned');

  const self = fileURLToPath(import.meta.url);
  for (const file of sources) {
    // This file names the origin in the assertion message above, by construction.
    if (file === self) continue;
    assert.ok(
      !readFileSync(file, 'utf8').includes(host),
      `${file}: hardcodes the origin "${host}"; it belongs only in astro.config.mjs`,
    );
  }
});
