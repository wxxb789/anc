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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'vitest';

import { rawStartTags, startTags } from './support/css-cascade.ts';
import { snapshotNotes } from './support/snapshot.ts';
import { DIAGRAM_MODE, REQUIRED_STYLE_SRC, STYLE_SRC_BY_MODE } from '../src/lib/diagram-mode.ts';

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

/**
 * No page carries an inline style — in the mode that ships.
 *
 * **This gate is mode-aware, and its non-vacuity is asserted rather than
 * assumed.** Owner decision 5 makes Mermaid dual-mode, and client mode violates
 * zero-inline-styles *by construction*: `render()` writes 26+ `style=`
 * attributes and injects a `<style>` element, which is why that mode needs
 * `style-src 'self' 'unsafe-inline'`. A gate that simply stopped asserting
 * under that mode would be worse than no gate — it reads as coverage while
 * measuring nothing.
 *
 * So the two modes get two different, equally binding assertions:
 *
 * - `build-time`: **zero** inline styles and zero `<style>` elements anywhere,
 *   which is the property that lets the CSP stay at `style-src 'self'`.
 * - `client`: the same zero over everything *except* a diagram figure, because
 *   the runtime writes into that subtree and nowhere else. A stray inline style
 *   in the page chrome is still a failure, and that is the part of the original
 *   guarantee client mode does not give up.
 *
 * Both branches count what they inspected and fail on zero, so neither can pass
 * by finding nothing to look at.
 */
test('no page contains an inline style attribute or style element', () => {
  let inspected = 0;

  for (const file of PAGES) {
    const html = read(file);
    // In client mode the diagram figure is the one place the runtime is
    // permitted to write inline styles. Removing that subtree leaves exactly
    // the region whose guarantee is unchanged between the two modes.
    const governed =
      DIAGRAM_MODE === 'client'
        ? html.replace(/<figure class="diagram"[\s\S]*?<\/figure>/gi, '')
        : html;

    for (const tag of startTags(governed)) {
      inspected += 1;
      assert.equal(/\sstyle\s*=/i.exec(tag), null, `${file}: inline style attribute in ${tag}`);
    }
    assert.equal(/<style\b/i.exec(governed), null, `${file}: contains an inline <style> element`);
  }

  assert.ok(inspected > 0, 'the gate inspected no markup, so it asserted nothing');
});

/**
 * The mode, the markup, and the deployed policy agree.
 *
 * A mode switch that changes what the pages contain but not what `_headers`
 * permits ships a page blocked by its own CSP — visibly, as a black rectangle
 * where the diagram should be. This is the gate that makes the two inseparable.
 */
test('the shipped CSP matches the diagram mode the build used', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const policy = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1];
  assert.ok(policy, 'public/_headers declares no Content-Security-Policy');

  const styleSrc = /(?:^|;)\s*style-src\s+([^;]+)/.exec(policy)?.[1]?.trim();
  assert.equal(
    styleSrc,
    REQUIRED_STYLE_SRC,
    `style-src is "${styleSrc}" but DIAGRAM_MODE is "${DIAGRAM_MODE}", which requires "${REQUIRED_STYLE_SRC}"`,
  );

  // The two modes must actually differ, or the assertion above is satisfied by
  // a constant and proves nothing about the coupling.
  assert.notEqual(
    STYLE_SRC_BY_MODE['build-time'],
    STYLE_SRC_BY_MODE.client,
    'the two modes declare the same style-src, so this gate cannot detect a mismatch',
  );
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

