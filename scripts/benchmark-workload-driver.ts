/**
 * The driver-Worker phase of one workload: armed named operations and cursor
 * walks against a second Worker built from the shipped chunk, followed by the
 * structural invariants and DB spot-checks those replies must satisfy.
 */

import type { Page } from 'playwright';
import { GLOBAL_NODE_LIMIT, LOCAL_NODE_LIMIT } from '../src/lib/graph-selection.ts';
import { MAX_PAGE_SIZE } from '../src/lib/snapshot-queries.ts';
import type { DatabaseSync } from '../src/lib/sqlite.ts';
import { scrub } from './benchmark-host.ts';
import {
  compareGraphSelection,
  compareRenderedSelection,
  graphOracleSelection,
  queryRows,
  queryValue,
  tagIdentityFailure,
  type DatabaseAnalysis,
  type GraphSelectionShape,
} from './benchmark-oracle.ts';
import { normalizePhases } from './benchmark-page.ts';
import {
  absorbTiming,
  driveWalk,
  driverRequest,
  DRIVER_COLD_TIMEOUT_MS,
  DRIVER_WARM_TIMEOUT_MS,
  finalizeTiming,
  installDriver,
  measuredReplyFailure,
  tagWalkPageBound,
  timingOf,
  type DriverReply,
  type OperationTiming,
  type WalkOutcome,
} from './benchmark-driver.ts';
import { numberOrNull, round, seriesOf } from './benchmark-stats.ts';
import type { DriverOperationReport, WorkloadReport } from './benchmark-workload-report.ts';
import type { TagNode } from './benchmark-workload-ui.ts';

/** Total driver requests one cursor operation may spend across its repetitions. */
const WALK_REQUEST_BUDGET = 400;

export interface DriverPhaseInputs {
  page: Page | undefined;
  workerChunk: string | null;
  samples: number;
  db: DatabaseSync;
  analysis: DatabaseAnalysis;
  tagNodes: readonly TagNode[];
}

interface SingleRun {
  timing: OperationTiming;
  first: DriverReply;
  failures: string[];
}

interface DriverRuns {
  reports: Record<string, DriverOperationReport | null>;
  preview: SingleRun;
  backlinks: WalkOutcome;
  outgoing: WalkOutcome;
  tagWalk: WalkOutcome | null;
  local: SingleRun;
  global: SingleRun;
  globalTag: SingleRun | null;
}

/** E(2) driver Worker: armed named operations, cursor walks, invariants. */
export async function measureDriver(workload: WorkloadReport, inputs: DriverPhaseInputs): Promise<void> {
  const page = inputs.page;
  if (page === undefined || workload.queries === null) throw new Error('the main page was not measured');
  if (inputs.workerChunk === null) throw new Error('the build carries no snapshot-worker chunk');
  await installDriver(page, inputs.workerChunk);
  const cold = await driverRequest(page, 'preview', { slug: inputs.analysis.plan.previewSlug }, DRIVER_COLD_TIMEOUT_MS);
  recordDriverColdStart(workload, cold);
  const runs = await runDriverOperations(page, cold, inputs.samples, inputs.analysis);
  recordDriverReports(workload, runs.reports);
  // Structural invariants and DB spot-checks, recorded rather than thrown.
  const checks = new DriverChecks(workload, inputs.db);
  checks.walks(inputs.analysis, inputs.tagNodes, runs);
  checks.graphs(inputs.analysis, runs);
  checks.previewReport();
}

function recordDriverColdStart(workload: WorkloadReport, cold: DriverReply): void {
  workload.queries!.driverColdStart = {
    ok: cold.ok,
    code: cold.code ?? null,
    dispatchMs: Number.isFinite(cold.dispatchMs) ? round(cold.dispatchMs, 3) : null,
    operationMs: numberOrNull(cold.operationMs),
    sqlMs: numberOrNull(cold.sqlMs),
    phases: normalizePhases(cold.phases),
  };
  if (!cold.ok) workload.failures.push({ phase: 'driver', message: `cold driver preview failed: ${cold.code ?? 'unknown'}` });
  else {
    const telemetryFailure = measuredReplyFailure('cold driver preview', cold, true);
    if (telemetryFailure !== null) workload.failures.push({ phase: 'driver', message: telemetryFailure });
  }
  if (cold.phases != null && workload.startup !== null && workload.startup.worker.phases === null) {
    workload.startup.worker.phases = normalizePhases(cold.phases);
    workload.startup.worker.wasmMemoryBytes = workload.startup.worker.phases?.wasmMemoryBytes ?? null;
    workload.startup.worker.phasesNote = 'phases from the driver Worker’s first armed reply (the page Worker’s seam was absent)';
  }
}

