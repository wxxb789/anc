# Media processing and delivery

Status: accepted design for Goals 0009–0013, 2026-11-08.
**Goals 0009, 0010 and 0011 are implemented and verified**; their completion records
([0009](../goals/archive/0009-zero-config-static-images.md),
[0010](../goals/archive/0010-readable-image-figures.md) and
[0011](../goals/archive/0011-webp-first-image-delivery.md)) carry the evidence.
0012–0013 have not shipped, and this document is not evidence that they have: the
sections below are the target for those outcomes, and the ones for 0009–0011 describe
the implemented contracts.

## Product contract and ownership

ANC is a publisher, not an image-management application. A Markdown author
writes ordinary local image references; the producer resolves permitted assets
and emits static files that the existing GitHub Pages / Cloudflare Pages host
serves. The default requires no account, image CDN SDK, API key, author-side
encoder, configuration flag, Rust installation, or system image CLI.

Order of outcomes:

1. **0009 — shipped:** authorized referenced PNG/JPEG/GIF/WebP/AVIF bytes are
   copied unchanged and work on the existing *domain-root* static-hosting
   contract. Local SVG is rejected explicitly. Correctness and publication safety
   first. The implemented shape, stated here because the later goals build on it:
   - Resolution is **note-relative, then content-root-relative**, with no basename
     tier; an explicitly relative reference does not fall through to the root.
     Markdown images, reference-style images, and image wikilinks all take it.
     A Markdown destination is percent-decoded **exactly once, after its fragment
     is split off**: a file named `chart#one.png` is written `chart%23one.png`,
     and `chart%2523one.png` names a file literally called `chart%23one.png`. A
     literal `#` still starts a fragment, and an encoded `/` in a segment names
     no file rather than becoming a separator.
   - A reference to a file the walk did not authorize — missing, excluded by a
     configuration glob, outside the content root through `../` or a symlink, an
     SVG, a non-raster, or a raw-HTML `<img>` — **fails the build**. It is never
     dropped from the HTML and never becomes a `/private/` link.
   - Public identity is the SHA-256 of the **emitted bytes**: the path is
     `/_assets/<full-sha256>-<sanitized-source-name>`, identical bytes publish one
     asset, and the name is decoration — the digest is what a consumer may rely
     on. The extension is derived from the detected bytes, because a static host
     infers `Content-Type` from it. The name is percent-encoded in the URL while
     the staged file keeps the raw bytes, so `#`, `&`, `?` and `%` round-trip
     through the artifact, the copy step, and the exact output inventory.
   - Bytes are copied byte-identically: no transcoding, resize, or metadata
     rewrite. (This is Goal 0009's contract; Goal 0011 adds a WebP candidate for
     JPEG and PNG before publication, with the exemptions in its row below.) An animated GIF or WebP keeps every frame. **This phase is not
     metadata sanitization** — a passthrough photo keeps its EXIF/GPS, and a
     later privacy policy that strips it is a separate product decision.
   - The bytes are staged beside the private artifact and emitted after Astro
     empties the output directory; the exact output inventory owns `/_assets/`
     (a declared file must be present and hash to its digest, and an undeclared
     one is an unexpected member), and residue/secret scanning runs over the
     emitted bytes.
   - Nothing else is added: no browser JavaScript, no SQLite table or column, no
     public manifest, no image service, no `publish.config.yaml` key, and no
     system CLI. The hosting shape remains a site at the domain root.
2. **0010 — shipped:** reading-quality changes over the 0009 asset contract.
   An explicit Markdown title on a standalone block image becomes a semantic
   `figure > img + figcaption`; `alt` remains the accessible alternative and is
   never promoted to visible prose; an inline, link-wrapped, or decorative image
   keeps its existing shape and gains no caption. The build reads intrinsic
   pixel dimensions from the already-authorized emitted bytes (PNG `IHDR`,
   JPEG `SOFn`, GIF logical screen descriptor, WebP `VP8`/`VP8L`/`VP8X`, AVIF
   `ispe`) and emits `width`/`height`; a malformed dimension header yields
   neither attribute and does not fail the build. That is a missing layout hint,
   not an incomplete file: an incomplete source container is refused before it
   can publish (see the 0011 completeness gate below). The first image in
   rendered document order is `loading="eager"`; every later image is
   `loading="lazy"`; all get `decoding="async"`. The 0010 change itself added no
   codec or dependency and no browser script or SQLite metadata.
