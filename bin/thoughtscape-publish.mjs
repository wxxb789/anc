#!/usr/bin/env node
/**
 * The `thoughtscape-publish` command: build a site from the directory the user
 * ran it in.
 *
 * This is TK-24's whole deliverable. Everything downstream — discovery,
 * exclusion, link resolution — is TK-26 onward; what this owns is the far
 * narrower question the adoption path stops on first: **when the package is
 * installed in somebody else's repository, where does the build think it is?**
 *
 * ## The root decision
 *
 * `astro build` needs three things from a project root: `astro.config.mjs`,
 * `src/pages/`, and a `node_modules/` its imports resolve through. All three
 * belong to *this package*, never to the user's notes repository — the user
 * supplies content, not a site. So the root is always this package's own
 * directory, and the user's directory contributes exactly two things: the
 * content that becomes the artifact, and the place `dist/` lands.
 *
 * **Implemented by changing the process's working directory to the package
 * root, then pointing `--outDir` back at the user's.** That reads as the blunt
 * option and it is the correct one, because cwd is not incidental here — it is
 * already the documented anchor three separate consumers agree on:
 * `src/lib/artifact-source.ts:13-22` resolves the artifact against
 * `process.cwd()` precisely because Astro bundles it into `dist/.prerender/`
 * where `import.meta.url` points into the build output, and it records that the
 * build "must be started from the repository root". Setting cwd satisfies that
 * contract instead of fighting it.
 *
 * **`--root` was implemented first and rejected on measurement.** It is the
 * option the plan names, it looks cleaner, and it does not work. Two failures,
 * both from a real spike rather than from reading:
 *
 * 1. With cwd in the user's directory and `--root` at the package, Astro emits
 *    its prerender chunks relative to `--outDir` and Node then resolves their
 *    bare imports from *there*: `Cannot find package 'github-slugger' imported
 *    from …/rootprobe/dist/.prerender/chunks/site_*.mjs`. The build gets as far
 *    as "generating static routes" and dies. Node's resolution walks up from the
 *    importing file, and the user's directory has no `node_modules` containing
 *    this package's dependency tree — under pnpm it emphatically does not.
 * 2. Pointing `--outDir` back inside the package instead trades that for
 *    `EXDEV: cross-device link not permitted` out of Astro's `ssrMoveAssets`,
 *    because Astro stages assets in `<cwd>/.astro` and renames them into
 *    `outDir` — a rename that cannot cross a device. The user's repository and
 *    the package are routinely on different drives; on this machine `C:` and
 *    `Q:` reproduce it every time.
 *
 * Both are the same underlying fact: Astro treats cwd as load-bearing in places
 * `--root` does not reach. Fighting that means guessing which of them will be
 * reached next. Setting cwd to the root — so cwd and root agree, as they do in
 * every ordinary Astro build — makes the whole class unreachable rather than
 * handling its members.
 *
 * Astro's JavaScript API, the plan's other candidate, was not tried and is not
 * needed: it takes `root` as an inline config option, so it lands on exactly the
 * same divergence between cwd and root that failure 2 comes out of. It would
 * also mean this file assembling an Astro config in code, giving the project two
 * places a config lives. `astro.config.mjs` staying the only one is worth more
 * than the subprocess this avoids — and there is no subprocess either way, since
 * `astro` exports `build` directly.
 *
 * ## What it does not do
 *
 * **It does not produce an artifact from Markdown.** That is TK-26. Until it
 * lands, `--content` is bridged by `scripts/markdown-to-artifact.ts`, which is
 * deliberately the narrowest thing that turns `.md` files into the existing
 * artifact shape so that this ticket's acceptance test can run end to end. It is
 * temporary and marked as such at its own definition.
 *
 * **It does not give the site the user's identity.** A site built here carries
 * this repository's: `https://thoughtscape.invalid` as its origin in every
 * canonical link, feed id, sitemap `<loc>`, and `robots.txt`; `thoughtscape` as
 * its name; this owner's social card; and an `/about/` page that describes
 * publication from "an explicit approval list", which is not how a build from a
 * directory of Markdown works. All of it is measured in a real packaged build,
 * not inferred.
 *
 * That is TK-31's ticket — "Site-identity extraction", which depends on TK-30's
 * config file — and it is named here rather than worked around because the
 * failure is silent: the site is valid, renders correctly, and is wrong about
 * whose it is. `tests/packaging.test.ts` asserts the boundary so that this note
 * cannot quietly stop being true, and `astro.config.mjs` already documents
 * `.invalid` as a placeholder that "cannot be mistaken for a real domain and
 * cannot accidentally point a crawler at somebody else's server" — which is what
 * makes shipping it the safe interim state rather than a leak.
 */

