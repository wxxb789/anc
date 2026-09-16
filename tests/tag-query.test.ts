/**
 * Tag browsing over the real snapshot: identity, exhaustive cursor pagination,
 * and the page-boundary controls `docs/goals/0004-complete-tag-browsing.md`
 * names.
 *
 * The corpus is authored here, and every expected membership list, page size,
 * label, and member count is hand-written rather than read from `tagFacets` or
 * from the query result. `writeSnapshot` writes a real SQLite file, and
 * `tagPage` reads it through a `node:sqlite` adapter, so these are the native
 * halves of the goal's Identity, Exhaustive pagination, and Subject changes
 * rows. The Worker boundary (argument rejection) and the browser surfaces are
 * gated elsewhere.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';

import { validateArtifact, type ContentArtifact, type ContentEntry } from '../src/lib/schema.ts';
import { tagPage, type SnapshotDb } from '../src/lib/snapshot-operations.ts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type NoteSummary } from '../src/lib/snapshot-queries.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { NAV_LANGUAGE } from '../src/lib/translations.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';

/** Chosen below the corpus' gardening membership so three pages are required. */
const PAGE_SIZE = 7;

/**
 * The two canonical spellings of `café`, built from escapes so an editor, a
 * formatter, or git cannot normalize one into the other and leave the pair
 * asserting nothing.
 */
const NFC_CAFE = 'caf\u00e9';
const NFD_CAFE = 'cafe\u0301';

/**
 * The gardening membership in cursor order, hand-written from the authored
 * corpus rather than derived from `tagFacets` or SQL. 18 members at page size
 * 7 is exactly three pages: 7, 7, 4.
 */
const EXPECTED_GARDENING_SLUGS = [
  'both-case',
  'page-01',
  'page-02',
  'page-03',
  'page-04',
  'page-05',
  'page-06',
  'page-07',
  'page-08',
  'page-09',
  'page-10',
  'page-11',
  'page-12',
  'page-13',
  'page-14',
  'page-15',
  'page-16',
  'page-17',
];

/** A minimal valid entry; every field the snapshot writer reads is overridable. */
function entry(slug: string, overrides: Partial<ContentEntry> = {}): ContentEntry {
  return {
    slug,
    title: `Title ${slug}`,
    excerpt: '',
    markdown: `# ${slug}\n`,
    outgoing: [],
    backlinks: [],
    ...overrides,
  };
}

/**
 * The authored corpus: 17 notes alternating the two spellings of one tag, one
 * note carrying both spellings, an NFC/NFD accent pair, CJK and emoji labels,
 * and one isolated untagged note. `page-07` declares a language; every other
 * page note must fall back to `NAV_LANGUAGE`.
 */
const entries: ContentEntry[] = [
  ...Array.from({ length: 17 }, (_, index): ContentEntry => {
    const label = String(index + 1).padStart(2, '0');
    return entry(`page-${label}`, {
      tags: [(index + 1) % 2 === 1 ? 'Gardening' : 'gardening'],
      ...(label === '07' ? { language: 'zh-CN' } : {}),
    });
  }),
  entry('both-case', { tags: ['Gardening', 'gardening'] }),
  entry('cafe-nfc', { tags: [NFC_CAFE] }),
  entry('cafe-nfd', { tags: [NFD_CAFE] }),
  entry('cjk-note', { tags: ['笔记'] }),
  entry('emoji-note', { tags: ['🌱 seedling'] }),
  entry('plain'),
];

const artifact: ContentArtifact = validateArtifact({ version: 1, entries }, 'tag-query corpus');

/**
 * The snapshot is written once for the file. Every test below only reads it,
 * and a fresh write per test (schema, integrity, contract check, digest) cost
 * more than all the queries together. The one writable case opens its own
 * handle to the same file and only attempts an insert the primary key refuses.
 */
let snapshotDirectory: string;
let snapshotPath: string;

beforeAll(() => {
  snapshotDirectory = mkdtempSync(join(tmpdir(), 'anc-tag-query-'));
  snapshotPath = join(snapshotDirectory, 'site.sqlite');
  writeSnapshot(artifact, snapshotPath);
});

afterAll(() => rmSync(snapshotDirectory, { recursive: true, force: true }));

/** Run against the suite's one snapshot; each caller opens its own handle. */
function withSnapshot<T>(run: (path: string) => T): T {
  return run(snapshotPath);
}