/** Repeat one non-cursor operation; `first` stays the cold reply until a repetition lands. */
async function runSingle(
  page: Page,
  cold: DriverReply,
  type: 'preview' | 'localGraph' | 'globalGraph',
  args: Record<string, unknown>,
  repetitions: number,
): Promise<SingleRun> {
  const timing = timingOf();
  const failures: string[] = [];
  let first: DriverReply = cold;
  let successfulReplies = 0;
  for (let index = 0; index < repetitions; index += 1) {
    const reply = await driverRequest(page, type, args, DRIVER_WARM_TIMEOUT_MS);
    if (!reply.ok || reply.result === undefined) {
      failures.push(`${type} repetition ${index}: ${reply.code ?? 'failed'}`);
    } else {
      successfulReplies += 1;
      const telemetryFailure = measuredReplyFailure(`${type} repetition ${index}`, reply);
      if (telemetryFailure !== null) failures.push(telemetryFailure);
      else absorbTiming(timing, reply);
    }
    if (index === 0) first = reply;
  }
  try {
    finalizeTiming(timing, repetitions, successfulReplies, type);
  } catch (error) {
    failures.push(scrub(error));
    timing.dispatchSummary = seriesOf([]);
    timing.opSummary = seriesOf([]);
  }
  return { timing, first, failures };
}

/** Repetitions for one cursor walk so its total requests stay within the budget. */
function walkRepetitions(samples: number, members: number, pageSize: number): number {
  return Math.max(1, Math.min(samples, Math.floor(WALK_REQUEST_BUDGET / Math.max(1, Math.ceil((members + 1) / pageSize)))));
}

function walkReport(walk: WalkOutcome): DriverOperationReport {
  return { ...walk.timing, pagesPerWalk: walk.pagesPerWalk, notesWalked: walk.notes.length, failures: walk.failures };
}

async function runDriverOperations(
  page: Page,
  cold: DriverReply,
  samples: number,
  analysis: DatabaseAnalysis,
): Promise<DriverRuns> {
  const plan = analysis.plan;
  const reports: Record<string, DriverOperationReport | null> = {};
  const pageSize = MAX_PAGE_SIZE;

  const preview = await runSingle(page, cold, 'preview', { slug: plan.previewSlug }, samples);
  reports['preview'] = { ...preview.timing, failures: preview.failures };

  const backlinkRepetitions = walkRepetitions(samples, analysis.inDegree.get(plan.backlinkAnchor) ?? 0, pageSize);
  const backlinks = await driveWalk(page, 'backlinks', { slug: plan.backlinkAnchor }, pageSize, backlinkRepetitions);
  reports['backlinks'] = walkReport(backlinks);

  const outgoingRepetitions = walkRepetitions(samples, analysis.outDegree.get(plan.outgoingAnchor) ?? 0, pageSize);
  const outgoing = await driveWalk(page, 'outgoing', { slug: plan.outgoingAnchor }, pageSize, outgoingRepetitions);
  reports['outgoing'] = walkReport(outgoing);

  let tagWalk: WalkOutcome | null = null;
  if (plan.tagKey !== null) {
    tagWalk = await driveWalk(
      page,
      'byTag',
      { tagKey: plan.tagKey },
      pageSize,
      walkRepetitions(samples, plan.tagMembers, pageSize),
      tagWalkPageBound(plan.tagMembers, pageSize),
    );
    reports['byTag'] = walkReport(tagWalk);
  } else {
    reports['byTag'] = null;
  }

  const local = await runSingle(page, cold, 'localGraph', { slug: plan.localCenter }, samples);
  reports['localGraph'] = { ...local.timing, failures: local.failures };
  const global = await runSingle(page, cold, 'globalGraph', {}, samples);
  reports['globalGraph'] = { ...global.timing, failures: global.failures };
  const globalTag = plan.tagKey === null ? null : await runSingle(page, cold, 'globalGraph', { tagKey: plan.tagKey }, samples);
  reports['globalGraphTag'] = globalTag === null ? null : { ...globalTag.timing, failures: globalTag.failures };

  return { reports, preview, backlinks, outgoing, tagWalk, local, global, globalTag };
}

