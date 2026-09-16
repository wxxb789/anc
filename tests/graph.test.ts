/**
 * The build-time graph model.
 *
 * Unit tests over `src/lib/graph.ts` against synthetic fixtures. What the built
 * pages render lives in `tests/built-routes.test.ts`, and what a browser does
 * with it lives in `tests/rendered-page.test.ts`. Selection and ranking are
 * shared with the Worker, so their oracles live in
 * `tests/graph-selection.test.ts`; what stays here is the IR adapter and the
 * layout: the drawn edge set, direction, counts, geometry, labels, and the
 * adjacency the accessible table renders.
 *
 * Two properties get most of the weight, because both are invisible to review
 * and both would ship silently:
 *
 * 1. **The drawn edge set is exactly the artifact's edge set** over the drawn
 *    nodes. A graph that dropped a chord, or invented one, looks entirely
 *    correct — it is a picture, and pictures do not fail loudly.
 * 2. **The layout is deterministic.** The build is reproducible, so identical
 *    input must give byte-identical geometry. Asserting "two calls agree" is not
 *    enough on its own: a layout seeded from the artifact's own order would pass
 *    that and still differ between a build and a re-export, so the fixture below
 *    also feeds the same corpus in a different order.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { ContentEntry } from '../src/lib/schema.ts';
import {
  GLOBAL_NODE_LIMIT,
  LOCAL_NODE_LIMIT,
  boundCounts,
  drawnNeighbours,
  globalGraph,
  hasDrawableGraph,
  localGraph,
  truncateLabel,
  type Graph,
} from '../src/lib/graph.ts';

/** A minimal valid entry; every field the graph model reads is overridable. */
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

function lookupIn(entries: readonly ContentEntry[]): (slug: string) => ContentEntry | undefined {
  const bySlug = new Map(entries.map((item) => [item.slug, item]));
  return (slug) => bySlug.get(slug);
}

const slugsOf = (graph: Graph): string[] => graph.nodes.map((node) => node.entry.slug);

/**
 * Complete both halves of every edge, the way the exporter does.
 *
 * `checkCorpus` proves `backlinks` is the exact inverse of `outgoing` across the
 * corpus, so a fixture that sets only `outgoing` is a shape the validated loader
 * can never produce — and a graph tested against it would be tested against
 * data the site does not have. Deriving the inverse here means a fixture states
 * its edges once and still exercises the real contract.
 */
function withBacklinks(entries: readonly ContentEntry[]): ContentEntry[] {
  return entries.map((item) => ({
    ...item,
    backlinks: entries
      .filter((other) => other.outgoing.includes(item.slug))
      .map((other) => other.slug)
      .sort(),
  }));
}

/**
 * A hub, its four neighbours, and chords between the neighbours.
 *
 * The chords are the point. A neighbourhood drawn as spokes from the subject
 * would pass every test that only counted nodes, so `beta → gamma` and
 * `gamma → delta` exist to make "the induced subgraph, not a star" a falsifiable
 * claim. `outside` is joined to a neighbour but not to the hub, so it must not
 * appear: one hop means one hop.
 */
function neighbourhoodCorpus(): ContentEntry[] {
  return withBacklinks([
    entry('hub', { title: 'Hub', outgoing: ['alpha', 'beta'] }),
    entry('alpha', { title: 'Alpha' }),
    entry('beta', { title: 'Beta', outgoing: ['gamma'] }),
    entry('gamma', { title: 'Gamma', outgoing: ['delta', 'hub'] }),
    entry('delta', { title: 'Delta', outgoing: ['hub'] }),
    entry('outside', { title: 'Outside', outgoing: ['delta'] }),
  ]);
}

// --- The drawn nodes and edges ----------------------------------------------

/**
 * The drawn node set is the one-hop neighbourhood, and the drawn edge set is
 * exactly the artifact's edges over it.
 *
 * The acceptance criterion, stated over content rather than over a count: a
 * cardinality check passes for a graph that drew the right *number* of wrong
 * edges, and the failure it would miss — one chord silently dropped — is the
 * one this whole module could get wrong without anybody noticing. The membership
 * half is the same claim from the other side: one hop, and an unresolvable
 * target is skipped rather than thrown on.
 */
