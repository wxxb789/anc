/**
 * Assertions over the built site.
 *
 * These cannot be made against the source: the CSP requirement is about what
 * Astro *emits*, and the layout shell is only assembled at build time. Run
 * `pnpm run build` before `pnpm test`; the suite fails loudly rather than
 * skipping when `dist/` is absent, because a security gate that quietly
 * disappears is worse than one that is inconvenient.
 *
 * The HTML tag scanners live in `support/css-cascade.ts` and carry their own
 * adversarial tests beside them.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { rawStartTags, startTags } from './support/css-cascade.ts';

const DIST = new URL('../dist/', import.meta.url);

function walk(dir: URL, extension: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const child = new URL(name, dir);
    if (statSync(child).isDirectory()) found.push(...walk(new URL(`${name}/`, dir), extension));
    else if (name.endsWith(extension)) found.push(fileURLToPath(child));
  }
  return found;
}

function builtFiles(extension: string): string[] {
  try {
    return walk(DIST, extension);
  } catch {
    return assert.fail(`dist/ is missing or unreadable — run \`pnpm run build\` before \`pnpm test\``);
  }
}

/** Pagefind's own bundle is a third-party artifact; these gates cover our output. */
const OURS = (file: string) => !file.includes('pagefind');

const PAGES = builtFiles('.html').filter(OURS);
const STYLESHEETS = builtFiles('.css').filter(OURS);

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

test('built pages exist', () => {
  assert.ok(PAGES.length > 0, 'the build produced no HTML pages');
  assert.ok(STYLESHEETS.length > 0, 'the build produced no stylesheet');
});

test('no page contains an inline script', () => {
  for (const file of PAGES) {
    for (const [, body] of read(file).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      assert.equal(
        body!.trim(),
        '',
        `${file}: contains an inline <script> body, which "script-src 'self'" forbids`,
      );
    }
  }
});

test('every script is loaded from this origin', () => {
  // A `data:` URL script body is empty, so the inline-script gate above passes
  // it while the CSP blocks it outright. Vite inlines a small `?url` asset as
  // exactly that when `assetsInlineLimit` is not 0, so this is one config
  // change away rather than hypothetical.
  for (const file of PAGES) {
    for (const [, source] of read(file).matchAll(/<script\b[^>]*\ssrc="([^"]*)"/gi)) {
      assert.ok(
        source!.startsWith('/'),
        `${file}: script src "${source}" is not a same-origin path`,
      );
    }
  }
});

test('no page contains an inline event handler', () => {
  for (const file of PAGES) {
    for (const tag of startTags(read(file))) {
      const handler = /\son[a-z]+\s*=/i.exec(tag);
      assert.equal(handler, null, `${file}: inline event handler in ${tag}`);
    }
  }
});

test('no page contains an inline style attribute or style element', () => {
  // Not required by TK-02, but the same CSP line ("style-src 'self'") governs it
  // and the cost of noticing here is one regex.
  for (const file of PAGES) {
    const html = read(file);
    for (const tag of startTags(html)) {
      assert.equal(/\sstyle\s*=/i.exec(tag), null, `${file}: inline style attribute in ${tag}`);
    }
    assert.equal(/<style\b/i.exec(html), null, `${file}: contains an inline <style> element`);
  }
});

test('every page carries the layout shell landmarks', () => {
  for (const file of PAGES) {
    const html = read(file);
    assert.match(html, /<a class="skip-link" href="#main">/, `${file}: missing skip link`);
    assert.match(html, /<main id="main"/, `${file}: skip link has no target landmark`);
    assert.match(html, /<header\b/, `${file}: missing header landmark`);
    assert.match(html, /<nav\b[^>]*aria-label="[^"]+"/, `${file}: nav has no accessible name`);
    assert.match(html, /<footer\b/, `${file}: missing footer landmark`);
  }
});

test('every page declares a language', () => {
  for (const file of PAGES) {
    const lang = /<html[^>]*\slang="([^"]+)"/.exec(read(file));
    assert.ok(lang, `${file}: <html> has no lang attribute`);
    assert.match(lang[1]!, /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, `${file}: lang is not a BCP 47 tag`);
  }
});

