// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  trailingSlash: 'always',
  vite: {
    build: {
      // Load-bearing for the CSP, not a size preference. Above 0, Vite inlines
      // a small `?url` asset as a `data:` URL — and `src/scripts/theme-init.js`
      // is exactly that, imported by `Layout.astro`. A `data:` script violates
      // `script-src 'self'`, so the theme would never apply. The
      // `every script is loaded from this origin` test in
      // `tests/built-output.test.ts` fails if this is ever raised.
      assetsInlineLimit: 0,
    },
  },
});
