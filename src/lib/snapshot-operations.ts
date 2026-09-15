/**
 * The named snapshot operations, over a minimal row-reader adapter.
 *
 * One implementation serves the browser Worker and any native caller: the
 * adapter only has to run a fixed SQL string with bound parameters and return
 * rows. The semantics are `docs/core-design/sqlite-contract.md`'s: cursor
 * pagination continues after the last returned slug, graph selection precedes
 * induced-edge extraction, and graph degree counts distinct adjacent notes.
 */

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SNAPSHOT_QUERIES,
  pageOf,
  type DirectedEdge,
  type GraphSelection,
  type LocalGraphSelection,
  type NotePage,
  type NotePreview,
  type NoteSummary,
  type TagPage,
} from './snapshot-queries.ts';

/** Runs one fixed statement with bound parameters and returns its rows. */
export interface SnapshotDb {
  select(sql: string, params?: readonly unknown[]): Record<string, unknown>[];
}

/** A local graph draws at most this many neighbours, plus the center. */
export const LOCAL_NODE_LIMIT = 12;
/** The global graph draws at most this many nodes. */
export const GLOBAL_NODE_LIMIT = 60;

/** Total order over notes: title, then the unique slug. */
function byTitleThenSlug(a: { title: string; slug: string }, b: { title: string; slug: string }): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.slug < b.slug ? -1 : 1;
}

function summary(row: Record<string, unknown>): NoteSummary {
  return { slug: String(row['slug']), title: String(row['title']), language: String(row['language']) };
}

function fullNode(row: Record<string, unknown>): { id: number; slug: string; title: string; language: string } {
  return {
    id: Number(row['id']),
    slug: String(row['slug']),
    title: String(row['title']),
    language: String(row['language']),
  };
}

function graphNode(node: { slug: string; title: string; language: string }): NoteSummary {
  return { slug: node.slug, title: node.title, language: node.language };
}

function slugOf(db: SnapshotDb, slug: string): number | undefined {
  const row = db.select(SNAPSHOT_QUERIES.nodeBySlug, [slug])[0];
  return row === undefined ? undefined : Number(row['id']);
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

/** Preview one published note, or `null` for an unknown or withheld slug. */
export function preview(db: SnapshotDb, slug: string): NotePreview | null {
  const node = db.select(SNAPSHOT_QUERIES.previewNode, [slug])[0];
  if (node === undefined) return null;
  const aliases = db.select(SNAPSHOT_QUERIES.previewAliases, [Number(node['id'])]).map((row) =>
    String(row['alias']),
  );
  return {
    slug: String(node['slug']),
    title: String(node['title']),
    excerpt: String(node['excerpt']),
    language: String(node['language']),
    aliases,
  };
}

/** One page of outgoing or backlinks for a known subject. */
export function edgePage(
  db: SnapshotDb,
  direction: 'outgoing' | 'backlinks',
  slug: string,
  cursor: string | null | undefined,
  pageSize: number | undefined,
): { known: boolean; page: NotePage } {
  const id = slugOf(db, slug);
  if (id === undefined) return { known: false, page: { notes: [], nextCursor: null } };
  const size = clampPageSize(pageSize);
  const first = direction === 'outgoing' ? SNAPSHOT_QUERIES.outgoingFirst : SNAPSHOT_QUERIES.backlinksFirst;
  const after = direction === 'outgoing' ? SNAPSHOT_QUERIES.outgoingAfter : SNAPSHOT_QUERIES.backlinksAfter;
  const rows =
    cursor === undefined || cursor === null
      ? db.select(first, [id, size + 1])
      : db.select(after, [id, cursor, size + 1]);
  const { items, nextCursor } = pageOf(rows.map(summary), size);
  return { known: true, page: { notes: items, nextCursor } };
}

/** One page of notes carrying a canonical tag, or an unknown-tag result. */
export function tagPage(
  db: SnapshotDb,
  tagKey: string,
  cursor: string | null | undefined,
  pageSize: number | undefined,
): TagPage {
  const tag = db.select(SNAPSHOT_QUERIES.tagByKey, [tagKey])[0];
  if (tag === undefined) return { known: false };
  const size = clampPageSize(pageSize);
  const rows =
    cursor === undefined || cursor === null
      ? db.select(SNAPSHOT_QUERIES.byTagFirst, [tagKey, size + 1])
      : db.select(SNAPSHOT_QUERIES.byTagAfter, [tagKey, cursor, size + 1]);
  const { items, nextCursor } = pageOf(rows.map(summary), size);
  return { known: true, tag: { key: String(tag['key']), label: String(tag['label']) }, notes: items, nextCursor };
}

interface EdgeRow {
  source_id: number;
  target_id: number;
}

/** Distinct-neighbour adjacency over the candidate node set. */
function adjacency(
  nodes: readonly { id: number }[],
  edges: readonly EdgeRow[],
): Map<number, Set<number>> {
  const present = new Set(nodes.map((node) => node.id));
  const neighbours = new Map<number, Set<number>>(nodes.map((node) => [node.id, new Set<number>()]));
  for (const edge of edges) {
    if (!present.has(edge.source_id) || !present.has(edge.target_id)) continue;
    neighbours.get(edge.source_id)!.add(edge.target_id);
    neighbours.get(edge.target_id)!.add(edge.source_id);
  }
  return neighbours;
}

function inducedEdges(
  selected: readonly { id: number; slug: string }[],
  edges: readonly EdgeRow[],
): DirectedEdge[] {
  const slugById = new Map(selected.map((node) => [node.id, node.slug]));
  const drawn = new Set(slugById.keys());
  const result: DirectedEdge[] = [];
  for (const edge of edges) {
    if (!drawn.has(edge.source_id) || !drawn.has(edge.target_id)) continue;
    result.push({ from: slugById.get(edge.source_id)!, to: slugById.get(edge.target_id)! });
  }
  result.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1));
  return result;
}

