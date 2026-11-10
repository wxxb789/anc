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
  'nested-style.svg': { reason: 'svg-css' },
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
    { name: 'use instances', svg: wrap('<use href="#a"/>'), limits: { maxUseInstances: 0 } },
    { name: 'text characters', svg: wrap('<text>ab</text>'), limits: { maxTextCharacters: 1 } },
    { name: 'style element', svg: wrap('<style>rect{fill:red}</style>'), limits: { maxStyleCharacters: 1 } },
    { name: 'style attribute', svg: wrap('<rect style="fill:red"/>'), limits: { maxStyleCharacters: 1 } },
    { name: 'filter primitives', svg: wrap('<feGaussianBlur/><feOffset/>'), limits: { maxFilterPrimitives: 1 } },
    {
      name: 'filter region',
      svg: wrap('<filter filterUnits="userSpaceOnUse" x="11"/>'),
      limits: { maxFilterRegion: 10 },
    },
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

test('a filter region is judged in the coordinate system its element declares', async () => {
  const wrap = (body: string): Buffer =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">${body}</svg>`);
  const filtered = (filter: string): Buffer =>
    wrap(`<defs>${filter}</defs><rect width="120" height="120" fill="#8ad884" filter="url(#f)"/>`);

  // The default is objectBoundingBox: `6` is a fraction of the box, 600%, not
  // six user units. The percentage spelling of the same surface already refuses.
  const fraction = inspectSvg(filtered('<filter id="f" width="6" height="6"><feGaussianBlur stdDeviation="1"/></filter>'));
  if (fraction.ok) assert.fail('a 600% bounding-box filter region was accepted');
  assert.equal(fraction.refusal.reason, 'svg-workload');
  const percent = inspectSvg(filtered('<filter id="f" width="600%" height="600%"><feGaussianBlur stdDeviation="1"/></filter>'));
  if (percent.ok) assert.fail('a 600% filter region was accepted');
  assert.equal(percent.refusal.reason, 'svg-workload');

  // A 100% region is the object's own box and stays renderable.
  const accepted = filtered('<filter id="f" width="1" height="1"><feGaussianBlur stdDeviation="1"/></filter>');
  const inspection = inspectSvg(accepted);
  if (!inspection.ok) assert.fail(`a 100% bounding-box filter region was refused: ${inspection.refusal.detail}`);
  const rendered = await prepareSvg(accepted);
  if (!rendered.ok) assert.fail(`a 100% bounding-box filter region did not render: ${rendered.reason}`);
  assert.deepEqual(rendered.image.dimensions, { width: 240, height: 240 });

  // userSpaceOnUse switches unitless numbers back to user units; a side at the
  // 20,000-unit ceiling is refused just as its percentage spelling is.
  const userUnits = inspectSvg(
    filtered('<filter id="f" filterUnits="userSpaceOnUse" width="20000" height="20000"><feGaussianBlur stdDeviation="1"/></filter>'),
  );
  if (userUnits.ok) assert.fail('a 20,000-user-unit filter region was accepted');
  assert.equal(userUnits.refusal.reason, 'svg-workload');

  // A primitive subregion is governed by the parent filter's primitiveUnits.
  const primitive = inspectSvg(
    filtered('<filter id="f" primitiveUnits="objectBoundingBox"><feGaussianBlur stdDeviation="1" width="6" height="6"/></filter>'),
  );
  if (primitive.ok) assert.fail('a 600% bounding-box primitive region was accepted');
  assert.equal(primitive.refusal.reason, 'svg-workload');
  const primitiveAccepted = filtered(
    '<filter id="f" primitiveUnits="objectBoundingBox"><feGaussianBlur stdDeviation="1" width="1" height="1"/></filter>',
  );
  const primitiveInspection = inspectSvg(primitiveAccepted);
  if (!primitiveInspection.ok) {
    assert.fail(`a 100% bounding-box primitive region was refused: ${primitiveInspection.refusal.detail}`);
  }
  const primitiveRendered = await prepareSvg(primitiveAccepted);
  if (!primitiveRendered.ok) assert.fail(`a 100% bounding-box primitive region did not render: ${primitiveRendered.reason}`);
});

/** The symbols of a legal chain, each referencing the next twice. */
function symbolChain(levels: number, href = 'href', leaf = '<rect width="2" height="2"/>'): string {
  const symbols = [`<symbol id="s${levels - 1}">${leaf}</symbol>`];
  for (let index = levels - 2; index >= 0; index -= 1) {
    symbols.push(
      `<symbol id="s${index}"><use ${href}="#s${index + 1}"/><use ${href}="#s${index + 1}"/></symbol>`,
    );
  }
  return symbols.join('');
}