/**
 * A duplicate id makes every deep link into the page ambiguous: the browser
 * scrolls to the first match, which may not be the one the anchor was written
 * for. It is also the shape TK-05a's table of contents and Pagefind's own
 * result anchors both depend on being unique.
 *
 * The pairing matters as much as either half. Unique ids alone permit a
 * `href="#x"` pointing at nothing; resolvable fragments alone permit two
 * elements answering to the same name.
 */
test('no page contains a duplicate id, and every fragment link resolves', () => {
  for (const file of PAGES) {
    // Raw, not blanked: the attribute *values* are what this gate reads.
    const tags = [...rawStartTags(read(file))];
    const ids = tags.flatMap((tag) => {
      const id = /\sid="([^"]*)"/.exec(tag)?.[1];
      return id === undefined ? [] : [id];
    });
    assert.ok(ids.length > 0, `${file}: no element carries an id`);

    const seen = new Set<string>();
    for (const id of ids) {
      assert.ok(!seen.has(id), `${file}: duplicate id="${id}"`);
      seen.add(id);
    }

    for (const tag of tags) {
      if (!/^<a\b/i.test(tag)) continue;
      const target = /\shref="#([^"]*)"/.exec(tag)?.[1];
      // `href="#"` is a link to the top of the document, which is valid and
      // needs no target.
      if (target === undefined || target === '') continue;
      assert.ok(seen.has(target), `${file}: href="#${target}" resolves to no element on the page`);
    }
  }
});

test('every page carries its canonical route for print', () => {
  // Scope item 10: a printed page must carry its canonical URL. The absolute
  // origin is TK-08's; the route is what this ticket can honestly emit.
  for (const file of PAGES) {
    assert.match(
      read(file),
      /<p class="print-only">Published at \/[^<]*<\/p>/,
      `${file}: no printable canonical route`,
    );
  }
});

test('every control has an accessible name', () => {
  for (const file of PAGES) {
    const html = read(file);
    for (const [tag, attributes, text] of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const named =
        text!.replace(/<[^>]*>/g, '').trim() !== '' ||
        /\saria-label="[^"]+"/i.test(attributes!) ||
        /\saria-labelledby="[^"]+"/i.test(attributes!);
      assert.ok(named, `${file}: control has no accessible name: ${tag}`);
    }
  }
});

test('heading order never skips a level', () => {
  for (const file of PAGES) {
    const levels = [...read(file).matchAll(/<h([1-6])\b/gi)].map(([, level]) => Number(level));
    assert.equal(levels.filter((level) => level === 1).length, 1, `${file}: must have exactly one h1`);
    assert.equal(levels[0], 1, `${file}: first heading must be the h1`);
    for (const [index, level] of levels.entries()) {
      const previous = levels[index - 1];
      if (previous !== undefined) {
        assert.ok(level <= previous + 1, `${file}: heading order jumps from h${previous} to h${level}`);
      }
    }
  }
});

/*
 * Deliberately absent: the syntactic 320 px width scan.
 *
 * It proved no CSS rule *committed* to an over-wide box, which was the best
 * TK-02 could do without a browser and which its own report named the weakest
 * evidence in that ticket. `tests/rendered-page.test.ts` now lays out every
 * built route at 320 px and measures it, so the same property is checked
 * against what a reader actually gets — including the overflow this scan could
 * never see: caused by content, by a box-model property, or by a combination of
 * rules. Owner decision D3.
 */

/**
 * Every class the rendered article carries is styled, or is named as
 * deliberately unstyled with a reason.
 *
 * The gate reads the built pages rather than the renderer's allowlist, which
 * is the direction that cannot go stale: a class only has to be styled once it
 * actually ships. Nine classes were shipping unstyled before TK-12 —
 * twenty-one `token-*` spans, fifteen `heading-anchor`, eight `code-block` on
 * the single published note, so syntax highlighting rendered as undifferentiated
 * plain text and `sr-only` rendered as a visible heading.
 *
 * This is deliberately *not* the rejected proposal from the parity plan's §7.3,
 * which would have extracted every class `markdown.ts` *can* emit and become a
 * fourth consumer of `tests/support/css-cascade.ts`'s hand-written parser. It
 * reads what shipped and does one substring check per class.
 */
