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
 * **It gives the site the user's identity, and did not until TK-31.** A site
 * built here used to carry *this repository's*: `https://thoughtscape.invalid`
 * as its origin in every canonical link, feed id, sitemap `<loc>`, and
 * `robots.txt`; `thoughtscape` as its name; this owner's social card; and an
 * `/about/` page describing publication from "an explicit approval list", which
 * is not how a build from a directory of Markdown works. All of it was measured
 * in a real packaged build rather than inferred, and the failure was silent —
 * the site was valid, rendered correctly, and was wrong about whose it was.
 *
 * The title and origin now come from the user's `publish.config.yaml`, and the
 * defaults a user who configures nothing gets belong to nobody: a neutral site
 * name and an RFC 6761 `.localhost` preview origin. The line that makes it true
 * from *this* file is the `PUBLISH_CONFIG_DIR` assignment in `buildInto`, which
 * documents at its own site why it is an environment variable.
 *
 * One piece is deliberately unfinished: there is no `og:image`, because a
 * default social card is an image belonging to this package appearing on a
 * stranger's site. A user supplying their own is a later ticket.
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
  thoughtscape-publish init [options]
  thoughtscape-publish review [options]
  thoughtscape-publish build [options]
  thoughtscape-publish preview [options]

Options for init and review
  --content <dir>  directory holding the Markdown (default: the working directory)

Options for build
  --content <dir>  directory holding the Markdown (default: the working directory)
  --out <dir>      where to write the site (default: <working directory>/dist)
  --release        require a non-loopback origin and committed exact publish-set review

