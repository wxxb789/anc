/**
 * The user's configuration file, and the one place its defaults are written
 * down.
 *
 * A stranger runs this tool on their own notes repository. Everything here is
 * therefore judged by one question — *what happens to something you typed
 * wrong* — because the alternative is a user who believes they configured an
 * exclusion and did not, and whose next push publishes the note they withheld.
 *
 * ## The format: YAML, and the measurement that chose it
 *
 * Four candidates, each measured on this host (Node 24.18.1, `yaml` 2.9.0)
 * rather than ranked by taste.
 *
 * **A `.ts` module — the plan's choice at §4.1 — is rejected on three
 * measurements, and the third is disqualifying.**
 *
 * 1. It loads in every repository shape, as the plan says: measured, a
 *    `publish.config.ts` importing a type from an unresolvable specifier loads
 *    with no `package.json`, with a CommonJS one, and with `"type": "module"`.
 *    So the plan's own supporting measurement reproduces. The problems are
 *    elsewhere.
 * 2. **It prints the user's absolute path to stderr, and the print cannot be
 *    intercepted.** Measured, in the middle case above — a notes repository
 *    holding a `package.json` with no `"type"`, which is what `npm i` for a
 *    local preview leaves behind — Node emits
 *    `[MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of
 *    file:///…/publish.config.ts is not specified`, containing the user's own
 *    directory. A `process.on('warning')` listener saw **zero** warnings while
 *    stderr carried it, so it is not interceptable; only the process-wide
 *    `NODE_NO_WARNINGS=1` suppresses it, which silences every other warning
 *    too. TK-25 §2.3 forbids any discovered filesystem path on that stream, and
 *    a format whose mere loading violates it cannot be made to comply.
 * 3. **Validating it is not possible, because the value can change after it is
 *    validated.** Measured: a config whose `exclude` is a getter returned
 *    `['drafts/**']` to the validator and `['nothing-at-all/**']` to the next
 *    reader. A `Proxy` reports whatever key set it likes to `Object.keys`. So
 *    the unknown-key check — the thing this ticket exists to provide — is
 *    advisory against a hostile or merely clever file, and the failure is
 *    silent in the publishing direction. Executing the config also means an
 *    arbitrary throw: measured, a config calling `readFileSync` on a missing
 *    path produced `ENOENT: … open 'Q:\etc\hostname'`, a host path in a message
 *    nothing here composed.
 *
 * **TOML is rejected on cost.** Node has no TOML parser — measured,
 * `import('node:toml')` fails `ERR_UNKNOWN_BUILTIN_MODULE` — so it is a new
 * dependency, and the ticket's rule is that a new dependency must be shown to
 * beat what is already installed. It does not: `yaml` is already a declared
 * dependency, added by TK-26 for frontmatter, and carries comments too.
 *
 * **JSON is rejected on comments.** This file's main content is a list of
 * exclusion patterns, which is exactly the content a user wants to annotate
 * (`# not ready yet`), and JSON has no way to. Two lesser measurements agree:
 * `JSON.parse` silently keeps the *last* of two duplicate keys — so a user who
 * writes `exclude` twice loses the first list with no signal — and its parse
 * error quotes the file's own bytes back (`Unexpected token ']', ..."ts/**",\n
 * ]\n}" is not valid JSON`), which puts pattern text on a stream TK-25 §2.3
 * bans it from.
 *
 * **YAML wins, and the trade is real rather than nominal.** A user editing
 * notes already writes YAML in their frontmatter, `yaml` is already installed,
 * comments work, and a duplicate key is a *loud* `DUPLICATE_KEY` error rather
 * than a silent overwrite. What it costs is that YAML's plain scalars are a
 * language, and a glob pattern is not written in it. Measured over 34 realistic
 * patterns written unquoted:
 *
 * ```
 * "*.md"        ReferenceError: Unresolved alias   "!README.md"  -> ""
 * "{a,b}/**"    UNEXPECTED_TOKEN                   "&draft/**"   -> null
 * "@work/**"    BAD_SCALAR_START                   "- dash/**"   -> ["dash/**"]
 * ```
 *
 * Three of those are rewritten with no error at all, and the middle one is the
 * worst available: `!README.md` is the exact spelling `docs/plans/…-plan.md`
 * §2.2 gives for re-including the repository README, and plain YAML turns it
 * into the empty string.
 *
 * **So the checks below are not defensive tidying; they are what makes the
 * format safe.** With every parse *warning* promoted to a failure, every member
 * required to be a non-empty untrimmed string, and every eaten `!` tag refused,
 * the same 34 patterns measure **21 exact, 13 loud, and zero silent** unquoted,
 * and **34 exact, zero loud, zero silent** quoted. Zero silent is the property
 * the format was chosen for.
 *
 * Which of the three mechanisms catches which case was **measured**, after a
 * mutation removed the warning promotion and every gate stayed green — the
 * cases it alone catches are a discarded tag *outside* `exclude`, where the
 * surviving value is a valid string and no other check can see that anything
 * happened. {@link CORRUPTION_GATE} records the split.
 *
 * ## What a message may carry
 *
 * TK-25 §2.1 admits a *config location* — filename, 1-indexed line, array index
 * — and a literal of this tool's own source, and admits no other user-derived
 * string. Two consequences, and the split between them is the whole rule:
 *
 * - **A known key is a literal of this file's own table**, so `exclude` and
 *   `origin` are printed in full.
 * - **An unknown key is user-authored text**, and `clients/acme/2026-renewal.md`
 *   is a valid YAML key. So a misspelling is reported by *line*, with the
 *   suggestion drawn from {@link KNOWN_KEYS}, and its bytes go to the report's
 *   private half. The user opens their own file at that line and reads what
 *   they wrote there — which is strictly more actionable than the key alone,
 *   since the line is where the fix goes.
 *
 * A *value* is never echoed for the same reason; what is printed is the type
 * that was found, which is a closed set of literals.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineCounter, parseAllDocuments } from 'yaml';
import { FIELD_LIMITS, isLanguageTag } from '../src/lib/schema.ts';
import { BuildFailure } from './write-report.ts';
import type { ExclusionOptions } from './markdown-to-artifact.ts';

/**
 * The one filename, at the root of the content directory.
 *
 * **One name and no search order**, per plan §4.1: a search order is a place
 * for a file to be silently not found. What the plan does not say, and what
 * {@link NEAR_MISS_NAMES} adds, is that the same argument condemns silence
 * about a *near* name — a user who wrote `publish.config.yml` has configured
 * nothing and been told nothing, which is the failure mode this whole module
 * exists to prevent, one level up from a misspelled key.
 *
 * **At the content directory rather than the invocation directory**, because
 * the patterns inside it are matched against content-directory-relative paths
 * (`scripts/markdown-to-artifact.ts`). Anchoring the file where its own
 * patterns are anchored means `drafts/**` is relative to the directory the file
 * sits in, which is the only reading a user has to be told once.
 *
 * The stem carries no project name — the same decision as TK-25's
 * `publish-report/` — and it matches the `CONFIG_LOCATION` shape
 * `scripts/markdown-to-artifact.ts` requires before it will put a caller's
 * source label on a stream.
 */
export const CONFIG_FILENAME = 'publish.config.yaml';

