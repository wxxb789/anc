/**
 * Goal 0012's security boundary, tested on both layers separately.
 *
 * The policy refuses every external reference, so a build-level test alone cannot
 * tell whether the *renderer* would have resolved one had the policy let it
 * through. That distinction is the design's explicit assumption: librsvg is given
 * a byte buffer with no base URI, so even a reference the policy missed has no
 * path to resolve. These gates therefore exercise:
 *
 * 1. a real packaged build with a hostile corpus, proving no host file is read
 *    and no request leaves the process;
 * 2. the rasterizer called **directly**, bypassing the policy, with the same
 *    references, proving the buffer boundary holds on its own;
 * 3. a failed build leaving the previous `dist/` byte-identical.
 *
 * A parser-only assertion is not evidence for any of the three.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterAll, test } from 'vitest';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BINARY = join(ROOT, 'bin', 'anc.mjs');
const BENIGN = join(ROOT, 'tests', 'fixtures', 'svg', 'benign');

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** A scratch repository with a `notes/` corpus. */
function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  mkdirSync(join(root, 'notes'), { recursive: true });
  return root;
}

function put(root: string, relativePath: string, body: string | Uint8Array): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** Run the shipped binary; never throws on a failed build. */
function build(root: string, out: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BINARY, 'build', '--content', 'notes', '--out', out], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240_000,
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Every file under a directory, with its SHA-256. */
function hashTree(directory: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else hashes.set(relative(directory, path), createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(directory);
  return hashes;
}

/** Every file under a directory, as paths relative to it. */
function filesUnder(directory: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(directory, path));
    }
  };
  walk(directory);
  return files;
}

/** A magenta canary PNG at an absolute path outside the corpus. */
async function canaryPixels(path: string): Promise<void> {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index++) {
    raw[index * 3] = 255;
    raw[index * 3 + 1] = 0;
    raw[index * 3 + 2] = 255;
  }
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(path);
}

/** Count magenta pixels in a rendered buffer. */
async function magentaPixels(bytes: Buffer): Promise<number> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    if (data[index]! > 200 && data[index + 1]! < 60 && data[index + 2]! > 200) count += 1;
  }
  return count;
}

test('a host canary outside the content root cannot be read through any SVG reference', async () => {
  const root = scratch('svg-canary-');
  const canary = join(root, 'canary.png');
  await canaryPixels(canary);

  const hostile = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64">`,
    `<image href="file://${canary}" width="64" height="64"/>`,
    `<image xlink:href="file://${canary}" width="64" height="64"/>`,
    `<image href="../../canary.png" width="64" height="64"/>`,
    `<use href="../../canary.png#x" width="64" height="64"/>`,
    `</svg>`,
  ].join('\n');
  put(root, 'notes/assets/leak.svg', hostile);
  put(root, 'notes/page.md', '# Page\n\nA paragraph so the search index has text.\n\n![leak](assets/leak.svg)\n');

  // Layer 1: the policy refuses it, and the failure names the reason without
  // printing the host path or the scheme.
  const failed = build(root, 'out');
  assert.notEqual(failed.status, 0, 'the build accepted an external file reference');
  const stream = failed.stderr + failed.stdout;
  assert.match(stream, /external SVG reference|SVG foreign content|unsupported SVG construct/);
  assert.ok(!stream.includes(canary), 'the public stream printed the canary path');
  assert.ok(!stream.includes('file://'), 'the public stream printed the reference scheme');

  // Layer 2: the renderer, given the same document **without** the policy,
  // resolves nothing. The relative `<image>` is the no-base-URI assumption: if
  // sharp passed the original path, `../../canary.png` would paint magenta.
  // This is the byte-buffer boundary itself, not a policy test.
  const rendered = await sharp(Buffer.from(hostile), { density: 144 }).png().toBuffer();
  assert.equal(await magentaPixels(rendered), 0, 'the rasterizer resolved a relative reference to the canary');
  const stats = await sharp(rendered).stats();
  assert.equal(stats.channels[3]?.mean ?? 0, 0, 'the bypassed render produced visible pixels');
});

