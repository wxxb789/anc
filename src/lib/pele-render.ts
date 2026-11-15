/**
 * Pele's SVG, reduced to what a build-time page may ship.
 *
 * Owner decision C, 2026-11-15: this adapter converts **no author
 * declarations**. Pele writes presentation in three places and the sanitizer
 * has one disposition for each:
 *
 * 1. **The root `style` block** — Pele's palette, its measurement font and the
 *    reset of the inheritable text properties, as one attribute on `<svg>`.
 *    `src/styles/diagram.css` re-creates it under `.diagram svg.pele` and
 *    `.diagram svg`; {@link ROOT_STYLE_DECLARATIONS} is the declaration set
 *    Pele 1.13.0 was measured to write, and a root declaration outside it stops
 *    the build by name instead of disappearing.
 * 2. **`rx: var(--_r)`** — Pele's own corner rounding, the one declaration it
 *    writes into a non-root `style` attribute
 *    ({@link ELEMENT_STYLE_DECLARATIONS}). It is stripped and the element is
 *    marked `pele-rounded`, which `diagram.css` supplies the same
 *    `rx: var(--_r)` for. The class is a carrier choice, not a necessity —
 *    measured in Chromium 158, `rx="var(--_r)"` as a presentation attribute
 *    resolves to the same length — but the class names the site's radius token
 *    once instead of re-emitting the reference on every element.
 * 3. **Everything else** — an author declaration (`style A …`, `classDef`,
 *    `linkStyle`), which Pele carries into an element's `style` attribute, and
 *    an author theme (`%%{init: …}%%`), which adds `--pele-series-*`
 *    declarations to the root block. Refused with `DiagramError` naming the
 *    declaration, the directive that carried it and the remedy. No conversion,
 *    no silent drop.
 *
 * An author declaration is refused **from the parsed model**, not from the
 * output it produced: Pele's writer normalises the text it writes — measured
 * 2026-11-15, an authored `rx : var(--_r)` or `RX:var(--_r)` reaches the
 * element as `rx:var(--_r)`, the spelling of Pele's own rounding — so a
 * declaration read back from the output can be spelled like the fixed set
 * without being Pele's ({@link ELEMENT_STYLE_DECLARATIONS} documents that
 * measurement). The model still carries the author's own text;
 * {@link authorDirectives} reads it and the refusal quotes it. The output-level
 * checks stay as the backstop for a declaration that arrives from somewhere the
 * model does not report — the author theme is the one measured case.
 *
 * Why the conversion was dropped rather than fixed: the adapter used to project
 * each author declaration onto the presentation attribute of the same name,
 * which required an oracle for "does the renderer keep this value in the
 * attribute form?" — the parser's grammar first, then measured tables for the
 * cells the grammar gets wrong, walked by an arithmetic evaluator for function
 * values. Six review rounds (r2–r6, 2026-11-15, cross-family) each found
 * further cells that oracle got wrong, in both directions, and every wrong cell
 * silently moved a rendering. The measured cost of closing the face instead:
 * none of the three real corpus diagrams (`docs/core-design/architecture.md`,
 * `example/guides/feature-showcase.md`,
 * `tests/fixtures/markdown/kitchen-sink.md`) uses
 * `style`/`classDef`/`linkStyle`, so refusing them has no observable effect on
 * the site this build ships. A refusal names the declaration and the remedy; a
 * conversion guessed at the rendering.
 */

