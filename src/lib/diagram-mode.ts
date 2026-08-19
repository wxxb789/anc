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
 * **`client` is what ships.** The owner selected it after accepting the runtime
 * cost, the no-JavaScript source fallback, and the whole-site CSP relaxation.
 * Mermaid's `render()` writes inline styles while measuring and drawing, before
 * page code can clean them up, so client mode and `'unsafe-inline'` move
 * together. Both modes remain implemented and tested; changing this constant
 * changes emitted markup, runtime, provenance requirement, and deployed policy.
 *
 * `'unsafe-inline'` is not scoped to diagrams. It re-permits inline styles on
 * every page served the policy, which is why selecting `client` is a whole-site
 * security decision rather than a rendering preference.
 */
export type DiagramMode = 'build-time' | 'client';

export const DIAGRAM_MODE: DiagramMode = 'client';

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
