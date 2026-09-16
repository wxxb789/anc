/**
 * Read-only import of a real snapshot through the pinned SQLite WASM.
 *
 * The browser gate proves the Worker path; this proves the underlying property
 * directly: a deserialized snapshot rejects writes even with `PRAGMA
 * query_only` turned off, and the shared schema validator accepts it. A mock
 * rejection would not be this.
 *
 * The import runs through the product's own `importSnapshot`
 * (`src/scripts/snapshot-worker.ts`) rather than a test reimplementation. A
 * gate that reimplements the path it gates measures the reimplementation
 * (`docs/gate-reading.md` case 4): a change to the production import — the
 * READONLY/FREEONCLOSE flags, the `query_only` guard, the schema validation, or
 * the failure cleanup — would leave a local copy green. Loading the Worker
 * module in Node needs the `self` stub `tests/snapshot-worker-init.test.ts`
 * uses; nothing here posts or listens.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { beforeAll, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { validateArtifact } from '../src/lib/schema.ts';
import { assertSnapshotRows } from '../src/lib/snapshot-contract.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';

type ImportSnapshot = typeof import('../src/scripts/snapshot-worker.ts')['importSnapshot'];
type Sqlite3 = Parameters<ImportSnapshot>[0];

let importSnapshot: ImportSnapshot;
let sqlite3: Sqlite3;

beforeAll(async () => {
  // The Worker entry reads `self` at module scope; the stub is what lets it
  // load in Node. Nothing here posts or listens.
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: { addEventListener() {}, postMessage() {} },
  });
  ({ importSnapshot } = await import('../src/scripts/snapshot-worker.ts'));
  // One WASM runtime for the whole file. Each `sqlite3InitModule()` loads and
  // instantiates the module again, and nothing here mutates it beyond the
  // `oo1.DB` accounting the truncated test installs and restores.
  sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3;
});

const artifact = validateArtifact(
  JSON.parse(readFileSync(new URL('./fixtures/valid-corpus.json', import.meta.url), 'utf8')),
  'tests/fixtures/valid-corpus.json',
);

/**
 * Count the database handles the real driver hands out and takes back.
 *
 * `importSnapshot` must close its `oo1.DB` on every failure path, because the
 * handle owns a copy of the bytes. The wrapper subclasses the real constructor
 * so the accounting is around production behavior, not a replacement driver:
 * the bytes still go through the product's `sqlite3_deserialize` path.
 */
function countHandles(sqlite3: Sqlite3): { live(): number; restore(): void } {
  const realDb = sqlite3.oo1.DB;
  let live = 0;
  class CountedDb extends realDb {
    constructor() {
      super();
      live += 1;
    }
    close(): void {
      live -= 1;
      super.close();
    }
  }
  sqlite3.oo1.DB = CountedDb;
  return {
    live: () => live,
    // The runtime is shared by the whole file, so the accounting wrapper must
    // not outlive the test that installed it.
    restore: () => {
      sqlite3.oo1.DB = realDb;
    },
  };
}

test('a read-only snapshot rejects writes and satisfies the shared schema contract', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anc-wasm-'));
  const path = join(directory, 'site.sqlite');
  try {
    writeSnapshot(artifact, path);
    const bytes = new Uint8Array(readFileSync(path));

    const database = importSnapshot(sqlite3, bytes);
    try {
      assert.doesNotThrow(() => assertSnapshotRows((sql) => database.selectObjects(sql)));

      // The import sets its own guard; the gate confirms it, then turns the
      // secondary guard off. The primary READONLY import flag must still reject
      // a write, which is the property the design requires.
      assert.equal(database.selectValue('PRAGMA query_only'), 1, 'the import did not enable query_only');
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
}, 120_000);

test('a snapshot with a foreign application id fails the import', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anc-wasm-'));
  const path = join(directory, 'site.sqlite');
  try {
    writeSnapshot(artifact, path);
    // A valid file carrying a different project discriminator. The reader must
    // refuse it in the schema phase rather than run a query whose meaning it
    // cannot vouch for.
    const mutable = new DatabaseSync(path);
    mutable.exec('PRAGMA application_id = 0');
    mutable.close();
    const bytes = new Uint8Array(readFileSync(path));

    assert.throws(
      () => importSnapshot(sqlite3, bytes),
      { code: 'schema' },
      'a foreign application_id was imported',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

test('a foreign user_version fails the import', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anc-wasm-'));
  const path = join(directory, 'site.sqlite');
  try {
    writeSnapshot(artifact, path);
    // One version ahead: the reader accepts exactly its own contract version
    // and never negotiates, so a future format fails closed.
    const mutable = new DatabaseSync(path);
    mutable.exec('PRAGMA user_version = 2');
    mutable.close();
    const bytes = new Uint8Array(readFileSync(path));

    assert.throws(
      () => importSnapshot(sqlite3, bytes),
      { code: 'schema' },
      'a foreign user_version was imported',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

test('a mutated schema fails the import', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anc-wasm-'));
  const path = join(directory, 'site.sqlite');
  try {
    writeSnapshot(artifact, path);
    // Application id and version still match; only the exact schema changed, so
    // header constants alone must not be enough to accept the file.
    const mutable = new DatabaseSync(path);
    mutable.exec('ALTER TABLE aliases RENAME TO aliases_x');
    mutable.close();
    const bytes = new Uint8Array(readFileSync(path));

    assert.throws(
      () => importSnapshot(sqlite3, bytes),
      { code: 'schema' },
      'a snapshot with a renamed table was imported',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

test('truncated snapshot bytes fail closed and leave no database open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anc-wasm-'));
  const path = join(directory, 'site.sqlite');
  try {
    writeSnapshot(artifact, path);
    const bytes = new Uint8Array(readFileSync(path));
    const counted = countHandles(sqlite3);
    try {
      for (const [label, truncated] of [
        ['a 128-byte prefix', bytes.slice(0, 128)],
        ['all but the last byte', bytes.slice(0, bytes.length - 1)],
      ] as const) {
        // Both cases are `format`: SQLite tolerates a partial final page (the
        // file-based `PRAGMA integrity_check` still reports `ok`), so the import
        // itself compares `page_size * page_count` with the received byte length
        // and refuses a file that is not exactly its pages. Production normally
        // catches truncation one layer up, in `load`'s SHA-256 check; this gate
        // requires the import boundary itself to fail closed too.
        assert.throws(
          () => importSnapshot(sqlite3, truncated),
          { code: 'format' },
          `${label} was imported instead of failing closed`,
        );
        assert.equal(counted.live(), 0, `${label} left a database handle open`);
      }

      // A valid import after those failures still works, so a failed attempt did
      // not carry a partial database into the next one and did not poison the
      // module's state.
      const database = importSnapshot(sqlite3, bytes);
      try {
        assertSnapshotRows((sql) => database.selectObjects(sql));
      } finally {
        database.close();
      }
      assert.equal(counted.live(), 0, 'the successful import could not be closed');
    } finally {
      counted.restore();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
