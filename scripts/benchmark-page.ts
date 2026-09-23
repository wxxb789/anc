/**
 * Page-side instruments: the context recorder, rendered-surface readers,
 * measured-page setup, navigation and resource timing, and CDP heap polling.
 */

import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { SelectionEdge } from '../src/lib/graph-selection.ts';
import type { LoadPhases } from '../src/lib/worker-protocol.ts';
import { scrub } from './benchmark-host.ts';
import type { GraphSelectionShape, RenderedPreviewShape, RenderedSelectionShape } from './benchmark-oracle.ts';

const HEAP_POLL_INTERVAL_MS = 50;

export type WorkerPhases = LoadPhases;

export function normalizePhases(value: unknown): WorkerPhases | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const durationFields = ['totalMs', 'fetchMs', 'digestMs', 'wasmInitMs', 'importMs'] as const;
  const fields = [...durationFields, 'wasmMemoryBytes'] as const;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key as (typeof fields)[number]))) {
    return null;
  }
  const durations = durationFields.map((field) => {
    const candidate = record[field];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
  });
  if (durations.some((duration) => duration === null)) return null;
  const wasmMemoryBytes = record['wasmMemoryBytes'];
  if (
    wasmMemoryBytes !== null &&
    !(typeof wasmMemoryBytes === 'number' && Number.isFinite(wasmMemoryBytes) && wasmMemoryBytes >= 0)
  ) {
    return null;
  }
  return {
    totalMs: durations[0]!,
    fetchMs: durations[1]!,
    digestMs: durations[2]!,
    wasmInitMs: durations[3]!,
    importMs: durations[4]!,
    wasmMemoryBytes,
  };
}

export interface SnapshotEvent {
  type: string;
  ms: number | null;
  operationMs: number | null;
  sqlMs: number | null;
  phases: WorkerPhases | null;
}

interface GraphRenderEvent {
  scope: string;
  ms: number | null;
}

interface PreviewObservation {
  intentAt: number;
  href: string;
  slug: string | null;
  visibleAt: number | null;
  text: string | null;
}

interface RecorderState {
  snapshot: SnapshotEvent[];
  graphRender: GraphRenderEvent[];
  preview: PreviewObservation[];
}

/**
 * Arm the page-side instrument on every document in a context.
 *
 * `__snapshotMeasurement` is the runtime's existing armed flag; the recorder's
 * listeners are passive and carry no corpus data. The preview observer records
 * the `pointerover` intent and the panel's own unhide on the page's clock, so
 * the hover delay is observed rather than a constant subtracted from the
 * harness's timing.
 */
export async function installRecorder(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const state = window as unknown as {
      __snapshotMeasurement?: boolean;
      __benchSnapshot: SnapshotEvent[];
      __benchGraphRender: GraphRenderEvent[];
      __benchPreview: PreviewObservation[];
    };
    state.__snapshotMeasurement = true;
    state.__benchSnapshot = [];
    state.__benchGraphRender = [];
    state.__benchPreview = [];

    const slugOf = (href: string): string | null => {
      try {
        const match = /^\/notes\/([^/]+)\/$/.exec(new URL(href, location.origin).pathname);
        return match === null ? null : match[1]!;
      } catch {
        return null;
      }
    };
    const eligible = (link: HTMLAnchorElement): boolean => {
      try {
        const url = new URL(link.href, location.origin);
        return url.origin === location.origin && url.pathname !== location.pathname && slugOf(url.pathname) !== null;
      } catch {
        return false;
      }
    };

    document.addEventListener(
      'pointerover',
      (event) => {
        const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!(target instanceof HTMLAnchorElement) || !eligible(target)) return;
        const href = target.getAttribute('href') ?? '';
        state.__benchPreview.push({ intentAt: performance.now(), href, slug: slugOf(href), visibleAt: null, text: null });
      },
      true,
    );

    document.addEventListener(
      'snapshot-result',
      (event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        state.__benchSnapshot.push({
          type: typeof detail['type'] === 'string' ? detail['type'] : 'unknown',
          ms: typeof detail['ms'] === 'number' ? detail['ms'] : null,
          operationMs: typeof detail['operationMs'] === 'number' ? detail['operationMs'] : null,
          sqlMs: typeof detail['sqlMs'] === 'number' ? detail['sqlMs'] : null,
          phases: (detail['phases'] ?? null) as WorkerPhases | null,
        });
      },
      true,
    );

    document.addEventListener(
      'graph-render',
      (event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        state.__benchGraphRender.push({
          scope: typeof detail['scope'] === 'string' ? detail['scope'] : 'unknown',
          ms: typeof detail['ms'] === 'number' ? detail['ms'] : null,
        });
      },
      true,
    );

    const observer = new MutationObserver(() => {
      const panel = document.querySelector<HTMLElement>('#link-preview');
      if (panel === null || panel.hidden) return;
      const last = state.__benchPreview.at(-1);
      if (last === undefined || last.visibleAt !== null) return;
      last.visibleAt = performance.now();
      last.text = (panel.textContent ?? '').slice(0, 2000);
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  });
}

