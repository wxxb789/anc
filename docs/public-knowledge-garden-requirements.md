# Public Knowledge Garden — Product Requirements and Architecture

**Status:** Revised against the delivered code, 2026-08-19
**Document type:** Product requirements + architecture decision baseline
**Target project:** A general-purpose static publisher for a repository of Markdown
**Last updated:** 2026-08-19; first drafted 2026-08-06
**Implementation status:** The general-purpose plan, reviewed release boundary, exact output
inventory, and pinned secret scan are delivered. Deployment remains a separately approved
external action this document does not authorize.

## 0. How to read this document, after the inversion

This was written for one person publishing a curated subset of a private Obsidian vault
through an explicit allowlist. **The project is now a general-purpose static site generator:
any user runs it on their own notes repository, and every file publishes unless they exclude
it.** The reversal is recorded as DR-7 in section 26 and its consequences reach section 5.1,
section 6's glossary, section 10.3, and section 21.1.

Three rules governed this revision, so a later reader can tell what changed from what merely
survived:

1. **Section numbers do not move.** Over eighty comment lines in `src/`, `scripts/`, and
   `tests/` cite this document by section — "requirements section 13.2", "requirements §19.2" —
   and a renumbering would silently repoint every one of them. Sections that lost their subject
   are marked and kept rather than deleted.
2. **A requirement met by a different mechanism says which mechanism.** A requirement that was
   abandoned says so and why. A requirements document that quietly drops things is worse than
   one that records the decision.
3. **Where a claim here could be checked against the code, it was.** Section 8.1's delivery
   column, section 11.3, and section 22 were all measured rather than assumed during this
   pass; what could not be verified is marked in place.

What has *not* changed, and is worth stating because it is the luck the whole turn ran on: the
rendering pipeline, design system, graph, search, feeds, and the content contract in
`src/lib/schema.ts` were all built against an *artifact interface* rather than against a
vault. Replacing the producer left them untouched.

## 1. Executive summary

Build a privacy-preserving, static-first publisher with a feature surface comparable to
Quartz v5, implemented with Astro.

The product turns a git repository of Markdown into a site. Every file in that repository
publishes unless the user excludes it — by a glob in `publish.config.yaml` or by `publish:
false` in a note's own frontmatter. The tool ships no content, no identity, and no default
that names its author.

The default architecture is:

- Astro static-site generation for routes, HTML, metadata, RSS, sitemap, and static backlinks;
- vanilla script for the interaction that cannot be expressed as HTML and CSS — no framework
  is installed; see section 11.3;
- Pagefind for full-text search;
- static HTML relationship surfaces: backlinks, outgoing links, and an SVG graph, all built at
  build time;
- no server runtime, D1, authentication, comments, or analytics;
- static hosting with strict CSP and immutable asset caching, on any host.

D1 is a conditional escalation path, not the launch default, and nothing has moved it closer.
Browser code must never connect directly to D1 with privileged credentials.

## 2. Problem statement

Someone with a repository of Markdown notes needs a public projection of it that preserves the
navigation and discovery affordances of a modern digital garden, without publishing what they
did not mean to publish and without coupling the site to a fork of the generator.

The proof of concept validated deterministic export, static Astro output, Pagefind search,
static backlinks, and strict browser security against a curated allowlist. The durable product
must hold those properties when the input is **an arbitrary repository the tool has never
seen**, and must add:

- an intentional reader experience;
- a stable public content contract;
- graph-native navigation and backlinks;
- predictable build and deployment behavior;
- measurable performance and accessibility;
- a publication decision the user can inspect before it happens;
- a documented path from fully static relationship data to D1 only if justified.

The tool has no privileged input. A repository of Markdown is the whole of what it reads, and
the vault this document was originally written around is now simply one such repository among
any others.

## 3. Goals

### 3.1 Product goals

1. Publish a repository of notes, minus an audited exclusion set, as a coherent public garden.
2. Provide Quartz-v5-like discovery: search, backlinks, local graph, explorer, tags,
   breadcrumbs, table of contents, and hover previews.
3. Preserve meaningful Obsidian authoring semantics — wikilinks, aliases, callouts, embeds —
   without requiring Obsidian, or any editor, to be involved in publishing.
4. Make core reading, navigation, backlinks, metadata, and SEO work without client JavaScript.
5. Load interactive JavaScript only where markup cannot express the behaviour, and only on
   pages that need it.
6. Keep publication reproducible from versioned, sanitized public artifacts.
7. Make the publication event fail closed even though authoring fails open.
8. Keep the relationship-store implementation replaceable behind one query contract.

### 3.2 Engineering goals

- Static output by default.
- Deterministic builds from pinned dependencies and content artifacts. Determinism is why the
  producer sorts its walk, refuses to pick a link winner by scan order, and NFC-normalises
  both link text and file paths: an answer that depends on the filesystem's enumeration order
  is not a build output.
- No access to any content the user did not put in the repository they pointed the tool at.
- Strict type and schema validation at every boundary.
- Content-addressed graph/search assets with explicit schema versions.
- Small, independently loaded client scripts.
- Browser feature degradation that preserves reading and navigation.
- Host portability: nothing in the build requires a particular hosting provider, and nothing
  reaches a network service.

## 4. Non-goals

The initial product does not include:

- editing public content in the browser;
- bidirectional synchronization with an authoring tool;
- public comments, reactions, accounts, or personalization;
- exposing withheld pages through client-side encryption;
- treating an exclusion glob as sufficient authorization without a reviewed publish set —
  `review` plus `build --release` now enforce this boundary; see DR-7;
- runtime rendering of normal content pages;
- D1 as the canonical content database;
- client-side access to D1 credentials or hosting administrative APIs;
- cloning Quartz internals or its plugin system;
- full Obsidian plugin compatibility;
- rendering arbitrary Dataview or executable user scripts;
- an asset pipeline. Non-Markdown files are discovered and never emitted. This is the
  deliberate shape rather than a gap: Quartz's own documentation concedes every non-Markdown
  file ships regardless of filtering, so a withheld note publishes the images it embedded.

**Two non-goals were deleted here, and the deletions are the inversion itself.**

| Struck | Why |
| --- | --- |
| ~~publishing `sources/` or work content **by folder convention**~~ | Folder conventions are now the primary exclusion channel. `exclude: ["clients/**"]` is the mechanism, not the hazard |
| ~~treating a `publish: true` frontmatter field as **sufficient authorization**~~ | Exactly inverted. `publish: false` is now rank-1 exclusion and unconditional; `publish: true` is accepted, recorded, and **does not override an exclusion**. The asymmetry is the design: a note meant to be public and withheld is an inconvenience the author notices, and a note meant to be private and published is irreversible once it reaches a CDN and a search index |

## 5. Guiding principles

### 5.1 The repository is the content; the publication event is the boundary

**Rewritten. The original read "Explicit projection, not vault deployment", and its authority —
a private repository owning content selection through a reviewed manifest — no longer exists.**

The user's repository is the input in full. The producer walks it, applies exclusion rules,
computes the publish set, and **reports it**: every discovered file with the rule that decided
it, and every link that resolved to nothing, to something ambiguous, or to a file the user
withheld.

What replaces the allowlist's structural guarantee is *where the guarantee lives*. Under the
manifest, a note not named in it was physically unreadable, so no bug in this tree could
publish it. Default-publish deletes that: every Markdown file is readable by construction. The
replacement is at the publication event — the exclusion rules, the refusal to accept a pattern
that matched nothing, and the report a user can read before they deploy.

The replacement remains weaker at authoring time and is now fail-closed at the publication
event. `thoughtscape-publish review` writes the exact sorted public slugs to
`.publish-set.json`; `build --release` requires that file to be tracked, committed, unchanged,
and exactly equal to the set just computed. Additions and removals both block. Requiring a
removal corrects the flaw that killed the drafted `published.txt`: after the ledger shrinks, a
formerly excluded note cannot be re-included under stale authorization. Ordinary `build` stays
an unrestricted local-preview command; the shipped Action always uses release mode.

### 5.2 Static is the product baseline

A reader must be able to open a page, follow links, inspect backlinks, read metadata, and use
browser-native navigation when JavaScript is disabled or fails.

### 5.3 Progressive enhancement

Interactive search, graph exploration, command palette, and hover behavior are enhancements.
Their failure must not remove the underlying link or content.

