# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 the
project makes no backward-compatibility promise.

## [Unreleased]

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

### Changed

- CI hardening: third-party actions are pinned to commit SHAs, jobs have
  timeouts and concurrency groups, the Action-parity workflow also runs on
  pushes to `main`, a scheduled job runs `pnpm run build:fixture`, and
  Dependabot watches npm and GitHub Actions dependencies.
- Documentation states the real distribution state: the package is not yet on
  npm, the Action is pinned by commit SHA until release tags exist, and a site
  must be served at a domain root.

## [0.0.1] - 2026-09-20

### Added

- First versioned state of the package under the scoped name `@wxxb789/anc`,
  which reserves the name. It is not a 0.1.0 candidate, was not tagged, and has
  not been published to npm.

[Unreleased]: https://github.com/wxxb789/anc/commits/main
[0.0.1]: https://github.com/wxxb789/anc/commit/0fa2c75
