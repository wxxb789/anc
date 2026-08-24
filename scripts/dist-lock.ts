/**
 * A lock over `dist/`, because two commands write it and seven test files read it.
 *
 * ## What actually collides, measured
 *
 * Not `.astro/`, which is what this was blamed on for three tickets. Measured
 * against `astro/dist/core/build/common.js:76-82`: `getOutDirWithinCwd` returns
 * the requested `outDir` unchanged whenever it starts with `process.cwd()`, and
 * `bin/anc.mjs` stages inside `PACKAGE_ROOT` *after* chdir'ing
 * there — so the fallback never fires for the binary, and its per-run `mkdtemp`
 * workspace really is per-run. Executed directly:
 *
 *     getOutDirWithinCwd(<cwd>/.anc-build-abc/dist) -> unchanged
 *     getOutDirWithinCwd(C:/elsewhere/dist)                  -> <cwd>/.astro/
 *
 * And 24 concurrent binary builds, run against a live suite, all exited 0 with
 * no crossover.
 *
 * What collides is `dist/` itself. `astro/dist/core/build/static-build.js:64`
 * calls `emptyDir(config.outDir)` before writing, and `pnpm run build:fixture`
 * builds the 32-note corpus into the *same* `dist/` that `pnpm run build`
 * writes and that `built-output`, `built-routes`, `deployment`, `metadata`,
 * `preview-server`, `search`, and `rendered-page` all read. Reproduced:
 * `build:fixture` concurrent with the suite gives
 * `dist/ has no index.html, so this gate would measure nothing` — five failures
 * in one file, each a read of a directory that was empty at that instant.
 *
 * ## Why a lock rather than a separate output directory
 *
 * Ten modules resolve `../dist` as their own literal — three build scripts,
 * seven test files. Threading a path through all ten is a large diff that still
 * would not stop the two *commands* from disagreeing about which directory the
 * gates should read. The gates are about the published build; there is exactly
 * one of it; the fault is that two writers share it with no interlock.
 *
 * So: whoever holds the lock owns `dist/`, and the other waits. `build:fixture`
 * already rebuilds the published site when it finishes, so waiting is correct
 * rather than merely safe — the suite then reads a complete directory.
 *
 * ponytail: a whole-directory lock, not per-file. Fine here because the two
 * writers are whole-build commands; if a third writer ever needs a subdirectory
 * of `dist/` concurrently, this becomes the wrong granularity.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The lock file. Inside `.astro/`, which `.gitignore` already names. */
export const LOCK_PATH: string = fileURLToPath(new URL('../.astro/dist.lock', import.meta.url));

/**
 * Poll interval. A build takes tens of seconds; sub-second polling buys nothing.
 *
 * Exported because `tests/dist-lock.test.ts` needs it to tell "waited on a held
 * lock" from "was scheduled later" — a gate that restated the number would
 * silently stop discriminating the day this changed.
 */
export const POLL_MS = 500;

/**
 * How many consecutive unreadable polls before a lock is treated as abandoned.
 *
 * The zero-length window is microseconds; five polls is 2.5 s, which no
 * `writeFileSync` of a hundred bytes survives. What this bound is really for is
 * the other case — a file truncated by a process killed mid-write, which no
 * amount of waiting will make parseable.
 */
const UNREADABLE_POLLS = 5;

interface Held {
  pid: number;
  what: string;
  at: number;
}

function read(path: string): Held | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Held;
  } catch {
    return undefined;
  }
}

/**
 * Whether a lock is dead: its holder is no longer running.
 *
 * `process.kill(pid, 0)` throws `ESRCH` for a pid that does not exist and
 * `EPERM` for one this user may not signal — the second means the process *is*
 * alive, so only `ESRCH` counts as gone. A crashed run must not wedge the
 * repository; a live run must not have its lock stolen.
 *
 * **There is deliberately no age cap.** An earlier version declared a holder
 * dead after ten minutes, justified by "a full build is ~60 s". The holder is
 * not a build — it is the whole suite, which has two gates budgeted at
 * `600_000` ms (`tests/adoption.test.ts`) and roughly twenty at `120_000`. The
 * cap was checked *before* the liveness test, so a demonstrably running suite
 * on a slow host had its lock taken and its `dist/` emptied underneath it: the
 * exact failure this module exists to prevent, introduced by the guard against
 * a crash the pid check already covers.
 *
 * Pid reuse is the residual hazard — an OS recycling a crashed holder's pid
 * inside the window. Embedding a start time would close it and costs more than
 * it buys; recorded rather than fixed.
 */
function dead(held: Held): boolean {
  try {
    process.kill(held.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Take the lock, waiting for whoever holds it.
 *
 * @param what What to call this holder in the message the waiter prints.
 * @param path Which lock. Defaults to the one over `dist/`; the gates pass a
 *   scratch path so they can exercise this mechanism *inside* a suite run that
 *   is already holding the real one — measured, taking the real lock from a
 *   test deadlocks the run against its own `globalSetup`.
 * @returns A release function, safe to call twice.
 */
export async function lockDist(what: string, path: string = LOCK_PATH): Promise<() => void> {
  mkdirSync(join(path, '..'), { recursive: true });

  /** Consecutive polls where the holder could not be read. See below. */
  let unreadable = 0;

  for (;;) {
    try {
      // `wx` fails if the file exists, which is what excludes: the existence
      // check and the create are one syscall, so two processes cannot both
      // create it. What it does *not* give is content atomicity — see the
      // `unreadable` handling below.
      writeFileSync(path, JSON.stringify({ pid: process.pid, what, at: Date.now() }), {
        encoding: 'utf8',
        flag: 'wx',
      });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // **`EPERM` is a wait, not a failure**, and this is Windows-specific.
      // `rmSync` marks a file for deletion while a handle is still open, and a
      // `CreateFile` against a delete-pending name returns `ERROR_ACCESS_DENIED`
      // rather than `ENOENT` or `EEXIST`. Measured, two processes contending for
      // six seconds: 67 `EPERM` throws between them. Rethrowing killed the
      // caller — in `build-fixture.ts` that meant dying *before* the restore,
      // leaving `dist/` holding the fixture build, which is the state that
      // function exists to prevent.
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;

      const held = code === 'EEXIST' ? read(path) : undefined;

      // **An unreadable lock means retry, never take.** `writeFileSync` opens
      // and then writes, so there is a window in which the file exists and is
      // empty — measured, 128 zero-length reads between two processes over six
      // seconds. Treating `undefined` as "no holder" and deleting was a live
      // holder's lock being removed while it was mid-create, which is the
      // exclusion failing in the one instant it matters.
      //
      // Retried a bounded number of times rather than for ever, because a
      // genuinely corrupt lock — a truncated file from a killed process — would
      // otherwise wedge the repository permanently. Past the bound it is treated
      // as abandoned, which is the same conclusion the pid check reaches for a
      // holder that is gone.
      if (held === undefined) {
        unreadable += 1;
        if (unreadable < UNREADABLE_POLLS) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          continue;
        }
        rmSync(path, { force: true });
        unreadable = 0;
        continue;
      }

      unreadable = 0;
      if (dead(held)) {
        // The holder is gone. Removing rather than overwriting keeps the `wx`
        // above the only path that takes the lock.
        rmSync(path, { force: true });
        continue;
      }
      console.log(`waiting for dist/ — held by ${held.what} (pid ${held.pid})`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only if it is still ours: a stale-takeover may have handed it on.
    if (read(path)?.pid === process.pid) rmSync(path, { force: true });
  };
}
