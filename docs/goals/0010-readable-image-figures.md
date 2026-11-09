# 0010 — Readable and accessible image figures

Status: ready. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Desired outcome

Images that already publish correctly through ANC become readable, accessible parts of technical articles: readers understand a figure's caption, images retain their intended aspect ratio while the page loads, and image rendering behaves sensibly across narrow and wide screens. Authors should use familiar Markdown rather than an ANC-specific component or configuration.

This is a reading-quality outcome, not an image encoder, CDN, or visual-effects project.

## Prerequisite and material bounds

Prerequisite: [0009 — Zero-config static images](archive/0009-zero-config-static-images.md) is accepted.

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
