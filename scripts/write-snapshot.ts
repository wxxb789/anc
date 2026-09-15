/**
 * Build the public SQLite snapshot from a validated content artifact.
 *
 * This is the producer side of `docs/core-design/sqlite-contract.md`. It writes a
 * fresh file (never copies and deletes from a previous snapshot, which would
 * leave removed text in free pages), finalizes it, runs the integrity and
 * foreign-key checks, validates the exact schema, and returns the binding the
 * rest of the build threads through: the digest-named URL, the full digest, and
 * the format constants.
 *
 * `node:sqlite` is the accepted build-time driver
 * (`docs/core-design/architecture.md`). Determinism is a contract: fixed page
 * size, explicit IDs in canonical slug/key order, primary-key insert order, no
 * timestamps and no counters, so two builds of the same corpus are byte-equal.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import type { ContentArtifact, ContentEntry } from '../src/lib/schema.ts';
import { tagFacets } from '../src/lib/routes.ts';
import { NAV_LANGUAGE } from '../src/lib/translations.ts';
import {
  SNAPSHOT_APPLICATION_ID,
  SNAPSHOT_EXPLICIT_INDEX,
  SNAPSHOT_PAGE_SIZE,
  SNAPSHOT_SCHEMA_SQL,
  SNAPSHOT_TABLE_COLUMNS,
  SNAPSHOT_TABLES,
  SNAPSHOT_USER_VERSION,
  snapshotRoute,
  type SnapshotBinding,
} from '../src/lib/snapshot.ts';

export interface WrittenSnapshot extends SnapshotBinding {
  /** Private filesystem path the bytes were written to. */
  path: string;
  /** Uncompressed size in bytes. */
  size: number;
}

/** A row read from `PRAGMA table_info`. */
interface TableInfoRow {
  name: string;
  pk: number;
}

/** Compare slugs in the canonical order IDs are assigned in. */
function bySlug(a: string, b: string): number {
  return a < b ? -1 : 1;
}

/**
 * Fail unless the file carries exactly the accepted schema.
 *
 * Called after finalization, before the file is hashed or copied. A matching
 * header alone is not proof: this checks the five tables, every column and
 * primary-key position, the explicit reverse index, and the absence of views or
 * triggers, so storage the query contract does not name cannot slip through.
 */
export function assertSnapshotContract(database: DatabaseSync): void {
  const applicationId = database.prepare('PRAGMA application_id').get() as
    | { application_id: number }
    | undefined;
  if (applicationId?.application_id !== SNAPSHOT_APPLICATION_ID) {
    throw new Error(
      `snapshot application_id is ${applicationId?.application_id}, expected ${SNAPSHOT_APPLICATION_ID}`,
    );
  }
  const userVersion = database.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  if (userVersion?.user_version !== SNAPSHOT_USER_VERSION) {
    throw new Error(
      `snapshot user_version is ${userVersion?.user_version}, expected ${SNAPSHOT_USER_VERSION}`,
    );
  }

  const objects = database
    .prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as { type: string; name: string }[];
  const tables = objects.filter((row) => row.type === 'table').map((row) => row.name).sort();
  const unexpected = [...tables].sort().join(',') !== [...SNAPSHOT_TABLES].sort().join(',');
  if (unexpected) {
    throw new Error(`snapshot tables are [${tables.join(', ')}], expected [${SNAPSHOT_TABLES.join(', ')}]`);
  }
  const otherObjects = objects.filter((row) => row.type !== 'table' && row.type !== 'index');
  if (otherObjects.length > 0) {
    throw new Error(
      `snapshot carries unexpected schema objects: ${otherObjects.map((row) => `${row.type} ${row.name}`).join(', ')}`,
    );
  }

  for (const [table, columns] of Object.entries(SNAPSHOT_TABLE_COLUMNS)) {
    const actual = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[];
    const shape = actual.map((row) => `${row.name}:${row.pk}`);
    const expected = columns.map((column) => `${column.name}:${column.pk}`);
    if (shape.length !== expected.length || shape.some((value, index) => value !== expected[index])) {
      throw new Error(
        `snapshot table ${table} has columns [${shape.join(', ')}], expected [${expected.join(', ')}]`,
      );
    }
  }

  const indexes = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  if (!indexes.some((row) => row.name === SNAPSHOT_EXPLICIT_INDEX)) {
    throw new Error(`snapshot is missing the ${SNAPSHOT_EXPLICIT_INDEX} index`);
  }
}

