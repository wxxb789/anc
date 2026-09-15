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
  SNAPSHOT_QUERIES,
  normalizePageSize,
  pageOf,
  type GraphSelection,
  type LocalGraphSelection,
  type NotePage,
  type NotePreview,
  type NoteSummary,
  type TagPage,
} from './snapshot-queries.ts';
import { rankGlobal, inducedEdges, selectLocal, GLOBAL_NODE_LIMIT, type SelectionEdge } from './graph-selection.ts';

/** Runs one fixed statement with bound parameters and returns its rows. */
export interface SnapshotDb {
  select(sql: string, params?: readonly unknown[]): Record<string, unknown>[];
}

function summary(row: Record<string, unknown>): NoteSummary {
  return selectionSummary(selectionNode(row));
}

function slugOf(db: SnapshotDb, slug: string): number | undefined {
  const row = db.select(SNAPSHOT_QUERIES.nodeBySlug, [slug])[0];
  return row === undefined ? undefined : Number(row['id']);
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
  const size = normalizePageSize(pageSize);
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
  const size = normalizePageSize(pageSize);
  const rows =
    cursor === undefined || cursor === null
      ? db.select(SNAPSHOT_QUERIES.byTagFirst, [tagKey, size + 1])
      : db.select(SNAPSHOT_QUERIES.byTagAfter, [tagKey, cursor, size + 1]);
  const { items, nextCursor } = pageOf(rows.map(summary), size);
  return { known: true, tag: { key: String(tag['key']), label: String(tag['label']) }, notes: items, nextCursor };
}

/** One node as the shared selection contract sees it. */
function selectionNode(row: Record<string, unknown>): { id: number; slug: string; title: string; language: string } {
  return {
    id: Number(row['id']),
    slug: String(row['slug']),
    title: String(row['title']),
    language: String(row['language']),
  };
}

/**
 * The directed edges whose two endpoints are all in `ids`.
 *
 * Bound placeholders, never interpolated data. This is the contract's "after
 * choosing the displayed nodes, query all directed edges whose two endpoints
 * belong to that set": scanning every edge in the corpus made a 10,000-note
 * local graph O(corpus) per request and missed the warm target.
 */
function edgesAmongIds(db: SnapshotDb, ids: readonly number[]): SelectionEdge[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const sql =
    `SELECT s.slug AS source, t.slug AS target FROM edges AS e ` +
    `JOIN nodes AS s ON s.id = e.source_id JOIN nodes AS t ON t.id = e.target_id ` +
    `WHERE e.source_id IN (${placeholders}) AND e.target_id IN (${placeholders}) ` +
    `ORDER BY source, target`;
  return (db.select(sql, [...ids, ...ids]) as unknown as { source: string; target: string }[]).map((row) => ({
    from: row.source,
    to: row.target,
  }));
}

/** The public summary of one selection node. */
function selectionSummary(node: { slug: string; title: string; language: string }): NoteSummary {
  return { slug: node.slug, title: node.title, language: node.language };
}

/** `nodeDegrees`/`tagNodeDegrees` rows as the rank function's degree lookup. */
function degreeMap(rows: readonly Record<string, unknown>[]): Map<number, number> {
  return new Map(rows.map((row) => [Number(row['id']), Number(row['degree'])]));
}

/**
 * The one-hop neighbourhood of a known center.
 *
 * The SQL `UNION` deduplicates incoming/outgoing and the shared selection
 * contract sorts, limits, and extracts induced edges, so the Worker and the
 * build cannot disagree about the drawn set.
 */
export function localGraph(db: SnapshotDb, slug: string): LocalGraphSelection | null {
  const center = db.select(SNAPSHOT_QUERIES.nodeBySlug, [slug])[0];
  if (center === undefined) return null;
  const centerNode = selectionNode(center);
  const neighbours = db
    .select(SNAPSHOT_QUERIES.neighbors, [centerNode.id, centerNode.id])
    .map(selectionNode);
  // Choose the drawn set first, then read only the edges among it.
  const preliminary = selectLocal(centerNode, neighbours, []);
  const ids = [centerNode.id, ...preliminary.drawn.map((node) => node.id)];
  const selected = new Set([centerNode.slug, ...preliminary.drawn.map((node) => node.slug)]);
  return {
    center: selectionSummary(centerNode),
    nodes: preliminary.drawn.map(selectionSummary),
    edges: inducedEdges(selected, edgesAmongIds(db, ids)),
    omitted: preliminary.omitted,
  };
}

/**
 * The ranked global graph, optionally restricted to one tag's members.
 *
 * Ranking has one authority: `rankGlobal` orders by degree in the candidate
 * graph, descending, then title/slug. The unfiltered case takes degrees from
 * one aggregate over the edge set; the filtered case takes the tag's member
 * rows and their in-tag degrees from tag-scoped statements, so filtering never
 * pulls the corpus' edge rows into JS. Only after the drawn set is chosen are
 * the directed edges among it read.
 */
export function globalGraph(db: SnapshotDb, tagKey?: string | null): GraphSelection {
  const filtered = tagKey !== undefined && tagKey !== null;
  const candidates = db
    .select(filtered ? SNAPSHOT_QUERIES.tagNodes : SNAPSHOT_QUERIES.allNodes, filtered ? [tagKey] : [])
    .map(selectionNode);
  const degrees = degreeMap(
    db.select(filtered ? SNAPSHOT_QUERIES.tagNodeDegrees : SNAPSHOT_QUERIES.nodeDegrees, filtered ? [tagKey] : []),
  );

  const ranked = rankGlobal(candidates, (node) => degrees.get(node.id) ?? 0);
  const selected = ranked.slice(0, GLOBAL_NODE_LIMIT);
  const selectedSlugs = new Set(selected.map((node) => node.slug));
  return {
    nodes: selected.map(selectionSummary),
    edges: inducedEdges(selectedSlugs, edgesAmongIds(db, selected.map((node) => node.id))),
    omitted: ranked.length - selected.length,
  };
}
