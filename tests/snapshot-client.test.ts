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
 * import; the measurement-event test also stubs `document.dispatchEvent`. The
 * import itself still runs under the module's `typeof window` Node guard.
 */

import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

import { WORKER_LIMITS, type LoadPhases, type SnapshotReply, type SnapshotResult } from '../src/lib/worker-protocol.ts';

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
  windowStub.__snapshotMeasurement = false;
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
  delete (globalThis as Record<string, unknown>).document;
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
  worker.emit({ id: 1, ok: true, result: firstResult, operationMs: 0.5 });
  worker.emit({ id: 2, ok: true, result: secondResult, operationMs: 0.5 });

  assert.deepEqual(await first, firstResult, 'the first request did not settle from its own reply');
  assert.deepEqual(await second, secondResult, 'the second request did not settle from its own reply');
});

test('the armed measurement seam carries the result type, elapsed time, and the Worker operation span', async () => {
  const client = await loadClient();
  const dispatched: CustomEvent<{ type: string; ms: number; operationMs: number }>[] = [];
  (globalThis as Record<string, unknown>).document = {
    dispatchEvent: (event: Event): boolean => {
      dispatched.push(event as CustomEvent<{ type: string; ms: number; operationMs: number }>);
      return true;
    },
  };

  // Unarmed, the seam stays silent: an ordinary reader dispatches nothing, and
  // the request posted is exactly the message the caller passed.
  const unarmed = client.request({ id: 1, type: 'preview', slug: 'alpha' });
  const worker = FakeWorker.instances[0]!;
  assert.deepEqual(
    worker.posted,
    [{ id: 1, type: 'preview', slug: 'alpha' }],
    'an unarmed dispatch did not post exactly the caller message',
  );
  worker.emit({ id: 1, ok: true, result: { type: 'preview', preview: null }, operationMs: 0.5 });
  await unarmed;
  assert.equal(dispatched.length, 0, 'the measurement event fired without the explicit arming flag');

  // Armed, one event carries the reply's own type and the Worker's measured
  // operation span beside the client's dispatch-to-result span. Goal 0005
  // requires the two recorded separately for goal 0008.
  windowStub.__snapshotMeasurement = true;
  const armed = client.request({ id: 2, type: 'localGraph', slug: 'alpha' });
  assert.deepEqual(
    worker.posted.at(-1),
    { id: 2, type: 'localGraph', slug: 'alpha', measure: true },
    'the armed dispatch did not add the measurement flag',
  );
  worker.emit({ id: 2, ok: true, result: { type: 'localGraph', graph: null }, operationMs: 1.75 });
  assert.equal((await armed).type, 'localGraph', 'the emitted reply did not settle the armed request');
  assert.equal(dispatched.length, 1, 'the armed measurement event did not fire exactly once');
  const detail = dispatched[0]!.detail;
  assert.equal(detail.type, 'localGraph', 'the event named a different operation than the reply');
  assert.ok(
    Number.isFinite(detail.ms) && detail.ms >= 0,
    `the dispatch-to-result span was not a finite non-negative number: ${detail.ms}`,
  );
  assert.equal(detail.operationMs, 1.75, 'the Worker operation span did not reach the event unchanged');
  // A reply without the measurement-only fields leaves the detail with exactly
  // the keys this seam always carried; the new fields are not `undefined` holes.
  assert.deepEqual(
    Object.keys(detail).sort(),
    ['ms', 'operationMs', 'type'],
    'an unmeasured reply changed the measurement event shape',
  );
});

