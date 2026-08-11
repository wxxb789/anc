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

import {
  UNCOLLECTED_LABEL,
  collectionNavigation,
  type ExplorerGroup,
} from '../src/lib/collection-navigation.ts';
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
  const listed = collectionNavigation(CORPUS, '/').flatMap(slugs).sort();
  assert.deepEqual(listed, CORPUS.map((entry) => entry.slug).sort());
});

test('groups are the collection facets, in the collection index order', () => {
  const groups = collectionNavigation(CORPUS, '/');
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
  const groups = collectionNavigation(CORPUS, '/');
  const last = groups.at(-1)!;
  assert.equal(last.label, UNCOLLECTED_LABEL);
  assert.deepEqual(slugs(last), ['adrift', 'loose'], 'not in title order');
  // Nothing in the route model addresses "notes with no collection", so linking
  // one would point at a page the build never emits. `built-routes.test.ts`
  // proves every internal link resolves; this is why that gate stays true.
  assert.equal(last.route, undefined, 'the uncollected group links a route that does not exist');
});

test('a corpus where every note has a collection has no uncollected group', () => {
  const groups = collectionNavigation(
    [note('a', 'A', 'engineering'), note('b', 'B', 'engineering')],
    '/',
  );
  assert.deepEqual(labels(groups), ['engineering']);
});

test('a corpus with no collection at all is one uncollected group', () => {
  // The published artifact's shape, scaled up: `collection` is one of the nine
  // optional fields the exporter has never produced.
  const groups = collectionNavigation([note('a', 'A'), note('b', 'B')], '/');
  assert.deepEqual(labels(groups), [UNCOLLECTED_LABEL]);
  assert.deepEqual(slugs(groups[0]!), ['a', 'b']);
});

test('every group carries the route its collection index is served from', () => {
  for (const group of collectionNavigation(CORPUS, '/')) {
    if (group.label === UNCOLLECTED_LABEL) continue;
    // Compared against the route model rather than a literal, so the two cannot
    // disagree about the segment or the trailing slash.
    assert.equal(group.route, collectionRoute(group.label));
  }
});

test('a note route marks the note and opens its own group', () => {
  const groups = collectionNavigation(CORPUS, '/notes/alpha/');
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
  const groups = collectionNavigation(CORPUS, '/notes/loose/');
  assert.deepEqual(labels(groups.filter((group) => group.isCurrent)), [UNCOLLECTED_LABEL]);
});

test('a collection index marks its own group and no note', () => {
  const groups = collectionNavigation(CORPUS, collectionRoute('garden-log'));
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
    const groups = collectionNavigation(CORPUS, path);
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
    const open = collectionNavigation(CORPUS, path).filter((group) => group.isCurrent);
    assert.ok(open.length <= 1, `${path}: ${open.length} groups are open at once`);
  }
});

test('the model is a pure function of the corpus and the path', () => {
  // Same inputs, same answer — and a second corpus does not disturb the first.
  // `collectionFacets` is memoised per corpus elsewhere in the tree, so this is
  // the property that would break if a cache were ever keyed less tightly.
  const first = collectionNavigation(CORPUS, '/notes/alpha/');
  collectionNavigation([note('x', 'X', 'other')], '/notes/x/');
  assert.deepEqual(collectionNavigation(CORPUS, '/notes/alpha/'), first);
});
