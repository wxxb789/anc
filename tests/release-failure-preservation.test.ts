/**
 * A failed build leaves the last good output exactly as it was.
 *
 * Goal 0006's "Failed-build preservation" row, asserted at the level a user
 * experiences it: run the shipped binary in a foreign git repository, fail the
 * build on purpose at each stage reachable from outside, and read the output
 * directory back byte for byte.
 *
 * ## The shape the property rests on
 *
 * `bin/anc.mjs`'s `buildInto` stages everything inside a per-run workspace
 * under the package root, and reaches the `rm`/`mkdir`/`cp` copy-out only after
 * the last scan has passed. The user's `--out` is not touched until then, which
 * is why every failure below leaves it alone — and why the `finally` that
 * removes the workspace cannot destroy the previous output either.
 * `tests/publish-set-cli.test.ts` already asserts one route page survives one
 * late failure; this file asserts the whole tree, including the snapshot, for a
 * failure at each reachable stage.
 *
 * ## Which stage each injection reaches
 *
 * Measured against a two-note release-mode fixture whose prior build had
 * already succeeded (clean release build ~17-19 s on this host under load):
 *
 * | injection | stderr (head) | stage reached |
 * | --- | --- | --- |
 * | malformed frontmatter | `malformed YAML frontmatter` (~0.6 s) | discovery, before `writeArtifact`, Astro, the snapshot copy, the inventory and both scans |
 * | `/home/<token>/` in a body | `residue scan: 6 findings` / `… contains absolute home-directory path` (~14 s) | after the secret scan passed and after the snapshot copy |
 * | a synthetic `ghp_` PAT | `secret scan found 10 findings` (~11 s) | after the inventory, before the residue scan |
 *
 * The first row is a pre-render failure in the strict sense: `frontmatterOf`
 * throws while discovery reads the corpus, so `astroBuild` never starts. That
 * is the check the task asked for — `publish: no`, the non-boolean-flag half of
 * the same contract, was also run by hand and fails at the same stage with
 * `frontmatter publish: must be true or false`; malformed YAML is used here
 * because its stderr names the fault unambiguously.
 *
 * ## DB copy and inventory, which this file cannot inject through the CLI
 *
 * The snapshot copy compares staged bytes against the digest bound into the
 * public filename, and the output inventory runs over the private staging
 * directory. Neither has a command-line switch, so their injection evidence
 * lives in `tests/output-inventory.test.ts`: `a corrupted or missing bound
 * snapshot or wasm member fails by its own code` for the digest and schema
 * branches, and `the copy step refuses staged bytes that do not hash to the
 * bound digest` for the copy step. What this file adds for those stages is the
 * end-to-end boundary: every one of them runs in the workspace under the
 * package root before the copy-out, so a failure in any of them cannot have
 * touched the prior output. The three injections above are the end-to-end
 * proof for every stage a user can reach; the two module-level stages are shown
 * injectable by `tests/output-inventory.test.ts` and share the same position
 * ahead of the copy-out.
 *
 * ## The instrument
 *
 * A whole-tree hash: every file's relative path, SHA-256, and byte size,
 * sorted, hashed as one manifest. The stability test builds twice and requires
 * the same digest before any injection is allowed to lean on it — a gate that
 * compares two hashes of a build that is not deterministic measures noise, not
 * preservation (`docs/gate-reading.md`).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';

import { SNAPSHOT_DIRECTORY, SNAPSHOT_FILE_PATTERN } from '../src/lib/snapshot.ts';
import { resolveArtifactDirectory } from '../scripts/preview-site.ts';
import { snapshotPath } from './support/snapshot.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin/anc.mjs');

/**
 * Every build here is a real one, so the budget is a hang detector rather than
 * the expected cost. A contended host took 20-35 s per clean build in the
 * sibling gates; 600 s is ~20x that.
 */
const TEST_TIMEOUT = 600_000;
/** The child's own bound, below the test's, so a hang fails with the child named. */
const SPAWN_TIMEOUT = 540_000;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string;
}

