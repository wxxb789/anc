# 0003 — Reliable lazy previews

Status: completed 2026-09-16. Created: 2026-09-14. Replaces part of
[0001](../0001-unified-public-query-model.md).

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
[Worker, integrity, CSP and lifecycle contract](../../core-design/build-and-runtime.md)
and [preview query semantics](../../core-design/sqlite-contract.md).

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
| Correct content | Previews match the DB and static page, including empty excerpts, author-ordered/shared aliases, CJK and emoji. Non-alphabetical aliases are not sorted. A target whose language differs from the page marks its metadata with the correct `lang`, including default-language fallback. Unknown/withheld/external targets cannot surface unpublished metadata. |
| Shared lifecycle | Concurrent eligible requests initialize/download once. Dismiss A, focus B, then deliver A late: A cannot open or replace B's panel. Teardown releases the Worker; snapshot changes invalidate IDs/results. |
| Read-only and validation | The packaged WASM imports a valid snapshot and runs the real query. A test through the actual connection attempts a write and receives a read-only failure; in the isolated test, disabling `query_only` must still leave the imported DB read-only. Wrong digest/ID/version/schema, truncated data, and invalid operation arguments fail closed. A mock rejection is insufficient. |
| Failure and retry | Block DB fetch, WASM, or Worker startup separately; force a deadline. Each leaves static content/links usable, settles pending requests and shows no stale panel. Restore availability; a later explicit intent succeeds. No poisoned initialization promise remains. |
| Resource and CSP controls | Missing/misleading `Content-Length` does not bypass the decoded-byte cap; oversized data aborts before import. No off-origin assets, broadened CSP, unbounded request queue, or raw SQL message is accepted. |

Confirm a planted latency race is actually delivered before declaring its control
effective. Browser tests require a real executed browser run; skipped browser tests
and native SQLite checks do not establish this goal.

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

Remaining gaps found while implementing: the provisional finite limits
(`WORKER_LIMITS`) are exercised on correctness fixtures only; goal 0008 owns
validating them on the benchmark workloads. No CI/Action browser run is recorded.

## Completion record

Completed 2026-09-16. Implementation commit `948696e` on branch
`feat/0003-reliable-lazy-previews` (local; no remote PR), based on `main`
`c149ccc` (the merged 0002 tag-surface work). This completion adds the row-level
browser evidence the goal's table requires; it does not change the accepted
architecture.

### Design changes this completion required

Three findings surfaced while building the row evidence. Each is a clean-design
alignment, not a test workaround.

- **Shared aliases are metadata.** `docs/core-design/content-semantics.md` owns
  the rule: aliases are "not alternate resolver targets, routes, globally unique
  names, or graph nodes" and "the same alias may belong to different notes". The
  shipped producer contradicted it — `aliasConflictsFor` (`src/lib/schema.ts`)
  and the `alias-collision` refusal (`scripts/markdown-to-artifact.ts`) rejected
  any corpus with a repeated alias or an alias equal to another note's slug, and
  `docs/adoption.md` documented that refusal. Row 2 names shared aliases, so the
  canonical design won: the cross-entry check is deleted (the SQLite projection's
  per-note `(node_id, alias)` uniqueness is unchanged), the
  `alias-collides-with-other-entry` invalid fixture and its rejection row are
  deleted, a positive schema test and a producer acceptance test replace them,
  the adoption paragraph states the current rule, and the `alias-heavy` fixture's
  own prose no longer documents the removed check.
- **Truncation fails closed at the import boundary.** SQLite tolerates a partial
  final page, so `importSnapshot` accepted a snapshot with one byte removed and
  handed out a working handle (`PRAGMA integrity_check` still `ok`). The
  production path was already safe — `load` verifies SHA-256 before import — but
  row 4 requires truncated data to fail closed at the import boundary too. The
  import now compares the SQLite header's page size times `PRAGMA page_count`
  with the received byte length and refuses a mismatch with `format`. The page
  size is read from the file header rather than `PRAGMA page_size`, because the
  pinned WASM build reports its compile-time default for a freshly deserialized
  database.
- **Teardown releases the Worker, and a refused constructor settles.** The
  lifecycle contract requires disposing the Worker on teardown; the client had
  no such path. `snapshot-client.ts` now exposes `dispose()`, registers it on
  `pagehide`, rejects what it owed with `cancelled`, and returns a rejected
  promise (not a synchronous throw) when the Worker constructor refuses. The
  benchmark measurement seam is guarded so the Node client gate can load the
  module.

### Commands and observed results

