# 0009 — Zero-config static images

Status: completed 2026-11-09. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Desired outcome

A stranger with a repository of Markdown and local images can use ANC's existing build, preview, and release workflows to publish readable images on GitHub Pages or Cloudflare Pages, **without image-specific configuration, a separate image host, credentials, or a new deployment step**. The result is a self-contained static site: pictures display in ordinary HTML even when JavaScript is disabled.

This is the first media outcome. Correct publication precedes compression, WebP conversion, SVG rasterization, and hosted-media integrations.

## Prerequisite and material bounds

Prerequisite: the packaged, independently usable publisher established by [0007](0007-independent-publisher-adoption.md), which is completed. This goal is independent of unfinished [0008](0008-acceptable-browser-cost.md).

- Local PNG, JPEG, GIF, WebP, and AVIF used by published Markdown notes are publishable without transcoding. Preserve animated-image behavior and original bytes in this phase. SVG is **not** a publishable file type yet; a local SVG embed must fail clearly rather than silently disappear or ship active content. Existing HTTPS image URLs continue to work without being fetched or mirrored.
- Image references resolve in the context of the writing note, including ordinary Markdown images, reference-style images, and image wikilinks actually used in the corpus. An unambiguous, explicitly relative path does not silently resolve to an unrelated basename elsewhere. If a local HTML image form is not supported, it fails visibly during publication rather than leaving a broken public link or bypassing asset authorization.
- Publish **only the image bytes intentionally referenced by published notes** and allowed by the existing publication/exclusion boundary. Unreferenced media, media referenced exclusively by withheld notes, explicitly excluded files, links escaping the content root, and files outside the authorized source tree must not enter public output. An unresolved or unauthorized local image is a failed build, not missing HTML or a link to `/private/`.
- The same source image referenced repeatedly produces one public asset; unchanged inputs produce stable published bytes and URLs. Output inventory, privacy scans, failed-build preservation, and release qualification retain their existing authority. No new public index, note-graph edge, SQLite body store, browser JavaScript, or image service is justified.
- The present hosting contract is a **site at the domain root**, including Cloudflare Pages and GitHub Pages user/organization sites or custom domains. GitHub Pages project sites at `/<repo>/` still require a separate site-wide base-path decision. This goal must not claim to support that currently unsupported deployment shape.
- Reuse the existing origin, reviewed publish set, CLI, GitHub Action, and deployable `dist/`. No image-specific `publish.config.yaml` fields or external system tools. Raw copied photos can still contain source metadata such as EXIF/GPS: do not describe this phase as metadata sanitization.

The accepted architecture currently excludes a local asset pipeline. The implementing change must reconcile the owning [core design](../../core-design/README.md) and [adoption documentation](../../adoption.md) with the new publication contract; a goal file alone does not override them.

## Done when

1. A foreign notes repository with several published notes, shared raster images, an image with spaces/Unicode in its path, reference-style syntax, and an image wikilink builds successfully with ANC's **packaged** public interface. The emitted HTML points only to present image files, each image displays in an ordinary static server/browser without JavaScript, and no extra image setup is necessary.
2. The same qualified static output is consumable by the existing GitHub Pages root-site workflow and Cloudflare Pages root-site conventions: image requests return the intended bytes and content type, under the actual published CSP, without manually copying media or configuring an image CDN. If live host deployment is inaccessible, demonstrate the real packaged output and host-compatible static serving; state that live deployment was **not** verified rather than claiming it was.
3. Duplicate references publish one asset, changing a source image updates the effective public reference, and two unchanged builds have the same asset identities and content. Image references do not become note graph edges; existing non-image links and remote HTTPS images remain correct.
4. Negative controls prove that a missing image, an excluded image, an escaping link/symlink, an unsupported local SVG, and a local HTML image form not covered by the accepted resolver cannot silently publish or leak bytes. A failed build preserves the previously qualified site; public diagnostics never print private source paths. A withheld-only or unreferenced asset stays absent from the entire output.
5. Existing security, exact-inventory, release, package-install and verification entry points cover the resulting **actual** bytes, including a foreign-repository build. The owning core-design contract and user-facing publishing instructions describe what is supported, what remains excluded, and the present GitHub Pages root-path limitation.

