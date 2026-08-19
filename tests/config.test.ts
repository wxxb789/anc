/**
 * The configuration file: what a repository without one gets, and what each way
 * of getting one wrong costs.
 *
 * The three error classes the ticket names are three different user mistakes
 * with three different fixes, and the gates below keep them distinguishable:
 *
 * 1. **An unknown key** — the user configured nothing and believes they did.
 * 2. **A wrong-typed value** — the key is right and the shape is not.
 * 3. **A malformed file** — nothing in it was read.
 *
 * A fourth is not in the ticket and turned out to matter more than two of them:
 * **a value the parser rewrites without saying so.** YAML's plain scalars are a
 * language and a glob pattern is not written in it, so `- !README.md` — plan
 * §2.2's own spelling for re-including the repository README — becomes the
 * empty string, and `- ! README.md` becomes `README.md`, which is not a
 * corrupted rule but an *inverted* one. Three separate mechanisms hold that
 * line, and which one catches which case was measured rather than assumed after
 * a mutation removed one of them and every gate stayed green.
 *
 * Properties are asserted on content rather than on cardinality, per this
 * repository's standing lesson. Two places where that took a second pass are
 * worth naming, because both were green while the property was false:
 *
 * - The **handoff** gate calls `discover()` with the loaded patterns and
 *   compares the published set, rather than inspecting the options object.
 * - The **disclosure** gate reduces every issue line to a closed vocabulary,
 *   rather than searching it for strings this file thought to plant. Its first
 *   version was measured passing while `checkExclude` echoed every pattern.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  CONFIG_FILENAME,
  CORRUPTION_GATE,
  DEFAULTS,
  DEFAULT_TITLE,
  exclusionOptions,
  isLoopbackOrigin,
  loadConfig,
  parseConfig,
} from '../scripts/load-config.ts';
import { discover } from '../scripts/markdown-to-artifact.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * `yaml`'s own error and warning codes, which the loader forwards verbatim.
 *
 * TK-25 §2.1 admits them as class-B literals — a closed set, byte-identical in
 * every run, distinguishing no user. Enumerated rather than pattern-matched:
 * a rule like "allow any SCREAMING_SNAKE token" would admit a user's own
 * `MY_SECRET_PROJECT` for free, and this list exists precisely so that a token
 * shaped like a code still has to *be* one.
 *
 * Taken from the library's own source (`grep` over `yaml@2.9.0`'s `dist`), so
 * it is the real set rather than the subset this test happened to trigger — two
 * codes were missed when it was built from observed failures alone.
 */
const YAML_CODES = [
  'ALIAS_PROPS',
  'BAD_ALIAS',
  'BAD_COLLECTION_TYPE',
  'BAD_DIRECTIVE',
  'BAD_DQ_ESCAPE',
  'BAD_INDENT',
  'BAD_PROP_ORDER',
  'BAD_SCALAR_START',
  'BLOCK_AS_IMPLICIT_KEY',
  'BLOCK_FOLDED',
  'BLOCK_IN_FLOW',
  'BLOCK_LITERAL',
  'DUPLICATE_KEY',
  'IMPOSSIBLE',
  'MISSING_CHAR',
  'MULTILINE_IMPLICIT_KEY',
  'MULTIPLE_ANCHORS',
  'MULTIPLE_DOCS',
  'MULTIPLE_TAGS',
  'NON_STRING_KEY',
  'PLAIN',
  'QUOTE_DOUBLE',
  'QUOTE_SINGLE',
  'RESOURCE_EXHAUSTION',
  'TAB_AS_INDENT',
  'TAG_RESOLVE_FAILED',
  'UNEXPECTED_TOKEN',
];

/**
 * Every word the loader's own source contains, lowercased, plus those codes.
 *
 * Derived from the file rather than listed, so it cannot go stale and cannot be
 * quietly padded to make a leak pass: a word this set does not hold is a word
 * the module never wrote, and therefore came from the user.
 */
const VOCABULARY: ReadonlySet<string> = new Set([
  ...[
    ...readFileSync(join(ROOT, 'scripts/load-config.ts'), 'utf8')
      .toLowerCase()
      .matchAll(/[a-z][a-z0-9_]*/g),
  ].map(([word]) => word),
  ...YAML_CODES.map((code) => code.toLowerCase()),
]);

/** A scratch directory removed when the callback returns, however it returns. */
async function scratch<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The message of the failure a body throws, or `assert.fail`. */
function refusalOf(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    assert.ok(error instanceof Error, 'threw a non-Error');
    // Only an error composed under the disclosure rule is printed by the CLI
    // boundary; anything else becomes the bare literal `build failed`, so a
    // refusal that is not one is a refusal the user never reads.
    assert.equal(error.name, 'BuildFailure', 'the refusal would not be printed by the CLI boundary');
    return error.message;
  }
  return assert.fail('was accepted');
}

// --- Absent, and the defaults --------------------------------------------------

/**
 * The first-build property, and the one the whole default-publish premise rests
 * on: a stranger with notes and nothing else gets a site.
 *
 * **Mutation watched fail:** making `loadConfig` throw when the file is absent
 * turned this red with `was accepted` inverted — the load itself threw
 * `config-missing`, and the assertion never ran.
 */
test('a repository with no configuration file loads the documented defaults', async () => {
  await scratch('tk30-absent-', async (directory) => {
    const config = loadConfig(directory);
    assert.deepEqual(config, DEFAULTS, 'an absent file did not produce exactly the defaults');
    assert.equal(config.title, DEFAULT_TITLE);
    assert.deepEqual([...config.exclude], []);
    // Not merely unset: the caller owns this fallback, because the origin has
    // one home and it is `astro.config.mjs`. A default written in the loader
    // would be a second one, which is the property `no source file hardcodes
    // the origin` exists to hold.
    assert.equal(config.origin, undefined, 'the loader invented an origin');
  });
});

/**
 * The default title belongs to nobody, and both modules that own one agree.
 *
 * Plan decision D2 removes single-owner residue, and a stranger's browser tab
 * is where it would be most visible.
 *
 * **Its subject moved with TK-31, and the old form would now pass vacuously.**
 * This used to read `src/lib/site.ts`'s `SITE_NAME` as a quoted literal and
 * assert `DEFAULT_TITLE` differed from it. That module no longer holds a name to
 * differ from — `SITE_NAME` is resolved from the user's configuration at build
 * time — so the regex matches nothing, and the whole gate rests on a value it
 * could no longer find.
 *
 * What replaces it is the property that actually needs holding now. `site.ts`
 * carries `DEFAULT_SITE_TITLE`, a second copy of this module's `DEFAULT_TITLE`,
 * because it cannot import the loader (Astro evaluates it out of
 * `dist/.prerender/`, where the loader's own dependency fails to resolve its
 * `package.json` — measured). So the two must agree, exactly as `theme-init.js`
 * and `preferences.ts` must, and neither may be this project's name.
 *
 * **Mutations watched fail:** setting `DEFAULT_TITLE = 'thoughtscape'` turned
 * the identity half red; changing `site.ts`'s `DEFAULT_SITE_TITLE` to `'Notebook'`
 * turned the agreement half red naming both values.
 */
