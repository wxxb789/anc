/**
 * The headless DOM Mermaid needs in order to lay a diagram out in Node.
 *
 * Mermaid measures text by putting it in a document and asking the browser how
 * big it is. `happy-dom` supplies the document; it does not supply the
 * measurement — `getBBox()` and `getBoundingClientRect()` both return `0×0`, so
 * without a metrics shim every label measures zero and every diagram collapses
 * into overlapping boxes. That failure is silent: the SVG is well-formed and
 * wrong.
 *
 * The shim measures text from a font advance table rather than a font file.
 * That is an approximation, and its accuracy was measured against the same
 * diagrams rendered in a real browser: median worst-axis deviation 3.8%, 23 of
 * 27 within 15%, and every deviation in the *safe* direction — headless boxes
 * come out slightly larger, so a label gets more room than it needs rather than
 * overflowing. CJK is more accurate than Latin, not less, because a full-width
 * glyph is exactly 1 em by definition. Full evidence in
 * the Mermaid feasibility probe, §2 and §5.
 *
 * This is a build-time module. Nothing here reaches the client in either mode:
 * `mermaid` and `happy-dom` are devDependencies, and the build emits SVG.
 */

import { Window } from 'happy-dom';

/**
 * Globals Mermaid and d3 read off `globalThis` *at import time*, so they must
 * exist before `import('mermaid')` is evaluated. A missing one is not a
 * degraded render; it is a `ReferenceError` during layout.
 */
const REQUIRED_GLOBALS: readonly string[] = [
  'document', 'DOMParser', 'XMLSerializer', 'Node', 'Element', 'SVGElement',
  'SVGGraphicsElement', 'HTMLElement', 'HTMLCanvasElement', 'CSSStyleSheet',
  'CSSStyleDeclaration', 'MutationObserver', 'CustomEvent', 'Event',
  'DocumentFragment', 'Range', 'NodeFilter', 'Image', 'SVGSVGElement',
  'HTMLIFrameElement',
];

/**
 * Arial advance widths in 1/1000 em for ASCII 32–126.
 *
 * Arial rather than the site's own stack because the diagram is laid out for a
 * font the build machine does not have and the reader might not either. Arial's
 * metrics are the closest widely-shared approximation of the sans-serif faces
 * `--font-sans` resolves to, and the measured deviation above is the evidence
 * that the approximation holds.
 */
const ARIAL_ADVANCE: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/**
 * Code point ranges that are one full em wide: CJK ideographs, kana, hangul,
 * full-width forms, and CJK punctuation. Every CJK font makes these exactly
 * 1000/1000 em, so this is exact rather than approximate.
 */
function isFullWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** Width of one line of text at a font size, in CSS pixels. */
export function measureLine(text: string, fontSizePx: number, isBold: boolean): number {
  let units = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (isFullWidth(codePoint)) units += 1000;
    else if (codePoint >= 32 && codePoint <= 126) units += ARIAL_ADVANCE[codePoint - 32]!;
    else if (codePoint === 9) units += 2224;
    else if (codePoint >= 32) units += 556;
  }
  return (units / 1000) * fontSizePx * (isBold ? 1.06 : 1);
}

interface Measurable {
  style?: { getPropertyValue?: (name: string) => string };
  getAttribute?: (name: string) => string | null;
  parentNode?: Measurable | null;
  namespaceURI?: string | null;
  nodeType?: number;
  nodeValue?: string | null;
  tagName?: string;
  childNodes?: Iterable<Measurable>;
  getBBox?: () => { x: number; y: number; width: number; height: number };
  textContent?: string | null;
}

/**
 * Font size in effect on an element, walking up until one is declared.
 *
 * Mermaid sets its font sizes inline or through the `<style>` block it injects
 * into the SVG, and a headless CSSOM cascades neither onto `getComputedStyle`.
 * Walking the ancestors for an explicit declaration is what a browser's
 * inheritance would have done.
 */
