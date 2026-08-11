import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import Slugger from 'github-slugger';
import { TOC_MIN_HEADINGS, defaultRouteForSlug, renderMarkdown, type TocEntry } from '../src/lib/markdown.ts';
import { DIAGRAM_MODE } from '../src/lib/diagram-mode.ts';
import { translate } from '../src/lib/translations.ts';

const FIXTURES = new URL('./fixtures/markdown/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

/** Rewrites only these two slugs, so "unknown slug" stays testable. */
const KNOWN_ROUTES: Readonly<Record<string, string>> = {
  'other-note': '/notes/other-note/',
  'raw-target': '/notes/raw-target/',
};

const routeForSlug = (slug: string): string | undefined => KNOWN_ROUTES[slug];

const kitchenSink = await renderMarkdown(fixture('kitchen-sink.md'), { routeForSlug });
const hostile = await renderMarkdown(fixture('hostile.md'), { routeForSlug });

// --- Supported constructs (requirements 15.1) ---------------------------------

test('renders GFM tables with alignment preserved as a data attribute', () => {
  assert.match(kitchenSink.html, /<table>/);
  assert.match(kitchenSink.html, /<th data-align="left">Language<\/th>/);
  assert.match(kitchenSink.html, /<th data-align="center">Runs at<\/th>/);
  assert.match(kitchenSink.html, /<th data-align="right">Notes<\/th>/);
  // The inline style satteri emits would be blocked by `style-src 'self'`.
  assert.doesNotMatch(kitchenSink.html, /style=/);
});

test('renders footnotes with their backreference section', () => {
  assert.match(kitchenSink.html, /<section data-footnotes class="footnotes">/);
  assert.match(kitchenSink.html, /href="#user-content-fn-src"/);
  assert.match(kitchenSink.html, /href="#user-content-fnref-src"/);
  assert.match(kitchenSink.html, /The synthetic source note\./);
});

/**
 * The footnote section's own two strings follow the document's language.
 *
 * GFM emits a visually hidden `<h2>` opening the section and an `aria-label` on
 * every backref, and both are English defaults unless supplied — so a Chinese
 * article announced "Back to reference 1" to a screen reader, which is the only
 * reader who meets either string. They are passed through `RenderOptions.chrome`
 * like the heading anchor and the diagram caption.
 *
 * Asserted here rather than over `dist/` because no built page reaches it: the
 * one fixture note with footnotes is English, so the interesting direction is
 * unreachable from either corpus and a gate over the artifact would check
 * nothing. Reverting `featuresFor` to a module constant left the whole suite
 * green before this existed.
 *
 * The rerun form is the half worth stating: a footnote cited twice gets a second
 * backref labelled `1-2`, and that suffix is substituted by satteri into the
 * `{reference}` placeholder the locale receives — so the locale is free to put
 * the number where its own grammar wants it.
 */
test('the footnote section is labelled in the document own language', async () => {
  const source = '# T\n\nOne[^a] and again[^a].\n\n[^a]: The note.\n';
  const expected = {
    en: { heading: 'Footnotes', first: 'Back to reference 1', rerun: 'Back to reference 1-2' },
    'zh-CN': { heading: '脚注', first: '返回正文引用 1', rerun: '返回正文引用 1-2' },
  } as const;

  for (const [language, words] of Object.entries(expected)) {
    const { html } = await renderMarkdown(source, { pageTitle: 'T', chrome: translate(language) });
    assert.ok(
      html.includes(`id="footnote-label">${words.heading}<`),
      `${language}: the footnotes heading is not "${words.heading}"`,
    );
    for (const label of [words.first, words.rerun]) {
      assert.ok(html.includes(`aria-label="${label}"`), `${language}: no backref labelled "${label}"`);
    }
    // And nothing from the other locale survives beside it.
    const other = language === 'en' ? expected['zh-CN'] : expected.en;
    for (const label of [other.heading, other.first]) {
      assert.ok(!html.includes(label), `${language}: the footnote section also carries "${label}"`);
    }
  }
});

/**
 * A heading anchor's accessible name is the heading, trimmed.
 *
 * The trim is the assertion: satteri's `textContent` keeps the whitespace around
 * an image, a raw tag, or an HTML comment, so `## Status <!-- note -->` produced
 * `aria-label="Link to section: Status "` — a name a screen reader reads with a
 * pause nobody wrote. Both shapes are valid Markdown that neither corpus
 * contains, which is why this is a unit test rather than a gate over `dist/`.
 */
test('a heading anchor is named for its heading, without surrounding whitespace', async () => {
  const cases: readonly [string, string][] = [
    ['## Status <!-- note -->\n\nx\n', 'Status'],
    ['## ![icon](https://example.test/x.png) Overview\n\nx\n', 'Overview'],
    ['## Plain Heading\n\nx\n', 'Plain Heading'],
    ['## `code` in a heading\n\nx\n', 'code in a heading'],
  ];

  for (const [body, heading] of cases) {
    const { html } = await renderMarkdown(`# T\n\n${body}`, {
      pageTitle: 'T',
      chrome: translate('zh-CN'),
    });
    const label = /<a class="heading-anchor"[^>]*aria-label="([^"]*)"/.exec(html)?.[1];
    assert.equal(label, `跳转到章节：${heading}`, `${JSON.stringify(body)}: wrong accessible name`);
  }
});

test('renders task lists as disabled checkboxes, never interactive', () => {
  assert.match(kitchenSink.html, /<ul class="contains-task-list">/);
  // Each checkbox is named by its own item's text. A checkbox with no
  // accessible name is an axe `label` violation at critical impact — announced
  // as bare state — and a fixed literal would name every checkbox identically
  // and in English, on a site whose notes may be in either language.
  assert.match(
    kitchenSink.html,
    /<input type="checkbox" disabled aria-label="Unchecked item" \/> Unchecked item/,
  );
  assert.match(
    kitchenSink.html,
    /<input type="checkbox" disabled aria-label="Checked item" checked \/> Checked item/,
  );
});

