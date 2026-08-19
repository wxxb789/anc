/**
 * G7: removing one source note removes every public projection on the next build.
 *
 * Both halves are load-bearing. The first build proves the deleted note and its
 * search token really reached every surface; the second proves they leave while
 * an unrelated retained note remains. Without the retained controls, a broken
 * empty build and a broken empty search index would look green.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test } from 'vitest';

const CLI = fileURLToPath(new URL('../bin/thoughtscape-publish.mjs', import.meta.url));

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

function build(root: string): void {
  const result = spawnSync(process.execPath, [CLI, 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.equal(result.status, 0, 'foreign build failed:\n' + result.stdout + '\n' + result.stderr);
}

function searchText(dist: string): string {
  const fragments = filesUnder(join(dist, 'pagefind')).filter((file) => file.endsWith('.pf_fragment'));
  assert.ok(fragments.length > 0, 'Pagefind wrote no fragment, so search deletion would be vacuous');
  return fragments.map((file) => gunzipSync(readFileSync(file)).toString('utf8')).join('\n');
}

function assertSurface(text: string, token: string, present: boolean, surface: string): void {
  assert.equal(text.includes(token), present, surface + (present ? ' lost ' : ' retained ') + token);
}

function projectionPattern(surface: 'content index' | 'feed' | 'sitemap', slug: string): RegExp {
  if (surface === 'content index') return new RegExp('"slug"\\s*:\\s*"' + slug + '"');
  if (surface === 'feed') {
    return new RegExp('<link rel="alternate" type="text/html" href="[^"]*/notes/' + slug + '/"/>');
  }
  return new RegExp('<loc>[^<]*/notes/' + slug + '/</loc>');
}

function assertProjection(
  text: string,
  slug: string,
  present: boolean,
  surface: 'content index' | 'feed' | 'sitemap',
): void {
  assert.equal(
    projectionPattern(surface, slug).test(text),
    present,
    surface + (present ? ' lost entry for ' : ' retained entry for ') + slug,
  );
}

test('deleting a note removes its route, feed, sitemap, content index, and search record', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-deletion-'));
  const dist = join(root, 'dist');
  const deleted = join(root, 'deleted-nebula.md');
  const deletedToken = 'zzqdeletednebula';
  const retainedToken = 'zzqretainedasterism';
  try {
    const git = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    writeFileSync(deleted, '# Deleted Nebula\n\n' + deletedToken + '\n', 'utf8');
    writeFileSync(join(root, 'retained-asterism.md'), '# Retained Asterism\n\n' + retainedToken + '\n', 'utf8');

    build(root);
    assert.equal(existsSync(join(dist, 'notes', 'deleted-nebula', 'index.html')), true, 'first build never emitted the deleted route');
    assert.equal(existsSync(join(dist, 'notes', 'retained-asterism', 'index.html')), true, 'first build never emitted the retained control route');
    for (const [surface, file] of [
      ['content index', 'content-index.json'],
      ['feed', 'rss.xml'],
      ['sitemap', 'sitemap.xml'],
    ] as const) {
      const text = readFileSync(join(dist, file), 'utf8');
      assertProjection(text, 'deleted-nebula', true, surface);
      assertProjection(text, 'retained-asterism', true, surface);
    }
    const firstSearch = searchText(dist);
    assertSurface(firstSearch, deletedToken, true, 'first search index');
    assertSurface(firstSearch, retainedToken, true, 'first search index');

    // Mutation watched fail: replacing this removal with a no-op leaves the
    // route present and fails below with "deleted route survived the rebuild".
    rmSync(deleted);
    build(root);
    assert.equal(existsSync(join(dist, 'notes', 'deleted-nebula', 'index.html')), false, 'deleted route survived the rebuild');
    assert.equal(existsSync(join(dist, 'notes', 'retained-asterism', 'index.html')), true, 'retained control route vanished');
    for (const [surface, file] of [
      ['content index', 'content-index.json'],
      ['feed', 'rss.xml'],
      ['sitemap', 'sitemap.xml'],
    ] as const) {
      const text = readFileSync(join(dist, file), 'utf8');
      assertProjection(text, 'deleted-nebula', false, surface);
      assertProjection(text, 'retained-asterism', true, surface);
    }
    const secondSearch = searchText(dist);
    assertSurface(secondSearch, deletedToken, false, 'rebuilt search index');
    assertSurface(secondSearch, retainedToken, true, 'rebuilt search index');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 240_000);
