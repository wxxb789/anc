# 0011 — WebP-first image delivery at low cost

Status: ready. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Desired outcome

ANC automatically reduces the storage and transfer cost of published local
images when doing so preserves the author's intended content. A reader receives
WebP when it is worthwhile; an author keeps writing ordinary Markdown without
understanding image codecs or choosing quality settings.

WebP is **preferred, not compulsory**. Pixel-accurate technical screenshots,
transparent graphics, animations and already-compressed files must not lose
meaning or become larger for the sake of consistent file extensions.

## Prerequisite and accepted design

Requires [0009 — Zero-config static images](archive/0009-zero-config-static-images.md).
[0010 — Readable image figures](archive/0010-readable-image-figures.md) is not blocking.
The [media core design](../core-design/media-pipeline.md#0011--automatic-webp-preferred-raster-policy)
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
