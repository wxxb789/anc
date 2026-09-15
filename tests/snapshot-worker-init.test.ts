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
  SNAPSHOT_TABLE_COLUMNS,
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
  schema?: 'fail' | 'ok';
  closeThrows?: boolean;
}

/** The rows a driver must return for `assertSnapshotRows` to accept it. */
function contractRows(sql: string): Record<string, unknown>[] {
  if (sql === 'PRAGMA application_id') return [{ application_id: SNAPSHOT_APPLICATION_ID }];
  if (sql === 'PRAGMA user_version') return [{ user_version: SNAPSHOT_USER_VERSION }];
  if (sql.startsWith('SELECT type, name FROM sqlite_schema')) {
    return [
      ...SNAPSHOT_TABLES.map((name) => ({ type: 'table', name })),
      { type: 'index', name: SNAPSHOT_EXPLICIT_INDEX },
    ];
  }
  const table = /^PRAGMA table_info\(([^)]+)\)$/.exec(sql)?.[1];
  if (table !== undefined) {
    return (SNAPSHOT_TABLE_COLUMNS[table] ?? []).map((column) => ({ name: column.name, pk: column.pk }));
  }
  if (sql.startsWith("SELECT name FROM sqlite_schema WHERE type = 'index'")) {
    return [{ name: SNAPSHOT_EXPLICIT_INDEX }];
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
    selectValue(): unknown {
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

const BYTES = new Uint8Array(8);

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
