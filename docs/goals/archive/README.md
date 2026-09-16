# Completed goals

Completed goals live here under their original `NNNN-short-name.md` filenames.
Each retains its completion date, implementation commit/PR and verification evidence.
Numbers are never reused. Active goals and lifecycle rules are in the
[goal index](../README.md).

| Goal | Completed | Evidence |
| --- | --- | --- |
| [0002 — Consistent static relationships](0002-consistent-static-relationships.md) | 2026-09-16 | Implementation commit `24cea57`, simplified in `3c7cb4f`, review fixes in `ba24f30` and `66ae50d`; `pnpm run verify` 64 files / 856 passed / 34 skipped, `pnpm run build:fixture` 64 files / 885 passed / 5 skipped, `pnpm run smoke:tarball` passed (`anc-0.1.0.tgz` sha256 `e48097b5…`); full record in the file. |
| [0003 — Reliable lazy previews](0003-reliable-lazy-previews.md) | 2026-09-16 | Implementation commit `948696e`, simplified in `d565428`; `pnpm run verify` 73 files / 896 passed / 34 skipped, `pnpm run build:fixture` 73 files / 925 passed / 5 skipped, `pnpm run smoke:tarball` passed (`anc-0.1.0.tgz` 388,215 bytes, sha256 `d0348a83…`); all six evaluation rows executed in real Chromium 151.0.7922.34 under the served CSP, with the full record in the file. |
| [0004 — Complete tag browsing](0004-complete-tag-browsing.md) | 2026-09-16 | Implementation commit `718700e`, review fixes `c119678`/`c401315`, PR #5; `pnpm run verify` 75 files / 923 passed / 34 skipped, `pnpm run build:fixture` 75 files / 952 passed / 5 skipped, `pnpm run smoke:tarball` passed (`anc-0.1.0.tgz` 388,754 bytes, sha256 `66a12a3a…`); all six evaluation rows gated natively over a real snapshot and in real Chromium 151.0.7922.34 under the served CSP, with the full record in the file. |