Do not substitute hand-authored HTML or a copied `public/` fixture for the production content-to-site path. Do not add image optimization or a provider integration to satisfy this goal. At the start, stop and report if a material input only the maintainer can provide is unavailable; otherwise use reversible implementation defaults. Stop for irreversible or out-of-bounds decisions, and finish by pairing each completion judgment with its concrete evidence and any failures.

## Implementation progress

Branch `feat/0009-zero-config-static-images`, created off `origin/main` at
`be6b6cf`. The implementation is uncommitted by design (the orchestrator verifies
and lands it); this record therefore names files and commands rather than a commit.

**Producer.** `src/lib/media.ts` is new and owns the whole decision: the five
publishable formats and their canonical extensions, signature-based format
detection, the bound/percent-encoded asset name, the canonical
`/_assets/<sha256>-<name>` URL parser, and the two-tier image resolver
(note-relative, then content-root; no basename tier). `scripts/markdown-to-artifact.ts`
records a verdict for every non-Markdown file during the walk
(`available` / `excluded` / `escaping`), builds one publisher per build that
reads, sniffs, hashes and deduplicates by digest, refuses the build on any
unauthorized reference, and writes the artifact plus a digest-verified staging
directory beside it. `scripts/resolve-links.ts` gives image nodes to that
publisher instead of the note resolver, keeps reference-style images and their
definitions pointing at the asset, rejects local raw-HTML `<img>` (with inert
forms — a comment, an inline code span, a fence — left alone), and records one
row per refusal for the private report.

**Render and emit.** `src/lib/schema.ts` accepts and validates the artifact's
sorted, unique, canonical `assets` list. `src/lib/markdown.ts` refuses a local
image `src` the artifact did not publish (classified with the same
whitespace-stripping rule `sanitize-html` uses), and `src/pages/notes/[slug].astro`
hands it the artifact's own list. `scripts/copy-assets.ts` is the new emission
step: it copies exactly the declared assets into `dist/_assets/`, verifying name,
digest and format, and refuses a staged file the artifact does not declare.
`scripts/verify-output-inventory.ts` owns the namespace and checks every emitted
file's digest and format. `scripts/scan-residue.ts` declares `.gif` and `.avif`
binary (and `.gitattributes` declares both, plus `.jpeg`, so the two lists agree).
`src/pages/privacy.astro` was corrected: a same-origin published image is no
longer described as a third-party exception.

**Gates.** `tests/media-pipeline.test.ts` (17 tests) runs the real producer over
scratch corpora with real bytes; `tests/media-display.test.ts` (4 tests) builds
with the shipped binary and opens the served output in Chromium with
`javaScriptEnabled: false`; `tests/output-inventory.test.ts` gained the asset rows;
`tests/content-contract.test.ts` the asset-list contract rows;
`tests/disclosure.test.ts` a fourth differential run whose failure is a missing
image; `tests/markdown.test.ts` the renderer's local-`src` refusal and the kitchen
sink's published asset. `scripts/smoke-tarball.ts` builds a foreign repository
containing three images (a name with a space and CJK, a reference-style
definition, an Obsidian embed, a photograph shared by two notes) and checks the
served bytes and a script-free browser, then proves a missing image fails the
release build without replacing the last good output.

