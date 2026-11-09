/**
 * Goals 0009–0011's display surface: a generated site, served statically,
 * showing its images and figures with **JavaScript disabled**. Goal 0011 means
 * the corpus now exercises both encoder rows — a JPEG photograph and PNG
 * screenshots/diagrams — so the byte-identity checks compare the served file
 * with the emitted candidate rather than with the source.
 *
 * The goal is not "the bytes exist in `dist/`" — it is "a reader sees the
 * picture, with truthful captions and without the layout moving". So this gate
 * builds a corpus with the shipped binary, serves the output through the same
 * `_headers`-applying server the other browser gates use, and opens it in
 * Chromium with scripting off. Each check fails on its own:
 *
 * 1. the response for every `/_assets/` URL is 200, with the content type the
 *    extension claims and bytes that hash to the URL's digest and equal the
 *    emitted representation (a WebP candidate where the policy chose one);
 * 2. every `<img>` decoded (`naturalWidth > 0`) under the served CSP, after the
 *    test scrolls a lazy image into view — JavaScript in the page remains off;
 * 3. exactly the titled standalone image is a `figure` with its `figcaption`,
 *    while an untitled, decorative, inline, or link-wrapped image is not;
 * 4. the `width`/`height` attributes and the browser's natural size agree with
 *    the fixture bytes, and the lead image is eager while later images are lazy;
 * 5. a 320 px viewport has no horizontal overflow, and a held-open image request
 *    reserves the same heading offset as the loaded page;
 * 6. no request left this origin, and the withheld note's image is absent from
 *    the whole output.
 *
 * `naturalWidth` rather than a layout assertion alone, because it is the
 * browser's own answer to "did you decode this image" — a broken `src`, a blocked
 * CSP directive, or a 404 all leave it at 0.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, BrowserContext, Route } from 'playwright';
import sharp from 'sharp';

import {
  buildSiteWithMedia,
  removeWorkspace,
  serveDist,
  type BuiltSite,
  type ServedSite,
} from './support/browser-site.ts';
import { prepareImage } from '../src/lib/media-codec.ts';
import { sniffImageFormat } from '../src/lib/media.ts';
import {
  AVIF,
  GIF_ANIMATED,
  JPEG,
  PNG_PORTRAIT,
  PNG_SCREENSHOT,
  PNG_SECOND,
  PNG_THIRD,
  PNG_TRANSPARENT,
  PNG_UNICODE,
  WEBP_ANIMATED,
  WEBP_LOSSY_WIDE,
} from './support/media.ts';

/**
 * A corpus with every supported form in one page.
 *
 * The reference form, the angle-bracket Unicode path, an animation, an AVIF, a
 * photograph shared with another note, and a name carrying `#` (written as
 * `%23`). `unused.png` is embedded only by a withheld note, which is the
 * negative control that keeps "everything published" from passing a gate that
 * never checked what was left out.
 */
const CORPUS: Record<string, string> = {
  'gallery.md': [
    '# Gallery',
    '',
    'The lead is a captioned figure. Its title is the caption and its alt is the',
    'accessible alternative:',
    '',
    '![A narrow vertical gradient](assets/portrait.png "A portrait figure: the caption, not the alt text")',
    '',
    'A wide screenshot has no title, so it is a plain image with no invented prose:',
    '',
    '![A wide screenshot of a command line](assets/screenshot.png)',
    '',
    'Transparent artwork is decorative and keeps an empty alternative:',
    '',
    '![](assets/transparent.png)',
    '',
    'An inline image keeps its place in the sentence: ![a hash-named chart](assets/chart%23one.png "Inline title") and the text continues.',
    '',
    'Unicode and a space: ![](<assets/图 表 one.png>)',
    '',
    'Reference form: ![a photograph][photo]',
    '',
    'An animation: ![a GIF](assets/anim.gif)',
    '',
    'A WebP animation: ![a WebP](assets/anim.webp)',
    '',
    'A lossy WebP: ![a lossy WebP](assets/lossy.webp)',
    '',
    'An AVIF: ![an AVIF](assets/still.avif)',
    '',
    'A linked image keeps its anchor and acquires no figure:',
    '[![a badge](assets/portrait.png)](https://example.test/target)',
    '',
    '## After the figures',
    '',
    'A paragraph below every image, used to measure reserved layout space.',
    '',
    'Shared with [[second]].',
    '',
    '[photo]: assets/photo.jpeg',
    '',
  ].join('\n'),
  'second.md': '# Second\n\n![from the second note](assets/photo.jpeg)\n',
  'withheld.md': '---\npublish: false\n---\n\n# Held\n\n![never published](assets/unused.png)\n',
};

