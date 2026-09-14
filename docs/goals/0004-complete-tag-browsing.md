# 0004 — Complete tag browsing

Status: ready. Created: 2026-09-14. Replaces part of [0001](0001-unified-public-query-model.md).

## Desired outcome

A reader can choose a published tag and reach every matching published note,
including matches beyond a single browser result page. The browser's tag query
and the complete static tag route agree on tag identity, label and membership.
Empty/exhausted results and an unknown tag are distinguishable.

This is one discovery capability. Its completion does not require interactive
graph drawing; the graph can consume the same tag semantics under 0005.

## Material bounds and prerequisites

Requires the normalized snapshot/static routes of
[0002](0002-consistent-static-relationships.md) and the shared working browser
runtime established with [0003](0003-reliable-lazy-previews.md). Follow
[tag semantics](../core-design/content-semantics.md),
[cursor rules](../core-design/sqlite-contract.md), and the existing
[`byTag` boundary](../core-design/build-and-runtime.md).

There must be a real reader-facing consumer of `byTag`, not only an exported
function or developer-console demo. Use the existing tag browsing surface; this
does not require a new dashboard or authoring feature. Static tag routes stay
complete and usable without JS or after enhancement failure. Browser enumeration
is slug-ordered; static display may remain title-ordered.

No browser-side tag normalization, alternate tag index, alias lookup semantics,
tag-generated graph edges, speculative reverse membership index, or schema growth.
Choosing/following a tag is explicit intent; scrolling a tag page is not permission
to prefetch the whole database.

## Completion evidence

Use an authored corpus with one tag spanning more than two chosen result pages,
equivalent spellings, non-equivalent key collisions, CJK/emoji labels, unused private
tags and isolated public notes. Expected membership must come from the authored
corpus, independent of the production normalizer/query result.

| Evaluation | Pass condition |
| --- | --- |
| Identity | NFC/lowercase-equivalent spellings have one deterministic key/label and one membership per note. Non-equivalent `C++`/`C#` key collisions fail the build. SQLite `NOCASE` is not substituted for the accepted rule. |
| Exhaustive pagination | The actual UI reaches all pages. Concatenated Worker results contain each expected slug exactly once in cursor order, with correct metadata and null continuation at exhaustion. A page boundary neither skips its lookahead row nor repeats the previous one. |
| Subject changes | Switching tags resets continuation. A late result for the old tag cannot replace the new selection. Invalid page sizes/cursors fail with bounded errors; an unknown tag is distinct from a known tag with no further results. |
| Static parity and failure | Static tag links/routes enumerate the same set. JS disabled or failed DB initialization preserves navigation to every matching note. Keyboard selection and result navigation work. |
| Language of results | Browser note titles carry the target note's effective language, applying the same `partLanguage` behavior as static tag lists, including notes with no declared language. |
| Privacy and cost | Withheld-only tags are absent; removed last-use tags disappear on a fresh rebuild. Previews and tag browsing share one runtime/download, with no independent corpus cache or public membership JSON. |

Run native query tests, production normalizer/collision tests, and real generated-
site browser tests. Include a control using the lookahead row as continuation: the
enumeration assertion must detect the skipped note. No new numerical latency
target is introduced here; 0008 evaluates measured cost.

## Completion record

Not completed. Record commit/PR, actual reader surface, exact commands and nonzero
results, expected/observed membership, page-boundary control, static parity and
failure observations. Archive only when the reader-facing outcome is demonstrated.
