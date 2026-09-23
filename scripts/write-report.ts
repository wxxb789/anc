/**
 * The build's own diagnostic, written where `git` cannot commit it.
 *
 * A build drops files silently today — a slug collision, a filename that
 * slugifies to nothing, an extension that is not `.md` — and the only surface
 * that could say so is a stream this tool now forbids from carrying a filename.
 * So the names go to a file, the counts go to the stream, and this module owns
 * the split.
 *
 * ## The destination, and the one question that decides it
 *
 * `<git-dir>/publish-report/content-report.json`, resolved as
 * `git rev-parse --git-path publish-report/content-report.json` against the
 * directory the command was invoked in.
 *
 * Nothing under the git directory can enter the index by any command, so the
 * "the report got committed" vector is closed structurally rather than by a
 * rule anyone has to remember. Measured on git 2.55.0.windows.3, in a throwaway
 * repository with no `.gitignore` at all: `git add -A` staged the note alone,
 * `git add -f <the report>` exited 0 as a silent no-op with `git ls-files`
 * unchanged, `git check-ignore -v` exited 1 reporting **no rule** — there is no
 * pattern to credit — and `git clean -xfd` left the file in place. That last one
 * is not incidental: `git clean -xfd` is what a user runs after a failed build,
 * which is the moment the diagnostic is worth most, and a self-ignoring
 * directory in the worktree does not survive it.
 *
 * The tool asks exactly one question, and every host can answer it definitively:
 * **is there a git directory here?** There is deliberately no second question,
 * and in particular no question about who can read the repository — a rule with
 * no input about the reader cannot be wrong about the reader. A private
 * repository gets the identical path and the identical contents, which trades a
 * convenience a private-repository user could safely have for one code path
 * exercised on every run instead of two of which one never is.
 *
 * The directory segment is `publish-report/`, and the neutrality is deliberate:
 * this tool runs on a stranger's notes repository, and a directory carrying this
 * project's name inside a user's own `.git/` is single-owner residue. The
 * segment describes what is in the directory and is legible to someone who finds
 * it without knowing what wrote it.
 *
 * ## Resolved before the chdir, and not with `--path-format=absolute`
 *
 * `bin/anc.mjs` changes the working directory to the package
 * root partway through a build, so the destination is computed from the
 * invocation cwd beside the other two directories and never after. Measured,
 * `git rev-parse --git-path` returns a **cwd-relative** path in the ordinary
 * case — `.git/publish-report/…` at a repository root, `../../.git/…` two levels
 * down — so a path resolved after the chdir lands inside the installed package
 * under `node_modules`.
 *
 * `path.resolve` on plain `--git-path` rather than `--path-format=absolute`:
 * both work, the resolve form has no git version floor, and `rev-parse`
 * **echoes unknown flags instead of failing** — measured, `git rev-parse
 * --bogus-flag --git-path x` exits 0 and prints `--bogus-flag` first with
 * `.git/x` second — so a version sniff on a flag silently returns garbage as a
 * path. The last line is the answer.
 *
 * Measured correct at a repository root, two directories down, in a linked
 * worktree, under `--separate-git-dir`, in a bare repository, in a repository
 * with no commits, in a nested repository, and in a submodule.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPORT_SCHEMA_VERSION = 1;

/**
 * Why a discovered file produced no page.
 *
 * A closed set of stable identifiers, never prose: a free-text reason cannot be
 * gated on and cannot be switched on. Adding a member — TK-26 added three, for
 * the two exclusion mechanisms and the repository's own README — does not bump
 * {@link REPORT_SCHEMA_VERSION}, because a reader that does not know it still
 * parses the file. Renaming or removing one does.
 *
 * The two exclusion reasons are separate members rather than one `excluded`,
 * because they are two different mistakes with two different fixes: a pattern
 * the user can correct in their config, and three words inside the file itself.
 * A reader who cannot tell them apart has to open the file to find out which.
 */
