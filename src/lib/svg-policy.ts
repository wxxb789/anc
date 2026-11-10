/**
 * The static, self-contained SVG subset: a namespace-aware XML walk plus the CSS
 * policy, and the measurements a rasterizer needs from it.
 *
 * This module is **policy only**. It reads bytes, never a filesystem path, and it
 * never renders. `svg-render.ts` turns an accepted document into WebP; keeping
 * the two apart means the security gate is tested without a native binding and
 * the renderer cannot be reached by a document this file refused.
 *
 * ## What is accepted
 *
 * A single `<svg>` root in the SVG namespace, drawing elements from the static
 * subset (shapes, paths, groups, `defs`/`symbol`/`use`, gradients, patterns, clip
 * paths, masks, markers, static filters, and text), styled by attributes, a
 * `style` attribute or a `<style>` sheet, and referencing only **fragments of the
 * same document** (`href="#id"`, `xlink:href="#id"`, `url(#grad)`). No external
 * resource can be named, so the renderer has nothing to resolve even before the
 * byte-buffer boundary denies it a base URI.
 *
 * ## What is refused, and why by construct rather than by text
 *
 * - A `DOCTYPE` event or an entity reference beyond XML's predefined five. The
 *   saxes parser is configured without a DTD resolver and reports an undefined
 *   entity as an error; a DTD is refused before it can declare one.
 * - `XInclude`, `script`, `foreignObject`, animation elements, `on*` handlers,
 *   `xmlns`-relative foreign namespaces, `xml:base`, and processing instructions.
 * - Every `href`/`xlink:href` and every CSS `url()` that is not a fragment,
 *   classified by the **decoded** value (see `svg-css.ts`), so an escaped
 *   `\6a avascript:` is the script URL it resolves to.
 * - Every `data:` payload, with its own diagnostic. That is the design's bounded
 *   choice rather than an unimplemented embedding path.
 * - Documents and declared surfaces beyond finite budgets, before a pixel is
 *   allocated: element count, nesting depth, `use` count, text volume, filter
 *   primitive count, standard deviations, filter regions and convolution
 *   kernels.
 *
 * ## What it returns
 *
 * The logical size to rasterize — explicit absolute `width`/`height` when both are
 * usable, otherwise the `viewBox` — and the visible text runs, which the renderer
 * probes against the host's fonts. A `viewBox`-only document has no author-chosen
 * CSS size, so the renderer derives one from the article layout; this module
 * reports what the author wrote and leaves that product decision where the
 * measurement is.
 */

import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';
import { inspectPresentationAttribute, inspectReference, inspectStyleAttribute, inspectStyleSheet } from './svg-css.ts';
import type { SvgRefusal } from './svg-refusal.ts';

/** The SVG namespace every accepted element must be in. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The legacy link namespace, accepted for `href`, `title` and `role`. */
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/** The XInclude namespace, refused with its own diagnostic. */
const XINCLUDE_NAMESPACE = 'http://www.w3.org/2001/XInclude';

/** XML's own namespace, accepted only for `xml:lang` and `xml:space`. */
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

/** Namespace declarations themselves; saxes reports them as attributes. */
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** The finite work limits one document is inspected against. */
export interface SvgLimits {
  /** Elements in the document. */
  readonly maxElements: number;
  /** Element nesting depth. */
  readonly maxDepth: number;
  /** `<use>` elements, the expansion primitive. */
  readonly maxUses: number;
  /** Instances produced by expanding `<use>` references. */
  readonly maxUseInstances: number;
  /** Characters of visible text across every `<text>` subtree. */
  readonly maxTextCharacters: number;
  /** Characters of CSS across every `<style>` element. */
  readonly maxStyleCharacters: number;
  /** Distinct characters the host-font coverage check will attempt. */
  readonly maxDistinctTextCharacters: number;
  /** Filter primitives across every `<filter>`. */
  readonly maxFilterPrimitives: number;
  /** Absolute user-unit ceiling for one filter region side. */
  readonly maxFilterRegion: number;
  /** Percentage ceiling for one filter region side. */
  readonly maxFilterRegionPercent: number;
  /** Ceiling for a `stdDeviation` component, in user units. */
  readonly maxStdDeviation: number;
  /** Ceiling for a convolution kernel's entry count. */
  readonly maxKernelEntries: number;
  /** Ceiling for `feTurbulence`'s `numOctaves`. */
  readonly maxTurbulenceOctaves: number;
}

/**
 * Chosen to admit an ordinary diagram export (tens to low hundreds of elements,
 * a handful of filters) while refusing a synthetic flood long before libvips is
 * asked for a surface. The render-budget half lives in `svg-render.ts`, because
 * it is about pixels rather than syntax.
 */
