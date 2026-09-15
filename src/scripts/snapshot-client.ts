/**
 * Main-thread client for the lazy snapshot Worker.
 *
 * Ordinary reading must download zero SQLite assets, so this module creates the
 * Worker only on first explicit intent and shares one instance for previews,
 * tag browsing, and graph exploration. It owns request ids, deadlines, the
 * pending bound, and generation invalidation: a reply from a torn-down Worker or
 * an older snapshot is discarded rather than attached to the current UI.
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
  generation: number;
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
let generation = 0;
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
  generation += 1;
  failAll(code);
}

function ensureWorker(): Worker {
  if (worker !== undefined) return worker;
  const created = new Worker(new URL('./snapshot-worker.ts', import.meta.url), { type: 'module' });
  created.addEventListener('message', (event: MessageEvent) => {
    const reply = event.data as SnapshotReply;
    const entry = pending.get(reply.id);
    if (entry === undefined) return;
    if (entry.generation !== generation) return;
    const elapsed = performance.now() - entry.started;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) {
      initialized = true;
      // Observability seam for the benchmark harness: the operation and its
      // measured dispatch-to-validated-result time. No corpus data is carried.
      document.dispatchEvent(
        new CustomEvent('snapshot-result', { detail: { type: reply.result.type, ms: elapsed } }),
      );
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
 * Send one named operation.
 *
 * @throws {SnapshotClientError} with a small code on failure, a bounded reject
 *   when too many requests are already pending, and on a deadline.
 */
export function request(message: SnapshotMessage): Promise<SnapshotResult> {
  if (!initialized && pending.size >= WORKER_LIMITS.maxPendingRequests) {
    return Promise.reject(new SnapshotClientError('busy'));
  }
  const instance = ensureWorker();
  const deadline = initialized ? WORKER_LIMITS.requestDeadlineMs : WORKER_LIMITS.startupDeadlineMs;
  return new Promise<SnapshotResult>((resolve, reject) => {
    const id = message.id;
    const timer = setTimeout(() => {
      // A cancel message cannot interrupt synchronous SQL already running in the
      // Worker, so the only bounded stop is terminating it.
      reset('timeout');
    }, deadline);
    pending.set(id, { resolve, reject, timer, generation, started: performance.now() });
    instance.postMessage(message);
  });
}

/** Mint the next request id. */
export function nextRequestId(): number {
  return nextId++;
}

type ResultOf<K extends SnapshotResult['type']> = Extract<SnapshotResult, { type: K }>;

/** Preview one slug. */
export function requestPreview(slug: string): Promise<ResultOf<'preview'>> {
  return request({ id: nextRequestId(), type: 'preview', slug }) as Promise<ResultOf<'preview'>>;
}

/** One page of a note's outgoing links or backlinks. */
export function requestEdges(
  direction: 'outgoing' | 'backlinks',
  slug: string,
  cursor?: string | null,
  pageSize?: number,
): Promise<ResultOf<'outgoing'>> {
  return request({ id: nextRequestId(), type: direction, slug, cursor, pageSize }) as Promise<ResultOf<'outgoing'>>;
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

/** Abandon one request; its eventual reply is discarded. */
export function cancel(id: number): void {
  const entry = pending.get(id);
  if (entry === undefined) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.reject(new SnapshotClientError('cancelled'));
}

/** Whether any SQLite asset has been requested yet. */
export function isInitialized(): boolean {
  return initialized;
}

/** Tear down the Worker and reject everything pending. */
export function dispose(): void {
  reset('terminated');
}

/** Test seam: run a function with the module's state reset after. */
export function resetForTests(): void {
  reset('terminated');
  nextId = 1;
  initialized = false;
}
