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
import type { ContentArtifact } from '../src/lib/schema.ts';
import { tagFacets } from '../src/lib/routes.ts';
import { NAV_LANGUAGE } from '../src/lib/translations.ts';
import { compareSlugs } from '../src/lib/route-path.ts';
import {
  SNAPSHOT_APPLICATION_ID,
  SNAPSHOT_PAGE_SIZE,
  SNAPSHOT_SCHEMA_SQL,
  SNAPSHOT_USER_VERSION,
  snapshotRoute,
  type SnapshotBinding,
} from '../src/lib/snapshot.ts';
import { assertSnapshotRows } from '../src/lib/snapshot-contract.ts';

export interface WrittenSnapshot extends SnapshotBinding {
  /** Private filesystem path the bytes were written to. */
  path: string;
  /** Uncompressed size in bytes. */
  size: number;
}

/**
 * Compare slugs in the canonical order IDs are assigned in: Unicode code point
 * order, which is what SQLite's BINARY collation gives `ORDER BY slug` and the
 * `slug > ?` cursor. JavaScript `<` (UTF-16 units) disagrees for astral
 * characters, and would make `ORDER BY id` and `ORDER BY slug` diverge.
 */
const bySlug = compareSlugs;

/**
 * Fail unless the file carries exactly the accepted schema.
 *
 * The contract itself lives in `src/lib/snapshot-contract.ts`, so the native and
 * browser drivers validate the same rules; this adapts it to a `node:sqlite`
 * handle. Called after finalization, before the file is hashed or copied.
 */
export function assertSnapshotContract(database: DatabaseSync): void {
  assertSnapshotRows((sql) => database.prepare(sql).all() as Record<string, unknown>[]);
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