| Command | Observed |
| --- | --- |
| `pnpm run verify` | **73 test files passed, 896 passed / 34 skipped**, exit 0. Build chain: search index 10 pages, output inventory 150 files, secret scan 150 files / 0 findings, residue scan 33 files / 0 findings. |
| `pnpm run build:fixture` | **73 test files, 925 passed / 5 skipped**, exit 0, `fixture build ok: every gate passed against tests/fixtures/valid-corpus.json`. Build chain: search index 54 pages, output inventory 227 files, secret scan 227 files / 0 findings, residue scan 33 files / 0 findings; the published build was then restored (inventory 150 files, search 10 pages). |
| `pnpm run smoke:tarball` | exit 0, `tarball adoption smoke ok: 1 published note, 2 withheld notes`; tarball `anc-0.1.0.tgz`, 388,215 bytes, sha256 `d0348a8338d6b13e6b53ba99a83d9181a9941ed13079791e637507d6458ef3f5`. |

Browser: Playwright 1.62.1 with real Chromium **151.0.7922.34**; every browser
gate below launched it, and no gate skips when Chromium is absent. Pinned
runtime `@sqlite.org/sqlite-wasm@3.53.4-build1`. The gates assert and print the
same-origin runtime paths they exercised:
`/_astro/snapshot-worker-<hash>.js`, `/data/site.<64 hex>.sqlite`,
`/wasm/sqlite3.<64 hex>.wasm`, and the pinned module entry `/wasm/sqlite-wasm.js`.
The published corpus carries
`/data/site.9fc2794fe518c3d39e30b107fa1b75a5805bff119bac536b0cfc745b6405634d.sqlite`
(40,960 bytes) and
`/wasm/sqlite3.2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752.wasm`;
the fixture corpus carries
`/data/site.dbabe2565a4c31975d319041268cd91afd19c46f864e4e1cc5c19753866c982c.sqlite`.

### Evaluation rows

1. **Intent and lazy cost — `tests/preview-intent.test.ts` (1 test, real
   Chromium).** Load, full-page scroll including the graph region, and 300 ms of
   idle produce zero requests matching the instrument (DB, WASM, or Worker
   chunk); the graph control was visible before the scroll as a positive
   control, and the request list is non-empty only after hover. A 60 ms-old
   hover has not opened the panel; the panel appears after the 120 ms intent
   delay. Keyboard Tab focus opens it with the focused note's content. Clicking
   the link performs a real navigation to `/notes/beta/`. Every request is
   same-origin.
2. **Correct content — `tests/preview-content.test.ts` (4 tests, real
   Chromium).** Each panel's `strong` starts with the DB title and contains every
   DB alias verbatim in ordinal order (non-alphabetical), and its `p` equals the
   DB excerpt exactly, including the empty excerpt. The same alias on `emoji` and
   `shared` appears in both panels while each note's private CJK alias stays out
   of the other's; `/notes/zh/` marks title and excerpt `lang="zh-CN"`, and the
   default-language targets carry no redundant `lang`. CJK/emoji survive as the
   same code points. The static pages fetched by Node carry the same titles and
   alias sequences as the DB. The withheld note has no node, its title and body
   are absent from the snapshot text, and its `/private/` link never previews;
   the unknown route never previews and `example.com` is never requested.
3. **Shared lifecycle — `tests/preview-lifecycle.test.ts` (6 tests, real
   Chromium) and `tests/snapshot-client.test.ts` (7 tests, Node over the real
   client module and a fake Worker).** Two concurrent hovers on a held DB
   response produce exactly one DB request, one WASM request, one Worker chunk
   request, and one Worker; the hold is confirmed delivered before the
   assertion. Hover A is held, the pointer dismisses it, keyboard focus opens B,
   and releasing A afterwards neither opens nor replaces B's panel — the
   recorded visibility timeline ends at B and A's delivery timestamp is later
   than B's first visibility. `pagehide` terminates the Worker, settles the owed
   request without a panel, and a later intent starts a live Worker. A rebuilt
   snapshot served at the same origin changes the bound digest: the reloaded
   document requests only the new DB and previews the new title. The Node gate
   drives the real client: one Worker for concurrent requests, the pending bound
   rejects `busy`, deadlines reject `timeout` and terminate, a late reply from a
   torn-down Worker is discarded, `dispose()` rejects `cancelled` and
   reinitializes, a crashed Worker rejects every pending request and the next
   intent builds a replacement, and a throwing Worker constructor yields a
   rejected promise rather than a throw.
