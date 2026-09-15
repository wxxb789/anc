/**
 * The graph, as the build sees it.
 *
 * This module is the IR adapter over the shared contract: it turns a note's
 * `outgoing`/`backlinks` into the directed edge set, asks `graph-selection.ts`
 * for the bounded local/global selection, and asks `graph-layout.ts` for the
 * coordinates. The Worker selects through the same `graph-selection.ts` and the
 * explorer lays out through the same `graph-layout.ts`, so the static SVG/table
 * and the browser graph cannot disagree about which notes are drawn.
 */

import type { ContentEntry } from './schema.ts';
import { selectGlobal, selectLocal, type SelectionEdge } from './graph-selection.ts';
import {
  layoutGlobal,
  layoutLocal,
  type Graph as LayoutGraph,
  type GraphEdge as LayoutGraphEdge,
  type GraphNode as LayoutGraphNode,
} from './graph-layout.ts';

/** A laid-out graph whose nodes carry the full entry the page renders. */
export type Graph = LayoutGraph<ContentEntry>;
/** One drawn note. */
export type GraphNode = LayoutGraphNode<ContentEntry>;
/** One drawn relationship. */
export type GraphEdge = LayoutGraphEdge;

export { GLOBAL_NODE_LIMIT, LOCAL_NODE_LIMIT, type EdgeDirection } from './graph-selection.ts';
export {
  NODE_RADIUS,
  SUBJECT_RADIUS,
  boundCounts,
  drawnNeighbours,
  hasDrawableGraph,
  truncateLabel,
} from './graph-layout.ts';

/** Every note this one is joined to by an authored edge, in either direction. */
function neighbourSlugs(entry: ContentEntry): string[] {
  return [...new Set([...entry.outgoing, ...entry.backlinks])];
}

/** The directed edges among `nodes`, restricted to the drawn endpoints. */
function edgesAmong(nodes: readonly ContentEntry[]): SelectionEdge[] {
  const present = new Set(nodes.map((node) => node.slug));
  const edges: SelectionEdge[] = [];
  for (const node of nodes) {
    for (const target of node.outgoing) {
      if (present.has(target)) edges.push({ from: node.slug, to: target });
    }
  }
  return edges;
}

/** The one-hop neighbourhood of one note: the union of incoming and outgoing. */
export function localGraph(
  entry: ContentEntry,
  lookup: (slug: string) => ContentEntry | undefined,
  limit?: number,
): Graph {
  const neighbours = neighbourSlugs(entry)
    .map(lookup)
    .filter((candidate): candidate is ContentEntry => candidate !== undefined);
  return layoutLocal(selectLocal(entry, neighbours, edgesAmong([entry, ...neighbours]), limit));
}

/** The site-wide graph, ranked by distinct adjacent notes in the corpus. */
export function globalGraph(entries: readonly ContentEntry[], limit?: number): Graph {
  const corpus = [...entries];
  return layoutGlobal(selectGlobal(corpus, edgesAmong(corpus), limit));
}
