/**
 * Reference-style links resolve through the same path as inline links.
 *
 * **The defect this exists for.** `scripts/resolve-links.ts` visited only `link`
 * and `image` nodes, so a `linkReference` or `imageReference` kept whatever
 * destination its `definition` carried. Measured on the unfixed walk:
 *
 *     See [s][x].  [x]: drafts/secret.md   ->  <a href="drafts/secret.md">s</a>, no finding
 *     See [b][y].  [y]: b.md               ->  <a href="b.md">b</a>, outgoing []
 *
 * The first is a withheld target that neither reached `/private/` nor degraded;
 * the second a live anchor with no DB edge, which breaks the defining equality
 * in `docs/core-design/content-semantics.md` ("the distinct published
 * cross-note destinations in an article equal that note's outgoing DB query").
 *
 * Each gate asserts the rendered HTML as well as the edge set, because a
 * rewritten body that the renderer reads differently is what a reader gets.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Window } from 'happy-dom';
import { markdownToMdast, type MdastNode } from 'satteri';

import { indexCorpus, type CorpusFile } from '../src/lib/link-resolution.ts';
import { WITHHELD_ROUTE } from '../src/lib/route-path.ts';
import { classifyImageSource, resolveImageTarget, type ImagePublisher } from '../src/lib/media.ts';
import { resolveLinksIn } from '../scripts/resolve-links.ts';
import { renderMarkdown } from '../src/lib/markdown.ts';

const CORPUS: readonly CorpusFile[] = [
  { path: 'src.md', slug: 'src' },
  { path: 'notes/beta.md', slug: 'notes-beta' },
  { path: 'drafts/secret plan.md', slug: undefined },
  { path: 'assets/chart.png', slug: undefined },
];

/** The URL `assets/chart.png` publishes as; the walk itself never hashes it. */
const CHART_URL = `/_assets/${'b'.repeat(64)}-chart.png`;

/** The corpus's one media file, resolved the way the producer resolves it. */
const publisher: ImagePublisher = {
  async publish({ notePath, target, isWikilink }) {
    const resolved = resolveImageTarget(target, notePath, (path) => (path === 'assets/chart.png' ? path : undefined), isWikilink);
    if (resolved.kind === 'external') return { kind: 'external' };
    if (resolved.kind !== 'local') return { kind: 'failed', reason: resolved.kind };
    return { kind: 'published', url: CHART_URL };
  },
};

/** Resolve one body written as `src.md`, then render what it became. */
async function run(body: string) {
  const result = await resolveLinksIn(body, 'src.md', indexCorpus(CORPUS), 'src', (slug) => `/${slug}/`, publisher);
  // The renderer refuses a local image `src` the build did not publish, so the
  // one asset this corpus has is handed to it. That is what the note page does
  // with the artifact's own list.
  const { html } = await renderMarkdown(result.markdown, { publishedAssets: new Set([CHART_URL]) });
  return { ...result, html };
}

/** Every `href` the rendered HTML carries, in order. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) => match[1] ?? '');
}

test('a reference to a published note renders its route and contributes the edge', async () => {
  for (const [body, what] of [
    ['See [the beta note][b] now.\n\n[b]: notes/beta.md\n', 'a full reference'],
    ['See [B] now.\n\n[b]: notes/beta.md "A title"\n', 'a shortcut reference, case-folded, with a title'],
    ['See [b][] now.\n\n[b]:\n  <notes/beta.md>\n', 'a collapsed reference to a multi-line definition'],
    ['> See [t][b] now.\n>\n> [b]: notes/beta.md\n', 'a reference inside a blockquote'],
  ] as const) {
    const result = await run(body);
    assert.deepEqual(hrefs(result.html), ['/notes-beta/'], `${what}: ${result.html}`);
    assert.deepEqual(result.outgoing, ['notes-beta'], `${what}: the anchor has no edge`);
    assert.deepEqual(result.findings, [], what);
  }

  // A heading fragment stays on the href and off the edge, as it does inline.
  const fragment = await run('See [h][b].\n\n[b]: notes/beta.md#Some%20Heading\n');
  assert.deepEqual(hrefs(fragment.html), ['/notes-beta/#some-heading'], fragment.html);
  assert.deepEqual(fragment.outgoing, ['notes-beta']);

  // The first definition wins, as CommonMark (and the renderer) reads it.
  const duplicate = await run('See [t][b].\n\n[b]: notes/beta.md\n[B]: drafts/secret%20plan.md\n');
  assert.deepEqual(hrefs(duplicate.html), ['/notes-beta/'], duplicate.html);
  assert.deepEqual(duplicate.outgoing, ['notes-beta']);
});

test('a reference to a withheld note links /private/, keeps its label, and makes no edge', async () => {
  const result = await run('See [my plan][x] here.\n\n[x]: drafts/secret%20plan.md\n');
  assert.deepEqual(hrefs(result.html), [WITHHELD_ROUTE], result.html);
  assert.match(result.html, new RegExp(`<a href="${WITHHELD_ROUTE}">my plan</a>`));
  assert.deepEqual(result.outgoing, [], 'a withheld target made an edge');
  assert.deepEqual(
    result.findings.map((finding) => finding.outcome),
    ['unpublished'],
    'not reported as withheld',
  );
  // The withheld destination reaches neither the rendered page nor the body
  // handed onward — the definition line is rewritten too.
  for (const path of ['drafts/secret', 'secret%20plan']) {
    assert.ok(!result.markdown.includes(path), `${path} survived in the body`);
    assert.ok(!result.html.includes(path), `${path} survived in the page`);
  }
});

test('a reference-style image publishes through its definition', async () => {
  // The reference form takes the media pipeline, not the note resolver: its
  // destination is a source path this build never publishes, so both the
  // reference and the definition have to point at the asset's URL afterwards.
  const result = await run('See ![a chart][c] here.\n\n[c]: assets/chart.png\n');
  assert.deepEqual(result.outgoing, [], 'an image reference made a note edge');
  assert.deepEqual(result.mediaFailures, []);
  assert.match(result.html, new RegExp(`<img src="${CHART_URL}" alt="a chart"`), result.html);
  // Both halves of the reference: the inline rewrite and the definition line.
  assert.ok(!result.markdown.includes('assets/chart'), result.markdown);
  assert.ok(result.markdown.includes(`[c]: ${CHART_URL}`), result.markdown);
});

/** Parse one body with the features the rewrite itself enables. */
function tree(markdown: string): MdastNode {
  return markdownToMdast(markdown, { features: { wikilinks: true, gfm: true } }) as MdastNode;
}

