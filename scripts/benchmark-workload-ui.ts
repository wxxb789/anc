/**
 * The real-UI phases of one workload: the main page's cold and warm hover
 * preview with heap polling, repeated local-graph activation, the tag browser,
 * and the site graph. Each phase reads DB-derived expectations from the
 * oracle and records its evidence on the workload report.
 */

import type { BrowserContext, CDPSession, Page } from 'playwright';
import { TAG_PAGE_SIZE } from '../src/lib/tag-browser-model.ts';
import type { DatabaseSync } from '../src/lib/sqlite.ts';
import { previewFragment, previewTitle } from '../src/lib/preview-model.ts';
import { sqliteAssetRequests } from '../tests/support/browser-site.ts';
import { scrub } from './benchmark-host.ts';
import {
  compareRenderedPreview,
  compareRenderedSelection,
  graphOracleSelection,
  queryRows,
  tagIdentityFailure,
  type DatabaseAnalysis,
  type RenderedPreviewShape,
  type RenderedSelectionShape,
  type WorkloadPlan,
} from './benchmark-oracle.ts';
import {
  collectResources,
  firstEligibleLink,
  measuredEventFailure,
  normalizePhases,
  openMeasuredPage,
  readRecorder,
  readRenderedGraph,
  readRenderedNotes,
  readRenderedPreview,
  readSnapshotEvents,
  startHeapPolling,
  urlPath,
  type ResourceEntry,
  type SnapshotEvent,
  type WorkerPhases,
} from './benchmark-page.ts';
import { tagWalkPageBound } from './benchmark-driver.ts';
import {
  assertExactEventCount,
  assertExactSampleCount,
  assertExactlyOneControl,
  round,
  seriesOf,
} from './benchmark-stats.ts';
import {
  emptyPreviewSample,
  withFailure,
  type PreviewSample,
  type ReadingReport,
  type StartupReport,
  type TagBrowseReport,
  type WorkloadReport,
} from './benchmark-workload-report.ts';

const HOVER_TIMEOUT_MS = 30_000;
const WARM_PREVIEW_TIMEOUT_MS = 15_000;
const STEADY_SETTLE_MS = 1_000;

export type TagNode = { slug: string; title: string; language: string };

/** Where the measured main page is kept once opened, even if a later step fails. */
export interface MainPageHolder {
  page: Page | undefined;
}

// --- Main page: startup, cold/warm preview, local graph -------------------------

function emptyStartupReport(): StartupReport {
  return {
    instrument:
      'CDP Performance.getMetrics on the page target: JSHeapUsedSize (main-thread JS heap) and ArrayBufferBytes when the browser reports it',
    blindSpots: [
      'main-thread JS heap only; not process RSS, not the Worker heap, not WASM linear memory',
      'the Worker target is not surfaced by Performance.getMetrics on the page session, so its heap and WASM memory are only visible through the runtime seam (phases.wasmMemoryBytes)',
      'CPU throttling (CDP Emulation.setCPUThrottlingRate) applies to the page target; the Worker target is not independently throttled, so this is simulation, never a physical device',
    ],
    heap: null,
    heapPeakNote: 'peak over the cold-intent polling window; steady is the last sample after the settle',
    worker: {
      firstReplyMs: null,
      phases: null,
      phasesNote: null,
      wasmMemoryBytes: null,
    },
  };
}

function emptyQueriesReport(): NonNullable<WorkloadReport['queries']> {
  return {
    definitions: [
      'dispatch→result: armed request posted to observed successful snapshot-result on the page clock (event.ms)',
      'operationMs: the Worker reply’s own named-operation span after initialization',
      'sqlMs: required finite inner-SQL telemetry on every successful measured reply; cold replies also require complete phases',
      'graph render: the graph client’s graph-render event, reported apart from query and messaging cost',
    ],
    ui: { localGraph: null, tagBrowse: null, globalGraph: null },
    driver: {},
    driverColdStart: null,
    seam: { sqlMsObserved: false, phasesObserved: false },
  };
}