test('the drawn graph is exactly the one-hop neighbourhood over the artifact edges', () => {
  const corpus = neighbourhoodCorpus();
  const graph = localGraph(corpus[0]!, lookupIn(corpus));
  const drawn = new Set(slugsOf(graph));

  assert.deepEqual([...drawn].sort(), ['alpha', 'beta', 'delta', 'gamma', 'hub'], 'the drawn set is not the one-hop neighbourhood');
  assert.ok(!drawn.has('outside'), 'a two-hop note was drawn in a one-hop graph');

  /** Every authored edge with both ends drawn, as one unordered pair each. */
  const expected = new Set<string>();
  for (const item of corpus) {
    if (!drawn.has(item.slug)) continue;
    for (const target of item.outgoing) {
      if (!drawn.has(target)) continue;
      expected.add([item.slug, target].sort().join(' '));
    }
  }
  const actual = new Set(graph.edges.map((edge) => [edge.from, edge.to].sort().join(' ')));

  assert.deepEqual([...actual].sort(), [...expected].sort());
  // The premise: this fixture really does have edges between neighbours, so the
  // comparison above is not two empty sets agreeing.
  assert.ok(
    [...expected].some((pair) => !pair.includes('hub')),
    'the fixture has no edge between two neighbours — it cannot tell a star from a subgraph',
  );

  // `checkCorpus` proves a dangling target cannot reach a page through the
  // validated loader. The module is pure and must not depend on a caller having
  // validated first.
  const dangling = [entry('subject', { outgoing: ['absent'], backlinks: [] })];
  assert.deepEqual(slugsOf(localGraph(dangling[0]!, lookupIn(dangling))), ['subject']);
});

/**
 * Direction is read from the subject's own edge lists, and a reciprocal pair is
 * one line.
 *
 * `outgoing`/`incoming`/`mutual` is what the stylesheet draws as a dash rather
 * than a colour, so it is the data behind requirements section 13.2's "incoming
 * and outgoing edges visually distinguished" and section 17's ban on
 * colour-only encoding. An edge between two neighbours has no direction
 * relative to a subject and must carry none — labelling it would be stating a
 * relationship the artifact does not express. The same corpus pins the other
 * half: a reciprocal link is one segment marked mutual, a one-way edge is not.
 */
test('a mutual pair is one line, and direction comes from the subject s own edge lists', () => {
  const corpus = withBacklinks([
    entry('subject', { title: 'Subject', outgoing: ['both', 'out'] }),
    entry('out', { title: 'Out', outgoing: ['in'] }),
    entry('in', { title: 'In', outgoing: ['subject'] }),
    entry('both', { title: 'Both', outgoing: ['subject'] }),
    entry('stranger', { title: 'Stranger' }),
  ]);
  const graph = localGraph(corpus[0]!, lookupIn(corpus));

  const edgeFor = (a: string, b: string) =>
    graph.edges.filter((edge) => (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a));
  const directionOf = (a: string, b: string) => edgeFor(a, b)[0]?.direction;

  assert.equal(directionOf('subject', 'out'), 'outgoing');
  assert.equal(directionOf('subject', 'in'), 'incoming');
  assert.equal(directionOf('subject', 'both'), 'mutual');
  // `out → in` joins two neighbours: a real drawn edge, with no direction.
  assert.equal(directionOf('out', 'in'), undefined, 'an edge between neighbours claims a direction');
  assert.ok(
    graph.edges.some((edge) => edge.from !== 'subject' && edge.to !== 'subject'),
    'the fixture has no edge between two neighbours',
  );

  // A reciprocal link is one segment with the mutual flag; a one-way edge is
  // not marked mutual, or the flag means nothing.
  const mutual = edgeFor('subject', 'both');
  assert.equal(mutual.length, 1, 'a reciprocal link was drawn as two segments');
  assert.equal(mutual[0]!.isMutual, true);
  assert.equal(edgeFor('subject', 'out')[0]!.isMutual, false);

  // And every drawn neighbour carries a direction, so the shape a screen reader
  // reads is never absent on the page that has a subject.
  for (const node of graph.nodes) {
    if (node.isSubject) continue;
    assert.ok(node.direction !== undefined, `${node.entry.slug}: drawn with no edge direction`);
  }

  // `/graph/` has no subject at all, so no edge on it may claim one.
  for (const edge of globalGraph(corpus).edges) {
    assert.equal(edge.direction, undefined, 'a global-graph edge claims a direction with no subject');
  }
});

// --- Bounds ------------------------------------------------------------------