test('the default title belongs to nobody, and the two modules holding one agree', async () => {
  const site = await readFile(join(ROOT, 'src/lib/site.ts'), 'utf8');
  const fallback = /export const DEFAULT_SITE_TITLE = '([^']*)'/.exec(site)?.[1];
  assert.ok(fallback, 'src/lib/site.ts declares no DEFAULT_SITE_TITLE, so this gate reads nothing');

  assert.equal(
    fallback,
    DEFAULT_TITLE,
    'src/lib/site.ts and the loader disagree about the title an unconfigured build gets, so a ' +
      'build takes one and every gate reading the other measures a value nothing ships',
  );

  // The identity half, with the forbidden token read from `package.json` rather
  // than spelled here.
  //
  // **The first version spelled it `/thoughtscape/i` under a comment claiming it
  // "stays true if the package is ever renamed", and the comment was wrong about
  // its own code.** The *value* was read from the module; the token was a
  // literal — so a rename would leave this matching nothing and passing for ever,
  // which is exactly the vacuity the comment claimed immunity from. Deriving the
  // token means the gate follows the package's identity instead of a memory of
  // it.
  const own = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string })
    .name.replace(/^@/, '')
    .split('/')[0]!;
  assert.ok(own.length > 2, 'package.json declares no name for this gate to forbid');

  for (const [what, value] of [['the loader', DEFAULT_TITLE], ['src/lib/site.ts', fallback]] as const) {
    assert.doesNotMatch(
      value,
      new RegExp(own, 'i'),
      `${what}'s default title is this project's own name, which a stranger's browser tab would carry`,
    );
  }
});

/**
 * An empty file is a user who created it and has not filled it in.
 *
 * Distinguished from a *malformed* file deliberately: the two look similar and
 * mean opposite things, and defaulting a malformed one would discard what the
 * user wrote.
 *
 * **Mutation watched fail:** deleting the `value === null` branch turned this
 * red — an empty document reached the table check and was refused as
 * `must be a table of keys, found null`.
 */
test('an empty or comment-only configuration file is the defaults, not a failure', () => {
  for (const text of ['', '\n\n', '# nothing configured yet\n']) {
    assert.deepEqual(parseConfig(text), DEFAULTS, `${JSON.stringify(text)} did not default`);
  }
});

/**
 * A near-miss filename is refused rather than ignored.
 *
 * The failure this closes is the one a search order creates: a user who wrote
 * `publish.config.ts` — the spelling the plan itself names — has configured
 * nothing, been told nothing, and will push whatever they meant to exclude.
 *
 * **Mutation watched fail:** returning the defaults instead of throwing turned
 * this red with `was accepted` on every one of the nine names.
 */
test('a configuration file under a near-miss name is refused, naming both spellings', async () => {
  for (const name of ['publish.config.yml', 'publish.config.ts', 'publish.yaml', 'publish.config.json']) {
    await scratch('tk30-nearmiss-', async (directory) => {
      writeFileSync(join(directory, name), 'title: Notes\n', 'utf8');
      const message = refusalOf(() => loadConfig(directory));
      assert.ok(message.includes(name), `${name}: the refusal does not name the file that is there`);
      assert.ok(message.includes(CONFIG_FILENAME), `${name}: the refusal does not name the file to rename it to`);
    });
  }
});

// --- The three error classes ---------------------------------------------------

/**
 * An unknown key fails loudly, and the message carries the coordinate the fix
 * is made at plus the key the user meant.
 *
 * **The key's own text is deliberately absent**, and that is the one part of
 * this gate that looks like a weakness and is not: a YAML key may be
 * `clients/acme/2026-renewal.md`, and this message reaches a workflow log that
 * is world-readable for 90 days. The line number sends the user to their own
 * editor, where their own text is already in front of them.
 *
 * **Mutation watched fail:** dropping the unknown-key loop turned this red with
 * `was accepted`; separately, replacing the line number with the key itself
 * turned the disclosure gate below red.
 */
test('an unknown key fails, naming the file, the line, and the key it resembles', () => {
  const message = refusalOf(() => parseConfig('title: Notes\nsiteTitle: Notes\n'));
  assert.ok(message.includes(CONFIG_FILENAME), 'the refusal does not name the file');
  assert.ok(message.includes('line 2'), 'the refusal does not name the line the key is on');
  assert.ok(message.includes('unknown key'), 'the refusal does not say the key is unknown');
  assert.ok(message.includes('"title"'), 'the refusal does not suggest the key that was meant');
});

/**
 * A misspelling and an elaboration are both caught, and each names the right
 * key.
 *
 * Two mechanisms because the two mistakes have different shapes: `excludes` is
 * four edits from `exclude` and would clear no distance threshold, while
 * `exclud` is one edit and is not a containment.
 *
 * **Mutation watched fail:** deleting the containment loop from `suggestionFor`
 * turned this red on `siteTitle` and `excludes` — both fell through to
 * `The keys are title, origin, exclude` with no suggestion.
 */
test('each near-miss key suggests the key it was a near miss for', () => {
  for (const [written, meant] of [
    ['siteTitle', 'title'],
    ['excludes', 'exclude'],
    ['exclud', 'exclude'],
    ['orgin', 'origin'],
    ['Origin', 'origin'],
    ['titel', 'title'],
  ]) {
    const message = refusalOf(() => parseConfig(`${written}: x\n`));
    assert.ok(
      message.includes(`"${meant}"`),
      `${written}: was not suggested as "${meant}" — the message was ${JSON.stringify(message)}`,
    );
  }
});

/**
 * A key that resembles nothing gets the list of keys rather than a wrong guess.
 *
 * A suggestion that is confidently wrong is worse than none: it sends the user
 * to rename a key they did not mean to write.
 *
 * **Mutation watched fail:** raising the distance threshold from 2 to 6 turned
 * this red — `bananas` was suggested as `origin`, four edits away.
 */
test('a key resembling nothing is told what the keys are, not given a wrong guess', () => {
  const message = refusalOf(() => parseConfig('bananas: 3\n'));
  assert.ok(message.includes('title, origin, exclude'), 'the refusal does not list the keys');
  assert.ok(!message.includes('Did you mean'), 'a key resembling nothing was given a suggestion');
});

/**
 * A wrong-typed value names the key, the expected type, and what was found.
 *
 * The key is printed in full here and the unknown key above is not, and the
 * asymmetry is the rule rather than an inconsistency: a *known* key is a
 * literal of the loader's own table, identical in every run on every machine,
 * so it distinguishes no user. An unknown one is text the user wrote.
 *
 * **Mutation watched fail:** replacing `typeName(value)` with a fixed
 * `'the wrong type'` turned this red on all six rows — the message no longer
 * said what was actually there.
 *
 * The expected line is stated per row rather than as a constant `line 1`, and
 * that is the second half of a coordinate being useful: a member's issue must
 * point at the *member*. The first version asserted `line 1` on two-line
 * documents where the key was on line 1 and the member on line 2 — so it passed
 * while every member issue named the `exclude:` key's line, which on a real
 * exclusion list is nowhere near the mistake.
 *
 * **Mutation watched fail (second):** passing `lines.get('exclude')` for every
 * member instead of the per-member line turned the `exclude[0]` rows red.
 */
test('a wrong-typed value names the key, the expected type, and what was found', () => {
  const cases: readonly (readonly [string, string, string, string, number])[] = [
    ['exclude: drafts/**\n', 'exclude', 'list of strings', 'a string', 1],
    ['exclude: 3\n', 'exclude', 'list of strings', 'a number', 1],
    ['exclude:\n  - 3\n', 'exclude[0]', 'string', 'a number', 2],
    ['exclude:\n  - "a/**"\n  - true\n', 'exclude[1]', 'string', 'a boolean', 3],
    ['title: 3\n', 'title', 'string', 'a number', 1],
    ['title:\n  - a\n', 'title', 'string', 'a list', 1],
    ['origin: 3\n', 'origin', 'absolute URL', 'a number', 1],
    ['origin:\n  a: b\n', 'origin', 'absolute URL', 'a table', 1],
  ];
  for (const [text, key, expected, found, line] of cases) {
    const message = refusalOf(() => parseConfig(text));
    assert.ok(message.includes(CONFIG_FILENAME), `${text}: does not name the file`);
    assert.ok(message.includes(key), `${text}: does not name the key ${key}`);
    assert.ok(message.includes(expected), `${text}: does not name the expected type`);
    assert.ok(message.includes(found), `${text}: does not say ${found} was found`);
    assert.ok(
      message.includes(`line ${line}`),
      `${text}: names a line other than ${line}, where the mistake is — ${message}`,
    );
  }
});

