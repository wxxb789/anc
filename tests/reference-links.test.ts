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

import { indexCorpus, type CorpusFile } from '../src/lib/link-resolution.ts';
import { WITHHELD_ROUTE } from '../src/lib/route-path.ts';
import { resolveImageTarget, type ImagePublisher } from '../src/lib/media.ts';
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
  publish({ notePath, target, isWikilink }) {
    const resolved = resolveImageTarget(target, notePath, (path) => (path === 'assets/chart.png' ? path : undefined), isWikilink);
    if (resolved.kind === 'external') return { kind: 'external' };
    if (resolved.kind !== 'local') return { kind: 'failed', reason: resolved.kind };
    return { kind: 'published', url: CHART_URL };
  },
};

/** Resolve one body written as `src.md`, then render what it became. */
async function run(body: string) {
  const result = resolveLinksIn(body, 'src.md', indexCorpus(CORPUS), 'src', (slug) => `/${slug}/`, publisher);
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
