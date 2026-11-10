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

## Qualified measurement campaign (2026-11-11)

Clean tree at `2ce506f`; candidate `@wxxb789/anc@0.0.3` installed from a tarball that
`pnpm run pack:tarball` reproduces byte-for-byte (504,986 B, sha256
`d9176a5244998244a58e297631c441dd3c662ffa3e90e00c5fff06ec76fdbe3a`), so the measured
package is reconstructible from the recorded tree. Instrument:
`scripts/benchmark-snapshot.ts` and `scripts/benchmark-limits.ts`, source hash recorded
in every report. Browser: **Chrome 157.0.8103.38**, device profile Pixel 7, CPU
throttled 4x — Chrome is one of the two accepted emulation targets and this host has no
Edge build; the goal's acceptance covers "Chrome or Edge mobile device emulation", so
no physical device was used. Network is loopback. 30 samples per measurement.

| Workload | Build | DB decoded | DB gzip | Cold preview | Warm preview | Local p95 | Global render p95 | Tag p95 | Failures |
|---|---|---|---|---|---|---|---|---|---|
| 100-sparse | 5.2s | 64.0 KiB | 14.2 KiB | 407 ms | 220 ms | **13.4 ms** | 140 ms | 124 ms | 0 |
| 100-hub | 5.1s | 64.0 KiB | 13.9 KiB | 441 ms | 224 ms | **13.7 ms** | 143 ms | 117 ms | 0 |
| 1000-sparse | 14.1s | 420.0 KiB | 124.8 KiB | 409 ms | 220 ms | **13.5 ms** | 179 ms | 48 ms | 0 |
| 1000-hub | 13.2s | 416.0 KiB | 124.8 KiB | 407 ms | 251 ms | **21.7 ms** | 325 ms | 60 ms | 0 |
| 10000-sparse | 265.4s | 3872.0 KiB | 1078.4 KiB | 409 ms | 231 ms | **13.8 ms** | 395 ms | 292 ms | 0 |
| 10000-hub | 258.9s | 3880.0 KiB | 1081.5 KiB | 423 ms | 217 ms | **14.9 ms** | 408 ms | 295 ms | 0 |

Local neighbourhood p95 (dispatch to validated Worker result, the 50 ms target) stays
between 13.4 ms and 21.7 ms across all six workloads; the Worker-side operation alone
stays under 7 ms. Graph drawing and the unfiltered global graph are reported separately
and are **not** part of that target: they reach 395 ms (sparse) and
408 ms (hub) at 10,000 notes, with tag browsing at
292/295 ms. This is the material UX trade-off the
maintainer has to accept or reject explicitly.

Cold preview (empty HTTP cache, fresh context) is
407-441 ms and does not grow with corpus size — it pays the Worker start-up (fetch,
digest, SQLite WASM init, module import). Warm preview is 217-251 ms.

The cost paid on first intent at 10,000 notes is the cold dependency transfer, 8
requests totalling **6,040.5 KiB decoded / 1,838.0 KiB gzip**:

| Component | Files | Decoded | gzip |
|---|---|---|---|
| snapshot DB | 1 | 3,880.0 KiB | 1,081.5 KiB |
| sqlite3 WASM binary | 1 | 848.5 KiB | 394.1 KiB |
| sqlite3 WASM glue | 3 | 1,280.5 KiB | 350.9 KiB |
| snapshot Worker chunk | 1 | 18.1 KiB | 5.9 KiB |
| snapshot client scripts | 2 | 13.3 KiB | 5.5 KiB |

Ordinary reading requests none of it before intent: with JavaScript disabled the page
transferred 14,460 B; with JavaScript enabled but no intent, 25,422 B. That 10,962 B
difference is the script overhead of reading, **not** the snapshot cost — the snapshot
and Worker assets are the 6,040.5 KiB above, and `zeroRequests` is true for both the
reading page and the main page in all six reports.

