# Development goals

These are separately addressable goal payloads for ANC's accepted SQLite/WASM
initiative. [Core design](../core-design/README.md) owns long-term architecture;
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

This goal set covers the accepted query-model initiative and its first-release
acceptance. It is not a rewrite of every historical requirement or a promise that
unrelated product requirements are complete. SQLite/WASM remains required for
0.1.0. Neither 0.1.0 nor 1.0.0 readiness is claimed here.

## Active goals

`Ready` means the completion contract is specified, not that prerequisites are
already delivered. The prerequisite column states material outcome dependencies,
not a mandatory execution schedule. Numbers are stable identifiers.

| Goal | Single completion judgment | Material prerequisites |
| --- | --- | --- |
| [0006 — Safe release output](0006-safe-release-output.md) | Publication gates reject incomplete, inconsistent or disallowed output without damaging the previous build | 0002 (completed); 0003 (completed) assets for Worker/WASM inventory checks |
| [0007 — Independent publisher adoption](0007-independent-publisher-adoption.md) | The shipped package and Action work in a foreign notes repository | 0002–0006 |
| [0008 — Acceptable browser cost](0008-acceptable-browser-cost.md) | Measured packaged behavior meets the mobile target and accepted cold-preview/resource policies | 0007, including its functional prerequisites |

## Completed goals

| Goal | Completed | Record |
| --- | --- | --- |
| [0002 — Consistent static relationships](archive/0002-consistent-static-relationships.md) | 2026-09-16 | Implementation commit `24cea57`; the actual no-JS site and one reproducible SQLite snapshot agree on published relationships, with static tag surfaces read from the snapshot's own rows. |
| [0003 — Reliable lazy previews](archive/0003-reliable-lazy-previews.md) | 2026-09-16 | Implementation commit `948696e`; all six evaluation rows executed as real Chromium gates against generated sites under the served CSP, with the read-only, failure/retry, race, and provisional-limit controls recorded in the file. |
| [0004 — Complete tag browsing](archive/0004-complete-tag-browsing.md) | 2026-09-16 | Implementation commit `718700e`, review fixes `c119678`/`c401315`, PR #5; the reader's tag chooser and the static tag route enumerate one snapshot's membership across pages, with the lookahead-row control, NOCASE exactness, failed-initialization fallback, keyboard operation, withheld-tag absence, and shared-runtime measurements recorded in the file. |
| [0005 — Interactive graph exploration](archive/0005-interactive-graph-exploration.md) | 2026-09-17 | Implementation commits `1d22934`, `610bb5f`, `38c9467`, PR #6; the live graph and its accessible representation agree on the bounded induced subgraph over a 65-note browser corpus, complete relations stay reachable beyond the drawing, the required mutation and failure controls were re-run, and SQL/Worker and render timings are recorded separately for 0008 — all in the file. |

Three goals remain `ready` and active. Schema creation, query-module code,
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
| Exact DB URL/digest binding | Build output in 0002; browser validation in 0003; host/package validation in 0007 |
| Lazy shared Worker, real read-only WASM, CSP, retry, stale preview suppression | 0003 (completed); cross-consumer evidence in 0004 (completed)/0005 |
| Canonical runtime tag lookup and exhaustive pagination | 0004 (completed) |
| Local/global/tag-filtered graph, ranking, re-centering, complete relation enumeration | [0005](archive/0005-interactive-graph-exploration.md) (completed) |
| Publication ledger, binary-aware residue/secrets, output inventory, withdrawal and failed-build preservation | 0006 |
| CLI preview recognition, tarball adoption, runtime minimum, JS/WASM provenance, GitHub Action | Recognition protection in 0006; foreign installation/transport in 0007 |
| Snapshot caching, stale-page fallback, no substitution of a newer DB | 0007 |
| 100/1,000/10,000-note measurements, physical mobile p95, cold preview, memory and finite policies | 0008 |
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
- A goal starts `ready`, becomes `in progress` when executed, and becomes
  `completed` only when its own evidence and stated acceptance authority are satisfied.
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
[archive](archive/README.md) on 2026-09-16, and
[0005](archive/0005-interactive-graph-exploration.md) on 2026-09-17; no other
number has been completed.
