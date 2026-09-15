# 0006 — Safe release output

Status: ready. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

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

## Completion record

Not completed. Record commit/PR, exact release/test commands and nonzero results,
scanner versions/coverage, mutation observations, redacted stream comparisons,
before/after output hashes and concurrency/failure evidence. Include the tested
artifact digest and any unresolved release failures.
