/**
 * The gate over the package boundary.
 *
 * TK-24's premise is that `npx @thoughtscape/publish build` runs in a stranger's
 * repository. npm installs a package's `dependencies` and **none of its
 * `devDependencies`**, so a module the build reaches at runtime that imports a
 * devDependency is not a lint violation — it is a build that dies at import,
 * before reading a single note, in somebody else's CI.
 *
 * That was the plan's fatal finding S1 and it was real: `temml`, `mermaid`,
 * `happy-dom`, and `pagefind` were all devDependencies while `src/lib/math.ts`
 * imported `temml` at module scope and `src/lib/markdown.ts` imported that
 * unconditionally.
 *
 * These gates are structural rather than a list. They read `package.json` and
 * the sources as data, so a dependency added tomorrow is covered without anyone
 * remembering this file exists.
 *
 * **The closure is traced, not globbed.** An earlier shape of this gate scanned
 * every `.ts` file under `src/` and `scripts/`, which is both too wide and too
 * narrow: too wide because `src/scripts/diagram.ts` legitimately imports
 * `mermaid` for the *client* bundle and is not on the build's own import path,
 * and too narrow because it would miss a devDependency reached through a chain
 * of relative imports the glob happened to include for another reason. Following
 * the imports from the real entry points answers the question actually being
 * asked: what does the build load?
 */

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import ts from 'typescript';
import { compilePackage } from '../scripts/compile-package.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  private: boolean;
  scripts: Record<string, string>;
  exports: Record<string, unknown>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/**
 * Where the packaged build starts.
 *
 * The binary, and the Astro entry points it reaches through `astro build` — the
 * page templates, which are not imported by any `.ts` file and so are invisible
 * to a pure import trace from the binary alone. Astro discovers them by
 * directory convention; this gate has to be told, because a page is exactly
 * where an accidental devDependency import would be least visible.
 *
 * `src/scripts/diagram-disabled.ts` is the third case: it is reached by neither
 * convention nor import, but by `astro.config.mjs`'s `resolveId` plugin, which
 * names it as a `fileURLToPath(new URL(…))` string and substitutes it for
 * `diagram.ts` whenever `DIAGRAM_MODE` is `build-time`. Since that is the mode
 * that ships, it is the module actually in the bundle — and a parser cannot see
 * a path built out of a string. Verified by planting an unresolvable import in
 * it: `astro build` died and this gate stayed green until the file was listed
 * here.
 */
const ENTRY_POINTS: readonly string[] = [
  'bin/thoughtscape-publish.mjs',
  'astro.config.mjs',
  'src/scripts/diagram-disabled.ts',
];

/**
 * Every module specifier in one source file, parsed rather than matched.
 *
 * TypeScript's own parser, which is already a devDependency and is the compiler
 * `astro check` runs. A regex was written first and was wrong in both
 * directions — the failure mode that matters for a gate, because both directions
 * are silent:
 *
 * - It **missed** `import 'happy-dom';`. A side-effect import has no `from`, so
 *   a `from`-anchored pattern returns nothing for it. Measured: the exact form
 *   yielded `[]`. That is a false pass on the highest-risk shape in this
 *   repository — `mermaid-environment.ts` is precisely where a DOM polyfill
 *   would be imported for its effect.
 * - It **invented** imports, reading `from 'x'` out of a template literal, and
 *   silently dropped any import list longer than the 200 characters its lazy
 *   quantifier allowed.
 *
 * The parser has no such edges: a string, a template literal, a regex literal,
 * and a comment are all distinguished from code by construction, and every form
 * the language admits — static, dynamic, re-export, side-effect — arrives as the
 * same node kind. It also reports `import type`, which is erased before runtime
 * and therefore must *not* count as a dependency.
 */
