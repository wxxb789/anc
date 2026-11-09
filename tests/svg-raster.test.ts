/**
 * Goal 0012: a static SVG is build-only input that becomes lossless WebP.
 *
 * Every gate here runs the shipped producer over **real files** — the committed
 * `tests/fixtures/svg/` corpus — because the properties at stake are about bytes:
 * whether a hostile document stops the build with the reason it names, whether a
 * benign one becomes the WebP its author's geometry describes, and whether the
 * XML reaches anything public.
 *
 * The negative controls are the point of the file. A rasterizer's failure
 * direction is the one that matters: a script that reaches a browser, a label
 * that silently becomes tofu, or a host file that leaks through a reference are
 * all worse than a build that stops and says so. Each hostile fixture therefore
 * asserts its **named** reason, and the public message is checked to carry only
 * the counted label rather than the construct the private report names.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import sharp from 'sharp';

import { imageDimensions, looksLikeSvg, parseAssetUrl, sniffImageFormat } from '../src/lib/media.ts';
import { coveredByCmap, missingCodePoints } from '../src/lib/font-coverage.ts';
import { inspectPresentationAttribute, inspectStyleAttribute, inspectStyleSheet } from '../src/lib/svg-css.ts';
import { inspectSvg, requiredCharacters, SVG_POLICY_LIMITS, type SvgLimits } from '../src/lib/svg-policy.ts';
import { prepareSvg, SVG_RENDER_LIMITS } from '../src/lib/svg-render.ts';
import type { SvgRefusalReason } from '../src/lib/svg-refusal.ts';
import type { ContentArtifact } from '../src/lib/schema.ts';
import { discover, resolveCorpusLinks, writeArtifact } from '../scripts/markdown-to-artifact.ts';
import type { BuildFailure } from '../scripts/write-report.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/svg/', import.meta.url));

function fixture(directory: 'benign' | 'hostile', name: string): Buffer {
  return readFileSync(join(FIXTURE_ROOT, directory, name));
}

const BENIGN = readdirSync(join(FIXTURE_ROOT, 'benign')).sort();

/**
 * Every hostile fixture and the reason it must produce.
 */
const HOSTILE: Readonly<Record<string, { readonly reason: SvgRefusalReason }>> = {
  'doctype.svg': { reason: 'svg-doctype' },
  'entity.svg': { reason: 'svg-doctype' },
  'xinclude.svg': { reason: 'svg-xinclude' },
  'script.svg': { reason: 'svg-script' },
  'foreign-object.svg': { reason: 'svg-foreign' },
  'event-handler.svg': { reason: 'svg-script' },
  'animation.svg': { reason: 'svg-animation' },
  'external-stylesheet.svg': { reason: 'svg-external' },
  'css-import.svg': { reason: 'svg-css' },
  'css-external-url.svg': { reason: 'svg-external' },
  'css-data-url.svg': { reason: 'svg-data' },
  'css-font-face.svg': { reason: 'svg-css' },
  'style-attribute.svg': { reason: 'svg-external' },
  'presentation-url.svg': { reason: 'svg-external' },
  'xlink-network.svg': { reason: 'svg-external' },
  'css-escaped-url.svg': { reason: 'svg-script' },
  'local-file.svg': { reason: 'svg-external' },
  'network.svg': { reason: 'svg-external' },
  'data-asset.svg': { reason: 'svg-data' },
  'invalid-xml.svg': { reason: 'svg-invalid' },
  'foreign-namespace.svg': { reason: 'svg-foreign' },
  'foreign-xhtml.svg': { reason: 'svg-foreign' },
  'pixel-flood.svg': { reason: 'svg-workload' },
  'filter-flood.svg': { reason: 'svg-workload' },
  'filter-region.svg': { reason: 'svg-workload' },
  'filter-region-exponent.svg': { reason: 'svg-workload' },
  'filter-region-negative.svg': { reason: 'svg-workload' },
  'filter-region-important.svg': { reason: 'svg-invalid' },
  'filter-primitive-region.svg': { reason: 'svg-workload' },
  'num-octaves.svg': { reason: 'svg-invalid' },
  'filter-deviation.svg': { reason: 'svg-workload' },
  'distant-light.svg': { reason: 'svg-unsafe' },
  'empty.svg': { reason: 'svg-empty' },
  'empty-root.svg': { reason: 'svg-empty' },
  'missing-glyph.svg': { reason: 'svg-font' },
  'metadata.svg': { reason: 'svg-unsafe' },
  'no-namespace.svg': { reason: 'svg-unsafe' },
  'xml-base.svg': { reason: 'svg-external' },
};

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

