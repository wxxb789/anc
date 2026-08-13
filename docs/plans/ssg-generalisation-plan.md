# General-Purpose SSG — Plan

**Status:** Active backlog — 2 of 12 tickets delivered, 1 of 3 fatal findings open (C3, TK-26)
**Document type:** Architecture decision + revised backlog
**Derived from:** three research agents, three drafted sections, and two adversarial reviews that returned 25 substantiated findings
**Describes:** `main` at `11b7cf2`, 497 tests, 20 tickets delivered
**Supersedes:** the single-owner premise in [`public-knowledge-garden-requirements.md`](../public-knowledge-garden-requirements.md) §4 and §10.3
**Note:** §2 through §5 are the design as first drafted. Where a delivered ticket contradicts
them, that ticket's specification under `.tmp/` is canonical and the section says so.

## 1. Verdict

The site is finished and the producer is not. Eighteen tickets built a reader — validated
content contract, sanitised Markdown pipeline, WCAG 2.2 AA design system, page anatomy,
relationship surfaces, search, previews, metadata and feeds, native MathML, build-time
Mermaid, bilingual chrome, a static SVG graph, and CI with a blocking privacy scan — and all
of it was built against an *artifact interface* rather than against a vault. That is the
piece of luck this plan runs on: turning the project into a general-purpose SSG replaces the
producer and touches almost nothing downstream. The rendering pipeline, design system,
graph, and search do not change.

What does change is the safety argument, and it changes for the worse before it changes for
the better. The allowlist made privacy structural: a note not named in the manifest was
physically unreadable, so no bug in this tree could publish it. Default-publish deletes that
guarantee — every file is readable by construction, and a mistyped exclusion glob publishes
a note the user believed was private, silently, and irreversibly once it reaches a CDN and a
search index. The owner accepted that trade. The replacement is not a weaker version of the
same guarantee; it is a different one, moved from read time to the publication event, and it
only works if the gates that enforce it can be watched failing.

**This plan was not implementable as drafted, and two of the three reasons are now gone.** Two
adversarial reviews returned 25 substantiated findings, three of them fatal: the `npx`
distribution model could not run because every renderer was a devDependency (S1); the
exclusion report was published to the world on the documented free adoption path, because
GitHub Pages from a private repository requires a paid plan and workflow logs on a public
repository are readable by anyone (C1); and the shipped default exclusion patterns fail every
real repository on first push, because `fs.globSync` structurally cannot match a dotfile while
the zero-match rule fails the build for exactly that (C3).

**S1 is closed by TK-24 (`5db558c`, `8127c26`) and C1 by TK-25 (`11b7cf2`). C3 remains, and
TK-26 owns it.** Sections 2 through 5 record the design as drafted, which in places the
delivered tickets have since overtaken; §8 records what the reviews killed. Where a delivered
ticket contradicts a drafted section, the ticket's own specification under `.tmp/` is
canonical and the section carries a note saying so — §2.5's report destination is the
instructive case, because the drafted answer reads safe and is destroyed by an ordinary `git
clean`.

The bet §1 opened with paid off: eighteen tickets built the reader against an *artifact
interface* rather than against a vault, and a stranger's three Markdown files now produce a
complete site with nothing downstream of `src/lib/schema.ts` changed. What remains is the
producer.

---

## 2. The content pipeline

The site already consumes a validated artifact. Nothing downstream of
`src/lib/schema.ts` needs to change to read one produced from a git repository instead of
from a manifest — the rendering pipeline, design system, graph, search, and feeds were all
built against that interface and stay untouched. What changes is who writes the file.

This section specifies that producer: a TypeScript program that walks a repository of
Markdown and emits `{version: 1, entries: [...]}`. It replaces `export.py` outright. It is
not a port — six of `export.py`'s reproduced defects (`docs/plans/quartz-parity-plan.md:196-201`)
come from scanning raw text with regular expressions, and the fix for all six is to stop
doing that.

### 2.1 Shape

| File | Responsibility |
| --- | --- |
| `src/lib/note-discovery.ts` | walk, classify, apply exclusion, derive slug and metadata |
| `src/lib/link-resolution.ts` | the five link forms → one `Resolution` union |
| `scripts/sync-content.ts` | CLI entry: read repo → write artifact + report → exit status |
| `src/lib/schema.ts` | unchanged except for two deletions (§2.7) |

One new direct dependency, `yaml` — already resolvable in the tree as a transitive
dependency of Astro. Frontmatter is YAML and hand-rolling a subset of it is the flimsier
algorithm, not the lazier one. `satteri` and `github-slugger` are already direct
dependencies and do the rest.

`scripts/` goes from five files to six. The naming rule holds (`sync-content.ts` ↔
`sync:content`, a script that already exists in `package.json:11` and today shells out to
Python). If five is load-bearing rather than descriptive, `scripts/render-og-card.ts` is
the one file with no npm script and no build caller (`scripts/render-og-card.ts:4` says so
itself) — but that is the owner's call, not this plan's.

The producer runs **in the user's notes repository**, not here. It never reads
`src/data/content.json`; it writes one.

### 2.2 Content discovery

| Question | Answer | Why |
| --- | --- | --- |
| What is walked | every file under the repository root, via `fs.globSync`, **sorted** before use | glob order is unspecified; determinism is a hard constraint, and unsorted input is how tier-5-style scan-order dependence sneaks back in |
| What is a note | extension `.md`, exactly | Obsidian accepts only `.md` as a Markdown note (research, *Extensions*). `.markdown` is an invented abbreviation of the problem |
| Non-Markdown files | discovered, **never emitted** | this preserves W2/C5. Quartz's own docs state every non-Markdown file ships regardless of filtering; the fix there is deleting an asset emitter, and the fix here is not writing one |
| `.git/`, `.obsidian/`, `node_modules/`, any dot-prefixed file or directory | excluded by default (§2.3) | `.obsidian/` carries workspace state, plugin data, and `graph.json`; a dotfile is configuration by convention |
| Root `README.md` | excluded by default, re-includable with `!README.md` | in a repo adopted by adding a GitHub Action, the README carries the badge, the Action snippet, and install steps. It addresses the repository, not the reader |
| Nested `README.md` | an ordinary note | it is a folder's index, which is prose |

**Derived fields.** Each is stated because each is a decision, not a mapping.

| Artifact field | Source | Failure mode |
| --- | --- | --- |
| `slug` | frontmatter `slug:` if present, else the repo-relative path slugified per segment and joined with `-` | must satisfy `SLUG` (`src/lib/schema.ts:64`) and the doubled-hyphen rule (`:56`). A path that slugifies outside that vocabulary — `简介.md` → `简介` — **fails and names the file and the fix** (`slug:` in frontmatter). No transliteration: every transliteration is locale-dependent, and a locale-dependent URL is not deterministic output. This is the existing contract, not a regression — `tests/fixtures/valid-corpus.json` already carries a hand-written `zh-jian-jie` for a Chinese note. Widening `SLUG` to Unicode is a real option with a real blast radius (routes, redirects, Cloudflare rule length, `facets()`); it is named here and not taken |
| two files → one slug | error naming both **paths** | same shape as the facet collision at `src/lib/routes.ts:149-151`, whose message must stop saying "exporter" — `tests/route-model.test.ts:283-305` asserts that word and breaks with it |
| `title` | frontmatter `title:`, else the first `# ` heading, else the filename stem | the stem is a real title in a notes repo; the filename *is* the note name in Obsidian |
| `created` / `updated` | git commit dates: first and last commit touching the path | five surfaces degrade without them (research §3): `/recent/` falls back to slug order and tells the reader so, Atom stamps the `UNDATED` sentinel (`src/lib/site.ts:177-193`), sitemap `<lastmod>` is omitted, `article:published_time` is absent, and the metadata `<dl>` renders nothing. A git-backed producer has these dates, so the sentinel stops being an accepted lie |
| `language` | frontmatter `lang:` / `language:`, else configuration default | already load-bearing: per-document chrome keys on it (`src/lib/translations.ts:726-729`) and Pagefind's bilingual merge keys on `<html lang>` |
| `collection` | first path segment, slugified; absent for a root-level note | `schema.ts:418-420` validates it as a *flat* slug and `src/lib/collection-navigation.ts:14-22` already states nesting has no data behind it. Folders are a hierarchy and this flattens it to one level deliberately — deeper nesting is a schema change, and it belongs to whoever bumps the version, not to this producer |
| `tags`, `aliases`, `description` | frontmatter, bounded by the existing `ARRAY_LIMITS`/`STRING_LIMITS` | already validated |
| `markdown` | the source body with frontmatter removed by **satteri's `yaml` node**, not by a regex | `export.py`'s `\A---\s*\n.*?\n---\s*\n` with `DOTALL` eats everything up to the *second* `---`, so a note opening with a thematic break loses its head |

**`MAX_ENTRIES = 900` (`src/lib/schema.ts:167`) is wrong at repository scale.** Its stated
justification is "the allowlist is hand-curated", which stops being true here. The binding
cost is per-entry build time, so the limit should become configuration with 900 as the
default, and the message should say how to raise it. One constant, one message.

### 2.3 Exclusion

Two mechanisms, one ordering, no ambiguity about which wins.

| Rank | Rule | Verdict |
| --- | --- | --- |
| 1 | frontmatter `publish: false` | excluded. Unconditional. A `!` re-include cannot resurrect it |
| 2 | glob rules in configuration, **last match wins**, gitignore-style with `!` negation | as matched |
| 3 | nothing matched | published |

`publish: true` is accepted and recorded, and it **does not override an exclusion**. That
asymmetry is the whole design. The two failure modes are not equal: a note the user meant
to publish and did not is an inconvenience they will notice; a note they meant to keep
private and published is irreversible once it is on a CDN and in a search index. So the
mechanism that points toward *not publishing* — the three words inside the file itself,
nearest the content — always wins, and the mechanism that points toward publishing never
overrides one.

Defaults ship as ordinary glob entries so a user can see and negate them:

```
.git/**  .obsidian/**  node_modules/**  **/.*  **/.*/**  README.md
```

**A pattern that matches nothing fails the build**, naming each such pattern. There is no
flag to downgrade it. This is the single mitigation available for the consequence the
owner accepted: default-publish fails open, and a mistyped exclusion glob is exactly the
mistype that publishes silently. `drafts/**` typed as `draft/**` matches nothing, and
without this rule the build is green and the drafts are live. Legitimate cases exist — a
config shared across repos, a folder not yet created — and the fix for both is deleting
the pattern or creating the folder, which is one line and visible.

"Matched" means the pattern returned true for at least one discovered path, whatever the
final verdict was. A pattern shadowed by an earlier rule still counts, so the check does
not depend on rule order.

### 2.4 Link resolution

Five spellings, **one resolver**. The internal/external test is Obsidian's `WE`:
`startsWith('./') || startsWith('../') || indexOf(':') === -1`. Internal Markdown hrefs get
`decodeURI` — not `decodeURIComponent`, so `%20` decodes and `%23` stays encoded — and are
then fed to the same function as a wikilink. Building two resolvers is how the two answers
drift apart.

