# Quartz v5 Parity and Superset Plan

**Status:** Active planning baseline
**Document type:** Competitive analysis + revised backlog
**Derived from:** a read of Quartz v5 at commit `74b3fc9` (`Q:/repos/quartz`), an audit of this repository, and three adversarial review passes over the resulting proposals
**Describes:** `main` at `04f8d9c`, 210 tests passing
**Supersedes:** the ticket ordering in [`p0-implementation-tickets.md`](p0-implementation-tickets.md), which remains canonical for TK-01 through TK-10 scope text

## 1. Verdict

The foundation is ahead of Quartz in the two dimensions hardest to retrofit, and both are
structural rather than a matter of effort. First, a hard artifact boundary with
corpus-level invariants: `checkCorpus` proves backlinks are the exact inverse of outgoing
across the whole corpus and fails the build otherwise, while Quartz records an edge whether
or not the target exists — measured on its own site, 72 of 492 outgoing edges dangle, 14.6%,
silently dropped at render. Second, a Content-Security-Policy posture Quartz cannot reach:
it emits an inline `contentIndex.json` fetch on every page, a second inline script on its
404, and eleven analytics providers as inline strings, so `script-src 'self'` is not
available to it at any configuration. Alongside those: privacy fails closed here and open
there — Quartz's own documentation states that every non-Markdown file is emitted publicly
regardless of filtering, so a `draft: true` note still publishes the images it embedded.
Total shipped JavaScript is 1,067 B gzip plus a 605 B theme script, against roughly 41.8 KB
gzip of scripts per article plus a 78 KB gzip content index fetched on first paint.

The reader-facing surface is behind, and honestly so. Roughly 15% of the feature surface is
built, and all of it is validated against a corpus of one note with two empty arrays — so
`recentFirst` has never sorted two entries, the backlinks aside has never rendered, and
`facets()` has never produced a page. Search has never run in production at all: our own
`script-src 'self'` blocks Pagefind's WebAssembly. The pipeline emits nine classes the
stylesheet does not style, so syntax highlighting currently renders as undifferentiated
plain text. Math and diagrams render as escaped source. Seven capabilities in the parity
matrix have no owner, and one of them — `/graph/` — is listed in the requirements.

The shortest path to winning overall is three moves, in order. Fix what is already
shipping wrong (TK-12), because those defects are small deletions that block later work and
one of them means the search feature has never executed. Build a realistic corpus (TK-11),
because every layout claim in this repository is currently unfalsified and every week of
delay adds more code written against an artifact shape nobody has seen. Then build the two
things that make this a superset rather than a tidier equal: a graph that is real HTML
(TK-17) and a measured benchmark that converts "faster" from a preference into a claim
(TK-18). Everything else on the board is parity work, correctly scoped — and parity work
alone cannot produce a superset.

---

## 2. Feature parity matrix

Every Quartz v5 capability in the 36-entry inventory, against what this repository actually ships at `04f8d9c`. Two entries were audited twice by different agents (i18n, SPA routing) and are merged here, leaving 34 rows. Status reflects code on `main`, not intent: a capability whose data is computed but never rendered is *planned*, not built.

| Quartz capability | Their approach | Our status | Verdict |
| --- | --- | --- | --- |
| Graph view (local + global) | d3 + PixiJS from jsDelivr, canvas-only, driven by an inline `fetchData` promise | **built (TK-17)** — inline SVG with real `<a>` elements laid out at build time, on `/notes/<slug>/` and `/graph/`. Works with JavaScript disabled, median 975 B gz per page, deterministic across builds, edge direction by line shape rather than colour, and an equivalent table naming both ends of every drawn edge | we win |
| Content index / relationship artifact | one `contentIndex.json` carrying full plaintext per page, shared by graph, search, explorer, 404 | **built** — `public/content-index.json`, 404 B, `{slug,title,excerpt}` only, byte-compared against the artifact at `scripts/validate-content.ts:36` | we win |
| Backlinks panel | build-time `allFiles.filter(f => f.links.includes(slug))` into static `<ul>`, zero JS | **built** — static list at `src/pages/notes/[slug].astro:28-38`; context snippets, empty state, and sort order are TK-05 | parity |
| Popover previews | `mouseenter` → fetch whole page → `DOMParser` → lift `.popover-hint`, positioned by @floating-ui | **built** — `src/scripts/link-preview.ts`, hover-only, no delay, no keyboard, caches a rejected promise at `:28`; TK-07 owns the rewrite | we lose |
| Wikilink parsing and link resolution | micromark tokenizer + `CrawlLinks` hast pass emitting real `<a href>` and the edge set | **built** — exporter resolves wikilinks; TK-03 rewrites `/<slug>/` → `/notes/<slug>/` via the injected `routeForSlug`, and `wikilinks: false` at `src/lib/markdown.ts:121` is deliberate | parity |
| Explorer (file tree sidebar) | client-side trie rebuilt from `contentIndex.json`, `new Function()` for the sort comparator | **gap** — no collection tree exists; owner decision 1 puts rails in scope but names no tree | we lose |
| SPA routing | click interception + micromorph DOM diffing, `<route-announcer>` with an inline `style` | **skipped** — requirements §8.3 defers it; ordinary navigation is the baseline | skipped by design |
| Table of contents | build-time mdast heading walk, server-rendered `<ol>`, 507 B scroll-spy enhancement | **built (TK-05a)** — real nested `<ol>` from `RenderedNote.toc`, complete in the server HTML, collapse via native `<details>`, zero JavaScript. Links measure 6.72:1 / 10.37:1 against Quartz's 2.04:1 / 2.92:1 | we win |
| Breadcrumbs | filesystem trie `ancestryChain`, server-rendered, zero JS | **built (TK-05a)** — `Home / Notes / <collection>? / <title>`, public fields only, current page `aria-current="page"`. One flat collection level; the tree is TK-05c | parity |
| Folder and tag listings | auto-generates a page per folder and per hierarchical tag prefix | **built (TK-04)** — `/tags/`, `/tags/<tag>/`, `/collections/`, `/collections/<slug>/` derived only from artifact fields, never from folders; no hierarchical tag expansion | parity |
| Recent notes | sorts `allFiles` by git-derived mtime, dated above undated, title tiebreak | **built (TK-04)** — `/recent/` with `updated ?? created` and a documented alphabetical fallback (`src/lib/routes.ts:170`); no sidebar variant | parity |
| Full-text search | FlexSearch built in the browser from the whole-corpus JSON, 26 KB gz on every page | **planned (TK-06)** — the CSP block is fixed (TK-12 added `'wasm-unsafe-eval'`, and a query now returns a result in a real browser under the shipped policy), but `src/scripts/search-dialog.ts` still injects the deprecated Default UI at 30,211 B gz where the modular UI is 4,244 B gz | we lose |
| RSS feed + sitemap | template-literal XML concatenation, CDATA plus manual escaping, build-time | **built (TK-08)** — a hand-written Atom 1.0 feed and a sitemap, both byte-identical across consecutive builds, with `robots.txt` naming the sitemap. Zero new dependencies | we win |
| Social preview images | satori + sharp per page, 22 npm packages, fonts fetched at build time | **built (TK-08)** — deterministic Open Graph and Twitter metadata on every route, plus one static default card. Per-page generated images deliberately skipped: satori and sharp are 22 packages and a native dependency this project has otherwise avoided | parity |
| i18n (UI chrome, 30 locales, RTL) | typed `Translation` contract, `as const satisfies`, one global `locale`, resolved at build time | **gap** — per-document `<html lang>` is built (TK-02, `Layout.astro:29`), but every chrome string is hardcoded English; constraint 6 requires bilingual chrome | we lose |
| Comments (Giscus) | cross-origin `client.js` + iframe into GitHub Discussions | **skipped** — constraint 2 forbids it, and a Discussions thread is a second unreviewed publication surface | skipped by design |
| Syntax highlighting | Shiki/TextMate at build time plus a scope→class token classifier; inline-script copy button | **built** — Prism at build time with `token-*` classes; the localized copy control is inserted only at runtime, so no dead no-JS button or copy chrome enters Pagefind. Shiki remains rejected because its inline `style` attributes need `style-src 'unsafe-inline'` | we win |
| Callouts | 13 types over 25 aliases, mask-image icons, collapsible via a 335 B script writing inline styles | **built (TK-03)** — `calloutPlugin` at `src/lib/markdown.ts:328` emits `data-callout` + `callout-<kind>`, with no alias map, no icons, no collapse, and no CSS | we lose |
| LaTeX / math | remark-math into KaTeX/MathJax/Typst; KaTeX path pulls CSS and a script from jsDelivr | **gap** — `$$…$$` renders as escaped source (`UNHIGHLIGHTED_LANGUAGES`, `src/lib/markdown.ts:138`); owner decision 2 settles on Temml but no ticket owns it | we lose |
| Mermaid diagrams | `mermaid` fences hydrated by a ~500 KB gz ESM bundle from cdnjs, re-rendered on theme change | **gap** — fences ship as escaped code tagged `data-diagram="mermaid"` (`src/lib/markdown.ts:421`); owner decision 5 settles dual-mode but no ticket owns it | we lose |
| Obsidian flavored Markdown surface | `==highlight==`, `%%comment%%`, `![[embed]]`, transclusion, block refs, `#tag`, custom task chars, media embeds | **gap** — only GFM task lists render; `==hi==` passes through literally, and the exporter already destroys `![[…]]` into bare words (D5) | we lose |
| Citations (BibTeX + CSL) | rehype-citation over a `.bib`, locales fetched from raw.githubusercontent at build time | **skipped** — no corpus need, and a `.bib` typically carries unpublished entries | skipped by design |
| Canvas (`.canvas` pages) | Preact SSR of absolutely positioned nodes plus live iframes, resolving arbitrary slugs from `allFiles` | **skipped** — whole-vault assumption breaks constraint 1; per-node inline styles break constraint 3 | skipped by design |
| Bases (`.base` views) | 4,177 lines including a hand-written query language over the whole vault | **skipped** — whole-vault query engine; the useful subset is the exporter emitting a precomputed collection | skipped by design |
| Darkmode / theme toggle | render-blocking `prescript.js` sets `saved-theme`; nothing works with JS off | **built (TK-02)** — `light-dark()` under `@supports` in `src/styles/tokens.css:59` honours the OS preference at zero JS; the override is an external `theme-init.js?url` | we win |
| Reader mode | 490 B prescript flipping an attribute, six lines of CSS, not persisted, dead button with JS off | **built (TK-02)** — `:root[data-reader='on']` at `src/styles/global.css:466`, persisted, and the button is hidden without JS via `[data-js-only]` (`:105`) | we win |
| Private pages — filters and `ignorePatterns` | opt-out `draft:`/opt-in `publish:` frontmatter plus a globby ignore list, fail-open on assets | **built (TK-01)** — allowlist manifest outside the repo, exporter-produced artifact, and privacy invariants enforced at `src/lib/schema.ts:95` | we win |
| Private pages — `unlisted` | one frontmatter boolean that eight independent plugins each promise to honour | **gap** — `status` accepts only `published`/`tombstone` (`src/lib/schema.ts:23`); no published-but-unlisted state exists | we lose |
| Private pages — encrypted pages | AES-256-GCM ciphertext of the rendered HTML shipped to the CDN, decrypted in the browser | **skipped** — requirements §8.3 defers it, and it needs inline script plus `innerHTML` | skipped by design |
| Docker support | two-stage Dockerfile running `quartz build --serve`, documented as dev-only | **skipped** — `pnpm run preview` is one command; a pinned sync-time image for the diagram toolchain is a separate question | skipped by design |
| Roam Research compatibility | `findAndReplace` over mdast emitting raw HTML nodes, including YouTube iframes | **skipped** — one source vault, one exporter; raw HTML would not survive the TK-03 allowlist anyway | skipped by design |
| OxHugo compatibility | seven `String.replaceAll` passes over raw source, and turns on `rehype-raw` pipeline-wide | **skipped** — same, and enabling `rehype-raw` is the inverse of our explicit allowlist | skipped by design |
| Page frames + layout-by-YAML DSL | `frameRegistry` Map, three frame modules, per-component slotting in `quartz.config.yaml`, frame CSS emitted inline | **skipped** — Astro layouts and slots are the registry, typechecked, at zero cost | skipped by design |
| Stacked pages | sliding panes built at runtime, trail encoded in `#stacked=`, disabled below 800 px | **skipped** — requirements §8.2 lists it as a later possibility; second navigation model, not a launch feature | skipped by design |

### Rows marked gap

Seven capabilities had no owner when this audit was taken at `04f8d9c`. Each was a backlog
candidate, not a defect in a shipped ticket. The table is the audit as found; the **Closed
by** column records which ticket has since taken each one, so the snapshot stays readable
as history rather than being rewritten into a status board.

| Gap | What is missing | Governing decision | Closed by |
| --- | --- | --- | --- |
| `/graph/` route | Requirements §9.1 lists it; TK-05 item 7 covers only the per-note list stand-in, and no ticket emits a site-wide graph route | Constraint 5 forces a static, `<a>`-bearing representation; a canvas island can only be an enhancement | **TK-17** `7dfd94f` |
| Collection tree / explorer | No build-time `<nav>` of the collection hierarchy exists on any page | Owner decision 1 puts rails in scope; native `<details>`/`<summary>` gives collapse at zero JS | **TK-05c** `e002113` |
| Bilingual chrome strings | `Layout.astro` hardcodes English for the skip link, nav, and all three toggles; `NoteList.astro` and every facet page do the same | Constraint 6; the resolution key is per-document `entry.language`, not one site locale | **TK-16** `410aad2` |
| Math rendering | `$$…$$` renders as escaped source with `math-inline`/`math-display` classes that have zero CSS | Owner decision 2 (Temml, prerendered MathML, ~9 KB CSS + 9.4 KB woff2) is settled but unticketed | **TK-15** `116b15c` |
| Mermaid rendering | Fences render as escaped code tagged `data-diagram="mermaid"` | Owner decision 5 (dual-mode, client-side default) is settled but unticketed; TK-02's zero-inline-style `dist/` gate must become mode-aware | **TK-15** `116b15c` |
| Obsidian syntax surface | `==highlight==` and image embeds do not render; the exporter destroys `![[…]]` before the repo sees it | Split decision — highlight is a TK-03 plugin; embeds require an exporter fix this repo cannot make | open |
| Published-but-unlisted state | No artifact field and no listing-surface contract; `status` admits only `published`/`tombstone`, and the `tombstone` shape cannot currently be produced (`checkCorpus` rejects it whenever a live note links in) | Needs a TK-01 schema field plus one test enumerating every listing surface, or an explicit decision not to have the state | open |

