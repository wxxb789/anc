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
  REDIRECT_LIMIT,
  SITE_MAP,
  TAGS_SEGMENT,
  collectionFacets,
  collectionRoute,
  legacyNoteRoute,
  noteRoute,
  noteSlugFromPath,
  noteTimestamp,
  recentFirst,
  redirectRules,
  renderRedirects,
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
  assert.equal(legacyNoteRoute('first-note'), '/first-note/');
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

test('every published slug gets a permanent redirect in both path forms', () => {
  const entries = [entry('b-note'), entry('a-note')];
  const rules = redirectRules(entries);

  // Both `/a-note/` and `/a-note` — Cloudflare compares the rule source against
  // the request path, and its documented trailing-slash handling covers its own
  // `.html` normalization, not user rules.
  assert.equal(rules.length, entries.length * 2);
  assert.deepEqual(rules.map((rule) => rule.from), ['/a-note', '/a-note/', '/b-note', '/b-note/']);
  for (const rule of rules) {
    assert.equal(rule.status, 301, 'a slug change must not be a temporary redirect');
    assert.equal(rule.to, noteRoute(rule.from.replaceAll('/', '')));
  }
});

test('the redirect map is acyclic and has no repeated source', () => {
  // Acyclic by construction — no target can be a source, because a slug cannot
  // contain a slash — but walked here so a future route change fails loudly
  // rather than shipping a loop.
  const rules = redirectRules(['a-note', 'b-note', 'c-note'].map((slug) => entry(slug)));
  const targets = new Map(rules.map((rule) => [rule.from, rule.to]));
  assert.equal(targets.size, rules.length, 'two rules share a source path');

  for (const rule of rules) {
    const seen = new Set([rule.from]);
    let current: string | undefined = rule.to;
    while (current !== undefined && targets.has(current)) {
      assert.ok(!seen.has(current), `redirect cycle reached through ${rule.from}`);
      seen.add(current);
      current = targets.get(current);
    }
  }
});

test('no redirect source can collide with a route the site owns', () => {
  // This matters because Cloudflare Pages applies a redirect even when a static
  // asset matches the request: a rule at `/recent/` would shadow the recent
  // index outright. Nothing in `redirectRules` prevents that — a note slugged
  // `recent` would emit exactly such a rule. What prevents it is TK-01, which
  // refuses the slug, and this is the seam where those two modules meet.
  //
  // So the invariant proven here is the conjunction: for every fixed route,
  // the slug that would shadow it is rejected by validation, AND redirect
  // sources for slugs that DO validate never land on a fixed route.
  const shadowing = FIXED_ROUTES.map((route) => route.replaceAll('/', '')).filter((slug) => slug !== '');
  assert.ok(shadowing.length > 0);

  for (const slug of shadowing) {
    assert.ok(
      redirectRules([entry(slug)]).some((rule) => FIXED_ROUTES.includes(rule.from)),
      `"${slug}" was expected to shadow a fixed route, so validation must reject it`,
    );
    assert.throws(
      () => validateArtifact({ version: 1, entries: [entry(slug)] }),
      /collides with reserved route segment/,
      `a note slugged "${slug}" would emit a redirect over the site's own route`,
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

  // And a slug that validates emits nothing over a site route.
  for (const rule of redirectRules([entry('a-note'), entry('recent-thoughts')])) {
    assert.ok(!FIXED_ROUTES.includes(rule.from), `redirect source ${rule.from} shadows a site route`);
  }
});

test('an empty corpus produces a valid, rule-free redirect file', () => {
  const text = renderRedirects(redirectRules([]), VERSION);
  assert.equal(text.split('\n').filter((line) => line !== '' && !line.startsWith('#')).length, 0);
  assert.ok(text.endsWith('\n'), 'the file must end with a newline');
});

test('the rendered file matches the Cloudflare _redirects grammar', () => {
  const rules = redirectRules(['a-note', 'b-note'].map((slug) => entry(slug)));
  const lines = renderRedirects(rules, VERSION).split('\n');

  assert.equal(lines.at(-1), '', 'the file must end with a newline');
  const body = lines.filter((line) => line !== '' && !line.startsWith('#'));
  assert.equal(body.length, rules.length);

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
  // artifact that produced it.
  const text = renderRedirects(redirectRules([entry('a-note')]), {
    schema: 1,
    content: 'sha256:abc123',
  });
  assert.match(text, /^# schema_version: 1$/m);
  assert.match(text, /^# content_version: sha256:abc123$/m);
});

test('a corpus past the Cloudflare rule limit fails the build', () => {
  // Two rules per note, so the limit is reached at half as many notes. Failing
  // here names the count; the host would otherwise reject the whole file.
  const overflowing = Array.from({ length: REDIRECT_LIMIT }, (_, index) => entry(`note-${index}`));
  assert.throws(
    () => renderRedirects(redirectRules(overflowing), VERSION),
    /exceeds the Cloudflare Pages limit of 2000/,
  );

  const withinLimit = overflowing.slice(0, REDIRECT_LIMIT / 2);
  assert.doesNotThrow(() => renderRedirects(redirectRules(withinLimit), VERSION));
});
