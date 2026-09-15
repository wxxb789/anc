# 0006 — Safe release output

Status: in progress. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

## Desired outcome

An ANC release build can succeed only with a complete, internally consistent
output matching the reviewed publication set. The new SQLite carrier cannot
bypass publication, residue or secret checks. A failed build preserves the
previous successful output and cannot leave a newly accepted partial site.

This is the publisher's publication-safety outcome, distinct from proving that a
query returns the right result or that a preview looks correct.

## Material bounds and prerequisite

Requires the real snapshot/static output of
[0002](0002-consistent-static-relationships.md) and the actual browser assets from
[0003](0003-reliable-lazy-previews.md) for JS/WASM inventory acceptance. Follow the
[publication semantics](../core-design/content-semantics.md),
[staging and preview-recognition contract](../core-design/build-and-runtime.md),
and [verification contract](../core-design/verification-and-evolution.md).
Exercise JS/WASM inventory on the actual packaged assets when they are part of the
candidate. Packaging a foreign-repository candidate is assessed separately in 0007.

Names and diagnostics remain private; public streams carry redacted counts and
categories. Authored withheld-link labels retain their accepted disclosure, but
the target's own metadata/body stay withheld. No claim is made to retract data
already downloaded by visitors or crawlers.

No completed-build manifest, writable scan fallback, FTS recovery, migration path,
retained historical DB, or scanner bypass. Deployment and registry publication
remain outside this goal. Security acceptance is for the actual current artifact;
later artifact changes must rerun the applicable gates.

## Completion evidence

Use real `build --release` results with committed synthetic publication ledgers,
plus targeted controls through the production scanners. Validate both the expected
failure and the unchanged prior output; an exit code alone is insufficient.

| Evaluation | Pass condition |
| --- | --- |
| Reviewed set | Missing/dirty/different ledgers, new slugs, removals, and remove-then-reinclude without new review fail release qualification. A matching committed set succeeds with the required public origin and pinned secret scanner. |
| Exact output | Wrong DB digest/schema/ID/version, a second snapshot, WAL/SHM/journal, unexpected JS/WASM, source map, private IR or legacy JSON fails inventory/validation. Preview rejects zero/multiple/wrong candidates and accepts the valid empty-corpus artifact. |
| Both text policies | Residue and pinned Gitleaks each detect planted values reconstructed from SQLite records, including an overflow boundary invisible to a raw-byte-only scan. Raw-byte coverage remains active. Each control proves its own scanner inspected the intended value. |
| Read-only inspection | Scan the immutable artifact; its bytes and directory membership remain unchanged. WAL/unreadable/unknown-schema inputs fail without writable reopening or generated sidecars. Unknown binaries cannot silently count as scanned. |
| No hidden failure path | Blind the SQLite row path for each scanner: its positive control fails. Unreadable output, scan startup failure, or zero coverage cannot report success. Redaction prevents planted secret values/private paths from entering stdout/stderr. |
| Withdrawal | A fresh rebuild removes a note, its incident edges/aliases/unused tags, route, feed/sitemap/search record and old snapshot. Verify that unique withheld target content is absent across current raw, decoded and reconstructed public surfaces. |
| Failed-build preservation | Inject failures during render, DB copy, inventory and scanning. The prior successful output remains byte-identical; a first failed build has no preview-acceptable output. Distinct concurrent synthetic builds cannot mix corpora or bindings. |

Scanner-only overflow fixtures may exceed normal metadata bounds to prove the
instrument sees split values; label them explicitly. Do not mistake rejection by
an earlier schema/digest gate for evidence that either text scanner worked.
The release entry point, repository `verify`, fixture builds and CI must exercise
the same applicable gates; do not construct an alternate passing release pipeline.

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

Remaining gaps found while implementing: release qualification, failed-build
preservation, and concurrent-build isolation are exercised by the existing gates
and by `smoke:tarball`, but were not individually re-verified for this record;
the new positive controls cover the reconstructed-row path, the raw free-page
path, and an unreadable artifact that must fail without a sidecar.

## Completion record

Not completed. Record commit/PR, exact release/test commands and nonzero results,
scanner versions/coverage, mutation observations, redacted stream comparisons,
before/after output hashes and concurrency/failure evidence. Include the tested
artifact digest and any unresolved release failures.
