import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseCss } from 'css-tree';
import { SaxesParser } from 'saxes';
import { afterEach, test, vi } from 'vitest';
import type * as DiagramConfiguration from '../src/lib/diagram-mode.ts';
import type * as MermaidAdapter from '../src/lib/mermaid-render.ts';
import type * as PeleAdapter from '../src/lib/pele-render.ts';
import type * as Pele from 'pele';

const selection = vi.hoisted(() => ({ engine: 'mermaid' as unknown }));
vi.mock('../src/lib/diagram-mode.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof DiagramConfiguration>();
  return { ...actual, DIAGRAM_MODE: 'build-time', get DIAGRAM_ENGINE() { return selection.engine; } };
});
vi.mock('pele', async (importOriginal) => {
  const actual = await importOriginal<typeof Pele>();
  return { ...actual, render: vi.fn<typeof Pele.render>(actual.render) };
});

import { render as renderPele } from 'pele';
import { DiagramError } from '../src/lib/mermaid-render.ts';
import { renderMarkdown } from '../src/lib/markdown.ts';

// Deferred imports intentionally exercise the adapter and dispatcher loading boundaries.

const DIAGRAMS: Readonly<Record<string, string>> = {
  flowchart: 'graph TD\n  A[Reader] --> B[Site]',
  sequence: 'sequenceDiagram\n  Reader->>Site: request\n  Site-->>Reader: html',
  class: 'classDiagram\n  class Artifact { +slug }\n  Artifact <|-- Note',
  state: 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> [*]',
  entityRelationship: 'erDiagram\n  NOTE ||--o{ EDGE : has',
  journey: 'journey\n  title Read\n  section Visit\n    Open: 5: Reader',
  gantt: 'gantt\n  title Wave\n  dateFormat YYYY-MM-DD\n  section Build\n  Render :a1, 2026-01-01, 5d',
  pie: 'pie title Sources\n  "Notes" : 45\n  "Manual" : 30',
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
  requirement: 'requirementDiagram\n  requirement test_req {\n  id: 1\n  text: privacy\n  risk: high\n  verifymethod: test\n  }',
  info: 'info',
};

function inspect(svg: string) {
  const elements: { name: string; attributes: Record<string, string> }[] = [];
  let text = '';
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    elements.push({
      name: tag.local,
      attributes: Object.fromEntries(Object.values(tag.attributes).map(({ name, value }) => [name, value])),
    });
  });
  parser.on('text', (value) => { text += value; });
  parser.write(svg).close();
  assert.equal(elements[0]?.name, 'svg');
  return { elements, root: elements[0]!.attributes, text };
}

function assertClean(svg: string): void {
  const { elements } = inspect(svg);
  for (const { name, attributes } of elements) {
    assert.ok(!['style', 'script', 'foreignObject', 'a', 'image'].includes(name), `unsafe element: ${name}`);
    for (const attribute of Object.keys(attributes)) {
      assert.doesNotMatch(attribute, /^(?:style|on.*|(?:xlink:)?href|src)$/i);
    }
  }
  assert.doesNotMatch(svg, /<style\b|\sstyle\s*=|<script\b/i);
}

afterEach(() => {
  selection.engine = 'mermaid';
  vi.mocked(renderPele).mockReset();
});

test.each(Object.entries(DIAGRAMS))('Pele preserves %s geometry and accessible content without inline execution', async (_name, source) => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const id = 'geometry-probe';
  const name = 'Reader’s diagram <with markup> & "quotes"';
  const original = inspect(renderPele(source, { idPrefix: id, links: false, images: false }).svg);
  const svg = await renderDiagram(source, id, name);
  const result = inspect(svg);

  assertClean(svg);
  for (const attribute of ['width', 'height', 'viewBox']) {
    assert.ok(original.root[attribute], `the renderer supplied no ${attribute}`);
    assert.equal(result.root[attribute], original.root[attribute]);
  }
  assert.equal(result.root['role'], 'graphics-document');
  assert.equal(result.root['aria-label'], name);
  assert.equal(result.root['focusable'], 'false');
  assert.equal(result.text, original.text, 'sanitization lost visible labels or descriptions');
});