3. **0011 — shipped:** automatic WebP-preferred delivery, without changing how an
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

## 0010 — Readable and accessible image figures (shipped)

The implemented reading rules are deliberately narrow:

- **Caption = authored title.** `![alt](path "Caption")` (and the same title on a
  reference definition) is the human-visible caption of a standalone block
  image. The image keeps its `alt`; the title is not repeated as a tooltip. The
  caption text is escaped by the renderer's text node and passes the same
  sanitizer as body text.
- **No invented prose.** An image with no title never gets a `figcaption`, empty
  or otherwise. `alt=""` stays `alt=""`; no figure numbering exists, so no
  document-local or build-global counter can diverge between builds.
- **Only a standalone block image is promoted.** A paragraph or list item whose
  only meaningful child is the image becomes the figure. An inline image, an image
  wrapped in a link, a table-cell image, an image wikilink with no title, Mermaid,
  math, code, and nested Markdown keep their existing markup.
- **Dimensions are header facts, not decoding.** The producer records the
  intrinsic pixel size while it holds the authorized bytes it is already
  publishing; the artifact carries it as private IR beside the public URL. The
  renderer emits `width`/`height` and the global CSS keeps `max-width: 100%;
  height: auto`, so a portrait, a wide screenshot, and transparent artwork
  reserve their ratio without overflow or distortion. A malformed dimension
  header yields no attributes, never a guess. It does not fail the build on its
  own, but it does not excuse an incomplete container: the completeness gate
  described under 0011 refuses truncated source bytes before publication. So
  does an orientation or transform that would make the stored pixels differ from
  the displayed pixels — a JPEG/WebP/PNG EXIF orientation other than 1, or an
  AVIF `irot`/`imir` — because a transposed pair would reserve the wrong box.
- **Loading follows rendered order.** The first `<img>` that keeps a source is
  `loading="eager"`; every later one is `loading="lazy"`; all are
  `decoding="async"`. No IntersectionObserver, placeholder script, or client-side
  dimension fix-up exists.
- **The sanitizer stays the exit.** `figure`, `figcaption`, and the four img
  attributes are on the explicit allowlist; a raw `figcaption` outside a
  `figure` is renamed to an inert `span` rather than left as an orphan caption.
  `img-src 'self'` is unchanged.

## 0011 — Automatic WebP-preferred raster policy

**Implemented 2026-11-09** by `src/lib/media-codec.ts` and the producer's existing
authorization point in `scripts/markdown-to-artifact.ts`. The table below is the shipped
decision. Settings are quality 80 / effort 4 for JPEG and lossless effort 4 for PNG,
applied after `autoOrient()` and a conversion to sRGB. Finite limits are 32 MiB per source,
50 megapixels per frame, 50 megapixels across an animation, and 20-second decode/encode
deadlines, with no `unlimited` opt-out. The per-build cache is keyed by source digest alone
(encoder settings are fixed module constants), identity is the emitted SHA-256, and the
hostile-input, orientation,
alpha and colour evidence is in the
[0011 completion record](../goals/archive/0011-webp-first-image-delivery.md).

Source bytes are identified by validated content and actual supported image
format, never trusted merely because of an extension. No image is automatically
resized, cropped, sharpened, animated, or made into several responsive variants.
Initial encoding policy is deliberately small:

