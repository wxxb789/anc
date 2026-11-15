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
 *    reading, {@link NON_NEGATIVE}, {@link RENDERER_KEPT_NUMBER},
 *    {@link RENDERER_KEPT_PERCENTAGE} and {@link FUNCTION_VALUE_TYPES} record
 *    the cells where a measurement showed the grammar's verdict is not the
 *    renderer's, and a value outside them is refused loudly rather than
 *    guessed. Where the element already has that attribute, the declaration
 *    wins and the attribute is replaced: a `style` attribute outranks a
 *    presentation attribute in CSS, so that is the rendering Pele produced, not
 *    a preference.
 *
 *    Which declarations arrive at all is a property of the *diagram type*, and
 *    the r3 sweep read only one of them. Measured 2026-11-15 over the 23-type
 *    matrix and every directive form: the flowchart parser drops a function
 *    value at its own directive parse (`style`/`classDef`/`linkStyle` with
 *    `calc(4px)`, `var(--x)` or `url(#p)` is a parse error), while the state,
 *    block and class parsers forward the raw value — `stateDiagram-v2` +
 *    `style A stroke-width:calc(4px)` reaches this file as
 *    `style="stroke-width:calc(4px)"`. So a parenthesised value is a face cell
 *    here, not a hypothetical, and the dispositions below are keyed to it:
 *    functions the property keeps are projected, functions it does not are
 *    refused by name, and `var()`/`env()`/`attr()` references are projected
 *    after measurement. Pele's own value filter is the other boundary: it
 *    drops any value carrying `url(` — measured, which is why the resource
 *    guard below has no reachable declaration cell and exists for the
 *    attribute path — and its 1.13.0 filter also refuses `expression(`,
 *    `javascript:`, `@import`, `image-set`, comments and control characters,
 *    read from the bundle rather than measured cell by cell.
 * 2. **`rx: var(--_r)`** — Pele's own corner rounding, carried as a class
 *    rather than an attribute. The reason the class was introduced (that
 *    `var()` does not resolve in a presentation attribute) is false as
 *    measured: in Chromium 158 `rx="var(--_r)"` computes the same length as the
 *    declaration does. The class is a carrier choice, not a necessity —
 *    `.diagram svg.pele .pele-rounded` in `diagram.css` names the site's radius
 *    token once, and the class is left off any element whose own declaration
 *    wins, because a class rule outranks a presentation attribute and keeping
 *    both would render `var(--_r)` over the author's literal radius.
 * 3. **The root `style` block** — Pele's palette, its measurement font and the
 *    reset of the inheritable text properties, as one attribute on `<svg>`.
 *    `src/styles/diagram.css` re-creates it under `.diagram svg.pele` and
 *    `.diagram svg`; {@link ROOT_STYLE_RULES} is that list, so a declaration
 *    added upstream stops the build instead of disappearing.
 */

