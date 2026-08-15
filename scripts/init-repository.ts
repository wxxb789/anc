/**
 * `thoughtscape-publish init`: prepare a notes repository for its first build.
 *
 * Two writes, and the argument for the ticket is that both are things a user
 * cannot discover by running the tool. A build tells you what it published; it
 * does not tell you that `dist/` is about to be committed, and it does not tell
 * you that the site it just built points at a loopback origin nobody can reach.
 *
 * ## What it does, and what it deliberately does not
 *
 * 1. **Seeds `.gitignore`.** {@link ensureIgnored} has shipped since TK-25 with
 *    no caller — this is the caller. Everything about *how* to append to a
 *    stranger's `.gitignore` lives there, including the four probe states and
 *    the three measured ways to corrupt a working file.
 * 2. **Writes a starter {@link CONFIG_FILENAME}, if there is not one already.**
 *
 * Three things the plan's §4.4 names for `init` are **not** written, each for a
 * reason rather than for want of time:
 *
 * - **`.github/workflows/publish.yml`.** A workflow file names the action it
 *   calls, as `uses: <owner>/<repo>@v1`. This repository has no git remote, so
 *   there is no such coordinate to write — `init` would put a `uses:` line
 *   naming a repository that does not exist into a stranger's CI, which fails
 *   on their first push with an error about *our* naming rather than about
 *   anything they did. It also picks a deploy target for them; the zero-secret
 *   GitHub Pages path is the documented default and Cloudflare is a supported
 *   alternative, and a file `init` wrote is the worst place for that choice to
 *   be made silently. `action.yml` at the root of this repository is the half
 *   that can exist today, and it does.
 * - **A starter about and privacy note.** §4.4 ties those to deleting
 *   `src/pages/about.astro` and `privacy.astro`, which is not this ticket's
 *   scope, and until that lands a seeded note would sit beside a shipped page
 *   saying something different about the same subject.
 * - **Prompts.** §4.4 has `init` fill `title` and `origin` from them. A prompt
 *   is unanswerable in CI and in a non-interactive shell, and the file this
 *   writes is one a user edits in the editor they already have open. What the
 *   template must do instead is make the two keys impossible to miss, which is
 *   what putting them first and commented does.
 *
 * ## Idempotence, which is the property that makes it safe to suggest
 *
 * A user will run this twice — after a failed first attempt, or because they
 * forgot. `ensureIgnored` is idempotent by asking git rather than by searching
 * for its own marker, so a user who edited or split the block still gets no
 * duplicate. The config is idempotent by the blunter rule: **an existing file is
 * never touched, whatever is in it.** Not "merged", not "updated", not
 * "rewritten with the missing keys" — a configuration file is the one file in a
 * notes repository whose contents are load-bearing for what stays private, and a
 * tool that edits it is a tool that can silently drop an exclusion.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_FILENAME } from './load-config.ts';
import { ensureIgnored, type SeedResult } from './seed-gitignore.ts';
import { BuildFailure } from './write-report.ts';

/**
 * The starter configuration, with every key commented out.
 *
 * **An entirely commented file and an absent file produce the same build**, and
 * that is measured rather than assumed: `parseConfig` over this text returns
 * `{title: 'Notes', exclude: []}`, byte-identical to what an empty string and a
 * missing file return. So writing it changes nothing about the site, which is
 * what makes writing it unconditionally safe — the file is a menu, not a
 * configuration.
 *
 * The three keys are {@link KNOWN_KEYS} in the order `load-config.ts` documents
 * them, and `origin` carries the longest comment because it is the only key
 * whose default is *wrong for a deployed site* rather than merely generic: with
 * no origin every canonical link, the feed id, the sitemap, and `robots.txt`
 * point at a loopback name. A user learns that from this file or from nowhere.
 *
 * Every glob is shown quoted, and the comment says why in one line. YAML's plain
 * scalars are a language and a glob is not written in it — `!README.md` parses
 * to the empty string and `! README.md` parses to `README.md`, which *inverts* a
 * re-include into an exclusion. The loader refuses all of them loudly, so the
 * cost of not knowing is a failed build rather than a leak; the quoting advice
 * is what turns the failed build into no build at all.
 *
 * The example origin is `notes.example.org`: `example.org` is reserved by
 * RFC 2606 for exactly this, so it can never become a real host somebody owns.
 */
export const CONFIG_TEMPLATE = `# ${CONFIG_FILENAME} — every key is optional, and every key below is commented
# out. Delete a "#" to use one. With this file exactly as written, the build
# behaves as though it were not here at all.
#
# Everything in this repository publishes unless you exclude it. There is no
# opt-in; the work is deciding what to withhold.

# The site's name. Reaches the browser tab, the feed, and the social card.
# title: My Notes

# The public address the site will be served from, with no path.
#
# Set this before you deploy. Without it every canonical link, the feed id, the
# sitemap, and robots.txt point at a loopback name that reaches nobody — the
# site builds and looks correct and is unreachable by anything that follows one
# of those links.
# origin: https://notes.example.org/

# Paths not to publish, as gitignore-style globs. "!" re-includes.
#
# Quote every pattern. YAML reads an unquoted "!" as a tag and discards it,
# which turns a rule that keeps a file into one that removes it.
#
# A pattern matching no files fails the build, with no override: a mistyped
# exclusion publishes what it was meant to withhold.
#
# Do not add "dist/**". Every file in a build's output is already dropped as
# not-markdown before exclusion is consulted, so the pattern changes a file's
# reason for being dropped rather than whether it is walked — measured, the
# discovered count goes up by one, not down, because the config file itself is
# then discovered too. Keep build output out of git with .gitignore, which
# this command seeds; exclude is for notes you wrote and do not want published.
# exclude:
#   - "drafts/**"
#   - "private/**"

# A single note can also withhold itself, which no glob can re-include:
#
#   ---
#   publish: false
#   ---
`;

