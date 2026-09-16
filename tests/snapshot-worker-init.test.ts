/**
 * The Worker's snapshot import releases its handle on every failure path.
 *
 * `importSnapshot` deserializes the snapshot into WASM memory with
 * `SQLITE_DESERIALIZE_FREEONCLOSE`, so the `oo1.DB` handle owns a copy of the
 * bytes — up to `WORKER_LIMITS.maxSnapshotBytes` (64 MiB) — for as long as it
 * is open. The Worker's lifecycle clears a failed loading promise so a later
 * explicit intent retries and previews retry on pointerover, so a failure that
 * leaves the handle open accumulates one handle and one copy per attempt. The
 * fix under test closes the handle before rethrowing.
 *
 * The gate drives `importSnapshot` with a fake `sqlite3` that counts open and
 * closed handles: a leak is then a specific red assertion, not an inference
 * from WASM heap size. The real WASM acceptance and rejection behavior is
 * covered by `tests/snapshot-wasm.test.ts`; this file is the handle accounting
 * around it.
 */

import assert from 'node:assert/strict';
import { beforeAll, test } from 'vitest';

import {
  SNAPSHOT_APPLICATION_ID,
  SNAPSHOT_EXPLICIT_INDEX,
  SNAPSHOT_SCHEMA_SQL,
  SNAPSHOT_TABLE_SHAPES,
  SNAPSHOT_TABLES,
  SNAPSHOT_USER_VERSION,
} from '../src/lib/snapshot.ts';

type ImportSnapshot = typeof import('../src/scripts/snapshot-worker.ts')['importSnapshot'];

let importSnapshot: ImportSnapshot;

beforeAll(async () => {
  // The Worker entry reads `self` at module scope; the stub is what lets it
  // load in Node. Nothing here posts or listens.
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: { addEventListener() {}, postMessage() {} },
  });
  ({ importSnapshot } = await import('../src/scripts/snapshot-worker.ts'));
});

/** Which failure the fake driver should produce; mutable so a retry can succeed. */
interface FailureModes {
  /** `sqlite3_deserialize`'s return value; `0` is success. */
  deserialize?: number;
  /** `PRAGMA query_only`'s value; `1` is the accepted state. */
  queryOnly?: number;
  /** `PRAGMA page_count`'s value; one 512-byte page by default. */
  pageCount?: number;
  schema?: 'fail' | 'ok';
  closeThrows?: boolean;
}

/** The stored DDL of one table, as the writer's `SNAPSHOT_SCHEMA_SQL` spells it. */
function storedTableSql(table: string): string {
  const start = SNAPSHOT_SCHEMA_SQL.indexOf(`CREATE TABLE ${table} (`);
  if (start < 0) throw new Error(`SNAPSHOT_SCHEMA_SQL does not declare table ${table}`);
  return SNAPSHOT_SCHEMA_SQL.slice(start, SNAPSHOT_SCHEMA_SQL.indexOf(';', start));
}

/** The stored DDL of the one explicit index, as the writer spells it. */
function storedIndexSql(): string {
  const start = SNAPSHOT_SCHEMA_SQL.indexOf(`CREATE INDEX ${SNAPSHOT_EXPLICIT_INDEX.name}`);
  if (start < 0) throw new Error(`SNAPSHOT_SCHEMA_SQL does not declare index ${SNAPSHOT_EXPLICIT_INDEX.name}`);
  return SNAPSHOT_SCHEMA_SQL.slice(start, SNAPSHOT_SCHEMA_SQL.indexOf(';', start));
}

/**
 * The rows a driver must return for `assertSnapshotRows` to accept it, built
 * from the normative metadata so a schema change reaches this fixture rather
 * than letting it keep testing an older contract.
 */