/**
 * Spellings that are not the filename, and that mean the user meant it.
 *
 * Each is refused by name rather than accepted, because accepting them is a
 * search order. The TypeScript spelling is on the list because it is the one
 * `docs/plans/ssg-generalisation-plan.md` §4.1 names, so it is what a reader of
 * the plan — or of anything derived from it — will write first.
 *
 * Every entry is a literal of this file's own source, so printing one discloses
 * nothing; that is what lets the refusal name the file it found.
 *
 * **Built by joining a stem to an extension rather than written out, and that
 * is a packaging constraint rather than a style.** `scripts/compile-package.ts`
 * rewrites every quoted `….ts` string naming a real file of ours to `.js` on
 * the way into the tarball, and `tests/packaging.test.ts` then fails on any
 * `.ts` string that survives. Both are right to: an unrewritten specifier is a
 * broken packaged build. But these are *the user's* filenames, not modules —
 * there is nothing to rewrite, and a quoted TypeScript spelling here is
 * indistinguishable from a stale import to a tool reading strings. Measured:
 * the gate failed on exactly that, once for the array entry and a second time
 * for a quoted mention of it inside this very comment, since the gate scans
 * bytes rather than syntax. Joining the parts keeps the value identical and the
 * hazard absent, and nothing in this file quotes the spelling any more.
 */
export const NEAR_MISS_NAMES: readonly string[] = [
  ...['yml', 'json', 'ts', 'js', 'mjs', 'toml'].map((extension) => `publish.config.${extension}`),
  ...['yaml', 'yml', 'json'].map((extension) => `publish.${extension}`),
  // Measured as silently ignored before they were listed: a hyphen for the dot,
  // an abbreviated stem, and the bare noun are each a spelling a user reaches
  // for first, and each configured nothing while looking configured.
  ...['yaml', 'yml'].flatMap((extension) => [`publish-config.${extension}`, `publish.conf.${extension}`]),
];

/** Every key the file may carry. The order is the order they are documented in. */
const KNOWN_KEYS = ['title', 'origin', 'exclude', 'language', 'media'] as const;

/**
 * Every key a `media:` table may carry.
 *
 * One provider and one shape, deliberately: Goal 0013 authorizes Cloudflare R2
 * and nothing else, so this is a validated configuration table rather than a
 * provider framework. The two credential entries are *names* of environment
 * variables; a value written here would be a secret in the user's repository
 * and is refused by the unknown-value rule of the shape itself.
 */
const MEDIA_KEYS = [
  'provider',
  'bucket',
  'endpoint',
  'public_base_url',
  'access_key_id_env',
  'secret_access_key_env',
] as const;

/**
 * The opt-in managed-media configuration. Only Cloudflare R2 is implemented;
 * the provider literal is what makes a future section fail here rather than in
 * a publisher that would have to guess.
 *
 * The two URLs are normalized to bare origins (scheme, host, port) so every
 * consumer forms one URL from one spelling. `endpoint` is the S3 API origin;
 * `publicBaseUrl` is the custom domain a reader fetches. `bucket` is the R2
 * bucket both are scoped by.
 */
export interface MediaConfig {
  readonly provider: 'r2';
  readonly bucket: string;
  readonly endpoint: string;
  readonly publicBaseUrl: string;
  readonly accessKeyIdEnv: string;
  readonly secretAccessKeyEnv: string;
}

/** The longest bucket name the S3 API and R2 both accept. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The shape of a name that can address an environment variable. */
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The configuration a build runs with, after defaults are applied.
 *
 * `origin` is the one field with no default here, and its absence is
 * meaningful rather than an omission: `astro.config.mjs` owns the fallback,
 * because the origin has exactly one home and that home is the `site:` line.
 * A default written here would be a second one. See {@link loadConfig}.
 */
export interface LoadedConfig {
  /**
   * The site's own name. Reaches `<title>`, page metadata, and the feed.
   *
   * Defaults to {@link DEFAULT_TITLE}. TK-31 wires it to `src/lib/site.ts`'s
   * `SITE_NAME`; this module only resolves it.
   */
  title: string;
  /**
   * The absolute public origin, when the user configured one.
   *
   * `undefined` means "the user said nothing", not "the user has no origin" —
   * the caller supplies the default it owns.
   */
  origin: string | undefined;
  /** Gitignore-style globs, last match wins, `!` re-includes. Defaults to none. */
  exclude: readonly string[];
  /**
   * The site's default BCP 47 language, when the user configured one.
   *
   * The fallback for every note that declares no `language:`/`lang:` — the
   * producer writes it into those entries, so static `<html lang>`, the
   * snapshot's `nodes.language`, and Pagefind's per-language index all agree —
   * and the chrome language of every route that is not one note. `undefined`
   * means the interface's own default, English.
   */
  language: string | undefined;
  /**
   * The opt-in managed-media configuration, when the user wrote one.
   *
   * Its presence does **not** authorize anything. Only `anc build --release
   * --media r2` reads it, so an ordinary build, a preview, and a release build
   * without the flag remain offline even in a repository that holds this table
   * and has the credentials exported. That separation is the product decision,
   * not an implementation convenience.
   */
  media: MediaConfig | undefined;
}

/**
 * The site name a repository with no configuration gets.
 *
 * Deliberately not `src/lib/site.ts`'s `SITE_NAME`. That value is this
 * project's own name, and a stranger's first build must not put it in their
 * browser tab — which is the residue plan decision D2 exists to remove. A
 * generic noun is legible, obviously a placeholder, and belongs to nobody.
 */
export const DEFAULT_TITLE = 'Notes';

/**
 * Every default, in one object, so "what does a repository with no config get"
 * is answered by reading one declaration.
 *
 * `origin` is absent by design; see {@link LoadedConfig}.
 *
 * Frozen, and {@link freshDefaults} is what callers actually receive. A spread
 * of this object is a *shallow* copy, so every caller would share one `exclude`
 * array — measured, pushing to the array returned by one `loadConfig` changed
 * what the next one returned. `readonly string[]` is a compile-time claim only,
 * and `exclusionOptions` hands the array straight to `discover`.
 */
export const DEFAULTS: LoadedConfig = Object.freeze({
  title: DEFAULT_TITLE,
  origin: undefined,
  exclude: Object.freeze([]) as readonly string[],
  language: undefined,
  media: undefined,
});

/** The defaults, as a value a caller may keep and a later caller cannot see. */
function freshDefaults(): LoadedConfig {
  return { ...DEFAULTS, exclude: [] };
}

/**
 * An object with no prototype surprises, which is what a config table must be.
 *
 * The same shape as `src/lib/schema.ts`'s `isPlainObject`, plus the prototype
 * test that `Set` and `Map` need — see the call site for the measurement.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The patterns a plain YAML document rewrites without saying so, with what it
 * makes of them.
 *
 * Exported so the gate that proves the loader refuses them is written against
 * the measurement that motivated it rather than against a rediscovered example.
 *
 * **Which mechanism catches which is the difference between a gate and a
 * coincidence, so it is recorded rather than assumed.** It had to be: a
 * mutation that removed the warning promotion left every gate green, because
 * the members it then admitted were all caught by something else.
 *
 * ```
 * "!README.md"          TAG_RESOLVE_FAILED  -> ""            emptiness check too
 * "!private drafts/**"  TAG_RESOLVE_FAILED  -> "drafts/**"   promotion ONLY
 * "&draft/**"           no warning          -> null          type check only
 * "- dash/**"           no warning          -> ["dash/**"]   type check only
 * "! README.md"         no warning          -> "README.md"   tag rule ONLY
 * ```
 *
 * The second and last rows are each the sole case of their mechanism, and the
 * difference between them is worth reading twice: a *named* tag is reported as
 * `'!private'` and the non-specific one as `'!'`, so the tag rule sees only the
 * second and the promotion is what refuses the first. A rule written against
 * `tag.startsWith('!')` would collapse them and lose the distinction the two
 * gates rest on.
 *
 * The last row is the worst of the five. `! README.md` — a negation written
 * with the space a human naturally puts after punctuation — parses to
 * `README.md` with no error and no warning, and that is not a corrupted pattern
 * but an **inverted** one: measured, `!README.md` re-includes the repository
 * README and `README.md` excludes it. The user asked for a file back and
 * silently told the tool to withhold it. Nothing about the parsed *value* can
 * see it; {@link taggedExcludeMembers} reads the node's tag instead.
 *
 * Note what this list does **not** cover, and why the promotion has a gate of
 * its own beyond the row above: a discarded tag on `title` or `origin` leaves a
 * valid string that no check on the value can question, and outside `exclude`
 * the tag rule does not look.
 */
