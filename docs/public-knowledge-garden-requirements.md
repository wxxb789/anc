# Public Knowledge Garden — Product Requirements and Architecture

**Status:** Draft for owner review  
**Document type:** Product requirements + architecture decision baseline  
**Target project:** Dedicated public knowledge-garden publisher  
**Last updated:** 2026-08-06  
**Implementation status:** Design only; this document does not authorize deployment

## 1. Executive summary

Build a privacy-preserving, static-first public knowledge garden with a feature surface comparable to Quartz v5, implemented with Astro and Svelte.

The product publishes only explicitly approved content from a private knowledge system. The public project never receives the private vault, private paths, work content, credentials, or non-allowlisted source material.

The default architecture is:

- Astro static-site generation for routes, HTML, metadata, RSS, sitemap, and static backlinks;
- Svelte islands only for interaction that cannot be expressed as HTML and CSS;
- Pagefind for full-text search;
- a content-addressed, read-only SQLite graph artifact distributed as a static CDN asset;
- SQLite WASM in a Web Worker for optional interactive graph and relationship queries;
- no server runtime, D1, authentication, comments, or analytics at launch;
- Cloudflare static hosting with strict CSP and immutable asset caching.

D1 is a conditional escalation path, not the launch default. Browser code must never connect directly to D1 with privileged credentials. If D1 becomes necessary, a narrow Cloudflare Worker API exposes anonymous, read-only, rate-limited graph queries while HTML pages remain prerendered.

## 2. Problem statement

A private Obsidian-first knowledge system needs a public projection that preserves the useful navigation and discovery affordances of a modern digital garden without exposing private data or coupling publication to the private repository.

The current proof of concept validates explicit allowlisting, deterministic export, static Astro output, Pagefind search, static backlinks, and strict browser security. The dedicated project must turn that proof into a durable product with:

- an intentional reader experience;
- a stable public content contract;
- graph-native navigation and backlinks;
- predictable build and deployment behavior;
- measurable performance and accessibility;
- independent evolution from the private vault;
- a documented path from fully static relationship data to D1 only if justified.

## 3. Goals

### 3.1 Product goals

1. Publish an explicitly reviewed subset of durable knowledge as a coherent public garden.
2. Provide Quartz-v5-like discovery: search, backlinks, local graph, explorer, tags, breadcrumbs, table of contents, and hover previews.
3. Preserve meaningful Obsidian authoring semantics without shipping the vault itself.
4. Make core reading, navigation, backlinks, metadata, and SEO work without client JavaScript.
5. Load interactive JavaScript only for bounded Svelte islands.
6. Keep publication reproducible from versioned, sanitized public artifacts.
7. Make privacy and deployment fail closed.
8. Keep the relationship-store implementation replaceable behind one query contract.

### 3.2 Engineering goals

- Static output by default.
- Deterministic builds from pinned dependencies and content artifacts.
- No private-vault access in public CI.
- Strict type and schema validation at every boundary.
- Content-addressed graph/search assets with explicit schema versions.
- Small, independently hydrated Svelte islands.
- Browser feature degradation that preserves reading and navigation.
- Cloudflare portability without requiring Cloudflare services for local builds.

## 4. Non-goals

The initial product does not include:

- editing public content in the browser;
- bidirectional synchronization with the private vault;
- public comments, reactions, accounts, or personalization;
- exposing private pages through client-side encryption;
- publishing `sources/` or work content by folder convention;
- treating a `publish: true` frontmatter field as sufficient authorization;
- runtime rendering of normal content pages;
- D1 as the canonical content database;
- client-side access to D1 credentials or Cloudflare administrative APIs;
- cloning Quartz internals or its plugin system;
- full Obsidian plugin compatibility;
- rendering arbitrary Dataview or executable user scripts.

## 5. Guiding principles

### 5.1 Explicit projection, not vault deployment

The publisher consumes a sanitized public projection. The private repository owns content selection and export policy. The public repository owns presentation, public navigation, public graph data, and deployment.

### 5.2 Static is the product baseline

A reader must be able to open a page, follow links, inspect backlinks, read metadata, and use browser-native navigation when JavaScript is disabled or fails.

### 5.3 Progressive enhancement

