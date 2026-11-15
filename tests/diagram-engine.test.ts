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

import { parse as parsePele, render as renderPele } from 'pele';
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

/**
 * Directive-free sources that reach a renderer branch no type fixture reaches,
 * one per form Pele writes into an element's `style` outside its plain rounding
 * (r8). Both of the first two were review findings: a legal, directive-free
 * source that failed to build.
 *
 * `classStaticMember` is the `$` classifier Pele's class renderer underlines
 * without any author declaration; `treemapClampZero` is the geometry that
 * crosses Pele's clamp threshold (`Math.min(cell.w, cell.h) / 4 < 4`), where it
 * substitutes its parametric `rx:min(var(--_r),Npx)` for the rounding. The
 * third is the same branch with a *nonzero* clamp: the zero case alone would
 * leave the matcher's number unexercised, and the carrier row measures this one
 * against `--_r` in a browser.
 */
const BRANCH_FIXTURES: Readonly<Record<string, string>> = {
  classStaticMember: 'classDiagram\n  class A {\n    +count$\n  }\n',
  treemapClampZero: 'treemap-beta\n  "A": 1\n  "B": 100000\n',
  treemapClampVisible: 'treemap-beta\n  "A": 1000\n  "B": 100000\n',
};

/** The type fixtures and the branch-only fixtures, in one list for the rows that read both. */
const DIRECTIVE_FREE_FIXTURES: ReadonlyArray<readonly [name: string, source: string]> = [
  ...Object.entries(DIAGRAMS), ...Object.entries(BRANCH_FIXTURES),
];

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

/**
 * Render one diagram source through the adapter and hold it to the raw render:
 * clean of inline execution, the same root geometry, the adapter's own
 * accessible name, and the same visible text.
 *
 * Shared by the type-matrix row, the branch-only fixtures and the real-corpus
 * rows below, because the corpus needs the *same* disposition — the r4 finding
 * was that the corpus was read only through the bare renderer, so the trust
 * boundary never touched it.
 */
async function expectAdapterParity(source: string, name: string, id: string): Promise<string> {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
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
  return svg;
}

