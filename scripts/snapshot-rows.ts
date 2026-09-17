/**
 * Read-only row enumeration shared by the two release-policy scanners.
 *
 * A byte scan of SQLite is not a scan of its contents: a value larger than a page
 * is stored as a chain of overflow pages with a 4-byte pointer written into the
 * middle, so a marker straddling a boundary exists in the file as two fragments
 * and matches nothing. Reading rows is what makes the scan see the database at
 * all; reading the raw bytes *as well* is what sees a deleted row's payload in a
 * free page. Both scanners need both, so both call this.
 *
 * The enumerator is deliberately narrow: it answers "what text does this store?"
 * and "what could not be read?", and nothing else. Policy — which rule fires and
 * what counts as a finding — stays in the scanners.
 *
 * It never opens the artifact. A file is read into memory and inspected through
 * a private read-only temporary copy, so an incidental journal or shared-memory
 * file SQLite might want lands in the OS temp directory and is removed with it.
 */

import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suppressSqliteWarning } from '../src/lib/sqlite-warning.ts';

/** The first sixteen bytes of every SQLite file. */
export const SQLITE_MAGIC = 'SQLite format 3\0';

/** The first two bytes of a gzip member. */
export const GZIP_MAGIC: readonly [number, number] = [0x1f, 0x8b];

/** Whether the bytes are a gzip member. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/** A database declared as WAL cannot be deserialized as a standalone snapshot. */
export function declaresWal(bytes: Uint8Array): boolean {
  return bytes.length > 19 && (bytes[18] === 2 || bytes[19] === 2);
}

/**
 * The journal siblings of an accepted artifact.
 *
 * A built output is exactly one rollback-journal database; `-wal`/`-shm` mean a
 * WAL database and `-journal` means a hot journal. Opening the database while
 * one is present is not read-only: SQLite attempts recovery and, measured, can
 * write a generated `-shm` into the directory being inspected. Both recognition
 * boundaries refuse on this list before opening.
 */
export const JOURNAL_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** The journal suffix beside `path`, or `undefined` when the directory is clean. */
export function journalSidecar(path: string): string | undefined {
  return JOURNAL_SIDECAR_SUFFIXES.find((suffix) => existsSync(path + suffix));
}

/** Whether the bytes carry SQLite's file header. */
export function isSqlite(bytes: Uint8Array): boolean {
  return (
    bytes.length >= SQLITE_MAGIC.length &&
    Buffer.from(bytes.subarray(0, SQLITE_MAGIC.length)).toString('latin1') === SQLITE_MAGIC
  );
}

/** What one database yielded. */
export interface DatabaseRead {
  /** Every readable text value, one per stored value. */
  values: string[];
  /** Rows of readable, non-shadow user tables. Coverage, not bookkeeping. */
  corpusRows: number;
  /** Tables whose text could be neither selected nor enumerated. Fatal to a caller. */
  unreadable: string[];
}

/** Loaded lazily so a scan of a dist/ with no database never pays for the binding. */
const loadSqlite = (): typeof import('node:sqlite') => {
  suppressSqliteWarning();
  return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
};

/**
 * Every text value a database carries, as rows, read through a private copy.
 *
 * @throws when the file declares WAL (not an accepted artifact), when SQLite
 *   cannot open it, or when a private temporary copy cannot be made. Callers
 *   decide whether that is fatal; both scanners treat it as fail-closed.
 */
