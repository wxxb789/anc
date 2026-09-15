/**
 * Named query surface over the public snapshot.
 *
 * One module owns the fixed, parameterized SQL and the typed shape of every
 * result, so the native build driver (`node:sqlite`) and the browser WASM driver
 * run the same statements rather than two reconstructions that can disagree.
 * Execution is the adapter's job; this file is SQL, row types, and the pure
 * pagination/selection rules.
 *
 * `docs/core-design/sqlite-contract.md` owns the semantics, especially:
 * pagination continues **after the last returned slug** and never from the
 * lookahead row, and graph selection happens **before** induced-edge extraction.
 */

/** A note as it appears in a relationship list: the fields a label needs. */
export interface NoteSummary {
  slug: string;
  title: string;
  /** Effective language, already `entry.language ?? NAV_LANGUAGE` in the DB. */
  language: string;
}

/** A note preview: a summary plus its bounded excerpt and authored aliases. */
export interface NotePreview extends NoteSummary {
  excerpt: string;
  /** Author order, as stored by ordinal. */
  aliases: string[];
}

/** One page of a cursor-paginated note list. */
export interface NotePage {
  notes: NoteSummary[];
  /** Last returned slug when more rows exist; `null` at exhaustion. */
  nextCursor: string | null;
}

/** A canonical tag and its display label. */
export interface TagIdentity {
  key: string;
  label: string;
}

/** Results of a `byTag` request: an unknown tag is distinct from an empty page. */
export type TagPage =
  | { known: false }
  | ({ known: true; tag: TagIdentity } & NotePage);

/** One directed edge between two nodes in a selection, by slug. */
export interface DirectedEdge {
  from: string;
  to: string;
}

/** A graph selection: drawn nodes, every induced edge, and the omitted count. */
export interface GraphSelection {
  nodes: NoteSummary[];
  edges: DirectedEdge[];
  omitted: number;
}

/** A local graph adds the center, which is never counted as its own neighbour. */
export interface LocalGraphSelection extends GraphSelection {
  center: NoteSummary;
}

/**
 * Every statement the snapshot contract exposes. Named parameters are positional
 * (`?`) rather than named because both drivers bind arrays identically and no
 * statement needs the same value twice.
 */
export const SNAPSHOT_QUERIES = {
  previewNode: `
    SELECT id, slug, title, excerpt, language
    FROM nodes
    WHERE slug = ?`.trim(),

  previewAliases: `
    SELECT alias
    FROM aliases
    WHERE node_id = ?
    ORDER BY ordinal`.trim(),

  outgoingFirst: `
    SELECT n.slug, n.title, n.language
    FROM edges AS e
    JOIN nodes AS n ON n.id = e.target_id
    WHERE e.source_id = ?
    ORDER BY n.slug
    LIMIT ?`.trim(),

  outgoingAfter: `
    SELECT n.slug, n.title, n.language
    FROM edges AS e
    JOIN nodes AS n ON n.id = e.target_id
    WHERE e.source_id = ? AND n.slug > ?
    ORDER BY n.slug
    LIMIT ?`.trim(),

  backlinksFirst: `
    SELECT n.slug, n.title, n.language
    FROM edges AS e
    JOIN nodes AS n ON n.id = e.source_id
    WHERE e.target_id = ?
    ORDER BY n.slug
    LIMIT ?`.trim(),

  backlinksAfter: `
    SELECT n.slug, n.title, n.language
    FROM edges AS e
    JOIN nodes AS n ON n.id = e.source_id
    WHERE e.target_id = ? AND n.slug > ?
    ORDER BY n.slug
    LIMIT ?`.trim(),

  tagByKey: `
    SELECT id, key, label
    FROM tags
    WHERE key = ?`.trim(),

  byTagFirst: `
    SELECT n.slug, n.title, n.language
    FROM tags AS t
    JOIN node_tags AS nt ON nt.tag_id = t.id
    JOIN nodes AS n ON n.id = nt.node_id
    WHERE t.key = ?
    ORDER BY n.slug
    LIMIT ?`.trim(),

  byTagAfter: `
    SELECT n.slug, n.title, n.language
    FROM tags AS t
    JOIN node_tags AS nt ON nt.tag_id = t.id
    JOIN nodes AS n ON n.id = nt.node_id
    WHERE t.key = ? AND n.slug > ?
    ORDER BY n.slug
    LIMIT ?`.trim(),

  /**
   * One-hop neighbours, incoming and outgoing unioned once. The union is over
   * ids, so a reciprocal pair appears once and the center is never a neighbour.
   */
  neighbors: `
    WITH neighbors(id) AS (
        SELECT target_id FROM edges WHERE source_id = ?
        UNION
        SELECT source_id FROM edges WHERE target_id = ?
    )
    SELECT n.id, n.slug, n.title, n.language
    FROM neighbors AS x
    JOIN nodes AS n ON n.id = x.id
    ORDER BY n.slug`.trim(),

  nodeBySlug: `
    SELECT id, slug, title, language
    FROM nodes
    WHERE slug = ?`.trim(),

  allNodes: `
    SELECT id, slug, title, language
    FROM nodes
    ORDER BY slug`.trim(),

  allEdges: `
    SELECT source_id, target_id
    FROM edges
    ORDER BY source_id, target_id`.trim(),

  tagNodeIds: `
    SELECT n.id, n.slug
    FROM tags AS t
    JOIN node_tags AS nt ON nt.tag_id = t.id
    JOIN nodes AS n ON n.id = nt.node_id
    WHERE t.key = ?
    ORDER BY n.slug`.trim(),

  allTags: `
    SELECT id, key, label
    FROM tags
    ORDER BY key`.trim(),

  tagMemberSlugs: `
    SELECT n.slug
    FROM node_tags AS nt
    JOIN nodes AS n ON n.id = nt.node_id
    WHERE nt.tag_id = ?
    ORDER BY n.slug`.trim(),

  schemaTables: `
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`.trim(),
} as const;

/**
 * Turn up to `pageSize + 1` ordered rows into one page.
 *
 * `nextCursor` is the last **returned** slug, never the lookahead row's; a
 * cursor built from the extra row skips a real result on the next request.
 */
export function pageOf<T extends { slug: string }>(rows: readonly T[], pageSize: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, pageSize);
  const nextCursor = rows.length > pageSize ? (items.at(-1)?.slug ?? null) : null;
  return { items, nextCursor };
}

/** A canonical note slug: lowercase, hyphen-separated, no traversal or dot. */
const LOOKUP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a slug is a plausible lookup key before a query is attempted.
 *
 * Uses the note-slug grammar rather than only a length bound: SQL binds the
 * value as a parameter, so a traversal string cannot escape, but a request that
 * is not a slug is a caller defect that should fail as `bad-argument` rather
 * than silently return "no match".
 */
export function isLookupSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && LOOKUP_SLUG.test(value);
}

/** Route-key characters a canonical tag key may carry; no separators or controls. */
const LOOKUP_TAG_INVALID = /[/\p{Cc}\p{Cf}]/u;

/**
 * Whether a canonical tag key is plausible before a query is attempted.
 *
 * Wider than a slug because a tag key may be any script (including CJK and
 * combining marks) and may contain `_`; it must still be one path segment.
 */
export function isLookupTagKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !LOOKUP_TAG_INVALID.test(value)
  );
}

/**
 * Bound a requested page size to the accepted range. The Worker validates this
 * rather than trusting a caller-supplied number; LIMIT bounds output, not work.
 */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export function normalizePageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}
