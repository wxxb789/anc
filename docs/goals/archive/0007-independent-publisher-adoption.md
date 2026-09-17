# 0007 — Independent publisher adoption

Status: completed 2026-09-18. Created: 2026-09-14. Replaces part of
[0001](../0001-unified-public-query-model.md).

## Desired outcome

Someone outside this repository can install ANC's tarball, initialize and review
their own Markdown repository, create a qualified static build, preview it, and
use its SQLite-powered features. This works without the ANC source checkout,
undeclared development dependencies, personal fixture data or a runtime CDN.
The shipped GitHub Action produces the same kind of qualified artifact.

## Material bounds and prerequisites

Requires the functional outcomes [0002](0002-consistent-static-relationships.md),
[0003](0003-reliable-lazy-previews.md),
[0004](0004-complete-tag-browsing.md),
[0005](0005-interactive-graph-exploration.md), and the release protection in
[0006](0006-safe-release-output.md). Packaging must not declare those features
delivered when they work only in repository development mode.

Follow [technology/ownership](../../core-design/architecture.md),
[snapshot/preview binding](../../core-design/build-and-runtime.md), and
[adoption documentation](../../adoption.md). Keep the chosen Node/toolchain requirement
consistent in engines, CLI, CI, Action and docs; prove the actual native SQLite APIs
on that runtime. Do not retain a lower historical minimum via a fallback driver.

Required Worker/JS/WASM ship with the package and generated output, with provenance,
correct URLs, MIME and hosting CSP/cache configuration. Preview remains loopback
and path-contained. A build needs no database service, cross-origin isolation or
credentials at browser runtime. Publishing to npm, merging or deploying the site
is not part of this local adoption goal.

## Completion evidence

Run `pnpm run pack:tarball` and `pnpm run smoke:tarball`. The smoke path must exercise
the current SQLite contract, not merely keep an old JSON assertion green. Record
the exact tarball digest, runtime/package-manager versions and test commands.

| Evaluation | Pass condition |
| --- | --- |
| Foreign repository | Install the tarball into a fresh synthetic git repository, outside the producer checkout's module ancestry. The shipped init/review/build/preview path produces that repository's notes, private report and exact reviewed public set. |
| Self-contained package | Compilation/install succeeds without borrowed dev packages or uncompiled package TypeScript. Required native API and WASM work on the declared runtime. No author's notes, public fixture index, build machine path or personal identity leaks into the site. |
| Real browser | Serve the resulting foreign build under the intended headers. Preview, tag enumeration and graph exploration work using only its own bound JS/WASM/DB; initial reading remains lazy and static fallback works when SQLite assets fail. |
| Recognition and transport | CLI preview accepts the correct completed output, rejects bad/multiple/missing DBs and path escape, and remains loopback. Worker/WASM have correct MIME; digest mismatch and stale-page/missing-snapshot scenarios fall back without substituting a different DB. |
| Host snapshot policy | Generated host configuration and an HTTP harness demonstrate immutable caching only for hashed assets, revalidation for HTML/stable assets, and actual CSP enforcement. Pagefind stable metadata is not made immutable wholesale. |
| Action parity | Exercise the shipped Action against a synthetic notes repository on its supported runner. It uses the chosen runtime, same publication gates and packaged assets; no separate weaker build chain or automatic deployment is introduced. A documentation-only inspection is not this run. |

Record whether each environment ran locally, in CI, or on another named supported
host. Do not claim an unexecuted platform matrix. A missing supported-runner or
browser run is unresolved evidence, not a reason to claim this goal completed.
Final mobile cost remains owned by 0008; this goal establishes usable distribution.

## Implementation progress (2026-09-15)

Branch `feat/public-sqlite-snapshot` (local; no remote PR). Commits, oldest first:
`56d52b4` public SQLite projection and static relationships from it, `4c08dff`
lazy read-only Worker powering previews, `f373b94` reconstructed-row scanning in
both release scanners, `9630622` reader-facing tag browsing, `d28728f` one graph
selection/layout authority, `7281ff6` interactive graph exploration.

Commands and observed results:

- `pnpm run verify` — 56 test files passed, **809 passed / 34 skipped**, exit 0.
- `pnpm run build:fixture` — 56 files, **838 passed / 5 skipped**, secret scan
  `227 files, 0 findings`, residue `33 files, 0 findings`, exit 0.
