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
import {
  hydrateEntriesWithSnapshot,
  loadSnapshotRelations,
  snapshotMatchesEntries,
} from './snapshot-reader.ts';
import type { ContentArtifact, ContentEntry } from './schema.ts';

export type { ContentArtifact, ContentEntry };

export const artifact: ContentArtifact = loadArtifact();

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
 */
const snapshot = loadSnapshotRelations();
if (snapshot !== undefined && snapshotMatchesEntries(artifact.entries, snapshot)) {
  hydrateEntriesWithSnapshot(artifact.entries, snapshot);
}

export const entries: readonly ContentEntry[] = artifact.entries;

const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));

export function getEntry(slug: string): ContentEntry | undefined {
  return bySlug.get(slug);
}
