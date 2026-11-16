/**
 * Math and diagrams: the constructs TK-15 turned from downgrades into rendered
 * content.
 *
 * Three properties are load-bearing and each is checked here rather than
 * inferred from the code that produces it:
 *
 * 1. **What ships is what the CSP permits.** A build-time diagram is markup —
 *    real SVG, no inline style, no `<style>` element, no script — and client
 *    math ships its TeX source HTML-escaped inside a `<code>` carrying
 *    `language-math`, substituted into the markup after sanitization.
 *    `tests/built-output.test.ts` owns
 *    the `dist/` assertions; the renderer's own guarantees live in
 *    `tests/diagram-engine.test.ts` and the math rows below.
 * 2. **Nothing reaches a page that does not need it.** A note with no math
 *    links no math stylesheet; a note with no diagram links no diagram
 *    stylesheet and requests no diagram script. Both directions are asserted,
 *    because a gate that only checks the positive passes when everything ships
 *    everywhere.
 * 3. **Rendering is deterministic.** The same source must produce
 *    byte-identical output, across renders and across processes, or the
 *    content-hashed asset URLs change on every build.
 *
 * `dist/` gates skip when the published one-note corpus has no math or diagram
 * to look at, and say so — `pnpm run build:fixture` is what un-skips them.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'vitest';

import { renderMarkdown } from '../src/lib/markdown.ts';
import { renderMath, MathRejectedError, MATH_STYLE_CLASSES } from '../src/lib/math.ts';
import temml from 'temml';

import { MATH_MODE } from '../src/lib/math-mode.ts';
import { extractStyles } from '../src/lib/math-output.ts';
import { MARKED_ROOT, RENDERED_DIAGRAM, RENDERED_MARKER, RENDERED_MATH } from '../src/lib/rendered-marker.ts';
import { entries } from '../src/lib/content.ts';
import { CLIENT_RUNTIME_FLOOR_BYTES } from './support/runtime-budget.ts';

const ROOT = new URL('../', import.meta.url);
const DIST = new URL('dist/', ROOT);

/**
 * The source the cross-process determinism row renders, unchanged from the
 * earlier engine so the row's fresh-process readings stay comparable.
 */
const DETERMINISM_SOURCE = 'gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev';

function walk(directory: URL, extension: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const child = new URL(name, directory);
    if (statSync(child).isDirectory()) found.push(...walk(new URL(`${name}/`, directory), extension));
    else if (name.endsWith(extension)) found.push(fileURLToPath(child));
  }
  return found;
}

function builtPages(): { file: string; html: string }[] {
  return walk(DIST, '.html')
    .filter((file) => !file.includes('pagefind'))
    .map((file) => ({ file, html: readFileSync(file, 'utf8') }));
}

/** Note pages whose body contains the construct, by what the renderer reports. */
async function pagesWith(flag: 'hasMath' | 'hasMermaid'): Promise<Set<string>> {
  // The renderer refuses an unpublished local image `src`, and this helper
  // renders the artifact's own bodies, so it needs the artifact's asset list.
  const { publishedAssets } = await import('../src/lib/content.ts');
  const slugs = new Set<string>();
  for (const entry of entries) {
    const rendered = await renderMarkdown(entry.markdown, { pageTitle: entry.title, publishedAssets });
    if (rendered[flag]) slugs.add(entry.slug);
  }
  return slugs;
}

// --- Math --------------------------------------------------------------------

test('math renders as MathML with no client JavaScript and no inline style', () => {
  const html = renderMath(String.raw`\sum_{i=1}^{n} w_i x_i \geq \theta`, true);
  assert.match(html, /^<math\b/, 'the root element is MathML, not a span of glyphs');
  assert.match(html, /<munderover>/, 'the expression is structured, not a flat run of characters');
  assert.doesNotMatch(html, /\sstyle="/, "style-src 'self' forbids an inline style");
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img|<svg/i, 'MathML needs no image fallback');
});

