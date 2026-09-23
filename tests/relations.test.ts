/**
 * The derived relationship model: related notes and collection neighbours.
 *
 * Unit tests over `src/lib/relations.ts` against synthetic fixtures. What the
 * built pages actually render lives in `tests/built-routes.test.ts`, and what a
 * browser does with it lives in `tests/rendered-page.test.ts`.
 *
 * The rule under test is a ranking, so most of these assert an *order* rather
 * than a membership. A gate that only checked "the related list is non-empty
 * and excludes linked notes" would pass for a rule that returned the corpus in
 * slug order, which is the failure mode the rarity weighting exists to prevent.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { ContentEntry } from '../src/lib/schema.ts';
import { collectionFacets, tagFacets } from '../src/lib/routes.ts';
import {
  RELATED_LIMIT,
  byTitleThenSlug,
  collectionNeighbours,
  hasTagPeer,
  notesForSlugs,
  relatedNotes,
} from '../src/lib/relations.ts';

/** A minimal valid entry; every field the relation model reads is overridable. */
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

/** Look an entry up the way a page does, so the tests exercise the real shape. */
function lookupIn(entries: readonly ContentEntry[]): (slug: string) => ContentEntry | undefined {
  const bySlug = new Map(entries.map((item) => [item.slug, item]));
  return (slug) => bySlug.get(slug);
}

const slugsOf = (entries: readonly ContentEntry[]): string[] => entries.map((item) => item.slug);

// --- Edge lists ---------------------------------------------------------------

test('an edge list renders in title order, not the artifact s slug order', () => {
  // The artifact stores both edge lists sorted by slug, which is what makes the
  // corpus invariant cheap and is meaningless to a reader looking at titles.
  const corpus = [
    entry('a-slug', { title: 'Zebra' }),
    entry('z-slug', { title: 'Apple' }),
    entry('m-slug', { title: 'Mango' }),
  ];
  const resolved = notesForSlugs(['a-slug', 'm-slug', 'z-slug'], lookupIn(corpus));
  assert.deepEqual(
    resolved.map((item) => item.title),
    ['Apple', 'Mango', 'Zebra'],
  );
});

test('two notes with the same title are ordered by slug, so the order is total', () => {
  const corpus = [entry('second', { title: 'Same' }), entry('first', { title: 'Same' })];
  assert.deepEqual(slugsOf(notesForSlugs(['second', 'first'], lookupIn(corpus))), ['first', 'second']);
});

test('an edge naming no published entry is skipped, not rendered as a dead link', () => {
  // `checkCorpus` proves this cannot reach the page through the validated
  // loader. The function is pure and must not depend on that having run.
  const corpus = [entry('present')];
  assert.deepEqual(slugsOf(notesForSlugs(['present', 'absent'], lookupIn(corpus))), ['present']);
});

/**
 * The shared title-then-slug order: title first, slug only to break a tie.
 *
 * `relations.ts` re-exports the comparator `routes.ts` owns, so there is no
 * second copy to agree with; what remains to hold is the order itself, over a
 * fixture where title order and slug order disagree.
 */
test('the title-then-slug comparator orders by title, then by slug', () => {
  const corpus = [
    entry('zebra', { title: 'Apple', collection: 'shared' }),
    entry('apple', { title: 'Zebra', collection: 'shared' }),
    entry('same-b', { title: 'Same', collection: 'shared' }),
    entry('same-a', { title: 'Same', collection: 'shared' }),
  ];
  assert.deepEqual(slugsOf([...corpus].sort(byTitleThenSlug)), ['zebra', 'same-a', 'same-b', 'apple']);
  // The facet's own entries use the same comparator.
  const ordered = collectionFacets(corpus).find((facet) => facet.key === 'shared')!.entries;
  assert.deepEqual(slugsOf(ordered), ['zebra', 'same-a', 'same-b', 'apple']);
});

// --- Related notes ------------------------------------------------------------

/**
 * A corpus where counting shared tags and ranking by the rarest shared tag give
 * opposite answers.
 *
 * `subject` carries one rare tag and two common ones. `rare-peer` shares only
 * the rare tag — one shared tag. `common-peer` shares both common tags — two
 * shared tags, so a plain count ranks it first. The rule ranks `rare-peer`
 * first, because the tag it shares groups two notes while each common tag
 * groups five.
 *
 * Without this disagreement the two rules are indistinguishable, which is
 * exactly what a weaker fixture hid: a corpus where the rare peer also happens
 * to share the common tags passes under both rules and proves neither.
 */
