# anc Agent Contract

> `AGENTS.md` is canonical. `CLAUDE.md` is a symlink to this file.

## Core design authority

Read [`docs/core-design/README.md`](docs/core-design/README.md) before changing
architecture, content semantics, build artifacts, or browser data access. That
directory is the accepted **long-term architecture**, superseding conflicting historical
requirements, plans, and ticket comments. This file owns contributor workflow;
the core-design documents own architecture. Do not duplicate their schema here.

- **SQLite/WASM is required for 0.1.0**, not a deferred optional phase. Static
  reading and accessible relationship HTML remain mandatory.
- Follow the [SQLite contract](docs/core-design/sqlite-contract.md): one public
  relational/preview DB, queried at build time and lazily in a browser Worker.
  No public `content-index.json`, `graph-manifest.json`, or adjacency JSON in the
  target; no page body, stored backlinks, speculative edge kinds, or SQLite FTS.
- Preserve [content semantics](docs/core-design/content-semantics.md), especially
  publication exclusions, withheld-link behavior, slug identity, tag collisions,
  aliases as metadata, and the exclusion of self-links from graph edges.
- Keep Markdown canonical, the compiler IR private, static HTML as page delivery,
  and Pagefind as full-text search. Do not conflate an IR field used by rendering
  with a requirement to publish that field in SQLite.
- Follow [build/runtime binding](docs/core-design/build-and-runtime.md): one
  finalized DB per output, exact hashed URL, real digest verification, read-only
  Worker, no ordinary-reading fetch, and static fallback on failure.
- Every new structure or exception needs a named consumer and an ablation result.
  Read [verification and evolution](docs/core-design/verification-and-evolution.md)
  for invariant evidence and the change process. Update the owning design section,
  affected consumers, and meaningful invariant tests together; never silently
  reintroduce an older plan's design because an old test expects it.

Before implementation, identify the governing sections and relevant invariants.
Before finishing, review the diff against those invariants and report evidence,
remaining gaps, and any design changes. Raise genuinely unresolved product choices;
do not repeatedly ask permission for work already authorized by the task.

**No backward compatibility:** ANC is not yet 0.1.0-ready or 1.0.0-ready. Choose
the clean design and replace affected producers, consumers, tests, and docs together.
Do not preserve unreleased schemas, APIs, artifacts, runtime minimums, or internals
through adapters, dual writes, migration code, or old-format support. Schema checks
detect mismatches; they are not a multi-version support promise. A documentation
change does not claim that the new implementation is delivered.

## Goal-driven development

- Long-term architecture belongs in `docs/core-design/`; finishable development
  outcomes belong in [`docs/goals/`](docs/goals/README.md).
- Name active goals `NNNN-short-name.md`, starting with `0001`, using the next
  unused number across both `docs/goals/` and `docs/goals/archive/`.
- Goals state the desired end state, verifiable completion evidence, material
  bounds and status. Reference core design rather than embedding another schema
  or architecture that can drift. Do not split goals by implementation layers alone.
- Use one independently assessable outcome per goal. State the observable pass
  condition, the actual artifact/command or browser observation used to assess it,
  and a failure control where relevant. A list of implementation tasks or an empty
  test run is not completion evidence. Record only material outcome prerequisites.
- A split goal is `superseded`, remains outside the completed archive, and links
  all successors. Do not keep the old umbrella goal active beside its replacements.
  The goal index owns coverage and release conjunction; it is not another executable goal.
- Once a goal is completed with recorded commit/PR and verification evidence,
  move it to `docs/goals/archive/` under the same filename and update its links.
  Never reuse its number or archive an unfinished goal as completed.
- New goal-driven development documents do not go into `docs/plans/`. Existing
  plans are historical references. Current implementation gaps and first-release
  acceptance belong in the active goals, not in the long-term architecture.

## Goal

Build a static, privacy-preserving site from a git repository of Markdown, for a user who is
not this repository's owner. Every file publishes unless the user excludes it.

**This repository is the tool, not anyone's site.** It ships no personal content, no personal
identity, and no default that names its author. A product-facing sentence that only
makes sense to this repository's owner is a defect — see
[`docs/adoption.md`](docs/adoption.md) for what another user actually does.

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
  never left the host. Under the rule that now holds, the author's full withheld-link
  label can enter the published article and its derived public text. This does not
  create a node or edge for the withheld target: the SQLite projection contains only
  published nodes and public metadata, and is downloaded lazily. It is not an inventory
  of excluded paths. The retained authored label is the accepted disclosure; the target's
  own metadata and body remain withheld. The reasoning the old rule
  rested on is in the superseded-gate notes in `tests/link-traversal.test.ts` and
  `tests/backlink-surfaces.test.ts`: a directory path is itself content (`clients/acme/`
  names a client), so reducing the target to its last segment kept every withheld
  directory name off the host. What it bought was that a reader could not learn the shape
  of the author's private tree, and that is what was spent.

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
- `src/data/content.json` is the current synthetic fixture input; never hand-edit it
  to bypass a gate. The build preserves private IR only where the build boundary
  needs it.
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
| Rendered-browser gates (Playwright) | when Chromium is installed; the preview and runtime gates fail without it | — | yes, always | — |

