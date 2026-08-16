/**
 * The gates over the dependency pin, on both paths a stranger can reach this
 * generator by.
 *
 * A user pins the generator exactly — by the git ref in `uses:`, or by the
 * version in `npx <name>@<version>`. Its *dependency tree* was not pinned on
 * either path, so two builds of the same commit could resolve two different
 * trees. For a tool whose output is a published website that is a supply-chain
 * hole, and `action.yml` had disposed of it in a comment.
 *
 * The two paths need different mechanisms and so get different gates:
 *
 * - **The Action path** is a git checkout, and the checkout already carries
 *   `pnpm-lock.yaml` — the whole resolved tree, integrity hashes and all, at the
 *   exact commit. The fix was to stop throwing it away: `--frozen-lockfile`.
 * - **The publish path** is a tarball, and npm forbids every lockfile inside
 *   one. `scripts/compile-package.ts` rewrites the staged `dependencies` to the
 *   versions `pnpm-lock.yaml` resolved.
 *
 * **The gates read the artifact, not the intention.** The pin is a property of
 * what ships, so the packaging gate stages a real package and reads the manifest
 * that lands in it, and the Action gate parses `action.yml` as YAML rather than
 * grepping it — the same instrument, and for the same reason, as
 * `tests/adoption.test.ts`: a gate over a hand-parsed subset of a format
 * measures the subset.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { compilePackage } from '../scripts/compile-package.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ACTION = readFileSync(join(ROOT, 'action.yml'), 'utf8');

/** Every file under a directory, recursively. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  packageManager: string;
  dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * A version specifier that resolves to more than one version.
 *
 * Anything that is not an exact `1.2.3` — a caret, a tilde, an `x`, a
 * comparator, a range, a dist-tag, `*`. Written as "not exact" rather than as a
 * list of range operators on purpose: `docs/gate-reading.md`'s corollary about
 * enumerations is that a list is true the day it is written and silently false
 * afterwards, and npm's specifier grammar has more spellings than anyone
 * remembers.
 *
 * The tails follow semver: a prerelease (`-rc.1`), then optional build metadata
 * (`+build.5`), in that order and both admitted — each still names exactly one
 * version. An earlier form allowed only one tail, so it rejected the valid
 * `1.2.3-rc.1+build.5` while accepting `1.2.3+x`: inconsistent rather than
 * conservative, and a gate that refuses correct input is one somebody deletes.
 */
const isExact = (specifier: string): boolean =>
  /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(specifier);

/** Every `run:` body in the action, parsed rather than matched. */
function runBodies(): string[] {
  const document = parseYaml(ACTION) as { runs?: { steps?: { run?: unknown }[] } };
  return (document.runs?.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === 'string');
}

/**
 * The body of the step that installs the dependency tree, selected by the step's
 * **name**.
 *
 * An earlier version found it with `runBodies().find(/\binstall\b/)`, and a
 * reviewer broke every gate in this file with it: `find` returns the first
 * match, so an `echo "will run pnpm install --frozen-lockfile --prod"` planted
 * in the shallow-clone step becomes the subject, and the real step can then be
 * reverted to the `npm install` this ticket exists to remove. Measured — the
 * original defect fully restored with all five gates green.
 *
 * That is `docs/gate-reading.md` case 1 exactly: the instrument was never
 * confirmed to be looking at the thing. A step's `name` is what identifies it in
 * a workflow, so it is what selects here, and the lookup throws rather than
 * returning `undefined` — a gate whose subject is missing must fail, not pass
 * quietly over nothing.
 */
function installStep(): string {
  const document = parseYaml(ACTION) as { runs?: { steps?: { name?: unknown; run?: unknown }[] } };
  const steps = (document.runs?.steps ?? []).filter(
    (step): step is { name: string; run: string } =>
      typeof step.name === 'string' && typeof step.run === 'string',
  );

  const matched = steps.filter((step) => /install/i.test(step.name));
  assert.equal(
    matched.length,
    1,
    `${matched.length} steps in action.yml name themselves as installing dependencies; these gates ` +
      'need exactly one so that they cannot be pointed at the wrong one',
  );
  return matched[0]!.run;
}

// ---------------------------------------------------------------------------
// The Action path: a git checkout that already carries the lockfile
// ---------------------------------------------------------------------------