| # | Form | Example | Tier it lands on |
| --- | --- | --- | --- |
| 1 | wikilink, shortest-path | `[[git]]` | 0 → 1 |
| 2 | wikilink, relative-to-file | `[[./sib]]`, `[[../x]]`, and the prefix-less `[[b/note]]` Obsidian's `relative` format actually writes | 2, or 5 for the prefix-less form |
| 3 | wikilink, vault-root | `[[Projects/Three laws]]`, `[[/Projects/Three laws]]` | 3, and 4 for the `/`-anchored spelling |
| 4 | standard Markdown link | `[t](../y.md)`, `[t](/Projects/Three%20laws)` | same tiers, after `decodeURI` |
| 5 | plain wikilink | `[[Page Name]]` written by hand outside Obsidian | 0 → 1, identical to form 1; the report distinguishes them, the resolver does not |

Form 2's prefix-less spelling is why tier 5 cannot simply be deleted: `fileToLinktext` under
`newLinkFormat: relative` emits `[[b/note]]` with no `./`, and that only resolves through
tier 5's same-folder bucket. Form 1 never needs tier 5, because `shortest` falls back to the
full vault path whenever the basename is not unique.

#### What we adopt, and what we deliberately differ on

The research recovered the mechanism by executing the shipped `getLinkpathDest` from
`obsidian.asar`. Tiers 0–4 are reproduced verbatim; tier 5 is where an editor's contract and
a build's contract diverge.

| Tier | Behaviour | Verdict | Why |
| --- | --- | --- | --- |
| 0 candidate set | lowercase; probe `name` if the basename has a dot, then probe `name + '.md'`; no basename match ⇒ dead, with no alias/title/permalink fallback | **adopt verbatim** | deterministic, and it is what makes `[[Figure 1]]` against `Figure 1.png` correctly resolve to nothing |
| 1 bare unique name | linkpath has no `/` **and** exactly one candidate | **adopt verbatim** | the dominant form; the only tier that requires uniqueness |
| 2 explicit `./` `../` | joined onto `dirname(source)`, exact full-path match, falls *through* on failure rather than returning | **adopt verbatim** | deterministic |
| 3 exact vault-root path | leading `/` stripped first, then exact match | **adopt verbatim** | covers every `absolute`-format link, and it is why a root-level `items.md` is not shadowed by `archive/items.md` |
| 4 leading `/` strict anchor | tier 3 missed **and** the link was written with `/` ⇒ unresolved | **adopt verbatim, and document `/`-anchoring as the recommended authoring spelling** | it is the most precise spelling available. Widely circulated third-party "ground truth" says a `/`-anchored link never resolves; the research executed it and that is wrong — the slash is stripped before tier 3 |
| 5 *matching* | raw-string `path.endsWith(link)` and `path.startsWith(srcDir)` | **harden to segment-aware** | executed: `[[ary/index]]` resolves to `knowledge/glossary/index.md`, and a source in `proj/` prefers `projects/note.md` over `zzz/note.md`. These are defects, not semantics |
| 5 *ranking* | same-folder bucket, then path length ascending, then `uniqueFileLookup` insertion order | **replace with a build error** | undocumented, and executed reversal of file order reverses the winner. A silent pick by scan order violates the determinism constraint outright |

```ts
// src/lib/link-resolution.ts
const matchesSuffix = (path: string, link: string) => path === link || path.endsWith('/' + link);
const inSourceSubtree = (path: string, dir: string) =>
  dir === '' || path === dir || path.startsWith(dir + '/');
```

```
survivors = candidates.filter(c => matchesSuffix(c, link))
near      = survivors.filter(c => inSourceSubtree(c, srcDir))
pool      = near.length > 0 ? near : survivors
pool.length === 1  -> resolved
pool.length === 0  -> unresolved
pool.length  >  1  -> ambiguous
```

**A static build can afford to fail loudly where an editor must guess.** Obsidian picks a
winner because a human is watching and can click through. A build promises byte-identical
output to a reader who is not watching.

Three further deliberate divergences, each named rather than smuggled in:

| Divergence | Choice | Why |
| --- | --- | --- |
| **Aliases as link targets** | **not resolved.** Match Obsidian desktop, not Obsidian Publish | This is a genuine fork between two first-party implementations: desktop's `getLinkpathDest` has no alias branch and a moderator closed the bug report as intentional; Publish's resolver has an alias tier *and* a permalink map, and the differential was executed — `[[alias-name]]` returns `null` on desktop and `Real.md` on Publish. The same two implementations disagree on `[[/foo/bar]]` in opposite directions. "Obsidian-compatible" is therefore ambiguous and this plan names which one it means. Aliases stay indexed for search and preview; `schema.ts:479-488` keeps collision-checking them |
| **Unicode** | NFC-normalise **both** the link text and every file path before keying | Obsidian normalises only the link text; filenames come from the OS unnormalised, so an NFC link against an NFD filename resolves to nothing, and macOS hands back decomposed forms. `zoni/obsidian-export` normalises both sides; it is the right call for a tool whose output must be identical on every runner |
| **Case-only collisions** | error, do not pick by scan order | resolution is entirely case-insensitive, so `Note.md` and `note.md` share one key: tier 1 is skipped, tier 3 matches *both*, and the loop returns whichever the filesystem scan saw first. On a case-insensitive filesystem the pair cannot exist, so the check is free; on a case-sensitive one it catches a platform-dependent hazard before a reader does |

**Subpaths.** `parseLinktext` splits at the **first** `#`. The raw subpath is preserved
un-slugified and matched against the target's headings with Obsidian's own comparator —
strip `/[!"#$%&()*+,.:;<=>?@^\`{|}~\/\[\]\\\r\n]/g`, collapse whitespace, trim, lowercase —
which is not a slugger. Note `-`, `_`, `'` are *not* in that class and must match literally,
and no Unicode normalisation is applied to heading text. Only after a heading matches does
the producer emit **our** anchor for it — the `github-slugger` id `src/lib/markdown.ts`
already generates. Quartz slugs at parse time with `github-slugger` in `splitAnchor`; that
is a divergence from Obsidian, not a reproduction, and it silently mismatches on any heading
whose two slugging rules disagree.

`INTERNAL_HREF` (`src/lib/markdown.ts:283`) already carries a capture group for exactly this
fragment — the fragment `export.py` destroyed by putting the heading anchor in a
non-capturing group.

### 2.5 The ambiguity rule, and where the report lives

Every link produces exactly one of four outcomes. There is no fallback branch.

```ts
export type Resolution =
  | { kind: 'resolved'; slug: string; anchor?: string }
  | { kind: 'unpublished'; path: string }
  | { kind: 'unresolved' }
  | { kind: 'ambiguous'; candidates: readonly string[] };
```

**Resolve against the full file set, then test publication separately.** Resolving against
the published set only would merge `unpublished` and `unresolved` — and those are different
events with different fixes. `unpublished` is a publication-boundary event: the user
excluded a note that something links to. It is the mistyped-glob hazard seen from the other
side, and it is the most useful line in the whole report.

| Outcome | Emitted | Build |
| --- | --- | --- |
| `resolved` | `<a href="/notes/<slug>/#anchor">`, and an `outgoing` edge | passes |
| `unpublished` | the link's **display text only**, as plain text. The resolved path never enters `markdown` | passes; reported |
| `unresolved` | display text only | passes; reported |
| `ambiguous` | nothing | **fails**, naming file, line, link text, and every candidate path, with the fix: write the vault-root path, or `/`-anchor it |

`![[x.png]]` and `![](x.png)` resolve to a repository file that is not a publishable note,
so they are `unpublished`: the node is dropped and reported. No broken `<img>` ships. An
asset pipeline is deliberately not built here — not writing one is what keeps C5
(deny-by-default assets) true, and Quartz's privacy failure was never the Markdown, it was
the images.

**Where the report lives.** `validateArtifact` rejects every top-level key that is not
`version` or `entries` (`src/lib/schema.ts:528`), so there is nowhere inside the artifact to
put corpus-level output. The answer is not to bump `SCHEMA_VERSION`:

> The report is a **second output file**, `content-report.json`, written to
> `<git-dir>/publish-report/content-report.json` — inside the git directory, which nothing
> can stage. It is never an artifact key, never imported by anything under `src/`, and never
> copied into `dist/`. Schema stays at version 1 and `validateArtifact:528` is untouched.

That is the lazy answer and also the correct one. The report's contents are *precisely* the
strings the privacy model exists to keep out of the artifact: excluded file paths,
unresolvable link targets, repo-relative source paths. `schema.ts:206-208` and
`scripts/scan-residue.ts:81-84` reject absolute local paths, and
`tests/preview-model.test.ts:208` uses `source_path: 'C:/vault/private.md'` as *the* example
of a leaked field. Putting an exclusion report inside the artifact would put the list of
things the user chose not to publish inside the file the site renders from. A separate file
that nothing in `src/` can import cannot leak into a page by accident.

**The destination is the git directory, and this paragraph originally said otherwise.** It
first specified the report "beside whatever path `CONTENT_ARTIFACT` names", and then a
draft of TK-25 specified a self-ignoring `<cwd>/.thoughtscape/`. Both are wrong, and the
second is wrong in a way that reads safe: a worktree directory carrying a `.gitignore` whose
body is `*` is **deleted entirely by `git clean -xfd`** — the command a user runs after a
failed build, which is exactly when the report is the only diagnostic they have. Measured, as
is its converse: a report under `.git/` survives that command, and `git add -A` stages
nothing of it. TK-25's `.tmp/tk-25-spec.md` §1 carries the full analysis, including the
no-git fallback and the linked-worktree and submodule paths.

The segment is `publish-report/`, not this project's name. A stranger runs this tool on their
own notes repository, and a directory carrying the tool author's name inside their `.git/` is
the single-owner residue decision D2 exists to remove.

The report carries, per finding: source path, 1-indexed line, the link exactly as written,
the outcome, and for `ambiguous` the sorted candidate list. Plus one section listing every
discovered file with its verdict and **which rule decided it** — that is the evidence
`tests/built-routes.test.ts:117-118` structurally cannot supply, because `expectedRoutes()`
is derived from the same entries the producer chose and so proves consistency, never
authorisation.

**None of it is printed.** This paragraph used to end "Everything is also printed to stderr,
because a GitHub Action log is what a user actually reads" — which is finding C1 stated as a
feature. The free adoption path is a public notes repository, whose workflow logs are
world-readable and retained 90 days, so a printed path list is an index to the private set
published to the world. The stream carries counts and closed-set rule identifiers; the file
carries names. TK-25 §2 states the rule an implementer applies to a line before writing it,
and `tests/disclosure.test.ts` gates it.

**Never counts — in the report.** "0 unresolved because I never looked" and "0 unresolved
because there were none" are the same number, so the *file* records the link text and
position for each finding and the gates assert on those. The *stream* is the opposite case
and carries counts precisely because they name nobody; TK-25 §4.2's `status` field is what
keeps a count honest there, distinguishing "nothing to report" from "I stopped before I could
look."

### 2.6 Backlinks from all five forms

Today `outgoing` derives from wikilinks only, so `{markdown: 'See [B](/b/).', outgoing: []}`
is a valid entry: a live anchor with no backlink on B, and no gate sees it.
`src/pages/notes/[slug].astro:160-169` documents this incompleteness rather than hiding it,
and says the heading therefore reads "links to" instead of "every link on this page".

The fix is structural, not additive. **`outgoing` and the rewritten hrefs come from the same
traversal.** One walk of the mdast; each `link` and `image` node resolved exactly once; the
single `Resolution` both rewrites `node.url` and, when `resolved`, appends to `outgoing`.
There is no second pass and no second source of truth, so the edge set and the rendered
anchors cannot disagree — not because a test checks them, but because one value produced
both.

