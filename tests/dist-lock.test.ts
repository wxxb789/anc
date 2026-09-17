/**
 * The `dist/` interlock: two writers, seven readers, one directory.
 *
 * ## What this is, and what it is not
 *
 * It is **not** a gate about `.astro/`. That was the diagnosis this repository
 * carried for three tickets and it is wrong. Measured against
 * `astro/dist/core/build/common.js:76-82`, `getOutDirWithinCwd` returns the
 * requested `outDir` unchanged whenever it starts with `process.cwd()`, and the
 * binary stages inside `PACKAGE_ROOT` *after* chdir'ing there — executed:
 *
 *     getOutDirWithinCwd(<cwd>/.anc-build-abc/dist) -> unchanged
 *     getOutDirWithinCwd(C:/elsewhere/dist)                  -> <cwd>/.astro/
 *
 * so the fallback never fires for the binary, and its per-run `mkdtemp`
 * workspace really is per-run. Twenty-four concurrent binary builds — run
 * against a live suite — all exited 0 with no crossover.
 *
 * What collides is `dist/` itself:
 * `astro/dist/core/build/static-build.js:64` calls `emptyDir(config.outDir)`
 * before writing, and `build:fixture` builds the 32-note corpus into the same
 * `dist/` seven test files read. Reproduced before the lock existed:
 * `build:fixture` concurrent with the suite produced five failures in
 * `tests/preview-server.test.ts`, each of the form
 * `dist/ has no index.html, so this gate would measure nothing`.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { POLL_MS, lockDist } from '../scripts/dist-lock.ts';
import { SNAPSHOT_DIRECTORY, SNAPSHOT_FILE_PATTERN } from '../src/lib/snapshot.ts';
import { snapshotPath, snapshotText } from './support/snapshot.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * The lock excludes: a second taker waits rather than proceeding.
 *
 * **Mutation watched fail:** changing the `flag: 'wx'` in
 * `scripts/dist-lock.ts` to `'w'` turns this red — the second call succeeds
 * immediately and both holders believe they own `dist/`, which is the state
 * that empties a directory another process is reading.
 */
test('a second taker of the dist lock waits for the first', async () => {
  // A scratch lock, not the real one: this suite's own `globalSetup` already
  // holds `LOCK_PATH`, so taking it here deadlocks the run against itself.
  // Measured — the first draft did exactly that and timed out at 30 s.
  const lock = join(mkdtempSync(join(tmpdir(), 'lock-1-')), 'dist.lock');
  const release = await lockDist('the gate', lock);
  try {
    assert.ok(existsSync(lock), 'the lock file was not created');

    // A second take must not resolve while the first is held. Raced against a
    // timer rather than asserted on a rejection: `lockDist` waits by design, so
    // the property is "does not resolve", and the only way to observe that is
    // to let something else win.
    const second = lockDist('the waiter', lock).then(
      (r) => {
        r();
        return 'took';
      },
    );
    const outcome = await Promise.race([
      second,
      new Promise((resolve) => setTimeout(() => resolve('waited'), 1500)),
    ]);
    assert.equal(outcome, 'waited', 'a second taker acquired the lock while it was held');

    // Releasing lets the waiter through, which is what makes the assertion
    // above "it waits" rather than "it never succeeds".
    release();
    assert.equal(await second, 'took', 'the waiter never acquired the lock after it was released');
  } finally {
    release();
  }
}, 30_000);

/**
 * A lock whose holder died does not wedge the repository.
 *
 * The failure this prevents is worse than the one the lock prevents: a crashed
 * run leaves a file behind, and without this every later build and every later
 * suite blocks until someone deletes it by hand.
 *
 * The dead pid is the *current* process's pid plus a large offset, checked to
 * be unused — rather than a literal like 999999, which is a real pid on a busy
 * host and would make this gate hang.
 */
test('a lock held by a dead process is taken over', async () => {
  let dead = process.pid + 1;
  for (let tries = 0; tries < 10_000; tries += 1, dead += 1) {
    try {
      process.kill(dead, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
    }
  }

  const lock = join(mkdtempSync(join(tmpdir(), 'lock-2-')), 'dist.lock');
  mkdirSync(join(lock, '..'), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: dead, what: 'a crashed run', at: Date.now() }), 'utf8');

  const release = await lockDist('the gate', lock);
  try {
    const held = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
    assert.equal(held.pid, process.pid, 'the stale lock was not taken over');
  } finally {
    release();
  }
}, 30_000);

