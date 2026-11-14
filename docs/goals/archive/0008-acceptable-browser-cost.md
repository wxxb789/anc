# 0008 — Acceptable browser cost

Status: completed 2026-11-11. Created: 2026-09-14. Replaces part of [0001](../0001-unified-public-query-model.md).

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
[0007](0007-independent-publisher-adoption.md), including 0002–0006. Follow
[runtime limits](../../core-design/build-and-runtime.md) and
[ablation/change rules](../../core-design/verification-and-evolution.md).

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
no physical device was used. Network is loopback.

Sample populations are not uniform, and each number is labelled by what it actually is:

| Measurement | Population |
|---|---|
| Build (per workload) | 1 |
| Preview cold / warm (per workload) | 1 observation each |
| Local-graph dispatch and SQL (UI, per workload) | 30 samples, exact count asserted |
| Global graph, unfiltered and tag-filtered (UI) | 1 render each |
| Tag browse (UI) | 10 / 100 / 1,000 dispatches at 100 / 1,000 / 10,000 notes |
| Driver queries: local, backlinks, outgoing, byTag, global | 30 samples each (byTag 30 / 150 / 350) |
| Reading, JS disabled and JS enabled without intent | 1 observation each |
| Startup heap / Worker WASM memory | 1 observation |
| Overload controls | 1 controlled run per control, bounds asserted |

| Workload | Build | DB decoded | DB gzip | Cold preview (1) | Warm preview (1) | Local p95 (n=30) | Global render (1) | Tag p95 (n=10/100/1,000) | Failures |
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
and are **not** part of that target: a single unfiltered render costs 395 ms (sparse) and
408 ms (hub) at 10,000 notes, and tag browsing — p95 over 1,000 dispatches at that size —
costs 292/295 ms. The global figure is one observation per workload, not a percentile. This is the material UX trade-off the
maintainer has to accept or reject explicitly.

Cold preview (empty HTTP cache, fresh context) is
407-441 ms and does not grow with corpus size — it pays the Worker start-up (fetch,
digest, SQLite WASM init, module import). Warm preview is 217-251 ms.

Two different quantities, kept apart. The **shipped inventory** for the seam is 8 files,
6,040.5 KiB decoded / 1,838.0 KiB gzip; the **observed first-intent transfer** is 4 of them,
**1,652.8 KiB over the wire / 5,374.4 KiB decoded** (10,000/hub):

| Component | Shipped | Requested on first intent | Wire bytes | Decoded |
|---|---|---|---|---|
| snapshot DB | 1 | 1 | 1,081.5 KiB | 3,880.0 KiB |
| sqlite3 WASM binary | 1 | 1 | 394.1 KiB | 848.5 KiB |
| sqlite3 WASM glue | 3 | 1 | 171.3 KiB | 627.7 KiB |
| snapshot Worker chunk | 1 | 1 | 5.9 KiB | 18.1 KiB |
| snapshot client scripts | 2 | 0 | — | — |

The other two glue files (`sqlite3-opfs-async-proxy.js`, `sqlite3-worker1.mjs`, 668,447 B
decoded together) stay `not-requested`, and the two client scripts load during ordinary
reading (started at 1,242 ms and 1,325 ms on a page load), which is why reading's resource
count is 7. The baseline figure that is comparable to 1,652.8 KiB is the 596,853 B the
pre-SQLite preview actually fetched, not that tree's artifact inventory.

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

### Pre-SQLite baseline comparison

`7579cc16a4320f7410b71e784587a01fdf14333d` has no SQLite oracle, so the snapshot instrument
rejects it (`expected one finalized snapshot, found 0`) — but that tree **does** build and it
**does** have a preview: `src/scripts/link-preview.ts` lazily fetches `/content-index.json` on
first hover, filters in JS and renders into `#link-preview`. The required comparison was
therefore measured with a purpose-built Playwright probe (archived with the campaign reports,
not committed to the tree: sha256 `999d09f746653379…`) on the same seeded corpus with exactly 10,000
published notes, the same Chrome channel, Pixel 7 profile, CPU 4x throttle and loopback
server, measuring the same observable as the candidate: hover a same-origin note link, wait
for the panel to be visible with the target note's title (a title mismatch counts as a
failure; there were none).

