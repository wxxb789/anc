/**
 * The main-thread snapshot client's lifecycle, in Node.
 *
 * `src/scripts/snapshot-client.ts` owns the shared Worker, the request ids, the
 * pending bound, the deadlines, and the crash/teardown paths. Those are all
 * decisions that can be read without a browser, so this file drives them with a
 * fake `Worker` against the real module; a browser gate cannot see a promise
 * that never settles, and this one can.
 *
 * Test `the finite pending bound ...` is also the evidence for goal 0003 row 6's
 * "no unbounded request queue": the bound is finite and enforced, so the
 * seventeenth concurrent intent is rejected rather than retained. Without that,
 * a page that dispatches in a loop would accumulate closures and timers without
 * limit even after initialization finished.
 *
 * The client reads `window.__snapshotMeasurement` on its success path before it
 * resolves, so the tests install a minimal `window` stub after the dynamic
 * import; the import itself still runs under the module's `typeof window` Node
 * guard.
 */

import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

import { WORKER_LIMITS, type SnapshotReply, type SnapshotResult } from '../src/lib/worker-protocol.ts';

/** The client module under test, as re-imported after each reset. */
type SnapshotClient = typeof import('../src/scripts/snapshot-client.ts');

/**
 * A Worker stand-in that records construction, posted messages, and
 * terminations, and can deliver a reply to the registered listeners.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static constructionFails = false;

  readonly posted: unknown[] = [];
  terminations = 0;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor() {
    if (FakeWorker.constructionFails) throw new Error('worker construction refused');
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminations += 1;
  }

  /** Deliver one reply to every registered `message` listener. */
  emit(reply: SnapshotReply): void {
    const event = new MessageEvent('message', { data: reply });
    for (const listener of this.listeners.get('message') ?? []) listener(event);
  }

  /** Deliver one `error` event: the Worker-crash path the client resets on. */
  emitError(): void {
    const event = new Event('error');
    for (const listener of this.listeners.get('error') ?? []) listener(event as unknown as MessageEvent);
  }
}

/** Satisfies the client's success-path read of the measurement seam. */
const windowStub = { __snapshotMeasurement: false };

/**
 * Reset the module registry, install the fake Worker, and import the client
 * fresh so each test starts from `idle` with its own counter state.
 */
async function loadClient(): Promise<SnapshotClient> {
  vi.resetModules();
  FakeWorker.instances = [];
  FakeWorker.constructionFails = false;
  delete (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  const client = await import('../src/scripts/snapshot-client.ts');
  // Installed after the import so the module still evaluates under its
  // `typeof window` Node guard; only the reply path needs the global.
  (globalThis as Record<string, unknown>).window = windowStub;
  return client;
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).Worker;
  delete (globalThis as Record<string, unknown>).window;
});

test('two concurrent requests construct one Worker and settle from their own replies', async () => {
  const client = await loadClient();
  const first = client.request({ id: 1, type: 'preview', slug: 'alpha' });
  const second = client.request({ id: 2, type: 'preview', slug: 'beta' });

  assert.equal(FakeWorker.instances.length, 1, 'concurrent requests constructed more than one Worker');
  const worker = FakeWorker.instances[0]!;
  assert.deepEqual(worker.posted, [
    { id: 1, type: 'preview', slug: 'alpha' },
    { id: 2, type: 'preview', slug: 'beta' },
  ], 'both requests were not dispatched on the shared Worker');

  const firstResult: SnapshotResult = {
    type: 'preview',
    preview: { slug: 'alpha', title: 'Alpha One', excerpt: 'first', aliases: [], language: 'en' },
  };
  const secondResult: SnapshotResult = {
    type: 'preview',
    preview: { slug: 'beta', title: 'Beta One', excerpt: 'second', aliases: [], language: 'en' },
  };
  worker.emit({ id: 1, ok: true, result: firstResult });
  worker.emit({ id: 2, ok: true, result: secondResult });

  assert.deepEqual(await first, firstResult, 'the first request did not settle from its own reply');
  assert.deepEqual(await second, secondResult, 'the second request did not settle from its own reply');
});