`checkCorpus` (`src/lib/schema.ts:470-513`) still proves backlinks are the exact inverse of
outgoing, and under default-publish that matters more, not less: the edge set is now derived
from a whole repository rather than a curated list. But it proves the two arrays are inverses
*of each other* — it has never had anything to say about the page.

**The gate.** Over built `dist/`, for every note page, the set of `href` values matching
`/notes/<slug>/` inside `<article class="prose">` (`src/pages/notes/[slug].astro:343` — the
element is already delimited, and it excludes the graph SVG, the outgoing list, and the
backlinks aside) equals `entry.outgoing` mapped through `routeForSlug`.

Three properties that decide whether that gate means anything:

1. **Assert on the href set, not its size.** Two wrong edges of the same cardinality is the
   failure this catches.
2. **The expected value is hardcoded in the test, per fixture note.** Both the anchors and
   `outgoing` are producer output; comparing them only to each other is the same
   self-comparison trap as `expectedRoutes()`. The fixture corpus carries a checked-in table
   naming the exact target slugs each note should link to.
3. **The fixture must contain all five forms**, or the gate is green while four of them go
   unchecked. It must also contain, per the research's own warning about the ambiguity
   branch: a deliberate same-basename pair in two folders, a case-only pair, an NFC/NFD
   pair, a prefix-less multi-segment relative link, and a `/`-anchored link that misses.
   Neither existing corpus has any of these. This is the fifth instance of the hazard —
   every high-value defect so far came from hardening a gate.

### 2.7 What happens to `schema.ts:207`

`[/\[\[/, 'unresolved [[wikilink]]']` (`src/lib/schema.ts:207`, mirrored at
`scripts/scan-residue.ts:82`) is safe today only because the current producer resolves every
wikilink against a closed allowlist. It fails a user's build for a normal outcome and for a
legitimate one:

| Case | Today | Correct |
| --- | --- | --- |
| a link that resolves to nothing | build fails, no recourse from this repository | degrade to display text, report it (§2.5) |
| a note *documenting* wikilink syntax — ```` ```text\n[[X]]\n``` ```` | build fails | publish it; a code fence is content |

**Delete both rules.** The justification is that this was never a privacy rule: `[[` leaks
nothing. It was a proxy for "the producer forgot to resolve something", and a proxy for a
property is exactly the coverage illusion — it goes vacuous or false the moment the producer
changes. The real invariant lives where the information is:

> Every wikilink **node** the parser found has a recorded `Resolution`. A `[[` surviving in
> `markdown` is therefore, by construction, inside a code fence, inside inline code, or
> escaped.

The privacy rules that carry actual weight — absolute local paths (`:208`), home-directory
paths, unsafe schemes, source-map references — all stay, along with
`scan-residue.ts`'s two designs worth preserving: the non-vacuity guards (`:282-286`) and
fail-closed-on-unknown-extension (`:257-263`). The `msw/` marker at `:206` and `:81` is a
separate problem — it is one owner's private path prefix and a false-positive generator for
everyone else — and belongs to the configuration section, not here.

### 2.8 Code fences

`export.py` ran `WIKILINK.finditer` over raw Markdown with no node awareness, so a note
documenting Obsidian syntax rewrote links inside its own code fences **and** injected a
phantom edge into `outgoing` — which `checkCorpus` then proved symmetric and passed. That is
the assert-on-the-wrong-property hazard with a green gate on top, and it is the same defect
the Quartz analysis condemns in the OxHugo and Roam compatibility plugins.

The new producer never regex-scans source text. It parses with `satteri` — already a direct
dependency, already this repository's renderer — with `wikilinks: true`, and walks only
`link` and `image` nodes. Verified against the installed version:

```
input:  Doc `[[X]]` and:  ```text\n[[X]]\n```  Real [[X]] plus [t](../y.md) and ![[p.png|200]].
nodes:  inlineCode "[[X]]"   code "[[X]]"   link "X"   link "../y.md"   image "p.png"
```

Fence-blindness is not tested away, it is unrepresentable: `[[X]]` in a fence is a `code`
node and in backticks is an `inlineCode` node, and neither is in the set the walker visits.
Node positions carry byte offsets, which is where the report's line numbers come from.

The **renderer** keeps `wikilinks: false` (`src/lib/markdown.ts:194`). That flag's stated
reason — parsing wikilinks at render time would quietly render a link the projection never
approved — survives the change intact, because by the time the artifact reaches the renderer
it carries no wikilinks. Two parses of the same bytes with different feature sets, both
pure, one extra parse per note at produce time.

The gate: a fixture note whose fenced code contains `[[Other Note]]` and `[link](/other-note/)`
where `other-note` is a real published note, and whose hand-written expected edge list says
**no edge**. Assert on the edge list's contents. A cardinality check passes this defect —
that is how it shipped.

### 2.9 Deliberately not in this section

| Deferred | Why |
| --- | --- |
| An asset/attachment pipeline | not writing one is what keeps deny-by-default assets true. `unpublished` + report is the honest interim behaviour |
| Nested collections | `schema.ts:418-420` validates `collection` as a flat slug and `collection-navigation.ts:14-22` already declines to invent the nesting. It is a schema version bump and belongs with one |
| A `source_path` artifact field | wanted for edit-on-GitHub links, but `schema.ts:390` rejects unknown entry fields and the privacy model treats source paths as *the* canonical leak. The report already carries them, outside the artifact |
| Per-edge context and source heading | requirements §13.1; `notes/[slug].astro:358-373` explains why edges are bare slugs. Unchanged here |
| Widening `SLUG` to Unicode | named in §2.2 with its blast radius; a real option, not this ticket's |

---

## 3. The privacy inversion

## 3.1 What is actually being traded

The manifest guarantee was structural: content not named in the allowlist was *physically
unreadable* by this repository, so no bug in this tree could publish it. Default-publish
deletes that guarantee. Nothing replaces it at read time, because under a whole-repository
producer every Markdown file is readable by construction.

The replacement is at the **publication event**, not at the read: a committed publish set
that a build refuses to grow without an explicit commit. Authoring stays fail-open — that
is the point of default-publish and the owner accepted it. Publishing becomes fail-closed
again, because the thing that makes a note public is a diff a human approved, not a glob a
human wrote correctly.

Two structural prerequisites, both cheap, both blocking:

| Prerequisite | Why | Cost |
| --- | --- | --- |
| `SCHEMA_VERSION` 1 → 2 with a third top-level key | `validateArtifact` (`src/lib/schema.ts:522-529`) rejects every top-level key but `version` and `entries`, so the exclusion report, the ambiguity report, and the pattern-match counts have **nowhere in the contract to live**. `SCHEMA_VERSION` is at `src/lib/schema.ts:33` | one constant, one `if`, one type |
| `dist/` is written into an empty directory each run | Deletion (G7) is only structural if a stale page cannot survive a rebuild. Quartz's `helpers.ts:13` writes non-atomically into a directory it already `rm -rf`'d — the wrong half of this | already true for `astro build`; must be stated as a deployment rule, not an accident |

## 3.2 Where the summary goes

Three destinations, three different audiences, three different disclosure rules. Conflating
them is how the report itself becomes the leak.

> **Superseded by TK-25, and the row that was wrong is kept here because it is instructive.**
> The first row below rested on "it is the user's own private repository", which is false on
> the documented free path: GitHub Pages from a private repository requires a paid plan, so
> the zero-secret adoption path is a **public** notes repository whose logs anyone can read
> for 90 days. Finding C1 killed it. The stream now carries counts and closed-set rule
> identifiers and never a name; the file carries names and lives where nothing can stage it.
> `.tmp/tk-25-spec.md` §2 is the current rule, and `published.txt` is gone — S6, M1 and M2
> killed it separately, and §8 records why.

| Destination | Contents | Committed? | May name an excluded file? |
| --- | --- | --- | --- |
| ~~Run log + Action step summary~~ | ~~every exclusion pattern with its match count; every excluded file and the rule that excluded it; every ambiguous link with all candidates~~ | no | ~~**yes** — it is the user's own private repository~~ **NO — C1** |
| Run log + Action step summary (current) | counts, and rule identifiers from a closed set. Never a path, never a basename, never a link's text | no | **no** — gated by `tests/disclosure.test.ts` |
| `<git-dir>/publish-report/content-report.json` | every excluded file and the rule that excluded it; every ambiguous link with all candidates; counts | **cannot be** — nothing under `<git-dir>` can enter the index | **yes** — that is what it is for |
| ~~`published.txt` at the notes-repo root~~ | ~~sorted published slugs~~ | — | killed by S6, M1, M2 — see §8 |
| `dist/` | nothing | n/a | **never** — gated, see G3 |

The paragraphs below argue for `published.txt`, which no longer exists. They are left in
place because the *reasoning* about what a publication ledger may carry survives the ledger,
and TK-29 will face the same question about the report's own diff.

`published.txt` carries slugs and no paths, no titles, no counts and no hash. That is
deliberate three ways. A body edit does not touch it, so its diff is the publication
change and only the publication change — Obsidian Publish's changes dialog, expressed as a
file `git diff` renders and CI can enforce. It cannot leak a private path even if someone
deploys it by mistake. And the excluded set is its exact complement over the discovered
files, so the run log is not a second source of truth, it is the same fact from the other
side.

Requirements §10.3 item 11 already asks for exactly this — *"emit a privacy/audit summary
without private values"* — and it is the one line in that section that survives the
inversion untouched.

## 3.3 The gates

Every row is a build failure, not an intention. The last column is the seeded defect that
must turn the gate red; a gate whose mutation has never been run is a gate this repository
has shipped green four times already.

