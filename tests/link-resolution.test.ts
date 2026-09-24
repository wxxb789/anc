/**
 * Link resolution: the five forms, the researched tier order, and the three
 * things that go wrong.
 *
 * **Every expected target below is hardcoded, and the ones marked "oracle" were
 * produced by a separate transcription of Obsidian's shipped
 * `getLinkpathDest` — `.tmp/tk27/obsidian.mjs`, transcribed from
 * `.tmp/ssg-research.md:419-433` — run against the same synthetic corpora.**
 * Sourcing an expected value from the resolver under test compares it against
 * itself, which is the trap `expectedRoutes()` in `tests/built-routes.test.ts`
 * already documents. The oracle is not imported here; its answers were read once
 * and written down, so this file has no dependency on it.
 *
 * Three cases are **deliberate divergences** from that oracle and are marked as
 * such, each with the executed defect it removes:
 *
 * 1. tier 5's suffix test is segment-aware, so `[[ary/index]]` no longer finds
 *    `knowledge/glossary/index.md`;
 * 2. tier 5's proximity test is segment-aware, so a source in `proj/` no longer
 *    prefers `projects/note.md`;
 * 3. a collision is `ambiguous` with every candidate named, where Obsidian
 *    silently returns the first.
 *
 * The corpora carry a same-basename pair in two folders and a case-only pair
 * deliberately. Without them the ambiguity branch is unreachable and this file
 * would be green while the most important outcome went unexecuted — which the
 * research names as the specific coverage illusion this ticket risks.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { indexCorpus, resolveLink, type CorpusFile, type LinkResolution } from '../src/lib/link-resolution.ts';
import { slugSegment } from '../src/lib/route-path.ts';

/**
 * A corpus from paths, publishing every `.md` under a slug derived from its
 * path — which is what `markdown-to-artifact.ts` does, spelled out here so a
 * test's expected slug is readable from its own corpus.
 *
 * A path prefixed with `!` is discovered and *not* published, which is how the
 * `unpublished` outcome is reachable without a second fixture shape.
 */
function corpus(...paths: readonly string[]): readonly CorpusFile[] {
  return paths.map((entry) => {
    const path = entry.startsWith('!') ? entry.slice(1) : entry;
    const published = !entry.startsWith('!') && path.endsWith('.md');
    return {
      path,
      slug: published
        ? path
            .replace(/\.md$/, '')
            .toLowerCase()
            .split('/')
            .map((segment) => slugSegment(segment))
            .filter((segment) => segment !== '')
            .join('-')
        : undefined,
    };
  });
}

/** Resolve one wikilink against a corpus, in one line. */
function wiki(paths: readonly string[], link: string, source: string): LinkResolution {
  return resolveLink(link, source, indexCorpus(corpus(...paths)), true);
}

/** Resolve one Markdown href against a corpus, in one line. */
function md(paths: readonly string[], href: string, source: string): LinkResolution {
  return resolveLink(href, source, indexCorpus(corpus(...paths)), false);
}

/** The path a resolution names, or a description of why it names none. */
function target(resolution: LinkResolution): string {
  return 'path' in resolution ? resolution.path : resolution.kind;
}

test('a CJK-named note resolves by wikilink and by encoded Markdown href, to its Unicode slug', () => {
  const files = ['日记/今天.md', 'Projects/观点.md'];
  for (const resolution of [
    wiki(files, '今天', 'Projects/观点.md'),
    wiki(files, '日记/今天', 'Projects/观点.md'),
    md(files, '../日记/今天.md', 'Projects/观点.md'),
    md(files, `../${encodeURI('日记/今天.md')}`, 'Projects/观点.md'),
  ]) {
    assert.equal(resolution.kind, 'resolved');
    assert.equal('slug' in resolution ? resolution.slug : undefined, '日记-今天');
  }
  // A composed link against a decomposed filename resolves to the NFC slug.
  const decomposed = ['Café.md'.normalize('NFD')];
  const resolved = wiki(decomposed, 'café'.normalize('NFC'), 'x.md');
  assert.equal('slug' in resolved ? resolved.slug : undefined, 'café');
});

