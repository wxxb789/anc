/**
 * The global graph's bounded prefilter against the unbounded algorithm.
 *
 * `globalGraph` used to materialise every node row and every degree, rank them
 * in JS, and keep 60. It now asks SQLite for the integer degree of candidates
 * at or above the 60th-degree cutoff and hands those rows to the same
 * `rankGlobal` authority. That is only safe if the drawn set is unchanged for
 * every caller: the same 60 slugs in the same order, the same induced directed
 * edges and the same `omitted` count.
 *
 * The oracle below is the pre-change algorithm shape, not a copy of the new
 * one: select every candidate row, build the degree lookup from the corpus-wide
 * aggregate, then rank. It deliberately includes the hostile parts of the
 * ordering: a degree-tie group that straddles the cut, identical titles with
 * different slugs, and titles whose astral characters sort differently under
 * SQLite's UTF-8 BINARY collation than under JavaScript's UTF-16 comparison.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { validateArtifact, type ContentArtifact, type ContentEntry } from '../src/lib/schema.ts';
import { GLOBAL_NODE_LIMIT, inducedEdges, rankGlobal, type SelectionEdge } from '../src/lib/graph-selection.ts';
import { SNAPSHOT_QUERIES, type NoteSummary } from '../src/lib/snapshot-queries.ts';
import { globalGraph, type SnapshotDb } from '../src/lib/snapshot-operations.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';

/** A minimal valid entry; relation lists are completed by `withBacklinks`. */
function entry(slug: string, title: string, overrides: Partial<ContentEntry> = {}): ContentEntry {
  return {
    slug,
    title,
    excerpt: '',
    markdown: `# ${slug}\n`,
    outgoing: [],
    backlinks: [],
    ...overrides,
  };
}

function withBacklinks(entries: readonly ContentEntry[]): ContentEntry[] {
  return entries.map((item) => ({
    ...item,
    backlinks: entries.filter((other) => other.outgoing.includes(item.slug)).map((other) => other.slug).sort(),
  }));
}

/**
 * A corpus shaped to exercise every branch of the bound.
 *
 * - 20 hubs at out-degree 10, 100 mid notes in a 3-out ring, 200 leaves at
 *   degree 1, and 20 isolated notes.
 * - The mid band supplies more than 60 nodes at the same degree, so the cut is
 *   decided by title/slug, not by degree alone.
 * - `\u{20000}` (astral) sorts before `\uE000` (PUA) in UTF-16 but after it in
 *   UTF-8 byte order; both appear in the tie band.
 * - `all`/`笔记` cover every connected note, `mids` is a >60 tag in the tie band,
 *   `few` is a <60 tag (the small-candidate fallback), and `thin` is a >60 tag
 *   whose connected members number fewer than 60 (the isolated-node fallback).
 */
function boundedCorpus(): ContentEntry[] {
  const entries: ContentEntry[] = [];
  const leaves = Array.from({ length: 200 }, (_, index) => `leaf-${String(index).padStart(3, '0')}`);
  for (let hub = 0; hub < 20; hub += 1) {
    const start = hub * 10;
    entries.push(
      entry(`hub-${String(hub).padStart(2, '0')}`, `Hub ${hub}`, {
        outgoing: leaves.slice(start, start + 10),
        tags: ['all', '笔记'],
      }),
    );
  }
  for (const leaf of leaves) {
    entries.push(entry(leaf, `Leaf ${leaf.slice(5)}`, { tags: ['all', '笔记'] }));
  }
  for (let index = 0; index < 100; index += 1) {
    const next = (offset: number): string => `mid-${String((index + offset) % 100).padStart(3, '0')}`;
    // Astral first, PUA second, every seventh title duplicated across slugs.
    const prefix = index % 7 === 0 ? 'Tied title' : index % 2 === 0 ? '\u{20000} mid' : '\uE000 mid';
    entries.push(
      entry(`mid-${String(index).padStart(3, '0')}`, `${prefix} ${String(index).padStart(3, '0')}`, {
        outgoing: [next(1), next(2), next(3)].sort(),
        tags: ['all', '笔记', 'mids'],
      }),
    );
  }
  for (let index = 0; index < 20; index += 1) {
    entries.push(
      entry(`island-${String(index).padStart(2, '0')}`, `Island ${index}`, {
        tags: index < 5 ? ['all', '笔记', 'few'] : ['all', 'thin'],
      }),
    );
  }
  // `thin` also carries 50 connected leaves, so it has more than 60 members but
  // fewer than 60 degree rows.
  for (const leaf of leaves.slice(0, 50)) {
    const found = entries.find((item) => item.slug === leaf)!;
    found.tags = [...(found.tags ?? []), 'thin'];
  }
  return withBacklinks(entries);
}

