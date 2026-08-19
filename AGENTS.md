# thoughtscape-publish Agent Contract

> `AGENTS.md` is canonical. `CLAUDE.md` is a symlink to this file.

## Goal

Build a static, privacy-preserving site from a git repository of Markdown, for a user who is
not this repository's owner. Every file publishes unless the user excludes it.

**This repository is the tool, not anyone's site.** It ships no personal content, no personal
identity, and no default that names it. A sentence in any file here that only makes sense if
the reader is this repository's owner is a defect — see [`docs/adoption.md`](docs/adoption.md)
for what a stranger actually does, and `.tmp/tk-31-report.md` for the 126 occurrences of one
owner's name a foreign build carried before TK-31 removed them.

## Boundaries

- This repository is public-facing. Never commit personal notes, credentials, local
  identifiers, or a host filesystem path into it.
- The privacy guarantee is **the publication event, not the input**. Under default-publish
  every Markdown file in the user's repository is readable by construction, so nothing at read
  time keeps a note private. What does: `publish: false` in frontmatter (rank 1,
  unconditional), exclusion globs in `publish.config.yaml` (rank 2), and the gates that refuse
  a pattern matching nothing. `scripts/markdown-to-artifact.ts` states the precedence at
  `discover`. A release-qualified artifact comes from `build --release`, which also requires
  the exact computed slug set in a committed, unchanged `.publish-set.json`; deployment itself
  remains external and separately approved.
- **The build's names go to a file git cannot commit; its counts go to the log.** A workflow
  log on a public notes repository is world-readable and retained 90 days, so a withheld
  file's path — or its basename — is a disclosure there. `content-report.json` lives under
  `<git-dir>/publish-report/`, is never an artifact key, and is never copied into `dist/`.
  `tests/disclosure.test.ts` gates the split by renaming the corpus and diffing the streams.
- **A link to a withheld note keeps its full path and resolves to `/private/`.** The rendered
  body carries the path exactly as the author wrote it, and the link is live: it lands on a
  generated page stating that the note is not published and will not be. `publish: false`
  still withholds the note — its body, title, and excerpt reach nothing — and only the *link*
  changed.

  **This reverses the rule of 2026-08-14 and it has a cost the owner accepted on 2026-08-17
  after hearing it.** The superseded rule reduced a withheld target to its last segment, so
  `[[clients/acme/2026-renewal]]` published as the text `2026-renewal` and the directory
  never left the host. Under the rule that now holds, the full path of every withheld note a
  published note links enters `dist/` — and under the planned SQLite conversion it enters a
  database every visitor downloads, where one `SELECT` lists every path the author excluded.
  That is the intended consequence and not a defect to mitigate. The reasoning the old rule
  rested on is in `.tmp/tk-27-report.md` §7.1 and in the superseded-gate notes in
  `tests/link-traversal.test.ts` and `tests/backlink-surfaces.test.ts`; what it bought was
  that a reader could not learn the shape of the author's private tree, and that is what was
  spent.

  Two things follow that are easy to get wrong. The `private` slug is **reserved**
  (`src/lib/schema.ts`), because `markdown.ts` rewrites every single-segment `/<slug>/` href
  through `routeForSlug` and a user's own `private.md` would otherwise capture every withheld
  link on their site. And the page is `noindex`: it names no note, but an indexed copy would
  be listed by a search engine under the text of every withheld link on the site, which
  gathers into one crawlable record what is otherwise scattered.

  **The two-surface rule the old one rested on is now a one-surface rule.** A withheld name
  is still a disclosure *on a stream* — that is what the bullet above holds, and
  `tests/disclosure.test.ts` still enforces it. It is no longer withheld from the rendered
  body. Both directions are deliberate.
- `src/data/content.json` and `public/content-index.json` are this repository's own build
  inputs. `src/data/content.json` holds one synthetic entry, `reading-a-build-log`; `ff0db9d`
  replaced the real personal note plan D2 named, so that gap is closed.