4. **Read-only and validation — `tests/preview-integrity.test.ts` (3 tests,
   real Chromium driving the built Worker chunk) and `tests/snapshot-wasm.test.ts`
   (5 tests over the pinned WASM).** A `preview` through the packaged runtime
   deep-equals the row `snapshotNotes` reads from the same DB. The real DB bytes
   with one bit flipped are refused with `integrity`, static reading is intact,
   and a later hover previews. Malformed messages (missing slug, `sql`
   operation, bad page size, path-shaped slug) return only `{code,id,ok}` with
   no SQL text or path, an ignored extra field is never executed or echoed, and
   the connection still answers a valid preview. Through the product's own
   `importSnapshot`: a write after `PRAGMA query_only = OFF` throws
   `SQLITE_READONLY`; foreign `application_id`, foreign `user_version`, a renamed
   table, and truncated bytes (a 128-byte prefix, all but the last byte) each
   fail closed and leave no handle open.
5. **Failure and retry — `tests/preview-failure.test.ts` (4 tests, real
   Chromium).** A blocked WASM download, a Worker chunk that never loads, a
   Worker constructor that throws, and a Worker that never answers (forced past
   `requestDeadlineMs`) each leave the static article and anchor usable, show no
   panel and no stale `aria-describedby`, and settle. Each restores availability
   and a later explicit intent previews; the deadline case terminates exactly the
   unresponsive Worker once and a later intent starts a live one, so no poisoned
   initialization promise remains. `pageerror` stays empty throughout.
6. **Resource and CSP controls — `tests/preview-limits.test.ts` (6 tests, real
   Chromium) and `tests/snapshot-fetch-bounded.test.ts` (10 tests over real HTTP
   streams).** An oversized snapshot body (`maxSnapshotBytes + 1`, with a
   misleading `Content-Length: 64`) is refused with `integrity` while patched
   `WebAssembly.instantiate/compile/instantiateStreaming` counters stay at zero,
   so the cap aborts before import; restoring the bytes lets the next hover
   preview. An oversized WASM body is refused at `maxWasmBytes` with the same
   zero-instantiation counter. The bounded fetch enforces the decoded cap against
   chunked bodies with no `Content-Length`, a lying small length, and an honest
   larger one, aborting the stream instead of buffering it; a large claimed
   length with a small body fails closed; 500 and redirect responses reject
   `fetch`; an aborted signal cancels the read mid-stream, and a response with no
   readable stream still enforces the cap on its buffered body. The served
   `Content-Security-Policy` equals `public/_headers`, an injected inline script
   is blocked with a recorded `securitypolicyviolation`,
   normal previewing produces none, and every request in the session is
   same-origin. The request queue bound is enforced by row 3's Node gate.

### Exercised provisional limits (`WORKER_LIMITS`)

`maxSnapshotBytes` and `maxWasmBytes` are exercised by the oversized browser
gates and the bounded-fetch cases; `maxPendingRequests` by the Node client gate;
`requestDeadlineMs` by the forced-deadline browser gate; `startupDeadlineMs` by
the same client gate's deadline test. The numeric policies are
correctness-fixture evidence, as the goal requires; 0008 owns validating or
replacing them on the benchmark workloads.

### Simplification pass (2026-09-16)

A behavior-preserving `ce-simplify-code` pass followed in commit `d565428`,
from three parallel reviews (reuse, quality, efficiency): the shared test
server now enforces a directory boundary rather than a string prefix, answers
malformed percent-encoding with 400, and streams file bodies with an explicit
Content-Length instead of buffering each request; the two duplicated
Worker/WASM probe blocks in `preview-limits` collapsed into one helper;
`preview-lifecycle` no longer rebuilds the beforeAll corpus for the
snapshot-replacement test; `focusByTab`, worker-termination counting, and page
error collection moved into `tests/support/browser-site.ts`; `snapshot-wasm`
initializes one WASM runtime for the file and restores its handle-accounting
wrapper; `preview-content`'s independent static fetches run concurrently; and
`snapshot-client`'s constructor-failure comment now matches the catch's scope.
One assertion changed rather than disappeared: the never-failing
`assert.ok(site.origin.length > 0, ...)` in `preview-lifecycle.test.ts` became a
browser-version `console.log`, so the file reports the browser it ran on without
an assertion that could not fail. `pnpm run verify` on `d565428` — 73 files, 896
passed / 34 skipped, exit 0; oxlint 0 warnings/errors and `astro check` 0
errors — the counts were unchanged.

### Explicitly not claimed

No mobile UX or performance acceptance, no release authorization, no CI/Action
browser run (all browser evidence above is local real Chromium and recorded
here), and no claim that 0001's other successor goals are complete.
