# Publishing a repository of Markdown

You have a directory of notes under git. This turns it into a static site: every page
rendered ahead of time, full-text search, backlinks, a graph, and no application server.

This guide describes the current commands. The relationship and preview index is a public
[SQLite/WASM snapshot](core-design/sqlite-contract.md) at `/data/site.<sha256>.sqlite`,
fetched lazily by the browser for hover previews, tag browsing, and graph exploration.
Reading and navigation still work without JavaScript.

**Everything publishes unless you exclude it.** That is the one thing to know before you
start. There is no allowlist and no `publish: true` to opt in with — a file that is in the
repository and ends in `.md` becomes a page, so the work is deciding what to withhold.

**Status: the tool builds, previews, and ships the Action and `init` (TK-32).** The release
gate `pnpm run smoke:tarball` installs the packed product into a foreign git repository, runs
those public commands, and reads the resulting site and private report. Everything below is
reported as measured.

## What you need

Node 22.18 or newer — `package.json` `engines` pins it, and the shipped code is compiled
JavaScript, so nothing needs a TypeScript toolchain.

**And, today, a checkout of this repository.** The package is named `@wxxb789/anc`, and
it is not yet published to npm. The name is scoped because the unscoped npm name `anc` is
already taken by an unrelated third-party package — so **never type bare `npx anc`**: outside
a project that has this package installed, `npx` falls back to the registry and offers to
download and run that stranger's package. Until publication, there are two ways to run it.

From a checkout, against your notes elsewhere:

```bash
node /path/to/anc/bin/anc.mjs build --content ~/notes --out ~/notes/dist
```

Or install the tarball the repository builds as a dev dependency of your notes repository,
with pnpm or npm:

```bash
cd /path/to/anc && pnpm run pack:tarball
cd ~/notes
pnpm add -D /path/to/anc/wxxb789-anc-*.tgz     # or: npm install -D /path/to/anc/wxxb789-anc-*.tgz
```

then give the commands names in your notes repository's `package.json`, which work the same
under both package managers:

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
pnpm run build       # or: npm run build
pnpm run preview     # or: npm run preview
```

To call the binary directly instead, use `pnpm exec anc build`, or `npx --no anc build`
under npm: `--no` makes `npx` refuse rather than fetch the unrelated registry `anc` when the
local install is missing.

Everything below is written as `anc <command>`, meaning whichever of those you use. After
publication the registry form will be `npx @wxxb789/anc`, which runs the same binary.
`anc --version` prints the version you are running; through `npx`, write
`npx --no -- anc --version`, because without the `--` npm takes `--version` as its own flag
and prints npm's version instead.

## The shortest thing that works

```bash
cd your-notes
anc build
anc preview
```

Two commands. The first writes `dist/`; the second serves it at
`http://localhost:4321/` and stays in the foreground until Ctrl-C.

`build` prints four lines and no filenames:

```text
residue scan ok: … files, 0 findings
site written
content: 4 discovered, 2 published, 2 dropped (1 excluded-by-frontmatter, 1 not-markdown)
report: cat "$(git rev-parse --git-path publish-report/content-report.json)"
```

The counts are on the stream; the *names* are in the report, and the last line is how to read
it. That split is deliberate and it is the thing to understand before you publish from CI: a
workflow log on a public repository is world-readable and retained for 90 days, so a list of
the files you chose not to publish is an index to them. The report lives inside `.git/`, where
`git add -A` cannot reach it and `git clean -xfd` does not delete it.

**Outside a git repository** the last line reads differently: the report goes under your user
state directory (`$LOCALAPPDATA` or `$XDG_STATE_HOME`), keyed by a digest of the build
directory, and the line tells you so. The fallback retains at most 128 project reports and
expires reports untouched for more than 90 days; reports inside a git directory are not pruned.

## Deciding what not to publish

Two mechanisms. When they disagree, the one pointing at *not publishing* wins.

**Frontmatter, per note.** Unconditional — no glob can re-include it.

```markdown
---
publish: false
---
```

**Globs, in `publish.config.yaml` at the root of your notes.**

```yaml
title: Field Notes
origin: https://notes.example.org/
exclude:
  - "drafts/**"
  - "clients/**"
```

