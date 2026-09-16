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
 * Default private workspace for the producer's staged bindings, relative to the
 * working directory that started the build.
 *
 * Private means never in `dist/`: `docs/core-design/build-and-runtime.md` owns
 * why no public manifest exists. The default lives here so `astro.config.mjs`
 * (which substitutes the binding) and `snapshot-reader.ts` (which reads the
 * staged edges) cannot resolve different directories.
 */
export const DEFAULT_SNAPSHOT_WORKSPACE = '.astro/snapshot';

/**
 * Apply the `SNAPSHOT_WORKSPACE` setting: the value when one is set, otherwise
 * the default.
 *
 * `||` rather than `??`: an empty value is a caller who meant to pass a path and
 * passed nothing. With `??` an empty value resolved to the working directory,
 * so the build staged one directory while `snapshot-reader.ts` looked in
 * another, `astro.config.mjs` substituted `null` for the binding, and the lazy
 * runtime silently never started — with no build error. Both sites call this
 * one function.
 *
 * Takes the raw environment value rather than reading the environment here: the
 * same module loads inside the browser Worker, where no workspace is ever
 * resolved, so it stays free of Node globals.
 */
export function configuredSnapshotWorkspace(environment: string | undefined): string {
  return environment || DEFAULT_SNAPSHOT_WORKSPACE;
}

/**
 * The normative schema. Five entity/relation tables and one explicit secondary
 * index; the `UNIQUE` constraints create their own B-trees, which is expected.
 *
 * Applied in one `exec` before any row is written. `PRAGMA foreign_keys` is a
 * connection setting, not stored in the file, so a reader must set it too; the
 * producer enables and verifies it before the write transaction.
 *
 * `SNAPSHOT_TABLE_SHAPES` and `SNAPSHOT_EXPLICIT_INDEX` below restate this DDL
 * for the reader's validator, which cannot parse SQL. Keep the two in step:
 * the validator's positive control writes a real snapshot, so a change here
 * that is not mirrored there fails the build rather than the browser.
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

/**
 * One column's declared shape, as `PRAGMA table_info` reports it: the declared
 * type keyword and `NOT NULL` option are part of the storage contract, not a
 * summary of the values a query later sees.
 */
export interface SnapshotColumn {
  name: string;
  /** Declared type keyword; `STRICT` admits only these two in this schema. */
  type: 'INTEGER' | 'TEXT';
  /**
   * `PRAGMA table_info.notnull`: true only where the DDL spells `NOT NULL`.
   * `INTEGER PRIMARY KEY` reports false even though `INTEGER PRIMARY KEY`
   * values can never be null, so this mirrors the declared keyword exactly.
   */
  notNull: boolean;
  /** 0 when not a primary-key member, otherwise the 1-based key position. */
  pk: number;
}

/**
 * One foreign key, as one row of `PRAGMA foreign_key_list` reports it. The
 * schema declares only single-column references, so `seq` is not modelled.
 */
export interface SnapshotForeignKey {
  /** Column in the declaring table. */
  from: string;
  /** Referenced table. */
  table: string;
  /** Referenced column, always the referenced table's `id`. */
  to: string;
}

/**
 * One table's full declared shape. `PRAGMA table_info` carries the columns and
 * `PRAGMA table_list` the storage options; `CHECK` clauses are visible only in
 * the stored `sqlite_schema.sql` text, which `SNAPSHOT_SCHEMA_SQL` supplies
 * verbatim to the writer.
 */
export interface SnapshotTable {
  columns: readonly SnapshotColumn[];
  /** Declared `STRICT`; `PRAGMA table_list.strict`. */
  strict: boolean;
  /** Declared `WITHOUT ROWID`; `PRAGMA table_list.wr`. */
  withoutRowid: boolean;
  foreignKeys: readonly SnapshotForeignKey[];
  /**
   * Table-level `CHECK` clauses, matched inside the stored DDL after case and
   * whitespace folding. Every entry is the exact clause text as spelled in
   * `SNAPSHOT_SCHEMA_SQL`; a table with no `CHECK` has an empty list.
   */
  checks: readonly string[];
  /**
   * The table's `UNIQUE` constraints, each as its indexed columns in
   * declaration order joined with commas. SQLite backs every UNIQUE constraint
   * with an implicit `sqlite_autoindex_*` index that the name filter above
   * hides from the explicit-index comparison, so without this list a
   * producer-side `UNIQUE (node_id, tag_id)` would grow a reverse membership
   * index the contract never sees. A table with no `UNIQUE` constraint has an
   * empty list. Flat strings rather than nested arrays so the bundled Worker
   * chunk cannot spell an unresolved `[[` byte sequence.
   */
  uniqueConstraints: readonly string[];
}

