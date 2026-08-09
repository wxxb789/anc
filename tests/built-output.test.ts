/**
 * Assertions over the built site.
 *
 * These cannot be made against the source: the CSP requirement is about what
 * Astro *emits*, and the layout shell is only assembled at build time. Run
 * `npm run build` before `npm test`; the suite fails loudly rather than
 * skipping when `dist/` is absent, because a security gate that quietly
 * disappears is worse than one that is inconvenient.
 *
 * The parsers live in `css-cascade.ts` and carry their own adversarial tests in
 * `css-cascade.test.ts`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appliesByDefault,
  declaration,
  fixedWidthOver,
  minWidthFloor,
  rawStartTags,
  rules,
  specificity,
  splitSelectorList,
  startTags,
  wins,
  type Rule,
} from './css-cascade.ts';

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
    return assert.fail(`dist/ is missing or unreadable — run \`npm run build\` before \`npm test\``);
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

/**
 * A guard against the declaration shape that causes horizontal overflow: a
 * fixed length, wider than the narrowest supported viewport, in a property that
 * contributes to a box's outer width.
 *
 * A value that can shrink below its stated length — `min()`, `clamp()`, a
 * percentage, `auto` — cannot force overflow and is skipped. `max()` and
 * `calc()` are deliberately *not* skipped: `max(400px, 10%)` returns at least
 * 400 px, and `calc(100% + 400px)` is the classic overflow bug.
 *
 * ponytail: this is a syntactic check over the stylesheet, not a rendered one.
 * It proves no rule *commits* to an over-wide box; it does not measure a laid
 * out page, so it cannot see overflow caused by content, by a box-model
 * property (`padding`, `margin`, `left`), by a fixed grid track outside
 * `minmax()`, or by a combination of rules. A rendered check needs a browser,
 * which TK-09 owns. Rules that cannot apply at 320 px on screen — those inside
 * a print block, or behind a `min-width` query above 320 px — are skipped.
 */
test('no stylesheet commits to a width that cannot fit 320 px', () => {
  const NARROWEST_PX = 320;
  const PROPERTIES = ['width', 'min-width', 'inline-size', 'min-inline-size', 'flex-basis'];

  /** Applies at 320 px on screen: not print-only, no `min-width` above 320 px. */
  const reachableAt320 = (rule: Rule) =>
    appliesByDefault(rule) &&
    !rule.conditions.some((condition) => minWidthFloor(condition) > NARROWEST_PX);

  for (const file of STYLESHEETS) {
    for (const rule of rules(read(file)).filter(reachableAt320)) {
      for (const property of PROPERTIES) {
        const declared = declaration(rule.body, property);
        if (!declared) continue;
        const px = fixedWidthOver(declared.value, NARROWEST_PX);
        assert.equal(
          px,
          undefined,
          `${file}: "${rule.selector}" sets ${property}: ${declared.value} (${px}px), ` +
            `which cannot fit a ${NARROWEST_PX}px viewport`,
        );
      }

      // `minmax(360px, 1fr)` is the grid form of the same mistake: the floor is
      // a hard minimum, so an auto-fit track wider than the viewport overflows.
      for (const [, floor] of rule.body.matchAll(/minmax\(\s*([^,)]+)/gi)) {
        const px = fixedWidthOver(floor!, NARROWEST_PX);
        assert.equal(
          px,
          undefined,
          `${file}: "${rule.selector}" has a grid track floor of ${floor!.trim()} (${px}px), ` +
            `which cannot fit a ${NARROWEST_PX}px viewport`,
        );
      }
    }
  }
});

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
 * fourth consumer of `tests/css-cascade.ts`'s hand-written parser. It reads
 * what shipped and does one substring check per class.
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

/** One control marked `data-js-only` in the built pages, as a selector sees it. */
type Control = { tag: string; id: string | undefined; classes: Set<string> };

/** Read from the output rather than assumed, so the check follows the markup. */
function jsOnlyControls(): Control[] {
  const controls: Control[] = [];
  for (const file of PAGES) {
    // `rawStartTags` rather than a `[^>]*` pattern: a `>` inside an attribute
    // value would otherwise truncate the tag and drop the control silently.
    // Raw, not blanked — the id and class values are what identify the control.
    for (const tag of rawStartTags(read(file))) {
      if (!/\bdata-js-only\b/.test(tag)) continue;
      controls.push({
        tag: /^<([a-z]+)/i.exec(tag)![1]!.toLowerCase(),
        id: /\bid="([^"]*)"/.exec(tag)?.[1],
        classes: new Set(/\bclass="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/).filter(Boolean) ?? []),
      });
    }
  }
  return controls;
}

