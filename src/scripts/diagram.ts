/**
 * Client-mode diagram rendering.
 *
 * Loaded only when `DIAGRAM_MODE` is `'client'` and only on pages that contain
 * a diagram. In the shipped mode (`'build-time'`) this file is never imported,
 * so none of it — and none of Mermaid — reaches any page. See
 * `src/lib/diagram-mode.ts` for what the two modes cost.
 *
 * Three properties this has to preserve, all of which the build-time path gets
 * for free and this one has to work for:
 *
 * 1. **Nothing loads until it is needed.** Mermaid's floor is 201 KB gzip for
 *    the cheapest single diagram — 4× the §18 article budget — so the import is
 *    deferred behind an `IntersectionObserver`. A reader who never scrolls to
 *    the diagram never fetches the parser. That also places the cost outside
 *    "initial JS on the article route", which is the only reading under which
 *    client mode fits the stated budget at all.
 * 2. **The source stays until the diagram replaces it.** The `<pre>` the
 *    renderer emitted is removed only after a successful render, so a failure
 *    at any point leaves the reader with the diagram's source rather than an
 *    empty figure.
 * 3. **The accessible name survives.** The figure's caption already names the
 *    diagram, and the injected SVG is given the same name, so replacing the
 *    source does not silently drop it.
 */

const DIAGRAM_SELECTOR = 'figure.diagram';

/**
 * Attributes that may carry a URL. Mirrors `URL_ATTRIBUTES` in
 * `src/lib/mermaid-render.ts`, which enforces the same rule at build time;
 * the two must agree, or one mode admits a link the other rejects.
 */
const URL_ATTRIBUTES: readonly string[] = ['href', 'xlink:href', 'src'];

/** Mermaid is imported at most once per page, on first diagram in view. */
let runtime: Promise<typeof import('mermaid').default> | undefined;

/**
 * Mermaid's own configuration, applied on import and again on every theme
 * change.
 *
 * `initialize` is what installs the palette, and it is *not* idempotent with
 * respect to the theme: calling it again with new `themeVariables` is the only
 * way to make a later `render()` draw different colours. Without the second
 * call a re-render redraws the diagram in exactly the palette it already had —
 * measured, 0 of 60 sampled fills changed.
 */
function configure(mermaid: typeof import('mermaid').default): void {
  mermaid.initialize({
    startOnLoad: false,
    // Matches the build-time renderer, which documents why: both stricter
    // levels run the output through DOMPurify, and the theme is supplied
    // here rather than by the diagram.
    securityLevel: 'loose',
    deterministicIds: true,
    handDrawnSeed: 42,
    theme: 'base',
    fontFamily: 'inherit',
    themeVariables: currentThemeVariables(),
    maxTextSize: 50000,
    maxEdges: 500,
  });
}

function loadMermaid(): Promise<typeof import('mermaid').default> {
  runtime ??= import('mermaid').then((module) => {
    const mermaid = module.default;
    configure(mermaid);
    return mermaid;
  });
  return runtime;
}

/**
 * Palette values for the theme in effect right now.
 *
 * Read from the live page rather than duplicated as literals, so the client
 * path cannot drift from `src/styles/tokens.css` the way a second copy would.
 *
 * **Resolved through a probe element, not read off the custom property.**
 * `getComputedStyle(root).getPropertyValue('--color-surface')` returns the
 * *declared* value — `light-dark(#fff, #161b21)` — because a custom property is
 * substituted, not computed. Mermaid runs every theme value through `khroma`,
 * which parses colours and throws `Unsupported color format` on that string,
 * and the whole render fails. Measured: it is what made every diagram in client
 * mode stay as source.
 *
 * Assigning the property to a real `color` and reading *that* back makes the
 * browser resolve `light-dark()` against the active `color-scheme`, which is
 * exactly the value the diagram should use and follows the theme toggle.
 */
function currentThemeVariables(): Record<string, string> {
  const probe = document.createElement('span');
  // Out of flow and invisible, but still styled: `display: none` would leave
  // the computed colour unresolved in some engines.
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.append(probe);

  const resolve = (name: string, fallback: string): string => {
    probe.style.color = '';
    probe.style.color = `var(${name})`;
    const value = getComputedStyle(probe).color;
    return value === '' ? fallback : value;
  };

  const palette = {
    background: resolve('--color-bg', '#fbfaf7'),
    surface: resolve('--color-surface', '#ffffff'),
    surfaceAlt: resolve('--color-surface-alt', '#f2f0ea'),
    text: resolve('--color-text', '#1b1f24'),
    line: resolve('--color-line-strong', '#767d87'),
  };
  probe.remove();

  return {
    background: palette.background,
    primaryColor: palette.surfaceAlt,
    primaryTextColor: palette.text,
    primaryBorderColor: palette.line,
    lineColor: palette.line,
    secondaryColor: palette.surface,
    tertiaryColor: palette.surface,
    textColor: palette.text,
    mainBkg: palette.surfaceAlt,
    nodeBorder: palette.line,
    nodeTextColor: palette.text,
  };
}

