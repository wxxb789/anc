/**
 * The collection navigation model.
 *
 * Fixture-driven like `route-model.test.ts` and `relations.test.ts`: every
 * assertion here runs against synthetic corpora, so the rules are exercised in
 * shapes neither real corpus contains — a note alone in a collection, a corpus
 * with no collection at all, a path that addresses nothing.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { collectionNavigation, GROUP_WINDOW, type ExplorerGroup } from '../src/lib/collection-navigation.ts';
import { collectionFacets, collectionRoute } from '../src/lib/routes.ts';
import type { ContentEntry } from '../src/lib/schema.ts';

/** A minimal valid entry; only the fields this module reads are interesting. */
function note(slug: string, title: string, collection?: string): ContentEntry {
  return {
    slug,
    title,
    excerpt: '',
    markdown: `# ${title}\n`,
    outgoing: [],
    backlinks: [],
    ...(collection === undefined ? {} : { collection }),
  };
}

const CORPUS: ContentEntry[] = [
  note('beta', 'Beta', 'engineering'),
  note('alpha', 'Alpha', 'engineering'),
  note('solo', 'Solo', 'garden-log'),
  note('loose', 'Loose', undefined),
  note('adrift', 'Adrift', undefined),
];

/**
 * The label this module gives the notes carrying no `collection`.
 *
 * A fixture value, not the production string: `collectionNavigation` takes the
 * label as a parameter since TK-16 — the rail on a Chinese note reads
 * "未归入合集" and on an English one "Uncollected" — so what this file can assert
 * is that the parameter reaches the last group, and a value that is obviously
 * not either locale's is what makes that assertion mean something. The rendered
 * wording is `tests/translations.test.ts`'s and `tests/built-routes.test.ts`'s.
 */
const UNCOLLECTED = 'test-uncollected';

/** Every call in this file passes the same label; only the corpus and path vary. */
function navigationFor(entries: readonly ContentEntry[], path: string): ExplorerGroup[] {
  return collectionNavigation(entries, path, UNCOLLECTED);
}

function labels(groups: readonly ExplorerGroup[]): string[] {
  return groups.map((group) => group.label);
}

function slugs(group: ExplorerGroup): string[] {
  return group.notes.map((member) => member.slug);
}

test('every published note appears exactly once', () => {
  // The property that makes this navigation rather than a partial index: a
  // reader can reach any published note from any page. A note with no
  // collection is the case that would silently vanish, and four of the
  // thirty-two fixture notes are in it.
  //
  // Asserted on a corpus every group of which is under `GROUP_WINDOW`, which is
  // where the claim is true without qualification. Past the bound a group draws
  // a window and states its full size instead; `total` carries that claim and
  // the window gates below prove it.
  const listed = navigationFor(CORPUS, '/').flatMap(slugs).sort();
  assert.deepEqual(listed, CORPUS.map((entry) => entry.slug).sort());
});

/* ------------------------------------------------------------- window -- */

/** A corpus of `count` notes in one collection, titled so the order is known. */
function collectionOf(count: number, collection?: string): ContentEntry[] {
  return Array.from({ length: count }, (_, index) =>
    // Zero-padded so title order and index order are the same thing, which is
    // what lets a window's contents be named rather than merely counted.
    note(`n${String(index).padStart(3, '0')}`, `N${String(index).padStart(3, '0')}`, collection),
  );
}

test('a group at the bound draws whole, and one past it draws the bound', () => {
  // The boundary itself, from both sides: an off-by-one here is the difference
  // between a 32-note fixture rail that is byte-identical to what it was and one
  // that silently started truncating.
  const at = navigationFor(collectionOf(GROUP_WINDOW, 'c'), '/');
  assert.equal(at[0]!.notes.length, GROUP_WINDOW, 'a group at the bound was truncated');
  assert.equal(at[0]!.total, GROUP_WINDOW);

  const past = navigationFor(collectionOf(GROUP_WINDOW + 1, 'c'), '/');
  assert.equal(past[0]!.notes.length, GROUP_WINDOW, 'a group past the bound was not bounded');
  assert.equal(past[0]!.total, GROUP_WINDOW + 1, 'the count is the window, not the collection');
});

test('a bounded group draws a window containing the note being read', () => {
  // The property the bound exists for, and the one an unbounded rail lost: the
  // reader's own note is in the slice, so `aria-current="page"` is on the page.
  // Every note in a corpus six times the bound, not a sample — a window that
  // held for the middle and dropped the ends would pass a sampled check.
  const corpus = collectionOf(GROUP_WINDOW * 6, 'c');
  for (const entry of corpus) {
    const group = navigationFor(corpus, `/notes/${entry.slug}/`)[0]!;
    assert.equal(group.notes.length, GROUP_WINDOW, `${entry.slug}: window is not the bound`);
    assert.ok(
      group.notes.some((member) => member.isCurrent && member.slug === entry.slug),
      `${entry.slug}: the window does not contain the note being read`,
    );
  }
});

