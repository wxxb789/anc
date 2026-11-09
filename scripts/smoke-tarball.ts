/**
 * Release smoke: install the packed product into a foreign notes repository,
 * run its public init/build path, and inspect what a stranger receives.
 *
 * This is intentionally not part of verify. npm installs the full production
 * dependency tree and may need the registry cache/network; that is a release
 * qualification cost, not a source gate. The fixture is synthetic, so failure
 * diagnostics may print it without disclosing anybody's notes.
 *
 * The browser phase is the goal's Real browser row: the built foreign output is
 * served under its own generated `dist/_headers` — the host configuration the
 * build wrote, which is what a deployment applies — and driven through its own
 * Worker, WASM, and snapshot. A missing Chromium throws rather than skipping,
 * because a green smoke without a browser run would report unexecuted evidence
 * as a pass.
 */

import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium, type Browser } from 'playwright';
import { serveDist, sqliteAssetRequests, tabTo, workerScriptPath, type ServedSite } from '../tests/support/browser-site.ts';
import {
  GIF_ANIMATED,
  JPEG,
  PNG_PORTRAIT,
  PNG_SCREENSHOT,
  PNG_TRANSPARENT,
  PNG_UNICODE,
} from '../tests/support/media.ts';
import { openSnapshot, snapshotMembers } from '../tests/support/snapshot.ts';
import { spawnNpm } from './npm-command.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const TARBALL = join(
  ROOT,
  MANIFEST.name.replace(/^@/, '').replace('/', '-') + '-' + MANIFEST.version + '.tgz',
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      command + ' ' + args.join(' ') + ' failed with status ' + String(result.status) + '\n' +
      result.stdout + '\n' + result.stderr,
    );
  }
  return result.stdout;
}

function runNpm(args: string[], cwd: string): string {
  const result = spawnNpm(args, cwd);
  if (result.status !== 0) {
    throw new Error(
      'npm ' + args.join(' ') + ' failed with status ' + String(result.status) + '\n' +
      result.stdout + '\n' + result.stderr,
    );
  }
  return result.stdout;
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

function artifactText(path: string): { text: string; inflated: boolean } {
  const bytes = readFileSync(path);
  const inflated = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return {
    text: inflated ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8'),
    inflated,
  };
}

/** Launch Chromium, naming the install command when it is missing. */
async function launchSmokeBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (error) {
    throw new Error(
      'the smoke browser phase needs Chromium; install it with `pnpm exec playwright install chromium` ' +
        '(chromium.launch failed: ' + (error instanceof Error ? error.message : String(error)) + ')',
    );
  }
}

// The browser phases below read the foreign artifact as a reader would. 1 and 2
// share one page so the lazy reading and the preview are one session's evidence,
// the way `tests/snapshot-runtime.test.ts` runs them. The recorder is attached
// before navigation: a zero collected after the runtime had already started
// would prove nothing.
async function checkReadingAndPreview(
  browser: Browser,
  server: ServedSite,
  workerChunk: string,
  secondTitle: string,
): Promise<void> {
  const readingPage = await browser.newPage();
  try {
    const runtimeRequests = sqliteAssetRequests(readingPage);
    const response = await readingPage.goto(`${server.origin}/notes/welcome/`, { waitUntil: 'load' });
    const servedPolicy = response?.headers()['content-security-policy'] ?? '';
    assert(
      servedPolicy.includes("worker-src 'self'") && servedPolicy.includes("connect-src 'self'"),
      'the foreign build was not served under its generated CSP: ' + JSON.stringify(servedPolicy),
    );
    assert(
      runtimeRequests.length === 0,
      'ordinary reading fetched SQLite assets before any intent: ' + runtimeRequests.join(', '),
    );
    await readingPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await readingPage.waitForTimeout(300);
    assert(
      runtimeRequests.length === 0,
      'scrolling the article fetched SQLite assets before any intent: ' + runtimeRequests.join(', '),
    );

    // Preview through the foreign artifact's own Worker/WASM/DB. The expected
    // title is the snapshot's own row (`secondTitle`), so the panel is compared
    // against the bytes the browser fetched rather than against the fixture
    // that asked for them.
    const link = readingPage.locator('article a[href="/notes/second/"]').first();
    assert(
      (await link.count()) === 1,
      'the welcome article has no link to the second note, so its preview was not measured',
    );
    await link.hover();
    const panel = readingPage.locator('#link-preview');
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    const preview = (await panel.textContent()) ?? '';
    assert(
      preview.includes(secondTitle),
      'the preview did not carry the snapshot title ' + JSON.stringify(secondTitle) + ': ' + JSON.stringify(preview),
    );
    assert(
      preview.includes('SECOND-NOTE-BODY-MARKER'),
      'the preview excerpt did not carry the second note body marker: ' + JSON.stringify(preview),
    );
    // The panel is evidence of this artifact's runtime only if this page fetched
    // this build's Worker chunk, WASM, and snapshot: the chunk path comes from
    // the built directory, not from the page's own markup.
    assert(
      runtimeRequests.some((url) => url.endsWith(workerChunk)),
      'the preview did not request the built Worker chunk at its own path: ' + runtimeRequests.join(', '),
    );
    assert(
      runtimeRequests.some((url) => url.endsWith('.wasm')),
      'the preview did not request the built WASM body: ' + runtimeRequests.join(', '),
    );
    assert(
      runtimeRequests.some((url) => url.includes('/data/site.')),
      'the preview did not request the built snapshot: ' + runtimeRequests.join(', '),
    );
  } finally {
    await readingPage.close();
  }
}

