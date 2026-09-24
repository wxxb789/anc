/**
 * The DB-side oracle: finalized snapshot analysis, the workload plan derived
 * from it, independently ranked graph selections, and the field-for-field
 * comparisons between what the runtime rendered and what the DB implies.
 */

import type { DatabaseSync } from '../src/lib/sqlite.ts';
import {
  GLOBAL_NODE_LIMIT,
  LOCAL_NODE_LIMIT,
  type SelectionEdge,
  type SelectionNode,
} from '../src/lib/graph-selection.ts';
import type { GeneratedCorpus } from './generate-corpus.ts';
import type { corpusTextStats } from './benchmark-corpus.ts';
import { distributionOf, fieldLengthDistribution, type FieldLengthDistribution, type NumericDistribution } from './benchmark-stats.ts';

export interface GraphSelectionShape {
  nodes: { slug: string; title: string; language: string }[];
  edges: { from: string; to: string }[];
  omitted: number;
}

/** Compare every public graph field, including directed edge identity and order. */
export function compareGraphSelection(
  actual: GraphSelectionShape,
  expected: GraphSelectionShape,
  label: string,
): string | null {
  if (JSON.stringify(actual.nodes) !== JSON.stringify(expected.nodes)) {
    return `${label}: nodes differ (actual ${JSON.stringify(actual.nodes)}, expected ${JSON.stringify(expected.nodes)})`;
  }
  if (JSON.stringify(actual.edges) !== JSON.stringify(expected.edges)) {
    return `${label}: edges differ (actual ${JSON.stringify(actual.edges)}, expected ${JSON.stringify(expected.edges)})`;
  }
  if (actual.omitted !== expected.omitted) {
    return `${label}: omitted differs (actual ${actual.omitted}, expected ${expected.omitted})`;
  }
  return null;
}

interface DegreeRow {
  slug: string;
  degree: number;
}

export interface DatabaseIdentity {
  file: string;
  sha256: string;
  digestMatchesFileName: boolean;
  rows: { nodes: number; edges: number; aliases: number; tags: number; nodeTags: number };
  notesPublished: number;
  notesWithheld: number | null;
  inDegree: { distribution: NumericDistribution; top: DegreeRow[] };
  outDegree: { distribution: NumericDistribution; top: DegreeRow[] };
  fieldLengths: {
    title: FieldLengthDistribution;
    excerpt: FieldLengthDistribution;
    language: FieldLengthDistribution;
    aliases: FieldLengthDistribution;
    tagKeys: FieldLengthDistribution;
    tagLabels: FieldLengthDistribution;
  };
  corpus: ReturnType<typeof corpusTextStats>;
}

export interface WorkloadPlan {
  pageSlug: string;
  previewSlug: string;
  backlinkAnchor: string;
  outgoingAnchor: string;
  localCenter: string;
  tagKey: string | null;
  tagLabel: string | null;
  tagMembers: number;
  nodeCount: number;
  edgeCount: number;
}

export interface DatabaseAnalysis {
  identity: DatabaseIdentity;
  plan: WorkloadPlan;
  inDegree: Map<string, number>;
  outDegree: Map<string, number>;
  nodes: (SelectionNode & { id: number })[];
  edges: SelectionEdge[];
}

export interface GraphOracleSelection {
  center: string | null;
  selection: GraphSelectionShape;
}

function oracleNodeOrder(a: SelectionNode, b: SelectionNode): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

function oracleInducedEdges(selected: ReadonlySet<string>, edges: readonly SelectionEdge[]): SelectionEdge[] {
  const seen = new Set<string>();
  const result: SelectionEdge[] = [];
  for (const edge of edges) {
    if (edge.from === edge.to || !selected.has(edge.from) || !selected.has(edge.to)) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ from: edge.from, to: edge.to });
  }
  return result.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** Independently derive the expected ranked graph from finalized DB rows and edges. */
type GraphOracleRequest =
  | { scope: 'local'; centerSlug: string }
  | { scope: 'global'; candidateSlugs?: ReadonlySet<string> };