/** A legal chain of symbols, each referencing the next twice. */
function useChain(levels: number, href = 'href', rootAttributes = ''): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${rootAttributes} width="100" height="100">` +
    `<defs>${symbolChain(levels, href)}</defs><use ${href}="#s0"/></svg>`
  );
}

test('the use expansion budget refuses a small document that would render 2^17 instances', async () => {
  // 17 chained symbols and 33 <use> declarations are 1 KB of XML, but they expand
  // to 131,071 instances. Measured before the budget: 1,146 ms on this host
  // (the reviewer measured 2.4 s for the same shape); 2^16 was 581 ms and 2^14,
  // the largest accepted chain, 177 ms. The cap is 16,384 instances.
  const refused = inspectSvg(Buffer.from(useChain(17)));
  if (refused.ok) assert.fail('the use-expansion budget accepted 131,071 instances');
  assert.equal(refused.refusal.reason, 'svg-workload');
  assert.match(refused.refusal.detail, /131071/, `the refusal did not report the count: ${refused.refusal.detail}`);

  const accepted = inspectSvg(Buffer.from(useChain(14)));
  if (!accepted.ok) assert.fail(`the budget refused its largest legitimate chain: ${accepted.refusal.detail}`);

  const oneSided = `<svg xmlns="http://www.w3.org/2000/svg" width="200" viewBox="0 0 100 50"><rect width="100" height="50" fill="#8ad884"/></svg>`;
  const inferred = inspectSvg(Buffer.from(oneSided));
  if (!inferred.ok) assert.fail(`one declared side plus a viewBox was refused: ${inferred.refusal.detail}`);
  assert.deepEqual(
    { width: inferred.source.width, height: inferred.source.height },
    { width: 200, height: 100 },
    'the viewBox did not infer the missing side',
  );
  const rendered = await prepareSvg(Buffer.from(oneSided));
  if (!rendered.ok) assert.fail(`the one-sided document did not render: ${rendered.reason}`);
  assert.deepEqual(rendered.image.dimensions, { width: 400, height: 200 });
  assert.deepEqual(rendered.image.displayDimensions, { width: 200, height: 100 });
});

test('the use expansion budget resolves href by namespace, not by prefix', async () => {
  const alternateNamespace = 'xmlns:l="http://www.w3.org/1999/xlink"';
  const defaultRefused = inspectSvg(Buffer.from(useChain(17)));
  const alternateRefused = inspectSvg(Buffer.from(useChain(17, 'l:href', alternateNamespace)));
  if (defaultRefused.ok) assert.fail('the default-prefix chain was accepted');
  if (alternateRefused.ok) assert.fail('the alternate-prefix chain bypassed the expansion budget');
  assert.equal(defaultRefused.refusal.reason, 'svg-workload');
  assert.equal(alternateRefused.refusal.reason, 'svg-workload');
  assert.match(defaultRefused.refusal.detail, /131071/);
  assert.match(alternateRefused.refusal.detail, /131071/);
  assert.equal(
    alternateRefused.refusal.detail,
    defaultRefused.refusal.detail,
    'the alternate prefix reached a different count than the default spelling',
  );

  // The same namespace binding must not reject a legitimate use chain. This
  // renders through librsvg, so it proves resolution reached the renderer as
  // well as the counter.
  const positive = await prepareSvg(Buffer.from(useChain(2, 'l:href', alternateNamespace)));
  if (!positive.ok) assert.fail(`the alternate-prefix control was refused: ${positive.reason} ${positive.detail ?? ''}`);
  assert.deepEqual(positive.image.dimensions, { width: 200, height: 200 });
});

/**
 * The 17-level chain inside one definition container, reached from drawn content.
 *
 * The container itself is not drawn; the `<rect>` or `<path>` beside it is, and
 * its reference makes the container's `<use>` chain render.
 */
function referencedChain(container: string, drawn: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">` +
    `<defs>${symbolChain(17)}${container}</defs>${drawn}</svg>`
  );
}

/** One definition family and the drawn element that reaches it. */
const REFERENCE_FAMILIES: Readonly<Record<string, { readonly container: string; readonly drawn: string }>> = {
  mask: {
    container: '<mask id="d"><use href="#s0"/></mask>',
    drawn: '<rect width="100" height="100" mask="url(#d)"/>',
  },
  pattern: {
    container: '<pattern id="d" width="10" height="10"><use href="#s0"/></pattern>',
    drawn: '<rect width="100" height="100" fill="url(#d)"/>',
  },
  clipPath: {
    container: '<clipPath id="d"><use href="#s0"/></clipPath>',
    drawn: '<rect width="100" height="100" clip-path="url(#d)"/>',
  },
  marker: {
    container: '<marker id="d"><use href="#s0"/></marker>',
    drawn: '<path d="M0 0L10 10" stroke="#161b21" marker-start="url(#d)"/>',
  },
  filter: {
    container: '<filter id="d"><use href="#s0"/></filter>',
    drawn: '<rect width="100" height="100" filter="url(#d)"/>',
  },
};