test('the Markdown build-time seam renders with either selected engine', async () => {
  const source = '```mermaid\nflowchart TD\n A[Consumer start] --> B[Consumer end]\n```\n';
  selection.engine = 'mermaid';
  const original = await renderMarkdown(source);
  selection.engine = 'pele';
  const replacement = await renderMarkdown(source);
  for (const html of [original.html, replacement.html]) {
    const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
    assert.ok(svg, 'the selected engine never reached Markdown’s post-sanitization insertion');
    const document = inspect(svg);
    assert.match(document.text, /Consumer start/);
    assert.match(document.text, /Consumer end/);
    assert.ok(document.root['aria-label']);
    assert.doesNotMatch(svg, /<style\b|\sstyle\s*=|<script\b/i);
  }
  assert.match(replacement.html, /class="pele pele-flowchart"/);
  assert.doesNotMatch(original.html, /class="pele /);
});

test('an unknown engine fails instead of silently choosing a renderer', async () => {
  selection.engine = 'unknown-engine';
  const { renderDiagram } = await import('../src/lib/diagram-engine.ts');
  await assert.rejects(() => renderDiagram(DIAGRAMS['flowchart']!, 'unknown', 'Unknown engine'));
});

test('Pele namespaces gradients and accessible titles without render-order state', async () => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const source = DIAGRAMS['sankey']!;
  const first = await renderDiagram(source, 'first', 'First');
  const second = await renderDiagram(source, 'second', 'Second');
  assert.equal(await renderDiagram(source, 'first', 'First'), first);
  const firstIds = new Set(inspect(first).elements.flatMap(({ attributes }) => attributes['id'] ?? []));
  const secondIds = new Set(inspect(second).elements.flatMap(({ attributes }) => attributes['id'] ?? []));
  for (const [svg, prefix, ids] of [[first, 'first-', firstIds], [second, 'second-', secondIds]] as const) {
    const references = [...svg.matchAll(/url\(#([^)]*)\)/g)].map((match) => match[1]!);
    assert.ok(references.length > 0, 'the fixture no longer exercises gradient references');
    for (const id of ids) assert.ok(id.startsWith(prefix), `unnamespaced id: ${id}`);
    for (const reference of references) assert.ok(ids.has(reference), `broken fragment: ${reference}`);
  }
  for (const id of firstIds) assert.ok(!secondIds.has(id), `two diagrams share ${id}`);

  const titled = inspect(await renderDiagram('flowchart TD\n accTitle: Authored title\n A --> B', 'titled', 'Caption name'));
  assert.equal(titled.root['aria-label'], 'Caption name');
  assert.equal(titled.root['aria-labelledby'], undefined, 'the requested accessible name replaces pele’s authored-title reference');
  assert.match(titled.text, /Authored title/);
});

test('Pele is byte-deterministic across fresh Node processes', () => {
  // The child script is inlined rather than taken from `tests/support/render-diagram.ts`
  // because a fresh child cannot see this file's `vi.mock` of `diagram-mode.ts` and there
  // is no runtime override, so the harness would render the configured `mermaid` engine.
  const adapter = new URL('../src/lib/pele-render.ts', import.meta.url).href;
  const source = DIAGRAMS['sankey']!;
  const script = `import { createHash } from 'node:crypto';
    import { renderDiagram } from ${JSON.stringify(adapter)};
    const svg = await renderDiagram(${JSON.stringify(source)}, 'fresh-process', 'Process diagram');
    process.stdout.write(createHash('sha256').update(svg).digest('hex'));`;
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 30_000,
  });
  const first = run();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(run(), first);
}, 75_000);

test.each(['flowchart TD\n A -->', 'sequenceDiagram\n ????', 'notadiagram\n A --> B'])(
  'Pele fails malformed source with the existing DiagramError: %s', async (source) => {
    const { renderDiagram } = await import('../src/lib/pele-render.ts');
    await assert.rejects(() => renderDiagram(source, 'malformed', 'Malformed'), (error: unknown) =>
      error instanceof DiagramError && error.source === source);
  },
);

const AUTHORED_SIZE = 'flowchart TD\n A[Reader] --> B[Site]\n style A font-size:40px';
const AUTHORED_PAINT = 'flowchart TD\n A[Reader] --> B[Site]\n style A fill:#ff0000,stroke:#00ff00,'
  + 'stroke-width:3px,font-weight:600,font-style:italic,font-family:Georgia,letter-spacing:2px,opacity:0.5';
const CRIT_GANTT = 'gantt\n  dateFormat YYYY-MM-DD\n  section Build\n  Render :crit, a1, 2026-01-01, 5d';

/**
 * Every source the census rows below read: the 23-type matrix, the three real
 * corpus diagrams (read from the files that ship them, not copied here), and the
 * probes that make an authored declaration or a critical task observable.
 */
function censusSources(): string[] {
  const corpus = [
    'docs/core-design/architecture.md',
    'example/guides/feature-showcase.md',
    'tests/fixtures/markdown/kitchen-sink.md',
  ];
  const sources = corpus.flatMap((path) =>
    [...readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').matchAll(/```mermaid\n([\s\S]*?)```/g)]
      .map((match) => match[1]!));
  assert.equal(sources.length, 3, 'the real corpus no longer carries the three diagrams this census reads');
  return [
    ...Object.values(DIAGRAMS), ...sources, AUTHORED_SIZE, AUTHORED_PAINT, CRIT_GANTT,
    'flowchart TD\n A[Reader] --> B[Site]\n style A fill:#111111',
    'flowchart TD\n A[Reader] --> B[Site]\n style A rx:8px',
  ];
}

const DIAGRAM_CSS = readFileSync(new URL('../src/styles/diagram.css', import.meta.url), 'utf8');

/** The body of one rule in `diagram.css`, so a declaration is cited where it lives. */
function ruleBody(selector: string): string {
  const start = DIAGRAM_CSS.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `diagram.css no longer declares \`${selector}\``);
  const end = DIAGRAM_CSS.indexOf('\n}', start);
  assert.notEqual(end, -1, `\`${selector}\` has no closing brace`);
  return DIAGRAM_CSS.slice(start, end);
}

/**
 * Pele's root `style` block, declaration by declaration, and the `diagram.css`
 * rule that supplies the same value.
 *
 * The block cannot ship — `style-src 'self'` is the build-time policy, and a
 * `style=` attribute is not a hashable thing — so the sanitizer drops it whole.
 * That is only safe while every declaration in it has a named counterpart, which
 * is what this table asserts and why the adapter refuses an unlisted property
 * instead of dropping it. `font-family` has no declaration of its own: the
 * `font` shorthand supplies it, which is the one place the CSS states the family
 * once rather than twice.
 */
const ROOT_DECLARATIONS: Readonly<Record<string, readonly [rule: string, css: string]>> = {
  'max-width': ['.diagram svg', 'max-width: 100%;'],
  height: ['.diagram svg', 'height: auto;'],
  font: ['.diagram svg.pele', 'font: 16px var(--pele-font);'],
  'font-family': ['.diagram svg.pele', 'font: 16px var(--pele-font);'],
  color: ['.diagram svg.pele', 'color: var(--_fg);'],
  'letter-spacing': ['.diagram svg.pele', 'letter-spacing: normal;'],
  'word-spacing': ['.diagram svg.pele', 'word-spacing: normal;'],
  'text-transform': ['.diagram svg.pele', 'text-transform: none;'],
  direction: ['.diagram svg.pele', 'direction: ltr;'],
  '--_bg': ['.diagram svg.pele', '--_bg: var(--pele-bg);'],
  '--_fg': ['.diagram svg.pele', '--_fg: var(--pele-fg);'],
  '--_m': ['.diagram svg.pele', '--_m: var(--pele-muted);'],
  '--_l': ['.diagram svg.pele', '--_l: var(--pele-line);'],
  '--_s': ['.diagram svg.pele', '--_s: var(--pele-surface);'],
  '--_a': ['.diagram svg.pele', '--_a: var(--pele-surface-alt);'],
  '--_b': ['.diagram svg.pele', '--_b: var(--pele-border);'],
  '--_c': ['.diagram svg.pele', '--_c: var(--pele-accent);'],
  '--_r': ['.diagram svg.pele', '--_r: var(--pele-radius);'],
  '--_fm': ['.diagram svg.pele', '--_fm: var(--pele-font-mono);'],
  '--_tw': ['.diagram svg.pele', '--_tw: var(--pele-title-weight, bold);'],
  '--_hw': ['.diagram svg.pele', '--_hw: var(--pele-heading-weight, bold);'],
  '--_w': ['.diagram svg.pele', '--_w: var(--pele-bold-weight, bold);'],
};

test('diagram.css supplies every declaration of Pele’s root style block', async () => {
  const observed = new Set<string>();
  for (const source of censusSources()) {
    const { svg } = renderPele(source, { idPrefix: 'census', links: false, images: false });
    const parser = new SaxesParser({ xmlns: true });
    let isRoot = true;
    parser.on('opentag', (tag) => {
      if (!isRoot) return;
      isRoot = false;
      const style = tag.attributes['style']?.value;
      assert.ok(style, 'the root no longer carries the style block this row accounts for');
      for (const node of parseCss(style, { context: 'declarationList' }).children?.toArray() ?? []) {
        const property = node['property'];
        if (node.type === 'Declaration' && typeof property === 'string') observed.add(property.toLowerCase());
      }
    });
    parser.write(svg).close();
  }
  assert.deepEqual([...observed].sort(), Object.keys(ROOT_DECLARATIONS).sort(),
    'the root block Pele emits and the declarations diagram.css supplies have drifted apart');
  const bodies = new Map<string, string>();
  for (const [rule] of Object.values(ROOT_DECLARATIONS)) {
    if (!bodies.has(rule)) bodies.set(rule, ruleBody(rule));
  }
  for (const [property, [rule, css]] of Object.entries(ROOT_DECLARATIONS)) {
    assert.ok(bodies.get(rule)!.includes(css), `${property} is dropped, but ${rule} does not supply \`${css}\``);
  }
});

/**
 * Names the variable block deliberately leaves to Pele's own value, with the
 * default the markup carries and the alias that reproduces it.
 *
 * The first three are the site's opt-in weights: `--_tw` and friends hold
 * `var(--pele-x, bold)`, so a site that wants different weights sets the public
 * variable and the alias inherits it, and one that does not gets Pele's `bold`.
 * Defining them in `diagram.css` would win over the reader's own `:root` value
 * and take that choice away. `css: null` is the honest form of the remaining
 * two: Pele chooses `--pele-fg-on-light`/`on-dark` from the fill it was handed,
 * as an absolute colour, and this palette is themed — there is no token here
 * that means "ink for a known-light fill", so the gap is recorded rather than
 * filled with a token that means something else.
 */
const FALLBACK_ONLY: Readonly<Record<string, { fallback: string; css: string | null }>> = {
  '--pele-title-weight': { fallback: 'bold', css: 'var(--pele-title-weight, bold)' },
  '--pele-heading-weight': { fallback: 'bold', css: 'var(--pele-heading-weight, bold)' },
  '--pele-bold-weight': { fallback: 'bold', css: 'var(--pele-bold-weight, bold)' },
  '--pele-fg-on-light': { fallback: '#1f1f1f', css: null },
  '--pele-fg-on-dark': { fallback: '#fff', css: null },
};

/**
 * The generalisation of `--pele-critical`: a public variable the emitted markup
 * consumes and `diagram.css` never defines renders Pele's own palette, and that
 * was invisible until a Gantt critical task painted `#e45756` on a themed page.
 * Consumed is measured over the raw render, so a variable only ever used inside
 * the dropped root block still counts.
 */
test('every Pele variable the emitted markup consumes is defined or deliberately defaulted', async () => {
  const block = ruleBody('.diagram svg.pele');
  const defined = new Set([...block.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]!));
  assert.ok(defined.size >= 20, `the variable block no longer parses as a declaration list: ${defined.size} names`);
  const consumed = new Map<string, Set<string | undefined>>();
  for (const source of censusSources()) {
    const { svg } = renderPele(source, { idPrefix: 'census', links: false, images: false });
    for (const match of svg.matchAll(/var\((--pele-[\w-]+)(,([^()]*))?\)/g)) {
      const fallbacks = consumed.get(match[1]!) ?? new Set<string | undefined>();
      fallbacks.add(match[3]);
      consumed.set(match[1]!, fallbacks);
    }
  }
  assert.ok(consumed.size >= 15, `the census stopped seeing the palette: ${consumed.size} names`);
  for (const [name, fallbacks] of consumed) {
    if (defined.has(name)) continue;
    assert.equal(fallbacks.size, 1, `${name} is consumed with ${[...fallbacks].join(' and ')} as its default`);
    const [fallback] = [...fallbacks];
    const recorded = FALLBACK_ONLY[name];
    assert.ok(recorded, `${name} is consumed by the emitted SVG and diagram.css never defines it`);
    assert.equal(fallback, recorded.fallback, `${name} carries a default other than the recorded ${recorded.fallback}`);
    if (recorded.css !== null) {
      assert.ok(block.includes(recorded.css), `${recorded.css} is gone, so ${name} no longer resolves to what it did`);
    }
  }
});