test('form 1 — an Obsidian shortest-path wikilink resolves to the one file carrying that name', () => {
  // Tier 0 → 1. The dominant form, and the only tier requiring uniqueness.
  assert.equal(target(wiki(['guides/git.md', 'other.md'], 'git', 'other.md')), 'guides/git.md');

  // Tier 0's whole contract, and the reason `[[Figure 1]]` is not a bug report:
  // a non-Markdown target must carry its extension, so the bare form finds
  // nothing while the spelled form finds the image. Oracle: `null`, then
  // `Figure 1.png`.
  assert.equal(wiki(['Figure 1.png', 'a.md'], 'Figure 1', 'a.md').kind, 'unresolved');
  assert.equal(target(wiki(['Figure 1.png', 'a.md'], 'Figure 1.png', 'a.md')), 'Figure 1.png');

  // The two-probe order, which is what makes a dot in a Markdown basename work.
  // Oracle: `Note.1.md`.
  assert.equal(target(wiki(['Note.1.md', 'a.md'], 'Note.1', 'a.md')), 'Note.1.md');

  // The first probe fires **only** when the basename carries a dot, and an
  // extensionless file is where that matters. Oracle: `[[LICENSE]]` against a
  // real `LICENSE` is `null`, because the dotless linkpath skips the as-written
  // probe and `LICENSE.md` does not exist. Without the guard this finds the
  // file, and a link to a note nobody wrote is silently reported as a link to
  // an unpublishable one — the two outcomes this resolver most needs to keep
  // apart. Added after a mutation removing the guard stayed green.
  assert.equal(
    wiki(['LICENSE', 'a.md'], 'LICENSE', 'a.md').kind,
    'unresolved',
    'an extensionless file answered a dotless linkpath, so the first probe is unguarded',
  );
  // …and the same guard's positive half: a dotted linkpath probes as written
  // first, so an extensionless `Node.js` beats `Node.js.md`. Oracle: `Node.js`.
  assert.equal(target(wiki(['Node.js', 'Node.js.md', 'a.md'], 'Node.js', 'a.md')), 'Node.js');

  // Resolution is case-insensitive where discovery is byte-exact. Oracle:
  // `Projects/Three Laws.md` for `[[projects/THREE laws]]`.
  assert.equal(
    target(wiki(['Projects/Three Laws.md', 'a.md'], 'projects/THREE laws', 'a.md')),
    'Projects/Three Laws.md',
  );
});

test('form 2 — a vault-root wikilink beats a nested namesake, and the /-anchored spelling is strict', () => {
  // Tier 3, and this is why a root-level file is not shadowed: tier 1 is skipped
  // by the collision, and the bare name happens to *be* a root path. Oracle:
  // `items.md`.
  assert.equal(target(wiki(['items.md', 'archive/items.md'], 'items', 'x.md')), 'items.md');

  // Tier 3 from anywhere, over a longer path that also ends in the link.
  // Oracle: `Projects/Three laws.md`.
  assert.equal(
    target(
      wiki(
        ['Projects/Three laws.md', 'Other/Projects/Three laws.md', 'Other/z.md'],
        'Projects/Three laws',
        'Other/z.md',
      ),
    ),
    'Projects/Three laws.md',
  );

  // Tier 4. The slash is stripped before tier 3 — so the anchored spelling
  // resolves — and when tier 3 misses it declines the fuzzy fallback rather than
  // guessing. Widely-copied third-party notes claim the first of these never
  // resolves; the research executed it and they are wrong. Oracle: `foo/bar.md`,
  // then `null`.
  assert.equal(target(wiki(['foo/bar.md', 'a.md'], '/foo/bar', 'a.md')), 'foo/bar.md');
  assert.equal(wiki(['x/foo/bar.md', 'a.md'], '/foo/bar', 'a.md').kind, 'unresolved');
});