/**
 * Whether a selector's subject — its rightmost compound, the element it
 * actually styles — could match one of those controls. `.site-nav button` can;
 * `.site-nav` cannot, because it styles the container, not the button.
 *
 * Pseudo-class arguments are stripped before the compound is read. Leaving them
 * in makes `button:not(.x)` look like it requires class `x`, so no control
 * matches and the rule is skipped — a competing rule waved through, which is
 * the direction that hides a real defect.
 */
function targetsControl(selector: string, controls: readonly Control[]): boolean {
  const subject = selector.trim().split(/[\s>+~]+/).pop() ?? '';
  if (subject === '') return false;
  const bare = subject.replace(/:[\w-]+\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '');
  const type = /^([a-z][\w-]*)/i.exec(bare)?.[1]?.toLowerCase();
  const id = /#([\w-]+)/.exec(bare)?.[1];
  const classes = bare.match(/\.[\w-]+/g)?.map((name) => name.slice(1)) ?? [];
  return controls.some(
    (control) =>
      (type === undefined || type === control.tag) &&
      (id === undefined || id === control.id) &&
      classes.every((name) => control.classes.has(name)),
  );
}

/**
 * The JavaScript-only controls must not render when scripting is unavailable —
 * otherwise a keyboard user meets three buttons that silently do nothing.
 *
 * This resolves the actual cascade rather than asserting a selector string: the
 * bug it catches is a *competing* rule winning over the hiding rule, which a
 * pattern match over the hiding rule alone cannot see. It caught exactly that
 * during implementation, when `[data-js-only]` (0,1,0) lost to `.site-nav
 * button` (0,1,1).
 */
test('JavaScript-only controls are hidden when scripting is unavailable', () => {
  const controls = jsOnlyControls();
  assert.ok(controls.length > 0, 'no [data-js-only] control was emitted to check');

  // Self-check: the gate can only judge a competing rule if it can identify the
  // controls that rule would match. A control whose id or class was lost during
  // parsing silently narrows what the gate examines, so prove each one is
  // reachable by its own most specific selector before trusting the verdict.
  for (const control of controls) {
    const own = `${control.tag}${control.id ? `#${control.id}` : ''}${[...control.classes].map((name) => `.${name}`).join('')}`;
    assert.ok(
      targetsControl(own, controls),
      `the gate cannot recognize its own control "${own}" — control parsing is broken`,
    );
  }

  for (const file of STYLESHEETS) {
    const displayRules = rules(read(file))
      .filter(appliesByDefault)
      .flatMap((rule) => {
        const display = declaration(rule.body, 'display');
        if (!display) return [];
        return splitSelectorList(rule.selector).map((selector) => ({
          selector,
          value: display.value,
          important: display.important,
          specificity: specificity(selector),
          order: rule.order,
        }));
      });

    // A hiding rule must apply in the no-scripting state, so one that requires
    // `[data-js='on']` outside a `:not()` does not count toward hiding.
    const hiding = displayRules.filter(
      (rule) =>
        rule.selector.includes('[data-js-only]') &&
        rule.value === 'none' &&
        !/\[data-js=/.test(rule.selector.replace(/:not\([^()]*\)/g, '')),
    );
    assert.ok(hiding.length > 0, `${file}: nothing hides [data-js-only] without scripting`);
    const strongest = hiding.reduce((best, current) => (wins(current, best) ? current : best));

    for (const rule of displayRules) {
      if (rule.value === 'none' || !targetsControl(rule.selector, controls)) continue;
      assert.ok(
        !wins(rule, strongest),
        `${file}: "${rule.selector}" {display: ${rule.value}${rule.important ? ' !important' : ''}} ` +
          `(${rule.specificity}) wins over the [data-js-only] hiding rule "${strongest.selector}" ` +
          `(${strongest.specificity}), so a JavaScript-only control stays visible without scripting`,
      );
    }
  }
});
