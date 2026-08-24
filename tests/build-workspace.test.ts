/** Packaged build workspaces converge after interruption without harming live runs. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  STALE_BUILD_WORKSPACE_AGE_MS,
  pruneStaleBuildWorkspaces,
  removeBuildWorkspace,
} from '../scripts/build-workspace.ts';

const BINARY_SOURCE = readFileSync(
  fileURLToPath(new URL('../bin/anc.mjs', import.meta.url)),
  'utf8',
);

function workspace(root: string, name: string, modified: number): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'content.json'), '{}\n', 'utf8');
  const date = new Date(modified);
  utimesSync(join(directory, 'content.json'), date, date);
  utimesSync(directory, date, date);
  return directory;
}

test('the binary prunes before creating and reports deferred final cleanup', () => {
  const prune = BINARY_SOURCE.indexOf('await pruneStaleBuildWorkspaces(PACKAGE_ROOT)');
  const create = BINARY_SOURCE.indexOf("mkdtemp(join(PACKAGE_ROOT, '.anc-build-'))");
  assert.ok(prune >= 0 && prune < create, 'the binary does not prune stale siblings before creating one');
  assert.match(BINARY_SOURCE, /await removeBuildWorkspace\(workspace\)/);
  assert.match(BINARY_SOURCE, /staging cleanup deferred: 1 directory/);
});

test('stale workspace pruning removes only old tool-owned directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'build-workspace-prune-'));
  try {
    const now = Date.UTC(2026, 7, 20);
    const stale = '.anc-build-aB3dE6';
    const fresh = '.anc-build-FR3sh1';
    const unfamiliar = '.anc-build-too-long';
    workspace(root, stale, now - STALE_BUILD_WORKSPACE_AGE_MS - 1);
    workspace(root, fresh, now - STALE_BUILD_WORKSPACE_AGE_MS + 1);
    workspace(root, unfamiliar, now - STALE_BUILD_WORKSPACE_AGE_MS - 1);
    writeFileSync(join(root, '.anc-build-zY9xW8'), 'not a directory\n', 'utf8');
    const target = workspace(root, 'link-target', now - STALE_BUILD_WORKSPACE_AGE_MS - 1);
    const link = join(root, '.anc-build-L1nK99');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

    assert.ok(readdirSync(root).length >= 4, 'the pre-state has no workspaces to prune');
    assert.equal(await pruneStaleBuildWorkspaces(root, now), 1);

    const names = readdirSync(root);
    assert.ok(!names.includes(stale));
    assert.ok(names.includes(fresh));
    assert.ok(names.includes(unfamiliar));
    assert.ok(names.includes('.anc-build-zY9xW8'));
    assert.ok(existsSync(link), 'a matching workspace symlink was removed');
    assert.ok(existsSync(join(target, 'content.json')), 'workspace symlink pruning traversed its target');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace cleanup reports failure without throwing or deleting the diagnostic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'build-workspace-remove-'));
  try {
    const directory = workspace(root, '.anc-build-a1B2c3', Date.now());
    const cleaned = await removeBuildWorkspace(directory, async () => {
      throw new Error('simulated lock');
    });
    assert.equal(cleaned, false);
    assert.ok(readdirSync(directory).includes('content.json'));

    assert.equal(await removeBuildWorkspace(directory), true);
    assert.ok(!readdirSync(root).includes('.anc-build-a1B2c3'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