/** Run the shipped binary from inside a fixture repository, as a user would. */
function run(cwd: string, args: readonly string[]): RunResult {
  const result = spawnSync(process.execPath, [BINARY, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? '',
  };
}

/** The concatenated streams, which are one surface to a workflow log. */
function streams(result: RunResult): string {
  return `${result.stdout}${result.stderr}`;
}

/**
 * A release build into the fixture's `out/`, which is also where
 * {@link createRepository} points `repository.out`.
 */
function releaseBuild(root: string): RunResult {
  return run(root, ['build', '--release', '--out', 'out']);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`);
}

const scratch: string[] = [];

/** A temporary directory removed after the file, whatever the tests did. */
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

/** Valid frontmatter, so the fixture exercises the parser and not only headings. */
function note(title: string): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\nOrdinary prose.\n`;
}

/**
 * A foreign git repository prepared for release, mirroring
 * `tests/publish-set-cli.test.ts`: a published note, a config with a public
 * origin, and a committed exact publish set.
 */
function createRepository(prefix: string, notes: Record<string, string>): { root: string; out: string } {
  const root = temporary(prefix);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Release Preservation']);
  git(root, ['config', 'user.email', 'preservation@example.invalid']);
  writeFileSync(join(root, 'publish.config.yaml'), 'origin: https://notes.example.org/\n', 'utf8');
  for (const [name, body] of Object.entries(notes)) writeFileSync(join(root, name), body, 'utf8');

  const reviewed = run(root, ['review']);
  assert.equal(reviewed.status, 0, `review did not succeed:\n${streams(reviewed)}`);
  git(root, ['add', '--', '.publish-set.json']);
  git(root, ['commit', '--quiet', '-m', 'review publish set']);

  return { root, out: join(root, 'out') };
}

interface TreeFile {
  path: string;
  sha256: string;
  size: number;
}

interface Tree {
  digest: string;
  files: TreeFile[];
}

/**
 * The whole-tree hash: relative path, SHA-256, and byte size of every file,
 * sorted by path into one manifest, then hashed.
 */
function treeHash(directory: string): Tree {
  const files: TreeFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        files.push({
          path: relative(directory, path).split(sep).join('/'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.byteLength,
        });
      }
    }
  };
  walk(directory);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  };
}

/** The digest-named snapshots a directory carries, if it carries any. */
function snapshotCandidates(directory: string): string[] {
  const data = join(directory, SNAPSHOT_DIRECTORY);
  return existsSync(data) ? readdirSync(data).filter((name) => SNAPSHOT_FILE_PATTERN.test(name)) : [];
}

/**
 * Assert a build failed and left `out` byte-identical to the recorded tree,
 * including the last good route page — the half a hash alone would not explain.
 */
function assertPreserved(failed: RunResult, out: string, good: Tree, what: string): void {
  assert.equal(
    failed.status,
    1,
    `${what} did not fail the build (status ${failed.status}${failed.error === '' ? '' : `, ${failed.error}`}):\n` +
      streams(failed),
  );
  assert.ok(
    existsSync(join(out, 'notes', 'alpha', 'index.html')),
    `${what} removed the last good route page`,
  );
  const after = treeHash(out);
  assert.equal(
    after.digest,
    good.digest,
    `${what} changed the prior output: ${after.files.length} files now against ${good.files.length} before`,
  );
}

let repository: { root: string; out: string };
let goodTree: Tree;

beforeAll(() => {
  repository = createRepository('anc-preserve-', {
    'alpha.md': note('Alpha note'),
    'trigger.md': note('Trigger note'),
  });

  const built = releaseBuild(repository.root);
  assert.equal(built.status, 0, `the fixture's first release build did not succeed:\n${streams(built)}`);

  // One snapshot, and its filename digest is its bytes: the prior output is a
  // real build, not a directory that happens to exist.
  const marker = snapshotPath(repository.out);
  const digest = SNAPSHOT_FILE_PATTERN.exec(marker.split(sep).at(-1)!)?.[1];
  assert.ok(digest !== undefined, `the snapshot is not digest-named: ${marker}`);
  assert.equal(
    createHash('sha256').update(readFileSync(marker)).digest('hex'),
    digest,
    'the snapshot filename digest does not match its bytes',
  );

  goodTree = treeHash(repository.out);
  assert.ok(goodTree.files.length > 10, `the fixture built only ${goodTree.files.length} files`);
}, TEST_TIMEOUT);

afterAll(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 120_000);

test('a successful release build is byte-stable across two consecutive builds', () => {
  const second = releaseBuild(repository.root);
  assert.equal(second.status, 0, `the second release build did not succeed:\n${streams(second)}`);

  const marker = snapshotPath(repository.out);
  assert.match(marker.split(sep).at(-1)!, SNAPSHOT_FILE_PATTERN, 'the one snapshot is not digest-named');

  const after = treeHash(repository.out);

  // Non-vacuity: the hash has to have seen the artifact it claims to protect.
  // A walk that found nothing, or a build that shipped no snapshot, would
  // compare two empty manifests and pass — the failure mode
  // `docs/gate-reading.md` calls "empty output is not green".
  assert.ok(after.files.length > 10, `the tree hash saw ${after.files.length} files, which is not a built site`);
  assert.ok(
    after.files.some(
      (file) => file.path.startsWith(`${SNAPSHOT_DIRECTORY}/site.`) && file.path.endsWith('.sqlite'),
    ),
    'the tree hash did not see the snapshot',
  );

  assert.equal(
    after.digest,
    goodTree.digest,
    'two consecutive successful builds produced different bytes, so this instrument measures noise',
  );
}, TEST_TIMEOUT);