test('a reader at either end of a collection still gets a full window', () => {
  // Clamping, which a naive `slice(at - half, at + half)` gets wrong at both
  // ends: the first note would yield a half window and the last an empty tail.
  // A short rail at the edges of a collection is the visible symptom.
  const corpus = collectionOf(GROUP_WINDOW * 3, 'c');
  const first = navigationFor(corpus, `/notes/${corpus[0]!.slug}/`)[0]!;
  const last = navigationFor(corpus, `/notes/${corpus.at(-1)!.slug}/`)[0]!;

  assert.equal(first.notes.length, GROUP_WINDOW, 'the first note gets a short window');
  assert.equal(last.notes.length, GROUP_WINDOW, 'the last note gets a short window');
  // And the windows are the collection's actual ends rather than a clamp that
  // slid off: the first window starts at the first note, the last ends at the last.
  assert.equal(first.notes[0]!.slug, corpus[0]!.slug);
  assert.equal(last.notes.at(-1)!.slug, corpus.at(-1)!.slug);
});

test('the window is centred on the reader rather than the collection start', () => {
  // A `slice(0, GROUP_WINDOW)` for every page would satisfy the length
  // assertions above on the first window's worth of notes and strand every
  // reader past it — which is the unbounded rail's own defect, shrunk.
  const corpus = collectionOf(GROUP_WINDOW * 4, 'c');
  const middle = corpus[GROUP_WINDOW * 2]!;
  const group = navigationFor(corpus, `/notes/${middle.slug}/`)[0]!;

  assert.notEqual(
    group.notes[0]!.slug,
    corpus[0]!.slug,
    'the window starts at the collection start, so it is not centred on the reader',
  );
  const at = group.notes.findIndex((member) => member.isCurrent);
  // Within one of the middle: `Math.floor` puts an even window one short on the
  // upper side, which is a placement rather than a defect.
  assert.ok(
    Math.abs(at - Math.floor(GROUP_WINDOW / 2)) <= 1,
    `the reader sits at index ${at} of the window, not near its middle`,
  );
});

test('a group is bounded whether or not it has a collection route', () => {
  // The uncollected group takes the same window, and it is the group a corpus
  // with no `collection` field puts *everything* in — which is the shipped
  // binary's own shape, since `markdown-to-artifact.ts` derives no collection.
  // A bound applied only to collection facets would leave that corpus unbounded,
  // which is every user of the CLI.
  const corpus = collectionOf(GROUP_WINDOW * 3, undefined);
  // Indexed off the bound rather than a literal, so this fixture cannot come to
  // address a note outside a corpus sized in terms of it.
  const reader = corpus[GROUP_WINDOW * 2]!;
  const group = navigationFor(corpus, `/notes/${reader.slug}/`)[0]!;
  assert.equal(group.route, undefined, 'the fixture is not the uncollected group');
  assert.equal(group.notes.length, GROUP_WINDOW, 'the uncollected group is not bounded');
  assert.ok(
    group.notes.some((member) => member.isCurrent),
    'the uncollected window does not contain the note being read',
  );
});

test('a bounded group states its full size, not the size of its window', () => {
  // The count beside the label is what tells a reader the window is a window.
  // Asserted across a range of sizes rather than one, since a `total` wired to
  // `notes.length` agrees with the truth on every corpus under the bound.
  for (const size of [1, 2, GROUP_WINDOW - 1, GROUP_WINDOW, GROUP_WINDOW + 1, 200]) {
    const group = navigationFor(collectionOf(size, 'c'), '/')[0]!;
    assert.equal(group.total, size, `a group of ${size} states a total of ${group.total}`);
    assert.equal(
      group.notes.length,
      Math.min(size, GROUP_WINDOW),
      `a group of ${size} drew ${group.notes.length} notes`,
    );
  }
});

test('per-page rail size stops growing once the corpus passes the bound', () => {
  // The defect in one assertion: the rail was n entries on each of n pages, so
  // the fix is not "fewer entries" but "an entry count that does not depend on
  // n". Measured as the total notes the model hands the component across four
  // corpus sizes an order of magnitude apart.
  const drawn = (size: number): number =>
    navigationFor(collectionOf(size, 'c'), `/notes/n${String(Math.floor(size / 2)).padStart(3, '0')}/`)
      .reduce((count, group) => count + group.notes.length, 0);

  const sizes = [100, 300, 1000, 5000];
  const counts = sizes.map(drawn);
  assert.deepEqual(
    counts,
    sizes.map(() => GROUP_WINDOW),
    `the rail draws ${JSON.stringify(counts)} notes at ${JSON.stringify(sizes)} — it still grows with the corpus`,
  );
});

