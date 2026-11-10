/**
 * Goal 0012's reading half, in a real browser.
 *
 * The raster tests prove the emitted bytes and dimensions from the producer's
 * side. This file answers the reader's question: does the published WebP decode,
 * lay out at the author's logical size, keep its aspect ratio, and show text as
 * crisp glyphs rather than a blurred or doubled picture?
 *
 * Crispness is measured from a real Chromium screenshot instead of asserted in
 * prose. At `deviceScaleFactor: 1` the browser downsamples the 2× raster to the
 * CSS box; at 2 it maps raster pixels 1:1 to device pixels. Counting strong
 * adjacent-pixel luminance transitions in the text distinguishes resolved glyph
 * edges from an upscale, which spreads one edge over several pixels.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import sharp from 'sharp';
import type { Browser, BrowserContext, Page } from 'playwright';

import {
  buildSiteWithMedia,
  collectPageErrors,
  removeWorkspace,
  serveDist,
  type BuiltSite,
  type ServedSite,
} from './support/browser-site.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'svg', 'benign');
const read = (name: string): Buffer => readFileSync(join(FIXTURES, name));

/** The corpus: one note with every benign fixture the goal names. */
const CORPUS: Record<string, string> = {
  'figures.md': [
    '# Figures',
    '',
    'A paragraph of prose so the page has text of its own and the search index is not empty.',
    '',
    '![A thin-line diagram](assets/line-art.svg "Line art")',
    '',
    '![Arrow labels](assets/arrow-labels.svg)',
    '',
    '![Gradients and a pattern](assets/gradients.svg)',
    '',
    '![A mask](assets/masks.svg)',
    '',
    '![Clip paths](assets/clip-paths.svg)',
    '',
    '![Static filters](assets/filters.svg)',
    '',
    '![Point lighting](assets/lighting.svg)',
    '',
    '![A transparent glow](assets/transparent.svg)',
    '',
    '![An explicit size](assets/explicit-size.svg)',
    '',
    '![A viewBox-only diagram](assets/viewbox-only.svg)',
    '',
    '![Latin text](assets/latin-text.svg)',
    '',
    '![A CJK label](assets/cjk-text.svg)',
    '',
    '![Small text](assets/small-text.svg)',
    '',
    '![A style sheet](assets/stylesheet.svg)',
    '',
    '![Shared symbols](assets/symbols.svg)',
    '',
    '![Physical units](assets/physical-mm.svg)',
    '',
    '![A shared picture](assets/shared.svg)',
    '',
  ].join('\n'),
};

const BENIGN = readdirSync(FIXTURES).sort();

const MEDIA: Readonly<Record<string, Uint8Array>> = Object.fromEntries(
  BENIGN.map((name) => [`assets/${name}`, read(name)]),
);

/** CSS layout size and emitted pixel size, from the document definitions. */
const EXPECTED: Readonly<Record<string, { readonly css: readonly [number, number]; readonly pixels: readonly [number, number] }>> = {
  'arrow-labels': { css: [560, 220], pixels: [1120, 440] },
  'cjk-text': { css: [560, 240], pixels: [1120, 480] },
  'clip-paths': { css: [560, 320], pixels: [1120, 640] },
  'explicit-size': { css: [640, 320], pixels: [1280, 640] },
  'filters': { css: [640, 300], pixels: [1280, 600] },
  'gradients': { css: [600, 300], pixels: [1200, 600] },
  'latin-text': { css: [520, 200], pixels: [1040, 400] },
  'line-art': { css: [480, 240], pixels: [960, 480] },
  'lighting': { css: [400, 240], pixels: [800, 480] },
  'masks': { css: [600, 300], pixels: [1200, 600] },
  'physical-mm': { css: [378, 189], pixels: [755, 377] },
  'shared': { css: [360, 160], pixels: [720, 320] },
  'small-text': { css: [320, 140], pixels: [640, 280] },
  'stylesheet': { css: [480, 240], pixels: [960, 480] },
  'symbols': { css: [420, 120], pixels: [840, 240] },
  'transparent': { css: [320, 320], pixels: [640, 640] },
  'viewbox-only': { css: [720, 340], pixels: [1440, 680] },
};

let built: BuiltSite | undefined;
let server: ServedSite | undefined;
let browser: Browser | undefined;

beforeAll(async () => {
  built = buildSiteWithMedia(CORPUS, MEDIA);
  server = await serveDist(built.dist);
  // Dynamic on purpose, matching every other browser gate: the file must collect
  // on a host without the browser package, and the failure is `chromium.launch`.
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (built !== undefined) removeWorkspace(built.workspace);
}, 300_000);

async function contextAt(deviceScaleFactor: number): Promise<BrowserContext> {
  assert.ok(browser !== undefined, 'the browser did not start');
  return browser.newContext({
    javaScriptEnabled: false,
    deviceScaleFactor,
    viewport: { width: 1000, height: 1600 },
  });
}