import { parse, walk } from 'css-tree';
import type { CssNode } from 'css-tree';
import { parse as parseDiagram, render } from 'pele';
import type { ParsedDiagramModel, StateModel } from 'pele';
import { SaxesParser } from 'saxes';
import { DiagramError } from './diagram-mode.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const ELEMENTS: Readonly<Record<string, true>> = {
  svg: true, g: true, defs: true, title: true, desc: true, path: true, line: true, polyline: true,
  polygon: true, rect: true, circle: true, ellipse: true, text: true, tspan: true,
  linearGradient: true, radialGradient: true, stop: true, clipPath: true, marker: true,
};
const GRAPHICS: Readonly<Record<string, true>> = {
  path: true, line: true, polyline: true, polygon: true, rect: true, circle: true, ellipse: true, text: true,
};
/**
 * The attributes a build-time page may carry, keyed by qualified name.
 *
 * This is an emission allowlist, not a property table: anything the renderer
 * emits that is not here is dropped, and the attributes that could execute or
 * fetch — `on*`, `href`, `src` — are refused above it rather than filtered
 * through it. It survives decision C unchanged because it never decided how a
 * CSS value renders; it decides which of the renderer's own attributes a page
 * may keep.
 */
const SAFE_ATTRIBUTES: Readonly<Record<string, true>> = {
  id: true, class: true, role: true, 'aria-label': true, 'aria-labelledby': true,
  'aria-describedby': true, 'aria-roledescription': true, 'data-id': true, 'data-icon': true,
  viewBox: true, width: true, height: true, preserveAspectRatio: true,
  x: true, y: true, x1: true, y1: true, x2: true, y2: true, cx: true, cy: true,
  r: true, rx: true, ry: true, dx: true, dy: true, d: true, points: true, transform: true,
  fill: true, 'fill-opacity': true, 'fill-rule': true, stroke: true, 'stroke-width': true,
  'stroke-opacity': true, 'stroke-dasharray': true, 'stroke-dashoffset': true,
  'stroke-linecap': true, 'stroke-linejoin': true, opacity: true, 'font-size': true,
  'font-family': true, 'font-weight': true, 'font-style': true, 'text-anchor': true,
  'text-decoration': true, 'dominant-baseline': true, 'clip-path': true, 'clip-rule': true,
  'baseline-shift': true, 'letter-spacing': true, 'word-spacing': true,
  gradientUnits: true, gradientTransform: true, offset: true, 'stop-color': true,
  'stop-opacity': true, 'marker-start': true, 'marker-mid': true, 'marker-end': true,
  markerWidth: true, markerHeight: true, markerUnits: true, refX: true, refY: true, orient: true,
};
/**
 * The attributes whose value the renderer resolves as a resource reference:
 * paint servers, clip paths and markers. Their values are the ones
 * {@link inspectResources} walks.
 *
 * Scoped by measurement rather than by a value rule. Measured 2026-11-15: a
 * value-context walk of *every* attribute value of the 23-type matrix and the
 * corpus fails on the renderer's own `xmlns="http://www.w3.org/2000/svg"` and
 * `data-id="A->B"` (css-tree cannot parse `http://…` or a bare `->` as a CSS
 * value), so the guard's scope cannot be widened to all attributes without
 * turning real output into errors; it is the family whose value *is* a URL when
 * it is anything.
 */
const RESOURCE_ATTRIBUTES: Readonly<Record<string, true>> = {
  fill: true, stroke: true, 'stop-color': true, 'clip-path': true,
  'marker-start': true, 'marker-mid': true, 'marker-end': true,
};

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;',
};

/**
 * Every declaration Pele 1.13.0 was measured to write into the root `style`
 * block, as `property: value` with the value spelled exactly as the renderer
 * writes it, in the order the renderer writes them.
 *
 * Measured 2026-11-15 by rendering the 23-type matrix of
 * `tests/diagram-engine.test.ts`, the three real corpus diagrams
 * (`docs/core-design/architecture.md`, `example/guides/feature-showcase.md`,
 * `tests/fixtures/markdown/kitchen-sink.md`) and a bold-run probe through
 * `pele.render()` with the options this adapter pins, then reading every
 * `style` attribute with the same `css-tree` reader this file uses — so the
 * measurement and the gate cannot disagree about a value's spelling.
 *
 * The block is not one constant string. Read from Pele's own bundle, four
 * members — `--_r`, `--_tw`, `--_hw` and `--_w` — are appended only when the
 * rendered markup consumes them: Pele
 * matches `/var\(--_(r|tw|hw|w)\)/` over the body before it writes the root
 * block, so a source that rounds a corner carries `--_r`, one with a title or a
 * heading carries `--_tw`/`--_hw`, and one with a bold run carries `--_w`.
 * Measured over the 26 matrix-and-corpus sources: `--_r` in 19, `--_tw` in 7,
 * `--_hw` in 6, `--_w` in 0 — the bold probe is what exercises the last one,
 * and the gate carries the same probe for the same reason.
 *
 * Re-measure when `pele` in `package.json` moves. The equality half of the
 * fixed-set gate in `tests/diagram-engine.test.ts` fails on a member here that
 * the renders no longer produce, and a new member Pele starts writing stops the
 * build in this file by name instead of dropping the declaration.
 */
