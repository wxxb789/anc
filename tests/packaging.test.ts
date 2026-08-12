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

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import ts from 'typescript';

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
  'bin/typescript-hook.mjs',
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
    pending.push(...sourceFilesUnder(join(ROOT, directory)));
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

function sourceFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFilesUnder(path));
    else if (path.endsWith('.astro') || path.endsWith('.ts')) found.push(path);
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