---

## 3. Where we win by design

These are advantages that fall out of the architecture rather than out of effort. Each
is anchored to a file in one of the two repositories. Quartz costs are measurements
someone took, not estimates.

### 3.1 The wins that hold

| # | Win | Our mechanism | Quartz's measured cost |
| --- | --- | --- | --- |
| W1 | **Strict CSP is reachable, and enforced by test** | `astro.config.mjs:16` pins `assetsInlineLimit: 0` as a security control naming the test that fails if it moves; `tests/built-output.test.ts:69,81,96,105` gate inline script, non-origin script, inline handlers, inline style | Quartz cannot run under `script-src 'self'` at all. `renderPage.tsx:75` builds `const fetchData = fetch(".../contentIndex.json")` and `renderPage.tsx:93` pushes it as `contentType: "inline"` on **every page**; `pages/404.tsx:13` adds a second ~40-line inline script; `componentResources.ts:93-259` injects eleven analytics providers as inline strings, three of which set `script.innerHTML`. Nor `style-src 'self'`: `renderPage.tsx:350` emits inline `<style>` per frame |
| W2 | **Privacy fails closed** | Nothing enters the repo that is not in the manifest. `checkPrivacy` (`src/lib/schema.ts:219-241`) walks every string reachable in an entry via an iterative generator and scans four normalizations — raw, entity-decoded, invisible-stripped, URL-whitespace-stripped — so `msw<ZWJ>/x` and `java\tscript:` are caught. `src/lib/content.ts:15` runs `validateArtifact` at module evaluation, so a violation fails `astro build`, not a lint | Quartz fails open. Its own docs: *"Regardless of the filter plugin used, all non-markdown files will be emitted and available publically in the final build."* `plugins/emitters/assets.ts` globs `**` minus `**/*.md` minus `ignorePatterns` and copies the remainder. `draft: true` on a note still publishes every image, PDF and voice memo it embedded |
| W3 | **Corpus-level invariants, checked** | `checkCorpus` (`src/lib/schema.ts:350-393`) proves backlinks are the exact inverse of outgoing across the whole corpus, that aliases do not collide with other entries' slugs, no self-links, both arrays sorted and duplicate-free. Violations name both slugs and fail the build | CrawlLinks records an edge regardless of whether the target exists. Measured on the live `quartz.jzhao.xyz` (122 pages): 492 outgoing edges, 420 resolve, **72 (14.6%) dangle**, silently dropped at render. Slug collisions are a `console.warn` at `build.ts:29`, last file wins |
| W4 | **Zero-JS theming, including dark mode** | `src/styles/tokens.css:59-94` — both palettes declared once with `light-dark()`, switched by one `color-scheme` property. `theme-init.js` is 605 B gz and stays a classic render-blocking script via `?url` (`src/layouts/Layout.astro:3-7`) | Grep for `prefers-color-scheme` and `light-dark(` across `quartz/` returns **zero hits**. Theming is `:root[saved-theme="dark"]`, an attribute set by client JS from `localStorage`. A reader with JS disabled gets light mode only, with no `<noscript>` anywhere in the codebase |
| W5 | **The whole site's JS is smaller than one Quartz component** | Total shipped JS: 1,067 B gz app + 605 B gz `theme-init` | Per-article: ~41.8 KB gz of scripts plus a 78 KB gz `contentIndex.json` fetched by an inline script on first paint. Graph alone: ~525 KB brotli of d3 + PixiJS from `cdn.jsdelivr.net` (and they load the *unminified* `dist/pixi.js`, 2× more bytes than needed), plus 8,508 B gz of inline script of which 27% is a dead Preact VDOM prelude |
| W6 | **The search index cannot contain what was never published** | Pagefind indexes `dist/`, which only ever contained allowlisted pages. It shards: 981 B meta, ~28.9 KB per index chunk, ~1.08 KB per result fragment, and auto-partitions by `<html lang>` (verified: `dist/pagefind/pagefind-entry.json` → `{"languages":{"en":…}}` with no configuration) | `contentIndex.json` ships the full plaintext of every page to every visitor before the first keystroke: 265,450 B raw / 78,017 B gz on Quartz's own 111-file docs corpus. It also carries `filePath`, which leaks the vault's directory layout — `docs\advanced\making plugins.md` was measured sitting in the emitted index |
| W7 | **Math is native MathML, self-hosted, zero JS** | Owner decision: Temml, TeX → MathML prerendered at build time. ~9 KB CSS + 9.4 KB `Temml.woff2`, both same-origin. 13 inline style declarations across 5 element types, extractable to build-time classes | Default path is KaTeX with `output: 'html'`: inline `style` on nearly every span (needs `style-src 'unsafe-inline'`), a 23 KB gz stylesheet **and** webfonts from jsdelivr, plus `copy-tex.min.js` from the same CDN — a third-party request per reader on every page. The plugin's `dist` is 28.9 MB because all three engines ship whether or not you use one |
| W8 | **Diagrams can exist with JS disabled** | Build-time Mermaid renders 23/23 diagram types, deterministic per process, CJK correct, **~1.9 KB gz SVG per diagram** (`.tmp/mermaid-feasibility.md`) | `mermaid.inline.ts` does `await import("https://cdnjs.cloudflare.com/…/mermaid.esm.min.mjs")` — third-party script per reader, ~500 KB gz — and calls `mermaid.initialize` with `securityLevel: "loose"`, which permits HTML in node labels and click directives, fed directly by note content. With JS off the reader sees raw mermaid source and a dead expand button |
| W9 | **The generator is the whole product** | One input file, one gate, one deployment target. No plugin loader, no network at config time | Quartz's largest subsystem is not the site generator. Plugin *infrastructure* is 5,524 lines (`plugins/loader/*.ts`, `cli/plugin-git-handlers.js`) against ~1,500 for the core build. `loadQuartzConfig` (`config-loader.ts:248`) clones git repos, runs `npm install`, runs `npm run build`, and speculatively invokes exported factory functions to guess a plugin's category (`config-loader.ts:557-600`). `gitLoader.ts:532` shell-interpolates a config string into `execSync("git clone …")`. Also shipped to every user who clones: `quartz/util/emojimap.json`, **15,304,987 bytes**, with exactly one importer (`util/emoji.ts`) which itself has zero importers |
| W10 | **The toolchain is already the one the owner specified** | Vite 8.2.0 in tree, whose own dependencies are `rolldown ~1.2.0` and `lightningcss ^1.33.0` (`node_modules/vite/package.json`). Astro 7.1.6 | Quartz is partially Rust/Go-tooled — lightningcss for CSS, esbuild for JS — but has no Vite, no Rolldown, no Vitest, and **no linter at all**: the only config files are `.prettierrc` and `.prettierignore`. Its test runner is `tsx --test` |

### 3.2 Claimed wins that do not survive scrutiny — do not repeat these

| Claim | Why it fails |
| --- | --- |
| "11 direct dependencies versus Quartz's 79" | 45 of Quartz's 79 are first-party `@quartz-community/*` feature packages. We have 11 deps because we have roughly 15% of the features. This is earliness, not restraint |
| "Faster than Quartz" | **Unmeasured.** No Lighthouse run, no LCP/INP/CLS, no build-time comparison. `.tmp/tk-02-report.md:243-248` says so itself about the 320 px criterion. Both repos are on this disk and `Q:/repos/quartz/docs/` is 111 markdown files; until that corpus goes through both pipelines, "faster" is a preference |
| "210 tests passing" as a robustness claim | Roughly 118 test pure functions against synthetic fixtures. Only ~25 (`built-output` 13, `built-routes` 12) touch real built output, and those run against a one-note corpus with zero optional fields |
| "Lightning CSS is idle capacity waiting to be unlocked" | False. Vite's `cssMinify ?? !!minify` path already routes our CSS through Lightning CSS — the built `--color-shadow:#1b1f2424` is the `#RRGGBBAA` shortening only Lightning CSS performs. There is no dormant win here |
| "Lightning CSS lowers our `light-dark()` today" | False. Every `light-dark()` in `src/styles/tokens.css:59` sits inside `@supports (color: light-dark(#000,#fff))`. Nothing lowers unless that guard is deleted **and** `targets` is set, and the two critics who costed it disagree by 543 gz bytes in opposite directions. Treat as unmeasured |
| "Our CSP posture is proven end to end" | The posture is reachable; the shipped policy is wrong. See §4, L1 |

---

## 4. Where we lose today, and the fix for each

Ordered by what it costs us. Each entry names what Quartz does better and the specific
change. Items that are only losses because the corpus is one note are excluded and
collected in §4.2.

| # | Loss | What Quartz does better | Why it matters | Fix |
| --- | --- | --- | --- | --- |
| L1 | **Search does not work under our own CSP** | Quartz's search works. Ours is blocked before it starts | `public/_headers:5` is `script-src 'self'` with no `'wasm-unsafe-eval'`; `dist/pagefind/pagefind.js` contains 3 `WebAssembly.instantiateStreaming` calls and `pagefind-worker.js` one more. TK-06 is not "build search" — it is "search has never run in production" | Add `'wasm-unsafe-eval'` (which is not `'unsafe-eval'` and permits no string-to-code). While in the file: add `font-src`, `worker-src`, `form-action`, and move `base-uri` to `'none'` per `docs/public-knowledge-garden-requirements.md:713-725`. Add the table-driven `_headers` test — `grep -rn "_headers" tests/ scripts/` returns nothing today. **Do not** add a second overlapping rule without `! Header-Name`: Cloudflare joins duplicate headers with a comma, it does not pick the most specific |
| L2 | **The pipeline emits markup the stylesheet does not style** | Quartz ships `syntax.scss`, `callouts.scss`, and per-component CSS for everything its transformers emit | Zero occurrences in `dist/_astro/Layout.uZ0PEUxZ.css` *and* `src/styles/*.css` for `token`/`token-*`, `code-block`, `heading-anchor`, `callout*`, `task-list-item`, `footnotes`, `sr-only`, `math-inline`, `math-display`. Live in the single published note: 21 `token-*` spans, 15 `heading-anchor`, 8 `code-block` render unstyled. Syntax highlighting is currently undifferentiated plain text | One prose stylesheet scoped to the classes that actually ship. `sr-only` is a latent visible-heading a11y bug (satteri emits `<h2 class="sr-only" id="footnote-label">Footnotes</h2>`; the corpus has no footnotes yet) — cheap, include it |
| L3 | **Every search result is polluted** | Quartz's excerpt window slides a 30-word frame to maximize matched-term density, and it scrolls the destination page to the match on arrival. Both are real UX wins | Decompressed `dist/pagefind/fragment/en_4ec3aee.pf_fragment`: `meta.title` is `"Adding a Password to a PFX Certificate on Windows#"`, **15/15** anchors end in `#`, `Copy` appears 8×, and the indexed body *opens* `"← All notes Adding a Password…"` because `src/pages/notes/[slug].astro:25` puts the back-link inside `data-pagefind-body` | Three deletions and a flag: delete the `copy-code` button (`src/lib/markdown.ts:437-441`, plus its entries at `:559` and `:593`) — it is `hidden`, has zero CSS and zero handler; move `← All notes` out of the article; use `pagefind --exclude-selectors` for the heading anchors rather than threading `data-pagefind-ignore` through the renderer |
| L4 | **Page anatomy is absent, and its data is computed and discarded** | Quartz's ToC is its best component: the full list is server-rendered so it works with JS off, and scroll-spy is a 507 B gz `IntersectionObserver` enhancement. Depth normalization against the shallowest heading is a thoughtful touch | `RenderedNote.toc`, `.headings`, `.hasCode`, `.hasMath`, `.hasMermaid` (`src/lib/markdown.ts:46-61`) have **zero consumers** across `src/pages src/components src/layouts src/scripts`. `notes/[slug].astro:16` destructures `{ html }` only. Owner decision 7 — lazy-load per page and per invocation — is gated entirely on wiring these up | Wire them. Render the nested `toc` as real nested `<ol>`, not a flat list with a `depth-N` class. Take Quartz's `legacy` `<details>` mode as the collapse mechanism so collapse costs zero JS. Fix their contrast mistake: their un-read TOC links are 2.04:1 in light and 2.92:1 in dark, both WCAG AA failures in the default state |
| L4a | **Prerequisite: heading anchors are already broken and untested** | — | `sanitize()` consumes generated ids from a one-shot `unusedIds` set in document order, and `a`/`li` are granted `id` in `allowedAttributes` (`src/lib/markdown.ts:539-543`). Raw HTML `<a id="introduction">` before `## Introduction` produces a duplicate id where the deep link, the future ToC entry, and the Pagefind anchor all resolve to the decoy. `grep 'href="#'` over `tests/` finds only the skip-link assertion | Consume the id at *generation* time rather than at sanitize time, plus one test asserting every `href="#x"` in built HTML has a matching `id="x"`. This must land before TK-05 writes a ToC |
| L5 | **No rails, no explorer, no collection navigation** | Quartz has a left explorer, a right rail, and three page frames selectable per page type | `src/styles/global.css:496-509` documents the centered-article-only decision. Owner decision 1 puts rails back in scope. Requirements §16 is currently unmet | Build-time `<nav>` of the curated collection tree using native `<details>`/`<summary>` — keyboard and screen-reader support with zero JS — plus an optional sub-500 B script for state persistence. Steal Quartz's `grid-template-rows: 0fr → 1fr` collapse animation and the `IntersectionObserver` overflow-gradient sentinel; steal nothing else from `explorer.inline.ts`, which uses three `new Function()` constructions, leaves twelve `console.log` calls in the published bundle, and renders an empty `<ul>` with JS off. **Blocker to name:** `collection` is validated as a flat slug (`src/lib/schema.ts:308-310`), so there is no tree yet. Breadcrumbs need nothing — `Home / Notes / <title>` is a constant today; do not let the nesting problem block them |
| L6 | **No canonical URLs, OG/Twitter metadata, RSS, or sitemap** | Quartz emits all four, plus rasterized OG images via satori + sharp | `dist/` has no `sitemap*`, no `rss*`, zero `rel="canonical"`, zero `og:title`. `astro.config.mjs` has no `site:` | TK-08. Decide the OG-image question explicitly: satori + sharp is a native dependency this project has otherwise avoided, and it collides with the browser-harness decision in L10 |
| L7 | **Hover previews are broken by construction** | Quartz's popover is better engineered on three axes: `@floating-ui/dom` positioning with `inline`/`shift`/`flip`, a per-pathname cache, `window.addCleanup` teardown, and a real 185-line regression test | `src/scripts/link-preview.ts:28` does `indexPromise ||= fetch(...).then(...)` with no `.catch` — one failed fetch permanently poisons previews for the page's lifetime. `:32` fires on every `pointerover` with no hover-intent delay | `.catch` that clears `indexPromise`, a 100–150 ms intent delay, and `focus`/`blur` alongside pointer events — the last is two lines and Quartz does not do it at all. Keep our lookup-by-slug shape (`:41`); it is strictly better than Quartz's fetch-whatever-the-anchor-points-at, which has zero `unlisted` check |
| L8 | **Chrome is monolingual** | Quartz ships 31 locales with a compile-checked contract: `locales/definition.ts` declares `Translation`, each locale ends `as const satisfies Translation`, so a missing key is a build error. Function-valued strings handle interpolation with no ICU runtime | `src/layouts/Layout.astro:17` hardcodes `NAV_LANGUAGE = 'en'`. Hard constraint 6 requires bilingual zh-CN/English with per-document language metadata. The artifact schema already has `language` (`src/lib/schema.ts:70`) and `Layout.astro:14,28` already threads it to `<html lang>` | Steal the `as const satisfies Translation` shape with two locales. Resolve chrome **per document**, which is where we beat them — see §5 |
| L9 | **First deploy will fail** | Quartz gates the Node version at `bootstrap-cli.mjs:3` with an actionable message | No `.nvmrc`; `package.json:15` runs bare `node scripts/validate-content.ts` and `engines` is advisory on Cloudflare Pages. `src/styles/tokens.css:99` names `Inter` with no `@font-face` and no font file anywhere outside `node_modules`. `package.json:15` chains `astro build && emit:redirects && pagefind --site dist`, so a `renderRedirects` throw ships a `dist/` with no `/pagefind/` while `Layout.astro:76` still emits a render-blocking `<link>` to `/pagefind/pagefind-ui.css` — a 404 stylesheet on every page, which `pnpm run preview` serves happily | `.nvmrc`; delete `Inter,`; call `tagFacets`/`collectionFacets`/`renderRedirects` from `scripts/validate-content.ts` so the three throws happen before `astro build` touches `dist/` |
| L10 | **No CI, and no ticket creates one** | Quartz runs `.github/workflows/ci.yaml` on three operating systems | Every gate here — the CSP tests, the residue scan, the contract validation — is only as strong as someone remembering to run it. For a repository whose central claim is that privacy is an artifact property, an unenforced gate is the headline risk. The repo has no remote URL, so a workflow file is not yet actionable | Append `node --test` to `build` today: measured 3.0 s wall, 210 pass. That makes every privacy and CSP gate mandatory on the host instead of opt-in, and needs no remote |
| L11 | **26% of first-paint transfer is a stylesheet for a dialog most readers never open** | — | `src/layouts/Layout.astro:76` unconditionally links `/pagefind/pagefind-ui.css`: 14,482 raw / 2,599 gz on all 7 routes. Article first paint is 10,119 gz total (3,195 html + 2,751 css + 1,574 js + 2,599 pagefind css). Separately, `src/scripts/search-dialog.ts:33-37` injects the **deprecated** Default UI, 119,987 raw / 30,211 gz, when `pagefind-modular-ui.js` at 14,634 / 4,244 gz is already in `dist/` | Delete one line for 26%. Switch to the modular UI for 7× on the search payload. Note `pagefind-highlight.js:1029-1034` creates a `<style>` element with `innerText` and `addStyles` defaults true — pass `addStyles: false` and ship our own `.pagefind__highlight` rule, or it is a CSP violation storm |
| L12 | **Onboarding and configuration do not exist** | `npx quartz create` is a genuinely good `@clack/prompts` wizard with four templates, and `quartz-plugins.schema.json` (345 lines) wired via a `# yaml-language-server: $schema=` header gives editor autocomplete without running anything | Mostly notional: one user, one deployment target, no config file. Recording it so nobody mistakes its absence for a win | Nothing now. If a config file ever appears, ship the JSON Schema header with it — that idea is worth stealing outright |

