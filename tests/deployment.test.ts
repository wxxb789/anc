/**
 * The two files that configure the host rather than the site: `public/_headers`
 * and `.nvmrc`. Neither is exercised by a build, and until TK-12 neither was
 * covered by a test — `grep -rn "_headers" tests/ scripts/` returned nothing.
 *
 * `_headers` is six lines, and it is the only place the site's security posture
 * is written down. It is also the file that silently broke search:
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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

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

/** Directive name to value, from the single policy the site serves. */
function policy(): Map<string, string> {
  const csp = RULES[0]?.headers.get('Content-Security-Policy');
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

test('exactly one rule serves the whole site', () => {
  // Cloudflare joins duplicate header names with a comma across every matching
  // rule instead of choosing the most specific, so a second overlapping block
  // is a defect unless it explicitly removes the inherited header with
  // `! Header-Name`. One rule means the question cannot arise.
  assert.equal(RULES.length, 1, `expected one rule, got: ${RULES.map((rule) => rule.pattern).join(', ')}`);
  assert.equal(RULES[0]!.pattern, '/*');
});

test('every security header is served', () => {
  const headers = RULES[0]!.headers;
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
    ['style-src', "'self'"],
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

test('no directive relaxes to unsafe-eval or unsafe-inline', () => {
  for (const [directive, value] of POLICY) {
    for (const forbidden of ["'unsafe-eval'", "'unsafe-inline'", "'unsafe-hashes'", '*']) {
      assert.ok(
        !value.split(/\s+/).includes(forbidden),
        `${directive} contains ${forbidden}, which the CSP baseline forbids`,
      );
    }
  }
});

test('the WebAssembly relaxation is still load-bearing', () => {
  // The relaxation exists for exactly one reason: Pagefind's search runtime is
  // WebAssembly. If a future Pagefind stops needing it, this fails and the
  // directive comes back out rather than outliving its justification.
  let pagefind: string;
  try {
    pagefind = readFileSync(new URL('../dist/pagefind/pagefind.js', import.meta.url), 'utf8');
  } catch {
    return assert.fail('dist/pagefind/pagefind.js is missing — run `npm run build` before `npm test`');
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
    return assert.fail('dist/_headers is missing — run `npm run build` before `npm test`');
  }
  assert.equal(built, TEXT);
});

/**
 * `.nvmrc` is what a build host and `nvm use` read; `engines` is what npm
 * warns on. Neither is enforced on Cloudflare Pages, so the only thing keeping
 * them from drifting apart is this.
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
 * written and now permanently incomplete — and `npm run preview` serves it
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
   * Run the gate exactly as `npm run build`'s first link runs it, against a
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
