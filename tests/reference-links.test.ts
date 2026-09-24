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
import { resolveLinksIn } from '../scripts/resolve-links.ts';
import { renderMarkdown } from '../src/lib/markdown.ts';

const CORPUS: readonly CorpusFile[] = [
  { path: 'src.md', slug: 'src' },
  { path: 'notes/beta.md', slug: 'notes-beta' },
  { path: 'drafts/secret plan.md', slug: undefined },
  { path: 'assets/chart.png', slug: undefined },
];

/** Resolve one body written as `src.md`, then render what it became. */
async function run(body: string) {
  const result = resolveLinksIn(body, 'src.md', indexCorpus(CORPUS), 'src', (slug) => `/${slug}/`);
  const { html } = await renderMarkdown(result.markdown);
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
  for (const [body, label, what] of [
    ['See [my plan][x] here.\n\n[x]: drafts/secret%20plan.md\n', 'my plan', 'a link reference'],
    ['See ![a chart][c] here.\n\n[c]: assets/chart.png\n', 'a chart', 'an image reference'],
  ] as const) {
    const result = await run(body);
    assert.deepEqual(hrefs(result.html), [WITHHELD_ROUTE], `${what}: ${result.html}`);
    assert.match(result.html, new RegExp(`<a href="${WITHHELD_ROUTE}">${label}</a>`), what);
    assert.deepEqual(result.outgoing, [], `${what}: a withheld target made an edge`);
    assert.deepEqual(
      result.findings.map((finding) => finding.outcome),
      ['unpublished'],
      `${what}: not reported as withheld`,
    );
    // The withheld destination reaches neither the rendered page nor the body
    // handed onward — the definition line is rewritten too.
    for (const path of ['drafts/secret', 'secret%20plan', 'assets/chart']) {
      assert.ok(!result.markdown.includes(path), `${what}: ${path} survived in the body`);
      assert.ok(!result.html.includes(path), `${what}: ${path} survived in the page`);
    }
  }
});

test('a withheld image reference inside a link stays text rather than nesting an anchor', async () => {
  const result = await run('Badge [![chart][c]](notes/beta.md) end.\n\n[c]: assets/chart.png\n');
  assert.deepEqual(hrefs(result.html), ['/notes-beta/'], result.html);
  assert.match(result.html, /<a href="\/notes-beta\/">chart<\/a>/);
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
