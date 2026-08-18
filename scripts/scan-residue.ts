/**
 * Privacy and security residue scan over the built artifact.
 *
 * This is the last gate before `dist/` becomes what readers receive, and it is
 * the only one that judges the *shipped bytes* rather than an input to them.
 * `scripts/validate-content.ts` scans the content artifact, and
 * `tests/built-routes.test.ts` scans the pages this repository authors for
 * structural disclosure — neither sees the stylesheet, the bundled scripts, the
 * files copied verbatim out of `public/`, or anything a future build step
 * writes. Requirements section 19.1 asks for a scan of the built output, and
 * until this existed it was performed by an agent typing `grep` and recording
 * the result in a report. That is advice, not a gate.
 *
 * Three properties make it evidence rather than decoration:
 *
 * 1. **It fails closed on novelty.** Every file is classified as text, binary,
 *    or a carrier it knows how to open. A file matching none of those fails the
 *    scan by name, so a build step that starts emitting a new kind of file
 *    cannot have it silently pass unscanned. **A carrier it can open but not
 *    read through is the same case**: a database whose table yields no text is
 *    reported, not skipped.
 * 2. **It refuses to pass vacuously.** An empty or missing `dist/`, a `dist/`
 *    with no scannable text in it, or a database holding no rows, is a failure
 *    rather than zero findings.
 * 3. **It reports every finding**, not the first, so one run names the whole
 *    problem.
 *
 * **A file is judged by its bytes, not by its name.** Gzip and SQLite are both
 * recognised by their magic, so a compressed member and a database are opened
 * wherever they appear and under whatever extension. An earlier version anchored
 * the inflate to `pagefind/*.pf_fragment`, which was safe only while every
 * compressed member in the artifact was third-party — a build step compressing
 * this site's own content would have shipped it behind a layer this scan could
 * not open.
 *
 * **What it does not cover**, stated here so the gate is not mistaken for the
 * whole of requirements section 19.1. That list has nine items; this closes
 * six of them — private path markers, work/MSW markers, unresolved wikilinks,
 * absolute local paths, source maps, and unsafe link schemes. The remaining
 * three are covered elsewhere or not at all:
 *
 * - *Non-allowlisted titles or slugs*, and *unexpected routes or assets*, are
 *   properties of the route model rather than of file bytes. `checkCorpus` and
 *   the facet gates in `scripts/validate-content.ts` decide what may exist;
 *   asserting that `dist/` contains nothing beyond what the manifest implies is
 *   TK-09's deny-by-default assets gate (parity plan C5), and it is not
 *   attempted here.
 * - *Secrets, via Gitleaks or equivalent*, is **not covered**. A credential
 *   pattern set is a different tool with a different false-positive profile,
 *   and adding an entropy heuristic here would be a worse version of one. The
 *   structural argument that it matters less on this repository — every byte in
 *   `dist/` derives from a reviewed allowlist — is a reason it is lower risk,
 *   not a reason it is covered.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { basename, extname, join, relative, sep } from 'node:path';
import { BuildFailure } from './write-report.ts';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/** One residue rule: what to look for, and what finding it to report as. */
type Rule = readonly [RegExp, string];

/**
 * What must never reach the built site.
 *
 * The first three mirror `STRUCTURAL_MARKERS` in `src/lib/schema.ts` and the
 * next three mirror its `UNSAFE_SCHEMES`, restated rather than imported: those
 * constants are module-private there, and the two scans judge different
 * corpora. The schema scans the *content artifact's* parsed string values
 * before a build and rejects the artifact; this scans the *bytes of every file
 * the site serves* after one.
 *
 * They are matched against decoded forms as well as raw bytes, for the reason
 * this scan exists at all. An earlier version skipped that on the argument that
 * the schema had already rejected the encoded forms — which is false for
 * exactly the files this gate was written to cover. The schema only ever reads
 * `src/data/content.json`; a file copied verbatim out of `public/`, a
 * stylesheet, or anything a future build step emits passes it untouched. So
 * `msw&#x2F;secret` in a `public/` file reached `dist/` and this scan reported
 * nothing. See `normalizedForms`.
 *
 * The last two are this scan's own, because only a built artifact can carry
 * them: a source map reference (requirements section 19.1, "source maps
 * containing private data") would embed absolute paths from the build machine,
 * and a home-directory path is the POSIX shape of the drive-letter marker the
 * schema already catches.
 */
