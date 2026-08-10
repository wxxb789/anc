/**
 * Renders `public/og-card.png`, the site's single social card.
 *
 * **Run by hand, never by the build.** The card is one image that does not
 * depend on the corpus, so generating it on every build would be work with no
 * output change — and a build step that rasterizes is exactly the cost the
 * satori + sharp decision rejected. The PNG is committed; this script is how it
 * is reviewed and regenerated:
 *
 *     node scripts/render-og-card.ts
 *
 * Playwright rather than a new dependency: it is already a devDependency, used
 * by `tests/rendered-page.test.ts`, and it is already the tool this repository
 * reaches for when something has to be measured as a browser would draw it.
 * satori + sharp would be 22 packages and a native binary for a file that
 * changes when the site is renamed.
 *
 * The markup below is inline rather than a sibling `.svg` file so the card has
 * exactly one source. Colours are the light-palette literals from
 * `src/styles/tokens.css`; a social card is composited by someone else's client
 * on a background this site does not control, so it cannot follow
 * `prefers-color-scheme` and picks the light palette deliberately.
 */

import { fileURLToPath } from 'node:url';
import { SITE_NAME, SITE_SUBTITLE } from '../src/lib/site.ts';

/** 2:1, which is what `twitter:card=summary_large_image` and Open Graph expect. */
const WIDTH_PX = 1200;
const HEIGHT_PX = 600;

/**
 * The card, as a document a browser can lay out.
 *
 * The mark is the `public/favicon.svg` path, inline and scaled. System fonts
 * only: `src/styles/tokens.css` ships no font file, so naming a webfont here
 * would render the card in a fallback nobody chose.
 */
const CARD = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${WIDTH_PX}px;
    height: ${HEIGHT_PX}px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 28px;
    padding: 88px;
    background: #fbfaf7;
    border-bottom: 16px solid #1f6f3c;
    color: #1b1f24;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  svg { width: 96px; height: 96px; fill: #1f6f3c; }
  h1 { font-size: 84px; font-weight: 700; letter-spacing: -0.02em; }
  p { font-size: 34px; line-height: 1.4; color: #535d69; max-width: 22em; }
</style>
<svg viewBox="0 0 128 128" aria-hidden="true"><path d="M50.4 78.5a75.1 75.1 0 0 0-28.5 6.9l24.2-65.7c.7-2 1.9-3.2 3.4-3.2h29c1.5 0 2.7 1.2 3.4 3.2l24.2 65.7s-11.6-7-28.5-7L67 45.5c-.4-1.7-1.6-2.8-2.9-2.8-1.3 0-2.5 1.1-2.9 2.7L50.4 78.5Zm-1.1 28.2Zm-4.2-20.2c-2 6.6-.6 15.8 4.2 20.2a17.5 17.5 0 0 1 .2-.7 5.5 5.5 0 0 1 5.7-4.5c2.8.1 4.3 1.5 4.7 4.7.2 1.1.2 2.3.2 3.5v.4c0 2.7.7 5.2 2.2 7.4a13 13 0 0 0 5.7 4.9v-.3l-.2-.3c-1.8-5.6-.5-9.5 4.4-12.8l1.5-1a73 73 0 0 0 3.2-2.2 16 16 0 0 0 6.8-11.4c.3-2 .1-4-.6-6l-.8.6-1.6 1a37 37 0 0 1-22.4 2.7c-5-.7-9.7-2-13.2-6.2Z"/></svg>
<h1>${SITE_NAME}</h1>
<p>${SITE_SUBTITLE}</p>
</html>`;

async function main(): Promise<number> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH_PX, height: HEIGHT_PX } });
    await page.setContent(CARD, { waitUntil: 'load' });
    const output = fileURLToPath(new URL('../public/og-card.png', import.meta.url));
    await page.screenshot({ path: output, type: 'png' });
    console.log(`wrote ${output} (${WIDTH_PX}x${HEIGHT_PX})`);
    return 0;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