| # | Gate | Fails when | Proven non-vacuous by |
| --- | --- | --- | --- |
| **G1** | **Unacknowledged publication.** The build compares the computed publish set against committed `published.txt` | any slug is present in the computed set and absent from the committed file | Three mutations, because two of them are the ways this gate goes quiet. (a) Add a fixture note, leave `published.txt` alone → must fail, naming the slug. (b) *Remove* a note, leave the file alone → must **pass**; a removal is always safe and a gate that blocks it will be disabled within a week. (c) Delete `published.txt` entirely → must fail as *"I could not look"*, never as "no additions found". Guard (c) is the whole gate: an absent ledger and a matching ledger are the same zero |
| **G2** | **A pattern that matched nothing.** Each configured exclusion glob carries its match count into the artifact's `publication` key; each `publish: false` exclusion is counted separately | any pattern matched zero files | Assert on content, not cardinality. (a) A pattern deliberately mistyped (`draft/**` for `drafts/**`) must fail, naming the pattern and its config location. (b) A known-good pattern must report the **exact sorted list of paths it excluded**, compared against a list the fixture authored — not against a count, and never against what the matcher returned. (c) Drop one configured pattern from the report and assert the gate fails: one report entry per configured pattern, or the gate is measuring a subset it chose |
| **G3** | **The report reached the output.** No file under `dist/` contains any path or basename from the exclusion report | any excluded path, or the distinctive stem of one, appears anywhere in `dist/` | Give the fixture an excluded note whose filename is a distinctive token. Assert the token appears in the report **and** is absent from every file in `dist/`. Both halves: the absence assertion alone passes on a build that excluded nothing. The oracle comes from the producer and the target is the consumer's output, so neither side sources its expected value from the other |
| **G4** | **A link into excluded content.** `checkCorpus` (`src/lib/schema.ts:470`) survives structurally and matters *more* — the edge set is now derived from a whole repository rather than a curated list — but it proves outgoing and backlinks are inverses **of each other**, never that either matches the rendered anchors. It gains that second half | any `href="/notes/<slug>/"` in built HTML names a slug not in the artifact; or any `outgoing` entry resolves to an excluded file rather than being degraded to plain text | This closes Quartz's defect (c) — an existence oracle computed before filtering, so a link to a `draft: true` note renders as a working link to a 404 and is never flagged. Mutation: a fixture note linking to an excluded note must build with that link as **plain text**, and the gate must fail when the degradation is removed. Second mutation, the one that matters: assert the anchor set and the edge set are compared *in both directions*. A rendered link with no edge is a missing backlink; an edge with no rendered link is a phantom edge. Today neither is visible |
| **G5** | **Residue.** `checkPrivacy` splits. The universal rules — absolute local path, home-directory path, `javascript:`/`vbscript:`/`file:`/non-image `data:`, source-map reference (`scripts/scan-residue.ts:80-89`) — stay hardcoded and non-configurable. `msw/` (`src/lib/schema.ts:206`, `scripts/scan-residue.ts:81`) becomes a user-configured marker list defaulting to empty, because `msw` is a widely used HTTP-mocking library and one owner's path prefix is another user's false build failure. `[[` (`src/lib/schema.ts:207`) **moves out of the artifact gate entirely** and stays only over `dist/`: under five link forms and real ambiguity an unresolvable wikilink is a normal authoring outcome, so the producer degrades it to plain text and records it in the ambiguity report, and a residual `[[` in output now means the degradation failed — a producer defect, not a user's | any universal marker appears in `dist/`; or a configured user marker appears; or a file shipped that the scan could not classify | The existing fail-closed-on-unknown-extension rule (`scripts/scan-residue.ts:257-263`) and the two non-vacuity guards (`:282-286`) are already the right design — preserve both. Add per-rule non-vacuity: seed each universal rule individually against a synthetic `dist/` and assert each fires alone. An aggregate "9 rules, 0 findings" cannot tell nine working rules from one working rule and eight broken ones. **Also fix the documented defect**: `scanResidue` reports "I couldn't look" as a *finding* (`src/lib/diagram-mode.ts:59-64` records this and it is still unfixed), so a caller counting findings cannot distinguish it from residue. Split the return into `{findings, blockers}` |
| **G6** | **Asset reachability.** An asset reaches `dist/` only because a published note references it. There is no `**` copy pass and there must never be one | any file in `dist/` traces to none of: a published entry's referenced asset, `public/`, or a build-tool output (`_astro/`, `pagefind/`) | Quartz's own docs concede *"all non-markdown files will be emitted and available publically"*, so a `draft: true` note publishes every image it embedded — and undocumented defect (b) is worse: discovery globs `**/*.*` while the asset emitter globs `**`, so an extensionless file (`secrets`, `TODO`) is copied verbatim while being invisible to every filter. Three mutations, all required together: an unreferenced image beside a published note must be **absent**; an image referenced only by an excluded note must be **absent**; an image referenced by a published note must be **present**. Without the third the gate passes on a build that copied nothing. Fourth: an extensionless file must be absent, tested by name |
| **G7** | **Deletion round trip.** Removing a Markdown file removes the page, the feed entry, the sitemap entry, and the search record | after removing a fixture note and rebuilding, its route exists in `dist/`, or its title appears in `sitemap.xml`, `feed.xml`, or returns a Pagefind result | The Digital Garden plugin's trap is that removing the inclusion marker leaves the page live — unpublishing is two steps. Ours must be one, and structurally so. Mutation: build the fixture corpus, remove one note, rebuild, assert all four absences **and** assert a retained note still returns a Pagefind result for its own title. Without the second, "zero results" proves the index is broken, not that deletion worked. This also forces `tests/search.test.ts:42` — `PRIMARY_QUERY = 'the'`, whose own comment already says a gate measuring a term the corpus lacks is "green for the wrong reason" — to become a term drawn from the corpus under test and asserted present in it before the query runs. On a Chinese-only user repo the current constant is exactly the failure its comment describes |

## 3.4 Gates that go vacuous and are not worth keeping

Deleting a gate that proves nothing is cheaper than reading it every time and believing it.

| Gate | Verdict |
| --- | --- |
| `checkIndexProjection` (`scripts/validate-content.ts:57-61`) + `isPublishedArtifact` (`src/lib/artifact-source.ts:44-57`) + the 16-line workaround at `scripts/build-fixture.ts:71-86` | **Delete all three.** The published-versus-substitute branch exists only because one file is committed and the other is generated. When a single CI run generates both, the comparison proves the producer agrees with itself |
| `tests/built-routes.test.ts:117-118` — `assert.deepEqual(builtRoutes(), expectedRoutes())` | **Keep, but stop calling it a privacy gate.** `expectedRoutes()` (`:98-108`) derives from the same entries the producer chose, so it cannot detect an over-publish. It proves the build is consistent with the artifact and nothing more. G1 is the only statement about what the user authorised |
| `tests/built-routes.test.ts:1430-1440` — skips when `entries.length > 1` | **Delete.** It exists for a published corpus of one note and becomes unreachable |
| `tests/built-routes.test.ts:382-397` — asserts `/about/` says *"approved for publication"* and *"is not published"* | **Delete the two claims.** Under default-publish they are false statements the gate requires the site to make |
| `tests/built-routes.test.ts:399-440` — forbids `folder`, `frontmatter`, `.md`, `allowlist file` on every non-note page | **Narrow to the private half.** A general SSG's `/about/` must be able to say "folder", "frontmatter" and ".md" — those are now its configuration surface. Absolute local paths and user markers stay forbidden |
| `tests/route-model.test.ts:283-305` — asserts the word `exporter` appears in the facet-collision message | **Rewrite the message and the assertion.** The collision is now the user's to fix, and the message must say where |
| `tests/verify.test.ts:109-114` — `GATE_TOOLS` contains `python` | **Falls out automatically.** The set is derived from `package.json` scripts; deleting `sync:content` removes it on the same commit |

---

---

## 4. Configuration and the site-identity split

### 4.1 The format: a TypeScript file, validated twice

The competitive survey ranks configuration formats by one question — *what happens to a key
you typed wrong* — and the answers separate cleanly (research §2, offsets 37,938–41,628):

| Tool | Format | Wrong key | Verdict for us |
| --- | --- | --- | --- |
| Starlight | TS importing the integration, Zod `.strictObject` | hard error, domain-specific message | **the shape to take** |
| Zola | TOML, `deny_unknown_fields` + `impl Default` | hard error; file contains only what you changed | the failure discipline to take |
| Docusaurus | JS object | hard error naming every unrecognised field | message shape to copy |
| Quartz v5 | YAML + JSON Schema, never executed | **silently ignored** | the outcome to design against |
| 11ty | JS mutating `eleventyConfig` | wrong method throws; wrong *value* unchecked | half a gate |

**Decision: `publish.config.ts` in the notes repository, a default-exported object literal
with `satisfies PublishConfig`, parsed at build time by a strict validator in the same shape
as `src/lib/schema.ts`.**

Three properties, each bought by a specific choice:

| Property | Mechanism | Grounding |
| --- | --- | --- |
| A wrong key is a red squiggle while typing | `import type { PublishConfig } from '@thoughtscape/publish'` + `satisfies` | research line 300: *"types for authoring, Zod for the build, and the two are derived from the same shape"* |
| A wrong key fails the build even with no editor, no TypeScript, no `node_modules` | the same strict validator that already rejects unknown artifact fields (`src/lib/schema.ts:390`, `:528`) | research line 370: *"if we ship a schema, the build must run it"* |
| The file works in a repository with no `package.json` and no `tsconfig.json` | Node 24 type stripping erases a type-only import of an unresolvable specifier | measured on Node v24.18.1 (`.nvmrc`): `import type { X } from 'package-that-does-not-exist'` in a temp directory with no `package.json` loads and returns its default export |

That last row is the reason this beats TOML or YAML for a file that lives in *someone
else's notes repository*. The user gets autocomplete if `@thoughtscape/publish` is
installed, and identical runtime behaviour if it is not; nothing has to be installed for the
config to be valid.

**No Zod.** Starlight's Zod is doing what `validateArtifact` already does here, in a style
this repository already reads — accumulate issues, name the file, name the field, name what
was received (`src/lib/schema.ts:390`). Adding a dependency to restate an existing idiom is
a dependency spent on nothing.

**One filename, no search order.** `publish.config.ts`, at the root of the notes repository,
or the path given by the Action's `config:` input. Not `.js`, not `.mjs`, not `.json`, not
`.config/`. A search order is a place for a file to be silently not found.

**Declarative only, no escape hatch yet.** Quartz's `loadQuartzConfig({ overrides })` door
(research line 304) is the right shape *when there is a plugin API to reach through*. There
is none, so the door opens onto nothing. Add it when a user asks for something the keys
cannot express — not before.

### 4.2 Every literal, and where it goes

The audit (research §2, offsets 5,214–9,462) counts **13 files a new user must edit today**,
plus 3 test files encoding the old copy, and ~40 individual string edits inside
`src/lib/translations.ts` alone. The table below is that list with a disposition for each.

| Literal | Written today | Becomes | Default |
| --- | --- | --- | --- |
| Origin | `astro.config.mjs:73` `site: 'https://thoughtscape.invalid'` | `origin` | `http://publish.localhost/` — see 5.5 |
| Site name | `src/lib/site.ts:37` `SITE_NAME` | `title` | **none; deploy fails without it** |
| Site name, second copy | `src/lib/translations.ts:362`, `:537` (`siteDescription`) | key becomes `(siteName) => …`, like `feedTitle` at `:363` | derived from `title` |
| Subtitle | `translations.ts` `siteSubtitle` | `subtitle` | empty; omitted from markup when empty |
| Page titles | `src/pages/about.astro:6`, `src/pages/privacy.astro:6` | — | both pages deleted, see 4.4 |
| About copy | `src/pages/about.astro:12-49` | a Markdown note in the notes repo | seeded by `init`, not shipped |
| Privacy copy | `src/pages/privacy.astro:60-115` | a Markdown note in the notes repo | seeded by `init`, not shipped |
| Navigation labels | `translations.ts:367-374` / `:542-549` | stay in the contract; `nav` config selects *which* items appear | all built-in routes |
| Owner-specific chrome (~20 keys × 2 locales) | `translations.ts` EN `:361,398-430,462-464,503`; zh mirrors | **rewritten, not configured** | see below |
| Package name | `package.json:2` | irrelevant — the generator is a dependency, not a fork | — |
| Vault path | `package.json:11` (`sync:content`, Python) | `contentDir` | `.` — the notes repo root |
| Storage namespace | `src/scripts/preferences.ts:26-27`, `theme-init.js:22,25` | **stays hardcoded** | see below |
| Social card | `public/og-card.png` + `scripts/render-og-card.ts` | `brand.socialCard`, a path in the notes repo | none; `og:image` omitted when unset |
| Mark | `public/favicon.svg`, `.ico` | `brand.icon` | the shipped default |
| Internal class prefix | `src/lib/markdown.ts:317,319,538,…` | **stays hardcoded** — not user-facing | — |

Three of those rows are decisions rather than moves:

