/**
 * The relationship projection's failure controls, and the helper routes that
 * must not become relationships.
 *
 * `docs/goals/0002-consistent-static-relationships.md`'s "Useful failure
 * controls" row requires that invalid self/dangling/duplicate rows, tag-key
 * collisions, unexpected schema members, and a deliberately inverted or omitted
 * authored relation are each rejected by a gate. Three of those are held
 * elsewhere and are deliberately not restated here: unexpected schema members in
 * `tests/snapshot-contract.test.ts`, inverted/omitted authoring in
 * `tests/content-contract.test.ts` and `tests/snapshot-hydration.test.ts`, and
 * tag-key collisions in `tests/route-model.test.ts` (alias collisions live in
 * `tests/discovery.test.ts`). This file closes the remaining two:
 *
 * 1. the SQLite constraints themselves, over a snapshot the real
 *    `writeSnapshot` wrote — a duplicate alias ordinal, a duplicate alias label,
 *    a duplicate edge, a self edge, and a dangling edge;
 * 2. helper-page targets, which `docs/core-design/content-semantics.md` (lines
 *    23-24) requires to produce no `nodes` row and no `edges` row — over both
 *    the pure traversal and a corpus carried through `discover`,
 *    `resolveCorpusLinks`, and `writeSnapshot`.
 *
 * Nothing here is a hand-built schema fixture: every assertion runs against the
 * producer's own output, so a green run is a statement about the shipped shape.
 */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { indexCorpus, type CorpusFile } from '../src/lib/link-resolution.ts';
import { validateArtifact, type ContentArtifact } from '../src/lib/schema.ts';
import { snapshotFileName } from '../src/lib/snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { resolveLinksIn } from '../scripts/resolve-links.ts';
import { discover, resolveCorpusLinks } from '../scripts/markdown-to-artifact.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';
import { snapshotEdges, snapshotNotes } from './support/snapshot.ts';

const FIXTURE = new URL('./fixtures/valid-corpus.json', import.meta.url);

/** The repository fixture, validated the way a build validates its artifact. */
function artifact(): ContentArtifact {
  return validateArtifact(
    JSON.parse(readFileSync(FIXTURE, 'utf8')),
    'tests/fixtures/valid-corpus.json',
  );
}