function contractRows(sql: string): Record<string, unknown>[] {
  if (sql === 'PRAGMA application_id') return [{ application_id: SNAPSHOT_APPLICATION_ID }];
  if (sql === 'PRAGMA user_version') return [{ user_version: SNAPSHOT_USER_VERSION }];
  if (sql.startsWith('SELECT type, name')) {
    // The writer creates the one explicit index, so `sqlite_schema` carries it
    // beside the five tables; leaving it out would make the fake driver
    // describe a schema the writer cannot produce.
    return [
      ...SNAPSHOT_TABLES.map((name) => ({ type: 'table', name, sql: storedTableSql(name) })),
      { type: 'index', name: SNAPSHOT_EXPLICIT_INDEX.name, sql: storedIndexSql() },
    ];
  }
  const table = /^PRAGMA table_info\(([^)]+)\)$/.exec(sql)?.[1];
  if (table !== undefined) {
    return (SNAPSHOT_TABLE_SHAPES[table]?.columns ?? []).map((column) => ({
      name: column.name,
      type: column.type,
      notnull: column.notNull ? 1 : 0,
      pk: column.pk,
    }));
  }
  if (sql === 'PRAGMA table_list') {
    return SNAPSHOT_TABLES.map((name) => {
      const shape = SNAPSHOT_TABLE_SHAPES[name]!;
      return {
        schema: 'main',
        name,
        type: 'table',
        ncol: shape.columns.length,
        wr: shape.withoutRowid ? 1 : 0,
        strict: shape.strict ? 1 : 0,
      };
    });
  }
  const foreignKeyTable = /^PRAGMA foreign_key_list\(([^)]+)\)$/.exec(sql)?.[1];
  if (foreignKeyTable !== undefined) {
    return (SNAPSHOT_TABLE_SHAPES[foreignKeyTable]?.foreignKeys ?? []).map((key, id) => ({
      id,
      seq: 0,
      table: key.table,
      from: key.from,
      to: key.to,
      on_update: 'NO ACTION',
      on_delete: 'NO ACTION',
      match: 'NONE',
    }));
  }
  const indexTable = /^PRAGMA index_list\(([^)]+)\)$/.exec(sql)?.[1];
  if (indexTable !== undefined) {
    return indexTable === SNAPSHOT_EXPLICIT_INDEX.table
      ? [
          {
            seq: 0,
            name: SNAPSHOT_EXPLICIT_INDEX.name,
            unique: SNAPSHOT_EXPLICIT_INDEX.unique ? 1 : 0,
            origin: 'c',
            partial: SNAPSHOT_EXPLICIT_INDEX.partial ? 1 : 0,
          },
        ]
      : [];
  }
  if (sql === `PRAGMA index_info(${SNAPSHOT_EXPLICIT_INDEX.name})`) {
    return SNAPSHOT_EXPLICIT_INDEX.columns.map((name, seqno) => ({ seqno, cid: seqno, name }));
  }
  throw new Error(`the fake driver was asked a statement it does not implement: ${sql}`);
}

/**
 * The `sqlite3` surface `importSnapshot` uses, over a live-handle counter.
 *
 * `DB` is a real constructor so the `new` in the Worker keeps working, and
 * `close` decrements the live count. The `failure` object is returned by
 * reference so one fake can fail an attempt and then accept the retry.
 */
function fakeSqlite(failure: FailureModes = {}) {
  const live = new Set<object>();
  let opened = 0;
  let closed = 0;

  class Db {
    pointer = 0;
    constructor() {
      opened += 1;
      live.add(this);
    }
    exec(): void {
      // Only `PRAGMA query_only = ON` is issued; nothing to record.
    }
    selectObjects(sql: string): Record<string, unknown>[] {
      if (failure.schema === 'fail') throw new Error('schema probe failed');
      return contractRows(sql);
    }
    selectValue(sql: string): unknown {
      // `importSnapshot` reads the page count as well as `query_only`; the
      // fake's BYTES carries a 512-byte header page, so one page is the
      // accepted accounting.
      if (sql === 'PRAGMA page_count') return failure.pageCount ?? 1;
      return failure.queryOnly ?? 1;
    }
    close(): void {
      if (failure.closeThrows === true) throw new Error('close failed');
      closed += 1;
      live.delete(this);
    }
  }

  return {
    sqlite3: {
      oo1: { DB: Db },
      wasm: { allocFromTypedArray: () => 0 },
      capi: {
        sqlite3_deserialize: () => failure.deserialize ?? 0,
        SQLITE_DESERIALIZE_READONLY: 1,
        SQLITE_DESERIALIZE_FREEONCLOSE: 2,
      },
    },
    failure,
    get openCount() {
      return opened;
    },
    get closeCount() {
      return closed;
    },
    get liveCount() {
      return live.size;
    },
  };
}

