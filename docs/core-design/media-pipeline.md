# Media processing and delivery

Status: accepted design for Goals 0009–0013, 2026-11-08.
**Goals 0009, 0010, 0011 and 0012 are implemented and verified**; their completion
records ([0009](../goals/archive/0009-zero-config-static-images.md),
[0010](../goals/archive/0010-readable-image-figures.md) and
[0011](../goals/archive/0011-webp-first-image-delivery.md)) carry the evidence, and
[0012](../goals/0012-safe-svg-rasterization.md) reports its own. 0013 has not shipped,
and this document is not evidence that it has: the section below is the target for that
outcome, and the ones for 0009–0012 describe the implemented contracts.

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
4. **0012 — shipped:** self-contained *static* SVG is accepted as **build-only
   input** and becomes lossless WebP; the original SVG is never served. The
   subset, refusals, budgets and font gate are in the 0012 section below.
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

**Implemented.** The renderer is the same pinned **sharp 0.35.5** through its
bundled librsvg decoder, and it receives a **byte buffer**, never a path to the
author's SVG. No base URI is supplied: librsvg has nothing against which to
resolve a relative reference. That is an assumption tested on its own, not a
substitute for the policy — `tests/svg-security.test.ts` renders a document that
**bypasses** the policy and proves a host-canary file is not read and a listening
socket receives no request.

The producer's publication checks authorize the source file *before* its bytes
are parsed. `src/lib/svg-policy.ts` then applies the static-subset policy,
`src/lib/svg-render.ts` rasterizes the accepted bytes and encodes **lossless
WebP**, and the existing asset pipeline receives only those WebP bytes plus the
layout size. The source XML never enters `dist/`, Pagefind, SQLite, the asset
inventory, or a browser; the existing `img-src 'self'` CSP is sufficient.

The published picture is rasterized at **2× its logical size**. The logical size
is the author's absolute `width`/`height` when written (physical units converted
at CSS's 96 dpi), otherwise a stable **720 CSS px** at the wide end of the
article reading column — the stylesheet's `max-width: 100%` caps it on a narrower
column, so the rendering never overflows. When only one side is declared and a
`viewBox` is present, the viewBox supplies the other side; that inferred pair is
then treated as declared so the raster keeps the author's aspect ratio instead of
falling back to the article measure. The render target is clamped
proportionally by a **6,000,000-pixel output budget** and an 8,000-pixel side
limit; nothing is cropped and the `viewBox` is never rewritten. The artifact's
`width`/`height` are **half the emitted raster**. Without clamping that is the
logical layout size, so a 600-pixel diagram publishes a 1,200-pixel WebP and still
lays out at 600 CSS pixels. When the budget clamps, the layout shrinks with the
raster: a 4000×4000 SVG publishes 2449×2449 and lays out at 1225×1225. The
emitted header is the 2× pair; both are read from the emitted bytes by 0010's
reader.

The emitted bytes are verified before publication: WebP MIME, exactly the target
dimensions, one frame, no rotation, the logical target's aspect ratio, and at
least one visible pixel. A fully transparent render is refused (`svg-empty`); an
intentionally empty SVG is therefore a build failure rather than a published
blank, and the refusal is the documented outcome rather than a bypass.

**Measured density semantics that the renderer relies on.** Reading the
document's natural size at 72 dpi and scaling by density is not linear for every
unit: with this pinned binary, `100px` renders 100 then 200 pixels at 72/144,
while `100mm` renders 283 then 1,134. The policy therefore reports the unit class
(`linear` or `physical`) and the renderer computes the density for each;
`src/lib/svg-policy.ts` records the measurement. Mixed physical and px/unitless
`width`/`height` is refused, because no density gives that document its written
aspect ratio.

Default SVG quality is **lossless WebP with transparent background**, not a
lossy photo preset that blurs diagram text and thin lines. Orientation is not
applicable to SVG; `ensureAlpha` then lossless encoding preserves transparency,
and libwebp omits the alpha channel entirely for a fully opaque picture, which
the visibility check accounts for. The verification and budget rules above are
the shipped implementation.