/** Every image-bearing node in one body, in document order, as the parser reads it. */
function images(markdown: string): { type: 'image' | 'imageReference'; alt: string; title: string | null; url: string }[] {
  const found: { type: 'image' | 'imageReference'; alt: string; title: string | null; url: string }[] = [];
  const walk = (node: MdastNode): void => {
    if (node.type === 'image') {
      found.push({ type: 'image', alt: node.alt ?? '', title: node.title ?? null, url: node.url ?? '' });
    } else if (node.type === 'imageReference') {
      // A reference node carries no title or destination of its own; both live
      // on its definition, which the rewrite reads and the tests inspect there.
      found.push({ type: 'imageReference', alt: node.alt ?? '', title: null, url: '' });
    }
    for (const child of ('children' in node ? node.children : []) as MdastNode[]) walk(child);
  };
  walk(tree(markdown));
  return found;
}

/** Every `definition` node in one body, with its label, destination and title. */
function definitions(markdown: string): { identifier: string; url: string; title: string | null }[] {
  const found: { identifier: string; url: string; title: string | null }[] = [];
  const walk = (node: MdastNode): void => {
    if (node.type === 'definition') {
      found.push({ identifier: node.identifier ?? '', url: node.url ?? '', title: node.title ?? null });
    }
    for (const child of ('children' in node ? node.children : []) as MdastNode[]) walk(child);
  };
  walk(tree(markdown));
  return found;
}

/**
 * One reusable HTML parser for the rendered `alt` and `title`.
 *
 * Both attributes are HTML-escaped by the renderer, so comparing them as bytes
 * would compare the renderer's escaping rather than the text a reader gets.
 * happy-dom is already a runtime dependency (the Mermaid gate), and it is a
 * real HTML parser, so this is not a decoder written to agree with the emitter.
 */
const htmlWindow = new Window();

/**
 * The `alt`, `title` and visible caption each `<img>` carries after the shipped
 * renderer.
 *
 * Goal 0010 promotes a titled standalone image to `figure > img + figcaption`,
 * so the title moves out of the attribute and into the caption's text. These
 * resolver tests are about the title *text* surviving its Markdown round trip,
 * not about where the renderer places it; recording both fields lets them assert
 * the value without pinning one output shape.
 */
function renderedImages(html: string): { alt: string; title: string | null; caption: string | null }[] {
  htmlWindow.document.body.innerHTML = html;
  return [...htmlWindow.document.querySelectorAll('img')].map((image) => ({
    alt: image.getAttribute('alt') ?? '',
    title: image.getAttribute('title'),
    caption: image.closest('figure')?.querySelector('figcaption')?.textContent ?? null,
  }));
}

