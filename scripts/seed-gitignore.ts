/**
 * The `.gitignore` lines a notes repository needs, and the algorithm that seeds
 * them without overwriting what the user already wrote.
 *
 * **This ships with no caller.** `init` does not exist — the CLI rejects every
 * command but `build` — and TK-32 writes it. What is worth having now is the
 * part that can be wrong: appending to a stranger's `.gitignore` has four
 * distinct correct behaviours and three measured ways to corrupt a working file,
 * and none of that needs a command to be gated against a scratch repository.
 *
 * ## What is seeded, and what deliberately is not
 *
 * Two entries. `/dist/` is the only generated artifact that really lands in a
 * stranger's worktree — measured in a throwaway repository, one built note and
 * `git add -A` stages 40 paths of which 38 are under `dist/`, and with the block
 * seeded, exactly `.gitignore` and the note. `node_modules/` is one line against
 * a 200 MB accidental commit, and a notes repository has no other reason for
 * that directory to exist, so the entry can never hide something the user
 * wanted.
 *
 * `content-report.json` is **not** seeded, and its absence is the design rather
 * than an omission: `scripts/write-report.ts` writes the report under the git
 * directory, where no ignore rule applies and none is needed. Measured,
 * `check-ignore -v` on that path exits 1 reporting no rule at all and `git add
 * -A` stages nothing from it. A line ignoring a file this tool never writes
 * there is a line no gate can turn red and no future maintainer can safely
 * delete.
 *
 * The build's staging workspace gets no line either: it is created inside the
 * *package* root, which in a stranger's repository is under `node_modules/`,
 * already covered. This repository needs its own `.thoughtscape-build-` rule
 * only because this repository *is* the package.
 *
 * ## Root-anchored with a leading `/`, and that is not style
 *
 * Measured: with the bare pattern `dist`, a user's own note at `notes/dist/i.md`
 * is ignored — `check-ignore` exits 0 attributing `.gitignore:1:dist` — and with
 * `/dist/` it is not. A publishing tool that silently drops a directory of the
 * user's notes because they named it `dist` has done the one thing it must never
 * do. `node_modules/` is unanchored on purpose: a nested `node_modules` is never
 * a user's note directory, and anchoring it would miss the one under a workspace
 * package.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The seeded lines, in the order they are written.
 *
 * A constant in source, because "one definition" across the package boundary is
 * impossible: `.gitignore` is not in `package.json`'s `files` so it is not in
 * the tarball, and even when a `.gitignore` *is* packed, **npm renames it** —
 * measured on a fixture whose tarball contained `package/.gitignore` and which
 * installed as `node_modules/<name>/.npmignore` holding the `.gitignore` text
 * and no `.gitignore`. An installed `init` cannot read its own package's copy
 * under that name.
 *
 * Nor is this repository's own `.gitignore` a second definition to check
 * against: this repository is the tool, not a notes repository. The two already
 * disagree correctly — this one ignores `dist/` unanchored and needs rules for
 * its packaging staging directories and tarballs besides, none of which belong
 * in a stranger's notes repository.
 */
export const SEEDED_ENTRIES = ['/dist/', 'node_modules/'] as const;

/**
 * The comment written above an appended block. For the human; nothing parses it.
 *
 * The spec's §3.1 spells this `# added by thoughtscape-publish init`, and that
 * spelling is deliberately not used. It writes this project's name into a file
 * in a stranger's repository, which is the single-owner residue the same
 * document's §1.1 removes from the report's own path two sections earlier —
 * `publish-report/` rather than a name-carrying segment, for exactly this
 * reason. The two rules cannot both be right, and the one that generalises is
 * the one that survives. Nothing keys off the text: idempotence comes from
 * asking git, never from searching for this string.
 */
export const SEEDED_HEADER = '# added by the publish tool';

/**
 * What each entry's probe found, and what was done about it.
 *
 * The `action` is what a caller reports to the user, and it is why the probe is
 * read as four states rather than two.
 */