test('every inline style Temml emits is either reproduced by a class or measured as inert', () => {
  // The extraction is only sound if the class table is *complete over what
  // survives*: a declaration that reaches the page as neither an attribute nor a
  // class has been silently dropped. This renders a wide corpus and asserts
  // zero residual `style=`, which is the property the CSP depends on.
  const corpus = [
    String.raw`\frac{a}{b}`,
    String.raw`\sqrt[3]{x^2+y^2}`,
    String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`,
    String.raw`\begin{aligned} x &= 1 \\ y &= 2 \end{aligned}`,
    String.raw`\begin{array}{c|c} a & b \\ \hline c & d \end{array}`,
    String.raw`\begin{cases} 1 & x>0 \\ 0 & x\le 0 \end{cases}`,
    String.raw`\boxed{E=mc^2}`,
    String.raw`\bordermatrix{ & 1 \cr 2 & 3 }`,
    String.raw`\begin{CD} A @>f>> B \end{CD}`,
    String.raw`\raisebox{2pt}{up}`,
    String.raw`\text{中文数学: } \sum_i 值_i`,
    String.raw`\begin{gather} a \\ b \end{gather}`,
    String.raw`\overbrace{a}^{b}\underbrace{c}_{d}`,
    String.raw`\vec v\hat n\widetilde{abc}`,
    String.raw`\cancel{x}\sout{w}`,
  ];
  for (const isDisplay of [true, false]) {
    for (const tex of corpus) {
      let html: string;
      try {
        html = renderMath(tex, isDisplay);
      } catch (error) {
        // Some environments are display-only — `\begin{CD}` refuses inline mode
        // outright. A rejection is the documented behaviour for a construct
        // that cannot be rendered, so it is not a failure of this gate; what
        // this gate forbids is output that *renders* while carrying a style.
        assert.ok(error instanceof MathRejectedError, `${tex}: unexpected failure`);
        continue;
      }
      assert.doesNotMatch(html, /\sstyle="/, `${tex}: an inline style survived extraction`);
    }
  }
});

test('the classes the math extractor writes all have a rule', () => {
  const stylesheet = readFileSync(new URL('src/styles/math.css', ROOT), 'utf8');
  const names = new Set(Object.values(MATH_STYLE_CLASSES));
  assert.ok(names.size > 0, 'the extractor declares no classes, so this gate checks nothing');
  for (const name of names) {
    assert.match(
      stylesheet,
      new RegExp(`\\.${name}(?![\\w-])`),
      `math.css has no rule for "${name}", which the extractor writes onto elements`,
    );
  }
});

test('author-chosen colour is rejected rather than mapped or silently dropped', () => {
  // The recorded decision. `\textcolor{red}` is 3.9:1 on the dark background and
  // `\textcolor{yellow}` is 1.1:1 on the light one, so no single mapping holds
  // contrast in both themes; dropping it silently removes the only thing
  // distinguishing the term. Requirements §15.2 permits failing export instead.
  //
  // `\fcolorbox` is listed by name because it is the one that got away: it was
  // missing from the first rejection list and, unlike the others, it emits
  // `mathbackground="#FFFF00"` as an *attribute*, so the extraction pass never
  // saw it and the zero-inline-styles gate stayed green while an author-chosen
  // yellow shipped at 1.1:1. That is why the guarantee is now the output check
  // in `assertNoAuthoredColour` rather than the name list, which cannot be
  // complete.
  for (const command of [
    '\\textcolor{red}{x}',
    '\\color{blue} y',
    '\\colorbox{red}{x}',
    '\\fcolorbox{red}{yellow}{x}',
    '\\pagecolor{red}',
  ]) {
    assert.throws(
      () => renderMath(command, true),
      (error: unknown) => error instanceof MathRejectedError,
      `${command} must be rejected, not rendered`,
    );
  }
  // The alternatives named in the rejection message must actually work, or the
  // message sends an author to a second failure.
  for (const alternative of ['\\mathbf{x}', '\\underline{x}', '\\boxed{x}', '\\overbrace{x}^{y}']) {
    assert.doesNotThrow(() => renderMath(alternative, true), `${alternative} is offered as an alternative`);
  }
});

test('no authored colour reaches the page, whichever command produced it', () => {
  // The structural half, and the one that actually holds the property: over a
  // wide corpus, the only colour value that may survive is `currentColor`,
  // which resolves to the surrounding text colour and therefore cannot fail
  // contrast in either theme. A name list is a blocklist; this is the check
  // that does not depend on having enumerated every spelling.
  const corpus = [
    String.raw`\sum_{i=1}^{n} x_i`,
    String.raw`\begin{array}{c|c} a & b \\ \hline c & d \end{array}`,
    String.raw`\boxed{E=mc^2}`,
    String.raw`\rule{2em}{1pt}`,
    String.raw`\cancel{x}\sout{w}`,
    String.raw`\text{中文} \sum_i 值_i`,
    String.raw`\begin{aligned} x &= 1 \\ y &= 2 \end{aligned}`,
  ];
  for (const isDisplay of [true, false]) {
    for (const tex of corpus) {
      let html: string;
      try {
        html = renderMath(tex, isDisplay);
      } catch (error) {
        assert.ok(error instanceof MathRejectedError, `${tex}: unexpected failure`);
        continue;
      }
      for (const [, attribute, value] of html.matchAll(
        /\s(mathbackground|mathcolor|color|background)="([^"]*)"/g,
      )) {
        assert.equal(value, 'currentColor', `${tex}: ${attribute}="${value}" is an authored colour`);
      }
    }
  }
});

test('a malformed expression fails the build rather than shipping error markup', () => {
  // Temml's own fallback is markup carrying an inline `color`, which the
  // sanitizer strips — leaving the broken source with nothing marking it broken.
  assert.throws(() => renderMath('\\frac{', true), (error: unknown) => error instanceof MathRejectedError);
  assert.throws(() => renderMath('\\nosuchcommand', true), (error: unknown) => error instanceof MathRejectedError);
});

test('math commands that would inject a URL or an attribute are refused', () => {
  // Temml refuses these under `trust: false`. Asserted rather than assumed,
  // because the option is the whole boundary: `\href` would put an author-chosen
  // URL in the document and `\class` an author-chosen class.
  for (const command of [
    String.raw`\href{https://example.com}{x}`,
    String.raw`\url{https://example.com}`,
    String.raw`\includegraphics[width=1em]{x.png}`,
    String.raw`\class{foo}{x}`,
    String.raw`\style{color: red}{x}`,
    String.raw`\htmlData{a=b}{x}`,
  ]) {
    assert.throws(
      () => renderMath(command, true),
      (error: unknown) => error instanceof MathRejectedError,
      `${command} must not reach the page`,
    );
  }
});

test('a rule renders in the reader’s own ink rather than hardcoded black', () => {
  // `\rule` is the one place Temml hardcodes a colour: `mathbackground="black"`,
  // which on the dark palette is a black bar on a near-black background —
  // present, correctly sized, and invisible.
  const html = renderMath(String.raw`\rule{2em}{1pt}`, true);
  assert.doesNotMatch(html, /mathbackground="black"/, 'a hardcoded black bar disappears in dark mode');
  assert.match(html, /mathbackground="currentColor"/);
});