**Fixtures and docs.** `tests/fixtures/valid-corpus.json` now declares three
assets (808 bytes total) whose committed bytes live in `tests/fixtures/assets/`;
`image-embed-demo` and `orphan-one` share one photograph, and the demo note carries
the spaces/Unicode and reference-style cases. `tests/support/media.ts` holds the
real PNG/JPEG/animated-GIF/animated-WebP/AVIF/not-an-image fixtures.
`docs/core-design/media-pipeline.md`, `content-semantics.md`, `architecture.md`,
`docs/core-design/README.md`, `AGENTS.md`, `docs/adoption.md`, `README.md`,
`README_zh-cn.md`, `CHANGELOG.md`, and the historical requirements bullet now
describe the implemented contract. `src/data/content.json` was not edited.

**A limit of the fixture corpus, stated rather than worked around.** The committed
32-note corpus is a *post-resolution* artifact: its bodies already carry the
rewritten form, and `build:fixture` builds from that JSON rather than from a
content directory. A `![[image.png]]` embed therefore cannot live in it — the
renderer would emit the literal text and the residue scan would refuse it. The
fixture corpus exercises spaces/Unicode, a shared image, reference-style syntax,
deduplication, emission, inventory and the scans; image-*wikilink resolution* is
exercised on the real content path by `tests/media-pipeline.test.ts` (which the
`build:fixture` suite runs) and by the packaged smoke's foreign corpus. Turning
the committed corpus into a generated one would change its `public_id`, dates and
edge provenance, so it was not done inside this goal.

## Completion record

Completed 2026-11-09 on `feat/0009-zero-config-static-images` (implementation
uncommitted; base `be6b6cf`). Environment: Linux x64, 4 vCPU / 8 GB; this host has
Node 24.16.0 where `.nvmrc` pins 24.18.1, which satisfies Astro's `>=22.23.4`
floor — the repository's own gate runs under the pinned version in CI.

### Commands and results

| Command | Result |
| --- | --- |
| `pnpm run verify` | 91 files / 1080 passed / 34 skipped, exit 0 (lint, `astro check`, the full build chain with the pinned secret and residue scans, and the test suite) |
| Browser files re-run alone with `--maxWorkers=1` when a 180 s timeout appeared under worker contention | the six browser files that timed out under 4-worker contention (`preview-content`, `preview-failure`, `preview-lifecycle`, `preview-intent`, `preview-limits`, `tag-browser`) passed 35/35 in 95 s with `--maxWorkers=1`; `tests/adoption.test.ts` and `tests/database-residue.test.ts` passed 41/41 in 72 s the same way |
| `pnpm run build:fixture` | 91 files / 1109 passed / 5 skipped, exit 0 (`fixture build ok: every gate passed against tests/fixtures/valid-corpus.json`); the build reported `image assets ok: 3 files`, `output inventory ok: 230 files`, and `secret scan ok: 230 files, 0 findings` |
| `pnpm run pack:tarball` | compiled 75 TypeScript files and rewrote specifiers in 24; wrote `wxxb789-anc-0.0.2.tgz` (428,730 bytes, sha256 `31bc73ea…`), which carries `scripts/copy-assets.js` and `src/lib/media.js` |
| `pnpm run smoke:tarball` | passed: `tarball adoption smoke ok: 2 published notes, 2 withheld notes, 3 images` (exit 0), including the script-free Chromium image check, the served-byte/content-type checks, and the missing-image failed-build preservation |

### "Done when" → evidence

**1. A foreign repository builds with the packaged interface, points only to
present files, and displays them without JavaScript.**
`pnpm run smoke:tarball` (above) installs the packed tarball with npm into a
synthetic foreign git repository and runs the shipped `init`, `review`, and
`build --release`. That corpus embeds a PNG whose name carries a space and CJK
(`media/图 表 one.png`), a reference-style `[shot]: media/photo.jpeg`, and an
Obsidian embed `![[media/anim.gif]]`; the smoke asserts three `/_assets/` files,
each hashing to its URL, three `<img>` URLs on the welcome page, and exactly one
URL shared with the second note. `checkImages` then opens the served output in a
Chromium context with scripting disabled and requires every `<img>` to report
`complete` with `naturalWidth > 0`, fetches each asset and checks its
`Content-Type` and digest. `tests/media-display.test.ts` runs the same
script-free display check inside `verify` against a second corpus.