for (const [family, { container, drawn }] of Object.entries(REFERENCE_FAMILIES)) {
  test(`a drawn reference into ${family} counts the <use> instances it renders`, () => {
    const refused = inspectSvg(Buffer.from(referencedChain(container, drawn)));
    if (refused.ok) assert.fail(`the ${family}-referenced chain bypassed the expansion budget`);
    assert.equal(refused.refusal.reason, 'svg-workload', `${family}: ${refused.refusal.detail}`);
    assert.match(
      refused.refusal.detail,
      /131071/,
      `${family}: the referenced chain reported a different count than the direct spelling: ${refused.refusal.detail}`,
    );
  });
}

test('an unreferenced definition container contributes no use instances', () => {
  const accepted = inspectSvg(
    Buffer.from(referencedChain('<mask id="d"><use href="#s0"/></mask>', '<rect width="100" height="100"/>')),
  );
  assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.refusal.detail);
});

test('a shallow use chain reached through a mask still renders', async () => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">` +
    `<defs>${symbolChain(2)}` +
    `<mask id="m"><rect width="100" height="100" fill="#ffffff"/><use href="#s0"/></mask>` +
    `</defs>` +
    `<rect width="100" height="100" fill="#8ad884" mask="url(#m)"/>` +
    `</svg>`;
  const inspection = inspectSvg(Buffer.from(svg));
  if (!inspection.ok) assert.fail(`the shallow mask-referenced chain was refused: ${inspection.refusal.detail}`);
  const rendered = await prepareSvg(Buffer.from(svg));
  if (!rendered.ok) assert.fail(`the shallow mask-referenced chain did not render: ${rendered.reason}`);
  assert.deepEqual(rendered.image.dimensions, { width: 200, height: 200 });
});

/**
 * A 14-level chain inside a mask: 16,383 instances per rendered consumer.
 *
 * 14 levels is the largest chain inside the 16,384-instance budget, so one
 * consumer is legal and two are exactly twice the budget.
 */
function maskChain(body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">` +
    // The chain's leaf is a path so a `rect` selector cannot match it: a shape
    // inside the mask that referenced the mask would be a cycle, not this test.
    `<defs>${symbolChain(14, 'href', '<path d="M0 0h2v2H0z"/>')}` +
    `<mask id="m"><path d="M0 0h100v100H0z" fill="#ffffff"/><use href="#s0"/></mask></defs>` +
    body +
    `</svg>`
  );
}

/** `depth` nested `<g>` elements around `body`. */
function nestedGroups(body: string, depth: number): string {
  return '<g>'.repeat(depth) + body + '</g>'.repeat(depth);
}

/**
 * A pattern holding a `<use>` chain, plus whatever definitions `extra` adds.
 *
 * The chain's leaf is a path so a `rect` selector cannot match it. The XLink
 * namespace is declared even in the SVG 2 spellings: the point of these shapes
 * is that both spellings of the same template edge take the same path.
 */
function patternedChain(body: string, levels: number, extra = ''): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">` +
    `<defs>${symbolChain(levels, 'href', '<path d="M0 0h2v2H0z"/>')}` +
    `<pattern id="p" width="10" height="10"><use href="#s0"/></pattern>${extra}</defs>` +
    body +
    `</svg>`
  );
}

test('a pattern template href is an edge, in both spellings and as repeated content', () => {
  const drawn = '<rect width="100" height="100" fill="url(#alias)"/>';
  const spellings = {
    'repeated content': patternedChain(
      drawn,
      17,
      '<pattern id="alias" width="10" height="10"><use href="#s0"/></pattern>',
    ),
    'xlink:href': patternedChain(drawn, 17, '<pattern id="alias" xlink:href="#p"/>'),
    href: patternedChain(drawn, 17, '<pattern id="alias" href="#p"/>'),
  };
  const details: string[] = [];
  const started = Date.now();
  for (const [name, svg] of Object.entries(spellings)) {
    const inspection = inspectSvg(Buffer.from(svg));
    if (inspection.ok) assert.fail(`${name}: a 17-level pattern alias bypassed the expansion budget`);
    assert.equal(inspection.refusal.reason, 'svg-workload', `${name}: ${inspection.refusal.detail}`);
    assert.match(inspection.refusal.detail, /131071/, `${name}: ${inspection.refusal.detail}`);
    details.push(inspection.refusal.detail);
  }
  assert.ok(Date.now() - started < 5_000, 'the template-edge walk was not linear');
  assert.equal(
    new Set(details).size,
    1,
    'an inherited definition, an XLink alias and an SVG 2 alias counted differently',
  );
});