interface RenderedImage {
  readonly src: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly width: string | null;
  readonly height: string | null;
  readonly boxWidth: number;
  readonly boxHeight: number;
  readonly complete: boolean;
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/** Load the page and describe every figure in rendered document order. */
async function loadFigures(context: BrowserContext): Promise<{
  images: RenderedImage[];
  articleWidth: number;
  pageErrors: Error[];
  consoleErrors: string[];
}> {
  const page = await context.newPage();
  const pageErrors = collectPageErrors(page);
  const consoleErrors = collectConsoleErrors(page);
  await page.goto(`${server!.origin}/notes/figures/`, { waitUntil: 'load' });
  for (const image of await page.locator('article img').all()) await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('article img')].every((image) => (image as HTMLImageElement).complete),
  );
  const images = await page.locator('article img').evaluateAll((nodes) =>
    (nodes as HTMLImageElement[]).map((image) => {
      const box = image.getBoundingClientRect();
      return {
        src: image.getAttribute('src') ?? '',
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        width: image.getAttribute('width'),
        height: image.getAttribute('height'),
        boxWidth: box.width,
        boxHeight: box.height,
        complete: image.complete,
      };
    }),
  );
  const articleWidth = await page.locator('article.prose').evaluate((article) => article.clientWidth);
  await page.close();
  return { images, articleWidth, pageErrors, consoleErrors };
}

/** Strong adjacent-pixel luminance transitions in a screenshot region. */
async function edgeTransitions(screenshot: Buffer): Promise<number> {
  const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const luma = (x: number, y: number): number => {
    const at = (y * info.width + x) * info.channels;
    return 0.2126 * data[at]! + 0.7152 * data[at + 1]! + 0.0722 * data[at + 2]!;
  };
  let transitions = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 1; x < info.width; x++) {
      if (Math.abs(luma(x, y) - luma(x - 1, y)) >= 180) transitions += 1;
    }
  }
  return transitions;
}

test('published figures decode at 2x their logical size and lay out at that size', async () => {
  const context = await contextAt(1);
  try {
    const { images, articleWidth, pageErrors, consoleErrors } = await loadFigures(context);
    assert.deepEqual(pageErrors, [], 'the figure page threw');
    assert.deepEqual(consoleErrors, [], 'the figure page logged a console error');
    assert.equal(images.length, BENIGN.length, `the page rendered ${images.length} figures for ${BENIGN.length} fixtures`);

    for (const [name, expectation] of Object.entries(EXPECTED)) {
      const image = images.find((candidate) => candidate.src.includes(`-${name}.webp`));
      assert.ok(image, `the page lost ${name}`);
      assert.ok(image.complete && image.naturalWidth > 0, `${name} did not decode`);
      assert.equal(image.naturalWidth, expectation.pixels[0], `${name}: decoded width`);
      assert.equal(image.naturalHeight, expectation.pixels[1], `${name}: decoded height`);
      assert.equal(image.width, String(expectation.css[0]), `${name}: width attribute is not the logical size`);
      assert.equal(image.height, String(expectation.css[1]), `${name}: height attribute is not the logical size`);

      // `max-width: 100%` caps a picture wider than the reading column, so the
      // reading column is the second half of the layout contract.
      const displayed = Math.min(expectation.css[0], articleWidth);
      assert.ok(
        Math.abs(image.boxWidth - displayed) < 1.5,
        `${name}: displayed ${image.boxWidth.toFixed(1)}px wide, expected ${displayed.toFixed(1)}`,
      );
      const boxAspect = image.boxWidth / image.boxHeight;
      const expectedAspect = expectation.pixels[0] / expectation.pixels[1];
      assert.ok(
        Math.abs(boxAspect - expectedAspect) / expectedAspect < 0.01,
        `${name}: rendered aspect ${boxAspect.toFixed(4)}, expected ${expectedAspect.toFixed(4)}`,
      );
    }
  } finally {
    await context.close();
  }
});

test('text is crisp at 2x and the page does not overflow at 320 px', async () => {
  const single = await contextAt(1);
  const double = await contextAt(2);
  try {
    const singlePage = await single.newPage();
    const doublePage = await double.newPage();
    const singleErrors = collectPageErrors(singlePage);
    const doubleErrors = collectPageErrors(doublePage);
    const singleConsole = collectConsoleErrors(singlePage);
    const doubleConsole = collectConsoleErrors(doublePage);
    for (const page of [singlePage, doublePage]) {
      await page.goto(`${server!.origin}/notes/figures/`, { waitUntil: 'load' });
      for (const image of await page.locator('article img').all()) await image.scrollIntoViewIfNeeded();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('article img')].every((image) => (image as HTMLImageElement).complete),
      );
    }

    for (const [name, label] of [
      ['cjk-text', 'CJK'],
      ['small-text', 'small Latin'],
      ['latin-text', 'body Latin'],
    ] as const) {
      const selector = `article img[src*="-${name}.webp"]`;
      const one = await edgeTransitions(await singlePage.locator(selector).screenshot());
      const two = await edgeTransitions(await doublePage.locator(selector).screenshot());
      // Measured on this host: a 2× screenshot carries more resolved edge
      // transitions than the browser's downsample, and an upscaled or blank label
      // would carry few or none.
      assert.ok(two > one, `${label} text lost edge contrast at 2x: ${one} → ${two} transitions`);
      assert.ok(two >= 400, `${label} text has too few strong edges at 2x: ${two}`);
    }

    assert.deepEqual(singleErrors, [], 'the 1x page threw');
    assert.deepEqual(doubleErrors, [], 'the 2x page threw');
    assert.deepEqual(singleConsole, [], 'the 1x page logged a console error');
    assert.deepEqual(doubleConsole, [], 'the 2x page logged a console error');

    await singlePage.setViewportSize({ width: 320, height: 800 });
    const narrow = await singlePage.evaluate(() => ({
      documentClient: document.documentElement.clientWidth,
      documentScroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      narrow.documentScroll <= narrow.documentClient,
      `the page overflows at 320 px: ${JSON.stringify(narrow)}`,
    );
  } finally {
    await single.close();
    await double.close();
  }
});
