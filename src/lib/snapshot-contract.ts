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
 * unexpected table or column, and a query against it would then return
 * something whose meaning differs from the contract.
 */

import {
  SNAPSHOT_APPLICATION_ID,
  SNAPSHOT_EXPLICIT_INDEX,
  SNAPSHOT_TABLE_COLUMNS,
  SNAPSHOT_TABLES,
  SNAPSHOT_USER_VERSION,
} from './snapshot.ts';

/** Runs one statement and returns its rows as plain records. */
export type SnapshotRowReader = (sql: string) => Record<string, unknown>[];

/** One row of `PRAGMA table_info`, limited to the fields the contract uses. */
interface TableInfoRow {
  name?: unknown;
  pk?: unknown;
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

  const objects = read("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const tables = objects
    .filter((row) => row['type'] === 'table')
    .map((row) => String(row['name']))
    .sort();
  if (tables.join(',') !== [...SNAPSHOT_TABLES].sort().join(',')) {
    throw new Error(`snapshot tables are [${tables.join(', ')}], expected [${SNAPSHOT_TABLES.join(', ')}]`);
  }
  const otherObjects = objects.filter((row) => row['type'] !== 'table' && row['type'] !== 'index');
  if (otherObjects.length > 0) {
    throw new Error(
      `snapshot carries unexpected schema objects: ${otherObjects
        .map((row) => `${String(row['type'])} ${String(row['name'])}`)
        .join(', ')}`,
    );
  }

  for (const [table, columns] of Object.entries(SNAPSHOT_TABLE_COLUMNS)) {
    const actual = read(`PRAGMA table_info(${table})`) as TableInfoRow[];
    const shape = actual.map((row) => `${String(row.name)}:${String(row.pk)}`);
    const expected = columns.map((column) => `${column.name}:${column.pk}`);
    if (shape.length !== expected.length || shape.some((value, index) => value !== expected[index])) {
      throw new Error(
        `snapshot table ${table} has columns [${shape.join(', ')}], expected [${expected.join(', ')}]`,
      );
    }
  }

  const indexes = read("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  if (!indexes.some((row) => row['name'] === SNAPSHOT_EXPLICIT_INDEX)) {
    throw new Error(`snapshot is missing the ${SNAPSHOT_EXPLICIT_INDEX} index`);
  }
}
