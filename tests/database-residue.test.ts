/**
 * The residue scan over a carrier that is not a file of text.
 *
 * Every other gate over `dist/` asks whether a rule fires on some bytes. These
 * ask something prior: whether the scan can see the corpus at all once the
 * corpus stops being text files. A SQLite database is the first carrier in this
 * artifact whose contents are not recoverable by reading it — and a scan that
 * reports clean because it read nothing is this project's recurring defect,
 * catalogued in `docs/gate-reading.md` in six shapes.
 *
 * So every gate here plants a marker the scan must find, and **asserts the
 * marker is genuinely hidden from a plain byte read before asserting the
 * finding**. Without that first half a fixture that happens to spell the marker
 * contiguously would be caught by the scan this project already had, and the
 * gate would pass while proving nothing about the mechanism in its name.
 *
 * These are here rather than in `tests/report-gates.test.ts` because they build
 * their fixtures with `node:sqlite` directly rather than by running the binary:
 * nothing in this repository emits a database yet. That is lesson 5 of
 * `docs/gate-reading.md` accepted knowingly — a constructed fixture encodes what
 * its author believes the pipeline emits — and the mitigation is that each
 * fixture asserts its own shape rather than assuming it, which is what the
 * split-count and byte-absence checks below are for.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { scanResidue } from '../scripts/scan-residue.ts';

/** A scratch directory removed when the callback returns, however it returns. */
function scratch<T>(prefix: string, body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * A scratch `dist/` with the entry point the scan's second vacuity guard wants.
 *
 * Without it every gate below fails on "no index.html at its root" rather than
 * on the property it is named for — a red result that says nothing about the
 * database.
 */
function distWithIndex(directory: string): void {
  writeFileSync(join(directory, 'index.html'), '<h1>home</h1>', 'utf8');
}

/**
 * A marker split across a SQLite overflow-page boundary is found.
 *
 * A row larger than a page is stored as a chain of pages linked by a **4-byte
 * pointer written into the middle of the payload**, so a marker straddling a
 * boundary exists in the file as two fragments with four bytes between them and
 * matches nothing. Measured: sweeping `/home/someone/private` through a
 * fixed-length body across 12,000 rows at `page_size=4096`, **60 rows carried
 * the marker where the file's bytes did not**, while a single `SELECT … LIKE`
 * returned all 12,000. At byte 81,694,700 a page ends `/home/someone/privat`,
 * four pointer bytes follow, then `e`.
 *
 * This is TK-29's `ms**w/s**ecret` — a marker the reader receives whole that no
 * raw read can see — arriving through B-tree structure instead of markup. It is
 * the single reason a byte scan of a database is not a scan of its contents no
 * matter what extension the file wears.
 *
 * ## The fixture has to be built by verification, and three ways of building it
 * are wrong
 *
 * **Every occurrence must be split, not merely some.** A sweep across many rows
 * splits a few and leaves the rest contiguous — 4 of 1,200, measured — and the
 * remaining 1,196 are found by the byte pass alone, so the gate passes without
 * the row pass existing. That version was written first and its mutation came
 * back green: `docs/gate-reading.md` lesson 3 at the assertion level, a gate
 * whose fixture contains an easier case than the one it is named for.
 *
 * **The offset cannot be predicted.** A single row whose padding grows does not
 * split at any offset in 20,000 — measured — because lengthening the payload
 * moves the marker and the chunk boundary together. Only holding the total
 * length fixed separates them, and even then the splitting offsets shift as rows
 * are added, so a list of them collected in advance stops being one.
 *
 * **And the split must fall inside what the rule matches, not merely inside the
 * marker.** The second version of this fixture verified that no byte spelled
 * `/home/someone/private` and its mutation came back green anyway: the rule is
 * `/(?:Users|home)/[A-Za-z0-9._-]+/`, which is satisfied by `/home/someone/`,
 * and the split fell in `priv|ate` — past everything the rule needed. A fixture
 * hiding more of the marker than the rule reads hides nothing. So what the
 * fixture verifies absent is **the rule's own match**, taken from the rule
 * itself rather than restated, which is also what keeps it honest if the rule
 * changes.
 *
 * So the fixture is grown a row at a time and each row is kept only if the file
 * still contains no byte the rule can match. What it asserts about itself is
 * then a measurement rather than a belief, which is the mitigation lesson 5
 * asks for from a constructed fixture.
 *
 * **Mutation watched fail:** dropping `...read.values` from `subjects` in
 * `scripts/scan-residue.ts`, so the database is read only as bytes, turns this
 * red and reports the file clean.
 */
test('a marker split across an overflow-page boundary fails the scan', () => {
  scratch('tk38-boundary-', (directory) => {
    distWithIndex(directory);
    const marker = '/home/someone/private';
    // The rule this gate is measuring, and the reason the fixture is checked
    // against it rather than against `marker`: what has to be invisible to the
    // byte pass is whatever the rule would match, which is shorter.
    const rule = /(?<![A-Za-z])\/(?:Users|home)\/[A-Za-z0-9._-]+\//;
    const path = join(directory, 'notes.sqlite3');
    const total = 9_000;

    const database = new DatabaseSync(path);
    database.exec('PRAGMA page_size=4096');
    database.exec('CREATE TABLE notes(markdown TEXT)');
    const insert = database.prepare('INSERT INTO notes VALUES(?)');
    const bytesMatchRule = (): boolean => rule.test(readFileSync(path).toString('utf8'));

    let kept = 0;
    for (let at = 100; at < total - marker.length - 100 && kept < 3; at += 1) {
      // Padded with spaces, not letters: the rule carries a `(?<![A-Za-z])`
      // lookbehind, so `xxx/home/someone/` does not match it and a fixture
      // built that way would measure its own padding.
      insert.run(' '.repeat(at) + marker + ' '.repeat(total - at - marker.length));
      if (bytesMatchRule()) {
        database.exec('DELETE FROM notes WHERE rowid = (SELECT max(rowid) FROM notes)');
      } else {
        kept += 1;
      }
    }
    database.close();

    // The fixture's own two halves, asserted rather than assumed. Rows must be
    // reachable by query, and no byte of the file may satisfy the rule — or the
    // byte pass finds it and this gate says nothing about reading rows.
    const reader = new DatabaseSync(path, { readOnly: true });
    const reachable = (
      reader.prepare('SELECT count(*) AS found FROM notes WHERE markdown LIKE ?').get(
        `%${marker}%`,
      ) as { found: number }
    ).found;
    reader.close();
    assert.ok(reachable > 0, 'no row carries the marker, so this fixture carries no case at all');
    assert.ok(
      !bytesMatchRule(),
      `${reachable} rows carry the marker and the file's bytes still satisfy the rule, so a plain ` +
        'byte scan would pass this fixture and the gate would prove nothing about reading rows',
    );

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some(
        (finding) =>
          finding.startsWith('notes.sqlite3') && finding.includes('absolute home-directory path'),
      ),
      `a marker carried by ${reachable} rows and by no byte shipped past the scan: ` +
        findings.join('; '),
    );
  });
});