export const SVG_POLICY_LIMITS: SvgLimits = Object.freeze({
  maxElements: 20_000,
  maxDepth: 128,
  maxUses: 500,
  maxUseInstances: 16_384,
  maxTextCharacters: 100_000,
  maxStyleCharacters: 1_000_000,
  maxDistinctTextCharacters: 4_096,
  maxFilterPrimitives: 100,
  maxFilterRegion: 20_000,
  maxFilterRegionPercent: 500,
  maxStdDeviation: 1_000,
  maxKernelEntries: 100,
  maxTurbulenceOctaves: 16,
});

/** A `viewBox` as four finite numbers. */
interface SvgViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The facts an accepted document contributes to the render decision. */
export interface SvgSource {
  /** Logical `width` in CSS pixels: declared, or inferred from the viewBox. */
  readonly width?: number;
  /** Logical `height` in CSS pixels: declared, or inferred from the viewBox. */
  readonly height?: number;
  /**
   * Whether an absolute width or height was written.
   *
   * A percentage, `em` or `ex` size follows the viewport or the font rather than
   * declaring a logical picture size, so it does not count: such a document is
   * laid out like a `viewBox`-only one. This flag is what lets the renderer give
   * an explicit size precedence and derive the article width otherwise. When one
   * side was declared and the other came from the viewBox, this stays true and
   * both fields carry the inferred pair.
   */
  readonly declaredSize: boolean;
  /**
   * How librsvg scales the document with `density`.
   *
   * `linear` for unitless/`px`/percentage dimensions, and `physical` for
   * `pt`/`pc`/`mm`/`cm`/`in`. Measured against the pinned sharp: a `100mm` width
   * renders 283 px at density 72 and 1134 px at 144 — the physical-unit branch
   * is evaluated at the requested DPI *and* scaled by it again — while `100px`
   * renders 100 then 200. The renderer's density formula depends on this
   * distinction, so the policy reports it instead of letting the renderer guess.
   */
  readonly sizeScale: 'linear' | 'physical';
  /**
   * Text runs in document order, including text inside an unused `defs` or
   * `symbol`; excludes `title`, `desc` and `style`. The font gate checks all of
   * them because proving a symbol is unreferenced is not worth the failure
   * direction.
   */
  readonly text: readonly string[];
}

/** What inspecting one candidate produced. */
export type SvgInspection =
  | { readonly ok: true; readonly source: SvgSource }
  | { readonly ok: false; readonly refusal: SvgRefusal };

/* ------------------------------------------------------------------------- *
 * Element and attribute policy
 * ------------------------------------------------------------------------- */

/**
 * Elements this subset draws.
 *
 * An allowlist, not a denylist, for the reason the design gives: a feature the
 * policy does not understand must fail rather than render as a misleading
 * partial diagram. `feImage` is absent because it names a resource; `metadata` is
 * absent because this build does not render it and will not walk arbitrary
 * foreign XML to prove that.
 */
const ALLOWED_ELEMENTS: Readonly<Record<string, true>> = {
  svg: true,
  g: true,
  defs: true,
  desc: true,
  title: true,
  style: true,
  symbol: true,
  use: true,
  view: true,
  rect: true,
  circle: true,
  ellipse: true,
  line: true,
  polyline: true,
  polygon: true,
  path: true,
  text: true,
  tspan: true,
  textPath: true,
  a: true,
  linearGradient: true,
  radialGradient: true,
  stop: true,
  pattern: true,
  clipPath: true,
  mask: true,
  marker: true,
  filter: true,
  feBlend: true,
  feColorMatrix: true,
  feComponentTransfer: true,
  feComposite: true,
  feConvolveMatrix: true,
  feDiffuseLighting: true,
  feDisplacementMap: true,
  feDropShadow: true,
  feFlood: true,
  feFuncA: true,
  feFuncB: true,
  feFuncG: true,
  feFuncR: true,
  feGaussianBlur: true,
  feMerge: true,
  feMergeNode: true,
  feMorphology: true,
  feOffset: true,
  fePointLight: true,
  feSpecularLighting: true,
  feSpotLight: true,
  feTile: true,
  feTurbulence: true,
};

/**
 * Attributes with no resource-loading meaning.
 *
 * Grouped by what they do rather than alphabetised, so a new entry lands in a
 * reviewable place. `href`/`xlink:href` are absent because they get their own
 * fragment-only check; `style` is absent because it is parsed.
 */