/**
 * A malformed file fails, and does not default.
 *
 * The distinction from the empty file above is the whole point: both are
 * "nothing was read", and only one of them is the user's intention.
 *
 * **Mutation watched fail:** dropping `document.errors` from the promotion loop
 * turned this red — the tab-indented and duplicate-key documents were accepted,
 * the second silently keeping only the later `exclude` list.
 */
test('a malformed configuration file fails rather than defaulting', () => {
  for (const text of [
    'exclude:\n\t- drafts/**\n',
    'title: a\ntitle: b\n',
    'title: My Notes: a garden\n',
    'exclude:\n  - {a,b}/**\n',
  ]) {
    const message = refusalOf(() => parseConfig(text));
    assert.ok(message.includes(CONFIG_FILENAME), `${JSON.stringify(text)}: does not name the file`);
  }
});

/**
 * A construct YAML accepts while discarding part of it is refused — including
 * where the surviving value looks perfectly ordinary.
 *
 * **This gate exists because the corruption gate above was measured passing
 * without the promotion it claimed to hold**, twice. The first repair added
 * members to `CORRUPTION_GATE`; the mutation stayed green anyway, because the
 * inversion rule — added in the same pass — refuses the tagged *patterns* on
 * their source text before the promotion is ever consulted. So the gate that
 * named the promotion was measuring a different mechanism, which is the shape
 * this repository has been bitten by four times.
 *
 * What only the promotion catches is a discarded tag *outside* `exclude`, where
 * no source-text rule looks and no type check can help, because the value left
 * behind is a valid string. Measured with the promotion removed, every one of
 * these was accepted:
 *
 * ```
 * title: !custom My Notes    -> {"title":"My Notes"}
 * origin: !url https://x/    -> {"origin":"https://x/"}
 * exclude: !weird\n  - a/**  -> {"exclude":["a/**"]}
 * %FOO bar\n---\ntitle: a    -> {"title":"a"}
 * ```
 *
 * In each the user wrote something the parser did not understand, and got a
 * build that succeeded and ignored it.
 *
 * **Mutation watched fail:** removing `document.warnings` from the promotion
 * loop turned this red on all four rows.
 */
test('a construct YAML accepts while discarding part of it is refused', () => {
  const documents = [
    'title: !custom My Notes\n',
    'origin: !url https://example.com/\n',
    'exclude: !weird\n  - "a/**"\n',
    '%FOO bar\n---\ntitle: a\n',
  ];
  for (const text of documents) {
    const message = refusalOf(() => parseConfig(text));
    assert.ok(message.includes(CONFIG_FILENAME), `${JSON.stringify(text)}: does not name the file`);
    assert.ok(/line \d+/.test(message), `${JSON.stringify(text)}: does not name a line`);
  }
});

/**
 * The gate this format was chosen on: a pattern YAML would rewrite is refused,
 * never rewritten.
 *
 * Measured over 34 realistic patterns: written unquoted, plain YAML produces 21
 * byte-exact, 13 loud failures, and — before the checks below — silent
 * rewrites. With them, zero are silent.
 *
 * Asserted as "the value is never something other than what was written", which
 * covers a rewrite this list has not thought of, rather than as "these five
 * throw", which would only cover the five.
 *
 * **What turns this red, measured rather than assumed:** deleting the inversion
 * rule from `checkExclude`, which admits `! README.md` as `README.md`. Removing
 * the warning promotion does **not** — that was measured, twice, and the gate
 * above is where the promotion is actually held. Recording the mutation that
 * does not work matters as much as the one that does: this gate's first draft
 * claimed the promotion, and a reader who trusted that claim would have removed
 * the promotion and seen green.
 */
test('a pattern YAML would rewrite is refused, never silently rewritten', () => {
  for (const pattern of CORRUPTION_GATE) {
    let loaded: string | undefined;
    try {
      loaded = parseConfig(`exclude:\n  - ${pattern}\n`).exclude[0];
    } catch (error) {
      assert.ok(error instanceof Error && error.name === 'BuildFailure', `${pattern}: threw something unprintable`);
      continue;
    }
    assert.equal(
      loaded,
      pattern,
      `${JSON.stringify(pattern)} was accepted as ${JSON.stringify(loaded)} — silently a different pattern`,
    );
  }
});

/**
 * The inversion, stated as the property rather than as a spelling.
 *
 * `!README.md` re-includes and `README.md` excludes — measured against
 * `matchesGlob` here so this rests on the producer's actual behaviour — so a
 * parse that drops the `!` does not corrupt the rule, it reverses it. The user
 * asked for a file to be published and would have withheld it.
 *
 * **Mutation watched fail:** the same deletion as above turned this red with
 * the assertion naming both the source and what it became.
 */
test('a negation whose "!" YAML would eat is refused, because it reverses the rule', () => {
  // The premise: the two spellings are opposite instructions to the producer.
  const verdict = (pattern: string): string => {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    if (!matchesGlob('README.md', body)) return 'no opinion';
    return negated ? 're-include' : 'exclude';
  };
  assert.equal(verdict('!README.md'), 're-include');
  assert.equal(verdict('README.md'), 'exclude');

  for (const written of ['! README.md', '!  README.md', '! drafts/**']) {
    const message = refusalOf(() => parseConfig(`exclude:\n  - ${written}\n`));
    assert.ok(message.includes('exclude[0]'), `${written}: does not name the member`);
    assert.ok(message.includes('"!pattern"'), `${written}: does not say how to write it`);
  }

  // The correct spelling must still work, or the rule above is satisfied by
  // refusing every re-include — which would break the one plan §2.2 requires.
  assert.deepEqual([...parseConfig('exclude:\n  - "!README.md"\n').exclude], ['!README.md']);
});

/**
 * The same patterns, quoted, survive byte for byte.
 *
 * The other half of the trade: the format refuses what it cannot carry
 * faithfully, and carries everything when the user quotes it. Without this the
 * gate above would be satisfied by a loader that refused every pattern.
 *
 * **Mutation watched fail:** making `checkExclude` reject any member containing
 * `!` turned this red on `!README.md`, which is the pattern the plan requires
 * to work.
 */
test('a quoted pattern reaches the loader byte for byte', () => {
  const patterns = [
    ...CORRUPTION_GATE,
    'drafts/**',
    '*.md',
    '**/*.tmp.md',
    'clients/acme/2026-renewal.md',
    'notes/[draft]/**',
    '日记/**',
    '{a,b}/**',
    '@work/**',
    '%archive/**',
  ];
  const document = ['exclude:', ...patterns.map((pattern) => `  - ${JSON.stringify(pattern)}`), ''].join('\n');
  assert.deepEqual([...parseConfig(document).exclude], patterns);
});

// --- Values that build a valid, wrong site --------------------------------------

/**
 * An origin carrying a path is refused, because it builds cleanly and is wrong.
 *
 * `src/lib/site.ts` forms every canonical URL as `new URL(route, site)` with a
 * root-absolute route, so `https://example.com/notes/` has its `/notes/`
 * discarded and the site ships with every public URL pointing at the wrong
 * place. Measured below rather than asserted, so this gate rests on `URL`'s
 * actual behaviour rather than on a claim about it.
 *
 * **Mutation watched fail:** dropping the `pathname !== '/'` clause turned this
 * red with `was accepted` — and the measurement in the same test then showed
 * the resolved URL had lost the path.
 */