function rarityCorpus(): ContentEntry[] {
  return [
    entry('subject', { title: 'Subject', tags: ['rare', 'common-x', 'common-y'] }),
    // Title sorts last, so its position can only come from the ranking.
    entry('rare-peer', { title: 'Zed Rare Peer', tags: ['rare'] }),
    entry('common-peer', { title: 'Alpha Common Peer', tags: ['common-x', 'common-y'] }),
    entry('filler-a', { title: 'Filler A', tags: ['common-x', 'common-y'] }),
    entry('filler-b', { title: 'Filler B', tags: ['common-x', 'common-y'] }),
    entry('filler-c', { title: 'Filler C', tags: ['common-x', 'common-y'] }),
  ];
}

test('the rarest shared tag ranks a candidate, not a count of shared tags', () => {
  const corpus = rarityCorpus();
  const related = relatedNotes(corpus[0]!, corpus);

  // The premise, asserted rather than assumed: a plain count really does
  // disagree here, so this fixture can tell the two rules apart.
  const facets = tagFacets(corpus);
  const sizeOf = (label: string) => facets.find((facet) => facet.key === label)!.entries.length;
  assert.equal(sizeOf('rare'), 2, 'the rare tag is no longer rare in this fixture');
  assert.ok(sizeOf('common-x') > sizeOf('rare'), 'the common tags are no longer common');

  assert.equal(
    related[0]!.slug,
    'rare-peer',
    'the note sharing one rare tag is not first — the ranking is counting tags, not ranking by rarity',
  );
  assert.deepEqual(slugsOf(related).slice(1), ['common-peer', 'filler-a', 'filler-b', 'filler-c']);
});

/**
 * The case that broke the first version of this rule.
 *
 * Summing per-tag rarity made two middle-frequency shared tags outrank one
 * genuinely rare one — so the page's stated rule ("the tag grouping fewest
 * notes first") was false of the code that ran. Here `rare` groups 2 notes and
 * each `mid` tag groups 3, so a sum ranks `mid-peer` first and the minimum
 * ranks `rare-peer` first, which is what the page claims.
 */
test('one rare shared tag outranks two middling ones', () => {
  const corpus = [
    entry('subject', { title: 'Subject', tags: ['rare', 'mid-one', 'mid-two'] }),
    entry('rare-peer', { title: 'Zed Rare Peer', tags: ['rare'] }),
    entry('mid-peer', { title: 'Alpha Mid Peer', tags: ['mid-one', 'mid-two'] }),
    entry('mid-filler', { title: 'Mid Filler', tags: ['mid-one', 'mid-two'] }),
  ];
  const facets = tagFacets(corpus);
  const sizeOf = (label: string) => facets.find((facet) => facet.key === label)!.entries.length;
  assert.equal(sizeOf('rare'), 2);
  assert.equal(sizeOf('mid-one'), 3);
  // A sum of (corpus - group) weights gives mid-peer 1+1 = 2 against
  // rare-peer's 2, and the collection tiebreak does not separate them — so the
  // old rule put "Alpha Mid Peer" first on the title tiebreak alone.
  assert.equal(relatedNotes(corpus[0]!, corpus)[0]!.slug, 'rare-peer');
});

test('more shared tags break a tie between equally rare ones', () => {
  // Both candidates share a tag of the same group size, so the rarest-tag key
  // ties and the count is what separates them.
  const corpus = [
    entry('subject', { title: 'Subject', tags: ['alpha', 'beta'] }),
    entry('both', { title: 'Zed Both', tags: ['alpha', 'beta'] }),
    entry('one', { title: 'Alpha One', tags: ['alpha'] }),
    entry('other', { title: 'Alpha Other', tags: ['beta'] }),
  ];
  assert.equal(relatedNotes(corpus[0]!, corpus)[0]!.slug, 'both');
});

test('a note carrying only the commonest tag still relates, so the fallback is a fallback', () => {
  const corpus = rarityCorpus();
  assert.ok(relatedNotes(corpus[2]!, corpus).length > 0, 'a note with only common tags got no suggestions');
});

test('the note itself is never related to itself', () => {
  const corpus = rarityCorpus();
  for (const item of corpus) {
    assert.ok(
      !slugsOf(relatedNotes(item, corpus)).includes(item.slug),
      `${item.slug}: is listed as related to itself`,
    );
  }
});

