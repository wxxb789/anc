/**
 * Renders `public/og-card.png`, the default social card every build ships.
 *
 * **It carries no name, and that is the whole of TK-31's decision here.** The
 * card it replaced showed the wordmark `thoughtscape` above "A reviewed public
 * projection from a private knowledge garden" — and this file ships in the
 * tarball, so *every site built with this tool* served one owner's brand and one
 * owner's description of a publication model the tool does not have. TK-24
 * measured that leak by building a package and looking at it, and judged that
 * excluding the file would make every build 404 its own `og:image` — right, and
 * it kept this owner's card as the placeholder, which is the half this ticket
 * owes.
 *
 * Four options were weighed:
 *
 * 1. **Render the configured title into the card at build time.** The correct
 *    end state and not available: it needs a rasterizer in `dependencies`, which
 *    is the cost the satori + sharp decision already rejected, and Playwright is
 *    a devDependency that a consumer's install does not carry.
 * 2. **Ship no card and omit `og:image` unless the user configures one** — plan
 *    §4.2's choice, and the best of these. It needs `SiteMetadata.astro` to make
 *    three tags conditional and a `brand.socialCard` key the config does not
 *    have, so it is named here as the follow-up rather than half-built.
 * 3. **Ship this owner's card.** The status quo, and the leak.
 * 4. **Ship a card that names nobody.** What this does.
 *
 * A card with no text says nothing false on anybody's site, needs no
 * rasterization at build time, and 404s nowhere. What it gives up is the thing a
 * wordmark buys — a share that shows the site's name — and that loss is smaller
 * than it looks: `og:title` and `og:site_name` carry the name in the same card,
 * and since TK-31 both are the *user's* configured title rather than a literal.
 * So the name still appears; it is rendered by the consumer from text rather
 * than baked into an image that cannot know it.
 *
 * The mark is `public/favicon.svg`'s, which is deliberate rather than an
 * oversight: plan §4.2 lists the icon's default as "the shipped default", so a
 * neutral shipped mark is already the accepted treatment for this class of
 * asset. What was not accepted, and is removed, is the *name*.
 *
 * **Run by hand, never by the build.** The card does not depend on the corpus,
 * so generating it every build would be work with no output change. The PNG is
 * committed; this script is how it is reviewed and regenerated:
 *
 *     node scripts/render-og-card.ts
 *
 * Playwright rather than a new dependency: it is already a devDependency, used
 * by `tests/rendered-page.test.ts`, and it is already the tool this repository
 * reaches for when something has to be measured as a browser would draw it.
 *
 * The markup below is inline rather than a sibling `.svg` file so the card has
 * exactly one source. Colours are the light-palette literals from
 * `src/styles/tokens.css`; a social card is composited by someone else's client
 * on a background this site does not control, so it cannot follow
 * `prefers-color-scheme` and picks the light palette deliberately.
 */

import { fileURLToPath } from 'node:url';

/** 2:1, which is what `twitter:card=summary_large_image` and Open Graph expect. */
const WIDTH_PX = 1200;
const HEIGHT_PX = 600;

/**
 * The card, as a document a browser can lay out.
 *
 * **No text node anywhere, and no import of `SITE_NAME`.** The earlier version
 * read that constant and the navigation-language subtitle, which is what put one
 * owner's name into the shipped image. It is worth stating why interpolating the
 * *new* `SITE_NAME` would be worse rather than better: it now resolves from
 * whatever configuration the person running this script happens to have, so a
 * contributor with a `publish.config.yaml` on disk would silently commit **their**
 * site's name as the default card for every user. A file with no text cannot
 * acquire one by accident.
 *
 * The mark is centred rather than set beside a title, because there is no title
 * for it to sit beside; a lone glyph in the top-left of an empty 1200×600 frame
 * reads as a rendering failure.
 */
const CARD = `<!doctype html>
<html>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${WIDTH_PX}px;
    height: ${HEIGHT_PX}px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fbfaf7;
    border-bottom: 16px solid #1f6f3c;
  }
  svg { width: 220px; height: 220px; fill: #1f6f3c; }
</style>
<svg viewBox="0 0 128 128" aria-hidden="true"><path d="M50.4 78.5a75.1 75.1 0 0 0-28.5 6.9l24.2-65.7c.7-2 1.9-3.2 3.4-3.2h29c1.5 0 2.7 1.2 3.4 3.2l24.2 65.7s-11.6-7-28.5-7L67 45.5c-.4-1.7-1.6-2.8-2.9-2.8-1.3 0-2.5 1.1-2.9 2.7L50.4 78.5Zm-1.1 28.2Zm-4.2-20.2c-2 6.6-.6 15.8 4.2 20.2a17.5 17.5 0 0 1 .2-.7 5.5 5.5 0 0 1 5.7-4.5c2.8.1 4.3 1.5 4.7 4.7.2 1.1.2 2.3.2 3.5v.4c0 2.7.7 5.2 2.2 7.4a13 13 0 0 0 5.7 4.9v-.3l-.2-.3c-1.8-5.6-.5-9.5 4.4-12.8l1.5-1a73 73 0 0 0 3.2-2.2 16 16 0 0 0 6.8-11.4c.3-2 .1-4-.6-6l-.8.6-1.6 1a37 37 0 0 1-22.4 2.7c-5-.7-9.7-2-13.2-6.2Z"/></svg>
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
