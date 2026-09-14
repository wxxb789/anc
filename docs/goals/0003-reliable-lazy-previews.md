# 0003 — Reliable lazy previews

Status: ready. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

## Desired outcome

A reader can preview a published note by intentional hover or keyboard focus,
using title, excerpt, and aliases from the page's bound SQLite snapshot. Ordinary
reading downloads no SQLite assets. Failure, dismissal, and rapid movement between
links never show the wrong note or break navigation; a later intent can retry.

The shared lazy read-only Worker is necessary evidence for this reader outcome,
not a separate infrastructure goal. Other browser consumers reuse it when present.

## Material bounds and prerequisite

Requires the valid snapshot and static reading outcome of
[0002](0002-consistent-static-relationships.md). Follow the
[Worker, integrity, CSP and lifecycle contract](../core-design/build-and-runtime.md)
and [preview query semantics](../core-design/sqlite-contract.md).

Use the official pinned SQLite WASM in the real site, same-origin assets, one
Worker/init promise per document/snapshot, named parameterized operations, and
read-only import. No JSON preview index, full-body fetch/render path, SQL console,
OPFS, automatic retry loop, or new script permission is in scope. Treat metadata
as text; preserve the bounded existing preview presentation.

Finite provisional download, request and time limits must already be enforced
and exercised on the correctness fixtures. Broader mobile performance and final
resource-policy acceptance belong to 0008 and do not block functional verification.

## Completion evidence

Use Playwright against an actual generated site with its intended CSP applied by
the test server. A header file merely present on disk does not enforce CSP. Record
the browser version, network trace, actual Worker/WASM paths and test commands.

| Evaluation | Pass condition |
| --- | --- |
| Intent and lazy cost | Load an article and scroll: zero SQLite JS/Worker/WASM/DB requests. Eligible hover after its delay or focus starts the enhancement. Normal navigation remains a real anchor action. |
| Correct content | Previews match the emitted DB, including empty excerpts, ordered/shared aliases, CJK and emoji. Unknown/withheld/external targets cannot surface unpublished metadata. |
| Shared lifecycle | Concurrent eligible requests initialize/download once. Dismiss A, focus B, then deliver A late: A cannot open or replace B's panel. Teardown releases the Worker; snapshot changes invalidate IDs/results. |
| Read-only and validation | The packaged WASM imports a valid snapshot and runs the real query. A test through the actual connection attempts a write and receives a read-only failure; in the isolated test, disabling `query_only` must still leave the imported DB read-only. Wrong digest/ID/version/schema, truncated data, and invalid operation arguments fail closed. A mock rejection is insufficient. |
| Failure and retry | Block DB fetch, WASM, or Worker startup separately; force a deadline. Each leaves static content/links usable, settles pending requests and shows no stale panel. Restore availability; a later explicit intent succeeds. No poisoned initialization promise remains. |
| Resource and CSP controls | Missing/misleading `Content-Length` does not bypass the decoded-byte cap; oversized data aborts before import. No off-origin assets, broadened CSP, unbounded request queue, or raw SQL message is accepted. |

Confirm a planted latency race is actually delivered before declaring its control
effective. Browser tests require a real executed browser run; skipped browser tests
and native SQLite checks do not establish this goal.

## Completion record

Not completed. Record implementation commit/PR, pinned WASM version, nonzero browser
results, CSP/network evidence, read-only control, failure/retry/race observations,
and exercised provisional limits. This record does not claim mobile UX acceptance.
