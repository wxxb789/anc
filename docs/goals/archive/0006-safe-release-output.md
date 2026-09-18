# 0006 — Safe release output

Status: completed 2026-09-17. Created: 2026-09-14. Replaces part of
[0001](../0001-unified-public-query-model.md).

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
[publication semantics](../../core-design/content-semantics.md),
[staging and preview-recognition contract](../../core-design/build-and-runtime.md),
and [verification contract](../../core-design/verification-and-evolution.md).
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

Remaining gaps found while implementing: release qualification, failed-build
preservation, and concurrent-build isolation were exercised by the existing gates
and by `smoke:tarball`, but were not individually re-verified for this record;
the new positive controls covered the reconstructed-row path, the raw free-page
path, and an unreadable artifact that must fail without a sidecar. All three
were closed on 2026-09-17; see the completion record below.

## Implementation progress (2026-09-17)

Branch `feat/0006-safe-release-output`, PR #8. The work closed the three
remaining gaps directly and found one production defect on the way.

**Production change.** `scripts/verify-output-inventory.ts` and
`scripts/preview-site.ts` now refuse a WAL header and a `-wal`/`-shm`/`-journal`
sibling *before* opening the database. Measured before the change: a bogus
`-wal` sibling made SQLite attempt recovery on the read-only open, fail with
`attempt to write a readonly database`, and write a generated `-shm` file into
the directory being inspected — a "read-only" inspection that changed the
artifact's membership. Inventory refuses with
`output-inventory-snapshot-format`; preview refuses as
`preview-snapshot-format`. The scanner enumerator already refused WAL before any
open; this extends the same rule to the two surfaces that touch the artifact
directory directly.

**New and extended gates.**

- `tests/release-failure-preservation.test.ts` (new): a whole-tree hash over a
  real release build, errors injected at every externally reachable stage, and
  the first-failure preview refusal.
- `tests/publish-set-cli.test.ts`: removal and remove-then-reinclude against a
  committed ledger; a missing pinned scanner; a planted credential whose value,
  name, digest, and host path never reach a stream.
- `tests/output-inventory.test.ts`: a second digest-named snapshot, the
  schema and unreadable branches, journal sidecars, `_astro/*.map`, an extra
  wasm member, and the named private build files.
- `tests/preview-snapshot.test.ts`: multiple candidates, sidecar/WAL refusal,
  and a valid empty-corpus artifact produced by the production writer.
- `tests/deletion-roundtrip.test.ts`: the old digest-named snapshot is gone and
  the withheld body token is absent from raw bytes, inflated gzip members, and
  reconstructed rows after the rebuild.
- `tests/dist-lock.test.ts`: genuinely concurrent builds — the previous harness
  used `spawnSync` inside `Promise.all` and was serial in fact — with per-build
  snapshot digest and compiled binding identity.
- `tests/secret-scan-database.test.ts`: a Gitleaks overflow-boundary fixture
  built by measurement, and a WAL case for the secret scanner.
- `tests/database-residue.test.ts` and `tests/secret-scan-database.test.ts`: the
  scanner-only fixtures are now labelled explicitly.
- `tests/secret-scan.test.ts`: a credential inside an extensionless binary
  member is scanned, not classified out.

## Completion record

Completed 2026-09-17. Implementation commit `3e65a12` on branch
`feat/0006-safe-release-output`, PR #8; CI run `35231482566` green on
`3e65a12`, the last code commit. The goal file and index changes are a
docs-only follow-up.

### Commands and observed results

- `pnpm run verify` — 77 test files, **934 passed / 34 skipped**, exit 0. The
  same run's build chain reported `snapshot bound: /data/site.9fc2794f…sqlite`,
  `output inventory ok: 150 files`, `secret scan ok: 150 files, 0 findings`,
  `residue scan ok: 33 files, 0 findings`.
- `pnpm run build:fixture` — 54 built pages, `output inventory ok: 227 files`,
  `secret scan ok: 227 files, 0 findings`, **963 passed / 5 skipped**, exit 0.
- `pnpm run smoke:tarball` — `tarball adoption smoke ok: 1 published note, 2 withheld notes`; tarball `anc-0.1.0.tgz`, 392,745 bytes, sha256 `dc1d98578d6e5a94369a404929ece29c38a292fa3f4b69c4d6e1cce3cb74b8d0`.
- Scanner pin: `gitleaks version` reports exactly `8.30.1`
  (`scripts/scan-secrets.ts` exports `GITLEAKS_VERSION`; CI and the composite
  Action install that checksum-pinned archive before any scan). A missing or
  mismatched scanner fails before scanning; the release entry point calls
  `scanSecrets` before the residue scan and before copy-out.
