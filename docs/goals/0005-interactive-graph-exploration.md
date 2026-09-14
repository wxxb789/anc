# 0005 — Interactive graph exploration

Status: ready. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

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
| Failure and sharing | With WASM blocked or the Worker terminated during exploration, article/static graph/table/lists remain usable. Retry recovers; stale replies cannot overwrite the new center/filter. Graph, tags and previews share the same Worker/snapshot. |

Controls must detect omission of a neighbor-to-neighbor edge, reversal of one
direction, double-counting a reciprocal pair, and applying the limit before ranking.
Inspect actual generated DOM/SVG and real Worker responses; pure layout tests alone
are insufficient. Record SQL/Worker and rendering timing separately for 0008, but
do not claim performance acceptance from bounded node count alone.

## Completion record

Not completed. Record commit/PR, exact commands/nonzero browser results, expected
and observed graph selections/edges/counts, accessibility evidence, failure and
mutation controls, and unresolved performance measurements.
