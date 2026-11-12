# Development goals

These are separately addressable goal payloads for ANC's accepted SQLite/WASM
initiative and the later image-publishing initiative (Issue #31). [Core design](../core-design/README.md) owns long-term architecture;
this directory owns finishable outcomes and completion evidence. No goal here
executes a runtime command merely by existing.

## Review and scope

The 2026-09-14 review keeps the accepted five-table SQLite read model, private
compiler IR, static HTML, and Pagefind. Every component has a current consumer;
no new public index, body store, graph manifest, compatibility layer, or framework
is justified. The broad 0001 had several independently assessable outcomes, so it
is superseded by seven goals rather than left active as another umbrella.

The review clarified four areas in the owning design documents: graph selection
and distinct-neighbor degree, cursor continuation without skipped rows, exact
schema validation after read-only import, and row-aware coverage for both residue
and secret scanning. The current residue scanner contains writable/FTS handling;
the current secret projection copies raw/gzip-decoded files without reconstructing
SQLite values. Those are implementation observations at the reviewed baseline,
not designs to preserve or evidence that the new release checks already work.

The reviewed baseline is `7579cc16a4320f7410b71e784587a01fdf14333d`; design
baseline PR #1 starts at `e30ca971f21b5b7ed3373c3c65f7de8526aec5ec`. On
2026-09-15 the SQLite initiative landed on local branch `feat/public-sqlite-snapshot`
(see each goal's "Implementation progress" section): a public five-table snapshot
replaces the public content index, static relationships render from it, a lazy
read-only Worker/WASM powers previews, tag browsing, and graph exploration, and
both release scanners reconstruct SQLite rows. The packaged artifact strips
producer-resolved edges (`bin/anc.mjs`); the repository artifact and fixture
corpora still carry them as the producer handoff, and at that point no goal was
archived as completed. On this host `pnpm run verify` then reported 809 passed /
34 skipped (exit 0) and `pnpm run build:fixture` 838 passed / 5 skipped
(exit 0). The historical full-suite result was 736 passed, 10 failed and 57
skipped; it is historical baseline evidence, not a current passing gate.

On 2026-09-16, [0002](archive/0002-consistent-static-relationships.md) was
completed on branch `feat/0002-consistent-static-relationships` (implementation
commit `24cea57`): the static tag surfaces now read `tags.key` and memberships
from the finalized snapshot, and the goal's completion record carries the run
evidence (`pnpm run verify` 64 files / 856 passed / 34 skipped;
`pnpm run build:fixture` 64 files / 885 passed / 5 skipped;
`pnpm run smoke:tarball` passed). [0003](archive/0003-reliable-lazy-previews.md)
was completed the same day on branch `feat/0003-reliable-lazy-previews`
(implementation commit `948696e`): every evaluation row now runs as a real
Chromium gate against a generated site under the shipped CSP, the producer
follows `content-semantics.md` for shared aliases, and the import boundary
refuses truncated bytes. [0004](archive/0004-complete-tag-browsing.md) was
completed the same day on branch `feat/0004-complete-tag-browsing`
(implementation commit `718700e`, review fixes `c119678`/`c401315`, PR #5): the canonical tag query now has
native snapshot gates for identity, a three-page enumeration, the lookahead-row
control, NOCASE exactness and the duplicate-membership refusal, and the real
Chromium gates add the failed-initialization fallback, keyboard operation,
static parity, withheld-tag absence, and one shared runtime and download for
previews and tag browsing.

On 2026-09-17, [0005](archive/0005-interactive-graph-exploration.md) was
completed on branch `feat/0005-graph-exploration-evidence` (commits `1d22934`,
`610bb5f`, `38c9467`, PR #6): the live drawing is gated against hand-written
oracles for its exact edge set with direction, table cells, language attributes
and no-match states, native/Worker selection is one full-identity comparison,
the required mutation and failure controls were re-run, SQL/Worker and render
timings are recorded separately for 0008, and CI run `35134417363` is green on
the last code commit. `pnpm run verify` reported 76 files / 916 passed /
34 skipped and `pnpm run build:fixture` 76 files / 945 passed / 5 skipped, both
exit 0. Four goals are archived; three remain active.

On 2026-09-17, [0006](archive/0006-safe-release-output.md) was completed on
branch `feat/0006-safe-release-output`: release qualification, failed-build
preservation, and concurrent-build isolation gained their own end-to-end gates,
both scanners gained a reconstructed-row overflow control, and inventory and
preview now refuse a WAL header or journal sidecar before opening the artifact
(measured: a `-wal` sibling had made the read-only open write a generated
`-shm` into the inspected directory). `pnpm run verify` reported 77 files /
934 passed / 34 skipped and `pnpm run build:fixture` 54 built pages with the
full record in the file. Five goals are archived; two remain active.

On 2026-09-18, [0007](archive/0007-independent-publisher-adoption.md) was
completed on branch `feat/0007-independent-publisher-adoption`, PR #10. The
shipped Action was exercised against a synthetic notes repository on
`ubuntu-latest` (CI run `35253591383`), the tarball smoke gained a real-Chromium
phase over the foreign build and the shipped `preview` command, the served host
policy and the vanished-snapshot fallback gained their own gates, and two CI
release-test failures traced to Pagefind's `writeFiles` resolving before its
members were on disk were fixed in `scripts/run-pagefind.ts`. CI verify run
`35253591403` is green on the last code commit. Six goals are archived; one
remains active.

On 2026-11-09, [0009](archive/0009-zero-config-static-images.md) was completed
on branch `feat/0009-zero-config-static-images` (implementation left uncommitted
for the orchestrator to land; the file records branch, files, commands and real
counts). The packaged producer now publishes only the images a published note
references: PNG/JPEG/GIF/WebP/AVIF bytes are copied unchanged to
`/_assets/<sha256>-<name>` and deduplicated by content, reference resolution is
note-relative then content-root with no basename fallback, and a missing,
excluded, escaping, SVG, or otherwise unsupported local image fails the build
rather than shipping a broken picture. The coalesced gates are the exact output
inventory over the emitted bytes, the extended column of residue/secret scans,
a real-Chromium JavaScript-disabled display gate, and a packaged foreign-repository
smoke. Seven goals are archived and 0008 remains active; 0010–0013 were still
`Ready` at that point.

On 2026-11-09, [0010](archive/0010-readable-image-figures.md) was completed on
branch `feat/0010-readable-image-figures` (implementation left uncommitted for
the orchestrator; the file records branch, files, commands and real counts).
Standalone block images with an authored Markdown title now render as semantic
`figure`/`figcaption` with the title as the visible caption and `alt` still the
accessible alternative; alt-only, decorative, inline and link-wrapped images
keep their existing shape. The producer reads intrinsic PNG/JPEG/GIF/WebP/AVIF
dimensions from the authorized emitted bytes and the renderer emits
`width`/`height`, with the lead image eager and later images lazy and
asynchronously decoded. The gates extend to real Chromium observations of
caption presence and absence, header-matching dimensions, script-free decoding,
narrow-viewport overflow and reserved layout space. Eight goals are archived and
0008 remains active; 0011–0013 were still `Ready` at that point.

On 2026-11-09, [0011](archive/0011-webp-first-image-delivery.md) was completed
on branch `feat/0011-webp-first-image-delivery`, created off `origin/main` at
`f167750`; the implementation commit is `7d2540d`, with the review round
uncommitted for the orchestrator and the file recording files, commands and real
counts. Referenced JPEG photographs now publish lossy WebP and 8-bit PNG
screenshots/diagrams/alpha graphics lossless WebP, each only when the emitted
candidate is smaller; 16-bit PNG, existing WebP/AVIF, and every animation publish
unchanged. A structural completeness gate refuses truncated containers before
decoding. The encoder is pinned `sharp` 0.35.5 at the producer's existing
authorization point, public identity is the SHA-256 of the emitted bytes, orientation
is applied before metadata removal, and finite pixel/byte/deadline limits fail
hostile input boundedly while preserving the previous output. Nine goals are
archived and 0008 remains active; 0012–0013 are still `Ready` and untouched.

On 2026-11-10, [0012](archive/0012-safe-svg-rasterization.md) was completed on
branch `feat/0012-safe-svg-rasterization`, created off `origin/main` at
`7d27414`, merged as PR #36 (`8b49d38`). Implementation commit `e32c75b`, then
seven review-fix commits closing fourteen findings across eight review rounds;
the final review reported no findings. A self-contained static SVG is validated
by a namespace-aware XML walk and a CSS AST, rasterized in memory by the same
pinned `sharp` 0.35.5, and published as lossless WebP with a transparent
background, so no SVG source byte reaches the site, the search index or the
snapshot. The completion record carries the measured evidence: 39 hostile
fixtures that fail the packaged build with distinct reasons and leave the
previous output byte-identical, 17 benign fixtures rendered in real Chromium at
1× and 2×, a `file://` canary and a listening socket proving no file disclosure
or network request, the `<use>`-expansion and filter-region budgets, host-font
discovery through fontconfig's own search semantics, and the cost figures.
On 2026-11-10, [0012](archive/0012-safe-svg-rasterization.md) and
[0013](archive/0013-optional-managed-image-hosting.md) completed and shipped in `0.0.3`. On
2026-11-11, [0008](archive/0008-acceptable-browser-cost.md) completed on the maintainer's
dated acceptance, after this record's pre-SQLite comparison was corrected: the recorded
warm-preview difference was two instruments' clocks, not a product regression. Eleven goals
are archived and none is active.

This goal set covers the accepted query-model initiative and its first-release
acceptance. It is not a rewrite of every historical requirement or a promise that
unrelated product requirements are complete. SQLite/WASM remains required for
0.1.0. Neither 0.1.0 nor 1.0.0 readiness is claimed here.

## Active goals

`Ready` means the completion contract is specified, not that prerequisites are
already delivered. The prerequisite column states material outcome dependencies,
not a mandatory execution schedule. Numbers are stable identifiers.

No goal is active as of 2026-11-11. 0008 completed on that date and is recorded under
[Completed goals](#completed-goals); no successor has been opened, and 0.1.0 has no scope
document yet.

## Image publishing goals — Issue #31 (2026-11-08)

The [accepted target media design](../core-design/media-pipeline.md) selects one
sharp-based image engine for 0011/0012, a fail-closed SVG/XML/CSS
resource boundary, and an opt-in R2 publishing contract for 0013. Dependency selection and security architecture belong there,
not in an implementer's interpretation of a goal prompt.

The user's agreed priority is **correct local-image display through the existing
GitHub Pages and Cloudflare Pages static hosting paths first**, with no new CDN
account or image-specific setup. ANC builds and ships static bytes; it does not
need a provider SDK merely to use a static host's CDN. Image presentation shipped
in 0010; WebP optimization, SVG rasterization and optional managed hosting remained
subsequent, separately assessable outcomes. Goal 0008 continued independently; its browser
cost acceptance was not a prerequisite for 0009 and completed on 2026-11-11.

| Goal | Status | Single completion judgment | Material prerequisites |
| --- | --- | --- | --- |
| [0012 — Safe SVG rasterization](archive/0012-safe-svg-rasterization.md) | Completed 2026-11-10 | Self-contained static local SVG becomes safe WebP via the selected sharp renderer and XML/CSS policy, with measured font, quality and resource evidence | 0009 and 0011 (completed) |
| [0013 — Optional R2 media publishing](archive/0013-optional-managed-image-hosting.md) | Completed 2026-11-10, shipped in 0.0.3 | A deliberate R2 release mode uploads approved images and verifies CDN availability without changing same-origin defaults | 0009 and 0011 (completed); live R2/custom-domain round trip is a disclosed, unverified gap |

`Ready` here means a downstream agent can pursue the stated outcome once its
prerequisite is accepted; it does **not** mean implemented, deployed or approved
as a release. `Provisional` goals preserve accepted direction but require
refinement before activation. 0009–0013 are completed and shipped in `0.0.3`;
0013's live R2/custom-domain round trip remains a disclosed gap, recorded in its
completion record rather than claimed as tested.

**Scope boundary.** Current ANC deployment supports root-of-origin sites, not a
GitHub Pages project site's `/<repo>/` prefix. Extending site-wide base-path
support is a separate potential outcome, not an unmentioned obligation of 0009.
Media RFC #31 also proposes external-link behavior, numbered captions,
references sections and wide-table accessibility. This initiative does not
silently commit those still-unresolved proposals; such choices can be evaluated
as separate future goals. 0009 reconciled the accepted core design's former
no-asset-pipeline stance and 0010 added the caption/layout reading rules; the
owning media design, content semantics, architecture index, `AGENTS.md`, and
adoption docs now describe the 0009–0011 implemented contracts rather than a target.

## Completed goals

| Goal | Completed | Record |
| --- | --- | --- |
| [0002 — Consistent static relationships](archive/0002-consistent-static-relationships.md) | 2026-09-16 | Implementation commit `24cea57`; the actual no-JS site and one reproducible SQLite snapshot agree on published relationships, with static tag surfaces read from the snapshot's own rows. |
| [0003 — Reliable lazy previews](archive/0003-reliable-lazy-previews.md) | 2026-09-16 | Implementation commit `948696e`; all six evaluation rows executed as real Chromium gates against generated sites under the served CSP, with the read-only, failure/retry, race, and provisional-limit controls recorded in the file. |
| [0004 — Complete tag browsing](archive/0004-complete-tag-browsing.md) | 2026-09-16 | Implementation commit `718700e`, review fixes `c119678`/`c401315`, PR #5; the reader's tag chooser and the static tag route enumerate one snapshot's membership across pages, with the lookahead-row control, NOCASE exactness, failed-initialization fallback, keyboard operation, withheld-tag absence, and shared-runtime measurements recorded in the file. |
| [0005 — Interactive graph exploration](archive/0005-interactive-graph-exploration.md) | 2026-09-17 | Implementation commits `1d22934`, `610bb5f`, `38c9467`, PR #6; the live graph and its accessible representation agree on the bounded induced subgraph over a 65-note browser corpus, complete relations stay reachable beyond the drawing, the required mutation and failure controls were re-run, and SQL/Worker and render timings are recorded separately for 0008 — all in the file. |
| [0006 — Safe release output](archive/0006-safe-release-output.md) | 2026-09-17 | Implementation commit `3e65a12`, PR #8, CI run `35231482566`; the reviewed-set failures, exact-output refusals, reconstructed-row scanner controls, withdrawal-after-rebuild, whole-tree failed-build preservation, and concurrent-build binding isolation are recorded in the file. |
| [0007 — Independent publisher adoption](archive/0007-independent-publisher-adoption.md) | 2026-09-18 | Implementation commits `2c9772e`, `33aa0ae`, `12ff781`, `ebd02f9`, `c159802`, `65f89d4`, PR #10; local `pnpm run verify` and CI run `35253591403` (80 files / 952 passed / 34 skipped) green on `65f89d4`, Action-parity CI run `35253591383` green with the shallow-clone refusal, and the recorded `pack:tarball` digest plus `smoke:tarball` result — all six evaluation rows in the file. |
| [0008 — Acceptable browser cost](archive/0008-acceptable-browser-cost.md) | 2026-11-11 | The packaged `0.0.3` meets the inherited warm-target (worst case 21.7 ms p95) and the qualified 10,000-note campaign; the pre-SQLite comparison is recorded on one clock (warm at parity, cold 226-244 ms faster, 2.8x first-preview bytes), the maintainer's dated acceptance names the candidate, the trade and the evidence limits, and no preview-regression goal was opened — all in the file. Its 2026-11-12 addendum closes the two costs it left open (windowed tag list, bounded global graph) with the merged measurements. |
| [0009 — Zero-config static images](archive/0009-zero-config-static-images.md) | 2026-11-09 | Branch `feat/0009-zero-config-static-images`, production commit `be6b6cf`, implementation uncommitted for landing; the packaged producer publishes only referenced, authorized raster bytes under `/_assets/<sha256>-<name>`, the exact inventory owns the namespace, and each "Done when" row carries its executed evidence in the file — including a JavaScript-disabled Chromium display gate and a packaged foreign-repository smoke with images. |
| [0010 — Readable image figures](archive/0010-readable-image-figures.md) | 2026-11-09 | Branch `feat/0010-readable-image-figures`, created off `origin/main` at `69f0f85`; implementation uncommitted for landing. The completion record maps each “Done when” row to its executed evidence, including packaged-build Chromium measurements for figures, dimensions, lazy/eager loading, no-script decoding, narrow-width overflow and reserved layout space. |
| [0011 — WebP-first image delivery](archive/0011-webp-first-image-delivery.md) | 2026-11-09 | Branch `feat/0011-webp-first-image-delivery`, base `f167750`, implementation commit `7d2540d` with the review round uncommitted for landing; the file records the packaged foreign-repository smoke, the emitter's final-byte identity and dedupe, the pre-decode completeness gate for every supported container, bounded hostile-input preservation, and a twice-run baseline-vs-optimized corpus measurement on Linux x64 — including the rows where WebP wins and where bytes are retained. |
| [0012 — Safe SVG rasterization](archive/0012-safe-svg-rasterization.md) | 2026-11-10 | A self-contained static local SVG becomes safe WebP through the pinned sharp renderer behind a fail-closed XML/CSS/resource boundary, with the hostile-fixture refusals, font-coverage refusal, quality limits and cost figures recorded in the file; merged as PR #36. |
| [0013 — Optional managed image hosting](archive/0013-optional-managed-image-hosting.md) | 2026-11-10 | A deliberate R2 release mode uploads only approved image bytes and verifies CDN availability without changing same-origin defaults; the live R2/custom-domain round trip stays a disclosed, unverified gap in the file. Shipped in `0.0.3`. |
| [0012 — Safe SVG rasterization](archive/0012-safe-svg-rasterization.md) | 2026-11-10 | Branch `feat/0012-safe-svg-rasterization`, base `7d27414`, implementation commit `e32c75b` plus seven review-fix commits (`36d3b34`…`587c7a0`), PR #36 merged as `8b49d38`; the file records 39 hostile fixtures with distinct refusal reasons and byte-identical previous output, 17 benign fixtures rendered in real Chromium at 1×/2×, the `file://` canary and listening-socket probes, the `<use>`-expansion and filter-region budgets, fontconfig-faithful font discovery, and the measured cost — with Linux x64 as the only claimed platform. |

One SQLite goal remains `in progress`, and one media goal remains `Ready`.
Schema creation, query-module code,
Worker setup and individual test files are means within these outcomes, not
separate goals. Functional completion and measured mobile acceptance remain
separate judgments, with no circular dependency on final performance budgets.

## Coverage and evidence ownership

This table checks that splitting 0001 loses nothing. Cross-goal comparisons are
integration evidence; they do not create competing schema or test implementations.

| Original commitment / core invariant | Owning goal |
| --- | --- |
| Published node/link/tag/alias semantics; exact schema; deterministic fresh snapshots | 0002 |
| Static backlinks/outgoing/tag routes, related suggestions, induced graph fallback | 0002 |
| Private IR boundary; removal of serialized relation authorities and public JSON indexes | 0002; final output rejection in 0006 |
| Exact DB URL/digest binding | Build output in 0002; browser validation in 0003; host/package validation in [0007](archive/0007-independent-publisher-adoption.md) (completed) |
| Lazy shared Worker, real read-only WASM, CSP, retry, stale preview suppression | 0003 (completed); cross-consumer evidence in [0004](archive/0004-complete-tag-browsing.md) (completed) and [0005](archive/0005-interactive-graph-exploration.md) (completed) |
| Canonical runtime tag lookup and exhaustive pagination | 0004 (completed) |
| Local/global/tag-filtered graph, ranking, re-centering, complete relation enumeration | [0005](archive/0005-interactive-graph-exploration.md) (completed) |
| Publication ledger, binary-aware residue/secrets, output inventory, withdrawal and failed-build preservation | 0006 (completed) |
| CLI preview recognition, tarball adoption, runtime minimum, JS/WASM provenance, GitHub Action | Recognition protection in 0006 (completed); foreign installation/transport in [0007](archive/0007-independent-publisher-adoption.md) (completed) |
| Snapshot caching, stale-page fallback, no substitution of a newer DB | [0007](archive/0007-independent-publisher-adoption.md) (completed) |
| 100/1,000/10,000-note measurements, Chrome-family mobile-emulation p95, cold preview, memory and finite policies | 0008 |
| No backward compatibility; no body/FTS/manifest; evidence-based ablation | Every goal, governed by core design |

## Reading completion evidence

Each file contains the desired state, material bounds, actual evaluation methods,
observable pass conditions and a completion record. There are no new invented
latency budgets or claims that a document itself implements a feature.

For each completion record:

- Record implementation commit/PR, exact commands, actual test counts, fixture
  identity and relevant artifact/observation links. New tests must use the existing
  verification entry point where applicable. Future test names are not fabricated
  in these goal files; record the real runnable command when the check exists.
- Evaluate the actual produced output and user flow. Native SQL success cannot
  stand in for browser WASM success. A test over hand-authored HTML cannot stand
  in for the generated site. A skipped or empty test run is unresolved evidence.
- Use an independent authored oracle for semantic checks. A failure control must
  reach the property it claims to exercise. See [gate reading](../gate-reading.md).
- Report all relevant failures. A regression within this goal blocks completion.
  A genuinely independent baseline failure or unfinished successor must be named
  and cannot be reported as passed or silently hidden by weakening a gate.
- Completion is not release authorization. Keep applicable gates active throughout
  the replacement; there is no promise that a partially completed goal set is a
  releasable product, and no compatibility outputs to disguise missing successors.

For this initiative to qualify for the first release, all seven outcomes must hold
on one integrated candidate. Require `pnpm run verify`, `pnpm run build:fixture`,
and `pnpm run smoke:tarball`, real browser/Action evidence, and 0008's accepted
measurements. Record the candidate commit and tarball/DB identities. Evidence from
ancestor commits remains usable only for behavior unchanged in the candidate;
rerun checks affected by later changes. Skipped required checks and the historical
10 failures cannot be carried forward as a passing release result.

This conjunction belongs here as an acceptance rule, not in another goal whose
only outcome is to mark the other goals completed. Registry publication, site
hosting and post-deployment checks remain separately scoped external actions.

## Naming and lifecycle

- Active goal filenames are unique increasing `NNNN-short-name.md` numbers. Check
  active and archive directories before choosing the next number; never reuse one.
- A goal starts `ready` (or `provisional` while its outcome contract still needs
  refinement), becomes `in progress` when executed, and becomes `completed`
  only when its own evidence and stated acceptance authority are satisfied.
  Refine a provisional goal to ready before activation.
- Move a completed goal, with date/commit/PR/results and material limitations, to
  `docs/goals/archive/` under the same filename. Update incoming links and relative
  links inside it. Do not move an unfinished goal into the completed archive.
- A superseded or abandoned goal records its decision and successors outside that
  archive. Keep it out of the active table and do not retain duplicate obligations.
- Goals reference core design. Changing architecture requires updating its owning
  document and the affected validation, not silently changing a goal's wording.
- Do not create new goal-driven development documents in historical `docs/plans/`.

## Superseded goals

[0001 — Unified public query model](0001-unified-public-query-model.md) was split
on 2026-09-14 into 0002–0008 without declaring completion. Its number is retained.

[0002](archive/0002-consistent-static-relationships.md),
[0003](archive/0003-reliable-lazy-previews.md) and
[0004](archive/0004-complete-tag-browsing.md) were completed and moved into the
[archive](archive/README.md) on 2026-09-16,
[0005](archive/0005-interactive-graph-exploration.md) and
[0006](archive/0006-safe-release-output.md) on 2026-09-17,
[0007](archive/0007-independent-publisher-adoption.md) on 2026-09-18,
[0009](archive/0009-zero-config-static-images.md) and
[0010](archive/0010-readable-image-figures.md) on 2026-11-09, and
[0011](archive/0011-webp-first-image-delivery.md) on 2026-11-09,
[0012](archive/0012-safe-svg-rasterization.md) and
[0013](archive/0013-optional-managed-image-hosting.md) on 2026-11-10, and
[0008](archive/0008-acceptable-browser-cost.md) on 2026-11-11. No goal is active and no
number has been reused.