test('no request leaves the process, observed at a listening socket', async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end();
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the probe server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const root = scratch('svg-network-');
    const hostile =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64">` +
      `<image href="${origin}/probe.png" width="64" height="64"/>` +
      `<use xlink:href="${origin}/probe.svg#icon" width="16" height="16"/>` +
      `<style>rect { fill: url("${origin}/pattern.svg#tile"); }</style>` +
      `</svg>`;
    put(root, 'notes/assets/network.svg', hostile);
    put(root, 'notes/page.md', '# Page\n\nA paragraph so the search index has text.\n\n![network](assets/network.svg)\n');

    const failed = build(root, 'out');
    assert.notEqual(failed.status, 0, 'the build accepted a network reference');
    assert.ok(!failed.stderr.includes(origin), 'the public stream printed the probe origin');

    // Layer 2: bypass the policy and render the same document. A render that
    // fetched would have done so before this promise settled — librsvg resolves
    // resources during the render, not after it — so no timer is needed to
    // observe an egress attempt.
    await sharp(Buffer.from(hostile), { density: 144 }).png().toBuffer();

    assert.deepEqual(requests, [], `the rasterizer made ${requests.length} request(s): ${requests.join(', ')}`);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

test('a refused SVG leaves the previous output byte-identical and publishes nothing partial', async () => {
  const root = scratch('svg-preserve-');
  put(root, 'notes/assets/diagram.svg', readFileSync(join(BENIGN, 'line-art.svg')));
  put(root, 'notes/page.md', '# Page\n\nA paragraph so the search index has text.\n\n![diagram](assets/diagram.svg)\n');

  const good = build(root, 'out');
  assert.equal(good.status, 0, `${good.stdout}${good.stderr}`);
  const before = hashTree(join(root, 'out'));
  assert.ok(before.size > 10, `the good build produced only ${before.size} files`);
  assert.ok([...before.keys()].some((file) => file.startsWith('_assets/')), 'the good build published no asset');

  // The same note, now naming a hostile document. The build must stop before
  // replacing any of the previous output.
  put(
    root,
    'notes/assets/diagram.svg',
    readFileSync(join(ROOT, 'tests', 'fixtures', 'svg', 'hostile', 'script.svg')),
  );
  const failed = build(root, 'out');
  assert.notEqual(failed.status, 0, 'the build published a hostile SVG');
  const after = hashTree(join(root, 'out'));
  assert.deepEqual([...after.entries()], [...before.entries()], 'a failed build changed the previous output');
});

test('the good build carries no SVG source, no .svg asset, no embedded data: image', () => {
  const root = scratch('svg-inventory-');
  for (const name of ['diagram.svg', 'labels.svg']) {
    const fixture = name === 'diagram.svg' ? 'viewbox-only.svg' : 'latin-text.svg';
    put(root, `notes/assets/${name}`, readFileSync(join(BENIGN, fixture)));
  }
  put(
    root,
    'notes/page.md',
    '# Page\n\nA paragraph of prose so the search index has text.\n\n![a diagram](assets/diagram.svg "A caption")\n\n![labels](assets/labels.svg)\n',
  );
  put(
    root,
    'notes/second.md',
    '# Second\n\nThe same diagram again, with prose beside it:\n\n![again](assets/diagram.svg)\n',
  );

  const built = build(root, 'out');
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
  const out = join(root, 'out');

  const assets = readdirSync(join(out, '_assets')).sort();
  assert.equal(assets.length, 2, `the build published ${assets.length} assets for two SVG sources`);
  for (const asset of assets) {
    assert.match(asset, /\.webp$/, `an emitted asset is not WebP: ${asset}`);
    assert.doesNotMatch(asset, /\.svg$/, `the SVG source reached _assets: ${asset}`);
  }

  for (const file of filesUnder(out)) {
    assert.doesNotMatch(file, /diagram\.svg$|labels\.svg$/, `the source path reached dist: ${file}`);
  }

  const index = filesUnder(out).filter((file) => file.startsWith('pagefind/'));
  assert.ok(index.length > 0, 'the build produced no Pagefind index to inspect');
  for (const file of index) {
    const bytes = readFileSync(join(out, file));
    assert.ok(!bytes.includes('diagram.svg'), `the Pagefind index carries the source name: ${file}`);
    assert.ok(!bytes.includes('labels.svg'), `the Pagefind index carries the source name: ${file}`);
  }

  const databases = filesUnder(out).filter((file) => file.endsWith('.sqlite'));
  assert.ok(databases.length === 1, `expected one public database, found ${databases.length}`);
  for (const file of databases) {
    const bytes = readFileSync(join(out, file));
    assert.ok(!bytes.includes('diagram.svg'), `${file}: the database carries the SVG source name`);
    assert.ok(!bytes.includes('xmlns='), `${file}: the database carries SVG XML`);
  }

  // The page must reference the published WebP, never the source XML, as a data
  // URL. Pagefind's own UI stylesheet ships an inline SVG icon and is not this
  // build's output, so the check is over `_assets/` and rendered pages.
  for (const file of filesUnder(out)) {
    if (!file.endsWith('.html') && !file.startsWith('_assets/')) continue;
    const bytes = readFileSync(join(out, file));
    assert.ok(!bytes.includes('data:image/svg'), `${file}: an SVG data: URL was emitted`);
  }
});
