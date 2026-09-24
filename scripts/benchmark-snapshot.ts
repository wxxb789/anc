/**
 * Transfer, startup, preview, query, and ordinary-reading measurement for the
 * snapshot runtime.
 *
 * This is goal 0008's **instrument**, not its acceptance. It measures a real
 * built candidate in a real browser and writes a private JSON report under
 * `<git-dir>/publish-report/`, but the maintainer's policy decision is external
 * and is not invented here. Every
 * report states its candidate identity, host, browser version, OS, throttling
 * (labeled simulation when used), cache definitions, sample counts, quantile
 * method, corpus generator seed, and fixture identity.
 * Every successful measured reply must supply finite `dispatchMs`, `operationMs`,
 * and `sqlMs`; cold measured success must also supply complete `phases`. Missing
 * telemetry is a workload failure, never an interpolated value.
 *
 * Each workload is one (size, topology) pair: a seeded corpus from
 * `scripts/generate-corpus.ts`, built by the CLI named on the command line
 * (`--cli`, default `bin/anc.mjs`; pass the installed package's bin to measure
 * the packaged-tarball candidate), served over loopback under the output's own
 * `_headers` with gzip negotiation, and driven in Chromium, Chrome, or Edge
 * through hover preview, the local-graph control, the tag browser, the site
 * graph, and a driver Worker constructed from the built chunk. A named
 * Playwright device profile applies the browser's mobile emulation settings to
 * every measured context.
 *
 * The SQLite-asset definition in section F is imported from
 * `tests/support/browser-site.ts` (`sqliteAssetRequests`,
 * `WORKER_CHUNK_PATTERN`) rather than restated, so this instrument cannot
 * drift from the gate that defines the class.
 *
 * Usage: `node scripts/benchmark-snapshot.ts [--sizes 100,1000,10000]
 * [--topologies sparse,hub] [--samples 30] [--throttle 4] [--cli bin/anc.mjs]
 * [--seed 7] [--browser chromium|chrome|edge] [--device "Pixel 7"]
 * [--out <report.json>]`
 *
 * `hub` names this harness's workload and maps to the generator's `skewed`
 * topology; `sparse` is the generator's `sparse`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  benchmarkBrowserOptionsFromValues,
  parseBenchmarkOptions,
  resolveBenchmarkBrowser,
  type BenchmarkBrowser,
  type ResolvedBenchmarkBrowser,
} from './benchmark-browser.ts';
import {
  assertRepositoryIdentityClean,
  benchmarkReportDirectory,
  BenchmarkIdentityDriftError,
  repositoryIdentity,
  type RepositoryIdentity,
} from './benchmark-identity.ts';
import { hostIdentity, ROOT, scrub } from './benchmark-host.ts';
import {
  assertCandidateCliPath,
  assertCandidateIdentityStable,
  candidateIdentity,
  type CandidateIdentity,
} from './benchmark-candidate.ts';
import type { Topology } from './benchmark-corpus.ts';
import { round } from './benchmark-stats.ts';
import { WorkloadMeasurementError, type WorkloadReport } from './benchmark-workload-report.ts';
import { emptyWorkloadReport, measureWorkload, observedBrowserVersion } from './benchmark-workload.ts';

const BENCHMARK_SNAPSHOT_OPTIONS = [
  'sizes',
  'topologies',
  'samples',
  'throttle',
  'cli',
  'seed',
  'browser',
  'device',
  'out',
] as const;

export interface Options {
  sizes: number[];
  topologies: Topology[];
  samples: number;
  throttle: number;
  cli: string | undefined;
  seed: number;
  browser: BenchmarkBrowser;
  device: string | undefined;
  out: string | undefined;
}

export function parseSnapshotOptions(argv: readonly string[]): Options {
  const values = parseBenchmarkOptions(argv, BENCHMARK_SNAPSHOT_OPTIONS);
  const option = (name: string): string | undefined => values.get(name);
  const sizeTokens = (option('sizes') ?? '100,1000,10000').split(',').map((value) => value.trim());
  const sizes = sizeTokens.map(Number);
  if (sizeTokens.some((value) => value === '') || sizes.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('--sizes accepts only positive integers');
  }
  const requestedTopologies = (option('topologies') ?? 'sparse,hub').split(',').map((value) => value.trim());
  const topologies = requestedTopologies.filter(
    (value): value is Topology => value === 'sparse' || value === 'hub',
  );
  if (topologies.length !== requestedTopologies.length) {
    throw new Error('--topologies accepts only sparse and hub');
  }
  const samples = Number(option('samples') ?? '30');
  if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples needs a positive integer');
  const throttle = Number(option('throttle') ?? '4');
  if (!Number.isFinite(throttle) || throttle < 1) throw new Error('--throttle needs a number >= 1');
  const seed = Number(option('seed') ?? '7');
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const browserOptions = benchmarkBrowserOptionsFromValues(values);
  return {
    sizes,
    topologies,
    samples,
    throttle,
    cli: option('cli'),
    seed,
    ...browserOptions,
    out: option('out'),
  };
}

interface BenchmarkReport {
  kind: 'anc-snapshot-benchmark';
  goal: '0008-acceptable-browser-cost';
  note: string;
  generatedAt: string;
  instrument: {
    sources: RepositoryIdentity | null;
  };
  candidate: CandidateIdentity | null;
  host: {
    platform: string;
    osType: string;
    osRelease: string;
    arch: string;
    cpus: number;
    totalMemoryBytes: number;
  };
  browser: string | null;
  browserProfile: ResolvedBenchmarkBrowser['report'];
  viewport: { width: number; height: number };
  network: { origin: string; throttling: string };
  throttling: { cpuRate: number; label: string } | null;
  quantileMethod: 'nearest-rank';
  cacheDefinitions: string[];
  measurementSeam: { requested: string; observed: { sqlMs: boolean; phases: boolean } | null };
  workloads: WorkloadReport[];
  failures: string[];
  elapsedSeconds: number;
}

function kib(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? 'n/a' : `${(bytes / 1024).toFixed(1)}KiB`;
}

/** One line per workload on stdout: counts and durations only, never a path. */
function printWorkload(workload: WorkloadReport): void {
  const dependencies = workload.transfer?.dependencies ?? [];
  const snapshot = dependencies.find((dependency) => dependency.kind === 'snapshot');
  const cold = workload.preview?.cold.intentToVisibleMs ?? null;
  const warm = workload.preview?.warm.intentToVisibleMs ?? null;
  const local = workload.queries?.ui.localGraph;
  const driverLocal = workload.queries?.driver['localGraph'] ?? null;
  const readingDelta = workload.reading?.delta.transferredBytes ?? null;
  process.stdout.write(
    `${workload.id}: published=${workload.database?.notesPublished ?? 'n/a'} ` +
      `withheld=${workload.database?.notesWithheld ?? 'n/a'} ` +
      `nodes=${workload.database?.rows.nodes ?? 'n/a'} edges=${workload.database?.rows.edges ?? 'n/a'} ` +
      `db=${kib(snapshot?.decodedBytes)} gzip=${kib(snapshot?.gzipBytes)} ` +
      `build=${workload.build?.seconds ?? 'n/a'}s coldPreview=${cold ?? 'n/a'}ms warmPreview=${warm ?? 'n/a'}ms ` +
      `uiLocalGraph p50=${local?.dispatchSummary.p50 ?? 'n/a'}ms p95=${local?.dispatchSummary.p95 ?? 'n/a'}ms n=${local?.dispatchMs.length ?? 0} ` +
      `driverLocalGraph p50=${driverLocal?.dispatchSummary.p50 ?? 'n/a'}ms p95=${driverLocal?.dispatchSummary.p95 ?? 'n/a'}ms n=${driverLocal?.dispatchMs.length ?? 0} ` +
      `readingTransferDelta=${readingDelta ?? 'n/a'}B failures=${workload.failures.length}\n`,
  );
}

