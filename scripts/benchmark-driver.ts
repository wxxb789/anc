/**
 * The driver Worker: a second Worker constructed from the built chunk, armed
 * named operations against it, and cursor walks with exact telemetry counts.
 */

import type { Page } from 'playwright';
import { scrub } from './benchmark-host.ts';
import { normalizePhases, type WorkerPhases } from './benchmark-page.ts';
import { tagIdentityFailure, type TagIdentity } from './benchmark-oracle.ts';
import { assertExactSampleCount, round, seriesOf, type Series } from './benchmark-stats.ts';

export const DRIVER_COLD_TIMEOUT_MS = 60_000;
export const DRIVER_WARM_TIMEOUT_MS = 10_000;
const MAX_WALK_PAGES = 500;

/** The page count implied by the finalized tag membership, never a fixed cap. */
export function tagWalkPageBound(tagMembers: number, pageSize: number): number {
  if (!Number.isInteger(tagMembers) || tagMembers < 0) throw new Error('tag member count must be a non-negative integer');
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error('tag page size must be a positive integer');
  return Math.max(1, Math.ceil(tagMembers / pageSize));
}

export interface DriverReply {
  id?: number;
  ok: boolean;
  code?: string;
  result?: {
    type: string;
    known?: boolean;
    page?: {
      known?: boolean;
      tag?: TagIdentity;
      notes: { slug: string; title: string; language: string }[];
      nextCursor: string | null;
    };
    preview?: { slug: string; title: string; excerpt: string } | null;
    graph?: {
      center?: { slug: string };
      nodes: { slug: string; title: string; language: string }[];
      edges: { from: string; to: string }[];
      omitted: number;
    } | null;
  };
  operationMs?: number;
  sqlMs?: number;
  phases?: unknown;
  dispatchMs: number;
}

export async function installDriver(page: Page, workerPath: string): Promise<void> {
  await page.evaluate((script: string) => {
    const state = window as unknown as {
      __benchDriver?: {
        request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
      };
    };
    if (state.__benchDriver !== undefined) return;
    const pending = new Map<number, (reply: unknown) => void>();
    let nextId = 1;
    const worker = new Worker(script, { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent) => {
      const reply = event.data as { id?: unknown };
      if (typeof reply?.id !== 'number') return;
      const settle = pending.get(reply.id);
      if (settle === undefined) return;
      pending.delete(reply.id);
      settle(reply);
    });
    state.__benchDriver = {
      request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
        const id = nextId;
        nextId += 1;
        const started = performance.now();
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ id, ok: false, code: 'timeout', dispatchMs: performance.now() - started });
          }, timeoutMs);
          pending.set(id, (reply) => {
            clearTimeout(timer);
            resolve({ ...(reply as Record<string, unknown>), dispatchMs: performance.now() - started });
          });
          worker.postMessage({ ...message, id, measure: true });
        });
      },
    };
  }, workerPath);
}

