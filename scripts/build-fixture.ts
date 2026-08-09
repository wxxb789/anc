/**
 * Builds the site from the fixture corpus and runs every gate against it.
 *
 * Why a script rather than an inline environment variable in `package.json`:
 * npm runs scripts through `cmd.exe` on Windows, where `VAR=value command` is
 * not assignment, and the alternative is a dependency whose whole job is one
 * line of `process.env`. This is that line.
 *
 * Why it runs the tests too: TK-11's acceptance criterion is that
 * `npm run build:fixture` produces a full site from the fixture corpus **and
 * every existing gate passes against it**. The gates read the artifact through
 * `src/lib/artifact-source.ts`, so they must see the same `CONTENT_ARTIFACT`
 * the build saw. Running them here is what makes that impossible to get wrong —
 * building with the fixture and then testing against the published artifact
 * would compare a 32-note `dist/` with a 1-note corpus and fail for a reason
 * that has nothing to do with the defect under test.
 *
 * Why it rebuilds the published site at the end: the gates over `dist/` read
 * whichever artifact `CONTENT_ARTIFACT` names, so a fixture `dist/` left in
 * place makes the *next* bare `npm run build`-less `npm test` fail six gates
 * for no reason a reader could diagnose. Leaving the tree in the state the
 * default commands expect is worth the extra build.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateArtifact } from '../src/lib/schema.ts';
import { projectIndex } from './validate-content.ts';

const FIXTURE_ARTIFACT = 'tests/fixtures/valid-corpus.json';

/** The published build chain, in order. The test suite runs after it. */
const STEPS: readonly (readonly [string, ...string[]])[] = [
  ['node', 'scripts/validate-content.ts'],
  ['npx', 'astro', 'build'],
  ['node', 'scripts/emit-redirects.ts'],
  ['npx', 'pagefind', '--site', 'dist'],
];

/** Run one step with the fixture artifact selected; returns its exit status. */
function runStep(command: string, args: readonly string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, [...args], {
    stdio: 'inherit',
    env,
    // `npx`, `pagefind`, and `npm` are shell wrappers on Windows and cannot be
    // executed directly, so a shell is required there and only there.
    //
    // Node deprecates `shell: true` with an args array (DEP0190) because the
    // arguments are concatenated rather than escaped. That is a real hazard for
    // caller-supplied input and not for this: every argument is a literal in
    // `STEPS` or in `restorePublishedBuild`, none contains a shell
    // metacharacter, and nothing here interpolates a path, a filename, or an
    // environment value. The artifact path travels in `env`, not in `argv`.
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Overwrite `dist/content-index.json` with the fixture's own projection.
 *
 * Astro copies `public/` verbatim, and `public/content-index.json` is the
 * projection of the *published* artifact — so without this the fixture build
 * serves a one-entry index alongside thirty-two note pages, and every hover
 * preview silently finds nothing. The published build is unaffected: there the
 * copied file is already the right projection, and `validate-content.ts` proves
 * it byte for byte.
 *
 * `public/content-index.json` itself is never touched. It is exporter-generated
 * and the agent contract forbids editing it here.
 */
function writeFixtureIndex(): void {
  const artifact = validateArtifact(JSON.parse(readFileSync(FIXTURE_ARTIFACT, 'utf8')), FIXTURE_ARTIFACT);
  writeFileSync('dist/content-index.json', JSON.stringify(projectIndex(artifact), null, 2) + '\n', 'utf8');
}

function main(): number {
  const env = { ...process.env, CONTENT_ARTIFACT: FIXTURE_ARTIFACT };
  console.log(`building from ${FIXTURE_ARTIFACT}`);

  for (const [command, ...args] of STEPS) {
    const status = runStep(command, args, env);
    if (status !== 0) {
      console.error(`\n${command} ${args.join(' ')} failed with status ${status}`);
      return status;
    }
  }

  writeFixtureIndex();

  const testStatus = runStep('npx', ['vitest', 'run'], env);
  if (testStatus !== 0) {
    console.error(`\nvitest run failed with status ${testStatus}`);
    // Still restore the published build: leaving a fixture `dist/` behind makes
    // the next ordinary `npm test` fail for a second, unrelated reason.
    restorePublishedBuild();
    return testStatus;
  }

  console.log(`\nfixture build ok: every gate passed against ${FIXTURE_ARTIFACT}`);
  restorePublishedBuild();
  return 0;
}

/** Leave `dist/` describing the published artifact, as every other command expects. */
function restorePublishedBuild(): void {
  console.log('\nrestoring the published build in dist/');
  const status = runStep('npm', ['run', 'build'], { ...process.env, CONTENT_ARTIFACT: undefined });
  if (status !== 0) console.error('could not restore the published build — run `npm run build`');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