import { lexer, parse, walk } from 'css-tree';
import type { CssNode } from 'css-tree';
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
 * rather than a face cell: a *scalar* spelling is what these rows are about,
 * and a parenthesised value is a different shape with its own disposition
 * above — {@link FUNCTION_VALUE_TYPES} for a math function, the reference
 * branch for `var()`/`env()`/`attr()`. This paragraph used to claim those
 * values could not arrive through a directive at all; measured 2026-11-15,
 * that holds for the flowchart parser only (see item 1 of this file's header),
 * and the claim is gone rather than left standing beside a reachable cell.
 * Neither is silently dropped; `tests/diagram-engine.test.ts` gates the first
 * with a source-level row per shape, and the refusal path names the property
 * and the value.
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

/**
 * The units a `<length>` may carry, so a `Dimension` in a function's argument
 * list can be told from an angle, a time or a frequency.
 */
const LENGTH_UNITS: Readonly<Record<string, true>> = {
  px: true, cm: true, mm: true, q: true, in: true, pt: true, pc: true,
  em: true, rem: true, ex: true, ch: true, cap: true, ic: true, lh: true, rlh: true,
  vw: true, vh: true, vi: true, vb: true, vmin: true, vmax: true,
};

/**
 * The math functions whose result is a `<number>` — a measurement of the type
 * boundary `FUNCTION_VALUE_TYPES` reads, not a second copy of the CSS grammar.
 *
 * `sin(45deg)` is the spelling that made this table necessary: the flowchart
 * parser refuses it, the state parser forwards it, and the two forms disagree
 * on the properties that expect a length — `letter-spacing:sin(45deg)` is
 * dropped by the declaration while `letter-spacing="sin(45deg)"` is taken as
 * `calc(0.707107px)`, measured in Chromium 158.
 */
const NUMBER_RESULT_FUNCTIONS: Readonly<Record<string, true>> = {
  sin: true, cos: true, tan: true, asin: true, acos: true, atan: true, atan2: true,
  pow: true, sqrt: true, log: true, exp: true, sign: true, sinh: true, cosh: true, tanh: true,
};

/**
 * The math functions whose result type follows from their arguments, folded by
 * the operator rules in {@link combineTypes}.
 */
const UNIT_PRESERVING_FUNCTIONS: Readonly<Record<string, true>> = {
  calc: true, min: true, max: true, clamp: true, round: true, mod: true, rem: true, abs: true, hypot: true,
};

/**
 * The functions whose value is a reference resolved at computed-value time —
 * `var()` against the page's custom properties, `env()` against the display
 * environment, `attr()` against the element's own data.
 *
 * All three are measured equal in both forms over the whole reachable
 * properties × spellings matrix (r4 sweep: `var(--pele-accent)`,
 * `var(--pele-radius)`, `var(--r4-missing)`, `var(--x)` inside `calc()` and
 * inside `rgb()`, `env(safe-area-inset-top)`, `attr(data-w)` — some fifty cells,
 * no divergent one): the declaration and the attribute substitute, or fail to
 * substitute, in the same environment, and an unresolvable reference is treated
 * as `unset` in both. They are admitted *because* that was measured, not
 * because a reference looks harmless.
 *
 * `url()` is deliberately not here: Pele's own filter drops any value carrying
 * it (measured on state, block and class), so the only reachable resource is
 * the resource guard's territory.
 */
const REFERENCE_FUNCTIONS: Readonly<Record<string, true>> = { var: true, env: true, attr: true };

/**
 * The function-value types each property's own declaration keeps, measured
 * 2026-11-15 in Chromium 158 against the r4 sweep and its focused follow-ups
 * (the declaration form, the attribute form, control elements with neither).
 *
 * The rows are not a guess about CSS typing; they are the cells where a math
 * function's *value type* decides whether the two forms agree:
 *
 * - `stroke-width`, `stroke-dasharray`, `stroke-dashoffset`, `rx`, `ry` keep a
 *   `<number>` as well as a `<length>` (`stroke-width:calc(4)` computes 4px,
 *   `calc(2 * 4px)` 8px, `hypot(3px)` 3px, and the attribute form agrees),
 *   which is why they admit all three scalar types. The type-invalid spellings
 *   are refused: `rx:calc(1px * 1px)` and `rx:calc(4px + 2)` measure divergent
 *   (the declaration is dropped, the displaced `rx="10"` survives in the raw
 *   render, while the projected attribute is read as the zero length).
 * - `font-size`, `letter-spacing`, `word-spacing`, `text-decoration` keep a
 *   length (or, for `font-size`, a percentage) and *drop* a `<number>`-valued
 *   function, while the attribute form coerces the number to user units:
 *   `letter-spacing:calc(4)` computes `normal` where `letter-spacing="calc(4)"`
 *   computes `calc(4px)`; same for `sin(45deg)`, `sqrt(4)`, `sign(2px)` and
 *   `calc(4px / 2px)`.
 * - `opacity`, `fill-opacity`, `stroke-opacity`, `font-weight` keep a number
 *   and drop a length-valued function (`fill-opacity:calc(4px)` is dropped
 *   where the attribute form is ignored, so the projection would delete a
 *   displaced `fill-opacity="0.25"` and render `1`).
 *
 * A property with no row never reaches this decision — its function values are
 * refused by the grammar path below, and a reference is admitted before the
 * table is consulted. The measured spellings behind each row are named in
 * `r4-sweep.tsv`; the cells the rule refuses while measuring equal are recorded
 * as its conservative side in the r4 report.
 */
const FUNCTION_VALUE_TYPES: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  'stroke-width': { length: true, percentage: true, number: true },
  'stroke-dasharray': { length: true, percentage: true, number: true },
  'stroke-dashoffset': { length: true, percentage: true, number: true },
  rx: { length: true, percentage: true, number: true },
  ry: { length: true, percentage: true, number: true },
  'font-size': { length: true, percentage: true },
  'letter-spacing': { length: true, percentage: true },
  'word-spacing': { length: true, percentage: true },
  'text-decoration': { length: true },
  opacity: { number: true },
  'fill-opacity': { number: true },
  'stroke-opacity': { number: true },
  'font-weight': { number: true },
};