/**
 * **The gate the ticket asks for**: `build:fixture` and a `dist/` reader do not
 * interleave.
 *
 * Rather than run the real 32-note fixture build — two full Astro builds and a
 * whole suite, several minutes — this drives the same interlock with the same
 * function: one holder empties and refills a scratch directory while a reader
 * repeatedly checks it is never empty. **On the pre-lock code the reader wins
 * that race**; the point of the lock is that it cannot.
 *
 * **Mutation watched fail:** removing the `await lockDist(...)` from the reader
 * below turns this red with `read an empty dist/` — which is exactly the
 * message `tests/preview-server.test.ts` produced when the real
 * `build:fixture` ran concurrently with the real suite.
 */
test('a writer emptying dist/ cannot interleave with a reader holding the lock', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lock-e2e-'));
  const lock = join(scratch, 'dist.lock');
  const marker = join(scratch, 'index.html');
  writeFileSync(marker, 'built', 'utf8');

  let sawEmpty = false;
  let contended = 0;
  let cycles = 0;

  // **The writer holds longer than the poll interval, and that is the fix for
  // this gate's own first version.** Review replayed that version with
  // timestamps: the writer's whole run was 15-264 ms and the reader's 527-746 ms
  // — the reader lost its first acquisition, slept one 500 ms `POLL_MS`, and by
  // the time it woke the writer had finished all eight cycles. The two loops ran
  // strictly sequentially, `sawEmpty` was false because nothing was concurrent,
  // and the gate measured only "a reader that takes no lock at all races".
  // `docs/gate-reading.md` case 2. A critical section shorter than the wait
  // granularity cannot produce contention.
  const HOLD_MS = 700;
  const ROUNDS = 3;

  const writer = (async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
      const release = await lockDist('the writer', lock);
      try {
        rmSync(marker, { force: true });
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        writeFileSync(marker, 'built', 'utf8');
      } finally {
        release();
      }
    }
  })();

  const reader = (async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
      const before = Date.now();
      const release = await lockDist('the reader', lock);
      // Waiting at all is what proves the two overlapped. Without this the gate
      // cannot tell exclusion from scheduling.
      if (Date.now() - before > POLL_MS) contended += 1;
      try {
        cycles += 1;
        if (!existsSync(marker)) sawEmpty = true;
      } finally {
        release();
      }
    }
  })();

  await Promise.all([writer, reader]);
  rmSync(scratch, { recursive: true, force: true });

  assert.equal(cycles, ROUNDS, 'the reader did not complete its rounds');
  // **The non-vacuity that the first version lacked**, and its measured limit.
  //
  // With `HOLD_MS` (700 ms) above `POLL_MS` (500 ms) the reader loses its first
  // acquisition and has to wait, which is what proves the two loops overlapped
  // at all — the first version of this gate ran them strictly sequentially and
  // could not tell exclusion from scheduling.
  //
  // **Measured, this is 1 of 3 rounds, not 3 of 3**, because the reader's own
  // rounds are microseconds and all three complete inside the writer's first
  // hold. Two stronger shapes were tried and both are worse: requiring
  // `contended === ROUNDS` is red on correct code, and driving the reader off a
  // `while (writing)` flag hangs the worker if the writer throws — that one
  // killed a vitest worker outright and is why this stayed a bounded loop.
  //
  // So the claim is the honest one: the loops overlapped at least once, and
  // during that overlap the reader never saw an empty directory. A gate that
  // proved exclusion on every round would need a different instrument than two
  // racing promises in one process.
  assert.ok(
    contended > 0,
    'the reader never waited on a held lock, so the writer and reader did not overlap and this ' +
      'gate measured nothing',
  );
  assert.ok(!sawEmpty, 'read an empty dist/ — the writer emptied it mid-read');
}, 60_000);