export interface MainPageInputs {
  context: BrowserContext;
  throttle: number;
  samples: number;
  pageUrl: string;
  db: DatabaseSync;
  analysis: DatabaseAnalysis;
  reading: ReadingReport;
}

/**
 * B/C/D/E on the main page: startup heap, cold and warm preview, then the
 * local graph. The opened page is stored in `holder` before navigation so the
 * driver and resource phases can still use it after a later failure here.
 */
export async function measureMainPage(
  workload: WorkloadReport,
  inputs: MainPageInputs,
  holder: MainPageHolder,
): Promise<void> {
  const { page, session } = await openMeasuredPage(inputs.context, inputs.throttle);
  holder.page = page;
  await session.send('Performance.enable');
  const pageRequests = sqliteAssetRequests(page);
  const startup = emptyStartupReport();
  workload.startup = startup;

  await page.goto(inputs.pageUrl, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  inputs.reading.zeroRequests.mainPage = {
    beforeIntent: pageRequests.length === 0,
    urls: pageRequests.map(urlPath),
  };
  if (pageRequests.length > 0) {
    workload.failures.push({
      phase: 'ordinary-reading',
      message: `main page requested SQLite assets before intent: ${pageRequests.map(urlPath).join(', ')}`,
    });
  }

  workload.preview = { targetFromDb: null, cold: emptyPreviewSample(), warm: emptyPreviewSample() };
  workload.queries = emptyQueriesReport();
  await withFailure(workload, 'cold-warm-preview', () =>
    measurePreview(workload, page, session, inputs.db, inputs.pageUrl, startup),
  );

  // --- E(1) real UI flow: repeated local-graph activation ---
  await withFailure(workload, 'ui-local-graph', () =>
    measureUiLocalGraph(workload, page, inputs.samples, inputs.analysis),
  );
}

interface PreviewTarget {
  href: string;
  slug: string;
  title: string;
  expected: RenderedPreviewShape;
}

/** The marked link and the exact panel the DB says its preview must render. */
async function previewTarget(page: Page, db: DatabaseSync, pageUrl: string): Promise<PreviewTarget> {
  const target = await firstEligibleLink(page);
  if (target === null) throw new Error('no eligible published note link on the measured page');
  const previewNode = queryRows<{ id: number; title: string; excerpt: string; language: string }>(
    db,
    'SELECT id, title, excerpt, language FROM nodes WHERE slug = ?',
    [target.slug],
  )[0];
  if (previewNode === undefined) throw new Error(`preview target is absent from the DB: ${target.slug}`);
  const previewAliases = queryRows<{ alias: string }>(
    db,
    'SELECT alias FROM aliases WHERE node_id = ? ORDER BY ordinal',
    [previewNode.id],
  ).map((row) => row.alias);
  return {
    href: target.href,
    slug: target.slug,
    title: previewNode.title,
    expected: {
      title: previewTitle({ title: previewNode.title, excerpt: previewNode.excerpt, aliases: previewAliases }),
      excerpt: previewNode.excerpt,
      fragment: previewFragment(new URL(target.href, pageUrl).hash) ?? null,
      titleLanguage: previewNode.language,
      excerptLanguage: previewNode.language,
    },
  };
}

async function measurePreview(
  workload: WorkloadReport,
  page: Page,
  session: CDPSession,
  db: DatabaseSync,
  pageUrl: string,
  startup: StartupReport,
): Promise<void> {
  const target = await previewTarget(page, db, pageUrl);
  const coldSample = await measureColdPreview(workload, page, session, target, startup);
  const warmSample = await measureWarmPreview(workload, page, target);
  workload.preview = { targetFromDb: null, cold: coldSample, warm: warmSample };
}

/**
 * The first hover on a fresh document, with heap polling across the intent.
 * A heap-polling failure escapes to the enclosing phase, as it always has.
 */
async function measureColdPreview(
  workload: WorkloadReport,
  page: Page,
  session: CDPSession,
  target: PreviewTarget,
  startup: StartupReport,
): Promise<PreviewSample> {
  const polling = startHeapPolling(session);
  let coldSample = emptyPreviewSample();
  try {
    const coldStarted = Date.now();
    await page.locator('[data-bench-target-link]').hover();
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: HOVER_TIMEOUT_MS });
    coldSample.intentToVisibleMs = Date.now() - coldStarted;
    const coldRecorder = await readRecorder(page);
    const coldVisible = coldRecorder.preview.filter((observation) => observation.visibleAt !== null).at(-1) ?? null;
    if (coldVisible === null || coldVisible.slug !== target.slug) {
      throw new Error('the cold hover did not produce an observed preview for the marked link');
    }
    const coldMismatch = compareRenderedPreview(await readRenderedPreview(page), target.expected, 'cold preview');
    if (coldMismatch !== null) throw new Error(coldMismatch);
    const coldText = coldVisible.text ?? '';
    coldSample = {
      ...coldSample,
      hoverDelayMs: round(coldVisible.visibleAt! - coldVisible.intentAt, 3),
      visible: true,
      nonEmpty: coldText.trim() !== '',
      targetSlug: coldVisible.slug,
      targetTitle: target.title,
      titleMatched: true,
      panelTextSample: coldText.slice(0, 200),
    };
    const coldReplies = coldRecorder.snapshot.filter((event) => event.type === 'preview');
    const firstReply = coldReplies.at(-1) ?? null;
    if (firstReply === null) throw new Error('cold preview produced no measured preview reply');
    const telemetryFailure = measuredEventFailure('cold preview', firstReply, true);
    if (telemetryFailure !== null) throw new Error(telemetryFailure);
    startup.worker.firstReplyMs = firstReply.ms;
    startup.worker.phases = normalizePhases(firstReply.phases);
    startup.worker.wasmMemoryBytes = startup.worker.phases?.wasmMemoryBytes ?? null;
    startup.worker.phasesNote = 'phases from the first armed snapshot-result detail';
  } catch (error) {
    coldSample.error = scrub(error);
    workload.failures.push({ phase: 'preview-cold', message: coldSample.error });
    startup.worker.phasesNote ??= 'the cold preview failed before any measured reply was observed';
  } finally {
    await page.waitForTimeout(STEADY_SETTLE_MS);
    startup.heap = await polling.stop();
  }
  return coldSample;
}