test('an inherited fill on a group counts like an attribute on each child', () => {
  const children = '<rect width="50" height="100"/><rect x="50" width="50" height="100"/>';
  const spellings = {
    'per-child attribute': patternedChain(
      '<rect width="50" height="100" fill="url(#p)"/><rect x="50" width="50" height="100" fill="url(#p)"/>',
      14,
    ),
    'group attribute': patternedChain(`<g fill="url(#p)">${children}</g>`, 14),
    'group style attribute': patternedChain(`<g style="fill:url(#p)">${children}</g>`, 14),
    'group stylesheet rule': patternedChain(`<style>g{fill:url(#p)}</style><g>${children}</g>`, 14),
  };
  const details: string[] = [];
  const started = Date.now();
  for (const [name, svg] of Object.entries(spellings)) {
    const inspection = inspectSvg(Buffer.from(svg));
    if (inspection.ok) assert.fail(`${name}: a group's inherited fill bypassed the expansion budget`);
    assert.equal(inspection.refusal.reason, 'svg-workload', `${name}: ${inspection.refusal.detail}`);
    assert.match(inspection.refusal.detail, /32766/, `${name}: ${inspection.refusal.detail}`);
    details.push(inspection.refusal.detail);
  }
  assert.ok(Date.now() - started < 5_000, 'the inherited-reference walk was not linear');
  assert.equal(new Set(details).size, 1, 'the four spellings of the same picture counted differently');
});

test('inherited stroke and marker-start references multiply like fill', () => {
  const shapes = '<path d="M0 10h100" fill="none"/><path d="M0 20h100" fill="none"/>';
  const cases = {
    stroke: patternedChain(`<g stroke="url(#p)">${shapes}</g>`, 14),
    'marker-start': patternedChain(`<g marker-start="url(#p)">${shapes}</g>`, 14),
  };
  for (const [name, svg] of Object.entries(cases)) {
    const inspection = inspectSvg(Buffer.from(svg));
    if (inspection.ok) assert.fail(`${name}: an inherited reference on the group was counted once`);
    assert.equal(inspection.refusal.reason, 'svg-workload', `${name}: ${inspection.refusal.detail}`);
    assert.match(inspection.refusal.detail, /32766/, `${name}: ${inspection.refusal.detail}`);
  }
});

test('a nearer declaration suppresses the inherited reference', () => {
  const children = '<rect width="50" height="100"/><rect x="50" width="50" height="100"/>';
  for (const [name, svg] of Object.entries({
    'nearer group': patternedChain(`<g fill="url(#p)"><g fill="none">${children}</g></g>`, 14),
    'own declaration': patternedChain(
      '<g fill="url(#p)"><rect width="50" height="100" fill="none"/>' +
        '<rect x="50" width="50" height="100" fill="none"/></g>',
      14,
    ),
  })) {
    const inspection = inspectSvg(Buffer.from(svg));
    assert.ok(
      inspection.ok,
      `${name}: an overriding declaration did not suppress the reference: ${
        inspection.ok ? '' : inspection.refusal.detail
      }`,
    );
  }
});

test('a CSS-wide keyword does not erase the inherited reference', () => {
  const children =
    '<rect width="50" height="100" fill="inherit"/><rect x="50" width="50" height="100" fill="inherit"/>';
  const cases = {
    attribute: patternedChain(`<g fill="url(#p)">${children}</g>`, 14),
    rule: patternedChain(`<style>rect{fill:inherit}</style><g fill="url(#p)">${children}</g>`, 14),
    'escaped keyword': patternedChain(
      String.raw`<g fill="url(#p)"><rect width="50" height="100" fill="\69 nherit"/><rect x="50" width="50" height="100" fill="\69 nherit"/></g>`,
      14,
    ),
    'escaped property': patternedChain(
      String.raw`<g style="f\69 ll:url(#p)"><rect width="50" height="100"/><rect x="50" width="50" height="100"/></g>`,
      14,
    ),
  };
  for (const [name, svg] of Object.entries(cases)) {
    const inspection = inspectSvg(Buffer.from(svg));
    if (inspection.ok) assert.fail(`${name}: fill:inherit erased the inherited reference`);
    assert.equal(inspection.refusal.reason, 'svg-workload', `${name}: ${inspection.refusal.detail}`);
    assert.match(inspection.refusal.detail, /32766/, `${name}: ${inspection.refusal.detail}`);
  }

  // `initial` is not inheritance: it resolves to the property's initial value.
  const initial = patternedChain(
    '<g fill="url(#p)"><rect width="50" height="100" fill="initial"/>' +
      '<rect x="50" width="50" height="100" fill="initial"/></g>',
    14,
  );
  assert.ok(inspectSvg(Buffer.from(initial)).ok, 'fill:initial was treated as inheritance');
});

