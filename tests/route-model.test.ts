/**
 * The public route model, its facets, its ordering, and its redirect map.
 *
 * These are unit tests over `src/lib/routes.ts` against synthetic fixtures.
 * The assertions over what the build actually emitted live in
 * `tests/built-routes.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { RESERVED_SLUGS, validateArtifact, type ContentEntry } from '../src/lib/schema.ts';
import {
  COLLECTIONS_SEGMENT,
  FIXED_ROUTES,
  NOTES_SEGMENT,
  PRIMARY_NAV,
  REDIRECT_RULES,
  SITE_MAP,
  TAGS_SEGMENT,
  collectionFacets,
  collectionRoute,
  isRouteKey,
  noteRoute,
  noteSlugFromPath,
  noteTimestamp,
  recentFirst,
  renderRedirects,
  routeKey,
  tagFacets,
  tagRoute,
} from '../src/lib/routes.ts';

/** A minimal valid entry; every field the route model reads is overridable. */
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

// --- Route shapes -------------------------------------------------------------

test('a note route is a pure function of its slug', () => {
  assert.equal(noteRoute('first-note'), '/notes/first-note/');
  assert.equal(tagRoute('gardening'), '/tags/gardening/');
  assert.equal(collectionRoute('field-notes'), '/collections/field-notes/');
});

test('the route segments are all reserved by the content contract', () => {
  // A note slugged `notes` would shadow every note route; TK-01 rejects it, and
  // this proves the two modules still agree on which segments matter.
  for (const segment of [NOTES_SEGMENT, TAGS_SEGMENT, COLLECTIONS_SEGMENT]) {
    assert.ok(RESERVED_SLUGS.has(segment), `route segment "${segment}" is not a reserved slug`);
  }
});

test('every fixed route collides with a reserved segment or is the site root', () => {
  // Otherwise a published note could take a route the site already owns.
  for (const route of FIXED_ROUTES) {
    if (route === '/') continue;
    const segment = route.slice(1, -1);
    assert.ok(RESERVED_SLUGS.has(segment), `fixed route "${route}" is not protected by a reserved slug`);
  }
});

test('note paths are recognized only in their canonical form', () => {
  assert.equal(noteSlugFromPath('/notes/first-note/'), 'first-note');
  assert.equal(noteSlugFromPath('/notes/first-note'), 'first-note');

  for (const path of [
    '/first-note/',           // the legacy route, which no longer resolves
    '/notes/',                // the segment with no slug
    '/notes/First-Note/',     // uppercase is not a valid slug
    '/notes/a/b/',            // a deeper path
    '/tags/gardening/',       // a different facet
    '/collections/notes/',    // the segment appearing elsewhere
    '/',
    '',
  ]) {
    assert.equal(noteSlugFromPath(path), undefined, `wrongly read a slug out of "${path}"`);
  }
});

// --- Navigation ---------------------------------------------------------------

test('the site map links every fixed route exactly once', () => {
  // `FIXED_ROUTES` is derived from `SITE_MAP`, so comparing the two would be a
  // tautology. What is worth proving is that the site map names each of the
  // routes section 9.1 specifies and does not link one twice — the property
  // "no orphan route" actually rests on.
  const hrefs = SITE_MAP.map((item) => item.href);
  assert.equal(new Set(hrefs).size, hrefs.length, 'the site map links a route twice');

  for (const required of ['/', '/recent/', `/${TAGS_SEGMENT}/`, `/${COLLECTIONS_SEGMENT}/`, '/about/', '/privacy/']) {
    assert.ok(hrefs.includes(required), `the site map does not link "${required}"`);
  }
  for (const item of SITE_MAP) assert.ok(item.label.trim() !== '', `${item.href} has no label`);
});

test('the site map never offers the 404 as a destination', () => {
  for (const item of [...SITE_MAP, ...PRIMARY_NAV]) {
    assert.doesNotMatch(item.href, /404/, 'the error page must not be linked as a destination');
  }
});