- `pnpm run smoke:tarball` — `tarball adoption smoke ok: 1 published note, 2
  withheld notes`; tarball `anc-0.1.0.tgz`, sha256
  `17b7128c4b3f80c73d1cfdeb410de2d6b7019161fa4f847382e6d24839aecb1b`.
- Published-corpus artifact identities: `dist/data/site.9fc2794f…sqlite`
  (40,960 bytes, digest in the filename), `dist/wasm/sqlite3.2ee8f3da…wasm`
  (868,907 bytes), pinned `@sqlite.org/sqlite-wasm@3.53.4-build1`.
- Browser gates (real Chromium under the `public/_headers` CSP):
  `tests/snapshot-runtime.test.ts`, `tests/tag-browser.test.ts`,
  `tests/graph-runtime.test.ts`; read-only/WASM `tests/snapshot-wasm.test.ts`;
  schema `tests/snapshot.test.ts` and `tests/snapshot-contract.test.ts`;
  selection `tests/graph-selection.test.ts`; scanners
  `tests/secret-scan-database.test.ts` and `tests/snapshot-rows.test.ts`.

Nothing below is archived as completed, and no successor is claimed complete by
this note.

Remaining gaps found while implementing: `smoke:tarball` ran locally only; the
shipped GitHub Action has not been run on its supported runner here, so Action
parity is unresolved evidence. Registry publication and deployment remain
external and separately approved.

## Implementation progress (2026-09-18)

Branch `feat/0007-independent-publisher-adoption`, PR #10. The 2026-09-15
implementation was already an ancestor of `main`; this branch closed the
unresolved evidence and the adoption-path gates.

- `.github/workflows/action-parity.yml` exercises the shipped composite Action
  on `ubuntu-latest` against a synthetic notes repository: the workspace root is
  the notes repository, the generator is checked out under `generator/`, and the
  build step is `uses: ./generator` and nothing else. A second job proves the
  Action refuses a shallow clone. `.github/scripts/action-parity-fixture.mjs`
  writes the corpus and commits the reviewed ledger; `.github/scripts/assert-action-artifact.mjs`
  re-derives the reviewed set, the snapshot digest binding, the runtime assets,
  the private report, and withheld-body absence from the artifact.
  `tests/action-parity.test.ts` holds the workflow to the Action, the read-only
  token, the supported runner, and the absence of a weaker build chain.
- `scripts/smoke-tarball.ts` now serves the tarball-built foreign `dist/` under
  its own generated `_headers` and drives lazy reading, preview, tag
  enumeration, graph exploration, and static fallback in Chromium, then starts
  the shipped `preview` subcommand on the foreign output and fetches the note
  and `/private/`. Chromium absence fails the smoke rather than skipping.
- `tests/host-snapshot-policy.test.ts` exercises real HTTP revalidation
  (200/304 with ETag), proves only `/_astro/*` is immutable, checks Pagefind's
  stable-named members, and checks the runtime MIME types. The shared harness
  gained the host's documented revalidating default and conditional-request
  handling (`tests/support/browser-site.ts`).
- `tests/preview-lifecycle.test.ts` adds the vanished-snapshot scenario: a
  cached page whose bound snapshot is gone falls back to static reading,
  requests only its own binding, and never requests the replacement.
- **A production defect was found and fixed while closing this.** Two CI runs
  failed in untouched release tests: `secret scan could not inflate one output
  member` (run `35250672080`) and a whole-tree byte-stability mismatch between
  two builds of one corpus (run `35251874609`). Both traced to Pagefind's
  `writeFiles` promise resolving before its writes were on disk, with `close()`
  able to abandon an in-flight member; the existing manifest poll covered one
  member of many. `scripts/run-pagefind.ts` now authors the indexer's
  `getFiles()` bundle synchronously and only returns when every member is
  closed. `tests/pagefind-bundle.test.ts` proves nested coverage, repair of a
  partial member, and a complete decodable bundle from the real
  `indexWithPagefind`.

## Completion record

Completed 2026-09-18. Implementation commits, oldest first: `2c9772e` Action
parity, `33aa0ae` host snapshot policy and vanished-snapshot fallback,
`12ff781` foreign browser and preview smoke, `ebd02f9` `AGENTS.md`,
`c159802` Action-parity reviewed-ledger fix, `65f89d4` Pagefind bundle
authorship. Branch `feat/0007-independent-publisher-adoption`, PR #10. CI verify
run `35253591403` and Action-parity run `35253591383` are green on `65f89d4`,
the last commit whose behavior those runs cover; the commits after it are a
two-line comment clarification, this archive move, and index edits. An
intermediate commit (`04ad69d`) accidentally carried only the goal-file rename
with the old relative links; CI's Markdown-link gate correctly failed it, and
this docs completion commit fixes the links — no product behavior was involved.

