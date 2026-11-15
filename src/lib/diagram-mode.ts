/**
 * The one place diagram rendering mode and build-time engine are written down.
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
 * **`build-time` is what ships**, with the `pele` engine selected below. The
 * owner chose it after the pele adapter was measured CSP-clean: no `<style>`
 * element and no surviving `style=` attribute reaches `dist/`, so the deployed
 * policy needs no relaxation. `client` mode remains implemented and tested but
 * unselected; Mermaid's `render()` writes inline styles while measuring and
 * drawing, before page code can clean them up, so client mode and
 * `'unsafe-inline'` move together — selecting `client` re-acquires that
 * whole-site relaxation. Changing this constant changes emitted markup,
 * runtime, provenance requirement, and deployed policy.
 *
 * `'unsafe-inline'` is not scoped to diagrams. It re-permits inline styles on
 * every page served the policy, which is why selecting `client` is a whole-site
 * security decision rather than a rendering preference.
 */
export type DiagramMode = 'build-time' | 'client';

export const DIAGRAM_MODE: DiagramMode = 'build-time';

/**
 * The build-time engine is independent of when diagrams render. Client mode
 * continues to use its existing Mermaid runtime; this switch only selects the
 * adapter loaded by `diagram-engine.ts` when rendering at build time.
 * Select the engine here; no environment or runtime override is read.
 *
 * | Engine | Build-time SVG | Browser/DOM dependency on success | Styles |
 * | --- | --- | --- | --- |
 * | `mermaid` | Existing two-palette projection, byte-for-byte unchanged | Headless DOM | Flattened presentation attributes |
 * | `pele` (selected) | Deterministic, namespaced SVG with text positioning preserved | None | Static token variables, rich-label weights and rounded geometry in `diagram.css` |
 *
 * **`pele` is selected**, so a build-time render loads no headless DOM; the
 * `mermaid` adapter remains implemented and tested. Both adapters fail with
 * `DiagramError` rather than publishing unsafe or blank output. Selecting an
 * engine does not change DIAGRAM_MODE or its CSP policy.
 */
export type DiagramEngine = 'mermaid' | 'pele';

export const DIAGRAM_ENGINE: DiagramEngine = 'pele';

/**
 * Thrown when a diagram cannot be rendered safely. The build stops.
 *
 * It lives here, beside the switch that names the two adapters, because both
 * adapters throw it and neither may import the other. `pele-render.ts` importing
 * `mermaid-render.ts` for one class cost the DOM shim on every Pele failure —
 * measured with a loader hook: a malformed source resolved `mermaid-render.ts`,
 * then `mermaid-environment.ts`, then `happy-dom`, which is exactly the cost the
 * engine seam exists to avoid (P1 design §1). This module imports nothing and
 * has no DOM, so the failure path of either adapter loads only itself.
 * `mermaid-render.ts` re-exports the class, so its existing importers are fine.
 */
export class DiagramError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(`${message}\n  in diagram: ${source.trim().slice(0, 200)}`);
    this.name = 'DiagramError';
    this.source = source;
  }
}

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