The two instruments do not share a clock origin, and the first version of this
section compared them as if they did. Correction, 2026-11-11: the candidate's
`intentToVisibleMs` is taken in Node — `Date.now()` around `page.locator(...).hover()` and
`page.locator('#link-preview').waitFor()` in `scripts/benchmark-workload-ui.ts` — which pays
Playwright's actionability checks, scroll-into-view and polling detection. The baseline
probe sets `probe.intentAt = performance.now()` in the page immediately before
`page.mouse.move()` (`baseline-preview/probe.mjs`). The candidate instrument records the
matching page-clock observation in the same sample as `hoverDelayMs`; the baseline probe
records no Node-side clock at all. Comparing the two Node-side totals therefore produced a
90-106 ms "regression" that is instrument residue, not product cost.

| 10,000 notes, page clock (pointerover -> panel visible with the target title) | Pre-SQLite `7579cc1` | Candidate 0.0.3 |
|---|---|---|
| Cold intent-to-visible, including the 120 ms delay | 513 ms sparse / 512 ms hub (1 observation) | 285.8 / 269.0 ms (1 observation) |
| Warm, including the 120 ms delay | 125.0 / 125.1 ms (p50, n=30) | 124.4 / 124.5 ms (1 observation) |
| Warm p95 | 125.9 / 134.1 ms (n=30) | not applicable (1 observation) |
| Fetched on first preview (observed) | 3,452,503 B decoded / 603,098 B encoded, one JSON index | 5,503,343 B decoded / 1,692,447 B encoded, 4 requests (inventory 6,040.5 KiB / 1,838.0 KiB) |

The candidate's Node-side totals (409/441 ms cold, 217/251 ms warm) stay in the reports as
the harness figure: they sit 142-195 ms cold and 92-126 ms warm above the page clock, and no
claim here uses them.