const MEDIA: Record<string, Uint8Array> = {
  'assets/portrait.png': PNG_PORTRAIT,
  'assets/screenshot.png': PNG_SCREENSHOT,
  'assets/transparent.png': PNG_TRANSPARENT,
  'assets/图 表 one.png': PNG_UNICODE,
  'assets/photo.jpeg': JPEG,
  'assets/anim.gif': GIF_ANIMATED,
  'assets/anim.webp': WEBP_ANIMATED,
  'assets/lossy.webp': WEBP_LOSSY_WIDE,
  'assets/still.avif': AVIF,
  'assets/chart#one.png': PNG_THIRD,
  'assets/unused.png': PNG_SECOND,
};

/** The exact bytes Goal 0011 publishes for one fixture. */
async function emitted(bytes: Uint8Array): Promise<Buffer> {
  const format = sniffImageFormat(bytes);
  assert.ok(format, 'a fixture is not a supported image by its bytes');
  const result = await prepareImage(Buffer.from(bytes), format);
  assert.ok(result.ok, `a fixture could not be prepared: ${result.ok ? '' : result.reason}`);
  return result.image.bytes;
}

const EXPECTED_SIZE: Readonly<Record<string, { width: number; height: number }>> = {
  'portrait.webp': { width: 24, height: 72 },
  'screenshot.webp': { width: 480, height: 120 },
  'transparent.webp': { width: 96, height: 96 },
  'photo.webp': { width: 8, height: 6 },
  'anim.gif': { width: 4, height: 4 },
  'anim.webp': { width: 4, height: 4 },
  'lossy.webp': { width: 333, height: 47 },
  'still.avif': { width: 8, height: 6 },
  'chart%23one.webp': { width: 4, height: 4 },
  '%E5%9B%BE%20%E8%A1%A8%20one.webp': { width: 8, height: 6 },
};

let built: BuiltSite;
let server: ServedSite;
let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  built = buildSiteWithMedia(CORPUS, MEDIA);
  server = await serveDist(built.dist);
  // Imported here rather than at module scope, matching every other browser
  // gate in this tree: the file then collects on a host without the browser
  // package, and the failure is the named one `chromium.launch` raises.
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  // The whole point of this file. Nothing here may depend on a script: the
  // images are static HTML, and the only browser assistance is the test's own
  // evaluate, which Playwright runs in its isolated world.
  context = await browser.newContext({ javaScriptEnabled: false });
}, 240_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.close();
  if (built !== undefined) removeWorkspace(built.workspace);
}, 240_000);