**The ~20 owner-specific chrome keys are rewritten, not made configurable.** They say
"projection", "private Obsidian garden", "allowlist", "approval list", "私有库". Under
default-publish every one is factually wrong (research line 60), and a *wrong* sentence
does not become right by being overridable — the default is what almost every user ships.
Rewrite them once to describe what the tool now does, keep them in the contract, and leave
them out of the config surface. A user who wants different chrome is asking for i18n
overrides, which is a separate feature nobody has requested.

**The storage namespace stays hardcoded.** `localStorage` is partitioned by origin, so
`thoughtscape:theme` on two different sites is already two different keys. Making it
configurable buys isolation the platform already provides, and costs the invariant
`tests/design-tokens.test.ts:388-399` exists to hold — that `preferences.ts` and
`theme-init.js` agree on the literal. Deliberate exclusion, not an oversight.

**`brand.socialCard` has no default and `og:image` is omitted when it is unset.** The
committed `public/og-card.png` carries a wordmark and a green mark; shipping it as a default
puts this owner's brand on every user's social card. Regenerating it per site is not
available either — `scripts/render-og-card.ts:4-10` is explicitly hand-run and rasterizing
at build time was the cost the satori+sharp decision rejected. So: no card unless the user
supplies one, and the metadata gate becomes *`og:image` is present exactly when
`brand.socialCard` is configured*, which is a stronger assertion than the unconditional one
it replaces.

### 4.3 How a wrong or missing key fails

Ordering is the whole design. The validator runs **before any file discovery**, so a config
error can never be masked by a build that otherwise succeeded.

| Failure | When | Message |
| --- | --- | --- |
| Unknown top-level key | config parse, step 1 | `publish.config.ts: siteTitle: unknown key is not allowed. Did you mean "title"?` — the Docusaurus shape (research line 291), the `src/lib/schema.ts:528` idiom |
| Wrong value type | config parse | `publish.config.ts: exclude: must be an array of strings, got "private/**"` |
| Missing `title` at deploy | deploy gate | build succeeds locally; the Action refuses to upload |
| `origin` still the preview default at deploy | deploy gate | `origin is still http://publish.localhost/, which is a loopback name and cannot be a public canonical URL. Set origin in publish.config.ts.` |
| `origin` is not an absolute URL with a scheme | config parse | `new URL()` failure, restated with the file name |
| Exclusion pattern matching zero files | after discovery | **hard failure**, research line 381: a pattern matching nothing is a typo or dead config, and both should stop the build |
| Config file absent | config parse | all defaults; build succeeds; deploy refuses on `title` and `origin` |

Two of those are behaviour changes worth naming. `src/lib/site.ts:80-95` currently throws
`NO_SITE` whenever the origin is missing and any absolute URL is needed — canonical link,
feed id, sitemap `<loc>`. Owner decision 4 ("no domain needed to preview") means that path
must stop throwing, so **the origin is never absent; it defaults to the preview origin**,
and the fail-loud moves from *build* to *deploy*. That is a strictly better place for it: a
missing origin was never a local-build problem, and it is always a deployment problem.

And the config is validated at the build, not only at deploy, because Quartz v5's YAML
schema is thorough, correct, and never executed (research line 294), producing a
troubleshooting entry titled *"Plugin options not taking effect."* An unenforced schema is
worse than none: it makes the config *feel* validated.

### 4.4 The split: the tool, and this owner's site

Today they are the same repository, and three artifacts prove it.

| Artifact | Today | After |
| --- | --- | --- |
| `src/data/content.json` | one real personal note, 5,272 B, slug `add-password-to-pfx-windows` | **deleted** |
| `tests/fixtures/valid-corpus.json` | 32 synthetic bilingual entries, reachable only via `CONTENT_ARTIFACT` | the **default** artifact for this repository's own build |
| `src/pages/about.astro`, `privacy.astro` | shipped pages asserting an allowlist that will no longer exist | **deleted**; seeded as Markdown by `init` |

**Delete the personal note.** It is the only content in this repository, it is not synthetic,
and under a default-publish tool it is a note the tool's own repository publishes for no
reason. The 32-note fixture corpus already exercises strictly more of the surface — it is
what `pnpm run build:fixture` builds and what 504 of the 505 tests pass against.

That deletion has a gate consequence that must be handled deliberately, because this is
exactly the coverage-illusion shape. `src/lib/artifact-source.ts:55` `isPublishedArtifact`
returns true only for `src/data/content.json`, and `scripts/validate-content.ts:118` runs the
`content-index.json` projection check **only when that returns true**. Delete the file and
that check never runs again while still appearing green.

**Fix: `isPublishedArtifact` is deleted, and the index-projection check runs on every build,
against whichever artifact the build selected.** The check compares
`public/content-index.json` byte-for-byte against a projection of the artifact
(`scripts/validate-content.ts:36`), and there was never a reason it applied to one corpus
only. The gate gets *stronger* by generalising — which is the pattern the recurring-hazards
list keeps recording: every high-value defect came from hardening a gate.

**Delete about and privacy.** Both are long-form prose and the generator already renders
long-form prose; there is nothing they need that a Markdown note does not have. Two further
reasons make this the only honest option:

- `src/pages/privacy.astro:106-110` and `about.astro:20-24, 26-31` assert an allowlist. Under
  default-publish that claim is false, and it is false in the one document a reader consults
  to find out whether it is true.
- `tests/translations.test.ts:483` carries `PROSE_PAGES = new Set(['about.astro',
  'privacy.astro'])` — the two files most needing to become user content are exempted from
  the chrome contract **by filename**, with the comment "adding a third is a deliberate act."
  Deleting them deletes the exception, and the chrome gate then covers every remaining file
  in `src/` with no carve-out.

`SITE_MAP` (`src/lib/routes.ts:386-394`) loses `navAbout` and `navPrivacy` as fixed entries;
the `nav` config lists which built-in routes appear, and a user's own about note is an
ordinary note they link from wherever they like.

**What `init` seeds.** One command writes into the notes repository: `publish.config.ts` with
`title` and `origin` filled from prompts and every other key absent, `.github/workflows/
publish.yml` (section 5.1), and two starter Markdown notes — an about and a privacy note
whose text describes *the tool's actual behaviour under the user's own configuration*,
including the exclusion patterns they set. That last property is the only thing that makes a
privacy page truthful under default-publish.

### 4.5 The gates that must change

| Gate | Today | After |
| --- | --- | --- |
| `tests/metadata.test.ts:831-875` | regex-reads `site:` from `astro.config.mjs`, walks `src/ scripts/ tests/ public/`, fails if the host appears anywhere else | reads the resolved origin from the loaded config; the walk is unchanged and now also covers the config default |
| `tests/translations.test.ts:473-525` | walks `src/`, fails on any module holding a chrome literal; exempts `about.astro`, `privacy.astro` by name | exemption deleted; the config is user data outside `src/`, so it never becomes a second home for chrome |
| `tests/built-routes.test.ts:382-397`, `tests/route-model.test.ts:283-305` | assert the old copy and the fixed `/about/` `/privacy/` routes | assert the nav set the config declares |
| **new** — identity scan | — | build the fixture corpus with a sentinel `title` and `origin`; assert both appear in `dist/` head, feed, and sitemap, and that `thoughtscape` and `thoughtscape.invalid` appear **nowhere** in `dist/` |

The new gate asserts on content, not on cardinality: it does not count how many literals
moved, it proves that a configured value reaches the output and that the old one does not.
And it must run on the fixture build, because a one-corpus assumption is the failure mode
`build:fixture` exists to catch.

---

## 5. The GitHub Action and adoption path

### 5.1 What the user adds

One file, `.github/workflows/publish.yml`, in their notes repository. Nothing else.

```yaml
name: publish
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: thoughtscape/publish-action@v1
      - uses: actions/deploy-pages@v4
        id: deploy
```

Twenty-six lines, of which the user edits zero. `publish.config.ts` carries everything a
site differs by, which is the point: a workflow file with per-site values in it is a second
configuration surface with no validation.

**Inputs**, modelled on `withastro/action`'s deliberately small surface (research line 366) —
every one has an obvious default:

| Input | Default | Purpose |
| --- | --- | --- |
| `config` | `publish.config.ts` | path to the config |
| `content-dir` | `.` | overridden by `contentDir` in the config if set there instead |
| `out-dir` | `dist` | |
| `generator-version` | the version pinned by this action release | escape hatch for pinning a patch early |
| `fail-on-new` | `true` | fail on a published-slug addition not acknowledged in the committed manifest (research line 382) |

**What the action does, in order.** The ordering is the fail-closed argument, so it is fixed
rather than incidental:

1. Refuse a shallow clone. `git rev-parse --is-shallow-repository` returning `true` fails
   with a message naming `fetch-depth: 0`. The survey confirms this is required whenever git
   timestamps supply `created`/`updated`, and Quartz's own hosting docs carry a warning about
   Cloudflare's shallow clone (research line 351). A shallow clone otherwise produces a
   *silently wrong but perfectly valid-looking* site, which is precisely the class of failure
   documentation does not prevent.
2. Set up Node from `.nvmrc` if the notes repo has one, otherwise the version the generator
   declares in `engines`.
3. `npx @thoughtscape/publish@<pinned> build` — install and run in one step, no lockfile in
   the notes repo, no `node_modules` committed.
4. Config parse. Unknown key, wrong type, unresolvable origin: fail here, before discovery.
5. Discovery and exclusion. Any pattern matching zero files fails the run.
6. Build, then every gate `verify` composes — including the privacy residue scan
   (`scripts/scan-residue.ts`), which is the product and not a formality.
7. The publish-manifest diff. An addition not present in the committed manifest fails unless
   `fail-on-new: false`. This is the structural replacement for the allowlist's fail-closed
   property: default-publish for authoring convenience, explicit acknowledgement for the
   publication event.
8. `actions/upload-pages-artifact` with `out-dir`.

Steps 4 through 7 are the generator's own exit codes, not YAML. The existing
`.github/workflows/verify.yml` already makes this argument in its header comment — there is
deliberately no list of gates in the workflow, because a workflow that restates a gate list
drifts from it. Same rule here: the action runs one command, and the command owns the gates.

### 5.2 Multi-repo: who checks out what

Nobody in the survey does this cleanly (research §5, offset 47,183). Quartz collapses it —
content lives *inside* the fork, copied or symlinked, so CI only ever sees the copy.
Digital Garden inverts it — the Obsidian plugin pushes notes into the site repo, which
requires the Obsidian app to be open to publish. And *nobody* uses `actions/checkout` with
`repository:`/`path:` to place two repos side by side.

**Neither does this plan, and that is the point: there is no second checkout.**

| | Where | How it gets there |
| --- | --- | --- |
| Notes | `$GITHUB_WORKSPACE` | `actions/checkout` in the user's own workflow |
| Config | `$GITHUB_WORKSPACE/publish.config.ts` | committed by the user |
| Generator | npm cache | `npx @thoughtscape/publish@<pinned>` |
| Output | `$GITHUB_WORKSPACE/dist` | the build |

The generator is a published npm package consumed as a dependency, so a "multi-repo build"
is an ordinary single-repo build with one dependency. A composite action runs on all three
runner OSes with no container startup cost, and needs no committed `dist/` bundle the way a
JS action does (research line 349).

**The generator's own repository — this one — is not in the user's dependency graph as
source.** It is not forked, not cloned, not templated. That eliminates the entire upgrade
failure class the survey documents: Quartz's `npx quartz upgrade` is a git pull into the
user's fork with a documented merge-conflict resolution procedure, special-cased lockfile
backup and restore, and an `npx quartz restore` for recovering from a botched merge
(research line 320).