/**
 * The bound's two numbers are the neighbours, never the note itself.
 *
 * `omitted` is zero exactly when nothing was dropped, and `boundCounts` is the
 * single place the page's "Drawing N of M **neighbouring notes**" sentence
 * computes its numbers — a note is not one of its own neighbours, so neither
 * number may count the subject. This is the arithmetic no built page can check,
 * because no built page renders the truncation sentence: the fixture corpus's
 * busiest note has 10 neighbours against a bound of 12, and the published note
 * has none. The counts are chosen to straddle the bound exactly, because
 * `omitted > 0` alone decides whether the sentence renders.
 *
 * It is not hypothetical, and it took three attempts. The first version passed
 * the raw node count as both bases and would have rendered "13 of 16" where the
 * truth was 12 of 15. The second corrected only the total and rendered "13 of
 * 15" — worse, because the numerator then exceeded the notes actually drawn.
 * The third fixed the component and added a test that *restated* the
 * arithmetic, which caught nothing: reverting the component left the suite
 * green, because the test compared the model against a copy of the expression
 * rather than against the component.
 */
test('the bound reports what it dropped and counts neighbours, never the note itself', () => {
  const peers = (count: number) =>
    withBacklinks([
      entry('subject', {
        outgoing: Array.from({ length: count }, (_, index) => `peer-${String(index).padStart(2, '0')}`),
      }),
      ...Array.from({ length: count }, (_, index) => entry(`peer-${String(index).padStart(2, '0')}`)),
    ]);

  for (const count of [1, LOCAL_NODE_LIMIT - 1, LOCAL_NODE_LIMIT, LOCAL_NODE_LIMIT + 1, LOCAL_NODE_LIMIT + 7]) {
    const corpus = peers(count);
    const graph = localGraph(corpus[0]!, lookupIn(corpus));
    const dropped = Math.max(0, count - LOCAL_NODE_LIMIT);
    assert.equal(graph.omitted, dropped, `${count} neighbours: wrong omitted count`);
    assert.equal(graph.nodes.length, Math.min(count, LOCAL_NODE_LIMIT) + 1, `${count} neighbours: the subject plus the bound is not what was drawn`);
    // The two numbers the sentence interpolates must add up to the corpus's own
    // neighbour count, or the page states a total that is not the total.
    assert.equal(graph.nodes.length - 1 + graph.omitted, count, `${count} neighbours: drawn + omitted is not the neighbour total`);

    const { shown, total } = boundCounts(graph);
    assert.equal(shown, Math.min(count, LOCAL_NODE_LIMIT), `${count} neighbours: the drawn count is wrong`);
    assert.equal(total, count, `${count} neighbours: the stated total is not the neighbour count`);
    assert.ok(shown <= total, `${count} neighbours: the sentence would read "${shown} of ${total}"`);
    // The subject is drawn, and is excluded from both numbers — which is the
    // whole defect. Without this the assertions above hold for a graph that
    // simply never drew the subject at all.
    assert.ok(
      graph.nodes.some((node) => node.isSubject),
      `${count} neighbours: the subject is not drawn, so the exclusion proves nothing`,
    );
  }

  // `/graph/` has no subject, so its counts are simply its node counts: the same
  // function needs no flag telling the two surfaces apart.
  const corpus = neighbourhoodCorpus();
  const site = globalGraph(corpus, 4);
  assert.ok(!site.nodes.some((node) => node.isSubject), 'the global graph drew a subject, so this no longer tests the identity case');
  const counts = boundCounts(site);
  assert.equal(counts.shown, site.nodes.length);
  assert.equal(counts.total, corpus.length);
});

test('the global graph is bounded to the most connected notes and reports the rest', () => {
  const corpus = withBacklinks([
    entry('hub', { title: 'Hub', outgoing: ['a', 'b', 'c'] }),
    entry('a', { title: 'A' }),
    entry('b', { title: 'B' }),
    entry('c', { title: 'C' }),
    entry('lonely', { title: 'Lonely' }),
  ]);

  // The centre is the hub, and a lonely note is on the outside — the whole
  // claim the ranked packing makes to a reader.
  const graph = globalGraph(corpus);
  assert.equal(graph.nodes[0]!.entry.slug, 'hub');
  assert.equal(graph.nodes[0]!.x, 0);
  assert.equal(graph.nodes[0]!.y, 0);
  assert.equal(graph.nodes.at(-1)!.entry.slug, 'lonely');
  assert.equal(graph.omitted, 0);

  const bounded = globalGraph(corpus, 2);
  assert.deepEqual(slugsOf(bounded), ['hub', 'a']);
  assert.equal(bounded.omitted, 3, 'the global bound does not report what it left out');

  // The documented default is the one the module applies.
  const wide = withBacklinks(Array.from({ length: GLOBAL_NODE_LIMIT + 5 }, (_, index) => entry(`note-${index}`)));
  assert.equal(globalGraph(wide).nodes.length, GLOBAL_NODE_LIMIT);
});