test('form 3 — a relative wikilink resolves against the writing file, including the prefix-less spelling', () => {
  // Tier 2, both spellings. Oracle: `a/sib.md`, `top.md`.
  assert.equal(target(wiki(['a/sib.md', 'a/x.md'], './sib', 'a/x.md')), 'a/sib.md');
  assert.equal(target(wiki(['top.md', 'a/x.md'], '../top', 'a/x.md')), 'top.md');

  // Tier 5's same-folder bucket, and the reason tier 5 cannot be deleted:
  // Obsidian's own `relative` link format emits `[[b/note]]` with no `./`
  // prefix when the target is below the source's folder, and nothing but tier 5
  // resolves it. Oracle: `a/b/note.md`.
  assert.equal(target(wiki(['a/b/note.md', 'a/x.md'], 'b/note', 'a/x.md')), 'a/b/note.md');

  // Tier 2 falls *through* on failure rather than returning, carrying its
  // rewritten path into tier 5. Without the fall-through this is `unresolved`.
  assert.equal(
    target(wiki(['deep/a/sib.md', 'a/x.md'], './sib', 'a/x.md')),
    'deep/a/sib.md',
  );
});

test('form 4 — a standard Markdown link reaches the same tiers, after decodeURI', () => {
  // The internal/external test, then the same resolver. Not a second one.
  assert.equal(target(md(['y.md', 'a/x.md'], '../y.md', 'a/x.md')), 'y.md');
  assert.equal(target(md(['guides/git.md', 'a.md'], 'guides/git.md', 'a.md')), 'guides/git.md');

  // `decodeURI`, which decodes `%20`. A link written by any editor that
  // percent-encodes spaces resolves to the file with a space in its name.
  assert.equal(
    target(md(['Projects/Three laws.md', 'a.md'], '/Projects/Three%20laws', 'a.md')),
    'Projects/Three laws.md',
  );

  // `decodeURI` and not `decodeURIComponent`, which is the load-bearing half:
  // `%23` stays encoded, so a filename carrying a literal `#` is still
  // distinguishable from the subpath separator. Under `decodeURIComponent` this
  // would split at the decoded `#` and look for a file called `C`.
  assert.equal(target(md(['C%23 notes.md', 'a.md'], 'C%23 notes.md', 'a.md')), 'C%23 notes.md');

  // External, and untouched. Every one of these carries a colon or is a bare
  // fragment, which is Obsidian's own test.
  for (const href of ['https://example.com/x', 'mailto:a@b.c', 'http://e.com', '#local']) {
    assert.equal(md(['a.md'], href, 'a.md').kind, 'external', `${href} was not treated as external`);
  }

  // …and `./a:b` is internal despite the colon, because the explicit relative
  // prefix is tested first.
  assert.equal(md(['a:b.md', 'x.md'], './a:b.md', 'x.md').kind, 'resolved');
});

test('form 5 — display text does not change what a wikilink names', () => {
  // The target half is what reaches the resolver; the display half is the
  // traversal's business and is gated in `tests/link-traversal.test.ts`, over
  // the source text where the two halves are still distinguishable. Asserting
  // it *here* is not possible and was tried: the parser splits at the `|` before
  // this function is called, so `[[a|b]]` and `[[a]]` arrive as the same string,
  // and comparing two calls with that string compares a value to itself.
  assert.equal(target(wiki(['guides/git.md', 'a.md'], 'git', 'a.md')), 'guides/git.md');

  // A subpath survives the split and becomes this site's own anchor, minted by
  // the same slugger the renderer uses so the two cannot disagree about an id.
  const withHeading = wiki(['note.md', 'a.md'], 'note#Some Heading', 'a.md');
  assert.equal(target(withHeading), 'note.md');
  assert.equal('anchor' in withHeading ? withHeading.anchor : undefined, '#some-heading');

  // The split is at the *first* `#`, so a nested reference points at the
  // deepest heading rather than at a file whose name contains a hash.
  const nested = wiki(['note.md', 'a.md'], 'note#Outer#Inner', 'a.md');
  assert.equal(target(nested), 'note.md');
  assert.equal('anchor' in nested ? nested.anchor : undefined, '#inner');

  // A block reference gets no anchor: this site emits no block anchors, so a
  // minted id would point at nothing. The page still resolves.
  const block = wiki(['note.md', 'a.md'], 'note#^abc123', 'a.md');
  assert.equal(target(block), 'note.md');
  assert.equal('anchor' in block ? block.anchor : undefined, '');
});

