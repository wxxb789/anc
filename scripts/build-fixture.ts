/**
 * Builds the site from the fixture corpus and runs every gate against it.
 *
 * Why a script rather than an inline environment variable in `package.json`:
 * `VAR=value command` is not assignment in `cmd.exe`, which is what runs a
 * script on Windows. pnpm can paper over that with `shellEmulator`, but that
 * setting changes how *every* script in the manifest is interpreted, which is a
 * much larger blast radius than the one line of `process.env` it would save —
 * and it would not shorten this file, which orchestrates five build steps, the
 * test run, and the restore below rather than setting one variable.
 *
 * Why it runs the tests too: TK-11's acceptance criterion is that
 * `pnpm run build:fixture` produces a full site from the fixture corpus **and
 * every existing gate passes against it**. The gates read the artifact through
 * `src/lib/artifact-source.ts`, so they must see the same `CONTENT_ARTIFACT`
 * the build saw. Running them here is what makes that impossible to get wrong —
 * building with the fixture and then testing against the published artifact
 * would compare a 32-note `dist/` with a 1-note corpus and fail for a reason
 * that has nothing to do with the defect under test.
 *
 * Why it rebuilds the published site at the end: the gates over `dist/` read
 * whichever artifact `CONTENT_ARTIFACT` names, so a fixture `dist/` left in
 * place makes the *next* bare `pnpm run build`-less `pnpm test` fail six gates
 * for no reason a reader could diagnose. Leaving the tree in the state the
 * default commands expect is worth the extra build.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateArtifact } from '../src/lib/schema.ts';
import { projectIndex } from './validate-content.ts';
import { lockDist } from './dist-lock.ts';
import { LOCK_HELD_VARIABLE } from './build-site.ts';

const FIXTURE_ARTIFACT = 'tests/fixtures/valid-corpus.json';

/** The published build chain, in order. The test suite runs after it. */
const STEPS: readonly (readonly [string, ...string[]])[] = [
  ['node', 'scripts/validate-content.ts'],
  ['pnpm', 'exec', 'astro', 'build'],
  ['node', 'scripts/emit-redirects.ts'],
  // `scripts/run-pagefind.ts` rather than `pnpm exec pagefind --site dist`,
  // which is what this line used to be. The two are not the same command: the
  // script passes `excludeSelectors: ['.heading-anchor']` and the bare CLI
  // invocation passed nothing, so the fixture corpus was indexed with every
  // heading anchor's `#` in it while the published build was not — a difference
  // between the corpus the search gates measure and the one that ships.
  ['node', 'scripts/run-pagefind.ts'],
];

/** Run one step with the fixture artifact selected; returns its exit status. */
function runStep(command: string, args: readonly string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, [...args], {
    stdio: 'inherit',
    env,
    // `pnpm` resolves to a `.CMD` shim under Corepack and under some installers,
    // and a `.CMD` cannot be executed directly by `CreateProcess`. It happens to
    // be a real `.exe` on this machine, so the shell is not always needed — but
    // which one a contributor has is not this script's to know, and the `node`
    // steps are unaffected either way.
    //
    // Node deprecates `shell: true` with an args array (DEP0190) because the
    // arguments are concatenated rather than escaped. That is a real hazard for
    // caller-supplied input and not for this: every argument is a literal in
    // this file; none contains a shell metacharacter, and nothing here
    // interpolates a path, a filename, or an
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

/**
 * Build the fixture site, run its gates, restore the published build.
 *
 * **The lock is taken and released three times, not held throughout**, and the
 * shape is forced rather than chosen: the middle step is `vitest run`, whose
 * own `globalSetup` takes the same lock (`tests/lock-dist.ts`). Holding it
 * across that call would deadlock this command against itself. So each phase
 * that *writes* `dist/` holds it, and the phase that reads `dist/` — the suite —
 * takes it for itself.
 *
 * `scripts/dist-lock.ts` records what collides and why it is a lock.
 */
async function main(): Promise<number> {
  const env = { ...process.env, CONTENT_ARTIFACT: FIXTURE_ARTIFACT };
  console.log(`building from ${FIXTURE_ARTIFACT}`);

  const releaseBuild = await lockDist('build:fixture (building)');
  try {
    for (const [command, ...args] of STEPS) {
      const status = runStep(command, args, env);
      if (status !== 0) {
        console.error(`\n${command} ${args.join(' ')} failed with status ${status}`);
        return status;
      }
    }
    writeFixtureIndex();
    const inventoryStatus = runStep('node', ['scripts/verify-output-inventory.ts'], env);
    if (inventoryStatus !== 0) {
      console.error('\noutput inventory failed with status ' + inventoryStatus);
      return inventoryStatus;
    }
    const secretStatus = runStep('node', ['scripts/scan-secrets.ts'], env);
    if (secretStatus !== 0) {
      console.error('\nsecret scan failed with status ' + secretStatus);
      return secretStatus;
    }
  } finally {
    releaseBuild();
  }

  // The bilingual corpus drives many nested Astro/Pagefind builds; two workers
  // prevent their temporary manifests competing under peak host load.
  const testStatus = runStep('pnpm', ['exec', 'vitest', 'run', '--maxWorkers=2'], env);
  if (testStatus !== 0) {
    console.error(`\nvitest run failed with status ${testStatus}`);
    // Still restore the published build: leaving a fixture `dist/` behind makes
    // the next ordinary `pnpm test` fail for a second, unrelated reason.
    await restorePublishedBuild();
    return testStatus;
  }

  console.log(`\nfixture build ok: every gate passed against ${FIXTURE_ARTIFACT}`);
  await restorePublishedBuild();
  return 0;
}

/** Leave `dist/` describing the published artifact, as every other command expects. */
async function restorePublishedBuild(): Promise<void> {
  console.log('\nrestoring the published build in dist/');
  const release = await lockDist('build:fixture (restoring)');
  try {
    // `LOCK_HELD_VARIABLE` because `pnpm run build` now takes the lock itself,
    // and a child waiting on a lock its parent will not release until the child
    // returns is a deadlock — introduced by covering the second writer, which
    // would make the lock worse than none. The child inherits ownership rather
    // than contending for it.
    const status = runStep('pnpm', ['run', 'build'], {
      ...process.env,
      CONTENT_ARTIFACT: undefined,
      [LOCK_HELD_VARIABLE]: '1',
    });
    if (status !== 0) console.error('could not restore the published build — run `pnpm run build`');
  } finally {
    release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
