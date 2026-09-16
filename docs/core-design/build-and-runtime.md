# Build, artifact binding, and browser runtime

## Build sequence and private handoff

1. Use the existing configuration, exclusion, publication-review, link-resolution,
   and private-report boundaries to produce a validated IR.
2. Build SQLite in the private staging workspace, outside the public output tree.
   Validate the schema, all rows, and semantic equality to the published projection.
3. Finalize and close the DB. Compute full SHA-256 over its uncompressed bytes.
   Its published path is `/data/site.<64-lowercase-hex-digits>.sqlite`.
4. Generate a private TypeScript module exporting `SITE_DB_URL` as that exact
   same-origin path. Feed it to the existing Astro/Vite build. Build-time queries
   read the same finalized DB; there is no separate relation reconstruction.
5. Render HTML using the IR for page content and SQLite queries for relationship
   surfaces. Generate Pagefind from that HTML, plus existing feeds/routes/headers.
6. Copy the exact hashed DB into the output after Astro's output cleanup, and
   include the bundled Worker and WASM in the output inventory.
7. Run complete inventory, DB, rendered-output, residue, and applicable release
   secret gates over the finished staging output. Only then report success and
   promote it to the requested output directory through the existing locked build
   path. Failed builds must not replace a previously successful output with a
   partial one or leave a new partial directory that preview accepts as complete.

The generated module is a build seam, not a public manifest. It contains no local
path, content body, corpus index, count, or second copy of the DB schema. Its URL
flows into the hashed client artifact. There is no cycle: DB bytes depend on public
data, not on the hash of the JS that subsequently imports its URL.

Keep private `content.json` serialization while the real CLI/Astro process boundary
needs it. Pass the selected IR and finalized DB through the same build workspace;
do not let default fixture paths accidentally select another corpus. Local build,
packaged CLI, fixture build, and Action must use equivalent gates.

## Why there is no manifest

| Information | Owner |
| --- | --- |
| Exact database URL | Generated client module |
| Expected SHA-256 | Full digest within that bound URL |
| File kind and schema version | SQLite `application_id` and `user_version` |
| Node/edge counts | Queries when requested |
| Static fallback | Already-rendered HTML |
| Decoded DB size | Actual response bytes; build measurement |
| Transfer cost | HTTP/browser measurement, recorded with encoding/cache state |

The filename is not a checksum verification operation. Verify its digest against
the actual bytes at build time and after browser download. This detects mismatched
responses and corruption relative to the trusted page; it is not authentication
against a compromised origin that can replace both the page and the DB.

`Content-Length` can be absent and can differ from the decoded body length. It is
an optional early hint, not a correctness prerequisite. The reader enforces a
decoded-byte limit while streaming and aborts excess data before allocating WASM
memory. Record compressed transfer, decoded bytes, and peak memory separately.
[HTTP Content-Length](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Length)
documents the header's limitations.

## Preview recognition

Preview requires exactly one regular `data/site.<sha256>.sqlite` in the selected
output, matching SQLite magic, application ID, the reader's exact version, and file digest,
plus the expected entry HTML and static-output structure. Reject missing or
multiple DB candidates instead of choosing the newest file by directory order.
Preserve the existing path-containment and loopback-serving checks.

These checks prevent common wrong-directory and incomplete-artifact mistakes;
they are not proof that a directory was built by trusted code. Build success and
release qualification come from the full build gates, not a magic header. There
is no new “build completed” public manifest or browser claim of release approval.

## Lazy Worker lifecycle

On an ordinary article load, request zero SQLite JS, Worker, WASM, or DB bytes.
Reading and scrolling alone are not database intent. Start loading after the
existing hover-intent delay or keyboard focus on an eligible note link, or an
explicit graph/relationship action. A scroll past a graph does not start it.

Use one shared initialization promise and one Worker per document/snapshot for
preview, graph, and tag consumers. The small main-thread client dynamically loads
the Worker; the Worker owns DB download, validation, WASM allocation, and SQL.
Do not initialize an independent database for every feature.

The lifecycle is `idle → loading → ready`, with a recoverable `failed` state.
Concurrent requests share loading. If loading fails, reject waiting requests and
clear the failed promise. A later explicit intent may retry; no automatic retry
loop. Dismissing a preview invalidates its request generation so a late response
cannot attach to a different link. It need not abort initialization needed by
another consumer.

Retain the ready Worker for the document lifetime, and dispose on teardown or a
snapshot change. Do not add an arbitrary idle timer that repeatedly makes previews
cold; memory-driven reclamation needs evidence. Release DB handles and transferred
buffers when terminating or failing initialization.

## Read-only import and query boundary

