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
 *    {@link RENDERER_KEPT_PERCENTAGE}, {@link RENDERER_KEPT_RELATIVE_COLOUR}
 *    and {@link FUNCTION_VALUE_TYPES} record the cells where a measurement
 *    showed the grammar's verdict is not the renderer's, and a value outside
 *    them is refused loudly rather than guessed. A function value is read the
 *    way the renderer reads it — one expression walk with CSS's precedence,
 *    parentheses, ASCII-case names and the *sign of the result* (r5, measured:
 *    `calc(0px - 4px)` is a negative length and diverges, `calc(4px + 2 * 2px)`
 *    is a length that does not, `calc(4px + 2)` is not a value at all) —
 *    rather than as a fold over tokens in the order they parse. Where the
 *    element already has that attribute, the declaration
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
/**
 * The colour functions a paint property's declaration keeps — the renderer's
 * own palette, measured, rather than the CSS Color function list copied out.
 *
 * Completed per CSS Color 4/5 and measured 2026-11-15 in Chromium 158 with the
 * r5 sweep (`fill` and `stroke`, the declaration form against the attribute
 * form): `hwb(120 0% 0%)`, `hwb(120 0% 0% / 50%)`, `RGB(0 255 0)`,
 * `lab(50% 40 59.5)`, `LCH(52.2% 72.2 50)`, `oklab(0.59 0.11 0.1)`,
 * `oklch(0.63 0.2 30)`, `color(srgb 0 0 0)` and `color(display-p3 1 0 0)` are
 * every one kept by the declaration and compute the same in both forms. The
 * names are compared in ASCII case, measured the same way: `HWB(...)`,
 * `RGB(...)`, `COLOR(...)` and `VAR(...)` compute what their lowercase
 * spellings do, and before the r5 fix the mixed-case spellings were refused
 * while the lowercase ones were projected.
 *
 * Two exclusions are measured rather than assumed. `device-cmyk()` is in the
 * CSS Color 5 list and `css-tree`'s own grammar accepts it, while the renderer
 * drops the declaration *and* the projected attribute — with the element's own
 * `fill` displaced, that deletes a paint that was rendering (measured
 * DIVERGENT in the r5 sweep), so the name is deliberately absent. The relative
 * colour syntax (`rgb(from red r g b)`) is the other direction: the renderer
 * keeps it while `css-tree`'s grammar does not parse it, and it is admitted by
 * the measured row {@link RENDERER_KEPT_RELATIVE_COLOUR} instead.
 */
