# SQLite file and query contract

`site.<sha256>.sqlite` is a rebuildable, public, immutable query projection. It is
not the source repository or compiler IR. This document owns its normative schema.

## File format version 1

Use application ID `0x4E475244` (the four bytes `NGRD`) and `user_version = 1`.
The application ID is ANC's project-local format discriminator, not a claim of
registration or cryptographic provenance. Producer, verifier, preview, and Worker
must share one implementation constant for each value.

```sql
PRAGMA application_id = 0x4E475244;
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;

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
```

Five tables and one explicitly declared secondary index. `UNIQUE(slug)` and
`UNIQUE(key)` also create indexes, as does `UNIQUE(node_id, alias)`; “one explicit
index” does not mean one B-tree. The alias PK supplies authored display order;
the alias uniqueness constraint prevents duplicate labels for the same note.
Entity `INTEGER PRIMARY KEY` values alias rowid. Composite relation keys use
`WITHOUT ROWID`. `STRICT` does not validate slug syntax, label normalization, or
publication eligibility; the producer and semantic gates still own those checks.
`nodes.language` is the bounded effective note language: the validated source
language, or the same navigation-language fallback used to render that note’s HTML.
It is required by mixed-language browser accessibility, not a speculative filter.
Alias ordinals are contiguous from zero in accepted author order; validate this
projection invariant rather than deriving order from SQLite text collation.
[SQLite rowid guidance](https://sqlite.org/withoutrowid.html) and
[STRICT tables](https://sqlite.org/stricttables.html) support these storage choices.

Enable and verify foreign-key enforcement before starting the write transaction.
No cascades, triggers, views, virtual tables, schema metadata table, or incremental
update machinery. Insert a fresh snapshot; do not copy a previous public DB and
delete withheld rows from it. This also avoids leaving removed text in free pages.

`edges` has a self-edge check because the content contract already excludes
self-links. Insert violations must fail, not be silently dropped with a blanket
`INSERT OR IGNORE`. Deduplicate known repeated links and tag memberships before
insertion; unexpected uniqueness or FK failures indicate a producer defect.

## Query ownership

Keep fixed, parameterized SQL and typed result mapping in one query module shared
by the build and Worker. A small native/WASM execution boundary is sufficient;
do not build a generic repository framework or interchangeable storage backend.

| Consumer | Query path | Access structure |
| --- | --- | --- |
| Slug lookup / preview | `nodes.slug = ?`, then aliases by node | Unique slug index; alias primary key |
| Outgoing | `edges.source_id = ?` | Edge primary key |
| Backlinks | `edges.target_id = ?` | `edges_by_target` |
| Notes with a tag | Tag key → tag ID → memberships | Unique tag key; membership primary key |
| Build-time tags for all notes | One joined scan grouped in memory | Avoid an N-per-page scan; no reverse index required |
| Local graph | Incoming ∪ outgoing, then induced edges | Both edge directions |
| Global graph / ranking | Aggregate the requested edge set | Computation, not a stored degree column |

Use explicit result order. Pagination order is canonical slug order — Unicode code
point order, which is SQLite `BINARY` (UTF-8 byte) order and which the producer
reproduces with `compareSlugs` in `src/lib/route-path.ts` when it assigns IDs —
never rowid or unspecified SQL order. JavaScript `<` compares UTF-16 units and
disagrees for astral characters, so it is not the canonical order. Presentation
ordering that already uses the JS title/slug comparator must keep that comparator;
SQLite binary Unicode order is not automatically the same as JavaScript UTF-16
ordering. Apply graph selection
limits after its documented ranking/order, not before sorting an arbitrary slice.

### Preview

```sql
SELECT id, slug, title, excerpt, language
FROM nodes
WHERE slug = :slug;

SELECT alias
FROM aliases
WHERE node_id = :node_id
ORDER BY ordinal;
```

Return aliases in their stored author order. Unknown slugs return no preview.
Treat strings as text in the DOM. A heading preview may display the bounded URL
fragment; no heading text or section-content lookup is implied.

### Outgoing and backlinks

```sql
SELECT n.slug, n.title, n.language
FROM edges AS e
JOIN nodes AS n ON n.id = e.target_id
WHERE e.source_id = :node_id
ORDER BY n.slug;

SELECT n.slug, n.title, n.language
FROM edges AS e
JOIN nodes AS n ON n.id = e.source_id
WHERE e.target_id = :node_id
ORDER BY n.slug;
```

The reverse index is required because every page has a backlink consumer. Do not
store `backlinks`, `in_degree`, or an inverse edge copy. Complete static lists can
consume batched query results; they must not inherit the old serialized-array
ceiling of 500 backlinks. UI drawing limits must not reject or truncate DB facts.

### Query by tag

```sql
SELECT n.slug, n.title, n.language
FROM tags AS t
JOIN node_tags AS nt ON nt.tag_id = t.id
JOIN nodes AS n ON n.id = nt.node_id
WHERE t.key = :tag_key
ORDER BY n.slug;
```

For a browser page, omit the cursor predicate on the first page; otherwise add
`n.slug > :after_slug`, with a bound `LIMIT :page_size_plus_one`. This same rule
applies to outgoing/backlink enumeration. Return at most the requested page size.
If an extra row exists, `nextCursor` is the **last returned** slug, not the extra
row's slug; otherwise it is null. A cursor is an exclusive lower bound within this
operation and snapshot, not a requirement that the named row still be a member.
Reset it when the subject, tag, or snapshot changes. An existing subject with an
exhausted page returns an empty list and null cursor; an unknown subject/tag is a
distinct no-match result. Cap and validate the positive integer page size in the
Worker. Never treat `LIMIT` as a bound on all work performed by a complex query.

Do not add `node_tags(node_id, tag_id)` merely because a build renders tags. Batch
the build read. If a new frequent node→tags consumer or measured build workload
needs the reverse index, evaluate it under the ablation rule; browser use is not
the only legitimate performance evidence.

### One-hop neighborhood

```sql
WITH neighbors(id) AS (
    SELECT target_id FROM edges WHERE source_id = :node_id
    UNION
    SELECT source_id FROM edges WHERE target_id = :node_id
)
SELECT n.id, n.slug, n.title, n.language
FROM neighbors AS x
JOIN nodes AS n ON n.id = x.id
ORDER BY n.slug;
```

After choosing the displayed nodes using the graph's ranking and limit, query all
directed edges whose two endpoints belong to that set. Use bound placeholders for
IDs, never interpolated data. The renderer may collapse reciprocal pairs visually.

Interactive expansion proceeds one hop at a time from a selected note. Each
expansion uses the same neighbor query; transient visited sets prevent repeating
nodes. Multi-hop exploration does not require storing closure or path data.
If a bulk traversal is added, bound visited nodes, depth, execution time, and
result size; a recursive CTE with `(id, depth)` and `UNION` alone does not eliminate
cycles across different depths. Arbitrary user SQL and unbounded shortest-path
execution are not part of the accepted browser query surface.

## Finalization and version changes

The writer fixes page size at 4096, encoding at UTF-8, and journal mode at DELETE
on a new file, before schema/data writes. Insert nodes and tags with explicit IDs
in deterministic order, then relations in primary-key order. Do not use WAL for
the published artifact, timestamps, nondeterministic IDs, or build-time counters.

After commit, run `PRAGMA foreign_key_check` (zero rows) and
`PRAGMA integrity_check` (exactly `ok`), then the semantic projection checks. Close
all writers before hashing or copying the file. No `-wal`, `-shm`, journal, or
private intermediate file may enter the published inventory.

Identical inputs under the pinned toolchain must produce identical DB bytes.
Byte identity across different SQLite/compiler versions is not assumed. The DB
hash identifies DB bytes, not the entire site: editing only a body can leave the
DB hash unchanged while HTML and Pagefind change.

Bump `user_version` when schema or stored-semantic changes require identifying a
different contract. The reader accepts exactly its current version. Rebuild from
source and replace affected consumers together; no historical readers, version
negotiation, compatibility adapters, or browser migrations. A mismatch fails to
the static baseline. Changes require the evidence and documentation
workflow in [verification and evolution](verification-and-evolution.md).