export function graphOracleSelection(
  nodes: readonly (SelectionNode & { id: number })[],
  edges: readonly SelectionEdge[],
  request: GraphOracleRequest,
): GraphOracleSelection {
  if (request.scope === 'local') {
    const { centerSlug } = request;
    const center = nodes.find((node) => node.slug === centerSlug);
    if (center === undefined) throw new Error(`local graph oracle center is unknown: ${centerSlug}`);
    const neighbourSlugs = new Set<string>();
    for (const edge of edges) {
      if (edge.from === centerSlug) neighbourSlugs.add(edge.to);
      if (edge.to === centerSlug) neighbourSlugs.add(edge.from);
    }
    const candidates = nodes
      .filter((node) => node.slug !== centerSlug && neighbourSlugs.has(node.slug))
      .sort(oracleNodeOrder);
    const drawn = candidates.slice(0, LOCAL_NODE_LIMIT);
    const selectedSlugs = new Set([center.slug, ...drawn.map((node) => node.slug)]);
    return {
      center: center.slug,
      selection: {
        nodes: drawn.map(({ slug, title, language }) => ({ slug, title, language: language ?? '' })),
        edges: oracleInducedEdges(selectedSlugs, edges),
        omitted: candidates.length - drawn.length,
      },
    };
  }
  const { candidateSlugs } = request;
  const candidates = candidateSlugs === undefined ? [...nodes] : nodes.filter((node) => candidateSlugs.has(node.slug));
  const candidateSet = new Set(candidates.map((node) => node.slug));
  const candidateEdges = edges.filter((edge) => candidateSet.has(edge.from) && candidateSet.has(edge.to));
  const neighbours = new Map(candidates.map((node) => [node.slug, new Set<string>()]));
  for (const edge of candidateEdges) {
    if (edge.from === edge.to) continue;
    neighbours.get(edge.from)!.add(edge.to);
    neighbours.get(edge.to)!.add(edge.from);
  }
  const ranked = candidates.sort((a, b) => {
    const degree = neighbours.get(b.slug)!.size - neighbours.get(a.slug)!.size;
    return degree === 0 ? oracleNodeOrder(a, b) : degree;
  });
  const drawn = ranked.slice(0, GLOBAL_NODE_LIMIT);
  const selectedSlugs = new Set(drawn.map((node) => node.slug));
  return {
    center: null,
    selection: {
      nodes: drawn.map(({ slug, title, language }) => ({ slug, title, language: language ?? '' })),
      edges: oracleInducedEdges(selectedSlugs, candidateEdges),
      omitted: ranked.length - drawn.length,
    },
  };
}