test('a value that only parses keeps the inherited reference like inherit does', () => {
  const children = (fill: string): string =>
    `<rect width="50" height="100" fill="${fill}"/>` +
    `<rect x="50" width="50" height="100" fill="${fill}"/>`;
  const cases = {
    'inherited spelling': patternedChain(`<g fill="url(#p)">${children('inherit')}</g>`, 14),
    bogus: patternedChain(`<g fill="url(#p)">${children('bogus')}</g>`, 14),
    transparent: patternedChain(`<g fill="url(#p)">${children('transparent')}</g>`, 14),
    'system colour': patternedChain(`<g fill="url(#p)">${children('Canvas')}</g>`, 14),
    'calc in a colour function': patternedChain(
      `<g fill="url(#p)">${children('rgb(calc(255),0,0)')}</g>`,
      14,
    ),
    'non-whitelisted colour function': patternedChain(
      `<g fill="url(#p)">${children('hwb(0 0% 0%)')}</g>`,
      14,
    ),
    'escaped keyword': patternedChain(`<g fill="url(#p)">${children(String.raw`\72 ed`)}</g>`, 14),
    'style attribute': patternedChain(
      `<g fill="url(#p)">` +
        '<rect width="50" height="100" style="fill:bogus"/>' +
        '<rect x="50" width="50" height="100" style="fill:bogus"/></g>',
      14,
    ),
    stylesheet: patternedChain(
      `<style>rect{fill:bogus}</style><g fill="url(#p)">` +
        '<rect width="50" height="100"/><rect x="50" width="50" height="100"/></g>',
      14,
    ),
  };
  const details: string[] = [];
  for (const [name, svg] of Object.entries(cases)) {
    const inspection = inspectSvg(Buffer.from(svg));
    if (inspection.ok) assert.fail(`${name}: an unproven paint erased the inherited pattern reference`);
    assert.equal(inspection.refusal.reason, 'svg-workload', `${name}: ${inspection.refusal.detail}`);
    assert.match(inspection.refusal.detail, /32766/, `${name}: ${inspection.refusal.detail}`);
    details.push(inspection.refusal.detail);
  }
  assert.equal(
    new Set(details).size,
    1,
    'an invalid paint and an inherited keyword counted the same picture differently',
  );
});

test('a provable non-reference paint suppresses the inherited pattern', () => {
  const values = [
    '#f00',
    'none',
    'rgb(255,0,0)',
    'rgba(255,0,0,.5)',
    'rgb(255 0 0 / 50%)',
    'hsl(0deg 100% 50%)',
    'currentColor',
    'red',
    'rebeccapurple',
    'initial',
  ];
  for (const value of values) {
    const svg = patternedChain(
      `<g fill="url(#p)"><rect width="50" height="100" fill="${value}"/>` +
        `<rect x="50" width="50" height="100" fill="${value}"/></g>`,
      14,
    );
    const inspection = inspectSvg(Buffer.from(svg));
    assert.ok(
      inspection.ok,
      `${value}: a non-reference paint did not suppress the pattern: ${inspection.ok ? '' : inspection.refusal.detail}`,
    );
  }

  // The same whitelist through the two CSS doors, so a rule cannot count
  // differently from the presentation attribute spelling.
  const spellings = {
    'style attribute': patternedChain(
      `<g fill="url(#p)">` +
        '<rect width="50" height="100" style="fill:currentColor"/>' +
        '<rect x="50" width="50" height="100" style="fill:currentColor"/></g>',
      14,
    ),
    stylesheet: patternedChain(
      `<style>rect{fill:rgb(255,0,0)}</style><g fill="url(#p)">` +
        '<rect width="50" height="100"/><rect x="50" width="50" height="100"/></g>',
      14,
    ),
  };
  for (const [name, svg] of Object.entries(spellings)) {
    const inspection = inspectSvg(Buffer.from(svg));
    assert.ok(
      inspection.ok,
      `${name}: a non-reference paint did not suppress the pattern: ${
        inspection.ok ? '' : inspection.refusal.detail
      }`,
    );
  }
});