/** A read-only handle running the fixed statements `tagPage` needs. */
function adapter(database: DatabaseSync): SnapshotDb {
  return {
    select: (sql, params) =>
      database.prepare(sql).all(...((params ?? []) as never[])) as Record<string, unknown>[],
  };
}

/**
 * The real adapter plus the parameters of every statement it was asked to run.
 *
 * Recording the bound values is what keeps the oversized-page control below
 * non-vacuous: the corpus is smaller than either page-size bound, so the
 * returned rows alone cannot tell a clamp at `MAX_PAGE_SIZE` from no clamp.
 */
function recordingAdapter(database: DatabaseSync): { db: SnapshotDb; boundParams: unknown[][] } {
  const boundParams: unknown[][] = [];
  const db = adapter(database);
  return {
    boundParams,
    db: {
      select: (sql, params) => {
        boundParams.push([...(params ?? [])]);
        return db.select(sql, params);
      },
    },
  };
}

/**
 * The enumeration oracle: the exact authored slugs in cursor order, each once.
 *
 * Deliberately usable on a wrong walker as well as a correct one — the
 * lookahead control below proves it detects a skipped note rather than merely
 * restating whatever the walk returned.
 */
function assertEnumerates(actual: readonly NoteSummary[], expected: readonly string[]): void {
  const slugs = actual.map((note) => note.slug);
  // Uniqueness first: it names the defect directly, while a duplicate would
  // otherwise surface as an unexplained deep-equal mismatch.
  assert.equal(new Set(slugs).size, slugs.length, 'a slug was enumerated more than once');
  assert.deepEqual(slugs, expected, 'the enumerated membership is not the authored list in cursor order');
}

/** The correct walker: continue from the last returned slug until exhaustion. */
function walkTag(db: SnapshotDb): NoteSummary[] {
  const notes: NoteSummary[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = tagPage(db, 'gardening', cursor, PAGE_SIZE);
    if (!page.known) assert.fail('gardening is a known tag in the authored corpus');
    notes.push(...page.notes);
    if (page.nextCursor === null) return notes;
    cursor = page.nextCursor;
  }
}

test('the real snapshot reaches every gardening note across cursor pages', () => {
  // Exhaustive pagination over the finalized file, not `pageOf` in isolation:
  // the walk follows `nextCursor`, and the expected slugs, page sizes, and
  // fallback language are hand-written from the authored corpus.
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const db = adapter(database);
      const sizes: number[] = [];
      const collected: NoteSummary[] = [];
      let cursor: string | null = null;
      let exhausted = false;
      for (;;) {
        const page = tagPage(db, 'gardening', cursor, PAGE_SIZE);
        if (!page.known) assert.fail('gardening is a known tag in the authored corpus');
        sizes.push(page.notes.length);
        collected.push(...page.notes);
        if (page.nextCursor === null) {
          exhausted = true;
          break;
        }
        // The contract's cursor is the last *returned* slug. A cursor built from
        // the `pageSize + 1` lookahead row would skip that row on the next page.
        assert.equal(page.nextCursor, page.notes.at(-1)?.slug, 'nextCursor is not the last returned slug');
        cursor = page.nextCursor;
      }

      assert.ok(exhausted, 'the walk ended without a null continuation');
      assert.deepEqual(sizes, [7, 7, 4], 'the walk did not page as 7/7/4 at page size 7');
      assertEnumerates(collected, EXPECTED_GARDENING_SLUGS);

      const authored = new Map(entries.map((candidate) => [candidate.slug, candidate]));
      for (const note of collected) {
        const source = authored.get(note.slug);
        assert.ok(source !== undefined, `the query returned a slug outside the authored corpus: ${note.slug}`);
        assert.equal(note.title, source.title, `the title for ${note.slug} does not come from the authored corpus`);
        // Every row must carry the target note's effective language: the
        // declared one, else the `NAV_LANGUAGE` fallback the writer stored.
        assert.equal(note.language, source.language ?? NAV_LANGUAGE);
      }
      const zh = collected.find((note) => note.slug === 'page-07');
      assert.equal(zh?.title, 'Title page-07');
      assert.equal(zh?.language, 'zh-CN');
      assert.equal(collected.find((note) => note.slug === 'page-01')?.language, 'en');
    } finally {
      database.close();
    }
  });
});

