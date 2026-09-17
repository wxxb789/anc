import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { snapshotPath } from './support/snapshot.ts';
import { GITLEAKS_VERSION } from '../scripts/scan-secrets.ts';

const CLI = fileURLToPath(new URL('../bin/anc.mjs', import.meta.url));

/**
 * Run the CLI in a scratch repository.
 *
 * `environment` defaults to this process's own environment. The scanner control
 * passes one whose PATH omits the pinned Gitleaks install, which is the only
 * way `secret-scanner-unavailable` is reachable through the real binary.
 */
function run(
  root: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: environment,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('release mode requires a committed exact review and preserves the last good output', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-set-cli-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.name', 'Release Test']);
    git(root, ['config', 'user.email', 'release@example.invalid']);
    writeFileSync(join(root, 'public-note.md'), '# Public Note\n\nVisible body.\n', 'utf8');
    writeFileSync(join(root, 'withheld-note.md'), '---\npublish: false\n---\n\n# Withheld Note\n', 'utf8');
    writeFileSync(join(root, 'publish.config.yaml'), 'origin: https://notes.example.org/\n', 'utf8');

    const missing = run(root, ['build', '--release']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no reviewed publish set/);

    const review = run(root, ['review']);
    assert.equal(review.status, 0, review.stderr);
    assert.equal(review.stdout, 'publish set review written: 1 notes\ninspect and commit .publish-set.json before a release build\n');
    assert.ok(!review.stdout.includes('public-note'));
    assert.ok(!review.stdout.includes('withheld-note'));
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.publish-set.json'), 'utf8')), {
      version: 1,
      slugs: ['public-note'],
    });

    const uncommitted = run(root, ['build', '--release']);
    assert.equal(uncommitted.status, 1);
    assert.match(uncommitted.stderr, /must be committed and unchanged/);

    git(root, ['add', '--', '.publish-set.json']);
    git(root, ['commit', '--quiet', '-m', 'review publish set']);
    const released = run(root, ['build', '--release']);
    assert.equal(released.status, 0, released.stdout + released.stderr);
    assert.equal(existsSync(join(root, 'dist', 'notes', 'public-note', 'index.html')), true);

    writeFileSync(join(root, 'unreviewed-addition.md'), '# Unreviewed Addition\n', 'utf8');
    const changed = run(root, ['build', '--release']);
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /1 added, 0 removed/);
    assert.ok(!(changed.stdout + changed.stderr).includes('unreviewed-addition'));
    assert.equal(existsSync(join(root, 'dist', 'notes', 'public-note', 'index.html')), true, 'failed release replaced the last good output');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 240_000);

test('withdrawing a note and re-including it without a new review both fail release', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-set-cli-removal-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.name', 'Release Test']);
    git(root, ['config', 'user.email', 'release@example.invalid']);
    writeFileSync(join(root, 'alpha.md'), '# Alpha Note\n\nAlpha body.\n', 'utf8');
    writeFileSync(join(root, 'beta.md'), '# Beta Note\n\nBeta body.\n', 'utf8');
    writeFileSync(join(root, 'publish.config.yaml'), 'origin: https://notes.example.org/\n', 'utf8');

    assert.equal(run(root, ['review']).status, 0);
    git(root, ['add', '--', '.publish-set.json']);
    git(root, ['commit', '--quiet', '-m', 'review publish set']);
    const both = run(root, ['build', '--release']);
    assert.equal(both.status, 0, both.stdout + both.stderr);
    assert.equal(existsSync(join(root, 'dist', 'notes', 'alpha', 'index.html')), true);
    assert.equal(existsSync(join(root, 'dist', 'notes', 'beta', 'index.html')), true);

    // The withdrawal is recorded by reviewing the shrunken set: the ledger, not
    // the absence of a file, is what says beta left.
    rmSync(join(root, 'beta.md'));
    const reviewed = run(root, ['review']);
    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.publish-set.json'), 'utf8')), {
      version: 1,
      slugs: ['alpha'],
    });
    git(root, ['add', '--', '.publish-set.json']);
    git(root, ['commit', '--quiet', '-m', 'review shrunk publish set']);

    const removed = run(root, ['build', '--release']);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(existsSync(join(root, 'dist', 'notes', 'alpha', 'index.html')), true);
    assert.equal(
      existsSync(join(root, 'dist', 'notes', 'beta', 'index.html')),
      false,
      'withdrawn note route survived the rebuild',
    );
    // Exactly one snapshot, whose content-addressed name is the last good output.
    const lastGood = snapshotPath(join(root, 'dist'));

    // Restoring beta is an addition against the shrunken ledger, not stale approval.
    writeFileSync(join(root, 'beta.md'), '# Beta Note\n\nBeta body.\n', 'utf8');
    const reincluded = run(root, ['build', '--release']);
    assert.equal(reincluded.status, 1);
    assert.match(reincluded.stderr, /1 added, 0 removed/);
    assert.ok(!(reincluded.stdout + reincluded.stderr).includes('beta'));
    assert.equal(
      existsSync(join(root, 'dist', 'notes', 'alpha', 'index.html')),
      true,
      'failed release replaced the last good output',
    );
    assert.equal(snapshotPath(join(root, 'dist')), lastGood, 'failed release replaced the last good snapshot');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 300_000);