test('primary navigation points only at routes the site owns', () => {
  for (const item of PRIMARY_NAV) {
    const [path] = item.href.split('#') as [string];
    assert.ok(
      FIXED_ROUTES.includes(path === '' ? '/' : path),
      `primary nav links "${item.href}", which is not a fixed route`,
    );
  }
});

// --- Facets -------------------------------------------------------------------

test('tags group by a slugified route key and sort deterministically', () => {
  const facets = tagFacets([
    entry('b-note', { tags: ['Field Notes', 'gardening'] }),
    entry('a-note', { tags: ['gardening'] }),
  ]);

  assert.deepEqual(facets.map((facet) => facet.key), ['field-notes', 'gardening']);
  assert.deepEqual(facets[1]!.entries.map((item) => item.slug), ['a-note', 'b-note']);
  assert.equal(facets[0]!.label, 'Field Notes', 'the label keeps the artifact spelling');
});

test('a tag route key is not affected by what other tags exist', () => {
  // A key derived from position or from a disambiguating counter would move an
  // existing public URL whenever an unrelated tag was published.
  const alone = tagFacets([entry('a-note', { tags: ['gardening'] })]);
  const crowded = tagFacets([
    entry('a-note', { tags: ['gardening'] }),
    entry('b-note', { tags: ['aardvark', 'gardening', 'zebra'] }),
  ]);
  assert.equal(
    crowded.find((facet) => facet.label === 'gardening')?.key,
    alone[0]!.key,
  );
});

test('two tags that would share a route key fail the build instead of merging', () => {
  // `C++` and `C#` both slugify to `c`. Merging them would put one tag's notes
  // on the other tag's page; suffixing would make an existing URL unstable.
  assert.throws(
    () => tagFacets([entry('a-note', { tags: ['C++'] }), entry('b-note', { tags: ['C#'] })]),
    /both route to \/tags\/c\//,
  );
});

test('tags differing only by case are one tag, not a build failure', () => {
  // `Gardening` and `gardening` are the same tag. Failing the build would be
  // unfixable from this repository, since the exporter is not writable here,
  // and publishing two pages would say the same thing twice.
  const facets = tagFacets([
    entry('a-note', { tags: ['Gardening'] }),
    entry('b-note', { tags: ['gardening'] }),
  ]);
  assert.equal(facets.length, 1);
  assert.equal(facets[0]!.key, 'gardening');
  assert.deepEqual(facets[0]!.entries.map((item) => item.slug), ['a-note', 'b-note']);
});

test('the surviving label does not depend on artifact order', () => {
  const label = (entries: ContentEntry[]) => tagFacets(entries)[0]!.label;
  const forward = [entry('a-note', { tags: ['Gardening'] }), entry('b-note', { tags: ['gardening'] })];
  assert.equal(label(forward), label([...forward].reverse()));
});

test('one note carrying two spellings of a tag is listed once', () => {
  // TK-01's duplicate check compares exact strings, so `['Gardening',
  // 'gardening']` on one entry is a valid artifact. The case merge folds them
  // into one facet; without a guard the note is pushed twice and the page
  // renders the same card twice under a count of "2 notes".
  const facets = tagFacets([entry('a-note', { tags: ['Gardening', 'gardening'] })]);
  assert.equal(facets.length, 1);
  assert.deepEqual(facets[0]!.entries.map((item) => item.slug), ['a-note']);
});

test('a tag with no URL-safe characters fails rather than routing to nothing', () => {
  assert.throws(
    () => tagFacets([entry('a-note', { tags: ['...'] })]),
    /has no URL-safe route key/,
  );
});

// --- Route key vocabulary -----------------------------------------------------