/** Read one page's recorder arrays as plain data. */
export async function readRecorder(page: Page): Promise<RecorderState> {
  const recorded = await page.evaluate(() => {
    const state = window as unknown as {
      __benchSnapshot?: SnapshotEvent[];
      __benchGraphRender?: GraphRenderEvent[];
      __benchPreview?: PreviewObservation[];
    };
    return {
      snapshot: state.__benchSnapshot ?? [],
      graphRender: state.__benchGraphRender ?? [],
      preview: state.__benchPreview ?? [],
    };
  });
  return {
    ...recorded,
    snapshot: recorded.snapshot.map((event) => ({ ...event, phases: normalizePhases(event.phases) })),
  };
}

/** Read only newly appended snapshot events so paginated walks stay linear. */
export async function readSnapshotEvents(page: Page, offset: number): Promise<{ events: SnapshotEvent[]; total: number }> {
  const batch = await page.evaluate((from) => {
    const state = window as unknown as { __benchSnapshot?: SnapshotEvent[] };
    const all = state.__benchSnapshot ?? [];
    return {
      events: all.slice(from),
      total: all.length,
    };
  }, offset);
  return {
    events: batch.events.map((event) => ({ ...event, phases: normalizePhases(event.phases) })),
    total: batch.total,
  };
}

export async function readRenderedPreview(page: Page): Promise<RenderedPreviewShape> {
  return page.locator('#link-preview').evaluate((panel) => {
    const title = panel.querySelector<HTMLElement>(':scope > strong');
    const excerpt = panel.querySelector<HTMLElement>(':scope > p');
    if (title === null || excerpt === null) throw new Error('the rendered preview has no title or excerpt');
    const documentLanguage = document.documentElement.lang || 'en';
    return {
      title: title.textContent ?? '',
      excerpt: excerpt.textContent ?? '',
      fragment: panel.querySelector<HTMLElement>(':scope > .preview-fragment')?.textContent ?? null,
      titleLanguage: title.getAttribute('lang') ?? documentLanguage,
      excerptLanguage: excerpt.getAttribute('lang') ?? documentLanguage,
    };
  });
}

export async function readRenderedGraph(page: Page): Promise<RenderedSelectionShape> {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[data-graph-region]');
    if (region === null) throw new Error('the rendered graph region is missing');
    const svg = region.querySelector<SVGSVGElement>('[data-graph-canvas] svg');
    const table = region.querySelector<HTMLElement>('[data-graph-body]');
    if (svg === null || table === null) throw new Error('the rendered graph surfaces are missing');

    const slugOf = (href: string): string => {
      const match = /^\/notes\/([^/]+)\/$/.exec(new URL(href, location.origin).pathname);
      if (match === null) throw new Error(`rendered graph link is not a note route: ${href}`);
      return match[1]!;
    };
    const documentLanguage = document.documentElement.lang || 'en';
    const nodes = [...table.querySelectorAll<HTMLTableRowElement>(':scope > tr')].map((row) => {
      const link = row.querySelector<HTMLAnchorElement>('th a[href]');
      if (link === null) throw new Error('a rendered graph row has no identity link');
      return {
        slug: slugOf(link.href),
        title: link.textContent ?? '',
        language: link.getAttribute('lang') ?? documentLanguage,
      };
    });

    const points = [...svg.querySelectorAll<SVGAElement>('.graph-nodes a[href]')].map((anchor) => {
      const circle = anchor.querySelector<SVGCircleElement>('circle');
      const x = circle?.getAttribute('cx');
      const y = circle?.getAttribute('cy');
      if (circle === null || x === null || y === null || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
        throw new Error('a rendered graph node has no finite coordinates');
      }
      return { slug: slugOf(anchor.href.baseVal), x: Number(x), y: Number(y) };
    });
    if (JSON.stringify(points.map((point) => point.slug)) !== JSON.stringify(nodes.map((node) => node.slug))) {
      throw new Error('the rendered graph table and figure expose different node identities');
    }
    const closest = (x: number, y: number): string => {
      const nearest = points
        .map((point) => ({ point, distance: Math.hypot(point.x - x, point.y - y) }))
        .sort((left, right) => left.distance - right.distance)[0];
      if (nearest === undefined) throw new Error('a rendered graph edge has no node endpoint');
      return nearest.point.slug;
    };
    const edges: SelectionEdge[] = [];
    for (const line of svg.querySelectorAll<SVGLineElement>('.graph-edges line')) {
      const coordinates = ['x1', 'y1', 'x2', 'y2'].map((name) => Number(line.getAttribute(name)));
      if (coordinates.some((value) => !Number.isFinite(value))) {
        throw new Error('a rendered graph edge has no finite coordinates');
      }
      const from = closest(coordinates[0]!, coordinates[1]!);
      const to = closest(coordinates[2]!, coordinates[3]!);
      if (from === to) throw new Error(`a rendered graph edge maps both endpoints to ${from}`);
      edges.push({ from, to });
      if (line.hasAttribute('marker-start')) edges.push({ from: to, to: from });
    }
    return { nodes, edges };
  });
}

