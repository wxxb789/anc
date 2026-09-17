# 0005 — Interactive graph exploration

Status: completed 2026-09-17. Created: 2026-09-14. Replaces part of
[0001](../0001-unified-public-query-model.md).

## Desired outcome

A reader can explore a note's incoming and outgoing relationships, re-center on
another note, and inspect the global or tag-filtered graph. The drawing and its
accessible representation describe the same bounded induced subgraph. Complete
relationships remain reachable when the drawing omits nodes.

## Material bounds and prerequisites

Requires [0002](0002-consistent-static-relationships.md), the shared runtime in
[0003](0003-reliable-lazy-previews.md), and the tag identity/query outcome of
[0004](0004-complete-tag-browsing.md) for filtered exploration. Follow the
[graph selection contract](../../core-design/content-semantics.md) and
[named graph/list operations](../../core-design/build-and-runtime.md).

Local selection includes the center and up to 12 neighbors; global selection
includes up to 60 nodes. These accepted presentation limits do not cap corpus
size or relation enumeration. Ranking, degree scopes, reciprocal pairs, omitted
counts and title/slug ordering follow core design. Selection must precede induced-
edge extraction; a center-only star is not the required neighborhood graph.

Static SVG/table/lists remain the baseline. Runtime exploration is bounded and
successive; no stored closure, materialized degree, unbounded path search, arbitrary
SQL, new graph database, or second adjacency payload. Collection filtering and new
edge kinds are outside this goal. Keyboard, ordinary anchor navigation and reduced
motion remain usable; layout state is transient presentation data.

## Completion evidence

Build a real corpus containing a reciprocal pair, a cycle, an isolated note, an
unknown lookup, neighbor-to-neighbor links, more than 12 neighbors, more than 60
candidates, ranking ties, and a tag subset whose top-ranked note differs from the
unfiltered graph. Use independently listed expected sets/order for those cases.

| Evaluation | Pass condition |
| --- | --- |
| Local meaning | Native and Worker selection agree; center is not counted as a neighbor. Incoming and outgoing neighbors are unioned once, selection order is correct, and every edge among drawn nodes is retained with correct direction. |
| Global/filter meaning | Degree ranks distinct candidate neighbors before truncation. Reciprocal directions do not double-count a neighbor. Filtering excludes outside endpoints and ranks within the filtered graph, including isolated matching notes. |
| Reader interaction | Actual controls load on intent, re-center across a cycle without unbounded accumulation, filter/reset, and reach complete incoming/outgoing lists beyond the drawn limit. Paginated list queries enumerate without gaps or duplicates. |
| Honest display | Omitted counts use the correct scope. Drawn degree/table adjacency matches the picture, accessible names explain the represented scope, and keyboard navigation exposes real note links. Unknown center, isolated center and empty filter do not masquerade as runtime failure. |
| Mixed-language expansion | Newly queried graph nodes and relationship titles retain effective note language. Expanding from an English page to a Chinese note, and from a Chinese page to an undeclared/default-language note, applies the same `lang` semantics as static rendering. |
| Failure and sharing | With WASM blocked or the Worker terminated during exploration, article/static graph/table/lists remain usable. Retry recovers; stale replies cannot overwrite the new center/filter. Graph, tags and previews share the same Worker/snapshot. |

Controls must detect omission of a neighbor-to-neighbor edge, reversal of one
direction, double-counting a reciprocal pair, and applying the limit before ranking.
Inspect actual generated DOM/SVG and real Worker responses; pure layout tests alone
are insufficient. Record SQL/Worker and rendering timing separately for 0008, but do
not claim performance acceptance from bounded node count alone.

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

Remaining gaps found while implementing: the enhanced drawing is redrawn
client-side from the shared layout; SQL/Worker and render timing are not recorded
(the goal asks for them for 0008), and no CI/Action browser run is recorded.
All three were closed on 2026-09-17; see the completion record below.

## Implementation progress (2026-09-17)

