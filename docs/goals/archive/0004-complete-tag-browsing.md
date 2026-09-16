# 0004 — Complete tag browsing

Status: completed 2026-09-16. Created: 2026-09-14. Replaces part of
[0001](../0001-unified-public-query-model.md).

## Desired outcome

A reader can choose a published tag and reach every matching published note,
including matches beyond a single browser result page. The browser's tag query
and the complete static tag route agree on tag identity, label and membership.
Empty/exhausted results and an unknown tag are distinguishable.

This is one discovery capability. Its completion does not require interactive
graph drawing; the graph can consume the same tag semantics under 0005.

## Material bounds and prerequisites

Requires the normalized snapshot/static routes of
[0002](0002-consistent-static-relationships.md) and the shared working browser
runtime established with [0003](0003-reliable-lazy-previews.md). Follow
[tag semantics](../../core-design/content-semantics.md),
[cursor rules](../../core-design/sqlite-contract.md), and the existing
[`byTag` boundary](../../core-design/build-and-runtime.md).

There must be a real reader-facing consumer of `byTag`, not only an exported
function or developer-console demo. Use the existing tag browsing surface; this
does not require a new dashboard or authoring feature. Static tag routes stay
complete and usable without JS or after enhancement failure. Browser enumeration
is slug-ordered; static display may remain title-ordered.

No browser-side tag normalization, alternate tag index, alias lookup semantics,
tag-generated graph edges, speculative reverse membership index, or schema growth.
Choosing/following a tag is explicit intent; scrolling a tag page is not permission
to prefetch the whole database.

## Completion evidence

Use an authored corpus with one tag spanning more than two chosen result pages,
equivalent spellings, non-equivalent key collisions, CJK/emoji labels, unused private
tags and isolated public notes. Expected membership must come from the authored
corpus, independent of the production normalizer/query result.

| Evaluation | Pass condition |
| --- | --- |
| Identity | NFC/lowercase-equivalent spellings have one deterministic key/label and one membership per note. Non-equivalent `C++`/`C#` key collisions fail the build. SQLite `NOCASE` is not substituted for the accepted rule. |
| Exhaustive pagination | The actual UI reaches all pages. Concatenated Worker results contain each expected slug exactly once in cursor order, with correct metadata and null continuation at exhaustion. A page boundary neither skips its lookahead row nor repeats the previous one. |
| Subject changes | Switching tags resets continuation. A late result for the old tag cannot replace the new selection. Invalid page sizes/cursors fail with bounded errors; an unknown tag is distinct from a known tag with no further results. |
| Static parity and failure | Static tag links/routes enumerate the same set. JS disabled or failed DB initialization preserves navigation to every matching note. Keyboard selection and result navigation work. |
| Language of results | Browser note titles carry the target note's effective language, applying the same `partLanguage` behavior as static tag lists, including notes with no declared language. |
| Privacy and cost | Withheld-only tags are absent; removed last-use tags disappear on a fresh rebuild. Previews and tag browsing share one runtime/download, with no independent corpus cache or public membership JSON. |

Run native query tests, production normalizer/collision tests, and real generated-
site browser tests. Include a control using the lookahead row as continuation: the
enumeration assertion must detect the skipped note. No new numerical latency
target is introduced here; 0008 evaluates measured cost.

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

Remaining gaps found while implementing: a statically rendered chooser cannot
produce a key the snapshot lacks, so the unknown-tag outcome is driven by
injecting an option through the real `change` handler; a memberless known tag is
proven at the model boundary because `write-snapshot.ts` emits only tags with a
member.

## Completion record

