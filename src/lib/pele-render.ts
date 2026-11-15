/**
 * Pele's SVG, reduced to what a build-time page may ship.
 *
 * Pele writes presentation in three places and the sanitizer has a disposition
 * for each, because dropping any of them silently is what made a box measured
 * at 40 px render its label at 16 px:
 *
 * 1. **A `style` declaration on a non-root element** — an author's `style A
 *    font-size:40px`, or the `rx`/paint Pele derives from one. It becomes the
 *    presentation attribute of the same name, which carries the same value in
 *    the same cascade position — for a value the renderer keeps, which is the
 *    whole of the rule below. A declaration the browser drops at parse time is
 *    not a declaration, so projecting it would not replace the attribute it
 *    displaces but delete it: the emitted attribute carries the same rejected
 *    value and is dropped too, while the raw render still has the attribute the
 *    declaration never won. The verdict is therefore measured rather than
 *    grammatical: the parser's grammar decides the values that need no further
 *    reading, {@link NON_NEGATIVE} and {@link RENDERER_KEPT_NUMBER} record the
 *    cells where a measurement showed the grammar's verdict is not the
 *    renderer's, and a value outside both is refused loudly rather than
 *    guessed. Where the element already has that attribute, the declaration
 *    wins and the attribute is replaced: a `style` attribute outranks a
 *    presentation attribute in CSS, so that is the rendering Pele produced, not
 *    a preference.
 * 2. **`rx: var(--_r)`** — the one declaration a presentation attribute cannot
 *    take, because `var()` does not resolve there. It stays a class, with the
 *    value supplied by `.diagram svg.pele .pele-rounded` in `diagram.css`.
 * 3. **The root `style` block** — Pele's palette, its measurement font and the
 *    reset of the inheritable text properties, as one attribute on `<svg>`.
 *    `src/styles/diagram.css` re-creates it under `.diagram svg.pele` and
 *    `.diagram svg`; {@link ROOT_STYLE_RULES} is that list, so a declaration
 *    added upstream stops the build instead of disappearing.
 */