test('an origin with a path, query, or fragment is refused', () => {
  // The premise, measured here so the refusal is not justified by a comment.
  assert.equal(
    new URL('/notes/a/', new URL('https://example.com/prefix/')).href,
    'https://example.com/notes/a/',
    'the premise no longer holds: a path in the origin now survives route resolution',
  );

  for (const origin of [
    'https://example.com/prefix/',
    'https://example.com/prefix',
    'https://example.com/?a=b',
    'https://example.com/#x',
  ]) {
    const message = refusalOf(() => parseConfig(`origin: ${JSON.stringify(origin)}\n`));
    assert.ok(message.includes('origin'), `${origin}: does not name the key`);
  }

  // The bare forms are what a user should write, and both must be accepted —
  // otherwise the gate above is satisfied by refusing everything.
  //
  // The third is the *default* origin, read from `astro.config.mjs` rather than
  // spelled here. Two reasons, and the second is why it is not simply dropped:
  // `tests/metadata.test.ts` fails on any file outside that config naming the
  // host, and this row must keep testing the exact value a build falls back to.
  // A user who configures the origin their preview already uses must not be
  // refused, and a literal copy would make that row stop tracking the default
  // the moment the default moved. Reading it holds both.
  const configured = /DEFAULT_ORIGIN = '([^']+)'/.exec(
    readFileSync(join(ROOT, 'astro.config.mjs'), 'utf8'),
  )?.[1];
  assert.ok(configured, 'astro.config.mjs declares no default origin for this row to check');

  for (const origin of ['https://example.com', 'https://example.com/', configured]) {
    assert.equal(parseConfig(`origin: ${JSON.stringify(origin)}\n`).origin, origin, `${origin}: was refused`);
  }
});