### Static subset and fail-closed resource policy

The SVG input is untrusted XML, even when authored by the repository owner.
`src/lib/svg-policy.ts` parses it with namespace-aware **saxes 6.0.0**. The
producer's byte signature looks for an optional-prefix `<svg>` root anywhere in
the first 1024 bytes, so an XML declaration, a comment, a DOCTYPE, or a bounded
sequence of processing instructions in the prologue reaches this policy and is
refused for its actual reason rather than being misreported as a plain text file;
a UTF-16 document does not match the byte signature and is unsupported. Every
refusal is a stable reason the public summary counts and the private report
names:

- `svg-doctype` — any DOCTYPE, entity declaration, or reference to an entity
  beyond XML's predefined five.
- `svg-xinclude` — an element in the XInclude namespace.
- `svg-script` — a `script` element, any `on*` event-handler attribute, or a
  `javascript:`/`vbscript:` URL.
- `svg-foreign` — `foreignObject`, or an element/attribute in a namespace this
  subset does not support.
- `svg-unsafe` — an element or attribute outside the allowlist, `<metadata>`,
  or a processing instruction other than an external stylesheet.
- `svg-animation` — `animate*`, `set`, `discard`.
- `svg-external` — any reference that is not a same-document fragment, including
  `file:`, `http(s):`, a relative path, an external stylesheet, `xml:base`,
  and every `<image>`/`<feImage>` element.
- `svg-data` — any embedded `data:` payload.
- `svg-css` — malformed CSS, a nested `<style>` element, or an at-rule
  (`@import`, `@font-face`, `@media`, …).
- `svg-invalid` — not well-formed UTF-8 XML, no `<svg>` root, no usable size, a
  mixed-unit width/height pair, or a budget argument that does not parse (a
  filter-region value or `numOctaves`).
- `svg-workload` — beyond the finite work budgets below.
- `svg-font` — text no installed font covers, including text in an unused
  `defs`/`symbol` subtree.
- `svg-render` — the rasterizer failed on a policy-accepted document.
- `svg-empty` — a render with no visible pixel.

**Elements and attributes are allowlists**, not denylists: shapes, groups,
`defs`/`symbol`/`use`/`view`, gradients, patterns, clip paths, masks, markers,
static filter primitives, `text`/`tspan`/`textPath`/`a`, `title`/`desc`,
`style`, and the presentation attributes those need. Lighting is limited to
`fePointLight` and `feSpotLight`; `feDistantLight` is not part of the subset. A foreign namespace — an
Inkscape `sodipodi`:element, an RDF metadata block, an XHTML `<link>` — is
refused rather than partially rendered. `<metadata>` is refused because it is not
drawn and walking arbitrary foreign XML to prove that is unnecessary surface.
Same-document fragments (`href="#id"`, `xlink:href="#id"`, `url(#grad)`) are the
only references accepted, and **one function** checks `href` and legacy
`xlink:href`, so they cannot drift. Inert accessibility and data attributes
(`role`, `aria-*`, `data-*`, `lang`, `tabindex`) and the legacy `xlink:title` /
`xlink:role` are allowed; none names a resource.

**Every embedded `data:` payload is refused** with its own diagnostic. The
design's optional bounded raster-embedding path was not built: the subset's
benefit did not justify the decode and recursion surface. Gradient, mask, clip,
symbol and filter fragment references are unaffected.

**The CSS parser is an AST** (`css-tree 3.2.1`), over `<style>` contents, `style`
attribute declarations, and every URL-bearing presentation attribute (`fill`,
`stroke`, `filter`, `clip-path`, `mask`, `marker-*`). It rejects every at-rule,
every `Raw` node css-tree could not parse, unknown functions (including `var()`,
whose fallback argument is a `Raw` node), and every `url()` that is not a
same-document fragment. `tests/svg-raster.test.ts` proves the check reads the
**decoded** value: `url("\6a avascript:alert(1)")` and
`url(http\3a //example.invalid/x)` contain neither literal the gate must not rely
on, yet are refused as a script URL and an external URL respectively.