/** The same link after readiness: hide the cold panel, then hover again. */
async function measureWarmPreview(workload: WorkloadReport, page: Page, target: PreviewTarget): Promise<PreviewSample> {
  const warmSample = emptyPreviewSample();
  try {
    const panel = page.locator('#link-preview');
    if (!(await panel.isVisible())) throw new Error('the warm hover did not start from a visible cold panel');
    await page.mouse.move(0, 0);
    await panel.waitFor({ state: 'hidden', timeout: 5_000 });
    const hiddenRecorder = await readRecorder(page);
    const hiddenPreviewCount = hiddenRecorder.preview.length;
    await page.waitForTimeout(200);
    const warmStarted = Date.now();
    await page.locator('[data-bench-target-link]').hover();
    await panel.waitFor({ state: 'visible', timeout: WARM_PREVIEW_TIMEOUT_MS });
    warmSample.intentToVisibleMs = Date.now() - warmStarted;
    const warmRecorder = await readRecorder(page);
    const warmReplies = warmRecorder.snapshot
      .slice(hiddenRecorder.snapshot.length)
      .filter((event) => event.type === 'preview');
    const warmReply = warmReplies.at(-1) ?? null;
    if (warmReply === null) throw new Error('warm preview produced no measured preview reply');
    const telemetryFailure = measuredEventFailure('warm preview', warmReply);
    if (telemetryFailure !== null) throw new Error(telemetryFailure);
    const warmVisible =
      warmRecorder.preview
        .slice(hiddenPreviewCount)
        .filter((observation) => observation.visibleAt !== null && observation.slug === target.slug)
        .at(-1) ?? null;
    if (warmVisible === null) {
      throw new Error(`the warm hover produced no fresh observed preview for ${target.slug}`);
    }
    const warmMismatch = compareRenderedPreview(await readRenderedPreview(page), target.expected, 'warm preview');
    if (warmMismatch !== null) throw new Error(warmMismatch);
    warmSample.hoverDelayMs = round(warmVisible.visibleAt! - warmVisible.intentAt, 3);
    warmSample.visible = true;
    warmSample.nonEmpty = (warmVisible.text ?? '').trim() !== '';
    warmSample.targetSlug = warmVisible.slug;
    warmSample.targetTitle = target.title;
    warmSample.titleMatched = true;
    warmSample.panelTextSample = (warmVisible.text ?? '').slice(0, 200);
  } catch (error) {
    warmSample.error = scrub(error);
    workload.failures.push({ phase: 'preview-warm', message: warmSample.error });
  }
  return warmSample;
}