function fontSizeOf(element: Measurable): number {
  let node: Measurable | null | undefined = element;
  while (node) {
    const declared = node.style?.getPropertyValue?.('font-size');
    if (declared) {
      const value = Number.parseFloat(declared);
      if (!Number.isNaN(value)) return declared.endsWith('em') ? value * 16 : value;
    }
    const attribute = node.getAttribute?.('font-size');
    if (attribute) {
      const value = Number.parseFloat(attribute);
      if (!Number.isNaN(value)) return value;
    }
    node = node.parentNode;
  }
  return 16;
}

function isBoldAt(element: Measurable): boolean {
  let node: Measurable | null | undefined = element;
  while (node) {
    const weight = node.style?.getPropertyValue?.('font-weight') ?? node.getAttribute?.('font-weight');
    if (weight) return weight === 'bold' || Number.parseInt(weight, 10) >= 600;
    node = node.parentNode;
  }
  return false;
}

/**
 * An element's text as the visual lines it occupies.
 *
 * Line structure matters because a multi-line label's width is its *widest*
 * line, not the width of its concatenated text. Treating `A<br>BBBB` as one
 * seven-character run makes the node twice as wide as it needs to be.
 */
function linesOf(element: Measurable): string[] {
  const BLOCK = new Set(['P', 'DIV', 'LI', 'BR', 'TSPAN', 'TR']);
  const lines: string[] = [];
  let current = '';

  const walk = (node: Measurable): void => {
    if (node.nodeType === 3) {
      current += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node.tagName ?? '').toUpperCase();
    if (tag === 'BR') {
      lines.push(current);
      current = '';
      return;
    }
    const isBlock = BLOCK.has(tag);
    if (isBlock && current) {
      lines.push(current);
      current = '';
    }
    for (const child of node.childNodes ?? []) walk(child);
    if (isBlock) {
      lines.push(current);
      current = '';
    }
  };

  walk(element);
  if (current) lines.push(current);
  const nonEmpty = lines.filter((line) => line.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : [''];
}

/** The box one text-bearing element occupies. */
function textBox(element: Measurable): { width: number; height: number } {
  const fontSize = fontSizeOf(element);
  const bold = isBoldAt(element);
  const lines = linesOf(element);
  const width = Math.max(0, ...lines.map((line) => measureLine(line, fontSize, bold)));
  // An SVG `<text>` line box is about 1.15 em; Mermaid's HTML labels declare
  // `line-height: 1.5` inline, so the two differ and using one for both makes
  // every foreignObject label too short.
  const lineHeight = element.namespaceURI === 'http://www.w3.org/2000/svg' ? fontSize * 1.15 : fontSize * 1.5;
  return { width, height: Math.max(lines.length, 1) * lineHeight };
}

/**
 * Install the measurement surface Mermaid reads.
 *
 * Every assignment below writes a *partial* implementation onto a fully typed
 * DOM prototype: `getBBox` returns a plain box rather than a `DOMRect`,
 * `getScreenCTM` an identity object rather than a `DOMMatrix`, and three of the
 * methods are not on happy-dom's `SVGGraphicsElement` type at all. That is the
 * point of a shim — the real types describe a browser, and this is not one.
 *
 * So the prototypes are widened once, here, to an index signature rather than
 * each assignment being cast at its own site. One widening with a stated reason
 * is honest; eight scattered `as unknown as` casts hide the same thing while
 * looking like eight separate accidents. Only what Mermaid actually calls is
 * implemented, and the feasibility probe §1.2 lists exactly that set.
 *
 * The union walk is the subtle half. `getBBox()` on a container must return the
 * union of its descendants' boxes in the container's own coordinate space —
 * which means honouring each descendant's `translate()` while *excluding* the
 * element's own, exactly as a browser does. Getting that backwards shifts every
 * nested subgraph by its own offset.
 */
function installMetrics(window: Window): void {
  const { SVGGraphicsElement, SVGElement, Element } = window;
  type ShimTarget = Record<string, unknown>;
  const svgPrototype = (SVGGraphicsElement?.prototype ?? SVGElement.prototype) as unknown as ShimTarget;
  const svgElementPrototype = SVGElement.prototype as unknown as ShimTarget;
  const elementPrototype = Element.prototype as unknown as ShimTarget;

  const numeric = (node: Measurable, attribute: string, fallback = 0): number => {
    const value = Number.parseFloat(node.getAttribute?.(attribute) ?? '');
    return Number.isNaN(value) ? fallback : value;
  };

  const unionOf = (element: Measurable): { x: number; y: number; width: number; height: number } => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const add = (x: number, y: number, width: number, height: number): void => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + (width || 0));
      maxY = Math.max(maxY, y + (height || 0));
    };

    const visit = (node: Measurable, offsetX: number, offsetY: number, isRoot: boolean): void => {
      if (node.nodeType !== 1) return;
      const tag = (node.tagName ?? '').toLowerCase();
      const transform = isRoot ? '' : (node.getAttribute?.('transform') ?? '');
      const translate = /translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)?/.exec(transform);
      const x = offsetX + (translate ? Number.parseFloat(translate[1]!) || 0 : 0);
      const y = offsetY + (translate ? Number.parseFloat(translate[2] ?? '0') || 0 : 0);

      if (tag === 'rect' || tag === 'foreignobject' || tag === 'image' || tag === 'use') {
        add(x + numeric(node, 'x'), y + numeric(node, 'y'), numeric(node, 'width'), numeric(node, 'height'));
      } else if (tag === 'circle') {
        const r = numeric(node, 'r');
        add(x + numeric(node, 'cx') - r, y + numeric(node, 'cy') - r, 2 * r, 2 * r);
      } else if (tag === 'ellipse') {
        const rx = numeric(node, 'rx');
        const ry = numeric(node, 'ry');
        add(x + numeric(node, 'cx') - rx, y + numeric(node, 'cy') - ry, 2 * rx, 2 * ry);
      } else if (tag === 'line') {
        const [x1, x2, y1, y2] = [numeric(node, 'x1'), numeric(node, 'x2'), numeric(node, 'y1'), numeric(node, 'y2')];
        add(x + Math.min(x1, x2), y + Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      } else if (tag === 'polygon' || tag === 'polyline') {
        for (const point of (node.getAttribute?.('points') ?? '').trim().split(/\s+/)) {
          const [px, py] = point.split(',').map(Number);
          if (Number.isFinite(px) && Number.isFinite(py)) add(x + px!, y + py!, 0, 0);
        }
      } else if (tag === 'path') {
        for (const [, px, py] of (node.getAttribute?.('d') ?? '').matchAll(
          /(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)/g,
        )) {
          add(x + Number.parseFloat(px!), y + Number.parseFloat(py!), 0, 0);
        }
      } else if (tag === 'text' || tag === 'tspan') {
        const box = node.getBBox?.() ?? { x: 0, y: 0, width: 0, height: 0 };
        add(x + box.x, y + box.y, box.width, box.height);
        return;
      }

      for (const child of node.childNodes ?? []) visit(child, x, y, false);
    };

    visit(element, 0, 0, true);
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };

  svgPrototype['getBBox'] = function getBBox(this: Measurable) {
    const tag = (this.tagName ?? '').toLowerCase();
    if (tag !== 'text' && tag !== 'tspan') return unionOf(this);
    const { width, height } = textBox(this);
    const x = numeric(this, 'x');
    const y = numeric(this, 'y');
    const anchor = this.getAttribute?.('text-anchor') ?? this.style?.getPropertyValue?.('text-anchor');
    const shift = anchor === 'middle' ? -width / 2 : anchor === 'end' ? -width : 0;
    // The 0.8 factor puts the box's top at the cap height above the baseline,
    // which is where a browser puts it for a text element.
    return { x: x + shift, y: y - height * 0.8, width, height };
  };

  // Non-graphics SVG elements (a `marker`, a child of `defs`) are asked too.
  if (svgElementPrototype !== svgPrototype) svgElementPrototype['getBBox'] = svgPrototype['getBBox'];

  const originalRect = Element.prototype.getBoundingClientRect;
  elementPrototype['getBoundingClientRect'] = function getBoundingClientRect(this: Measurable) {
    if (this.namespaceURI === 'http://www.w3.org/1999/xhtml' || !this.namespaceURI) {
      const { width, height } = textBox(this);
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
    }
    const box = this.getBBox ? this.getBBox() : originalRect.call(this as never);
    return {
      x: box.x, y: box.y, top: box.y, left: box.x,
      right: box.x + box.width, bottom: box.y + box.height,
      width: box.width, height: box.height, toJSON: () => ({}),
    };
  };

  svgPrototype['getComputedTextLength'] = function getComputedTextLength(this: Measurable) {
    return textBox(this).width;
  };
  svgPrototype['getSubStringLength'] = function getSubStringLength(this: Measurable, start: number, length: number) {
    return measureLine((this.textContent ?? '').slice(start, start + length), fontSizeOf(this), isBoldAt(this));
  };
  svgPrototype['getNumberOfChars'] = function getNumberOfChars(this: Measurable) {
    return (this.textContent ?? '').length;
  };
  const identityMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  svgPrototype['getScreenCTM'] = function getScreenCTM() {
    return { ...identityMatrix, inverse: () => ({ ...identityMatrix }) };
  };
  svgPrototype['getCTM'] = svgPrototype['getScreenCTM'];
}

