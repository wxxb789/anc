# anc

Short for *Active Noise Cancelling*. The package and the command it installs are both `anc`.

Build a static site from a git repository of Markdown. Every note publishes unless you
exclude it.

**This repository is the tool.** It is not anybody's site and ships no content of its own.
If you want to publish your notes, read [`docs/adoption.md`](docs/adoption.md) — it is the one
document a stranger needs.

## What it does

- Walks a repository of Markdown and publishes every `.md` file, minus what you withhold by
  glob or by `publish: false` in frontmatter.
- Resolves five link forms in one pass, following Obsidian's own resolution order. A link into
  a note you withheld keeps its full label and path, points to `/private/`, and is reported; the
  target body remains unpublished. An ambiguous link warns with every candidate named.
- Renders backlinks, outgoing links, a graph, breadcrumbs, tags, collections, and a table of
  contents as build-time HTML — no fetch, no database. YAML frontmatter can set slug, language,
  description, tags, and searchable/displayed aliases; aliases deliberately remain non-link
  targets. The first folder supplies the collection, and git history supplies dates.
- Pagefind for search, bilingual chrome resolved per document, client-rendered math and Mermaid
  with source fallbacks, RSS, sitemap, and a strict CSP.
- Writes the names of everything it dropped to a file under `.git/` that cannot be committed,
  and only counts to the log. Every build also rejects routes or assets outside the exact
  route model and the package/Astro/Pagefind-owned output inventory. Release builds additionally
  run an exact-version, redacted Gitleaks scan over raw and inflated output.

## Architecture

- Astro `output: "static"`; the build output is `dist/`.
- Content is produced by `scripts/markdown-to-artifact.ts` and `scripts/resolve-links.ts`, then
  validated against `src/lib/schema.ts` before anything renders.
- About 4.7 KB gzip of vanilla script for the base interactive surfaces. Pages containing math
  or diagrams lazy-load the accepted client renderers (~116 KB or ~232 KB gzip respectively).
- No D1, R2, Functions, or network access at build time or runtime.

## Working on the tool

```bash
pnpm install
pnpm run verify          # lint, check, build, inventory, secret/residue scans, tests
pnpm run build           # the build chain alone
pnpm run build:fixture   # rebuild against the 32-note corpus
pnpm run pack:tarball    # compile TypeScript and pack the installable tarball
pnpm run smoke:tarball   # install that tarball in a foreign repo and build/read it
```

`pnpm run verify` also requires the exact Gitleaks version exported by
`scripts/scan-secrets.ts` on `PATH`; ordinary `pnpm run build` does not.

`packageManager` in `package.json` pins the pnpm version, which Corepack honours when enabled
(`corepack enable`). Dependencies install into a symlinked `node_modules`, so a package not
declared in `package.json` does not resolve — which is a boundary rather than a preference.

Read [`AGENTS.md`](AGENTS.md) before changing anything. It carries the verification contract,
what runs where, and a list of what is known stale and whose it is.

## Running the tool on your own notes

```bash
cd your-notes
npx anc build          # unrestricted local preview build
npx anc preview
npx anc review         # write .publish-set.json for inspection
npx anc build --release # exact set + pinned Gitleaks on PATH
```

**Not yet, though:** `package.json` carries `"private": true`, so the package is on no registry
and that specifier resolves for nobody. Until it is published, run
`bin/anc.mjs` from a checkout or install the tarball `pnpm run pack:tarball`
builds. [`docs/adoption.md`](docs/adoption.md) gives both, along with configuration, exclusion,
links, and hosting.

The GitHub Action and `init` command both ship. The Linux Action installs checksum-pinned
Gitleaks automatically; a manual release build must install the exact version itself. The
package is still private, so adoption uses the Action by git ref or the tarball until a registry
release exists.

## Deployment

Any static host serves `dist/`. `dist/_headers` carries a Content-Security-Policy and three
other security headers in Cloudflare Pages' format; a host that does not read that file serves
the site without them.

Publication remains an explicit external side effect. Building does not deploy, and nothing in
this repository can.
