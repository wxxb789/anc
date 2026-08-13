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
 * option the plan names, it looks cleaner, and it cannot work here. Not on
 * taste, and not on a hunch about Astro being cwd-sensitive in general: two
 * constraints compose, and between them they leave exactly one shape available.
 *
 * 1. **cwd must be inside this package.** With cwd in the user's directory and
 *    `--root` at the package, Astro emits its prerender chunks relative to
 *    `--outDir` and Node then resolves their bare imports from *there*: `Cannot
 *    find package 'github-slugger' imported from
 *    …/rootprobe/dist/.prerender/chunks/site_*.mjs`. The build gets as far as
 *    "generating static routes" and dies. Node's resolution walks up from the
 *    importing file, and the user's directory has no `node_modules` containing
 *    this package's dependency tree — under pnpm it emphatically does not.
 * 2. **`outDir` must be on the same device as cwd.** The mechanism is one
 *    function — `getOutDirWithinCwd`, four lines, in
 *    `astro/dist/core/build/common.js:76-82` (read at astro 7.1.6):
 *
 *        if (fileURLToPath(outDir).startsWith(process.cwd())) return outDir;
 *        else return new URL('./.astro/', pathToFileURL(process.cwd() + sep));
 *
 *    An `outDir` that fails that containment test is discarded *for the
 *    prerender staging directory*, which is placed at `<cwd>/.astro/` instead —
 *    reaching the build through `getServerOutputDirectory`
 *    (`astro/dist/prerender/utils.js:10`) → `getPrerenderOutputDirectory` →
 *    `static-build.js:114`. `ssrMoveAssets` (`static-build.js:249-285`) then
 *    `fs.promises.rename`s the assets from that staging directory to the real
 *    `outDir`, and **a rename cannot cross a device**.
 *
 * Be precise about what constraint 2 does and does not say, because the obvious
 * reading is wrong and was measured to be wrong. The containment test governs
 * only where prerender output is *staged*; the finished pages still reach
 * `config.outDir`. So an out-of-cwd `outDir` is not fatal by itself — measured,
 * `astro build --outDir Q:/probe-sibling/dist` from this repository produces a
 * complete site, redirected staging and all, because the rename stays on one
 * drive. The identical run to `C:/…` dies at `static-build.js` with
 * `EXDEV: cross-device link not permitted`. **EXDEV is the operative blocker,
 * and it is device-specific.** Configuring `build.client` does not reach it
 * either — in static mode `clientRoot` is `config.outDir` directly
 * (`static-build.js:254`).
 *
 * That is enough, because a publishing tool cannot know what device a user's
 * repository is on: this package may sit on `Q:` while the notes it builds are
 * on `C:`, which reproduces the EXDEV every run. Constraint 1 already forces cwd
 * inside the package, so the only `outDir` guaranteed to share a device with cwd
 * is one inside the package too — and the user's `dist/` can then only be
 * reached by copying afterwards, which `cp` does across devices and `rename`
 * does not. Staging then copying is not the blunt option chosen over a subtler
 * one; it is the shape that holds wherever the user's directory happens to live.
 *
 * `tests/packaging.test.ts` imports `getOutDirWithinCwd` and asserts the
 * redirect, so an Astro upgrade that changes this behaviour arrives as a failing
 * test naming this decision rather than as an EXDEV nobody can place.
 *
 * Astro's JavaScript API, the plan's other candidate, is what runs the build
 * (`import('astro')`, no subprocess) — but its `root` *option* is rejected for
 * the same reason: passing `root` inline still leaves cwd elsewhere, which is
 * constraint 1. It would also mean this file assembling an Astro config in code,
 * giving the project two places a config lives. `astro.config.mjs` staying the
 * only one is worth more.
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

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { failureFor, isDisclosureChecked, openReport, BuildFailure } from '../scripts/write-report.ts';

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
 *
 * **The rejected token is never echoed.** "The user typed it" is not a safety
 * argument on a surface a workflow log inherits — the user typed their withheld
 * filenames too, and measured before this changed, `build
 * clients/acme/2026-renewal` printed that path back verbatim. The rule is that a
 * printed argv token must be byte-equal to a spelling this tool's own table
 * declares, and an *unrecognised* token is by definition not one of those, so
 * there is nothing left that may be printed.
 *
 * A shape test was tried first and rejected on measurement: echoing whatever
 * matches `/^--?[A-Za-z][A-Za-z0-9-]*$/` still prints `--clients-acme-renewal`,
 * which is a withheld note's stem wearing two dashes. A rule that admits a class
 * of tokens has to be right about the whole class; this one admits none.
 *
 * The token is carried on the error's private half, which on this path reaches
 * nobody: parsing happens before `build` opens a report, so an argument refusal
 * has no file to write it to. That is accepted rather than repaired — the user is
 * looking at the command they just typed, so the one string they do not need
 * repeated back is the one they can see. It is recorded here so a later reader
 * does not take the third argument as a promise that it is stored somewhere.
 */
