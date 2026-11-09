# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 the
project makes no backward-compatibility promise.

## [Unreleased]

### Added

- Local images referenced by a published note are published. PNG, JPEG, GIF, WebP, and AVIF
  are published under `/_assets/<sha256>-<name>` and deduplicated by content, so an animation
  keeps every frame and one picture is one file however many notes embed it. (JPEG and PNG may
  be replaced by a smaller WebP candidate; the entry below states that policy.)
  A reference resolves relative to the note and then to the content root, with no basename
  fallback. A missing, excluded, escaping, or unsupported image — an SVG included — fails
  the build rather than shipping a broken picture, and the previously built site stays in
  place. Remote images are left as written and never fetched. That change added no
  configuration key, deployment step, or browser script; the 0011 entry below adds the
  encoder and may replace JPEG/PNG bytes, while passthrough originals are not scrubbed.
- Referenced JPEG and PNG images are published WebP-first when that is worthwhile, with no
  author configuration. A JPEG photograph becomes lossy WebP at quality 80 / effort 4 and is
  kept only when its emitted bytes are smaller; an 8-bit PNG screenshot, diagram, or alpha
  graphic becomes **lossless** WebP and is kept only when smaller. A 16-bit or other-depth
  PNG is published unchanged because WebP lossless cannot carry it without reducing visible
  values. Existing WebP/AVIF, every GIF or animated WebP, and every APNG publish unchanged,
  frame for frame. The encoder is pinned `sharp` 0.35.5 with its prebuilt platform packages:
  no system CLI, `cwebp`, `libvips` install, new configuration key, browser script, resizing,
  or responsive-variant matrix. Public identity is the SHA-256 of the emitted bytes, so
  duplicate outputs deduplicate and unchanged builds keep their URLs. EXIF orientation is
  applied before metadata removal on a transcode, dimensions come from the emitted bytes,
  and output format, size, and orientation are validated. A structural completeness gate
  checks every source before decoding — PNG chunk lengths, CRCs and final `IEND`; GIF trailer
  and descriptor count; JPEG `EOI`; WebP RIFF size; AVIF boxes and primary extent — so
  corrupt, truncated, or over-budget images fail the build under finite decoded-pixel,
  source-byte, and deadline limits, preserving the previous output. **Passthrough originals
  keep their metadata**, and ANC does not promise to scrub them.
- A block image's explicit Markdown title — in its own paragraph or alone in a list item —
  becomes a visible `<figcaption>` inside a semantic `<figure>`; `alt` stays the
  accessible alternative and is never promoted to visible prose. Uncaptioned,
  decorative, inline, and link-wrapped images keep their existing markup. The build
  reads intrinsic PNG/JPEG/GIF/WebP/AVIF dimensions from the already-published bytes
  and emits `width`/`height` so layout space is reserved; a malformed dimension header,
  or a JPEG/WebP/PNG EXIF or AVIF transform that changes the displayed orientation,
  yields no attributes rather than a guess. That is separate from source completeness:
  a truncated container is a build failure. The first image loads eagerly, later images
  lazily, and all decode asynchronously; that change added no dependency, browser script,
  configuration key, or image metadata store.

### Changed

- Documentation states the published state: `@wxxb789/anc` is on npm with provenance, the
  quick start installs from the registry, and the Action can be pinned by release tag
  (`@v0.0.2`, `@v0`) instead of only by commit SHA.

### Fixed

- An image whose filename carries `#`, `&`, `?` or `%` is resolvable from its
  percent-encoded Markdown destination. The resolver now splits the authored fragment first
  and decodes the path once, so `chart%23one.png` names `chart#one.png` while
  `chart%2523one.png` names a file literally called `chart%23one.png`; previously all four
  escapes were left encoded and the build failed as if the file were missing. The emitted
  URL percent-encodes the name, so the browser and the exact output inventory agree on the
  byte-identical file.

## [0.0.2] - 2026-11-07

### Security

- Updated production dependencies to clear the critical and high advisories
  reported against `astro` and `sanitize-html`.
- A UTF-8 byte-order mark or a padded opening `---` no longer hides a note's
  frontmatter, so `publish: false` holds for those files too.
- Reference-style links and their definitions go through the link resolver,
  so a definition pointing at a withheld note resolves to `/private/` and
  records the same edge as an inline link.
- Page, feed, and sitemap dates are normalised to UTC, so a committer's local
  UTC offset is no longer published.
- The Content-Security-Policy is also emitted as a `<meta>` tag, so hosts that
  ignore `_headers` still apply it (except `frame-ancestors`, which a meta tag
  cannot carry).
- A `.md` symbolic link whose target lies outside the content directory is
  dropped unread instead of publishing the external file.
- An unterminated leading `---` block that carries `publish:` fails the build
  however long it is, rather than only within its first 64 lines.

### Added

- Notes whose filenames contain no ASCII letters or digits, such as CJK-only
  names, get Unicode slugs with a deterministic hash fallback instead of being
  dropped.
- A site-level `language` key in `publish.config.yaml` sets the default
  document and navigation language.
- `anc --version` (and `-v`) prints the package version.
- The published tarball includes `LICENSE`.

### Fixed

- Runtime and accessibility fixes in the browser scripts.
- Client-rendered math parses TeX commands again: the bundler had corrupted the
  shipped renderer, so `\sum` or `\alpha` rendered as separate letters.
- The test suite runs on a Windows development host.
- Build-time gantt diagrams no longer draw a "today" line from the wall clock.
  It moved a pixel between two renders of identical Markdown, which made the
  determinism gate fail intermittently on `main` and would have changed the
  bytes of a rebuilt page.

### Changed

- CI hardening: third-party actions are pinned to commit SHAs, jobs have
  timeouts and concurrency groups, the Action-parity workflow also runs on
  pushes to `main`, a scheduled job runs `pnpm run build:fixture`, and
  Dependabot watches npm and GitHub Actions dependencies.
- Documentation states the real distribution state: the package is not yet on
  npm, the Action is pinned by commit SHA until release tags exist, and a site
  must be served at a domain root.
- Publication runs in CI: pushing a `vX.Y.Z` tag re-runs the release gates and
  publishes the compiled tarball through npm trusted publishing, so the
  repository stores no npm token. Release notes stay a maintainer step, written
  from the `CHANGELOG.md` section.
- A one-click `release` workflow bumps the version, moves the `Unreleased`
  CHANGELOG section under it, tags the commit, and dispatches publishing. It
  refuses a release commit that changes anything besides `package.json` and
  `CHANGELOG.md`.

## [0.0.1] - 2026-09-20

### Added

- First versioned state of the package under the scoped name `@wxxb789/anc`,
  which reserves the name. It is not a 0.1.0 candidate, was not tagged, and has
  not been published to npm.

[Unreleased]: https://github.com/wxxb789/anc/commits/main
[0.0.2]: https://github.com/wxxb789/anc/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/wxxb789/anc/commit/0fa2c75
