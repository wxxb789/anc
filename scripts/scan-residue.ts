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
 * 1. **It fails closed on novelty.** Every file is classified as text or
 *    binary by an explicit list. A file matching neither fails the scan by
 *    name, so a build step that starts emitting a new kind of file cannot have
 *    it silently pass unscanned.
 * 2. **It refuses to pass vacuously.** An empty or missing `dist/`, or a
 *    `dist/` with no scannable text in it, is a failure rather than zero
 *    findings.
 * 3. **It reports every finding**, not the first, so one run names the whole
 *    problem.
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
 * `.pf_index` and `.pf_meta` hold Pagefind's word list, built from the same
 * extracted text a fragment stores verbatim, so any marker reaching them has
 * already passed through a fragment this scan now reads. That argument is what
 * makes the exclusion safe, and it survives a new rule being added to
 * {@link RESIDUE_RULES} — which is the property the earlier reasoning here
 * lacked.
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
 *   findings" means something was read.
 */
export function scanResidue(root: string = DIST): {
  findings: string[];
  detailed: string[];
  scannedCount: number;
} {
  const findings: string[] = [];
  const detailed: string[] = [];
  const scannedPaths: string[] = [];

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
  } catch {
    report(
      'the built site is missing or unreadable — run `pnpm run build` first',
      `${root} is missing or unreadable — run \`pnpm run build\` first`,
    );
    return { findings, detailed, scannedCount: 0 };
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

    if (!isFragment) {
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
    let text: string;
    if (isFragment) {
      try {
        text = gunzipSync(readFileSync(path)).toString('utf8');
      } catch {
        report(
          `${publicWhere}: holds a fragment that could not be inflated, so it shipped unscanned`,
          `${where}: is a search-index fragment that could not be inflated, so it shipped unscanned`,
        );
        continue;
      }
    } else {
      text = readFileSync(path, 'utf8');
    }
    scannedPaths.push(where);
    // Computed once per file rather than per rule, and only when a file could
    // hold a code region at all.
    const outsideCode = text.includes('<code') || text.includes('<pre')
      ? withoutCodeRegions(text)
      : text;
    for (const [pattern, what] of RESIDUE_RULES) {
      // A fragment carries no markup, so the rule that reads code regions has
      // nothing to exempt there and is dropped instead of being applied blind.
      if (isFragment && FRAGMENT_EXEMPT.has(what)) continue;
      // One finding per rule per file, not one per form: the same marker seen
      // raw and again decoded is one defect, and reporting it twice would make
      // a clean fix look half-done.
      const subject = CODE_EXEMPT.has(what) ? outsideCode : text;
      const match = normalizedForms(subject)
        .map((form) => pattern.exec(form))
        .find((found) => found !== null);
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

  // Two non-vacuity guards, because "zero findings" and "nothing was examined"
  // are the same output. A count alone is the weaker of the two: a `dist/`
  // holding one stray file satisfies it. Requiring the site's entry point ties
  // the clean result to a build that actually produced a site.
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

  return { findings, detailed, scannedCount: scannedPaths.length };
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