const RESIDUE_RULES: readonly Rule[] = [
  [/msw\//i, 'private "msw/" path marker'],
  [/\[\[/, 'unresolved [[wikilink]]'],
  [/(?<![A-Za-z])[A-Za-z]:[\\/]/, 'absolute local path'],
  [/(?<![A-Za-z])\/(?:Users|home)\/[A-Za-z0-9._-]+\//, 'absolute home-directory path'],
  [/javascript:/i, 'javascript: URL'],
  [/vbscript:/i, 'vbscript: URL'],
  [/(?<![A-Za-z])file:\/\//i, 'file:// URL'],
  [/data:(?!image\/(?:png|jpe?g|gif|webp|avif);base64,)(?:,|[^,\s]*(?:\/|;base64)[^,\s]*,)/i, 'non-image data: URL'],
  [/sourceMappingURL/, 'source map reference'],
];

/**
 * The one rule that does not apply inside a code region, and why exactly one.
 *
 * `[[` is not a privacy marker — it discloses nothing — it is a producer
 * self-check: TK-27 resolves every wikilink *node*, so a `[[` reaching output
 * from prose means the degradation failed. That reading is only true outside
 * `<code>` and `<pre>`. A note documenting Obsidian syntax is content, and its
 * fence renders as `<code class="language-text">[[not a link]]</code>` —
 * measured through the shipped renderer, brackets intact and unescaped. The
 * artifact-level version of this rule was deleted for that reason
 * (`src/lib/schema.ts`); here it is narrowed instead, because over built output
 * the rule still catches something real that nothing else does.
 *
 * Every other rule keeps applying everywhere. An absolute path or a
 * `javascript:` URL inside a fence is exactly as much of a disclosure as one in
 * a paragraph — more, if anything, because a reader is likelier to copy it.
 */
const CODE_EXEMPT: ReadonlySet<string> = new Set(['unresolved [[wikilink]]']);

/**
 * The contents of every `<code>` and `<pre>` element blanked.
 *
 * Blanked rather than removed, so byte offsets are unchanged and the text either
 * side of a fence cannot be joined into a marker that neither half contains —
 * the same reason `normalizedForms` refuses a whitespace-stripped form.
 *
 * ## Why the tag alone, and not `class="language-…"` as well
 *
 * A `<code>` a *note body* wrote is exempted too, and that was tested rather
 * than assumed. `sanitize-html` allows `code` as a raw tag, so a body containing
 * `Text with a raw <code> tag then [[stray]] after.` renders as
 * `<p>Text with a raw <code> tag …</code></p>` — a `<code>` element wrapping
 * ordinary prose, with no language class. Requiring the class looked like the
 * safer rule and is measurably worse:
 *
 * - **The escape it closes is unreachable.** Put that exact body through the
 *   real producer and the traversal parses `[[stray]]` as a link node and
 *   degrades it, so the artifact reads `then stray after.` and the rendered page
 *   contains no `[[` at all. A note cannot carry a stray `[[` into prose in the
 *   first place — that is what this rule is checking for, and it is checking for
 *   a *producer* defect, not for anything a body can arrange.
 * - **It breaks a case that is real.** Inline code renders as a bare
 *   `<code>[[syntax]]</code>` with no class — measured — so requiring the class
 *   makes ``Inline `[[syntax]]` here`` fail the build. Documenting wikilink
 *   syntax inline is exactly as legitimate as documenting it in a fence.
 *
 * So the exemption is the tag, and the reason it is safe is not that a body
 * cannot write the tag: it is that a body cannot produce the *marker* this rule
 * looks for. If a future change lets one, this comment is where to start.
 *
 * Non-greedy, and tag-name-anchored on both ends: `<pre` matches `<pre>` and
 * `<pre tabindex="0">` alike, which is what this pipeline emits, while `</pre>`
 * closes only a `pre`. Nesting is not handled and does not need to be — `code`
 * inside `pre` is the only nesting that occurs here, and blanking the outer
 * covers the inner.
 *
 * **Every ambiguous shape fails closed**, measured: an unclosed `<code>`, a
 * `</code>` inside an attribute value, and a stray between two fences are all
 * still reported. That is the direction an exemption has to err in.
 */
function withoutCodeRegions(text: string): string {
  return text.replace(
    /<(pre|code)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
    (whole, tag: string, _attributes: string | undefined, body: string) =>
      whole.slice(0, whole.length - body.length - `</${tag}>`.length) +
      ' '.repeat(body.length) +
      `</${tag}>`,
  );
}

/**
 * The forms of one file's text a browser could resolve a marker out of.
 *
 * Three, mirroring `checkPrivacy` in `src/lib/schema.ts` and for the same
 * reasons. The raw bytes, because that is what ships. The entity-decoded text,
 * because `&#x2F;` is a `/` to every HTML parser and `msw&#x2F;secret` is the
 * `msw/` marker wearing a hat. And the decoded text with format characters
 * removed, because a zero-width joiner between `msw` and `/` is invisible in
 * the rendered page and defeats a literal match.
 *
 * A whitespace-stripped form is deliberately absent: joining lines turns
 * ordinary prose such as "Option A:" above "/usr/bin" into an apparent drive
 * path, which is the false positive the schema documents avoiding.
 */
function normalizedForms(text: string): string[] {
  const decoded = decodeHtmlEntities(text);
  return [text, decoded, decoded.replace(/\p{Cf}+/gu, '')];
}

/**
 * Decode the numeric and named entity forms a browser resolves.
 *
 * Deliberately small: the named set is the handful whose expansion produces a
 * character that appears in a marker — a separator, a scheme's colon, or a
 * bracket. Decoding every named entity in HTML would need a table this file has
 * no reason to carry, and the ones omitted cannot manufacture a marker.
 *
 * The trailing `;` is optional, matching `decodeEntities` in
 * `src/lib/schema.ts`, which is the reference implementation for what counts as
 * a marker. HTML5 decodes a numeric reference without it — the missing
 * semicolon is a parse error that still yields the character — so
 * `msw&#x2F secret` renders as the private path marker. An earlier version of
 * this file required the semicolon and let that through, on a comment claiming
 * the schema had the same gap. It does not, and never did: the two decoders
 * differed by exactly this character, and the scan was the weaker one.
 *
 * Double encoding is deliberately *not* followed. `&amp;#x2F;` renders as the
 * literal text `&#x2F;` in a browser, not as `/`, so decoding twice would
 * invent a marker the reader never sees.
 */
function decodeHtmlEntities(text: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    colon: ':',
    lsqb: '[',
    sol: '/',
    rsqb: ']',
    bsol: '\\',
    tab: '\t',
    newline: '\n',
  };
  return text.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));?/g,
    (match, decimal?: string, hex?: string, name?: string) => {
      const code = decimal === undefined ? (hex === undefined ? NaN : parseInt(hex, 16)) : Number(decimal);
      if (Number.isFinite(code)) return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      return (name === undefined ? undefined : named[name.toLowerCase()]) ?? match;
    },
  );
}

/**
 * File kinds whose bytes are text, and are therefore scanned.
 *
 * `.xml` is here ahead of the first feed or sitemap: scanning a format that
 * does not exist yet costs nothing and errs toward coverage, whereas omitting
 * it would put the first one in the unclassified bucket.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.svg',
  '.txt',
  '.xml',
]);

/** Extensionless files Cloudflare Pages reads. Both are text and both ship. */
const TEXT_NAMES: ReadonlySet<string> = new Set(['_headers', '_redirects']);

/**
 * File kinds whose bytes are not text, so a marker search over them reports
 * coincidences rather than residue.
 *
 * Mirrors the `binary` list in `.gitattributes`, plus `.jpeg` — which that file
 * omits because nothing in the tree uses the spelling, and which is listed here
 * because an unlisted extension would fail the scan as unclassified rather than
 * be treated as the image it is. These are not *unscanned by
 * accident* — they are declared, which is what separates them from a file kind
 * nobody has considered.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ico',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.woff',
  '.woff2',
]);

/**
 * Pagefind's own bundle, excluded with a reason rather than by convenience —
 * **except for its fragments, which are read after inflating.**
 *
 * Its runtime — `pagefind*.js`, `.css`, and two WebAssembly binaries — is
 * third-party code this repository does not author; it legitimately contains
 * `javascript:void(0)` in its form markup, and the compiled WebAssembly contains
 * `[[` as a byte coincidence.
 *
 * ## The index was excluded on an argument that is measurably false
 *
 * That argument was: Pagefind indexes exactly the `data-pagefind-body` subtree
 * of the built HTML, that HTML is scanned here in full, so nothing reaches the
 * index without first appearing in a page this scan reads. It is wrong in one
 * direction that matters, because **a fragment stores extracted text, not
 * markup** — decoded, and with inline elements joined.
 *
 * Measured on a real packaged build, from an ordinary note body:
 *
 * - `A path ms**w/s**ecret here.` renders as `ms<strong>w/s</strong>ecret`. No
 *   byte sequence anywhere in `dist/` contains `msw/`; the fragment contains it.
 *   The build reported `residue scan ok: 25 files, 0 findings`.
 * - The same split carried `/home/someone/`, `javascript:`, and
 *   `sourceMappingURL` into the fragment, each invisible to every raw read.
 * - HTML escaping does it too, without any markup: a body containing
 *   `zzqacme&secret` ships `&amp;` in the page and the decoded form in the
 *   fragment.
 *
 * So a marker split by emphasis, or merely containing an `&`, reached the
 * shipped search index past a green scan. That is the failure mode a privacy
 * gate may not have, and it is not hypothetical — a reader typing the marker
 * into the site's own search box gets the page back.
 *
 * ## Why only the fragments
 *
 * **Because the fragment is the source the other members are derived from.**
 * Every other member of the bundle — `.pf_index`, `.pf_meta`, `.pf_filter`, and
 * the two `.pagefind` blobs — is built from the same extracted text a fragment
 * stores verbatim, so any marker reaching them has already passed through a
 * fragment this scan now reads. That argument is what makes the exclusion safe,
 * and it survives a new rule being added to {@link RESIDUE_RULES} — which is the
 * property the earlier reasoning here lacked.
 *
 * **The set is stated as "everything in the bundle that is not a fragment"
 * rather than as a list, and that is deliberate.** An earlier version of this
 * comment enumerated `.pf_index` and `.pf_meta` as though they were the whole
 * excluded set, which is how `.pf_filter` — under `pagefind/filter/`, and the
 * member that stores its values *least* digested of any — went unnamed. It is
 * genuinely covered, because a filter value is also in its fragment's `filters`
 * key, and this build emits none: nothing under `src/` writes
 * `data-pagefind-filter` (`src/scripts/search-dialog.ts:482` records that too).
 * But an auditor reading a list looks for the members on it. The code has always
 * excluded by "not a fragment"; the comment now says the same thing.
 *
 * A weaker argument was written first and is recorded because it is wrong in an
 * instructive way: that a word list is split on punctuation, so a marker cannot
 * survive in one as a matchable string. Measured, a token of pure letters
 * reaches `.pf_index` intact and **lowercased** — `sourceMappingXYZ` is stored
 * as `sourcemappingxyz`. So `sourceMappingURL`, the one rule here that is a bare
 * word, misses it only because that rule carries no `i` flag. The exclusion was
 * resting on a regular-expression flag nobody had written down, and adding `i`
 * to that rule — a change that reads as strictly safer — would have opened the
 * surface silently.
 *
 * The two `.pagefind` blobs stay excluded, and they are not what their name
 * suggests: measured, both begin with the gzip magic `1f 8b`, and their inflated
 * bytes begin `pagefind` rather than the WebAssembly `\0asm`. Inflated they
 * carry no marker; **raw** they trip the `[[` rule as a byte coincidence, which
 * is the actual reason to keep them out.
 *
 * `tests/built-output.test.ts` draws the same third-party boundary for the same
 * reason, though more loosely — it matches `pagefind` anywhere in the path.
 * This is anchored at the root instead, because loose matching has a false-pass
 * mode a privacy gate must not have: Pagefind's bundle is emitted to exactly
 * `dist/pagefind/`, but a published note slugged `pagefind` builds to
 * `dist/notes/pagefind/index.html`, and a substring test would exclude that
 * page from the scan entirely. Anchoring costs nothing and removes the case.
 */
const THIRD_PARTY = 'pagefind';

/** The one member of that bundle whose text is this site's own content. */
const FRAGMENT_EXTENSION = '.pf_fragment';

/**
 * The rules that do not apply to a fragment, and the one reason they do not.
 *
 * A fragment is extracted *text*: Pagefind strips the markup before storing it,
 * so a fenced ` ```text\n[[not a link]] ` arrives with no `<code>` element left
 * to exempt it. Measured — the fragment for such a note reads
 * `"content":"Obsidian writes a link as: [[not a link]]"` while the page it came
 * from reads `<code class="language-text">[[not a link]]</code>`. Applying the
 * wikilink rule there would fail the build on a note documenting Obsidian
 * syntax, which is exactly the case {@link CODE_EXEMPT} exists to permit, and it
 * would do so with no way for the author to escape it.
 *
 * Dropping it costs nothing, because `[[` is the one rule that is not a privacy
 * marker. It discloses nothing; it is a producer self-check over *rendered
 * prose*, and the rendered prose is scanned in full. A `[[` that reaches a
 * fragment either came from a code region — legitimate — or came from prose, in
 * which case the page carrying that prose fails this scan first.
 *
 * Every other rule applies. A path or a scheme in a fragment is a disclosure
 * wherever it came from, and the search box will hand it to a reader.
 *
 * **Spelled out rather than aliased to {@link CODE_EXEMPT}, though the two hold
 * the same member today.** They encode opposite decisions: `CODE_EXEMPT`
 * *narrows* a rule, blanking code regions while still catching the marker in
 * prose either side, and this one *drops* a rule outright. A second rule added
 * to `CODE_EXEMPT` for the narrowing reason would, through an alias, silently
 * become disabled over the whole search index — and there is nothing about those
 * two reasons that makes them co-vary. The duplicated literal is the cost of
 * keeping one edit from meaning two things.
 */
const FRAGMENT_EXEMPT: ReadonlySet<string> = new Set(['unresolved [[wikilink]]']);

/**
 * The rules that do not apply to a database's raw bytes, and why exactly one.
 *
 * A database is read twice — as rows, and as bytes — and the byte pass exists
 * for one thing only: a deleted row's payload, which survives in the file until
 * a `VACUUM` and which no `SELECT` can reach. Its cost was measured across four
 * corpus sizes, and it is zero until the file gets large: at 0.2 MB, 2.1 MB and
 * 43 MB no rule matched the bytes that did not also match a row, and at 172 MB
 * exactly one did — `[[`, struck by a **B-tree interior page's cell-pointer
 * array**, where a run of two-byte big-endian offsets happens to spell `5b 5b`.
 * Verified at byte 95,618,728 of a 12,000-row database of pure `x`/`y` padding:
 * the surrounding bytes are `00 00 5f 21 b6 2c 00 00 5f 1a b6 2a`, no row
 * contains `[[`, and the hits scale with the pointer array rather than with
 * anything authored.
 *
 * So the rule is dropped over bytes and kept over rows, and that split is not a
 * weakening: `[[` is the one rule here that is **not** a privacy marker — it
 * discloses nothing, it is the producer's self-check that link degradation ran,
 * and what it is a check *on* is authored text. A `[[` in a free page came from
 * a row that was authored and then withheld; if the degradation failed, it
 * failed on the live rows too and is caught there. Reading it off B-tree
 * structure measures SQLite's file format, not the corpus.
 *
 * Every other rule applies to both. A path, a scheme or a source-map reference
 * found in a free page is a real disclosure — that is the whole reason the byte
 * pass exists, and none of them can be spelled by a pointer array: each requires
 * a multi-character literal that a run of offsets does not produce, which the
 * same sweep confirms at every size measured.
 *
 * **Spelled out rather than aliased to {@link FRAGMENT_EXEMPT} or
 * {@link CODE_EXEMPT}, though all three hold the same member today**, for the
 * reason `FRAGMENT_EXEMPT` already states: they encode three different
 * decisions — narrow a rule, drop it over one carrier, drop it over one *pass*
 * of one carrier — and nothing makes those three co-vary.
 */
const RAW_BYTES_EXEMPT: ReadonlySet<string> = new Set(['unresolved [[wikilink]]']);

/**
 * The first sixteen bytes of every SQLite file, and the reason the database
 * branch keys on them rather than on an extension.
 *
 * An extension is a naming convention: `.sqlite3`, `.db`, `.sqlite`, or no
 * extension at all are the same format, and a build step choosing a fifth
 * spelling would fall through to the unclassified branch — correct, but it
 * fails the build on a file this scan is now able to read. The header is what
 * the format actually guarantees, so the classifier asks the bytes.
 *
 * This does not weaken the fail-closed property. A file whose first bytes are
 * not this magic is classified exactly as it was before; a file whose bytes
 * *are* this magic and which SQLite then refuses to open is reported, not
 * skipped.
 */
const SQLITE_MAGIC = 'SQLite format 3\0';

/** The first two bytes of a gzip member. */
const GZIP_MAGIC: readonly [number, number] = [0x1f, 0x8b];

/**
 * `node:sqlite` is loaded through `createRequire` rather than imported.
 *
 * This module is imported by five test files and by `bin/thoughtscape-publish.mjs`
 * on every build, and all but one of those runs scan a `dist/` holding no
 * database at all. A static import would load the SQLite binding into every one
 * of them to serve a branch they never reach.
 *
 * It is a Node builtin, so it needs no entry in `package.json` — which
 * `tests/packaging.test.ts`'s undeclared-import gate checks, and which is why a
 * third-party SQLite package would have been a worse answer even before the
 * runtime cost.
 */
const loadSqlite = (): typeof import('node:sqlite') =>
  createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Every text value a database carries, as rows rather than as bytes.
 *
 * ## Why rows, and why bytes are still read alongside them
 *
 * A byte scan of a SQLite file is not a scan of its contents, for a reason that
 * is this project's own recurring defect in a new carrier. A row larger than a
 * page is stored as a chain of overflow pages, each linked by a **4-byte
 * pointer written into the middle of the payload** — so a marker straddling a
 * page boundary exists in the file as two fragments with four bytes of pointer
 * between them, and matches nothing. Measured here: sweeping
 * `/home/someone/private` through a fixed-length body across 12,000 rows at
 * `page_size=4096`, **60 rows carried the marker where the file's bytes did
 * not**, while all 12,000 were returned by a single `SELECT … LIKE`. At byte
 * 81,694,700 a page ends `/home/someone/privat`, four pointer bytes follow, then
 * `e`. That is TK-29's `ms**w/s**ecret` again — a marker the reader receives
 * whole and no raw read can see — arriving through B-tree structure instead of
 * markup.
 *
 * So reading rows is what makes the scan see the database at all. The bytes are
 * read **as well**, and the reason is the opposite direction of the same
 * question: a deleted row's payload stays in the file until a `VACUUM`
 * reclaims it, and a `SELECT` cannot see it. Measured: a row inserted and then
 * deleted left `WITHHELD /home/someone/private msw/secret` in the file with
 * `freelist_count` at 0, invisible to every query and present in every byte a
 * reader downloads. Under an artifact the reader receives whole, that is a
 * withheld note shipping.
 *
 * Neither read subsumes the other, and the cost of running both is measured at
 * zero: over a database built from this repository's own `docs/`, **no rule
 * matched in the bytes that did not also match in the rows** — the byte pass
 * contributes no false positive of its own, only the free-page case.
 *
 * ## What "every text value" means
 *
 * Every user table in `sqlite_schema`, every column, every row. Not a named set
 * of columns: a scan that knows the schema is a scan that goes blind the first
 * time a column is added, and the whole point of the fail-closed classifier is
 * that novelty is not silently skipped.
 *
 * **A BLOB is read as text too**, and an earlier version of this function
 * skipped one on the argument that a BLOB is bytes already read by the byte
 * pass. That argument is false for exactly the reason this function exists: the
 * byte pass cannot see across an overflow-page boundary, and a BLOB body
 * overflows identically to a TEXT one. Measured — the same boundary fixture with
 * the column typed `BLOB` carried the marker in three rows, satisfied no rule
 * over the file's bytes, and produced zero findings. Values that are numbers or
 * null are ignored, because neither can carry a marker.
 *
 * @returns The text of every row as separate values, and the tables that could
 *   not be read as text. **Separate, never joined**: concatenating two rows
 *   manufactures a marker that neither carries, which is the same false positive
 *   {@link normalizedForms} refuses a whitespace-stripped form to avoid. It also
 *   keeps the scan's peak memory to one copy of the corpus — measured, joining
 *   them exhausted a 4 GB heap on a 168 MB database. `corpusRows` counts only
 *   rows of tables that yielded text, which is what makes it a coverage measure
 *   rather than a count of SQLite's own bookkeeping. A caller must treat a
 *   non-empty `unreadable` as a finding: see the database branch of
 *   {@link scanResidue}.
 */
/** What one database yielded. See {@link databaseText}. */
interface DatabaseRead {
  values: string[];
  corpusRows: number;
  unreadable: string[];
}

/**
 * @param bytes The database, as bytes — the inflated payload where it was
 *   compressed.
 * @param path Where those bytes came from, when they came from a file. Used only
 *   as a fallback: a WAL-mode header is refused by `deserialize` and readable
 *   from its path. An inflated gzip member has no path and passes `undefined`.
 */
function databaseText(bytes: Uint8Array, path?: string): DatabaseRead {
  const { DatabaseSync } = loadSqlite();
  // Opened from the buffer rather than from the path, so one code path serves
  // both a database on disk and one recovered by inflating a gzip member — and
  // so the scan cannot write to, or create a journal beside, the artifact it is
  // judging.
  const database = new DatabaseSync(':memory:');
  try {
    // **A WAL-mode file is read from its path instead.** A database whose header
    // declares WAL (bytes 18 and 19 are 2) cannot be served from a buffer: the
    // format's shared-memory index has no in-memory equivalent, and measured,
    // `deserialize` *succeeds* on such a file while the first query then throws
    // "unable to open database file". So the fallback is keyed on the whole
    // read failing rather than on the open — the open is not where it fails.
    // That is a common `journal_mode`, and reporting it as unopenable would send
    // the reader to a fix that is not the problem.
    //
    // The buffer stays the default because it is the only path that can serve an
    // inflated gzip member, which has no file to open.
    try {
      database.deserialize(bytes);
      return readOpenDatabase(database);
    } catch (error) {
      if (path === undefined) throw error;
      // Not `readOnly`: a WAL database needs its `-shm` file and a read-only
      // connection cannot create one. Anything this leaves beside the artifact
      // is itself scanned — a stray `-wal` or `-shm` in `dist/` falls through to
      // the unclassified branch and fails the build by name, which is the
      // fail-closed classifier covering this function's own side effects.
      const fromDisk = new DatabaseSync(path);
      try {
        return readOpenDatabase(fromDisk);
      } finally {
        fromDisk.close();
      }
    }
  } finally {
    database.close();
  }
}

/** The reading half of {@link databaseText}, over a handle already open. */
function readOpenDatabase(database: {
  prepare: (sql: string) => { all: () => unknown[] };
  exec: (sql: string) => void;
}): DatabaseRead {
  const values: string[] = [];
  const unreadable: string[] = [];
  let corpusRows = 0;
  let vocabSequence = 0;
  const orphanCandidates: { name: string; terms: string[] }[] = [];
  // Row text only, kept apart from `values` so an index's terms are not checked
  // for orphanhood against themselves. See the orphan pass below.
  const rowText: string[] = [];

  const tables = database
    .prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
    .all() as { name: string; sql: string | null }[];
  const virtualNames = tables
    .filter(({ sql }) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? ''))
    .map(({ name }) => name);

  for (const { name, sql } of tables) {
    const isVirtual = /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? '');
    const isShadow = virtualNames.some((owner) => name.startsWith(`${owner}_`));
    let rows: Record<string, unknown>[];
    try {
      rows = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Record<
        string,
        unknown
      >[];
    } catch {
      // A table that exists and cannot be selected from is "could not look",
      // and lesson 3 of `docs/gate-reading.md` is that it must not be spelled
      // like "looked and found nothing".
      unreadable.push(name);
      continue;
    }

    let textValues = 0;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string' && value.length > 0) {
          textValues += 1;
          values.push(value);
          if (!isShadow) rowText.push(value);
        } else if (value instanceof Uint8Array && value.length > 0) {
          // A BLOB, read as text for the reason stated above: the byte pass
          // cannot see across an overflow-page boundary and a BLOB body
          // overflows exactly as a TEXT one does.
          //
          // **Inflated first where it is a gzip member**, by the same rule the
          // file loop applies and for the same reason: a compressed body is
          // unreadable to both passes at once. Measured — a note stored as
          // `gzip(body)` in a BLOB column produced zero findings, with the
          // marker absent from the file's bytes and absent from the value.
          // Storing bodies compressed is the obvious thing to do when the
          // whole database is downloaded, so this is the shape a real build
          // takes rather than a contrived one. An inflate failure falls back
          // to the raw value, which is the *conservative* direction here: the
          // value is still scanned, unlike a file-level failure where falling
          // back would mean scanning compressed bytes and calling it clean.
          textValues += 1;
          let blob = Buffer.from(value);
          if (blob.length >= 2 && blob[0] === GZIP_MAGIC[0] && blob[1] === GZIP_MAGIC[1]) {
            try {
              blob = Buffer.from(gunzipSync(blob));
            } catch {
              // Kept as the raw bytes, and still scanned.
            }
          }
          values.push(blob.toString('utf8'));
          // **Not counted toward the orphan corpus when this is a shadow
          // table.** An FTS5 `_data` blob stores the index's own term list, so
          // including it means every term finds itself there and no index can
          // ever have an orphan — measured, the stale case came back clean with
          // its five withheld terms visible inside `s_data`. The corpus an index
          // is checked against has to be the text a *reader* gets back, which is
          // the ordinary tables.
          if (!isShadow) rowText.push(blob.toString('utf8'));
        }
      }
    }
    // **Only a corpus table's rows count toward coverage.** Counting every row
    // makes the guard satisfiable by SQLite's own bookkeeping: measured, a
    // database with zero notes and one empty FTS5 index reports three rows —
    // two from its `_data` shadow table and one from `_config`, whose single
    // text value is the literal `"version"`. A build shipping an empty corpus
    // would then pass a non-zero row count, and the guard is meant to move
    // with what is published.
    //
    // A shadow table is one whose name is a virtual table's name plus a known
    // suffix, which is how SQLite itself names them. Excluded by that shape
    // rather than by a list of suffixes, so a future FTS5 version adding a
    // fourth shadow table is covered by the sentence rather than missing from
    // an enumeration — the corollary about enumerations in
    // `docs/gate-reading.md`.
    if (textValues > 0 && !isShadow) corpusRows += rows.length;

    // **An index's own terms, read through `fts5vocab`, and counted.** A
    // full-text index is a second copy of the corpus and it does not have to
    // agree with the first: an external-content index whose source row is
    // later rewritten keeps the *old* terms, `SELECT` returns the new body,
    // `integrity-check` does not notice, and prefix compression hides them
    // from the byte pass. Measured — a note rewritten after indexing, then
    // `VACUUM`ed, left `msw path secret someone` recoverable by any reader in
    // one statement.
    //
    // The terms are pushed as subjects like any other text, but they are also
    // what decides the unreadable finding below, and the two are different
    // questions. A tokenizer is lossy: `unicode61` splits `msw/secret` into
    // `msw` and `secret`, so **no marker rule can match a term even when the
    // index plainly carries the marker**. Reading the terms therefore proves
    // the index is *enumerable*, not that it is *scannable* — and an index
    // holding text no rule can be applied to is exactly the "could not look"
    // case, whether it is contentless or merely tokenized.
    const vocabTerms: string[] = [];
    let vocabReadable = false;
    if (isVirtual && /\bfts5\b/i.test(sql ?? '')) {
      const view = `residue_vocab_${vocabSequence++}`;
      try {
        // **The schema is named explicitly.** An `fts5vocab` table created in
        // `temp` resolves its target in `temp` too — measured, the
        // `temp.`-qualified form fails with `no such fts5 table: temp.search`
        // — so the two-argument form naming `main` is what reaches the index.
        // The first version of this used the qualified form and therefore
        // never read a term: every index landed in `unreadable` instead,
        // which reads as a stricter gate and is in fact a blinder one.
        database.exec(
          `CREATE VIRTUAL TABLE temp."${view}" USING fts5vocab(main, "${name.replaceAll('"', '""')}", 'row')`,
        );
        for (const { term } of database.prepare(`SELECT term FROM temp."${view}"`).all() as {
          term: string | null;
        }[]) {
          if (typeof term === 'string' && term.length > 0) {
            vocabTerms.push(term);
            values.push(term);
          }
        }
        vocabReadable = true;
      } catch {
        // An index whose terms cannot be enumerated at all is the strongest
        // form of the same case.
        vocabReadable = false;
      } finally {
        // Dropped whether or not the read succeeded: a live virtual table
        // keeps a handle on the file, and on Windows that makes the artifact
        // undeletable by anything that runs after the scan.
        try {
          database.exec(`DROP TABLE IF EXISTS temp."${view}"`);
        } catch {
          // Already absent because the create failed, which is the only way
          // here — and nothing downstream depends on it.
        }
      }
    }

    // **A contentless FTS5 index is the case this check exists for**, and it
    // is unreadable in both directions at once — which is what makes it a
    // finding rather than an exclusion. Measured on `fts5(body, content='')`:
    // `SELECT body` returns `null` for every row and `snippet()` returns
    // `null`, so it carries no text to read; and its stored terms are not
    // byte-findable either, because `unicode61` strips the separators every
    // rule here keys on (`msw/` absent while `msw` present, `javascript:`
    // absent while `javascript` present, `C:/` absent) and prefix compression
    // stores a term sharing a prefix with its neighbour as a suffix only
    // (`zzqalpha zzqalphabet zzqalphabetical` leaves only `zzqalpha`
    // findable). An index this scan can neither query nor grep is exactly the
    // artifact the header's property 1 refuses to pass in silence.
    //
    // Keyed on the measured shape — a virtual table holding rows and yielding
    // no text — rather than on parsing `content=''` out of the DDL, because
    // the spelling varies (`content=''`, `content=""`, `content = ''` all
    // measured) while the shape does not. An *empty* contentless index yields
    // no rows and is not reported: it holds nothing to disclose.
    //
    // **Decided after the vocab read.** A tokenizer is lossy — `unicode61`
    // splits `msw/secret` into `msw` and `secret`, so no marker rule can match a
    // term even when the index plainly carries the marker — which is why the
    // question here is whether the index's text is *readable*, not whether a
    // rule fired on it.
    if (isVirtual && (rows.length > 0 || vocabTerms.length > 0) && textValues === 0) {
      unreadable.push(name);
    } else if (isVirtual && !vocabReadable) {
      // An index whose terms cannot be enumerated at all, which is stronger.
      unreadable.push(name);
    } else {
      // **An orphan term is a second copy of the corpus disagreeing with the
      // first.** An index does not have to match the table it was built from:
      // measured, rewriting a note's source row without reindexing leaves the
      // *old* terms in the index while `SELECT` returns the new body,
      // `integrity-check` passes, and `VACUUM` plus prefix compression keeps
      // them out of the file's bytes — `a here msw path secret` recoverable by
      // any reader in one statement, from a note the build withdrew.
      //
      // So the terms are held back and checked against everything else the
      // database yielded. A term no readable text accounts for is a payload no
      // `SELECT` reaches and no byte read spells, which is the free-page case in
      // a different store. A fresh index has no orphan — measured, zero for
      // external-content, owned-content, and contentless alike — so this costs
      // nothing on a database whose index agrees with its corpus.
      orphanCandidates.push({ name, terms: vocabTerms });
    }
  }

  // Checked after every table, because a term is only an orphan if *no* table
  // accounts for it, and the table that does may come later in the schema.
  //
  // **Checked against the row text, not against `values`.** `values` carries the
  // terms themselves — they are scanned as subjects like any other text — so
  // every term would find itself and no index could ever have an orphan. The
  // corpus here is what the *tables* yielded, which is the thing an index is
  // supposed to agree with.
  const corpus = rowText.join('\n').toLowerCase();
  for (const { name, terms } of orphanCandidates) {
    if (terms.some((term) => !corpus.includes(term.toLowerCase()))) unreadable.push(name);
  }

  return { values, corpusRows, unreadable };
}