export const ROOT_STYLE_DECLARATIONS: readonly string[] = [
  'max-width: 100%',
  'height: auto',
  '--_bg: var(--pele-bg,#fff)',
  '--_fg: var(--pele-fg,#1f1f1f)',
  '--_m: var(--pele-muted,#6e6e6e)',
  '--_l: var(--pele-line,#1f1f1f)',
  '--_s: var(--pele-surface,#f3f3f3)',
  '--_a: var(--pele-surface-alt,#e6e6e6)',
  '--_b: var(--pele-border,#8a8a8a)',
  '--_c: var(--pele-accent,#5b7bd5)',
  'color: var(--_fg)',
  '--_r: var(--pele-radius,4px)',
  '--_tw: var(--pele-title-weight,bold)',
  '--_hw: var(--pele-heading-weight,bold)',
  '--_w: var(--pele-bold-weight,bold)',
  '--_fm: var(--pele-font-mono,monospace)',
  'font: 16px sans-serif',
  'letter-spacing: normal',
  'word-spacing: normal',
  'text-transform: none',
  'direction: ltr',
  'font-family: var(--pele-font,sans-serif)',
];

/**
 * Every declaration Pele 1.13.0 was measured to write into a non-root `style`
 * attribute: the rounding reference, prepended to the element's own style, and
 * nothing else. Measured the same way as {@link ROOT_STYLE_DECLARATIONS}, over
 * the same sources: 49 elements of 523 carried it, and no element carried
 * anything else.
 *
 * Membership is exact, down to the spelling of the value: `rx: var(--_r)` is
 * stripped, and `rx: 4` or `rx: var(--_R)` beside it is an author declaration
 * and is refused by the output check below. **That exactness is a spelling, not
 * a provenance** — measured 2026-11-15 (r7): Pele's writer lower-cases the
 * property and normalises `property: value`, so an authored `RX:var(--_r)`,
 * `Rx:var(--_r)`, `rx : var(--_r)` or `rx: var(--_r)` reaches the element as
 * this set's own text and was silently stripped. Provenance is decided before
 * the output — {@link authorDirectives} reads the directive out of the parsed
 * model, which still carries the author's spelling — so this set only ever
 * decides whether a declaration read from the output is Pele's own, and the
 * directive that would have made it the author's has already stopped the build.
 */
export const ELEMENT_STYLE_DECLARATIONS: readonly string[] = ['rx: var(--_r)'];

const ROOT_STYLE_SET: ReadonlySet<string> = new Set(ROOT_STYLE_DECLARATIONS);
const ELEMENT_STYLE_SET: ReadonlySet<string> = new Set(ELEMENT_STYLE_DECLARATIONS);

/**
 * A `style` attribute's declarations, in the order they were written.
 *
 * The value is read as source, from the position the parser reports, rather
 * than rebuilt from the AST: the refusal quotes the author's own spelling
 * (`#fff`, `Georgia`, `0.5`) character for character, and `css-tree`'s declared
 * slice here — `src/types/css-tree.d.ts` — deliberately has no generator.
 *
 * A node the parser cannot read as a declaration is an error, not a skip: this
 * input reaches the build from a renderer, and a half-parsed declaration list
 * is how a dropped value hides.
 */
