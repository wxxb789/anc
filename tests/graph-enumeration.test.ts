/**
 * Graph enumeration over a real written snapshot.
 *
 * This is the native half of goal 0005's "reach complete incoming/outgoing
 * lists beyond the drawn limit" and "unknown center ... do not masquerade as
 * runtime failure" evaluations. `writeSnapshot` writes a real SQLite file and
 * `edgePage`/`localGraph`/`globalGraph` read it through a `node:sqlite`
 * adapter, so the assertions are over the shipped row shape.
 *
 * The corpus is authored here, and every expected membership, page size,
 * cursor value, local node order, induced directed edge, and omitted count is
 * hand-written rather than read from the query result. The wrong-walker control
 * is deliberately run against the same oracle the correct walk passes, so an
 * oracle that merely restated the walk's own output would fail to reject it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';

import { validateArtifact, type ContentArtifact, type ContentEntry } from '../src/lib/schema.ts';
import { localGraph as buildLocal } from '../src/lib/graph.ts';
import {
  edgePage,
  globalGraph,
  localGraph,
  type SnapshotDb,
} from '../src/lib/snapshot-operations.ts';
import type { NoteSummary } from '../src/lib/snapshot-queries.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { NAV_LANGUAGE } from '../src/lib/translations.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';

/** Small enough that the hub's 15 members need four pages of 4/4/4/3. */
const PAGE_SIZE = 4;

/** The hub's outgoing targets, in canonical slug order, hand-written. */
const EXPECTED_OUTGOING = [
  'out-01',
  'out-02',
  'out-03',
  'out-04',
  'out-05',
  'out-06',
  'out-07',
  'out-08',
  'out-09',
  'out-10',
  'out-11',
  'out-12',
  'out-13',
  'out-14',
  'out-15',
];

/** The hub's backlink sources, in canonical slug order, hand-written. */
const EXPECTED_BACKLINKS = [
  'in-01',
  'in-02',
  'in-03',
  'in-04',
  'in-05',
  'in-06',
  'in-07',
  'in-08',
  'in-09',
  'in-10',
  'in-11',
  'in-12',
  'in-13',
  'in-14',
  'in-15',
];

/** The drawn neighbourhood of the hub: the first 12 titles, not slugs. */
const EXPECTED_LOCAL_NODES: NoteSummary[] = [
  { slug: 'in-01', title: 'In 01', language: NAV_LANGUAGE },
  { slug: 'in-02', title: 'In 02', language: NAV_LANGUAGE },
  { slug: 'in-03', title: 'In 03', language: NAV_LANGUAGE },
  { slug: 'in-04', title: 'In 04', language: NAV_LANGUAGE },
  { slug: 'in-05', title: 'In 05', language: NAV_LANGUAGE },
  { slug: 'in-06', title: 'In 06', language: NAV_LANGUAGE },
  { slug: 'in-07', title: 'In 07', language: NAV_LANGUAGE },
  { slug: 'in-08', title: 'In 08', language: NAV_LANGUAGE },
  { slug: 'in-09', title: 'In 09', language: NAV_LANGUAGE },
  { slug: 'in-10', title: 'In 10', language: NAV_LANGUAGE },
  { slug: 'in-11', title: 'In 11', language: NAV_LANGUAGE },
  { slug: 'in-12', title: 'In 12', language: NAV_LANGUAGE },
];

/**
 * The induced edges over `[hub, in-01..in-12]`, hand-written and directed.
 *
 * `in-01 <-> in-02` is a reciprocal pair, `in-01 -> in-02 -> in-03 -> in-01` is
 * a 3-cycle, and `in-10 -> in-12` is a chord touching no center. `in-13`,
 * `in-14`, `in-15`, and every `out-NN` are omitted, so their hub edges must not
 * appear either.
 */