### 5.3 Version pinning and the upgrade story

Two layers, and the second is the one the survey says is easy to miss.

| Layer | Pinned as | Who moves it |
| --- | --- | --- |
| Action | `thoughtscape/publish-action@v1`, a floating major tag | the user, by editing one line |
| Generator | an **exact** version inside the action, `@1.4.2`, never a range | a publish-action release |

The floating major is `withastro/action`'s model and `actions/jekyll-build-pages`'s
documented release process: publish a semver tag, then a release workflow moves the major
tag behind an environment approval (research line 314). The consequence users care about is
that `@v1` keeps working forever and a new major is opt-in.

The exact inner pin is the caveat the research attaches to that model: *"the action must not
silently pick up behaviour changes within a major. Version-pin the generator inside the
action, not just the action"* (research line 316). A caret range would mean a generator minor
release changing exclusion or link-resolution semantics for every `@v1` user on their next
push, with no diff anywhere in their repository. So the generator version moves only when a
publish-action tag moves, and a generator patch ships as a publish-action patch — which the
floating `v1` tag delivers, which is the deliberate trade: patches are automatic, behaviour
changes are not.

**Explicitly not built: a plugin registry.** Quartz v5 names plugin sources in
`quartz.config.yaml`, pins commits in `quartz.lock.json`, and documents that on a fresh
clone *"typically around 10–15"* plugins fail to build, with the fix being `--latest`, which
discards the pinning (research line 322). A lockfile whose documented recovery is to stop
using the lockfile is not a lockfile. One action, one version, no per-plugin clones in CI.

**What breaks on a major:**