export interface EntryOutcome {
  /** The line as it would be written: `/dist/`, `node_modules/`. */
  entry: string;
  state: 'covered' | 'negated' | 'tracked' | 'seeded';
  /**
   * Present for `tracked`: the command the user runs, because a new ignore line
   * does not help — measured, `git add -A` still stages a modification to an
   * already-tracked file.
   */
  advice?: string;
}

export interface SeedResult {
  outcomes: EntryOutcome[];
  /** True when the repository had no git directory, so nothing could be probed. */
  unprobed: boolean;
}

/** What `git` said, distinguishing "answered no" from "could not be asked". */
function git(cwd: string, args: readonly string[], input?: string): { status: number; stdout: string } | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input });
  // `spawnSync` reports a missing binary as `error.code === 'ENOENT'` with
  // `status === null`, which is the one genuine "cannot tell" and takes the safe
  // branch at every call site.
  if (result.error !== undefined || result.status === null) return undefined;
  return { status: result.status, stdout: result.stdout };
}

/**
 * The probe, and why it is two calls per entry rather than the obvious one.
 *
 * `check-ignore -v --non-matching` reports three states in one line — a pattern
 * with a file and line for covered, a pattern beginning `!` for a deliberate
 * un-ignore, and the empty `::` for no rule at all. That is the reason for
 * `-v --non-matching` over `-q`: measured, `-q` exits 1 for **both** the negated
 * and the no-rule cases, so a quiet probe cannot tell "the user chose to track
 * this" from "nobody has said anything", and would append over the first.
 *
 * What is not obvious, and what one probe gets wrong: **the answer depends on
 * whether the path exists on disk, and differently for each spelling of the
 * argument.** Measured on git 2.55.0.windows.3, with the rule `/dist/`:
 *
 *     probe `dist`   directory absent  →  `::`                  (uncovered — wrong)
 *     probe `dist`   directory present →  `.gitignore:1:/dist/` (covered)
 *     probe `dist/`  either            →  `.gitignore:1:/dist/` (covered)
 *
 * A `dir/` pattern matches only directories, and git needs the filesystem to
 * know that a slashless `dist` names one. `init` runs *before* the first build,
 * so the absent case is the ordinary case rather than an edge one — a probe on
 * the slashless form alone would report a correctly-ignored `dist/` as uncovered
 * and append a duplicate rule to every repository it touched.
 *
 * So coverage is asked with the trailing slash, which is disk-independent. And
 * negation is asked without it, because that is the only form that reports one:
 * with the rule `!dist/`, `probe dist/` answers `::` while `probe dist` answers
 * `.gitignore:1:!dist/` — when the directory exists.
 *
 * **The residual, stated rather than hidden:** a negation written in `dir/` form
 * for a directory that does not yet exist is invisible to git — measured, both
 * spellings answer with no rule. There is no `check-ignore` flag that assumes a
 * path is a directory, and probing a path *inside* it answers the same way. Such
 * an entry is therefore seeded as uncovered, which appends `/dist/` after the
 * user's `!dist/` and, last-match-wins, reverses it. It is the one case this
 * cannot get right; a caller shows the outcomes so a user sees what was written.
 *
 * ## `-z --stdin`, because the human-readable form is ambiguous
 *
 * The default `-v` output is `<file>:<line>:<pattern>\t<path>`, and **the file
 * field can contain a colon**, so splitting on `:` and taking the third field is
 * wrong on the most ordinary Windows configuration there is. Measured: with a
 * global `core.excludesFile` at `C:/Users/<name>/.config/git/ignore` holding
 * `!dist/`, the line reads
 * `C:/Users/<name>/.config/git/ignore:1:!dist/<TAB>dist` and the third
 * colon-separated field is `1`. A parser reading it as the pattern sees no
 * leading `!`, classifies a deliberate negation as "nobody has said anything",
 * and appends `/dist/` after the user's `!dist/` — silently reversing it, which
 * is the exact failure this two-probe design exists to prevent.
 *
 * `-z` emits the same four fields NUL-separated instead, which no path can
 * forge. It requires `--stdin` — measured, `-z` without it is
 * `fatal: -z only makes sense with --stdin` — so the paths go in on stdin and
 * the trailing empty field of each record is dropped.
 */
