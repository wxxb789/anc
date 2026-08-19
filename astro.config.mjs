// @ts-check
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { DIAGRAM_MODE } from './src/lib/diagram-mode.ts';
import { MATH_MODE } from './src/lib/math-mode.ts';
import { configForBuild } from './scripts/load-config.ts';
import { vendorProvenancePlugin } from './scripts/vendor-provenance.ts';

/**
 * Keep a client runtime out of the build unless client mode wants it.
 *
 * `src/pages/notes/[slug].astro` has Astro `<script>` tags importing
 * `src/scripts/diagram.ts` and `src/scripts/math.ts`, and Astro bundles such a
 * script **eagerly**: wrapping the tag in a condition or guarding the import at
 * runtime does not keep it out of `dist/`. Measured, not assumed — the guarded
 * version emitted 99 Mermaid chunks on a build whose mode was `build-time`,
 * orphaned and referenced by no page, and tripped the privacy residue scan on
 * `[[` byte sequences inside the parser.
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
 * @param {'diagram' | 'math'} runtime
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
function clientRuntimePlugin(runtime, mode) {
  const stub = fileURLToPath(new URL(`src/scripts/${runtime}-disabled.ts`, import.meta.url));
  // The extension is matched loosely because it is not the same in both trees:
  // this repository runs `diagram.ts` directly, while the packaged tarball ships
  // it compiled to `diagram.js` (`scripts/compile-package.ts`). Pinning `.ts`
  // here meant the redirect silently stopped firing once installed — Mermaid's
  // whole runtime was then bundled into a `build-time` site, which the residue
  // scan caught on `[[` byte sequences inside the parser. Matching either
  // extension keeps one rule true of both trees.
  //
  // **Parameterised over the runtime rather than duplicated**, because math
  // needs exactly this arrangement for exactly this reason and a second copy is
  // a second place for the `.ts`/`.js` lesson above to be relearned. The two
  // modes are separate constants (`DIAGRAM_MODE`, `MATH_MODE`) — the costs and
  // the evidence differ, so one switch must not carry the other's consequences —
  // but the mechanism that keeps an unselected runtime out of `dist/` is one.
  const target = new RegExp(String.raw`[\\/]src[\\/]scripts[\\/]${runtime}\.(?:ts|js)$`);
  return {
    name: `thoughtscape:${runtime}-mode`,
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
 * THE ONE PLACE A SITE'S PUBLIC ORIGIN IS WRITTEN DOWN.
 *
 * **`.localhost` rather than `.invalid`, and the change is the point of
 * TK-31.** RFC 6761 reserves `.localhost` and requires resolvers to map the
 * name *and all its subdomains* to loopback, so this is a name that cannot
 * resolve to anybody else's server — the property `.invalid` was chosen for —
 * and that additionally *works*: a preview build's canonical links, feed, and
 * sitemap all point at a local origin a browser can actually follow.
 *
 * The value it replaced was `https://thoughtscape.invalid`, which was safe and
 * was still one owner's name on every stranger's site. That is the whole of
 * plan decision D2. `.invalid` was never wrong about *safety* — TK-24's gate
 * was right that a reserved name cannot misdirect a crawler — it was wrong
 * about *whose*, and a default that belongs to nobody is what this ticket owes
 * every user who configures nothing.
 *
 * **Deliberately no port**, per plan §5.5: a canonical URL, a feed id, and a
 * `<loc>` should not carry a development port, and they are not deployable
 * anyway. `astro dev` serves `http://localhost:4321/` regardless; what this
 * governs is the absolute URLs written *into* the built documents.
 *
 * **This is a preview origin, not a publishable one, and nothing here can tell
 * the difference.** A site built with it is complete and correct and obviously
 * local at a glance — which is a property `.invalid` gave up by producing URLs
 * that looked plausible. Refusing to *deploy* it belongs to the deploy step,
 * which this repository does not have and does not perform.
 *
 * **A user's own `publish.config.yaml` overrides it, and this stays the
 * fallback rather than moving into the loader.** That is the point of the
 * arrangement rather than an accident of it: a build of *this* repository, and
 * a stranger's build before they have configured anything, both need an origin,
 * and there is exactly one place to read it from. `scripts/load-config.ts`
 * deliberately returns `undefined` for an unconfigured origin — a default there
 * would be a second home for this value. `tests/metadata.test.ts` fails if the
 * host appears in any file under `src/`, `scripts/`, `tests/`, or `public/`
 * other than this one.
 */
const DEFAULT_ORIGIN = 'http://publish.localhost/';

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

/**
 * Hand the configured title to the page modules.
 *
 * `src/lib/site.ts` reads it from here and cannot read it from anywhere else:
 * importing `scripts/load-config.ts` from `src/lib/` breaks the build, because
 * Astro evaluates that module out of `dist/.prerender/` and the loader's
 * dependency reads `../package.json` relative to its own URL — measured,
 * `ENOENT: … dist\.prerender\package.json` at "generating static routes". The
 * variable is the same seam `CONTENT_ARTIFACT` already uses across the same
 * boundary, and that module documents the mechanism at length.
 *
 * Set here rather than in `bin/thoughtscape-publish.mjs` because this is the
 * one scope that runs for *every* way a build starts — the packaged binary,
 * `astro build` in a checkout, and `astro dev` — and each of them needs the
 * title. `config.title` always holds a value: `loadConfig` applies its own
 * default when the user configured nothing, which is why there is no `??` here
 * and why an unconfigured build still gets a legible name.
 *
 * **The name is spelled out rather than imported, deliberately.** Importing
 * `SITE_TITLE_VARIABLE` from `src/lib/site.ts` would evaluate that module here,
 * at config time, *before* this line runs — so its `SITE_NAME` would be
 * computed from an unset variable, giving one process two module instances that
 * disagree about the site's name. A literal has no such ordering. The cost is a
 * second copy of the spelling, and it is paid the way this repository already
 * pays it for `theme-init.js`: `tests/site-identity.test.ts` reads both files
 * and fails if they name different variables, so a rename cannot half-apply.
 */
process.env['PUBLISH_SITE_TITLE'] = config.title;

// https://astro.build/config
export default defineConfig({
  site: config.origin ?? DEFAULT_ORIGIN,
  output: 'static',
  trailingSlash: 'always',
  vite: {
    plugins: [
      clientRuntimePlugin('diagram', DIAGRAM_MODE),
      clientRuntimePlugin('math', MATH_MODE),
      vendorProvenancePlugin(fileURLToPath(new URL('.', import.meta.url))),
    ],
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