const COLOUR_FUNCTIONS: Readonly<Record<string, true>> = {
  var: true, 'light-dark': true, 'color-mix': true,
  rgb: true, rgba: true, hsl: true, hsla: true, hwb: true,
  lab: true, lch: true, oklab: true, oklch: true, color: true,
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
 * The gate below reads the value's *components* — each scalar's own sign, a
 * list component by component, which is what the renderer parses (a list is not
 * an expression) — and a value that is one function is a different rule
 * ({@link FUNCTION_NEGATIVE_TAKEN_BACK}): its sign is the *result's*, which is
 * the r5 finding `rx:calc(0px - 4px)` is.
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
 * The one paint spelling `css-tree`'s own colour grammar rejects while the
 * renderer keeps it: the relative-colour syntax, `rgb(from red r g b)`.
 *
 * Measured 2026-11-15 in Chromium 158 in the r5 sweep: the declaration is kept
 * (`specified` is `rgb(from red r g b)`) and the declaration and the attribute
 * form both compute `color(srgb 1 0 0)`. `css-tree` 3.2.1's `fill` grammar
 * rejects the value — its colour syntax predates the relative form — which is
 * why the projection is a measured row beside {@link RENDERER_KEPT_NUMBER}
 * rather than a grammar decision. The row is per function name: `rgb` is the
 * spelling that was measured, and the other functions' relative forms are
 * unmeasured and stay with the grammar path, which refuses them loudly — the
 * direction an unmeasured spelling takes everywhere in this file.
 */
const RENDERER_KEPT_RELATIVE_COLOUR: Readonly<Record<string, true>> = { rgb: true };

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
 * The units an `<angle>` may carry, as the radians one of each is — the
 * conversion the trigonometric functions do, and a measured one: `sin(45deg)`
 * computes `calc(0.707107px)` in both forms, and `Math.sin(Math.PI / 4)` is
 * that number. A *number* argument is radians, also measured: `sin(200)`
 * computes `calc(-0.873297px)` in both forms, which is `Math.sin(200)` to the
 * digit — not `sin(200deg)`, whose sign is negative.
 */
const ANGLE_UNITS: Readonly<Record<string, number>> = {
  deg: Math.PI / 180, grad: Math.PI / 200, rad: 1, turn: Math.PI * 2,
};

/**
 * The trigonometric functions, the ones whose argument may be an angle as well
 * as a number — measured in both spellings: `sin(45deg)` and `sin(200)` are
 * both kept by the declaration where the property takes a number and both
 * compute what {@link NUMBER_RESULT_FUNCTIONS} computes for them.
 */
const TRIG_FUNCTIONS: Readonly<Record<string, true>> = { sin: true, cos: true, tan: true };

/**
 * The math functions whose result is a `<number>`, each with the number the
 * renderer computes for it — a measurement of the type boundary
 * `FUNCTION_VALUE_TYPES` reads, and of the arithmetic, not a second copy of the
 * CSS grammar.
 *
 * `sin(45deg)` is the spelling that made this table necessary: the flowchart
 * parser refuses it, the state parser forwards it, and the two forms disagree
 * on the properties that expect a length — `letter-spacing:sin(45deg)` is
 * dropped by the declaration while `letter-spacing="sin(45deg)"` is taken as
 * `calc(0.707107px)`, measured in Chromium 158. The numbers are measured too
 * and they are the renderer's own: `sin(45deg)` is `Math.sin(π / 4)`, a number
 * argument is radians (`sin(200)` computes `calc(-0.873297px)` in both forms),
 * `sqrt(4)` computes `calc(2px)`. The one function whose result keeps its
 * argument's type is not here — `abs()` is measured to compute `calc(2px)` for
 * a `2px` argument, and `hypot(3px)` computes `3px`, so
 * {@link UNIT_PRESERVING_FUNCTIONS} is where they belong; `sign()` *is* a
 * number but takes any argument, so it has its own branch in
 * {@link evaluateFunction}.
 */
const NUMBER_RESULT_FUNCTIONS: Readonly<Record<string, (...arguments_: number[]) => number>> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  pow: Math.pow, sqrt: Math.sqrt,
  log: (value: number, base = Math.E) => Math.log(value) / Math.log(base),
  exp: Math.exp, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
};

/**
 * The math functions whose result is an `<angle>`, split from
 * {@link NUMBER_RESULT_FUNCTIONS} on a measurement.
 *
 * `rx:asin(0.5)` is *dropped* by the renderer — its `specified` value is empty
 * — while `rx="asin(0.5)"` is taken as the zero length, so a walk that read
 * this family as a number would project the declaration away and delete the
 * attribute that was rendering: measured DIVERGENT in the r5 sweep. None of the
 * measured rows keeps a function of type `angle`, so the type alone refuses it
 * wherever it arrives. The values are radians because an angle's sign is the
 * same in either unit and the sign is all this table is read for.
 */
const ANGLE_RESULT_FUNCTIONS: Readonly<Record<string, (...arguments_: number[]) => number>> = {
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
};