function styleDeclarations(style: string): { property: string; value: string }[] {
  const declarations: { property: string; value: string }[] = [];
  const list = parse(style, { context: 'declarationList', positions: true });
  for (const node of list.children?.toArray() ?? []) {
    if (node.type !== 'Declaration') {
      throw new Error(`the renderer emitted an unreadable style attribute: ${style.slice(0, 80)}`);
    }
    const property = node['property'];
    if (typeof property !== 'string' || property === '') {
      throw new Error(`the renderer emitted a style declaration with no property: ${style.slice(0, 80)}`);
    }
    if (node['important'] === true) {
      throw new Error(`the renderer emitted !important in a style attribute: ${property}`);
    }
    declarations.push({ property, value: sourceRangeOf(node['value'], style) });
  }
  return declarations;
}

/** One node's own text, from the offsets the parser reported for it. */
function sourceRangeOf(node: unknown, source: string): string {
  const loc = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)['loc'] : undefined;
  if (typeof loc !== 'object' || loc === null) throw new Error('the parser reported no source position');
  const offsets = loc as Record<string, unknown>;
  const start = offsets['start'];
  const end = offsets['end'];
  const from = typeof start === 'object' && start !== null ? (start as Record<string, unknown>)['offset'] : undefined;
  const to = typeof end === 'object' && end !== null ? (end as Record<string, unknown>)['offset'] : undefined;
  if (typeof from !== 'number' || typeof to !== 'number') throw new Error('the parser reported no source offset');
  return source.slice(from, to).trim();
}

/**
 * One author styling directive a parsed model retained, as the model keeps it.
 */
interface AuthorDirective {
  origin: 'style' | 'classDef' | 'linkStyle';
  /** The declaration text the model kept: `property:value` as the author wrote it, or the parser's own spelling. */
  declared: readonly string[];
}

/**
 * The fields every flowchart-shaped model keeps its author declarations in.
 *
 * `flowchart`, `flowchart-v2` and `swimlane` all parse to `type: 'flowchart'`
 * and `agentflow` to its own member (measured 2026-11-15), but the four fields
 * below are the same object shape in both, so one scan reads both.
 */
interface FlowchartShapedModel {
  readonly nodes: ReadonlyMap<string, { readonly styles: readonly string[] }>;
  readonly classes: ReadonlyMap<
    string,
    { readonly styles: readonly string[]; readonly textStyles?: readonly string[] }
  >;
  readonly edges: readonly { readonly style?: readonly string[] }[];
  readonly defaultEdgeStyle?: readonly string[];
}

/**
 * The author styling directives `pele.parse` retained from the source, in a
 * deterministic order, as the model spells them.
 *
 * This is the provenance half of decision C, and it exists because the
 * output-level half cannot have one: measured 2026-11-15, Pele's writer
 * normalises what it writes — an authored `RX:var(--_r)`, `Rx:var(--_r)` or
 * `rx : var(--_r)` lands in an element's `style` attribute as `rx:var(--_r)`,
 * the exact text of Pele's own rounding — so a declaration read back from the
 * output can be spelled like the fixed set without being Pele's. The parsed
 * model still carries the author's own text, and quoting it is what lets the
 * refusal name the declaration *and* the directive that carried it.
 *
 * Measured 2026-11-15, pele 1.13.0, one probe per registered type (33: the
 * `detectType` names, each given its own minimal source), the refusal rows'
 * three directive forms appended to it. The model types below retain the
 * directive in the fields read here. Every other type either rejects the line
 * at its own parser (pie, sequence, mindmap, timeline, quadrant, xychart,
 * sankey, packet, architecture, radar, c4, gitGraph, railroad, cynefin,
 * wardley, eventmodeling; a `var()` value in flowchart, er and requirement; the
 * `classDef` form in journey and gantt) or swallows it as content — and a
 * swallowed line is not a directive: the declaration the text resembles never
 * exists in the model (kanban keeps it as a section name, treeView and ishikawa
 * as a label, journey and gantt as a task, state and class as elements named
 * after the words). Re-measure when `pele` in `package.json` moves, exactly as
 * the fixed sets above are re-measured: the refusal is by name, never a silent
 * drop.
 */
