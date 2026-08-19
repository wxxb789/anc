/**
 * The files that configure the host and the toolchain rather than the site:
 * `public/_headers`, `.nvmrc`, and the shape of the installed tree. None is
 * exercised by a build, and until TK-12 none was covered by a test — `grep -rn
 * "_headers" tests/ scripts/` returned nothing.
 *
 * `_headers` is the only place the site's security posture and its cache policy
 * are written down. It is also the file that silently broke search:
 * `script-src 'self'` with no `'wasm-unsafe-eval'` blocked Pagefind's
 * WebAssembly, so the feature had never executed in production.
 *
 * Two shapes of failure are checked. A *missing* directive is the obvious one.
 * The subtler one is a *duplicate*: Cloudflare Pages inherits every rule whose
 * pattern matches and joins same-named headers with a comma rather than picking
 * the most specific, so a second `/notes/*` block adding one header would emit
 * two comma-joined `Content-Security-Policy` values. Overriding needs an
 * explicit `! Header-Name`.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { REQUIRED_STYLE_SRC } from '../src/lib/diagram-mode.ts';

const SOURCE = new URL('../public/_headers', import.meta.url);
const BUILT = new URL('../dist/_headers', import.meta.url);

const TEXT = readFileSync(SOURCE, 'utf8');

/** One `_headers` rule: the path pattern and the headers it sets. */
interface HeaderRule {
  pattern: string;
  headers: Map<string, string>;
}

/**
 * Parse the Cloudflare Pages `_headers` grammar: an unindented line is a path
 * pattern, an indented `Name: value` line attaches to the pattern above it, and
 * `#` starts a comment.
 */
function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      rules.push({ pattern: line.trim(), headers: new Map() });
      continue;
    }
    const separator = line.indexOf(':');
    assert.ok(separator > 0, `not a "Name: value" header line: ${JSON.stringify(line)}`);
    const rule = rules.at(-1);
    assert.ok(rule, `header line before any path pattern: ${JSON.stringify(line)}`);
    const name = line.slice(0, separator).trim();
    assert.ok(!rule.headers.has(name), `${rule.pattern}: sets ${name} twice`);
    rule.headers.set(name, line.slice(separator + 1).trim());
  }
  return rules;
}

const RULES = parseHeaders(TEXT);

/** The site-wide rule, selected by its pattern rather than by its position. */
function siteRule(): HeaderRule {
  const rule = RULES.find((candidate) => candidate.pattern === '/*');
  assert.ok(rule, `no rule matches the whole site; got: ${RULES.map((r) => r.pattern).join(', ')}`);
  return rule;
}

/** Directive name to value, from the single policy the site serves. */
function policy(): Map<string, string> {
  const csp = siteRule().headers.get('Content-Security-Policy');
  assert.ok(csp, 'no Content-Security-Policy is served');
  const directives = new Map<string, string>();
  for (const part of csp.split(';')) {
    const [name, ...value] = part.trim().split(/\s+/);
    if (name === undefined || name === '') continue;
    assert.ok(!directives.has(name), `${name} is declared twice in one policy`);
    directives.set(name, value.join(' '));
  }
  return directives;
}

const POLICY = policy();