/**
 * An author's `style`/`classDef`/`linkStyle` directive reaches this adapter as a
 * `style` attribute, and every `style` attribute used to be dropped: the box was
 * measured with the label at 40 px and the label then rendered at whatever the
 * page's stylesheet said. The raw render is asserted to carry the declaration, so
 * a fixture that stopped exercising the conversion cannot make the row pass by
 * having nothing to convert.
 */
test('Pele emits an author’s declaration as the presentation attribute it stands for', async () => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const original = inspect(renderPele(AUTHORED_SIZE, { idPrefix: 'authored', links: false, images: false }).svg);
  assert.ok(
    original.elements.some(({ attributes }) => attributes['style']?.includes('font-size:40px')),
    'the fixture no longer emits the declaration this row converts',
  );
  const svg = await renderDiagram(AUTHORED_SIZE, 'authored', 'Authored size');
  const { elements, root } = inspect(svg);
  assertClean(svg);
  assert.equal(root['viewBox'], original.root['viewBox'], 'the fixture no longer measures its label at the authored size');
  const label = elements.find(({ attributes }) => attributes['class'] === 'pele-label');
  assert.equal(label?.attributes['font-size'], '40px', 'the authored size did not reach the element');
  const { browser, page } = await openDiagramPage(`<figure class="diagram">${svg}</figure>`);
  try {
    const measured = await page.evaluate(() => {
      const element = document.querySelector('svg.pele text.pele-label');
      if (element === null) throw new Error('the fixture no longer renders the label this row measures');
      return Number.parseFloat(getComputedStyle(element).fontSize);
    });
    assert.equal(measured, 40, 'the label still renders at the stylesheet’s size, in a box measured at the authored one');
  } finally {
    await browser.close();
  }
});

/**
 * A `style` declaration outranks a presentation attribute in CSS, so where the
 * author's declaration and Pele's own attribute name the same property the
 * attribute has to lose — and where Pele's attribute holds a `var()`, the value
 * cannot be compared at build time, which is why it is displacing rather than
 * merging. Both are asserted, in the browser, because the failure this catches is
 * a rendering difference: a `font-weight="var(--_w)"` left beside a
 * `font-weight="600"` would be a duplicate attribute, and one left *instead of*
 * it would render `bold` where the author wrote 600.
 */
test('Pele keeps an authored declaration even where it displaces its own attribute', async () => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const original = inspect(renderPele(AUTHORED_PAINT, { idPrefix: 'declared', links: false, images: false }).svg);
  const rawStyles = original.elements.flatMap(({ attributes }) => attributes['style'] ?? []).join(' ');
  assert.match(rawStyles, /fill:#ff0000/, 'the fixture no longer emits the authored paint declaration');
  assert.match(rawStyles, /font-weight:600/, 'the fixture no longer emits the authored weight declaration');
  const svg = await renderDiagram(AUTHORED_PAINT, 'declared', 'Declared style');
  const { elements, root } = inspect(svg);
  assertClean(svg);
  assert.equal(root['viewBox'], original.root['viewBox'], 'the fixture no longer renders the geometry this row compares');
  const box = elements.find(({ attributes }) => attributes['class']?.includes('pele-rounded'));
  assert.ok(box, 'the box lost the class that carries its corner radius');
  assert.deepEqual(
    Object.fromEntries(['fill', 'stroke', 'stroke-width', 'opacity'].map((name) => [name, box.attributes[name]])),
    { fill: '#ff0000', stroke: '#00ff00', 'stroke-width': '3px', opacity: '0.5' },
    'an authored declaration did not displace the attribute it outranks',
  );
  const label = elements.find(({ attributes }) => attributes['class'] === 'pele-label');
  assert.ok(label, 'the fixture no longer renders a label');
  assert.deepEqual(
    Object.fromEntries(['font-weight', 'font-style', 'font-family', 'letter-spacing'].map((name) => [name, label.attributes[name]])),
    { 'font-weight': '600', 'font-style': 'italic', 'font-family': 'Georgia', 'letter-spacing': '2px' },
  );
  // Pele's own `font-weight` attribute carries a `var()`, which a filter or a
  // later style element could not be trusted to leave alone; the emitted value is
  // a literal, and this is the reason it is allowed to be.
  assert.equal(label.attributes['font-weight'], '600');
  const { browser, page } = await openDiagramPage(`<figure class="diagram">${svg}</figure>`);
  try {
    const measured = await page.evaluate(() => {
      const rect = document.querySelector('svg.pele rect.pele-rounded');
      const text = document.querySelector('svg.pele text.pele-label');
      if (rect === null || text === null) throw new Error('the fixture no longer renders what this row measures');
      const style = getComputedStyle(text);
      return { fill: getComputedStyle(rect).fill, weight: Number(style.fontWeight), spacing: style.letterSpacing };
    });
    assert.equal(measured.fill, 'rgb(255, 0, 0)', 'the authored fill did not reach the rendering');
    assert.equal(measured.weight, 600, 'the authored weight did not reach the rendering');
    assert.equal(measured.spacing, '2px', 'the authored letter spacing did not reach the rendering');
  } finally {
    await browser.close();
  }
});

