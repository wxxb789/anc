/**
 * The diagram runtime, in the mode that does not have one.
 *
 * `astro.config.mjs` aliases `src/scripts/diagram.ts` to this file whenever
 * `DIAGRAM_MODE` is `'build-time'` — the selected mode
 * (`src/lib/diagram-mode.ts`), so this stub is what the bundle carries and the
 * client runtime reaches `dist/` only when that constant selects it. The page's
 * `<script>` is bundled eagerly by Astro regardless of any condition around it,
 * so the only way to keep Mermaid's 119 chunks out of `dist/` is to make the
 * module they hang from import nothing.
 *
 * An empty module rather than a deleted `<script>`: the tag still exists, so
 * the two modes emit the same page shape, and the difference between them is
 * exactly one aliased import instead of a divergence in the template.
 */

export {};