test('a task checkbox is named by its own item, in every list shape', async () => {
  // A nested list: the parent's name must be its own text, not its subtree's.
  // `ctx.textContent` on the `<li>` returns the children's text too, so the
  // parent was named "Parent task Child A Child B" — the whole subtree read
  // aloud as one name, and then each child read again.
  const nested = await renderMarkdown('- [ ] Parent task\n  - [ ] Child A\n  - [x] Child B\n');
  assert.deepEqual(
    [...nested.html.matchAll(/aria-label="([^"]*)"/g)].map(([, label]) => label),
    ['Parent task', 'Child A', 'Child B'],
  );

  // A *loose* list — a blank line between items — wraps each item's content in
  // a `<p>`, so the checkbox is not a direct child of the `<li>`. A
  // direct-children search found nothing and left exactly the unnamed checkbox
  // this plugin exists to name.
  const loose = await renderMarkdown('- [ ] First\n\n- [x] Second\n');
  assert.match(loose.html, /<p><input type="checkbox" disabled aria-label="First" \/>/);
  assert.match(loose.html, /aria-label="Second" checked/);
});

test('a task checkbox is named in the document s own language, and boundedly', async () => {
  const chinese = await renderMarkdown('- [ ] 写文档\n');
  assert.match(chinese.html, /aria-label="写文档"/, 'the name is not lifted from the item text');

  // Inline markup contributes its text, not its tags, and whitespace collapses:
  // an `aria-label` is announced as one unbroken run.
  const rich = await renderMarkdown('- [x] Ship **the** release\n');
  assert.match(rich.html, /aria-label="Ship the release" checked/);

  // Bounded, so a paragraph-length item is not read out in full before the
  // reader learns whether it is checked. The full text is still in the item.
  const long = await renderMarkdown(`- [ ] ${'x'.repeat(400)}\n`);
  const label = /aria-label="([^"]*)"/.exec(long.html)?.[1];
  assert.ok(label, 'a long task item produced no accessible name');
  assert.ok(label.length < 200, `the accessible name is ${label.length} characters long`);
  assert.ok(label.endsWith('…'), 'a truncated name does not say it was truncated');

  // The bound counts code points. Cutting UTF-16 units splits a surrogate pair
  // and leaves half a character, which is announced as a replacement glyph.
  const astral = await renderMarkdown(`- [ ] ${'a'.repeat(119)}😀 tail\n`);
  assert.match(astral.html, /aria-label="a{119}😀…"/);

  // The bound holds for a raw-HTML input too. By the time the sanitizer parses
  // the final HTML it cannot tell a label the plugin wrote from one a note
  // body wrote, so without re-bounding there the body would have an unbounded
  // attribute channel.
  const raw = await renderMarkdown(`<input aria-label="${'A'.repeat(5000)}">\n`);
  const rawLabel = /aria-label="([^"]*)"/.exec(raw.html)?.[1];
  assert.ok(rawLabel !== undefined && rawLabel.length < 200, 'a raw-HTML input carried an unbounded label');
});

test('renders callouts with kind and promoted title, leaving plain quotes alone', () => {
  assert.match(
    kitchenSink.html,
    /<blockquote class="callout callout-note" data-callout="note">\s*<p><strong class="callout-title">Callout with a title<\/strong>/,
  );
  assert.match(kitchenSink.html, /<blockquote class="callout callout-warning" data-callout="warning">/);
  // The marker itself must not survive into the reader-visible text.
  assert.doesNotMatch(kitchenSink.html, /\[!note\]|\[!warning\]/);
  assert.match(kitchenSink.html, /<blockquote>\s*<p>An ordinary blockquote/);
});

