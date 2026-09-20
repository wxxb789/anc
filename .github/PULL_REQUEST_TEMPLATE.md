<!-- markdownlint-disable MD041 -->

## What this changes

<!-- One or two sentences. Link the goal, issue, or design section it serves. -->

## Why

<!-- The problem, the consumer it affects, and the observable outcome. -->

## Verification

<!-- The command or browser check you ran, and its result. -->

- [ ] `pnpm run verify` passes (Gitleaks version from `scripts/scan-secrets.ts` on `PATH`)
- [ ] `pnpm run build:fixture` passes when the change can reach a multi-entry gate
- [ ] Architecture or content-semantics changes update the owning document in `docs/core-design/` and the affected tests

## Privacy checklist

- [ ] No withheld note's body, title, excerpt, or path is added to an artifact, a log line, or a committed file
- [ ] No personal notes, credentials, local identifiers, or host filesystem paths are included