/**
 * The math functions whose result type follows from their arguments, resolved
 * by the operator rules in {@link combineOperands} — `calc(2 * 4px)` is a
 * length, `abs(-2px)` is the `calc(2px)` measured in both forms, `hypot(3px)`
 * the `calc(3px)` measured in both. `sign()` is *not* one of these even though
 * it is written the same way: measured, `sign(2px)` computes `calc(1)` — a
 * `<number>`, which is why the length-only properties drop it — so it has its
 * own branch in {@link evaluateFunction}.
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
 * because a reference looks harmless. The names are compared in ASCII case,
 * measured the same way in the r5 sweep: `VAR(--pele-accent)` computes the
 * token, `VAR(--pele-radius)` the length.
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
 *
 * The row is consulted with a *result type* rather than a fold over tokens: the
 * value is evaluated the way the renderer evaluates it — `*` and `/` binding
 * tighter than `+` and `-`, parentheses their own operand, function names and
 * units compared in ASCII case, a number argument to a trigonometric function
 * read as radians — and r5 measured what the token-order fold got wrong in both
 * directions: `calc(4px + 2 * 2px)` and `calc((4px))` are lengths (`8px` and
 * `4px` in both forms) while `calc(4px + 2)` is not a value the renderer keeps.
 * A result of type `angle` is a row of its own — no row admits it, for the
 * reason on {@link ANGLE_RESULT_FUNCTIONS} — and a value this walk cannot
 * resolve is `other`, which no row admits either, so an unreadable expression is
 * refused rather than guessed. The *sign* of a result is a separate rule, on
 * {@link FUNCTION_NEGATIVE_TAKEN_BACK}.
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
 * measurement holds across the geometry family. The lookup is ASCII
 * case-insensitive, because a CSS keyword is — measured in the r5 sweep, where
 * the mixed-case spellings were the finding: `rx:INITIAL` (declaration keeps
 * `initial`, attribute computes `0px`), `rx:Inherit`, `rx:AUTO`, `rx:Unset` and
 * `rx:REVERT` each compute exactly what their lowercase spellings do, and the
 * table's earlier case-sensitive lookup admitted them. `auto` is refused only
 * while the declaration would keep it: where `auto` is invalid for the property
 * the grammar path below refuses it anyway.
 */
const GEOMETRY_KEYWORD_VALUES: Readonly<Record<string, true>> = {
  auto: true, inherit: true, initial: true, unset: true, revert: true, 'revert-layer': true,
};

/**
 * The properties whose attribute form takes a negative back when it arrives
 * inside a function — the geometry attributes again, measured: `rx:calc(-4px)`
 * is kept by the declaration and computes `0px` (clamped), while
 * `rx="calc(-4px)"` computes `-4px`.
 *
 * The sign that decides is the *result's*, not a literal minus in the source,
 * which is the r5 finding: `rx:calc(0px - 4px)` resolves to `-4px` — the same
 * value as `calc(-4px)` — and diverges the same way (measured: declaration
 * `0px`, attribute `-4px`), and `rx:calc(1em - 100px)` computes `-84px` in this
 * page's context while its sign cannot be decided at build time at all. A
 * result whose sign the walk does not resolve (`calc(1em - 2px)` is `14px` here
 * and negative for a smaller font) is therefore refused on these properties
 * rather than guessed. The result *type* is part of the rule: a
 * `<number>`-typed result is taken back by neither form — `rx:calc(4 - 8)`
 * computes `calc(-4px)` in both, measured — so only a length or a percentage
 * has to be provably non-negative.
 *
 * The stroke properties clamp in both forms (`stroke-width:calc(-4px)` computes
 * `0px` in each), so their function values are not refused for a sign the
 * renderer already handles — `stroke-width:calc(0px - 4px)` and `abs(-2px)`
 * compute the same in both forms, measured. A *scalar* negative is a different
 * cell and stays refused for every {@link NON_NEGATIVE} property, measured and
 * gated since r2.
 */
const FUNCTION_NEGATIVE_TAKEN_BACK: Readonly<Record<string, true>> = { rx: true, ry: true };

/**
 * The value types {@link FUNCTION_VALUE_TYPES} and the walk below can name.
 * `angle` is the one the renderer types but no measured row keeps, and `other`
 * is what the walk returns for everything it does not read.
 */
type ValueType = 'length' | 'percentage' | 'number' | 'angle' | 'other';

/** How the type gate's message names one of those types. */
const TYPE_NAMES: Readonly<Record<ValueType, string>> = {
  length: 'a length',
  percentage: 'a percentage',
  number: 'a number',
  angle: 'an angle',
  other: 'a type this build does not read',
};

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
 * CSS compares property names, keywords and function names in *ASCII* case — a
 * spelling like `RGB(0 255 0)` is the function `rgb` — while a Unicode
 * `toLowerCase` folds more than CSS does. Everything this file compares by name
 * goes through here.
 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

/**
 * The signs a computed number can carry, as a mask: a result the arithmetic
 * does not decide keeps all three, and the rules below read that as "not
 * provably non-negative" rather than picking one.
 */
const SIGN_NEGATIVE = 1;
const SIGN_ZERO = 2;
const SIGN_POSITIVE = 4;
const SIGN_ANY = SIGN_NEGATIVE | SIGN_ZERO | SIGN_POSITIVE;