import { lexer, parse, walk } from 'css-tree';
import { render } from 'pele';
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
const ATTRIBUTES: Readonly<Record<string, true>> = {
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
const PAINT_ATTRIBUTES: Readonly<Record<string, true>> = {
  fill: true, stroke: true, 'stop-color': true, 'clip-path': true,
  'marker-start': true, 'marker-mid': true, 'marker-end': true,
};
const COLOUR_FUNCTIONS: Readonly<Record<string, true>> = {
  var: true, 'light-dark': true, 'color-mix': true, rgb: true, rgba: true, hsl: true, hsla: true,
};

/**
 * The properties whose declared values the renderer requires to be non-negative
 * while the parser's grammar for them is sign-agnostic: measured in Chromium
 * 158, a negative is dropped from a *declaration* for every one of these
 * (`stroke-width:-2`, `stroke-dasharray:4 -2`, `rx:-2%`, `ry:-50%`, `r:-4px`)
 * and admitted by the grammar — the one direction the grammar alone cannot
 * close, and a silent rendering change by the road item 1 of this file's header
 * describes. `rx` and `ry` are the worst of the five: the renderer takes the
 * same negative back as a *presentation attribute*, so the projection would not
 * even preserve the drop.
 *
 * The properties that are absent are measured too, and for two different
 * reasons: the grammar already carries the constraint for `width`, `height` and
 * `font-size`, so their negatives never reach this table (the unitless
 * `font-size:-2` spelling reaches {@link RENDERER_KEPT_NUMBER} instead, which
 * refuses it there); and the renderer keeps a negative for `x`, `y`, `cx`,
 * `cy`, `stroke-dashoffset`, `letter-spacing`, `word-spacing` and the opacity
 * family, so refusing one there would be a refusal of a value the browser
 * honours. `r` has no producer here yet — Pele filters it out of an author's
 * `style` and `classDef` — and it is a row anyway, because a row is a fact
 * about the renderer's parser rather than about what Pele currently forwards.
 */
const NON_NEGATIVE: Readonly<Record<string, true>> = {
  'stroke-width': true, 'stroke-dasharray': true, rx: true, ry: true, r: true,
};

/**
 * The measured acceptance table for values `css-tree`'s grammar rejects — one
 * row per (property, value shape) the renderer keeps anyway, with the
 * presentation attribute measured to compute what the declaration computes.
 *
 * Measured 2026-11-15 in Chromium 158.0.8127.18 with the r3 sweep harness
 * (380 cells; declaration form `style="P:V"`, attribute form `P="V"` and a
 * control element without either, compared by `getComputedStyle`): a row is
 * admitted only where both halves hold — the declaration survives the parse
 * (its specified value is not empty, so the browser did not drop it) *and* the
 * attribute form computes the same value, so the projection is a move and not a
 * guess. `rx:4` is the finding that produced this table: the grammar reads a
 * unitless non-zero number as neither a length nor a percentage, while the
 * renderer resolves it as a user unit in both forms (`4px` — the rounding
 * Pele's own `rx:var(--_r)` gave the raw render would otherwise have been
 * deleted along with the radius). Refusing it refused a value the browser
 * keeps.
 *
 * `'positive'` rows are the measured sign boundary of that shape: the negative
 * unitless spelling is dropped by the renderer (`rx:-2`, `ry:-2`,
 * `font-size:-2`), and the `rx="-2px"` attribute form *is* taken — the same
 * direction {@link NON_NEGATIVE} records for the spellings that carry a unit.
 * `'any'` rows keep the negative too, measured in both forms:
 * `fill-opacity:-2` computes `0` (and `4`/`1e2`/`1500` clamp to `1`),
 * `letter-spacing:-2` computes `-2px`, `word-spacing:-2` computes `-2px`.
 * Measured spellings of the shape: `4`, `+4`, `04`, `4.0`, `.5`, `0.5`,
 * `1e2`, `1500`, `-1`, `-2`.
 *
 * Every value outside the rows is refused, and the measured reason divides in
 * two. The first is the one an author directive reaches: the renderer drops the
 * declaration (`font-size:normal`, `rx:not-a-color`, `fill-opacity:-4px`,
 * `rx:4 -2` — the unit is a boundary of the shape: the `<number>` is kept and
 * the `Dimension` is not). The second is a guard on the renderer's contract
 * rather than a face cell: a parenthesised value cannot arrive through a
 * directive at all — measured 2026-11-15, `style`/`classDef`/`linkStyle` with
 * `var(--x)`, `url(#g)` or `calc(4px)` fails Pele's own directive parse and the
 * adapter reports that as a `DiagramError` — so the branch exists for whatever a
 * future renderer emits: a declaration whose value an attribute cannot carry is
 * refused, never moved. Neither is silently dropped;
 * `tests/diagram-engine.test.ts` gates the first with a source-level row per
 * shape, and the refusal path names the property and the value.
 */
const RENDERER_KEPT_NUMBER: Readonly<Record<string, 'any' | 'positive'>> = {
  'fill-opacity': 'any',
  'font-size': 'positive',
  'letter-spacing': 'any',
  'word-spacing': 'any',
  rx: 'positive',
  ry: 'positive',
};

/**
 * The one further shape a grammar-rejected value can have and the renderer keep:
 * `word-spacing`'s percentage — this grammar wants a length, while the renderer
 * keeps `50%` and `-50%` as declarations and computes both from the attribute
 * form too (the computed value keeps the percentage itself).
 */
const RENDERER_KEPT_PERCENTAGE: Readonly<Record<string, true>> = { 'word-spacing': true };

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;',
};

