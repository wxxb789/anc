/**
 * CSS policy for the static SVG subset: an AST, never a text search.
 *
 * Everything an SVG can ask CSS to fetch arrives through one of three doors —
 * a `<style>` sheet, a `style` attribute, or a URL-bearing presentation
 * attribute such as `fill="url(#grad)"` — and this module closes all three with
 * the same check. `css-tree` parses the text, and every `Url` node it produces
 * must be a same-document fragment.
 *
 * **Why the parser matters rather than a substring test.** CSS escapes are part
 * of the grammar: measured against css-tree 3.2.1,
 * `url("\6a avascript:alert(1)")` and `url("jav\61 script:alert(1)")` both
 * parse to a `Url` node whose *decoded* value is `javascript:alert(1)`, and
 * `url(http\3a //evil/x)` decodes to `http://evil/x`. The source bytes contain
 * neither `javascript:` nor `http://`, so a scan for those literal strings
 * reports nothing while a browser resolves the URL. The check below reads the
 * decoded `Url.value`, which is the form the renderer acts on.
 *
 * The policy is fail-closed on construct: an at-rule (which is where `@import`
 * and `@font-face` `src: url()` live), a `Raw` node (css-tree's fallback for
 * text it could not parse, including a `var()` fallback argument), an unknown
 * function, or any node type outside the static styling grammar is refused
 * rather than passed through on the assumption the renderer and the checker
 * read it the same way.
 */

import { parse, walk, type CssNode } from 'css-tree';
import type { SvgRefusal } from './svg-refusal.ts';

/** Node types a static declaration value or selector may contain. */
const STATIC_NODES: Readonly<Record<string, true>> = {
  StyleSheet: true,
  Rule: true,
  SelectorList: true,
  Selector: true,
  TypeSelector: true,
  ClassSelector: true,
  IdSelector: true,
  UniversalSelector: true,
  AttributeSelector: true,
  PseudoClassSelector: true,
  PseudoElementSelector: true,
  Combinator: true,
  Nth: true,
  WhiteSpace: true,
  Comment: true,
  Block: true,
  Declaration: true,
  DeclarationList: true,
  Value: true,
  Identifier: true,
  Number: true,
  Dimension: true,
  Percentage: true,
  String: true,
  Hash: true,
  Operator: true,
  Ratio: true,
};

/**
 * Functions with no resource-loading meaning.
 *
 * Colour, arithmetic and transform functions are inert. Every function that can
 * name an image or a font is absent on purpose: `url()` is handled as its own
 * node, and `image()`, `image-set()`, `cross-fade()`, `element()`, `paint()`,
 * `local()` and `attr()` are refused by falling outside this list. `var()` is
 * refused too, because its fallback argument parses as a `Raw` node.
 */
const STATIC_FUNCTIONS: Readonly<Record<string, true>> = {
  rgb: true,
  rgba: true,
  hsl: true,
  hsla: true,
  hwb: true,
  lab: true,
  lch: true,
  oklab: true,
  oklch: true,
  color: true,
  'color-mix': true,
  'light-dark': true,
  calc: true,
  min: true,
  max: true,
  clamp: true,
  round: true,
  mod: true,
  rem: true,
  abs: true,
  sign: true,
  translate: true,
  translatex: true,
  translatey: true,
  scale: true,
  scalex: true,
  scaley: true,
  rotate: true,
  skew: true,
  skewx: true,
  skewy: true,
  matrix: true,
  matrix3d: true,
  perspective: true,
  circle: true,
  ellipse: true,
  inset: true,
  polygon: true,
  path: true,
  rect: true,
};

const SCHEME = /^\s*([A-Za-z][A-Za-z0-9+.-]*):/;

/**
 * Classify one reference value.
 *
 * Exported because `href` and `xlink:href` are XML attributes rather than CSS,
 * and the design requires them to get **identical** checks. One function means
 * they cannot drift into two policies.
 *
 * The rules are ordered so the diagnostic names the sharpest fault: an embedded
 * payload is not reported as a generic external URL, and a script URL is not
 * reported as a network request.
 */
