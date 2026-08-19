# Publishing a repository of Markdown

You have a directory of notes under git. This turns it into a static site: every page
rendered ahead of time, full-text search, backlinks, a graph, no server and no database.

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

**And, today, a checkout of this repository.** `package.json` carries `"private": true`, so
`@thoughtscape/publish` is on no registry and `npx @thoughtscape/publish` resolves for nobody.
Until it is published, the two ways to run it are:

```bash
# from a checkout, against your notes elsewhere
node /path/to/thoughtscape-publish/bin/thoughtscape-publish.mjs build --content ~/notes --out ~/notes/dist

# or install the tarball the repository builds
cd /path/to/thoughtscape-publish && pnpm run pack:tarball
cd ~/notes && npm install /path/to/thoughtscape-publish/thoughtscape-publish-*.tgz
npx thoughtscape-publish build
```

Everything below is written as `npx @thoughtscape/publish`, which is the intended shape and
the one the commands become on the day the package is published. Substitute one of the above
until then.

## The shortest thing that works

```bash
cd your-notes
npx @thoughtscape/publish build
npx @thoughtscape/publish preview
```

Two commands. The first writes `dist/`; the second serves it at
`http://localhost:4321/` and stays in the foreground until Ctrl-C.

`build` prints four lines and no filenames:

```
residue scan ok: … files, 0 findings
site written
content: 4 discovered, 2 published, 2 dropped
report: cat "$(git rev-parse --git-path publish-report/content-report.json)"
```

The counts are on the stream; the *names* are in the report, and the last line is how to read
it. That split is deliberate and it is the thing to understand before you publish from CI: a
workflow log on a public repository is world-readable and retained for 90 days, so a list of
the files you chose not to publish is an index to them. The report lives inside `.git/`, where
`git add -A` cannot reach it and `git clean -xfd` does not delete it.

**Outside a git repository** the last line reads differently: the report goes under your user
state directory (`$LOCALAPPDATA` or `$XDG_STATE_HOME`), keyed by a digest of the build
directory, and the line tells you so. Nothing else changes.

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

Three keys, and every one is optional. With no file at all you get `title: Notes`, no
exclusions, and a preview origin — the build succeeds and the site is complete.

**A pattern that matches nothing fails the build.** This is the guard the whole design rests
on, so it has no override:

```
publish.config.yaml — exclude[0] matched 0 files. A pattern that matches nothing is
usually a typo, and a mistyped exclusion publishes what it was meant to withhold.
Correct it, or delete it.
```

`draft/**` typed for `drafts/**` matches nothing, and without this rule the build is green and
the drafts are live. If a pattern is legitimately empty — a folder you have not created yet —
delete the line until you need it.

A key you spell wrong also fails, by line and with a suggestion:

