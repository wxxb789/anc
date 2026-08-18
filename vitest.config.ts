/// <reference types="vitest/config" />

/**
 * Vitest reuses Astro's own Vite configuration rather than declaring a second
 * one. `getViteConfig` returns the config Astro builds the site with, so path
 * resolution, TypeScript handling, and `astro.config.mjs`'s load-bearing
 * `assetsInlineLimit: 0` are configured once and cannot drift from what ships.
 *
 * The reference above is what teaches Vite's `UserConfig` about the `test` key.
 * Without it `astro check` rejects this file, because `getViteConfig` is typed
 * against Vite's own config rather than Vitest's extension of it.
 */

import { getViteConfig } from 'astro/config';

export default getViteConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    /**
     * Redirect the report's state directory into a scratch path for the whole
     * run. Seven test files spawn the binary and one remembered to do this per
     * spawn; the file itself explains why that is the wrong place for it.
     */
    setupFiles: ['./tests/setup-state-directory.ts'],
    /**
     * Hold a lock over `dist/` for the whole run.
     *
     * Seven test files read the published `dist/`, and `pnpm run build:fixture`
     * empties and rewrites it — `astro/dist/core/build/static-build.js:64` calls
     * `emptyDir(outDir)` before writing. Run concurrently, the gates read a
     * directory that is empty at that instant.
     *
     * `globalSetup`, not `setupFiles`: setup files run once per *worker*, and
     * `isolate: true` gives each of the thirty-one test files its own — so the
     * lock would be taken thirty-one times and released when the first finished.
     */
    globalSetup: ['./tests/lock-dist.ts'],
    /**
     * Raised from Vitest's 5 s default because a single render can now lay out
     * real diagrams.
     *
     * Since TK-15 a Mermaid fence is rendered to SVG at build time rather than
     * escaped, and that costs a one-off ~1.4 s to import and initialize Mermaid
     * plus ~50 ms per diagram — each rendered twice, once per palette, to pair
     * the themes. Measured on the fixture corpus: 2.9 s for all 32 notes on a
     * cold process, 0.6 s warm. Gates that re-render every note therefore
     * exceeded 5 s and failed as timeouts rather than on any assertion.
     *
     * 30 s is chosen to be comfortably above the cold-process cost while still
     * failing a genuine hang in under a minute. It is not a way to tolerate a
     * slow test: `tests/rendered-page.test.ts` drives a real browser and sets
     * its own longer bounds where it needs them.
     *
     * **Raised to 90 s after measuring it under the real run rather than alone.**
     * The 2.9 s figure above is a cold process with the machine to itself;
     * `isolate: true` gives all 32 files their own worker and they compete.
     * Measured under `pnpm run verify`: `every diagram type renders to CSP-clean
     * SVG` took 36.4 s and `diagram rendering is deterministic across processes`
     * took 40.6 s — both timeouts, neither an assertion, and the second was
     * waiting on children it had itself budgeted 120 s each. A gate whose inner
     * budget is four times its outer one cannot fail the way it intends to.
     *
     * This is the ceiling being raised to where the work actually is, not a
     * tolerance for slowness: 90 s still fails a hung render well inside a
     * two-minute run, and every gate that needs more still says so itself.
     */
    testTimeout: 90_000,
    /**
     * `hookTimeout` is left at Vitest's 10 s default, deliberately.
     *
     * Ten top-level hooks exist across four files, and every one of them now
     * declares its own budget:
     *
     * | hook | cost | budget |
     * | --- | --- | --- |
     * | `preview-server` `beforeAll` | 35 s alone, **187 s** worst over seven runs | 360 s |
     * | `search` / `rendered-page` / `diagram-client` `afterAll` | a Chromium close: p50 22 s, max 43 s contended | 180 s each |
     * | `preview-server` `afterEach` (×16) / `afterAll` | 12.9 s worst over six runs / 0 ms | 45 s each |
     * | `search` `beforeAll` | 0.4-0.9 s | 120 s |
     * | `rendered-page` `beforeAll` | 0.5 s typical, **23.7 s** worst | 120 s |
     * | `diagram-client` `beforeAll` | 0.8 s, but it also builds a fixture site | `BROWSER_TIMEOUT` |
     *
     * The `afterEach` row is the one that had to be measured twice: five runs put
     * it at 5-6.5 s against the 10 s default, which reads as a bound worth
     * keeping tight, and the sixth put it at 12.9 s — over, on a run that
     * otherwise passed. A margin argued from five samples was wrong at six.
     *
     * Raising the global would relax all ten to accommodate six, and the
     * argument is the same one that gave `math-and-diagrams`'s every-diagram-type
     * gate its own 300 s rather than lifting `testTimeout`.
     *
     * **The gap this closes was real and cost a red run.** `search.test.ts` does
     * its browser teardown in `afterAll` and carried 60 s, which is the one
     * budget a `testTimeout` rise does not touch: `Hook timed out in 60000ms`,
     * on a run whose 693 tests all passed. A hook budget is not a test budget,
     * and a file whose work is in a hook is governed by the one you did not set.
     */
    // Each file gets its own worker, matching what `node --test` gave us with
    // one process per file. `tests/markdown.test.ts` depends on it: Prism's
    // grammar registry is a process-wide singleton, and its determinism gate
    // deliberately contaminates that registry.
    isolate: true,
    server: {
      deps: {
        // `src/lib/markdown.ts` imports `prismjs/components.json` with an
        // `import ... with { type: 'json' }` attribute. Left external, Vite
        // hands the specifier back to Node without the attribute and the import
        // throws.
        //
        // Only the JSON is inlined, never `prismjs` itself. Prism's grammar
        // registry is a process-wide singleton, and inlining the package gives
        // Vite's transformed ESM copy a *second* registry: `markdown.ts` loads
        // grammars through `createRequire` into the CJS instance while
        // `@astrojs/prism`'s highlighter tokenizes against the ESM one, which
        // has none — so every fence silently renders as unhighlighted source.
        // Two gates in `tests/markdown.test.ts` catch exactly that.
        inline: [/prismjs\/components\.json$/],
      },
    },
  },
});
