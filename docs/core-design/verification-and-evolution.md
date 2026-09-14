# Verification and design evolution

## Evidence and responsibility

Core design defines invariants and evaluation methods. Active development goals
in [`docs/goals/`](../goals/README.md) define bounded outcomes, workload-specific
benchmarks, and completion judgments; completed goals retain evidence in their
archive. An architecture document is not a claim that a goal or release is done.

Keep one repository verification entry point, `pnpm run verify`, invoked by CI.
Extend the actual pipeline rather than adding a parallel gate that bypasses
existing publication checks. A documentation-only PR reports its document/SQL
checks and unavailable full-suite prerequisites honestly.

## Required evidence for the implementation

| Area | Positive evidence | Required failure/control |
| --- | --- | --- |
| Schema | Exact five tables, columns, PKs, FKs, STRICT/rowid options and expected indexes | Extra column/table, trigger/view, self-edge, duplicate, or dangling edge is rejected |
| Public projection | Rows equal the approved published metadata, normalized tags, aliases and links | Add a withheld/orphan row, change a preview field, or remove a real relation; fail |
| SQL consumers | Static lists and Worker results agree with authored cross-note links | Invert an edge or omit a neighbor-to-neighbor edge; fail |
| Tags/aliases | Case/NFC equivalence, collisions, duplicate membership and shared aliases behave as specified | A `C++`/`C#` collision fails; a same-note duplicate membership cannot inflate counts |
| DB integrity | Correct application ID/version, integrity `ok`, empty FK check | Wrong ID/version, altered bytes, malformed schema and truncated file fail |
| Determinism | Two fresh builds under one pinned toolchain yield equal DB hashes; shuffled discovery yields the same rows | Change public metadata and confirm expected projection/hash changes |
| Removal | Rebuild removes the note, incident edges, unused aliases/tags, route, feed/sitemap and Pagefind records | Re-include a removed note without new ledger review; release fails |
| Output inventory | Exactly the bound DB and package-owned JS/WASM are present | Stale second DB, journal, extra JSON index, private IR or source map fails |
| Output scanning | Scan every stored text value plus raw/decoded output using the existing policies | Plant a forbidden value inside a SQLite record and a secret in an overflow-page value; both are detected |
| Real browser | Named operations run under actual CSP, with the packaged Worker/WASM | Block WASM, fail fetch, alter digest, timeout Worker; static reading/links survive |
| Lazy loading | Network trace shows zero SQLite requests before explicit intent | Initial article load or scrolling must not request DB/Worker/WASM |
| Lifecycle | Concurrent consumers share one init; later intent retries after failure | Reject the first download, then succeed; late preview replies cannot open the wrong panel |
| Read-only | Actual imported browser DB supports the named read queries | A write fails even with `query_only` disabled in an isolated test of the imported DB; no raw-SQL UI message exists |
| Packaging | Tarball carries required JS/WASM and runs in a foreign notes repo | Test the chosen pinned runtime without borrowing undeclared dependencies |

Do not scan SQLite as if a UTF-8 decode of the file were equivalent to reading its
rows. Record/page boundaries can split text. Open read-only and scan the expected
text columns using the same normalization and secret policies as other public
surfaces; check the schema so unexpected storage cannot evade that scan. Keep
private diagnostics out of public logs. A scan that skips an unknown binary format
is not a passing gate.

The residue scanner and pinned secret scanner must both inspect reconstructed
SQLite text values; a row-aware residue scan does not make a raw-file-only secret
scan sufficient. Keep raw-byte coverage as well, including unexpected residual
bytes. Temporary text projections for secret scanning stay private and are removed;
neither values nor private source names may enter public diagnostics.

The accepted output has one exact rollback-journal SQLite format. Reject WAL,
unexpected schemas, virtual/FTS tables, extra DBs, and unreadable binaries. Scanning
must not reopen a failed DB as writable or create sidecars. Historical generic
database/FTS recovery code has no current public-format consumer; remove it when
replacing the scanner contract, while retaining meaningful negative controls.
Prefer one narrow read-only row enumerator shared by the two policy scanners,
not a general database inspection framework. Positive controls must reach each
scanner's row path; a prior schema or digest failure alone proves neither scan.

Use `EXPLAIN QUERY PLAN` on representative data to confirm outgoing uses the edge
PK, backlinks uses `edges_by_target`, and tag membership uses its leading tag key.
Assert useful access behavior, not exact version-specific planner wording. Also
measure real query latency; a desired index plan is not a performance result.

Empty and single-note corpora have valid empty graphs; an empty DB schema is not
evidence that output was never built. Include reciprocal links, cycles, isolated
nodes, high-degree hubs, CJK/emoji labels, and cross-note heading links. Removal
tests must build a fresh DB rather than reuse and delete from a previous file.

## Ablation and changes

For every new table, field, index, artifact, cache, dependency, or abstraction,
record the required consumer and ask what breaks when it is removed. Accept it
only if removal loses required behavior, a correctness property, or measured
material performance. Evaluate both build and browser costs. An experiment need
not remove FK checks from production to demonstrate their validation value.

| Structure | Why it survives |
| --- | --- |
| `nodes` | Slug lookup, labels and bounded previews |
| `edges` and reverse index | Directed graph and efficient backlinks |
| `aliases` | Required preview/search metadata without global uniqueness |
| `tags` and `node_tags` | Canonical tag identity and query-by-tag |
| Static HTML | Reading/navigation and accessible relationship fallback |
| Pagefind | Specialized full-text retrieval; no equivalent relational consumer |
| Private IR | Page rendering and the existing process boundary |

Rejected by default: page bodies in SQLite, a second public preview/adjacency
index, graph manifests, closure/degree/neighborhood tables, speculative edge kinds,
timestamps/counts/build metadata, browser persistence, and alternate DB backends.
They may return only with a concrete changed requirement and evidence.

A contributor proposing a departure must update the owning core-design section,
state the reason and rejected simpler option, identify schema/version and consumer
effects, and provide validation evidence in the same review. A feature request
authorizes its stated scope; it does not silently authorize unrelated architecture
changes. Ask the maintainer only for an unresolved product trade-off, not for an
implementation choice already covered by this baseline.

`AGENTS.md` and review discipline cannot guarantee that drift is impossible.
Executable invariant tests, release gates, and keeping one normative design are
the enforcement mechanism. Do not add tests that merely search for a sentence in
documentation and call that architectural compliance.