export const CORRUPTION_GATE: readonly string[] = [
  '!README.md',
  '!private drafts/**',
  '&draft/**',
  '- dash/**',
  '! README.md',
];

/** What was found where a type was expected. A closed set of literals. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  if (typeof value === 'object') return 'a table';
  return 'nothing';
}

/**
 * How far apart two strings are, capped at the only distances worth reporting.
 *
 * The two-row form rather than a full matrix, because the matrix is the version
 * that gets written wrong. Used only to choose a suggestion out of
 * {@link KNOWN_KEYS}, so its output never reaches a message.
 */
function editDistance(from: string, to: string): number {
  let previous = Array.from({ length: to.length + 1 }, (_, index) => index);
  for (let i = 0; i < from.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < to.length; j += 1) {
      current.push(
        Math.min(
          (previous[j + 1] ?? 0) + 1,
          (current[j] ?? 0) + 1,
          (previous[j] ?? 0) + (from[i] === to[j] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[to.length] ?? to.length;
}

/**
 * The known key a misspelling most likely meant, or `undefined`.
 *
 * Two rules, because the two common mistakes have different shapes.
 * Containment catches an *elaboration* — `siteTitle` for `title`, `excludes`
 * for `exclude` — which is four edits away and would never clear a distance
 * threshold. Distance catches a *typo*: `exclud`, `orgin`, `titel`.
 *
 * Compared on a folded form so that `Origin` and `EXCLUDE` are recognised;
 * the file's keys are lowercase and a user who capitalised one has still made
 * a spelling mistake rather than named something else.
 *
 * The containment rule needs a length floor, because `known.includes(folded)`
 * is true of any substring: measured, a key of `e` was suggested as `title`,
 * `x` as `exclude`, and `o` as `origin`. A confidently wrong suggestion tells
 * the user to rename a key they did not mean to write, which is worse than
 * listing the keys.
 */
function suggestionFor(key: string, candidates: readonly string[] = KNOWN_KEYS): string | undefined {
  const folded = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (folded === '') return undefined;
  for (const known of candidates) {
    if (folded.length >= 3 && (folded.includes(known) || known.includes(folded))) return known;
  }
  for (const known of candidates) {
    if (editDistance(folded, known) <= 2) return known;
  }
  return undefined;
}

/**
 * How many issues one refusal prints before it stops enumerating.
 *
 * Measured: a list of 5,000 wrong-typed members composes a 303,940-character
 * message. Nothing in it is a disclosure, but a stream nobody can read is a
 * diagnostic nobody uses, and the remainder is reported as a count — which is a
 * class-A integer and so costs nothing.
 */
const MAX_REPORTED_ISSUES = 50;

/**
 * Every issue found in one file, thrown as one failure.
 *
 * The shape mirrors `src/lib/schema.ts`'s `ContentValidationError` — the file,
 * a count, then one indented line per issue — rather than inventing a second
 * way for this project to reject malformed input. Accumulating rather than
 * throwing on the first is the same decision for the same reason: a user
 * correcting three mistakes one build at a time is three builds.
 *
 * A {@link BuildFailure} rather than a new class, so the message is printable:
 * `bin/anc.mjs` prints only errors composed under the
 * disclosure rule, and everything else becomes `build failed`. The private half
 * carries what the public half may not — and the private half is **not**
 * truncated, because the file it goes to is where a user reads the rest.
 */
function refuse(issues: readonly string[], details: readonly string[]): never {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES);
  const remainder = issues.length - shown.length;
  throw new BuildFailure(
    'config-invalid',
    `${CONFIG_FILENAME}: ${issues.length} configuration violation${issues.length === 1 ? '' : 's'}\n` +
      shown.map((issue) => `  - ${issue}`).join('\n') +
      (remainder === 0 ? '' : `\n  … and ${remainder} more`),
    details.length === 0 ? issues.join('; ') : details.join('; '),
  );
}

/**
 * An absolute `http(s)` origin and nothing more.
 *
 * The path check is the one that is not obvious and is the one that matters.
 * `src/lib/site.ts` forms every canonical URL, feed id, and sitemap `<loc>` as
 * `new URL(route, site)` where `route` is root-absolute — so a configured
 * `https://example.com/notes/` has its `/notes/` **discarded**, and the site
 * builds cleanly while every public URL in it is wrong. Astro spells that
 * arrangement `base:`, which is a separate option and a separate decision; what
 * this module must not do is accept a value that produces a valid, wrong site.
 *
 * A non-`http` scheme is refused for the same class of reason: a canonical link
 * is dereferenced by a crawler.
 */
function checkOrigin(value: unknown, line: number | undefined, issues: string[], details: string[]): void {
  const at = line === undefined ? 'origin' : `origin (line ${line})`;
  if (typeof value !== 'string') {
    issues.push(`${at}: must be a string holding an absolute URL, found ${typeName(value)}`);
    details.push(`origin = ${JSON.stringify(value)}`);
    return;
  }

  // Before `new URL`, because `URL` *tolerates* surrounding whitespace and a
  // tab inside the host — measured, `"  https://example.com/  "` and
  // `"https://exa\tmple.com/"` both parse and both pass every check below, and
  // the raw string is what reaches `site:`. Refusing rather than trimming, for
  // the reason `checkExclude` refuses a padded pattern: a silent rewrite is the
  // failure mode this module exists to prevent.
  if (value !== value.trim() || /\s/.test(value)) {
    issues.push(`${at}: must not contain whitespace`);
    details.push(`origin = ${JSON.stringify(value)}`);
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The value is not echoed: an origin is not itself sensitive, but a
    // *mistyped* one is whatever the user's editor left in the buffer, and this
    // reaches a workflow log. The line number is where the fix goes.
    issues.push(`${at}: must be an absolute URL with a scheme, such as https://notes.example.com/`);
    details.push(`origin = ${JSON.stringify(value)}`);
    return;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    issues.push(`${at}: must use the https or http scheme`);
    details.push(`origin = ${JSON.stringify(value)}`);
    return;
  }

  // Credentials in the origin are the sharpest case of "builds cleanly and is
  // wrong": measured, `https://alice:s3cret@example.com/` passes every other
  // check, and `new URL('/notes/a/', origin)` then puts the password into every
  // canonical link, feed id, and sitemap entry of the published site.
  if (url.username !== '' || url.password !== '') {
    issues.push(`${at}: must not carry a username or password — they would appear in every published URL`);
    // Deliberately not the value, which is the one string here that really is a
    // secret. The line is enough to find it.
    details.push('origin carried credentials');
    return;
  }

  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    issues.push(
      `${at}: must be a bare origin with no path, query, or fragment — every ` +
        'canonical URL, feed id, and sitemap entry is resolved against it as a ' +
        'root-absolute route, so a path here is silently discarded',
    );
    details.push(`origin = ${JSON.stringify(value)}`);
  }
}

/** Whether a validated origin names only the current host rather than a public server. */
export function isLoopbackOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '0.0.0.0' || hostname.startsWith('127.')) return true;
  if (hostname === '::' || hostname === '::1') return true;
  if (!hostname.startsWith('::ffff:')) return false;
  const mapped = hostname.slice('::ffff:'.length);
  if (mapped === '0.0.0.0' || mapped.startsWith('127.') || mapped === '0:0') return true;
  const first = Number.parseInt(mapped.split(':')[0] ?? '', 16);
  return Number.isFinite(first) && first >= 0x7f00 && first <= 0x7fff;
}