test('a note already linked either way is excluded, so this is a fallback not a third edge list', () => {
  const corpus = [
    entry('subject', { tags: ['shared'], outgoing: ['target'], backlinks: ['source'] }),
    entry('target', { tags: ['shared'], backlinks: ['subject'] }),
    entry('source', { tags: ['shared'], outgoing: ['subject'] }),
    entry('unlinked', { tags: ['shared'] }),
  ];
  assert.deepEqual(slugsOf(relatedNotes(corpus[0]!, corpus)), ['unlinked']);
});

/**
 * The two reasons the list is empty are distinguishable.
 *
 * A note whose every tag-sharer is already linked has a neighbourhood — it is
 * rendered in the two sections above — and the page must not tell the reader
 * nothing shares a tag. `hasTagPeer` is what separates the cases, and without
 * it the empty state states something the artifact contradicts.
 */
test('a note whose every tag peer is already linked still has tag peers', () => {
  const linked = [
    entry('subject', { tags: ['shared'], outgoing: ['peer'] }),
    entry('peer', { tags: ['shared'], backlinks: ['subject'] }),
  ];
  assert.deepEqual(relatedNotes(linked[0]!, linked), [], 'the linked peer leaked into the related list');
  assert.equal(hasTagPeer(linked[0]!, linked), true, 'the only tag peer was reported as no peer at all');

  const alone = [entry('subject', { tags: ['solo'] }), entry('other', { tags: ['different'] })];
  assert.equal(hasTagPeer(alone[0]!, alone), false, 'a note with no tag peer was reported as having one');

  const untagged = [entry('bare'), entry('tagged', { tags: ['shared'] })];
  assert.equal(hasTagPeer(untagged[0]!, untagged), false);
});

test('a shared collection breaks a tie, and cannot create a relation on its own', () => {
  const corpus = [
    entry('subject', { title: 'Subject', tags: ['shared'], collection: 'here' }),
    // Same weight as `outside`; wins on the collection despite the later title.
    entry('inside', { title: 'Zed Inside', tags: ['shared'], collection: 'here' }),
    entry('outside', { title: 'Alpha Outside', tags: ['shared'], collection: 'elsewhere' }),
    // No shared tag: in the collection and still not related.
    entry('untagged-peer', { title: 'Untagged Peer', collection: 'here' }),
  ];
  assert.deepEqual(slugsOf(relatedNotes(corpus[0]!, corpus)), ['inside', 'outside']);
});

test('the list is bounded, and the bound is the documented one', () => {
  const corpus = [
    entry('subject', { tags: ['shared'] }),
    ...Array.from({ length: RELATED_LIMIT + 4 }, (_, index) =>
      entry(`peer-${index}`, { tags: ['shared'] }),
    ),
  ];
  assert.equal(relatedNotes(corpus[0]!, corpus).length, RELATED_LIMIT);
});

test('a note with no tags relates to nothing rather than to everything', () => {
  const corpus = [entry('bare'), entry('tagged', { tags: ['shared'] }), entry('also', { tags: ['shared'] })];
  assert.deepEqual(relatedNotes(corpus[0]!, corpus), []);
});

test('tags differing only by case are one tag here, exactly as on the tag page', () => {
  // `facets()` merges `Gardening` and `gardening` into one public page. A second
  // private normalization here would let a note be "related" on a tag the site
  // never publishes, or fail to relate two notes the tag page groups.
  const corpus = [
    entry('subject', { tags: ['Gardening'] }),
    entry('peer', { tags: ['gardening'] }),
  ];
  assert.deepEqual(slugsOf(relatedNotes(corpus[0]!, corpus)), ['peer']);
  assert.equal(tagFacets(corpus).length, 1, 'the fixture no longer exercises the case merge');
});

/**
 * The tag-grouping memo is keyed on the corpus, not shared across corpora.
 *
 * `facetsFor` caches `tagFacets` per call — without it the grouping runs twice
 * per page and a 900-entry build spends 8.9 s in this module
 * rather than 0.2 s. A cache is only safe here because it is keyed on the array
 * the caller passed: the fixture build, the published build, and this suite all
 * evaluate the module and pass *different* corpora, and a single cached value
 * would answer one build's question with another's data. That is the failure
 * this pins, and it is not hypothetical — the fixture build runs the whole
 * suite in the same process as its own artifact.
 */