function putDirectory(root: string, relativePath: string, body: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

function putBytes(root: string, relativePath: string, bytes: Uint8Array): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

async function produce(directories: Scratch, exclude: string[] = []): Promise<{
  readonly artifact: ContentArtifact;
  readonly staged: ReadonlyMap<string, Buffer>;
  readonly markdown: ReadonlyMap<string, string>;
}> {
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
  };
}

async function refusalFrom(directories: Scratch): Promise<BuildFailure> {
  try {
    await produce(directories);
  } catch (error) {
    assert.equal((error as BuildFailure).name, 'BuildFailure', `not a disclosure-checked failure: ${String(error)}`);
    return error as BuildFailure;
  }
  assert.fail('the producer accepted an SVG it must refuse');
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The logical size each benign fixture declares, and the 2× raster it must
 * produce. Hardcoded because these are the documents' own numbers: a renderer
 * change that moves them should require reading the diff, not recomputing the
 * expectation from the same code under test.
 */
const EXPECTED: Readonly<Record<string, { readonly css: readonly [number, number]; readonly pixel: readonly [number, number] }>> = {
  'arrow-labels.svg': { css: [560, 220], pixel: [1120, 440] },
  'cjk-text.svg': { css: [560, 240], pixel: [1120, 480] },
  'clip-paths.svg': { css: [560, 320], pixel: [1120, 640] },
  'explicit-size.svg': { css: [640, 320], pixel: [1280, 640] },
  'filters.svg': { css: [640, 300], pixel: [1280, 600] },
  'gradients.svg': { css: [600, 300], pixel: [1200, 600] },
  'latin-text.svg': { css: [520, 200], pixel: [1040, 400] },
  'line-art.svg': { css: [480, 240], pixel: [960, 480] },
  'lighting.svg': { css: [400, 240], pixel: [800, 480] },
  'masks.svg': { css: [600, 300], pixel: [1200, 600] },
  'physical-mm.svg': { css: [378, 189], pixel: [755, 377] },
  'shared.svg': { css: [360, 160], pixel: [720, 320] },
  'small-text.svg': { css: [320, 140], pixel: [640, 280] },
  'stylesheet.svg': { css: [480, 240], pixel: [960, 480] },
  'symbols.svg': { css: [420, 120], pixel: [840, 240] },
  'transparent.svg': { css: [320, 320], pixel: [640, 640] },
  'viewbox-only.svg': { css: [720, 340], pixel: [1440, 680] },
};

test('every hostile fixture is refused by the policy with its own reason', async () => {
  assert.deepEqual(
    Object.keys(HOSTILE).sort(),
    readdirSync(join(FIXTURE_ROOT, 'hostile')).sort(),
    'the hostile corpus and the expected-reason table disagree',
  );

  for (const [name, expectation] of Object.entries(HOSTILE)) {
    const bytes = fixture('hostile', name);
    const inspection = inspectSvg(bytes);
    let refusalReason: string;
    let privateDetail: string;
    if (inspection.ok) {
      const rendered = await prepareSvg(bytes);
      if (rendered.ok) assert.fail(`${name}: the policy accepted a hostile document`);
      assert.ok(rendered.detail !== undefined, `${name}: the renderer refused without a private detail`);
      refusalReason = rendered.reason;
      privateDetail = rendered.detail;
    } else {
      refusalReason = inspection.refusal.reason;
      privateDetail = inspection.refusal.detail;
    }
    assert.equal(refusalReason, expectation.reason, `${name}: expected ${expectation.reason}, got ${refusalReason} — ${privateDetail}`);

    await scratch(`svg-hostile-${name.replace(/[^a-z]+/gi, '-')}-`, async (directories) => {
      putBytes(directories.content, `assets/${name}`, bytes);
      putDirectory(directories.content, 'page.md', `# Page\n\n![diagram](assets/${name})\n`);
      const failure = await refusalFrom(directories);
      assert.match(failure.detail, new RegExp(`\\(${expectation.reason}(?::|\\()`), `${name}: ${failure.detail}`);
      assert.ok(
        !failure.message.includes(privateDetail),
        `${name}: the public message carried the private detail (${privateDetail})`,
      );
    });
  }
});

test('every benign fixture publishes one WebP at its declared layout size', async () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), BENIGN, 'the benign corpus and the expectation table disagree');

  await scratch('svg-benign-', async (directories) => {
    for (const name of BENIGN) putBytes(directories.content, `assets/${name}`, fixture('benign', name));
    putDirectory(
      directories.content,
      'page.md',
      ['# Gallery', '', ...BENIGN.map((name) => `![${name}](assets/${name})`), ''].join('\n'),
    );

    const produced = await produce(directories);
    const assets = produced.artifact.assets ?? [];
    assert.equal(assets.length, BENIGN.length, 'a benign fixture did not publish exactly one asset');

    for (const name of BENIGN) {
      const expectation = EXPECTED[name]!;
      const match = new RegExp(`!\\[${name}\\]\\((/[^)]+)\\)`).exec(produced.markdown.get('page')!);
      assert.ok(match, `${name}: no published URL`);
      const url = match[1]!;
      const declaration = assets.find((asset) => asset.url === url);
      assert.ok(declaration, `${name}: the artifact does not declare ${url}`);
      const parsed = parseAssetUrl(url);
      assert.ok(parsed, `${name}: not a canonical asset URL`);
      assert.match(parsed.fileName, /\.webp$/, `${name}: published under a non-WebP name`);

      const staged = produced.staged.get(`${parsed.digest}-${parsed.fileName}`);
      assert.ok(staged, `${name}: the declared asset was not staged`);
      assert.equal(parsed.digest, digestOf(staged), `${name}: the URL digest does not hash the staged bytes`);
      assert.equal(sniffImageFormat(staged), 'webp', `${name}: the emitted bytes are not WebP`);
      assert.equal(staged.subarray(8, 12).toString('latin1'), 'WEBP', `${name}: the RIFF tag is not WEBP`);

      assert.equal(declaration.width, expectation.css[0], `${name}: published layout width`);
      assert.equal(declaration.height, expectation.css[1], `${name}: published layout height`);

      // The emitted header is read by the same function 0010 uses, and it must be
      // the 2× raster the layout attributes halve.
      const emitted = imageDimensions(staged, 'webp');
      assert.deepEqual(emitted, { width: expectation.pixel[0], height: expectation.pixel[1] }, `${name}: emitted pixels`);

      const cssAspect = expectation.css[0] / expectation.css[1];
      const pixelAspect = emitted!.width / emitted!.height;
      assert.ok(
        Math.abs(pixelAspect - cssAspect) / cssAspect < 0.01,
        `${name}: emitted aspect ${pixelAspect.toFixed(4)} differs from ${cssAspect.toFixed(4)}`,
      );
    }

    // The source XML reaches none of the private outputs that could carry it.
    // (An alt text may legitimately contain the filename — that is the author's
    // own words — so this checks paths and asset URLs, not prose.)
    const serialized = JSON.stringify(produced.artifact);
    for (const asset of assets) {
      assert.ok(!asset.url.endsWith('.svg'), `an .svg name reached a published asset URL: ${asset.url}`);
    }
    for (const name of BENIGN) {
      assert.ok(!serialized.includes(`assets/${name}`), `${name}: the artifact carries the source path`);
    }
  });
});