// The chooser and trigger are exactly `tests/tag-browser.test.ts`'s. The
// membership asserted is the note titles from the snapshot, so a list that
// renders slugs, or a chooser that merely offers the tag name, fails here.
async function checkTagEnumeration(
  browser: Browser,
  server: ServedSite,
  publicNotes: readonly { slug: string; title: string }[],
): Promise<void> {
  const tagPage = await browser.newPage();
  try {
    await tagPage.goto(`${server.origin}/tags/`, { waitUntil: 'load' });
    await tagPage.selectOption('#tag-browser-select', 'garden');
    await tagPage.waitForSelector('#tag-browser-results a');
    const members = await tagPage.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>('#tag-browser-results a[href^="/notes/"]')].map((anchor) => ({
        slug: anchor.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
        title: anchor.textContent ?? '',
      })),
    );
    assert(
      members.length === publicNotes.length &&
        publicNotes.every((note) => members.some((member) => member.slug === note.slug && member.title === note.title)),
      'the garden chooser did not enumerate both published note titles: ' + JSON.stringify(members),
    );
  } finally {
    await tagPage.close();
  }
}

// The local graph on the note page is driven exactly as the local half of
// `tests/graph-runtime.test.ts` drives it — Tab to the activation control,
// Enter — and the oracle is the one edge the fixture authored
// (welcome <-> second). The equivalent table is checked beside the figure,
// because that is the representation a non-visual reader gets.
async function checkGraph(browser: Browser, server: ServedSite): Promise<void> {
  const graphPage = await browser.newPage();
  try {
    await graphPage.goto(`${server.origin}/notes/welcome/`, { waitUntil: 'load' });
    assert(
      (await tabTo(graphPage, '[data-graph-activate]')) === true,
      'the local graph activation control was not reachable by Tab',
    );
    await graphPage.keyboard.press('Enter');
    // Wait for the answer, not for any status: the cold load writes a loading
    // string into the same live region first, and a non-empty test passes on it.
    await graphPage.waitForFunction(() => {
      const status = document.querySelector('[data-graph-status]')?.textContent ?? '';
      const controls = document.querySelector<HTMLElement>('[data-graph-controls]');
      return status !== '' && status !== controls?.dataset['graphLoading'] && !controls?.hasAttribute('aria-busy');
    });
    const region = graphPage.locator('[data-graph-region="note-graph"]');
    // A two-note corpus draws the same figure and table before activation as
    // after it, so the counts below cannot distinguish a live redraw from the
    // build-time baseline. Re-center controls exist only in the client's own
    // table rows, so their count is the proof the live render ran.
    assert(
      (await region.locator('button[data-graph-recenter]').count()) === 2,
      'no live re-center controls, so the graph may still be the static baseline',
    );
    const drawn = await graphPage.evaluate(() =>
      [...document.querySelectorAll<Element>('[data-graph-region="note-graph"] .graph-nodes a.graph-node')].map(
        (anchor) => anchor.getAttribute('href')!.replace(/^\/notes\/|\/$/g, ''),
      ),
    );
    assert(
      drawn.length === 2 && drawn[0] === 'welcome' && drawn[1] === 'second',
      'the local graph did not draw the centre and its one neighbour in order: ' + JSON.stringify(drawn),
    );
    assert(
      (await region.locator('.graph-edges line').count()) === 1,
      'the local graph did not draw the single merged welcome <-> second edge',
    );
    assert(
      (await region.locator('.graph-table tbody tr').count()) === 2,
      'the equivalent graph table does not hold one row per drawn note',
    );
    assert(
      (await region.locator('.graph-table tbody th a[href="/notes/second/"]').count()) === 1,
      'the equivalent graph table has no row for the second note',
    );
  } finally {
    await graphPage.close();
  }
}