### 4.1 The measurement gap, stated separately

Not losses. The live corpus is **one entry with six fields** — `[slug, title, excerpt,
markdown, outgoing, backlinks]`, both arrays empty. The nine optional fields in
`src/lib/schema.ts:67-77` are *unproduced by the exporter*, not merely absent.
Consequences:

| What has never run in production | Evidence |
| --- | --- |
| `recentFirst` sorting two notes | `src/lib/routes.ts:178`; no entry carries `created`/`updated` |
| `NoteList` rendering a grid; the `.note-grid` `auto-fit` collapse at 320 px with more than one card | `tests/built-routes.test.ts:523-540` asserts the empty state as the normal case |
| The backlinks `<aside>` | `src/pages/notes/[slug].astro:29-39`; `backlinks: []` |
| `facets()` producing a single page | `src/lib/routes.ts:134,139`; zero tags, zero collections |

That last one is why nobody noticed that tag route keys use a wider vocabulary than
every other slug in the repo: `facets()` rejects `key === ''` and nothing else
(`src/lib/routes.ts:95`), so `🌱 seedling` → `/tags/-seedling/` and `---` → `/tags/---/`
are emittable public URLs. A related latent build failure: two distinct labels that slug
to the same key throw with no fix available from this repo, since the exporter owns tag
text.

**The gate that closes this is a realistic multi-note fixture corpus built in CI, and it
must land before TK-05 writes a single new component.** Every week it waits, more code is
written against an artifact shape nobody has ever seen. It is also the only way "faster
than Quartz" becomes a claim rather than a preference: `Q:/repos/quartz/docs/` is 111
markdown files, Quartz is MIT-licensed, and both repositories are on this disk.

### 4.2 The boundary decision that gates more than any ticket

`docs/plans/p0-implementation-tickets.md:26-29` declares the exporter not writable from
this repository. It has 210 lines, six output keys, and these reproduced defects:

| Bug | Effect on us |
| --- | --- |
| `WIKILINK.finditer` runs over raw markdown with no node awareness | Wikilinks are rewritten inside code fences, and `outgoing`/`backlinks` are derived from the same fence-blind scan — so a note documenting Obsidian syntax injects a phantom edge that `checkCorpus` will prove symmetric and pass. This is the exact defect the Quartz analysis condemns in OxHugo and Roam compat |
| `FRONTMATTER` regex is `\A---\s*\n.*?\n---\s*\n` with `DOTALL` | A note opening with a thematic break loses everything up to the second `---`. `src/lib/markdown.ts:104` documents the opposite contract |
| Wikilink heading anchors are in a non-capturing group | `[[Other#Prerequisites]]` degrades to a page-top link. `INTERNAL_HREF` (`src/lib/markdown.ts:207`) has a capture group preserving a fragment the exporter already destroyed |
| `![[diagram.png]]` → the literal word `diagram.png`; `![[shot.png\|300]]` → `300` | Image embeds become garbage mid-sentence. The residue scan only looks for `[[`, so no gate sees it |
| `MARKDOWN = re.compile(r'[\`*_>#-]+')` applied per line in `excerpt()` | `Step-by-Step` → `StepbyStep`, `--no-verify` → `noverify`, `e-mail` → `email`. That string is `<meta name="description">`, the card, the hover preview, and the search snippet |
| `outgoing` derives from wikilinks only | `{markdown: 'See [B](/b/).', outgoing: []}` is **valid**. A plain markdown link renders a live `<a>` with no backlink on B, so "Linked from" is systematically incomplete and no gate can see it |

Decide the boundary once. If it holds, several downstream tickets are blocked and should
say so instead of building renderers for fields that will never arrive. If it does not,
five of these are one regex each. There are 13 tests in `.harness/tests/test_publish.py`
and none covers frontmatter stripping, excerpt generation, or fence awareness.

---

## 5. Features Quartz cannot have that we can

Quartz assumes whole-vault access, derives relationships by crawling, and ships the
corpus to the client so features can be computed there. We have a curated projection with
a hard artifact boundary, a total validation gate, and corpus-level invariants. That
difference is not a matter of degree — it makes a specific class of guarantee available
to us and structurally unavailable to Quartz.

| # | Capability | Why our architecture enables it | Why Quartz structurally cannot |
| --- | --- | --- | --- |
| C1 | **A graph that is real HTML** — a build-time one-hop neighborhood as inline SVG with real `<a>` elements, crawlable, keyboard-navigable, working with JS disabled, at roughly 2 KB per page | The corpus is a bounded allowlist, so the neighborhood is small and known at build time. `checkCorpus` has already resolved every edge, so layout can be computed once during the build | Quartz's `Graph.tsx` emits three empty divs and a `data-cfg` attribute — no nodes, no links, no text in the HTML. Everything comes from `~525 KB` brotli of d3 + PixiJS injected from jsdelivr plus the `fetchData` inline script. Server-rendering it would mean laying out a whole-vault graph per page. **Note: `/graph/` is in requirements §9.1 and no ticket owns it.** This is the one item on the board a reader would experience as *better*, not merely *cleaner* |
| C2 | **A published, provable relationship guarantee** — "this site has zero dangling edges", stated on the site and enforced by the build | `checkCorpus` (`src/lib/schema.ts:350-393`) fails the build if backlinks are not the exact inverse of outgoing. It is a total check over a bounded corpus, which is only affordable because the corpus is a projection | CrawlLinks records edges whether or not the target exists; broken wikilinks are opt-in (`disableBrokenWikilinks: false` by default); slug collisions are a warn. The measured dangle rate on Quartz's own site is 14.6%. Copying this would mean rewriting CrawlLinks and turning warnings into build failures. **Prerequisite for us:** the edge model is currently never checked against the rendered links (§4.2), so today the guarantee is about the artifact's internal consistency, not about the page |
| C3 | **Previewing a non-allowlisted page is structurally impossible** | `src/scripts/link-preview.ts:41` looks the target up by slug in the projected index and returns when absent. The preview payload is a projection the exporter authored, not a page scrape | Quartz's popover calls `fetchCanonical(targetUrl)` on whatever the anchor points at, parses it with `DOMParser`, and has **zero** `unlisted` checks (grep confirms). On Quartz that is merely inconsistent; on a privacy projection it would be a hole. There is no bounded preview payload to switch to because there is no projection |
| C4 | **Per-document chrome language** — a zh-CN note renders Chinese chrome and `<html lang="zh-CN">`; an English note on the same site renders English chrome; `hreflang` and per-language feeds derive from the same field | `language` is a per-entry field on the validated contract (`src/lib/schema.ts:70`) and `src/layouts/Layout.astro:14,28` already threads it. Chrome resolution is a build-time lookup keyed on that field: still zero client JS | `cfg.locale` is a **single global** (`quartz/cfg.ts:83`). `renderPage.tsx:338-339` reads `<html lang>` from frontmatter but every chrome string from the global, so a zh-CN document renders `lang="zh"` around English "Backlinks" and "minute read". Expressing per-document chrome would require changing the config shape that 47 plugins read from |
| C5 | **Deny-by-default assets, assertable as a test** | **Shipped:** there is no note-asset copy step, and `verify-output-inventory.ts` requires the exact route model, byte-bound `public/` members, flat hash-shaped Astro JS/CSS, and Pagefind's fixed/metadata-bound members. Independent mutations make each unexpected surface fail | Quartz's own docs state the opposite behaviour as fact, and `plugins/emitters/assets.ts` implements it. Their privacy failure was never the Markdown — it was the images. Fixing it means deleting the asset emitter |
| C6 | **Withdrawal that actually withdraws** | Removing an entry from the manifest removes it from the artifact, from `dist/`, and from the Pagefind index. There is nothing left to serve | Quartz's `unlisted` is documented security-by-obscurity: the HTML still ships, the page is still served to anyone with the URL. Worse, `unlisted` removes a page from the index while CrawlLinks still recorded *other* pages' edges pointing at it, so unlisted titles are inferrable from neighbours' link arrays. **Open problem on our side:** the obvious tombstone shape `{status:'tombstone', outgoing:[], backlinks:[]}` cannot be produced — `checkCorpus` (`src/lib/schema.ts:384-393`) rejects it whenever a live note links to the withdrawn one, which is exactly when withdrawal matters. Owner decision 3 already settles the redirect half: renames are delete-and-recreate, old URLs may 404 |
| C7 | **An exhaustive, machine-readable "what is public" manifest** | `public/content-index.json` is 404 bytes and is proven an exact `{slug, title, excerpt}` projection of the validated artifact by a single key-order-sensitive `JSON.stringify` comparison (`scripts/validate-content.ts:36`). We can publish a complete list of everything on the site and prove it complete | Quartz's equivalent artifact carries the full plaintext of every page, so it cannot be published as a manifest without publishing the corpus. There is no separate title-only index and no projection gate. (Honest scoping: our disclosure argument for *withholding* this file is void — `dist/index.html` already renders every title and excerpt via `NoteList.astro`. The only remaining argument is 404 bytes, which is not an argument) |
| C8 | **"Zero search or preview bytes requested before explicit user intent"** as a binary build assertion | Every heavy subsystem is lazily gated, and `RenderedNote` already returns `hasCode`/`hasMath`/`hasMermaid` to gate on (owner decision 7). The assertion is parsed out of the built HTML's `<link>`/`<script>` set | Quartz fails it unconditionally: `renderPage.tsx:75` emits the `contentIndex.json` fetch as an inline script on every page, and the search bundle (26,259 B gz) loads `afterDOMLoaded` on every page, not on first open. This is the one budget gate worth more than all the byte thresholds combined, precisely because it is the one Quartz cannot pass |
| C9 | **A versioned, tested contract between exactly one producer and one consumer** | One exporter, one artifact, one site. That permits a fixture-vault → exporter → artifact → built-HTML golden test covering the entire pipeline — the single thing that would have caught all six exporter defects in §4.2 | Quartz has 47 plugin packages writing fields onto `file.data` by convention with no schema. Category detection is literally "call the exported functions and inspect the return shape" (`config-loader.ts:557-600`), and `PageTypePluginEntry` types matchers as `(...args: never[]) => boolean` and calls them unsafely because contravariance breaks across differently-branded `FullSlug` types. Quartz has 163 tests and **zero** over `build.ts`, `parse.ts`, or `emit.ts`, no end-to-end build test, and no golden files. Two of its eleven test files test *inlined copies* of the code rather than the code |
| C10 | **A build that fails rather than ships something wrong** | `validateArtifact` at module evaluation (`src/lib/content.ts:15`); `facets()` throws and names both colliding labels rather than disambiguating with a numeric suffix, because a suffix would make one tag's public URL depend on which other tags exist | `emit.ts:84-95` catches per-emitter failures, prints *"Build completed with N emitter failure(s). Output may be incomplete"*, and **exits 0**. Any CI gate checking exit status deploys it. `util/trace.ts:36-41` `process.exit(1)` on the main thread but `throw` in a worker, so the same malformed file behaves differently depending on whether the corpus crossed the 128-file concurrency threshold. `helpers.ts:13` writes non-atomically into a directory that was already `rm -rf`'d, so a mid-emit crash leaves no previous good state |

