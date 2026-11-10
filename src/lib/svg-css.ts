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

/** One compound of a selector this policy can decide against the recorded tree. */
export interface StaticSelectorCompound {
  /** How this compound joins the previous one; `undefined` on the leftmost. */
  readonly combinator: ' ' | '>' | undefined;
  /** The element's local name; `undefined` is the universal selector. */
  readonly name: string | undefined;
  readonly id: string | undefined;
  readonly classes: readonly string[];
}

/** A selector compiled to compounds, with the rightmost (subject) one last. */
export type StaticSelector = readonly StaticSelectorCompound[];

/** One declaration of a `style` attribute or a rule: its property and fragments. */
export interface StaticDeclaration {
  /** The CSS property name, lowercased so the policy's table is case-insensitive. */
  readonly property: string;
  /** Every same-document fragment the declaration's value names, in source order. */
  readonly references: readonly string[];
  /**
   * Whether the value is a CSS-wide keyword that resolves to the parent's value.
   *
   * `inherit`, `unset` (on an inherited property) and `revert`/`revert-layer`
   * cannot be read as "this element declares its own value": the inherited
   * reference still applies. The policy counts both the declared reference and
   * the inherited one for such a declaration, because resolving which wins is
   * cascade work it does not model and an over-count is the safe direction.
   * `initial` is deliberately absent: it resolves to the property's initial
   * value, not to the parent.
   */
  readonly defers: boolean;
}

/** One static rule: its attributable selectors and the declarations it applies. */
export interface StaticStyleRule {
  readonly selectors: readonly StaticSelector[];
  readonly declarations: readonly StaticDeclaration[];
}

/** What a `<style>` element contributes, or why it was refused. */
export type StyleSheetAnalysis =
  | { readonly ok: true; readonly rules: readonly StaticStyleRule[] }
  | { readonly ok: false; readonly refusal: SvgRefusal };

/**
 * The selector forms attribution understands.
 *
 * A stylesheet reference is counted per element its rule matches, so the policy
 * must be able to decide that match from the element tree it records: local
 * name, `id`, `class`, and the descendant and child combinators. Everything
 * else — attribute selectors, pseudo-classes, pseudo-elements, sibling and
 * column combinators, namespaces and escaped identifiers — has no recorded
 * fact to decide it here and is refused rather than guessed at.
 */
const SELECTOR_FORMS =
  'type, class, id and universal selectors joined by the descendant or child combinator';

function selectorFault(where: string, construct: string): SvgRefusal {
  return {
    reason: 'svg-css',
    detail: `${where}: ${construct} is not attributable to drawn elements; only ${SELECTOR_FORMS} can be matched`,
  };
}

