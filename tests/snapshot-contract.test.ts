/**
 * The shared snapshot schema contract, over the row-reader seam.
 *
 * The browser Worker and the build reader must agree on what a valid snapshot
 * is; these gates mutate one valid schema in each direction the contract names,
 * so the check is proven to look at the thing rather than at the header alone.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { SNAPSHOT_SCHEMA_SQL } from '../src/lib/snapshot.ts';
import { assertSnapshotRows, type SnapshotRowReader } from '../src/lib/snapshot-contract.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';

/** Apply the normative schema, then let a caller mutate it. */
function withSchema<T>(mutate: (database: DatabaseSync) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'anc-contract-'));
  try {
    const database = new DatabaseSync(join(directory, 'schema.sqlite'));
    try {
      database.exec(SNAPSHOT_SCHEMA_SQL);
      return mutate(database);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function reader(database: DatabaseSync): SnapshotRowReader {
  return (sql) => database.prepare(sql).all() as Record<string, unknown>[];
}

test('the exact schema is accepted', () => {
  withSchema((database) => assert.doesNotThrow(() => assertSnapshotRows(reader(database))));
});

test('a wrong application id or user version is rejected', () => {
  withSchema((database) => {
    database.exec('PRAGMA application_id = 1');
    assert.throws(() => assertSnapshotRows(reader(database)), /application_id/);
  });
  withSchema((database) => {
    database.exec('PRAGMA user_version = 99');
    assert.throws(() => assertSnapshotRows(reader(database)), /user_version/);
  });
});

test('an extra table, a missing index, or a changed column is rejected', () => {
  withSchema((database) => {
    database.exec('CREATE TABLE extra (x TEXT)');
    assert.throws(() => assertSnapshotRows(reader(database)), /tables are/);
  });
  withSchema((database) => {
    database.exec('DROP INDEX edges_by_target');
    assert.throws(() => assertSnapshotRows(reader(database)), /edges_by_target/);
  });
  withSchema((database) => {
    database.exec('ALTER TABLE nodes ADD COLUMN extra TEXT');
    assert.throws(() => assertSnapshotRows(reader(database)), /table nodes has columns/);
  });
});

test('a view is rejected even when the five tables are intact', () => {
  withSchema((database) => {
    database.exec('CREATE VIEW leak AS SELECT slug FROM nodes');
    assert.throws(() => assertSnapshotRows(reader(database)), /unexpected schema objects/);
  });
});