/** A scratch directory removed when the callback returns, however it returns. */
async function scratch<T>(prefix: string, body: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Write a file, creating the directories above it. */
function put(root: string, relativePath: string, body: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

test('the finalized snapshot refuses a duplicate, self, or dangling relationship row', () => {
  // The constraints are the projection's last line of defence, and the contract
  // states each one (`docs/core-design/sqlite-contract.md`): the alias primary
  // key `(node_id, ordinal)`, `UNIQUE (node_id, alias)`, the edge primary key
  // `(source_id, target_id)`, `CHECK (source_id <> target_id)`, and the FK from
  // `edges.target_id` to `nodes.id` that SQLite enforces only while
  // `foreign_keys` is ON for *this* connection.
  //
  // Every attempt is made non-vacuous by reading the row it conflicts with
  // first: a constraint that fails because the table is empty is
  // indistinguishable from one that works.
  return scratch('rel-constraints-', (directory) => {
    const written = writeSnapshot(artifact(), join(directory, 'snapshot.sqlite'));
    const before = readFileSync(written.path);
    const database = new DatabaseSync(written.path);
    try {
      // The assignment form returns no row of its own (measured), so the
      // read-back is the assertion that enforcement is on. Read as a value
      // rather than as a row object: node:sqlite returns rows with a null
      // prototype, which a strict deep-equal would reject for that alone.
      database.exec('PRAGMA foreign_keys = ON');
      const enforced = database.prepare('PRAGMA foreign_keys').get() as
        | { foreign_keys: number }
        | undefined;
      assert.equal(enforced?.foreign_keys, 1, 'foreign-key enforcement is off, so the dangling-edge control below cannot fire');

      const count = (table: 'nodes' | 'edges' | 'aliases'): number =>
        (database.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
      const counts = { nodes: count('nodes'), edges: count('edges'), aliases: count('aliases') };
      assert.ok(
        counts.nodes > 0 && counts.edges > 0 && counts.aliases > 0,
        'the fixture projection is empty, so none of the constraints below can fire',
      );

      // The row the duplicate-alias attempts are built against: the lowest
      // ordinal-0 alias, read rather than assumed.
      const alias = database
        .prepare(
          `SELECT a.node_id AS node_id, a.ordinal AS ordinal, a.alias AS alias
           FROM aliases AS a
           WHERE a.ordinal = 0
           ORDER BY a.node_id
           LIMIT 1`,
        )
        .get() as { node_id: number; ordinal: number; alias: string } | undefined;
      assert.ok(alias !== undefined, 'the fixture carries no ordinal-0 alias, so these controls prove nothing');
      assert.equal(alias.ordinal, 0);

      // Duplicate ordinal: the alias primary key `(node_id, ordinal)`.
      assert.throws(
        () =>
          database
            .prepare('INSERT INTO aliases (node_id, ordinal, alias) VALUES (?, ?, ?)')
            .run(alias.node_id, 0, 'a second ordinal zero'),
        /UNIQUE constraint failed: aliases\.node_id, aliases\.ordinal/,
        'a second alias at ordinal 0 was accepted',
      );

      // Duplicate label: `UNIQUE (node_id, alias)`, at an ordinal the note does
      // not use — so the failure is the label constraint and not the primary
      // key. Both halves are asserted first: the ordinal is free, and the label
      // being inserted is the one the row above carries.
      const maxOrdinal = (
        database.prepare('SELECT MAX(ordinal) AS max FROM aliases WHERE node_id = ?').get(alias.node_id) as {
          max: number | null;
        }
      ).max;
      assert.ok(maxOrdinal !== null);
      const freeOrdinal = maxOrdinal + 1;
      assert.equal(
        database.prepare('SELECT 1 FROM aliases WHERE node_id = ? AND ordinal = ?').get(alias.node_id, freeOrdinal),
        undefined,
        'the ordinal is not free, so the failure below could be the primary key rather than alias uniqueness',
      );
      assert.equal(
        (
          database.prepare('SELECT alias FROM aliases WHERE node_id = ? AND ordinal = 0').get(alias.node_id) as {
            alias: string;
          }
        ).alias,
        alias.alias,
        'the ordinal-0 row is not the label being duplicated',
      );
      assert.throws(
        () =>
          database
            .prepare('INSERT INTO aliases (node_id, ordinal, alias) VALUES (?, ?, ?)')
            .run(alias.node_id, freeOrdinal, alias.alias),
        /UNIQUE constraint failed: aliases\.node_id, aliases\.alias/,
        'the same alias label was accepted twice for one note',
      );

      // An existing directed edge, read first so the duplicate is that exact
      // pair. The pair is asserted to be a real edge rather than a self edge,
      // because a self edge would make the two attempts below the same control.
      const edge = database
        .prepare('SELECT source_id, target_id FROM edges ORDER BY source_id, target_id LIMIT 1')
        .get() as { source_id: number; target_id: number } | undefined;
      assert.ok(edge !== undefined, 'the fixture projection has no edge, so the duplicate-edge control proves nothing');
      assert.notEqual(edge.source_id, edge.target_id, 'the fixture edge is a self edge, so the controls below conflate two constraints');

      assert.throws(
        () =>
          database
            .prepare('INSERT INTO edges (source_id, target_id) VALUES (?, ?)')
            .run(edge.source_id, edge.target_id),
        /UNIQUE constraint failed: edges\.source_id, edges\.target_id/,
        'the same directed edge was accepted twice',
      );

      // A self edge: `CHECK (source_id <> target_id)`. The pair is read as
      // absent first, so the failure is the CHECK and not the edge primary key.
      assert.equal(
        database.prepare('SELECT 1 FROM edges WHERE source_id = ? AND target_id = ?').get(edge.source_id, edge.source_id),
        undefined,
        'a self edge already exists, so this attempt would measure the primary key instead',
      );
      assert.throws(
        () =>
          database
            .prepare('INSERT INTO edges (source_id, target_id) VALUES (?, ?)')
            .run(edge.source_id, edge.source_id),
        /CHECK constraint failed: source_id <> target_id/,
        'a self edge was accepted',
      );

      // A dangling target: the FK, enforced only because this connection asked
      // for it above. The id is read as absent first.
      const dangling =
        (database.prepare('SELECT MAX(id) AS max FROM nodes').get() as { max: number }).max + 1000;
      assert.equal(
        database.prepare('SELECT 1 FROM nodes WHERE id = ?').get(dangling),
        undefined,
        'the dangling id is a real node, so this is not a dangling edge',
      );
      assert.throws(
        () =>
          database
            .prepare('INSERT INTO edges (source_id, target_id) VALUES (?, ?)')
            .run(edge.source_id, dangling),
        /FOREIGN KEY constraint failed/,
        'an edge to a node that does not exist was accepted',
      );

      // Nothing partial survived a rejection, and nothing is left to check.
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [], 'a rejected attempt left a dangling row');
      assert.deepEqual(
        { nodes: count('nodes'), edges: count('edges'), aliases: count('aliases') },
        counts,
        'a rejected insert changed a table',
      );

      // **The positive control**, without which every assertion above is
      // satisfied by a connection that cannot insert at all. A directed pair the
      // table does not carry goes in inside a transaction that is then rolled
      // back, so the gate proves the columns and constraints are the ones it
      // thinks they are and leaves the file as it found it.
      const ids = (database.prepare('SELECT id FROM nodes ORDER BY id').all() as unknown as { id: number }[]).map(
        (row) => row.id,
      );
      const edgeExists = database.prepare(
        'SELECT 1 FROM edges WHERE source_id = ? AND target_id = ?',
      );
      let pair: [number, number] | undefined;
      for (const source of ids) {
        for (const target of ids) {
          if (source === target) continue;
          if (edgeExists.get(source, target) === undefined) {
            pair = [source, target];
            break;
          }
        }
        if (pair !== undefined) break;
      }
      assert.ok(pair !== undefined, 'every node pair already has an edge, so the control cannot run');

      database.exec('BEGIN IMMEDIATE');
      const inserted = database.prepare('INSERT INTO edges (source_id, target_id) VALUES (?, ?)').run(pair[0], pair[1]);
      assert.equal(Number(inserted.changes), 1, 'a legal edge insert changed no row');
      assert.equal(count('edges'), counts.edges + 1, 'the legal edge is not in the table');
      database.exec('ROLLBACK');
      assert.equal(count('edges'), counts.edges, 'the control transaction was not rolled back');
    } finally {
      database.close();
    }

    // The gate read a real snapshot and left it byte-identical: the artifact a
    // reader downloads is not something a test run may mutate.
    assert.ok(before.equals(readFileSync(written.path)), 'the constraint controls modified the snapshot bytes');
  });
});

/** The corpus the pure-traversal gate resolves against. */
const CORPUS: readonly CorpusFile[] = [
  { path: 'index.md', slug: 'index' },
  { path: 'notes/beta.md', slug: 'notes-beta' },
];

/**
 * One helper route per line, each with a distinctive label.
 *
 * `404.html` is included because `404` is in `RESERVED_SLUGS`
 * (`src/lib/schema.ts`) and the artifact's own 404 page is `/404.html`. Every
 * entry is a route this site serves and therefore a target a note may
 * reasonably name, and the sentence in `content-semantics.md` is about all of
 * them: no helper-page target enters `nodes` or `edges`.
 */
const HELPER_LINKS = [
  ['private-index', '/private/'],
  ['tag-index', '/tags/some-tag/'],
  ['graph-index', '/graph/'],
  ['recent-index', '/recent/'],
  ['collection-index', '/collections/topic/'],
  ['404 page', '/404.html'],
] as const;

/** One body naming every helper route, with one real note as the control. */
const HELPER_BODY = [
  '# Index',
  '',
  ...HELPER_LINKS.map(([label, href]) => `Helper [${label}](${href}).`),
  'Control [beta](notes/beta.md).',
].join('\n');

test('a helper-route link resolves to no edge and degrades to its label', () => {
  // The pure-traversal half, driven exactly as `tests/link-traversal.test.ts`
  // drives `resolveLinksIn`, with the producer's default route shape
  // (`/${slug}/`, later rewritten to the real route by the renderer).
  const result = resolveLinksIn(HELPER_BODY, 'index.md', indexCorpus(CORPUS), 'index', (slug) => `/${slug}/`);

  // By content, not by count: one wrong edge and the right one are the same
  // cardinality, and the property is *which* target the projection may name.
  assert.deepEqual(result.outgoing, ['notes-beta'], 'a helper route produced an edge, or the real link did not');

  // Exact output, measured against the shipped walk. Every helper link takes
  // the `unresolved` branch: a helper path carries no scheme, so `isExternal`
  // does not fire; it goes through the same tiers as a note link, matches no
  // corpus basename, and degrades to the label its author wrote. The
  // alternative a future route allowlist would choose — leaving the href live —
  // is a product decision this gate does not make; what it pins is that the
  // *relationship* projection and the resolver agree that no note is named.
  //
  // The whole string is asserted because a per-construct `includes` check
  // cannot see a rewrite that kept the label but mangled the sentence around
  // it.
  const rewritten = [
    '# Index',
    '',
    ...HELPER_LINKS.map(([label]) => `Helper ${label}.`),
    'Control [beta](/notes-beta/).',
  ].join('\n');
  assert.equal(result.markdown, rewritten, 'a helper link did not degrade to its label');

  // Non-vacuity: the walk really ran, over the real link, and rewrote it to its
  // route.
  assert.ok(
    result.markdown.includes('Control [beta](/notes-beta/).'),
    'the control link was not rewritten, so the traversal did not run',
  );

  // Each helper is *reported* as unresolved, so the author sees the degraded
  // link in the report rather than discovering a missing anchor. This is also
  // the non-vacuity for the degradation above: a walk that never visited these
  // nodes would have no findings here and would pass a bare output check.
  assert.deepEqual(
    result.findings.map((finding) => [finding.link, finding.outcome]),
    HELPER_LINKS.map(([label, href]) => [`[${label}](${href})`, 'unresolved']),
    'a helper link was not reported as unresolved',
  );
});

test('a built corpus with helper-route links has one node per note and one edge per real link', async () => {
  await scratch('rel-helper-artifact-', async (root) => {
    put(root, 'index.md', `${HELPER_BODY}\n`);
    put(root, 'notes/beta.md', '# Beta\n\nprose\n');

    const discovery = await discover(root);
    await resolveCorpusLinks(discovery);

    // The producer's IR first: one outgoing target, the real note, and no
    // helper-derived slug. The snapshot below must project exactly this.
    const index = discovery.entries.find((entry) => entry.slug === 'index')!;
    assert.deepEqual(index.outgoing, ['notes-beta'], 'the producer IR carries a helper edge');
    assert.equal(discovery.counts.published, 2, 'the fixture did not publish two notes, so the counts below prove nothing');

    const content: ContentArtifact = validateArtifact(
      { version: 1, entries: discovery.entries },
      'content directory',
    );

    // Write under a digest name, the shape `tests/support/snapshot.ts` reads,
    // so the assertions use the shipped reader rather than a second join.
    const out = join(root, 'out');
    const written = writeSnapshot(content, join(out, 'data', 'site.sqlite'));
    renameSync(join(out, 'data', 'site.sqlite'), join(out, snapshotFileName(written.digest)));

    // Nodes: exactly the published note files. A helper route that minted a
    // placeholder row would appear here by name.
    const notes = snapshotNotes(out);
    assert.deepEqual(
      notes.map((note) => note.slug),
      ['index', 'notes-beta'],
      'a helper route became a node, or a published note did not',
    );
    assert.equal(
      notes.length,
      discovery.counts.published,
      'the snapshot node count does not match the number of published note files',
    );

    // Edges: exactly the real control pair, asserted by content so a wrong edge
    // of the same cardinality fails here.
    assert.deepEqual(
      snapshotEdges(out),
      [['index', 'notes-beta']],
      'the snapshot carries an edge a helper route produced, or lost the real one',
    );
  });
});
