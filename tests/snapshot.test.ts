/**
 * The public snapshot contract.
 *
 * These gates exercise the writer and the emitted schema directly against the
 * repository fixture corpus, whose expected rows are computed from the authored
 * entries rather than from the SQL the writer runs. A second copy of the schema
 * lives in the `node:sqlite` driver; this file asserts the two agree by reading
 * the file back through a fresh connection.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { validateArtifact, type ContentArtifact } from '../src/lib/schema.ts';
import { tagFacets } from '../src/lib/routes.ts';
import { NAV_LANGUAGE } from '../src/lib/translations.ts';
import {
  SNAPSHOT_APPLICATION_ID,
  SNAPSHOT_SCHEMA_SQL,
  SNAPSHOT_USER_VERSION,
  readSnapshotBinding,
  snapshotRoute,
} from '../src/lib/snapshot.ts';
import { pageOf, SNAPSHOT_QUERIES } from '../src/lib/snapshot-queries.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { assertSnapshotContract, writeSnapshot } from '../scripts/write-snapshot.ts';

const FIXTURE = new URL('./fixtures/valid-corpus.json', import.meta.url);

/** The fixture artifact, validated once. */
const artifact: ContentArtifact = validateArtifact(
  JSON.parse(readFileSync(FIXTURE, 'utf8')),
  'tests/fixtures/valid-corpus.json',
);

function withSnapshot<T>(run: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'anc-snapshot-'));
  const path = join(directory, 'site.sqlite');
  try {
    writeSnapshot(artifact, path);
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the snapshot carries the exact accepted schema and header', () => {
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      assertSnapshotContract(database);
      assert.equal(
        (database.prepare('PRAGMA application_id').get() as { application_id: number }).application_id,
        SNAPSHOT_APPLICATION_ID,
      );
      assert.equal(
        (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SNAPSHOT_USER_VERSION,
      );
      const integrity = database.prepare('PRAGMA integrity_check').all() as unknown as {
        integrity_check: string;
      }[];
      assert.deepEqual(
        integrity.map((row) => ({ ...row })),
        [{ integrity_check: 'ok' }],
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });
});

test('nodes, edges, aliases, and tags equal the authored corpus', () => {
  const entries = [...artifact.entries].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const expectedNodes = entries.map((entry) => ({
    slug: entry.slug,
    title: entry.title,
    excerpt: entry.excerpt,
    language: entry.language ?? NAV_LANGUAGE,
  }));
  const expectedEdges = entries
    .flatMap((entry) => entry.outgoing.map((target) => [entry.slug, target] as [string, string]))
    .sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : 1));
  const expectedAliases = entries.flatMap((entry) =>
    (entry.aliases ?? []).map((alias, ordinal) => ({ slug: entry.slug, ordinal, alias })),
  );
  const expectedTags = tagFacets(artifact.entries).map((facet) => ({
    key: facet.key,
    label: facet.label,
    members: facet.entries.map((entry) => entry.slug).sort(),
  }));

  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const nodes = (
        database.prepare('SELECT slug, title, excerpt, language FROM nodes ORDER BY slug').all() as unknown as {
          slug: string;
          title: string;
          excerpt: string;
          language: string;
        }[]
      ).map((row) => ({ ...row }));
      assert.deepEqual(nodes, expectedNodes);

      const edges = database
        .prepare(
          `SELECT s.slug AS source, t.slug AS target FROM edges AS e
           JOIN nodes AS s ON s.id = e.source_id JOIN nodes AS t ON t.id = e.target_id
           ORDER BY source, target`,
        )
        .all() as unknown as { source: string; target: string }[];
      assert.deepEqual(
        edges.map((row) => [row.source, row.target]),
        expectedEdges,
      );

      const aliases = (
        database
          .prepare(
            `SELECT n.slug AS slug, a.ordinal AS ordinal, a.alias AS alias
             FROM aliases AS a JOIN nodes AS n ON n.id = a.node_id
             ORDER BY n.slug, a.ordinal`,
          )
          .all() as unknown as { slug: string; ordinal: number; alias: string }[]
      ).map((row) => ({ ...row }));
      assert.deepEqual(aliases, expectedAliases);

      const tags = database
        .prepare('SELECT id, key, label FROM tags ORDER BY key')
        .all() as unknown as { id: number; key: string; label: string }[];
      assert.deepEqual(
        tags.map((tag) => tag.key),
        expectedTags.map((tag) => tag.key),
        'tag keys are not in canonical key order',
      );
      const memberships = database
        .prepare(
          `SELECT nt.tag_id AS tag, n.slug AS slug FROM node_tags AS nt
           JOIN nodes AS n ON n.id = nt.node_id ORDER BY nt.tag_id, n.slug`,
        )
        .all() as unknown as { tag: number; slug: string }[];
      for (const tag of tags) {
        assert.deepEqual(
          memberships.filter((row) => row.tag === tag.id).map((row) => row.slug),
          expectedTags.find((candidate) => candidate.key === tag.key)!.members,
        );
      }
      assert.equal(memberships.length, expectedTags.reduce((sum, tag) => sum + tag.members.length, 0));
    } finally {
      database.close();
    }
  });
});