test('release origin classification rejects loopback and unspecified hosts', () => {
  for (const origin of [
    'http://localhost/',
    'https://preview.localhost/',
    'http://127.3.2.1/',
    'http://0.0.0.0/',
    'http://[::]/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.equal(isLoopbackOrigin(origin), true, `${origin}: was treated as a public release origin`);
  }
  for (const origin of ['https://notes.example.org/', 'http://10.0.0.1/', 'https://[2001:db8::1]/']) {
    assert.equal(isLoopbackOrigin(origin), false, `${origin}: was treated as loopback`);
  }
});

/**
 * A non-URL and a non-http scheme are refused.
 *
 * **Mutation watched fail:** removing the `new URL` guard turned this red —
 * `notes.example.com` was accepted, which produces a build whose canonical
 * links are unresolvable.
 */
test('an origin that is not an absolute http URL is refused', () => {
  for (const origin of ['notes.example.com', '/notes/', 'ftp://example.com/', 'javascript:alert(1)']) {
    const message = refusalOf(() => parseConfig(`origin: ${JSON.stringify(origin)}\n`));
    assert.ok(message.includes('origin'), `${origin}: does not name the key`);
  }
});

/**
 * A backslash-separated pattern is refused with the reason, not left to fail as
 * a zero-match.
 *
 * `matchesGlob` is separator-literal, which `scripts/markdown-to-artifact.ts`
 * measured: `drafts\**` matches nothing on the platform where a user is most
 * likely to have typed it. TK-26 would refuse it as a pattern matching zero
 * files — loud, but naming a typo the user cannot see, since the pattern looks
 * right in their editor.
 *
 * **Mutation watched fail:** deleting the backslash clause turned this red with
 * `was accepted`.
 */
test('a backslash-separated pattern is refused with the separator as the reason', () => {
  const message = refusalOf(() => parseConfig('exclude:\n  - "drafts\\\\**"\n'));
  assert.ok(message.includes('exclude[0]'), 'does not name the member');
  assert.ok(message.includes('/'), 'does not name the separator to use');
});

/**
 * A title carrying a control character is refused.
 *
 * `src/lib/site.ts` records that XML 1.0 has no escape for a C0 control, so a
 * feed carrying one does not parse — and that the content contract checks
 * `title` for emptiness and privacy markers but not for these characters. This
 * is the site's title rather than a note's, so it is the one such string this
 * module can close.
 *
 * **Mutation watched fail:** deleting the control-character clause turned this
 * red with `was accepted`.
 */
test('a title carrying a character XML cannot represent is refused', () => {
  const message = refusalOf(() => parseConfig('title: "a\\u0001b"\n'));
  assert.ok(message.includes('title'), 'does not name the key');
  for (const text of ['', '   ', '\n']) {
    refusalOf(() => parseConfig(`title: ${JSON.stringify(text)}\n`));
  }
});

// --- Disclosure ------------------------------------------------------------------

/**
 * No refusal carries a string that is the user's to keep.
 *
 * **Two halves, and the second exists because the first was measured green
 * while every pattern was echoed.** A review patched `checkExclude` to
 * interpolate each member into its own issue and ran this gate's original
 * corpus: five of five documents refused, no needle hit, gate passed. Two
 * independent reasons — the needle-bearing members in one document were all
 * *valid*, so only a needle-free member ever failed; and the one document whose
 * member did fail spelled the path with backslashes while every needle used
 * forward slashes.
 *
 * So the corpus is now built rule by rule — separator, duplicate, whitespace,
 * inversion, unknown key, malformed, wrong type, credential — each firing *on* a
 * needle rather than beside one. And the second half stops depending on
 * anticipation altogether: every issue line must reduce to nothing once the
 * admissible vocabulary is removed, so a byte the user supplied fails it whether
 * or not this test thought to plant that byte.
 *
 * The `zzq` prefix keeps every needle unique to this test, so a hit is
 * attributable rather than a coincidence with ordinary vocabulary.
 *
 * **Mutation watched fail:** interpolating `JSON.stringify(member)` into
 * `checkExclude`'s `where` turned this red on the separator, duplicate,
 * whitespace, and inversion documents — the mutation the original corpus could
 * not see.
 */
test('no configuration refusal puts a user’s own string on the stream', () => {
  const secrets = [
    'zzqclients/acme/zzq2026-layoffs.md',
    'zzqprivate/zzqq3-layoff-list.md',
    'zzqsecret-vendor-globex',
  ];
  // The backslash spelling of the first, because the separator rule is the one
  // that fires on it and a `/`-spelled needle cannot see a `\`-spelled echo.
  // That omission was measured making this whole gate green while every member
  // was printed verbatim.
  const backslashed = 'zzqclients\\acme\\zzq2026-layoffs.md';
  const needles = [...secrets, backslashed, ...secrets.map((secret) => secret.replace(/\.md$/, ''))];

  const documents = [
    // An unknown key that is itself a withheld note's path.
    `${JSON.stringify(secrets[0])}: true\n`,
    // A wrong-typed member beside two valid needle-bearing ones.
    `exclude:\n  - ${JSON.stringify(secrets[0])}\n  - ${JSON.stringify(secrets[1])}\n  - 3\n`,
    // The separator rule, firing *on* a needle rather than beside one.
    `exclude:\n  - ${JSON.stringify(backslashed)}\n`,
    // The duplicate rule, firing on a needle.
    `exclude:\n  - ${JSON.stringify(secrets[0])}\n  - ${JSON.stringify(secrets[0])}\n`,
    // The whitespace rule, firing on a needle.
    `exclude:\n  - ${JSON.stringify(` ${secrets[1]} `)}\n`,
    // The inversion rule, firing on a needle.
    `exclude:\n  - ! ${secrets[0]}\n`,
    // A malformed document whose surrounding lines carry the patterns.
    `exclude:\n  - ${JSON.stringify(secrets[0])}\n\t- ${JSON.stringify(secrets[1])}\n`,
    // A title that is itself sensitive, wrong-typed.
    `title:\n  - ${JSON.stringify(secrets[2])}\n`,
    // A title that is sensitive and *valid apart from* its padding.
    `title: ${JSON.stringify(` ${secrets[2]} `)}\n`,
    // An origin carrying a credential, which is the one value that is a secret
    // in itself rather than a key into one.
    'origin: "https://zzquser:zzqp4ssw0rd@example.com/"\n',
  ];

  let refusals = 0;
  for (const text of documents) {
    let message: string;
    try {
      parseConfig(text);
      continue;
    } catch (error) {
      assert.ok(error instanceof Error, 'threw a non-Error');
      message = error.message;
      refusals += 1;
    }

    for (const needle of [...needles, 'zzqp4ssw0rd', 'zzquser']) {
      assert.ok(!message.includes(needle), `a refusal carried ${JSON.stringify(needle)}:\n${message}`);
    }

    // **The positive half, and it is a token allowlist rather than a
    // subtraction.** The subtraction version — strip the admissible vocabulary,
    // assert the remainder is empty — was measured near-vacuous: its
    // `[a-z]+/gi` and punctuation strips erase *any* ASCII path, stem, or
    // title, so `clients/acme/2026-renewal.md` reduced to the empty string. A
    // mutation echoing each member's basename with separators normalised passed
    // both halves of this gate at once.
    //
    // So each line is tokenised and every word must appear in the loader's own
    // source. A word the module never wrote is a word the user supplied,
    // whatever it is made of — which is the property the needle list can only
    // approximate and the subtraction could not express at all.
    for (const line of message.split('\n').slice(1)) {
      const coordinates = line
        .replaceAll(/\bline \d+\b/g, ' ')
        .replaceAll(/\bexclude\[\d+\]\b/g, ' ');
      for (const [token] of coordinates.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
        assert.ok(
          VOCABULARY.has(token.toLowerCase()),
          `a refusal line carries ${JSON.stringify(token)}, which is not a word this ` +
            `module writes — so it came from the user:\n${line}`,
        );
      }
    }
  }
  // Without this the loop above is vacuous if the documents stop being refused.
  assert.equal(refusals, documents.length, 'a document that should have been refused was accepted');
});

/**
 * The inversion is caught in every spelling, on every line ending.
 *
 * The rule's first implementation recovered each pattern's text from the source
 * *line* and was measured wrong four ways: it missed a flow sequence, missed a
 * member indented onto the next line, missed **every** member of a CRLF file —
 * the ordinary case on Windows — and falsely refused the legitimate `!!str`.
 * So it was off exactly where it was needed and on where it was not.
 *
 * These rows are that measurement, kept as the gate. The CRLF row is the one
 * that matters most: a rule that is silently inert on the platform most users
 * are typing on is not a rule.
 *
 * **Mutation watched fail:** reverting to the line-based recovery
 * (`source.split('\n')` plus `/^\s*-\s*(.*)$/`) turned this red on the CRLF,
 * flow, and indented rows at once.
 */
test('an eaten "!" is caught in flow style, when indented, and under CRLF', () => {
  const eaten = [
    ['plain', 'exclude:\n  - ! README.md\n'],
    ['flow sequence', 'exclude: [! README.md]\n'],
    ['indented onto the next line', 'exclude:\n  -\n    ! README.md\n'],
    ['CRLF', 'exclude:\r\n  - ! README.md\r\n'],
  ] as const;
  for (const [name, text] of eaten) {
    const message = refusalOf(() => parseConfig(text));
    assert.ok(message.includes('exclude[0]'), `${name}: does not name the member`);
    assert.ok(message.includes('"!pattern"'), `${name}: does not say how to write it`);
  }

  // The valid forms, which the same rule must not refuse. `!!str` is the one
  // the line-based version got wrong: its line opens with `!` while its value
  // is an ordinary pattern.
  for (const [name, text, expected] of [
    ['quoted negation', 'exclude:\n  - "!README.md"\n', '!README.md'],
    ['quoted negation, CRLF', 'exclude:\r\n  - "!README.md"\r\n', '!README.md'],
    ['explicit string tag', 'exclude:\n  - !!str "a/**"\n', 'a/**'],
    ['flow, quoted', 'exclude: ["!README.md"]\n', '!README.md'],
  ] as const) {
    assert.equal(parseConfig(text).exclude[0], expected, `${name}: a valid pattern was refused or altered`);
  }
});

/**
 * A document that is an object but not a table discards the whole file, so it
 * is refused.
 *
 * Measured: `!!set` and `!!omap` make `toJS` return a `Set` and a `Map`. Both
 * pass a bare `typeof === 'object' && !Array.isArray`, and `Object.keys` on
 * either is empty — so before this rule, the user's entire configuration was
 * replaced by the defaults with no error, no warning, and no line number. That
 * is this module's headline failure mode one level above the misspelled key it
 * was built to catch.
 *
 * **Mutation watched fail:** replacing `isPlainObject(value)` with the bare
 * `typeof value !== 'object' || Array.isArray(value)` turned this red on both
 * rows, each having been accepted as the defaults.
 */
test('a document that is a set or an ordered map is refused, not silently defaulted', () => {
  for (const text of ['!!set\n? title\n? origin\n', '!!omap\n- title: Mine\n']) {
    const message = refusalOf(() => parseConfig(text));
    assert.ok(message.includes('table of keys'), `${JSON.stringify(text)}: ${message}`);
  }
});

/**
 * An origin carrying credentials or whitespace is refused.
 *
 * The credential case is the sharpest "builds cleanly and is wrong" in the
 * module: measured, `https://alice:s3cret@example.com/` passes every other
 * check, and `new URL('/notes/a/', origin)` then writes the password into every
 * canonical link, feed id, and sitemap entry the site publishes.
 *
 * The whitespace cases are here because `URL` *tolerates* them — measured,
 * `"  https://example.com/  "` parses, and the padded string is what would have
 * reached `site:`.
 *
 * **Mutation watched fail:** deleting the credential clause turned the first
 * two rows red; deleting the whitespace clause turned the last two red.
 */
test('an origin carrying credentials or whitespace is refused', () => {
  // The premise, measured rather than asserted: a credential in the origin
  // survives into every route resolved against it.
  assert.equal(
    new URL('/notes/a/', new URL('https://alice:s3cret@example.com/')).href,
    'https://alice:s3cret@example.com/notes/a/',
    'the premise no longer holds: credentials no longer survive route resolution',
  );

  for (const origin of [
    'https://alice:s3cret@example.com/',
    'https://alice@example.com/',
    '  https://example.com/  ',
    'https://exa mple.com/',
  ]) {
    const message = refusalOf(() => parseConfig(`origin: ${JSON.stringify(origin)}\n`));
    assert.ok(message.includes('origin'), `${origin}: does not name the key`);
  }
});

/**
 * The defaults cannot be mutated through a config a caller was handed.
 *
 * `{ ...DEFAULTS }` is a shallow copy, so before this every caller shared one
 * `exclude` array — measured, pushing to the array one `loadConfig` returned
 * changed what the next one returned. `readonly string[]` is a compile-time
 * claim only, and `exclusionOptions` hands the array straight to `discover`.
 *
 * **Mutation watched fail:** restoring `{ ...DEFAULTS }` in place of
 * `freshDefaults()` turned this red — the second load returned `['POISON']`.
 */
test('a returned configuration cannot poison the defaults', () => {
  const first = parseConfig('');
  (first.exclude as string[]).push('POISON');
  assert.deepEqual([...parseConfig('').exclude], [], 'the defaults were mutated through a returned config');
  assert.deepEqual([...DEFAULTS.exclude], [], 'DEFAULTS itself was mutated');
});

/**
 * A one- or two-character key is not given a confident suggestion.
 *
 * `known.includes(folded)` is true of any substring, so before the length floor
 * a key of `e` was suggested as `title`, `x` as `exclude`, and `o` as `origin`.
 * A confidently wrong suggestion tells the user to rename a key they did not
 * mean to write.
 *
 * **Mutation watched fail:** dropping the `folded.length >= 3` guard turned
 * this red on every row.
 */
test('a very short unknown key is told what the keys are, not given a guess', () => {
  for (const key of ['e', 'x', 'o', 't', 'lu', 'gi']) {
    const message = refusalOf(() => parseConfig(`${key}: 1\n`));
    assert.ok(
      message.includes('title, origin, exclude'),
      `${key}: was given a suggestion instead of the list — ${message}`,
    );
  }
});

/**
 * A refusal with very many issues stays readable.
 *
 * Measured before the cap: 5,000 wrong-typed members produced a 303,940-character
 * message. Nothing in it is a disclosure, but a stream nobody can read is a
 * diagnostic nobody uses.
 *
 * **Mutation watched fail:** removing the `slice` turned this red at 5,000
 * issue lines.
 */
test('a refusal with very many issues is capped, and says how many it withheld', () => {
  const document = ['exclude:', ...Array.from({ length: 200 }, () => '  - 3'), ''].join('\n');
  const message = refusalOf(() => parseConfig(document));
  assert.ok(message.includes('200 configuration violations'), 'does not state the true count');
  assert.ok(message.includes('and 150 more'), 'does not say how many it withheld');
  assert.ok(message.length < 10_000, `the message is ${message.length} characters`);
});

/**
 * An eaten `!` is caught wherever it is written, including through an alias.
 *
 * The rule started as a check on `exclude` members' source lines and grew twice,
 * each time because a review measured a way past it:
 *
 * - **Through an alias.** `title: &r ! README.md` with `exclude: [*r]` was
 *   accepted, publishing nothing and withholding the README — an `Alias` node
 *   carries no tag of its own, because the tag lives on the anchored scalar.
 * - **On `title` and `origin`.** `title: ! My Notes` was accepted as
 *   `My Notes`; the module's own header claimed the warning promotion covered
 *   it, and measured, `yaml` emits **no warning** for the non-specific `!` —
 *   only for a named tag. So the documented property was false and the gate
 *   that named it tested only named tags.
 *
 * **Mutation watched fail:** dropping the top-level loop turned the alias,
 * `title`, and `origin` rows red at once.
 *
 * **A mutation that stayed green, recorded because it is a real limit:**
 * removing the `resolve` hop from `carriesEatenTag`. Every anchor site is
 * already checked by some caller, so the alias rows below are caught by the
 * top-level loop rather than by the hop, and I could not construct a document
 * only the hop refuses. The hop is kept anyway — the function must be right
 * about the node it is handed, not right only while its callers happen to cover
 * the anchor sites — but this gate does not hold it, and a reader should not
 * take these rows as evidence that it does.
 */
test('an eaten "!" is caught through an alias and on every key', () => {
  const documents = [
    ['alias, block', 'title: &r ! README.md\nexclude:\n  - *r\n'],
    ['alias, flow', 'title: &r ! README.md\nexclude: [*r]\n'],
    ['on title', 'title: ! My Notes\n'],
    ['on origin', 'origin: ! https://example.com/\n'],
  ] as const;
  for (const [name, text] of documents) {
    const message = refusalOf(() => parseConfig(text));
    assert.ok(/line \d+/.test(message), `${name}: does not name a line — ${message}`);
  }

  // A named tag is a different mechanism's case and must stay that way, or the
  // two rules collapse into one and the warning promotion loses its own gate.
  const named = refusalOf(() => parseConfig('title: !custom My Notes\n'));
  assert.ok(named.includes('TAG_RESOLVE_FAILED'), `a named tag is no longer the promotion's case: ${named}`);
});

/**
 * A file holding more than one document is refused, not silently truncated.
 *
 * Measured: `title: One\n---\nexclude:\n  - "drafts/**"\n` parsed to
 * `{title: 'One'}` with `errors` and `warnings` both empty — the user's entire
 * exclusion list discarded with no error and no line number. Same failure class
 * as the `!!set` document, and worse: what is dropped is the half that withholds
 * files.
 *
 * **Mutation watched fail:** reverting `parseAllDocuments` to `parseDocument`
 * turned this red — the second document was accepted and ignored.
 */
test('a file holding a second document is refused, naming where it begins', () => {
  const message = refusalOf(() => parseConfig('title: One\n---\nexclude:\n  - "drafts/**"\n'));
  assert.ok(message.includes('line 2'), `does not name where the second document begins: ${message}`);
  // One document must still be ordinary, or the rule is satisfied by refusing
  // every file. A leading `---` is a document *start* marker, not a separator.
  assert.equal(parseConfig('---\ntitle: One\n').title, 'One', 'a leading document marker was refused');
});

/**
 * An ordinary `config.yaml` in a stranger's repository is not this tool's
 * business.
 *
 * The near-miss list closes a real gap, and it over-reached: `config.yaml` and
 * `config.yml` were on it, so a repository holding an unrelated `config.yaml` —
 * one of the most common filenames there is — was **refused outright**, told to
 * rename a file that has nothing to do with this tool, with no way to proceed
 * but to delete it. The `publish.*` spellings carry the intent signal; the bare
 * noun does not.
 *
 * **Mutation watched fail:** restoring `config.yaml` to `NEAR_MISS_NAMES`
 * turned this red with the refusal quoted.
 */
test('an unrelated config.yaml does not stop the build', async () => {
  await scratch('tk30-unrelated-', async (directory) => {
    for (const name of ['config.yaml', 'config.yml', 'settings.yaml', 'app.config.yaml']) {
      writeFileSync(join(directory, name), 'theme: mytheme\n', 'utf8');
    }
    assert.deepEqual(loadConfig(directory), DEFAULTS, "a stranger's own config file was treated as ours");
  });
});

/**
 * The private half carries what the public half may not.
 *
 * The split is the whole design — the stream gets the coordinate, the report
 * gets the text — so a gate proving only the public half is nameless would be
 * satisfied by a loader that threw the information away.
 *
 * **Mutation watched fail:** passing `issues` as the detail — which is what
 * `BuildFailure`'s default second argument does — turned this red: the detail
 * became a copy of the public message and carried no key.
 */
test('the refusal’s private half carries the text the public half withholds', () => {
  try {
    parseConfig('zzqclients/acme/zzq2026-layoffs.md: true\n');
    assert.fail('was accepted');
  } catch (error) {
    assert.ok(error instanceof Error && 'detail' in error, 'the refusal carries no private half');
    const detail = String((error as { detail: unknown }).detail);
    assert.ok(
      detail.includes('zzqclients/acme/zzq2026-layoffs.md'),
      `the private half does not carry the key the user must fix: ${detail}`,
    );
  }
});

/**
 * A duplicate pattern is refused, because nothing downstream can see it.
 *
 * This is the one user mistake TK-26's zero-match rule structurally cannot
 * catch: measured, `exclude: ['draft.md', 'draft.md']` builds cleanly and
 * publishes the right set, because `excludes()` records a hit for *every*
 * pattern that matched, so neither copy is ever idle. A repeated line in a list
 * a user has edited over months is usually one they meant to change and copied
 * instead — a rule they believe is configured and is not.
 *
 * **Mutation watched fail:** deleting the `seen` map turned this red with
 * `was accepted`; the same corpus was measured building cleanly through
 * `discover()` beforehand, which is why the rule is here rather than there.
 */
test('a duplicate exclusion pattern is refused, naming both positions', () => {
  const message = refusalOf(() => parseConfig('exclude:\n  - "a/**"\n  - "b/**"\n  - "a/**"\n'));
  assert.ok(message.includes('exclude[2]'), 'does not name the duplicate');
  assert.ok(message.includes('exclude[0]'), 'does not name the pattern it repeats');
  // Distinct patterns must still be accepted, or the rule is satisfied by
  // refusing every list.
  assert.deepEqual([...parseConfig('exclude:\n  - "a/**"\n  - "b/**"\n').exclude], ['a/**', 'b/**']);
});

// --- The handoff to TK-26 --------------------------------------------------------

/**
 * The loaded patterns are what `discover()` takes, proven by calling it.
 *
 * The acceptance criterion is "accepted without adaptation", and the only
 * evidence for that is a real call. Two halves, because either alone is
 * satisfiable by a broken loader: the published set must be exactly the notes
 * that survive the patterns, and TK-26's zero-match rule must name **this file**
 * — which it only does if `excludeSource` matches the producer's own
 * `CONFIG_LOCATION` allowlist, a coupling nothing else here would notice
 * breaking.
 *
 * **Mutation watched fail:** renaming `CONFIG_FILENAME` to `publish.config`
 * (no extension) turned the second half red — the producer fell back to
 * `the exclude list`, and the user would never learn which file to edit.
 */
test('the loaded configuration is accepted by discover() without adaptation', async () => {
  await scratch('tk30-handoff-', async (directory) => {
    writeFileSync(
      join(directory, CONFIG_FILENAME),
      ['# what I do not publish yet', 'exclude:', '  - "drafts/**"', '  - "*.tmp.md"', ''].join('\n'),
      'utf8',
    );
    writeFileSync(join(directory, 'alpha.md'), '# Alpha\n', 'utf8');
    writeFileSync(join(directory, 'scratch.tmp.md'), '# Scratch\n', 'utf8');
    writeFileSync(join(directory, 'beta.md'), '# Beta\n', 'utf8');
    mkdirSync(join(directory, 'drafts'), { recursive: true });
    writeFileSync(join(directory, 'drafts/wip.md'), '# Work in progress\n', 'utf8');

    const config = loadConfig(directory);
    const discovery = await discover(directory, exclusionOptions(config));

    assert.deepEqual(
      discovery.entries.map((entry) => entry.slug).sort(),
      ['alpha', 'beta'],
      'the published set is not what the configured patterns select',
    );
    assert.deepEqual(
      discovery.dropped
        .filter((file) => file.reason === 'excluded-by-pattern')
        .map((file) => file.path)
        .sort(),
      ['drafts/wip.md', 'scratch.tmp.md'],
      'the excluded files were not dropped for the configured reason',
    );
    // The config file itself is not Markdown, so it is dropped rather than
    // published — asserted because a config that became a page would be this
    // ticket publishing the user's exclusion list as a note.
    assert.ok(
      discovery.dropped.some((file) => file.path === CONFIG_FILENAME && file.reason === 'not-markdown'),
      'the configuration file was not dropped as a non-Markdown file',
    );
  });
});

/**
 * A pattern matching nothing fails, and the failure names this file.
 *
 * The other half of the handoff, and the one that proves the *label* crosses
 * the seam rather than only the patterns.
 */
test('a configured pattern matching nothing fails, naming the configuration file', async () => {
  await scratch('tk30-zeromatch-', async (directory) => {
    writeFileSync(join(directory, CONFIG_FILENAME), 'exclude:\n  - "draft/**"\n', 'utf8');
    writeFileSync(join(directory, 'alpha.md'), '# Alpha\n', 'utf8');

    const config = loadConfig(directory);
    try {
      await discover(directory, exclusionOptions(config));
      assert.fail('a pattern matching nothing was accepted');
    } catch (error) {
      assert.ok(error instanceof Error, 'threw a non-Error');
      assert.ok(
        error.message.includes(CONFIG_FILENAME),
        `the zero-match failure does not name the configuration file: ${error.message}`,
      );
      assert.ok(error.message.includes('exclude[0]'), 'the zero-match failure does not name the index');
      assert.ok(!error.message.includes('draft/**'), 'the zero-match failure echoed the pattern text');
    }
  });
});

// --- End to end, over the binary --------------------------------------------------

/**
 * A configured exclusion actually withholds the file, measured over the shipped
 * command rather than over `discover`.
 *
 * **This gate exists because the two above are not evidence of it.** They call
 * `discover` directly with `exclusionOptions(config)`, which proves the loader
 * produces what the producer consumes and proves nothing about whether anything
 * *passes* it. Measured on the shipped binary before the call site was wired: a
 * repository whose `publish.config.yaml` excluded `drafts/**` built cleanly and
 * **published the drafts** — the excluded note's body reached five files under
 * `dist/`, including the search index. The counts line read `2 published` and
 * looked exactly like a working build.
 *
 * That is the worst direction for this project's privacy model to fail. A
 * fail-open exclusion is indistinguishable from a working one until somebody
 * reads the published site, which is after the note is on a CDN and in a search
 * index.
 *
 * **Both halves are asserted, and the first is what makes the second mean
 * anything.** The token must be present in the corpus on disk — otherwise a gate
 * that wrote the fixture wrongly would report absence from `dist/` as success,
 * which is the "0 because none" versus "0 because I never looked" ambiguity this
 * repository has been bitten by. Then it must be absent from *every* file under
 * `dist/`, not merely from `dist/notes/`: the leak went through the Pagefind
 * index and the content index as well as the page.
 *
 * Run through `bin/thoughtscape-publish.mjs` in a child process, because the
 * property is about the command a user types. An in-process call would test the
 * functions this file already tests.
 *
 * **Mutation watched fail:** replacing `exclusionOptions(config)` with no second
 * argument at `bin/thoughtscape-publish.mjs`'s `discover` call turned this red —
 * `2 published`, and the token in 5 files under `dist/`.
 */
test('a configured exclusion withholds the file from dist/, end to end', async () => {
  await scratch('tk30-e2e-', async (directory) => {
    const notes = join(directory, 'notes');
    const out = join(directory, 'out');
    mkdirSync(join(notes, 'drafts'), { recursive: true });
    writeFileSync(join(notes, CONFIG_FILENAME), 'exclude:\n  - "drafts/**"\n', 'utf8');
    writeFileSync(join(notes, 'public.md'), '# Public\n\nAn ordinary note.\n', 'utf8');
    // A token no other file in the tree carries, so a hit is attributable.
    writeFileSync(join(notes, 'drafts', 'secret.md'), '# Secret\n\nzzqexcludedleak here.\n', 'utf8');

    const probe = spawnSync(
      process.execPath,
      [join(ROOT, 'bin/thoughtscape-publish.mjs'), 'build', '--content', notes, '--out', out],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, `the build failed:\n${probe.stdout}\n${probe.stderr}`);

    /** Every file under a directory, recursively. */
    const filesUnder = (root: string): string[] =>
      readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? filesUnder(join(root, entry.name)) : [join(root, entry.name)],
      );

    // Half one: the token really is in the corpus. Without this the assertion
    // below passes on a fixture that never contained it.
    const inCorpus = filesUnder(notes).filter((file) => readFileSync(file, 'utf8').includes('zzqexcludedleak'));
    assert.equal(inCorpus.length, 1, 'the fixture does not contain the token, so the next assertion proves nothing');

    // Half two: it reached nothing that ships. Every file, not just the pages —
    // the measured leak went through the Pagefind index too.
    //
    // **Inflated before scanning, because the search index is gzipped and a
    // UTF-8 read cannot see into it.** Measured on a real build: a withheld
    // note's name is absent from `dist/pagefind/fragment/*.pf_fragment` read as
    // text and present after `gunzipSync` — so the byte-level scan this gate
    // used to do reported the search index clean while every published body sat
    // inside it compressed. That is the largest surface in `dist/` and it was
    // the one surface this gate could not read.
    //
    // Not gzip-shaped files fall through to the raw read, so an ordinary page
    // is scanned exactly as before.
    const searchable = (file: string): string => {
      const raw = readFileSync(file);
      try {
        return `${raw.toString('utf8')}\n${gunzipSync(raw).toString('utf8')}`;
      } catch {
        return raw.toString('utf8');
      }
    };

    const leaked = filesUnder(out).filter((file) => {
      try {
        return searchable(file).includes('zzqexcludedleak');
      } catch {
        return false;
      }
    });
    assert.deepEqual(
      leaked.map((file) => file.slice(out.length + 1).replaceAll('\\', '/')),
      [],
      'the excluded note reached the published site',
    );

    // **Non-vacuity for the inflate itself**, and without it adding `gunzipSync`
    // above proves nothing: a scan that never decompresses anything reports the
    // same empty list as one that decompresses everything, so the absence
    // assertion cannot tell a working gate from a blind one. Measured — with
    // the inflate removed, the assertion above stayed **green**.
    //
    // The control is a *positive* one rather than a planted needle. There is no
    // token that lands only in a gzipped member: Pagefind indexes a published
    // note's body, and that body is also in the note's own HTML, so anything
    // reachable in the index is reachable in a page too. What can be proven is
    // that the inflate genuinely reads a surface a UTF-8 read cannot — the
    // published note's own words, recovered from a gzip member where the raw
    // bytes do not contain them.
    const gzipped = filesUnder(out).filter((file) => {
      const bytes = readFileSync(file);
      return bytes[0] === 0x1f && bytes[1] === 0x8b;
    });
    assert.ok(
      gzipped.length > 0,
      'the build produced no gzipped file, so the inflate branch never ran and this gate is ' +
        'a plain text scan claiming to be more',
    );
    assert.ok(
      gzipped.some(
        (file) =>
          !readFileSync(file, 'utf8').includes('An ordinary note') &&
          searchable(file).includes('An ordinary note'),
      ),
      "no gzipped file yielded the published note's own text only after inflating, so the " +
        'decompression is not reaching the search index this gate claims to cover',
    );

    // And the counts agree with the outcome, so a build that excluded the note
    // by failing to find it would not pass.
    assert.match(probe.stdout, /content: 3 discovered, 1 published, 2 dropped/, probe.stdout);
    assert.deepEqual(readdirSync(join(out, 'notes')), ['public'], 'the published route set is not just the public note');
  });
  // One full CLI build plus a scan of every file in its `dist/` with the gzipped
  // members inflated. Measured across six full runs: 55, 59, 62, 79, 97, and
  // **101 s** — the last 84% of the 120 s this carried, and it crossed at 187 s
  // on a seventh run measured on a host 2.4x degraded.
  //
  // A build costs 20.4 s idle and p50 29-36 s under the suite's own contention,
  // so most of this gate is the inflating scan rather than the build. 300 s is
  // ~3x the observed maximum, matching what `tests/disclosure.test.ts` derives
  // for the same pair of costs.
}, 300_000);