/** Every file under a directory, as paths relative to it. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path).map((child) => join(name, child)));
    else found.push(name);
  }
  return found;
}

test('the published output carries one file per referenced image and nothing else', async () => {
  const assets = filesUnder(join(built.dist, '_assets')).sort();
  // Ten unique sources were referenced by a published note; the withheld note's
  // image is not among them.
  assert.equal(assets.length, 10, `the output carries ${assets.length} assets: ${assets.join(', ')}`);
  const digests = new Set(assets.map((name) => name.slice(0, 64)));
  assert.equal(digests.size, 10, 'two published assets share a digest');

  // The withheld image's published bytes are nowhere in the output. Goal 0011's
  // encoder means "the source bytes" is no longer the question: a withheld PNG
  // would have reached the build as a WebP candidate, so that candidate is what
  // the comparison looks for.
  const withheld = await emitted(PNG_SECOND);
  for (const file of filesUnder(built.dist)) {
    const bytes = readFileSync(join(built.dist, file));
    assert.ok(!bytes.equals(withheld), `the withheld image's bytes reached ${file}`);
    assert.ok(!bytes.equals(Buffer.from(PNG_SECOND)), `the withheld image's source bytes reached ${file}`);
  }
  // Non-vacuity: the same comparison finds the shared photograph's emitted
  // bytes, so it is looking at image bytes rather than at text that never
  // matches.
  const shared = await emitted(JPEG);
  assert.ok(
    filesUnder(built.dist).some((file) => readFileSync(join(built.dist, file)).equals(shared)),
    'the comparison above found nothing at all, so it proves nothing',
  );
});

test('a JavaScript-disabled browser decodes every published image under the served CSP', async () => {
  const page = await context.newPage();
  const assetResponses: { url: string; status: number; type: string }[] = [];
  const foreign: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== server.origin) {
      foreign.push(response.url());
      return;
    }
    if (url.pathname.startsWith('/_assets/')) {
      assetResponses.push({
        url: url.pathname,
        status: response.status(),
        type: response.headers()['content-type'] ?? '',
      });
    }
  });

  const response = await page.goto(`${server.origin}/notes/gallery/`, { waitUntil: 'load' });
  const policy = response?.headers()['content-security-policy'] ?? '';
  assert.match(policy, /img-src[^;]*'self'/, `the served policy does not allow same-origin images: ${policy}`);

  // Lazy images below the fold have not been requested yet, so each is scrolled
  // into view before the assertion that it decoded. That is the browser doing
  // the loading, with page scripting disabled, not the test setting `src`.
  const count = await page.locator('article img').count();
  for (let index = 0; index < count; index += 1) {
    await page.locator('article img').nth(index).scrollIntoViewIfNeeded();
  }
  await page.waitForFunction(() =>
    [...document.querySelectorAll('article img')].every((image) => (image as HTMLImageElement).complete),
  );

  const images = await page.locator('article img').evaluateAll((nodes) =>
    (nodes as HTMLImageElement[]).map((image) => ({
      src: image.getAttribute('src') ?? '',
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      width: image.getAttribute('width'),
      height: image.getAttribute('height'),
      alt: image.getAttribute('alt'),
      loading: image.getAttribute('loading'),
      decoding: image.getAttribute('decoding'),
      inFigure: image.closest('figure') !== null,
      caption: image.closest('figure')?.querySelector('figcaption')?.textContent ?? null,
    })),
  );
  // Eleven references over ten assets: the portrait is also the linked badge.
  assert.equal(images.length, 11, `the page rendered ${images.length} images: ${JSON.stringify(images)}`);
  for (const image of images) {
    assert.ok(image.src.startsWith('/_assets/'), `an image points somewhere else: ${image.src}`);
    assert.ok(image.complete, `an image never finished loading: ${image.src}`);
    assert.ok(image.naturalWidth > 0 && image.naturalHeight > 0, `the browser decoded nothing for ${image.src}`);
    assert.equal(typeof image.alt, 'string', `an image lost its alt attribute: ${image.src}`);
    assert.equal(image.decoding, 'async', `${image.src}: decoding hint missing`);
    const expected = Object.entries(EXPECTED_SIZE).find(([suffix]) => image.src.endsWith(`-${suffix}`));
    assert.ok(expected, `${image.src}: no fixture size is recorded for this URL`);
    const [, size] = expected;
    assert.equal(image.width, String(size.width), `${image.src}: width attribute`);
    assert.equal(image.height, String(size.height), `${image.src}: height attribute`);
    assert.equal(image.naturalWidth, size.width, `${image.src}: natural width`);
    assert.equal(image.naturalHeight, size.height, `${image.src}: natural height`);
  }

  // The rendered corpus really contains both encoder rows and an exempt
  // animated source. Without these three assertions a corpus of only passthrough
  // images would still pass every check above.
  const renderedUrls = images.map((image) => image.src);
  assert.ok(renderedUrls.some((url) => url.endsWith('-photo.webp')), 'no JPEG photograph was transcoded');
  assert.ok(renderedUrls.some((url) => url.endsWith('-screenshot.webp')), 'no PNG screenshot was converted');
  assert.ok(renderedUrls.some((url) => url.endsWith('-anim.gif')), 'the animated GIF was not published unchanged');
  const gifPages = (await sharp(Buffer.from(GIF_ANIMATED)).metadata()).pages ?? 1;
  assert.ok(gifPages >= 3, `the fixture behind anim.gif has ${gifPages} page(s), not a real animation`);

  // The lead image is the first in document order and stays eager; everything
  // after it defers. The inline image and the linked badge appear later, so
  // neither is mistaken for the lead.
  assert.equal(images[0]!.loading, 'eager', `the lead image defers: ${JSON.stringify(images[0])}`);
  for (const image of images.slice(1)) {
    assert.equal(image.loading, 'lazy', `${image.src}: a below-the-fold image is not lazy`);
  }

  // Exactly the titled standalone portrait becomes a figure. The wide
  // screenshot, the decorative transparent artwork, the inline chart and the
  // link-wrapped badge do not.
  assert.equal(images.filter((image) => image.inFigure).length, 1, 'a non-standalone image acquired a figure');
  assert.equal(images[0]!.inFigure, true, 'the captioned lead did not become a figure');
  assert.equal(images[0]!.caption, 'A portrait figure: the caption, not the alt text');
  assert.equal(images[0]!.alt, 'A narrow vertical gradient', 'the caption replaced the alt text');
  assert.equal((await page.locator('article figcaption').count()), 1, 'a caption was invented');
  assert.doesNotMatch(
    readFileSync(join(built.dist, 'notes', 'gallery', 'index.html'), 'utf8'),
    /<figure[^>]*>[\s\S]*?<figcaption>\s*<\/figcaption>/,
    'an empty figcaption shipped',
  );

  // At the narrowest supported width the wide screenshot and the portrait stay
  // inside the article column; neither `scrollWidth` nor the document may grow.
  await page.setViewportSize({ width: 320, height: 640 });
  const narrow = await page.evaluate(() => {
    const article = document.querySelector('article.prose') as HTMLElement;
    return {
      articleClient: article.clientWidth,
      articleScroll: article.scrollWidth,
      documentClient: document.documentElement.clientWidth,
      documentScroll: document.documentElement.scrollWidth,
    };
  });
  assert.ok(narrow.articleScroll <= narrow.articleClient, `the article overflows at 320 px: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.documentScroll <= narrow.documentClient, `the page overflows at 320 px: ${JSON.stringify(narrow)}`);

  // One response per distinct asset URL, all 200, and the content type matches
  // the extension a static host would map — which is why the extension is
  // derived from the bytes rather than from the source name.
  const byUrl = new Map(assetResponses.map((entry) => [entry.url, entry]));
  assert.equal(byUrl.size, 10, `the browser fetched ${byUrl.size} distinct assets: ${[...byUrl.keys()].join(', ')}`);
  for (const [url, entry] of byUrl) {
    assert.equal(entry.status, 200, `${url} returned ${entry.status}`);
    const extension = url.slice(url.lastIndexOf('.'));
    const expected: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
    };
    assert.equal(entry.type, expected[extension], `${url} was served as ${entry.type}`);
  }
  assert.deepEqual(foreign, [], `a page request left this origin: ${foreign.join(', ')}`);
  await page.close();
});

test('width and height reserve the same layout space before the image bytes arrive', async () => {
  // A layout-shift proxy that does not need a performance observer: hold every
  // image request open, measure the heading after them while the bytes are still
  // pending, then release the requests and measure again. The width/height
  // attributes plus `max-width: 100%; height: auto` are what make the two
  // offsets agree; an image without them has no reserved ratio until it arrives.
  //
  // Held rather than aborted: an aborted image becomes a broken-image alt box,
  // which is a different rendering question and measured 235 px of difference on
  // the first version of this gate.
  const page = await context.newPage();
  await page.setViewportSize({ width: 320, height: 640 });
  const pending: Route[] = [];
  let holding = true;
  await page.route('**/_assets/**', (route) => {
    if (holding) pending.push(route);
    else route.continue();
  });
  await page.goto(`${server.origin}/notes/gallery/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const article = document.querySelector('article.prose');
    return article !== null && getComputedStyle(article).maxWidth.endsWith('px');
  });
  const headingOffset = () =>
    page.locator('article h2', { hasText: 'After the figures' }).evaluate((node) =>
      node.getBoundingClientRect().top + window.scrollY,
    );
  const pendingOffset = await headingOffset();
  assert.ok(pending.length > 0, 'no image request was held open, so nothing was measured');

  holding = false;
  for (const route of pending) await route.continue();
  const count = await page.locator('article img').count();
  for (let index = 0; index < count; index += 1) {
    await page.locator('article img').nth(index).scrollIntoViewIfNeeded();
  }
  await page.waitForFunction(() =>
    [...document.querySelectorAll('article img')].every((image) => (image as HTMLImageElement).complete),
  );
  const loadedOffset = await headingOffset();
  await page.close();

  assert.ok(
    Math.abs(pendingOffset - loadedOffset) <= 1,
    `the reserved layout differs from the loaded layout by ${Math.abs(pendingOffset - loadedOffset)} px (${pendingOffset} vs ${loadedOffset})`,
  );
});

test('a served asset is the exact emitted representation its digest names', async () => {
  const gallery = readFileSync(join(built.dist, 'notes', 'gallery', 'index.html'), 'utf8');
  const sources = [...gallery.matchAll(/<img src="(\/_assets\/[^"]+)"/g)].map((match) => match[1]!);
  assert.ok(sources.length > 0, 'the built page carries no asset URL');

  // Every representation this corpus can legitimately publish: a passthrough
  // source for the exempt rows, a WebP candidate for JPEG and PNG. The served
  // bytes must be one of them *and* hash to the URL, which is the pair 0011's
  // identity rule states. Comparing only against sources would fail on every
  // transcoded image; comparing only against the digest would not prove the
  // encoder's output is what a reader receives.
  const expected = new Map<string, Buffer>();
  for (const [path, bytes] of Object.entries(MEDIA)) {
    expected.set(path, await emitted(bytes));
  }
  const emittedBytes = [...expected.values()];
  const servedBytes: Buffer[] = [];

  for (const url of new Set(sources)) {
    const response = await fetch(`${server.origin}${url}`);
    assert.equal(response.status, 200, `${url} returned ${response.status}`);
    const served = Buffer.from(await response.arrayBuffer());
    assert.equal(
      createHash('sha256').update(served).digest('hex'),
      url.slice('/_assets/'.length, '/_assets/'.length + 64),
      `${url} served bytes that do not hash to its own digest`,
    );
    assert.ok(
      emittedBytes.some((candidate) => candidate.equals(served)),
      `${url} served bytes no source in this corpus produces`,
    );
    servedBytes.push(served);
  }

  // The two encoder rows reach a browser as WebP, and the bytes are the
  // candidates rather than the sources. Asserted by source path, because a
  // count of WebP files would also be satisfied by the corpus's already-WebP
  // fixtures.
  for (const sourcePath of ['assets/photo.jpeg', 'assets/screenshot.png'] as const) {
    const candidate = expected.get(sourcePath)!;
    assert.equal(sniffImageFormat(candidate), 'webp', `${sourcePath} produced no WebP candidate`);
    assert.ok(!candidate.equals(Buffer.from(MEDIA[sourcePath]!)), `${sourcePath} published its source bytes`);
    assert.ok(
      servedBytes.some((served) => served.equals(candidate)),
      `${sourcePath}: the WebP candidate is not the file a reader fetched`,
    );
  }
});

test('the shared photograph is one file on disk and two references on the pages', () => {
  const gallery = readFileSync(join(built.dist, 'notes', 'gallery', 'index.html'), 'utf8');
  const second = readFileSync(join(built.dist, 'notes', 'second', 'index.html'), 'utf8');
  const sourcesOf = (html: string): string[] =>
    [...html.matchAll(/<img src="(\/_assets\/[^"]+)"/g)].map((match) => match[1]!);
  const secondUrls = new Set(sourcesOf(second));
  // Distinct URLs on the gallery page: the photograph is embedded there twice,
  // so counting occurrences would report two shared images for one asset.
  const shared = [...new Set(sourcesOf(gallery))].filter((url) => secondUrls.has(url));
  assert.equal(shared.length, 1, `the two notes share ${shared.length} image URLs, not one`);
  // And the URL names one file in the output, which the inventory also asserts.
  const name = decodeURIComponent(shared[0]!.slice('/_assets/'.length));
  assert.ok(filesUnder(join(built.dist, '_assets')).includes(name), `${name} is not one of the published files`);
});
