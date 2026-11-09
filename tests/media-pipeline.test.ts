/**
 * Goal 0009: the producer-owned asset decision, over real bytes.
 *
 * Every gate here runs the shipped producer (`discover` → `resolveCorpusLinks` →
 * `writeArtifact`) over a real scratch corpus with real image files, because the
 * properties at stake are about *bytes*: which file an authored reference names,
 * whether its pixels reach the artifact unchanged, and whether an unauthorized
 * one reaches it at all. A unit test over a fake filesystem would encode this
 * file's belief about the pipeline rather than the pipeline.
 *
 * The negative controls are the point of the file. A media pipeline's failure
 * direction is the one that matters: a missing image that silently disappears, a
 * withheld one that ships, or an unsupported one that renders as a broken element
 * are all worse than a build that stops and says so.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { ContentArtifact } from '../src/lib/schema.ts';
import { imageDimensions, parseAssetUrl, sniffImageFormat, imageExtension } from '../src/lib/media.ts';
import { renderMarkdown } from '../src/lib/markdown.ts';
import { discover, resolveCorpusLinks, writeArtifact } from '../scripts/markdown-to-artifact.ts';
import type { BuildFailure } from '../scripts/write-report.ts';
import {
  AVIF,
  AVIF_PRIMARY_ISPE_NOT_FIRST,
  AVIF_PRIMARY_ISPE_UNASSOCIATED,
  GIF_ANIMATED,
  JPEG,
  NOT_AN_IMAGE,
  ORIENTATION_1_JPEG,
  ORIENTED_AVIF,
  ORIENTED_AVIF_MIRROR,
  ORIENTED_JPEG,
  ORIENTED_PNG,
  ORIENTED_WEBP,
  PNG_SECOND,
  PNG_UNICODE,
  SVG,
  WEBP_ANIMATED,
  WEBP_LOSSLESS,
  WEBP_LOSSY,
  WEBP_LOSSY_WIDE,
} from './support/media.ts';

/** A scratch root with a content directory and an output directory beside it. */
interface Scratch {
  readonly root: string;
  readonly content: string;
  readonly out: string;
}

