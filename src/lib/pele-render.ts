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
 *    property and the value. No conversion, no silent drop.
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
 * stripped, and `rx: 4`, `rx: var(--_R)` or `RX: var(--_r)` beside it is an
 * author declaration and is refused. That is the point of pinning the set — a
 * near miss is the case a conversion used to guess at.
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
            + ' after a pele upgrade; an author %%{init}%% theme adds --pele-series-* declarations here, and this'
            + ' engine refuses every author declaration rather than converting it)',
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
    const { svg } = render(source, { idPrefix: diagramId, links: false, images: false, now: 0 });
    return sanitizeSvg(svg, accessibleName);
  } catch (error) {
    throw new DiagramError(source, error instanceof Error ? error.message.split('\n')[0]! : String(error));
  }
}