/**
 * A literal `rx` is the one case where the class mechanism and the declaration
 * cannot both be honoured: `.diagram svg.pele .pele-rounded` is a class rule and
 * would beat the presentation attribute, so an element carrying both would render
 * `var(--_r)` and drop the author's radius. `rx:var(--_r);rx:8px` is Pele's own
 * output for `style A rx:8px`, and the last declaration wins, as CSS says.
 */
test('a literal radius becomes the attribute, not the class that would outrank it', async () => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const source = 'flowchart TD\n A[Reader] --> B[Site]\n style A rx:8px';
  const svg = await renderDiagram(source, 'literal-radius', 'Literal radius');
  const { elements } = inspect(svg);
  assertClean(svg);
  const sized = elements.find(({ attributes }) => attributes['rx'] !== undefined);
  assert.equal(sized?.attributes['rx'], '8px', 'the authored radius is not on the element');
  assert.ok(
    !sized.attributes['class']?.includes('pele-rounded'),
    'the class that carries var(--_r) was added beside a literal radius',
  );
  assert.ok(
    elements.some(({ attributes }) => attributes['class']?.includes('pele-rounded')),
    'the unstyled node lost the class that carries var(--_r)',
  );
});

/**
 * The displacement rule's other half, and the half it did not hold: a
 * declaration the renderer drops is not a declaration at all — the attribute it
 * was meant to outrank still applies. Projecting it *deletes* that attribute
 * instead, because the `fill="not-a-color"` emitted in its place is dropped by
 * the same parse: the box that paints from `var(--_s)` in the raw render loses
 * its fill and inherits the root's paint. A rendering change with no error
 * anywhere is exactly what the build refuses here, naming the declaration.
 * `fill:not-a-color` is a cell of the measured face whose verdict the property
 * grammar and the renderer agree on; the cells they disagree on are the two
 * tables in `pele-render.ts`, and each has its own row below.
 *
 * The control is the raw render: it must carry both the declaration and the
 * `var()` attribute it displaces, or the row would pass by having nothing to
 * project.
 */
test('Pele refuses an authored declaration with no measured projection', async () => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const source = 'flowchart TD\n A[Reader] --> B[Site]\n style A fill:not-a-color';
  const original = inspect(renderPele(source, { idPrefix: 'declared-invalid', links: false, images: false }).svg);
  const node = original.elements.find(({ attributes }) => attributes['style']?.includes('fill:not-a-color'));
  assert.ok(node, 'the fixture no longer emits the declaration this row refuses');
  assert.equal(node.attributes['fill'], 'var(--_s)', 'the fixture no longer carries the attribute the declaration displaces');
  await assert.rejects(() => renderDiagram(source, 'declared-invalid', 'Declared invalid'), (error: unknown) =>
    error instanceof DiagramError && error.source === source && /fill: not-a-color/.test(error.message));
});

/**
 * The second refusal at the same point, and why the grammar is not the whole
 * oracle: these are rows of `NON_NEGATIVE`, whose values the renderer requires
 * to be non-negative while the grammar for them is sign-agnostic. Measured in
 * Chromium 158, `rx:-4px` is dropped from a declaration — so the raw render
 * still rounds the box from `rx: var(--_r)` — while `rx="-4px"` is taken back as
 * a presentation attribute, so the projection would lose the rounding *and*
 * carry a value the declaration never had.
 *
 * The four probes are every table row an author directive can reach, and the
 * control is the raw render carrying the declaration exactly as written.
 */
test.each(['rx:-4px', 'stroke-width:-2px', 'stroke-dasharray:-2%', 'ry:-50%'])(
  'Pele refuses a negative value for a non-negative property: %s', async (declaration) => {
    const { renderDiagram } = await import('../src/lib/pele-render.ts');
    const source = `flowchart TD\n A[Reader] --> B[Site]\n style A ${declaration}`;
    const original = inspect(renderPele(source, { idPrefix: 'negative', links: false, images: false }).svg);
    assert.ok(
      original.elements.some(({ attributes }) => attributes['style']?.includes(declaration)),
      'the fixture no longer emits the negative declaration this row refuses',
    );
    await assert.rejects(() => renderDiagram(source, 'negative', 'Negative value'), (error: unknown) =>
      error instanceof DiagramError && error.source === source && error.message.includes(declaration.replace(':', ': ')));
  });

/**
 * The complement of the table, and the reason it is a table rather than a sign
 * rule: the renderer keeps a negative for `letter-spacing` and
 * `stroke-dashoffset` — measured in both spellings — so a negative declaration
 * there has to become the attribute as before. Refusing it would refuse a value
 * the browser honours. `stroke-dashoffset` reaches the shape and
 * `letter-spacing` the label, so a missing projection on either is its own
 * failure.
 */
test('Pele keeps a negative declaration where the renderer keeps the value', async () => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const source = 'flowchart TD\n A[Reader] --> B[Site]\n style A letter-spacing:-2px,stroke-dashoffset:-2';
  const svg = await renderDiagram(source, 'negative-kept', 'Negative kept');
  const { elements } = inspect(svg);
  assertClean(svg);
  const label = elements.find(({ attributes }) => attributes['letter-spacing'] !== undefined);
  assert.equal(label?.attributes['letter-spacing'], '-2px', 'a negative the renderer keeps did not reach the label');
  const shape = elements.find(({ attributes }) => attributes['stroke-dashoffset'] !== undefined);
  assert.equal(shape?.attributes['stroke-dashoffset'], '-2', 'a negative the renderer keeps did not reach the shape');
});

/**
 * The measured face, one row per `RENDERER_KEPT_NUMBER` row in
 * `pele-render.ts` (r3): every spelling below is a real `style A` directive,
 * rendered through the raw renderer and the adapter and read back side by side
 * in the browser. The reading is pinned to the value the r3 measurements (the
 * 380-cell sweep and its boundary probe) read for *both* forms, so a browser
 * that starts dropping a spelling — or an adapter that starts normalising one —
 * fails here instead of passing a drop-versus-drop comparison. `specified` is
 * asserted non-empty on the raw element: the declaration survived the renderer's
 * parse, which is the half of the row the property grammar gets wrong.
 */
const UNITLESS_FACE: ReadonlyArray<readonly [
  property: string,
  values: ReadonlyArray<readonly [value: string, reading: string]>,
]> = [
  ['rx', [['4', '4px'], ['0.5', '0.5px'], ['1e2', '100px'], ['1500', '1500px'], ['+4', '4px'], ['4.0', '4px']]],
  ['ry', [['4', '4px'], ['0.5', '0.5px'], ['1e2', '100px'], ['1500', '1500px']]],
  ['fill-opacity', [['4', '1'], ['-2', '0'], ['1e2', '1'], ['1500', '1']]],
  ['font-size', [['4', '4px'], ['0.5', '0.5px'], ['1e2', '100px'], ['1500', '1500px']]],
  ['letter-spacing', [['4', '4px'], ['-2', '-2px'], ['1e2', '100px'], ['1500', '1500px']]],
  ['word-spacing', [['4', '4px'], ['-2', '-2px'], ['1e2', '100px'], ['1500', '1500px']]],
];

/** The `RENDERER_KEPT_PERCENTAGE` row — `word-spacing`'s percentage, both signs. */
const PERCENTAGE_FACE: ReadonlyArray<readonly [value: string, reading: string]> = [
  ['50%', '50%'],
  ['-50%', '-50%'],
];

/** The source shape every face row reads: `style A` lands on the first node's box or its label. */
function faceSource(property: string, value: string): string {
  return `flowchart TD\n A[Reader] --> B[Site]\n style A ${property}:${value}`;
}