**2. The output is consumable by the root-site host conventions, under the
published CSP, with no media copying or CDN.**
`tests/media-display.test.ts` asserts the served `Content-Security-Policy`
carries `img-src ... 'self'` and that every image decodes under it;
`serveDist` applies `public/_headers` per path, and the smoke applies the
foreign build's own generated `dist/_headers`. The published extension is
derived from the detected bytes, so the static host's extension→MIME mapping
serves the right type (`tests/media-pipeline.test.ts`: a PNG named `.jpg`
publishes as `.png`; the inventory checks the same property over the built bytes,
and the smoke checks the served content type for every published extension).
*Live deployment to GitHub Pages or Cloudflare Pages was **not verified** — no
host or deployment credential was reachable, and deployment is a separately
approved external action.*

**3. Duplicate references publish one asset, a changed source changes the public
reference, two builds agree, and images are not graph edges.**
`tests/media-pipeline.test.ts` covers each: five references across three source
names produce one staged file; a rebuilt corpus after the source bytes change
yields a different URL and the new bytes; two runs produce identical artifact
bytes, names and pixels; `outgoing` is unchanged by an image; remote `https:`
and `data:` images are left byte-for-byte, and a build whose `fetch` throws still
completes.

**4. Negative controls.**
One row per fault — missing, excluded by a glob, `../` escape, symlink escape,
SVG, unsupported bytes, raw-HTML `<img>` — asserts the `image-not-publishable`
code, the public reason label, the private detail, and that no asset directory
was staged. A separate control proves an `<img>` a note only *documents*
(a comment, inline code, a fence) builds and publishes nothing. The withheld-only and unreferenced
assets never reach the artifact or the output. `tests/disclosure.test.ts` adds a
fourth corpus of its rename differential whose failure is a missing image and
requires the two streams to be byte-identical and to name neither the directory
nor the image. The packaged smoke appends one missing reference to the already
qualified repository, requires a non-zero exit, no path on the stream, and a
`dist/` byte-identical to the last good build.

**5. Existing gates own the actual bytes, and the docs describe the contract.**
`tests/output-inventory.test.ts` asserts a declared asset is required, must hash
to its URL, must be the format its extension names, and that an undeclared
`_assets/` file is an unexpected member. `build:fixture` runs the inventory, the
pinned secret scan and the residue scan over the three committed assets; the
smoke runs both scans over the three foreign assets in `build --release`.
Documentation: the list in "Implementation progress", including the explicit
root-path limitation (document editing, not a new deployment claim).

### Deliberately not done

0010 (captions/layout), 0011 (sharp/WebP), 0012 (SVG rasterization), 0013 (R2);
metadata scrubbing (passthrough bytes keep EXIF/GPS, and the docs say so);
site-wide base paths / GitHub Pages project sites; external image hosts; image
optimization or responsive variants; any new dependency, configuration key,
browser script, SQLite column, or public manifest.

### Residual limits

- Live host deployment and post-deploy smoke tests are unverified (out of scope
  and separately approved).
- An image is read whole to hash it, again to stage it beside the artifact, and
  the staged copy is read once more to emit it. No size bound is introduced here
  because input limits belong to 0011's measured policy, so a very large
  referenced image is bounded by the host's memory.
- `_assets/` URLs are content-addressed but `public/_headers` grants `immutable`
  to `/_astro/*` only, so images inherit the platform's revalidating default.
  Adding a rule is a host-policy change with its own gate; it is not part of this
  goal and is not claimed.
- A source file edited between hashing and staging fails the build with
  `asset-source-changed` rather than publishing a URL that no longer describes
  its bytes; the corpus is expected to be stable during a build.
- This host's Node is 24.16.0 against a 24.18.1 pin (see above); CI uses the pin.
