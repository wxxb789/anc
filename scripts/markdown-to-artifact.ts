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
 * The link pass below derives backlinks. `aliases` remain underived. Tracked
 * notes take `created` and `updated` from the first and last visible commits.
 * Frontmatter can supply `slug`, `language`/`lang`, `description`,
 * and `tags`; the first folder becomes the flat `collection`. All reuse fields
 * and routes the site already owns. `title:` is read because the frontmatter
 * had to be parsed and stripped regardless.
 *
 * ## Link resolution runs after the whole walk, and that ordering is forced
 *
 * TK-27 resolves links against the **full** file set — every discovered file,
 * published or not — because a link to a note the user excluded and a link to
 * nothing at all are different events with different fixes, and resolving
 * against the published set only would merge them. The full set does not exist
 * until the walk finishes, so the traversal cannot run inside the loop that
 * builds it. See {@link resolveCorpusLinks}.
 */

import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, matchesGlob } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FIELD_LIMITS, RESERVED_SLUGS, isLanguageTag, isSlug, validateArtifact } from '../src/lib/schema.ts';
import { indexCorpus, type CorpusFile } from '../src/lib/link-resolution.ts';
import { BuildFailure, bySourceThenLine, type DroppedFile, type LinkFindingRow } from './write-report.ts';

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
 * First folder as the flat collection key the existing artifact contract accepts.
 *
 * The collection field is still an ASCII `SLUG`, unlike Unicode tag route keys.
 * A folder that yields no such key leaves the note uncollected rather than
 * rejecting a repository that already publishes; widening that field is a
 * schema decision, not transliteration for this producer to invent.
 */
function collectionFor(relativePath: string): string | undefined {
  const separator = relativePath.indexOf('/');
  if (separator === -1) return undefined;
  const collection = slugSegment(relativePath.slice(0, separator));
  return collection === '' ? undefined : collection;
}

/** Read a YAML tag list without silently coercing scalars or whitespace. */
function tagsFor(data: Record<string, unknown> | undefined, path: string): string[] | undefined {
  const value = data?.['tags'];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim() === '' || item !== item.trim())
  ) {
    throw new BuildFailure(
      'invalid-tags-frontmatter',
      'frontmatter tags must be a YAML list of non-empty text',
      `${path}: tags must be written as a YAML list whose members are non-empty strings`,
    );
  }
  return value.length === 0 ? undefined : [...value] as string[];
}

function slugOverrideFor(data: Record<string, unknown> | undefined, path: string): string | undefined {
  const value = data?.['slug'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isSlug(value) || value.length > FIELD_LIMITS.strings.slug) {
    throw new BuildFailure(
      'invalid-slug-frontmatter',
      'frontmatter slug must be a lowercase public route key',
      `${path}: slug must use lowercase ASCII letters, digits, and single interior hyphens`,
    );
  }
  return value;
}

function languageFor(data: Record<string, unknown> | undefined, path: string): string | undefined {
  const language = data?.['language'];
  const lang = data?.['lang'];
  for (const [field, value] of [
    ['language', language],
    ['lang', lang],
  ] as const) {
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      value !== value.trim() ||
      !isLanguageTag(value) ||
      value.length > FIELD_LIMITS.strings.language
    ) {
      throw new BuildFailure(
        'invalid-language-frontmatter',
        'frontmatter language must be a BCP 47 tag',
        `${path}: ${field} must be a BCP 47 tag such as en, zh-CN, or zh-Hans-CN`,
      );
    }
  }

  const preferred = language as string | undefined;
  const short = lang as string | undefined;
  if (preferred !== undefined && short !== undefined && preferred.toLowerCase() !== short.toLowerCase()) {
    throw new BuildFailure(
      'conflicting-language-frontmatter',
      'frontmatter lang and language must name the same locale',
      `${path}: lang and language disagree; keep one key or make their BCP 47 tags equal`,
    );
  }
  // `language` is the artifact field and therefore owns the spelling when both
  // equivalent keys exist. BCP 47 comparison itself is case-insensitive.
  return preferred ?? short;
}