Interactive search, graph exploration, stacked panes, command palette, and hover behavior are enhancements. Their failure must not remove the underlying link or content.

### 5.4 Relationships have one public contract

Build-time backlinks, the interactive graph, related-note queries, and future D1 APIs derive from the same versioned edge model. Storage technology must not redefine relationship semantics.

### 5.5 Privacy is an artifact property

The final public Git tree, generated site, search index, SQLite database, source maps, logs, error pages, and HTTP headers must all be safe to disclose independently.

## 6. Domain model and ubiquitous language

| Term | Definition |
| --- | --- |
| Private Source | The private knowledge repository and its non-public metadata. It is never available to public CI or runtime. |
| Publication Manifest | The reviewed allowlist naming specific private source items approved for export. |
| Projection | The sanitized, deterministic public representation produced from the manifest. |
| Public Document | One approved page with public metadata, sanitized Markdown/HTML, and a stable public identifier. |
| Public ID | An immutable opaque identifier for a public document. It does not encode a private path. |
| Slug | The public route key. Slugs may change through an explicit redirect record; Public IDs do not. |
| Public Link | A link whose source and target are both in the projection. |
| Suppressed Link | A private or non-public link rendered as safe text, never as a discoverable target. |
| Edge | A typed, directed relationship between two public nodes. |
| Backlink | An incoming `links-to` edge for a public document. |
| Graph Artifact | A versioned public relationship dataset, normally a static SQLite file plus manifest. |
| Content Artifact | Versioned public document data consumed by the site build. |
| Build | Deterministic conversion of public artifacts into deployable static output. |
| Sync | Local regeneration of public artifacts. Sync is not publication or deployment. |
| Deployment | External release of a reviewed build to a hosting environment. |
| Reader Shell | Static Astro layout, navigation, metadata, and content HTML. |
| Interactive Island | A Svelte component hydrated for a bounded interactive feature. |
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

### 7.2 Owner/editor

The owner must be able to:

1. approve content item by item in the private manifest;
2. regenerate deterministic public artifacts locally;
3. review an exact public diff before deployment;
4. verify no private residue exists;
5. preview the static site;
6. publish through a separately approved Git/deployment action;
7. change a slug without breaking old URLs;
8. withdraw a page and generate explicit tombstone or redirect behavior;
9. reproduce a historical build from versioned inputs.

### 7.3 Maintainer/agent

A maintainer or agent must be able to:

- validate schemas and route invariants;
- query content and graph artifacts without private access;
- run privacy, security, accessibility, and performance gates;
- identify whether a failure belongs to export, build, graph generation, or deployment;
- change implementation without changing public domain semantics.

## 8. Quartz v5-inspired feature requirements

Quartz v5 is a feature benchmark, not an implementation dependency. The parity target is based on the official Quartz v5 feature documentation at commit `74b3fc9efd0caafea3dbcd846ddf1f06855b6d2a` accessed 2026-08-06.

### 8.1 P0 — launch requirements

| Capability | Requirement | Delivery model |
| --- | --- | --- |
| Obsidian-flavored Markdown | Headings, wikilinks, aliases, heading links, callouts, highlights, tasks, code fences, and safe embedded public assets | Build-time transform |
| Public wikilinks | Resolve aliases and headings only within the allowlisted projection | Build-time |
| Backlinks | Render incoming links in static HTML; include context snippets where safe | Build-time HTML + graph artifact |
| Full-text search | Keyboard-accessible search with CJK support, excerpts, and tag filtering | Pagefind static index; Svelte dialog |
| Explorer | Browse public collections and nested public routes | Static data + Svelte enhancement |
| Breadcrumbs | Stable hierarchy independent of private paths | Static HTML |
| Table of contents | Heading navigation with active-section enhancement | Static HTML + optional island |
| Tags | Tag listing pages and per-page tag links | Static routes |
| Folder/collection listings | Curated public collections; never mirror private folder names automatically | Static routes |
| Hover previews | Safe title, summary, metadata, and bounded excerpt | Static public preview payload + island |
| Local graph | One-hop incoming/outgoing public neighborhood | SQLite WASM island; static link-list fallback |
| Dark mode | System preference plus explicit user toggle | CSS + minimal island |
| Reader mode | Distraction-reduced layout | CSS + minimal island |
| Syntax highlighting | Build-time highlighted code with copy affordance | Static HTML + tiny island |
| Math | Build-time KaTeX or equivalent where approved | Static HTML/CSS |
| Mermaid | Render safely; lazy-load only on pages that contain diagrams | Build-time where possible; bounded island otherwise |
| RSS/Atom | Public posts/notes feed with canonical URLs | Build-time |
| Sitemap and robots | Canonical sitemap, explicit indexing policy | Build-time |
| Social cards | Deterministic Open Graph metadata and optional generated images | Build-time |
| 404 and redirects | Static 404 plus versioned redirect map | Build-time/host config |
| Responsive layout | Mobile-first, no horizontal overflow | Static CSS |

