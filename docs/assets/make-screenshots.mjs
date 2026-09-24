/**
 * Generator for the README screenshots. The diagrams are drawn by `make-card.mjs`.
 *
 * Not part of the product, for the reason `make-card.mjs` gives. Run it from the
 * repository root with `node docs/assets/make-screenshots.mjs` after a
 * `pnpm install`. It writes a small synthetic garden to a temporary directory,
 * builds it with this checkout's own `bin/anc.mjs`, serves it with the shipped
 * `preview`, and photographs real pages — so every screenshot is the product's
 * actual output, not a mock-up. The corpus is invented; it names no one.
 *
 * Images are written as WebP. Playwright screenshots only as PNG or JPEG, so each
 * PNG is re-encoded by Chromium's own canvas encoder: no image dependency added.
 */
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const QUALITY = 0.82;

const NOTES = {
  'publish.config.yaml': ['title: Field Notes', 'exclude:', '  - "private/**"'],
  'ideas/evergreen-notes.md': [
    '---', 'title: Evergreen notes',
    'description: Notes written to be revised, linked, and read again.',
    'tags: [writing, method]', 'aliases: [Living notes]', '---', '',
    'An evergreen note is written for a future reader, which is usually you.',
    'Each one states a single idea and links to the notes it depends on — see',
    '[[linking-over-filing]] and [[small-atomic-notes]].', '',
    '## Why they compound', '',
    'A note that links outward keeps earning attention: every [[backlinks-matter|backlink]]',
    'is a second route in. Progress on this garden is tracked in [[projects/garden-roadmap]].', '',
    '> [!tip] Write the title as a claim', '> "Links beat folders" is a note. "Folders" is a bucket.',
  ],
  'ideas/linking-over-filing.md': [
    '---', 'title: Linking over filing', 'tags: [method]', '---', '',
    'A folder answers "where does this live". A link answers "what is this about".',
    'The second question stays useful as the collection grows; see [[evergreen-notes]].', '',
    'Related: [[small-atomic-notes]], [[reading/how-to-take-smart-notes]].',
  ],
  'ideas/small-atomic-notes.md': [
    '---', 'title: Small, atomic notes', 'tags: [method, writing]', '---', '',
    'One idea per note makes a link precise. It pairs with [[linking-over-filing]]',
    'and is the unit of an [[evergreen-notes|evergreen note]].',
  ],
  'ideas/backlinks-matter.md': [
    '---', 'title: Backlinks matter', 'tags: [method]', '---', '',
    'A backlink is the reverse of a citation. On this site each one is computed at',
    'build time and rendered as plain HTML, so it works without JavaScript.', '',
    'Built on: [[evergreen-notes]], [[projects/static-first]].',
  ],
  'projects/garden-roadmap.md': [
    '---', 'title: Garden roadmap', 'tags: [project]', '---', '',
    '- [x] Move notes into git', '- [x] Publish with [[static-first|a static build]]',
    '- [ ] Write up [[reading/the-garden-and-the-stream]]', '',
    'The private draft [[private/salary-negotiation]] stays out of the site: its link goes to a notice page.',
  ],
  'projects/static-first.md': [
    '---', 'title: Static first', 'tags: [project, web]', '---', '',
    'Every page is plain HTML. Search is [Pagefind](https://pagefind.app), a static index',
    'fetched only when opened. See [[search-without-a-server]].',
  ],
  'projects/search-without-a-server.md': [
    '---', 'title: Search without a server', 'tags: [web]', '---', '',
    'A static search index costs bytes only on the first query. Compare [[static-first]].',
  ],
  'reading/how-to-take-smart-notes.md': [
    '---', 'title: How to Take Smart Notes', 'tags: [reading, method]', '---', '',
    'On the slip-box. The part worth keeping is [[ideas/small-atomic-notes]]',
    'and the habit of [[ideas/linking-over-filing]].',
  ],
  'reading/the-garden-and-the-stream.md': [
    '---', 'title: The garden and the stream', 'tags: [reading, writing]', '---', '',
    'A timeline against a garden of linked notes. This site is the garden; see',
    '[[ideas/evergreen-notes]] and [[projects/garden-roadmap]].',
  ],
  'journal/2026-09-weekly-review.md': [
    '---', 'title: Weekly review — September', 'tags: [journal]', '---', '',
    'Revised [[ideas/backlinks-matter]], started [[reading/the-garden-and-the-stream]].',
  ],
  'journal/2026-08-weekly-review.md': [
    '---', 'title: Weekly review — August', 'tags: [journal]', '---', '',
    'Moved everything into git. Next: [[projects/static-first]].',
  ],
  'private/salary-negotiation.md': ['---', 'publish: false', '---', '', 'Not for the site.'],
};