const EXPECTED_LOCAL_EDGES = [
  { from: 'in-01', to: 'hub' },
  { from: 'in-01', to: 'in-02' },
  { from: 'in-02', to: 'hub' },
  { from: 'in-02', to: 'in-01' },
  { from: 'in-02', to: 'in-03' },
  { from: 'in-03', to: 'hub' },
  { from: 'in-03', to: 'in-01' },
  { from: 'in-04', to: 'hub' },
  { from: 'in-05', to: 'hub' },
  { from: 'in-06', to: 'hub' },
  { from: 'in-07', to: 'hub' },
  { from: 'in-08', to: 'hub' },
  { from: 'in-09', to: 'hub' },
  { from: 'in-10', to: 'hub' },
  { from: 'in-10', to: 'in-12' },
  { from: 'in-11', to: 'hub' },
  { from: 'in-12', to: 'hub' },
];

/** A minimal valid entry. The relation lists are completed by `withBacklinks`. */
function entry(slug: string, overrides: Partial<ContentEntry> = {}): ContentEntry {
  return {
    slug,
    title: `Title ${slug}`,
    excerpt: '',
    markdown: `# ${slug}\n`,
    outgoing: [],
    backlinks: [],
    ...overrides,
  };
}

/** Complete both halves of every edge, the way the exporter does. */
function withBacklinks(entries: readonly ContentEntry[]): ContentEntry[] {
  return entries.map((item) => ({
    ...item,
    backlinks: entries.filter((other) => other.outgoing.includes(item.slug)).map((other) => other.slug).sort(),
  }));
}

/**
 * The authored corpus: a hub with 15 outgoing targets and 15 backlink sources,
 * plus chords among the backlink side so the drawn neighbourhood is not a star.
 */
const entries: ContentEntry[] = withBacklinks([
  entry('hub', {
    title: 'Hub',
    outgoing: Array.from({ length: 15 }, (_, index) => `out-${String(index + 1).padStart(2, '0')}`),
  }),
  ...Array.from({ length: 15 }, (_, index) => {
    const label = String(index + 1).padStart(2, '0');
    return entry(`out-${label}`, { title: `Out ${label}` });
  }),
  entry('in-01', { title: 'In 01', outgoing: ['hub', 'in-02'] }),
  entry('in-02', { title: 'In 02', outgoing: ['hub', 'in-01', 'in-03'] }),
  entry('in-03', { title: 'In 03', outgoing: ['hub', 'in-01'] }),
  ...Array.from({ length: 12 }, (_, index) => {
    const label = String(index + 4).padStart(2, '0');
    return entry(`in-${label}`, {
      title: `In ${label}`,
      outgoing: label === '10' ? ['hub', 'in-12'] : ['hub'],
    });
  }),
  // A known note with no relations at all: a no-match shape that must not read
  // as a runtime failure.
  entry('alone', { title: 'Alone' }),
]);

const artifact: ContentArtifact = validateArtifact({ version: 1, entries }, 'graph-enumeration corpus');

let snapshotDirectory: string;
let snapshotPath: string;

beforeAll(() => {
  snapshotDirectory = mkdtempSync(join(tmpdir(), 'anc-graph-enumeration-'));
  snapshotPath = join(snapshotDirectory, 'site.sqlite');
  writeSnapshot(artifact, snapshotPath);
});

afterAll(() => rmSync(snapshotDirectory, { recursive: true, force: true }));

/** Run against the suite's one snapshot; each caller opens its own handle. */
function withSnapshot<T>(run: (path: string) => T): T {
  return run(snapshotPath);
}

/** A read-only handle running the fixed statements the operations need. */
function adapter(database: DatabaseSync): SnapshotDb {
  return {
    select: (sql, params) =>
      database.prepare(sql).all(...((params ?? []) as never[])) as Record<string, unknown>[],
  };
}

/**
 * The enumeration oracle: the exact authored slugs in cursor order, each once.
 *
 * Deliberately usable on a wrong walker as well as a correct one — the
 * lookahead control below proves it detects a skipped note rather than merely
 * restating whatever the walk returned.
 */
