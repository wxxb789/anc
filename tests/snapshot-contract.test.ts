/**
 * The shared snapshot schema contract, over the row-reader seam.
 *
 * The browser Worker and the build reader must agree on what a valid snapshot
 * is. These gates first accept a snapshot the producer actually wrote, then
 * mutate one declaration in each direction the contract names — column type,
 * `NOT NULL`, a foreign key, `STRICT`, `WITHOUT ROWID`, the self-edge `CHECK`,
 * and the one explicit index (redefined or joined by another) — so the check is
 * proven to read the schema rather than the header alone.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { validateArtifact } from '../src/lib/schema.ts';
import { SNAPSHOT_SCHEMA_SQL } from '../src/lib/snapshot.ts';
import { assertSnapshotRows, type SnapshotRowReader } from '../src/lib/snapshot-contract.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';

/** Open a throwaway database with `ddl` applied, then let a caller use it. */
function withDdl<T>(ddl: string, use: (database: DatabaseSync) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'anc-contract-'));
  try {
    const database = new DatabaseSync(join(directory, 'schema.sqlite'));
    try {
      database.exec(ddl);
      return use(database);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Apply the normative schema, then let a caller mutate it in place. */
function withSchema<T>(mutate: (database: DatabaseSync) => T): T {
  return withDdl(SNAPSHOT_SCHEMA_SQL, mutate);
}

function reader(database: DatabaseSync): SnapshotRowReader {
  return (sql) => database.prepare(sql).all() as Record<string, unknown>[];
}

/**
 * Apply the normative DDL with exactly one textual replacement, and prove the
 * replacement landed exactly once: a mutation that does not apply, or applies
 * to the wrong table, would let the control pass without testing anything.
 */
function mutatedSchema(from: string, to: string): string {
  const mutated = SNAPSHOT_SCHEMA_SQL.replace(from, to);
  assert.notEqual(mutated, SNAPSHOT_SCHEMA_SQL, `the schema mutation did not apply: ${from}`);
  assert.equal(mutated.indexOf(from), -1, `the schema mutation matched more than once: ${from}`);
  return mutated;
}

test('a snapshot the producer wrote is accepted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anc-contract-'));
  try {
    const artifact = validateArtifact(
      JSON.parse(readFileSync(new URL('./fixtures/valid-corpus.json', import.meta.url), 'utf8')),
      'tests/fixtures/valid-corpus.json',
    );
    const written = writeSnapshot(artifact, join(directory, 'site.sqlite'));
    const database = new DatabaseSync(written.path);
    try {
      assert.doesNotThrow(() => assertSnapshotRows(reader(database)));
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the exact schema is accepted', () => {
  withSchema((database) => assert.doesNotThrow(() => assertSnapshotRows(reader(database))));
});

test('a wrong application id or user version is rejected', () => {
  withSchema((database) => {
    database.exec('PRAGMA application_id = 1');
    assert.throws(() => assertSnapshotRows(reader(database)), /application_id/);
  });
  withSchema((database) => {
    database.exec('PRAGMA user_version = 99');
    assert.throws(() => assertSnapshotRows(reader(database)), /user_version/);
  });
});

test('an extra table, a missing index, or a changed column is rejected', () => {
  withSchema((database) => {
    database.exec('CREATE TABLE extra (x TEXT)');
    assert.throws(() => assertSnapshotRows(reader(database)), /tables are/);
  });
  withSchema((database) => {
    database.exec('DROP INDEX edges_by_target');
    assert.throws(() => assertSnapshotRows(reader(database)), /edges_by_target/);
  });
  withSchema((database) => {
    database.exec('ALTER TABLE nodes ADD COLUMN extra TEXT');
    assert.throws(() => assertSnapshotRows(reader(database)), /table nodes has columns/);
  });
});

test('an additional explicit index is rejected beside the accepted one', () => {
  withSchema((database) => {
    database.exec('CREATE INDEX node_tags_by_node ON node_tags(node_id, tag_id)');
    assert.throws(
      () => assertSnapshotRows(reader(database)),
      /explicit indexes are \[edges_by_target, node_tags_by_node\], expected \[edges_by_target\]/,
    );
  });
  withSchema((database) => {
    database.exec('CREATE INDEX nodes_title ON nodes(title)');
    assert.throws(
      () => assertSnapshotRows(reader(database)),
      /explicit indexes are \[edges_by_target, nodes_title\], expected \[edges_by_target\]/,
    );
  });
});

test('a view is rejected even when the five tables are intact', () => {
  withSchema((database) => {
    database.exec('CREATE VIEW leak AS SELECT slug FROM nodes');
    assert.throws(() => assertSnapshotRows(reader(database)), /unexpected schema objects/);
  });
});

test('a changed column type is rejected', () => {
  withDdl(mutatedSchema('id       INTEGER PRIMARY KEY', 'id       TEXT PRIMARY KEY'), (database) => {
    assert.throws(
      () => assertSnapshotRows(reader(database)),
      /table nodes column 1 .*type=TEXT.*type=INTEGER/,
    );
  });
});

test('a removed NOT NULL is rejected', () => {
  withDdl(mutatedSchema('slug     TEXT NOT NULL UNIQUE', 'slug     TEXT UNIQUE'), (database) => {
    assert.throws(
      () => assertSnapshotRows(reader(database)),
      /table nodes column 2 .*notnull=0 .*notnull=1/,
    );
  });
});

test('a dropped foreign key is rejected', () => {
  withDdl(
    mutatedSchema('source_id INTEGER NOT NULL REFERENCES nodes(id)', 'source_id INTEGER NOT NULL'),
    (database) => {
      assert.throws(
        () => assertSnapshotRows(reader(database)),
        /table edges has foreign keys \[target_id -> nodes\.id\], expected \[source_id -> nodes\.id, target_id -> nodes\.id\]/,
      );
    },
  );
});

test('a table that is not STRICT is rejected', () => {
  withDdl(mutatedSchema('    language TEXT NOT NULL\n) STRICT;', '    language TEXT NOT NULL\n);'), (database) => {
    assert.throws(() => assertSnapshotRows(reader(database)), /table nodes is not STRICT, expected STRICT/);
  });
});

test('a WITHOUT ROWID table declared as a rowid table is rejected', () => {
  withDdl(
    mutatedSchema(
      '    CHECK (source_id <> target_id)\n) WITHOUT ROWID, STRICT;',
      '    CHECK (source_id <> target_id)\n) STRICT;',
    ),
    (database) => {
      assert.throws(
        () => assertSnapshotRows(reader(database)),
        /table edges is a rowid table, expected WITHOUT ROWID/,
      );
    },
  );
});

test('the removed self-edge CHECK is rejected', () => {
  withDdl(
    mutatedSchema(
      '    PRIMARY KEY (source_id, target_id),\n    CHECK (source_id <> target_id)\n',
      '    PRIMARY KEY (source_id, target_id)\n',
    ),
    (database) => {
      assert.throws(
        () => assertSnapshotRows(reader(database)),
        /table edges is missing the CHECK \(source_id <> target_id\) constraint/,
      );
    },
  );
});

test('an edges_by_target index over the wrong columns is rejected', () => {
  withDdl(mutatedSchema('ON edges(target_id, source_id)', 'ON edges(source_id, target_id)'), (database) => {
    assert.throws(
      () => assertSnapshotRows(reader(database)),
      /index edges_by_target is on \[source_id, target_id\], expected \[target_id, source_id\]/,
    );
  });
});

test('a unique or partial edges_by_target index is rejected', () => {
  withDdl(mutatedSchema('CREATE INDEX edges_by_target', 'CREATE UNIQUE INDEX edges_by_target'), (database) => {
    assert.throws(
      () => assertSnapshotRows(reader(database)),
      /index edges_by_target is unique, expected not unique/,
    );
  });
  withDdl(
    mutatedSchema('ON edges(target_id, source_id);', 'ON edges(target_id, source_id) WHERE target_id > 0;'),
    (database) => {
      assert.throws(
        () => assertSnapshotRows(reader(database)),
        /index edges_by_target is partial, expected full/,
      );
    },
  );
});
