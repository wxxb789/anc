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

/** One request as it arrives: an operation plus its id. */
export type SnapshotMessage = SnapshotArguments & { id: number };

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
  | { id: number; ok: true; result: SnapshotResult }
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
