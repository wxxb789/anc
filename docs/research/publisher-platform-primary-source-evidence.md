# Publisher platform primary-source evidence memo

**Question.** What capabilities and constraints are documented for a Quartz-v5-like public knowledge publisher built with Astro and Svelte, rendered static-first, with relationships/backlinks supplied either by Cloudflare D1 or by a CDN-delivered SQLite database queried in the browser through SQLite WASM?

**Access date:** 2026-08-06  
**Evidence policy:** “Documented facts” below are claims made by official documentation or first-party source repositories. “Design recommendations” are deductions for this publisher and are not claims made by those projects. No private Thoughtscape content was inspected or included.

## Executive finding

A fully static baseline is not only feasible; it most closely matches Quartz v5 itself. Quartz v5 builds a static content index containing each page’s outgoing links, renders backlinks by reversing those links, and lets graph/search clients consume a generated static JSON index. Astro can reproduce that shape with build-time content collections, static routes, and selectively hydrated Svelte islands.

D1 and browser SQLite should therefore be treated as **optional relationship-query backends**, not prerequisites for page publication:

1. **Recommended default:** compute an edge table at build time, render each page’s backlinks into HTML, and emit versioned static graph artifacts.
2. **Use D1** when relationships must update independently of a site rebuild, when query payloads must remain small regardless of total graph size, or when server-side policy/observability is required. D1 requires a Worker/Pages Function or equivalent server runtime; it is not a direct static-browser binding.
3. **Use SQLite WASM** when the whole public relationship dataset may be downloaded to the browser and richer local SQL is worth the payload, memory, initialization, and compatibility costs. Keep it a progressive enhancement; the official documented simple path downloads the database and deserializes it in full.

## 1. Quartz v5 reference behavior

### Documented facts

- Quartz describes itself as a static site generator. Its build pipeline globs content, parses Markdown through text/Markdown/HTML transformations, filters content, and runs emitters that write files. Page HTML is statically rendered. Quartz v5’s plugin categories include transformers, filters, emitters, page types, and Bases views. [Q1]
- The documented feature baseline includes Obsidian-flavored Markdown, wikilinks, transclusions, search, local/global graph views, backlinks, explorer, breadcrumbs, table of contents, tag/folder listings, popover previews, RSS, private-page filtering, SPA routing, syntax highlighting, math, diagrams, comments, social images, and i18n. [Q2]
- The v5 `ContentIndex` emitter writes `static/contentIndex.json`. Its first-party source defines per-page records containing `slug`, `filePath`, `title`, outgoing `links`, `tags`, and text `content`; it also emits RSS and a sitemap. [Q3]
- The v5 backlinks component computes incoming links from build data by selecting files whose outgoing `links` contain the current slug. It excludes `unlisted` files. Backlinks are therefore derivable and renderable during the static build; Quartz does not require a runtime database for this feature. [Q4]
- Quartz’s graph plugin loads the static content index in the browser, creates edges from each record’s outgoing links, and derives a local neighborhood or global graph client-side. The feature docs define the local graph as incoming and outgoing notes at most one hop away; the global graph shows all notes and links. [Q5][Q6]
- Search is powered by FlexSearch and requires the content-index emitter. Quartz documents separate title/content/tag indexes and Markdown-stripped text. [Q7]
- Quartz’s optional SPA routing intercepts navigation, fetches the destination HTML with `GET`, and morphs the current DOM; it is an enhancement over generated HTML, not a server-rendering requirement. [Q8]

### Design implications / recommendations

- Treat Quartz as a **product-capability reference**, not an architectural requirement to add a database. Its current backlink and graph implementation establishes that static artifacts are sufficient.
- Define one canonical build graph (`nodes`, directed `edges`) after slug/alias/link resolution. Derive prerendered backlinks, graph artifacts, orphan/broken-link reports, and search metadata from that same graph to prevent semantic drift.
- Preserve a no-JavaScript reading path: page body, navigation, and backlinks should be present in static HTML. Use Svelte only for interactive search, graph, popovers, filters, or SPA-style transitions.
- Make SPA navigation optional and progressively enhanced; normal anchors and direct page URLs remain authoritative.

## 2. Astro and Svelte fit

### Documented facts

