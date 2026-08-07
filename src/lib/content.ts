/**
 * Typed accessor for the public content artifact.
 *
 * Pages import from here rather than from `src/data/content.json` directly, so
 * every consumer sees an artifact that has already passed the contract in
 * `schema.ts`. A malformed artifact throws at module evaluation, which fails
 * `astro build` with a message naming the offending entry and field.
 */

import raw from '../data/content.json' with { type: 'json' };
import { validateArtifact, type ContentArtifact, type ContentEntry } from './schema.ts';

export type { ContentArtifact, ContentEntry };

export const artifact: ContentArtifact = validateArtifact(raw, 'src/data/content.json');

export const entries: readonly ContentEntry[] = artifact.entries;

const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));

export function getEntry(slug: string): ContentEntry | undefined {
  return bySlug.get(slug);
}