const ALLOWED_ATTRIBUTES: Readonly<Record<string, true>> = {
  // Core, accessibility and styling hooks.
  id: true,
  class: true,
  role: true,
  tabindex: true,
  lang: true,
  // Geometry.
  x: true,
  y: true,
  z: true,
  x1: true,
  y1: true,
  x2: true,
  y2: true,
  width: true,
  height: true,
  rx: true,
  ry: true,
  r: true,
  cx: true,
  cy: true,
  fx: true,
  fy: true,
  fr: true,
  d: true,
  points: true,
  pathLength: true,
  viewBox: true,
  preserveAspectRatio: true,
  transform: true,
  'transform-origin': true,
  version: true,
  baseProfile: true,
  // Paint and compositing.
  fill: true,
  'fill-opacity': true,
  'fill-rule': true,
  stroke: true,
  'stroke-width': true,
  'stroke-opacity': true,
  'stroke-linecap': true,
  'stroke-linejoin': true,
  'stroke-miterlimit': true,
  'stroke-dasharray': true,
  'stroke-dashoffset': true,
  'paint-order': true,
  color: true,
  opacity: true,
  display: true,
  visibility: true,
  overflow: true,
  clip: true,
  'clip-path': true,
  'clip-rule': true,
  mask: true,
  filter: true,
  'mix-blend-mode': true,
  isolation: true,
  'vector-effect': true,
  'shape-rendering': true,
  'text-rendering': true,
  'image-rendering': true,
  'color-interpolation': true,
  'color-interpolation-filters': true,
  'color-rendering': true,
  'pointer-events': true,
  'marker-start': true,
  'marker-mid': true,
  'marker-end': true,
  // Text.
  'font-family': true,
  'font-size': true,
  'font-size-adjust': true,
  'font-stretch': true,
  'font-style': true,
  'font-variant': true,
  'font-weight': true,
  'letter-spacing': true,
  'word-spacing': true,
  kerning: true,
  'text-anchor': true,
  'text-decoration': true,
  'writing-mode': true,
  direction: true,
  'unicode-bidi': true,
  'dominant-baseline': true,
  'alignment-baseline': true,
  'baseline-shift': true,
  'white-space': true,
  textLength: true,
  lengthAdjust: true,
  startOffset: true,
  method: true,
  spacing: true,
  // Gradients and patterns.
  offset: true,
  'stop-color': true,
  'stop-opacity': true,
  'flood-color': true,
  'flood-opacity': true,
  'lighting-color': true,
  gradientUnits: true,
  gradientTransform: true,
  spreadMethod: true,
  patternUnits: true,
  patternContentUnits: true,
  patternTransform: true,
  // Clip paths, masks and markers.
  clipPathUnits: true,
  maskUnits: true,
  maskContentUnits: true,
  markerWidth: true,
  markerHeight: true,
  markerUnits: true,
  refX: true,
  refY: true,
  orient: true,
  // Filters.
  filterUnits: true,
  primitiveUnits: true,
  in: true,
  in2: true,
  result: true,
  mode: true,
  operator: true,
  type: true,
  values: true,
  tableValues: true,
  slope: true,
  intercept: true,
  amplitude: true,
  exponent: true,
  scale: true,
  baseFrequency: true,
  numOctaves: true,
  seed: true,
  stitchTiles: true,
  xChannelSelector: true,
  yChannelSelector: true,
  radius: true,
  stdDeviation: true,
  dx: true,
  dy: true,
  rotate: true,
  order: true,
  kernelMatrix: true,
  divisor: true,
  bias: true,
  targetX: true,
  targetY: true,
  edgeMode: true,
  preserveAlpha: true,
  surfaceScale: true,
  diffuseConstant: true,
  specularConstant: true,
  specularExponent: true,
  limitingConeAngle: true,
  pointsAtX: true,
  pointsAtY: true,
  pointsAtZ: true,
  k1: true,
  k2: true,
  k3: true,
  k4: true,
};

/**
 * Presentation attributes that accept `url(...)`.
 *
 * Every one is parsed as a CSS value, not scanned for the text `url(`. `cursor`
 * is absent with the attribute from the allowlist: it is a pointer-interaction
 * property, and an SVG served as an image has no pointer to style.
 */
const URL_ATTRIBUTES: Readonly<Record<string, true>> = {
  fill: true,
  stroke: true,
  filter: true,
  'clip-path': true,
  mask: true,
  'marker-start': true,
  'marker-mid': true,
  'marker-end': true,
};

/** SVG's number grammar, shared by every budget argument below. */
const NUMBER_PATTERN = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const LENGTH_PATTERN = new RegExp(String.raw`^\s*(${NUMBER_PATTERN})\s*([A-Za-z]*)\s*$`);
const PERCENT_PATTERN = new RegExp(String.raw`^\s*(${NUMBER_PATTERN})\s*%\s*$`);
const NUMBER_PATTERN_ONLY = new RegExp(String.raw`^\s*(${NUMBER_PATTERN})\s*$`);

/**
 * CSS pixel size of one absolute SVG length unit, and whether librsvg
 * re-evaluates it at the requested DPI.
 *
 * Measured rather than assumed: see {@link SvgSource.sizeScale}. One table, so
 * adding a unit cannot silently miss its density class.
 */
const LENGTH_UNITS: Readonly<Record<string, { readonly px: number; readonly physical: boolean }>> = {
  px: { px: 1, physical: false },
  pt: { px: 4 / 3, physical: true },
  pc: { px: 16, physical: true },
  mm: { px: 96 / 25.4, physical: true },
  cm: { px: 96 / 2.54, physical: true },
  in: { px: 96, physical: true },
};

/** One parsed length attribute: its CSS-pixel value and how it scales. */
interface ParsedLength {
  readonly px: number;
  readonly physical: boolean;
}