/**
 * A marker only inline markup joins is found, from stored Markdown.
 *
 * TK-29's surface, moved from the search index into the corpus. A body written
 * `ms**w/s**ecret` renders as `ms<strong>w/s</strong>ecret`, whose text is
 * `msw/secret`; today a Pagefind fragment stores that joined form and the scan
 * reads it there. A database stores the Markdown source, where the marker
 * appears in no form — and the joining then happens in the reader's browser,
 * downstream of every gate.
 *
 * The three delimiters here are the ones the shipped renderer was **measured**
 * to consume: `ms**w/s**ecret`, `ms*w/s*ecret` and ``ms`w/s`ecret`` all reach
 * the page as the marker, while `ms__w/s__ecret` and `ms_w/s_ecret` do not,
 * because CommonMark does not open intra-word emphasis on underscores.
 *
 * **Mutation watched fail:** dropping the `joinedForms` term from the database
 * branch's `forms` turns this red on all three, and leaves the overflow-boundary
 * gate green — the two mechanisms are independent and each needs its own gate.
 */
test('a marker only inline markup joins fails the scan, from a database', () => {
  scratch('tk38-joined-', (directory) => {
    distWithIndex(directory);
    const path = join(directory, 'notes.sqlite3');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE notes(slug TEXT, markdown TEXT)');
    const insert = database.prepare('INSERT INTO notes VALUES(?,?)');
    insert.run('a', 'A path ms**w/s**ecret here.');
    insert.run('b', 'A path ms*w/s*ecret here.');
    insert.run('c', 'A path ms`w/s`ecret here.');
    database.close();

    assert.ok(
      !readFileSync(path).includes('msw/'),
      'the fixture spells the marker contiguously, so a raw byte scan would catch it and this ' +
        'gate proves nothing about the joined form',
    );

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some((finding) => finding.startsWith('notes.sqlite3') && finding.includes('msw/')),
      `a marker split by inline markup shipped in a database past the scan: ${findings.join('; ')}`,
    );
  });
});

