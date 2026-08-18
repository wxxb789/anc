/**
 * The traversal: one walk producing both the rewritten body and the edge set.
 *
 * These gates hold the properties `tests/link-resolution.test.ts` cannot, because
 * they are about the *walk* rather than about the resolver — what reaches
 * `outgoing`, what the body says afterwards, and what a note documenting link
 * syntax does to both.
 *
 * The structural claim is that `outgoing` and the rewritten hrefs come from one
 * resolution per node, so they cannot disagree. That is not gated by comparing
 * the two — a comparison test would pass on two passes that happened to agree
 * today — but it *is* gated: the mutations recorded in `.tmp/tk-27-report.md`
 * include severing the edge from the rewrite, and the gates below go red on it
 * because each names the pair a single link must produce.
 *
 * The corpus in `traverse()` is deliberately hostile in three ways the plan
 * names: a note documenting wikilink syntax inside a fence, a same-basename
 * pair, and a link to a discovered-but-unpublished file. Without them the
 * interesting branches are unreachable and this file would be green while
 * nothing it claims was executed.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { indexCorpus, type CorpusFile } from '../src/lib/link-resolution.ts';
import { WITHHELD_LINK_TEXT, WITHHELD_ROUTE } from '../src/lib/route-path.ts';
import { resolveLinksIn } from '../scripts/resolve-links.ts';
import { discover, resolveCorpusLinks, writeArtifact } from '../scripts/markdown-to-artifact.ts';
import { openReport } from '../scripts/write-report.ts';
import { renderMarkdown } from '../src/lib/markdown.ts';

/** A scratch directory removed when the callback returns, however it returns. */
async function scratch<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The synchronous form, for the report gates, which do no I/O of their own. */
function scratch2<T>(prefix: string, body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Write a file, creating the directories above it. */
function put(root: string, relativePath: string, body: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

/** The corpus every gate below resolves against, unless it builds its own. */
const CORPUS: readonly CorpusFile[] = [
  { path: 'index.md', slug: 'index' },
  { path: 'notes/alpha.md', slug: 'notes-alpha' },
  { path: 'notes/beta.md', slug: 'notes-beta' },
  { path: 'guides/alpha.md', slug: 'guides-alpha' },
  { path: 'drafts/secret.md', slug: undefined },
  { path: 'assets/diagram.png', slug: undefined },
];

/** Resolve one body written at one path, against {@link CORPUS}. */
function traverse(markdown: string, source = 'index.md', slug = 'index') {
  return resolveLinksIn(markdown, source, indexCorpus(CORPUS), slug, (target) => `/${target}/`);
}

test('a standard Markdown link contributes an edge, which it did not before', () => {
  // The defect this ticket removes, stated as the plan states it:
  // `{markdown: 'See [B](/b/).', outgoing: []}` was a valid entry — a live
  // anchor with no backlink on B, and no gate anywhere that could see it.
  const result = traverse('See [beta](notes/beta.md) for more.');
  assert.deepEqual(result.outgoing, ['notes-beta']);
  assert.equal(result.markdown, 'See [beta](/notes-beta/) for more.');
});

test('one traversal produces the edge and the href, for every form at once', () => {
  // Five forms in one body, and the assertion is the *pair*: each form's href
  // and its edge. A rewrite without an edge, or an edge without a rewrite,
  // fails here — which is what makes this a gate on the single resolution
  // rather than on either half.
  const body = [
    '# Mixed',
    '',
    'Shortest [[alpha]] here.', // ambiguous: notes/ and guides/ both hold one
    'Root [[notes/beta]] here.',
    'Relative [[../index]] here.',
    'Markdown [text](../notes/beta.md) here.',
    'Labelled [[notes/beta|shown]] here.',
  ].join('\n');

  const result = traverse(body, 'notes/alpha.md', 'notes-alpha');

  // Every edge, by content and not by count: two wrong edges of the same
  // cardinality is exactly the failure a length check passes. `[[alpha]]` from
  // `notes/alpha.md` resolves to that same file — the oracle agrees, and tier
  // 5's near bucket is why — so it renders and contributes no edge, because
  // `checkCorpus` rejects an entry listing itself.
  assert.deepEqual([...result.outgoing].sort(), ['index', 'notes-beta']);

  // Every href, in the body. `[[alpha]]` is ambiguous — `notes/alpha.md` and
  // `guides/alpha.md` share a basename — and it still renders, which is
  // decision D1.
  assert.match(result.markdown, /Shortest \[alpha\]\(\/notes-alpha\/\) here\./);
  assert.match(result.markdown, /Root \[notes\/beta\]\(\/notes-beta\/\) here\./);
  assert.match(result.markdown, /Relative \[\.\.\/index\]\(\/index\/\) here\./);
  assert.match(result.markdown, /Markdown \[text\]\(\/notes-beta\/\) here\./);
  assert.match(result.markdown, /Labelled \[shown\]\(\/notes-beta\/\) here\./);

  // Nothing else moved. The heading and the prose are byte-identical, which is
  // what span editing buys over re-serializing the tree.
  assert.match(result.markdown, /^# Mixed\n\n/);
  assert.ok(!result.markdown.includes('[['), 'a wikilink survived the traversal');
});

test('a link inside a code fence is neither rewritten nor an edge', () => {
  // `export.py` ran a regex over raw Markdown, so a note *documenting* wikilink
  // syntax had its own examples rewritten and a phantom edge injected into
  // `outgoing` — which `checkCorpus` then proved symmetric and passed. Asserted
  // on the edge list's contents, because a cardinality check passes that defect:
  // the phantom edge and the real one are both one edge.
  const body = [
    'Real [[notes/beta]] link.',
    '',
    'Inline `[[notes/alpha]]` and:',
    '',
    '```text',
    '[[notes/alpha]]',
    '[link](notes/alpha.md)',
    '```',
  ].join('\n');

  const result = traverse(body);
  assert.deepEqual(result.outgoing, ['notes-beta']);
  // The fence's own bytes survive, brackets and all.
  assert.ok(result.markdown.includes('```text\n[[notes/alpha]]\n[link](notes/alpha.md)\n```'));
  assert.ok(result.markdown.includes('`[[notes/alpha]]`'), 'inline code was rewritten');

  // **Non-vacuity, and the mutation that demanded it.** Both assertions above
  // are satisfied by a walk that visits `code` and `inlineCode` too and simply
  // fails to resolve their contents — measured: adding those node types to the
  // walk left this file green, because a fence's *value* is not a url and every
  // finding it produced went unexamined. So the gate also says the fence
  // produced no finding at all: a walk that looked inside one would report the
  // example links as unresolved, which is a report full of a note's own prose.
  assert.deepEqual(
    result.findings,
    [],
    'the fence produced a finding, so the walk looked inside a code node',
  );
});

test('a percent sign in a wikilink is not decoded, and one in an href is', () => {
  // The two syntaxes differ in exactly one place, and this is it. A wikilink is
  // not percent-encoded, so decoding one corrupts what the author typed:
  // `[[100% done]]` would become `[[100 done]]` under a naive decode, or throw
  // on a malformed sequence. A Markdown href *is* encoded, so `%20` must decode
  // or a filename with a space never resolves.
  //
  // Both directions are asserted, because a mutation making every node a
  // wikilink and a mutation making none one each break only one of them.
  const corpus: readonly CorpusFile[] = [
    { path: 'src.md', slug: 'src' },
    { path: '100% done.md', slug: 'done' },
    { path: 'two words.md', slug: 'two-words' },
  ];
  const run = (body: string) =>
    resolveLinksIn(body, 'src.md', indexCorpus(corpus), 'src', (slug) => `/${slug}/`);

  // The wikilink is used verbatim: `100% done` is a real filename.
  assert.equal(run('See [[100% done]].').markdown, 'See [100% done](/done/).');
  // The href is decoded: `%20` is a space.
  assert.equal(run('See [x](two%20words.md).').markdown, 'See [x](/two-words/).');
  // And a wikilink carrying what looks like an escape is *not* decoded — under
  // a decode this resolves to `two words.md` and silently links somewhere the
  // author did not name.
  assert.equal(run('See [[two%20words]].').findings[0]?.outcome, 'unresolved');
});

test('an unresolved link degrades to its display text and is reported', () => {
  // Not silently dropped and not left as a live-looking dead anchor. The
  // finding carries the text and the position, never a count — "zero because
  // there were none" and "zero because I never looked" are the same number.
  const result = traverse('# T\n\nSee [[nothing-here]] and [the label](gone.md).');

  assert.deepEqual(result.outgoing, []);
  assert.match(result.markdown, /See nothing-here and the label\./);

  assert.deepEqual(
    result.findings.map((finding) => [finding.outcome, finding.link, finding.line]),
    [
      ['unresolved', '[[nothing-here]]', 3],
      ['unresolved', '[the label](gone.md)', 3],
    ],
  );
  // No candidates key at all, rather than an empty array: an empty list reads
  // as "looked and found none", and there was nothing to look at.
  assert.ok(result.findings.every((finding) => finding.candidates === undefined));
});

test('a link to an excluded note is a publication-boundary event, not a broken link', () => {
  // The most useful line in the report: the user excluded a note that something
  // links to. It is the mistyped-exclusion hazard seen from the other side, and
  // merging it with `unresolved` would hide it.
  const result = traverse('See [[secret]] and ![[diagram.png]].');

  assert.deepEqual(result.outgoing, []);
  assert.deepEqual(
    result.findings.map((finding) => [finding.outcome, finding.candidates]),
    [
      ['unpublished', ['drafts/secret.md']],
      ['unpublished', ['assets/diagram.png']],
    ],
  );

  // **The excluded note's path enters the body, and the link is live.** Owner
  // decision 2026-08-17, reversing the rule this gate's last three assertions
  // used to hold — they read `!markdown.includes('drafts/')`,
  // `!markdown.includes('secret.md')`, and `equal(markdown, 'See secret and
  // diagram.png.')`. The finding half above is untouched: the *report* was
  // never the surface that decision was about.
  assert.equal(result.markdown, 'See [secret](/private/) and [diagram.png](/private/).');
});

test('an ambiguous link renders, and the finding names every candidate and the winner', () => {
  const result = traverse('See [[alpha]].', 'index.md', 'index');

  // It renders — ambiguity warns, it does not fail. The winner matches the
  // oracle: from a corpus-root source every candidate is "near", so tier 5
  // ranks by path length and `notes/alpha.md` is shorter than `guides/alpha.md`.
  assert.deepEqual(result.outgoing, ['notes-alpha']);
  assert.equal(result.markdown, 'See [alpha](/notes-alpha/).');

  assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  assert.equal(finding.outcome, 'ambiguous');
  assert.equal(finding.link, '[[alpha]]');
  assert.equal(finding.source, 'index.md');
  assert.deepEqual(finding.candidates, ['guides/alpha.md', 'notes/alpha.md']);
  // Which one it picked, so the author can see whether the guess was theirs.
  assert.equal(finding.resolvedTo, 'notes/alpha.md');
});

test('a resolved link produces no finding, so the report is readable', () => {
  const result = traverse('See [[notes/beta]] and [x](https://example.com/) and [y](#local).');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.outgoing, ['notes-beta']);
  // External links and bare fragments are untouched, byte for byte.
  assert.ok(result.markdown.includes('[x](https://example.com/)'));
  assert.ok(result.markdown.includes('[y](#local)'));
});

test('a note linking to its own heading renders the link and contributes no edge', () => {
  // `checkCorpus` rejects an entry listing itself in `outgoing`, and a note
  // linking to its own section is an ordinary thing to write. The link is real,
  // so it renders; it is simply not an edge.
  const result = traverse('See [[index#Some Section]].', 'index.md', 'index');
  assert.deepEqual(result.outgoing, []);
  assert.equal(result.markdown, 'See [index#Some Section](/index/#some-section).');
});

test('an undisplayed wikilink keeps the text its author typed', () => {
  // Obsidian derives a display string for a subpath link by splitting on `#`
  // and joining with ` > `, so `[[note#head]]` shows as `note > head`. That is
  // deliberately **not** reproduced: it is a rendering convention rather than a
  // resolution rule, it invents punctuation the author did not write, and a
  // note whose link text is not what its author typed is a diff nobody made.
  // The `|` form exists for authors who want different text, and it is honoured
  // exactly.
  assert.equal(
    traverse('See [[notes/beta#Deep Heading]].').markdown,
    'See [notes/beta#Deep Heading](/notes-beta/#deep-heading).',
  );
  assert.equal(
    traverse('See [[notes/beta#Deep Heading|the deep bit]].').markdown,
    'See [the deep bit](/notes-beta/#deep-heading).',
  );
});

test('a subpath becomes this site own anchor, on the target route', () => {
  const result = traverse('See [[notes/beta#Deep Heading]].');
  assert.match(result.markdown, /\(\/notes-beta\/#deep-heading\)/);
  assert.deepEqual(result.outgoing, ['notes-beta']);
});

test('inline markup inside a degraded label survives', () => {
  // The label is taken from the node's own child span rather than reconstructed
  // from its text, so `**bold**` degrades to `**bold**` and not to `bold`.
  const result = traverse('Try [**bold** and `code`](gone.md).');
  assert.equal(result.markdown, 'Try **bold** and `code`.');
});

test('the same target linked twice is one edge, and both links are rewritten', () => {
  const result = traverse('One [[notes/beta]] two [again](notes/beta.md) three [[notes/beta|x]].');
  assert.deepEqual(result.outgoing, ['notes-beta']);
  assert.equal(
    result.markdown,
    'One [notes/beta](/notes-beta/) two [again](/notes-beta/) three [x](/notes-beta/).',
  );
});

test('an embed of a note becomes a link rather than an image, and says so', () => {
  // Obsidian transcludes `![[note]]`; nothing here does, and an `<img src>`
  // pointing at an HTML page is the one outcome that is certainly wrong. The
  // demotion is reported rather than left for the author to discover as a
  // missing image.
  const result = traverse('Embedded ![[notes/beta]] here.');
  assert.equal(result.markdown, 'Embedded [notes/beta](/notes-beta/) here.');
  assert.deepEqual(result.outgoing, ['notes-beta']);
  assert.deepEqual(
    result.findings.map((finding) => finding.outcome),
    ['embed-not-transcluded'],
  );
});

test('a CJK body keeps its bytes, and its links still resolve', () => {
  // Node positions are UTF-16 offsets into the exact string handed to the
  // parser, so a body whose links sit after multi-byte text is where an
  // offset-arithmetic mistake shows up as text sliced mid-character.
  const result = traverse('中文段落，参见 [[notes/beta]]，以及 [标签](notes/alpha.md)。结束。');
  assert.equal(
    result.markdown,
    '中文段落，参见 [notes/beta](/notes-beta/)，以及 [标签](/notes-alpha/)。结束。',
  );
  assert.deepEqual([...result.outgoing].sort(), ['notes-alpha', 'notes-beta']);
});

test('every finding carries a line a reader can open the file at', () => {
  const body = ['# T', '', 'first [[gone-one]]', '', 'and', '', 'later [[gone-two]]'].join('\n');
  const result = traverse(body);
  assert.deepEqual(
    result.findings.map((finding) => [finding.link, finding.line]),
    [
      ['[[gone-one]]', 3],
      ['[[gone-two]]', 7],
    ],
  );
});

test('a repository resolves end to end, and the artifact it produces validates', async () => {
  // The producer's two steps over a real directory, because everything above
  // this point tests one note at a time and the interesting failures are
  // corpus-shaped: a link resolving against the full file set, the edge set
  // and its inverse, and an artifact the contract accepts.
  await scratch('tk27-corpus-', async (root) => {
    // Document order is deliberately the reverse of slug order — `notes-beta`
    // is written first and sorts second. A corpus whose two orders agree cannot
    // tell a sorted `outgoing` from an unsorted one, which is half of why the
    // sort defect survived: the assertion normalised, and the fixture could not
    // have exposed it even if it had not.
    put(root, 'index.md', '# Index\n\nSee [beta](notes/beta.md) and [[notes/alpha]].\n');
    put(root, 'notes/alpha.md', '# Alpha\n\nBack to [[index]] and out to [[nowhere]].\n');
    put(root, 'notes/beta.md', '# Beta\n\nA [[../index]] relative link.\n');
    put(root, 'drafts/held.md', '---\npublish: false\n---\n\n# Held\n\nprose\n');
    put(root, 'assets/logo.png', 'not really a png\n');
    // A link *to* the excluded note and *to* the asset, which is what makes the
    // `unpublished` outcome reachable over a real directory. Without these the
    // corpus resolves against the published set and the full set identically,
    // and the distinction the resolver exists to draw goes unexecuted —
    // measured: narrowing resolution to the published entries left this file
    // green until these two links existed.
    put(root, 'links.md', '# Links\n\nTo [[held]] and to [[logo.png]] and to [[missing]].\n');

    const discovery = await discover(root);
    const findings = await resolveCorpusLinks(discovery);

    const bySlug = new Map(discovery.entries.map((entry) => [entry.slug, entry]));
    assert.deepEqual([...bySlug.keys()].sort(), ['index', 'links', 'notes-alpha', 'notes-beta']);

    // Edges from every form, by content. `[[nowhere]]` contributes none.
    //
    // Compared **without** sorting the actual, which is the whole point of the
    // assertion. This line used to read `.outgoing.sort()`, and that normalised
    // away the property `checkCorpus` enforces: the traversal emits document
    // order, `checkCorpus` requires ascending order, and a gate that sorts the
    // value before comparing it cannot see the difference. This corpus happened
    // to be in slug order too, so both halves of the vacuity were present at
    // once — the gate normalised what it was checking, over a fixture that could
    // not have exposed it either way.
    //
    // Measured on the shipped binary before the fix: `See [[zebra]] and
    // [[apple]].` exited 1 with `outgoing: must be sorted in ascending order`,
    // while the same corpus with the links swapped exited 0. Nobody writes prose
    // in slug-alphabetical order, so this was a first build a stranger could not
    // get past. `scripts/markdown-to-artifact.ts` sorts, and this asserts it.
    assert.deepEqual(bySlug.get('index')!.outgoing, ['notes-alpha', 'notes-beta']);
    assert.deepEqual(bySlug.get('notes-alpha')!.outgoing, ['index']);
    assert.deepEqual(bySlug.get('notes-beta')!.outgoing, ['index']);
    assert.deepEqual(bySlug.get('links')!.outgoing, []);

    // Backlinks are the exact inverse, which is what `checkCorpus` demands and
    // what makes the artifact below validate rather than throw.
    assert.deepEqual(bySlug.get('index')!.backlinks, ['notes-alpha', 'notes-beta']);
    assert.deepEqual(bySlug.get('notes-alpha')!.backlinks, ['index']);

    // Every finding, with its source and its line — and specifically the two
    // outcomes that are only distinguishable because resolution ran over the
    // *full* file set. A link to an excluded note is a publication-boundary
    // event and names the file; a link to nothing is a broken link and names
    // no candidate. Resolving against the published entries alone reports both
    // as `unresolved`, which is the distinction being asserted here.
    assert.deepEqual(
      findings.map((finding) => [finding.source, finding.line, finding.link, finding.outcome]),
      [
        ['links.md', 3, '[[held]]', 'unpublished'],
        ['links.md', 3, '[[logo.png]]', 'unpublished'],
        ['links.md', 3, '[[missing]]', 'unresolved'],
        ['notes/alpha.md', 3, '[[nowhere]]', 'unresolved'],
      ],
    );
    assert.deepEqual(
      findings.map((finding) => finding.candidates),
      [['drafts/held.md'], ['assets/logo.png'], undefined, undefined],
    );

    // And the artifact the contract accepts. Before backlinks were derived this
    // threw `backlinks: must be the exact inverse of outgoing links`, which is
    // every repository with an internal link failing to build.
    await writeArtifact(discovery, join(root, 'out', 'content.json'));
    const artifact = JSON.parse(readFileSync(join(root, 'out', 'content.json'), 'utf8'));
    assert.equal(artifact.entries.length, 4);
    // No excluded path anywhere in the artifact, including in an excerpt.
    assert.ok(!JSON.stringify(artifact).includes('drafts/'), 'an excluded path reached the artifact');
  });
});

test('a title the author wrote in frontmatter survives the traversal', async () => {
  // The traversal re-derives a title from the *rewritten* body, because the
  // authored one may have carried a wikilink. That re-derivation must not
  // overwrite a title the author declared — measured: without the guard, a note
  // carrying `title: Declared` published under its heading instead.
  await scratch('tk27-title-', async (root) => {
    put(root, 'a.md', '---\ntitle: Declared\n---\n\n# Heading Instead\n\nSee [[b]].\n');
    put(root, 'b.md', '# B\n\nprose\n');

    const discovery = await discover(root);
    await resolveCorpusLinks(discovery);

    const entry = discovery.entries.find((candidate) => candidate.slug === 'a')!;
    assert.equal(entry.title, 'Declared');
    // …and a note without one still gets its heading, so the guard did not
    // simply stop deriving titles.
    assert.equal(discovery.entries.find((candidate) => candidate.slug === 'b')!.title, 'B');
  });
});

test('the report carries every finding, sorted, with its candidates', () => {
  // The writer's half of the report integration. `discovered()` takes the
  // findings and sorts them where a reader would look; the *stream* still
  // carries only counts, which is the split TK-25 §2 requires — a workflow log
  // is world-readable and a link naming a withheld note is a disclosure.
  scratch2('tk27-report-', (root) => {
    const report = openReport(root);

    // Deliberately out of order, so the sort is doing work.
    report.discovered({ discovered: 4, published: 3, dropped: 1 }, [], [
      { source: 'z/last.md', line: 2, link: '[[gone]]', outcome: 'unresolved' },
      {
        source: 'a/first.md',
        line: 40,
        link: '[[alpha]]',
        outcome: 'ambiguous',
        candidates: ['guides/alpha.md', 'notes/alpha.md'],
        resolvedTo: 'notes/alpha.md',
      },
      {
        source: 'a/first.md',
        line: 9,
        link: '[[held]]',
        outcome: 'unpublished',
        candidates: ['drafts/held.md'],
      },
    ]);

    const written = JSON.parse(readFileSync(report.destination, 'utf8'));

    // Sorted by source then line, and *numerically* by line: a string sort puts
    // 40 before 9.
    assert.deepEqual(
      written.links.map((row: { source: string; line: number }) => `${row.source}:${row.line}`),
      ['a/first.md:9', 'a/first.md:40', 'z/last.md:2'],
    );

    // Every candidate reaches the file, which is the acceptance criterion.
    assert.deepEqual(written.links[1].candidates, ['guides/alpha.md', 'notes/alpha.md']);
    assert.equal(written.links[1].resolvedTo, 'notes/alpha.md');
    // And the row with nothing to look at carries no empty list, which would
    // read as "looked and found none".
    assert.equal(written.links[2].candidates, undefined);

    // The counts line is unchanged: three integers and a source literal. A
    // findings count on the stream would be a number, but the names stay in the
    // file either way, and this asserts the stream did not grow a new surface.
    assert.match(report.summary, /^content: 4 discovered, 3 published, 1 dropped$/);
  });
});

test('a report with nothing to say still has a links array', () => {
  // Empty rather than omitted, for the same reason `dropped` is: a reader's
  // access must not depend on whether this run found anything, and
  // `jq '.links | length'` must be meaningful on every report.
  scratch2('tk27-report-empty-', (root) => {
    const report = openReport(root);
    // The stub, before anything has happened.
    assert.deepEqual(JSON.parse(readFileSync(report.destination, 'utf8')).links, []);
    // And after a discovery that recorded no findings at all.
    report.discovered({ discovered: 1, published: 1, dropped: 0 }, []);
    assert.deepEqual(JSON.parse(readFileSync(report.destination, 'utf8')).links, []);
  });
});

test('a linked image builds, which is the badge every README opens with', () => {
  // Measured across three drafts, and each fixed one defect by introducing the
  // next:
  //
  // 1. Both nodes edited as whole-span replacements — `applyEdits` refused the
  //    overlap, `resolveCorpusLinks` turned it into a `BuildFailure`, and a
  //    repository containing one linked local image could not build at all.
  // 2. The nested node not visited — the build worked and the *leak* arrived:
  //    with `assets/diagram.png` unpublished, the standalone form correctly
  //    degraded to `logo` while the nested form shipped
  //    `[![logo](assets/diagram.png)](/notes-beta/)`, path and all.
  // 3. Each rewrite split into the two regions around the node's label, which
  //    is where a nested node writes. Both edits apply, neither overwrites the
  //    other, and the two forms of the same image now agree.
  const result = traverse('Badge: [![logo](assets/diagram.png)](notes/beta.md)');
  assert.equal(result.markdown, 'Badge: [logo](/notes-beta/)');
  assert.deepEqual(result.outgoing, ['notes-beta']);
  // The excluded image is still *reported*, which draft 2 also had and draft 1
  // never reached.
  assert.deepEqual(
    result.findings.map((finding) => finding.outcome),
    ['unpublished'],
  );

  // The two forms of the same image agree — the property draft 2 broke, and the
  // one a gate on the badge alone cannot see.
  //
  // **They agree by pointing at different things, and that asymmetry is the
  // decision rather than a defect.** Since 2026-08-17 a withheld target renders
  // as a live link to `/private/`, *except* where it is nested inside another
  // link: CommonMark has no nested anchor, so the badge form must stay text or
  // the outer link is destroyed. Measured through the shipped renderer, the
  // nested-anchor form emits `[<a href="/private/">chart</a>](/notes-beta/)` —
  // an anchor to the withheld page with the outer link's closing syntax spilled
  // into the prose. What "agree" means here is that neither form ships the
  // *path*: an image's label is its alt text, which the author wrote.
  assert.equal(traverse('![logo](assets/diagram.png)').markdown, '[logo](/private/)');

  // A published image would keep its markup; there is no asset pipeline, so the
  // external form is the only one that reaches that branch. Untouched, which is
  // what proves the fix did not simply strip every nested node.
  const external = traverse('Badge: [![b](https://img.example/x)](notes/beta.md)');
  assert.equal(external.markdown, 'Badge: [![b](https://img.example/x)](/notes-beta/)');

  // An outer link that itself degrades still degrades — and does not throw,
  // which drafts 1 and 3 both did before the split reached this branch.
  assert.equal(traverse('[![logo](assets/diagram.png)](gone.md)').markdown, 'logo');

  // Prose around a nested node survives. Draft 2's fix, applied naively,
  // deleted it.
  assert.equal(
    traverse('[text with ![i](assets/diagram.png) inside](notes/beta.md)').markdown,
    '[text with i inside](/notes-beta/)',
  );
});

test('every withheld link form is live, keeps its label, and ships no withheld body', async () => {
  // **Was "no withheld path reaches the body or the excerpt, in any link form",
  // and its central property was deleted on 2026-08-17.** That property read:
  //
  //     for (const path of withheld)
  //       for (const segment of path.split('/').slice(0, -1))
  //         assert.ok(!artifact.includes(segment), …)
  //
  // — every directory segment of every withheld file, absent from the whole
  // artifact. It protected the fact that a reader of the published site could
  // not learn *where in the author's tree* a withheld note lived. The owner
  // reversed that: the label survives whole, and a wikilink's label is its path,
  // so the artifact now carries it. The assertion is false and is gone rather
  // than weakened, because a weakened version would read as though something
  // were still being withheld.
  //
  // **The fixture is kept, and it is the reason this is a repurposing rather
  // than a deletion.** Eleven link forms over two withheld files is the most
  // hostile corpus in this tree for the `unpublished` branch, and the new rule
  // needs exactly that breadth: it has to hold for the bare wikilink, the
  // `/`-anchored one, the subpath, the embed, the percent-encoded href, and the
  // two nested forms alike. Rebuilding this fixture for the new rule would have
  // produced this fixture.
  await scratch('tk27-withheld-', async (root) => {
    // Every segment is a distinctive token, so an assertion that finds one has
    // found a real disclosure rather than an English word that happens to occur
    // in the fixture prose.
    const withheld = ['zzqclients/zzqacme/zzqrenewal.md', 'zzqprivate/zzqchart.png'];
    put(
      root,
      'zzqclients/zzqacme/zzqrenewal.md',
      '---\npublish: false\n---\n\n# Renewal\n\nzzqwithheldbody prose no reader may see\n',
    );
    put(root, 'zzqprivate/zzqchart.png', 'not really a png\n');
    put(root, 'target.md', '# Target\n\nprose\n');

    // Every form that can name a file, including the two that leaked under the
    // old syntax-based rule and the nested one, written so each appears in a
    // body that also has ordinary prose around it.
    put(
      root,
      'src.md',
      [
        '# Source',
        '',
        'Bare wikilink [[zzqclients/zzqacme/zzqrenewal]] here.',
        'Anchored [[/zzqclients/zzqacme/zzqrenewal]] here.',
        'Subpath [[zzqclients/zzqacme/zzqrenewal#Some Heading]] here.',
        'Embed ![[zzqclients/zzqacme/zzqrenewal]] here.',
        'Label equals target [[zzqclients/zzqacme/zzqrenewal|zzqclients/zzqacme/zzqrenewal]] here.',
        'Markdown [text](zzqclients/zzqacme/zzqrenewal.md) here.',
        'Encoded [text](zzqclients/zzqacme/zzqrenewal%2Emd) here.',
        'Label equals href [zzqclients/zzqacme/zzqrenewal](zzqclients/zzqacme/zzqrenewal.md) here.',
        'Image ![chart](zzqprivate/zzqchart.png) here.',
        'Image embed ![[zzqprivate/zzqchart.png]] here.',
        'Nested [![chart](zzqprivate/zzqchart.png)](target.md) here.',
        'Nested to nothing [![chart](zzqprivate/zzqchart.png)](gone.md) here.',
      ].join('\n'),
    );

    const discovery = await discover(root);
    const findings = await resolveCorpusLinks(discovery);
    await writeArtifact(discovery, join(root, 'out', 'content.json'));
    const artifact = readFileSync(join(root, 'out', 'content.json'), 'utf8');

    // **Non-vacuity, and it is two halves.** The tokens must be present in the
    // *input* — otherwise an empty corpus passes the assertions below — and the
    // build must have seen them as real files, which the findings prove. Both
    // are asserted before anything else is.
    const source = readFileSync(join(root, 'src.md'), 'utf8');
    for (const path of withheld) {
      const directory = path.slice(0, path.indexOf('/'));
      assert.ok(source.includes(directory), `the fixture never mentions ${directory}`);
    }
    assert.ok(
      findings.filter((finding) => finding.outcome === 'unpublished').length >= 10,
      `the corpus reached ${findings.length} findings, so most forms resolved to nothing ` +
        'instead of to a withheld file and the assertions below prove little',
    );

    const entry = discovery.entries.find((candidate) => candidate.slug === 'src')!;

    // **The rule, one row per authored form, written out.**
    //
    // This replaced a count — `anchors === unpublished - nested` — that review
    // proved self-cancelling: both sides came from the same run, so a form
    // regressing from `unpublished` to `unresolved` decremented the finding
    // count *and* the anchor count together and the gate stayed green. Measured
    // on this fixture: sending the subpath form, the percent-encoded form, or
    // the embed to `unresolved` each took it from `12/10` to `11/9`, green every
    // time, and doing two at once reached `10/8` and still cleared the `>= 10`
    // non-vacuity check above. Nine of the eleven forms were protected by
    // nothing. That is lesson 3 of `docs/gate-reading.md` in its arithmetic
    // form: a comparison between two numbers the same defect moves is not a
    // comparison.
    //
    // So each form states what it must render as. A regression in any one of
    // them now names that one.
    const anchor = `(${WITHHELD_ROUTE})`;
    for (const [expected, what] of [
      [`[zzqclients/zzqacme/zzqrenewal]${anchor}`, 'the bare wikilink'],
      [`[/zzqclients/zzqacme/zzqrenewal]${anchor}`, 'the /-anchored wikilink'],
      [`[zzqclients/zzqacme/zzqrenewal#Some Heading]${anchor}`, 'the subpath wikilink'],
      // The embed and the label-equals-target form both reduce to the bare
      // spelling, so they are counted rather than merely found: three
      // occurrences of that exact string is what proves all three rendered.
      [`[text]${anchor}`, 'the markdown href and its percent-encoded twin'],
      [`[chart]${anchor}`, 'the standalone image'],
      [`[zzqprivate/zzqchart.png]${anchor}`, 'the image embed, whose alt is its path'],
    ] as const) {
      assert.ok(entry.markdown.includes(expected), `${what} did not render as ${expected}`);
    }

    // The four forms whose output is the same string, counted. `includes`
    // cannot tell one occurrence from four, and these are four separately
    // authored links — the bare wikilink, the embed, the label-equals-target
    // spelling, and the label-equals-href one — that must each have rendered.
    // The number is measured against the fixture rather than reasoned about: an
    // earlier draft of this line said three, having forgotten that a Markdown
    // href whose label is its own target lands on the identical string.
    assert.equal(
      entry.markdown.split(`[zzqclients/zzqacme/zzqrenewal]${anchor}`).length - 1,
      4,
      'the bare wikilink, the embed, and the two label-equals-target forms do not all render ' +
        `alike: ${entry.markdown}`,
    );
    // And `[text](…)` is two: the plain markdown href and the percent-encoded
    // one, which resolve to the same file by different spellings.
    assert.equal(
      entry.markdown.split(`[text]${anchor}`).length - 1,
      2,
      `the percent-encoded href did not resolve to the same withheld file: ${entry.markdown}`,
    );

    // The two nested forms stay text, because an anchor may not open inside a
    // link. Each is asserted as its whole line: the withheld image's own alt
    // survives as the *label of the outer link* where that link is published,
    // and as bare text where the outer link resolved to nothing. Asserting the
    // absence of `/private/` alone would pass on a build that deleted the node.
    assert.ok(
      entry.markdown.includes('Nested [chart](/target/) here.'),
      `a nested withheld image did not become the outer link's label: ${entry.markdown}`,
    );
    assert.ok(
      entry.markdown.includes('Nested to nothing chart here.'),
      `a nested withheld image under an unresolved link was not degraded: ${entry.markdown}`,
    );

    // **And the body is still withheld, which is the half the decision did not
    // touch.** A path in the artifact and a *note* in the artifact are different
    // facts, and this is the one that must stay false — it is the line between
    // "the link discloses where the note lives" and "the note was published".
    assert.ok(
      !artifact.includes('zzqwithheldbody'),
      "the withheld note's own prose reached the artifact",
    );
    assert.ok(
      !discovery.entries.some((candidate) => candidate.slug.includes('zzqrenewal')),
      'the withheld note became an entry',
    );

    // The author's surrounding prose is untouched.
    assert.ok(entry.markdown.includes('Bare wikilink'), "the author's prose was deleted");
    assert.ok(entry.markdown.includes('here.'), "the author's prose was truncated");
  });
});

test('every spelling of a withheld target renders as one live link, label intact', () => {
  // **Replaces "an unpublished target path does not enter the body, even
  // undisplayed", which held the reduction the owner reversed on 2026-08-17.**
  // What that gate protected: the withheld note's *directory* never reached the
  // body, in any of the nine spellings below — so a reader could learn that a
  // note named `secret plan` existed and not where in the author's tree it sat.
  // Every one of its assertions is now false, and none is recoverable in a
  // weaker form: `!markdown.includes('drafts')` has no weaker version that still
  // says something.
  //
  // **The nine spellings are kept, and they are the reason this is a rewrite
  // rather than a deletion.** Each was added because a mutation removing its
  // handling stayed green — the `/`-anchored label, the percent-encoded one, the
  // label that equals its own target. Those are the spellings a rule about
  // withheld links has to be exercised over whichever direction the rule runs,
  // and they are asserted here as exact output so a partial rewrite of any one
  // of them is visible rather than absorbed.
  const corpus: readonly CorpusFile[] = [
    { path: 'src.md', slug: 'src' },
    { path: 'drafts/secret plan.md', slug: undefined },
  ];
  const run = (body: string) =>
    resolveLinksIn(body, 'src.md', indexCorpus(corpus), 'src', (slug) => `/${slug}/`);

  // Exact output for every form, rather than a substring test. A substring test
  // ("the path is present") would be green on a rewrite that emitted the path
  // *and* mangled the anchor around it, which is precisely the failure mode of
  // an edit made to the label region.
  for (const [body, expected] of [
    ['A [[drafts/secret plan]] end', 'A [drafts/secret plan](/private/) end'],
    ['B ![[drafts/secret plan]] end', 'B [drafts/secret plan](/private/) end'],
    // The subpath survives *in the label* and points nowhere new: `/private/` is
    // one page with no heading of the withheld note on it. It is part of what
    // the author wrote, so removing it would be an edit to their prose.
    ['C [[drafts/secret plan#Some Heading]] end', 'C [drafts/secret plan#Some Heading](/private/) end'],
    ['D [[/drafts/secret plan]] end', 'D [/drafts/secret plan](/private/) end'],
    // The label that equals its own target, which is the spelling that leaked
    // past the first syntax-based rule and is now simply the ordinary case.
    [
      'E [[drafts/secret plan|drafts/secret plan]] end',
      'E [drafts/secret plan](/private/) end',
    ],
    ['F [drafts/secret plan](drafts/secret%20plan.md) end', 'F [drafts/secret plan](/private/) end'],
    // A label the author wrote that is *not* the path: untouched, which is what
    // proves the label is carried through rather than reconstructed from the
    // target. This is the one row whose expected value is the same under both
    // rules, and it is kept for that reason.
    ['G [see notes/the draft](drafts/secret%20plan.md) end', 'G [see notes/the draft](/private/) end'],
    [
      'H [[/drafts/secret plan|/drafts/secret plan]] end',
      'H [/drafts/secret plan](/private/) end',
    ],
    [
      'I [drafts/secret%20plan.md](drafts/secret%20plan.md) end',
      'I [drafts/secret%20plan.md](/private/) end',
    ],
  ] as const) {
    assert.equal(run(body).markdown, expected, `${body} did not render as one live withheld link`);
  }

  // And the destination is the constant the site reserves, not a literal spelled
  // twice. Without this the rows above would pin `/private/` as a string and a
  // rename of the route would leave nine green rows describing a page that no
  // longer exists.
  assert.ok(
    run('J [[drafts/secret plan]] end').markdown.includes(`](${WITHHELD_ROUTE})`),
    'the withheld link does not point at the route the site reserves for it',
  );
});

test('a withheld node inside a reference link does not open an anchor inside one', () => {
  // **The defect this exists for was shipped and found by review.** The nesting
  // set was filled by testing `node.type === 'link' || node.type === 'image'` —
  // the two types this walk *rewrites* — and mdast's reference-style link is
  // neither. So `[![build](badge.png)][ci]`, the badge idiom half of every
  // README uses, had its withheld image marked unnested, took the live branch,
  // and emitted an anchor inside a link. Measured through the shipped renderer:
  //
  //     <p>Badge: [<a href="/private/">build</a>]<a href="https://ci.example/">ci</a></p>
  //
  // — the outer reference link destroyed, a stray bracket in the prose, and its
  // label `ci` rendered as the anchor text. It is also the only way the withheld
  // rule could change a link that is *not* withheld.
  //
  // **Mutation watched fail:** removing `'linkReference'` from `CONTAINS_LINK`
  // in `scripts/resolve-links.ts` restores exactly the output above and turns
  // the first row red.
  const corpus: readonly CorpusFile[] = [
    { path: 'src.md', slug: 'src' },
    { path: 'other.md', slug: 'other' },
    { path: 'assets/badge.png', slug: undefined },
    { path: 'drafts/secret.md', slug: undefined },
  ];
  const run = (body: string) =>
    resolveLinksIn(body, 'src.md', indexCorpus(corpus), 'src', (slug) => `/${slug}/`).markdown;

  const definition = '\n\n[ci]: https://ci.example/\n';
  for (const [body, expected, what] of [
    // The two withheld-inside-reference shapes. Each degrades to its own label
    // as text, which is what a node that may not open an anchor does.
    [
      `Badge: [![build](assets/badge.png)][ci]${definition}`,
      `Badge: [build][ci]${definition}`,
      'a withheld image inside a reference link',
    ],
    // **Not nesting, and it is here because it looks like it.**
    // `[[[drafts/secret]]][ci]` reads as a wikilink *beside* a reference link
    // rather than inside one — measured on the parse tree: `link`, `text`,
    // `linkReference` as three siblings of one paragraph. So the wikilink is
    // unnested and correctly becomes an anchor, and the brackets around it are
    // the author's own text. Written down because the first version of this row
    // asserted the nested outcome, went red, and the tree is what settled it:
    // a shape that looks nested in the source is not necessarily nested in the
    // tree, and only the tree decides this branch.
    [
      `See [[[drafts/secret]]][ci]${definition}`,
      `See [[drafts/secret](${WITHHELD_ROUTE})][ci]${definition}`,
      'a withheld wikilink beside a reference link',
    ],
    // And the reference link itself is untouched in every case, withheld
    // content or not — the property the defect broke.
    [
      `A [text][ci] end${definition}`,
      `A [text][ci] end${definition}`,
      'an ordinary reference link',
    ],
    [
      `B [![ok](https://img.example/x)][ci] end${definition}`,
      `B [![ok](https://img.example/x)][ci] end${definition}`,
      'a reference link wrapping an external image',
    ],
  ] as const) {
    assert.equal(run(body), expected, `${what} was rewritten wrongly`);
  }

  // Non-vacuity: the same withheld image *outside* a reference link does become
  // an anchor. Without this the rows above are satisfied by a build that
  // stopped making withheld links live at all.
  assert.equal(
    run('C ![build](assets/badge.png) end'),
    `C [build](${WITHHELD_ROUTE}) end`,
    'the unnested form is not live, so the rows above prove nothing about nesting',
  );
});

test('a withheld link with no label of its own still has an accessible name', () => {
  // `[](note.md)` and `![](chart.png)` carry no label at all. Under the rule
  // this replaced they degraded to nothing and the shape did not exist; now
  // they are anchors, and an anchor with no text is announced by a screen
  // reader as its URL. Measured before the fallback: `<a href="/private/"></a>`.
  //
  // The resolved branch has had this guard since TK-27 and falls back to the
  // target's slug. A withheld target has no slug — there is no published note —
  // so the fallback is what the destination says about itself.
  //
  // **Mutation watched fail:** dropping the third argument from the `rewrite`
  // call in the `unpublished` branch of `scripts/resolve-links.ts` turns both
  // rows red with an empty label.
  const corpus: readonly CorpusFile[] = [
    { path: 'src.md', slug: 'src' },
    { path: 'drafts/secret.md', slug: undefined },
    { path: 'assets/chart.png', slug: undefined },
  ];
  const run = (body: string) =>
    resolveLinksIn(body, 'src.md', indexCorpus(corpus), 'src', (slug) => `/${slug}/`).markdown;

  for (const body of ['[](drafts/secret.md) end', '![](assets/chart.png) end']) {
    assert.equal(
      run(body),
      `[${WITHHELD_LINK_TEXT}](${WITHHELD_ROUTE}) end`,
      `${body} produced an anchor with no accessible name`,
    );
  }

  // And a label the author *did* write is never replaced by the fallback, which
  // is what stops this from being "always use the fixed text".
  assert.equal(
    run('[their words](drafts/secret.md) end'),
    `[their words](${WITHHELD_ROUTE}) end`,
    "the author's own label was replaced by the fallback",
  );
});

test('the title and the excerpt carry a link\'s text, never its syntax', async () => {
  // Both fields are read as **plain text** — the excerpt lands verbatim in
  // `content-index.json`, `rss.xml`, and every `<meta name="description">`, and
  // the title in `<title>` and `og:title`. Neither goes through the Markdown
  // pipeline, and both are derived from the *rewritten* body, where every
  // internal link is already `[label](/route/)`. Measured before the fix, on a
  // corpus with one ordinary link in a heading and one in a paragraph:
  //
  //     <title>See [beta](/beta/) now · Notes</title>
  //     <meta name="description" content="See [beta](/beta/) for the numbers.">
  //
  // This is the same defect `aab694b` fixed for code spans, in the same
  // function; that fix stripped backticks and stopped.
  //
  // **Asserted over a corpus carrying every link form**, not one: the shapes
  // that break a naive strip are the ones a single-link fixture cannot contain —
  // a badge (a link whose label is an image, so one pass leaves the outer
  // construct), an escaped bracket in a label, and a reference link, which must
  // survive untouched because nothing here resolves one.
  //
  // **Mutation watched fail:** deleting the `withoutLinkSyntax` call from
  // `excerptFor` in `scripts/markdown-to-artifact.ts` turns the excerpt row red
  // with `[beta](/beta/)`; deleting it from `titleFor` turns the title row red.
  await scratch('exc-syntax-', async (root) => {
    put(root, 'beta.md', '# Beta\n\nplain prose\n');
    put(root, 'drafts/secret.md', '---\npublish: false\n---\n\n# S\n\nhidden\n');
    put(root, 'assets/logo.png', 'not really a png\n');
    put(
      root,
      'hub.md',
      [
        '# See [beta](beta.md) now',
        '',
        'See [[beta]], [[drafts/secret]] too, and ![alt](assets/logo.png).',
        'A badge [![logo](assets/logo.png)](beta.md) and a bracket [[beta|has ] bracket]].',
        'A ref [text][ci] and a bare https://example.invalid/p stay.',
        '',
        '[ci]: https://example.invalid/',
      ].join('\n'),
    );

    const discovery = await discover(root);
    await resolveCorpusLinks(discovery);
    const hub = discovery.entries.find((entry) => entry.slug === 'hub')!;

    // The title, whose link is in the heading itself.
    assert.equal(hub.title, 'See beta now');

    // The excerpt, every form at once. Written as one expected string rather
    // than a set of `includes` checks: a substring test cannot see a construct
    // that was half-stripped, which is the failure mode of the badge.
    //
    // The corpus is kept under `excerptFor`'s 200-character cap on purpose. An
    // earlier draft ran to 207 and the tail — the reference link, the one form
    // that must survive untouched — was replaced by an ellipsis, so the gate
    // would have measured truncation while claiming to measure stripping.
    //
    // **The bracket row asserts a known-broken output, deliberately.** A
    // wikilink whose display half contains `]` is a pre-existing producer
    // defect: `escapeLabel` escapes it in the whole-span rewrite and the
    // *split* rewrite — the one a node with a label span takes — leaves the
    // label's own bytes in place, unescaped. Measured on `2405cb2`, before any
    // of this ticket's work: `[[beta|has ] bracket]]` becomes
    // `[has ] bracket](/beta/)`, which is not link syntax and renders as literal
    // text. So there is nothing here for a stripper to strip, and asserting the
    // *repaired* string would be asserting a fix nobody has made. Recorded so
    // whoever fixes the escape sees this row go red and knows it is the row that
    // should change.
    assert.equal(
      hub.excerpt,
      'See beta, drafts/secret too, and alt. ' +
        'A badge logo and a bracket [has ] bracket](/beta/). ' +
        'A ref [text][ci] and a bare https://example.invalid/p stay. ' +
        '[ci]: https://example.invalid/',
    );
    // Under the cap, so the row above is a statement about stripping rather
    // than about the ellipsis.
    assert.ok(!hub.excerpt.endsWith('…'), 'the fixture crossed the 200-character cap');

    // Non-vacuity: the *body* still carries the syntax, so the two rows above
    // are a statement about these two fields rather than about a build that
    // stopped rewriting links at all.
    assert.ok(
      hub.markdown.includes('[beta](/beta/)'),
      `the rewritten body carries no link syntax, so stripping it proves nothing: ${hub.markdown}`,
    );
    // And the withheld path is still in both, which is the 2026-08-17 decision:
    // this strips *syntax*, never the author's words.
    assert.ok(hub.excerpt.includes('drafts/secret'), 'the withheld path was stripped from the excerpt');
  });

  // The escaped form, which the corpus above cannot reach: only the whole-span
  // rewrite escapes a bracket, and that path is taken by a node with no label
  // span — an image embed. Without this the `\]` branch of the strip is
  // unasserted, and a mutation deleting it stays green.
  await scratch('exc-escaped-', async (root) => {
    put(root, 'beta.md', '# Beta\n\nprose\n');
    put(root, 'hub.md', '# Hub\n\nAn embed ![[beta|has ] bracket]] here.\n');

    const discovery = await discover(root);
    await resolveCorpusLinks(discovery);
    const hub = discovery.entries.find((entry) => entry.slug === 'hub')!;

    // The traversal wrote `[has \] bracket](/beta/)`; the reader gets the
    // bracket, not the backslash.
    assert.ok(
      hub.markdown.includes('[has \\] bracket](/beta/)'),
      `the fixture did not reach the escaping path, so the row below proves nothing: ${hub.markdown}`,
    );
    assert.equal(hub.excerpt, 'An embed has ] bracket here.');
  });
});

test('a bracket in a label cannot truncate the link it lands in', () => {
  // Text moved from one construct into another has to be re-escaped for the one
  // it lands in. A wikilink's display half and an image's `alt` are not
  // link-label syntax, so a `[` or `]` inside either is ordinary text there and
  // a delimiter here. Measured before `escapeLabel` existed — the anchor ended
  // at the author's bracket and the rest became prose:
  //
  //     ![[t|before ] after]]  ->  [before ] after](/t/)
  //
  // Asserted through the *renderer* as well as on the Markdown, because the
  // escape is only correct if it disappears again: a reader must see the
  // bracket, not a backslash.
  const corpus: readonly CorpusFile[] = [
    { path: 'src.md', slug: 'src' },
    { path: 't.md', slug: 't' },
  ];
  const run = (body: string) =>
    resolveLinksIn(body, 'src.md', indexCorpus(corpus), 'src', (slug) => `/${slug}/`).markdown;

  assert.equal(run('![[t|has ] bracket]]'), '[has \\] bracket](/t/)');
  assert.equal(run('![[t|has [ bracket]]'), '[has \\[ bracket](/t/)');
  // A label with no bracket gains no backslash, so the escape is not applied
  // indiscriminately.
  assert.equal(run('![[t|plain label]]'), '[plain label](/t/)');
});

test('an escaped bracket renders as one anchor, with the bracket in its text', async () => {
  // The other half of the escape, and the half that matters to a reader: the
  // backslash must disappear again. Asserted through the shipped renderer
  // rather than by inspecting Markdown, because "correctly escaped" is a claim
  // about what the next stage does with it — and the escape would be worse than
  // the defect if it shipped a visible backslash.
  const corpus: readonly CorpusFile[] = [
    { path: 'src.md', slug: 'src' },
    { path: 't.md', slug: 't' },
  ];
  const markdown = resolveLinksIn(
    'See ![[t|has ] bracket]] here.',
    'src.md',
    indexCorpus(corpus),
    'src',
    (slug) => `/${slug}/`,
  ).markdown;

  const { html } = await renderMarkdown(markdown);
  assert.match(html, /<a href="\/t\/">has \] bracket<\/a>/);
  assert.ok(!html.includes('\\'), `a backslash reached the reader: ${html}`);
});

test('an NFC link finds an NFD filename in every segment, not only the last', () => {
  // Obsidian normalises the link text and not the filename; this normalises
  // both, so the answer does not depend on which machine checked the repository
  // out. Measured when only the *key* was normalised: the single-segment form
  // resolved and every multi-segment form did not — which is the same
  // macOS-versus-Linux divergence the normalisation exists to remove, surviving
  // in the shape a real vault uses most.
  const nfc = 'café'; // precomposed
  const nfd = 'café'; // decomposed
  assert.notEqual(nfc, nfd, 'the two spellings are one string, so this gate proves nothing');

  const corpus: readonly CorpusFile[] = [
    { path: 'src.md', slug: 'src' },
    { path: `${nfd}/note.md`, slug: 'cafe-note' },
    { path: `dir/${nfd}.md`, slug: 'dir-cafe' },
  ];
  const run = (body: string) =>
    resolveLinksIn(body, 'src.md', indexCorpus(corpus), 'src', (slug) => `/${slug}/`);

  // A normalised directory segment, which the basename key never sees.
  assert.equal(run(`A [[${nfc}/note]] end`).markdown, 'A [café/note](/cafe-note/) end');
  // …and a normalised basename in a multi-segment path.
  assert.equal(run(`B [[dir/${nfc}]] end`).markdown, 'B [dir/café](/dir-cafe/) end');
});

test('resolving one discovery twice is refused rather than silently corrupting it', async () => {
  // Rewriting is not idempotent and cannot be — the output syntax is the input
  // syntax. Measured before the guard: a second pass read its own `[b](/b/)` as
  // a new link, resolved it to nothing, degraded it to the bare text `b`,
  // emptied `outgoing` and `backlinks`, and emitted a spurious `unresolved`
  // finding. All of it silent, and all of it in the artifact.
  await scratch('tk27-twice-', async (root) => {
    put(root, 'a.md', '# A\n\nSee [[b]].\n');
    put(root, 'b.md', '# B\n\nprose\n');

    const discovery = await discover(root);
    await resolveCorpusLinks(discovery);
    const after = discovery.entries.find((entry) => entry.slug === 'a')!.markdown;

    const refusal = await resolveCorpusLinks(discovery).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    assert.ok(refusal, 'a second resolution pass was accepted');
    assert.match(refusal.message, /ran twice over one discovery/);
    // A plain `Error`, not a `BuildFailure`: the closed failure-code set is for
    // faults a user's repository can cause and a user can fix, and calling this
    // twice is neither.
    assert.equal(refusal.name, 'Error');

    // And it refused *before* touching anything, so the corpus still holds the
    // first pass's result rather than a half-applied second one.
    assert.equal(discovery.entries.find((entry) => entry.slug === 'a')!.markdown, after);
    assert.deepEqual(discovery.entries.find((entry) => entry.slug === 'a')!.outgoing, ['b']);
  });
});

test('a wikilink in prose cannot survive into the rendered page', async () => {
  // **The producer half of the residue scan's code-region exemption.**
  // `scripts/scan-residue.ts` exempts `[[` inside `<code>` and `<pre>`, and
  // that exemption is safe only because a note body cannot get a `[[` into
  // prose in the first place. It is worth stating why the obvious tightening is
  // wrong: `sanitize-html` allows `code` as a raw tag, so a body *can* wrap its
  // own prose in one — but requiring `class="language-…"` to exclude that
  // breaks inline code, which renders as a bare `<code>[[syntax]]</code>` with
  // no class, and documenting the syntax inline is as legitimate as a fence.
  //
  // So the exemption rests on this: the traversal parses with `wikilinks: true`
  // and every `[[…]]` in prose is a link node, resolved and degraded. A body
  // that opens a raw `<code>` tag around one gets the degraded text inside its
  // own tag, not a live marker. Asserted end to end, because a claim about what
  // reaches `dist/` is only worth what the whole chain does.
  await scratch('tk27-prose-', async (root) => {
    put(root, 'other.md', '# Other\n\nprose\n');
    put(
      root,
      'src.md',
      [
        '# Source',
        '',
        'Text with a raw <code> tag then [[stray]] after.',
        '',
        'A [[resolvable]] one and a [[missing one]] too.',
        '',
        'Documented in a fence, which must survive:',
        '',
        '```text',
        '[[documented]]',
        '```',
        '',
        'And inline `[[also documented]]`.',
      ].join('\n'),
    );
    put(root, 'resolvable.md', '# Resolvable\n\nprose\n');

    const discovery = await discover(root);
    await resolveCorpusLinks(discovery);
    const entry = discovery.entries.find((candidate) => candidate.slug === 'src')!;
    const { html } = await renderMarkdown(entry.markdown);

    // The fenced and inline forms survive as authored — that is the content
    // this whole exemption exists to allow.
    assert.match(html, /<code[^>]*>\[\[documented\]\]<\/code>/);
    assert.match(html, /<code>\[\[also documented\]\]<\/code>/);

    // And *outside* those, nothing. Asserted on the page with its code regions
    // removed, which is the same question the residue scan asks: a `[[` a
    // reader meets in prose means the degradation failed.
    const prose = html.replace(/<(pre|code)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, '');
    assert.ok(
      !prose.includes('[['),
      `a wikilink survived into prose, so the residue scan's code exemption is unsound: ${prose}`,
    );
    // Non-vacuity: the stripper left real prose behind rather than blanking the
    // page. Deliberately not asserting on the text *after* the raw `<code>` —
    // the sanitizer closes that tag at the end of the paragraph, so the words
    // following it are genuinely inside a code element. That is the sanitizer's
    // behaviour and not this ticket's, and it is also why the exemption cannot
    // rest on where a body's own tags fall.
    assert.match(prose, /Text with a raw/);
    assert.match(prose, /<a href="\/resolvable\/">resolvable<\/a> one/);
    assert.match(prose, /missing one/);
  });
});

test('the traversal imports no package absent from the manifest', () => {
  // The same rule `tests/discovery.test.ts` holds over the producer, applied to
  // the module that actually pulls the parser in. pnpm's symlinked
  // `node_modules` makes this a real failure mode: a module importing a
  // transitive dependency resolves here and fails in a consumer's install.
  const source = readFileSync(new URL('../scripts/resolve-links.ts', import.meta.url), 'utf8');
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { dependencies: Record<string, string> };

  const imports = [...source.matchAll(/from '([^']+)'/g)]
    .map((match) => match[1]!)
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'));

  assert.ok(imports.includes('satteri'), 'the parser is no longer imported here');
  for (const specifier of imports) {
    assert.ok(
      specifier in manifest.dependencies,
      `${specifier} is imported but is not a direct dependency`,
    );
  }
});

test('the walk itself loads without a parser, which the cross-platform gate needs', () => {
  // `satteri`'s parser is a native binding installed per platform — a win32
  // install carries `@bruits/satteri-win32-x64-msvc` and nothing else. TK-26's
  // cross-platform gate loads `markdown-to-artifact.ts` under WSL to compare
  // the two walks against the same bytes, and a static import of the traversal
  // made that load throw `Cannot find native binding` before discovery ran —
  // turning a green gate red on a property this ticket does not touch.
  //
  // Asserted on the producer's source rather than by loading it, because the
  // failure is a *static* import and a successful load here proves nothing
  // about a platform whose binding is absent.
  const source = readFileSync(new URL('../scripts/markdown-to-artifact.ts', import.meta.url), 'utf8');
  assert.ok(
    !/^import\s[^;]*from '\.\/resolve-links\.ts'/m.test(source.replace(/^import type\b.*$/gm, '')),
    'the producer statically imports the traversal, so loading it needs a native parser binding',
  );
  assert.match(
    source,
    /await import\('\.\/resolve-links\.ts'\)/,
    'the traversal is no longer loaded dynamically, so this gate measures nothing',
  );
});
