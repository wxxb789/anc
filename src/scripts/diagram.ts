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

function loadMermaid(): Promise<typeof import('mermaid').default> {
  runtime ??= import('mermaid').then((module) => {
    const mermaid = module.default;
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
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
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
}
