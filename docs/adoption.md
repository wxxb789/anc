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

**The package is on the registry.** Install it as a dev dependency of your notes
repository, then let it prepare the repository — it seeds `.gitignore` and writes a
`publish.config.yaml` with every key commented out:

```bash
npm install -D @wxxb789/anc        # or: pnpm add -D @wxxb789/anc
npx @wxxb789/anc init
```

The name is scoped because the unscoped npm name `anc` is already taken by an unrelated
third-party package — so **never type bare `npx anc`**: outside a project that has this
package installed, `npx` falls back to the registry and offers to download and run that
stranger's package.

Then give the commands names in your notes repository's `package.json`, which work the same
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

To call the binary directly instead, use `pnpm exec anc`, or `npx @wxxb789/anc` under npm.
Everything below is written as `anc <command>`, meaning whichever of those you use.
`anc --version` prints the version you are running.

To try an unreleased commit, run from a checkout against your notes elsewhere, or install the
tarball the repository builds:

```bash
node /path/to/anc/bin/anc.mjs build --content ~/notes --out ~/notes/dist

cd /path/to/anc && pnpm run pack:tarball
cd ~/notes
pnpm add -D /path/to/anc/wxxb789-anc-*.tgz     # or: npm install -D /path/to/anc/wxxb789-anc-*.tgz
```

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

### Images

An image is published because **a published note references it**. The ordinary Markdown
forms work — `![alt](path/to/photo.png)`, a title after the path, the reference form
`![alt][ref]` with `[ref]: path/to/photo.png` on its own line — and so does an Obsidian
embed, `![[path/to/photo.png]]`. (A bare `![[note]]` is still a link to a note, not a
transclusion; that has not changed.)

A reference resolves **relative to the note, then relative to the content root**, and nowhere
else. `![chart](chart.png)` written in `notes/today.md` finds `notes/chart.png` first and
`chart.png` at the root second; it will not pick up a `chart.png` from an unrelated folder
because the name happened to match. `./` and `../` are exact: if the note-relative file is not
there, the build stops rather than looking elsewhere. A leading `/` names the content root.

A filename that a URL would read as syntax is written percent-encoded: a file named
`chart#one.png` is referenced `![chart](chart%23one.png)`, and the same applies to `&`,
`?` and `%`. The resolver decodes exactly once — `chart%2523one.png` names a file literally
called `chart%23one.png` — while a raw `#` still starts a fragment. The published
`/_assets/<sha256>-<name>` URL percent-encodes the character again, so the browser requests
exactly the bytes the build wrote.

The site serves one representation of each referenced picture under
`/_assets/<sha256>-<name>`, where the digest is the **emitted bytes'** own content. WebP is
preferred when it is worthwhile, not compulsory:

- An ordinary JPEG photograph becomes lossy WebP at quality 80 / effort 4. The candidate
  replaces the JPEG only when its bytes are smaller; otherwise the JPEG is published.
- An 8-bit PNG screenshot, diagram, or transparent graphic becomes **lossless** WebP. It
  replaces the PNG only when the lossless candidate is smaller, and the visible pixels and
  alpha are preserved exactly. A 16-bit PNG, or any PNG with a depth WebP lossless cannot
  carry without reducing values, is published unchanged as PNG.
- WebP's 16,383-pixel-per-side limit is a representability bound: a JPEG or 8-bit PNG with
  either side above it is published unchanged, not reported as corrupt.
- An existing WebP or AVIF is published unchanged. So is every GIF, every animated WebP,
  and every animated PNG (APNG): no frame, delay, or loop count is altered, and no first
  frame is extracted. APNG frame extents are not fully validated, but its PNG chunk stream
  still has to pass the completeness check.
- A corrupt, structurally incomplete, over-limit, or unsupported image fails the build.
  Completeness is checked before decoding: a truncated PNG, GIF, JPEG, WebP, or AVIF is
  refused even when a decoder can produce partial pixels from its prefix. There is no
  fallback to publishing bytes the encoder could not decode. A header whose *dimension
  fields* cannot be read is a different case: the complete image still publishes, without
  `width`/`height`.