export function inspectReference(value: string, where: string): SvgRefusal | undefined {
  if (value.startsWith('#')) {
    return value.length > 1 ? undefined : { reason: 'svg-external', detail: `${where}: an empty fragment reference` };
  }
  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme === 'data') {
    return { reason: 'svg-data', detail: `${where}: embedded data: payload; ANC does not publish embedded assets` };
  }
  if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'livescript') {
    return { reason: 'svg-script', detail: `${where}: script URL` };
  }
  if (scheme !== undefined) {
    return { reason: 'svg-external', detail: `${where}: ${scheme}: reference; only a same-document fragment is allowed` };
  }
  return { reason: 'svg-external', detail: `${where}: relative reference; only a same-document fragment is allowed` };
}

/** One node, checked for resources and for static-only construct. */
function checkNode(node: CssNode, where: string): SvgRefusal | undefined {
  if (node.type === 'Url') {
    return inspectReference(node.value ?? '', where);
  }
  if (node.type === 'Function') {
    const name = (node.name ?? '').toLowerCase();
    if (STATIC_FUNCTIONS[name] !== true) {
      return { reason: 'svg-css', detail: `${where}: unsupported CSS function ${name}()` };
    }
    return undefined;
  }
  if (node.type === 'Raw') {
    return { reason: 'svg-css', detail: `${where}: CSS this policy cannot parse` };
  }
  if (node.type === 'Atrule') {
    const name = (node.name ?? '').toLowerCase();
    return { reason: 'svg-css', detail: `${where}: @${name} is not part of the static subset` };
  }
  if (STATIC_NODES[node.type] !== true) {
    return { reason: 'svg-css', detail: `${where}: unsupported CSS construct ${node.type}` };
  }
  return undefined;
}

function inspect(source: string, context: 'stylesheet' | 'declarationList' | 'value', where: string): SvgRefusal | undefined {
  let ast: CssNode;
  try {
    ast = parse(source, { context });
  } catch (error) {
    return {
      reason: 'svg-css',
      detail: `${where}: ${error instanceof Error ? error.message.split('\n')[0]! : String(error)}`,
    };
  }
  let refusal: SvgRefusal | undefined;
  walk(ast, (node) => {
    if (refusal === undefined) refusal = checkNode(node, where);
  });
  return refusal;
}

/** Check a `<style>` element's contents. */
export function inspectStyleSheet(source: string): SvgRefusal | undefined {
  return inspect(source, 'stylesheet', 'style element');
}

/** Check a `style` attribute's declaration list. */
export function inspectStyleAttribute(source: string): SvgRefusal | undefined {
  return inspect(source, 'declarationList', 'style attribute');
}

/**
 * Check one URL-bearing presentation attribute.
 *
 * `fill`, `stroke`, `filter`, `mask`, `clip-path` and the marker properties all
 * accept `url(...)`, and `cursor` accepts a URL list. Parsing the value rather
 * than scanning it means an escaped scheme is decoded by the same grammar the
 * renderer uses.
 */
export function inspectPresentationAttribute(name: string, source: string): SvgRefusal | undefined {
  return inspect(source, 'value', `${name} attribute`);
}

/**
 * The same-document fragment targets named by `url()` values in one CSS context.
 *
 * The `<use>`-expansion budget needs the graph of rendered references, not only
 * the `href` edges: a mask, clip path, filter, marker, pattern or gradient that a
 * drawn element reaches renders its contents. Those references can be written in
 * a presentation attribute, a `style` attribute or a `<style>` sheet, and this
 * function reads all three through the same parser as
 * {@link inspectPresentationAttribute}. The caller has already accepted the
 * value, so every URL it returns is a fragment; an unparseable value contributes
 * no edges rather than a second refusal.
 */
export function fragmentReferences(
  source: string,
  context: 'stylesheet' | 'declarationList' | 'value',
): string[] {
  let ast: CssNode;
  try {
    ast = parse(source, { context });
  } catch {
    return [];
  }
  const references: string[] = [];
  walk(ast, (node) => {
    if (node.type === 'Url' && typeof node.value === 'string' && node.value.startsWith('#') && node.value.length > 1) {
      references.push(node.value.slice(1));
    }
  });
  return references;
}
