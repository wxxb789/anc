/**
 * Row-aware secret scanning over the public snapshot.
 *
 * A credential can live in a SQLite value that no raw or gzip byte read spells:
 * a BLOB stored as gzip, or a value split across an overflow-page boundary. The
 * pinned Gitleaks must see the reconstructed text, so these gates plant each
 * shape and assert the scan fails for the right reason without printing the
 * secret, the digest, or a host path.
 *
 * **Every fixture here is scanner-only.** They carry table and value shapes the
 * accepted snapshot never emits — a 9,000-byte body, a BLOB table — and exist
 * solely to prove the instrument reconstructs values the file's bytes do not
 * spell. They are labelled here rather than in each test so the boundary is one
 * sentence a reviewer can check against the shipped schema.
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

/**
 * A credential split across an overflow-page boundary is found through rows.
 *
 * **Scanner-only fixture.** A 9,000-byte row and a table named `notes` are
 * shapes the accepted snapshot never emits — its values are short metadata
 * strings — so this fixture exists only to make the reconstructed-row member
 * the only surface that spells the credential. It is built by measurement, not
 * arithmetic: each candidate offset is written, the file is read back, and the
 * row is accepted only when no byte of the file spells the credential, so the
 * gate asserts a measured shape rather than a believed one.
 *
 * **Mutation watched fail:** deleting the `.rows` write in `projection()`
 * (`scripts/scan-secrets.ts`) leaves the raw copy as the only member; the
 * credential is absent from it by construction, so the scan reports clean and
 * this test fails on the expected `secret-scan-findings`.
 */
test('a credential split across an overflow-page boundary is found through the row projection', () => {
  const total = 9_000;
  const { directory, digest } = scratchWithSnapshot((path) => {
    let accepted = false;
    for (let at = 100; at < total - SECRET.length - 100 && !accepted; at += 1) {
      rmSync(path, { force: true });
      const database = new DatabaseSync(path);
      database.exec('PRAGMA page_size=4096');
      // The sweep creates and deletes one database per offset; with the default
      // journal and fsync it spends ~24 s on 678 attempts and approaches the
      // test timeout on a slow host. Journal and sync do not enter the accepted
      // bytes — the assertion below reads the final file and requires it not to
      // spell the credential — and measured, the accepted database is
      // byte-identical with them off at ~86x the speed.
      database.exec('PRAGMA journal_mode=OFF');
      database.exec('PRAGMA synchronous=OFF');
      database.exec('CREATE TABLE notes(markdown TEXT)');
      database
        .prepare('INSERT INTO notes VALUES (?)')
        .run(' '.repeat(at) + SECRET + ' '.repeat(total - at - SECRET.length));
      database.close();
      accepted = !readFileSync(path).includes(SECRET);
    }
    assert.ok(
      accepted,
      'no fixed-length row split the credential, so this fixture carries no case at all',
    );
  });
  try {
    const file = join(directory, 'data', `site.${digest}.sqlite`);
    const reader = new DatabaseSync(file, { readOnly: true });
    const stored = (
      reader.prepare('SELECT count(*) AS found FROM notes WHERE markdown LIKE ?').get(`%${SECRET}%`) as {
        found: number;
      }
    ).found;
    reader.close();
    assert.equal(stored, 1, 'the fixture kept no row carrying the credential, so the scan had nothing to find');
    // The raw file must not spell it either, so the finding can only come from rows.
    assert.ok(
      !readFileSync(file).includes(SECRET),
      'the fixture spells the credential in raw bytes, so a byte pass could have found it',
    );
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

/**
 * A WAL-declaring snapshot fails closed without writable reopening or sidecars.
 *
 * The accepted artifact is rollback-journal format only, and the shared row
 * enumerator refuses a WAL header before any open. Flipping the format bytes is
 * the same measurement `tests/snapshot-rows.test.ts` uses, and the delivered
 * bytes and directory membership must be identical afterwards: a refusal that
 * repaired or reopened the file would pass a code assertion while changing the
 * artifact under inspection.
 */
test('a WAL-declaring snapshot fails closed without touching the artifact', () => {
  const { directory, digest } = scratchWithSnapshot((path) => {
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE notes(markdown TEXT)');
    database.prepare('INSERT INTO notes VALUES (?)').run('plain value');
    database.close();
  });
  const data = join(directory, 'data');
  const file = join(data, `site.${digest}.sqlite`);
  try {
    const bytes = readFileSync(file);
    bytes[18] = 2;
    bytes[19] = 2;
    writeFileSync(file, bytes);
    const before = readdirSync(data).sort();
    const size = statSync(file).size;
    const error = failure(() => scanSecrets(directory));
    assert.equal(error.code, 'secret-scan-input-unreadable');
    assert.match(error.detail ?? '', /rollback-journal/);
    assert.deepEqual(readdirSync(data).sort(), before, 'the scan created a sidecar');
    assert.equal(statSync(file).size, size, 'the scan modified the artifact');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      assert.ok(!readdirSync(data).some((name) => name.endsWith(suffix)), `created ${suffix}`);
    }
    assert.ok(!(error.message + (error.detail ?? '')).includes(directory), 'the scan printed a host path');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
