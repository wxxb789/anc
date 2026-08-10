/**
 * Mermaid diagrams as static, CSP-clean, theme-aware SVG, rendered at build time.
 *
 * Mermaid's raw output cannot be served under `style-src 'self'`. It carries a
 * `<style>` element and dozens of `style=` attributes, which together produced
 * **595 CSP violations across 28 diagrams** in a real browser under this site's
 * exact policy. This module removes both, and the result was measured at **zero
 * violations** on the same corpus while rendering pixel-identically.
 *
 * Three transforms do it, in order:
 *
 * 1. **Flatten the stylesheet.** Every rule in Mermaid's injected `<style>` is
 *    matched against the rendered tree and the winning declarations are written
 *    onto the elements as SVG presentation attributes, which are real
 *    attributes with identical semantics and no CSP relevance. The `<style>`
 *    element is then deleted. This is what makes the diagram self-contained: no
 *    per-diagram-type stylesheet ships, so a page with one flowchart pays for
 *    one flowchart. Flattening rather than hoisting was chosen on a
 *    measurement — **86% of the rules in that stylesheet (1,279 of 1,495) match
 *    nothing at all**, because Mermaid emits the union of every shape it *could*
 *    draw. Hoisting them into 23 per-type stylesheets would have shipped 6,354 B
 *    gzip of mostly-dead CSS.
 * 2. **Convert the inline styles.** The `style=` attributes are the same
 *    presentation properties in a different syntax, plus the root's intrinsic
 *    `max-width`, which becomes a real `width` attribute.
 * 3. **Pair the themes.** See {@link renderDiagram}.
 *
 * **The post-processing pass is also the sanitizer.** Mermaid's own
 * sanitization is off — `securityLevel: 'loose'` is mandatory here, because
 * both stricter levels run the output through DOMPurify, which under happy-dom
 * destroys the entire SVG and returns an *empty string with no error*. So this
 * module strips `<script>`, every `on*` handler, and every `style` attribute
 * unconditionally, and rejects any external reference. That is stronger than
 * `securityLevel: 'strict'` would have been, since DOMPurify preserves the
 * inline styles the CSP forbids.
 *
 * Diagram source comes from the reviewed allowlist, not from untrusted input;
 * this pass is defence in depth rather than the only boundary.
 */

import { createMermaidEnvironment, resetSeededRandom } from './mermaid-environment.ts';

/**
 * Palette values handed to Mermaid, one set per theme.
 *
 * These are the literal hex values of the `--color-*` tokens in
 * `src/styles/tokens.css`. They cannot be the custom properties themselves:
 * Mermaid runs every theme value through `khroma`, which computes derived
 * shades by parsing the colour, and `var(--color-bg)` throws
 * `Unsupported color format` at `initialize()`. Verified, not assumed.
 *
 * `tests/math-and-diagrams.test.ts` asserts each value against the token it
 * mirrors, so the two cannot drift.
 */
export const THEME_VARIABLES = {
  light: {
    background: '#fbfaf7',
    primaryColor: '#f2f0ea',
    primaryTextColor: '#1b1f24',
    primaryBorderColor: '#767d87',
    lineColor: '#767d87',
    secondaryColor: '#ffffff',
    tertiaryColor: '#ffffff',
    textColor: '#1b1f24',
    mainBkg: '#f2f0ea',
    nodeBorder: '#767d87',
    nodeTextColor: '#1b1f24',
  },
  dark: {
    background: '#0d1013',
    primaryColor: '#1c222a',
    primaryTextColor: '#e9edf2',
    primaryBorderColor: '#69737f',
    lineColor: '#69737f',
    secondaryColor: '#161b21',
    tertiaryColor: '#161b21',
    textColor: '#e9edf2',
    mainBkg: '#1c222a',
    nodeBorder: '#69737f',
    nodeTextColor: '#e9edf2',
  },
} as const;

type Theme = keyof typeof THEME_VARIABLES;