import './typescript-hook.mjs';

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** This package's own root — the directory holding `astro.config.mjs`. */
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

const USAGE = `thoughtscape-publish — build a static site from a directory of Markdown

Usage
  thoughtscape-publish build [options]

Options
  --content <dir>  directory holding the Markdown (default: the working directory)
  --out <dir>      where to write the site (default: <working directory>/dist)
  --help           show this message
`;

/**
 * Parse `--flag value` pairs, rejecting anything unrecognised.
 *
 * Unknown flags fail rather than being ignored. A user who mistypes `--outdir`
 * would otherwise get a successful build writing to a place they did not ask
 * for, which for a publishing tool is the failure that matters: silently correct
 * output in the wrong location reads as success.
 */
function parseArguments(argv) {
  const options = { content: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return 'help';
    const key = argument === '--content' ? 'content' : argument === '--out' ? 'out' : undefined;
    if (key === undefined) throw new Error(`unknown option "${argument}"\n\n${USAGE}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} needs a directory\n\n${USAGE}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

/**
 * Refuse an output directory whose deletion would take the user's notes with it.
 *
 * The build replaces `--out` wholesale, because a stale file from a previous
 * build left in a published directory is a page that still serves after the note
 * behind it was deleted. That is right for a directory the tool owns and
 * catastrophic for one it does not: `--out .` in a notes repository resolves to
 * the repository, and the notes are what gets deleted.
 *
 * Measured, not theorised — a probe with `--out` pointing at a directory holding
 * an unrelated file lost the file. It survived in the working directory only
 * because Windows holds a lock on cwd, which is luck rather than a guarantee and
 * is absent on every other platform.
 *
 * So three refusals, each a containment relation rather than a name: the output
 * may not *be* the content directory, may not *contain* it, and may not be the
 * directory the command was run from. A user who genuinely wants to publish into
 * one of those can name a subdirectory, which is what `dist` already is.
 */
function assertSafeOutput(outDirectory, contentDirectory, userDirectory) {
  // Resolved through the filesystem before comparison, because `path.relative`
  // is string arithmetic and a link is not a string relationship. Measured: with
  // `alias` a junction to `notes/`, `--content ./alias --out ./notes` passed a
  // purely textual guard and deleted the notes. `realpath` collapses the link,
  // the two paths become the same string, and the containment test then sees
  // what the filesystem sees.
  //
  // A directory that does not exist yet is its own resolved path — `--out dist`
  // on a first run is the ordinary case, and it cannot alias anything, since
  // there is nothing there to be a link.
  const real = (directory) => {
    try {
      return realpathSync(directory);
    } catch {
      return directory;
    }
  };

  const output = real(outDirectory);

  // `relative`, not `startsWith`: `/notes-backup` starts with the string
  // `/notes` while being no relation to it, and the string test would refuse a
  // legitimate directory while a case-different or trailing-separator spelling
  // of a real ancestor slipped past. `relative(a, b)` returning a path that
  // neither escapes upward nor is absolute is the actual containment test.
  const contains = (parent, child) => {
    const step = relative(parent, child);
    return step === '' || (!step.startsWith('..') && !isAbsolute(step));
  };

  for (const [directory, what] of [
    [contentDirectory, 'the content directory'],
    [userDirectory, 'the working directory'],
  ]) {
    if (contains(output, real(directory))) {
      throw new Error(
        `refusing to build into ${outDirectory}: it is, or contains, ${what} ` +
          `(${directory}), and the build replaces its output directory wholesale. ` +
          'Name a subdirectory instead — the default is `dist`.',
      );
    }
  }
}

/**
 * Run the build.
 *
 * The ordering mirrors `package.json`'s `build` script link for link —
 * validate, build, emit redirects, index, scan — because that chain is the
 * product. A link dropped here would be a gate this repository enforces on
 * itself and not on the users it ships to, which is the wrong way round.
 * `tests/packaging.test.ts` asserts the two chains name the same steps, so the
 * mirror is a property rather than a promise.
 *
 * Every path is resolved to an absolute one *before* cwd changes, since a
 * relative `--out` means "relative to where the user typed it".
 */
async function build(options) {
  const userDirectory = process.cwd();
  const contentDirectory = resolve(userDirectory, options.content ?? '.');
  const outDirectory = resolve(userDirectory, options.out ?? 'dist');

  if (!existsSync(contentDirectory)) throw new Error(`content directory not found: ${contentDirectory}`);
  assertSafeOutput(outDirectory, contentDirectory, userDirectory);

  // Build inside the package, then copy out. Astro stages assets in
  // `<root>/.astro` and *renames* them into `outDir`, and a rename cannot cross
  // a device — so writing straight to a user directory on another drive fails
  // with EXDEV. Staging keeps the rename within one filesystem and makes the
  // copy the only cross-device step, which `cp` performs as a real copy.
  //
  // Inside the package rather than in the OS temp directory, because that is the
  // filesystem the rename has to stay on: `mkdtemp` in `os.tmpdir()` is on `C:`
  // while a checkout may be on `Q:`, which reproduces the EXDEV this staging
  // exists to avoid.
  //
  // Per-run rather than a fixed name, so two builds cannot delete each other's
  // intermediate output — the `finally` below removes the whole workspace, and
  // with a shared path the first run to finish would take the second's with it.
  // Under a normal install the package root is inside `node_modules`, so this is
  // already ignored by anything ignoring that; it matters when the binary is run
  // from a checkout of this repository, where scratch state in the working tree
  // is one `git add -A` from being committed. `.gitignore` names the prefix for
  // that case.
  const workspace = await mkdtemp(join(PACKAGE_ROOT, '.thoughtscape-build-'));

  // The `try` opens on the line after the directory exists, and deliberately
  // *before* the artifact is written. `writeArtifact` reads every note and runs
  // the whole content contract over them, so it is the likeliest throw in this
  // function — and with the boundary any later, each failed run left a workspace
  // behind for ever. Measured: three failing runs, three directories.
  try {
    const staging = join(workspace, 'dist');

    const { writeArtifact } = await import('../scripts/markdown-to-artifact.ts');
    const artifact = join(workspace, 'content.json');
    const count = await writeArtifact(contentDirectory, artifact);
    console.log(`content: ${count} note${count === 1 ? '' : 's'} from ${contentDirectory}`);

    // From here on the process runs as if it had been started in the package, so
    // every consumer that resolves against cwd — `artifact-source.ts` first among
    // them — sees the root it was written for.
    process.chdir(PACKAGE_ROOT);
    process.env['CONTENT_ARTIFACT'] = artifact;

    const { validateBuildInputs } = await import('../scripts/validate-content.ts');
    const validated = validateBuildInputs(artifact);

    const { build: astroBuild } = await import('astro');
    await astroBuild({ outDir: staging, logLevel: 'error' });

    const { emitRedirects } = await import('../scripts/emit-redirects.ts');
    emitRedirects(staging);

    // `public/content-index.json` is the *owner's* index and is deliberately not
    // in the published tarball, so nothing copies one here — the build must write
    // its own projection of the corpus it just built. `build-fixture.ts` does the
    // same thing for the same reason (`scripts/build-fixture.ts:70-86`); the
    // projection comes from `validate-content.ts` so there is one definition of
    // what the index is.
    const { projectIndex } = await import('../scripts/validate-content.ts');
    await writeFile(
      join(staging, 'content-index.json'),
      `${JSON.stringify(projectIndex(validated), null, 2)}\n`,
      'utf8',
    );

    const { indexWithPagefind } = await import('../scripts/run-pagefind.ts');
    await indexWithPagefind(staging);

    const { assertNoResidue } = await import('../scripts/scan-residue.ts');
    console.log(`residue scan ok: ${assertNoResidue(staging)} files, 0 findings`);

    // Only now is the output fit to hand over. Copying after the scan rather than
    // before means a build that fails a gate leaves the user's `dist/` untouched,
    // holding whatever last passed — the same property `validate-content.ts`
    // argues for at the front of the chain.
    await rm(outDirectory, { recursive: true, force: true });
    await mkdir(outDirectory, { recursive: true });
    await cp(staging, outDirectory, { recursive: true });
    console.log(`site written to ${outDirectory}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main(argv) {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command !== 'build') {
    console.error(`unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  const options = parseArguments(argv.slice(1));
  if (options === 'help') {
    console.log(USAGE);
    return 0;
  }

  await build(options);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
