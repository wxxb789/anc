/**
 * The build-time graph model.
 *
 * Unit tests over `src/lib/graph.ts` against synthetic fixtures. What the built
 * pages render lives in `tests/built-routes.test.ts`, and what a browser does
 * with it lives in `tests/rendered-page.test.ts`.
 *
 * Two properties get most of the weight here, because both are invisible to
 * review and both would ship silently:
 *
 * 1. **The drawn edge set is exactly the artifact's edge set** over the drawn
 *    nodes. A graph that dropped a chord, or invented one, looks entirely
 *    correct — it is a picture, and pictures do not fail loudly.
 * 2. **The layout is deterministic.** The build is reproducible, so identical
 *    input must give byte-identical geometry. Asserting "two calls agree" is not
 *    enough on its own: a layout seeded from the artifact's own order would pass
 *    that and still differ between a build and a re-export, so the fixtures below
 *    also feed the same corpus in a different order.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { ContentEntry } from '../src/lib/schema.ts';
import {
  GLOBAL_NODE_LIMIT,
  LOCAL_NODE_LIMIT,
  edgeDirection,
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

// --- The edge set ------------------------------------------------------------

/**
 * Every authored edge between two drawn notes is drawn, and nothing else is.
 *
 * The acceptance criterion, stated over content rather than over a count: a
 * cardinality check passes for a graph that drew the right *number* of wrong
 * edges, and the failure it would miss — one chord silently dropped — is the
 * one this whole module could get wrong without anybody noticing.
 */
test('the drawn edges are exactly the artifact s edges over the drawn nodes', () => {
  const corpus = neighbourhoodCorpus();
  const graph = localGraph(corpus[0]!, lookupIn(corpus));
  const drawn = new Set(slugsOf(graph));

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
});

test('a mutual edge is one line with two arrowheads, not two overlapping lines', () => {
  const corpus = withBacklinks([
    entry('subject', { outgoing: ['peer'] }),
    entry('peer', { outgoing: ['subject'] }),
  ]);
  const graph = localGraph(corpus[0]!, lookupIn(corpus));
  assert.equal(graph.edges.length, 1, 'a reciprocal link was drawn as two segments');
  assert.equal(graph.edges[0]!.isMutual, true);
  // And a one-way edge is not marked mutual, or the flag means nothing.
  const oneWay = withBacklinks([entry('subject', { outgoing: ['peer'] }), entry('peer')]);
  assert.equal(localGraph(oneWay[0]!, lookupIn(oneWay)).edges[0]!.isMutual, false);
});

test('the three edge directions are read from the subject s own edge lists', () => {
  const corpus = withBacklinks([
    entry('subject', { outgoing: ['out', 'both'] }),
    entry('out'),
    entry('in', { outgoing: ['subject'] }),
    entry('both', { outgoing: ['subject'] }),
    entry('stranger'),
  ]);
  const subject = corpus[0]!;
  assert.equal(edgeDirection(subject, 'out'), 'outgoing');
  assert.equal(edgeDirection(subject, 'in'), 'incoming');
  assert.equal(edgeDirection(subject, 'both'), 'mutual');
  assert.equal(edgeDirection(subject, 'stranger'), undefined);

  // And every drawn neighbour carries one, so the shape a screen reader reads
  // is never absent on the page that has a subject.
  const graph = localGraph(subject, lookupIn(corpus));
  for (const node of graph.nodes) {
    if (node.isSubject) continue;
    assert.ok(node.direction !== undefined, `${node.entry.slug}: drawn with no edge direction`);
  }
});

test('a two-hop note is not drawn, and an unresolvable edge is skipped', () => {
  const corpus = neighbourhoodCorpus();
  const graph = localGraph(corpus[0]!, lookupIn(corpus));
  assert.ok(!slugsOf(graph).includes('outside'), 'a two-hop note was drawn in a one-hop graph');

  // `checkCorpus` proves this cannot reach a page through the validated loader.
  // The module is pure and must not depend on a caller having validated first.
  const dangling = [entry('subject', { outgoing: ['absent'], backlinks: [] })];
  assert.deepEqual(slugsOf(localGraph(dangling[0]!, lookupIn(dangling))), ['subject']);
});

/**
 * An edge touching the subject carries the subject's own view of it.
 *
 * This is what the stylesheet draws as a dash rather than a colour, so it is
 * the data behind requirements section 13.2's "incoming and outgoing edges
 * visually distinguished" and section 17's ban on colour-only encoding. An edge
 * between two neighbours has no direction relative to a subject and must carry
 * none — labelling it would be stating a relationship the artifact does not
 * express.
 */
test('an edge touching the subject carries its direction, and one between neighbours does not', () => {
  const corpus = withBacklinks([
    entry('subject', { title: 'Subject', outgoing: ['both', 'out'] }),
    entry('out', { title: 'Out', outgoing: ['in'] }),
    entry('in', { title: 'In', outgoing: ['subject'] }),
    entry('both', { title: 'Both', outgoing: ['subject'] }),
  ]);
  const graph = localGraph(corpus[0]!, lookupIn(corpus));

  const directionOf = (a: string, b: string) =>
    graph.edges.find(
      (edge) => (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a),
    )?.direction;

  assert.equal(directionOf('subject', 'out'), 'outgoing');
  assert.equal(directionOf('subject', 'in'), 'incoming');
  assert.equal(directionOf('subject', 'both'), 'mutual');
  // `out → in` joins two neighbours: a real drawn edge, with no direction.
  assert.equal(directionOf('out', 'in'), undefined, 'an edge between neighbours claims a direction');
  assert.ok(
    graph.edges.some((edge) => edge.from !== 'subject' && edge.to !== 'subject'),
    'the fixture has no edge between two neighbours',
  );

  // `/graph/` has no subject at all, so no edge on it may claim one.
  for (const edge of globalGraph(corpus).edges) {
    assert.equal(edge.direction, undefined, 'a global-graph edge claims a direction with no subject');
  }
});