test('every class in the rendered article is styled or deliberately not', () => {
  // Named, with the reason, in the "deliberately unstyled" block of
  // `src/styles/global.css`. Repeated here so the two cannot silently diverge:
  // the stylesheet is asserted to name each of them.
  const UNSTYLED: Readonly<Record<string, string>> = {
    token: 'the bare Prism class; each specific token class carries the colour',
    'language-*': 'the fence language is carried by data-code-language',
    'callout-*': 'every kind gets one neutral treatment; the title text carries the kind',
  };

  const stylesheets = STYLESHEETS.map(read).join('\n');
  const globalSource = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  for (const name of Object.keys(UNSTYLED)) {
    assert.ok(
      globalSource.includes(name),
      `global.css does not record why "${name}" is unstyled — this gate's exemption list has drifted`,
    );
  }

  // Only the article body: page chrome is TK-02's and is styled by definition.
  const articles = PAGES.flatMap((file) => {
    const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(read(file));
    return article ? [{ file, html: article[1]! }] : [];
  });
  assert.ok(articles.length > 0, 'no article was found to check');

  const exempt = (name: string) =>
    Object.keys(UNSTYLED).some((pattern) =>
      pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
    );

  for (const { file, html } of articles) {
    for (const tag of rawStartTags(html)) {
      for (const name of /\sclass="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? []) {
        if (name === '' || exempt(name)) continue;
        // The trailing boundary matters: a bare `includes('.code')` would be
        // satisfied by the `.code-block` rule and wave through an unstyled
        // `code` class. A class selector ends at anything that is not a name
        // character.
        assert.match(
          stylesheets,
          new RegExp(`\\.${name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`),
          `${file}: class "${name}" ships with no CSS rule and is not recorded as deliberately unstyled`,
        );
      }
    }
  }
});

/*
 * Deliberately absent: a test that gunzips a `.pf_fragment` and asserts the
 * search index carries no page chrome. The parity plan's §7.3 rejects exactly
 * that ("no allowlist widening, no decompression test") in favour of the
 * `--exclude-selectors` flag in `package.json`'s build script, which is what
 * ships. A decompression test would re-add the machinery the flag replaced, and
 * it would test Pagefind rather than this repository. The index was verified by
 * hand once after the flag landed: title clean, 15/15 anchors clean, zero
 * occurrences of `Copy` or `← All notes`.
 */

test('the built stylesheet stays inside the initial-CSS budget', () => {
  // Requirements section 18 budgets initial CSS at 40 KB gzip, so the
  // comparison must be against gzipped bytes. TK-09 owns the enforced gate and
  // the full initial-CSS accounting. This keeps the design system honest about
  // its own contribution while it is being built.
  const bytes = STYLESHEETS.reduce((total, file) => total + gzipSync(readFileSync(file)).length, 0);
  assert.ok(bytes < 40 * 1024, `built CSS is ${bytes} bytes gzipped, over the 40 KB budget`);
});

/**
 * No search byte is requested before the reader asks for search.
 *
 * This is the one budget assertion that is binary rather than a threshold, and
 * the one Quartz structurally cannot pass — it loads its search bundle
 * `afterDOMLoaded` on every page. Until TK-12 it was false here too, for a
 * different reason: `Layout.astro` linked `/pagefind/pagefind-ui.css`
 * unconditionally, 2,599 B gzip on every route for a dialog most readers never
 * open. The stylesheet now loads with the bundle it styles, on first open.
 */
test('no page requests a search asset before the reader opens search', () => {
  for (const file of PAGES) {
    for (const tag of rawStartTags(read(file))) {
      const url = /\s(?:href|src)="([^"]*)"/.exec(tag)?.[1];
      assert.ok(
        url === undefined || !url.includes('/pagefind/'),
        `${file}: requests a search asset on first paint: ${tag}`,
      );
    }
  }
});

/*
 * Deliberately absent: the cascade-resolving no-JavaScript gate.
 *
 * It reimplemented CSS specificity, `!important`, document order, and media
 * query applicability in order to decide whether a competing rule beat the
 * `[data-js-only]` hiding rule. That was the right call without a browser, and
 * it caught a real defect. It is now `tests/rendered-page.test.ts`, which loads
 * each page with scripting disabled and reads the computed style — the
 * cascade's own verdict, produced by the implementation that ships rather than
 * by a reimplementation of it. Both directions are checked there: hidden
 * without scripting, offered with it. Owner decision D3.
 */
