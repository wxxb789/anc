# Media processing and delivery

Status: accepted **target design** for Goals 0009–0013, 2026-11-08.
This is not evidence that those features have shipped. The current
no-local-asset behavior remains until 0009 is implemented and verified.

## Product contract and ownership

ANC is a publisher, not an image-management application. A Markdown author
writes ordinary local image references; the producer resolves permitted assets
and emits static files that the existing GitHub Pages / Cloudflare Pages host
serves. The default requires no account, image CDN SDK, API key, author-side
encoder, configuration flag, Rust installation, or system image CLI.

Order of outcomes:

1. **0009:** authorized referenced PNG/JPEG/GIF/WebP/AVIF bytes are copied
   unchanged and work on the existing *domain-root* static-hosting contract.
   Local SVG is rejected explicitly. Correctness and publication safety first.
2. **0010:** optional figure captions and image layout/accessibility improve
   reading; unrelated to which image encoder is installed.
3. **0011:** automatic WebP-preferred optimization, without changing how an
   author embeds an image or where it is hosted.
4. **0012:** self-contained *static* SVG is accepted as **build-only input** and
   becomes WebP; the original SVG is never served.
5. **0013:** later, an explicitly authorized external storage/publication flow
   may replace the delivery location. Local same-origin output remains default.

These outcomes must not be implemented as parallel image pipelines. A single
producer-owned resolution and publication decision leads to zero or one
published representation of each referenced source asset. The selected bytes
and their content digest own public identity, not the source basename. Only
published notes can authorize an asset; an excluded asset, missing file, path
escape, unsafe symlink or withheld-only reference cannot be made public by an
optimizer. There is no public asset manifest, new SQLite table, secondary note
graph, image runtime script, or on-demand browser conversion.

The image encoder operates on *already authorized* input bytes. It cannot
decide what is publishable. A failed conversion never implicitly falls back
to publishing the unsafe input. Generated assets are inserted into the existing
private staging / exact-output-inventory / residue-and-secret-check pipeline,
and successful output promotion remains atomic. A stable public asset path
cannot be mapped to different bytes by another build. Do not make an ordinary
local build perform uploads or remote image fetches.

## Dependency and execution decisions

### Chosen baseline

**sharp 0.35.5, pinned** (with its prebuilt libvips packages) is the **sole
build-time image decoding, transformation and WebP encoding engine** for 0011
and 0012. It already supports the raster formats ANC needs and SVG input via
librsvg. Keep it in production dependencies of the published CLI, **not** the
site's browser bundle. Inspect its bundled libvips/librsvg version instead of
assuming a system installation. The version floor is deliberate: sharp
versions earlier than 0.35.5 contain the reported librsvg vulnerability
CVE-2026-96889. Pin exact supported package versions in the implementation
lockfile; upgrade deliberately after vulnerability review and package tests.

SVG **policy checking** needs real XML and CSS syntax awareness. Use
**saxes 6.0.0** for namespace-aware, strict XML parsing and **css-tree 3.2.1**
for embedded style sheets and style declarations (including CSS URL tokens).
These are small pure-JS, build-only policy parsers, **not** additional raster
renderers, browser dependencies, or a general SVG DOM/sanitizer framework.
Reject parser-recovered CSS `Raw` nodes and unsupported constructs rather
than assuming the renderer and policy checker interpret them the same way.
The SAX parser does not fetch DTDs or automatically resolve external entities;
ANC rejects DTDs outright, so there is no second entity resolver.

No npm package is added by this design-only change. Goal 0011 introduces
sharp and proves its foreign-repository installation; Goal 0012 introduces
only the policy parsers needed for SVG and reuses the same sharp dependency.
A missing/wrong-platform binary is a clear build failure, not a silent copy
or request that the user install an external CLI. Native optional dependency
selection is tested under npm/pnpm with install scripts denied per repository
policy. Node's pinned runtime remains the CLI owner.

**Rejected as defaults:**