/** The sign of one computed number; NaN — `sqrt(-4)` — decides nothing. */
function signOf(value: number): number {
  if (Number.isNaN(value)) return SIGN_ANY;
  if (value < 0) return SIGN_NEGATIVE;
  return value > 0 ? SIGN_POSITIVE : SIGN_ZERO;
}

/**
 * `a + b` over sign sets: a zero operand leaves the other's sign, equal
 * operands keep theirs (two positives are positive; two negatives negative),
 * and anything else is undecided — conservatively, so a set the exact
 * arithmetic could narrow (`{0, positive} + {positive}` is positive) stays a
 * set and is refused wherever a set is not provable.
 */
function signSum(left: number, right: number): number {
  if (left === SIGN_ZERO) return right;
  if (right === SIGN_ZERO) return left;
  return left === right ? left : SIGN_ANY;
}

/** The sign set of `-a`. */
function signNegated(sign: number): number {
  let negated = sign & SIGN_ZERO;
  if (sign & SIGN_NEGATIVE) negated |= SIGN_POSITIVE;
  if (sign & SIGN_POSITIVE) negated |= SIGN_NEGATIVE;
  return negated;
}

/**
 * `a * b`. A definite zero times a definite number is a zero; a zero times an
 * undecided sign is not — `0 * NaN` is `NaN` in the renderer's arithmetic too.
 */
function signProduct(left: number, right: number): number {
  if (left === SIGN_ZERO || right === SIGN_ZERO) {
    return left === SIGN_ANY || right === SIGN_ANY ? SIGN_ANY : SIGN_ZERO;
  }
  const definite = (sign: number): boolean => sign === SIGN_NEGATIVE || sign === SIGN_POSITIVE;
  if (definite(left) && definite(right)) return left === right ? SIGN_POSITIVE : SIGN_NEGATIVE;
  return SIGN_ANY;
}

/** `a / b`; a divisor that can be zero, or a sign set, decides nothing. */
function signQuotient(left: number, right: number): number {
  if ((right & SIGN_ZERO) !== 0) return SIGN_ANY;
  if (left === SIGN_ZERO) return SIGN_ZERO;
  return signProduct(left, right);
}

/** The sign set of `|a|` — what `abs()` carries. */
function signMagnitude(sign: number): number {
  let magnitude = sign & SIGN_ZERO;
  if (sign & (SIGN_NEGATIVE | SIGN_POSITIVE)) magnitude |= SIGN_POSITIVE;
  return magnitude;
}

/**
 * What one operand or expression resolves to: the value type the measured
 * tables read, the number it resolves to where the arithmetic has one, the unit
 * that number is carried in, and the signs the result can carry.
 *
 * The three fields answer the three questions the declaration walk asks: the
 * type whether the property's own declaration keeps the value at all
 * ({@link FUNCTION_VALUE_TYPES}), the sign whether the attribute form's
 * clamping would change it ({@link FUNCTION_NEGATIVE_TAKEN_BACK}), and the unit
 * whether two operands resolve to one number (`calc(50% - 100%)` is `-50%`,
 * `calc(1em - 2px)` is not one number at all).
 */
type Evaluated = {
  readonly type: ValueType;
  readonly value: number | null;
  readonly unit: string | null;
  readonly sign: number;
};

/** A value this walk does not read: a keyword, a `url()`, a `Raw` tail, a stray operator. */
const UNREADABLE: Evaluated = { type: 'other', value: null, unit: null, sign: SIGN_ANY };

/** One scalar — a `Number`, a `Percentage`, a `Dimension` — as a result. */
function scalar(type: ValueType, unit: string, value: number): Evaluated {
  return { type, value, unit, sign: signOf(value) };
}

/**
 * A result of that type carrying the number the operands resolved to, or — where
 * they resolved to none — their signs alone. Where a number is there, the sign is
 * the number's, so a fallback can never contradict a result.
 */
function resultOf(type: ValueType, unit: string | null, value: number | null, sign: number): Evaluated {
  if (value === null) return { type, value: null, unit: null, sign };
  return { type, value, unit, sign: signOf(value) };
}

