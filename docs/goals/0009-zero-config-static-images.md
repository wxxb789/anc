# 0009 — Zero-config static images

Status: ready. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Desired outcome

A stranger with a repository of Markdown and local images can use ANC's existing build, preview, and release workflows to publish readable images on GitHub Pages or Cloudflare Pages, **without image-specific configuration, a separate image host, credentials, or a new deployment step**. The result is a self-contained static site: pictures display in ordinary HTML even when JavaScript is disabled.

This is the first media outcome. Correct publication precedes compression, WebP conversion, SVG rasterization, and hosted-media integrations.

## Prerequisite and material bounds

Prerequisite: the packaged, independently usable publisher established by [0007](archive/0007-independent-publisher-adoption.md), which is completed. This goal is independent of unfinished [0008](0008-acceptable-browser-cost.md).

- Local PNG, JPEG, GIF, WebP, and AVIF used by published Markdown notes are publishable without transcoding. Preserve animated-image behavior and original bytes in this phase. SVG is **not** a publishable file type yet; a local SVG embed must fail clearly rather than silently disappear or ship active content. Existing HTTPS image URLs continue to work without being fetched or mirrored.
- Image references resolve in the context of the writing note, including ordinary Markdown images, reference-style images, and image wikilinks actually used in the corpus. An unambiguous, explicitly relative path does not silently resolve to an unrelated basename elsewhere. If a local HTML image form is not supported, it fails visibly during publication rather than leaving a broken public link or bypassing asset authorization.
- Publish **only the image bytes intentionally referenced by published notes** and allowed by the existing publication/exclusion boundary. Unreferenced media, media referenced exclusively by withheld notes, explicitly excluded files, links escaping the content root, and files outside the authorized source tree must not enter public output. An unresolved or unauthorized local image is a failed build, not missing HTML or a link to `/private/`.
- The same source image referenced repeatedly produces one public asset; unchanged inputs produce stable published bytes and URLs. Output inventory, privacy scans, failed-build preservation, and release qualification retain their existing authority. No new public index, note-graph edge, SQLite body store, browser JavaScript, or image service is justified.
- The present hosting contract is a **site at the domain root**, including Cloudflare Pages and GitHub Pages user/organization sites or custom domains. GitHub Pages project sites at `/<repo>/` still require a separate site-wide base-path decision. This goal must not claim to support that currently unsupported deployment shape.
- Reuse the existing origin, reviewed publish set, CLI, GitHub Action, and deployable `dist/`. No image-specific `publish.config.yaml` fields or external system tools. Raw copied photos can still contain source metadata such as EXIF/GPS: do not describe this phase as metadata sanitization.

The accepted architecture currently excludes a local asset pipeline. The implementing change must reconcile the owning [core design](../core-design/README.md) and [adoption documentation](../adoption.md) with the new publication contract; a goal file alone does not override them.

## Done when

1. A foreign notes repository with several published notes, shared raster images, an image with spaces/Unicode in its path, reference-style syntax, and an image wikilink builds successfully with ANC's **packaged** public interface. The emitted HTML points only to present image files, each image displays in an ordinary static server/browser without JavaScript, and no extra image setup is necessary.
2. The same qualified static output is consumable by the existing GitHub Pages root-site workflow and Cloudflare Pages root-site conventions: image requests return the intended bytes and content type, under the actual published CSP, without manually copying media or configuring an image CDN. If live host deployment is inaccessible, demonstrate the real packaged output and host-compatible static serving; state that live deployment was **not** verified rather than claiming it was.
3. Duplicate references publish one asset, changing a source image updates the effective public reference, and two unchanged builds have the same asset identities and content. Image references do not become note graph edges; existing non-image links and remote HTTPS images remain correct.
4. Negative controls prove that a missing image, an excluded image, an escaping link/symlink, an unsupported local SVG, and a local HTML image form not covered by the accepted resolver cannot silently publish or leak bytes. A failed build preserves the previously qualified site; public diagnostics never print private source paths. A withheld-only or unreferenced asset stays absent from the entire output.
5. Existing security, exact-inventory, release, package-install and verification entry points cover the resulting **actual** bytes, including a foreign-repository build. The owning core-design contract and user-facing publishing instructions describe what is supported, what remains excluded, and the present GitHub Pages root-path limitation.

Do not substitute hand-authored HTML or a copied `public/` fixture for the production content-to-site path. Do not add image optimization or a provider integration to satisfy this goal. At the start, stop and report if a material input only the maintainer can provide is unavailable; otherwise use reversible implementation defaults. Stop for irreversible or out-of-bounds decisions, and finish by pairing each completion judgment with its concrete evidence and any failures.