function parseArguments(argv) {
  const options = { content: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return 'help';
    const key = argument === '--content' ? 'content' : argument === '--out' ? 'out' : undefined;
    if (key === undefined) {
      throw new BuildFailure('unknown-option', `unrecognised option\n\n${USAGE}`, argument);
    }
    const value = argv[index + 1];
    // `argument` is `--content` or `--out` by construction here — the ternary
    // above has already rejected everything else — so it is a literal of this
    // tool's own source rather than a user-supplied string.
    if (value === undefined || value.startsWith('--')) {
      throw new BuildFailure('missing-value', `${argument} needs a directory\n\n${USAGE}`);
    }
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
      // Three host paths used to be in this message and now none is: the public
      // half is the error code and which containment relation tripped, and the
      // paths go to the report, where the person who can act on them reads them.
      throw new BuildFailure(
        'unsafe-output-directory',
        `unsafe-output-directory: refusing to build into the directory named by --out, ` +
          `because it is, or contains, ${what}, and the build replaces its output ` +
          'directory wholesale. Name a subdirectory instead — the default is `dist`.',
        `--out ${outDirectory} is, or contains, ${what} (${directory}); ` +
          `the command was run in ${userDirectory}`,
      );
    }
  }
}

/**
 * The report this run opened, so the boundary below can print its two lines
 * however the run ended.
 *
 * A module-level binding because the boundary is a top-level `try`, and there is
 * exactly one `build` per process — `main` returns after it, and the binary has
 * no path that calls it twice. It is cleared at the top of `build` regardless,
 * so that a hypothetical second call which failed to open a report could not
 * announce the first call's.
 */
let openedReport;

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
 * relative `--out` means "relative to where the user typed it". The report's
 * destination is resolved here for a sharper reason: `git rev-parse --git-path`
 * answers **relative to cwd**, so resolving it after the `chdir` below would
 * land it inside this package under `node_modules`.
 */
async function build(options) {
  openedReport = undefined;
  const userDirectory = process.cwd();
  const contentDirectory = resolve(userDirectory, options.content ?? '.');
  const outDirectory = resolve(userDirectory, options.out ?? 'dist');

  // Opened before anything can fail, and it writes its stub immediately. The
  // diagnostic is worth most on the run that failed, and a report written where
  // the counts are convenient — after validation — cannot exist on the run that
  // failed validation, which is the likeliest throw in this function.
  const report = openReport(userDirectory);
  openedReport = report;
  try {
    if (!existsSync(contentDirectory)) {
      throw new BuildFailure(
        'content-directory-not-found',
        'content directory not found: the directory named by --content does not exist',
        contentDirectory,
      );
    }
    assertSafeOutput(outDirectory, contentDirectory, userDirectory);

    await buildInto(contentDirectory, outDirectory, report);
    return report;
  } catch (error) {
    // Recording the failure must not *replace* it. If this second write throws —
    // a full disk, a `.git` that turned read-only mid-run — the build's own
    // error is what the user needs, and a report nobody can write is the lesser
    // loss. The same argument governs the workspace cleanup below; stating it
    // twice is cheaper than a reader finding the two treated differently and
    // wondering which was deliberate.
    try {
      report.failed(failureFor(error));
    } catch {
      // Deliberately empty: see above. The original error is rethrown intact.
    }
    throw error;
  }
}