### 5.4 Relationships have one public contract

Build-time backlinks, the graph, related-note queries, and future D1 APIs derive from the same
versioned edge model. Storage technology must not redefine relationship semantics.

**Strengthened in delivery, and worth recording as the mechanism:** `outgoing` and the
rewritten hrefs now come from *one traversal* of the parsed document — each link node resolved
exactly once, and the single resolution both rewrites the URL and appends the edge. The edge
set and the rendered anchors cannot disagree, not because a test compares them but because one
value produced both.

### 5.5 Privacy is an artifact property

The public Git tree, generated site, search index, source maps, logs, error pages, and HTTP
headers must all be safe to disclose independently.

**This is now the load-bearing principle rather than one of five**, because it is the one the
inversion did not weaken. Two clauses added by delivery:

- **The exclusion report is an artifact too, and it is the one artifact that must not be
  published.** It contains precisely the strings the privacy model exists to keep out of
  everything else. It lives at `<git-dir>/publish-report/content-report.json`, where nothing
  can stage it and `git clean -xfd` does not remove it.
- **A build's log is a disclosure surface.** The free adoption path is a public notes
  repository, whose workflow logs are world-readable and retained 90 days. So counts and
  closed-set rule identifiers go to the stream and names go to the file, and
  `tests/disclosure.test.ts` holds the split by renaming the corpus and diffing what the CLI
  wrote.

The search index is part of this and was the expensive lesson: a Pagefind fragment stores
*extracted text* with inline elements joined, so `ms**w/s**ecret` in a note body reaches a
reader's search box as `msw/secret` while no byte anywhere in `dist/` contains it. Every gate
over built output must inflate gzip members or it is asserting about a surface it cannot read.

## 6. Domain model and ubiquitous language

| Term | Definition |
| --- | --- |
| Notes Repository | The user's own git repository of Markdown. It is the input in full, and the tool reads nothing outside it. |
| ~~Publication Manifest~~ | **Deleted.** There is no allowlist. What replaced it is the Exclusion Rule set plus the Publish Set. |
| Exclusion Rule | One decision that withholds a file: a glob in `publish.config.yaml`, `publish: false` in a note's frontmatter, or a structural ignore the tool applies without being asked. |
| Structural Ignore | A path the tool never offers to the user's rules at all — `.git/`, any dot-prefixed name, `node_modules/`, the root `README.md`. A structural ignore matching nothing is normal; a user pattern matching nothing is a probable typo and fails the build. |
| Publish Set | The files that survived every Exclusion Rule. Computed per build and represented publicly by their slugs. |
| Publish Set Review | `.publish-set.json`: the exact sorted public slugs a human inspected and committed. It records no source path or withheld name. |
| Release Build | `build --release`: a build requiring a configured public origin and a committed, unchanged Publish Set Review exactly equal to the computed set. It qualifies an artifact but does not deploy it. |
| Projection | The sanitized, deterministic public representation produced from the Publish Set. |
| Public Document | One published page with public metadata, sanitized Markdown/HTML, and a stable public identifier. |
| Public ID | An immutable opaque identifier for a public document. It does not encode a source path. |
| Slug | The public route key, supplied by valid `slug:` frontmatter or derived from the repository-relative path with each segment slugified and joined by `-`. |
| Public Link | A link whose source and target are both in the Publish Set. |
| Withheld Link | A link whose target is a real file the user excluded. It keeps the author's full label/path, links to `/private/`, withholds the target body, and is reported. Distinct from an unresolved link, which pointed at nothing at all — different events with different fixes. |
| Edge | A typed, directed relationship between two public nodes. |
| Backlink | An incoming `links-to` edge for a public document. |
| Exclusion Report | `content-report.json`: every discovered file with the rule that decided it, plus every link finding with its source, line, text, outcome, and candidates. Written under the git directory; never an artifact key; never in `dist/`. |
| Ambiguity | A link that resolved to more than one candidate. Warns with every candidate named and does not fail the build (DR-8). |
| Graph Artifact | A versioned public relationship dataset. Deferred; see 12.3. |
| Content Artifact | Versioned public document data consumed by the site build. |
| Build | Deterministic conversion of a notes repository into deployable static output. |
| Deployment | External release of a reviewed build to a hosting environment. |
| Reader Shell | Static Astro layout, navigation, metadata, and content HTML. |
| Runtime Data Service | Optional Worker/D1 API used only after the static graph path fails a measured requirement. |

## 7. Users and primary journeys

### 7.1 Reader

A reader must be able to:

1. open a durable URL;
2. understand the note title, summary, dates, tags, and reading context;
3. follow internal and external links;
4. inspect backlinks and related notes;
5. browse by folder-like collection and tag;
6. search using keyboard or pointer;
7. preview a linked note without losing place;
8. explore a local graph;
9. share a page with useful Open Graph metadata;
10. use the site on mobile, keyboard-only, reduced-motion, and narrow screens.

### 7.2 Author

**Rewritten: the "owner/editor" of a private manifest is now any user of the tool.**

The author must be able to:

1. withhold a note by frontmatter, and a set of notes by glob, with the precedence stated when
   the two disagree;
2. learn what would publish *before* it does, by reading the report;
3. find out which links point at something they withheld;
4. build and preview locally with no domain, no account, and no configuration;
5. deploy through a separately approved action;
6. delete a note and have the page, feed entry, sitemap entry, and search record go with it.

Two journeys from the original are **not** available and are recorded as such rather than
silently dropped: *approve content item by item* has no mechanism under default-publish, and
*change a slug without breaking old URLs* has none either — `REDIRECT_RULES` is `[]` and
cannot grow from a corpus. A rename is a new address and the old one 404s.

### 7.3 Maintainer/agent

A maintainer or agent must be able to:

- validate schemas and route invariants;
- query content and graph artifacts;
- run privacy, security, accessibility, and performance gates;
- identify whether a failure belongs to discovery, link resolution, build, or deployment;
- change implementation without changing public domain semantics.

## 8. Quartz v5-inspired feature requirements

Quartz v5 is a feature benchmark, not an implementation dependency. The parity target is based
on the official Quartz v5 feature documentation at commit
`74b3fc9efd0caafea3dbcd846ddf1f06855b6d2a` accessed 2026-08-06 and not re-checked since.

Two of its documented behaviours are benchmarks in the negative sense, and both shaped
decisions here rather than being copied: every non-Markdown file publishes regardless of
filtering, so a withheld note ships the images it embedded (see the asset non-goal in 4); and a
link is recorded as an edge whether or not its target exists, measured at 14.6% dangling on
Quartz's own site, which is why resolution here is producer-side and typed (15.2).

### 8.1 P0 — the reader's feature set

The delivery column states what ships today, verified against a site the shipped binary built
from a scratch repository during the TK-35 revision rather than read off the ticket list.

| Capability | Requirement | Delivered as |
| --- | --- | --- |
| Obsidian-flavored Markdown | Headings, wikilinks, aliases, heading links, callouts, highlights, tasks, code fences, footnotes | Build-time transform, `src/lib/markdown.ts` |
| Public wikilinks | Resolve **five link forms** in one traversal against the whole repository, then test publication separately. Ambiguity is typed and reported, never silently resolved | `src/lib/link-resolution.ts`, `scripts/resolve-links.ts` |
| Backlinks | Render incoming links in static HTML | Build-time HTML. Per-edge context excerpts are **not** delivered; see 13.1 |
| Full-text search | Keyboard-accessible search with CJK support, excerpts, and tag filtering | Pagefind static index; vanilla dialog |
| Explorer | Browse published collections and nested routes | `src/components/CollectionExplorer.astro`; the producer maps the first folder to one flat collection |
| Breadcrumbs | Stable hierarchy independent of source paths | Static HTML |
| Table of contents | Heading navigation with active-section enhancement | Static HTML. **No script**: `TableOfContents.astro` states there is none, so the active-section enhancement is unbuilt |
| Tags | Tag listing pages and per-page tag links | Static routes derived from YAML frontmatter tag lists |
| Folder/collection listings | Published collections | Static routes; see the Explorer row |
| Hover previews | Safe title, summary, metadata, and bounded excerpt | Static preview payload + `src/scripts/link-preview.ts` |
| Local graph | One-hop incoming/outgoing neighborhood | **Static SVG plus an equivalent table.** Not the SQLite WASM island section 12 describes; that path was never built and is deferred |
| Dark mode | System preference plus explicit user toggle | CSS + minimal script |
| Reader mode | Distraction-reduced layout | CSS + minimal script |
| Syntax highlighting | Build-time highlighted code with copy affordance | Build-time highlighting. **No copy affordance**: TK-03 emitted a hidden button for a handler nobody wrote and TK-12 deleted it, per `src/lib/markdown.ts` |
| Math | Build-time rendering | Native MathML via Temml. The "where approved" clause is deleted — there is no approval step |
| Mermaid | Render safely; lazy-load only on pages that contain diagrams | Build-time markup by default |
| RSS/Atom | Public notes feed with canonical URLs | Build-time |
| Sitemap and robots | Canonical sitemap, explicit indexing policy | Build-time |
| Social cards | Deterministic Open Graph metadata and optional generated images | Metadata yes; **no `og:image`**. `SOCIAL_CARD_PATH` is `undefined`, no config key sets it, and all three card tags are emitted together or not at all — a shipped default card would put the tool author's brand on every user's site |
| 404 and redirects | Static 404 plus versioned redirect map | 404 yes. `REDIRECT_RULES` is `[]` and cannot grow from a corpus |
| Responsive layout | Mobile-first, no horizontal overflow | Static CSS, gated at 320 px |