test('an ambiguous link resolves and names every candidate, sorted', () => {
  // **Divergence from the oracle, and the whole of decision D1.** Obsidian
  // returns `a/note.md` here and discards the fact that there were two. The
  // link still renders — failing was rejected as unbounded and unoverridable —
  // but every candidate is recorded, because a resolution that cannot say it
  // was a guess is the Quartz defect this resolver exists to beat.
  const collision = wiki(['a/note.md', 'b/note.md', 'src/x.md'], 'note', 'src/x.md');
  assert.equal(collision.kind, 'ambiguous');
  assert.ok('candidates' in collision);
  assert.deepEqual(collision.candidates, ['a/note.md', 'b/note.md']);
  // The winner matches the oracle: same tier order, made total at the tiebreak.
  assert.equal(target(collision), 'a/note.md');

  // A case-only pair is the same class. On a case-insensitive filesystem it
  // cannot exist, so the check is free; on a case-sensitive one it is the
  // hazard where Obsidian returns whichever the scan saw first. Oracle:
  // `Note.md`, by insertion order — which is exactly what is not reproducible.
  const caseOnly = wiki(['Note.md', 'note.md', 'a.md'], 'Note', 'a.md');
  assert.equal(caseOnly.kind, 'ambiguous');
  assert.ok('candidates' in caseOnly);
  assert.deepEqual(caseOnly.candidates, ['Note.md', 'note.md']);

  // Sorted, and by the path rather than by the tier order, so a report reads
  // the same however the walk found them. Asserted on contents rather than on
  // length: two wrong candidates of the same cardinality is the failure this
  // catches.
  const three = wiki(['z/note.md', 'a/note.md', 'm/note.md', 'src/x.md'], 'note', 'src/x.md');
  assert.ok('candidates' in three);
  assert.deepEqual(three.candidates, ['a/note.md', 'm/note.md', 'z/note.md']);

  // The winner is deterministic under a permuted corpus, which is the property
  // Obsidian's insertion-order tiebreak does not have. Same three files, six
  // orders, one answer.
  const permutations = [
    ['aa/note.md', 'bb/note.md', 'cc/note.md'],
    ['cc/note.md', 'bb/note.md', 'aa/note.md'],
    ['bb/note.md', 'cc/note.md', 'aa/note.md'],
  ];
  for (const order of permutations) {
    const resolved = wiki([...order, 'src/x.md'], 'note', 'src/x.md');
    assert.equal(target(resolved), 'aa/note.md', `corpus order ${order.join(',')} changed the winner`);
  }
});

test('an unresolved link and an unpublished one are different outcomes', () => {
  // Resolution runs over the full file set and publication is tested
  // afterwards. Merging these two would report a link to an excluded note as a
  // broken link — the mistyped-exclusion hazard seen from the other side, and
  // the most useful line the report carries.
  const missing = wiki(['a.md'], 'nothing-here', 'a.md');
  assert.equal(missing.kind, 'unresolved');

  const excluded = wiki(['!drafts/secret.md', 'a.md'], 'secret', 'a.md');
  assert.equal(excluded.kind, 'unpublished');
  assert.equal(target(excluded), 'drafts/secret.md');

  // An image is the same outcome by the same rule, without an asset pipeline
  // needing to exist to say so.
  const image = wiki(['diagram.png', 'a.md'], 'diagram.png', 'a.md');
  assert.equal(image.kind, 'unpublished');
  assert.equal(target(image), 'diagram.png');
});

test('tier 5 is segment-aware, which Obsidian is not', () => {
  // **Divergence 1.** Executed against the shipped resolver,
  // `[[ary/index]]` resolves to `knowledge/glossary/index.md`, because the test
  // is a raw-string `endsWith` and `'…glossary/index.md'.endsWith('ary/index.md')`
  // is true. Nobody writes `ary/index` meaning that file.
  assert.equal(
    wiki(['knowledge/glossary/index.md', 'a.md'], 'ary/index', 'a.md').kind,
    'unresolved',
    'a mid-segment suffix resolved, so tier 5 is matching raw strings',
  );
  // The segment-aligned spelling of the same link still resolves, so the
  // hardening removed the defect rather than the tier. Oracle agrees here.
  assert.equal(
    target(wiki(['knowledge/glossary/index.md', 'a.md'], 'glossary/index', 'a.md')),
    'knowledge/glossary/index.md',
  );

  // **Divergence 2.** Executed, a source in `proj/` prefers `projects/note.md`
  // over `zzz/note.md`, because `'projects/note.md'.startsWith('proj')` is true.
  // Segment-aware, neither is near, so both survive and this is ambiguity —
  // which is the honest answer for two files nothing distinguishes.
  const bucket = wiki(['projects/note.md', 'zzz/note.md', 'proj/x.md'], 'note', 'proj/x.md');
  assert.equal(bucket.kind, 'ambiguous');
  assert.ok('candidates' in bucket);
  assert.deepEqual(bucket.candidates, ['projects/note.md', 'zzz/note.md']);

  // The genuine proximity case still fires, and it beats a shorter path — which
  // is the ordering Obsidian has and a naive "shortest wins" does not. Oracle:
  // `a/deeply/note.md` over `q/note.md` for a source in `a/`.
  assert.equal(
    target(wiki(['a/deeply/note.md', 'q/note.md', 'a/x.md'], 'note', 'a/x.md')),
    'a/deeply/note.md',
  );
});