/**
 * Source spellings and the alt each one decodes to.
 *
 * The rewrite re-emits the **decoded** `alt`, not the source text, so the
 * property these rows assert is: parse the authored image, remember its `alt`,
 * rewrite, parse the result, and get that same `alt` back — plus the renderer's
 * `alt` attribute decoding to it. Written as source rather than generated from
 * `alt`, because a generator would encode this file's belief about escaping and
 * could agree with the bug; the expected value is what the repo's parser says
 * the source means, checked before the rewrite runs.
 *
 * The rows are grouped by the construct the decoded text can accidentally
 * re-open: character references, emphasis and code spans, raw HTML, the label
 * delimiters, backslash runs, GFM strikethrough/tables, control characters, and
 * honest text that must not change. A code-span or emphasis row whose source
 * already lost the markers (for example `![a*b*c]` with no escapes) is kept so
 * the parser fact is visible: its `alt` is already `abc`, and the property is
 * still `abc` after the rewrite.
 */
const LABEL_ROWS: readonly { readonly source: string; readonly alt: string }[] = [
  // Character references: an alt containing entity text must not decode twice.
  { source: '![literal &amp;copy;](assets/chart.png)', alt: 'literal &copy;' },
  { source: '![literal &#169;](assets/chart.png)', alt: 'literal ©' },
  { source: '![literal &amp;#169;](assets/chart.png)', alt: 'literal &#169;' },
  { source: '![literal &amp;amp;](assets/chart.png)', alt: 'literal &amp;' },
  { source: '![bare &](assets/chart.png)', alt: 'bare &' },
  // Emphasis: an author's escapes survive the parser but not a raw re-emit.
  { source: '![a\\*b\\*c](assets/chart.png)', alt: 'a*b*c' },
  { source: '![a*b*c](assets/chart.png)', alt: 'abc' },
  { source: '![\\_\\_x\\_\\_](assets/chart.png)', alt: '__x__' },
  { source: '![snake\\_case](assets/chart.png)', alt: 'snake_case' },
  // Code spans: the delimiters are discarded, so a literal one needs escaping.
  { source: '![tick `x`](assets/chart.png)', alt: 'tick x' },
  { source: '![tick \\`x\\`](assets/chart.png)', alt: 'tick `x`' },
  // Raw HTML and comments, which would be reparsed as markup.
  { source: '![<b>x</b>](assets/chart.png)', alt: '<b>x</b>' },
  { source: '![<!-- c -->](assets/chart.png)', alt: '<!-- c -->' },
  // The label delimiters themselves.
  { source: '![\\[x\\] y](assets/chart.png)', alt: '[x] y' },
  // Backslash runs: round-2 rows, kept green.
  { source: '![mix \\\\\\]](assets/chart.png)', alt: 'mix \\]' },
  { source: '![mix \\\\\\\\\\[ x](assets/chart.png)', alt: 'mix \\\\[ x' },
  { source: '![ends with \\\\](assets/chart.png)', alt: 'ends with \\' },
  // GFM constructs, math and ordinary punctuation.
  { source: '![a | b](assets/chart.png)', alt: 'a | b' },
  { source: '![math $$x$$ here](assets/chart.png)', alt: 'math $$x$$ here' },
  { source: '![wow!](assets/chart.png)', alt: 'wow!' },
  { source: '![~~gone~~](assets/chart.png)', alt: 'gone' },
  { source: '![\\~\\~gone\\~\\~](assets/chart.png)', alt: '~~gone~~' },
  // A non-breaking space is text, not syntax.
  { source: '![a\u00a0b](assets/chart.png)', alt: 'a\u00a0b' },
  // Control characters the parser preserves only when they do not become line
  // structure; a raw newline would let `#` or a blank line break the construct.
  { source: '![a&#10;#b](assets/chart.png)', alt: 'a\n#b' },
  { source: '![a&#10;&#10;b](assets/chart.png)', alt: 'a\n\nb' },
  { source: '![a&#13;b](assets/chart.png)', alt: 'a\rb' },
  // Whitespace at the edges of the label.
  { source: '![  leading and trailing  ](assets/chart.png)', alt: '  leading and trailing  ' },
  // A decoded run of two backslashes before ordinary text: the C4 row. Emitted
  // raw it re-parsed as one, because each pair escapes itself.
  { source: '![\\\\\\\\x](assets/chart.png)', alt: '\\\\x' },
  // A quote is inert in a label but is the title's delimiter; one shared set
  // escapes it in both fields.
  { source: '![a "b" c](assets/chart.png)', alt: 'a "b" c' },
  // Honest labels: the text must reach the reader unchanged.
  { source: '![C++ & C#](assets/chart.png)', alt: 'C++ & C#' },
  { source: '![A & B](assets/chart.png)', alt: 'A & B' },
  { source: '![50%](assets/chart.png)', alt: '50%' },
  { source: '![图 1](assets/chart.png)', alt: '图 1' },
];

/**
 * Title spellings and the title each one decodes to.
 *
 * The title is the second field the rewrite serialises, and it used to carry a
 * second copy of the escaping rule: `&` decoded a second time and whitespace was
 * collapsed and trimmed away. The first two rows are C5; the whitespace rows are
 * the old collapse; the backslash rows are C4 in the title; the rest are inert
 * constructs that must survive as text.
 */