/**
 * CSS properties that are also SVG presentation attributes: settable as real
 * attributes with identical rendering semantics.
 *
 * The list is the SVG 1.1/2 presentation-attribute set restricted to what
 * Mermaid actually emits. A property outside it cannot be expressed as an
 * attribute and is handled by {@link LAYOUT_CLASSES} or dropped.
 */
const PRESENTATION_PROPERTIES: ReadonlySet<string> = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-opacity', 'opacity', 'font-family', 'font-size', 'font-style', 'font-weight',
  'text-anchor', 'dominant-baseline', 'letter-spacing', 'text-decoration', 'visibility',
  'display', 'color', 'cursor', 'pointer-events', 'shape-rendering', 'overflow',
  'paint-order', 'stop-color', 'stop-opacity', 'rx', 'ry', 'marker-end', 'marker-start',
  'marker-mid', 'clip-path', 'mask', 'filter',
]);

/**
 * The handful of non-presentational declarations that still change layout, each
 * mapped to a class in `src/styles/diagram.css`.
 *
 * Measured rather than assumed: across all 23 diagram types, the matching rules
 * carry 417 presentational declarations and only 18 non-presentational ones,
 * and these six properties are all of them. `background-color` on a label and
 * `text-align` inside a `foreignObject` are the two that visibly matter.
 *
 * A closed table rather than generated utility classes, so a Mermaid version
 * bump that starts emitting a seventh property fails
 * `tests/math-and-diagrams.test.ts` rather than silently growing the stylesheet.
 */
export const LAYOUT_CLASSES: Readonly<Record<string, string>> = {
  'text-align:center': 'diagram-center',
  'text-align:left': 'diagram-left',
  'text-align:start': 'diagram-start',
  'white-space:nowrap': 'diagram-nowrap',
  'line-height:1.5': 'diagram-line',
  'mix-blend-mode:multiply': 'diagram-blend',
  // `display` is a presentation attribute on an SVG element and an ordinary
  // property on the HTML labels inside a `foreignObject`, where an attribute
  // does nothing. The journey diagram's sections and tasks are laid out with
  // `display: table` on exactly those HTML elements, so without this they
  // rendered as blocks — the one place a dropped declaration changed layout
  // rather than only colour.
  'display:table': 'diagram-table',
};

/** Attributes that may carry a URL, checked against the same-origin rule below. */
const URL_ATTRIBUTES: readonly string[] = ['href', 'xlink:href', 'src'];

/** Presentation attributes only apply to elements in this namespace. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Thrown when a diagram cannot be rendered safely. The build stops. */
export class DiagramError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(`${message}\n  in diagram: ${source.trim().slice(0, 200)}`);
    this.name = 'DiagramError';
    this.source = source;
  }
}

