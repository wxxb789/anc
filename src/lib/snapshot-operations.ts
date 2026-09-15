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
  type GraphSelection,
  type LocalGraphSelection,
  type NotePage,
  type NotePreview,
  type NoteSummary,
  type TagPage,
} from './snapshot-queries.ts';
import { selectGlobal, selectLocal } from './graph-selection.ts';

/** Runs one fixed statement with bound parameters and returns its rows. */
export interface SnapshotDb {
  select(sql: string, params?: readonly unknown[]): Record<string, unknown>[];
}

/** The presentation bounds, re-exported from the shared selection contract. */
export { GLOBAL_NODE_LIMIT, LOCAL_NODE_LIMIT } from './graph-selection.ts';

function summary(row: Record<string, unknown>): NoteSummary {
  return { slug: String(row['slug']), title: String(row['title']), language: String(row['language']) };
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

/** One node as the shared selection contract sees it. */
function selectionNode(row: Record<string, unknown>): { id: number; slug: string; title: string; language: string } {
  return {
    id: Number(row['id']),
    slug: String(row['slug']),
    title: String(row['title']),
    language: String(row['language']),
  };
}

/** The public summary of one selection node. */
function selectionSummary(node: { slug: string; title: string; language: string }): NoteSummary {
  return { slug: node.slug, title: node.title, language: node.language };
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
  const edges = (
    db.select(SNAPSHOT_QUERIES.allEdgesBySlug) as unknown as { source: string; target: string }[]
  ).map((row) => ({ from: row.source, to: row.target }));
  const selection = selectLocal(centerNode, neighbours, edges);
  return {
    center: selectionSummary(centerNode),
    nodes: selection.drawn.map(selectionSummary),
    edges: selection.edges,
    omitted: selection.omitted,
  };
}

/** The ranked global graph, optionally restricted to one tag's members. */
export function globalGraph(db: SnapshotDb, tagKey?: string | null): GraphSelection {
  const all = (db.select(SNAPSHOT_QUERIES.allNodes) as unknown as Record<string, unknown>[]).map(selectionNode);
  const edges = (
    db.select(SNAPSHOT_QUERIES.allEdgesBySlug) as unknown as { source: string; target: string }[]
  ).map((row) => ({ from: row.source, to: row.target }));
  let candidates = all;
  if (tagKey !== undefined && tagKey !== null) {
    const members = new Set(
      (db.select(SNAPSHOT_QUERIES.tagNodeIds, [tagKey]) as unknown as { id: number }[]).map((row) => Number(row.id)),
    );
    candidates = all.filter((node) => members.has(node.id));
  }
  const selection = selectGlobal(candidates, edges);
  return {
    nodes: selection.nodes.map(selectionSummary),
    edges: selection.edges,
    omitted: selection.omitted,
  };
}
