/**
 * TeX to MathML at build time, with no client JavaScript.
 *
 * Owner decision 2 settles the engine: Temml, not KaTeX. Temml emits native
 * MathML, which every current browser lays out itself — MathML Core has been
 * Baseline widely available since January 2023 — so the page ships markup and a
 * ~9 KB stylesheet instead of a 23 KB stylesheet, a webfont set, and a script.
 * KaTeX's default HTML output additionally puts an inline `style` on nearly
 * every span, which `style-src 'self'` blocks.
 *
 * Three properties are load-bearing:
 *
 * 1. **Zero inline styles reach the page.** Temml writes a small, closed set of
 *    `style` attributes. `sanitize-html` drops every one of them, so what has to
 *    be decided is which of them *matter*, not how to preserve them all. See
 *    {@link STYLE_CLASSES}.
 * 2. **Rendering is deterministic.** Temml mints no ids, reads no clock, and
 *    calls no random source: the same TeX yields byte-identical MathML, verified
 *    across renders and across processes.
 * 3. **A rejected expression fails loudly.** `throwOnError` is on, so a
 *    malformed expression aborts the build rather than shipping Temml's own
 *    error markup, which is a red `<mtext>` carrying an inline `color` that the
 *    sanitizer would then strip — leaving an unmarked, unreadable fragment.
 */

import temml from 'temml';

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
 * TeX constructs rejected outright, each because it would put something in the
 * document that the projection cannot vouch for.
 *
 * Temml already refuses `\href`, `\url`, `\includegraphics`, `\class`,
 * `\cssId`, `\style`, and `\htmlData` under `trust: false` — verified, not
 * assumed — so the only rejection this module has to make itself is colour.
 *
 * **`\textcolor`, `\color`, and `\colorbox` are rejected rather than mapped.**
 * They are the one unbounded, author-chosen part of Temml's output: every other
 * inline declaration comes from a closed set, and these produce an arbitrary
 * `color:#rrggbb`. There is no correct thing to do with such a value on a site
 * with a light and a dark palette. Keeping it fails contrast in one theme —
 * `\textcolor{red}` on `#0d1013` is 3.9:1, below the 4.5:1 AA floor, and
 * `\textcolor{yellow}` on `#fbfaf7` is 1.1:1 in the other direction. Mapping it
 * onto a palette token silently renders something other than what the author
 * wrote. Dropping it silently — which is what the sanitizer does today — makes
 * the emphasis vanish with no signal, and colour was in all likelihood the only
 * thing distinguishing that term.
 *
 * So the build fails and names the expression. An author who wants emphasis
 * inside math has `\mathbf`, `\underline`, `\boxed`, and `\overbrace`, all of
 * which survive both themes and are not colour-alone distinctions (WCAG 1.4.1).
 * Requirements §15.2 permits exactly this: a construct that cannot be rendered
 * safely fails export rather than degrading silently.
 *
 * **The list is a courtesy, not the guarantee.** It exists to give an author a
 * message naming the command they wrote. What actually holds the property is
 * {@link assertNoAuthoredColour}, which inspects the rendered output — because
 * a name list cannot be complete, and was not: `\fcolorbox` is a fifth colour
 * command that this list originally missed, and it was *worse* than the four
 * here, because it emits `mathbackground="#FFFF00"` as an attribute rather than
 * a style, so the extraction pass never saw it and the zero-inline-styles gate
 * stayed green while an author-chosen yellow shipped at 1.1:1 on the light
 * palette. A blocklist in a module whose own policy is allowlists was the bug.
 */
const REJECTED_COMMANDS: readonly string[] = [
  '\\textcolor',
  '\\color',
  '\\colorbox',
  '\\fcolorbox',
  '\\pagecolor',
];

/**
 * MathML attributes that carry a colour, and the only value this projection
 * permits in one.
 *
 * `currentColor` resolves against the inherited text colour, which is
 * `--color-text` in both themes — so it is the one value that cannot fail
 * contrast, because it *is* the colour the surrounding prose already uses.
 * Anything else is a literal an author chose, and the whole argument above says
 * such a literal cannot hold contrast in both palettes.
 *
 * Checked over the rendered output rather than the source, which is what makes
 * it total: it does not matter which command produced the colour, whether that
 * command is named in {@link REJECTED_COMMANDS}, or whether a future Temml
 * version adds a sixth way to set one.
 */
const COLOUR_ATTRIBUTES: readonly string[] = ['mathbackground', 'mathcolor', 'color', 'background'];

