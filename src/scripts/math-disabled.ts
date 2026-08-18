/**
 * The math runtime, in the mode that does not have one.
 *
 * `astro.config.mjs` aliases `src/scripts/math.ts` to this file whenever
 * `MATH_MODE` is `'build-time'`, which is the mode that ships. The page's
 * `<script>` is bundled eagerly by Astro regardless of any condition around it,
 * so the only way to keep Temml out of `dist/` is to make the module it hangs
 * from import nothing.
 *
 * An empty module rather than a deleted `<script>`: the tag still exists, so the
 * two modes emit the same page shape, and the difference between them is exactly
 * one aliased import instead of a divergence in the template. The sibling of
 * `src/scripts/diagram-disabled.ts`, which documents the same arrangement for
 * diagrams.
 */

export {};