Options for preview
  --dist <dir>     the built site to serve (default: <working directory>/dist)
  --port <number>  the port to listen on (default: 4321)

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
  const options = { content: undefined, out: undefined, release: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return 'help';
    if (argument === '--release') {
      options.release = true;
      continue;
    }
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

function parseReviewArguments(argv) {
  const options = parseArguments(argv);
  if (options === 'help') return options;
  if (options.out !== undefined || options.release) {
    const option = options.out !== undefined ? '--out' : '--release';
    throw new BuildFailure('unknown-option', `review does not accept ${option}\n\n${USAGE}`, option);
  }
  return { content: options.content };
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

    await buildInto(contentDirectory, outDirectory, report, options.release);
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

async function buildInto(contentDirectory, outDirectory, report, release) {
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

    const { discover, resolveCorpusLinks, writeArtifact } = await import('../scripts/markdown-to-artifact.ts');
    const { exclusionOptions, isLoopbackOrigin, loadConfig, CONFIG_DIRECTORY_VARIABLE } = await import('../scripts/load-config.ts');
    const artifact = join(workspace, 'content.json');

    // Read from the *content* directory, not from cwd: `--content` may name a
    // subdirectory, and the configuration belongs with the notes it governs.
    // Absent is the ordinary case and yields the documented defaults.
    const config = loadConfig(contentDirectory);
    if (release && (config.origin === undefined || isLoopbackOrigin(config.origin))) {
      throw new BuildFailure(
        'release-origin-missing',
        'release blocked: publish.config.yaml must declare a non-loopback public origin',
      );
    }

    // Tell `astro.config.mjs` where to read the same file from, and this line is
    // the difference between a configured site and a silently ignored
    // configuration. Measured without it: a `publish.config.yaml` naming
    // `title` and `origin` built a site carrying neither — the placeholder
    // origin in every canonical link and feed id, the default name in every
    // browser tab — and the build reported success. A stranger configures their
    // site, gets this package's defaults, and is told nothing.
    //
    // **An environment variable rather than an argument, and there is no
    // argument available to pass.** Astro loads `astro.config.mjs` itself, from
    // inside `astroBuild()` below; nothing here calls it, so there is no
    // parameter to thread a directory through. The config's scope then reads
    // `process.env` because that is the only channel that crosses into it.
    // `CONTENT_ARTIFACT` is set a few lines down for exactly the same reason and
    // has the same shape. Anyone tempted to "clean this up" into a function
    // argument will find there is no function.
    //
    // Set *before* the `chdir` below rather than after, though either works
    // today: `contentDirectory` is already absolute. Keeping it beside the
    // `loadConfig` call means the two readers of this directory sit together,
    // and a future relative path cannot silently start resolving against the
    // package root.
    process.env[CONFIG_DIRECTORY_VARIABLE] = contentDirectory;

    // Discovery, then the report, then validation — in that order and not the
    // convenient one. The report stops saying `aborted` the moment discovery
    // finishes, which is *before* the content contract runs over what was
    // discovered and before an empty corpus is refused. That is what puts the
    // names of the dropped files in a readable file on the two runs that need
    // them most: the one the contract rejects, and the one where every file was
    // dropped and there is nothing left to publish.
    // The configured exclusions reach discovery here, and this argument is the
    // whole of what makes them real. Without it `discover` walks with its
    // structural ignores alone and a user who excluded `drafts/**` publishes
    // their drafts — measured, and the wrong direction for a privacy boundary to
    // fail in: a fail-open exclusion looks exactly like a working one until
    // somebody reads the site.
    //
    // `exclusionOptions(config)` rather than `{ exclude: config.exclude }`, and
    // the difference is one a hand test does not show: it also passes
    // `excludeSource`, which is what lets a pattern matching nothing name the
    // file to edit. Measured with the bare object — a config whose `draft/**`
    // was a typo for `drafts/**` failed with `the exclude list — exclude[0]
    // matched 0 files`, sending the user to look for a list the tool would not
    // name. `markdown-to-artifact.ts` validates the label against its own
    // filename allowlist before printing it, so this cannot become a disclosure.
    const discovery = await discover(contentDirectory, exclusionOptions(config));

    // Between discovery and the artifact, because this is where the link
    // findings come from and the report has to carry them: `discover` holds no
    // report handle and `writeArtifact` holds none either, so this call site is
    // the only place a link finding can reach the report.
    //
    // The report is named by `scripts/write-report.ts` and never here — not
    // even in a comment. `tests/packaging.test.ts` scans every module the build
    // loads for the report's filename and exempts only its writer, on the
    // reasoning that a module which *names* the report is one layer from a
    // module that prints it. That gate fired on an earlier draft of this
    // comment, which is the gate working rather than a rule being pedantic.
    //
    // It also rewrites the bodies. Without it `outgoing` is empty for every
    // note, and every wikilink survives into the artifact unresolved — so on
    // the shipped binary a repository containing one did not build at all.
    // Measured; the feature was reachable only from the test suite.
    const links = await resolveCorpusLinks(discovery);
    report.discovered(discovery.counts, discovery.dropped, links);
    if (release) {
      const { assertPublishSetReviewed } = await import('../scripts/publish-set-review.ts');
      assertPublishSetReviewed(contentDirectory, discovery.entries.map((entry) => entry.slug));
    }
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

    const { assertOutputInventory } = await import('../scripts/verify-output-inventory.ts');
    assertOutputInventory(staging, validated);

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

/**
 * Prepare a notes repository for its first build.
 *
 * `scripts/init-repository.ts` documents what is written and what deliberately
 * is not. What belongs here is the reporting, which is the half a user judges
 * the command by: `init` writes into a repository the user owns, so every line
 * it prints is an account of a file it touched.
 *
 * **Every string on this stream is a literal of this tool's own source.** The
 * seeded entries, the config filename, and the tracked-case advice are all
 * constants declared in `scripts/seed-gitignore.ts` and `scripts/load-config.ts`
 * — a closed set, byte-equal to a spelling this tool declares, which is the rule
 * `parseArguments` states. No path the user supplied and no name discovered on
 * their filesystem reaches it. That is what makes `init` printable at all where
 * `build` prints counts: `build` speaks about the user's corpus and `init`
 * speaks only about its own two files.
 *
 * It opens no report, for the reason `preview` gives: a report describes a
 * corpus, and this command reads none.
 *
 * The four outcomes are each reported, including the two that wrote nothing.
 * "Already covered" is the answer a user running this a second time needs, and
 * `tracked` is the one case where the tool cannot fix the problem itself and
 * hands back the command that can.
 */
async function init(argv) {
  const { initialise, parseInitArguments } = await import('../scripts/init-repository.ts');
  const { CONFIG_FILENAME } = await import('../scripts/load-config.ts');

  const options = parseInitArguments(argv);
  const result = initialise(resolve(process.cwd(), options.content));

  for (const outcome of result.ignore.outcomes) {
    if (outcome.state === 'tracked') {
      // The rule was written; what it cannot do is take effect on a path git is
      // already tracking, because `git add -A` stages a modification to a
      // tracked file whatever the ignore rules say. So the line and the command
      // are both needed, and the message says which does what — an earlier
      // version said an ignore rule "cannot help" and wrote none, which left the
      // user's `git rm --cached` undone by their next `git add -A`.
      console.log(`.gitignore: ${outcome.entry} — added, but this path is already tracked, so it stays staged until:`);
      console.log(`  ${outcome.advice}`);
      continue;
    }
    const said = {
      seeded: 'added to .gitignore',
      covered: 'already ignored',
      negated: 'left alone — this repository un-ignores it deliberately',
    }[outcome.state];
    console.log(`.gitignore: ${outcome.entry} — ${said}`);
  }

  if (result.ignore.unprobed) {
    // The state words above mean something weaker on this branch and the line
    // says so: with no repository there is nothing to ask, so `already ignored`
    // is "this exact line is in the file" rather than git's answer. A user who
    // has a global ignore rule, or who later writes a `!dist/`, gets the probed
    // reading from the next run after `git init`.
    console.log('.gitignore: not a git repository yet, so the entries were matched as text rather than checked');
  }

  console.log(
    result.config === 'written'
      ? `${CONFIG_FILENAME}: written, with every key commented out — edit it, or leave it`
      : `${CONFIG_FILENAME}: already present, left unchanged`,
  );
}

/** Compute the public note set and write the candidate review ledger. */
async function review(argv) {
  const options = parseReviewArguments(argv);
  const contentDirectory = resolve(process.cwd(), options.content ?? '.');
  if (!existsSync(contentDirectory)) {
    throw new BuildFailure(
      'content-directory-not-found',
      'content directory not found: the directory named by --content does not exist',
      contentDirectory,
    );
  }
  const { discover } = await import('../scripts/markdown-to-artifact.ts');
  const { exclusionOptions, loadConfig } = await import('../scripts/load-config.ts');
  const { PUBLISH_SET_REVIEW_FILE, writePublishSetReview } = await import('../scripts/publish-set-review.ts');
  const config = loadConfig(contentDirectory);
  const discovery = await discover(contentDirectory, exclusionOptions(config));
  const count = writePublishSetReview(contentDirectory, discovery.entries.map((entry) => entry.slug));
  console.log(`publish set review written: ${count} notes`);
  console.log(`inspect and commit ${PUBLISH_SET_REVIEW_FILE} before a release build`);
}

/**
 * Serve a built site, and stay in the foreground until interrupted.
 *
 * The command that makes the tool's own output readable to the person who ran
 * it — `scripts/preview-site.ts` documents why a subcommand exists at all when
 * `astro preview` does, and it comes down to `astro` not being on a pnpm
 * install's `.bin` at all.
 *
 * It opens no report. A report describes a corpus, and this command reads no
 * corpus — it reads a directory of HTML the build already accounted for. Opening
 * one would announce a `no such thing was dropped` summary for a run that
 * dropped nothing because it discovered nothing, which is a line that says
 * something false about a build that already happened.
 *
 * **Nothing holds the process open, because the listening socket already does.**
 * An `await new Promise(() => {})` was written here first, on the reasoning that
 * `main` returning would let Node exit. Measured with that line removed: the
 * command served normally past 12 s and answered 200. Node's event loop is held
 * by the listening handle, which is what a server handle is for. The line was
 * not merely redundant — an unsettled top-level await makes Node print `Warning:
 * Detected unsettled top-level await` and exit **13** when the loop does drain,
 * so it turned a clean shutdown into a warning and a failure code.
 */
async function preview(argv) {
  const { parsePreviewArguments, resolveArtifactDirectory, startPreview } = await import(
    '../scripts/preview-site.ts'
  );

  const options = parsePreviewArguments(argv);
  const artifact = resolveArtifactDirectory(options.dist, process.cwd());
  const server = await startPreview(artifact, options.port, PACKAGE_ROOT);

  // The port comes from the server rather than from `options`, because a taken
  // port moves: measured, `preview()` on a held 4580 returned 4581. Printing
  // what was asked for would send the user to a port nothing is listening on.
  //
  // No path in the line, for the reason every other stream write in this file
  // gives — `--dist` may name a withheld directory, and this stream is one a
  // workflow log inherits.
  console.log(`preview: http://localhost:${server.port}/`);
  console.log('press Ctrl-C to stop');
}

async function main(argv) {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === 'init' || command === 'review' || command === 'preview') {
    const rest = argv.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(USAGE);
      return 0;
    }
    if (command === 'init') await init(rest);
    else if (command === 'review') await review(rest);
    else await preview(rest);
    return 0;
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