export async function readRenderedNotes(page: Page, selector: string): Promise<GraphSelectionShape['nodes']> {
  return page.locator(selector).evaluateAll((links) => {
    const documentLanguage = document.documentElement.lang || 'en';
    return links.map((element) => {
      if (!(element instanceof HTMLAnchorElement)) throw new Error('rendered note identity is not an anchor');
      const match = /^\/notes\/([^/]+)\/$/.exec(element.pathname);
      if (match === null) throw new Error(`rendered note link is not a note route: ${element.href}`);
      return {
        slug: match[1]!,
        title: element.textContent ?? '',
        language: element.getAttribute('lang') ?? documentLanguage,
      };
    });
  });
}

/** Open a measured page and arm its page target before any navigation occurs. */
export async function openMeasuredPage(
  context: BrowserContext,
  throttle: number,
): Promise<{ page: Page; session: CDPSession }> {
  const page = await context.newPage();
  try {
    const session = await context.newCDPSession(page);
    if (throttle > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    return { page, session };
  } catch (error) {
    try {
      await page.close();
    } catch {
      // The caller records the original page-setup failure; best-effort cleanup is enough here.
    }
    throw error;
  }
}

/**
 * Mark and return the first previewable note link on the page.
 *
 * Eligibility mirrors `link-preview.ts`: same origin, not the page's own
 * route, and a `/notes/<slug>/` path. The link is marked with a data attribute
 * so the hover target is one element rather than a selector re-derived from a
 * value that could be quoted.
 */
export async function firstEligibleLink(page: Page): Promise<{ href: string; slug: string } | null> {
  return page.evaluate(() => {
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (link.origin !== location.origin) continue;
      const match = /^\/notes\/([^/]+)\/$/.exec(link.pathname);
      if (match === null || link.pathname === location.pathname) continue;
      link.setAttribute('data-bench-target-link', '');
      return { href: link.getAttribute('href') ?? '', slug: match[1]! };
    }
    return null;
  });
}

/** The installed class definition, imported from the gate that owns it. */
export function sqliteAssetDefinition(): string {
  return "url includes '/data/site.', '/wasm/', or matches WORKER_CHUNK_PATTERN (/\\/_astro\\/snapshot-worker-[\\w-]+\\.js$/); imported from tests/support/browser-site.ts";
}

export interface RenderTiming {
  domContentLoadedEventEnd: number | null;
  loadEventEnd: number | null;
  firstContentfulPaint: number | null;
  transferredBytes: number | null;
  documentTransferBytes: number | null;
  resourceTransferBytes: number | null;
  resourceCount: number;
}

export async function navigationTiming(page: Page): Promise<RenderTiming> {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint');
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const resourceTransfer = resources.reduce((sum, entry) => sum + (entry.transferSize ?? 0), 0);
    const documentTransfer = navigation?.transferSize ?? 0;
    return {
      domContentLoadedEventEnd: navigation?.domContentLoadedEventEnd ?? null,
      loadEventEnd: navigation?.loadEventEnd ?? null,
      firstContentfulPaint: paint === undefined ? null : paint.startTime ?? null,
      transferredBytes: documentTransfer + resourceTransfer,
      documentTransferBytes: documentTransfer,
      resourceTransferBytes: resourceTransfer,
      resourceCount: resources.length,
    };
  });
}

export interface ResourceEntry {
  source: 'page' | 'worker';
  page: string;
  path: string;
  encodedBodySize: number | null;
  decodedBodySize: number | null;
  transferSize: number | null;
  duration: number | null;
  responseStatus: number | null;
  initiatorType: string | null;
}