async function renderInto(figure: HTMLElement, index: number): Promise<void> {
  const source = figure.querySelector<HTMLElement>('.diagram-source');
  const text = source?.textContent;
  if (source === null || text === undefined || text === null || text.trim() === '') return;

  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`diagram-client-${index}`, text);
    if (svg === '') throw new Error('the renderer produced empty output');

    // Parsed rather than assigned as `innerHTML`: requirements §19.2 asks for
    // DOM APIs or trusted structured rendering rather than untrusted
    // `innerHTML`, and the string here is renderer output over content that,
    // although allowlisted, has not passed the build-time sanitizer on this
    // path. `image/svg+xml` also parses `<style>` inside `<svg>` correctly,
    // which the HTML parser does not.
    //
    // **`xmlns:xlink` is declared here because Mermaid does not declare it and
    // still uses it.** XML has no implicit prefixes, so an `xlink:href` on an
    // undeclared prefix is a well-formedness *error* rather than an unknown
    // attribute — the parse yields a `parsererror` document and the reader is
    // left looking at the fence source. Measured on Mermaid 11.16.1 in
    // Chromium: a C4 diagram renders, and parsing its output gives
    // `Namespace prefix xlink for href on image is not defined` at column
    // 17664; seven other diagram types are unaffected because only C4 emits
    // `<image xlink:href>` for its icons. Build-time mode never meets this —
    // it parses as HTML, where an undeclared prefix is just a name.
    //
    // Declaring the standard binding is a smaller and safer repair than
    // rewriting the attribute: the value is what Mermaid meant, and the URL
    // allowlist below still governs what it may point at.
    //
    // Matched on the **root element's own tag**, not on the whole string. A
    // `svg.includes('xmlns:xlink')` guard was the first version and is wrong in
    // the direction that matters: measured through the real renderer, a diagram
    // whose *label* contains the text `xmlns:xlink` puts it in a `<tspan>` or a
    // `foreignObject`, so such a diagram would skip the declaration and fall
    // back to source — the defect this exists to fix, reintroduced by its own
    // guard.
    const declared = /<svg\b[^>]*\bxmlns:xlink=/.test(svg)
      ? svg
      : svg.replace(/<svg\b/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    const parsed = new DOMParser().parseFromString(declared, 'image/svg+xml');
    const root = parsed.documentElement;
    if (root.querySelector('parsererror') !== null) throw new Error('renderer output is not well-formed');
    if (root.querySelector('script') !== null) throw new Error('renderer emitted a script');
    for (const element of [root, ...root.querySelectorAll('*')]) {
      // `attributes` is live and `removeAttribute` mutates it, so the names are
      // snapshotted first. Iterating it directly skips the entry after each
      // removal — which would leave a handler on the page.
      const names = Array.from(element.attributes, (attribute) => attribute.name);
      for (const name of names) {
        if (/^on/i.test(name)) element.removeAttribute(name);
      }
      // The same URL rule the build-time renderer enforces, for the same
      // reason: Mermaid's `click` directive turns a node into an anchor
      // pointing wherever the diagram source said, including a `javascript:`
      // URL, and this SVG never passed through the build-time href allowlist.
      // Build-time mode fails the build on one of these; here the diagram is
      // already in front of a reader, so the link is dropped and the rest of
      // the diagram still renders.
      for (const attribute of URL_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value === null) continue;
        const isLocal = value.startsWith('#');
        const isInlineRaster = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]*$/i.test(value);
        if (!isLocal && !isInlineRaster) element.removeAttribute(attribute);
      }
    }

    const caption = figure.querySelector('figcaption')?.textContent?.trim();
    if (caption !== undefined && caption !== '') root.setAttribute('aria-label', caption);
    root.setAttribute('focusable', 'false');

    const canvas = document.createElement('div');
    canvas.className = 'diagram-canvas';
    // The container scrolls horizontally when the diagram is wider than the
    // measure, and a scrollable region must be keyboard reachable — axe
    // `scrollable-region-focusable`, WCAG 2.1.1. Build-time mode sets the same
    // attribute in the markup; the two modes must not differ on this.
    canvas.tabIndex = 0;
    canvas.append(document.importNode(root, true));
    // Replace only now that a diagram exists: every failure above leaves the
    // source in place, which is a readable page rather than a blank figure.
    source.replaceWith(canvas);
  } catch {
    // The source is still on the page and is the honest fallback. Nothing is
    // logged: a console error on a published page is a gate failure in
    // `tests/rendered-page.test.ts`, and a reader can act on neither.
  }
}

