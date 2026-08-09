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