// --- The origin has one home -----------------------------------------------------

/**
 * A configured origin reaches `astro.config.mjs`, and an absent one leaves its
 * fallback in place.
 *
 * The acceptance criterion is that the origin "comes from config when one is
 * present", and the honest evidence for it is the config module actually being
 * evaluated with a config on disk — not a claim about what `??` does. So this
 * loads `astro.config.mjs` in a child process with `PUBLISH_CONFIG_DIR` pointed
 * at a scratch directory, twice, and reads `site` off the exported object.
 *
 * A child process rather than an import, because `astro.config.mjs` reads the
 * environment at module scope and a module is evaluated once per process — two
 * imports in one test would both see whichever value was set first, which is a
 * gate that cannot tell the two cases apart.
 *
 * **Mutation watched fail:** changing `site:` to the bare `DEFAULT_ORIGIN`
 * turned the first half red — the configured origin never reached the build,
 * which is exactly the wiring failure this ticket would otherwise ship
 * silently.
 */
test('a configured origin reaches astro.config.mjs, and an absent one does not', async () => {
  await scratch('tk30-origin-', async (directory) => {
    const read = (): string => {
      const probe = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '-e',
          "import('./astro.config.mjs').then((m) => console.log(m.default.site));",
        ],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PUBLISH_CONFIG_DIR: directory } },
      );
      assert.equal(probe.status, 0, `loading astro.config.mjs failed: ${probe.stderr}`);
      return probe.stdout.trim();
    };

    const fallback = read();
    assert.ok(fallback.length > 0, 'astro.config.mjs exported no site');

    writeFileSync(join(directory, CONFIG_FILENAME), 'origin: "https://notes.example.test/"\n', 'utf8');
    const configured = read();

    assert.equal(configured, 'https://notes.example.test/', 'the configured origin did not reach the build');
    assert.notEqual(configured, fallback, 'the configured origin was ignored in favour of the fallback');
  });
});

