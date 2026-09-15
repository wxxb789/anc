/**
 * Build-time reads from the finalized snapshot.
 *
 * The Astro build runs in Node, so it can open the same file the browser later
 * downloads and answer its relationship questions from a real SQL query rather
 * than from a second reconstruction of the artifact. This module is the one
 * seam pages use; when no binding exists — `astro dev`, and unit tests that never
 * built a site — callers fall back to the private IR's producer-resolved pairs,
 * which are the bytes the snapshot was built from.
 *
 * The binding is a small JSON file in the private snapshot workspace, written by
 * `scripts/build-snapshot.ts` and pointed at by `SNAPSHOT_WORKSPACE`. It is never
 * inside `dist/`: it names the same digest the public filename carries, and
 * `docs/core-design/build-and-runtime.md` owns why no public manifest exists.
 *
 * **A staged workspace is not a current build.** The workspace persists between
 * commands (the output copy step reads it after Astro renders), so a later
 * `astro dev` — or a test run against a different `CONTENT_ARTIFACT` — would
 * otherwise treat the previous build's files as this build's authority, static
 * hydration included. Two checks close that window: this module refuses bytes
 * that do not hash to the digest the binding names, and `content.ts` hydrates
 * only when the snapshot's node and edge sets are the entries' own. A mismatch
 * falls back to the artifact's producer-resolved pairs, and the fallback is the
 * safe direction because those pairs are the bytes the snapshot was built from:
 * a snapshot failing either check describes some other corpus, and rendering
 * its relationships would state something the artifact does not.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from './sqlite.ts';
import { configuredSnapshotWorkspace, readSnapshotBinding, type SnapshotBinding } from './snapshot.ts';
import { SNAPSHOT_QUERIES } from './snapshot-queries.ts';

/**
 * The private workspace `SNAPSHOT_WORKSPACE` names, anchored at the working
 * directory, or the default when it is unset or empty.
 *
 * The empty-as-unset choice is `configuredSnapshotWorkspace`'s, shared with
 * `astro.config.mjs`; resolving the path against `cwd` stays here because this
 * is the Node-only scope.
 */
export function snapshotWorkspace(
  workspace: string = configuredSnapshotWorkspace(process.env['SNAPSHOT_WORKSPACE']),
): string {
  return resolve(process.cwd(), workspace);
}

/** The build-time relation projection the pages render from. */
export interface SnapshotRelations {
  /** Slug to the slugs it links out to, sorted. */
  outgoing: ReadonlyMap<string, string[]>;
  /** Slug to the slugs that link to it, sorted. */
  backlinks: ReadonlyMap<string, string[]>;
  /**
   * Slug to the tags the snapshot projects for it, as `tags.label` spellings in
   * canonical key order.
   *
   * Labels rather than keys because the one normalizer both the producer and
   * the pages call, `tagFacets`, derives a route key from the label it is
   * handed. Handing it the DB's key would turn `Field Notes` into `field-notes`
   * on every static tag surface while the browser keeps rendering the
   * `tags.label` row — the disagreement this shared read exists to remove.
   */
  tags: ReadonlyMap<string, string[]>;
}

interface EdgeRow {
  source_id: number;
  target_id: number;
}

interface NodeRow {
  id: number;
  slug: string;
}

interface NodeTagRow {
  slug: string;
  key: string;
  label: string;
}

/**
 * The complete projection, or `undefined` when this process has no current
 * snapshot.
 *
 * Edges are read as one query and inverted in memory rather than one query per
 * note: the edge set is the whole relation model, and a per-note scan would
 * make the build quadratic in the corpus for no benefit. Tags come from one
 * joined scan of `node_tags`, grouped here instead of queried per page. The
 * binding must name the bytes: a workspace left by an earlier build, or a
 * half-written file from an interrupted one, returns `undefined` rather than
 * being served as current.
 */
