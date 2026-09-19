/**
 * The lazy snapshot Worker's message contract.
 *
 * Pure and dependency-free so the Worker and the main-thread client import the
 * same definition: a message the client can send is one the Worker can validate,
 * and a result the Worker can return is one the client can type.
 *
 * The design constrains this shape (`docs/core-design/build-and-runtime.md`):
 * messages carry a discriminated `type`, a request id, and operation-specific
 * validated arguments. There is deliberately **no field that can carry SQL, a
 * URL, a filesystem path, a table name, or a column name** — "named operations,
 * not an SQL console" is structural here, not a convention enforced elsewhere.
 */

import {
  isLookupSlug,
  isLookupTagKey,
  normalizePageSize,
  type GraphSelection,
  type LocalGraphSelection,
  type NotePage,
  type NotePreview,
  type TagPage,
} from './snapshot-queries.ts';

/**
 * Finite provisional bounds. Goal 0003 establishes these on the correctness
 * fixtures; goal 0008 must validate or replace them on the benchmark workloads.
 * They are not a capacity claim.
 */
export const WORKER_LIMITS = {
  /** Fetch + hash + WASM init + schema validation. */
  startupDeadlineMs: 20_000,
  /** One dispatched request to a validated result. */
  requestDeadlineMs: 8_000,
  /** Concurrent requests before a new one is rejected rather than queued. */
  maxPendingRequests: 16,
  /** Decoded snapshot bytes read before WASM allocation. */
  maxSnapshotBytes: 64 * 1024 * 1024,
  /** Decoded WASM bytes read before instantiation. */
  maxWasmBytes: 8 * 1024 * 1024,
} as const;

export type SnapshotOperation =
  | 'preview'
  | 'backlinks'
  | 'outgoing'
  | 'byTag'
  | 'localGraph'
  | 'globalGraph';

export const SNAPSHOT_OPERATIONS: readonly SnapshotOperation[] = [
  'preview',
  'backlinks',
  'outgoing',
  'byTag',
  'localGraph',
  'globalGraph',
];

/** Operation-specific arguments, before a request id is attached. */
export type SnapshotArguments =
  | { type: 'preview'; slug: string }
  | { type: 'backlinks'; slug: string; cursor?: string | null; pageSize?: number }
  | { type: 'outgoing'; slug: string; cursor?: string | null; pageSize?: number }
  | { type: 'byTag'; tagKey: string; cursor?: string | null; pageSize?: number }
  | { type: 'localGraph'; slug: string }
  | { type: 'globalGraph'; tagKey?: string | null };

/**
 * Measurement-only decomposition of the shared cold start.
 *
 * Every member is a number, `null`, or a boolean flag — never text that could
 * carry SQL, a URL, or a path — so carrying it crosses the same boundary the
 * header's no-SQL/no-URL/no-path rule governs. The numbers describe timings of
 * the Worker's own load phases, and goal 0008 is the consumer: a measured
 * request can attribute startup cost instead of reading it as one opaque span.
 */
export interface LoadPhases {
  /** Worker module evaluation to a validated, imported snapshot. */
  totalMs: number;
  /** The awaited pair of same-origin downloads (snapshot and WASM). */
  fetchMs: number;
  /** Both SHA-256 digests, measured as one awaited pair. */
  digestMs: number;
  /** Instantiation of the pinned SQLite WASM module. */
  wasmInitMs: number;
  /** Read-only deserialization, `query_only` guard, and schema validation. */
  importMs: number;
  /** WASM linear-memory capacity after import, or `null` where unexposed. */
  wasmMemoryBytes: number | null;
}

/**
 * One request as it arrives: an operation plus its id.
 *
 * `measure` is the instrumentation opt-in. Omitted by every ordinary client
 * dispatch, and `true` only when the measurer armed the client deliberately;
 * the Worker acts on it only as a literal boolean. `false` and an absent flag
 * mean the same reply shape as before this field existed.
 */
export type SnapshotMessage = SnapshotArguments & { id: number; measure?: boolean };

