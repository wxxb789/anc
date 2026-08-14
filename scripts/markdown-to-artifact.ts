/**
 * Discovery and exclusion: a git repository of Markdown in, an artifact out.
 *
 * Replaces TK-24's non-recursive bridge. The walk is recursive, the exclusion
 * rules are two mechanisms with a stated precedence, and every file the walk
 * enumerated either becomes an entry or gets a row in the report — so
 * `discovered === published + dropped` holds by construction rather than by
 * three counters agreeing.
 *
 * ## Structural ignores are not patterns, and that is the whole of C3
 *
 * The plan says the shipped defaults `.git/**`, `.obsidian/**` and `**\/.*`
 * "structurally match zero files" because `fs.globSync` cannot match a dotfile,
 * and so fail every user's first push under the zero-match rule. **Measured on
 * Node 24.18.1, that premise is false on both platforms.** `globSync('.obsidian/**')`
 * returns `['.obsidian', '.obsidian/app.json']` on win32 and the same on Linux;
 * `globSync('**\/.*')` returns `['.hidden', '.obsidian']`. There is no dotfile
 * bug to work around and none is worked around here.
 *
 * The split the ticket asks for is still right, for a different reason. A
 * shipped default matching nothing is *normal* — not every repository has an
 * `.obsidian/` — while a user's own pattern matching nothing is a probable typo,
 * and `drafts/**` mistyped as `draft/**` is precisely the mistype that publishes
 * a draft silently. So the two are not two lists of globs with one rule between
 * them: {@link structurallyIgnored} is a *predicate on a name*, evaluated during
 * the walk and never expressed as a pattern at all, and the zero-match rule
 * applies to the user's patterns because they are the only patterns there are.
 * A rule that cannot be written down cannot be mistyped.
 *
 * Pruning during the walk rather than filtering after it is also the only
 * affordable shape: `.git/` and `node_modules/` in a real repository are tens of
 * thousands of files, and a walk that enumerates them to discard them pays for
 * every one.
 *
 * ## Case sensitivity: exact on every platform, and `globSync` is why
 *
 * Every name comparison here — structural ignore, extension, glob — is
 * byte-exact and case-sensitive on win32 and on Linux alike.
 *
 * The measurement that decides it is not about which behaviour is nicer. On
 * win32, `globSync('readme.md')` returns `['readme.md']` in a directory whose
 * only such file is `README.md` — it echoes the *pattern* back as if it were a
 * path, and `readdirSync` does not contain that name. On Linux the same call
 * returns `[]`. So a mistyped-case pattern is green here and red in CI, and any
 * code treating the result as a real path acts on a filename that does not
 * exist. Case-insensitive matching would inherit exactly that divergence.
 *
 * Two consequences, taken deliberately:
 *
 * - **Discovery never calls `globSync`.** The walk is `readdir`, which returns
 *   the names that are actually on disk. Patterns are matched with
 *   `path.matchesGlob`, measured identical on both platforms and case-sensitive
 *   on both (`matchesGlob('README.md', 'readme.md')` is `false` on win32 and on
 *   Linux).
 * - **A differently-cased name is a different name.** `readme.md` at the root is
 *   an ordinary note; only `README.md` is structurally ignored. That is
 *   surprising exactly once, and it is the only rule that gives one answer on
 *   both platforms.
 *
 * ## What this file still does not do, and who owns each
 *
 * No link resolution, no backlink derivation, no ambiguity reporting — TK-27 and
 * TK-28. No git commit dates, no `tags`, no `collection`, no `aliases` — every
 * one is a derived field that needs a decision of its own, and this ticket's
 * scope is discovery, exclusion, and the frontmatter publish flag. `title:` is
 * read because the frontmatter had to be parsed and stripped regardless, and a
 * note whose title lived only in frontmatter would otherwise lose it.
 */

import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, matchesGlob } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateArtifact } from '../src/lib/schema.ts';
import { BuildFailure, type DroppedFile } from './write-report.ts';

/**
 * Names the walk never descends into or enumerates, tested against one path
 * segment.
 *
 * Not a glob, and not configurable — see this file's header. Each is machine
 * state or tool configuration rather than a note a user wrote:
 *
 * - **any dot-prefixed name**, which is configuration by convention, and which
 *   covers `.git/`, `.obsidian/` (workspace state, plugin data, `graph.json`),
 *   `.github/`, and `.gitignore` in one rule rather than four;
 * - **`node_modules`**, which a notes repository acquires from a local preview
 *   and never authors.
 *
 * A structural ignore matching nothing is silent, because most repositories have
 * no `.obsidian/` and a build that failed for that reason would fail on first
 * use for everyone.
 */