/**
 * Write the snapshot for one artifact and return its binding.
 *
 * @throws if a relation names an unknown or self target, if SQLite rejects a row,
 *   or if the finalized file fails integrity, foreign keys, or schema shape.
 */
export function writeSnapshot(artifact: ContentArtifact, destination: string): WrittenSnapshot {
  const entries = [...artifact.entries].sort((a, b) => bySlug(a.slug, b.slug));
  const idBySlug = new Map<string, number>(entries.map((entry, index) => [entry.slug, index + 1]));

  // `tagFacets` owns the accepted normalization, collision failure, and
  // representative-label rule; the snapshot must not re-derive it. Facets are
  // already in canonical key order, so their position is the tag id.
  const facets = tagFacets(artifact.entries);
  const tagIdByKey = new Map<string, number>(facets.map((facet, index) => [facet.key, index + 1]));

  rmSync(destination, { force: true });
  mkdirSync(dirname(destination), { recursive: true });

  const database = new DatabaseSync(destination);
  try {
    // Fixed before the first page is allocated, so byte layout is reproducible.
    database.exec(`PRAGMA page_size = ${SNAPSHOT_PAGE_SIZE}`);
    database.exec('PRAGMA journal_mode = DELETE');
    database.exec(SNAPSHOT_SCHEMA_SQL);

    database.exec('PRAGMA foreign_keys = ON');
    const enforced = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
    if (enforced?.foreign_keys !== 1) throw new Error('snapshot could not enable foreign-key enforcement');

    const insertNode = database.prepare(
      'INSERT INTO nodes (id, slug, title, excerpt, language) VALUES (?, ?, ?, ?, ?)',
    );
    const insertTag = database.prepare('INSERT INTO tags (id, key, label) VALUES (?, ?, ?)');
    const insertAlias = database.prepare(
      'INSERT INTO aliases (node_id, ordinal, alias) VALUES (?, ?, ?)',
    );
    const insertEdge = database.prepare('INSERT INTO edges (source_id, target_id) VALUES (?, ?)');
    const insertMembership = database.prepare(
      'INSERT INTO node_tags (tag_id, node_id) VALUES (?, ?)',
    );

    database.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        const id = idBySlug.get(entry.slug)!;
        insertNode.run(id, entry.slug, entry.title, entry.excerpt, entry.language ?? NAV_LANGUAGE);
      }
      for (const [index, facet] of facets.entries()) insertTag.run(index + 1, facet.key, facet.label);

      for (const entry of entries) {
        const id = idBySlug.get(entry.slug)!;
        for (const [ordinal, alias] of (entry.aliases ?? []).entries()) insertAlias.run(id, ordinal, alias);
      }

      for (const entry of entries) {
        const sourceId = idBySlug.get(entry.slug)!;
        for (const target of [...entry.outgoing].sort(bySlug)) {
          const targetId = idBySlug.get(target);
          if (targetId === undefined) {
            throw new Error(`snapshot edge from "${entry.slug}" names unpublished target "${target}"`);
          }
          if (targetId === sourceId) {
            throw new Error(`snapshot edge from "${entry.slug}" targets itself`);
          }
          insertEdge.run(sourceId, targetId);
        }
      }

      for (const facet of facets) {
        const tagId = tagIdByKey.get(facet.key)!;
        const memberIds = facet.entries
          .map((entry) => idBySlug.get(entry.slug)!)
          .sort((a, b) => a - b);
        for (const nodeId of memberIds) insertMembership.run(tagId, nodeId);
      }

      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    const integrity = database.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== 'ok') {
      throw new Error(`snapshot integrity_check is not ok: ${JSON.stringify(integrity)}`);
    }
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (foreignKeys.length > 0) {
      throw new Error(`snapshot foreign_key_check returned ${foreignKeys.length} row(s)`);
    }
    assertSnapshotContract(database);
  } finally {
    database.close();
  }

  const bytes = readFileSync(destination);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    url: snapshotRoute(digest),
    digest,
    applicationId: SNAPSHOT_APPLICATION_ID,
    userVersion: SNAPSHOT_USER_VERSION,
    path: destination,
    size: bytes.length,
  };
}

/** Type guard used where a caller holds a parsed entry rather than the writer's input. */
export function hasEdges(entry: ContentEntry): entry is ContentEntry & { outgoing: string[]; backlinks: string[] } {
  return Array.isArray(entry.outgoing) && Array.isArray(entry.backlinks);
}
