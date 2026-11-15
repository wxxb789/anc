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
 *    the same cascade position. Where the element already has that attribute,
 *    the declaration wins and the attribute is replaced: a `style` attribute
 *    outranks a presentation attribute in CSS, so that is the rendering Pele
 *    produced, not a preference.
 * 2. **`rx: var(--_r)`** — the one declaration a presentation attribute cannot
 *    take, because `var()` does not resolve there. It stays a class, with the
 *    value supplied by `.diagram svg.pele .pele-rounded` in `diagram.css`.
 * 3. **The root `style` block** — Pele's palette, its measurement font and the
 *    reset of the inheritable text properties, as one attribute on `<svg>`.
 *    `src/styles/diagram.css` re-creates it under `.diagram svg.pele` and
 *    `.diagram svg`; {@link ROOT_STYLE_RULES} is that list, so a declaration
 *    added upstream stops the build instead of disappearing.
 */

import { parse, walk } from 'css-tree';
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
  'baseline-shift': true, 'letter-spacing': true,
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
