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

The inherited warm local-neighborhood target is p95 **below 50 ms** under a named
Chrome-family mobile device-emulation profile after Worker readiness. Interpret it
as request dispatch to validated Worker result, including messaging, selection and
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

Record commit/tarball hash, instrument source hashes, browser channel/version, OS,
host CPU/RAM, the named emulation profile and its user agent, viewport, screen,
device scale factor, mobile/touch flags, network, cache definitions, sample counts,
repetitions, quantile method, raw observations and summaries. Cold means no ready
Worker/DB and empty relevant HTTP cache; warm means the same ready snapshot.
Preserve failures, timeouts and OOMs in results; do not calculate an apparently
passing p95 after silently removing them.

The maintainer accepted Chrome or Edge mobile device emulation as the supported
mobile judgment on 2026-09-18; a physical Android device and `adb` are not required.
State CPU and network throttling separately and do not describe emulation as
physical hardware. Use the same exact fixture identity and emulation configuration
for comparison with the pre-SQLite preview at commit
`7579cc16a4320f7410b71e784587a01fdf14333d`; this does not require shipping that code.
If the baseline cannot build a workload, record that limitation rather than
silently simplifying the corpus or fabricating a comparative latency.

The maintainer's recorded acceptance must identify the measured candidate,
comparison, finite policies and material UX trade-off. Lack of access to a suitable
supported browser or acceptance authority leaves this goal open; it does not reopen
settled architecture choices or postpone SQLite beyond 0.1.0.

## Implementation progress (2026-09-19)

The measurement and overload instruments are implemented, but no current report is
completion evidence yet. Review found several ways the earlier instruments could
pass without observing the required result. Those paths have been hardened, and
the pre-fix reports are retained only as diagnostic history until the finalized
instrument is committed and rerun from a clean tree.

### Instrument

- `scripts/benchmark-snapshot.ts` generates exact published-node workloads while
  retaining withheld notes and records the generator, seed, fixture identity,
  degree distributions and material SQLite field-length distributions. Preview
  measurement requires a confirmed hidden transition and a newly appended result
  for the requested slug. Render series require one finite event per activation;
  tag walks must enumerate the exact DB membership and exhaust their continuation;
  local, global and tag-filtered graph replies are compared with an independently
  derived DB-row oracle, including exact ranked nodes, directed induced edges and
  omitted counts.
- The snapshot server precomputes encoded bodies before browser intent, preserves
  actual request start and end offsets, and rejects listen failures into the
  partial-report path. Candidate identity covers repository and CLI bytes, the
  installed package, its complete runtime dependency tree, the lockfile, a bound
  tarball when supplied, Node and package-manager versions, and is rechecked at
  material boundaries.
- `scripts/benchmark-limits.ts` accepts the same strict `--cli`, browser and device
  selection as the snapshot runner. Its page-size control refuses an unsaturated
  corpus; the pending-request control waits for all held requests to settle and
  proves a fresh request succeeds through the same client and Worker; unreadable
  child-test output fails closed; listen failures still produce a private partial
  report. The local rendering fixture must exceed `LOCAL_NODE_LIMIT` before that
  control can pass.
- `src/lib/worker-protocol.ts`, `src/scripts/snapshot-worker.ts` and
  `src/scripts/snapshot-client.ts` carry the opt-in measurement seam. The owning
  Worker protocol design records its literal boolean opt-in, numeric-only result
  fields, Goal 0008 consumer and ablation result. Ordinary readers remain on the
  unchanged request/reply path.
- Repository-only benchmark runners and helpers are excluded from the installable
  tarball, whose production dependency set does not include Playwright.

### Invalidated diagnostic runs

The 2026-09-18 six-workload Edge/Pixel 7 run, paired pre-SQLite comparison, limits
run and npm-installed-package run all preceded the finalized instrument and used a
dirty candidate. In addition, the cited limits report recorded 11 local neighbours
against a limit of 12, so it did not exercise local truncation even though it was
described as a passing overload control. Their latencies, hashes and 7/7 claim are
not completion evidence and must not be used for acceptance.

### Verification before the qualified rerun

On the working tree, lint, type checking, focused benchmark and packaging tests,
the normal build, tarball compilation and diff checks pass. These checks establish
the implementation shape; they do not replace the clean-tree browser measurements.

### Still required

Commit the finalized instrument, then rerun the six 100/1,000/10,000-note sparse
and hub-heavy workloads under the accepted Edge/Pixel 7 profile, the paired
pre-SQLite baseline, every overload control against both the checkout and the
npm-installed tarball, and the full release gates. Record only reports whose
candidate/instrument identity stays stable and whose failure arrays are empty.
Then record the maintainer's dated acceptance of the exact candidate, finite
policies, cold-preview cost and material limitations. Mobile evidence remains
browser emulation; CPU throttling applies to the page target rather than the
Worker; loopback network is not a physical mobile network; and Worker heap,
process RSS and total peak memory remain unavailable.

## Completion record

Not completed. The implementation is awaiting clean-tree qualified measurements
and the maintainer acceptance named above.
