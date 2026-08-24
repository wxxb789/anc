# Reading a gate's own result

Seven ways a gate lies about itself, each found here the hard way, each by a different ticket.
They are collected because they were scattered across the ticket reports under `.tmp/` — a
directory `.gitignore` names and which has already been deleted out from under a session once
(TK-27 §9), taking one ticket's report with it for good. A lesson that costs a ticket to learn
should not live somewhere a `rm` can end it.

`AGENTS.md` carries the first five in one line each, because every agent reads it and five lines
is what a contract can afford. Cases 6 and 7 are about a *measurement* and a *claim* rather than
a gate, which is why they live here only. This file carries the measurement behind each, because that is
what makes one recognisable in the next instance rather than merely agreed with.

**The unifying claim: the instrument has to be confirmed to have looked at the thing before
its answer means anything.** Every case below is that sentence with a different subject —
the mutation, the gate, the command, the control, the fixture.

---

## 1. A green mutation may mean you mutated something inert

You break the code, the gate stays green, and you write down that the gate is weak. Sometimes
it is. Sometimes your edit never executed.

**Measured — TK-27 T2, and again as TK-28 M5, in the same file to two different people.**
Adding `code` and `inlineCode` to the node types `collectLinkNodes` pushes came back green.
The loop's own guard at `scripts/resolve-links.ts` (`node.type !== 'link' && node.type !==
'image'`) re-excludes them, so the mutation never reached the rewriter. Nothing was learned
about the gate. The mutation that *does* reach it pushes each `code` node re-typed as a
`link` — red, with the fence consumed and no `<pre>` in the article at all.

Nearly every green mutation in TK-27 named a real unasserted property; one was this. They are
indistinguishable from the verdict alone. You have to check what the edit reached.

## 2. A red mutation may mean you mutated something broader than the property claimed

The gate goes red, so you record it as proven. But a mutation with a wide blast radius turns
red gates red for reasons that have nothing to do with the property in the gate's name.

**Measured — TK-28 M6b and M9.** Making `collectLinkNodes` skip `image` nodes turned a gate
red — via a *build failure*, not via its own assertion: the unresolved `![[alpha]]` survived
into the body and the residue scan rejected it before any assertion ran. Same for rendering
`{entry.markdown}` into a component. Both needed a narrower mutation before the result meant
anything about the gate they were aimed at.

**And TK-27's own version:** a mutation making `unpublished` behave as `resolved` turns four
gates red — but it does not prove the *nested* case works. It proves an unpublished target
stops being withheld anywhere. Right answer, wrong inference.

## 3. Empty output is not green

The most embarrassing one and the cheapest to prevent.

**Measured — TK-27 §10.2.** A test command naming a file that does not exist prints nothing
and exits zero. A run that looked at no test looks exactly like a run where every test passed.

The same shape at the assertion level: **a gate that normalises the value it is checking
asserts nothing about it.** TK-28 §6.1 found `tests/link-traversal.test.ts` comparing
`bySlug.get('index')!.outgoing.sort()` — sorting the actual before comparing — so it could not
see the ordering property `checkCorpus` enforces, over a corpus whose links were already in
slug order so the fixture could not have exposed it either. A producer defect shipped that a
stranger's first real build hit immediately, because nobody writes prose in slug-alphabetical
order. **A gate that erases the property before looking reads as more rigorous than a plain
equality, not less.**

And at the reporting level: TK-28's `gunzip` catch fell back to raw bytes on failure, which
reports clean. "Could not look" must not be spelled like "looked and found nothing" — which is
why `scanResidue` returns a `scannedCount` a caller can refuse a zero from, and why the
report's `status` field distinguishes "nothing to report" from "I stopped before I could look."
**The stronger form is now closed at the definition**: `scan-residue.ts` used to report "the
built site is missing or unreadable" as a *finding*, so a caller counting findings could not
tell an unreadable output from a dirty one. It throws instead. The other "could not look"
cases in that file stay findings, by a rule rather than a list: a file that shipped and could
not be read inside is a finding and names itself; vacuity is the case where there is no
artifact at all. The rule form is not a flourish — the first draft of that comment enumerated
those branches and undercounted them, three sections above the corollary warning against
exactly that.

## 4. A control that reimplements what it is controlling for measures the reimplementation

A positive control exists to prove the instrument can see. If the control has its own private
path to the answer, it proves only that the control works.

**Measured — TK-28 M17.** A control was added to prove a `dist/` scan's `gunzipSync` was
load-bearing. It came back green when the inflate was removed — because the control called
`gunzipSync` *itself* rather than going through the search path under test, so disabling that
path left the control reading its own copy. Both gates now route the control through the same
function the assertions use.

The sibling case, **TK-31 M6/M18**: a scan restricted to a never-matching extension must turn
the control red. If a "this project's name appears nowhere" gate can be blinded without any
control noticing, the zero it reports is the zero of having looked nowhere.

## 5. A fixture you construct encodes what you believe the pipeline emits

Different in kind from the first four. There the instrument could not see; here it sees
perfectly and is pointed at something the product does not build.

**Measured — TK-29, in its list of what its inputs got wrong, and in its §5.2.** Commit
`02b51c0` narrowed the `[[` residue rule to exempt
`<code>`/`<pre>` regions so a note documenting Obsidian syntax could publish, and its comment
states the inline case was measured working. It was measured over **hand-written scratch
HTML**. Through the real pipeline, ``Inline `[[syntax]]` is how you write it.`` exited 1 with
five findings: the body was correctly exempt, but the *excerpt* reached four surfaces as raw
Markdown carrying no `<code>` element at all. `tests/verify.test.ts` asserts that rule over
scratch HTML where an inline `<code>[[inline]]</code>` is trivially exempt, so it was green
throughout — correctly, about a page the pipeline never produces.

**Where a property is about output, build the output.** Every gate written against a foreign
corpus in TK-28 and TK-31 found something no unit test had, and TK-31's opening measurement is
the strongest single case: 126 occurrences of one owner's name in a stranger's build, of which
only nine were in `.html`. A gate reading `dist/**/*.html` would have been blind to
four whole classes of carrier: `robots.txt`, `rss.xml`, `sitemap.xml`, and the JavaScript
bundles holding the storage prefix.


## 6. A broken measurement can break in the direction that reads as good news

A gate that fails is loud. A *measurement* that fails is a number, and a number arrives without
a status. If the failure makes it smaller, and smaller is what you were hoping for, nothing in
the result argues with you.

**Measured — the render-cost report, in its own §"one methodological note".** The first bundle
run reported Mermaid at **406 KB gzip across 62 chunks**, which is a plausible figure that
would have gone straight into a recommendation. It was wrong: rolldown had left `dompurify`,
`d3`, `katex`, `cytoscape` and their transitive dependencies **external**, because pnpm nests
each package's own dependencies under `.pnpm/<name>@<version>/node_modules/` and a bundler
pointed only at the top level does not find them. Resolved properly the same bundle is
**967 KB across 111 chunks** — the first answer was 42% of the real one.

The bundle was smaller *because it was broken*. Nothing in the output said so. It surfaced only
when a browser was asked to run it and refused:
`Failed to resolve module specifier "dompurify"`.

**The second half is subtler and is the part worth carrying.** The obvious repair — hand the
bundler a list of every `.pnpm/*/node_modules` directory — is also wrong, and fails in a way
that at least announces itself. pnpm keeps several copies of a package at different versions,
so a flat list resolves whichever directory comes first rather than the one the importer is
actually linked to. Measured: rolldown reported
`"curveBumpX" is not exported by d3/src/index.js` for a symbol that is plainly exported there,
because the `d3-shape` it had found was not the one `d3` re-exports. `createRequire` from the
*importing file* resolves the same copy the runtime would; nothing else does.

The rule is not about bundlers. **Ask which direction your instrument's failure points.** A
scanner that cannot open a file reports zero findings. A benchmark that skips the slow path
reports a better time. A coverage tool that misses a directory reports higher coverage. Every
one of those is the answer you wanted, and none of them will tell you. Where a measurement can
fail silently, the check is a *positive control on the measurement itself* — for a bundle,
"does it run"; for a scan, a planted needle; for a benchmark, a known-slow input.

## 7. An unverified mechanism survives in the documentation long enough to be quoted back

Case 6 is about a number nobody checked. This is about a *sentence* nobody checked, which is
worse, because a sentence gets copied.

**Measured — the staging-collision report, and the claim was written by this project about
itself.** The test suite was intermittently red, always on a gate that spawned the binary. The
explanation recorded was that `bin/anc.mjs` chdirs to `PACKAGE_ROOT`, so
Astro's `getOutDirWithinCwd` discards the per-run `outDir` and stages every concurrent build at
a shared `<cwd>/.astro/`. It named a real function, quoted its real source, and reasoned
correctly — from a premise about which branch that function takes that nobody had executed.

Executing it takes one call:

```
getOutDirWithinCwd(<cwd>/.anc-build-abc/dist) -> unchanged
getOutDirWithinCwd(<cwd>/dist)                         -> unchanged
getOutDirWithinCwd(C:/elsewhere/dist)                  -> <cwd>/.astro/
```

The fallback fires only for an `outDir` **outside** cwd, and the binary stages *inside*
`PACKAGE_ROOT` after chdir'ing there — so it never fires, and the per-run workspace really was
per-run. Confirmed behaviourally: 24 concurrent binary builds against a live suite, every one
exit 0, no crossover. The real cause was `emptyDir(config.outDir)`
(`astro/dist/core/build/static-build.js:64`) on the single `dist/` that two commands write and
seven test files read.

**What makes this case 7 rather than an ordinary wrong guess is what happened next.** The claim
reached `AGENTS.md`'s known-stale table, two ticket briefs, and a ticket report's own §8 — and
was then quoted back to its author as established fact by the agent who had been told it. Three
tickets tripped over the symptom while the explanation sat in the contract looking settled.
Nothing in the sentence marked it as never-measured, because prose has no field for that.

**So say how you know, in the sentence.** This repository's convention already exists and works:
"measured", "executed", "reproduced" mean somebody ran it, and a claim carrying none of those
words is a hypothesis wearing a statement's clothes. A one-line `node -e` would have settled
this one before it was ever written down. Where that is not affordable, the honest form is the
one `docs/` uses elsewhere — record the *stimulus* ("I ran X and got Y") rather than the
verdict ("X does not happen"), because a stimulus invites correction and a verdict forecloses
it.

---

## The corollary about searching

**Searching for a gate by the constant it guards will not find it** (TK-27 §10.2, which
produced a false conclusion twice in one review, once on each side). A gate that *references*
a constant is usually a restatement of the source; the gate worth having exercises the
behaviour and never names it. Searching `tests/` for `CODE_EXEMPT` finds the first and misses
the second.

## The corollary about enumerations

An enumeration in a comment is true on the day it is written and silently false after a
version bump. TK-29 §2 hit this twice in one file: a rationale resting on `sourceMappingURL`
lacking an `/i` flag that nobody had written down, and a list naming `.pf_index` and `.pf_meta`
as though they were the whole excluded set, which is how `.pf_filter` went unnamed. Both were
replaced with the *rule* the code had always applied. State the rule; a member added by a
future upgrade is then covered by the sentence rather than missing from a list.

## What to do with a green mutation

Not "conclude the gate is weak" and not "conclude the code is inert" — those are the two
guesses. Check which:

1. Did the edit execute? Add a throw where you mutated and confirm the run dies.
2. Did the test command look at anything? Confirm a nonzero count of assertions ran.
3. Does the fixture contain the case? A gate over a corpus lacking the shape is green about
   nothing.
4. Does the control fail when the instrument is blinded? If not, the control is case 4.

A mutation that stays green after all four is the useful result. TK-27 ran dozens and several
came back green; all but one named a real unasserted property and became a gate, and the
remaining one was case 1 — an edit that never executed. Its own report gives three different
mutation totals in three places, which is its own small lesson about counting: the ratio is not
the point, and the four checks above are.