function localGraphRenderCount(page: Page, expected: number, timeout: number): Promise<unknown> {
  return page.waitForFunction(
    (count) =>
      ((window as unknown as { __benchGraphRender?: { scope: string }[] }).__benchGraphRender ?? []).filter(
        (event) => event.scope === 'local',
      ).length >= count,
    expected,
    { timeout },
  );
}

/** The DB-derived local selection as the rendered table lists it: center first. */
function expectedLocalRendering(analysis: DatabaseAnalysis): RenderedSelectionShape {
  const plan = analysis.plan;
  const localOracle = graphOracleSelection(analysis.nodes, analysis.edges, {
    scope: 'local',
    centerSlug: plan.localCenter,
  });
  const localCenterNode = analysis.nodes.find((node) => node.slug === localOracle.center);
  if (localCenterNode === undefined) throw new Error(`local graph center is absent from the DB: ${plan.localCenter}`);
  return {
    nodes: [
      {
        slug: localCenterNode.slug,
        title: localCenterNode.title,
        language: localCenterNode.language ?? '',
      },
      ...localOracle.selection.nodes,
    ],
    edges: localOracle.selection.edges,
  };
}

async function measureUiLocalGraph(
  workload: WorkloadReport,
  page: Page,
  samples: number,
  analysis: DatabaseAnalysis,
): Promise<void> {
  const localGraph = {
    activations: 0,
    dispatchMs: [] as number[],
    operationMs: [] as number[],
    sqlMs: [] as number[],
    phases: null as WorkerPhases | null,
    renderMs: [] as number[],
    dispatchSummary: seriesOf([]),
  };
  const activate = page.locator('[data-graph-activate]');
  const activationCount = await activate.count();
  assertExactlyOneControl('local graph activation control', activationCount);
  const expectedRenderedLocal = expectedLocalRendering(analysis);
  for (let index = 0; index < samples; index += 1) {
    try {
      await activate.click();
      await page.waitForFunction(
        (expected) =>
          ((window as unknown as { __benchSnapshot?: { type: string; ms: number | null }[] }).__benchSnapshot ?? [])
            .filter((event) => event.type === 'localGraph' && event.ms !== null).length >= expected,
        index + 1,
        { timeout: 15_000 },
      );
      await localGraphRenderCount(page, index + 1, 5_000);
      const mismatch = compareRenderedSelection(
        await readRenderedGraph(page),
        expectedRenderedLocal,
        `local graph sample ${index + 1}`,
      );
      if (mismatch !== null) throw new Error(mismatch);
      localGraph.activations += 1;
    } catch (error) {
      workload.failures.push({
        phase: 'ui-local-graph',
        message: `activation ${index + 1} failed: ${scrub(error)}`,
      });
      break;
    }
  }
  // A render follows its reply; wait with a bound for the drawings to
  // catch up rather than reading early and dropping the slowest draw.
  await localGraphRenderCount(page, localGraph.activations, 5_000);
  const events = await readRecorder(page);
  const localReplies = events.snapshot.filter((entry) => entry.type === 'localGraph');
  assertExactEventCount('local graph snapshot replies', localReplies.length, localGraph.activations);
  const localRenders = events.graphRender.filter((event) => event.scope === 'local');
  assertExactEventCount('local graph render', localRenders.length, localGraph.activations);
  if (localRenders.some((event) => event.ms === null || !Number.isFinite(event.ms))) {
    throw new Error('local graph render series contains a missing duration');
  }
  for (const [index, event] of localReplies.entries()) {
    const telemetryFailure = measuredEventFailure(`local graph sample ${index + 1}`, event);
    if (telemetryFailure !== null) throw new Error(telemetryFailure);
    localGraph.dispatchMs.push(round(event.ms!, 3));
    localGraph.operationMs.push(round(event.operationMs!, 3));
    localGraph.sqlMs.push(round(event.sqlMs!, 3));
    if (localGraph.phases === null && event.phases !== null) localGraph.phases = normalizePhases(event.phases);
  }
  assertExactSampleCount('local graph dispatch samples', localGraph.dispatchMs.length, localReplies.length);
  assertExactSampleCount('local graph operation samples', localGraph.operationMs.length, localReplies.length);
  assertExactSampleCount('local graph SQL samples', localGraph.sqlMs.length, localReplies.length);
  localGraph.renderMs = localRenders.map((event) => round(event.ms!, 3));
  localGraph.dispatchSummary = seriesOf(localGraph.dispatchMs);
  workload.queries!.ui.localGraph = localGraph.activations === 0 && localGraph.dispatchMs.length === 0 ? null : localGraph;
  workload.queries!.seam = {
    sqlMsObserved: localGraph.sqlMs.length > 0,
    phasesObserved: localGraph.phases !== null,
  };
}

