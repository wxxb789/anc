/**
 * The gate over the gates.
 *
 * TK-14's premise is that every check in this repository is only as strong as
 * someone remembering to run it. `pnpm run verify` is the answer, and the CI
 * workflow calls it rather than restating its steps — but that arrangement has
 * exactly one failure mode, and it is silent: the two drift. Someone adds a
 * gate to `verify` and the workflow keeps passing without it, or someone spells
 * a gate out in YAML "just to be explicit" and now there are two lists.
 *
 * These assertions are what make "they cannot drift" a property rather than an
 * intention. They are cheap and they are structural: they read the manifest and
 * the workflow as data, and they fail on the shape of the mistake rather than
 * on any particular gate's name.
 *
 * The workflow is parsed with a deliberately small reader rather than a YAML
 * dependency. What is needed is the `run:` lines and the workflow's own name —
 * both single-line scalars at a known indent — and adding a parser to
 * `package.json` to read seven lines would be a dependency for a regex. The
 * reader is strict about what it accepts, so a workflow it cannot parse fails
 * rather than yielding an empty list that would pass everything.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { scanResidue } from '../scripts/scan-residue.ts';

const ROOT = new URL('../', import.meta.url);
const WORKFLOW_PATH = '.github/workflows/verify.yml';

const WORKFLOW = readFileSync(new URL(WORKFLOW_PATH, ROOT), 'utf8');

const SCRIPTS = (
  JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * Every `run:` command in the workflow, in order.
 *
 * Only the single-line `- run: <command>` form is recognised, which is the form
 * the workflow uses. Every other form YAML allows — a block scalar (`run: |`),
 * flow style (`- {run: …}`), a quoted key — would be read as *no step*, and a
 * reader that silently sees fewer steps than exist is how the mirror gate below
 * passes while the workflow does something else. So the count is checked
 * against every `run:` occurrence in the file rather than merely asserted
 * non-empty: an under-read fails instead of passing quietly.
 */
function runSteps(): string[] {
  return [...WORKFLOW.matchAll(/^\s*-?\s*run:\s*(.+?)\s*$/gm)].map((match) => match[1]!);
}

