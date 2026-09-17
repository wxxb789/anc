/**
 * The graph selection contract over a real snapshot.
 *
 * Three consumers must select the same notes: the build's static graph, the
 * shared `graph-selection.ts` contract, and the Worker's named operations. The
 * first test is the single end-to-end comparison — full public identity (slug,
 * title, effective language), ordered directed edges, and omitted counts — run
 * over every note, every tag, and a hand-listed browser-shaped corpus.
 *
 * The tests after it are the goal's own defect list, each written with a
 * hand-listed oracle so a ranking, reciprocity, ordering, or induced-edge
 * defect is visible rather than restated:
 *
 * - a global bound applied before ranking,
 * - a reciprocal pair counted once per direction, on both the unfiltered and
 *   the tag-filtered degree paths,
 * - a local slice taken before the title sort,
 * - a local edge list restricted to a center-only star or reversed.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { validateArtifact, type ContentArtifact, type ContentEntry } from '../src/lib/schema.ts';
import { tagFacets } from '../src/lib/routes.ts';
import { GLOBAL_NODE_LIMIT, selectGlobal, selectLocal, type SelectionEdge } from '../src/lib/graph-selection.ts';
import { globalGraph, localGraph, type Graph } from '../src/lib/graph.ts';
import type { NoteSummary } from '../src/lib/snapshot-queries.ts';
import { globalGraph as workerGlobal, localGraph as workerLocal, type SnapshotDb } from '../src/lib/snapshot-operations.ts';
import { NAV_LANGUAGE } from '../src/lib/translations.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';

const artifact: ContentArtifact = validateArtifact(
  JSON.parse(readFileSync(new URL('./fixtures/valid-corpus.json', import.meta.url), 'utf8')),
  'tests/fixtures/valid-corpus.json',
);

/** One selection as every path expresses it: identities, induced edges, omitted. */
interface SelectionLike {
  nodes: readonly NoteSummary[];
  edges: readonly SelectionEdge[];
  omitted: number;
}

/**
 * Compare one selection against an expectation that is either hand-written
 * below or enumerated independently of the selection module (the build path,
 * the authoured edge set). Never against the module under test.
 */
function assertSameSelection(actual: SelectionLike, expected: SelectionLike, label: string): void {
  assert.deepEqual(actual.nodes, expected.nodes, `${label}: node identity or ranked order differs`);
  assert.deepEqual(actual.edges, expected.edges, `${label}: directed edge list differs`);
  assert.equal(actual.omitted, expected.omitted, `${label}: omitted count differs`);
}

/** Every directed edge a built graph draws, as the shared selection expresses it. */
function directedFromGraph(graph: Graph): SelectionEdge[] {
  const edges: SelectionEdge[] = [];
  for (const edge of graph.edges) {
    edges.push({ from: edge.from, to: edge.to });
    if (edge.isMutual) edges.push({ from: edge.to, to: edge.from });
  }
  return edges.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1));
}

/** A minimal valid entry. The relation lists are completed by `withBacklinks`. */
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

/**
 * Complete both halves of every edge, the way the exporter does.
 *
 * The entries' own relation lists are the fixture's authority; deriving the
 * inverse keeps a hand-authored corpus valid for `validateArtifact` and means
 * the expected sides below can be listed without touching the module.
 */
function withBacklinks(entries: readonly ContentEntry[]): ContentEntry[] {
  return entries.map((item) => ({
    ...item,
    backlinks: entries.filter((other) => other.outgoing.includes(item.slug)).map((other) => other.slug).sort(),
  }));
}

/** Every authored directed edge, in artifact order. */
function directedEdges(entries: readonly ContentEntry[]): SelectionEdge[] {
  return entries.flatMap((item) => item.outgoing.map((target) => ({ from: item.slug, to: target })));
}

/** The three fields relationship surfaces carry, with the stored language fallback. */
function identity(node: { slug: string; title: string; language?: string }): NoteSummary {
  return { slug: node.slug, title: node.title, language: node.language ?? NAV_LANGUAGE };
}

