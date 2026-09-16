/**
 * The shared read-only row enumerator.
 *
 * The scanners consume it through their own gates; these are the direct
 * properties: it reads a gzip-compressed BLOB as text, refuses WAL, and reports
 * a table it cannot read rather than returning it as clean.
 */

import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { DatabaseSync } from '../src/lib/sqlite.ts';
import { databaseText, declaresWal, isGzip, isSqlite } from '../scripts/snapshot-rows.ts';

function withDatabase<T>(build: (path: string) => void, run: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'anc-rows-'));
  const path = join(directory, 'store.sqlite');
  try {
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE bodies(body)');
    build(path);
    database.close();
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('magic helpers classify bytes without opening them', () => {
  assert.equal(isGzip(Uint8Array.from([0x1f, 0x8b, 0x00])), true);
  assert.equal(isGzip(Uint8Array.from([0x00, 0x00])), false);
  const header = new TextEncoder().encode('SQLite format 3\0');
  assert.equal(isSqlite(header), true);
  assert.equal(isSqlite(new TextEncoder().encode('not a database')), false);
  const wal = new Uint8Array(20);
  wal.set(header);
  wal[18] = 2;
  wal[19] = 2;
  assert.equal(declaresWal(wal), true);
});

test('a gzip-compressed BLOB is read as text', () => {
  withDatabase(
    (path) => {
      const database = new DatabaseSync(path);
      database.prepare('INSERT INTO bodies VALUES (?)').run(gzipSync(Buffer.from('inflate me')));
      database.close();
    },
    (path) => {
      const read = databaseText(new Uint8Array(readFileSync(path)));
      assert.ok(read.values.some((value) => value.includes('inflate me')), 'the BLOB was not inflated');
      assert.ok(read.corpusRows > 0);
    },
  );
});

test('a WAL header is refused before any open', () => {
  withDatabase(
    (path) => {
      const database = new DatabaseSync(path);
      database.prepare('INSERT INTO bodies VALUES (?)').run('plain');
      database.close();
    },
    (path) => {
      const bytes = new Uint8Array(readFileSync(path));
      bytes[18] = 2;
      bytes[19] = 2;
      assert.throws(() => databaseText(bytes), /rollback-journal/);
    },
  );
});

test('a corrupt database throws rather than returning an empty read', () => {
  const corrupt = Buffer.concat([
    Buffer.from('SQLite format 3\0', 'latin1'),
    Buffer.from('not a database at all'),
  ]);
  assert.throws(() => databaseText(new Uint8Array(corrupt)));
});
