/**
 * Generator for the repository's social card and README banner.
 *
 * Not part of the product: `docs/` is outside the package `files` list, so this
 * script and the PNGs it writes never reach a consumer's `node_modules`. Run it
 * from the repository root with `node docs/assets/make-card.mjs` after a
 * `pnpm install`; Playwright's Chromium is the only tool it needs, and it is
 * already a devDependency for the browser gates. The two images it writes are
 * committed:
 *
 * - `social-preview.png` — uploaded by hand in GitHub Settings → Social preview,
 *   which the API does not expose.
 * - `readme-banner.webp` — embedded at the top of both READMEs. WebP, re-encoded
 *   by Chromium's canvas the way `make-screenshots.mjs` does, at a fifth of the
 *   PNG's size; the social preview stays PNG because GitHub's upload takes no WebP.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./', import.meta.url));
mkdirSync(OUT, { recursive: true });

// Filled with the site's dark-theme accent, so the card and the product agree.
const MARK_PATH =
  'M50.4 78.5a75.1 75.1 0 0 0-28.5 6.9l24.2-65.7c.7-2 1.9-3.2 3.4-3.2h29c1.5 0 2.7 1.2 3.4 3.2l24.2 65.7s-11.6-7-28.5-7L67 45.5c-.4-1.7-1.6-2.8-2.9-2.8-1.3 0-2.5 1.1-2.9 2.7L50.4 78.5Zm-1.1 28.2Zm-4.2-20.2c-2 6.6-.6 15.8 4.2 20.2a17.5 17.5 0 0 1 .2-.7 5.5 5.5 0 0 1 5.7-4.5c2.8.1 4.3 1.5 4.7 4.7.2 1.1.2 2.3.2 3.5v.4c0 2.7.7 5.2 2.2 7.4a13 13 0 0 0 5.7 4.9v-.3l-.2-.3c-1.8-5.6-.5-9.5 4.4-12.8l1.5-1a73 73 0 0 0 3.2-2.2 16 16 0 0 0 6.8-11.4c.3-2 .1-4-.6-6l-.8.6-1.6 1a37 37 0 0 1-22.4 2.7c-5-.7-9.7-2-13.2-6.2Z';

const NODES = [
  [200, 46, 13], [96, 132, 9], [316, 126, 11], [40, 244, 8],
  [172, 236, 15], [300, 240, 9], [112, 352, 10], [246, 344, 12], [356, 300, 8],
];
const EDGES = [
  [0, 1], [0, 2], [1, 3], [1, 4], [2, 4], [2, 5],
  [4, 6], [4, 7], [5, 7], [5, 8], [7, 8], [6, 3],
];

const graph = `
<svg viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg">
  ${EDGES.map(([a, b]) => {
    const [x1, y1] = NODES[a];
    const [x2, y2] = NODES[b];
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(233,237,242,0.20)" stroke-width="1.6"/>`;
  }).join('')}
  ${NODES.map(([x, y, r], i) => {
    const fill = i === 4 ? '#8ad884' : '#86c8e6';
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" fill-opacity="0.92"/>`;
  }).join('')}
</svg>`;

const CHIPS = ['backlinks', 'link graph', 'Pagefind search', 'static HTML', 'MIT licensed'];

function page(tagline, { compact }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body {
    background: #0d1013; color: #e9edf2;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, "Noto Sans", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
  .glow { position: absolute; inset: 0; background:
      radial-gradient(900px 520px at 88% -12%, rgba(134,200,230,.17), transparent 62%),
      radial-gradient(760px 520px at -8% 112%, rgba(138,216,132,.15), transparent 60%); }
  .grid { position: absolute; inset: 0; opacity: .5;
    background-image:
      linear-gradient(rgba(233,237,242,.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(233,237,242,.045) 1px, transparent 1px);
    background-size: 46px 46px;
    -webkit-mask-image: radial-gradient(circle at 46% 42%, #000, transparent 76%);
    mask-image: radial-gradient(circle at 46% 42%, #000, transparent 76%); }
  .content { position: relative; height: 100%; display: grid;
    grid-template-columns: 1.38fr .86fr; gap: 40px; align-items: center;
    padding: 68px 78px; }
  .brand { display: flex; align-items: center; gap: 16px; }
  .mark { width: 54px; height: 54px; flex: none; }
  .wordmark { font-size: 66px; font-weight: 800; letter-spacing: -.035em; line-height: 1; }
  .tagline { margin-top: 22px; font-size: 41px; font-weight: 700;
    letter-spacing: -.015em; line-height: 1.13; max-width: 15ch; }
  .tagline em { font-style: normal; color: #8ad884; }
  .sub { margin-top: 18px; font-size: 20px; line-height: 1.5; color: #a4b0be;
    max-width: 36ch; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
  .chip { font-size: 16px; padding: 8px 15px; border-radius: 999px;
    border: 1px solid #2b323c; background: rgba(22,27,33,.78); color: #cdd6e0; }
  .art { display: flex; justify-content: center; align-items: center; }
  .art svg { width: 100%; max-width: 430px; height: auto;
    filter: drop-shadow(0 0 34px rgba(134,200,230,.20)); }
  .footer { position: absolute; left: 78px; bottom: 44px; font-size: 18px; color: #a4b0be; }
  .footer b { color: #8ad884; font-weight: 600; }
  @media (max-height: 470px) {
    .content { grid-template-columns: 1.75fr .8fr; padding: 40px 68px; }
    .wordmark { font-size: 48px; }
    .mark { width: 40px; height: 40px; }
    .tagline { font-size: 29px; margin-top: 14px; max-width: 24ch; }
    .sub, .chips, .footer { display: none; }
    .art svg { max-width: 244px; }
  }
</style></head>
<body><div class="card">
  <div class="glow"></div><div class="grid"></div>
  <div class="content">
    <div class="left">
      <div class="brand">
        <svg class="mark" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="${MARK_PATH}" fill="#8ad884"/>
        </svg>
        <div class="wordmark">anc</div>
      </div>
      <div class="tagline">${tagline}</div>
      ${compact ? '' : '<div class="sub">Turn a git repository of Markdown into fast, self-hosted static pages — with backlinks, a link graph, and search. Every note publishes unless you exclude it.</div>'}
      ${compact ? '' : `<div class="chips">${CHIPS.map((c) => `<span class="chip">${c}</span>`).join('')}</div>`}
    </div>
    <div class="art">${graph}</div>
  </div>
  ${compact ? '' : '<div class="footer">github.com/wxxb789/anc &nbsp;·&nbsp; <b>MIT</b> &nbsp;·&nbsp; no trackers</div>'}
</div></body></html>`;
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function shot(file, html, width, height, scale) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await p.setContent(html, { waitUntil: 'load' });
  const png = await p.screenshot();
  if (file.endsWith('.webp')) {
    const data = await p.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: image.naturalWidth, height: image.naturalHeight });
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/webp', 0.9).split(',')[1];
    }, png.toString('base64'));
    writeFileSync(`${OUT}${file}`, Buffer.from(data, 'base64'));
  } else {
    writeFileSync(`${OUT}${file}`, png);
  }
  await p.close();
  console.log(`wrote ${file} at ${width * scale}x${height * scale}`);
}

await shot(
  'social-preview.png',
  page('A privacy-preserving static site generator for <em>Markdown</em>', { compact: false }),
  1280, 640, 1,
);
await shot(
  'readme-banner.webp',
  page('A privacy-preserving static site generator for <em>Markdown</em>', { compact: true }),
  1280, 360, 2,
);

await browser.close();
