# 0008 — Acceptable browser cost

Status: in progress. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

## Desired outcome

The real packaged SQLite enhancements are usable on the stated corpus/device
workloads, with measured cold and warm cost and justified finite resource limits.
The maintainer has accepted the first-preview trade-off against the previous
preview on comparable inputs. Normal reading pays no SQLite download/startup cost.

A benchmark report with unacceptable latency or missing mobile evidence does not
complete this goal. The outcome is acceptable behavior with defensible limits,
not the activity of collecting numbers. An unsuccessful result remains useful
evidence and leaves the goal open.

## Material bounds and prerequisite

Requires the actual packaged feature outcome of
[0007](archive/0007-independent-publisher-adoption.md), including 0002–0006. Follow
[runtime limits](../core-design/build-and-runtime.md) and
[ablation/change rules](../core-design/verification-and-evolution.md).

Measure 100, 1,000 and 10,000 published notes. For each size include sparse and
hub-heavy topology with real edges, tags, aliases and varied text, including CJK.
Record counts, degree distribution, field lengths, generator/seed and fixture
identity. These are evaluation workloads, not a new maximum corpus size.

The inherited warm local-neighborhood target is p95 **below 50 ms** on a named
representative mid-range mobile device after Worker readiness. Interpret it as
request dispatch to validated Worker result, including messaging, selection and
induced-edge extraction; report inner SQL separately and graph drawing separately.
The target must hold on each stated topology/size for the declared supported mobile
workload. Do not average away a failing large or hub-heavy case.

The historical 2 MB warning / 5 MB hard DB thresholds are void. No new cold-preview,
memory or transfer budget is invented here. Those policies require measurements
and recorded maintainer UX acceptance; functional goals use finite provisional
limits until that decision. No JSON fast path or body-in-DB exception is implied.

## Completion evidence

| Measurement | Required evidence |
| --- | --- |
| Transfer | DB decoded bytes and compressed wire cost; complete client/Worker/WASM dependency transfer. State HTTP encoding and cache state; missing `Content-Length` is not zero bytes. |
| Startup and memory | Fetch, hash, WASM initialization/import and ready timings; peak memory during startup and steady readiness. State whether the instrument measures process, JS heap or WASM memory, its uncertainty and known blind spots. JS heap alone is not total peak memory. |
| Preview | Cold eligible intent to visible correct panel, with hover delay separately reported; warm preview latency. A fast failure or absent panel is not a successful sample. |
| Queries and drawing | Backlink, outgoing, tag, local/induced and global/filtered query latency, page enumeration and Worker messaging; graph layout/render cost separately. Verify answers during measurement. |
| Ordinary reading | Network evidence of zero SQLite assets before intent and initial-render comparison with enhancements inactive under the same environment. Report meaningful observed regressions. |
| Limits and overload | Recorded finite decoded-byte, pending-request, page-size, startup/query deadline and rendering policies are enforced. Exceed each configured boundary and verify bounded failure, cleanup, static usability and successful later retry. |

Record commit/tarball hash, browser/version, OS, physical device/CPU/RAM, network,
cache definitions, sample counts, repetitions, quantile method, raw observations
and summaries. Cold means no ready Worker/DB and empty relevant HTTP cache; warm
means the same ready snapshot. Preserve failures, timeouts and OOMs in results;
do not calculate an apparently passing p95 after silently removing them.

Use a real named mobile device for the mobile judgment. CPU/network throttling
may supplement it but must be labeled simulation. Use the same corpus/device for
comparison with the pre-SQLite preview at commit
`7579cc16a4320f7410b71e784587a01fdf14333d`; this does not require shipping that code.
If the baseline cannot build a workload, record that limitation rather than
silently simplifying the corpus or fabricating a comparative latency.

The maintainer's recorded acceptance must identify the measured candidate,
comparison, finite policies and material UX trade-off. Lack of access to a suitable
device or acceptance authority leaves this goal open; it does not reopen settled
architecture choices or postpone SQLite beyond 0.1.0.

## Implementation progress (2026-09-18)

The instrument now covers every completion-evidence row and the delivered
runtime's finite policies were exceeded on this host. The physical mobile
judgment and the recorded maintainer acceptance below are still missing, so the
goal remains open.

### Instrument

- `scripts/benchmark-snapshot.ts` generates seeded 100/1,000/10,000-note corpora
  with `topology: sparse|skewed` and `metadata: true` (tags including `笔记`,
  per-note aliases, mixed-script headings), records generator/seed/fixture
  sha256 with DB row counts and degree/length distributions, serves `dist/`
  under per-path `_headers` with gzip negotiation, records page and Worker
  resource timing plus the decoded, gzip and wire cost of the DB, WASM binary,
  WASM glue and Worker chunk, reports `sqlMs` and load `phases` from the opt-in
  measurement seam, separates the observed hover delay from intent-to-visible,
  measures preview, backlinks, outgoing, byTag, local and global/filtered graph
  through UI flows and an armed driver Worker, verifies answers against the
  finalized DB, asserts zero SQLite requests before intent, compares the initial
  render with JavaScript disabled, and writes a partial report with preserved
  failures on any error.
