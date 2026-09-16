/**
 * The preview's marker checks, each of which had only ever been asserted in the
 * direction that cannot fail.
 *
 * `anc preview` refuses a directory unless it carries exactly one regular
 * `data/site.<sha256>.sqlite` whose bytes start with the SQLite header, hash to
 * the digest in their own name, and carry ANC's `application_id` and
 * `user_version`. `tests/preview-server.test.ts` plants a valid marker and
 * proves the guard accepts it; before this file nothing planted an invalid one,
 * so deleting the header check, the digest comparison, or either format
 * comparison left the whole suite green.
 *
 * **Measured, one mutation at a time:** replacing the header condition with
 * `false` reds the invalid-bytes gate alone, whose fixture then refuses as
 * `preview-snapshot-digest`; inverting the digest comparison reds all four,
 * because every gate here asserts acceptance first on an unmutated marker;
 * dropping the `application_id` comparison reds the foreign-application-id
 * gate alone; and dropping the `user_version` comparison reds the
 * foreign-user-version gate alone. The single-gate reds are the evidence that
 * each fixture reaches the branch it names; the digest mutation's four reds are
 * its own control working.
 *
 * No server is started here. `resolveArtifactDirectory` is the guard the binary
 * calls before `startPreview` opens a socket, so the refusals are measured
 * without a Vite preview's cold start; `tests/preview-server.test.ts` keeps the
 * served-directory half.
 *
 * The `preview-snapshot-unreadable` branch is reached with a planted file
 * through its read failure, not its open failure: `node:sqlite` opens a file
 * whose first 16 bytes are the SQLite magic and whose remainder is garbage, so
 * the constructor succeeds and the failure surfaces at the `PRAGMA` prepare,
 * where `scripts/preview-site.ts` now names it `preview-snapshot-unreadable`.
 * A gate that cannot make its branch fire would be the very shape this file
 * exists to remove.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import { DatabaseSync } from '../src/lib/sqlite.ts';
import {
  SNAPSHOT_APPLICATION_ID,
  SNAPSHOT_FILE_PATTERN,
  SNAPSHOT_USER_VERSION,
  snapshotFileName,
} from '../src/lib/snapshot.ts';
import { resolveArtifactDirectory } from '../scripts/preview-site.ts';
import { installSnapshotMarker, mutateSnapshotMarker, snapshotPath } from './support/snapshot.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');

/** Scratch directories removed after the test, whatever it did. */
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'anc-preview-marker-'));
  scratch.push(directory);
  return directory;
}

/** A directory carrying the real marker and an entry page, and nothing else. */
function markerDirectory(): string {
  const directory = temporary();
  writeFileSync(join(directory, 'index.html'), '<h1>built</h1>\n', 'utf8');
  installSnapshotMarker(directory, DIST);
  return directory;
}

/** The code `resolveArtifactDirectory` refused with, or `undefined` if it accepted. */
function refusedCode(directory: string): string | undefined {
  try {
    resolveArtifactDirectory(directory, ROOT);
    return undefined;
  } catch (error) {
    assert.ok(error instanceof Error, 'the refusal was not an Error');
    return (error as Error & { code?: string }).code;
  }
}

test('the marker is refused when its bytes are not SQLite, not only when its name is missing', () => {
  const directory = markerDirectory();

  // The control: the same directory, before the mutation below, is accepted, so
  // the refusal is about the bytes rather than about the fixture.
  assert.equal(resolveArtifactDirectory(directory, ROOT), directory, 'the fixture was refused before it was mutated');

  const marker = snapshotPath(directory);
  // 128 bytes, so the header comparison is reached rather than the length
  // short-circuit that guards it.
  writeFileSync(marker, 'x'.repeat(128));

  assert.equal(refusedCode(directory), 'preview-snapshot-invalid');
});

test('the marker is refused when its bytes do not hash to the digest in its name', () => {
  const directory = markerDirectory();
  assert.equal(resolveArtifactDirectory(directory, ROOT), directory, 'the fixture was refused before it was mutated');

  const marker = snapshotPath(directory);
  const match = SNAPSHOT_FILE_PATTERN.exec(marker.split('/').at(-1)!);
  assert.ok(match, 'the built marker is not named site.<digest>.sqlite, so this gate measured nothing');
  const digest = match[1]!;
  // The first hex character moves to a different value, so the new name is
  // guaranteed to differ from the digest of the unchanged bytes.
  const foreign = `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`;
  renameSync(marker, join(directory, ...snapshotFileName(foreign).split('/')));

  assert.equal(refusedCode(directory), 'preview-snapshot-digest');
});

test("the marker is refused when application_id is not ANC's", () => {
  const directory = markerDirectory();
  assert.equal(resolveArtifactDirectory(directory, ROOT), directory, 'the fixture was refused before it was mutated');

  mutateSnapshotMarker(directory, (path) => {
    const database = new DatabaseSync(path);
    try {
      database.exec(`PRAGMA application_id = ${SNAPSHOT_APPLICATION_ID + 1}`);
    } finally {
      database.close();
    }
  });

  assert.equal(refusedCode(directory), 'preview-snapshot-format');
});

test("the marker is refused when user_version is not the reader's", () => {
  const directory = markerDirectory();
  assert.equal(resolveArtifactDirectory(directory, ROOT), directory, 'the fixture was refused before it was mutated');

  mutateSnapshotMarker(directory, (path) => {
    const database = new DatabaseSync(path);
    try {
      database.exec(`PRAGMA user_version = ${SNAPSHOT_USER_VERSION + 1}`);
    } finally {
      database.close();
    }
  });

  assert.equal(refusedCode(directory), 'preview-snapshot-format');
});

test('the marker is refused when it opens but its pages cannot be read', () => {
  const directory = temporary();
  writeFileSync(join(directory, 'index.html'), '<h1>built</h1>\n', 'utf8');

  // A valid 16-byte SQLite header and 112 bytes of garbage, named by the digest
  // of exactly those bytes so the earlier refusals pass. `node:sqlite` opens
  // this lazily, so the refusal must come from the read that follows it.
  const bytes = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(112, 0x41)]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const marker = join(directory, ...snapshotFileName(digest).split('/'));
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, bytes);

  assert.equal(refusedCode(directory), 'preview-snapshot-unreadable');
});