function authorDirectives(model: ParsedDiagramModel): AuthorDirective[] {
  const directives: AuthorDirective[] = [];
  const record = (origin: AuthorDirective['origin'], declared: readonly string[] | undefined): void => {
    const kept = (declared ?? []).filter((declaration) => declaration.trim() !== '');
    if (kept.length > 0) directives.push({ origin, declared: kept });
  };
  const recordStyles = (
    origin: AuthorDirective['origin'],
    holder: { readonly styles: readonly string[]; readonly textStyles?: readonly string[] },
  ): void => {
    record(origin, holder.styles);
    record(origin, holder.textStyles);
  };
  switch (model.type) {
    case 'flowchart':
    case 'agentflow': {
      const shaped: FlowchartShapedModel = model;
      for (const node of shaped.nodes.values()) record('style', node.styles);
      for (const definition of shaped.classes.values()) recordStyles('classDef', definition);
      for (const edge of shaped.edges) record('linkStyle', edge.style);
      record('linkStyle', shaped.defaultEdgeStyle);
      break;
    }
    case 'state': {
      // `rootDoc`, not the compiled `states` map: the statement is the directive
      // as parsed, it survives inside a composite state's own `doc`, and the
      // node's compiled styles would have to be told apart from a classDef's by
      // field name alone (`cssStyles` vs `cssCompiledStyles`).
      const visit = (statements: readonly StateModel['rootDoc'][number][]): void => {
        for (const statement of statements) {
          if (typeof statement !== 'object' || statement === null) continue;
          if (statement.stmt === 'style') record('style', [statement.styleClass]);
          else if (statement.stmt === 'classDef') record('classDef', [statement.classes]);
          else if (statement.stmt === 'state' && statement.doc) visit(statement.doc);
        }
      };
      visit(model.rootDoc);
      break;
    }
    case 'class': {
      for (const node of model.classes.values()) record('style', node.styles);
      for (const definition of model.styleClasses.values()) recordStyles('classDef', definition);
      break;
    }
    case 'er': {
      for (const entity of model.entities.values()) record('style', entity.cssStyles);
      for (const subgraph of model.subgraphs) record('style', subgraph.cssStyles);
      for (const definition of model.classes.values()) recordStyles('classDef', definition);
      break;
    }
    case 'requirement': {
      for (const requirement of model.requirements.values()) record('style', requirement.cssStyles);
      for (const element of model.elements.values()) record('style', element.cssStyles);
      for (const definition of model.classes.values()) recordStyles('classDef', definition);
      break;
    }
    case 'block': {
      for (const block of model.blocks) record('style', block.styles);
      for (const definition of model.classes.values()) recordStyles('classDef', definition);
      break;
    }
    case 'usecase': {
      for (const actor of model.actors.values()) record('style', actor.styles);
      for (const useCase of model.useCases.values()) record('style', useCase.styles);
      for (const boundary of model.systemBoundaries.values()) record('style', boundary.styles);
      for (const relationship of model.relationships) record('style', relationship.styles);
      for (const jsonNode of model.jsonNodes.values()) record('style', jsonNode.styles);
      for (const definition of model.classDefs.values()) record('classDef', definition.styles);
      break;
    }
    case 'venn': {
      // The one model that keeps a declaration as a parsed pair rather than as
      // the author's text; the pair is re-joined into `property:value` and read
      // by the same reader as every other spelling.
      for (const styled of model.styles) {
        record('style', [...styled.styles].map(([property, value]) => `${property}:${value}`));
      }
      break;
    }
    case 'treemap': {
      for (const declared of model.classes.values()) record('classDef', declared);
      break;
    }
    default:
      break;
  }
  return directives;
}