function recordDriverReports(workload: WorkloadReport, reports: Record<string, DriverOperationReport | null>): void {
  const queries = workload.queries!;
  queries.driver = reports;
  for (const [operation, driverReport] of Object.entries(reports)) {
    if (driverReport === null) continue;
    for (const failure of driverReport.failures) {
      workload.failures.push({ phase: `driver-${operation}`, message: failure });
    }
  }
  queries.seam = {
    sqlMsObserved: Object.values(reports).some((report) => report !== null && report.sqlMs.length > 0),
    phasesObserved:
      Object.values(reports).some((report) => report !== null && report.phases !== null) ||
      workload.startup?.worker.phases !== null,
  };
}

function graphShape(graph: NonNullable<NonNullable<DriverReply['result']>['graph']>): GraphSelectionShape {
  return {
    nodes: graph.nodes.map(({ slug, title, language }) => ({ slug, title, language })),
    edges: graph.edges,
    omitted: graph.omitted,
  };
}

/** Records each named check on the workload; a failed check is also a failure. */
class DriverChecks {
  private readonly workload: WorkloadReport;
  private readonly db: DatabaseSync;

  constructor(workload: WorkloadReport, db: DatabaseSync) {
    this.workload = workload;
    this.db = db;
  }

  private check(name: string, ok: boolean, detail: string): void {
    this.workload.checks.push({ name, ok, detail });
    if (!ok) this.workload.failures.push({ phase: `check:${name}`, message: detail });
  }

  private dbTitle(slug: string): string | null {
    const value = queryValue(this.db, 'SELECT title FROM nodes WHERE slug = ?', [slug]);
    return value === undefined ? null : String(value);
  }

  private dbSlugs(sql: string, params: readonly (string | number | null)[]): string[] {
    return queryRows<{ slug: string }>(this.db, sql, params).map((row) => row.slug);
  }

  /** The preview entry, then each cursor walk against its DB membership. */
  walks(analysis: DatabaseAnalysis, tagNodes: readonly TagNode[], runs: DriverRuns): void {
    const plan = analysis.plan;
    const previewReply = runs.preview.first;
    if (previewReply.result?.preview != null) {
      const returned = previewReply.result.preview;
      this.check(
        'driver-preview',
        returned.slug === plan.previewSlug && returned.title === this.dbTitle(plan.previewSlug),
        `preview returned ${JSON.stringify(returned.slug)} / ${JSON.stringify(returned.title)} for ${plan.previewSlug}`,
      );
    } else {
      this.check('driver-preview', false, `preview returned no entry for ${plan.previewSlug}`);
    }

    const { backlinks, outgoing, tagWalk } = runs;
    const backlinkDb = this.dbSlugs(
      `SELECT s.slug AS slug FROM edges AS e
           JOIN nodes AS n ON n.id = e.target_id JOIN nodes AS s ON s.id = e.source_id
           WHERE n.slug = ? ORDER BY s.slug`,
      [plan.backlinkAnchor],
    );
    this.check(
      'driver-backlinks-walk',
      backlinks.failures.length === 0 &&
        backlinks.notes.length === backlinkDb.length &&
        backlinks.notes.every((note, index) => note.slug === backlinkDb[index]) &&
        backlinks.pagesPerWalk >= 1,
      `backlinks walk returned ${backlinks.notes.length} over ${backlinks.pagesPerWalk} pages; DB has ${backlinkDb.length}` +
        (backlinks.failures.length === 0 ? '' : `; ${backlinks.failures.join('; ')}`),
    );
    const outgoingDb = this.dbSlugs(
      `SELECT t.slug AS slug FROM edges AS e
           JOIN nodes AS n ON n.id = e.source_id JOIN nodes AS t ON t.id = e.target_id
           WHERE n.slug = ? ORDER BY t.slug`,
      [plan.outgoingAnchor],
    );
    this.check(
      'driver-outgoing-walk',
      outgoing.failures.length === 0 &&
        outgoing.notes.length === outgoingDb.length &&
        outgoing.notes.every((note, index) => note.slug === outgoingDb[index]),
      `outgoing walk returned ${outgoing.notes.length} over ${outgoing.pagesPerWalk} pages; DB has ${outgoingDb.length}` +
        (outgoing.failures.length === 0 ? '' : `; ${outgoing.failures.join('; ')}`),
    );

    if (tagWalk !== null && plan.tagKey !== null) {
      const tagMismatch = tagIdentityFailure(tagWalk.tag, { key: plan.tagKey, label: plan.tagLabel ?? '' }, 'driver byTag');
      const memberMismatch = compareRenderedSelection(
        { nodes: tagWalk.notes, edges: [] },
        { nodes: [...tagNodes], edges: [] },
        'driver byTag members',
      );
      this.check(
        'driver-byTag-walk',
        tagWalk.failures.length === 0 && tagMismatch === null && memberMismatch === null,
        `byTag walk returned ${tagWalk.notes.length} over ${tagWalk.pagesPerWalk} pages for ${plan.tagKey}; DB has ${tagNodes.length}` +
          (tagMismatch === null ? '' : `; ${tagMismatch}`) +
          (memberMismatch === null ? '' : `; ${memberMismatch}`) +
          (tagWalk.failures.length === 0 ? '' : `; ${tagWalk.failures.join('; ')}`),
      );
    }
  }