/**
 * A malformed config fails a raw `astro build` legibly, with no host path.
 *
 * `bin/thoughtscape-publish.mjs` has a boundary that knows how to print a
 * `BuildFailure`; a direct `astro build` — and `astro dev`, which evaluates the
 * same module scope — has only Astro's config loader. Measured before
 * `astro.config.mjs` caught the throw, that loader printed the composed message
 * *plus* a stack trace carrying four absolute host paths
 * (`at refuse (Q:/…/scripts/load-config.ts:313:8)` and three more). TK-25 §2.3
 * forbids a discovered filesystem path on that stream.
 *
 * Asserted on the stream's whole content rather than on the exit code, because
 * the exit code was already 1 while the paths were being printed.
 *
 * **Mutation watched fail:** removing the `try`/`catch` from
 * `astro.config.mjs`'s `loadUserConfig` turned this red, with the assertion
 * naming the `Q:` drive letter in the trace.
 */
test('a malformed config fails a raw astro build with no host path on the stream', async () => {
  await scratch('tk30-astrofail-', async (directory) => {
    writeFileSync(join(directory, CONFIG_FILENAME), 'siteTitle: Notes\n', 'utf8');
    // `node_modules/astro/bin/astro.mjs`, not the `.pnpm/astro@7.1.6_<hash>/…`
    // path this reached for first. Both resolve to the same file — verified —
    // but the versioned one embeds an astro version *and* a pnpm
    // peer-dependency hash, either of which changes on a lockfile bump, after
    // which an `existsSync` guard that returned early would leave this gate
    // green while asserting nothing. That is the vacuity shape this repository
    // keeps being bitten by, so the path is the stable one and its absence is a
    // failure rather than a skip.
    const astro = join(ROOT, 'node_modules/astro/bin/astro.mjs');
    assert.ok(existsSync(astro), `astro is not installed at ${astro}, so this gate cannot run`);

    const probe = spawnSync(process.execPath, [astro, 'build'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PUBLISH_CONFIG_DIR: directory },
    });

    const streams = `${probe.stdout}${probe.stderr}`;
    assert.notEqual(probe.status, 0, 'a malformed configuration did not fail the build');
    assert.ok(streams.includes(CONFIG_FILENAME), `the failure does not name the file:\n${streams}`);
    assert.ok(streams.includes('unknown key'), `the failure does not say what is wrong:\n${streams}`);
    // The disclosure half. A drive letter, a POSIX-style repository path, and a
    // stack frame are each a host path by a different spelling.
    for (const leak of [ROOT, ROOT.replaceAll('\\', '/'), 'node_modules', '    at ']) {
      assert.ok(!streams.includes(leak), `the failure carries ${JSON.stringify(leak)}:\n${streams}`);
    }
  });
});