/**
 * One SQLite header page's worth of bytes: 512 bytes with the header's
 * big-endian page-size field set to 512 (offset 16 becomes `0x02 0x00`). The
 * import's truncation check reads that field, so an all-zero buffer would be a
 * header the product correctly refuses.
 */
const BYTES = new Uint8Array(512);
BYTES[16] = 0x02;

test('a deserialize failure closes the handle', () => {
  const fake = fakeSqlite({ deserialize: 1 });

  assert.throws(() => importSnapshot(fake.sqlite3, BYTES), { code: 'format' });

  assert.equal(fake.openCount, 1, 'the import never opened a database');
  assert.equal(fake.closeCount, 1, 'the failed import left its DB handle open');
  assert.equal(fake.liveCount, 0, 'a handle survived the failed import');
});

test('a query_only failure closes the handle', () => {
  const fake = fakeSqlite({ queryOnly: 0 });

  assert.throws(() => importSnapshot(fake.sqlite3, BYTES), { code: 'format' });

  assert.equal(fake.openCount, 1, 'the import never opened a database');
  assert.equal(fake.closeCount, 1, 'the failed import left its DB handle open');
  assert.equal(fake.liveCount, 0, 'a handle survived the failed import');
});

test('a schema failure closes the handle', () => {
  const fake = fakeSqlite({ schema: 'fail' });

  assert.throws(() => importSnapshot(fake.sqlite3, BYTES), { code: 'schema' });

  assert.equal(fake.openCount, 1, 'the import never opened a database');
  assert.equal(fake.closeCount, 1, 'the failed import left its DB handle open');
  assert.equal(fake.liveCount, 0, 'a handle survived the failed import');
});

test('a close failure does not mask the import failure', () => {
  const fake = fakeSqlite({ queryOnly: 0, closeThrows: true });

  assert.throws(() => importSnapshot(fake.sqlite3, BYTES), { code: 'format' });
});

test('a successful retry after a failed import holds exactly one handle', () => {
  const fake = fakeSqlite({ queryOnly: 0 });

  assert.throws(() => importSnapshot(fake.sqlite3, BYTES), { code: 'format' });
  assert.equal(fake.liveCount, 0, 'the failed attempt left its handle open');

  fake.failure.queryOnly = 1;
  const database = importSnapshot(fake.sqlite3, BYTES);

  assert.equal(fake.openCount, 2, 'the retry did not open a fresh database');
  assert.equal(fake.closeCount, 1, 'the failed attempt was not the handle that closed');
  assert.equal(fake.liveCount, 1, 'the retry holds more than the one open database');

  database.close();
  assert.equal(fake.liveCount, 0, 'the successful import could not be closed');
});

/**
 * One 65536-byte page: the header's page-size field holds the format's sentinel
 * `1` at offset 16, big-endian, which means 64 KiB rather than one byte.
 */
const BIG_PAGE = new Uint8Array(65536);
BIG_PAGE[16] = 0x00;
BIG_PAGE[17] = 0x01;

test('the page-size header sentinel 1 reads as 65536 bytes', () => {
  const fake = fakeSqlite({ pageCount: 1 });

  const database = importSnapshot(fake.sqlite3, BIG_PAGE);

  assert.equal(fake.liveCount, 1, 'the import refused a valid 65536-byte page');
  database.close();
  assert.equal(fake.liveCount, 0, 'the valid import could not be closed');
});

test('a page count that disagrees with the byte length fails as format', () => {
  // `BYTES` is one 512-byte page; a driver reporting two of them is the padded
  // direction of the same boundary the truncation cases cover with real bytes.
  const fake = fakeSqlite({ pageCount: 2 });

  assert.throws(() => importSnapshot(fake.sqlite3, BYTES), { code: 'format' });

  assert.equal(fake.openCount, 1, 'the import never opened a database');
  assert.equal(fake.liveCount, 0, 'the mismatched import left its handle open');
});