test('the batched tag read equals the tagFacets projection over the fixture', () => {
  // The build hydrates each entry's `tags` from this query and then calls
  // `tagFacets`, while the browser reads the same `tags`/`node_tags` rows. The
  // rows must therefore be exactly the (slug, key, label) triples that
  // re-normalizing the labels reproduces — a changed key or a dropped label
  // would put the static tag pages and the enhanced browser on two different
  // facts. The expected value comes from `tagFacets`, the accepted producer
  // normalizer, not from SQL written for this test.
  const expected = tagFacets(artifact.entries)
    .flatMap((facet) =>
      facet.entries.map((entry) => ({ slug: entry.slug, key: facet.key, label: facet.label })),
    )
    .sort((left, right) =>
      left.slug !== right.slug ? (left.slug < right.slug ? -1 : 1) : left.key < right.key ? -1 : 1,
    );

  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = (
        database.prepare(SNAPSHOT_QUERIES.allNodeTags).all() as unknown as {
          slug: string;
          key: string;
          label: string;
        }[]
      ).map((row) => ({ ...row }));
      assert.deepEqual(rows, expected);
    } finally {
      database.close();
    }
  });
});

test('two fresh snapshots of one corpus are byte-identical', () => {
  withSnapshot((first) => {
    withSnapshot((second) => {
      assert.equal(
        createHash('sha256').update(readFileSync(first)).digest('hex'),
        createHash('sha256').update(readFileSync(second)).digest('hex'),
      );
    });
  });
});

test('the binding names the digest of the bytes it wrote', () => {
  withSnapshot((path) => {
    const written = writeSnapshot(artifact, path);
    assert.equal(written.url, snapshotRoute(written.digest));
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), written.digest);
    assert.deepEqual(readSnapshotBinding({ url: written.url, digest: written.digest }), {
      url: written.url,
      digest: written.digest,
      applicationId: SNAPSHOT_APPLICATION_ID,
      userVersion: SNAPSHOT_USER_VERSION,
    });
    assert.equal(readSnapshotBinding({ url: '/data/site.zzz.sqlite', digest: written.digest }), undefined);
    assert.equal(readSnapshotBinding({ url: written.url, digest: 'not-a-digest' }), undefined);
  });
});

test('a dangling or self edge is rejected rather than silently dropped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anc-snapshot-'));
  const path = join(directory, 'site.sqlite');
  try {
    const dangling = structuredClone(artifact);
    dangling.entries[0]!.outgoing = ['zzq-not-published'];
    assert.throws(() => writeSnapshot(dangling, path), /unpublished target/);

    const self = structuredClone(artifact);
    self.entries[0]!.outgoing = [self.entries[0]!.slug];
    assert.throws(() => writeSnapshot(self, path), /targets itself/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cursor pagination uses the last returned slug and never the lookahead row', () => {
  const rows = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
  assert.deepEqual(pageOf(rows, 2), { items: [{ slug: 'a' }, { slug: 'b' }], nextCursor: 'b' });
  assert.deepEqual(pageOf(rows, 3), { items: rows, nextCursor: null });
  assert.deepEqual(pageOf([], 2), { items: [], nextCursor: null });
});