/**
 * The declarations of one directive as the refusal quotes them: read with the
 * same `css-tree` reader the output branch uses, so the value keeps the
 * author's spelling (`#fff`, `Georgia`, `0.5`) under one `property: value`
 * join, and the two halves of the file cannot disagree about a declaration's
 * text. Text the reader cannot read as a declaration is quoted as the model
 * kept it rather than dropped.
 */
function declarationTexts(declared: readonly string[]): string {
  const texts: string[] = [];
  for (const declaration of declared) {
    let read: { property: string; value: string }[] = [];
    try {
      read = styleDeclarations(declaration);
    } catch {
      read = [];
    }
    if (read.length === 0) texts.push(declaration.trim());
    else for (const { property, value } of read) texts.push(`${property}: ${value}`);
  }
  return texts.join(', ');
}

/**
 * The refusal for a directive the parsed model reports, in the shape decision C
 * requires of every refusal: the declaration as written, the directive that
 * carried it, and the remedy. The output-level branch below carries the same
 * three, one distinction apart: it can name the directive family only, because
 * a declaration read back from the output no longer says which directive wrote
 * it.
 */
function authorRefusal(directive: AuthorDirective): string {
  return 'the pele engine does not support author declarations, but the source carries one: '
    + declarationTexts(directive.declared)
    + ` (an author '${directive.origin}' directive; this engine refuses every author 'style', 'classDef' or`
    + " 'linkStyle' declaration) — remove it, rewrite it with pele's native syntax, or set"
    + " DIAGRAM_ENGINE = 'mermaid'";
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"\t\n\r]/g, (character) => XML_ENTITIES[character]!);
}

/**
 * One walk over a value, with `css-tree`'s own parse: the AST for everything it
 * parses, plus the `Raw` nodes it keeps for text it cannot parse — a CSS
 * variable's fallback arrives that way, and a resource can hide inside it.
 */
function visitValue(value: string, visit: (node: CssNode) => void): void {
  walk(parse(value, { context: 'value' }), (node) => {
    visit(node);
    if (node.type === 'Raw') visitValue(node.value ?? '', visit);
  });
}

/**
 * An external resource anywhere in a value is refused, a paint property or not:
 * `url(#fragment)` is the renderer's own namespace and passes, anything else is
 * a fetch the page would make — including through an escape or a `var()`
 * fallback, which is why the walk parses rather than matches text.
 *
 * Pele's own value filter drops an author value carrying `url(`, so this guards
 * the attribute path — the renderer's direct output — rather than a declaration
 * the adapter would have converted; measured 2026-11-15, and the reason the
 * scope is {@link RESOURCE_ATTRIBUTES}.
 */
function inspectResources(value: string): void {
  visitValue(value, (node) => {
    if (node.type === 'Url' && !/^#[A-Za-z0-9_.:-]+$/.test(node.value ?? '')) {
      throw new Error(`the renderer emitted an external paint reference: url(${node.value ?? ''})`);
    }
  });
}