test('a pre-render content failure leaves the prior output byte-identical', () => {
  // Malformed YAML in the block that may carry `publish: false`: the producer
  // refuses rather than silently discarding the flag. `frontmatterOf` throws
  // while discovery reads the corpus, so the renderer and every later stage are
  // never reached.
  writeFileSync(
    join(repository.root, 'trigger.md'),
    '---\ntitle: [unclosed\n---\n\n# Trigger\n\nBody.\n',
    'utf8',
  );

  const failed = releaseBuild(repository.root);
  assertPreserved(failed, repository.out, goodTree, 'a malformed-frontmatter build');

  assert.match(failed.stderr, /malformed YAML frontmatter/, 'the build did not fail at the frontmatter parse');
  assert.match(
    failed.stdout,
    /discovery did not finish/,
    'the run reached past discovery, so this is not a pre-render failure',
  );
  assert.doesNotMatch(
    failed.stdout,
    /secret scan ok|residue scan ok/,
    'a later stage ran, so this failure is not pre-render',
  );
}, TEST_TIMEOUT);

test('a residue-scan failure leaves the prior output byte-identical', () => {
  writeFileSync(
    join(repository.root, 'trigger.md'),
    '# Trigger\n\nExported from /home/zzqplanted/ today.\n',
    'utf8',
  );

  const failed = releaseBuild(repository.root);
  assertPreserved(failed, repository.out, goodTree, 'a residue-scan build');

  // The secret scan runs first and passed, which pins the failure to the scan
  // after it rather than to any earlier gate.
  assert.match(
    failed.stdout,
    /secret scan ok: \d+ files, 0 findings/,
    'the secret scan did not pass, so this failure is not the residue scan',
  );
  assert.match(failed.stderr, /residue scan: \d+ findings?/, 'the build did not fail at the residue scan');
  assert.match(failed.stderr, /absolute home-directory path/, 'the residue finding is not the planted one');
  assert.doesNotMatch(failed.stdout, /residue scan ok/, 'the residue scan passed, so this is not a residue failure');
  assert.ok(
    !streams(failed).includes('zzqplanted'),
    'the residue scanner echoed the matched bytes on a stream',
  );
}, TEST_TIMEOUT);

test('a secret-scan failure leaves the prior output byte-identical and prints no token', () => {
  // Split across two literals so this file itself never carries a contiguous
  // credential-shaped string; the note receives the joined form.
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  writeFileSync(join(repository.root, 'trigger.md'), `# Trigger\n\nToken: ${secret}\n`, 'utf8');

  const failed = releaseBuild(repository.root);
  assertPreserved(failed, repository.out, goodTree, 'a secret-scan build');

  assert.match(failed.stderr, /secret scan found \d+ findings?/, 'the build did not fail at the secret scan');
  assert.match(
    failed.stdout,
    /\d+ discovered, \d+ published/,
    'discovery did not finish, so the build cannot have reached the scan',
  );
  assert.doesNotMatch(failed.stdout, /residue scan/, 'the residue scan ran, so the build passed the secret scan');
  assert.ok(!streams(failed).includes(secret), 'the synthetic token reached a stream');
}, TEST_TIMEOUT);

test('a first failed build leaves no preview-acceptable output', () => {
  const secret = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
  const root = createRepository('anc-first-failure-', {
    'secret-note.md': `# Secret Note\n\nToken: ${secret}\n`,
  }).root;
  const out = join(root, 'out');

  const failed = releaseBuild(root);
  assert.equal(failed.status, 1, `the first build did not fail:\n${streams(failed)}`);
  // Non-vacuity: the run reached the secret scan, which is past Astro, the
  // snapshot copy, and the inventory, and is the last wall before the copy-out
  // — so the absence below is a statement about a full build that failed, not
  // one that refused before doing anything.
  assert.match(failed.stderr, /secret scan found \d+ findings?/, 'the first build failed before the secret scan');
  assert.match(failed.stdout, /\d+ discovered, \d+ published/, 'discovery did not finish');

  assert.deepEqual(
    snapshotCandidates(out),
    [],
    'a first failed build left a preview-acceptable snapshot',
  );

  // The CLI's own refusal, through the shipped entry point. `preview-site.ts`
  // checks the directory before `startPreview` opens a socket, so the
  // observable is the refusal message and a process that exits rather than
  // serves.
  const refusal = run(root, ['preview', '--dist', 'out']);
  assert.equal(refusal.status, 1, `preview did not refuse the first failed build:\n${streams(refusal)}`);
  assert.doesNotMatch(refusal.stdout, /^preview: http:\/\//m, 'preview served a URL after a first failed build');
  assert.match(
    refusal.stderr,
    /preview directory not found|not a built site/,
    'preview refused for a reason other than the missing marker',
  );

  // And the code, as `tests/preview-server.test.ts` asserts it in process. The
  // directory is normally absent (`preview-directory-not-found`); if anything
  // ever creates it empty, the missing snapshot is `preview-directory-not-an-artifact`.
  assert.throws(
    () => resolveArtifactDirectory('out', root),
    (error: Error & { code?: string }) =>
      error.code === 'preview-directory-not-found' || error.code === 'preview-directory-not-an-artifact',
    'a first failed build produced a directory preview would accept',
  );
}, TEST_TIMEOUT);
