/**
 * Interactive graph exploration: re-center and tag-filter over the shared
 * snapshot Worker.
 *
 * Progressive enhancement only. The server-rendered SVG, table, and lists remain
 * the baseline and are never blanked by a failure here; the controls are hidden
 * until this module runs. It imports only leaf modules (`graph-selection`,
 * `graph-layout`, `route-path`, `translations`, the shared client), never the
 * content artifact or the route model, so graph-free pages do not carry it and
 * the bundle stays small. `partLanguage` is the one thing it takes from the
 * translations contract, and it is a BCP 47 comparison rather than a locale
 * lookup, so the built bundle still ships no locale table.
 *
 * This file is the stateful wiring (center, tag filter, request sequence); the
 * stateless figure and table construction lives in `graph-draw.ts`.
 */

import { layoutGlobal, layoutLocal, boundCounts, type Graph } from '../lib/graph-layout.ts';
import type { SelectionNode } from '../lib/graph-selection.ts';
import { noteSlugFromPath } from '../lib/route-path.ts';
import { drawFigure, drawTable, fillTemplate, type TemplateLookup } from './graph-draw.ts';
import { requestGlobalGraph, requestLocalGraph } from './snapshot-client.ts';

interface SelectionAnswer {
  center: SelectionNode | null;
  nodes: SelectionNode[];
  edges: { from: string; to: string }[];
  omitted: number;
}

type Scope = 'local' | 'global';

/** The page's graph elements and templates, resolved once at install. */
interface GraphView {
  region: HTMLElement;
  scope: Scope;
  chooser: HTMLSelectElement | null;
  status: HTMLElement | null;
  canvas: HTMLElement | null;
  tableBody: HTMLElement | null;
  template: TemplateLookup;
}

/** The mutable selection the controls drive. */
interface GraphState {
  center: string | null;
  tag: string | null;
  /** Increments per request; a reply whose number is no longer current is stale. */
  sequence: number;
  /**
   * Whether a live drawing has replaced the static figure and table.
   *
   * The client redraws in place, so once that has happened the page's own
   * baseline cannot come back. An unknown-center reply that arrives before any
   * drawing is a stale binding whose subject is absent from the snapshot, and
   * the baseline it leaves in place is still this page's own graph; the same
   * reply after a drawing blanks that drawing instead. The empty-filter branch
   * is different — the baseline was never the requested graph — and clears
   * unconditionally.
   */
  live: boolean;
}

const region = document.querySelector<HTMLElement>('[data-graph-region]');
const controls = document.querySelector<HTMLElement>('[data-graph-controls]');
if (region && controls) install(region, controls);

function install(region: HTMLElement, controls: HTMLElement): void {
  const data = controls.dataset;
  const origin = data['graphCenter'] || noteSlugFromPath(location.pathname) || null;
  const resetButton = controls.querySelector<HTMLButtonElement>('[data-graph-reset-control]');
  const view: GraphView = {
    region,
    scope: (data['graphScope'] as Scope) ?? 'local',
    chooser: controls.querySelector<HTMLSelectElement>('[data-graph-tag]'),
    status: region.querySelector<HTMLElement>('[data-graph-status]'),
    canvas: region.querySelector<HTMLElement>('[data-graph-canvas]'),
    tableBody: region.querySelector<HTMLElement>('[data-graph-body]'),
    template: (name) => data[name] ?? '',
  };
  const { chooser, status, template } = view;
  const state: GraphState = { center: origin, tag: data['graphInitialTag'] || null, sequence: 0, live: false };
  const recenter = (slug: string): void => {
    state.center = slug;
    void refresh();
  };

  controls.hidden = false;

  controls.querySelector('[data-graph-activate]')?.addEventListener('click', () => void refresh());
  resetButton?.addEventListener('click', () => {
    state.center = origin;
    state.tag = null;
    if (chooser) chooser.value = '';
    void refresh();
  });
  chooser?.addEventListener('change', () => {
    state.tag = chooser.value || null;
    void refresh();
  });

  async function refresh(): Promise<void> {
    const mine = ++state.sequence;
    controls.setAttribute('aria-busy', 'true');
    // A cold load fetches the Worker, the WASM, and the snapshot before any
    // reply, and `aria-busy` alone announces nothing. The polite status region
    // says the live graph is loading; the reply's own sentence replaces it.
    if (status) status.textContent = template('graphLoading');
    let answer: SelectionAnswer;
    try {
      answer = await load(view.scope, state.center, state.tag);
    } catch {
      if (mine !== state.sequence) return;
      controls.removeAttribute('aria-busy');
      if (status) status.textContent = template('graphFailed');
      return;
    }
    if (mine !== state.sequence) return; // a newer center/filter already won
    controls.removeAttribute('aria-busy');
    if (resetButton) resetButton.hidden = false;
    render(view, state, answer, recenter);
  }
}

async function load(scope: Scope, center: string | null, tag: string | null): Promise<SelectionAnswer> {
  if (scope === 'local') {
    const result = await requestLocalGraph(center ?? '');
    if (result.graph === null) return { center: null, nodes: [], edges: [], omitted: 0 };
    return { center: result.graph.center, nodes: result.graph.nodes, edges: result.graph.edges, omitted: result.graph.omitted };
  }
  const result = await requestGlobalGraph(tag);
  return { center: null, nodes: result.graph.nodes, edges: result.graph.edges, omitted: result.graph.omitted };
}