### Commands and observed results

- Local `pnpm run verify` (Node v22.23.2, pnpm 11.18.0, Linux x64) —
  PENDING-LOCAL-VERIFY, exit 0, with the build chain reporting
  `output inventory ok: 150 files`, `secret scan ok: 150 files, 0 findings`,
  `residue scan ok: 33 files, 0 findings`.
- CI `pnpm run verify` (`ubuntu-24.04`, Node from `.nvmrc` 24.18.1) — **80 test
  files, 952 passed / 34 skipped / 986**, exit 0; same 150-file inventory and
  clean scans. Run `35253591403`.
- `pnpm run pack:tarball` — `anc-0.1.0.tgz`, sha256
  `1025e0a54bd24fd864ab7d12ceefb90a0e59df8d8e962897f5baba659acedf7f`,
  393,306 bytes.
- `pnpm run smoke:tarball` — PENDING-SMOKE. The run installs the tarball with
  npm into a fresh synthetic git repository outside the producer's module
  ancestry, runs the installed `init`/`review`/`build --release`, serves the
  foreign output under its own `dist/_headers`, drives the five browser checks,
  and fetches the note and `/private/` from the installed `preview`
  subcommand.
- Action parity (CI, `ubuntu-latest`) — run `35253591383`. `foreign-notes`
  built `284 discovered, 2 published, 282 dropped` with `secret scan ok: 154
  files, 0 findings`, `residue scan ok: 37 files, 0 findings`, `site written`,
  and `action-parity artifact ok`; `shallow-clone-refusal` exited 1 as
  required.
- Tarball artifact identity unchanged by this branch's production change to the
  pagefind writer except for the tarball digest above; the published-corpus
  `dist/data/site.9fc2794fe518c3d39e30b107fa1b75a5805bff119bac536b0cfc745b6405634d.sqlite`
  (40,960 bytes) and
  `dist/wasm/sqlite3.2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752.wasm`
  (868,907 bytes, pinned `@sqlite.org/sqlite-wasm@3.53.4-build1`) are unchanged.

### Evidence by evaluation

| Evaluation | Gate | Expected vs observed |
| --- | --- | --- |
| Foreign repository | `pnpm run smoke:tarball` (local); Action-parity `foreign-notes` (CI) | Tarball installed by npm into a fresh git repository outside the checkout; `init` wrote the config, `review` recorded `2 notes`, the committed ledger produced `build --release` with `2 published`, the private report carried both exclusion kinds, and the installed `preview --port 0` served `/notes/welcome/` and `/private/` 200. In CI the Action produced the same artifact kind for a different synthetic corpus (2 published, 282 dropped generated from the 284-file tree). |
| Self-contained package | `tests/packaging.test.ts`, smoke residue/absence checks, `tests/site-identity.test.ts`, CI Action job | The tarball carries compiled JavaScript with no `.ts`, `.map`, or `.d.ts`, declares its dependencies, and contains none of this repository's content; the numbered `.github/scripts` files are not packed. The foreign site contains neither withheld marker, raw or gzip-inflated. |
| Real browser | Smoke browser phase over the tarball-built foreign `dist`; `pnpm run verify` browser suite | Under the foreign build's own generated CSP and cache rules: zero SQLite asset requests on load and scroll; preview panel carried the second note's snapshot title and body marker through the artifact's own Worker/WASM/DB; the tag chooser enumerated both published titles; the local graph drew centre plus neighbour with the merged edge, a two-row accessible table, and live re-center controls; aborting `/data/site.*` left the panel hidden and the article and anchor intact. |
| Recognition and transport | Smoke `preview` phase; `tests/preview-server.test.ts`, `tests/preview-snapshot.test.ts`, `tests/preview-integrity.test.ts`, `tests/host-snapshot-policy.test.ts`, `tests/preview-lifecycle.test.ts` | The installed binary accepts the completed foreign output and serves it on loopback; the existing gates reject bad, wrong-digest, wrong-format, unreadable, multiple, missing, WAL/sidecar candidates and refuse path escape and foreign `Host`; Worker chunk `text/javascript`, WASM `application/wasm`, snapshot `application/octet-stream`; digest mismatch falls back and retries; a cached page whose snapshot vanished requests only its own binding (404) and never the replacement. |
| Host snapshot policy | `tests/host-snapshot-policy.test.ts`, `tests/deployment.test.ts`, `tests/preview-limits.test.ts` | HTTP: unconditional 200 with the revalidating default and a validator, matching conditional 304 with empty body, stale validator returns the bytes, no HTML/Pagefind/DB response is immutable, only `/_astro/*` is, and the validator changes when the file changes. `preview-limits` proves actual CSP enforcement with an injected inline script and records no runtime violation. The harness models the host's documented default rather than running Cloudflare Pages, and the MIME assertions are the host's documented extension mappings; real consumption is gated in the browser suite. |
| Action parity | `.github/workflows/action-parity.yml`, `.github/scripts/assert-action-artifact.mjs`, `tests/action-parity.test.ts`; CI run `35253591383` | On `ubuntu-latest` the shipped composite Action built a synthetic notes repository through `uses: ./generator` only, after a committed reviewed ledger; the external check re-derived exactly the reviewed set, the snapshot filename digest, the runtime assets, both report exclusions, and withheld-body absence. The shallow-clone refusal job failed as required. The workflow installs no toolchain itself, so the Action's own Node check, pinned pnpm install, checksum-pinned scanner, and `build --release` are the exercised path. No deployment step and no secret. |