/**
 * The geometry properties whose presentation attribute the renderer parses as
 * a `<length>` in the SVG legacy grammar rather than as the CSS value.
 *
 * `rx` and `ry` are the two the Pele filter reaches; the others are the same
 * attribute family, measured with the same spellings (`x`, `y`, `width`,
 * `height`, `cx`, `cy`, `r` — a CSS-wide keyword is kept by the declaration and
 * read as the zero length by the attribute).
 */
const GEOMETRY_PROPERTIES: Readonly<Record<string, true>> = {
  x: true, y: true, width: true, height: true, cx: true, cy: true, r: true, rx: true, ry: true,
};

/**
 * The values a geometry attribute reads as a length instead of as the value the
 * declaration names — the one cell family where the grammar accepts and the
 * projection would move the rendering.
 *
 * Measured in Chromium 158: `rx:inherit`, `rx:initial`, `rx:unset`,
 * `rx:revert` and `rx:auto` are all kept by the declaration (`rx:inherit`
 * computes `auto` — the inherited value — and `rx:auto` the keyword itself)
 * while the attribute form computes `0px` in every one of them; the same
 * measurement holds across the geometry family. `auto` is refused only while
 * the declaration would keep it: where `auto` is invalid for the property the
 * grammar path below refuses it anyway.
 */
const GEOMETRY_KEYWORD_VALUES: Readonly<Record<string, true>> = {
  auto: true, inherit: true, initial: true, unset: true, revert: true, 'revert-layer': true,
};

/**
 * The properties whose attribute form takes a negative back when it arrives
 * inside a function — the geometry attributes again, measured: `rx:calc(-4px)`
 * is kept by the declaration and computes `0px` (clamped), while
 * `rx="calc(-4px)"` computes `-4px`. The stroke properties clamp in both forms
 * (`stroke-width:calc(-4px)` computes `0px` in each), so their function values
 * are not refused for a sign the renderer already handles — `stroke-width:
 * abs(-2px)` computes `2px` in both forms and is projected. A *scalar* negative
 * is a different cell and stays refused for every {@link NON_NEGATIVE}
 * property, measured and gated since r2.
 */
const FUNCTION_NEGATIVE_TAKEN_BACK: Readonly<Record<string, true>> = { rx: true, ry: true };

