/**
 * Goal 0011's visual corpus, in a real browser.
 *
 * `tests/media-display.test.ts` proves the reading rules and the encoder rows
 * over small fixtures. This file answers the other half of the goal: that a
 * *representative* page — a CJK/UI screenshot, a thin-line diagram, transparent
 * artwork, a photograph, an EXIF-rotated photograph and both animation forms —
 * still holds its meaning after the policy. The source and the served asset are
 * both decoded by the browser and compared in canvas pixels:
 *
 * - a lossless PNG conversion must have an identical alpha channel and identical
 *   RGB everywhere alpha is visible;
 * - a lossy JPEG conversion is measured as PSNR of visible pixels, with the
 *   qualification threshold the codec tests use;
 * - the oriented photograph must report its displayed dimensions, not the coded
 *   frame;
 * - an exempt animation's served bytes must be the source bytes, with the same
 *   frame count, delays and loop count;
 * - the page must not overflow at 320 px.
 *
 * A "looks smaller" claim never substitutes for this: it measures the picture a
 * reader receives, which is what the goal requires.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import sharp from 'sharp';
import type { Browser, BrowserContext } from 'playwright';

import {
  buildSiteWithMedia,
  removeWorkspace,
  serveDist,
  type BuiltSite,
  type ServedSite,
} from './support/browser-site.ts';
import { diagramSvg, photographicRgb, screenshotSvg, transparentSvg } from '../scripts/media-corpus.ts';

const CORPUS: Record<string, string> = {
  'quality.md': [
    '# Quality',
    '',
    '![A dense CJK and Latin interface screenshot](assets/cjk.png "A caption survives the transcode")',
    '',
    '![A thin-line flow diagram](assets/diagram.png)',
    '',
    '![](assets/alpha.png)',
    '',
    '![A photograph with grain](assets/photo.jpg)',
    '',
    '![An EXIF-rotated photograph](assets/oriented.jpg)',
    '',
    '![An animated GIF](assets/motion.gif)',
    '',
    '![An animated WebP](assets/loop.webp)',
    '',
    '## After the figures',
    '',
    'A paragraph below the images for the narrow-width measurement.',
    '',
  ].join('\n'),
};

interface Fixture {
  readonly bytes: Buffer;
  readonly type: string;
  readonly width: number;
  readonly height: number;
}

let media: Record<string, Buffer>;
/** Keyed by the published stem; the extension is the policy's answer, not a guess. */
let expected: Readonly<Record<string, Fixture>>;
let built: BuiltSite;
let server: ServedSite;
let browser: Browser;
let context: BrowserContext;

/** Six PNG frames, joined through sharp's animation input. */
async function frames(): Promise<Buffer[]> {
  const images: Buffer[] = [];
  for (let frame = 0; frame < 6; frame++) {
    const raw = Buffer.alloc(240 * 160 * 3);
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 240; x++) {
        const index = (y * 240 + x) * 3;
        raw[index] = (x + frame * 20) % 256;
        raw[index + 1] = y;
        raw[index + 2] = frame * 40;
      }
    }
    images.push(await sharp(raw, { raw: { width: 240, height: 160, channels: 3 } }).png().toBuffer());
  }
  return images;
}

/** The published file whose name ends with `-<stem>.<any supported extension>`. */
function assetFor(stem: string): string {
  const name = readdirSync(join(built.dist, '_assets')).find((file) => /-([^/]+)$/.test(file) && file.slice(file.lastIndexOf('-') + 1).startsWith(`${stem}.`));
  assert.ok(name, `the output carries no ${stem} asset`);
  return join(built.dist, '_assets', name);
}

