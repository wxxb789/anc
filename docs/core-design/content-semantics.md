# Content and relationship semantics

These semantics apply to the IR, static output, and SQLite queries. They express
accepted product behavior, not backward compatibility with an old implementation.

## Publication and disclosure

Preserve discovery precedence: a note's `publish: false` is unconditional;
configuration exclusions apply next; `publish: true` cannot override exclusion.
Malformed configuration and zero-match exclusion patterns fail. Existing built-in
exclusions and the absence of a non-Markdown asset-copy pipeline remain in force.

Publication reads only what lies inside the content root. A `.md` symbolic link
whose resolved target is outside it is dropped unread as `link-outside-content`,
after both exclusion ranks. A release ledger records slugs, and git does not see
an external target change, so following such a link would let an approved slug
carry different private text on each build. A link to a file inside the root
publishes under the link's own path. A leading `---` block that carries a
`publish:` key but has no closing delimiter fails the build, whatever its length.

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

- Preserve the validated slug grammar and reserved routes in `src/lib/schema.ts`,
  whose `isSlug` is `isNoteSlug` in `src/lib/route-path.ts` — the one definition
  the producer, the content contract, the renderer's href rewrite, the Worker's
  lookup guard, the browser's pathname parser, and the publish-set ledger share.
  Derive note URLs through `src/lib/route-path.ts` rather than storing another
  URL/path column.
- **Slugs are Unicode.** A slug is hyphen-separated runs of Unicode letters,
  numbers, and marks (`\p{L}\p{N}\p{M}`), lowercase under JavaScript
  `toLowerCase()`, NFC, with no Default_Ignorable code point, at least one letter
  or digit, and no leading, trailing, or doubled hyphen. Underscore is not a slug
  character (it is one in a tag key). The producer derives it per path segment —
  NFC, lowercase, strip invisible code points, replace each run of anything else
  with one hyphen, trim — and joins segments with `-`: `日记/今天.md` → `日记-今天`,
  `Projects/观点.md` → `projects-观点`. No transliteration. A folder segment that
  derives nothing is omitted; the first folder's derived key is the collection.
- **Hash fallback.** When the stem derives nothing (`___.md`, `🌱.md`, `---.md`) or
  the joined slug is not a valid slug (too long, marks only), the slug is `note-`
  plus the first ten hex digits of SHA-256 over the NFC repo-relative path. It is
  a pure function of that one path, so adding or removing another file never moves
  it. The former `empty-slug` drop is removed: under default-publish it silently
  lost a note the author never excluded. A frontmatter `slug:` override uses the
  same grammar after NFC and fails, rather than hashing, when invalid or too long.
- **Length.** At most 128 UTF-8 **bytes** (`SLUG_MAX_BYTES`), not UTF-16 units: a
  slug is an output directory name, and ext4/APFS cap a name at 255 bytes, which a
  128-character CJK slug (384 bytes) exceeds. 128 bytes is about 42 CJK characters.
- **Collisions.** Two distinct files deriving one slug keep the explicit behavior:
  the first in sorted walk order wins and the other is dropped with
  `slug-collision`, naming the winner in the private report. Stdout carries every
  drop reason as a nameless count, e.g. `content: 5 discovered, 3 published,
  2 dropped (1 not-markdown, 1 slug-collision)`; reasons are literals of the
  closed set, so the line is rename-invariant.
- **Encoding.** HTML hrefs carry the raw slug (`/notes/日记-今天/`). Canonical
  links, `og:url`, sitemap `<loc>`, and feed URLs are percent-encoded valid URIs
  (`new URL`). The Markdown renderer emits body hrefs percent-encoded, so the href
  rewrite and the browser's `noteSlugFromPath` decode first (a malformed escape is
  not a slug), NFC-normalize, then validate.
- **Order.** Canonical slug order is Unicode code point order (`compareSlugs`),
  which equals SQLite `BINARY` (UTF-8 byte) order. JavaScript `<` compares UTF-16
  units and disagrees for astral characters versus U+E000–U+FFFF, so it is not
  used for IDs, artifact edge lists, the sitemap, or the publish-set ledger.
  Title-then-slug presentation order is a display comparator and stays as it is.
  *Consumer:* `ORDER BY id` must equal `ORDER BY slug` and the cursor order.
  *Ablation:* with JS `<`, a corpus holding `𠀀` and `ａ` assigns IDs in one order
  and pages in the other (`tests/route-model.test.ts`).
  *Consumer and ablation for the grammar as a whole:* a CJK-named repository.
  Under the ASCII grammar its notes were dropped and links to them went to
  `/private/`; `tests/unicode-slugs.test.ts` builds one end to end.
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
- Store the effective note language in SQLite using the same bounded BCP 47
  validation and `entry.language ?? NAV_LANGUAGE` fallback as static rendering.
  Every browser result carrying note text includes that language. Apply the shared
  `partLanguage` semantics against the current page to title, excerpt, aliases and
  graph/list note labels; UI chrome keeps the surrounding page’s language.
- **Site language default.** `publish.config.yaml` may carry `language`, validated
  exactly as a note's. The producer writes it into every entry that declares none,
  so `<html lang>`, `nodes.language`, and the Pagefind index a page lands in read
  one effective value. It also becomes `NAV_LANGUAGE`, the chrome language of
  non-note routes (crossing into page modules on `PUBLISH_SITE_LANGUAGE`, like the
  title). Unconfigured, it is `en`. The English prose pages `/about/` and
  `/privacy/` keep `lang="en"`. *Consumer:* a Chinese site without per-note
  `language:` was indexed by Pagefind as English, one token per sentence.
  *Ablation:* remove the fallback and such a note renders `<html lang="en">` and
  lands in the `en` index (`tests/unicode-slugs.test.ts`).

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
The same alias may belong to different notes. Preserve accepted YAML order in a
zero-based ordinal per note; it need not be alphabetical. The static page and
preview display the same sequence. If normalization deduplicates exact aliases,
keep the first occurrence and assign contiguous ordinals afterwards; this does not
relax the producer’s rejection of malformed duplicate frontmatter. No alias-search
B-tree is needed while Pagefind owns that search. The per-note uniqueness index in
the SQLite contract enforces distinct labels, not global alias search.

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

The selection contract is explicit:

- Local: deduplicate incoming/outgoing neighbors, sort by the shared JavaScript
  title-then-slug comparator, then take up to 12 neighbors **plus** the center.
  An isolated center has no neighbors; an unknown center is a different result.
- Global: rank by the number of distinct adjacent notes in the candidate graph,
  descending, then the same title/slug comparator; take up to 60 nodes. Reciprocal
  directed edges contribute one neighbor, not two. With a tag filter, the candidate
  graph contains only matching notes and edges between them; rank before truncation.
- After selection, include every directed edge between selected nodes. Displayed
  degree counts distinct adjacent drawn notes; a reciprocal pair drawn once counts
  once. It is not in-degree plus out-degree or the rank used to select nodes.
- Local omitted counts exclude the center; global omitted counts use the candidate
  graph, including isolated matching notes. Limits never truncate complete static
  relationship/tag lists or paginated browser enumeration.

Static relationship and tag lists use title/slug presentation order. Browser
enumeration uses the slug cursor order in the SQLite contract; comparing these
surfaces means equality of membership and metadata, not necessarily row order.
