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
import { fileURLToPath } from 'node:url';
import { basename, extname, join, relative, sep } from 'node:path';

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
 * Pagefind's own bundle, excluded with a reason rather than by convenience.
 *
 * Two kinds of file live under it. Its runtime — `pagefind*.js`, `.css`, and
 * two WebAssembly binaries — is third-party code this repository does not
 * author; it legitimately contains `javascript:void(0)` in its form markup, and
 * the compiled WebAssembly contains `[[` as a byte coincidence. Its index
 * (`.pf_fragment`, `.pf_index`, `.pf_meta`) is compressed, so a text scan of it
 * reads noise: matching or not matching says nothing either way.
 *
 * That the index is excluded is safe for a specific reason, not a hope.
 * Pagefind indexes exactly the `data-pagefind-body` subtree of the built HTML,
 * and that HTML is scanned here in full. There is no path by which residue
 * reaches the index without first appearing in a page this scan reads. The
 * parity plan section 7.3 separately rejected decompressing a `.pf_fragment` in
 * a test, so this does not reopen that decision.
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
 * @returns Every finding, as a printable line. Empty means the artifact is
 *   clean — which the caller may only trust because `scannedCount` proves
 *   something was read.
 */
export function scanResidue(root: string = DIST): { findings: string[]; scannedCount: number } {
  const findings: string[] = [];
  const scannedPaths: string[] = [];

  let files: string[];
  try {
    files = walk(root);
  } catch {
    return { findings: [`${root} is missing or unreadable — run \`pnpm run build\` first`], scannedCount: 0 };
  }

  for (const path of files) {
    const name = basename(path);
    const where = relative(root, path);
    // Anchored at the root of the built site: `pagefind/…` and nothing else.
    if (where.split(sep)[0] === THIRD_PARTY) continue;

    const extension = extname(name).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) continue;
    if (!TEXT_EXTENSIONS.has(extension) && !TEXT_NAMES.has(name)) {
      findings.push(
        `${where}: is neither declared text nor declared binary, so it shipped unscanned — ` +
          `add its extension to TEXT_EXTENSIONS or BINARY_EXTENSIONS in scripts/scan-residue.ts`,
      );
      continue;
    }

    const text = readFileSync(path, 'utf8');
    scannedPaths.push(where);
    for (const [pattern, what] of RESIDUE_RULES) {
      // One finding per rule per file, not one per form: the same marker seen
      // raw and again decoded is one defect, and reporting it twice would make
      // a clean fix look half-done.
      const match = normalizedForms(text)
        .map((form) => pattern.exec(form))
        .find((found) => found !== null);
      if (match) findings.push(`${where}: contains ${what} (${JSON.stringify(match[0])})`);
    }
  }

  // Two non-vacuity guards, because "zero findings" and "nothing was examined"
  // are the same output. A count alone is the weaker of the two: a `dist/`
  // holding one stray file satisfies it. Requiring the site's entry point ties
  // the clean result to a build that actually produced a site.
  if (scannedPaths.length === 0) {
    findings.push(`${root}: no scannable file was found, so this scan proved nothing`);
  } else if (!scannedPaths.includes('index.html')) {
    findings.push(`${root}: has no index.html at its root, so this is not a complete built site`);
  }

  return { findings, scannedCount: scannedPaths.length };
}

function main(): number {
  const { findings, scannedCount } = scanResidue();
  if (findings.length > 0) {
    console.error(`residue scan: ${findings.length} finding${findings.length === 1 ? '' : 's'} in dist/`);
    for (const finding of findings) console.error(`  - ${finding}`);
    return 1;
  }
  console.log(`residue scan ok: ${scannedCount} files, 0 findings`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
