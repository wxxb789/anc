# 0002 — Consistent static relationships

Status: completed 2026-09-16. Created: 2026-09-14. Replaces part of
[0001](../0001-unified-public-query-model.md).

## Desired outcome

A reader of an actual ANC build can follow complete, correct outgoing links,
backlinks, tags, related-note suggestions, and accessible static graphs with
JavaScript disabled. Every relationship surface is derived from the same finalized
public SQLite snapshot. The snapshot exactly represents the published Markdown
corpus and is reproducible under the pinned toolchain.

This establishes the static site's relationship truth. It can be accepted without
claiming that enhanced browser features or the installable package are finished.

## Material bounds

The [architecture](../../core-design/architecture.md),
[content semantics](../../core-design/content-semantics.md),
[SQLite contract](../../core-design/sqlite-contract.md), and
[build binding](../../core-design/build-and-runtime.md) are binding. No additional
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

At the time of this note, nothing was archived as completed, and no successor
was claimed complete.

Closed 2026-09-15: the packaged artifact no longer serializes
`outgoing`/`backlinks`. `bin/anc.mjs` writes the artifact stripped
(`writeArtifact(..., { includeEdges: false })`) and builds the snapshot from the
same in-memory producer result (`buildSnapshotFromEntries`), so the relationship
authority reaches the build as a transient handoff rather than a serialized page
field; `tests/discovery.test.ts` gates both the stripped and the default writer,
and `tests/content-contract.test.ts` accepts an edgeless artifact while rejecting
a mixed one. This repository's committed `src/data/content.json` and the two
fixture corpora still carry the arrays as the producer handoff for the repo build.

Closed 2026-09-16: the static tag surfaces read their key and members from the
finalized snapshot. `snapshot-reader.ts` returns `SnapshotRelations.tagFacets`
built from the `tags`/`node_tags` rows — the `tags.key` column the batched scan
already selected but discarded — and `content.ts` exposes that index to the tag
routes (`tags/[tag].astro`, `tags/index.astro`), the graph filter, the sitemap,
note metadata links, and related-note grouping. `routes.ts`'s `tagFacets` remains
only the producer's normalization/collision check and the no-snapshot fallback.
`tests/snapshot-hydration.test.ts` mutates a staged `tags.key` to
`renamed-route`, rebinds the digest, and proves the build-facing accessor
returns it (with the producer normalizer as the negative control), so the route
key is the row rather than a re-derivation.

## Completion record