Download from the bound same-origin URL and reject an unexpected redirect origin.
Check HTTP success, byte bounds, SQLite header, and SHA-256 before use. Import into
Worker memory through `sqlite3_deserialize` with `SQLITE_DESERIALIZE_READONLY` and
correct buffer ownership/lifetime. The pinned WASM package must expose this path;
prove it on the real packaged artifact. Set `PRAGMA query_only = ON` as an
additional guard, then verify the application ID and the reader's exact schema version.
Validate the exact schema once per imported snapshot before accepting named queries;
matching header constants alone do not establish that the query contract is present.

Do not assume that opening `:memory:` with an `r` flag makes imported bytes
read-only. The SQLite API documents that memory database open-mode flags behave
differently. The published DB must be in rollback-journal format: a WAL database
cannot simply be deserialized as a standalone snapshot.
[SQLite deserialization](https://sqlite.org/c3ref/deserialize.html), its
[ownership flags](https://sqlite.org/c3ref/c_deserialize_freeonclose.html), and
[WASM DB constructor](https://sqlite.org/wasm/doc/trunk/api-oo1.md)
define those constraints.

The application exposes named operations, not an SQL console:

| Operation | Input | Result |
| --- | --- | --- |
| `preview` | `slug` | Bounded title, excerpt, author-ordered aliases and effective note language, or no match |
| `backlinks` / `outgoing` | `slug`, optional cursor and page size | Note summaries including effective language, and continuation |
| `byTag` | Canonical `tagKey`, cursor and page size | Tag identity, note summaries including effective language, and continuation, or unknown tag |
| `localGraph` | Center `slug` | Bounded neighbors with effective language, induced directed edges, omitted count |
| `globalGraph` | Optional canonical `tagKey` | Ranked bounded nodes with effective language, induced directed edges, omitted count |

Selecting another graph node invokes `localGraph` again and enables successive
exploration. In a tag-filtered global graph, select matching nodes, rank within
that induced graph, and return only edges with both endpoints in the selected set.
Do not label the filtered result as the whole corpus.

Messages use a discriminated `type`, a request ID, and operation-specific validated
arguments; replies echo the request ID and carry either a typed result or a small
error code, and a successful reply also carries the measured milliseconds the
named operation spent in the Worker after initialization settled — its queries
and selection work, never a cold start (a number for the performance goal, not a
data-model field). Results are structured-clone-safe values. IDs never cross snapshot
boundaries. Validate slug/key shape, cursor, and bounded page size in the Worker;
SQL uses bound parameters. No message accepts SQL text, arbitrary URLs, filesystem
paths, or a table/column name supplied by the UI.

Bound pending requests and apply a finite startup/query deadline. A main-thread
deadline may terminate an unresponsive Worker because a cancel message cannot
interrupt synchronous SQL already running there. Reject its pending requests and
allow reinitialization on subsequent intent. LIMIT bounds output, not CPU or
memory; named policies must bound download, execution, and rendering separately.
Choose and record numeric policies from measured workloads, not an invented
corpus-size assumption; the active goal names its benchmark corpus and gate.
Functional goals may establish finite provisional limits with their actual
correctness fixtures. The performance goal must validate and settle those limits
on its stated workloads before release; this does not require performance acceptance
before a functional implementation can be tested. Do not remove limits while waiting
for that evidence or mistake provisional values for proven product capacity.

## Failure, accessibility, and security

On fetch, integrity, schema, CSP, Worker, or WASM failure, preserve the static
article, complete relationship lists, graph SVG/table, and normal anchor navigation.
No JSON graph fallback. A graph action can show a concise retry state; a preview
failure leaves the link usable and does not display a stale panel.

Graph controls remain keyboard usable, communicate truncation, and respect reduced
motion. Render metadata as text, never raw `innerHTML`. Keep table/list access to
graph relationships. UI selection and layout state may live in memory; it is not a
second corpus data model.

Serve Worker, WASM, DB, and scripts from the site origin, with correct MIME types
and actual host CSP enforcement. SQLite adds no `unsafe-eval`, inline scripts, or
cross-origin isolation requirement. Test the already-existing
`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, and `connect-src 'self'`
policy. Existing Mermaid style allowances do not authorize new script allowances.

## Deployment snapshots and withdrawal

Deploy HTML, JS, WASM, Pagefind, and the DB as one consistent release. Each HTML/JS
build binds its exact DB URL; never resolve “latest DB” at runtime. Hash-addressed
DB/JS/WASM can use immutable caching; HTML and stable-named assets revalidate.
Do not apply an immutable rule indiscriminately to the Pagefind directory.

If a cached page requests a DB no longer available, fail to the static baseline.
Never substitute a different DB whose integer IDs or metadata could disagree.
This is snapshot consistency, not support for older product versions. The output
contains one DB and does not retain historical snapshots or compatibility assets.
Removal and rebuild eliminate the current DB row, incident
edges, unused tag metadata, HTML, and Pagefind records; previously downloaded
snapshots and third-party caches cannot be recalled by this architecture.
