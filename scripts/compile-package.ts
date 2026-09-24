/**
 * Compiles this package's TypeScript to JavaScript, in place, for `npm pack`.
 *
 * ## Why the tarball cannot ship `.ts`
 *
 * Every script in `scripts/` and every module in `src/lib/` is TypeScript run
 * directly by Node's built-in type stripping. That works in this repository and
 * **stops working the moment the package is installed**, because Node refuses to
 * strip types from any file under `node_modules`:
 *
 *     Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
 *     currently unsupported for files under node_modules
 *
 * Measured on Node 24.18.1, for a bare-specifier import and a direct `node
 * node_modules/x/file.ts` alike. No flag lifts it — `--experimental-strip-types`,
 * `--experimental-transform-types`, and `--no-experimental-detect-module` were
 * each tried and each still fails — and pnpm's symlink layout does not sidestep
 * it either: a tarball install lands at
 * `node_modules/.pnpm/<name>@<version>/node_modules/<name>`, whose realpath is
 * still under `node_modules`.
 *
 * An earlier version of this package worked around the restriction with a
 * `registerHooks` loader that stripped the types itself. This compiles instead,
 * which removes the restriction from the path rather than circumventing it:
 * there is no `.ts` left for Node to have an opinion about. It also deletes a
 * whole class of question — what the loader does about a `.ts` file it does not
 * own, what a stack trace points at, what happens when `registerHooks` changes.
 *
 * ## Why `tsc` and not `oxc`
 *
 * Both can perform the transform, and `oxc` is faster. `typescript` wins on two
 * properties this particular job needs and speed does not outrank, in a step
 * that runs once per release:
 *
 * 1. **`rewriteRelativeImportExtensions` does the specifier rewrite as part of
 *    the compile.** Every module here imports its neighbours as `'./routes.ts'`,
 *    which is correct for Node's type stripping and wrong for the emitted `.js`.
 *    `tsc` rewrites those to `./routes.js` on the way out — including inside
 *    `await import()` — so the rewrite is a compiler guarantee rather than a
 *    regex this file would have to maintain.
 * 2. **It is the compiler this repository already runs.** `typescript` is an
 *    existing devDependency and `astro check` is already a `verify` gate, so the
 *    types the tarball is compiled from are the types already checked. Adding a
 *    second toolchain to save a few seconds of a once-per-release step would buy
 *    a dependency and a way for the two to disagree.
 *
 * ## What `tsc` cannot do, and this file does
 *
 * `tsc` only rewrites specifiers in files it compiles, and three kinds of file
 * reference `.ts` paths without being rewritten by it:
 *
 * - **The 19 `.astro` files.** Astro components are not TypeScript modules and
 *   `tsc` does not emit them, but their frontmatter and `<script>` bodies import
 *   `'../lib/routes.ts'` and friends. Measured, not assumed: with only a `.js`
 *   sibling present, Vite does *not* fall back — a probe page importing a
 *   `.ts` specifier whose file was `.js` failed the build outright. So these
 *   must be rewritten, and unrewritten they would break every packaged build.
 * - **`astro.config.mjs`'s diagram stub**, which names
 *   `src/scripts/diagram-disabled.ts` inside `new URL(...)`. A path built out of
 *   a string is invisible to any compiler, which is the same reason
 *   `tests/packaging.test.ts` has to be told about that module by hand.
 * - **A compiled `.js` that names a module in a string**, such as
 *   `snapshot-client.js`'s `new URL('./snapshot-worker.ts', import.meta.url)`.
 *   `rewriteRelativeImportExtensions` rewrites import specifiers only, so the
 *   worker URL would otherwise point at a `.ts` file the tarball does not carry.
 *
 * The rewrite is deliberately narrow: a relative specifier, in quotes, ending
 * `.ts`, whose target exists as a `.ts` file on disk. It is applied to the
 * *staged copy*, never to the working tree.
 *
 * ## What it must not produce
 *
 * No source maps and no declarations. `scripts/scan-residue.ts` already treats a
 * `sourceMappingURL` in built output as fatal residue, and a map in the package
 * is the same defect one layer up: it would carry this repository's absolute
 * paths and its original sources into a stranger's `node_modules`. Declarations
 * are dead weight — nothing consumes this package as a library, which is why
 * `exports` deliberately exposes only `./package.json`.
 *
 * `erasableSyntaxOnly` is set so that compiling cannot quietly admit a construct
 * the in-repo `node --experimental-strip-types` path would reject. Without it
 * `enum`, `namespace`, and parameter properties would compile here and fail
 * there, and the two paths would silently diverge. It is enforced in
 * `tsconfig.json` too, so `astro check` catches it first — and it is why this
 * file does not pass `noCheck`, which suppresses the option entirely.
 */

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnNpm } from './npm-command.ts';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * The directories whose `.ts` sources ship, and are therefore compiled.
 *
 * `tests/` is absent because it is not in `package.json`'s `files`, and
 * `vitest.config.ts` because a consumer never runs this package's tests.
 */
