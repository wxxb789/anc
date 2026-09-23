/**
 * The per-workload report schema and the failure-recording helpers every
 * measurement phase shares.
 */

import { BenchmarkIdentityDriftError } from './benchmark-identity.ts';
import { scrub } from './benchmark-host.ts';
import type { FixtureIdentity } from './benchmark-files.ts';
import type { CorpusFinalization, GeneratorRequest, Topology } from './benchmark-corpus.ts';
import type { GeneratedCorpus } from './generate-corpus.ts';
import type { DatabaseIdentity } from './benchmark-oracle.ts';
import type { TransferReport } from './benchmark-transfer.ts';
import type { HeapSummary, RenderTiming, WorkerPhases } from './benchmark-page.ts';
import type { OperationTiming } from './benchmark-driver.ts';
import type { Series } from './benchmark-stats.ts';

interface GeneratorIdentity {
  name: string;
  seed: number;
  options: GeneratorRequest;
  result: GeneratedCorpus | null;
  finalized: CorpusFinalization | null;
}

interface BuildIdentity {
  seconds: number | null;
  cli: { basename: string; sha256: string };
}

interface FailoverRecord {
  phase: string;
  message: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreviewSample {
  intentToVisibleMs: number | null;
  hoverDelayMs: number | null;
  hoverDelaySource: string;
  visible: boolean;
  nonEmpty: boolean;
  targetSlug: string | null;
  targetTitle: string | null;
  titleMatched: boolean | null;
  panelTextSample: string | null;
  error: string | null;
}

interface PreviewReport {
  targetFromDb: { slug: string; title: string } | null;
  cold: PreviewSample;
  warm: PreviewSample;
}

export interface StartupReport {
  instrument: string;
  blindSpots: string[];
  heap: HeapSummary | null;
  heapPeakNote: string;
  worker: {
    firstReplyMs: number | null;
    phases: WorkerPhases | null;
    phasesNote: string | null;
    wasmMemoryBytes: number | null;
  };
}

interface UiLocalGraphReport {
  activations: number;
  dispatchMs: number[];
  operationMs: number[];
  sqlMs: number[];
  phases: WorkerPhases | null;
  renderMs: number[];
  dispatchSummary: Series;
}

export interface TagBrowseReport {
  tagKey: string;
  pages: number;
  notesShown: number;
  dispatchMs: number[];
  operationMs: number[];
  sqlMs: number[];
  phases: WorkerPhases | null;
  dispatchSummary: Series;
}

interface GlobalGraphUiReport {
  unfilteredMs: number[];
  filteredMs: number[];
  operationMs: number[];
  renderMs: number[];
  phases: WorkerPhases | null;
  filteredTag: string | null;
}

export interface DriverOperationReport extends OperationTiming {
  pagesPerWalk?: number;
  notesWalked?: number;
  failures: string[];
}

interface QueriesReport {
  definitions: string[];
  ui: {
    localGraph: UiLocalGraphReport | null;
    tagBrowse: TagBrowseReport | null;
    globalGraph: GlobalGraphUiReport | null;
  };
  driver: Record<string, DriverOperationReport | null>;
  driverColdStart: {
    ok: boolean;
    code: string | null;
    dispatchMs: number | null;
    operationMs: number | null;
    sqlMs: number | null;
    phases: WorkerPhases | null;
  } | null;
  seam: { sqlMsObserved: boolean; phasesObserved: boolean };
}

export interface ReadingReport {
  definition: string;
  zeroRequests: {
    readingPage: { beforeIntent: boolean; urls: string[] };
    mainPage: { beforeIntent: boolean; urls: string[] };
  };
  active: RenderTiming | null;
  inactiveJavaScript: RenderTiming | null;
  delta: {
    domContentLoadedEventEnd: number | null;
    loadEventEnd: number | null;
    firstContentfulPaint: number | null;
    transferredBytes: number | null;
  };
  regressionNote: string;
}

export interface WorkloadReport {
  id: string;
  size: number;
  topology: Topology;
  generator: GeneratorIdentity;
  fixture: FixtureIdentity | null;
  build: BuildIdentity | null;
  database: DatabaseIdentity | null;
  transfer: TransferReport | null;
  startup: StartupReport | null;
  preview: PreviewReport | null;
  queries: QueriesReport | null;
  reading: ReadingReport | null;
  checks: CheckResult[];
  failures: FailoverRecord[];
  elapsedSeconds: number;
}

export class WorkloadMeasurementError extends Error {
  readonly workload: WorkloadReport;
  readonly originalError: unknown;

  constructor(workload: WorkloadReport, originalError: unknown) {
    super(scrub(originalError));
    this.name = 'WorkloadMeasurementError';
    this.workload = workload;
    this.originalError = originalError;
    workload.failures.push({
      phase: originalError instanceof BenchmarkIdentityDriftError ? 'identity' : 'workload',
      message: scrub(originalError),
    });
  }
}

export function emptyPreviewSample(): PreviewSample {
  return {
    intentToVisibleMs: null,
    hoverDelayMs: null,
    hoverDelaySource:
      'page observer: pointerover on the eligible link to #link-preview unhidden with text; no constant subtracted',
    visible: false,
    nonEmpty: false,
    targetSlug: null,
    targetTitle: null,
    titleMatched: null,
    panelTextSample: null,
    error: null,
  };
}

export async function withFailure(
  workload: WorkloadReport,
  phase: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    workload.failures.push({ phase, message: scrub(error) });
  }
}

export async function captureCleanupFailure(
  failures: FailoverRecord[],
  phase: string,
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push({ phase, message: scrub(error) });
  }
}