### 8.2 P1 — post-launch enhancements

- Global graph with filtering and accessible non-canvas fallback.
- Stacked-page reading inspired by Andy Matuschak.
- Recently changed notes.
- Link-context search and relationship filters.
- Public note properties panel.
- Citation rendering and bibliography pages.
- Canvas projection for explicitly approved canvases.
- Public Base-like tables/cards generated from public metadata only.
- Offline shell and cached graph artifact where measured use justifies it.
- Multiple visual themes using design tokens.

### 8.3 Explicitly deferred Quartz features

- Encrypted/private pages: client-side encryption is not a substitute for keeping private content out of public artifacts.
- Comments: adds identity, moderation, privacy, and runtime dependencies.
- Arbitrary plugin loading: conflicts with a small, auditable static architecture.
- General SPA routing: evaluate only after navigation metrics show a need. Standard multi-page navigation remains the baseline.
- Full vault explorer: only public, curated collections are exposed.

## 9. Information architecture

### 9.1 Public route model

Recommended routes:

```text
/
/notes/<slug>/
/collections/<slug>/
/tags/<tag>/
/recent/
/graph/
/search/                 # optional dedicated route; dialog remains available
/about/
/privacy/
404.html
```

Routes must not expose private source paths. A public slug is selected or derived inside the projection process and validated for uniqueness.

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
11. optional local-graph island;
12. previous/next or collection navigation where meaningful;
13. footer with public provenance and canonical URL.

### 9.3 Stable identity and redirects

- `public_id` is immutable.
- `slug` is unique but mutable through an explicit redirect record.
- Redirects are generated as static host rules and tested for cycles.
- Removed content is represented by either a redirect or an intentional tombstone policy.
- Relationship edges use Public IDs internally, not slugs.

## 10. Public content contract

### 10.1 Required document fields

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

Optional fields include aliases, description, canonical external source, authorship label, cover image, reading order, citation metadata, and social image configuration.

### 10.2 Fields forbidden in public artifacts

- private vault paths;
- work/MSW identifiers;
- local machine paths;
- private tags or aliases;
- unpublished titles or excerpts;
- credentials, tokens, cookies, connection strings, or private headers;
- private backlink counts;
- source-control metadata that reveals private filenames;
- raw frontmatter not explicitly allowlisted.

### 10.3 Projection behavior

The exporter must:

1. parse a versioned manifest;
2. reject absolute paths, traversal, backslash separators, symlink escapes, and non-approved roots;
3. require each source to be a regular supported file;
4. sanitize frontmatter through a field allowlist;
5. resolve public IDs, slugs, aliases, headings, and public links deterministically;
6. render non-public links as plain text without target metadata;
7. copy only explicitly referenced and approved assets;
8. reject unsafe URL schemes and unsupported embeds;
9. produce deterministic content and graph artifacts;
10. write only after target-project identity validation;
11. emit a privacy/audit summary without private values;
12. leave deployment as a separate action.

## 11. Target technical architecture

### 11.1 Layer model

```text
Private repository
  Publication manifest + approved Garden documents
              |
              v
Deterministic exporter
  Sanitization + link resolution + public IDs + graph extraction
              |
              v
Public artifact boundary
  content manifest + page payloads + graph SQLite + asset manifest
              |
              v
Astro build
  Static HTML/routes/RSS/sitemap/Pagefind/headers
              |
              v
Cloudflare static assets
  HTML/CSS/JS/WASM/content-addressed DB
```

### 11.2 Astro responsibilities

