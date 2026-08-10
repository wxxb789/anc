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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * The gate a workflow step would be running, or `undefined` if the step is
 * setup rather than a gate.
 *
 * Two routes, because a gate can be restated in YAML two ways and an earlier
 * version of this caught only the first. Naming the gates literally — `test`,
 * `lint`, `check`, `build` — missed `pnpm exec vitest run` and `pnpm exec astro
 * check` entirely, which run the same gates while matching none of those words.
 * A gate that can be bypassed by spelling it differently is not a gate.
 *
 * So: any step invoking a script *this manifest declares* is a gate, which
 * needs no list and stays correct as scripts are added; and any step invoking
 * one of the underlying tools directly is a gate too, which covers the route
 * that goes around the manifest altogether.
 */
function gateInvokedBy(step: string): string | undefined {
  const script = /^pnpm\s+(?:run\s+)?([\w:-]+)/.exec(step)?.[1];
  if (script !== undefined && Object.hasOwn(SCRIPTS, script)) return script;
  return /\b(?:vitest|oxlint|astro|pagefind)\b|\bnode\s+scripts\//.test(step) ? step : undefined;
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
  assert.match(
    build,
    /pnpm run scan:residue\s*$/,
    'the residue scan is not the last link of `build`, so a build could ship an unscanned dist/',
  );
  assert.match(build, /&&\s*pnpm run scan:residue/, 'the residue scan is not chained with `&&`, so it cannot block');
  assert.ok(SCRIPTS['scan:residue'], 'package.json declares no `scan:residue` script');
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
