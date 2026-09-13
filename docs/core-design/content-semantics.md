# Content and relationship semantics

These semantics apply to the IR, static output, and SQLite queries. They express
accepted product behavior, not backward compatibility with an old implementation.

## Publication and disclosure

Preserve discovery precedence: a note's `publish: false` is unconditional;
configuration exclusions apply next; `publish: true` cannot override exclusion.
Malformed configuration and zero-match exclusion patterns fail. Existing built-in
exclusions and the absence of a non-Markdown asset-copy pipeline remain in force.

`review` produces the exact public slug set. Release builds require the committed,
unchanged ledger to equal the newly computed set, including removals. A successful
build is not a deployment action. Reports retain names privately; stdout/stderr
carry sanitized counts and categories, including for SQLite failures.

The author-approved withheld-link behavior remains: a published article can retain
the author's full link label/path and link to `/private/`. This does not publish
the withheld target's body, title, aliases, or tags. The `/private/` helper remains
reserved, generic, and `noindex`.

Only published notes create `nodes` rows. No placeholder for a withheld, missing,
ambiguous, external, or helper-page target enters `nodes` or `edges`. In particular,
SQLite is not a directory of excluded files. Public titles/excerpts can still
contain words or paths the author wrote in published content, including retained
withheld-link labels. Do not claim that every withheld name is absent from every
public surface, or create a broader disclosure than this existing rule allows.

Search-engine discovery settings are not access control. A published static page
or DB is downloadable regardless of `robots.txt` or `noindex`; neither promises
deletion from a crawler, cache, or a visitor's previous download.

## Notes, routes, and identity

- Preserve the existing validated slug grammar and reserved routes in
  `src/lib/schema.ts`. Derive note URLs through `src/lib/route-path.ts` rather than
  storing another URL/path column.
- `nodes.id` is a positive integer assigned in canonical slug order within one
  snapshot. It is not a durable ID across builds or a public API identity.
- Lookup and navigation use slugs. Browser responses containing integer IDs belong
  to the DB URL that produced them and must be discarded when that snapshot changes.
- Renaming a slug changes a public URL. This design adds no redirect history,
  tombstone ledger, or cross-build identifier. There is no promise to preserve
  unreleased URL/API shapes; author-managed rename history needs its own use case.
- Keep field bounds and sanitization from the content contract. `excerpt` is plain
  text and may be empty; it is derived through the existing post-resolution summary
  path, not by copying raw Markdown into a browser payload.

## Edges

One row `(source_id, target_id)` means at least one supported authored link in the
published source note resolves to a different published target note. Repeated links
collapse to one row. Reverse links are distinct rows: A→B and B→A are both stored.

Preserve producer link-resolution precedence for wikilinks, labelled links,
repository/relative paths, Markdown links, and downgraded note embeds. Ambiguity
warns and degrades according to the current resolver; do not choose by walk order.
Code fences, inline code, escaped syntax, and external links do not create edges.

A same-note heading link remains a real HTML anchor but creates no self-edge.
Cross-note heading links create the note-level edge; heading fragments stay on
the HTML link, not in the DB. Embeds currently downgrade to links and have no
distinct stored edge kind. Tags and collections are not synthetic `edges` rows.

The defining equality is: the distinct published cross-note destinations in an
article equal that note's outgoing DB query. Backlinks are the exact reverse query.
Compare content anchors, excluding navigation, same-note links, and `/private/`.
Do not parse rendered chrome to reconstruct the graph.

## Aliases

Aliases remain bounded display, preview, and Pagefind search metadata. They are
not alternate resolver targets, routes, globally unique names, or graph nodes.
The same alias may belong to different notes. Deduplicate a note's exact aliases;
query their display order explicitly and preserve the current deterministic order.
No alias-search B-tree is needed while Pagefind owns that search.

## Tags

A tag has a canonical route key and a display label, so it is an entity with a
many-to-many membership relation. Reuse the existing `routeKey`, label-equivalence,
collision, and representative-label behavior from `src/lib/routes.ts`:

1. Derive the key using the existing NFC normalization, `github-slugger`, invisible
   code-point removal, and separator cleanup. Reject an unaddressable key.
2. Labels equivalent under NFC followed by JavaScript `toLowerCase()` share a tag.
   This is Unicode lowercasing, not full Unicode case folding; `straße` and
   `STRASSE` are not required to merge. Do not substitute SQLite `NOCASE`.
3. Equivalent spellings use the lexicographically smallest source label as the
   deterministic display label, following the existing comparator. Different
   labels that collide on a key, such as `C++` and `C#`, fail the build.
4. A note carrying equivalent spellings has one `(tag_id, node_id)` membership.
   Emit only tags used by published notes. Assign tag IDs in canonical key order.
5. Static tag routes, tag labels, memberships, and browser tag queries use the same
   normalized model. Do not normalize independently in SQL or browser code.

Determinism does not mean a display label can never change when the corpus changes;
the selected representative may change while the canonical key stays the same.

## Graph presentation

The local neighborhood is the union of incoming and outgoing published neighbors.
The displayed graph is the induced subgraph over the selected nodes, including
links between neighbors. It is not merely a star drawn from the center.

Retain the current local limit of 12 neighbors and global limit of 60 nodes as
presentation defaults, not database/corpus limits. Show omitted counts and an
accessible path to complete relationship lists or further exploration. Reciprocal
edges may be drawn as one mutual link; that is presentation, not stored `edge_type`.

Compute ranking and degree from query results when requested. Distinguish degree
in the full corpus, degree in a filtered graph, and degree in the drawn subset.
Labels and accessible names must state the scope they actually describe.