Peak main-thread JS heap during the cold-intent window was 1,073.9 KiB; the Worker's
WASM linear memory was 8 MiB. Worker heap, process RSS and total peak memory remain
unobserved — the instrument says so and this record does not paper over it.

### Overload controls

All eight controls pass against both the checkout and the installed 0.0.3 package: snapshot cap aborts a 72 MiB body at 64.06 MiB with `code=integrity`;
WASM cap aborts a 10 MiB body at 8.06 MiB; the 20 s startup deadline terminates and
recovers; the 8 s query deadline drops and the client stays usable; page size 10,000
clamps to 200; the rendering policy holds local 12/15 and global 60/573; the pending
bound admits 16 and answers later requests `busy`; and `tests/snapshot-client.test.ts`
passes 7/7 as a child process with its JSON report parsed.

Running these controls found a real instrument defect: Vitest 5 writes
`--reporter=json` to `.vitest/json/output.json` instead of stdout, so the client-bound
control failed closed and its stray directory dirtied the tree, which the run reported
as benchmark identity drift. Fixed at `10e6cfd` (PR #42): the report is written to a
temp directory outside the repository, parsed from that file, removed in `finally`, and
`.vitest/` is ignored. The seven other controls passed before and after the fix, so the
change affects evidence capture only.

### Pre-SQLite baseline

`7579cc16a4320f7410b71e784587a01fdf14333d` **cannot supply the required comparison**: it
has no SQLite snapshot to verify against, so the finalized instrument rejects the
workload (`expected one finalized snapshot, found 0`, see the evidence table)
and no comparative latency exists or is claimed. Recorded instead as build shape on the
same seeded 10,000-note corpus: that tree emits 20,184 files / 217 MB (sparse) and
20,178 files / 218 MB (hub), with a 3.45 MB `content-index.json` and 3.8 MB listing
pages, against the candidate's 3880.0 KiB DB and pages that do not embed the corpus.

### Gates

`pnpm run lint` clean; `pnpm run check` 0/0; build, snapshot/wasm binding, search index
(10 pages), inventory (150 files), secret scan (0 findings) and residue scan (0 findings)
pass; suite 100 files / **1,254 passed** / 35 skipped at `--maxWorkers=1` (the default
4-worker `pnpm run verify` was OOM-killed twice on this 7.88 GiB host after the
non-test gates had passed); `pack:tarball` reproduces the measured sha256;
`smoke:tarball` ok (2 published, 2 withheld, 8 images). CI on `2ce506f` is green.

### Evidence

Raw reports stay out of the tree (the repository keeps measurement output in the private
workspace, not in commits); these hashes pin what was measured:

| Report | Size | sha256 |
|---|---|---|
| `id-pkg-100-sparse.json` | 92,026 B | `254a43e7ad1c2aff…` |
| `id-pkg-100-hub.json` | 91,999 B | `09a9ddd0813ead92…` |
| `id-pkg-1000-sparse.json` | 111,171 B | `741a08b3c17ef357…` |
| `id-pkg-1000-hub.json` | 111,391 B | `2e4e9999cd5cf956…` |
| `id-pkg-10000-sparse.json` | 204,034 B | `290482f4787a11a9…` |
| `id-pkg-10000-hub.json` | 204,131 B | `f882853b51225b5e…` |
| `limits-checkout.json` | 17,828 B | `3128a1dfd48964f1…` |
| `limits-packaged.json` | 19,439 B | `18a7d529f014ccc2…` |
| `baseline-probe-100.json` | 8,353 B | `8f6022784cc2f5e1…` |
| `baseline-build-10000-sparse.json` | 1,667 B | `191bb28dc63765d2…` |
| `baseline-build-10000-hub.json` | 1,661 B | `ff8d657425b39bd0…` |

## Completion record

Measured and qualified; **awaiting the maintainer's dated acceptance** of this exact
candidate, the finite policies above and the material UX trade-off (global graph
395-408 ms and tag browsing
292-295 ms at 10,000 notes, cold preview
407-441 ms). The goal's own terms make that acceptance the last
open item; it is not self-granted.