/** What `init` did, for a caller to report. */
export interface InitResult {
  ignore: SeedResult;
  /** `written` when this run created it; `present` when the user already had one. */
  config: 'written' | 'present';
}

/**
 * Parse `init`'s options.
 *
 * One flag, and it is `build`'s: the configuration file must land where the
 * build will look for it. `loadConfig` reads {@link CONFIG_FILENAME} from the
 * **content** directory rather than from the invocation directory, so an `init`
 * with no such flag would write the file at the working directory while a user
 * who then runs `build --content notes` gets a build that silently ignores it.
 * That is this project's recurring failure exactly — a configuration that looks
 * applied and is not — installed by the command whose job is to prevent it.
 *
 * The rejected token is never echoed, for the reason
 * `bin/thoughtscape-publish.mjs` gives at length: a printed argv token must be
 * byte-equal to a spelling this tool's own table declares, and an unrecognised
 * token is by definition not one.
 */
export function parseInitArguments(argv: readonly string[]): { content: string } {
  let content = '.';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--content') {
      throw new BuildFailure('unknown-option', 'unrecognised option for init', argument);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      // `argument` is `--content` by construction — the branch above rejected
      // everything else — so this is a literal of this file's own source.
      throw new BuildFailure('missing-value', `${argument} needs a directory`);
    }
    content = value;
    index += 1;
  }

  return { content };
}

/**
 * Write the starter config, unless the user already has one.
 *
 * **Absent is the only case that writes**, and the check is `existsSync` on the
 * one filename rather than anything cleverer. A near-miss spelling is
 * deliberately not consulted: `loadConfig` refuses a build that finds
 * `publish.config.yml`, by name and with the rename instruction, which is a
 * better outcome than `init` quietly producing a second file beside the one the
 * user meant.
 */
export function writeStarterConfig(contentDirectory: string): 'written' | 'present' {
  const path = join(contentDirectory, CONFIG_FILENAME);
  // `statSync().isFile()` rather than `existsSync`, which answers true for a
  // *directory* of that name: measured, `init` then reported the config as
  // "already present, left unchanged" when there was no config, and the build
  // failed one command later with `exists but could not be read`. `init` is the
  // command whose job is to leave the repository buildable, so it is the wrong
  // command to be silent there.
  //
  // Refused rather than worked around. Removing a directory the user made is not
  // this command's decision, and writing the file beside it is impossible.
  let existing;
  try {
    existing = statSync(path);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new BuildFailure(
      'config-not-a-file',
      `${CONFIG_FILENAME} exists but is not a file, so no configuration can be written or read there. ` +
        'Move or remove it.',
      `${path} is not a regular file`,
    );
  }
  if (existing !== undefined) return 'present';
  writeFileSync(path, CONFIG_TEMPLATE, 'utf8');
  return 'written';
}

/**
 * Seed the ignore rules and the configuration, in that order.
 *
 * The order is the fail-closed one and it is not incidental. `ensureIgnored`
 * throws when git cannot be asked or a probe cannot be trusted — and on that run
 * nothing should have been written yet, because a repository holding a config
 * this tool wrote and no ignore rule is a repository one `git add -A` away from
 * committing `dist/`. Writing the config second means the failure leaves the
 * directory as it was found.
 *
 * `.gitignore` goes to the **repository root** and the config to the **content
 * directory**, which are the same place in the ordinary case and deliberately
 * not the same call: an ignore rule governs a worktree and a config governs the
 * notes it sits with. `ensureIgnored` resolves the root itself, by asking git.
 *
 * **The directory is checked first, before either write.** A mistyped
 * `--content` otherwise reaches `ensureIgnored`, whose `git -C <missing>` exits
 * 128 and is reported as "not a repository" — so `init` would write a
 * `.gitignore` into a directory `writeFileSync` then fails to put the config in,
 * with a raw `ENOENT` carrying the user's own path onto a stream the disclosure
 * rule governs. Measured: `mkdir` on the missing directory is the other option
 * and is worse, because it makes a typo succeed.
 */
export function initialise(contentDirectory: string): InitResult {
  const resolved = resolve(contentDirectory);
  if (!existsSync(resolved)) {
    throw new BuildFailure(
      'content-directory-not-found',
      'content directory not found: the directory named by --content does not exist',
      resolved,
    );
  }

  // **A content directory in no repository is not refused**, and there is
  // deliberately no check here for one "outside the repository". A review
  // proposed it and it cannot be written: `ensureIgnored` resolves the
  // repository root *from the content directory itself*, so the `.gitignore` it
  // seeds always governs the notes it was pointed at — a guard comparing the two
  // would ask whether a directory is inside its own repository, which is true by
  // construction. Measured with the guard in place: it never fired, on any of
  // the three shapes tried.
  //
  // The reviewed symptom was real but is a different arrangement: content and
  // invocation directories both under one repository, which is the ordinary
  // nested case and correctly seeds that repository's root. What that leaves
  // uncovered is the build output under a subdirectory, and `entriesFor` in
  // `seed-gitignore.ts` is what closes it.
  const ignore = ensureIgnored(resolved);
  return { ignore, config: writeStarterConfig(resolved) };
}