function lookupIn(entries: readonly ContentEntry[]): (slug: string) => ContentEntry | undefined {
  const bySlug = new Map(entries.map((item) => [item.slug, item]));
  return (slug) => bySlug.get(slug);
}

/** A real snapshot of a synthetic corpus, opened read-only through the adapter. */
function snapshotDatabase(entries: readonly ContentEntry[]): { db: SnapshotDb; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'anc-graph-synthetic-'));
  const path = join(directory, 'site.sqlite');
  writeSnapshot(validateArtifact({ version: 1, entries: [...entries] }, 'synthetic graph corpus'), path);
  const database = new DatabaseSync(path, { readOnly: true });
  return {
    db: { select: (sql, params) => database.prepare(sql).all(...((params ?? []) as never[])) as Record<string, unknown>[] },
    close: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------- the one parity comparison -- */

/**
 * The browser gate's corpus shape, compactly: a 15-neighbour hub, a reciprocal
 * pair, a 3-cycle, a neighbour-to-neighbour chord, two isolated notes, degree
 * ties broken by title before slug, and mixed `language` values.
 */
function browserShapedCorpus(): ContentEntry[] {
  const peers = Array.from({ length: 15 }, (_, index) => `peer-${String(index + 1).padStart(2, '0')}`);
  const titles: Record<string, string> = {
    'peer-01': 'Zulu Peer',
    'peer-03': 'Alpha Peer',
    'peer-10': 'Tie Beta',
    'peer-12': 'Tie Alpha',
  };
  const languages: Record<string, string> = { 'peer-05': 'zh-CN', 'peer-09': 'fr' };
  const peerEntry = (slug: string, outgoing: string[] = []): ContentEntry => {
    const language = languages[slug];
    return entry(slug, {
      title: titles[slug] ?? `Peer ${slug.slice(5)}`,
      ...(language === undefined ? {} : { language }),
      outgoing,
    });
  };
  return withBacklinks([
    entry('hub', { title: 'Hub', language: 'en', outgoing: [...peers] }),
    peerEntry('peer-01', ['peer-02']),
    peerEntry('peer-02', ['peer-01', 'peer-03']),
    peerEntry('peer-03', ['peer-01']),
    ...peers
      .filter((slug) => !['peer-01', 'peer-02', 'peer-03'].includes(slug))
      .map((slug) => peerEntry(slug, slug === 'peer-10' ? ['peer-12'] : [])),
    entry('zeta-island', { title: 'Alpha Island' }),
    entry('alpha-island', { title: 'Zeta Island' }),
  ]);
}

/**
 * The hand-listed identity order and directed edges for the corpus above.
 *
 * Degree-3 and degree-2 ties order by title where slug order would differ, the
 * two isolated notes close the global ranking, and the drawn `peer-02 ->
 * peer-03` chord plus the directed `peer-01 <-> peer-02` pair are the ones a
 * count-only comparison would let drift.
 */
const browserShapedGlobal: SelectionLike = {
  nodes: [
    { slug: 'hub', title: 'Hub', language: 'en' },
    { slug: 'peer-03', title: 'Alpha Peer', language: 'en' },
    { slug: 'peer-02', title: 'Peer 02', language: 'en' },
    { slug: 'peer-01', title: 'Zulu Peer', language: 'en' },
    { slug: 'peer-12', title: 'Tie Alpha', language: 'en' },
    { slug: 'peer-10', title: 'Tie Beta', language: 'en' },
    { slug: 'peer-04', title: 'Peer 04', language: 'en' },
    { slug: 'peer-05', title: 'Peer 05', language: 'zh-CN' },
    { slug: 'peer-06', title: 'Peer 06', language: 'en' },
    { slug: 'peer-07', title: 'Peer 07', language: 'en' },
    { slug: 'peer-08', title: 'Peer 08', language: 'en' },
    { slug: 'peer-09', title: 'Peer 09', language: 'fr' },
    { slug: 'peer-11', title: 'Peer 11', language: 'en' },
    { slug: 'peer-13', title: 'Peer 13', language: 'en' },
    { slug: 'peer-14', title: 'Peer 14', language: 'en' },
    { slug: 'peer-15', title: 'Peer 15', language: 'en' },
    { slug: 'zeta-island', title: 'Alpha Island', language: 'en' },
    { slug: 'alpha-island', title: 'Zeta Island', language: 'en' },
  ],
  edges: [
    ...Array.from({ length: 15 }, (_, index) => ({
      from: 'hub',
      to: `peer-${String(index + 1).padStart(2, '0')}`,
    })),
    { from: 'peer-01', to: 'peer-02' },
    { from: 'peer-02', to: 'peer-01' },
    { from: 'peer-02', to: 'peer-03' },
    { from: 'peer-03', to: 'peer-01' },
    { from: 'peer-10', to: 'peer-12' },
  ],
  omitted: 0,
};

/** The hub's hand-listed bounded neighbourhood over the same corpus. */
const browserShapedLocal: SelectionLike = {
  nodes: [
    { slug: 'peer-03', title: 'Alpha Peer', language: 'en' },
    { slug: 'peer-02', title: 'Peer 02', language: 'en' },
    { slug: 'peer-04', title: 'Peer 04', language: 'en' },
    { slug: 'peer-05', title: 'Peer 05', language: 'zh-CN' },
    { slug: 'peer-06', title: 'Peer 06', language: 'en' },
    { slug: 'peer-07', title: 'Peer 07', language: 'en' },
    { slug: 'peer-08', title: 'Peer 08', language: 'en' },
    { slug: 'peer-09', title: 'Peer 09', language: 'fr' },
    { slug: 'peer-11', title: 'Peer 11', language: 'en' },
    { slug: 'peer-13', title: 'Peer 13', language: 'en' },
    { slug: 'peer-14', title: 'Peer 14', language: 'en' },
    { slug: 'peer-15', title: 'Peer 15', language: 'en' },
  ],
  edges: [
    { from: 'hub', to: 'peer-02' },
    { from: 'hub', to: 'peer-03' },
    { from: 'hub', to: 'peer-04' },
    { from: 'hub', to: 'peer-05' },
    { from: 'hub', to: 'peer-06' },
    { from: 'hub', to: 'peer-07' },
    { from: 'hub', to: 'peer-08' },
    { from: 'hub', to: 'peer-09' },
    { from: 'hub', to: 'peer-11' },
    { from: 'hub', to: 'peer-13' },
    { from: 'hub', to: 'peer-14' },
    { from: 'hub', to: 'peer-15' },
    { from: 'peer-02', to: 'peer-03' },
  ],
  omitted: 3,
};

test('native and Worker selections agree in full identity, directed edges, and omitted counts', () => {
  // Every fixture note's local graph, full public identity included: a row that
  // carried another note's title or dropped the effective language would pass a
  // slug map but not this.
  const fixture = snapshotDatabase(artifact.entries);
  try {
    const lookup = new Map(artifact.entries.map((item) => [item.slug, item]));
    const bySlug = (slug: string) => lookup.get(slug);
    let compared = 0;
    for (const item of artifact.entries) {
      const built = localGraph(item, bySlug);
      const worker = workerLocal(fixture.db, item.slug);
      assert.ok(worker !== null, `Worker returned no local graph for ${item.slug}`);
      assert.deepEqual(worker.center, identity(item), `local center identity differs at ${item.slug}`);
      assert.deepEqual(
        worker.nodes,
        built.nodes.filter((node) => !node.isSubject).map((node) => identity(node.entry)),
        `local node identity differs at ${item.slug}`,
      );
      assert.deepEqual(worker.omitted, built.omitted, `local omitted differs at ${item.slug}`);
      // The whole directed edge list, in order, with direction intact.
      assert.deepEqual(worker.edges, directedFromGraph(built), `local induced edges differ at ${item.slug}`);
      compared += 1;
    }
    assert.ok(compared > 0, 'the corpus carried no notes to compare');

    // The site-wide graph.
    const builtGlobal = globalGraph(artifact.entries);
    assertSameSelection(
      workerGlobal(fixture.db),
      {
        nodes: builtGlobal.nodes.map((node) => identity(node.entry)),
        edges: directedFromGraph(builtGlobal),
        omitted: builtGlobal.omitted,
      },
      'the fixture global graph',
    );

    // Every tag's subgraph: the Worker walks SQL-aggregated degrees, the shared
    // selection walks the authored edges within the tag. Both must rank, slice,
    // and induce edges identically.
    const facets = tagFacets(artifact.entries);
    assert.ok(facets.length > 0, 'the fixture corpus carried no tagged notes to compare');
    for (const facet of facets) {
      const members = new Set(facet.entries.map((item) => item.slug));
      const edgesWithinTag: SelectionEdge[] = facet.entries.flatMap((item) =>
        item.outgoing.filter((target) => members.has(target)).map((target) => ({ from: item.slug, to: target })),
      );
      const shared = selectGlobal(facet.entries, edgesWithinTag);
      assertSameSelection(
        workerGlobal(fixture.db, facet.key),
        { nodes: shared.nodes.map(identity), edges: shared.edges, omitted: shared.omitted },
        `tag ${facet.key}`,
      );
    }
  } finally {
    fixture.close();
  }

  // The hand-listed case: degree ties broken by title, mixed effective
  // languages, isolated notes at the tail of the ranking, a neighbour chord,
  // and a bounded local neighbourhood. Every path is compared with the same
  // hand-written selection.
  const corpus = browserShapedCorpus();
  const edges = directedEdges(corpus);
  const sharedGlobal = selectGlobal(corpus, edges);
  assertSameSelection(
    { nodes: sharedGlobal.nodes.map(identity), edges: sharedGlobal.edges, omitted: sharedGlobal.omitted },
    browserShapedGlobal,
    'the shared browser-shaped global selection',
  );
  const builtGlobalGraph = globalGraph(corpus);
  assertSameSelection(
    {
      nodes: builtGlobalGraph.nodes.map((node) => identity(node.entry)),
      edges: directedFromGraph(builtGlobalGraph),
      omitted: builtGlobalGraph.omitted,
    },
    browserShapedGlobal,
    'the build browser-shaped global selection',
  );
  const builtLocalGraph = localGraph(corpus[0]!, lookupIn(corpus));
  assert.deepEqual(
    builtLocalGraph.nodes.map((node) => identity(node.entry)),
    [identity(corpus[0]!), ...browserShapedLocal.nodes],
    'the build browser-shaped local selection is not the hand-listed neighbourhood',
  );
  assert.deepEqual(
    directedFromGraph(builtLocalGraph),
    browserShapedLocal.edges,
    'the build browser-shaped local edge list is not the hand-listed list',
  );
  assert.equal(builtLocalGraph.omitted, browserShapedLocal.omitted);

  const synthetic = snapshotDatabase(corpus);
  try {
    assertSameSelection(workerGlobal(synthetic.db), browserShapedGlobal, 'the Worker browser-shaped global selection');
    const workerLocalGraph = workerLocal(synthetic.db, 'hub');
    assert.ok(workerLocalGraph !== null, 'the Worker lost the known center');
    assert.deepEqual(workerLocalGraph.center, { slug: 'hub', title: 'Hub', language: 'en' });
    assertSameSelection(workerLocalGraph, browserShapedLocal, 'the Worker browser-shaped local selection');
  } finally {
    synthetic.close();
  }
});

/* ------------------------------------------------------- tag filtering -- */

/**
 * Filtering is not a truncation: only tag members are ranked, an edge whose
 * other endpoint is outside the tag neither draws nor contributes degree, and a
 * member with no in-tag edge is still a ranked note.
 */
test('a tag filter ranks its members, excludes outside endpoints, and keeps isolated members', () => {
  const memberSlugs = ['m1', 'm2', 'm3', 'm4'];
  const corpus = withBacklinks([
    entry('m1', { title: 'Alpha', tags: ['team'], outgoing: ['m2', 'outsider'] }),
    entry('m2', { title: 'Beta', tags: ['team'], language: 'zh-CN', outgoing: ['m1'] }),
    entry('m3', { title: 'Gamma', tags: ['team'] }),
    entry('m4', { title: 'Delta', tags: ['team'], outgoing: ['outsider-two'] }),
    entry('outsider', { title: 'Zulu', outgoing: ['m1'] }),
    entry('outsider-two', { title: 'Yankee' }),
  ]);
  const members = corpus.filter((item) => memberSlugs.includes(item.slug));
  const edgesWithinTag: SelectionEdge[] = members.flatMap((item) =>
    item.outgoing.filter((target) => memberSlugs.includes(target)).map((target) => ({ from: item.slug, to: target })),
  );
  // Degrees inside the tag: m1 and m2 have one neighbour each, m3 and m4 none.
  const expected: SelectionLike = {
    nodes: [
      { slug: 'm1', title: 'Alpha', language: NAV_LANGUAGE },
      { slug: 'm2', title: 'Beta', language: 'zh-CN' },
      { slug: 'm4', title: 'Delta', language: NAV_LANGUAGE },
      { slug: 'm3', title: 'Gamma', language: NAV_LANGUAGE },
    ],
    edges: [
      { from: 'm1', to: 'm2' },
      { from: 'm2', to: 'm1' },
    ],
    omitted: 0,
  };

  const shared = selectGlobal(members, edgesWithinTag);
  assertSameSelection(
    { nodes: shared.nodes.map(identity), edges: shared.edges, omitted: shared.omitted },
    expected,
    'the shared tag selection',
  );

  const { db, close } = snapshotDatabase(corpus);
  try {
    const worker = workerGlobal(db, 'team');
    assertSameSelection(worker, expected, 'the Worker tag selection');
    assert.ok(
      worker.edges.every(
        (edge) => memberSlugs.includes(edge.from) && memberSlugs.includes(edge.to),
      ),
      'an induced edge has an endpoint outside the tag',
    );

    // The control: both untagged notes are real ranked nodes without the
    // filter, so the selection above is a filter and not an empty corpus.
    const unfiltered = workerGlobal(db);
    for (const outsider of ['outsider', 'outsider-two']) {
      assert.ok(
        unfiltered.nodes.some((node) => node.slug === outsider),
        `${outsider} is not a ranked note without the filter, so its exclusion proves nothing`,
      );
    }
  } finally {
    close();
  }
});

/**
 * The tag path applies the same bound, ranking before slicing.
 *
 * Every fixture tag is smaller than `GLOBAL_NODE_LIMIT`, so the corpus gate
 * above never exercises `omitted` or the slice. This synthetic tag is wider
 * than the bound and its two hubs sort after every filler in SQL/artifact
 * order, so a slice taken before the ranking drops both hubs.
 */
test('a tag larger than the global bound ranks before it slices inside the tag', () => {
  const fillers = Array.from({ length: GLOBAL_NODE_LIMIT + 3 }, (_, index) =>
    entry(`note-${String(index).padStart(2, '0')}`, {
      title: `Note ${String(index).padStart(2, '0')}`,
      tags: ['wide'],
    }),
  );
  const corpus = withBacklinks([
    ...fillers,
    entry('zeta-hub-a', { title: 'Zeta Hub A', tags: ['wide'], outgoing: ['note-00', 'note-04'] }),
    entry('zeta-hub-b', { title: 'Zeta Hub B', tags: ['wide'], outgoing: ['note-01', 'note-02', 'note-03'] }),
  ]);
  const expectedFirstTwo = ['zeta-hub-b', 'zeta-hub-a'];
  const edges = directedEdges(corpus);

  const shared = selectGlobal(corpus, edges);
  assert.deepEqual(
    shared.nodes.slice(0, 2).map((node) => node.slug),
    expectedFirstTwo,
    'the shared selection ranked a filler above a hub',
  );
  assert.equal(shared.nodes.length, GLOBAL_NODE_LIMIT, 'the shared selection drew a different bound');
  assert.equal(shared.omitted, 5, 'the shared selection omitted a different count');
  assert.equal(shared.nodes.at(-1)!.slug, 'note-57', 'the shared truncation point is not the ranked tail');

  const { db, close } = snapshotDatabase(corpus);
  try {
    const worker = workerGlobal(db, 'wide');
    assertSameSelection(
      worker,
      { nodes: shared.nodes.map(identity), edges: shared.edges, omitted: shared.omitted },
      'the wide tag',
    );
    assert.deepEqual(
      worker.nodes.slice(0, 2).map((node) => node.slug),
      expectedFirstTwo,
      'the Worker sliced the tag order before ranking',
    );
    assert.equal(worker.nodes.at(-1)!.slug, 'note-57', 'the Worker truncation point is not the ranked tail');
    assert.equal(
      worker.nodes.length + worker.omitted,
      GLOBAL_NODE_LIMIT + 5,
      'drawn + omitted is not the tag member count',
    );
  } finally {
    close();
  }
});

/* ------------------------------------------- the goal's named defects -- */

/**
 * A limit applied before ranking, caught on all three paths.
 *
 * 61 fillers come first in canonical slug order and two hubs sort after every
 * one of them, so `candidates.slice(0, 60)` — what a pre-ranking limit does to
 * the SQL/artifact order — keeps `note-00` and `note-01` and drops both hubs.
 * The hubs carry the corpus' only edges, so ranking puts them first; the drawn
 * count and the truncation point are both exact, so a slice that happened to
 * keep one hub but not the other also fails.
 */
test('the global bound ranks before it slices, keeping the two late-slug hubs', () => {
  const fillers = Array.from({ length: GLOBAL_NODE_LIMIT + 1 }, (_, index) =>
    entry(`note-${String(index).padStart(2, '0')}`, { title: `Note ${String(index).padStart(2, '0')}` }),
  );
  const corpus = withBacklinks([
    ...fillers,
    entry('zeta-hub-a', { title: 'Zeta Hub A', outgoing: ['note-00', 'note-01'] }),
    entry('zeta-hub-b', { title: 'Zeta Hub B', outgoing: ['note-02', 'note-03', 'note-04'] }),
  ]);
  const expectedFirstTwo = ['zeta-hub-b', 'zeta-hub-a'];
  const edges = directedEdges(corpus);

  const shared = selectGlobal(corpus, edges);
  assert.deepEqual(shared.nodes.slice(0, 2).map((node) => node.slug), expectedFirstTwo, 'the shared selection ranked an edge-less filler above a hub');
  assert.equal(shared.nodes.length, GLOBAL_NODE_LIMIT, 'the shared selection drew a different bound');
  assert.equal(shared.omitted, 3, 'the shared selection omitted a different count');
  assert.equal(shared.nodes.at(-1)!.slug, 'note-57', 'the shared truncation point is not the ranked tail');

  const built = globalGraph(corpus);
  assert.deepEqual(built.nodes.slice(0, 2).map((node) => node.entry.slug), expectedFirstTwo, 'the build drew the artifact order rather than the ranking');
  assert.equal(built.nodes.length, GLOBAL_NODE_LIMIT);
  assert.equal(built.omitted, 3);
  assert.equal(built.nodes.at(-1)!.entry.slug, 'note-57');

  const { db, close } = snapshotDatabase(corpus);
  try {
    const worker = workerGlobal(db);
    assert.deepEqual(worker.nodes.slice(0, 2).map((node) => node.slug), expectedFirstTwo, 'the Worker drew the SQL order rather than the ranking');
    assert.equal(worker.nodes.length, GLOBAL_NODE_LIMIT);
    assert.equal(worker.omitted, 3);
    assert.equal(worker.nodes.at(-1)!.slug, 'note-57');
  } finally {
    close();
  }
});

/**
 * A reciprocal pair is one ranked neighbour, not two edge occurrences.
 *
 * All four joined notes have exactly one distinct neighbour, so the contract
 * ranks them by title: c, b, d, a — the reverse of their slug order. Counting
 * each edge occurrence instead gives the reciprocal pair degree 2 and moves
 * them to the front, which changes the order, the drawn set at limit 3, and
 * both degree paths. The two directed edges themselves must survive in the
 * induced list — only the *ranking* collapses them. `e` and `f` share a title
 * and a degree, so the tail pins the slug tiebreak, and `b`'s `zh-CN` beside
 * `f`'s undeclared language pins the effective-language fallback.
 */
test('a reciprocal pair ranks as one neighbour, not two edge occurrences', () => {
  const corpus = withBacklinks([
    entry('a', { title: 'Zeta', tags: ['t'], outgoing: ['b'] }),
    entry('b', { title: 'Beta', tags: ['t'], language: 'zh-CN', outgoing: ['a'] }),
    entry('c', { title: 'Alpha', tags: ['t'], outgoing: ['d'] }),
    entry('d', { title: 'Delta', tags: ['t'] }),
    // Authored before `e`, opposite to slug order: a comparator that left the
    // title tie open would keep this order and fail the hand list below.
    entry('f', { title: 'Same' }),
    entry('e', { title: 'Same', tags: ['t'] }),
  ]);
  const expected: SelectionLike = {
    nodes: [
      { slug: 'c', title: 'Alpha', language: NAV_LANGUAGE },
      { slug: 'b', title: 'Beta', language: 'zh-CN' },
      { slug: 'd', title: 'Delta', language: NAV_LANGUAGE },
      { slug: 'a', title: 'Zeta', language: NAV_LANGUAGE },
      { slug: 'e', title: 'Same', language: NAV_LANGUAGE },
      { slug: 'f', title: 'Same', language: NAV_LANGUAGE },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'c', to: 'd' },
    ],
    omitted: 0,
  };
  const edges = directedEdges(corpus);

  const shared = selectGlobal(corpus, edges);
  assertSameSelection(
    { nodes: shared.nodes.map(identity), edges: shared.edges, omitted: shared.omitted },
    expected,
    'the shared selection',
  );

  const bounded = selectGlobal(corpus, edges, 3);
  assert.deepEqual(bounded.nodes.map((node) => node.slug), ['c', 'b', 'd'], 'a double-counted reciprocal pair displaced a one-way neighbour');
  assert.equal(bounded.omitted, 3);

  const built = globalGraph(corpus);
  assertSameSelection(
    { nodes: built.nodes.map((node) => identity(node.entry)), edges: directedFromGraph(built), omitted: built.omitted },
    expected,
    'the build selection',
  );

  const { db, close } = snapshotDatabase(corpus);
  try {
    assertSameSelection(workerGlobal(db), expected, 'the unfiltered Worker selection');
    // The same rule through the tag's own degree statement: `f` is outside the
    // filter, and the reciprocal pair is still one neighbour each.
    assertSameSelection(
      workerGlobal(db, 't'),
      { nodes: expected.nodes.filter((node) => node.slug !== 'f'), edges: expected.edges, omitted: 0 },
      "the Worker's tag-filtered selection",
    );
  } finally {
    close();
  }
});