- Astro’s `output: 'static'` prerenders pages by default and can produce a completely static site when no route opts out. `output: 'server'` makes server rendering the default. Astro also supports a mostly-static site with selected routes declaring `export const prerender = false`, provided a server adapter is installed. [A1][A2]
- In default static output, dynamic routes must enumerate pages with `getStaticPaths()`. Astro’s content-collection guidance explicitly shows `getCollection()` inside `getStaticPaths()` for an entirely static, prerendered site. [A3][A4]
- Build-time content collections support local Markdown/MDX/Markdoc/YAML/TOML/JSON and custom loaders for remote data. Collections provide schemas, validation, typed query APIs, and cached build-time storage; Astro says they are suitable for tens of thousands of entries. [A4]
- Framework components render as static HTML by default and send no framework JavaScript. A `client:*` directive controls hydration; documented choices include `client:load`, `client:idle`, `client:visible`, `client:media`, and `client:only`. [A5]
- The official `@astrojs/svelte` integration currently enables rendering and client-side hydration for Svelte 5 components. The integration docs show `npx astro add svelte`. [A6]
- Astro requires an adapter for on-demand routes. Cloudflare’s Astro guide states that SSR runs on Pages Functions and that Cloudflare bindings are available from the Cloudflare runtime in Astro middleware/components/API routes. [A2][C3]

### Design implications / recommendations

- Use Astro build-time collections as the publication boundary: validate frontmatter, normalize slugs, resolve aliases/wikilinks, and reject or report broken references before route generation.
- Use a catch-all static route such as `[...slug].astro` whose `getStaticPaths()` is generated from the validated public collection.
- Render content, metadata, canonical links, breadcrumbs, table of contents, and backlinks in Astro. Hydrate bounded Svelte islands for search and graph rather than hydrating the page shell.
- If D1 is selected, keep content pages prerendered and add only a narrow on-demand API route (or separate Pages Function/Worker). This preserves static availability while introducing runtime dependence only for the enhanced relationship query.

## 3. Cloudflare D1 option

### Documented facts

- D1’s Worker Binding API executes SQL from a Worker after the database is bound to that Worker. In Pages, the D1 binding is available to **Pages Function** code through `context.env`; Cloudflare’s example calls `context.env.NORTHWIND_DB.prepare(...)`. [D1][D2]
- Therefore, the documented binding surface is server runtime code, not arbitrary browser JavaScript. Cloudflare also offers a REST API, but its operations require scoped API tokens; that is an administrative/server integration, not a credential-free public browser query mechanism. [D1][D4]
- Current limits include: 10 GB per paid database / 500 MB Free; 1,000 D1 queries per paid Worker invocation / 50 Free; 2 MB maximum row/string/BLOB; 100 KB SQL statement; 100 bound parameters; and 30 seconds maximum SQL query duration. Each D1 database processes queries one at a time; excessive concurrency is queued and can return an overloaded error. A Worker invocation may open up to six simultaneous D1 connections. [D3]
- Without read replication, requests go to one primary database location. With read replication enabled, replicas are asynchronous and may be out of date. Cloudflare requires the Sessions API to use replicas and documents sequential consistency within a session; `first-primary` starts from the latest primary version, while bookmarks let a later session start at least as fresh as an earlier one. Writes still go to the primary. [D4]
- A Cloudflare Pages project can combine static assets and Functions. Pages Function requests count against Workers quotas. Current Pages limits include a 20-minute build timeout, 20,000 files on Free / 100,000 on paid plans, and 25 MiB maximum per static asset. [C1]

### Design implications / recommendations

- **Do not expose D1 credentials or an administrative API token to the browser.** Put a narrow read endpoint in a Worker/Pages Function, e.g. `GET /api/backlinks/:slug` and optionally `GET /api/neighborhood/:slug?depth=1`.
- Suggested public graph schema: `nodes(slug PRIMARY KEY, title, url, updated_at, build_id)` and `edges(source_slug, target_slug, kind, build_id, PRIMARY KEY (...))`, with indexes beginning on `target_slug` for backlinks and `source_slug` for outgoing links.
- Keep API queries indexed, bounded, and paginated. Avoid constructing large `IN (...)` lists because D1 permits 100 bound parameters per query.
- Publish a `build_id`/content version in both static HTML and D1 rows. During deployment, load a new version and switch an active-version pointer only after all rows are present; this avoids pages and relationships from different builds being mixed.
- Enable read replication only after measuring global API latency. If enabled, carry a D1 bookmark per browser session when read-after-update semantics matter; otherwise accept explicitly documented snapshot staleness for public backlinks.
- D1 is the stronger option when graph data changes outside publication builds, the full graph is too large to ship, or server-side rate limiting and telemetry matter. It weakens the “works on any static host” property and adds runtime cost/failure modes.