Completed 2026-09-16. Implementation commit `718700e`, review fixes in
`c119678` and `c401315`, on branch `feat/0004-complete-tag-browsing` (PR #5),
based on `main` `6cf50e1` (the merged 0003 work). The completion adds the row-level
native and browser evidence the table above requires and closes the two gaps
the implementation note carried; the reader-facing surface itself shipped in
`9630622`, and no accepted architecture changed.

### Reader surface

`#tag-browser` (`src/components/TagBrowser.astro`) is the one enhanced region,
mounted mode `switch` on `/tags/` (`#tag-browser-select`) and mode `fixed` on
`/tags/<tag>/` (`#tag-browse-start`), with `#tag-browse-more`,
`#tag-browser-status`, `#tag-browser-results`, and `#tag-browser-current`.
`#tag-static-list` beside it is the complete no-JS route; the enhanced region
stays hidden until the script runs and the static list returns on any failure.
Every status sentence arrives as a `data-tag-browse-*` attribute, so no locale
table ships to the browser and no tag is normalized there — the key is sent
exactly as the static route spells it.

### Commands and observed results

| Command | Observed |
| --- | --- |
| `pnpm run verify` | **75 test files passed, 923 passed / 34 skipped**, exit 0. Build chain: search index 10 pages, output inventory 150 files, secret scan 150 files / 0 findings, residue scan 33 files / 0 findings; oxlint 0 warnings / 0 errors and `astro check` 0 errors. |
| `pnpm run build:fixture` | **75 files, 952 passed / 5 skipped**, exit 0, `fixture build ok: every gate passed against tests/fixtures/valid-corpus.json`. Build chain: search index 54 pages, output inventory 227 files, secret scan 227 files / 0 findings, residue scan 33 files / 0 findings; the published build was then restored (search 10 pages, inventory 150 files). |
| `pnpm run smoke:tarball` | exit 0, `tarball adoption smoke ok: 1 published note, 2 withheld notes`; tarball `anc-0.1.0.tgz`, 388,754 bytes, sha256 `66a12a3aab464c0ffb739e51d766c68b0b5cdbf5c73cb07eefa13b85f391140b`. |

Browser: Playwright 1.62.1 with real Chromium **151.0.7922.34**; every browser
gate below launched it. Pinned runtime `@sqlite.org/sqlite-wasm@3.53.4-build1`.
Published-corpus artifact identities unchanged from 0003:
`/data/site.9fc2794fe518c3d39e30b107fa1b75a5805bff119bac536b0cfc745b6405634d.sqlite`
(40,960 bytes) and
`/wasm/sqlite3.2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752.wasm`.

### Evaluation rows

1. **Identity — `tests/tag-query.test.ts` (7 tests, native over a real
   `writeSnapshot` file)** plus the existing normalizer and build gates.
   The authored corpus is 23 notes: 17 alternating `Gardening`/`gardening`, one
   `both-case` note carrying both spellings, an NFC/NFD `café` pair, `笔记`,
   `🌱 seedling`, and an isolated untagged `plain` note; every expected key,
   label, member list, and page size is hand-written. Raw `tags`/`node_tags`
   reads assert one deterministic key and label per equivalence class
   (`facets`' existing comparator selects the NFD `café` and `Gardening`), one
   membership per note including `both-case`, and 4 canonical tags total.
   `tagPage(db, 'GARDENING')` is unknown and `PRAGMA index_xinfo` reports the
   key column's collation as `BINARY`, so SQLite `NOCASE` is not substituted;
   the duplicate-membership control proves the `(tag_id, node_id)` primary key
   refuses a second row. `C++`/`C#` collisions remain build failures:
   `tests/route-model.test.ts` throws in `tagFacets`,
   `tests/producer-metadata.test.ts` runs the real CLI to `status 1` /
   `invalid-generated-content`, and `tests/deployment.test.ts` fails the
   pre-build gate.
2. **Exhaustive pagination — the native walk and the actual UI.**
   `tests/tag-query.test.ts` walks `tagPage` at page size 7 over the 18-member
   tag: page sizes `[7, 7, 4]`, every non-final `nextCursor` equals the last
   *returned* slug, the final cursor is null, and the concatenation is the
   hand-written list exactly once in cursor order with each row's authored title
   and effective language (`zh-CN` for `page-07`, `en` fallback for `page-01`).
   The lookahead control is the goal's named control: a second walker continues
   from the row *after* the last returned slug, collects 16 slugs, drops exactly
   `page-07` and `page-15`, and the same enumeration oracle that accepts the
   correct walk throws on it. `tests/tag-browser.test.ts` drives the built site's
   real UI through `#tag-browse-more`: 21 members at the reader page size 10
   produce `[10, 10, 1]`, exactly-once enumeration in cursor order despite titles
   reversed against slug order, the snapshot label, and the exhaustion sentence;
   the double-click test counts `byTag` dispatches so a second click cannot
   re-send a cursor.
3. **Subject changes.** `tests/tag-browser.test.ts` advances `gardening` to a
   real continuation (dispatch cursors `[null, 'tag-10']`), switches to
   `notebook`, and asserts the new tag's first dispatch carries cursor null and
   the result list begins at its first page; the delay-controlled test proves a
   late reply for the old tag cannot replace the newer selection. Invalid
   arguments are refused before SQL at the Worker boundary:
   `tests/worker-protocol.test.ts` rejects `byTag` with a malformed cursor, a
   string page size, and a slash-bearing key, and clamps `byTag` page sizes to
   the accepted range. An unknown tag is distinct from a known tag with no
   further results: the browser drives a missing key through the real `change`
   handler and renders the unknown sentence with no results, while the native
   test proves `{known: false}` for an unknown key versus a known tag that
   returns an empty page and null cursor for a cursor beyond every member.
4. **Static parity and failure.** The JS-disabled context reaches every
   matching note through `#tag-static-list`; a failed snapshot (route aborted)
   leaves the same complete list visible with the failure sentence and no page
   error; the enhanced and static lists in one document are compared as sets and
   agree; keyboard-only operation is real presses: Tab to the chooser, ArrowDown
   for the first facet, Tab to the first result and Enter to navigate, and on the
   fixed route Tab to Start, Enter, Tab to Load more, Enter. Route-level parity
   stays with `tests/built-routes.test.ts` (exact route set and per-facet
   membership) and `tests/snapshot-hydration.test.ts` (keys and members read from
   the snapshot rows).
5. **Language of results.** `src/scripts/tag-browser.ts` now calls the same
   `partLanguage` the static lists use instead of an inline comparison, so the
   rule has one authority; the browser test asserts `lang="zh-CN"` on the
   `tag-07` result and no redundant `lang` on the undeclared `tag-01` result,
   matching `tests/built-routes.test.ts`'s static rendering and
   `tests/translations.test.ts`'s unit cases.
6. **Privacy and cost.** On the built corpus, `snapshotTags(dist)` is exactly
   `[gardening, notebook]`, the chooser options are the same keys, and
   `/tags/withheld-only/` is a 404, so a tag used only by the withheld note
   reaches no surface; `tests/deletion-roundtrip.test.ts` still proves a
   last-use tag row disappears on a fresh rebuild. The shared-runtime claim is
   measured: loading `/tags/` and scrolling issues zero SQLite requests, the
   first selection downloads exactly one snapshot, one WASM body, and one Worker
   chunk across two pages; and a preview hovered on the same page before the tag
   query reuses all three with zero Worker terminations. The retired
   `tags.json`/`memberships.json` names join `tests/legacy-payload.test.ts`'s
   named-absence list beside the exact output inventory, so no public
   membership JSON can appear.

### Design alignment this completion required

`assertSnapshotRows` accepted any number of extra explicit indexes while its
own header promised "an unexpected ... index" would fail. The accepted
"exact schema" rule and this goal's "no speculative reverse membership index,
or schema growth" bound are one requirement, so the validator now compares the
`sqlite_schema` index set exactly against `edges_by_target`, and
`tests/snapshot-contract.test.ts` plants both the reverse membership index
`node_tags(node_id, tag_id)` and an unrelated index as refusal controls. The
Worker-init fixture now returns the index row the writer actually creates,
rather than a schema shape the writer cannot produce.

### Carried limitations and explicit non-claims

- The chooser is rendered from the snapshot's own facets, so the unknown-tag
  browser outcome is still driven by injecting an option through the real
  `change` handler; a memberless known tag remains representable only at the
  model boundary, where `tests/tag-browser-model.test.ts` now pins it (the
  writer emits only tags with a member).
- `C++`/`C#` collision is proven as a build failure, so no served corpus can
  contain it.
- No new numerical latency target; 0008 evaluates measured cost.
- All browser evidence above is local real Chromium under the served CSP, and
  the same gates run in CI: GitHub Actions `verify` run `35100602682` is green
  on `c401315`, the last code commit of this completion.
- No mobile or release acceptance, and 0005–0008 remain active. This record
  does not claim any successor is complete.