/**
 * A non-empty site title carrying nothing XML cannot represent.
 *
 * The control-character rule is not belt-and-braces. `src/lib/site.ts` records
 * that XML 1.0's `Char` production admits no escape for a C0 control, so a
 * title carrying one produces a feed no reader can parse — and that the content
 * contract checks `title` for emptiness and privacy markers but *not* for these
 * characters. This is the site's own title rather than a note's, so it is the
 * one such string this module can close.
 */
function checkTitle(value: unknown, line: number | undefined, issues: string[], details: string[]): void {
  const at = line === undefined ? 'title' : `title (line ${line})`;
  if (typeof value !== 'string') {
    issues.push(`${at}: must be a string, found ${typeName(value)}`);
    details.push(`title = ${JSON.stringify(value)}`);
    return;
  }
  if (value.trim() === '') {
    issues.push(`${at}: must not be empty`);
    return;
  }
  // Refused rather than trimmed, which is the same rule `checkExclude` applies
  // to a padded pattern. YAML preserves the padding a user quoted deliberately,
  // and quietly discarding it is a silent rewrite — the thing this module is
  // built to prevent, applied inconsistently if it happened here.
  if (value !== value.trim()) {
    issues.push(`${at}: must not have leading or trailing whitespace`);
    details.push(`title = ${JSON.stringify(value)}`);
    return;
  }
  // oxlint-disable-next-line no-control-regex -- refusing them is the point
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    issues.push(`${at}: must not contain a control character — XML has no escape for one, so the feed would not parse`);
    details.push(`title = ${JSON.stringify(value)}`);
  }
}

/**
 * A BCP 47 tag, validated exactly as a note's own `language:` is.
 *
 * The same shape (`isLanguageTag`) and the same 35-character registry ceiling
 * the content contract applies, so a value accepted here is one every consumer
 * of a note's language already accepts. Refused rather than trimmed or
 * case-folded, for the reason {@link checkTitle} gives.
 */
function checkLanguage(value: unknown, line: number | undefined, issues: string[], details: string[]): void {
  const at = line === undefined ? 'language' : `language (line ${line})`;
  if (typeof value !== 'string') {
    issues.push(`${at}: must be a string holding a BCP 47 language tag, found ${typeName(value)}`);
    details.push(`language = ${JSON.stringify(value)}`);
    return;
  }
  if (!isLanguageTag(value) || value.length > FIELD_LIMITS.strings.language) {
    issues.push(`${at}: must be a BCP 47 language tag such as en, zh-CN, or zh-Hans-CN`);
    details.push(`language = ${JSON.stringify(value)}`);
  }
}

/**
 * A bare HTTPS origin for the R2 storage endpoint or its public custom domain.
 *
 * The two checks that are not obvious, and the reason they are here rather
 * than in the publisher:
 *
 * - **HTTPS only.** Credentials travel on every signed request, so a plain
 *   `http:` endpoint would put them on the wire. The public base is also where
 *   a reader's browser fetches images, and mixed content would break the page
 *   under the site's own CSP.
 * - **No `r2.dev`.** That hostname is Cloudflare's development-only, rate
 *   limited endpoint with no normal CDN caching. A published site that used it
 *   would work in a test and degrade under real traffic, so it is refused at
 *   configuration time rather than discovered later.
 *
 * A path, query, fragment, username or password is refused for the same class
 * of reason `checkOrigin` gives: the publisher appends the object path, so a
 * path here would silently move every object and a credential would appear in
 * every signed request line.
 */
function checkMediaOrigin(
  value: unknown,
  at: string,
  issues: string[],
  details: string[],
): string | undefined {
  if (typeof value !== 'string') {
    issues.push(`${at}: must be a string holding an HTTPS origin, found ${typeName(value)}`);
    details.push(`${at} = ${JSON.stringify(value)}`);
    return undefined;
  }
  if (value !== value.trim() || /\s/.test(value)) {
    issues.push(`${at}: must not contain whitespace`);
    details.push(`${at} = ${JSON.stringify(value)}`);
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push(`${at}: must be an absolute HTTPS URL with a host, such as https://example.com/`);
    details.push(`${at} = ${JSON.stringify(value)}`);
    return undefined;
  }

  if (url.protocol !== 'https:') {
    issues.push(`${at}: must use the https scheme`);
    details.push(`${at} = ${JSON.stringify(value)}`);
    return undefined;
  }

  if (url.username !== '' || url.password !== '') {
    issues.push(`${at}: must not carry a username or password — credentials are read from the environment`);
    // The value itself is the one string here that may be a secret.
    details.push(`${at} carried credentials`);
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'r2.dev' || hostname.endsWith('.r2.dev')) {
    issues.push(
      `${at}: must not use r2.dev — it is Cloudflare's development-only, rate-limited ` +
        'hostname with no normal CDN caching; connect a custom domain to the bucket instead',
    );
    details.push(`${at} named an r2.dev host`);
    return undefined;
  }

  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    issues.push(
      `${at}: must be a bare origin with no path, query, or fragment — ` +
        'the object path is appended to it',
    );
    details.push(`${at} = ${JSON.stringify(value)}`);
    return undefined;
  }

  return url.origin;
}

/**
 * The `media:` table: one provider, one shape, and every required key present.
 *
 * Returns the normalized configuration only when this table contributed no
 * issue. The caller still refuses the file if any other key did, which is why
 * this does not throw: the loader accumulates every mistake in one pass.
 *
 * `bucket` is validated against the narrower of the S3 and R2 naming rules
 * because both are addressed by the same value: 3–63 lowercase alphanumerics
 * or hyphens, starting and ending with an alphanumeric. Rejecting a bucket the
 * service would reject is cheaper than a 404 from a publisher that cannot say
 * which of the two was wrong.
 */