const COMPILED_ROOTS = ['src', 'scripts'] as const;

/** Every file under `directory` matching `predicate`, recursively. */
function filesUnder(directory: string, predicate: (path: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, predicate));
    else if (predicate(path)) found.push(path);
  }
  return found;
}

/**
 * Rewrite every quoted `….ts` path naming one of this package's own files to
 * `.js`, in a file `tsc` does not compile.
 *
 * Two forms occur and both must be caught, which is why the pattern is not
 * anchored on a leading `./`. Most are ordinary relative specifiers —
 * `'../lib/routes.ts'`. One is not: `astro.config.mjs` names the diagram stub as
 * `new URL('src/scripts/diagram-disabled.ts', import.meta.url)`, a package-root
 * path with no leading `./` and not a specifier at all.
 *
 * What keeps the loose pattern from eating prose is the **disk check**, not the
 * shape of the path: a match is rewritten only if it resolves to a real `.ts`
 * file of ours, first relative to the importing file and then from the package
 * root. `src/pages/notes/[slug].astro` discusses `src/scripts/diagram.ts` in a
 * comment three lines above importing it, and a mention that happens to name a
 * real file is rewritten harmlessly — it is a comment either way.
 *
 * Backticks are excluded from the character class because a template literal is
 * not a specifier here.
 *
 * **This cannot see a path it does not recognise as a string.** A `.ts` path
 * built by concatenation, or embedded in a regex literal, is invisible to it —
 * measured, and not hypothetically: `astro.config.mjs` matched the diagram
 * module with `/…diagram\.ts$/`, which survived this rewrite untouched and
 * silently stopped matching once the file shipped as `.js`, bundling Mermaid's
 * whole runtime into a `build-time` site. That regex is now extension-agnostic.
 * The gate in `tests/packaging.test.ts` scans *every* staged file for a
 * surviving `.ts` string, which is what catches the next one.
 */
function rewriteSpecifiers(source: string, file: string): string {
  return source.replaceAll(/(['"])([^'"`\n]*?)\.ts\1/g, (match, quote: string, path: string) => {
    const candidates = [resolve(dirname(file), `${path}.ts`), join(ROOT, `${path}.ts`)];
    return candidates.some((candidate) => existsSync(candidate)) ? `${quote}${path}.js${quote}` : match;
  });
}

/**
 * Compile every shipped `.ts` file, emitting `.js` into `destination`.
 *
 * The *originals* are compiled, in place in this repository, with `outDir`
 * pointing at the staging directory. That is not a detail: `tsc` has to resolve
 * `astro`, `satteri`, `temml` and the rest, and the staged copy has no
 * `node_modules` of its own. Compiling the originals means resolution is the
 * ordinary walk up from the real source file and needs no compiler host of its
 * own — an earlier version compiled the staged copy and had to redirect bare
 * specifiers by hand, which resolved the packages but typed them differently
 * from `astro check` and invented four errors that were not there.
 *
 * Options come from `tsconfig.json` rather than being restated, so what is
 * compiled for the tarball is checked under exactly the configuration
 * `astro check` already enforces in `verify`. Only the emit-shaped options are
 * overridden below.
 *
 * Errors are reported and fatal. A tarball built from sources that do not
 * compile is a package that fails at import in somebody else's repository,
 * which is precisely the failure this whole step exists to prevent.
 */
function compile(destination: string, isExcluded: (path: string) => boolean): string[] {
  const configPath = join(ROOT, 'tsconfig.json');
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile.bind(ts.sys));
  if (error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));

  const sources = COMPILED_ROOTS.flatMap((root) =>
    filesUnder(
      join(ROOT, root),
      (path) => path.endsWith('.ts') && !path.endsWith('.d.ts') && !isExcluded(path),
    ),
  );

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT, undefined, configPath);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    // What `tsconfig.json` cannot say, because in this repository nothing is
    // ever emitted: `astro check` sets `noEmit`, and here emitting is the point.
    noEmit: false,
    // `.ts` specifiers become `.js` on the way out. This is the option that
    // makes `tsc` the right tool for the job — the rewrite is a compiler
    // guarantee rather than a regex this file would have to maintain.
    rewriteRelativeImportExtensions: true,
    // The four that keep the tarball to plain JavaScript. A map would carry this
    // repository's absolute paths and original sources into a stranger's
    // `node_modules`, and `scripts/scan-residue.ts` already treats a
    // `sourceMappingURL` in built output as fatal residue.
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    // Emit lands in the staging directory, mirroring the source layout, so the
    // working tree is never written to.
    outDir: destination,
    rootDir: ROOT,
  };

  const program = ts.createProgram(sources, options);
  const emitted = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );

  if (diagnostics.length > 0) {
    throw new Error(
      `the package does not compile:\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => '\n',
      })}`,
    );
  }

  return sources;
}