/** One node's own value, as far as this walk reads it. */
function evaluateNode(node: CssNode): Evaluated {
  if (node.type === 'Number' || node.type === 'Percentage' || node.type === 'Dimension') {
    const value = Number.parseFloat(node.value ?? '');
    if (!Number.isFinite(value)) return UNREADABLE;
    if (node.type === 'Number') return scalar('number', '', value);
    if (node.type === 'Percentage') return scalar('percentage', '%', value);
    const unit = asciiLower(String(node['unit'] ?? ''));
    if (LENGTH_UNITS[unit] === true) return scalar('length', unit, value);
    if (ANGLE_UNITS[unit] !== undefined) return scalar('angle', unit, value);
    return { type: 'other', value: null, unit: null, sign: signOf(value) };
  }
  if (node.type === 'Parentheses') return evaluateExpression(node.children?.toArray() ?? []);
  if (node.type === 'Function') return evaluateFunction(node);
  return UNREADABLE;
}

/**
 * One function's value. A reference is unreadable here — the caller admits
 * `var()`/`env()`/`attr()` before this walk — a math function follows its own
 * table, and anything else (an unknown function, a colour, a shape this build
 * cannot read) is `other`.
 */
function evaluateFunction(node: CssNode): Evaluated {
  const name = asciiLower(node.name ?? '');
  const parts = node.children?.toArray() ?? [];
  if (REFERENCE_FUNCTIONS[name] === true) return UNREADABLE;
  if (name === 'sign') {
    // `sign()` answers a `<number>` about *any* argument it can resolve — a
    // number or a dimension alike. Measured: `sign(2px)` computes `calc(1)`
    // (a number: `rx` coerces it to `calc(1px)`, the length-only properties
    // drop the declaration) while `abs(-2px)` beside it computes `calc(2px)`.
    const argument = argumentValues(parts);
    const [only] = argument ?? [];
    if (argument === null || argument.length !== 1 || only === undefined || only.type === 'other') return UNREADABLE;
    return resultOf('number', '', only.value === null ? null : Math.sign(only.value), only.sign | SIGN_ZERO);
  }
  const number = NUMBER_RESULT_FUNCTIONS[name];
  if (number !== undefined) {
    const arguments_ = numberArguments(parts, TRIG_FUNCTIONS[name] === true);
    return arguments_ === null ? UNREADABLE : scalar('number', '', number(...arguments_));
  }
  const angle = ANGLE_RESULT_FUNCTIONS[name];
  if (angle !== undefined) {
    const arguments_ = numberArguments(parts, false);
    return arguments_ === null ? UNREADABLE : scalar('angle', 'rad', angle(...arguments_));
  }
  if (UNIT_PRESERVING_FUNCTIONS[name] !== true) return UNREADABLE;
  return evaluateUnitFunction(name, parts);
}

/**
 * A function's arguments, each evaluated as its own expression. A list with an
 * empty group (`min(4px,)`) is null rather than a shorter list.
 */
function argumentValues(parts: readonly CssNode[]): Evaluated[] | null {
  const groups: CssNode[][] = [[]];
  for (const part of parts) {
    if (part.type === 'Operator' && (part.value ?? '').trim() === ',') groups.push([]);
    else groups[groups.length - 1]!.push(part);
  }
  if (groups.some((group) => group.length === 0)) return null;
  return groups.map((group) => evaluateExpression(group));
}

/**
 * The numeric arguments of a math function, with an angle read as radians where
 * the function takes one — measured: `sin(45deg)` is `Math.sin(π / 4)`, and a
 * number argument is radians (`sin(200)` computes `calc(-0.873297px)`).
 */
function numberArguments(parts: readonly CssNode[], angles: boolean): number[] | null {
  const arguments_ = argumentValues(parts);
  if (arguments_ === null) return null;
  const numbers: number[] = [];
  for (const argument of arguments_) {
    if (argument.type === 'number' && argument.value !== null) {
      numbers.push(argument.value);
      continue;
    }
    if (angles && argument.type === 'angle' && argument.value !== null && argument.unit !== null) {
      numbers.push(argument.value * ANGLE_UNITS[argument.unit]!);
      continue;
    }
    return null;
  }
  return numbers;
}