### Controls (mutation and ablation evidence)

| Control | Observed |
| --- | --- |
| Action artifact check, planted withheld marker in a published page | Local run failed with `... carries PARITY-PRIVATE-BODY-MUST-NOT-SHIP`, exit 1 |
| Action artifact check, snapshot renamed to a forged digest | Local run failed with `the snapshot filename is not the digest of its bytes`, exit 1 |
| Action artifact check, empty workspace | Local run reported the missing ledger, routes, assets, and report and exited 1 |
| Shallow clone through the Action (CI) | `shallow-clone-refusal` job green because the guarded step's outcome was `failure` |
| Replace the worked example's reviewed ledger | `tests/publish-set-cli.test.ts` refuses added and removed slugs; the Action workflow's fixture ledger is exact and the release gate compares it |
| Validator mutation | `tests/host-snapshot-policy.test.ts` appends bytes, sees a new ETag, and the old validator stops revalidating |
| CSP inline-script control | `tests/preview-limits.test.ts` observes the script not executing and a `script-src` violation event under the served policy |
| Vanished snapshot | `tests/preview-lifecycle.test.ts` records exactly one `/data/site.` request, to the page's own digest, and no request naming the replacement |
| Pagefind partial member | `tests/pagefind-bundle.test.ts` writes a truncated member and proves the authored bytes replace it; the real `indexWithPagefind` path is proven to leave every gzip member decodable |
| Pagefind write completeness in CI | The same commit family failed before the fix (`35250672080`, `35251874609`) and passed after it (`35253591403`) |

### Carried limitations and explicit non-claims

- Local runs were on Linux x64, Node v22.23.2, pnpm 11.18.0; CI ran
  `ubuntu-24.04` with the `.nvmrc` Node 24.18.1. No Windows or macOS browser
  run is claimed, and no other supported-runner matrix was executed.
- The host-policy tests exercise a harness that models the host's documented
  revalidating default and extension MIME mappings, not Cloudflare Pages
  itself; actual CSP enforcement is exercised in Chromium under that harness.
- `smoke:tarball` requires npm registry access and an installed Chromium; it
  fails rather than skipping when Chromium is missing and is not part of
  `pnpm run verify`.
- The Action-parity workflow commits the reviewed ledger from its fixture
  because `anc review` imports the generator's dependencies, which nothing has
  installed before the Action step; the real `init`/`review` path is exercised
  by `smoke:tarball` against an npm install, and the release gate's exact-set
  comparison is exercised by both.
- The Pagefind authorship change was validated by byte-equality probes against
  `writeFiles` output on this host and by the before/after CI runs; no claim is
  made about Pagefind versions outside the pinned `^1.4.0` range's installed
  `1.5.2`.
- Completion is not release authorization. Registry publication, deployment,
  and post-deploy smoke tests remain external and separately approved, and
  [0008](../0008-acceptable-browser-cost.md) remains active for mobile cost.