const TITLE_ROWS: readonly { readonly titleSource: string; readonly title: string }[] = [
  { titleSource: 'literal &amp;copy;', title: 'literal &copy;' },
  { titleSource: 'literal &copy;', title: 'literal ©' },
  { titleSource: 'A & B', title: 'A & B' },
  { titleSource: 'a  b', title: 'a  b' },
  { titleSource: ' a ', title: ' a ' },
  { titleSource: 'a\nb', title: 'a\nb' },
  { titleSource: 'a\\\\b', title: 'a\\b' },
  { titleSource: 'a\\\\\\\\b', title: 'a\\\\b' },
  { titleSource: 'ends\\\\', title: 'ends\\' },
  { titleSource: 'a\\"b', title: 'a"b' },
  { titleSource: 'tick `x`', title: 'tick `x`' },
  { titleSource: '~~gone~~', title: '~~gone~~' },
  { titleSource: 'math $$x$$', title: 'math $$x$$' },
  { titleSource: 'Figure 1: overview', title: 'Figure 1: overview' },
  { titleSource: '图 1', title: '图 1' },
];

/** Source spelling for `run` literal backslashes followed by one follower. */
function backslashSource(run: number, follower: string): string {
  const pairs = '\\\\'.repeat(run);
  if (follower === '') return pairs;
  return `${pairs}${follower === 'x' || follower === ' ' ? '' : '\\'}${follower}`;
}

test('every emitted inline image label round-trips to the alt it started from', async () => {
  for (const { source, alt } of LABEL_ROWS) {
    // The fixture is the ground truth: if this row's source no longer parses to
    // the recorded alt, the row is stale and the rest of its assertions would
    // measure something else.
    const authored = images(source);
    assert.equal(authored.length, 1, `${JSON.stringify(source)}: the fixture is not one image`);
    assert.equal(authored[0]!.alt, alt, `${JSON.stringify(source)}: the source no longer decodes to the recorded alt`);
    assert.equal(authored[0]!.title, null, `${JSON.stringify(source)}: the fixture grew a title`);

    const result = await run(`${source}\n`);
    const parsed = images(result.markdown);
    assert.equal(parsed.length, 1, `${JSON.stringify(source)}: not one image after rewrite: ${result.markdown}`);
    assert.equal(parsed[0]!.alt, alt, `${JSON.stringify(source)}: the rewritten alt changed: ${result.markdown}`);
    assert.equal(parsed[0]!.title, authored[0]!.title, `${JSON.stringify(source)}: the rewritten title changed: ${result.markdown}`);
    assert.equal(parsed[0]!.url, CHART_URL, `${JSON.stringify(source)}: wrong destination`);
    assert.deepEqual(
      renderedImages(result.html),
      [{ alt, title: authored[0]!.title, caption: null }],
      `${JSON.stringify(source)}: the rendered attributes changed: ${result.html}`,
    );
    assert.ok(!result.html.includes('!['), `${JSON.stringify(source)}: literal Markdown reached the page: ${result.html}`);
  }
});

test('every emitted reference-style image label round-trips and its definition label survives', async () => {
  for (const { source, alt } of LABEL_ROWS) {
    const reference = source.replace('](assets/chart.png)', '][c]');
    const authored = images(`See ${reference} here.\n\n[c]: assets/chart.png\n`);
    assert.equal(authored.length, 1, `${JSON.stringify(reference)}: the fixture is not one image`);
    assert.equal(authored[0]!.type, 'imageReference', `${JSON.stringify(reference)}: not a reference`);
    assert.equal(authored[0]!.alt, alt, `${JSON.stringify(reference)}: the source no longer decodes to the recorded alt`);

    const result = await run(`See ${reference} here.\n\n[c]: assets/chart.png\n`);
    const parsed = images(result.markdown);
    assert.equal(parsed.length, 1, `${JSON.stringify(reference)}: not one image after rewrite: ${result.markdown}`);
    assert.equal(parsed[0]!.alt, alt, `${JSON.stringify(reference)}: the rewritten alt changed: ${result.markdown}`);
    assert.equal(parsed[0]!.title, authored[0]!.title, `${JSON.stringify(reference)}: the rewritten title changed: ${result.markdown}`);
    assert.equal(parsed[0]!.url, CHART_URL, `${JSON.stringify(reference)}: wrong destination`);
    assert.deepEqual(
      renderedImages(result.html),
      [{ alt, title: authored[0]!.title, caption: null }],
      `${JSON.stringify(reference)}: the rendered attributes changed: ${result.html}`,
    );
    // The reference is rewritten inline and only the definition's destination
    // moves: the `[c]` label is byte-untouched and still parses as identifier
    // `c`, so a later reference to it would bind to the asset. The definition
    // is unused after the inline rewrite, so its title is dropped with the old
    // destination; the title that renders is the one on the inline image.
    assert.deepEqual(
      definitions(result.markdown),
      [{ identifier: 'c', url: CHART_URL, title: null }],
      `${JSON.stringify(reference)}: the definition label or destination changed: ${result.markdown}`,
    );
    assert.ok(result.markdown.includes(`[c]: ${CHART_URL}`), `${JSON.stringify(reference)}: ${result.markdown}`);
    assert.ok(!result.markdown.includes('assets/chart'), `${JSON.stringify(reference)}: the source path survived`);
    assert.ok(!result.html.includes('!['), `${JSON.stringify(reference)}: literal Markdown reached the page: ${result.html}`);
  }
});