- Published-corpus artifact identity (unchanged by this branch's tests; the
  filename digest equals the file's bytes): `dist/data/site.9fc2794fe518c3d39e30b107fa1b75a5805bff119bac536b0cfc745b6405634d.sqlite`,
  40,960 bytes; `dist/wasm/sqlite3.2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752.wasm`,
  868,907 bytes, pinned `@sqlite.org/sqlite-wasm@3.53.4-build1`.

### Evidence by evaluation

| Evaluation | Gate | Expected vs observed |
| --- | --- | --- |
| Reviewed set | `tests/publish-set-review.test.ts`, `tests/publish-set-cli.test.ts` (8 tests), `scripts/smoke-tarball.ts`, `tests/config.test.ts` | A missing ledger, an untracked/staged/modified ledger, an added slug, and a removal each fail (`/no reviewed publish set/`, `/must be committed and unchanged/`, `/1 added, 0 removed/`, `/0 added, 1 removed/`); a shrunken ledger committed and then re-included fails as a new addition rather than inheriting approval; a matching committed set builds with `origin: https://notes.example.org/` and the pinned scanner; a loopback/missing origin is refused. The public stream carries counts only — the note names (`alpha`, `beta`) never appear. |
| Exact output | `tests/output-inventory.test.ts` (11 tests), `tests/legacy-payload.test.ts`, `tests/preview-snapshot.test.ts` (8 tests), `tests/snapshot-contract.test.ts`, `tests/copy-snapshot` coverage in the same file | A second `data/site.<64hex>.sqlite` is `output-inventory-mismatch` (`1 unexpected`, name only in `detail`); a digest-consistent snapshot with a dropped index is `output-inventory-snapshot-schema`; an over-path-cap member is `-unreadable` with directory membership unchanged; `-wal`/`-shm`/`-journal` siblings are `-snapshot-format` before any open, and no `-shm` is generated; `_astro/*.map`, `wasm/unexpected.wasm`, `content.json`, `binding.json`, `content-report.json` are unexpected with the name only in `detail`; legacy JSON names fail by their own gate. Preview refuses zero candidates, two candidates (`preview-directory-not-an-artifact`, count in `detail`), a wrong digest, wrong `application_id`/`user_version`, unreadable pages, and a WAL header/sidecar; it accepts an empty-corpus artifact produced by `buildSnapshotFromEntries({version: 1, entries: []})` + `copySnapshotToOutput`, whose `SELECT count(*) FROM nodes` is 0. |
| Both text policies | `tests/database-residue.test.ts` (13 tests), `tests/secret-scan-database.test.ts` (5 tests), `tests/secret-scan.test.ts` (7 tests), `tests/snapshot-rows.test.ts` | Residue finds an overflow-split absolute path while the raw file satisfies no byte of the rule (the fixture keeps only rows whose file bytes do not match the rule's own expression); Gitleaks finds a `ghp_` PAT split across an overflow boundary while the raw file does not spell it, and the finding is attributed to `the site snapshot (data/), reconstructed rows`; the gzip-BLOB and plain-row cases are the existing controls. Raw-byte coverage: raw and inflated members are scanned by both policies (2 findings in `secret-scan.test.ts`; free-page and gzip-DB cases in residue). A credential inside an extensionless binary member is found, so no file-kind classification can skip it. |
| Read-only inspection | `tests/snapshot-rows.test.ts`, `tests/database-residue.test.ts`, `tests/secret-scan-database.test.ts`, `tests/output-inventory.test.ts`, `tests/preview-snapshot.test.ts` | After each refusal the artifact's directory membership and byte sizes are unchanged and no `-wal`/`-shm`/`-journal` is created; a WAL-declaring snapshot fails as `secret-scan-input-unreadable` (`/rollback-journal/`) before any open; unreadable/unknown-schema inputs fail closed. Measured defect and fix: the inventory/preview pre-open checks above (a `-wal` sibling had generated a `-shm` in the inspected directory). |
| No hidden failure path | `tests/database-residue.test.ts` (recorded mutation), `tests/secret-scan-database.test.ts` (mutation re-measured 2026-09-17), `tests/verify.test.ts`, `tests/secret-scan.test.ts`, `tests/disclosure.test.ts` | Blinding the row path reds each scanner's positive control; unreadable output, a failed scanner start, empty output, and zero coverage all fail rather than reporting clean; `BuildFailure.message`/`detail` redaction is asserted at the function level and over the real CLI streams (a corpus-rename differential is byte-equal, and a release with a planted credential prints only counts). |
| Withdrawal | `tests/deletion-roundtrip.test.ts` (extended), `tests/backlink-surfaces.test.ts`, `tests/preview-content.test.ts`, `tests/tag-browser.test.ts` | A fresh rebuild removes the note's route, feed/sitemap entry, Pagefind record, `nodes` row, incident edges, aliases, and the tag only it used, while other notes remain; `data/` holds exactly one snapshot, named differently, and the old digest-named file is gone; after the rebuild the withheld body token is absent from every raw file, every inflated gzip member (Pagefind fragments included), and `snapshotText`, with positive controls proving each surface was read. |
| Failed-build preservation | `tests/release-failure-preservation.test.ts` (5 tests), `tests/publish-set-cli.test.ts`, `tests/output-inventory.test.ts`, `tests/dist-lock.test.ts` (5 tests), `tests/build-workspace.test.ts` | Malformed frontmatter (discovery), `/home/<token>/` (residue), and a `ghp_` PAT (secret scan) each exit 1 with the prior whole-tree hash byte-identical; the hash is proven stable across two consecutive successful builds (`66945cf378a4d9eaeb5c738d4aef8b9b6d5cf85338e087fcf1205ffe06d1f4df` for that fixture) and covers >10 files including the snapshot. The DB-copy and inventory injections live at the module level (copy digest refusal; digest/schema/unreadable branches) and share the staging boundary before copy-out. A first failed build leaves no output directory, and `preview --dist` exits non-zero with `preview-directory-not-found`. Two genuinely concurrent builds (measured overlap ≈12.8 s) produce distinct snapshot digests, each filename digest equals its bytes, each compiled binding names only its own snapshot, and neither output carries the other's token. |

### Controls (mutation evidence)

Each mutation was applied to one production file, the named gate observed red, and
the file restored to its byte-identical pre-mutation content (sha256 checked).

| Mutation | Red gate |
| --- | --- |
| `scan-secrets.ts`: drop the `.rows` write, leaving the raw copy | `tests/secret-scan-database.test.ts` overflow boundary: the scan reports clean and the expected finding is absent |
| `snapshot-rows.ts`: disable the WAL refusal | `tests/snapshot-rows.test.ts` WAL case and `tests/secret-scan-database.test.ts` WAL case both red |
| `verify-output-inventory.ts`: disable the pre-open WAL/sidecar checks | `tests/output-inventory.test.ts` journal/sidecar case: not refused as a format problem |
| `preview-site.ts`: disable the pre-open WAL/sidecar checks | `tests/preview-snapshot.test.ts` WAL header/sidecar case |
| `publish-set-review.ts`: make the precise-set comparison unconditional | `tests/publish-set-cli.test.ts` removal/re-inclusion: the re-included slug builds instead of failing |
| `bin/anc.mjs`: promote (delete `out`) before the gates | `tests/release-failure-preservation.test.ts` residue case: prior output replaced |
| `verify-output-inventory.ts`: skip `assertSnapshotRows` | `tests/output-inventory.test.ts` schema branch accepted the mutated snapshot |
| `tests/dist-lock.test.ts` harness made serial | overlap assertion red (latest start before earliest exit) |
| `tests/dist-lock.test.ts` corpus both use one token | snapshot-digest equality red |
| `tests/dist-lock.test.ts` binding expectation swapped | compiled-binding assertion red |
| `tests/deletion-roundtrip.test.ts` fixture drops `publish: false` | gate red; the token appeared in 5 published files |
| `tests/preview-snapshot.test.ts` stimulus removed | 2 gates red (count refusal and empty-corpus acceptance) |

### Redacted stream comparisons

- Missing scanner: exit 1, stderr exactly `secret scan requires Gitleaks 8.30.1`;
  the combined streams contain no secret, note name, or host path.
- Planted credential with Gitleaks 8.30.1: exit 1, stderr exactly
  `secret scan found 10 findings`; the combined streams contain neither the
  token nor `ghp_`, the note's name, the snapshot digest, or the temporary
  repository path.
- Changed publish set: stderr `release blocked: publish set changed (1 added, 0
  removed); run anc review, inspect the diff, and commit it`; the note name does
  not appear on either stream.
- `tests/disclosure.test.ts` keeps the rendered-stream differential: two corpora
  differing only in names produce byte-identical streams for a clean build, a
  content-contract failure, and a residue failure.

### Carried limitations and explicit non-claims

- DB-copy and output-inventory failures have no command-line switch. Their
  injection evidence is at the production-function level
  (`tests/output-inventory.test.ts`), and the end-to-end argument is positional:
  both run inside the per-run staging workspace before the copy-out, so no
  failure in them can touch the prior output. The three CLI-injectable stages are
  proven byte-for-byte.
- Promotion is still `rm` + `mkdir` + `cp` after every gate, not an atomic
  rename. A hard kill inside copy-out is outside the goal's four injection
  stages and is recorded, not claimed fixed; preview recognition still requires
  exactly one snapshot plus `index.html`, so the window in which it could accept
  a copy in progress is heartbeat-scale.
- The scanner-only overflow fixtures deliberately exceed the shipped snapshot's
  metadata bounds and are labelled as such in both test files; they make no claim
  about what the build emits.
- "Unknown binaries cannot silently count as scanned": the residue scanner fails
  closed by reporting an unclassifiable file as a finding; the secret projection
  has no classification step and copies every regular file as bytes for both the
  raw and inflated passes, which the extensionless-member gate measures.
  Gitleaks' own size limit is disabled (`--max-target-megabytes 0`) and its decode
  depth is pinned at 1.
- The goal's completion is not release authorization, and no claim is made about
  data already downloaded by visitors or crawlers.
- [0007](0007-independent-publisher-adoption.md) and
  [0008](../0008-acceptable-browser-cost.md) remain active. Deployment, registry
  publication, and post-deploy smoke tests remain external, separately approved
  actions.