beforeAll(async () => {
  const cjk = await sharp(Buffer.from(screenshotSvg(900, 600))).png({ compressionLevel: 9 }).toBuffer();
  const diagram = await sharp(Buffer.from(diagramSvg(900, 450))).png({ compressionLevel: 9 }).toBuffer();
  const alpha = await sharp(Buffer.from(transparentSvg(600, 400))).png({ compressionLevel: 9 }).toBuffer();
  const photo = await sharp(photographicRgb(900, 600, 0x2468), {
    raw: { width: 900, height: 600, channels: 3 },
  })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const orientedCoded = Buffer.alloc(300 * 450 * 3);
  for (let index = 0; index < orientedCoded.length; index++) orientedCoded[index] = (index * 7) % 256;
  const oriented = await sharp(orientedCoded, { raw: { width: 300, height: 450, channels: 3 } })
    .jpeg({ quality: 92 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const animationFrames = await frames();
  const animGif = await sharp(animationFrames, { join: { animated: true } }).gif().toBuffer();
  const animWebp = await sharp(animationFrames, { join: { animated: true } }).webp({ quality: 70, effort: 4 }).toBuffer();

  media = {
    'assets/cjk.png': cjk,
    'assets/diagram.png': diagram,
    'assets/alpha.png': alpha,
    'assets/photo.jpg': photo,
    'assets/oriented.jpg': oriented,
    'assets/motion.gif': animGif,
    'assets/loop.webp': animWebp,
  };
  expected = {
    cjk: { bytes: cjk, type: 'image/png', width: 900, height: 600 },
    diagram: { bytes: diagram, type: 'image/png', width: 900, height: 450 },
    alpha: { bytes: alpha, type: 'image/png', width: 600, height: 400 },
    photo: { bytes: photo, type: 'image/jpeg', width: 900, height: 600 },
    // Coded 300×450 with Orientation 6; the displayed frame is 450×300.
    oriented: { bytes: oriented, type: 'image/jpeg', width: 450, height: 300 },
    motion: { bytes: animGif, type: 'image/gif', width: 240, height: 160 },
    loop: { bytes: animWebp, type: 'image/webp', width: 240, height: 160 },
  };

  built = buildSiteWithMedia(CORPUS, media);
  server = await serveDist(built.dist);
  // Dynamic on purpose, matching every other browser gate: the file must collect
  // on a host without the browser package, and the failure is `chromium.launch`.
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  context = await browser.newContext({ javaScriptEnabled: false });
}, 300_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.close();
  if (built !== undefined) removeWorkspace(built.workspace);
}, 300_000);

test('the page decodes every transcoded image at its displayed size', async () => {
  const page = await context.newPage();
  await page.goto(`${server.origin}/notes/quality/`, { waitUntil: 'load' });
  for (const image of await page.locator('article img').all()) await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('article img')].every((image) => (image as HTMLImageElement).complete),
  );
  const images = await page.locator('article img').evaluateAll((nodes) =>
    (nodes as HTMLImageElement[]).map((image) => ({
      src: image.getAttribute('src') ?? '',
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      width: image.getAttribute('width'),
      height: image.getAttribute('height'),
      complete: image.complete,
      alt: image.getAttribute('alt'),
    })),
  );
  assert.equal(images.length, 7, `the page rendered ${images.length} images`);
  for (const [stem, size] of Object.entries(expected)) {
    const image = images.find((candidate) => candidate.src.includes(`-${stem}.`));
    assert.ok(image, `the page lost ${stem}`);
    assert.ok(image.complete && image.naturalWidth > 0, `${stem} did not decode`);
    assert.equal(image.naturalWidth, size.width, `${stem}: browser width`);
    assert.equal(image.naturalHeight, size.height, `${stem}: browser height`);
    assert.equal(image.width, String(size.width), `${stem}: width attribute`);
    assert.equal(image.height, String(size.height), `${stem}: height attribute`);
  }
  assert.ok(images.some((image) => image.alt === 'A dense CJK and Latin interface screenshot'));

  await page.setViewportSize({ width: 320, height: 640 });
  const narrow = await page.evaluate(() => ({
    articleClient: (document.querySelector('article.prose') as HTMLElement).clientWidth,
    articleScroll: (document.querySelector('article.prose') as HTMLElement).scrollWidth,
    documentClient: document.documentElement.clientWidth,
    documentScroll: document.documentElement.scrollWidth,
  }));
  assert.ok(narrow.articleScroll <= narrow.articleClient, `the article overflows at 320 px: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.documentScroll <= narrow.documentClient, `the page overflows at 320 px: ${JSON.stringify(narrow)}`);
  await page.close();
});

test('lossless conversions are pixel-identical and the photograph stays legible', async () => {
  const page = await context.newPage();
  await page.goto(`${server.origin}/notes/quality/`, { waitUntil: 'load' });
  const rows: readonly (readonly [string, boolean])[] = [
    ['cjk', true],
    ['diagram', true],
    ['alpha', true],
    ['photo', false],
  ];
  for (const [stem, lossless] of rows) {
    const fixture = expected[stem]!;
    const servedPath = assetFor(stem);
    const assetName = servedPath.slice(servedPath.lastIndexOf('-') + 1);
    const served = readFileSync(servedPath);
    const result = await page.evaluate(
      async ({ servedBase64, sourceBase64, servedType, sourceType }) => {
        const decode = async (base64: string, type: string): Promise<ImageData> => {
          const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context2d = canvas.getContext('2d')!;
          context2d.drawImage(bitmap, 0, 0);
          return context2d.getImageData(0, 0, bitmap.width, bitmap.height);
        };
        const [published, original] = await Promise.all([
          decode(servedBase64, servedType),
          decode(sourceBase64, sourceType),
        ]);
        if (published.width !== original.width || published.height !== original.height) {
          return { sameSize: false, alphaIdentical: false, visibleIdentical: false, psnr: 0 };
        }
        let alphaIdentical = true;
        let visibleIdentical = true;
        let squared = 0;
        let samples = 0;
        for (let index = 0; index < published.data.length; index += 4) {
          if (published.data[index + 3] !== original.data[index + 3]) alphaIdentical = false;
          if (original.data[index + 3] === 0) continue;
          for (let channel = 0; channel < 3; channel++) {
            const delta = published.data[index + channel]! - original.data[index + channel]!;
            if (delta !== 0) visibleIdentical = false;
            squared += delta * delta;
            samples += 1;
          }
        }
        const psnr = samples === 0 ? 0 : 10 * Math.log10((255 * 255) / (squared / samples));
        return { sameSize: true, alphaIdentical, visibleIdentical, psnr };
      },
      {
        servedBase64: served.toString('base64'),
        sourceBase64: fixture.bytes.toString('base64'),
        servedType: assetName.endsWith('.webp') ? 'image/webp' : fixture.type,
        sourceType: fixture.type,
      },
    );
    assert.ok(result.sameSize, `${assetName}: the browser decoded a different size`);
    assert.ok(result.alphaIdentical, `${assetName}: alpha changed`);
    if (lossless) {
      assert.ok(result.visibleIdentical, `${assetName}: a visible pixel changed in a lossless conversion`);
    } else {
      assert.ok(result.psnr > 32, `${assetName}: PSNR ${result.psnr.toFixed(2)} dB is below the qualification floor`);
    }
  }
  await page.close();
});

test('exempt animations are served byte-identically, with frames, delays and loop intact', async () => {
  const cases: readonly (readonly [string, string])[] = [
    ['motion', 'assets/motion.gif'],
    ['loop', 'assets/loop.webp'],
  ];
  for (const [stem, sourcePath] of cases) {
    const servedPath = assetFor(stem);
    const assetName = servedPath.slice(servedPath.lastIndexOf('-') + 1);
    const served = readFileSync(servedPath);
    const source = media[sourcePath]!;
    assert.ok(served.equals(source), `${assetName}: the animation was re-encoded`);
    const before = await sharp(source).metadata();
    const after = await sharp(served).metadata();
    assert.equal(after.pages, before.pages, `${assetName}: frame count changed`);
    assert.deepEqual(after.delay, before.delay, `${assetName}: frame timing changed`);
    assert.equal(after.loop, before.loop, `${assetName}: loop count changed`);
  }
});