Four keys — `title`, `origin`, `exclude`, and `language` (see
[Filenames and URLs](#filenames-and-urls)) — and every one is optional. With no file at all
you get `title: Notes`, no exclusions, English, and a preview origin — the build succeeds and
the site is complete.

**A pattern that matches nothing fails the build.** This is the guard the whole design rests
on, so it has no override:

```text
publish.config.yaml — exclude[0] matched 0 files. A pattern that matches nothing is
usually a typo, and a mistyped exclusion publishes what it was meant to withhold.
Correct it, or delete it.
```

`draft/**` typed for `drafts/**` matches nothing, and without this rule the build is green and
the drafts are live. If a pattern is legitimately empty — a folder you have not created yet —
delete the line until you need it.

A key you spell wrong also fails, by line and with a suggestion:

```text
publish.config.yaml: 1 configuration violation
  - line 1: unknown key is not allowed. Did you mean "title"?
```

The line rather than the key, because a YAML key can be a path, and a path is the thing this
tool does not print. Open your own file at that line.

**Quote your globs.** YAML's plain scalars are a language and a glob is not written in it.
Unquoted, `!README.md` parses as an empty string, `&draft/**` parses as null, and — the one
worth knowing — `! README.md`, with a space, parses as the plain string `README.md`, which
**inverts what you meant**: a re-include becomes an exclusion. The loader refuses all five of
these rather than acting on them, but quoting avoids the argument entirely.

### What is skipped without being asked

`.git/`, `.obsidian/`, `node_modules/`, anything else starting with a dot, and the root
`README.md` — which addresses your repository rather than your reader. A `README.md` inside a
folder is an ordinary note. Re-include the root one with `"!README.md"`.

A symbolic link to a note elsewhere inside the content directory publishes under the link's
name. A link to a file **outside** it is dropped unread and counted as `link-outside-content`:
publishing only reads what lives under the directory you pointed it at.

Non-Markdown files are discovered and never emitted. **There is no asset pipeline**: an
embedded image does not ship, and a link to one degrades to text and is reported. That is
deliberate rather than pending — the alternative shape, copying every non-Markdown file, is
how comparable tools publish the images belonging to notes their users excluded. The final
output inventory fails if any note asset or unexpected route reaches the site anyway.

Run `anc init` before your first `git add -A`. It seeds `.gitignore` with
`node_modules/` and your build's output directory — which follows `--content`, so a build into
`notes/dist/` is ignored as `/notes/dist/` rather than as a root-anchored `/dist/` that would
miss it. It is safe to run twice: measured, three runs outside a git repository once produced
three copies of the block, and the command now recognises its own.

**Do not add `dist/**` to `exclude`.** It reads like the obvious hygiene rule and it does
nothing you want. Measured on a one-note repository, three builds in a row:

```text
first build (no dist/ yet)        1 discovered,  1 published,  0 dropped
second build (dist/ exists)      42 discovered,  1 published, 41 dropped
third build, dist/** excluded    43 discovered,  1 published, 42 dropped
```

The count goes **up**, not down. Every file in `dist/` is already dropped as `not-markdown`
before any exclusion rule is consulted, so the pattern changes a file's *reason* for being
dropped rather than whether it is walked — and it adds one, because the config file itself is
then discovered too. Nothing is published either way. `discovered` counts what the walk
classified, not what it considered publishing.

## Tags and collections

Tags come from a YAML list in note frontmatter. A scalar is refused rather than guessed:

```yaml
---
tags:
  - Security
  - field notes
---
```

Each tag gets a `/tags/<key>/` page and a link on the note. The first folder under the content
directory becomes the flat collection: `Projects/deep/note.md` belongs to `projects`; a root
note is uncollected. Deeper folders remain part of the note slug, not nested collections.
A first folder with no letters or digits at all — only punctuation or emoji — leaves the note
uncollected, while the note itself still publishes.

### Filenames and URLs

A note's URL is `/notes/<slug>/`, and the slug comes from its path, in any script: each folder
and the filename are lowercased and every run of spaces or punctuation becomes one hyphen, then
the parts are joined with `-`. `日记/今天.md` is `/notes/日记-今天/`, `Projects/Three laws.md` is
`/notes/projects-three-laws/`. Nothing is transliterated. A filename that leaves no letters or
digits (`___.md`, `🌱.md`) gets `note-` plus ten hex digits of a hash of its own path — stable
across builds, and unaffected by other files. So does a slug longer than 128 UTF-8 bytes (about
42 CJK characters). If two files derive the same slug (`a-b.md` and `a/b.md`), the first in sorted
order publishes, the other is dropped, the count line says `1 slug-collision`, and the report
names both; give one a `slug:` override.

Three other optional frontmatter fields reach the page: `slug` overrides the path-derived URL
with a lowercase route key in the same grammar (letters, digits, single hyphens, any script);
`language` (or `lang`) sets the BCP 47 document locale and
its chrome; `description` supplies the public note summary. Invalid shapes stop the build and
the private report identifies the source note. If a slug override collides with another note,
the first path in sorted order wins and the private report records the dropped path and winner.

**A site-wide default language** goes in `publish.config.yaml` as `language: zh-CN` (any BCP 47
tag). Every note without its own `language:` takes it, and so do the navigation pages. It also
picks the search index: Pagefind indexes a page under its `<html lang>`, and a Chinese note in
an English-indexed page is searchable only by whole sentences. Unset, the default is English.

Tracked notes take `created` and `updated` from the first and last commits that touch their
current paths. Creation requires full history — the Action example below uses `fetch-depth: 0`;
a shallow clone emits only `updated`. Untracked notes and directories outside git stay undated.
`created:` and `updated:` frontmatter are not read; git is the sole date authority.

Fenced code is highlighted at build time. When JavaScript is available, each fence gains a
localized copy control; without JavaScript the code remains complete and no dead button appears.

## Links

Five spellings, all resolved by one pass, following Obsidian's own order:

| You write | It resolves |
| --- | --- |
| `[[note]]` | by basename, when exactly one file has it |
| `[[./sibling]]`, `[[../other]]` | relative to the linking file. Only an explicit `./` or `../` is relative |
| `[[folder/note]]`, `[[Projects/Three laws]]`, `[[/Projects/Three laws]]` | from the **repository root** — a path with no `./` prefix is not relative, whatever it looks like. If nothing matches at the root, a path-suffix match is tried, preferring a file under the linking file's own folder |
| `[text](../other.md)`, `[text](/Projects/Three%20laws)` | the same tiers, after URL-decoding |
| `[[note\|shown]]` | the target resolves; the label is what a reader sees |

The third row is the one that surprises people. `[[folder/note]]` written from `b/src.md`
resolves to `folder/note.md` at the root, **not** to `b/folder/note.md`, even though both
exist — measured. Write `[[./folder/note]]` if you meant the nearby one, or `/`-anchor it if
you meant the root one.

Matching is case-insensitive and Unicode-normalised, so a link whose case differs from the
filename still resolves and a macOS-decomposed filename matches an NFC link.

A link that resolves to **more than one** file is reported with every candidate and the site
still builds — `/`-anchor it to disambiguate. A link to a note you excluded keeps the full
label and path you wrote, points to `/private/`, and is reported; the target note's body never
ships. That report row is your exclusion seen from the other side.

Aliases are **not** link targets. Obsidian desktop and Obsidian Publish genuinely disagree
here and this follows desktop. A YAML `aliases:` list is still public metadata: the note shows
it, search indexes it, and hover previews include it, but it creates no route and changes no
link resolution. The public `/data/site.<sha256>.sqlite` snapshot downloaded for previews
contains every alias of every published note in its `aliases` table. The same alias may belong
to more than one note, and an alias may equal another note's slug: aliases create no route and
resolve no link, so there is nothing to own or collide with.

## Reading the report

```bash
cat "$(git rev-parse --git-path publish-report/content-report.json)"
```

Per dropped file: the path and which rule dropped it. Per link finding: the source, the
1-indexed line, the link exactly as you wrote it, the outcome, and the candidates. Nothing in
it reaches `dist/`, and nothing in it can be committed.

## Reviewing the publish set

An ordinary `build` is for local preview and needs no approval file. Before producing an
artifact for deployment, record and commit the exact public note set:

```bash
anc review
git add --intent-to-add .publish-set.json
git diff -- .publish-set.json
git add .publish-set.json
git commit -m "review publish set"
anc build --release
```

The review file contains sorted public slugs only — no source paths and no withheld names.
Release mode requires it to be tracked, committed, unchanged, and exactly equal to the set the
producer just computed. Additions and removals both stop the release until you run `review`
again. Requiring the removal too is what prevents stale approval: a note cannot be published,
excluded, then silently re-included under its old ledger entry.

`--release` also refuses the loopback default origin and requires the exact Gitleaks version
named by `scripts/scan-secrets.ts` on `PATH`. It scans raw output plus explicitly inflated gzip,
with findings redacted. It qualifies a build for deployment; it does not deploy anything. The
Linux Action installs a checksum-pinned scanner before reading notes, always uses release mode,
and has no switch that disables either gate.

## Hosting it

**The Action exists.** `action.yml` at the root of this repository is what a user adds; the
hand-assembled equivalent below is still worth reading, because it is what the Action does and
the two properties are yours to preserve either way.

The Action is referenced by git coordinate — `uses: <owner>/<repo>@<ref>` — rather than by
package name, and that is deliberate rather than temporary. The Action installs the generator
from its own checkout with a frozen lockfile, so the ref you write pins the generator *and*
its whole dependency tree; it does not use the registry, and will not after publication.

**Pin the ref to a full commit SHA.** No release tag exists yet, so a 40-character commit SHA
from this repository is the only immutable pin available today. `@main` also works, but it is
unpinned: every push to this repository changes what your next build runs. Once releases are
tagged, `@vX.Y.Z` names one release exactly and `@v0` follows the latest 0.x release; a SHA
stays the strongest pin for a deploy workflow.

- **Clone at full depth.** `created` needs the first commit touching each current path. A
  shallow clone cannot prove that date, so the producer deliberately omits `created` there and
  keeps only the latest visible `updated`; `fetch-depth: 0` supplies both.
- **Set `origin` before you deploy.** With no `origin` the canonical links, the feed id, the
  sitemap, and `robots.txt` all point at `http://publish.localhost/`, which is loopback by
  RFC 6761 and reaches nobody. Ordinary preview builds allow it; `build --release` and the
  Action refuse it.
- **Commit the reviewed publish set.** The Action runs `build --release`, so a missing, dirty,
  or stale `.publish-set.json` stops before any deployable artifact is produced.
- **Use a Linux Action runner.** The checksum-pinned scanner installer supports Linux x64 and
  arm64. Manual release builds on other platforms may use the same Gitleaks version from PATH.

The output is a directory of static files. Any static host serves it, **at the root of a
domain.** Every route, the snapshot and WASM URLs, the Worker, and the search index are
root-anchored, and there is no base-path setting: `build` refuses an `origin` with a path
(`must be a bare origin with no path, query, or fragment`). So serve the site from a custom domain or
subdomain (`https://notes.example.org/`), or from a GitHub Pages *user or organisation* site —
a repository named `<user>.github.io`, served at `https://<user>.github.io/`. A GitHub Pages
*project* site at `https://<user>.github.io/<repo>/` is not supported unless you attach a
custom domain to it.

`dist/_headers` carries a Content-Security-Policy and three other security headers in
Cloudflare Pages' format. A host that ignores that file still applies the Content-Security-Policy
from the `<meta>` tag in every page, except `frame-ancestors`, which a meta tag cannot carry;
the other three headers are served only if you configure them on that host.

A rough GitHub Pages workflow, given the four caveats above:

```yaml
name: publish
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: false }
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: { name: github-pages }
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: <owner>/<repo>@<commit-sha>   # a full 40-character SHA; see above
        with: { content-dir: ., out-dir: dist }
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - uses: actions/deploy-pages@v4
```

No secrets: the notes repository is the deploy target, so the automatic `GITHUB_TOKEN` and
OIDC are enough, and nothing at build time reaches a network service.

**One consequence to weigh before choosing this.** GitHub Pages from a *private* repository
requires a paid plan, so the zero-secret path is a public notes repository — whose workflow
logs anyone can read. That is why the build prints counts and not names, and it is the reason
that rule is not negotiable.

## What it will not do

- Publish a non-Markdown file, including images.
- Publish a note whose derived slug is reserved by the site, such as root `about.md`,
  `search.md`, `tags.md`, or `private.md`. Rename the source file; the private report lists
  every conflicting note and slug together.
- Keep a note's URL when you rename it. There is no redirect map that grows from your corpus;
  a renamed note is a new address and the old one 404s.
- Transclude `![[note]]`. It becomes an ordinary link, and the report records the demotion as
  `embed-not-transcluded`.
- Run Dataview, Tasks, arbitrary HTML, or any script from a note.