/**
 * The expected shape of each table, keyed and ordered as `SNAPSHOT_SCHEMA_SQL`
 * declares them. A reader validates every field once per imported snapshot, so
 * a header that matches the constants but carries an unexpected column type,
 * dropped constraint, storage option, or index fails closed rather than
 * running a query whose result means something else.
 *
 * This restates the DDL above for the reader's validator; the positive control
 * that validates a snapshot the writer just produced is what keeps the two
 * from drifting apart.
 */
export const SNAPSHOT_TABLE_SHAPES: Readonly<Record<string, SnapshotTable>> = {
  nodes: {
    strict: true,
    withoutRowid: false,
    columns: [
      { name: 'id', type: 'INTEGER', notNull: false, pk: 1 },
      { name: 'slug', type: 'TEXT', notNull: true, pk: 0 },
      { name: 'title', type: 'TEXT', notNull: true, pk: 0 },
      { name: 'excerpt', type: 'TEXT', notNull: true, pk: 0 },
      { name: 'language', type: 'TEXT', notNull: true, pk: 0 },
    ],
    foreignKeys: [],
    checks: [],
    uniqueConstraints: ['slug'],
  },
  edges: {
    strict: true,
    withoutRowid: true,
    columns: [
      { name: 'source_id', type: 'INTEGER', notNull: true, pk: 1 },
      { name: 'target_id', type: 'INTEGER', notNull: true, pk: 2 },
    ],
    foreignKeys: [
      { from: 'source_id', table: 'nodes', to: 'id' },
      { from: 'target_id', table: 'nodes', to: 'id' },
    ],
    checks: ['CHECK (source_id <> target_id)'],
    uniqueConstraints: [],
  },
  aliases: {
    strict: true,
    withoutRowid: true,
    columns: [
      { name: 'node_id', type: 'INTEGER', notNull: true, pk: 1 },
      { name: 'ordinal', type: 'INTEGER', notNull: true, pk: 2 },
      { name: 'alias', type: 'TEXT', notNull: true, pk: 0 },
    ],
    foreignKeys: [{ from: 'node_id', table: 'nodes', to: 'id' }],
    checks: ['CHECK (ordinal >= 0)'],
    uniqueConstraints: ['node_id,alias'],
  },
  tags: {
    strict: true,
    withoutRowid: false,
    columns: [
      { name: 'id', type: 'INTEGER', notNull: false, pk: 1 },
      { name: 'key', type: 'TEXT', notNull: true, pk: 0 },
      { name: 'label', type: 'TEXT', notNull: true, pk: 0 },
    ],
    foreignKeys: [],
    checks: [],
    uniqueConstraints: ['key'],
  },
  node_tags: {
    strict: true,
    withoutRowid: true,
    columns: [
      { name: 'tag_id', type: 'INTEGER', notNull: true, pk: 1 },
      { name: 'node_id', type: 'INTEGER', notNull: true, pk: 2 },
    ],
    foreignKeys: [
      { from: 'tag_id', table: 'tags', to: 'id' },
      { from: 'node_id', table: 'nodes', to: 'id' },
    ],
    checks: [],
    uniqueConstraints: [],
  },
};

/** The five user tables, in the order the schema declares them. */
export const SNAPSHOT_TABLES: readonly string[] = Object.keys(SNAPSHOT_TABLE_SHAPES);

/** The one explicitly created secondary index and its exact definition. */
export interface SnapshotIndex {
  name: string;
  /** Table the index is declared on. */
  table: string;
  /** Indexed columns, in index order. */
  columns: readonly string[];
  /** `PRAGMA index_list.unique`; the reverse index makes no uniqueness claim. */
  unique: boolean;
  /** `PRAGMA index_list.partial`; the reverse index covers every edge row. */
  partial: boolean;
}

export const SNAPSHOT_EXPLICIT_INDEX: SnapshotIndex = {
  name: 'edges_by_target',
  table: 'edges',
  columns: ['target_id', 'source_id'],
  unique: false,
  partial: false,
};

/** A full lowercase-hex SHA-256, as it appears in a digest-named artifact. */
export function isHexDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** The snapshot's own digest predicate; kept as the named public spelling. */
export const isSnapshotDigest: (value: string) => boolean = isHexDigest;

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
