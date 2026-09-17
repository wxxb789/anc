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
 */

import {
  layoutGlobal,
  layoutLocal,
  boundCounts,
  drawnNeighbours,
  relationKey,
  truncateLabel,
  SUBJECT_RADIUS,
  NODE_RADIUS,
  type EdgeDirection,
  type Graph,
} from '../lib/graph-layout.ts';
import type { SelectionNode } from '../lib/graph-selection.ts';
import { noteSlugFromPath, noteRoute } from '../lib/route-path.ts';
import { partLanguage } from '../lib/translations.ts';
import { requestGlobalGraph, requestLocalGraph } from './snapshot-client.ts';

export {};

interface SelectionAnswer {
  center: SelectionNode | null;
  nodes: SelectionNode[];
  edges: { from: string; to: string }[];
  omitted: number;
}

const region = document.querySelector<HTMLElement>('[data-graph-region]');
const controls = document.querySelector<HTMLElement>('[data-graph-controls]');
if (region && controls) install(region, controls);

function install(region: HTMLElement, controls: HTMLElement): void {
  const data = controls.dataset;
  const scope = (data['graphScope'] as 'local' | 'global') ?? 'local';
  const origin = data['graphCenter'] || noteSlugFromPath(location.pathname) || null;
  const chooser = controls.querySelector<HTMLSelectElement>('[data-graph-tag]');
  const resetButton = controls.querySelector<HTMLButtonElement>('[data-graph-reset-control]');
  const status = region.querySelector<HTMLElement>('[data-graph-status]');
  const canvas = region.querySelector<HTMLElement>('[data-graph-canvas]');
  const tableBody = region.querySelector<HTMLElement>('[data-graph-body]');
  const template = (name: string): string => data[name] ?? '';
  const fill = (text: string, values: Record<string, string | number>): string =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

  let center = origin;
  let tag = data['graphInitialTag'] || null;
  let sequence = 0;
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
  let live = false;

  controls.hidden = false;

  controls.querySelector('[data-graph-activate]')?.addEventListener('click', () => void refresh());
  resetButton?.addEventListener('click', () => {
    center = origin;
    tag = null;
    if (chooser) chooser.value = '';
    void refresh();
  });
  chooser?.addEventListener('change', () => {
    tag = chooser.value || null;
    void refresh();
  });

  async function load(): Promise<SelectionAnswer> {
    if (scope === 'local') {
      const result = await requestLocalGraph(center ?? '');
      if (result.graph === null) return { center: null, nodes: [], edges: [], omitted: 0 };
      return { center: result.graph.center, nodes: result.graph.nodes, edges: result.graph.edges, omitted: result.graph.omitted };
    }
    const result = await requestGlobalGraph(tag);
    return { center: null, nodes: result.graph.nodes, edges: result.graph.edges, omitted: result.graph.omitted };
  }

  async function refresh(): Promise<void> {
    const mine = ++sequence;
    controls.setAttribute('aria-busy', 'true');
    let answer: SelectionAnswer;
    try {
      answer = await load();
    } catch {
      if (mine !== sequence) return;
      controls.removeAttribute('aria-busy');
      if (status) status.textContent = template('graphFailed');
      return;
    }
    if (mine !== sequence) return; // a newer center/filter already won
    controls.removeAttribute('aria-busy');
    if (resetButton) resetButton.hidden = false;
    render(answer);
  }

  function render(answer: SelectionAnswer): void {
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
      if (live) clearLiveDrawing();
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
      clearLiveDrawing();
      return;
    }
    const drawingStarted = performance.now();
    // The button that started this redraw is about to be replaced with the
    // table's new rows; remember which note it named so focus can follow it to
    // the fresh control, and a keyboard re-center stays one Tab away from the
    // next one instead of falling back to the document.
    const focused = focusedRecenter();
    const graph =
      scope === 'local' && answer.center !== null
        ? layoutLocal({ center: answer.center, drawn: answer.nodes, edges: answer.edges, omitted: answer.omitted })
        : layoutGlobal({ nodes: answer.nodes, edges: answer.edges, omitted: answer.omitted });

    if (canvas) drawFigure(canvas, graph);
    if (tableBody) drawTable(tableBody, graph);
    if (focused !== null) {
      tableBody?.querySelector<HTMLElement>(`[data-graph-recenter="${CSS.escape(focused)}"]`)?.focus();
    }
    // Layout and drawing only: the Worker wait that produced `answer` is not
    // part of what this render costs the main thread. Goal 0008 consumes the
    // event below beside the snapshot timing it does not replace.
    const drawingMs = performance.now() - drawingStarted;
    live = true;
    // Both static count sentences describe the build-time figure. A live redraw
    // makes them second, stale totals for the same picture, so they go and the
    // status sentence below is the live home for counts.
    hideStaticCounts();
    if (status) {
      const counts = boundCounts(graph);
      const templateName = scope === 'local' ? 'graphStatusLocal' : tag ? 'graphStatusFiltered' : 'graphStatusGlobal';
      status.textContent = fill(template(templateName), {
        shown: counts.shown,
        total: counts.total,
        tag: tag ?? '',
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
  function clearLiveDrawing(): void {
    const svg = canvas?.querySelector('svg');
    svg?.querySelector('.graph-edges')?.replaceChildren();
    svg?.querySelector('.graph-nodes')?.replaceChildren();
    tableBody?.replaceChildren();
    hideStaticCounts();
    const figureName = template('graphFigureName');
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
  function hideStaticCounts(): void {
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

  function drawFigure(target: HTMLElement, graph: Graph<SelectionNode>): void {
    const svg = target.querySelector('svg');
    if (!svg) return;
    const edgeGroup = svg.querySelector('.graph-edges');
    const nodesGroup = svg.querySelector('.graph-nodes');
    if (!edgeGroup || !nodesGroup) return;

    // The static SVG carries the build-time frame and a count-bearing name, so
    // a redraw has to move both with the new selection: without the frame the
    // filtered graph draws inside the old box, and without the name a screen
    // reader hears the static total beside the live one. The live counts are in
    // `[data-graph-status]`, which is why the live name is count-free.
    svg.setAttribute('viewBox', graph.viewBox);
    svg.setAttribute('width', String(graph.width));
    svg.setAttribute('height', String(graph.height));
    const figureName = template('graphFigureName');
    if (figureName !== '') svg.setAttribute('aria-label', figureName);

    const namespace = 'http://www.w3.org/2000/svg';
    const markerId = svg.querySelector('marker')?.id;
    const arrow = markerId === undefined ? undefined : `url(#${markerId})`;

    edgeGroup.replaceChildren(
      ...graph.edges.map((edge) => {
        const line = document.createElementNS(namespace, 'line');
        line.setAttribute('class', `graph-edge${edge.isMutual ? ' graph-edge-mutual' : ''}${edge.direction === 'incoming' ? ' graph-edge-incoming' : ''}`);
        line.setAttribute('x1', String(edge.x1));
        line.setAttribute('y1', String(edge.y1));
        line.setAttribute('x2', String(edge.x2));
        line.setAttribute('y2', String(edge.y2));
        if (arrow !== undefined) line.setAttribute('marker-end', arrow);
        if (edge.isMutual) line.setAttribute('marker-start', arrow!);
        return line;
      }),
    );

    const language = document.documentElement.lang || 'en';
    nodesGroup.replaceChildren(
      ...graph.nodes.map((node) => {
        const anchor = document.createElementNS(namespace, 'a');
        anchor.setAttribute('class', node.isSubject ? 'graph-node graph-node-subject' : 'graph-node');
        anchor.setAttribute('href', noteRoute(node.entry.slug));
        anchor.setAttribute('aria-label', labelFor(node));
        // The same `partLanguage` result the static SVG anchor carries, so a
        // live redraw cannot drop a foreign title's language where the static
        // figure had it — including an entry declaring no language, which the
        // helper resolves to the navigation language.
        const lang = partLanguage(node.entry.language, language);
        if (lang !== undefined) anchor.setAttribute('lang', lang);
        const circle = document.createElementNS(namespace, 'circle');
        circle.setAttribute('class', 'graph-dot');
        circle.setAttribute('cx', String(node.x));
        circle.setAttribute('cy', String(node.y));
        circle.setAttribute('r', String(node.isSubject ? SUBJECT_RADIUS : NODE_RADIUS));
        circle.setAttribute('aria-hidden', 'true');
        const text = document.createElementNS(namespace, 'text');
        text.setAttribute('class', 'graph-label');
        text.setAttribute('x', String(node.x));
        text.setAttribute('y', String(node.y));
        text.setAttribute('dy', '1.9em');
        text.setAttribute('aria-hidden', 'true');
        text.textContent = node.label || truncateLabel(node.entry.title);
        anchor.append(circle, text);
        return anchor;
      }),
    );
  }

  function labelFor(node: {
    entry: SelectionNode;
    isSubject: boolean;
    direction?: EdgeDirection;
    degree: number;
  }): string {
    return fill(template(node.degree === 1 ? 'graphNodeLabelOne' : 'graphNodeLabel'), {
      title: node.entry.title,
      relation: labelForRelation(node),
      degree: String(node.degree),
    });
  }

  function drawTable(target: HTMLElement, graph: Graph<SelectionNode>): void {
    const joined = drawnNeighbours(graph);
    const language = document.documentElement.lang || 'en';

    target.replaceChildren(
      ...graph.nodes.map((node) => {
        const row = document.createElement('tr');
        const head = document.createElement('th');
        head.scope = 'row';
        const link = document.createElement('a');
        link.href = noteRoute(node.entry.slug);
        link.textContent = node.entry.title;
        // The static table marks its title link with `partLanguage`; the live
        // one has to carry the same attribute or a redraw quietly drops it.
        const titleLang = partLanguage(node.entry.language, language);
        if (titleLang !== undefined) link.setAttribute('lang', titleLang);
        head.append(link);
        const relation = document.createElement('td');
        relation.textContent = labelForRelation(node);
        const degree = document.createElement('td');
        degree.textContent = String(node.degree);
        const linked = document.createElement('td');
        const links = joined.get(node.entry.slug) ?? [];
        if (links.length === 0) {
          const none = document.createElement('span');
          none.className = 'graph-none';
          none.textContent = template('graphNoLinks');
          linked.append(none);
        } else {
          const list = document.createElement('ul');
          list.className = 'graph-joined';
          for (const other of links) {
            const item = document.createElement('li');
            const anchor = document.createElement('a');
            anchor.href = noteRoute(other.slug);
            anchor.textContent = other.title;
            // As in the static "linked to" list, each joined note is marked
            // with its own language.
            const otherLang = partLanguage(other.language, language);
            if (otherLang !== undefined) anchor.setAttribute('lang', otherLang);
            item.append(anchor);
            list.append(item);
          }
          linked.append(list);
        }
        row.append(head, relation, degree, linked);
        if (scope === 'local') {
          const control = document.createElement('button');
          control.type = 'button';
          control.setAttribute('data-graph-recenter', node.entry.slug);
          control.textContent = template('graphRecenter');
          // The visible text is the same on every row, so the accessible name
          // carries the note this control acts on: the page emits the
          // `{title}` template and the client fills it, as it does for the node
          // labels, which keeps the bundle free of a locale table.
          control.setAttribute('aria-label', fill(template('graphRecenterLabel'), { title: node.entry.title }));
          head.append(control);
          control.addEventListener('click', () => {
            center = node.entry.slug;
            void refresh();
          });
        }
        return row;
      }),
    );
  }

  function labelForRelation(node: { isSubject: boolean; direction?: EdgeDirection }): string {
    // One classifier decides the state; the attribute name is that same key, as
    // `data-graph-relation-<key>` in NoteGraph.astro and `dataset` camelize it.
    // Keys are single words, so the camel spelling is the first letter up.
    const key = relationKey(node);
    return template(`graphRelation${key.charAt(0).toUpperCase()}${key.slice(1)}`);
  }
}
