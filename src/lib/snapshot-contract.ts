/**
 * The snapshot's exact schema contract, over a row-reader rather than a driver.
 *
 * Both drivers that can open a snapshot — the native build reader and the
 * browser WASM reader — must accept and reject the same files. Expressing the
 * check as "run these SQL statements and give me rows" lets one implementation
 * serve both without either importing the other; `scripts/write-snapshot.ts`
 * adapts `node:sqlite`, and the browser Worker adapts the WASM connection.
 *
 * The check is deliberately not satisfied by the header constants: a file can
 * carry the right `application_id` and `user_version` and still have an
 * unexpected column type, dropped `NOT NULL`, foreign key, `STRICT`/
 * `WITHOUT ROWID` option, `CHECK`, or explicit index — added, removed, or
 * reshaped (columns, uniqueness, partiality) — and a query against it would then
 * return something whose meaning differs from the contract.
 *
 * Every statement issued here is a read-only `PRAGMA` or `sqlite_schema`
 * query, so the reader can stay read-only. `CHECK` clauses are the one
 * declaration SQLite exposes only in the stored DDL text; they are matched
 * after case and whitespace folding, which is stable because the writer
 * applies `SNAPSHOT_SCHEMA_SQL` verbatim.
 */

import {
  SNAPSHOT_APPLICATION_ID,
  SNAPSHOT_EXPLICIT_INDEX,
  SNAPSHOT_TABLE_SHAPES,
  SNAPSHOT_TABLES,
  SNAPSHOT_USER_VERSION,
  type SnapshotForeignKey,
  type SnapshotTable,
} from './snapshot.ts';

/** Runs one statement and returns its rows as plain records. */
export type SnapshotRowReader = (sql: string) => Record<string, unknown>[];

/** Collapse case and whitespace so stored DDL compares by clause, not layout. */
function foldSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toUpperCase();
}

/** `from -> table.to`, so foreign keys compare as a set, not in pragma order. */
function foreignKeyText(key: SnapshotForeignKey): string {
  return `${key.from} -> ${key.table}.${key.to}`;
}

