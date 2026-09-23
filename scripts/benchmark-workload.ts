/**
 * Measure one (size, topology) workload end to end.
 *
 * `measureWorkload` owns the workspace, the static server, the browser, and
 * the read-only DB handle, and releases them in a fixed order (DB, browser,
 * server, workspace) whatever happened. Each phase between those boundaries is
 * a named function with explicit inputs; a phase failure is recorded on the
 * workload and later phases still run, because a benchmark that stops at the
 * first timeout measures less than the one failure. The corpus directory is
 * removed in `finally`; the report keeps only its hash.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Browser, BrowserContext } from 'playwright';
import { SNAPSHOT_FILE_PATTERN } from '../src/lib/snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { sqliteAssetRequests, workerScriptPath } from '../tests/support/browser-site.ts';
import { generateCorpus } from './generate-corpus.ts';
import type { ResolvedBenchmarkBrowser } from './benchmark-browser.ts';
import { sha256File } from './benchmark-identity.ts';
import { registerScrubPath } from './benchmark-host.ts';
import { assertCandidateIdentityStable, type CandidateIdentity } from './benchmark-candidate.ts';
import { corpusTextStats, finalizeCorpus, generatorRequest, type Topology } from './benchmark-corpus.ts';
import { fixtureIdentity } from './benchmark-files.ts';
import { analyseDatabase, queryRows, type DatabaseAnalysis } from './benchmark-oracle.ts';
import { startStaticServer, type StaticServer } from './benchmark-server.ts';
import { dependencyFiles, dependencyTransferReports, type MeasuredDependency } from './benchmark-transfer.ts';
import {
  collectResources,
  installRecorder,
  navigationTiming,
  openMeasuredPage,
  sqliteAssetDefinition,
  urlPath,
  type ResourceEntry,
} from './benchmark-page.ts';
import { round } from './benchmark-stats.ts';
import {
  captureCleanupFailure,
  withFailure,
  WorkloadMeasurementError,
  type ReadingReport,
  type WorkloadReport,
} from './benchmark-workload-report.ts';
import {
  measureGlobalGraph,
  measureMainPage,
  measureTagBrowse,
  type MainPageHolder,
  type SecondaryPageInputs,
  type TagNode,
} from './benchmark-workload-ui.ts';
import { measureDriver } from './benchmark-workload-driver.ts';

const BUILD_TIMEOUT_MS = 20 * 60_000;

/** The subset of the CLI options one workload reads. */
export interface WorkloadOptions {
  samples: number;
  throttle: number;
  seed: number;
}

/** The browser version the workload runs observed; the report records one. */
let browserVersion: string | null = null;

export function observedBrowserVersion(): string | null {
  return browserVersion;
}

/** Everything `measureWorkload` must release, in release order. */
interface WorkloadResources {
  root: string | undefined;
  db: DatabaseSync | undefined;
  browser: Browser | undefined;
  server: StaticServer | undefined;
}

export function emptyWorkloadReport(options: Pick<WorkloadOptions, 'seed'>, size: number, topology: Topology): WorkloadReport {
  return {
    id: `${size}-${topology}`,
    size,
    topology,
    generator: {
      name: 'scripts/generate-corpus.ts#generateCorpus',
      seed: options.seed,
      options: generatorRequest(options, size, topology),
      result: null,
      finalized: null,
    },
    fixture: null,
    build: null,
    database: null,
    transfer: null,
    startup: null,
    preview: null,
    queries: null,
    reading: null,
    checks: [],
    failures: [],
    elapsedSeconds: 0,
  };
}