/**
 * A math function whose result carries its arguments' type. `calc()` folds one
 * expression; `min()`, `max()` and `clamp()` take a list and keep its type; and
 * the rest keep the type they were handed, with the sign the function implies:
 * `abs(-2px)` is `2px` (proved non-negative, so projectable where `calc(-2px)`
 * is not), `hypot(3px)` is non-negative by construction, and a rounding
 * function can reach zero. The value is left unresolved because only the sign
 * and the type are read.
 */
function evaluateUnitFunction(name: string, parts: readonly CssNode[]): Evaluated {
  if (name === 'calc') {
    const comma = parts.some((part) => part.type === 'Operator' && (part.value ?? '').trim() === ',');
    return comma ? UNREADABLE : evaluateExpression(parts);
  }
  const arguments_ = argumentValues(parts);
  if (arguments_ === null || arguments_.length === 0) return UNREADABLE;
  const first = arguments_[0]!;
  if (arguments_.some((argument) => argument.type !== first.type || argument.type === 'other')) return UNREADABLE;
  const signs = arguments_.reduce((mask, argument) => mask | argument.sign, 0);
  if (name === 'abs') {
    return resultOf(first.type, first.unit, first.value === null ? null : Math.abs(first.value), signMagnitude(first.sign));
  }
  if (name === 'hypot') return resultOf(first.type, null, null, signMagnitude(signs));
  if (name === 'round' || name === 'mod' || name === 'rem') return resultOf(first.type, null, null, signs | SIGN_ZERO);
  return resultOf(first.type, null, null, signs);
}

/** A position in one function's child list, so the precedence walk can look ahead. */
type Cursor = { readonly parts: readonly CssNode[]; at: number };

/**
 * One expression, with CSS's own precedence: `*` and `/` bind tighter than `+`
 * and `-`, a `Parentheses` node is its own operand, and a sequence that is not
 * one expression — a missing operand, a stray token, two operands with no
 * operator between them — is `other` rather than a fold over whatever parsed.
 */
function evaluateExpression(parts: readonly CssNode[]): Evaluated {
  const cursor: Cursor = { parts, at: 0 };
  const evaluated = evaluateSum(cursor);
  return cursor.at === parts.length ? evaluated : UNREADABLE;
}

function evaluateSum(cursor: Cursor): Evaluated {
  let left = evaluateProduct(cursor);
  for (;;) {
    const operator = operatorAt(cursor);
    if (operator !== '+' && operator !== '-') return left;
    cursor.at += 1;
    left = combineOperands(operator, left, evaluateProduct(cursor));
  }
}

function evaluateProduct(cursor: Cursor): Evaluated {
  let left = evaluateOperand(cursor);
  for (;;) {
    const operator = operatorAt(cursor);
    if (operator !== '*' && operator !== '/') return left;
    cursor.at += 1;
    left = combineOperands(operator, left, evaluateOperand(cursor));
  }
}

/** The operator at the cursor, or null where the next part is not one. */
function operatorAt(cursor: Cursor): string | null {
  const part = cursor.parts[cursor.at];
  return part?.type === 'Operator' ? (part.value ?? '').trim() : null;
}

function evaluateOperand(cursor: Cursor): Evaluated {
  const part = cursor.parts[cursor.at];
  if (part === undefined) return UNREADABLE;
  cursor.at += 1;
  return evaluateNode(part);
}

/**
 * One operator over two operands, with CSS's type rules: `4px + 2` and
 * `1px * 1px` are not values the renderer keeps (`other` — measured: the
 * declaration is dropped while the displaced attribute survives), `2 * 4px` is
 * a length and `4px / 2px` a number (the units cancel).
 *
 * The result's sign is the sign of the number the operands resolved to where
 * they resolved to one (`calc(0px - 4px)` is `-4px`, `calc(100% - 50%)` is
 * `+50%`, `calc(4px / 0)` is positive infinity, which is what the renderer
 * computes too), and the operands' own signs where they resolved to none:
 * `1em + 2px` is positive whatever `em` resolves to, while `1em - 2px` carries
 * both signs and is refused on a property whose attribute form takes a negative
 * back.
 */
