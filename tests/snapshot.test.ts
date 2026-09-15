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
  SNAPSHOT_USER_VERSION,
  readSnapshotBinding,
  snapshotRoute,
} from '../src/lib/snapshot.ts';
import { pageOf } from '../src/lib/snapshot-queries.ts';
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
      const plan = (sql: string): string =>
        (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as { detail: string }[])
          .map((row) => row.detail)
          .join(' | ');
      const outgoing = plan(
        'SELECT n.slug FROM edges AS e JOIN nodes AS n ON n.id = e.target_id ' +
          'WHERE e.source_id = 1 ORDER BY n.slug LIMIT 10',
      );
      assert.match(
        outgoing,
        /USING (?:COVERING )?PRIMARY KEY/,
        `outgoing does not use the edge primary key: ${outgoing}`,
      );
      assert.doesNotMatch(outgoing, /SCAN/, `outgoing scans the edge table instead of seeking it: ${outgoing}`);
      const backlinks = plan(
        'SELECT n.slug FROM edges AS e JOIN nodes AS n ON n.id = e.source_id ' +
          'WHERE e.target_id = 1 ORDER BY n.slug LIMIT 10',
      );
      assert.match(backlinks, /edges_by_target/, `backlinks does not use the reverse index: ${backlinks}`);
      const byTag = plan(
        'SELECT n.slug FROM tags AS t JOIN node_tags AS nt ON nt.tag_id = t.id ' +
          "JOIN nodes AS n ON n.id = nt.node_id WHERE t.key = 'a' ORDER BY n.slug LIMIT 10",
      );
      assert.match(byTag, /tags/, `tag lookup does not reach the tags table: ${byTag}`);
      assert.match(
        byTag,
        /SEARCH nt USING PRIMARY KEY/,
        `tag lookup does not seek the membership primary key: ${byTag}`,
      );
      assert.doesNotMatch(byTag, /SCAN/, `tag lookup scans instead of seeking: ${byTag}`);
    } finally {
      database.close();
    }
  });
});