function sanitizeSvg(svg: string, accessibleName: string): string {
  const markup = svg.trim();
  if (markup === '') throw new Error('the renderer produced empty output');
  const output: string[] = [];
  let rootSeen = false;
  let hasGraphics = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('the renderer emitted a DOCTYPE'); });
  parser.on('processinginstruction', () => { throw new Error('the renderer emitted a processing instruction'); });
  parser.on('opentag', (tag) => {
    const isRoot = !rootSeen;
    if (tag.uri !== SVG_NAMESPACE || tag.prefix !== '' || ELEMENTS[tag.local] !== true) {
      throw new Error(`the renderer emitted an unsafe element: ${tag.name}`);
    }
    if (isRoot) {
      if (tag.local !== 'svg' || !tag.attributes['viewBox']) {
        throw new Error('the renderer produced no scalable <svg> element');
      }
      rootSeen = true;
    }
    if (GRAPHICS[tag.local] === true) hasGraphics = true;
    // Decision C, exactly: a declaration from the fixed set is stripped, and
    // anything else stops the build naming the property and the value. The root
    // block and the rounding reference are the two sets above; `rounded` marks
    // the elements whose `diagram.css` class carries the radius instead.
    let rounded = false;
    const style = tag.attributes['style']?.value ?? '';
    if (style !== '') {
      for (const { property, value } of styleDeclarations(style)) {
        const declaration = `${property}: ${value}`;
        if (isRoot) {
          if (ROOT_STYLE_SET.has(declaration)) continue;
          throw new Error(
            'the renderer emitted a root style declaration this build does not recognise: ' + declaration
            + ' (the fixed set is measured from pele 1.13.0 without author directives — re-measure it in this file'
            + ' after a pele upgrade; an author %%{init}%% theme adds --pele-series-* declarations here)'
            + " — remove the theme directive or set DIAGRAM_ENGINE = 'mermaid'",
          );
        }
        if (!ELEMENT_STYLE_SET.has(declaration)) {
          throw new Error(
            'the pele engine does not support author declarations, but one reached the output: ' + declaration
            + " (an author 'style', 'classDef' or 'linkStyle' directive; this engine strips only pele's own fixed"
            + " inline set) — remove it, rewrite it with pele's native syntax, or set DIAGRAM_ENGINE = 'mermaid'",
          );
        }
        if (declaration === 'rx: var(--_r)') rounded = true;
      }
    }
    let hasClass = false;
    output.push(`<${tag.local}`);
    for (const name in tag.attributes) {
      const attribute = tag.attributes[name]!;
      if (/^on/i.test(attribute.local) || /^(?:href|src)$/i.test(attribute.local)) {
        throw new Error(`the renderer emitted an unsafe attribute: ${name}`);
      }
      if (attribute.local.toLowerCase() === 'style') continue;
      if (name === 'xmlns' && attribute.value === SVG_NAMESPACE) {
        output.push(` xmlns="${SVG_NAMESPACE}"`);
        continue;
      }
      if (attribute.uri === XML_NAMESPACE && attribute.local === 'space') {
        output.push(` xml:space="${escapeXml(attribute.value)}"`);
        continue;
      }
      if (attribute.prefix !== '' || SAFE_ATTRIBUTES[name] !== true) continue;
      // Pele's root role and accessible-name attributes are replaced by the site's caption.
      if (isRoot && ['role', 'aria-label', 'aria-labelledby'].includes(name)) continue;
      if (RESOURCE_ATTRIBUTES[name] === true) inspectResources(attribute.value);
      const value = name === 'class' && rounded ? `${attribute.value} pele-rounded` : attribute.value;
      if (name === 'class') hasClass = true;
      output.push(` ${name}="${escapeXml(value)}"`);
    }
    if (rounded && !hasClass) output.push(' class="pele-rounded"');
    if (isRoot) {
      output.push(` role="graphics-document" aria-label="${escapeXml(accessibleName)}" focusable="false"`);
    }
    output.push('>');
  });
  parser.on('closetag', (tag) => { output.push(`</${tag.local}>`); });
  const text = (value: string): void => { output.push(escapeXml(value)); };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.write(markup).close();
  if (!rootSeen || !hasGraphics) throw new Error('the renderer produced an empty SVG');
  return output.join('');
}

export async function renderDiagram(source: string, diagramId: string, accessibleName: string): Promise<string> {
  try {
    // The model is built once and used twice: the provenance check reads it, and
    // the same model renders, so what the check quoted is what the renderer saw.
    // `render(model, options)` is byte-identical to `render(source, options)`
    // (measured 2026-11-15); the row named "Pele renders a parsed model to the
    // same bytes as its own source" in `tests/diagram-engine.test.ts` holds both
    // to those bytes over every census source on every run.
    const model = parseDiagram(source);
    const [directive] = authorDirectives(model);
    if (directive !== undefined) throw new Error(authorRefusal(directive));
    const { svg } = render(model, { idPrefix: diagramId, links: false, images: false, now: 0 });
    return sanitizeSvg(svg, accessibleName);
  } catch (error) {
    throw new DiagramError(source, error instanceof Error ? error.message.split('\n')[0]! : String(error));
  }
}