## 4. CDN-delivered SQLite + official SQLite WASM option

### Documented facts

- SQLite’s official WASM project targets modern WASM-capable browsers. The official npm subproject is browser-side only; npm is used by build tooling, not to add Node runtime support. [S1][S2]
- The canonical distribution is typically `sqlite3.js`/`sqlite3.mjs` plus `sqlite3.wasm`. Each JavaScript thread that loads it has an independent WASM runtime. SQLite documents direct use from either the main thread or a Worker. [S3]
- SQLite warns that long-running main-thread operations prevent UI rendering and generally recommends running nontrivial work in a Worker. As of 2026-04-15, the packaged Worker1/Promiser “remote control” APIs are deprecated and actively discouraged for non-toy software; the recommended direction is to load and use the library directly in the chosen thread. [S4][S5]
- The official C-style API documentation gives an explicit remote-database example: `fetch('my.db')`, read the response as an `ArrayBuffer`, copy it into WASM memory, and call `sqlite3_deserialize()`. With no resize/free-on-close flags, SQLite describes this as a fixed-size region where SQLite is a read-only user of client-owned memory. [S6]
- That documented path downloads the database into an `ArrayBuffer` and then copies it into WASM memory. It is not an official transparent HTTP range-query VFS. The official project index lists `sqlite-wasm-http` as a third-party read-only HTTP VFS, not as part of SQLite’s core API. [S1][S6]
- For persistence, official SQLite WASM supports browser storage VFSes. OPFS is Worker-only. `OpfsDb.importDb()` can import a `Uint8Array`/`ArrayBuffer`, and since SQLite 3.44 can accept chunks from a callback. Imported WAL databases are forced out of WAL mode because the documented OPFS/WAL combination has severe concurrency restrictions. [S7][S8]
- The standard `opfs` VFS needs `SharedArrayBuffer`, which requires `Cross-Origin-Embedder-Policy: require-corp` (or context-dependent `credentialless`) and `Cross-Origin-Opener-Policy: same-origin`. SQLite documents `opfs-sahpool` as an alternative for applications unable to set those headers, trading away some concurrency characteristics. Browser private/incognito modes can reduce or remove persistence. [S7]
- Cloudflare Pages can set static response headers with a `_headers` file, but its 25 MiB single-asset limit applies to a SQLite file served as a Pages asset. Cloudflare recommends R2 for larger files. [C1][C2]

### Design implications / recommendations

- Treat a CDN SQLite file as a **public downloadable artifact**. It must contain no private notes, unpublished slugs, secrets, or security-sensitive metadata. SQL access control in the browser is not confidentiality.
- Use an immutable, content-addressed filename such as `graph.<build-id>.sqlite` plus a small manifest. Never overwrite a long-cache database URL in place; this prevents stale HTML, WASM caches, and database bytes from becoming incoherent.
- For the simplest read-only use, fetch and deserialize into an in-memory database in a dedicated application Worker. This avoids OPFS headers and locking but incurs full network transfer plus at least an `ArrayBuffer` and a WASM-side copy during initialization.
- Use OPFS only as an optional local cache when repeat-visit savings justify more code and browser-specific failure handling. It is not required merely to query a downloaded immutable database.
- Gate loading behind an explicit graph action or a delayed/visible Svelte island. Show loading/error states and retain prerendered backlinks when WASM, Worker creation, storage, or the network fails.
- Keep the SQLite artifact comfortably below the host’s single-file limit and establish a product budget based on measured compressed transfer, uncompressed bytes, peak browser memory, and startup/query latency on low-end mobile hardware. If the dataset exceeds the budget, shard static artifacts, move the file to R2, or prefer D1. Note that a single SQLite database cannot be naively sharded without changing query semantics.
- Do not claim partial/range loading with the official vanilla API. That requires a separately selected and validated HTTP VFS; the official docs identify such a solution as third-party.