function specifiersIn(source: string, filename: string): string[] {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      // `import type … from 'x'` and `export type … from 'x'` are erased by the
      // type stripper, so they are not runtime dependencies. `src/lib/*` uses
      // this form heavily for `ContentEntry`.
      const isTypeOnly = ts.isImportDeclaration(node)
        ? (node.importClause?.isTypeOnly ?? false)
        : node.isTypeOnly;
      if (specifier !== undefined && ts.isStringLiteral(specifier) && !isTypeOnly) {
        found.push(specifier.text);
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    // `require('prismjs/components/index.js')` in `markdown.ts`, reached through
    // `createRequire`. Not an ESM form, so the parser sees an ordinary call.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return found;
}

/**
 * The code regions of an `.astro` file: its frontmatter, **and each `<script>`
 * body**, returned separately.
 *
 * Both regions are load-bearing and the second was missing. An Astro `<script>`
 * is bundled and shipped, and `astro.config.mjs` documents at length that Astro
 * bundles such a script *eagerly* — so an import inside one is as much a
 * build-time dependency as an import in the frontmatter, and it is where a
 * devDependency import would be least visible. `src/layouts/Layout.astro:234-238`
 * imports three modules that way and `src/pages/notes/[slug].astro` imports
 * `src/scripts/diagram.ts`, which imports `mermaid`.
 *
 * **Separately, not concatenated.** Joining them was tried and silently lost
 * imports: a `<script>` earlier in the file contains a prose comment with an
 * unpaired backtick, and once the regions share a parse that backtick opens a
 * template literal which swallows every later region. Measured — the joined form
 * found one of the four specifiers in `Layout.astro`, the separated form finds
 * all four. Each region is its own scope in the real build too, so parsing them
 * apart is also the more faithful model.
 */
function astroRegions(source: string): string[] {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
  return [frontmatter, ...[...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]!)];
}

/** Resolve a relative specifier to a file on disk, trying Astro's extensions. */
function resolveRelative(specifier: string, importer: string): string | undefined {
  const base = resolve(dirname(importer), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** The package a bare specifier belongs to: `foo`, or `@scope/foo`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/**
 * Every file the build loads, and every bare package it imports, from the entry
 * points outward.
 *
 * Astro's page, layout, and component directories are seeded as entry points of
 * their own, since Astro reaches them by convention rather than by import.
 */
function traceImports(): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>();

  const pending = ENTRY_POINTS.map((entry) => join(ROOT, entry));
  for (const directory of ['src/pages', 'src/layouts', 'src/components']) {
    pending.push(
      ...sourceFilesUnder(join(ROOT, directory), (path) => path.endsWith('.astro') || path.endsWith('.ts')),
    );
  }

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);

    const source = readFileSync(file, 'utf8');
    const regions = file.endsWith('.astro') ? astroRegions(source) : [source];
    for (const specifier of regions.flatMap((region) => specifiersIn(region, file))) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        // A `?url` or `?raw` suffix names an asset, not a module.
        const resolved = resolveRelative(specifier.split('?')[0]!, file);
        if (resolved !== undefined) pending.push(resolved);
        continue;
      }
      const name = packageOf(specifier);
      if (!packages.has(name)) packages.set(name, relative(ROOT, file).replaceAll('\\', '/'));
    }
  }

  return { files, packages };
}

function sourceFilesUnder(directory: string, matches: (path: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFilesUnder(path, matches));
    else if (matches(path)) found.push(path);
  }
  return found;
}

test('no module the build reaches imports a devDependency', () => {
  const { packages } = traceImports();
  const dev = new Set(Object.keys(MANIFEST.devDependencies));

  const violations = [...packages]
    .filter(([name]) => dev.has(name))
    .map(([name, importer]) => `${importer} imports "${name}", which is a devDependency`);

  assert.deepEqual(
    violations,
    [],
    'npm installs no devDependencies of an installed package, so each of these fails the ' +
      `packaged build at import:\n  ${violations.join('\n  ')}`,
  );
});

test('every package the build imports is declared as a dependency', () => {
  const { packages } = traceImports();
  const declared = new Set(Object.keys(MANIFEST.dependencies));

  // The other half of the same property. A package that is in neither list
  // resolves today only because something else in the tree happens to hoist it,
  // which `AGENTS.md` names as the boundary pnpm's symlinked `node_modules`
  // exists to enforce — and which npm's flat install in a user's repository
  // would silently permit until it did not.
  const undeclared = [...packages]
    .filter(([name]) => !declared.has(name) && !Object.hasOwn(MANIFEST.devDependencies, name))
    .map(([name, importer]) => `${importer} imports "${name}", which package.json does not declare`);

  assert.deepEqual(undeclared, [], undeclared.join('\n'));
});