/**
 * A gzipped database is inflated and read, wherever it is and whatever it is called.
 *
 * The inflate branch used to test `pagefind/*.pf_fragment`, which was safe only
 * while every compressed member in the artifact was third-party. Measured on a
 * database: `msw/`, `javascript:` and `C:/` are all present in its raw bytes,
 * all absent once it is gzipped, and all present again after inflating — so
 * shipping the corpus precompressed would have put it behind a layer the scan
 * structurally could not open.
 *
 * **The non-vacuity check routes through the scan, not around it.** It asserts
 * the compressed bytes do *not* spell the marker rather than calling
 * `gunzipSync` itself to prove they do — a control with its own private path to
 * the answer stays green when the path under test is removed, which is exactly
 * how TK-28 M17 failed and lesson 4 of `docs/gate-reading.md`.
 *
 * **Mutation watched fail:** restoring `const isGzip = isFragment` turns this
 * red. The file is then classified on its `.gz` extension, lands in the
 * unclassified branch, and is reported as shipped unscanned rather than read.
 */
test('a gzipped database is inflated, not skipped', () => {
  scratch('tk38-gzip-', (directory) => {
    distWithIndex(directory);
    const plain = join(directory, 'plain.sqlite3');
    const database = new DatabaseSync(plain);
    database.exec('CREATE TABLE notes(markdown TEXT)');
    database.prepare('INSERT INTO notes VALUES(?)').run('a body carrying msw/secret');
    database.close();

    const raw = readFileSync(plain);
    rmSync(plain);
    const compressed = join(directory, 'notes.sqlite3.gz');
    writeFileSync(compressed, gzipSync(raw));

    assert.ok(
      !readFileSync(compressed).includes('msw/'),
      'the compressed fixture still spells the marker, so the inflate is not what this gate reads',
    );

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some(
        (finding) => finding.startsWith('notes.sqlite3.gz') && finding.includes('msw/'),
      ),
      `a gzipped database shipped past the scan: ${findings.join('; ')}`,
    );
  });
});

/**
 * An index whose text the scan can neither query nor grep fails by name.
 *
 * A contentless FTS5 table is unreadable in **both** directions at once, which
 * is what makes it a finding rather than an exclusion. Measured on
 * `fts5(body, content='')`: `SELECT body` returns `null` for every row and
 * `snippet()` returns `null`, so there is no text to read; and its stored terms
 * are not byte-findable either, because `unicode61` strips the separators every
 * rule keys on — `msw/` absent while `msw` present, `javascript:` absent while
 * `javascript` present, `C:/` absent — and prefix compression stores a term
 * sharing a prefix with its neighbour as a suffix only, so
 * `zzqalpha zzqalphabet zzqalphabetical` leaves only `zzqalpha` findable.
 *
 * This is property 1 of `scripts/scan-residue.ts`'s header applied to a carrier
 * rather than to a file: an artifact the scan cannot see through is named, never
 * skipped. Both halves of "unreadable" are asserted, because a finding raised
 * for some other reason would satisfy the last assertion alone.
 *
 * **Mutation watched fail:** removing the `fts5vocab` read — so the index's
 * terms go unread — turns this red.
 *
 * **And a mutation that stays green, recorded because it is the informative
 * kind:** deleting the `textValues === 0` branch leaves this gate green, because
 * the orphan check downstream reaches the same conclusion by a different route.
 * A contentless index's terms belong to no readable table, so they are all
 * orphans. The edit was confirmed to execute; the two branches genuinely
 * overlap on this input and diverge elsewhere — the orphan check needs
 * enumerable terms, and the `textValues` branch catches a virtual table that
 * yields rows and no text at all, including one that is not FTS5 and has no
 * vocabulary to read. Neither is redundant; on this fixture either suffices.
 */