/**
 * Render each cell's source through the raw renderer and the adapter, serve
 * every pair side by side without a policy (`openDiagramPage` above), and read
 * each pair back: the raw element carrying the author's declaration, the
 * adapter element carrying the property, and the computed value of both.
 *
 * The element controls are the point of the helper. `localName` and the `x`/`y`
 * geometry have to match between the two — the adapter must not be compared
 * across elements — and the adapter's attribute has to carry the author's own
 * spelling, which is what projection as-is means.
 */
async function measureCells(cells: ReadonlyArray<{ property: string; value: string; source: string }>) {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const blocks: string[] = [];
  for (const [index, cell] of cells.entries()) {
    const { svg } = renderPele(cell.source, { idPrefix: `face-${index}`, links: false, images: false });
    const adapter = await renderDiagram(cell.source, `face-${index}`, 'Face probe');
    assertClean(adapter);
    blocks.push(`<figure class="diagram" data-role="raw-${index}">${svg}</figure>`);
    blocks.push(`<figure class="diagram" data-role="adapter-${index}">${adapter}</figure>`);
  }
  const { browser, page } = await openDiagramPage(blocks.join(''), { policy: null });
  try {
    return await page.evaluate((probes) => probes.map(({ property, value, index }) => {
      const elements = (role: string): Element[] => {
        const figure = document.querySelector(`figure[data-role="${role}"]`);
        if (figure === null) throw new Error(`the page lost the ${role} block`);
        return [...figure.querySelectorAll('*')];
      };
      const raw = elements(`raw-${index}`).filter((element) =>
        element.localName !== 'svg' && (element.getAttribute('style') ?? '').includes(`${property}:${value}`));
      const adapter = elements(`adapter-${index}`).filter((element) => element.hasAttribute(property));
      if (raw.length !== 1) throw new Error(`${property}:${value} is on ${raw.length} raw elements, not one`);
      if (adapter.length !== 1) throw new Error(`${property} is on ${adapter.length} adapter elements, not one`);
      const geometry = (element: Element): string => `${element.getAttribute('x')}/${element.getAttribute('y')}`;
      const reading = (element: Element): string => getComputedStyle(element).getPropertyValue(property);
      return {
        rawTag: raw[0]!.localName,
        adapterTag: adapter[0]!.localName,
        rawGeometry: geometry(raw[0]!),
        adapterGeometry: geometry(adapter[0]!),
        specified: (raw[0] as SVGElement).style.getPropertyValue(property),
        emitted: adapter[0]!.getAttribute(property),
        raw: reading(raw[0]!),
        adapter: reading(adapter[0]!),
      };
    }), cells.map((cell, index) => ({ property: cell.property, value: cell.value, index })));
  } finally {
    await browser.close();
  }
}

test.each(UNITLESS_FACE)(
  'a unitless %s declaration is projected as the renderer keeps it', async (property, values) => {
    const cells = values.map(([value]) => ({ property, value, source: faceSource(property, value) }));
    const measured = await measureCells(cells);
    for (const [index, [value, reading]] of values.entries()) {
      const cell = measured[index]!;
      const label = `${property}:${value}`;
      assert.equal(cell.rawTag, cell.adapterTag, `${label}: the two forms are not the same kind of element`);
      assert.equal(cell.rawGeometry, cell.adapterGeometry, `${label}: the two forms are not the same element`);
      assert.notEqual(cell.specified, '', `${label}: the browser no longer keeps the declaration — the row's premise is gone`);
      assert.equal(cell.emitted, value, `${label}: the projection did not carry the author's spelling`);
      assert.equal(cell.raw, reading, `${label}: the raw render no longer computes ${reading}`);
      assert.equal(cell.adapter, reading, `${label}: the projection computes ${cell.adapter}, not ${reading}`);
    }
  },
);

test.each(PERCENTAGE_FACE)(
  'a %s word-spacing declaration is projected as the renderer keeps it', async (value, reading) => {
    const source = faceSource('word-spacing', value);
    const [cell] = await measureCells([{ property: 'word-spacing', value, source }]);
    assert.notEqual(cell!.specified, '', `word-spacing:${value}: the browser no longer keeps the declaration`);
    assert.equal(cell!.emitted, value, `word-spacing:${value}: the projection did not carry the author's spelling`);
    assert.equal(cell!.raw, reading, `word-spacing:${value}: the raw render no longer computes ${reading}`);
    assert.equal(cell!.adapter, reading, `word-spacing:${value}: the projection computes ${cell!.adapter}, not ${reading}`);
  },
);

/**
 * The r3 finding, source-level: `style A rx:4`. The raw render carries
 * `style="rx:var(--_r);rx:4"` — the browser keeps the declaration, the last one
 * wins, and the box rounds at 4 user units — while the adapter used to fail the
 * whole build on the property grammar's verdict, refusing a value the browser
 * keeps. The class mechanism has to stay off this element: a `.pele-rounded`
 * class rule would outrank the projected attribute and render `var(--_r)`,
 * which is a different radius, while the other node keeps its class.
 */
test('the authored unitless radius is projected, and the class that would outrank it stays off', async () => {
  const source = 'flowchart TD\n A[Reader] --> B[Site]\n style A rx:4';
  const { svg: raw } = renderPele(source, { idPrefix: 'unitless-radius', links: false, images: false });
  assert.match(raw, /style="rx:var\(--_r\);rx:4;"/, 'the raw render no longer carries the declaration this row projects');
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const svg = await renderDiagram(source, 'unitless-radius', 'Unitless radius');
  const { elements } = inspect(svg);
  assertClean(svg);
  const sized = elements.find(({ attributes }) => attributes['rx'] !== undefined);
  assert.equal(sized?.attributes['rx'], '4', 'the authored radius is not on the element');
  assert.ok(
    !sized?.attributes['class']?.includes('pele-rounded'),
    'the class that carries var(--_r) was added beside the projected radius',
  );
  assert.ok(
    elements.some(({ attributes }) => attributes['class']?.includes('pele-rounded')),
    'the unstyled node lost the class that carries var(--_r)',
  );
  const [cell] = await measureCells([{ property: 'rx', value: '4', source }]);
  assert.equal(cell!.raw, '4px', 'the raw render no longer rounds the box at the authored unit');
  assert.equal(cell!.adapter, '4px', 'the projected radius does not compute the raw render’s radius');
});

/**
 * The r3 finding, source-level: `word-spacing` is a legal SVG presentation
 * attribute and the renderer keeps `-2px`, but it was missing from the emit
 * allowlist, so every authored `word-spacing` was refused as having “no safe
 * equivalent” — measured false. It is projected like the `letter-spacing`
 * beside it, onto the label the declaration reached.
 */
test('an authored word-spacing reaches the label as its presentation attribute', async () => {
  const source = 'flowchart TD\n A[Reader] --> B[Site]\n style A word-spacing:-2px';
  const { svg: raw } = renderPele(source, { idPrefix: 'word-spacing', links: false, images: false });
  assert.match(raw, /style="word-spacing:-2px;"/, 'the raw render no longer carries the declaration this row projects');
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const svg = await renderDiagram(source, 'word-spacing', 'Word spacing');
  const { elements } = inspect(svg);
  assertClean(svg);
  const label = elements.find(({ attributes }) => attributes['word-spacing'] !== undefined);
  assert.equal(label?.attributes['word-spacing'], '-2px', 'the authored spacing is not on the label');
  const [cell] = await measureCells([{ property: 'word-spacing', value: '-2px', source }]);
  assert.equal(cell!.raw, '-2px', 'the raw render no longer spaces the words at the authored value');
  assert.equal(cell!.adapter, '-2px', 'the projected spacing does not compute the raw render’s value');
});