test('a walker that continues from the lookahead row drops notes the oracle detects', () => {
  // A control over the assertion, not over production behavior: this walker
  // deliberately passes the member immediately after the last returned slug,
  // so each page boundary drops one row. The hand-computed damage at page size
  // 7 is page-07 and page-15, and the same oracle the correct walk passes must
  // reject the result.
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const db = adapter(database);
      const wrong: NoteSummary[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = tagPage(db, 'gardening', cursor, PAGE_SIZE);
        if (!page.known) assert.fail('gardening is a known tag in the authored corpus');
        wrong.push(...page.notes);
        if (page.nextCursor === null) break;
        const lookahead = EXPECTED_GARDENING_SLUGS.indexOf(page.nextCursor) + 1;
        cursor = EXPECTED_GARDENING_SLUGS[lookahead]!;
      }

      assert.equal(wrong.length, 16, 'the wrong walker collected an unexpected number of notes');
      const collected = new Set(wrong.map((note) => note.slug));
      assert.deepEqual(
        EXPECTED_GARDENING_SLUGS.filter((slug) => !collected.has(slug)),
        ['page-07', 'page-15'],
        'the wrong walker did not skip the hand-computed lookahead rows',
      );
      assert.throws(
        () => assertEnumerates(wrong, EXPECTED_GARDENING_SLUGS),
        'the enumeration oracle accepted a walk that skipped its lookahead row',
      );
      assertEnumerates(walkTag(db), EXPECTED_GARDENING_SLUGS);
    } finally {
      database.close();
    }
  });
});

test('tag identity and membership at the table level match the authored corpus', () => {
  // Raw SQL, not `tagFacets` and not `tagPage`: the tables themselves must carry
  // one row per canonical tag, the representative label, and one membership per
  // note, including the note that carries two spellings of one tag.
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      // Spread each row: `node:sqlite` returns null-prototype objects, which
      // strict deep equality compares by prototype.
      const rows = <T>(sql: string, params: readonly unknown[] = []): T[] =>
        (database.prepare(sql).all(...(params as never[])) as unknown as T[]).map((row) => ({ ...row }));

      // The surviving café label is the *decomposed* spelling. `facets` picks
      // the lexicographically smallest raw source label with `<`, and
      // 'cafe\u0301' < 'café' because U+0065 precedes U+00E9; the choice is
      // deterministic in either artifact order. The key is the NFC form,
      // because `routeKey` normalizes before slugifying and does not strip the
      // accent.
      assert.deepEqual(
        rows<{ key: string; label: string }>('SELECT key, label FROM tags ORDER BY key'),
        [
          { key: NFC_CAFE, label: NFD_CAFE },
          { key: 'gardening', label: 'Gardening' },
          { key: 'seedling', label: '🌱 seedling' },
          { key: '笔记', label: '笔记' },
        ],
        'the tag table does not carry exactly the canonical tags of the authored corpus',
      );

      const members = (key: string): string[] =>
        rows<{ slug: string }>(
          `SELECT n.slug AS slug
           FROM node_tags AS nt
           JOIN tags AS t ON t.id = nt.tag_id
           JOIN nodes AS n ON n.id = nt.node_id
           WHERE t.key = ?
           ORDER BY n.slug`,
          [key],
        ).map((row) => row.slug);

      const gardeningMembers = members('gardening');
      assert.deepEqual(gardeningMembers, EXPECTED_GARDENING_SLUGS);
      assert.equal(
        gardeningMembers.filter((slug) => slug === 'both-case').length,
        1,
        'the note carrying both spellings was recorded as two memberships',
      );
      assert.deepEqual(
        members(NFC_CAFE),
        ['cafe-nfc', 'cafe-nfd'],
        'the two café spellings did not collapse to one tag with two members',
      );
      assert.deepEqual(
        rows<{ key: string }>('SELECT key FROM tags WHERE key = ?', ['GARDENING']),
        [],
        'the tag table matched an uppercase key without the accepted Unicode lowercasing',
      );
    } finally {
      database.close();
    }
  });
});

