/** Producer metadata must reach the routes and links readers receive. */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { routeKey, tagRoute } from '../src/lib/routes.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'thoughtscape-publish.mjs');

test('frontmatter tags and the first folder reach their public routes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'producer-metadata-'));
  try {
    const notes = join(directory, 'notes', 'Projects', 'deep');
    mkdirSync(notes, { recursive: true });
    writeFileSync(
      join(notes, 'note.md'),
      '---\ntags:\n  - Security\n  - field notes\n---\n\n# Tagged note\n\nBody.\n',
      'utf8',
    );
    const git = spawnSync('git', ['init', '--quiet'], { cwd: directory, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);

    const build = spawnSync(
      process.execPath,
      [BINARY, 'build', '--content', 'notes', '--out', 'dist'],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);

    const noteRoute = '/notes/projects-deep-note/';
    const note = readFileSync(join(directory, 'dist', 'notes', 'projects-deep-note', 'index.html'), 'utf8');
    for (const label of ['Security', 'field notes']) {
      const route = tagRoute(routeKey(label));
      const page = readFileSync(
        join(directory, 'dist', ...route.split('/').filter(Boolean), 'index.html'),
        'utf8',
      );
      assert.ok(note.includes(`href="${route}"`));
      assert.ok(page.includes(`href="${noteRoute}"`));
    }
    const collection = readFileSync(join(directory, 'dist', 'collections', 'projects', 'index.html'), 'utf8');
    assert.match(note, /href="\/collections\/projects\/"/);
    assert.ok(collection.includes(`href="${noteRoute}"`));
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 120_000);

test('unroutable and colliding tags fail by public literal and private labels', () => {
  for (const [yaml, labels] of [
    ['  - ---', ['---']],
    ['  - C++\n  - C#', ['C++', 'C#']],
  ] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'producer-tag-route-'));
    try {
      writeFileSync(join(directory, 'note.md'), `---\ntags:\n${yaml}\n---\n\n# Note\n`, 'utf8');
      const git = spawnSync('git', ['init', '--quiet'], { cwd: directory, encoding: 'utf8' });
      assert.equal(git.status, 0, git.stderr);

      const build = spawnSync(process.execPath, [BINARY, 'build'], { cwd: directory, encoding: 'utf8' });
      const output = `${build.stdout}${build.stderr}`;
      assert.equal(build.status, 1, output);
      assert.ok(output.includes('generated content cannot pass schema and route validation'));

      const report = JSON.parse(
        readFileSync(join(directory, '.git', 'publish-report', 'content-report.json'), 'utf8'),
      ) as { failure?: { code?: string; detail?: string } };
      assert.equal(report.failure?.code, 'invalid-generated-content');
      for (const label of labels) {
        assert.ok(report.failure?.detail?.includes(label));
        assert.ok(!output.includes(label));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}, 120_000);