Completed 2026-09-16. Implementation commit `24cea57` on branch
`feat/0002-consistent-static-relationships` (local; no remote PR), based on the
merged `feat/public-sqlite-snapshot` work (`36ebc56`, PR #2). The baseline
before this
completion work was `pnpm run verify` — 60 files, 845 passed / 34 skipped,
exit 0.

### Commands and observed results

| Command | Observed |
| --- | --- |
| `pnpm run verify` | **64 test files passed, 856 passed / 34 skipped**, exit 0. Build chain in the same run: search index 10 pages, output inventory 150 files, secret scan 150 files / 0 findings, residue scan 33 files / 0 findings. |
| `pnpm run build:fixture` | **64 test files, 885 passed / 5 skipped**, exit 0, `fixture build ok: every gate passed against tests/fixtures/valid-corpus.json`. Build chain in the same run: search index 54 pages, output inventory 227 files, secret scan 227 files / 0 findings, residue scan 33 files / 0 findings; then the published build was restored (inventory 150 files, search 10 pages). |
| `pnpm run smoke:tarball` | exit 0, `tarball adoption smoke ok: 1 published note, 2 withheld notes`; tarball `anc-0.1.0.tgz`, 387,394 bytes, sha256 `e48097b519d038edd3f9ba752cf11bbad436a8de147f860960c865279795aab3`. |
| `pnpm run build` twice | Both fresh runs emitted `dist/data/site.9fc2794fe518c3d39e30b107fa1b75a5805bff119bac536b0cfc745b6405634d.sqlite`, **40,960 bytes**, sha256 `9fc2794fe518c3d39e30b107fa1b75a5805bff119bac536b0cfc745b6405634d`; `diff` of the two `sha256sum` outputs is empty — identical DB bytes. |
| `git diff --check` | clean (exit 0) |

Published-corpus identities from the `verify` build:
`dist/data/site.9fc2794fe518c3d39e30b107fa1b75a5805bff119bac536b0cfc745b6405634d.sqlite`
(40,960 bytes, digest in the filename) and
`dist/wasm/sqlite3.2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752.wasm`
(868,907 bytes), pinned `@sqlite.org/sqlite-wasm@3.53.4-build1`.

### Simplification pass (2026-09-16)

A behavior-preserving `ce-simplify-code` review pass followed in commit
`3c7cb4f`: reuse `notesForSlugs` for snapshot facet members and `TagIdentity`
for the facet row type, one local binding writer shared by the hydration gate's
two callers, the scanners' `SQLITE_MAGIC` constant in the legacy-payload gate,
a single hoisted facet index with a lazy `hasTagPeer` on the note page, and
test-local statement/route hoists. No outputs changed: `pnpm run verify` was
rerun on that commit — **64 files, 856 passed / 34 skipped**, exit 0, inventory
150 files, secret scan 150 files / 0 findings, residue 33 files / 0 findings.

### Post-review fixes (2026-09-16)

A `ce-code-review` round over commit `8c4e78f` returned two findings; both are
fixed in `ba24f30`, and the review's testing gap is closed by the link gate in
`66ae50d`.

- **Dangling incoming links (P2, confirmed by the independent validator).**
  The archive move (`5287bff`) rewrote the moved file's own links but left the
  six goal files that point at `0002-consistent-static-relationships.md`
  unchanged, plus two new test prose references. All eight now point at
  `archive/0002-consistent-static-relationships.md`, restoring the lifecycle
  rule in `AGENTS.md`.
- **Emitted-route authority (P2, design call).** The mutated-`tags.key` gate
  proved the reader and the page-facing accessors but not the route surface,
  and `tests/built-routes.test.ts` still predicted tag routes from the producer
  normalizer. The route model is now asserted too:
  `publicRoutes(entries, tagFacets())` tag paths must carry the stored key and
  must not carry the re-derived one, and the built-HTML gates take their
  expected tag route set and note tag href from `content.ts` (`tagFacets`,
  `tagRouteForLabel`). `tests/route-model.test.ts` and the output inventory
  keep the producer normalizer as the independent writer oracle. A full Astro
  build over a deliberately diverging DB remains unexercised: the writer
  guarantees `tags.key = routeKey(tags.label)` and the output inventory
  refuses a tampered file, so divergence is not reachable through the build
  path.

- **Documentation-link gate (the review's testing gap, `66ae50d`).**
  `tests/markdown-links.test.ts` now checks every tracked `*.md` outside
  `tests/fixtures/` for relative links and images that resolve to an existing
  path, with a detector control that proves each supported and skipped shape.
  The gate was falsified against this finding: restoring the stale
  `archive/0003-reliable-lazy-previews.md:19` link turns it red with that exact
  file:line and passes once the link is repointed.

`pnpm run verify` on `ba24f30` — 64 test files, **856 passed / 34 skipped**,
exit 0; output inventory 150 files, secret scan 150 files / 0 findings,
residue scan 33 files / 0 findings. `pnpm run verify` on `66ae50d` — 65 test
files, **858 passed / 34 skipped**, exit 0.

### Skips and conditional gates

No relationship gate is skipped in both configurations. `pnpm run verify`
reports 34 skips because the published corpus is one note, which cannot meet
the multi-entry conditions in `tests/built-routes.test.ts`,
`tests/rendered-page.test.ts`, and `tests/search.test.ts`. `pnpm run
build:fixture` reruns the whole suite over the 32-note corpus and reduces that
to 5, so the multi-entry relationship, tag, graph, and search gates execute.
The browser gates (Chromium installed) ran in both configurations:
`tests/tag-browser.test.ts` 4/4, `tests/graph-runtime.test.ts` 4/4,
`tests/snapshot-runtime.test.ts` 2/2, and `tests/rendered-page.test.ts` 19/19
on the fixture. The remaining five fixture skips are corpus-shape branches
asserted in their own files and are not evidence this goal relies on.

### Evaluation rows

1. **Public projection.** `tests/snapshot.test.ts` opens the producer's own
   bytes and asserts the exact schema, `application_id`, `user_version`,
   `integrity_check = ok`, empty `foreign_key_check`, and nodes, directed
   edges, aliases with ordinals, tag keys, and `node_tags` memberships equal to
   values computed from the fixture artifact. `tests/snapshot-contract.test.ts`
   rejects every declaration mutation (wrong constants, extra table/column/view,
   missing index, dropped FK, removed self-edge check). `tests/snapshot-wasm.test.ts`
   proves the same validator accepts the file through the pinned WASM under
   read-only import. Withheld and missing targets produce no node/edge
   (`tests/link-traversal.test.ts`, `tests/backlink-surfaces.test.ts`);
   external links produce no edge (`tests/link-traversal.test.ts`); helper-route
   targets (`/private/`, `/tags/…`, `/graph/`, `/recent/`, `/collections/…`,
   `/404.html`) are driven through `discover` → `resolveCorpusLinks` →
   `writeSnapshot` in `tests/relationship-failure-controls.test.ts` and produce
   exactly the published note nodes and the one authored edge.
2. **Link semantics.** `tests/link-traversal.test.ts` covers duplicate collapse,
   directed inverse pairs, same-page heading links with no self-edge, cross-note
   heading fragments, and code/escaped links; `tests/content-contract.test.ts`
   rejects self, dangling, duplicate, and non-inverse authored relations;
   `tests/backlink-surfaces.test.ts` checks the rendered article anchors against
   the expected edge set. Shared aliases remain valid metadata:
   `tests/snapshot.test.ts` stores and reads the deliberately non-alphabetical
   `alias-heavy` fixture through ordinals, and `tests/content-contract.test.ts`
   rejects cross-entry conflicts.
3. **Metadata fidelity.** `tests/snapshot.test.ts`, `tests/producer-metadata.test.ts`,
   and `tests/tag-browser.test.ts` compare stored `language` with the rendered
   `lang`, including the `NAV_LANGUAGE` fallback. Duplicate labels are rejected
   by the producer (`tests/discovery.test.ts`) and by `UNIQUE(node_id, alias)`;
   duplicate ordinals are rejected by the primary key — both now planted and
   rolled back in `tests/relationship-failure-controls.test.ts`.
4. **Static behavior.** `tests/built-routes.test.ts` reads the built HTML with
   no scripting for relationship lists, tag routes, and graph parity;
   `tests/tag-browser.test.ts` serves the site with JavaScript disabled and
   asserts the static tag route is complete; `tests/rendered-page.test.ts`
   checks the graph SVG and equivalent table under the browser gates. The new
   `tests/backlink-scale.test.ts` builds a 502-note corpus with the shipped CLI
   and asserts the hub page's backlinks list carries exactly 501 peer anchors
   (each peer once), the emitted DB carries the same 501 edges, the contract's
   reverse-index query returns 501, and the bounded graph states its omission.
5. **Single output model.** `tests/output-inventory.test.ts` accepts the real
   output and rejects unexpected routes/assets by count;
   `tests/legacy-payload.test.ts` adds the named claim — no
   `content-index.json`, `graph-manifest.json`, or adjacency payload, no JSON
   object keys `outgoing`/`backlinks`, and no SQLite header outside the bound
   DB and WASM — with planted positive controls. `tests/snapshot-hydration.test.ts`
   proves the build-time reads come from the digest-bound file (and refuse
   mismatched bytes, bindings, or corpora); `tests/snapshot-runtime.test.ts`
   proves ordinary reading requests no SQLite assets, so page content still
   renders from private IR.
6. **Determinism and removal.** `tests/snapshot-determinism.test.ts`: two fresh
   `writeSnapshot` runs are byte-identical; a shuffled discovery order validates
   and produces identical bytes; changed title/excerpt/language/alias
   order/tag membership change the bytes with the expected row-count deltas;
   a markdown-only edit leaves them identical, with a title control proving the
   comparison can see stored-column changes. `tests/deletion-roundtrip.test.ts`
   now builds through the real CLI and asserts removal eliminates the node, both
   incident edges, the single-member tag row, the alias, and the
   route/feed/sitemap/Pagefind records, while the retained edge and shared tag
   remain. `tests/snapshot-hydration.test.ts` mutates a staged `tags.key` to
   `renamed-route`, rebinds the digest, and proves the build-facing accessor and
   note tag link follow the row rather than the normalizer.
7. **Useful failure controls.** `tests/relationship-failure-controls.test.ts`
   plants each invalid row against the producer's own file with the conflicting
   row read first, asserts the constraint failure, the empty `foreign_key_check`,
   unchanged counts, and a rolled-back legal insert as the positive control.
   Tag-key collisions are held by `tests/route-model.test.ts` and
   `tests/deployment.test.ts`; unexpected schema members by
   `tests/snapshot-contract.test.ts`; the omitted/inverted relation by
   `tests/content-contract.test.ts` and `tests/snapshot-hydration.test.ts`;
   and the rendered graph is compared pair-by-pair with the artifact in
   `tests/built-routes.test.ts`, so a dropped neighbour edge fails parity.

### Query plans (fixture snapshot: 32 notes, 49,152 bytes, digest `dbabe256…`)

```
outgoingFirst   SEARCH e USING PRIMARY KEY (source_id=?)          -- edges PK
                SEARCH n USING INTEGER PRIMARY KEY (rowid=?)
backlinksFirst  SEARCH e USING COVERING INDEX edges_by_target (target_id=?)
                SEARCH n USING INTEGER PRIMARY KEY (rowid=?)
byTagFirst      SEARCH t USING COVERING INDEX sqlite_autoindex_tags_1 (key=?)
                SEARCH nt USING PRIMARY KEY (tag_id=?)
                SEARCH n USING INTEGER PRIMARY KEY (rowid=?)
allNodeTags     SCAN nt → SEARCH t/n by rowid (one batched scan)
```

Plans are asserted statement-by-statement in `tests/snapshot.test.ts`
(`EXPLAIN QUERY PLAN` over `SNAPSHOT_QUERIES`); no latency claim follows.

### Out-of-scope failures

None within this goal's evidence. Enhanced previews and further browser
features beyond the shared read-only runtime remain under 0003; release
adversarial coverage remains under 0006; deployment, registry publication, and
post-deploy smoke tests remain separately approved external actions. This
repository's committed artifact and fixture corpora still carry the producer
handoff arrays by design; the packaged CLI strips them (`tests/discovery.test.ts`).
