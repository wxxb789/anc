/**
 * Interactive graph exploration: re-center and tag-filter over the shared
 * snapshot Worker.
 *
 * Progressive enhancement only. The server-rendered SVG, table, and lists remain
 * the baseline and are never blanked by a failure here; the controls are hidden
 * until this module runs. It imports only leaf modules (`graph-selection`,
 * `graph-layout`, `route-path`, the shared client), never the content artifact
 * or the route model, so graph-free pages do not carry it and the bundle stays
 * small.
 */

import { layoutGlobal, layoutLocal, boundCounts, truncateLabel, SUBJECT_RADIUS, NODE_RADIUS, type Graph } from '../lib/graph-layout.ts';
import { byTitleThenSlug, type SelectionNode } from '../lib/graph-selection.ts';
import { noteSlugFromPath, noteRoute } from '../lib/route-path.ts';
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
      if (status) status.textContent = template('graphUnknownCenter');
      return;
    }
    if (scope === 'global' && tag && answer.nodes.length === 0) {
      if (status) status.textContent = template('graphEmptyFilter');
      return;
    }
    const graph =
      scope === 'local' && answer.center !== null
        ? layoutLocal({ center: answer.center, drawn: answer.nodes, edges: answer.edges, omitted: answer.omitted })
        : layoutGlobal({ nodes: answer.nodes, edges: answer.edges, omitted: answer.omitted });

    if (canvas) drawFigure(canvas, graph);
    if (tableBody) drawTable(tableBody, graph);
    if (status) {
      const counts = boundCounts(graph);
      const templateName = scope === 'local' ? 'graphStatusLocal' : tag ? 'graphStatusFiltered' : 'graphStatusGlobal';
      status.textContent = fill(template(templateName), {
        shown: counts.shown,
        total: counts.total,
        tag: tag ?? '',
      });
    }
  }

  function drawFigure(target: HTMLElement, graph: Graph<SelectionNode>): void {
    const svg = target.querySelector('svg');
    if (!svg) return;
    const edgeGroup = svg.querySelector('.graph-edges');
    const nodesGroup = svg.querySelector('.graph-nodes');
    if (!edgeGroup || !nodesGroup) return;
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
        anchor.setAttribute('aria-label', labelFor(node.entry.title, node.direction, node.degree, node.isSubject));
        if (node.entry.language && node.entry.language.toLowerCase() !== language.toLowerCase()) {
          anchor.setAttribute('lang', node.entry.language);
        }
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

  function labelFor(title: string, direction: string | undefined, degree: number, isSubject: boolean): string {
    const relation = isSubject
      ? template('graphRelationSubject')
      : direction === 'outgoing'
        ? template('graphRelationOutgoing')
        : direction === 'incoming'
          ? template('graphRelationIncoming')
          : direction === 'mutual'
            ? template('graphRelationMutual')
            : template('graphRelationLinked');
    return fill(template(degree === 1 ? 'graphNodeLabelOne' : 'graphNodeLabel'), { title, relation, degree: String(degree) });
  }

  function drawTable(target: HTMLElement, graph: Graph<SelectionNode>): void {
    const joined = new Map<string, { slug: string; title: string; language?: string }[]>(
      graph.nodes.map((node) => [node.entry.slug, []]),
    );
    for (const edge of graph.edges) {
      const from = graph.nodes.find((node) => node.entry.slug === edge.from)!.entry;
      const to = graph.nodes.find((node) => node.entry.slug === edge.to)!.entry;
      joined.get(edge.from)!.push(to);
      joined.get(edge.to)!.push(from);
    }
    for (const list of joined.values()) list.sort(byTitleThenSlug);

    target.replaceChildren(
      ...graph.nodes.map((node) => {
        const row = document.createElement('tr');
        const head = document.createElement('th');
        head.scope = 'row';
        const link = document.createElement('a');
        link.href = noteRoute(node.entry.slug);
        link.textContent = node.entry.title;
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

  function labelForRelation(node: { isSubject: boolean; direction?: string }): string {
    if (node.isSubject) return template('graphRelationSubject');
    switch (node.direction) {
      case 'outgoing':
        return template('graphRelationOutgoing');
      case 'incoming':
        return template('graphRelationIncoming');
      case 'mutual':
        return template('graphRelationMutual');
      default:
        return template('graphRelationLinked');
    }
  }
}