// --- Tag browser ------------------------------------------------------------------

export interface SecondaryPageInputs {
  context: BrowserContext;
  throttle: number;
  origin: string;
  analysis: DatabaseAnalysis;
  tagNodes: readonly TagNode[];
  resources: ResourceEntry[];
}

/**
 * Accumulates `byTag` telemetry from a page's recorder. A page's recorder keeps
 * every reply; each read absorbs only the events that arrived since the last
 * one, or a ten-page walk would re-record page one ten times and report its
 * duration as a trend.
 */
class TagTelemetry {
  readonly dispatchMs: number[] = [];
  readonly operationMs: number[] = [];
  readonly sqlMs: number[] = [];
  phases: WorkerPhases | null = null;
  absorbed = 0;
  byTagTotal = 0;

  absorb(batch: { events: SnapshotEvent[]; total: number }): void {
    for (const event of batch.events) {
      if (event.type !== 'byTag') continue;
      this.byTagTotal += 1;
      const telemetryFailure = measuredEventFailure(`tag browser sample ${this.byTagTotal}`, event, this.byTagTotal === 1);
      if (telemetryFailure !== null) throw new Error(telemetryFailure);
      this.dispatchMs.push(round(event.ms!, 3));
      this.operationMs.push(round(event.operationMs!, 3));
      this.sqlMs.push(round(event.sqlMs!, 3));
      if (this.phases === null && event.phases !== null) this.phases = normalizePhases(event.phases);
    }
    this.absorbed = batch.total;
  }
}

/** The rendered tag identity and the first `pageCount` pages of DB members. */
async function assertRenderedTagPage(
  page: Page,
  plan: WorkloadPlan,
  tagNodes: readonly TagNode[],
  pageCount: number,
): Promise<void> {
  const identity = await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('#tag-browser-select');
    const current = document.querySelector<HTMLElement>('#tag-browser-current');
    return select === null || current === null || current.hidden
      ? null
      : { key: select.value, label: current.textContent ?? '' };
  });
  const identityMismatch = tagIdentityFailure(
    identity,
    { key: plan.tagKey!, label: plan.tagLabel! },
    `tag browser page ${pageCount}`,
  );
  if (identityMismatch !== null) throw new Error(identityMismatch);
  const expected = tagNodes.slice(0, Math.min(pageCount * TAG_PAGE_SIZE, tagNodes.length));
  await page.waitForFunction(
    (count) => document.querySelectorAll('#tag-browser-results li > a[href]').length >= count,
    expected.length,
    { timeout: 15_000 },
  );
  const mismatch = compareRenderedSelection(
    { nodes: await readRenderedNotes(page, '#tag-browser-results li > a[href]'), edges: [] },
    { nodes: [...expected], edges: [] },
    `tag browser ${plan.tagKey} page ${pageCount}`,
  );
  if (mismatch !== null) throw new Error(mismatch);
}