test('an explicit inherit on a local reference property is refused as svg-css', () => {
  const properties = ['mask', 'filter', 'clip-path'];
  const bodies: Readonly<Record<string, (property: string) => string>> = {
    attribute: (property) => `<rect width="100" height="100" ${property}="inherit"/>`,
    'style attribute': (property) =>
      `<rect width="100" height="100" style="${property}:inherit"/>`,
    stylesheet: (property) =>
      `<style>rect{${property}:inherit}</style><rect width="100" height="100"/>`,
  };
  for (const property of properties) {
    for (const [spelling, body] of Object.entries(bodies)) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">` + body(property) + `</svg>`;
      const inspection = inspectSvg(Buffer.from(svg));
      if (inspection.ok) assert.fail(`${property} in a ${spelling}: an explicit inherit was accepted`);
      assert.equal(inspection.refusal.reason, 'svg-css', `${property} in a ${spelling}: ${inspection.refusal.detail}`);
      assert.ok(
        inspection.refusal.detail.includes(property),
        `${property} in a ${spelling}: the refusal does not name the property: ${inspection.refusal.detail}`,
      );
      assert.ok(
        inspection.refusal.detail.includes('inherit'),
        `${property} in a ${spelling}: the refusal does not name the keyword: ${inspection.refusal.detail}`,
      );
    }
  }
});

test('a use inherits its own paint reference into the content it instantiates', () => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">` +
    `<defs>${symbolChain(14, 'href', '<path d="M0 0h2v2H0z"/>')}` +
    `<pattern id="p" width="10" height="10"><use href="#s0"/></pattern>` +
    `<symbol id="t"><rect width="50" height="100"/><rect x="50" width="50" height="100"/></symbol></defs>` +
    `<g fill="url(#p)"><use href="#t"/></g></svg>`;
  const inspection = inspectSvg(Buffer.from(svg));
  if (inspection.ok) assert.fail('a reference inherited through <use> was counted once instead of per painted child');
  assert.equal(inspection.refusal.reason, 'svg-workload', inspection.refusal.detail);
  assert.match(inspection.refusal.detail, /32767/, inspection.refusal.detail);
});

test('a shallow inherited reference still renders through librsvg', async () => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">` +
    `<defs>` +
    `<linearGradient id="g"><stop offset="0" stop-color="#8ad884"/><stop offset="1" stop-color="#86c8e6"/></linearGradient>` +
    `<symbol id="dot"><circle cx="5" cy="5" r="5"/></symbol>` +
    `</defs>` +
    `<g fill="url(#g)"><rect width="100" height="100"/><use href="#dot" x="10" y="10"/></g>` +
    `</svg>`;
  const inspection = inspectSvg(Buffer.from(svg));
  if (!inspection.ok) assert.fail(`a shallow inherited fill was refused: ${inspection.refusal.detail}`);
  const rendered = await prepareSvg(Buffer.from(svg));
  if (!rendered.ok) assert.fail(`a shallow inherited fill did not render: ${rendered.reason} ${rendered.detail ?? ''}`);
  assert.deepEqual(rendered.image.dimensions, { width: 200, height: 200 });
});

test('a stylesheet reference is counted once per matched element, like the attribute spelling', () => {
  const attribute = maskChain(
    '<rect width="100" height="100" mask="url(#m)"/><rect width="100" height="100" mask="url(#m)"/>',
  );
  const stylesheet = maskChain(
    '<style>rect{mask:url(#m)}</style><rect width="100" height="100"/><rect width="100" height="100"/>',
  );

  const fromAttribute = inspectSvg(Buffer.from(attribute));
  if (fromAttribute.ok) assert.fail('the attribute spelling accepted 32,766 instances');
  assert.equal(fromAttribute.refusal.reason, 'svg-workload');
  assert.match(fromAttribute.refusal.detail, /32766/, fromAttribute.refusal.detail);

  const fromStylesheet = inspectSvg(Buffer.from(stylesheet));
  if (fromStylesheet.ok) {
    assert.fail('the stylesheet spelling counted its reference once instead of once per matched element');
  }
  assert.equal(fromStylesheet.refusal.reason, 'svg-workload');
  assert.match(fromStylesheet.refusal.detail, /32766/, fromStylesheet.refusal.detail);
  assert.equal(
    fromStylesheet.refusal.detail,
    fromAttribute.refusal.detail,
    'the two spellings of the same picture produced different counts',
  );
});