/** Compile one selector, or name the construct that cannot be attributed. */
function compileSelector(
  node: CssNode,
  where: string,
): { readonly ok: true; readonly selector: StaticSelector } | { readonly ok: false; readonly refusal: SvgRefusal } {
  if (node.type !== 'Selector') {
    return { ok: false, refusal: selectorFault(where, `the selector form ${node.type}`) };
  }
  interface Compound {
    combinator: ' ' | '>' | undefined;
    name: string | undefined;
    universal: boolean;
    id: string | undefined;
    classes: string[];
  }
  const compounds: Compound[] = [];
  let current: Compound | undefined;
  let combinator: ' ' | '>' | undefined;
  const open = (): Compound => {
    const compound: Compound = { combinator, name: undefined, universal: false, id: undefined, classes: [] };
    compounds.push(compound);
    current = compound;
    combinator = undefined;
    return compound;
  };
  const plain = (name: string | undefined, construct: string): string | SvgRefusal => {
    const value = name ?? '';
    if (value.includes('\\')) return selectorFault(where, `an escaped identifier in ${construct}`);
    return value;
  };
  for (const part of node.children?.toArray() ?? []) {
    if (part.type === 'WhiteSpace' || part.type === 'Comment') continue;
    if (part.type === 'Combinator') {
      if (current === undefined) {
        return { ok: false, refusal: selectorFault(where, `the combinator ${JSON.stringify(part.name ?? '')} at the start of a selector`) };
      }
      const name = part.name ?? '';
      if (name === '>' || name === ' ') {
        combinator = name;
      } else if (name === '+') {
        return { ok: false, refusal: selectorFault(where, "the adjacent-sibling combinator '+'") };
      } else if (name === '~') {
        return { ok: false, refusal: selectorFault(where, "the general-sibling combinator '~'") };
      } else if (name === '||') {
        return { ok: false, refusal: selectorFault(where, "the column combinator '||'") };
      } else {
        return { ok: false, refusal: selectorFault(where, `the combinator ${JSON.stringify(name)}`) };
      }
      current = undefined;
      continue;
    }
    if (part.type === 'TypeSelector' || part.type === 'UniversalSelector') {
      const universal = part.type === 'UniversalSelector' || part.name === '*';
      let typeName: string | undefined;
      if (!universal) {
        const value = plain(part.name, 'a type selector');
        if (typeof value !== 'string') return { ok: false, refusal: value };
        if (value === '') return { ok: false, refusal: selectorFault(where, 'an empty type selector') };
        if (value.includes('|')) {
          return { ok: false, refusal: selectorFault(where, 'a namespace-qualified type selector') };
        }
        typeName = value;
      }
      const compound = current ?? open();
      if (compound.name !== undefined || compound.universal) {
        return { ok: false, refusal: selectorFault(where, 'more than one type selector in one compound') };
      }
      if (universal) compound.universal = true;
      else compound.name = typeName;
      continue;
    }
    if (part.type === 'ClassSelector') {
      const value = plain(part.name, 'a class selector');
      if (typeof value !== 'string') return { ok: false, refusal: value };
      if (value === '') return { ok: false, refusal: selectorFault(where, 'an empty class selector') };
      (current ?? open()).classes.push(value);
      continue;
    }
    if (part.type === 'IdSelector') {
      const value = plain(part.name, 'an id selector');
      if (typeof value !== 'string') return { ok: false, refusal: value };
      if (value === '') return { ok: false, refusal: selectorFault(where, 'an empty id selector') };
      const compound = current ?? open();
      if (compound.id !== undefined) {
        return { ok: false, refusal: selectorFault(where, 'more than one id selector in one compound') };
      }
      compound.id = value;
      continue;
    }
    if (part.type === 'AttributeSelector') {
      return { ok: false, refusal: selectorFault(where, 'an attribute selector') };
    }
    if (part.type === 'PseudoClassSelector') {
      return { ok: false, refusal: selectorFault(where, `the pseudo-class ':${part.name ?? ''}'`) };
    }
    if (part.type === 'PseudoElementSelector') {
      return { ok: false, refusal: selectorFault(where, `the pseudo-element '::${part.name ?? ''}'`) };
    }
    return { ok: false, refusal: selectorFault(where, `the selector construct ${part.type}`) };
  }
  if (compounds.length === 0) {
    return { ok: false, refusal: selectorFault(where, 'an empty selector') };
  }
  return {
    ok: true,
    selector: compounds.map((compound) => ({
      combinator: compound.combinator,
      name: compound.universal ? undefined : compound.name,
      id: compound.id,
      classes: compound.classes,
    })),
  };
}

/** Compile one selector list, preserving its alternatives in source order. */
function compileSelectorList(
  node: CssNode | undefined,
  where: string,
): { readonly ok: true; readonly selectors: StaticSelector[] } | { readonly ok: false; readonly refusal: SvgRefusal } {
  if (node === undefined || node.type !== 'SelectorList') {
    return { ok: false, refusal: selectorFault(where, `the selector form ${node?.type ?? 'missing'}`) };
  }
  const selectors: StaticSelector[] = [];
  for (const part of node.children?.toArray() ?? []) {
    if (part.type === 'WhiteSpace' || part.type === 'Comment') continue;
    const compiled = compileSelector(part, where);
    if (!compiled.ok) return compiled;
    selectors.push(compiled.selector);
  }
  if (selectors.length === 0) {
    return { ok: false, refusal: selectorFault(where, 'an empty selector list') };
  }
  return { ok: true, selectors };
}

/** Collect the same-document fragments named by `url()` anywhere under one node. */
function collectFragmentReferences(root: CssNode, into: string[]): void {
  walk(root, (node) => {
    if (node.type === 'Url' && typeof node.value === 'string' && node.value.startsWith('#') && node.value.length > 1) {
      into.push(node.value.slice(1));
    }
  });
}

/**
 * The declarations in one parsed block, each with the fragments its value names.
 *
 * The property name matters, not only the URL: inheritance is decided per
 * inherited property, so a declaration with no URL (`fill="red"`) still has to
 * be visible to the policy as the declaration that overrides an ancestor's
 * `fill="url(#p)"`. A CSS-wide keyword that resolves to the parent's value is
 * flagged instead of treated as a plain local value.
 */
function collectDeclarations(root: CssNode): StaticDeclaration[] {
  const declarations: StaticDeclaration[] = [];
  walk(root, (node) => {
    if (node.type !== 'Declaration') return;
    const property = node['property'];
    if (typeof property !== 'string') return;
    const references: string[] = [];
    collectFragmentReferences(node, references);
    const value = node['value'];
    const parsed = typeof value === 'object' && value !== null ? (value as CssNode) : undefined;
    declarations.push({
      property: decodeCssEscapes(property).toLowerCase(),
      references,
      defers: defersToParent(parsed),
    });
  });
  return declarations;
}