/**
 * Every declaration of Pele's root `style` block, and nothing else.
 *
 * Each is supplied, with the value Pele intends, by `src/styles/diagram.css`:
 * `max-width` and `height` by its `.diagram svg` rule, the palette and the
 * measurement font by `.diagram svg.pele`. `tests/diagram-engine.test.ts` reads
 * the emitted declaration set against this table in both directions, so a
 * property Pele adds upstream fails the build here rather than vanishing, and a
 * property in the table with no CSS counterpart fails the test that resolves it.
 */
const ROOT_STYLE_RULES: Readonly<Record<string, true>> = {
  'max-width': true, height: true, color: true, font: true, 'font-family': true,
  'letter-spacing': true, 'word-spacing': true, 'text-transform': true, direction: true,
  '--_bg': true, '--_fg': true, '--_m': true, '--_l': true, '--_s': true, '--_a': true,
  '--_b': true, '--_c': true, '--_r': true, '--_fm': true, '--_tw': true, '--_hw': true, '--_w': true,
};

/**
 * A `style` attribute's declarations, the last one per property winning, as CSS
 * defines it.
 *
 * Last-wins is load-bearing: Pele writes `rx:var(--_r)` on every rounded rect
 * and appends an author's own `rx` when the author set one, so `rx:var(--_r);
 * rx:8px` means the literal radius, while `rx:8px;rx:var(--_r)` means the class.
 * A node the parser cannot read as a declaration is an error, not a skip: this
 * input reaches the build from a renderer, and a half-parsed declaration list is
 * how a dropped value hides.
 *
 * The value is read as source, from the position the parser reports, rather than
 * rebuilt from the AST: an emitted declaration has to carry the author's own
 * spelling of it (`#fff`, `Georgia`, `0.5`) and `css-tree`'s declared slice here
 * — `src/types/css-tree.d.ts` — deliberately has no generator.
 */
