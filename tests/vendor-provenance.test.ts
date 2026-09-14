/** Build-minted provenance for dependency-only client chunks. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  clientRuntimePackageRoots,
  isVendoredChunk,
  readVendorProvenance,
  vendoredClientChunks,
  vendorProvenancePath,
  vendorProvenancePlugin,
  writeVendorProvenance,
} from '../scripts/vendor-provenance.ts';
import { scanResidue } from '../scripts/scan-residue.ts';

function scratch<T>(body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'vendor-provenance-'));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('only nonempty chunks inside exact resolved runtime roots are vendored', () => {
  const roots = [
    'q:/repo/publish/node_modules/mermaid',
    'q:/repo/publish/node_modules/d3',
    'q:/repo/publish/node_modules/temml',
  ];
  assert.equal(isVendoredChunk(['Q:/repo/publish/node_modules/mermaid/dist/mermaid.mjs'], roots), true);
  assert.equal(isVendoredChunk(['Q:/repo/publish/node_modules/d3/src/index.js'], roots), true);
  assert.equal(
    isVendoredChunk([
      'Q:/repo/publish/node_modules/mermaid/dist/mermaid.mjs',
      '\0rolldown/runtime.js',
    ], roots),
    true,
  );
  assert.equal(isVendoredChunk(['Q:/repo/publish/node_modules/temml/dist/temml.mjs'], roots), true);
  assert.equal(isVendoredChunk([], roots), false);
  assert.equal(isVendoredChunk(['Q:/repo/publish/src/scripts/diagram.ts'], roots), false);
  assert.equal(
    isVendoredChunk([
      'Q:/repo/publish/node_modules/mermaid/dist/mermaid.mjs',
      'Q:/repo/publish/src/scripts/diagram.ts',
    ], roots),
    false,
  );
  assert.equal(isVendoredChunk(['\0vite/preload-helper.js'], roots), false);
  assert.equal(isVendoredChunk(['D:/external/node_modules/mermaid/index.js'], roots), false);
  assert.equal(isVendoredChunk(['C:/site/node_modules/@scope/publish/src/lib/site.js'], roots), false);
  assert.equal(isVendoredChunk(['Q:\\repo\\publish\\node_modules\\mermaid\\dist\\mermaid.mjs'], roots), true);
  assert.equal(isVendoredChunk(['Q:/repo/publish/node_modules/mermaid/../first-party.js'], roots), false);
  assert.equal(isVendoredChunk(['Q:/repo/publish/node_modules/mermaid-copy/index.js'], roots), false);
});

test.skipIf(process.platform === 'win32')('POSIX path case cannot grant an unrelated package', (context) => {
  scratch((directory) => {
    const trusted = join(directory, 'runtime');
    const unrelated = join(directory, 'Runtime');
    mkdirSync(trusted);
    if (existsSync(unrelated)) return context.skip('requires a case-sensitive filesystem');
    mkdirSync(unrelated);
    writeFileSync(join(trusted, 'index.js'), 'vendor');
    writeFileSync(join(unrelated, 'index.js'), 'first-party');
    assert.equal(isVendoredChunk([join(trusted, 'index.js')], [trusted]), true);
    assert.equal(isVendoredChunk([join(unrelated, 'index.js')], [trusted]), false);
  });
});

test('the installed runtime closure resolves the package instances the bundle loads', () => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const roots = clientRuntimePackageRoots(packageRoot);
  const mermaid = fileURLToPath(new URL('../node_modules/mermaid/dist/mermaid.core.mjs', import.meta.url));
  const temml = fileURLToPath(new URL('../node_modules/temml/dist/temml.mjs', import.meta.url));
  assert.ok(roots.length > 2, 'the transitive runtime closure was not resolved');
  assert.equal(isVendoredChunk([mermaid], roots), true);
  assert.equal(isVendoredChunk([temml], roots), true);
});

test('client provenance carries exact final names, sorted and unique', () => {
  const chunks = vendoredClientChunks([
    { fileName: '_astro/z.Hash.js', moduleIds: ['Q:/repo/node_modules/mermaid/index.js'] },
    { fileName: '_astro/a.Hash.js', moduleIds: ['Q:/repo/node_modules/d3/index.js'] },
    { fileName: '_astro/z.Hash.js', moduleIds: ['Q:/repo/node_modules/mermaid/index.js'] },
    { fileName: 'server.mjs', moduleIds: ['Q:/repo/node_modules/mermaid/server.js'] },
    { fileName: '_astro/first.Hash.js', moduleIds: ['Q:/repo/src/first.ts'] },
  ], ['q:/repo/node_modules/mermaid', 'q:/repo/node_modules/d3']);
  assert.deepEqual(chunks, ['_astro/a.Hash.js', '_astro/z.Hash.js']);
});

test('server hooks cannot erase client grants and sibling outputs stay isolated', () => {
  scratch((directory) => {
    const packageRoot = fileURLToPath(new URL('../', import.meta.url));
    const mermaid = fileURLToPath(new URL('../node_modules/mermaid/dist/mermaid.core.mjs', import.meta.url));
    const firstParty = fileURLToPath(new URL('../src/scripts/diagram.ts', import.meta.url));
    const unrelated = fileURLToPath(new URL('../node_modules/sanitize-html/index.js', import.meta.url));
    const distA = join(directory, 'dist-a');
    const distB = join(directory, 'dist-b');
    for (const dist of [distA, distB]) mkdirSync(join(dist, '_astro'), { recursive: true });
    for (const name of ['vendor.Hash.js', 'second.Hash.js']) {
      writeFileSync(join(distA, '_astro', name), 'vendor-a', 'utf8');
    }
    writeFileSync(join(distB, '_astro', 'vendor.Hash.js'), 'vendor-b', 'utf8');
    const plugin = vendorProvenancePlugin(packageRoot);

    plugin.writeBundle({ dir: distA }, {
      server: { type: 'chunk', fileName: 'server.mjs', moduleIds: [mermaid] },
    });
    assert.equal(existsSync(vendorProvenancePath(distA)), false, 'a server bundle wrote an empty client manifest');

    plugin.writeBundle({ dir: distA }, {
      vendor: { type: 'chunk', fileName: '_astro/vendor.Hash.js', moduleIds: [mermaid] },
      first: { type: 'chunk', fileName: '_astro/first.Hash.js', moduleIds: [firstParty] },
      mixed: { type: 'chunk', fileName: '_astro/mixed.Hash.js', moduleIds: [mermaid, firstParty] },
      unrelated: { type: 'chunk', fileName: '_astro/unrelated.Hash.js', moduleIds: [unrelated] },
      css: { type: 'asset', fileName: '_astro/site.css' },
    });
    assert.deepEqual([...readVendorProvenance(distA)], ['_astro/vendor.Hash.js']);

    plugin.writeBundle({ dir: distA }, {
      second: { type: 'chunk', fileName: '_astro/second.Hash.js', moduleIds: [mermaid] },
    });
    assert.deepEqual([...readVendorProvenance(distA)], ['_astro/second.Hash.js', '_astro/vendor.Hash.js']);

    plugin.writeBundle({ dir: distB }, {
      vendor: { type: 'chunk', fileName: '_astro/vendor.Hash.js', moduleIds: [mermaid] },
    });
    assert.notEqual(vendorProvenancePath(distA), vendorProvenancePath(distB));
    assert.deepEqual([...readVendorProvenance(distB)], ['_astro/vendor.Hash.js']);
    assert.deepEqual([...readVendorProvenance(distA)], ['_astro/second.Hash.js', '_astro/vendor.Hash.js']);

    plugin.writeBundle({ dir: distA }, {
      server: { type: 'chunk', fileName: 'server.mjs', moduleIds: [firstParty] },
    });
    assert.deepEqual([...readVendorProvenance(distA)], ['_astro/second.Hash.js', '_astro/vendor.Hash.js']);
  });
});

test('the sidecar is outside dist and round-trips exact existing files', () => {
  scratch((directory) => {
    const dist = join(directory, 'dist');
    mkdirSync(join(dist, '_astro'), { recursive: true });
    writeFileSync(join(dist, '_astro', 'a.Hash.js'), 'vendor', 'utf8');
    writeVendorProvenance(dist, ['_astro/a.Hash.js', '_astro/a.Hash.js']);

    const path = vendorProvenancePath(dist);
    assert.equal(path, join(directory, 'dist.publish-state', 'vendored-chunks.json'));
    assert.deepEqual([...readVendorProvenance(dist)], ['_astro/a.Hash.js']);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      chunks: { file: string; sha256: string }[];
    };
    assert.equal(manifest.version, 2);
    assert.equal(manifest.chunks.length, 1);
    assert.equal(manifest.chunks[0]?.file, '_astro/a.Hash.js');
    assert.match(manifest.chunks[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
  });
});

test('the scanner skips only exact listed chunks and still reads first-party lookalikes', () => {
  scratch((directory) => {
    const dist = join(directory, 'dist');
    mkdirSync(join(dist, '_astro'), { recursive: true });
    mkdirSync(join(dist, 'notes'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><p>home</p>', 'utf8');
    const coincidence = 'const points=[[1,2],[3,4]];';
    writeFileSync(join(dist, '_astro', 'vendor.Hash.js'), coincidence, 'utf8');
    writeFileSync(join(dist, '_astro', 'first.Hash.js'), coincidence, 'utf8');
    writeFileSync(join(dist, 'notes', 'vendor.Hash.js'), coincidence, 'utf8');
    writeVendorProvenance(dist, ['_astro/vendor.Hash.js']);

    const { findings, scannedCount } = scanResidue(dist);
    assert.equal(scannedCount, 3, 'the exact vendor grant skipped too much or too little');
    assert.equal(findings.length, 2, `expected both unlisted chunks to fire: ${findings.join('; ')}`);
    assert.ok(findings.some((finding) => finding.includes('_astro') && finding.includes('first.Hash.js')));
    assert.ok(findings.some((finding) => finding.includes('notes') && finding.includes('vendor.Hash.js')));
    assert.ok(!findings.some((finding) => finding.includes('vendor.Hash.js') && finding.includes('_astro')));
  });
});

test('the real client build proves vendor and first-party chunks took opposite paths', () => {
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  const provenance = readVendorProvenance(root, { required: true });
  assert.ok(provenance.size > 0, 'the client build granted no exact vendor chunks');
  assert.equal(existsSync(vendorProvenancePath(root)), true, 'the client build wrote no private sidecar');
  assert.equal(existsSync(join(root, 'vendored-chunks.json')), false, 'the private sidecar entered the public artifact');

  // Positive control for the exemption: at least one exact listed dependency
  // chunk carries the bracket coincidence that made client Mermaid fail before.
  const coincident = [...provenance].find((file) => readFileSync(join(root, ...file.split('/')), 'utf8').includes('[['));
  assert.ok(coincident !== undefined, 'no listed chunk carries the coincidence the exemption exists for');

  // Negative control: the first-party client runtime contains the escaped raster
  // regex that caused the other blocker. It must remain unlisted and pass only
  // because the scanner understands that exact safe source spelling.
  const scripts = readdirSync(join(root, '_astro')).filter((name) => name.endsWith('.js'));
  const firstPartyRaster = scripts
    .map((name) => ({ name, text: readFileSync(join(root, '_astro', name), 'utf8') }))
    .find(({ text }) => text.includes('data:image\\/'));
  assert.ok(firstPartyRaster !== undefined, 'no first-party raster guard reached the built JavaScript');
  assert.ok(!provenance.has('_astro/' + firstPartyRaster.name), 'the first-party raster runtime was marked vendored');
  assert.deepEqual(
    scanResidue(root, { requireVendorProvenance: true }).findings,
    [],
    'the client build is not clean through the production provenance requirement',
  );
});

test('missing provenance grants nothing; malformed and stale grants fail', () => {
  scratch((directory) => {
    const dist = join(directory, 'dist');
    mkdirSync(dist, { recursive: true });
    assert.deepEqual([...readVendorProvenance(dist)], []);
    assert.throws(() => readVendorProvenance(dist, { required: true }), /provenance is invalid/);

    const path = vendorProvenancePath(dist);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, chunks: [] }), 'utf8');
    assert.throws(() => readVendorProvenance(dist, { required: true }), /provenance is invalid/);

    writeFileSync(path, '{', 'utf8');
    assert.throws(() => readVendorProvenance(dist), /provenance is invalid/);

    mkdirSync(join(dist, '_astro'), { recursive: true });
    const stale = join(dist, '_astro', 'stale.Hash.js');
    writeFileSync(stale, 'first build', 'utf8');
    writeVendorProvenance(dist, ['_astro/stale.Hash.js']);
    writeFileSync(stale, 'different build', 'utf8');
    assert.throws(() => readVendorProvenance(dist), /provenance is invalid/);

    const digest = '0'.repeat(64);
    for (const file of ['notes/private.js', '../escape.js', '_astro\\lookalike.js']) {
      writeFileSync(path, JSON.stringify({ version: 2, chunks: [{ file, sha256: digest }] }), 'utf8');
      assert.throws(() => readVendorProvenance(dist), /provenance is invalid/);
    }
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        chunks: [
          { file: '_astro/z.Hash.js', sha256: digest },
          { file: '_astro/a.Hash.js', sha256: digest },
        ],
      }),
      'utf8',
    );
    assert.throws(() => readVendorProvenance(dist), /provenance is invalid/);
  });
});
