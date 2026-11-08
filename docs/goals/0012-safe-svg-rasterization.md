# 0012 — Safe SVG input with static raster output

Status: provisional. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Intended advance

A technical author can embed a local, self-contained static SVG directly from Markdown, while ANC automatically turns it into an ordinary efficiently delivered **WebP** image during the build. Readers never need an SVG interpreter supplied by ANC, and the original active SVG document never enters the published site.

This extends the successful local-image workflow instead of creating a standalone diagram service or a second media publishing route. Static technical diagrams with CJK labels, paths, gradients and transparent backgrounds are first-class subjects; unsupported dynamic SVG features are not silently promised.

## Prerequisite

Requires [0009 — Zero-config static images](0009-zero-config-static-images.md) and the measured image encoding/package behavior from [0011 — WebP-first delivery](0011-webp-first-image-delivery.md). It does not block either earlier outcome.

## Material bounds already decided

- SVG is build-time input only; the user has chosen **rasterization**, not sanitizing and hosting raw SVG. WebP is the preferred published format.
- The build must not fetch remote resources or read arbitrary local files through an SVG's internal references. Reject or securely isolate external images, fonts, styles, scripts, XML entities and other resource loading, including attempted traversal outside the content root.
- Prefer simple adoption and stable cross-platform packaging over the number of rendering features. Users should not need to install separate system tools or a large font/rendering toolchain just to publish a note.
- Preserve meaningful visual quality for small text and fine lines, transparent backgrounds and reasonable resolutions, within bounded build-time resource usage. Existing publication, privacy, output-scanning, no-JS and deterministic-output principles remain in force.

## Provisional completion basis

A future run should demonstrate that representative local SVG diagrams are faithfully converted to linked, viewable WebP assets in the **actual packaged ANC site**, with repeatable output under named pinned fonts/toolchain, supported environment coverage and measured build/install costs. Negative controls must prove that scripts, network/file references, hostile SVG constructs, missing glyphs and resource-exhaustion attempts neither disclose local data nor produce seemingly valid empty images. The shipped static site must contain no original source SVG.

**Refine before activation:** compare the actual packaged and quality evidence from 0011, then settle what bounded SVG feature set, font coverage, cross-platform identity guarantee and resource/failure budget can honestly be supported without disproportionate dependencies. The agreed rasterization direction is fixed; the rendering engine, executable form and font distribution are not. Do not promote a library recommendation or historical unmeasured timing into a completion guarantee.

This goal is **not ready to run yet**. A receiving agent must first refine it into a stand-alone `Done when` contract with verifiable controls, then follow the normal stop/report rules of [define-goal](README.md).