function descriptionFor(data: Record<string, unknown> | undefined, path: string): string | undefined {
  const value = data?.['description'];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > FIELD_LIMITS.strings.description
  ) {
    throw new BuildFailure(
      'invalid-description-frontmatter',
      'frontmatter description must be non-empty text',
      `${path}: description must be a non-empty string`,
    );
  }
  return value;
}

interface GitDates {
  created?: string;
  updated: string;
}

/**
 * First and last commit dates for current paths, from one history scan.
 *
 * Git emits newest commits first. The first date seen for a path is `updated`;
 * each older one replaces `created`. A shallow clone cannot establish creation,
 * so it emits only the latest visible update rather than asserting a false first
 * date. Dates use the committer timestamp, so a rebase may change them, and the
 * scan follows current path names rather than identities across renames. Merge
 * commits use Git's default no-diff view; their ordinary side commits still
 * count, while a resolution-only edit does not move `updated`. `-z` both keeps
 * non-ASCII names unquoted and uses NUL boundaries; names remain `/`-separated
 * on every platform, matching the walk. Outside git, for untracked files, or
 * after the 30-second/64 MiB bounds, the map is empty and the existing undated
 * behavior remains.
 */
function gitDatesFor(contentDirectory: string, paths: readonly string[]): ReadonlyMap<string, GitDates> {
  const options = {
    cwd: contentDirectory,
    encoding: 'utf8' as const,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  };
  const shallowProbe = spawnSync('git', ['rev-parse', '--is-shallow-repository'], options);
  if (shallowProbe.status !== 0) return new Map();
  const shallow = shallowProbe.stdout.trim() === 'true';
  const history = spawnSync(
    'git',
    [
      '--no-pager',
      'log',
      '-z',
      '--format=%x1e%cI',
      '--name-only',
      '--relative',
      '--',
      '.',
    ],
    options,
  );
  if (history.status !== 0) return new Map();

  const wanted = new Set(paths);
  const dates = new Map<string, GitDates>();
  let commitDate: string | undefined;
  for (const raw of history.stdout.split('\0')) {
    if (raw.startsWith('\x1e')) {
      const candidate = raw.slice(1).trim();
      commitDate = Number.isNaN(Date.parse(candidate)) ? undefined : candidate;
      continue;
    }
    if (commitDate === undefined) continue;
    const path = raw.startsWith('\r\n') ? raw.slice(2) : raw.startsWith('\n') ? raw.slice(1) : raw;
    if (path === '' || !wanted.has(path)) continue;
    const previous = dates.get(path);
    dates.set(path, {
      updated: previous?.updated ?? commitDate,
      ...(shallow ? {} : { created: commitDate }),
    });
  }
  return dates;
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
 * A link's text, with its syntax removed — for the two fields that are read as
 * plain text rather than rendered.
 *
 * `title` and `excerpt` are derived from the *rewritten* Markdown, so every
 * internal link in them is already `[label](/route/)`. Neither field goes
 * through the Markdown pipeline: the excerpt lands verbatim in
 * `content-index.json`, in `rss.xml`, and in the `<meta name="description">` of
 * every page showing the card, and the title lands in `<title>` and `og:title`.
 * Measured before this existed — a heading and a body each containing one
 * ordinary link:
 *
 * ```
 * <title>See [beta](/beta/) now · Notes</title>
 * <meta name="description" content="See [beta](/beta/) for the numbers.">
 * ```
 *
 * Brackets and a route in a reader's search result, on every build with a link
 * in a first heading or first paragraph. This is the same defect `aab694b`
 * fixed for code spans, in the same function, and that fix stripped backticks
 * and stopped.
 *
 * **The label is kept and the destination dropped**, which is what a reader
 * would have seen had the field been rendered. That is also why this cannot be
 * "delete the whole construct": the label is the author's prose.
 *
 * **Applied repeatedly until it stops changing**, because a badge is a link
 * whose label is an image — `[![logo](/private/)](/t/)` — and one pass leaves
 * the outer construct behind.
 *
 * The label pattern admits `\]`, which `scripts/resolve-links.ts` writes when an
 * author's own label contains a bracket; those escapes are unescaped afterwards,
 * since a reader of a plain-text field should see the bracket rather than the
 * backslash. A reference link (`[text][ci]`) is deliberately untouched: nothing
 * here resolves one, so its definition may not even be in this note, and
 * dropping the syntax would assert a resolution this module never made.
 */
function withoutLinkSyntax(markdown: string): string {
  let text = markdown;
  for (;;) {
    // No whitespace and no parens in the destination, so ordinary prose such as
    // "the array [a] (see below)" is not mistaken for a link.
    const next = text.replace(/!?\[((?:[^\][\\]|\\.)*)\]\([^()\s]*\)/g, '$1');
    if (next === text) break;
    text = next;
  }
  return text.replace(/\\([[\]])/g, '$1');
}

/**
 * Every math expression removed, and the punctuation it stranded repaired.
 *
 * ## Why an excerpt carries nothing for an expression
 *
 * This is a judgement and the alternatives were read as a reader gets them,
 * because the sentence on the page is the whole of the evidence:
 *
 * | | `The identity $$\frac{a}{b}$$ holds.` | `Consider $$…$$. It follows.` |
 * | --- | --- | --- |
 * | keep the TeX (today) | `The identity $$\frac{a}{b} = \sqrt{c}$$ holds.` | `Consider $$\frac{\partial \mathcal{L}}{\partial \theta} = 0$$. It follows.` |
 * | drop it, no repair | `The identity holds.` | `Consider . It follows.` |
 * | a `[math]` placeholder | `The identity [math] holds.` | `Consider [math]. It follows.` |
 * | **drop and repair** | `The identity holds.` | `Consider. It follows.` |
 *
 * **Keeping the TeX is what ships today and it is the worst of the four.** An
 * excerpt is plain text on a card, in `rss.xml`, and in every page's
 * `<meta name="description">` — `\frac{\partial \mathcal{L}}{\partial \theta}`
 * is noise in all three, and it crowds out the prose that would have told a
 * reader what the note is about.
 *
 * **A placeholder was rejected**, though it reads well. `[math]` is a chrome
 * string minted in the producer, which is outside the components TK-16's
 * bilingual sweep covers — so a zh-CN note would carry an English marker in its
 * own description. Translating it would put a locale lookup in a module that has
 * no document language to look up. And it is not free of judgement either: it
 * asserts to a reader that something was removed, which is a claim about the
 * note the excerpt is not otherwise in the business of making.
 *
 * **What is dropped is a real loss, stated plainly**: a note whose sentence is
 * mostly one expression yields a thinner excerpt than it deserves, and
 * `$$E = mc^2$$ is the relation everyone knows.` becomes
 * `is the relation everyone knows.` — a sentence starting mid-clause. There is
 * no rendered form available at this stage to substitute, because the excerpt is
 * derived from Markdown before any renderer runs. Given that, the honest options
 * were the four above and this is the least bad.
 *
 * It also makes the two delimiter forms agree. A ```` ```math ```` fence already
 * produces exactly this today — fenced code is stripped a line above — so the
 * change is that `$$…$$` stops being the exception rather than that anything new
 * starts happening.
 *
 * ## What counts as math, taken from the renderer rather than guessed
 *
 * `renderMarkdown` sets `singleDollarTextMath: false`, so a single `$` is not a
 * delimiter and ordinary prices are left alone. Verified rather than trusted —
 * measured through the real renderer: `It costs $5 and then $10 later.` sets
 * `hasMath: false`, and `The price is $$ and rising.` does too, because an
 * unpaired `$$` is not a span. Both survive this function unchanged.
 *
 * `From $$5 to $$10 in a year.` *does* parse as math — the two `$$` pair up
 * across the prose between them — and is stripped here in consequence. That is
 * the renderer's reading and this follows it: an excerpt disagreeing with the
 * page about what is math would be a second, quieter defect.
 *
 * ## The seam
 *
 * Removing a span strands whatever punctuation surrounded it. A space before a
 * comma or a stop is an artefact of the removal rather than anything the author
 * wrote, so it is closed up; a bracket left holding nothing — `($$\alpha$$)`
 * becoming `()` — is the same artefact in a worse form, and goes entirely.
 *
 * **The span is found once, and the seam is decided from its own boundaries.**
 * That shape is forced by two defects a chained-regex version had, both found by
 * review and both measured through the producer:
 *
 * - A rule that looked for the span *and* its trailing punctuation in one match
 *   backtracked past the closing `$$` to find one. Measured:
 *   `The bound is $$\alpha$$ and the limit is $$\beta$$.` came out as
 *   `The bound is.` — eight words of the author's prose eaten, on what is the
 *   ordinary shape of a sentence in a maths note. The docstring claimed the
 *   repair was "structurally unable to reach prose it did not just alter", and
 *   a lazy quantifier with a forced trailing anchor is not bounded at all.
 * - A rule deleting `()` and `[]` across the whole string fired on notes with no
 *   math in them: `The function main() returns zero, and init() does not.`
 *   became `The function main returns zero, and init does not.`, and a GFM
 *   `- [ ]` task marker vanished. Deciding it at the removal site makes it
 *   reachable only by text this function just changed.
 *
 * A `while` loop with `lastIndex` rather than `replace`, because the decision
 * needs the characters on both sides of the match and a replacer callback does
 * not get them.
 */
function withoutMath(markdown: string): string {
  const span = /\$\$[\s\S]*?\$\$/g;
  let result = '';
  let read = 0;
  let match: RegExpExecArray | null;

  while ((match = span.exec(markdown)) !== null) {
    const before = markdown.slice(read, match.index);
    const after = markdown.slice(span.lastIndex);

    // Whitespace either side of the span belongs to the seam rather than to the
    // prose, and is taken with it. What replaces the whole seam is decided by
    // what sits immediately outside: a space, unless the removal would leave a
    // gap before punctuation or inside a bracket, where it would be visible.
    const leading = /\s*$/.exec(before)?.[0].length ?? 0;
    const trailing = /^\s*/.exec(after)?.[0].length ?? 0;
    const prose = before.slice(0, before.length - leading);
    const next = after[trailing];

    // A bracket pair whose entire content was the expression is an artefact of
    // the removal, not the author's — but only when *this* removal emptied it.
    const opensHere = /[([]$/.test(prose);
    const closesNext = next !== undefined && /[)\]]/.test(next);
    if (opensHere && closesNext) {
      result += prose.slice(0, -1);
      read = span.lastIndex + trailing + 1;
      continue;
    }

    const joinTight = next !== undefined && /[.,;:!?)\]]/.test(next);
    result += prose + (prose === '' || joinTight ? '' : ' ');
    read = span.lastIndex + trailing;
  }

  const stripped = result + markdown.slice(read);
  // **An unpaired `$$` still ships, so it is removed too.** The renderer pairs
  // delimiters left to right and leaves a leftover one as literal text — so
  // `A $$x$$ b $$ c, and $$y$$ done.` renders with a visible `$$`, and the loop
  // above, which pairs the same way, leaves the same one behind. It is exactly
  // the byte this whole function exists to keep out of a description, and the
  // page carrying it too is a separate defect rather than a licence to ship it
  // here. What is left is the delimiter alone; the author's surrounding words
  // are untouched.
  return stripped.replace(/\$\$/g, '');
}

