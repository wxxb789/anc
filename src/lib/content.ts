/**
 * Typed accessor for the public content artifact.
 *
 * Pages import from here rather than from `src/data/content.json` directly, so
 * every consumer sees an artifact that has already passed the contract in
 * `schema.ts`. A malformed artifact throws at module evaluation, which fails
 * `astro build` with a message naming the offending entry and field.
 *
 * Which file is read is `artifact-source.ts`'s decision, so `pnpm run
 * build:fixture` can build the whole site from a fixture corpus without
 * touching the generated artifact. The file is read rather than imported: a
 * static `import ... with { type: 'json' }` names one path at parse time, which
 * is exactly the indirection the fixture build needs.
 */

import { loadArtifact } from './artifact-source.ts';
import { byTitleThenSlug } from './relations.ts';
import { routeKey, tagFacets as producerTagFacets, tagRoute, type Facet } from './routes.ts';
import type { ContentArtifact, ContentEntry } from './schema.ts';
import {
  hydrateEntriesWithSnapshot,
  loadSnapshotRelations,
  snapshotMatchesEntries,
  type SnapshotRelations,
} from './snapshot-reader.ts';

export type { ContentArtifact, ContentEntry };

export const artifact: ContentArtifact = loadArtifact();

export const entries: readonly ContentEntry[] = artifact.entries;

const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));

export function getEntry(slug: string): ContentEntry | undefined {
  return bySlug.get(slug);
}

/**
 * Relationship and tag authority is the finalized snapshot, not the private IR.
 *
 * When this build staged a snapshot whose bytes hash to the digest its binding
 * names and whose node and edge sets are these entries' own, it replaces the
 * producer's arrays, so every relationship and tag surface — static and
 * interactive — reads the same SQL projection. A build without a snapshot
 * (`astro dev`, a unit test) keeps the producer's resolved pairs, which are the
 * exact bytes the snapshot is built from. So does a workspace left behind by an
 * earlier build, or one staged for a different `CONTENT_ARTIFACT`: hydrating
 * those would render relationships this corpus does not have, and the artifact's
 * own pairs are the only authority provably tied to what is being rendered.
 *
 * The tag routes follow the same switch. Their key is `tags.key` read from the
 * snapshot rather than `routeKey(tags.label)` recomputed here, and their member
 * list is the snapshot's `node_tags` projection, so a static tag page, its
 * sitemap URL, its note metadata links, and the browser's `byTag` query all
 * name the rows the producer wrote. Only the no-snapshot fallback normalizes
 * from the entries, because there the producer is the authority.
 */
const snapshot = loadSnapshotRelations();
const snapshotIsAuthority = snapshot !== undefined && snapshotMatchesEntries(entries, snapshot);
if (snapshotIsAuthority) hydrateEntriesWithSnapshot(entries, snapshot);

/**
 * The snapshot's facets as the `Facet` shape the static surfaces render.
 *
 * `entries` are the artifact's own objects, resolved through the same map
 * `getEntry` uses, so a tag page and a note page list the same instances. A
 * member the artifact does not carry is skipped rather than rendered as a dead
 * link; `snapshotMatchesEntries` already proves the node sets are equal, so
 * this is unreachable through the validated loader.
 */
function facetsFromSnapshot(
  relation: SnapshotRelations,
  lookup: ReadonlyMap<string, ContentEntry>,
): Facet[] {
  return relation.tagFacets.map((facet) => ({
    key: facet.key,
    label: facet.label,
    entries: facet.slugs
      .map((slug) => lookup.get(slug))
      .filter((entry): entry is ContentEntry => entry !== undefined)
      .sort(byTitleThenSlug),
  }));
}

const facets: readonly Facet[] = snapshotIsAuthority
  ? facetsFromSnapshot(snapshot, bySlug)
  : producerTagFacets(entries);

/** Facet label to the key its own row carries, for note-page tag links. */
const keyByLabel = new Map(facets.map((facet) => [facet.label, facet.key]));

/**
 * The tag facets this build renders, in canonical key order.
 *
 * This is the accessor the static tag surfaces call; `routes.ts`'s
 * `tagFacets(entries)` remains the producer's normalization and collision
 * check, used by the writer and as the no-snapshot fallback here.
 */
export function tagFacets(): readonly Facet[] {
  return facets;
}

/**
 * The public route for one note's tag label, from the same facet index the tag
 * pages render.
 *
 * A hydrated entry carries the snapshot's representative label, so every label
 * on a note page resolves to the `tags.key` row it came from. The fallback is
 * reachable only where the producer is already the authority — no snapshot, or
 * a label the artifact spelled differently from the representative, which
 * `producerTagFacets` groups under the same key.
 */
export function tagRouteForLabel(label: string): string {
  return tagRoute(keyByLabel.get(label) ?? routeKey(label));
}