function probe(root: string, paths: readonly string[], slash: boolean): string[][] | undefined {
  const answer = git(
    root,
    ['-C', root, 'check-ignore', '-vz', '--non-matching', '--stdin'],
    paths.map((path) => (slash ? `${path}/` : path)).join('\0') + '\0',
  );
  // 128 has at least three meanings — not a repository, `-C` into a directory
  // that does not exist, and a path argument git refuses — so it is never read
  // as an answer. The caller has already established this is a work tree, which
  // makes a 128 here a malformed probe rather than a missing repository.
  if (answer === undefined || answer.status > 1) return undefined;

  // Four fields per record — file, line, pattern, path — then the next record.
  // A trailing NUL closes the last one, so the split leaves an empty tail.
  const fields = answer.stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length !== paths.length * 4) return undefined;

  return paths.map((_, index) => fields.slice(index * 4, index * 4 + 4));
}

/**
 * Seed the two entries into `<root>/.gitignore`, writing only what is missing.
 *
 * Blind append and overwrite are both wrong, and so is string-matching the file
 * for our entries. Each measured on git 2.55.0.windows.3:
 *
 * - **Overwrite destroys** rules the rest of the repository depends on, which is
 *   a larger blast radius than the leak it prevents.
 * - **Append reverses a deliberate choice.** `.gitignore` is last-match-wins:
 *   with `!dist/` followed by an appended `dist/`, `dist/index.html` goes from
 *   not-ignored to ignored.
 * - **Append corrupts a file with no trailing newline.** Measured:
 *   `node_modules/` written without a final `\n`, then `/dist/` appended, yields
 *   the single junk rule `node_modules//dist/` — verified byte by byte — after
 *   which *neither* path is ignored. The append broke a rule that already
 *   worked.
 * - **Reading the file cannot answer the question.** Every one of `dist`,
 *   `/dist/`, a doubled-star form anchored either way, a bare `*`, a rule in
 *   `.git/info/exclude`, and a rule in `core.excludesFile` was measured ignoring
 *   `dist/index.html` while a textual search for the line `/dist/` finds
 *   nothing.
 *
 * So git is asked, from the repository root with repository-root-relative paths.
 * `-C <toplevel>` matters because `check-ignore` resolves relative to cwd:
 * `dist/index.html` probed from `sub/` asks about `sub/dist/index.html` and
 * answers against a root-anchored rule as un-ignored.
 *
 * The probe arguments are paths, never patterns. A leading-slash argument is not
 * a path and the call dies — measured, `check-ignore -- /dist/` exits 128 with
 * `fatal: Invalid path`, and under git-bash the argument is first mangled into
 * `C:/Program Files/Git/dist` by MSYS path conversion. So `dist/` is probed and
 * `/dist/` is written.
 *
 * The ambient ignore chain is deliberately **not** neutralised here: a user with
 * a global rule for `dist/` must not be forced to commit a line they do not
 * need. A gate over this function is the place that neutralises it, because
 * there a global rule would make the seed look unnecessary when it is not.
 *
 * @param root The repository root, or any directory when there is no repository.
 * @throws {Error} when git is absent or a probe cannot be trusted, and when a
 *   re-probe after writing shows an entry still uncovered. A half-seeded run
 *   that reports success is how the artifact gets committed.
 */