/** Select the busiest tag and follow More until the membership is enumerated. */
async function browseTag(page: Page, plan: WorkloadPlan, tagNodes: readonly TagNode[]): Promise<TagBrowseReport> {
  const telemetry = new TagTelemetry();
  await page.selectOption('#tag-browser-select', plan.tagKey!);
  await page.waitForFunction(
    () =>
      ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).some(
        (event) => event.type === 'byTag',
      ),
    undefined,
    { timeout: 30_000 },
  );
  telemetry.absorb(await readSnapshotEvents(page, telemetry.absorbed));
  await assertRenderedTagPage(page, plan, tagNodes, 1);
  const tagPageBound = tagWalkPageBound(plan.tagMembers, TAG_PAGE_SIZE);
  const more = page.locator('#tag-browse-more');
  let pages = 1;
  while (await more.isVisible()) {
    if (pages >= tagPageBound) {
      throw new Error(`tag walk exposed More after the derived ${tagPageBound}-page bound for ${plan.tagMembers} members`);
    }
    await more.click();
    await page.waitForFunction(
      (count) => ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).length > count,
      telemetry.absorbed,
      { timeout: 15_000 },
    );
    telemetry.absorb(await readSnapshotEvents(page, telemetry.absorbed));
    pages += 1;
    await assertRenderedTagPage(page, plan, tagNodes, pages);
  }
  const notesShown = await page.locator('#tag-browser-results li').count();
  assertExactEventCount('tag browser page replies', telemetry.byTagTotal, pages);
  if (pages > tagPageBound) {
    throw new Error(`tag browser walked ${pages} pages beyond derived bound ${tagPageBound}`);
  }
  if (notesShown !== plan.tagMembers) {
    throw new Error(`tag browser showed ${notesShown} notes; DB plan requires ${plan.tagMembers}`);
  }
  if (await more.isVisible()) throw new Error('tag browser More control remained visible after enumeration');
  assertExactSampleCount('tag browser dispatch samples', telemetry.dispatchMs.length, telemetry.byTagTotal);
  assertExactSampleCount('tag browser operation samples', telemetry.operationMs.length, telemetry.byTagTotal);
  assertExactSampleCount('tag browser SQL samples', telemetry.sqlMs.length, telemetry.byTagTotal);
  return {
    tagKey: plan.tagKey!,
    pages,
    notesShown,
    dispatchMs: telemetry.dispatchMs,
    operationMs: telemetry.operationMs,
    sqlMs: telemetry.sqlMs,
    phases: telemetry.phases,
    dispatchSummary: seriesOf(telemetry.dispatchMs),
  };
}

/** E(1) real UI flow: the tag browser on its own page. */
export async function measureTagBrowse(workload: WorkloadReport, inputs: SecondaryPageInputs): Promise<void> {
  const plan = inputs.analysis.plan;
  if (plan.tagKey === null || plan.tagLabel === null || workload.queries === null) {
    throw new Error('the corpus has no tag to browse');
  }
  const { page } = await openMeasuredPage(inputs.context, inputs.throttle);
  try {
    await page.goto(`${inputs.origin}/tags/`, { waitUntil: 'load' });
    await page.waitForSelector('#tag-browser-select', { timeout: 15_000 });
    workload.queries!.ui.tagBrowse = await browseTag(page, plan, inputs.tagNodes);
    await collectResources(page, 'ui-tag-browse', inputs.resources);
  } finally {
    await page.close();
  }
}

// --- Site graph -------------------------------------------------------------------