/**
 * Collect the page's and its workers' resource timings.
 *
 * The page's own timeline carries the Worker chunk (a page-initiated
 * construction) but not the DB, WASM binary, or glue, because those are
 * fetched *inside* the Worker and Chrome attributes them to the worker's own
 * timeline; both are collected here under `source` so the dependency table can
 * use the real numbers instead of a page-side absence reported as zero.
 */
export async function collectResources(page: Page, label: string, out: ResourceEntry[]): Promise<void> {
  const readEntries = (): Omit<ResourceEntry, 'source' | 'page'>[] => {
    return (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((entry) => {
      let path: string;
      try {
        path = new URL(entry.name).pathname;
      } catch {
        path = entry.name;
      }
      return {
        path,
        encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
        decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
        transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
        duration: Number.isFinite(entry.duration) ? entry.duration : null,
        responseStatus:
          typeof (entry as { responseStatus?: unknown }).responseStatus === 'number'
            ? ((entry as { responseStatus: number }).responseStatus)
            : null,
        initiatorType: entry.initiatorType ?? null,
      };
    });
  };
  let pageEntries: Omit<ResourceEntry, 'source' | 'page'>[];
  try {
    pageEntries = await page.evaluate(readEntries);
  } catch (error) {
    throw new Error(`${label} page resource timing failed: ${scrub(error)}`);
  }
  for (const entry of pageEntries) {
    out.push({ source: 'page', page: label, ...entry });
  }
  for (const [index, worker] of page.workers().entries()) {
    let workerEntries: Omit<ResourceEntry, 'source' | 'page'>[];
    try {
      workerEntries = await worker.evaluate(readEntries);
    } catch (error) {
      throw new Error(`${label} worker ${index + 1} resource timing failed: ${scrub(error)}`);
    }
    for (const entry of workerEntries) {
      out.push({ source: 'worker', page: label, ...entry });
    }
  }
}

export interface HeapSummary {
  samples: number;
  arrayBufferObserved: boolean;
  peakJsHeapBytes: number | null;
  steadyJsHeapBytes: number | null;
  peakArrayBufferBytes: number | null;
  steadyArrayBufferBytes: number | null;
}

/** Poll CDP `Performance.getMetrics` until stopped; the last sample is steady. */
export function startHeapPolling(session: CDPSession): { stop: () => Promise<HeapSummary> } {
  const values: { jsHeap: number | null; arrayBuffer: number | null }[] = [];
  let stopped = false;
  let failure: { error: unknown } | null = null;
  const loop = (async () => {
    while (!stopped) {
      try {
        const metrics = await session.send('Performance.getMetrics');
        const find = (name: string): number | null => {
          const metric = metrics.metrics.find((entry) => entry.name === name);
          return metric === undefined || !Number.isFinite(metric.value) ? null : Math.round(metric.value);
        };
        values.push({ jsHeap: find('JSHeapUsedSize'), arrayBuffer: find('ArrayBufferBytes') });
      } catch (error) {
        failure = { error };
        break;
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, HEAP_POLL_INTERVAL_MS));
    }
  })();
  return {
    async stop(): Promise<HeapSummary> {
      stopped = true;
      await loop;
      if (failure !== null) throw new Error(`CDP Performance.getMetrics failed: ${scrub(failure.error)}`);
      const jsHeap = values.map((sample) => sample.jsHeap).filter((value): value is number => value !== null);
      const arrayBuffer = values.map((sample) => sample.arrayBuffer).filter((value): value is number => value !== null);
      if (jsHeap.length < 2) {
        throw new Error(`CDP Performance.getMetrics returned ${jsHeap.length} usable JSHeapUsedSize samples; need at least 2`);
      }
      return {
        samples: values.length,
        arrayBufferObserved: values.some((sample) => sample.arrayBuffer !== null),
        peakJsHeapBytes: jsHeap.length === 0 ? null : Math.max(...jsHeap),
        steadyJsHeapBytes: jsHeap.at(-1) ?? null,
        peakArrayBufferBytes: arrayBuffer.length === 0 ? null : Math.max(...arrayBuffer),
        steadyArrayBufferBytes: arrayBuffer.at(-1) ?? null,
      };
    },
  };
}

export function measuredEventFailure(label: string, event: SnapshotEvent, requirePhases = false): string | null {
  if (!Number.isFinite(event.ms)) return `${label}: measured reply has non-finite dispatchMs`;
  if (!Number.isFinite(event.operationMs)) return `${label}: measured reply has non-finite operationMs`;
  if (!Number.isFinite(event.sqlMs)) return `${label}: measured reply has non-finite sqlMs`;
  if (requirePhases && normalizePhases(event.phases) === null) return `${label}: cold measured reply has no complete phases`;
  return null;
}

export function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
