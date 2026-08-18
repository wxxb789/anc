/**
 * The one place the diagram rendering mode is written down.
 *
 * Owner decision 5 makes Mermaid dual-mode. The two modes differ in what ships,
 * what the CSP must permit, and what a reader with JavaScript disabled sees, so
 * a mode that the build and the deployed policy disagreed about would ship a
 * page whose diagrams are blocked by its own headers. Both read this constant;
 * `tests/deployment.test.ts` asserts that `public/_headers` matches whichever
 * mode is selected here, in both directions.
 *
 * | | `build-time` | `client` |
 * | --- | --- | --- |
 * | JavaScript shipped | 0 B | 201 KB gzip floor, per diagram page |
 * | `style-src` | `'self'` | `'self' 'unsafe-inline'` |
 * | Readable with JS disabled | yes, it is markup | no |
 * | Inline styles in `dist/` | zero, asserted | present by construction |
 *
 * **`build-time` is what ships.** Owner decision 5 named client-side as the
 * default, and the evidence gathered after that decision (the Mermaid feasibility probe
 * §7.4, and this ticket’s own measurements) inverted the case:
 * the same post-processing pass that yields zero CSP violations at build time
 * yields 38 in a browser, because Mermaid's `render()` violates the policy
 * *internally* while measuring text, before any page code can intervene. The
 * client path cannot be cleaned up later. Both modes are implemented and both
 * are tested; flipping this constant flips the emitted markup, the emitted CSP,
 * and the gate that measures them, which is the property the ticket asks for.
 *
 * `'unsafe-inline'` is not scoped to diagrams. It re-permits inline styles on
 * every page served the policy, which is why selecting `client` is a whole-site
 * security decision rather than a rendering preference.
 */
export type DiagramMode = 'build-time' | 'client';

export const DIAGRAM_MODE: DiagramMode = 'build-time';

/**
 * What selecting `client` still requires, beyond flipping the constant above.
 *
 * Both modes are implemented and both render correctly in a real browser —
 * client mode was verified end to end at 0 CSP violations in both themes. But
 * two gates outside this ticket's fence currently *forbid* the configuration
 * client mode needs, so selecting it makes the build red rather than shipping a
 * broken page. Recorded here rather than worked around, because a mode switch
 * whose remaining cost is undocumented is the trap this constant exists to
 * avoid.
 *
 * 1. **`tests/deployment.test.ts` hardcodes the build-time policy.** It asserts
 *    `style-src` is exactly `'self'`, and separately that no directive contains
 *    `'unsafe-inline'`. Both must read {@link REQUIRED_STYLE_SRC} instead. That
 *    file is TK-14's; changing it needs the same recorded authorization TK-08
 *    took to add its `_headers` rule.
 * 2. **The privacy residue scan rejects Mermaid's own bundle.** Measured: 21
 *    findings across the 99 chunks client mode emits — `[[` inside 18 parser
 *    chunks, a `data:text/html;base64` in `mermaid.core`, a drive-letter-shaped
 *    `s:/` in `defaultLocale`. Every one is a byte coincidence in third-party
 *    code rather than residue, but `scan:residue` is a link of `build`, so the
 *    Cloudflare build fails. It needs a vendored-runtime exemption of the kind
 *    it already grants Pagefind — a TK-09/TK-14 decision, not this ticket's to
 *    make unilaterally. (The vacuity ambiguity this paragraph used to also
 *    record — `scanResidue` reporting "I couldn't look" as a finding — is
 *    fixed, and its reasoning now lives in `scripts/scan-residue.ts`, where the
 *    behaviour is. It was recorded here only because this constant happened to
 *    be the file someone had open, and it would have been deleted with this
 *    constant.)
 *
 * Until both are settled, `client` is implemented-and-verified but not
 * shippable, and `build-time` is not merely the better choice — it is the only
 * one the gates admit.
 */
export const CLIENT_MODE_BLOCKERS: readonly string[] = [
  'tests/deployment.test.ts asserts style-src is exactly \'self\' and that no directive relaxes to \'unsafe-inline\'',
  'scripts/scan-residue.ts reports 21 findings in Mermaid\'s own chunks, all byte coincidences in third-party code',
];

/**
 * The `style-src` value each mode requires, measured rather than reasoned.
 *
 * `client` needs both the element and the attribute form relaxed and a single
 * `'unsafe-inline'` in `style-src` is what does that; relaxing only
 * `style-src-elem` keeps the theme but loses the sizing, and relaxing only
 * `style-src-attr` loses the theme. Hash-pinning was tested and cannot work:
 * hashes never cover a `style=` attribute, so `'unsafe-inline'` survives in
 * `style-src-attr` and merely relocates. See the feasibility probe §7.2
 * and §7.3.
 */
export const STYLE_SRC_BY_MODE: Readonly<Record<DiagramMode, string>> = {
  'build-time': "'self'",
  client: "'self' 'unsafe-inline'",
};

/** The `style-src` the deployed policy must declare for the selected mode. */
export const REQUIRED_STYLE_SRC = STYLE_SRC_BY_MODE[DIAGRAM_MODE];
