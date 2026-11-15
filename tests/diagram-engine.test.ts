import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SaxesParser } from 'saxes';
import { afterEach, test, vi } from 'vitest';
import type * as DiagramConfiguration from '../src/lib/diagram-mode.ts';
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
  assert.equal(titled.root['aria-labelledby'], undefined, 'an authored title overrides the requested accessible name');
  assert.match(titled.text, /Authored title/);
});

test('Pele is byte-deterministic across fresh Node processes', () => {
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

test('Pele preserves subscript, superscript and bold labels under external CSS', async () => {
  selection.engine = 'pele';
  const { html } = await renderMarkdown(
    '```mermaid\nflowchart TD\n A["H<sub>2</sub>O"] --> B["x<sup>3</sup> and <b>Bold</b> plus <strong>Strong</strong>"]\n```\n',
  );
  const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
  assert.ok(svg);
  assertClean(svg);
  const styles: Readonly<Record<string, string>> = {
    '/tokens.css': readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'),
    '/diagram.css': readFileSync(new URL('../src/styles/diagram.css', import.meta.url), 'utf8'),
  };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://diagram.test/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/') {
        await route.fulfill({
          contentType: 'text/html',
          headers: { 'content-security-policy': "default-src 'none'; style-src 'self'" },
          body: '<!doctype html><html><head><link rel="stylesheet" href="/tokens.css">' +
            `<link rel="stylesheet" href="/diagram.css"></head><body>${html}</body></html>`,
        });
        return;
      }
      const css = styles[pathname];
      if (css !== undefined) await route.fulfill({ contentType: 'text/css', body: css });
      else await route.abort();
    });
    await page.goto('https://diagram.test/');
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
