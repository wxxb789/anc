/**
 * Build-time reads from the finalized snapshot.
 *
 * The Astro build runs in Node, so it can open the same file the browser later
 * downloads and answer its relationship questions from a real SQL query rather
 * than from a second reconstruction of the artifact. This module is the one
 * seam pages use; when no binding exists — `astro dev`, and unit tests that never
 * built a site — callers fall back to the private IR's producer-resolved edges,
 * which are the bytes the snapshot was built from.
 *
 * The binding is a small JSON file in the private snapshot workspace, written by
 * `scripts/build-snapshot.ts` and pointed at by `SNAPSHOT_WORKSPACE`. It is never
 * inside `dist/`: it names the same digest the public filename carries, and
 * `docs/core-design/build-and-runtime.md` owns why no public manifest exists.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from './sqlite.ts';
import { readSnapshotBinding, type SnapshotBinding } from './snapshot.ts';
import { SNAPSHOT_QUERIES } from './snapshot-queries.ts';

/** Default private workspace, relative to the build's working directory. */
export const DEFAULT_SNAPSHOT_WORKSPACE = '.astro/snapshot';

export function snapshotWorkspace(workspace: string = process.env['SNAPSHOT_WORKSPACE'] || DEFAULT_SNAPSHOT_WORKSPACE): string {
  return resolve(process.cwd(), workspace);
}

export interface SnapshotEdges {
  /** Slug to the slugs it links out to, sorted. */
  outgoing: ReadonlyMap<string, string[]>;
  /** Slug to the slugs that link to it, sorted. */
  backlinks: ReadonlyMap<string, string[]>;
}

interface EdgeRow {
  source_id: number;
  target_id: number;
}

interface NodeRow {
  id: number;
  slug: string;
}

/**
 * The complete edge adjacency, or `undefined` when this build has no snapshot.
 *
 * Read as one query and inverted in memory rather than one query per note: the
 * edge set is the whole relation model, and a per-note scan would make the build
 * quadratic in the corpus for no benefit.
 */
export function loadSnapshotEdges(workspace?: string): SnapshotEdges | undefined {
  const directory = snapshotWorkspace(workspace);
  const bindingPath = resolve(directory, 'binding.json');
  if (!existsSync(bindingPath)) return undefined;

  const database = new DatabaseSync(resolve(directory, 'snapshot.sqlite'), { readOnly: true });
  try {
    const rows = database.prepare(SNAPSHOT_QUERIES.allEdges).all() as unknown as EdgeRow[];
    const nodes = database.prepare(SNAPSHOT_QUERIES.allNodes).all() as unknown as NodeRow[];
    const slugById = new Map<number, string>(nodes.map((node) => [node.id, node.slug]));

    const outgoing = new Map<string, string[]>();
    const backlinks = new Map<string, string[]>();
    for (const node of nodes) {
      outgoing.set(node.slug, []);
      backlinks.set(node.slug, []);
    }
    for (const row of rows) {
      const source = slugById.get(row.source_id);
      const target = slugById.get(row.target_id);
      if (source === undefined || target === undefined) continue;
      outgoing.get(source)!.push(target);
      backlinks.get(target)!.push(source);
    }
    for (const list of outgoing.values()) list.sort();
    for (const list of backlinks.values()) list.sort();
    return { outgoing, backlinks };
  } finally {
    database.close();
  }
}

/**
 * Replace each entry's producer-resolved edge arrays with the snapshot's own.
 *
 * The arrays keep their existing shape so every pure relationship function
 * (`relations.ts`, `graph.ts`) is unchanged; only the authority moved. A slug the
 * snapshot does not carry keeps empty lists rather than its IR values, so a
 * stale entry cannot render an edge the public projection does not contain.
 */
export function hydrateEntriesWithSnapshot<T extends { slug: string; outgoing: string[]; backlinks: string[] }>(
  entries: readonly T[],
  edges: SnapshotEdges,
): readonly T[] {
  for (const entry of entries) {
    entry.outgoing = [...(edges.outgoing.get(entry.slug) ?? [])];
    entry.backlinks = [...(edges.backlinks.get(entry.slug) ?? [])];
  }
  return entries;
}

/** The binding a build wrote, or `undefined` when this process has no snapshot. */
export function readBuildBinding(workspace?: string): SnapshotBinding | undefined {
  const directory = snapshotWorkspace(workspace);
  const bindingPath = resolve(directory, 'binding.json');
  if (!existsSync(bindingPath)) return undefined;
  try {
    return readSnapshotBinding(JSON.parse(readFileSync(bindingPath, 'utf8')));
  } catch {
    return undefined;
  }
}
