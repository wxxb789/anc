// @ts-check
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { DIAGRAM_MODE } from './src/lib/diagram-mode.ts';
import { configForBuild } from './scripts/load-config.ts';

/**
 * Keep the diagram runtime out of the build unless client mode wants it.
 *
 * `src/pages/notes/[slug].astro` has an Astro `<script>` importing
 * `src/scripts/diagram.ts`, and Astro bundles such a script **eagerly**:
 * wrapping the tag in a condition or guarding the import at runtime does not
 * keep it out of `dist/`. Measured, not assumed — the guarded version emitted
 * 99 Mermaid chunks on a build whose mode was `build-time`, orphaned and
 * referenced by no page, and tripped the privacy residue scan on `[[` byte
 * sequences inside the parser.
 *
 * A plugin rather than `resolve.alias`, because an alias is matched against the
 * *raw specifier* — here `../../scripts/diagram.ts` — before resolution, so a
 * pattern written against the real path never fires. `resolveId` runs after the
 * path is known, which is the only place the question "is this that module" can
 * be asked reliably.
 *
 * Typed structurally rather than as `import('vite').Plugin`: `vite` reaches this
 * tree through Astro and is not a declared dependency, and under pnpm an
 * undeclared package does not resolve — which is the boundary `AGENTS.md` names
 * as a feature. Adding `vite` to `package.json` to annotate one function would
 * spend a dependency on a type.
 *
 * @param {'build-time' | 'client'} mode
 * @returns {{
 *   name: string,
 *   enforce: 'pre',
 *   resolveId: (
 *     this: { resolve: (source: string, importer: string | undefined, options: object) =>
 *       Promise<{ id: string } | null> },
 *     source: string,
 *     importer: string | undefined,
 *     options: object,
 *   ) => Promise<string | null>,
 * }}
 */
function diagramRuntimePlugin(mode) {
  const stub = fileURLToPath(new URL('src/scripts/diagram-disabled.ts', import.meta.url));
  // The extension is matched loosely because it is not the same in both trees:
  // this repository runs `diagram.ts` directly, while the packaged tarball ships
  // it compiled to `diagram.js` (`scripts/compile-package.ts`). Pinning `.ts`
  // here meant the redirect silently stopped firing once installed — Mermaid's
  // whole runtime was then bundled into a `build-time` site, which the residue
  // scan caught on `[[` byte sequences inside the parser. Matching either
  // extension keeps one rule true of both trees.
  const target = /[\\/]src[\\/]scripts[\\/]diagram\.(?:ts|js)$/;
  return {
    name: 'thoughtscape:diagram-mode',
    // Ahead of Vite's own resolver, so the redirect happens before the module
    // is loaded and its imports crawled.
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (mode === 'client') return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved !== null && target.test(resolved.id) ? stub : null;
    },
  };
}

/**
 * THE ONE PLACE THIS SITE'S PUBLIC ORIGIN IS WRITTEN DOWN.
 *
 * `.invalid` is reserved by RFC 2606 and is guaranteed never to resolve, so
 * this is a placeholder that cannot be mistaken for a real domain and cannot
 * accidentally point a crawler at somebody else's server. No public domain has
 * been assigned yet.
 *
 * **To assign the real origin, change this line and nothing else.** Every
 * canonical link, Open Graph URL, feed id, sitemap `<loc>`, and the
 * `Sitemap:` line in `robots.txt` is derived from it at build time, and
 * `tests/metadata.test.ts` fails if any of them is ever written literally
 * somewhere else. Redeploying after the change is what publishes it; nothing
 * here deploys.
 *
 * **A user's own `publish.config.yaml` overrides it, and this stays the
 * fallback rather than moving into the loader.** That is the point of the
 * arrangement rather than an accident of it: a build of *this* repository, and
 * a stranger's build before they have configured anything, both need an origin,
 * and there is exactly one place to read it from. `scripts/load-config.ts`
 * deliberately returns `undefined` for an unconfigured origin — a default there
 * would be a second home for this value, which is the property the test above
 * exists to hold.
 */
const DEFAULT_ORIGIN = 'https://thoughtscape.invalid';

/**
 * The user's configuration, read once at config evaluation.
 *
 * `configForBuild` resolves the directory from `PUBLISH_CONFIG_DIR`, falling
 * back to the working directory. A packaged build has already changed its
 * working directory to the installed package by the time this runs, which is
 * why the variable exists at all; `bin/thoughtscape-publish.mjs` documents the
 * same boundary for `CONTENT_ARTIFACT`. For a build of *this* repository the
 * fallback is the repository root — so a `publish.config.yaml` committed here
 * would reconfigure this repository's own build, which is the honest
 * description and not a bug: this repository is the tool, and there is no such
 * file in it.
 *
 * A malformed config stops the build before a single page is generated — the
 * ordering `docs/plans/ssg-generalisation-plan.md` §4.3 asks for, where a config
 * error cannot be masked by a build that otherwise succeeded.
 *
 * **Caught rather than thrown, because this module scope has no boundary above
 * it that knows how to print one.** `bin/thoughtscape-publish.mjs` prints a
 * `BuildFailure`'s own message and nothing else; a `astro build` or `astro dev`
 * run directly has only Astro's config loader, which was measured printing the
 * composed message *plus* a stack trace carrying four absolute host paths —
 * `at refuse (Q:/…/scripts/load-config.ts:313:8)` and three more. TK-25 §2.3
 * forbids a discovered filesystem path on that stream, and `astro dev`
 * evaluates this same scope, so the leak is not confined to the packaged path.
 * Printing the message and exiting keeps the diagnostic and drops the trace.
 */
function loadUserConfig() {
  try {
    return configForBuild();
  } catch (error) {
    // Only a message composed under the disclosure rule may be printed. Anything
    // else is a string this project did not write, on a world-readable stream.
    if (error instanceof Error && error.name === 'BuildFailure') {
      console.error(error.message);
    } else {
      console.error('the configuration file could not be read');
    }
    process.exit(1);
  }
}

const config = loadUserConfig();

// https://astro.build/config
export default defineConfig({
  site: config.origin ?? DEFAULT_ORIGIN,
  output: 'static',
  trailingSlash: 'always',
  vite: {
    plugins: [diagramRuntimePlugin(DIAGRAM_MODE)],
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