async function buildInto(contentDirectory, outDirectory, report) {
  // Build inside the package, then copy out. Not an ad-hoc workaround but the
  // shape the two constraints in this file's header force: cwd must be inside
  // the package for prerender chunks to resolve their imports, Astro stages
  // prerender output under cwd and *renames* it to `outDir`, and a rename cannot
  // cross a device. A user's notes may be on any drive, so the only `outDir`
  // guaranteed to share one with cwd is one inside the package. `cp` then
  // performs the cross-device step as a real copy, which `rename` cannot.
  //
  // Inside the package rather than in the OS temp directory for the same
  // reason: `mkdtemp` in `os.tmpdir()` is on `C:` while a checkout may be on
  // `Q:`, which reproduces the very EXDEV this staging exists to avoid.
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

    const { discover, writeArtifact } = await import('../scripts/markdown-to-artifact.ts');
    const artifact = join(workspace, 'content.json');

    // Discovery, then the report, then validation — in that order and not the
    // convenient one. The report stops saying `aborted` the moment discovery
    // finishes, which is *before* the content contract runs over what was
    // discovered and before an empty corpus is refused. That is what puts the
    // names of the dropped files in a readable file on the two runs that need
    // them most: the one the contract rejects, and the one where every file was
    // dropped and there is nothing left to publish.
    const discovery = await discover(contentDirectory);
    report.discovered(discovery.counts, discovery.dropped);
    await writeArtifact(discovery, artifact);

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
    // No path. `site written to <outDirectory>` put a host path on a surface a
    // workflow log inherits, and restoring it as `options.out` would not help —
    // a user-typed argv value is not a safety class.
    console.log('site written');
  } finally {
    // `maxRetries` because this is Windows: measured, removing the staging
    // directory intermittently fails with `EBUSY: resource busy or locked` on a
    // file the just-finished build wrote, which is a scanner or indexer still
    // holding it rather than anything this process did.
    //
    // And caught, because a cleanup failure must not *replace* the build's own
    // failure. It did: on the run that reproduced the EBUSY, the residue scan's
    // five findings were thrown away and the user got the unlink error instead —
    // so the same corpus printed two different things on two runs, and the one
    // it printed on the bad run said nothing about what was actually wrong. A
    // left-behind workspace is a wasted directory; a swallowed diagnostic is a
    // build nobody can debug.
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

async function main(argv) {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command !== 'build') {
    // Same treatment as an unrecognised option, for the reason
    // `parseArguments` gives at length: an unrecognised token is by definition
    // not one of this tool's own spellings, and measured before this changed,
    // `deploy-to-clients-acme` was printed back verbatim. A shape test does not
    // help — that token matches every plausible one.
    console.error(`unrecognised command\n\n${USAGE}`);
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

/**
 * The two report lines, emitted exactly once per `build` however it ended.
 *
 * Unconditional is the decision, and the alternative is worth naming so it is
 * not re-proposed: a line emitted only when something was dropped reaches
 * exactly the user who already had a signal, while the user who needs the report
 * is by definition the one who did not know they would. The file's existence is
 * not self-announcing.
 *
 * Both are rename-invariant by construction — three integers and two source
 * literals — so requiring them strengthens the disclosure differential rather
 * than fighting it.
 */
function announce(report) {
  if (report === undefined) return;
  console.log(report.summary);
  console.log(report.pointer);
}

/**
 * The boundary, and the one place a string nobody here composed could reach a
 * world-readable log.
 *
 * `console.error(error.message)` used to print every throw in the process
 * verbatim, which is how a `readdir` `ENOTDIR` reached stderr with an absolute
 * path already inside a message this project never wrote — and how the residue
 * scanner, whose whole job is keeping an absolute path out of `dist/`, announced
 * that path on the one run where it existed. So only an error constructed under
 * the disclosure rule prints its own message; everything else prints its code,
 * and its real message is in the report's `failure.detail`.
 */
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Three cases, not two, and the third is why this is not one ternary.
  //
  // An error composed under the disclosure rule prints its own message. Anything
  // else prints a fixed literal — including `error.name`, which reads like a
  // harmless literal of this tool's own source and is not one: it is whatever a
  // library or the runtime chose, so it is a third-party string of opaque
  // provenance on the same surface as everything else this rule governs.
  //
  // And an error thrown *before a report was opened* must not point at one. That
  // is not hypothetical: `parseArguments` runs before `build`, so every argument
  // refusal takes this path, as does a failure to open the report itself. A
  // message reading "see the report for the detail" when no report exists sends
  // the user to a file they will not find, which is worse than saying less.
  if (isDisclosureChecked(error)) console.error(error.message);
  else if (openedReport === undefined) console.error('build failed');
  else console.error('build failed — see the report for the detail');
  process.exitCode = 1;
} finally {
  announce(openedReport);
}
