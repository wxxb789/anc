/**
 * `pnpm run build`, holding the `dist/` lock for the whole chain.
 *
 * ## Why a wrapper rather than a lock inside one of the steps
 *
 * The chain is six processes — validate, `astro build`, redirects, Pagefind,
 * output inventory, residue scan. Astro, redirects, and Pagefind write `dist/`;
 * the final two gates read it. No single step spans that: a lock taken in `validate-content.ts` releases when
 * that process exits, which is *before* `astro build` starts, and one taken in
 * `scan-residue.ts` is taken after the writing is done. Something has to
 * outlive all six, and this is the smallest thing that does.
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
 * `pnpm run verify` chains `lint && check && build && test` sequentially, so the
 * build releases before the suite starts and there is no self-deadlock. The one
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

/** The chain `package.json`'s `build` used to name, in order. */
const STEPS: readonly (readonly [string, ...string[]])[] = [
  ['node', 'scripts/validate-content.ts'],
  ['pnpm', 'exec', 'astro', 'build'],
  ['node', 'scripts/emit-redirects.ts'],
  ['node', 'scripts/run-pagefind.ts'],
  ['node', 'scripts/verify-output-inventory.ts'],
  ['node', 'scripts/scan-residue.ts'],
];

function runSteps(): number {
  for (const [command, ...args] of STEPS) {
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
  if (process.env[LOCK_HELD_VARIABLE] === '1') return runSteps();
  const release = await lockDist('pnpm run build');
  try {
    return runSteps();
  } finally {
    release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