- Publication and deployment are external side effects requiring explicit approval. A
  successful local build is not deployment authorization.
- Keep runtime static. D1, R2, Functions, analytics, comments, or other stateful services
  require a measured need and a separate design decision.

## Workflow

```bash
pnpm run build          # Astro + Pagefind + output inventory + residue scan
pnpm run verify         # every gate: lint, check, build, scans, tests
pnpm run build:fixture  # rebuild against the 32-note corpus, un-skipping the multi-entry gates
pnpm run pack:tarball   # compile TypeScript and produce the installable tarball
pnpm run preview        # `astro preview` over this repository's own dist/
```

`pnpm run verify`, `build:fixture`, and packaged `build --release` require the exact
`GITLEAKS_VERSION` exported by `scripts/scan-secrets.ts` on `PATH`. CI and the composite Action
install checksum-pinned Linux archives before any scan or note read; ordinary preview builds
do not require the external tool. A manual release host must install that version itself.

`pnpm run preview` is not the same command a user gets. `astro preview` serves *this*
repository's build, and `scripts/preview-site.ts` records the measurement that a stranger
installing under pnpm has no `node_modules/astro` at all — so the shipped preview is the
binary's own `preview` subcommand.

pnpm is the only supported package manager **for this repository's own install**;
`packageManager` in `package.json` pins the version. Its symlinked `node_modules` is a
boundary, not a preference: a module that imports a package absent from `package.json` fails
to resolve rather than silently borrowing it from a transitive dependency.

`pnpm run pack:tarball` is the one command that shells `npm`, and deliberately: it invokes
`npm pack` inside the staging directory it has just built, which is no longer part of this
workspace, and npm is what a consumer installs the result with. That is a carve-out for
producing an artifact, not for managing this repository's dependencies.

The name is `pack:tarball` rather than `pack` because npm runs `pre`/`post` hooks around *any*
script name. `package.json`'s `prepack` refuses a bare `npm pack` — which would otherwise ship
this repository's `.ts` sources, which Node cannot strip under `node_modules` — and measured,
a hook by that name fires for `npm run pack` too and never reaches the script's body. A refusing hook and a script
called `pack` cannot coexist.

## Verification

`pnpm run verify` is the gate. It runs lint and type check, then one locked build chain ending
in exact inventory, pinned redacted secret, and residue scans, then the test suite. `&&` stops
on the first failure. Run it before proposing a merge and report the pass count.

### What runs where

| Gate | `pnpm run verify` | `pnpm run build` | CI | the shipped binary |
| --- | --- | --- | --- | --- |
| Oxlint | yes | — | yes | — |
| `astro check` | yes | — | yes | — |
| Content contract + derived-route validation | yes | yes | yes | yes |
| Astro build, redirects, Pagefind index | yes | yes | yes | yes |
| Exact output inventory: routes, package assets, Astro/Pagefind namespaces | yes | yes | yes | yes |
| Pinned Gitleaks over raw and inflated output | yes | — | yes | `build --release` |
| Residue scan over the output — markers, paths, schemes, source maps, the search index | yes | yes | yes | yes |
| Configuration parse: unknown key, wrong type, malformed YAML | — | — | — | yes |
| Exclusion: `publish: false`, globs, zero-match refusal | — | — | — | yes |
| Release qualification: public origin + committed exact publish set | — | — | — | `build --release` |
| Test suite | yes | — | yes | — |
| Rendered-browser gates (Playwright) | when Chromium is installed | — | yes, always | — |

The last column replaces what used to say "Cloudflare Pages". `bin/thoughtscape-publish.mjs`
runs the same generated-output chain `package.json`'s `build` names, link for link. Secret
scanning is the deliberate exception: repository `verify` and packaged `build --release` run
it, while an ordinary preview does not require an external binary. Both relationships are
gated. Cloudflare Pages is one deployment target among several and builds nothing this
repository owns; [`docs/adoption.md`](docs/adoption.md) covers hosting.