- `cwebp`, ImageMagick, or a system `resvg` executable: introduce external
  installation / PATH / per-platform distribution into the zero-config flow.
- `@resvg/resvg-js` or its WASM sibling: a second engine and font/packaging
  stack for this scope; the stable JS wrapper currently trails the actively
  maintained Rust resvg core. The official resvg CLI uses a default file-capable
  resolver, so it is not a no-policy security shortcut.
- A custom Rust/N-API renderer or independent `resvg` helper: more native
  toolchain, distribution and maintenance surface than sharp-only.
- Squoosh/WASM codec collections or AVIF/WebP/JPEG responsive matrices: more
  code, buffers and formats with no demonstrated gain over a single encoder.
- Astro `astro:assets` as an image identity/publishing authority: ANC builds
  *someone else's* corpus through its own private producer, outside ordinary
  Astro source imports; it must apply the existing exclusion and release gates.

The above is an **architectural selection**, not an unmeasured guarantee of
sharp's performance or complete SVG conformance. If a required safety or
cross-platform control fails, report the failed goal and propose a design
revision; do not silently adopt another engine in implementation.

## 0011 — Automatic WebP-preferred raster policy

Source bytes are identified by validated content and actual supported image
format, never trusted merely because of an extension. No image is automatically
resized, cropped, sharpened, animated, or made into several responsive variants.
Initial encoding policy is deliberately small:

| Validated input | Initial candidate | Acceptance rule |
| --- | --- | --- |
| JPEG (ordinary photo) | Lossy WebP, start near sharp's quality 80 and default effort 4 | Keep WebP only if it is smaller and visual review confirms no material degradation; otherwise retain original JPEG |
| PNG (screenshot, text, diagrams, alpha) | Lossless WebP | Compare actual published bytes with PNG; preserve exact visible detail and alpha, keep PNG if no saving |
| Existing WebP or AVIF | Unchanged | Do not pay for speculative generation loss or re-encode an already effective format |
| Animated GIF / animated WebP | Unchanged | No first-frame-only conversion, lost timing, changed loop count, or unreviewed full-animation encoder cost |
| Any decoded invalid/corrupt or unsupported image | Build failure | Never put unidentified or unsafe bytes into public assets |

The approximately 80-quality JPEG setting and effort 4 are **initial encoder
settings**, not a universal proof of visual quality or an immutable user-facing
contract. Change them from representative CJK screenshot/photo and throughput
evidence, not from arbitrary per-author knobs. The only automatic comparison
in the first optimization pass is **candidate bytes vs original bytes**; do
not run perceptual quality optimization in every production build. Determining
acceptable lossy quality is a qualification/fixture responsibility, whereas
lossless conversion must preserve display semantics by construction. Avoid
using lossless WebP for an image just because it can be decoded as PNG.

When transcoding JPEG, apply its EXIF orientation before removing metadata so
the displayed orientation remains unchanged. Preserve intended color behavior
and alpha; validate the resulting image's actual dimensions, orientation and
format, not only its encoder call status. Sharp normally strips source metadata
from *transcoded* output. **Unchanged original bytes still carry their original
metadata (potentially EXIF/GPS): ANC does not promise automatic metadata
scrubbing for passthrough assets.** A future privacy policy that requires
unconditional stripping is a distinct product trade-off, not a silent
consequence of "WebP preferred".

Hash the **final emitted bytes** for public identity, and deduplicate identical
outputs. A private per-build source-byte cache may avoid repeated transformations
of the same file with identical settings; it is not a second public index or a
durable cache contract. Do not add cross-build caches unless measurements justify
their invalidation/maintenance cost. The output filename's extension must agree
with the actual output bytes and emitted MIME type.

Cost is end-to-end: measure baseline 0009 vs 0011 on the same corpus and include
published bytes, build wall time, peak memory, extra transcodes, npm installed
size, package install success, and CDN transfer implications. Benchmarks require
CJK-small-text screenshots, diagrams, photos, transparency, already-compressed
images and animated formats. Do not claim that WebP is always smaller or always
better. Use sharp's native finite input limits, no `unlimited` opt-out,
bounded concurrency, and explicit time/size/decoded-pixel policies chosen from
measured representative images; fail boundedly on pathological sources. There
is no extra SQLite, WASM, JavaScript or CDN cost in the reader.