function writeCorpus() {
  const root = mkdtempSync(join(tmpdir(), 'readme-garden-'));
  for (const [path, lines] of Object.entries(NOTES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${lines.join('\n')}\n`);
  }
  // A fixed date, so the "Published" line does not change on every regeneration.
  const date = '2026-09-01T09:00:00Z';
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=example', '-c', 'user.email=example@example.org', 'commit', '-qm', 'notes');
  return root;
}

function serve(dist) {
  const child = spawn(process.execPath, ['bin/anc.mjs', 'preview', '--dist', dist, '--port', '4610'], { cwd: ROOT });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      const match = /preview: (http:\S+)/.exec(String(chunk));
      if (match) resolve({ url: match[1].replace(/\/$/, ''), stop: () => child.kill() });
    });
    child.on('exit', (code) => reject(new Error(`preview exited ${code}`)));
  });
}

async function saveWebp(page, png, file) {
  const data = await page.evaluate(async ({ base64, quality }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas.toDataURL('image/webp', quality).split(',')[1];
  }, { base64: png.toString('base64'), quality: QUALITY });
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  console.log(`wrote ${file}`);
}

const corpus = writeCorpus();
const dist = join(corpus, 'dist');
execFileSync(process.execPath, ['bin/anc.mjs', 'build', '--content', corpus, '--out', dist], { cwd: ROOT, stdio: 'inherit' });
const server = await serve(dist);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
  const encoder = await browser.newPage();
  const shot = async (file, options) => saveWebp(encoder, await page.screenshot(options), file);
  const open = async (path) => {
    await page.goto(server.url + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
  };

  await open('/notes/ideas-evergreen-notes/');
  await shot('screenshot-note.webp');

  // Clipped against the full page, so the sticky header stays out of frame.
  const span = async (from, to) => {
    const top = await page.locator(from).boundingBox();
    const bottom = await page.locator(to).boundingBox();
    const y = top.y - 24;
    return { x: top.x - 24, y, width: top.width + 48, height: bottom.y + bottom.height + 24 - y };
  };
  await shot('screenshot-relationships.webp', {
    fullPage: true,
    clip: await span('[aria-labelledby="outgoing-title"]', '[aria-labelledby="backlinks-title"]'),
  });
  await shot('screenshot-graph.webp', { fullPage: true, clip: await span('section.graph-region', 'section.graph-region') });

  await open('/notes/projects-garden-roadmap/');
  await page.locator('article a[href*="static-first"]').first().hover();
  await page.waitForSelector('#link-preview:not([hidden])', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await shot('screenshot-preview.webp', { clip: { x: 160, y: 100, width: 700, height: 420 } });

  await page.click('#search-toggle');
  await page.fill('#search-input', 'backlink');
  await page.waitForTimeout(1500);
  await shot('screenshot-search.webp', { clip: { x: 280, y: 140, width: 720, height: 520 } });
} finally {
  await browser.close();
  server.stop();
  rmSync(corpus, { recursive: true, force: true, maxRetries: 5 });
}