test('the pending bound rejects past its finite limit instead of queueing', async () => {
  const client = await loadClient();
  const held: Promise<SnapshotResult>[] = [];
  for (let index = 0; index < WORKER_LIMITS.maxPendingRequests; index += 1) {
    held.push(client.request({ id: index + 1, type: 'preview', slug: 'alpha' }));
  }
  const worker = FakeWorker.instances[0]!;
  assert.equal(
    worker.posted.length,
    WORKER_LIMITS.maxPendingRequests,
    'the bound did not admit exactly its own limit of requests',
  );

  await assert.rejects(
    client.request({ id: WORKER_LIMITS.maxPendingRequests + 1, type: 'preview', slug: 'alpha' }),
    (error: { code?: string }) => error.code === 'busy',
    'the request past the pending bound was queued instead of rejected with busy',
  );
  assert.equal(worker.posted.length, WORKER_LIMITS.maxPendingRequests, 'the rejected request was still dispatched');

  client.dispose();
  const settled = await Promise.allSettled(held);
  assert.ok(
    settled.every((outcome) => outcome.status === 'rejected'),
    'dispose left a request behind the pending bound unsettled',
  );
});

test('the startup deadline terminates the Worker and a later request reinitializes', async () => {
  vi.useFakeTimers();
  const client = await loadClient();
  const first = client.request({ id: 1, type: 'preview', slug: 'alpha' });
  const worker = FakeWorker.instances[0]!;
  const rejected = assert.rejects(first, (error: { code?: string }) => error.code === 'timeout');
  await vi.advanceTimersByTimeAsync(WORKER_LIMITS.startupDeadlineMs + 1);
  await rejected;
  assert.equal(worker.terminations, 1, 'the startup deadline did not terminate the unresponsive Worker');

  // No poisoned initialization promise: the next intent builds a new Worker and
  // can resolve rather than inheriting the failed one's rejection.
  const second = client.request({ id: 2, type: 'preview', slug: 'alpha' });
  assert.equal(FakeWorker.instances.length, 2, 'the next intent reused the timed-out Worker');
  const replacement = FakeWorker.instances[1]!;
  const secondResult: SnapshotResult = { type: 'preview', preview: null };
  replacement.emit({ id: 2, ok: true, result: secondResult });
  assert.deepEqual(await second, secondResult, 'the reinitialized request did not settle');

  // Once initialized, the shorter request deadline governs, not the startup one.
  const third = client.request({ id: 3, type: 'preview', slug: 'beta' });
  const thirdRejected = assert.rejects(third, (error: { code?: string }) => error.code === 'timeout');
  await vi.advanceTimersByTimeAsync(WORKER_LIMITS.requestDeadlineMs + 1);
  await thirdRejected;
  assert.equal(
    replacement.terminations,
    1,
    'an initialized request did not use requestDeadlineMs, or its timeout did not terminate the Worker',
  );
});