```
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

Non-Markdown files are discovered and never emitted. **There is no asset pipeline**: an
embedded image does not ship, and a link to one degrades to text and is reported. That is
deliberate rather than pending — the alternative shape, copying every non-Markdown file, is
how comparable tools publish the images belonging to notes their users excluded. The final
output inventory fails if any note asset or unexpected route reaches the site anyway.

Run `thoughtscape-publish init` before your first `git add -A`. It seeds `.gitignore` with
`node_modules/` and your build's output directory — which follows `--content`, so a build into
`notes/dist/` is ignored as `/notes/dist/` rather than as a root-anchored `/dist/` that would
miss it. It is safe to run twice: measured, three runs outside a git repository once produced
three copies of the block, and the command now recognises its own.

**Do not add `dist/**` to `exclude`.** It reads like the obvious hygiene rule and it does
nothing you want. Measured on a one-note repository, three builds in a row:

```
first build (no dist/ yet)        1 discovered,  1 published,  0 dropped
second build (dist/ exists)      42 discovered,  1 published, 41 dropped
third build, dist/** excluded    43 discovered,  1 published, 42 dropped
```

The count goes **up**, not down. Every file in `dist/` is already dropped as `not-markdown`
before any exclusion rule is consulted, so the pattern changes a file's *reason* for being
dropped rather than whether it is walked — and it adds one, because the config file itself is
then discovered too. Nothing is published either way. `discovered` counts what the walk
classified, not what it considered publishing.

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
still builds — `/`-anchor it to disambiguate. A link to a note you excluded renders as the
words you wrote, with no anchor and no target, and is reported: that line is the most useful
one in the report, because it is your exclusion seen from the other side.

Aliases are **not** link targets. Obsidian desktop and Obsidian Publish genuinely disagree
here and this follows desktop. They are also not indexed for search or previews, because the
producer does not read them at all — an `aliases:` key in your frontmatter currently reaches
nothing.

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
npx @thoughtscape/publish review
git add --intent-to-add .publish-set.json
git diff -- .publish-set.json
git add .publish-set.json
git commit -m "review publish set"
npx @thoughtscape/publish build --release
```

The review file contains sorted public slugs only — no source paths and no withheld names.
Release mode requires it to be tracked, committed, unchanged, and exactly equal to the set the
producer just computed. Additions and removals both stop the release until you run `review`
again. Requiring the removal too is what prevents stale approval: a note cannot be published,
excluded, then silently re-included under its old ledger entry.

`--release` also refuses the loopback default origin. It qualifies a build for deployment; it
does not deploy anything. The shipped Action always uses this mode and has no switch that
disables the review.

## Hosting it

**The Action exists.** `action.yml` at the root of this repository is what a user adds; the
hand-assembled equivalent below is still worth reading, because it is what the Action does and
the two properties are yours to preserve either way.

The Action is referenced by git coordinate — `uses: <owner>/<repo>@<ref>` — rather than by
package name, and that is deliberate rather than temporary. The package is not published, so
`npx` resolves for nobody today; but a git ref keeps working through a rename, and a workflow
pinned to a package name does not. A user's adopted workflow surviving a rename of this tool is
worth more than a shorter install line.

- **Clone at full depth.** `created` and `updated` are meant to come from git commit dates, and
  a shallow clone would produce a site that looks correct and carries wrong dates — the failure
  class documentation does not prevent. Measured today, the producer derives neither field at
  all, so this costs nothing yet and matters from the commit that changes that.
- **Set `origin` before you deploy.** With no `origin` the canonical links, the feed id, the
  sitemap, and `robots.txt` all point at `http://publish.localhost/`, which is loopback by
  RFC 6761 and reaches nobody. Ordinary preview builds allow it; `build --release` and the
  Action refuse it.
- **Commit the reviewed publish set.** The Action runs `build --release`, so a missing, dirty,
  or stale `.publish-set.json` stops before any deployable artifact is produced.

The output is a directory of static files. Any static host serves it. `dist/_headers` carries
a Content-Security-Policy and three other security headers in Cloudflare Pages' format; a host
that does not read that file serves the site without them, which works and is weaker.

A rough GitHub Pages workflow, given the three caveats above:

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
      - uses: actions/setup-node@v5
        with: { node-version: 24 }
      - run: npx @thoughtscape/publish build --release
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
- Keep a note's URL when you rename it. There is no redirect map that grows from your corpus;
  a renamed note is a new address and the old one 404s.
- Transclude `![[note]]`. It becomes an ordinary link, and the report records the demotion as
  `embed-not-transcluded`.
- Group notes into collections. `collection` is a field the site renders and the producer does
  not yet derive, so `/collections/` is empty whatever your folders look like. Folders reach
  the site only through the slug: `projects/sub/deep.md` publishes at
  `/notes/projects-sub-deep/`.
- Read dates from git. `created` and `updated` are unset, so `/recent/` falls back to slug
  order, the feed stamps its undated sentinel, and the sitemap omits `<lastmod>`.
- Run Dataview, Tasks, arbitrary HTML, or any script from a note.
