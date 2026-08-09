# P0 Implementation Tickets

**Status:** Active backlog
**Derived from:** [`docs/public-knowledge-garden-requirements.md`](../public-knowledge-garden-requirements.md) sections 8.1, 9, 10, 13.1, 15, 16, 17, 18, 19, 20, 22, 25
**Scope:** Phase 1 (static reader foundation). Phase 2–4 are out of scope; see TK-10.
**Execution model:** One ticket per implementation agent, strictly sequential.

## Resolved owner decisions

The requirements document (section 27) permits proceeding on the recommended
defaults. This backlog adopts them:

| Question | Adopted answer |
| --- | --- |
| Q1 relationship store | Static relationship lists at launch; SQLite WASM graph deferred to Phase 2 |
| Q2 information architecture | Curated collections independent of private folder structure, degrading to a flat note namespace while the artifact carries no collection field |
| Q3 publishing cadence | Owner-triggered reviewed releases |
| Q4 URL and deletion policy | Stable public identity, mutable slugs with permanent redirects, tombstone for withdrawal |
| Q5 first launch scope | P0 static reader, search, previews, static backlinks |
| Q6 visual direction | Bespoke calm knowledge-garden design |
| Q7 languages | Mixed zh-CN/English content with per-document language metadata, one navigation language |
| Q8 analytics and feedback | None at launch |

## Repository boundaries that constrain every ticket

- The exporter (`../thoughtscape/ob-flow/.harness/publish/export.py`) lives in the
  private vault and is **not** writable from this repository. Tickets consume the
  generated artifact contract and validate it; they never reimplement or edit the
  exporter.
- The artifact currently emitted is `{version, entries[{slug, title, excerpt,
  markdown, outgoing, backlinks}]}`. Richer fields from requirements section 10.1
  (`public_id`, `created`, `updated`, `language`, `tags`, `collection`, `status`,
  `aliases`) are **optional**: the site must accept them when present and degrade
  cleanly when absent. No ticket may fabricate them.
- The exporter rewrites public wikilinks to `/<slug>/`. Any route change in this
  repository must rewrite those hrefs at build time rather than demand an exporter
  change.
- Publication and deployment are external side effects requiring explicit owner
  approval. No ticket may deploy, push to a remote, or configure a hosting target.
- No stateful runtime service (D1, R2, Functions, analytics, comments).

## Global definition of done

Every ticket is complete only when all of the following hold:

1. `pnpm run build` passes from a clean tree.
2. `pnpm run check` (type checking) passes.
3. The ticket's own tests pass under `pnpm test`.
4. `git diff --check` passes.
5. Built output contains no `msw/`, no unresolved `[[wikilink]]`, no absolute local
   path, and no private-vault path fragment.
6. A `/code-review xhigh` pass returns no actionable findings.
7. Work is committed with a conventional-commit message.

## Ticket order

Dependency first, then priority. Each ticket may assume all lower-numbered tickets
are merged.

| ID | Title | Depends on |
| --- | --- | --- |
| TK-01 | Content contract, typed loader, validation, and test harness | — |
| TK-02 | Design system, layout shell, accessibility and responsive baseline | TK-01 |
| TK-03 | Build-time Markdown rendering pipeline | TK-01 |
| TK-04 | Public route model, collections, tags, redirects, and 404 | TK-01, TK-03 |
| TK-05 | Page anatomy and static relationship surfaces | TK-02, TK-03, TK-04 |
| TK-06 | Search | TK-02, TK-04 |
| TK-07 | Hover and focus previews | TK-02, TK-04 |
| TK-08 | Canonical metadata, feeds, sitemap, robots, and social cards | TK-04 |
| TK-09 | Privacy, security, and performance release gates | TK-01…TK-08 |
| TK-10 | Architecture decision records and deferred-scope documentation | TK-01…TK-09 |

---

## TK-01 — Content contract, typed loader, validation, and test harness

**Requirements:** sections 6, 10.1, 10.2, 20, 22.1, 22.2, 25

**Problem.** `src/data/content.json` is imported directly by pages with no schema
validation and no type safety. A malformed or privacy-violating artifact would
build successfully. There is no test runner.

**Scope.**

