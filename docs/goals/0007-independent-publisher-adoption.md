# 0007 — Independent publisher adoption

Status: ready. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

## Desired outcome

Someone outside this repository can install ANC's tarball, initialize and review
their own Markdown repository, create a qualified static build, preview it, and
use its SQLite-powered features. This works without the ANC source checkout,
undeclared development dependencies, personal fixture data or a runtime CDN.
The shipped GitHub Action produces the same kind of qualified artifact.

## Material bounds and prerequisites

Requires the functional outcomes [0002](0002-consistent-static-relationships.md),
[0003](0003-reliable-lazy-previews.md),
[0004](0004-complete-tag-browsing.md),
[0005](0005-interactive-graph-exploration.md), and the release protection in
[0006](0006-safe-release-output.md). Packaging must not declare those features
delivered when they work only in repository development mode.

Follow [technology/ownership](../core-design/architecture.md),
[snapshot/preview binding](../core-design/build-and-runtime.md), and
[adoption documentation](../adoption.md). Keep the chosen Node/toolchain requirement
consistent in engines, CLI, CI, Action and docs; prove the actual native SQLite APIs
on that runtime. Do not retain a lower historical minimum via a fallback driver.

Required Worker/JS/WASM ship with the package and generated output, with provenance,
correct URLs, MIME and hosting CSP/cache configuration. Preview remains loopback
and path-contained. A build needs no database service, cross-origin isolation or
credentials at browser runtime. Publishing to npm, merging or deploying the site
is not part of this local adoption goal.

## Completion evidence

Run `pnpm run pack:tarball` and `pnpm run smoke:tarball`. The smoke path must exercise
the current SQLite contract, not merely keep an old JSON assertion green. Record
the exact tarball digest, runtime/package-manager versions and test commands.

| Evaluation | Pass condition |
| --- | --- |
| Foreign repository | Install the tarball into a fresh synthetic git repository, outside the producer checkout's module ancestry. The shipped init/review/build/preview path produces that repository's notes, private report and exact reviewed public set. |
| Self-contained package | Compilation/install succeeds without borrowed dev packages or uncompiled package TypeScript. Required native API and WASM work on the declared runtime. No author's notes, public fixture index, build machine path or personal identity leaks into the site. |
| Real browser | Serve the resulting foreign build under the intended headers. Preview, tag enumeration and graph exploration work using only its own bound JS/WASM/DB; initial reading remains lazy and static fallback works when SQLite assets fail. |
| Recognition and transport | CLI preview accepts the correct completed output, rejects bad/multiple/missing DBs and path escape, and remains loopback. Worker/WASM have correct MIME; digest mismatch and stale-page/missing-snapshot scenarios fall back without substituting a different DB. |
| Host snapshot policy | Generated host configuration and an HTTP harness demonstrate immutable caching only for hashed assets, revalidation for HTML/stable assets, and actual CSP enforcement. Pagefind stable metadata is not made immutable wholesale. |
| Action parity | Exercise the shipped Action against a synthetic notes repository on its supported runner. It uses the chosen runtime, same publication gates and packaged assets; no separate weaker build chain or automatic deployment is introduced. A documentation-only inspection is not this run. |

Record whether each environment ran locally, in CI, or on another named supported
host. Do not claim an unexecuted platform matrix. A missing supported-runner or
browser run is unresolved evidence, not a reason to claim this goal completed.
Final mobile cost remains owned by 0008; this goal establishes usable distribution.

## Completion record

Not completed. Record implementation commit/PR, tarball hash, runtime versions,
successful foreign-repository commands and browser evidence, Action run URL/log,
negative controls and material supported-environment limitations.
