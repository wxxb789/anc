# ANC core design

Status: accepted long-term architecture, 2026-09-13. This directory defines durable
design decisions, not a release plan or a claim of implementation completeness.
ANC is pre-release and is not yet 0.1.0-ready or 1.0.0-ready.

ANC turns a Markdown repository into a static knowledge garden. SQLite and browser
WASM are core capabilities. Ordinary reading, navigation, backlinks, and the graph's
accessible fallback remain available without JavaScript.

## Read by concern

| Document | Contract |
| --- | --- |
| [Architecture](architecture.md) | Product scope, ownership, source/IR/output boundaries |
| [Content semantics](content-semantics.md) | Publication, links, identity, aliases, tags |
| [SQLite contract](sqlite-contract.md) | Exact schema, invariants, query semantics |
| [Build and browser runtime](build-and-runtime.md) | Artifact binding, Worker protocol, loading, failure, caching |
| [Verification and evolution](verification-and-evolution.md) | Invariant evidence, ablation, design changes |

## Architecture, goals, and authority

For architecture, this directory supersedes conflicting text in the historical
requirements and plans. `AGENTS.md` defines contributor workflow and points here;
it must not maintain a second schema. Historical section numbers stay stable
because source comments reference them. A historical ticket or passing old test
does not authorize restoring a superseded design.

Finishable development outcomes and their completion evidence belong in
[`docs/goals/`](../goals/README.md), not here. Active goals use unique increasing
numbers such as `0001-name.md`; completed goals move, with their evidence, to
`docs/goals/archive/` under the same filename. Goals reference this design rather
than repeating or overriding it.

There is no backward-compatibility requirement. Choose the clean target and update
all affected producers, consumers, tests, and documentation together. Do not retain
legacy schemas, outputs, API shapes, loaders, migration paths, dual writes, or
adapter layers for existing unreleased code. Generated data is rebuilt from source.
Schema/version checks detect a mismatched artifact; they do not promise support
for historical formats. Any future compatibility commitment needs its own decision.

## Binding decisions

- Markdown and configuration are the canonical source. A validated compiler IR
  carries page content; it is private build state, not a public database.
- `site.<sha256>.sqlite` is the only public relational and preview index. It has
  `nodes`, `edges`, `aliases`, `tags`, and `node_tags`.
- No `content-index.json`, `graph-manifest.json`, or JSON adjacency fallback in
  the target output. Bind the exact DB URL into the build's client module.
- No full Markdown or rendered page body in the public DB. Static HTML delivers
  pages; Pagefind owns full-text search, including aliases. No SQLite FTS.
- An edge is one directed link between two published, distinct notes. Store it
  once; query backlinks through the reverse index. No stored degree, closure,
  neighborhood, edge occurrences, or speculative edge kinds.
- SQLite is built afresh, validated, finalized, hashed, and published immutably.
  Browser queries are read-only in one lazy dedicated Worker.
- Static relationship HTML and interactive queries use the same SQLite relation
  model. A query at build time does not make a page depend on a query at runtime.
- Every added structure must name its consumer and survive an ablation check.
  Fewer tables or fewer lines alone are not evidence of a better design.

## Review corrections incorporated

| Earlier shorthand | Precise contract |
| --- | --- |
| A hash filename verifies the DB | Recompute SHA-256 over the received uncompressed bytes and compare it with the full digest in the bound URL |
| `Content-Length` replaces the manifest's size | It can be absent and can describe encoded transfer bytes; measure decoded bytes separately and enforce limits while reading |
| `application_id` proves a completed build | It identifies a format only; completion requires the build gates and validated output inventory |
| Integer identity is immutable | IDs are local to one DB snapshot; slugs are the public lookup identity, and IDs may change on rebuild |
| Every table should use `WITHOUT ROWID` | Integer entity tables use rowid; composite relation tables use `WITHOUT ROWID` |
| Every build-time tag query needs another index | Batch node/tag reads at build time; add a reverse index only for demonstrated work that needs it |
| One public structured artifact means literally one data file | SQLite owns relational/preview facts; Pagefind, feeds, sitemap, and host metadata retain their distinct protocol roles |
| The design is now proven fast enough | Cold preview and large-corpus memory remain release measurements, not established results |

No unresolved product choice blocks this architecture. Performance and the actual
browser/package behavior require evidence; specific completion conditions are in
the active goals. Do not label an unmeasured design perfect.