test('every emitted inline image title round-trips to the title it started from', async () => {
  for (const { titleSource, title } of TITLE_ROWS) {
    const source = `![x](assets/chart.png "${titleSource}")`;
    const authored = images(source);
    assert.equal(authored.length, 1, `${JSON.stringify(source)}: the fixture is not one image`);
    assert.equal(authored[0]!.title, title, `${JSON.stringify(source)}: the source no longer decodes to the recorded title`);

    const result = await run(`${source}\n`);
    const parsed = images(result.markdown);
    assert.equal(parsed.length, 1, `${JSON.stringify(source)}: not one image after rewrite: ${result.markdown}`);
    assert.equal(parsed[0]!.alt, 'x', `${JSON.stringify(source)}: the alt changed: ${result.markdown}`);
    assert.equal(parsed[0]!.title, title, `${JSON.stringify(source)}: the rewritten title changed: ${result.markdown}`);
    assert.equal(parsed[0]!.url, CHART_URL, `${JSON.stringify(source)}: wrong destination`);
    assert.deepEqual(
      renderedImages(result.html),
      [{ alt: 'x', title: null, caption: title }],
      `${JSON.stringify(source)}: the rendered title changed: ${result.html}`,
    );
  }
});

test('every emitted reference-style image title round-trips and the definition label survives', async () => {
  for (const { titleSource, title } of TITLE_ROWS) {
    const source = `See ![x][c] here.\n\n[c]: assets/chart.png "${titleSource}"\n`;
    assert.deepEqual(
      definitions(source),
      [{ identifier: 'c', url: 'assets/chart.png', title }],
      `${JSON.stringify(titleSource)}: the fixture definition no longer decodes to the recorded title`,
    );

    const result = await run(source);
    const parsed = images(result.markdown);
    assert.equal(parsed.length, 1, `${JSON.stringify(titleSource)}: not one image after rewrite: ${result.markdown}`);
    assert.equal(parsed[0]!.alt, 'x', `${JSON.stringify(titleSource)}: the alt changed: ${result.markdown}`);
    assert.equal(parsed[0]!.title, title, `${JSON.stringify(titleSource)}: the rewritten title changed: ${result.markdown}`);
    assert.equal(parsed[0]!.url, CHART_URL, `${JSON.stringify(titleSource)}: wrong destination`);
    assert.deepEqual(
      renderedImages(result.html),
      [{ alt: 'x', title, caption: null }],
      `${JSON.stringify(titleSource)}: the rendered title changed: ${result.html}`,
    );
    // The definition label is untouched; its old destination and title are
    // replaced because the reference is now inline and the definition is unused.
    assert.deepEqual(
      definitions(result.markdown),
      [{ identifier: 'c', url: CHART_URL, title: null }],
      `${JSON.stringify(titleSource)}: the definition changed: ${result.markdown}`,
    );
    assert.ok(!result.markdown.includes('assets/chart'), `${JSON.stringify(titleSource)}: the source path survived`);
  }
});

/**
 * Followers for the generated backslash matrix: a letter, a space, ASCII
 * punctuation, both label delimiters, another construct character, and the end
 * of the text. Each row is encoded independently with CommonMark's own escape
 * rules and checked against the parser before the rewrite runs, so the matrix
 * does not share the serializer's belief.
 */
const MATRIX_FOLLOWERS = ['x', ' ', '.', '[', ']', '*', ''] as const;

