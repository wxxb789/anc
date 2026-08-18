/**
 * Client-mode math rendering.
 *
 * Loaded only when `MATH_MODE` is `'client'` and only on pages that contain an
 * expression. In the shipped mode (`'build-time'`) this file is never imported,
 * so none of it — and none of Temml — reaches any page. See
 * `src/lib/math-mode.ts` for what the two modes cost.
 *
 * ## What this deliberately does *not* copy from `src/scripts/diagram.ts`
 *
 * That file is the template, and two thirds of its machinery is unnecessary
 * here. Both omissions are measurements rather than judgements:
 *
 * 1. **No theme re-rendering.** Mermaid bakes its palette into the SVG at render
 *    time, so a theme toggle leaves a diagram frozen in the old colours and the
 *    runtime has to re-run `initialize` and redraw. MathML does not: it inherits
 *    CSS colour like any other element, and measured, Temml's output carries no
 *    colour attribute at all except `\rule`'s hardcoded `black` — which
 *    `src/lib/math.ts` already rewrites to `currentColor` at build time and
 *    which {@link currentColorRule} applies here for the same reason. A
 *    `MutationObserver` on `data-theme` would be complexity for nothing.
 * 2. **No serialized render passes.** The diagram runtime chains its renders
 *    because Mermaid's `render()` is async and two overlapping passes can
 *    interleave a half-painted figure. `temml.renderToString` is **synchronous**
 *    — measured, it returns a `string` rather than a `Promise` — so there is no
 *    interleaving to prevent and nothing to serialize.
 *
 * ## What it does keep, because these are the properties that matter
 *
 * 1. **Nothing loads until it is needed.** The import is deferred behind an
 *    `IntersectionObserver`, so a reader who never scrolls to an expression
 *    never fetches the ~59 KB gzip.
 * 2. **The source stays until the MathML replaces it.** The `<code>` the
 *    renderer emitted is removed only after a successful render, so a failure at
 *    any point leaves the reader with the TeX rather than an empty span. This is
 *    load-bearing in a way it is not for diagrams: `src/lib/math.ts` sets
 *    `throwOnError: true` and a malformed expression aborts the *build*, so
 *    under client rendering there is no build-time gate at all and a throw would
 *    otherwise leave the element empty — measured.
 */

import type { MathMode } from '../lib/math-mode.ts';
import { currentColorRules, extractStyles } from '../lib/math-output.ts';

/** Every span the client branch of `mathPlugin` emits, display and inline. */
const MATH_SELECTOR = 'span.math-display > code.language-math, span.math-inline > code.language-math';

/** Temml is imported at most once per page, on the first expression in view. */
let runtime: Promise<typeof import('temml').default> | undefined;

function loadTemml(): Promise<typeof import('temml').default> {
  runtime ??= import('temml').then((module) => module.default);
  return runtime;
}

/**
 * Render one expression in place, leaving the source alone if anything fails.
 *
 * **Parsed rather than assigned through `innerHTML` on the live element**, so a
 * failure cannot half-replace the source: the MathML is built in a detached
 * container first, and only a container that actually produced a `<math>` root
 * is swapped in. A `parsererror` document still has a root element, so the check
 * is for the element this expects rather than for "something parsed".
 */
function renderInto(host: HTMLElement, temml: typeof import('temml').default): void {
  const code = host.querySelector('code.language-math');
  if (code === null) return;
  const tex = code.textContent ?? '';
  if (tex.trim() === '') return;

  let html: string;
  try {
    // `throwOnError` is **off** here, and that is the opposite of the build-time
    // setting for a reason the two modes do not share. At build time a throw
    // aborts the build and names the expression, which is the strongest possible
    // signal. In the browser there is nobody to tell: a throw would leave the
    // element empty and the reader would lose the expression entirely.
    //
    // **And it is not sufficient on its own**, which is why the build-time
    // validation in `mathPlugin` matters more than this setting does. Measured:
    // `x^`, `x_`, `^` and `a^^` throw a `TypeError` out of Temml *regardless* of
    // `throwOnError`, which only governs its own `ParseError` path. Under client
    // mode those never reach a reader, because `mathPlugin` runs `renderMath` —
    // with `throwOnError: true` — over every expression at build time, so a
    // corpus containing one fails the build exactly as it does today.
    //
    // What remains for this `catch` is the case that setting cannot cover: a
    // Temml version whose browser build disagrees with the one that validated,
    // or an expression that renders at build time and throws in a browser. In
    // that case the reader keeps the TeX, which is the whole point of the
    // fallback.
    html = temml.renderToString(tex, {
      displayMode: host.classList.contains('math-display'),
      throwOnError: false,
      trust: false,
      maxExpand: 1000,
      maxSize: [500, 500],
      annotate: false,
    });
  } catch {
    return;
  }

  const container = document.createElement('span');
  // **`extractStyles` before `innerHTML`, and it is the difference between 0 CSP
  // violations and one per styled element.** At build time the sanitizer drops
  // every `style` attribute that survives this call; here there is no sanitizer,
  // so an unextracted `style` becomes a real attribute and `style-src 'self'`
  // blocks it. Measured in Chromium under the shipped policy without this call:
  // `\begin{pmatrix}` violated 4 times, `\begin{aligned}` and `\begin{array}` 4
  // each, `\boxed` once — none of which are the two commands the received
  // account named. With it, all four are silent.
  container.innerHTML = currentColorRules(extractStyles(html));
  const math = container.querySelector('math');
  if (math === null) return;

  // The source is removed only now, which is what makes every `return` above a
  // safe exit: the reader keeps the TeX in each of them.
  code.remove();
  host.append(math);
}

const hosts = [...document.querySelectorAll<HTMLElement>(MATH_SELECTOR)].map(
  (code) => code.parentElement as HTMLElement,
);

if (hosts.length > 0) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const host = entry.target as HTMLElement;
        void loadTemml().then((temml) => renderInto(host, temml));
      }
    },
    // A margin, so an expression just below the fold is typeset before it
    // arrives rather than visibly swapping under the reader.
    { rootMargin: '200px' },
  );
  for (const host of hosts) observer.observe(host);
}

// Referenced so the type import is not elided, and so this module fails to
// compile if the mode module's contract changes underneath it.
export type { MathMode };