test('representative queries use their declared access structures', () => {
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      // Plan the shipped statements themselves, with parameters bound: a copy
      // of a statement's text here would keep reporting the plan of SQL that no
      // longer ships, so a regression in SNAPSHOT_QUERIES would pass the gate.
      const plan = (sql: string, params: readonly unknown[] = []): string =>
        (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as unknown as { detail: string }[])
          .map((row) => row.detail)
          .join(' | ');
      const tagKey = tagFacets(artifact.entries)[0]?.key ?? 'unused-tag-key';

      const outgoing = plan(SNAPSHOT_QUERIES.outgoingFirst, [1, 10]);
      assert.match(
        outgoing,
        /USING (?:COVERING )?PRIMARY KEY/,
        `outgoing does not use the edge primary key: ${outgoing}`,
      );
      assert.doesNotMatch(outgoing, /SCAN/, `outgoing scans the edge table instead of seeking it: ${outgoing}`);

      const backlinks = plan(SNAPSHOT_QUERIES.backlinksFirst, [1, 10]);
      assert.match(backlinks, /edges_by_target/, `backlinks does not use the reverse index: ${backlinks}`);

      const byTag = plan(SNAPSHOT_QUERIES.byTagFirst, [tagKey, 10]);
      assert.match(byTag, /tags/, `tag lookup does not reach the tags table: ${byTag}`);
      assert.match(
        byTag,
        /SEARCH nt USING PRIMARY KEY/,
        `tag lookup does not seek the membership primary key: ${byTag}`,
      );
      assert.doesNotMatch(byTag, /SCAN/, `tag lookup scans instead of seeking: ${byTag}`);

      const tagNodes = plan(SNAPSHOT_QUERIES.tagNodes, [tagKey]);
      assert.match(
        tagNodes,
        /SEARCH t USING COVERING INDEX sqlite_autoindex_tags_1/,
        `tag members do not look the tag up by its unique key: ${tagNodes}`,
      );
      assert.match(
        tagNodes,
        /SEARCH nt USING PRIMARY KEY/,
        `tag members do not seek the membership primary key: ${tagNodes}`,
      );
      assert.doesNotMatch(tagNodes, /SCAN/, `tag members scan instead of seeking: ${tagNodes}`);

      // The tag-filtered ranking must stay proportional to the tag's incident
      // edges: one seek per member through each edge access path plus a
      // membership probe on the far endpoint, never a scan of the corpus' edge
      // set and never a member-by-member cross product.
      const tagDegrees = plan(SNAPSHOT_QUERIES.tagNodeDegrees, [tagKey]);
      assert.match(
        tagDegrees,
        /SEARCH e USING PRIMARY KEY/,
        `tag degrees do not read out-edges through the edge primary key: ${tagDegrees}`,
      );
      assert.match(
        tagDegrees,
        /SEARCH e USING COVERING INDEX edges_by_target/,
        `tag degrees do not read in-edges through the reverse index: ${tagDegrees}`,
      );
      assert.match(
        tagDegrees,
        /SEARCH nt USING PRIMARY KEY \(tag_id=\? AND node_id=\?\)/,
        `tag degrees do not test the far endpoint's membership by primary key: ${tagDegrees}`,
      );
      // The distinct-neighbour semantics are gated by the returned rows in
      // `degrees count a reciprocal pair once` below, not by plan text: the
      // planner's representation of `COUNT(DISTINCT ...)` differs across the
      // SQLite versions Node ships (22 emits `USE TEMP B-TREE FOR
      // count(DISTINCT)`; 24 dedupes through a `MERGE (UNION)` co-routine and
      // emits no such row).
      assert.doesNotMatch(
        tagDegrees,
        /SCAN (?:e|edges)\b/,
        `tag degrees scan the whole edge table instead of the tag's edges: ${tagDegrees}`,
      );

      const allNodes = plan(SNAPSHOT_QUERIES.allNodes);
      assert.match(
        allNodes,
        /SCAN nodes USING (?:COVERING )?INDEX/,
        `allNodes does not walk the slug index: ${allNodes}`,
      );
      assert.doesNotMatch(allNodes, /TEMP B-TREE/, `allNodes sorts instead of walking the slug index: ${allNodes}`);

      const allEdges = plan(SNAPSHOT_QUERIES.allEdges);
      assert.match(
        allEdges,
        /SCAN edges(?: \||$)/,
        `allEdges does not walk the edge primary key: ${allEdges}`,
      );
      assert.doesNotMatch(allEdges, /TEMP B-TREE/, `allEdges sorts instead of reading primary-key order: ${allEdges}`);

      // Build-time tags are one joined scan, not a query per page: the
      // membership primary key is walked once and both dimension tables are
      // probed by primary key. A rewrite that drove the join from `nodes` would
      // scan `node_tags` once per node, which is the quadratic the contract's
      // "One joined scan grouped in memory" row exists to forbid.
      const allNodeTags = plan(SNAPSHOT_QUERIES.allNodeTags);
      assert.match(allNodeTags, /SCAN nt\b/, `build-time tags do not scan the membership table once: ${allNodeTags}`);
      assert.match(
        allNodeTags,
        /SEARCH t USING INTEGER PRIMARY KEY/,
        `build-time tags do not probe the tag table by primary key: ${allNodeTags}`,
      );
      assert.match(
        allNodeTags,
        /SEARCH n USING INTEGER PRIMARY KEY/,
        `build-time tags do not probe the node table by primary key: ${allNodeTags}`,
      );
      assert.doesNotMatch(
        allNodeTags,
        /SCAN (?:nodes|tags)\b/,
        `build-time tags scan a dimension table instead of probing it: ${allNodeTags}`,
      );

      const nodeDegrees = plan(SNAPSHOT_QUERIES.nodeDegrees);
      assert.match(
        nodeDegrees,
        /edges_by_target/,
        `nodeDegrees does not aggregate through the reverse index: ${nodeDegrees}`,
      );
    } finally {
      database.close();
    }
  });
});

