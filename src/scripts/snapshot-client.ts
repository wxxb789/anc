/**
 * Main-thread client for the lazy snapshot Worker.
 *
 * Ordinary reading must download zero SQLite assets, so this module creates the
 * Worker only on first explicit intent and shares one instance for previews,
 * tag browsing, and graph exploration. It owns request ids, deadlines, and the
 * pending bound: a reply from a torn-down Worker is discarded rather than
 * attached to the current UI.
 */

import {
  WORKER_LIMITS,
  type SnapshotErrorCode,
  type SnapshotMessage,
  type SnapshotReply,
  type SnapshotResult,
} from '../lib/worker-protocol.ts';

type Pending = {
  resolve: (result: SnapshotResult) => void;
  reject: (error: SnapshotClientError) => void;
  timer: ReturnType<typeof setTimeout>;
  /** `performance.now()` when the request was dispatched, for measurement. */
  started: number;
};

export class SnapshotClientError extends Error {
  readonly code: SnapshotErrorCode;
  constructor(code: SnapshotErrorCode) {
    super(code);
    this.name = 'SnapshotClientError';
    this.code = code;
  }
}

let worker: Worker | undefined;
let nextId = 1;
let initialized = false;
const pending = new Map<number, Pending>();

function failAll(code: SnapshotErrorCode): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new SnapshotClientError(code));
  }
  pending.clear();
}

function reset(code: SnapshotErrorCode): void {
  worker?.terminate();
  worker = undefined;
  initialized = false;
  failAll(code);
}

function ensureWorker(): Worker {
  if (worker !== undefined) return worker;
  const created = new Worker(new URL('./snapshot-worker.ts', import.meta.url), { type: 'module' });
  created.addEventListener('message', (event: MessageEvent) => {
    const reply = event.data as SnapshotReply;
    const entry = pending.get(reply.id);
    if (entry === undefined) return;
    const elapsed = performance.now() - entry.started;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) {
      initialized = true;
      // Observability seam for the benchmark harness, armed explicitly by the
      // measurer: the operation, its dispatch-to-validated-result time, and the
      // Worker's own operation time (its queries plus selection). Goal 0005
      // requires the two recorded separately for goal 0008. No corpus data is
      // carried, and an ordinary reader dispatches nothing.
      if (typeof window !== 'undefined' && (window as { __snapshotMeasurement?: boolean }).__snapshotMeasurement === true) {
        document.dispatchEvent(
          new CustomEvent('snapshot-result', {
            detail: { type: reply.result.type, ms: elapsed, operationMs: reply.operationMs },
          }),
        );
      }
      entry.resolve(reply.result);
    } else {
      entry.reject(new SnapshotClientError(reply.code));
    }
  });
  const crashed = (): void => reset('terminated');
  created.addEventListener('error', crashed);
  created.addEventListener('messageerror', crashed);
  worker = created;
  return created;
}

/**
 * Release the Worker and settle what it owed.
 *
 * A document's snapshot cannot change in place — its binding is compiled into
 * the page — so the lifecycle contract's "snapshot change" case arrives as a
 * new document with a new binding, and teardown is the only in-place
 * transition. Registering it on `pagehide` releases the Worker (and its
 * deserialized database) with the document, without an idle timer that would
 * make a later preview cold.
 */
export function dispose(): void {
  reset('cancelled');
}

// `typeof window` keeps this module loadable in Node for the client gate; a
// browser is the only environment where the listener has anything to release.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => dispose());

/**
 * Send one named operation.
 *
 * @throws {SnapshotClientError} with a small code on failure, a bounded reject
 *   when too many requests are already pending, and on a deadline.
 */
export function request(message: SnapshotMessage): Promise<SnapshotResult> {
  // The bound applies at every stage: a ready Worker must not accumulate an
  // unbounded queue of closures and timers just because initialization finished.
  if (pending.size >= WORKER_LIMITS.maxPendingRequests) {
    return Promise.reject(new SnapshotClientError('busy'));
  }
  let instance: Worker;
  try {
    instance = ensureWorker();
  } catch {
    // A Worker the document may not construct (CSP refusal, unsupported engine)
    // rejects this request instead of throwing past an awaiting caller; the
    // client's init state stays clean, so the next intent tries again.
    return Promise.reject(new SnapshotClientError('terminated'));
  }
  const deadline = initialized ? WORKER_LIMITS.requestDeadlineMs : WORKER_LIMITS.startupDeadlineMs;
  return new Promise<SnapshotResult>((resolve, reject) => {
    const id = message.id;
    const timer = setTimeout(() => {
      // A cancel message cannot interrupt synchronous SQL already running in the
      // Worker, so the only bounded stop is terminating it.
      reset('timeout');
    }, deadline);
    pending.set(id, { resolve, reject, timer, started: performance.now() });
    instance.postMessage(message);
  });
}

/** Mint the next request id. */
function nextRequestId(): number {
  return nextId++;
}

type ResultOf<K extends SnapshotResult['type']> = Extract<SnapshotResult, { type: K }>;

/** Preview one published note. */
export function requestPreview(slug: string): Promise<ResultOf<'preview'>> {
  return request({ id: nextRequestId(), type: 'preview', slug }) as Promise<ResultOf<'preview'>>;
}

/** One page of a tag's members. */
export function requestByTag(
  tagKey: string,
  cursor?: string | null,
  pageSize?: number,
): Promise<ResultOf<'byTag'>> {
  return request({ id: nextRequestId(), type: 'byTag', tagKey, cursor, pageSize }) as Promise<ResultOf<'byTag'>>;
}

/** The local neighbourhood of one note. */
export function requestLocalGraph(slug: string): Promise<ResultOf<'localGraph'>> {
  return request({ id: nextRequestId(), type: 'localGraph', slug }) as Promise<ResultOf<'localGraph'>>;
}

/** The global graph, optionally filtered to one tag. */
export function requestGlobalGraph(tagKey?: string | null): Promise<ResultOf<'globalGraph'>> {
  return request({ id: nextRequestId(), type: 'globalGraph', tagKey }) as Promise<ResultOf<'globalGraph'>>;
}