/**
 * The forms of a Markdown body a *reader* resolves a marker out of.
 *
 * A database stores Markdown source, and the reader receives what a renderer
 * makes of it. That gap is precisely the surface TK-29 closed for the search
 * index and which storing source would otherwise reopen: a body written
 * `ms**w/s**ecret` renders as `ms<strong>w/s</strong>ecret`, whose text is
 * `msw/secret`, while the stored bytes contain no `msw/` anywhere. Measured
 * both ways — through the real renderer, `ms**w/s**ecret`, `ms*w/s*ecret` and
 * ``ms`w/s`ecret`` all reach the page as the marker.
 *
 * So the delimiters stripped here are the ones the shipped renderer actually
 * consumes *between two word characters*: `*`, `_` and a backtick. That the set
 * is measured rather than assumed matters in both directions — `ms__w/s__ecret`
 * and `ms_w/s_ecret` were measured **not** to join, because CommonMark does not
 * open intra-word emphasis on underscores, so including `_` is this form being
 * deliberately wider than the renderer rather than narrower.
 *
 * The tag form is the same defect wearing HTML, for the day a body carries raw
 * inline markup or a column stores rendered fragments.
 *
 * **Anchored between two non-delimiter, non-space characters**, which is what
 * keeps it from inventing markers: ordinary emphasis (`**bold** at edges`) and
 * spaced asterisks (`a * b * c`) are untouched. Swept over every tracked `.md`,
 * `.ts` and `.astro` file in this repository — 104 files — and over every text
 * file in a built `dist/`, **no rule matched a joined form that did not already
 * match the raw text**. The cost it does carry is real and small:
 * `snake_case_name` joins to `snakecasename`, which no rule here can match.
 *
 * **A tag is replaced by a space, not removed**, and that is not symmetry with
 * the emphasis form — it is the one place this transform can invent a marker.
 * Deleting the tag lets the text either side abut, so `Option A:<br>/usr/bin`
 * becomes `Option A:/usr/bin` and trips the absolute-path rule on ordinary
 * prose; measured, along with `<td>A:</td><td>/usr</td>`. That is precisely the
 * false positive {@link normalizedForms} refuses a whitespace-stripped form to
 * avoid.
 *
 * **Anchored inside a word**, which is what keeps the joining honest: a tag
 * joins only where both sides are word characters, because that is the only
 * shape a renderer joins into a single word. `ms<strong>w/s</strong>ecret`
 * becomes `msw/secret`; `A:<br>/usr` does not become `A:/usr`, because `:` is
 * not a word character and no reader sees those two run together.
 */