/** Every line that mentions `run:` outside a comment, however it is written. */
function runMentions(): string[] {
  return WORKFLOW.split('\n').filter((line) => !line.trimStart().startsWith('#') && /(?:^|[\s{,])run:/.test(line));
}

test('the workflow is syntactically well formed', () => {
  // Not a YAML validation — a tab is the one character YAML forbids outright
  // for indentation, and `.gitattributes` normalises this file to LF, so CRLF
  // here would mean the attribute stopped applying.
  assert.doesNotMatch(WORKFLOW, /^[ ]*\t/m, `${WORKFLOW_PATH}: indents with a tab, which YAML forbids`);
  assert.doesNotMatch(WORKFLOW, /\r/, `${WORKFLOW_PATH}: contains CR — .gitattributes declares this repository LF`);
  assert.match(WORKFLOW, /^name: \S/m, `${WORKFLOW_PATH}: declares no name`);
  assert.match(WORKFLOW, /^on:/m, `${WORKFLOW_PATH}: declares no trigger, so it would never run`);
  assert.match(WORKFLOW, /^jobs:$/m, `${WORKFLOW_PATH}: declares no jobs`);
});

test('every step in the workflow is readable by these gates', () => {
  // A `run: |` step, or a flow-style `- {run: …}`, hides its commands from
  // `runSteps()` — which would let the mirror gate below pass while the
  // workflow ran something it never saw.
  assert.doesNotMatch(
    WORKFLOW,
    /^\s*-?\s*run:\s*[|>]/m,
    `${WORKFLOW_PATH}: uses a block scalar for a step, which these gates cannot read`,
  );
  const steps = runSteps();
  assert.ok(steps.length > 0, `${WORKFLOW_PATH}: has no run steps`);
  // The guard that makes the above meaningful: every `run:` in the file was
  // parsed into a step. Without it a narrowed reader reports a subset and
  // every gate below passes on the part it happened to see.
  assert.equal(
    steps.length,
    runMentions().length,
    `${WORKFLOW_PATH}: ${runMentions().length} run: lines but ${steps.length} parsed — a step is written in a form these gates cannot read`,
  );
});

/**
 * The executables this project's own gates are built from, derived from the
 * manifest rather than listed.
 *
 * Every script body is a `&&` chain of commands; the first word of each link is
 * the tool it runs. Taking them from there means the set tracks the manifest:
 * if `check` ever becomes `tsc --noEmit`, `tsc` joins this set on the same
 * commit, with nothing to remember. An earlier version hardcoded
 * `vitest|oxlint|astro|pagefind`, which would have let exactly that change slip
 * past the mirror gate below.
 *
 * `pnpm` itself is dropped: a link beginning with it is a script this manifest
 * declares, which `gateInvokedBy`'s first route already recognises by name.
 */
const GATE_TOOLS: ReadonlySet<string> = new Set(
  Object.values(SCRIPTS)
    .flatMap((body) => body.split('&&'))
    .map((link) => link.trim().split(/\s+/)[0])
    .filter((tool) => tool !== undefined && tool !== '' && tool !== 'pnpm'),
);

/**
 * The gate a workflow step would be running, or `undefined` if the step is
 * setup rather than a gate.
 *
 * Two routes, because a gate can be restated in YAML two ways and an earlier
 * version of this caught only the first. Naming the gates literally — `test`,
 * `lint`, `check`, `build` — missed `pnpm exec vitest run` and `pnpm exec astro
 * check` entirely, which run the same gates while matching none of those words.
 * A gate that can be bypassed by spelling it differently is not a gate.
 *
 * So: any step invoking a script *this manifest declares* is a gate, and any
 * step invoking one of the tools *those scripts are built from* is a gate too,
 * which covers the route around the manifest. Neither route carries a list.
 *
 * It errs toward calling a step a gate. That is the safe direction: a false
 * positive means someone routes a step through `verify`, while a false negative
 * is the silent drift this whole file exists to prevent.
 */
function gateInvokedBy(step: string): string | undefined {
  const script = /^pnpm\s+(?:run\s+)?([\w:-]+)/.exec(step)?.[1];
  if (script !== undefined && Object.hasOwn(SCRIPTS, script)) return script;
  const words = step.split(/[^\w:.-]+/);
  return words.some((word) => GATE_TOOLS.has(word)) ? step : undefined;
}

test('the workflow runs verify and does not restate the gates verify composes', () => {
  const steps = runSteps();
  assert.ok(
    steps.includes('pnpm run verify'),
    `${WORKFLOW_PATH}: does not run \`pnpm run verify\`, so CI and the host no longer check the same things`,
  );

  // The mirror property, stated as the thing that can actually go wrong: any
  // *second* gate-running step is a gate spelled out in YAML, and a gate
  // spelled out in YAML is one that can be added to `verify` and forgotten
  // here, or removed from `verify` and left running here.
  assert.deepEqual(
    steps.filter((step) => gateInvokedBy(step) !== undefined),
    ['pnpm run verify'],
    `${WORKFLOW_PATH}: runs a gate directly instead of through \`verify\`, which is how the two drift apart`,
  );
});

test('the workflow deploys nothing and needs no secret', () => {
  // Requirements section 21.1 stage 13: deployment is a separately approved
  // action. A workflow that could deploy would turn a green build into
  // publication authority, which the agent contract forbids.
  //
  // The load-bearing guards are the first two: no secret reference, and a
  // narrowed `permissions` block. A deployment needs credentials, so a workflow
  // that can read none and holds a read-only token cannot publish regardless of
  // what any step is named.
  assert.doesNotMatch(WORKFLOW, /\$\{\{\s*secrets\./, `${WORKFLOW_PATH}: reads a secret`);
  assert.match(
    WORKFLOW,
    /^permissions:\n\s+contents: read$/m,
    `${WORKFLOW_PATH}: does not narrow permissions to \`contents: read\``,
  );

  // The name check is a tripwire on top of those, not the guarantee — a step
  // could always deploy under some name this list does not know. It reads only
  // non-comment lines, so the file stays free to *explain* that it does not
  // deploy; an earlier version scanned comments too and survived only because
  // the word it used happened to be "deploys".
  const instructions = WORKFLOW.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  for (const forbidden of [/wrangler/i, /cloudflare/i, /pages[- ]deploy/i, /\bdeploy\b/i, /npm publish/]) {
    for (const line of instructions) {
      assert.doesNotMatch(line, forbidden, `${WORKFLOW_PATH}: step matches ${forbidden}, and CI must not deploy`);
    }
  }
});

test('the workflow pins Node and pnpm to the files that already pin them', () => {
  // Two pins for one version is how they disagree. `.nvmrc` and
  // `packageManager` are the existing ones — `tests/deployment.test.ts` gates
  // `.nvmrc` against `engines.node` — so the workflow must read them rather
  // than name a version of its own.
  assert.match(WORKFLOW, /node-version-file:\s*\.nvmrc/, `${WORKFLOW_PATH}: does not pin Node from .nvmrc`);
  assert.doesNotMatch(
    WORKFLOW,
    /^\s*node-version:/m,
    `${WORKFLOW_PATH}: pins a literal Node version, which can disagree with .nvmrc`,
  );
  assert.doesNotMatch(
    WORKFLOW,
    /^\s*version:\s*['"]?\d/m,
    `${WORKFLOW_PATH}: pins a literal pnpm version, which can disagree with packageManager in package.json`,
  );
  assert.match(
    WORKFLOW,
    /pnpm install --frozen-lockfile/,
    `${WORKFLOW_PATH}: installs without --frozen-lockfile, so CI could resolve versions the lockfile does not name`,
  );
});

test('CI runs the browser gates rather than letting them skip', () => {
  // `tests/rendered-page.test.ts` skips its four gates when Chromium is
  // absent, which is right for a fresh clone and wrong for CI: the whole point
  // of this ticket is that a gate nothing guarantees runs is not a gate. A
  // green CI run that silently skipped them would be worse than no CI.
  assert.ok(
    runSteps().some((step) => /playwright install\b.*\bchromium\b/.test(step)),
    `${WORKFLOW_PATH}: does not install Chromium, so the rendered gates would skip and CI would report green`,
  );
});

test('verify runs every gate, and the build it measures happens before the tests', () => {
  const verify = SCRIPTS['verify'];
  assert.ok(verify, 'package.json declares no `verify` script');

  // Parsed into links rather than matched as one string. Both assertions below
  // were wrong when they reasoned over the raw text: a substring test cannot
  // tell `build` from `build:fixture`, and comparing character offsets is not
  // comparing order — `pnpm run build:fixture && pnpm test && pnpm run build`
  // satisfied "build before test" while genuinely running the tests first.
  const links = verify.split('&&').map((link) => link.trim());
  const gateAt = (gate: string) => links.findIndex((link) => new RegExp(`^pnpm (?:run )?${gate}$`).test(link));

  // Named individually rather than as a count: a count stays satisfied while
  // one gate is swapped for another. Validation and the residue scan are links
  // of `build`, asserted separately below.
  for (const gate of ['lint', 'check', 'build', 'test']) {
    assert.notEqual(gateAt(gate), -1, `verify does not run \`${gate}\`, so that gate is optional again`);
  }

  // Ordering is a real defect class here, not pedantry. Half the suite reads
  // `dist/` — the CSP gates, the residue-adjacent page scans, the byte budget —
  // and a suite that runs before the build measures the *previous* build, so a
  // change that breaks the output would pass on stale files.
  assert.ok(
    gateAt('build') < gateAt('test'),
    'verify runs the tests before the build, so they would measure the previous build',
  );

  // `&&` and not `;`: with `;` every later gate runs on a failed earlier one,
  // and the exit status is whichever gate happened to run last.
  assert.doesNotMatch(verify, /;/, 'verify chains with `;`, so a failing gate would not stop it');
  assert.match(verify, /&&/, 'verify does not chain with `&&`');
});

test('the residue scan is a blocking link of the build, not an advisory step', () => {
  const build = SCRIPTS['build'];
  assert.ok(build, 'package.json declares no `build` script');

  // In `build` rather than only in `verify` for one specific reason: Cloudflare
  // Pages runs `pnpm run build` and nothing else. A scan that lived only in
  // `verify` would be enforced on this machine and absent from the host that
  // publishes the artifact — which is the wrong way round for a privacy gate.
  //
  // **The chain moved out of `package.json` and into `scripts/build-site.ts`**,
  // a wrapper that holds the `dist/` lock across every step — which no single
  // step can do, since the five are five processes and the writing spans three
  // of them. So the property is read where the chain now lives. It is a stronger
  // form than the string match it replaces: the steps are an ordered array, so
  // "last" is a position rather than a regex anchor, and "blocking" is a
  // non-zero return rather than an `&&`.
  assert.match(build, /scripts\/build-site\.ts/, '`build` no longer runs the chain wrapper');

  const wrapper = readFileSync(new URL('../scripts/build-site.ts', import.meta.url), 'utf8');
  const steps = [...wrapper.matchAll(/\['node', 'scripts\/([\w-]+)\.ts'\]|\['pnpm', 'exec', '(astro)'/g)].map(
    (match) => match[1] ?? match[2]!,
  );
  assert.ok(steps.length >= 4, `the wrapper declares only ${steps.length} steps`);
  assert.equal(
    steps.at(-1),
    'scan-residue',
    `the residue scan is not the last step of the build chain (${steps.join(' -> ')}), so a build ` +
      'could ship an unscanned dist/',
  );
  // And a failing step stops the chain, which is what `&&` used to buy.
  assert.match(
    wrapper,
    /if \(result\.status !== 0\) return/,
    'the wrapper does not stop on a failing step, so a later gate could measure a half-written dist/',
  );
  assert.ok(SCRIPTS['scan:residue'], 'package.json declares no `scan:residue` script');
});

test('a scan of nothing throws rather than reporting clean or reporting a finding', () => {
  // **Both wrong answers are refused, and they are different wrong answers.**
  // Returning `{findings: []}` says "I looked and it was clean" about a
  // directory that does not exist. Returning a *finding* — which is what this
  // did until now — says "I looked and found residue", so every caller that
  // counts findings, tests `length`, or filters by rule name treats an unbuilt
  // directory as a dirty one. Neither is true; nothing was scanned.
  //
  // **Mutation watched fail:** restoring the old branch in
  // `scripts/scan-residue.ts` — `report(...)` then
  // `return { findings, detailed, scannedCount: 0, rowCount: 0 }` — turns this
  // red on the throw assertion, and the message check below is what stops a
  // future version from throwing something that reads like residue.
  const root = mkdtempSync(join(tmpdir(), 'vacuity-'));
  try {
    const missing = join(root, 'never-built');

    // Caught once and asserted outside, rather than asserting inside a `catch`
    // — `tests/preview-server.test.ts:374` uses the same shape. The obvious
    // version puts `assert.fail('did not throw')` in the `try` and the
    // assertions in the `catch`, where the `catch` swallows its own
    // `AssertionError`: still red, but red saying "the private half does not
    // name the directory" when the real regression is that nothing threw.
    let thrown: (Error & { detail?: string }) | undefined;
    try {
      scanResidue(missing);
    } catch (error) {
      thrown = error as Error & { detail?: string };
    }

    assert.ok(thrown, 'scanning a missing directory did not throw');
    assert.match(thrown.message, /missing or unreadable/, 'the refusal does not say what was wrong');
    // The public half carries no host path: this reaches a workflow log on a
    // public repository, which is the disclosure this module exists to prevent.
    assert.doesNotMatch(
      thrown.message,
      /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/,
      `the public message names an absolute path: ${thrown.message}`,
    );
    // And the *detail* does carry it, or the report a maintainer reads cannot
    // say which directory was missing.
    assert.ok(
      thrown.detail?.includes(missing),
      'the private half does not name the directory, so the report cannot say which one',
    );

    // Non-vacuity: the same call against a directory that *does* exist returns
    // normally. Without this every assertion above passes on a `scanResidue`
    // that throws unconditionally.
    writeFileSync(join(root, 'index.html'), '<!doctype html><p>ordinary</p>', 'utf8');
    const clean = scanResidue(root);
    assert.deepEqual(clean.findings, [], 'a clean directory reported findings');
    assert.ok(clean.scannedCount > 0, 'the control scanned nothing, so it is not a control');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the residue scan reads the built site and finds nothing in it', () => {
  const { findings, scannedCount } = scanResidue();
  assert.deepEqual(findings, [], 'the residue scan found something in dist/');
  // Non-vacuity: a scan that read no files reports no findings, and the two are
  // indistinguishable from the outside.
  assert.ok(scannedCount > 0, 'the residue scan read no files, so its clean result proves nothing');
});

test('the third-party exclusion covers the bundle and nothing that merely looks like it', () => {
  // Pagefind's own bundle is excluded because it is third-party code containing
  // `javascript:void(0)` in its markup and `[[` inside compiled WebAssembly.
  // The exclusion must be anchored at the root of the built site: a published
  // note slugged `pagefind` builds to `dist/notes/pagefind/index.html`, and an
  // exclusion matching the word anywhere in the path would drop that page from
  // the scan. That is a false pass on a real published page, which is the one
  // failure mode this gate cannot have.
  const scratch = mkdtempSync(join(tmpdir(), 'tk14-thirdparty-'));
  try {
    // Shaped like a real built site, so the entry-point guard is satisfied and
    // the only finding left is the one under test.
    writeFileSync(join(scratch, 'index.html'), '<h1>home</h1>', 'utf8');
    mkdirSync(join(scratch, 'notes', 'pagefind'), { recursive: true });
    writeFileSync(join(scratch, 'notes', 'pagefind', 'index.html'), 'leaked msw/secret', 'utf8');
    mkdirSync(join(scratch, 'pagefind'), { recursive: true });
    writeFileSync(join(scratch, 'pagefind', 'pagefind-ui.js'), 'action:"javascript:void(0)"', 'utf8');

    const { findings } = scanResidue(scratch);
    assert.equal(findings.length, 1, `expected exactly the note's finding, got: ${findings.join('; ')}`);
    assert.match(findings[0]!, /notes.pagefind.index\.html/, 'a note slugged `pagefind` was excluded from the scan');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a documented wikilink publishes, and a stray one is still residue', () => {
  // The one rule that does not apply inside a code region, and both halves of
  // why. `[[` is not a privacy marker — it discloses nothing — it is a producer
  // self-check: TK-27 resolves every wikilink *node*, so a `[[` reaching output
  // from prose means the degradation failed. The artifact-level version of this
  // rule was deleted for the same reason, because a note documenting Obsidian
  // syntax is content and its fence renders as
  // `<code class="language-text">[[not a link]]</code>` — measured through the
  // shipped renderer, brackets intact and unescaped.
  //
  // Narrowing a rule is exactly where a coverage illusion gets in, so this
  // asserts three things rather than one: the exempt case passes, the
  // non-exempt case still fails, and **every other rule still fires inside a
  // code region**. A stripper that blanked too much would satisfy the first and
  // quietly break the other two.
  const scratch = mkdtempSync(join(tmpdir(), 'tk27-coderegion-'));
  try {
    const page = (body: string) => `<html><body>${body}</body></html>`;

    // Exempt: the two shapes this pipeline emits for authored code.
    for (const documented of [
      '<pre tabindex="0"><code class="language-text">[[not a link]]</code></pre>',
      '<p>See <code>[[inline]]</code> for the syntax.</p>',
    ]) {
      writeFileSync(join(scratch, 'index.html'), page(documented), 'utf8');
      assert.deepEqual(
        scanResidue(scratch).findings,
        [],
        `a documented wikilink in ${documented} was reported as residue, so a note about ` +
          'Obsidian syntax cannot publish',
      );
    }

    // Not exempt, and this is the half that keeps the rule worth having: a `[[`
    // in prose means the traversal failed to degrade a link, which is a
    // producer defect the user cannot see any other way.
    writeFileSync(join(scratch, 'index.html'), page('<p>A stray [[wikilink]] escaped.</p>'), 'utf8');
    assert.ok(
      scanResidue(scratch).findings.some((finding) => finding.includes('wikilink')),
      'a stray wikilink in prose was not reported, so the narrowed rule catches nothing',
    );

    // And the same page with both: the exemption must not swallow the prose
    // occurrence merely because a code region exists elsewhere in the file.
    writeFileSync(
      join(scratch, 'index.html'),
      page('<code>[[documented]]</code><p>and a stray [[one]] too</p>'),
      'utf8',
    );
    assert.ok(
      scanResidue(scratch).findings.some((finding) => finding.includes('wikilink')),
      'a stray wikilink went unreported because the same file also had a code region',
    );

    // **The exemption is the tag, and the reason it is safe is not that a body
    // cannot write the tag.** `sanitize-html` allows `code` as a raw tag, so a
    // note body *can* wrap its own prose in one — and requiring
    // `class="language-…"` to exclude that was tried and is measurably worse:
    // inline code renders as a bare `<code>[[syntax]]</code>` with no class, so
    // the stricter rule fails the build on ``Inline `[[syntax]]` here``, which
    // is exactly as legitimate as a fence.
    //
    // What makes the loose exemption safe is that a body cannot produce the
    // *marker*: the traversal parses every `[[…]]` in prose as a link node and
    // degrades it, so there is nothing for a self-claimed exemption to hide.
    // That property is asserted in `tests/link-traversal.test.ts`, over the
    // producer, which is where it lives — this file scans built output and
    // cannot see the producer. Named here so the two halves are findable from
    // each other.

    // **Every other rule still applies inside code.** An absolute path or a
    // `javascript:` URL in a fence is as much of a disclosure as one in a
    // paragraph — more, since a reader is likelier to copy it. This is the
    // assertion that a too-greedy stripper fails.
    for (const [planted, expected] of [
      ['<pre><code>built from C:\\Users\\someone\\vault</code></pre>', 'absolute local path'],
      ['<code>see msw/internal</code>', 'msw/'],
      ['<pre><code>/home/someone/vault/note.md</code></pre>', 'home-directory'],
    ] as const) {
      writeFileSync(join(scratch, 'index.html'), page(planted), 'utf8');
      assert.ok(
        scanResidue(scratch).findings.some((finding) =>
          finding.toLowerCase().includes(expected.toLowerCase()),
        ),
        `${expected} inside a code region was not reported: the exemption is too wide`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the residue scan fails on each marker it exists to catch', () => {
  // A gate that has never failed is not evidence. Each marker is planted in a
  // scratch directory shaped like `dist/` and the scan is required to name it.
  const scratch = mkdtempSync(join(tmpdir(), 'tk14-residue-'));
  try {
    for (const [planted, expected] of [
      ['see msw/internal for details', 'msw/'],
      ['an unresolved [[wikilink]]', 'wikilink'],
      ['built from C:\\Users\\someone\\vault', 'absolute local path'],
      ['built from /home/someone/vault/note.md', 'home-directory'],
      ['<a href="javascript:alert(1)">x</a>', 'javascript'],
      ['<a href="file:///etc/passwd">x</a>', 'file://'],
      ['//# sourceMappingURL=app.js.map', 'source map'],
      // The encoded forms. These are the cases the first version of this scan
      // missed: it matched raw bytes only, on the mistaken argument that the
      // content schema had already rejected them — which it cannot do for a
      // file copied verbatim out of `public/`, the very kind this scan exists
      // to read.
      ['<p>msw&#x2F;secret</p>', 'msw/'],
      // Without the trailing semicolon too. HTML5 treats that as a parse error
      // and decodes the character anyway, so this renders as the marker. The
      // scan required the semicolon until review caught that `decodeEntities`
      // in `src/lib/schema.ts` had always accepted it optional \u2014 the two
      // decoders differed by one character and this was the weaker one.
      ['<p>msw&#x2F secret</p>', 'msw/'],
      ['<p>msw\u200d/secret</p>', 'msw/'],
      ['<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', 'data:'],
    ] as const) {
      writeFileSync(join(scratch, 'index.html'), planted, 'utf8');
      const { findings } = scanResidue(scratch);
      assert.ok(
        findings.some((finding) => finding.toLowerCase().includes(expected.toLowerCase())),
        `the scan passed ${JSON.stringify(planted)}, or failed without naming ${expected}: ${findings.join('; ')}`,
      );
    }

    // Double encoding must NOT fire: `&amp;#x2F;` renders as the literal text
    // `&#x2F;` in a browser, so treating it as a marker would invent one the
    // reader never sees. This pins the decoder's depth at exactly one pass.
    writeFileSync(join(scratch, 'index.html'), '<p>msw&amp;#x2F;secret</p>', 'utf8');
    assert.deepEqual(
      scanResidue(scratch).findings,
      [],
      'a double-encoded entity was decoded twice and reported as a marker it never renders as',
    );

    // An unrecognised file kind must fail rather than ship unscanned. This is
    // the property that keeps the scan honest as the build grows: a future step
    // emitting a new format cannot quietly opt out of being read.
    rmSync(join(scratch, 'index.html'));
    writeFileSync(join(scratch, 'artifact.wasm'), 'msw/secret', 'utf8');
    const unclassified = scanResidue(scratch).findings;
    assert.ok(
      unclassified.some((finding) => finding.includes('unscanned')),
      `an undeclared file kind did not fail the scan: ${unclassified.join('; ')}`,
    );

    // And an empty artifact must fail rather than report a clean scan.
    rmSync(join(scratch, 'artifact.wasm'));
    assert.ok(
      scanResidue(scratch).findings.some((finding) => finding.includes('proved nothing')),
      'an empty dist/ passed the scan',
    );

    // A `dist/` with files but no entry point is a partial build, and a partial
    // build must not produce a clean scan. The count alone cannot see this: one
    // stray file satisfies it.
    mkdirSync(join(scratch, 'notes'), { recursive: true });
    writeFileSync(join(scratch, 'notes', 'index.html'), '<h1>a note</h1>', 'utf8');
    assert.ok(
      scanResidue(scratch).findings.some((finding) => finding.includes('index.html')),
      'a dist/ with no entry point passed the scan',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * A gate's own clock cannot beat the clock it delegates to.
 *
 * Three gates in this repository have shipped with an inner budget larger than
 * the outer one that contains it, and each was found the same way: as a red run
 * whose message named the wrong thing. `tests/math-and-diagrams.test.ts`'s
 * across-processes gate gave each of two children 120 s under a 90 s outer, so a
 * hung child reported as "the test was slow". `tests/preview-server.test.ts`'s
 * announce gate waited 25 s under a 40 s outer, which left no room for the
 * command it spawns to be slow *and* fail with its own message.
 *
 * The shape is mechanical, so this reads it as data. For every `test(...)` in
 * every test file, the outer budget is the trailing argument (or the global
 * `testTimeout` when absent); the inner budgets are the `timeout:` options and
 * `setTimeout(…, N)` bounds in its body. A test whose largest inner budget
 * meets or exceeds its outer one is the defect.
 *
 * **Not a sum, a maximum**, and that is a deliberate weakening: two sequential
 * children of 60 s each under a 100 s outer is a real hazard this will not
 * catch. Summing would demand knowing which inner waits are sequential and which
 * are alternatives on one path, which needs the control flow rather than the
 * text. The property asserted is the one that can be read honestly: no single
 * delegated wait may outlive the gate waiting on it.
 *
 * ### What it does not see, measured rather than assumed
 *
 * A budget routed through a module-level helper — `search.test.ts`'s `openSearch`
 * carries `{ timeout: 20_000 }`, `preview-server.test.ts`'s `fetchPath` carries
 * `{ timeout: 8000 }` — is outside every test body and is invisible here. That is
 * the repository's own idiom, so it is the largest gap and it is real today; the
 * six helpers involved all carry short budgets, so none is currently a defect.
 * Closing it needs a call graph rather than a window, which is a different tool.
 * `page.waitForTimeout(N)` is likewise unread.
 */
test('no gate budgets an inner wait longer than its own', () => {
  const GLOBAL_TEST_TIMEOUT = 90_000;
  // Recursive, because `vitest.config.ts` includes `tests/**/*.test.ts` and a
  // flat `readdirSync` missed `tests/support/css-cascade.test.ts` — one file of
  // 33, read by the suite and not by this gate.
  const files: string[] = [];
  const collect = (relative: string): void => {
    for (const entry of readdirSync(new URL(`tests/${relative}`, ROOT), { withFileTypes: true })) {
      if (entry.isDirectory()) collect(`${relative}${entry.name}/`);
      else if (entry.name.endsWith('.test.ts')) files.push(`${relative}${entry.name}`);
    }
  };
  collect('');
  assert.ok(files.length > 30, `only ${files.length} test files were found, so this gate read almost nothing`);

  const number = (token: string | undefined, constants: Map<string, number>): number | undefined => {
    if (token === undefined) return undefined;
    const bare = token.trim();
    if (/^[0-9_]+$/.test(bare)) return Number(bare.replaceAll('_', ''));
    return constants.get(bare);
  };

  const offenders: string[] = [];
  /** Counted per extractor, because a sum cannot tell one of them from both. */
  const examined = { option: 0, setTimeout: 0 };
  let parsed = 0;

  for (const file of files) {
    const lines = readFileSync(new URL(`tests/${file}`, ROOT), 'utf8').split('\n');
    // File-level `const NAME = 30_000;`, so a budget spelled as a named constant
    // is read rather than skipped. A budget this cannot resolve is skipped
    // rather than assumed, and the counts below are what keep that honest.
    const constants = new Map<string, number>();
    for (const line of lines) {
      const declared = /^const ([A-Z][A-Z0-9_]*) = ([0-9_]+);/.exec(line);
      if (declared) constants.set(declared[1]!, Number(declared[2]!.replaceAll('_', '')));
    }

    let open: { name: string; from: number; depth: number } | undefined;
    // Brace depth, not a column-zero close. The first version matched any `});`
    // at column 0, which fires inside a test body wherever a helper or an
    // `assert.rejects` callback closes there — measured, `adoption.test.ts` alone
    // truncated at nine such lines. Every truncation ended the window early, so
    // the *real* trailing budget was never read and the global was assumed
    // instead: an error whose direction is toward green.
    let depth = 0;
    for (const [index, line] of lines.entries()) {
      // Indented too: `content-contract.test.ts` has one inside a loop and
      // `adoption.test.ts` has a `describe` block, and an anchored `^test(`
      // dropped both.
      const opened = /^\s*test(?:\.\w+)?\(\s*(['"`])(.*?)\1/.exec(line);
      if (opened !== null && open === undefined) {
        open = { name: opened[2]!, from: index, depth };
      }
      // Counted after the open so the opening line's own `{` is included.
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (open === undefined || depth > open.depth) continue;

      const closed = /^\s*\}(?:,\s*([^)]+?)\s*)?\);?$/.exec(line);
      const outer = closed === null ? GLOBAL_TEST_TIMEOUT : (number(closed[1], constants) ?? GLOBAL_TEST_TIMEOUT);
      parsed += 1;
      const body = lines.slice(open.from, index).join('\n');
      // Comments carry measurements in milliseconds all over this repository —
      // "budgeted 120 s each", "`Test timed out in 300000ms`" — and a gate that
      // read those would measure the prose rather than the code. Verified
      // load-bearing: planting such a comment produces a false positive without
      // this and none with it.
      const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const inner: number[] = [];
      for (const found of code.matchAll(/\btimeout:\s*([A-Za-z0-9_]+)/g)) {
        const value = number(found[1], constants);
        if (value !== undefined) { inner.push(value); examined.option += 1; }
      }
      // `[^;]*?` rather than `[\s\S]*?`: the lazy any-character form crossed
      // statement boundaries, so a short `setTimeout(tick, 200)` followed later
      // in the body by any four-digit number in parentheses was reported as an
      // inner budget that no line declares. Measured — it fabricated one.
      // Braces cannot be excluded as well: the real case
      // (`preview-server.test.ts:702`) passes an arrow function as the callback,
      // so a brace-free form reads none of the two bounds in the suite.
      for (const found of code.matchAll(/\bsetTimeout\([^;]*?,\s*([0-9_]{4,})\s*\)/g)) {
        inner.push(Number(found[1]!.replaceAll('_', '')));
        examined.setTimeout += 1;
      }

      if (inner.length > 0) {
        const largest = Math.max(...inner);
        if (largest >= outer) {
          offenders.push(`${file} > ${open.name}: waits ${largest} ms inside a ${outer} ms budget`);
        }
      }
      open = undefined;
    }
  }

  // Non-vacuity, and it has to be **per extractor**. The first version asserted
  // one count over both, and measured, deleting the whole `setTimeout` half left
  // 17 of 19 — green. A planted regression that only that half could see was
  // then missed with the control still passing, which is exactly
  // `docs/gate-reading.md` case 4: a control that cannot distinguish an intact
  // instrument from a half-blinded one is measuring neither.
  //
  // Measured on the tree that wrote this: 33 files, 628 tests parsed, 33
  // `timeout:` options and 2 `setTimeout` bounds read. The thresholds sit below
  // those so a gate added tomorrow does not redden them, and far enough above
  // zero that a broken extractor cannot satisfy one.
  assert.ok(parsed > 500, `only ${parsed} tests were parsed at all, so the window never closed properly`);
  assert.ok(examined.option >= 20, `only ${examined.option} \`timeout:\` options were read`);
  assert.ok(examined.setTimeout >= 2, `only ${examined.setTimeout} \`setTimeout\` bounds were read`);
  assert.deepEqual(offenders, [], `a gate cannot fail with its own message:\n${offenders.join('\n')}`);
});

/**
 * The math residue exemption, and the limit it is scoped by.
 *
 * `scripts/scan-residue.ts` exempts `absolute local path` inside a
 * `code.language-math` region, because real TeX writes drive-letter-shaped
 * signatures — `f:\mathbb{R}` — by typesetting ordinary mathematics. Two
 * properties make that safe enough to ship, and neither had a gate: it was added
 * with `MATH_EXEMPT` and `withoutMathRegions` named by no test at all, which
 * review found before any run did.
 *
 * 1. **It is scoped to client math mode.** In build-time mode TeX renders to
 *    MathML and trips nothing, so the exemption protects nothing there. Keeping
 *    it active outside the only mode that needs it would be needless attack
 *    surface.
 * 2. **It never covers a code region that is not math.** A pasted shell
 *    transcript is the likeliest way a genuine host path reaches `dist/`, and
 *    widening `CODE_EXEMPT` instead would have taken it.
 */
test('the math residue exemption is scoped, and covers only math', () => {
  const source = readFileSync(new URL('scripts/scan-residue.ts', ROOT), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Scoped on the mode, so build-time mode carries no exemption at all.
  assert.match(
    code,
    /MATH_EXEMPT[^=]*=\s*\n?\s*MATH_MODE === 'client'/,
    'the math exemption is no longer scoped to client mode, where alone it is needed — ' +
      'its key is author-writable, so an unscoped version lets a note hide a real host path',
  );

  // And the rules it drops are only the ones TeX can spell by accident. A
  // `javascript:` URL or an `msw/` marker inside a math region is a disclosure
  // like any other.
  const members = /MATH_EXEMPT[^[]*\[([^\]]*)\]/.exec(code)?.[1] ?? '';
  assert.match(members, /'absolute local path'/, 'the exemption no longer covers the rule it exists for');
  for (const forbidden of ['javascript:', 'msw/', 'source map']) {
    assert.ok(!members.includes(forbidden), `the math exemption drops ${forbidden}, which TeX cannot spell by accident`);
  }

  // `CODE_EXEMPT` must not have grown the path rule, which is the wider fix that
  // was measured taking a real bash-fence path with it.
  const codeExempt = /CODE_EXEMPT[^[]*\[([^\]]*)\]/.exec(code)?.[1] ?? '';
  assert.ok(
    !codeExempt.includes('absolute local path'),
    'CODE_EXEMPT now exempts absolute paths in every code region — a pasted shell transcript ' +
      'carrying a real host path would stop being reported',
  );
});