// --- Determinism and geometry -------------------------------------------------

/**
 * The same corpus in a different order produces the same picture.
 *
 * Two calls with the *same* array agreeing proves only that the function has no
 * hidden mutable state. A layout that read the artifact's order — which a ring
 * placement trivially could — would pass that and still emit different geometry
 * after a re-export reordered one entry. Reversing the input is what separates
 * the two.
 */
test('the layout does not depend on the order the artifact lists entries in', () => {
  const corpus = neighbourhoodCorpus();
  const reversed = [...corpus].reverse();
  const subject = corpus[0]!;

  assert.deepEqual(
    localGraph(subject, lookupIn(corpus)),
    localGraph(subject, lookupIn(reversed)),
    'the same artifact in a different order laid out differently',
  );
  assert.deepEqual(
    globalGraph(corpus),
    globalGraph(reversed),
    'the global graph depends on the artifact s ordering',
  );
});

/**
 * The geometry the SVG serializes: finite, rounded, in-frame, and distinct.
 *
 * All of these are invisible at review time and all three are attribute-level:
 * a `-0` serializes as a different string than `0`, a coordinate past the
 * viewBox clips, and two nodes on one point read as one node.
 */
test('the layout emits distinct, finite, rounded coordinates inside its own viewBox', () => {
  const corpus = neighbourhoodCorpus();
  for (const graph of [localGraph(corpus[0]!, lookupIn(corpus)), globalGraph(corpus)]) {
    const [minX, minY, width, height] = graph.viewBox.split(' ').map(Number) as [
      number,
      number,
      number,
      number,
    ];
    assert.equal(graph.width, width);
    assert.equal(graph.height, height);

    const numbers = [
      ...graph.nodes.flatMap((node) => [node.x, node.y]),
      ...graph.edges.flatMap((edge) => [edge.x1, edge.y1, edge.x2, edge.y2]),
    ];
    assert.ok(numbers.length > 0, 'no coordinate was inspected');
    for (const value of numbers) {
      assert.ok(Number.isFinite(value), `${value} is not a finite coordinate`);
      // `Object.is` rather than `=== 0`: `-0 === 0` is true, and `-0` is exactly
      // the value that serializes as a different attribute string.
      assert.ok(!Object.is(value, -0), 'a coordinate is negative zero, which serializes as "-0"');
      assert.equal(value, Math.round(value * 100) / 100, `${value} carries more than two decimals`);
    }

    const seen = new Set<string>();
    for (const node of graph.nodes) {
      assert.ok(
        node.x > minX && node.x < minX + width && node.y > minY && node.y < minY + height,
        `${node.entry.slug} at (${node.x}, ${node.y}) is outside the viewBox ${graph.viewBox}`,
      );
      seen.add(`${node.x},${node.y}`);
    }
    assert.equal(seen.size, graph.nodes.length, 'two nodes were placed on the same point');
  }
});

// --- Labels -------------------------------------------------------------------

/**
 * A label is truncated by code point, and never replaces the node's full title.
 *
 * Twenty emoji: a `slice` by UTF-16 unit would cut one in half and emit a lone
 * surrogate. The fixture corpus has a title starting with an astral glyph, so
 * this is the shape the site actually carries. The node keeps its full title
 * beside the drawn label, which is what the accessible name reads.
 */
test('a label truncates by code point and never replaces the node s full title', () => {
  const long = '🌿'.repeat(20);
  const label = truncateLabel(long);
  assert.ok([...label].length <= 18, `the label is ${[...label].length} code points`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label), 'the label ends in a lone surrogate');
  assert.equal(truncateLabel('Short'), 'Short', 'a short title was altered');

  const corpus = withBacklinks([
    entry('subject', { title: 'A Title Far Longer Than Any Label Could Hold', outgoing: ['peer'] }),
    entry('peer', { title: 'Another Title That Will Not Fit Beside A Circle' }),
  ]);
  for (const node of localGraph(corpus[0]!, lookupIn(corpus)).nodes) {
    assert.notEqual(node.label, node.entry.title, 'the fixture no longer exercises truncation');
    assert.ok(node.entry.title.startsWith(node.label.replace(/…$/, '').trimEnd()));
  }
});

