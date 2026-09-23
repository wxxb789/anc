/**
 * DOM construction for a live graph redraw: the SVG figure and its equivalent
 * table, plus the label helpers both share.
 *
 * Split out of `graph-client.ts` so that file holds only the stateful wiring
 * (center, tag filter, request sequence). Nothing here keeps state: every
 * function takes the graph, the page's template lookup, and whatever callback it
 * needs as explicit arguments. It imports only the same leaf modules the client
 * already does, so the bundle's import graph is unchanged.
 */

import {
  drawnNeighbours,
  relationKey,
  truncateLabel,
  SUBJECT_RADIUS,
  NODE_RADIUS,
  type EdgeDirection,
  type Graph,
} from '../lib/graph-layout.ts';
import type { SelectionNode } from '../lib/graph-selection.ts';
import { noteRoute } from '../lib/route-path.ts';
import { partLanguage } from '../lib/translations.ts';

/** Reads one page-emitted template string by its `dataset` name; `''` when absent. */
export type TemplateLookup = (name: string) => string;

/** Replace each `{key}` in a page-emitted template with its value. */
export function fillTemplate(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}

export function relationLabel(
  template: TemplateLookup,
  node: { isSubject: boolean; direction?: EdgeDirection },
): string {
  // One classifier decides the state; the attribute name is that same key, as
  // `data-graph-relation-<key>` in NoteGraph.astro and `dataset` camelize it.
  // Keys are single words, so the camel spelling is the first letter up.
  const key = relationKey(node);
  return template(`graphRelation${key.charAt(0).toUpperCase()}${key.slice(1)}`);
}

function nodeLabel(
  template: TemplateLookup,
  node: {
    entry: SelectionNode;
    isSubject: boolean;
    direction?: EdgeDirection;
    degree: number;
  },
): string {
  return fillTemplate(template(node.degree === 1 ? 'graphNodeLabelOne' : 'graphNodeLabel'), {
    title: node.entry.title,
    relation: relationLabel(template, node),
    degree: String(node.degree),
  });
}

export function drawFigure(target: HTMLElement, graph: Graph<SelectionNode>, template: TemplateLookup): void {
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
      anchor.setAttribute('aria-label', nodeLabel(template, node));
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

/** The "linked to" cell: the joined notes as a list, or the page's "none" text. */
function joinedCell(links: readonly SelectionNode[], template: TemplateLookup, language: string): HTMLTableCellElement {
  const linked = document.createElement('td');
  if (links.length === 0) {
    const none = document.createElement('span');
    none.className = 'graph-none';
    none.textContent = template('graphNoLinks');
    linked.append(none);
    return linked;
  }
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
  return linked;
}

/**
 * Redraw the equivalent table. `recenter` is present only on a local graph, and
 * each row then carries a re-center control that calls it with the row's slug.
 */
export function drawTable(
  target: HTMLElement,
  graph: Graph<SelectionNode>,
  template: TemplateLookup,
  recenter: ((slug: string) => void) | undefined,
): void {
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
      relation.textContent = relationLabel(template, node);
      const degree = document.createElement('td');
      degree.textContent = String(node.degree);
      const linked = joinedCell(joined.get(node.entry.slug) ?? [], template, language);
      row.append(head, relation, degree, linked);
      if (recenter !== undefined) {
        const control = document.createElement('button');
        control.type = 'button';
        control.setAttribute('data-graph-recenter', node.entry.slug);
        control.textContent = template('graphRecenter');
        // The visible text is the same on every row, so the accessible name
        // carries the note this control acts on: the page emits the
        // `{title}` template and the client fills it, as it does for the node
        // labels, which keeps the bundle free of a locale table.
        control.setAttribute('aria-label', fillTemplate(template('graphRecenterLabel'), { title: node.entry.title }));
        head.append(control);
        control.addEventListener('click', () => recenter(node.entry.slug));
      }
      return row;
    }),
  );
}