## 0012 — SVG as self-contained build-time source

### Renderer, boundary and output

Use **the same pinned sharp 0.35.5**, through its bundled librsvg decoder, to
render a validated SVG **byte buffer**, never a path to the author's SVG. A
file-based base URI must not be supplied to the renderer: librsvg can resolve
local references relative to a base file, while loading from bytes without a
base URL denies such external file resolution. This property is an explicit
security assumption to **test**, not a substitute for checking the SVG.

The producer's publication checks authorize the source file *before* its bytes
are parsed. The security policy then accepts only a **static, self-contained SVG
subset**, renders it, encodes **lossless WebP**, and gives the existing asset
pipeline only WebP bytes and dimensions. Never emit the source XML or an SVG
`data:` URL; the original SVG does not enter `dist/`, Pagefind, SQLite or
a browser. The existing `img-src 'self'` CSP is sufficient.

Default SVG quality is **lossless WebP with transparent background**, not a
lossy photo preset that blurs diagram text and thin lines. Respect source
`viewBox` aspect ratio and explicit logical width/height when valid. For a
`viewBox`-only diagram, derive a stable logical image size within the article
layout, rather than accepting an arbitrary library default. Rasterize at an
effective high-density resolution sufficient for 2× displays, bounded by an
explicit output-pixel budget; downscale proportionally instead of allocating
unbounded surfaces. Do not invent cropping or change the author's viewBox.
Normalize orientation and alpha, verify nonempty visible rendered content and
WebP MIME/dimensions before publication. A valid intentionally empty SVG is a
special case that needs evidence, not a bypass of blank-output detection.

### Static subset and fail-closed resource policy

The SVG input is untrusted XML, even when authored by the repository owner.
The **XML parser** is namespace-aware and must reject declarations and resource
mechanisms that introduce ambiguity or active/external behavior: any DTD,
entities beyond XML's predefined entities, XInclude, processing instructions,
scripts, `foreignObject`, event handlers, animation elements, external
stylesheets/fonts and any unsupported foreign namespace. Allow same-document
fragment references (e.g. `href="#id"`, `url(#gradient)`) needed by
ordinary gradients, clip paths, masks, symbols and filters.

The **CSS parser** must examine both SVG `<style>` contents and `style`
attributes (and URL-bearing presentation attributes) with an AST, accepting
only static styling. Reject CSS `@import`, external `url(...)`, malformed
or unhandled CSS nodes, and unsafe/unknown URL-bearing constructs. Recognize
CSS-escaped URLs as the CSS parser interprets them; searching text for
`javascript:`, `url(`, or `<script>` is not sufficient. XML `href` and
legacy `xlink:href` must have identical checks.

Permitted inline `data:` image payloads, if any, are restricted to validated,
bounded raster types (PNG/JPEG/WebP) with byte and decoded-pixel checks; never
permit recursive embedded SVG, HTML, fonts or unbounded compression. The
simplest acceptable implementation may reject **all** embedded data assets
with a clear diagnostic if their benefit does not justify the security and
memory cost. That bounded scope choice does not affect gradient or mask
fragment references. Reject unsupported SVG features rather than rendering
a misleading partial diagram; no network fetch, local file read, or silently
ignored external reference is permitted.

Keep SVG analysis/rasterization within bounded work and memory, honoring
sharp's finite input-pixel limits and an additional *post-scale SVG output*
pixel budget. A sharp-native decode has a process-crash risk that pure JS
cannot eliminate. Consequently the release qualification must cover the
patched decoder, malicious XML/resource negative controls, encoder failure,
and bounded build behavior; do not describe syntax checking alone as a
complete native-code sandbox. If a reliable resource/hostile-input boundary
cannot be demonstrated, 0012 remains incomplete rather than publishing SVG.

