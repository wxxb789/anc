# 0011 — WebP-first image delivery at low cost

Status: ready. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Desired outcome

ANC publishes local images with materially lower storage and transfer costs where worthwhile, preferring WebP while protecting readability, transparency and animation. Authors continue writing ordinary Markdown; they do not choose encoders, quality levels, output formats, or platform-specific tools to get useful defaults.

**WebP preferred is a cost/quality policy, not a mandate to convert every image.** If conversion enlarges an image, loses meaningful quality, or breaks its behavior, keeping the source format is a successful outcome.

## Prerequisite and material bounds

Prerequisite: [0009 — Zero-config static images](0009-zero-config-static-images.md) is accepted. [0010](0010-readable-image-figures.md) improves presentation but is not a blocking dependency.

- Prioritize ordinary photos, screenshots, CJK/text-heavy diagrams, transparent graphics, small images and animated content. Text legibility, exact details where essential, alpha and animation outrank uniform extensions.
- Processing remains automatic, offline, reproducible under a declared pinned build environment, and integrated into the existing npm package, CLI, GitHub Action and static hosts. No required system-wide encoder installation, author-specific image configuration, hosted transformation API, or browser-side image decoding library.
- Prefer a small, maintainable dependency surface justified by actual package installation, portability, resource and quality evidence. Do not add multiple parallel encoders or a responsive-format matrix without an observed user benefit.
- Public identities follow the bytes actually shipped; unchanged inputs and pinned settings produce stable effective references. The output remains subject to the same reviewed publication set, failed-build preservation, exact inventory and privacy controls as 0009. Avoid needless rewrites or proliferation of derivatives.
- Do not set arbitrary universal per-file byte, quality, CPU or memory limits without representative measurements; provide bounded failure for pathological inputs and report the operative policies. Image handling must not cause a new ordinary-reading SQLite/WASM cost.

## Done when

1. A foreign-repository build automatically selects useful WebP output on representative photographs and images whose storage/transfer size improves without material visual degradation. It demonstrably **retains** source formats where WebP would be larger, unsuitable, or behavior-changing. Authors need no new config or manual image preparation.
2. A reproducible comparison reports source and published sizes, format choices, and render/visual quality for photographed scenes, CJK-small-text screenshots, line art, alpha, GIF animation, and already-compressed inputs. Any loss of technical readability, transparency or animation is a failure, not a successful compression statistic.
3. A measured representative corpus reports incremental build time, peak memory with the measurement method stated, package/tarball installation size, and Windows/macOS/Linux support evidence at the level actually exercised. Material regressions are addressed or exposed honestly; unsupported environments do not silently fall back to broken images.
4. Unchanged builds produce stable public assets and references; duplicate source use does not duplicate output. Failure controls show corrupt input and excessive resource demands fail safely, without leaking excluded media or replacing a previously qualified release.
5. The actual packaged output functions on the existing GitHub Pages and Cloudflare Pages root-site static hosting contracts, under CSP, without an image CDN integration or additional browser dependency. The owning design and adoption docs explain the automatic behavior without asking users to tune an encoder.

At the start, report any indispensable maintainer-only input; otherwise use reversible defaults and decide implementation choices from the observed evidence. Stop for irreversible or out-of-bounds changes. Finish with concrete comparisons, checks and failures, not merely an installed encoder or claimed compression ratio.