Astro owns:

- static route generation;
- layouts and page composition;
- content rendering from sanitized artifacts;
- metadata, RSS, sitemap, redirects, and error pages;
- build-time backlinks and related-note fallback lists;
- strict bundling of CSS and external scripts;
- no-JavaScript baseline behavior.

The project should remain `output: "static"`. The Cloudflare Astro adapter is unnecessary for a static-only deployment.

### 11.3 Svelte responsibilities

Svelte 5 islands own only:

- search dialog and keyboard navigation;
- explorer expand/collapse state;
- hover preview positioning and interaction;
- local/global graph interaction;
- theme and reader-mode toggles;
- optional stacked-page navigation.

Every island must define:

- hydration trigger (`client:idle`, `client:visible`, or explicit interaction preference);
- JavaScript budget;
- accessible fallback;
- error boundary/failure behavior;
- whether state is transient, URL-backed, or local-storage-backed.

Article content, backlinks, breadcrumbs, tag links, and primary navigation must not require Svelte hydration.

### 11.4 Search

Pagefind remains the launch search engine because it is static, CDN-friendly, and independent of the graph database.

Requirements:

- CJK tokenization verified with representative Chinese and English queries;
- title weighted above body;
- tags and collection filterable;
- excerpts contain public text only;
- keyboard navigation and focus restoration;
- search bundle lazy-loaded on first use;
- zero results distinguish no match from index-load failure.

SQLite FTS is not a launch requirement. It may be evaluated later only if Pagefind cannot satisfy measured query behavior.

## 12. Relationship-store architecture

### 12.1 Canonical relationship model

The exporter produces typed public edges:

```text
links-to
embeds
cites
belongs-to-collection
has-tag
redirects-to
related-to             # only when explicitly curated or generated by a documented rule
```

Only `links-to` and `embeds` generate backlinks by default. Derived relationships must record their derivation method.

### 12.2 Recommended SQLite schema

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

### 12.3 Static SQLite artifact — launch decision

Generate at build/export time:

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
8. Return structured-clone-safe result objects to Svelte.
9. Terminate or idle the worker after a bounded period.
10. Fall back to static HTML or bounded JSON adjacency if WASM fails.

The launch path should load the database into worker memory. OPFS persistence is optional and deferred; it adds browser, concurrency, private-mode, and header complexity without improving the first visit. Browser Cache API may cache the content-addressed response using normal HTTP caching.

### 12.4 Database size and loading policy

Initial budgets:

- graph manifest: less than 10 KB uncompressed;
- graph database warning threshold: 2 MB compressed transfer;
- graph database hard launch budget: 5 MB compressed transfer;
- local-neighborhood query after worker readiness: p95 less than 50 ms on a representative mid-range mobile device;
- graph island must not delay Largest Contentful Paint;
- graph code/database loaded only after explicit user intent or when the graph enters the viewport.

If the artifact exceeds the hard budget:

1. optimize schema and remove duplicated text;
2. keep backlink HTML static;
3. shard by public collection or publish a compact adjacency index;
4. evaluate HTTP-range-capable read-only VFS only with a pinned, audited implementation;
5. evaluate D1 only after static/sharded options fail the measured requirement.

### 12.5 D1 escalation path

D1 is appropriate only if one or more are measured:

- the graph artifact is too large for acceptable transfer/cold-start budgets;
- relationships change independently of site deployments;
- server-side filtering is required for a large public graph;
- abuse-resistant shared state is introduced;
- runtime features already require a Worker.

D1 architecture:

