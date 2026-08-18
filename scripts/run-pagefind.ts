/**
 * Builds the Pagefind search index over a built site.
 *
 * The JavaScript API rather than the `pagefind` CLI, so that this repository's
 * own build and the packaged one run the same indexer through the same call.
 * The CLI is reachable here — `pagefind` is a declared dependency and pnpm links
 * its binary — but not reliably from a consumer's tree: the executable ships in
 * seven per-platform optional dependencies, and locating it from a
 * `node_modules/.bin` belonging to *the user's* project is an assumption this
 * package should not make when a supported programmatic entry point exists.
 *
 * The exclusion is not a preference. `--exclude-selectors ".heading-anchor"`
 * keeps the `#` character every heading anchor carries out of the index, and
 * without it a search for any heading returns results whose excerpt begins with
 * a stray `#`. It lives here as a constant rather than in a command line so that
 * every path indexes alike: `package.json`'s `build`, `build-fixture.ts`, and
 * the packaged binary all call this one function. They did not — `build` passed
 * the flag and `build-fixture.ts` did not, so the fixture corpus the search
 * gates measure was indexed differently from the corpus that ships, and
 * `tests/search.test.ts` measures results rather than flags and so could not
 * see it.
 */

import { createIndex, close } from 'pagefind';
import { fileURLToPath } from 'node:url';
import { BuildFailure } from './write-report.ts';

/**
 * The selectors whose text must not enter the index.
 *
 * `.heading-anchor` is the `#` link every heading carries; indexing it puts a
 * bare `#` into every heading's searchable text.
 *
 * **`code.language-math` is a cost, not a free win, and the cost is stated
 * because it is a real one: a reader can no longer find a note by an expression
 * in it.** Under client rendering the TeX source ships as the fallback a
 * JS-disabled reader sees, and a Pagefind fragment stores extracted *text* with
 * markup stripped — so `f:\mathbb{R} \to \mathbb{C}` arrives in the index with
 * no element around it, where it reads as noise beside the prose and trips the
 * residue scan's `absolute local path` rule with no code region left to exempt
 * it. Measured: the fragment for such a note carries the raw TeX.
 *
 * The alternative is exempting the rule over every fragment, which
 * `scripts/scan-residue.ts` measures as taking a genuinely leaked path with it.
 * Excluding the source from the index is the narrower price, and it is paid by
 * search rather than by the privacy boundary.
 *
 * `src/lib/math.ts` already declines to emit Temml's `<annotation>` copy of the
 * source for the same reason, so this is the same decision applied to the mode
 * where the source is what ships.
 */
const EXCLUDE_SELECTORS = ['.heading-anchor', 'code.language-math'];

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/**
 * Pagefind's own error strings are third-party, of opaque provenance, and are
 * composed over the directory being indexed — so they go to the report rather
 * than to a stream a workflow log inherits. The public half is which of the
 * three calls failed, which is a literal of this file's own source.
 */
function pagefindFailed(what: string, errors: readonly unknown[]): BuildFailure {
  return new BuildFailure('pagefind-failed', `pagefind ${what}`, `pagefind ${what}: ${errors.join('; ')}`);
}

export async function indexWithPagefind(siteDirectory: string): Promise<number> {
  const { index, errors } = await createIndex({ excludeSelectors: EXCLUDE_SELECTORS });
  if (errors.length > 0 || index === undefined) {
    throw pagefindFailed('could not start', errors);
  }

  try {
    const added = await index.addDirectory({ path: siteDirectory });
    if (added.errors.length > 0) throw pagefindFailed('failed to index', added.errors);

    const written = await index.writeFiles({ outputPath: `${siteDirectory}/pagefind` });
    if (written.errors.length > 0) throw pagefindFailed('failed to write', written.errors);

    return added.page_count;
  } finally {
    // The indexer is a long-lived child process. Left running, the build never
    // exits — which on CI is a job that hangs until its timeout rather than a
    // build that failed.
    await close();
  }
}

async function main(): Promise<number> {
  try {
    const pages = await indexWithPagefind(DIST);
    console.log(`search index ok: ${pages} page${pages === 1 ? '' : 's'} indexed`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