export function databaseText(bytes: Uint8Array): DatabaseRead {
  if (declaresWal(bytes)) {
    throw new Error('database is not in the accepted rollback-journal format');
  }
  const { DatabaseSync } = loadSqlite();
  const directory = mkdtempSync(join(tmpdir(), 'anc-scan-'));
  try {
    const temporary = join(directory, 'snapshot.sqlite');
    writeFileSync(temporary, bytes);
    const database = new DatabaseSync(temporary, { readOnly: true });
    try {
      return readOpenDatabase(database);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The reading half of {@link databaseText}, over a handle already open. */
function readOpenDatabase(database: {
  prepare: (sql: string) => { all: () => unknown[] };
  exec: (sql: string) => void;
}): DatabaseRead {
  const values: string[] = [];
  const unreadable: string[] = [];
  let corpusRows = 0;
  let vocabSequence = 0;
  const orphanCandidates: { name: string; terms: string[] }[] = [];
  // Row text only, kept apart from `values` so an index's terms are not checked
  // for orphanhood against themselves.
  const rowText: string[] = [];

  const tables = database
    .prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
    .all() as { name: string; sql: string | null }[];
  const virtualNames = tables
    .filter(({ sql }) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? ''))
    .map(({ name }) => name);
  // The orphan pass needs the corpus text only when there is an index to orphan
  // against; without FTS5 the collection and its join are dead weight.
  const hasFts5 = tables.some(({ sql }) => /\bfts5\b/i.test(sql ?? ''));

  for (const { name, sql } of tables) {
    const isVirtual = /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? '');
    const isShadow = virtualNames.some((owner) => name.startsWith(`${owner}_`));
    let rows: Record<string, unknown>[];
    try {
      rows = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Record<
        string,
        unknown
      >[];
    } catch {
      // A table that exists and cannot be selected from is "could not look", and
      // must not be spelled like "looked and found nothing".
      unreadable.push(name);
      continue;
    }

    let textValues = 0;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string' && value.length > 0) {
          textValues += 1;
          values.push(value);
          if (!isShadow && hasFts5) rowText.push(value);
        } else if (value instanceof Uint8Array && value.length > 0) {
          // A BLOB is read as text: the byte pass cannot see across an
          // overflow-page boundary, and a BLOB body overflows identically to a
          // TEXT one. A gzip BLOB is inflated first, by the same rule the file
          // loop applies; an inflate failure falls back to the raw value, which
          // is still scanned.
          textValues += 1;
          let blob = Buffer.from(value);
          if (blob.length >= 2 && blob[0] === GZIP_MAGIC[0] && blob[1] === GZIP_MAGIC[1]) {
            try {
              blob = Buffer.from(gunzipSync(blob));
            } catch {
              // Kept as the raw bytes, and still scanned.
            }
          }
          values.push(blob.toString('utf8'));
          if (!isShadow && hasFts5) rowText.push(blob.toString('utf8'));
        }
      }
    }
    // Only a corpus table's rows count toward coverage; SQLite's own bookkeeping
    // must not be able to satisfy the vacuity guard.
    if (textValues > 0 && !isShadow) corpusRows += rows.length;

    // An index's own terms, read through `fts5vocab`, are a second copy of the
    // corpus that need not agree with the first. A tokenizer is lossy, so
    // reading terms proves the index is enumerable, not that it is scannable.
    const vocabTerms: string[] = [];
    let vocabReadable = false;
    if (isVirtual && /\bfts5\b/i.test(sql ?? '')) {
      const view = `scan_vocab_${vocabSequence++}`;
      try {
        database.exec(
          `CREATE VIRTUAL TABLE temp."${view}" USING fts5vocab(main, "${name.replaceAll('"', '""')}", 'row')`,
        );
        for (const { term } of database.prepare(`SELECT term FROM temp."${view}"`).all() as {
          term: string | null;
        }[]) {
          if (typeof term === 'string' && term.length > 0) {
            vocabTerms.push(term);
            values.push(term);
          }
        }
        vocabReadable = true;
      } catch {
        vocabReadable = false;
      } finally {
        try {
          database.exec(`DROP TABLE IF EXISTS temp."${view}"`);
        } catch {
          // Already absent because the create failed.
        }
      }
    }

    if (isVirtual && (rows.length > 0 || vocabTerms.length > 0) && textValues === 0) {
      unreadable.push(name);
    } else if (isVirtual && !vocabReadable) {
      unreadable.push(name);
    } else {
      orphanCandidates.push({ name, terms: vocabTerms });
    }
  }

  // A term is only an orphan if *no* table accounts for it, checked against the
  // row text rather than against `values` (which carries the terms themselves).
  if (hasFts5) {
    const corpus = rowText.join('\n').toLowerCase();
    for (const { name, terms } of orphanCandidates) {
      if (terms.some((term) => !corpus.includes(term.toLowerCase()))) unreadable.push(name);
    }
  }

  return { values, corpusRows, unreadable };
}