Read on one clock: **warm preview is at parity** (124.4-124.5 ms against 125.0-125.1 ms,
inside one observation's resolution) and **cold preview is 226-244 ms faster** at 10,000
notes. The trade that remains is transfer: 2.8x the bytes on the first preview, 603 KB ->
1,692 KB encoded. At 1,000 notes the pre-SQLite path still wins cold (176.1 ms against
240.5-244.4 ms) because the candidate pays a fixed ~150 ms Worker start that does not scale
with the corpus; the crossover sits between 1,000 and 10,000 notes.

At this size the largest remaining costs are the unfiltered global graph first open
(356.5 / 381.7 ms end-to-end: 128.8 / 137.0 ms of Worker start plus a 209.9 / 224.5 ms
query, with the figure and its accessible table rendering in 21.6 / 34.5 ms) and tag
browsing (292-295 ms p95 over 1,000 dispatches, which is page-side list growth — the query
stays under 1 ms).

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
| `probe.mjs` (baseline preview probe) | 23,429 B | `999d09f746653379…` |
| `baseline-preview-10000-sparse.json` | 9,704 B | `ae0ff283ac0cf9b0…` |
| `baseline-preview-10000-hub.json` | 9,681 B | `e62600db06682a0f…` |
| `baseline-build-10000-hub.json` | 1,661 B | `ff8d657425b39bd0…` |

## Completion record

Accepted 2026-11-11 by the maintainer (`wxxb789`), who recorded that the new design
direction is the better one and accepted `@wxxb789/anc@0.0.3` on it. The acceptance covers:

- candidate: `@wxxb789/anc@0.0.3`, tarball sha256 `d9176a52…` reproduced from `2ce506f`,
  instrument at `405ff6f`;
- the inherited warm local-neighbourhood target (dispatch -> validated Worker result, p95
  below 50 ms) holds in every workload; the worst case is 21.7 ms (10,000/hub);
- first preview at 10,000 notes: 269-286 ms cold on the page clock against 512-513 ms before
  SQLite — 226-244 ms faster — and warm at parity with the previous preview (124.4-124.5 ms
  against 125.0-125.1 ms);
- the transfer cost accepted with it: 1,692 KB encoded / 5,503 KB decoded on the first
  preview (2.8x the previous 603 KB), while ordinary reading requests no `/data/`, `/wasm/`
  or Worker asset before intent and pays none of it;
- the stated limits: Chrome-family mobile emulation rather than hardware, CPU throttle on
  the page target only (the Worker target is not independently throttled), loopback network
  rather than a mobile-network claim, and no Worker-heap, process-RSS or total-peak memory
  figure;
- the material costs recorded above: global graph first open 356.5-381.7 ms end-to-end, tag
  browsing 292-295 ms p95 at 10,000 notes.

Not opened: a goal for the warm-preview difference. The 2026-11-11 review of this comparison
found it to be two instruments' clocks rather than a product regression, with warm preview at
parity on the page clock; the remaining work on those two numbers is the global-graph query
and the tag-list DOM, tracked on the performance board rather than as a preview regression.

## Addendum 2026-11-12 — the two costs this goal left open

The completion record above named two costs it did not fix: tag browsing at 292-295 ms p95
over 1,000 continuations at 10,000 notes, and the global graph's first open at 356.5-381.7 ms
end-to-end. Both were tracked on the performance board as work items rather than as preview
regressions. They landed together in PR #46 (squash `d48dc19`, base `97d6565`).

### What changed

- **Tag list** — the enhanced list renders a window of `TAG_WINDOW_SIZE = 120` logical rows and
  positions it from scroll geometry, with at least one viewport of measured heights above and
  below the viewport so no spacer can enter it. Every rendered row carries
  `aria-setsize`/`aria-posinset` and the list's counter starts at `--tag-window-start`, so the
  visible marker, the ARIA position and the logical position agree. The static no-JS route is
  detached after the first successful page and restored on any failure path, which also stops
  10,000 hidden nodes from costing a layout on every continuation.
- **Row geometry** — titles wrap, so row heights differ. Positioning reads the rendered rows'
  rects and keeps a per-index height index (two Fenwick trees: heights and a count of measured
  rows) so the released-range spacers and the "which row covers this offset" query are O(log n)
  in the logical position instead of O(n). A width change invalidates every height and rebuilds
  the index around the rows still in the DOM before the same pass queries it.
- **Global graph** — `globalGraph()` asks SQLite for candidates at or above the 60th-highest
  degree instead of materialising every node row plus a corpus-wide degree aggregate.
  `rankGlobal` remains the single ordering authority, including the title/slug tie-break;
  corpora no larger than the limit, and degree sets too small to fill it, fall back to the full
  candidate list so isolated notes are never dropped from the title-ordered remainder.

### Measured

Same host as the 0008 campaign (4 vCPU / 7.7 GiB), Chrome 157, Pixel 7 emulation, CPU throttle
4x on the page target, loopback network, seeded corpus (seed 7), sparse topology. The
before-column is this goal's own recorded campaign; the after-column is the packaged tarball of
the merged tree, measured by the same probe, twice each for 1,000 and once for 10,000.

| measurement | before (0.0.3) | after (PR #46) |
| --- | --- | --- |
| Tag continuation p95, 1,000 notes | 10.1 ms at 100 rendered rows growing to 57.2 ms at 1,000 | **22.7 ms**, growth 0.94x |
| Tag continuation p95, 10,000 notes | 292-295 ms p95 over 1,000 continuations | **24.3 ms**, growth 0.64x |
| Rendered rows at 10,000 notes | grows with the list (2,510 at position 2,510) | **121** (120 rows + 1 spacer) |
| Global graph warm Worker operation, 10,000 | 224.5 ms | **40.3 p50 / 50.4 p95 ms** (card bound 60) |
| Global graph first unfiltered end-to-end, 10,000 | 356.5-381.7 ms | 263.0 ms |

The drawn global set is identical to the pre-change algorithm on every corpus and tag
(`eq-graph.mjs`: unfiltered and five tags over the 10,000-note atlas, plus a dense-degree-tie
corpus and a mixed corpus; every row `equal: true`). `tests/graph-global-bounded.test.ts`
compares the bounded result against the pre-change algorithm shape, including a degree tie that
straddles the cutoff and a title pair (astral U+20000 versus PUA U+E000) that sorts differently
under SQLite's BINARY collation than under JavaScript's UTF-16 comparison.

### Limits

- Chrome-family mobile emulation and CPU throttle on the page target only, as in this goal's own
  campaign; no hardware device, no mobile-network claim, no Worker-heap or total-peak memory
  figure.
- The probe harness stops at 250 continuations, so the 10,000-note run covers logical position
  2,510. The bound that matters there is the growth ratio, and it is flat.
- One A/B round in a six-round comparison measured p95 57.0 ms while host load rose from 1.46 to
  2.53; the same tarball measured 23.5-36.6 ms in the other rounds and the pre-change build
  itself reached 63.9 ms in an earlier round. It is recorded here rather than averaged away.
- In-page find (Ctrl+F) reaches only the rendered window, which is the documented cost of a
  window; the complete list remains reachable by scrolling and exists in the static route.
- Chrome's accessibility tree did not expose `posinset` for the rendered `li` elements in the
  probe's AX snapshot although the DOM attributes are present and contiguous 1..n. What a
  screen reader actually receives from a windowed `ol` was then an open question; the
  2026-11-14 addendum below answers it (the CDP snapshot is not the AT-facing tree, and the
  announced list size was wrong until the membership count reached `aria-setsize`).

## Addendum 2026-11-14 — what a screen reader receives from the windowed tag list

The 2026-11-12 addendum closed with an unanswered question: its AX snapshot did not show
`posinset` for the rendered rows even though the DOM carried it, so the record claimed only the DOM
contract. This measures the accessibility tree and a real screen reader, and records the one
change the measurement produced.

### Method

| | |
|---|---|
| Corpus | `scripts/generate-corpus.ts`, seed 7, `sparse`, `metadata: true`: 1,092 generated files / **1,000 published**; every metadata note carries `笔记`, so the tag has **1,000 members** — nine windows |
| Build | this worktree's `node bin/anc.mjs build --content <corpus> --out <dist>`; residue scan 2,041 files, 0 findings |
| Browser | **Google Chrome 157.0.8103.38**, Playwright 1.64.1, headful under Xvfb, 1200×800 viewport, no CPU throttling |
| AT API | **AT-SPI2 2.52.0** (`at-spi2-core`), read with `python3-pyatspi` |
| Screen reader | **Orca 46.1** (GNOME 46), Speech Dispatcher 0.12.0-rc2 + espeak-ng. Utterances are the `SPEECH OUTPUT:` lines from Orca's own `--debug-file` log. There is no audio device on this host and no human listener; this is what Orca sent to its speech server, not a recording |
| Host | Ubuntu noble, 4 vCPU / 7.7 GiB, kernel 7.0.0-1017-azure, loopback static server |
| Probe | private workspace, not committed; each state below is one recorded run on the built site |

Places in the lists were produced by scrolling: `scrollTo(0)` (top; released range *after* the
window) and a jump to the list's top + 2500 px (deep; released ranges on **both** sides). Pages
were loaded until the logical list held 310-320 entries, so the window was always a strict subset
of the collection.

### What each surface exposes

Paged enhanced list, 310 loaded, window at top (`1..120`):

| Observation | CDP `Accessibility.getFullAXTree` | Playwright `ariaSnapshot` | AT-SPI2 (what Orca reads) | Static no-JS route |
|---|---|---|---|---|
| Container role | `list` (childCount 120) | `list` | `list` (childCount 120) | **none** — `div.note-grid` |
| Rendered items | 120 `listitem` (+5 nav) | 120 bare `listitem` | 120 `list item` | 1,000 `article` |
| `posinset` on items | **0 of 125** | absent | **`1..120` on every item** | absent |
| `setsize` on items | **absent** | absent | **`310` on every item** | absent |
| `setsize` on the list | absent | absent | **`310`** | — |
| Other item properties | `level: 1` only | — | `level`, `display`, `tag`, `text-align` | — |
| Programmatic count | 120 (childCount) | 120 | 310 (list `setsize`), childCount 120 | **none** (visible text `1000 notes`) |

The CDP tree and Playwright's snapshot are the same DevTools serialization, and both omit
`aria-posinset`/`aria-setsize` for `listitem` in Chrome 157 — implicit `<li>`, explicit
`role="listitem"`, `div[role=listitem]`, and `role="option"` all expose only `level`. **The
AT-facing AT-SPI tree exposes both attributes**, so the 2026-11-12 reading was an instrument
limit, not a missing contract. Do not use a CDP AX dump alone to judge what an AT receives.

At the deep position (window `39..158`, spacers on both sides) the same fields held: CDP 0 of 125
with `posinset`, AT-SPI `posinset 39..158`, `setsize 310`, list `setsize 310`.

### What Orca 46.1 actually said

| State | Utterance |
|---|---|
| First card link on the **static** route (JS disabled) | `Brief cloud quiet shadow field link.` |
| Focused enhanced row link (posinset 191, 310 loaded) | `潮汐名录：观测与记录 link.` — **no position** |
| List object, probe-only focus, 310 loaded, pre-fix | **`List with 310 items.`** |
| List object after one continuation (320 loaded), pre-fix | `List with 320 items.` (same-build control, attribute rewritten to the loaded count) |
| List object, 1,000-member tag, post-fix, 320 loaded | **`List with 1000 items.`** |
| Where Am I on a focused row link | `link Ridge copper shadow lantern.` — no position |

The static route has no list at all, so Orca announces no list and no count there; it announces
each card as heading/link. The enhanced route told a reader the tag held **310** notes when it held
**1,000**, and that number grew by ten on every "Load more".

The reading comes from Orca's own code, not a guess:
`scripts/web/speech_generator.py:482` takes the list's announced size from
`getSetSize(AXObject.get_child(obj, 0))` — the **first item's** `setsize` — and only falls back to
the rendered child count when it is absent (`:488`); `scripts/web/script_utilities.py:432` reads
the attribute, and `:2671` maps `setsize: -1` to "List of unknown size"
(`messages.py:2748`). So the one attribute that decides the announcement is `aria-setsize` on a
rendered row, and it was the loaded count.

The list-object utterances were elicited by giving the `<ol>` a temporary `tabindex="-1"` and
focusing it: the region is not focusable in the product, and this is a probe-only mutation to hear
the announcement Orca makes for that object. The long title run that precedes "List with …" is
Orca's name-from-contents for the focused container — an artifact of focusing a non-interactive
list, not something a reader hears while moving between links.

### The change

`byTag` now reports the tag's complete membership, and the enhanced list announces it.

- `SNAPSHOT_QUERIES.tagByKey` returns the membership count as `total` in the identity lookup it
  already performed: `(SELECT COUNT(*) FROM node_tags AS nt WHERE nt.tag_id = t.id)`.
- `TagPage`'s known shape gains `total`; `tagPage()` returns it.
- `src/scripts/tag-browser.ts` keeps `logicalTotal` from the first page and uses it for every
  row's `aria-setsize`. `entries.length` (what has loaded) no longer reaches the attribute.
- The benchmark instrument's tag assertion now compares `setsize` with the tag's DB membership
  (`scripts/benchmark-workload-ui.ts`), and `docs/core-design/sqlite-contract.md` records the
  count in the query-by-tag section.
- Gates: `tests/tag-query.test.ts` asserts the total on a non-exhausted page and at the tail;
  `tests/tag-browser-window.test.ts` asserts the announcement on page 1 and its stability across a
  continuation. With `src/scripts/tag-browser.ts` reverted, that file fails 3/4 with
  `the first page announced setsize 10, not 145`.

Result: **`List with 1000 items.`** from the first page on, unchanged by any continuation. The
per-item position ("191 of 1000") is still not spoken by Orca on link focus or Where Am I; Orca
keeps `posinset` for its positional path but the focused object is the link inside the item, so
nothing announces it. Fixing that would mean putting the position in every link's accessible
name, which this change does not do.

### Limits

- One screen reader, on Linux: **NVDA, JAWS, VoiceOver, TalkBack and Narrator were not exercised**.
  No speech audio was heard; the utterances are Orca's debug log.
- CDP and Playwright's `ariaSnapshot` do not expose the attributes that AT-SPI does; a claim about
  AT exposure must be made from AT-SPI (or a real AT), not from the DevTools tree.
- The list-size announcement was elicited with a probe-only `tabindex` on the list; a reader hears
  it on entering the list in browse mode, not by tabbing to it.
- The AT-SPI walker caps traversal at 4,000 nodes / depth 60, so the static route reads 980 of its
  1,000 articles (the DOM and CDP counts are exact).
- One corpus, one tag, one page size; no mobile or CPU-throttled profile, unlike this goal's own
  campaign. The count's query cost was not measured separately — it is one aggregate over the
  `node_tags` primary key inside the existing identity lookup.
- `total` is a public query-shape change. ANC is pre-0.1.0 and carries no compatibility shim;
  every consumer (client, tests, benchmark) moved in the same change.

## Addendum 2026-11-14 (later, cleanup) — no new AT campaign

The addendum above is the original empirical record of this increment: its AT-SPI table, Orca
utterances, AX-tree observations, corpus, and measured artifact are unchanged here, and nothing
below repeats that campaign or claims a new measurement of Orca, AT-SPI, or the browser. This
note records a post-completion cleanup of the same increment's code, comments, and docs, and the
revalidation actually run on the cleaned tree.

Cleanup applied (no reader-visible behaviour change):

- `src/scripts/tag-browser.ts`: `setSetsize` restated `aria-setsize` on rows that already received
  `logicalTotal` when they were created, and nothing else ever wrote a different size, so the
  helper and its two calls were deleted. `rowFor` now reads the `logicalTotal` closure it already
  depended on instead of taking a third parameter that had a single value. One narrowing of the
  known reply replaced the unreachable `: 0` fallback and the repeated `page.known` test.
- Comment-only consolidation in `src/lib/snapshot-queries.ts`, `scripts/benchmark-workload-ui.ts`,
  `tests/tag-browser-scroll.test.ts`, `tests/tag-browser-variable-rows.test.ts`, and
  `tests/tag-query.test.ts`: the announcement rationale is stated once, in this file and in the
  `TagPage` contract, instead of at every row, helper, and assertion.
- `tests/tag-query.test.ts` gained one assertion pairing `tagByKey`'s membership count with
  `tagMemberCount` for one authored tag, each against the hand-written membership: the two SQL
  spellings of one row set are now held equal.
- The private benchmark report's announced-size key was renamed `announcedSetsize`
  (`scripts/benchmark-workload-report.ts`, `scripts/benchmark-workload-ui.ts`), matching the value
  it holds. Nothing published or committed named the old key.

Two corrections inside the addendum above, neither of which moves a measurement:

- The Method row's "1,000 members — eight windows" is nine window positions: 8 × 120 = 960 is less
  than 1,000. The recorded membership, timings, artifact sizes, and hashes are as measured.
- The `setsize: -1` mapping is at `messages.py:2748` on the Orca 46.1-1ubuntu1 named above —
  `listItemCount`'s `_("List of unknown size")`; line 2740 is that function's own `def`. The
  mechanism and every other citation in that paragraph are unchanged.

`docs/core-design/build-and-runtime.md`'s Worker-boundary operation table now names the
membership count that crosses the boundary in the `byTag` reply.

Revalidation on the cleaned tree, 2026-11-14: `pnpm run lint` exit 0; `pnpm run check` exit 0
(0 errors, 2 pre-existing hints); focused tests
`pnpm exec vitest run tests/tag-browser-model.test.ts tests/tag-query.test.ts tests/graph-global-bounded.test.ts --maxWorkers=1`
passed 3 files / 17 tests; the four browser gates
(`tests/tag-browser-window.test.ts`, `tests/tag-browser-scroll.test.ts`,
`tests/tag-browser-variable-rows.test.ts`, `tests/tag-browser.test.ts`) passed 4 files / 21 tests
— window 4/4, scroll 4/4, variable-rows 1/1, tag-browser 12/12, the same tallies the change
recorded. Those gates rebuild a site from this source and read the rendered `aria-setsize`, so the
deleted restatement is covered where it mattered. No AT campaign was re-run and none of the
utterances, tables, or timings above were re-derived.
