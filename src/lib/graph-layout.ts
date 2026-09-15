/**
 * The graph's geometry, as a leaf module.
 *
 * Pure and import-free so the build (`NoteGraph.astro`) and the browser
 * explorer can lay out the same bounded selection without the client pulling in
 * the content artifact, the route model, or Pagefind. Selection lives in
 * `graph-selection.ts`; this module turns a selection into coordinates and a
 * drawable edge set.
 *
 * Determinism is a hard requirement: every ordering ends in `slug`, every
 * coordinate goes through {@link round}, and no layout step iterates to a fixed
 * point, so two builds of one corpus are byte-equal.
 */

import { byTitleThenSlug, type EdgeDirection, type SelectionEdge } from './graph-selection.ts';

/** How an edge runs relative to the note the reader is on. */
export type { EdgeDirection } from './graph-selection.ts';

/** One note, drawn. */
export interface GraphNode<T extends { slug: string } = { slug: string }> {
  entry: T;
  x: number;
  y: number;
  /** The label as drawn, truncated. `entry.title` is the accessible name. */
  label: string;
  direction?: EdgeDirection;
  isSubject: boolean;
  /** Edges touching this node inside the drawn set. */
  degree: number;
}

/** One authored relationship between two drawn notes. */
export interface GraphEdge {
  from: string;
  to: string;
  isMutual: boolean;
  direction?: EdgeDirection;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A laid-out graph, ready to render. */
export interface Graph<T extends { slug: string } = { slug: string }> {
  nodes: GraphNode<T>[];
  edges: GraphEdge[];
  viewBox: string;
  width: number;
  height: number;
  /** Nodes the bound excluded. Stated to the reader rather than silently dropped. */
  omitted: number;
}

/** Distance between two concentric rings, in user units. */
const RING_STEP = 92;
/** The shortest arc the layout will leave between two nodes on one ring. */
const NODE_GAP = 78;
/** Room outside the outermost ring for a label to sit in. */
const LABEL_SPACE = 136;
/** Longest drawn label, in code points rather than UTF-16 units. */
const LABEL_CHARS = 18;
/** Radius of the note the reader is on, and of every other note. */
export const SUBJECT_RADIUS = 9;
export const NODE_RADIUS = 6;
/** How much of the line the arrowhead occupies, so an edge stops short of it. */
const MARKER_LENGTH = 9;

/** Two decimal places, with negative zero normalized away. */
function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** A title shortened to fit beside its node. */
export function truncateLabel(title: string): string {
  const characters = [...title];
  return characters.length <= LABEL_CHARS
    ? title
    : `${characters.slice(0, LABEL_CHARS - 1).join('').trimEnd()}…`;
}

/** Place items evenly around a circle, starting at the top and going clockwise. */
function placeRing<T>(items: readonly T[], radius: number): { item: T; x: number; y: number }[] {
  return items.map((item, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / items.length;
    return { item, x: round(radius * Math.cos(angle)), y: round(radius * Math.sin(angle)) };
  });
}

/** How many nodes ring `index` holds, from its own circumference. */
function ringCapacity(index: number): number {
  if (index === 0) return 1;
  return Math.max(1, Math.floor((2 * Math.PI * index * RING_STEP) / NODE_GAP));
}

function radiusOf(node: { isSubject: boolean }): number {
  return node.isSubject ? SUBJECT_RADIUS : NODE_RADIUS;
}

/** How `other` relates to `subject`, from the directed edge set. */
function edgeDirection(
  edges: readonly SelectionEdge[],
  subject: string,
  other: string,
): EdgeDirection | undefined {
  const outgoing = edges.some((edge) => edge.from === subject && edge.to === other);
  const incoming = edges.some((edge) => edge.from === other && edge.to === subject);
  if (outgoing && incoming) return 'mutual';
  if (outgoing) return 'outgoing';
  if (incoming) return 'incoming';
  return undefined;
}

/**
 * The relationship states a drawn node can carry, as one shared key.
 *
 * `NoteGraph.astro` resolves the key to a word and writes its
 * `data-graph-relation-<key>` attribute; `graph-client.ts` builds the same
 * attribute name from the key. Keeping the classifier beside `edgeDirection`
 * — the function that computes a node's direction — means a sixth state or a
 * rename is one edit here, with `NoteGraph.astro`'s `Record<RelationKey, …>`
 * failing to type-check until the new state has a word, rather than a switch
 * in the shipped bundle falling through to a wrong label.
 */
export type RelationKey = 'subject' | EdgeDirection | 'linked';

export function relationKey(node: { isSubject: boolean; direction?: EdgeDirection }): RelationKey {
  if (node.isSubject) return 'subject';
  switch (node.direction) {
    case 'outgoing':
      return 'outgoing';
    case 'incoming':
      return 'incoming';
    case 'mutual':
      return 'mutual';
    // `/graph/` has no subject, so its nodes have no direction relative to one.
    // Spelled as a case rather than a `default` so a sixth direction fails this
    // function's return type instead of silently reading as `linked`.
    case undefined:
      return 'linked';
  }
}

/**
 * Every directed edge with both ends drawn, each unordered pair drawn once.
 * A reciprocal pair becomes one line with two arrowheads.
 */
function drawEdges<T extends { slug: string }>(
  nodes: readonly GraphNode<T>[],
  edges: readonly SelectionEdge[],
  subject?: string,
): GraphEdge[] {
  const drawn = new Map(nodes.map((node) => [node.entry.slug, node]));
  const pairs = new Map<string, { from: string; to: string; isMutual: boolean }>();
  for (const edge of edges) {
    if (!drawn.has(edge.from) || !drawn.has(edge.to)) continue;
    const key = edge.from < edge.to ? `${edge.from} ${edge.to}` : `${edge.to} ${edge.from}`;
    const existing = pairs.get(key);
    if (existing === undefined) pairs.set(key, { from: edge.from, to: edge.to, isMutual: false });
    else if (existing.from !== edge.from) existing.isMutual = true;
  }

  return [...pairs.values()]
    .sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1))
    .map((pair) => {
      const from = drawn.get(pair.from)!;
      const to = drawn.get(pair.to)!;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const startTrim = radiusOf(from) + (pair.isMutual ? MARKER_LENGTH : 0);
      const endTrim = radiusOf(to) + MARKER_LENGTH;
      const scale = Math.min(startTrim, Math.max(0, (length - endTrim) / 2));
      const other =
        subject === undefined
          ? undefined
          : pair.from === subject
            ? pair.to
            : pair.to === subject
              ? pair.from
              : undefined;
      return {
        ...pair,
        direction: other === undefined ? undefined : edgeDirection(edges, subject!, other),
        x1: round(from.x + (dx / length) * scale),
        y1: round(from.y + (dy / length) * scale),
        x2: round(to.x - (dx / length) * Math.min(endTrim, length - scale)),
        y2: round(to.y - (dy / length) * Math.min(endTrim, length - scale)),
      };
    });
}