test('the trace reaches the modules whose devDependency imports broke the adoption path', () => {
  // Non-vacuity. Every assertion above passes trivially if the trace reaches
  // nothing, and the three modules named in the plan's S1 finding are exactly
  // the ones it must not miss: `math.ts` (temml), `mermaid-environment.ts`
  // (happy-dom), and `markdown.ts`, which imports both.
  const { files } = traceImports();
  const reached = new Set([...files].map((file) => relative(ROOT, file).replaceAll('\\', '/')));

  for (const module of [
    'src/lib/math.ts',
    'src/lib/markdown.ts',
    'src/lib/mermaid-environment.ts',
    'src/lib/mermaid-render.ts',
    'scripts/scan-residue.ts',
    'scripts/validate-content.ts',
    // Reached only through an Astro `<script>` tag, which is the region an
    // earlier version of this trace never read. `diagram.ts` imports `mermaid`,
    // so had that package stayed a devDependency this file would have been the
    // one to prove it and did not.
    'src/scripts/diagram.ts',
    'src/scripts/search-dialog.ts',
    'src/scripts/link-preview.ts',
    'src/scripts/preferences.ts',
  ]) {
    assert.ok(reached.has(module), `the import trace never reached ${module}, so it gates nothing`);
  }
});

test('the packaged build runs the same chain as `pnpm run build`', () => {
  // `AGENTS.md` makes this a documented property rather than a preference: CI
  // "runs `pnpm run verify` rather than restating its steps, so the two cannot
  // drift", and `tests/verify.test.ts` fails if a gate is ever spelled out in
  // YAML instead. `bin/thoughtscape-publish.mjs` is a third place the chain
  // could be written down, and it is the one that runs in other people's
  // repositories — so a step present in `build` and absent there is a gate this
  // project enforces on itself and not on the users it ships to.
  //
  // Matched on the module each link runs rather than on the command text, since
  // the two invoke the same code by different routes: `build` shells out to
  // `node scripts/x.ts` while the binary imports `../scripts/x.ts`. What must
  // agree is the set of steps, which is what this compares.
  const build = MANIFEST.scripts['build'];
  assert.ok(build, 'package.json declares no `build` script');

  const scriptsIn = (text: string): Set<string> =>
    new Set([...text.matchAll(/scripts\/([\w-]+)\.ts/g)].map((match) => match[1]!));

  // `build` reaches its steps through the named scripts it chains, so resolve
  // one level: `pnpm run emit:redirects` is `node scripts/emit-redirects.ts`.
  const expanded = build
    .split('&&')
    .map((link) => {
      const named = /^\s*pnpm\s+run\s+([\w:-]+)\s*$/.exec(link)?.[1];
      return named === undefined ? link : (MANIFEST.scripts[named] ?? link);
    })
    .join(' && ');

  const cli = readFileSync(join(ROOT, MANIFEST.bin['thoughtscape-publish']!), 'utf8');
  const missing = [...scriptsIn(expanded)].filter((step) => !scriptsIn(cli).has(step));

  assert.deepEqual(
    missing,
    [],
    `\`pnpm run build\` runs ${missing.join(', ')} and the packaged binary does not, so a gate ` +
      'this repository enforces on itself would not run in a user\'s repository',
  );

  // Astro is the one step that is not a script in `scripts/`, and it is the step
  // that produces everything the others measure.
  assert.match(cli, /import\('astro'\)/, 'the packaged binary never builds the site');
});

