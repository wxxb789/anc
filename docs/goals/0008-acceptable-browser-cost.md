# 0008 — Acceptable browser cost

Status: ready. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

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

## Implementation progress (2026-09-15)

The functional prerequisites (0002–0007) are implemented and their gates pass on
this host, but **this goal's own measurement and acceptance cannot be produced
here**: it requires a named physical mid-range mobile device for the p95 target
and a recorded maintainer decision accepting the cold-preview/resource policies.
Neither the device nor the acceptance authority is available in this
environment, so no number is invented and the goal stays open. A benchmark
harness and desktop-throttled numbers can be added, but they are labeled
simulation and do not satisfy the mobile judgment.

**Measured 2026-09-15** with `pnpm run benchmark:snapshot --sizes
100,1000,10000 --topologies sparse,hub --samples 30 --throttle 4` (desktop
Chromium, CDP `Emulation.setCPUThrottlingRate=4`, nearest-rank p95, JS-heap-only
memory). Warm local-neighbourhood p95, after the 10,000-note local query was
changed from a whole-corpus edge scan to a query over the selected endpoints:
100 sparse 12.7 ms / hub 17.4 ms; 1,000 sparse 13.5 ms / hub 17.5 ms; 10,000
sparse 12.7 ms / hub 20.8 ms. Cold preview ~370-394 ms, warm ~226-253 ms;
decoded DB 48 KiB/200 KiB/1.6 MiB and gzip 6.5/54/371 KiB. This holds under a
**simulation** on this host; the physical mid-range mobile device and the
recorded maintainer acceptance below are still required and are not satisfied by
these numbers. The pre-optimization run measured 82 ms / 162 ms at 10,000, so the
ablation of the endpoint-restricted query is the difference between failing and
holding at the largest workload.

## Completion record

Not completed. Record reproducible benchmark command/tool, candidate identity, raw
artifact links, per-workload results, mobile evidence, overload-control outcomes,
and dated maintainer acceptance. Any added optimization must also record what its
ablation loses; measurements alone do not authorize a new public index.