/** Wrap placed nodes and their edges in a box that contains every label. */
function frame<T extends { slug: string }>(
  nodes: GraphNode<T>[],
  omitted: number,
  edges: readonly SelectionEdge[],
  subject?: string,
): Graph<T> {
  const reach = Math.max(0, ...nodes.map((node) => Math.hypot(node.x, node.y)));
  const half = Math.ceil(reach + LABEL_SPACE);
  return {
    nodes,
    edges: drawEdges(nodes, edges, subject),
    viewBox: `${-half} ${-half} ${half * 2} ${half * 2}`,
    width: half * 2,
    height: half * 2,
    omitted,
  };
}

/** Count each node's drawn edges, once reciprocal pairs are merged. */
function withDegrees<T extends { slug: string }>(graph: Graph<T>): Graph<T> {
  const degrees = new Map<string, number>();
  for (const edge of graph.edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  for (const node of graph.nodes) {
    node.degree = degrees.get(node.entry.slug) ?? 0;
  }
  return graph;
}

/** Lay out a local selection: center at the origin, neighbours on one ring. */
export function layoutLocal<T extends { slug: string; title: string }>(selection: {
  center: T;
  drawn: readonly T[];
  edges: readonly SelectionEdge[];
  omitted: number;
}): Graph<T> {
  const radius = Math.max(RING_STEP, Math.ceil((NODE_GAP * selection.drawn.length) / (2 * Math.PI)));
  const subject: GraphNode<T> = {
    entry: selection.center,
    x: 0,
    y: 0,
    label: truncateLabel(selection.center.title),
    isSubject: true,
    degree: 0,
  };
  const nodes: GraphNode<T>[] = [
    subject,
    ...placeRing(selection.drawn, radius).map(({ item, x, y }) => ({
      entry: item,
      x,
      y,
      label: truncateLabel(item.title),
      direction: edgeDirection(selection.edges, selection.center.slug, item.slug),
      isSubject: false,
      degree: 0,
    })),
  ];
  return withDegrees(frame(nodes, selection.omitted, selection.edges, selection.center.slug));
}

/** Lay out a global selection: ranked nodes packed onto concentric rings. */
export function layoutGlobal<T extends { slug: string; title: string }>(selection: {
  nodes: readonly T[];
  edges: readonly SelectionEdge[];
  omitted: number;
}): Graph<T> {
  const nodes: GraphNode<T>[] = [];
  for (let ring = 0, placed = 0; placed < selection.nodes.length; ring += 1) {
    const slice = selection.nodes.slice(placed, placed + ringCapacity(ring));
    for (const { item, x, y } of placeRing(slice, ring * RING_STEP)) {
      nodes.push({
        entry: item,
        x,
        y,
        label: truncateLabel(item.title),
        isSubject: false,
        degree: 0,
      });
    }
    placed += slice.length;
  }
  return withDegrees(frame(nodes, selection.omitted, selection.edges));
}

/** The two numbers the bound sentence states: drawn notes, and the total. */
export function boundCounts<T extends { slug: string }>(graph: Graph<T>): { shown: number; total: number } {
  const shown = graph.nodes.length - graph.nodes.filter((node) => node.isSubject).length;
  return { shown, total: shown + graph.omitted };
}

/** Whether there is a graph worth drawing at all. */
export function hasDrawableGraph<T extends { slug: string }>(graph: Graph<T>): boolean {
  return graph.edges.length > 0;
}

/** The notes each drawn node is joined to, within the figure. */
export function drawnNeighbours<T extends { slug: string; title: string }>(graph: Graph<T>): Map<string, T[]> {
  const bySlug = new Map(graph.nodes.map((node) => [node.entry.slug, node.entry]));
  const joined = new Map<string, T[]>(
    graph.nodes.map((node) => [node.entry.slug, [] as T[]]),
  );
  for (const edge of graph.edges) {
    joined.get(edge.from)?.push(bySlug.get(edge.to)!);
    joined.get(edge.to)?.push(bySlug.get(edge.from)!);
  }
  for (const list of joined.values()) list.sort(byTitleThenSlug);
  return joined;
}