test('a link is resolved against the file that wrote it', () => {
  // The same link, the same corpus, two sources, two answers. This is what a
  // resolver ignoring `sourcePath` cannot do, and a gate that only ever resolves
  // from the corpus root would not notice it was ignored — the root case has
  // `dirname === ''`, under which every candidate is "near" and the bucket split
  // is inert. Oracle: `handbook/items.md` from `handbook/a.md`.
  const paths = ['handbook/items.md', 'archive/items.md', 'handbook/a.md', 'archive/b.md'];
  assert.equal(target(wiki(paths, 'items', 'handbook/a.md')), 'handbook/items.md');
  assert.equal(target(wiki(paths, 'items', 'archive/b.md')), 'archive/items.md');
});

test('NFC normalisation is applied to both sides, which Obsidian does to one', () => {
  // Obsidian normalises the link text and not the filename, so an NFC link
  // against an NFD filename resolves to nothing — and macOS filesystems hand
  // back decomposed forms. A build whose answer depends on which machine
  // checked out the repository is not a build.
  const nfc = 'café.md'; // café, precomposed
  const nfd = 'café.md'; // café, decomposed
  assert.notEqual(nfc, nfd, 'the two spellings are the same string, so this gate proves nothing');

  assert.equal(target(wiki([nfd, 'a.md'], 'café', 'a.md')), nfd, 'an NFC link missed an NFD filename');
  assert.equal(target(wiki([nfc, 'a.md'], 'café', 'a.md')), nfc, 'an NFD link missed an NFC filename');
});

test('every outcome is a member of the closed set, and every member is reachable', () => {
  // The type is TK-28's contract, so a member appearing that nothing declared
  // is a break in a consumer rather than in this file.
  //
  // **Both directions, and the second is the one that was missing.** A gate
  // asserting only that each observed kind is known passes trivially on inputs
  // that stopped reaching a branch — so an edit that made `ambiguous`
  // unreachable would leave it green while the most important outcome went
  // unexecuted. Comparing the observed *set* to the declared one is the
  // "assert on content, not cardinality" rule applied to coverage.
  const known = new Set(['external', 'resolved', 'ambiguous', 'unpublished', 'unresolved']);
  const inputs: readonly (readonly [string, string, readonly string[]])[] = [
    ['https://e.com', 'a.md', ['a.md']],
    ['#top', 'a.md', ['a.md']],
    ['b', 'a.md', ['a.md', 'b.md']],
    ['note', 'a.md', ['a.md', 'x/note.md', 'y/note.md']],
    ['img.png', 'a.md', ['a.md', 'img.png']],
    ['gone', 'a.md', ['a.md']],
    ['', 'a.md', ['a.md']],
    ['   ', 'a.md', ['a.md']],
    ['/', 'a.md', ['a.md']],
    ['../../../escape', 'a/b.md', ['a.md']],
  ];

  const observed = new Set<string>();
  for (const [link, source, paths] of inputs) {
    for (const isWikilink of [true, false]) {
      const outcome = resolveLink(link, source, indexCorpus(corpus(...paths)), isWikilink);
      assert.ok(known.has(outcome.kind), `${link} produced the outcome "${outcome.kind}"`);
      observed.add(outcome.kind);
    }
  }
  assert.deepEqual([...observed].sort(), [...known].sort(), 'a declared outcome was never reached');
});