/**
 * The local bound sorts before it slices, on both paths.
 *
 * 15 neighbours with titles running opposite to their slugs: the SQL/input
 * order is peer-00..peer-14 and the title order is peer-14..peer-03. A slice
 * taken before the sort keeps peer-00..peer-11 and drops every hand-listed
 * drawn note, so the exact list below is the discriminator. Omitted is stated
 * too, because the candidate list still has 15 members either way.
 */
test('the local bound sorts by title before it slices, on both the build and Worker paths', () => {
  const peers = Array.from({ length: 15 }, (_, index) => `peer-${String(index).padStart(2, '0')}`);
  const corpus = withBacklinks([
    entry('hub', { title: 'Hub', outgoing: peers }),
    ...peers.map((slug, index) => entry(slug, { title: `Peer ${String(15 - index).padStart(2, '0')}` })),
  ]);
  const expectedDrawn = ['peer-14', 'peer-13', 'peer-12', 'peer-11', 'peer-10', 'peer-09', 'peer-08', 'peer-07', 'peer-06', 'peer-05', 'peer-04', 'peer-03'];
  const expectedTitles = ['Peer 01', 'Peer 02', 'Peer 03', 'Peer 04', 'Peer 05', 'Peer 06', 'Peer 07', 'Peer 08', 'Peer 09', 'Peer 10', 'Peer 11', 'Peer 12'];

  const built = localGraph(corpus[0]!, lookupIn(corpus));
  assert.deepEqual(built.nodes.map((node) => node.entry.slug), ['hub', ...expectedDrawn], 'the build sliced before sorting');
  assert.equal(built.omitted, 3, 'the build omitted a different count');
  assert.ok(!built.nodes.some((node) => node.entry.slug === 'peer-00'), 'the build kept the first SQL-order note');

  const { db, close } = snapshotDatabase(corpus);
  try {
    const worker = workerLocal(db, 'hub');
    assert.ok(worker !== null, 'the Worker lost the known center');
    assert.deepEqual(worker.nodes.map((node) => node.slug), expectedDrawn, 'the Worker sliced the SQL order before sorting');
    assert.deepEqual(worker.nodes.map((node) => node.title), expectedTitles, 'the Worker drew the wrong titles for the drawn slugs');
    assert.deepEqual(worker.nodes.map((node) => node.language), expectedDrawn.map(() => NAV_LANGUAGE));
    assert.equal(worker.omitted, 3, 'the Worker omitted a different count');
    assert.ok(!worker.nodes.some((node) => node.slug === 'peer-00'), 'the Worker kept the first SQL-order note');
  } finally {
    close();
  }
});