function combineOperands(operator: string, left: Evaluated, right: Evaluated): Evaluated {
  if (left.type === 'other' || right.type === 'other') return UNREADABLE;
  if (operator === '+' || operator === '-') {
    // Unlike types are the arithmetic the renderer's own parser drops
    // (`calc(4px + 2)`), and a percentage added to a length is a type of its
    // own that no measured row admits either.
    if (left.type !== right.type) return UNREADABLE;
    const sign = operator === '+'
      ? signSum(left.sign, right.sign)
      : signSum(left.sign, signNegated(right.sign));
    const value = left.unit === right.unit && left.value !== null && right.value !== null
      ? (operator === '+' ? left.value + right.value : left.value - right.value)
      : null;
    return resultOf(left.type, left.unit, value, sign);
  }
  if (operator === '*') {
    if (right.type === 'number') return product(left, right, signProduct(left.sign, right.sign));
    if (left.type === 'number') return product(right, left, signProduct(left.sign, right.sign));
    return UNREADABLE;
  }
  if (operator === '/') {
    if (right.type === 'number') {
      const value = left.value === null || right.value === null ? null : left.value / right.value;
      return resultOf(left.type, left.unit, value, signQuotient(left.sign, right.sign));
    }
    // A quotient of two same-typed values is a number — `4px / 2px` is `2`.
    if (left.type === right.type) {
      const value = left.unit === right.unit && left.value !== null && right.value !== null
        ? left.value / right.value
        : null;
      return resultOf('number', '', value, signQuotient(left.sign, right.sign));
    }
    return UNREADABLE;
  }
  return UNREADABLE;
}

/** One operand scaled by a number: the type and the unit survive, the sign does not. */
function product(target: Evaluated, factor: Evaluated, sign: number): Evaluated {
  const value = target.value === null || factor.value === null ? null : target.value * factor.value;
  return resultOf(target.type, target.unit, value, sign);
}

/**
 * Whether a value the function rules do not own — one scalar, a list of them,
 * or a list that carries a function — can be negative anywhere in it.
 *
 * The components are read one at a time: a scalar's own sign *is* its value's
 * sign, and a function component's is its result's, so `4 calc(-4px)` is
 * negative while `4 abs(-2px)` is not. A component this walk does not read at
 * all — a keyword, a `url()`, a `Raw` tail — is the grammar path's business.
 */
function anyNegativeComponent(value: string): boolean {
  const children = parse(value, { context: 'value' }).children?.toArray() ?? [];
  return children.some((child) => {
    const evaluated = evaluateNode(child);
    if (evaluated.type === 'other' && evaluated.value === null) return false;
    return (evaluated.sign & SIGN_NEGATIVE) !== 0;
  });
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
  if (PAINT_ATTRIBUTES[property] === true && isRelativeColour(value)) return value;
  return null;
}

/**
 * Whether a paint value is the relative-colour spelling `css-tree`'s colour
 * grammar does not parse: one function whose name is a measured colour function
 * and whose first argument is `from`.
 *
 * The row it belongs to is {@link RENDERER_KEPT_RELATIVE_COLOUR}; a spelling
 * outside it — `hwb(from …)`, or a malformed `rgb(from)` — is left to the
 * grammar path, which refuses it.
 */