test('a one-consumer stylesheet reference stays inside the budget and renders', async () => {
  const svg = maskChain(
    '<style>rect{mask:url(#m)}</style><rect width="100" height="100" fill="#8ad884"/>',
  );
  const inspection = inspectSvg(Buffer.from(svg));
  if (!inspection.ok) assert.fail(`the one-consumer stylesheet was refused: ${inspection.refusal.detail}`);
  const rendered = await prepareSvg(Buffer.from(svg));
  if (!rendered.ok) assert.fail(`the one-consumer stylesheet did not render: ${rendered.reason}`);
  assert.deepEqual(rendered.image.dimensions, { width: 200, height: 200 });
});

test('a stylesheet rule that matches no element contributes no reference', () => {
  const svg = maskChain(
    '<style>.absent{mask:url(#m)}</style><rect width="100" height="100" mask="url(#m)"/>',
  );
  const inspection = inspectSvg(Buffer.from(svg));
  assert.equal(inspection.ok, true, inspection.ok ? '' : inspection.refusal.detail);
});

test('class- and id-selected rules count like the type-selected one', () => {
  const byClass = maskChain(
    '<style>.shape{mask:url(#m)}</style>' +
      '<rect width="100" height="100" class="shape"/><rect width="100" height="100" class="shape"/>',
  );
  const byId = maskChain(
    '<style>#same{mask:url(#m)}</style>' +
      '<rect width="100" height="100" id="same"/><rect width="100" height="100" id="same"/>',
  );
  for (const [name, svg] of [['class', byClass], ['id', byId]] as const) {
    const inspection = inspectSvg(Buffer.from(svg));
    if (inspection.ok) assert.fail(`the ${name}-selected rule counted one reference instead of two`);
    assert.equal(inspection.refusal.reason, 'svg-workload', `${name}: ${inspection.refusal.detail}`);
    assert.match(inspection.refusal.detail, /32766/, `${name}: ${inspection.refusal.detail}`);
  }
});

test('two declarations naming the same definition count twice on one matched element', () => {
  const svg = maskChain(
    '<style>rect{mask:url(#m);filter:url(#m)}</style><rect width="100" height="100"/>',
  );
  const inspection = inspectSvg(Buffer.from(svg));
  if (inspection.ok) assert.fail('two declarations naming the mask were counted once');
  assert.equal(inspection.refusal.reason, 'svg-workload', inspection.refusal.detail);
  assert.match(inspection.refusal.detail, /32766/, inspection.refusal.detail);
});

test('a selector list applies one rule once to an element that matches twice', () => {
  const svg = maskChain(
    '<style>.shape, rect{mask:url(#m)}</style>' +
      '<rect width="100" height="100" class="shape"/><rect width="100" height="100" class="shape"/>',
  );
  const inspection = inspectSvg(Buffer.from(svg));
  if (inspection.ok) assert.fail('the selector list was accepted');
  assert.equal(inspection.refusal.reason, 'svg-workload');
  assert.match(inspection.refusal.detail, /32766/, inspection.refusal.detail);
});

test('descendant and child selectors attribute a reference to their subject', () => {
  for (const selector of ['g rect', 'g > rect']) {
    const svg = maskChain(
      `<style>${selector}{mask:url(#m)}</style>` +
        '<g><rect width="100" height="100"/></g><g><rect width="100" height="100"/></g>',
    );
    const inspection = inspectSvg(Buffer.from(svg));
    if (inspection.ok) assert.fail(`the ${JSON.stringify(selector)} selector was not attributed`);
    assert.equal(inspection.refusal.reason, 'svg-workload', `${selector}: ${inspection.refusal.detail}`);
    assert.match(inspection.refusal.detail, /32766/, `${selector}: ${inspection.refusal.detail}`);
  }
});

test('a long descendant selector is matched in polynomial time', () => {
  // The shapes measured against the recursive matcher: 698 ms, 16.6 s and
  // 59.7 s. A regression to path enumeration exceeds the guard on the last two,
  // while the fixed set propagation stays in single-digit milliseconds.
  const shapes: readonly (readonly [number, number])[] = [
    [32, 8],
    [32, 12],
    [40, 10],
  ];
  for (const [depth, steps] of shapes) {
    const selector = ['missing', ...Array.from({ length: steps }, () => 'g'), 'rect'].join(' ');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
      `<defs><mask id="m"><path d="M0 0h10v10H0z" fill="#ffffff"/></mask>` +
      `<symbol id="s"><path d="M0 0h2v2H0z"/></symbol></defs>` +
      `<style>${selector}{mask:url(#m)}</style>` +
      nestedGroups('<rect width="10" height="10"/>', depth) +
      // Attribution runs only for a document that also expands a <use>.
      `<use href="#s"/>` +
      `</svg>`;
    const started = Date.now();
    const inspection = inspectSvg(Buffer.from(svg));
    const elapsed = Date.now() - started;
    if (!inspection.ok) {
      assert.fail(`depth ${depth}, ${steps} steps: a non-matching selector refused the document: ${inspection.refusal.detail}`);
    }
    assert.ok(elapsed < 5_000, `depth ${depth}, ${steps} steps: matching took ${elapsed} ms`);
  }
});