// --- Bounds ------------------------------------------------------------------

test('the local graph is bounded, reports what it omitted, and truncates by title', () => {
  const many = withBacklinks([
    entry('subject', {
      outgoing: Array.from({ length: LOCAL_NODE_LIMIT + 3 }, (_, index) => `peer-${index}`).sort(),
    }),
    // Titles are the reverse of slug order, so a graph truncating in artifact
    // order keeps a different set than one truncating in title order — which is
    // what makes the assertion below able to tell them apart.
    ...Array.from({ length: LOCAL_NODE_LIMIT + 3 }, (_, index) =>
      entry(`peer-${index}`, { title: `Peer ${String(LOCAL_NODE_LIMIT + 3 - index).padStart(2, '0')}` }),
    ),
  ]);
  const graph = localGraph(many[0]!, lookupIn(many));

  assert.equal(graph.nodes.length, LOCAL_NODE_LIMIT + 1, 'the subject plus the bound is not what was drawn');
  assert.equal(graph.omitted, 3, 'the omitted count does not match what the bound dropped');

  const titles = graph.nodes.filter((node) => !node.isSubject).map((node) => node.entry.title);
  assert.deepEqual(titles, [...titles].sort(), 'the neighbourhood is not in title order');
  assert.ok(
    titles.includes('Peer 01') && !titles.includes('Peer 15'),
    'the bound kept the artifact s order rather than the reader s',
  );
});

test('the global graph is bounded to the most connected notes', () => {
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
});

test('the documented global bound is the one the module applies', () => {
  const corpus = withBacklinks(
    Array.from({ length: GLOBAL_NODE_LIMIT + 5 }, (_, index) => entry(`note-${index}`)),
  );
  assert.equal(globalGraph(corpus).nodes.length, GLOBAL_NODE_LIMIT);
});

// --- Determinism -------------------------------------------------------------

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

test('every coordinate is a finite, rounded number with no negative zero', () => {
  const corpus = neighbourhoodCorpus();
  for (const graph of [localGraph(corpus[0]!, lookupIn(corpus)), globalGraph(corpus)]) {
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
  }
});

// --- Geometry and labels ------------------------------------------------------

test('every node sits inside the viewBox, labels included', () => {
  const corpus = neighbourhoodCorpus();
  for (const graph of [localGraph(corpus[0]!, lookupIn(corpus)), globalGraph(corpus)]) {
    const [minX, minY, width, height] = graph.viewBox.split(' ').map(Number) as [
      number,
      number,
      number,
      number,
    ];
    for (const node of graph.nodes) {
      assert.ok(
        node.x > minX && node.x < minX + width && node.y > minY && node.y < minY + height,
        `${node.entry.slug} at (${node.x}, ${node.y}) is outside the viewBox ${graph.viewBox}`,
      );
    }
    assert.equal(graph.width, width);
    assert.equal(graph.height, height);
  }
});

test('two nodes never share a position', () => {
  const corpus = withBacklinks([
    entry('subject', { outgoing: ['one', 'two', 'three'] }),
    entry('one'),
    entry('two'),
    entry('three'),
  ]);
  for (const graph of [localGraph(corpus[0]!, lookupIn(corpus)), globalGraph(corpus)]) {
    const seen = new Set(graph.nodes.map((node) => `${node.x},${node.y}`));
    assert.equal(seen.size, graph.nodes.length, 'two nodes were placed on the same point');
  }
});

test('a label is truncated by code point, so an astral character is never split', () => {
  // Twenty emoji: a `slice` by UTF-16 unit would cut one in half and emit a lone
  // surrogate. The fixture corpus has a title starting with an astral glyph, so
  // this is the shape the site actually carries.
  const long = '🌿'.repeat(20);
  const label = truncateLabel(long);
  assert.ok([...label].length <= 18, `the label is ${[...label].length} code points`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label), 'the label ends in a lone surrogate');
  assert.equal(truncateLabel('Short'), 'Short', 'a short title was altered');
});

test('a node keeps its full title, whatever the drawn label says', () => {
  const corpus = withBacklinks([
    entry('subject', { title: 'A Title Far Longer Than Any Label Could Hold', outgoing: ['peer'] }),
    entry('peer', { title: 'Another Title That Will Not Fit Beside A Circle' }),
  ]);
  for (const node of localGraph(corpus[0]!, lookupIn(corpus)).nodes) {
    assert.notEqual(node.label, node.entry.title, 'the fixture no longer exercises truncation');
    assert.ok(node.entry.title.startsWith(node.label.replace(/…$/, '').trimEnd()));
  }
});

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

// --- The empty cases ----------------------------------------------------------

/**
 * The published corpus's own shape: one note, no edges.
 *
 * This is the case the deployed site shows today, so a graph that only works on
 * the fixture corpus is a graph that does not work. `hasDrawableGraph` is what
 * lets the page say so in a sentence rather than draw one circle and no lines.
 */
test('a note with no edges has no graph worth drawing', () => {
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
});

test('an empty corpus lays out rather than throwing', () => {
  const graph = globalGraph([]);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.ok(graph.width > 0, 'an empty graph has no drawable box');
  assert.equal(graph.omitted, 0);
});