Branch `feat/0005-graph-exploration-evidence`, PR
[#6](https://github.com/wxxb789/anc/pull/6). Commits, oldest first: `1d22934`
operation duration in snapshot replies with separated measurement spans,
`610bb5f` honest empty/unknown drawings, named re-center controls, table
language, and the render span, `38c9467` the consolidated native/Worker and
browser gates. A CI run was recorded on the last code commit (below); the goal
file and index changes are a docs-only follow-up.

Commands and observed results:

- `pnpm run verify` — 76 test files, **916 passed / 34 skipped**, exit 0.
- `pnpm run build:fixture` — 76 files, **945 passed / 5 skipped**, secret scan
  `227 files, 0 findings`, residue `33 files, 0 findings`, exit 0.
- Test consolidation in the same change: node-layer graph tests 44 → 31
  (`graph-selection` 10 → 7, `graph.test` 22 → 10, `graph-enumeration` new → 4,
  `worker-protocol` 5 → 4, `snapshot-client` 7 → 6), the browser gate 4 → 12,
  and `snapshot.test.ts` 9 → 7, while adding live incoming-direction, live
  table relation/degree, stale-center, and live-keyboard coverage. Every removed
  assertion was checked against a stronger retained gate, and the retained gates
  were re-run under mutation to confirm the defects still go red (table below).
- Timing instrument run (goal 0008's instrument, not its acceptance):
  `node scripts/benchmark-snapshot.ts --sizes 1000,10000 --topologies sparse,hub
  --samples 8 --throttle 4` in real Chromium 151.0.7922.34 on this Linux host
  with CPU throttling ×4 simulation; report sha256 `bab2f831df95` under
  `<git-dir>/publish-report/` (private, never an artifact key). Columns are
  nearest-rank p50/p95 in milliseconds; n = 9 per cell (warm-up plus eight
  samples). `total` is dispatch → validated result, `Worker op` is the reply's
  own `operationMs` span around the named operation's `run()` after
  initialization settled, and `render` is the client's layout+draw span.

  | Workload | total | Worker op | render |
  | --- | --- | --- | --- |
  | 1000 sparse | 8.3 / 10.7 | 0.9 / 3.2 | 2.7 / 14.5 |
  | 1000 hub | 12.9 / 19.7 | 4.9 / 19.3 | 4.7 / 15.3 |
  | 10000 sparse | 9.8 / 12.9 | 0.9 / 5.1 | 1.4 / 12.6 |
  | 10000 hub | 14.0 / 16.5 | 7.2 / 15.6 | 4.3 / 13.2 |

  These are simulation numbers, not a physical mobile device and not a
  performance claim; goal 0008 owns acceptance.
- CI: GitHub Actions `verify` run `35134417363` is green on `38c9467`, the last
  code commit of this completion. Earlier runs already prove the browser gates
  executed rather than skipped: run `35041077292` is green on `36ebc56` (the
  PR #2 merge carrying the 2026-09-15 implementation) and its log records
  `tests/graph-runtime.test.ts (4 tests)` under the Chromium the workflow
  installs; run `35117827299` is green on `933ce85`, the reviewed baseline this
  branch builds on. The workflow installs Chromium because these gates fail,
  not skip, without it.

## Completion record

Completed 2026-09-17. Implementation commits `1d22934`, `610bb5f`, `38c9467` on
branch `feat/0005-graph-exploration-evidence`, PR
[#6](https://github.com/wxxb789/anc/pull/6); CI run `35134417363` green on
`38c9467`.

### Corpus and oracle identity

The browser corpus is `tests/fixtures/graph-runtime-corpus.ts`: 65 notes built
by the shipped binary for each run of `tests/graph-runtime.test.ts` (measured
build 5.4–11.7 s, well inside the gate's 180 s setup budget). It contains one
hub with 17 neighbours, fifteen peers with an authored reciprocal pair
(`peer-01` ↔ `peer-02`), a three-cycle (`peer-02` → `peer-03` → `peer-01`), a
neighbour-to-neighbour chord (`peer-04` → `peer-02`), an isolated note, two
identically titled degree-1 notes (`tie-alpha`/`tie-zeta`, slug tiebreak), a
zh-CN note and an undeclared-language note, 44 degree-0 fillers (more than 60
candidates in total), and tags `team` (peer-01..03) and `garden` (island,
peer-04, plain-note) whose top-ranked member differs from the unfiltered top.
Every expected set, order, count and edge in that module is hand-written; no
gate derives an expectation from the implementation or reads one back from the
DOM.

### Evidence by evaluation

| Evaluation | Gate | Expected vs observed |
| --- | --- | --- |
| Local meaning | One full-identity native/Worker comparison (slug, title, language, ordered directed edges, omitted) plus local bound and induced-edge tests in `tests/graph-selection.test.ts`; exact live DOM/SVG in `tests/graph-runtime.test.ts` and hand-listed `localGraph` over a real snapshot in `tests/graph-enumeration.test.ts`. | Hub: drawn exactly `[hub, peer-01…peer-12]`, omitted 3 of 17 neighbours (center never counted), 16 merged lines with `hub→peer-01…12`, `peer-01↔peer-02`, `peer-02→peer-03`, `peer-03→peer-01`, `peer-04→peer-02`, and no line to an omitted neighbour. peer-01 re-center: exactly 7 lines, `hub→peer-01` dashed/`incoming`, `peer-01↔peer-02` both arrowheads, `peer-01→zh-note` outgoing. |
| Global/filter meaning | `tests/graph-selection.test.ts` rank-before-slice, reciprocal-once (native and tag SQL), outside-endpoint exclusion, isolated members, >60 inside a tag; real `/graph/` DOM in `tests/graph-runtime.test.ts`. | Unfiltered: exactly 60 of 65 drawn, first `hub`, omitted exactly `filler-41…44, island`; team filter draws `[peer-01, peer-02, peer-03]` with 3 merged lines and no `hub`; garden filter draws `[island, peer-04, plain-note]` with zero lines, so the isolated matching note is ranked inside its own graph. |
| Reader interaction | Keyboard and pointer controls, cycle re-center, filter/reset, complete lists, and cursor enumeration: `tests/graph-runtime.test.ts`, `tests/graph-enumeration.test.ts` (real snapshot), `tests/tag-query.test.ts`/`tests/tag-browser.test.ts` for the tag pagination prerequisite. | The live controls open by Tab+Enter, reset by Tab+Space (proved by a second Worker reply), and re-center by Tab+Space; the re-center sequence traverses the cycle with the exact hand list at every step and never more than 13 nodes; the hub page's complete outgoing list carries all 17 links although the figure draws 12; outgoing/backlinks enumerate as pages `[4,4,4,3]` in canonical slug order with no gap or duplicate, `nextCursor` equal to the last returned slug, and a deliberately wrong walker provably misses three members. |
| Honest display | Bound sentence (template and literal `12 of 17`), live table cells, drawn degree, accessible names, frame coverage, and the three no-match states: `tests/graph-runtime.test.ts`, `tests/graph.test.ts`. | The static hub page states `12 of 17` and links all 17; after redraw every drawn row's relation/degree matches the hand oracle (peer-01: outgoing, degree 3, joined `[hub, peer-02, peer-03]`; peer-05: singular label, degree 1); the live figure name is count-free and equals the emitted template; an empty filter depicts 0 nodes/rows under the empty-filter sentence on both first load and after a drawing; an unknown center is a successful no-match (`localGraph` reply `graph: null`) that keeps the stale page's own baseline and never shows the failure sentence; an isolated note offers no explorer at all. |
| Mixed-language expansion | Static == live `lang` per anchor on an English and a Chinese page, plus title text: `tests/graph-runtime.test.ts`; language identity in the native/Worker parity. | On `/notes/peer-01/` exactly the zh-note anchors carry `lang="zh-CN"` (figure, table row head, joined list) before and after redraw, and the live zh-note anchor's text and accessible name carry the corpus's Chinese title; on `/notes/zh-note/` the undeclared note is marked `en` exactly as the static page renders it. |
| Failure and sharing | WASM blocked with retry, Worker deadline with recovery, released stale filter and stale center replies, one shared Worker with previews: `tests/graph-runtime.test.ts`, lifecycle halves in `tests/snapshot-client.test.ts`. | With WASM blocked the static article, figure, table and links survive and the failure sentence is exact; after unroute the next intent draws. A non-replying Worker is terminated at its deadline (counted), the previous drawing stays, and the next intent builds a second Worker and succeeds. A released stale `globalGraph` reply and a released stale `localGraph` reply each fail to overwrite the newer selection. Graph activation and a hover preview share one Worker: db, WASM, glue and Worker chunk each requested once, zero terminations, no page errors. |

### Controls (mutation evidence)

Each mutation was applied to one `src/` file, the named gate observed red, and
the file restored to its byte-identical pre-mutation content; the working tree
carries no mutation and no `src/` file is modified by a test-only experiment.

| Mutation | Red gate |
| --- | --- |
| `selectGlobal` slices before ranking | `graph-selection.test.ts` rank-before-slice, global and tag pages |
| Degree counts edge occurrences or a reciprocal pair twice (`UNION ALL` without `DISTINCT`) | `graph-selection.test.ts` reciprocal-once, Worker path |
| `tagNodeDegrees` counts a neighbour outside the tag | per-tag native/Worker parity |
| `selectLocal` slices before the title sort | local bound order on both paths |
| `inducedEdges` keeps only center edges | exact directed edge set, node and browser |
| `inducedEdges` reverses one direction | exact directed edge set, node and browser |
| `graph-client` drops the `graph-edge-incoming` class | browser peer-01 merged-edge oracle |
| `graph-client` swaps the table's relation/degree cells | browser table oracle |
| `graph-client` removes the sequence guard after the await | browser stale filter and stale center |
| `snapshot-queries` `nextCursor` becomes the lookahead row | `graph-enumeration.test.ts` and `tag-query.test.ts` (used to prove the removed cursor unit test redundant) |

### Carried limitations and explicit non-claims

- No performance acceptance is claimed. The recorded numbers are CPU-throttled
  simulation (×4) on this Linux host in headless Chromium, not a physical
  mobile device, and bounded node count alone is not offered as a cost
  argument; [0008](../0008-acceptable-browser-cost.md) owns the device and policy
  judgment.
- The browser corpus gates 65 notes built per test, not the packaged 10,000-note
  workloads; corpus and row scale are covered independently by the native
  selection tests and the real-snapshot enumeration.
- The isolated center's live 0-of-0 drawing branch is unreachable from the
  shipped UI — a note with no drawable graph renders no explorer — so it is
  asserted through the "no explorer offered" browser test rather than by
  simulating a figure that cannot exist.
- The reply's `operationMs` covers the named operation's whole execution inside
  the Worker (its queries plus selection and induced-edge work) after
  initialization settled; an inner SQL-only split remains goal 0008's to
  introduce if its report needs one.
- [0006](../0006-safe-release-output.md),
  [0007](../0007-independent-publisher-adoption.md) and
  [0008](../0008-acceptable-browser-cost.md) remain active. Deployment and
  post-deploy smoke tests remain external, separately approved actions.