function joinedForms(text: string): string[] {
  return [
    text.replace(/(?<=[^\s*_`])[*_`]+(?=[^\s*_`])/g, ''),
    text.replace(/(?<=[A-Za-z0-9])<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?>(?=[A-Za-z0-9])/g, ''),
    text.replace(/<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?>/g, ' '),
  ];
}

/**
 * Every form of one database subject a marker could be resolved out of, lazily.
 *
 * A generator rather than an array because a database subject is the whole
 * corpus: materialising all nine forms at once held 1.16 GB for a 129 MB file
 * and exhausted a 4 GB heap at 304 MB. Yielded one at a time, the caller's
 * first match ends the walk and at most one derived string is live.
 */
function* databaseForms(subject: string): Generator<string> {
  yield* normalizedForms(subject);
  for (const joined of joinedForms(subject)) yield* normalizedForms(joined);
}

/**
 * Markdown fenced and inline code spans blanked, so `[[` inside them is exempt.
 *
 * The sibling of {@link withoutCodeRegions}, and it exists because that function
 * cannot serve this carrier: it keys on `<code>` and `<pre>` elements, and a
 * database row holds Markdown that has no elements in it yet. Measured — the
 * same note that builds clean today, whose page carries
 * `<code class="language-text">[[not a link]]</code>`, stores a body that
 * survives `withoutCodeRegions` untouched and trips the wikilink rule.
 *
 * **The reasoning at {@link CODE_EXEMPT} is what is being carried across, not
 * its implementation.** A note documenting Obsidian syntax is content; the
 * `[[` rule is the producer's self-check that link degradation ran, and that
 * reading is only true outside a code region. Which characters delimit a code
 * region is a property of the carrier, so the rule keeps its meaning by
 * changing its blanking to match. Dropping the rule instead — the shape
 * {@link FRAGMENT_EXEMPT} takes — would be wrong here for the reason stated
 * there: a fragment's prose is scanned in full on the page it came from, and a
 * database's is not scanned anywhere else.
 *
 * Blanked rather than removed, for {@link withoutCodeRegions}'s reason: offsets
 * are unchanged, so text either side of a fence cannot be joined into a marker
 * neither half contains.
 *
 * ## Which shapes count as code, and why the list is longer than fences
 *
 * Every shape below was checked **through the shipped renderer**, and each one
 * puts its content inside a `<code>` element on the page — so failing the build
 * on it fails on content the site publishes cleanly, with no escape available to
 * the author. That is the wall of false positives this exemption exists to
 * prevent, and an earlier version of this function produced it on four shapes at
 * once:
 *
 * - A **fenced block**, with up to three spaces of indent on either fence, which
 *   is what CommonMark permits.
 * - A **fence inside a blockquote**, where every line carries a `>` prefix.
 * - An **indented code block** — four spaces or a tab — which is ordinary
 *   Markdown and carries no fence at all.
 * - An **inline span**, between matched backtick runs.
 *
 * Fences first, then indented blocks, then inline spans, so a backtick inside a
 * fenced block cannot open a span that swallows the prose after it.
 *
 * **Every ambiguous shape fails closed** — an unterminated fence and an unpaired
 * backtick both leave the text after them scanned.
 */
function withoutMarkdownCode(text: string): string {
  const blankLines = (block: string): string =>
    block.replace(/[^\n]/g, ' ');
  return text
    .replace(
      /(^|\n)([ \t]{0,3}(?:> ?)*)(```+|~~~+)([^\n]*\n)([\s\S]*?)(\n[ \t]{0,3}(?:> ?)*\3)/g,
      (_whole, lead: string, quote: string, fence: string, info: string, body: string, end: string) =>
        `${lead}${quote}${fence}${info}${blankLines(body)}${end}`,
    )
    // An indented code block: a run of lines each starting with four spaces or a
    // tab, after a blank line. The blank line is what separates it from the
    // continuation of a paragraph, which is not code.
    .replace(/(^|\n\s*?\n)((?:(?: {4}|\t)[^\n]*(?:\n|$))+)/g, (_whole, lead: string, block: string) =>
      `${lead}${blankLines(block)}`,
    )
    .replace(/(`+)([^\n]+?)\1/g, (_whole, ticks: string, body: string) =>
      `${ticks}${' '.repeat(body.length)}${ticks}`,
    );
}

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
 * Scan the built site.
 *
 * @returns Every finding, as a printable line, plus the same findings with the
 *   matched text appended. `findings` is the half that may be printed: a route
 *   this build was about to serve, and a rule name from this file's own source.
 *   `detailed` carries the bytes that were actually matched and belongs in the
 *   report, never on a stream — measured, for the home-directory rule the match
 *   is `/home/<user>/`. `scannedCount` is what lets a caller trust that "no
 *   findings" means something was read, and `rowCount` is what lets it trust
 *   that for a corpus that has collapsed into one file — see the vacuity guards.
 */
export function scanResidue(root: string = DIST): {
  findings: string[];
  detailed: string[];
  scannedCount: number;
  rowCount: number;
} {
  const findings: string[] = [];
  const detailed: string[] = [];
  const scannedPaths: string[] = [];
  let rowCount = 0;
  let sawDatabase = false;

  /**
   * Record one finding.
   *
   * Two arrays and one call site per finding, because the split is only safe if
   * it is exhaustive: an earlier version of this change redacted the matched
   * text on the one line that obviously carried it and left `${root}` on the
   * three that also did — the missing-directory line, and both vacuity guards.
   * Under the packaged CLI `root` is the per-run `mkdtemp` workspace, whose
   * random suffix differs between two runs of the same corpus, so those three
   * were a host path on a public surface and a rename differential that could
   * never be byte-equal.
   *
   * @param message The public half: a route this build was about to serve, and
   *   literals of this file's own source.
   * @param detail The same finding with whatever must not be printed — the
   *   scanned root, the bytes that matched. Defaults to `message` when there is
   *   nothing to withhold.
   */
  const report = (message: string, detail: string = message): void => {
    findings.push(message);
    detailed.push(detail);
  };

  let files: string[];
  try {
    files = walk(root);
  } catch (error) {
    // **Vacuity throws; it is not a finding.** A finding is a fact about output
    // that exists — this is the absence of output, and returning it as a
    // finding made "I could not look" arrive in the same channel and the same
    // shape as "I looked and found residue". Every caller that counts findings,
    // tests `length`, or filters by rule name then treats an unbuilt directory
    // as a dirty one, and the one caller that reports success reads
    // `scannedCount` — which was 0, a number no assertion here checks.
    //
    // The other "could not look" cases in this file are deliberately *not*
    // collapsed into this, and the line between them is a rule rather than a
    // list: **a file that shipped and could not be read inside is a finding and
    // names itself; vacuity is the case where there is no artifact at all.**
    // Stated as a rule because a list is what `docs/gate-reading.md`'s corollary
    // about enumerations warns against — and earned it here, since the first
    // draft of this comment counted five such branches as four (it missed the
    // search-index fragment, which has its own inflate because a fragment's
    // bytes are never read into the shared gzip path).
    // The public half names no path. `root` is a host filesystem path and this
    // throw reaches a workflow log on a public repository, which is the
    // disclosure the whole module exists to prevent — `BuildFailure` already
    // carries the split, so the detail goes where the report reads it.
    throw new BuildFailure(
      'residue-scan-vacuous',
      'the built site is missing or unreadable — run `pnpm run build` first. Nothing was ' +
        'scanned, so a clean result would be the zero of having looked nowhere.',
      `${root} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const path of files) {
    const name = basename(path);
    const where = relative(root, path);
    const extension = extname(name).toLowerCase();
    // Anchored at the root of the built site: `pagefind/…` and nothing else.
    // Its fragments are the one member read anyway — see {@link THIRD_PARTY}.
    //
    // **Both conditions, not the extension alone.** A `.pf_fragment` anywhere
    // else is not Pagefind's — it is a file a user put in their notes, or a
    // future build step's — and treating it as one would skip this file's
    // fail-closed classifier for it and then report it under a location that
    // names Pagefind, sending the reader to the wrong place. Anchored, it falls
    // through to the unclassified branch and fails the scan by name, which is
    // property 1 of this file's header.
    const inBundle = where.split(sep)[0] === THIRD_PARTY;
    const isFragment = inBundle && extension === FRAGMENT_EXTENSION;
    if (inBundle && !isFragment) continue;

    // **A fragment's own filename may not be printed.** Measured: Pagefind names
    // each fragment for a digest of the text in it, so two corpora differing
    // only in a note's body produce `en_ad9f487` and `en_4d27cf9`. That makes
    // the name a function of content the stream may not carry — and
    // `tests/disclosure.test.ts`'s rename differential caught exactly that when
    // this scan started reading fragments, which is the gate doing its job.
    //
    // The public half names the *surface* instead. It is a fixed literal, it is
    // the same on every machine, and it loses nothing a reader needs: there is
    // one search index, the fix is always in the note the marker came from, and
    // the exact fragment is in the report's `detailed` half where the person who
    // can act on it reads it.
    const publicWhere = isFragment ? `the search index (${THIRD_PARTY}/)` : where;

    // Read once, and classify on what the bytes are rather than on what the
    // name claims. A fragment keeps its own branch below because its *location*
    // is what identifies it; everything else is decided here.
    const bytes = isFragment ? new Uint8Array() : readFileSync(path);

    // **The inflate is no longer anchored to Pagefind.** It was, and that was
    // safe only for as long as every gzip member in the artifact belonged to a
    // third-party bundle. A build step compressing this site's own content —
    // measured, a gzipped database hides `msw/`, `javascript:` and `C:/` from
    // every raw read, all three visible again after inflating — would otherwise
    // ship behind a layer this scan structurally could not open. Keying on the
    // gzip magic covers the member that exists today and the one a future step
    // adds, which is the corollary about enumerations in `docs/gate-reading.md`.
    const isGzip = bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
    let inflated: Uint8Array | undefined;
    if (isGzip) {
      try {
        inflated = gunzipSync(bytes);
      } catch {
        report(
          `${publicWhere}: is gzipped and could not be inflated, so it shipped unscanned`,
          `${where}: is gzipped and could not be inflated, so it shipped unscanned`,
        );
        continue;
      }
    }
    const payload = inflated ?? bytes;

    // A database is recognised by its header, so `.sqlite3`, `.db` and a file
    // with no extension at all are one case — and so a gzipped one is the same
    // case, since the test runs on the inflated payload.
    const isDatabase =
      !isFragment &&
      payload.length >= SQLITE_MAGIC.length &&
      Buffer.from(payload.subarray(0, SQLITE_MAGIC.length)).toString('latin1') === SQLITE_MAGIC;

    if (!isFragment && !isDatabase) {
      // A gzip member that is not a database is classified on the name it ships
      // under, as before. Its inflated text is what gets scanned.
      if (BINARY_EXTENSIONS.has(extension)) continue;
      if (!TEXT_EXTENSIONS.has(extension) && !TEXT_NAMES.has(name)) {
        report(
          `${where}: is neither declared text nor declared binary, so it shipped unscanned — ` +
            `add its extension to TEXT_EXTENSIONS or BINARY_EXTENSIONS in scripts/scan-residue.ts`,
        );
        continue;
      }
    }

    // A fragment is gzip, and an unreadable one is reported rather than skipped:
    // "I could not inflate it" and "it was clean" must not be the same outcome
    // on the surface this exclusion was just narrowed to cover.
    //
    // Every text this file carries, as separate subjects. One for an ordinary
    // file; for a database, one per stored value plus one for its raw bytes.
    // **Separate rather than concatenated**, so a marker cannot be manufactured
    // by joining two values that neither of them contains — and so the peak
    // memory is one copy of the corpus rather than two.
    let subjects: { text: string; raw: boolean }[];
    if (isFragment) {
      try {
        subjects = [{ text: gunzipSync(readFileSync(path)).toString('utf8'), raw: false }];
      } catch {
        report(
          `${publicWhere}: holds a fragment that could not be inflated, so it shipped unscanned`,
          `${where}: is a search-index fragment that could not be inflated, so it shipped unscanned`,
        );
        continue;
      }
    } else if (isDatabase) {
      // **Rows and bytes both**, for the two opposite reasons {@link databaseText}
      // states: a `SELECT` sees a marker split across an overflow-page boundary
      // that no byte read can match, and the bytes carry a deleted row's payload
      // that no `SELECT` can reach. Measured to cost nothing in false positives.
      let read: ReturnType<typeof databaseText>;
      try {
        read = databaseText(payload, inflated === undefined ? path : undefined);
      } catch {
        // A file wearing the SQLite magic that SQLite will not open is "could
        // not look". Reported, never skipped — measured, both a corrupt file and
        // a truncated one throw here rather than returning empty.
        report(
          `${publicWhere}: is a database that could not be opened, so it shipped unscanned`,
          `${where}: is a database that could not be opened, so it shipped unscanned`,
        );
        // Not counted as a database for the row guard below: this one has
        // already been reported by name, and adding "it holds no rows" to that
        // says the same thing less precisely.
        continue;
      }
      sawDatabase = true;
      for (const table of read.unreadable) {
        // The table's name is a schema literal the build chose, not content, so
        // both halves may carry it — unlike a fragment's digest filename.
        report(
          `${publicWhere}: holds table "${table}", whose text this scan can neither read as rows ` +
            `nor find as bytes, so it shipped unscanned`,
          `${where}: holds table "${table}", whose text this scan can neither read as rows ` +
            `nor find as bytes, so it shipped unscanned`,
        );
      }
      rowCount += read.corpusRows;
      // The raw bytes are one more subject, flagged so a rule that reads
      // authored text can decline it — see {@link RAW_BYTES_EXEMPT}.
      subjects = [
        ...read.values.map((value) => ({ text: value, raw: false })),
        { text: Buffer.from(payload).toString('utf8'), raw: true },
      ];
    } else {
      subjects = [{ text: Buffer.from(payload).toString('utf8'), raw: false }];
    }
    scannedPaths.push(where);

    for (const [pattern, what] of RESIDUE_RULES) {
      // A fragment carries no markup, so the rule that reads code regions has
      // nothing to exempt there and is dropped instead of being applied blind.
      if (isFragment && FRAGMENT_EXEMPT.has(what)) continue;
      // One finding per rule per *file*, not one per form and not one per row:
      // the same marker seen raw and again decoded is one defect, and reporting
      // it twice would make a clean fix look half-done.
      let match: RegExpExecArray | undefined;
      for (const { text, raw } of subjects) {
        if (raw && RAW_BYTES_EXEMPT.has(what)) continue;
        // A database carries Markdown, whose code regions are delimited by
        // fences and backticks rather than by elements — the reasoning at
        // {@link CODE_EXEMPT} carried across a carrier that has no elements in
        // it yet, per {@link withoutMarkdownCode}.
        const subject = !CODE_EXEMPT.has(what)
          ? text
          : isDatabase
            ? withoutMarkdownCode(text)
            : text.includes('<code') || text.includes('<pre')
              ? withoutCodeRegions(text)
              : text;
        // A database stores Markdown source, and the reader receives what a
        // renderer makes of it — so the forms a *reader* can resolve a marker
        // out of include the ones inline markup joins. That is the surface
        // TK-29 closed for the search index; it applies to this carrier for the
        // same reason and is measured to add no false positive. See
        // {@link joinedForms}.
        //
        // **Generated rather than collected**, so at most one derived string is
        // live at a time. Materialising all nine of a database's forms at once
        // held 1.16 GB for a 129 MB file and exhausted a 4 GB heap at 304 MB.
        //
        // **And the raw-byte subject takes none of them**, which is what keeps
        // the peak bounded rather than merely lower: every form is a full copy
        // of its subject — measured, 638 MB for a 142 MB file and 923 MB after
        // one decode pass — and for the whole file that is the largest subject
        // there is. It also buys nothing there. The byte pass exists for one
        // thing, a deleted row's payload sitting in a free page, and those bytes
        // are whatever the row held; an entity-encoded or emphasis-split marker
        // is a property of *text a reader resolves*, which is the row pass's
        // job and which the row pass does on that same text before it is
        // deleted. Derived forms of a B-tree's raw image are forms of something
        // no reader ever parses.
        const forms = raw
          ? [text]
          : isDatabase
            ? databaseForms(subject)
            : normalizedForms(subject);
        for (const form of forms) {
          match = pattern.exec(form) ?? undefined;
          if (match) break;
        }
        if (match) break;
      }
      if (match) {
        // `publicWhere` is a route or a literal and `what` is a literal, but
        // `match[0]` is whatever was found — measured, `/home/<user>/` for the
        // home-directory rule, a real disclosure on a surface a workflow log
        // inherits. One rule leaking is enough to withhold the echo for all nine
        // rather than maintain a per-rule table.
        report(
          `${publicWhere}: contains ${what}`,
          `${where}: contains ${what} (${JSON.stringify(match[0])})`,
        );
      }
    }
  }

  // Three non-vacuity guards, because "zero findings" and "nothing was examined"
  // are the same output. A file count alone is the weakest: a `dist/` holding
  // one stray file satisfies it. Requiring the site's entry point ties the clean
  // result to a build that actually produced a site.
  //
  // **The third exists because a file count stops measuring coverage the moment
  // the corpus stops being files.** One database in place of a thousand pages
  // leaves `scannedCount` at a number that no longer varies with what is
  // published, and an instrument whose reading does not move with its subject
  // has stopped looking — the unifying claim of `docs/gate-reading.md`. So a
  // database that yields no row is a finding: the artifact holding the corpus
  // was opened and gave nothing up, which is "could not look" wearing the shape
  // of a clean result. `rowCount` is returned for the same reason `scannedCount`
  // is — so a caller can refuse a zero — and it is only meaningful where a
  // database was read, which is exactly when this guard applies.
  if (scannedPaths.length === 0) {
    report(
      'no scannable file was found in the built site, so this scan proved nothing',
      `${root}: no scannable file was found, so this scan proved nothing`,
    );
  } else if (!scannedPaths.includes('index.html')) {
    report(
      'the built site has no index.html at its root, so this is not a complete built site',
      `${root}: has no index.html at its root, so this is not a complete built site`,
    );
  }
  if (sawDatabase && rowCount === 0) {
    report(
      'the built site ships a database holding no rows, so scanning it proved nothing',
      `${root}: ships a database holding no rows, so scanning it proved nothing`,
    );
  }

  return { findings, detailed, scannedCount: scannedPaths.length, rowCount };
}

/**
 * Scan a built site and fail loudly if it carries residue.
 *
 * The reporting half of {@link scanResidue}, exported so the packaged CLI does
 * not restate it. Two callers formatting the same findings is two places the
 * wording, the plural, and — the one that matters — the decision that a finding
 * is fatal can drift apart.
 *
 * The message carries no `root`: measured, the packaged build's `root` is a
 * `mkdtemp` workspace whose random suffix differs between two runs of the same
 * corpus, so it is a host path the user never typed. The full detail, matched
 * bytes and scanned root included, is on the thrown error for the report.
 *
 * @throws {BuildFailure} listing every finding, when the scan is not clean.
 */
export function assertNoResidue(root: string = DIST): number {
  const { findings, detailed, scannedCount } = scanResidue(root);
  if (findings.length > 0) {
    const count = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
    throw new BuildFailure(
      'residue-scan-failed',
      `residue scan: ${count}\n${findings.map((finding) => `  - ${finding}`).join('\n')}`,
      `residue scan: ${count} in ${root}\n${detailed.map((finding) => `  - ${finding}`).join('\n')}`,
    );
  }
  return scannedCount;
}

/**
 * This repository scanning its own `dist/`, from `pnpm run build`.
 *
 * The detail is printed here and only here. This path never runs in a user's
 * repository — the packaged CLI imports {@link assertNoResidue} directly — and
 * its `root` is this repository's own `dist/`, on a host whose operator is the
 * person reading the output. A maintainer fixing residue needs the bytes that
 * matched; a stranger's workflow log must not have them, and that caller takes
 * the public half off the same error.
 */
function main(): number {
  try {
    console.log(`residue scan ok: ${assertNoResidue()} files, 0 findings`);
    return 0;
  } catch (error) {
    console.error(error instanceof BuildFailure ? error.detail : error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