Two of these — C1 and C2 — are the only items in the whole analysis that make the site
*more feature rich* rather than *tidier*. **C1 is now built**: TK-17 (`7dfd94f`) ships the
graph as inline SVG with real `<a>` elements on both the article page and `/graph/`, laid
out at build time, working with JavaScript disabled, at a median 975 B gzip per page.
Everything else
on the backlog is parity work, correctly scoped. A superset needs a superset.

---

## 6. Revised backlog

The existing backlog is a faithful decomposition of requirements §8.1, which is itself a
Quartz parity table. No ticket in it has a success condition of the form "better than
Quartz at X". A backlog that only closes parity gaps cannot produce a superset, so this
section adds the tickets that do, revises the ones the owner decisions changed, and
deletes work that the critiques proved unnecessary.

Two structural facts drive the order:

- **Nothing here has been validated against a realistic corpus.** The live artifact is one
  entry with six fields and two empty arrays. Every layout claim in the repository is
  currently unfalsified. TK-11 exists to fix that and blocks the component work.
- **Several defects are already merged.** Search has never run under our own CSP, the
  pipeline emits nine classes the stylesheet does not style, and heading-anchor ids can
  collide. These are cheaper to fix than any new feature and some of them block new
  features.

### 6.1 Ticket table

| ID | Title | Depends on | Priority | Wave |
| --- | --- | --- | --- | --- |
| TK-11 | Realistic multi-note fixture corpus | — | P0 | done `855b06b` |
| TK-12 | Shipped-output defect sweep | — | P0 | done `855b06b` |
| TK-13 | Toolchain migration — Vitest, Oxlint | — | P0 | done `ba58842` |
| TK-14 | CI enforcement | TK-13 | P0 | done `4ccd5c9` |
| TK-05a | Page anatomy and table of contents | TK-11, TK-12 | P0 | done `a37bf7b` |
| TK-05b | Static relationship surfaces | TK-05a | P0 | done `be89b25` |
| TK-06 | Search — make it work, then make it good | TK-05a | P0 | done `1164c72` |
| TK-08 | Canonical metadata, feeds, sitemap, social cards | TK-05a | P0 | done `6d7b730` |
| TK-15 | Math and diagrams — Temml and dual-mode Mermaid | TK-05a | P0 | done `116b15c` |
| TK-05c | Collection rails and explorer | TK-05a, TK-05b | P0 | done `e002113` |
| TK-07 | Hover and focus previews | TK-05b | P0 | done `22cd841` |
| TK-16 | Bilingual chrome | TK-05a, TK-05c | P0 | done `410aad2` |
| TK-17 | Static graph route | TK-05b | P0 | done `7dfd94f` |
| TK-09 | Privacy, security, and performance gates | all above | P0 | 4 |
| TK-18 | Measured benchmark against Quartz v5 | TK-09 | P0 | 4 |
| TK-10 | ADRs and deferred-scope documentation | all above | P0 | 4 |
| TK-21 | Interactive graph via SQLite WASM | TK-17, TK-09 | P1 | 5 |
| TK-23 | Generalisation and distribution | TK-16, TK-17 | P0 | superseded — see [`ssg-generalisation-plan.md`](ssg-generalisation-plan.md) |
| TK-19 | Formalise the artifact contract | TK-23 | P0 | superseded — see [`ssg-generalisation-plan.md`](ssg-generalisation-plan.md) |
| TK-20 | Oxfmt | TK-13 | P1 | isolated |
| TK-22 | Migrate from npm to pnpm | TK-13 | P1 | done `ddc9b71` |

TK-11 and TK-12 landed as `855b06b`: 254 tests, article first paint down from 10,119 to
8,284 B gzip, and search running under the shipped CSP for the first time.

### Delivered so far

Seventeen tickets are merged. `main` is at `7dfd94f` with **505 tests** — 479 passing and
26 skipped on the published one-note corpus, 504 passing and 1 skipped under
`pnpm run build:fixture` — `pnpm run verify` green, and the residue scan clean over 24
files.

| Landed | Commit | What changed |
| --- | --- | --- |
| TK-11, TK-12 | `855b06b` | Fixture corpus, and the shipped-output sweep that first made search run |
| TK-13 | `ba58842` | Vitest, Oxlint, and a rendered 320 px measurement |
| TK-05a | `a37bf7b` | The §9.2 page anatomy, and the render metadata that had zero consumers |
| TK-22 | `ddc9b71` | pnpm, with an undeclared import now failing to resolve |
| TK-05b, TK-08 | `c5a92c9` | Relationship surfaces; canonical URLs, Atom feed, sitemap, social card |
| TK-14 | `4ccd5c9` | `verify`, the residue scan, and the CI workflow |
| TK-06 | `1164c72` | Search that runs under the shipped CSP, on the modular UI |
| TK-15 | `116b15c` | Temml math and build-time Mermaid, both zero-JS at that milestone |
| Client rendering | `8464046` | Math and Mermaid moved to client runtimes with source fallbacks and mode-matched CSP |
| TK-05c | `e002113` | The collection rail, complete and collapsible without script |
| TK-07 | `22cd841` | Hover and focus previews from the projected index only |
| TK-16 | `410aad2` | Per-document chrome: a zh-CN note renders Chinese chrome in the same build |
| TK-17 | `7dfd94f` | The graph as real HTML — inline SVG, real links, no script, deterministic |

**Two authorized fence extensions**, recorded so the audit trail is not silent:

1. **TK-08 edited `tests/deployment.test.ts`**, which its fence excluded. Scope item 6
   needs a second `_headers` rule for `/_astro/*`, and the file asserted `RULES.length === 1`.
   That assertion was a *proxy* for the hazard its own comment names — Cloudflare joins
   duplicate header names with a comma rather than choosing the most specific — so it was
   replaced with a direct check that no two rules set the same header name. Stricter in the
   dimension that matters, and proven non-vacuous by seeding a genuine duplicate. Authorized
   before the edit, not after.
2. **TK-14 added one `&&` link to `build`**, slightly past its "owns the `verify` script"
   grant. Cloudflare Pages runs `build` alone, so a residue scan attached only to `verify`
   would mean the host that publishes the artifact is not the host that scans it. Flagged
   by the agent rather than assumed.

### Superseded in part

TK-23 and TK-19 in the table below were written when "generalisation" was one ticket and a
contract specification. The direction has since been settled further — the project is a
**general-purpose SSG** whose input is a git repository of Markdown, publish is the default
with explicit exclusion, and this repository is the tool only, with no site of its own.

Both tickets are replaced by [`ssg-generalisation-plan.md`](ssg-generalisation-plan.md),
which decomposes them into TK-24 through TK-35 after two adversarial reviews returned 25
substantiated findings against the first design. **Read that document for anything to do
with generalisation.** Everything else here — the parity matrix, the delivered work, and the
wave-4 tickets TK-09, TK-18, and TK-10 — remains current.

### The project is becoming a reusable publisher

Decided 2026-08-11, and it reshapes what remains. The target is that **another user adds
one GitHub Action to their own notes repository** and gets a published knowledge garden.
Today the architecture is hardcoded to one owner: `export.py` refuses to write anywhere but
a directory named `thoughtscape-publish`, the vault path is a fixed relative path, and the
site origin, title, navigation, and about and privacy copy are literals in the tree.

Two consequences, both already folded into the backlog:

- **No domain is needed to develop, test, or preview.** The origin becomes deployment-time
  configuration; local preview targets `http://publish.localhost/`. The note below about
  the placeholder origin stands as a deployment gate, not a development one.
- **TK-19 changes shape.** A contract defined by one implementation is not a contract, and
  other users will not have this owner's `export.py`. It is now "formalise the artifact
  contract so any producer can implement it", with the six reproduced defects restated as
  specification test cases.

TK-23 is scheduled ahead of wave 4 deliberately: building release gates, a benchmark, and
architecture records around single-owner assumptions would mean redoing all three.

### Blocking before any deployment

`astro.config.mjs:16` sets the canonical origin to `https://thoughtscape.invalid` — an
RFC 2606 reserved name chosen so it cannot resolve to a real site by accident. A test walks
`src/`, `scripts/`, `tests/`, and `public/` and fails if any second file writes the host, so
assigning a real domain stays a one-line change. **Deploying before that change would
publish canonical URLs, an Atom feed, and a sitemap all pointing at a domain that does not
exist.**

**Parallelism.** Tickets in the same wave have no dependency between them *and* no
overlapping file ownership. The second condition is the binding one — two tickets that
both rewrite `Layout.astro` are not parallel however independent their logic.

**Revised after wave 1, which proved the point the hard way.** TK-11 and TK-12 were
dispatched in parallel on the reasoning that their logic was independent. It was; their
files were not. A fixture corpus inevitably reaches validation, routing, and the build
scripts, so the fence could not be drawn cleanly and five files conflicted. The merge was
worth doing — it surfaced two defects that existed only in the combined tree, including a
test file that auto-merged cleanly and did not compile — but the conflict was avoidable
orchestration cost, not a discovery. **Group by which files a ticket writes, never by
whether its logic is separable.**

The second correction is `src/pages/notes/[slug].astro`. It is 39 lines, and five tickets
in the original wave 2 all needed to edit its centre. Splitting a file that small into
"named regions" is a fiction. One ticket establishes the shape and the rest fill slots it
defines.

| Wave | Runs together | Why they do not collide |
| --- | --- | --- |
| 1 | ~~TK-11, TK-12, TK-13~~ — **completed as TK-12, then TK-11 merged into it, then TK-13 alone** | Recorded as run, not as planned. TK-11 and TK-12 should have been serialized. |
| 2a | **TK-05a alone** | It establishes the article page shape and the `<head>` slots every later ticket fills. Running anything beside it means contending for a 39-line file. Serializing one ticket buys four conflict-free ones. |
| 2b | TK-05b, TK-08, TK-14 | TK-05b fills the relationship region TK-05a leaves; TK-08 fills the `<head>` slot TK-05a leaves and otherwise owns `src/pages/rss.xml.ts` and the sitemap emitter; TK-14 owns `.github/` and the `verify` script. The only shared file is `package.json` — **TK-14 lands its script last**. |
| 3a | TK-06, TK-07, TK-15 | TK-06 owns `src/scripts/search-dialog.ts` and the Pagefind build flags; TK-07 owns `src/scripts/link-preview.ts`; TK-15 owns the math and diagram paths in `src/lib/markdown.ts` plus `src/scripts/mermaid.ts`. Disjoint. All three consume TK-05a's slots without redefining them. |
| 3b | TK-05c, then TK-16, then TK-17 | TK-05c creates the rail components; TK-16 rewrites every chrome string **inside components TK-05c and TK-05a created**, so it cannot precede them; TK-17 adds `src/pages/graph.astro` and `src/lib/graph.ts` and touches the article page's neighborhood slot. Serial. |
| 3c | TK-23, then TK-19 | Inserted ahead of wave 4 by owner decision. Generalisation changes the assumptions gates, benchmarks, and architecture records would otherwise be built on, and TK-19 formalises a contract whose audience only exists once TK-23 makes a second producer possible. |
| 4 | TK-09, then TK-18, then TK-10 | Strictly serial. Gates must see the finished surface; the benchmark needs the gates' numbers; the ADRs record what the other two found. |
| 5 | TK-21 alone | Phase 2. It enhances TK-17's static baseline and must not start before TK-09 has established the budget gates it has to pass. |

TK-20 (Oxfmt) is deliberately outside every wave. It rewrites every file in the
repository, so it lands as its own commit against a clean tree, touching nothing else.

### 6.2 Revisions to existing tickets

**TK-05 is split into three.** As written it carries thirteen page-anatomy elements plus
breadcrumbs, table of contents, related-note derivation, backlink context, empty states,
and — since owner decision 1 — the rails. That is more surface than TK-01 through TK-04
combined. It is also partly blocked: `collection` is validated as a flat slug
(`src/lib/schema.ts:308`) and `src/lib/routes.ts` has no notion of nesting, so a
collection *tree* has no data behind it. Breadcrumbs are not blocked — `Home / Notes /
<title>` is a constant that needs no schema change, and the nesting problem must not be
allowed to hold them hostage.

**TK-06 is not "build search".** Search has never run in production: `public/_headers`
sets `script-src 'self'` with no `'wasm-unsafe-eval'`, and `dist/pagefind/pagefind.js`
contains two `WebAssembly` calls. The ticket's first acceptance criterion is that a query
returns a result in a browser under the shipped CSP.

**TK-07 is smaller than it looks.** `grep -o 'href="/notes/' dist/notes/*/index.html`
returns zero: there are no in-prose note links to preview. The ticket is real, since the
corpus will grow, but it is a three-fix ticket (unpoisoned cache, hover-intent delay,
keyboard focus), not a rewrite.

**TK-09 loses the class-coverage gate and gains the mode-aware CSP gate.** A proposed gate
extracting every class `markdown.ts` can emit would be a fourth consumer of
`tests/css-cascade.ts`, the 397-line hand-written parser whose own TK-02 report recommends
replacing rather than deepening. The allowlist is twelve literals; read them once. What
TK-09 must gain instead: the zero-inline-style assertion becomes mode-aware, because
Mermaid client mode requires `style-src 'unsafe-inline'` (owner decision 5).

**TK-09 also inherits one known flaky gate, and it is wider than first recorded.**
`tests/math-and-diagrams.test.ts > every diagram type renders to CSP-clean SVG` failed once
and then passed four consecutive runs with the file untouched, found during TK-16. TK-17
saw the same file redden four more times across full-suite runs, in **four different
tests** — `every diagram type renders to CSP-clean SVG`, `diagram rendering is
deterministic across processes`, `build-time mode ships no diagram runtime at all`, and
`the per-page cost of math and diagrams is recorded` — while the file passed alone every
time it was run in isolation. So it is the *file* that is flaky under concurrent load, not
one assertion, which points at a shared resource (the Mermaid render harness, or `dist/`
read while another suite rebuilds it) rather than at a single racy check. It is unrelated
to both tickets and was left alone deliberately, but a gate that reddens at random will
eventually block a release for no reason and train whoever sees it to re-run rather than
investigate. Diagnose the race rather than adding a retry — TK-07 hit the same shape and
the cause was an assertion measured against a different document state than its stimulus.