**Every version-1 producer field now has an owning source.** Slug, language, description, tags,
aliases, first-folder collections, and git dates flow through the shipped producer. Aliases are
display/search/preview metadata, deliberately not link targets. The delivery column separately
marks every other partial capability, including redirects, graph storage, active-section TOC,
and code-copy affordances.

### 8.2 P1 — post-launch enhancements

- Global graph with filtering and accessible non-canvas fallback. **Partly delivered** as a
  static SVG at `/graph/` with a bounded node count and an equivalent table.
- Recently changed notes. **Delivered for tracked notes** from the latest commit touching each
  current path; untracked or non-git notes keep the explicit slug-order fallback.
- Link-context search and relationship filters.
- Public note properties panel.
- Citation rendering and bibliography pages.
- Canvas projection for approved canvases. The approval clause is deleted; Canvas stays
  deferred on its own merits.
- Public Base-like tables/cards generated from public metadata only.
- Offline shell and cached graph artifact where measured use justifies it.
- Multiple visual themes using design tokens.

**Deleted from this list: stacked-page reading.** It appears nowhere in the delivered code, has
no owner, and its inclusion here was aspiration rather than plan. Section 14 records the same
deletion.

### 8.3 Explicitly deferred Quartz features

- Encrypted/private pages: client-side encryption is not a substitute for keeping withheld
  content out of public artifacts.
- Comments: adds identity, moderation, privacy, and runtime dependencies.
- Arbitrary plugin loading: conflicts with a small, auditable static architecture. Quartz's own
  lockfile documents 10–15 plugins failing to build on a fresh clone, with the fix being to
  discard the pinning.
- General SPA routing: evaluate only after navigation metrics show a need.
- ~~Full vault explorer: only public, curated collections are exposed.~~ **Deleted.** The
  explorer now groups published notes by the first folder. Deeper folders stay in note slugs
  rather than creating a second collection hierarchy.

## 9. Information architecture

### 9.1 Public route model

Routes, verified against a built site:

```text
/
/notes/<slug>/
/collections/<slug>/
/tags/<tag>/
/recent/
/graph/
/about/
/privacy/
404.html
```

No dedicated `/search/` route; the dialog is available from every page.

**`/about/` and `/privacy/` are shipped pages of the tool's own prose, and that is a known
wrong shape.** They should be Markdown notes seeded into the user's repository, so that a
privacy page can describe *the user's own configuration* — which is the only thing that makes
one truthful under default-publish. `init` now exists and deliberately does not seed competing
notes; whether these generic pages stay or become user-owned content remains unresolved.

Slugs derive from the repository-relative path, each segment slugified and joined with `-`, so
`projects/sub/deep.md` publishes at `/notes/projects-sub-deep/`. A path that slugifies to
nothing is dropped and reported; a reserved site slug fails with every conflicting source path
in private detail. Two files claiming one slug are reported with both paths and the loser is
dropped.

### 9.2 Page anatomy

Each note page contains:

1. skip link;
2. global header and search trigger;
3. breadcrumbs;
4. title and public metadata;
5. optional summary;
6. table of contents on sufficiently long pages;
7. sanitized article content;
8. outgoing public links;
9. static backlinks;
10. related-note fallback list;
11. optional local-graph region;
12. previous/next or collection navigation where meaningful;
13. footer with public provenance and canonical URL.

### 9.3 Stable identity and redirects

- `public_id` is immutable when the artifact carries one.
- `slug` derives from the path and is unique; a collision is a build-time report naming both
  files.
- **A rename is a delete and a create, and the old URL 404s.** This reverses the original
  "mutable slugs with permanent redirects": `REDIRECT_RULES` is an empty literal that cannot
  grow from a corpus, and nothing in the producer records that a path used to be something
  else. The redirect emitter and its cycle checks survive for a map somebody writes by hand.
- `status: 'tombstone'` remains a **separate** published-but-withdrawn state affecting the feed
  and sitemap only. It is not exclusion and must not be conflated with it.
- Relationship edges use slugs.

## 10. Public content contract

### 10.1 Document fields

```yaml
schema_version: 1
public_id: opaque-stable-id
slug: public-route-slug
title: Human title
summary: Safe public summary
created: 2026-01-01
updated: 2026-08-06
language: zh-CN
tags: [public-tag]
collection: optional-public-collection
status: published
```

`src/lib/schema.ts` is the normative form and has not changed across the inversion. Optional
fields include aliases, description, cover image, reading order, and citation metadata. Of the
above, today's producer emits `slug`, `title`, `excerpt`, `markdown`, `outgoing`, and
`backlinks`; the rest are accepted and unwritten (see 8.1).

`MAX_ENTRIES` still carries the justification "the allowlist is hand-curated", which is
**false** under a whole-repository producer. The binding cost is per-entry build time, so the
limit should become configuration with a documented default and a message saying how to raise
it. The *value* was in flux as this was written — TK-34's scale work is measuring what it
should be — so the requirement here is on the justification and the mechanism, not the number.

### 10.2 Fields forbidden in public artifacts

- source paths of any kind;
- local machine paths;
- withheld tags or aliases;
- unpublished titles or excerpts;
- credentials, tokens, cookies, connection strings, or private headers;
- source-control metadata that reveals withheld filenames;
- raw frontmatter not explicitly allowlisted.

The rule survives; its authority moved. `src/lib/schema.ts` rejects any unknown entry field, so
a producer that started emitting a source path would fail rather than leak. **Frontmatter is
now also the exclusion channel**, which is why `publish` is read and never emitted: it is an
instruction to the build, not a document field.

One deliberate exception, ruled by the owner and recorded so it is not re-litigated as a bug:
**a withheld note's stem survives in the linking author's own prose.** `[[clients/acme/renewal]]`
in a published note renders the text `renewal` — the directory segments are withheld, the leaf
is not, because the author typed that word into their own sentence and a reader who meets it
learns what the link pointed at without being able to follow it. The same leaf on a *log line*
is a disclosure and is refused, because there it arrives as a filename with no sentence around
it. Two surfaces, two rules, both intended.

### 10.3 Producer behavior

**Rewritten. The original was twelve steps built on a manifest.**

The producer must:

1. discover every file under the content directory by walking `readdir` — never `globSync`,
   which returns a mistyped-case pattern back as though it were a path on win32 and `[]` on
   Linux — sorted, with structural ignores pruned during the walk rather than filtered after;
2. reject traversal, symlink escapes, and an output directory that is or contains the content
   directory;
3. treat only `.md` as a note, and emit no other file;
4. apply exclusion in rank order: `publish: false` first and unconditionally, then user globs
   with last-match-wins;
5. **fail the build on any user pattern that matched zero discovered paths**, naming the
   pattern's index and its config file. A file dropped for another reason still counts as
   matched, so the check does not depend on rule order;
6. resolve links against the *full* file set and test publication separately, so a link to a
   withheld note and a link to nothing are distinct outcomes;