export async function measureWorkload(
  options: WorkloadOptions,
  browserSettings: ResolvedBenchmarkBrowser,
  cliPath: string,
  size: number,
  topology: Topology,
  expectedCandidate: CandidateIdentity,
): Promise<WorkloadReport> {
  const startedAt = Date.now();
  const workload = emptyWorkloadReport(options, size, topology);
  const resources: WorkloadResources = { root: undefined, db: undefined, browser: undefined, server: undefined };
  let escapedFailure: { error: unknown } | null = null;
  const cleanup = (phase: string, action: () => void | Promise<void>): Promise<void> =>
    captureCleanupFailure(workload.failures, phase, action);
  try {
    await runWorkloadPhases(workload, resources, options, browserSettings, cliPath, expectedCandidate, cleanup);
  } catch (error) {
    escapedFailure = { error };
  } finally {
    workload.elapsedSeconds = round((Date.now() - startedAt) / 1000, 2);
    await cleanup('cleanup-db', () => resources.db?.close());
    await cleanup('cleanup-browser', () => resources.browser?.close());
    await cleanup('cleanup-server', () => resources.server?.close());
    if (resources.root !== undefined) {
      const workspace = resources.root;
      await cleanup('cleanup-workspace', () =>
        rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
      );
    }
  }
  if (escapedFailure !== null) throw new WorkloadMeasurementError(workload, escapedFailure.error);
  return workload;
}

type Cleanup = (phase: string, action: () => void | Promise<void>) => Promise<void>;

/** The workload's phases in order; any throw escapes to `measureWorkload`. */
async function runWorkloadPhases(
  workload: WorkloadReport,
  resources: WorkloadResources,
  options: WorkloadOptions,
  browserSettings: ResolvedBenchmarkBrowser,
  cliPath: string,
  expectedCandidate: CandidateIdentity,
  cleanup: Cleanup,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `anc-bench-${workload.id}-`));
  resources.root = root;
  registerScrubPath(root);
  const corpusText = await prepareCorpus(workload, root);
  buildCandidate(workload, root, cliPath, expectedCandidate);
  const dist = join(root, 'dist');
  const { analysis, tagNodes } = analyseBuild(workload, resources, dist, corpusText);
  const db = resources.db!;
  const dependencies = measuredDependencies(dist, analysis.plan.pageSlug);
  const workerChunk = (() => {
    try {
      return workerScriptPath(dist);
    } catch {
      return null;
    }
  })();

  const server = await startStaticServer(dist);
  resources.server = server;
  const resourceEntries: ResourceEntry[] = [];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch(browserSettings.launchOptions);
  resources.browser = browser;
  browserVersion = browser.version();
  const pageUrl = `${server.origin}/notes/${analysis.plan.pageSlug}/`;

  // --- F. Ordinary reading: inactive first, in its own fresh context ---
  const reading = emptyReadingReport();
  workload.reading = reading;
  await measureInactiveReading(browser, browserSettings, options.throttle, pageUrl, reading, cleanup);

  const context = await browser.newContext(browserSettings.contextOptions);
  await installRecorder(context);
  try {
    await measureActiveReading(workload, context, options.throttle, pageUrl, reading, resourceEntries);

    const holder: MainPageHolder = { page: undefined };
    // --- B/C/D/E on the main page ---
    await withFailure(workload, 'preview-and-startup', () =>
      measureMainPage(
        workload,
        { context, throttle: options.throttle, samples: options.samples, pageUrl, db, analysis, reading },
        holder,
      ),
    );
    const secondary: SecondaryPageInputs = {
      context,
      throttle: options.throttle,
      origin: server.origin,
      analysis,
      tagNodes,
      resources: resourceEntries,
    };
    await withFailure(workload, 'ui-tag-browse', () => measureTagBrowse(workload, secondary));
    await withFailure(workload, 'ui-global-graph', () => measureGlobalGraph(workload, secondary));
    await withFailure(workload, 'driver', () =>
      measureDriver(workload, { page: holder.page, workerChunk, samples: options.samples, db, analysis, tagNodes }),
    );

    // Resource timings belong to the transfer evidence, so a driver failure
    // must not take them with it.
    await withFailure(workload, 'main-page-resources', async () => {
      if (holder.page !== undefined) await collectResources(holder.page, 'main-page', resourceEntries);
    });
    recordTransfer(workload, dependencies, server, resourceEntries);
  } finally {
    await cleanup('cleanup-context', () => context.close());
  }
}

