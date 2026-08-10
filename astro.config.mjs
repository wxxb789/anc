// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // THE ONE PLACE THIS SITE'S PUBLIC ORIGIN IS WRITTEN DOWN.
  //
  // `.invalid` is reserved by RFC 2606 and is guaranteed never to resolve, so
  // this is a placeholder that cannot be mistaken for a real domain and cannot
  // accidentally point a crawler at somebody else's server. No public domain has
  // been assigned yet.
  //
  // **To assign the real origin, change this line and nothing else.** Every
  // canonical link, Open Graph URL, feed id, sitemap `<loc>`, and the
  // `Sitemap:` line in `robots.txt` is derived from it at build time, and
  // `tests/metadata.test.ts` fails if any of them is ever written literally
  // somewhere else. Redeploying after the change is what publishes it; nothing
  // here deploys.
  site: 'https://thoughtscape.invalid',
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