test('a search index the scan can neither read nor grep fails by name', () => {
  scratch('tk38-fts-', (directory) => {
    distWithIndex(directory);
    const path = join(directory, 'notes.sqlite3');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE notes(markdown TEXT)');
    database.prepare('INSERT INTO notes VALUES(?)').run('ordinary prose with nothing in it');
    database.exec(`CREATE VIRTUAL TABLE search USING fts5(body, content='')`);
    database.prepare('INSERT INTO search(rowid, body) VALUES(?,?)').run(1, 'a path msw/secret here');
    database.close();

    assert.ok(
      !readFileSync(path).includes('msw/'),
      'the tokenizer left the marker contiguous in the file, so the byte pass would catch it and ' +
        'this index is not the unreadable case',
    );
    const reader = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      (reader.prepare('SELECT body FROM search').get() as { body: string | null }).body,
      null,
      'the contentless index returned its text, so it is readable and this gate names nothing',
    );
    reader.close();

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some((finding) => finding.includes('notes.sqlite3') && finding.includes('"search"')),
      `an unreadable search index shipped without being named: ${findings.join('; ')}`,
    );
  });
});

/**
 * A note documenting Obsidian syntax publishes; a stray wikilink in prose does not.
 *
 * `CODE_EXEMPT` exists because a note documenting `[[wikilink]]` syntax is
 * legitimate content, and that reasoning has to survive into a database — but
 * its *implementation* cannot, because it blanks `<code>` and `<pre>` elements
 * and a stored Markdown body has no elements in it yet. Measured: the same note
 * that builds clean today, whose page carries
 * `<code class="language-text">[[not a link]]</code>`, survives
 * `withoutCodeRegions` untouched in a database and trips the rule; on a
 * 10,000-note database it matched 25,655 times.
 *
 * So the rule keeps its meaning by changing what it blanks — fences and inline
 * backticks, per `withoutMarkdownCode`. **Both directions are one gate**,
 * because they are one decision: an exemption that also swallows the prose case
 * has not narrowed the rule, it has deleted the producer self-check that is the
 * rule's entire purpose.
 *
 * **Mutations watched fail:** scanning the raw text instead of
 * `withoutMarkdownCode(text)` turns the documenting note red — the wall of false
 * positives the exemption prevents. Blanking the whole body instead turns the
 * prose case green, which is the check silently going away.
 */
test('a database can document wikilink syntax, and cannot leak one from prose', () => {
  scratch('tk38-code-', (directory) => {
    distWithIndex(directory);

    const documenting = join(directory, 'documenting.sqlite3');
    const first = new DatabaseSync(documenting);
    first.exec('CREATE TABLE notes(markdown TEXT)');
    first
      .prepare('INSERT INTO notes VALUES(?)')
      .run(
        'Obsidian writes a link as:\n\n```text\n[[not a link]]\n```\n\nAnd inline `[[syntax]]` too.\n',
      );
    first.close();

    assert.deepEqual(
      scanResidue(directory).findings,
      [],
      'a note documenting Obsidian syntax failed the scan, which is the case CODE_EXEMPT exists ' +
        'to permit and which the author has no way to escape',
    );

    rmSync(documenting);
    const prose = new DatabaseSync(join(directory, 'prose.sqlite3'));
    prose.exec('CREATE TABLE notes(markdown TEXT)');
    prose.prepare('INSERT INTO notes VALUES(?)').run('Prose with a stray [[wikilink]] in it.');
    prose.close();

    assert.ok(
      scanResidue(directory).findings.some((finding) =>
        finding.includes('unresolved [[wikilink]]'),
      ),
      'a stray wikilink in stored prose passed the scan, so the producer self-check is gone',
    );
  });
});

/**
 * A withheld note surviving in a free page is found.
 *
 * The one thing reading rows cannot do. A deleted row's payload stays in the
 * file until a `VACUUM` reclaims it, and no `SELECT` can reach it. Under an
 * artifact the reader downloads whole, that is a withheld note shipping to every
 * reader.
 *
 * **The row has to be big enough to hold a page of its own**, and that is
 * measured rather than assumed: at 320-byte rows SQLite repacks the leaf and
 * the deleted body is gone from the file, while at 3,000 bytes it survives. A
 * fixture built at the smaller size passes its delete and proves nothing, so
 * this one asserts the survival before asserting the finding.
 *
 * So the database is read as rows **and** as bytes, and this is the gate for the
 * second. Its cost was measured across four corpus sizes and is essentially
 * nil: at 0.2 MB, 2.1 MB and 43 MB no rule matched the bytes that did not also
 * match a row.
 *
 * **Mutation watched fail:** dropping the raw-bytes subject from the database
 * branch turns this red, and the withheld body is reported clean.
 */