test('math rendering is deterministic', () => {
  const tex = String.raw`\begin{array}{c|c} a & b \\ \hline c & d \end{array}`;
  assert.equal(renderMath(tex, true), renderMath(tex, true));
});

// --- Diagrams ----------------------------------------------------------------

test('diagram rendering is deterministic across processes', () => {
  // The stronger property, and the one that matters for a content hash: a fresh
  // process must produce the same bytes. The row runs the shipped adapter —
  // `tests/support/render-diagram.ts` imports `src/lib/pele-render.ts` — so what
  // it compares is the bytes the build actually inserts.
  const script = fileURLToPath(new URL('tests/support/render-diagram.ts', ROOT));
  const source = DETERMINISM_SOURCE;
  // **The inner budget is smaller than the outer one, which is the point.**
  // `tests/verify.test.ts` records this gate failing once as a timeout while
  // waiting on children it had itself budgeted 120 s each, under a 90 s outer
  // bound — a gate whose inner budget exceeds its outer cannot fail the way it
  // intends to, because the outer clock always wins and reports a hang as "the
  // test was slow" rather than "a child never returned".
  //
  // The outer is 240 s so that **both** children can hit their own bound and
  // still fail inside it: 2 × 90 = 180 s. That ordering is the fix — a hung
  // child fails at its own timeout naming the child, rather than the outer clock
  // reporting "the test was slow".
  //
  // Measured 2026-11-16 through `pele-render.ts`: one child cost 0.25-0.5 s
  // idle, so both budgets are loose upper bounds. They were left as they were
  // rather than tightened — a timing change does not belong in the change that
  // deleted an engine.
  const run = (): string =>
    execFileSync(process.execPath, [script, source], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(run(), run(), 'two processes rendered the same diagram differently');
}, 240_000);

// --- The pipeline ------------------------------------------------------------

test('a diagram figure carries a caption that names it', async () => {
  const declared = await renderMarkdown('```mermaid\npie title Publication Sources\n  "Vault" : 45\n```\n');
  assert.match(declared.html, /<figcaption>Publication Sources<\/figcaption>/);
  // The SVG carries the caption as `aria-label` too, so a screen reader meeting
  // the graphics role hears the same words as the sighted reader.
  assert.match(declared.html, /aria-label="Publication Sources"/);

  // With no declared title the diagram's kind is the honest fallback: it says
  // what the reader is looking at without inventing a description.
  const undeclared = await renderMarkdown('```mermaid\nsequenceDiagram\n  A->>B: x\n```\n');
  assert.match(undeclared.html, /<figcaption>Sequence diagram<\/figcaption>/);
});

test('two diagrams on one page do not collide on element ids', async () => {
  // An id is unique within one element's own render, so two diagrams on one
  // page would both define the same id and the second definition would win for
  // both — silently, in both diagrams, with no error anywhere.
  //
  // **The source is chosen from a census, not from convenience.** Measured
  // 2026-11-16 through the `pele` engine over the 23-type matrix and the
  // branch fixtures, only the sankey renderer mints ids at all — two for a
  // two-edge source, five for the five-edge pair below — and each is referenced
  // exactly once through `url(#…)`. The flowchart pair this gate used before
  // the engine switch carries **zero** ids under this renderer: uniqueness over
  // an empty set is true and the gate would assert nothing.
  //
  // What makes the two diagrams' ids differ is the `diagram-<index>` id prefix
  // `markdown.ts` passes to the renderer. A renderer that dropped it would mint
  // the same id for both identical sources, and the equality below is what
  // fails.
  const rendered = await renderMarkdown(
    '```mermaid\nsankey-beta\nA,B,10\nB,C,5\nC,D,3\nD,E,7\nE,F,2\n```\n\n' +
      '```mermaid\nsankey-beta\nA,B,10\nB,C,5\nC,D,3\nD,E,7\nE,F,2\n```\n',
  );
  const ids = [...rendered.html.matchAll(/\sid="([^"]*)"/g)].map(([, id]) => id!);
  assert.ok(
    ids.length >= 8,
    `only ${ids.length} ids; the measured pair mints 10 (5 per diagram), so a one-diagram render must not pass this row`,
  );
  assert.equal(new Set(ids).size, ids.length, 'two diagrams on one page share an element id');

  // Every internal reference resolves. A unique-id check alone would pass a
  // renaming that changed the definitions and left `url(#…)` pointing at the
  // old names — and a sankey has no arrowheads: the definitions are
  // `<linearGradient>` paint servers referenced from each link path's `fill`,
  // so a dangling reference costs each link its gradient (it paints the flat
  // fallback colour in the same `fill`), not an arrowhead.
  const references = [...rendered.html.matchAll(/url\(#([^)]*)\)/g)].map(([, id]) => id!);
  assert.ok(
    references.length >= 8,
    `only ${references.length} references; the measured pair mints 10 (5 per diagram), so a one-diagram render must not pass this row`,
  );
  const defined = new Set(ids);
  for (const reference of references) {
    assert.ok(defined.has(reference), `url(#${reference}) points at no element on the page`);
  }
});

test('a page rendering both constructs reports both and neither leaks a placeholder', async () => {
  const rendered = await renderMarkdown('$$\na+b\n$$\n\n```mermaid\ngraph TD\n  A --> B\n```\n');
  assert.equal(rendered.hasMath, true);
  assert.equal(rendered.hasMermaid, true);
  assert.doesNotMatch(rendered.html, /rendered\w*Placeholder/, 'a substitution marker reached the page');
});

test('a note body cannot forge a rendering placeholder', async () => {
  // The markers are spliced into *sanitized* HTML, which makes them the one
  // seam in this pipeline where body content could plausibly reach the page
  // unsanitized. Substitution is positional and exhausting, so a body that
  // writes a marker is a loud build failure rather than a body receiving
  // somebody else's diagram — and it can never inject markup either way,
  // because the replacement is chosen by index from this render's own list.
  //
  // Every shape a marker can appear in is checked, because they reach the
  // sanitizer by different routes: prose is a text node, a fence is escaped
  // source, raw HTML is an opaque node, and an attribute value is neither.
  const forgeries = [
    'renderedMathPlaceholder0End\n\n$$\na\n$$\n',
    'renderedDiagramPlaceholder0End\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
    '```js\nrenderedMathPlaceholder0End\n```\n\n$$\na\n$$\n',
    '`renderedMathPlaceholder0End`\n\n$$\na\n$$\n',
    '<div>renderedMathPlaceholder0End</div>\n\n$$\na\n$$\n',
    '<a href="/x/" title="renderedMathPlaceholder0End">y</a>\n\n$$\na\n$$\n',
    '![renderedMathPlaceholder0End](https://example.com/a.png)\n\n$$\na\n$$\n',
    // A marker this render never minted: a different index, and the diagram
    // form on a page that has only math. Neither collides with a real token, so
    // without the residue check they would ship as visible gibberish.
    'renderedMathPlaceholder0End\n',
    'renderedMathPlaceholder99End\n\n$$\na\n$$\n',
    'renderedDiagramPlaceholder0End\n\n$$\na\n$$\n',
  ];
  for (const markdown of forgeries) {
    await assert.rejects(
      () => renderMarkdown(markdown),
      /placeholder/i,
      `a forged placeholder reached the page: ${markdown.slice(0, 60)}`,
    );
  }
});

test('hostile content inside math or a diagram cannot reach the page as markup', async () => {
  // Both renderers take author text and emit markup that bypasses the
  // sanitizer, so what an author writes *inside* an expression or a diagram
  // label is the other half of the seam. Every case below must render inert:
  // none may produce a script, a handler, or a live URL.
  //
  // `\s` before the handler pattern is what distinguishes `onerror=` as an
  // attribute from `onerror=` as escaped text: the escaped form is preceded by
  // `&quot;` or a letter, never by whitespace inside a tag.
  const hostile = [
    '$$\n\\text{</math><script>alert(1)</script>}\n$$\n',
    '```mermaid\ngraph TD\n  A["</svg><script>alert(1)</script>"] --> B\n```\n',
    '```mermaid\ngraph TD\n  A["<img src=x onerror=alert(1)>"] --> B\n```\n',
    '```mermaid\ngraph TD\n  A --> B\n  click A callback\n```\n',
  ];
  for (const markdown of hostile) {
    const { html } = await renderMarkdown(markdown);
    assert.doesNotMatch(html, /<script/i, `a script survived: ${markdown.slice(0, 50)}`);
    assert.doesNotMatch(html, /<style/i, `a style element survived: ${markdown.slice(0, 50)}`);
    assert.doesNotMatch(html, /\sstyle="/, `an inline style survived: ${markdown.slice(0, 50)}`);
    // Only real attributes count. Escaped text is inert by construction.
    for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, `a handler attribute survived: ${tag.slice(0, 80)}`);
      assert.doesNotMatch(tag, /="javascript:/i, `a javascript: URL survived: ${tag.slice(0, 80)}`);
    }
  }
});

test('a diagram cannot emit a link the projection never approved', async () => {
  // Mermaid's `click` directive turns a node into an anchor pointing anywhere
  // the author wrote, including a `javascript:` URL — and the SVG never passes
  // through the href allowlist that governs prose links.
  //
  // The renderer answers by construction: `pele-render.ts` renders with
  // `links: false`, so the directive is dropped — measured 2026-11-16, the URL
  // reaches no byte of the output and no anchor is minted. What is asserted
  // here is that property rather than the mechanism: no anchor and no URL in
  // the markup.
  const sources = [
    '```mermaid\ngraph TD\n  A --> B\n  click A "https://evil.example" _blank\n```\n',
    '```mermaid\ngraph TD\n  A --> B\n  click A href "javascript:alert(1)"\n```\n',
  ];

  for (const source of sources) {
    const { html } = await renderMarkdown(source);
    assert.doesNotMatch(html, /<a\b/i, `${source}: a diagram emitted an anchor`);
    assert.doesNotMatch(html, /(?:xlink:)?href\s*=/i, `${source}: a diagram emitted an href`);
    assert.doesNotMatch(html, /javascript:/i, `${source}: a javascript: URL reached the markup`);
    assert.ok(!html.includes('evil.example'), `${source}: the URL reached the markup`);
    assert.match(html, /<svg\b/, `${source}: nothing rendered, so the absence proves nothing`);
  }
});

// --- What reaches a page -----------------------------------------------------

test('no chunk carries a diagram runtime', () => {
  // The diagram renderer is build-time only: `markdown.ts` imports
  // `pele-render.ts` into the build, and no page ships a diagram script, so no
  // byte of either the live renderer or the deleted one may appear under
  // `dist/`. Measured over `dist/` because the failure — chunks emitted but
  // referenced by nothing — is invisible in the rendered page and was a real
  // defect during TK-15, caught only by the residue scan.
  //
  // **Named per runtime rather than by one list of vendor strings**, so the
  // check has nothing to forget: `pele` is the diagram runtime, and
  // `mermaid|cytoscape|dagre` is a re-addition tripwire — the dependency graph
  // already makes those bytes unreachable (pnpm's symlinked `node_modules`
  // boundary, gated by `tests/packaging.test.ts`), so the scan only fails if
  // someone deliberately puts one back.
  //
  // **And read as bytes, not only as file names.** Chunk names carry the entry
  // module's basename, while what matters is whether the runtime's code is in
  // the output. Both checks run; the content one is the load-bearing half.
  //
  // `dist/wasm/*.js` is out of scope by name: it is the SQLite read model's
  // loader, copied from the wasm package and shipped independently of any
  // renderer. Nothing bounds its bytes: `tests/output-inventory.test.ts` binds
  // the loaders' membership and verifies only the `.wasm` binary's digest,
  // while `tests/graph-runtime.test.ts` counts its requests. Neither gate
  // imposes a byte-size ceiling on the loaders.
  const scripts = walk(DIST, '.js').filter(
    (file) => !file.includes('pagefind') && !/[/\\]wasm[/\\]/.test(file),
  );
  const forbidden: readonly [boolean, RegExp, string][] = [
    [true, /pele/i, 'the diagram runtime'],
    [true, /mermaid|cytoscape|dagre/i, 'a deleted diagram runtime'],
    [MATH_MODE === 'build-time', /temml/i, 'the math runtime'],
  ];
  const root = fileURLToPath(DIST);
  let inspected = 0;
  for (const file of scripts) {
    inspected += 1;
    const code = readFileSync(file, 'utf8');
    // The *published* name, not the host path: a checkout directory is allowed
    // to be named after anything (this one contains the string being checked),
    // and what matters is the name a reader's request carries.
    const name = relative(root, file);
    for (const [applies, pattern, what] of forbidden) {
      if (!applies) continue;
      assert.ok(!pattern.test(name), `${name}: ${what} chunk shipped`);
      assert.ok(!pattern.test(code), `${file}: ${what} code shipped`);
    }
  }
  assert.ok(inspected > 0, 'no chunk was inspected, so the absence was never checked');

  // The site-wide total is scoped to what the selected modes account for: this
  // site's own scripts against the 100 KB this gate has always allowed them,
  // plus the measured floor of each runtime a *selected client* mode ships (the
  // same numbers `tests/support/runtime-budget.ts` grants per page). Measured
  // 2026-11-16 on the fixture corpus: 257,647 B total, of which the selected
  // client math runtime (`temml.<hash>.js`) is 203,577 B.
  const ceiling =
    100 * 1024 +
    (MATH_MODE === 'client' ? CLIENT_RUNTIME_FLOOR_BYTES[RENDERED_MATH] : 0);
  const bytes = scripts.reduce((total, file) => total + statSync(file).size, 0);
  assert.ok(bytes < ceiling, `client JavaScript totals ${bytes} B, over the ${ceiling} B the selected modes account for`);
});

test('a page with no diagram and no math requests neither asset', async (t: TestContext) => {
  const withMath = await pagesWith('hasMath');
  const withDiagram = await pagesWith('hasMermaid');
  if (withMath.size === 0 && withDiagram.size === 0) {
    return t.skip('no corpus entry carries math or a diagram — run `pnpm run build:fixture`');
  }

  let checkedBare = 0;
  for (const { file, html } of builtPages()) {
    const slug = /notes[\\/]([^\\/]+)[\\/]index\.html$/.exec(file)?.[1];
    const linksMath = /<link[^>]+href="[^"]*math[^"]*\.css"/.test(html);
    const linksDiagram = /<link[^>]+href="[^"]*diagram[^"]*\.css"/.test(html);

    if (slug !== undefined && withMath.has(slug)) {
      assert.ok(linksMath, `${file}: has math but links no math stylesheet`);
    } else {
      assert.ok(!linksMath, `${file}: links the math stylesheet without containing math`);
      if (slug !== undefined) checkedBare += 1;
    }

    if (slug !== undefined && withDiagram.has(slug)) {
      assert.ok(linksDiagram, `${file}: has a diagram but links no diagram stylesheet`);
    } else {
      assert.ok(!linksDiagram, `${file}: links the diagram stylesheet without containing a diagram`);
      // The `<script>` half, which the ticket names alongside the `<link>` half
      // and which matters more: in the client diagram mode that once existed
      // the runtime was the 201 KB floor, so a page without a diagram
      // requesting one was the expensive failure. No diagram script ships at
      // all now, so this scan is the request-level absence — a re-added chunk
      // named after one fails here.
      for (const [, source] of html.matchAll(/<script\b[^>]*\ssrc="([^"]*)"/g)) {
        assert.doesNotMatch(
          source!,
          /diagram|mermaid/i,
          `${file}: requests a diagram script without containing a diagram`,
        );
      }
    }
  }

  assert.ok(checkedBare > 0, 'no page without math was inspected, so the negative was never checked');
});

test('the built diagram markup is CSP-clean', async (t: TestContext) => {
  const pages = builtPages().filter(({ html }) => html.includes('data-diagram="mermaid"'));
  if (pages.length === 0) {
    return t.skip('no built page carries a diagram — run `pnpm run build:fixture`');
  }
  for (const { file, html } of pages) {
    const figures = html.match(/<figure class="diagram"[\s\S]*?<\/figure>/g) ?? [];
    assert.ok(figures.length > 0, `${file}: reports a diagram but has no diagram figure`);
    for (const figure of figures) {
      assert.match(figure, /<svg\b/, `${file}: a diagram figure carries no SVG`);
      assert.doesNotMatch(figure, /\sstyle="/, `${file}: a diagram carries an inline style`);
      assert.doesNotMatch(figure, /<style/i, `${file}: a diagram carries a <style> element`);
      assert.match(figure, /<figcaption>/, `${file}: a diagram figure has no caption`);
    }
  }
});

test('the diagram stylesheet pins the root font at the size the renderer laid out with', () => {
  // Pele's root block — stripped by the adapter and re-created by
  // `.diagram svg.pele` — declares `font: 16px` as one of its measured members
  // (`ROOT_STYLE_DECLARATIONS` in `pele-render.ts`). The geometry is baked into
  // the SVG at build time, so the number the renderer laid out with is the only
  // number that can be correct; this site's body text is `--text-base`,
  // 1.0625rem — **17 px** — and an unpinned diagram would inherit it.
  const stylesheet = readFileSync(new URL('src/styles/diagram.css', ROOT), 'utf8');
  assert.match(
    stylesheet,
    /\.diagram svg\.pele[^{]*\{[^}]*font:\s*16px/,
    'diagram.css must keep the 16px root font the renderer laid out with',
  );
  // In `px`, not `rem`: a reader who scales the root font size scales the whole
  // SVG, which keeps each label inside its box, whereas scaling only the text
  // would reintroduce exactly the mismatch this pin removes. The refusal is
  // scoped by selector rather than by block: it binds every `.diagram`-prefixed
  // rule.
  assert.doesNotMatch(
    stylesheet,
    /\.diagram[^{]*\{[^}]*font-size:\s*[\d.]+rem/,
    'a rem font size re-couples the label to the root size and reintroduces clipping',
  );
  // The renderer carries per-element `font-size` presentation attributes —
  // `font-size` is in the adapter's emission allowlist — and a class rule beats
  // an attribute, so a `.diagram text` size rule would override the renderer's
  // own sizing.
  assert.doesNotMatch(
    stylesheet,
    /\.diagram text[^{]*\{[^}]*font-size/,
    'pinning SVG text overrides the per-element sizes the renderer wrote',
  );
});

test('the per-page cost of math and diagrams is recorded', async (t: TestContext) => {
  // Requirements §18 budgets the article route. These are the numbers the report
  // quotes; the gate exists so a regression that doubles them is caught rather
  // than discovered later. Bounds are deliberately loose — this measures the
  // shape of the cost, not a byte-exact target.
  const pages = builtPages().filter(({ html }) => html.includes('data-diagram="mermaid"'));
  if (pages.length === 0) return t.skip('no built page carries a diagram — run `pnpm run build:fixture`');

  for (const { file, html } of pages) {
    for (const figure of html.match(/<svg\b[\s\S]*?<\/svg>/g) ?? []) {
      const gzip = gzipSync(figure).length;
      assert.ok(gzip < 12 * 1024, `${file}: one diagram costs ${gzip} B gzip, far above the 486-801 B measured across six types`);
    }
  }

  const stylesheets = walk(DIST, '.css').filter((file) => /math|diagram/.test(file));
  for (const file of stylesheets) {
    const gzip = gzipSync(readFileSync(file)).length;
    assert.ok(gzip < 6 * 1024, `${file}: ${gzip} B gzip, above what a per-page sheet should cost`);
  }
});

// --- Client math -------------------------------------------------------------

/**
 * The client math path's markup, asserted through the real renderer.
 *
 * Mode-independent by construction: it renders with the mode the tree carries
 * and asserts whichever shape that mode owes. A gate that only ran in one mode
 * would be skipped in the shipped one and would therefore never have caught the
 * `data-math` attribute this path originally carried — measured, the sanitizer
 * stripped it, and the fix keyed on it would have compiled, read correctly, and
 * done nothing.
 */
test('math emits the shape its mode owes, and the sanitizer keeps all of it', async () => {
  for (const [what, body, isDisplay] of [
    ['display', String.raw`$$
f:\mathbb{R} \to \mathbb{C}
$$
`, true],
    ['inline', 'See $$x^2 + y^2$$ inline.\n', false],
  ] as const) {
    const { html, hasMath } = await renderMarkdown(body, { pageTitle: 'x' });
    assert.ok(hasMath, `${what}: hasMath was not set — it is read before the mode branch`);
    assert.match(html, /class="math-(?:inline|display)"/, `${what}: the carrier class was stripped`);
    if (isDisplay) assert.match(html, /tabindex="0"/, `${what}: the display wrapper lost its keyboard stop`);

    if (MATH_MODE === 'client') {
      // The TeX source, HTML-escaped by `escapeHtml` and substituted after
      // sanitization: `renderMarkdown` splices a `<code
      // class="language-math">` carrying the escaped source
      // (`src/lib/markdown.ts:1919`) into the sanitized `span.math-inline` /
      // `span.math-display` carrier through `substituteRendered` (`:1817`). A
      // `pre` cannot be used: measured, a `<pre>` inside a `<p>` is torn out of
      // the paragraph by the parser, which would break every paragraph carrying
      // inline math.
      assert.match(html, /<code\b[^>]*class="language-math"/, `${what}: the source element or its class was stripped`);
      assert.ok(!html.includes('<math'), `${what}: MathML shipped in client mode`);
    } else {
      assert.match(html, /<math\b/, `${what}: build-time mode shipped no MathML`);
      assert.ok(!/<code class="language-math">/.test(html), `${what}: build-time mode shipped the source`);
    }
  }

  // In the shipped mode the escaping is this pipeline's own: the client-math
  // replacement writes the source through `escapeHtml`
  // (`src/lib/markdown.ts:1919`, the function at `:403`) and is spliced into
  // already-serialized HTML by `substituteRendered` (`:1817`), so no serializer
  // runs over the substituted markup. Build-time mode escapes its MathML inside
  // Temml (`src/lib/math.ts:153`), measured: `a < b > c` comes out with `&lt;`
  // and no `<b`. Asserted rather than assumed, because a text node that reached
  // the page raw would be an injection point rather than a cosmetic defect.
  // `a < b > c` is valid TeX in both modes; an earlier version of this row
  // wrote `\&`, which is not, so it failed at the *renderer* and measured
  // nothing about escaping at all.
  const { html } = await renderMarkdown('See $$a < b > c$$ inline.\n', { pageTitle: 'x' });
  assert.ok(!/<b\b/.test(html), `an unescaped angle bracket reached the page: ${html}`);
  assert.match(html, /&lt;/, `the comparison operator vanished entirely: ${html}`);
});

/**
 * Client mode's rendering happens in a browser, so the *client* path's CSP
 * cleanliness cannot be measured from Node — but the property it depends on can.
 *
 * `extractStyles` is what removes every `style` attribute Temml writes, and in
 * client mode its output goes into `innerHTML` with no sanitizer behind it. So a
 * residual `style` is a CSP violation on a real page. Measured in Chromium under
 * the policy from `public/_headers`: without this call `\begin{pmatrix}` violated
 * 4 times, `\begin{aligned}` and `\begin{array}` 4 each, `\boxed` once, `\pmb`
 * once and `\sideset` twice; with it, all six are silent.
 *
 * **The corpus is the six that violated**, not a convenient sample. The received
 * account named only `\pmb` and `\sideset`, and a gate built from that account
 * would pass while a matrix violated four times on every page carrying one.
 */
test('the shared extraction leaves no inline style for either mode to replay', () => {
  const corpus = [
    ['a matrix', String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`],
    ['aligned', String.raw`\begin{aligned} x &= 1 \\ y &= 2 \end{aligned}`],
    ['an array', String.raw`\begin{array}{c|c} a & b \\ \hline c & d \end{array}`],
    ['boxed', String.raw`\boxed{E=mc^2}`],
    ['pmb', String.raw`\pmb{x}`],
    ['sideset', String.raw`\sideset{_a^b}{_c^d}\sum`],
  ] as const;

  let styled = 0;
  for (const [what, tex] of corpus) {
    const raw = temml.renderToString(tex, { displayMode: false, throwOnError: false });
    // **The expression must have rendered, not errored.** Temml's error markup is
    // a `<span class="temml-error" style="color:#b22222…">`, which carries a
    // `style` — so a malformed fixture satisfies the count below while measuring
    // an error span rather than the structure it names. Three rows of this corpus
    // were exactly that: a heredoc ate one backslash from each `\\` row, so
    // `\begin{pmatrix} a & b \ c & d \end{pmatrix}` was a parse error that
    // happened to be styled. `docs/gate-reading.md` case 5.
    assert.doesNotMatch(raw, /temml-error/, `${what}: the fixture does not parse, so it measures an error span`);
    if (/\sstyle="/.test(raw)) styled += 1;
    assert.doesNotMatch(
      extractStyles(raw),
      /\sstyle="/,
      `${what}: a style attribute survived extraction and would violate style-src in client mode`,
    );
  }
  // Non-vacuity: the corpus must actually contain the thing being extracted, or
  // this passes on six expressions Temml never styled.
  assert.equal(styled, corpus.length, `only ${styled} of ${corpus.length} corpus expressions carried a style`);
});

/**
 * The client runtime must actually *call* the extraction, not merely have it
 * available.
 *
 * The gate above proves `extractStyles` is correct; this proves the one caller
 * that has no sanitizer behind it uses it. Measured as a gap: deleting the call
 * from `src/scripts/math.ts` left every other gate in this file green, because
 * nothing here executes that module — it runs in a browser, and its failure mode
 * is a CSP violation on a real page rather than an assertion anywhere.
 *
 * Read as source text rather than executed, which is the honest description of
 * what this can check. Comments are stripped first: this file's own prose says
 * `extractStyles` several times, and a gate matching that would match itself —
 * `docs/gate-reading.md` case 4, which `tests/dist-lock.test.ts` already paid
 * for once.
 */
test('the client math runtime extracts styles before it writes innerHTML', () => {
  const source = readFileSync(new URL('src/scripts/math.ts', ROOT), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const write = /\binnerHTML\s*=\s*(.+);/.exec(source);
  assert.ok(write, 'the runtime no longer writes innerHTML, so this gate is measuring nothing');
  assert.match(
    write[1]!,
    /\bextractStyles\(/,
    'the client runtime writes Temml output to innerHTML without extracting its inline styles, ' +
      "which style-src 'self' blocks — measured at 4 violations for a single matrix",
  );
  assert.match(write[1]!, /\bcurrentColorRules\(/, "\rule's hardcoded black would be invisible on the dark palette");
});

/**
 * The colour rejection runs in **both** modes.
 *
 * `src/lib/math.ts` refuses `\textcolor`, `\color`, `\colorbox`, `\fcolorbox`
 * and `\pagecolor`, then re-checks the rendered output for any colour attribute
 * whatever — a check its own docblock calls total. Client rendering moves where
 * the MathML is produced; it does not move what an author may write.
 *
 * **A first version of the client branch skipped it**, and the consequence was
 * measured rather than argued: `\colorbox{yellow}{x}` failed the build in
 * build-time mode and, through the client branch, shipped to the browser, where
 * the runtime rendered `<mrow mathbackground="#FFFF00">` — the 1.1:1 yellow on
 * the light palette that the whole rejection exists to prevent. Found by review.
 *
 * Asserted mode-independently, so the gate holds in whichever mode the tree
 * carries rather than skipping in the shipped one.
 */
test('an authored colour is refused in whichever mode renders it', async () => {
  for (const command of [
    String.raw`\textcolor{red}{x}`,
    String.raw`\colorbox{yellow}{x}`,
    String.raw`\fcolorbox{red}{yellow}{x}`,
  ]) {
    await assert.rejects(
      () => renderMarkdown(`See $$${command}$$ here.\n`, { pageTitle: 'x' }),
      (error: unknown) => error instanceof MathRejectedError,
      `${command}: an author-chosen colour was accepted in ${MATH_MODE} mode`,
    );
  }

  // Non-vacuity: an ordinary expression still renders, so the rows above are a
  // statement about colour rather than about math failing wholesale.
  const { hasMath } = await renderMarkdown('See $$x^2$$ here.\n', { pageTitle: 'x' });
  assert.ok(hasMath, 'an ordinary expression stopped rendering, so the refusals prove nothing');
});

test('the rendered marker cannot be written by a note body', async () => {
  // **The property the two consumers rest on.** `scripts/scan-residue.ts` uses
  // this marker to decide that a region is real TeX rather than a pasted host
  // path, and `tests/built-routes.test.ts` uses it to grant a page a JavaScript
  // allowance. Both were previously keyed on things a body can write —
  // `code.language-math` and `class="math-inline"` — and measured, a fence
  // labelled `language-math` took a host path from FIRES to CLEAN.
  //
  // Three ways a body could try, and each must fail differently but safely.
  for (const [what, body] of [
    ['the attribute directly', `<code ${RENDERED_MARKER}="${RENDERED_MATH}">C:\\Users\\alice</code>`],
    ['on a figure', `<figure class="diagram" ${RENDERED_MARKER}="${RENDERED_DIAGRAM}">forged</figure>`],
    ['the old forgeable key', '```language-math\nC:\\Users\\alice\\private.md\n```'],
    ['the class alone', '<span class="math-inline">forged</span>'],
  ] as const) {
    const { html } = await renderMarkdown(body, { pageTitle: 'x' });
    assert.ok(
      !html.includes(RENDERED_MARKER),
      `${what}: a note body produced the marker — the sanitizer's allowlist must not carry it: ${html}`,
    );
  }

  // **The marker as ordinary text, which is the shape the four rows above miss
  // entirely.** The string has no character an HTML escaper rewrites, so a body
  // typing it in a paragraph puts it in the output verbatim — and so does a body
  // writing it as numeric character references. Neither is stopped, and neither
  // should be: it is the author's text.
  //
  // What this means is that **presence in the page is not the property**, and a
  // consumer testing for the bare string is forgeable by a paragraph. Measured
  // as a real defect in the first version of the script-budget gate, which was
  // then *strictly worse* than the author-writable class it replaced.
  // `MARKED_ROOT` is the shape a consumer must use, and these rows pin the
  // difference between the two.
  for (const [what, body] of [
    ['plain prose', `The attribute ${RENDERED_MARKER}="${RENDERED_MATH}" written in prose.`],
    ['a code span', `Inline \`${RENDERED_MARKER}="${RENDERED_MATH}"\` here.`],
    ['numeric references', 'x &#100;&#97;&#116;&#97;-rendered=&#34;math&#34; y'],
  ] as const) {
    const { html } = await renderMarkdown(body, { pageTitle: 'x' });
    assert.ok(
      !MARKED_ROOT(RENDERED_MATH).test(html),
      `${what}: text in a body satisfied MARKED_ROOT, so a consumer keyed on it is forgeable: ${html}`,
    );
  }

  // And the substitution token, which is the other half: a body writing one does
  // not receive somebody else's render, it stops the build. Positional and
  // exhausting, which is what `substituteRendered` documents.
  await assert.rejects(
    () => renderMarkdown('Prose renderedMathPlaceholder0End more.\n', { pageTitle: 'x' }),
    /placeholder survived substitution/,
    'a body writing a substitution token did not stop the build',
  );

  // Non-vacuity: the pipeline really does mint it, in the position a consumer
  // looks for, or every assertion above is satisfied by a marker that never
  // exists.
  const { html } = await renderMarkdown('See $$x^2$$ here.\n', { pageTitle: 'x' });
  assert.match(html, MARKED_ROOT(RENDERED_MATH), 'the pipeline minted no marker in an attribute position');
});

test('the marker reaches no reader as visible text', async () => {
  // The real Pagefind index is asserted in `tests/client-marker.test.ts`; an
  // earlier version claimed that property here after stripping tags with a
  // regex, which only measured its own projection. This test owns the reader's
  // visible-text surface and nothing broader.
  for (const [what, body] of [
    ['math', '$$\nx^2\n$$\n'],
    ['a diagram', '```mermaid\ngraph TD\n  A --> B\n```\n'],
  ] as const) {
    const { html } = await renderMarkdown(body, { pageTitle: 'x' });
    assert.match(html, new RegExp(RENDERED_MARKER), `${what}: nothing was minted, so this measures nothing`);
    const visible = html.replace(/<[^>]+>/g, '');
    assert.ok(!visible.includes(RENDERED_MARKER), `${what}: the marker is visible to a reader: ${visible}`);
  }
});