test('an SVG is authorized before its bytes are parsed', async () => {
  // A hostile document, withheld by the author's own exclusion: the answer must
  // be `excluded`, not the script the policy would have found. That ordering is
  // the publication boundary — the policy runs on bytes this build may publish.
  await scratch('svg-authorized-', async (directories) => {
    putBytes(directories.content, 'assets/script.svg', fixture('hostile', 'script.svg'));
    putDirectory(directories.content, 'page.md', '# Page\n\n![hidden](assets/script.svg)\n');
    const failure = await (async () => {
      try {
        await produce(directories, ['assets/script.svg']);
      } catch (error) {
        return error as BuildFailure;
      }
      assert.fail('an excluded SVG was parsed and published');
    })();
    assert.match(failure.detail, /\(excluded\)/, 'the excluded SVG reached the policy instead of the authorization check');
  });

  await scratch('svg-missing-target-', async (directories) => {
    putDirectory(directories.content, 'page.md', '# Page\n\n![absent](assets/absent.svg)\n');
    const failure = await (async () => {
      try {
        await produce(directories);
      } catch (error) {
        return error as BuildFailure;
      }
      assert.fail('a missing SVG was accepted');
    })();
    assert.match(failure.detail, /\(missing\)/);
  });

  await scratch('svg-outside-target-', async (directories) => {
    putDirectory(directories.content, 'page.md', '# Page\n\n![outside](../../outside.svg)\n');
    const failure = await (async () => {
      try {
        await produce(directories);
      } catch (error) {
        return error as BuildFailure;
      }
      assert.fail('a reference outside the content root was accepted');
    })();
    assert.match(failure.detail, /\(outside\)/);
  });
});

