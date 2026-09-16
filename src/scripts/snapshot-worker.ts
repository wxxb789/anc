/**
 * The lazy, read-only snapshot Worker.
 *
 * Owns the snapshot download, digest verification, WASM initialization,
 * read-only import, schema validation, and query execution. The main thread
 * never learns the database URL and never sends SQL: the binding is compiled
 * into this module, and requests are one of the named operations.
 *
 * Lifecycle (`docs/core-design/build-and-runtime.md`): one init promise per
 * document/snapshot; a failure clears it so a later explicit intent can retry;
 * every failure falls back to the already-rendered static page.
 */

import '../lib/build-bindings.ts';
import { assertSnapshotRows } from '../lib/snapshot-contract.ts';
import { edgePage, globalGraph, localGraph, preview, tagPage, type SnapshotDb } from '../lib/snapshot-operations.ts';
import {
  isSnapshotMessage,
  requestPageSize,
  WORKER_LIMITS,
  type SnapshotErrorCode,
  type SnapshotMessage,
  type SnapshotReply,
  type SnapshotResult,
} from '../lib/worker-protocol.ts';

/** Minimal Worker global, avoiding a webworker/DOM lib declaration clash. */
const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
};

const SQLITE_MAGIC = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];

/** A typed failure the reply maps back to a small error code. */
function fault(code: SnapshotErrorCode): never {
  const error = new Error(code) as Error & { code: SnapshotErrorCode };
  error.code = code;
  throw error;
}

function codeOf(error: unknown): SnapshotErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? (code as SnapshotErrorCode) : 'sql';
}

/**
 * Fetch with a running decoded-byte cap, cancelled before the cap is exceeded.
 *
 * Exported for `tests/snapshot-fetch-bounded.test.ts`, which drives it against
 * a server whose `Content-Length` disagrees with the body; `load` is the only
 * production caller.
 */
export async function fetchBounded(url: string, limit: number): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin', redirect: 'error' });
  } catch {
    return fault('fetch');
  }
  if (!response.ok) fault('fetch');

  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) fault('integrity');
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      fault('integrity');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

/**
 * Load the pinned runtime from its same-origin entry.
 *
 * The URL is read from a variable so Vite leaves the import for the browser
 * (`@vite-ignore`): bundling the package inlined its Emscripten glue into this
 * chunk and made the residue scan read the library's strings as ANC findings.
 */
async function initSqlite(bytes: Uint8Array, wasmUrl: string): Promise<Sqlite3> {
  const moduleUrl: string = __ANC_WASM_MODULE_URL__;
  const module = (await import(/* @vite-ignore */ moduleUrl)) as { default: unknown };
  const init = module.default as (options: {
    wasmBinary?: ArrayBuffer;
    locateFile?: (file: string) => string;
  }) => Promise<Sqlite3>;
  return init({ wasmBinary: bytes.buffer as ArrayBuffer, locateFile: () => wasmUrl });
}

interface SqliteDb {
  pointer: number;
  exec(sql: string): unknown;
  selectObjects(sql: string, params?: unknown[]): Record<string, unknown>[];
  selectValue(sql: string, params?: unknown[]): unknown;
  close(): void;
}

/**
 * Deserialize the snapshot bytes and validate the imported schema.
 *
 * Exported for `tests/snapshot-worker-init.test.ts`, which drives it with a
 * fake `sqlite3` and counts open handles; `load` is the only production caller.
 *
 * The `oo1.DB` handle owns a FREEONCLOSE copy of the bytes — up to
 * `WORKER_LIMITS.maxSnapshotBytes` — and `database()` clears a failed loading
 * promise so a later intent retries here, so every failure after the handle
 * exists closes it before rethrowing. Without the close each retry would hold
 * another handle and another copy; `docs/core-design/build-and-runtime.md`
 * requires the release on failing initialization.
 */
