/**
 * Row-aware secret scanning over the public snapshot.
 *
 * A credential can live in a SQLite value that no raw or gzip byte read spells:
 * a BLOB stored as gzip, or a value split across an overflow-page boundary. The
 * pinned Gitleaks must see the reconstructed text, so these gates plant each
 * shape and assert the scan fails for the right reason without printing the
 * secret, the digest, or a host path.
 *
 * Requires the pinned Gitleaks on `PATH`, as `tests/secret-scan.test.ts` does.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { DatabaseSync } from '../src/lib/sqlite.ts';
import { BuildFailure } from '../scripts/write-report.ts';
import { scanSecrets } from '../scripts/scan-secrets.ts';

const SECRET = 'ghp_4fJ9xQ2mN7vL5sT8yR1cW6kP3dH0bA9eZ7uC';

/** A scratch output carrying one digest-named snapshot and an entry page. */
function scratchWithSnapshot(build: (databasePath: string) => void): { directory: string; digest: string } {
  const directory = mkdtempSync(join(tmpdir(), 'anc-secret-db-'));
  const data = join(directory, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(directory, 'index.html'), '<h1>built</h1>\n', 'utf8');
  const plain = join(data, 'snapshot.sqlite');
  build(plain);
  const bytes = readFileSync(plain);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const named = join(data, `site.${digest}.sqlite`);
  writeFileSync(named, bytes);
  rmSync(plain);
  return { directory, digest };
}

function failure(run: () => unknown): BuildFailure {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof BuildFailure, `expected BuildFailure, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected the scan to throw');
}

test('a credential compressed into a BLOB is found through the row projection', () => {
  const { directory, digest } = scratchWithSnapshot((path) => {
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE bodies(markdown BLOB)');
    database.prepare('INSERT INTO bodies VALUES (?)').run(gzipSync(Buffer.from(`note body ${SECRET} end`)));
    database.close();
  });
  try {
    // The raw file must not spell it, so the finding can only come from rows.
    assert.ok(!readFileSync(join(directory, 'data', `site.${digest}.sqlite`)).includes(SECRET), 'the fixture is not row-only');
    const error = failure(() => scanSecrets(directory));
    assert.equal(error.code, 'secret-scan-findings');
    assert.match(error.detail ?? '', /the site snapshot \(data\/\), reconstructed rows/);
    assert.ok(!(error.message + (error.detail ?? '')).includes(SECRET), 'the scan printed the secret');
    assert.ok(!(error.message + (error.detail ?? '')).includes(digest), 'the scan printed the content digest');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a plain credential in a row is found and never printed', () => {
  const { directory, digest } = scratchWithSnapshot((path) => {
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE notes(markdown TEXT)');
    database.prepare('INSERT INTO notes VALUES (?)').run(`live ${SECRET} value`);
    database.close();
  });
  try {
    const error = failure(() => scanSecrets(directory));
    assert.equal(error.code, 'secret-scan-findings');
    assert.ok(!(error.message + (error.detail ?? '')).includes(SECRET));
    assert.ok(!(error.message + (error.detail ?? '')).includes(digest));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unreadable snapshot fails closed without touching the artifact', () => {
  const { directory, digest } = scratchWithSnapshot((path) => {
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE notes(markdown TEXT)');
    database.close();
  });
  const file = join(directory, 'data', `site.${digest}.sqlite`);
  writeFileSync(file, Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.from('garbage-not-a-database')]));
  try {
    const before = readdirSync(join(directory, 'data')).sort();
    const size = statSync(file).size;
    const error = failure(() => scanSecrets(directory));
    assert.equal(error.code, 'secret-scan-input-unreadable');
    assert.deepEqual(readdirSync(join(directory, 'data')).sort(), before, 'the scan created a sidecar');
    assert.equal(statSync(file).size, size, 'the scan modified the artifact');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      assert.ok(!readdirSync(join(directory, 'data')).some((name) => name.endsWith(suffix)), `created ${suffix}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