```text
Browser -> read-only HTTPS endpoint -> Cloudflare Worker -> D1
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
- optional source heading;
- bounded, sanitized public context excerpt;
- stable sort order.

No JavaScript or database fetch is required.

### 13.2 Local graph

The local graph shows public nodes within one hop by default:

- current page emphasized;
- incoming and outgoing edges visually distinguished;
- edge type available to screen readers and details view;
- keyboard-selectable nodes;
- list/table fallback representing the same data;
- reduced-motion mode without force-animation;
- bounded node count with an explicit expansion action.

### 13.3 Global graph

Global graph is P1 and must not ship until:

- the graph remains legible at current node count;
- interaction is keyboard-accessible or accompanied by an equivalent searchable list;
- its JS and database budgets meet performance gates;
- it provides a decision value beyond visual novelty.

## 14. Hover previews and stacked pages

Hover/focus previews:

- trigger on pointer hover and keyboard focus after a short delay;
- never replace the underlying link behavior;
- use only public preview payloads;
- support heading-target previews;
- remain inside viewport and dismiss predictably;
- do not fetch private/non-public targets;
- avoid raw `innerHTML`; render sanitized structured content.

Stacked pages are deferred to P1. If implemented, the URL must represent the primary page and optionally encode the stack in a shareable, bounded form. Browser back/forward semantics must remain predictable.

## 15. Content rendering requirements

### 15.1 Supported at launch

- CommonMark/GitHub-flavored Markdown subset;
- Obsidian wikilinks and heading links;
- public image embeds with explicit alt text;
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
- private or missing embeds;
- dangerous URL schemes;
- non-public wikilinks;
- unsupported Obsidian plugin syntax.

Rejected dynamic constructs either fail export when ambiguity is dangerous or render as fenced/plain source when that is safe and intentional.

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
- automated axe checks plus manual keyboard/screen-reader smoke tests.

## 18. Performance budgets

Representative production budgets:

| Metric | Target |
| --- | --- |
| Lighthouse performance | 95+ on representative article pages |
| LCP | p75 less than 2.5 seconds |
| INP | p75 less than 200 ms |
| CLS | less than 0.1 |
| Initial JS on article route | less than 50 KB gzip, excluding user-invoked search/graph chunks |
| Initial CSS | less than 40 KB gzip |
| Article HTML | warn above 250 KB uncompressed |
| Graph SQLite transfer | less than 2 MB preferred, 5 MB hard launch budget |
| Search/graph chunks | lazy-loaded and independently cacheable |

Budgets are release gates, not aspirational documentation. CI records actual values and fails on configured hard limits.

## 19. Security and privacy

### 19.1 Artifact scanning

Scan the public repository and built output for:

- secrets with Gitleaks or equivalent;
- private path markers;
- work/MSW markers;
- unresolved wikilinks;
- absolute local paths;
- source maps containing private data;
- non-allowlisted titles or slugs;
- unsafe link schemes;
- unexpected routes or assets.

### 19.2 Browser boundary

- Sanitize Markdown-generated HTML using an explicit allowlist.
- Use DOM APIs or trusted structured rendering for previews and graph labels.
- Avoid untrusted `innerHTML`.
- No inline event handlers.
- No inline scripts unless a documented nonce/hash design supersedes the stricter external-script baseline.
- Serve WASM, Worker, database, and data assets from the same trusted origin by default.
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

SQLite WASM compatibility must be proven against the final CSP. If a browser requires `wasm-unsafe-eval`, add it only with a documented compatibility test and threat review. Do not add broad `unsafe-eval` or `unsafe-inline` as a shortcut.

COOP/COEP headers are not launch requirements for in-memory, read-only SQLite in a dedicated Worker. They become a separate decision if an OPFS mode or SharedArrayBuffer-dependent feature needs cross-origin isolation.

## 20. Caching and versioning

- HTML: short cache or revalidation suitable for rapid content withdrawal.
- Hashed JS/CSS/WASM/database assets: `public, max-age=31536000, immutable`.
- `graph-manifest.json`: short cache with ETag.
- Search assets: content-addressed or build-versioned.
- Service Worker: deferred; do not introduce stale-content withdrawal risk at launch.
- Every artifact records `schema_version` and `content_version`.
- Browser code refuses incompatible graph schemas and falls back to static content.

## 21. Build and deployment pipeline

### 21.1 Local/CI stages

1. Validate private publication manifest.
2. Export sanitized public artifacts.
3. Validate content and graph schemas.
4. Run public-link, slug, alias, heading, and redirect checks.
5. Build graph SQLite and fallback adjacency data.
6. Run SQLite integrity and foreign-key checks.
7. Build Astro static output.
8. Build Pagefind index.
9. Scan public source and `dist/` for privacy/security residue.
10. Run unit, integration, accessibility, and browser tests.
11. Verify CSP and absence of inline scripts/events.
12. Produce a reviewable build manifest and artifact hashes.
13. Deploy only through a separately approved action.
14. Run post-deploy route, header, search, graph, and privacy smoke tests.

### 21.2 Environments

- local: synthetic or explicitly approved public artifacts;
- preview: immutable build for review, with no private data access;
- production: approved static build;
- D1 preview/production: absent until an explicit ADR enables runtime data.

## 22. Testing requirements

### 22.1 Exporter tests

- traversal and symlink escape;
- wrong source root;
- wrong target identity;
- ambiguous alias/slug;
- private link downgrade;
- unsafe URL schemes across Markdown/reference/raw HTML forms;
- raw HTML sanitization;
- unsupported embeds;
- deterministic output;
- explicit asset inclusion;
- no private fields in public artifacts.

### 22.2 Graph tests

- all edge endpoints exist;
- public IDs and slugs are unique;
- backlink/incoming counts match edge queries;
- aliases resolve deterministically;
- redirects are acyclic;
- SQLite `PRAGMA integrity_check` returns `ok`;
- foreign-key check is empty;
- deterministic database content for identical input;
- manifest hash/size matches the asset;
- fallback adjacency equals SQLite query results for fixtures;
- query templates use bound parameters.

### 22.3 Browser tests

- article readable with JavaScript disabled;
- internal link and heading navigation;
- search keyboard flow;
- preview hover and focus behavior;
- graph worker success, failure, timeout, and fallback;
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

Launch with no third-party analytics by default.

Operational evidence may use:

- Cloudflare aggregate request/error logs if enabled under a separate privacy decision;
- build metrics and artifact sizes in CI;
- client-side error reporting only after explicit approval and data-minimization design;
- no fingerprinting, session replay, advertising IDs, or cross-site tracking.

## 24. Delivery phases

### Phase 0 — decision and contract freeze

- Approve this document and answer open decisions.
- Freeze public domain terms and artifact schemas.
- Record ADRs for static relationship storage and content authority.

### Phase 1 — static reader foundation

- Astro layouts and design system.
- Sanitized public content contract.
- Stable routes, redirects, metadata, RSS, sitemap.
- Pagefind search.
- Static backlinks, tags, collections, breadcrumbs, TOC, previews.
- Accessibility, privacy, and performance gates.

### Phase 2 — interactive graph via SQLite WASM

- Versioned graph schema and static database artifact.
- Dedicated Worker wrapper.
- Svelte local-graph island.
- Accessible list fallback.
- failure and browser-compatibility matrix.

### Phase 3 — advanced garden UX

- global graph if useful;
- stacked pages;
- richer relationship filters;
- Base-like public views;
- optional offline caching.

### Phase 4 — conditional runtime service

Only after a measured static limitation:

- approve D1 ADR;
- add Worker read API;
- preserve static page/backlink fallbacks;
- add rate limits, runtime monitoring, cost budgets, and failure drills.

## 25. Launch acceptance criteria

Launch is accepted only when:

- every deployed page is present in the approved public manifest;
- public source, graph, search index, and `dist/` scans find zero private leaks;
- all routes, aliases, headings, redirects, and public assets resolve;
- no unresolved wikilinks remain in public artifacts;
- build and database outputs are deterministic;
- static backlinks match graph edges;
- normal article reading works without JavaScript;
- Pagefind search works for representative Chinese and English queries;
- graph enhancement fails safely to static relationship lists;
- accessibility tests meet WCAG 2.2 AA gates;
- performance budgets pass on representative mobile and desktop profiles;
- CSP is strict and browser console is clean;
- production headers, cache policy, RSS, sitemap, and social metadata are verified;
- local and remote deployed commit/build identifiers are recorded;
- deployment had explicit approval separate from content sync.

## 26. Decision record

### DR-1 — Content authority

**Decision:** The private manifest and deterministic exporter are the authority for public content selection. The public repository never scans the private vault and never infers publication from folder or frontmatter alone.

### DR-2 — Rendering architecture

**Decision:** Astro static generation is the baseline. Svelte is restricted to interactive islands. Core reading and backlinks remain static HTML.

### DR-3 — Search

**Decision:** Pagefind is the launch search system. Graph SQLite is not used as a replacement search engine initially.

### DR-4 — Relationship storage

**Recommended decision:** Launch with a content-addressed static SQLite artifact loaded on demand into SQLite WASM in a dedicated Worker, with static HTML/JSON fallback.

### DR-5 — D1

**Recommended decision:** Do not use D1 at launch. Introduce it only through an approved Worker API after a measured static limitation. Direct browser access to D1 is prohibited.

### DR-6 — Runtime features

**Decision:** No comments, authentication, analytics, or mutable public state at launch.

## 27. Owner decision frontier

The requirements can proceed with the recommended defaults, but these decisions affect implementation sequencing.

### Q1 — Relationship-store launch mode

Choose one:

- **Recommended:** static SQLite + SQLite WASM Worker, with D1 deferred;
- static JSON adjacency first, SQLite WASM later;
- D1 Worker API at launch despite added runtime complexity.

### Q2 — Public information architecture

Choose one:

- **Recommended:** curated collections independent of private folder structure;
- mirror selected Garden folders publicly;
- flat note namespace with tags only.

### Q3 — Publishing cadence

Choose one:

- **Recommended:** owner-triggered reviewed releases;
- scheduled publication of already-approved manifest entries;
- every merge to public main deploys automatically after gates.

### Q4 — URL and deletion policy

Choose one:

- **Recommended:** stable Public IDs, mutable slugs with permanent redirects, tombstone for intentional withdrawal;
- immutable slugs;
- removal returns 404 with no tombstone.

### Q5 — Feature scope for first public launch

Choose one:

- **Recommended:** P0 static reader + search + previews + static backlinks; local graph ships in Phase 2;
- include SQLite local graph in first launch;
- minimal reader/search only.

### Q6 — Visual direction

Choose one:

- **Recommended:** bespoke calm knowledge-garden design using Quartz only as a feature benchmark;
- visually Quartz-like;
- documentation-product aesthetic closer to Starlight.

### Q7 — Public languages

Choose one:

- **Recommended:** mixed zh-CN/English content with per-document language metadata and one navigation language initially;
- bilingual navigation from launch;
- zh-CN-only or English-only public surface.

### Q8 — Analytics and feedback

Choose one:

- **Recommended:** no analytics/comments at launch;
- privacy-preserving aggregate analytics;
- Giscus comments or another external feedback system.

## 28. Primary-source baseline

The detailed fact/recommendation separation and pinned source inventory lives in [`docs/research/publisher-platform-primary-source-evidence.md`](research/publisher-platform-primary-source-evidence.md).

Accessed 2026-08-06:

- Quartz v5 documentation and repository, pinned baseline commit `74b3fc9efd0caafea3dbcd846ddf1f06855b6d2a`: <https://github.com/jackyzha0/quartz/tree/v5>
- Quartz v5 feature list: <https://github.com/jackyzha0/quartz/blob/v5/docs/features/index.md>
- Astro islands architecture: <https://docs.astro.build/en/concepts/islands/>
- Astro Svelte integration: <https://docs.astro.build/en/guides/integrations-guide/svelte/>
- Astro Cloudflare integration: <https://docs.astro.build/en/guides/integrations-guide/cloudflare/>
- Cloudflare Astro deployment guidance: <https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/>
- Cloudflare D1 overview: <https://developers.cloudflare.com/d1/>
- Cloudflare D1 limits: <https://developers.cloudflare.com/d1/platform/limits/>
- SQLite WASM documentation: <https://sqlite.org/wasm/doc/trunk/index.md>
- SQLite WASM persistence and OPFS constraints: <https://sqlite.org/wasm/doc/trunk/persistence.md>
- Pagefind documentation: <https://pagefind.app/docs/>

## 29. Handoff checklist for the dedicated project

- [ ] Copy this document into the dedicated project as a versioned requirements baseline.
- [ ] Add project-specific `AGENTS.md` pointing to this document.
- [ ] Resolve the owner decision frontier.
- [ ] Create a context glossary only if implementation introduces additional domain terms.
- [ ] Record ADRs for the selected relationship store and deployment runtime.
- [ ] Convert each P0 capability and acceptance gate into implementation tickets.
- [ ] Preserve the three approval boundaries: infrastructure, item-level content, deployment.
- [ ] Do not begin deployment work until the project has an approved public domain and hosting target.