1. Define one authoritative content schema module. Required fields: `version`,
   `entries[].slug`, `title`, `excerpt`, `markdown`, `outgoing`, `backlinks`.
   Optional fields accepted when present: `public_id`, `created`, `updated`,
   `language`, `tags`, `collection`, `status`, `aliases`, `description`.
   Unknown fields must be rejected rather than silently passed through, so that a
   future exporter change is a loud failure instead of a privacy risk.
2. Validate at build time. An invalid artifact must fail `pnpm run build` with a
   message naming the offending entry and field.
3. Enforce artifact invariants:
   - slug uniqueness;
   - slug format (lowercase, `[a-z0-9-]`, no leading/trailing hyphen);
   - slug is not a reserved route segment (`notes`, `tags`, `collections`,
     `recent`, `graph`, `search`, `about`, `privacy`, `404`, `rss`, `sitemap`,
     `pagefind`, `data`, `wasm`);
   - every `outgoing` and `backlinks` slug resolves to a published entry;
   - `backlinks` is the exact inverse of `outgoing` across the corpus;
   - both arrays are sorted and duplicate-free;
   - no entry links to itself.
4. Enforce privacy invariants on the artifact: reject any entry whose serialized
   form contains `msw/`, `[[`, a Windows drive path, a `file://` URL, or a
   `javascript:`/`vbscript:`/`data:` URL outside of an allowlisted image data URI.
5. Provide a typed accessor used by all pages instead of raw JSON imports.
6. Add local fixtures under `tests/fixtures/` covering: a valid minimal artifact,
   a valid rich artifact using every optional field, and one fixture per rejected
   invariant. Fixtures are synthetic; never copy private content.
7. Add a test runner. Use the Node built-in test runner (`node --test`); do not add
   a test framework dependency. Wire `pnpm test`.
8. Add `pnpm run check` for type checking, and make `pnpm run build` depend on
   validation.

**Acceptance criteria.**

- A deliberately corrupted artifact fails the build with a precise error.
- Every invariant above has a failing-fixture test proving it is enforced.
- The rich fixture round-trips through the loader with optional fields intact.
- Existing pages render unchanged for the current real artifact.

---

## TK-02 — Design system, layout shell, accessibility and responsive baseline

**Requirements:** sections 9.2, 16, 17, 19.2, 19.3

**Problem.** The current CSS is a single flat sheet with a hardcoded dark theme,
no tokens, no light mode, no skip link, no focus styling, no print styles, and no
CJK typography handling. `Layout.astro` hardcodes `lang="en"` even though content
is bilingual, and mixes an inline `<script>` block that the target CSP forbids.

**Scope.**

1. Introduce design tokens for color, type scale, spacing, radius, elevation,
   motion, and content width. Provide light and dark palettes that both meet WCAG
   2.2 AA contrast.
2. Theme behavior: follow `prefers-color-scheme` by default, plus an explicit
   user toggle persisted in `localStorage`. The toggle must work without a flash
   of incorrect theme while keeping `script-src 'self'` — use an external script
   loaded before first paint, never an inline script or inline event handler.
3. Reader mode: a distraction-reduced layout toggle using the same mechanism.
4. Layout shell: skip link, semantic landmarks (`header`/`nav`/`main`/`footer`),
   correct heading order, visible focus states, accessible names for all icon-only
   controls, and no information conveyed by color alone.
5. Move every inline `<script>` out of `Layout.astro` into external modules under
   `src/scripts/` bundled by Astro, so the built HTML contains no inline script
   and no inline event handler.
6. `lang` must come from document metadata when present and fall back to the site
   navigation language otherwise.
7. Responsive behavior: mobile-first single column; tablet collapsible panels;
   desktop centered article with optional side rails. No horizontal overflow at
   320 CSS px on any page.
8. Prose measure of roughly 65–80 characters; CJK and mixed zh/en line breaking
   handled explicitly (`word-break`, `line-break`, `text-wrap`, font stack with a
   CJK fallback).
9. `prefers-reduced-motion` respected everywhere.
10. Print stylesheet: article, metadata, and canonical URL without interactive
    chrome.

**Acceptance criteria.**

- Built HTML contains zero `<script>` blocks with inline content and zero `on*`
  attributes; a test asserts this over `dist/`.
- Theme and reader-mode toggles work, persist, and degrade to the system theme
  with JavaScript disabled.
- No horizontal overflow at 320 px, verified by a test or documented manual check.
- Contrast ratios documented for both themes.

