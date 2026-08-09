/**
 * Typed accessor for the public content artifact.
 *
 * Pages import from here rather than from `src/data/content.json` directly, so
 * every consumer sees an artifact that has already passed the contract in
 * `schema.ts`. A malformed artifact throws at module evaluation, which fails
 * `astro build` with a message naming the offending entry and field.
 *
 * Which file is read is `artifact-source.ts`'s decision, so `npm run
 * build:fixture` can build the whole site from a fixture corpus without
 * touching the generated artifact. The file is read rather than imported: a
 * static `import ... with { type: 'json' }` names one path at parse time, which
 * is exactly the indirection the fixture build needs.
 */

import { loadArtifact } from './artifact-source.ts';
import type { ContentArtifact, ContentEntry } from './schema.ts';

export type { ContentArtifact, ContentEntry };

export const artifact: ContentArtifact = loadArtifact();

export const entries: readonly ContentEntry[] = artifact.entries;

const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));

export function getEntry(slug: string): ContentEntry | undefined {
  return bySlug.get(slug);
}
