/**
 * Emits `dist/_redirects` after the Astro build.
 *
 * Generated rather than committed under `public/`, so the redirect map cannot
 * drift from the artifact it describes: every published slug gets a rule on
 * every build, and a withdrawn note's rule disappears with it.
 *
 * A build step rather than an Astro route: `src/pages/_redirects.ts` would be
 * ignored (Astro excludes underscore-prefixed files from routing), and the file
 * is consumed by the host rather than served, so it does not belong in the
 * route model. It follows `scripts/validate-content.ts` — same shape, same
 * place in the build chain.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, validateArtifact } from '../src/lib/schema.ts';
import { redirectRules, renderRedirects } from '../src/lib/routes.ts';

const CONTENT = new URL('../src/data/content.json', import.meta.url);
const OUTPUT = new URL('../dist/_redirects', import.meta.url);

function main(): number {
  try {
    // Re-validated rather than imported through `src/lib/content.ts`: the
    // accessor is written for the Astro build, and reading the artifact here
    // keeps this script runnable on its own.
    const source = readFileSync(CONTENT, 'utf8');
    const { entries } = validateArtifact(JSON.parse(source), 'src/data/content.json');
    // A hash of the artifact bytes, so the emitted map can be tied back to the
    // exact input it was generated from (requirements section 20). The artifact
    // is already public, so its digest discloses nothing further.
    const contentVersion = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    const rules = redirectRules(entries);
    writeFileSync(
      OUTPUT,
      renderRedirects(rules, { schema: SCHEMA_VERSION, content: contentVersion }),
      'utf8',
    );
    console.log(`redirects ok: ${rules.length} permanent rule${rules.length === 1 ? '' : 's'}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