CI (`.github/workflows/verify.yml`) runs `pnpm run verify` rather than restating its steps, so
the two cannot drift; `tests/verify.test.ts` fails if a gate is ever spelled out in the
workflow instead.

**The repository has no git remote, so the workflow does not run yet.** Until one exists,
every gate above is enforced only by running `pnpm run verify` on the host.

### Still manual

- Deployment. Requirements section 21.1 stage 13 makes it a separately approved action; CI
  deliberately cannot deploy and needs no secrets.
- Post-deploy smoke tests (stage 14), which need a deployed origin.
- `pnpm run build:fixture`, the 32-note corpus that un-skips the multi-entry gates. Not in
  `verify` because it builds the site twice. It *can* now run concurrently with the suite — the
  two interlock over `dist/` and wait for each other (`scripts/dist-lock.ts`), which the
  "Known-stale" table records was not always true.
- `pnpm run pack:tarball`, which compiles this package's TypeScript to JavaScript and packs
  the tarball. Not in `verify` because the artifact is a release step, not a gate — but the
  compile itself *is* gated: `tests/packaging.test.ts` stages a package on every run and
  asserts it carries no `.ts`, `.map`, or `.d.ts`, and no surviving `.ts` specifier.
- `git diff --check`, which reads the working tree rather than the artifact and so belongs to
  the commit step, not the build.
- `pnpm run smoke:tarball`, the release gate over the adoption path end to end. It packs the
  current tree, installs the tarball with npm into a synthetic foreign git repository, runs the
  shipped `init`, `review`, and `build --release`, and reads the public artifact plus private
  report. It is not in `verify` because installing the full production dependency tree needs
  the npm cache or network.

### Properties the gates assert

- Generated routes are exactly the route model; package assets are byte-bound to `public/`;
  Astro owns only flat hashed JS/CSS; Pagefind has an exact runtime allowlist and metadata-bound
  content-addressed index members.
- Gitleaks is exact-version pinned, cannot inherit user config or allow comments, scans one
  decode layer plus raw and explicitly inflated gzip, and never preserves or prints matched
  secret values.
- Release mode requires a public origin and a committed ledger exactly equal to the computed
  public slugs; missing, dirty, added, and removed states fail, and shrink-then-re-include fails
  as a new addition rather than inheriting stale approval.
- Removing a note and rebuilding removes its route, content-index entry, feed and sitemap entry,
  and Pagefind record while a retained note remains on all five surfaces.
- No horizontal overflow, browser console error, or broken internal link.
- Search opens and indexes published pages.
- Backlinks carry only the linked note's title and route, checked against an allowlist of both
  text and attribute *values* — a leak only had to wear an allowed attribute name to pass the
  earlier version (`tests/backlink-surfaces.test.ts`). Hover previews are a client script and
  are gated in the browser suite, not over `dist/`.
- `dist/` carries no `msw/` marker, absolute local path, unsafe URL scheme, non-image `data:`
  URL, or source-map reference — in raw, entity-decoded, invisible-character-stripped, or
  **gzip-inflated** form. A Pagefind fragment stores extracted text with inline elements
  joined, so `ms**w/s**ecret` reaches the search box as `msw/secret` while no byte anywhere in
  `dist/` contains it (TK-29 §2).
- An unresolved `[[wikilink]]` in `dist/` outside a `<code>` or `<pre>` region fails the build.
  It is not a privacy rule — `[[` discloses nothing — it is the producer's self-check that its
  degradation ran. The artifact-level version of this rule was deleted, because a note
  documenting Obsidian syntax is content.
- A link to a withheld note is a live anchor at `/private/` carrying the author's label whole,
  and the withheld note's own body reaches no published file. The second half is the one the
  2026-08-17 reversal did not move, and it is now the *only* thing standing between a link and
  a publication — so it is gated over every file in the output with gzip members inflated.