/**
 * Every command that empties `dist/` takes the lock.
 *
 * **This gate was vacuous when written and review proved it.** It matched
 * `/lock-dist|lockDist/` over each file — and `scripts/build-fixture.ts` names
 * `tests/lock-dist.ts` in a *JSDoc comment*, so with every real call site
 * deleted the regex still matched the prose. `docs/gate-reading.md` case 1: the
 * instrument was looking at a file that contains the string for a reason
 * unrelated to the property.
 *
 * So it strips comments first, and matches a call rather than a mention.
 *
 * **`pnpm run build` is on the list now, and was the review's other finding.**
 * It is the *other* writer — `astro build` in that chain hits the same
 * `emptyDir(config.outDir)` — and it is the one run constantly, so
 * `pnpm run build` in one terminal against `pnpm test` in another was the
 * likelier collision than the one this ticket was named for. The chain moved
 * into `scripts/build-site.ts`, a wrapper holding the lock across all five
 * steps — no single step can, since the five are five processes and the writing
 * spans three of them.
 *
 * **Mutation watched fail:** deleting the `lockDist` call from
 * `scripts/build-fixture.ts` while leaving its JSDoc intact — the exact edit
 * that kept the first version green — turns this red.
 */
test('every command that empties dist/ takes the lock', () => {
  /** Source with comments removed, so a mention cannot satisfy a call. */
  const code = (file: string): string =>
    readFileSync(join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  for (const [file, what] of [
    ['scripts/build-fixture.ts', 'build:fixture'],
    ['scripts/build-site.ts', 'pnpm run build'],
  ] as const) {
    assert.match(
      code(file),
      /lockDist\(/,
      `${file} empties dist/ without taking the lock (${what})`,
    );
  }

  // The suite is a *reader* and takes it through vitest's config rather than a
  // call of its own, so it is checked on the key that wires it up.
  assert.match(
    code('vitest.config.ts'),
    /globalSetup:\s*\[[^\]]*lock-dist/,
    'the suite reads dist/ without holding the lock',
  );
});

/**
 * The digest-named URL `vite.define` compiles into a build's client bundles.
 *
 * `astro.config.mjs` substitutes the binding from the run's private workspace,
 * so the URL a built site carries is that run's snapshot or a mixed binding.
 */
// Derived from the snapshot module's own path shape, so a route or name change
// cannot leave this gate searching for a URL the build no longer emits.
const BINDING_URL = new RegExp(
  `/${SNAPSHOT_DIRECTORY}/${SNAPSHOT_FILE_PATTERN.source.slice(1, -1)}`,
  'g',
);

/** Every regular file under a directory, in no particular order. */
function outputFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...outputFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * Two concurrent binary builds both produce their own site, snapshot, and binding.
 *
 * This is the property the ticket names, and the corpus half **passed before the
 * lock too** — recorded here rather than dropped, because the measurement is what
 * corrects the diagnosis this repository carried for three tickets. The binary
 * stages per-run and never touches `dist/`; nothing about it needed fixing.
 *
 * Two rather than the twenty-four measured by hand: this runs in CI on every
 * suite, and two is enough to fail if a shared path is ever introduced.
 *
 * **The first version was not concurrent, and the gate now proves it is.**
 * It called `spawnSync` inside `Promise.all`; a synchronous spawn blocks the
 * event loop for the whole build, so the two runs were strictly sequential and
 * the `Promise.all` over already-settled promises only made them *look*
 * concurrent. `docs/gate-reading.md` case 5: the fixture encoded what the
 * author believed the runner did. The builds are now `spawn`ed asynchronously
 * and the test asserts the measured lifetimes overlapped — the later start is
 * before the earlier exit — so the corpora/binding postconditions below are
 * evidence about concurrent builds and not about two sequential ones. Measured
 * on one developer-host run: the two processes were both alive for ~12.8 s
 * (starts 4.4 s/4.4 s, exits 17.2 s/18.9 s on the same monotonic clock).
 *
 * **The binding half of the failed-build row.** Each output must hold exactly
 * one snapshot whose file name is the SHA-256 of its own bytes, whose records
 * name only its own corpus token, and whose compiled binding URL names that
 * same digest; and no file in an output may carry the other corpus's token.
 * A build that staged another run's workspace or artifact fails these even
 * while exiting 0.
 */
test('two concurrent binary builds each produce their own site, snapshot, and binding', async () => {
  const roots = [0, 1].map((index) => {
    const root = mkdtempSync(join(tmpdir(), `conc-${index}-`));
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'note.md'), `# Note\n\nzzqbody${index} prose.\n`, 'utf8');
    return root;
  });

  const binary = join(ROOT, 'bin', 'anc.mjs');
  interface Run {
    status: number | null;
    output: string;
    startedAt: number;
    finishedAt: number;
  }
  const run = (root: string) =>
    new Promise<Run>((resolve) => {
      // Monotonic, so the overlap comparison cannot be moved by a wall-clock
      // jump; both readings come from this one process.
      const startedAt = performance.now();
      const child = spawn(process.execPath, [binary, 'build', '--content', 'notes', '--out', 'out'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.on('close', (status) => resolve({ status, output, startedAt, finishedAt: performance.now() }));
    });

  const runs = await Promise.all(roots.map(run));

  try {
    for (const [index, result] of runs.entries()) {
      assert.equal(result.status, 0, `concurrent build ${index} failed:\n${result.output}`);
    }

    // The concurrency signal, measured rather than assumed. Reverting to a
    // synchronous spawn (or awaiting inside a loop) runs the builds one after
    // the other and reds this line, which is exactly the state this gate exists
    // to detect; the numbers go in the message so a red run shows the gap.
    //
    // **Harness mutation watched fail:** `await run(root)` in a sequential
    // loop put the later start 1 ms *after* the earlier exit and this assertion
    // is what failed, not a later one.
    const latestStart = Math.max(...runs.map((result) => result.startedAt));
    const earliestExit = Math.min(...runs.map((result) => result.finishedAt));
    assert.ok(
      latestStart < earliestExit,
      `the two builds did not overlap: latest start ${latestStart} vs earliest exit ${earliestExit}`,
    );

    // Exactly one snapshot per output, its file name equal to the digest of its
    // own bytes. `snapshotPath` throws unless `data/` holds exactly one
    // digest-pattern candidate, so a missing or second snapshot fails here.
    const snapshots = roots.map((root, index) => {
      const out = join(root, 'out');
      const file = snapshotPath(out);
      const named = SNAPSHOT_FILE_PATTERN.exec(basename(file));
      assert.ok(named, `build ${index}'s snapshot file is not digest-named: ${file}`);
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      assert.equal(named[1], digest, `build ${index}'s snapshot file name does not match its own bytes`);
      return { out, digest, text: snapshotText(out) };
    });
    assert.notEqual(
      snapshots[0]!.digest,
      snapshots[1]!.digest,
      'two distinct corpora produced the same snapshot digest',
    );

    // Each site carries its own note and not its neighbour's — a build that
    // picked up the other's artifact would still exit 0.
    for (const [index, snapshot] of snapshots.entries()) {
      const other = index === 0 ? 1 : 0;
      const page = join(snapshot.out, 'notes', 'note', 'index.html');
      assert.ok(existsSync(page), `concurrent build ${index} produced no note page`);
      const html = readFileSync(page, 'utf8');
      assert.ok(html.includes(`zzqbody${index}`), `build ${index} does not carry its own note`);
      assert.ok(!html.includes(`zzqbody${other}`), `build ${index} carries build ${other}'s note`);

      // The snapshot's own records, not the rendered page: its stored excerpt
      // names the corpus it was built from.
      assert.ok(snapshot.text.includes(`zzqbody${index}`), `build ${index}'s snapshot does not carry its own note`);
      assert.ok(
        !snapshot.text.includes(`zzqbody${other}`),
        `build ${index}'s snapshot carries build ${other}'s note`,
      );

      // One raw pass over every published file: the other corpus's token must
      // appear nowhere, this output must carry its own somewhere, and every
      // compiled binding URL must name this output's own snapshot digest.
      const bound = new Set<string>();
      let ownToken = false;
      for (const file of outputFiles(snapshot.out)) {
        const bytes = readFileSync(file);
        if (bytes.includes(`zzqbody${other}`)) {
          assert.fail(`build ${index} carries build ${other}'s corpus token in ${file}`);
        }
        if (bytes.includes(`zzqbody${index}`)) ownToken = true;
        for (const match of bytes.toString('latin1').matchAll(BINDING_URL)) bound.add(match[1]!);
      }
      assert.ok(ownToken, `build ${index}'s output does not carry its own corpus token`);
      assert.deepEqual(
        [...bound],
        [snapshot.digest],
        `build ${index} compiles a binding that does not name its own snapshot`,
      );
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}, 300_000);
