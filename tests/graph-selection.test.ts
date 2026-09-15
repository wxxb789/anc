/**
 * Build-time and Worker graph selection must agree.
 *
 * The build draws the static SVG/table; the Worker answers exploration. If the
 * two selections differ, a reader who enhances the page sees a different graph
 * than the one that shipped. This gate runs both over the same finalized
 * snapshot and compares the selected node order, induced directed edges, and
 * omitted counts.
 *
 * The oracle cases below are hand-listed, not recomputed from the module, so a
 * ranking or reciprocity defect is visible rather than restated.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { validateArtifact, type ContentArtifact, type ContentEntry } from '../src/lib/schema.ts';
import {
  byTitleThenSlug,
  selectGlobal,
  selectLocal,
  type SelectionEdge,
  type SelectionNode,
} from '../src/lib/graph-selection.ts';
import { globalGraph, localGraph, type Graph } from '../src/lib/graph.ts';
import { globalGraph as workerGlobal, localGraph as workerLocal, type SnapshotDb } from '../src/lib/snapshot-operations.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';

const artifact: ContentArtifact = validateArtifact(
  JSON.parse(readFileSync(new URL('./fixtures/valid-corpus.json', import.meta.url), 'utf8')),
  'tests/fixtures/valid-corpus.json',
);

function directedFromGraph(graph: Graph): SelectionEdge[] {
  const edges: SelectionEdge[] = [];
  for (const edge of graph.edges) {
    edges.push({ from: edge.from, to: edge.to });
    if (edge.isMutual) edges.push({ from: edge.to, to: edge.from });
  }
  return edges.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1));
}

function workerDatabase(): { db: SnapshotDb; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'anc-graph-'));
  const path = join(directory, 'site.sqlite');
  writeSnapshot(artifact, path);
  const database = new DatabaseSync(path, { readOnly: true });
  return {
    db: { select: (sql, params) => database.prepare(sql).all(...((params ?? []) as never[])) as Record<string, unknown>[] },
    close: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('local selection agrees between the build and the Worker', () => {
  const { db, close } = workerDatabase();
  try {
    const lookup = new Map(artifact.entries.map((entry) => [entry.slug, entry]));
    const bySlug = (slug: string) => lookup.get(slug);
    let compared = 0;
    for (const entry of artifact.entries) {
      const built = localGraph(entry, bySlug);
      const worker = workerLocal(db, entry.slug);
      assert.ok(worker !== null, `Worker returned no local graph for ${entry.slug}`);
      const builtNodes = built.nodes.filter((node) => !node.isSubject).map((node) => node.entry.slug);
      assert.deepEqual(worker.nodes.map((node) => node.slug), builtNodes, `local node order differs at ${entry.slug}`);
      assert.deepEqual(worker.omitted, built.omitted, `local omitted differs at ${entry.slug}`);
      assert.deepEqual(worker.edges, directedFromGraph(built), `local induced edges differ at ${entry.slug}`);
      assert.deepEqual(worker.center.slug, entry.slug);
      compared += 1;
    }
    assert.ok(compared > 0, 'the corpus carried no notes to compare');
  } finally {
    close();
  }
});

test('global selection agrees between the build and the Worker', () => {
  const { db, close } = workerDatabase();
  try {
    const built = globalGraph(artifact.entries);
    const worker = workerGlobal(db);
    assert.deepEqual(worker.nodes.map((node) => node.slug), built.nodes.map((node) => node.entry.slug));
    assert.deepEqual(worker.omitted, built.omitted);
    assert.deepEqual(worker.edges, directedFromGraph(built));
  } finally {
    close();
  }
});

/* ------------------------------------------------------------------ oracles -- */

const node = (slug: string, title = slug): SelectionNode => ({ slug, title });