test('every page carries its canonical URL for print', () => {
  // Scope item 10: a printed page must carry its canonical URL. TK-05a emitted
  // the route and left the origin to TK-08, which configured `site:`; a printed
  // page has no address bar, so the absolute form is the whole point.
  //
  // The URL is asserted, not the sentence around it: since TK-16 that sentence
  // is per-document chrome, so a Chinese note prints "本页地址：<url>" and an
  // English one prints "Published at <url>". Matching either wording here would
  // make this gate fail on one of the two languages; matching the element and
  // the URL inside it is the property that actually matters, and
  // The wording is asserted by `tests/built-routes.test.ts`'s "no page renders a
  // string from a locale other than its own" gate, which covers `publishedAt`
  // through its fixed part.
  for (const file of PAGES) {
    const line = /<p class="print-only">([^<]*)<\/p>/.exec(read(file))?.[1];
    assert.ok(line !== undefined, `${file}: no printable canonical URL line`);
    assert.match(
      line,
      /https?:\/\/[^\s]+\//,
      `${file}: the printed line "${line}" carries no absolute URL`,
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
    // A diagram's own classes are excluded, and the exclusion is a *span* of the
    // document rather than a name pattern, because the two vocabularies must not
    // be allowed to overlap in this gate's judgement.
    //
    // Inside a rendered `<svg>`, `class` carries Mermaid's structural names —
    // `flowchart`, `node`, `edgePath`, `actor` — which name what a shape *is*,
    // not how it looks. TK-15's build-time renderer flattens Mermaid's own
    // stylesheet onto the elements as SVG presentation attributes, so those
    // classes are correctly styleless: the appearance travels in `fill`,
    // `stroke`, and the rest. Requiring a CSS rule for each would demand
    // hundreds of empty rules for names this project does not author and cannot
    // enumerate. The classes the *pipeline* writes into a diagram —
    // `diagram-center`, `diagram-nowrap`, and the rest of `LAYOUT_CLASSES` —
    // are checked, because they sit on the figure and its wrapper, outside the
    // SVG, where this gate still reads them.
    const outsideDiagrams = html.replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
    for (const tag of rawStartTags(outsideDiagrams)) {
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

/**
 * The bundler must not corrupt what it minifies.
 *
 * Measured with rolldown 1.2.2: temml's lexer builds its token regex by
 * concatenating template literals with a `"[\uD800-\uDBFF]"` string, and
 * constant folding wrote each lone-surrogate escape out as U+FFFD followed by
 * `d800`. The regex then matched no control word, so every `\sum`, `\frac`, and
 * `\alpha` in client-mode math rendered as separate letters, while the Node
 * build that validated the expression at build time was correct. Only the
 * shipped chunk showed it, so this reads the shipped chunk: no U+FFFD in any
 * script of ours, and temml's own chunk turning a control word into its symbol.
 */
test('the bundled math renderer still reads control words', async () => {
  const scripts = builtFiles('.js').filter(OURS);
  for (const file of scripts) {
    assert.ok(!read(file).includes('�'), `${file}: carries U+FFFD, a character the bundler failed to write`);
  }
  const temml = scripts.filter((file) => /[\\/]temml\.[^\\/]+\.js$/.test(file));
  assert.equal(temml.length, 1, `expected one shipped temml chunk, found ${temml.length}`);
  const module = (await import(pathToFileURL(temml[0]!).href)) as {
    default: { renderToString(tex: string): string };
  };
  assert.match(module.default.renderToString('\\alpha'), /<mi>α<\/mi>/);
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

test('no surface that serves an excerpt or a title carries TeX', (context: TestContext) => {
  // **Three surfaces, and a gate on one of them would have passed.** An excerpt
  // is plain text stored in the SQLite snapshot, in `rss.xml`, and in every
  // page's `<meta name="description">`; a title reaches `<title>` and
  // `og:title`. The three are written by different code — the feed is built from
  // the artifact separately from the page's head — so a defect can live in one
  // and not the others, and this asserts over the shipped bytes rather than over
  // the producer that `tests/link-traversal.test.ts` already covers.
  //
  // Measured on `cabcc6a`, one note containing `$$\frac{a}{b} = \sqrt{c}$$`: all
  // three carried the TeX verbatim.
  // **The rule, not a list of commands.** A first version enumerated `\frac`,
  // `\sqrt`, `\partial`, `\theta`, `\mathbb{`, `\sum_`, `\prod_` — true the day
  // it was written and blind to `\int`, `\lim`, `\begin{`, `\left`, `\cdot`,
  // `\alpha`, `\nabla`, `\infty`, `\pi`. An excerpt reading `Let \alpha be the
  // learning rate` passed it clean. `docs/gate-reading.md`'s enumeration
  // corollary: a hand-listed member set measures the list.
  //
  // What TeX actually looks like on these surfaces is a backslash followed by a
  // command name, or a surviving `$$` delimiter. Prose does not contain either —
  // a Windows path is caught by the residue scan on its own rule, and a literal
  // backslash in prose is not followed by two letters.
  const TEX = /\$\$|\\[a-zA-Z]{2,}/;

  const notes = snapshotNotes(fileURLToPath(DIST));
  assert.ok(notes.length > 0, 'the snapshot is empty, so this gate inspected nothing');
  for (const note of notes) {
    assert.doesNotMatch(note.excerpt, TEX, `the snapshot: ${note.slug}'s excerpt carries TeX`);
    assert.doesNotMatch(note.title, TEX, `the snapshot: ${note.slug}'s title carries TeX`);
  }

  // The feed's per-entry `<summary>` is the same excerpt through a different
  // writer, and its `<title>` the same title. **Atom, not RSS**, despite the
  // filename: measured, `dist/rss.xml` is `<feed xmlns=".../2005/Atom">` with
  // `<summary type="text">` elements. A first version of this gate matched
  // `<description>`, found none, and failed on its own non-vacuity check rather
  // than passing on a regex that matched nothing — which is the direction that
  // check exists for.
  const feed = readFileSync(new URL('rss.xml', DIST), 'utf8');
  let summaries = 0;
  for (const [, text] of feed.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)) {
    assert.doesNotMatch(text!, TEX, 'rss.xml: a feed summary carries TeX');
    summaries += 1;
  }
  for (const [, text] of feed.matchAll(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/g)) {
    assert.doesNotMatch(text!, TEX, 'rss.xml: a feed entry title carries TeX');
  }
  assert.ok(summaries > 0, 'the feed carried no entry summary, so its surface was not measured');

  // And the head of every built page: the meta description and the title.
  let heads = 0;
  for (const file of builtFiles('.html').filter(OURS)) {
    const html = readFileSync(file, 'utf8');
    for (const [, content] of html.matchAll(/<meta name="description" content="([^"]*)"/g)) {
      assert.doesNotMatch(content!, TEX, `${file}: the meta description carries TeX`);
      heads += 1;
    }
    const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1];
    if (title !== undefined) assert.doesNotMatch(title, TEX, `${file}: the document title carries TeX`);
  }
  assert.ok(heads > 0, 'no meta description was read, so the third surface was not measured');

  // **Non-vacuity, and it is the one that matters here.** The published corpus
  // has one note and may carry no math at all, in which case every assertion
  // above is satisfied by a corpus with nothing to strip — which is the same
  // green as a pipeline that strips correctly. Reported as a skip rather than as
  // a pass, so the difference is visible: `pnpm run build:fixture` is what puts
  // math in `dist/`.
  const withMath = builtFiles('.html')
    .filter(OURS)
    .filter((file) => /class="math-(?:inline|display)"/.test(readFileSync(file, 'utf8')));
  if (withMath.length === 0) {
    return context.skip(
      'no built page carries math, so the surfaces above were clean with nothing to be clean of — ' +
        'run `pnpm run build:fixture` to exercise them',
    );
  }
});
