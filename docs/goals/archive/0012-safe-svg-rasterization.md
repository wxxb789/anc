# 0012 — Safe SVG rasterization with WebP output

Status: completed 2026-11-10. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Desired outcome

An author embeds a local, self-contained **static SVG** as an ordinary Markdown
image. ANC turns it into a high-fidelity **WebP** during its existing offline
build. The original SVG and its potentially active XML never become public
assets or browser runtime dependencies. The author does not install a separate
SVG renderer, manage fonts manually for common supported diagrams, or choose
conversion settings.

A complicated SVG that cannot be rendered safely and faithfully must fail
clearly; a silently blank image or leaked host file is worse than a failed
build.

## Prerequisite and accepted design

Requires [0009 — Zero-config static images](0009-zero-config-static-images.md)
and [0011 — WebP-first image delivery](0011-webp-first-image-delivery.md).
The [media core design](../../core-design/media-pipeline.md#0012--svg-as-self-contained-build-time-source)
has **already selected** the renderer and baseline security/format strategy:
the **same pinned sharp 0.35.5** (bundled librsvg) operating on an in-memory,
previously authorized SVG; **saxes 6.0.0** and **css-tree 3.2.1** enforce a
syntax-aware, fail-closed XML/CSS policy. This is not a request to compare
resvg, WASM, ImageMagick or a new Rust toolchain during implementation.

- The static subset accepts ordinary internal gradients, clip paths, masks,
  filters and same-document fragment references, including common diagram
  styles, but **never** external resource fetching, external file resolution,
  active XML, unsafe embedded resources or unsupported dynamic content.
- Render at useful high-density resolution within bounded output-pixel and
  build-resource policies, retain transparency and aspect ratio, and use
  **lossless WebP** for text/line fidelity. Do not publish a PNG intermediate
  or the original SVG merely because conversion failed.
- Reuse publication selection, content-addressed output, ordinary Markdown,
  CSP, exact inventory, private diagnostics and atomic release preservation
  from 0009 and 0011. No new public format, image CDN or client runtime.
- Font policy is **host-font-first without bundled heavyweight CJK fonts**;
  prove useful CJK label rendering on the actual packaged Linux CI host and
  sampled Windows/macOS hosts. Missing glyphs are not success. If evidence
  shows a minimal bundled fallback is essential, justify its measured cost
  against the lightweight product boundary; do not introduce it silently.
  Byte identity is claimed for repeated builds with the same pinned
  engine/font environment, not for different operating systems' fonts.

## Done when

1. A foreign-repository build and actual browser rendering show common
   author-exported SVGs (line art, arrow labels, gradients, masks, clipping,
   filters, transparent backgrounds, explicit sizes and viewBox-only cases,
   Latin and CJK text) as **viewable, correctly referenced WebP** files with
   readable small text, appropriate aspect ratios and no SVG source bytes
   shipped to the site.
2. A real packaged-build hostile corpus rejects DTDs/entities, XInclude,
   scripts/events, foreignObject, CSS imports/escaped URLs, local/file/network
   references, malicious embedded data, invalid XML, unsupported dynamic
   features and excessive pixel/filter workloads. A controlled host-file
   canary and network probe demonstrate that conversion cannot disclose
   another file or initiate network requests. A parser-only test is not enough.
3. Font tests demonstrate the accepted host-font-first policy on actual
   supported execution environments. CJK/symbol text cannot silently turn
   into blank or tofu labels; unavailable glyph coverage either fails
   actionably or is addressed through a documented, measured minimal fallback.
   Do not claim untested platform or cross-font byte identity.
4. Repeat builds under an identified pinned environment yield stable final
   WebP bytes/hashes and duplicate-asset behavior. Unsupported/hostile inputs
   fail before publishing an incomplete site; previous valid output remains
   usable, excluded assets remain excluded, and neither raw SVG nor a
   second image source appears in the exact output inventory.
5. Comparative evidence includes source and published sizes, conversion
   latency, aggregate build time, peak memory, dependency/tarball installation
   cost, quality and SVG-specific negative controls. The packaged result
   serves on the existing GitHub Pages / Cloudflare Pages root-hosting
   contracts with no author-side tools or browser runtime additions, and
   user documentation describes the supported static subset accurately.

Stop for a genuinely unavailable maintainer-only input or an irreversible
departure from the approved design; otherwise make reversible technical
decisions from observed evidence and report all pass/fail controls. This
goal is **ready after its prerequisites are accepted**, not already done.

## Implementation progress (2026-11-10) — completed on Linux x64

Landed as PR #36, merge commit `8b49d38`, branch
`feat/0012-safe-svg-rasterization` off `7d27414`. Implementation commit
`e32c75b`, then seven review-fix commits (`36d3b34`, `485ffd4`, `4e97b67`,
`9d1a226`, `8f16d97`, `bd43b26`, `9e2ce82`, `587c7a0`) closing the 14 findings
of eight Codex review rounds; the final review state is `has_any_findings:false`
and all 14 review threads are resolved.

**Done-when 1 — rendering.** 17 benign fixtures (line art, arrow labels,
gradients, masks, clip paths, filters, transparent backgrounds, explicit sizes,
viewBox-only, physical units, Latin, CJK, small text) rendered in real Chromium
at 1× and 2× from a foreign-repository packaged build; the packaged adoption
smoke publishes 2 notes, withholds 2 and emits 8 images, and no `.svg` byte
reaches `dist/`, Pagefind, SQLite or the inventory.

**Done-when 2 — hostile input.** 39 hostile fixtures, each a real file that
fails the packaged build with its own reason (`svg-xml`, `svg-css`,
`svg-foreign`, `svg-workload`, `svg-font`, …) while the previous `dist/`
stays byte-identical. With the policy deliberately bypassed, a `file://`
canary produced 0 magenta pixels and a listening socket saw 0 requests from
absolute `http://` references in `<image>`, `<use>` and `<style>`. The
`<use>`-expansion budget of 16,384 instances counts use chains, definition
containers once per consumer, template `href` edges, inherited paint once per
painted element, stylesheet rules once per matched element and marker
references once per placement; unparseable path data over-counts instead of
under-counting. Filter regions are judged in their own coordinate system with
a 20,000-unit ceiling.

**Done-when 3 — fonts, and the scope it is claimed for.** Host-font-first, no
bundled font: fontconfig `<dir>`/`<include>`, `<selectfont>` globs and cmaps are
read from the host configuration (4 directories / 106 files on this host,
matching `fc-list`'s 253 faces), `FONTCONFIG_FILE` and a colon-separated
`FONTCONFIG_PATH` resolve through the same search semantics as fontconfig, and
a missing glyph fails actionably as `svg-font` instead of shipping tofu.
**Scope: Linux x64 only.** Windows and macOS were not exercised here — `sharp`
provides prebuilt binaries for them, but untested is not passed and
cross-platform byte identity is not claimed, as
[adoption.md](../../adoption.md) states.

**Done-when 4 — repeatability and preservation.** Budgets: 24M input pixels,
6M output pixels, 8,000-pixel side, proportional clamp; the emitted layout size
is the raster size divided by 2 when the output budget bites (asserted exactly
for `4000×4000 → 1225×1225`). Repeat builds under the pinned engine and font
environment produce stable final WebP hashes; duplicate assets are deduplicated
by emitted-byte SHA-256; a refused input preserves the previous output.

**Done-when 5 — cost and packaging.** 16 benign sources 11,151 B → 318,810 B of
lossless WebP; build cost +1,608 ms and +172,868 KiB peak RSS against
pre-rendered WebP. Final tarball `wxxb789-anc-0.0.2.tgz`, 491,446 bytes,
SHA-256 `90d404d7f49112dd7ee82707a57f8811f939783cfababb5b4dbbd7ac53297b4e`;
final gates 98 test files, 1,214 passed, 35 skipped, plus build,
`pack:tarball` and `smoke:tarball`. `docs/adoption.md` describes the accepted
static subset, the platform scope and the failure behaviour.

**Disclosed limits.** Linux x64 is the measured platform; Windows/macOS font and
byte evidence is absent and not claimed. The accepted subset is narrower than
SVG: no `data:` embedding, no animation, no scripting, no external references,
and CSS selectors using attribute selectors, pseudo-classes, pseudo-elements,
sibling combinators or namespaces are refused rather than interpreted.