test('the number of groups is still the number of collections', () => {
  // The bound is on a group's *notes* and never on the group list: a corpus with
  // many small collections is bounded by nothing here, and must not be. Losing
  // this would make the rail's own group list incomplete, which is a hole in the
  // navigation rather than a smaller view of one.
  const corpus = Array.from({ length: 40 }, (_, index) =>
    note(`n${index}`, `N${index}`, `c${String(index).padStart(2, '0')}`),
  );
  const groups = navigationFor(corpus, '/');
  assert.equal(groups.length, 40, 'the group list was bounded');
  assert.deepEqual(
    groups.map((group) => group.notes.length),
    groups.map(() => 1),
  );
});

test('every group past the bound is windowed, on a corpus with several', () => {
  // The shape neither built corpus has and the rendered gate does not measure:
  // more than one group, each past the bound. The fixture corpus's groups are
  // 11, 10, 7, and 4 — all under it — and the corpus the CLI produces has
  // exactly one group, so "several windowed groups at once" is exercised
  // nowhere else. It is also the case the rail's own row budget is tightest in,
  // since every group spends another summary's height on the reader's screen.
  const corpus = [
    ...collectionOf(GROUP_WINDOW * 2, 'alpha'),
    // A second collection, with slugs that do not collide with the first.
    ...collectionOf(GROUP_WINDOW * 3, 'beta').map((entry) => ({
      ...entry,
      slug: `b-${entry.slug}`,
      title: `B ${entry.title}`,
    })),
    // And notes in no collection at all, which is a third group and the one
    // with no index route to expand into.
    ...collectionOf(GROUP_WINDOW * 2, undefined).map((entry) => ({
      ...entry,
      slug: `u-${entry.slug}`,
      title: `U ${entry.title}`,
    })),
  ];

  // Read from inside the middle group, which is where the reader actually is.
  const reader = corpus.find((entry) => entry.slug.startsWith('b-'))!;
  const groups = navigationFor(corpus, `/notes/${reader.slug}/`);

  assert.equal(groups.length, 3, 'the three groups are not all present');
  for (const group of groups) {
    assert.equal(
      group.notes.length,
      GROUP_WINDOW,
      `group "${group.label}" drew ${group.notes.length} notes, not the window`,
    );
    assert.ok(group.total > group.notes.length, `group "${group.label}" is not actually past the bound`);
  }

  // And exactly one note is marked, in the group the reader is in — a window per
  // group must not mark a note in a group the reader is not reading.
  const marked = groups.flatMap((group) => group.notes).filter((member) => member.isCurrent);
  assert.deepEqual(marked.map((member) => member.slug), [reader.slug]);
  assert.deepEqual(labels(groups.filter((group) => group.isCurrent)), ['beta']);
});

test('a windowed group is distinguishable from a whole one by its own fields', () => {
  // What the component branches on to render the bound sentence and the
  // expansion link. Without a difference the model can state, the rail would
  // have to guess — and a group drawing whole would claim to be partial.
  const whole = navigationFor(collectionOf(GROUP_WINDOW, 'c'), '/')[0]!;
  const windowed = navigationFor(collectionOf(GROUP_WINDOW * 2, 'c'), '/')[0]!;

  assert.equal(whole.total, whole.notes.length, 'a group drawing whole looks windowed');
  assert.ok(windowed.total > windowed.notes.length, 'a windowed group looks whole');
});

test('groups are the collection facets, in the collection index order', () => {
  const groups = navigationFor(CORPUS, '/');
  const facets = collectionFacets(CORPUS);
  assert.ok(facets.length > 0, 'the corpus has no collection, so the ordering proved nothing');

  // Not "the same set": the same sequence, so the rail and `/collections/` list
  // the same collections in the same order. A reader who learns the order in
  // one place must not have to relearn it in the other.
  assert.deepEqual(
    labels(groups).slice(0, facets.length),
    facets.map((facet) => facet.label),
  );
  // And each group's members are that facet's members, in the facet's own
  // order — the order `/collections/<key>/` shows.
  for (const [index, facet] of facets.entries()) {
    assert.deepEqual(
      slugs(groups[index]!),
      facet.entries.map((entry) => entry.slug),
      `group "${facet.label}" is not the facet's own membership, in its own order`,
    );
  }
});

