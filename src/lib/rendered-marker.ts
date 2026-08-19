/**
 * The mark that says "a renderer produced this region", and nothing else.
 *
 * A leaf module with no imports, and that is the whole reason it exists rather
 * than living beside the code that writes it. `scripts/scan-residue.ts` needs
 * this vocabulary and its predicates, and importing them from
 * `src/lib/markdown.ts` pulls in `mermaid-render.ts` and a top-level pass that
 * loads every Prism grammar:
 * measured, the residue scan went from **4.1 s to 25.5 s**, on a step that is a
 * link of `pnpm run build` and of the shipped binary's chain. Every user's build
 * would pay twenty seconds to read two literals.
 *
 * `src/lib/markdown.ts` documents what the mark *means*, where it is minted, and
 * why that point is unforgeable. This file is the shared marker interface.
 */

/**
 * The attribute a renderer's output carries.
 *
 * **Unbranded, deliberately.** A first version was `data-thoughtscape-rendered`
 * and `tests/site-identity.test.ts` went red on it: every stranger's note
 * containing an expression or a diagram shipped this project's name into their
 * own `dist/`, which is the headline TK-31 criterion. The attribute has to be
 * unforgeable, not branded — and unforgeability comes from *where* it is
 * written, not from what it is called.
 */
export const RENDERED_MARKER = 'data-rendered';

/** The two kinds of region {@link RENDERED_MARKER} distinguishes. */
export const RENDERED_MATH = 'math';
export const RENDERED_DIAGRAM = 'diagram';

/** A renderer-owned value accepted by the marker interface. */
export type RenderedKind = typeof RENDERED_MATH | typeof RENDERED_DIAGRAM;

/**
 * The marker in an attribute position, wherever it occurs in an opening tag.
 *
 * Kept beside {@link MARKED_ROOT} so the residue scanner and script-budget gate
 * cannot silently grow different definitions of the same security-sensitive
 * grammar. The leading whitespace is load-bearing: without it, a marker-looking
 * string inside another attribute's value would satisfy the predicate.
 */
export const MARKED_ATTRIBUTE = (kind: RenderedKind): RegExp =>
  new RegExp(`\\s${RENDERED_MARKER}="${kind}"`);

/**
 * A marked element's opening tag — the shape a consumer must look for.
 *
 * **Presence in the page is not the property either consumer wants.** The
 * marker string has no character an HTML escaper rewrites, so a note body typing
 * it in a paragraph puts it in the output as ordinary text — measured, and also
 * through numeric character references such as
 * `&#100;&#97;&#116;&#97;-rendered=&#34;math&#34;`. What no body can produce is
 * the marker in an *attribute position on an element*, because it is written
 * after the sanitizer.
 *
 * A first version of the script-budget gate tested the bare string against the
 * whole page, so a note could mint itself 220 KB of allowance by typing it in
 * prose — strictly worse than the author-writable class it replaced. This
 * function exists so that mistake is not available by accident.
 */
export const MARKED_ROOT = (kind: RenderedKind): RegExp =>
  new RegExp(`<[a-zA-Z][a-zA-Z0-9-]*${MARKED_ATTRIBUTE(kind).source}`);