test('a deleted row surviving in a free page fails the scan', () => {
  scratch('tk38-freepage-', (directory) => {
    distWithIndex(directory);
    const path = join(directory, 'notes.sqlite3');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE notes(slug TEXT, markdown TEXT)');
    const insert = database.prepare('INSERT INTO notes VALUES(?,?)');
    database.exec('BEGIN');
    for (let row = 0; row < 50; row += 1) insert.run(`n${row}`, 'ordinary prose. '.repeat(200));
    insert.run('excluded', `WITHHELD /home/someone/private ${'z'.repeat(3_000)}`);
    database.exec('COMMIT');
    database.exec(`DELETE FROM notes WHERE slug='excluded'`);
    database.close();

    // The fixture's own shape, both halves. The marker must be gone from every
    // live row — or a row scan would catch it and this gate would not be
    // measuring the byte pass — and still present in the file, or there is
    // nothing left to find.
    const reader = new DatabaseSync(path, { readOnly: true });
    const live = reader.prepare('SELECT markdown FROM notes').all() as { markdown: string }[];
    reader.close();
    assert.ok(
      !live.some((row) => row.markdown.includes('/home/someone/')),
      'a live row still carries the marker, so this fixture does not isolate the free-page case',
    );
    assert.ok(
      readFileSync(path).includes('/home/someone/private'),
      'the deleted body did not survive in the file, so this fixture carries no residue at all — ' +
        'the row is too small and SQLite repacked the leaf',
    );

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some(
        (finding) =>
          finding.startsWith('notes.sqlite3') && finding.includes('absolute home-directory path'),
      ),
      `a withheld note surviving in a free page shipped past the scan: ${findings.join('; ')}`,
    );
  });
});

/**
 * A database that yields no row fails, rather than passing on a file count.
 *
 * The scan's other two non-vacuity guards are a file count and the presence of
 * `index.html`, and **a file count stops measuring coverage the moment the
 * corpus stops being files**: one database in place of a thousand pages leaves
 * `scannedCount` at a number that no longer varies with what is published. An
 * instrument whose reading does not move with its subject has stopped looking,
 * which is the unifying claim of `docs/gate-reading.md`.
 *
 * `rowCount` is the replacement and this gate is the proof it can fail. Both
 * older guards are asserted to *pass* on this fixture, because that is what
 * makes the third load-bearing rather than a restatement of the other two.
 *
 * **Mutation watched fail:** deleting the `sawDatabase && rowCount === 0` guard
 * turns this red — the empty database is reported clean with `scannedCount` at
 * 2, which is the shape of a build that shipped an empty corpus and passed.
 */
test('a database holding no rows fails the scan rather than passing it', () => {
  scratch('tk38-vacuity-', (directory) => {
    distWithIndex(directory);
    const database = new DatabaseSync(join(directory, 'notes.sqlite3'));
    database.exec('CREATE TABLE notes(slug TEXT, markdown TEXT)');
    database.close();

    const { findings, scannedCount, rowCount } = scanResidue(directory);
    assert.equal(rowCount, 0, 'the fixture is not the empty case it is named for');
    assert.equal(
      scannedCount,
      2,
      'the file count no longer describes this fixture, so it cannot show the older guards pass',
    );
    assert.ok(
      findings.some((finding) => finding.includes('no rows')),
      `an empty database passed the scan on a file count alone: ${findings.join('; ')}`,
    );
  });
});

/**
 * A file wearing the SQLite magic that SQLite will not open is reported.
 *
 * "Could not look" must not be spelled like "looked and found nothing" — lesson
 * 3 of `docs/gate-reading.md`, and the reason the fragment branch reports an
 * inflate failure rather than falling back to raw bytes. Recognising a carrier
 * by its header means accepting files that wear the header and are not readable,
 * and those are findings. Measured: both a corrupt file and a truncated one
 * throw on open rather than returning an empty database.
 *
 * **Mutation watched fail:** replacing the `catch`'s `report` with a bare
 * `continue` — the fallback that reads as harmless — turns this red, and the
 * corrupt file is reported clean.
 */