- `scripts/benchmark-limits.ts` exceeds each configured boundary on the real
  build: 64 MiB+1 DB and 8 MiB+4 KiB WASM fail `integrity` with zero WASM
  instantiation, the static page stays usable and a later retry succeeds; the
  20 s startup and 8 s query deadlines terminate the Worker once, with no
  automatic retry, and a later intent rebuilds; the 17th concurrent request is
  rejected `busy` without dispatch while a shared instance stays shared; page
  size 10,000 clamps to 200 and a saturated CJK tag enumerates 200+85; the local
  bound draws 11/11 and the global bound 60/285.
- `src/lib/worker-protocol.ts`, `src/scripts/snapshot-worker.ts` and
  `src/scripts/snapshot-client.ts` carry the opt-in seam: an armed request sets
  `measure: true`; a measured reply adds numeric `sqlMs` and `phases
  {totalMs, fetchMs, digestMs, wasmInitMs, importMs, wasmMemoryBytes}`.
  Ordinary readers send and receive exactly what they did before.
- `scripts/generate-corpus.ts` gained `topology` and `metadata` options without
  changing default output; a golden digest test pins that.

### Measured 2026-09-18

Candidate: commit `2f7fa2d` (the measurement instruments were run from the same
tree before it was committed; the private reports record parent `66769ae4` plus
the CLI sha256). `pnpm run verify` was green before the run (81 files / 959
passed / 34 skipped).
Throttled simulation: CDP `Emulation.setCPUThrottlingRate = 4` on the page
target only, nearest-rank p95, 30 samples per query operation, six workloads,
none failed. Report `benchmark-snapshot-2026-09-18T09-11-04-644Z.json`
(sha256 `22fcf2c718e8…`) in the private report directory.

| workload | UI local p95 | driver local p95 | cold preview | warm preview |
| --- | --- | --- | --- | --- |
| 100 sparse | 16.5 ms | 6.0 ms | 968 ms | 238 ms |
| 100 hub | 12.3 ms | 4.5 ms | 977 ms | 237 ms |
| 1,000 sparse | 17.4 ms | 3.7 ms | 967 ms | 226 ms |
| 1,000 hub | 13.9 ms | 4.3 ms | 950 ms | 235 ms |
| 10,000 sparse | 14.6 ms | 3.9 ms | 1152 ms | 235 ms |
| 10,000 hub | 13.4 ms | 4.7 ms | 1167 ms | 237 ms |

Preview is one cold plus one warm sample per workload, not a p95. At 10,000 hub:
DB 3.72 MiB decoded / 1.04 MiB gzip wire, WASM 848.5 KiB, glue 627.7 KiB,
Worker chunk 17.6 KiB; warm startup phases fetch 41.1 / digest 6.0 / wasmInit
59.9 / import 13.2 ms with 8 MiB WASM memory; zero SQLite requests before
intent; JS-disabled versus active FCP 284 versus 188 ms with a +10,160 B
enhancement bundle. Program queries are reported separately and one is
materially slower than the local target: global graph p50 173 / p95 258.5 ms at
10,000 notes under the ×4 simulation (driver byTag p95 13.8 ms; UI byTag p95
34.2 ms). No failure was removed from any p95.

An unthrottled hub pass matches the baseline's conditions (30 samples, report
`benchmark-snapshot-2026-09-18T09-29-07-150Z.json`, sha256 `d49dddc14650…`):
page-observed warm hover-to-visible 121.5–122.4 ms versus the baseline's
123.2–124.7 ms; cold 357.8–506.9 ms versus 156.3–353.2 ms; FCP 92–248 ms versus
88–256 ms.

### Pre-SQLite baseline

Commit `7579cc16` installed and built all three sizes in a worktree (100: 8.2 s,
1,000: 20.5 s, 10,000: 327.2 s), so no build limitation is claimed. Its preview
is one `/content-index.json` fetch (2.83 MB decoded / 517 KB gzip at 10,000)
plus an in-memory lookup; it has no Worker or per-link query, so its warm figure
is the same hover-intent-to-visible total, not a dispatch-equivalent. On that
like-for-like page-observer basis, candidate warm preview is on par while cold
pays the Worker/WASM startup the baseline does not have. The worktree was
removed and the raw baseline observations are retained outside this repository.

### Packaged candidate

`pnpm run pack:tarball` produced `anc-0.1.0.tgz` (413,493 bytes, sha256
`edbf5c028a7d…`), installed with npm. The installed CLI measured 1,000/hub under
the ×4 simulation with 10 samples and no failures: UI local p95 16.1 ms, driver
local p95 8.4 ms, cold 982 ms, warm 239 ms; report
`benchmark-snapshot-candidate-1000-hub.json` (sha256 `618853ae4618…`).

### Still required

The named physical mid-range mobile device and the dated maintainer acceptance
of the finite policies and the cold-preview UX trade-off do not exist in this
environment, so the goal stays open. Known instrument limitations: cold/warm
preview is a single sample per workload; throttling is page-target simulation;
`ArrayBufferBytes` and process RSS are unavailable, so total peak memory is not
measured; the global graph at 10,000 notes is a quarter-second under the ×4
simulation.

## Completion record

Not completed. Recorded here: the reproducible commands and report identities
above, per-workload results, the baseline and packaged-candidate comparisons,
and the overload-control outcomes. Missing: physical mobile evidence and the
dated maintainer acceptance.
