# 0001 — Unified public query model

Status: ready. Created: 2026-09-13.

## Desired outcome

ANC's real generated site and installable package provide previews, backlinks,
outgoing links, tag queries, and graph exploration through the single SQLite/WASM
read model defined by [core design](../core-design/README.md). Static reading,
navigation, and accessible relationship surfaces remain usable without JavaScript
or when the enhancement fails. There is no competing public relational/preview
index or page-body delivery path.

This is a required capability for the first 0.1.0 release, not a later optional
phase. Its completion does not claim that all other release requirements are met.

## Current evidence and bounds

At reviewed commit `7579cc16a4320f7410b71e784587a01fdf14333d`, the implementation
uses serialized `outgoing/backlinks` and `content-index.json`; browser SQLite is
not implemented. That is a starting observation, not an interface to preserve.

Follow the long-term core-design contracts for data ownership, authoring/publication
semantics, exact schema, query behavior, snapshot binding, Worker lifecycle and
verification. No backward compatibility is required: replace superseded producers,
consumers, tests and docs together. No legacy loader, migration adapter, dual-write
path, old-schema reader or public JSON compatibility output is part of completion.

Deployment and registry publication are outside this goal. Pagefind remains the
full-text index; Markdown remains canonical; the DB contains no page body. There
is no requirement for another runtime service, a framework migration, arbitrary
SQL input, browser persistence or a new authoring feature.

## Completion evidence

The goal is complete when the built output and packaged foreign-repository path
meet the [invariant evidence matrix](../core-design/verification-and-evolution.md),
with results attached to the implementation PR and recorded here. In particular:

- Static and Worker queries agree with the published corpus, including tags,
  aliases, withheld/missing targets, same-page links, reciprocal edges, cycles,
  neighbor-to-neighbor edges, empty graphs and high-degree notes.
- Preview, fixture builds, packaged builds, CLI preview recognition, output
  inventory and binary-aware scans use the accepted DB contract. Superseded public
  JSON outputs and serialized relation authorities are absent.
- Real browser evidence proves lazy loading, read-only queries, CSP behavior,
  shared initialization, retry after failure and intact static/accessible fallback.
- The chosen runtime and packaged JS/WASM work without undeclared dependencies;
  two equivalent fresh builds produce the same DB bytes under the pinned toolchain.
- Existing applicable verification and new invariant gates run and pass; skipped
  or unavailable checks are explicitly unresolved, not silently counted as passed.
- The performance evidence below is present, finite runtime policies are recorded,
  and the maintainer has accepted cold-preview behavior on the stated comparison.

## Performance evidence and acceptance

Measure generated corpora of 100, 1,000, and 10,000 notes. Record node/edge/tag/alias
counts and distributions, text lengths, and sparse versus hub-heavy topology.
Use the same corpus for any alternative comparison. A graph with 10,000 isolated
notes does not exercise backlink or neighborhood behavior.

Record browser/version, OS, device/CPU/RAM, network/encoding, cache state, toolchain,
sample count, raw measurements, and summary statistics. A desktop CPU throttle is
not evidence of a physical mid-range phone; label simulations and measure a named
mobile device for the mobile gate.

Required measurements are DB decoded bytes and compressed transfer; JS/Worker/WASM
transfer; peak memory during fetch/hash/import and when ready; cold initialization;
cold first preview from eligible intent to visible panel, with hover delay separate;
warm preview, backlinks, tag and one-hop/induced graph query latency; and graph
rendering cost separate from SQL/Worker messaging. Ordinary reading requests zero
SQLite assets and incurs no SQLite initial-render regression.

The existing warm local-neighborhood target is p95 below 50 ms after Worker
readiness on a named mid-range mobile device, with corpus and sample method recorded.
Historical 2 MB warning / 5 MB hard database thresholds were explicitly voided;
they are not acceptance thresholds for this goal.

Cold first-preview acceptability and memory/download/deadline limits require
measurements. The implementation PR must record measured results, proposed finite
runtime policies, and the maintainer's UX acceptance against the starting preview
on the same corpus/device. This comparison measures a trade-off; it does not
require preserving or shipping the old implementation. Missing evidence cannot
be called a passed goal or used to defer SQLite beyond the first release.

If cold preview is unacceptable, a different public projection is allowed only
through the core design's evidence-based change procedure. It is not an implied
fallback or a compatibility exception.

## Completion record

Not completed. When complete, record the implementation commit/PR, dated results,
benchmark artifacts, maintainer acceptance and material limitations, then move
this file unchanged in identity to `archive/` and update the goal index.