// The snapshot is aborted before any intent, so the hover cannot start the
// runtime. The model is `tests/snapshot-runtime.test.ts`'s blocked-fetch case:
// the panel stays hidden while the article and its anchor remain readable and
// followable.
async function checkStaticFallback(browser: Browser, server: ServedSite): Promise<void> {
  const fallbackPage = await browser.newPage();
  try {
    await fallbackPage.route('**/data/site.*', (route) => route.abort());
    await fallbackPage.goto(`${server.origin}/notes/welcome/`, { waitUntil: 'load' });
    const link = fallbackPage.locator('article a[href="/notes/second/"]').first();
    assert(
      (await link.count()) === 1,
      'the welcome article has no link to the second note, so the fallback check is vacuous',
    );
    await link.hover();
    await fallbackPage.waitForTimeout(1_500);
    assert(
      await fallbackPage.locator('#link-preview').isHidden(),
      'a blocked snapshot still produced a preview panel',
    );
    assert(
      (await link.getAttribute('href')) === '/notes/second/',
      'static navigation was not intact after the blocked snapshot',
    );
    assert(
      ((await fallbackPage.locator('article').textContent()) ?? '').includes('A public note linking'),
      'the static article text did not survive the blocked snapshot',
    );
  } finally {
    await fallbackPage.close();
  }
}

// The shipped preview accepts this exact output, and only on loopback. The
// recognition cases (missing, multiple, wrong digest, path escape) have their
// own gates; this is the positive half the foreign-repository row asks for, run
// through the installed binary rather than through the test helpers. `--port 0`
// lets the server pick, and the announced line carries the port it actually
// bound — a taken port moves, so trusting the request instead of the
// announcement would fetch from nothing. The refused cases stay in
// `tests/preview-server.test.ts` and `tests/preview-snapshot.test.ts`; what
// cannot be tested there is whether *this installed package* can serve *this
// built output* from a foreign directory, which is what runs here.
async function checkShippedPreview(binary: string, scratch: string): Promise<void> {
  const preview = spawn(
    process.execPath,
    [binary, 'preview', '--dist', 'dist', '--port', '0'],
    { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    let streams = '';
    const port = await new Promise<number>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error('preview did not announce a URL within 30s: ' + streams)),
        30_000,
      );
      preview.stdout.setEncoding('utf8');
      preview.stdout.on('data', (chunk: string) => {
        streams += chunk;
        const match = /^preview: http:\/\/localhost:(\d+)\/$/m.exec(streams);
        if (match) {
          clearTimeout(timer);
          resolvePromise(Number(match[1]));
        }
      });
      // Read from the start: a crash before the announcement is exactly the
      // case whose diagnosis needs it, and an unread pipe can block the child.
      preview.stderr.setEncoding('utf8');
      preview.stderr.on('data', (chunk: string) => {
        streams += chunk;
      });
      preview.once('exit', (code) => {
        clearTimeout(timer);
        rejectPromise(new Error('preview exited before announcing a URL (status ' + String(code) + '): ' + streams));
      });
    });

    const previewed = await fetch(`http://127.0.0.1:${port}/notes/welcome/`);
    assert(previewed.status === 200, 'the shipped preview did not serve the foreign note route');
    assert(
      (await previewed.text()).includes('A public note linking'),
      'the shipped preview served a page without the foreign note body',
    );
    const withheld = await fetch(`http://127.0.0.1:${port}/private/`);
    assert(withheld.status === 200, 'the shipped preview did not serve the withheld-note page');
    await withheld.body?.cancel();
  } finally {
    // `once` does not replay an already-emitted event, so a preview that died
    // before announcing would otherwise hang this release smoke forever.
    if (preview.exitCode === null && preview.signalCode === null) {
      preview.kill('SIGINT');
      await once(preview, 'exit');
    }
  }
}

