# 0012 — Safe SVG rasterization with WebP output

Status: ready. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

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

Requires [0009 — Zero-config static images](archive/0009-zero-config-static-images.md)
and [0011 — WebP-first image delivery](0011-webp-first-image-delivery.md).
The [media core design](../core-design/media-pipeline.md#0012--svg-as-self-contained-build-time-source)
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