/**
 * Every induced directed edge, including the chords between neighbours.
 *
 * `alpha -> delta -> beta -> alpha` is a 3-cycle among neighbours, `alpha` and
 * `beta` are a reciprocal pair, and `delta -> echo` is a chord that touches no
 * center. `echo -> outside` leaves the drawn set and must be absent. The list
 * is exact and directed: a star-only selection loses every edge that does not
 * touch the subject, and reversing any one edge (for example emitting
 * `subject -> beta`) changes it.
 */
test('the local graph draws every induced directed edge, including between-neighbour chords', () => {
  const corpus = withBacklinks([
    entry('subject', { title: 'Subject', outgoing: ['alpha', 'echo'] }),
    entry('alpha', { title: 'Alpha', outgoing: ['beta', 'delta'] }),
    entry('beta', { title: 'Beta', outgoing: ['alpha', 'subject'] }),
    entry('delta', { title: 'Delta', outgoing: ['beta', 'echo', 'subject'] }),
    entry('echo', { title: 'Echo', outgoing: ['outside'] }),
    entry('outside', { title: 'Outside' }),
  ]);
  const expectedEdges: SelectionEdge[] = [
    { from: 'alpha', to: 'beta' },
    { from: 'alpha', to: 'delta' },
    { from: 'beta', to: 'alpha' },
    { from: 'beta', to: 'subject' },
    { from: 'delta', to: 'beta' },
    { from: 'delta', to: 'echo' },
    { from: 'delta', to: 'subject' },
    { from: 'subject', to: 'alpha' },
    { from: 'subject', to: 'echo' },
  ];
  const subject = corpus[0]!;
  const lookup = lookupIn(corpus);

  const shared = selectLocal(subject, corpus.slice(1, 5), directedEdges(corpus));
  assert.deepEqual(shared.candidates.map((node) => node.slug), ['alpha', 'beta', 'delta', 'echo']);
  assert.deepEqual(shared.drawn.map((node) => node.slug), ['alpha', 'beta', 'delta', 'echo']);
  assert.deepEqual(shared.edges, expectedEdges, 'the shared selection dropped or reversed an induced chord');
  assert.equal(shared.omitted, 0);

  const built = localGraph(subject, lookup);
  assert.deepEqual(built.nodes.map((node) => node.entry.slug), ['subject', 'alpha', 'beta', 'delta', 'echo'], 'the build drew a star instead of the neighbourhood');
  assert.deepEqual(directedFromGraph(built), expectedEdges, 'the built graph dropped, reversed, or invented an induced edge');
  assert.equal(built.omitted, 0);

  const { db, close } = snapshotDatabase(corpus);
  try {
    const worker = workerLocal(db, 'subject');
    assert.ok(worker !== null, 'the Worker lost the known center');
    assert.deepEqual(worker.nodes.map((node) => node.slug), ['alpha', 'beta', 'delta', 'echo']);
    assert.deepEqual(worker.edges, expectedEdges, 'the Worker dropped, reversed, or invented an induced edge');
    assert.deepEqual(worker.center, { slug: 'subject', title: 'Subject', language: NAV_LANGUAGE });
    assert.equal(worker.omitted, 0);
  } finally {
    close();
  }
});