test('a generated 1–5 backslash matrix round-trips in both fields and both shapes', async () => {
  for (let slashes = 1; slashes <= 5; slashes += 1) {
    for (const follower of MATRIX_FOLLOWERS) {
      const text = '\\'.repeat(slashes) + follower;
      const spelling = backslashSource(slashes, follower);
      const what = `${slashes} backslash(es), follower ${JSON.stringify(follower)}`;

      // Label, inline.
      const inlineLabel = `![${spelling}](assets/chart.png)`;
      let authored = images(inlineLabel);
      assert.equal(authored.length, 1, `${what}: inline label fixture is not one image: ${inlineLabel}`);
      assert.equal(authored[0]!.alt, text, `${what}: inline label fixture alt: ${inlineLabel}`);
      let result = await run(`${inlineLabel}\n`);
      let parsed = images(result.markdown);
      assert.equal(parsed.length, 1, `${what}: inline label: ${result.markdown}`);
      assert.equal(parsed[0]!.alt, text, `${what}: inline label: ${result.markdown}`);
      assert.equal(parsed[0]!.title, null, `${what}: inline label grew a title`);
      assert.deepEqual(
        renderedImages(result.html),
        [{ alt: text, title: null, caption: null }],
        `${what}: inline label rendered: ${result.html}`,
      );

      // Label, reference-style.
      const referenceLabel = `![${spelling}][c]\n\n[c]: assets/chart.png\n`;
      authored = images(referenceLabel);
      assert.equal(authored.length, 1, `${what}: reference label fixture is not one image: ${referenceLabel}`);
      assert.equal(authored[0]!.type, 'imageReference', `${what}: reference label fixture is not a reference`);
      assert.equal(authored[0]!.alt, text, `${what}: reference label fixture alt: ${referenceLabel}`);
      result = await run(referenceLabel);
      parsed = images(result.markdown);
      assert.equal(parsed.length, 1, `${what}: reference label: ${result.markdown}`);
      assert.equal(parsed[0]!.alt, text, `${what}: reference label: ${result.markdown}`);
      assert.equal(parsed[0]!.title, null, `${what}: reference label grew a title`);
      assert.deepEqual(
        renderedImages(result.html),
        [{ alt: text, title: null, caption: null }],
        `${what}: reference label rendered: ${result.html}`,
      );

      // Title, inline.
      const inlineTitleSource = `![x](assets/chart.png "${spelling}")`;
      authored = images(inlineTitleSource);
      assert.equal(authored.length, 1, `${what}: inline title fixture is not one image: ${inlineTitleSource}`);
      assert.equal(authored[0]!.title, text, `${what}: inline title fixture: ${inlineTitleSource}`);
      result = await run(`${inlineTitleSource}\n`);
      parsed = images(result.markdown);
      assert.equal(parsed.length, 1, `${what}: inline title: ${result.markdown}`);
      assert.equal(parsed[0]!.alt, 'x', `${what}: inline title alt: ${result.markdown}`);
      assert.equal(parsed[0]!.title, text, `${what}: inline title: ${result.markdown}`);
      assert.deepEqual(
        renderedImages(result.html),
        [{ alt: 'x', title: null, caption: text }],
        `${what}: inline title rendered: ${result.html}`,
      );

      // Title, reference-style.
      const referenceTitle = `![x][c]\n\n[c]: assets/chart.png "${spelling}"\n`;
      assert.deepEqual(
        definitions(referenceTitle),
        [{ identifier: 'c', url: 'assets/chart.png', title: text }],
        `${what}: reference title fixture: ${referenceTitle}`,
      );
      result = await run(referenceTitle);
      parsed = images(result.markdown);
      assert.equal(parsed.length, 1, `${what}: reference title: ${result.markdown}`);
      assert.equal(parsed[0]!.alt, 'x', `${what}: reference title alt: ${result.markdown}`);
      assert.equal(parsed[0]!.title, text, `${what}: reference title: ${result.markdown}`);
      assert.deepEqual(
        renderedImages(result.html),
        [{ alt: 'x', title: null, caption: text }],
        `${what}: reference title rendered: ${result.html}`,
      );
    }
  }
});

test('an honest image label emits readable source and the same rendered alt', async () => {
  // No visual regression: the serialiser is allowed to add backslashes to the
  // *source* only where a construct would otherwise consume the character, and
  // a reader must never see one in the alt text.
  for (const [label, emitted] of [
    ['A & B', 'A \\& B'],
    ['C++', 'C++'],
    ['50%', '50%'],
    ['图 1', '图 1'],
  ] as const) {
    const result = await run(`![${label}](assets/chart.png)\n`);
    assert.ok(result.markdown.includes(`![${emitted}](${CHART_URL})`), `${label}: emitted ${result.markdown}`);
    assert.deepEqual(renderedImages(result.html), [{ alt: label, title: null, caption: null }], `${label}: ${result.html}`);
    assert.ok(!renderedImages(result.html)[0]!.alt.includes('\\'), `${label}: a backslash reached the reader`);
  }
});

test('an honest image title emits readable source and the same rendered title', async () => {
  // Same no-visual-regression rule for the title path. `&` is the one honest
  // character the shared rule escapes (it can begin a character reference);
  // everything else here is emitted unchanged.
  for (const [title, emitted] of [
    ['Figure 1: overview', 'Figure 1: overview'],
    ['A & B', 'A \\& B'],
    ['C++', 'C++'],
    ['50%', '50%'],
    ['图 1', '图 1'],
  ] as const) {
    const result = await run(`![x](assets/chart.png "${title}")\n`);
    assert.ok(result.markdown.includes(`"${emitted}"`), `${title}: emitted ${result.markdown}`);
    assert.deepEqual(renderedImages(result.html), [{ alt: 'x', title: null, caption: title }], `${title}: ${result.html}`);
    assert.ok(!renderedImages(result.html)[0]!.caption!.includes('\\'), `${title}: a backslash reached the reader`);
  }
});