/** What the run has established so far; the report write reads it in `finally`. */
interface RunState {
  exitCode: number;
  identityFailureRecorded: boolean;
  expectedCandidate: CandidateIdentity | null;
  candidateCliPath: string | null;
}

function createSnapshotReport(options: Options, browserSettings: ResolvedBenchmarkBrowser): BenchmarkReport {
  return {
    kind: 'anc-snapshot-benchmark',
    goal: '0008-acceptable-browser-cost',
    note:
      'This is goal 0008’s measurement instrument, not the recorded maintainer decision. A named device field is Chrome-family mobile emulation, and null means no device profile was requested. Null runtime measurements are never invented zeros.',
    generatedAt: new Date().toISOString(),
    instrument: {
      sources: null,
    },
    candidate: null,
    host: hostIdentity(),
    browser: null,
    browserProfile: browserSettings.report,
    viewport: browserSettings.report.viewport,
    network: {
      origin: 'loopback static server',
      throttling: 'none; HTTP cache state and gzip negotiation are measured separately',
    },
    throttling:
      options.throttle > 1
        ? {
            cpuRate: options.throttle,
            label:
              'simulation (CDP Emulation.setCPUThrottlingRate on the page target only); device emulation does not emulate physical CPU hardware',
          }
        : null,
    quantileMethod: 'nearest-rank',
    cacheDefinitions: [
      'cold: fresh browser and fresh context for the workload, so the HTTP cache is empty when intent begins',
      'warm: the same ready Worker and imported snapshot within the same document',
      'each page gets its own Worker; the Worker is shared within one document across preview, tag, and graph consumers',
    ],
    measurementSeam: {
      requested:
        'armed requests carry measure: true; successful measured replies carry finite { dispatchMs, operationMs, sqlMs }; cold replies also carry complete phases = { totalMs, fetchMs, digestMs, wasmInitMs, importMs, wasmMemoryBytes }',
      observed: null,
    },
    workloads: [],
    failures: [],
    elapsedSeconds: 0,
  };
}

