/**
 * Goal 0009's display surface: a generated site, served statically, showing its
 * images with **JavaScript disabled**.
 *
 * The goal is not "the bytes exist in `dist/`" — it is "a reader sees the
 * picture". So this gate builds a corpus with the shipped binary, serves the
 * output through the same `_headers`-applying server the other browser gates use,
 * and opens it in Chromium with scripting off. Three things are checked, and each
 * fails on its own:
 *
 * 1. the response for every `/_assets/` URL is 200, with the content type the
 *    extension claims and the exact source bytes;
 * 2. every `<img>` on the page has decoded (`naturalWidth > 0`), which under the
 *    served CSP is also the proof that `img-src 'self'` allowed the request;
 * 3. no request left this origin, and the withheld note's image is absent from
 *    the whole output.
 *
 * `naturalWidth` rather than a layout assertion, because it is the browser's own
 * answer to "did you decode this image" — a broken `src`, a blocked CSP directive,
 * or a 404 all leave it at 0.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';

import {
  buildSiteWithMedia,
  removeWorkspace,
  serveDist,
  type BuiltSite,
  type ServedSite,
} from './support/browser-site.ts';
import { AVIF, GIF_ANIMATED, JPEG, PNG_SECOND, PNG_THIRD, PNG_UNICODE, WEBP_ANIMATED } from './support/media.ts';

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
    'Unicode and a space: ![](<assets/图 表 one.png>)',
    '',
    'Reference form: ![a photograph][photo]',
    '',
    'An animation: ![a GIF](assets/anim.gif)',
    '',
    'A WebP animation: ![a WebP](assets/anim.webp)',
    '',
    'An AVIF: ![an AVIF](assets/still.avif)',
    '',
    'A name with a hash: ![reserved](assets/chart%23one.png)',
    '',
    'The same photograph again, root-anchored: ![shared](/assets/photo.jpeg)',
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
  'assets/图 表 one.png': PNG_UNICODE,
  'assets/photo.jpeg': JPEG,
  'assets/anim.gif': GIF_ANIMATED,
  'assets/anim.webp': WEBP_ANIMATED,
  'assets/still.avif': AVIF,
  'assets/chart#one.png': PNG_THIRD,
  'assets/unused.png': PNG_SECOND,
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

test('the published output carries one file per referenced image and nothing else', () => {
  const assets = filesUnder(join(built.dist, '_assets')).sort();
  // Six unique byte sets were referenced by a published note; the withheld
  // note's image is not among them.
  assert.equal(assets.length, 6, `the output carries ${assets.length} assets: ${assets.join(', ')}`);
  const digests = new Set(assets.map((name) => name.slice(0, 64)));
  assert.equal(digests.size, 6, 'two published assets share a digest');

  // The withheld image's bytes are nowhere in the output. Compared by content
  // rather than by name, because the name is not what would leak.
  const withheld = Buffer.from(PNG_SECOND);
  for (const file of filesUnder(built.dist)) {
    const bytes = readFileSync(join(built.dist, file));
    if (file.endsWith('.html') || file.endsWith('.js') || !bytes.equals(withheld)) continue;
    assert.fail(`the withheld image's bytes reached ${file}`);
  }
  // Non-vacuity: the same comparison finds the shared photograph, so it is
  // looking at image bytes rather than at text that never matches.
  const shared = Buffer.from(JPEG);
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

  const images = await page.locator('article img').evaluateAll((nodes) =>
    (nodes as HTMLImageElement[]).map((image) => ({
      src: image.getAttribute('src') ?? '',
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
      alt: image.getAttribute('alt'),
    })),
  );
  // Seven references over six assets: the photograph is embedded twice, once
  // through its definition. A page that published only the first reference would
  // still have the file and fail here.
  assert.equal(images.length, 7, `the page rendered ${images.length} images: ${JSON.stringify(images)}`);
  for (const image of images) {
    assert.ok(image.src.startsWith('/_assets/'), `an image points somewhere else: ${image.src}`);
    assert.ok(image.complete, `an image never finished loading: ${image.src}`);
    assert.ok(image.width > 0 && image.height > 0, `the browser decoded nothing for ${image.src}`);
    // Every authored alt survives; the renderer never invents or drops one.
    assert.equal(typeof image.alt, 'string', `an image lost its alt attribute: ${image.src}`);
  }

  // One response per distinct asset URL, all 200, and the content type matches
  // the extension a static host would map — which is why the extension is
  // derived from the bytes rather than from the source name.
  const byUrl = new Map(assetResponses.map((entry) => [entry.url, entry]));
  assert.equal(byUrl.size, 6, `the browser fetched ${byUrl.size} distinct assets: ${[...byUrl.keys()].join(', ')}`);
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

test('a served asset returns the exact source bytes it was made from', async () => {
  const gallery = readFileSync(join(built.dist, 'notes', 'gallery', 'index.html'), 'utf8');
  const sources = [...gallery.matchAll(/<img src="(\/_assets\/[^"]+)"/g)].map((match) => match[1]!);
  assert.ok(sources.length > 0, 'the built page carries no asset URL');
  const sourceBytes = Object.values(MEDIA).map((bytes) => Buffer.from(bytes));
  let compared = 0;
  for (const url of new Set(sources)) {
    const response = await fetch(`${server.origin}${url}`);
    assert.equal(response.status, 200, `${url} returned ${response.status}`);
    const served = Buffer.from(await response.arrayBuffer());
    // Identity is the digest in the URL, so the served bytes must hash to it,
    // and must be one of the sources unchanged — no transcode, no metadata edit.
    assert.equal(
      createHash('sha256').update(served).digest('hex'),
      url.slice('/_assets/'.length, '/_assets/'.length + 64),
      `${url} served bytes that do not hash to its own digest`,
    );
    if (sourceBytes.some((source) => source.equals(served))) compared += 1;
  }
  assert.equal(compared, new Set(sources).size, 'a served asset matches no source image, so byte identity is unproven');
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