export function ensureIgnored(root: string): SeedResult {
  // Asked directly rather than inferred from `check-ignore`'s exit 128, which
  // has at least three meanings. Measured: `true` in a fresh repository with no
  // commits, `false` inside `.git/`, 128 for both not-a-repository and
  // missing-directory.
  const inside = git(root, ['-C', root, 'rev-parse', '--is-inside-work-tree']);
  if (inside === undefined) {
    throw new Error('git is not available, so no ignore rules could be checked — nothing was written');
  }

  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    // No repository: write the block unconditionally. It costs one file and is
    // correct the moment they run `git init`.
    append(root, [...SEEDED_ENTRIES]);
    return { outcomes: SEEDED_ENTRIES.map((entry) => ({ entry, state: 'seeded' })), unprobed: true };
  }

  const top = git(root, ['-C', root, 'rev-parse', '--show-toplevel']);
  if (top === undefined || top.status !== 0) {
    throw new Error('the repository root could not be resolved — nothing was written');
  }
  const toplevel = top.stdout.trim();

  const outcomes = classify(toplevel);
  const missing = outcomes.filter((outcome) => outcome.state === 'seeded').map((outcome) => outcome.entry);
  if (missing.length > 0) append(toplevel, missing);

  // Verify, then fail loudly. The re-probe is the same probe, so a seed that did
  // not take — appended to the wrong file, or defeated by a later rule — is a
  // non-zero exit rather than a success message.
  for (const outcome of classify(toplevel)) {
    if (outcome.state === 'seeded' && missing.includes(outcome.entry)) {
      throw new Error(
        `${outcome.entry} was written to .gitignore and is still not ignored — ` +
          `written: ${missing.join(', ')}`,
      );
    }
  }

  return { outcomes, unprobed: false };
}

/** The four states, one probe pair for all entries. */
function classify(toplevel: string): EntryOutcome[] {
  // Probed without the leading `/` the written lines carry, and with the
  // trailing one they do not: the argument is a path, the line is a pattern.
  const paths = SEEDED_ENTRIES.map((entry) => entry.replace(/^\//, '').replace(/\/$/, ''));

  const covered = probe(toplevel, paths, true);
  const negated = probe(toplevel, paths, false);
  // Both probes are checked, and `probe` itself has already verified that each
  // returned exactly one record per path. An unchecked second probe is the same
  // defect as an unchecked first: a short answer makes some entry's record
  // `undefined`, a negation reads as "no rule", and the seeded line silently
  // reverses what the user wrote.
  if (covered === undefined || negated === undefined) {
    throw new Error('the ignore rules could not be read — nothing was written');
  }

  return SEEDED_ENTRIES.map((entry, index) => {
    // `[file, line, pattern, path]`, with the first three empty when no rule
    // matched. The pattern is read as a field rather than parsed out of a
    // colon-joined string, because the file field can itself contain a colon.
    if (covered[index]![2] !== '') return { entry, state: 'covered' as const };
    if (negated[index]![2]!.startsWith('!')) return { entry, state: 'negated' as const };

    // Already tracked is a fourth answer and needs the opposite action.
    // Measured: for a tracked path `check-ignore` reports uncovered even with a
    // matching rule present, because it consults the index — and a new ignore
    // line does not help, since `git add -A` still stages the modification.
    const path = paths[index]!;
    const tracked = git(toplevel, ['-C', toplevel, 'ls-files', '--error-unmatch', '--', path]);
    if (tracked !== undefined && tracked.status === 0) {
      return {
        entry,
        state: 'tracked' as const,
        advice: `git rm --cached -r ${path}  (the file stays in this repository's history)`,
      };
    }

    return { entry, state: 'seeded' as const };
  });
}

/**
 * Append at the end, after repairing a missing trailing newline.
 *
 * The end is the only position that cannot change the meaning of a rule the user
 * already wrote, since `.gitignore` is last-match-wins. Only the uncovered
 * entries are written, so a second call is idempotent because the probe answers
 * differently — not because anything searched for the header comment. A user who
 * edits or splits the block still gets no duplicate.
 */
function append(root: string, entries: readonly string[]): void {
  const path = join(root, '.gitignore');

  let existing: string;
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    existing = '';
  }

  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${existing}${separator}${SEEDED_HEADER}\n${entries.join('\n')}\n`, 'utf8');
}
