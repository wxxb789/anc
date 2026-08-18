/**
 * The Temml post-processing both rendering modes need, with no Temml in it.
 *
 * `src/lib/math.ts` owns the build-time path and imports Temml, so a client
 * runtime importing that module would pull Temml's server-side entry into the
 * page bundle. These two functions are pure string transforms over Temml's
 * output, so they live here and both modes call them.
 *
 * **Extracted because the client path was measured missing them, and the
 * consequence was larger than any brief predicted.** Client mode without
 * {@link extractStyles} lets every `style` attribute Temml writes reach a live
 * DOM `setAttribute`, which is exactly what `style-src 'self'` blocks. Measured
 * in Chromium under the shipped policy, violations per expression:
 *
 * | expression | violations |
 * | --- | --- |
 * | `x^2 + y^2 = z^2` | 0 |
 * | `\begin{pmatrix} a & b \\ c & d \end{pmatrix}` | **4** |
 * | `\begin{aligned}`, `\begin{array}` | **4** each |
 * | `\boxed{E=mc^2}` | **1** |
 * | `\pmb{x}` | 1 |
 * | `\sideset{_a^b}{_c^d}\sum` | 2 |
 *
 * The received account was that `\pmb` and `\sideset` are the only violating
 * commands, via three `MathNode.setAttribute` sites in `temml.mjs`. That is true
 * of those three sites and false as a description of the whole: an ordinary
 * matrix violates four times and goes nowhere near them. Running the same
 * extraction the build-time path already runs removes the padding and border
 * cases entirely and leaves the genuinely irreducible pair.
 */

/**
 * Inline declarations Temml emits that a class must reproduce, because dropping
 * them changes the rendered geometry.
 *
 * The whole inline surface is 39 distinct declarations over a 77-expression
 * corpus in both display and inline mode. Reproducing all 39 was rejected:
 * measured in Chromium against Temml's own stylesheet, dropping each property
 * group and re-measuring, only three groups move the box at all. The rest —
 * `math-depth`, `width`, every `padding-left`/`padding-right` on `mtd`, and
 * `color` — measured **0.0% deviation on all 24 test expressions**, because
 * MathML Core's user-agent stylesheet already computes them. A class per
 * declaration would have been 39 rules of which 36 changed nothing.
 *
 * What survives, with what it costs to drop it:
 *
 * | Declaration | Carrier | Dropping it |
 * | --- | --- | --- |
 * | `display:block math` | `math.tml-display` | up to 9% on a wide array |
 * | `padding` / `padding-top` / `padding-bottom` | `mtd`, `mrow`, `mpadded` | up to 32% on `align`, `gather`, `bordermatrix` |
 * | `border` / `border-right` / `border-bottom` | `mrow`, `mtd` | up to 8% on `\boxed`, and a lost rule in `array` |
 *
 * Each is reproduced by a rule in `src/styles/math.css` keyed on an element and
 * a class this module writes. `display:block math` is additionally implied by
 * `math.tml-display`, which Temml sets itself, and the `array` borders are
 * structural rather than author-chosen.
 *
 * One value in the set is genuinely dynamic — `\raisebox`'s
 * `padding: 2.8892pt 0 0 0`, whose length comes from the author — and it is
 * *dropped*, not reproduced. The raise survives anyway, because Temml also
 * emits `voffset`, a real MathML attribute that the sanitizer keeps and that
 * does the same job. Nothing else in the set depends on author input.
 */
export const MATH_STYLE_CLASSES: Readonly<Record<string, string>> = {
  'border:1px solid': 'math-boxed',
  'padding:3pt': 'math-boxed-pad',
  'border-right:0.06em solid': 'math-cell-rule-right',
  'border-bottom:0.06em solid': 'math-cell-rule-bottom',
  'padding:0': 'math-cell-tight',
  'padding-top:0': 'math-cell-tight-top',
  'padding-bottom:0': 'math-cell-tight-bottom',
};

/**
 * Rewrite every inline `style` attribute into the classes above, dropping the
 * declarations that measured no layout effect.
 *
 * Each declaration inside an attribute is looked up on its own, because Temml
 * groups several onto one element: an `array` cell carries
 * `border-bottom:0.06em solid;padding-left:0pt;padding-right:5.9776pt;
 * border-right:0.06em solid` in a single `style`. A declaration the table does
 * not name is dropped — which is what the sanitizer would have done anyway at
 * build time, the difference being that here it is a decision with a measurement
 * behind it rather than an accident of the allowlist. The `mtd` paddings are
 * exactly that case: measured at 0.0% layout effect across 24 expressions,
 * because MathML Core's user-agent stylesheet already supplies them.
 *
 * **In client mode the sanitizer is not there at all**, which is what makes this
 * function load-bearing rather than tidy: the string goes into `innerHTML`, so
 * an unextracted `style` becomes a real attribute and a real CSP violation.
 */
export function extractStyles(html: string): string {
  return html.replace(
    /<([a-zA-Z0-9:-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)\sstyle="([^"]*)"/g,
    (_match, tag: string, rest: string, css: string) => {
      const classes: string[] = [];
      for (const declaration of css.split(';')) {
        const trimmed = declaration.trim();
        if (trimmed === '') continue;
        const name = MATH_STYLE_CLASSES[trimmed];
        if (name !== undefined && !classes.includes(name)) classes.push(name);
      }
      if (classes.length === 0) return `<${tag}${rest}`;
      const existing = /\sclass="([^"]*)"/.exec(rest);
      if (existing) {
        return `<${tag}${rest.replace(/\sclass="([^"]*)"/, ` class="$1 ${classes.join(' ')}"`)}`;
      }
      return `<${tag}${rest} class="${classes.join(' ')}"`;
    },
  );
}

/**
 * `\rule` draws a bar whose colour Temml hardcodes as
 * `<mspace mathbackground="black">`. On the dark palette that is a black bar on
 * a `#0d1013` background — invisible, and invisible in a way no gate would see,
 * because the element is present and correctly sized.
 *
 * `currentColor` is the fix and it is exact rather than approximate: MathML
 * resolves it against the inherited text colour, which is `--color-text` in
 * both themes, so the rule renders in the same ink as the expression around it.
 * That is what `\rule` means — a bar drawn in the current pen — and it is what
 * every other Temml border already does, via `border-color: currentColor` in
 * Temml's own stylesheet.
 *
 * Narrow by construction: only `mathbackground`, only the literal `black`
 * Temml writes. An author cannot reach this attribute — `\colorbox`, the one
 * command that sets a background of its own choosing, is rejected by
 * `src/lib/math.ts` at build time and cannot produce a colour Temml would put
 * here.
 */
export function currentColorRules(html: string): string {
  return html.replaceAll('<mspace mathbackground="black"', '<mspace mathbackground="currentColor"');
}