function checkMedia(
  value: unknown,
  line: number | undefined,
  memberLines: ReadonlyMap<string, number>,
  tagged: ReadonlySet<string>,
  issues: string[],
  details: string[],
): MediaConfig | undefined {
  const at = line === undefined ? 'media' : `media (line ${line})`;
  if (!isPlainObject(value)) {
    issues.push(`${at}: must be a table, found ${typeName(value)}`);
    details.push(`media = ${JSON.stringify(value)}`);
    return undefined;
  }

  const before = issues.length;
  const where = (key: string): string => {
    const memberLine = memberLines.get(key);
    return memberLine === undefined ? `media.${key}` : `media.${key} (line ${memberLine})`;
  };

  // A nested key is user-authored text exactly as a top-level one is: a pasted
  // path or credential can be a valid YAML key, and this message reaches the
  // public stderr stream. The line is where the fix goes; the bytes go to the
  // private report. `where()` remains for the schema's own key names below.
  for (const key of tagged) {
    const memberLine = memberLines.get(key);
    issues.push(
      `${memberLine === undefined ? 'media' : `media (line ${memberLine})`}: the value carries a ` +
        '"!" tag, which YAML discards — remove it, or quote the value if the "!" is part of it',
    );
    details.push(`media.${key} carried an eaten "!" tag`);
  }

  for (const key of Object.keys(value)) {
    if ((MEDIA_KEYS as readonly string[]).includes(key)) continue;
    const memberLine = memberLines.get(key);
    const suggestion = suggestionFor(key, MEDIA_KEYS);
    issues.push(
      `${memberLine === undefined ? 'media' : `media (line ${memberLine})`}: unknown key is not allowed` +
        (suggestion === undefined
          ? `. The keys are ${MEDIA_KEYS.join(', ')}`
          : `. Did you mean "${suggestion}"?`),
    );
    details.push(`unknown media key ${JSON.stringify(key)}`);
  }

  for (const key of MEDIA_KEYS) {
    if (key in value) continue;
    issues.push(`${where(key)}: is required`);
  }

  if ('provider' in value && value['provider'] !== 'r2') {
    issues.push(`${where('provider')}: must be "r2"; it is the only supported provider`);
    details.push(`media.provider = ${JSON.stringify(value['provider'])}`);
  }

  if ('bucket' in value) {
    const bucket = value['bucket'];
    if (typeof bucket !== 'string') {
      issues.push(`${where('bucket')}: must be a string, found ${typeName(bucket)}`);
      details.push(`media.bucket = ${JSON.stringify(bucket)}`);
    } else if (bucket !== bucket.trim() || /\s/.test(bucket)) {
      issues.push(`${where('bucket')}: must not contain whitespace`);
      details.push(`media.bucket = ${JSON.stringify(bucket)}`);
    } else if (!BUCKET_NAME.test(bucket)) {
      issues.push(
        `${where('bucket')}: must be 3–63 lowercase letters, digits, or hyphens, ` +
          'starting and ending with a letter or digit',
      );
      details.push(`media.bucket = ${JSON.stringify(bucket)}`);
    }
  }

  const endpoint =
    'endpoint' in value ? checkMediaOrigin(value['endpoint'], where('endpoint'), issues, details) : undefined;
  const publicBaseUrl =
    'public_base_url' in value
      ? checkMediaOrigin(value['public_base_url'], where('public_base_url'), issues, details)
      : undefined;

  const envNames = new Map<string, string>();
  for (const key of ['access_key_id_env', 'secret_access_key_env'] as const) {
    if (!(key in value)) continue;
    const name = value[key];
    if (typeof name !== 'string') {
      issues.push(`${where(key)}: must be a string naming an environment variable, found ${typeName(name)}`);
      details.push(`media.${key} = ${JSON.stringify(name)}`);
      continue;
    }
    if (!ENVIRONMENT_NAME.test(name) || name.length > 128) {
      issues.push(
        `${where(key)}: must be an environment variable name — letters, digits, and ` +
          'underscores, not starting with a digit',
      );
      details.push(`media.${key} = ${JSON.stringify(name)}`);
      continue;
    }
    envNames.set(key, name);
  }

  const accessKeyIdEnv = envNames.get('access_key_id_env');
  const secretAccessKeyEnv = envNames.get('secret_access_key_env');
  if (accessKeyIdEnv !== undefined && accessKeyIdEnv === secretAccessKeyEnv) {
    issues.push(
      `${where('secret_access_key_env')}: must name a different environment variable from ` +
        'media.access_key_id_env — one value cannot be both the key ID and the secret',
    );
    details.push('media.access_key_id_env and media.secret_access_key_env named the same variable');
  }

  if (issues.length !== before) return undefined;
  return {
    provider: 'r2',
    bucket: value['bucket'] as string,
    endpoint: endpoint!,
    publicBaseUrl: publicBaseUrl!,
    accessKeyIdEnv: accessKeyIdEnv!,
    secretAccessKeyEnv: secretAccessKeyEnv!,
  };
}

/**
 * The nested `media:` members whose YAML value carried an eaten `!` tag.
 *
 * The top-level loop cannot see these: a tagged scalar inside a mapping is a
 * different node, and `bucket: ! mybucket` would otherwise be accepted with the
 * tag silently discarded. Same rule, one level down.
 */
function mediaEatenTags(document: { get(key: string, keepScalar: true): unknown }): ReadonlySet<string> {
  const eaten = new Set<string>();
  const node: unknown = document.get('media', true);
  const items: unknown =
    node !== null && typeof node === 'object' && 'items' in node ? node.items : undefined;
  if (!Array.isArray(items)) return eaten;
  for (const item of items) {
    const pair = item as { key?: unknown; value?: unknown };
    const key = pair.key as { value?: unknown } | undefined;
    if (key === undefined || typeof key.value !== 'string') continue;
    if (carriesEatenTag(pair.value, document)) eaten.add(key.value);
  }
  return eaten;
}

/**
 * The 1-indexed line each `media:` member was written on.
 *
 * Per member, not per table: the entire disclosure design rests on the user
 * opening their own file at that line and reading their own text there, so a
 * line that points at `media:` for an error in `bucket` is worse than none.
 */
function mediaLines(
  document: { get(key: string, keepScalar: true): unknown },
  lineCounter: LineCounter,
): ReadonlyMap<string, number> {
  const lines = new Map<string, number>();
  const node: unknown = document.get('media', true);
  const items: unknown =
    node !== null && typeof node === 'object' && 'items' in node ? node.items : undefined;
  if (!Array.isArray(items)) return lines;
  for (const item of items) {
    const pair = item as { key?: unknown };
    const key = pair.key as { value?: unknown; range?: unknown } | undefined;
    if (key === undefined || typeof key.value !== 'string') continue;
    const range = key.range;
    if (!Array.isArray(range) || typeof range[0] !== 'number') continue;
    lines.set(key.value, lineCounter.linePos(range[0]).line);
  }
  return lines;
}

/**
 * A list of gitignore-style patterns, every member checked.
 *
 * The backslash rule is a cross-platform trap `scripts/markdown-to-artifact.ts`
 * measured and this is the only place that can name it: `matchesGlob` is
 * separator-literal, so `drafts\**` written by a Windows user matches nothing.
 * Left to itself that surfaces as TK-26's zero-match failure, which is loud but
 * names a typo the user cannot see — the pattern looks right on their machine.
 * Refusing it here says what is actually wrong.
 *
 * The duplicate rule is here for the same reason and is the one case TK-26's
 * zero-match check structurally cannot reach. Measured: `exclude: ['draft.md',
 * 'draft.md']` builds cleanly, because `excludes()` records a hit for *every*
 * pattern that matched, so a duplicate is never idle. A repeated pattern is
 * always either redundant or — far more likely in a list a user has edited over
 * months — a line they meant to change and copied instead, which reads as a
 * configured rule and is not one.
 *
 * **`tagged` marks the members YAML read a `!` tag on**, which is the one rule
 * that cannot be written against the parsed value: a re-include whose `!` was
 * eaten arrives as an ordinary string. See {@link taggedExcludeMembers}.
 *
 * **`memberLines` is per member, not per list.** A coordinate is only worth
 * printing if it points at the thing that is wrong.
 */