/** A finite, positive number, or `undefined`. */
function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Parse a signed SVG length; `undefined` for a unit this subset does not know. */
function parseSignedLength(raw: string | undefined): ParsedLength | undefined {
  if (raw === undefined) return undefined;
  const match = LENGTH_PATTERN.exec(raw);
  if (match === null) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  const scale = unit === '' ? { px: 1, physical: false } : LENGTH_UNITS[unit];
  if (scale === undefined) return undefined;
  const px = Number(match[1]) * scale.px;
  return Number.isFinite(px) ? { px, physical: scale.physical } : undefined;
}

/**
 * Parse an SVG length attribute to CSS pixels and classify its scaling.
 *
 * A percentage, `em`, `ex` or `ch` depends on a viewport or a font, so it is
 * treated as absent rather than guessed. The renderer then falls back to the
 * document's measured natural size, which is the size librsvg itself chose.
 */
function parseLength(raw: string | undefined): ParsedLength | undefined {
  const parsed = parseSignedLength(raw);
  return parsed !== undefined && parsed.px > 0 ? parsed : undefined;
}

/** Parse `viewBox` into four finite numbers with a positive size. */
function parseViewBox(raw: string | undefined): SvgViewBox | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.trim().split(/[\s,]+/);
  if (parts.length !== 4) return undefined;
  const [x, y, width, height] = parts.map(Number);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return undefined;
  if (!positive(width) || !positive(height)) return undefined;
  return { x: x!, y: y!, width: width!, height: height! };
}

/**
 * Decode the document's bytes as UTF-8.
 *
 * The producer's `looksLikeSvg` signature is byte-based and selects an SVG only
 * from UTF-8 text, so the policy is UTF-8-only too. A UTF-16 document is
 * reported as an unsupported file by the producer rather than parsed here.
 */
