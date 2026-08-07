/**
 * Build gate for the generated content artifact pair.
 *
 * Runs before `astro build` so an invalid or privacy-violating artifact fails
 * with a precise message instead of a bundler stack trace. Also proves that
 * `public/content-index.json` is still an exact public projection of
 * `src/data/content.json`, since the index ships to the browser on its own.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateArtifact, ContentValidationError, type ContentArtifact } from '../src/lib/schema.ts';

const CONTENT = new URL('../src/data/content.json', import.meta.url);
const INDEX = new URL('../public/content-index.json', import.meta.url);

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The public index carries `{slug, title, excerpt}` and nothing else. */
export function projectIndex(artifact: ContentArtifact) {
  return {
    version: artifact.version,
    entries: artifact.entries.map(({ slug, title, excerpt }) => ({ slug, title, excerpt })),
  };
}

/**
 * The index ships to the browser on its own, so it must stay an exact projection
 * of the validated artifact rather than a separately generated file that could
 * drift. The comparison is key-order sensitive, which is the safe direction for
 * a privacy gate: a reordered index is a change in the exporter worth reviewing.
 */
export function checkIndexProjection(index: unknown, artifact: ContentArtifact): string[] {
  return JSON.stringify(index) === JSON.stringify(projectIndex(artifact))
    ? []
    : ['public/content-index.json: is not an exact {slug, title, excerpt} projection of src/data/content.json'];
}

function main(): number {
  try {
    const artifact = validateArtifact(readJson(CONTENT), 'src/data/content.json');
    const issues = checkIndexProjection(readJson(INDEX), artifact);
    if (issues.length > 0) throw new ContentValidationError('public/content-index.json', issues);
    console.log(`content ok: version=${artifact.version} entries=${artifact.entries.length}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
