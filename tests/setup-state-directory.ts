/**
 * Point every test's state directory at a scratch path, once, for the whole run.
 *
 * `scripts/write-report.ts` writes `content-report.json` under the user's state
 * directory when a build has no git directory to put it in — which is every
 * scratch corpus a gate builds. Without this, a suite run leaves one directory
 * per `mkdtemp` path in the real `%LOCALAPPDATA%\publish-report\` (or
 * `$XDG_STATE_HOME`), and this repository's own suite is what filled that
 * directory with over a thousand keys on the development host.
 *
 * **The growth is not a defect in the reports.** The key is
 * `sha256(realpath(cwd))` — a pure function of the path, verified — so a user
 * building the same repository repeatedly reuses one key, and CI gets a stable
 * checkout path and so one key per repository. Only a suite that builds from a
 * fresh temporary directory every run produces a fresh key every run, and that
 * is legitimate behaviour observed from the wrong side.
 *
 * **Here rather than in each gate**, because "every test that spawns the binary
 * remembers to redirect two environment variables" is the shape this project
 * has been bitten by repeatedly: it is green until somebody writes the next gate
 * and forgets. Seven test files spawn the binary today and one redirected.
 *
 * Both spellings are set because `write-report.ts` reads `XDG_STATE_HOME` first
 * and falls back to `LOCALAPPDATA`, so setting one leaves the other live on the
 * platform that uses it. A gate that wants to assert *about* the state
 * directory overrides these per spawn, as `tests/report-gates.test.ts` does —
 * it passes its own scratch path and reads back from it, which still works
 * because a per-spawn `env` wins over the inherited one.
 *
 * The directory is created under the OS temp root rather than inside the
 * repository: a state directory in the working tree is one `git add -A` from
 * being committed, and it would carry the paths of every scratch corpus the
 * suite built.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = mkdtempSync(join(tmpdir(), 'publish-suite-state-'));

process.env['XDG_STATE_HOME'] = state;
process.env['LOCALAPPDATA'] = state;