---

## TK-03 — Build-time Markdown rendering pipeline

**Requirements:** sections 8.1, 15.1, 15.2, 19.2

**Problem.** Rendering happens per page with `marked` plus a broad
`sanitize-html` default allowlist, produces no heading anchors, no table of
contents data, no syntax highlighting, and applies no policy to math, Mermaid, or
image alt text.

**Scope.**

1. Build one rendering module that converts artifact Markdown to sanitized HTML
   plus structured metadata (heading tree, whether the page contains code, math,
   or Mermaid). Prefer the already-installed toolchain; climb the dependency
   ladder before adding anything new, and justify each new dependency in the
   report.
2. Support: GitHub-flavored Markdown, tables, footnotes, task-list visual states
   (non-interactive), callouts, code fences with build-time syntax highlighting
   and a copy affordance, headings with stable slugified anchor ids and
   deduplication, and image embeds with explicit alt text.
3. Math and Mermaid: render at build time where a dependency-light path exists.
   If not, downgrade to a fenced/plain rendering rather than shipping a runtime
   renderer, and record the decision. Never inject runtime `eval`-based renderers
   that would require weakening the CSP.
4. Rewrite internal anchors: hrefs of the form `/<known-slug>/` are rewritten to
   the canonical route form owned by TK-04. The mapping must be injected, not
   hardcoded, so TK-04 can wire it.
5. Sanitization: replace the permissive default allowlist with an explicit
   allowlist of tags, attributes, and URL schemes. Allow only `http`, `https`, and
   `mailto`. Forbid `iframe`, `object`, `embed`, `form`, `style` attributes, and
   all event handler attributes. Assert that sanitization runs after every
   transform, not before.
6. Extract a table-of-contents structure for pages above a length threshold, for
   TK-05 to render.
7. Rendering must be deterministic: identical input produces byte-identical HTML.

**Acceptance criteria.**

- Unit tests cover each supported construct and each rejected construct from
  section 15.2, including script injection through raw HTML, `javascript:` URLs
  with obfuscated whitespace or entities, and unsupported embeds.
- Determinism test: rendering the same fixture twice yields identical output.
- Heading anchor ids are unique and stable across builds.
- No dangerous construct survives sanitization in any fixture.

---

## TK-04 — Public route model, collections, tags, redirects, and 404

**Requirements:** sections 9.1, 9.3, 8.1, 20

**Problem.** Notes live at `/<slug>/`, which collides with the reserved segments
the route model needs. There are no tag, collection, recent, about, privacy, or
404 routes, and no redirect mechanism.

**Scope.**

1. Move note pages to `/notes/<slug>/` and wire the TK-03 link rewriter so
   in-content links point at the canonical route.
2. Emit permanent redirects from the legacy `/<slug>/` path to `/notes/<slug>/`
   for every published slug, expressed as static host rules that Cloudflare Pages
   honors, plus an equivalent in-repo record. Test the redirect map for cycles and
   for collisions with reserved segments.
3. Add routes: `/tags/`, `/tags/<tag>/`, `/collections/`, `/collections/<slug>/`,
   `/recent/`, `/about/`, `/privacy/`, and a static `404`.
4. Tag and collection routes build from artifact fields when present. When the
   artifact carries no tags or collections, the index routes must render an
   explicit, honest empty state rather than 404 or fabricate groupings.
5. `/recent/` orders by `updated` then `created` when present, falling back to a
   documented deterministic order otherwise.
6. `/about/` and `/privacy/` state what the site is, what the publication boundary
   is, and that no analytics, comments, or third-party tracking run. Content is
   public-safe and must not describe the private vault's structure.
7. Every route must be reachable from navigation or a sitemap-visible link; no
   orphan routes.

**Acceptance criteria.**

- A test enumerates built routes and asserts the expected set exists with no
  unexpected extras.
- Redirect map is acyclic, collision-free, and covers every published slug.
- Reserved-segment slugs are rejected by TK-01 validation, proven by a test.
- Empty tag and collection states render correctly against the minimal fixture.

---

## TK-05 — Page anatomy and static relationship surfaces

**Requirements:** sections 9.2, 13.1, 13.2 fallback, 8.1

**Problem.** A note page currently renders a back link, the article body, and a
bare backlink list. Requirements section 9.2 specifies thirteen elements.

