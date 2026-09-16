# 0005 — Interactive graph exploration

Status: in progress. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

## Desired outcome

A reader can explore a note's incoming and outgoing relationships, re-center on
another note, and inspect the global or tag-filtered graph. The drawing and its
accessible representation describe the same bounded induced subgraph. Complete
relationships remain reachable when the drawing omits nodes.

## Material bounds and prerequisites

Requires [0002](0002-consistent-static-relationships.md), the shared runtime in
[0003](0003-reliable-lazy-previews.md), and the tag identity/query outcome of
[0004](0004-complete-tag-browsing.md) for filtered exploration. Follow the
[graph selection contract](../core-design/content-semantics.md) and
[named graph/list operations](../core-design/build-and-runtime.md).

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
are insufficient. Record SQL/Worker and rendering timing separately for 0008, but
do not claim performance acceptance from bounded node count alone.

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

## Completion record

Not completed. Record commit/PR, exact commands/nonzero browser results, expected
and observed graph selections/edges/counts, accessibility evidence, failure and
mutation controls, and unresolved performance measurements.