export function queryRows<T>(db: DatabaseSync, sql: string, params: readonly (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function queryValue(
  db: DatabaseSync,
  sql: string,
  params: readonly (string | number | null)[] = [],
): unknown {
  const row = queryRows<Record<string, unknown>>(db, sql, params)[0];
  return row === undefined ? undefined : Object.values(row)[0];
}

/** Read directed graph edges without using SQLite keyword-shaped aliases. */
export function selectionEdges(db: DatabaseSync): SelectionEdge[] {
  return queryRows<{ sourceSlug: string; targetSlug: string }>(
    db,
    `SELECT s.slug AS sourceSlug, t.slug AS targetSlug
     FROM edges AS e
     JOIN nodes AS s ON s.id = e.source_id
     JOIN nodes AS t ON t.id = e.target_id
     ORDER BY s.slug, t.slug`,
  ).map((edge) => ({ from: edge.sourceSlug, to: edge.targetSlug }));
}

function topDegrees(degrees: ReadonlyMap<string, number>, nodes: readonly string[]): DegreeRow[] {
  return [...nodes]
    .map((slug) => ({ slug, degree: degrees.get(slug) ?? 0 }))
    .sort((a, b) => (b.degree !== a.degree ? b.degree - a.degree : a.slug < b.slug ? -1 : 1))
    .slice(0, 5);
}

/** Everything section A asks about the finalized DB, plus the plan the runs use. */
export function analyseDatabase(
  db: DatabaseSync,
  fileName: string,
  fileDigest: string,
  corpus: ReturnType<typeof corpusTextStats>,
  finalized: GeneratedCorpus | null,
): DatabaseAnalysis {
  const rows = {
    nodes: Number(queryValue(db, 'SELECT COUNT(*) FROM nodes') ?? 0),
    edges: Number(queryValue(db, 'SELECT COUNT(*) FROM edges') ?? 0),
    aliases: Number(queryValue(db, 'SELECT COUNT(*) FROM aliases') ?? 0),
    tags: Number(queryValue(db, 'SELECT COUNT(*) FROM tags') ?? 0),
    nodeTags: Number(queryValue(db, 'SELECT COUNT(*) FROM node_tags') ?? 0),
  };
  const nodeRows = queryRows<{ id: number; slug: string; title: string; language: string; excerpt: string | null }>(
    db,
    'SELECT id, slug, title, excerpt, language FROM nodes ORDER BY slug',
  );
  const nodes = nodeRows.map((row) => row.slug);
  const selectionNodes = nodeRows.map((row) => ({
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    language: row.language,
  }));
  const edges = selectionEdges(db);
  // Seed every published node so isolated nodes contribute zero to the
  // distribution, not only to the top-list fallback.
  const inDegree = new Map<string, number>(nodes.map((slug): [string, number] => [slug, 0]));
  const outDegree = new Map<string, number>(nodes.map((slug): [string, number] => [slug, 0]));
  for (const row of queryRows<{ slug: string; degree: number }>(
    db,
    `SELECT n.slug AS slug, COUNT(*) AS degree
     FROM edges AS e JOIN nodes AS n ON n.id = e.target_id
     GROUP BY n.id`,
  )) {
    inDegree.set(row.slug, Number(row.degree));
  }
  for (const row of queryRows<{ slug: string; degree: number }>(
    db,
    `SELECT n.slug AS slug, COUNT(*) AS degree
     FROM edges AS e JOIN nodes AS n ON n.id = e.source_id
     GROUP BY n.id`,
  )) {
    outDegree.set(row.slug, Number(row.degree));
  }
  const total = new Map<string, number>();
  for (const slug of nodes) total.set(slug, (inDegree.get(slug) ?? 0) + (outDegree.get(slug) ?? 0));
  const byTotal = [...nodes].sort((a, b) =>
    (total.get(b) ?? 0) !== (total.get(a) ?? 0) ? (total.get(b) ?? 0) - (total.get(a) ?? 0) : a < b ? -1 : 1,
  );
  const byIn = [...nodes].sort((a, b) =>
    (inDegree.get(b) ?? 0) !== (inDegree.get(a) ?? 0) ? (inDegree.get(b) ?? 0) - (inDegree.get(a) ?? 0) : a < b ? -1 : 1,
  );
  const byOut = [...nodes].sort((a, b) =>
    (outDegree.get(b) ?? 0) !== (outDegree.get(a) ?? 0) ? (outDegree.get(b) ?? 0) - (outDegree.get(a) ?? 0) : a < b ? -1 : 1,
  );
  const busiestTag = queryRows<{ key: string; label: string; members: number }>(
    db,
    `SELECT t.key AS key, t.label AS label, COUNT(*) AS members
     FROM tags AS t JOIN node_tags AS nt ON nt.tag_id = t.id
     GROUP BY t.id
     ORDER BY members DESC, t.key ASC
     LIMIT 1`,
  )[0];
  const aliases = queryRows<{ nodeId: number; alias: string | null }>(
    db,
    'SELECT node_id AS nodeId, alias FROM aliases ORDER BY node_id, ordinal',
  );
  const tags = queryRows<{ id: number; key: string | null; label: string | null }>(
    db,
    'SELECT id, key, label FROM tags ORDER BY id',
  );
  const taggedNodeIds = new Set(
    queryRows<{ nodeId: number }>(db, 'SELECT DISTINCT node_id AS nodeId FROM node_tags').map((row) => Number(row.nodeId)),
  );
  const aliasNodeIds = new Set(aliases.map((row) => Number(row.nodeId)));
  const pageSlug = byTotal[0];
  if (pageSlug === undefined) throw new Error('the finalized DB has no published nodes');
  const digestMatch = /^site\.([0-9a-f]{64})\.sqlite$/.exec(fileName);
  return {
    identity: {
      file: `/data/${fileName}`,
      sha256: fileDigest,
      digestMatchesFileName: digestMatch?.[1] === fileDigest,
      rows,
      notesPublished: rows.nodes,
      notesWithheld: finalized === null ? null : finalized.withheld,
      inDegree: { distribution: distributionOf([...inDegree.values()]), top: topDegrees(inDegree, nodes) },
      outDegree: { distribution: distributionOf([...outDegree.values()]), top: topDegrees(outDegree, nodes) },
      fieldLengths: {
        title: fieldLengthDistribution(nodeRows.map((row) => row.title)),
        excerpt: fieldLengthDistribution(nodeRows.map((row) => row.excerpt)),
        language: fieldLengthDistribution(nodeRows.map((row) => row.language)),
        aliases: fieldLengthDistribution(
          aliases.map((row) => row.alias),
          rows.nodes - aliasNodeIds.size,
        ),
        tagKeys: fieldLengthDistribution(
          tags.map((row) => row.key),
          rows.nodes - taggedNodeIds.size,
        ),
        tagLabels: fieldLengthDistribution(
          tags.map((row) => row.label),
          rows.nodes - taggedNodeIds.size,
        ),
      },
      corpus,
    },
    plan: {
      pageSlug,
      previewSlug: pageSlug,
      backlinkAnchor: byIn[0] ?? pageSlug,
      outgoingAnchor: byOut[0] ?? pageSlug,
      localCenter: pageSlug,
      tagKey: busiestTag?.key ?? null,
      tagLabel: busiestTag?.label ?? null,
      tagMembers: Number(busiestTag?.members ?? 0),
      nodeCount: rows.nodes,
      edgeCount: rows.edges,
    },
    inDegree,
    outDegree,
    nodes: selectionNodes,
    edges,
  };
}

export interface RenderedSelectionShape {
  nodes: GraphSelectionShape['nodes'];
  edges: GraphSelectionShape['edges'];
}

export interface RenderedPreviewShape {
  title: string;
  excerpt: string;
  fragment: string | null;
  titleLanguage: string;
  excerptLanguage: string;
}

export interface TagIdentity {
  key: string;
  label: string;
}

export function tagIdentityFailure(
  actual: TagIdentity | null,
  expected: TagIdentity,
  label: string,
): string | null {
  return actual?.key === expected.key && actual.label === expected.label
    ? null
    : `${label}: tag identity differs (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`;
}

export function compareRenderedPreview(
  actual: RenderedPreviewShape,
  expected: RenderedPreviewShape,
  label: string,
): string | null {
  const comparable = (value: RenderedPreviewShape): RenderedPreviewShape => ({
    ...value,
    titleLanguage: value.titleLanguage.toLowerCase(),
    excerptLanguage: value.excerptLanguage.toLowerCase(),
  });
  return JSON.stringify(comparable(actual)) === JSON.stringify(comparable(expected))
    ? null
    : `${label}: rendered preview differs (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`;
}

function orderedEdges(edges: readonly SelectionEdge[]): SelectionEdge[] {
  return [...edges].sort((left, right) =>
    left.from !== right.from
      ? left.from < right.from
        ? -1
        : 1
      : left.to < right.to
        ? -1
        : left.to > right.to
          ? 1
          : 0,
  );
}

export function compareRenderedSelection(
  actual: RenderedSelectionShape,
  expected: RenderedSelectionShape,
  label: string,
): string | null {
  const comparableNodes = (nodes: GraphSelectionShape['nodes']): GraphSelectionShape['nodes'] =>
    nodes.map((node) => ({ ...node, language: node.language.toLowerCase() }));
  if (JSON.stringify(comparableNodes(actual.nodes)) !== JSON.stringify(comparableNodes(expected.nodes))) {
    return `${label}: rendered nodes differ (actual ${JSON.stringify(actual.nodes)}, expected ${JSON.stringify(expected.nodes)})`;
  }
  const actualEdges = orderedEdges(actual.edges);
  const expectedEdges = orderedEdges(expected.edges);
  if (JSON.stringify(actualEdges) !== JSON.stringify(expectedEdges)) {
    return `${label}: rendered edges differ (actual ${JSON.stringify(actualEdges)}, expected ${JSON.stringify(expectedEdges)})`;
  }
  return null;
}