**Scope.**

1. Compose the note page in the specified order: skip link, header and search
   trigger, breadcrumbs, title and public metadata, optional summary, table of
   contents on sufficiently long pages, sanitized article content, outgoing public
   links, static backlinks, related-note fallback list, previous/next or collection
   navigation where meaningful, footer with public provenance and canonical URL.
2. Breadcrumbs derive from the public collection hierarchy or a documented default
   (`Home / Notes / <title>`). They must never reflect private folder names.
3. Table of contents renders from TK-03 heading data as static HTML; active-section
   highlighting is an optional enhancement that must degrade to a plain list.
4. Static backlinks render source title, source route, optional source heading, and
   a bounded sanitized context excerpt when the artifact supplies one, in a stable
   sort order, with no JavaScript required.
5. Related-note fallback: a deterministic, documented rule (shared tags, shared
   collection, or shared neighbors) producing a bounded list. The derivation rule
   must be stated in the page or in documentation.
6. Empty states for zero backlinks and zero outgoing links are explicit, not
   silently omitted, and a large-backlinks state remains readable.
7. The local-graph slot ships as the accessible list/table representation only.
   The interactive island is Phase 2 and must not be stubbed in.

**Acceptance criteria.**

- Every section 9.2 element is present or explicitly justified as not meaningful
  for the current artifact.
- Backlink rendering matches the artifact edges exactly, proven by a test.
- Page is fully readable and navigable with JavaScript disabled.
- Long, empty, and large-backlink fixtures all render without layout breakage.

---

## TK-06 — Search

**Requirements:** sections 8.1, 11.4, 17

**Problem.** Search uses the deprecated Pagefind Default UI, loads via a
dynamically injected script, has no CJK verification, no title weighting, no
filters, no focus management, and cannot distinguish an empty result set from an
index that failed to load.

**Scope.**

1. Migrate to the supported Pagefind integration path and load the search bundle
   lazily on first invocation, from the same origin, without inline script.
2. Mark up pages so Pagefind indexes public body text only, weights the title
   above the body, and exposes tag and collection filters when those fields exist.
3. Verify CJK tokenization with representative Chinese and English queries against
   a fixture corpus containing both.
4. Keyboard access: an accessible trigger, a dialog with a focus trap, `Escape` to
   close, focus restoration to the trigger, arrow-key result navigation, and a
   documented keyboard shortcut.
5. Distinguish and separately message: no results, index still loading, and index
   load failure. Failure must leave the rest of the page usable.
6. Excerpts must contain public text only.
7. Optionally add a `/search/` route as a no-JavaScript-friendly entry point; the
   dialog remains the primary affordance.

**Acceptance criteria.**

- Search bundle is not requested on initial page load, proven by inspecting built
  HTML and the module graph.
- A test asserts the Pagefind index contains published pages and no private
  residue.
- Zero-result and load-failure paths are distinguishable and tested.
- Full keyboard flow works, including focus restoration.

---

## TK-07 — Hover and focus previews

**Requirements:** section 14, 8.1, 17

**Problem.** The current preview fires on `pointerover` only, has no delay, no
keyboard support, no dismissal on scroll or `Escape`, clamps only the left edge,
fetches the whole index on first hover, and has no failure handling.

**Scope.**

1. Trigger on pointer hover and on keyboard focus, after a short delay, with
   cancellation when the pointer or focus leaves before the delay elapses.
2. Render only from the public preview payload (`title`, `excerpt`, and public
   metadata). Use DOM construction, never `innerHTML`.
3. Support heading-target previews for `/notes/<slug>/#heading` links.
4. Clamp to the viewport on all four edges, flip above the link when there is no
   room below, and dismiss on `Escape`, scroll, resize, and pointer/focus exit.
5. Never fetch or preview a non-public target; external links get no preview.
6. Fetch failure, malformed payload, and unknown slug must fail silently without
   breaking the underlying link.
7. Respect `prefers-reduced-motion` and do not interfere with touch interaction.
8. The preview must never be the only way to reach information.

**Acceptance criteria.**

- Keyboard focus produces the same preview as hover.
- Preview never overflows the viewport at 320 px or at the page edges.
- With JavaScript disabled or the index request failing, every link still works.
- Unit tests cover clamping math and payload lookup.

---