function assertEnumerates(actual: readonly string[], expected: readonly string[], label: string): void {
  // Uniqueness first: it names the defect directly, while a duplicate would
  // otherwise surface as an unexplained deep-equal mismatch.
  assert.equal(new Set(actual).size, actual.length, `${label}: a slug was enumerated more than once`);
  assert.deepEqual(actual, expected, `${label}: the enumerated membership is not the hand-written list in cursor order`);
}

/** The correct walker: continue from the last returned slug until exhaustion. */
function walkEdge(db: SnapshotDb, direction: 'outgoing' | 'backlinks'): { slugs: string[]; sizes: number[] } {
  const slugs: string[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = edgePage(db, direction, 'hub', cursor, PAGE_SIZE);
    assert.ok(result.known, `${direction}: hub is a known subject in the authored corpus`);
    if (!result.known) return { slugs, sizes };
    sizes.push(result.page.notes.length);
    slugs.push(...result.page.notes.map((note) => note.slug));
    if (result.page.nextCursor === null) return { slugs, sizes };
    // The contract's cursor is the last *returned* slug. A cursor built from
    // the `pageSize + 1` lookahead row would skip that row on the next page.
    assert.equal(result.page.nextCursor, result.page.notes.at(-1)?.slug, `${direction}: nextCursor is not the last returned slug`);
    cursor = result.page.nextCursor;
  }
}

test('the snapshot enumerates all 15 outgoing and 15 backlink neighbours across cursor pages', () => {
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const db = adapter(database);
      for (const [direction, expected] of [
        ['outgoing', EXPECTED_OUTGOING],
        ['backlinks', EXPECTED_BACKLINKS],
      ] as const) {
        const { slugs, sizes } = walkEdge(db, direction);
        assert.deepEqual(sizes, [4, 4, 4, 3], `${direction}: the walk did not page as 4/4/4/3 at page size 4`);
        assertEnumerates(slugs, expected, direction);
      }

      // A returned summary carries the target's own title and effective
      // language, not the subject's label.
      const first = edgePage(db, 'outgoing', 'hub', null, PAGE_SIZE);
      assert.ok(first.known);
      if (first.known) {
        assert.deepEqual(first.page.notes[0], { slug: 'out-01', title: 'Out 01', language: NAV_LANGUAGE });
      }

      const exhausted = { known: true, page: { notes: [], nextCursor: null } };
      assert.deepEqual(
        edgePage(db, 'outgoing', 'hub', 'out-15', PAGE_SIZE),
        exhausted,
        'the page after the last outgoing member is not a known exhausted page',
      );
      assert.deepEqual(
        edgePage(db, 'outgoing', 'hub', 'zzz-not-a-member', PAGE_SIZE),
        exhausted,
        'a cursor beyond every member must stay a known, exhausted page',
      );
      assert.deepEqual(edgePage(db, 'backlinks', 'hub', 'in-15', PAGE_SIZE), exhausted);
    } finally {
      database.close();
    }
  });
});

test('a walker that reuses the lookahead row as its cursor provably drops members', () => {
  // A control over the oracle, not over production behavior: this walker
  // deliberately passes the member immediately after the last returned slug,
  // so each page boundary drops one row. The hand-computed damage at page size
  // 4 over 15 members is out-05/out-10/out-15 (and in-05/in-10/in-15 for
  // backlinks); the same oracle the correct walk passes must reject the result.
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const db = adapter(database);
      const cases = [
        { direction: 'outgoing' as const, expected: EXPECTED_OUTGOING, missing: ['out-05', 'out-10', 'out-15'] },
        { direction: 'backlinks' as const, expected: EXPECTED_BACKLINKS, missing: ['in-05', 'in-10', 'in-15'] },
      ];
      for (const { direction, expected, missing } of cases) {
        const wrong: string[] = [];
        let cursor: string | null = null;
        for (;;) {
          const result = edgePage(db, direction, 'hub', cursor, PAGE_SIZE);
          assert.ok(result.known, `${direction}: hub is a known subject`);
          if (!result.known) break;
          wrong.push(...result.page.notes.map((note) => note.slug));
          if (result.page.nextCursor === null) break;
          const lookahead = expected.indexOf(result.page.nextCursor) + 1;
          cursor = expected[lookahead]!;
        }

        assert.equal(wrong.length, 12, `${direction}: the wrong walker collected an unexpected number of notes`);
        const collected = new Set(wrong);
        assert.deepEqual(
          expected.filter((slug) => !collected.has(slug)),
          missing,
          `${direction}: the wrong walker did not skip the hand-computed lookahead rows`,
        );
        assert.throws(
          () => assertEnumerates(wrong, expected, direction),
          `${direction}: the enumeration oracle accepted a walk that skipped its lookahead row`,
        );
        assertEnumerates(walkEdge(db, direction).slugs, expected, direction);
      }
    } finally {
      database.close();
    }
  });
});