export type DropReason =
  | 'slug-collision' // an earlier file already took this slug
  | 'not-markdown' // the extension is not .md
  | 'excluded-by-pattern' // a user exclusion glob matched it
  | 'excluded-by-frontmatter' // the note itself carries `publish: false`
  | 'repository-readme'; // the root README addresses the repository, not the reader

export interface DroppedFile {
  /** Path relative to the content directory, in POSIX separators. */
  path: string;
  reason: DropReason;
  /**
   * Present only for `slug-collision`: the path that won the slug, in the same
   * relative form as `path`. A collision is the one reason a reader cannot act
   * on from the losing file alone.
   */
  collidedWith?: string;
}

/**
 * What a link turned out to be, for the rows that are worth a reader's time.
 *
 * A closed set, like {@link DropReason} and for the same reason: a free-text
 * outcome cannot be gated on and cannot be switched on. `resolved` and
 * `external` are deliberately absent — a report listing every working link is a
 * report nobody reads, and the two that are not findings are the two that
 * needed no action.
 *
 * - `ambiguous` — several files could have been meant. The link **still
 *   renders**; this is a warning, because failing is worst exactly where it is
 *   most likely and a stranger cannot always act on it.
 * - `unpublished` — the target is a real file this build did not publish. Not a
 *   broken link: it is the publication boundary seen from the other side, and
 *   the most useful line in the report.
 * - `unresolved` — nothing of that name exists.
 * - `embed-not-transcluded` — an `![[note]]` embed became an ordinary link,
 *   because nothing here transcludes a note's content into another.
 */
export type LinkOutcome = 'ambiguous' | 'unpublished' | 'unresolved' | 'embed-not-transcluded';

/**
 * One link the build wants a human to look at.
 *
 * **Rows, never counts.** "Zero unresolved because there were none" and "zero
 * because I never looked" are the same number, so each row carries the text and
 * the position a user can act on. `ContentReport.status` is what keeps the
 * *stream's* counts honest; this is the file's half.
 *
 * Every field here is a string the stream may not carry: a repository-relative
 * source path, a link naming a note that may have been withheld, and for
 * `unpublished` the path of a file the user chose not to publish. That is
 * precisely why the report lives under the git directory, where nothing can
 * stage it, and why nothing under `src/` imports this module.
 */
export interface LinkFindingRow {
  /** The writing file's path, relative to the content directory. */
  source: string;
  /** 1-indexed line within that file. */
  line: number;
  /** The link exactly as authored, so it can be searched for. */
  link: string;
  outcome: LinkOutcome;
  /**
   * Every candidate considered, sorted. Present for `ambiguous` and
   * `unpublished`; **absent** for the other two rather than empty, because an
   * empty list reads as "looked and found none" where there was nothing to look
   * at.
   */
  candidates?: string[];
  /** For `ambiguous` only: which candidate the tier order picked. */
  resolvedTo?: string;
}

/**
 * Where a reader would look for a finding: by file, then down the file.
 *
 * Exported because the producer sorts its own findings before handing them over
 * and this module sorts them again on the way to disk — and two copies of one
 * comparator is one edit away from two different orders. `line` is compared
 * numerically: as a string, 10 sorts before 9.
 */
export function bySourceThenLine(a: LinkFindingRow, b: LinkFindingRow): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.line - b.line;
}