function isRelativeColour(value: string): boolean {
  const children = parse(value, { context: 'value' }).children?.toArray() ?? [];
  const [only] = children;
  if (children.length !== 1 || only?.type !== 'Function') return false;
  if (RENDERER_KEPT_RELATIVE_COLOUR[asciiLower(only.name ?? '')] !== true) return false;
  const [first] = only.children?.toArray() ?? [];
  return first?.type === 'Identifier' && asciiLower(first.name ?? '') === 'from';
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
 * A paint property's value is a colour: the renderer's own palette functions —
 * the measured list in {@link COLOUR_FUNCTIONS}, compared in ASCII case — and
 * nothing else.
 *
 * Measured 2026-11-15 over the reachable spellings: every math function on
 * `fill`/`stroke` is dropped by the declaration form while the attribute form
 * is taken or ignored differently, so `fill:calc(4px)` and `fill:rgb(0 0 0 /
 * 50%)` are in different classes here for a measured reason — `rgb(...)` is a
 * colour and computes the same in both forms; `calc(...)` is not. A *malformed*
 * colour function is the grammar path's business, not this guard's: `fill:rgb()`
 * and `fill:hwb(120)` pass this name check and are then refused by the property
 * grammar, measured DIVERGENT in both (the renderer drops the declaration and
 * the projected attribute alike, so the element's own paint would go with them).
 */
function inspectColourFunctions(property: string, value: string): void {
  visitValue(value, (node) => {
    if (node.type === 'Function' && COLOUR_FUNCTIONS[asciiLower(node.name ?? '')] !== true) {
      throw new Error(`the renderer emitted a paint value with an unsupported function: ${property}: ${value}`);
    }
  });
}

/**
 * Whether the value carries a `var()`/`env()`/`attr()` reference, directly or in
 * a fallback. The names are compared in ASCII case like every other name here;
 * measured, `VAR(--pele-accent)` substitutes the token exactly as `var()` does.
 */
function hasReference(value: string): boolean {
  let found = false;
  visitValue(value, (node) => {
    if (node.type === 'Function' && REFERENCE_FUNCTIONS[asciiLower(node.name ?? '')] === true) found = true;
  });
  return found;
}

/**
 * The value's own function component evaluated, or null where the value is not
 * exactly one function call.
 *
 * `calc(4px)`, `min(4px)`, `sin(45deg)` and `var(--x)` are one function
 * component; `4px`, `4 -2` and `Georgia` are not, and a list is not either —
 * the measured tables read single function results, and a list is the grammar
 * path's business. A function that is *there* but unreadable (`Georgia()`)
 * evaluates to `other` and is not null, so the two outcomes are not the same
 * answer.
 */
function evaluateFunctionValue(value: string): Evaluated | null {
  const children = parse(value, { context: 'value' }).children?.toArray() ?? [];
  const [only] = children;
  return children.length === 1 && only !== undefined && only.type === 'Function'
    ? evaluateNode(only)
    : null;
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
        if (GEOMETRY_PROPERTIES[property] === true && GEOMETRY_KEYWORD_VALUES[asciiLower(value)] === true) {
          throw new Error(`the renderer emitted a style declaration whose attribute form is the zero length, not the value it names: ${property}: ${value}`);
        }
        const functionValue = evaluateFunctionValue(value);
        // The renderer's requirement is not the grammar's; the table above
        // records the properties where that difference is measured. The check
        // splits by shape, because the sign boundary does: a *scalar* component
        // negative (`-2px`, `-50%`, the second half of `4 -2`) is dropped from
        // the declaration for every property in NON_NEGATIVE, and a list is read
        // component by component so a negative inside a function in one counts
        // too — while a value that *is* one function is the function rules'
        // business below, not this one's.
        if (NON_NEGATIVE[property] === true && functionValue === null && anyNegativeComponent(value)) {
          throw new Error(`the renderer emitted a style declaration with a negative or undecided sign for a non-negative property: ${property}: ${value}`);
        }
        // A math function is decided by its *value type*, not by the grammar:
        // `css-tree` matches every function name without typing its arithmetic
        // (`lexer.matchProperty('rx', 'calc(4px + 2)')` matches), while the
        // renderer keeps a function only when its value is of the property's own
        // type. The type is evaluated — precedence, parentheses and ASCII case
        // included — and the table is measured; see FUNCTION_VALUE_TYPES.
        if (FUNCTION_VALUE_TYPES[property] !== undefined && functionValue !== null) {
          const { type } = functionValue;
          if (FUNCTION_VALUE_TYPES[property]?.[type] !== true) {
            throw new Error(`the renderer emitted a style declaration with a function the property does not keep (${TYPE_NAMES[type]}): ${property}: ${value}`);
          }
          // The second half of the sign rule, and the one that reads the
          // *result* rather than a minus sign in the source: for the properties
          // whose attribute form takes a negative back, a length- or
          // percentage-valued function must be provably non-negative, and a
          // result whose sign the walk does not resolve is refused rather than
          // guessed. A number-valued result is taken back by neither form
          // (`rx:calc(4 - 8)` computes `calc(-4px)` in both), so it passes.
          if (FUNCTION_NEGATIVE_TAKEN_BACK[property] === true && type !== 'number'
            && (functionValue.sign & SIGN_NEGATIVE) !== 0) {
            throw new Error(`the renderer emitted a style declaration whose result is not provably non-negative for a property whose attribute form takes a negative back: ${property}: ${value}`);
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