/**
 * `package.json`'s `files`, split into the roots that ship and the paths
 * excluded from them.
 *
 * Read rather than restated, so an entry added there cannot be forgotten here.
 * The exclusions are load-bearing and not merely tidiness: two are this owner's
 * content (`src/data/content.json`) and several are development-only scripts. Ignoring them would not only ship those files, it
 * would *compile* them — `scripts/compile-package.ts` imports `typescript`, a
 * devDependency, so a tarball carrying it would import a package npm never
 * installed for a consumer.
 */
function manifestFiles(): { roots: string[]; excluded: string[] } {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] };
  return {
    roots: manifest.files.filter((entry) => !entry.startsWith('!')),
    excluded: manifest.files.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1)),
  };
}

/**
 * The exact version each direct dependency resolves to, read from
 * `pnpm-lock.yaml`.
 *
 * **Why the staged manifest is pinned at all.** A caret range in a published
 * package is resolved fresh by whoever installs it, so `npx <name>@<version>`
 * twice on the same version can produce two different dependency trees — and
 * this tool's output is a website. The generator is pinned exactly by the
 * version a user names; without this its dependency tree is not.
 *
 * **Why this is the only lever left, measured rather than assumed.** npm gives a
 * *publisher* two mechanisms and takes back the two obvious ones:
 *
 * - `npm-shrinkwrap.json`, the file invented for exactly this, is **gone**. npm
 *   12's own `package-lock-json.md` states it "is no longer read or written",
 *   and that a shrinkwrap shipped inside a dependency's tarball "is ignored".
 *   Measured against npm 12.0.2: `npm-packlist` force-excludes it (`lib/index.js`
 *   lists `/npm-shrinkwrap.json` among the rules that cannot be un-ignored), and
 *   a real `npm pack` of a probe carrying one produced a tarball without it —
 *   with and without a `files` entry naming it.
 * - `overrides`, which would reach transitives, is documented as considered
 *   "only in the root `package.json` for a project… Overrides in installed
 *   dependencies are not considered". A published package cannot use it.
 * - `bundleDependencies` is what npm's own docs name as the replacement, and it
 *   is refused here on measurement: a production install of this package's tree
 *   is **325 MB across 299 packages**, and that figure is for *one* platform —
 *   pnpm resolved only this host's three native binaries (`@esbuild/win32-x64`,
 *   `@astrojs/compiler-binding-win32-x64-msvc`, and one more), because the rest
 *   are optional dependencies gated on `os`/`cpu`. Bundling vendors whatever the
 *   packing machine happened to install, so the tarball would be both enormous
 *   and wrong for every consumer on another platform.
 *
 * That leaves pinning the dependencies, which is what this does.
 *
 * **What it does not do, stated because the ceiling is real.** Exact direct pins
 * fix 11 entries of a 553-entry lockfile; the production closure is 299
 * packages, and `astro` alone declares 48 caret ranges of its own. A consumer's
 * transitive tree still floats. Pinning the direct dependencies removes the
 * whole class this project controls and cannot remove the class it does not
 * publish — the alternative that would is `bundleDependencies`, priced above.
 *
 * **Derived, never written down.** A hand-maintained list is stale the first
 * time somebody runs `pnpm update`, and the version is read from the lockfile
 * rather than from `node_modules` because the lockfile is the file that travels
 * with the repository: a tree installed from a *stale* lockfile would otherwise
 * pin what a developer happens to have on disk. `tests/pinning.test.ts` fails if
 * a shipped range survives this rewrite.
 */
