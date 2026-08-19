/**
 * The one place the math rendering mode is written down.
 *
 * The sibling of `src/lib/diagram-mode.ts`, and deliberately a *separate*
 * constant rather than a second reader of that one. The two constructs have
 * different costs and the evidence points different ways, so a single switch
 * would force one decision to carry the other's consequences:
 *
 * | | math (`temml`) | diagrams (`mermaid`) |
 * | --- | --- | --- |
 * | JS a page downloads, client mode | ~116 KB gzip | ~232 KB gzip |
 * | `style-src` required | `'self'`, measured at 0 violations | `'self' 'unsafe-inline'` |
 * | Readable with JS disabled | the TeX source | the Mermaid source |
 * | Render call | **synchronous** | asynchronous |
 *
 * **Math needs no CSP relaxation, and diagrams do.** That asymmetry is the whole
 * reason for two constants: selecting client math does not itself widen
 * `style-src`, while selecting client diagrams does.
 *
 * ## Zero CSP violations, and what it took to get there
 *
 * The received account was that `\pmb` and `\sideset` are irreducible violators:
 * `MathNode.setAttribute` stores into `this.attributes` and `toNode()` replays
 * them through a real DOM `setAttribute`, bypassing CSSOM, at `temml.mjs:10141`,
 * `:10142` and `:10795`. Every part of that mechanism is real. **The conclusion
 * drawn from it was wrong in both directions**, measured in Chromium under the
 * policy read from `public/_headers`:
 *
 * | expression | violations, before | after |
 * | --- | --- | --- |
 * | `x^2 + y^2 = z^2` | 0 | 0 |
 * | `\begin{pmatrix} a & b \\ c & d \end{pmatrix}` | **4** | **0** |
 * | `\begin{aligned}`, `\begin{array}` | **4** each | **0** |
 * | `\boxed{E=mc^2}` | **1** | **0** |
 * | `\pmb{x}` | 1 | **0** |
 * | `\sideset{_a^b}{_c^d}\sum` | 2 | **0** |
 *
 * Too narrow, because an ordinary matrix violates four times and goes nowhere
 * near those three sites. And too pessimistic, because the fix is not
 * command-specific at all: `src/lib/math-output.ts`'s `extractStyles` — which
 * the build-time path has always run — rewrites Temml's inline declarations into
 * classes, and the client path was simply not calling it. A `style` attribute
 * that never reaches `innerHTML` cannot be replayed through `setAttribute`.
 *
 * So there is **no documented ceiling and no violating command**. The earlier
 * draft of this file recorded `\pmb` and `\sideset` as an accepted cost; that
 * cost does not exist, and the entry is removed rather than kept as a caution.
 * `tests/math-and-diagrams.test.ts` carries both commands plus a matrix, so a
 * regression that reintroduced any of it would be caught rather than discovered.
 */
export type MathMode = 'build-time' | 'client';

export const MATH_MODE: MathMode = 'client';

/**
 * The costs carried by the selected client mode.
 *
 * Unlike Mermaid, temml needs no relaxation at all — measured at 0 CSP
 * violations across every expression tried — and its single chunk carries no
 * `[[`, no `data:` URL, and no drive-letter-shaped string, measured against the
 * residue scan.
 *
 * What remains is the cost this selected mode moves onto the reader, recorded so
 * the choice stays explicit rather than becoming an unexplained default:
 *
 * 1. **~116 KB gzip per math page**, against 0 in build-time mode. A page with
 *    no math pays nothing either way; the loader is gated on `hasMath`.
 *
 *    **The received figure was ~59 KB and it is wrong**, which matters because
 *    it is the number the whole cost/benefit rests on. 59 KB is
 *    `temml.min.js`; the package's `exports` map sends `import('temml')` to the
 *    unminified `temml.cjs`/`temml.mjs`, and that is **115,541 B gzip**
 *    measured. Astro's bundler minifies what it emits, so the shipped figure
 *    should land nearer the 50 KB mark — but that is a prediction, and the
 *    number recorded here is the one that has actually been measured. Anyone
 *    flipping the mode should measure the emitted chunk rather than trust
 *    either.
 * 2. **The TeX source is excluded from the search index**
 *    (`scripts/run-pagefind.ts`), so a reader cannot find a note by an
 *    expression in it. That is a real loss and it is stated where it is taken.
 * 3. **A reader with JavaScript disabled sees the TeX source**, not typeset
 *    mathematics — the same bargain client diagrams make with their Mermaid
 *    source, and what the owner chose.
 */
export const CLIENT_MATH_COSTS: readonly string[] = [
  'a math page downloads temml: 115,541 B gzip unminified, measured — the ~59 KB figure is temml.min.js, which the exports map does not serve',
  'the TeX source is excluded from the search index, so an expression is not findable',
  'a reader with JavaScript disabled sees the TeX source rather than typeset mathematics',
];