/**
 * The loader declares no origin of its own, on any path that reaches a build.
 *
 * `tests/metadata.test.ts` holds that no source file hardcodes the *configured*
 * host, which is a different property: it would stay green if this module
 * introduced a second default under some other name. What must be true is that
 * the fallback lives in `astro.config.mjs` and the loader supplies only what
 * the user actually wrote.
 *
 * **Asserted on the returned value rather than on the source text, and the
 * textual version is worth recording because it was written first and was
 * wrong.** A scan for `https?://` over the comment-stripped module flagged
 * `such as https://notes.example.com/` inside the refusal message — an example
 * shown to a user who typed an unparseable origin, which is prose and never
 * becomes anybody's site. Weakening the regex to permit it would have made the
 * gate a spelling rule; asserting what the loader *returns* covers every path a
 * default could hide on, including the ones a regex cannot see.
 *
 * **Mutation watched fail:** giving `DEFAULTS.origin` the default origin's own
 * value turned this red on all four rows. That value is now
 * `astro.config.mjs`'s, changed by TK-31 from an RFC 2606 `.invalid`
 * placeholder to an RFC 6761 `.localhost` preview origin — and the mutation
 * still goes red, which is the point of this gate: *whatever* the default is,
 * the loader must not be a second place holding it.
 */
test('the configuration loader declares no origin of its own', async () => {
  assert.equal(DEFAULTS.origin, undefined, 'the loader carries a default origin');
  assert.equal(parseConfig('').origin, undefined, 'an empty file produced an origin');
  assert.equal(parseConfig('title: Notes\n').origin, undefined, 'a file without an origin key produced one');
  await scratch('tk30-noorigin-', async (directory) => {
    assert.equal(loadConfig(directory).origin, undefined, 'an absent file produced an origin');
  });
});