/**
 * The first heading's text, or the filename.
 *
 * A title is required and must be non-empty, and the renderer removes a leading
 * `# Title` that matches the page title — so taking it from the body is what
 * makes an ordinary note render with its heading once rather than twice.
 *
 * Link syntax is stripped for the reason {@link withoutLinkSyntax} gives: this
 * value reaches `<title>` and `og:title` as plain text, and a heading may carry
 * a link like any other line.
 *
 * **Math goes the same way, and the title path had the defect too** — checked
 * rather than assumed, because `4cae152` found `titleFor` shared the link-syntax
 * defect and this is the third repair of the same shape. Measured before the
 * fix: `# The $$\alpha$$ theorem` produced the title `The $$\alpha$$ theorem`,
 * which reaches `<title>`, `og:title`, and the browser tab.
 *
 * The whitespace collapse is this path's own. `excerptFor` collapses as its last
 * step and a title never went through one, because nothing it stripped used to
 * leave a gap mid-line — a removed expression does. Measured without it:
 * `The   theorem`, three spaces, in the browser tab.
 *
 * **Code spans are removed first, exactly as `excerptFor` does**, and a first
 * version of this omitted them while its own comment defended the ordering that
 * only the other function had. Measured: `` # Writing `$$x$$` in a note ``
 * rendered as `Writing $$x$$ in a note` on the page — the renderer treats a
 * backticked `$$` as code, not math — while the title came back
 * ``Writing ` ` in a note``: the author's example eaten *and* stray backticks
 * shipped into `<title>` and `og:title`, which is the defect `aab694b` fixed for
 * excerpts arriving on the other surface.
 */