test('href and legacy xlink:href take the same check', () => {
  const value = 'https://example.invalid/sprite.svg#icon';
  const modern =
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">` +
    `<use href="${value}" width="40" height="40"/></svg>`;
  const legacy =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40">` +
    `<use xlink:href="${value}" width="40" height="40"/></svg>`;
  const first = inspectSvg(Buffer.from(modern));
  const second = inspectSvg(Buffer.from(legacy));
  if (first.ok || second.ok) assert.fail('one spelling of the same reference was accepted');
  assert.equal(first.refusal.reason, second.refusal.reason);
  assert.match(first.refusal.detail, /@href/);
  assert.match(second.refusal.detail, /@xlink:href/);
});

test('an over-budget surface is downscaled proportionally, never cropped', async () => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000">` +
    `<rect width="2000" height="4000" fill="#8ad884"/><rect x="2000" width="2000" height="4000" fill="#86c8e6"/>` +
    `</svg>`;
  const result = await prepareSvg(Buffer.from(svg));
  if (!result.ok) assert.fail(`${result.reason} ${result.detail ?? ''}`);
  const pixels = result.image.dimensions!;
  const css = result.image.displayDimensions!;
  assert.ok(pixels.width * pixels.height <= 6_000_000, `the output kept ${pixels.width * pixels.height} pixels`);
  assert.ok(Math.max(pixels.width, pixels.height) <= 8_000, 'the output exceeded the side limit');
  assert.ok(Math.abs(pixels.width / pixels.height - 1) < 0.01, `the square document became ${pixels.width}×${pixels.height}`);
  assert.deepEqual(css, { width: 1225, height: 1225 }, 'the layout is not exactly the emitted raster / 2');
});

test('a thin physical-unit diagram is rendered against its declared aspect', async () => {
  // The 72-dpi natural size rounds this to 22×900; comparing the 2398-px output
  // to that rounded aspect refused a valid document. The target is the declared
  // 7.647mm × 317.352mm, not the measurement's approximation.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="7.647mm" height="317.352mm">` +
    `<rect width="100%" height="100%" fill="#8ad884"/>` +
    `</svg>`;
  const result = await prepareSvg(Buffer.from(svg));
  if (!result.ok) assert.fail(`${result.reason} ${result.detail ?? ''}`);
  assert.deepEqual(result.image.dimensions, { width: 57, height: 2398 });
  assert.deepEqual(result.image.displayDimensions, { width: 29, height: 1199 });
});