7. emit an asset only if — and there is no asset pass, so: never. Not writing one is what keeps
   deny-by-default true;
8. reject unsafe URL schemes and unsupported embeds;
9. produce deterministic output for identical input on every platform;
10. ~~write only after target-project identity validation~~ — **deleted.** That was
    `export.py`'s hardcoded check that its target was one named repository, and a general tool
    must run against any repository;
11. **emit a privacy/audit summary without private values.** Promoted rather than changed: this
    is the one item in the original list that survived the inversion untouched, and it is now
    the report of section 5.5;
12. leave deployment as a separate action.

## 11. Target technical architecture

### 11.1 Layer model

```text
The user's notes repository
  Markdown + publish.config.yaml
              |
              v
Producer  (scripts/markdown-to-artifact.ts, scripts/resolve-links.ts)
  walk + exclusion + link resolution + slug derivation
              |
              +--> content-report.json  (under <git-dir>, never published)
              |
              v
Content artifact  (validated by src/lib/schema.ts)
              |
              v
Astro build
  Static HTML/routes/RSS/sitemap/Pagefind/headers
              |
              v
Any static host
  HTML/CSS/JS/WASM
```

The generator is a package installed into the user's repository, not a fork of it. Nothing in
the user's dependency graph contains this repository as source, which is what removes the
entire upgrade failure class of a template fork: no merge conflicts, no `restore` command.

### 11.2 Astro responsibilities

Astro owns:

- static route generation;
- layouts and page composition;
- content rendering from sanitized artifacts;
- metadata, RSS, sitemap, redirects, and error pages;
- build-time backlinks and related-note fallback lists;
- strict bundling of CSS and external scripts;
- no-JavaScript baseline behavior.

The project remains `output: "static"`, and the build runs against this package's own root with
the user's directory contributing content and an output location. That shape is forced rather
than chosen: cwd must be inside the package for prerender chunks to resolve their imports, and
Astro stages prerender output under cwd and *renames* it to `outDir`, which cannot cross a
device. `bin/thoughtscape-publish.mjs` documents the measurement.

### 11.3 Client script responsibilities

**Deleted and replaced. The original specified Svelte 5 islands with a per-island contract, and
zero Svelte is installed.** This staleness predates the inversion and is named so a later plan
does not re-derive it.

Four interactive surfaces ship script — the search dialog, hover previews, theme and
reader-mode toggles, and diagram rendering — totalling about 4.7 KB gzip across two files on
every page. The collection explorer ships none: it is a `<details>`-based `<nav>` and says so
at its own definition, and the diagram chunk is zero bytes under the build-time diagram mode.
Article content, backlinks, breadcrumbs, tag links, and primary navigation require no script at
all.

A framework is not forbidden; it is unjustified. Reconsider it only if the Phase 2 interactive
graph is built, which is the one feature whose state would plausibly need one.

Every client script must still define: its load trigger, its budget, its accessible fallback,
its failure behavior, and whether its state is transient, URL-backed, or storage-backed.

### 11.4 Search

Pagefind remains the search engine because it is static, CDN-friendly, and independent of any
relationship store.

Requirements:

- CJK tokenization verified with representative Chinese and English queries;
- title weighted above body;
- tags and collection filterable;
- excerpts contain public text only;
- keyboard navigation and focus restoration;
- search bundle lazy-loaded on first use;
- zero results distinguish no match from index-load failure.

Two properties the delivered gates argue for, one of which is **not** in place:

- **A search test's query term should be drawn from the corpus under test and asserted present
  in it before the query runs.** A fixed English constant is green for the wrong reason on a
  Chinese-only repository. `tests/search.test.ts` still uses one, and its comment argues for it
  on a real constraint — a term lifted from the one-note corpus times out under the 32-note
  one. The resolution is a term drawn from whichever corpus is under test; nobody has written
  it.
- **The index is a privacy surface.** See 5.5. Delivered.

SQLite FTS is not a requirement and has no owner.

## 12. Relationship-store architecture

**Status of this whole section: Phase 2, unbuilt, and its sizing premise is void.**

Every budget in 12.3 and 12.4 was calculated against a hand-curated corpus of a few hundred
notes. Under a whole-repository producer the node count is whatever the user's repository
holds, so a figure derived from "the allowlist is small" is not a smaller number than it
should be — it is a number with no basis. **Do not treat 12.4's thresholds as decided.**
Whoever builds this restates them against a stated corpus, or the store ships without size
budgets and gains them from measurement.

What ships today instead: build-time HTML backlinks, an outgoing-links list, and a static SVG
graph with an equivalent table, all with no client fetch and no database. 12.1's edge model
survives as the contract; 12.2's schema survives as an illustration of the semantics; 12.3 and
12.4 survive as an unstarted design.

### 12.1 Canonical relationship model

The producer's edge model, of which one member is implemented:

```text
links-to               # implemented, as entry.outgoing / entry.backlinks
embeds                 # demoted to links-to and reported; nothing transcludes
cites
belongs-to-collection
has-tag
redirects-to
related-to             # only when explicitly curated or generated by a documented rule
```

`checkCorpus` proves `backlinks` is the exact inverse of `outgoing` across the whole corpus and
fails the build otherwise. That invariant survived the inversion structurally and matters
*more* under a whole-repository producer, because the edge set now derives from a repository
rather than a curated list. What it has never had anything to say about is the *page* — which
is why a separate gate compares the article's rendered hrefs against the edge set, in both
directions, over a site the real binary built.

One property of that comparison, learned the hard way and recorded because it is easy to
restate wrongly: the equality holds over every article href *other than the page's own slug*.
A link to a heading on the same page renders a real anchor inside the article and correctly
contributes no edge.

### 12.2 Illustrative SQLite schema

```sql
CREATE TABLE build_meta (
  schema_version INTEGER NOT NULL,
  content_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL
);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT,
  language TEXT,
  collection TEXT,
  created TEXT,
  updated TEXT
) WITHOUT ROWID;

CREATE TABLE aliases (
  alias TEXT NOT NULL,
  node_id TEXT NOT NULL,
  PRIMARY KEY (alias, node_id),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
) WITHOUT ROWID;

CREATE TABLE edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  source_heading TEXT,
  context_excerpt TEXT,
  PRIMARY KEY (source_id, target_id, edge_type, source_heading),
  FOREIGN KEY (source_id) REFERENCES nodes(id),
  FOREIGN KEY (target_id) REFERENCES nodes(id)
) WITHOUT ROWID;

CREATE TABLE tags (
  node_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (node_id, tag),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
) WITHOUT ROWID;

CREATE INDEX edges_target_type ON edges(target_id, edge_type);
CREATE INDEX edges_source_type ON edges(source_id, edge_type);
CREATE INDEX tags_tag ON tags(tag);
```

The schema is illustrative but its semantics are normative: immutable node identity, typed edges, public-only context, deterministic ordering, foreign-key integrity, and indexed incoming/outgoing queries.

### 12.3 Static SQLite artifact — deferred design

**Not built, and not scheduled.** What follows is the shape a Phase 2 implementer starts from.
The one substantive change from the original: the client returns structured-clone-safe results
to *whatever renders the graph*, which today is markup and not a component framework.

Generate at build time:

```text
public/data/graph-manifest.json
public/data/graph.<content-hash>.sqlite
public/wasm/sqlite3.wasm
public/wasm/graph-worker.js
```

`graph-manifest.json` contains:

```json
{
  "schemaVersion": 1,
  "contentVersion": "sha256:...",
  "databaseUrl": "/data/graph.<content-hash>.sqlite",
  "databaseBytes": 123456,
  "databaseSha256": "...",
  "nodeCount": 100,
  "edgeCount": 500,
  "fallbackUrl": "/data/graph-fallback.<content-hash>.json"
}
```

Client behavior:

1. Do not fetch SQLite for normal article reading.
2. Fetch the manifest only when a graph/advanced relationship feature is invoked.
3. Fetch the immutable database from the same origin/CDN.
4. Verify schema and content version before querying.
5. Open SQLite inside a dedicated Web Worker.
6. Treat the database as read-only.
7. Query using bound parameters and fixed query templates.
8. Return structured-clone-safe result objects to the renderer.
9. Terminate or idle the worker after a bounded period.
10. Fall back to static HTML or bounded JSON adjacency if WASM fails.