test('an image label inside a table cell keeps the cell and its alt', async () => {
  // The paragraph rows above would pass even if `|` were left raw, because a
  // pipe is ordinary text outside a table. Inside one it is the cell separator:
  // measured with a raw re-emit, the cell ended at the pipe and the page carried
  // the text `![a` with no image at all.
  const result = await run('| head |\n| --- |\n| ![a \\| b](assets/chart.png) |\n');
  assert.ok(result.markdown.includes('![a \\| b]('), result.markdown);
  const parsed = images(result.markdown);
  assert.equal(parsed.length, 1, `the rewritten table lost its image: ${result.markdown}`);
  assert.equal(parsed[0]!.alt, 'a | b', result.markdown);
  assert.deepEqual(renderedImages(result.html), [{ alt: 'a | b', title: null, caption: null }], result.html);
  assert.equal((result.html.match(/<td>/g) ?? []).length, 1, `the cell split: ${result.html}`);
  assert.equal((result.html.match(/<img\b/g) ?? []).length, 1, `the image vanished: ${result.html}`);
});

test('a failed image label with backslashes or syntax characters degrades to text', async () => {
  // The caller stops the build on `mediaFailures`, but the returned body still
  // has to be self-consistent: escaping it with the image rule must produce
  // ordinary text, never something that later parses as an image or as markup.
  for (const source of [
    '![ends with \\\\](missing.png)',
    '![a \\] b](missing.png)',
    '![literal &amp;copy;](missing.png)',
    '![a\\*b\\*c](missing.png)',
    '![<b>x</b>](missing.png)',
  ]) {
    const result = await run(`${source}\n`);
    const alt = images(source)[0]!.alt;
    assert.equal(result.mediaFailures.length, 1, `${JSON.stringify(source)}: the failure was not recorded`);
    assert.equal(images(result.markdown).length, 0, `${JSON.stringify(source)}: a degraded label still parses as an image: ${result.markdown}`);
    assert.ok(!result.markdown.includes('!['), `${JSON.stringify(source)}: ${result.markdown}`);
    assert.ok(!result.html.includes('<img'), `${JSON.stringify(source)}: a failed image rendered an element: ${result.html}`);
    // The degraded text is the same words, not a Markdown construct.
    htmlWindow.document.body.innerHTML = result.html;
    assert.equal(htmlWindow.document.body.textContent?.trim(), alt, `${JSON.stringify(source)}: ${result.html}`);
  }
});

/**
 * Raw-HTML `src` values and the one answer both sides must give for them.
 *
 * `expected` is the shared classifier's answer; `rendered` is what the renderer
 * does with the element: `kept` (the sanitizer preserves the src), `stripped`
 * (the renderer treats it as non-local and the sanitizer removes the attribute,
 * existing behaviour), or `refused` (the renderer's published-asset check
 * throws because the value is local). The producer refuses every non-remote
 * value before the renderer sees it in a real build.
 */
const RAW_IMAGE_ROWS: readonly {
  readonly name: string;
  readonly src: string;
  readonly expected: 'remote' | 'refused' | 'local';
  readonly rendered: 'kept' | 'stripped' | 'refused';
}[] = [
  { name: 'leading space', src: ' https://example.test/pic.png', expected: 'remote', rendered: 'kept' },
  { name: 'leading tab', src: '\thttps://example.test/pic.png', expected: 'remote', rendered: 'kept' },
  { name: 'leading newline', src: '\nhttps://example.test/pic.png', expected: 'remote', rendered: 'kept' },
  { name: 'all whitespace', src: '   ', expected: 'local', rendered: 'refused' },
  { name: 'protocol-relative', src: '//host.example/x.png', expected: 'remote', rendered: 'stripped' },
  { name: 'backslash-relative', src: '\\\\host.example\\x.png', expected: 'remote', rendered: 'stripped' },
  { name: 'uppercase scheme', src: 'HTTPS://HOST.EXAMPLE/X.PNG', expected: 'remote', rendered: 'kept' },
  { name: 'tab-split javascript', src: 'java\tscript:alert(1)', expected: 'refused', rendered: 'stripped' },
  { name: 'file', src: 'file:///etc/passwd', expected: 'refused', rendered: 'stripped' },
  { name: 'vbscript', src: 'vbscript:msgbox(1)', expected: 'refused', rendered: 'stripped' },
  { name: 'bare relative', src: 'pic.png', expected: 'local', rendered: 'refused' },
  { name: 'data raster', src: 'data:image/png;base64,iVBORw0KGgo=', expected: 'remote', rendered: 'kept' },
];