async function waitForGlobalGraph(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(
    (count) =>
      ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).filter(
        (event) => event.type === 'globalGraph',
      ).length >= count,
    expected,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    (count) =>
      ((window as unknown as { __benchGraphRender?: { scope: string }[] }).__benchGraphRender ?? []).filter(
        (event) => event.scope === 'global',
      ).length >= count,
    expected,
    { timeout: 5_000 },
  );
}

/** Draw the unfiltered site graph, then the busiest tag's, against the oracle. */
async function driveGlobalGraph(page: Page, inputs: SecondaryPageInputs): Promise<void> {
  const { analysis, tagNodes } = inputs;
  const plan = analysis.plan;
  const activate = page.locator('[data-graph-activate]');
  if ((await activate.count()) === 0) throw new Error('the site graph exposes no activation control');
  await activate.click();
  await waitForGlobalGraph(page, 1);
  const globalOracle = graphOracleSelection(analysis.nodes, analysis.edges, { scope: 'global' });
  const globalMismatch = compareRenderedSelection(await readRenderedGraph(page), globalOracle.selection, 'global graph UI');
  if (globalMismatch !== null) throw new Error(globalMismatch);
  if (plan.tagKey !== null) {
    await page.selectOption('[data-graph-tag]', plan.tagKey);
    await waitForGlobalGraph(page, 2);
    const filteredOracle = graphOracleSelection(analysis.nodes, analysis.edges, {
      scope: 'global',
      candidateSlugs: new Set(tagNodes.map((node) => node.slug)),
    });
    const filteredMismatch = compareRenderedSelection(
      await readRenderedGraph(page),
      filteredOracle.selection,
      `global graph UI (${plan.tagKey})`,
    );
    if (filteredMismatch !== null) throw new Error(filteredMismatch);
  }
}

/** E(1) real UI flow: the site graph, unfiltered then tag-filtered. */
export async function measureGlobalGraph(workload: WorkloadReport, inputs: SecondaryPageInputs): Promise<void> {
  if (workload.queries === null) throw new Error('query report was not initialized');
  const plan = inputs.analysis.plan;
  const { page } = await openMeasuredPage(inputs.context, inputs.throttle);
  try {
    await page.goto(`${inputs.origin}/graph/`, { waitUntil: 'load' });
    await driveGlobalGraph(page, inputs);
    const expectedGlobalReplies = plan.tagKey === null ? 1 : 2;
    const events = await readRecorder(page);
    const globals = events.snapshot.filter((event) => event.type === 'globalGraph');
    assertExactEventCount('global graph snapshot replies', globals.length, expectedGlobalReplies);
    for (const [index, event] of globals.entries()) {
      const telemetryFailure = measuredEventFailure(`global graph sample ${index + 1}`, event, index === 0);
      if (telemetryFailure !== null) throw new Error(telemetryFailure);
    }
    const globalRenders = events.graphRender.filter((event) => event.scope === 'global');
    assertExactEventCount('global graph render', globalRenders.length, expectedGlobalReplies);
    if (globalRenders.some((event) => event.ms === null || !Number.isFinite(event.ms))) {
      throw new Error('global graph render series contains a missing duration');
    }
    const globalDispatchMs = globals.map((event) => round(event.ms!, 3));
    const globalOperationMs = globals.map((event) => round(event.operationMs!, 3));
    assertExactSampleCount('global graph dispatch samples', globalDispatchMs.length, globals.length);
    assertExactSampleCount('global graph operation samples', globalOperationMs.length, globals.length);
    workload.queries!.ui.globalGraph = {
      unfilteredMs: globalDispatchMs.slice(0, 1),
      filteredMs: globalDispatchMs.slice(1),
      operationMs: globalOperationMs,
      renderMs: globalRenders.map((event) => round(event.ms!, 3)),
      phases: globals.find((event) => event.phases !== null)?.phases ?? null,
      filteredTag: plan.tagKey,
    };
    await collectResources(page, 'ui-global-graph', inputs.resources);
  } finally {
    await page.close();
  }
}