export interface ContentReport {
  version: typeof REPORT_SCHEMA_VERSION;
  /** `package.json`'s version, so a report found later names the tool that wrote it. */
  generator: string;
  /**
   * `complete` — discovery finished and `dropped` is exhaustive.
   * `aborted` — the run stopped before discovery finished, so `counts` are
   * partial and `dropped` is a prefix rather than a set.
   *
   * This is what distinguishes "nothing to report" from "I stopped before I
   * could look". An empty `dropped` under `complete` means nothing was dropped;
   * the same array under `aborted` means nothing was dropped *yet*.
   */
  status: 'complete' | 'aborted';
  /**
   * `discovered` counts every directory entry the walk classified as a file,
   * including the ones that became `dropped` rows. `discovered === published +
   * dropped` on every complete run, which is what makes the three checkable
   * against each other rather than three independent numbers.
   */
  counts: { discovered: number; published: number; dropped: number };
  /** Sorted by `path`. Empty when nothing was dropped — never omitted, so `jq '.dropped | length'` is meaningful on every report. */
  dropped: DroppedFile[];
  /**
   * Every link worth a human's attention, sorted by source then line. Empty
   * rather than omitted, for the same reason `dropped` is: a reader's access to
   * it must not depend on whether this run happened to find anything.
   *
   * Adding this field does not bump {@link REPORT_SCHEMA_VERSION} — a reader
   * that does not know it still parses the file, which is the rule stated on
   * {@link DropReason}.
   */
  links: LinkFindingRow[];
  /** `null` on a successful build. */
  failure: { code: string; detail: string } | null;
}

/**
 * An error whose message was composed under the disclosure rule, so the caller
 * may print it.
 *
 * The boundary in `bin/anc.mjs` prints `error.message` for
 * every throw in the process, which is how a `readdir` `ENOTDIR` — a string
 * nobody here composed, with an absolute path already inside it — would reach a
 * world-readable workflow log. Only errors this module vouches for are printed;
 * everything else prints a fixed literal and puts its real message in the
 * report's `failure.detail`.
 *
 * @param code A stable identifier from a closed set, safe on any stream.
 * @param message The public half: literals, integers, and published slugs only.
 * @param detail The private half, which goes to the report and nowhere else.
 */