function lockedVersions(): Map<string, string> {
  const lock = parseYaml(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')) as {
    importers?: Record<
      string,
      {
        dependencies?: Record<string, { version?: string }>;
        optionalDependencies?: Record<string, { version?: string }>;
      }
    >;
  };
  // Both kinds pnpm resolves for this importer, because both are rewritten. An
  // `optionalDependencies` entry lives under its own key in the lockfile, so
  // reading only `dependencies` would make every optional dependency look
  // unresolvable and throw on a manifest that is in fact perfectly in step.
  const importer = lock.importers?.['.'];
  const entries = { ...importer?.dependencies, ...importer?.optionalDependencies };

  return new Map(
    Object.entries(entries).map(([name, entry]) => [
      name,
      // A lockfile version carries its peer resolution in parentheses —
      // `7.1.6(@types/node@26.1.2)(yaml@2.9.0)` — which is pnpm's own notation
      // and not a version npm can install. The version is the part before it.
      (entry.version ?? '').split('(')[0]!,
    ]),
  );
}

/**
 * Stage a complete, compiled copy of this package at `destination`.
 *
 * A staged copy rather than an in-place compile, and that is the whole point:
 * this repository's own development keeps running TypeScript directly. `pnpm run
 * verify`, `build:fixture`, `dev`, and every `node scripts/*.ts` invocation are
 * unchanged by this file existing, because it never writes to the working tree.
 * An in-place `prepack` would delete the `.ts` sources it had just compiled.
 *
 * The result is a directory `npm pack` can be run in directly, which is what
 * `pnpm run pack:tarball` does.
 */