The launch path should load the database into worker memory. OPFS persistence is optional and deferred; it adds browser, concurrency, private-mode, and header complexity without improving the first visit. Browser Cache API may cache the content-addressed response using normal HTTP caching.

### 12.4 Database size and loading policy

**Every threshold below is void until restated against a named corpus.** They were derived
from a hand-curated allowlist of a few hundred notes; the input is now an arbitrary repository
and the node count is unbounded. Kept as the *shape* of the policy — a warning threshold, a
hard budget, a query latency target, and an escalation ladder — with the numbers marked as
having no current basis.

- graph manifest: less than 10 KB uncompressed — the one figure that does not scale with the
  corpus, and so the one still defensible;
- graph database warning threshold: ~~2 MB compressed transfer~~ — restate;
- graph database hard budget: ~~5 MB compressed transfer~~ — restate;
- local-neighborhood query after worker readiness: p95 less than 50 ms on a representative
  mid-range mobile device. A latency target does not depend on corpus size and survives; what
  corpus it is measured on must be named;
- the graph must not delay Largest Contentful Paint;
- graph code and database loaded only after explicit user intent or when the graph enters the
  viewport.

If the artifact exceeds whatever the restated budget is:

1. optimize schema and remove duplicated text;
2. keep backlink HTML static;
3. shard by collection or publish a compact adjacency index;
4. evaluate HTTP-range-capable read-only VFS only with a pinned, audited implementation;
5. evaluate D1 only after static/sharded options fail the measured requirement.

### 12.5 D1 escalation path

D1 is appropriate only if one or more are measured:

- the graph artifact is too large for acceptable transfer/cold-start budgets;
- relationships change independently of site deployments;
- server-side filtering is required for a large public graph;
- abuse-resistant shared state is introduced;
- runtime features already require a Worker.

**One argument for D1 got stronger and one got weaker under the inversion, and both are worth
naming.** Stronger: a large repository is exactly the case a static artifact strains, and
repository size is no longer bounded by anyone's patience for curation. Weaker: introducing
D1 means a hosting provider, a secret, and a runtime — and the zero-secret, any-host property
is now a headline feature of the adoption path rather than a convenience. A tool a stranger
installs cannot require the stranger to provision a database.

D1 architecture:

```text
Browser -> read-only HTTPS endpoint -> Worker -> D1
```

Requirements:

- no browser-side D1/API credentials;
- narrow GET or POST query contract, not arbitrary SQL;
- anonymous read-only endpoint for public data;
- strict input schema, query allowlist, row/result limits, and timeouts;
- cacheable responses with ETag/content version;
- rate limiting and abuse telemetry without invasive tracking;
- static HTML fallback for backlinks and normal navigation;
- generated D1 database remains a projection, never the content authority;
- the same node/edge schema and content-version semantics as static SQLite;
- D1 failure must not break article pages.

A D1 binding requires Worker/Pages runtime code. It is therefore incompatible with a literally static-only deployment, although most routes can remain prerendered and served as static assets.

## 13. Graph and backlink UX

### 13.1 Static backlinks

Each page statically renders:

- source title;
- source route;
- ~~optional source heading~~ — **not delivered**;
- ~~bounded, sanitized public context excerpt~~ — **not delivered**;
- stable sort order.

No JavaScript or database fetch is required.

**The two struck rows are a deliberate omission with a stated reason, not a backlog item.** The
edge set carries bare slugs: a context excerpt is text from the *linking* note reproduced on
the *linked* note's page, so it is one more surface a withheld string can reach and one more
place two notes' content mix. Adding either means widening the artifact's edge shape, which is
a schema decision. `src/pages/notes/[slug].astro` records the same argument at the component.

The delivered gate over this surface is worth stating as a requirement in its own right,
because the obvious spelling of it is wrong: **the backlink aside is checked against an
allowlist of what may appear, not a list of forbidden strings** — in its text *and* in its
attribute values. A forbidden-string version was measured near-vacuous, and an
attribute-*name* allowlist was too: a leak only had to wear an allowed name, and `class` is
the easiest attribute in any codebase to reach for.

### 13.2 Local graph

The local graph shows published nodes within one hop by default:

- current page emphasized;
- incoming and outgoing edges visually distinguished, and never by colour alone;
- edge type available to screen readers and details view;
- keyboard-selectable nodes;
- list/table fallback representing the same data;
- reduced-motion mode without force-animation;
- bounded node count with an explicit expansion action.

Delivered as build-time SVG with an equivalent table, not as an interactive island.

### 13.3 Global graph

Delivered at `/graph/` as static SVG with an equivalent table. The four conditions stand, and
one is restated because the inversion voided its original meaning:

- ~~the graph remains legible at current node count~~ → **the bound is a stated policy, not an
  assumption about corpus size.** `GLOBAL_NODE_LIMIT` in `src/lib/graph.ts` is that policy, and
  the page states the bound and offers the expansion action rather than silently truncating.
  "Current node count" meant a curated corpus and means nothing now;
- interaction is keyboard-accessible or accompanied by an equivalent searchable list;
- its JS and database budgets meet performance gates;
- it provides decision value beyond visual novelty.

## 14. Hover previews

Hover/focus previews:

- trigger on pointer hover and keyboard focus after a short delay;
- never replace the underlying link behavior;
- use only the bounded preview payload — a projection of published metadata, never a scrape of
  the target page;
- support heading-target previews;
- remain inside viewport and dismiss predictably;
- do not fetch withheld targets. The meaning shifts with the inversion: "not in the manifest"
  becomes "not in the publish set", and the mechanism is that a withheld target is not a link
  at all by the time the page renders;
- avoid raw `innerHTML`; render sanitized structured content.

**Stacked pages are deleted from this document.** They were listed here and in 8.2 as a P1
enhancement, have no implementation, no owner, and no requirement anyone has restated in
twenty-six tickets across two plans. Recording the deletion rather than leaving the paragraph, because an
unowned P1 in a requirements document reads as a commitment.

## 15. Content rendering requirements

### 15.1 Supported

- CommonMark/GitHub-flavored Markdown subset;
- Obsidian wikilinks and heading links;
- ~~public image embeds with explicit alt text~~ — **no image ships**; there is no asset pass,
  an embed resolves to a repository file that is not a publishable note, and it degrades to
  text and is reported. Alt text requirements still bind whatever HTML does render an image;
- callouts;
- task-list visual states without mutability;
- code fences and syntax highlighting;
- tables;
- footnotes;
- math;
- Mermaid under a strict rendering policy;
- safe HTML subset after sanitization.

### 15.2 Rejected or downgraded

- executable scripts;
- Dataview/DataviewJS execution;
- Tasks queries;
- arbitrary iframe/embed HTML;
- missing or withheld embeds;
- dangerous URL schemes;
- **unresolvable** wikilinks — rewritten from "non-public wikilinks", and the change is the
  *reason* rather than the flag. `wikilinks: false` stays set on the renderer, because
  the parser's built-in handler has no corpus access and can only emit a link it cannot
  verify — which is Quartz's 14.6% dangling-edge defect adopted deliberately. Resolution stays
  producer-side, ahead of the renderer, and the outcome it rejects on is *unresolvable*, not
  *non-public*: a link to a withheld note is a normal authoring event that routes to `/private/`,
  while a link to nothing degrades to text;
- unsupported Obsidian plugin syntax.

Rejected dynamic constructs either fail the build when ambiguity is dangerous or render as
fenced/plain source when that is safe and intentional. **A note documenting Obsidian syntax is
content and must publish**: the artifact-level rule forbidding a surviving `[[` was deleted for
exactly this, and the rule over built output is narrowed to exempt `<code>` and `<pre>`
regions.

## 16. Design system and responsive UX

Use design tokens for color, type, spacing, radius, elevation, motion, and content width. The visual direction should be calm, information-dense, and garden-like rather than cloning Quartz.

Required layout behavior:

- desktop: optional explorer, centered article, contextual right rail;
- tablet: collapsible side panels;
- mobile: single-column reading, drawer navigation, no forced graph load;
- print: article, metadata, citations, and canonical URL without interactive chrome;
- maximum readable line length approximately 65–80 characters for prose;
- CJK typography and mixed Chinese/English line breaking explicitly tested;
- no horizontal overflow at 320 CSS px.

## 17. Accessibility requirements

