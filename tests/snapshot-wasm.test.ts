/**
 * Read-only import of a real snapshot through the pinned SQLite WASM.
 *
 * The browser gate proves the Worker path; this proves the underlying property
 * directly: a deserialized snapshot rejects writes even with `PRAGMA
 * query_only` turned off, and the shared schema validator accepts it. A mock
 * rejection would not be this.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { validateArtifact } from '../src/lib/schema.ts';
import { assertSnapshotRows } from '../src/lib/snapshot-contract.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';

interface SqliteDb {
  pointer: number;
  exec(sql: string): unknown;
  selectObjects(sql: string): Record<string, unknown>[];
  selectValue(sql: string): unknown;
  close(): void;
}

interface Sqlite3 {
  oo1: { DB: new () => SqliteDb };
  wasm: { allocFromTypedArray(source: Uint8Array): number };
  capi: {
    sqlite3_deserialize(
      pointer: number,
      schema: string,
      data: number,
      size: number,
      buffer: number,
      flags: number,
    ): number;
    SQLITE_DESERIALIZE_READONLY: number;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
  };
}

const artifact = validateArtifact(
  JSON.parse(readFileSync(new URL('./fixtures/valid-corpus.json', import.meta.url), 'utf8')),
  'tests/fixtures/valid-corpus.json',
);

function importReadOnly(sqlite3: Sqlite3, bytes: Uint8Array): SqliteDb {
  const database = new sqlite3.oo1.DB();
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const result = sqlite3.capi.sqlite3_deserialize(
    database.pointer,
    'main',
    pointer,
    bytes.byteLength,
    bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_READONLY | sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
  );
  assert.equal(result, 0, 'sqlite3_deserialize failed');
  return database;
}

test('a read-only snapshot rejects writes and satisfies the shared schema contract', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anc-wasm-'));
  const path = join(directory, 'site.sqlite');
  try {
    writeSnapshot(artifact, path);
    const bytes = new Uint8Array(readFileSync(path));
    const sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3;

    const database = importReadOnly(sqlite3, bytes);
    try {
      assert.doesNotThrow(() => assertSnapshotRows((sql) => database.selectObjects(sql)));

      database.exec('PRAGMA query_only = ON');
      assert.equal(database.selectValue('PRAGMA query_only'), 1);
      // Turn the secondary guard off: the primary READONLY import flag must
      // still reject a write, which is the property the design requires.
      database.exec('PRAGMA query_only = OFF');
      assert.equal(database.selectValue('PRAGMA query_only'), 0);
      assert.throws(
        () => database.exec("UPDATE nodes SET title = 'mutated'"),
        /READONLY|read-only|readonly/i,
        'a write succeeded against a read-only import',
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a snapshot with a foreign application id fails the shared schema contract', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anc-wasm-'));
  const path = join(directory, 'site.sqlite');
  try {
    writeSnapshot(artifact, path);
    const mutable = new DatabaseSync(path);
    mutable.exec('PRAGMA application_id = 0');
    mutable.close();
    const bytes = new Uint8Array(readFileSync(path));
    const sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3;
    const database = importReadOnly(sqlite3, bytes);
    try {
      assert.throws(() => assertSnapshotRows((sql) => database.selectObjects(sql)), /application_id/);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
