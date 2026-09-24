# anc — a privacy-preserving static site generator for Markdown notes and digital gardens

[![status: pre-release](https://img.shields.io/badge/status-pre--release-orange)](#status)
[![node: >=22.18](https://img.shields.io/badge/node-%E2%89%A522.18-brightgreen)](#working-on-the-tool)
[![verify](https://github.com/wxxb789/anc/actions/workflows/verify.yml/badge.svg)](https://github.com/wxxb789/anc/actions/workflows/verify.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![docs: core design](https://img.shields.io/badge/docs-core%20design-blue)](docs/core-design/README.md)

[English](README.md) · [简体中文](README_zh-cn.md)

![anc, a privacy-preserving static site generator: publish your Markdown notes from git as a static digital garden with wikilinks, backlinks, a link graph, and Pagefind full-text search](docs/assets/readme-banner.webp)

**anc turns a git repository of Markdown into a self-hosted static knowledge
garden**: articles, backlinks, a link graph, breadcrumbs, tags, collections, a table
of contents, full-text search, feeds, and a sitemap — all rendered ahead of time into
plain static files that any host can serve.

It reads the notes you already have, including Obsidian-style `[[wikilinks]]`, and
needs no database, server, or account. Every note publishes unless you exclude it.
Ordinary reading needs no JavaScript, and nothing is sent to a third party.

![A note page built by anc: breadcrumbs, published and updated dates from git, tags, aliases, a table of contents, and a callout, in the dark theme](docs/assets/screenshot-note.webp)

*anc* is short for **A**ctive **N**oise **C**ancelling. The command it installs is
`anc`; the package is named `@wxxb789/anc` and is not yet published to npm.

## Contents

- [Status](#status)
- [Why anc](#why-anc)
- [Features](#features)
- [How it works](#how-it-works)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [How publication is decided](#how-publication-is-decided)
- [Links, tags, and metadata](#links-tags-and-metadata)
- [Architecture](#architecture)
- [Working on the tool](#working-on-the-tool)
- [Adoption and hosting](#adoption-and-hosting)
- [FAQ](#faq)
- [Documentation](#documentation)
- [License](#license)

## Status

**Pre-release.** The tool builds, previews, and ships the GitHub Action and the `init`
command. It is named `@wxxb789/anc`, because the unscoped `anc` is already taken on
npm, and it is not on the registry yet; install from a checkout or from the tarball the
repository builds. [`docs/adoption.md`](docs/adoption.md) gives both, along with
configuration, exclusion, links, and hosting. ANC is not yet 0.1.0-ready or
1.0.0-ready and makes no backward-compatibility promise.

## Why anc

- **Your notes stay yours.** Markdown in git is the source of truth. There is no
  import step, no proprietary vault format, and no hosted service to subscribe to.
- **Privacy is decided at publication.** `publish: false` and exclusion globs withhold
  a note, a typo in a pattern fails the build instead of leaking drafts, and the build
  log never prints a withheld file's name.
- **A digital garden, not a blog.** Backlinks and the link graph are computed at
  build time from how your notes link; hover previews and graph exploration read the
  same public snapshot lazily.
- **Static and portable.** The output is a `dist/` folder of HTML, CSS, a Pagefind
  index, and one SQLite file. GitHub Pages, Cloudflare Pages, Netlify, or any web
  server can host it at the root of a domain.

## Features

| Surface | What you get |
| --- | --- |
| Markdown | CommonMark plus GFM: tables, task lists, footnotes, callouts, highlighted code |
| Links | `[[wikilinks]]`, relative and root-anchored links, Markdown links, and note embeds |
| Relationships | Backlinks, outgoing links, and a link graph, rendered to static HTML |
| Navigation | Tags, collections, breadcrumbs, table of contents, and recent changes |
| Search | Pagefind full-text search, with a per-document language |
| Rich content | Client-rendered math and Mermaid diagrams, each with a source fallback |
| Discovery | Atom feed, sitemap, `robots.txt`, canonical URLs, and Open Graph metadata |
| Languages | Per-document chrome in English and Simplified Chinese (`zh-CN`) |
| Privacy | Default-publish with explicit withholding; released names stay out of logs |
| Delivery | Static HTML by default; a public SQLite/WASM snapshot for lazy previews |
| Security | A strict Content-Security-Policy in `dist/_headers`; no trackers or analytics |

## How it works

![How anc works: Markdown notes in a git repository go through anc build, which applies exclusion gates, resolves wikilinks and backlinks, and renders every page ahead of time into a dist/ folder of static HTML, a Pagefind index, and one SQLite snapshot, which any static host serves](docs/assets/build-pipeline.webp)

1. **Write** Markdown in the git repository you already keep, in any editor —
   Obsidian, VS Code, or plain `vim`.
2. **Build** with `anc build`. Exclusions are applied first, then every link is
   resolved and every page is rendered ahead of time.
3. **Host** the resulting `dist/` folder anywhere that serves static files.

## Screenshots

Every image below is a real page built by anc from a small synthetic garden;
[`docs/assets/make-screenshots.mjs`](docs/assets/make-screenshots.mjs) regenerates them.

| Backlinks and outgoing links | Local link graph |
| --- | --- |
| ![Links to and Linked from lists on a note page, each rendered as static HTML](docs/assets/screenshot-relationships.webp) | ![The Nearby notes graph around one note, laid out at build time with a table fallback](docs/assets/screenshot-graph.webp) |
| **Hover preview** | **Full-text search** |
| ![A link preview card showing the target note's title and excerpt on hover](docs/assets/screenshot-preview.webp) | ![The Pagefind search dialog with highlighted matches across notes](docs/assets/screenshot-search.webp) |

## Quick start

From a checkout of this repository, against your own notes:

```bash
node /path/to/anc/bin/anc.mjs build --content ~/notes --out ~/notes/dist
node /path/to/anc/bin/anc.mjs preview --dist ~/notes/dist
```

Or install the tarball the repository builds:

```bash
cd /path/to/anc && pnpm run pack:tarball
cd ~/notes
pnpm add -D /path/to/anc/wxxb789-anc-*.tgz   # or: npm install -D /path/to/anc/wxxb789-anc-*.tgz
```

Then name the commands in your notes repository's `package.json`; the same scripts
work under pnpm and npm:

```json
{
  "scripts": {
    "build": "anc build",
    "preview": "anc preview",
    "review": "anc review",
    "release": "anc build --release"
  }
}
```

```bash
pnpm run build     # or: npm run build
pnpm run preview   # serves dist/ at http://localhost:4321/
pnpm run review    # write .publish-set.json for inspection
pnpm run release   # exact publish set + pinned Gitleaks on PATH
```

To call the binary directly, use `pnpm exec anc build`, or `npx --no anc build` under
npm: `--no` makes `npx` refuse rather than fetch from the registry when the local
install is missing. After publication the registry form will be
`npx @wxxb789/anc build`. **Do not type bare `npx anc`:** outside a project with the
tarball installed it falls back to the registry, where the unscoped `anc` is an
unrelated third-party package that `npx` would offer to download and run.

## How publication is decided

**Everything publishes unless you exclude it.** There is no allowlist and no
`publish: true` to opt in with. Two mechanisms withhold a note, and when they
disagree the one pointing at *not publishing* wins:

![How anc decides publication: every Markdown file in the repository publishes by default, publish: false and exclude globs withhold notes, a glob matching nothing fails the build, the public dist/ receives the site, and a private content-report.json under .git/ receives the withheld names](docs/assets/publication-flow.webp)

```markdown
---
publish: false
---
```

```yaml
# publish.config.yaml
title: Field Notes
origin: https://notes.example.org/
exclude:
  - "drafts/**"
  - "clients/**"
```

A pattern that matches nothing stops the build. That is deliberate: `draft/**` typed
for `drafts/**` would otherwise build green while the drafts went live. A link to a
withheld note keeps the full label and path you wrote, resolves to `/private/`, and is
reported; the withheld note's own body, title, and excerpt reach nothing.

The build prints counts and no filenames. The list of dropped files goes to
`content-report.json` under `<git-dir>/publish-report/` (or your user state directory
outside git), which `git add -A` cannot reach and which is never copied into `dist/`.
A workflow log on a public repository is world-readable, so a withheld file's path is
a disclosure there; that is why the names and the counts are split.

## Links, tags, and metadata

- Five link spellings resolve in one pass, following Obsidian's own order: `[[note]]`,
  `[[./sibling]]`, `[[folder/note]]`, `[text](../other.md)`, and `[[note|shown]]`.
- Tags come from a frontmatter list, and each one gets a `/tags/<key>/` page. The
  first folder under the content root becomes the flat collection.
- Git history supplies `created` and `updated`; frontmatter does not.
- Frontmatter can set `slug`, `language`, `description`, `tags`, and `aliases`.
  Aliases are public, searchable metadata with no route of their own — deliberately
  not alternate link targets.
- Non-Markdown files are never published. There is no asset pipeline, so an embedded
  image degrades to text and is reported.

## Architecture

Long-term architecture is documented in [`docs/core-design/`](docs/core-design/README.md);
bounded development outcomes and their completion evidence live in
[`docs/goals/`](docs/goals/README.md). Markdown stays canonical, the compiler IR stays
private, static HTML delivers pages, and Pagefind owns full-text search.

- Astro `output: "static"`; the build output is `dist/`.
- Content is produced by `scripts/markdown-to-artifact.ts` and `scripts/resolve-links.ts`,
  then validated against `src/lib/schema.ts` before anything renders.
- The one public relational and preview index is `data/site.<sha256>.sqlite`, holding
  `nodes`, `edges`, `aliases`, `tags`, and `node_tags`. It contains no page body and no
  SQLite FTS; the browser fetches it lazily in a read-only Worker for hover previews,
  tag browsing, and graph exploration.
- Base interactive surfaces are a few KB gzip of vanilla script. Pages containing math
  or diagrams lazy-load the accepted client renderers; both have source fallbacks.
- No D1, R2, Functions, analytics, comments, or build-time data service. A runtime
  application server is not required.

## Working on the tool

```bash
pnpm install
pnpm run verify          # lint, check, build, inventory, secret/residue scans, tests
pnpm run build           # the build chain alone
pnpm run build:fixture   # rebuild against the 32-note corpus
pnpm run build:example   # build example/ into .tmp/example-dist
pnpm run preview:example # serve the example build locally
pnpm run pack:tarball    # compile TypeScript and pack the installable tarball
pnpm run smoke:tarball   # install that tarball in a foreign repo and read it
```

`pnpm run verify` requires the exact Gitleaks version exported by
`scripts/scan-secrets.ts` on `PATH`; an ordinary `pnpm run build` does not.
`packageManager` in `package.json` pins the pnpm version, which `corepack enable`
honours. Dependencies install into a symlinked `node_modules`, so a package not
declared in `package.json` does not resolve — a boundary rather than a preference.

Read [`AGENTS.md`](AGENTS.md) before changing anything. It carries the verification
contract, what runs where, and what is known stale and whose it is. The synthetic
corpus under [`example/`](example/) is the smallest useful feature tour, with public
notes, both exclusion mechanisms, links and backlinks, rich Markdown, math, and Mermaid.

## Adoption and hosting

The GitHub Action at the repository root runs a release build on a supported Linux
runner, installs the checksum-pinned secret scanner, and writes a static `dist/`. Any
static host serves that directory, at the root of a domain: a site under a path such
as `https://<user>.github.io/<repo>/` is not supported. `dist/_headers` carries a
Content-Security-Policy and three other security headers in Cloudflare Pages' format;
a host that ignores that file still gets the policy from each page's `<meta>` tag,
except `frame-ancestors`, and serves the other headers only if configured to.

Publication is an explicit external side effect. Building does not deploy, and nothing
in this repository can. [`docs/adoption.md`](docs/adoption.md) covers both the Action
and a hand-assembled GitHub Pages example, with no secrets required.

## FAQ

**Can anc publish an Obsidian vault?**
Yes: point `--content` at the vault. anc reads Obsidian-style `[[wikilinks]]`,
`[[note|shown text]]`, note embeds, and callouts; keeping the vault in git also gives
each page its created and updated dates. Plugins and non-Markdown attachments are not
processed.

**Do I need a server, a database, or an account?**
No. The output is static files. Search runs from a Pagefind index and relationships
from one SQLite file, both fetched by the reader's browser only when used.

**How do I keep a note private?**
Add `publish: false` to its frontmatter, or match its path with an `exclude:` glob in
`publish.config.yaml`. See [How publication is decided](#how-publication-is-decided).

**Does the site work without JavaScript?**
Reading, navigation, backlinks, and the link graph's table fallback are plain HTML.
Search, hover previews, math, and diagrams need JavaScript.

**Where can I host it?**
Any static host at the root of a domain: GitHub Pages, Cloudflare Pages, Netlify, or
your own web server. See [Adoption and hosting](#adoption-and-hosting).

## Documentation

- [`docs/adoption.md`](docs/adoption.md) — what a stranger with a notes repository does.
- [`docs/core-design/`](docs/core-design/README.md) — authoritative long-term architecture.
- [`docs/goals/`](docs/goals/README.md) — active goals and the completed-goal archive.
- [`docs/gate-reading.md`](docs/gate-reading.md) — the seven ways an instrument lies
  about itself.
- [`AGENTS.md`](AGENTS.md) — contributor workflow and the verification contract.
- [`example/`](example/) — a synthetic corpus demonstrating every public surface.

[Astro documentation](https://docs.astro.build) · [Pagefind documentation](https://pagefind.app/docs/)

## License

Released under the [MIT License](LICENSE).

---

[English](README.md) · [简体中文](README_zh-cn.md)