test('release refuses a missing pinned scanner without naming a path or a secret', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-set-cli-scanner-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.name', 'Release Test']);
    git(root, ['config', 'user.email', 'release@example.invalid']);
    writeFileSync(join(root, 'alpha.md'), '# Alpha Note\n\nAlpha body.\n', 'utf8');
    writeFileSync(join(root, 'publish.config.yaml'), 'origin: https://notes.example.org/\n', 'utf8');
    assert.equal(run(root, ['review']).status, 0);
    git(root, ['add', '--', '.publish-set.json']);
    git(root, ['commit', '--quiet', '-m', 'review publish set']);

    // Observed 2026-09-17 with the pinned scanner absent from PATH: exit 1 and
    // stderr exactly "secret scan requires Gitleaks 8.30.1". The version comes
    // from the one pinned constant rather than a third literal, so a version
    // bump cannot red this test as a message change. This process's node is
    // invoked by absolute path, so /usr/bin:/bin keeps node and git reachable
    // while leaving the scanner's own directory off PATH.
    const missing = run(root, ['build', '--release'], { ...process.env, PATH: '/usr/bin:/bin' });
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr, `secret scan requires Gitleaks ${GITLEAKS_VERSION}\n`);
    const streams = missing.stdout + missing.stderr;
    assert.ok(!streams.includes(root), 'stream named the host directory');
    assert.ok(!streams.includes('alpha'), 'stream named the note');
    assert.ok(!streams.includes('ghp_'), 'stream carried a credential');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 240_000);

test('release reports only counts for a planted credential, never its value, name, digest, or host path', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-set-cli-secret-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.name', 'Release Test']);
    git(root, ['config', 'user.email', 'release@example.invalid']);
    // Synthetic and shaped for the rule it must trip; never a real credential,
    // and never committed here — only the ledger is staged.
    const planted = 'ghp_4fJ9xQ2mN7vL5sT8yR1cW6kP3dH0bA9eZ7uC';
    writeFileSync(
      join(root, 'planted-credential.md'),
      `# Planted Credential\n\nHere is the token: ${planted}\n`,
      'utf8',
    );
    writeFileSync(join(root, 'publish.config.yaml'), 'origin: https://notes.example.org/\n', 'utf8');

    // The same corpus passes an ordinary build, so the refusal below is the
    // release-only scanner and not an earlier gate. The snapshot is
    // content-addressed, so this name is also the one a release build computes.
    const ordinary = run(root, ['build']);
    assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
    const snapshotName = basename(snapshotPath(join(root, 'dist')));

    assert.equal(run(root, ['review']).status, 0);
    git(root, ['add', '--', '.publish-set.json']);
    git(root, ['commit', '--quiet', '-m', 'review publish set']);

    // Observed 2026-09-17 with Gitleaks 8.30.1: exit 1 and stderr exactly
    // "secret scan found 10 findings". The ten findings cover the note's
    // rendered page (three matches), the home and recent indexes, the feed, the
    // Pagefind fragment (a github-pat and a generic-api-key match) and index
    // projections, and the site snapshot's reconstructed rows. The count is
    // pinned so a change in scanner coverage is visible instead of absorbed.
    const scanned = run(root, ['build', '--release']);
    assert.equal(scanned.status, 1);
    assert.equal(scanned.stderr, 'secret scan found 10 findings\n');
    const streams = scanned.stdout + scanned.stderr;
    assert.ok(!streams.includes(planted), 'stream carried the planted value');
    assert.ok(!streams.includes('ghp_'), 'stream carried a credential-shaped value');
    assert.ok(!streams.includes('planted-credential'), 'stream named the note');
    assert.ok(!streams.includes(snapshotName), 'stream named the snapshot digest');
    assert.ok(!streams.includes(root), 'stream named the host directory');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 240_000);

test('release mode refuses a loopback-only build with no configured origin', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-set-origin-'));
  try {
    git(root, ['init', '--quiet']);
    writeFileSync(join(root, 'note.md'), '# Note\n', 'utf8');
    const missing = run(root, ['build', '--release']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /must declare a non-loopback public origin/);

    writeFileSync(join(root, 'publish.config.yaml'), 'origin: http://preview.localhost/\n', 'utf8');
    const loopback = run(root, ['build', '--release']);
    assert.equal(loopback.status, 1);
    assert.match(loopback.stderr, /must declare a non-loopback public origin/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('review output is identical when the public slug changes', () => {
  const reviewOutput = (name: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'publish-set-disclosure-'));
    try {
      git(root, ['init', '--quiet']);
      writeFileSync(join(root, name + '.md'), '# Public Note\n', 'utf8');
      const result = run(root, ['review']);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };

  assert.equal(reviewOutput('alpha'), reviewOutput('clients-acme-renewal'));
});

test('review refuses build-only flags by their safe literal without echoing values', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-set-options-'));
  try {
    const out = run(root, ['review', '--out', 'clients-acme-renewal']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /review does not accept --out/);
    assert.ok(!out.stderr.includes('clients-acme-renewal'));

    const release = run(root, ['review', '--release']);
    assert.equal(release.status, 1);
    assert.match(release.stderr, /review does not accept --release/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('help exposes review and release without changing ordinary build options', () => {
  const result = run(process.cwd(), ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\banc review \[options\]/);
  assert.match(result.stdout, /--release\s+require a non-loopback origin/);
});