Target WCAG 2.2 AA.

Must include:

- semantic landmarks and heading order;
- skip links;
- visible focus states;
- keyboard-operable search, explorer, previews, and graph fallback;
- dialog focus trap and restoration;
- minimum contrast compliance in all themes;
- reduced-motion support;
- meaningful image alt text or explicit decorative status;
- accessible names for icon-only controls;
- no information encoded by color alone;
- graph data available as an equivalent list/table;
- automated axe checks plus manual keyboard/screen-reader smoke tests. **The axe half is not
  wired**: `axe-core` is in neither `dependencies` nor `devDependencies`, so the automated
  accessibility checks this line promises are not running. The browser suite covers keyboard
  operation, focus, overflow, and reduced motion directly; contrast and landmark structure rest
  on review. Recorded rather than left implying a gate.

## 18. Performance budgets

| Metric | Target |
| --- | --- |
| Lighthouse performance | 95+ on the 32-note fixture corpus's article pages |
| LCP | p75 less than 2.5 seconds |
| INP | p75 less than 200 ms |
| CLS | less than 0.1 |
| Initial JS on article route | less than 50 KB gzip, excluding user-invoked search chunks |
| Initial CSS | less than 40 KB gzip |
| Article HTML | warn above 250 KB uncompressed |
| Graph SQLite transfer | see 12.4 — void until restated |
| Search chunks | lazy-loaded and independently cacheable |

**"Representative article pages" is replaced by a named corpus, because "representative" meant
*one note* for the life of this document.** The fixture corpus is 32 synthetic bilingual
entries built by `pnpm run build:fixture`, and it is what a budget claim must be measured
against. A number measured on a one-note site is not a smaller sample of the same thing.

Budgets are release gates in intent. **In fact CI records no values and fails on no limit** —
`tests/built-output.test.ts` measures CSS but still enforces no limit. TK-09's route/asset slice
now ships as the output-inventory gate; its performance-budget slice remains unbuilt.

## 19. Security and privacy

### 19.1 Artifact scanning

Scan the built output for:

- secrets with checksum-pinned Gitleaks — enforced over the final artifact and explicitly
  inflated gzip members; release builds and repository CI require the exact scanner version,
  redact secret values, and put only sanitized rule/path/position metadata in the private report;
- path markers. **These are hardcoded and should be user configuration**: the only config keys
  are `title`, `origin`, and `exclude`, and the scanner reads no config at all, so every user
  inherits one owner's `msw/` prefix — a widely used HTTP-mocking library, and therefore a
  false build failure waiting for the first user who documents it;
- unresolved wikilinks outside code regions;
- absolute local and home-directory paths;
- source maps;
- unsafe link schemes and non-image `data:` URLs;
- slugs absent from the reviewed publish set — enforced for release builds by exact comparison
  with the committed `.publish-set.json` (see 5.1);
- unexpected routes or assets — enforced by `scripts/verify-output-inventory.ts`: HTML files must
  equal the fixed, note, tag, and collection route model; package assets are byte-bound to
  `public/`; Astro owns flat hashed JS/CSS, while Pagefind uses an exact runtime allowlist and
  metadata-bound content-addressed index members.

All eight are enforced. Gitleaks owns the maintained credential rules; the residue scanner
deliberately does not duplicate them with ad-hoc entropy heuristics.

**Every rule must be individually proven non-vacuous.** An aggregate "eight rules, zero
findings" cannot distinguish eight working rules from one working rule and seven broken ones,
and the scan must additionally refuse to pass over an empty or unreadable output, and over a
file whose type it cannot classify.

**The scan must read what a reader receives, not what the files spell.** The search index
stores extracted text with markup joined and entities decoded, so it must be inflated and
scanned; a marker split by emphasis exists in no file and in the reader's search results.

### 19.2 Browser boundary

- Sanitize Markdown-generated HTML using an explicit allowlist.
- Use DOM APIs or trusted structured rendering for previews and graph labels.
- Avoid untrusted `innerHTML`.
- No inline event handlers.
- No inline scripts unless a documented nonce/hash design supersedes the stricter external-script baseline.
- Serve WASM, Worker, and data assets from the same trusted origin by default.
- Pin dependencies and audit changes to Markdown, sanitization, WASM, and graph libraries.

### 19.3 CSP baseline

The exact policy is deployment-specific, but the intended baseline is:

```text
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data: https:;
font-src 'self';
connect-src 'self';
worker-src 'self';
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
form-action 'none';
```

The shipped policy adds `'wasm-unsafe-eval'` to `script-src`, which Pagefind requires; without
it search cannot execute at all. That is the documented exception the paragraph below asks
for, and it is the only one.

SQLite WASM compatibility must be proven against the final CSP if that path is ever built. Do
not add broad `unsafe-eval` or `unsafe-inline` as a shortcut. `style-src` is coupled to the
diagram mode and the two must change together; `public/_headers` states it at the line.

The policy ships in `dist/_headers`, in Cloudflare Pages' format. **A host that does not read
that file serves the site without any of these headers** — which works, and is weaker, and is
a property of the deployment rather than of the build.

COOP/COEP headers are not requirements today. They become a separate decision if an OPFS mode
or SharedArrayBuffer-dependent feature needs cross-origin isolation.

## 20. Caching and versioning

- HTML: short cache or revalidation suitable for rapid content withdrawal.
- Hashed JS/CSS/WASM assets: `public, max-age=31536000, immutable`.
- Search assets: content-addressed or build-versioned.
- Service Worker: deferred; do not introduce stale-content withdrawal risk.
- Every artifact records `schema_version` and `content_version`.
- Browser code refuses incompatible graph schemas and falls back to static content.

## 21. Build and deployment pipeline

### 21.1 Stages

**Rewritten. Stages 1, 2, 5, and 6 named a manifest and a SQLite artifact that do not exist.**

1. **Discover, apply exclusion rules, and fail on any user pattern matching nothing.** Write
   the report.
2. Resolve every link form in one traversal; route withheld targets to `/private/`, degrade
   unresolved links to text, and record each; warn on ambiguity with every candidate named.
3. Validate the content artifact against the schema.
4. Run link, slug, and redirect checks.
5. ~~Build graph SQLite and fallback adjacency data.~~ Not built; the graph is markup.
6. ~~Run SQLite integrity and foreign-key checks.~~ Replaced by `checkCorpus`, which proves
   backlinks are the exact inverse of outgoing across the corpus.
7. Build Astro static output into an empty directory. **Writing into an empty directory each
   run is a requirement, not an incidental**: deletion is only structural if a stale page
   cannot survive a rebuild.
8. Build the Pagefind index.
9. Verify the exact route/asset inventory, run the pinned redacted secret scan, then scan the
   built output for privacy and security residue.
10. Run unit, integration, accessibility, and browser tests.
11. Verify CSP and absence of inline scripts/events.
12. Run `review`, inspect and commit `.publish-set.json`, then require exact equality with
    `build --release`. Artifact hashes beyond the existing hashed assets remain unbuilt.
13. Deploy only through a separately approved action.
14. Run post-deploy route, header, search, graph, and privacy smoke tests.

Stages 1 through 9 are the shipped binary's build chain. Stages 10 and 11 are this repository's
gates over itself. Stage 12 is the shipped release-qualification boundary; stages 13 and 14
remain separately approved/manual.

### 21.2 Environments

- local: the user's own repository, or this repository's fixture corpus. **A local build needs
  no domain, no account, and no configuration** — an absent `publish.config.yaml` yields
  documented defaults and a complete site at the reserved loopback origin
  `http://publish.localhost/`, which RFC 6761 requires every resolver to map to loopback and
  which therefore cannot reach anyone's server;
- preview: an immutable build for review;
- production: an approved static build;
- D1 preview/production: absent until an explicit ADR enables runtime data.

The origin's fail-loud belongs to release qualification, not local preview. Ordinary `build`
allows the RFC 6761 loopback default; `build --release` refuses it and also requires the exact
committed Publish Set Review. The Action is delivered and always selects release mode, but
this repository has no remote so that workflow has not run here. Deployment itself remains a
separate external approval.

## 22. Testing requirements

### 22.1 Producer tests

- traversal and symlink escape;
- ~~wrong source root~~ and ~~wrong target identity~~ — **deleted.** Both tested `export.py`'s
  check that its target was one named repository, and a general tool runs against any
  repository;