/** Identify the repository and candidate, refusing a dirty tree before any workload. */
function identifyCandidate(report: BenchmarkReport, options: Options, state: RunState): string {
  const cliPath = options.cli === undefined ? join(ROOT, 'bin', 'anc.mjs') : resolve(process.cwd(), options.cli);
  state.candidateCliPath = cliPath;
  assertCandidateCliPath(cliPath);
  const repository = repositoryIdentity(ROOT);
  report.instrument.sources = repository;
  state.expectedCandidate = candidateIdentity(cliPath, repository);
  report.candidate = state.expectedCandidate;
  assertRepositoryIdentityClean(repository);
  return cliPath;
}

/**
 * Measure one workload and record it. Returns `false` when an identity failure
 * means no later workload may run.
 */
async function runOneWorkload(
  report: BenchmarkReport,
  options: Options,
  browserSettings: ResolvedBenchmarkBrowser,
  cliPath: string,
  size: number,
  topology: Topology,
  state: RunState,
): Promise<boolean> {
  const expectedCandidate = state.expectedCandidate!;
  process.stdout.write(`benchmark ${size}/${topology}: generating and measuring\n`);
  try {
    const workload = await measureWorkload(options, browserSettings, cliPath, size, topology, expectedCandidate);
    try {
      assertCandidateIdentityStable(expectedCandidate, cliPath, `workload ${workload.id} after measurement`, 'state');
    } catch (error) {
      const message = scrub(error);
      workload.failures.push({ phase: 'identity', message });
      report.workloads.push(workload);
      report.failures.push(`${workload.id}: ${message}`);
      state.identityFailureRecorded = true;
      state.exitCode = 1;
      return false;
    }
    report.workloads.push(workload);
    if (workload.failures.length > 0) state.exitCode = 1;
    printWorkload(workload);
    return true;
  } catch (error) {
    const originalError = error instanceof WorkloadMeasurementError ? error.originalError : error;
    const failure: WorkloadReport =
      error instanceof WorkloadMeasurementError
        ? error.workload
        : {
            ...emptyWorkloadReport(options, size, topology),
            failures: [{ phase: 'workload', message: scrub(originalError) }],
          };
    report.workloads.push(failure);
    report.failures.push(`${failure.id}: ${scrub(originalError)}`);
    state.exitCode = 1;
    printWorkload(failure);
    if (originalError instanceof BenchmarkIdentityDriftError) {
      state.identityFailureRecorded = true;
      return false;
    }
    return true;
  }
}