test('an unknown center is null, an isolated center is empty, and an unknown tag is an empty selection', () => {
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const db = adapter(database);

      assert.equal(localGraph(db, 'ghost'), null, 'an unknown center returned a graph');
      assert.deepEqual(
        edgePage(db, 'outgoing', 'ghost', null, PAGE_SIZE),
        { known: false, page: { notes: [], nextCursor: null } },
        'an unknown subject is not a distinct no-match result',
      );
      assert.deepEqual(
        globalGraph(db, 'no-such-tag'),
        { nodes: [], edges: [], omitted: 0 },
        'an unknown tag is not an empty selection',
      );
      assert.deepEqual(
        localGraph(db, 'alone'),
        { center: { slug: 'alone', title: 'Alone', language: NAV_LANGUAGE }, nodes: [], edges: [], omitted: 0 },
        'a known isolated center is not an empty neighbourhood',
      );

      // The controls: the same calls are non-empty for known inputs, so the
      // shapes above are a no-match result rather than what every call returns.
      const knownLocal = localGraph(db, 'hub');
      assert.ok(knownLocal !== null && knownLocal.nodes.length === 12, 'the known hub did not return its drawn neighbourhood');
      const knownGlobal = globalGraph(db);
      assert.ok(
        knownGlobal.nodes.length > 0 && knownGlobal.edges.length > 0,
        'the unfiltered graph is empty, so the empty-tag result proves nothing',
      );
    } finally {
      database.close();
    }
  });
});

test('the hub local graph is the hand-listed induced neighbourhood with the center uncounted', () => {
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const db = adapter(database);
      const worker = localGraph(db, 'hub');
      assert.deepEqual(
        worker,
        {
          center: { slug: 'hub', title: 'Hub', language: NAV_LANGUAGE },
          nodes: EXPECTED_LOCAL_NODES,
          edges: EXPECTED_LOCAL_EDGES,
          omitted: 18,
        },
        'the local selection is not the hand-listed neighbourhood',
      );
      if (worker === null) return;

      // The center is in neither number: 12 drawn + 18 omitted is the 30
      // neighbours. Counting the center would make the same pair sum to 31.
      assert.equal(worker.nodes.length, 12, 'the drawn count is not the neighbour bound');
      assert.equal(worker.nodes.length + worker.omitted, 30, 'drawn + omitted is not the neighbour total');
      assert.ok(!worker.nodes.some((node) => node.slug === 'hub'), 'the center was counted as its own neighbour');
      assert.ok(!worker.edges.some((edge) => edge.from === 'hub' && edge.to === 'hub'), 'a self-edge was induced');

      // The build's own local graph over the same authored entries must agree
      // with the hand lists, so the snapshot operation is not the only path.
      const lookup = new Map(entries.map((candidate) => [candidate.slug, candidate]));
      const built = buildLocal(entries[0]!, (slug) => lookup.get(slug));
      assert.deepEqual(
        built.nodes
          .filter((node) => !node.isSubject)
          .map((node) => ({ slug: node.entry.slug, title: node.entry.title, language: node.entry.language ?? NAV_LANGUAGE })),
        EXPECTED_LOCAL_NODES,
        'the build local selection differs from the hand-listed neighbourhood',
      );
      assert.equal(built.omitted, 18, 'the build omitted a different count');
    } finally {
      database.close();
    }
  });
});
