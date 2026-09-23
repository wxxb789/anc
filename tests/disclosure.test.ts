/**
 * The disclosure gates: what a build may say, and where it may write what it
 * may not say.
 *
 * TK-25's premise is that this tool runs in somebody else's notes repository,
 * under a GitHub Action whose log is world-readable and retained for 90 days.
 * Two things follow, and they are the two clauses these gates hold:
 *
 * 1. **No host filesystem path on a stream.** Measured before this ticket, all
 *    three success-path lines carried one.
 * 2. **No name of a file the build did not publish.** For a note a user
 *    withheld, the leaf *is* the disclosure — `clients/acme/2026-renewal.md` and
 *    `2026-renewal.md` disclose the same fact.
 *
 * ## The oracle is a differential, not a rule table
 *
 * `scanResidue` is deliberately **not** the gate here, for four measured
 * reasons. It is blind to the rule's whole subject: fed a line naming a
 * repo-relative path, a basename, a stem, or a slug, it comes back clean,
 * because its rule table has no rule for any of them. It is platform-dependent
 * for the absolute paths it *does* catch — `/tmp/x/notes` and
 * `/github/workspace` are clean, and CI is `ubuntu-latest` while every scratch
 * fixture in this tree is under `tmpdir()`. It is red on correct output, since
 * an ambiguity diagnostic quoting a `[[link]]` trips its wikilink rule. And
 * `RESIDUE_RULES` is module-private.
 *
 * So the oracle is two corpora that differ only in names, and byte-equality of
 * the streams between them. One property subsumes the whole rule — output that
 * varies with a name discloses a name — and it needs no token list, catching
 * slugs, stems, and the opaque join key a later reviewer will propose.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { SEEDED_ENTRIES, SEEDED_HEADER, ensureIgnored } from '../scripts/seed-gitignore.ts';
import { openReport } from '../scripts/write-report.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'anc.mjs');

/**
 * Run the packaged binary the way a user does, and return what a log would
 * carry.
 *
 * Shaped after `tests/deployment.test.ts:289-293`: spawn, and concatenate the
 * two streams into one string, because under the Action of the plan's §5.1 they
 * *are* one surface. No test in this tree spawned this binary before — the
 * packaging gate reads it as text — so this is a new shape here.
 */
