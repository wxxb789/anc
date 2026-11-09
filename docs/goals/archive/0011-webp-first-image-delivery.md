# 0011 — WebP-first image delivery at low cost

Status: completed 2026-11-09. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Desired outcome

ANC automatically reduces the storage and transfer cost of published local
images when doing so preserves the author's intended content. A reader receives
WebP when it is worthwhile; an author keeps writing ordinary Markdown without
understanding image codecs or choosing quality settings.

WebP is **preferred, not compulsory**. Pixel-accurate technical screenshots,
transparent graphics, animations and already-compressed files must not lose
meaning or become larger for the sake of consistent file extensions.

## Prerequisite and accepted design

Requires [0009 — Zero-config static images](0009-zero-config-static-images.md).
[0010 — Readable image figures](0010-readable-image-figures.md) is not blocking.
The [media core design](../../core-design/media-pipeline.md#0011--automatic-webp-preferred-raster-policy)
already selects **pinned sharp 0.35.5** as the one build-time encoder and defines
the initial photo-vs-lossless policy, output identity, source-format exemptions,
packaging and resource boundaries. A coding agent does **not** need to select an
encoder, external CLI, system utility or alternate media architecture.

- Protect legible CJK text, diagram lines, color/alpha, orientation and animation
  before optimizing size. No automatic resize, multi-format derivative matrix,
  image CDN service, browser runtime or extra author configuration.
- Publishing authority, source exclusions, final-byte asset hashes, exact
  inventory, failure preservation and static-host behavior continue from 0009.
  A codec is never a publication authority.
- Keep the npm-installed product usable on the supported platforms with
  platform-provided prebuilt dependencies; no separate installation commands.
  Resource limits are finite and justified by measured normal and hostile cases.
  The accepted policy does not falsely promise to strip metadata from
  untouched passthrough originals.

## Done when

1. The **packaged ANC CLI**, installed into a foreign Markdown repository,
   publishes representative JPEG photographs as smaller, visually acceptable
   WebP where beneficial and publishes eligible PNG technical images as
   **lossless** WebP when smaller. Existing WebP/AVIF and animated sources
   behave under the accepted exemptions; images whose candidate is larger
   or unsuitable keep a correct source representation.
2. The same rendered, browser-visible corpus demonstrates that photos,
   small CJK/UI text, sharp lines, transparent images, color/orientation,
   animation duration/frames and responsive layout retain intended meaning.
   A material visual or behavioral regression is a failed result, regardless
   of impressive byte savings.
3. A reproducible baseline-vs-optimized comparison records **real emitted
   bytes** (not file extensions), per-type savings, incremental build time,
   peak memory with its instrumentation caveats, tarball/installed footprint,
   and npm/pnpm install success on named supported systems. Explicitly name
   any Windows/macOS/Linux platform not exercised; untested is not passed.
   The measured default is defensible for personal notes repositories without
   manual setup or an external encoder.
4. Fresh unchanged builds in the declared pinned runtime produce stable asset
   URLs and bytes; repeated references deduplicate, and changed content
   produces correctly bound new URLs. Corrupt files and over-budget inputs
   fail boundedly and preserve the preceding valid output. Excluded media
   cannot be processed into public output.
5. The same resulting static artifact serves correctly under GitHub Pages /
   Cloudflare Pages root-hosting contracts and existing CSP, without causing
   SQLite/WASM, browser JS, a media-host account, or a second public index
   to be loaded for ordinary image display. Governing core design and adoption
   docs agree with the actual behavior.

Stop and report an indispensable maintainer-only input at the start, and stop
for irreversible/out-of-bounds choices later. Otherwise follow the **already
selected design**, apply reversible evidence-based tuning and finish with
the observed results/failures for each judgment; installing sharp alone is
not completion.

## Implementation progress

Branch `feat/0011-webp-first-image-delivery`, created off `origin/main` at
`f167750` (Goals 0009 and 0010 present). The goal implementation is committed at
`7d2540d` (`feat(media): WebP-preferred delivery with emitted-byte identity`);
the review round recorded below is uncommitted on top of that commit for the
orchestrator to verify and land. Environment: Linux x64, 4 vCPU / 8 GB RAM,
Node 24.16.0 (`.nvmrc` pins 24.18.1; CI runs the pin).

**Encoder.** `src/lib/media-codec.ts` is the only module that imports the encoder.
It pins the policy settings (`quality: 80, effort: 4` lossy; lossless effort 4),
applies `.autoOrient()` before output and converts an embedded profile to sRGB
without attaching one, validates the produced format/size/orientation against the
displayed source frame, and returns either exact publishable bytes or a closed
failure reason. `sharp.cache(false)` and four libvips threads are set once.
`package.json` pins `"sharp": "0.35.5"` exactly; `pnpm-lock.yaml` records the
platform packages (`@img/sharp-linux-x64`, `@img/sharp-libvips-linux-x64`).

**Policy and producer.** `scripts/markdown-to-artifact.ts` keeps the single
authorization point from 0009 and makes it asynchronous. `src/lib/media.ts` gains
`corrupt`, `too-large`, `timeout` and `encode-failed` in the closed failure set;
`scripts/resolve-links.ts` awaits the publisher. The producer holds three caches:
by resolved path, by source digest, and by emitted digest. Encoder settings are
module constants for the build, so the source digest alone identifies a
preparation. `AssetEmission` now carries the emitted bytes, the emitted digest
and the private source digest; staging writes the emitted bytes and re-reads the
source only to prove it did not change mid-build. Public asset identity is
`sha256(emitted bytes)`; the filename extension comes from the emitted format and
the artifact's `width`/`height` come from 0010's reader over the emitted bytes.

**Decision tree.** A reference resolves note-first then content-root; the walk's
verdict is checked **before** any read, so an excluded, escaping, or unlisted file
never reaches memory or the codec. Authorized bytes are sniffed by content, then
`assertCompleteContainer` structurally checks the claimed format before any pixel
decode or encode. GIF, WebP and AVIF are decode-validated and published
byte-identically; a multi-frame PNG (APNG), a 16-bit PNG, and any PNG whose depth
or colour model WebP lossless cannot carry faithfully take the same preservation
path. JPEG and 8-bit PNG are encoded; the candidate is kept only when its emitted
byte length is strictly smaller than the source's, otherwise the source is
decode-validated and retained. A decode, validation, byte-cap, pixel-cap or
deadline failure stops the build, and no branch falls back to publishing bytes
the process could not decode.

**Completeness gate.** `src/lib/media.ts` owns one pre-decode walk, not a
per-format patch in the codec. PNG walks every chunk, checks each CRC-32, and
requires a zero-length `IEND` as the last chunk with no trailing bytes; GIF walks
the block stream to `0x3B`, rejects a trailer with a following non-zero byte,
and requires its image-descriptor count to equal libvips' page count; JPEG walks
marker segments and entropy-coded scan data to `EOI` exactly at the end; WebP
requires the RIFF size to be `bytes.length - 8` and every chunk to fit; AVIF
requires top-level boxes to consume the file and the primary item's `iloc`
extent to lie inside an `mdat` payload. A failure maps to the existing
`corrupt` reason. The gate is called for every source before `readMetadata` and
again for GIF after the header read, which is the only way to compare its
descriptor count with the decoder's page count; it runs before `validateDecode`
or `transcode` for transcode and passthrough alike. A header-only dimension
failure remains the separate fail-open case 0010 defined.

**Emission and gates unchanged in authority.** `scripts/copy-assets.ts` verifies
and copies the staged emitted bytes; `scripts/verify-output-inventory.ts` still
owns exactly the declared `/_assets/` set, and every file must hash to the digest
in its URL and be the format its extension names. `src/lib/schema.ts` keeps the
same artifact shape (`url` plus optional pair). Residue and Gitleaks scanning run
over the new bytes through the existing named-binary rules.

**Bounds.** Finite source bytes 32 MiB, decoded pixels 50 MP per frame, 50 MP
across the animated stack, and 20-second decode/encode deadlines; `unlimited`
is never set and `failOn: 'warning'` is. Encode operations are sequential
(`resolveCorpusLinks` awaits one reference at a time), and libvips is limited to
four threads. Limits are an injectable internal contract for tests; there is no
user configuration key.

**Tests.** `tests/media-codec.test.ts` (17 tests) covers every policy row over
real bytes, lossless pixel/alpha identity, EXIF orientation applied before
metadata removal, ICC-to-sRGB conversion, metadata-free transcode, byte-identical
passthrough (including WebP EXIF, animated GIF/WebP frame counts/delays, and an
APNG shape sharp reports as a single frame), emitted-byte
deduplication across metadata-only sources, determinism, the 16-bit PNG
passthrough with a smaller 8-bit candidate as the non-vacuity control, the
byte/pixel/animation/time limits with a huge-header PNG and a deliberately
timed-out encode, and the structural gate: intact fixtures pass, while GIF at
90/75/50 %, a GIF without its trailer or with a non-zero byte after it, PNG minus
4/12/20 bytes, at half, with a trailing byte after `IEND`, or with a damaged
chunk CRC, JPEG without `EOI`,
WebP with a shortened RIFF size, and AVIF truncated inside `mdat` all fail as
`corrupt` before a decoder can accept the prefix. The 16-bit control is a 16×16
`rgb16` PNG of 117 bytes; the encoder's 8-bit candidate is 38 bytes and reports
`uchar`, and `prepareImage` returns the 117 source bytes unchanged
(`transcoded: false`).
`tests/release-failure-preservation.test.ts` adds a full two-note release build
with a referenced truncated GIF: the second build exits 1, names
`corrupt or undecodable`, and the prior output tree hashes byte-identically.
`tests/media-pipeline.test.ts` gained the emitted-identity, policy-row,
cross-source dedupe, corrupt/oversized refusal and upright-dimension changes;
its animated GIF fixture is now a genuine three-page GIF and both it and
`tests/media-display.test.ts` assert `pages >= 3` rather than only the presence
of a loop-extension string. `tests/media-display.test.ts` now asserts both
encoder rows are served as WebP, the served bytes equal the emitted candidate,
every image decodes under CSP, the
0010 caption/dimension/lead rules still hold, and the served corpus has no
overflow at 320 px. `tests/media-quality.test.ts` builds a browser-visible corpus
with a CJK/Latin UI screenshot, a thin-line diagram, transparent artwork, a
photograph, an EXIF-rotated photograph and both animation forms, decodes source
and served bytes in Chromium canvases, and requires identical alpha/visible pixels
for the lossless rows plus PSNR above the qualification floor for the photograph.
`tests/link-traversal.test.ts`,
`tests/reference-links.test.ts` and `tests/relationship-failure-controls.test.ts`
await the asynchronous traversal. `scripts/smoke-tarball.ts` now builds an 800×600 generated
photograph into the foreign repository and expects six WebP assets and the
unchanged GIF (seven images) through the packaged CLI.

**Measurement.** `scripts/media-corpus.ts` generates a deterministic corpus
under `.tmp` with two photographs, a CJK/UI screenshot, a thin-line diagram,
transparent artwork, an already-compressed WebP and AVIF, and an animated GIF and
WebP. `scripts/measure-media.ts` reads a built `dist/`, re-hashes every asset, detects
emitted formats, and optionally decodes source and candidate to report
displayed-pixel identity or PSNR. It reports **one row per emitted asset**,
attributed to the first source name that matches; a source deduplicated into
another emitted asset has no row and is listed in `sourcesWithoutEmittedRow`.
Only the SHA-256 recomputation is independent of the producer; name parsing,
format sniffing, and attribution reuse product conventions, and encode
operations are not counted. Both scripts are excluded from the published package.

## Measurement

All numbers below come from commands run on this tree on the named host. The
comparison is the branch's parent `f167750` (0009+0010) against this branch, over
the **same generated corpus** and the same build command.

Host: Linux x64, 4 vCPU, 8 GB RAM, Node 24.16.0 (`sharp` reported
`availableParallelism() == 4`). Bundled libraries from `sharp.versions`:
sharp 0.35.5, libvips 8.18.7, libwebp 1.6.0, librsvg 2.63.2 (librsvg is unused
by 0011), lcms 2.19.1. **Windows and macOS were not exercised.** Untested is not
passed. `.nvmrc` pins Node 24.18.1; this host has 24.16.0 and CI runs the pin.

### Corpus

`node scripts/media-corpus.ts .tmp/media-corpus` generated nine sources,
1,242,624 bytes: two JPEG photographs, a CJK/Latin UI screenshot PNG, a thin-line
diagram PNG, transparent artwork PNG, an already-compressed WebP, an
already-compressed AVIF, an animated GIF and an animated WebP. Two notes reference
them; the first photograph is referenced by both, so the run also exercises the
per-build cache. The corpus is a git repository, so the producer's date path runs.

### Commands

```bash
# baseline tree (this branch's parent), implementation:
git archive f167750 | tar -x -C .tmp/baseline
ln -s ../../node_modules .tmp/baseline/node_modules

# each command run twice, serially, with the other tree idle:
/usr/bin/time -v node .tmp/baseline/bin/anc.mjs build \
  --content "$PWD/.tmp/media-corpus" --out "$PWD/.tmp/measure/baseline-dist"
/usr/bin/time -v node bin/anc.mjs build \
  --content "$PWD/.tmp/media-corpus" --out "$PWD/.tmp/measure/optimized-dist"

node scripts/measure-media.ts --corpus .tmp/media-corpus \
  --dist .tmp/measure/optimized-dist --label optimized --quality \
  --json .tmp/measure/optimized.json
```

`/usr/bin/time -v` is the instrumentation. Its `Maximum resident set size` is a
single process's peak as the kernel reports it: `bin/anc.mjs` imports `astro` and
calls `astroBuild` in-process, and imports the Pagefind runner the same way, so
Astro, Pagefind, the producer, and sharp's native allocations all share that
process. It is **not** an aggregate over a process tree, and it includes the
baseline site machinery, which dominates both figures. Wall time is
`Elapsed (wall clock) time`.

### Published bytes, same corpus

| Measure | Baseline (f167750) | 0011 | Delta |
| --- | --- | --- | --- |
| `dist/_assets` files | 9 | 9 | 0 |
| Published image bytes | 1,242,624 | 728,778 | −513,846 (−41.4%) |
| Whole `dist/` bytes | 9,551,724 | 9,037,872 | −513,852 (−5.4%) |
| Transcoded assets (emitted rows) | 0 | 5 | +5 |
| Passthrough assets | 9 | 4 | −5 |
| Wall time, run 1 / run 2 | 3.86 s / 4.57 s | 5.09 s / 5.19 s | +1.23 s / +0.62 s |
| Peak RSS, run 1 / run 2 | 1,240,388 KiB / 1,243,460 KiB | 1,216,808 KiB / 1,236,148 KiB | −23,580 / −7,312 KiB |

The five transforms are six references over five unique sources: the first
photograph is embedded by both notes and is encoded once. The measurement script
reports one row per emitted asset; it does not independently observe encode
operations, and a deduplicated source has no row (`sourcesWithoutEmittedRow`).
Bytes per emitted type,
baseline → 0011: JPEG 680,731 → 0; PNG 189,593 → 0; GIF 354,069 → 354,069;
WebP 15,154 → 371,632 (15,154 passthrough + 356,478 emitted); AVIF 3,077 → 3,077.

**CDN transfer implications (reasoned, not measured).** The reader downloads
each emitted `/_assets/` representation once per page load (subject to the
browser cache); this corpus's measured image total is 728,778 bytes against
1,242,624 source bytes, and the browser receives the representation the `<img>`
names, not both. A CDN changes where those bytes are served and can cache the
content-addressed URLs closer to a reader, reducing origin egress and latency;
it does **not** transcode, choose a candidate, or change the byte count this
encoder produces. The static host still applies its revalidating default to
`/_assets/*` (only `/_astro/*` is marked immutable), so a CDN or host cache
policy can reduce revalidation round trips but is not required for the transfer
saving, which comes from selecting smaller bytes. No CDN account, header key,
or second index is involved.

### Per-source result, with the browser-decoded quality check

`--quality` decodes both source and served candidate in sharp, applies EXIF
orientation, and compares displayed RGBA. For a lossless conversion it compares
alpha exactly and RGB only where alpha > 0 (a fully transparent pixel's colour is
not visible and WebP is not required to preserve it). For a lossy conversion it
reports PSNR over visible RGB. `tests/media-quality.test.ts` repeats the lossless
and PSNR comparisons **in Chromium canvas pixels** over a browser-visible corpus.

| Source | Source bytes | Published bytes | Saving | Quality |
| --- | ---: | ---: | ---: | --- |
| `photo-forest.jpg` | 441,417 | 135,134 WebP | 69.4% | lossy q80, PSNR 36.97 dB |
| `photo-studio.jpg` | 239,314 | 78,724 WebP | 67.1% | lossy q80, PSNR 37.60 dB |
| `cjk-screenshot.png` | 63,308 | 30,208 WebP | 52.3% | lossless; alpha + visible pixels identical |
| `diagram.png` | 24,797 | 11,492 WebP | 53.7% | lossless; alpha + visible pixels identical |
| `transparent.png` | 101,488 | 100,920 WebP | 0.6% | lossless; alpha + visible pixels identical |
| `already-compressed.webp` | 5,222 | 5,222 WebP | 0% | passthrough, byte-identical |
| `animation-webp.webp` | 9,932 | 9,932 WebP | 0% | passthrough; frames/delays/loop unchanged |
| `animation.gif` | 354,069 | 354,069 GIF | 0% | passthrough; frames/delays/loop unchanged |
| `already-compressed-avif.avif` | 3,077 | 3,077 AVIF | 0% | passthrough, byte-identical |

**WebP is not always smaller.** The transparent artwork saved only 601 bytes
(0.6%), and the already-compressed WebP/AVIF and the animation are untouched. A
JPEG whose q80 candidate is larger keeps its source:
`tests/media-codec.test.ts` constructs that case and asserts the retained bytes.
The same test constructs a PNG whose lossless candidate is larger and asserts the
PNG is retained. The policy never re-encodes an already-effective format to make
extensions uniform.

### Determinism

Two unchanged optimized builds (`optimized-dist`, `optimized-dist2`) produced the
same nine asset filenames, and every file was byte-identical (`cmp` over each
`_assets/` member). The measured totals were identical (728,778 image bytes).
`tests/media-pipeline.test.ts` also compares artifact bytes, names and staged
bytes across two producer runs, and the codec test compares two preparations of
each unchanged input.

### Package and install

| Measure | Baseline | 0011 |
| --- | ---: | ---: |
| Packed tarball | 440,908 bytes | 451,190 bytes (+10,282; +2.33%) |
| Compiled TypeScript files in the tarball | 75 | 76 |
| `npm install <tarball>` in a foreign repository | exit 0 | exit 0 (installed sharp 0.35.5 and `@img/sharp-linux-x64` 0.35.5, libvips 1.3.4) |
| Foreign `node_modules` after install | 358,371,642 bytes | 358,408,643 bytes (+37,001) |
| sharp's own installed footprint (pnpm tree) | — | 20,072,677 bytes |

The install delta is small **on this graph** because Astro 7.4.5 already pulls
`sharp` as an optional dependency, so the baseline install contained the same
platform libraries. On a platform where Astro omits it, the direct dependency adds
sharp's ~20.1 MB footprint. `pnpm add sharp@0.35.5 --save-exact` and both `npm
install` runs succeeded with no install script; sharp ships prebuilt platform
packages and needs no system `libvips`, `cwebp`, or other CLI.

### Limit calibration

Before choosing the finite caps, one 24-megapixel JPEG (6000×4000) was decoded
and encoded directly on this host: `stats()` took 742 ms, the q80 WebP encode
1,709 ms, and the process reported 138 MB RSS after both. That is the normal-case
cost the 50-megapixel per-frame cap and 20-second deadline leave ample room for;
the caps remain finite so a pathological header cannot allocate without bound.
The same run establishes that the cost is linear-ish in decoded pixels rather
than in file bytes, which is why the pixel limit and not only the 32 MiB byte
limit is the primary decompression-bomb boundary.

### Bounded hostile input

A copy of the corpus with `diagram.png` truncated to its 8-byte signature was
built into a directory that already held the qualified 161-file output. The build
exited 1 with `1 image reference ... cannot be published (1 corrupt or
undecodable)`, printed no source path, and the 161-file output hashed identically
before and after. `tests/media-codec.test.ts` additionally proves a PNG whose
header declares 50,000×50,000 pixels returns `too-large` (libvips' finite
`limitInputPixels`) within its 5-second assertion bound, every truncated format
returns `corrupt`, a 1 ms injected encode deadline returns `timeout`, and the
32 MiB source-byte and total-animation-pixel caps return `too-large`. The review
round adds direct structural controls: GIF truncated to 90/75/50 %, missing its
trailer, or carrying a non-zero byte after it; PNG minus 4/12/20 bytes, at half,
with a trailing byte after `IEND`, or with a damaged chunk CRC; JPEG without
`EOI`; WebP with a shortened RIFF size; and AVIF truncated inside `mdat` — all
fail as `corrupt`, while the intact fixtures pass. A full two-note release build
whose GIF is replaced by its 50 % prefix exits 1 with `corrupt or undecodable` and
hashes the prior output tree identically; that is
`tests/release-failure-preservation.test.ts`, not a producer module test. The
same failure was reproduced through the shipped CLI on a separate two-note
corpus: the intact build exited 0 and published one `motion.gif`; after replacing
the GIF with its 50 % prefix the build exited 1 with
`1 image reference in published notes cannot be published (1 corrupt or
undecodable)`, and the 152-file output tree was byte-identical before and after.

## Completion record

Completed 2026-11-09 on `feat/0011-webp-first-image-delivery`; implementation
commit `7d2540d` on base `f167750`, with the 2026-11-10 review round uncommitted
for landing. Environment: Linux x64, 4 vCPU / 8 GB, Node 24.16.0 where `.nvmrc` pins
24.18.1; CI runs the pin. Live deployment and post-deploy smoke tests remain
external, separately approved actions and were not performed.

### Commands and results

| Command | Result |
| --- | --- |
| `pnpm run verify` | exit 0 — lint and `astro check` clean, the full build chain (`image assets ok: 0`, `output inventory ok: 150`, `secret scan ok: 150 files, 0 findings`, `residue scan ok: 34 files, 0 findings`), then the suite: 94 files / 1135 passed / 35 skipped |
| `pnpm run build:fixture` | exit 0 — 94 files / 1165 passed / 5 skipped; the fixture build reported 54 pages, `image assets ok: 7 files`, `output inventory ok: 234 files`, `secret scan ok: 234 files, 0 findings`; `fixture build ok: every gate passed against tests/fixtures/valid-corpus.json` |
| `pnpm run pack:tarball` | exit 0 — compiled 76 TypeScript files and rewrote specifiers in 24; wrote `wxxb789-anc-0.0.2.tgz` (451,190 bytes, sha256 `4665c48b87810bae2af4df4196516b362db89e63f57c15ed9ce05995958f25dc`) |
| `pnpm run smoke:tarball` | exit 0 — `tarball adoption smoke ok: 2 published notes, 2 withheld notes, 7 images`, including the packaged `npm install`, `init`, `review`, `build --release`, script-free Chromium checks, and the missing-image failed-build preservation |
| `node scripts/media-corpus.ts .tmp/media-corpus` | 9 sources / 1,242,624 bytes |
| baseline and 0011 builds, each twice, under `/usr/bin/time -v` | see the measurement section above |
| `node scripts/measure-media.ts … --quality`, both trees | see the byte and quality tables above |
| `node scripts/measure-media.ts` on the final review build | exit 0 — 728,778 image bytes, 5 transcoded assets, 4 passthrough assets, `sourcesWithoutEmittedRow: []`; totals unchanged |
| Hostile-input build over a copy of the corpus | exit 1, named `corrupt or undecodable` reason, no path on the stream, previous 161-file output byte-identical |
| Two-note CLI build, GIF then replaced by its 50 % prefix | first exit 0 (one `motion.gif`); second exit 1 with `1 image reference ... (1 corrupt or undecodable)`; 152 output files byte-identical before and after |
| `git diff --check` | exit 0 |

### "Done when" → evidence

**1. The packaged CLI publishes representative photographs as smaller, visually
acceptable WebP and PNG technical images as lossless WebP when smaller, with
exemptions.**
`pnpm run smoke:tarball` installs the tarball into a synthetic foreign git
repository and runs the shipped `init`, `review`, and `build --release`. That
corpus now includes a generated 800×600 JPEG photograph, and the output carries
six WebP assets from the five JPEG/PNG sources plus the generated photograph,
with the animated GIF unchanged; `checkImages` opens the served output in a
JavaScript-disabled Chromium, requires every image to decode, and checks every
response's content type and URL digest. The representative corpus measurement
(above) shows 69.4% and 67.1% savings for the two photographs and 52.3%/53.7% for
the CJK screenshot/diagram, all with browser-level quality evidence; it also
shows the cases retained (already-compressed WebP/AVIF, animation, and a PNG
whose candidate was larger). The codec test constructs the JPEG and PNG
candidates that lose and asserts the source is retained.
*Live deployment to GitHub Pages or Cloudflare Pages was not verified — no host
or deployment credential was used.*

**2. The browser-visible corpus keeps photos, small CJK/UI text, sharp lines,
transparency, colour/orientation, animation and responsive layout meaningful.**
`tests/media-quality.test.ts` builds a Chromium-visible page containing a 900×600
CJK/Latin UI screenshot, a 900×450 thin-line diagram, 600×400 transparent
artwork, a 900×600 photograph, a 300×450 JPEG with EXIF Orientation 6, and
six-frame GIF and WebP animations. Every image decodes at its displayed size
(the oriented photo reports 450×300); source and served bytes are decoded in
browser canvases, and the lossless rows must have identical alpha and identical
visible RGB, while the photograph must exceed the 32 dB PSNR floor. The page has
no horizontal overflow at 320 px. The animation's served bytes are byte-identical
to its source and retain frame count, per-frame delays and loop count. The
measurement report's node-side check independently gives 36.97 dB and 37.60 dB
for the two photographs and exact displayed pixels for the lossless rows.

**3. A reproducible baseline-vs-optimized comparison records real emitted bytes,
per-type savings, incremental build time, peak memory with caveats, package
footprint, and install success on named systems, naming untested platforms.**
The measurement section above carries the twice-run table, commands, corpus
composition, per-source results, `/usr/bin/time` instrumentation caveat, tarball
and installed-size deltas, and `npm`/`pnpm` exit statuses. Linux x64 is the only
platform exercised; **Windows and macOS were not exercised** and are named as
untested. WebP is not claimed always smaller: transparency saved 0.6% and the
already-compressed/animation sources are untouched.

**4. Fresh unchanged builds are stable; repeated references deduplicate; changed
content rebinds; corrupt/over-budget input fails boundedly and preserves output;
excluded media cannot be processed.**
Two optimized builds produced the same nine asset names and byte-identical files
(728,778 image bytes both times); the producer test compares artifact bytes, URLs
and staged bytes across two runs. The same photograph embedded from two notes is
one asset and five encode-eligible references over five sources produced five
transcodes. Changing a source changes the URL and staged bytes
(`tests/media-pipeline.test.ts`). The truncated-image hostile build above failed
with the previous 161-file output unchanged; the codec test's 50,000×50,000 PNG
header, truncated formats, injected 1 ms deadline, 32 MiB cap and animation-pixel
cap all return named failures. Authorization still precedes the read, so an
excluded or escaping file is never opened; the withheld-only and unreferenced
asset tests still pass.

**5. The artifact serves under the existing root-host/CSP contract without new
runtime or index cost; governing docs agree.**
`tests/media-display.test.ts` serves the generated `dist/` through the
`_headers`-applying server with JavaScript disabled, observes every served image
under `img-src 'self'`, and opens it in Chromium with no off-origin request;
`tests/media-quality.test.ts` adds the representative corpus on the same surface.
The packaged smoke applies the foreign build's own generated `_headers`. No
SQLite, WASM, browser script, image host, or second public index is loaded by an
ordinary image page. The core media design now records 0011 as implemented,
0012–0013 as not, and `docs/adoption.md`, `AGENTS.md`, the READMEs and
`CHANGELOG.md` state the policy, the passthrough-metadata limit and the platform
limit.

### Deliberately not done

- 0012 (SVG rasterization) and 0013 (R2/managed hosting). Their goal files are
  unchanged apart from the relative link to this archived record.
- Resize, crop, sharpening, responsive variants, a CDN, browser JavaScript,
  SQLite/WASM image metadata, a public asset index, or a new configuration key.
- Metadata scrubbing for passthrough originals. Transcoded outputs have no source
  EXIF/ICC; an unchanged JPEG/WebP/AVIF/GIF keeps its metadata and the docs say so.
- Windows/macOS installation or rendering evidence; live host deployment; a
  cross-build cache.

### Residual risks

- sharp is native code. Finite limits and deadlines bound this build's input, but
  a decoder vulnerability or a process crash inside libvips remains an external
  dependency risk. The version is pinned so an upgrade is a reviewed change.
- A deadline abandons the promise, not the native work: a timed-out libvips
  operation may finish on its thread after the build has failed. The build exits;
  it does not publish the unfinished result.
- APNG is preserved, but sharp reports no frame count for it, so its decode
  validation covers the frame sharp decodes. The guard exists so animation cannot
  be flattened; full-frame extent validation of an APNG is not claimed. Its PNG
  chunk stream still passes the completeness walk, so a truncated APNG prefix is
  refused even though its frame semantics are not fully checked.
- WebP lossless is an 8-bit format, so 16-bit and other-depth PNGs are published
  unchanged rather than reduced. This is a deliberate coverage limit, not a
  promise that WebP can carry every PNG.
- Lossless conversion preserves displayed pixels, not RGB stored under alpha 0;
  WebP is not required to retain invisible colour. The quality comparison and the
  browser gate therefore compare alpha exactly and RGB where alpha > 0.
- Wide-gamut colour is converted to sRGB, clipping colours outside that gamut by
  design for ordinary web delivery; the ICC conversion is tested against stored
  P3 values, not every possible profile.
- The per-build caches are memory-resident. Each source is bounded, but a corpus
  with a very large total of published image bytes holds those emitted bytes
  until the build ends; no global corpus byte budget is introduced.
- The measurement corpus renders its CJK text with this host's Noto fonts, so the
  visual numbers are host-specific. The product's 8-bit PNG conversion is
  lossless, so the font's presence affects the corpus image, not the conversion.
- A build that previously published a truncated-but-header-valid image now fails
  as `corrupt`. That is the goal's container-completeness and decode-validation
  requirement, not an accidental narrowing; the failure preserves the previous
  output.