function styleDeclarations(style: string): Map<string, string> {
  const declarations = new Map<string, string>();
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
    declarations.set(property.toLowerCase(), sourceRangeOf(node['value'], style));
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

function escapeXml(value: string): string {
  return value.replace(/[&<>"\t\n\r]/g, (character) => XML_ENTITIES[character]!);
}

/**
 * Whether any numeric component of the value is negative — `-2`, `-2px`, `-2%`
 * and a later component of a list (`4 -2`) all count; `-0` does not, which is
 * what the renderer does with it too (measured: `stroke-width:-0px` computes to
 * `0px`, declaration and attribute alike).
 */
function hasNegativeComponent(value: string): boolean {
  let negative = false;
  walk(parse(value, { context: 'value' }), (node) => {
    if (node.type !== 'Number' && node.type !== 'Dimension' && node.type !== 'Percentage') return;
    if (typeof node.value === 'string' && Number.parseFloat(node.value) < 0) negative = true;
  });
  return negative;
}

/**
 * The value, when it is exactly one scalar of that type — a bare `<number>` or
 * a bare `<percentage>`, the two shapes {@link RENDERER_KEPT_NUMBER} and
 * {@link RENDERER_KEPT_PERCENTAGE} read. Every other shape is null rather than
 * the number it contains: `4 -2` is a list (two components), `-4px` is a
 * `Dimension`, `var(--x)` and `calc(4px)` are `Function`s.
 */
function singleComponent(value: string, type: 'Number' | 'Percentage'): number | null {
  const children = parse(value, { context: 'value' }).children?.toArray() ?? [];
  if (children.length !== 1 || children[0]?.type !== type) return null;
  const scalar = Number.parseFloat(children[0]['value'] ?? '');
  return Number.isFinite(scalar) ? scalar : null;
}

/**
 * The measured tables' lookup for a value the property's grammar rejects: the
 * projection — the author's own spelling, which each row measured the attribute
 * form to carry — or null, which the caller refuses loudly.
 */
function measuredProjection(property: string, value: string): string | null {
  const sign = RENDERER_KEPT_NUMBER[property];
  if (sign !== undefined) {
    const scalar = singleComponent(value, 'Number');
    if (scalar !== null && (sign === 'any' || scalar > 0)) return value;
  }
  if (RENDERER_KEPT_PERCENTAGE[property] === true && singleComponent(value, 'Percentage') !== null) return value;
  return null;
}

/** CSS variables can hide a resource in a fallback; css-tree keeps that fallback as Raw. */
function inspectPaint(value: string): void {
  walk(parse(value, { context: 'value' }), (node) => {
    if (node.type === 'Url' && !/^#[A-Za-z0-9_.:-]+$/.test(node.value ?? '')) {
      throw new Error('the renderer emitted an external paint reference');
    }
    if (node.type === 'Function' && COLOUR_FUNCTIONS[node.name ?? ''] !== true) {
      throw new Error('the renderer emitted an unsupported paint function');
    }
    if (node.type === 'Raw') inspectPaint(node.value ?? '');
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
    const declared = new Map<string, string>();
    let rounded = false;
    const style = tag.attributes['style']?.value ?? '';
    if (style !== '') {
      for (const [property, value] of styleDeclarations(style)) {
        if (isRoot) {
          if (ROOT_STYLE_RULES[property] !== true) {
            throw new Error(`the renderer emitted a root style declaration with no CSS counterpart: ${property}`);
          }
          continue;
        }
        // `rx: var(--_r)` is the one declaration `diagram.css` supplies as a
        // class: a presentation attribute cannot carry `var()`.
        if (property === 'rx' && value === 'var(--_r)') {
          rounded = true;
          continue;
        }
        if (ATTRIBUTES[property] !== true || value.includes('var(')) {
          throw new Error(`the renderer emitted a style declaration with no safe equivalent: ${property}: ${value}`);
        }
        inspectPaint(value);
        // `lexer.matchProperty` is the parser's own property grammar, the same
        // oracle `svg-css.ts` resolves colours with, and it decides the values
        // that need no further reading. Where it rejects, the decision is the
        // measured tables above rather than the grammar: a row admits the value
        // as the author spelled it, and everything else is refused loudly —
        // never dropped in silence, which is the rendering change item 1 of
        // this file's header describes.
        if (lexer.matchProperty(property, value).matched === null) {
          const projection = measuredProjection(property, value);
          if (projection === null) {
            throw new Error(`the renderer emitted a style declaration with no measured projection: ${property}: ${value}`);
          }
          declared.set(property, projection);
          continue;
        }
        // The grammar is sign-agnostic where the renderer is not; the table
        // above records the properties where that difference is measured.
        if (NON_NEGATIVE[property] === true && hasNegativeComponent(value)) {
          throw new Error(`the renderer emitted a style declaration with a negative value for a non-negative property: ${property}: ${value}`);
        }
        declared.set(property, value);
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
      if (attribute.prefix !== '' || ATTRIBUTES[name] !== true) continue;
      // Pele's root role and accessible-name attributes are replaced by the site's caption.
      if (isRoot && ['role', 'aria-label', 'aria-labelledby'].includes(name)) continue;
      if (PAINT_ATTRIBUTES[name] === true) inspectPaint(attribute.value);
      // A `style` declaration outranks a presentation attribute in CSS, so the
      // attribute it displaces is dropped rather than emitted twice.
      if (declared.has(name)) continue;
      const value = name === 'class' && rounded ? `${attribute.value} pele-rounded` : attribute.value;
      if (name === 'class') hasClass = true;
      output.push(` ${name}="${escapeXml(value)}"`);
    }
    for (const [property, value] of declared) output.push(` ${property}="${escapeXml(value)}"`);
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
    const { svg } = render(source, { idPrefix: diagramId, links: false, images: false, now: 0 });
    return sanitizeSvg(svg, accessibleName);
  } catch (error) {
    throw new DiagramError(source, error instanceof Error ? error.message.split('\n')[0]! : String(error));
  }
}