function build(cwd: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [BINARY, 'build', ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** A scratch directory removed when the callback returns, however it returns. */
function scratch<T>(prefix: string, body: (directory: string) => T): T | undefined {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** {@link scratch}'s signature, for a block whose subject this platform lacks. */
function skipScratch<T>(_prefix: string, _body: (directory: string) => T): T | undefined {
  return undefined;
}

/** `git`, with the ambient ignore chain neutralised where a gate needs it. */
function git(cwd: string, ...args: string[]): { status: number; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout };
}

/**
 * The ignore chain, off.
 *
 * `git add` consults `.gitignore`, `.git/info/exclude`, `core.excludesFile`, and
 * the XDG default `~/.config/git/ignore` — and measured, this machine has one
 * configured. A gate run on such a host is **green with the destination
 * mutated**, because a global rule for `content-report.json` hides a report
 * sitting in the worktree. Neutralising it is what makes the discrimination
 * real; `.git/info/exclude` holds only comments in a fresh `git init`, so a
 * scratch repository is clean there by construction.
 */
function nakedGit(cwd: string, ...args: string[]): { status: number; stdout: string } {
  const result = spawnSync('git', ['-c', 'core.excludesFile=', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  return { status: result.status ?? 1, stdout: result.stdout };
}

/** Where this invocation's report is, asked of git exactly as the writer asks. */
function reportPath(cwd: string): string {
  const answer = git(cwd, 'rev-parse', '--git-path', 'publish-report/content-report.json');
  assert.equal(answer.status, 0, 'git could not resolve the report path');
  return resolve(cwd, answer.stdout.trim().split('\n').at(-1)!);
}

function readReport(cwd: string): {
  version: number;
  generator: string;
  status: string;
  counts: { discovered: number; published: number; dropped: number };
  dropped: { path: string; reason: string; collidedWith?: string }[];
  failure: { code: string; detail: string } | null;
} {
  return JSON.parse(readFileSync(reportPath(cwd), 'utf8')) as never;
}

/** Every file under `directory`, descending into dotted directories too. */
function walk(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/**
 * One corpus of the differential pair.
 *
 * `token` is the distinctive string the pair differs by, and it appears **only**
 * in the content directory's name. The note filenames are held constant on
 * purpose: a published slug is a route this build was about to serve, so a gate
 * forbidding one would be wrong on the design and would also cost
 * `tests/content-contract.test.ts:163`, which pins an `entries[0] (slug
 * "first-note")` message. Varying only the directory measures host paths without
 * charging an existing test.
 */
function corpus(root: string, token: string, body: string, notes = 1): string {
  const content = join(root, `${token}dir`);
  mkdirSync(content, { recursive: true });
  for (let index = 0; index < notes; index += 1) {
    writeFileSync(join(content, `note-${index}.md`), `# Note ${index}\n\n${body}\n`, 'utf8');
  }
  return content;
}

/**
 * The three fixture bodies, named by what they plant rather than by rule class.
 *
 * That distinction is measured, not pedantic: the obvious "plant an absolute
 * path" fixture trips the content contract twice and the residue scan never.
 * `STRUCTURAL_MARKERS` in `src/lib/schema.ts` carries the drive-letter rule and
 * kills the note before the build runs, while it carries no home-directory rule
 * and `scripts/scan-residue.ts` does. So `C:\…` dies at the contract with the
 * residue scan never reached, and `/home/…/` builds all the way through and
 * fails at residue with five findings.
 */
const BODIES = {
  clean: 'Ordinary prose, with nothing planted in it at all.',
  contract: (token: string): string => `Exported from C:\\${token}planted\\x.md today.`,
  residue: (token: string): string => `Exported from /home/${token}planted/ today.`,
} as const;

test('the streams carry no name that changes when the corpus is renamed', () => {
  scratch('tk25-g1-', (root) => {
    // Both corpora sit in the same scratch root, under differently-named
    // content directories, and each build is invoked from that root with
    // byte-identical relative arguments.
    //
    // Each run's directory is a git repository, and that is load-bearing twice
    // over. The pointer line has two spellings — one for a repository and one
    // for the fallback — so a fixture with no repository would assert the wrong
    // half of it. And the branch between them is decided by the presence of a
    // git directory, which is not a property of any note's name, so both corpora
    // must be in the same git state or the differential measures that instead.
    const runs = (token: string): Record<string, { status: number | null; output: string }> => {
      const directory = join(root, token);
      mkdirSync(directory, { recursive: true });
      const results: Record<string, { status: number | null; output: string }> = {};
      for (const [name, body] of [
        ['a', BODIES.clean],
        ['b', BODIES.contract(token)],
        ['c', BODIES.residue(token)],
      ] as const) {
        const here = join(directory, name);
        mkdirSync(here, { recursive: true });
        git(here, 'init', '-q', '.');
        corpus(here, token, body);
        results[name] = build(here, '--content', `${token}dir`, '--out', 'out');
      }
      return results;
    };

    const alpha = runs('zzqalpha');
    const beta = runs('qqbeta');

    // Non-vacuity 1 — determinism. Without it the A/B difference measures
    // run-to-run noise rather than disclosure. This half is what caught the
    // `mkdtemp` suffix in `residue scan: N findings in <workspace>`, which
    // differed between two runs of the *same* corpus.
    const alphaAgain = runs('zzqalpha');
    for (const run of ['a', 'b', 'c'] as const) {
      assert.equal(
        alphaAgain[run]!.output,
        alpha[run]!.output,
        `run (${run}) is not deterministic, so any A/B difference below measures noise:\n` +
          `${alpha[run]!.output}\n---\n${alphaAgain[run]!.output}`,
      );
    }

    // The gate itself.
    for (const run of ['a', 'b', 'c'] as const) {
      assert.equal(
        beta[run]!.output,
        alpha[run]!.output,
        `run (${run})'s output changes with the corpus name, so it discloses one:\n` +
          `${alpha[run]!.output}\n---\n${beta[run]!.output}`,
      );
    }

    // The three runs must take three different paths, or a fixture that trips
    // one rule twice would satisfy the equality above while measuring less than
    // it claims.
    assert.equal(alpha['a']!.status, 0, `run (a) did not build cleanly:\n${alpha['a']!.output}`);
    assert.equal(alpha['b']!.status, 1, `run (b) did not fail:\n${alpha['b']!.output}`);
    assert.equal(alpha['c']!.status, 1, `run (c) did not fail:\n${alpha['c']!.output}`);
    assert.match(alpha['b']!.output, /content contract violation/, 'run (b) did not fail at the contract');
    assert.match(
      alpha['c']!.output,
      /absolute home-directory path/,
      'run (c) did not fail at the residue scan — it may be tripping the contract instead, ' +
        'which would make (b) and (c) the same test',
    );

    // Non-vacuity 2 — sensitivity. A comparison that passes on a build which
    // printed nothing is not a comparison.
    scratch('tk25-g1s-', (other) => {
      git(other, 'init', '-q', '.');
      const content = corpus(other, 'zzqalpha', BODIES.clean, 2);
      const two = build(other, '--content', relative(other, content), '--out', 'out');
      assert.notEqual(
        two.output,
        alpha['a']!.output,
        'a corpus with a different note count produced identical output, so this differential ' +
          'cannot see a difference at all',
      );
    });

    // Non-vacuity 3 — both required lines, on the clean run. Run (a) dropped
    // nothing, which is precisely the run a conditional pointer line would
    // leave silent, so asserting it here is what makes "unconditional" a
    // property rather than a preference.
    assert.match(
      alpha['a']!.output,
      /report: cat "\$\(git rev-parse --git-path publish-report\/content-report\.json\)"/,
      'a clean build did not print the report pointer',
    );
    const counts = /content: (\d+) discovered, (\d+) published, (\d+) dropped/.exec(alpha['a']!.output);
    assert.ok(counts, `a clean build did not print the counts line:\n${alpha['a']!.output}`);
    assert.ok(Number(counts[2]) > 0, 'the clean build published nothing, so the counts prove nothing');
  });
  // **Ten CLI builds**, not the six this gate is usually described as buying:
  // `runs()` builds three, and it is called three times — alpha, beta, and alpha
  // again for the determinism half — plus the two-note sensitivity control. Each
  // is followed by a scan of every file in its `dist/` with the gzipped members
  // inflated.
  //
  // The budget is a sum over measured parts rather than a round number. Timed
  // individually on an idle host: run (a), a clean build, 20.3 s; run (b), which
  // dies at the content contract before Astro starts, 1.0 s; run (c), which
  // builds through and fails at the residue scan, 20.4 s. So seven of the ten
  // are full-length and three are nearly free. Three triples plus the control
  // predicts 146 s; the gate measured 154 s alone, so nothing else in it is
  // material.
  //
  // Under the suite's own contention the same build measured p50 29.1-35.5 s
  // against 20.4 s idle — **1.4x to 1.7x**, and the tail worse: one build in
  // eight took 51.6 s, 2.5x. Applied to a 146 s floor that is 219-365 s, which
  // is why the 300 s this used to carry was not a margin. It was observed at
  // 250 s, then at a timeout: `Test timed out in 300000ms`, on a run with no
  // external load at all.
  //
  // 600 s is 4x the idle cost and ~1.6x the worst contended projection. Four
  // times measured cost is what a gate buying seven full *processes* needs,
  // because each carries the whole contended spread independently and they
  // compound rather than average. A genuinely hung build still fails inside ten
  // minutes.
}, 600_000);

test('a rejected argument is never echoed, whatever shape it has', () => {
  // The rule §2.3 states: any argv token that is not byte-equal to a spelling
  // this tool's own table declares may not be printed. An unrecognised token is
  // by definition not one of those, so there is nothing left that may be
  // printed — and "the user typed it" is not a safety argument, because the user
  // typed their withheld filenames too.
  //
  // A shape test was the first implementation and it was wrong on measurement,
  // which is why this gate names the tokens it does: `/^--?[A-Za-z][A-Za-z0-9-]*$/`
  // matches `--zzq-layoff-list`, and `/^[a-z][a-z0-9-]*$/` matches
  // `deploy-to-zzq-clients` — both of which are a withheld note's stem in
  // flag's clothing, and both were echoed by a guard whose comment cited that
  // exact leak as the reason it existed.
  scratch('tk25-argv-', (root) => {
    git(root, 'init', '-q', '.');

    // Both positions, because they are two different code paths and an earlier
    // version of this gate exercised only the first. `main` rejects an unknown
    // *command* before `parseArguments` ever runs, so passing a flag-shaped
    // token as `argv[0]` tests the command branch twice and the option branch
    // never — and the option branch is where the shape test actually lived.
    for (const [argv, what] of [
      [['zzqclients/acme/2026-renewal'], 'a path in the command position'],
      [['deploy-to-zzq-clients'], 'a stem in the command position'],
      [['build', '--zzq-layoff-list'], 'a stem wearing two dashes, which the shape test admitted'],
      [['build', 'zzqclients/acme/2026-renewal'], 'a path where a flag was expected'],
      [['build', '--zzqoutdir'], 'the ordinary typo the refusal exists for'],
      [['build', '--content'], 'a flag whose value is missing'],
    ] as const) {
      const result = spawnSync(process.execPath, [BINARY, ...argv], { cwd: root, encoding: 'utf8' });
      const output = `${result.stdout}${result.stderr}`;
      assert.notEqual(result.status, 0, `${what} was accepted: ${argv.join(' ')}`);
      assert.ok(!output.includes('zzq'), `the rejection of ${what} echoed it back:\n${output}`);
      // Non-vacuity: the refusal has to actually say something, or an empty
      // stream would satisfy the absence above.
      assert.match(output, /unrecognised|needs a directory/, `${what} produced no refusal`);
      assert.ok(output.includes('--content'), `${what}'s refusal did not print the usage text`);
    }
  });
}, 120_000);

test('the per-reason drop counts on the stream do not change when the dropped files are renamed', () => {
  // The counts line names each drop reason with a count. Reasons are literals of
  // the closed `DropReason` set and counts are integers, so renaming every
  // dropped file, and the colliding pair, must leave the line byte-identical.
  scratch('tk25-reasons-', (root) => {
    const outputOf = (token: string): string => {
      const here = join(root, token);
      const content = join(here, 'notes');
      mkdirSync(content, { recursive: true });
      writeFileSync(join(content, 'alpha.md'), '# Alpha\n\nprose.\n', 'utf8');
      writeFileSync(join(content, `${token}-plan.md`), '---\npublish: false\n---\n\n# Held\n', 'utf8');
      writeFileSync(join(content, `${token.toUpperCase()}__X.md`), '# Winner\n', 'utf8');
      writeFileSync(join(content, `${token} X.md`), '# Loser\n', 'utf8');
      writeFileSync(join(content, `${token}-terms.pdf`), 'not markdown\n', 'utf8');
      git(here, 'init', '-q', '.');
      const run = build(here, '--content', 'notes', '--out', 'out');
      assert.equal(run.status, 0, `the ${token} fixture did not build:\n${run.output}`);
      return run.output;
    };
    const alpha = outputOf('zzqalpha');
    const beta = outputOf('qqbeta');
    // Non-vacuity: the reasons are on the line this gate compares.
    assert.match(
      alpha,
      /content: 5 discovered, 2 published, 3 dropped \(1 excluded-by-frontmatter, 1 not-markdown, 1 slug-collision\)/,
      alpha,
    );
    assert.equal(beta, alpha, `renaming the dropped files changed the stream:\n${alpha}\n---\n${beta}`);
    assert.ok(!alpha.includes('zzq') && !beta.includes('qqbeta'), 'a dropped file was named on the stream');
  });
}, 180_000);

test('a dropped file is named in the report and nowhere else', () => {
  scratch('tk25-g2-', (root) => {
    const content = join(root, 'notes');
    mkdirSync(content, { recursive: true });

    // The collision direction is measured, not assumed. `buildArtifact` sorts
    // the listing and keeps the **first** file to claim a slug, so the winner is
    // whichever name sorts first — and `['ZZQ__LAYOFF.md', 'Zzq Layoff.md',
    // '___.md', 'alpha.md', 'zzq-terms.pdf']` is the measured order. A fixture
    // built on the intuitive reading asserts the report names a file that was
    // *published*, which is a vacuous gate.
    writeFileSync(join(content, 'alpha.md'), '# Alpha\n\nprose.\n', 'utf8');
    writeFileSync(join(content, 'ZZQ__LAYOFF.md'), '# Winner\n\nprose.\n', 'utf8');
    writeFileSync(join(content, 'Zzq Layoff.md'), '# Loser\n\nprose.\n', 'utf8');
    writeFileSync(join(content, '___.md'), '# Nameless\n\nprose.\n', 'utf8');
    writeFileSync(join(content, 'zzq-terms.pdf'), 'not markdown\n', 'utf8');

    git(root, 'init', '-q', '.');
    const run = build(root, '--content', 'notes', '--out', 'out');
    assert.equal(run.status, 0, `the fixture did not build:\n${run.output}`);

    // Present half. This is the half with a real mutation, and it is what proves
    // the absence half below is measuring something rather than passing because
    // nothing in the tree computes a dropped set at all.
    const report = readReport(root);
    assert.equal(report.status, 'complete');
    // `___.md` publishes under a hash slug now (it was an `empty-slug` drop),
    // and its filename still reaches nothing public: the slug is a digest.
    assert.deepEqual(report.counts, { discovered: 5, published: 3, dropped: 2 });
    assert.equal(
      report.counts.discovered,
      report.counts.published + report.counts.dropped,
      'the three counts do not add up, so they are three independent numbers rather than a partition',
    );
    assert.deepEqual(report.dropped, [
      { path: 'Zzq Layoff.md', reason: 'slug-collision', collidedWith: 'ZZQ__LAYOFF.md' },
      { path: 'zzq-terms.pdf', reason: 'not-markdown' },
    ]);
    // The stream carries the reasons as counts, never the names.
    assert.match(
      run.output,
      /content: 5 discovered, 3 published, 2 dropped \(1 not-markdown, 1 slug-collision\)/,
      run.output,
    );

    // Absence half. The loser's spelling, not the substring `zzq`: the published
    // slug `zzq-layoff` legitimately appears throughout `dist/`, and asserting
    // on the shared prefix would be red on correct output.
    const distFiles = walk(join(root, 'out'));
    /**
     * Whether one built file carries a string, **inflating where the bytes are
     * gzip.**
     *
     * The Pagefind index under `dist/pagefind/` is compressed, so a UTF-8 read
     * of it matches nothing whatever it contains — measured, a published note's
     * own words are absent from a `.pf_fragment` read as text and present after
     * `gunzipSync`. A dropped file's name reaching the search index is exactly
     * the disclosure this gate refuses, and it was the one surface the gate
     * could not read.
     *
     * One function rather than two copies of the rule, so the non-vacuity
     * control below exercises the same code path the assertions do. Written
     * inline first, the control called `gunzipSync` itself and stayed green
     * when the search path stopped inflating — a control that reimplements what
     * it is controlling for measures its own copy.
     */
    const carries = (file: string, needle: string): boolean => {
      if (statSync(file).size > 4_000_000) return false;
      try {
        const bytes = readFileSync(file);
        if (bytes.toString('utf8').includes(needle)) return true;
        if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return false;
        return gunzipSync(bytes).toString('utf8').includes(needle);
      } catch {
        return false;
      }
    };
    for (const needle of ['Zzq Layoff', '___.md', 'zzq-terms']) {
      assert.ok(
        !run.output.includes(needle),
        `the streams name a dropped file (${needle}):\n${run.output}`,
      );
      const leaked = distFiles.filter((file) => carries(file, needle));
      assert.deepEqual(
        leaked.map((file) => relative(root, file)),
        [],
        `a dropped file's name (${needle}) reached the built site`,
      );
    }

    // And the winner's slug *is* in `dist/`, which is correct and is what makes
    // the absence assertions above discriminating rather than trivially true.
    assert.ok(
      distFiles.some((file) => relative(root, file).includes('zzq-layoff')),
      'the winning slug never reached dist/, so the absence assertions above prove nothing',
    );

    // **And the inflate reads a surface a UTF-8 read cannot**, or adding it
    // proved nothing: a scan that never decompresses returns the same empty
    // list as one that always does, so the absence assertions cannot tell a
    // working gate from a blind one.
    //
    // A positive control rather than a planted needle, because no token lands
    // *only* in a gzipped member — Pagefind indexes a published body, and that
    // body is in the note's own HTML too. What is provable is that inflating
    // recovers text the raw bytes of that same file do not contain.
    assert.ok(
      distFiles.some(
        (file) => !readFileSync(file, 'utf8').includes('zzq-layoff') && carries(file, 'zzq-layoff'),
      ),
      'no file answered for the published slug only after inflating, so this gate is not ' +
        'reading the search index and a dropped name could sit in it undetected',
    );
  });
}, 120_000);

test('the report survives the failure it describes', () => {
  // The write ordering read from its observable end. A report written where the
  // counts are convenient — after validation — cannot exist on the run that
  // failed validation, and validation is the likeliest throw in the binary.
  scratch('tk25-g3-', (root) => {
    git(root, 'init', '-q', '.');

    // The stub, asserted at the one moment it is the whole report: `openReport`
    // has returned and nothing else has happened yet.
    //
    // This is asserted **in-process rather than through a build**, and that is
    // not a shortcut — it is the only place the property is visible. Measured:
    // deleting the stub write entirely leaves every end-to-end assertion in this
    // test green, because `failed()` flushes too, so a run that aborts still
    // ends with a file on disk. The window the stub protects is the one a
    // SIGINT or a CI timeout lands in, where no `catch` and no `finally` runs at
    // all — and that window has no end-to-end observer by construction.
    const stubbed = openReport(root);
    const stub = readReport(root);
    assert.equal(stub.status, 'aborted', 'the report is not written until something has happened');
    assert.deepEqual(stub.counts, { discovered: 0, published: 0, dropped: 0 });
    assert.deepEqual(stub.dropped, []);
    assert.equal(stub.failure, null);
    assert.equal(stub.version, 1);
    assert.ok(stub.generator, 'the report does not name the tool that wrote it');
    assert.match(
      stubbed.pointer,
      /^report: cat "\$\(git rev-parse/,
      'the pointer in a git repository is not the command form',
    );

    const content = corpus(root, 'zzq', BODIES.contract('zzq'));
    const failed = build(root, '--content', relative(root, content), '--out', 'out');
    assert.equal(failed.status, 1, `the contract fixture did not fail:\n${failed.output}`);

    const afterFailure = readReport(root);
    assert.equal(afterFailure.status, 'complete', 'discovery finished, so the report must say so');
    assert.equal(afterFailure.counts.discovered, 1);
    assert.ok(afterFailure.failure, 'the failing run left no failure in the report');
    assert.equal(afterFailure.failure.code, 'content-contract-violation');

    // The state that distinguishes "nothing to report" from "I stopped before I
    // could look". `--content` at a file makes `readdir` throw mid-discovery,
    // which is the shape of every abort.
    const file = join(root, 'a-file.md');
    writeFileSync(file, '# x\n', 'utf8');
    const aborted = build(root, '--content', 'a-file.md', '--out', 'out');
    assert.equal(aborted.status, 1);
    const partial = readReport(root);
    assert.equal(partial.status, 'aborted', 'a run that never finished discovery claims a complete report');
    assert.deepEqual(partial.counts, { discovered: 0, published: 0, dropped: 0 });
    assert.ok(partial.failure, 'the aborted run left no failure in the report');
    // The message that reaches stderr on that path is `ENOTDIR: not a
    // directory, scandir '<path>'` — a string nobody in this project composed,
    // with the path already inside it.
    assert.ok(
      !aborted.output.includes(root),
      `the abort path printed a host path:\n${aborted.output}`,
    );

    // And the successful run leaves `failure: null` at the same path.
    const clean = corpus(root, 'ok', BODIES.clean);
    const built = build(root, '--content', relative(root, clean), '--out', 'out');
    assert.equal(built.status, 0, `the clean fixture did not build:\n${built.output}`);
    assert.equal(readReport(root).failure, null, 'a successful build recorded a failure');

    // The corpus where *everything* was dropped, which is the one the report
    // exists for and the one an implementation most easily gets backwards. The
    // build fails — there is nothing to publish — but discovery *finished*, so
    // the report must name the three files rather than report three zeroes under
    // `aborted`. Ordering it the convenient way, with the empty-corpus refusal
    // inside discovery, produced exactly that: the run with the most to say said
    // nothing.
    const barren = join(root, 'barren');
    mkdirSync(barren, { recursive: true });
    writeFileSync(join(barren, 'zzq-terms.pdf'), 'not markdown\n', 'utf8');
    // A withheld note rather than `___.md`, which now publishes under a hash slug.
    writeFileSync(join(barren, 'zzq-plan.md'), '---\npublish: false\n---\n\n# Nameless\n', 'utf8');
    const empty = build(root, '--content', 'barren', '--out', 'out');
    assert.equal(empty.status, 1, `a corpus with no publishable note did not fail:\n${empty.output}`);

    const nothing = readReport(root);
    assert.equal(
      nothing.status,
      'complete',
      'every file was dropped and discovery finished, so the report must say complete',
    );
    assert.deepEqual(nothing.counts, { discovered: 2, published: 0, dropped: 2 });
    assert.deepEqual(
      nothing.dropped.map((row) => row.reason).sort(),
      ['excluded-by-frontmatter', 'not-markdown'],
      'the report does not say why the corpus produced nothing',
    );
    assert.equal(nothing.failure?.code, 'no-markdown-found');
    assert.ok(!empty.output.includes('zzq'), `the refusal named a dropped file:\n${empty.output}`);
  });
}, 120_000);

test('`git add -A` stages nothing of the report, in a repository with no .gitignore', () => {
  // No `.gitignore` is the point: the destination's guarantee is structural, so
  // the gate must demonstrate it without any ignore rule doing the work.
  scratch('tk25-g4-', (root) => {
    nakedGit(root, 'init', '-q', '.');
    const content = corpus(root, 'zzq', BODIES.clean);
    const run = build(root, '--content', relative(root, content), '--out', 'out');
    assert.equal(run.status, 0, `the fixture did not build:\n${run.output}`);

    // Non-vacuity: the report is on disk at this moment, at the path git itself
    // resolves, and it is non-empty JSON.
    const report = reportPath(root);
    assert.ok(existsSync(report), 'no report exists, so the absence below is trivial');
    assert.equal(readReport(root).version, 1);

    nakedGit(root, 'add', '-A');
    const staged = nakedGit(root, 'diff', '--cached', '--name-only').stdout.split('\n').filter(Boolean);

    // On the first segment and the basename, not on the exact staged set: this
    // repository is deliberately unseeded, so `dist/` is staged too — measured,
    // 40 paths of which 38 are under the output directory. A gate red on its
    // first run is a gate disabled in week one.
    for (const path of staged) {
      assert.notEqual(path.split('/').at(-1), 'content-report.json', `the report was staged as ${path}`);
      assert.notEqual(path.split('/')[0], '.git', `a path under the git directory was staged: ${path}`);
    }
    assert.ok(staged.length > 0, 'nothing at all was staged, so this gate measured an empty repository');
  });
}, 120_000);

test('exactly one report exists anywhere under the invocation directory', () => {
  // Verified by walking the filesystem rather than by asking git. A
  // `git status --porcelain` form sees nothing at the git-directory path at all,
  // so it cannot tell the specified design from one that wrote no report — and a
  // "convenience copy" that wrote to both a git-directory path and a worktree
  // path passes every git-shaped assertion once any ignore rule covers the
  // second.
  scratch('tk25-g5-', (root) => {
    git(root, 'init', '-q', '.');
    const content = join(root, 'elsewhere', 'notes');
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, 'n.md'), '# N\n\nprose.\n', 'utf8');

    const run = build(root, '--content', 'elsewhere/notes', '--out', 'elsewhere/out');
    assert.equal(run.status, 0, `the fixture did not build:\n${run.output}`);

    // Non-vacuity: `--content` was accepted and produced a site, so the pinning
    // below is not satisfied by a run that did nothing.
    assert.ok(existsSync(join(root, 'elsewhere', 'out', 'index.html')), 'no site was built');

    // The walk must descend into `.git/`, which is the one thing this
    // destination forces on it: a walk skipping dotted directories — the default
    // of most helpers — finds zero reports and passes vacuously.
    const found = walk(root).filter((file) => file.endsWith(`${sep}content-report.json`));
    assert.deepEqual(
      found.map((file) => relative(root, file)),
      [relative(root, reportPath(root))],
      'exactly one report must exist, at the path git resolves',
    );
    assert.ok(readFileSync(found[0]!, 'utf8').length > 0, 'the report at the pinned path is empty');

    // And none in the three places it must never be.
    for (const forbidden of ['elsewhere/notes', 'elsewhere/out']) {
      assert.deepEqual(
        walk(join(root, forbidden)).filter((file) => file.endsWith('content-report.json')),
        [],
        `a report was written under ${forbidden}`,
      );
    }
    // The per-run workspace, which is where the plan's own text still says the
    // report should go — and where it would be destroyed by the build's `finally`
    // before anyone could read it, which is silent data loss rather than a leak.
    //
    // Asserted against the one report the walk found, rather than by looking
    // inside whatever workspace survived: the build removes its workspace on
    // success, so a loop over the survivors runs zero times on a green run and
    // would pass whatever the writer did. The walk above has already proven
    // exactly one report exists; these two lines pin *where* it is from the
    // other direction.
    const reports = walk(root).filter((file) => file.endsWith(`${sep}content-report.json`));
    assert.equal(reports.length, 1, 'the count assertion above is what this depends on');
    assert.ok(
      !reports[0]!.includes('.anc-build-'),
      'the report was written into the per-run staging workspace, which the build deletes',
    );
    assert.ok(
      reports[0]!.startsWith(join(root, '.git')),
      `the one report is not under the git directory: ${relative(root, reports[0]!)}`,
    );
  });
}, 120_000);

test('ensureIgnored seeds what a stranger\'s repository needs', () => {
  // Every probe here runs with the ambient chain neutralised, and only here: a
  // gate probing the naked `check-ignore` is green on any machine or CI image
  // carrying a global rule for `dist/`, **with the seeded line deleted**. In
  // `ensureIgnored` itself the chain is correct — a user with a global rule must
  // not be forced to commit anything — so this is a gate-only argument.
  const ignored = (root: string, path: string): boolean =>
    nakedGit(root, 'check-ignore', '-q', '--', path).status === 0;

  // 1. Behavioural, both halves, against the packaged binary.
  scratch('tk25-g7-', (root) => {
    nakedGit(root, 'init', '-q', '.');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'alpha.md'), '# Alpha\n\nprose.\n', 'utf8');

    ensureIgnored(root);

    // The producer is non-recursive, so a bare `build` at the root of this
    // fixture exits 1 with `no Markdown found`.
    const run = build(root, '--content', 'notes', '--out', 'dist');
    assert.equal(run.status, 0, `the fixture did not build:\n${run.output}`);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'x'), 'x', 'utf8');

    // Non-vacuity: both things the seed exists to hide are on disk right now.
    assert.ok(walk(join(root, 'dist')).length > 10, 'the build produced almost nothing to ignore');
    assert.ok(existsSync(join(root, 'node_modules', 'x')), 'node_modules/x does not exist');

    nakedGit(root, 'add', '-A');
    assert.deepEqual(
      nakedGit(root, 'ls-files').stdout.split('\n').filter(Boolean).sort(),
      ['.gitignore', 'notes/alpha.md'],
      'the seeded block did not keep the generated artifact out of the index',
    );

    // The anchoring, which is the silent-data-loss direction: with the bare
    // pattern `dist` a user's own note at `notes/dist/i.md` is ignored.
    mkdirSync(join(root, 'notes', 'dist'), { recursive: true });
    writeFileSync(join(root, 'notes', 'dist', 'i.md'), '# I\n', 'utf8');
    assert.ok(
      !ignored(root, 'notes/dist/i.md'),
      'a note inside a directory the user named `dist` is ignored, so the seeded pattern is not ' +
        'root-anchored and the tool silently drops the user\'s own notes',
    );
  });

  // 2. The four states of the probe, one scratch repository each, asserting the
  // *action* rather than the exit code.
  const gitignore = (root: string): string => readFileSync(join(root, '.gitignore'), 'utf8');

  scratch('tk25-g7-covered-', (root) => {
    nakedGit(root, 'init', '-q', '.');
    writeFileSync(join(root, '.gitignore'), '/dist/\n', 'utf8');
    const { outcomes } = ensureIgnored(root);
    assert.equal(outcomes[0]!.state, 'covered');
    assert.equal(outcomes[1]!.state, 'seeded');
    // Byte-identity on the `dist/` line: an implementation that skipped the
    // probe and always appended grows a duplicate.
    assert.equal(
      gitignore(root).match(/dist/g)?.length,
      1,
      'the covered entry was written again, so the probe is not deciding anything',
    );
    assert.match(gitignore(root), /^\/dist\/\n/, 'the existing rule was not left first');
  });

  scratch('tk25-g7-negated-', (root) => {
    nakedGit(root, 'init', '-q', '.');
    writeFileSync(join(root, '.gitignore'), '!dist/\n', 'utf8');
    // The directory has to exist for git to report the negation: measured, a
    // `dir/` pattern matches only directories, and with nothing on disk both
    // spellings answer with no rule. That residual is stated in
    // `seed-gitignore.ts`.
    mkdirSync(join(root, 'dist'), { recursive: true });

    const { outcomes } = ensureIgnored(root);
    assert.equal(
      outcomes[0]!.state,
      'negated',
      'a deliberate `!dist/` was not recognised — a `-q` probe cannot tell it from "no rule", so ' +
        'the seeded `/dist/` would be appended after it and, last-match-wins, silently reverse it',
    );
    assert.equal(gitignore(root).includes('/dist/'), false, 'the user\'s negation was overridden');
    assert.ok(!ignored(root, 'dist/index.html'), 'the user\'s `!dist/` stopped taking effect');
  });

  // Windows only, and the condition is the subject rather than a convenience.
  // The defect is a `:` in the *reported* path of an ignore file, and the only
  // portable source of one is a drive letter — measured, a POSIX
  // `/tmp/…/global-ignore:1:!dist/` splits into exactly the three fields the
  // naive parser expects, so on Linux this fixture cannot distinguish a correct
  // parser from the broken one. Manufacturing a colon another way does not work
  // either: a directory named `has:colon` is creatable on Linux and refused by
  // Windows, where `check-ignore` answers `warning: unable to access` and
  // reports no rule at all.
  //
  // So this is skipped where it would be vacuous rather than asserted where it
  // would be false. CI is `ubuntu-latest`, which means this particular fixture
  // is enforced on the maintainer's host and not in CI — stated here rather than
  // left for someone to discover as a gate that never ran.
  (process.platform === 'win32' ? scratch : skipScratch)('tk25-g7-negated-global-', (root) => {
    // The same negation, written in a **global** ignore file rather than in
    // `.gitignore`. This is a separate fixture from the one above because the
    // one above cannot see the defect it exists for: its rule lives in
    // `.gitignore`, a name with no colon in it, so a parser that splits the
    // `-v` line on `:` and takes the third field reads the pattern correctly
    // there — and reads the *line number* here, because `check-ignore` reports
    // a global file by its absolute path, which on Windows begins `C:/`.
    //
    // Measured before the fix, with the file at
    // `C:/Users/<name>/AppData/Local/Temp/…/ignore`: the line was
    // `C:/Users/…/ignore:1:!dist/<TAB>dist`, the third colon-separated field
    // was `1`, and a deliberate negation was therefore classified as "nobody
    // has said anything" — so `/dist/` was appended after the user's `!dist/`
    // and, last-match-wins, silently reversed it. The absolute path is what
    // supplies the extra colon; no filename needs to contain one, and on
    // Windows none may.
    //
    // Deliberately **not** run through `nakedGit`: neutralising the ambient
    // chain is what makes the other G7 probes honest, and it is exactly what
    // would hide this one. Here the global file *is* the subject, so it is
    // pointed at a fixture rather than at the machine's own.
    nakedGit(root, 'init', '-q', '.');
    mkdirSync(join(root, 'dist'), { recursive: true });
    const globalIgnore = join(root, 'global-ignore');
    writeFileSync(globalIgnore, '!dist/\n', 'utf8');
    writeFileSync(join(root, '.gitignore'), '', 'utf8');
    writeFileSync(
      join(root, 'gitconfig'),
      `[core]\n\texcludesFile = ${globalIgnore.replaceAll('\\', '/')}\n`,
      'utf8',
    );

    const previous = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = join(root, 'gitconfig');
    try {
      // Non-vacuity: the fixture's own configuration has to be the thing git is
      // reading, and the reported file has to be the one carrying the extra
      // colon. Without this the assertion below could pass on a run where the
      // global rule never applied at all.
      const seen = spawnSync('git', ['-C', root, 'check-ignore', '-v', '--', 'dist'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_SYSTEM: '/dev/null' },
      }).stdout.trim();
      assert.ok(
        seen.startsWith(globalIgnore.replaceAll('\\', '/')),
        `the fixture's global ignore file is not what git read: ${JSON.stringify(seen)}`,
      );
      assert.ok(
        (seen.split('\t')[0] ?? '').split(':').length > 3,
        'this run\'s absolute ignore-file path carries no extra colon, so this fixture is not ' +
          `exercising the defect it exists for: ${seen}`,
      );

      const { outcomes } = ensureIgnored(root);
      assert.equal(
        outcomes[0]!.state,
        'negated',
        'a negation in an ignore file whose path contains a colon was misparsed — the `-v` line ' +
          'is `<file>:<line>:<pattern>` and the file field can contain colons, so the pattern is ' +
          'not the third colon-separated field',
      );
      assert.equal(
        gitignore(root).includes('/dist/'),
        false,
        'a rule was appended after the user\'s global negation, reversing it',
      );
    } finally {
      if (previous === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = previous;
    }
  });

  scratch('tk25-g7-uncovered-', (root) => {
    nakedGit(root, 'init', '-q', '.');
    writeFileSync(join(root, '.gitignore'), '', 'utf8');
    ensureIgnored(root);
    const first = gitignore(root);
    assert.ok(first.includes(SEEDED_HEADER), 'the block was written without its header');
    for (const entry of SEEDED_ENTRIES) assert.ok(first.includes(entry), `${entry} was not written`);

    // Idempotence must come from the probe, not from searching for the header —
    // a user who edits or splits the block still gets no duplicate.
    writeFileSync(join(root, '.gitignore'), first.replace(SEEDED_HEADER, '# my own note'), 'utf8');
    const edited = gitignore(root);
    ensureIgnored(root);
    assert.equal(
      gitignore(root),
      edited,
      'a second call appended again after the header comment was edited, so idempotence depends ' +
        'on the marker rather than on what git says',
    );
  });

  scratch('tk25-g7-tracked-', (root) => {
    nakedGit(root, 'init', '-q', '.');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'i.html'), 'x', 'utf8');
    nakedGit(root, 'add', '-A');
    nakedGit(root, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'x');

    const { outcomes } = ensureIgnored(root);
    // `check-ignore` alone cannot see this: for a tracked path it reports
    // uncovered even with a matching rule present, because it consults the
    // index — so the ignore line alone does not help, since `git add -A` still
    // stages the modification. Hence the state and the advice.
    assert.equal(outcomes[0]!.state, 'tracked', 'an already-tracked dist/ was treated as uncovered');
    assert.match(outcomes[0]!.advice ?? '', /git rm --cached/, 'the tracked case gave no way out');

    // **The rule is written as well, and this assertion used to require the
    // opposite.** TK-25 reasoned that a line which cannot take effect should not
    // be written, which is true about the moment it is written and false about
    // every moment after. Measured under TK-32, following the advice verbatim
    // with no rule present: `git rm --cached -r dist` then `git add -A` puts
    // every file straight back in the index, so the one state a user cannot fix
    // themselves was the state the tool withheld the line that makes the fix
    // stick. With the rule present the same two commands leave it untracked.
    assert.ok(
      gitignore(root).includes('/dist/'),
      'no rule was written for a tracked path, so the `git rm --cached` this run advises is undone ' +
        'by the user\'s next `git add -A`',
    );

    // The behavioural half, which is what the assertion above is a proxy for.
    // Asserted rather than assumed, because "the line is in the file" is the
    // weaker claim and this whole module exists because those two come apart.
    nakedGit(root, 'rm', '--cached', '-r', '-q', 'dist');
    nakedGit(root, 'add', '-A');
    assert.deepEqual(
      nakedGit(root, 'ls-files').stdout.split('\n').filter((line) => line.startsWith('dist/')),
      [],
      'after the advised command and a re-add, the build output is tracked again',
    );
  });

  // 3. The no-trailing-newline fixture. Both halves go red at once under the
  // mutation, and the failure is legible as one broken line rather than two
  // unrelated misses.
  scratch('tk25-g7-newline-', (root) => {
    nakedGit(root, 'init', '-q', '.');
    writeFileSync(join(root, '.gitignore'), 'node_modules/', 'utf8');
    ensureIgnored(root);
    assert.ok(
      ignored(root, 'dist/index.html'),
      'appending without repairing the missing newline yields the junk rule `node_modules//dist/`',
    );
    assert.ok(ignored(root, 'node_modules/x'), 'the rule that already worked was broken by the append');
  });

  // 4. No repository at all: write the block unconditionally, and say so. It
  // costs one file and is correct the moment they run `git init`.
  scratch('tk25-g7-norepo-', (root) => {
    writeFileSync(join(root, '.git'), 'not a gitdir\n', 'utf8');
    const { outcomes, unprobed } = ensureIgnored(root);
    assert.equal(unprobed, true, 'a directory with no repository was probed anyway');
    assert.deepEqual(
      outcomes.map((outcome) => outcome.state),
      ['seeded', 'seeded'],
    );
    assert.equal(
      readFileSync(join(root, '.gitignore'), 'utf8'),
      `${SEEDED_HEADER}\n${SEEDED_ENTRIES.join('\n')}\n`,
    );
  });
}, 120_000);
