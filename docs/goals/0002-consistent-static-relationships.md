# 0002 — Consistent static relationships

Status: in progress. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

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

Closed 2026-09-15: the packaged artifact no longer serializes
`outgoing`/`backlinks`. `bin/anc.mjs` writes the artifact stripped
(`writeArtifact(..., { includeEdges: false })`) and builds the snapshot from the
same in-memory producer result (`buildSnapshotFromEntries`), so the relationship
authority reaches the build as a transient handoff rather than a serialized page
field; `tests/discovery.test.ts` gates both the stripped and the default writer,
and `tests/content-contract.test.ts` accepts an edgeless artifact while rejecting
a mixed one. This repository's committed `src/data/content.json` and the two
fixture corpora still carry the arrays as the producer handoff for the repo build.

Remaining gap: static tag routes still derive from the producer normalizer rather
than a direct DB read (the `tags`/`node_tags` rows are built from that same
normalizer, so the two agree by construction and by gate).

## Completion record

Not completed. Record commit/PR, exact commands, fixture identities, DB/HTML
comparison results, determinism hashes, failure-control results, and remaining
out-of-scope failures. Archive only with this goal's evidence satisfied.
