# 0010 — Readable and accessible image figures

Status: completed 2026-11-09. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Desired outcome

Images that already publish correctly through ANC become readable, accessible parts of technical articles: readers understand a figure's caption, images retain their intended aspect ratio while the page loads, and image rendering behaves sensibly across narrow and wide screens. Authors should use familiar Markdown rather than an ANC-specific component or configuration.

This is a reading-quality outcome, not an image encoder, CDN, or visual-effects project.

## Prerequisite and material bounds

Prerequisite: [0009 — Zero-config static images](0009-zero-config-static-images.md) is accepted.

- Preserve the distinct meanings of `alt` (accessible image alternative) and an explicit Markdown title (human-visible caption). Do **not** automatically turn ordinary alt text into a visible caption. Decorative images retain `alt=""`; do not produce empty or duplicated captions.
- The image's intrinsic dimensions, when available from supported raster files, should reserve appropriate layout space without distorting responsive rendering. Image metadata must not become a reason to load image bytes from a remote third-party host during a build.
- Nonessential content images should defer loading and use appropriate decoding hints. The initial/important article image must not be made noticeably slower merely to enforce an unconditional lazy-loading rule.
- Standalone block images can become semantic figures with explicit captions. Inline images, existing Mermaid figures, math, code blocks, links, and nested Markdown must retain their respective meaning. If figure numbering is introduced, it is stable, document-local, and derived from rendered content order rather than build-global counters.
- Retain a restrictive sanitizer and CSP, meaningful keyboard/screen-reader access, static HTML rendering and no new client dependency. Do not duplicate page bodies or image metadata in SQLite, or introduce a second image-index artifact.

## Done when

1. A packaged ANC build of a foreign authored corpus renders a captioned block image using accessible image and figure semantics, while an uncaptioned image remains free of invented prose. Explicit titles and `alt` values stay distinct; decorative and inline-image cases do not acquire false captions.
2. Supported local raster images have verifiably correct intrinsic aspect ratios and layout dimensions, including a portrait, a wide screenshot, and transparent artwork. Real browser observations show that responsive widths do not overflow the article and that article layout does not unnecessarily jump as images arrive.
3. Browser requests and markup demonstrate appropriate lazy/decoding behavior for below-the-fold content without harming the lead image. The page continues to read without JavaScript; CSS/CSP and sanitizer constraints remain intact.
4. Negative controls include a misleading title/alt combination, missing dimension information, a malicious raw HTML image attribute, and an inline image embedded in other prose. Existing Mermaid/code/footnote and image-link semantics do not regress, and the normal verification and package-smoke entry points are exercised against produced artifacts.
5. The documented Markdown author experience works without a new configuration option or provider account.

At the start, stop if an essential input only the maintainer can provide is missing. Otherwise choose reversible details without repeatedly seeking approval; stop for irreversible or out-of-bounds decisions. Report each result with its actual rendered-site evidence and unresolved failures.

## Implementation progress