export class BuildFailure extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, message: string, detail: string = message) {
    super(message);
    this.name = 'BuildFailure';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Error names whose messages are composed under the disclosure rule.
 *
 * `ContentValidationError` earns its place rather than being grandfathered in:
 * its message is a source literal for the artifact, `entries[N]` coordinates,
 * a rule name from `schema.ts`'s own table, and the slug of an entry — which is
 * a *published* route the build was about to serve, not the name of a file the
 * build withheld. Its `source` argument used to be the resolved content
 * directory, and that is the one part of it that changed.
 *
 * Matched by name rather than by `instanceof` so this module imports nothing
 * from `src/`: `bin/` loads every build step through `await import()`, and a
 * static import here would pull the schema into the report writer's own module
 * graph for a type test.
 */
const DISCLOSURE_CHECKED: ReadonlySet<string> = new Set(['BuildFailure', 'ContentValidationError']);

/** Whether this error's own message is safe to print on a stream. */
export function isDisclosureChecked(error: unknown): error is Error {
  return error instanceof Error && DISCLOSURE_CHECKED.has(error.name);
}

/**
 * The report's `failure` for a thrown error: a stable code for the stream's
 * sake, and everything else for the file's.
 */
export function failureFor(error: unknown): { code: string; detail: string } {
  if (error instanceof BuildFailure) return { code: error.code, detail: error.detail };
  if (error instanceof Error) {
    return {
      code: error.name === 'ContentValidationError' ? 'content-contract-violation' : 'unexpected-error',
      detail: error.stack ?? error.message,
    };
  }
  return { code: 'unexpected-error', detail: String(error) };
}

const GENERATOR = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/**
 * The line a build prints instead of the report's path.
 *
 * A path, printed, would carry the user's own directory onto a public log. This
 * is a command instead: one literal, byte-identical on every machine, that the
 * user runs to get their own path — and it is correct from any subdirectory, in
 * a linked worktree, in a submodule, and under `--separate-git-dir` alike,
 * because it asks the same question of git that this module asked.
 */
const POINTER = 'report: cat "$(git rev-parse --git-path publish-report/content-report.json)"';

/** The same line where there is no git directory to ask. Also a fixed literal. */
const POINTER_NO_GIT =
  'report: no git directory here; written under the user state directory, publish-report/<key>/';

/**
 * Where a user's own state lives, for the case where there is no repository.
 *
 * Never `os.tmpdir()`: on Linux that is world-readable `/tmp`. Outside the
 * worktree either way, so a later `git init` followed by `git add -A` cannot
 * reach a report an earlier run wrote — the hazard any in-worktree fallback
 * carries and cannot close, since the earlier run had no repository to consult.
 *
 * `||` rather than `??`, which is not a style choice and has a measured failure
 * behind it: `??` treats an **empty** environment variable as a value, so
 * `XDG_STATE_HOME=` — the ordinary way a shell unsets one for a single command —
 * yields `''`, and `join('', 'publish-report', …)` is a *relative* path that
 * `mkdirSync` then creates inside the invocation directory. That is the report
 * landing in the user's worktree, one `git init && git add -A` from being
 * committed, which is precisely the hazard this destination exists to close.
 * `src/lib/artifact-source.ts` documents `||` for the identical reason.
 */
function stateDirectory(): string {
  if (process.platform === 'win32') {
    return process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local');
  }
  return process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state');
}

/** Soft cap and age bound for reports that have no git directory to own them. */
export const STATE_REPORT_MAX_PROJECTS = 128;
export const STATE_REPORT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const STATE_KEY = /^[a-f0-9]{16}$/;

/**
 * Remove old no-git reports without following or touching unfamiliar names.
 *
 * Only this tool's 16-hex project directories are candidates. The current key
 * is retained even when its previous report is old; one slot is reserved for it
 * before the next write, so an ordinary run leaves at most 128 projects. Races
 * between several new projects may exceed the soft cap briefly and converge on
 * the next run. Cleanup is best-effort: inability to delete history must never
 * replace the report for the build in progress.
 */
export function pruneStateReports(root: string, currentKey: string, now: number = Date.now()): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  const candidates: { directory: string; modified: number }[] = [];
  for (const entry of entries) {
    if (entry.name === currentKey || !STATE_KEY.test(entry.name) || !entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    let modified: number;
    try {
      modified = statSync(join(directory, 'content-report.json')).mtimeMs;
    } catch {
      try {
        modified = statSync(directory).mtimeMs;
      } catch {
        continue;
      }
    }
    candidates.push({ directory, modified });
  }

  const remove = (directory: string): void => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort retention only; the current report still has to be written.
    }
  };
  const retained = candidates.filter(({ directory, modified }) => {
    if (now - modified <= STATE_REPORT_MAX_AGE_MS) return true;
    remove(directory);
    return false;
  });
  retained
    .sort((left, right) => right.modified - left.modified)
    .slice(Math.max(0, STATE_REPORT_MAX_PROJECTS - 1))
    .forEach(({ directory }) => remove(directory));
}

/**
 * The report's path for this invocation, and whether git answered.
 *
 * `spawnSync` surfaces a missing binary as `error.code === 'ENOENT'` with
 * `status === null`, and `git rev-parse` outside a repository exits 128. Both
 * take the same branch, because the conclusion is the same: there is no index,
 * so no path in the worktree can be staged.
 */
function destinationFor(userDirectory: string): { path: string; hasGitDirectory: boolean } {
  const probe = spawnSync('git', ['rev-parse', '--git-path', 'publish-report/content-report.json'], {
    cwd: userDirectory,
    encoding: 'utf8',
  });

  const answer = probe.status === 0 ? probe.stdout.trim().split('\n').at(-1) : undefined;
  if (answer !== undefined && answer !== '') {
    return { path: resolve(userDirectory, answer), hasGitDirectory: true };
  }

  // A filesystem key, not a disclosure: it exists so two projects do not
  // overwrite each other's report. It names the user's own directory on the
  // user's own machine and is never interpolated into a stream.
  const key = createHash('sha256').update(realpath(userDirectory)).digest('hex').slice(0, 16);
  const root = join(stateDirectory(), 'publish-report');
  pruneStateReports(root, key);
  return {
    path: join(root, key, 'content-report.json'),
    hasGitDirectory: false,
  };
}