/**
 * The packaged path's image evidence, with scripting off.
 *
 * The goal's first completion clause is about a reader, not about a file: a
 * generated site served statically shows its pictures in an ordinary browser
 * without JavaScript. So this opens the foreign output in a context whose page
 * scripts are disabled and asks the browser whether it decoded each image —
 * `naturalWidth > 0` is the browser's own answer, and under the served CSP it
 * also proves `img-src 'self'` allowed the request. Every response is then
 * checked for status, content type, and the digest its URL names.
 */
async function checkImages(browser: Browser, server: ServedSite, expectedFiles: readonly string[]): Promise<void> {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    const response = await page.goto(`${server.origin}/notes/welcome/`, { waitUntil: 'load' });
    const policy = response?.headers()['content-security-policy'] ?? '';
    assert(
      /img-src[^;]*'self'/.test(policy),
      'the foreign build was not served under a policy that allows same-origin images: ' + JSON.stringify(policy),
    );

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
        width: image.naturalWidth,
        height: image.naturalHeight,
        attributeWidth: image.getAttribute('width'),
        attributeHeight: image.getAttribute('height'),
        complete: image.complete,
        alt: image.getAttribute('alt'),
        loading: image.getAttribute('loading'),
        decoding: image.getAttribute('decoding'),
        caption: image.closest('figure')?.querySelector('figcaption')?.textContent ?? null,
      })),
    );
    assert(images.length >= 6, 'the foreign note rendered fewer images than it embeds: ' + JSON.stringify(images));
    for (const image of images) {
      assert(image.src.startsWith('/_assets/'), 'an image points outside the published assets: ' + image.src);
      assert(image.complete, 'an image never finished loading: ' + image.src);
      assert(image.width > 0, 'the browser decoded nothing for ' + image.src);
      assert(image.decoding === 'async', 'an image carries no async decoding hint: ' + image.src);
    }
    assert(images[0]!.loading === 'eager', 'the lead image does not load eagerly: ' + JSON.stringify(images[0]));
    for (const image of images.slice(1)) {
      assert(image.loading === 'lazy', 'a below-the-fold image is not lazy: ' + image.src);
    }
    const sized = Object.entries({
      'portrait.png': [24, 72],
      'screenshot.png': [480, 120],
      'transparent.png': [96, 96],
    } as const);
    for (const [suffix, [width, height]] of sized) {
      const image = images.find((candidate) => candidate.src.endsWith(`-${suffix}`));
      assert(image, 'the foreign page lost its ' + suffix);
      assert(image.attributeWidth === String(width) && image.attributeHeight === String(height),
        suffix + ' was emitted without its intrinsic dimensions: ' + JSON.stringify(image));
      assert(image.width === width && image.height === height,
        suffix + ' decoded at a different size than its header declared');
    }
    assert(
      images.some((image) => image.caption === 'A packaged portrait caption' && image.alt === 'a narrow portrait gradient'),
      'the packaged figure lost its caption or replaced its alt: ' + JSON.stringify(images),
    );
    assert(images.find((image) => image.src.endsWith('-transparent.png'))?.alt === '',
      'the decorative image lost its empty alt');

    const contentTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
    };
    const served = new Set(images.map((image) => image.src));
    assert(served.size === expectedFiles.length, 'the page shows ' + served.size + ' assets, the output carries ' + expectedFiles.length);
    for (const url of served) {
      const asset = await fetch(server.origin + url);
      assert(asset.status === 200, url + ' returned ' + asset.status);
      const extension = url.slice(url.lastIndexOf('.'));
      assert(
        asset.headers.get('content-type') === contentTypes[extension],
        url + ' was served as ' + String(asset.headers.get('content-type')),
      );
      const bytes = Buffer.from(await asset.arrayBuffer());
      const digest = createHash('sha256').update(bytes).digest('hex');
      assert(digest === url.slice('/_assets/'.length, '/_assets/'.length + 64), url + ' served bytes that do not hash to its digest');
    }
  } finally {
    await context.close();
  }
}