test('a tag key never carries a leading, trailing, or doubled separator', () => {
  // `github-slugger` strips emoji and punctuation without closing the gap they
  // leave, so every one of these was an emittable public URL before TK-11:
  // `/tags/-seedling/`, `/tags/seedling-/`, `/tags/ops--sre/`, `/tags/---/`.
  for (const [label, expected] of [
    ['🌱 seedling', 'seedling'],
    ['seedling 🌱', 'seedling'],
    ['Ops & SRE', 'ops-sre'],
    ['设计 · Design', '设计-design'],
    ['⚠️ warning', 'warning'],
    ['  spaced  ', 'spaced'],
    ['dev👨‍💻ops', 'devops'],
  ] as const) {
    assert.equal(routeKey(label), expected, `wrong key for ${JSON.stringify(label)}`);
    const [facet] = tagFacets([entry('a-note', { tags: [label] })]);
    assert.equal(facet?.key, expected);
    assert.equal(facet?.label, label, 'the artifact spelling survives on the page');
  }
});

test('a label that reduces to nothing addressable fails the build', () => {
  // There is no answer to invent here, so the build stops rather than emitting
  // an empty or invisible route segment.
  for (const label of ['---', '...', '½', '   ', '—', '①']) {
    assert.throws(
      () => tagFacets([entry('a-note', { tags: [label] })]),
      /has no URL-safe route key/,
      `${JSON.stringify(label)} was accepted as a route key`,
    );
  }
});

test('the emoji variation selector never survives into a route key', () => {
  // U+FE0F is a nonspacing MARK, not a format character, so a `\p{M}`-based
  // vocabulary admits it and `⚠️ warning` keys a route whose first character is
  // invisible. Two tags differing only by it would also be two indistinguishable
  // public URLs.
  const key = routeKey('⚠️ warning');
  assert.equal(key, 'warning');
  assert.doesNotMatch(key, /\p{Default_Ignorable_Code_Point}/u);
  assert.ok(isRouteKey(key));
});

test('a route key stays a pure function of its own label', () => {
  // The property that rules out a disambiguating numeric suffix: cleaning must
  // not read the corpus, or an existing tag's URL moves when another is added.
  const alone = tagFacets([entry('a-note', { tags: ['🌱 seedling'] })]);
  const crowded = tagFacets([
    entry('a-note', { tags: ['🌱 seedling'] }),
    entry('b-note', { tags: ['aardvark', 'seedling notes', 'zebra'] }),
  ]);
  assert.equal(crowded.find((facet) => facet.label === '🌱 seedling')?.key, alone[0]!.key);
  assert.equal(alone[0]!.key, routeKey('🌱 seedling'));
});

test('two spellings of the same accented label produce one route key', () => {
  // `café` typed with a precomposed é and with a combining accent are the same
  // word. Two keys would be two indistinguishable public URLs — and, since keys
  // become directory names, a pair that collides on a normalizing filesystem
  // and not on a case-sensitive one, so the build would differ by platform.
  // Built from escapes rather than written literally: an editor, a formatter, or
  // git itself may normalize a source file, which would silently turn the two
  // spellings into one string and leave this test asserting nothing.
  const composed = 'café';
  const decomposed = 'café';
  assert.notEqual(composed, decomposed, 'the two spellings must differ as strings');
  assert.equal(routeKey(composed), routeKey(decomposed));

  const facets = tagFacets([
    entry('a-note', { tags: [composed] }),
    entry('b-note', { tags: [decomposed] }),
  ]);
  assert.equal(facets.length, 1, 'the two spellings produced two facets');
  assert.deepEqual(facets[0]!.entries.map((item) => item.slug), ['a-note', 'b-note']);
});

test('non-Latin scripts keep a readable route key rather than being encoded', () => {
  for (const label of ['笔记', '开发笔记', 'हिन्दी', 'tiếng việt', 'café', 'Ελληνικά', '한국어']) {
    const key = routeKey(label);
    assert.ok(isRouteKey(key), `${JSON.stringify(label)} produced an unusable key ${JSON.stringify(key)}`);
    // Stable under URL normalization, so the built path resolves where it was
    // written rather than somewhere a browser reinterprets it to.
    const route = tagRoute(key);
    assert.equal(new URL(route, 'https://example.invalid').pathname, encodeURI(route));
  }
});