test.each(DIRECTIVE_FREE_FIXTURES)('Pele preserves %s geometry and accessible content without inline execution', async (_name, source) => {
  const svg = await expectAdapterParity(source, 'Reader’s diagram <with markup> & "quotes"', 'geometry-probe');
  assert.match(svg, /^<svg\b/, 'the adapter returned no root element to compare');
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
  // so the test exercises `pele-render.ts` itself, independent of the constant's current
  // value: a fresh child cannot see this file's `vi.mock` of `diagram-mode.ts`, so a bare
  // harness run follows the real configured engine through the dispatcher — currently
  // `pele` (`tests/support/render-diagram.ts:75`, where an absent `--adapter` imports
  // `src/lib/diagram-engine.ts`).
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
 * The three real corpus diagrams, read from the files that ship them.
 *
 * Shared deliberately. The census rows read them through the *bare* renderer —
 * an inventory measurement of what Pele emits — and the rows further down read
 * the same sources through the adapter: the r4 finding was that only the first
 * reading existed, so the corpus never touched the trust boundary (an
 * `assertClean` over it was never run). Both readings are kept; they answer
 * different questions.
 */
const CORPUS_FILES = [
  'docs/core-design/architecture.md',
  'example/guides/feature-showcase.md',
  'tests/fixtures/markdown/kitchen-sink.md',
] as const;

function corpusDiagrams(): { path: string; source: string }[] {
  const diagrams = CORPUS_FILES.flatMap((path) =>
    [...readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').matchAll(/```mermaid\n([\s\S]*?)```/g)]
      .map((match) => ({ path, source: match[1]! })));
  assert.equal(diagrams.length, 3, 'the real corpus no longer carries the three diagrams this build reads');
  for (const { path, source } of diagrams) {
    assert.notEqual(source.trim(), '', `${path} carries an empty diagram, so its row would pass vacuously`);
  }
  return diagrams;
}

/**
 * Every source the census rows below read: the 23-type matrix, the three
 * branch-only fixtures, the three real corpus diagrams, and the probes that
 * make an authored paint or a critical task observable.
 *
 * The two authored-paint probes are load-bearing, not decorative:
 * `AUTHORED_PAINT` is the only source here that produces `--_w`, which the
 * root row's 22-member equality needs, and the only one behind the
 * `--pele-bold-weight` and `--pele-fg-on-light` observations `FALLBACK_ONLY`
 * records; the `fill:#111111` probe is the only producer of `--pele-fg-on-dark`.
 */
function censusSources(): string[] {
  return [
    ...Object.values(DIAGRAMS), ...Object.values(BRANCH_FIXTURES),
    ...corpusDiagrams().map(({ source }) => source),
    AUTHORED_PAINT, CRIT_GANTT,
    'flowchart TD\n A[Reader] --> B[Site]\n style A fill:#111111',
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
 * P1 design §5(2): the real corpus, *through the adapter*.
 *
 * The two census rows above read the corpus through the bare renderer, which is
 * the right instrument for what they measure (the root block's declaration set
 * and the variables Pele's markup consumes) and the wrong one for this: no row
 * in the suite ran `assertClean` or the parity assertions over a corpus diagram
 * through the trust boundary, so "the three real diagrams still come out clean
 * after the adapter" was an absence, not a result — the r4 finding. These rows
 * are that gate; the census rows stay as the independent raw measurement.
 *
 * `corpusDiagrams` throws at collection if the three sources are missing or
 * empty, so the rows cannot pass by having nothing to read.
 */
test.each(corpusDiagrams())('the real corpus diagram $path survives the adapter clean', async ({ path, source }) => {
  const name = `The ${path.split('/').at(-1)!} diagram`;
  const svg = await expectAdapterParity(source, name, 'corpus-probe');
  assert.match(svg, /^<svg\b/, 'the adapter returned no root element to compare');
});

/**
 * The fixed-set gate: the declarations Pele writes into a `style` attribute of
 * a diagram with no author declarations have to be members of the set this
 * adapter strips, the adapter has to leave none of them behind, and the set has
 * to be exactly what these renders produce — no member Pele stopped writing, no
 * declaration the set fails to name.
 *
 * The sources are the 23-type matrix, the three branch-only fixtures and the
 * three real corpus diagrams; the bold-run probe is added because none of those
 * produces a bold run, so `--_w` — the one member Pele appends only for a body
 * that consumes it — would have no producer here while the rich-label row
 * further down still renders one through the adapter.
 *
 * The element half is a literal set plus one matcher since r8: literal equality
 * cannot spell the treemap clamp, so a produced declaration is accepted when it
 * is a literal member or when `elementStyleClamp` recognises it; the literals
 * produced must equal the literal set, and at least one clamp must be produced
 * or the matcher would sit there dead.
 *
 * The instruments are read at both ends: the raw render (what arrives) and the
 * adapter's own output (what survives). Measured 2026-11-16 over these 30
 * sources: 22 root members, 2 element literals plus the clamp family, 0
 * residual declarations. The set's own measurement and its re-measurement
 * trigger are documented at `ROOT_STYLE_DECLARATIONS` in `pele-render.ts`.
 */
const FIXED_SET_PROBE = 'flowchart TD\n A["run <b>Bold</b> now"] --> B[Site]';

/** Test-side reader for a `style` attribute: `property: value`, value as written. */
function declarationsOf(style: string): string[] {
  return (parseCss(style, { context: 'declarationList', positions: true }).children?.toArray() ?? []).map((node) => {
    const fields: Record<string, unknown> = node;
    const property = fields['property'];
    const loc = (fields['value'] as { loc?: { start: { offset: number }; end: { offset: number } } } | undefined)?.loc;
    assert.ok(typeof property === 'string', `unreadable declaration in ${style}`);
    assert.ok(loc !== undefined, `unreadable declaration in ${style}`);
    return `${property}: ${style.slice(loc.start.offset, loc.end.offset).trim()}`;
  });
}

test('Pele strips its own fixed inline declarations and leaves no residual style', async () => {
  const { renderDiagram, ROOT_STYLE_DECLARATIONS, ELEMENT_STYLE_DECLARATIONS, elementStyleClamp } =
    await import('../src/lib/pele-render.ts');
  const accepted = { root: new Set(ROOT_STYLE_DECLARATIONS), element: new Set(ELEMENT_STYLE_DECLARATIONS) };
  const produced = { root: new Set<string>(), element: new Set<string>() };
  const sources: ReadonlyArray<readonly [name: string, source: string]> = [
    ...DIRECTIVE_FREE_FIXTURES,
    ...corpusDiagrams().map(({ path, source }) => [path, source] as const),
    ['bold-run probe', FIXED_SET_PROBE],
  ];
  for (const [name, source] of sources) {
    // What arrives: every declaration the raw renderer wrote, held to the fixed
    // set of the element kind it was written on — the root block, the element
    // literals and the clamp family are separate whitelists on purpose.
    const rawParser = new SaxesParser({ xmlns: true });
    let isRoot = true;
    rawParser.on('opentag', (tag) => {
      const kind = isRoot ? 'root' : 'element';
      for (const declaration of declarationsOf(tag.attributes['style']?.value ?? '')) {
        assert.ok(accepted[kind].has(declaration) || (kind === 'element' && elementStyleClamp(declaration) !== undefined),
          `${name}: Pele emitted an inline declaration outside its fixed ${kind} set: ${declaration}`);
        produced[kind].add(declaration);
      }
      isRoot = false;
    });
    rawParser.write(renderPele(source, { idPrefix: 'fixed-set', links: false, images: false }).svg).close();
    // What survives: nothing. The adapter strips the whole fixed set, so no
    // element of its output may carry a `style` attribute or a declaration
    // inside one.
    const svg = await renderDiagram(source, 'fixed-set', 'Fixed set');
    const residual = inspect(svg).elements.flatMap(({ attributes }) => declarationsOf(attributes['style'] ?? ''));
    assert.equal(residual.length, 0, `${name}: declarations survived sanitization: ${residual.join(', ')}`);
  }
  assert.ok(produced.root.size >= 20 && produced.element.size >= 3,
    'the probe corpus stopped exercising the fixed sets, so the equality below would pass vacuously');
  // The literal members are exactly what these sources produce: a member Pele
  // stopped writing — or one the corpus can no longer reach — fails here rather
  // than sitting in the strip set as a hole a stray declaration could hide in.
  // The clamp is a family, so what is pinned is that at least one cell crossed
  // the threshold and that nothing outside the literal set fails the matcher.
  const producedLiterals = [...produced.element].filter((declaration) => accepted.element.has(declaration));
  const producedClamps = [...produced.element].filter((declaration) => !accepted.element.has(declaration));
  assert.ok(producedClamps.length > 0, 'no census source crossed the treemap clamp, so the matcher would be dead');
  assert.ok(producedClamps.every((declaration) => elementStyleClamp(declaration) !== undefined),
    `a produced element declaration is neither a literal member nor the clamp family: ${producedClamps.join(', ')}`);
  assert.deepEqual([...produced.root].sort(), [...ROOT_STYLE_DECLARATIONS].sort());
  assert.deepEqual(producedLiterals.sort(), [...ELEMENT_STYLE_DECLARATIONS].sort());
});

/**
 * Where the strip hands its two r8 forms to: stripping can only stay honest
 * while the declaration still reaches the page, and these rows bind the carrier
 * each one gets. The rounding keeps its `pele-rounded` class, which the
 * `diagram.css` row below measures in a browser; the clamp and the member
 * underline are carried as the element's own attributes — Pele's own carrier
 * for `text-decoration` elsewhere in its output, and the only carrier a
 * per-element clamp value can have — so each row reads the raw declaration
 * (what has to be carried), the adapter's output (that it was), and the absence
 * of a `style` attribute in between.
 */
test('the adapter carries the static member’s underline as a text-decoration attribute', async () => {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const source = BRANCH_FIXTURES['classStaticMember']!;
  assert.ok(elementDeclarations(source).includes('text-decoration: underline'),
    'the raw render no longer writes the declaration this carrier replaces');
  const svg = await renderDiagram(source, 'carrier', 'Carrier');
  assertClean(svg);
  const carried = inspect(svg).elements.filter(({ attributes }) => attributes['text-decoration'] === 'underline');
  assert.equal(carried.length, 1, 'the adapter did not carry the underline as a presentation attribute');
  assert.match(carried[0]!.attributes['class'] ?? '', /(?:^|\s)pele-static(?:\s|$)/,
    'the carried underline no longer sits on the member Pele marks static');
});

test.each(['treemapClampZero', 'treemapClampVisible'] as const)(
  'the adapter carries every treemap clamp as an rx attribute: %s', async (fixture) => {
    const { renderDiagram } = await import('../src/lib/pele-render.ts');
    const source = BRANCH_FIXTURES[fixture]!;
    const declared = elementDeclarations(source).filter((declaration) => declaration.startsWith('rx: min(var(--_r),'));
    assert.ok(declared.length > 0, 'the raw render no longer writes the clamp this carrier replaces');
    const svg = await renderDiagram(source, 'carrier', 'Carrier');
    assertClean(svg);
    const carried = inspect(svg).elements
      .map(({ attributes }) => attributes['rx'])
      .filter((value): value is string => value !== undefined && value.startsWith('min(var(--_r),'));
    assert.deepEqual(carried.sort(), declared.map((declaration) => declaration.slice('rx: '.length)).sort(),
      'the adapter did not carry every clamp as the attribute value it strips');
  });

/**
 * The clamp matcher is a second acceptance rule beside the literal set, so its
 * edges are pinned the way the set's are: each measured renderer output is
 * accepted and returned as the attribute value it is carried as, and every
 * spelling an author could aim at it — a trailing zero the formatter never
 * prints, a canonical hundredth its quarter steps never take, the strict
 * gate's own threshold, or the unnormalised spelling the output branch never
 * hands it — is refused.
 *
 * The accepted rows are the canonically printed quarters the instrumented
 * sweep measured at the substitution site (2026-11-16; `elementStyleClamp` in
 * `pele-render.ts` carries the readings), including both ends — the bare `0`
 * and the largest quarter any cell produced, `3.75`.
 */
test('the clamp matcher accepts only the spelling pele writes', async () => {
  const { elementStyleClamp } = await import('../src/lib/pele-render.ts');
  for (const written of [
    'rx: min(var(--_r),0px)', 'rx: min(var(--_r),0.25px)', 'rx: min(var(--_r),0.5px)',
    'rx: min(var(--_r),0.75px)', 'rx: min(var(--_r),1px)', 'rx: min(var(--_r),1.25px)',
    'rx: min(var(--_r),3.75px)',
  ]) {
    assert.equal(elementStyleClamp(written), written.slice('rx: '.length), `${written} is a spelling pele writes`);
  }
  for (const foreign of [
    'rx: min(var(--_r),0.50px)', // a trailing zero the formatter never prints
    'rx: min(var(--_r),0.00px)', // the zero the formatter prints bare, dressed with one
    'rx: min(var(--_r),4.00px)', // a trailing zero on a value the gate refuses anyway
    'rx: min(var(--_r),0.2px)', // a canonical hundredth the quarter steps never take
    'rx: min(var(--_r),3.99px)', // the same class, at the top of the range
    'rx: min(var(--_r),4px)', // the strict gate's threshold: the writer clamps only below it
    'rx: min(var(--_r),5px)', // beyond the gate the writer substitutes in
    'rx: min(var(--_r),0.125px)', // more decimals than the formatter prints
    'rx: min(var(--_r),04px)', // a leading zero the formatter never prints
    'rx: min(var(--_R),0.5px)', // the argument's spelling
    'rx:min(var(--_r),0.5px)', // the unnormalised spelling the output branch never hands it
    'rx: min(var(--_r),0.5em)', // the unit
    'rx: min(var(--_r),0.5px) ', // trailing space
    'rx: min(var(--_r))', // no clamp value
    'min(var(--_r),0.5px)', // no property
    'text-decoration: underline', // a member of the set, but not of the family
  ]) {
    assert.equal(elementStyleClamp(foreign), undefined,
      `${foreign} is not a spelling pele writes, but the matcher accepted it`);
  }
});

/**
 * The adapter's provenance check reads the model it renders (r7), so this binds
 * that choice: `render(model, options)` must be byte-identical to
 * `render(source, options)` over every source the census rows read. It is the
 * measurement `src/lib/pele-render.ts` cites, taken as a gate — a future pele
 * that rendered a passed model differently would otherwise slip through the
 * parity rows above, which compare geometry and text, not bytes.
 */
test('Pele renders a parsed model to the same bytes as its own source', () => {
  const options = { idPrefix: 'model-parity', links: false, images: false, now: 0 };
  for (const source of censusSources()) {
    assert.equal(
      renderPele(parsePele(source), options).svg,
      renderPele(source, options).svg,
      `rendering the parsed model diverged from rendering the source: ${source.slice(0, 60)}`,
    );
  }
});

/**
 * Render one source and return the failure, asserting it is this adapter's own
 * refusal: decision C converts no author declaration, so every source below has
 * to fail with `DiagramError` rather than publish a guessed rendering.
 */
async function refuse(source: string): Promise<DiagramError> {
  const { renderDiagram } = await import('../src/lib/pele-render.ts');
  const failure: unknown = await renderDiagram(source, 'author-probe', 'Author probe')
    .then(() => null, (error: unknown) => error);
  assert.ok(failure instanceof DiagramError, 'the adapter published an author declaration instead of refusing it');
  assert.equal(failure.source, source, 'the refusal lost the diagram source');
  return failure;
}

/**
 * The refusal, held to the three things decision C requires its message to name:
 * the declaration exactly as written, the directive that carried it, and what
 * to do instead.
 *
 * The origin is asserted as the *specific* clause, not as the generic
 * enumeration every refusal carries: the r8 finding was a copied `classDef`
 * reported as an authored `style`, and a check that only required the three
 * names to appear somewhere in the message could not tell the difference.
 */
async function expectAuthorRefused(
  source: string,
  declaration: string,
  origin: 'style' | 'classDef' | 'linkStyle',
): Promise<void> {
  const failure = await refuse(source);
  assert.ok(failure.message.includes(declaration), `the refusal does not name ${declaration}: ${failure.message}`);
  assert.ok(failure.message.includes(`an author '${origin}' directive`),
    `the refusal does not name '${origin}' as the directive that carried the declaration: ${failure.message}`);
  assert.ok(failure.message.includes("DIAGRAM_ENGINE = 'mermaid'"), `the refusal names no remedy: ${failure.message}`);
}

/** The source shape every probe row reads: `style A` lands on the first node's box or its label. */
function faceSource(property: string, value: string): string {
  return `flowchart TD\n A[Reader] --> B[Site]\n style A ${property}:${value}`;
}

/**
 * The same declaration through parsers that forward it, for the reachable face.
 *
 * The flowchart directive parser rejects a function value at its own parse
 * (measured), so `faceSource` cannot reach the cells below at all; `state`
 * forwards the raw value and `block` does too — two independent parsers, which
 * is the evidence that this is the face and not one diagram type's quirk.
 */
function stateFaceSource(property: string, value: string): string {
  return `stateDiagram-v2\n  A --> B\n  style A ${property}:${value}`;
}

function blockFaceSource(property: string, value: string): string {
  return `block-beta\n  columns 2\n  A B\n  style A ${property}:${value}`;
}

/*
 * The seven rows below replace the r2–r6 conversion tests one for one: each
 * source used to assert a projection — or a refusal justified by what the
 * projection would have rendered — and under decision C each asserts the same
 * refusal instead. The raw render stays as the control that the declaration
 * really arrives, so a fixture that stopped producing it cannot make a row pass
 * by having nothing to refuse.
 */
test('Pele refuses an authored font-size instead of converting it to an attribute', async () => {
  const original = inspect(renderPele(AUTHORED_SIZE, { idPrefix: 'authored', links: false, images: false }).svg);
  assert.ok(
    original.elements.some(({ attributes }) => attributes['style']?.includes('font-size:40px')),
    'the fixture no longer emits the declaration this row refuses',
  );
  await expectAuthorRefused(AUTHORED_SIZE, 'font-size: 40px', 'style');
});

test('Pele refuses an authored paint declaration, naming the declaration it meets', async () => {
  const original = inspect(renderPele(AUTHORED_PAINT, { idPrefix: 'declared', links: false, images: false }).svg);
  const rawStyles = original.elements.flatMap(({ attributes }) => attributes['style'] ?? []).join(' ');
  assert.match(rawStyles, /fill:#ff0000/, 'the fixture no longer emits the authored paint declaration');
  assert.match(rawStyles, /font-weight:600/, 'the fixture no longer emits the authored weight declaration');
  await expectAuthorRefused(AUTHORED_PAINT, 'fill: #ff0000', 'style');
});

test('Pele refuses an authored literal radius rather than choose between it and the rounding class', async () => {
  const source = faceSource('rx', '8px');
  const { svg } = renderPele(source, { idPrefix: 'literal-radius', links: false, images: false });
  assert.match(svg, /style="rx:var\(--_r\);rx:8px;"/, 'the raw render no longer carries the declarations this row reads');
  await expectAuthorRefused(source, 'rx: 8px', 'style');
});

test('Pele refuses an authored declaration the renderer itself would have dropped', async () => {
  const source = faceSource('fill', 'not-a-color');
  const original = inspect(renderPele(source, { idPrefix: 'declared-invalid', links: false, images: false }).svg);
  const node = original.elements.find(({ attributes }) => attributes['style']?.includes('fill:not-a-color'));
  assert.ok(node, 'the fixture no longer emits the declaration this row refuses');
  assert.equal(node.attributes['fill'], 'var(--_s)', 'the fixture no longer carries the attribute the declaration displaces');
  await expectAuthorRefused(source, 'fill: not-a-color', 'style');
});

test('Pele refuses a negative declaration even where the renderer keeps the value', async () => {
  const source = faceSource('letter-spacing', '-2px');
  const { svg } = renderPele(source, { idPrefix: 'negative-kept', links: false, images: false });
  assert.match(svg, /style="letter-spacing:-2px;"/, 'the raw render no longer carries the declaration this row refuses');
  await expectAuthorRefused(source, 'letter-spacing: -2px', 'style');
});

test('Pele refuses the authored unitless radius the r3 sweep projected', async () => {
  const source = faceSource('rx', '4');
  const { svg } = renderPele(source, { idPrefix: 'unitless-radius', links: false, images: false });
  assert.match(svg, /style="rx:var\(--_r\);rx:4;"/, 'the raw render no longer carries the declaration this row refuses');
  await expectAuthorRefused(source, 'rx: 4', 'style');
});

test('Pele refuses an authored word-spacing declaration the emit allowlist used to reject by name', async () => {
  const source = faceSource('word-spacing', '-2px');
  const { svg } = renderPele(source, { idPrefix: 'word-spacing', links: false, images: false });
  assert.match(svg, /style="word-spacing:-2px;"/, 'the raw render no longer carries the declaration this row refuses');
  await expectAuthorRefused(source, 'word-spacing: -2px', 'style');
});

/**
 * The rest of the refused face: the spellings the r4–r6 sweeps measured for the
 * conversion, now under the one disposition decision C gives them. `state` and
 * `block` are here because their parsers forward a function value the flowchart
 * parser rejects at its own parse (measured 2026-11-15), so these are cells an
 * author can really reach.
 */
const REFUSED_DECLARATIONS: ReadonlyArray<{ graph: 'state' | 'block'; property: string; value: string }> = [
  { graph: 'state', property: 'rx', value: 'clamp(4px)' },
  { graph: 'state', property: 'rx', value: 'calc(4px)' },
  { graph: 'state', property: 'rx', value: 'calc(0px - 4px)' },
  { graph: 'state', property: 'stroke-width', value: 'calc(4px)' },
  { graph: 'state', property: 'fill', value: 'var(--pele-accent)' },
  { graph: 'state', property: 'fill', value: 'rgb(from red r g b)' },
  { graph: 'state', property: 'fill', value: 'rgb(calc(255) 0 0)' },
  { graph: 'block', property: 'rx', value: 'calc(4px)' },
];

test.each(REFUSED_DECLARATIONS)(
  'Pele refuses the reachable authored declaration $graph $property:$value',
  async ({ graph, property, value }) => {
    const source = graph === 'state' ? stateFaceSource(property, value) : blockFaceSource(property, value);
    // The control: the declaration really arrives in a `style` attribute, so
    // the row cannot pass by having nothing to refuse.
    const { svg } = renderPele(source, { idPrefix: 'refused-declaration', links: false, images: false });
    assert.ok(
      inspect(svg).elements.some(({ attributes }) => attributes['style']?.includes(`${property}:${value}`)),
      `the raw render no longer carries ${property}:${value}`,
    );
    await expectAuthorRefused(source, `${property}: ${value}`, 'style');
  },
);

test.each([
  ['classDef',
    'flowchart TD\n A[Reader] --> B[Site]\n classDef red fill:#ff0000,stroke:#00ff00\n class A red',
    'fill:#ff0000', 'fill: #ff0000'],
  ['linkStyle',
    'flowchart TD\n A[Reader] --> B[Site]\n linkStyle 0 stroke:#5b7bd5,stroke-width:4px',
    'stroke:#5b7bd5', 'stroke: #5b7bd5'],
] as const)('Pele refuses a %s declaration the same way as an authored style', async (origin, source, written, named) => {
  const { svg } = renderPele(source, { idPrefix: 'refused-directive', links: false, images: false });
  assert.ok(
    inspect(svg).elements.some(({ attributes }) => attributes['style']?.includes(written)),
    `the raw render no longer carries ${written}`,
  );
  await expectAuthorRefused(source, named, origin);
});

/**
 * The r7 finding: membership in `ELEMENT_STYLE_SET` is a spelling, not a
 * provenance. Measured 2026-11-15, Pele's writer normalises the text it writes —
 * `RX:var(--_r)`, `Rx:var(--_r)` and `rx : var(--_r)` all reach an element's
 * `style` attribute as `rx:var(--_r)`, `ELEMENT_STYLE_DECLARATIONS`'s own
 * member — so the output-level strip silently converted an authored
 * declaration.
 *
 * These are the model types whose parser accepts the directive *and* whose
 * renderer forwards it onto an element that exists without the directive too
 * (the sweep behind `authorDirectives` reads every registered type); each
 * control is the same source with its directive lines removed, so the raw
 * render must carry one more `rx: var(--_r)` declaration than the control
 * before the row can pass — a control that is not vacuous. The r8 nested-block
 * row is the same defect on a node the scan never visited; the two forms the
 * element set accepts besides the rounding get their own rows below, because
 * neither forwards the rounding this control counts.
 */
const COLLIDING_DECLARATIONS: ReadonlyArray<{
  name: string;
  origin: 'style' | 'classDef';
  source: string;
  control: string;
  refused: string;
}> = [
  {
    name: 'stateDiagram-v2 style',
    origin: 'style',
    source: 'stateDiagram-v2\n  A --> B\n  style A rx:var(--_r)',
    control: 'stateDiagram-v2\n  A --> B',
    refused: 'rx: var(--_r)',
  },
  {
    name: 'stateDiagram-v2 style, the property laundered by pele’s writer',
    origin: 'style',
    source: 'stateDiagram-v2\n  A --> B\n  style A RX:var(--_r)',
    control: 'stateDiagram-v2\n  A --> B',
    refused: 'RX: var(--_r)',
  },
  {
    name: 'stateDiagram-v2 style, whitespace laundered by pele’s writer',
    origin: 'style',
    source: 'stateDiagram-v2\n  A --> B\n  style A rx : var(--_r)',
    control: 'stateDiagram-v2\n  A --> B',
    refused: 'rx: var(--_r)',
  },
  {
    name: 'stateDiagram-v2 classDef',
    origin: 'classDef',
    source: 'stateDiagram-v2\n  A --> B\n  classDef red rx:var(--_r)\n  class A red',
    control: 'stateDiagram-v2\n  A --> B',
    refused: 'rx: var(--_r)',
  },
  {
    name: 'classDiagram style',
    origin: 'style',
    source: 'classDiagram\n  class Artifact { +slug }\n  Artifact <|-- Note\n  style Artifact rx:var(--_r)',
    control: 'classDiagram\n  class Artifact { +slug }\n  Artifact <|-- Note',
    refused: 'rx: var(--_r)',
  },
  {
    name: 'block style',
    origin: 'style',
    source: 'block-beta\n  columns 2\n  A B\n  style A rx:var(--_r)',
    control: 'block-beta\n  columns 2\n  A B',
    refused: 'rx: var(--_r)',
  },
  {
    name: 'block classDef',
    origin: 'classDef',
    source: 'block-beta\n  columns 2\n  A B\n  classDef red rx:var(--_r)\n  class A red',
    control: 'block-beta\n  columns 2\n  A B',
    refused: 'rx: var(--_r)',
  },
  {
    name: 'block style on a nested composite’s child (r8)',
    origin: 'style',
    source: 'block-beta\n  columns 1\n  block:outer\n    A\n  end\n  style A rx:var(--_r)',
    control: 'block-beta\n  columns 1\n  block:outer\n    A\n  end',
    refused: 'rx: var(--_r)',
  },
  {
    name: 'usecase style',
    origin: 'style',
    source: 'usecase-beta\na\n  style a rx:var(--_r)',
    control: 'usecase-beta\na',
    refused: 'rx: var(--_r)',
  },
  {
    name: 'usecase classDef',
    origin: 'classDef',
    source: 'usecase-beta\na\n  classDef red rx:var(--_r)\n  class a red',
    control: 'usecase-beta\na',
    refused: 'rx: var(--_r)',
  },
];

/**
 * Every declaration the raw renderer wrote into a *non-root* element’s `style`,
 * in document order — the root block is whole-attribute evidence and belongs to
 * the fixed-set row, which distinguishes the two kinds by position.
 */
function elementDeclarations(source: string): string[] {
  return inspect(renderPele(source, { idPrefix: 'collision', links: false, images: false }).svg)
    .elements.slice(1)
    .flatMap(({ attributes }) => (attributes['style'] === undefined ? [] : declarationsOf(attributes['style'])));
}

test.each(COLLIDING_DECLARATIONS)(
  'Pele refuses the authored fixed-set collision: $name',
  async ({ origin, source, control, refused }) => {
    const member = 'rx: var(--_r)';
    const arrived = elementDeclarations(source).filter((declaration) => declaration === member);
    const own = elementDeclarations(control).filter((declaration) => declaration === member);
    assert.ok(
      arrived.length > own.length,
      'the raw render no longer forwards the authored rounding declaration, so the row would pass vacuously',
    );
    await expectAuthorRefused(source, refused, origin);
  },
);

/**
 * The two forms the element set accepts besides the rounding, each with the
 * same authored-collision row: widening the strip set cannot be what makes an
 * author declaration render, because the model check refuses it first.
 *
 * The underline arrives intact through a flowchart `style` directive (measured
 * 2026-11-16; the fixed-set row's member). The clamp's spelling carries a comma
 * and the faces handle it differently, measured one by one (2026-11-16, r9):
 * a `state` or `block` `style` face forwards the truncated `rx:min(var(--_r)`
 * into the raw render; a flowchart `style` never carries it — Pele's parser
 * rejects the function value at its own parse; a treemap `classDef` splits at
 * an unescaped comma (applied, the element receives the truncated fragment;
 * unused, nothing), while an escaped `\,` is restored by its parser — the
 * applied escaped form forwards the clamp intact into the raw render (the
 * applied `classDef` row below), the unused one writes nothing (the unused
 * `classDef` row below, r8's accepted-source finding). Both rows pin the same
 * line: the model check is what refuses an author clamp the element set grew
 * its second acceptance rule for — the applied one reaches the output, and the
 * unused one cannot.
 */
test('Pele refuses an authored underline the element set now accepts as pele’s static member', async () => {
  const source = 'flowchart TD\n  A[Reader] --> B[Site]\n  style A text-decoration:underline';
  const control = 'flowchart TD\n  A[Reader] --> B[Site]';
  const member = 'text-decoration: underline';
  const arrived = elementDeclarations(source).filter((declaration) => declaration === member);
  const own = elementDeclarations(control).filter((declaration) => declaration === member);
  assert.equal(own.length, 0, 'the directive-free control carries the declaration this row refuses');
  assert.ok(arrived.length > 0, 'the raw render no longer forwards the authored underline, so the row would pass vacuously');
  await expectAuthorRefused(source, 'text-decoration: underline', 'style');
});

test('Pele refuses an authored clamp an unused classDef retains, which the output never carries', async () => {
  // The visible-clamp geometry is the control: its own cell is small enough that
  // the *renderer* writes `min(var(--_r),0.5px)`, so one number is all that
  // separates a real renderer output from the authored spelling — which the
  // output must not contain, because the definition is never applied.
  const source = BRANCH_FIXTURES['treemapClampVisible']! + '  classDef red rx:min(var(--_r),0px)';
  const model = parsePele(source);
  if (model.type !== 'treemap') throw new Error('the fixture is no longer a treemap source');
  // The unescaped comma splits this treemap definition — the escaped `\,` the
  // applied row below measures is the spelling the parser restores — and the
  // model keeps the two fragments.
  assert.deepEqual([...model.classes], [['red', ['rx:min(var(--_r)', '0px)']]],
    'the model no longer retains the definition this row refuses');
  const declarations = elementDeclarations(source);
  assert.ok(declarations.includes('rx: min(var(--_r),0.5px)'),
    'the fixture no longer renders the cell whose own clamp this row controls against');
  assert.ok(!declarations.includes('rx: min(var(--_r),0px)'),
    'the fixture started forwarding the authored definition, so it no longer measures the case the output cannot see');
  await expectAuthorRefused(source, 'rx: min(var(--_r), 0px)', 'classDef');
});

test('Pele refuses an authored clamp an applied treemap classDef forwards intact', async () => {
  // The escaped comma is the treemap face the parser restores, and with the
  // definition applied the authored clamp reaches the raw render whole
  // (measured 2026-11-16: the cell carries its own renderer clamp and the
  // authored declaration behind it). `3.99` is a canonical hundredth the
  // renderer's quarter-step clamp cannot print — the same source without `:::`
  // prints `0px` for this cell — so the declaration read below can only be the
  // author's.
  const source = 'treemap-beta\n  "A": 1:::red\n  "B": 100000\n  classDef red rx:min(var(--_r)\\,3.99px)';
  const model = parsePele(source);
  if (model.type !== 'treemap') throw new Error('the fixture is no longer a treemap source');
  assert.deepEqual([...model.classes], [['red', ['rx:min(var(--_r),3.99px)']]],
    'the parser no longer restores the escaped comma this row measures');
  assert.ok(
    elementDeclarations(source).includes('rx: min(var(--_r),3.99px)'),
    'the raw render no longer forwards the authored clamp intact, so the row would pass vacuously',
  );
  const unapplied = elementDeclarations(source.replace(':::red', ''));
  assert.ok(unapplied.includes('rx: min(var(--_r),0px)'),
    'the fixture no longer renders the cell clamp the authored spelling is told apart from');
  assert.ok(!unapplied.includes('rx: min(var(--_r),3.99px)'),
    'the definition reaches the raw render without being applied, so the row would measure the wrong face');
  await expectAuthorRefused(source, 'rx: min(var(--_r),3.99px)', 'classDef');
});

/**
 * Quadrant definitions: the r8 gap was that `authorDirectives` had no
 * `quadrantChart` case at all, so a definition the *renderer never writes*
 * passed. This parser refuses `style`, `class` and `linkStyle`, so the two
 * faces an author really has are the unused definition and the point class
 * — and a point's styles are parsed into typed fields, so the definition's
 * `color:` reaches the output as a circle's `fill:`.
 */
test('Pele refuses an unused quadrant classDef, which the output never carries', async () => {
  const source = 'quadrantChart\n  A: [0.3, 0.6]\n  classDef red color:#ff0000';
  const model = parsePele(source);
  if (model.type !== 'quadrantChart') throw new Error('the fixture is no longer a quadrant source');
  assert.deepEqual([...model.classes], [['red', { color: '#ff0000' }]],
    'the model no longer retains the definition this row refuses');
  assert.deepEqual(
    elementDeclarations(source).filter((declaration) => declaration !== 'rx: var(--_r)'), [],
    'the fixture started forwarding the declaration, so it no longer measures the case the output cannot see',
  );
  await expectAuthorRefused(source, 'color: #ff0000', 'classDef');
});

test('Pele refuses a quadrant classDef applied to a point, naming the definition it compiled from', async () => {
  const source = 'quadrantChart\n  A:::red: [0.3, 0.6]\n  classDef red color:#ff0000';
  assert.ok(
    elementDeclarations(source).includes('fill: #ff0000'),
    'the raw render no longer compiles the definition onto the point, so the row would pass vacuously',
  );
  await expectAuthorRefused(source, 'color: #ff0000', 'classDef');
});

test('Pele refuses the quadrant properties its parser validates one by one', async () => {
  const source = 'quadrantChart\n  A: [0.3, 0.6]\n  classDef red radius:5,stroke-color:#00ff00,stroke-width:2px';
  const model = parsePele(source);
  if (model.type !== 'quadrantChart') throw new Error('the fixture is no longer a quadrant source');
  assert.deepEqual([...model.classes], [['red', { radius: 5, strokeColor: '#00ff00', strokeWidth: '2px' }]],
    'the model no longer retains the properties this row refuses, so the row would pass vacuously');
  await expectAuthorRefused(source, 'radius: 5, stroke-color: #00ff00, stroke-width: 2px', 'classDef');
});

/**
 * Provenance on a declaration Pele *copies*: a `classDef` is kept in the
 * definition map and compiled into a node's own style array, and the r8
 * finding was that the copy was read first and reported as an authored
 * `style` — the directive that actually carried it is `classDef`. Both models
 * with a compiled copy are pinned here; `classDiagram` tags every new class
 * `default` at creation, and the requirement parser compiles an applied class
 * into `cssStyles`.
 */
test.each([
  ['a class tagged default at creation',
    'classDiagram\n  class A\n  classDef default fill:#ff0000'],
  ['a requirement’s applied class',
    'requirementDiagram\n  requirement test_req {\n  id: 1\n  text: privacy\n  risk: high\n  verifymethod: test\n  }\n'
    + '  classDef red fill:#ff0000\n  class test_req red'],
])('Pele reports the copied classDef as the classDef directive that carried it: %s', async (_name, source) => {
  assert.ok(
    elementDeclarations(source).includes('fill: #ff0000'),
    'the raw render no longer compiles the definition into the node, so the row would pass vacuously',
  );
  await expectAuthorRefused(source, 'fill: #ff0000', 'classDef');
});

test('Pele refuses an author theme, which writes --pele-series-* into the root block', async () => {
  const source = '%%{init: {"themeVariables": {"pie1": "#ff0000"}}}%%\npie title Sources\n  "Notes" : 45';
  const failure = await refuse(source);
  assert.ok(failure.message.includes('--pele-series-1: #ff0000'),
    `the root refusal does not name the declaration the theme wrote: ${failure.message}`);
  assert.ok(failure.message.includes('root style declaration'),
    `the root refusal does not say what it is refusing: ${failure.message}`);
  assert.ok(failure.message.includes('remove the theme directive'),
    `the root refusal names no author remedy for the theme: ${failure.message}`);
  assert.ok(failure.message.includes("DIAGRAM_ENGINE = 'mermaid'"),
    `the root refusal names no engine remedy: ${failure.message}`);
});

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
  // Decision C's two refusals, reached through a renderer this suite controls:
  // a declaration in an element's own `style` attribute, and a root block that
  // drifts from the measured fixed set — by a property and by a value.
  ['element style declaration', `${SVG_OPEN}<path style="fill:red" d="M0 0L1 1"/></svg>`],
  ['unknown root declaration', `${SVG_OPEN.replace('>', ' style="color:red">')}<path d="M0 0L1 1"/></svg>`],
  ['fixed declaration with another value', `${SVG_OPEN.replace('>', ' style="--_bg:var(--not-pele-bg)">')}<path d="M0 0L1 1"/></svg>`],
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
 * for the four rows that need a browser.
 *
 * `style-src 'self'` is the policy the build-time row ships, so anything
 * measuring that row's cascade has to measure it under that policy — see the
 * token row below for what it blocks.
 */
async function openDiagramPage(markup: string) {
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
      const policy = "default-src 'none'; style-src 'self'";
      await route.fulfill({
        contentType: 'text/html',
        headers: { 'content-security-policy': policy },
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
 * The r8 carriers under the shipped policy, because neither can be observed by
 * a build-time assertion: the strip removed declarations the build-time CSP
 * never permits, and what replaces them has to resolve to what it replaced.
 * Each measurement is against a `setProperty` probe of the declaration form
 * itself — the same instrument the rounding row above uses, and for the same
 * reason — and the clamp is compared against `--_r` as well, so a carrier that
 * dropped the clamp and fell back to the token cannot pass.
 */
test('the clamp and member-underline carriers resolve under the build-time policy', async () => {
  selection.engine = 'pele';
  const { html } = await renderMarkdown(
    '```mermaid\n' + BRANCH_FIXTURES['classStaticMember']! + '\n```\n\n' +
    '```mermaid\n' + BRANCH_FIXTURES['treemapClampVisible']! + '\n```\n',
  );
  const { browser, page } = await openDiagramPage(html);
  try {
    const measured = await page.evaluate(() => {
      const svg = document.querySelector('svg.pele');
      const member = document.querySelector('svg.pele .pele-static');
      const clamped = [...document.querySelectorAll('svg.pele rect[rx]')]
        .find((rect) => rect.getAttribute('rx')?.startsWith('min(var(--_r),'));
      const rounded = document.querySelector('svg.pele rect.pele-rounded');
      if (svg === null || member === null || clamped === undefined || rounded === null) {
        throw new Error('the fixtures no longer render the elements this row measures');
      }
      const probeRx = (value: string): string => {
        const probe = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        probe.style.setProperty('rx', value);
        svg.append(probe);
        const computed = getComputedStyle(probe).rx;
        probe.remove();
        return computed;
      };
      const underlineProbe = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      underlineProbe.style.setProperty('text-decoration', 'underline');
      svg.append(underlineProbe);
      const probeUnderline = getComputedStyle(underlineProbe).textDecorationLine;
      underlineProbe.remove();
      const clamp = clamped.getAttribute('rx')!;
      return {
        memberUnderline: getComputedStyle(member).textDecorationLine,
        probeUnderline,
        clamp,
        clampedRx: getComputedStyle(clamped).rx,
        clampProbe: probeRx(clamp),
        roundedRx: getComputedStyle(rounded).rx,
        roundProbe: probeRx('var(--_r)'),
      };
    });
    assert.equal(measured.memberUnderline, measured.probeUnderline, 'the member underline no longer resolves under the policy');
    assert.equal(measured.memberUnderline, 'underline', 'the member underline is not the decoration it carries');
    assert.equal(measured.roundedRx, measured.roundProbe, 'the rounding class the clamp is compared against no longer resolves');
    assert.equal(measured.clampedRx, measured.clampProbe, `the carried clamp ${measured.clamp} differs from its declaration form`);
    assert.notEqual(measured.clampedRx, measured.roundedRx,
      'the fixture no longer clamps below --_r, so the row would pass with the clamp lost');
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
 * Placed after every row that compares a module instance against a held
 * binding, because `vi.resetModules()` invalidates the module instances those
 * rows hold: `DiagramError` is compared by `instanceof`, and after a reset they
 * would compare a fresh class against the binding this file imported before it.
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
 * P1 design §5(5): with the selected engine the seam is a pass-through, byte
 * for byte. The existing two-engine row compares the dispatcher against itself,
 * so it cannot see a dispatcher that post-processes its engine's output — which
 * is exactly what this pair binds.
 *
 * **The pair is bound against the engine the tree selects** (`pele` since the
 * engine switch). A fresh child cannot see this file's `vi.mock` of
 * `diagram-mode.ts` and there is no runtime override, so the child renders the
 * configured engine, whatever that is; the pair follows the constant instead of
 * naming it. The Mermaid half of §5(5) is bound separately by the row below,
 * in-process.
 *
 * Two fresh processes, not one, for the reason `tests/support/render-diagram.ts`
 * gives: Mermaid seeds gitgraph's hashes from `Math.random` and keeps
 * module-level counters, so a same-process pair shares state the design's claim
 * is not about. It is also the evidence that moving `DiagramError` out of
 * `mermaid-render.ts` did not touch what the selected engine’s row renders.
 */
test('the selected engine reaches the same bytes through the dispatcher and its adapter', async () => {
  const realEngine = (await vi.importActual<typeof DiagramConfiguration>('../src/lib/diagram-mode.ts')).DIAGRAM_ENGINE;
  const adapter = { mermaid: 'src/lib/mermaid-render.ts', pele: 'src/lib/pele-render.ts' }[realEngine];
  const source = DIAGRAMS['flowchart']!;
  const dispatched = runInChild(undefined, source, { hash: true });
  const direct = runInChild(adapter, source, { hash: true });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(dispatched.stdout, /^[a-f0-9]{64}$/, 'the child no longer prints a digest');
  assert.equal(
    dispatched.stdout,
    direct.stdout,
    `the dispatcher no longer passes ${realEngine}’s output through unchanged`,
  );
});

/**
 * The same pass-through, for the engine this tree does not select, in-process.
 *
 * No fresh child can run the dispatcher with Mermaid while `pele` is the
 * constant, so the two paths are called back to back on the same source with
 * the same id — measured stable for these two sources (2026-11-16; gitgraph's
 * `Math.random`-seeded hashes are the reason the fresh-process pair above uses
 * a fresh process, and this row deliberately uses sources Mermaid renders
 * deterministically for shared state). A dispatcher that post-processes
 * Mermaid's bytes fails it: both sides start from the same state, and the only
 * difference between them is which module did the rendering.
 */
test('with the Mermaid engine selected the dispatcher passes its adapter through unchanged', async () => {
  // Deferred like every adapter and dispatcher import in this file (see the
  // module header): the mock's `DIAGRAM_ENGINE` getter is read at call time, and
  // `vi.importActual` is the only way to read the real constant beside it.
  selection.engine = 'mermaid';
  const { renderDiagram: direct } = await import('../src/lib/mermaid-render.ts');
  const { renderDiagram: dispatched } = await import('../src/lib/diagram-engine.ts');
  for (const source of [DIAGRAMS['flowchart']!, DIAGRAMS['sequence']!]) {
    const directBytes = await direct(source, 'pass-through', 'Pass-through diagram');
    const dispatchedBytes = await dispatched(source, 'pass-through', 'Pass-through diagram');
    assert.equal(dispatchedBytes, directBytes, `${source.split('\n')[0]}: the dispatcher changed Mermaid's output`);
  }
});