## TK-08 — Canonical metadata, feeds, sitemap, robots, and social cards

**Requirements:** sections 8.1, 9.3, 20, 25

**Problem.** Pages emit only `title` and `description`. There is no canonical URL,
Open Graph metadata, RSS/Atom feed, or sitemap. `robots.txt` exists but is not
coordinated with a sitemap.

**Scope.**

1. Configure a canonical site origin in `astro.config.mjs` and emit `<link
   rel="canonical">` on every route.
2. Emit deterministic Open Graph and Twitter card metadata per route, including
   type, title, description, URL, locale from document language, and published and
   modified timestamps when present.
3. Generate an RSS or Atom feed of published notes with canonical URLs, stable
   ordering, and public-safe summaries only. Prefer a first-party generator over a
   new dependency unless the dependency is clearly justified.
4. Generate a sitemap covering every public route, and align `robots.txt` with it
   and with the intended indexing policy.
5. Social card images: emit deterministic metadata now. Generated images are
   optional; if an image generator would add a heavyweight dependency, ship a
   single static default card and record the decision.
6. Confirm cache policy in `public/_headers`: short cache or revalidation for HTML,
   `public, max-age=31536000, immutable` for hashed assets, short cache with ETag
   for JSON data files.

**Acceptance criteria.**

- Feed and sitemap validate structurally and contain only published routes.
- Every route has a canonical URL and complete social metadata, asserted by a test
  over `dist/`.
- Feed output is deterministic across two consecutive builds given identical input
  and a fixed build timestamp source.

---

## TK-09 — Privacy, security, and performance release gates

**Requirements:** sections 18, 19.1, 19.2, 19.3, 21.1, 22, 25

**Problem.** Nothing verifies the built output. There is no residue scan, no CSP
verification, no budget enforcement, and no build manifest.

**Scope.**

1. Residue scanner over the public source tree and `dist/`, failing the build on:
   secrets patterns, `msw/` markers, private path markers, unresolved
   `[[wikilinks]]`, absolute local paths, `file://` URLs, unsafe URL schemes,
   source maps in production output, and any route or asset not on an expected
   inventory.
2. CSP verification: assert the served policy matches the section 19.3 baseline as
   closely as the deployed feature set allows, and assert `dist/` contains no
   inline script, no inline style attribute that the policy would block, and no
   inline event handler. Document any necessary deviation with its justification.
3. Performance budget check over `dist/`: initial JavaScript per article route
   under 50 KB gzip excluding user-invoked chunks, initial CSS under 40 KB gzip,
   and a warning above 250 KB uncompressed article HTML. Record measured values;
   fail on hard limits.
4. Build manifest: emit a reviewable summary listing routes, artifact hashes, asset
   sizes, content version, and the commit identifier. The manifest must contain no
   private values.
5. Consolidate the full gate into one `pnpm run verify` entry point that runs
   validation, type checking, tests, build, and every scan above.
6. Accessibility: run whatever automated check is achievable without a heavyweight
   browser dependency, and document precisely which WCAG 2.2 AA checks remain
   manual and why.

**Acceptance criteria.**

- `pnpm run verify` passes from a clean tree and fails when a seeded violation is
  introduced, proven by a test for each scanner rule.
- Measured performance values are recorded and within budget.
- The build manifest is generated and reviewed for privacy.

---

## TK-10 — Architecture decision records and deferred-scope documentation

**Requirements:** sections 24, 26, 29

**Scope.**

1. Record ADRs for the decisions actually made during TK-01…TK-09: relationship
   storage at launch, route model and the legacy redirect, Markdown pipeline and
   dependency choices, theme and CSP-compatible script strategy, search engine,
   and feed generation.
2. Document every deliberate deviation from the requirements document, with its
   reason and the condition under which it should be revisited.
3. Document deferred scope explicitly, including that the Phase 2 SQLite graph
   artifact must be produced by the private exporter and is therefore blocked on
   work outside this repository.
4. Update `AGENTS.md` with the commands, gates, and boundaries that now exist.
5. Update the requirements document's handoff checklist to reflect completed items.
6. Update `README.md` to describe the project accurately for a public reader.

**Acceptance criteria.**

- Every ADR states context, decision, consequences, and revisit conditions.
- No deviation from the requirements document is undocumented.
- `AGENTS.md` commands match the actual `package.json` scripts.