**TK-10 records the deliberate deviations**, which now number at least six: slug renames
are delete-and-recreate (§9.3 not implemented), SPA routing deferred, encrypted pages
deferred, PlantUML deferred, diagrams absent without JavaScript in Mermaid client mode
(§5.2/§5.3 carve-out), and Svelte not installed despite requirements §11.3 naming it as
the interaction layer.

**One requirement needs an explicit verdict, not silence.** Requirements §11.3 specifies
Svelte islands with a per-island contract. Nothing has installed Svelte, and TK-06 and
TK-07 implement search and previews in plain TypeScript totalling 1,067 B gzip. Either the
requirement is stale or the tickets are wrong. The recommendation is that the requirement
is stale for the current surface — a framework earns its place at the Phase 2 interactive
graph, not before — and TK-10 should record that rather than leaving the contradiction
unwritten.

### 6.3 New tickets

---

#### TK-11 — Realistic multi-note fixture corpus

**Requirements:** sections 22.1, 22.2, 25

**Problem.** The live artifact is one entry carrying six fields with two empty arrays. The
nine optional fields in `src/lib/schema.ts:67-77` have never been produced. Consequently
`recentFirst` has never sorted two notes, `NoteList` has never rendered a grid, the
backlinks `<aside>` has never rendered, and `facets()` has never produced a single page —
`tests/built-routes.test.ts:523-540` asserts the empty state as the normal case. Every
layout, performance, and accessibility claim in this repository is unfalsified. Each week
this waits, more code is written against an artifact shape nobody has seen.

**Scope.**

1. Author a synthetic multi-note artifact under `tests/fixtures/` — at minimum 30 entries
   — exercising: every optional field; tags and collections with realistic cardinality; a
   dense backlink graph including hub and orphan notes; bilingual zh-CN and English
   entries; long, code-heavy, table-heavy, and math-and-diagram-bearing bodies; titles and
   tags with CJK, emoji, and punctuation. Synthetic only — never copy private content.
2. Make the build runnable against a fixture corpus by environment variable or a
   `build:fixture` script, so `dist/` can be produced from it without touching
   `src/data/content.json`.
3. Extend the built-output tests to run against the fixture build, not only the live
   one-note build.
4. Fix what the fixture exposes. Two failures are already known and will surface
   immediately: `facets()` rejects only `key === ''` (`src/lib/routes.ts:95`), so a tag of
   `🌱 seedling` becomes the public URL `/tags/-seedling/` and `---` becomes `/tags/---/`;
   and two distinct labels slugging to the same key throw with no remedy available from
   this repository, since the exporter owns tag text.
5. Bound the fields that exist. `validateArtifact` currently bounds nothing: a 3 MB
   `markdown` body and 5,000 tags both pass, and 5,000 tags is 5,000 routes against
   `REDIRECT_LIMIT = 2000` (`src/lib/routes.ts:231`).

**Acceptance criteria.**

- `pnpm run build:fixture` produces a full site from the fixture corpus and every existing
  gate passes against it.
- Grid, backlinks, tag pages, collection pages, and `/recent/` ordering each render with
  more than one entry, asserted by test.
- No public route contains a character outside the slug vocabulary, proven by a test that
  enumerates built route paths.
- A tag-key collision fails the build with a message naming both labels and stating that
  the fix belongs to the exporter.
- Field bounds are enforced with a stated limit per field.

---

#### TK-12 — Shipped-output defect sweep

**Requirements:** sections 8.1, 11.4, 17, 18, 19.2

**Problem.** Six independent defects are already merged and shipping. They share a
property that makes them one ticket rather than six: each is a small deletion or a
one-line change in built output, and several block later tickets.

**Scope.**

1. **Search is blocked by our own CSP.** Add `'wasm-unsafe-eval'` to `script-src` — it is
   not `'unsafe-eval'` and permits no string-to-code evaluation. While in
   `public/_headers`: add `font-src`, `worker-src`, and `form-action 'none'`, and move
   `base-uri` to `'none'` per requirements lines 713-725. Add the table-driven `_headers`
   test that does not exist — `grep -rn "_headers" tests/ scripts/` returns nothing. Do
   not add a second overlapping rule without `! Header-Name`; Cloudflare joins duplicate
   headers with a comma rather than picking the most specific.
2. **Delete the `copy-code` button** (`src/lib/markdown.ts:437-441`, forced `hidden` at
   `:708`, plus its `allowedTags`/`allowedAttributes`/`allowedClasses` entries). It has
   zero CSS and zero handler, and it welds the word `Copy` onto all eight indexed code
   blocks. TK-05a may reintroduce it in the same commit as its handler and its styling —
   the point at which it stops being dead code.
3. **Style the classes that actually ship.** Zero rules exist in `src/styles/` or the
   built CSS for `token-*`, `code-block`, `heading-anchor`, `callout*`, `task-list-item`,
   `footnotes`, `sr-only`, `math-inline`, `math-display`. The single published note
   renders 21 unstyled `token-*` spans, 15 `heading-anchor`, and 8 `code-block`; syntax
   highlighting is currently undifferentiated plain text. `sr-only` is a live
   accessibility bug — satteri emits `<h2 class="sr-only" id="footnote-label">Footnotes</h2>`
   which is visible today. Do not import Quartz's thirteen-kind callout vocabulary; the
   corpus has zero callouts.
4. **Fix heading-anchor id collisions.** `sanitize()` consumes generated ids from a
   one-shot set in document order while granting `id` to `a` and `li`
   (`src/lib/markdown.ts:539-543`), so raw HTML `<a id="introduction">` preceding
   `## Introduction` produces a duplicate id where the deep link, the future table of
   contents entry, and the Pagefind anchor all resolve to the decoy. Consume the id at
   generation time. This must land before TK-05a writes a table of contents.
5. **Stop shipping the Pagefind stylesheet to every page.** `src/layouts/Layout.astro:76`
   links `/pagefind/pagefind-ui.css` unconditionally: 2,599 B gzip on all seven routes,
   26% of the measured 10,119 B gzip article first paint, for a dialog most readers never
   open. Load it with the search bundle.
6. **Make the build fail before it writes a bad `dist/`.** `package.json:15` chains
   `astro build && emit:redirects && pagefind --site dist`, so a `renderRedirects` throw
   ships a `dist/` with no `/pagefind/` while every page still emits a render-blocking
   `<link>` to a 404. Call `tagFacets`, `collectionFacets`, and `renderRedirects` from
   `scripts/validate-content.ts` so those throws happen before `astro build` touches
   `dist/`.
7. **Delete the legacy `/<slug>/` redirect pair and its limit machinery**
   (`src/lib/routes.ts:213-224`, `REDIRECT_LIMIT`, the cycle-walk test). It migrates away
   from a URL shape that was never publicly served: introduced at `3831ad0`, superseded at
   `04f8d9c`, entirely within unpushed history, with no `site:` configured and no
   canonical URLs emitted. Keep the redirect *mechanism*; delete the rules it has no
   reason to emit.
8. **Delete `Inter,` from `src/styles/tokens.css:99`** — the font is named with no
   `@font-face` and no font file anywhere outside `node_modules`. Add `.nvmrc`.

**Acceptance criteria.**

- A search query returns a result in a real browser under the shipped CSP.
- Every class the pipeline emits either has a CSS rule or is deliberately unstyled with a
  comment saying so.
- No built page contains a duplicate `id`, and every `href="#x"` has a matching `id="x"`,
  proven by a test.
- Article first-paint transfer is measured before and after, and the reduction recorded.
- A seeded `renderRedirects` failure aborts before `dist/` is modified.
- `_headers` is covered by a test asserting each directive.

---

#### TK-13 — Toolchain migration: Vitest and Oxlint

**Requirements:** owner decision 6

**Problem.** The repository runs `node --test` — a deliberate and correct TK-01 call at the
time — while the owner has specified Vitest. It has no linter at all. Separately, TK-02's
320 px overflow check is syntactic: it proves no CSS rule *commits* to an over-wide box,
but never measures a rendered page, and its own report names this the weakest evidence in
that ticket.

**Scope.**

1. Migrate the 210 tests to Vitest, reusing the Vite configuration already present via
   Astro so path resolution and TypeScript handling are not configured twice.
2. Add Oxlint with a configuration matched to this codebase. Report only; do not let it
   rewrite files.
3. Decide the browser-harness question **once**, because it is one decision wearing two
   hats: Vitest browser mode plus Playwright would give the rendered 320 px measurement,
   and the same harness question governs whether Mermaid build-time rendering needs a real
   browser. TK-15's probe already answered the Mermaid half — `happy-dom` suffices, no
   Chromium — so the only remaining question is whether a rendered viewport check is worth
   a Playwright dependency. Recommend and implement one answer.
4. Do not adopt Oxfmt here. It is TK-20 and lands alone.

**Acceptance criteria.**

- `pnpm test` runs under Vitest with all tests passing and no count regression.
- `pnpm run lint` runs Oxlint and passes, or reports only findings recorded as deliberate.
- The browser-harness decision is written down with its reason, and the 320 px check
  either measures a rendered page or documents why it still does not.

---

#### TK-14 — CI enforcement

**Requirements:** sections 21.1, 25

**Problem.** Every gate in this repository — the CSP tests, the privacy residue scan, the
contract validation — is only as strong as someone remembering to run it. For a project
whose central claim is that privacy is an artifact property, an unenforced gate is the
headline risk. There is no `.github/`, and no ticket creates one. The repository also has
no remote, so a workflow file alone would not run.

**Scope.**

1. Make the gates mandatory on the host today, independent of any remote: `pnpm run verify`
   must run validation, lint, type check, tests, build, and the residue scan, and the
   release path must run it rather than relying on discipline.
2. Add the CI workflow file so it takes effect the moment a remote exists. Pin the Node
   version to `.nvmrc`.
3. Make the privacy scan a blocking step, not an advisory one.

**Acceptance criteria.**

- `pnpm run verify` passes from a clean tree and fails on a seeded violation of each gate.
- The workflow file is syntactically valid and its steps mirror `verify` exactly, so the
  two cannot drift.
- A documented statement of which gates run where, and what is still manual.

---

#### TK-15 — Math and diagrams: Temml and dual-mode Mermaid

**Requirements:** sections 8.1, 15.1, 18, 19.3; owner decisions 2, 5, 7

**Problem.** `$$…$$` renders as escaped source and Mermaid fences render as escaped code
tagged `data-diagram="mermaid"`. Both downgrades were correct at the time and both are now
superseded by owner decisions. Neither has a ticket.

**Scope.**

1. **Math via Temml.** TeX to native MathML, prerendered at build time, zero client
   JavaScript. Extract Temml's 13 distinct inline style declarations — measured across a
   20-expression corpus, on 5 element types, using 8 CSS properties — into build-time
   classes rather than relaxing `style-src`. Self-host the ~9 KB stylesheet and the 9.4 KB
   `Temml.woff2`. Decide the `\textcolor` question explicitly: author-specified colours are
   the one unbounded part of that inline-style set and they break contrast in one theme or
   the other. The recommendation is to reject `\textcolor` rather than map it.
2. **Mermaid dual-mode**, configurable, client-side by default per owner decision 5. Both
   modes must work.
   - *Build-time mode*: renders 23/23 diagram types under `happy-dom` with no browser,
     deterministic per process, CJK correct, ~1.9 KB gzip SVG per diagram. Needs the
     ~90-line post-processing pass that converts 45.6% of inline declarations to SVG
     presentation attributes and collapses the remainder into 8 utility classes, yielding
     0 CSP violations. Full evidence in `.tmp/mermaid-feasibility.md`.
   - *Client mode*: requires `style-src 'self' 'unsafe-inline'`. `unsafe-eval` is **not**
     needed. Hash-pinning was tested and cannot work — 26+ inline `style=` attributes are
     uncoverable by hashes. Diagrams are absent with JavaScript disabled; this is a
     deliberate carve-out from requirements §5.2/§5.3 and TK-10 records it.
3. **Per-page lazy loading, per owner decision 7.** `RenderedNote.hasCode`, `.hasMath`, and
   `.hasMermaid` (`src/lib/markdown.ts:46-61`) exist and have zero consumers. Gate every
   heavy asset on them: math CSS and font only on pages with math, Mermaid runtime and
   per-diagram-type chunks only on pages with a diagram and only in client mode, `token-*`
   CSS only on pages with a code fence. Emit conditional `<link>` elements rather than one
   merged sheet — merging all 23 Mermaid diagram-type stylesheets costs 6,354 B gzip
   against a 972 B median for a single type, a 6× penalty on a typical page.
4. The CSP must differ by mode, and the mode must be a single configuration value that
   both the build and the `_headers` generation read.

**Acceptance criteria.**

- Every diagram type in the fixture corpus renders in both modes.
- Build-time mode produces zero CSP violations under `script-src 'self'; style-src 'self'`,
  proven by a test over `dist/`.
- Client mode ships zero diagram bytes on a page with no diagram, proven by a test over the
  built HTML's `<link>` and `<script>` set.
- Math renders as MathML with no client JavaScript in either mode.
- Switching modes changes the emitted CSP, and a test asserts the two stay consistent.
- Byte cost per mode is measured and recorded.

---

#### TK-16 — Bilingual chrome

**Requirements:** section 8.1 i18n; hard constraint 6

**Problem.** `src/layouts/Layout.astro:17` hardcodes `NAV_LANGUAGE = 'en'`. Every chrome
string — the skip link, the navigation, all three toggles, `NoteList`, every facet page —
is English. Hard constraint 6 requires bilingual zh-CN and English with per-document
language metadata, and the schema already carries `language` (`src/lib/schema.ts:70`),
which `Layout.astro:14,28` already threads to `<html lang>`.

**Scope.**

1. A typed translation contract with two locales, using the `as const satisfies
   Translation` shape so a missing key is a build error rather than a runtime fallback.
2. Resolve chrome **per document** from `entry.language`, not from one site-wide locale.
   This is the point where we exceed Quartz structurally: `cfg.locale` there is a single
   global read by 47 plugins, so a zh-CN document renders `lang="zh"` around English
   chrome. Ours can render Chinese chrome on a Chinese note and English chrome on an
   English note, on the same site, at zero client JavaScript.
