/**
 * Emits `dist/_redirects` after the Astro build.
 *
 * Generated rather than committed under `public/`, so the redirect map cannot
 * drift from the artifact it describes.
 *
 * The map is empty today, and correctly so: no public URL has ever been
 * stranded (see {@link renderRedirects}). What ships is the version-stamped
 * header, which is what ties a deployed map back to the artifact that produced
 * it — and the working, tested emission path for the first rename that does
 * strand one.
 *
 * A build step rather than an Astro route: `src/pages/_redirects.ts` would be
 * ignored (Astro excludes underscore-prefixed files from routing), and the file
 * is consumed by the host rather than served, so it does not belong in the
 * route model. It follows `scripts/validate-content.ts` — same shape, same
 * place in the build chain.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../src/lib/schema.ts';
import { REDIRECT_RULES, renderRedirects } from '../src/lib/routes.ts';
import { loadArtifact, readArtifact } from '../src/lib/artifact-source.ts';
import { contentVersion } from './validate-content.ts';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/**
 * Write `_redirects` into a built site.
 *
 * @param outDirectory Where the build actually wrote. Defaults to this
 *   repository's own `dist/`, which is where `pnpm run build` puts it. The
 *   packaged CLI builds into a staging directory instead — Astro renames assets
 *   out of `<root>/.astro` and a rename cannot cross a device — so the emitter
 *   must be told, rather than assuming the one path that used to be the only
 *   possibility.
 */
export function emitRedirects(outDirectory: string = DIST): number {
  // Re-validated rather than imported through `src/lib/content.ts`: the
  // accessor is written for the Astro build, and reading the artifact here
  // keeps this script runnable on its own. It reads whichever artifact the
  // build read, so a fixture build's redirect map describes the fixture.
  //
  // The validated result is discarded: the rule set is a literal, so nothing
  // emitted here is derived from the entries. The call is the validation.
  loadArtifact();
  writeFileSync(
    join(outDirectory, '_redirects'),
    renderRedirects(REDIRECT_RULES, {
      schema: SCHEMA_VERSION,
      content: contentVersion(readArtifact()),
    }),
    'utf8',
  );
  return REDIRECT_RULES.length;
}

function main(): number {
  try {
    const rules = emitRedirects();
    console.log(`redirects ok: ${rules} permanent rule${rules === 1 ? '' : 's'}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