- A site built by a stranger carries no occurrence of this project's name, asserted over every
  file as bytes and after inflating gzip members, with a positive control that plants the name
  *split by markup* so the gate cannot silently degrade into a raw substring search.
- Nothing the CLI writes to stdout or stderr changes when the corpus is renamed. The counts go
  to the stream and the names go to `content-report.json`.

## Reading a gate's own result

Seven distinct ways to misread an instrument have been found here, each the hard way and each
by a different ticket. They are collected in
[`docs/gate-reading.md`](docs/gate-reading.md) with the measurement behind each. The short
form, because the cost of not knowing them is a ticket:

1. A **green** mutation may mean you mutated something inert.
2. A **red** one may mean you mutated something broader than the property claimed.
3. **Empty output is not green** — and a mutation that fails to apply produces the same green
   as a gate that does not care.
4. **A control that reimplements what it is controlling for measures the reimplementation.**
5. **A fixture you construct encodes what you believe the pipeline emits**, so a gate over one
   measures your belief, not the product.
6. **A broken measurement can break toward good news.** A bundle that failed to resolve half
   its dependencies measured 42% of its real size, and nothing in the number said so.
7. **An unverified mechanism survives in prose and gets quoted back as fact.** The `.astro/`
   staging story reached this file and two briefs before one `node -e` falsified it.

Unifying: the instrument has to be confirmed to have looked at the thing before its answer
means anything — and so does the explanation.

## Known-stale, and whose

Recorded rather than fixed, because each belongs to a ticket that has not run. An agent
meeting one of these has met a known gap, not a discovery.

| What | State | Owner |
| --- | --- | --- |
| `src/pages/about.astro`, `privacy.astro` | shipped pages; plan §4.4 says notes `init` seeds. TK-32 built `init` and deliberately did not seed them — that row is tied to deleting the two pages, which is not TK-32's scope, and a seeded note beside a shipped page contradicting it is worse than neither | unassigned |
| `og:image` | never emitted; `SOCIAL_CARD_PATH` is `undefined` and no config key sets it | unassigned |
| The report state directory | grows without pruning. **The key is per-directory, not per-build** — `sha256(realpath(cwd))`, a pure function of the path. A count rising once per build was three agents and a `mkdtemp`-heavy suite sharing a host, and reading that count as an identity is lesson 1 of `docs/gate-reading.md` committed against itself | unassigned |
| `dist/` as a shared output path | **Fixed.** `scripts/dist-lock.ts` interlocks the three commands that write or read it — the suite (vitest `globalSetup`), `pnpm run build`, and `build:fixture` — so they wait for each other instead of emptying a directory another is reading. The row this replaces blamed `.astro/`, which was wrong for three tickets: measured, `getOutDirWithinCwd` returns an `outDir` under cwd unchanged, the binary stages under `PACKAGE_ROOT` after chdir'ing there, and 24 concurrent binary builds against a live suite were all clean. What collided was `emptyDir(config.outDir)` (`astro/dist/core/build/static-build.js:64`) over the one `dist/`. See `.tmp/staging-collision-report.md` | closed |

## Documentation

- [`docs/adoption.md`](docs/adoption.md) — what a stranger with a notes repository does.
- [`docs/gate-reading.md`](docs/gate-reading.md) — the seven ways an instrument lies about itself.
- [`docs/public-knowledge-garden-requirements.md`](docs/public-knowledge-garden-requirements.md)
  — the requirements every section reference in a source comment points at.
- [`docs/plans/ssg-generalisation-plan.md`](docs/plans/ssg-generalisation-plan.md) — the
  general-purpose turn, its tickets, and what its own drafting got wrong.

Astro documentation: https://docs.astro.build
Pagefind documentation: https://pagefind.app/docs/
