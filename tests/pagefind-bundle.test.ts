/**
 * The Pagefind bundle must be complete before the build judges it.
 *
 * `scripts/run-pagefind.ts` documents the measured reason. `writeFiles`
 * resolved before its writes were on disk: the manifest was the first member a
 * gate caught (the poll that grew from that covered one member of many), a
 * partial content-addressed member then failed the secret scanner with `could
 * not inflate one output member`, and two builds of one corpus hashed
 * differently because a tree was read mid-write. The indexer child is closed
 * after indexing, so a member still landing can be abandoned forever.
 *
 * The producer now writes the indexer's authored `getFiles()` bundle itself and
 * reports success only after every member is closed. These tests prove the
 * writer covers nested members byte-for-byte, repairs a partial member, and
 * that the real `indexWithPagefind` path leaves a complete, decodable bundle —
 * a guard that only ever saw complete bundles would measure nothing.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { test } from 'vitest';
import { indexWithPagefind, writePagefindBundle } from '../scripts/run-pagefind.ts';
import { isGzip } from '../scripts/snapshot-rows.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'pagefind-bundle-'));
}

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found.sort();
}

test('the authored bundle reaches every member, nested paths included', () => {
  const root = scratch();
  try {
    const files = [
      { path: 'pagefind-entry.json', content: Buffer.from('{"version":"probe"}') },
      { path: 'index/en_probe.pf_index', content: Buffer.from([0x1f, 0x8b, 0x08, 0x00]) },
      { path: 'fragment/en_probe.pf_fragment', content: Buffer.from('fragment bytes') },
    ];
    writePagefindBundle(join(root, 'pagefind'), files);

    const written = filesUnder(join(root, 'pagefind'));
    assert.deepEqual(
      written.map((path) => path.slice(join(root, 'pagefind').length + 1).split(sep).join('/')),
      files.map((file) => file.path).sort(),
      'the bundle does not hold exactly the authored members',
    );
    for (const file of files) {
      assert.deepEqual(
        readFileSync(join(root, 'pagefind', file.path)),
        Buffer.from(file.content),
        `${file.path} was not written byte-for-byte`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a partial member is replaced by the authored bytes', () => {
  const root = scratch();
  try {
    const member = join(root, 'pagefind', 'wasm.en.pagefind');
    mkdirSync(join(root, 'pagefind'), { recursive: true });
    // The class the old writer could leave behind: a member that starts like a
    // gzip stream and is not one.
    writeFileSync(member, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));

    const content = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);
    writePagefindBundle(join(root, 'pagefind'), [{ path: 'wasm.en.pagefind', content }]);

    assert.deepEqual(readFileSync(member), content, 'the partial member survived the write');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexWithPagefind leaves a complete, decodable bundle', async () => {
  const root = scratch();
  try {
    writeFileSync(
      join(root, 'index.html'),
      '<html><head><title>Bundle page</title></head><body><h1>Bundle page</h1><p>Indexed body text.</p></body></html>',
      'utf8',
    );

    const pages = await indexWithPagefind(root);
    assert.equal(pages, 1, 'the indexer did not count the one page');

    const bundle = join(root, 'pagefind');
    const members = filesUnder(bundle);
    assert.ok(members.length >= 4, `the bundle holds only ${members.length} members, which is not a Pagefind bundle`);

    const manifest = JSON.parse(readFileSync(join(bundle, 'pagefind-entry.json'), 'utf8')) as {
      languages?: Record<string, unknown>;
    };
    assert.ok(
      Object.keys(manifest.languages ?? {}).length > 0,
      'the manifest does not describe any indexed language',
    );

    const gzipMembers = members.flatMap((path) => {
      const bytes = readFileSync(path);
      return isGzip(bytes) ? [bytes] : [];
    });
    assert.ok(gzipMembers.length > 0, 'no gzip member was written, so the decode check would be vacuous');
    for (const bytes of gzipMembers) {
      gunzipSync(bytes);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