test('an armed measured reply reaches the event with its inner-SQL figure and phases, on a copy of the caller message', async () => {
  const client = await loadClient();
  const dispatched: CustomEvent<{
    type: string;
    ms: number;
    operationMs: number;
    sqlMs?: number;
    phases?: LoadPhases;
  }>[] = [];
  (globalThis as Record<string, unknown>).document = {
    dispatchEvent: (event: Event): boolean => {
      dispatched.push(event as CustomEvent<{ type: string; ms: number; operationMs: number; sqlMs?: number; phases?: LoadPhases }>);
      return true;
    },
  };

  windowStub.__snapshotMeasurement = true;
  // The caller's object is held on purpose: only a copy may carry the flag.
  const message = { id: 4, type: 'localGraph', slug: 'alpha' } as const;
  const pending = client.request(message);
  const worker = FakeWorker.instances[0]!;
  assert.deepEqual(
    worker.posted,
    [{ id: 4, type: 'localGraph', slug: 'alpha', measure: true }],
    'the armed dispatch did not post a copy carrying the measurement flag',
  );
  assert.deepEqual(
    message,
    { id: 4, type: 'localGraph', slug: 'alpha' },
    'the armed dispatch mutated the caller message',
  );

  const phases: LoadPhases = {
    totalMs: 21,
    fetchMs: 9,
    digestMs: 3,
    wasmInitMs: 6,
    importMs: 3,
    wasmMemoryBytes: 16 * 1024 * 1024,
  };
  worker.emit({ id: 4, ok: true, result: { type: 'localGraph', graph: null }, operationMs: 1.5, sqlMs: 0.75, phases });
  assert.equal((await pending).type, 'localGraph', 'the measured reply did not settle its request');
  assert.equal(dispatched.length, 1, 'the measured reply did not produce exactly one event');
  const detail = dispatched[0]!.detail;
  assert.equal(detail.type, 'localGraph', 'the event named a different operation than the measured reply');
  assert.equal(detail.sqlMs, 0.75, 'the inner-SQL figure did not reach the event unchanged');
  assert.deepEqual(detail.phases, phases, 'the phase decomposition did not reach the event unchanged');
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

test('a deadline tears down the Worker, a late reply is discarded, and the next intent rebuilds', async () => {
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
  assert.equal(worker.terminations, 1, 'the startup deadline did not terminate the unresponsive Worker');
  assert.equal(settlements, 1, 'the timeout did not settle the original request exactly once');

  // The reply the terminated Worker owed arrives after teardown. The pending
  // entry is gone with the Worker, so it must be dropped.
  worker.emit({
    id: 1,
    ok: true,
    result: { type: 'preview', preview: { slug: 'alpha', title: 'Late', excerpt: '', aliases: [], language: 'en' } },
    operationMs: 0.5,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settlements, 1, 'a stale reply settled the original promise a second time');

  // No poisoned initialization promise: the next intent builds a new Worker and
  // can resolve rather than inheriting the failed one's rejection.
  const second = client.request({ id: 2, type: 'preview', slug: 'alpha' });
  assert.equal(FakeWorker.instances.length, 2, 'the next intent reused the timed-out Worker');
  const replacement = FakeWorker.instances[1]!;
  const secondResult: SnapshotResult = { type: 'preview', preview: null };
  replacement.emit({ id: 2, ok: true, result: secondResult, operationMs: 0.5 });
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

test('dispose and a Worker crash settle every pending request with their own codes, and the next intent rebuilds', async () => {
  const scenarios = [
    { name: 'dispose', code: 'cancelled', trigger: (client: SnapshotClient, _worker: FakeWorker) => client.dispose() },
    { name: 'a Worker crash', code: 'terminated', trigger: (_client: SnapshotClient, worker: FakeWorker) => worker.emitError() },
  ] as const;

  for (const scenario of scenarios) {
    const client = await loadClient();
    const first = client.request({ id: 1, type: 'preview', slug: 'alpha' });
    const second = client.request({ id: 2, type: 'preview', slug: 'beta' });
    const worker = FakeWorker.instances[0]!;

    // The handlers are attached before the trigger so neither rejection is
    // reported as unhandled.
    const firstRejected = assert.rejects(first, (error: { code?: string }) => error.code === scenario.code);
    const secondRejected = assert.rejects(second, (error: { code?: string }) => error.code === scenario.code);
    scenario.trigger(client, worker);
    await firstRejected;
    await secondRejected;
    assert.equal(worker.terminations, 1, `${scenario.name}: the dead Worker was not terminated`);

    // The reply the dead Worker owed must be dropped, and no state resurrected:
    // the next intent builds a new Worker.
    const later = client.request({ id: 3, type: 'preview', slug: 'alpha' });
    assert.equal(FakeWorker.instances.length, 2, `${scenario.name}: the next intent reused the dead Worker`);
    const replacement = FakeWorker.instances[1]!;
    const result: SnapshotResult = { type: 'preview', preview: null };
    replacement.emit({ id: 3, ok: true, result, operationMs: 0.5 });
    assert.deepEqual(await later, result, `${scenario.name}: the replacement Worker did not settle the later request`);
  }
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
  worker.emit({ id: 2, ok: true, result, operationMs: 0.5 });
  assert.deepEqual(await later, result, 'the retry after a refused construction did not settle');
});