/** Order foreign keys by their printed form; `PRAGMA` order is not stable. */
function byForeignKeyText(left: SnapshotForeignKey, right: SnapshotForeignKey): number {
  const leftText = foreignKeyText(left);
  const rightText = foreignKeyText(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

/** Fail unless `PRAGMA table_info` matches the declared columns exactly. */
function assertColumns(read: SnapshotRowReader, table: string, columns: SnapshotTable['columns']): void {
  const actual = read(`PRAGMA table_info(${table})`);
  if (actual.length !== columns.length) {
    throw new Error(
      `snapshot table ${table} has columns [${actual.map((row) => String(row['name'])).join(', ')}], ` +
        `expected [${columns.map((column) => column.name).join(', ')}]`,
    );
  }
  for (const [index, column] of columns.entries()) {
    const row = actual[index]!;
    const actualText =
      `name=${String(row['name'])} type=${String(row['type'])} ` +
      `notnull=${String(row['notnull'])} pk=${String(row['pk'])}`;
    const expectedText =
      `name=${column.name} type=${column.type} ` +
      `notnull=${column.notNull ? 1 : 0} pk=${column.pk}`;
    if (actualText !== expectedText) {
      throw new Error(`snapshot table ${table} column ${index + 1} is ${actualText}, expected ${expectedText}`);
    }
  }
}

/** Fail unless `PRAGMA table_list` reports the declared kind and options. */
function assertTableOptions(listed: Record<string, unknown>[], table: string, shape: SnapshotTable): void {
  const row = listed.find((candidate) => candidate['name'] === table);
  if (row === undefined) throw new Error(`snapshot table ${table} is absent from PRAGMA table_list`);
  const kind = String(row['type']);
  if (kind !== 'table') {
    throw new Error(`snapshot table ${table} is a ${kind}, expected an ordinary table`);
  }
  const strict = Number(row['strict']) === 1;
  if (strict !== shape.strict) {
    throw new Error(
      `snapshot table ${table} is ${strict ? 'STRICT' : 'not STRICT'}, ` +
        `expected ${shape.strict ? 'STRICT' : 'not STRICT'}`,
    );
  }
  const withoutRowid = Number(row['wr']) === 1;
  if (withoutRowid !== shape.withoutRowid) {
    throw new Error(
      `snapshot table ${table} is ${withoutRowid ? 'WITHOUT ROWID' : 'a rowid table'}, ` +
        `expected ${shape.withoutRowid ? 'WITHOUT ROWID' : 'a rowid table'}`,
    );
  }
}

/** Fail unless `PRAGMA foreign_key_list` matches the declared references. */
function assertForeignKeys(read: SnapshotRowReader, table: string, expected: SnapshotTable['foreignKeys']): void {
  const actual = read(`PRAGMA foreign_key_list(${table})`)
    .map((row) => ({ from: String(row['from']), table: String(row['table']), to: String(row['to']) }))
    .sort(byForeignKeyText);
  const wanted = expected.map((key) => ({ ...key })).sort(byForeignKeyText);
  const actualText = actual.map(foreignKeyText);
  const wantedText = wanted.map(foreignKeyText);
  if (actualText.join(',') !== wantedText.join(',')) {
    throw new Error(
      `snapshot table ${table} has foreign keys [${actualText.join(', ')}], ` +
        `expected [${wantedText.join(', ')}]`,
    );
  }
}

/** Fail unless every declared `CHECK` clause survives in the stored DDL. */
function assertChecks(storedSql: string, table: string, checks: SnapshotTable['checks']): void {
  const folded = foldSql(storedSql);
  for (const check of checks) {
    if (!folded.includes(foldSql(check))) {
      throw new Error(`snapshot table ${table} is missing the ${check} constraint`);
    }
  }
}

/** Fail unless the one explicit secondary index matches its declared definition. */
function assertExplicitIndex(read: SnapshotRowReader): void {
  const index = SNAPSHOT_EXPLICIT_INDEX;
  const row = read(`PRAGMA index_list(${index.table})`).find((candidate) => candidate['name'] === index.name);
  if (row === undefined) {
    throw new Error(`snapshot table ${index.table} is missing the ${index.name} index`);
  }
  const unique = Number(row['unique']) === 1;
  if (unique !== index.unique) {
    throw new Error(
      `snapshot index ${index.name} is ${unique ? 'unique' : 'not unique'}, ` +
        `expected ${index.unique ? 'unique' : 'not unique'}`,
    );
  }
  const partial = Number(row['partial']) === 1;
  if (partial !== index.partial) {
    throw new Error(
      `snapshot index ${index.name} is ${partial ? 'partial' : 'full'}, ` +
        `expected ${index.partial ? 'partial' : 'full'}`,
    );
  }
  const columns = read(`PRAGMA index_info(${index.name})`)
    .map((info) => ({ seqno: Number(info['seqno']), name: String(info['name']) }))
    .sort((left, right) => left.seqno - right.seqno)
    .map((info) => info.name);
  if (columns.join(',') !== index.columns.join(',')) {
    throw new Error(
      `snapshot index ${index.name} is on [${columns.join(', ')}], expected [${index.columns.join(', ')}]`,
    );
  }
}

/**
 * Fail unless the connection carries exactly the accepted schema.
 *
 * @param read A function that executes one SQL statement on the imported
 *   snapshot. It must not write. `PRAGMA` statements and reads only.
 * @throws {Error} naming the first discrepancy, so a mismatch fails closed.
 */
export function assertSnapshotRows(read: SnapshotRowReader): void {
  const applicationId = read('PRAGMA application_id')[0]?.['application_id'];
  if (applicationId !== SNAPSHOT_APPLICATION_ID) {
    throw new Error(`snapshot application_id is ${String(applicationId)}, expected ${SNAPSHOT_APPLICATION_ID}`);
  }
  const userVersion = read('PRAGMA user_version')[0]?.['user_version'];
  if (userVersion !== SNAPSHOT_USER_VERSION) {
    throw new Error(`snapshot user_version is ${String(userVersion)}, expected ${SNAPSHOT_USER_VERSION}`);
  }

  const objects = read(
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
  );
  const tables = objects
    .filter((row) => row['type'] === 'table')
    .map((row) => String(row['name']))
    .sort();
  const expectedTables = [...SNAPSHOT_TABLES].sort();
  if (tables.join(',') !== expectedTables.join(',')) {
    throw new Error(`snapshot tables are [${tables.join(', ')}], expected [${SNAPSHOT_TABLES.join(', ')}]`);
  }
  // `sqlite_schema` hides the UNIQUE constraints' implicit `sqlite_` indexes
  // behind the query's name filter, so the index rows that remain are exactly
  // the explicitly created ones. The filter matches `sqlite_` literally — the
  // underscore is escaped, because an unescaped LIKE `_` is a wildcard and
  // would also hide a user-creatable name such as `sqliteX`. This must equal
  // the one accepted index: an added reverse membership index, a renamed
  // accepted index, or a missing accepted index each change the storage
  // contract. `assertExplicitIndex` below still checks that index's declared
  // shape.
  const indexes = objects
    .filter((row) => row['type'] === 'index')
    .map((row) => String(row['name']))
    .sort();
  const expectedIndexes = [SNAPSHOT_EXPLICIT_INDEX.name];
  if (indexes.join(',') !== expectedIndexes.join(',')) {
    throw new Error(
      `snapshot explicit indexes are [${indexes.join(', ')}], expected [${expectedIndexes.join(', ')}]`,
    );
  }
  const otherObjects = objects.filter((row) => row['type'] !== 'table' && row['type'] !== 'index');
  if (otherObjects.length > 0) {
    throw new Error(
      `snapshot carries unexpected schema objects: ${otherObjects
        .map((row) => `${String(row['type'])} ${String(row['name'])}`)
        .join(', ')}`,
    );
  }

  // The stored DDL is the only place a CHECK clause survives; the table-list
  // pragma is the only place STRICT/WITHOUT ROWID survive.
  const storedSql = new Map(
    objects
      .filter((row) => row['type'] === 'table')
      .map((row) => [String(row['name']), String(row['sql'] ?? '')]),
  );
  const listed = read('PRAGMA table_list');

  for (const [table, shape] of Object.entries(SNAPSHOT_TABLE_SHAPES)) {
    assertColumns(read, table, shape.columns);
    assertTableOptions(listed, table, shape);
    assertForeignKeys(read, table, shape.foreignKeys);
    assertChecks(storedSql.get(table) ?? '', table, shape.checks);
  }
  assertExplicitIndex(read);
}