- ambiguous slug, and ambiguous link resolution with every candidate named;
- withheld-link routing, including the nested `[![img](x.png)](note.md)` form, which is a
  separate case: the two spellings of one image disagreed in a shipped draft, and the
  standalone form degraded correctly while the nested form published the withheld folder name;
- unsafe URL schemes across Markdown/reference/raw HTML forms;
- raw HTML sanitization;
- unsupported embeds;
- deterministic output — and specifically **identical output on win32 and Linux**, which is why
  discovery never calls `globSync`;
- no source paths or unknown fields in the artifact.

**Five cases added, each from a design decision with no test before it:**

- a user exclusion pattern matching zero files fails the build, naming the pattern's index and
  its config file, while a structural ignore matching nothing does not;
- an ambiguous link warns with all candidates and still builds;
- the output inventory is exact: unexpected routes/assets, missing expected routes, altered
  package assets, nested Astro output, and unreferenced Pagefind members fail independently;
- the publish set is diffed against an exact committed record; missing, malformed, untracked,
  dirty, added, removed, and stale re-inclusion states all fail release mode;
- deletion round trip: removing a Markdown file removes the page, the feed entry, the sitemap
  entry, and the search record, with a *retained* note still returning a search result for its
  own title. Without that second half, "zero results" proves the index is broken rather than
  that deletion worked.

### 22.2 Graph and corpus tests

- all edge endpoints exist;
- slugs are unique;
- backlinks are the exact inverse of outgoing across the corpus;
- the rendered article's note hrefs equal the edge set, in both directions, excluding the
  page's own slug;
- redirects are acyclic;
- deterministic output for identical input;
- ~~SQLite integrity, foreign keys, manifest hash, fallback-versus-query equality, bound
  parameters~~ — **all five deferred with the store itself** (12.3). They are not failing;
  there is nothing to run them against.

### 22.3 Browser tests

- article readable with JavaScript disabled;
- internal link and heading navigation;
- search keyboard flow;
- preview hover and focus behavior;
- ~~graph worker success, failure, timeout, and fallback~~ — deferred with 12.3; the graph is
  markup and has no worker;
- narrow viewport and no overflow;
- reduced motion;
- dark mode and reader mode;
- CSP console clean;
- no broken asset or route requests;
- no private residue in DOM, network responses, or Pagefind data.

### 22.4 Visual tests

Capture representative:

- long bilingual article;
- code-heavy article;
- table-heavy article;
- callout/math/Mermaid article;
- mobile article;
- search dialog;
- local graph and accessible fallback;
- 404;
- empty backlinks state;
- large backlinks state.

## 23. Observability without invasive analytics

Ship with no third-party analytics by default.

Operational evidence may use:

- a host's own aggregate request/error logs if enabled under a separate privacy decision;
- build metrics and artifact sizes in CI;
- client-side error reporting only after explicit approval and data-minimization design;
- no fingerprinting, session replay, advertising IDs, or cross-site tracking.

**A build log is itself observability with a disclosure profile**, and it is the one this
project got wrong first: the counts a run prints are the operational evidence, and the names
are not. See 5.5.

## 24. Delivery phases

### Phase 0 — decision and contract freeze — **done**

- Domain terms and artifact schema frozen at `SCHEMA_VERSION = 1`, which has not moved across
  the inversion.
- Content authority recorded as DR-1, then reversed as DR-7.

### Phase 1 — static reader foundation — **done**

- Astro layouts and design system.
- Sanitized content contract.
- Stable routes, metadata, RSS, sitemap.
- Pagefind search.
- Static backlinks, breadcrumbs, TOC, previews, frontmatter tags, and first-folder collections.
- Accessibility and privacy gates. Performance gates are measured and not enforced; see 18.

### Phase 1b — the general-purpose turn — **the current phase**

Not in the original plan, and it displaced Phase 2 entirely:

- a producer that walks a repository, replacing the vault exporter;
- default-publish with exclusion by glob and frontmatter;
- five link forms in one traversal, with typed outcomes;
- configuration, and a site identity that belongs to the user;
- a report that lives where nothing can publish it;
- packaging as an installable command, and local preview.

The GitHub Action, `init`, and reviewed release boundary are delivered; this repository has no
remote, so the workflow has not run. No version-1 producer field remains underived.

### Phase 2 — interactive graph via SQLite WASM — **not started**

- Versioned graph schema and static database artifact.
- Dedicated Worker wrapper.
- A local-graph component, in whatever renders it.
- Accessible list fallback — **already shipped** with the static graph, and it is what makes
  deferring the rest cheap.
- Failure and browser-compatibility matrix.

### Phase 3 — advanced garden UX

- global graph with filtering, if useful — the static one ships;
- richer relationship filters;
- Base-like public views;
- optional offline caching.

Stacked pages are deleted from this phase; see 14.

### Phase 4 — conditional runtime service

Only after a measured static limitation:

- approve D1 ADR;
- add Worker read API;
- preserve static page/backlink fallbacks;
- add rate limits, runtime monitoring, cost budgets, and failure drills.

## 25. Acceptance criteria

**"Launch" is retired as a frame.** This is a tool a stranger installs, so there is no single
launch; there is a release, and each release meets these:

- ~~every deployed page is present in the approved public manifest~~ → every release build's
  computed public slugs exactly equal the committed `.publish-set.json` the user reviewed;
- scans of the built output, including the search index inflated, find zero residue;
- the complete output inventory contains exactly modeled routes, byte-bound package assets,
  hashed Astro JS/CSS, and the fixed/metadata-bound Pagefind members;
- all routes, headings, and redirects resolve;
- no unresolved wikilink remains outside a code region in built output;
- build output is deterministic, and identical on win32 and Linux;
- static backlinks match the edge set, and the rendered article's hrefs match it in both
  directions;
- normal article reading works without JavaScript;
- search works for representative Chinese and English queries. `tests/search.test.ts` segments
  a query from the corpus under test and requires it in both inflated Pagefind text and the
  rendered note before querying; its CJK control rejects an unsplit whole-title token;
- accessibility tests meet WCAG 2.2 AA gates;
- performance budgets are measured on a named corpus;
- CSP is strict and the browser console is clean;
- headers, cache policy, RSS, sitemap, and social metadata are verified;
- **a site built by someone who is not this tool's author carries no trace of its author** —
  no name, no origin, no card, no storage key — asserted over every file as bytes, gzip
  members inflated, with a control that plants the name split by markup;
- deployment had explicit approval separate from building.

## 26. Decision record

### DR-1 — Content authority — **superseded by DR-7**

**Original decision, 2026-08-06:** The private manifest and deterministic exporter are the
authority for public content selection. The public repository never scans the private vault and
never infers publication from folder or frontmatter alone.

Kept in full rather than rewritten, because DR-7 is only legible beside it. This was correct
for the product as scoped and is the exact opposite of what the tool now does.

### DR-2 — Rendering architecture — **amended**

**Decision:** Astro static generation is the baseline. Core reading and backlinks remain static
HTML.

**Amendment:** "Svelte is restricted to interactive islands" is struck. No framework is
installed and five interactive surfaces ship as vanilla script; see 11.3.

### DR-3 — Search

**Decision:** Pagefind is the search system. A relationship store is not a search engine.

### DR-4 — Relationship storage — **amended**

**Original recommendation:** a content-addressed static SQLite artifact loaded on demand into
SQLite WASM in a dedicated Worker, with static HTML/JSON fallback.

**Amendment:** the *fallback* shipped and the store did not. Build-time HTML backlinks and a
static SVG graph with an equivalent table meet the reader requirements at present corpus sizes
with no fetch, no WASM, and no CSP exception. The store stays available as Phase 2 and its
sizing premise needs restating first; see 12.

### DR-5 — D1

**Decision:** Do not use D1. Introduce it only through an approved Worker API after a measured
static limitation. Direct browser access to D1 is prohibited. The zero-secret, any-host
property of the adoption path raises the bar further; see 12.5.

### DR-6 — Runtime features

**Decision:** No comments, authentication, analytics, or mutable public state.

### DR-7 — Default publish, with explicit exclusion — **supersedes DR-1**