export function compilePackage(destination: string): { compiled: number; rewritten: number } {
  rmSync(destination, { recursive: true, force: true });

  const { roots, excluded } = manifestFiles();
  const isExcluded = (path: string): boolean => {
    const relativePath = relative(ROOT, path).replaceAll('\\', '/');
    return excluded.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
  };

  // Everything except the TypeScript, which arrives compiled a moment later.
  // `.astro`, `.js`, `public/`, `package.json` and the rest are copied as they
  // are; a `.ts` file is deliberately never staged, so there is no window in
  // which the staging directory holds sources that must be remembered and
  // deleted again.
  //
  // `README.md` is staged explicitly because npm includes it implicitly — even
  // when `files` omits it — and this function stages only the `files` roots.
  // Measured before it was added: the bare tarball carried `README.md` and the
  // compiled one did not, 65 files against 64. That was a difference between two
  // tarballs; once `prepack` refuses the bare pack, the compiled one is the only
  // tarball, and the omission would be the shipped state.
  //
  // `LICENSE` for the same reason, and with a stronger one behind it: the MIT
  // terms require the notice to travel with every copy, and a tarball is one.
  for (const entry of [...roots, 'package.json', 'README.md', 'LICENSE']) {
    const from = join(ROOT, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(destination, entry), {
      recursive: true,
      filter: (source) => !source.endsWith('.ts') && !isExcluded(source),
    });
  }

  const sources = compile(destination, isExcluded);

  let rewritten = 0;
  // One pass over every staged file that can carry a specifier and was not
  // compiled — the `.astro` components, `bin/anc.mjs`, and
  // `astro.config.mjs`. All three reference `.ts` paths that no longer exist in
  // the tarball: the CLI loads each build step with `await
  // import('../scripts/x.ts')`, and the config both imports
  // `./src/lib/diagram-mode.ts` and names the diagram stub inside a
  // `new URL(...)`. Walking the staged tree rather than naming the files means
  // a component or script added later is covered with nothing to remember.
  const carriers = filesUnder(
    destination,
    (path) => path.endsWith('.astro') || path.endsWith('.mjs') || path.endsWith('.js'),
  );

  for (const file of carriers) {
    const before = readFileSync(file, 'utf8');
    // Resolved against the *original* tree, because the "is this one of ours"
    // check has to see the `.ts` files, which the staged copy no longer has.
    // A compiled `.js` is checked against its `.ts` origin, because that is where
    // a string-built worker URL (`new URL('./snapshot-worker.ts', import.meta.url)`)
    // has to resolve; `tsc` rewrites import specifiers but not string literals.
    const staged = relative(destination, file);
    const origin = staged.endsWith('.js')
      ? join(ROOT, `${staged.slice(0, -'.js'.length)}.ts`)
      : join(ROOT, staged);
    const after = rewriteSpecifiers(before, origin);
    if (after === before) continue;
    writeFileSync(file, after, 'utf8');
    rewritten += 1;
  }

  // The staged manifest keeps only what a consumer can actually run. Every
  // `scripts` entry here is a *development* command — `node
  // scripts/validate-content.ts`, `astro dev`, `vitest run` — naming `.ts` files
  // the tarball deliberately no longer carries and tools it does not depend on.
  // Left in place they are six dangling references in the one file every
  // consumer reads, and `npm run build` in an installed package would fail on a
  // missing file rather than on a missing feature. The binary does not use them:
  // it imports each step directly (`bin/anc.mjs`), which is why
  // `tests/packaging.test.ts` compares the two chains by module rather than by
  // command text.
  const manifestPath = join(destination, 'package.json');
  const staged = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  delete staged['scripts'];
  delete staged['devDependencies'];

  // And every dependency range becomes the exact version the lockfile resolved,
  // so that installing this tarball twice cannot produce two different trees.
  // See `lockedVersions` for why this is the mechanism rather than a shrinkwrap.
  //
  // **Both installed kinds, not just `dependencies`.** npm installs
  // `optionalDependencies` by default — the "optional" is about tolerating a
  // failed install, not about being skipped — so a range left there is the same
  // unpinned tree this rewrite exists to remove, reported as closed. Measured: a
  // caret range added under that key shipped verbatim to a consumer while the
  // gates stayed green. `peerDependencies` is deliberately absent: a peer range
  // is a statement about what a *host* must provide, and pinning it to one
  // version would refuse hosts this package works with.
  //
  // A dependency the lockfile does not carry is fatal rather than skipped: it
  // means the manifest and the lockfile have drifted, and the quiet outcome
  // would be a tarball pinning some of its tree and floating the rest — which
  // reads as pinned.
  const locked = lockedVersions();
  for (const kind of ['dependencies', 'optionalDependencies']) {
    const declared = staged[kind] as Record<string, string> | undefined;
    if (declared === undefined) continue;
    staged[kind] = Object.fromEntries(
      Object.keys(declared).map((name) => {
        const version = locked.get(name);
        if (version === undefined || version === '') {
          throw new Error(
            `pnpm-lock.yaml resolves no version for "${name}" (${kind}), so the packaged manifest ` +
              'cannot pin it — run `pnpm install` to bring the lockfile back in step with package.json',
          );
        }
        return [name, version];
      }),
    );
  }

  writeFileSync(manifestPath, `${JSON.stringify(staged, null, 2)}\n`, 'utf8');

  return { compiled: sources.length, rewritten };
}

/**
 * Stage the package and pack it, printing the tarball's path.
 *
 * `npm pack` rather than `pnpm pack`: the staging directory is no longer part of
 * this workspace, and npm is what a consumer installs the result with. The
 * carve-out from `AGENTS.md`'s pnpm-only rule is recorded there, in the
 * contract, rather than argued here.
 *
 * The inner `npm pack` does **not** trip `package.json`'s `prepack` refusal,
 * and that is structural rather than lucky: it runs inside `.package/`, whose
 * staged manifest has had its `scripts` key deleted above. The refusal exists to
 * stop a bare `npm pack` at the repository root, which would ship `.ts` files
 * Node refuses to strip under `node_modules` and scripts naming sources absent
 * from that uncompiled package.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const staging = join(ROOT, '.package');
  const { compiled, rewritten } = compilePackage(staging);
  console.log(`compiled ${compiled} TypeScript files, rewrote specifiers in ${rewritten}`);

  const packed = spawnNpm(['pack', '--pack-destination', ROOT], staging);
  if (packed.status !== 0) {
    console.error(packed.stderr || packed.stdout);
    process.exit(1);
  }
  console.log(`tarball: ${join(ROOT, packed.stdout.trim().split('\n').at(-1) ?? '')}`);
}
