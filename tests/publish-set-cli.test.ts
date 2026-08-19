import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'vitest';

const CLI = fileURLToPath(new URL('../bin/thoughtscape-publish.mjs', import.meta.url));

function run(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 120_000 });
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
  assert.match(result.stdout, /thoughtscape-publish review \[options\]/);
  assert.match(result.stdout, /--release\s+require a non-loopback origin/);
});