async function runWorkloads(
  report: BenchmarkReport,
  options: Options,
  browserSettings: ResolvedBenchmarkBrowser,
  cliPath: string,
  state: RunState,
): Promise<void> {
  for (const size of options.sizes) {
    for (const topology of options.topologies) {
      if (!(await runOneWorkload(report, options, browserSettings, cliPath, size, topology, state))) return;
    }
  }
}

/** Close the report: elapsed time, observed seam, a last identity check, and the write. */
function writeSnapshotReport(report: BenchmarkReport, out: string, startedAt: number, state: RunState): void {
  report.elapsedSeconds = round((Date.now() - startedAt) / 1000, 2);
  report.browser = observedBrowserVersion();
  const workloads = report.workloads;
  report.measurementSeam.observed = {
    sqlMs: workloads.some((workload) => workload.queries?.seam.sqlMsObserved === true),
    phases: workloads.some((workload) => workload.queries?.seam.phasesObserved === true || workload.startup?.worker.phases !== null),
  };
  try {
    if (!state.identityFailureRecorded && state.expectedCandidate !== null) {
      try {
        if (state.candidateCliPath !== null) {
          assertCandidateIdentityStable(state.expectedCandidate, state.candidateCliPath, 'report write', 'state');
        }
      } catch (error) {
        report.failures.push(scrub(error));
        state.exitCode = 1;
      }
    }
    const body = `${JSON.stringify(report, null, 2)}\n`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body, 'utf8');
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 12);
    const failureCount = report.workloads.reduce((sum, workload) => sum + workload.failures.length, 0) + report.failures.length;
    console.log(`benchmark: ${report.workloads.length} workloads, ${failureCount} failures, report sha256=${digest}`);
  } catch (error) {
    process.stderr.write(`benchmark: report write failed: ${scrub(error)}\n`);
    state.exitCode = 1;
  }
}

async function main(): Promise<number> {
  const options = parseSnapshotOptions(process.argv.slice(2));
  const { devices } = await import('playwright');
  const browserSettings = resolveBenchmarkBrowser(options.browser, options.device, devices);
  const out =
    options.out ??
    join(benchmarkReportDirectory(ROOT), `benchmark-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const report = createSnapshotReport(options, browserSettings);
  const startedAt = Date.now();
  const state: RunState = { exitCode: 0, identityFailureRecorded: false, expectedCandidate: null, candidateCliPath: null };
  try {
    const cliPath = identifyCandidate(report, options, state);
    await runWorkloads(report, options, browserSettings, cliPath, state);
    assertCandidateIdentityStable(state.expectedCandidate!, cliPath, 'report finalization', 'full');
  } catch (error) {
    report.failures.push(scrub(error));
    if (error instanceof BenchmarkIdentityDriftError) state.identityFailureRecorded = true;
    state.exitCode = 1;
    process.stderr.write(`benchmark: ${scrub(error)}\n`);
  } finally {
    writeSnapshotReport(report, out, startedAt, state);
  }
  return state.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(scrub(error));
      process.exit(1);
    },
  );
}