test('the manifest declares what npm needs to install and run this package', () => {
  assert.equal(MANIFEST.name, '@thoughtscape/publish', 'the package name is not the one the plan publishes');
  assert.notEqual(MANIFEST.version, '0.0.1', 'the version is still the placeholder');
  assert.match(MANIFEST.version, /^\d+\.\d+\.\d+/, 'the version is not a release version');

  // The rename has one known consequence outside this repository, recorded
  // rather than silently accepted: `sync:content` runs the private vault's
  // `export.py`, which refuses a target whose `package.json` name is not the
  // literal `thoughtscape-publish` (its `publisher target identity mismatch`
  // check). So `pnpm run sync:content` fails until the exporter's constant is
  // updated — a change in the vault, which this repository may not make and
  // `AGENTS.md` puts behind its own review. It is not in `verify`, has never run
  // anywhere but a trusted host, and plan decision D2 retires it: the owner's
  // site becomes a consumer of this tool rather than its content. Named here so
  // the next person to run it learns why from a test rather than from a stack
  // trace in another repository.
  assert.equal(
    MANIFEST.scripts['sync:content']?.includes('export.py'),
    true,
    'sync:content no longer runs the vault exporter — if it was removed, delete this note with it',
  );

  const binary = MANIFEST.bin['thoughtscape-publish'];
  assert.ok(binary, 'package.json declares no `thoughtscape-publish` binary, so `npx` has nothing to run');
  assert.ok(existsSync(join(ROOT, binary)), `bin points at ${binary}, which does not exist`);
  assert.match(
    readFileSync(join(ROOT, binary), 'utf8'),
    /^#!\/usr\/bin\/env node\n/,
    `${binary} has no shebang, so npm's bin shim cannot execute it on POSIX`,
  );
});

test('the tarball carries what the build reads and none of this owner\'s content', () => {
  // `files` is an allowlist, so the failure mode is a build that resolves here
  // and 404s at a stranger's. Every entry point and every traced file must be
  // under one of its roots.
  const roots = MANIFEST.files.filter((entry) => !entry.startsWith('!'));
  const { files } = traceImports();
  for (const file of files) {
    const path = relative(ROOT, file).replaceAll('\\', '/');
    assert.ok(
      roots.some((root) => path === root || path.startsWith(`${root}/`)),
      `${path} is loaded by the build but no entry in package.json "files" carries it`,
    );
  }

  // And the inverse, which is a privacy property rather than a packaging one.
  // `src/data/content.json` is this owner's corpus and `public/content-index.json`
  // its public projection — Astro copies `public/` verbatim, so an index left in
  // the tarball would be served from every site built with this tool.
  for (const excluded of ['src/data/content.json', 'public/content-index.json']) {
    assert.ok(
      MANIFEST.files.includes(`!${excluded}`),
      `package.json "files" does not exclude ${excluded}, so this owner's content ships to every consumer`,
    );
  }

  // Nothing here may be published by accident. The plan's §5 adoption path is
  // `npx @thoughtscape/publish@<pinned>`, but no ticket has authorized a
  // publication, and `AGENTS.md` makes publication "an external side effect
  // requiring explicit approval". `private` is the flag that makes `npm publish`
  // refuse; `npm pack` still works, which is what the acceptance test needs.
  assert.equal(
    MANIFEST.private,
    true,
    'package.json is not private, so `npm publish` would succeed — and publication is a ' +
      'separately approved action (AGENTS.md, Boundaries)',
  );
});

