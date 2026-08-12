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

/** The selector whose text must not enter the index. */
const EXCLUDE_SELECTORS = ['.heading-anchor'];

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

export async function indexWithPagefind(siteDirectory: string): Promise<number> {
  const { index, errors } = await createIndex({ excludeSelectors: EXCLUDE_SELECTORS });
  if (errors.length > 0 || index === undefined) {
    throw new Error(`pagefind could not start: ${errors.join('; ')}`);
  }

  try {
    const added = await index.addDirectory({ path: siteDirectory });
    if (added.errors.length > 0) throw new Error(`pagefind failed to index: ${added.errors.join('; ')}`);

    const written = await index.writeFiles({ outputPath: `${siteDirectory}/pagefind` });
    if (written.errors.length > 0) throw new Error(`pagefind failed to write: ${written.errors.join('; ')}`);

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