function render(view: GraphView, state: GraphState, answer: SelectionAnswer, recenter: (slug: string) => void): void {
  const { scope, status, canvas, tableBody, template } = view;
  const { tag } = state;
  if (answer.center === null && scope === 'local') {
    // A reply with no center is a successful no-match, not a runtime failure:
    // the failure-preservation contract (`docs/core-design/build-and-runtime.md`,
    // "Failure, accessibility, and security") keeps the static article,
    // figure, and table for fetch, integrity, schema, CSP, Worker, and WASM
    // failures, and none of those happened here. On first load this branch is
    // a stale binding whose subject is absent from the snapshot — no drawing
    // has replaced the baseline, and that baseline is still this page's own
    // graph, so it stays visible while the status says what was not found.
    // Only a drawing this client already replaced is cleared: it depicts a
    // center the snapshot does not have, and leaving it would contradict the
    // status sentence.
    if (status) status.textContent = template('graphUnknownCenter');
    if (state.live) clearLiveDrawing(view);
    return;
  }
  if (scope === 'global' && tag && answer.nodes.length === 0) {
    // The status states the empty result, so any drawing shown beside it would
    // contradict it: picture and status would describe different sets. Unlike
    // the unknown-center branch above, there is no baseline that is still the
    // requested graph — a first load on `/graph/` is the unfiltered static
    // figure, not the filter's — so this clears unconditionally. The empty
    // selection is a successful answer and is depicted as one.
    if (status) status.textContent = template('graphEmptyFilter');
    clearLiveDrawing(view);
    return;
  }
  const drawingStarted = performance.now();
  // The button that started this redraw is about to be replaced with the
  // table's new rows; remember which note it named so focus can follow it to
  // the fresh control, and a keyboard re-center stays one Tab away from the
  // next one instead of falling back to the document.
  const focused = focusedRecenter();
  const graph: Graph<SelectionNode> =
    scope === 'local' && answer.center !== null
      ? layoutLocal({ center: answer.center, drawn: answer.nodes, edges: answer.edges, omitted: answer.omitted })
      : layoutGlobal({ nodes: answer.nodes, edges: answer.edges, omitted: answer.omitted });

  if (canvas) drawFigure(canvas, graph, template);
  if (tableBody) drawTable(tableBody, graph, template, scope === 'local' ? recenter : undefined);
  if (focused !== null) {
    tableBody?.querySelector<HTMLElement>(`[data-graph-recenter="${CSS.escape(focused)}"]`)?.focus();
  }
  // Layout and drawing only: the Worker wait that produced `answer` is not
  // part of what this render costs the main thread. Goal 0008 consumes the
  // event below beside the snapshot timing it does not replace.
  const drawingMs = performance.now() - drawingStarted;
  state.live = true;
  // Both static count sentences describe the build-time figure. A live redraw
  // makes them second, stale totals for the same picture, so they go and the
  // status sentence below is the live home for counts.
  hideStaticCounts(view.region);
  if (status) {
    const counts = boundCounts(graph);
    const templateName = scope === 'local' ? 'graphStatusLocal' : tag ? 'graphStatusFiltered' : 'graphStatusGlobal';
    status.textContent = fillTemplate(template(templateName), {
      shown: counts.shown,
      total: counts.total,
      tag: tag === null ? '' : tagLabel(view.chooser, tag),
    });
  }
  // The render instrument, armed explicitly by the measurer: no corpus data
  // is carried, and an ordinary reader dispatches nothing. Only the actual
  // drawing path reaches this line — an unknown center or an empty filter
  // returns above with a status and no render to time.
  if ((window as { __snapshotMeasurement?: boolean }).__snapshotMeasurement === true) {
    document.dispatchEvent(new CustomEvent('graph-render', { detail: { scope, ms: drawingMs } }));
  }
}

/**
 * The chosen tag's display label, for the filtered status sentence.
 *
 * The option's value is the route key (`c-sharp`), and the sentence names
 * the tag the reader chose, which is the label on the option (`C#`) — the
 * same text the chooser showed. Falls back to the key only for a tag no
 * option carries.
 */
function tagLabel(chooser: HTMLSelectElement | null, key: string): string {
  return [...(chooser?.options ?? [])].find((option) => option.value === key)?.textContent?.trim() || key;
}

/**
 * Blank a live drawing's figure and table.
 *
 * The children are replaced rather than the containers hidden: an empty
 * picture and an empty equivalent table are the depiction of an empty result,
 * and the static baseline cannot be restored — the client replaced it in
 * place. Leaving the previous selection on screen would state two different
 * sets at once, which is the contradiction this removes. The static count
 * sentences and the count-bearing group name go with it; the status sentence
 * is the live home for counts.
 */
function clearLiveDrawing(view: GraphView): void {
  const svg = view.canvas?.querySelector('svg');
  svg?.querySelector('.graph-edges')?.replaceChildren();
  svg?.querySelector('.graph-nodes')?.replaceChildren();
  view.tableBody?.replaceChildren();
  hideStaticCounts(view.region);
  const figureName = view.template('graphFigureName');
  if (svg && figureName !== '') svg.setAttribute('aria-label', figureName);
}

/**
 * Hide the static count sentences.
 *
 * Both describe the build-time figure and neither can be updated by a live
 * query, so once the picture is redrawn or cleared they would state a second
 * total beside the live status sentence. The bound element's expansion link
 * stays: "see the whole graph" is useful whatever this figure holds.
 */
function hideStaticCounts(region: HTMLElement): void {
  const figureLabel = region.querySelector<HTMLElement>('[data-graph-figure-label]');
  if (figureLabel) figureLabel.hidden = true;
  const bound = region.querySelector<HTMLElement>('[data-graph-bound]');
  if (bound) bound.hidden = true;
}

/** The note slug of the re-center control that currently holds focus, if any. */
function focusedRecenter(): string | null {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active.getAttribute('data-graph-recenter') : null;
}