Branch `feat/0010-readable-image-figures`, created off `origin/main` at
`69f0f85` (Goal 0009's asset pipeline is present). The implementation is
uncommitted by design; the orchestrator verifies and lands it.

**Decision model.** A caption is the **author's explicit Markdown title**, never
`alt` and never invented. A paragraph whose only meaningful child is an `img`
with a non-empty `title` becomes
`<figure class="image-figure"><img …><figcaption>…</figcaption></figure>`, with
the title removed from the image's tooltip attributes. `alt` stays on the image
and keeps its meaning. An untitled image, an inline image in prose, a
link-wrapped image, a table-cell image, and a decorative `alt=""` image are left
in their existing shape; no empty caption, no "Figure N", and no per-build
counter exists.

**Dimensions.** `src/lib/media.ts` reads intrinsic pixels only from the bytes
Goal 0009 already authorized: PNG `IHDR`, JPEG `SOFn` after marker scanning, GIF
logical screen descriptor, WebP `VP8`/`VP8L`/`VP8X`, and AVIF `ispe`. The
producer records the pair as private artifact IR beside the public URL, and the
renderer emits `width`/`height`. A malformed, truncated, or unsupported header
returns `undefined`: the image still publishes, no attributes are emitted, and
the build does not fail or guess. No codec, image library, or new dependency was
added.

**Loading.** The first image that retains a `src` in rendered document order is
`loading="eager"`; every later image is `loading="lazy"`; all get
`decoding="async"`. The rule is applied in the sanitizer's parse-order transform,
so raw-HTML images follow the same rule and no client script participates.

**Files.** Producer: `src/lib/media.ts`, `scripts/markdown-to-artifact.ts`,
`src/lib/schema.ts`. Renderer/layout: `src/lib/markdown.ts`, `src/lib/content.ts`,
`src/pages/notes/[slug].astro`, `src/styles/global.css`. Consumers:
`scripts/copy-assets.ts`, `scripts/verify-output-inventory.ts`. Gates:
`tests/media-pipeline.test.ts`, `tests/media-display.test.ts`,
`tests/rendered-page.test.ts`, `tests/markdown.test.ts`,
`tests/reference-links.test.ts`, `tests/content-contract.test.ts`,
`tests/output-inventory.test.ts`, `scripts/smoke-tarball.ts`. Fixtures:
`tests/support/media.ts`, `tests/fixtures/valid-corpus.json`, and four new
committed fixtures under `tests/fixtures/assets/` — portrait 24×72, wide
screenshot 480×120, transparent artwork 96×96, and an EXIF-oriented JPEG whose
displayed frame is 6×8. `tests/support/media.ts` also embeds genuine WebP-EXIF,
PNG-eXIf and AVIF-`irot`/`imir` fixtures for the header gate. Docs: `docs/core-design/media-pipeline.md`,
`content-semantics.md`, `architecture.md`, `README.md`, `docs/adoption.md`,
`README.md`, `README_zh-cn.md`, `CHANGELOG.md`, `docs/goals/README.md`,
`docs/goals/archive/README.md`, and the 0011 incoming link. No new emitted file
was introduced.

## Completion record

Completed 2026-11-09 on `feat/0010-readable-image-figures` (implementation
uncommitted; base `69f0f85`). Environment: Linux x64, 4 vCPU / 8 GB. The gates
ran with Node 24.16.0 on `PATH`; `.nvmrc` pins 24.18.1 and CI uses that pin, while
the default shell's Node 22.23.2 is below Astro's `>=22.23.4` floor.

### Commands and results

| Command | Result |
| --- | --- |
| `pnpm run verify` | 91 files / 1109 passed / 35 skipped, exit 0 — lint, `astro check` (0 errors, 2 hints), the full build chain with the pinned secret scan (`secret scan ok: 150 files, 0 findings`) and residue scan (`residue scan ok: 34 files, 0 findings`), then the suite |
| `pnpm exec vitest run --maxWorkers=1 tests/media-display.test.ts` | 5 tests passed, exit 0, 6.23 s. Run alone after the first full-suite attempt under four-worker contention; it was also green in both full-suite runs |
| `pnpm run build:fixture` | 91 files / 1139 passed / 5 skipped, exit 0 (`fixture build ok: every gate passed against tests/fixtures/valid-corpus.json`). The same build steps counted directly with `CONTENT_ARTIFACT=tests/fixtures/valid-corpus.json node scripts/build-site.ts --scan-secrets`: `image assets ok: 7 files`, `search index ok: 54 pages indexed`, `output inventory ok: 234 files`, `secret scan ok: 234 files, 0 findings`, `residue scan ok: 109 files, 0 findings` |
| `pnpm run pack:tarball` | compiled 75 TypeScript files and rewrote specifiers in 24; wrote `wxxb789-anc-0.0.2.tgz` (440,908 bytes, sha256 `da651cfb9bbbd75bc5125e5ccc0253d0fdedb54877fa16614ab464a7ea3b1754`), exit 0 |
| `pnpm run smoke:tarball` | exit 0: `tarball adoption smoke ok: 2 published notes, 2 withheld notes, 6 images` — the packaged `init`, `review`, and `build --release` path over a synthetic foreign git repository, including script-free Chromium and the missing-image failed-build control |
| `git diff --check` | exit 0 |

### "Done when" → evidence

**1. A packaged foreign build renders a captioned block image, keeps alt
distinct, and invents no caption for uncaptioned, decorative, or inline cases.**
`pnpm run smoke:tarball` adds a titled portrait and asserts the packaged
artifact contains
`<figure class="image-figure"><img … alt="a narrow portrait gradient" … width="24" height="72" /><figcaption>A packaged portrait caption</figcaption></figure>`;
the untitled wide screenshot and the `alt=""` transparent artwork carry no
caption, and the inline screenshot stays inline. `tests/media-display.test.ts`
reports 11 image references over 10 assets, exactly one `article figure` and one
`figcaption`, the caption text `A portrait figure: the caption, not the alt
text`, and the unchanged alt `A narrow vertical gradient`, with no empty
`figcaption` in the page. `tests/markdown.test.ts` covers title→caption,
alt-only→no figure, `alt=""`→no figure, inline, link-wrapped, tight and loose
list items producing the same figure, and the rewritten image-wikilink shape; `tests/media-pipeline.test.ts` renders the wikilink and
reference-style rewrites and asserts no figure.

**2. Intrinsic aspect ratios and layout dimensions are correct for a portrait, a
wide screenshot, and transparent artwork; widths do not overflow; layout space
is reserved.** The producer test records PNG 8×6, JPEG 8×6, GIF 4×4, animated
WebP 4×4, lossless WebP 12×20, lossy WebP 12×20 and 333×47, and AVIF 8×6 from
the real fixtures. An EXIF-rotated JPEG (Orientation 6) is committed and
browser-observed at a 6×8 displayed size with no attributes; genuine WebP-EXIF,
PNG-eXIf and AVIF-`irot`/`imir` fixtures gate the header reader to `undefined`. The
browser gate observes attribute and natural sizes of 24×72 (portrait), 480×120
(screenshot), 96×96 (transparent), and the other published assets, all equal;
`article.scrollWidth <= article.clientWidth` and
`documentElement.scrollWidth <= clientWidth` at 320 px. Holding every
`/_assets/` request open before measuring the heading after the images, then
releasing and loading them, produced a difference within the 1 px assertion
bound — the reserved space is the loaded space. The same page-level check runs
in `tests/rendered-page.test.ts` against a producer-built fixture page.

**3. Lazy/decoding behavior is right, the lead is not slowed, and the page reads
without JavaScript.** In the JavaScript-disabled Chromium context the first
image is `loading="eager"`, every later image is `loading="lazy"`, all carry
`decoding="async"`, and every image reaches `naturalWidth > 0` after being
scrolled into view under the served `img-src 'self'` CSP. The packaged smoke
makes the same assertions. No browser script, IntersectionObserver, placeholder,
or client-side dimension fix-up exists; the implementation adds no dependency
and no client entry.

**4. The named negative controls and existing semantics hold.**
`tests/markdown.test.ts` includes a title that deliberately disagrees with
`alt` (both survive as authored), a script/quote/angle-bracket-bearing title
(rendered as text, no live element), a hostile raw `<img onerror style>`
(`onerror`/`style` stripped, loading pinned to the page's own rule), and an
inline image in prose. A real truncated PNG publishes with no `width`/`height`
and does not fail; truncated headers for every supported format return no
dimensions. The existing Mermaid, code, footnote, link, and image-link suites
pass unchanged in both full runs. The packaged missing-image control still exits
non-zero without printing the path and leaves the previously built `dist/`
byte-identical.

**5. The documented author experience needs no configuration or account.**
`docs/adoption.md` documents the title-caption syntax, the `alt` distinction, the
decorative form, the inline/link exception, the header-derived dimensions and the
eager/lazy rule; `content-semantics.md` and `media-pipeline.md` state the same
contract; `README.md`, `README_zh-cn.md`, and `CHANGELOG.md` carry the user-facing
summary. No `publish.config.yaml` key, provider account, image CDN, or new
command exists; the smoke drives the same packaged `init`/`review`/`build
--release` path with no extra setup.

### Deliberately not done

- 0011 (sharp/WebP policy), 0012 (SVG rasterization), 0013 (R2 media). No
  optimizer, encoder, transcoder, or `sharp` dependency was added.
- Figure numbering. No counter, document-local or build-global, exists, so no
  caption is invented and no numbering can drift between builds.
- Any browser JavaScript, placeholder, second image index, SQLite column,
  public asset manifest, or new emitted file.
- Live deployment. The artifact and its host-compatible static serving were
  exercised; no host or deployment credential was used.

### Residual limits

- AVIF dimensions are resolved through `meta/pitm` and `meta/iprp/ipma` to the
  `ispe` associated with the primary item. No `pitm`, more than one primary or
  `ipma` row, an unknown `ipma` version or flag, a property index outside
  `ipco`, or no associated `ispe` yields no attributes; an unused property in
  the container cannot supply the pair. Only `ipma` versions 0 and 1 with the
  standard 7-bit/15-bit association widths are supported, and AVIF `clap` is
  not checked.
- JPEG scanning stops at the first start-of-frame and before the entropy-coded
  scan, which is the shape of a decodable JPEG; a nonconforming file yields no
  attributes rather than a decode failure, because this is a header hint.
- Dimensions are not decode validation. A file with a well-formed header but
  corrupt pixel data can still publish its header size; Goal 0009's contract is
  byte passthrough, and 0011 owns real decode validation.
- A `data:` image has no artifact declaration, so it gets no `width`/`height`;
  the same is true of a remote image, which is never fetched. Raw remote images
  retain author-supplied dimension attributes, while the loading/decoding rule
  is still forced by the renderer.
- Orientation fail-open is unit-gated with genuine JPEG, WebP-EXIF, PNG-eXIf and
  AVIF-`irot`/`imir` fixtures; only the JPEG is committed to the fixture corpus and
  browser-observed, so browser geometry for the WebP/PNG/AVIF cases is not
  independently verified. An `irot`/`imir` associated with the primary item
  vetoes the pair; one associated with another item does not.
- Live host deployment and post-deploy smoke tests remain unverified and
  separately approved.