**Work is bounded before a surface is allocated.** The policy caps 20,000
elements, 128 nesting levels, 500 `<use>` elements, **16,384 instances after
`<use>` expansion**, 100,000 UTF-16 code units of text in any `<text>` subtree
(referenced or not), 4,096 distinct text characters, 1,000,000 characters of CSS
across `<style>` elements and `style` attributes, 100 filter primitives,
`stdDeviation` 1,000 user units, filter regions at 500% / 20,000 user units,
convolution kernels at 100 entries, and turbulence octaves at 16. The `<use>`
count is a dynamic-programming count over the id graph, not the number of
`<use>` declarations: 17 chained symbols and 33 declarations are about 1 KB of
XML but expand to 131,071 instances. The 16,384 cap admits the largest practical
chained symbol table (measured at 177 ms for 16,383 instances on the qualification
host) and refuses that document before the renderer; the same shape measured
581 ms at 65,535 instances and 1,146 ms at 131,071 instances before the cap
(reviewer measurement 2.4 s at 2^17). A cyclic `<use>` graph is refused as
non-terminating. A source SVG larger than 8 MiB is refused before the policy
parses it. The renderer then measures the document's natural size at 72 dpi with
sharp's `limitInputPixels` at 24,000,000, so a declared million-pixel square is
refused by libvips before allocation, and the post-scale output budget is
6,000,000 pixels. `unlimited` is never set.

The policy is not a native sandbox. A sharp-native decode has a process-crash
risk pure JS cannot eliminate; the release qualification covers the patched
decoder, hostile XML/resource controls, encoder failure and bounded behavior,
and this document does not claim otherwise.

### Fonts, portability, determinism

**Host fonts only; no font is bundled.** Sharp/librsvg discovers fonts through
the host, and there is no download, forced installation, or package weight added
for CJK.

The gate cannot be an ink test. Measured on the Linux qualification host, Pango
draws a **hex box containing the code point** when no font covers a character:
U+10FFF0 renders a box reading `10FFF0`, U+E000 a box reading `E000`, and `口`
renders its own glyph — all three have ink, and the boxes differ from each other,
so neither a blank check nor a single control bitmap detects tofu.

`src/lib/font-coverage.ts` therefore answers the question Pango asks fontconfig:
**is the code point in the `cmap` of any font fontconfig would offer?** It
discovers font containers from `/etc/fonts/fonts.conf` and `conf.d/*.conf` on
Linux and from the standard system/user directories on macOS and Windows. The
fontconfig files are parsed as XML; `<dir>` entries and their `prefix` attribute
are honoured (an XDG `<dir>` resolves against `XDG_DATA_HOME`, while an XDG
`<include>` resolves against `XDG_CONFIG_HOME`), and `<include>` is followed
relative to the including file or by its `prefix`. An include that names a
directory is followed as fontconfig does, through its `[0-9]*.conf` entries. The
hard include depth cap is 8; missing, unresolvable, repeated, too-deep and
malformed includes are counted as skipped, and followed files and directories are
counted separately by the measurement instrument. System and user font
directories come from the config; the module does not add `~/.fonts` or
`~/.local/share/fonts` unconditionally, because that would credit a directory
fontconfig does not use when `XDG_DATA_HOME` points elsewhere.

`<selectfont>` selection is applied, not merely its `<dir>` list. Filename
selectors run first, as fontconfig does: `<glob>` rules match the **complete
path** (home and relative spellings are expanded), an accept glob protects a
directory or file from a reject glob, and a rejected directory is not searched.
Family-pattern selectors run after filename acceptance; their accept set is
checked before their reject set, so a family accept protects a font from a family
reject. `<pattern>` rules are matched against family names read from the font's
`name` table (IDs 1 and 16). The gate maps the `family` predicate; other pattern
predicates are outside this bounded matcher, and the module only reads scalable
containers (`.ttf`, `.otf`, `.ttc`, `.otc`), so a bitmap-format reject predicate
cannot select one of its files. `tests/font-config.test.ts` compares the result on
a temporary HOME/XDG tree against fontconfig's own matching behavior, including
include directories, reject/accept precedence, an absolute file glob and a family
reject. Measured with fontconfig 2.15, `fc-list` does not apply a `<selectfont>`
filename reject (it lists the configured directory), while `fc-match` does; the
gate follows the latter.