3. Cover the interpolated strings without adding an ICU runtime — function-valued
   translation entries are sufficient.
4. Documents with no `language` field fall back to the site navigation language.

**Acceptance criteria.**

- A zh-CN fixture note renders Chinese chrome and `lang="zh-CN"`; an English note on the
  same build renders English chrome. Asserted by test over `dist/`.
- A missing translation key fails type checking.
- Zero client JavaScript is added.

---

#### TK-17 — Static graph route

**Requirements:** section 9.1, 13.2, 13.3, 17

**Problem.** `/graph/` is listed in requirements §9.1 and no ticket owns it. TK-05's item 7
covers only the per-note accessible list. This is also the single item on the whole board
that a reader would experience as *better* than Quartz rather than merely cleaner, so it is
the clearest content for the "more feature rich" goal.

**Scope.**

1. Render the graph as **real HTML** — inline SVG containing real `<a>` elements, laid out
   at build time. It is crawlable, keyboard-navigable, and works with JavaScript disabled.
   This is structurally unavailable to Quartz, whose `Graph.tsx` emits three empty divs and
   a `data-cfg` attribute and depends on roughly 525 KB brotli of d3 and PixiJS from a
   third-party CDN.
2. A per-note one-hop neighborhood on the article page, and a site-wide `/graph/` route.
   The corpus is a bounded allowlist, so both layouts are computable during the build.
3. Distinguish incoming from outgoing edges without relying on colour alone. Expose edge
   type to assistive technology. Provide the equivalent list or table representation
   required by requirements §17.
4. Respect `prefers-reduced-motion`; no force-simulation animation is required for a
   static layout.
5. Keep the per-page cost near 2 KB. The interactive layer is TK-21 and must not be stubbed
   in here — this ticket ships the baseline that TK-21 enhances and that survives when
   TK-21's enhancement fails.

**Acceptance criteria.**

- `/graph/` and the per-note neighborhood render with JavaScript disabled, and every node
  is a working link.
- Keyboard traversal reaches every node in a documented order.
- The rendered graph's edges match the artifact's edge set exactly, proven by a test.
- Per-page byte cost is measured and recorded.

---

#### TK-21 — Interactive graph via SQLite WASM

**Requirements:** sections 12.1, 12.2, 12.3, 12.4, 13.2, 13.3, 17, 19.3, 20; owner decisions
on graph architecture

**Problem.** TK-17's static SVG answers "what is one hop from here" — a query the build can
answer over a bounded corpus. It cannot answer multi-hop traversal, relationship filtering
("notes cited by both A and B"), or arbitrary graph queries: those combinatorially explode
at build time. That is the genuine case for a client-side database, and it is the only one.

**Two things this ticket must not do.** It must not move backlinks or the one-hop
neighborhood into a query — those are build-time static HTML today
(`src/pages/notes/[slug].astro:28-38`), which is what requirements §13.1 and §12.3 require
and what Quartz already does correctly. Moving them would cost roughly 900 KB of WebAssembly,
require `wasm-unsafe-eval`, and make them invisible without JavaScript. And it must not
introduce D1 or any runtime data service: D1 is permanently rejected, not deferred, because
a browser calling it directly needs client-side credentials and a binding needs Worker
runtime code.

**Scope.**

1. **Generate the graph artifact at build time** using Node 24's built-in `node:sqlite` —
   verified available, zero new dependencies. This is a build step, not a server: the build
   host runs Node and the deployed runtime stays fully static. Schema semantics are
   normative per requirements §12.2 — immutable node identity, typed edges, public-only
   context, deterministic ordering, foreign-key integrity, indexed incoming and outgoing
   queries.
2. **Emit a content-addressed artifact set**: `public/data/graph.<hash>.sqlite`,
   `graph-manifest.json` carrying schema version, content version, byte size, sha256, and
   node and edge counts, plus a bounded JSON adjacency fallback.
3. **Load only on explicit user intent.** No fetch during normal article reading. The
   manifest is fetched when a graph feature is invoked; the database follows only if the
   schema and content versions validate.
4. **Query in a dedicated Web Worker**, read-only, using bound parameters and fixed query
   templates. Return structured-clone-safe objects. Idle the worker after a bounded period.
5. **Degrade to TK-17's static layer** on any failure — WASM unsupported, fetch failed,
   schema mismatch, worker timeout. The static graph is always present in the HTML, so
   degradation is the absence of an enhancement, never a blank region.
6. **CSP.** SQLite WASM needs `wasm-unsafe-eval` in `script-src`. That is not
   `unsafe-eval` and permits no string-to-code evaluation. TK-12 already adds it for
   Pagefind, so this ticket adds no new relaxation — verify that and state it.
7. **Budgets** per requirements §12.4: manifest under 10 KB, database warning at 2 MB
   compressed transfer and hard limit at 5 MB, p95 local-neighborhood query under 50 ms
   after worker readiness, and no effect on Largest Contentful Paint.
8. Client library: `@sqlite.org/sqlite-wasm` (3.53.0-build1) or `sql.js` (1.14.1). Pin it,
   and record which and why.

**Acceptance criteria.**

- Zero graph bytes are requested on an article page until the reader invokes a graph
  feature, proven by a test over the built HTML and the module graph.
- With JavaScript disabled, with WASM blocked, and with the database request failing, the
  page still shows TK-17's static graph and every node still links.
- Database content is deterministic for identical input, `PRAGMA integrity_check` returns
  `ok`, and the foreign-key check is empty.
- The JSON fallback returns results identical to the SQLite query for every fixture.
- Manifest hash and byte size match the served asset.
- Query templates use bound parameters; a test asserts no string-concatenated SQL.
- Measured transfer and p95 query latency are recorded against the §12.4 budgets.

---

#### TK-18 — Measured benchmark against Quartz v5

**Requirements:** sections 18, 25; the owner's stated goal

**Problem.** No ticket's success condition is "better than Quartz at X". "Faster than
Quartz" is currently a preference, not a claim: there has been no Lighthouse run, no
LCP/INP/CLS measurement, and no build-time comparison. Both repositories are on this disk,
`Q:/repos/quartz/docs/` is 111 Markdown files, and Quartz is MIT-licensed — the comparison
is available and nobody has run it.

**Scope.**

1. Build the same corpus through both pipelines. Quartz's own `docs/` is the obvious
   choice; convert it into an artifact for our exporter contract, or use the TK-11 fixture
   for both.
2. Measure and record, for an identical article page: total transfer, JavaScript transfer,
   CSS transfer, request count, LCP, INP, CLS, and Lighthouse performance.
3. Measure build wall-clock and peak memory for both at the same corpus size, and at
   roughly 10× by duplication.
4. Record every number with the method used to obtain it, so a later run is comparable.
5. Where we lose, say so and open a ticket. Where we win, the number becomes the claim the
   project is allowed to make.

**Acceptance criteria.**

- A results table with both tools' numbers and the method for each.
- Requirements §18's budgets are checked against the real numbers, and any budget that is
  not actually ambitious relative to Quartz is revised.
- No claim of "faster" or "lighter" survives anywhere in the repository's documentation
  without a number behind it.

---

#### TK-19 — Formalise the artifact contract

**Requirements:** sections 10.1, 10.3, 21.1

**Problem.** The artifact contract is currently defined by whatever one private
`export.py` happens to emit. That was adequate while this repository published one
person's vault; it is not adequate now that the project is to be a reusable publisher
(TK-23), because other users will not have that script. A contract defined by one
implementation is not a contract.

Six defects in the reference implementation are reproduced, and each is really a hole in
the unwritten specification rather than only a bug: wikilinks are rewritten inside code
fences and the edge set derives from the same fence-blind scan, so a note documenting
Obsidian syntax injects a phantom edge that `checkCorpus` proves symmetric and passes; the
frontmatter regex eats content up to a second `---`; wikilink heading anchors are
discarded, which is why TK-07's heading previews ship as a bounded partial; image embeds
degrade to bare words; the excerpt regex turns `Step-by-Step` into `StepbyStep`, and that
string is the meta description, the card, the hover preview, and the search snippet; and
`outgoing` derives from wikilinks only, so a plain Markdown link produces a live anchor
with no backlink on its target and no gate can see it. `created` and `updated` are not
emitted at all, which is why `/recent/` falls back to alphabetical order.

**Scope.**

1. Write the artifact specification as a document any producer can implement against —
   not as a patch list for one script. Field by field: type, constraints, what a consumer
   may assume, and what it must degrade to when a field is absent. `src/lib/schema.ts` is
   the de facto specification today; the written contract must agree with it or the
   disagreement is itself a finding.
2. Give each of the six defects a reproducible test case stated against the specification
   rather than against `export.py`, so a second implementation inherits the same
   requirement.
3. Publish a conformance fixture — a small vault-shaped input and the exact artifact a
   conforming producer must emit from it — so an implementation can be checked without
   reading the reference code.
4. Document the escalation path for a contract change that breaks the build, including the
   known case where two tag labels slug to the same key and no fix is available from the
   consuming repository.
5. State, per pending ticket, which behaviour is blocked on a producer, so nobody builds a
   renderer for a field that will never arrive.

This repository does not implement the producer. It specifies what it consumes.

**Acceptance criteria.**

- One specification document a stranger could implement a producer from, with a
  reproducible test case per defect.
- A conformance fixture pairing an input with its required output.
- The specification and `src/lib/schema.ts` agree, or every divergence is recorded with a
  reason.
- Every blocked behaviour in the backlog names its blocker.

---

#### TK-23 — Generalisation and distribution

**Requirements:** the owner's decision of 2026-08-11; sections 21.1, 21.2

**Problem.** The project is hardcoded to one owner. `export.py` refuses to write anywhere
but a directory named `thoughtscape-publish` and checks `package.json`'s name to prove it;
the vault path is a fixed relative path; the site origin, title, navigation labels, and the
about and privacy copy are literals in the tree. Another user cannot clone this and publish
their own garden.

The target is that a user adds **one GitHub Action to their own notes repository** and gets
a published knowledge garden. That is a different product from what exists, and it is
scheduled **ahead of wave 4** deliberately: building release gates, a benchmark, and
architecture records around single-owner assumptions would mean redoing all three once
those assumptions change.

**Scope.**

1. **Make every site-identifying literal configuration** with a documented default: origin,
   site title, navigation labels, about and privacy copy, and the vault path. The origin
   already has the right shape — `astro.config.mjs` is the single place it is written and
   `tests/metadata.test.ts` fails if it is ever written elsewhere — so this is a change of
   source, not of structure.
2. **The origin becomes deployment-time configuration.** No domain is needed to develop,
   test, or preview. Remove the assumption that a build requires a real origin.
3. **Local preview at `http://publish.localhost/`**, so the local experience needs no
   domain and no hosts-file surgery beyond what `.localhost` already guarantees.
4. **A reusable GitHub Action** a user adds to their notes repository. It must run the
   allowlist export, the build, and every gate `verify` composes, and it must fail closed:
   the privacy scan is the product, not a formality.
5. **Keep the privacy model intact.** The allowlist manifest and the artifact boundary are
   the reason this project exists. Generalising must not turn "publish exactly what the
   manifest names" into "publish the repository".
6. **Document the setup path** end to end for a user who has a notes repository and nothing
   else.

**Acceptance criteria.**

- A second, synthetic notes repository publishes successfully through the Action with no
  edit to this repository's source.
- `pnpm run build` and `pnpm run preview` succeed with no origin configured, and preview is
  reachable at `http://publish.localhost/`.
- No site-identifying literal remains outside configuration, proven by a test.
- The privacy scan runs inside the Action and fails the run on a seeded violation.
- A user-facing setup document, followed start to finish, produces a published site.

---

#### TK-20 — Oxfmt

**Requirements:** owner decision 6

**Scope.** Adopt Oxfmt and format the repository. Land as a single commit against a clean
tree, touching nothing else, so that no feature diff is ever contaminated by a whole-repo
reformat. Verify `.gitattributes` LF normalization survives the pass — TK-02 added it after
CRLF made `git diff --check` fail on 948 lines.

**Acceptance criteria.** Formatting is a no-op on a second run; the full gate passes; the
commit contains no logic change.

---

#### TK-22 — Migrate from npm to pnpm

**Requirements:** owner decision on the toolchain

**Problem.** The repository installs with npm, whose flat `node_modules` lets a module
import a package that is not declared in `package.json`. This project has already been
bitten by the class of problem that prevents: TK-03 deliberately promoted `satteri`,
`github-slugger`, `prismjs`, and `@astrojs/prism` from transitive to direct dependencies,
recording that "leaving them implicit would make the build depend on Astro's private
dependency tree". Three source files still import from packages of that kind
(`satteri`, `github-slugger`, `sanitize-html`), and today nothing structurally prevents a
fourth import of something undeclared.

pnpm's symlinked store makes an undeclared package unresolvable rather than merely
discouraged. **Install speed is not the justification** — 246 packages installed rarely, on
a static site deployed to a CDN, is not where pnpm's performance story pays. The
justification is that an undeclared dependency becomes a loud failure, which is the same
bias every other boundary in this repository takes.

**Scope.**

1. Migrate to pnpm: generate `pnpm-lock.yaml`, delete `package-lock.json`, and remove the
   npm-only `node_modules` before reinstalling so no flat-layout residue survives.
2. Add `packageManager` to `package.json` so the version is pinned and Corepack can honour
   it.
3. Verify Astro's integrations resolve under a symlinked layout. Historically some have
   needed `public-hoist-pattern` or `shamefully-hoist` in `.npmrc`. **Determine this
   empirically** rather than pre-emptively adding a hoist rule — a blanket
   `shamefully-hoist` would recreate the flat layout and discard the entire reason for the
   migration. If a hoist pattern is genuinely required, scope it to the narrowest pattern
   that works and record why.
4. Update every command in `AGENTS.md`, `README.md`, and any script or document that
   invokes npm.
5. Confirm the Cloudflare Pages build works from `pnpm-lock.yaml`. A lockfile the host
   cannot consume is worse than the one it replaces.
6. Land as a single commit against a clean tree, touching nothing else — same discipline as
   TK-20. A package-manager migration mixed into a feature diff is unreviewable.

**Acceptance criteria.**

- `pnpm install` from a clean checkout produces a working tree; `pnpm test`, `pnpm lint`,
  `pnpm run check`, `pnpm run build`, and `pnpm run build:fixture` all pass with the same
  results as before the migration, including the test count.
