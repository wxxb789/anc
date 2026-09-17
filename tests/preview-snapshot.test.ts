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
 * Two later gates extend the same guard in both directions: a directory holding
 * two digest-named candidates is refused as a count — the count reaches
 * `detail`, and the message a log inherits names no digest and no host directory
 * — and the empty corpus, which `validateArtifact` admits as
 * `{ version: 1, entries: [] }`, is accepted once the build's own
 * `buildSnapshotFromEntries` and `copySnapshotToOutput` have put it at
 * `data/site.<sha256>.sqlite`.
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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import { validateArtifact } from '../src/lib/schema.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import {
  SNAPSHOT_APPLICATION_ID,
  SNAPSHOT_FILE_PATTERN,
  SNAPSHOT_USER_VERSION,
  snapshotFileName,
} from '../src/lib/snapshot.ts';
import { buildSnapshotFromEntries } from '../scripts/build-snapshot.ts';
import { copySnapshotToOutput } from '../scripts/copy-snapshot.ts';
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

/** The error `resolveArtifactDirectory` refused with, or `undefined` if it accepted. */
function refusal(directory: string): (Error & { code?: string; detail?: string }) | undefined {
  try {
    resolveArtifactDirectory(directory, ROOT);
    return undefined;
  } catch (error) {
    assert.ok(error instanceof Error, 'the refusal was not an Error');
    return error as Error & { code?: string; detail?: string };
  }
}

/** The code `resolveArtifactDirectory` refused with, or `undefined` if it accepted. */
function refusedCode(directory: string): string | undefined {
  return refusal(directory)?.code;
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

test('a directory holding two snapshot candidates is refused as a count, and one candidate is accepted', () => {
  const directory = markerDirectory();

  // The control: one candidate, accepted, so the refusal below is about the
  // second file rather than about the fixture.
  assert.equal(resolveArtifactDirectory(directory, ROOT), directory, 'the fixture was refused before it was doubled');

  const marker = snapshotPath(directory);
  const match = SNAPSHOT_FILE_PATTERN.exec(marker.split('/').at(-1)!);
  assert.ok(match, 'the built marker is not named site.<digest>.sqlite, so this gate measured nothing');
  const digest = match[1]!;
  // A second digest-shaped name, whichever bytes the first candidate holds.
  // Recognition counts matching names before it reads any bytes, which is why
  // this refusal is the count one: the count is checked first and the copied
  // bytes never enter the decision.
  const second = `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`;
  copyFileSync(marker, join(directory, ...snapshotFileName(second).split('/')));

  const refused = refusal(directory);
  assert.ok(refused !== undefined, 'a directory with two snapshot candidates was accepted');
  assert.equal(refused.code, 'preview-directory-not-an-artifact');
  assert.equal(
    refused.message,
    'not a built site: the directory named by --dist does not carry exactly one ' +
      'data/site.<sha256>.sqlite snapshot, so it was not produced by this tool. ' +
      'Refusing to serve it — a directory of notes served on a port publishes every ' +
      'file in it. Name the build output directory instead; the default is `dist`.',
    'the refusal was not the count message this branch declares',
  );
  // The count goes to `detail`, which nothing prints, and the two things the
  // message may not carry — a digest and the directory the user named — stay off
  // the surface a log inherits.
  assert.ok(refused.detail?.endsWith('2 snapshot candidate(s)'), `the count did not reach the detail: ${refused.detail}`);
  assert.doesNotMatch(refused.message, /[0-9a-f]{64}/, 'the refusal put a digest on the stream');
  assert.ok(!refused.message.includes(directory), 'the refusal put the served directory on the stream');
});

test('a WAL header or a journal sidecar is refused before the driver can generate one', () => {
  const directory = markerDirectory();
  const marker = snapshotPath(directory);
  const data = join(directory, 'data');

  // The control: the untouched marker is accepted, so each refusal below is the
  // format mutation rather than the fixture.
  assert.equal(resolveArtifactDirectory(directory, ROOT), directory, 'the fixture was refused before it was mutated');

  // A `-wal` sibling. Measured before this check existed: opening the database
  // read-only made SQLite attempt recovery and create a `-shm` file inside the
  // directory being served. The refusal must happen before the open — the
  // membership assertion below is what makes "read-only" a property of the
  // artifact rather than of the driver's intentions.
  const sidecar = marker + '-wal';
  writeFileSync(sidecar, 'journal bytes', 'utf8');
  const membersBefore = readdirSync(data).sort();
  assert.equal(refusal(directory)?.code, 'preview-snapshot-format', 'a WAL sidecar was accepted');
  assert.deepEqual(
    readdirSync(data).sort(),
    membersBefore,
    'serving recognition generated or removed a file beside the snapshot',
  );
  rmSync(sidecar);

  // A WAL-declaring header. The filename is renamed to the mutated bytes'
  // digest, so the refusal is the format check rather than the digest check.
  mutateSnapshotMarker(directory, (path) => {
    const bytes = readFileSync(path);
    bytes[18] = 2;
    bytes[19] = 2;
    writeFileSync(path, bytes);
  });
  assert.equal(refusal(directory)?.code, 'preview-snapshot-format', 'a WAL-declaring header was accepted');
});

test('an empty corpus produces a snapshot the preview accepts', () => {
  const directory = temporary();
  writeFileSync(join(directory, 'index.html'), '<h1>built</h1>\n', 'utf8');

  // The artifact through the contract's own validator: `{ version: 1, entries:
  // [] }` is an accepted corpus, so the database below is a valid site of
  // nothing rather than a fixture this test invented. Every other acceptance
  // gate in this file installs a marker copied from `dist/`, so acceptance was
  // only ever measured on a corpus that has notes in it.
  const artifact = validateArtifact({ version: 1, entries: [] });

  // The build's own path to a public snapshot: finalize it in a private
  // workspace, then copy it into the output under its digest name.
  const workspace = temporary();
  const built = buildSnapshotFromEntries(artifact.entries, workspace);
  assert.equal(built.nodes, 0, 'the empty corpus produced a snapshot with nodes in it');
  copySnapshotToOutput(directory, workspace);

  // Recognition: exactly one digest-named candidate, SQLite magic,
  // application_id, user_version, a digest matching the bytes, readable pages,
  // and index.html.
  assert.equal(
    resolveArtifactDirectory(directory, ROOT),
    directory,
    'the empty-corpus artifact was refused, so a user with no published notes has no preview',
  );

  // And the accepted file really is empty: recognition accepts any schema-valid
  // snapshot, so the acceptance above would also pass for a corpus with rows.
  const database = new DatabaseSync(snapshotPath(directory), { readOnly: true });
  try {
    assert.equal(
      (database.prepare('SELECT count(*) AS count FROM nodes').get() as { count: number }).count,
      0,
      'the accepted snapshot is not empty',
    );
  } finally {
    database.close();
  }
});