function decodeDocument(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Instances produced by expanding `<use>` references, with a DP over the id
 * graph. A literal `<use>` counts once, plus the rendered subtree of its target;
 * the total is the work librsvg would perform even though the XML is small.
 *
 * Elements in a definition container are not rendered on their own: a `<use>`
 * inside `<defs>` or an unreferenced `<symbol>` contributes nothing until a
 * resolving `<use>` expands it. A target's own subtree is rendered, but nested
 * definition containers inside it are still skipped. The count is deliberately a
 * conservative upper bound (every use counts, including a use under a hidden
 * branch); the budget exists to bound work, not to prove a picture's exact shape.
 */
function expandedUseInstances(
  nodes: readonly string[],
  useTargets: readonly (string | undefined)[],
  children: readonly (readonly number[])[],
  idNodes: ReadonlyMap<string, number>,
  root: number,
): number {
  const nonRendered: Readonly<Record<string, true>> = {
    defs: true,
    symbol: true,
    clipPath: true,
    mask: true,
    pattern: true,
    linearGradient: true,
    radialGradient: true,
    filter: true,
    marker: true,
    style: true,
    title: true,
    desc: true,
    view: true,
  };
  const expansion = new Map<number, number>();
  const visiting = new Set<number>();

  const countSubtree = (index: number): number => {
    let total = 0;
    const target = useTargets[index];
    if (target !== undefined) total = 1 + expand(target);
    for (const child of children[index] ?? []) {
      if (nonRendered[nodes[child] ?? ''] === true) continue;
      total += countSubtree(child);
    }
    return total;
  };

  const expand = (id: string): number => {
    const index = idNodes.get(id);
    if (index === undefined) return 0;
    const memo = expansion.get(index);
    if (memo !== undefined) return memo;
    if (visiting.has(index)) return Number.POSITIVE_INFINITY;
    visiting.add(index);
    const total = countSubtree(index);
    visiting.delete(index);
    expansion.set(index, total);
    return total;
  };

  return countSubtree(root);
}

/** The reason a tag name or attribute has no place in this subset. */
function namespaceFault(uri: string, name: string): SvgRefusal {
  if (uri === XINCLUDE_NAMESPACE) {
    return { reason: 'svg-xinclude', detail: `${name}: XInclude is not part of the static subset` };
  }
  return { reason: 'svg-foreign', detail: `${name}: unsupported namespace ${JSON.stringify(uri)}` };
}

/**
 * Inspect one SVG candidate: the single security decision of Goal 0012.
 *
 * @param bytes The already-authorized source bytes; never a path.
 * @param limits Finite work limits. Tests inject smaller ones.
 */
export function inspectSvg(bytes: Uint8Array, limits: SvgLimits = SVG_POLICY_LIMITS): SvgInspection {
  const text = decodeDocument(bytes);
  if (text === undefined) {
    return { ok: false, refusal: { reason: 'svg-invalid', detail: 'not a UTF-8 XML document' } };
  }

  let refusal: SvgRefusal | undefined;
  let rootSeen = false;
  let elements = 0;
  let depth = 0;
  let uses = 0;
  let filterPrimitives = 0;
  let textDepth = 0;
  let styleDepth = 0;
  let titleDescDepth = 0;
  const textBuffers: string[] = [];
  let styleBuffer = '';
  const textRuns: string[] = [];
  let textCharacters = 0;
  let rootWidth: ParsedLength | undefined;
  let rootHeight: ParsedLength | undefined;
  let rootViewBox: SvgViewBox | undefined;
  const nodes: string[] = [];
  const useTargets: (string | undefined)[] = [];
  const childNodes: number[][] = [];
  const elementStack: number[] = [];
  const idNodes = new Map<string, number>();

  const fail = (fault: SvgRefusal): void => {
    if (refusal === undefined) refusal = fault;
  };

  const parser = new SaxesParser({ xmlns: true, position: true });

  parser.on('error', (error) => {
    const entity = /entit/i.test(error.message);
    fail({
      reason: entity ? 'svg-doctype' : 'svg-invalid',
      detail: error.message.split('\n')[0] ?? 'XML parse error',
    });
  });

  parser.on('doctype', () => {
    fail({ reason: 'svg-doctype', detail: 'a DOCTYPE declaration; DTDs and entity declarations are refused' });
  });

  parser.on('processinginstruction', (instruction) => {
    fail(
      instruction.target.toLowerCase() === 'xml-stylesheet'
        ? { reason: 'svg-external', detail: 'an xml-stylesheet processing instruction' }
        : { reason: 'svg-unsafe', detail: `processing instruction <?${instruction.target}?>` },
    );
  });

  parser.on('opentag', (tag: SaxesTagNS) => {
    if (refusal !== undefined) return;
    elements += 1;
    depth += 1;
    if (elements > limits.maxElements) {
      fail({ reason: 'svg-workload', detail: `more than ${limits.maxElements} elements` });
      return;
    }
    if (depth > limits.maxDepth) {
      fail({ reason: 'svg-workload', detail: `nesting deeper than ${limits.maxDepth} elements` });
      return;
    }

    const local = tag.local;
    if (!rootSeen) {
      rootSeen = true;
      if (local !== 'svg') {
        fail({ reason: 'svg-invalid', detail: `root element is <${tag.name}>, not <svg>` });
        return;
      }
      if (tag.uri === '') {
        fail({
          reason: 'svg-unsafe',
          detail: 'the root <svg> has no namespace; add xmlns="http://www.w3.org/2000/svg"',
        });
        return;
      }
      if (tag.uri !== SVG_NAMESPACE) {
        fail(namespaceFault(tag.uri, `<${tag.name}>`));
        return;
      }
      rootViewBox = parseViewBox(tag.attributes['viewBox']?.value);
      rootWidth = parseLength(tag.attributes['width']?.value);
      rootHeight = parseLength(tag.attributes['height']?.value);
    } else if (tag.uri !== SVG_NAMESPACE) {
      fail(namespaceFault(tag.uri, `<${tag.name}>`));
      return;
    }

    // Active-content elements are refused by name before any attribute is read:
    // their attributes are not part of the subset either, and "unsupported
    // attribute `attributeName`" would send an author to edit the wrong thing.
    if (local === 'script') {
      fail({ reason: 'svg-script', detail: '<script> is active content' });
      return;
    }
    if (local === 'foreignObject') {
      fail({ reason: 'svg-foreign', detail: '<foreignObject> is not part of the static subset' });
      return;
    }
    if (local.startsWith('animate') || local === 'set' || local === 'discard') {
      fail({ reason: 'svg-animation', detail: `<${local}> animates the drawing` });
      return;
    }
    if (local === 'metadata') {
      fail({ reason: 'svg-unsafe', detail: '<metadata> is not drawn; delete the metadata block' });
      return;
    }
    if (local === 'style' && styleDepth > 0) {
      fail({
        reason: 'svg-css',
        detail: '<style> inside <style> is not part of the static subset; nested stylesheets are refused',
      });
      return;
    }

    // Attributes are checked **before** the element allowlist, so a construct the
    // design names gets its own reason: `<image href="data:…">` reports an
    // embedded payload, `<image xlink:href="file:…">` an external reference, and
    // only an `<image>` with no offending reference falls through to "this element
    // is not in the subset". A policy that named the element first would report
    // every embedded asset as a generic unsupported element.
    for (const attribute of Object.values(tag.attributes)) {
      const attributeRefusal = checkAttribute(local, attribute, limits);
      if (attributeRefusal !== undefined) {
        fail(attributeRefusal);
        return;
      }
    }

    if (local === 'image' || local === 'feImage') {
      fail({
        reason: 'svg-external',
        detail: `<${local}> loads a resource into the drawing; embed pictures with ordinary Markdown instead`,
      });
      return;
    }
    if (ALLOWED_ELEMENTS[local] !== true) {
      fail({ reason: 'svg-unsafe', detail: `<${local}> is not part of the static subset` });
      return;
    }
    if (local === 'use') {
      uses += 1;
      if (uses > limits.maxUses) {
        fail({ reason: 'svg-workload', detail: `more than ${limits.maxUses} <use> references` });
        return;
      }
    }
    if (local.startsWith('fe')) filterPrimitives += 1;
    if (filterPrimitives > limits.maxFilterPrimitives) {
      fail({ reason: 'svg-workload', detail: `more than ${limits.maxFilterPrimitives} filter primitives` });
      return;
    }

    // Record the accepted tree for the `<use>` expansion count. The element
    // stack mirrors XML nesting; ids are first-wins here as in a renderer, and a
    // same-document fragment is the only reference shape the policy admits.
    const nodeIndex = nodes.length;
    nodes.push(local);
    useTargets.push(undefined);
    childNodes.push([]);
    const parentNode = elementStack.at(-1);
    if (parentNode !== undefined) childNodes[parentNode]!.push(nodeIndex);
    elementStack.push(nodeIndex);
    const elementId = tag.attributes['id']?.value;
    if (elementId !== undefined && !idNodes.has(elementId)) idNodes.set(elementId, nodeIndex);
    if (local === 'use') {
      const href = tag.attributes['href']?.value ?? tag.attributes['xlink:href']?.value;
      if (href !== undefined && href.startsWith('#') && href.length > 1) {
        useTargets[nodeIndex] = href.slice(1);
      }
    }

    if (local === 'style') {
      styleDepth += 1;
      styleBuffer = '';
    }
    if (local === 'title' || local === 'desc') titleDescDepth += 1;
    if (local === 'text') {
      textDepth += 1;
      textBuffers.push('');
    }
  });

  parser.on('text', (value: string) => {
    if (refusal !== undefined) return;
    if (styleDepth > 0) {
      // A `<style>` is parsed as one sheet when it closes. saxes may split its
      // text at an entity or CDATA boundary, and parsing each fragment would
      // treat a valid sheet as two malformed ones.
      styleBuffer += value;
      if (styleBuffer.length > limits.maxStyleCharacters) {
        fail({ reason: 'svg-workload', detail: `more than ${limits.maxStyleCharacters} characters of CSS` });
      }
      return;
    }
    if (textDepth > 0 && titleDescDepth === 0) {
      const index = textBuffers.length - 1;
      if (index >= 0) textBuffers[index] = (textBuffers[index] ?? '') + value;
      textCharacters += value.length;
      if (textCharacters > limits.maxTextCharacters) {
        fail({ reason: 'svg-workload', detail: `more than ${limits.maxTextCharacters} characters of text` });
      }
    }
  });

  parser.on('cdata', (value: string) => {
    if (refusal !== undefined) return;
    if (styleDepth > 0) {
      // A `<style>` is parsed as one sheet when it closes. saxes may split its
      // text at an entity or CDATA boundary, and parsing each fragment would
      // treat a valid sheet as two malformed ones.
      styleBuffer += value;
      if (styleBuffer.length > limits.maxStyleCharacters) {
        fail({ reason: 'svg-workload', detail: `more than ${limits.maxStyleCharacters} characters of CSS` });
      }
      return;
    }
    if (textDepth > 0 && titleDescDepth === 0) {
      const index = textBuffers.length - 1;
      if (index >= 0) textBuffers[index] = (textBuffers[index] ?? '') + value;
      textCharacters += value.length;
      if (textCharacters > limits.maxTextCharacters) {
        fail({ reason: 'svg-workload', detail: `more than ${limits.maxTextCharacters} characters of text` });
      }
    }
  });

  parser.on('closetag', (tag: SaxesTagNS) => {
    if (depth > 0) depth -= 1;
    if (elementStack.length > 0) elementStack.pop();
    if (refusal !== undefined) {
      // Keep depth coherent for the remaining events, but stop inspecting.
      if (tag.local === 'style' && styleDepth > 0) {
        styleDepth -= 1;
        styleBuffer = '';
      }
      if ((tag.local === 'title' || tag.local === 'desc') && titleDescDepth > 0) titleDescDepth -= 1;
      if (tag.local === 'text' && textDepth > 0) {
        textDepth -= 1;
        textBuffers.pop();
      }
      return;
    }
    if (tag.local === 'style' && styleDepth > 0) {
      styleDepth -= 1;
      const styleRefusal = inspectStyleSheet(styleBuffer);
      if (styleRefusal !== undefined) fail(styleRefusal);
      styleBuffer = '';
    }
    if ((tag.local === 'title' || tag.local === 'desc') && titleDescDepth > 0) titleDescDepth -= 1;
    if (tag.local === 'text' && textDepth > 0) {
      textDepth -= 1;
      const run = textBuffers.pop() ?? '';
      if (run !== '') {
        const parent = textBuffers.length - 1;
        if (parent >= 0) textBuffers[parent] = (textBuffers[parent] ?? '') + run;
        else textRuns.push(run);
      }
    }
  });

  try {
    parser.write(text).close();
  } catch (error) {
    fail({
      reason: 'svg-invalid',
      detail: error instanceof Error ? error.message.split('\n')[0]! : String(error),
    });
  }

  if (refusal !== undefined) return { ok: false, refusal };
  if (!rootSeen) return { ok: false, refusal: { reason: 'svg-invalid', detail: 'the document has no root element' } };

  if (uses > 0) {
    const instances = expandedUseInstances(nodes, useTargets, childNodes, idNodes, 0);
    if (!Number.isFinite(instances) || instances > limits.maxUseInstances) {
      return {
        ok: false,
        refusal: {
          reason: 'svg-workload',
          detail: Number.isFinite(instances)
            ? `expanding <use> creates ${instances} instances, more than ${limits.maxUseInstances}; reduce references or replace them with drawn geometry`
            : `the <use> graph never terminates or exceeds the instance budget of ${limits.maxUseInstances}; break the cycle`,
        },
      };
    }
  }

  // A width without a height (or the reverse) is only usable when a viewBox
  // supplies the other side; otherwise the document declares no shape at all.
  let width = rootWidth?.px;
  let height = rootHeight?.px;
  if (rootViewBox !== undefined) {
    const ratio = rootViewBox.height / rootViewBox.width;
    if (width === undefined && height === undefined) {
      // The viewBox is the whole size. librsvg uses its units as CSS pixels when
      // no CSS size is written, which is what the renderer measures anyway.
      width = rootViewBox.width;
      height = rootViewBox.height;
    } else if (width !== undefined && height === undefined) {
      height = width * ratio;
    } else if (height !== undefined && width === undefined) {
      width = height / ratio;
    }
  }
  if (width === undefined || height === undefined) {
    return {
      ok: false,
      refusal: {
        reason: 'svg-invalid',
        detail: 'no usable size: give both absolute width and height, or a viewBox',
      },
    };
  }

  // A physical width with a unitless height changes the picture's aspect ratio as
  // the render density rises, because the two branches scale differently. There
  // is no density at which that document has the aspect ratio its author wrote
  // down, so refuse it rather than publish a distorted diagram.
  if (
    rootWidth !== undefined &&
    rootHeight !== undefined &&
    rootWidth.physical !== rootHeight.physical
  ) {
    return {
      ok: false,
      refusal: {
        reason: 'svg-invalid',
        detail: 'width and height mix physical units with px/unitless units; use one unit for both',
      },
    };
  }

  return {
    ok: true,
    source: {
      width,
      height,
      declaredSize: rootWidth !== undefined || rootHeight !== undefined,
      sizeScale: rootWidth?.physical === true || rootHeight?.physical === true ? 'physical' : 'linear',
      text: textRuns,
    },
  };
}

/**
 * The distinct characters that need a host glyph, filtered and deduplicated.
 *
 * Whitespace, combining marks and Unicode format characters (zero-width
 * joiners, variation selectors, soft hyphen, BOM and bidi controls) are excluded
 * because they are not standalone glyphs: a lone mark combines with a preceding
 * base, and a format character draws nothing by definition. The caller maps
 * these characters to code points and asks `font-coverage.ts`.
 */
export function requiredCharacters(source: SvgSource, limits: SvgLimits = SVG_POLICY_LIMITS): string[] | SvgRefusal {
  const seen = new Set<string>();
  const characters: string[] = [];
  for (const run of source.text) {
    for (const character of run) {
      if (/\s/u.test(character) || /\p{M}/u.test(character) || /\p{Cf}/u.test(character)) continue;
      if (seen.has(character)) continue;
      seen.add(character);
      characters.push(character);
      if (characters.length > limits.maxDistinctTextCharacters) {
        return {
          reason: 'svg-workload',
          detail: `more than ${limits.maxDistinctTextCharacters} distinct text characters`,
        };
      }
    }
  }
  return characters;
}

/** One attribute's policy check. */
function checkAttribute(element: string, attribute: SaxesAttributeNS, limits: SvgLimits): SvgRefusal | undefined {
  const { local, uri } = attribute;
  const value = attribute.value;
  const where = `${element}@${attribute.prefix === '' ? local : `${attribute.prefix}:${local}`}`;

  if (uri === XMLNS_NAMESPACE) return undefined;

  // An event handler is active regardless of the namespace spelling it chose.
  if (/^on[a-z]+$/i.test(local)) {
    return { reason: 'svg-script', detail: `${where}: event handler attribute` };
  }

  if (uri === XLINK_NAMESPACE) {
    if (local === 'href') return inspectReference(value, where);
    if (local === 'title' || local === 'role') return undefined;
    return { reason: 'svg-foreign', detail: `${where}: unsupported attribute namespace ${JSON.stringify(uri)}` };
  }
  if (uri === XML_NAMESPACE) {
    if (local === 'lang' || local === 'space') return undefined;
    if (local === 'base') {
      return { reason: 'svg-external', detail: `${where}: xml:base changes how references resolve` };
    }
    return { reason: 'svg-unsafe', detail: `${where}: unsupported xml attribute` };
  }
  if (uri !== '' && uri !== SVG_NAMESPACE) {
    return { reason: 'svg-foreign', detail: `${where}: unsupported attribute namespace ${JSON.stringify(uri)}` };
  }

  if (local === 'href') return inspectReference(value, where);
  if (local === 'style') {
    if (value.length > limits.maxStyleCharacters) {
      return {
        reason: 'svg-workload',
        detail: `${where}: more than ${limits.maxStyleCharacters} characters of CSS`,
      };
    }
    return inspectStyleAttribute(value);
  }

  if (local.startsWith('data-') || local.startsWith('aria-')) return undefined;

  if (ALLOWED_ATTRIBUTES[local] !== true) {
    return { reason: 'svg-unsafe', detail: `${where}: attribute is not part of the static subset` };
  }

  if (URL_ATTRIBUTES[local] === true) {
    const refusal = inspectPresentationAttribute(where, value);
    if (refusal !== undefined) return refusal;
  }

  if (local === 'type' && element === 'style') {
    const type = value.trim().toLowerCase();
    if (type !== '' && type !== 'text/css') return { reason: 'svg-css', detail: `${where}: ${JSON.stringify(value)}` };
  }

  if (local === 'stdDeviation') {
    for (const part of value.trim().split(/[\s,]+/)) {
      const number = Number(part);
      if (!Number.isFinite(number) || number < 0) {
        return { reason: 'svg-invalid', detail: `${where}: ${JSON.stringify(value)}` };
      }
      if (number > limits.maxStdDeviation) {
        return { reason: 'svg-workload', detail: `${where}: ${number} exceeds ${limits.maxStdDeviation}` };
      }
    }
  }

  if (local === 'order' && element === 'feConvolveMatrix') {
    const order = value.trim().split(/[\s,]+/).map(Number);
    if (order.length < 1 || order.length > 2 || order.some((part) => !Number.isInteger(part) || part < 1)) {
      return { reason: 'svg-invalid', detail: `${where}: ${JSON.stringify(value)}` };
    }
    const entries = order.length === 1 ? order[0]! * order[0]! : order[0]! * order[1]!;
    if (entries > limits.maxKernelEntries) {
      return { reason: 'svg-workload', detail: `${where}: ${entries} kernel entries exceeds ${limits.maxKernelEntries}` };
    }
  }

  if (local === 'kernelMatrix' && value.trim().split(/[\s,]+/).length > limits.maxKernelEntries) {
    return { reason: 'svg-workload', detail: `${where}: a kernel larger than ${limits.maxKernelEntries} entries` };
  }

  if (local === 'numOctaves') {
    const match = NUMBER_PATTERN_ONLY.exec(value);
    const octaves = match === null ? Number.NaN : Number(match[1]);
    if (!Number.isInteger(octaves) || octaves < 0) {
      return { reason: 'svg-invalid', detail: `${where}: ${JSON.stringify(value)} is not a non-negative integer` };
    }
    if (octaves > limits.maxTurbulenceOctaves) {
      return { reason: 'svg-workload', detail: `${where}: ${octaves} exceeds ${limits.maxTurbulenceOctaves} octaves` };
    }
  }

  // A filter region is a surface libvips allocates. Percentages resolve against
  // the object's bounding box, so a four-digit percentage is the hostile shape a
  // plain user-unit bound would miss. Primitive subregions are the same kind of
  // surface and get the same bound.
  const regionAttribute = local === 'x' || local === 'y' || local === 'width' || local === 'height';
  const regionElement =
    element === 'filter' ||
    (element.startsWith('fe') && element !== 'fePointLight' && element !== 'feSpotLight');
  if (regionElement && regionAttribute) {
    const size = local === 'width' || local === 'height';
    const percent = PERCENT_PATTERN.exec(value);
    if (percent !== null) {
      const number = Number(percent[1]);
      if (!Number.isFinite(number)) {
        return { reason: 'svg-workload', detail: `${where}: ${JSON.stringify(value)} exceeds the filter-region budget` };
      }
      if (size && number < 0) {
        return { reason: 'svg-invalid', detail: `${where}: ${JSON.stringify(value)} is negative` };
      }
      if (Math.abs(number) > limits.maxFilterRegionPercent) {
        return { reason: 'svg-workload', detail: `${where}: ${JSON.stringify(value)} exceeds the filter-region budget` };
      }
    } else {
      const absolute = parseSignedLength(value);
      if (absolute === undefined) {
        return { reason: 'svg-invalid', detail: `${where}: ${JSON.stringify(value)} is not a filter-region length` };
      }
      if (size && absolute.px < 0) {
        return { reason: 'svg-invalid', detail: `${where}: ${JSON.stringify(value)} is negative` };
      }
      if (Math.abs(absolute.px) > limits.maxFilterRegion) {
        return { reason: 'svg-workload', detail: `${where}: ${JSON.stringify(value)} exceeds the filter-region budget` };
      }
    }
  }

  return undefined;
}