## 5. Recommended static-first requirements

These are **design recommendations derived from the evidence**, not documented behavior of one upstream project.

### Publication pipeline

1. Ingest only the explicitly public content set.
2. Validate metadata and normalize canonical slugs/aliases before resolving links.
3. Parse Markdown/Obsidian-compatible syntax into a stable intermediate record.
4. Resolve outgoing links and emit diagnostics for broken, ambiguous, duplicate, and unpublished targets.
5. Build the canonical node/edge graph once.
6. Generate static routes, canonical HTML, backlinks, RSS, sitemap, search artifacts, and graph artifacts from the same build graph.
7. Stamp every artifact with a content/build version and deploy atomically.

### User-facing baseline

- Direct URLs, ordinary anchor navigation, readable content, page title/description/canonical metadata, and backlinks work with JavaScript disabled.
- Search, local/global graph, popovers, filters, and SPA-style transitions are progressive Svelte islands with keyboard and reduced-motion behavior.
- A local graph includes incoming and outgoing neighbors; a global graph is lazy-loaded and protected by node/edge/render budgets.
- Public/private filtering happens before any HTML, JSON, D1 import, or SQLite snapshot is emitted.

### Relationship-backend acceptance criteria

| Criterion | Static generated artifacts | D1 API | SQLite WASM snapshot |
|---|---|---|---|
| Static-host portability | Best | Reduced: needs Worker/Function | Good, subject to WASM/Worker support |
| Backlinks in initial HTML | Yes | Only if build also embeds them | Only if build also embeds them |
| Freshness without rebuild | No | Yes | Requires publishing a new snapshot/manifest |
| First-load data transfer | Small if split/prerendered | Query-sized | Whole DB on official simple path |
| Offline/repeat visit | Normal HTTP cache | Network endpoint required | HTTP cache; optional OPFS |
| Server operations/cost | None | D1 + Workers quotas/monitoring | None after asset publication |
| Data confidentiality | Artifacts are public | Endpoint can enforce policy | Entire DB is public |
| Query flexibility | Precomputed shapes | Server SQL | Rich local SQL |
| Failure isolation | Strongest | Runtime API can fail | WASM/Worker/download can fail |

### Decision rule

- Choose **static artifacts** unless a measured requirement disproves them.
- Add **SQLite WASM** for client-side graph exploration when the complete public graph fits the transfer/memory/startup budget and local SQL materially simplifies required interactions.
- Add **D1** when freshness, dataset size, server-controlled query policy, or centralized observability outweigh static-host portability.
- Regardless of backend, continue to prerender the ordinary backlink list. Neither D1 nor WASM should be on the critical path for reading a published note.

## 6. Risks and questions to carry into the design document

- What exact Quartz-compatible syntax is in scope: wikilinks, aliases, block/heading transclusion, embeds, tags, callouts, Canvas, Bases, citations, or only a subset?
- Is relationship data immutable between publication builds, or can an external system update it independently?
- What are the maximum node/edge counts and serialized database size at launch and at a three-year horizon?
- What are the mobile budgets for initial JavaScript, WASM, database transfer, peak memory, and time-to-interactive?
- Must the publisher remain deployable to GitHub Pages/Netlify/Vercel without a Cloudflare runtime? If yes, D1 must remain optional or be hidden behind a portable API contract.
- Are backlinks/graph required to expose only published pages, and how are links to filtered/private pages represented without leaking their existence?
- What consistency contract is acceptable during deployment: build-snapshot consistency, eventual freshness, or read-after-publish?
- Are third-party CDN scripts acceptable? Quartz’s current graph plugin loads D3 and PixiJS from jsDelivr, but a dedicated publisher may choose self-hosting and a stricter CSP/supply-chain policy. [Q5]

## Primary-source list

All sources accessed 2026-08-06.

### Quartz v5

