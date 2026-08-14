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

  // **The excluded note's path never enters the body.** It is a path to a file
  // the user chose not to publish, and the artifact is the one place it may not
  // appear — `schema.ts` would reject an absolute one and cannot see a relative
  // one, so this is the control.
  assert.ok(!result.markdown.includes('drafts/'), `the body carried an excluded path: ${result.markdown}`);
  assert.ok(!result.markdown.includes('secret.md'), 'the body carried an excluded filename');
  assert.equal(result.markdown, 'See secret and diagram.png.');
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
    put(root, 'index.md', '# Index\n\nSee [[notes/alpha]] and [beta](notes/beta.md).\n');
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
    assert.deepEqual(bySlug.get('index')!.outgoing.sort(), ['notes-alpha', 'notes-beta']);
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
  assert.equal(traverse('![logo](assets/diagram.png)').markdown, 'logo');

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

test('no withheld path reaches the body or the excerpt, in any link form', async () => {
  // **The property, not a list of forms.** Plan §2.5: "the resolved path never
  // enters `markdown`." Two earlier versions of this gate enumerated the
  // spellings their author happened to think of, and both were green while a
  // spelling nobody listed leaked — first the undisplayed wikilink, then a
  // label that *equals* the withheld path, which the "an authored label is
  // untouched" exemption swallowed:
  //
  //     [[drafts/secret plan|drafts/secret plan]]     -> "drafts/secret plan"
  //     [drafts/secret plan](drafts/secret%20plan.md) -> "drafts/secret plan"
  //
  // So this asserts over the *corpus*: every file the build did not publish,
  // against every form that can name one, checking the whole artifact rather
  // than one field. A form-by-form gate cannot catch the next spelling, and
  // there has now been a next spelling twice.
  await scratch('tk27-withheld-', async (root) => {
    // Every segment is a distinctive token, so an assertion that finds one has
    // found a real disclosure rather than an English word that happens to occur
    // in the fixture prose.
    const withheld = ['zzqclients/zzqacme/zzqrenewal.md', 'zzqprivate/zzqchart.png'];
    put(root, 'zzqclients/zzqacme/zzqrenewal.md', '---\npublish: false\n---\n\n# Renewal\n\nprose\n');
    put(root, 'zzqprivate/zzqchart.png', 'not really a png\n');
    put(root, 'target.md', '# Target\n\nprose\n');

    // Every form that can name a file, including the two that leaked and the
    // nested one, written so each appears in a body that also has ordinary
    // prose around it.
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
    // *input* — otherwise an empty corpus passes the absence check — and the
    // build must have seen them as real files, which the findings prove. Both
    // are asserted before any absence is.
    const source = readFileSync(join(root, 'src.md'), 'utf8');
    for (const path of withheld) {
      const directory = path.slice(0, path.indexOf('/'));
      assert.ok(source.includes(directory), `the fixture never mentions ${directory}`);
    }
    assert.ok(
      findings.filter((finding) => finding.outcome === 'unpublished').length >= 10,
      `the corpus reached ${findings.length} findings, so most forms resolved to nothing ` +
        'instead of to a withheld file and the absence assertions below prove little',
    );

    // The property. Every directory segment of every withheld file, absent from
    // the whole artifact — which covers `markdown`, `excerpt`, and `title` at
    // once, so a field added later is covered without editing this gate.
    for (const path of withheld) {
      for (const segment of path.split('/').slice(0, -1)) {
        assert.ok(
          !artifact.includes(segment),
          `the artifact carries "${segment}", a directory of a file this build withheld`,
        );
      }
    }

    // And the reader still gets the *name*, which is what makes this a
    // reduction rather than a deletion. Without it, "delete every label" passes
    // every assertion above.
    const entry = discovery.entries.find((candidate) => candidate.slug === 'src')!;
    assert.ok(
      entry.markdown.includes('zzqrenewal'),
      `the withheld note's own name was deleted rather than reduced: ${entry.markdown}`,
    );
    assert.ok(entry.markdown.includes('zzqchart.png'), 'the image lost its filename');
    // The author's surrounding prose is untouched.
    assert.ok(entry.markdown.includes('Bare wikilink'), "the author's prose was deleted");
    assert.ok(entry.markdown.includes('here.'), "the author's prose was truncated");
  });
});

test('an unpublished target path does not enter the body, even undisplayed', () => {
  // The narrow case the property gate above generalises, kept because it names
  // the two spellings that actually leaked and what each degrades to.
  const corpus: readonly CorpusFile[] = [
    { path: 'src.md', slug: 'src' },
    { path: 'drafts/secret plan.md', slug: undefined },
  ];
  const run = (body: string) =>
    resolveLinksIn(body, 'src.md', indexCorpus(corpus), 'src', (slug) => `/${slug}/`);

  for (const body of [
    'A [[drafts/secret plan]] end',
    'B ![[drafts/secret plan]] end',
    'C [[drafts/secret plan#Some Heading]] end',
    'D [[/drafts/secret plan]] end',
  ]) {
    const { markdown } = run(body);
    assert.ok(!markdown.includes('drafts'), `${body} leaked the excluded folder: ${markdown}`);
    assert.ok(!markdown.includes('.md'), `${body} leaked a filename: ${markdown}`);
    // The reader still sees the name the author typed, which is the point of
    // degrading to text rather than dropping the node.
    assert.ok(markdown.includes('secret plan'), `${body} lost the author's own words: ${markdown}`);
  }

  // The two spellings that leaked past a syntax-based rule, and the one whose
  // label is the author's own words. All three are decided by comparing against
  // the resolved path now, so there is no exemption for a spelling to hide in.
  //
  // Each keeps the form the author wrote: a wikilink names the note without its
  // extension and reduces to `secret plan`, while a Markdown href names the
  // file and reduces to `secret plan.md`. The directory is gone from both,
  // which is the property; the extension is not disclosing and the author's own
  // spelling is what a reader recognises.
  assert.equal(run('E [[drafts/secret plan|drafts/secret plan]] end').markdown, 'E secret plan end');
  assert.equal(
    run('F [drafts/secret plan](drafts/secret%20plan.md) end').markdown,
    'F secret plan end',
  );
  assert.equal(
    run('G [see notes/the draft](drafts/secret%20plan.md) end').markdown,
    'G see notes/the draft end',
  );

  // The two spellings the same path can wear, each of which needs its own entry
  // in the reduction list. Added after mutations removing them stayed green:
  // the corpus above never wrote a `/`-anchored link whose label was its own
  // target, nor a percent-encoded one, so both list entries were unasserted.
  assert.equal(
    run('H [[/drafts/secret plan|/drafts/secret plan]] end').markdown,
    'H secret plan end',
    'the /-anchored spelling of a withheld path was not reduced',
  );
  assert.equal(
    run('I [drafts/secret%20plan.md](drafts/secret%20plan.md) end').markdown,
    'I secret plan.md end',
    'the percent-encoded spelling of a withheld path was not reduced',
  );
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