| Validated input | Initial candidate | Acceptance rule |
| --- | --- | --- |
| JPEG (ordinary photo) | Lossy WebP at quality 80, effort 4 | Keep WebP only if its emitted bytes are smaller and libwebp can represent the dimensions; otherwise retain the original JPEG. Visual acceptability is a fixture-qualification gate, not a per-build comparison |
| 8-bit PNG (screenshot, text, diagrams, alpha) | Lossless WebP, effort 4 | Compare actual published bytes with PNG; keep PNG if there is no saving or libwebp cannot represent the dimensions. Lossless conversion preserves displayed pixels and alpha. Only 8-bit samples with a colour model WebP lossless carries faithfully |
| 16-bit or other-depth PNG | Unchanged | WebP lossless is 8-bit; an encoder candidate would reduce visible values. Publish the PNG bytes exactly |
| Existing WebP or AVIF | Unchanged | Do not pay for speculative generation loss or re-encode an already effective format |
| Animated GIF / animated WebP / animated PNG | Unchanged | No first-frame-only conversion, lost timing, changed loop count, or unreviewed full-animation encoder cost. APNG is detected structurally because sharp does not report its frame count |
| Static GIF | Unchanged | No policy row selects an encoder for it; the file is copied byte-identically |
| Any decoded invalid/corrupt or structurally incomplete image | Build failure | Never put unidentified, truncated, or unsafe bytes into public assets. A header read is not evidence the container is complete |

Before any image reaches a pixel decode or encoder, one structural gate checks the container
the bytes claim to be: PNG chunks are walked with their CRC-32 checks and a
final zero-length `IEND` with no trailing bytes; GIF is walked to its trailer
and its image-descriptor count must match the decoded page count; JPEG markers
must reach `EOI` exactly at the end; WebP's RIFF size must be the whole file and
every chunk must fit; AVIF top-level boxes must consume the file exactly and the
primary item's extent must lie inside the `mdat` or `meta/idat` payload its
construction method names. A failure is the
existing `corrupt` reason, never a fallback to publishing the bytes. This is
required because libvips decodes a truncated PNG prefix and a partial GIF
successfully: decoder success alone is not container completeness. APNG's
frame-extent semantics remain the disclosed limit, but its PNG chunk stream is
still walked.

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

## 0013 — Opt-in Cloudflare R2 image publishing

### First provider and dependency

**The first managed provider is Cloudflare R2**, using its S3-compatible
`HEAD`, `PUT` and `GET` operations. Compatibility with arbitrary S3
providers, OSS, COS, ImageKit and Cloudinary is **not** implied. They require
separate product demand and tests. Existing author-supplied HTTPS images
remain unaffected.

Use **pinned `aws4fetch` 1.0.20**, a lightweight dependency-free AWS SigV4
signer supported by Cloudflare's R2 documentation, with Node's built-in
`fetch` and WebCrypto. This is smaller than adding the AWS SDK v3 client
tree, safer than inventing SigV4, and requires no installed `wrangler`,
`rclone`, remote Worker, new server, or browser package. Load the signer
only in the optional R2 publishing path. The published tarball must include
the signer; quantify its actual installed footprint. No new dependency is
added in this design PR.

The default `anc build`, `anc preview` and `anc build --release`
remain **same-origin, offline and unchanged**, even when R2 credentials are
present. Only a clearly explicit action (proposed CLI:
`anc build --release --media r2`) authorizes remote writes. Extend the
existing `publish.config.yaml` only for that opted-in mode, with
`provider: r2`, bucket, HTTPS account/jurisdiction S3 API endpoint and
HTTPS R2 **public custom-domain base URL**. Choose one narrow validated
shape, not a generic provider framework. Read access-key ID and secret
from named environment variables or CI secrets, never YAML or the published
site. A production custom domain is required: `r2.dev` is development-only,
rate-limited and lacks normal CDN caching. Reject userinfo in URLs,
insecure endpoints and signing-key exposure through redirects.

### Media identity and idempotent uploads

Only an already authorized asset from a published note may be uploaded.
Reuse the local final-byte content hash and actual MIME type. The R2
object key is the same stable relative path 0009 publishes — and the same
`_assets/` namespace the output inventory owns — so an uploaded object and a
local asset are one identity rather than two schemes that must be kept in step.
The key carries the full SHA-256 and the emitted extension; the sanitized source
basename after the digest is URL decoration, never identity. The configured CDN
domain serves that key as its public path. No original source *path*, local
directory, or private report becomes a remote key; the sanitized basename 0009
already publishes after the digest is decoration, not identity. The already accepted image pipeline
determines the *only* published representation; R2 cannot transform bytes.

