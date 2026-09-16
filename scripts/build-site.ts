/**
 * `pnpm run build`, holding the `dist/` lock for the whole chain.
 *
 * ## Why a wrapper rather than a lock inside one of the steps
 *
 * Preview is six processes — validate, Astro, redirects, Pagefind, inventory,
 * residue. Repository `verify` opts into a seventh, secret scan, before residue.
 * Astro, redirects, and Pagefind write `dist/`; the final gates read it. No one
 * child spans that sequence, so this wrapper owns the lock across every child.
 *
 * ## Why `pnpm run build` needs the lock at all
 *
 * Review's finding, and it is the likelier collision of the two. `astro build`
 * calls `emptyDir(config.outDir)` (`astro/dist/core/build/static-build.js:64`)
 * against the same `dist/` that seven test files read — so `pnpm run build` in
 * one terminal against `pnpm test` in another produces the identical five
 * `preview-server` failures that `build:fixture` did. `build` is ~60 s and run
 * constantly; `build:fixture` is minutes and run rarely. The ticket was named
 * for the rare one.
 *
 * `pnpm run verify` passes `--scan-secrets`, keeping build and credential scan
 * atomic before the suite starts; ordinary `build` keeps the preview chain. The one
 * caller that *does* nest is `build-fixture.ts`'s restore step, which spawns
 * this while holding the lock — see `PUBLISH_DIST_LOCK_HELD`.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockDist } from './dist-lock.ts';

/**
 * Set by a caller that already holds the lock, so this does not wait on itself.
 *
 * `scripts/build-fixture.ts` restores the published build by spawning
 * `pnpm run build` from inside its own critical section. Without this the child
 * would block for ever on a lock its parent will not release until the child
 * returns — a deadlock introduced by covering the second writer, which is
 * exactly the kind of thing that makes a lock worse than none.
 */
export const LOCK_HELD_VARIABLE = 'PUBLISH_DIST_LOCK_HELD';

type Step = readonly [string, ...string[]];

/** The preview chain `package.json`'s `build` used to name, in order. */
const STEPS: readonly Step[] = [
  ['node', 'scripts/validate-content.ts'],
  ['node', 'scripts/build-snapshot.ts'],
  ['node', 'scripts/build-wasm.ts'],
  ['pnpm', 'exec', 'astro', 'build'],
  ['node', 'scripts/copy-snapshot.ts'],
  ['node', 'scripts/copy-wasm.ts'],
  ['node', 'scripts/emit-redirects.ts'],
  ['node', 'scripts/run-pagefind.ts'],
  ['node', 'scripts/verify-output-inventory.ts'],
  ['node', 'scripts/scan-residue.ts'],
];
const SECRET_STEP: Step = ['node', 'scripts/scan-secrets.ts'];

function runSteps(includeSecrets: boolean): number {
  const sequence: readonly Step[] = includeSecrets
    ? [...STEPS.slice(0, -1), SECRET_STEP, STEPS.at(-1)!]
    : STEPS;
  for (const [command, ...args] of sequence) {
    const result = spawnSync(command, [...args], {
      stdio: 'inherit',
      // `pnpm` resolves to a `.CMD` shim under some installers and a `.CMD`
      // cannot be executed directly by `CreateProcess`. Same reasoning as
      // `scripts/build-fixture.ts`, including why DEP0190 does not apply: every
      // argument is a literal of this file and none contains a metacharacter.
      shell: process.platform === 'win32',
    });
    if (result.error) {
      console.error(`${command}: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

async function main(): Promise<number> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== '--scan-secrets')) {
    console.error('build-site accepts only --scan-secrets');
    return 1;
  }
  const includeSecrets = arguments_.includes('--scan-secrets');
  if (process.env[LOCK_HELD_VARIABLE] === '1') return runSteps(includeSecrets);
  const release = await lockDist(includeSecrets ? 'pnpm run verify (building)' : 'pnpm run build');
  try {
    return runSteps(includeSecrets);
  } finally {
    release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