### Fonts, portability, determinism

Do **not** bundle a large CJK font family or require authors to install Rust,
ImageMagick or an SVG executable. Sharp/librsvg uses host font discovery for
SVG text. The supported baseline is therefore:

- Use the existing host's fonts; there is no silent download or forced font
  installation on the user's behalf.
- Test Latin, CJK, symbols and absent-font cases on the actual packaged GitHub
  Actions Linux environment and representative Windows/macOS installations.
  No blank/tofu labels may be counted as a successful render. Missing glyph
  coverage must fail with a useful private diagnostic (or be solved by a
  separately justified, measured minimal font fallback), not silently ship
  a broken technical diagram.
- Exact output identity is required across **repeat builds with the same
  pinned binary/font environment**, not across different operating systems
  with different fonts. Public hash paths bind the actual emitted bytes.
  Never promise byte-for-byte cross-platform equality without pinned fonts
  and demonstrated cross-platform tests.
- SVG paths whose text has been converted to outlines render without font
  discovery. This is not a requirement that every user manually convert text.

The explicit trade-off is that a zero-extra-install renderer cannot guarantee
all possible Unicode glyphs on an arbitrary host without shipping fonts.
If the required packaged Linux CJK test fails, the goal is **not complete**;
the implementer must evaluate the smallest warranted bundled fallback against
measured package size, not declare missing glyphs acceptable. No unresolved
renderer or font-system *choice* is delegated to a coding agent: sharp and
host-font-first with a measured fallback gate are the baseline.

### Boundaries proven by executable evidence

Positive fixtures: common author-exported SVG from diagram tools, paths,
gradients, masks, clip paths, filters, transparency, explicit sizes and
viewBox-only SVG, fine lines, CJK/Latin labels, repeated and shared embeds,
served WebP in the actual packaged site.

Negative fixtures: DTD/entity/XInclude, scripts/events, `foreignObject`,
CSS `@import` and escaped URLs, absolute/relative/`file:`/network
references, recursive embedded SVG, symlink/path escape, broken XML, giant
viewBox, huge output pixels, malicious filter workloads, unsupported dynamic
features and missing glyphs. Prove that neither the contents of a build-host
canary file nor a network probe can enter the output. The previous qualified
site must survive failures. Run these through actual build/packaged paths, not
only through an isolated XML parser.

Measured cost includes installation and dependency payload (on Linux,
Windows, macOS), per-SVG processing, aggregate cold build, peak memory,
source/output bytes, browser transfer, and quality comparisons. Do not add
a second renderer or silently use system executables to make a benchmark pass.

## Change and ablation discipline

The only justified extra public artifact is a **referenced, content-addressed
image**, delivered by the static host; no second read model. Sharp survives
ablation only if representative WebP/transcode output provides actual byte
savings and correct quality without imposing unacceptable package/build cost.
Saxes/CSS parsing survive only if their security controls detect real
external-resource or malformed-input cases not safely enforced at the same
boundary by the renderer alone. Unnecessary image caches, additional encoders,
font packages and generic provider abstractions are rejected by default.

The selected baseline is grounded in official upstream documents:
- sharp formats and prebuilt installation: https://sharp.pixelplumbing.com/install/
- WebP output controls: https://sharp.pixelplumbing.com/api-output/#webp
- sharp security and input bounds: https://sharp.pixelplumbing.com/security/
- patched librsvg advisory (0.35.5): https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w
- librsvg base-URI resource security: https://gnome.pages.gitlab.gnome.org/librsvg/doc/rsvg/
- strict XML parser behavior: https://www.npmjs.com/package/saxes
- CSS parser behavior (including recoverable `Raw` nodes): https://www.npmjs.com/package/css-tree

The current documents select a technical direction; they do **not** claim
completed benchmark evidence, a working SVG security sandbox, tested package
installations, or shipped image support. Those belong to the goal completion
records and real implementation PRs.