test('a long matching descendant selector counts like its single compound', () => {
  const depth = 32;
  const selector = [...Array.from({ length: depth }, () => 'g'), 'rect'].join(' ');
  const shapes = '<rect width="100" height="100"/><rect width="100" height="100"/>';
  const descendant = inspectSvg(
    Buffer.from(
      maskChain(`<style>${selector}{mask:url(#m)}</style>` + nestedGroups(shapes, depth)),
    ),
  );
  const compound = inspectSvg(
    Buffer.from(maskChain(`<style>rect{mask:url(#m)}</style>` + nestedGroups(shapes, depth))),
  );
  const details: string[] = [];
  for (const [name, inspection] of [
    ['descendant', descendant],
    ['compound', compound],
  ] as const) {
    if (inspection.ok) assert.fail(`the ${name} selector counted one reference instead of two`);
    assert.equal(inspection.refusal.reason, 'svg-workload', `${name}: ${inspection.refusal.detail}`);
    assert.match(inspection.refusal.detail, /32766/, `${name}: ${inspection.refusal.detail}`);
    details.push(inspection.refusal.detail);
  }
  assert.equal(
    details[0],
    details[1],
    'the descendant selector and the equivalent compound counted different instances',
  );
});

test('a selector form the policy cannot attribute is refused, never dropped', () => {
  const cases: readonly { readonly name: string; readonly selector: string; readonly construct: RegExp }[] = [
    { name: 'attribute selector', selector: 'rect[fill]', construct: /an attribute selector/ },
    { name: 'pseudo-class', selector: 'rect:hover', construct: /the pseudo-class ':hover'/ },
    { name: 'pseudo-element', selector: 'rect::before', construct: /the pseudo-element '::before'/ },
    { name: 'adjacent sibling', selector: 'g + g', construct: /adjacent-sibling/ },
    { name: 'general sibling', selector: 'g ~ g', construct: /general-sibling/ },
    { name: 'namespace', selector: 'svg|rect', construct: /namespace-qualified/ },
    { name: 'escaped identifier', selector: '.a\\:b', construct: /escaped identifier/ },
  ];
  for (const entry of cases) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
      `<style>${entry.selector}{mask:url(#m)}</style><rect width="10" height="10"/></svg>`;
    const inspection = inspectSvg(Buffer.from(svg));
    if (inspection.ok) assert.fail(`${entry.name}: the selector was silently ignored`);
    assert.equal(inspection.refusal.reason, 'svg-css', `${entry.name}: ${inspection.refusal.detail}`);
    assert.match(inspection.refusal.detail, entry.construct, `${entry.name}: ${inspection.refusal.detail}`);
  }
});

test('a namespaced root and nested text keep their actual identity and content', () => {
  const namespaced =
    `<s:svg xmlns:s="http://www.w3.org/2000/svg" width="20" height="20">` +
    `<s:text>A<s:text>CD</s:text></s:text></s:svg>`;
  assert.equal(looksLikeSvg(Buffer.from(namespaced)), true, 'the signature missed a prefixed <svg>');
  const inspection = inspectSvg(Buffer.from(namespaced));
  if (!inspection.ok) assert.fail(`a prefixed root was refused: ${inspection.refusal.detail}`);
  assert.deepEqual(inspection.source.text, ['ACD'], 'nested text lost the inner run or duplicated it');
  assert.deepEqual(requiredCharacters(inspection.source), ['A', 'C', 'D']);

  const processingInstruction = `<?php echo 1; ?><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>`;
  assert.equal(looksLikeSvg(Buffer.from(processingInstruction)), true, 'a prologue hid the root from the signature');
  const refused = inspectSvg(Buffer.from(processingInstruction));
  if (refused.ok) assert.fail('the policy accepted a processing instruction');
  assert.equal(refused.refusal.reason, 'svg-unsafe');

  assert.equal(looksLikeSvg(Buffer.from('<svg/>')), true, 'a self-closing root did not match the signature');
  const noNamespace = inspectSvg(Buffer.from('<svg/>'));
  if (noNamespace.ok) assert.fail('the policy accepted a namespace-less root');
  assert.equal(noNamespace.refusal.reason, 'svg-unsafe');
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