test('a database that cannot be opened is reported, not skipped', () => {
  scratch('tk38-corrupt-', (directory) => {
    distWithIndex(directory);
    writeFileSync(
      join(directory, 'notes.sqlite3'),
      Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('garbage'.repeat(200))]),
    );

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some(
        (finding) => finding.startsWith('notes.sqlite3') && finding.includes('could not be opened'),
      ),
      `an unopenable database shipped unscanned and unreported: ${findings.join('; ')}`,
    );
  });
});

/**
 * The fail-closed classifier still fails closed, and the escape hatch is shut.
 *
 * The database branch keys on the SQLite header rather than on an extension, and
 * the risk of keying on bytes is that it becomes a way *past* the unclassified
 * branch. It is not: a file that is not a database is classified exactly as it
 * was before.
 *
 * **The mutation this file exists to forbid is now inert, and that is the
 * result worth recording.** Adding `.sqlite3` to `BINARY_EXTENSIONS` — the cheap
 * one-line fix that made a database build green, a `continue` before the file
 * was ever read — turns *nothing* red here, because it no longer does anything:
 * `isDatabase` is decided from the header *above* the extension check, so a
 * database is read whatever list its extension is on. Verified by applying that
 * mutation and re-running the marker gates, which all stayed green with the
 * findings intact. A green mutation is normally a reason to distrust a gate
 * (`docs/gate-reading.md` lesson 1); here the edit was confirmed to execute and
 * the branch it targets was confirmed unreachable, which is the fourth outcome
 * that file's closing section describes.
 *
 * **Mutation watched fail:** widening `SQLITE_MAGIC` to `'SQLite'` — a prefix
 * short enough to be spelled by an ordinary file — turns this red: the
 * unclassified file is taken for a database, fails to open, and is reported
 * under a reason that sends the reader to the wrong fix.
 */
test('a file that is neither text, binary, nor a database still fails by name', () => {
  scratch('tk38-closed-', (directory) => {
    distWithIndex(directory);
    // Wears the word but not the header, which is the case that separates a
    // magic test from a substring test.
    writeFileSync(join(directory, 'mystery.bin'), 'SQLite-ish bytes carrying nothing', 'utf8');

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some(
        (finding) =>
          finding.startsWith('mystery.bin') &&
          finding.includes('neither declared text nor declared binary'),
      ),
      `an unclassified file no longer fails the scan by name: ${findings.join('; ')}`,
    );
  });
});

/**
 * A BLOB body is read, and a compressed one is inflated first.
 *
 * The review that found this was right about the reason: an earlier version of
 * `databaseText` skipped BLOBs on the argument that a BLOB is bytes the byte
 * pass has already read. That argument fails for exactly the reason the row pass
 * exists — the byte pass cannot see across an overflow-page boundary, and a BLOB
 * body overflows identically to a TEXT one. Measured, the boundary fixture with
 * the column typed `BLOB` carried the marker in three rows and produced zero
 * findings.
 *
 * The compressed case is the one a real build reaches first: when the whole
 * database is downloaded, storing bodies as `gzip(body)` is the obvious move,
 * and it hides the marker from both passes at once. So a BLOB is inflated by the
 * same rule the file loop applies, keyed on the gzip magic.
 *
 * **Mutations watched fail:** restoring the `typeof value === 'string'` test, so
 * BLOBs are skipped, turns both halves red. Removing only the inflate turns the
 * compressed half red and leaves the plain half green.
 */
test('a BLOB body is scanned, compressed or not', () => {
  scratch('tk38-blob-', (directory) => {
    distWithIndex(directory);
    const path = join(directory, 'notes.sqlite3');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE notes(slug TEXT, body BLOB)');
    const insert = database.prepare('INSERT INTO notes VALUES(?,?)');
    insert.run('plain', Buffer.from('a path msw/secret here'));
    insert.run('gzipped', gzipSync(Buffer.from('another path /home/someone/private here')));
    database.close();

    // The compressed half's own shape: its marker is in no byte of the file.
    assert.ok(
      !readFileSync(path).includes('/home/someone/private'),
      'the compressed BLOB still spells its marker, so the inflate is not what this gate reads',
    );

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some((finding) => finding.includes('msw/')),
      `a plain BLOB body shipped unscanned: ${findings.join('; ')}`,
    );
    assert.ok(
      findings.some((finding) => finding.includes('absolute home-directory path')),
      `a gzipped BLOB body shipped unscanned: ${findings.join('; ')}`,
    );
  });
});