test('the producer and renderer classify raw image sources with one predicate', async () => {
  for (const row of RAW_IMAGE_ROWS) {
    assert.equal(classifyImageSource(row.src), row.expected, `${row.name}: shared classifier`);
    const body = `<img src="${row.src}" alt="probe">\n`;
    const result = await resolveLinksIn(body, 'src.md', indexCorpus([{ path: 'src.md', slug: 'src' }]), 'src', (slug) => `/${slug}/`, publisher);
    const failures = result.mediaFailures.map((failure) => failure.reason);
    if (row.expected === 'remote') {
      assert.deepEqual(failures, [], `${row.name}: the producer refused a remote source`);
    } else {
      assert.deepEqual(failures, ['html-form'], `${row.name}: the producer did not report the source`);
    }

    if (row.rendered === 'refused') {
      await assert.rejects(
        renderMarkdown(body, { publishedAssets: new Set() }),
        /without being published/,
        `${row.name}: the renderer accepted a local source`,
      );
      continue;
    }
    const { html } = await renderMarkdown(body, { publishedAssets: new Set() });
    if (row.rendered === 'kept') {
      assert.match(html, /\ssrc=/, `${row.name}: the renderer dropped a kept src: ${html}`);
    } else {
      // Existing sanitizer policy: protocol-relative and refused schemes are
      // non-local here, so the membership check is skipped and the sanitizer
      // removes the attribute exactly as it did before this fix.
      assert.doesNotMatch(html, /\ssrc=/, `${row.name}: the renderer kept a stripped src: ${html}`);
    }
    if (row.name === 'leading space') {
      assert.ok(html.includes('src=" https://example.test/pic.png"'), `the exact src was not kept: ${html}`);
    }
  }

  // An `<img>` with no src keeps its current split treatment: the producer
  // reports the form, the renderer leaves the element without a src attribute.
  const noSrc = await resolveLinksIn('<img alt="probe">\n', 'src.md', indexCorpus([{ path: 'src.md', slug: 'src' }]), 'src', (slug) => `/${slug}/`, publisher);
  assert.deepEqual(noSrc.mediaFailures.map((failure) => failure.reason), ['html-form'], 'an img with no src was accepted');
  const renderedNoSrc = await renderMarkdown('<img alt="probe">\n', { publishedAssets: new Set() });
  assert.doesNotMatch(renderedNoSrc.html, /\ssrc=/, renderedNoSrc.html);
});

test('a badge image inside a link keeps the image and the anchor', async () => {
  const result = await run('Badge [![chart][c]](notes/beta.md) end.\n\n[c]: assets/chart.png\n');
  assert.deepEqual(hrefs(result.html), ['/notes-beta/'], result.html);
  assert.match(result.html, new RegExp(`<a href="/notes-beta/"><img src="${CHART_URL}" alt="chart"`), result.html);
  assert.deepEqual(result.outgoing, ['notes-beta']);
  assert.ok(!result.html.includes('assets/chart'), result.html);
});

test('a reference to a missing target renders as text, not an anchor', async () => {
  const result = await run('See [**gone** thing][g] here.\n\n[g]: nowhere.md\n');
  assert.deepEqual(hrefs(result.html), [], result.html);
  assert.match(result.html, /<p>See <strong>gone<\/strong> thing here\.<\/p>/);
  assert.deepEqual(result.outgoing, []);
  assert.deepEqual(result.findings.map((finding) => finding.outcome), ['unresolved']);
});

test('an unused definition contributes no edge and renders nothing', async () => {
  // An edge exists iff a rendered anchor to its target does. A definition by
  // itself renders nothing, so it may not make one.
  const result = await run('No references here.\n\n[b]: notes/beta.md\n[x]: drafts/secret%20plan.md\n');
  assert.deepEqual(hrefs(result.html), [], result.html);
  assert.deepEqual(result.outgoing, []);
  assert.deepEqual(result.findings, []);
  assert.ok(!result.markdown.includes('drafts/secret'), 'an unused withheld definition kept its path');
});

test('an external definition is left byte-for-byte', async () => {
  const body = 'See [e][x] and ![i][y].\n\n[x]: https://example.invalid/page "T"\n[y]: https://img.invalid/a.png\n';
  const result = await run(body);
  assert.equal(result.markdown, body);
  assert.deepEqual(result.outgoing, []);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(hrefs(result.html), ['https://example.invalid/page'], result.html);
});

test('a reference to the note itself renders but makes no self-edge', async () => {
  const result = await run('See [top][me] and [again][me].\n\n[me]: src.md#Top\n');
  assert.deepEqual(hrefs(result.html), ['/src/#top', '/src/#top'], result.html);
  assert.deepEqual(result.outgoing, []);
});