**SVG diagrams.** A local, self-contained **static** SVG is accepted and
published as **lossless WebP**; the XML itself is never served. Write it like any
other picture — `![A flow diagram](diagrams/flow.svg)` — and the build validates
it, rasterizes it from the file's bytes, and hands the rest of the pipeline only
the WebP bytes. A rasterized SVG is laid out at **half the emitted raster**. When
the output budget does not bite, that is the author's logical size: an absolute
`width`/`height` in the document is honoured (`px`, `pt`, `pc`, `mm`, `cm`, `in`,
converted at CSS's 96 dpi), and a `viewBox`-only document is laid out at 720 CSS
pixels wide with its own aspect ratio. The published raster is normally 2× that
size, so text stays sharp on a high-density display; a picture wider than the
reading column is still capped by the page's CSS. When the finite output budget
clamps the raster, the layout shrinks with it: a 4000×4000 SVG is emitted at
2449×2449 and lays out at 1225×1225. Transparency is preserved, the encoding is
lossless, and two notes that embed the same file get one asset. Nothing is
cropped, no `viewBox` is rewritten, and a proportional downscale keeps a very
large diagram inside a finite pixel budget.

The accepted subset is deliberate and fail-closed. The source must be UTF-8
XML. A UTF-16 document does not match the byte signature and is reported as an
unsupported image; any other non-UTF-8 bytes are refused as malformed rather
than parsed.

- **Drawing:** shapes, paths, groups, `defs`/`symbol`/`use`, `view`, linear and
  radial gradients, patterns, masks, clip paths, markers, and static filters
  (blur, offset, merge, colour matrix, flood, drop shadow, component transfer,
  point and spot lighting, tile and turbulence within the work budget).
  `feDistantLight` is not part of the subset.
- **Text:** `text`, `tspan`, `textPath`, `title`, `desc`, and text converted to
  outlines. `<style>` sheets, `style` attributes and presentation attributes are
  supported for static styling.
- **References:** same-document fragments only — `href="#id"`,
  `xlink:href="#id"`, `url(#gradient)`. A gradient, mask, clip path, symbol or
  filter defined in the same file is fine.
- **Refused:** a DOCTYPE or entity declaration, XInclude, `script` or an `on*`
  handler, `foreignObject`, animation (`animate*`, `set`), an external stylesheet,
  any CSS at-rule (`@import`, `@font-face`, `@media`, …), an external `url()`, a
  `file:` or `http(s)` reference, a relative path, an embedded `data:` asset,
  `xml:base`, `<metadata>`, a root without
  `xmlns="http://www.w3.org/2000/svg"`, and any element or attribute outside the
  subset — including an Inkscape `sodipodi`/`inkscape` attribute or an RDF
  metadata block. Inert `role`, `aria-*`, `data-*`, `lang` and `tabindex`
  attributes and the legacy `xlink:title`/`xlink:role` are the documented
  exception; none can name a resource. Re-export the drawing as plain SVG if
  your editor adds anything else.
- **Fonts:** text uses the fonts installed on the build machine; ANC does not
  download or bundle one. Every `<text>` subtree is checked, including one in an
  unused `defs` or `symbol`, because proving a symbol is unreferenced is not
  worth the failure direction. If no installed font covers a character, the build
  fails and names the code point — install a font with those glyphs, or convert
  the labels to outlines in the editor. This is checked per character, not per
  requested family. Latin and CJK render on a host that has them; the same
  pinned engine and font set produce identical bytes across repeat builds, and
  no cross-machine byte identity is promised.

The failure reasons are part of the build's contract: `svg-invalid`,
`svg-doctype`, `svg-xinclude`, `svg-script`, `svg-foreign`, `svg-unsafe`,
`svg-animation`, `svg-external`, `svg-data`, `svg-css`, `svg-workload`,
`svg-font`, `svg-render`, and `svg-empty`. The public message counts them; the
private report names the element, attribute, CSS construct or code point.

No resize, crop, sharpening, responsive variant matrix, image CDN, browser script, or
per-image configuration is involved. The digest, the filename extension, and the bytes a
reader receives all agree, so a PNG that became WebP is served as `image/webp`. The same
picture referenced from five notes is one file, and an unchanged picture keeps its URL.

**Metadata.** A transcoded image carries no EXIF, XMP, IPTC, or ICC profile from its source:
orientation is applied to the pixels first and then the metadata is removed. **A passthrough
original is not scrubbed.** A JPEG kept because its WebP candidate was larger, a 16-bit PNG,
and every unchanged WebP, AVIF, GIF, or APNG keeps its EXIF/GPS block exactly as the file had
it. If you need unconditional metadata removal, do it before committing the image; ANC does
not promise it for passthrough bytes.

**Platforms.** The encoder and SVG rasterizer are the pinned `sharp` package, installed as an
ordinary npm dependency with its prebuilt platform binary; there is no system command,
`cwebp`, `librsvg`, `resvg`, or `libvips` installation step. SVG text uses the build host's
own fonts, and missing glyph coverage is a build failure rather than a bundled font. Linux x64
is the platform this repository's gates and measurements ran on. Windows and macOS are covered
by sharp's published prebuilt packages but were **not exercised here**; untested is not passed,
and cross-platform byte equality is not promised.

Write the image's description in `alt`, and use Markdown's own title for a caption:

```markdown
![A chart of revenue by quarter](charts/revenue.png "Figure 1: revenue by quarter")
```

That title is the caption a reader sees under the picture. `alt` is not repeated as a
caption, and an image without a title gets none — there is no automatic "Figure N" label.
An image written in the middle of a sentence, or wrapped in a link, keeps its inline form;
a decorative image can be marked `![](artwork.png)` and stays uncaptioned. A titled image
that is the only content of a list item becomes the same figure whether the list is tight
or loose. A `title` on an inline image remains a tooltip, because only a standalone block
image becomes a figure.

For PNG, JPEG, GIF, WebP and AVIF the build reads the picture's own pixel dimensions from
the **emitted** file and writes `width`/`height`, so the browser reserves the right space
before the bytes arrive and a portrait, a wide screenshot or transparent artwork stays
inside the article at any width. A transcode applies EXIF orientation to the pixels, so a
rotated photograph publishes upright at its displayed size. An unchanged image whose EXIF
orientation is not 1, or whose AVIF carries an `irot`/`imir` transform, is published as-is
and gets no dimension attributes rather than a pair that would reserve the wrong box. A
truncated or structurally incomplete file fails the build before decoding; that is distinct
from an unreadable dimension header, which only omits the attributes.
The first image in an article loads eagerly, later images load lazily, and all use
asynchronous decoding. This is ordinary static HTML: nothing here needs JavaScript, an
image CDN, or a configuration key.

An image that cannot be published **fails the build**, and the previously built site stays
where it was. The public message counts the reasons; the private report names the file and
the line. The reasons are:

- the file is not there;
- a `publish.config.yaml` exclusion hides it;
- the path leaves your content directory, or is a symbolic link to a file outside it;
- it is not one of the five raster formats or a self-contained static SVG;
- it is written as raw HTML, `<img src="...">`, which the resolver does not cover;
- its bytes are corrupt or truncated, it exceeds the finite source-size/decoded-pixel budget,
  a decode or encode exceeds its deadline, or the encoder returns bytes it cannot validate;
- an SVG was refused by the static-subset policy, exceeded its work budget (including an
  SVG over 8 MiB or more than 1,000,000 characters of CSS), had no visible pixel, or used
  text no installed font covers. The private report names the construct or code point; the
  SVG section above lists the accepted subset.

Remote images (`https://…`) are left exactly as you wrote them and are never downloaded during
a build. Files no published note references are never published, which is why an excluded
draft's attachments stay off the site.

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
its whole dependency tree; it does not use the registry, and publication does not change that.

**Pin the ref.** Releases are tagged: `@v0.0.2` names one release exactly and `@v0` follows
the latest 0.x release, while a full commit SHA stays the strongest pin for a deploy workflow.
`@main` also works, but it is unpinned: every push to this repository changes what your next
build runs.

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

- Publish a non-Markdown file no published note references. Images — including a local static
  SVG that becomes WebP — are published only through a reference in a published note. WebP
  conversion is automatic for JPEG and 8-bit PNG (16-bit PNG is retained), and a static SVG
  is always WebP; there is no resize, crop, responsive-variant matrix, external image host,
  per-author quality setting, or SVG `data:` URL. A dynamic SVG (script, animation,
  `foreignObject`), an embedded `data:` asset, or an external reference is refused, not
  partially rendered.
- Publish a note whose derived slug is reserved by the site, such as root `about.md`,
  `search.md`, `tags.md`, or `private.md`. Rename the source file; the private report lists
  every conflicting note and slug together.
- Keep a note's URL when you rename it. There is no redirect map that grows from your corpus;
  a renamed note is a new address and the old one 404s.
- Transclude `![[note]]`. It becomes an ordinary link, and the report records the demotion as
  `embed-not-transcluded`.
- Run Dataview, Tasks, arbitrary HTML, or any script from a note.