// --- Degrees and the table adjacency ------------------------------------------

test('a drawn degree counts only edges the figure actually shows', () => {
  const corpus = neighbourhoodCorpus();
  const graph = localGraph(corpus[0]!, lookupIn(corpus));
  for (const node of graph.nodes) {
    const drawn = graph.edges.filter(
      (edge) => edge.from === node.entry.slug || edge.to === node.entry.slug,
    ).length;
    assert.equal(node.degree, drawn, `${node.entry.slug}: reports a degree the picture does not show`);
  }
  // `delta` links to `outside`, which is not drawn — so its artifact degree is
  // higher than its drawn one, and a node's name must state the smaller number.
  const delta = graph.nodes.find((node) => node.entry.slug === 'delta')!;
  const authored = new Set([...delta.entry.outgoing, ...delta.entry.backlinks]).size;
  assert.ok(authored > delta.degree, 'the fixture no longer has an edge leaving the drawn set');
});

/**
 * The adjacency the equivalent table renders is the drawn edge set.
 *
 * Requirements section 17 asks for the graph *data* as a list or table, and
 * this is the function that supplies the column carrying it. A table of node,
 * relationship, and degree states how many lines touch a node while withholding
 * which notes they run to — and on `/graph/`, where no node has a relationship
 * to a subject, that leaves the whole edge set unavailable to a non-visual
 * reader. Review found exactly that.
 */
test('the table adjacency names both ends of every drawn edge, and is empty rather than absent', () => {
  const corpus = neighbourhoodCorpus();
  for (const graph of [localGraph(corpus[0]!, lookupIn(corpus)), globalGraph(corpus)]) {
    const joined = drawnNeighbours(graph);

    // Every drawn node has an entry, so a row never renders an absent list.
    assert.deepEqual(
      [...joined.keys()].sort(),
      graph.nodes.map((node) => node.entry.slug).sort(),
    );

    // Reconstructing the edge set from the adjacency gives back the edges.
    const fromAdjacency = new Set<string>();
    for (const [slug, others] of joined) {
      for (const other of others) fromAdjacency.add([slug, other.slug].sort().join(' '));
    }
    assert.deepEqual(
      [...fromAdjacency].sort(),
      [...new Set(graph.edges.map((edge) => [edge.from, edge.to].sort().join(' ')))].sort(),
      'the table adjacency is not the drawn edge set',
    );

    // And it agrees with the degree the same node reports, or the two columns
    // of the same row would contradict each other.
    for (const node of graph.nodes) {
      assert.equal(
        joined.get(node.entry.slug)!.length,
        node.degree,
        `${node.entry.slug}: the adjacency and the drawn degree disagree`,
      );
    }
  }

  // A node with no edges gets an empty adjacency, not a missing row.
  const alone = [entry('only')];
  const joined = drawnNeighbours(localGraph(alone[0]!, lookupIn(alone)));
  assert.deepEqual([...joined.keys()], ['only']);
  assert.deepEqual(joined.get('only'), []);
});

// --- The empty cases ----------------------------------------------------------

/**
 * The published corpus's own shape: one note, no edges.
 *
 * This is the case the deployed site shows today, so a graph that only works on
 * the fixture corpus is a graph that does not work. `hasDrawableGraph` is what
 * lets the page say so in a sentence rather than draw one circle and no lines,
 * and an empty corpus must still lay out a drawable box.
 */
test('a graph with no edges is not drawable, and an empty corpus still lays out', () => {
  const alone = [entry('only')];
  const graph = localGraph(alone[0]!, lookupIn(alone));
  assert.equal(hasDrawableGraph(graph), false);
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(slugsOf(graph), ['only'], 'the subject itself is missing from its own graph');
  assert.equal(hasDrawableGraph(globalGraph(alone)), false);

  // The control: the same functions do report a drawable graph when there is one.
  const linked = withBacklinks([entry('subject', { outgoing: ['peer'] }), entry('peer')]);
  assert.equal(hasDrawableGraph(localGraph(linked[0]!, lookupIn(linked))), true);
  assert.equal(hasDrawableGraph(globalGraph(linked)), true);

  const empty = globalGraph([]);
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
  assert.ok(empty.width > 0, 'an empty graph has no drawable box');
  assert.equal(empty.omitted, 0);
});
