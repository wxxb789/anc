import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { TOC_MIN_HEADINGS, defaultRouteForSlug, renderMarkdown, type TocEntry } from '../src/lib/markdown.ts';

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

test('renders task lists as disabled checkboxes, never interactive', () => {
  assert.match(kitchenSink.html, /<ul class="contains-task-list">/);
  assert.match(kitchenSink.html, /<input type="checkbox" disabled \/> Unchecked item/);
  assert.match(kitchenSink.html, /<input type="checkbox" disabled checked \/> Checked item/);
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
    /<figure class="code-block" data-code-language="js"><pre><code class="language-js">/,
  );
  assert.match(kitchenSink.html, /<span class="token token-keyword">const<\/span>/);
  // Shiki-style inline colors would need `style-src 'unsafe-inline'`.
  assert.doesNotMatch(kitchenSink.html, /style="color/);
});

test('every code block carries a copy affordance that is inert without JavaScript', () => {
  // Three fences: js, mermaid, and the unlabelled one. Math is not a code block.
  const figures = kitchenSink.html.match(/<figure class="code-block"[^>]*>/g) ?? [];
  assert.equal(figures.length, 3, `expected one figure per fence, got ${figures.length}`);
  const buttons = kitchenSink.html.match(/<button[^>]*>/g) ?? [];
  assert.equal(buttons.length, figures.length, 'every code block needs exactly one copy button');
  for (const button of buttons) {
    assert.match(button, /type="button"/, `copy button must not default to submit: ${button}`);
    assert.match(button, /hidden/, `copy button must ship hidden: ${button}`);
    assert.match(button, /data-copy-code/, `copy button needs its hook: ${button}`);
  }
});

test('an unlabelled fence is still a copyable code block', () => {
  assert.match(
    kitchenSink.html,
    /<figure class="code-block" data-code-language="plaintext"><pre><code class="language-plaintext">plain fence with no language<\/code><\/pre>/,
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

// --- Downgraded constructs (requirements 15.2) --------------------------------

test('Mermaid downgrades to escaped plain source, never a runtime renderer', () => {
  assert.match(
    kitchenSink.html,
    /<figure class="code-block" data-code-language="mermaid" data-diagram="mermaid"><pre><code class="language-mermaid">graph TD; A--&gt;B;<\/code><\/pre>/,
  );
  assert.equal(kitchenSink.hasMermaid, true);
  assert.doesNotMatch(kitchenSink.html, /<script/i);
});

test('math downgrades to plain source and single dollars stay literal', () => {
  assert.match(kitchenSink.html, /<pre><code class="language-math math-display">E = mc\^2<\/code><\/pre>/);
  assert.equal(kitchenSink.hasMath, true);
  assert.match(kitchenSink.html, /\$5 to \$10/, 'currency must not be parsed as inline math');
  // Math is not a code block: no copy button, no highlighting shell.
  assert.doesNotMatch(kitchenSink.html, /data-code-language="math"/);
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

test('a raw-HTML button cannot act as a submit control', () => {
  for (const button of hostile.html.match(/<button[^>]*>/g) ?? []) {
    assert.match(button, /type="button"/, `button kept submit semantics: ${button}`);
  }
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