function snapshotDatabase(entries: readonly ContentEntry[]): { db: SnapshotDb; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'anc-global-bounded-'));
  const path = join(directory, 'site.sqlite');
  const artifact: ContentArtifact = validateArtifact({ version: 1, entries: [...entries] }, 'bounded global corpus');
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

interface SelectionLike {
  nodes: NoteSummary[];
  edges: SelectionEdge[];
  omitted: number;
}

/** The pre-change algorithm: every candidate row, then rank and slice. */
function unboundedSelection(db: SnapshotDb, tagKey?: string | null): SelectionLike {
  const filtered = tagKey !== undefined && tagKey !== null;
  const params = filtered ? [tagKey] : [];
  const nodes = db
    .select(filtered ? SNAPSHOT_QUERIES.tagNodes : SNAPSHOT_QUERIES.allNodes, params)
    .map((row) => ({
      id: Number(row['id']),
      slug: String(row['slug']),
      title: String(row['title']),
      language: String(row['language']),
    }));
  const degrees = new Map(
    db
      .select(filtered ? SNAPSHOT_QUERIES.tagNodeDegrees : SNAPSHOT_QUERIES.nodeDegrees, params)
      .map((row) => [Number(row['id']), Number(row['degree'])]),
  );
  const ranked = rankGlobal(nodes, (node) => degrees.get(node.id) ?? 0);
  const selected = ranked.slice(0, GLOBAL_NODE_LIMIT);
  const slugs = new Set(selected.map((node) => node.slug));
  const slugById = new Map(
    db
      .select(SNAPSHOT_QUERIES.allNodes)
      .map((row) => [Number(row['id']), String(row['slug'])]),
  );
  const edges = inducedEdges(
    slugs,
    db.select(SNAPSHOT_QUERIES.allEdges).map((row) => ({
      from: slugById.get(Number(row['source_id']))!,
      to: slugById.get(Number(row['target_id']))!,
    })),
  );
  return {
    nodes: selected.map(({ slug, title, language }) => ({ slug, title, language })),
    edges,
    omitted: ranked.length - selected.length,
  };
}

const corpus = boundedCorpus();

test('the prefilter and the full scan draw the same global set for every tag and corpus size', () => {
  const { db, close } = snapshotDatabase(corpus);
  try {
    const tags = db
      .select('SELECT key FROM tags ORDER BY key')
      .map((row) => String(row['key']));
    const variants: (string | null | undefined)[] = [undefined, null, ...tags, 'no-such-tag'];
    for (const tag of variants) {
      const expected = unboundedSelection(db, tag);
      const actual = globalGraph(db, tag);
      assert.deepEqual(actual, expected, `global selection differs for ${tag ?? 'unfiltered'}`);
    }
  } finally {
    close();
  }
});

test('the corpus exercises the unbounded prefilter and its two fallbacks', () => {
  const { db, close } = snapshotDatabase(corpus);
  try {
    const count = (sql: string, params: readonly unknown[] = []): number =>
      Number(db.select(sql, params)[0]?.['count'] ?? 0);
    const total = count(SNAPSHOT_QUERIES.nodeCount);
    assert.ok(total > GLOBAL_NODE_LIMIT, 'the corpus is too small to exercise the bound');
    // The primary path must actually run: at least 60 degree rows survive the
    // cutoff, otherwise the caller fell back and this test measured nothing.
    assert.ok(
      db.select(SNAPSHOT_QUERIES.globalRankedNodes, [GLOBAL_NODE_LIMIT]).length >= GLOBAL_NODE_LIMIT,
      'the unfiltered cutoff returned fewer than 60 rows',
    );
    assert.ok(
      count(SNAPSHOT_QUERIES.tagMemberCount, ['mids']) > GLOBAL_NODE_LIMIT,
      'the mids tag is too small to exercise the filtered bound',
    );
    assert.ok(
      db.select(SNAPSHOT_QUERIES.globalRankedTagNodes, ['mids', GLOBAL_NODE_LIMIT]).length >= GLOBAL_NODE_LIMIT,
      'the filtered cutoff returned fewer than 60 rows',
    );
    // Both fallbacks are represented: a tag smaller than the limit and a tag
    // whose connected members are fewer than the limit although its membership
    // is larger (the isolated notes fill the remainder by title).
    assert.ok(count(SNAPSHOT_QUERIES.tagMemberCount, ['few']) <= GLOBAL_NODE_LIMIT);
    assert.ok(count(SNAPSHOT_QUERIES.tagMemberCount, ['thin']) > GLOBAL_NODE_LIMIT);
    assert.ok(
      db.select(SNAPSHOT_QUERIES.globalRankedTagNodes, ['thin', GLOBAL_NODE_LIMIT]).length < GLOBAL_NODE_LIMIT,
      'the thin tag unexpectedly filled the cutoff',
    );
  } finally {
    close();
  }
});