export type SnapshotErrorCode =
  | 'bad-request'
  | 'bad-argument'
  | 'unknown-operation'
  | 'not-ready'
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'terminated'
  | 'fetch'
  | 'integrity'
  | 'header'
  | 'format'
  | 'schema'
  | 'wasm'
  | 'sql';

export type SnapshotResult =
  | { type: 'preview'; preview: NotePreview | null }
  | { type: 'backlinks'; known: boolean; page: NotePage }
  | { type: 'outgoing'; known: boolean; page: NotePage }
  | { type: 'byTag'; page: TagPage }
  | { type: 'localGraph'; graph: LocalGraphSelection | null }
  | { type: 'globalGraph'; graph: GraphSelection };

export type SnapshotReply =
  | {
      id: number;
      ok: true;
      result: SnapshotResult;
      /**
       * Milliseconds this named operation spent executing in the Worker,
       * measured around its `run()` call after initialization is already
       * settled: its queries plus its selection/induced-edge work, and never a
       * cold start. Goal 0005 requires SQL/Worker and rendering timing recorded
       * separately for goal 0008, so a duration crosses the boundary as a
       * number; the header's no-SQL/no-URL/no-path rule is about text that could
       * be executed or resolved, and a duration is none.
       */
      operationMs: number;
      /**
       * Measurement-only inner-SQL figure: the sum of the spans this operation
       * spent inside its `select` calls, a subset of `operationMs`. Present
       * only when the request asked (`measure === true`); an ordinary reply
       * does not carry the key at all.
       */
      sqlMs?: number;
      /**
       * Measurement-only decomposition of the shared load that preceded this
       * reply, present only when the request asked and the load completed.
       * Never corpus data: durations and a memory capacity.
       */
      phases?: LoadPhases;
    }
  | { id: number; ok: false; code: SnapshotErrorCode };

/**
 * Whether an untrusted value is a request the Worker may run.
 *
 * Checks the discriminator, the id, and the lookup-shape of every argument.
 * Page size and cursor are validated here too; `normalizePageSize` clamps rather
 * than rejects, which is the accepted bound ("cap and validate the positive
 * integer page size").
 */
export function isSnapshotMessage(value: unknown): value is SnapshotMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const id = message['id'];
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return false;

  const type = message['type'];
  if (typeof type !== 'string' || !SNAPSHOT_OPERATIONS.includes(type as SnapshotOperation)) return false;

  // The instrumentation flag is optional, and only a boolean is a request the
  // Worker may act on; any other value is refused rather than coerced. Checked
  // before the per-operation branches because `preview`, `localGraph`, and
  // `globalGraph` return from those branches, and an invalid flag must not slip
  // past one of them. Unrelated extra keys stay ignored, as before.
  const measure = message['measure'];
  if (measure !== undefined && typeof measure !== 'boolean') return false;

  if (type === 'preview' || type === 'localGraph') return isLookupSlug(message['slug']);
  if (type === 'globalGraph') {
    return message['tagKey'] === undefined || message['tagKey'] === null || isLookupTagKey(message['tagKey']);
  }
  if (type === 'byTag') {
    if (!isLookupTagKey(message['tagKey'])) return false;
  } else if (!isLookupSlug(message['slug'])) {
    return false;
  }

  const cursor = message['cursor'];
  if (cursor !== undefined && cursor !== null && !isLookupSlug(cursor)) return false;
  const pageSize = message['pageSize'];
  if (pageSize !== undefined && typeof pageSize !== 'number') return false;
  return true;
}

/** The page size a validated request resolves to, clamped to the accepted range. */
export function requestPageSize(message: SnapshotMessage): number {
  return normalizePageSize((message as Record<string, unknown>)['pageSize']);
}

/** Narrow a reply to the result type a caller asked for. */
export function isResultOf<K extends SnapshotOperation>(
  reply: SnapshotReply,
  type: K,
): reply is Extract<SnapshotReply, { ok: true }> & { result: Extract<SnapshotResult, { type: K }> } {
  return reply.ok && reply.result.type === type;
}