test('Astro still redirects prerender staging for an outDir outside cwd', async () => {
  // The mechanism `bin/thoughtscape-publish.mjs` builds its root decision on,
  // reproduced as a check so an Astro upgrade that changes it is a red test
  // rather than a mysterious EXDEV in a user's build.
  //
  // `getOutDirWithinCwd` (astro 7.1.6, `dist/core/build/common.js:76-82`) is
  // four lines: if `outDir` is not under `process.cwd()`, prerender output is
  // staged at `<cwd>/.astro/` instead. That directory reaches the build through
  // `getServerOutputDirectory` (`dist/prerender/utils.js:10`) →
  // `getPrerenderOutputDirectory` → `static-build.js:114`, and `ssrMoveAssets`
  // (`static-build.js:249-285`) then `fs.promises.rename`s assets from there to
  // the real `outDir` — a rename that cannot cross a device.
  //
  // What this gate asserts is the *redirect*, which is the reason the rename
  // exists at all. It deliberately does not assert that an out-of-cwd `outDir`
  // fails: measured, a same-drive one builds a complete site, because the rename
  // stays on one device. EXDEV is the operative blocker and it is
  // device-specific — see the CLI's header, which states it that way.
  //
  // Reached through `import.meta.resolve('astro/package.json')` because the deep
  // path is not in Astro's `exports` map: importing
  // `astro/dist/core/build/common.js` directly is `ERR_PACKAGE_PATH_NOT_EXPORTED`.
  // Resolving the one entry Astro *does* export and walking relative from it
  // gets the real file without asking the exports map for permission.
  const astroPackageJson = import.meta.resolve('astro/package.json');
  const { getOutDirWithinCwd } = (await import(
    /* @vite-ignore */ new URL('./dist/core/build/common.js', astroPackageJson).href
  )) as { getOutDirWithinCwd: (outDir: URL) => URL };

  const asOutDir = (path: string): URL => pathToFileURL(`${path}${sep}`);
  const resolved = (path: string): string => fileURLToPath(getOutDirWithinCwd(asOutDir(path)));

  // Honoured: the shape the CLI actually uses — a staging directory inside the
  // package, which is cwd for the duration of the build.
  const inside = join(process.cwd(), '.thoughtscape-build-probe', 'dist');
  assert.equal(
    resolved(inside),
    `${inside}${sep}`,
    'an outDir under cwd is no longer honoured, so the staging directory the CLI builds into is ' +
      'not where Astro writes — re-read `getOutDirWithinCwd` before trusting the CLI comment',
  );

  // Redirected: anything outside cwd, which is where a user's directory always
  // is. Both cases are ordinary absolute paths on the *same* device as cwd,
  // which is the point — the redirect is a containment test and knows nothing
  // about devices. What makes it matter is the rename that follows it: staging
  // lands under cwd, the assets are renamed to `outDir`, and that rename is what
  // fails when the two are on different drives.
  const fallback = join(process.cwd(), '.astro') + sep;
  for (const [what, path] of [
    ['a sibling of cwd', join(process.cwd(), '..', 'probe-sibling', 'dist')],
    ['a path at the filesystem root', join(resolve(sep), 'probe-elsewhere', 'dist')],
  ] as const) {
    assert.equal(
      resolved(path),
      fallback,
      `Astro no longer redirects an outDir at ${what}. If it now stages prerender output in ` +
        '`outDir` itself, the cross-device rename that forces staging in ' +
        '`bin/thoughtscape-publish.mjs` may be gone — re-measure a cross-drive build before ' +
        'trusting that file\'s root-decision comment, and delete both together if it has lapsed.',
    );
  }
});