/**
 * A full-text index's own terms are read, so a withdrawn body cannot ship in one.
 *
 * An index is a second copy of the corpus and it does not have to agree with the
 * first. Measured: index a note, rewrite the source row without reindexing, then
 * `VACUUM`. `SELECT` returns the *new* body, an `integrity-check` passes without
 * noticing, prefix compression keeps the old terms out of the file's bytes — and
 * a reader recovers `msw path secret someone` from the shipped artifact in one
 * statement through `fts5vocab`.
 *
 * That is the free-page case again in a different store: a payload no `SELECT`
 * reaches and no byte read spells. So the terms are read where they are stored,
 * through `fts5vocab`, and checked against the text the tables yielded.
 *
 * **The index is named rather than a rule firing on a term**, and that is the
 * tokenizer's doing: `unicode61` strips the `/`, so `msw/secret` is stored as
 * `msw` and `secret` and no marker rule can match either. What is detectable is
 * the *disagreement* — a term no readable text accounts for. A fresh index has
 * none, measured for external-content, owned-content and contentless alike, so
 * the check costs nothing on a database whose index matches its corpus. The
 * distinction matters for anyone changing this later: the fix is not to add a
 * rule for `msw`.
 *
 * **Mutation watched fail:** removing the `fts5vocab` read from `databaseText`
 * turns this red — the withdrawn terms ship and the scan reports clean. So does
 * letting the shadow tables into the orphan corpus, which is subtler and was a
 * real defect: an FTS5 `_data` blob stores the term list, so every term finds
 * itself there and no index can ever have an orphan.
 */
test('terms left in a stale search index fail the scan', () => {
  scratch('tk38-vocab-', (directory) => {
    distWithIndex(directory);
    const path = join(directory, 'notes.sqlite3');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE notes(markdown TEXT)');
    database.prepare('INSERT INTO notes VALUES(?)').run('a path msw/secret here');
    database.exec(
      `CREATE VIRTUAL TABLE search USING fts5(markdown, content='notes', content_rowid='rowid')`,
    );
    database.exec(`INSERT INTO search(search) VALUES('rebuild')`);
    // The note is withdrawn from the corpus without the index being rebuilt.
    database.exec(`UPDATE notes SET markdown='an innocuous replacement body'`);
    database.exec('VACUUM');
    database.close();

    // Three halves of the fixture's own shape. The live row must be clean, or a
    // plain row scan catches it; the bytes must not spell the term, or the byte
    // pass does; and the withdrawn text must genuinely still be recoverable by a
    // reader, or there is nothing here to fail on.
    const reader = new DatabaseSync(path);
    const live = reader.prepare('SELECT markdown FROM notes').all() as { markdown: string }[];
    // `main` named explicitly: an `fts5vocab` table created in `temp` resolves
    // its target in `temp` too, and the qualified form fails outright.
    reader.exec(`CREATE VIRTUAL TABLE temp.terms USING fts5vocab(main, search, 'row')`);
    const terms = (reader.prepare('SELECT term FROM temp.terms').all() as { term: string }[]).map(
      ({ term }) => term,
    );
    // Dropped before closing: on Windows a live virtual table keeps a handle on
    // the file, and `scratch`'s `rmSync` then fails with EPERM after every
    // assertion has already passed — a red result that says nothing about the
    // property.
    reader.exec('DROP TABLE temp.terms');
    reader.close();
    assert.ok(
      !live.some((row) => row.markdown.includes('msw')),
      'the live row still carries the marker, so this fixture does not isolate the index',
    );
    assert.ok(
      !readFileSync(path).includes('msw/'),
      'the file spells the withdrawn marker, so the byte pass would catch it and the index is not ' +
        'what this gate measures',
    );
    assert.ok(
      terms.includes('msw') && terms.includes('secret'),
      `the withdrawn note left no recoverable terms, so this fixture carries no case: ${terms.join(' ')}`,
    );

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some(
        (finding) => finding.includes('notes.sqlite3') && finding.includes('"search"'),
      ),
      `terms left in a stale search index shipped past the scan: ${findings.join('; ')}`,
    );
  });
});