/** Split a declaration list, respecting quotes and parentheses. */
function declarationsOf(css: string): { property: string; value: string; isImportant: boolean }[] {
  const parts: string[] = [];
  let buffer = '';
  let quote: string | undefined;
  let depth = 0;
  for (const character of css) {
    if (quote !== undefined) {
      buffer += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      buffer += character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ';' && depth === 0) {
      if (buffer.trim() !== '') parts.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += character;
  }
  if (buffer.trim() !== '') parts.push(buffer.trim());

  return parts.flatMap((part) => {
    const separator = part.indexOf(':');
    if (separator < 0) return [];
    const raw = part.slice(separator + 1).trim();
    const isImportant = /!\s*important$/i.test(raw);
    return [{
      property: part.slice(0, separator).trim().toLowerCase(),
      value: raw.replace(/!\s*important$/i, '').trim(),
      isImportant,
    }];
  });
}

/** Style rules in the injected stylesheet, in document order. At-rules are dropped. */
function styleRules(css: string): { selector: string; body: string }[] {
  // `@keyframes` and `@media` blocks: the only two Mermaid emits, both for
  // animated edges the static output never uses.
  const withoutAtRules = css.replace(/@[\w-]+[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  return [...withoutAtRules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector!.trim(),
    body: body!.trim(),
  }));
}

/**
 * Split a selector list at top-level commas.
 *
 * Load-bearing for {@link specificityOf}: CSS specificity is a property of each
 * selector in a list, never of the list. Scoring
 * `#d .actor-man circle, #d line` as one string counts two ids and beats
 * `#d .messageLine0`, so a sequence diagram's message lines took the generic
 * 2 px stroke instead of their own 1.5 px. Caught by a computed-style
 * comparison against the unflattened SVG in a real browser.
 */
function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (quote !== undefined) {
      if (character === quote && selector[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * Specificity as a single comparable number, for *one* selector.
 *
 * Needed, not speculative: 69 real conflicts were measured across the corpus —
 * `class` alone has 41, where `.marker { fill: … }` and
 * `[id$="-aggregationStart"], .aggregation { fill: transparent !important }`
 * both target the same element with different values. Taking the last rule
 * would paint every class-diagram arrowhead solid instead of hollow.
 *
 * Only the three columns CSS defines, in the same order. The multipliers are
 * wide enough that no realistic selector overflows a column: Mermaid's most
 * complex is four compound parts.
 */
function specificityOf(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (selector.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

interface Winner {
  value: string;
  isImportant: boolean;
  specificity: number;
  order: number;
}

/** Whether declaration `a` wins over `b` under the cascade. */
function outranks(a: Omit<Winner, 'value'>, b: Omit<Winner, 'value'>): boolean {
  // Compared as a tuple rather than folded into one number. A single
  // `important * K + specificity * N + order` score inverts as soon as the rule
  // count exceeds `N`: at `N = 1000`, specificity 100 at order 1500 scores
  // 101500 and beats specificity 101 at order 0. Mermaid's largest stylesheet
  // is 204 rules today, so it was not reachable — but a version bump is exactly
  // the event that would reach it, and a tuple cannot overflow at all.
  if (a.isImportant !== b.isImportant) return a.isImportant;
  if (a.specificity !== b.specificity) return a.specificity > b.specificity;
  return a.order >= b.order;
}

/**
 * Write the stylesheet's declarations onto the elements they select, then
 * delete the stylesheet.
 *
 * Selectors are resolved by the DOM's own `querySelectorAll`, so this does not
 * reimplement selector matching — only the cascade's ordering, and only over
 * one stylesheet with no inheritance to consider (every property here is set
 * directly on the element that needs it).
 */
function flattenStylesheet(root: Element, css: string): void {
  const winners = new Map<Element, Map<string, Winner>>();

  for (const [order, rule] of styleRules(css).entries()) {
    const declarations = declarationsOf(rule.body).filter(
      ({ property, value }) =>
        PRESENTATION_PROPERTIES.has(property) || LAYOUT_CLASSES[`${property}:${value}`] !== undefined,
    );
    if (declarations.length === 0) continue;

    // Each selector in a list is matched and scored on its own, because CSS
    // specificity is a property of one selector rather than of the list.
    for (const selector of splitSelectorList(rule.selector)) {
      let matches: Element[];
      try {
        // `querySelectorAll` searches *descendants only*, and Mermaid's very
        // first rule targets the root: `#<renderId> { font-family; font-size;
        // fill }`. Missing it dropped the fill that every SVG `<text>` inherits,
        // so diagram text fell back to the initial black — invisible on the dark
        // palette, and wrong on the light one.
        matches = [...root.querySelectorAll(selector)] as unknown as Element[];
        if (root.matches(selector)) matches.unshift(root);
      } catch {
        // A selector the DOM cannot parse selects nothing, which is also what a
        // browser would do with it.
        continue;
      }
      if (matches.length === 0) continue;

      const base = specificityOf(selector);
      for (const { property, value, isImportant } of declarations) {
        const candidate = { isImportant, specificity: base, order };
        for (const element of matches) {
          let byProperty = winners.get(element);
          if (byProperty === undefined) {
            byProperty = new Map();
            winners.set(element, byProperty);
          }
          const existing = byProperty.get(property);
          if (existing === undefined || outranks(candidate, existing)) {
            byProperty.set(property, { value, ...candidate });
          }
        }
      }
    }
  }

  for (const [element, byProperty] of winners) {
    for (const [property, { value }] of byProperty) {
      // A stylesheet rule beats a presentation attribute the renderer already
      // wrote — verified in Chromium, not assumed: given
      // `.styled { fill: … }` and `<rect class="styled" fill="#eaeaea">`, the
      // computed fill is the stylesheet's. Declining to overwrite here left the
      // wrong colour on every element Mermaid had pre-painted, which showed as
      // 20 mismatched sequence-diagram actors and 16 class-diagram paths in the
      // computed-style comparison against the unflattened SVG.
      //
      // The cascade below the flattening is then: stylesheet rules first
      // (resolved by specificity, here), then inline `style=` on top, which
      // `convertInlineStyles` applies afterwards with `overrideExisting`.
      applyDeclaration(element, property, value, true);
    }
  }

  for (const style of [...root.querySelectorAll('style')] as unknown as Element[]) {
    style.remove();
  }
}

/**
 * Put one declaration on an element as a presentation attribute or a class.
 *
 * **Only on an SVG element.** A presentation attribute is an SVG concept: on an
 * HTML element inside a `foreignObject` — which is where Mermaid puts every
 * label — `fill="…"` and `display="table"` are inert junk attributes that style
 * nothing. Writing them there both lost the declaration and put two
 * meaningless attributes into every label; a computed-style comparison against
 * the unflattened SVG showed the journey diagram's sections losing their
 * `display: table`. For those elements the class table below is the only route,
 * which is why `LAYOUT_CLASSES` covers exactly the properties that reach them.
 *
 * `overrideExisting` is the difference between the two callers. A stylesheet
 * rule overrides a presentation attribute the renderer already wrote, because
 * that is what the cascade does — verified in Chromium. An inline `style=`
 * overrides both, and `convertInlineStyles` applies it afterwards.
 */
function applyDeclaration(element: Element, property: string, value: string, overrideExisting: boolean): void {
  const layoutClass = LAYOUT_CLASSES[`${property}:${value.replace(/\s+/g, '')}`];
  if (layoutClass !== undefined) {
    const existing = element.getAttribute('class');
    if (existing === null) element.setAttribute('class', layoutClass);
    else if (!existing.split(/\s+/).includes(layoutClass)) element.setAttribute('class', `${existing} ${layoutClass}`);
    return;
  }
  if (!PRESENTATION_PROPERTIES.has(property)) return;
  if (element.namespaceURI !== SVG_NAMESPACE) return;
  if (!overrideExisting && element.hasAttribute(property)) return;
  element.setAttribute(property, value);
}

/**
 * Convert every `style=` attribute into presentation attributes and classes,
 * then remove it.
 *
 * The root `<svg>`'s `max-width` is the diagram's intrinsic width, which is why
 * it becomes a real `width` attribute rather than a class: without it the SVG
 * stretches to fill its container instead of sitting at its natural size. The
 * paired `height` is deliberately not set — the `viewBox` already fixes the
 * aspect ratio, and setting both would stop the diagram scaling down on a
 * narrow screen, which is the one thing a 320 px viewport needs it to do.
 */
function convertInlineStyles(root: Element): void {
  const all = [root, ...([...root.querySelectorAll('[style]')] as unknown as Element[])];
  for (const element of all) {
    const css = element.getAttribute('style');
    if (css === null) continue;
    for (const { property, value } of declarationsOf(css)) {
      if (property === 'max-width' && element === root) {
        const width = Number.parseFloat(value);
        if (Number.isFinite(width)) element.setAttribute('width', String(width));
        continue;
      }
      applyDeclaration(element, property, value, true);
    }
    element.removeAttribute('style');
  }
}

/**
 * Remove everything the projection does not vouch for, and fail on anything
 * unexpected rather than shipping it.
 *
 * Mermaid emits none of these today — measured at 0 scripts and 0 `on*`
 * handlers across the corpus — which is exactly why a *failure* is the right
 * response to finding one: it would mean the renderer changed under us.
 */
function sanitizeDiagram(root: Element, source: string): void {
  if (root.querySelector('script') !== null) {
    throw new DiagramError(source, 'the renderer emitted a <script> element');
  }
  for (const element of [root, ...([...root.querySelectorAll('*')] as unknown as Element[])]) {
    for (const attribute of [...element.attributes].map((item) => item.name)) {
      if (/^on/i.test(attribute)) {
        throw new DiagramError(source, `the renderer emitted an inline handler: ${attribute}`);
      }
    }
    for (const attribute of URL_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      // A fragment reference into the diagram's own defs, or the one base64
      // raster image C4 embeds for its icons. Anything else is an outbound
      // request from a static diagram, which nothing in this pipeline should
      // produce.
      const isLocal = value.startsWith('#');
      const isInlineRaster = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]*$/i.test(value);
      if (!isLocal && !isInlineRaster) {
        throw new DiagramError(source, `the renderer emitted an external reference: ${attribute}="${value.slice(0, 80)}"`);
      }
    }
  }
}

/**
 * Rewrite every generated id so it is unique across the page and stable across
 * builds.
 *
 * Both halves are required and for different reasons. *Unique*, because
 * Mermaid's ids are only unique within one diagram, and two diagrams on one
 * page would otherwise both define `#arrowhead` — the second definition wins
 * for both, silently. *Stable*, because Mermaid's module-level counters
 * continue across renders in a shared process, so the same diagram gets
 * `node-1` in one build and `node-10` in the next; geometry is byte-identical
 * but the file is not, which breaks the determinism requirement and would
 * change a content hash on every build.
 *
 * Sequential renumbering in document order fixes both: the id becomes a
 * function of the diagram's structure and its position on the page, neither of
 * which depends on what else the process rendered first.
 */
/**
 * Attributes whose value is a bare id, or a space-separated list of them,
 * rather than a `#`-prefixed fragment.
 *
 * These have to be rewritten alongside the fragment references or renumbering
 * breaks them. Mermaid emits `aria-labelledby="chart-title-<renderId>"` beside
 * a `<title>` carrying that id whenever a diagram declares `accTitle`, and
 * `aria-describedby` likewise for `accDescr` — so without this the accessible
 * name pointed at an element that no longer existed. A dangling IDREF is an
 * axe failure and, worse, a *silent* one: the name simply vanishes.
 */
const IDREF_ATTRIBUTES: readonly string[] = ['aria-labelledby', 'aria-describedby', 'headers'];

function renumberIds(root: Element, prefix: string): void {
  const rename = new Map<string, string>();
  let next = 0;
  for (const element of [root, ...([...root.querySelectorAll('[id]')] as unknown as Element[])]) {
    const id = element.getAttribute('id');
    if (id === null || id === '') continue;
    const replacement = `${prefix}-${next}`;
    next += 1;
    rename.set(id, replacement);
    element.setAttribute('id', replacement);
  }
  if (rename.size === 0) return;

  const substitute = (value: string): string =>
    value.replace(/url\(#([^)]*)\)/g, (match, reference: string) => {
      const replacement = rename.get(reference);
      return replacement === undefined ? match : `url(#${replacement})`;
    });

  for (const element of [root, ...([...root.querySelectorAll('*')] as unknown as Element[])]) {
    for (const { name, value } of Array.from(element.attributes, (item) => ({
      name: item.name,
      value: item.value,
    }))) {
      if (name === 'id') continue;
      if (IDREF_ATTRIBUTES.includes(name)) {
        element.setAttribute(
          name,
          value
            .split(/\s+/)
            .filter(Boolean)
            .map((token) => rename.get(token) ?? token)
            .join(' '),
        );
        continue;
      }
      if (value.startsWith('#')) {
        const replacement = rename.get(value.slice(1));
        if (replacement !== undefined) element.setAttribute(name, `#${replacement}`);
        continue;
      }
      if (value.includes('url(#')) element.setAttribute(name, substitute(value));
    }
  }
}

/**
 * Every colour in the SVG, in document order, as (element, attribute) pairs.
 *
 * Used to pair a light render with a dark one. Order is the pairing key, which
 * is sound precisely because the two renders are structurally identical — see
 * {@link renderDiagram}.
 */
function colourSlots(root: Element): { element: Element; attribute: string }[] {
  const COLOUR_ATTRIBUTES = ['fill', 'stroke', 'stop-color', 'flood-color', 'color'];
  const slots: { element: Element; attribute: string }[] = [];
  for (const element of [root, ...([...root.querySelectorAll('*')] as unknown as Element[])]) {
    for (const attribute of COLOUR_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value !== null && /^(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/.test(value)) {
        slots.push({ element, attribute });
      }
    }
  }
  return slots;
}

/** The document-order structure of an element tree, ignoring colour values. */
function structureOf(root: Element): string {
  const COLOUR_ATTRIBUTES = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'color']);
  const parts: string[] = [];
  const visit = (element: Element): void => {
    const attributes = [...element.attributes]
      .map((item) => (COLOUR_ATTRIBUTES.has(item.name) ? `${item.name}=@` : `${item.name}=${item.value}`))
      .sort()
      .join(' ');
    parts.push(`<${element.tagName}|${attributes}>`);
    for (const child of [...element.children] as unknown as Element[]) visit(child);
  };
  visit(root);
  return parts.join('');
}

/**
 * A complete colour value. Anchored at both ends, unlike the slot filter.
 *
 * `NaN` is excluded by construction — `[\d\s.,%/-]` admits no letters — and
 * that is load-bearing rather than incidental. Mermaid emits
 * `hsl(45, 23.5294117647%, NaN%)` for a quadrant chart's points under a `base`
 * theme with no `quadrantPointFill` supplied: an invalid colour that every
 * browser discards, painting the point the initial black. Pairing it would have
 * produced `light-dark(<valid>, hsl(…NaN%))`, where one arm is invalid and the
 * *whole function* is invalid, so the element would lose its colour in **both**
 * themes rather than one.
 */
const COLOUR_VALUE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([\d\s.,%/-]+\)|currentColor|transparent|none)$/;

/**
 * Diagrams whose two renders could not be paired, and which therefore ship in
 * the light palette in both themes.
 *
 * Four diagram types were measured as structurally unstable across renders and
 * are expected here; anything else appearing is a regression, which
 * `tests/math-and-diagrams.test.ts` asserts against. Exported rather than
 * logged because a warning in a build log is not a gate.
 */
export const UNPAIRED_DIAGRAMS = new Set<string>();

let environment: Awaited<ReturnType<typeof createMermaidEnvironment>> | undefined;

/**
 * Diagram renders run one at a time, process-wide.
 *
 * Mermaid is a singleton in three ways that all break under concurrency, and
 * none of them fails loudly: `initialize()` sets **global** configuration, so
 * an interleaved render reads whichever theme was installed last; module-level
 * counters feed element ids; and the seeded PRNG this module resets before each
 * render is one shared sequence. Astro renders pages concurrently, so this is
 * not hypothetical — the failure it fixes was two renders of the *same* source
 * in one build producing different bytes, which is precisely the determinism
 * property the ticket requires.
 *
 * A promise chain rather than a lock: each call appends itself to the tail, so
 * renders queue in call order and no caller has to know the queue exists. The
 * cost is that diagram rendering is serial — at ~50 ms per warm render, a page
 * with three diagrams spends 150 ms, which is not worth a second process to
 * parallelize.
 *
 * ponytail: one global queue, not one per diagram type. Per-type queues would
 * not help, because the contended state is Mermaid's global config, not
 * anything per type.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  // `catch` keeps one failed render from poisoning the queue for the next
  // caller, which would turn a single bad diagram into a build-wide failure
  // reported against an innocent page.
  const result = renderQueue.then(work, work);
  renderQueue = result.catch(() => undefined);
  return result;
}

/**
 * One diagram as sanitized, CSP-clean, theme-aware SVG markup.
 *
 * **Theme handling is the interesting part, and it costs zero client bytes.**
 * The diagram is rendered twice — once with the light palette, once with the
 * dark — and the two outputs are paired position by position into
 * `light-dark(light, dark)` values on the *same* SVG. The browser then resolves
 * each against `color-scheme` at paint time, so one diagram serves both themes,
 * follows the system preference, and follows the site's own toggle, with no
 * second render, no second file, and no script.
 *
 * That pairing is only sound because the two renders are structurally
 * identical, which was measured rather than assumed: with a seeded PRNG and
 * fixed ids, 20 of 24 diagram types produce byte-identical output apart from
 * colour values. The four that do not (`sequence`, `class`, `sankey`,
 * `architecture`) drift in element ids and in a colour *count*, so pairing
 * them positionally would put a dark value in a light slot. They are detected
 * here — not assumed away — and fall back to the light palette, which is
 * legible in both themes because the palette's own borders and text are, and
 * which is exactly what the site would have shipped without this feature.
 *
 * @param source The diagram body, without the fence.
 * @param diagramId A page-unique identifier, used to namespace element ids.
 * @param accessibleName The name assistive technology announces for the
 *   diagram. Mermaid gives the root `role="graphics-document"`, which axe
 *   requires to be named; the caller passes the same string it renders as the
 *   figure's caption, so a reader who hears the name and a reader who sees it
 *   get the same words.
 */
export async function renderDiagram(
  source: string,
  diagramId: string,
  accessibleName: string,
): Promise<string> {
  return serialize(() => renderOne(source, diagramId, accessibleName));
}

async function renderOne(source: string, diagramId: string, accessibleName: string): Promise<string> {
  environment ??= await createMermaidEnvironment();
  const { mermaid, window } = environment;

  const rendered: Partial<Record<Theme, string>> = {};
  for (const theme of ['light', 'dark'] as const) {
    // Restart the random sequence before every render, so a diagram's output is
    // a function of its own source rather than of how many diagrams the process
    // rendered first. Without this a gitgraph's commit hashes differ between
    // the light and the dark pass, the two renders stop being structurally
    // identical, and the theme pairing silently declines to pair them.
    resetSeededRandom();
    mermaid.initialize({
      startOnLoad: false,
      // Mandatory. Both stricter levels run the output through DOMPurify, which
      // under happy-dom returns an empty string with no error — a silently
      // blank diagram. The assertion below is the backstop for that.
      securityLevel: 'loose',
      // Determinism, part one: element ids derive from a fixed seed rather than
      // a counter's current value.
      deterministicIds: true,
      deterministicIDSeed: diagramId,
      // Determinism, part two: the hand-drawn renderers jitter their paths from
      // `Math.random()` unless seeded, so `class` and `er` produce different
      // path coordinates on every build.
      handDrawnSeed: 42,
      theme: 'base',
      themeVariables: THEME_VARIABLES[theme],
      // Inherit the article's own type stack, so a diagram label is set in the
      // same face as the prose around it.
      fontFamily: 'inherit',
      maxTextSize: 50000,
      maxEdges: 500,
    });

    let svg: string;
    try {
      ({ svg } = await mermaid.render(`${diagramId}-${theme}`, source));
    } catch (error) {
      throw new DiagramError(source, error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
    // The DOMPurify failure mode is an empty string, returned successfully. A
    // pipeline that does not assert here ships blank diagrams undetected.
    if (svg.length === 0) throw new DiagramError(source, 'the renderer produced empty output');
    rendered[theme] = svg;
  }

  /**
   * Parse with `DOMParser` as XML, never by assigning `innerHTML`.
   *
   * happy-dom's HTML parser mishandles a `<style>` element inside an `<svg>`:
   * it consumes the rest of the document as that element's text, so the parsed
   * tree is an `<svg>` containing one empty `<style>` and nothing else. Every
   * node, every measurement, and every colour is silently gone, and the result
   * is still well-formed markup with a correct `viewBox` — so nothing downstream
   * notices. Mermaid emits exactly that shape on every diagram.
   *
   * The XML path parses it correctly. `image/svg+xml` is also the honest
   * content type: the string is an SVG document, not an HTML fragment.
   */
  const parse = (svg: string): Element => {
    const document = new window.DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = document.documentElement;
    if (root === null || root.tagName.toLowerCase() !== 'svg') {
      throw new DiagramError(source, 'the renderer produced no <svg> element');
    }
    // An XML parse error is reported as a `<parsererror>` element rather than a
    // throw, so it has to be looked for.
    if (root.querySelector('parsererror') !== null) {
      throw new DiagramError(source, 'the renderer produced markup that is not well-formed XML');
    }
    return root as unknown as Element;
  };

  const light = parse(rendered.light!);
  const dark = parse(rendered.dark!);

  for (const root of [light, dark]) {
    const style = root.querySelector('style');
    flattenStylesheet(root, style?.textContent ?? '');
    convertInlineStyles(root);
  }

  // `info` is a version banner with no geometry, and is the only type that
  // legitimately has no viewBox.
  const isInfoBanner = source.trim() === 'info';
  if (!isInfoBanner && !light.hasAttribute('viewBox')) {
    throw new DiagramError(source, 'the renderer produced an SVG with no viewBox');
  }

  renumberIds(light, diagramId);
  renumberIds(dark, diagramId);

  // Pair the palettes. Structural identity is the precondition; when it does
  // not hold, the light render ships unchanged rather than mispaired.
  //
  // **The failure is reported, not silent.** A diagram that pairs nothing looks
  // exactly like a correctly rendered one — it is simply stuck in the light
  // palette — so a silent decline is invisible until a reader in dark mode
  // meets it. That was not hypothetical: an `accTitle` baked the render id into
  // `aria-labelledby`, which made the two structures differ, and every such
  // diagram lost theming with nothing to show for it. `pairedColours` is
  // returned so the caller can gate on it.
  const lightSlots = colourSlots(light);
  const darkSlots = colourSlots(dark);
  let pairedColours = 0;
  if (lightSlots.length === darkSlots.length && structureOf(light) === structureOf(dark)) {
    for (const [index, slot] of lightSlots.entries()) {
      const lightValue = slot.element.getAttribute(slot.attribute)!;
      const darkValue = darkSlots[index]!.element.getAttribute(darkSlots[index]!.attribute)!;
      if (lightValue === darkValue) continue;
      // Both arms must be real colours: the dark one because it is interpolated
      // into a CSS function, and the light one because `light-dark()` is
      // invalid as a whole if either arm is. Mermaid does emit an invalid
      // colour — see `COLOUR_VALUE` — so this is a live case, not a hypothetical
      // one. The pair is skipped rather than thrown on: an unpaired slot keeps
      // whatever Mermaid produced, which is exactly what the diagram would have
      // shipped without theming, whereas failing the build would reject a whole
      // diagram type over one of its renderer's own defects.
      if (!COLOUR_VALUE.test(lightValue) || !COLOUR_VALUE.test(darkValue)) continue;
      slot.element.setAttribute(slot.attribute, `light-dark(${lightValue}, ${darkValue})`);
      pairedColours += 1;
    }
  }
  UNPAIRED_DIAGRAMS.delete(diagramId);
  if (pairedColours === 0 && lightSlots.length > 0) UNPAIRED_DIAGRAMS.add(diagramId);

  sanitizeDiagram(light, source);

  // The diagram is content, not decoration. Mermaid gives the root
  // `role="graphics-document document"` and an `aria-roledescription`, and a
  // role of that kind must have an accessible name or axe reports it — so the
  // name is set here from the same string the caption renders.
  light.setAttribute('aria-label', accessibleName);
  // Not a tab stop. The SVG holds no control and no scrollable overflow, so
  // making it focusable would add a stop that announces the name and offers
  // nothing to do; the caption already carries the name in the reading order.
  light.setAttribute('focusable', 'false');
  // A width attribute plus `max-width: 100%` in the stylesheet lets the diagram
  // shrink below its intrinsic size on a narrow screen without stretching past
  // it on a wide one. The `viewBox` already fixes the aspect ratio, so setting
  // `height` too would stop it scaling — the one thing 320 px needs.
  light.removeAttribute('height');

  return light.outerHTML;
}
