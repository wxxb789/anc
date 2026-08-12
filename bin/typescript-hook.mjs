/**
 * Teaches Node to load this package's own `.ts` sources once it lives under a
 * consumer's `node_modules`.
 *
 * Every script in `scripts/` and every module in `src/lib/` is TypeScript, run
 * directly by Node's built-in type stripping. That works in this repository and
 * **stops working the moment the package is installed**, because Node refuses to
 * strip types from any file under `node_modules`:
 *
 *     Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
 *     currently unsupported for files under node_modules
 *
 * Measured, not assumed — a two-file probe reproduces it on Node 24.18.1, for
 * both a bare-specifier import and a direct `node node_modules/x/file.ts`. There
 * is no flag that lifts it: `--experimental-strip-types` does not, and the
 * restriction is deliberate, so a package cannot make its consumers pay an
 * unbounded compile cost on every import of a transitive dependency.
 *
 * The supported escape hatch is to do the stripping ourselves. `registerHooks`
 * (synchronous, in-thread, stable since Node 22.15) intercepts the load and
 * hands back already-stripped source, so Node never applies the policy — the
 * file arrives as plain JavaScript. `stripTypeScriptTypes` is the same
 * implementation Node's own loader uses, so what runs is byte-identical to what
 * runs here today.
 *
 * `mode: 'strip'` rather than `'transform'` is load-bearing in the same way it
 * is for the in-repo build: stripping only erases annotations, so no
 * TypeScript-only construct that *emits* code — `enum`, `namespace`, parameter
 * properties — may appear in this package's sources. That constraint already
 * holds and is already enforced, because `node --experimental-strip-types` is
 * how every script here runs; `src/lib/math.ts:150-157` records a parameter
 * property being rejected for exactly this reason.
 *
 * Only this package's own files are intercepted. A `.ts` file belonging to a
 * dependency is left to Node, which is the behaviour it would have had anyway.
 * Deliberately not a general-purpose TypeScript loader: it compiles nothing it
 * does not own.
 */

import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * This package's root, as a `file:` URL prefix.
 *
 * The comparison is on the resolved URL rather than on a path substring: a
 * consumer's own `.ts` file, or one in an unrelated dependency, must not be
 * routed through here. `new URL('../', import.meta.url)` resolves to the
 * package root because this file sits in `bin/`.
 */
const PACKAGE_ROOT = new URL('../', import.meta.url).href;

/**
 * `stripTypeScriptTypes` is flagged experimental, so Node prints a warning on
 * first use — once, to stderr, in the middle of a user's build output. The API
 * is the one Node's own loader calls and this package pins a Node floor in
 * `engines`, so the warning describes a stability risk this build has already
 * accepted rather than an action a user can take.
 *
 * Filtered by name at the emitter rather than suppressed process-wide with
 * `--disable-warning`: that flag would need to reach the shebang, where it would
 * apply to *every* warning this build or any dependency ever emits, including
 * ones a user should see. This removes exactly one.
 */
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const name = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (name === 'ExperimentalWarning' && String(warning).includes('stripTypeScriptTypes')) return;
  emitWarning.call(process, warning, ...rest);
};

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(PACKAGE_ROOT) || !url.endsWith('.ts')) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      // `sourceUrl` keeps stack traces pointing at the `.ts` file rather than at
      // an anonymous evaluated string, which is the difference between a build
      // failure a user can act on and one they cannot.
      source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
        mode: 'strip',
        sourceUrl: url,
      }),
    };
  },
});