test('the uncollected group is last, and carries no route', () => {
  const groups = navigationFor(CORPUS, '/');
  const last = groups.at(-1)!;
  assert.equal(last.label, UNCOLLECTED);
  assert.deepEqual(slugs(last), ['adrift', 'loose'], 'not in title order');
  // Nothing in the route model addresses "notes with no collection", so linking
  // one would point at a page the build never emits. `built-routes.test.ts`
  // proves every internal link resolves; this is why that gate stays true.
  assert.equal(last.route, undefined, 'the uncollected group links a route that does not exist');
});

test('a corpus where every note has a collection has no uncollected group', () => {
  const groups = navigationFor([note('a', 'A', 'engineering'), note('b', 'B', 'engineering')], '/');
  assert.deepEqual(labels(groups), ['engineering']);
});

test('a corpus with no collection at all is one uncollected group', () => {
  // The published artifact's shape, scaled up: `collection` is one of the nine
  // optional fields the exporter has never produced.
  const groups = navigationFor([note('a', 'A'), note('b', 'B')], '/');
  assert.deepEqual(labels(groups), [UNCOLLECTED]);
  assert.deepEqual(slugs(groups[0]!), ['a', 'b']);
});

test('every group carries the route its collection index is served from', () => {
  for (const group of navigationFor(CORPUS, '/')) {
    if (group.label === UNCOLLECTED) continue;
    // Compared against the route model rather than a literal, so the two cannot
    // disagree about the segment or the trailing slash.
    assert.equal(group.route, collectionRoute(group.label));
  }
});

test('a note route marks the note and opens its own group', () => {
  const groups = navigationFor(CORPUS, '/notes/alpha/');
  const open = groups.filter((group) => group.isCurrent);
  assert.deepEqual(labels(open), ['engineering'], 'the reader’s own group is not the open one');

  const current = groups.flatMap((group) => group.notes).filter((member) => member.isCurrent);
  assert.deepEqual(
    current.map((member) => member.slug),
    ['alpha'],
    'exactly one note must be marked as the page being read',
  );
});

test('a note with no collection opens the uncollected group', () => {
  const groups = navigationFor(CORPUS, '/notes/loose/');
  assert.deepEqual(labels(groups.filter((group) => group.isCurrent)), [UNCOLLECTED]);
});

test('a collection index marks its own group and no note', () => {
  const groups = navigationFor(CORPUS, collectionRoute('garden-log'));
  assert.deepEqual(labels(groups.filter((group) => group.isCurrent)), ['garden-log']);
  assert.deepEqual(
    groups.flatMap((group) => group.notes).filter((member) => member.isCurrent),
    [],
    'a collection index is not one of its notes, so no note is the current page',
  );
});

test('a route with no collection context marks nothing', () => {
  // The home page, `/tags/`, the 404. There is no group the reader is "in", so
  // opening one would present a guess as a location — and every `<details>`
  // renders closed, which is what keeps the rail one screen tall.
  for (const path of ['/', '/tags/', '/recent/', '/404.html', '/notes/not-published/']) {
    const groups = navigationFor(CORPUS, path);
    assert.deepEqual(
      labels(groups.filter((group) => group.isCurrent)),
      [],
      `${path}: opened a group on a route with no collection context`,
    );
    assert.deepEqual(
      groups.flatMap((group) => group.notes).filter((member) => member.isCurrent),
      [],
      `${path}: marked a note as the page being read`,
    );
  }
});

test('at most one group is ever open', () => {
  // Two collections whose notes could both match a naive check, plus every
  // route the corpus produces. More than one open group is the state that turns
  // the rail from a location into a wall of titles.
  const paths = [
    '/',
    ...CORPUS.map((entry) => `/notes/${entry.slug}/`),
    ...collectionFacets(CORPUS).map((facet) => collectionRoute(facet.key)),
  ];
  for (const path of paths) {
    const open = navigationFor(CORPUS, path).filter((group) => group.isCurrent);
    assert.ok(open.length <= 1, `${path}: ${open.length} groups are open at once`);
  }
});

test('the model is a pure function of the corpus and the path', () => {
  // Same inputs, same answer — and a second corpus does not disturb the first.
  // `collectionFacets` is memoised per corpus elsewhere in the tree, so this is
  // the property that would break if a cache were ever keyed less tightly.
  const first = navigationFor(CORPUS, '/notes/alpha/');
  navigationFor([note('x', 'X', 'other')], '/notes/x/');
  assert.deepEqual(navigationFor(CORPUS, '/notes/alpha/'), first);
});