test('the tarball ships compiled JavaScript and no TypeScript, source maps, or declarations', () => {
  // The property TK-24a exists for. Node **refuses** to strip types from any
  // file under `node_modules`
  // (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `.ts` file in the
  // tarball is not untidy — it is a build that dies at its first import in
  // somebody else's repository. An earlier version worked around that with a
  // `registerHooks` loader; compiling removes the restriction from the path
  // instead of circumventing it.
  //
  // Staged rather than packed, so this gate needs no network and no `npm pack`:
  // `compilePackage` produces exactly the directory `npm pack` is run in, so
  // what is measured here is what ships. Three absences, each its own failure:
  //
  // - `.ts` — the package does not run at all.
  // - `.map` — this repository's absolute paths and original sources would be
  //   published into a stranger's `node_modules`. `scripts/scan-residue.ts:89`
  //   already treats a `sourceMappingURL` in *built output* as fatal residue;
  //   shipping maps from the package is the same defect one layer up.
  // - `.d.ts` — dead weight. Nothing consumes this package as a library, which
  //   is why `exports` deliberately exposes only `./package.json`.
  const staging = mkdtempSync(join(tmpdir(), 'thoughtscape-pack-'));
  try {
    const { compiled } = compilePackage(staging);
    assert.ok(compiled > 0, 'nothing was compiled, so the absences below hold vacuously');

    const forbidden: Record<string, string[]> = { '.ts': [], '.map': [], '.d.ts': [] };
    for (const file of sourceFilesUnder(staging, () => true)) {
      const path = relative(staging, file).replaceAll('\\', '/');
      // `.d.ts` first: it also ends in `.ts`, and reporting it as both would
      // name one file twice under two different reasons.
      const kind = path.endsWith('.d.ts') ? '.d.ts' : path.endsWith('.ts') ? '.ts' : path.endsWith('.map') ? '.map' : undefined;
      if (kind !== undefined) forbidden[kind]!.push(path);
    }

    for (const [extension, found] of Object.entries(forbidden)) {
      assert.deepEqual(
        found,
        [],
        `the tarball carries ${found.length} ${extension} file(s), which it must not: ${found.slice(0, 5).join(', ')}`,
      );
    }

    // Non-vacuity, and the other half of the property: the compiled output has
    // to actually be there. A staging directory that emitted nothing would
    // satisfy all three absences perfectly.
    const emitted = sourceFilesUnder(staging, (path) => path.endsWith('.js'));
    assert.ok(
      emitted.length >= compiled,
      `${compiled} TypeScript files were compiled but only ${emitted.length} .js files reached the ` +
        'package, so something was compiled and then lost',
    );

    // And **no file in the tarball** may still name a `.ts` file. `tsc` rewrites
    // the specifiers in what it compiles; the `.astro` components and the two
    // `.mjs` files are rewritten by `compile-package.ts` because no compiler
    // sees them. Measured: with only a `.js` sibling present, Vite does *not*
    // fall back from a `.ts` specifier — the build fails outright — so an
    // unrewritten specifier is a broken packaged build rather than a cosmetic
    // inconsistency.
    //
    // Every file, not a list of extensions. An earlier version of this gate
    // filtered to `.astro|.mjs|.js` and so could not see `package.json`, whose
    // `scripts` named six `.ts` files the tarball does not carry — the exact
    // defect this gate exists to catch, sitting in the one file every consumer
    // reads, invisible because of the filter. A gate that measures a subset of
    // its stated property is worse than none, because it reports success.
    //
    // Two forms are excluded, because naming a `.ts` path is their job rather
    // than a stale reference to one: an entry in `package.json`'s `files` that
    // *excludes* a source (`"!scripts/build-fixture.ts"`), and a `.d.ts`
    // declaration reference in `tsconfig.json`, which describes types and
    // resolves nothing at run time.
    const stale: string[] = [];
    for (const file of sourceFilesUnder(staging, () => true)) {
      for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/['"]([^'"`\n]*?\.ts)['"]/g)) {
        if (specifier.startsWith('!') || specifier.endsWith('.d.ts')) continue;
        stale.push(`${relative(staging, file).replaceAll('\\', '/')} → ${specifier}`);
      }
    }
    assert.deepEqual(stale, [], `these specifiers still name a .ts file the tarball does not carry:\n  ${stale.join('\n  ')}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  // A full type-checked compile of 29 files: ~13 s alone, and this suite runs a
  // worker per file, so it competes with `math-and-diagrams.test.ts` laying out
  // real Mermaid diagrams. Measured, both then exceeded `vitest.config.ts`'s
  // 30 s default and failed as timeouts rather than on any assertion. The bound
  // is generous rather than tight because what it must catch is a hang, not a
  // slow machine.
}, 120_000);

test('the site identity a packaged build ships is this owner\'s, and TK-31 is what fixes it', () => {
  // A site built from a stranger's Markdown currently carries this repository's
  // identity: the `.invalid` placeholder origin, the name `thoughtscape`, this
  // owner's social card, and an `/about/` page describing an approval list that
  // a TK-26 build does not have.
  //
  // This gate does not assert that is *right* — it is not, and TK-31 owns it. It
  // asserts the two properties that make shipping it safe in the meantime, and
  // it fails the day either stops holding:
  //
  // 1. The origin is unresolvable. RFC 2606 reserves `.invalid`, so a canonical
  //    link, a feed id, or a sitemap entry built by a stranger points at nothing
  //    rather than at somebody else's server. A real domain here would turn a
  //    placeholder into a misattribution the moment anyone published.
  // 2. It is written in exactly one place, so TK-31 changes one line rather than
  //    hunting for copies. `tests/metadata.test.ts` already enforces this for the
  //    site's own pages; this restates it as a packaging property.
  const config = readFileSync(join(ROOT, 'astro.config.mjs'), 'utf8');
  const site = /site:\s*'([^']+)'/.exec(config)?.[1];
  assert.ok(site, 'astro.config.mjs declares no `site`, so canonical URLs have no origin');
  assert.match(
    site,
    /\.invalid(?:\/|$)/,
    `astro.config.mjs publishes ${site} to every consumer of this package. Until TK-31 extracts ` +
      'site identity into the user\'s own config, the origin must stay an RFC 2606 `.invalid` ' +
      'placeholder — a real domain would put one owner\'s canonical links on every stranger\'s site',
  );
});