test('a late reply from a torn-down Worker is discarded', async () => {
  vi.useFakeTimers();
  const client = await loadClient();
  let settlements = 0;
  const first = client.request({ id: 1, type: 'preview', slug: 'alpha' });
  void first.then(
    () => {
      settlements += 1;
    },
    () => {
      settlements += 1;
    },
  );
  const worker = FakeWorker.instances[0]!;
  const rejected = assert.rejects(first, (error: { code?: string }) => error.code === 'timeout');
  await vi.advanceTimersByTimeAsync(WORKER_LIMITS.startupDeadlineMs + 1);
  await rejected;
  assert.equal(settlements, 1, 'the timeout did not settle the original request exactly once');

  // The reply the terminated Worker owed arrives after teardown. It must be
  // dropped: the pending entry is gone with the Worker.
  worker.emit({
    id: 1,
    ok: true,
    result: { type: 'preview', preview: { slug: 'alpha', title: 'Late', excerpt: '', aliases: [], language: 'en' } },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settlements, 1, 'the stale reply settled the original promise a second time');

  // And no state was resurrected: the next request builds a new Worker rather
  // than attaching to the torn-down one.
  const second = client.request({ id: 2, type: 'preview', slug: 'alpha' });
  assert.equal(FakeWorker.instances.length, 2, 'the stale reply kept the torn-down Worker alive');
  const replacement = FakeWorker.instances[1]!;
  const secondResult: SnapshotResult = { type: 'preview', preview: null };
  replacement.emit({ id: 2, ok: true, result: secondResult });
  assert.deepEqual(await second, secondResult, 'the request after teardown did not settle from the new Worker');
});

test('dispose terminates, fails pending with cancelled, and a later request rebuilds', async () => {
  const client = await loadClient();
  const pending = client.request({ id: 1, type: 'preview', slug: 'alpha' });
  const worker = FakeWorker.instances[0]!;

  client.dispose();
  await assert.rejects(
    pending,
    (error: { code?: string }) => error.code === 'cancelled',
    'dispose did not reject the pending request with cancelled',
  );
  assert.equal(worker.terminations, 1, 'dispose did not terminate the Worker');

  const later = client.request({ id: 2, type: 'preview', slug: 'beta' });
  assert.equal(FakeWorker.instances.length, 2, 'the request after dispose reused the terminated Worker');
  const replacement = FakeWorker.instances[1]!;
  const result: SnapshotResult = { type: 'preview', preview: null };
  replacement.emit({ id: 2, ok: true, result });
  assert.deepEqual(await later, result, 'the request after dispose did not settle from the new Worker');
});

test('a Worker crash rejects every pending request and a later intent rebuilds', async () => {
  const client = await loadClient();
  const first = client.request({ id: 1, type: 'preview', slug: 'alpha' });
  const second = client.request({ id: 2, type: 'preview', slug: 'beta' });
  const crashed = FakeWorker.instances[0]!;

  // The `error` listener is the crash path the browser gates cannot reach: a
  // module Worker whose script fails to load fires it with no message ever
  // sent. Both owed requests must settle rather than hang.
  const firstRejected = assert.rejects(first, (error: { code?: string }) => error.code === 'terminated');
  const secondRejected = assert.rejects(second, (error: { code?: string }) => error.code === 'terminated');
  crashed.emitError();
  await firstRejected;
  await secondRejected;
  assert.equal(crashed.terminations, 1, 'the crash path did not terminate the crashed Worker');

  const later = client.request({ id: 3, type: 'preview', slug: 'alpha' });
  assert.equal(FakeWorker.instances.length, 2, 'the request after a crash reused the crashed Worker');
  const replacement = FakeWorker.instances[1]!;
  const result: SnapshotResult = { type: 'preview', preview: null };
  replacement.emit({ id: 3, ok: true, result });
  assert.deepEqual(await later, result, 'the replacement Worker did not settle the later request');
});

test('a Worker constructor that throws returns a rejected promise and can be retried', async () => {
  const client = await loadClient();
  FakeWorker.constructionFails = true;

  let thrown: unknown;
  let failed: Promise<SnapshotResult> | undefined;
  try {
    failed = client.request({ id: 1, type: 'preview', slug: 'alpha' });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, undefined, 'request() threw synchronously instead of returning a rejected promise');
  assert.ok(failed !== undefined, 'request() returned no promise when the Worker constructor refused');
  await assert.rejects(
    failed,
    (error: { code?: string }) => error.code === 'terminated',
    'a refused Worker construction did not reject with terminated',
  );
  assert.equal(FakeWorker.instances.length, 0, 'a refused construction still produced an instance');

  // Restored availability: the failure must not have cached a poisoned state.
  FakeWorker.constructionFails = false;
  const later = client.request({ id: 2, type: 'preview', slug: 'alpha' });
  assert.equal(FakeWorker.instances.length, 1, 'the retry after a refused construction did not build a Worker');
  const worker = FakeWorker.instances[0]!;
  const result: SnapshotResult = { type: 'preview', preview: null };
  worker.emit({ id: 2, ok: true, result });
  assert.deepEqual(await later, result, 'the retry after a refused construction did not settle');
});