  /** Each graph reply against the independently ranked DB oracle. */
  graphs(analysis: DatabaseAnalysis, runs: DriverRuns): void {
    const plan = analysis.plan;
    const localGraph = runs.local.first.result?.graph ?? null;
    if (localGraph !== null) {
      const oracle = graphOracleSelection(analysis.nodes, analysis.edges, {
        scope: 'local',
        centerSlug: plan.localCenter,
      });
      const mismatch = compareGraphSelection(graphShape(localGraph), oracle.selection, 'localGraph');
      const center = localGraph.center?.slug ?? null;
      this.check(
        'driver-localGraph',
        center === oracle.center && mismatch === null,
        mismatch ??
          `localGraph center ${String(center)} matched the DB-derived oracle with ` +
            `${localGraph.nodes.length}/${LOCAL_NODE_LIMIT} drawn nodes`,
      );
    } else {
      this.check('driver-localGraph', false, `localGraph returned no selection for ${plan.localCenter}`);
    }

    const globalReply = runs.global.first;
    if (globalReply.ok && globalReply.result?.graph != null) {
      const graph = globalReply.result.graph;
      const oracle = graphOracleSelection(analysis.nodes, analysis.edges, { scope: 'global' });
      const mismatch = compareGraphSelection(graphShape(graph), oracle.selection, 'globalGraph');
      this.check(
        'driver-globalGraph',
        mismatch === null,
        mismatch ?? `globalGraph matched the DB-derived oracle with ${graph.nodes.length}/${GLOBAL_NODE_LIMIT} drawn nodes`,
      );
    } else {
      this.check('driver-globalGraph', false, `globalGraph did not answer: ${globalReply.code ?? 'unknown'}`);
    }

    if (runs.globalTag !== null) {
      const graph = runs.globalTag.first.result?.graph ?? null;
      if (graph !== null) {
        const members = new Set(
          this.dbSlugs(
            `SELECT n.slug AS slug FROM tags AS t
                 JOIN node_tags AS nt ON nt.tag_id = t.id JOIN nodes AS n ON n.id = nt.node_id
                 WHERE t.key = ? ORDER BY n.slug`,
            [plan.tagKey!],
          ),
        );
        const oracle = graphOracleSelection(analysis.nodes, analysis.edges, {
          scope: 'global',
          candidateSlugs: members,
        });
        const mismatch = compareGraphSelection(graphShape(graph), oracle.selection, `globalGraph(${plan.tagKey})`);
        this.check(
          'driver-globalGraphTag',
          mismatch === null,
          mismatch ??
            `globalGraph(${plan.tagKey}) matched the DB-derived oracle with ` +
              `${graph.nodes.length}/${GLOBAL_NODE_LIMIT} drawn nodes from ${members.size} members`,
        );
      } else {
        this.check('driver-globalGraphTag', false, `tag-filtered globalGraph returned no selection`);
      }
    }
  }

  /** The visible panel was compared field-for-field at each timed completion. */
  previewReport(): void {
    const previewReport = this.workload.preview;
    if (previewReport === null) return;
    const targetSlug = previewReport.cold.targetSlug;
    const title = targetSlug === null ? null : this.dbTitle(targetSlug);
    previewReport.targetFromDb = targetSlug === null || title === null ? null : { slug: targetSlug, title };
    for (const [label, sample] of [
      ['cold', previewReport.cold],
      ['warm', previewReport.warm],
    ] as const) {
      sample.targetTitle ??= title;
      if (sample.visible && !sample.nonEmpty) {
        this.workload.failures.push({ phase: 'preview', message: `${label} preview panel was empty` });
      }
      if (sample.visible && sample.titleMatched !== true) {
        this.workload.failures.push({
          phase: 'preview',
          message: `${label} preview was visible without an exact DB-backed field comparison`,
        });
      }
    }
  }
}
