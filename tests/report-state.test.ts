/** No-git reports are private state, but not unbounded state. */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  STATE_REPORT_MAX_AGE_MS,
  STATE_REPORT_MAX_PROJECTS,
  pruneStateReports,
} from '../scripts/write-report.ts';

function put(root: string, key: string, modified: number): void {
  const directory = join(root, key);
  const report = join(directory, 'content-report.json');
  mkdirSync(directory, { recursive: true });
  writeFileSync(report, '{}\n', 'utf8');
  const date = new Date(modified);
  utimesSync(report, date, date);
  utimesSync(directory, date, date);
}

test('state report retention keeps the current project and the newest bounded set', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-state-cap-'));
  try {
    const now = Date.UTC(2026, 7, 20);
    const current = 'ffffffffffffffff';
    put(root, current, now - STATE_REPORT_MAX_AGE_MS * 2);
    for (let index = 0; index < STATE_REPORT_MAX_PROJECTS + 8; index += 1) {
      put(root, index.toString(16).padStart(16, '0'), now - index * 1000);
    }
    mkdirSync(join(root, 'user-owned-name'), { recursive: true });

    pruneStateReports(root, current, now);

    const names = readdirSync(root).sort();
    const managed = names.filter((name) => /^[a-f0-9]{16}$/.test(name));
    assert.equal(managed.length, STATE_REPORT_MAX_PROJECTS);
    assert.ok(managed.includes(current), 'the current project was pruned because its prior report was old');
    assert.ok(names.includes('user-owned-name'), 'an unfamiliar state entry was deleted');
    assert.ok(!managed.includes((STATE_REPORT_MAX_PROJECTS + 7).toString(16).padStart(16, '0')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('state report retention expires old managed projects without touching fresh ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-state-age-'));
  try {
    const now = Date.UTC(2026, 7, 20);
    const old = '0000000000000001';
    const fresh = '0000000000000002';
    put(root, old, now - STATE_REPORT_MAX_AGE_MS - 1);
    put(root, fresh, now - STATE_REPORT_MAX_AGE_MS + 1);

    pruneStateReports(root, 'ffffffffffffffff', now);

    const names = readdirSync(root);
    assert.ok(!names.includes(old));
    assert.ok(names.includes(fresh));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
