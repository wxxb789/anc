/**
 * Math and diagrams: the constructs TK-15 turned from downgrades into rendered
 * content.
 *
 * Three properties are load-bearing and each is checked here rather than
 * inferred from the code that produces it:
 *
 * 1. **What ships is what the CSP permits.** Build-time mode must produce no
 *    inline style, no `<style>` element, and no script; client mode needs a
 *    relaxed `style-src` and must say so in `public/_headers`.
 *    `tests/built-output.test.ts` owns the mode-aware `dist/` assertions; this
 *    file owns the renderer's own guarantees.
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
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'vitest';

import { renderMarkdown } from '../src/lib/markdown.ts';
import { renderMath, MathRejectedError, MATH_STYLE_CLASSES } from '../src/lib/math.ts';
import {
  renderDiagram,
  DiagramError,
  LAYOUT_CLASSES as DIAGRAM_LAYOUT_CLASSES,
  THEME_VARIABLES,
  UNPAIRED_DIAGRAMS,
} from '../src/lib/mermaid-render.ts';
import {
  DIAGRAM_MODE,
  REQUIRED_STYLE_SRC,
  STYLE_SRC_BY_MODE,
  CLIENT_MODE_BLOCKERS,
} from '../src/lib/diagram-mode.ts';
import { entries } from '../src/lib/content.ts';
import { scanResidue } from '../scripts/scan-residue.ts';

const ROOT = new URL('../', import.meta.url);
const DIST = new URL('dist/', ROOT);

/** Every diagram type the renderer claims to support, one minimal example each. */
const DIAGRAM_TYPES: Readonly<Record<string, string>> = {
  flowchart: 'graph TD\n  A[Vault] -->|allowlist| B[Exporter]\n  B --> C{Valid?}',
  sequence: 'sequenceDiagram\n  Reader->>Site: request\n  Site-->>Reader: html',
  class: 'classDiagram\n  class Artifact { +slug }\n  Artifact <|-- Note',
  state: 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> [*]',
  entityRelationship: 'erDiagram\n  NOTE ||--o{ EDGE : has',
  journey: 'journey\n  title Read\n  section Visit\n    Open: 5: Reader',
  gantt: 'gantt\n  title Wave\n  dateFormat YYYY-MM-DD\n  section Build\n  Render :a1, 2026-01-01, 5d',
  pie: 'pie title Sources\n  "Vault" : 45\n  "Manual" : 30',
  quadrant: 'quadrantChart\n  title Reach\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]',
  gitGraph: 'gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev',
  mindmap: 'mindmap\n  root((corpus))\n    notes\n    tags',
  timeline: 'timeline\n  title History\n  2024 : Start\n  2025 : Ship',
  sankey: 'sankey-beta\nA,B,10\nB,C,5',
  xyChart: 'xychart-beta\n  title "Load"\n  x-axis [a, b, c]\n  bar [1, 2, 3]',
  block: 'block-beta\n  columns 2\n  A B',
  packet: 'packet-beta\n0-7: "Head"\n8-15: "Body"',
  architecture: 'architecture-beta\n  group api(cloud)[API]\n  service db(database)[DB] in api',
  treemap: 'treemap-beta\n"Root"\n  "A": 10\n  "B": 20',
  radar: 'radar-beta\n  axis a["A"], b["B"], c["C"]\n  curve x["X"]{1, 2, 3}',
  kanban: 'kanban\n  Todo\n    task1[Write]',
  c4: 'C4Context\n  title Sys\n  Person(a, "Reader")\n  System(b, "Site")\n  Rel(a, b, "reads")',
  requirement:
    'requirementDiagram\n  requirement test_req {\n  id: 1\n  text: privacy\n  risk: high\n  verifymethod: test\n  }',
  info: 'info',
};

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
  const slugs = new Set<string>();
  for (const entry of entries) {
    const rendered = await renderMarkdown(entry.markdown, { pageTitle: entry.title });
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

test('every diagram type renders to CSP-clean SVG', async () => {
  for (const [name, source] of Object.entries(DIAGRAM_TYPES)) {
    const svg = await renderDiagram(source, `t-${name}`, `${name} diagram`);

    assert.match(svg, /^<svg\b/, `${name}: the result is not an SVG element`);
    assert.ok(svg.length > 100, `${name}: output is suspiciously short (${svg.length} bytes)`);
    // The DOMPurify interaction returns an empty string *successfully*, so an
    // adopting pipeline that does not assert here ships blank diagrams.
    //
    // These four are regression guards rather than the substance of the gate:
    // the pipeline removes every `<style>` and every `style=` unconditionally,
    // so they would also pass if the cascade resolver were deleted outright —
    // deletion is what makes them true. The gate that binds is the next test.
    assert.doesNotMatch(svg, /\sstyle="/, `${name}: an inline style survived, which style-src 'self' blocks`);
    assert.doesNotMatch(svg, /<style/i, `${name}: a <style> element survived`);
    assert.doesNotMatch(svg, /<script/i, `${name}: a script reached the output`);
    assert.doesNotMatch(svg, /\son[a-z]+="/i, `${name}: an inline handler reached the output`);
    // `info` is a version banner with no geometry and legitimately has none.
    if (name !== 'info') assert.match(svg, /viewBox="/, `${name}: no viewBox, so the diagram cannot scale`);
    assert.match(svg, /aria-label="/, `${name}: a diagram is content and needs an accessible name`);
  }
  // The most expensive gate in the tree: every diagram type, each rendered twice
  // to pair the palettes. Measured at 160 s under `pnpm run verify` against the
  // 90 s file default and 32 s alone — so it is not slow, it is *contended*, and
  // a default sized on an idle machine is the wrong instrument for it. Its own
  // budget rather than another rise in the global one, which would relax every
  // gate to accommodate this one.
}, 300_000);

test('flattening preserves the appearance the stylesheet described', async () => {
  // The assertion the CSP gate above cannot make. Deleting the stylesheet makes
  // a diagram CSP-clean *and* blank; what has to hold is that the declarations
  // survive as presentation attributes on the elements they selected.
  //
  // Each expectation below is a rule Mermaid's own stylesheet carries, and each
  // was verified against a real browser's computed style on the unflattened
  // SVG. Together they cover the three routes a declaration can take: a
  // descendant selector (`.node rect`), the root-targeting rule that
  // `querySelectorAll` alone would miss, and a rule whose winner is decided by
  // specificity against a competing one.
  const flowchart = await renderDiagram(DIAGRAM_TYPES['flowchart']!, 'flat-flow', 'Flowchart diagram');

  // `#id .node rect { fill; stroke; stroke-width }` — the shapes are painted.
  const nodeRect = /<rect[^>]*class="[^"]*label-container[^"]*"[^>]*>/.exec(flowchart)?.[0];
  assert.ok(nodeRect, 'the flowchart has no node rectangle to check');
  assert.match(nodeRect, /\sfill="light-dark\(/, 'the node fill was not flattened onto the element');
  assert.match(nodeRect, /\sstroke="light-dark\(/, 'the node stroke was not flattened onto the element');

  // `#id { fill }` targets the root, which `querySelectorAll` does not return.
  // Without it every SVG `<text>` inherits the initial black.
  assert.match(
    flowchart.slice(0, flowchart.indexOf('>')),
    /\sfill="light-dark\(/,
    "the root rule was dropped, so text falls back to the initial black",
  );

  // A sequence diagram's message lines carry 1.5, while a broader rule in the
  // same stylesheet sets 2px on `line`. Scoring a selector *list* as one string
  // let the broader rule win — the shape that made per-selector specificity
  // necessary.
  const sequence = await renderDiagram(DIAGRAM_TYPES['sequence']!, 'flat-seq', 'Sequence diagram');
  const messageLine = /<line[^>]*class="[^"]*messageLine0[^"]*"[^>]*>/.exec(sequence)?.[0];
  assert.ok(messageLine, 'the sequence diagram has no message line to check');
  assert.match(
    messageLine,
    /stroke-width="1\.5"/,
    'a less specific rule won: specificity is being scored over the whole selector list',
  );
});

test('a diagram follows the theme with no second file and no script', async () => {
  // The pairing: two renders, one per palette, collapsed into `light-dark()`
  // values on one SVG. Without it a build-time diagram is stuck in one theme.
  const svg = await renderDiagram(DIAGRAM_TYPES['flowchart']!, 'theme-probe', 'Flowchart diagram');
  const paired = svg.match(/light-dark\([^)]*\)/g) ?? [];
  assert.ok(paired.length > 0, 'no colour was paired, so the diagram cannot follow the theme');
  for (const value of paired) {
    assert.match(value, /^light-dark\(\s*[^,]+,\s*[^)]+\)$/, `malformed paired colour: ${value}`);
  }
});

test('a diagram is rendered against the article column, not an arbitrary viewport', async () => {
  // gantt and timeline take their total width from the container, so this is
  // their rendered size rather than an internal detail.
  const svg = await renderDiagram(DIAGRAM_TYPES['gantt']!, 'width-probe', 'Gantt diagram');
  const width = Number(/viewBox="[^"]*?\s([\d.]+)\s[\d.]+"/.exec(svg)?.[1]);
  assert.ok(Number.isFinite(width) && width > 0, 'the gantt chart has no measurable width');
  assert.ok(width <= 800, `a gantt chart ${width}px wide overflows the article column`);
});

test('CJK labels are measured, not collapsed', async () => {
  // The metric shim treats a full-width glyph as exactly 1 em, which is what
  // every CJK font does. A collapse would show as a box narrower than its text.
  const svg = await renderDiagram(
    'graph LR\n  甲[开始] --> 乙[这是一个相当长的中文节点标签]',
    'cjk-probe',
    'Flowchart diagram',
  );
  const width = Number(/viewBox="[^"]*?\s([\d.]+)\s[\d.]+"/.exec(svg)?.[1]);
  // 19 full-width glyphs at 16px is ~304px of text before padding and the
  // second node; anything near zero means the labels measured empty.
  assert.ok(width > 300, `CJK labels collapsed: the diagram is only ${width}px wide`);
});

test('a diagram that cannot be rendered fails the build', async () => {
  await assert.rejects(
    () => renderDiagram('graph TD\n  A --[[', 'bad-probe', 'Flowchart diagram'),
    (error: unknown) => error instanceof DiagramError,
  );
});

test('diagram rendering is deterministic within a process', async () => {
  // Two passes over the *whole* corpus, not two renders of each type back to
  // back. The difference is load-bearing: Mermaid's element counters and its
  // `Math.random`-seeded gitgraph hashes are process-wide, so a diagram's output
  // can depend on what was rendered before it. Rendering each type twice in
  // sequence puts the same state in front of both calls and hides exactly that.
  // Verified by mutation: removing the per-render PRNG reset leaves the paired
  // form green and fails this one.
  const first = new Map<string, string>();
  for (const [name, source] of Object.entries(DIAGRAM_TYPES)) {
    first.set(name, await renderDiagram(source, `d-${name}`, `${name} diagram`));
  }
  for (const [name, source] of Object.entries(DIAGRAM_TYPES)) {
    const second = await renderDiagram(source, `d-${name}`, `${name} diagram`);
    assert.equal(second, first.get(name), `${name}: the second pass produced different bytes`);
  }
});

test('diagram rendering is deterministic across processes', () => {
  // The stronger property, and the one that matters for a content hash: a fresh
  // process must produce the same bytes. Mermaid's module-level counters and its
  // `Math.random`-seeded commit hashes both make this false without the seeding
  // and id renumbering the renderer does.
  const script = fileURLToPath(new URL('tests/support/render-diagram.ts', ROOT));
  const source = DIAGRAM_TYPES['gitGraph']!;
  const run = (): string =>
    execFileSync(process.execPath, [script, source], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run(), run(), 'two processes rendered the same diagram differently');
});

test('concurrent renders do not contaminate each other', async () => {
  // Mermaid is a process-wide singleton in three ways — global config, module
  // counters, and the seeded PRNG — and Astro renders pages concurrently. Two
  // renders of one source interleaved with a third must still agree.
  const source = DIAGRAM_TYPES['flowchart']!;
  const [a, b, c] = await Promise.all([
    renderDiagram(source, 'race-a', 'Flowchart diagram'),
    renderDiagram(DIAGRAM_TYPES['pie']!, 'race-b', 'Pie diagram'),
    renderDiagram(source, 'race-a', 'Flowchart diagram'),
  ]);
  assert.equal(c, a, 'an interleaved render changed the output');
  assert.ok(b!.length > 0);
});

// --- The pipeline ------------------------------------------------------------

test('a diagram figure carries a caption that names it', async () => {
  const declared = await renderMarkdown('```mermaid\npie title Publication Sources\n  "Vault" : 45\n```\n');
  assert.match(declared.html, /<figcaption>Publication Sources<\/figcaption>/);
  // The caption is the figure's visible name in both modes. In build-time mode
  // the SVG carries it as `aria-label` too, so a screen reader meeting the
  // graphics role hears the same words; in client mode `src/scripts/diagram.ts`
  // copies the caption onto the SVG it injects, which cannot be asserted here
  // because no SVG exists until the runtime makes one.
  if (DIAGRAM_MODE === 'build-time') {
    assert.match(declared.html, /aria-label="Publication Sources"/);
  }

  // With no declared title the diagram's kind is the honest fallback: it says
  // what the reader is looking at without inventing a description.
  const undeclared = await renderMarkdown('```mermaid\nsequenceDiagram\n  A->>B: x\n```\n');
  assert.match(undeclared.html, /<figcaption>Sequence diagram<\/figcaption>/);
});

test('two diagrams on one page do not collide on element ids', async (t: TestContext) => {
  if (DIAGRAM_MODE !== 'build-time') {
    return t.skip('client mode mints ids in the browser, where this file cannot see them');
  }
  // Mermaid's ids are unique within one diagram only. Two on a page would both
  // define `#arrowhead`, and the second definition wins for both — silently, in
  // both diagrams, with no error anywhere.
  //
  // **Two independent mechanisms hold this and either alone is sufficient**:
  // the per-diagram `render()` id, which Mermaid prefixes onto every id it
  // mints, and `renumberIds`, which rewrites them afterwards. Mutation testing
  // confirmed that breaking *either* leaves this gate green and breaking *both*
  // produces five duplicate ids — so this gate proves the property, not any one
  // implementation of it. That is the right shape here: the property is what
  // matters, and a gate pinned to one mechanism would fail on a refactor that
  // kept the guarantee.
  const rendered = await renderMarkdown(
    '```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\ngraph TD\n  C --> D\n```\n',
  );
  const ids = [...rendered.html.matchAll(/\sid="([^"]*)"/g)].map(([, id]) => id!);
  assert.ok(ids.length > 20, `only ${ids.length} ids, too few for this gate to mean anything`);
  assert.equal(new Set(ids).size, ids.length, 'two diagrams on one page share an element id');

  // Every internal reference resolves. A unique-id check alone would pass a
  // renumbering that renamed the definitions and left `url(#…)` pointing at the
  // old names — which renders as a diagram with no arrowheads.
  const references = [...rendered.html.matchAll(/url\(#([^)]*)\)/g)].map(([, id]) => id!);
  assert.ok(references.length > 0, 'no internal references, so this half checks nothing');
  const defined = new Set(ids);
  for (const reference of references) {
    assert.ok(defined.has(reference), `url(#${reference}) points at no element on the page`);
  }
});

test('a page rendering both constructs reports both and neither leaks a placeholder', async () => {
  const rendered = await renderMarkdown('$$\na+b\n$$\n\n```mermaid\ngraph TD\n  A --> B\n```\n');
  assert.equal(rendered.hasMath, true);
  assert.equal(rendered.hasMermaid, true);
  assert.doesNotMatch(rendered.html, /thoughtscape\w*Placeholder/, 'a substitution marker reached the page');
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
    'thoughtscapeMathPlaceholder0End\n\n$$\na\n$$\n',
    'thoughtscapeDiagramPlaceholder0End\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
    '```js\nthoughtscapeMathPlaceholder0End\n```\n\n$$\na\n$$\n',
    '`thoughtscapeMathPlaceholder0End`\n\n$$\na\n$$\n',
    '<div>thoughtscapeMathPlaceholder0End</div>\n\n$$\na\n$$\n',
    '<a href="/x/" title="thoughtscapeMathPlaceholder0End">y</a>\n\n$$\na\n$$\n',
    '![thoughtscapeMathPlaceholder0End](https://example.com/a.png)\n\n$$\na\n$$\n',
    // A marker this render never minted: a different index, and the diagram
    // form on a page that has only math. Neither collides with a real token, so
    // without the residue check they would ship as visible gibberish.
    'thoughtscapeMathPlaceholder0End\n',
    'thoughtscapeMathPlaceholder99End\n\n$$\na\n$$\n',
    'thoughtscapeDiagramPlaceholder0End\n\n$$\na\n$$\n',
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
  // label is the other half of the seam. Every case below either renders inert
  // or fails the build; none may produce a script, a handler, or a live URL.
  //
  // In client mode the diagram is not rendered at build time at all — its
  // source ships escaped inside a `<pre>`, so the assertions are made against
  // that escaped text. `\s` before the handler pattern is what distinguishes
  // `onerror=` as an attribute from `onerror=` as escaped source: the escaped
  // form is preceded by `&quot;` or a letter, never by whitespace inside a tag.
  const hostile = [
    '$$\n\\text{</math><script>alert(1)</script>}\n$$\n',
    '```mermaid\ngraph TD\n  A["</svg><script>alert(1)</script>"] --> B\n```\n',
    '```mermaid\ngraph TD\n  A["<img src=x onerror=alert(1)>"] --> B\n```\n',
    '```mermaid\ngraph TD\n  A --> B\n  click A callback\n```\n',
  ];
  for (const markdown of hostile) {
    let html: string;
    try {
      ({ html } = await renderMarkdown(markdown));
    } catch {
      // Failing the build is the other acceptable outcome, and is what a
      // `click` directive naming an external URL does in build-time mode.
      continue;
    }
    assert.doesNotMatch(html, /<script/i, `a script survived: ${markdown.slice(0, 50)}`);
    assert.doesNotMatch(html, /<style/i, `a style element survived: ${markdown.slice(0, 50)}`);
    assert.doesNotMatch(html, /\sstyle="/, `an inline style survived: ${markdown.slice(0, 50)}`);
    // Only real attributes count. Escaped source text is inert by construction
    // and is what client mode deliberately ships.
    for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, `a handler attribute survived: ${tag.slice(0, 80)}`);
      assert.doesNotMatch(tag, /="javascript:/i, `a javascript: URL survived: ${tag.slice(0, 80)}`);
    }
  }
});

test('a diagram cannot emit a link the projection never approved', async (t: TestContext) => {
  // Mermaid's `click` directive turns a node into an anchor pointing anywhere
  // the author wrote, including a `javascript:` URL — and the SVG never passes
  // through the href allowlist that governs prose links.
  //
  // The two modes answer this differently, and both are checked. Build-time
  // rejects every external reference and fails the build, because nothing is in
  // front of a reader yet. Client mode cannot fail a build that already
  // shipped, so `src/scripts/diagram.ts` strips the same attributes in the page
  // — asserted there by reading the script, since the stripping happens in a
  // browser this file does not run.
  const sources = [
    '```mermaid\ngraph TD\n  A --> B\n  click A "https://evil.example" _blank\n```\n',
    '```mermaid\ngraph TD\n  A --> B\n  click A href "javascript:alert(1)"\n```\n',
  ];

  if (DIAGRAM_MODE === 'build-time') {
    for (const source of sources) {
      await assert.rejects(() => renderMarkdown(source), /external reference/i);
    }
    return;
  }

  for (const source of sources) {
    const { html } = await renderMarkdown(source);
    for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      assert.doesNotMatch(tag, /="javascript:/i, `a javascript: URL reached the markup: ${tag}`);
    }
  }
  const runtime = readFileSync(new URL('src/scripts/diagram.ts', ROOT), 'utf8');
  assert.match(runtime, /URL_ATTRIBUTES/, 'the client runtime does not enforce the URL rule at all');
  assert.match(
    runtime,
    /removeAttribute\(attribute\)/,
    'the client runtime does not strip a disallowed URL from the rendered diagram',
  );
  void t;
});

// --- What reaches a page -----------------------------------------------------

test('the deployed CSP matches the diagram mode', () => {
  const headers = readFileSync(new URL('public/_headers', ROOT), 'utf8');
  const styleSrc = /(?:^|;)\s*style-src\s+([^;]+)/.exec(headers)?.[1]?.trim();
  assert.equal(styleSrc, REQUIRED_STYLE_SRC, `style-src must match DIAGRAM_MODE "${DIAGRAM_MODE}"`);
  assert.notEqual(
    STYLE_SRC_BY_MODE['build-time'],
    STYLE_SRC_BY_MODE.client,
    'the modes declare the same policy, so this gate cannot detect a mismatch',
  );
});

test('what still blocks client mode is recorded and still true', () => {
  // Client mode renders correctly — verified in a real browser, both themes,
  // zero CSP violations — but two gates outside this ticket's fence forbid the
  // configuration it needs, so selecting it fails the build. `diagram-mode.ts`
  // records both. This asserts the record is accurate rather than aspirational:
  // a blocker that quietly gets fixed should stop being listed, and one that is
  // listed should be real.
  assert.ok(CLIENT_MODE_BLOCKERS.length > 0, 'the record claims client mode is shippable');

  // Blocker 1: the deployment gate pins the build-time policy.
  const deployment = readFileSync(new URL('tests/deployment.test.ts', ROOT), 'utf8');
  assert.match(
    deployment,
    /\['style-src', "'self'"\]/,
    'deployment.test.ts no longer hardcodes style-src — the first blocker is stale',
  );
  assert.match(
    deployment,
    /"'unsafe-inline'"/,
    'deployment.test.ts no longer forbids unsafe-inline — the first blocker is stale',
  );

  // Blocker 2: the residue scan has no vendored-runtime exemption that covers
  // Mermaid, so its chunks trip it.
  //
  // Run against a real chunk rather than grepped for the vendor's name. The
  // likely shape of the real fix is a *generic* exemption — the mechanism is
  // already there as `THIRD_PARTY`, and the comment beside it frames it as
  // something Pagefind is granted rather than something named per vendor — so a
  // name search would miss it and leave this blocker listed after it was gone.
  //
  // The finding is matched by *rule* rather than counted. `scanResidue` reports
  // its own vacuity ("no scannable file was found") as a finding, so a
  // non-empty result is not evidence the chunk was rejected: an exemption that
  // skipped the file entirely would produce exactly one finding and pass a
  // count check. Asserting the wikilink rule fired is what distinguishes
  // "rejected the chunk" from "never read it".
  const chunk = new URL('.tmp/blocker-probe/', ROOT);
  mkdirSync(chunk, { recursive: true });
  writeFileSync(
    new URL('parser.js', chunk),
    // The exact shape Mermaid's parser chunks carry: `[[` opening a nested
    // array literal, which the scan reads as an unresolved wikilink.
    'const points=[[1,2],[3,4]];export default points;\n',
    'utf8',
  );
  try {
    const { findings, scannedCount } = scanResidue(fileURLToPath(chunk));
    assert.equal(scannedCount, 1, 'the probe chunk was not scanned, so this proves nothing either way');
    assert.ok(
      findings.some((finding) => finding.includes('[[wikilink]]')),
      'the residue scan now accepts a vendored runtime chunk — the second blocker is stale',
    );
  } finally {
    rmSync(chunk, { recursive: true, force: true });
  }
});

test('build-time mode ships no diagram runtime at all', (t: TestContext) => {
  if (DIAGRAM_MODE !== 'build-time') return t.skip('client mode ships the runtime by design');
  // The mode's headline property: 0 B of JavaScript for a diagram. Measured over
  // `dist/` because the failure — Mermaid's chunks emitted but referenced by
  // nothing — is invisible in the rendered page and was a real defect during
  // this ticket, caught only by the residue scan.
  const scripts = walk(DIST, '.js').filter((file) => !file.includes('pagefind'));
  for (const file of scripts) {
    assert.ok(
      !/mermaid|cytoscape|dagre|katex/i.test(file),
      `${file}: a diagram runtime chunk shipped in build-time mode`,
    );
  }
  const bytes = scripts.reduce((total, file) => total + statSync(file).size, 0);
  assert.ok(bytes < 100 * 1024, `client JavaScript totals ${bytes} B, far above what this site ships`);
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
      // and which matters more: in client mode the diagram runtime is the 201 KB
      // floor, so a page without a diagram requesting it is the expensive
      // failure. Checked mode-independently — build-time mode must request no
      // diagram script anywhere, and client mode must request one only where a
      // diagram exists.
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

test('the built diagram markup is CSP-clean in build-time mode', async (t: TestContext) => {
  if (DIAGRAM_MODE !== 'build-time') return t.skip('client mode writes inline styles by design');
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

test('the diagram palette is the site palette', () => {
  // `THEME_VARIABLES` duplicates 22 hex literals from `tokens.css`, and it has
  // to: Mermaid runs every theme value through `khroma`, which parses colours
  // to compute derived shades and throws `Unsupported color format` on
  // `var(--color-bg)`. A duplicate with no gate silently desynchronises the
  // diagrams from the site the first time a token changes, and the symptom —
  // a diagram in nearly-but-not-quite the right colour — is one nobody reports.
  const tokens = readFileSync(new URL('src/styles/tokens.css', ROOT), 'utf8');

  /** The light and dark halves of a `light-dark()` token declaration. */
  const pair = (name: string): { light: string; dark: string } => {
    const declaration = new RegExp(`--${name}:\\s*light-dark\\(([^,]+),\\s*([^)]+)\\)`).exec(tokens);
    assert.ok(declaration, `tokens.css declares no light-dark() value for --${name}`);
    return { light: declaration[1]!.trim(), dark: declaration[2]!.trim() };
  };

  // Each Mermaid theme key, and the token it must mirror.
  const MIRRORS: Readonly<Record<string, string>> = {
    background: 'color-bg',
    primaryColor: 'color-surface-alt',
    primaryTextColor: 'color-text',
    primaryBorderColor: 'color-line-strong',
    lineColor: 'color-line-strong',
    secondaryColor: 'color-surface',
    tertiaryColor: 'color-surface',
    textColor: 'color-text',
    mainBkg: 'color-surface-alt',
    nodeBorder: 'color-line-strong',
    nodeTextColor: 'color-text',
  };

  for (const [key, token] of Object.entries(MIRRORS)) {
    const expected = pair(token);
    for (const theme of ['light', 'dark'] as const) {
      assert.equal(
        THEME_VARIABLES[theme][key as keyof (typeof THEME_VARIABLES)['light']].toLowerCase(),
        expected[theme].toLowerCase(),
        `THEME_VARIABLES.${theme}.${key} has drifted from --${token}`,
      );
    }
  }

  // Every key is mirrored: a new theme variable with no token behind it is a
  // colour chosen here rather than in the design system.
  assert.deepEqual(
    Object.keys(THEME_VARIABLES.light).sort(),
    Object.keys(MIRRORS).sort(),
    'a theme variable has no token it mirrors',
  );
});

test('a diagram that cannot be theme-paired is a known one', async () => {
  // Pairing needs the light and dark renders to be structurally identical. When
  // they are not, the diagram ships in the light palette in both themes — which
  // looks exactly like a correct diagram until a reader opens it in dark mode.
  // An `accTitle` used to cause it, silently, for every diagram that had one.
  //
  // The set is asserted empty rather than allowed to hold known exceptions: on
  // this corpus every type pairs, so anything appearing is a regression.
  UNPAIRED_DIAGRAMS.clear();
  for (const [name, source] of Object.entries(DIAGRAM_TYPES)) {
    await renderDiagram(source, `pair-${name}`, `${name} diagram`);
  }
  // A declared accessible title is the shape that broke it, so it is checked by
  // name rather than left to the type list.
  await renderDiagram(
    'graph TD\n  accTitle: Publication pipeline\n  A[Vault] --> B[Exporter]',
    'pair-acctitle',
    'Flowchart diagram',
  );
  assert.deepEqual([...UNPAIRED_DIAGRAMS], [], 'these diagrams ship stuck in the light palette');
});

test('a diagram with a declared accessible title keeps a resolvable name', async () => {
  // Mermaid points `aria-labelledby` at a `<title>` it mints, using a bare
  // IDREF rather than a `#fragment`. Renumbering the ids without rewriting that
  // reference leaves the accessible name pointing at nothing — an axe failure,
  // and a silent one, because the `aria-label` set alongside it still reads.
  for (const [source, attribute] of [
    ['graph TD\n  accTitle: Publication pipeline\n  A --> B', 'aria-labelledby'],
    ['graph TD\n  accDescr: How the pipeline flows\n  A --> B', 'aria-describedby'],
  ] as const) {
    const svg = await renderDiagram(source, `a11y-${attribute}`, 'Flowchart diagram');
    const reference = new RegExp(`${attribute}="([^"]*)"`).exec(svg)?.[1];
    assert.ok(reference, `the diagram declares one but emitted no ${attribute}`);
    const ids = new Set([...svg.matchAll(/\sid="([^"]*)"/g)].map(([, id]) => id!));
    for (const token of reference.split(/\s+/).filter(Boolean)) {
      assert.ok(ids.has(token), `${attribute}="${reference}" points at no element in the diagram`);
    }
  }
});

test('the diagram stylesheet pins the size the renderer measured at', () => {
  // The geometry of a build-time diagram is baked into the SVG, computed from
  // Mermaid's own measurement of the label text at 16 px. This site's body text
  // is `--text-base`, 17 px, and HTML labels inherit it — so without a pin every
  // multi-word label rendered ~6% wider than the box built for it and was
  // visibly clipped ("Private vault" showed as "Private vaul"). Measured in
  // Chromium, and the reason this is a gate rather than a comment: the coupling
  // is invisible in both files on their own.
  const stylesheet = readFileSync(new URL('src/styles/diagram.css', ROOT), 'utf8');
  assert.match(
    stylesheet,
    /\.diagram foreignObject[^{]*\{[^}]*font-size:\s*16px/,
    'diagram.css must pin the label font size to the 16px the renderer measured at',
  );
  // In `px`, not `rem`: a reader who scales the root font size scales the whole
  // SVG, which keeps each label inside its box. Scaling only the text would
  // reintroduce exactly the clipping this pin removes.
  assert.doesNotMatch(
    stylesheet,
    /\.diagram[^{]*\{[^}]*font-size:\s*[\d.]+rem/,
    'a rem font size re-couples the label to the root size and reintroduces clipping',
  );
  // Scoped to `foreignObject` content. An SVG `<text>` carries its own
  // `font-size` presentation attribute — 12 px on a radar axis label, 38 px on a
  // treemap label — and a class rule beats an attribute, so including `text`
  // here silently resized 139 elements across seven diagram types.
  assert.doesNotMatch(
    stylesheet,
    /\.diagram text[^{]*\{[^}]*font-size/,
    'pinning SVG text overrides the per-element sizes the flattening pass wrote',
  );
});

test('every class the flattening pass can write has a rule', () => {
  // `LAYOUT_CLASSES` is the closed set of non-presentational declarations the
  // pass converts to classes. A class with no rule is a silently dropped
  // declaration — which is how the journey diagram lost its `display: table`
  // and rendered its sections as blocks.
  const stylesheet = readFileSync(new URL('src/styles/diagram.css', ROOT), 'utf8');
  const names = new Set(Object.values(DIAGRAM_LAYOUT_CLASSES));
  assert.ok(names.size > 0, 'the pass declares no classes, so this gate checks nothing');
  for (const name of names) {
    assert.match(
      stylesheet,
      new RegExp(`\\.${name}(?![\\w-])`),
      `diagram.css has no rule for "${name}", which the flattening pass writes onto elements`,
    );
  }
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
      assert.ok(gzip < 12 * 1024, `${file}: one diagram costs ${gzip} B gzip, far above the ~2 KB measured`);
    }
  }

  const stylesheets = walk(DIST, '.css').filter((file) => /math|diagram/.test(file));
  for (const file of stylesheets) {
    const gzip = gzipSync(readFileSync(file)).length;
    assert.ok(gzip < 6 * 1024, `${file}: ${gzip} B gzip, above what a per-page sheet should cost`);
  }
});