/**
 * The refused half of the face, one spelling per measured reason: the sign
 * boundary of a `'positive'` row (`rx:-2`, `ry:-2`, `font-size:-2`), the shape
 * boundary that keeps the number and drops the dimension
 * (`fill-opacity:-4px`), a list that must not be read as its first number
 * (`rx:4 -2`), and a value the renderer drops outright (`rx:not-a-color`,
 * `word-spacing:bold`).
 *
 * Each row has the adapter fail loudly on the real source, then shows *why*
 * refusal is the direction that preserves the rendering, in the same browser:
 * the declaration is dropped on an element that carries nothing else
 * (`specified` is empty — the value that would render comes from what the
 * declaration displaces), and on a pele-shaped element that carries a value of
 * its own, the projection's attribute form computes something else than the
 * dropped declaration left behind. The last assertion is the ablatable half:
 * it is what makes each refusal necessary rather than merely safe.
 */
const REFUSED_FACE: ReadonlyArray<{
  property: string;
  value: string;
  element: 'rect' | 'text';
  displaced: string;
  displacedReading: string;
  projectedReading: string;
}> = [
  { property: 'rx', value: '-2', element: 'rect', displaced: '9px', displacedReading: '9px', projectedReading: '-2px' },
  { property: 'ry', value: '-2', element: 'rect', displaced: '9px', displacedReading: '9px', projectedReading: '-2px' },
  { property: 'font-size', value: '-2', element: 'text', displaced: '33px', displacedReading: '33px', projectedReading: '16px' },
  { property: 'fill-opacity', value: '-4px', element: 'rect', displaced: '0.25', displacedReading: '0.25', projectedReading: '1' },
  { property: 'rx', value: 'not-a-color', element: 'rect', displaced: '9px', displacedReading: '9px', projectedReading: '0px' },
  { property: 'rx', value: '4 -2', element: 'rect', displaced: '9px', displacedReading: '9px', projectedReading: '0px' },
  { property: 'word-spacing', value: 'bold', element: 'text', displaced: '5px', displacedReading: '5px', projectedReading: '0px' },
];

test.each(REFUSED_FACE)(
  'Pele refuses $property:$value, and the projection would move the rendering',
  async (row) => {
    const { property, value, element, displaced, displacedReading, projectedReading } = row;
    const source = faceSource(property, value);
    const { renderDiagram } = await import('../src/lib/pele-render.ts');
    await assert.rejects(() => renderDiagram(source, 'refused-face', 'Refused face'), (error: unknown) =>
      error instanceof DiagramError && error.source === source && error.message.includes(`${property}: ${value}`));
    const { svg: raw } = renderPele(source, { idPrefix: 'refused-face', links: false, images: false });
    const box = element === 'rect' ? 'x="5" y="5" width="50" height="20"' : 'x="5" y="20"';
    const probe = (role: string, attributes: string): string =>
      `<figure class="diagram" data-role="${role}"><svg xmlns="http://www.w3.org/2000/svg" class="pele" ` +
      `viewBox="0 0 100 100" width="100" height="100"><${element} ${attributes}/></svg></figure>`;
    const { browser, page } = await openDiagramPage(
      `<figure class="diagram" data-role="raw">${raw}</figure>` +
      probe('clean', `style="${property}:${value}"`) +
      probe('displaced', `${box} ${property}="${displaced}" style="${property}:${value}"`) +
      probe('projected', `${box} ${property}="${value}"`),
      { policy: null },
    );
    try {
      const measured = await page.evaluate(({ property, value }) => {
        const one = (role: string): Element => {
          const figure = document.querySelector(`figure[data-role="${role}"]`);
          if (figure === null) throw new Error(`the page lost the ${role} block`);
          const found = [...figure.querySelectorAll('*')].filter((element) =>
            role === 'raw'
              ? element.localName !== 'svg' && (element.getAttribute('style') ?? '').includes(`${property}:${value}`)
              : element.hasAttribute('style') || element.hasAttribute(property));
          if (found.length !== 1) throw new Error(`${role}: ${property} is on ${found.length} elements, not one`);
          return found[0]!;
        };
        const reading = (role: string): string => getComputedStyle(one(role)).getPropertyValue(property);
        return {
          specified: (one('clean') as SVGElement).style.getPropertyValue(property),
          displaced: reading('displaced'),
          projected: reading('projected'),
        };
      }, { property, value });
      assert.equal(measured.specified, '', `${property}:${value}: the browser no longer drops this declaration`);
      assert.equal(
        measured.displaced, displacedReading,
        `${property}:${value}: the element's own value no longer survives the dropped declaration`,
      );
      assert.equal(measured.projected, projectedReading, `${property}:${value}: the projection no longer computes what it used to`);
      assert.notEqual(
        measured.displaced, measured.projected,
        `${property}:${value}: the projection no longer moves the rendering, so the refusal is no longer measured as necessary`,
      );
    } finally {
      await browser.close();
    }
  },
);


const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">';
test.each([
  ['empty', ''],
  ['whitespace', ' \n '],
  ['empty SVG', `${SVG_OPEN}</svg>`],
  ['wrong root', '<div>not SVG</div>'],
  ['malformed XML', `${SVG_OPEN}<path></svg>`],
  ['script', `${SVG_OPEN}<script>alert(1)</script></svg>`],
  ['style element', `${SVG_OPEN}<style>path { fill: red }</style><path d="M0 0L1 1"/></svg>`],
  ['event', `${SVG_OPEN}<path onload="alert(1)" d="M0 0L1 1"/></svg>`],
  ['foreign namespace', `${SVG_OPEN}<path xmlns="http://www.w3.org/1999/xhtml"/></svg>`],
  ['external href', `${SVG_OPEN}<a href="https://example.invalid/"><text>link</text></a></svg>`],
  ['external paint', `${SVG_OPEN}<path fill="url(https://example.invalid/p.svg#paint)" d="M0 0L1 1"/></svg>`],
  ['fallback external paint', `${SVG_OPEN}<path fill="var(--paint,url(https://example.invalid/p.svg#paint))" d="M0 0L1 1"/></svg>`],
  ['escaped external paint', `${SVG_OPEN}<path fill="u\\72l(https://example.invalid/p.svg#paint)" d="M0 0L1 1"/></svg>`],
  ['DOCTYPE', `<!DOCTYPE svg [<!ENTITY probe SYSTEM "file:///nonexistent-diagram-canary">]>${SVG_OPEN}<text>&probe;</text></svg>`],
  ['stylesheet instruction', `<?xml-stylesheet href="https://example.invalid/s.css"?>${SVG_OPEN}<path d="M0 0L1 1"/></svg>`],
])('Pele rejects unsafe or blank upstream output: %s', async (_name, svg) => {
  vi.mocked(renderPele).mockReturnValueOnce({ svg, width: 10, height: 10, links: [], type: 'flowchart', mermaidType: 'flowchart-v2' });
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const source = DIAGRAMS['flowchart']!;
  await assert.rejects(() => renderDiagram(source, 'unsafe', 'Unsafe'), (error: unknown) =>
    error instanceof DiagramError && error.source === source);
});

test('Pele treats hostile label text and accessible names as text, not markup', async () => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const name = '"><script>alert(1)</script><svg onload="alert(2)">';
  const svg = await renderDiagram('flowchart TD\n A["Reader <img src=x onerror=alert(1)>"] --> B[Site]', 'hostile', name);
  assertClean(svg);
  assert.equal(inspect(svg).root['aria-label'], name);
  assert.match(inspect(svg).text, /Reader/);
});