**Decision (2026-08, owner):** The user's repository is the content. Every Markdown file in it
publishes unless withheld by a glob in `publish.config.yaml` or `publish: false` in the note's
own frontmatter. Frontmatter wins when the two disagree, and a `!` re-include cannot resurrect
a note that says `publish: false`.

**What was traded, stated as the owner accepted it.** The manifest made privacy *structural*: a
note not named in it was physically unreadable, so no bug in this tree could publish it.
Default-publish deletes that guarantee. Every file is readable by construction, and a mistyped
exclusion glob publishes a note the user believed was private — silently, and irreversibly once
it reaches a CDN and a search index.

**The mitigations, and their status:**

| Mitigation | Status |
| --- | --- |
| A user pattern matching zero files fails the build, with no override flag | shipped |
| Structural ignores are separate, so a shipped default matching nothing is not a failure | shipped |
| The report names every discovered file and the rule that decided it | shipped |
| Withheld and unresolved links are distinct outcomes, both reported | shipped |
| The report cannot be committed and cannot reach the output | shipped, gated |
| The build's log carries counts and never names | shipped, gated |
| Removing a note removes its page, feed entry, sitemap entry, and search record | shipped, gated by `tests/deletion-roundtrip.test.ts` with retained-route and retained-search controls; browser search derives its positive query from the corpus under test |
| An asset reaches the output only from a published note | enforced more narrowly: no note asset may ship; exact routes, byte-bound package assets, and constrained Astro/Pagefind namespaces are the complete output inventory |
| **The publish set is reviewed as a diff before it publishes** | shipped: `review` writes exact public slugs; `build --release` requires a clean committed equality match, and the Action cannot disable it |

**Why the asymmetry between the two exclusion mechanisms.** The two failure modes are not
equal. A note the user meant to publish and did not is an inconvenience they will notice; a
note they meant to keep private and published is irreversible. So the mechanism pointing
toward *not publishing* — three words inside the file itself, nearest the content — always
wins, and the mechanism pointing toward publishing never overrides one.

### DR-8 — Link ambiguity warns; it does not fail

**Decision (2026-08-12, owner):** Resolve using Obsidian's researched tier order, render the
link, and record the ambiguity in the report naming every candidate. Fail only under an opt-in
strict mode, which has no implementation yet.

Hard failure was rejected as unbounded and unoverridable, and worst exactly where it is most
likely — two root-level notes sharing a basename, which a stranger cannot act on from their own
repository. Silent resolution was rejected equally: that is the competitors' shared defect,
where zero matches and five matches fall through identically with no warning.

Two deliberate divergences from Obsidian ride on this decision and are recorded because
"Obsidian-compatible" is ambiguous between two first-party implementations that genuinely
disagree. **Aliases are not link targets** (desktop's behaviour, not Publish's). **Both link
text and file paths are NFC-normalised** (Obsidian normalises only the link text, which
fails against a macOS-decomposed filename).

### DR-9 — This repository is the tool, and has no site of its own

**Decision (2026-08-12, owner):** This repository holds the tool and no site of its own. Its
demo corpus is synthetic; whoever wrote it publishes their own notes with it like anyone else,
from their own repository.

Delivered for identity — a foreign build carried 126 occurrences of one owner's name across 15
files, of which only nine were in `.html`, and now carries zero. **And delivered for content:**
`ff0db9d` replaced the one real personal note with a synthetic entry, `reading-a-build-log`.

## 27. Decision frontier — closed

Every question below was open at drafting. All eight are answered; the answers are recorded
here rather than in the table above so that the *option that was not taken* stays visible.

### Q1 — Relationship-store mode — **answered: static HTML, store deferred**

Neither of the three offered options. Build-time HTML backlinks and a static SVG graph with an
equivalent table meet the reader requirements with no fetch and no WASM, so the "fallback" in
the original recommendation became the product. DR-4.

### Q2 — Information architecture — **answered: folders are the hierarchy**

The question is closed and the option "curated collections independent of folder structure" is
gone with the curation. The first folder now becomes one flat collection; deeper folders remain
in the note slug rather than creating another hierarchy.

### Q3 — Publishing cadence — **answered: every push, gated**

The user's own workflow decides, and the shape the tool is designed for is push-to-publish.
The option "scheduled publication of already-approved manifest entries" is **deleted** — there
are no approved entries to schedule.

Push-to-publish is bounded by the publication-event guard in 5.1: the Action refuses a release
until the exact slug set matches the committed review.

### Q4 — URL and deletion policy — **answered: delete and recreate**

A rename is a new address and the old one 404s. `REDIRECT_RULES` is `[]` and cannot grow from a
corpus, so "mutable slugs with permanent redirects" describes machinery that does not exist.
`status: 'tombstone'` is retained as a separate published-but-withdrawn state affecting feed
and sitemap only, and must not be confused with exclusion. See 9.3.

### Q5 — Feature scope — **answered: the P0 reader, and then the general-purpose turn**

Delivered as recommended, and then overtaken: the scope question that mattered turned out not
to be which reader features ship but who the reader's site belongs to. See 24, Phase 1b.

### Q6 — Visual direction — **answered: bespoke, Quartz as benchmark only**

As recommended. Unchanged by the inversion — it was a reader property.

### Q7 — Languages — **answered: bilingual chrome, resolved per document**

Stronger than the recommendation. Chrome resolves per document from the note's language rather
than one navigation language site-wide, and a gate walks `src/` refusing any module that holds
a chrome literal outside the translation contract.

### Q8 — Analytics and feedback — **answered: none**

As recommended. DR-6.

## 28. Primary-source baseline

The detailed fact/recommendation separation and pinned source inventory lives in [`docs/research/publisher-platform-primary-source-evidence.md`](research/publisher-platform-primary-source-evidence.md).

**These sources were accessed 2026-08-06 and have not been re-verified since.** Two entries
below are for technology this project no longer uses and are kept because the decisions that
rejected them cite these pages.

- Quartz v5 documentation and repository, pinned baseline commit `74b3fc9efd0caafea3dbcd846ddf1f06855b6d2a`: <https://github.com/jackyzha0/quartz/tree/v5>
- Quartz v5 feature list: <https://github.com/jackyzha0/quartz/blob/v5/docs/features/index.md>
- Astro islands architecture: <https://docs.astro.build/en/concepts/islands/>
- Astro Svelte integration (no longer used; see 11.3): <https://docs.astro.build/en/guides/integrations-guide/svelte/>
- Astro Cloudflare integration (not used; the build is host-agnostic): <https://docs.astro.build/en/guides/integrations-guide/cloudflare/>
- Cloudflare D1 overview: <https://developers.cloudflare.com/d1/>
- Cloudflare D1 limits: <https://developers.cloudflare.com/d1/platform/limits/>
- SQLite WASM documentation: <https://sqlite.org/wasm/doc/trunk/index.md>
- SQLite WASM persistence and OPFS constraints: <https://sqlite.org/wasm/doc/trunk/persistence.md>
- Pagefind documentation: <https://pagefind.app/docs/>

A second body of primary-source work underlies the general-purpose turn — Obsidian's link
resolution recovered by executing the shipped `getLinkpathDest`, and a survey of how five
publishers handle configuration, multi-repo builds, and upgrades. It lives in the ticket
reports and in `docs/plans/ssg-generalisation-plan.md` §2 and §5 rather than here.

## 29. Handoff checklist — closed, with what replaced it

The dedicated project exists and is this repository. Each item's outcome:

- [x] Requirements baseline copied and versioned. This document, revised 2026-08-19.
- [x] Project `AGENTS.md`. It is the contract every agent reads first, and over eighty source
      comment lines cite this document by section number — which is why section 27's numbering
      survived a revision that emptied it.
- [x] Decision frontier resolved. Section 27, all eight.
- [x] Context glossary. Section 6 is the canonical glossary; a second `CONTEXT.md` would create
      two authorities for the same terms.
- [x] ADRs for relationship store and content authority. DR-4 amended, DR-1 superseded by DR-7.
- [x] P0 capabilities converted to tickets. Twenty-six delivered.
- [x] **The three approval boundaries: infrastructure, publish set, deployment.** Item-level
      approval was replaced by the committed exact Publish Set Review in 5.1; infrastructure
      and deployment approval remain separate.
- [x] No deployment work before an approved domain and hosting target. Nothing here deploys,
      and the origin a user does not configure is loopback.