function checkExclude(
  value: unknown,
  line: number | undefined,
  memberLines: readonly (number | undefined)[],
  tagged: readonly boolean[],
  issues: string[],
  details: string[],
): void {
  const at = line === undefined ? 'exclude' : `exclude (line ${line})`;
  if (!Array.isArray(value)) {
    issues.push(`${at}: must be a list of strings, found ${typeName(value)}`);
    details.push(`exclude = ${JSON.stringify(value)}`);
    return;
  }

  /** Pattern to the index that claimed it, so a duplicate can name the original. */
  const seen = new Map<string, number>();

  for (const [index, member] of value.entries()) {
    // The index, never the pattern: TK-25 §2.3 forbids a pattern's text on this
    // surface, because a gitignore-style pattern may be a bare path and echoing
    // it re-admits the exact string the exclusion existed to withhold. The user
    // opens their own file and reads their own pattern at that index.
    const memberLine = memberLines[index];
    const where = `exclude[${index}]${memberLine === undefined ? '' : ` (line ${memberLine})`}`;
    if (typeof member !== 'string') {
      issues.push(`${where}: must be a string, found ${typeName(member)}`);
      details.push(`exclude[${index}] = ${JSON.stringify(member)}`);
      continue;
    }
    if (member.trim() === '') {
      issues.push(`${where}: must not be empty`);
      continue;
    }
    if (member !== member.trim()) {
      issues.push(`${where}: must not have leading or trailing whitespace`);
      details.push(`exclude[${index}] = ${JSON.stringify(member)}`);
      continue;
    }
    if (member.includes('\\')) {
      issues.push(
        `${where}: must use "/" separators on every platform — a backslash is ` +
          'matched literally, so this pattern would match nothing',
      );
      details.push(`exclude[${index}] = ${JSON.stringify(member)}`);
      continue;
    }

    const original = seen.get(member);
    if (original !== undefined) {
      // Two coordinates and no text, which is the whole message a user needs:
      // they open their own file and see the same line twice.
      issues.push(`${where}: repeats exclude[${original}] — a duplicate pattern is dead config`);
      details.push(`exclude[${index}] = ${JSON.stringify(member)} duplicates exclude[${original}]`);
      continue;
    }
    seen.set(member, index);

    // The inversion, and the one refusal here that prevents a file being
    // *withheld* rather than published.
    if (tagged[index] === true && !member.startsWith('!')) {
      issues.push(
        `${where}: a re-include must be written as "!pattern" in quotes, with no ` +
          'space after the "!" — unquoted, YAML reads it as a tag and discards it, ' +
          'which turns a rule that keeps a file into one that removes it',
      );
      details.push(`exclude[${index}] = ${JSON.stringify(member)} carried an eaten "!" tag`);
    }
  }
}

/**
 * Whether a YAML node carries the non-specific `!` tag, following an alias.
 *
 * The one signal that something the user wrote was discarded. `! README.md`
 * parses to `README.md` with no error and no warning — and inside `exclude`
 * that is not a corrupted pattern but an inverted one, since `!README.md`
 * re-includes the repository README while `README.md` excludes it. So the user
 * wrote "give me this file back", the loader received "withhold it", and every
 * check on the parsed value sees an ordinary string.
 *
 * **The alias hop, and what it is and is not doing.** Measured:
 * `title: &r ! README.md` with `exclude: [*r]` reaches this function as an
 * `Alias` node carrying no tag of its own — the tag lives on the anchored
 * scalar — so a check on `.tag` alone answers `false` for it. `resolve` follows
 * the alias.
 *
 * Recorded honestly, because the mutation that removes the hop stays **green**:
 * every site an anchor can be defined at is already checked by a caller, so I
 * could not construct a document that only the hop refuses. What I tried — an
 * anchor on `title`, on an `exclude` member, on an unknown key, and aliased in
 * both block and flow style — is the search, not a proof there is none. The hop
 * stays because this function must be right about the node it is handed rather
 * than right only while its callers happen to cover the anchor sites, which is
 * the rule `src/lib/routes.ts` states for the same reason.
 *
 * `=== '!'` exactly, never `startsWith('!')`. A *named* tag such as
 * `!private drafts/**` reports `'!private'` and is refused by the warning
 * promotion in {@link parseConfig} instead; widening this test would collapse
 * two mechanisms into one and leave the promotion with no gate of its own.
 */
function carriesEatenTag(node: unknown, document: { get(key: string, keepScalar: true): unknown }): boolean {
  if (node === null || typeof node !== 'object') return false;
  const direct: unknown = (node as { tag?: unknown }).tag;
  if (direct === '!') return true;

  const resolve: unknown = (node as { resolve?: unknown }).resolve;
  if (typeof resolve !== 'function') return false;
  const target: unknown = (resolve as (document: unknown) => unknown).call(node, document);
  return target !== null && typeof target === 'object' && (target as { tag?: unknown }).tag === '!';
}

/**
 * Which `exclude` members carry an eaten `!`.
 *
 * **Read off the node, and the first version read the source line instead —
 * which was wrong in four measured ways.** Recovering the text after the `-` on
 * the member's own line missed a flow sequence (`exclude: [! README.md]`,
 * accepted), missed a member indented onto the next line, missed **every member
 * of a CRLF file** — the ordinary case on Windows, where splitting on a bare
 * newline leaves a `\r` that an unanchored `$` will not match — and *falsely
 * refused* the legitimate `!!str "a/**"`, whose line also opens with a `!`. So
 * the rule was off exactly where it was most needed and on where it was not.
 *
 * The tag is the thing itself rather than a proxy for it: measured, `"!README.md"`
 * carries no tag, `!!str` carries `tag:yaml.org,2002:str`, and CRLF changes
 * neither the tag nor the line numbers.
 */
function taggedExcludeMembers(document: { get(key: string, keepScalar: true): unknown }): boolean[] {
  const sequence: unknown = document.get('exclude', true);
  const items: unknown =
    sequence !== null && typeof sequence === 'object' && 'items' in sequence ? sequence.items : undefined;
  if (!Array.isArray(items)) return [];
  return items.map((item: unknown) => carriesEatenTag(item, document));
}

/**
 * The 1-indexed line each `exclude` member was written on.
 *
 * A member's issue must point at the member, not at the `exclude:` key. The
 * first version passed one line for the whole list, so on a nine-line config
 * the fourth member's error read `exclude[3] (line 4)` while line 4 was
 * `exclude:` — and a *config location* that is wrong is worse than none, since
 * the entire disclosure design rests on the user opening their own file at that
 * line and reading their own text there.
 */
function excludeLines(
  document: { get(key: string, keepScalar: true): unknown },
  lineCounter: LineCounter,
): (number | undefined)[] {
  const sequence: unknown = document.get('exclude', true);
  const items: unknown =
    sequence !== null && typeof sequence === 'object' && 'items' in sequence ? sequence.items : undefined;
  if (!Array.isArray(items)) return [];
  return items.map((item: unknown) => {
    const range: unknown = (item as { range?: unknown }).range;
    if (!Array.isArray(range) || typeof range[0] !== 'number') return undefined;
    return lineCounter.linePos(range[0]).line;
  });
}

