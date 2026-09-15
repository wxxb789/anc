/**
 * The public SQLite snapshot: file-format constants, the normative schema, and
 * the naming/URL helpers every producer, verifier, preview, and browser consumer
 * shares.
 *
 * `docs/core-design/sqlite-contract.md` owns this schema. This module exists so
 * the producer, the output inventory, the preview recognizer, the scanners, and
 * the browser Worker all agree on one set of numbers and names; a second copy
 * would be the one that drifts.
 *
 * Nothing here imports `node:sqlite` or any browser API: it is data and pure
 * string helpers, so the same module can be loaded in the Astro build, in a
 * browser Worker, and in a Node test runner.
 */

/** `NGRD` — ANC's project-local file discriminator. Not a registration claim. */
export const SNAPSHOT_APPLICATION_ID = 0x4e475244;

/** The reader accepts exactly this contract; there is no version negotiation. */
export const SNAPSHOT_USER_VERSION = 1;

/** Directory segment the hashed snapshot lives under. `data` is a reserved slug. */
export const SNAPSHOT_DIRECTORY = 'data';

/** Page size fixed by the contract, so identical inserts give identical bytes. */
export const SNAPSHOT_PAGE_SIZE = 4096;

/**
 * The normative schema. Five entity/relation tables and one explicit secondary
 * index; the `UNIQUE` constraints create their own B-trees, which is expected.
 *
 * Applied in one `exec` before any row is written. `PRAGMA foreign_keys` is a
 * connection setting, not stored in the file, so a reader must set it too; the
 * producer enables and verifies it before the write transaction.
 */
export const SNAPSHOT_SCHEMA_SQL = `
PRAGMA application_id = ${SNAPSHOT_APPLICATION_ID};
PRAGMA user_version = ${SNAPSHOT_USER_VERSION};

CREATE TABLE nodes (
    id       INTEGER PRIMARY KEY,
    slug     TEXT NOT NULL UNIQUE,
    title    TEXT NOT NULL,
    excerpt  TEXT NOT NULL,
    language TEXT NOT NULL
) STRICT;

CREATE TABLE edges (
    source_id INTEGER NOT NULL REFERENCES nodes(id),
    target_id INTEGER NOT NULL REFERENCES nodes(id),
    PRIMARY KEY (source_id, target_id),
    CHECK (source_id <> target_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX edges_by_target ON edges(target_id, source_id);

CREATE TABLE aliases (
    node_id INTEGER NOT NULL REFERENCES nodes(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    alias   TEXT NOT NULL,
    PRIMARY KEY (node_id, ordinal),
    UNIQUE (node_id, alias)
) WITHOUT ROWID, STRICT;

CREATE TABLE tags (
    id    INTEGER PRIMARY KEY,
    key   TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL
) STRICT;

CREATE TABLE node_tags (
    tag_id  INTEGER NOT NULL REFERENCES tags(id),
    node_id INTEGER NOT NULL REFERENCES nodes(id),
    PRIMARY KEY (tag_id, node_id)
) WITHOUT ROWID, STRICT;
`.trim();

/** The five user tables, in the order the schema declares them. */
export const SNAPSHOT_TABLES: readonly string[] = ['nodes', 'edges', 'aliases', 'tags', 'node_tags'];

/**
 * The expected shape of each table: column name and, for a primary-key member,
 * its 1-based position in the key (SQLite's own `PRAGMA table_info` `pk` value);
 * `0` means the column is not part of the primary key. A reader validates this
 * once per imported snapshot, so a header that matches the constants but carries
 * an unexpected schema fails closed rather than running a query whose result
 * means something else.
 */
export interface SnapshotColumn {
  name: string;
  /** 0 when not a primary-key member, otherwise the 1-based key position. */
  pk: number;
}

export const SNAPSHOT_TABLE_COLUMNS: Readonly<Record<string, readonly SnapshotColumn[]>> = {
  nodes: [
    { name: 'id', pk: 1 },
    { name: 'slug', pk: 0 },
    { name: 'title', pk: 0 },
    { name: 'excerpt', pk: 0 },
    { name: 'language', pk: 0 },
  ],
  edges: [
    { name: 'source_id', pk: 1 },
    { name: 'target_id', pk: 2 },
  ],
  aliases: [
    { name: 'node_id', pk: 1 },
    { name: 'ordinal', pk: 2 },
    { name: 'alias', pk: 0 },
  ],
  tags: [
    { name: 'id', pk: 1 },
    { name: 'key', pk: 0 },
    { name: 'label', pk: 0 },
  ],
  node_tags: [
    { name: 'tag_id', pk: 1 },
    { name: 'node_id', pk: 2 },
  ],
};

/** The one explicitly created secondary index, outside the `UNIQUE` constraints. */
export const SNAPSHOT_EXPLICIT_INDEX = 'edges_by_target';

const DIGEST = /^[0-9a-f]{64}$/;

/** A full lowercase-hex SHA-256, as it appears in the bound filename. */
export function isSnapshotDigest(value: string): boolean {
  return DIGEST.test(value);
}

/**
 * The published path of a snapshot named by its full digest.
 *
 * The filename is not itself a verification: the reader recomputes SHA-256 over
 * the received uncompressed bytes and compares it with the digest the page bound.
 */
export function snapshotRoute(digest: string): string {
  if (!isSnapshotDigest(digest)) throw new Error(`snapshot digest is not 64 lowercase hex: ${digest}`);
  return `/${SNAPSHOT_DIRECTORY}/site.${digest}.sqlite`;
}

/** The output-relative file name, without a leading slash. */
export function snapshotFileName(digest: string): string {
  return snapshotRoute(digest).slice(1);
}

/** Matches a snapshot member name, capturing the digest; used by output gates. */
export const SNAPSHOT_FILE_PATTERN = /^site\.([0-9a-f]{64})\.sqlite$/;

/** A bound snapshot URL as it appears in the generated client module. */
export interface SnapshotBinding {
  /** Same-origin URL, e.g. `/data/site.<64hex>.sqlite`. */
  url: string;
  /** The full digest the URL names, repeated so a reader can verify its fetch. */
  digest: string;
  /** SQLite `application_id`, so the reader can reject a foreign file early. */
  applicationId: number;
  /** The reader's exact contract version. */
  userVersion: number;
}

/** Validate an untrusted binding (a generated module or a preview's reading). */
export function readSnapshotBinding(value: unknown): SnapshotBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const url = record['url'];
  const digest = record['digest'];
  if (typeof url !== 'string' || typeof digest !== 'string' || !isSnapshotDigest(digest)) return undefined;
  if (url !== snapshotRoute(digest)) return undefined;
  return {
    url,
    digest,
    applicationId: SNAPSHOT_APPLICATION_ID,
    userVersion: SNAPSHOT_USER_VERSION,
  };
}
