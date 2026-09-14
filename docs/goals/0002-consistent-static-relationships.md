# 0002 — Consistent static relationships

Status: ready. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

## Desired outcome

A reader of an actual ANC build can follow complete, correct outgoing links,
backlinks, tags, related-note suggestions, and accessible static graphs with
JavaScript disabled. Every relationship surface is derived from the same finalized
public SQLite snapshot. The snapshot exactly represents the published Markdown
corpus and is reproducible under the pinned toolchain.

This establishes the static site's relationship truth. It can be accepted without
claiming that enhanced browser features or the installable package are finished.

## Material bounds

The [architecture](../core-design/architecture.md),
[content semantics](../core-design/content-semantics.md),
[SQLite contract](../core-design/sqlite-contract.md), and
[build binding](../core-design/build-and-runtime.md) are binding. No additional
schema, body column, stored backlink array, public JSON index, or compatibility
path is allowed. The private IR retains only the rendering/process-boundary data
it needs; the target does not serialize outgoing/backlink authorities in entries.

Preserve authored link behavior, publication exclusions, static page content,
Pagefind alias/full-text search, routes, feeds, and collection-based presentation.
Complete relation lists are not limited by the graph's drawing bounds or the old
500-backlink field limit. Related suggestions remain suggestions, not graph edges.

No other new goal is a completion prerequisite. Existing preview enhancement may
remain unfinished under 0003, but normal links and static reading must work. This
goal must not retain the deleted JSON to keep the old enhancement working.

## Completion evidence

Use real Markdown builds with independently specified expected slugs, directed
pairs, tags, and aliases. Do not derive the expected answer from the SQL or arrays
being replaced. Record exact test commands and nonzero assertions in the completion
record; the repository fixture/build gates remain the execution entry points.

| Evaluation | Pass condition |
| --- | --- |
| Public projection | Read the emitted DB: exact schema, headers, constraints, rows and normalized memberships agree with the authored corpus. Integrity is `ok`; FK check is empty. Withheld, missing, helper and external targets produce no nodes or edges. |
| Link semantics | Duplicate occurrences collapse; reverse links remain directed; same-page headings create no self-edge; cross-note headings retain HTML fragments. Code and escaped links do not become edges. Shared aliases across notes remain valid metadata. |
| Metadata fidelity | Effective note language matches static rendering, including fallback when source language is absent. Deliberately non-alphabetical YAML aliases retain their sequence through ordinal storage and query; duplicate labels/ordinals are rejected. |
| Static behavior | Build the corpus and inspect article anchors, relationship lists, tag routes and graph SVG/table with JS disabled. Membership/metadata agree with SQLite; ordering and induced edges satisfy core design. A hub with more than 500 backlinks remains fully reachable. |
| Single output model | Output inventory finds exactly the bound hashed DB and no legacy public index/manifest/adjacency payload. Static queries read that finalized file; page content still renders from private IR. |
| Determinism and removal | Two fresh builds and shuffled discovery under the same toolchain produce identical DB bytes. Changed public metadata changes the projection; removal eliminates the node, incident relations, unused metadata and current static/search records. A body-only edit outside excerpt/links may leave DB bytes unchanged. |
| Useful failure controls | Invalid self/dangling/duplicate rows, tag-key collisions, unexpected schema members, and a deliberately inverted or omitted authored relation are rejected by the relevant gate. Dropping a neighbor-to-neighbor edge must fail static graph parity. |

Show representative query plans using the outgoing PK, backlink reverse index,
and leading tag membership key. No latency claim follows from a query plan.
Run applicable build/fixture, relation, graph, route, search, and removal checks;
report failures rather than relabeling them as passing. Release adversarial coverage
is owned by 0006; no existing gate may be bypassed to complete this goal.

## Completion record

Not completed. Record commit/PR, exact commands, fixture identities, DB/HTML
comparison results, determinism hashes, failure-control results, and remaining
out-of-scope failures. Archive only with this goal's evidence satisfied.