function titleFor(markdown: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  const stripped =
    heading === undefined
      ? ''
      : withoutMath(withoutLinkSyntax(heading.replace(/`[^`\n]*`/g, '')))
          .replace(/\s+/g, ' ')
          .trim();
  return stripped || fallback;
}

/**
 * Prose, collapsed and bounded, for the card and the meta description.
 *
 * **Inline code is stripped as well as fenced, and the reason is a build break
 * rather than tidiness.** An excerpt is not rendered through the Markdown
 * pipeline — it lands verbatim in `content-index.json`, in `rss.xml`, and in the
 * `<meta name="description">` of every page that shows the card. Those surfaces
 * carry no `<code>` element, so the residue scan's code-region exemption cannot
 * see them, and a note writing ``Inline `[[syntax]]` is how you write it.``
 * exited 1 with `contains unresolved [[wikilink]]` against four files. Measured
 * on the shipped binary: a *fenced* example built clean and the inline form did
 * not, which is the asymmetry this line removes.
 *
 * A note documenting wikilink syntax is this tool's own audience, so the break
 * was on exactly the content it exists to publish.
 *
 * Stripped rather than exempted downstream: the excerpt is a projection of the
 * prose, and a code span is not prose. Widening the scanner's exemption instead
 * would have admitted a genuinely unresolved `[[wikilink]]` — the producer
 * defect that rule exists to catch — which is the repair this rule has already
 * had twice.
 *
 * **Link syntax goes the same way and for the same reason**, one commit later
 * and found the same way: the fix above stripped backticks and stopped, so
 * every build shipped `See [beta](/beta/) for the numbers.` into the meta
 * description. See {@link withoutLinkSyntax}. Code spans are removed *before*
 * links, so a note documenting `` `[label](/route/)` `` loses the span whole
 * rather than having its example rewritten into prose.
 *
 * **And math, one ticket later again, found by measuring the three surfaces
 * rather than by a build break.** `The identity $$\frac{a}{b} = \sqrt{c}$$
 * holds.` shipped verbatim into `content-index.json`, `rss.xml`, and every meta
 * description. See {@link withoutMath} for what an excerpt carries instead and
 * what that costs.
 *
 * **Ordered last, after the code strips.** A note documenting math syntax writes
 * `` `$$x^2$$` `` or a fenced block, and the renderer treats neither as math —
 * measured, `hasMath` is `false` for both. Stripping code first means this
 * function never sees them, so the excerpt agrees with the page about which
 * dollar signs were delimiters. Reversing the order would eat an author's
 * example out of a note about writing math.
 */
function excerptFor(markdown: string): string {
  const prose = withoutMath(
    withoutLinkSyntax(
      markdown
        .replace(/^#.*$/gm, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, ''),
    ),
  )
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
 * `backlinks` is the mechanical inverse of `outgoing`, derived in
 * {@link resolveCorpusLinks} because `checkCorpus` rejects any artifact where it
 * is not — so a producer emitting only one direction makes every repository with
 * an internal link unbuildable. Deriving the array is all this ticket does with
 * it; what a page *renders* from it is TK-28's.
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
export async function discover(
  contentDirectory: string,
  options: ExclusionOptions = {},
): Promise<Discovery> {
  const patterns = options.exclude ?? [];
  const matched = patterns.map(() => false);
  const paths = await walk(contentDirectory);
  const gitDates = gitDatesFor(contentDirectory, paths);

  /** Published source paths whose derived slug belongs to the site itself. */
  const reserved: { path: string; slug: string }[] = [];
  /** Slug to the path that claimed it, so a collision can name its winner. */
  const claimed = new Map<string, string>();
  /** Slug to the path that produced it, for the link traversal. */
  const pathBySlug = new Map<string, string>();
  /** Slugs whose title the author wrote in frontmatter rather than a heading. */
  const declaredTitles = new Set<string>();
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

    const slug = slugOverrideFor(parsed.data, path) ?? slugFor(path);
    if (slug === undefined) {
      dropped.push({ path, reason: 'empty-slug' });
      continue;
    }
    if (RESERVED_SLUGS.has(slug)) {
      // Fatal candidates are not "dropped": no Discovery is returned and the
      // failure report owns these paths. Calling this an exclusion would imply
      // the rest of the site can still publish.
      reserved.push({ path, slug });
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
    const tags = tagsFor(parsed.data, path);
    const collection = collectionFor(path);
    const language = languageFor(parsed.data, path);
    const description = descriptionFor(parsed.data, path);
    const dates = gitDates.get(path);
    entries.push({
      slug,
      ...(dates?.created === undefined ? {} : { created: dates.created }),
      ...(dates?.updated === undefined ? {} : { updated: dates.updated }),
      ...(tags === undefined ? {} : { tags }),
      ...(collection === undefined ? {} : { collection }),
      ...(language === undefined ? {} : { language }),
      ...(description === undefined ? {} : { description }),
      // Derived from the body as authored, and derived **again** from the
      // rewritten body by {@link resolveCorpusLinks}. Not merely deferred:
      // deriving them only here was measured wrong in the loudest possible way —
      // the excerpt of a note containing `[[b]]` still carried the two brackets
      // after the body no longer did, and `schema.ts`'s unresolved-wikilink rule
      // rejected the artifact naming the entry rather than the field. Deriving
      // them only *there* would leave a caller that never runs the traversal
      // with an untitled entry, which is a second way to be wrong. So both, and
      // the second overwrites the first.
      title: title || titleFor(parsed.body, slug),
      excerpt: excerptFor(parsed.body),
      markdown: parsed.body,
      outgoing: [],
      backlinks: [],
    });
    // The frontmatter title, kept apart from the derived one: the traversal
    // re-derives a title from the rewritten body, and it must not overwrite a
    // title the author wrote down.
    if (title !== '') declaredTitles.add(slug);
    // The path a link resolves *from*, kept beside the entry it produced rather
    // than inside it: `slug` is a public route and `path` is a host-relative
    // filename, and `schema.ts` rejects an artifact carrying an unknown field
    // precisely so a source path cannot ride into `dist/` on one.
    pathBySlug.set(slug, path);
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

  // The exclusion typo wins when both faults exist: it could expose content,
  // while a reserved slug can only stop the build. Report every reserved path
  // together once the higher-risk configuration fault is clear.
  if (reserved.length > 0) {
    throw new BuildFailure(
      'reserved-slug',
      `${reserved.length} published ${reserved.length === 1 ? 'note uses' : 'notes use'} reserved route slugs`,
      reserved
        .map(({ path, slug }) => `${path}: slug "${slug}" is reserved by the site; rename the source file or its directory`)
        .join('\n'),
    );
  }

  return {
    entries,
    counts: { discovered: paths.length, published: entries.length, dropped: dropped.length },
    dropped,
    paths,
    pathBySlug,
    declaredTitles,
  };
}

/**
 * The route a published slug is served at.
 *
 * A parameter with a default rather than a constant, so the shape lives in one
 * place and a ticket that moves notes under a prefix changes one default instead
 * of hunting for string concatenation. Mirrors `defaultRouteForSlug` in
 * `src/lib/markdown.ts`, which is what rewrites these same hrefs at render time.
 */
export type RouteForSlug = (slug: string) => string;

const defaultRouteForSlug: RouteForSlug = (slug) => `/${slug}/`;

/**
 * Discoveries this process has already resolved links for.
 *
 * A `WeakSet` rather than a flag on {@link Discovery}: the flag would be a field
 * of the returned shape, which every caller can see and set, and this is an
 * invariant of the module rather than a property of the data. Weak so a
 * long-running process holding many discoveries does not retain them.
 */
const resolved = new WeakSet<Discovery>();

/**
 * Resolve every link in every published note, in one traversal per note.
 *
 * **A separate exported step rather than the tail of {@link discover}, for the
 * same reason {@link writeArtifact} is one: a caller has to be able to put its
 * own work between the two.** It also keeps the walk free of a parser — see the
 * dynamic import below — which TK-26's cross-platform gate depends on.
 *
 * **Resolution runs over the full file set**, every path the walk classified and
 * not only the published ones, so a link to an excluded note resolves to *that
 * note* and is reported as a publication-boundary event rather than as a broken
 * link. Those are different mistakes with different fixes, and the excluded-note
 * case is the mistyped-exclusion hazard seen from the other side. The full set
 * does not exist until the walk finishes, which is why this cannot run inside
 * the loop that builds it.
 *
 * Entries are rewritten **in place**, and each `outgoing` comes from the same
 * traversal that produced its rewrite — see `scripts/resolve-links.ts` for why
 * that is one walk rather than two. `backlinks` is derived here as the exact
 * inverse, because `checkCorpus` rejects an artifact where it is not.
 *
 * @returns Every link that did not simply resolve, sorted by source then line.
 */
export async function resolveCorpusLinks(
  discovery: Discovery,
  routeForSlug: RouteForSlug = defaultRouteForSlug,
): Promise<LinkFindingRow[]> {
  const { entries, pathBySlug, paths: allPaths, declaredTitles } = discovery;

  // **Called twice, this would silently corrupt the corpus**, so it refuses.
  // Measured: a second pass over an already-rewritten body reads `[b](/b/)` as a
  // link to a route rather than to a file, resolves it to nothing, degrades it
  // to the text `b`, empties `outgoing` and `backlinks`, and reports a spurious
  // `unresolved` finding. Every one of those is silent. Rewriting is not
  // idempotent because it cannot be — the output syntax is the input syntax —
  // so the guard is the honest shape rather than a defensive flourish.
  //
  // A plain `Error` rather than a `BuildFailure`: the closed set of failure
  // codes exists so a *user's* build can put a stable identifier on a stream
  // and a name in the report, and this is not a fault of any repository. It is
  // this module's caller calling it twice, which no corpus can cause and no
  // user can fix. `failureFor` files it as `unexpected-error` with the stack,
  // which is what a programmer error should look like in the report.
  if (resolved.has(discovery)) {
    throw new Error(
      'link resolution ran twice over one discovery. It rewrites bodies in place, so a ' +
        'second pass would read its own output as new links and drop them.',
    );
  }
  resolved.add(discovery);
  // Every discovered file, carrying its slug where it has one. A file with no
  // slug is discoverable and unpublishable, which is exactly what makes
  // `unpublished` distinguishable from `unresolved`.
  const slugByPath = new Map([...pathBySlug].map(([slug, path]) => [path, slug]));
  const corpus: CorpusFile[] = allPaths.map((path) => ({ path, slug: slugByPath.get(path) }));
  const index = indexCorpus(corpus);

  // **Imported here rather than at the top of the file, and this is measured
  // rather than stylistic.** `resolve-links.ts` imports `satteri`, whose parser
  // is a native binding installed per platform — a win32 install carries
  // `@bruits/satteri-win32-x64-msvc` and nothing else. TK-26's cross-platform
  // gate loads *this module* under WSL to compare the two walks, and a static
  // import made that load throw `Cannot find native binding` before discovery
  // ran at all, turning a green gate red on a property this ticket does not
  // touch. The walk needs no parser; only the traversal does.
  const { resolveLinksIn } = await import('./resolve-links.ts');

  const findings: LinkFindingRow[] = [];
  for (const entry of entries) {
    const path = pathBySlug.get(entry.slug);
    // Unreachable by construction — `pathBySlug` is written for every entry pushed
    // — but an entry with no path cannot be resolved *from* anywhere, and
    // resolving it from the corpus root would silently answer tiers 2 and 5
    // wrong rather than not answering.
    if (path === undefined) continue;

    let result;
    try {
      result = resolveLinksIn(entry.markdown, path, index, entry.slug, routeForSlug);
    } catch (error) {
      // `applyEdits` refuses overlapping spans, which is a rewritten body that
      // would be neither of the two things it was built from. The public half
      // stays nameless — a withheld note's path is the disclosure — and the
      // report gets the file.
      throw new BuildFailure(
        'link-rewrite-conflict',
        'a note\'s links could not be rewritten unambiguously. See the report for the file.',
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    entry.markdown = result.markdown;
    // Sorted, because `checkCorpus` requires ascending order and the traversal
    // emits document order. Without this, `See [[zebra]] and [[apple]].` fails
    // the build outright — measured on the shipped binary, exit 1 with
    // `outgoing: must be sorted in ascending order`, while the same corpus with
    // the two links swapped exits 0. Nobody writes prose in slug-alphabetical
    // order, so this was a first build a stranger could not get past.
    //
    // The *page* still renders links in document order: this array is the edge
    // set, not the body, and the body is `result.markdown` above.
    entry.outgoing = [...result.outgoing].sort();
    // Re-derived from the rewritten body. A title and an excerpt are
    // projections of what was published, and taking them from the pre-traversal
    // text put an unresolved `[[wikilink]]` into the excerpt of a body that no
    // longer had one — which `schema.ts` rejects, correctly. A title the author
    // wrote in frontmatter is never overwritten; only a derived one is.
    if (!declaredTitles.has(entry.slug)) entry.title = titleFor(entry.markdown, entry.slug);
    entry.excerpt = excerptFor(entry.markdown);
    findings.push(...result.findings);
  }

  // **The mechanical inverse, and why it is here rather than left to TK-28.**
  // `checkCorpus` requires `backlinks` to be the exact inverse of `outgoing`
  // and computes precisely this list to compare against. So the moment
  // `outgoing` stopped being empty, an artifact without this was rejected —
  // measured on two notes and one link: `backlinks: must be the exact inverse
  // of outgoing links (expected [a], got [])`. A producer emitting half an edge
  // set makes every repository with a link between two notes unbuildable, which
  // is the ordinary case for the corpora this tool exists to serve.
  //
  // This is the derivation only. What a *page* does with a backlink — the
  // aside, the hover preview, the "links to this note" heading — is TK-28's,
  // and none of it is decided here.
  //
  // Sorted, because the contract compares sorted lists and an unsorted one
  // would make the artifact's bytes depend on entry order for no visible reason.
  const backlinks = new Map(entries.map((entry) => [entry.slug, [] as string[]]));
  for (const entry of entries) {
    for (const target of entry.outgoing) backlinks.get(target)?.push(entry.slug);
  }
  for (const entry of entries) entry.backlinks = (backlinks.get(entry.slug) ?? []).sort();

  // Sorted by where a reader would look for them, so a report reads identically
  // however the walk found the notes. One comparator, exported by the module
  // that owns the row type, because the report sorts them again on the way to
  // disk.
  return findings.sort(bySourceThenLine);
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
  /**
   * Every path the walk classified as a file, published or not.
   *
   * Carried because link resolution runs over the **full** set: a link to an
   * excluded note and a link to nothing at all are different events with
   * different fixes, and resolving against the published entries alone would
   * merge them.
   */
  paths: readonly string[];
  /** Each published slug to the path that produced it, for tiers 2 and 5. */
  pathBySlug: ReadonlyMap<string, string>;
  /**
   * Slugs whose title came from frontmatter, so re-deriving a title after the
   * link traversal cannot overwrite one the author wrote down.
   */
  declaredTitles: ReadonlySet<string>;
}

/**
 * One candidate entry, before the contract has judged it.
 *
 * Exported because the link traversal rewrites these in place and TK-28 derives
 * backlinks from the same shape; an unexported type would make both consumers
 * restate it, and two restatements of one shape drift.
 */
export interface ContentEntryInput {
  slug: string;
  tags?: string[];
  collection?: string;
  language?: string;
  description?: string;
  created?: string;
  updated?: string;
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