test('a reciprocal pair ranks as one neighbour and draws once', () => {
  const nodes = [node('a'), node('b'), node('c', 'Aaa')];
  const edges: SelectionEdge[] = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'a' },
  ];
  const selection = selectGlobal(nodes, edges);
  // a and b each have one distinct neighbour; c has none, so c is last.
  assert.deepEqual(selection.nodes.map((n) => n.slug), ['a', 'b', 'c']);
  const aNeighbours = edges.filter((edge) => edge.from === 'a' || edge.to === 'a');
  assert.equal(new Set(aNeighbours.flatMap((edge) => [edge.from, edge.to])).size, 2);
});

test('ranking happens before truncation, not on an arbitrary slice', () => {
  // hub is linked to five leaves; its slug sorts last, so a limit applied before
  // ranking would drop it and keep only alphabetically early leaves.
  const nodes = [node('hub', 'Zeta hub'), node('a', 'a'), node('b', 'b'), node('c', 'c'), node('d', 'd'), node('e', 'e')];
  const edges: SelectionEdge[] = ['a', 'b', 'c', 'd', 'e'].map((leaf) => ({ from: 'hub', to: leaf }));
  const selection = selectGlobal(nodes, edges, 2);
  assert.deepEqual(selection.nodes.map((n) => n.slug), ['hub', 'a']);
  assert.equal(selection.omitted, nodes.length - 2);
});

test('local selection retains every edge among drawn nodes, not only a star', () => {
  const center = node('center');
  const neighbours = [node('a'), node('b'), node('c')];
  const edges: SelectionEdge[] = [
    { from: 'center', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ];
  const selection = selectLocal(center, neighbours, edges);
  assert.deepEqual(selection.edges, [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'center', to: 'a' },
  ]);
  assert.equal(selection.omitted, 0);
});

test('the local bound counts neighbours, never the center', () => {
  const center = node('center');
  const neighbours = Array.from({ length: 15 }, (_, index) => node(`n-${String(index).padStart(2, '0')}`));
  const selection = selectLocal(center, neighbours, []);
  assert.equal(selection.drawn.length, 12);
  assert.equal(selection.omitted, 3);
  assert.ok(!selection.drawn.some((n) => n.slug === center.slug));
});

test('the comparator is a total order with the slug as the tiebreak', () => {
  const ordered = [node('b', 'Same'), node('a', 'Same'), node('c', 'Different')].sort(byTitleThenSlug);
  assert.deepEqual(ordered.map((n) => n.slug), ['c', 'a', 'b']);
});

test('tag-filtered ranking counts a reciprocal pair once in both paths', () => {
  const entry = (slug: string, title: string, outgoing: string[]): ContentEntry => ({
    slug,
    title,
    excerpt: '',
    markdown: `# ${title}`,
    tags: ['t'],
    outgoing: [...outgoing].sort(),
    backlinks: [],
  });
  const entries: ContentEntry[] = [
    entry('x', 'X', ['z']),
    entry('y', 'Y', ['v', 'w']),
    entry('z', 'Z', ['x']),
    entry('v', 'V', []),
    entry('w', 'W', []),
  ];
  for (const candidate of entries) {
    candidate.backlinks = entries.filter((other) => other.outgoing.includes(candidate.slug)).map((other) => other.slug).sort();
  }
  const directory = mkdtempSync(join(tmpdir(), 'anc-graph-tag-'));
  const path = join(directory, 'site.sqlite');
  try {
    writeSnapshot({ version: 1, entries }, path);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const db: SnapshotDb = {
        select: (sql, params) => database.prepare(sql).all(...((params ?? []) as never[])) as Record<string, unknown>[],
      };
      const worker = workerGlobal(db, 't');
      const shared = selectGlobal(
        entries,
        entries.flatMap((candidate) => candidate.outgoing.map((target: string) => ({ from: candidate.slug, to: target }))),
      );
      assert.deepEqual(worker.nodes.map((node) => node.slug), shared.nodes.map((node) => node.slug));
      assert.deepEqual(worker.omitted, shared.omitted);
      // y has two distinct neighbours and must rank first; x and z are one
      // neighbour each despite a reciprocal pair between them.
      assert.deepEqual(worker.nodes.map((node) => node.slug), ['y', 'v', 'w', 'x', 'z']);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