/** The one-hop neighbourhood of a known center: union of incoming and outgoing. */
export function localGraph(db: SnapshotDb, slug: string): LocalGraphSelection | null {
  const center = db.select(SNAPSHOT_QUERIES.nodeBySlug, [slug])[0];
  if (center === undefined) return null;
  const centerNode = fullNode(center);
  const neighbors = db
    .select(SNAPSHOT_QUERIES.neighbors, [centerNode.id, centerNode.id])
    .map(fullNode)
    .sort(byTitleThenSlug);
  const drawn = neighbors.slice(0, LOCAL_NODE_LIMIT);
  const edges = db.select(SNAPSHOT_QUERIES.allEdges) as unknown as EdgeRow[];
  const selected = [centerNode, ...drawn];
  return {
    center: graphNode(centerNode),
    nodes: drawn.map(graphNode),
    edges: inducedEdges(selected, edges),
    omitted: neighbors.length - drawn.length,
  };
}

/** The ranked global graph, optionally restricted to one tag's members. */
export function globalGraph(db: SnapshotDb, tagKey?: string | null): GraphSelection {
  const all = (db.select(SNAPSHOT_QUERIES.allNodes) as unknown as Record<string, unknown>[]).map(fullNode);
  const edges = db.select(SNAPSHOT_QUERIES.allEdges) as unknown as EdgeRow[];

  let nodes = all;
  if (tagKey !== undefined && tagKey !== null) {
    const members = new Set(
      (db.select(SNAPSHOT_QUERIES.tagNodeIds, [tagKey]) as unknown as { id: number }[]).map((row) => Number(row.id)),
    );
    nodes = all.filter((node) => members.has(node.id));
  }

  const neighbours = adjacency(nodes, edges);
  const ranked = [...nodes].sort((a, b) => {
    const left = neighbours.get(a.id)!.size;
    const right = neighbours.get(b.id)!.size;
    if (left !== right) return right - left;
    return byTitleThenSlug(a, b);
  });
  const selected = ranked.slice(0, GLOBAL_NODE_LIMIT);
  return {
    nodes: selected.map(graphNode),
    edges: inducedEdges(selected, edges),
    omitted: ranked.length - selected.length,
  };
}