/** Generate the seeded corpus, normalize publication, and identify the fixture. */
async function prepareCorpus(workload: WorkloadReport, root: string): Promise<ReturnType<typeof corpusTextStats>> {
  const contentDirectory = join(root, 'notes');
  mkdirSync(contentDirectory, { recursive: true });
  const generated = await generateCorpus(contentDirectory, workload.generator.options);
  workload.generator.result = {
    files: generated.files,
    published: generated.published,
    withheld: generated.withheld,
    assets: generated.assets,
    bytes: generated.bytes,
  };
  workload.generator.finalized = finalizeCorpus(contentDirectory, workload.size, workload.generator.result);
  workload.fixture = fixtureIdentity(contentDirectory);
  return corpusTextStats(contentDirectory);
}

/** Build the corpus with the candidate CLI, bracketed by candidate state checks. */
function buildCandidate(
  workload: WorkloadReport,
  root: string,
  cliPath: string,
  expectedCandidate: CandidateIdentity,
): void {
  assertCandidateIdentityStable(expectedCandidate, cliPath, `workload ${workload.id} before build`, 'state');
  const buildStarted = Date.now();
  const build = spawnSync(process.execPath, [cliPath, 'build', '--content', 'notes', '--out', 'dist'], {
    cwd: root,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  assertCandidateIdentityStable(expectedCandidate, cliPath, `workload ${workload.id} after build`, 'state');
  workload.build = {
    seconds: round((Date.now() - buildStarted) / 1000, 2),
    cli: { basename: basename(cliPath), sha256: sha256File(cliPath) },
  };
  if (build.status !== 0) {
    throw new Error(`build exited ${String(build.status)}: ${(build.stderr || build.stdout).slice(0, 4000)}`);
  }
}

/**
 * Open the one finalized snapshot read-only, analyse it, and read the busiest
 * tag's members. The handle is stored in `resources` as soon as it opens so a
 * later analysis failure still closes it.
 */
function analyseBuild(
  workload: WorkloadReport,
  resources: WorkloadResources,
  dist: string,
  corpusText: ReturnType<typeof corpusTextStats>,
): { analysis: DatabaseAnalysis; tagNodes: TagNode[] } {
  const dataDirectory = join(dist, 'data');
  const snapshots = existsSync(dataDirectory)
    ? readdirSync(dataDirectory).filter((name) => SNAPSHOT_FILE_PATTERN.test(name))
    : [];
  if (snapshots.length !== 1) throw new Error(`expected one finalized snapshot, found ${snapshots.length}`);
  const fileName = snapshots[0]!;
  const fileDigest = sha256File(join(dataDirectory, fileName));
  const db = new DatabaseSync(join(dataDirectory, fileName), { readOnly: true });
  resources.db = db;
  const finalized = workload.generator.finalized!.result;
  const analysis = analyseDatabase(db, fileName, fileDigest, corpusText, finalized);
  workload.database = analysis.identity;
  if (!analysis.identity.digestMatchesFileName) {
    workload.failures.push({ phase: 'database', message: 'snapshot file name digest does not match its bytes' });
  }
  if (finalized.published !== analysis.identity.rows.nodes) {
    workload.failures.push({
      phase: 'database',
      message: `finalized corpus published ${finalized.published}, DB nodes ${analysis.identity.rows.nodes}`,
    });
  }
  if (workload.size !== analysis.identity.rows.nodes) {
    workload.failures.push({
      phase: 'database',
      message: `requested ${workload.size} published notes, DB nodes ${analysis.identity.rows.nodes}`,
    });
  }
  const plan = analysis.plan;
  const tagNodes =
    plan.tagKey === null
      ? []
      : queryRows<TagNode>(
          db,
          `SELECT n.slug AS slug, n.title AS title, n.language AS language
             FROM tags AS t
             JOIN node_tags AS nt ON nt.tag_id = t.id
             JOIN nodes AS n ON n.id = nt.node_id
             WHERE t.key = ?
             ORDER BY n.slug`,
          [plan.tagKey],
        );
  return { analysis, tagNodes };
}

function measuredDependencies(dist: string, pageSlug: string): MeasuredDependency[] {
  return dependencyFiles(dist, join(dist, 'notes', pageSlug, 'index.html')).map((dependency) => {
    const bytes = readFileSync(dependency.file);
    return { ...dependency, decodedBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
  });
}

function emptyReadingReport(): ReadingReport {
  return {
    definition: sqliteAssetDefinition(),
    zeroRequests: {
      readingPage: { beforeIntent: false, urls: [] },
      mainPage: { beforeIntent: false, urls: [] },
    },
    active: null,
    inactiveJavaScript: null,
    delta: {
      domContentLoadedEventEnd: null,
      loadEventEnd: null,
      firstContentfulPaint: null,
      transferredBytes: null,
    },
    regressionNote:
      'positive delta = the enhancement build renders later than the no-JS build under the same host, viewport, and throttle; the enhancements are lazy by contract, so a material positive delta implicates script download/evaluation rather than SQLite work',
  };
}

/** The no-JavaScript render of the reading page, in its own fresh context. */
async function measureInactiveReading(
  browser: Browser,
  browserSettings: ResolvedBenchmarkBrowser,
  throttle: number,
  pageUrl: string,
  reading: ReadingReport,
  cleanup: Cleanup,
): Promise<void> {
  const inactiveContext = await browser.newContext({
    ...browserSettings.contextOptions,
    javaScriptEnabled: false,
  });
  try {
    const { page } = await openMeasuredPage(inactiveContext, throttle);
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    reading.inactiveJavaScript = await navigationTiming(page);
  } finally {
    await cleanup('cleanup-inactive-context', () => inactiveContext.close());
  }
}

/**
 * Active initial render, no intent of any kind, under the same throttle as the
 * inactive measurement so the delta is one variable.
 */
async function measureActiveReading(
  workload: WorkloadReport,
  context: BrowserContext,
  throttle: number,
  pageUrl: string,
  reading: ReadingReport,
  resources: ResourceEntry[],
): Promise<void> {
  const { page: readingPage } = await openMeasuredPage(context, throttle);
  const readingRequests = sqliteAssetRequests(readingPage);
  await readingPage.goto(pageUrl, { waitUntil: 'load' });
  await readingPage.waitForTimeout(300);
  await readingPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await readingPage.waitForTimeout(300);
  reading.active = await navigationTiming(readingPage);
  reading.zeroRequests.readingPage = {
    beforeIntent: readingRequests.length === 0,
    urls: readingRequests.map(urlPath),
  };
  const delta = (active: number | null, inactive: number | null): number | null =>
    active === null || inactive === null ? null : round(active - inactive, 3);
  reading.delta = {
    domContentLoadedEventEnd: delta(reading.active.domContentLoadedEventEnd, reading.inactiveJavaScript?.domContentLoadedEventEnd ?? null),
    loadEventEnd: delta(reading.active.loadEventEnd, reading.inactiveJavaScript?.loadEventEnd ?? null),
    firstContentfulPaint: delta(reading.active.firstContentfulPaint, reading.inactiveJavaScript?.firstContentfulPaint ?? null),
    transferredBytes: delta(reading.active.transferredBytes, reading.inactiveJavaScript?.transferredBytes ?? null),
  };
  if (readingRequests.length > 0) {
    workload.failures.push({
      phase: 'ordinary-reading',
      message: `reading page requested SQLite assets before intent: ${readingRequests.map(urlPath).join(', ')}`,
    });
  }
  await collectResources(readingPage, 'reading-page', resources);
  await readingPage.close();
}

function recordTransfer(
  workload: WorkloadReport,
  dependencies: readonly MeasuredDependency[],
  server: StaticServer,
  resources: ResourceEntry[],
): void {
  const transferEvidence = dependencyTransferReports(dependencies, server.records, resources);
  for (const message of transferEvidence.failures) workload.failures.push({ phase: 'transfer', message });
  workload.transfer = {
    headersSource: server.headersSource,
    definitions: [
      'fresh browser + context per workload: empty HTTP cache at every cold measurement',
      'the page Worker is shared within the document for preview, graph, and tag consumers; each document gets its own Worker, so a first UI operation on a later page includes that Worker’s cold start',
      'cacheState network = a 200 the server wrote to the wire; revalidated = a 304; cache = a resource-timing transferSize of 0 with decoded bytes',
      'dependency `resource` is the cold observation whose transferSize includes the encoded body; Chromium reports a cache hit as a header-only transferSize, and those observations are counted in cacheHitObservations',
    ],
    dependencies: transferEvidence.dependencies,
    serverRecords: server.records,
    resources,
  };
}