test('the action installs against the lockfile rather than resolving ranges afresh', () => {
  // The defect this closes, exactly: `npm install` ignores `pnpm-lock.yaml` and
  // resolves the caret ranges in `package.json` fresh, so a dependency's new
  // minor reaches a user's build with no diff in their repository.
  //
  // `--frozen-lockfile` is the whole property. It does not merely *prefer* the
  // lockfile — it refuses to run when the lockfile and `package.json` have
  // drifted apart, which is what makes the pin a pin rather than a default.
  // Measured on a checkout whose manifest was moved to `github-slugger@^3.0.0`
  // with the lockfile untouched: exit 1, naming the mismatched dependency.
  const install = installStep();

  assert.match(
    install,
    /pnpm install .*--frozen-lockfile(?![\w=-])/,
    'the action does not install with --frozen-lockfile, so the dependency tree it builds with is ' +
      'whatever the ranges in package.json resolve to on the day the user runs it — the generator ' +
      'is pinned by the ref in `uses:` and its dependencies are not',
  );

  // **The flag's value, not merely its spelling.** `--frozen-lockfile=false` is
  // a valid pnpm invocation that matches any pattern looking for the flag's
  // name, and it turns the pin off — a reviewer showed it passing the earlier
  // form of this gate. The negative spellings are refused explicitly rather than
  // left to the pattern above, because a gate that reads `=false` as "present"
  // is worse than no gate: it reports the property as held.
  assert.doesNotMatch(
    install,
    /--frozen-lockfile=(?:false|0|no)\b|--no-frozen-lockfile\b/,
    'the action passes --frozen-lockfile with a negative value, which spells the flag while ' +
      'switching the pin off — pnpm then resolves the ranges afresh and rewrites the lockfile',
  );

  // The installer must not be one that cannot read `pnpm-lock.yaml` at all.
  // `npm install` in this step is the original defect, and it is silent: it
  // succeeds, builds a working site, and pins nothing.
  assert.doesNotMatch(
    install,
    /\bnpm (?:install|ci|i)\b(?![^\n]*-g)/,
    'the action installs the dependency tree with npm, which does not read pnpm-lock.yaml and ' +
      'resolves the ranges in package.json fresh',
  );

  // `--prod`, because a user's build needs none of the gates — and because the
  // gates are where this repository's own toolchain lives.
  assert.match(install, /--prod\b/, 'the action installs devDependencies into a user\'s build');
});

test('the lockfile the action installs against is committed and covers every dependency', () => {
  // The Action path works because `uses:` checks out the generator's *whole
  // repository*, so the lockfile is already on the runner at the pinned commit.
  // That is load-bearing and invisible: if `pnpm-lock.yaml` were ever
  // gitignored, or fell out of step with `package.json`, the install above would
  // fail in a stranger's CI rather than here.
  //
  // **Every kind the lockfile records, not only the ones the action installs.**
  // `--prod` skips installing `devDependencies`, but `--frozen-lockfile` checks
  // them anyway — measured: a drifted devDependency fails the install exactly
  // like a drifted dependency. Since this gate exists to move that failure off a
  // stranger's workflow log and onto this host, checking only the production
  // half would leave the commonest drift — a tooling bump — to be discovered
  // there instead.
  const lock = parseYaml(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')) as {
    importers?: Record<
      string,
      Record<string, Record<string, { specifier?: string; version?: string }> | undefined>
    >;
  };
  const importer = lock.importers?.['.'] ?? {};
  const kinds = ['dependencies', 'optionalDependencies', 'devDependencies'] as const;

  const locked: Record<string, { specifier?: string; version?: string }> = {};
  for (const kind of kinds) Object.assign(locked, importer[kind]);

  const declared: Record<string, string> = {};
  for (const kind of kinds) Object.assign(declared, MANIFEST[kind]);
  assert.ok(Object.keys(declared).length > 0, 'package.json declares no dependencies at all');

  const missing = Object.keys(declared).filter((name) => locked[name]?.version === undefined);
  assert.deepEqual(
    missing,
    [],
    `pnpm-lock.yaml resolves no version for ${missing.join(', ')}, so --frozen-lockfile refuses and ` +
      'the action cannot install at all — run `pnpm install`',
  );

  // The specifiers have to agree too, which is the drift `--frozen-lockfile`
  // refuses on. Asserted here so the failure is a named test on this host rather
  // than an exit 1 in somebody else's workflow log.
  const drifted = Object.entries(declared)
    .filter(([name, range]) => locked[name]!.specifier !== range)
    .map(([name, range]) => `${name} (package.json: ${range}, lockfile: ${locked[name]!.specifier})`);
  assert.deepEqual(
    drifted,
    [],
    `the lockfile and package.json disagree, so a user's build fails at install:\n  ${drifted.join('\n  ')}`,
  );
});