export function loadSnapshotRelations(workspace?: string): SnapshotRelations | undefined {
  const directory = snapshotWorkspace(workspace);
  const binding = readBuildBinding(workspace);
  if (binding === undefined) return undefined;

  const databasePath = resolve(directory, 'snapshot.sqlite');
  let bytes: Buffer;
  try {
    bytes = readFileSync(databasePath);
  } catch {
    // A binding without readable bytes is a build that did not finish staging;
    // the documented fallback (the producer's own pairs) is the honest answer.
    return undefined;
  }
  // The digest is the build's own notarization of these bytes: the producer
  // hashed the finalized file it had just integrity-checked, then wrote the
  // binding. A partial write, a truncation, or a file some later step rewrote
  // cannot pass this comparison.
  if (createHash('sha256').update(bytes).digest('hex') !== binding.digest) return undefined;

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    // Bytes that hash to the binding are complete, but the open can still fail
    // (permissions, or a file removed between the read and the open). Falling
    // back is safer than failing a build over a workspace that is only an
    // optimization.
    return undefined;
  }
  try {
    const nodes = database.prepare(SNAPSHOT_QUERIES.allNodes).all() as unknown as NodeRow[];
    const rows = database.prepare(SNAPSHOT_QUERIES.allEdges).all() as unknown as EdgeRow[];
    const memberships = database
      .prepare(SNAPSHOT_QUERIES.allNodeTags)
      .all() as unknown as NodeTagRow[];
    const slugById = new Map<number, string>(nodes.map((node) => [node.id, node.slug]));

    const outgoing = new Map<string, string[]>();
    const backlinks = new Map<string, string[]>();
    const tags = new Map<string, string[]>();
    for (const node of nodes) {
      outgoing.set(node.slug, []);
      backlinks.set(node.slug, []);
      tags.set(node.slug, []);
    }
    for (const row of rows) {
      const source = slugById.get(row.source_id);
      const target = slugById.get(row.target_id);
      if (source === undefined || target === undefined) continue;
      outgoing.get(source)!.push(target);
      backlinks.get(target)!.push(source);
    }
    for (const row of memberships) {
      // The join reaches nodes by primary key, so every row's slug is one of
      // the nodes above; the guard covers a file this process did not write.
      tags.get(row.slug)?.push(row.label);
    }
    for (const list of outgoing.values()) list.sort();
    for (const list of backlinks.values()) list.sort();
    return { outgoing, backlinks, tags };
  } finally {
    database.close();
  }
}

/**
 * Replace each entry's producer-resolved arrays with the snapshot's own.
 *
 * Outgoing and backlinks keep their existing shape so every pure relationship
 * function (`relations.ts`, `graph.ts`) is unchanged; only the authority moved.
 * `tags` carries the snapshot's label spelling, so `tagFacets` — still the one
 * normalization and label authority — reproduces exactly the keys and labels
 * the browser reads from the same rows. A slug the snapshot does not carry
 * keeps empty arrays rather than its IR values, so a stale entry cannot render
 * a relationship the public projection does not contain.
 */
export function hydrateEntriesWithSnapshot<
  T extends { slug: string; outgoing: string[]; backlinks: string[]; tags?: string[] },
>(entries: readonly T[], snapshot: SnapshotRelations): void {
  for (const entry of entries) {
    entry.outgoing = [...(snapshot.outgoing.get(entry.slug) ?? [])];
    entry.backlinks = [...(snapshot.backlinks.get(entry.slug) ?? [])];
    entry.tags = [...(snapshot.tags.get(entry.slug) ?? [])];
  }
}

/**
 * Whether a loaded snapshot describes the entries about to render.
 *
 * The snapshot is the relationship authority, but only for the corpus it was
 * built from; `content.ts` is where the loaded projection and the entries meet,
 * so the two are required to be the same corpus. The node slug sets must be
 * equal — a slug on either side alone means a note was added or removed since
 * the build. Edge sets are compared only when the artifact carries
 * producer-resolved edges at all: the packaged target's serialized artifact is
 * deliberately stripped (`writeArtifact(..., { includeEdges: false })`), so its
 * empty arrays are the handoff, not a claim that the corpus has no links, and
 * comparing them would refuse exactly the builds the hydration exists for.
 *
 * A mismatch means this process cannot tell which corpus the staged snapshot
 * belongs to; the fallback is the artifact's own resolved pairs, the one answer
 * that provably belongs to what is being rendered.
 */
export function snapshotMatchesEntries(
  entries: readonly { slug: string; outgoing: readonly string[] }[],
  snapshot: SnapshotRelations,
): boolean {
  if (entries.length !== snapshot.outgoing.size) return false;

  let carriesEdges = false;
  for (const entry of entries) {
    if (snapshot.outgoing.get(entry.slug) === undefined) return false;
    if (entry.outgoing.length > 0) carriesEdges = true;
  }
  if (!carriesEdges) return true;

  return entries.every((entry) => sameMembers(entry.outgoing, snapshot.outgoing.get(entry.slug)!));
}

/** Whether two slug lists carry the same members; order is not part of it. */
function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((member, index) => member === sortedRight[index]);
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