- `package-lock.json` is gone and `pnpm-lock.yaml` is committed.
- No `shamefully-hoist`. Any `public-hoist-pattern` entry names the package that needs it
  and why.
- An import of an undeclared package fails to resolve, proven by a seeded attempt.
- Every documented command uses pnpm.

---

## 7. Explicitly rejected

Thirty gap findings were reviewed by six independent critique passes. Twelve survive
intact or shrunk; the rest are recorded here so they are not re-proposed.

**Reading the citations.** `C3`–`C8` are the six critique documents (narratives 3–8 of
`.tmp/quartz-evidence.md`). `F<n>` is the finding's number in that file's canonical
gap-findings list; the critiques use their own, different numbering, so proposals below
are keyed by description first. `Verified` means the claim was re-checked against a real
file in this repository.

### 7.1 Violates a hard constraint

| Proposal | Why rejected | Who killed it |
| --- | --- | --- |
| Raw `/notes/<slug>.md` endpoint serving `entry.markdown` (F30) | `sanitize()` is a privacy control, not only a security one — it discards `<iframe>` and `<style>` bodies, `onclick`, and HTML comments that `validateArtifact` accepts. The endpoint routes around it. Constraint 1. | C5, C6, C7, C8; verified (C7 of the factual base) |
| Alias-derived `301` rules in `_redirects` (F10) | `export.py:78-85` `entry_aliases()` returns **vault paths**; `aliases` is validated only for non-empty/no-`/`/no-control-char, so `"Hello World"`, `".."`, `"tags"` and `"pagefind"` all pass. Emits a 4-field line into a 3-field grammar, shadows `/tags/`, and publishes private folder structure. Constraint 1. | C5, C8; verified (C9) |
| `%%` added to `STRUCTURAL_MARKERS` as an Obsidian-comment backstop (F23) | `/%%/.test('for %%i in (*.pfx) do echo %%i')` is `true`. The corpus is a Windows/OpenSSL guide with 8 ` ```cmd ` fences. Fails the build on legal shell syntax, unfixable from this repo. Exporter-only. | C3, C5, C6, C7, C8; verified (C11) |
| `/search/` page with `<form method="get" action="/search">` as the no-JS fallback (F27) | No server can answer the GET. Requirements line 724 specifies `form-action 'none'`, which blocks the navigation outright. `SITE_MAP` (`src/lib/routes.ts:280`) already renders `/tags/` and `/collections/` in every page footer — the fallback is shipped. | C3, C5, C6, C8 |
| Sync-time diagram pipeline: Docker + pinned Chromium/Puppeteer + Java + Graphviz or self-hosted Kroki, plus a staleness-hash gate (F26) | Largest unearned dependency in the set, for zero diagrams in 1,425 vault `.md` files. Superseded by owner decision 5 in any case. | C3, C5, C6 |

### 7.2 Rests on a factual error

| Proposal | Why rejected | Who killed it |
| --- | --- | --- |
| `_headers` cache rules layered "most specific match wins" (F4, F15) | Cloudflare inherits **all** matching rules and comma-joins duplicate header names. The proposed shape emits `Cache-Control: public, max-age=0, must-revalidate, public, max-age=31536000, immutable` on `/_astro/*` — the exact bug the finding opens by diagnosing. Needs `! Cache-Control` or non-overlapping patterns. | C7, C8; verified (C6) |
| `/pagefind/*` served `immutable` (F4) | `pagefind.js`, `pagefind-worker.js`, `pagefind-entry.json`, `wasm.*.pagefind` are stable-named and rewritten every build. A year-cached entry file against fresh index chunks silently breaks search after every republish. | C6 |
| `worker-src 'self'` presented as part of the search fix (F12) | `new Worker("/pagefind/pagefind-worker.js")` is same-origin; `script-src 'self'` already permits it. Only `'wasm-unsafe-eval'` is load-bearing. Keep the directive as documentation, not as the fix. | C7; verified (A3) |
| Lightning CSS "is idle; the transformer switch proves it" (F6) | Vite 8's `build.cssMinify` already defaults to Lightning CSS — the built `--color-shadow:#1b1f2424` is the `#RRGGBBAA` shortening only Lightning CSS performs. `css.transformer` governs a different path. | C7; verified (C4) |
| Lightning CSS lowers `light-dark()` today, deleting the fallback block (F6) | `src/styles/tokens.css:59` wraps every `light-dark()` in `@supports`; nothing lowers unless that guard is deleted **and** `targets` is set. Two critiques measured opposite deltas (+50 gz vs −493 gz), so the byte claim is unmeasured. `tokens.css:79-88` documents why `color-scheme` lives inside the guard. | C4, C7; verified (C5) |
| Speculation Rules shipped as one JSON file plus one `_headers` line (F7) | The header form is not governed by `script-src`, so the proposed CSP test asserts nothing; and the response must be `application/speculationrules+json` or it is ignored. Cloudflare serves `.json` as `application/json` and we set `X-Content-Type-Options: nosniff` globally. Likely outcome: fetched and silently discarded. | C4, C7, C8; verified (C12) |
| Tombstone as `{status:'tombstone', outgoing:[], backlinks:[]}` "needs no schema change" (F20) | `checkCorpus` (`src/lib/schema.ts:384-393`) rejects it whenever a live note still links to the withdrawn one — i.e. exactly when withdrawal matters. The artifact cannot be produced. | C7, C8; verified (C8) |
| `pagefind-highlight.js` is CSP-clean under `style-src 'self'` (F27) | `dist/pagefind/pagefind-highlight.js:1029-1034` creates a `<style>` and sets `innerText`; `addStyles ?? true` fires by default. Blocked. Mitigable with `addStyles:false`, but the constraint check as written is wrong. | C8; verified (C14) |
| `sanitize-html` with an SVG allowlist for committed diagrams (F26) | camelCase allowlist drops `viewBox`/`textLength`; lowercase allowlist emits `viewbox`, which is wrong under XML parsing. No working option with the installed dependency. | C8; verified (C13) |
| "Build the reverse backlink index as a `Map` rather than filtering per page" (F19) | `src/lib/content.ts:19` already builds `bySlug` once; `getEntry` is O(1); `[slug].astro:33` reads `entry.backlinks` directly. There is no O(N·E) filter here — that is Quartz's bug. | C3, C5; verified (B7) |
| `data-pagefind-filter="lang"` for bilingual search (F21) | `dist/pagefind/pagefind-entry.json` already reads `{"languages":{"en":{…}}}` with no configuration. The finding says so and proposes the filter anyway. The real bilingual defect is query-time: `findIndex()` reads `<html lang>` and loads **one** index, so English notes are unfindable from a `zh-CN` page. `mergeIndex` exists and nothing calls it. No finding proposed that. | C3, C5, C6; verified (B9, D2) |
| `CONTENT=… npm run build` env-selectable content (F18) | `src/lib/content.ts:10` is a static `import … with { type: 'json' }`; a `process.env` branch needs `await import`, which makes `entries` a promise and breaks every synchronous `getStaticPaths()`. `scripts/validate-content.ts:14` also hardcodes the path, so the projection gate would compare the wrong artifact. | C3, C5, C6, C8; verified (C10) |
| `description ?? excerpt` as the fix for the bad excerpt (F28) | The root cause is `export.py:21` `MARKDOWN = re.compile(r'[\`*_>#-]+')` applied line-wise: `--no-verify` → `noverify`, `well-known` → `wellknown`. `description` is never emitted (`export.py:162-171` writes six fields), so the fallback is the only live path. Four `.astro` edits conceal it. | C4, C5, C6; verified (D6) |
| Bounding `description` at ~300 chars (F28) | Adds a validation rule for a field no producer emits. The real defect is that `validateArtifact` bounds **nothing** — a 3 MB `markdown` and 5,000 tags both pass, and 5,000 tags is 5,000 routes against `REDIRECT_LIMIT = 2000` (`src/lib/routes.ts:231`). Bound the fields that exist. | C3; verified (C18) |

### 7.3 Over-engineered for this corpus

The corpus is one note, six fields, zero edges, zero tags, zero collections, zero
callouts, zero images, zero diagrams, zero math. The nine optional schema fields
(`src/lib/schema.ts:67-77`) are **unproduced**, not merely absent.

| Proposal | Why rejected | Who killed it |
| --- | --- | --- |
| Edge objects `{to, anchor, text, context}` + triple-keyed inversion proof + `version: 2` break (F19) | Rewrites the one invariant that makes the relationship surface trustworthy, to serve a `<aside>` that has never rendered. Also dead on arrival: `export.py` discards wikilink `#heading` fragments before the artifact is written. | C3, C4, C5, C6; verified (D4) |
| `previous_slugs` + collision rule + redirect emission (F20) | Also superseded — see 7.5. | C3, C5 |
| `translation_of` + symmetric-group validation + `hreflang` + `x-default` + switcher + per-language feeds (F21) | Four subsystems for zero translation pairs, on a corpus whose one entry carries no `language` field. `<html lang>` already works (`Layout.astro:28`); `hreflang` is three lines when a pair exists. | C3, C5, C6 |
| Code fence metadata grammar (`title="…"`, `{1-3,5}`, `showLineNumbers`) + `figcaption` and `.line` allowlist widening + CSS counters (F22) | 8 fences, all bare ` ```cmd `, zero meta. Prism tokens span newlines, so per-line wrapping means splitting generated HTML across open spans — a harder second `namespaceTokenClasses` (`src/lib/markdown.ts:255`), the most fragile code in the module. | C3, C5, C6 |
| Nested `collection` segments + `order` + prev/next + `<details>` explorer tree (F25) | Zero collections exist; `collectionFacets` has produced zero facets in every build. `order` is a second ordering axis the exporter must keep consistent by hand. | C3, C5, C6 |
| Per-slug `/previews/<slug>.json` emitter + per-slug cache + rewritten projection gate (F2) | `public/content-index.json` is **404 bytes**. Replaces one total `JSON.stringify` equality (`scripts/validate-content.ts:36`) with N per-file comparisons plus an extra-files check — strictly weaker and strictly more code. Its headline guarantee already holds at `link-preview.ts:41`. | C3, C5, C6; verified (B3, B4, B6) |
| Six ratcheted performance budgets + build wall-clock ceiling + manifest table (F3) | Five of six keep the disease they diagnose: "JS ≤ 8 KB gz" against a measured 1,574 gz. A wall-clock ceiling is flaky and there is no CI. Exactly one assertion is binary and can fail today: zero search/preview bytes requested before user intent. | C3, C4, C5, C6 |
| `build-manifest.json` + `execSync('git rev-parse HEAD')` + freshness gate (F16) | Any content-hashed filename in the served HTML (`dist/_astro/Layout.uZ0PEUxZ.css`) already answers "which build is live". One operator, no CI. | C3, C5, C6 |
| `scripts/review-content.ts` (~60 lines, `node:util` `diff`) (F17) | `git diff --word-diff --word-diff-regex='[^[:space:],]+' -- src/data/content.json` renders legibly on the single-line `markdown` field. One `package.json` line, no config, no version dependency. | C3, C5, C6 |
| Reading time / word count via `Intl.Segmenter` (F29) | Zero requirement mentions. Needs an uncalibrated per-language wpm constant, and the proposal re-opens `TOC_MIN_HEADINGS`, whose rationale is already written down at `src/lib/markdown.ts:86-95`. | C3, C5, C6 |
| `llms.txt` (F30) | On this corpus, a site title and one bullet. TK-08's sitemap is already the machine-readable index; this is a second publication surface with its own cache rule, asset-allowlist entry, and header story. | C3, C5, C6 |
| Quartz's 13-kind callout colour vocabulary and `mask-image` icon set; task-list and footnote styling (F24) | Zero callouts, zero task lists, zero footnotes in the corpus. Style the classes that actually ship: `token-*` (21 spans), `code-block` (8), `heading-anchor` (15), plus a 4-line `sr-only` recipe as insurance. | C3, C5, C6; verified (A6, A7) |
| A TK-09 gate extracting every class `markdown.ts` can emit and asserting each has a CSS rule (F24) | A fourth consumer of `tests/css-cascade.ts`, the 397-line hand-written parser whose own TK-02 report found five bugs that had silently disarmed real gates. The allowlist at `markdown.ts:579-595` is twelve literals — read them once. | C3, C5, C6 |
| Hand-rolled Pagefind result renderer over the core API (F1) | `pagefind-modular-ui.js` is 4,244 B gz and already sits in `dist/`. Writing keyboard nav, sub-results, and excerpt markup to save 4 KB is rung-5 failure. | C3, C5, C6; verified (A2) |
| "Steal the density-maximizing excerpt window" (F27) | Pagefind already returns excerpts. | C3, C5 |
| A test that gunzips a `.pf_fragment` and strips its 12-byte prefix, plus `data-pagefind-ignore` threaded through `markdown.ts` and the sanitize allowlist (F5) | `pagefind --site dist --exclude-selectors ".heading-anchor,.copy-code,.back-home"` fixes titles, `Copy`, and the `← All notes` chrome in one build-script flag — no allowlist widening, no decompression test. | C6; verified (B10) |
| Self-hosted woff2 subsystem: `size-adjust`, `ascent-override`, `font-display`, `<link rel=preload as=font crossorigin>`, its own budget (F9) | A subsystem hanging off a one-token deletion. Delete `Inter,` from `src/styles/tokens.css:99`. Stop. | C3, C5, C6 |
| `assets[]` schema `{path,width,height,alt,hash,kind}` + fail-closed inventory gate + hash staleness gate (F8, F26) | Zero images. The real risk closes with two deletions available today: `img-src 'self' data: https:` → `'self' data:` in `public/_headers`, and `allowedSchemesByTag.img` → `['data']` plus relative paths. `width`/`height` become required when the first image appears. | C3, C5, C6 |
| 25-alias callout canonicalization map; custom task chars `[?]`/`[!]`/`[/]` (F23) | Measured occurrences in the corpus: 0, 0, 0. | C3, C5, C6 |

### 7.4 Duplicate of another finding

| Proposal | Why rejected | Who killed it |
| --- | --- | --- |
| F1 + F27 + F12 — three findings proposing the lazy Pagefind stylesheet, the move off the Default UI, and `'wasm-unsafe-eval'` | One four-line change plus one `_headers` edit. Merge into the TK-06 search item. | C3, C5, C6 |
| F4 + F15 + parts of F12 — four findings editing `public/_headers` and each proposing a test that parses it | Six lines of file, contended by four tickets. One edit, one table-driven test. | C3, C5, C6 |
| F10 + F20 — two tombstone/withdrawal findings proposing the same `published` filter and the same enumeration test | One item, and both halves are inert until the exporter emits `status`. | C3, C5, C6 |
| F8 + F26 — two image-contract findings | One item, reduced to the two permission deletions. | C3, C5 |
| F30's `llms.txt` as "the machine-readable projection surface" | TK-08 owns the sitemap. Same job, already ticketed. | C3, C5, C6 |
| F4's `/previews/*` cache rule | Caches a route class from F2, which does not ship. | C3, C5 |

### 7.5 Superseded by an owner decision

| Proposal | Why rejected | Who killed it |
| --- | --- | --- |
| `previous_slugs` field + rename-redirect emission (F20) | Owner decision 3: slug renames are delete-and-recreate; old URLs may 404, and the exporter emits no `previous_slugs`. This closes requirements §9.3's mutable-slug-with-redirect as deliberately not implemented. | Owner decision 3 (C3, C5 independently) |
| Docker + Puppeteer/Chromium + Java + Graphviz/Kroki for byte-stable diagram rendering (F26) | Owner decision 5: Mermaid is dual-mode with **client-side by default**; build-time mode renders 23/23 diagram types deterministically per-process via a ~90-line post-processing pass. Owner decision 4 defers PlantUML. | Owner decisions 4 and 5 |
| Append `&& node --test` to the `build` script (F13) | Owner decision 6 adopts Vitest in place of `node --test`. The intent — gates run in the release path — stands; the command does not. | Owner decision 6 |
| Enable `vite.css.transformer = 'lightningcss'` to delete the fallback palette (F6) | Owner decision 6 settles the Rust toolchain question; Lightning CSS already minifies our CSS (verified C4). What remains is a `targets` decision that rewrites `global.css` too and breaks the `palette()` regex at `tests/design-tokens.test.ts:43`. Unmeasured, P2, not a ticket. | Owner decision 6; C4, C6, C7 |
| C3/C5/C6's kill of the `<details>` explorer tree and the sidebar surface | **Partially reversed.** Owner decision 1 puts sidebars and rails in scope. The kill stands only for nested `collection` segments and the `order` field, which need a schema change the exporter cannot satisfy. | Owner decision 1 overrides C3, C5, C6 |
| C6's "delete `link-preview.ts` and `route-path.ts` goes with it" | Previews remain in scope as TK-07. The observation that there are **zero** in-prose note links to preview (`grep -o 'href="/notes/' dist/notes/*/index.html` → 0) is correct and should size the ticket, not cancel it. | Owner scope; C6 overruled |

### 7.6 Contradictions the critics found between proposals

| Contradiction | Resolution | Reason |
| --- | --- | --- |
| **F24 wires up the `copy-code` button; F5 deletes it.** Flagged independently by C3, C5, C6, C8 — the most-cited contradiction in the set. | **Delete.** | Deletion is the smaller diff, and the button is not neutral: `src/lib/markdown.ts:437-441` emits it, `:708` forces it `hidden`, it has zero CSS and zero handler (verified A5), and it welds `Copy` onto all 8 indexed code blocks. TK-05 may reintroduce it in the same commit as its handler and its CSS — the only point at which it stops being dead. |
| **F30 wants `llms.txt` (every title, URL and description in one GET); F2 wants `content-index.json` deleted because a one-GET title-and-excerpt manifest is a disclosure.** Neither cites the other. C4 flags it. | **The disclosure argument is void for both. Ship neither route.** | `dist/index.html` already renders every title *and* every excerpt via `NoteList.astro`, `robots.txt` is `Allow: /`, and TK-08's sitemap will enumerate every slug. F2's only surviving argument is bytes, and the file is 404 B. |
| **Three findings, three `form-action` values**: F27 needs a GET form to work, F4 proposes `'none'`, F12 proposes `'self'` while claiming to match a baseline that says `'none'`. C8 flags it. | **`form-action 'none'`, per requirements line 724. The `/search/` GET form does not ship.** | C15 disproves the objection that `'none'` breaks the search dialog: `Layout.astro:49`'s `<form method="dialog">` returns before `action` is parsed and never navigates. The only thing `'none'` blocks is a GET form a static host cannot answer anyway. |
| **F17's diff script needs `node:util` `diff`; F11 pins `.nvmrc` at 22.18.** C8 flags the version risk. | **Moot — F17 is rejected in favour of `git diff --word-diff`.** | `util.diff` is confirmed on Node 24.18.1 only; `git diff --word-diff` needs no config and no version check. |
| **C3 measures Lightning CSS at +50 B; C7 measures −493 B gz.** Both claim measurement. | **Treat as unmeasured.** | They measured different transforms: C7 shows the lowering only fires with `targets` set, and C3 measured with the `@supports` guard still in place. Nothing depends on the number, so nothing blocks. |
| **F5 threads `data-pagefind-ignore` through the sanitize allowlist; C6 proposes `--exclude-selectors`.** | **`--exclude-selectors`.** | One flag in the build script the tool already runs (verified B10), against a schema change, an allowlist widening, and a gunzip test. Same three defects fixed, including the `← All notes` chrome at `src/pages/notes/[slug].astro:25` that F5 missed. |
| **F4 wants `/pagefind/*` `immutable`; C6 shows that breaks search after republish.** | **C6.** | `pagefind-entry.json` and `wasm.*.pagefind` are stable-named and rewritten every build; only `/pagefind/index/*` and `/pagefind/fragment/*` are content-hashed. |

### 7.7 Over-engineering already in the tree

Nobody proposed adding these. They are already merged, and shrinking them is cheaper than
any feature on the list.

| Code | Why it should go or shrink | Who named it |
| --- | --- | --- |
| Legacy `/<slug>/` redirect machinery — `redirectRules` (`src/lib/routes.ts:213-224`) emits **2 rules per note**, guarded by `REDIRECT_LIMIT = 2000`, a `renderRedirects` throw (`:252`), a cycle-walk test, and 40 lines of doc comment | A migration away from a URL shape that was never publicly served: `/<slug>/` was introduced at `3831ad0` and superseded at `04f8d9c`, all in an unpushed history, with no `site:` in `astro.config.mjs` and zero `rel="canonical"` in `dist/`. Delete the legacy pair and the limit machinery goes with it. | C6; verified (E) |
| `tests/css-cascade.ts`, 397 lines of hand-written CSS parsing, with three dependent test files | Its own TK-02 report recommends **replacing** it with a rendered check rather than deepening it, after round two found five parser bugs that had silently disarmed real gates. Three rejected proposals (F24's class gate, F3's budgets, F6's transformer switch) each wanted to add a fourth consumer. | C3, C5, C6 |
| `src/lib/route-path.ts` — a 31-line module with its own docstring, existing solely so `link-preview.ts` does not drag `SITE_MAP` into the browser bundle | The split is currently justified (Rolldown could not drop the array literal) but serves a feature with **zero** in-prose note links to preview. Keep it only as long as `link-preview.ts` ships; it is one file, not a module boundary worth defending. | C6 |
| `copy-code` button markup (`src/lib/markdown.ts:437-441`, forced `hidden` at `:708`) plus its `button` entries in `allowedTags`/`allowedAttributes`/`allowedClasses` | 8 buttons per article, zero CSS, zero handler, ~672 raw bytes, and it corrupts every indexed code block. Pure deletion. | C3, C5, C6, C8; verified (A5) |
| The unconditional `<link href="/pagefind/pagefind-ui.css">` at `src/layouts/Layout.astro:76` | 2,599 B gz on all 7 routes for a dialog most readers never open — 26% of the measured 10,119 gz first paint. A worse failure mode also hides here: if `emit:redirects` throws, `&&` stops the chain, `pagefind --site dist` never runs, and every page ships a 404ing render-blocking stylesheet that `pnpm run preview` serves happily. | all six; verified (A1, A11) |
| `RenderedNote.toc` / `.headings` / `.hasCode` / `.hasMath` / `.hasMermaid` — computed every render, zero consumers across `src/pages`, `src/components`, `src/layouts`, `src/scripts` | **Do not delete.** C6 lists these as dead weight; owner decision 7 makes them the per-page lazy-load gate. Wire them up in TK-05, do not remove them. | C6 named it; owner decision 7 overrides |

---

## 8. Open decisions for the owner

Everything already settled is out of this list: sidebars are in scope, math is Temml, slug
renames are delete-and-recreate, PlantUML is deferred, Mermaid is dual-mode with
client-side default, the toolchain is Vitest plus Oxlint plus Oxfmt, and heavy assets lazy
load per page. What remains are genuine forks.

### D1 — The exporter boundary

`p0-implementation-tickets.md:26-29` declares the exporter not writable from this
repository. Six defects sit behind that boundary, reproduced from its 210 lines:

| Defect | Consequence here |
| --- | --- |
| `WIKILINK.finditer` runs over raw Markdown with no node awareness | Wikilinks are rewritten inside code fences, and `outgoing`/`backlinks` derive from the same fence-blind scan — so a note documenting Obsidian syntax injects a phantom edge that `checkCorpus` proves symmetric and passes |
| `FRONTMATTER` regex is `\A---\s*\n.*?\n---\s*\n` with `DOTALL` | A note opening with a thematic break loses everything up to the second `---` |
| Wikilink heading anchors sit in a non-capturing group | `[[Other#Prerequisites]]` degrades to a page-top link |
| `![[diagram.png]]` becomes the literal word `diagram.png` | Image embeds become garbage mid-sentence; the residue scan only looks for `[[`, so no gate sees it |
| `MARKDOWN = re.compile(r'[\`*_>#-]+')` applied per line in `excerpt()` | `Step-by-Step` becomes `StepbyStep`; that string is the meta description, the card, the hover preview, and the search snippet |
| `outgoing` derives from wikilinks only | A plain Markdown link renders a live `<a>` with no backlink on the target, so "Linked from" is systematically incomplete and no gate can see it |

If the boundary holds, several downstream behaviours are permanently blocked and their
tickets should say so rather than building renderers for fields that will never arrive. If
it does not, five of the six are one regex each. `.harness/tests/test_publish.py` has 13
tests and none covers frontmatter stripping, excerpt generation, or fence awareness.

**Recommendation:** hold the boundary for code, break it for specification. TK-19 writes the
contract change with a reproducible test case per defect; the exporter's owner implements
it. This gates more than any single ticket, so decide it before wave 2 starts.

### D2 — Is the Svelte mandate stale?

Requirements §11.3 specifies Svelte islands as the interaction layer, with a per-island
contract covering hydration trigger, JavaScript budget, accessible fallback, error
boundary, and state model. Nothing has installed Svelte. TK-02 delivered theming and reader
mode in pure CSS at zero JavaScript, and search plus previews are 1,067 B gzip of plain
TypeScript. Either the requirement is stale or two tickets are wrong, and nobody has
written down which.

**Recommendation:** the requirement is stale for the current surface. A framework earns its
place at the Phase 2 interactive graph, not before. TK-10 records this rather than leaving
the contradiction unwritten.

### D3 — Is a rendered viewport check worth a Playwright dependency?

TK-02's 320 px overflow check is syntactic: it proves no CSS rule commits to an over-wide
box, but never measures a rendered page. Its own report names this the weakest evidence in
that ticket. Vitest browser mode with Playwright would measure it properly.

Half of this question is already answered — the Mermaid probe established that build-time
diagram rendering needs only `happy-dom`, no Chromium — so the dependency would exist
solely for the viewport check and any future rendered assertion.

**Recommendation:** adopt it in TK-13. The alternative is `tests/css-cascade.ts`, a 397-line
hand-written CSS parser whose own review found five bugs that had silently disarmed real
gates, and three separate proposals wanted to add a fourth consumer to it. A real browser
replaces the parser rather than deepening it.

### D4 — Does a published-but-unlisted state exist?

Quartz has `unlisted`, documented as security by obscurity: the HTML still ships and the
page is still served to anyone holding the URL. Worse, unlisted titles remain inferrable
from neighbours' link arrays, because `CrawlLinks` still recorded the edges pointing at
them.

We have no such state. `status` admits only `published` and `tombstone`
(`src/lib/schema.ts:23`), and the obvious tombstone shape — `{status: 'tombstone',
outgoing: [], backlinks: []}` — cannot be produced: `checkCorpus`
(`src/lib/schema.ts:384-393`) rejects it whenever a live note still links to the withdrawn
one, which is exactly when withdrawal matters.

**Recommendation:** decide that there is no unlisted state, and make withdrawal work
instead. Withdrawal here already beats Quartz's — removing an entry from the manifest
removes it from the artifact, from `dist/`, and from the search index, leaving nothing to
serve. What needs fixing is the tombstone shape, which is a TK-01 schema question plus one
test enumerating every listing surface. If you do want an unlisted state, it needs an
artifact field the exporter does not emit, which makes it a D1 item.

### D5 — Is `/graph/` P0 or P1?

TK-17 is the single item on the board that a reader would experience as better rather than
merely cleaner, and it is the clearest content for the stated goal of being more feature
rich. It is also the largest new ticket. Requirements §9.1 lists the route, so shipping
without it means shipping against the requirements document.

**Recommendation:** P0, scheduled in wave 3. If the launch date binds, the honest move is to
amend §9.1 rather than quietly omit the route.

### D6 — Settled: the relationship store

Recorded here because it closes requirements §12.5, DR-4, and DR-5, and because the wrong
version of it keeps resurfacing.

**D1 is permanently rejected, not deferred.** A browser calling D1 directly would need
client-side credentials, and a D1 binding needs Worker or Pages runtime code — both
contradict the static-first principle. Requirements §12.5's escalation path and DR-5 are
closed as "will not happen"; TK-10 records this.

**The graph ships in two layers.** TK-17 renders a build-time static SVG baseline with real
`<a>` elements, crawlable and keyboard-navigable and working with JavaScript disabled.
TK-21 adds an optional SQLite-WASM layer for the queries the build cannot precompute —
multi-hop traversal and relationship filtering — loaded lazily on explicit intent and
degrading to the baseline on any failure.

**Backlinks stay build-time static HTML** and must not move into a query. They are already
correct at `src/pages/notes/[slug].astro:28-38`, which is what requirements §13.1 and §12.3
specify and what Quartz also does. Moving them would cost roughly 900 KB of WebAssembly,
require `wasm-unsafe-eval`, and make them invisible without JavaScript — a regression on a
capability where we are already at parity.

**The `.db` artifact is generated at build time with Node 24's built-in `node:sqlite`** —
verified available, zero new dependencies. This is a build step, not a server: the build
host runs Node and the deployed runtime stays fully static.