async function main(): Promise<number> {
  const packOutput = run(process.execPath, [join(ROOT, 'scripts', 'compile-package.ts')], ROOT);
  assert(
    packOutput.includes('tarball: ' + TARBALL),
    'packing current sources did not produce the expected tarball',
  );
  assert(existsSync(TARBALL), 'packing current sources wrote no tarball');
  const scratch = mkdtempSync(join(tmpdir(), 'publish-adoption-'));
  try {
    mkdirSync(join(scratch, 'drafts'), { recursive: true });
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'foreign-notes', version: '1.0.0', private: true }, null, 2) + '\n',
      'utf8',
    );
    // Real image bytes, under a path with a space and CJK so the packaged path
    // exercises resolution, URL encoding, staging, inventory, and serving with
    // names a stranger would actually write.
    mkdirSync(join(scratch, 'media'), { recursive: true });
    writeFileSync(join(scratch, 'media', '图 表 one.png'), PNG_UNICODE);
    writeFileSync(join(scratch, 'media', 'photo.jpeg'), JPEG);
    writeFileSync(join(scratch, 'media', 'anim.gif'), GIF_ANIMATED);
    writeFileSync(join(scratch, 'media', 'portrait.png'), PNG_PORTRAIT);
    writeFileSync(join(scratch, 'media', 'screenshot.png'), PNG_SCREENSHOT);
    writeFileSync(join(scratch, 'media', 'transparent.png'), PNG_TRANSPARENT);
    writeFileSync(
      join(scratch, 'welcome.md'),
      [
        '---',
        'tags: [garden]',
        '---',
        '',
        '# Welcome',
        '',
        'A public note linking to [[private]] and [[second]] with math $$x^2$$.',
        '',
        'INDEX-CONTROL-**JOINED**-TEXT',
        '',
        '![a chart with a space and CJK in its name](<media/图 表 one.png>)',
        '',
        'The same photograph as the second note: ![shared][shot]',
        '',
        'An Obsidian embed of an animation: ![[media/anim.gif]]',
        '',
        'A titled standalone image becomes a figure:',
        '',
        '![a narrow portrait gradient](media/portrait.png "A packaged portrait caption")',
        '',
        'An untitled wide screenshot stays a plain image:',
        '',
        '![a wide screenshot](media/screenshot.png)',
        '',
        'Decorative artwork keeps an empty alternative and no caption:',
        '',
        '![](media/transparent.png)',
        '',
        'An inline picture keeps its sentence: ![inline screenshot](media/screenshot.png) and the prose continues.',
        '',
        'A tight list item promotes a captioned image:',
        '',
        '- ![a tight-list portrait](media/portrait.png "A tight-list caption")',
        '',
        '[shot]: media/photo.jpeg',
        '',
        '~~~mermaid',
        'graph TD',
        '  A[Write] --> B[Publish]',
        '~~~',
        '',
      ].join('\n'),
      'utf8',
    );
    // The reciprocal half of the one published edge: the preview reads this
    // note's title and excerpt, the tag chooser must return its title, and the
    // local graph needs the backlink. The body marker exists in no other file,
    // so a panel showing it cannot have been scraped from the welcome page.
    writeFileSync(
      join(scratch, 'second.md'),
      [
        '---',
        'title: Second Note',
        'tags: [garden]',
        '---',
        '',
        '# Second Note',
        '',
        'A public note linking back to [[welcome]].',
        '',
        'SECOND-NOTE-BODY-MARKER',
        '',
        'The photograph the welcome note shows too: ![shared](media/photo.jpeg)',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(scratch, 'private.md'),
      '---\npublish: false\n---\n\n# Private\n\nPRIVATE-BODY-MUST-NOT-SHIP\n',
      'utf8',
    );
    writeFileSync(
      join(scratch, 'drafts', 'roadmap.md'),
      '# Draft\n\nDRAFT-BODY-MUST-NOT-SHIP\n',
      'utf8',
    );

    run('git', ['init', '--quiet'], scratch);
    run('git', ['config', 'user.name', 'Release Smoke'], scratch);
    run('git', ['config', 'user.email', 'release-smoke@example.invalid'], scratch);
    runNpm(['install', TARBALL, '--no-audit', '--no-fund'], scratch);

    const binary = join(scratch, 'node_modules', ...MANIFEST.name.split('/'), 'bin', 'anc.mjs');
    assert(existsSync(binary), 'npm did not install the shipped binary');
    const initOutput = run(process.execPath, [binary, 'init'], scratch);
    assert(initOutput.includes('publish.config.yaml: written'), 'init did not create its configuration template');
    assert(readFileSync(join(scratch, '.gitignore'), 'utf8').includes('/dist/'), 'init did not ignore the build output');

    writeFileSync(
      join(scratch, 'publish.config.yaml'),
      'title: Foreign Garden\norigin: https://notes.example.org/\nexclude:\n  - "drafts/**"\n',
      'utf8',
    );
    const reviewOutput = run(process.execPath, [binary, 'review'], scratch);
    assert(reviewOutput.includes('publish set review written: 2 notes'), 'review did not record the public set');
    run('git', ['add', '--', '.publish-set.json'], scratch);
    run('git', ['commit', '--quiet', '-m', 'review publish set'], scratch);
    const buildOutput = run(process.execPath, [binary, 'build', '--release'], scratch);
    const lines = buildOutput.trim().split(/\r?\n/);
    assert(lines.length === 5, 'release build wrote more or fewer than its five documented lines: ' + buildOutput);
    assert(lines[0]?.startsWith('secret scan ok:'), 'release build did not finish its secret scan');
    assert(lines[1]?.startsWith('residue scan ok:'), 'build did not finish its residue scan');
    assert(lines[2] === 'site written', 'build did not report a written site');
    assert(lines[3]?.includes('2 published'), 'build did not publish exactly the public fixture notes');
    assert(lines[4]?.startsWith('report:'), 'build did not point to its private report');

    const dist = join(scratch, 'dist');
    const welcome = readFileSync(join(dist, 'notes', 'welcome', 'index.html'), 'utf8');
    assert(welcome.includes('Welcome · Foreign Garden'), 'configured title did not reach the note page');
    assert(welcome.includes('href="/private/"'), 'the withheld-note link is not live');
    assert(welcome.includes('href="/notes/second/"'), 'the public link to the second note is absent');
    assert(welcome.includes('language-math'), 'client math fallback did not ship');
    assert(welcome.includes('language-mermaid'), 'client diagram fallback did not ship');
    assert(!welcome.includes('PRIVATE-BODY-MUST-NOT-SHIP'), 'withheld body reached its linking page');

    // --- Image assets: six files, one filename with a space and CJK, a
    // photograph shared with the second note, and the figure/layout cases ---
    const assetFiles = readdirSync(join(dist, '_assets')).sort();
    assert(assetFiles.length === 6, 'the foreign output carries ' + assetFiles.length + ' image assets: ' + assetFiles.join(', '));
    for (const file of assetFiles) {
      const bytes = readFileSync(join(dist, '_assets', file));
      const digest = createHash('sha256').update(bytes).digest('hex');
      assert(digest === file.slice(0, 64), file + ' does not hash to the digest its URL names');
    }
    assert(
      assetFiles.some((file) => file.includes('图 表 one')),
      'the Unicode-named image did not publish under its own name: ' + assetFiles.join(', '),
    );
    const welcomeImages = [...welcome.matchAll(/<img src="(\/_assets\/[^"]+)"/g)].map((match) => match[1]!);
    assert(welcomeImages.length === 8, 'the foreign page points at ' + welcomeImages.length + ' asset URLs');
    // The packaged renderer, not a test fixture, produced these: one figure with
    // the author's caption, distinct alt text, header dimensions, and a lazy
    // rule for everything after the lead.
    assert(
      /<figure class="image-figure"><img [^>]*alt="a narrow portrait gradient"[^>]*width="24" height="72"[^>]*\/><figcaption>A packaged portrait caption<\/figcaption><\/figure>/.test(
        welcome,
      ),
      'the packaged build did not render a captioned figure with its dimensions: ' + welcome,
    );
    assert(
      /<li><figure class="image-figure"><img [^>]*alt="a tight-list portrait"[^>]*\/><figcaption>A tight-list caption<\/figcaption><\/figure><\/li>/.test(
        welcome,
      ),
      'the packaged build did not promote a tight-list item to one figure: ' + welcome,
    );
    assert(
      /<img [^>]*alt="a wide screenshot"[^>]*width="480" height="120"[^>]*loading="lazy"/.test(welcome),
      'the packaged build did not reserve the wide screenshot with lazy loading: ' + welcome,
    );
    assert(
      /<img [^>]*alt=""[^>]*width="96" height="96"[^>]*loading="lazy"/.test(welcome),
      'the decorative image lost its empty alt or dimensions: ' + welcome,
    );
    assert(
      /<img [^>]*loading="eager"[^>]*>/.test(welcome),
      'the packaged page has no eager lead image: ' + welcome,
    );
    const secondHtml = readFileSync(join(dist, 'notes', 'second', 'index.html'), 'utf8');
    const shared = welcomeImages.filter((url) => secondHtml.includes(url));
    assert(shared.length === 1, 'the two foreign notes share ' + shared.length + ' image URLs, not one');

    assert(
      !welcome.includes('INDEX-CONTROL-JOINED-TEXT'),
      'the Pagefind control degraded into a raw HTML substring',
    );
    // Deliberately an independent oracle from the Action-parity check
    // (`.github/scripts/assert-action-artifact.ts`): the two gates examine
    // different artifacts built by different paths, so a bug in one instrument
    // cannot hide a real disclosure from the other. The rule both implement is
    // the same — every file under `dist/` carries no forbidden marker in its
    // raw bytes or an inflated gzip member, with a positive control proving the
    // scan ran — so a change to it must be applied to both.
    let inflatedText = '';
    const outputText = filesUnder(dist)
      .filter((file) => !/\.(?:avif|gif|ico|jpe?g|png|webp|woff2?)$/i.test(file))
      .map((file) => {
        const artifact = artifactText(file);
        if (artifact.inflated) inflatedText += artifact.text + '\n';
        return artifact.text;
      })
      .join('\n');
    assert(
      inflatedText.includes('INDEX-CONTROL-JOINED-TEXT'),
      'no inflated Pagefind member carried its joined-text positive control',
    );
    for (const forbidden of ['PRIVATE-BODY-MUST-NOT-SHIP', 'DRAFT-BODY-MUST-NOT-SHIP']) {
      assert(!outputText.includes(forbidden), 'foreign artifact contains forbidden marker ' + forbidden);
    }

    const snapshots = snapshotMembers(dist);
    assert(snapshots.length === 1, 'foreign artifact does not carry exactly one snapshot');
    const database = openSnapshot(dist);
    let publicNotes: { slug: string; title: string }[];
    try {
      publicNotes = database
        .prepare('SELECT slug, title FROM nodes ORDER BY slug')
        .all() as unknown as { slug: string; title: string }[];
    } finally {
      database.close();
    }
    assert(
      publicNotes.length === 2 && publicNotes[0]!.slug === 'second' && publicNotes[1]!.slug === 'welcome',
      'snapshot is not the reviewed public set: ' + publicNotes.map((note) => note.slug).join(', '),
    );
    // The browser checks below take this title from the artifact the browser is
    // served, not from a hand-typed copy: a preview compared against the fixture
    // would pass even if the projection renamed the note.
    const secondTitle = publicNotes.find((note) => note.slug === 'second')!.title;

    const reportPath = join(scratch, '.git', 'publish-report', 'content-report.json');
    const report = JSON.parse(
      readFileSync(reportPath, 'utf8'),
    ) as {
      status: string;
      dropped: { path: string; reason: string }[];
    };
    assert(report.status === 'complete', 'publication report did not complete');
    assert(
      report.dropped.some((item) => item.path === 'private.md' && item.reason === 'excluded-by-frontmatter'),
      'frontmatter exclusion is absent from the private report',
    );
    assert(
      report.dropped.some((item) => item.path === 'drafts/roadmap.md' && item.reason === 'excluded-by-pattern'),
      'pattern exclusion is absent from the private report',
    );

    // --- Real browser: the foreign artifact's own Worker, WASM, and snapshot ---
    //
    // Everything above read the output as files. This serves it under the
    // generated `dist/_headers` — the host configuration a deployment applies,
    // not the producer's `public/_headers` — so the runtime checks below only
    // pass if this artifact's own JS, WASM, and DB work under the deployed CSP.
    const server = await serveDist(dist, { headersFile: join(dist, '_headers') });
    // Resolved once: `workerScriptPath` reads the built `_astro/` directory, and
    // the assertion below would otherwise rescan it for every request recorded.
    const workerChunk = workerScriptPath(dist);
    const browser = await launchSmokeBrowser();
    try {
      await checkImages(browser, server, assetFiles);

      await checkReadingAndPreview(browser, server, workerChunk, secondTitle);

      await checkTagEnumeration(browser, server, publicNotes);

      await checkGraph(browser, server);

      await checkStaticFallback(browser, server);
    } finally {
      await browser.close();
      await server.close();
    }

    // --- The shipped preview accepts this exact output, and only on loopback ---
    await checkShippedPreview(binary, scratch);

    const planted = 'ghp_4fJ9xQ2mN7vL5sT8yR1cW6kP3dH0bA9eZ7uC';
    const sourcePath = join(scratch, 'welcome.md');
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8') + `\ntoken=${planted}\n`, 'utf8');
    const rejected = spawnSync(process.execPath, [binary, 'build', '--release'], {
      cwd: scratch,
      encoding: 'utf8',
    });
    assert(rejected.status !== 0, 'a release carrying a credential passed the scan');
    const rejectedStreams = rejected.stdout + rejected.stderr;
    assert(
      /secret scan found [1-9]\d* findings?/.test(rejectedStreams),
      'release failure did not report a finding count: ' + rejectedStreams.replaceAll(planted, '<REDACTED>'),
    );
    assert(!rejectedStreams.includes(planted), 'release failure printed the matched credential');
    assert(!rejectedStreams.includes('welcome.md'), 'release failure printed the source filename');
    const failedReport = readFileSync(reportPath, 'utf8');
    assert(!failedReport.includes(planted), 'private report preserved the matched credential');
    assert(failedReport.includes('github-pat'), 'private report omitted the sanitized rule id');
    assert(readFileSync(join(dist, 'notes', 'welcome', 'index.html'), 'utf8') === welcome, 'failed release replaced the last good output');

    // --- A missing image fails the build and leaves the last good output ---
    //
    // The secret case above proves preservation for a scan failure *after* the
    // output was built. This one proves it for a producer failure *before* Astro
    // ran: the previous `dist/` must be untouched, and the stream must count the
    // reasons without naming the private source path.
    writeFileSync(join(scratch, 'welcome.md'), readFileSync(join(scratch, 'welcome.md'), 'utf8').replace(/\ntoken=\S+\n?$/, '\n'), 'utf8');
    writeFileSync(
      join(scratch, 'second.md'),
      readFileSync(join(scratch, 'second.md'), 'utf8') + '\n![a file that is not there](media/zzqmissing.png)\n',
      'utf8',
    );
    const imageRejected = spawnSync(process.execPath, [binary, 'build', '--release'], { cwd: scratch, encoding: 'utf8' });
    assert(imageRejected.status !== 0, 'a build whose note embeds a missing image succeeded');
    const imageStreams = imageRejected.stdout + imageRejected.stderr;
    assert(/image reference/.test(imageStreams), 'the failure did not say an image could not be published: ' + imageStreams);
    assert(!imageStreams.includes('zzqmissing'), 'the failure printed the private image path: ' + imageStreams);
    assert(!imageStreams.includes('second.md'), 'the failure printed the note filename: ' + imageStreams);
    assert(
      readFileSync(join(dist, 'notes', 'welcome', 'index.html'), 'utf8') === welcome,
      'a failed build replaced the last good output',
    );

    console.log('tarball adoption smoke ok: 2 published notes, 2 withheld notes, 6 images');
    console.log('tarball: ' + basename(TARBALL));
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