function structurallyIgnored(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/**
 * The one file excluded by name rather than by kind: the repository's own
 * README.
 *
 * Root-level only. In a repository adopted by adding a workflow file, the root
 * README carries the badge, the action snippet, and the install steps — it
 * addresses the repository, not the reader. A README *inside* a folder is that
 * folder's index, which is prose, so it is an ordinary note (and reachable here
 * only through the nested branch, which never consults this).
 *
 * Byte-exact, per the header's case rule: `readme.md` is published. Stated in
 * the one place a reader looks for it rather than left to be discovered.
 */
const REPOSITORY_README = 'README.md';

/** Mirrors the slug shape `schema.ts` enforces: lowercase, single hyphens. */
function slugSegment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The repo-relative path, slugified per segment and joined.
 *
 * Per segment and not over the whole string, so a directory boundary survives as
 * a hyphen and `a/b.md` cannot collide with a root-level `a-b.md` for a reason
 * invisible in the source. Empty segments are dropped rather than producing the
 * doubled hyphen `src/lib/schema.ts:64` rejects.
 */
function slugFor(relativePath: string): string | undefined {
  const slug = relativePath
    // Case-sensitive, matching the extension test that admitted this path: only
    // `.md` reaches here, so an `/i` flag would describe a case that cannot
    // occur while contradicting this file's byte-exact rule.
    .replace(/\.md$/, '')
    .split('/')
    .map(slugSegment)
    .filter((segment) => segment !== '')
    .join('-');
  return slug === '' ? undefined : slug;
}

/**
 * Frontmatter, the body without it, and whether the note asked not to be
 * published.
 *
 * Split on the source text rather than through satteri's mdast: the renderer
 * runs with `frontmatter: false` (`src/lib/markdown.ts`), so a block left in
 * `markdown` renders as content — measured before this ticket, a note carrying
 * `publish: false` published the note *and* printed `publish: false` and its
 * frontmatter title into the page. Stripping here is what makes the field a
 * directive instead of prose.
 *
 * A note that *opens* with a thematic break is the case this has to get right,
 * and it took three attempts to find a discriminator that is not itself a bug.
 * Measured, in order:
 *
 * - **Anchoring the delimiter is not enough.** `---\n\nOpens with a break.\n\n---\n`
 *   matches an anchored pattern too, because a break's own two rules look
 *   exactly like a delimited block. That reduced the note to its tail — precisely
 *   `export.py`'s defect reproduced.
 * - **"Must parse as a YAML mapping" is not enough either.** `Status: draft note`
 *   between two breaks *is* a mapping, so an ordinary note opening `Note:` or
 *   `See: https://…` still lost its head; and `**Bold** opener.` is not valid
 *   YAML at all, so it threw `malformed-frontmatter` and **failed the whole
 *   build** on a note that has no frontmatter.
 * - **Satteri's own `yaml` mdast node does not discriminate either**, which is
 *   worth recording because plan §2.2 prescribes it as the fix. Measured: it
 *   reports a `yaml` node with value `"\n**Bold** opener.\n"` for that input.
 *
 * What actually separates them is the blank line. A thematic break is followed
 * by one; a frontmatter block opens immediately with its first key, because a
 * leading blank line is not how anyone writes one and not what any editor emits.
 * So `(?!\s*\r?\n)` after the opening delimiter is the whole test — and it keeps
 * a *malformed* frontmatter block loud, because such a block still opens with a
 * key.
 */
function frontmatterOf(markdown: string): { body: string; data: Record<string, unknown> | undefined } {
  const match = /^---\r?\n(?!\s*\r?\n)([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (match === null) return { body: markdown, data: undefined };

  const raw = match[1] ?? '';
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    // Loud, and this is H2's first half. A YAML error *anywhere* in the block
    // would otherwise take `publish: false` down with it silently: the parse
    // fails, the field is never read, and the note the user withheld is
    // published. Failing the whole build is the only outcome that cannot
    // publish something by accident.
    //
    // No filename in the public half — a withheld note's name is the disclosure
    // (TK-25 §2.4) and this reaches a world-readable log. The name goes to the
    // report, where the person who can act on it reads it.
    throw new FrontmatterError(
      'malformed-frontmatter',
      'malformed YAML frontmatter — a parse error here would silently discard a ' +
        '`publish: false` in the same block, so the build stops. See the report for the file.',
      error instanceof Error ? error.message : String(error),
    );
  }

  // A scalar or a list opened with no blank line — `---\njust a sentence\n---` —
  // is not a frontmatter block and cannot carry `publish:`. Leave the body
  // intact rather than deleting content the user wrote.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { body: markdown, data: undefined };
  }
  return { body: markdown.slice(match[0].length), data: parsed as Record<string, unknown> };
}

/**
 * A frontmatter fault, carrying the private half the report prints.
 *
 * Separate from {@link BuildFailure} only so the walk can attach the path of the
 * offending file — which the thrower does not know — before it reaches the
 * boundary as one.
 */
class FrontmatterError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, message: string, detail: string) {
    super(message);
    this.name = 'FrontmatterError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Whether a note asked not to be published, refusing every near-miss loudly.
 *
 * H2's second half, and the measurement behind it: `yaml` parses `publish: no`
 * to the **string** `'no'`, `publish: off` to `'off'`, `publish: "false"` to
 * `'false'`, and `publish: 0` to `0`. YAML 1.2 dropped YAML 1.1's `no`/`off`
 * booleans, so every one of those is a user writing "do not publish" and getting
 * a truthy non-boolean that a `=== false` test reads as consent. Each publishes
 * the note.
 *
 * So the field is boolean or the build stops. There is no coercion table: a
 * coercion table is a list of spellings that silently work, and the next
 * spelling nobody listed publishes the note anyway. `publish: true` is accepted
 * and does **not** override an exclusion — §2.3's asymmetry, and the reason for
 * it is that the two failure modes are not equal. A note the user meant to
 * publish and did not is an inconvenience they will notice; a note they meant to
 * withhold and published is irreversible once it is on a CDN and in a search
 * index.
 */
function publishFlag(data: Record<string, unknown> | undefined): boolean | undefined {
  if (data === undefined || !('publish' in data)) return undefined;
  const value = data['publish'];
  if (typeof value === 'boolean') return value;

  throw new FrontmatterError(
    'non-boolean-publish-flag',
    'frontmatter `publish:` must be `true` or `false` — YAML 1.2 reads `no`, `off`, ' +
      '`"false"` and `0` as a string or a number, not as a boolean, and a note meaning ' +
      'to withhold itself would publish. See the report for the file.',
    `publish: ${JSON.stringify(value)} (${typeof value})`,
  );
}

/**
 * The first heading's text, or the filename.
 *
 * A title is required and must be non-empty, and the renderer removes a leading
 * `# Title` that matches the page title — so taking it from the body is what
 * makes an ordinary note render with its heading once rather than twice.
 */
function titleFor(markdown: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || fallback;
}

/** Prose, collapsed and bounded, for the card and the meta description. */
function excerptFor(markdown: string): string {
  const prose = markdown
    .replace(/^#.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return prose.length > 200 ? `${prose.slice(0, 200).trimEnd()}…` : prose;
}

/**
 * Every file under the root, depth-first and sorted at each level, with
 * structurally ignored names pruned.
 *
 * Sorted because glob and `readdir` order are both unspecified and determinism
 * is a hard constraint — measured, win32 and Linux return different orders for
 * the same directory, and a slug collision's winner is decided by this order.
 * Sorting per level rather than over the whole result keeps a directory's files
 * adjacent to it, which is what makes the collision winner predictable from the
 * tree rather than from the flattening.
 *
 * Paths are joined with `/` explicitly rather than with `path.join`:
 * `matchesGlob` is separator-literal — measured, `matchesGlob('a\\b.md', 'a/**')`
 * is `false` on win32 — so a native-separator path would silently match no
 * pattern at all on the platform where the user is most likely to be testing.
 */
async function walk(root: string, prefix = ''): Promise<string[]> {
  const entries = (await readdir(prefix === '' ? root : `${root}/${prefix}`, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const found: string[] = [];
  for (const entry of entries) {
    if (structurallyIgnored(entry.name)) continue;
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    // `isFile()` alone is not the file test, and the comment that used to sit
    // here said it was. Measured on win32 (Node 24.18.1): a symlink to
    // `real.md` reports `isFile() === false` and `isSymbolicLink() === true`
    // under `withFileTypes`, so an `isFile()`-only branch put a symlinked note
    // in **neither** `discovered` nor `dropped` — it left the partition
    // silently, which is the one outcome the report cannot express. TK-25 §4.2
    // records the opposite as measured; it is wrong on this platform.
    //
    // So a symlink is resolved by asking the filesystem what it points at.
    // `stat` follows the link where `readdir` did not, and a broken link throws
    // rather than answering — which is a file that is not there, so it is
    // pruned like a directory rather than counted.
    if (entry.isDirectory()) {
      found.push(...(await walk(root, relativePath)));
      continue;
    }
    if (entry.isFile()) {
      found.push(relativePath);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;

    const target = await stat(`${root}/${relativePath}`).catch(() => undefined);
    // A symlinked *directory* is deliberately not descended into: a link may
    // point at an ancestor, and a walk that follows one does not terminate.
    // Enumerating it as a file would be worse than skipping it, so it is
    // treated exactly as a real directory's own entry is — pruned, in neither
    // column, because "the tool declined to follow" is not a fact about a file
    // the user wrote.
    if (target?.isFile() === true) found.push(relativePath);
  }
  return found;
}

/**
 * A user's exclusion patterns and where they came from.
 *
 * The seam TK-30 fills. Until it lands the caller passes patterns explicitly or
 * passes nothing, and no config format is invented here — a format guessed by
 * this ticket is a format TK-30 would have to keep or break.
 *
 * `excludeSource` is a *config location* and never a path the build discovered.
 * It reaches stderr, where TK-25 §2.1 admits a config filename and an index and
 * admits nothing else — so it is validated against {@link CONFIG_LOCATION}
 * rather than trusted. "The caller passed it" is not a safety argument, for the
 * same reason `tests/disclosure.test.ts` records that "the user typed it" is
 * not: a withheld note's stem is a perfectly good string to pass here by
 * accident, and this module cannot see where its caller got one.
 *
 * The pattern's own text is deliberately never printed with it — a
 * gitignore-style pattern may be a bare path, so echoing it re-admits the exact
 * disclosure string that rule exists to withhold.
 */
export interface ExclusionOptions {
  /** Gitignore-style globs, last match wins, `!` re-includes. */
  exclude?: readonly string[];
  /** What to call the patterns' origin in a message, e.g. `publish.config.ts`. */
  excludeSource?: string;
}

/**
 * A bare configuration filename, which is the only shape allowed onto a stream.
 *
 * Tighter than "no separators", and the loose version was measured admitting
 * exactly the hazard the field exists to exclude: `/^[A-Za-z0-9._-]+$/` accepts
 * `zzqsecret-client.md` and `zzq2026-layoffs`, which are a withheld note's
 * filename and its stem. So the shape required is a *known configuration file
 * extension* — a stem alone is refused, and a note's `.md` is not on the list.
 *
 * A caller passing anything else gets the fixed literal instead of its string,
 * silently, because refusing the build over a diagnostic's own label would fail
 * a run that had nothing else wrong with it.
 */
const CONFIG_LOCATION = /^[A-Za-z0-9._-]+\.(?:ts|js|mjs|cjs|json|ya?ml|toml)$/;

/**
 * Whether the last pattern to mention this path re-included it.
 *
 * Only the default-excluded root README consults this, and it is what makes
 * plan §2.2's "re-includable with `!README.md`" true. `excludes` cannot answer
 * it: a path no pattern touches and a path whose last rule was a `!` both come
 * back `false`, and those are opposite answers to "did the user ask for this
 * file back".
 *
 * No `matched` argument: the recording already happened in the `excludes` call
 * this run made for the same path, and marking a pattern twice would let a
 * `!README.md` that matched nothing else look used.
 */
function reincluded(relativePath: string, patterns: readonly string[]): boolean {
  let answer = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (matchesGlob(relativePath, negated ? pattern.slice(1) : pattern)) answer = negated;
  }
  return answer;
}

/**
 * Which patterns matched a path, and the verdict of the last one to do so.
 *
 * Every match is recorded, not just the decisive one: a pattern shadowed by a
 * later rule has still done its job of proving it was not a typo, so the
 * zero-match check does not depend on rule order.
 *
 * `matched` is written through rather than returned because the caller
 * accumulates it across every discovered path — the question the zero-match rule
 * asks is about the corpus, not about any one file.
 */
function excludes(
  relativePath: string,
  patterns: readonly string[],
  matched: boolean[],
): boolean {
  let verdict = false;
  for (const [index, pattern] of patterns.entries()) {
    const negated = pattern.startsWith('!');
    // `matchesGlob` has no negation of its own — measured, `matchesGlob('a/b.md',
    // '!a/**')` is `false` rather than an inversion — so the `!` is stripped here
    // and the sense is applied to the verdict.
    const body = negated ? pattern.slice(1) : pattern;
    if (!matchesGlob(relativePath, body)) continue;
    matched[index] = true;
    verdict = !negated;
  }
  return verdict;
}

/**
 * Walk a repository, apply both exclusion mechanisms, and say what was left out.
 *
 * Discovery only: the artifact is **not** validated here, because the caller has
 * to be able to record what was discovered before the contract can reject any of
 * it. That ordering is the whole reason a run which fails the contract still
 * leaves a report naming the files it dropped.
 *
 * `outgoing` and `backlinks` are empty for every entry: the contract requires
 * backlinks to be the exact inverse of outgoing links, and deriving either needs
 * the link resolution TK-27 specifies. Empty is the only pair that is honest and
 * that validates.
 *
 * **Enumerate first, classify inside.** Every path {@link walk} returned is
 * `discovered`, and leaves with either an entry or a `DroppedFile` row — so
 * `discovered === published + dropped` is a property of the loop rather than of
 * three counters. A structurally ignored name is in neither, for the same reason
 * a directory is in neither: "the tool declined to look" is not a fact about a
 * file the user wrote.
 *
 * **Exclusion precedence, and it is not symmetric.** Frontmatter `publish: false`
 * is rank 1 and unconditional — a `!` re-include cannot resurrect it — and the
 * glob rules are rank 2. The mechanism pointing toward *not* publishing is the
 * three words inside the file itself, nearest the content, and it always wins.
 */
export async function discover(contentDirectory: string, options: ExclusionOptions = {}): Promise<Discovery> {
  const patterns = options.exclude ?? [];
  const matched = patterns.map(() => false);
  const paths = await walk(contentDirectory);

  /** Slug to the path that claimed it, so a collision can name its winner. */
  const claimed = new Map<string, string>();
  const dropped: DroppedFile[] = [];
  const entries = [];

  for (const path of paths) {
    // **Every discovered path is offered to every pattern, before any drop.**
    // Not a reordering for tidiness: with the `not-markdown` drop ahead of this,
    // a non-Markdown file was `discovered` and yet never seen by a pattern, so
    // `exclude: ['assets/**']` on a repository whose `assets/` holds only images
    // matched nothing and failed the build. Measured — excluding an asset folder
    // is the ordinary case in a notes repository, and it was unbuildable.
    //
    // Plan §2.3 states the rule this restores: "'Matched' means the pattern
    // returned true for at least one *discovered* path, whatever the final
    // verdict was." A file dropped for another reason is still discovered.
    const excluded = excludes(path, patterns, matched);

    if (!path.endsWith('.md')) {
      dropped.push({ path, reason: 'not-markdown' });
      continue;
    }

    // The root README is excluded by default and, per plan §2.2, is
    // "re-includable with `!README.md`" — so the default yields to a user's
    // negation rather than preceding it. `excludes` returning false for a path
    // no pattern touched is why this cannot simply test `excluded`: the question
    // is whether the user *said* something about this path, not what the last
    // rule concluded about every path.
    if (path === REPOSITORY_README && !reincluded(path, patterns)) {
      dropped.push({ path, reason: 'repository-readme' });
      continue;
    }

    // Rank 2, and the read is still below it: an excluded note's bytes are not
    // needed, and not reading them is one fewer way for its contents to reach
    // anything. Rank 1 overrides this below — the read happens for a published
    // candidate only, so the two ranks are ordered by outcome rather than by
    // which test runs first.
    if (excluded) {
      dropped.push({ path, reason: 'excluded-by-pattern' });
      continue;
    }

    const source = (await readFile(`${contentDirectory}/${path}`, 'utf8')).replace(/\r\n/g, '\n');
    let parsed;
    let published;
    try {
      parsed = frontmatterOf(source);
      published = publishFlag(parsed.data);
    } catch (error) {
      // The thrower knows the fault and not the file; the walk knows the file
      // and not the fault. Joining them here is what lets the public half stay
      // nameless while the report gets a detail a user can act on.
      if (error instanceof FrontmatterError) {
        throw new BuildFailure(error.code, error.message, `${path}: ${error.detail}`);
      }
      throw error;
    }

    if (published === false) {
      dropped.push({ path, reason: 'excluded-by-frontmatter' });
      continue;
    }

    const slug = slugFor(path);
    if (slug === undefined) {
      dropped.push({ path, reason: 'empty-slug' });
      continue;
    }

    // A duplicate slug fails the contract, so two files that collide would fail
    // the build with a schema error naming neither file. Dropping the second is
    // no better as an answer — plan D1 gives ambiguity to TK-27 — but it fails
    // understandably here rather than confusingly, and the report says which
    // file lost and to which. The winner is the first in the sorted walk, which
    // is why the walk sorts.
    const winner = claimed.get(slug);
    if (winner !== undefined) {
      dropped.push({ path, reason: 'slug-collision', collidedWith: winner });
      continue;
    }
    claimed.set(slug, path);

    const title = typeof parsed.data?.['title'] === 'string' ? parsed.data['title'].trim() : '';
    entries.push({
      slug,
      title: title || titleFor(parsed.body, slug),
      excerpt: excerptFor(parsed.body),
      markdown: parsed.body,
      outgoing: [],
      backlinks: [],
    });
  }

  // After the walk, because a pattern's verdict is "did it match any discovered
  // path", and that is not known until every path has been offered to it. Before
  // the artifact is written, because a typo'd exclusion is exactly the fault that
  // must stop a publication rather than be reported after one.
  const idle = matched.flatMap((hit, index) => (hit ? [] : [index]));
  if (idle.length > 0) {
    const source = options.excludeSource;
    const where = source !== undefined && CONFIG_LOCATION.test(source) ? source : 'the exclude list';
    // The index and the config location, never the pattern's text: a
    // gitignore-style pattern may be a bare path, so `exclude[3]` on a public log
    // and the text in the report is the split TK-25 §2.3 requires. The user opens
    // their own file at that index and reads their own pattern there.
    throw new BuildFailure(
      'exclusion-pattern-matched-nothing',
      `${where} — ${idle.map((index) => `exclude[${index}]`).join(', ')} matched 0 files. ` +
        'A pattern that matches nothing is usually a typo, and a mistyped exclusion ' +
        'publishes what it was meant to withhold. Correct it, or delete it.',
      idle.map((index) => `exclude[${index}] = ${JSON.stringify(patterns[index])}`).join('; '),
    );
  }

  return {
    entries,
    counts: { discovered: paths.length, published: entries.length, dropped: dropped.length },
    dropped,
  };
}

/**
 * What one repository yielded: the entries to validate, and what was left out.
 *
 * `entries` is deliberately the unvalidated shape. Discovery does not call
 * `validateArtifact`, because the caller has to be able to record what was
 * discovered *before* the contract can reject any of it — that ordering is the
 * whole reason a run which fails the contract still leaves a report naming the
 * files it dropped.
 */
export interface Discovery {
  entries: ContentEntryInput[];
  counts: { discovered: number; published: number; dropped: number };
  dropped: DroppedFile[];
}

/** One candidate entry, before the contract has judged it. */
interface ContentEntryInput {
  slug: string;
  title: string;
  excerpt: string;
  markdown: string;
  outgoing: string[];
  backlinks: string[];
}

/**
 * Validate what discovery produced, and write it where the build will read it.
 *
 * Split from {@link discover} rather than taking a callback, so the caller can
 * put its own work between the two — which is exactly what the report needs: a
 * caller records the counts and the dropped rows, and only then asks for the
 * artifact. A callback would have hidden that ordering inside this module,
 * where nothing depends on it.
 */
export async function writeArtifact(discovery: Discovery, destination: string): Promise<void> {
  if (discovery.entries.length === 0) {
    // Thrown here rather than at the end of `discover`, and that ordering is
    // load-bearing: a directory holding only a `.pdf` and a filename that
    // slugifies to nothing is exactly the corpus the report exists for, and
    // throwing before the caller could record the counts left that run's report
    // saying `aborted` with three zeroes — the one shape a reader cannot act on.
    //
    // No path in the message: the content directory is a host path the user did
    // not type in this form, and this reaches a workflow log. The flag spelling
    // is a literal of this tool's own source, identical in every run.
    throw new BuildFailure(
      'no-markdown-found',
      'no Markdown found — this build reads *.md from the directory named by --content',
    );
  }

  // A source literal, not the content directory: `ContentValidationError`
  // prefixes its message with this, and that message reaches a stream.
  const artifact = validateArtifact({ version: 1, entries: discovery.entries }, 'content directory');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