test('no header name is set by more than one rule', () => {
  // Cloudflare joins duplicate header names with a comma across every matching
  // rule instead of choosing the most specific, so two rules setting one header
  // emit both values. Overriding needs an explicit `! Header-Name`.
  //
  // This asserts that hazard directly. Until TK-08 it was approximated by
  // "there is exactly one rule", which was true and sufficient while the file
  // had one; TK-08 added `/_astro/*` for the immutable hashed-asset cache, and
  // that rule shares no header name with the site-wide block. The direct form
  // is the stricter one — it also rejects two *non*-overlapping patterns that
  // set the same header, which the count never inspected.
  const owner = new Map<string, string>();
  for (const rule of RULES) {
    for (const name of rule.headers.keys()) {
      const first = owner.get(name);
      assert.equal(
        first,
        undefined,
        `${name} is set by both "${first}" and "${rule.pattern}"; Cloudflare comma-joins them ` +
          'rather than picking the most specific — remove one or override with `! Header-Name`',
      );
      owner.set(name, rule.pattern);
    }
  }

  // Every rule must be reachable from the site-wide block's perspective: an
  // unanchored pattern is a rule that silently matches nothing.
  for (const rule of RULES) {
    assert.match(rule.pattern, /^\//, `rule pattern "${rule.pattern}" is not an absolute path`);
  }
});

test('the whole site is covered by the security rule', () => {
  assert.ok(siteRule().headers.size > 0, 'the /* rule sets no headers');
});

test('hashed assets are cached immutably, and nothing else is', () => {
  // Requirements section 20: `public, max-age=31536000, immutable` for hashed
  // assets. `/_astro/*` is exactly Astro's content-hashed output, so a changed
  // file is a changed URL and a cached copy can never be stale.
  const immutable = RULES.filter((rule) => rule.headers.get('Cache-Control')?.includes('immutable'));
  assert.deepEqual(
    immutable.map((rule) => rule.pattern),
    ['/_astro/*'],
    'exactly the content-hashed output directory may be cached immutably',
  );
  assert.equal(immutable[0]!.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');

  // `/pagefind/*` must never join it. Only `index/` and `fragment/` are
  // content-hashed there; `pagefind-entry.json` and `wasm.*.pagefind` are
  // stable-named and rewritten every build, so an immutable rule would pin a
  // returning reader to an entry file pointing at index chunks that no longer
  // exist — search breaking silently for the most frequent visitors.
  for (const rule of RULES) {
    assert.ok(
      !rule.pattern.startsWith('/pagefind'),
      `${rule.pattern}: pagefind assets are not all content-hashed and must use the revalidating default`,
    );
  }
});

test('every security header is served', () => {
  const headers = siteRule().headers;
  for (const [name, expected] of [
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
  ] as const) {
    assert.equal(headers.get(name), expected, `${name} is missing or changed`);
  }
});

test('the CSP declares every directive the requirements baseline names', () => {
  // Requirements section 19.3, lines 713-725. `script-src` carries the one
  // documented deviation, asserted separately below.
  for (const [directive, expected] of [
    ['default-src', "'self'"],
    ['style-src', REQUIRED_STYLE_SRC],
    ['img-src', "'self' data: https:"],
    ['font-src', "'self'"],
    ['connect-src', "'self'"],
    ['worker-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['frame-ancestors', "'none'"],
    ['form-action', "'none'"],
  ] as const) {
    assert.equal(POLICY.get(directive), expected, `${directive} is missing or not "${expected}"`);
  }
});

test('script-src permits WebAssembly compilation and nothing more', () => {
  // `'wasm-unsafe-eval'` permits WebAssembly compilation only. It grants no
  // string-to-code evaluation: `eval`, `new Function`, and `setTimeout("…")`
  // stay blocked, which is what separates it from `'unsafe-eval'`.
  assert.equal(POLICY.get('script-src'), "'self' 'wasm-unsafe-eval'");
});

test('no directive relaxes beyond the selected diagram policy', () => {
  for (const [directive, value] of POLICY) {
    for (const forbidden of ["'unsafe-eval'", "'unsafe-hashes'", '*']) {
      assert.ok(
        !value.split(/\s+/).includes(forbidden),
        `${directive} contains ${forbidden}, which the CSP baseline forbids`,
      );
    }
  }

  // Client Mermaid needs inline style elements and attributes while measuring
  // and drawing. The accepted cost is confined to style-src; every other
  // directive must remain unable to execute inline content.
  const owners = [...POLICY]
    .filter(([, value]) => value.split(/\s+/).includes("'unsafe-inline'"))
    .map(([directive]) => directive);
  assert.deepEqual(
    owners,
    REQUIRED_STYLE_SRC.includes("'unsafe-inline'") ? ['style-src'] : [],
    `unsafe-inline does not match the selected style policy ${REQUIRED_STYLE_SRC}`,
  );
});

test('the WebAssembly relaxation is still load-bearing', () => {
  // The relaxation exists for exactly one reason: Pagefind's search runtime is
  // WebAssembly. If a future Pagefind stops needing it, this fails and the
  // directive comes back out rather than outliving its justification.
  let pagefind: string;
  try {
    pagefind = readFileSync(new URL('../dist/pagefind/pagefind.js', import.meta.url), 'utf8');
  } catch {
    return assert.fail('dist/pagefind/pagefind.js is missing — run `pnpm run build` before `pnpm test`');
  }
  assert.match(
    pagefind,
    /WebAssembly\./,
    "Pagefind no longer compiles WebAssembly, so 'wasm-unsafe-eval' should be removed",
  );
});

test('the built site serves the same headers as the source declares', () => {
  // Astro copies `public/` verbatim, so this proves the policy reviewed here is
  // the policy deployed rather than one a build step could rewrite.
  let built: string;
  try {
    built = readFileSync(BUILT, 'utf8');
  } catch {
    return assert.fail('dist/_headers is missing — run `pnpm run build` before `pnpm test`');
  }
  assert.equal(built, TEXT);
});

/**
 * `.nvmrc` is what a build host and `nvm use` read; `engines` is what the
 * package manager warns on. Neither is enforced on Cloudflare Pages, so the
 * only thing keeping them from drifting apart is this.
 */
test('the pinned Node version satisfies the declared engine floor', () => {
  const nvmrc = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
  assert.match(nvmrc, /^\d+\.\d+\.\d+$/, `.nvmrc must pin an exact version, got ${JSON.stringify(nvmrc)}`);

  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines?: { node?: string };
  };
  const declared = manifest.engines?.node ?? '';
  const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(declared);
  assert.ok(floor, `engines.node must be a ">=x.y.z" floor, got ${JSON.stringify(declared)}`);

  // Compare component-wise, most significant first: the first differing part
  // decides. A lexical or per-part comparison gets 22.9.0 vs 22.10.0 wrong.
  const parts = (version: string) => version.split('.').map(Number);
  const [pinned, minimum] = [parts(nvmrc), parts(floor[1]!)];
  const decisive = pinned.findIndex((part, index) => part !== minimum[index]);
  assert.ok(
    decisive === -1 || pinned[decisive]! > minimum[decisive]!,
    `.nvmrc pins ${nvmrc}, below the engines.node floor of ${floor[1]}`,
  );
});

/**
 * The build must fail before it writes a bad `dist/`.
 *
 * `build` is a `&&` chain: validate, `astro build`, emit redirects, index with
 * Pagefind. A throw in any link after the first leaves a `dist/` that is already
 * written and now permanently incomplete — and `pnpm run preview` serves it
 * happily. The worst shape was concrete: `emit:redirects` throwing meant
 * `pagefind --site dist` never ran, so every page shipped a render-blocking
 * `<link>` to a `/pagefind/` stylesheet that did not exist.
 *
 * `scripts/validate-content.ts` now runs the artifact-derived computations that
 * later links would otherwise reach first. What has to be proven is the
 * *ordering*, not the arithmetic — so this runs the real gate as the build runs
 * it, against a poisoned artifact in a scratch directory, and asserts it exits
 * non-zero. Calling `checkDerivedRoutes` directly would only prove that
 * `tagFacets` throws, and would keep passing if the call were deleted from
 * `main()` — which is the one change that would actually break the guarantee.
 */
test('the content gate fails on a poisoned artifact before the build runs', () => {
  const root = new URL('../', import.meta.url);
  const gateScript = fileURLToPath(new URL('scripts/validate-content.ts', root));
  const artifact = JSON.parse(
    readFileSync(new URL('src/data/content.json', root), 'utf8'),
  ) as { entries: { tags?: string[] }[] };

  /**
   * Run the gate exactly as `pnpm run build`'s first link runs it, against a
   * candidate artifact.
   *
   * The candidate is a temporary file, never `src/data/content.json`. Poisoning
   * the real artifact in place would leave exporter-owned generated content
   * corrupted if the run were interrupted — a `finally` does not survive SIGINT
   * — and Vitest, like `node --test` before it, runs test files in parallel
   * workers, so a sibling file reading the artifact inside the poisoned window
   * would fail for no reason it could explain.
   */
  const gate = (candidate?: string) => {
    const result = spawnSync(process.execPath, [gateScript, ...(candidate ? [candidate] : [])], {
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stderr}${result.stdout}` };
  };

  // Clean first: the gate must pass on the real artifact, or the failures below
  // prove nothing.
  assert.equal(gate().status, 0, 'the gate rejects the real artifact');

  const scratch = mkdtempSync(join(tmpdir(), 'tk12-gate-'));
  try {
    // Two live failure modes, both from the facet layer, both of which Astro
    // would otherwise reach inside `getStaticPaths()` — after `dist/` is open.
    for (const [what, tags] of [
      ['a tag with no URL-safe route key', ['🌱']],
      ['two tags colliding onto one route key', ['C++', 'C#']],
    ] as const) {
      artifact.entries[0]!.tags = [...tags];
      const candidate = join(scratch, 'content.json');
      writeFileSync(candidate, JSON.stringify(artifact));
      const { status, output } = gate(candidate);
      assert.notEqual(status, 0, `${what} did not fail the gate, so it would fail mid-build instead`);
      assert.match(output, /tag|route key/i, `the gate failed without naming the cause: ${output}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * The symlinked layout is the reason this repository uses pnpm, so it is worth
 * one gate rather than one sentence in `AGENTS.md`.
 *
 * npm's flat `node_modules` hoists every transitive package to the top level,
 * where a bare `import` finds it — so a module can depend on a package nobody
 * declared and the build keeps working until the dependency that dragged it in
 * changes. TK-03 hit exactly that class of problem and had to promote
 * `satteri`, `github-slugger`, `prismjs`, and `@astrojs/prism` from transitive
 * to direct. pnpm links only declared packages into the root `node_modules`,
 * which turns that from a convention into a resolution error.
 *
 * This reads the root directory rather than attempting a resolution. Node's
 * lookup for a bare specifier does continue past this directory — into ancestor
 * `node_modules`, `NODE_PATH`, and the home-directory fallbacks — but none of
 * those is what hoisting populates. Every route back to a flat tree ends with
 * extra entries here: `public-hoist-pattern` (which `shamefully-hoist` is
 * defined as, with the pattern `*`), `node-linker=hoisted`, and a stray
 * `npm install` in a tree that no longer has a `package-lock.json`. Comparing
 * this directory against the manifest catches all of them.
 *
 * Two earlier attempts are worth not repeating. Probing with `require.resolve`
 * *inside* a test measures Vitest rather than the build: Vitest puts
 * `node_modules/.pnpm/node_modules` on `NODE_PATH` for its workers, so every
 * package in the store resolves. Deriving candidate names from the `.pnpm`
 * store instead needs the peer suffix parsed off
 * (`vite@8.2.0_@types+node@26.1.2_…`), and a name parsed wrong becomes a name
 * that cannot resolve — which is a silent pass, the one failure mode a gate
 * must not have.
 */
test('only declared packages are installed at the root of node_modules', () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  // All three kinds are linked into the root: `node_modules/.modules.yaml`
  // records `included: {dependencies, devDependencies, optionalDependencies}`.
  // Omitting any of them would fail this gate on a package the manifest declares.
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ].sort();

  // Dot-entries are never importable specifiers: `.bin`, `.pnpm`, and
  // `.modules.yaml` belong to pnpm, `.astro` and `.vite` are build caches. A
  // `@scope` directory holds the package one level further down; npm names are
  // never nested deeper than that.
  const modules = fileURLToPath(new URL('node_modules', root));
  const installed = readdirSync(modules)
    .filter((entry) => !entry.startsWith('.'))
    .flatMap((entry) =>
      entry.startsWith('@')
        ? readdirSync(join(modules, entry)).map((scoped) => `${entry}/${scoped}`)
        : [entry],
    )
    .sort();

  assert.deepEqual(
    installed,
    declared,
    'the root of node_modules does not match package.json. Extra entries mean the flat layout ' +
      'is back, so an undeclared import would resolve here and fail on another machine; missing ' +
      'entries mean the install is incomplete — run `pnpm install`',
  );
});
