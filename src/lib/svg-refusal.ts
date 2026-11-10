/**
 * The refusal taxonomy Goal 0012 publishes for an unsafe SVG.
 *
 * A closed set of stable identifiers, for the reason every other closed set in
 * this build gives: the public summary counts labels derived from it, the private
 * report sorts by it, and tests switch on it. Renaming a member is a breaking
 * change to both surfaces.
 *
 * - `svg-invalid` — not well-formed XML, no `<svg>` root, or no usable size.
 * - `svg-doctype` — a DTD, an entity declaration, or a reference to an entity
 *   beyond XML's predefined five.
 * - `svg-xinclude` — an XInclude element.
 * - `svg-script` — a `script` element, an `on*` handler, or a `javascript:` URL.
 * - `svg-foreign` — `foreignObject` or an element/attribute in a namespace this
 *   subset does not support.
 * - `svg-unsafe` — an unsupported construct inside the SVG namespace: an element
 *   or attribute outside the static subset, or a processing instruction other
 *   than an external stylesheet.
 * - `svg-animation` — an animation element (`animate*`, `set`, `discard`).
 * - `svg-external` — any reference that is not a same-document fragment:
 *   external stylesheet, `file:`, `http(s):`, a relative path, `url(...)`.
 * - `svg-data` — an embedded `data:` payload. Refused wholesale by design.
 * - `svg-css` — malformed or unsupported CSS, including an at-rule such as
 *   `@import` or `@font-face`.
 * - `svg-render` — the renderer failed on a document the policy accepted.
 * - `svg-workload` — a document or declared surface beyond the finite render
 *   budget (element count, filter primitives, densities, output pixels).
 * - `svg-font` — visible text a host font would draw as tofu or as nothing.
 * - `svg-empty` — a render with no visible pixel at all.
 */
export type SvgRefusalReason =
  | 'svg-invalid'
  | 'svg-doctype'
  | 'svg-xinclude'
  | 'svg-script'
  | 'svg-foreign'
  | 'svg-unsafe'
  | 'svg-animation'
  | 'svg-external'
  | 'svg-data'
  | 'svg-css'
  | 'svg-render'
  | 'svg-workload'
  | 'svg-font'
  | 'svg-empty';

/**
 * One refusal, with the private diagnostic that makes it actionable.
 *
 * `detail` names the element, attribute, CSS construct or code point at fault.
 * It is read from the untrusted document, so it belongs in the private report
 * and never on the public stream — the same split a withheld file's path has.
 */
export interface SvgRefusal {
  readonly reason: SvgRefusalReason;
  readonly detail: string;
}