test('a tag-key collision names both labels and says the fix is the exporter s', () => {
  // Unfixable from this repository: the exporter authors tag text. The message
  // has to say so, or the failure gets patched in the wrong place.
  assert.throws(
    () => tagFacets([entry('a-note', { tags: ['C++'] }), entry('b-note', { tags: ['C#'] })]),
    (error: Error) => {
      assert.match(error.message, /"C\+\+"/, 'the first label is not named');
      assert.match(error.message, /"C#"/, 'the second label is not named');
      assert.match(error.message, /both route to \/tags\/c\//, 'the colliding route is not named');
      assert.match(error.message, /exporter/i, 'the message does not say where the fix belongs');
      return true;
    },
  );
});

test('an unroutable label also says the fix is the exporter s', () => {
  assert.throws(
    () => tagFacets([entry('a-note', { tags: ['---'] })]),
    (error: Error) => {
      assert.match(error.message, /"---"/, 'the label is not named');
      assert.match(error.message, /exporter/i, 'the message does not say where the fix belongs');
      return true;
    },
  );
});

test('the slug contract and the route vocabulary agree', () => {
  // These are two rules over the same strings: a slug and a collection are used
  // verbatim as public route segments. If the contract admits a shape routing
  // refuses, a schema-valid artifact fails the build at a later stage — which is
  // exactly the failure the contract exists to prevent. `deep--dive` was such a
  // shape until the doubled hyphen was removed from `SLUG`.
  const valid = (slug: string) =>
    validateArtifact({ version: 1, entries: [entry(slug)] }) !== undefined;

  for (const slug of ['a', 'a-b', 'deep-dive', 'note-2026', '2026-notes']) {
    assert.ok(valid(slug), `"${slug}" is a valid slug`);
    assert.ok(isRouteKey(slug), `the contract admits "${slug}" but routing cannot address it`);
  }

  for (const slug of ['deep--dive', '-lead', 'trail-', 'Upper', 'has space', 'a/b', '']) {
    assert.throws(
      () => validateArtifact({ version: 1, entries: [entry(slug)] }),
      `the contract admits "${slug}", which routing rejects`,
    );
  }

  // A collection is its own route key with no cleaning step, so the same has to
  // hold for it or `collectionFacets` throws on a valid artifact.
  assert.throws(() => validateArtifact({ version: 1, entries: [entry('a-note', { collection: 'a--b' })] }));
  assert.doesNotThrow(() => collectionFacets([entry('a-note', { collection: 'field-notes' })]));
});

test('CJK tags produce a usable route key', () => {
  const [facet] = tagFacets([entry('a-note', { tags: ['笔记'] })]);
  assert.ok(facet);
  assert.equal(facet.label, '笔记');
  assert.notEqual(facet.key, '');
  assert.doesNotMatch(facet.key, /[/\s]/, 'a route key must not contain a slash or whitespace');
});

test('collections use the validated slug as their own key', () => {
  const facets = collectionFacets([
    entry('b-note', { collection: 'field-notes' }),
    entry('a-note', { collection: 'field-notes' }),
    entry('c-note'),
  ]);
  assert.equal(facets.length, 1);
  assert.equal(facets[0]!.key, 'field-notes');
  assert.deepEqual(facets[0]!.entries.map((item) => item.slug), ['a-note', 'b-note']);
});

test('an artifact carrying no tags or collections yields no facets, not an error', () => {
  // The empty state is the current normal case and must never 404 or fabricate.
  assert.deepEqual(tagFacets([entry('a-note'), entry('b-note')]), []);
  assert.deepEqual(collectionFacets([entry('a-note'), entry('b-note')]), []);
  assert.deepEqual(tagFacets([]), []);
  assert.deepEqual(collectionFacets([]), []);
});

test('notes with identical titles still sort into a stable order', () => {
  const facets = tagFacets([
    entry('z-note', { title: 'Same', tags: ['t'] }),
    entry('a-note', { title: 'Same', tags: ['t'] }),
  ]);
  assert.deepEqual(facets[0]!.entries.map((item) => item.slug), ['a-note', 'z-note']);
});

test('facet grouping does not mutate the entries it is given', () => {
  const entries = [entry('b-note', { tags: ['t'] }), entry('a-note', { tags: ['t'] })];
  const before = entries.map((item) => item.slug);
  tagFacets(entries);
  recentFirst(entries);
  assert.deepEqual(entries.map((item) => item.slug), before);
});

// --- Recent ordering ----------------------------------------------------------

test('recent orders by updated, then created, most recent first', () => {
  const ordered = recentFirst([
    entry('older', { created: '2026-01-01' }),
    entry('newest', { created: '2026-01-01', updated: '2026-08-06' }),
    entry('middle', { created: '2026-03-01' }),
  ]);
  assert.deepEqual(ordered.map((item) => item.slug), ['newest', 'middle', 'older']);
});

test('an offset timestamp is compared as an instant, not as text', () => {
  // `2026-08-06T12:00:00+08:00` is 04:00Z, so it is EARLIER than 05:00Z even
  // though it sorts later as a string.
  const ordered = recentFirst([
    entry('plus-eight', { updated: '2026-08-06T12:00:00+08:00' }),
    entry('utc', { updated: '2026-08-06T05:00:00Z' }),
  ]);
  assert.deepEqual(ordered.map((item) => item.slug), ['utc', 'plus-eight']);
});

test('undated notes follow dated ones, in slug order', () => {
  const ordered = recentFirst([
    entry('z-undated'),
    entry('dated', { created: '2020-01-01' }),
    entry('a-undated'),
  ]);
  assert.deepEqual(ordered.map((item) => item.slug), ['dated', 'a-undated', 'z-undated']);
});

test('the documented fallback order applies when no note carries a date', () => {
  const ordered = recentFirst([entry('c-note'), entry('a-note'), entry('b-note')]);
  assert.deepEqual(ordered.map((item) => item.slug), ['a-note', 'b-note', 'c-note']);
  for (const item of ordered) assert.equal(noteTimestamp(item), undefined);
});

test('recent ordering is stable across repeated calls', () => {
  const entries = [entry('a-note'), entry('b-note'), entry('c-note', { updated: '2026-01-01' })];
  assert.deepEqual(recentFirst(entries), recentFirst(entries));
});

test('an unparseable date is treated as undated, not as NaN', () => {
  // `NaN !== NaN`, so an unguarded parse sends the comparator down its numeric
  // branch and returns NaN, making the whole sort implementation-defined.
  // TK-01 rejects such a value, but this module is pure and fixture-driven.
  assert.equal(noteTimestamp(entry('x', { updated: 'not-a-date' })), undefined);

  const ordered = recentFirst([
    entry('broken', { updated: 'not-a-date' }),
    entry('dated', { updated: '2026-01-01' }),
    entry('a-undated'),
  ]);
  assert.deepEqual(ordered.map((item) => item.slug), ['dated', 'a-undated', 'broken']);
});

// --- Redirects ----------------------------------------------------------------

/** The version stamp shape the emitter supplies; irrelevant to rule content. */
const VERSION = { schema: 1, content: 'sha256:0000' };

/** A rule shape to render, since the live map has none. See `REDIRECT_RULES`. */
const SAMPLE: readonly { from: string; to: string; status: 301 }[] = [
  { from: '/a-note/', to: noteRoute('a-note'), status: 301 },
  { from: '/b-note', to: noteRoute('b-note'), status: 301 },
];

test('the site strands no public path, so it emits no redirect', () => {
  // TK-04 emitted two rules per note migrating `/<slug>/` to `/notes/<slug>/`.
  // That URL shape was never publicly served — introduced at `3831ad0`,
  // superseded at `04f8d9c`, entirely within unpushed history — so every rule
  // redirected from a URL nobody could hold. TK-12 deleted them.
  //
  // This is the assertion that keeps them deleted: a rule reappears only
  // alongside a real stranded URL, and whoever adds one has to update this test
  // and say which URL it is.
  assert.deepEqual(REDIRECT_RULES, []);
});

test('no redirect source may collide with a route the site owns', () => {
  // Cloudflare Pages applies a redirect even when a static asset matches the
  // request, so a rule at `/recent/` would shadow the recent index outright.
  // Two things must hold for that to be impossible. First, a note slugged
  // `recent` must never validate — TK-01 refuses it, and this is the seam where
  // the two modules meet. Second, no rule that does ship may name a fixed route
  // as its source.
  const shadowing = FIXED_ROUTES.map((route) => route.replaceAll('/', '')).filter((slug) => slug !== '');
  assert.ok(shadowing.length > 0);

  for (const slug of shadowing) {
    assert.throws(
      () => validateArtifact({ version: 1, entries: [entry(slug)] }),
      /collides with reserved route segment/,
      `a note slugged "${slug}" could shadow the site's own route`,
    );
  }

  // Every reserved segment, not only the ones that are fixed routes: `notes`,
  // `pagefind`, and `404` shadow route prefixes and assets rather than pages.
  for (const reserved of RESERVED_SLUGS) {
    assert.throws(
      () => validateArtifact({ version: 1, entries: [entry(reserved)] }),
      /collides with reserved route segment/,
    );
  }

  for (const rule of REDIRECT_RULES) {
    assert.ok(!FIXED_ROUTES.includes(rule.from), `redirect source ${rule.from} shadows a site route`);
  }
});

test('the rule set is acyclic and names each source once', () => {
  // Vacuous while `REDIRECT_RULES` is empty, and kept for exactly that reason:
  // the deleted machinery derived two rules per note and carried a cycle walk
  // to prove they could not loop. The rules are hand-written now, which makes a
  // loop *easier* to introduce, not harder — nothing computes the targets, so
  // nothing guarantees a target is not also a source. This is the assertion the
  // first hand-written rule has to pass.
  const targets = new Map(REDIRECT_RULES.map((rule) => [rule.from, rule.to]));
  assert.equal(targets.size, REDIRECT_RULES.length, 'two rules share a source path');

  for (const rule of REDIRECT_RULES) {
    assert.equal(rule.status, 301, 'a stranded URL must not move temporarily');
    const seen = new Set([rule.from]);
    let current: string | undefined = rule.to;
    while (current !== undefined && targets.has(current)) {
      assert.ok(!seen.has(current), `redirect cycle reached through ${rule.from}`);
      seen.add(current);
      current = targets.get(current);
    }
  }
});

test('an empty rule set produces a valid, rule-free redirect file', () => {
  const text = renderRedirects([], VERSION);
  assert.equal(text.split('\n').filter((line) => line !== '' && !line.startsWith('#')).length, 0);
  assert.ok(text.endsWith('\n'), 'the file must end with a newline');
});

test('the rendered file matches the Cloudflare _redirects grammar', () => {
  // Rendered against a sample rule set rather than the live one, which is
  // empty: the grammar is what the first real rule will be emitted into, so it
  // must stay proven while there is nothing to emit.
  const lines = renderRedirects(SAMPLE, VERSION).split('\n');

  assert.equal(lines.at(-1), '', 'the file must end with a newline');
  const body = lines.filter((line) => line !== '' && !line.startsWith('#'));
  assert.equal(body.length, SAMPLE.length);

  for (const line of body) {
    // `[source] [destination] [code]`, absolute paths, permanent status.
    assert.match(line, /^\/[\S]* \/[\S]* 301$/, `not a valid redirect rule: ${line}`);
    // Cloudflare caps a rule at 1000 characters.
    assert.ok(line.length <= 1000, `redirect rule exceeds the 1000 character limit: ${line}`);
  }
});

test('the file records the schema and content version it was generated from', () => {
  // Requirements section 20: every artifact records `schema_version` and
  // `content_version`. Without them a deployed map cannot be tied back to the
  // artifact that produced it. This is why the file ships at all today.
  const text = renderRedirects(REDIRECT_RULES, { schema: 1, content: 'sha256:abc123' });
  assert.match(text, /^# schema_version: 1$/m);
  assert.match(text, /^# content_version: sha256:abc123$/m);
});