/**
 * Serve one rendered document under the site's own stylesheets and the
 * build-time CSP, and hand back the live page.
 *
 * `playwright` is imported here rather than at the top of the file: every other
 * row is a build-time assertion, and a static import turns an absent browser
 * package into a collection error for all of them instead of a named failure
 * for the two rows that need a browser.
 *
 * `style-src 'self'` is the policy the build-time row ships, so anything
 * measuring that row's cascade has to measure it under that policy — see the
 * token row below for what it blocks. `policy: null` serves the same document
 * with no policy at all, which is the only way to measure the *raw* render
 * beside the adapter: the raw render carries its presentation in `style=`
 * attributes and this policy blocks exactly those, so a policy-bearing page
 * would measure the blocked declaration rather than the rendering the adapter
 * has to reproduce. The adapter's own output never carries `style=`
 * (`assertClean` gates that), so nothing that the policy could block reaches
 * its elements, and the two blocks below are measured under one cascade.
 */
async function openDiagramPage(markup: string, options: { policy?: string | null } = {}) {
  const { chromium } = await import('playwright');
  const styles: Readonly<Record<string, string>> = {
    '/tokens.css': readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'),
    '/diagram.css': readFileSync(new URL('../src/styles/diagram.css', import.meta.url), 'utf8'),
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route('https://diagram.test/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') {
      const policy = options.policy === undefined ? "default-src 'none'; style-src 'self'" : options.policy;
      await route.fulfill({
        contentType: 'text/html',
        headers: policy === null ? {} : { 'content-security-policy': policy },
        body: '<!doctype html><html><head><link rel="stylesheet" href="/tokens.css">' +
          `<link rel="stylesheet" href="/diagram.css"></head><body>${markup}</body></html>`,
      });
      return;
    }
    const css = styles[pathname];
    if (css !== undefined) await route.fulfill({ contentType: 'text/css', body: css });
    else await route.abort();
  });
  await page.goto('https://diagram.test/');
  return { browser, page };
}

test('Pele preserves subscript, superscript and bold labels under external CSS', async () => {
  selection.engine = 'pele';
  const { html } = await renderMarkdown(
    '```mermaid\nflowchart TD\n A["H<sub>2</sub>O"] --> B["x<sup>3</sup> and <b>Bold</b> plus <strong>Strong</strong>"]\n```\n',
  );
  const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
  assert.ok(svg);
  assertClean(svg);
  const { browser, page } = await openDiagramPage(html);
  try {
    const formatting = await page.locator('svg tspan').evaluateAll((spans) => spans.map((span) => {
      const style = getComputedStyle(span);
      const parentStyle = getComputedStyle(span.parentElement!);
      return {
        text: span.textContent?.trim(), shift: style.getPropertyValue('baseline-shift'),
        size: Number.parseFloat(style.fontSize), parentSize: Number.parseFloat(parentStyle.fontSize),
        weight: Number(style.fontWeight), parentWeight: Number(parentStyle.fontWeight),
      };
    }));
    for (const [text, shift] of [['2', 'sub'], ['3', 'super']]) {
      const run = formatting.find((item) => item.text === text);
      assert.ok(run, `${text}: its formatted label run is missing`);
      assert.equal(run.shift, shift, `${text}: its baseline positioning was lost`);
      assert.ok(run.size < run.parentSize, `${text}: its smaller script size was lost`);
    }
    for (const text of ['Bold', 'Strong']) {
      const run = formatting.find((item) => item.text === text);
      assert.ok(run && run.weight > run.parentWeight, `${text}: authored emphasis was lost`);
    }
  } finally {
    await browser.close();
  }
});

/**
 * The Pele row of `diagram-mode.ts`'s table names `diagram.css`'s variable block
 * as the whole of its presentation, and no committed gate observed it: deleting
 * `--_tw`, `--_fm`, the `--_s` mapping or `.pele-rounded` left the suite green.
 *
 * Each assertion is an ablation, not a snapshot of a value: drop the alias and
 * the property falls back to what it would otherwise inherit — `400`, `auto`,
 * the sans stack — which is what these rows compare against. `--_hw` stays
 * unobserved: the `journey`, `class`, `c4`, `requirement` and `treemap`
 * fixtures below render elements that consume it, but no row reads it.
 */
test('diagram.css resolves Pele’s title weight, rounding, paint and mono label', async () => {
  selection.engine = 'pele';
  const { html } = await renderMarkdown(
    '```mermaid\n' + DIAGRAMS['gantt']! + '\n```\n\n' +
    '```mermaid\nflowchart TD\n A["run <code>pnpm build</code> now"] --> B[Site]\n```\n',
  );
  const { browser, page } = await openDiagramPage(html);
  try {
    const measured = await page.evaluate(() => {
      const svg = document.querySelector('svg.pele');
      const title = document.querySelector('svg.pele .pele-title');
      const rounded = document.querySelector('svg.pele rect.pele-rounded');
      const node = [...document.querySelectorAll('svg.pele rect')].find((rect) => rect.getAttribute('fill') === 'var(--_s)');
      const code = document.querySelector('svg.pele tspan[font-family]');
      const label = document.querySelector('svg.pele text.pele-label');
      if (svg === null || title === null || rounded === null || node === undefined || code === null || label === null) {
        throw new Error('the fixture no longer renders the elements this row measures');
      }
      // `setAttribute('style', …)` is blocked by this document's `style-src
      // 'self'`: Chromium logs the violation and the declaration never lands, so
      // a probe built that way silently measures the inherited value instead of
      // the token. `style.setProperty` is not blocked, which is why it is used.
      const resolve = (property: string, value: string): string => {
        const probe = document.createElement('span');
        probe.style.setProperty(property, value);
        document.body.append(probe);
        const computed = getComputedStyle(probe).getPropertyValue(property);
        probe.remove();
        return computed;
      };
      const rxProbe = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rxProbe.style.setProperty('rx', 'var(--_r)');
      svg.append(rxProbe);
      const resolvedRx = getComputedStyle(rxProbe).rx;
      rxProbe.remove();
      return {
        titleWeight: getComputedStyle(title).fontWeight,
        labelWeight: getComputedStyle(label).fontWeight,
        roundedRx: getComputedStyle(rounded).rx,
        resolvedRx,
        nodeFill: getComputedStyle(node).fill,
        surface: resolve('color', 'var(--color-surface)'),
        codeFont: getComputedStyle(code).fontFamily,
        mono: resolve('font-family', 'var(--font-mono)'),
        rootFont: getComputedStyle(svg).fontFamily,
        sans: resolve('font-family', 'var(--font-sans)'),
      };
    });
    assert.equal(measured.titleWeight, '700', 'the title weight token no longer resolves to bold');
    assert.equal(measured.labelWeight, '400', 'a plain label is bold, so the title row proves nothing');
    assert.match(measured.roundedRx, /^\d+(?:\.\d+)?px$/, 'the rounded-corner rule no longer reaches the rect');
    assert.equal(measured.roundedRx, measured.resolvedRx, 'the corner radius is not the length var(--_r) resolves to');
    assert.equal(measured.nodeFill, measured.surface, 'a node’s fill no longer resolves to --color-surface');
    assert.equal(measured.rootFont, measured.sans, 'the diagram root no longer uses --pele-font');
    assert.equal(measured.codeFont, measured.mono, 'the code label run no longer consumes --_fm');
  } finally {
    await browser.close();
  }
});