export function importSnapshot(sqlite3: Sqlite3, databaseBytes: Uint8Array): SqliteDb {
  const database = new sqlite3.oo1.DB();
  try {
    const pointer = sqlite3.wasm.allocFromTypedArray(databaseBytes);
    const result = sqlite3.capi.sqlite3_deserialize(
      database.pointer,
      'main',
      pointer,
      databaseBytes.byteLength,
      databaseBytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_READONLY | sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
    );
    // On failure with FREEONCLOSE, SQLite has already freed the buffer, so only
    // the handle is left for the close below.
    if (result !== 0) fault('format');

    database.exec('PRAGMA query_only = ON');
    if (database.selectValue('PRAGMA query_only') !== 1) fault('format');
    // A deserialize sizes its page list from the buffer length, so a file whose
    // last page is partial still imports — and `PRAGMA integrity_check` calls it
    // `ok`. The producer's snapshot is exactly its pages; any other byte length
    // is truncated or padded, and the import refuses it. The page size comes
    // from the file's own header (offset 16, big-endian; 1 means 65536) rather
    // than `PRAGMA page_size`, which on the pinned WASM build reports the
    // connection's compiled-in default for a freshly deserialized database.
    // This is the second line: `load` already fails truncated data on the
    // digest before import.
    const headerPageSize = (databaseBytes[16]! << 8) | databaseBytes[17]!;
    const pageSize = headerPageSize === 1 ? 65536 : headerPageSize;
    let pageCount: number;
    try {
      pageCount = Number(database.selectValue('PRAGMA page_count'));
    } catch {
      // A buffer too corrupt to answer `page_count` is refused as a format
      // fault rather than escaping as a raw driver error.
      fault('format');
    }
    if (!Number.isInteger(pageCount) || pageSize * pageCount !== databaseBytes.byteLength) fault('format');
    try {
      assertSnapshotRows((sql) => database.selectObjects(sql));
    } catch {
      fault('schema');
    }
    return database;
  } catch (error) {
    // Best effort: a close error must not replace the failure being diagnosed.
    try {
      database.close();
    } catch {
      // The original error is the diagnosis.
    }
    throw error;
  }
}

async function load(): Promise<SnapshotDb> {
  const snapshotBinding = __ANC_SNAPSHOT_BINDING__;
  const wasmBinding = __ANC_WASM_BINDING__;
  if (snapshotBinding === null || wasmBinding === null) fault('not-ready');

  // Neither download depends on the other, and both are on the cold path.
  const [databaseBytes, wasmBytes] = await Promise.all([
    fetchBounded(snapshotBinding.url, WORKER_LIMITS.maxSnapshotBytes),
    fetchBounded(wasmBinding.url, WORKER_LIMITS.maxWasmBytes),
  ]);
  const [databaseDigest, wasmDigest] = await Promise.all([sha256(databaseBytes), sha256(wasmBytes)]);
  if (databaseDigest !== snapshotBinding.digest) fault('integrity');
  if (databaseBytes.length < 100) fault('header');
  for (const [index, byte] of SQLITE_MAGIC.entries()) {
    if (databaseBytes[index] !== byte) fault('header');
  }
  // Bytes 18/19 are the file-format write/read versions: 1 is rollback journal,
  // 2 is WAL, which cannot be deserialized as a standalone snapshot.
  if (databaseBytes[18] !== 1 || databaseBytes[19] !== 1) fault('format');
  if (wasmDigest !== wasmBinding.digest) fault('integrity');

  let sqlite3: Awaited<ReturnType<typeof initSqlite>>;
  try {
    sqlite3 = await initSqlite(wasmBytes, wasmBinding.url);
  } catch {
    return fault('wasm');
  }

  const database = importSnapshot(sqlite3, databaseBytes);
  return { select: (sql, params) => database.selectObjects(sql, params ? [...params] : undefined) };
}

let loading: Promise<SnapshotDb> | undefined;

/** One shared initialization promise; a failure clears it so intent can retry. */
function database(): Promise<SnapshotDb> {
  loading ??= load().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

function run(db: SnapshotDb, message: SnapshotMessage): SnapshotResult {
  switch (message.type) {
    case 'preview':
      return { type: 'preview', preview: preview(db, message.slug) };
    case 'outgoing':
      return { type: 'outgoing', ...edgePage(db, 'outgoing', message.slug, message.cursor, requestPageSize(message)) };
    case 'backlinks':
      return { type: 'backlinks', ...edgePage(db, 'backlinks', message.slug, message.cursor, requestPageSize(message)) };
    case 'byTag':
      return { type: 'byTag', page: tagPage(db, message.tagKey, message.cursor, requestPageSize(message)) };
    case 'localGraph':
      return { type: 'localGraph', graph: localGraph(db, message.slug) };
    case 'globalGraph':
      return { type: 'globalGraph', graph: globalGraph(db, message.tagKey ?? undefined) };
  }
}

function reply(message: SnapshotReply): void {
  scope.postMessage(message);
}

async function handle(value: unknown): Promise<void> {
  if (!isSnapshotMessage(value)) {
    const id = (value as { id?: unknown } | null)?.id;
    if (typeof id === 'number') reply({ id, ok: false, code: 'bad-request' });
    return;
  }
  try {
    reply({ id: value.id, ok: true, result: run(await database(), value) });
  } catch (error) {
    reply({ id: value.id, ok: false, code: codeOf(error) });
  }
}

scope.addEventListener('message', (event) => {
  void handle(event.data);
});