It reads only each file's `cmap` table (formats 0, 4, 6 and 12, including `.ttc`
collections) and accepts only Unicode records (platform 0, and platform 3
encodings 1 and 10; symbol and other encodings are ignored). The scan is one pass
over the files per process and stops when every code point is resolved; results
are cached for the build. A reject rule that removes a file also removes its
cmap from this scan. Whitespace, combining marks and Unicode format characters are excluded because they are not standalone
glyphs. A missing code point fails with `svg-font` and a diagnostic naming it and
the number of font files searched. If no font files are found at all, every code
point is missing and the build fails rather than publishing an unverified
picture.

The check is per code point, not per requested family: Pango falls back through
the host's font set per character — measured, CJK text under
`font-family="DejaVu Sans"` renders identically to the default stack — so
"can *any* host font draw this?" is the question that decides a reader's outcome.
The consequence is that a host without a CJK font refuses a CJK diagram with an
actionable message; it does not silently publish tofu.

Exact output identity is required across **repeat builds with the same pinned
binary/font environment**, not across different operating systems with different
fonts. Public hash paths bind the actual emitted bytes. Cross-platform byte
equality is not promised and has not been tested. SVG paths whose text has been
converted to outlines render without font discovery; that remains the escape
hatch for an author whose host cannot supply a glyph.

### Boundaries proven by executable evidence

The committed corpus is `tests/fixtures/svg/benign/` and
`tests/fixtures/svg/hostile/`. Each hostile file is a real document on disk, and
each benign file is rendered and measured.

Positive fixtures: line art and markers, arrow labels, linear/radial gradients
and a pattern, masks, clip paths, static filters, transparency, explicit sizes,
a `viewBox`-only document, physical `mm` units, Latin text, CJK text, 9–11 px
text, a `<style>` sheet with class selectors, `symbol`/`use`, and one document
referenced from more than one note. `tests/svg-raster.test.ts` checks the emitted
bytes, format, 2× pixel size, logical layout size, aspect ratio and
duplicate/rebind behavior; it also renders a one-sided `width` plus `viewBox` at
the inferred aspect and proves the `<use>` expansion budget refuses a 33-declaration
chain before rendering. `tests/svg-display.test.ts` decodes the corpus in Chromium
at 1×/2× and measures a real screenshot for strong edge transitions.

Negative fixtures, each failing the build with the reason named above:
DTD and an entity declaration, XInclude, `script`, `foreignObject`, `onload`,
`animate`/`set`, an external `xml-stylesheet`, `@import`, `@font-face`, a nested
`<style>` element, an external `url()` in a `<style>` sheet, a `style` attribute
and a presentation attribute, a CSS-escaped script URL, a `file:` reference, an
`http(s)` reference through both `href` and `xlink:href`, an embedded `data:`
asset in XML and in CSS, malformed XML, Inkscape/XHTML foreign namespaces, a
million-pixel square, a filter-primitive flood, an oversized filter region, a huge
`stdDeviation`, a fully transparent render and a structurally empty root, missing
glyph coverage, `<metadata>`, a namespace-less root, and `xml:base`.

`tests/svg-security.test.ts` adds the two controls the XML policy cannot supply
for itself: a canary PNG outside the content root is not read — by the build and
by a direct rasterizer call that **bypasses** the policy — and a local listening
socket receives no request from either path. It also hashes a previously built
`dist/`, rebuilds with a hostile document, and requires the failed build to leave
every file byte-identical. `tests/svg-security.test.ts` and
`tests/svg-raster.test.ts` assert that the source `.svg` name appears in no
`dist/` path, asset inventory entry, Pagefind index or SQLite file.

Measured cost — per-SVG latency, aggregate cold build time, peak RSS, source and
published bytes, dependency and tarball delta, and browser transfer — is reported
with this goal's implementation evidence rather than claimed here. No second
renderer and no system executable participates.

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