/**
 * Pele paints a Gantt critical task from `var(--pele-critical, #e45756)` and the
 * variable block never defined it, so the site's own pages carried Pele's red.
 * Resolved in the browser rather than compared as text: the binding is only
 * worth anything if the cascade reaches the bar under the build-time policy.
 */
test('a critical-path Gantt task paints with the site token, not Pele’s own red', async () => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const svg = await renderDiagram(CRIT_GANTT, 'critical', 'Critical path');
  assertClean(svg);
  const bar = inspect(svg).elements.find(({ attributes }) => attributes['fill']?.startsWith('var(--pele-critical,'));
  assert.ok(bar, 'the fixture no longer paints a critical bar from the variable');
  const { browser, page } = await openDiagramPage(`<figure class="diagram">${svg}</figure>`);
  try {
    const { painted, token } = await page.evaluate(() => {
      const element = document.querySelector('svg.pele .pele-crit rect');
      if (element === null) throw new Error('the fixture no longer renders a critical bar');
      const probe = document.createElement('span');
      probe.style.setProperty('color', 'var(--color-syntax-literal)');
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return { painted: getComputedStyle(element).fill, token: resolved };
    });
    assert.equal(painted, token, 'the critical bar resolved Pele’s own red instead of the site token');
    assert.notEqual(painted, 'rgb(228, 87, 86)', 'the bar is still Pele’s literal #e45756');
  } finally {
    await browser.close();
  }
});

/**
 * The dispatcher exists to load *only* the selected adapter (P1 design §5.1).
 * The factories registered in the loop below are what count a request.
 *
 * Last in the file because `vi.resetModules()` invalidates the module instances
 * every row above holds: `DiagramError` is compared by `instanceof`, and after a
 * reset those rows would compare a fresh class against the binding this file
 * imported before it.
 *
 * The source is valid on purpose: this row counts *requests*, and it is about the
 * success path. The failure path is gated where it can be observed — a fresh
 * process with a loader hook, in `a Pele failure loads neither Mermaid’s adapter
 * nor its DOM shim` below. That row exists because this one was green while
 * `pele-render.ts` imported `mermaid-render.ts` from its own `catch`.
 */
test('selecting an engine requests only that engine’s adapter', async () => {
  const requested: string[] = [];
  for (const engine of ['mermaid', 'pele']) {
    vi.resetModules();
    // Re-registered per phase on purpose. A mocked module is instantiated once
    // and kept for the rest of the file — measured: `vi.resetModules()` alone
    // does not drop it, so a second phase would reuse the first phase's instance
    // and count nothing, which is a green that means only that the factory had
    // already run. `vi.doMock` re-registration does drop it, so each phase below
    // counts a fresh set of requests.
    vi.doMock('../src/lib/mermaid-render.ts', async (importOriginal) => {
      requested.push('mermaid-render.ts');
      return { ...(await importOriginal<typeof MermaidAdapter>()) };
    });
    vi.doMock('../src/lib/pele-render.ts', async (importOriginal) => {
      requested.push('pele-render.ts');
      return { ...(await importOriginal<typeof PeleAdapter>()) };
    });
    requested.length = 0;
    selection.engine = engine;
    const { renderDiagram } = await import('../src/lib/diagram-engine.ts');
    assert.match(await renderDiagram(DIAGRAMS['flowchart']!, `lazy-${engine}`, 'Lazy diagram'), /^<svg\b/);
    assert.deepEqual(requested, [`${engine}-render.ts`], `${engine}: the unselected adapter was requested`);
  }
});

/**
 * The rows below observe a *module graph*, which only a fresh process can
 * honestly report: an in-process mock counts the requests made through its own
 * factory, and this suite's own imports are part of the graph it would measure.
 * `tests/support/render-diagram.ts` takes `--adapter`, `--hash` and `--resolves`,
 * and `--resolves` records every specifier the run asked for through a loader
 * hook.
 *
 * They sit after the `vi.resetModules()` row because a child sees none of this
 * file's module registry either way.
 */
const SUPPORT = fileURLToPath(new URL('support/render-diagram.ts', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));

function runInChild(
  adapter: string | undefined,
  source: string,
  options: { hash?: boolean; resolves?: boolean } = {},
): { status: number | null; stdout: string; stderr: string; record: string[] } {
  const directory = mkdtempSync(join(tmpdir(), 'anc-diagram-probe-'));
  const log = join(directory, 'resolves.txt');
  try {
    const argv = [SUPPORT, ...(adapter === undefined ? [] : ['--adapter', adapter])];
    if (options.hash) argv.push('--hash');
    if (options.resolves) argv.push('--resolves');
    argv.push(source);
    const result = spawnSync(process.execPath, argv, {
      cwd: REPOSITORY,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, ...(options.resolves ? { DIAGRAM_RESOLVE_LOG: log } : {}) },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      record: options.resolves ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Pele's failure path used to reach Mermaid's adapter through a dynamic import
 * of one class, and with it `mermaid-environment.ts` and `happy-dom` — the DOM
 * shim the engine seam exists to keep off the unselected path. The control is
 * what makes the negative mean something: the same hook, on a run that must see
 * the shim, has to see it.
 */
test('a Pele failure loads neither Mermaid’s adapter nor its DOM shim', () => {
  const failure = runInChild('src/lib/pele-render.ts', 'notadiagram\n A --> B', { resolves: true });
  assert.match(failure.stderr, /render error: DiagramError/, 'the malformed fixture no longer fails through DiagramError');
  const reachable = failure.record.join('\n');
  assert.match(reachable, /pele-render\.ts/, 'the hook recorded nothing, so the negative assertions below are vacuous');
  assert.doesNotMatch(reachable, /mermaid-render\.ts/, 'Pele’s failure path requested Mermaid’s adapter');
  assert.doesNotMatch(reachable, /mermaid-environment\.ts/, 'Pele’s failure path requested Mermaid’s environment');
  assert.doesNotMatch(reachable, /happy-dom/, 'Pele’s failure path requested the DOM shim');

  const control = runInChild('src/lib/mermaid-render.ts', DIAGRAMS['flowchart']!, { resolves: true });
  assert.equal(control.status, 0, control.stderr);
  const controlReachable = control.record.join('\n');
  assert.match(controlReachable, /mermaid-environment\.ts/, 'the hook cannot see Mermaid’s environment at all');
  assert.match(controlReachable, /happy-dom/, 'the hook cannot see the DOM shim at all');
});

/**
 * P1 design §5(5): with `DIAGRAM_ENGINE = 'mermaid'` the seam is a pass-through,
 * byte for byte. The existing two-engine row compares the dispatcher against
 * itself, so it cannot see a dispatcher that post-processes Mermaid's output —
 * which is exactly what this pair binds.
 *
 * Two fresh processes, not one, for the reason `tests/support/render-diagram.ts`
 * gives: Mermaid seeds gitgraph's hashes from `Math.random` and keeps
 * module-level counters, so a same-process pair shares state the design's claim
 * is not about. It is also the evidence that moving `DiagramError` out of
 * `mermaid-render.ts` did not touch what Mermaid's row renders.
 */
test('the mermaid engine reaches the same bytes through the dispatcher and its adapter', () => {
  const source = DIAGRAMS['flowchart']!;
  const dispatched = runInChild(undefined, source, { hash: true });
  const direct = runInChild('src/lib/mermaid-render.ts', source, { hash: true });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(dispatched.stdout, /^[a-f0-9]{64}$/, 'the child no longer prints a digest');
  assert.equal(dispatched.stdout, direct.stdout, 'the dispatcher no longer passes Mermaid’s output through unchanged');
});