function realpath(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/** What a build holds for the duration of a run, so its three writes share one state. */
export interface OpenReport {
  /** Resolved once, and printed nowhere. */
  readonly destination: string;
  /** The pointer line for this invocation, which is a literal either way. */
  readonly pointer: string;
  /** The counts line, which is three integers and a source literal. */
  readonly summary: string;
  /**
   * Discovery finished: the counts are real and `dropped` is exhaustive.
   *
   * `links` is optional because discovery and link resolution are two steps,
   * and a caller may record what was discovered before the second runs — which
   * is the ordering that puts the dropped files in a readable file on the run
   * that fails afterwards. Omitting it leaves whatever was recorded before.
   */
  discovered(
    counts: ContentReport['counts'],
    dropped: readonly DroppedFile[],
    links?: readonly LinkFindingRow[],
  ): void;
  /** The run threw: record the code and the private detail, leaving the rest. */
  failed(failure: { code: string; detail: string }): void;
}

/**
 * Open the report **before discovery starts**, and write the stub immediately.
 *
 * The ordering is the whole point, and it is why this is opened rather than
 * written at the end: the diagnostic is most needed on the run that failed, and
 * a report written only after validation cannot exist on the run that failed
 * validation — which is the likeliest throw in the whole binary. Measured
 * before this existed: a note whose body carried an absolute path exited 1 with
 * **nothing** written anywhere.
 *
 * `status: "aborted"` is the only value that is true at that moment, and
 * writing it first is what makes "I stopped before I could look" a state a
 * reader can observe rather than an absence they must interpret.
 *
 * A successful run needs no third write: the stub is superseded by
 * {@link OpenReport.discovered}, which already leaves `failure: null`.
 */
export function openReport(userDirectory: string): OpenReport {
  const { path, hasGitDirectory } = destinationFor(userDirectory);

  const report: ContentReport = {
    version: REPORT_SCHEMA_VERSION,
    generator: GENERATOR,
    status: 'aborted',
    counts: { discovered: 0, published: 0, dropped: 0 },
    dropped: [],
    links: [],
    failure: null,
  };

  const flush = (): void => {
    // 0700 where the tool chose the directory. On Windows Node's mode argument
    // is inert and the directory reports the default — accepted, because that
    // path is inside the user's own profile directory and the vector this
    // destination closes is git, not local ACLs.
    mkdirSync(dirname(path), hasGitDirectory ? { recursive: true } : { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  };

  flush();

  return {
    destination: path,
    pointer: hasGitDirectory ? POINTER : POINTER_NO_GIT,
    get summary(): string {
      // Three integers and a source literal on the ordinary path. On a run that
      // stopped before discovery finished the same three integers are all zero,
      // and printing them unqualified would say "your directory held nothing" —
      // indistinguishable from an empty content directory, and the opposite of
      // what `status: "aborted"` exists to record. So the aborted run gets its
      // own literal instead, and the counts are simply not claimed.
      if (report.status === 'aborted') return 'content: discovery did not finish';
      const { discovered, published, dropped } = report.counts;
      // Per-reason counts after the total: still integers and literals of the
      // closed {@link DropReason} set, so the line stays rename-invariant, and a
      // collision or an exclusion is visible on the stream without a name.
      const byReason = new Map<DropReason, number>();
      for (const row of report.dropped) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1);
      const reasons = [...byReason]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([reason, count]) => `${count} ${reason}`);
      return (
        `content: ${discovered} discovered, ${published} published, ${dropped} dropped` +
        (reasons.length === 0 ? '' : ` (${reasons.join(', ')})`)
      );
    },
    discovered(counts, dropped, links): void {
      report.status = 'complete';
      report.counts = counts;
      report.dropped = [...dropped].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      // Sorted where a reader would look, and left alone when the caller has
      // nothing yet — link resolution is a second step, and a caller recording
      // discovery first must not have that read as "no findings".
      if (links !== undefined) report.links = [...links].sort(bySourceThenLine);
      flush();
    },
    failed(failure): void {
      report.failure = failure;
      flush();
    },
  };
}