Issue `PutObject` with `If-None-Match: *`, the correct `Content-Type`,
immutable caching metadata, and verified request payload integrity.
R2 explicitly guarantees this condition is atomic: concurrent publishes
cannot overwrite the same key. A `412` means re-read and verify, not
overwrite. For existing objects, establish actual byte identity against
the expected digest: size, MIME or S3 multipart ETag **alone** is not a
SHA-256 proof; an untrusted metadata claim alone is insufficient. Use
a trustworthy checksum or read/hash the object. For an ambiguous timeout,
retry only conditionally and verify the result; a 404 does not prove a
possibly in-flight prior PUT will never commit. Deduplicate repeated
references. Bound request concurrency, upload retries and object size
by the existing validated-image workload.

### Publication is ordered, not globally transactional

An ordinary release still builds and qualifies a local, same-origin
artifact. For **explicit R2 mode**, complete the private asset selection,
normal publish-set/security gates and immutable candidate site first.
Then make *all* referenced objects available and verify their identity
and actual public custom-domain reachability **before promoting a
remotely linked deployable site**. Never probe an absent CDN object
before upload: Cloudflare may cache negative 404 responses and continue
serving them after a later successful PUT. A private candidate can carry
remote links while still being withheld from the promoted output; the
final HTML and hosted bytes must agree.

If any required upload, identity, public URL, or content-type check fails,
the run fails, retains the last successful local output and does not
present a candidate with broken remote links as ready. Uploads that
precede a later failure may leave harmless immutable orphans. Do not
try to delete them during automatic rollback: earlier deployed pages
could reference those objects. ANC does **not** deploy HTML to GitHub
Pages/Cloudflare Pages and cannot promise an atomic transaction across
the CDN and static host. An R2/CDN outage after successful publishing
is a separate availability risk willingly accepted by opt-in users.
Removing a note/asset does not revoke previously cached copies or
authorize automated remote deletion.

Public HTML uses normal absolute HTTPS `img src` URLs under the existing
`img-src https:` CSP; images need no browser-side R2 SDK, credentials,
JavaScript, SQLite, CORS preflight, or public asset index. The storage API
endpoint is never an image-serving URL; a successful signed `HEAD`
alone does not prove the public CDN hostname is functional.

### Required verification

Demonstrate foreign-repository **packaged** adoption, exactly one
authorized asset set, stable URLs, fresh/repeated publish costs,
content-addressed deduplication, and actual browser image display.
A local protocol fixture/fake is sufficient for repeatable fault
injection (missing/revoked credentials, 403/404, wrong MIME/digest,
concurrent conditional writers, uncertain write outcomes, partial
upload, cached 404, domain misconfiguration and excluded/private
asset leaks). A **live R2 bucket and public custom-domain round trip**
is necessary before claiming production Cloudflare integration
verified; if no authorized credentials are available, do not invent
that evidence. CI secrets are optional for the normal build.

Do not build a new upload manifest, upload daemon, generic S3 adapter,
remote media dashboard, or multi-provider abstraction. The baseline
survives ablation because removing the optional signer/publisher
leaves 0009's zero-config publishing unaffected. Uploading images
is not the default merely because the static host happens to be
Cloudflare Pages.

Provider references:
- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/api/s3/extensions/
- https://developers.cloudflare.com/r2/examples/aws/aws4fetch/
- https://developers.cloudflare.com/r2/buckets/public-buckets/
- https://developers.cloudflare.com/r2/reference/consistency/

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

The current documents select a technical direction for 0011–0013; they do **not**
claim completed benchmark evidence, a working SVG security sandbox, tested
package installations, or shipped support for those three goals. Those belong to
the goal completion records and real implementation PRs. The 0009 and 0010
records are the two already written: they claim byte-passthrough images, figure
and layout reading rules, their negative controls, and their gate evidence, and
nothing in this document is evidence for the goals after them.