/**
 * The layout width diagrams size themselves from.
 *
 * Not a constant with no meaning: gantt reads `parentElement.offsetWidth` as
 * its total chart width and timeline does the same, so this *is* their rendered
 * width. It matches `--measure` at the article's own text size — the column a
 * diagram actually appears in — so a gantt chart comes out the width of the
 * prose above it rather than of an arbitrary viewport.
 */
export const DIAGRAM_VIEWPORT_WIDTH_PX = 720;

const DIAGRAM_VIEWPORT_HEIGHT_PX = 768;

/**
 * Replace `Math.random` with a seeded generator, and hand back a reset.
 *
 * Mermaid's `deterministicIds` option is necessary and not sufficient. Gitgraph
 * mints commit hashes with `makeRandomHex`, which calls `Math.random` directly,
 * and those hashes are *rendered as text* — so their measured width feeds back
 * into the layout and the diagram's own `viewBox` height changes between
 * builds. Measured: five renders of one gitgraph produced five different
 * heights. The hand-drawn renderers used by `class` and `er` jitter their path
 * coordinates from the same source unless `handDrawnSeed` is set.
 *
 * The replacement is installed before `import('mermaid')` because the module
 * graph captures the reference at import time, and reset before each render so
 * that a diagram's output depends only on its own source and not on how many
 * diagrams preceded it.
 *
 * A linear congruential generator is the right size here: this seeds label text
 * in a static site generator, not anything that needs unpredictability.
 *
 * **The replacement is process-lifetime and deliberate.** It is installed once,
 * when the environment is created, and never restored — so every consumer of
 * `Math.random` in a build that rendered a diagram shares the sequence. That is
 * acceptable because nothing else in this build reads it: the renderer is
 * deterministic by design, and a grep over `src/`, `scripts/`, and `tests/`
 * finds no other caller. Restoring it per render would defeat the purpose, and
 * restoring it at the end would leave the ordering dependent on when that
 * happened. An earlier comment here claimed the original was restored; it never
 * was, and a guarantee the code does not provide is worse than none.
 */
