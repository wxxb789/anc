/** Git history is the source of note creation and update dates. */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { discover } from '../scripts/markdown-to-artifact.ts';

function git(cwd: string, args: readonly string[], date?: string): string {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    },
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd: string, message: string, date: string): void {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '--quiet', '-m', message], date);
}

test('full history supplies first and last commit dates in one repository or subdirectory', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'producer-git-dates-'));
  const source = join(workspace, 'source');
  const clone = join(workspace, 'shallow');
  try {
    mkdirSync(join(source, 'notes'), { recursive: true });
    git(source, ['init', '--quiet']);
    git(source, ['config', 'user.name', 'Fixture']);
    git(source, ['config', 'user.email', 'fixture@example.invalid']);

    writeFileSync(join(source, 'notes', 'a.md'), '# A\n\nFirst.\n', 'utf8');
    writeFileSync(join(source, 'notes', '日-b.md'), '# B\n', 'utf8');
    writeFileSync(join(source, 'private.md'), '---\npublish: false\n---\n\n# Private\n', 'utf8');
    commit(source, 'first', '2024-01-02T03:04:05Z');
    writeFileSync(join(source, 'notes', 'a.md'), '# A\n\nUpdated.\n', 'utf8');
    commit(source, 'second', '2024-03-04T05:06:07Z');
    writeFileSync(join(source, 'untracked.md'), '# Untracked\n', 'utf8');

    const full = await discover(source);
    const tracked = full.entries.find((entry) => entry.slug === 'notes-a');
    const nonAscii = full.entries.find((entry) => entry.slug === 'notes-日-b');
    const untracked = full.entries.find((entry) => entry.slug === 'untracked');
    assert.equal(tracked?.created, '2024-01-02T03:04:05Z');
    assert.equal(tracked?.updated, '2024-03-04T05:06:07Z');
    assert.equal(nonAscii?.created, '2024-01-02T03:04:05Z');
    assert.equal(nonAscii?.updated, '2024-01-02T03:04:05Z');
    assert.equal(untracked?.created, undefined);
    assert.equal(untracked?.updated, undefined);
    assert.ok(!full.entries.some((entry) => entry.slug === 'private'));
    assert.ok(full.dropped.some((row) => row.path === 'private.md' && row.reason === 'excluded-by-frontmatter'));

    const nested = await discover(join(source, 'notes'));
    const nestedTracked = nested.entries.find((entry) => entry.slug === 'a');
    const nestedNonAscii = nested.entries.find((entry) => entry.slug === '日-b');
    assert.equal(nestedTracked?.created, '2024-01-02T03:04:05Z');
    assert.equal(nestedTracked?.updated, '2024-03-04T05:06:07Z');
    assert.equal(nestedNonAscii?.created, '2024-01-02T03:04:05Z');

    git(workspace, ['clone', '--quiet', '--depth=1', pathToFileURL(source).href, clone]);
    const shallow = await discover(clone);
    const shallowEntry = shallow.entries.find((entry) => entry.slug === 'notes-a');
    assert.equal(shallowEntry?.created, undefined, 'a shallow clone asserted a false creation date');
    assert.equal(shallowEntry?.updated, '2024-03-04T05:06:07Z');
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a committer offset is normalised to UTC rather than published', async () => {
  // `%cI` spells the committer's local offset, which says where they were when
  // they committed. The instant survives; the location does not.
  const directory = mkdtempSync(join(tmpdir(), 'producer-git-offset-'));
  try {
    git(directory, ['init', '--quiet']);
    git(directory, ['config', 'user.name', 'Fixture']);
    git(directory, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(join(directory, 'note.md'), '# Note\n', 'utf8');
    commit(directory, 'first', '2024-01-02T11:04:05+08:00');
    const [entry] = (await discover(directory)).entries;
    assert.equal(entry?.created, '2024-01-02T03:04:05Z');
    assert.equal(entry?.updated, '2024-01-02T03:04:05Z');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a directory outside git remains honestly undated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'producer-no-git-dates-'));
  try {
    writeFileSync(join(directory, 'note.md'), '# Note\n', 'utf8');
    const found = await discover(directory);
    assert.equal(found.entries[0]?.created, undefined);
    assert.equal(found.entries[0]?.updated, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