test('the pnpm the action installs is the version packageManager pins', () => {
  // Corepack would be the ordinary way to honour `packageManager`, and it is
  // **excluded from Node from 25.0.0** (nodejs/corepack README) — so building on
  // it would be building on something already leaving. pnpm is installed by npm
  // instead, and the version must come from the manifest rather than be written
  // into the YAML, or it is a second pin that drifts from the first.
  //
  // **The value crosses two steps, so the gate follows it across both.** A
  // `$GITHUB_ENV` write is not visible to the step that makes it, so the read
  // and the install cannot be one step; asserting over the install body alone
  // would therefore be asserting over a body that legitimately does not mention
  // the manifest. What must hold is the whole chain: some step derives the
  // version from `packageManager` into a variable, and the install step spends
  // that same variable.
  const install = installStep();

  const exported = /appendFileSync\(\s*process\.env\.GITHUB_ENV\s*,\s*"(\w+)=/.exec(ACTION)?.[1];
  assert.ok(
    exported,
    'no step exports a variable to $GITHUB_ENV, so the pnpm version the action installs is not ' +
      'derived from anything — a literal here is a second pin that will drift from package.json',
  );

  const producer = runBodies().find((body) => body.includes(`${exported}=`));
  assert.ok(producer, `nothing writes ${exported}, so the install step spends an empty variable`);
  assert.match(
    producer,
    /packageManager/,
    'the action does not read the pnpm version from package.json\'s packageManager, so the version ' +
      'it installs is a second pin that will drift from the one the repository declares',
  );

  // The install step has to actually spend it. Without this the chain can be
  // built correctly and then ignored, which reads as pinned.
  assert.match(
    install,
    new RegExp(`npm install -g "?\\$\\{?${exported}\\b`),
    `the install step does not pass $${exported} to npm, so the version derived from the manifest ` +
      'is computed and discarded',
  );

  // The `+sha512.…` integrity tail `packageManager` may carry is not part of an
  // npm specifier, and `npm install -g pnpm@11.18.0+sha512.…` fails on it. The
  // producer must strip it — asserted because the tail is optional today and
  // whoever adds it would otherwise break a stranger's CI and not this suite.
  assert.match(
    producer,
    /\.split\("\+"\)\[0\]/,
    'the exported spec keeps the +sha512 integrity tail, which npm cannot install',
  );

  // And the literal is genuinely absent. A version written here *as well* would
  // satisfy the matches above while still being the drift it exists to prevent.
  const pinned = MANIFEST.packageManager.replace(/^pnpm@/, '').split('+')[0]!;
  assert.match(pinned, /^\d+\.\d+\.\d+/, 'package.json declares no pnpm version for this gate to forbid');
  assert.ok(
    !ACTION.includes(pinned),
    `action.yml spells the pnpm version (${pinned}) that package.json already pins, so a bump has ` +
      'two places to reach and one of them will be missed',
  );
});

// ---------------------------------------------------------------------------
// The publish path: a tarball, which may carry no lockfile at all
// ---------------------------------------------------------------------------

test('the packaged manifest pins every dependency to one exact version', () => {
  // The property, measured on the artifact rather than on the source: the
  // manifest that reaches a consumer must name one version per dependency, so
  // `npx <name>@<version>` twice resolves the same tree twice.
  //
  // Staged rather than packed, for the reason `tests/packaging.test.ts` gives:
  // `compilePackage` produces exactly the directory `npm pack` runs in, so what
  // is read here is what ships — no network and no registry needed. Verified
  // through the shipped path as well: the real tarball was packed, installed
  // into a scratch project with `npm install`, and all 11 dependencies resolved
  // to the exact declared version, drift 0.
  const staged = mkdtempSync(join(tmpdir(), 'tk33-pin-'));
  try {
    compilePackage(staged);
    const manifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;

    // **Every kind npm installs, not only `dependencies`.** A reviewer added an
    // `optionalDependencies` caret range and watched it ship verbatim while this
    // gate stayed green: npm installs optional dependencies by default, so a
    // range there is exactly the unpinned tree this ticket exists to remove,
    // with the gate reporting the hole as closed. `peerDependencies` is
    // deliberately not included — a peer range describes what a host must
    // provide, and pinning it would refuse hosts this package works with.
    const dependencies: Record<string, string> = {
      ...manifest['dependencies'],
      ...manifest['optionalDependencies'],
    };
    assert.ok(
      Object.keys(dependencies).length > 0,
      'the staged manifest declares no dependencies, so this scan looked at nothing',
    );

    const floating = Object.entries(dependencies)
      .filter(([, specifier]) => !isExact(specifier))
      .map(([name, specifier]) => `${name}: ${specifier}`);

    assert.deepEqual(
      floating,
      [],
      'these dependencies ship to a consumer as ranges, so two installs of the same published ' +
        `version can resolve two different trees:\n  ${floating.join('\n  ')}`,
    );

    // The pin must be the version this repository actually resolved, not merely
    // *some* exact version. A rewrite that pinned the wrong thing would satisfy
    // the shape check above perfectly.
    const lock = parseYaml(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')) as {
      importers?: Record<
        string,
        {
          dependencies?: Record<string, { version?: string }>;
          optionalDependencies?: Record<string, { version?: string }>;
        }
      >;
    };
    const importer = lock.importers?.['.'];
    const locked = { ...importer?.dependencies, ...importer?.optionalDependencies };
    const wrong = Object.entries(dependencies)
      .filter(([name, pinned]) => (locked[name]?.version ?? '').split('(')[0] !== pinned)
      .map(([name, pinned]) => `${name}: staged ${pinned}, lockfile ${locked[name]?.version}`);
    assert.deepEqual(
      wrong,
      [],
      `the staged manifest pins versions this repository never resolved:\n  ${wrong.join('\n  ')}`,
    );

    // Non-vacuity, and it is the assertion that keeps the rest honest: the
    // *source* manifest must still carry ranges. Every check above passes
    // trivially if `package.json` were pinned by hand — which is the shape this
    // ticket was told not to produce, since a hand-written list is stale the
    // first time somebody runs `pnpm update`. The rewrite has to be doing work.
    const ranges = Object.values({
      ...MANIFEST.dependencies,
      ...MANIFEST.optionalDependencies,
    }).filter((specifier) => !isExact(specifier));
    assert.ok(
      ranges.length > 0,
      'package.json declares no ranges at all, so the staging rewrite pins nothing and this gate ' +
        'would pass with the rewrite deleted',
    );
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}, 120_000);

test('the tarball carries no lockfile, because npm would ignore it', () => {
  // Recorded as a gate rather than as a comment, because it is the reason the
  // manifest rewrite exists and it is a fact about *npm* that a future version
  // could change. npm 12's `package-lock-json.md` states `npm-shrinkwrap.json`
  // "is no longer read or written", and that one shipped inside a dependency's
  // tarball "is ignored"; `npm-packlist` force-excludes every lockfile spelling.
  //
  // Measured on npm 12.0.2: a probe package carrying `npm-shrinkwrap.json`
  // packed without it, with and without a `files` entry naming it. So a lockfile
  // staged here would be silently dropped — and if it were *not* dropped it
  // would be ignored at install, which is worse: a pin that looks present and
  // does nothing.
  //
  // **The staged tree is the subject, not the manifest's text.** An earlier
  // version asked whether `package.json` *mentioned* a lockfile spelling, and a
  // reviewer left it green by copying a real `pnpm-lock.yaml` into the staged
  // directory — the file present, the gate satisfied. `docs/gate-reading.md`
  // case 4: the instrument had its own private route to the answer and never
  // looked at the thing.
  const staged = mkdtempSync(join(tmpdir(), 'tk33-lock-'));
  try {
    compilePackage(staged);
    const packed = filesUnder(staged).map((file) => relative(staged, file).replaceAll('\\', '/'));
    assert.ok(packed.length > 0, 'the packer staged nothing, so this scan looked at no files');
    assert.ok(
      packed.includes('package.json'),
      'the staged tree has no package.json, so it is not the artifact this gate means to inspect',
    );

    const lockfiles = packed.filter((file) =>
      /(?:^|\/)(?:npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(file),
    );
    assert.deepEqual(
      lockfiles,
      [],
      'the tarball carries a lockfile, and npm ignores one shipped inside a package — so a pin ' +
        `resting on it would look present and do nothing:\n  ${lockfiles.join('\n  ')}`,
    );
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}, 120_000);