const RANDOM_SEED = 0x2f6e2b1;
let randomState = RANDOM_SEED;

function installSeededRandom(): void {
  Math.random = (): number => {
    randomState = (randomState * 1103515245 + 12345) % 2147483648;
    return randomState / 2147483648;
  };
}

/** Restart the sequence, so render N does not depend on renders 1..N-1. */
export function resetSeededRandom(): void {
  randomState = RANDOM_SEED;
}

/**
 * A Mermaid instance with the DOM and metrics it needs, plus the window so a
 * caller can query the rendered tree.
 *
 * One per process. Mermaid keeps module-level counters that feed element ids,
 * so a second instance in the same process would continue the first's numbering
 * rather than restarting it — which is why ids are normalized after rendering
 * instead of being relied upon to repeat. See `renderDiagram`.
 */
export async function createMermaidEnvironment(): Promise<{
  mermaid: typeof import('mermaid').default;
  window: Window;
}> {
  installSeededRandom();
  // `localhost` rather than the site's own origin. Nothing in a diagram
  // resolves a URL against it — the post-processing pass rejects every external
  // reference — so this is only the base a DOM must have, and naming the real
  // origin here would put a second copy of it outside `astro.config.mjs`, which
  // `tests/metadata.test.ts` forbids for exactly that reason.
  const window = new Window({ url: 'http://localhost/' });
  const globals = globalThis as unknown as Record<string, unknown>;
  globals['window'] = window;
  for (const name of REQUIRED_GLOBALS) {
    const value = (window as unknown as Record<string, unknown>)[name];
    if (value !== undefined) globals[name] = value;
  }

  // cytoscape, which lays out mindmaps, reads `padding-*` off the computed
  // style and does arithmetic with it. happy-dom returns `''` for an unset
  // property, and `'' * 1` is `NaN`, which propagates into every coordinate.
  //
  // Typed loosely on purpose: happy-dom declares `getComputedStyle` with one
  // parameter while the DOM's own signature takes a pseudo-element too, and the
  // proxy must forward whatever it is called with rather than the narrower of
  // the two.
  const computeStyle = window.getComputedStyle.bind(window) as unknown as (
    ...args: unknown[]
  ) => CSSStyleDeclaration;
  const patchedComputeStyle = ((...args: unknown[]) => {
    const style = computeStyle(...args);
    return new Proxy(style, {
      get(target, key) {
        if (key === 'getPropertyValue') {
          return (name: string): string => {
            const value = target.getPropertyValue(name);
            return (value === '' || value == null) && /^(?:padding|margin|border)/.test(name) ? '0px' : value;
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as unknown as typeof window.getComputedStyle;
  globals['getComputedStyle'] = patchedComputeStyle;
  window.getComputedStyle = patchedComputeStyle;

  globals['requestAnimationFrame'] = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0);
  globals['cancelAnimationFrame'] = clearTimeout;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  // C4 reads `screen` directly and throws a ReferenceError without it.
  globals['screen'] = window.screen ?? {
    width: 1920, height: 1080, availWidth: 1920, availHeight: 1080,
  };

  installMetrics(window);

  // mindmap and architecture measure text through a 2d canvas context rather
  // than through the DOM. happy-dom has no canvas at all, so this backs
  // `measureText` with the same advance table the DOM path uses — the two must
  // agree, or a mindmap's nodes and its labels are sized by different rulers.
  const fontSizeFrom = (font: string): number => {
    const match = /(\d+(?:\.\d+)?)px/.exec(font);
    return match ? Number.parseFloat(match[1]!) : 16;
  };
  window.HTMLCanvasElement.prototype.getContext = function getContext(type: string) {
    if (type !== '2d') return null;
    let font = '16px Arial';
    const noop = (): void => {};
    return {
      get font() { return font; },
      set font(value: string) { font = value; },
      measureText(text: string) {
        const size = fontSizeFrom(font);
        const width = measureLine(String(text), size, /bold/.test(font));
        return {
          width,
          actualBoundingBoxAscent: size * 0.8, actualBoundingBoxDescent: size * 0.2,
          actualBoundingBoxLeft: 0, actualBoundingBoxRight: width,
          fontBoundingBoxAscent: size * 0.9, fontBoundingBoxDescent: size * 0.25,
        };
      },
      fillText: noop, strokeText: noop, save: noop, restore: noop, scale: noop,
      translate: noop, rotate: noop, beginPath: noop, closePath: noop, moveTo: noop,
      lineTo: noop, arc: noop, fill: noop, stroke: noop, clearRect: noop,
      fillRect: noop, drawImage: noop, setTransform: noop,
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    };
  } as typeof window.HTMLCanvasElement.prototype.getContext;

  // The layout viewport. cytoscape divides by `clientWidth` and throws on a
  // zero; gantt and timeline read `offsetWidth` as their chart width.
  for (const [property, value] of [
    ['clientWidth', DIAGRAM_VIEWPORT_WIDTH_PX],
    ['clientHeight', DIAGRAM_VIEWPORT_HEIGHT_PX],
    ['offsetWidth', DIAGRAM_VIEWPORT_WIDTH_PX],
    ['offsetHeight', DIAGRAM_VIEWPORT_HEIGHT_PX],
  ] as const) {
    Object.defineProperty(window.HTMLElement.prototype, property, {
      configurable: true,
      get: () => value,
    });
  }

  const mermaid = (await import('mermaid')).default;
  return { mermaid, window };
}