- **[Q1]** Quartz v5 architecture, official repository at inspected commit `74b3fc9efd0caafea3dbcd846ddf1f06855b6d2a`: <https://github.com/jackyzha0/quartz/blob/74b3fc9efd0caafea3dbcd846ddf1f06855b6d2a/docs/advanced/architecture.md>
- **[Q2]** Quartz v5 feature list: <https://quartz.jzhao.xyz/features/>
- **[Q3]** Quartz community content-index emitter, first-party v5 plugin source at inspected commit `1342d1eacfdabbcefa2c6a26f8346945a9d9860f`: <https://github.com/quartz-community/content-index/blob/1342d1eacfdabbcefa2c6a26f8346945a9d9860f/src/emitter.ts>
- **[Q4]** Quartz community backlinks component at inspected commit `cb445dcc3f6969e4088bb0ff4254ba59071e4243`: <https://github.com/quartz-community/backlinks/blob/cb445dcc3f6969e4088bb0ff4254ba59071e4243/src/components/Backlinks.tsx>
- **[Q5]** Quartz community graph client at inspected commit `411971434ab698c495dfc42870eb02d3bc539b3a`: <https://github.com/quartz-community/graph/blob/411971434ab698c495dfc42870eb02d3bc539b3a/src/components/scripts/graph.inline.ts>
- **[Q6]** Quartz v5 graph-view docs: <https://quartz.jzhao.xyz/features/graph-view>
- **[Q7]** Quartz v5 full-text-search docs: <https://quartz.jzhao.xyz/features/full-text-search>
- **[Q8]** Quartz v5 SPA-routing docs: <https://quartz.jzhao.xyz/features/spa-routing>

### Astro and Svelte

- **[A1]** Astro configuration reference (`output`): <https://docs.astro.build/en/reference/configuration-reference/#output>
- **[A2]** Astro on-demand rendering: <https://docs.astro.build/en/guides/on-demand-rendering/>
- **[A3]** Astro routing and `getStaticPaths()`: <https://docs.astro.build/en/guides/routing/#static-ssg-mode>
- **[A4]** Astro content collections: <https://docs.astro.build/en/guides/content-collections/>
- **[A5]** Astro framework components and hydration: <https://docs.astro.build/en/guides/framework-components/>
- **[A6]** Official Astro Svelte integration: <https://docs.astro.build/en/guides/integrations-guide/svelte/>

### Cloudflare D1 and deployment

- **[D1]** D1 Worker Binding API: <https://developers.cloudflare.com/d1/worker-api/>
- **[D2]** Pages Function bindings, D1 section: <https://developers.cloudflare.com/pages/functions/bindings/#d1-databases>
- **[D3]** D1 limits and concurrency: <https://developers.cloudflare.com/d1/platform/limits/>
- **[D4]** D1 global read replication and Sessions API: <https://developers.cloudflare.com/d1/best-practices/read-replication/>
- **[C1]** Cloudflare Pages limits: <https://developers.cloudflare.com/pages/platform/limits/>
- **[C2]** Cloudflare Pages static response headers: <https://developers.cloudflare.com/pages/configuration/headers/>
- **[C3]** Cloudflare Pages Astro deployment/runtime guide: <https://developers.cloudflare.com/pages/framework-guides/deploy-an-astro-site/>

### Official SQLite WASM

- **[S1]** SQLite WASM documentation index: <https://sqlite.org/wasm/doc/trunk/index.md>
- **[S2]** Official SQLite WASM npm guidance: <https://sqlite.org/wasm/doc/trunk/npm.md>
- **[S3]** SQLite WASM API loading and thread/runtime model: <https://sqlite.org/wasm/doc/trunk/api-index.md#loading>
- **[S4]** SQLite WASM three-step browser demo and main-thread warning: <https://sqlite.org/wasm/doc/trunk/demo-123.md>
- **[S5]** SQLite WASM Worker1/Promiser status and constraints: <https://sqlite.org/wasm/doc/trunk/api-worker1.md>
- **[S6]** SQLite WASM `sqlite3_deserialize()` remote-database example: <https://sqlite.org/wasm/doc/trunk/api-c-style.md#sqlite3_deserialize>
- **[S7]** SQLite WASM persistence, OPFS, headers, and locking: <https://sqlite.org/wasm/doc/trunk/persistence.md>
- **[S8]** SQLite WASM `OpfsDb.importDb()`: <https://sqlite.org/wasm/doc/trunk/api-oo1.md#opfsdbimportdb>