async function scratch<T>(prefix: string, body: (directories: Scratch) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const content = join(root, 'content');
  const out = join(root, 'out');
  mkdirSync(content, { recursive: true });
  mkdirSync(out, { recursive: true });
  try {
    return await body({ root, content, out });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Write one text file, creating its directories. */
function put(root: string, relativePath: string, body: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

/** Write one binary file, creating its directories. */
function putBytes(root: string, relativePath: string, bytes: Uint8Array): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** The SHA-256 a published URL's digest prefix must equal. */
function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One producer run: the artifact it wrote and the bytes it staged beside it. */
interface Produced {
  readonly artifact: ContentArtifact;
  readonly staged: ReadonlyMap<string, Buffer>;
  readonly markdown: ReadonlyMap<string, string>;
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
}

async function produce(directories: Scratch, exclude: string[] = []): Promise<Produced> {
  const discovery = await discover(directories.content, { exclude });
  await resolveCorpusLinks(discovery);
  const destination = join(directories.out, 'content.json');
  await writeArtifact(discovery, destination, { includeEdges: false });
  const artifact = JSON.parse(readFileSync(destination, 'utf8')) as ContentArtifact;
  const staged = new Map<string, Buffer>();
  const directory = join(directories.out, 'assets');
  if (existsSync(directory)) {
    for (const name of readdirSync(directory)) staged.set(name, readFileSync(join(directory, name)));
  }
  return {
    artifact,
    staged,
    markdown: new Map(discovery.entries.map((entry) => [entry.slug, entry.markdown])),
    outgoing: new Map(discovery.entries.map((entry) => [entry.slug, entry.outgoing])),
  };
}

/** Run the producer and return the refusal it raised, or fail the test. */
async function refusalFrom(directories: Scratch, exclude: string[] = []): Promise<BuildFailure> {
  try {
    await produce(directories, exclude);
  } catch (error) {
    assert.equal((error as BuildFailure).name, 'BuildFailure', `not a disclosure-checked failure: ${String(error)}`);
    return error as BuildFailure;
  }
  assert.fail('the producer accepted an image reference it must refuse');
}

/** Every asset the artifact declares, as `{ fileName, digest }`. */
function assetsOf(artifact: ContentArtifact): {
  fileName: string;
  digest: string;
  width: number | undefined;
  height: number | undefined;
}[] {
  return (artifact.assets ?? []).map((asset) => {
    const parsed = parseAssetUrl(asset.url);
    assert.ok(parsed !== undefined, `the artifact declares a non-canonical asset URL: ${asset.url}`);
    return { fileName: parsed.fileName, digest: parsed.digest, width: asset.width, height: asset.height };
  });
}

test('resolution is note-relative first, then content-root, and an explicit path does not fall through', async () => {
  await scratch('media-precedence-', async (directories) => {
    // Two files named `pic.png`: one beside the note, one at the root, with
    // different bytes so which one published is a fact about the bytes. Plus a
    // file only the content root holds, which is what tier 2 exists for.
    putBytes(directories.content, 'notes/pic.png', PNG_UNICODE);
    putBytes(directories.content, 'pic.png', PNG_SECOND);
    putBytes(directories.content, 'root-only.png', PNG_SECOND);
    put(directories.content, 'notes/a.md', [
      '# A',
      '',
      'Bare ![near](pic.png) here.',
      'Explicit ![explicit](./pic.png) here.',
      'Rooted ![root](root-only.png) here.',
      'Anchored ![anchored](/root-only.png) here.',
      '',
    ].join('\n'));
    put(directories.content, 'root.md', '# Root\n\nBare ![from-root](pic.png) here.\n');

    const produced = await produce(directories);
    const artifact = produced.artifact;
    const assets = assetsOf(artifact);
    // Three distinct sources: notes/pic.png, pic.png, and — because the note-root
    // is the same file as the bare root file — one more reference to it. So two
    // assets, and the note-relative reference must be the one with a different
    // digest.
    assert.equal(assets.length, 2, 'the corpus produced an unexpected number of assets');
    assert.ok(assets.some((asset) => asset.digest === digestOf(PNG_UNICODE)), 'the note-relative file did not publish');
    assert.ok(assets.some((asset) => asset.digest === digestOf(PNG_SECOND)), 'the content-root file did not publish');

    const near = produced.markdown.get('notes-a')!;
    assert.match(near, new RegExp(`!\\[near\\]\\(/_assets/${digestOf(PNG_UNICODE)}-[^)]+\\)`), near);
    assert.match(near, new RegExp(`!\\[explicit\\]\\(/_assets/${digestOf(PNG_UNICODE)}-[^)]+\\)`), near);
    assert.match(near, new RegExp(`!\\[root\\]\\(/_assets/${digestOf(PNG_SECOND)}-[^)]+\\)`), near);
    assert.match(near, new RegExp(`!\\[anchored\\]\\(/_assets/${digestOf(PNG_SECOND)}-[^)]+\\)`), near);
    assert.match(produced.markdown.get('root')!, new RegExp(`!\\[from-root\\]\\(/_assets/${digestOf(PNG_SECOND)}-`), 'a root note resolved somewhere else');
  });

  // The explicit-path control, in its own corpus: `./only-at-root.png` misses
  // beside the note and **must fail**, while the bare `only-at-root.png` from the
  // same note resolves at the content root. Falling through would let a reference
  // the author anchored to their own directory silently name another file.
  await scratch('media-explicit-', async (directories) => {
    putBytes(directories.content, 'root-file.png', PNG_SECOND);
    put(directories.content, 'notes/bare.md', '# Bare\n\n![bare](root-file.png)\n');
    put(directories.content, 'notes/explicit.md', '# Explicit\n\n![explicit](./root-file.png)\n');

    const failure = await (async () => {
      try {
        await produce(directories);
        return undefined;
      } catch (error) {
        return error as BuildFailure;
      }
    })();
    assert.ok(failure, 'an explicitly relative reference fell through to the content root');
    assert.match(failure.detail, /notes\/explicit\.md/, 'the report does not name the note that failed');
    assert.match(failure.detail, /\(missing\)/, 'the reported reason is not `missing`');
    assert.match(failure.message, /image reference/, 'the public message does not name the failure kind');
    assert.ok(!failure.message.includes('root-file'), 'the public message printed the private source path');
  });
});

test('a reference that names no root or note file does not resolve by basename', async () => {
  await scratch('media-basename-', async (directories) => {
    putBytes(directories.content, 'elsewhere/photo.png', PNG_SECOND);
    put(directories.content, 'notes/a.md', '# A\n\n![unrelated](photo.png)\n');

    const failure = await refusalFrom(directories);
    assert.match(failure.detail, /\(missing\)/, 'a basename elsewhere on disk was accepted');
  });
});

test('identical bytes publish one asset, whatever name or how many references', async () => {
  await scratch('media-dedupe-', async (directories) => {
    putBytes(directories.content, 'assets/one.png', PNG_UNICODE);
    // A byte-identical copy under a different name in another directory.
    putBytes(directories.content, 'assets/copy of one.png', PNG_UNICODE);
    putBytes(directories.content, 'notes/shared.png', PNG_UNICODE);
    put(directories.content, 'notes/a.md', [
      '# A',
      '',
      'One ![one](../assets/one.png) here.',
      'Again ![again](../assets/one.png) here.',
      'Copy ![copy](../assets/copy%20of%20one.png) here.',
      'Beside ![beside](shared.png) here.',
      '',
    ].join('\n'));
    put(directories.content, 'notes/b.md', '# B\n\nElsewhere ![shared](shared.png) here.\n');

    const produced = await produce(directories);
    const assets = assetsOf(produced.artifact);
    assert.equal(assets.length, 1, `identical bytes published ${assets.length} assets`);
    assert.equal(produced.staged.size, 1, 'the staged directory holds more than the one asset');
    const [asset] = assets;
    assert.equal(asset!.digest, digestOf(PNG_UNICODE));
    // The name is decoration: whichever deterministic reference reached it first.
    assert.match(asset!.fileName, /one\.png$/, `the published name lost its identity: ${asset!.fileName}`);
    // Every reference points at that one URL, in both notes.
    for (const entry of ['notes-a', 'notes-b']) {
      const urls = [...produced.markdown.get(entry)!.matchAll(/!\[[^\]]*\]\((\/_assets\/[^)]+)\)/g)].map((match) => match[1]);
      assert.ok(urls.length > 0, `${entry} published no image`);
      for (const url of urls) assert.equal(url, produced.artifact.assets![0]!.url, `${entry} points at ${url}`);
    }
  });
});

test('two unchanged builds produce identical artifact bytes, URLs, names and pixels', async () => {
  await scratch('media-determinism-', async (directories) => {
    putBytes(directories.content, 'assets/图 表 one.png', PNG_UNICODE);
    putBytes(directories.content, 'assets/photo.jpeg', JPEG);
    put(directories.content, 'notes/a.md', '# A\n\n![one](../assets/%E5%9B%BE%20%E8%A1%A8%20one.png)\n\n![two](../assets/photo.jpeg)\n');

    const first = await produce(directories);
    const firstArtifact = readFileSync(join(directories.out, 'content.json'));
    const firstFiles = new Map(first.staged);
    rmSync(join(directories.out, 'content.json'));
    rmSync(join(directories.out, 'assets'), { recursive: true });

    const second = await produce(directories);
    const secondArtifact = readFileSync(join(directories.out, 'content.json'));
    assert.ok(firstArtifact.equals(secondArtifact), 'the artifact bytes changed between two identical builds');
    assert.deepEqual([...second.staged.keys()].sort(), [...firstFiles.keys()].sort(), 'the published names changed');
    for (const [name, bytes] of firstFiles) {
      assert.ok(bytes.equals(second.staged.get(name)!), `${name} changed between two identical builds`);
    }
    assert.deepEqual(second.artifact.assets, first.artifact.assets);
  });
});

test('every supported format is copied byte-identically, including animated sources', async () => {
  await scratch('media-formats-', async (directories) => {
    const sources: readonly (readonly [string, Uint8Array])[] = [
      ['assets/one.png', PNG_UNICODE],
      ['assets/photo.jpeg', JPEG],
      ['assets/anim.gif', GIF_ANIMATED],
      ['assets/anim.webp', WEBP_ANIMATED],
      ['assets/still.avif', AVIF],
    ];
    const references = ['one.png', 'photo.jpeg', 'anim.gif', 'anim.webp', 'still.avif'];
    for (const [path, bytes] of sources) putBytes(directories.content, path, bytes);
    put(
      directories.content,
      'notes/a.md',
      `# A\n\n${references.map((name) => `![${name}](../assets/${name})`).join('\n\n')}\n`,
    );

    const produced = await produce(directories);
    assert.equal(produced.staged.size, sources.length, 'a format did not publish');
    for (const [path, bytes] of sources) {
      const digest = digestOf(bytes);
      const asset = assetsOf(produced.artifact).find((candidate) => candidate.digest === digest);
      assert.ok(asset, `${path} published nothing`);
      const stagedBytes = produced.staged.get(`${digest}-${asset.fileName}`);
      assert.ok(stagedBytes, `${path} staged under an unexpected name`);
      assert.ok(stagedBytes.equals(Buffer.from(bytes)), `${path} was not copied byte-identically`);
      // The extension names the detected format, not the source spelling: a host
      // infers Content-Type from it.
      const format = sniffImageFormat(bytes);
      assert.ok(format, `${path} is not a supported image by its bytes`);
      assert.equal(asset.fileName.slice(asset.fileName.lastIndexOf('.')), imageExtension(format), `${path} published under the wrong extension`);
    }

    // Animated sources are the ones a naive pipeline destroys. Byte identity is
    // the whole claim: the three frames are still there because the file is the
    // file. The fixtures really are animated — asserted here so a future edit
    // that replaces them with static images cannot quietly retire the property.
    assert.ok(Buffer.from(GIF_ANIMATED).includes(Buffer.from('NETSCAPE2.0')), 'the GIF fixture is no longer animated');
    assert.ok(Buffer.from(WEBP_ANIMATED).includes(Buffer.from('ANIM')), 'the WebP fixture is no longer animated');
  });
});

test('changing a source image changes the public reference and the published bytes', async () => {
  await scratch('media-change-', async (directories) => {
    putBytes(directories.content, 'assets/chart.png', PNG_SECOND);
    put(directories.content, 'notes/a.md', '# A\n\n![chart](../assets/chart.png)\n');
    put(directories.content, 'notes/b.md', '# B\n\n![the same chart](assets/chart.png)\n');

    const first = await produce(directories);
    const [before] = assetsOf(first.artifact);
    assert.ok(before, 'the first build published nothing');
    assert.ok(first.staged.get(`${before.digest}-${before.fileName}`)?.equals(Buffer.from(PNG_SECOND)));

    // The author replaces the file and rebuilds. Both notes reference it by the
    // same source path, so both must move to the new URL — a content-addressed
    // name that survived a source change would be a URL pointing at bytes it no
    // longer describes.
    rmSync(join(directories.out, 'content.json'));
    rmSync(join(directories.out, 'assets'), { recursive: true, force: true });
    putBytes(directories.content, 'assets/chart.png', PNG_UNICODE);

    const second = await produce(directories);
    const [after] = assetsOf(second.artifact);
    assert.ok(after, 'the second build published nothing');
    assert.notEqual(after.digest, before.digest, 'the published URL survived a source change');
    assert.equal(after.digest, digestOf(PNG_UNICODE));
    assert.deepEqual([...second.staged.keys()], [`${after.digest}-${after.fileName}`], 'a stale asset stayed staged');
    assert.ok(second.staged.get(`${after.digest}-${after.fileName}`)!.equals(Buffer.from(PNG_UNICODE)));
    for (const slug of ['notes-a', 'notes-b']) {
      const url = second.artifact.assets![0]!.url;
      assert.ok(second.markdown.get(slug)!.includes(url), `${slug} still points at the old image: ${second.markdown.get(slug)}`);
      assert.ok(!second.markdown.get(slug)!.includes(before.digest), `${slug} kept the old digest`);
    }
  });
});

test('a source named like another format publishes under the format its bytes are', async () => {
  await scratch('media-misnamed-', async (directories) => {
    // A PNG named `.jpg`. A static host would serve `image/jpeg` for it if the
    // extension were trusted.
    putBytes(directories.content, 'assets/diagram.jpg', PNG_SECOND);
    put(directories.content, 'notes/a.md', '# A\n\n![diagram](../assets/diagram.jpg)\n');

    const produced = await produce(directories);
    const [asset] = assetsOf(produced.artifact);
    assert.ok(asset, 'the misnamed image did not publish');
    assert.match(asset.fileName, /\.png$/, `the published extension followed the source name: ${asset.fileName}`);
  });
});

test('spaces and Unicode in a path publish through both legal destination spellings', async () => {
  await scratch('media-unicode-', async (directories) => {
    putBytes(directories.content, 'assets/图 表 one.png', PNG_UNICODE);
    put(directories.content, 'notes/a.md', [
      '# A',
      '',
      'Angle brackets ![angle](<../assets/图 表 one.png>) here.',
      'Percent-encoded ![encoded](../assets/%E5%9B%BE%20%E8%A1%A8%20one.png) here.',
      '',
    ].join('\n'));

    const produced = await produce(directories);
    const [asset] = assetsOf(produced.artifact);
    assert.ok(asset, 'the Unicode image did not publish');
    assert.equal(asset.fileName, '图 表 one.png', 'the published name lost its characters');
    // The URL is percent-encoded — and canonically so, which `parseAssetUrl`
    // enforces; the staged file keeps the raw name a host will decode to.
    const url = produced.artifact.assets![0]!.url;
    assert.ok(url.includes('%E5%9B%BE'), `the URL is not percent-encoded: ${url}`);
    assert.ok(produced.staged.has(`${asset.digest}-${asset.fileName}`), 'the raw name is not what was staged');
    assert.equal(
      produced.markdown.get('notes-a')!.split(url).length - 1,
      2,
      'the two legal spellings did not resolve to one asset',
    );
  });
});

test('a filename carrying a URL-reserved character resolves from its encoded destination', async () => {
  await scratch('media-reserved-', async (directories) => {
    // One name per character that means something else inside a URL. The file
    // literally named `chart%23one.avif` is the double-decode control: only a
    // single decode of `chart%2523one.avif` reaches it, while `chart%23one.png`
    // must reach the file named `chart#one.png` — both exist here at once, so a
    // resolver that decoded twice would publish one and call the other missing.
    putBytes(directories.content, 'assets/chart#one.png', PNG_UNICODE);
    putBytes(directories.content, 'assets/amp&one.png', PNG_SECOND);
    putBytes(directories.content, 'assets/query?one.jpg', JPEG);
    putBytes(directories.content, 'assets/percent%one.gif', GIF_ANIMATED);
    putBytes(directories.content, 'assets/chart%23one.avif', AVIF);
    put(directories.content, 'notes/a.md', [
      '# A',
      '',
      'Hash ![hash](../assets/chart%23one.png)',
      '',
      'Ampersand ![amp](../assets/amp%26one.png)',
      '',
      'Question ![query](../assets/query%3Fone.jpg)',
      '',
      'Percent ![percent](../assets/percent%25one.gif)',
      '',
      'Escape text ![escape](../assets/chart%2523one.avif)',
      '',
      'A real fragment ends the path: ![fragment](../assets/chart%23one.png#ignored)',
      '',
    ].join('\n'));

    const expected: readonly {
      readonly label: string;
      readonly bytes: Uint8Array;
      readonly fileName: string;
      readonly encoded: string;
    }[] = [
      { label: 'hash', bytes: PNG_UNICODE, fileName: 'chart#one.png', encoded: 'chart%23one.png' },
      { label: 'amp', bytes: PNG_SECOND, fileName: 'amp&one.png', encoded: 'amp%26one.png' },
      { label: 'query', bytes: JPEG, fileName: 'query?one.jpg', encoded: 'query%3Fone.jpg' },
      { label: 'percent', bytes: GIF_ANIMATED, fileName: 'percent%one.gif', encoded: 'percent%25one.gif' },
      { label: 'escape', bytes: AVIF, fileName: 'chart%23one.avif', encoded: 'chart%2523one.avif' },
    ];

    const produced = await produce(directories);
    const declared = produced.artifact.assets ?? [];
    assert.equal(declared.length, expected.length, `the corpus published ${declared.length} assets, not ${expected.length}`);
    const urlByDigest = new Map(declared.map((asset) => [parseAssetUrl(asset.url)!.digest, asset.url]));
    assert.equal(urlByDigest.size, expected.length, 'two reserved-character sources shared one digest');
    const markdown = produced.markdown.get('notes-a')!;

    for (const row of expected) {
      const digest = digestOf(row.bytes);
      const url = urlByDigest.get(digest);
      assert.ok(url, `${row.label}: published nothing`);
      assert.ok(url.endsWith(`-${row.encoded}`), `${row.label}: the URL is ${url}, not the encoded name ${row.encoded}`);
      assert.ok(!/[#?&]/.test(url), `${row.label}: a reserved character stayed raw in ${url}`);

      // The public URL is one fragment-free path segment, and its decoded path
      // is the raw staged name — the pair the copy step and the inventory read.
      const asUrl = new URL(url, 'https://example.test');
      assert.equal(asUrl.hash, '', `${row.label}: the URL starts a fragment: ${url}`);
      assert.equal(asUrl.search, '', `${row.label}: the URL starts a query: ${url}`);
      const fileName = `${digest}-${row.fileName}`;
      assert.equal(decodeURIComponent(asUrl.pathname), `/_assets/${fileName}`, `${row.label}: the URL path does not decode to the staged name`);
      const staged = produced.staged.get(fileName);
      assert.ok(staged?.equals(Buffer.from(row.bytes)), `${row.label}: ${fileName} is not the source bytes`);
      assert.ok(markdown.includes(`![${row.label}](${url})`), `${row.label}: the reference was not rewritten to ${url}`);
    }

    // The fragment was split before decoding, so it did not become part of the
    // name even though the path component is percent-decoded on its own.
    const hashUrl = urlByDigest.get(digestOf(PNG_UNICODE))!;
    assert.ok(markdown.includes(`![fragment](${hashUrl})`), 'a fragment on an encoded destination broke the reference');

    // Stability: two identical builds produce identical artifact bytes and names.
    const firstArtifact = readFileSync(join(directories.out, 'content.json'));
    const firstNames = [...produced.staged.keys()].sort();
    rmSync(join(directories.out, 'content.json'));
    rmSync(join(directories.out, 'assets'), { recursive: true });
    const second = await produce(directories);
    assert.ok(firstArtifact.equals(readFileSync(join(directories.out, 'content.json'))), 'the artifact bytes changed between two identical builds');
    assert.deepEqual(second.artifact.assets, produced.artifact.assets, 'the published URLs changed between two identical builds');
    assert.deepEqual([...second.staged.keys()].sort(), firstNames, 'the staged names changed between two identical builds');
  });
});

test('reserved-character spellings of identical bytes still publish one asset', async () => {
  await scratch('media-reserved-dedupe-', async (directories) => {
    // Three names, one byte set, two of them reserved-character spellings of a
    // third. Keying identity by the authored reference rather than by the bytes
    // would publish three copies; decoding twice would make the last two the
    // same file and lose one.
    putBytes(directories.content, 'assets/pic#one.png', PNG_UNICODE);
    putBytes(directories.content, 'assets/pic&one.png', PNG_UNICODE);
    putBytes(directories.content, 'assets/pic%23one.png', PNG_UNICODE);
    put(directories.content, 'notes/a.md', [
      '# A',
      '',
      '![hash](../assets/pic%23one.png)',
      '',
      '![amp](../assets/pic%26one.png)',
      '',
      '![escape](../assets/pic%2523one.png)',
      '',
    ].join('\n'));

    const produced = await produce(directories);
    const assets = assetsOf(produced.artifact);
    assert.equal(assets.length, 1, `identical bytes published ${assets.length} assets`);
    assert.equal(produced.staged.size, 1, 'the staging directory holds more than one copy');
    const url = produced.artifact.assets![0]!.url;
    const references = [...produced.markdown.get('notes-a')!.matchAll(/!\[[^\]]*\]\((\/_assets\/[^)\s]+)\)/g)].map((match) => match[1]);
    assert.equal(references.length, 3, 'a reserved-character reference was not rewritten');
    for (const reference of references) assert.equal(reference, url, `a reference points at ${reference}, not ${url}`);
    const parsed = parseAssetUrl(url);
    assert.ok(parsed, `the published URL is not canonical: ${url}`);
    assert.ok(produced.staged.has(`${parsed.digest}-${parsed.fileName}`), 'the URL does not decode to the staged file');
  });
});

test('reference-style images and image wikilinks publish through the same decision', async () => {
  await scratch('media-syntax-', async (directories) => {
    putBytes(directories.content, 'assets/chart.png', PNG_SECOND);
    put(directories.content, 'notes/a.md', [
      '# A',
      '',
      'Reference ![a chart][c] here.',
      '',
      'Embed ![[assets/chart.png]] here.',
      '',
      '[c]: ../assets/chart.png',
      '',
    ].join('\n'));

    const produced = await produce(directories);
    const [asset] = assetsOf(produced.artifact);
    assert.ok(asset, 'neither form published');
    const url = produced.artifact.assets![0]!.url;
    const markdown = produced.markdown.get('notes-a')!;
    // The reference is rewritten inline and its definition is rewritten too, so
    // the destination — the only place a reader would follow — carries the asset
    // URL in both halves.
    assert.ok(markdown.includes(`![a chart](${url})`), markdown);
    assert.ok(markdown.includes(`[c]: ${url}`), markdown);
    const definitions = markdown.split('\n').filter((line) => line.startsWith('[c]:'));
    assert.deepEqual(definitions, [`[c]: ${url}`], 'the definition did not become the asset URL');
    // A wikilink embed's label *is* its target, as it is for a note embed — the
    // author's label rule, not a second path channel. What matters is that the
    // destination is the asset URL.
    assert.match(markdown, /!\[assets\/chart\.png\]\(\/_assets\//, markdown);
    // A wikilink embed becomes an inline image with the target as its alt.
    assert.ok(markdown.includes(`![assets/chart.png](${url})`), markdown);
    assert.equal(
      markdown.split(url).length - 1,
      3,
      'the reference, its definition, and the wikilink embed did not all become the one URL',
    );
    // Neither rewritten shape carries a title, so neither may acquire a figure
    // or a caption: an image wikilink and a reference-style image used inline
    // are pictures, not authored figures.
    const rendered = await renderMarkdown(markdown, { publishedAssets: new Set([url]) });
    assert.doesNotMatch(rendered.html, /<figure|<figcaption/, rendered.html);
  });
});

test('a title the author wrote survives republication', async () => {
  await scratch('media-title-', async (directories) => {
    putBytes(directories.content, 'assets/photo.jpeg', JPEG);
    put(directories.content, 'notes/a.md', '# A\n\n![P](../assets/photo.jpeg "A \\"quoted\\" caption")\n');
    const produced = await produce(directories);
    assert.match(produced.markdown.get('notes-a')!, /"A \\"quoted\\" caption"\)/, produced.markdown.get('notes-a')!);
  });
});

test('remote and inline images are untouched, no asset is emitted, and nothing is fetched', async () => {
  await scratch('media-remote-', async (directories) => {
    put(directories.content, 'notes/a.md', [
      '# A',
      '',
      'Remote ![r](https://example.test/pic.png) here.',
      'Inline ![i](data:image/png;base64,iVBORw0KGgo=) here.',
      '<img src="https://example.test/second.png" alt="raw remote">',
      '',
    ].join('\n'));

    // A build that fetched a remote image would have to call `fetch` (or a
    // client that does). Making it throw is a real control on the claim: the
    // remote forms are kept, never retrieved.
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('the build fetched a remote image');
    };
    try {
      const produced = await produce(directories);
      assert.deepEqual(produced.artifact.assets ?? [], [], 'a remote image emitted an asset');
      assert.equal(produced.staged.size, 0, 'a remote image staged bytes');
      const markdown = produced.markdown.get('notes-a')!;
      assert.ok(markdown.includes('![r](https://example.test/pic.png)'), markdown);
      assert.ok(markdown.includes('data:image/png;base64,iVBORw0KGgo='), markdown);
      assert.ok(markdown.includes('<img src="https://example.test/second.png"'), markdown);
    } finally {
      globalThis.fetch = original;
    }
  });
});

test('a raw remote image with ignored leading whitespace builds and keeps its src', async () => {
  // The regression: the producer tested raw bytes while the renderer stripped
  // the characters `sanitize-html` ignores, so this note failed the build but
  // rendered unchanged before it. The producer and renderer now share
  // `classifyImageSource`, and this drives a real corpus through both.
  await scratch('media-html-remote-', async (directories) => {
    put(directories.content, 'notes/a.md', [
      '# A',
      '',
      '<img src=" https://example.test/leading.png" alt="space">',
      '',
      '<img src="\thttps://example.test/tab.png" alt="tab">',
      '',
      '<img src="\nhttps://example.test/newline.png" alt="newline">',
      '',
      '<img src="HTTPS://EXAMPLE.TEST/UPPER.PNG" alt="upper">',
      '',
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">',
      '',
    ].join('\n'));

    const produced = await produce(directories);
    assert.deepEqual(produced.artifact.assets ?? [], [], 'a remote raw image emitted an asset');
    assert.equal(produced.staged.size, 0, 'a remote raw image staged bytes');
    const markdown = produced.markdown.get('notes-a')!;
    for (const expected of [
      '<img src=" https://example.test/leading.png"',
      '<img src="\thttps://example.test/tab.png"',
      '<img src="\nhttps://example.test/newline.png"',
      '<img src="HTTPS://EXAMPLE.TEST/UPPER.PNG"',
      '<img src="data:image/png;base64,iVBORw0KGgo="',
    ]) {
      assert.ok(markdown.includes(expected), `${JSON.stringify(expected)} left the body: ${markdown}`);
    }

    const { html } = await renderMarkdown(markdown, { publishedAssets: new Set() });
    // The renderer must keep the exact src it used to keep, including the
    // whitespace character the old producer rejected the note for.
    assert.ok(html.includes('src=" https://example.test/leading.png"'), html);
    assert.ok(html.includes('src="\thttps://example.test/tab.png"'), html);
    assert.ok(html.includes('src="\nhttps://example.test/newline.png"'), html);
    assert.ok(html.includes('src="HTTPS://EXAMPLE.TEST/UPPER.PNG"'), html);
    assert.ok(html.includes('src="data:image/png;base64,iVBORw0KGgo="'), html);
  });
});

test('an image reference never becomes a note edge, and existing links keep theirs', async () => {
  await scratch('media-edges-', async (directories) => {
    putBytes(directories.content, 'assets/chart.png', PNG_SECOND);
    put(directories.content, 'beta.md', '# Beta\n');
    put(directories.content, 'a.md', '# A\n\n![chart](assets/chart.png)\n\nSee [beta](beta.md) and [[beta]].\n');
    const produced = await produce(directories);
    assert.deepEqual(produced.outgoing.get('a'), ['beta'], 'an image reference changed the edge set');
  });
});

test('every unauthorized local image is a build failure with its own reason', async () => {
  // One row per fault, each with the public label the stream carries and the
  // stable reason the report records. The body is written per row rather than
  // computed, because a shared template is what lets two rows silently become
  // the same test.
  const rows: readonly {
    readonly name: string;
    readonly body: string;
    readonly files?: Record<string, Uint8Array>;
    readonly exclude?: string[];
    readonly label: string;
    readonly reason: string;
  }[] = [
    { name: 'missing', body: '![x](../assets/gone.png)', label: 'missing', reason: 'missing' },
    {
      name: 'missing-encoded',
      body: '![x](../assets/gone%23.png)',
      label: 'missing',
      reason: 'missing',
    },
    {
      // `%2F` decodes to a separator, not a filename byte: the file below exists,
      // but no single path segment names it, so this stays a failure rather than
      // becoming a second spelling of `assets/sub/pic.png`.
      name: 'encoded-separator',
      body: '![x](../assets/sub%2Fpic.png)',
      files: { 'assets/sub/pic.png': PNG_SECOND },
      label: 'missing',
      reason: 'missing',
    },
    {
      name: 'excluded',
      body: '![x](../assets/secret.png)',
      files: { 'assets/secret.png': PNG_SECOND },
      exclude: ['assets/secret.png'],
      label: 'excluded',
      reason: 'excluded',
    },
    { name: 'svg', body: '![x](../assets/vector.svg)', files: { 'assets/vector.svg': SVG }, label: 'unsupported local SVG', reason: 'svg' },
    { name: 'unsupported', body: '![x](../assets/notes.txt)', files: { 'assets/notes.txt': NOT_AN_IMAGE }, label: 'unsupported file type', reason: 'unsupported' },
    { name: 'escape', body: '![x](../../outside.png)', label: 'outside the content root', reason: 'outside' },
    {
      name: 'html',
      body: '<img src="assets/chart.png" alt="handwritten">',
      files: { 'assets/chart.png': PNG_SECOND },
      label: 'unsupported HTML image form',
      reason: 'html-form',
    },
    // A raw `<img>` whose src is a local/script scheme is the producer's to
    // report. The shared classifier marks these `refused`; the renderer would
    // have let the sanitizer drop the attribute, which is the silent outcome
    // Goal 0009 replaces with a failure.
    {
      name: 'html-file',
      body: '<img src="file:///etc/passwd" alt="handwritten">',
      label: 'unsupported HTML image form',
      reason: 'html-form',
    },
    {
      name: 'html-javascript',
      body: '<img src="java\tscript:alert(1)" alt="handwritten">',
      label: 'unsupported HTML image form',
      reason: 'html-form',
    },
    {
      name: 'html-vbscript',
      body: '<img src="vbscript:msgbox(1)" alt="handwritten">',
      label: 'unsupported HTML image form',
      reason: 'html-form',
    },
    {
      name: 'html-whitespace',
      body: '<img src="   " alt="handwritten">',
      label: 'unsupported HTML image form',
      reason: 'html-form',
    },
    {
      name: 'html-no-src',
      body: '<img alt="handwritten">',
      label: 'unsupported HTML image form',
      reason: 'html-form',
    },
  ];

  for (const row of rows) {
    await scratch(`media-fail-${row.name}-`, async (directories) => {
      for (const [path, bytes] of Object.entries(row.files ?? {})) putBytes(directories.content, path, bytes);
      put(directories.content, 'notes/a.md', `# A\n\n${row.body}\n`);
      const failure = await refusalFrom(directories, row.exclude ?? []);
      assert.equal(failure.code, 'image-not-publishable', `${row.name}: unexpected failure code`);
      assert.match(failure.message, new RegExp(row.label), `${row.name}: the public message does not name the failure kind`);
      assert.match(failure.detail, new RegExp(`\\(${row.reason}\\)`), `${row.name}: ${failure.detail}`);
      assert.ok(!failure.message.includes('a.md'), `${row.name}: the public message named the note file`);
      assert.equal(existsSync(join(directories.out, 'assets')), false, `${row.name}: a failed build staged asset bytes`);
    });
  }
});

test('an <img> a note only documents is not a reference, and does not fail the build', async () => {
  // The negative control's control. A build that fails on every occurrence of
  // the bytes `<img` would refuse a note that explains how to write one, and a
  // note documenting syntax is content — the same rule that made an unresolved
  // `[[wikilink]]` inside a fence legal. Three inert carriers: an HTML comment, an
  // inline code span, and a fenced block.
  await scratch('media-documented-', async (directories) => {
    put(directories.content, 'a.md', [
      '# A',
      '',
      '<!-- <img src="assets/missing.png" alt="shown, never requested"> -->',
      '',
      'An inline `<img src="assets/missing.png">` span.',
      '',
      '```html',
      '<img src="assets/missing.png" alt="documented">',
      '```',
      '',
    ].join('\n'));

    const produced = await produce(directories);
    assert.deepEqual(produced.artifact.assets ?? [], [], 'a documented img published an asset');
    const markdown = produced.markdown.get('a')!;
    assert.ok(markdown.includes('<!-- <img src="assets/missing.png"'), 'the comment was rewritten');
    assert.ok(markdown.includes('`<img src="assets/missing.png">`'), 'the inline code was rewritten');
    assert.ok(markdown.includes('<img src="assets/missing.png" alt="documented">'), 'the fence was rewritten');
  });
});

test('a symlink whose target leaves the content root is refused without reading it', async () => {
  await scratch('media-symlink-', async (directories) => {
    putBytes(directories.content, 'inside/ok.png', PNG_SECOND);
    put(directories.content, 'notes/a.md', '# A\n\n![out](../escaping.png)\n\n![in](../inside/ok.png)\n');
    // The target is a real image on this host, outside the content root. A build
    // that followed the link would publish those pixels under a digest.
    const outside = join(directories.root, 'outside.png');
    writeFileSync(outside, PNG_UNICODE);
    symlinkSync(outside, join(directories.content, 'escaping.png'));

    const failure = await refusalFrom(directories);
    assert.match(failure.detail, /\(outside\)/, failure.detail);
    assert.match(failure.detail, /escaping\.png/, 'the report does not name the link');
  });
});

test('media referenced only by a withheld note, and unreferenced media, never reach the output', async () => {
  await scratch('media-withheld-', async (directories) => {
    putBytes(directories.content, 'assets/only-withheld.png', PNG_UNICODE);
    putBytes(directories.content, 'assets/unreferenced.png', PNG_SECOND);
    put(directories.content, 'a.md', '# A\n\nProse only.\n');
    put(
      directories.content,
      'drafts/hidden.md',
      '---\npublish: false\n---\n\n# Hidden\n\n![x](../assets/only-withheld.png)\n',
    );
    const produced = await produce(directories);
    assert.deepEqual(produced.artifact.assets ?? [], [], 'a withheld reference published an asset');
    assert.equal(existsSync(join(directories.out, 'assets')), false, 'the staging directory was created for nothing');
    // And neither file's bytes reach the artifact or the output in any form.
    const artifactText = readFileSync(join(directories.out, 'content.json'), 'utf8');
    assert.ok(!artifactText.includes('only-withheld'), 'the withheld image name reached the artifact');
    assert.ok(!artifactText.includes('unreferenced'), 'the unreferenced image name reached the artifact');
  });
});

test('the committed fixture corpus declares exactly the assets it ships', async () => {
  // `tests/fixtures/valid-corpus.json` is the 32-note corpus `build:fixture`
  // uses, and it is hand-maintained rather than generated. Its declared URLs and
  // the bytes beside it therefore have to be checked as a pair here; the output
  // inventory checks the same pair in `dist/` after a build.
  const fixture = new URL('./fixtures/', import.meta.url);
  const artifact = JSON.parse(readFileSync(new URL('valid-corpus.json', fixture), 'utf8')) as ContentArtifact;
  const declared = assetsOf(artifact);
  assert.ok(declared.length >= 2, 'the fixture corpus exercises no local images');

  const directory = new URL('assets/', fixture);
  const files = readdirSync(directory).sort();
  const expected = declared.map((asset) => `${asset.digest}-${asset.fileName}`).sort();
  assert.deepEqual(files, expected, 'the fixture asset directory and the artifact declaration disagree');
  for (const asset of declared) {
    const bytes = readFileSync(new URL(`${asset.digest}-${asset.fileName}`, directory));
    assert.equal(digestOf(bytes), asset.digest, `${asset.fileName} does not hash to its URL`);
    const format = sniffImageFormat(bytes);
    assert.ok(format, `${asset.fileName} is not a supported image`);
    assert.equal(imageExtension(format), asset.fileName.slice(asset.fileName.lastIndexOf('.')), `${asset.fileName} disagrees with its bytes`);
    // The hand-maintained fixture's declared dimensions are the header's own,
    // not a second guess. A truncated-header fixture declares neither.
    const dimensions = imageDimensions(bytes, format);
    assert.equal(asset.width, dimensions?.width, `${asset.fileName}: declared width disagrees with its header`);
    assert.equal(asset.height, dimensions?.height, `${asset.fileName}: declared height disagrees with its header`);
  }
  // Every declared asset is referenced by at least one entry, so the fixture
  // cannot drift into declaring bytes no page shows.
  const references = artifact.entries.flatMap((entry) => [...entry.markdown.matchAll(/\/_assets\/[^\s)"'<>]+/g)].map((match) => match[0]));
  for (const { url } of artifact.assets ?? []) {
    assert.ok(references.includes(url), `${url} is declared but no entry references it`);
  }
});

test('every supported raster header yields its own pixel size, and a truncated one yields none', () => {
  const rows: readonly (readonly [string, Uint8Array, { width: number; height: number }])[] = [
    ['png', PNG_UNICODE, { width: 8, height: 6 }],
    ['jpeg', JPEG, { width: 8, height: 6 }],
    ['gif', GIF_ANIMATED, { width: 4, height: 4 }],
    ['webp', WEBP_ANIMATED, { width: 4, height: 4 }],
    ['webp', WEBP_LOSSLESS, { width: 12, height: 20 }],
    ['webp', WEBP_LOSSY, { width: 12, height: 20 }],
    ['webp', WEBP_LOSSY_WIDE, { width: 333, height: 47 }],
    ['avif', AVIF, { width: 8, height: 6 }],
  ];
  for (const [format, bytes, expected] of rows) {
    assert.deepEqual(
      imageDimensions(bytes, format as 'png' | 'jpeg' | 'gif' | 'webp' | 'avif'),
      expected,
      `${format}: the header's own dimensions were not read`,
    );
    // Truncate inside every format's header: a fallible hint must fail open,
    // not throw and not invent a size from the bytes that remain.
    for (const length of [0, 4, 8]) {
      const truncated = bytes.subarray(0, Math.min(length, bytes.length));
      assert.equal(
        imageDimensions(truncated, format as 'png' | 'jpeg' | 'gif' | 'webp' | 'avif'),
        undefined,
        `${format}: a ${truncated.length}-byte prefix produced dimensions`,
      );
    }
  }
  // A non-1 EXIF orientation (JPEG, WebP, PNG) or an AVIF irot/imir transform
  // makes the stored pair describe different pixels from the displayed image.
  // The honest answer is no attributes, not a transposed guess.
  for (const [format, bytes] of [
    ['jpeg', ORIENTED_JPEG],
    ['webp', ORIENTED_WEBP],
    ['png', ORIENTED_PNG],
    ['avif', ORIENTED_AVIF],
    ['avif', ORIENTED_AVIF_MIRROR],
  ] as const) {
    assert.equal(
      imageDimensions(bytes, format),
      undefined,
      `${format}: an oriented/transformed image produced dimensions`,
    );
  }
  assert.deepEqual(
    imageDimensions(ORIENTATION_1_JPEG, 'jpeg'),
    { width: 8, height: 6 },
    'an explicit Orientation 1 should keep the usable pair',
  );
  // An `ipco` is a property container, not an item description. The first
  // `ispe` here is an unused 1000x1 property; the primary item's `ipma` entry
  // still points at the original 8x6 property. The second file removes that
  // association, so there is no primary `ispe` even though the container has
  // one: both must fail open rather than read container order.
  assert.deepEqual(
    imageDimensions(AVIF_PRIMARY_ISPE_NOT_FIRST, 'avif'),
    { width: 8, height: 6 },
    'AVIF dimensions followed a non-primary property',
  );
  assert.equal(
    imageDimensions(AVIF_PRIMARY_ISPE_UNASSOCIATED, 'avif'),
    undefined,
    'an AVIF with no primary-item ispe association produced dimensions',
  );
  // JPEG TEM carries no length and must be skipped, while a frame header after
  // the start of scan is entropy-coded data and must not become a size.
  const withTem = new Uint8Array([JPEG[0]!, JPEG[1]!, 0xff, 0x01, ...JPEG.subarray(2)]);
  assert.deepEqual(imageDimensions(withTem, 'jpeg'), { width: 8, height: 6 });
  const sosBeforeFrame = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...Array<number>(14).fill(0),
    0xff, 0xda, 0x00, 0x0c, ...Array<number>(10).fill(0),
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  assert.equal(imageDimensions(sosBeforeFrame, 'jpeg'), undefined);
  // The PNG signature alone is a file Goal 0009 publishes and Goal 0010 must not
  // claim to know the size of.
  assert.equal(imageDimensions(PNG_UNICODE.subarray(0, 8), 'png'), undefined);
});

test('the producer records header dimensions, and a truncated header publishes without attributes', async () => {
  await scratch('media-dimensions-', async (directories) => {
    const truncated = PNG_UNICODE.subarray(0, 8);
    putBytes(directories.content, 'assets/one.png', PNG_UNICODE);
    putBytes(directories.content, 'assets/photo.jpeg', JPEG);
    putBytes(directories.content, 'assets/anim.gif', GIF_ANIMATED);
    putBytes(directories.content, 'assets/anim.webp', WEBP_ANIMATED);
    putBytes(directories.content, 'assets/lossless.webp', WEBP_LOSSLESS);
    putBytes(directories.content, 'assets/still.avif', AVIF);
    putBytes(directories.content, 'assets/broken.png', truncated);
    putBytes(directories.content, 'assets/oriented.jpg', ORIENTED_JPEG);
    put(
      directories.content,
      'notes/a.md',
      [
        '# A',
        '',
        '![one](../assets/one.png)',
        '',
        '![two](../assets/photo.jpeg)',
        '',
        '![three](../assets/anim.gif)',
        '',
        '![four](../assets/anim.webp)',
        '',
        '![five](../assets/still.avif)',
        '',
        '![six](../assets/lossless.webp)',
        '',
        '![a truncated header](../assets/broken.png)',
        '',
        '![an oriented photograph](../assets/oriented.jpg)',
        '',
      ].join('\n'),
    );

    const produced = await produce(directories);
    const assets = assetsOf(produced.artifact);
    const byDigest = new Map(assets.map((asset) => [asset.digest, asset]));
    const expected: readonly (readonly [Uint8Array, number, number])[] = [
      [PNG_UNICODE, 8, 6],
      [JPEG, 8, 6],
      [GIF_ANIMATED, 4, 4],
      [WEBP_ANIMATED, 4, 4],
      [WEBP_LOSSLESS, 12, 20],
      [AVIF, 8, 6],
    ];
    for (const [bytes, width, height] of expected) {
      const asset = byDigest.get(digestOf(bytes));
      assert.ok(asset, `a supported format published nothing`);
      assert.equal(asset.width, width, `${asset.fileName}: width`);
      assert.equal(asset.height, height, `${asset.fileName}: height`);
    }
    const broken = byDigest.get(digestOf(truncated));
    assert.ok(broken, 'the truncated PNG was not published');
    assert.equal(broken.width, undefined, 'the truncated PNG claimed a width');
    assert.equal(broken.height, undefined, 'the truncated PNG claimed a height');
    const oriented = byDigest.get(digestOf(ORIENTED_JPEG));
    assert.ok(oriented, 'the EXIF-rotated JPEG was not published');
    assert.equal(oriented.width, undefined, 'the EXIF-rotated JPEG claimed a coded width');
    assert.equal(oriented.height, undefined, 'the EXIF-rotated JPEG claimed a coded height');

    // The rendered page uses the recorded values, and the unreadable header
    // gives no attributes at all rather than a zero or a guess.
    const markdown = produced.markdown.get('notes-a')!;
    const declared = produced.artifact.assets ?? [];
    const dimensions = new Map(
      declared.flatMap((asset) =>
        asset.width === undefined || asset.height === undefined
          ? []
          : [[asset.url, { width: asset.width, height: asset.height }] as const],
      ),
    );
    const urls = new Set(declared.map((asset) => asset.url));
    const rendered = await renderMarkdown(markdown, { publishedAssets: urls, assetDimensions: dimensions });
    assert.match(rendered.html, /width="8" height="6"/, rendered.html);
    assert.match(rendered.html, /width="4" height="4"/, rendered.html);
    const brokenUrl = produced.artifact.assets!.find((asset) => parseAssetUrl(asset.url)!.digest === digestOf(truncated))!.url;
    const brokenTag = new RegExp(`<img src="${brokenUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(rendered.html);
    assert.ok(brokenTag, 'the truncated image rendered no tag');
    assert.doesNotMatch(brokenTag[0], /\swidth=|\sheight=/, `a truncated header produced dimensions: ${brokenTag[0]}`);
  });
});