/**
 * Keywords whose computed value comes from the parent for an inherited property.
 *
 * `revert` and `revert-layer` roll back to a lower origin; a presentation
 * attribute is a lower origin, and the inherited value may be the result, so
 * both are treated as deferring. `initial` is not here.
 */
const DEFERRING_KEYWORDS: Readonly<Record<string, true>> = {
  inherit: true,
  unset: true,
  revert: true,
  'revert-layer': true,
};

/**
 * One CSS escape, hex form with its optional single terminator or literal form.
 *
 * `css-tree` keeps escapes in `property` and `Identifier.name` (`\69 nherit`
 * stays spelled that way), while a CSS reader resolves it to `inherit`. The
 * comparison below must see the decoded name or a host could spell a deferring
 * keyword so the policy reads a plain local value and drops the inherited
 * reference.
 */
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|([\s\S]))/g;

function decodeCssEscapes(value: string): string {
  return value.replace(CSS_ESCAPE, (_match, hex: string | undefined, literal: string | undefined) => {
    if (hex !== undefined) {
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return '\uFFFD';
      }
      return String.fromCodePoint(codePoint);
    }
    if (literal === '\n' || literal === '\r' || literal === '\f') return '';
    return literal ?? '';
  });
}

/** Whether a parsed value is exactly one CSS-wide keyword that defers to the parent. */
function defersToParent(value: CssNode | undefined): boolean {
  if (value?.type !== 'Value') return false;
  const parts = value.children?.toArray() ?? [];
  if (parts.length !== 1) return false;
  const [only] = parts;
  return (
    only?.type === 'Identifier' &&
    typeof only.name === 'string' &&
    DEFERRING_KEYWORDS[decodeCssEscapes(only.name).toLowerCase()] === true
  );
}

/**
 * One presentation attribute as a declaration: its fragments and whether its
 * value is a deferring keyword. Parsed with the same context as
 * {@link inspectPresentationAttribute}; the caller has already accepted it, so
 * an unparseable value contributes no reference rather than a second refusal.
 */
export function presentationDeclaration(property: string, source: string): StaticDeclaration {
  let ast: CssNode;
  try {
    ast = parse(source, { context: 'value' });
  } catch {
    return { property, references: [], defers: false };
  }
  const references: string[] = [];
  collectFragmentReferences(ast, references);
  return { property, references, defers: defersToParent(ast) };
}

/**
 * Inspect a `<style>` element and return what it contributes to attribution.
 *
 * The static grammar check is the same one every other CSS door gets. Selector
 * lists are compiled to the subset matching can decide, because a sheet's
 * references are counted once per element the rule matches, not once per sheet.
 * A selector form outside that subset is refused here rather than attributed to
 * the root or silently dropped.
 */
export function analyzeStyleSheet(source: string): StyleSheetAnalysis {
  let ast: CssNode;
  try {
    ast = parse(source, { context: 'stylesheet' });
  } catch (error) {
    return {
      ok: false,
      refusal: {
        reason: 'svg-css',
        detail: `style element: ${error instanceof Error ? error.message.split('\n')[0]! : String(error)}`,
      },
    };
  }
  let refusal: SvgRefusal | undefined;
  walk(ast, (node) => {
    if (refusal === undefined) refusal = checkNode(node, 'style element');
  });
  if (refusal !== undefined) return { ok: false, refusal };
  const rules: StaticStyleRule[] = [];
  for (const node of ast.children?.toArray() ?? []) {
    if (node.type === 'WhiteSpace' || node.type === 'Comment') continue;
    if (node.type !== 'Rule') {
      return { ok: false, refusal: selectorFault('style element', `the top-level ${node.type}`) };
    }
    const selectors = compileSelectorList(node.prelude, 'style element');
    if (!selectors.ok) return selectors;
    const declarations = node.block === undefined ? [] : collectDeclarations(node.block);
    rules.push({ selectors: selectors.selectors, declarations });
  }
  return { ok: true, rules };
}

/** Check a `<style>` element's contents, including its selectors. */
export function inspectStyleSheet(source: string): SvgRefusal | undefined {
  const analysis = analyzeStyleSheet(source);
  return analysis.ok ? undefined : analysis.refusal;
}

/** Check a `style` attribute's declaration list. */
export function inspectStyleAttribute(source: string): SvgRefusal | undefined {
  return inspect(source, 'declarationList', 'style attribute');
}

/**
 * The declarations in a `style` attribute, each with its fragment references.
 *
 * Parsed with the same grammar and context as {@link inspectStyleAttribute}. The
 * caller has already accepted the attribute, so an unparseable value contributes
 * no declarations rather than a second refusal.
 */
export function declarationReferences(source: string): StaticDeclaration[] {
  let ast: CssNode;
  try {
    ast = parse(source, { context: 'declarationList' });
  } catch {
    return [];
  }
  return collectDeclarations(ast);
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