| Change | How the user finds out |
| --- | --- |
| A config key renamed or removed | strict validator, unknown-key error naming the key and the release that removed it — the same message shape as `src/lib/schema.ts:528` |
| A default changed | release notes; the config file states only what the user changed (Zola's property, research line 301), so a changed default is *visible* precisely because it is absent from their file |
| Output structure changed | their site rebuilds and looks different; the deploy is theirs to roll back by reverting the `@v2` line |
| Nothing, until they act | `@v1` continues to resolve its own pinned generator forever |

The upgrade is: edit `@v1` to `@v2`, push, read the failure, fix the named key. Not a merge
conflict in a text editor.

### 5.4 What the user configures outside the file

| Setting | Where | Value |
| --- | --- | --- |
| Pages source | repository Settings → Pages → Build and deployment | **GitHub Actions** (not "Deploy from a branch") |
| Permissions | in the workflow, shown above | `contents: read`, `pages: write`, `id-token: write` |
| Environment | created automatically on first deploy | `github-pages` |
| Secrets | — | **none** |

**No secrets, and that is a design constraint rather than a happy accident.** Three things
have to hold, and all three do:

- The notes repository is the same repository as the deploy target, so the automatic
  `GITHUB_TOKEN` is sufficient and `actions/deploy-pages` authenticates by OIDC using
  `id-token: write`.
- The generator is a public npm package, so no registry token.
- Nothing at build time reaches a network service. There is no analytics key, no comment
  provider, no search backend — the CSP already forbids all three
  (`default-src 'self'` in `public/_headers`), and Pagefind is a static index.

`permissions:` is written out rather than left to the repository default, which is the same
posture `.github/workflows/verify.yml` already takes.

**Cloudflare Pages, if the user prefers it, needs a secret** — an API token — and a
`wrangler` step, so it is documented as the alternative and not the default. The zero-secret
path is the one `init` writes.

**A private notes repository with a public site** is the one shape that needs a token, since
it is two repositories and a cross-repo push. It is documented as out of scope for v1 with a
one-line reason: the plan's zero-secret property is worth more than the shape, and a private
repository can publish to its own private-repo Pages site on a paid plan with no change at
all.

### 5.5 Local preview at `http://publish.localhost/`

**No hosts-file edit, and the reason is specific.** RFC 6761 reserves `.localhost` and
requires resolvers to map the name *and all its subdomains* to loopback. This is not
aspirational — measured on this machine, `curl http://publish.localhost/` reports
`Host publish.localhost:80 was resolved. IPv6: ::1 IPv4: 127.0.0.1` with no entry in
`C:\Windows\System32\drivers\etc\hosts`. Chrome, Firefox, and Safari do the same. It is the
same property that made `.invalid` the right placeholder origin at `astro.config.mjs:60-73`
— a reserved name that cannot resolve to somebody else's server — except that this one also
*works*.

**What Astro needs: nothing.** Three facts, each verified rather than assumed:

| Concern | Finding |
| --- | --- |
| Does the server bind to `publish.localhost`? | **No, and it must not.** Node's `dns.lookup` does not implement RFC 6761 — `dns.lookup('publish.localhost')` returns `ENOTFOUND` here, and `server.listen(0, 'publish.localhost')` fails with the same. The server binds `127.0.0.1` as it already does; the *browser* resolves the name. |
| Does Vite reject the `Host: publish.localhost` header? | **No.** `isHostAllowedInternal` returns true for any hostname where `hostname === "localhost" \|\| hostname.endsWith(".localhost")`, before consulting `allowedHosts` (vite 8.2.0, `dist/node/chunks/node.js:17383`). No `server.allowedHosts` entry is needed. |
| Is the origin trusted for CORS/WebSocket? | **Yes.** `defaultAllowedOrigins` is `/^https?:\/\/(?:(?:[^:]+\.)?localhost\|127\.0\.0\.1\|\[::1\])(?::\d+)?$/` (same file, `:690`) — the `(?:[^:]+\.)?` group is exactly the subdomain case. |

So the entire implementation is that `origin` defaults to `http://publish.localhost/`, and
`astro.config.mjs` reads `site:` from the loaded config. `astro.config.mjs:4` already imports
a `.ts` module from `src/lib/`, so importing the resolved config is the existing pattern, not
a new one.

**The port is the one honest wrinkle.** `http://publish.localhost/` with no port is port 80,
which requires privilege on Linux and macOS. Astro's default is 4321. The decision:

- The documented preview URL is `http://publish.localhost:4321/`. The hostname is what owner
  decision 4 is about — an identity-free, domain-free, hosts-file-free local origin — and the
  port does not affect that.
- `--port 80` is documented as the way to get the bare URL where the platform allows an
  unprivileged bind. It bound successfully here on Windows; it will need `sudo` elsewhere,
  and no default should require `sudo`.
- `origin` defaulting to `http://publish.localhost/` **without** a port is deliberate:
  canonical URLs, the feed id, and `<loc>` entries in a preview build should not carry a
  development port, and they are never deployed anyway because the deploy gate refuses this
  exact value (4.3).

**The build produces a complete, correct, undeployable site.** Canonical links, the Atom
feed, the sitemap, and `robots.txt` all resolve against `http://publish.localhost/` and are
therefore all obviously local at a glance — a property `.invalid` gave up by producing URLs
that looked plausible. `src/lib/site.ts:80-95` stops throwing `NO_SITE`, and the fail-loud
moves to the one place it belongs: the moment the site is about to become public.

---

## 6. Tickets

Twelve tickets. Three are **prerequisites the adversarial reviews created** — without them
the plan's own adoption path does not run — and they come first.

Sizing note, from S5: the drafted producer is one ticket touching eight files and every gate
in the repository. Three agents have stalled in this session on tasks that large. The
producer is split into four tickets that can each be implemented *and* reviewed in one pass.

### 6.1 Ticket table

| ID | Title | Depends on | Priority | Wave |
| --- | --- | --- | --- | --- |
| TK-24 | Make the package installable and runnable from another directory | — | P0 | A |
| TK-25 | Redesign the report disclosure surface | — | P0 | A |
| TK-26 | Discovery and exclusion, with defaults that work on a real repository | TK-24 | P0 | B |
| TK-27 | Link resolution: five forms, one traversal, typed outcomes | TK-26 | P0 | C |
| TK-28 | Backlink derivation from all link forms | TK-27 | P0 | C |
| TK-29 | The report file and its gates | TK-26, TK-28 | P0 | D |
| TK-30 | Configuration file and loader | TK-24 | P0 | B |
| TK-31 | Site-identity extraction | TK-30 | P0 | D |
| TK-32 | The GitHub Action and `init` | TK-24, TK-30, TK-25 | P0 | E |
| TK-33 | Local preview at `publish.localhost` | TK-30 | P1 | D |
| TK-34 | Scale evidence at 1,000 and 10,000 notes | TK-28 | P1 | F |
| TK-35 | Requirements-document revisions | all above | P1 | F |

### 6.2 Parallelism, keyed on file ownership

`quartz-parity-plan.md:352` records this project losing a merge to parallelism claimed on
logical independence. S4 shows the three drafted sections write the same eight files —
`schema.ts`, `scan-residue.ts`, `site.ts`, `routes.ts`, `artifact-source.ts`,
`validate-content.ts`, and two test files. So the default is serial, and parallelism is
allowed only where the fence is a directory boundary rather than an argument.

| Wave | Runs together | Why they do not collide |
| --- | --- | --- |
| A | TK-24, TK-25 | ~~TK-24 owns `package.json` and the packaging entry point; TK-25 owns the workflow surface and `.gitignore` seeding. Disjoint.~~ **Both delivered, and they were not disjoint.** TK-25's `prepack` fix is a `package.json` script, which TK-24 owns — the two ran serially and the second read the first's manifest. Had they run together, the merge would have been the `quartz-parity-plan.md:352` collision again. The lesson holds: file ownership is the fence, and "the workflow surface" was not a file. |
| B | TK-26, TK-30 | TK-26 owns the new producer modules under `src/producer/`; TK-30 owns the config module and `astro.config.mjs`. Neither touches `schema.ts` or the gates. |
| C | TK-27, then TK-28 | Serial. TK-28 consumes the typed resolution outcome TK-27 defines; splitting them across agents would mean defining the type twice. |
| D | TK-29, TK-31, TK-33 | TK-29 owns `scan-residue.ts` and the gate tests; TK-31 owns `src/pages/`, `src/components/`, `translations.ts`, `site.ts`; TK-33 owns preview config only. **TK-29 and TK-31 both touch `site.ts`** — serialise those two on that file, TK-31 last. |
| E | TK-32 alone | It integrates everything and is the first ticket a stranger's repository actually exercises. |
| F | TK-34, TK-35 | TK-34 writes fixtures and a benchmark; TK-35 writes documentation. Disjoint, and neither blocks anything. |

### 6.3 The three prerequisite tickets

---

#### TK-24 — Make the package installable and runnable from another directory

**Problem.** The adoption path is `npx @thoughtscape/publish@<pinned> build` in a stranger's
notes repository. Measured against `package.json`, that cannot run: `temml`, `mermaid`,
`happy-dom`, and `pagefind` are all devDependencies, and npm installs no devDependencies of
an installed package. `src/lib/math.ts:26` imports `temml` at module scope,
`src/lib/mermaid-environment.ts:24` imports `happy-dom` at module scope, and
`src/lib/markdown.ts:30-31` imports both unconditionally — so the build fails at import
before reading a single note. `package.json` also has no `bin`, no `files`, no `exports`, and
`version: 0.0.1`, and `astro.config.mjs` is located by cwd, which under `npx` is the user's
repository rather than this one.

**Scope.**

1. Move every dependency the build imports at runtime from `devDependencies` to
   `dependencies`. Keep the genuinely dev-only ones (`playwright`, `oxlint`, `vitest`) where
   they are, and prove the split by installing the packed tarball.
2. Add `bin`, `files`, and `exports`. Set a real version.
3. Decide and implement how `astro build` gets its project root when cwd is the user's
   repository — a `--root` argument, or invoking Astro's JavaScript API with this package's
   own root and an injected content path. State which and why.
4. Keep `pnpm run build` working in this repository unchanged.

**Acceptance criteria.**

- `npm pack`, install the tarball into an empty directory containing three `.md` files, run
  the binary, and get a site in `dist/`. This is the gate; everything else is detail.
- No import of a devDependency survives in any module the build reaches at runtime, proven
  by a test rather than by inspection.
- This repository's own `pnpm run verify` and `pnpm run build:fixture` are unchanged.

**Delivered** — `5db558c`, then `8127c26` for the follow-up. Report at `.tmp/tk-24-report.md`.
The acceptance gate ran for real: `npm pack`, install into an empty directory holding three
`.md` files, run the binary, get a site.

Two blockers this ticket found that the text above does not mention, both invisible from
reading and immediate on running:

- **Node refuses to strip types under `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),
  and every module here is TypeScript run directly by Node. No flag lifts it, and pnpm's
  layout does not help — a tarball install resolves to `node_modules/.pnpm/…`, still under
  `node_modules`. Closed by compiling at publish time (`8127c26`): the tarball carries no
  `.ts`, no `.map`, no `.d.ts`, so the restriction is not on the path at all.
- **`astro build --root` does not work from a foreign cwd.** `getOutDirWithinCwd`
  (`astro/dist/core/build/common.js:76-82`) discards an `outDir` that is not under cwd and
  stages prerender output at `<cwd>/.astro/` instead, which `ssrMoveAssets` then `rename`s —
  and a rename cannot cross a device. cwd must be the package (for module resolution) and
  `outDir` must be under cwd (for the rename), so staging-then-copy is the only shape
  available, not a workaround. A test imports the function and asserts the redirect, so an
  Astro upgrade that changes this is a red gate rather than a mysterious `EXDEV`.

---

#### TK-25 — Redesign the report disclosure surface

**Problem.** The drafted design writes the exclusion report — every excluded path and the
rule that excluded it — into the workflow run log and the Action step summary, justified as
"the user's own private repository". That premise is false on the documented free path:
GitHub Pages from a private repository requires a paid plan, so the zero-secret adoption path
is a **public** notes repository, whose workflow logs are world-readable and retained 90 days
by default. A list of paths like `clients/acme/2026-renewal.md` is an index to the private
set even when no body leaks. Separately, `init` seeds no `.gitignore`, so the first
`git add -A` commits the report, the artifact, and `dist/` into public git history, where
deleting them does not remove them.

The owner's position, which this ticket implements: **an excluded file is not necessarily a
secret** — a user may exclude for many reasons — but the exclusion *list* must still not be
published.

**Scope.**

1. Decide where the report may be written and where it may not, for a public repository, a
   private repository, and a local build. Default to the safe case.
2. Specify what the workflow log and step summary are permitted to contain — counts and
   rule identifiers are probably safe; paths are not.
3. `init` seeds a `.gitignore` covering `content-report.json`, the artifact, and `dist/`.
4. Decide what a user who *wants* the detailed report locally does to get it.

**Acceptance criteria.**

- A gate asserts no excluded path, and no basename of one, appears in anything the Action
  writes to a log, a step summary, or a committed file.
- Non-vacuity: a fixture whose excluded note has a distinctive filename token must have that
  token present in the local report and absent from every published surface, both halves
  asserted.
- `init` output, committed with `git add -A`, contains none of the three generated artifacts.

**Delivered** — `11b7cf2`, specification at `.tmp/tk-25-spec.md`, report at
`.tmp/tk-25-report.md`. `pnpm run verify` 497 passed / 26 skipped.

Three things the ticket learned that the text above got wrong:

- **The destination.** Both the draft's `<cwd>/.thoughtscape/` and §2.5's "beside the
  artifact" are destroyed or committable. The report lives at
  `<git-dir>/publish-report/content-report.json` — measured: `git clean -xfd` deletes a
  self-ignoring worktree directory whole, and nothing under `<git-dir>` can be staged.
- **`init` does not exist**, so scope item 3 landed as `ensureIgnored()` plus its gates, and
  the seeding command itself is TK-32's. Acceptance criterion 3 is therefore a specification
  today, not a gate, and is labelled so rather than given an invented test.
- **The `npm pack` gap, which this ticket did not know it had.** A bare `npm pack` shipped 29
  `.ts` files because the compile step lived in a `pack` script npm's lifecycle never runs.
  Closed with a `prepack` that refuses and names the real script.

Also delivered against the standing constraint that this tool is nobody's in particular: the
seeded marker is `# added by the publish tool`, not the project's name, and the report
segment is `publish-report/`. A stranger's `.gitignore` and `.git/` carry no trace of who
wrote the tool.

Two defects in existing code fell out of the gates: the CLI's workspace cleanup could replace
the build's own failure (Windows `EBUSY` discarding five residue findings), and the
`no Markdown found` path threw before counts were recorded, leaving a report claiming
`aborted` with three zeroes.

One gate does not run in CI and says so in its own source: the `check-ignore -v` parser's
negated-global-ignore fixture is Windows-only, because a POSIX path splits into exactly the
three fields a naive parser expects and cannot distinguish a correct parser from a broken
one. CI is `ubuntu-latest`.

---

#### TK-26 — Discovery and exclusion, with defaults that work on a real repository

**Problem.** Two measured defects make the drafted design fail on first use. `fs.globSync`
does not return dotfiles, so the shipped defaults `.git/**`, `.obsidian/**`, and `**/.*`
structurally match zero files — while the same design says a pattern matching nothing fails
the build with no downgrade flag. Every user's first push fails. Separately, H1 found that a
case-mismatched glob reports as matching on Windows and matching nothing on Linux, which is
the mistyped-glob case with a green gate on one platform and a red build on the other.

**Scope.**

1. Discovery over a git repository: what is a note, what is ignored structurally rather than
   by pattern, and how `README.md`, `LICENSE`, `.obsidian/`, and extensionless files are
   treated.
2. Exclusion by glob and by `publish: false`, with the precedence stated when they disagree.
   H2 found `publish: false` can be lost silently to malformed YAML elsewhere in the
   frontmatter and to `publish: no` — both must be loud.
3. **Separate structural ignores from user patterns.** A structural ignore matching nothing
   is normal; a user pattern matching nothing is a probable typo. The zero-match rule applies
   only to the second.
4. Case sensitivity: one behaviour across platforms, chosen and justified.

**Acceptance criteria.**

- A repository never written for this tool builds: mixed link styles, files sharing a
  basename, non-Markdown assets, a root `README.md`, `.obsidian/`, `LICENSE`.
- A user pattern matching nothing fails the build, naming the pattern and its config
  location. A structural ignore matching nothing does not.
- The same repository produces the same published set on Windows and Linux, proven rather
  than assumed.

---

The remaining tickets (TK-27 through TK-35) are specified in the sections above: the resolver
in §2, the report gates in §3, configuration and identity in §4, the Action in §5, and the
documentation revisions in §7. Each carries the acceptance criteria stated there.

---

## 7. Requirements-document revisions

`docs/public-knowledge-garden-requirements.md`, 1,020 lines, last updated 2026-08-06,
still marked *"Draft for owner review"* and *"Design only; this document does not authorize
deployment"* while eighteen tickets have shipped against it. Every row below is a line the
direction has reversed or overtaken. **Rewrite** means the requirement survives with a new
authority; **delete** means the requirement is gone and leaving it would be a false
constraint.

## 7.1 Header and framing

| Section (lines) | Says now | Must say | Change |
| --- | --- | --- | --- |
| Header (3-7) | "Draft for owner review"; "Design only; does not authorize deployment" | Implementation status reflects 18 delivered tickets and 505 tests; deployment authorisation stays separate and stays denied | rewrite |
| §1 (11, 13) | "implemented with Astro and Svelte"; "publishes only explicitly approved content… never receives non-allowlisted source material" | Astro only — zero Svelte is installed and five interactive surfaces ship without it. Publishes every Markdown file in a repository except those excluded by glob or `publish: false`; the privacy property is now the ledger diff (§3, G1), not the input | rewrite |
| §2 (29, 31, 38) | "private Obsidian-first knowledge system"; "explicit allowlisting"; "independent evolution from the private vault" | A git repository of Markdown files is the input. `ob-flow` is one consumer, not the definition | rewrite |
| §3.1 (45) | "Publish an explicitly reviewed subset" | Publish a repository, minus an audited exclusion set, with the publish set reviewed as a diff | rewrite |

## 7.2 The inverted authority

| Section (lines) | Says now | Must say | Change |
| --- | --- | --- | --- |
| §4 (73) | Non-goal: "publishing `sources/` or work content **by folder convention**" | — | **delete**. Folder conventions are now the primary exclusion channel |
| §4 (74) | Non-goal: "**treating a `publish: true` frontmatter field as sufficient authorization**" | — | **delete**. Exact inversion of decision 1. Replace with the new non-goal: *treating an exclusion glob as sufficient authorisation without a reviewed ledger diff* |
| §5.1 (84-86) | "Explicit projection, not vault deployment. The private repository owns content selection and export policy." | The repository is the content. The producer computes the publish set and **reports it**; the ledger diff is the approval boundary | rewrite (whole subsection) |
| §5.5 (100-102) | "Privacy is an artifact property" — every output must be safe to disclose independently | Unchanged, and it becomes the load-bearing principle rather than one of five. Add: the exclusion report is an artifact too, and it is the one artifact that must **not** be published (§3, G3) | keep + one clause |
| §6 glossary (108-111) | Private Source; **Publication Manifest** ("the reviewed allowlist"); Projection ("produced from the manifest"); Public Document ("one approved page") | Delete Publication Manifest. Redefine Projection as computed-from-exclusion. Add: Exclusion Rule, Publication Ledger, Exclusion Report, Ambiguity Report | rewrite + one deletion |
| §7.2 (148) | Owner can "approve content item by item in the private manifest" | Owner reviews the ledger diff before publication and excludes by glob or frontmatter | rewrite |
| §26 DR-1 (901-903) | "The private manifest and deterministic exporter are the authority… never infers publication from folder or frontmatter alone" | **Superseded, not erased.** Rewrite DR-1 in place with a `Superseded by DR-7` marker, and add **DR-7 — default publish**: the reversal, the fail-open consequence the owner accepted, and the seven gates of §3 as its mitigation. A decision record that reverses must show the reversal | rewrite + new record |
| §29 (1019) | "Preserve the three approval boundaries: infrastructure, item-level content, deployment" | Still three. The middle one becomes **ledger acknowledgement**: item-level approval is gone, publish-set approval replaces it | rewrite |

## 7.3 Mechanics that named the manifest

| Section (lines) | Says now | Must say | Change |
| --- | --- | --- | --- |
| §8.1 (177) | "Resolve aliases and headings **only within the allowlisted projection**" | Resolve five link forms within the published set; ambiguity is typed and reported, never silently resolved (competitors' worst shared defect) | rewrite |
| §8.1 (184) | "Curated public collections; **never mirror private folder names automatically**" | Folders are the hierarchy. `collection` (`src/lib/schema.ts` flat-slug validation) must grow a path shape or be joined by a path field | rewrite |
| §8.1 (190) | "Math: build-time KaTeX or equivalent **where approved**" | Delete "where approved". Temml shipped in TK-15 | rewrite (two words) |
| §8.2 (206) | "Canvas projection for **explicitly approved** canvases" | Delete the approval clause; Canvas stays skipped for its own reasons | rewrite (one clause) |
| §8.3 (217) | Deferred: "**Full vault explorer**: only public, curated collections are exposed" | The explorer shows the published folder tree. The deferral reason no longer exists; TK-05c shipped the rail | rewrite |
| §9.1 (238) | "A public slug is selected or derived **inside the projection process**" | Slug derives from the repo-relative path; uniqueness is validated and a collision is a **build failure naming every colliding file** — Quartz's `slugCollisions.ts` reporting shape with `console.warn` changed to a throw | rewrite |
| §9.3 (258-264) | "Removed content is represented by either a redirect or an intentional tombstone policy" | Owner decision 3: renames are delete-and-recreate, old URLs may 404. `status: 'tombstone'` stays a *separate* published-but-withdrawn state affecting only feed and sitemap (`src/lib/site.ts:262-281`) and must not be conflated with exclusion | rewrite |
| §10.2 (296) | Forbidden: "raw frontmatter not explicitly allowlisted" | Keep the rule, change its authority: the producer ships only fields on a published-field allowlist. Frontmatter is now also the *exclusion* channel, and that must be stated where the rule is | rewrite |
| §10.3 (298-313) | Twelve numbered exporter steps built on a manifest: "1. parse a versioned manifest… 10. write only after **target-project identity validation**" | Rewrite as discovery + exclusion + reporting. Items 2, 3, 4, 5, 6, 8, 9, 12 survive retargeted. Item 1 becomes "discover, apply exclusion rules, count every pattern's matches". Item 7 becomes G6 (assets reachable from published notes only). **Item 10 deletes** — target-project identity is `export.py`'s hardcoded `thoughtscape-publish` check. **Item 11 is promoted**, not changed: it already requires the privacy/audit summary §3 specifies | rewrite; one deletion, one promotion |
| §11.1 (320-321) | Layer model: "Private repository / Publication manifest + approved Garden documents" | Notes repository → Action → producer → artifact → site | rewrite |
| §14 (598) | Previews "do not fetch private/non-public targets" | Survives verbatim; the meaning shifts from "not in the manifest" to "not in the published set". Add: the preview payload stays a bounded projection, never a page scrape | keep + one clause |
| §15.2 (627) | Rejected: "non-public wikilinks" | Rewrite the *reason*, keep the *flag*. `wikilinks: false` (`src/lib/markdown.ts:194`) stays: satteri's built-in handler has no corpus access, so it can only emit a link it cannot verify — Quartz's 14.6% dangling-edge defect, adopted deliberately. Resolution stays producer-side, ahead of the renderer, and rejects on *unresolvable*, not on *non-public* | rewrite |
| §19.1 (695) | Scan for "non-allowlisted titles or slugs" | Scan for any slug absent from `published.txt`. Same gate, new authority — no deletion needed | rewrite |
| §21.1 (745) | Stage 1: "Validate private publication manifest" | Stage 1: discover, apply exclusion rules, **fail on any pattern matching nothing**, write the report | rewrite |
| §21.2 (762) | local: "synthetic or **explicitly approved** public artifacts" | local: the fixture corpus or the user's own repository | rewrite |
| §22.1 (769-781) | Exporter tests including "wrong source root" and "**wrong target identity**" | Delete both — they test `export.py`'s identity check. The other nine survive against the new producer. **Add** the five §3 cases with no test today: zero-match pattern, ambiguity with candidates, asset reachability, ledger diff, deletion round trip | rewrite + two deletions + five additions |
| §25 (883) | Launch: "every deployed page is present in the **approved public manifest**" | Every deployed page is present in `published.txt`, and `published.txt` was committed by a human-reviewed diff | rewrite |

## 7.4 Overtaken by scale or by delivery

| Section (lines) | Says now | Must say | Change |
| --- | --- | --- | --- |
| §11.3 (354-373) | Svelte 5 islands own search, explorer, previews, graph interaction, and toggles, each with a per-island contract | **Delete the subsection.** Zero Svelte is installed; all five ship as static markup plus 1,067 B gzip of vanilla script. Replace with one sentence deferring a framework to the Phase 2 interactive graph. This staleness predates the inversion — name it so a plan does not re-derive it | delete |
| §12.2-12.4 (409-521) | SQLite graph store sized against a curated corpus | Restate the sizing premise against an unbounded repository, or mark the whole store Phase 2 and stop sizing it. `MAX_ENTRIES = 900` (`src/lib/schema.ts:150-167`) justifies itself with "the allowlist is hand-curated" and is now false | rewrite |
| §13.3 (580-587) | Global graph ships only while it "remains legible at **current node count**" | Node count is unbounded. The bound must be a stated policy — `GLOBAL_NODE_LIMIT = 60` (`src/lib/graph.ts:131`) already is one — not an assumption about corpus size | rewrite |
| §18 (671) | Lighthouse 95+ on "representative article pages" | Name the corpus the budget is measured on. "Representative" meant one note for the life of this document | rewrite |
| §27 Q2 (937-943) | Open: curated collections vs. mirror folders vs. flat namespace | **Delete the question.** Decided: folders are the hierarchy | delete |
| §27 Q3 (950) | Option: "scheduled publication of already-approved manifest entries" | **Delete the option.** Q3 itself survives, and the ledger acknowledgement is what makes "every merge deploys" safe to choose | delete (one option) |
| §27 Q4 (953-959) | Open: URL and deletion policy | **Answered by owner decision 3.** Record it: delete-and-recreate, old URLs may 404, tombstone retained as a separate feed/sitemap state | rewrite |
| §27 Q7 (977-983) | Open: "one navigation language initially" | **Answered by hard constraint 6 and TK-16.** Bilingual chrome resolved per document, shipped | rewrite |

## 7.5 Survives unchanged

Recorded so a revision pass does not churn them: §5.2, §5.3, §5.4, §7.1, §7.3, §9.2, §10.1,
§16, §17, §19.2, §19.3, §20, §23, §28. Every one was written against an *output* property
or a *reader* property, and neither end of the pipeline changed.

---

## 8. Explicitly rejected

Twenty-five findings came back from two adversarial reviews. What follows is what they
killed, with the reason and the finding that killed it. Findings that produced a ticket
rather than a deletion are in §6 instead.

| Proposal | Why rejected | Killed by |
| --- | --- | --- |
| Bump `SCHEMA_VERSION` 1→2 so the reports have a top-level key | The reports contain precisely the strings the privacy model exists to keep out of the artifact — excluded paths, unresolvable targets, repo-relative source paths, the same shape `tests/preview-model.test.ts:208` uses as its canonical leaked field. A separate `content-report.json` that nothing under `src/` imports cannot reach a rendered page by accident, and changes no schema, version, or validator | S2; owner decision 2026-08-12 |
| G2 writing exclusion match counts into an artifact `publication` key | Same reason. The gate's substance is unchanged — a pattern matching nothing still fails loudly — only the data lands in `content-report.json` | S2 |
| Delete `checkIndexProjection` from `scripts/validate-content.ts` | Two sections disagreed; the deletion is the coverage illusion the same section spends pages warning about. The check is byte-for-byte and cheap. Keep and generalise it | S4 |
| Write the exclusion report to the workflow log and step summary | Publishes the index to the private set on a world-readable log with 90-day retention, because the free adoption path is necessarily a public repository | C1 |
| "It is the user's own private repository" as a disclosure justification | False on the documented default path — GitHub Pages from a private repository requires a paid plan | C1 |
| Apply the zero-match rule uniformly to shipped defaults and user patterns | `fs.globSync` structurally cannot match a dotfile, so three shipped defaults are permanently zero and every first push fails | C3 |
| Hard-fail on link ambiguity with no override | Unbounded and unoverridable, worst for root-level notes; a user cannot act on it from their own repository | M6 |
| Emit an asset pipeline to satisfy G6's third mutation | The gate is unsatisfiable as written because §2 never emits an asset — but building one to fix the gate inverts the priority. Not writing an asset pass is what keeps deny-by-default true | H4 |
| `published.txt` as a manual ledger | Never specified how it is created or updated; G1's own mutation table shows it failing the first push, and M1 shows it never shrinking, so a note published then excluded republishes with the gate green | S6, M1, M2 |
| Write §7's requirements revisions before the code settles | 52 table rows blocking nothing; writing them first is how they get rewritten twice | S4 |

**Tried and could not break.** The critics attacked and failed on three points, which marks
them load-bearing: the separate-report-file design survived every disclosure attack once the
log surface was removed; `checkCorpus` survives the inversion structurally and matters more
under a whole-repository producer than it did under a curated one; and the decision to
replace only the producer, leaving the rendering pipeline, design system, graph, and search
untouched, drew no substantiated objection from the over-engineering reviewer.

## 9. Decisions, settled 2026-08-12

All three forks are closed. Recorded here so the reasoning survives the ticket that
implements each.

### D1 — Link ambiguity warns; it does not fail

Resolve using the researched Obsidian order, render the link, and record the ambiguity in
`content-report.json` naming every candidate. Fail the build only under an opt-in strict
mode.

Hard-fail was rejected (M6) as unbounded and unoverridable, and worst exactly where it is
most likely — two root-level notes sharing a basename, which a stranger cannot act on from
their own repository. Silent resolution was rejected equally: that is Quartz's defect, where
zero matches and five matches fall through identically with no warning. Owned by TK-27.

### D2 — This repository is the tool only

No site of its own. The demo corpus becomes synthetic; the owner's site lives in `ob-flow`
as the tool's first consumer.

This closes the incomplete split S10 found, where `content-index.json`, `SITE_NAME`, and the
localStorage namespace still carried one owner's identity — including the personal note
still in `src/data/content.json`. Every remaining ticket treats this repository's content as
fixture rather than as publication. Owned by TK-31.

### D3 — TK-24 ships before any second design pass — **answered**

The plan was not implementable as drafted: three fatal findings and 22 behind them. TK-24 was
small, mechanical, independently valuable, and its acceptance test — `npm pack` into an empty
directory holding three Markdown files, run the binary, get a site — was the fastest way to
learn whether the rest of the design survives contact.

**It survived, and no second design pass followed.** TK-24 shipped, then TK-25. What the
evidence changed was narrower than a redesign and sharper than a guess: the packaging problem
was *understated* by the plan rather than overstated — two blockers appear nowhere in it and
both were invisible from reading — while the rendering pipeline, design system, graph and
search needed no change at all, because they were built against an artifact interface.

The method that replaced the second design pass is worth keeping. TK-25 was designed by three
independent designs, each attacked by two adversaries — one trying to extract the excluded
list from published surfaces, one attacking the gates for vacuity. All three designs were
broken; the survivors' pieces were converged against measurement, and the measurement decided
every case where two sections disagreed on a fact. That found, on paper and before any code:
a report destination that an ordinary `git clean -xfd` destroys, a gate whose only falsifiable
half was the one that could not fire, and a published site leaking excluded names through
wikilink display text. Cheaper than finding any of them in review.

C3 remains open, and TK-26 owns it.