const figures = [...document.querySelectorAll<HTMLElement>(DIAGRAM_SELECTOR)];
if (figures.length > 0) {
  /**
   * Each figure's source, captured before anything replaces it.
   *
   * A re-render needs the text back, and by then the `<pre>` that held it is
   * gone — `renderInto` replaces it on success, which is the property that
   * leaves a readable page when a render fails.
   */
  const sources = new WeakMap<HTMLElement, string>();
  for (const figure of figures) {
    const text = figure.querySelector<HTMLElement>('.diagram-source')?.textContent;
    if (text !== null && text !== undefined && text.trim() !== '') sources.set(figure, text);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        void renderInto(entry.target as HTMLElement, figures.indexOf(entry.target as HTMLElement));
      }
    },
    // Start fetching a screen ahead, so a diagram is usually ready by the time
    // it is scrolled to rather than appearing after it.
    { rootMargin: '200px' },
  );
  for (const figure of figures) observer.observe(figure);

  /**
   * Re-render every drawn diagram when the theme changes.
   *
   * Mermaid bakes the palette into the SVG at render time, so a diagram drawn
   * in light mode stays light for ever. Build-time mode has no such problem —
   * it renders both palettes and merges them into `light-dark()` values the
   * browser re-resolves — which is why this regression is invisible until
   * somebody runs the client path. Measured before this existed: toggling to
   * dark changed 0 of 60 sampled fills and strokes.
   *
   * **A `MutationObserver` on `data-theme` rather than a custom event**, because
   * `preferences.ts` already mutates that attribute and nothing else needs to
   * know this file exists. `matchMedia` alone would miss the explicit toggle,
   * which is the case a reader actually operates.
   *
   * **Passes are serialized rather than raced, and that is a correctness fix
   * rather than tidiness.** An earlier version started a pass per change and
   * guarded with a generation counter checked *after* `renderInto` — which is
   * after the paint, so a stale pass had already committed its DOM before
   * discovering it was stale. Worse, the newer pass skipped any figure without
   * a `.diagram-canvas`, which is exactly the state an in-flight figure is in,
   * so it stepped over the one figure the stale pass was about to paint in the
   * old palette. The result was a deterministic mixed-palette page: every
   * figure new except the one that had been rendering.
   *
   * Chaining removes the interleaving instead of detecting it. `pending` is the
   * tail of the chain; a change appends to it, so a pass never observes a DOM
   * another pass is midway through mutating. `wanted` is read at the start of
   * each pass rather than captured per change, so a burst of toggles collapses
   * into one redraw at the theme that is actually in effect when its turn
   * comes — measured, a fast triple toggle settles byte-identical to a single
   * clean toggle to the same theme.
   *
   * **Every figure with a captured source is redrawn**, including one still
   * showing that source. A figure mid-initial-render is the case the skip used
   * to miss: its `IntersectionObserver` pass may have called `render()` before
   * the new palette was installed, and nothing would revisit it.
   */
  let pending: Promise<void> = Promise.resolve();
  const redraw = (): void => {
    pending = pending.then(async () => {
      // Re-configure before rendering: `initialize` is what installs the
      // palette, so without this every re-render redraws the old colours.
      configure(await loadMermaid());

      for (const [index, figure] of figures.entries()) {
        const text = sources.get(figure);
        if (text === undefined) continue;
        const canvas = figure.querySelector('.diagram-canvas');
        if (canvas !== null) {
          const source = document.createElement('pre');
          source.className = 'diagram-source';
          source.textContent = text;
          // Put the source back so `renderInto` has its input, then let it do
          // the replacing exactly as on first draw — one code path draws a
          // diagram, and its failure path leaves the source in place.
          canvas.replaceWith(source);
        }
        await renderInto(figure, index);
      }
    });
  };

  new MutationObserver(redraw).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  // The system-preference case, for a reader on "system" who changes it at the
  // OS level: no attribute mutates, so the observer above never fires.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
}