test('degrees count a reciprocal pair once and stay scoped to their graph', () => {
  // The plan for a `COUNT(DISTINCT ...)` aggregate differs across the SQLite
  // versions Node ships, so these gates pin the returned values instead: a
  // reciprocal pair is one neighbour, and the tag-scoped degree counts only
  // neighbours that are members too (node c links to a but does not carry the
  // tag, so it contributes to the global degree and not to the tag's).
  // `COUNT(DISTINCT ...)` and `COUNT(...)` are equivalent here because the
  // UNION deduplicates each pair before the aggregate; dropping that dedup
  // (UNION ALL) doubles each reciprocal degree and reds the length checks.
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(SNAPSHOT_SCHEMA_SQL);
    database.exec(`
      INSERT INTO nodes (id, slug, title, excerpt, language) VALUES
        (1, 'a', 'A', '', 'en'),
        (2, 'b', 'B', '', 'en'),
        (3, 'c', 'C', '', 'en');
      INSERT INTO edges (source_id, target_id) VALUES (1, 2), (2, 1), (1, 3);
      INSERT INTO tags (id, key, label) VALUES (1, 't', 'T');
      INSERT INTO node_tags (tag_id, node_id) VALUES (1, 1), (1, 2);
    `);
    const degrees = (sql: string, params: readonly unknown[] = []): [number, number][] =>
      (database.prepare(sql).all(...(params as never[])) as unknown as { id: number; degree: number }[])
        .map((row): [number, number] => [Number(row.id), Number(row.degree)])
        .sort((left, right) => left[0] - right[0]);

    assert.deepEqual(
      degrees(SNAPSHOT_QUERIES.tagNodeDegrees, ['t']),
      [
        [1, 1],
        [2, 1],
      ],
      'the tag subgraph counted a reciprocal edge twice or a non-member neighbour',
    );
    assert.deepEqual(
      degrees(SNAPSHOT_QUERIES.nodeDegrees),
      [
        [1, 2],
        [2, 1],
        [3, 1],
      ],
      'the global degree counted a reciprocal edge twice',
    );
  } finally {
    database.close();
  }
});