export function driverRequest(
  page: Page,
  type: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<DriverReply> {
  return page.evaluate(
    async (input: { type: string; args: Record<string, unknown>; timeoutMs: number }) => {
      const driver = (
        window as unknown as {
          __benchDriver?: { request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown> };
        }
      ).__benchDriver;
      if (driver === undefined) return { ok: false, code: 'no-driver', dispatchMs: 0 };
      return (await driver.request({ type: input.type, ...input.args }, input.timeoutMs)) as {
        ok: boolean;
        code?: string;
        result?: unknown;
        operationMs?: number;
        sqlMs?: number;
        phases?: unknown;
        dispatchMs: number;
      };
    },
    { type, args, timeoutMs },
  ) as Promise<DriverReply>;
}

export interface OperationTiming {
  repetitions: number;
  dispatchMs: number[];
  operationMs: number[];
  sqlMs: number[];
  phases: WorkerPhases | null;
  dispatchSummary: Series;
  opSummary: Series;
}

export function timingOf(): OperationTiming {
  return { repetitions: 0, dispatchMs: [], operationMs: [], sqlMs: [], phases: null, dispatchSummary: seriesOf([]), opSummary: seriesOf([]) };
}

export function measuredReplyFailure(
  label: string,
  reply: Pick<DriverReply, 'dispatchMs' | 'operationMs' | 'sqlMs' | 'phases'>,
  requirePhases = false,
): string | null {
  if (!Number.isFinite(reply.dispatchMs)) return `${label}: measured reply has non-finite dispatchMs`;
  if (!Number.isFinite(reply.operationMs)) return `${label}: measured reply has non-finite operationMs`;
  if (!Number.isFinite(reply.sqlMs)) return `${label}: measured reply has non-finite sqlMs`;
  if (requirePhases && normalizePhases(reply.phases) === null) return `${label}: cold measured reply has no complete phases`;
  return null;
}


export function absorbTiming(timing: OperationTiming, reply: DriverReply): void {
  const failure = measuredReplyFailure('driver', reply);
  if (failure !== null) throw new Error(failure);
  timing.dispatchMs.push(round(reply.dispatchMs, 3));
  timing.operationMs.push(round(reply.operationMs!, 3));
  timing.sqlMs.push(round(reply.sqlMs!, 3));
  if (timing.phases === null && reply.phases != null) timing.phases = normalizePhases(reply.phases);
}

export function finalizeTiming(
  timing: OperationTiming,
  repetitions: number,
  successfulReplies: number,
  label: string,
): OperationTiming {
  timing.repetitions = repetitions;
  assertExactSampleCount(`${label} dispatch telemetry`, timing.dispatchMs.length, successfulReplies);
  assertExactSampleCount(`${label} operation telemetry`, timing.operationMs.length, successfulReplies);
  assertExactSampleCount(`${label} SQL telemetry`, timing.sqlMs.length, successfulReplies);
  timing.dispatchSummary = seriesOf(timing.dispatchMs);
  timing.opSummary = seriesOf(timing.operationMs);
  return timing;
}

export interface WalkOutcome {
  timing: OperationTiming;
  pagesPerWalk: number;
  notes: { slug: string; title: string; language: string }[];
  tag: TagIdentity | null;
  failures: string[];
}

/** Drive one cursor operation across repetitions, walking `nextCursor` to null. */
export async function driveWalk(
  page: Page,
  type: 'backlinks' | 'outgoing' | 'byTag',
  args: Record<string, unknown>,
  pageSize: number,
  repetitions: number,
  maxPages: number = MAX_WALK_PAGES,
): Promise<WalkOutcome> {
  const timing = timingOf();
  const failures: string[] = [];
  const notes: { slug: string; title: string; language: string }[] = [];
  let tag: TagIdentity | null = null;
  let pagesPerWalk = 0;
  let successfulReplies = 0;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const reply = await driverRequest(page, type, { ...args, cursor, pageSize }, DRIVER_WARM_TIMEOUT_MS);
      if (!reply.ok || reply.result === undefined) {
        failures.push(`${type} repetition ${repetition} page ${pages}: ${reply.code ?? 'failed'}`);
        break;
      }
      successfulReplies += 1;
      const telemetryFailure = measuredReplyFailure(`${type} repetition ${repetition} page ${pages}`, reply);
      if (telemetryFailure !== null) {
        failures.push(telemetryFailure);
        break;
      }
      absorbTiming(timing, reply);
      const walkPage = reply.result.page;
      if (walkPage === undefined) {
        failures.push(`${type} repetition ${repetition}: reply carried no page`);
        break;
      }
      if (walkPage.notes.length > pageSize) {
        failures.push(`${type} returned ${walkPage.notes.length} notes for page size ${pageSize}`);
      }
      if (type === 'byTag') {
        const observed = walkPage.known === true && walkPage.tag !== undefined ? walkPage.tag : null;
        if (observed === null) failures.push(`byTag repetition ${repetition} page ${pages}: reply carried no tag identity`);
        else if (tag === null) tag = observed;
        else {
          const mismatch = tagIdentityFailure(observed, tag, `byTag repetition ${repetition} page ${pages}`);
          if (mismatch !== null) failures.push(mismatch);
        }
      }
      if (repetition === 0) notes.push(...walkPage.notes);
      cursor = walkPage.nextCursor;
      pages += 1;
      if (cursor === null) break;
      if (pages >= maxPages) {
        failures.push(`${type} cursor did not terminate within ${maxPages} pages`);
        break;
      }
    }
    if (repetition === 0) pagesPerWalk = pages;
  }
  try {
    finalizeTiming(timing, repetitions, successfulReplies, type);
  } catch (error) {
    failures.push(scrub(error));
    timing.dispatchSummary = seriesOf([]);
    timing.opSummary = seriesOf([]);
  }
  return { timing, pagesPerWalk, notes, tag, failures };
}