function assertNoAuthoredColour(tex: string, html: string): void {
  for (const attribute of COLOUR_ATTRIBUTES) {
    for (const [, value] of html.matchAll(new RegExp(`\\s${attribute}="([^"]*)"`, 'g'))) {
      if (value !== 'currentColor') {
        throw new MathRejectedError(
          tex,
          `the expression sets an author-chosen colour (${attribute}="${value}"), which cannot ` +
            'hold contrast in both themes. Use \\mathbf, \\underline, \\boxed, or \\overbrace, ' +
            'which survive both.',
        );
      }
    }
  }
}

/**
 * Thrown when an expression uses a construct this projection rejects.
 *
 * Fields are assigned in the body rather than declared as parameter
 * properties: `node --experimental-strip-types` — which is how every script in
 * `scripts/` runs — rejects that syntax outright, because erasing the types
 * would change the runtime behaviour rather than only the annotations.
 */
export class MathRejectedError extends Error {
  readonly tex: string;
  readonly reason: string;

  constructor(tex: string, reason: string) {
    super(`math rejected: ${reason}\n  in: ${tex.trim().slice(0, 200)}`);
    this.name = 'MathRejectedError';
    this.tex = tex;
    this.reason = reason;
  }
}

/**
 * Rewrite every inline `style` attribute into the classes above, dropping the
 * declarations that measured no layout effect.
 *
 * Each declaration inside an attribute is looked up on its own, because Temml
 * groups several onto one element: an `array` cell carries
 * `border-bottom:0.06em solid;padding-left:0pt;padding-right:5.9776pt;
 * border-right:0.06em solid` in a single `style`. A declaration the table does
 * not name is dropped — which is what the sanitizer would have done anyway, the
 * difference being that here it is a decision with a measurement behind it
 * rather than an accident of the allowlist. The `mtd` paddings are exactly that
 * case: measured at 0.0% layout effect across 24 expressions, because MathML
 * Core's user-agent stylesheet already supplies them.
 */
function extractStyles(html: string): string {
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
 * One expression's MathML.
 *
 * @param tex The expression body, without delimiters.
 * @param isDisplay Display math (`$$…$$`) rather than inline.
 * @throws {MathRejectedError} when the expression uses a rejected construct or
 *   Temml cannot parse it. Both abort the build; see the note on `throwOnError`.
 */
export function renderMath(tex: string, isDisplay: boolean): string {
  for (const command of REJECTED_COMMANDS) {
    // Word-boundary on the command name, so `\colorbox` does not match inside
    // `\colorboxes` and `\color` does not match inside `\colorbox` — the longer
    // name is listed and would be reported under its own entry either way.
    if (new RegExp(`${command.replace('\\', '\\\\')}(?![a-zA-Z])`).test(tex)) {
      throw new MathRejectedError(
        tex,
        `${command} sets an author-chosen colour, which cannot hold contrast in both themes. ` +
          'Use \\mathbf, \\underline, \\boxed, or \\overbrace, which survive both.',
      );
    }
  }

  let html: string;
  try {
    html = temml.renderToString(tex, {
      displayMode: isDisplay,
      // A parse failure must stop the build. Temml's fallback is markup carrying
      // an inline `color`, which the sanitizer strips — so the page would show
      // the broken source with nothing marking it as broken.
      throwOnError: true,
      // Refuses `\href`, `\url`, `\includegraphics`, `\class`, `\cssId`,
      // `\style`, and `\htmlData`: every command that would inject a URL, a
      // class, or an attribute of the author's choosing.
      trust: false,
      // Bounds the two expansion vectors a hostile or looping macro would use.
      // Temml's own defaults; restated because they are a security property
      // rather than a rendering preference.
      maxExpand: 1000,
      maxSize: [500, 500],
      // No `<annotation>` copy of the TeX source. It would double the byte cost
      // of every expression and put a second copy of the text into the Pagefind
      // index, where it reads as noise next to the rendered form.
      annotate: false,
    });
  } catch (error) {
    throw new MathRejectedError(tex, error instanceof Error ? error.message.split('\n')[0]! : String(error));
  }

  const extracted = currentColorRules(extractStyles(html));
  // Last, and over the *output*: whatever produced a colour, and whichever
  // command spelled it, it does not ship unless it is `currentColor`.
  assertNoAuthoredColour(tex, extracted);
  return extracted;
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
 * command that sets a background of its own choosing, is rejected above.
 */
function currentColorRules(html: string): string {
  return html.replaceAll('<mspace mathbackground="black"', '<mspace mathbackground="currentColor"');
}