/**
 * Parse one configuration file and apply the defaults it did not override.
 *
 * Separated from {@link loadConfig} so the whole validator is reachable from a
 * string, which is what lets a gate state a hostile document inline instead of
 * writing it to a temporary directory first.
 *
 * **Every warning is a failure, and that is the load-bearing line.** `yaml`
 * reports an unresolvable tag as a *warning* and hands back a document whose
 * value has been quietly replaced — measured, `- !README.md` yields `''` with
 * `doc.errors` empty and `doc.warnings` holding one `TAG_RESOLVE_FAILED`. A
 * loader that reads only `errors` publishes the file the user meant to withhold
 * and reports success.
 *
 * **`logLevel: 'silent'` is a disclosure fix, not a tidiness one.** `yaml`
 * writes some diagnostics through `process.emitWarning` rather than collecting
 * them, and measured, one of them prints the user's own config key:
 * `Warning: Keys with collection values will be stringified … "[ clients/acme/…`.
 * That is a user-authored string on stderr from a call nothing here composed,
 * emitted before this function can reject anything, and a `process.on('warning')`
 * listener does not see it. Silencing the logger suppresses it entirely, and —
 * measured — leaves `doc.warnings` populated, so the promotion below is
 * unaffected.
 */
export function parseConfig(text: string): LoadedConfig {
  const issues: string[] = [];
  const details: string[] = [];
  /** Filled only by a fully valid `media:` table; validation failures throw below. */
  let media: MediaConfig | undefined;

  // A leading BOM is what Notepad writes, and it is not YAML. Stripped rather
  // than refused: the user did not type it and cannot see it.
  //
  // CRLF is deliberately *not* normalised here, and the earlier version that
  // did is worth recording. It was added to repair the inversion rule, which
  // then recovered each pattern from the text of its source line and so broke
  // on the carriage return a bare newline split leaves behind. The rule now
  // reads the node's tag instead, and measured, `yaml` handles CRLF itself: the
  // tag, the line numbers, and every scalar — plain, quoted, literal, folded —
  // are identical under both line endings, and no carriage return reaches a
  // value. So the normalisation became a line no mutation could turn red, which
  // is the kind of code that outlives the reason for it.
  const source = text.replace(/^﻿/, "");

  const lineCounter = new LineCounter();
  let documents;
  try {
    // `parseAllDocuments` rather than `parseDocument`, because the latter
    // returns the *first* document and says nothing about the rest. Measured:
    // `title: One\n---\nexclude:\n  - "drafts/**"\n` parsed to `{title: 'One'}`
    // with `errors` and `warnings` both empty — the user's entire exclusion list
    // discarded with no error and no line number. That is the same failure class
    // as the `!!set` document below, and worse, because what is dropped is the
    // half that withholds files.
    documents = parseAllDocuments(source, { lineCounter, logLevel: 'silent' });
  } catch (error) {
    // A throw rather than a collected error is a `yaml` internal, so its message
    // has opaque provenance and goes to the private half only.
    throw new BuildFailure(
      'config-unparsable',
      `${CONFIG_FILENAME}: is not valid YAML`,
      error instanceof Error ? error.message : String(error),
    );
  }

  const lineOf = (offset: number | undefined): number | undefined =>
    offset === undefined ? undefined : lineCounter.linePos(offset).line;

  // Measured, an empty input yields zero documents rather than one empty one.
  if (documents.length === 0) return freshDefaults();
  if (documents.length > 1) {
    const second = documents[1]?.range?.[0];
    const line = lineOf(typeof second === 'number' ? second : undefined);
    refuse(
      [
        `${line === undefined ? 'the document' : `line ${line}`}: a second document begins here, ` +
          'and only the first is read — remove the "---" separator and the documents after it',
      ],
      [`${documents.length} documents in one file`],
    );
  }

  const document = documents[0]!;

  for (const problem of [...document.errors, ...document.warnings]) {
    // The code is `yaml`'s own closed set of identifiers, and the position is a
    // config location — both admissible. The message is not: it quotes the
    // offending source line back, which for this file is pattern text.
    const line = problem.linePos?.[0]?.line;
    issues.push(`${line === undefined ? 'the document' : `line ${line}`}: ${problem.code}`);
    details.push(problem.message);
  }
  if (issues.length > 0) refuse(issues, details);

  // `toJS` is what resolves aliases, and an unresolvable one throws from inside
  // it rather than being collected — so it runs after the promotion above has
  // already refused every document that could reach that state, and is guarded
  // regardless because a throw here would otherwise escape as a library string.
  let value: unknown;
  try {
    value = document.toJS({ logLevel: 'silent' });
  } catch (error) {
    throw new BuildFailure(
      'config-unparsable',
      `${CONFIG_FILENAME}: is not valid YAML`,
      error instanceof Error ? error.message : String(error),
    );
  }

  // An empty file is a user who created the file and has not filled it in, which
  // is what the defaults are for. A file whose top level is a list or a string
  // is a structural mistake, and silently defaulting it would discard whatever
  // they did write.
  if (value === null || value === undefined) return freshDefaults();

  // **A plain object, not merely an object**, and the difference is a whole
  // configuration silently discarded. Measured: `!!set` and `!!omap` at the
  // document level make `toJS` return a `Set` and a `Map`, both of which pass a
  // bare `typeof === 'object' && !Array.isArray`, and `Object.keys` on either is
  // empty — so the unknown-key loop finds nothing, no key is ever read, and the
  // user's entire file is replaced by the defaults with no error and no line
  // number. That is this module's own headline failure mode one level above the
  // misspelled key it was built to catch.
  if (!isPlainObject(value)) {
    refuse([`the document: must be a table of keys, found ${typeName(value)}`], []);
  }

  const table = value;

  /** The 1-indexed line a key was written on, for the message to point at. */
  const lines = new Map<string, number>();
  /** Keys whose *value* carried a tag YAML discarded. */
  const eatenTags = new Set<string>();
  const contents: unknown = document.contents;
  const items: unknown =
    contents !== null && typeof contents === 'object' && 'items' in contents ? contents.items : undefined;
  if (Array.isArray(items)) {
    for (const item of items) {
      const key: unknown = (item as { key?: unknown }).key;
      if (key === null || typeof key !== 'object') continue;
      const range: unknown = (key as { range?: unknown }).range;
      const name: unknown = (key as { value?: unknown }).value;
      if (typeof name !== 'string' || !Array.isArray(range)) continue;
      const line = lineOf(typeof range[0] === 'number' ? range[0] : undefined);
      if (line !== undefined) lines.set(name, line);
      // The same eaten-tag rule the exclusion list gets, applied to every key.
      // Measured: `title: ! My Notes` and `origin: ! https://example.com/` were
      // accepted with the tag discarded and no warning — the user wrote
      // something the parser did not understand and got a build that ignored
      // it. `exclude`'s members are checked separately, per member.
      if (name !== 'exclude' && carriesEatenTag((item as { value?: unknown }).value, document)) {
        eatenTags.add(name);
      }
    }
  }

  for (const key of eatenTags) {
    const line = lines.get(key);
    issues.push(
      `${line === undefined ? 'a key' : `line ${line}`}: the value carries a "!" tag, which YAML ` +
        'discards — remove it, or quote the value if the "!" is part of it',
    );
    details.push(`${key} carried an eaten "!" tag`);
  }

  for (const key of Object.keys(table)) {
    if ((KNOWN_KEYS as readonly string[]).includes(key)) continue;
    // The line, never the key. A known key is a literal of this file's table and
    // is printed in full below; an unknown one is user-authored text, and
    // `clients/acme/2026-renewal.md:` is a valid YAML key. The suggestion comes
    // out of the table, so it discloses nothing and tells the user which key
    // they meant — which is the half the line number cannot supply.
    const line = lines.get(key);
    const suggestion = suggestionFor(key);
    issues.push(
      `${line === undefined ? 'a key' : `line ${line}`}: unknown key is not allowed` +
        (suggestion === undefined
          ? `. The keys are ${KNOWN_KEYS.join(', ')}`
          : `. Did you mean "${suggestion}"?`),
    );
    details.push(`unknown key ${JSON.stringify(key)}`);
  }

  if ('title' in table) checkTitle(table['title'], lines.get('title'), issues, details);
  if ('origin' in table) checkOrigin(table['origin'], lines.get('origin'), issues, details);
  if ('language' in table) checkLanguage(table['language'], lines.get('language'), issues, details);
  if ('media' in table) {
    media = checkMedia(
      table['media'],
      lines.get('media'),
      mediaLines(document, lineCounter),
      mediaEatenTags(document),
      issues,
      details,
    );
  }
  if ('exclude' in table) {
    checkExclude(
      table['exclude'],
      lines.get('exclude'),
      excludeLines(document, lineCounter),
      taggedExcludeMembers(document),
      issues,
      details,
    );
  }

  if (issues.length > 0) refuse(issues, details);

  return {
    // No `.trim()`: `checkTitle` has already refused a padded value, so trimming
    // here would be a rewrite that can never fire, and a reader would have to
    // check whether it could.
    title: 'title' in table ? (table['title'] as string) : DEFAULTS.title,
    origin: 'origin' in table ? (table['origin'] as string) : DEFAULTS.origin,
    exclude: 'exclude' in table ? [...(table['exclude'] as string[])] : [],
    language: 'language' in table ? (table['language'] as string) : DEFAULTS.language,
    media,
  };
}