/**
 * A search index that agrees with its corpus is not reported.
 *
 * The other half of the gate above, and the reason it is a separate test: a
 * check that names *every* index would satisfy that one while making the scan
 * unusable, because a build's own search index would fail its own build. This
 * is the control that the orphan check discriminates rather than blankets —
 * three index shapes that all carry the marker legitimately, each of which the
 * scan must catch through the ordinary rules and none of which it may name as
 * unreadable.
 *
 * **Mutation watched fail:** reporting any index with terms — dropping the
 * orphan comparison and pushing every candidate — turns this red on all three.
 */
test('a search index matching its corpus is not reported as unreadable', () => {
  for (const [label, build] of [
    [
      'external content',
      (database: DatabaseSync): void => {
        database.exec(
          `CREATE VIRTUAL TABLE search USING fts5(markdown, content='notes', content_rowid='rowid')`,
        );
        database.exec(`INSERT INTO search(search) VALUES('rebuild')`);
      },
    ],
    [
      'owned content',
      (database: DatabaseSync): void => {
        database.exec('CREATE VIRTUAL TABLE search USING fts5(body)');
        database.prepare('INSERT INTO search(body) VALUES(?)').run('a path msw/secret here');
      },
    ],
  ] as const) {
    scratch('tk38-fresh-', (directory) => {
      distWithIndex(directory);
      const database = new DatabaseSync(join(directory, 'notes.sqlite3'));
      database.exec('CREATE TABLE notes(markdown TEXT)');
      database.prepare('INSERT INTO notes VALUES(?)').run('a path msw/secret here');
      build(database);
      database.exec('VACUUM');
      database.close();

      const { findings } = scanResidue(directory);
      assert.ok(
        !findings.some((finding) => finding.includes('"search"')),
        `a ${label} index that matches its corpus was reported as unreadable: ${findings.join('; ')}`,
      );
      // And the marker it legitimately carries is still caught, so this gate
      // cannot pass by the scan having gone quiet altogether.
      assert.ok(
        findings.some((finding) => finding.includes('msw/')),
        `the ${label} fixture's own marker was not found, so this gate proves nothing: ${findings.join('; ')}`,
      );
    });
  }
});

/**
 * A WAL-mode database is read rather than reported as broken.
 *
 * `journal_mode=WAL` is a common setting, and a database written under it cannot
 * be served from a buffer: the format's shared-memory index has no in-memory
 * equivalent. Measured, and the shape of the failure is why the fallback is
 * keyed where it is — `deserialize` **succeeds** on such a file and the *first
 * query* then throws `unable to open database file`. A fallback guarding only
 * the open would never fire, which is what the first version of it did.
 *
 * This is a false result on the build rather than a disclosure — it fails closed
 * — but it fails closed with a message that sends the reader to a fix that is
 * not the problem, and it would make an ordinary build unshippable.
 *
 * **Mutation watched fail:** narrowing the `try` to the `deserialize` call alone
 * turns this red with `is a database that could not be opened`.
 */
test('a WAL-mode database is read from its path', () => {
  scratch('tk38-wal-', (directory) => {
    distWithIndex(directory);
    const path = join(directory, 'notes.sqlite3');
    const database = new DatabaseSync(path);
    database.exec('PRAGMA journal_mode=WAL');
    database.exec('CREATE TABLE notes(markdown TEXT)');
    database.prepare('INSERT INTO notes VALUES(?)').run('a path msw/secret here');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.close();

    // The fixture is the case it is named for: the header declares WAL.
    assert.equal(
      readFileSync(path)[18],
      2,
      'the fixture is not in WAL mode, so it exercises the ordinary path',
    );

    const { findings, rowCount } = scanResidue(directory);
    assert.ok(
      !findings.some((finding) => finding.includes('could not be opened')),
      `a WAL-mode database was reported as unopenable rather than read: ${findings.join('; ')}`,
    );
    assert.equal(rowCount, 1, 'the WAL database was opened but its rows were not counted');
    assert.ok(
      findings.some((finding) => finding.includes('msw/')),
      `a marker in a WAL-mode database shipped past the scan: ${findings.join('; ')}`,
    );
  });
});