test('highlights code fences at build time with class-only markup', () => {
  assert.match(
    kitchenSink.html,
    /<figure class="code-block" data-code-language="js"><pre tabindex="0"><code class="language-js">/,
  );
  assert.match(kitchenSink.html, /<span class="token token-keyword">const<\/span>/);
  // Shiki-style inline colors would need `style-src 'unsafe-inline'`.
  assert.doesNotMatch(kitchenSink.html, /style="color/);
});

test('a code block is a bare figure with no dead controls', () => {
  // Two code fences: js and the unlabelled one. Math and Mermaid are rendered
  // rather than highlighted, so neither is a `code-block` figure since TK-15.
  const figures = kitchenSink.html.match(/<figure class="code-block"[^>]*>/g) ?? [];
  assert.equal(figures.length, 2, `expected one figure per fence, got ${figures.length}`);
  // TK-03 shipped a `hidden` copy button with no handler and no CSS, which
  // welded the word `Copy` onto every indexed code block. TK-05a may bring one
  // back in the same commit as its handler and its styling.
  assert.doesNotMatch(kitchenSink.html, /<button/i, 'a control with no handler is dead markup');
  assert.doesNotMatch(kitchenSink.html, /data-copy-code/);
  assert.doesNotMatch(kitchenSink.html, />Copy</);
});

test('an unlabelled fence is still a code block', () => {
  assert.match(
    kitchenSink.html,
    /<figure class="code-block" data-code-language="plaintext"><pre tabindex="0"><code class="language-plaintext">plain fence with no language<\/code><\/pre>/,
  );
});

test('image embeds always carry explicit alt text', () => {
  assert.match(kitchenSink.html, /<img src="decorative\.png" alt="" \/>/);
  assert.match(kitchenSink.html, /<img src="https:\/\/example\.com\/diagram\.png" alt="A described diagram" \/>/);
  const images = kitchenSink.html.match(/<img[^>]*>/g) ?? [];
  assert.ok(images.length > 0);
  for (const image of images) assert.match(image, /\balt="/, `image without alt: ${image}`);
});

test('an inline image is allowed only as a base64 raster, matching the artifact scanner', async () => {
  for (const safe of [
    'data:image/png;base64,iVBORw0KGgo=',
    'data:image/gif;base64,R0lGOD',
    'data:image/webp;base64,UklGRg',
  ]) {
    const rendered = await renderMarkdown(`![x](${safe})\n`);
    assert.match(rendered.html, /\ssrc="data:image\//, `safe raster was dropped: ${safe}`);
  }

  // An SVG can carry a script; the rest are not images at all. A bare scheme
  // grant would admit every one of these, so the shape check has to be separate.
  for (const unsafe of [
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==',
    'data:text/html,<script>window.alert(1)</script>',
    'data:,plain',
    'data:;base64,PHN2Zz4=',
    'data: image/png;base64,ABC',
    'data:image/png,notbase64',
  ]) {
    const rendered = await renderMarkdown(`<img src="${unsafe}" alt="x">\n`);
    assert.doesNotMatch(rendered.html, /\ssrc=/, `unsafe data URI survived: ${unsafe}`);
    assert.match(rendered.html, /alt="x"/, 'the image element itself should remain, alt intact');
  }

  // `data:` is granted to img[src] only, never to a link.
  const link = await renderMarkdown('<a href="data:image/png;base64,ABC">x</a>\n');
  assert.doesNotMatch(link.html, /\shref=/);
});

test('inline marks and external links survive', () => {
  assert.match(kitchenSink.html, /<strong>bold<\/strong>/);
  assert.match(kitchenSink.html, /<em>emphasis<\/em>/);
  assert.match(kitchenSink.html, /<del>strikethrough<\/del>/);
  assert.match(kitchenSink.html, /<code>inline code<\/code>/);
  assert.match(kitchenSink.html, /<a href="https:\/\/example\.com\/docs\/">public link<\/a>/);
});

// --- Rendered constructs (requirements 15.1) ---------------------------------
//
// Both of these were downgrades to escaped source until TK-15, recorded under
// requirements 15.2. Owner decisions 2 and 5 superseded them: math is native
// MathML from Temml and a diagram is build-time SVG, both at zero client
// JavaScript. `tests/math-and-diagrams.test.ts` carries the full coverage; what
// is pinned here is that the *pipeline* produces them, since this file owns the
// renderer's contract.

test('a Mermaid fence becomes a rendered diagram, never a runtime renderer', () => {
  assert.match(kitchenSink.html, /<figure class="diagram" data-diagram="mermaid">/);
  assert.equal(kitchenSink.hasMermaid, true);
  // Neither mode may put a script or anything `style-src 'self'` blocks into
  // the *markup*. That is the whole property in build-time mode, and still the
  // property in client mode, where the runtime arrives as an external module
  // and the diagram source ships escaped inside a `<pre>`.
  assert.doesNotMatch(kitchenSink.html, /<script/i);
  assert.doesNotMatch(kitchenSink.html, /<style/i);
  assert.doesNotMatch(kitchenSink.html, /\sstyle="/);

  if (DIAGRAM_MODE === 'build-time') {
    // The diagram is markup: real SVG, named for assistive technology, present
    // with JavaScript disabled.
    assert.match(kitchenSink.html, /<svg\b[^>]*aria-label="Flowchart diagram"/);
  } else {
    // The diagram is the source until the runtime replaces it, which is also
    // what a reader without JavaScript is left with — the deliberate §5.2/§5.3
    // carve-out that TK-10 records.
    assert.match(kitchenSink.html, /<pre class="diagram-source" tabindex="0"><code class="language-mermaid">/);
  }
});

test('math becomes MathML and single dollars stay literal', () => {
  assert.match(kitchenSink.html, /<span class="math-display" tabindex="0"><math display="block"/);
  assert.match(kitchenSink.html, /<mi>m<\/mi>/, 'the expression is marked up, not escaped');
  assert.equal(kitchenSink.hasMath, true);
  assert.match(kitchenSink.html, /\$5 to \$10/, 'currency must not be parsed as inline math');
  // Math is not a code block: no copy button, no highlighting shell, and no
  // `pre` wrapper — which would make it a keyboard stop with nothing to scroll.
  assert.doesNotMatch(kitchenSink.html, /data-code-language="math"/);
  assert.doesNotMatch(kitchenSink.html, /language-math/);
});

test('unsupported plugin syntax renders as inert source, not executed', () => {
  for (const language of ['dataview', 'dataviewjs', 'tasks']) {
    assert.match(hostile.html, new RegExp(`data-code-language="${language}"`), `${language} block missing`);
  }
  assert.match(hostile.html, /LIST FROM #private/);
  assert.doesNotMatch(hostile.html, /<script/i);
});

test('an unknown fence language is escaped rather than passed through as HTML', async () => {
  const rendered = await renderMarkdown('```nosuchlang\n<script>window.alert(1)</script>\n```\n');
  assert.match(rendered.html, /&lt;script&gt;window\.alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered.html, /<script/i);
  // The label the author wrote is preserved even though nothing highlighted it.
  assert.match(rendered.html, /data-code-language="nosuchlang"/);
});

test('a fence language Prism spells differently is still highlighted', async () => {
  const rendered = await renderMarkdown('```cmd\ndel temp.pem\n```\n');
  assert.match(rendered.html, /<span class="token token-keyword">del<\/span>/, 'cmd should map onto Prism batch');
  // The author's label survives; only the grammar lookup is remapped.
  assert.match(rendered.html, /data-code-language="cmd"/);
  assert.match(rendered.html, /class="language-cmd"/);
});

// --- Rejected constructs (requirements 15.2, 19.2) ----------------------------

test('no dangerous construct survives sanitization in the hostile fixture', () => {
  for (const pattern of [
    /<script/i, /<iframe/i, /<object/i, /<embed/i, /<form/i, /<svg/i, /<math/i,
    /<style/i, /<base/i, /<link/i, /<meta/i, /<textarea/i, /<select/i, /<option/i,
    /\son[a-z]+\s*=/i, /\sstyle\s*=/i, /javascript:/i, /vbscript:/i, /data:text\/html/i, /file:\/\//i,
  ]) {
    assert.doesNotMatch(hostile.html, pattern, `hostile fixture leaked ${pattern}`);
  }
});

test('non-text containers are discarded whole, not unwrapped into their text', () => {
  // Unwrapping would surface "iframe fallback text" as body prose.
  for (const leak of [
    'iframe fallback text', 'object fallback text', 'svg text', 'math text',
    'textarea content', 'option text', 'display: none',
  ]) {
    assert.ok(!hostile.html.includes(leak), `discarded container leaked its text: ${leak}`);
  }
});

test('every obfuscated javascript: URL variant is stripped', async () => {
  const variants = [
    'javascript:window.alert(1)',
    'JaVaScRiPt:window.alert(1)',
    '&#106;avascript:window.alert(1)',
    '&#x6a;avascript:window.alert(1)',
    'javascript&colon;window.alert(1)',
    'java\tscript:window.alert(1)',
    'java\nscript:window.alert(1)',
    ' javascript:window.alert(1)',
    '   javascript:window.alert(1)',
    'JAVASCRIPT:window.alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'file:///etc/passwd',
    '//evil.example/path',
  ];
  for (const href of variants) {
    const rendered = await renderMarkdown(`<a href="${href}">x</a>\n<img src="${href}" alt="y">\n`);
    assert.doesNotMatch(rendered.html, /\shref=/, `href survived for ${JSON.stringify(href)}`);
    assert.doesNotMatch(rendered.html, /\ssrc=/, `src survived for ${JSON.stringify(href)}`);
  }
});

test('form controls are neutralized into inert checkboxes', () => {
  const inputs = hostile.html.match(/<input[^>]*>/g) ?? [];
  for (const input of inputs) {
    assert.match(input, /type="checkbox"/, `input escaped neutralization: ${input}`);
    assert.match(input, /disabled/, `input is not disabled: ${input}`);
    assert.doesNotMatch(input, /\bname=|\bvalue=/, `input kept a submit payload: ${input}`);
  }
});

test('a raw-HTML button does not survive as a control', async () => {
  // `button` is not in the tag allowlist: nothing this pipeline emits is one,
  // and a control a note body cannot wire to anything is a dead affordance.
  // The hostile fixture's button sits inside a `<form>`, which `nonTextTags`
  // discards whole, so a standalone one is rendered to see the element rule on
  // its own — its label survives as text.
  assert.doesNotMatch(hostile.html, /<button/i);

  const rendered = await renderMarkdown('<button type="submit" onclick="x()">Send</button>\n');
  assert.doesNotMatch(rendered.html, /<button/i);
  assert.doesNotMatch(rendered.html, /\sonclick=/i);
  assert.ok(rendered.html.includes('Send'), 'the label should survive as text');
});

test('only pipeline-emitted classes survive', async () => {
  // Lowercase kebab-case names, i.e. exactly the shape the site's own layout
  // classes take — an allowlist that admits these lets body content overlay
  // page chrome. `site-header` is `position: sticky; z-index: 10` in TK-02's
  // stylesheet.
  const rendered = await renderMarkdown(
    '<span class="site-header">a</span><span class="evil-injected">b</span>' +
      '<div class="callout">c</div><p class="brand">d</p>' +
      '<ol class="site-header" start="5"><li class="back-home">e</li></ol>\n',
  );
  for (const injected of ['site-header', 'evil-injected', 'brand', 'back-home', 'callout']) {
    assert.ok(!rendered.html.includes(injected), `injected class survived: ${injected}`);
  }

  // Prism's own token classes are namespaced, so the allowlist stays closed.
  const highlighted = await renderMarkdown('```js\nconst a = 1;\n```\n');
  assert.match(highlighted.html, /class="token token-keyword"/);
  for (const [, list] of highlighted.html.matchAll(/<span class="([^"]*)"/g)) {
    for (const name of list.split(/\s+/)) {
      assert.match(name, /^token(?:-[a-z0-9-]+)?$/, `unexpected span class: ${name}`);
    }
  }

  const code = await renderMarkdown('<code class="language-js EVIL">c</code>\n');
  assert.match(code.html, /<code class="language-js">c<\/code>/);
});

test('body content cannot mint an element id', async () => {
  // `#search-toggle` and `#search-dialog` are live hooks in the layout.
  const rendered = await renderMarkdown(
    '<a id="search-toggle" href="https://x/">a</a>\n\n<li id="search-dialog">b</li>\n\n<h2 id="chosen">c</h2>\n',
  );
  for (const injected of ['search-toggle', 'search-dialog', 'chosen']) {
    assert.ok(!rendered.html.includes(injected), `injected id survived: ${injected}`);
  }

  // A raw heading id must not collide with a real heading's generated anchor.
  const collide = await renderMarkdown('## Real\n\n<h2 id="real">Fake</h2>\n');
  assert.equal((collide.html.match(/id="real"/g) ?? []).length, 1);

  // Generated ids still survive: heading anchors and footnote structure.
  assert.match(kitchenSink.html, /id="prose-and-inline-marks"/);
  assert.match(kitchenSink.html, /id="user-content-fn-src"/);
  assert.match(kitchenSink.html, /id="footnote-label"/);
});

test('no allowed tag can carry a body-authored id to the page', async () => {
  // The id channel is closed by `allowedAttributes`, not by the `'*'` transform
  // — which only consumes *generated* ids, and only on tags granted an `id`.
  // This walks every tag the allowlist admits so that distinction stays true:
  // if a future ticket grants `id` to another tag, this fails rather than
  // quietly handing body content a page-global name.
  const HOOKS = ['search-toggle', 'search-dialog', 'main', 'link-preview', 'theme-toggle'];
  const TAGS = [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 'del', 's', 'ins', 'mark', 'sup', 'sub',
    'abbr', 'small', 'span', 'q', 'cite', 'kbd', 'samp', 'var', 'time',
    'bdi', 'bdo', 'wbr', 'ruby', 'rt', 'rp', 'dfn',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'blockquote', 'pre', 'code', 'figure', 'figcaption', 'section', 'div',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'input',
  ];

  for (const tag of TAGS) {
    for (const hook of HOOKS) {
      const { html } = await renderMarkdown(`<${tag} id="${hook}">x</${tag}>\n`);
      assert.ok(
        !html.includes(`id="${hook}"`),
        `<${tag}> carried a body-authored id to the page: ${html.trim()}`,
      );
    }
  }
});

test('comments and doctype do not survive', async () => {
  const rendered = await renderMarkdown('<!DOCTYPE html>\n\n<p>a<!-- secret note -->b</p>\n');
  assert.doesNotMatch(rendered.html, /secret note/);
  assert.doesNotMatch(rendered.html, /<!/);
});

test('wikilinks are not resolved here; the exporter owns that boundary', async () => {
  const rendered = await renderMarkdown('A [[private-note]] reference.\n');
  // Renders as literal text, never as an anchor to an unapproved target.
  assert.doesNotMatch(rendered.html, /<a /);
  assert.match(rendered.html, /\[\[private-note\]\]/);
});

test('a leading --- is a rule, not swallowed as frontmatter', async () => {
  const rendered = await renderMarkdown('---\ntitle: not frontmatter\n---\n\nBody text.\n');
  assert.match(rendered.html, /Body text\./);
  assert.match(rendered.html, /not frontmatter/);
});

test('heading attribute syntax cannot choose its own id or class', async () => {
  const rendered = await renderMarkdown('# Real heading { #chosen-id .evil }\n');
  // The braces stay literal text; only the pipeline assigns ids.
  assert.doesNotMatch(rendered.html, /id="chosen-id"/);
  assert.doesNotMatch(rendered.html, /class="evil"/);
  assert.match(rendered.html, /\{ #chosen-id \.evil \}/);
});

// --- Heading anchors and table of contents ------------------------------------

test('heading anchor ids are slugified, deduplicated, and linked', () => {
  const ids = kitchenSink.headings.map((heading) => heading.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate heading ids: ${ids.join(', ')}`);
  assert.ok(ids.includes('prose-and-inline-marks'));
  assert.ok(ids.includes('混合-mixed-标题'), `CJK heading slug missing from ${ids.join(', ')}`);
  for (const { id, text } of kitchenSink.headings) {
    assert.match(kitchenSink.html, new RegExp(`id="${id}"`), `heading ${text} lost its id`);
    assert.ok(
      kitchenSink.html.includes(`<a class="heading-anchor" href="#${id}"`),
      `heading ${text} lost its anchor link`,
    );
  }
});

test('repeated heading text yields distinct, stable ids', async () => {
  const source = '## Repeat\n\n## Repeat\n\n## Repeat\n';
  const first = await renderMarkdown(source);
  assert.deepEqual(first.headings.map((heading) => heading.id), ['repeat', 'repeat-1', 'repeat-2']);
  const second = await renderMarkdown(source);
  assert.deepEqual(second.headings, first.headings, 'ids must not drift between renders');
});

test('slugger state does not leak across renders', async () => {
  const a = await renderMarkdown('## Shared\n');
  const b = await renderMarkdown('## Shared\n');
  assert.deepEqual(a.headings, b.headings);
  assert.equal(b.headings[0]?.id, 'shared');
});

test('a heading with no sluggable text still gets a usable anchor', async () => {
  const rendered = await renderMarkdown('## ...\n\n## ???\n');
  const ids = rendered.headings.map((heading) => heading.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.notEqual(id, '');
});

test('an unsluggable heading does not steal the id of a real one', async () => {
  // "..." slugs to "". If the fallback bypasses the slugger, "section" is never
  // registered as taken and a later heading actually titled "Section" collides,
  // emitting a duplicate id and an anchor that jumps to the wrong place.
  for (const source of ['## ...\n\n## Section\n', '## Section\n\n## ...\n']) {
    const rendered = await renderMarkdown(source);
    const ids = rendered.headings.map((heading) => heading.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids for ${JSON.stringify(source)}: ${ids.join(', ')}`);
    for (const id of ids) {
      assert.equal((rendered.html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1);
    }
  }
});

test('a raw-HTML id cannot shadow a heading anchor that follows it', async () => {
  // The defect this closes: ids were deduplicated at sanitize time, so a raw
  // `<a id="introduction">` before `## Introduction` consumed the generated id
  // and the heading's own `id` was dropped — leaving `href="#introduction"`
  // pointing at the decoy, and taking the future table of contents entry and
  // the Pagefind anchor with it. Reserving the raw id at generation time makes
  // the heading pick a free one instead.
  //
  // Every quoting form an HTML parser accepts, plus character references,
  // because a decoy only has to survive the parser, not the author. The named
  // ones are the interesting case: `_` and `-` are slug characters and both
  // have named references, so a decoder handling only `&#…;` reads
  // `foo&lowbar;bar` literally, reserves the wrong string, and lets the decoy
  // keep the heading's anchor.
  for (const [decoy, heading] of [
    ['<a id="introduction">decoy</a>', 'Introduction'],
    ["<a id='introduction'>decoy</a>", 'Introduction'],
    ['<a id=introduction>decoy</a>', 'Introduction'],
    ['<a id = "introduction">decoy</a>', 'Introduction'],
    ['<a ID="introduction">decoy</a>', 'Introduction'],
    ['<a id="&#105;ntroduction">decoy</a>', 'Introduction'],
    ['<a id="&#x69;ntroduction">decoy</a>', 'Introduction'],
    ['<a id="foo&lowbar;bar">decoy</a>', 'Foo_Bar'],
    ['<a id="foo&UnderBar;bar">decoy</a>', 'Foo_Bar'],
    ['<ul><li id="introduction">decoy</li></ul>', 'Introduction'],
    ['<h2 id="introduction">decoy</h2>', 'Introduction'],
  ] as const) {
    const rendered = await renderMarkdown(`${decoy}\n\n## ${heading}\n`);
    const anchor = rendered.headings[0]?.id;
    const taken = new Slugger().slug(heading);
    assert.ok(anchor, `no heading was collected for ${decoy}`);
    assert.notEqual(anchor, taken, `the decoy kept the heading's id: ${decoy}`);
    assert.match(
      rendered.html,
      new RegExp(`<h2 id="${anchor}">${heading}<a class="heading-anchor" href="#${anchor}"`),
      `the heading lost its own anchor: ${rendered.html}`,
    );
    // The decoy itself is still dropped — it just no longer has anything to
    // shadow. Its text stays, so the reader loses nothing.
    assert.ok(rendered.html.includes('decoy'), `the decoy's text was discarded: ${decoy}`);
    assert.doesNotMatch(rendered.html, new RegExp(`id="${taken}"`), `the decoy id survived: ${decoy}`);
  }
});

test('text that is not an id does not move a heading anchor', async () => {
  // The other direction, and the more damaging one: over-reserving silently
  // renames a *published* deep link.
  //
  // Two families. A regex for `\bid\s*=` fires inside an HTML comment, inside
  // `data-id=`, and inside a `title` value. And an id that a browser parses but
  // that this pipeline can never ship — on a tag the allowlist grants no `id`,
  // or inside a subtree `nonTextTags` discards whole — has nothing to shadow, so
  // reserving it costs a real heading its anchor for no gain.
  for (const noise of [
    '<!-- id="introduction" -->',
    '<div data-id="introduction">x</div>',
    '<a title="id=introduction" href="https://example.com/">x</a>',
    '<p>The text id="introduction" written as prose.</p>',
    '<a id="">x</a>',
    '<div id="introduction">x</div>',
    '<span id="introduction">x</span>',
    '<section id="introduction">x</section>',
    '<form><a id="introduction">x</a></form>',
  ]) {
    const rendered = await renderMarkdown(`${noise}\n\n## Introduction\n`);
    assert.equal(
      rendered.headings[0]?.id,
      'introduction',
      `"${noise}" moved the heading's anchor away from #introduction`,
    );
    assert.match(rendered.html, /<h2 id="introduction">/, `heading lost its id after: ${noise}`);
  }

  // And an empty raw id must not consume the slugger's empty-slug fallback,
  // which would leave an unsluggable heading with `id="-1"` instead of
  // `section`.
  const fallback = await renderMarkdown('<a id="">x</a>\n\n## ...\n');
  assert.equal(fallback.headings[0]?.id, 'section');
});

test('every scrollable block is reachable by keyboard', async () => {
  // A block that scrolls horizontally when a line exceeds the measure must be
  // keyboard reachable — axe `scrollable-region-focusable`, WCAG 2.1.1, four
  // serious violations on the single published note before TK-05a.
  //
  // Two shapes qualify and both are checked. Every `pre`, including a raw-HTML
  // one. And the display-math wrapper, which since TK-15 is a `span` rather
  // than a `pre`: a long derivation does not wrap, so it scrolls exactly as a
  // code fence does. Inline math is in the text flow and gets none.
  const rendered = await renderMarkdown(
    '```js\nconst a = 1;\n```\n\n$$\nx\n$$\n\n<pre tabindex="5">raw</pre>\n',
  );

  const blocks = rendered.html.match(/<pre[^>]*>/g) ?? [];
  assert.equal(blocks.length, 2, `expected two pre elements, got ${blocks.length}`);
  for (const block of blocks) {
    // Pinned to 0, not merely present: a raw `tabindex="5"` would put the block
    // ahead of the page's own controls in tab order.
    assert.match(block, /^<pre tabindex="0"(?: |>)/, `pre is not keyboard reachable: ${block}`);
  }

  assert.match(
    rendered.html,
    /<span class="math-display" tabindex="0">/,
    'display math scrolls and must be keyboard reachable',
  );
});

test('a raw-HTML span cannot claim a place in the tab order', async () => {
  // The display-math wrapper is the one `span` granted a `tabindex`, so the
  // attribute is now reachable from body content. Left ungoverned it is a tab
  // order hijack: `tabindex="5"` on a decorative span jumps ahead of the skip
  // link and every control in the header.
  const rendered = await renderMarkdown(
    '<span tabindex="5">decoy</span> and <span class="math-display" tabindex="9">fake</span>\n',
  );
  for (const tag of rendered.html.match(/<span[^>]*>/g) ?? []) {
    assert.doesNotMatch(tag, /tabindex="[1-9]/, `span claims a tab order position: ${tag}`);
  }
});

test('a raw-HTML id cannot steal a generated footnote id', async () => {
  // Heading anchors are safe by construction — they are minted after the raw
  // node is seen. Footnote ids are not: `sanitize()` recognizes them by *shape*
  // (`footnote-label`, `user-content-fn-*`), so whichever element carried one
  // first was handed it. A decoy took `footnote-label`, left the real
  // `<h2 class="sr-only">` without an id, and pointed the reference's
  // `aria-describedby` at the decoy — a screen reader then announces the decoy
  // as the footnote section's name.
  for (const id of ['footnote-label', 'user-content-fn-a', 'user-content-fnref-a']) {
    const { html } = await renderMarkdown(`<a id="${id}">decoy</a>\n\ntext[^a]\n\n[^a]: note\n`);

    // The decoy loses its id but keeps its text.
    assert.match(html, /<p><a>decoy<\/a><\/p>/, `the decoy kept an id or lost its text: ${html}`);
    // Exactly one element answers to the id, and it is the generated one.
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, `id="${id}" is not unique`);

    // And no footnote link dangles — the failure mode of denying the string
    // outright rather than denying one claim on it.
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map(([, value]) => value!);
    for (const [, target] of html.matchAll(/\shref="#([^"]*)"/g)) {
      assert.ok(ids.includes(target!), `href="#${target}" dangles after denying ${id}`);
    }
  }
});

test('no rendered document contains a duplicate id or a dangling fragment link', async () => {
  // The invariant the built-output gate asserts over `dist/`, proven here
  // against the constructs that can break it.
  for (const source of [
    fixture('kitchen-sink.md'),
    fixture('hostile.md'),
    '<a id="a">x</a>\n\n## A\n\n## A\n\n<span id="a-1">y</span>\n\n## A\n',
    'text[^n]\n\n## Notes\n\n[^n]: a footnote\n',
  ]) {
    const { html } = await renderMarkdown(source, { routeForSlug });
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map(([, id]) => id!);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in: ${ids.join(', ')}`);
    for (const [, target] of html.matchAll(/\shref="#([^"]*)"/g)) {
      assert.ok(ids.includes(target!), `href="#${target}" has no matching id`);
    }
  }
});

test('generated footnote heading stays out of the heading tree', () => {
  assert.ok(!kitchenSink.headings.some((heading) => heading.id === 'footnote-label'));
  assert.match(kitchenSink.html, /id="footnote-label"/);
});

test('table of contents nests by depth', () => {
  const roots = kitchenSink.toc;
  assert.equal(roots.length, 1, 'the single h1 should be the only root');
  assert.equal(roots[0]?.id, 'kitchen-sink');
  const nested = roots[0]?.children.find((child) => child.id === '混合-mixed-标题');
  assert.ok(nested, 'h2 missing from the tree');
  assert.equal(nested.children[0]?.id, 'nested-subsection');
});

test('short pages get no table of contents but keep their headings', async () => {
  const short = await renderMarkdown('# Only\n\nBody.\n');
  assert.deepEqual(short.toc, []);
  assert.equal(short.headings.length, 1);

  const atThreshold = await renderMarkdown('# A\n\n## B\n\n## C\n');
  assert.equal(atThreshold.headings.length, TOC_MIN_HEADINGS);
  assert.ok(atThreshold.toc.length > 0, 'the threshold itself must produce a table of contents');
});

test('a page starting at h2 still produces a tree', async () => {
  const rendered = await renderMarkdown('## A\n\n### B\n\n## C\n');
  assert.deepEqual(rendered.toc.map((entry) => entry.id), ['a', 'c']);
  assert.deepEqual(rendered.toc[0]?.children.map((entry) => entry.id), ['b']);
});

test('an irregular heading structure never drops a heading from the tree', async () => {
  const flatten = (entries: readonly TocEntry[]): string[] =>
    entries.flatMap((entry) => [entry.id, ...flatten(entry.children)]);

  // Skipped levels, a rise back to h1, and a document that opens deep.
  for (const source of [
    '# A\n\n#### B\n\n## C\n',
    '#### A\n\n# B\n\n## C\n',
    '###### A\n\n##### B\n\n#### C\n',
    '# A\n\n## B\n\n### C\n\n# D\n\n## E\n',
  ]) {
    const rendered = await renderMarkdown(source);
    assert.deepEqual(
      flatten(rendered.toc),
      rendered.headings.map((heading) => heading.id),
      `tree lost or reordered a heading for ${JSON.stringify(source)}`,
    );
  }
});

// --- Injected route mapping ---------------------------------------------------

test('internal links are rewritten through the injected mapping', () => {
  assert.match(kitchenSink.html, /<a href="\/notes\/other-note\/">internal note link<\/a>/);
  assert.match(kitchenSink.html, /<a href="\/notes\/other-note\/#a-heading">internal heading link<\/a>/);
  assert.match(kitchenSink.html, /<a href="https:\/\/example\.com\/">external link<\/a>/);
});

test('raw-HTML internal links are rewritten too', async () => {
  const rendered = await renderMarkdown('<a href="/raw-target/">raw</a>\n', { routeForSlug });
  assert.match(rendered.html, /href="\/notes\/raw-target\/"/);
});

test('the default mapping keeps today’s route shape', async () => {
  assert.equal(defaultRouteForSlug('some-note'), '/some-note/');
  const rendered = await renderMarkdown('[x](/some-note/)\n');
  assert.match(rendered.html, /href="\/some-note\/"/);
});

test('an unmapped slug is left alone rather than pointed at the site root', async () => {
  const rendered = await renderMarkdown('[x](/unknown-note/)\n', { routeForSlug });
  assert.match(rendered.html, /href="\/unknown-note\/"/);
});

test('non-note paths are not treated as slugs', async () => {
  const rendered = await renderMarkdown(
    '[a](/deep/path/) [b](/other-note/extra/) [c](/Other-Note/) [d](/)\n',
    { routeForSlug: () => '/notes/rewritten/' },
  );
  for (const href of ['/deep/path/', '/other-note/extra/', '/Other-Note/', '/']) {
    assert.ok(rendered.html.includes(`href="${href}"`), `rewrote a non-slug path: ${href}`);
  }
});

test('a mapping returning a dangerous route is still sanitized', async () => {
  for (const route of ['javascript:window.alert(1)', 'data:text/html,<script>x</script>', '//evil.example/']) {
    const rendered = await renderMarkdown('[x](/other-note/)\n', { routeForSlug: () => route });
    assert.doesNotMatch(rendered.html, /\shref=/, `dangerous injected route survived: ${route}`);
  }
});

test('sanitization runs after the rewrite, so a rewritten href is re-checked', async () => {
  const rendered = await renderMarkdown('[x](/other-note/#frag)\n', {
    routeForSlug: () => 'https://example.com/notes/x/',
  });
  assert.match(rendered.html, /href="https:\/\/example\.com\/notes\/x\/#frag"/);
});

// --- The page title inside the body ------------------------------------------

/**
 * The exporter writes the note's title into the body as a leading `# Title`,
 * while requirements section 9.2 puts the title above the article, before the
 * metadata and the table of contents. `pageTitle` removes that one duplicate,
 * and does nothing else.
 *
 * "Nothing else" is the part worth testing. An earlier version also demoted
 * every other body `h1` to `h2`, on the reasoning that the page owns the single
 * first-level heading. It preserved the text and destroyed the structure:
 * `# Part Two` followed by `## Section` both became `h2`, so the subsection
 * became a sibling of its own parent in the outline and in the table of
 * contents. The last two tests below are what pins that shut.
 */
test('the body heading that restates the page title is removed', async () => {
  const rendered = await renderMarkdown('# My Note\n\n## Section\n\nBody.\n', { pageTitle: 'My Note' });
  assert.doesNotMatch(rendered.html, /<h1/);
  assert.doesNotMatch(rendered.html, /My Note/);
  assert.deepEqual(rendered.headings.map((heading) => heading.id), ['section']);
  // Whitespace differences between the artifact's title field and the body
  // heading are not a different title.
  const padded = await renderMarkdown('#   My Note  \n\n## Section\n', { pageTitle: 'My Note' });
  assert.doesNotMatch(padded.html, /<h1/);
});

test('the removed heading reserves no id, so a later heading of that name is clean', async () => {
  // The duplicate is dropped before an id is minted. Reserving one would push a
  // genuine later heading of the same text to `-1` and move a deep link that
  // may already be published.
  const rendered = await renderMarkdown('# My Note\n\n## Intro\n\n## My Note\n', { pageTitle: 'My Note' });
  assert.deepEqual(rendered.headings.map((heading) => heading.id), ['intro', 'my-note']);
  assert.match(rendered.html, /<h2 id="my-note">My Note/);
});

test('a body h1 that is not the title is left exactly as authored', async () => {
  const rendered = await renderMarkdown('# Something Else\n\n## Section\n', { pageTitle: 'My Note' });
  assert.match(rendered.html, /<h1 id="something-else">Something Else/);
  assert.deepEqual(
    rendered.headings.map((heading) => [heading.depth, heading.id]),
    [
      [1, 'something-else'],
      [2, 'section'],
    ],
  );
});

test('a second h1 further down the body keeps its level and its subtree', async () => {
  // The regression this exists for: demoting `# Part Two` to `h2` made
  // `## Section` its sibling rather than its child. The nesting below is the
  // whole assertion — text alone surviving is not enough.
  const rendered = await renderMarkdown(
    '# My Note\n\n## A\n\n# Part Two\n\n## Section\n\n### Deep\n',
    { pageTitle: 'My Note' },
  );
  assert.match(rendered.html, /<h1 id="part-two">Part Two/);
  assert.deepEqual(rendered.headings.map((heading) => heading.depth), [2, 1, 2, 3]);
  assert.deepEqual(rendered.toc.map((entry) => entry.id), ['a', 'part-two']);
  assert.deepEqual(rendered.toc[1]?.children.map((entry) => entry.id), ['section']);
  assert.deepEqual(rendered.toc[1]?.children[0]?.children.map((entry) => entry.id), ['deep']);
});

test('every heading in the tree still has an anchor on the page', async () => {
  // The removal's one real hazard: a heading collected into `headings` but no
  // longer rendered would put a dangling `href="#…"` in the table of contents.
  for (const source of [
    '# My Note\n\n## A\n\n### B\n',
    '# Other\n\n## A\n\n# My Note\n\n## B\n',
    '## A\n\n## B\n\n## C\n',
    '# My Note\n\n## My Note\n\n## A\n',
  ]) {
    const rendered = await renderMarkdown(source, { pageTitle: 'My Note' });
    for (const heading of rendered.headings) {
      assert.ok(
        rendered.html.includes(`id="${heading.id}"`),
        `${JSON.stringify(source)}: heading "${heading.id}" is in the tree with no anchor in the HTML`,
      );
    }
  }
});

test('without a page title the body is rendered exactly as before', async () => {
  // Every caller that is not the note page relies on this: the removal must be
  // unreachable unless the option asks for it.
  const source = '# My Note\n\n## Section\n\n# Another\n';
  const rendered = await renderMarkdown(source);
  assert.match(rendered.html, /<h1 id="my-note">My Note/);
  assert.match(rendered.html, /<h1 id="another">Another/);
  assert.deepEqual(rendered.headings.map((heading) => heading.depth), [1, 2, 1]);
});

// --- Metadata flags -----------------------------------------------------------

test('content flags reflect what the page actually contains', async () => {
  assert.equal(kitchenSink.hasCode, true);
  assert.equal(kitchenSink.hasMath, true);
  assert.equal(kitchenSink.hasMermaid, true);

  const prose = await renderMarkdown('Just prose, with `inline code` only.\n');
  assert.equal(prose.hasCode, false);
  assert.equal(prose.hasMath, false);
  assert.equal(prose.hasMermaid, false);

  const displayMath = await renderMarkdown('$$\na + b\n$$\n');
  assert.equal(displayMath.hasMath, true);
  assert.equal(displayMath.hasCode, false);
});

test('a Mermaid-only page does not claim to contain code', async () => {
  const rendered = await renderMarkdown('```mermaid\ngraph TD; A-->B;\n```\n');
  assert.equal(rendered.hasMermaid, true);
  assert.equal(rendered.hasCode, false);
});

// --- Determinism --------------------------------------------------------------

test('rendering the same fixture twice yields byte-identical output', async () => {
  for (const name of ['kitchen-sink.md', 'hostile.md']) {
    const source = fixture(name);
    const first = await renderMarkdown(source, { routeForSlug });
    const second = await renderMarkdown(source, { routeForSlug });
    assert.equal(second.html, first.html, `${name} rendered differently on a second pass`);
    assert.deepEqual(second.headings, first.headings);
    assert.deepEqual(second.toc, first.toc);
  }
});

test('concurrent renders do not contaminate each other', async () => {
  const source = fixture('kitchen-sink.md');
  const [a, b, c] = await Promise.all([
    renderMarkdown(source, { routeForSlug }),
    renderMarkdown('## Shared\n\n## Shared\n', { routeForSlug }),
    renderMarkdown(source, { routeForSlug }),
  ]);
  assert.equal(c!.html, a!.html);
  assert.deepEqual(b!.headings.map((heading) => heading.id), ['shared', 'shared-1']);
});

test('highlighting does not depend on what other pages the build rendered first', async () => {
  // Prism's grammar registry is a process-wide singleton, and several of its
  // components permanently rewrite another language's grammar when loaded:
  // `jsdoc` turns javascript's `token comment` into `token doc-comment comment`,
  // `js-extras` adds `control-flow` to keywords, `css-extras` tokenizes colors.
  // Without an eager load at module init, an identical `js` fence would render
  // differently depending on page order — a real, silent determinism break.
  const probe = '```js\n/** @param a */\nreturn 1;\n```\n';
  const before = await renderMarkdown(probe);
  for (const contaminant of ['jsdoc', 'js-extras', 'js-templates', 'css-extras', 'phpdoc']) {
    await renderMarkdown(`\`\`\`${contaminant}\nx\n\`\`\`\n`);
  }
  const after = await renderMarkdown(probe);
  assert.equal(after.html, before.html, 'rendering a different language changed a js fence');
});

// --- Real artifact ------------------------------------------------------------

test('the shipped artifact renders clean of residue markers', async () => {
  const { entries } = await import('../src/lib/content.ts');
  for (const entry of entries) {
    const rendered = await renderMarkdown(entry.markdown, { routeForSlug });
    for (const pattern of [/msw\//i, /\[\[/, /<script/i, /\son[a-z]+\s*=/i, /javascript:/i, /file:\/\//i]) {
      assert.doesNotMatch(rendered.html, pattern, `entry "${entry.slug}" leaked ${pattern}`);
    }
    assert.doesNotMatch(rendered.html, /(?<![A-Za-z])[A-Za-z]:[\\/]/, `entry "${entry.slug}" leaked a drive path`);
  }
});

test('every fence in the shipped artifact resolves to a real grammar', async () => {
  const { entries } = await import('../src/lib/content.ts');

  /** Fences in one body that were expected to highlight and did not. */
  const unhighlighted = async (markdown: string): Promise<string[]> => {
    const { html } = await renderMarkdown(markdown, { routeForSlug });
    const missed: string[] = [];
    for (const figure of html.match(/<figure class="code-block"[^>]*>[\s\S]*?<\/figure>/g) ?? []) {
      if (/data-diagram="mermaid"/.test(figure)) continue;
      // `plaintext` is the one language with no grammar by design: it is
      // `codePlugin`'s fallback for an unlabelled fence. `text` is here too
      // because `LANGUAGE_ALIASES` maps it to `plaintext` inside `highlight()`
      // while `data-code-language` keeps the raw fence label — so a ```text
      // fence has no grammar either, and keying only on `plaintext` would fail
      // the day a note used it. There is nothing to tokenize in any of these,
      // so requiring a token would fail on any corpus that contains one. What
      // this gate exists for is a *labelled* fence whose language silently has
      // no grammar, leaving the reader plain text where highlighting was meant.
      // The control below proves the exemption did not disarm that.
      if (/data-code-language="(?:plaintext|text)"/.test(figure)) continue;
      if (!/class="token /.test(figure)) missed.push(figure.slice(0, 160));
    }
    return missed;
  };

  // Positive control: a labelled fence with no grammar must still be reported,
  // or the `plaintext` exemption has quietly turned this gate off.
  assert.equal(
    (await unhighlighted('```nosuchlanguage\nx = 1\n```\n')).length,
    1,
    'the gate no longer detects a labelled fence with no grammar',
  );

  for (const entry of entries) {
    assert.deepEqual(
      await unhighlighted(entry.markdown),
      [],
      `entry "${entry.slug}" has a code block that fell back to unhighlighted source`,
    );
  }
});