test('two different corpora get their own answers, not each other s', () => {
  const small = [entry('subject', { tags: ['shared'] }), entry('peer-a', { tags: ['shared'] })];
  const large = [
    entry('subject', { tags: ['shared'] }),
    entry('peer-b', { tags: ['shared'] }),
    entry('peer-c', { tags: ['shared'] }),
  ];

  assert.deepEqual(slugsOf(relatedNotes(small[0]!, small)), ['peer-a']);
  assert.deepEqual(slugsOf(relatedNotes(large[0]!, large)), ['peer-b', 'peer-c']);
  // Back to the first, after the second has been through the same cache.
  assert.deepEqual(slugsOf(relatedNotes(small[0]!, small)), ['peer-a']);
  assert.equal(hasTagPeer(small[0]!, small), true);
});

test('the ranking is stable under a reordering of the artifact', () => {
  const corpus = rarityCorpus();
  const reversed = [...corpus].reverse();
  const subject = corpus[0]!;
  assert.deepEqual(
    slugsOf(relatedNotes(subject, corpus)),
    slugsOf(relatedNotes(subject, reversed)),
    'the same artifact in a different order produced a different related list',
  );
});

// --- Collection navigation ----------------------------------------------------

/** Three notes in one collection, plus a distractor outside it. */
function collectionCorpus(): ContentEntry[] {
  return [
    entry('beta', { title: 'Beta', collection: 'series' }),
    entry('alpha', { title: 'Alpha', collection: 'series' }),
    entry('gamma', { title: 'Gamma', collection: 'series' }),
    entry('elsewhere', { title: 'Elsewhere', collection: 'other' }),
  ];
}

test('the pager walks the collection in the order its own index lists', () => {
  const corpus = collectionCorpus();
  const order = collectionFacets(corpus).find((facet) => facet.key === 'series')!.entries;
  assert.deepEqual(slugsOf(order), ['alpha', 'beta', 'gamma'], 'the index order is not what was assumed');

  const middle = collectionNeighbours(corpus[0]!, corpus);
  assert.equal(middle.previous?.slug, 'alpha');
  assert.equal(middle.next?.slug, 'gamma');
});

test('the first and last note in a collection have one neighbour each', () => {
  const corpus = collectionCorpus();
  const first = collectionNeighbours(corpus[1]!, corpus);
  assert.equal(first.previous, undefined);
  assert.equal(first.next?.slug, 'beta');

  const last = collectionNeighbours(corpus[2]!, corpus);
  assert.equal(last.previous?.slug, 'beta');
  assert.equal(last.next, undefined);
});

test('a note with no collection, or alone in one, has no sequence at all', () => {
  const corpus = [
    entry('loose'),
    entry('only-one', { collection: 'solo' }),
    entry('paired-a', { collection: 'pair' }),
    entry('paired-b', { collection: 'pair' }),
  ];
  // Both fields absent, which is what the page branches on. Asserting the whole
  // object would pin `{}` against `{previous: undefined, next: undefined}` —
  // two spellings of the same answer, and not the one the template reads.
  for (const item of [corpus[0]!, corpus[1]!]) {
    const { previous, next } = collectionNeighbours(item, corpus);
    assert.equal(previous, undefined, `${item.slug}: has a previous note`);
    assert.equal(next, undefined, `${item.slug}: has a next note`);
  }
  // The pair is the control: the same code path does produce a pager when there
  // is something to page to.
  assert.equal(collectionNeighbours(corpus[2]!, corpus).next?.slug, 'paired-b');
});

test('the pager and the collection index agree across the whole sequence', () => {
  // Walking "next" from the first note must reproduce the index exactly, or a
  // reader following the pager visits the collection in an order its own page
  // does not show. The step bound is not decoration: a pager that wrapped from
  // the last note back to the first would otherwise hang this test rather than
  // fail it, and a gate that hangs on a defect is a gate nobody keeps.
  const corpus = collectionCorpus();
  const index = collectionFacets(corpus).find((facet) => facet.key === 'series')!.entries;
  const walked = [index[0]!.slug];
  let current = index[0]!;
  for (let step = 0; step <= index.length; step += 1) {
    const { next } = collectionNeighbours(current, corpus);
    if (next === undefined) break;
    assert.ok(!walked.includes(next.slug), `the pager revisits "${next.slug}" — the sequence is a cycle`);
    walked.push(next.slug);
    current = next;
  }
  assert.deepEqual(walked, slugsOf(index));
});