test('the tag lookup is exact and the key column is BINARY, so NOCASE is not substituted', () => {
  // Unicode lowercasing happens once, in `routes.ts`; substituting SQLite
  // NOCASE for it would change which labels match and which collide. A change
  // to either the query or the column's declared collation must fail here.
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const db = adapter(database);
      assert.deepEqual(
        tagPage(db, 'GARDENING', null, PAGE_SIZE),
        { known: false },
        'an uppercase key matched, so the lookup substituted a case-insensitive comparison',
      );

      const indexes = database.prepare('PRAGMA index_list(tags)').all() as unknown as {
        name: string;
        unique: number;
      }[];
      const unique = indexes.filter((index) => index.unique === 1);
      assert.equal(unique.length, 1, `tags does not carry exactly one unique index: ${JSON.stringify(indexes)}`);
      const indexName = unique[0]!.name;
      const columns = database
        .prepare(`PRAGMA index_xinfo('${indexName.replaceAll("'", "''")}')`)
        .all() as unknown as { name: string | null; coll: string }[];
      const key = columns.find((column) => column.name === 'key');
      assert.ok(key !== undefined, `the unique index does not index the key column: ${JSON.stringify(columns)}`);
      assert.equal(key.coll, 'BINARY', 'the tag key column carries a non-BINARY collation');
    } finally {
      database.close();
    }
  });
});

test('an unknown tag is distinct from a known tag with no further results', () => {
  // `docs/core-design/sqlite-contract.md`: an unknown subject/tag is a distinct
  // no-match result, and a cursor is an exclusive lower bound within the
  // operation, not a requirement that the named row is still a member.
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const db = adapter(database);
      assert.deepEqual(tagPage(db, 'zzq-not-a-tag', null, PAGE_SIZE), { known: false });

      const exhausted = {
        known: true as const,
        tag: { key: 'gardening', label: 'Gardening' },
        notes: [],
        nextCursor: null,
      };
      assert.deepEqual(tagPage(db, 'gardening', 'page-17', PAGE_SIZE), exhausted);
      assert.deepEqual(
        tagPage(db, 'gardening', 'zzz-not-a-member', PAGE_SIZE),
        exhausted,
        'a cursor beyond every member must stay a known, exhausted tag',
      );
    } finally {
      database.close();
    }
  });
});

test('page size normalizes to the bounded default instead of unbounded work', () => {
  // Zero, a missing value, and an over-maximum value are all bounded by
  // `normalizePageSize`; argument *rejection* belongs to the Worker boundary
  // and is gated in `tests/worker-protocol.test.ts`.
  //
  // The corpus holds 18 gardening notes — fewer than either bound — so the
  // returned rows would look identical if `10_000` reached the statement
  // unclamped. The recorded bound is what makes that case fail here: the
  // membership query must be handed the clamped size plus one lookahead row.
  withSnapshot((path) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const cases: { requested: number | undefined; limit: number }[] = [
        { requested: 0, limit: DEFAULT_PAGE_SIZE + 1 },
        { requested: undefined, limit: DEFAULT_PAGE_SIZE + 1 },
        { requested: 10_000, limit: MAX_PAGE_SIZE + 1 },
      ];
      for (const { requested, limit } of cases) {
        const { db, boundParams } = recordingAdapter(database);
        const page = tagPage(db, 'gardening', null, requested);
        if (!page.known) assert.fail('gardening is a known tag in the authored corpus');
        assertEnumerates(page.notes, EXPECTED_GARDENING_SLUGS);
        assert.equal(page.nextCursor, null, `pageSize ${String(requested)} did not exhaust the tag`);
        assert.equal(
          boundParams.at(-1)?.[1],
          limit,
          `pageSize ${String(requested)} did not bind the clamped lookahead limit`,
        );
      }
    } finally {
      database.close();
    }
  });
});

test('a second membership for one note under one tag is refused', () => {
  // The failure control for "one membership per note": the membership primary
  // key, not the writer's grouping, is what makes a duplicate impossible.
  withSnapshot((path) => {
    const writable = new DatabaseSync(path);
    try {
      assert.throws(
        () =>
          writable
            .prepare(
              `INSERT INTO node_tags (tag_id, node_id)
               SELECT tag_id, node_id FROM node_tags
               WHERE tag_id = (SELECT id FROM tags WHERE key = ?)
               LIMIT 1`,
            )
            .run('gardening'),
        /constraint failed/i,
        'the snapshot accepted the same note twice under one tag',
      );
    } finally {
      writable.close();
    }
  });
});