/**
 * The configuration for a build rooted at `directory`, or the defaults.
 *
 * **Absent must work**, and it is the ordinary case rather than a degradation:
 * this tool publishes by default, so a stranger who has written notes and
 * nothing else gets a complete site. What they do not get is an origin — see
 * {@link LoadedConfig} — because the fallback for that belongs to the one place
 * the origin is written down.
 *
 * `directory` being `undefined` means the caller has no user directory to
 * consult at all, which is this repository building itself. Same answer,
 * reached without a filesystem call.
 */
export function loadConfig(directory?: string): LoadedConfig {
  if (directory === undefined) return freshDefaults();

  const path = join(directory, CONFIG_FILENAME);
  if (!existsSync(path)) {
    for (const name of NEAR_MISS_NAMES) {
      if (!existsSync(join(directory, name))) continue;
      // Both names are literals of this file's own source, so the refusal can
      // name them. Refusing rather than reading it: accepting a second spelling
      // is a search order, and a search order is a place for the *next* file to
      // be silently not found.
      throw new BuildFailure(
        'config-misnamed',
        `found ${name}, but the configuration file is ${CONFIG_FILENAME}. ` +
          'Rename it — a file under any other name is not read, and would ' +
          'leave you believing you had configured something.',
        `${name} present, ${CONFIG_FILENAME} absent, in the content directory`,
      );
    }
    return freshDefaults();
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // The path is in the message `readFileSync` composed, and nothing here
    // composed that message. It goes to the private half.
    throw new BuildFailure(
      'config-unreadable',
      `${CONFIG_FILENAME}: exists but could not be read`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return parseConfig(text);
}

/**
 * The exclusion argument `discover()` takes, built from a loaded config.
 *
 * It also carries the configured site `language`, because `discover()` is
 * where an undeclared note's effective language is decided: one options object
 * keeps every caller of `discover()` (build and review) passing the same
 * configuration rather than threading a second argument through each.
 *
 * The return type is imported from the producer rather than restated, so the
 * handoff is checked by `astro check` instead of by a comment: if TK-26's
 * `ExclusionOptions` ever gains a field or changes one, this stops compiling.
 * That is the whole of the "accepted without adaptation" criterion, held at the
 * type level; the gate that calls `discover()` with it holds the other half at
 * run time.
 *
 * `excludeSource` is {@link CONFIG_FILENAME}, which is the shape the producer's
 * `CONFIG_LOCATION` allowlist requires before it will put a source label on a
 * stream — so a zero-match failure names this file rather than falling back to
 * the anonymous literal.
 *
 * **Nothing in the shipped binary calls this yet, and a reader must not assume
 * otherwise.** `bin/anc.mjs` calls `discover(contentDirectory)`
 * with no options, so measured end to end today, a repository whose
 * `publish.config.yaml` excludes `drafts/**` builds and **publishes the drafts**
 * — the only file dropped is the config itself, as `not-markdown`. The same run
 * ignores the configured `title`. That is TK-32's wiring, one line at each call
 * site, and it is stated here rather than left implied because the gate in
 * `tests/config.test.ts` calls `discover` directly and reads as end-to-end
 * evidence when it is not.
 */
export function exclusionOptions(config: LoadedConfig): ExclusionOptions {
  return {
    exclude: config.exclude,
    excludeSource: CONFIG_FILENAME,
    ...(config.language === undefined ? {} : { language: config.language }),
  };
}

/**
 * The environment variable naming the directory holding the user's config.
 *
 * The seam, and the reason it is one. `bin/anc.mjs` changes the
 * working directory to this package's root before Astro is started, so by the
 * time `astro.config.mjs` is evaluated the user's own directory is no longer
 * reachable from `process.cwd()`. `CONTENT_ARTIFACT` already crosses that
 * boundary the same way and for the same reason.
 *
 * **Nothing sets it yet, and that is deliberate rather than unfinished.**
 * Setting it is one line in the CLI, which TK-32 owns along with the rest of the
 * end-to-end wiring; this ticket owns the loader and the config's arrival in
 * `astro.config.mjs`. Until then a packaged build falls back to the shipped
 * default origin, which is the placeholder `astro.config.mjs` documents as safe.
 */
export const CONFIG_DIRECTORY_VARIABLE = 'PUBLISH_CONFIG_DIR';

/**
 * The configuration an Astro build should use, resolved from the environment.
 *
 * `||` rather than `??`, and `src/lib/artifact-source.ts` documents the same
 * choice for the same measured reason: an *empty* environment variable is how a
 * shell unsets one for a single command, and `??` would treat `''` as a
 * directory — making `join('', 'publish.config.yaml')` a relative path resolved
 * against wherever the process happens to be standing.
 */
export function configForBuild(): LoadedConfig {
  const config = loadConfig(process.env[CONFIG_DIRECTORY_VARIABLE] || process.cwd());
  // The configured site language crosses into the page modules the way the
  // title does — an environment variable, because `src/lib/` cannot import
  // this module (see `SITE_TITLE_VARIABLE` in `src/lib/site.ts`). Set here
  // rather than in `astro.config.mjs` so every caller that resolves the build's
  // configuration also publishes its language, and cleared when the user
  // configured none so a value left by an earlier build in the same process
  // cannot leak into this one. The spelling is `SITE_LANGUAGE_VARIABLE` in
  // `src/lib/translations.ts`; `tests/config.test.ts` holds the two equal.
  if (config.language === undefined) delete process.env[SITE_LANGUAGE_VARIABLE];
  else process.env[SITE_LANGUAGE_VARIABLE] = config.language;
  return config;
}

/**
 * The environment variable `src/lib/translations.ts` reads the site language
 * from. Spelled out rather than imported: importing `translations.ts` here would
 * evaluate its `NAV_LANGUAGE` before this module has set the variable.
 */
export const SITE_LANGUAGE_VARIABLE = 'PUBLISH_SITE_LANGUAGE';
