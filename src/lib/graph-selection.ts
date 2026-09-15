/**
 * The graph selection contract, shared by the build and the browser Worker.
 *
 * `docs/core-design/content-semantics.md` owns these rules: selection precedes
 * induced-edge extraction, degree counts distinct adjacent notes in the
 * candidate graph, a reciprocal pair is one neighbour, and the limits are
 * presentation bounds rather than corpus bounds.
 *
 * Pure and dependency-free, so the same functions can run over `node:sqlite`
 * results at build time, over the Worker's WASM results, and in a unit test.
 */

/** How an edge runs relative to the note the reader is on. */
export type EdgeDirection = 'outgoing' | 'incoming' | 'mutual';

/** The minimum a selection needs to rank, order, and look up a node. */
export interface SelectionNode {
  slug: string;
  title: string;
  language?: string;
}

/** One directed authored edge. A reciprocal pair is two entries here. */
export interface SelectionEdge {
  from: string;
  to: string;
}

/** Local presentation bound: drawn neighbours, not counting the center. */
export const LOCAL_NODE_LIMIT = 12;
/** Global presentation bound: drawn nodes. */
export const GLOBAL_NODE_LIMIT = 60;

/** Total order over notes: title, then the unique slug so no tie is left open. */
export function byTitleThenSlug(a: { title: string; slug: string }, b: { title: string; slug: string }): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.slug < b.slug ? -1 : 1;
}

/** Every directed edge with both ends selected, deduplicated and sorted. */
export function inducedEdges(
  selected: ReadonlySet<string>,
  edges: readonly SelectionEdge[],
): SelectionEdge[] {
  const seen = new Set<string>();
  const result: SelectionEdge[] = [];
  for (const edge of edges) {
    if (!selected.has(edge.from) || !selected.has(edge.to) || edge.from === edge.to) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ from: edge.from, to: edge.to });
  }
  result.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1));
  return result;
}

export interface LocalSelection<T extends SelectionNode> {
  center: T;
  /** Every distinct resolved neighbour, sorted, before the bound. */
  candidates: T[];
  /** The neighbours the bound kept. */
  drawn: T[];
  /** Induced directed edges over `[center, ...drawn]`. */
  edges: SelectionEdge[];
  /** `candidates.length - drawn.length`; the center is in neither number. */
  omitted: number;
}

export interface GlobalSelection<T extends SelectionNode> {
  nodes: T[];
  edges: SelectionEdge[];
  /** `candidateCount - nodes.length`, from the candidate graph. */
  omitted: number;
}

/**
 * Local contract: dedupe already done by the caller, sort by title/slug, take
 * up to `limit` neighbours **plus** the center, then extract induced edges.
 */
export function selectLocal<T extends SelectionNode>(
  center: T,
  neighbours: readonly T[],
  edges: readonly SelectionEdge[],
  limit: number = LOCAL_NODE_LIMIT,
): LocalSelection<T> {
  const candidates = [...neighbours].sort(byTitleThenSlug);
  const drawn = candidates.slice(0, limit);
  const selected = new Set<string>([center.slug, ...drawn.map((node) => node.slug)]);
  return { center, candidates, drawn, edges: inducedEdges(selected, edges), omitted: candidates.length - drawn.length };
}

/**
 * The global ranking rule: degree in the candidate graph descending, then the
 * shared title/slug order. Exported so the Worker's SQL-aggregated path and
 * `selectGlobal`'s edge-walking path share one implementation instead of two
 * copies that a test has to hold together.
 */
export function rankGlobal<T extends SelectionNode>(
  candidates: readonly T[],
  degreeOf: (node: T) => number,
): T[] {
  return [...candidates].sort((a, b) => {
    const left = degreeOf(a);
    const right = degreeOf(b);
    if (left !== right) return right - left;
    return byTitleThenSlug(a, b);
  });
}

/**
 * Global contract: rank by the number of distinct adjacent notes **in the
 * candidate graph** (descending), then title/slug, then truncate and extract
 * induced edges over the drawn set.
 */
export function selectGlobal<T extends SelectionNode>(
  candidates: readonly T[],
  edges: readonly SelectionEdge[],
  limit: number = GLOBAL_NODE_LIMIT,
): GlobalSelection<T> {
  const present = new Set(candidates.map((node) => node.slug));
  const neighbours = new Map<string, Set<string>>(candidates.map((node) => [node.slug, new Set<string>()]));
  for (const edge of edges) {
    if (!present.has(edge.from) || !present.has(edge.to) || edge.from === edge.to) continue;
    neighbours.get(edge.from)!.add(edge.to);
    neighbours.get(edge.to)!.add(edge.from);
  }
  const ranked = rankGlobal(candidates, (node) => neighbours.get(node.slug)!.size);
  const nodes = ranked.slice(0, limit);
  return {
    nodes,
    edges: inducedEdges(new Set(nodes.map((node) => node.slug)), edges),
    omitted: ranked.length - nodes.length,
  };
}