The last column replaces what used to say "Cloudflare Pages". `bin/anc.mjs`
runs the same generated-output chain `package.json`'s `build` names, link for link. Secret
scanning is the deliberate exception: repository `verify` and packaged `build --release` run
it, while an ordinary preview does not require an external binary. Both relationships are
gated. Cloudflare Pages is one deployment target among several and builds nothing this
repository owns; [`docs/adoption.md`](docs/adoption.md) covers hosting.

CI (`.github/workflows/verify.yml`) runs `pnpm run verify` rather than restating its steps, so
the two cannot drift; `tests/verify.test.ts` fails if a gate is ever spelled out in the
workflow instead.

The repository is hosted on GitHub. The workflow declares push and pull-request
verification; inspect the actual run rather than assuming that its presence proves CI passed.

A second workflow, `action-parity.yml`, is the one thing CI can do that
`pnpm run verify` cannot: it builds a synthetic notes repository with the shipped
composite Action on its supported runner, then re-derives the artifact from the
outside. It is adoption evidence, not another copy of this repository's gates;
`tests/action-parity.test.ts` holds it to the Action and to no secret or
deployment step. Read its run for 0007, not as a substitute for `verify`.

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
- Removing a note and rebuilding removes its route, its SQLite node row and incident
  relations (including any aliases and tags no longer used by another note), its
  feed/sitemap entry, and its Pagefind record, while retaining other notes.
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
  *split by markup* so the gate cannot degrade into a search for something narrower. The name
  is read from `package.json` and matched as a **delimited token, not a raw substring** —
  a three-letter name is a substring of ordinary English and of ordinary minified JavaScript.
  Measured at the rename over this repository's own `dist/`: the raw substring occurs in
  **67 of 143 files**, the delimited token in **0 of 143**. A hyphen counts as a delimiter, so
  `anc-build-`, `data-anc-`, and `/anc/` still fail. Two consequences worth knowing before
  touching it. **A name buried inside a longer identifier is no longer caught** — which is why
  the math and diagram substitution tokens in `src/lib/markdown.ts` were unbranded to
  `renderedMathPlaceholder` in the same change, and why a new identifier spelling this name
  must not be introduced. And a future dependency whose minifier emits `anc` as an identifier
  will read as a leak until the named file is inspected. `tests/site-identity.test.ts` carries
  both measurements.
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

The public SQLite/WASM read model has landed: the five-table
`data/site.<sha256>.sqlite` snapshot replaced the public content index, static
relationships render from it, and a lazy read-only Worker/WASM powers previews, tag
browsing, and graph exploration. [`docs/goals/archive/`](docs/goals/archive/) holds the
completed outcomes; [goal 0008](docs/goals/0008-acceptable-browser-cost.md) is still in
progress, and the older note here that the design was "not yet implemented" predates
that landing. Neither 0.1.0 nor 1.0.0 is ready. Registry publication, deployment, and
post-deploy smoke tests are separate external actions. Version 0.1 intentionally adds no
non-Markdown asset pipeline or corpus redirects. The `0.0.1` in `package.json` reserves the
`@wxxb789/anc` name; it is not a 0.1.0 candidate and records no release evidence.

## Documentation

- [`docs/core-design/README.md`](docs/core-design/README.md) — authoritative long-term
  design, superseding conflicting historical requirements and plans.
- [`docs/goals/README.md`](docs/goals/README.md) — active numbered goals and the
  completed-goal archive lifecycle.
- [`docs/adoption.md`](docs/adoption.md) — what a stranger with a notes repository does.
- [`docs/gate-reading.md`](docs/gate-reading.md) — the seven ways an instrument lies about itself.
- [`docs/public-knowledge-garden-requirements.md`](docs/public-knowledge-garden-requirements.md)
  — historical requirements retained for stable source-comment section references;
  conflicting architecture is superseded by `docs/core-design/`.
- [`docs/plans/ssg-generalisation-plan.md`](docs/plans/ssg-generalisation-plan.md) — the
  general-purpose turn, its tickets, and what its own drafting got wrong.

Astro documentation: <https://docs.astro.build>
Pagefind documentation: <https://pagefind.app/docs/>