/** The value types {@link FUNCTION_VALUE_TYPES} and the walk below can name. */
type ValueType = 'length' | 'percentage' | 'number' | 'other';

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
 * a fetch the page would make.
 *
 * Through an author directive this guard has no reachable cell — Pele's own
 * filter drops every value containing `url(` — so it guards the attribute path
 * (a future renderer's output) rather than a face cell, and the r4 sweep
 * records that as measured, not assumed.
 */
function inspectResources(value: string): void {
  visitValue(value, (node) => {
    if (node.type === 'Url' && !/^#[A-Za-z0-9_.:-]+$/.test(node.value ?? '')) {
      throw new Error(`the renderer emitted an external paint reference: url(${node.value ?? ''})`);
    }
  });
}

/**
 * A paint property's value is a colour: the renderer's own palette functions
 * (`var()`, `light-dark()`, `color-mix()`, the `rgb`/`hsl` families) and
 * nothing else.
 *
 * Measured 2026-11-15 over the reachable spellings: every math function on
 * `fill`/`stroke` is dropped by the declaration form while the attribute form
 * is taken or ignored differently, so `fill:calc(4px)` and `fill:rgb(0 0 0 /
 * 50%)` are in different classes here for a measured reason — `rgb(...)` is a
 * colour and computes the same in both forms; `calc(...)` is not.
 */
function inspectColourFunctions(property: string, value: string): void {
  visitValue(value, (node) => {
    if (node.type === 'Function' && COLOUR_FUNCTIONS[node.name ?? ''] !== true) {
      throw new Error(`the renderer emitted a paint value with an unsupported function: ${property}: ${value}`);
    }
  });
}

/** Whether the value carries a `var()`/`env()`/`attr()` reference, directly or in a fallback. */
function hasReference(value: string): boolean {
  let found = false;
  visitValue(value, (node) => {
    if (node.type === 'Function' && REFERENCE_FUNCTIONS[node.name ?? ''] === true) found = true;
  });
  return found;
}

/** The type of one scalar or function node, as far as {@link FUNCTION_VALUE_TYPES} reads it. */
function componentType(node: CssNode): ValueType {
  if (node.type === 'Number') return 'number';
  if (node.type === 'Percentage') return 'percentage';
  if (node.type === 'Dimension') {
    const unit = node['unit'];
    return typeof unit === 'string' && LENGTH_UNITS[unit.toLowerCase()] === true ? 'length' : 'other';
  }
  if (node.type === 'Function') return functionType(node);
  return 'other';
}

/**
 * One operator applied to two operand types, conservatively: a combination the
 * CSS type rules reject — `4px + 2`, `1px * 1px`, a number divided by a length
 * — is `other`, and `other` is sticky, so a later operator cannot rescue it.
 */
function combineTypes(operator: string, left: ValueType, right: ValueType): ValueType {
  if (left === 'other' || right === 'other') return 'other';
  if (operator === '*') {
    if (left === 'number') return right;
    if (right === 'number') return left;
    return 'other';
  }
  if (operator === '/') {
    if (right === 'number') return left;
    if (left === 'number') return 'other';
    return left === right ? 'number' : 'other';
  }
  return left === right ? left : 'other';
}

/**
 * The type a function value resolves to, from the function's name and its
 * arguments' types — the walk {@link FUNCTION_VALUE_TYPES} is consulted with.
 *
 * A reference never reaches this branch (the caller admits it first). A
 * number-result function is a number unless it is handed a length — `sqrt(4)`
 * is a number, `sqrt(4px)` is not a value at all, and both are refused on a
 * property that expects a length. A unit-preserving function folds its operand
 * list left to right: arguments without operators are a list (`round(1.5px,
 * 1px)` parses as two components) and must agree.
 */
function functionType(node: CssNode): ValueType {
  const name = (node.name ?? '').toLowerCase();
  const parts = node.children?.toArray() ?? [];
  if (NUMBER_RESULT_FUNCTIONS[name] === true) {
    const unitful = parts.some((part) => {
      const type = part.type === 'Operator' ? 'other' : componentType(part);
      return type === 'length' || type === 'percentage';
    });
    return unitful ? 'other' : 'number';
  }
  if (UNIT_PRESERVING_FUNCTIONS[name] !== true) return 'other';
  let current: ValueType | null = null;
  let operator: string | null = null;
  for (const part of parts) {
    if (part.type === 'Operator') {
      operator = (part.value ?? '').trim();
      continue;
    }
    const type = componentType(part);
    if (current === null) {
      current = type;
      continue;
    }
    current = operator === null ? (current === type ? type : 'other') : combineTypes(operator, current, type);
    operator = null;
    if (current === 'other') return 'other';
  }
  return current ?? 'other';
}

/** The type of a value's single component — a function value, as the caller has already checked. */
function functionValueType(value: string): ValueType {
  const children = parse(value, { context: 'value' }).children?.toArray() ?? [];
  return children.length === 1 && children[0] !== undefined ? componentType(children[0]) : 'other';
}

/**
 * Whether the value's single component is a function call.
 *
 * `calc(4px)`, `min(4px)`, `sin(45deg)` and `var(--x)` are; `4px`, `4 -2` and
 * `Georgia` are not, and a list is not either — the tables above read scalars,
 * and a list of scalars is the grammar path's business.
 */
function isFunctionValue(value: string): boolean {
  const children = parse(value, { context: 'value' }).children?.toArray() ?? [];
  return children.length === 1 && children[0]?.type === 'Function';
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
        // `rx: var(--_r)` is Pele's own rounding, which `diagram.css` supplies
        // as a class; see item 2 of this file's header for why it is a class
        // though the attribute form would resolve the same length.
        if (property === 'rx' && value === 'var(--_r)') {
          rounded = true;
          continue;
        }
        if (ATTRIBUTES[property] !== true) {
          throw new Error(`the renderer emitted a style declaration with no safe equivalent: ${property}: ${value}`);
        }
        inspectResources(value);
        // `var()`/`env()`/`attr()` are references, not values: the measurement
        // that admits them is in REFERENCE_FUNCTIONS. Admitting them before the
        // paint guard and the tables is deliberate — the paint guard exists for
        // *functions* whose declaration the renderer drops (measured on
        // `fill:calc(4px)`), and a reference is not one of those; the grammar
        // rejects every reference too, and a value the grammar rejects with no
        // table row is refused below.
        if (hasReference(value)) {
          declared.set(property, value);
          continue;
        }
        if (PAINT_ATTRIBUTES[property] === true) inspectColourFunctions(property, value);
        if (GEOMETRY_PROPERTIES[property] === true && GEOMETRY_KEYWORD_VALUES[value] === true) {
          throw new Error(`the renderer emitted a style declaration whose attribute form is the zero length, not the value it names: ${property}: ${value}`);
        }
        // The renderer's requirement is not the grammar's; the table above
        // records the properties where that difference is measured. The check
        // splits by shape, because the sign boundary does: a *scalar* negative
        // (`-2px`, `-50%`) is dropped from the declaration for every property
        // in NON_NEGATIVE, while a negative inside a function is kept and
        // clamped by the declaration for the stroke and radius-less properties
        // and taken back by the attribute only for the geometry ones —
        // `stroke-width:calc(-4px)` computes `0px` in both forms, and
        // `rx:calc(-4px)` computes `0px` where `rx="calc(-4px)"` computes
        // `-4px`, measured.
        if (NON_NEGATIVE[property] === true && hasNegativeComponent(value)
          && (!isFunctionValue(value) || FUNCTION_NEGATIVE_TAKEN_BACK[property] === true)) {
          throw new Error(`the renderer emitted a style declaration with a negative value for a non-negative property: ${property}: ${value}`);
        }
        // A math function is decided by its *value type*, not by the grammar:
        // `css-tree` matches every function name without typing its arithmetic,
        // while the renderer keeps a function only when its value is of the
        // property's own type. The table is measured; see FUNCTION_VALUE_TYPES.
        if (FUNCTION_VALUE_TYPES[property] !== undefined && isFunctionValue(value)) {
          const type = functionValueType(value);
          if (FUNCTION_VALUE_TYPES[property]?.[type] !== true) {
            throw new Error(`the renderer emitted a style declaration with a function the property does not keep as a ${type}: ${property}: ${value}`);
          }
          declared.set(property, value);
          continue;
        }
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
      if (PAINT_ATTRIBUTES[name] === true) {
        inspectResources(attribute.value);
        inspectColourFunctions(name, attribute.value);
      }
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