test('every finite policy budget refuses at its boundary', async () => {
  const wrap = (body: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">${body}</svg>`;
  const cases: readonly {
    readonly name: string;
    readonly svg: string;
    readonly limits: Partial<SvgLimits>;
  }[] = [
    { name: 'elements', svg: wrap('<rect/>'), limits: { maxElements: 1 } },
    { name: 'depth', svg: wrap('<g><g><rect/></g></g>'), limits: { maxDepth: 2 } },
    { name: 'uses', svg: wrap('<use href="#a"/><use href="#a"/>'), limits: { maxUses: 1 } },
    { name: 'text characters', svg: wrap('<text>ab</text>'), limits: { maxTextCharacters: 1 } },
    { name: 'style element', svg: wrap('<style>rect{fill:red}</style>'), limits: { maxStyleCharacters: 1 } },
    { name: 'style attribute', svg: wrap('<rect style="fill:red"/>'), limits: { maxStyleCharacters: 1 } },
    { name: 'filter primitives', svg: wrap('<feGaussianBlur/><feOffset/>'), limits: { maxFilterPrimitives: 1 } },
    { name: 'filter region', svg: wrap('<filter x="11"/>'), limits: { maxFilterRegion: 10 } },
    { name: 'filter region percent', svg: wrap('<filter width="11%"/>'), limits: { maxFilterRegionPercent: 10 } },
    { name: 'std deviation', svg: wrap('<feGaussianBlur stdDeviation="2"/>'), limits: { maxStdDeviation: 1 } },
    { name: 'kernel entries', svg: wrap('<feConvolveMatrix order="2"/>'), limits: { maxKernelEntries: 1 } },
    { name: 'turbulence octaves', svg: wrap('<feTurbulence numOctaves="2"/>'), limits: { maxTurbulenceOctaves: 1 } },
  ];

  for (const entry of cases) {
    const limits: SvgLimits = { ...SVG_POLICY_LIMITS, ...entry.limits };
    const inspection = inspectSvg(Buffer.from(entry.svg), limits);
    if (inspection.ok) assert.fail(`${entry.name}: the budget accepted its boundary document`);
    assert.equal(inspection.refusal.reason, 'svg-workload', `${entry.name}: ${inspection.refusal.detail}`);
  }

  const distinct = inspectSvg(Buffer.from(wrap('<text>ab</text>')), {
    ...SVG_POLICY_LIMITS,
    maxDistinctTextCharacters: 1,
  });
  if (!distinct.ok) assert.fail(`distinct characters: the policy refused before the font probe — ${distinct.refusal.detail}`);
  const characters = requiredCharacters(distinct.source, { ...SVG_POLICY_LIMITS, maxDistinctTextCharacters: 1 });
  assert.ok(!Array.isArray(characters), 'the distinct-character budget accepted its boundary document');
  assert.equal(characters.reason, 'svg-workload');

  const oversized = await prepareSvg(Buffer.from('<svg/>'), { ...SVG_RENDER_LIMITS, maxSourceBytes: 5 });
  if (oversized.ok) assert.fail('the source-byte budget accepted an oversized document');
  assert.equal(oversized.reason, 'too-large');
});

test('only Unicode cmap records count as coverage', () => {
  // One format-0 subtable under a Macintosh (1,0) record: the old scan indexed
  // its byte 0xE9 as U+00E9 and reported a glyph Pango would never draw.
  const cmap = Buffer.alloc(12 + 6 + 256);
  cmap.writeUInt16BE(0, 0);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(1, 4);
  cmap.writeUInt16BE(0, 6);
  cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(0, 12);
  cmap.writeUInt16BE(6 + 256, 14);
  cmap.writeUInt16BE(0, 16);
  cmap[12 + 6 + 0xe9] = 1;
  assert.equal(coveredByCmap(cmap, 0xe9), false, 'a Macintosh cmap record counted as Unicode coverage');
  cmap.writeUInt16BE(0, 4); // platform 0, Unicode
  assert.equal(coveredByCmap(cmap, 0xe9), true, 'a Unicode cmap record no longer counts as coverage');
});

test('Unicode format characters are not required glyphs', () => {
  // U+200E (left-to-right mark) draws nothing; without \p{Cf} it would be
  // required from the host font set and could fail a valid label.
  const inspection = inspectSvg(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text>a\u200eb</text></svg>`),
  );
  if (!inspection.ok) assert.fail(`the policy refused a format character: ${inspection.refusal.detail}`);
  assert.deepEqual(requiredCharacters(inspection.source), ['a', 'b']);
});

test('the same SVG referenced twice publishes one asset, and editing it rebinds', async () => {
  await scratch('svg-dedupe-', async (directories) => {
    putBytes(directories.content, 'assets/shared.svg', fixture('benign', 'shared.svg'));
    putDirectory(directories.content, 'a.md', '# A\n\n![one](assets/shared.svg)\n');
    putDirectory(directories.content, 'b.md', '# B\n\nAgain ![two](assets/shared.svg)\n');
    putDirectory(directories.content, 'c.md', '# C\n\nAn Obsidian embed: ![[assets/shared.svg]]\n');

    const first = await produce(directories);
    const assets = first.artifact.assets ?? [];
    assert.equal(assets.length, 1, `three references published ${assets.length} assets`);
    assert.equal(first.staged.size, 1, 'the staged directory holds more than one asset');
    const firstUrl = assets[0]!.url;
    for (const slug of ['a', 'b', 'c']) {
      assert.match(
        first.markdown.get(slug)!,
        new RegExp(`\\]\\(${firstUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`),
        `${slug}.md did not receive the one published URL`,
      );
    }

    // A visible edit changes the pixels, so the digest — and therefore the URL —
    // must change rather than the old asset being reused.
    const edited = fixture('benign', 'shared.svg').toString('utf8').replace('#86c8e6', '#f08c8c');
    putBytes(directories.content, 'assets/shared.svg', Buffer.from(edited));
    const second = await produce(directories);
    const editedAssets = second.artifact.assets ?? [];
    assert.equal(editedAssets.length, 1, 'the edited SVG published more than one asset');
    assert.notEqual(editedAssets[0]!.url, firstUrl, 'the edited SVG kept the old content-addressed URL');
    assert.ok(!second.staged.has(firstUrl.slice(firstUrl.lastIndexOf('/') + 1)), 'the old asset survived the edit');
  });
});

test('two clean renders of one document emit identical bytes', async () => {
  for (const name of BENIGN) {
    const bytes = fixture('benign', name);
    const first = await prepareSvg(bytes);
    const second = await prepareSvg(bytes);
    if (!first.ok) assert.fail(`${name}: ${first.reason} ${first.detail ?? ''}`);
    if (!second.ok) assert.fail(`${name}: ${second.reason} ${second.detail ?? ''}`);
    assert.deepEqual(first.image.bytes, second.image.bytes, `${name}: repeated renders differ`);
    assert.deepEqual(first.image.dimensions, second.image.dimensions, `${name}: repeated dimensions differ`);
  }
});

test('the CSS checker reads escaped URLs as the parser decodes them', () => {
  // The document bytes contain no `javascript:` and no `http://`: the rejection
  // is evidence that the parser decoded the escape, not that a text scan found a
  // literal.
  const escaped = String.raw`rect { fill: url("\6a avascript:alert(1)"); }`;
  assert.ok(!escaped.includes('javascript:'), 'the fixture itself contains the literal the gate must not rely on');
  assert.equal(inspectStyleSheet(escaped)?.reason, 'svg-script');

  const escapedNetwork = String.raw`rect { fill: url(http\3a //example.invalid/x.png); }`;
  assert.ok(!escapedNetwork.includes('http://'), 'the fixture itself contains the literal scheme');
  assert.equal(inspectStyleSheet(escapedNetwork)?.reason, 'svg-external');

  // The same AST check covers the other two doors CSS arrives through.
  assert.equal(inspectStyleAttribute('fill: url(https://example.invalid/x.png)')?.reason, 'svg-external');
  assert.equal(inspectStyleAttribute('fill: url(#grad)')?.reason, undefined);
  assert.equal(inspectPresentationAttribute('fill', 'url(#grad)')?.reason, undefined);
  assert.equal(inspectPresentationAttribute('filter', 'url(../outside.svg#f)')?.reason, 'svg-external');
  assert.equal(
    inspectStyleSheet('rect { fill: url("data:image/png;base64,AAAA"); }')?.reason,
    'svg-data',
    'an embedded data: URL in CSS was not named',
  );

  // `href` and `xlink:href` get one function, so they cannot drift.
  const href = fixture('hostile', 'network.svg');
  const inspection = inspectSvg(href);
  if (inspection.ok) assert.fail('the policy accepted a network reference');
  assert.match(inspection.refusal.detail, /image@href|use@xlink:href/);
});

test('CJK and small Latin text are rendered as ink, not as a blank or a hex box', async () => {
  for (const name of ['cjk-text.svg', 'small-text.svg', 'latin-text.svg']) {
    const result = await prepareSvg(fixture('benign', name));
    if (!result.ok) assert.fail(`${name}: ${result.reason} ${result.detail ?? ''}`);
    const { data, info } = await sharp(result.image.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let dark = 0;
    let light = 0;
    for (let index = 0; index < data.length; index += info.channels) {
      const alpha = info.channels === 4 ? data[index + 3]! : 255;
      if (alpha === 0) continue;
      const luminance = 0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!;
      if (luminance < 80) dark += 1;
      if (luminance > 240) light += 1;
    }
    assert.ok(dark > 200, `${name}: only ${dark} dark pixels — the labels did not draw`);
    assert.ok(light > 200, `${name}: only ${light} light pixels — the page did not draw`);
  }

  const covered = missingCodePoints([0x6784]);
  assert.deepEqual(covered.missing, [], 'the host has no font for 构');
  assert.ok(covered.fonts > 0, 'no font files were discovered');
});

test('an ink count cannot distinguish a hex box from a glyph', async () => {
  // This is why the gate above is `missingCodePoints`, not an ink test: Pango's
  // tofu box has ink. Render a missing code point directly, bypassing the policy,
  // and prove the same dark/light measurement sees it.
  const missing = missingCodePoints([0x10fffd]).missing;
  assert.ok(missing.length > 0, 'this host covers U+10FFFD; the control cannot be exercised');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><text x="8" y="48" font-size="24">&#x10fffd;</text></svg>`;
  const { data, info } = await sharp(Buffer.from(svg), { density: 144 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    if ((info.channels === 4 ? data[index + 3]! : 255) === 0) continue;
    if (0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]! < 80) dark += 1;
  }
  assert.ok(dark > 0, 'the tofu control drew no ink; the measurement is not exercising the hex box');
});

test('a document using a code point the host cannot draw fails with its own diagnostic', async () => {
  const candidates = [0x10fffd, 0x10fffe, 0x10ffff];
  const missing = missingCodePoints(candidates).missing;
  assert.ok(missing.length > 0, 'this host covers every candidate code point; the gate cannot be exercised');
  const codePoint = missing[0]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><text x="8" y="48" font-size="24">&#x${codePoint.toString(16)};</text></svg>`;
  const result = await prepareSvg(Buffer.from(svg));
  if (result.ok) assert.fail('the renderer accepted text this host cannot draw');
  assert.equal(result.reason, 'svg-font');
  assert.match(result.detail ?? '', /no installed font covers U\+[0-9A-F]+/i);

  await scratch('svg-font-', async (directories) => {
    putBytes(directories.content, 'assets/unknown.svg', Buffer.from(svg));
    putDirectory(directories.content, 'page.md', '# Page\n\n![label](assets/unknown.svg)\n');
    const failure = await refusalFrom(directories);
    assert.match(failure.detail, /svg-font: no installed font covers/);
    assert.ok(!failure.message.includes('U+'), 'the public message carried the private code point');
  });
});

test('a UTF-16 document is reported unsupported, not parsed', async () => {
  const text =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#8ad884"/></svg>';
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(looksLikeSvg(bytes), false, 'the signature accepted UTF-16');
  assert.equal(inspectSvg(bytes).ok, false, 'the policy parsed a UTF-16 document');

  await scratch('svg-utf16-', async (directories) => {
    putBytes(directories.content, 'assets/vector.svg', bytes);
    putDirectory(directories.content, 'page.md', '# Page\n\n![utf16](assets/vector.svg)\n');
    const failure = await refusalFrom(directories);
    assert.match(failure.detail, /\(unsupported\)/, `UTF-16 was not unsupported: ${failure.detail}`);
  });
});

test('a malformed document that is not recognisably SVG is still an unsupported file', async () => {
  const bytes = Buffer.from('this is prose, not pixels\n');
  assert.equal(looksLikeSvg(bytes), false, 'a prose file matched the SVG signature');
  assert.equal(inspectSvg(bytes).ok, false);
  assert.equal(sniffImageFormat(bytes), undefined);

  await scratch('svg-unsupported-', async (directories) => {
    putBytes(directories.content, 'assets/vector.svg', bytes);
    putDirectory(directories.content, 'page.md', '# Page\n\n![prose](assets/vector.svg)\n');
    const failure = await refusalFrom(directories);
    assert.match(failure.detail, /\(unsupported\)/, `the prose file was not classified as unsupported: ${failure.detail}`);
  });
});
