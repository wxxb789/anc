/**
 * One walk of one note's Markdown, producing its rewritten body and its edges
 * from the same values.
 *
 * ## Why this is one function and not two passes
 *
 * `outgoing` and the hrefs a reader clicks are the same fact stated twice, and
 * two passes are how the two statements drift. The producer this replaces
 * derived `outgoing` from wikilinks only, so
 * `{markdown: 'See [B](/b/).', outgoing: []}` was a valid entry: a live anchor
 * on the page, no backlink on B, and no gate anywhere that could see the
 * disagreement — `checkCorpus` proves `backlinks` is the exact inverse of
 * `outgoing`, which says nothing at all about the page.
 *
 * So each `link` and `image` node is resolved **exactly once**, and that single
 * {@link LinkResolution} does both jobs: it decides the text written back into
 * the body, and, when it resolved to a published note, it appends to `outgoing`.
 * The two cannot disagree because one value produced both. That is a property of
 * the shape rather than of a test — there is no second source for either.
 *
 * ## Why the body is edited by source span rather than re-serialized
 *
 * The obvious alternative is to mutate `node.url` and stringify the tree back to
 * Markdown, and it is wrong here for a reason that is not about effort:
 * serializing an mdast tree normalises everything it touches — emphasis markers,
 * list bullets, escaping, hard breaks, table padding — so every note in a user's
 * repository would come back subtly rewritten, and the diff between what they
 * wrote and what was published would be full of changes nobody made. It also
 * needs a serializer this package does not have.
 *
 * Editing spans keeps every byte the walk did not decide to change. satteri's
 * node positions are offsets into the exact string handed to the parser —
 * measured: `input.slice(node.position.start.offset, node.position.end.offset)`
 * round-trips to the link's own source text, for wikilinks, Markdown links,
 * images, and CJK bodies alike — and the edits are applied last-to-first so an
 * earlier replacement cannot move a later offset.
 *
 * ## Fence-blindness is unrepresentable rather than tested away
 *
 * The producer this replaces ran a regex over raw Markdown, so a note
 * *documenting* wikilink syntax had the links inside its own code fences
 * rewritten and a phantom edge injected into `outgoing` — which `checkCorpus`
 * then proved symmetric and passed. Here the walk visits `link` and `image`
 * nodes; a `[[X]]` inside a fence is a `code` node and inside backticks is an
 * `inlineCode` node, and neither is in the set the walk visits. There is no
 * branch to get wrong.
 */

import { markdownToMdast, type MdastNode } from 'satteri';
import { resolveLink, type LinkIndex } from '../src/lib/link-resolution.ts';
import type { LinkFindingRow } from './write-report.ts';

/** What one note's traversal produced. */
export interface TraversalResult {
  /** The body with every internal link rewritten. Every other byte unchanged. */
  readonly markdown: string;
  /** Published slugs this note links to, deduplicated, in document order. */
  readonly outgoing: readonly string[];
  /** Everything the report needs from this note. */
  readonly findings: readonly LinkFindingRow[];
}

/** One span of the source to replace, and what to replace it with. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Every `link` and `image` node, in document order, including nested ones.
 *
 * **Nesting is real and both halves of it matter.** `[![logo](logo.png)](index.md)`
 * — the badge idiom every README opens with — is an image inside a link, and
 * the two spans overlap. An early draft edited both as whole-node replacements
 * and threw; the draft after that stopped visiting the inner node at all, and
 * that traded a build failure for a leak. Measured: with `private/chart.png`
 * excluded, the standalone `![chart](private/chart.png)` correctly degraded to
 * `chart` while the nested form shipped `[![chart](private/chart.png)](/index/)`
 * — the excluded folder, in the published body.
 *
 * So every node is visited, resolved, and edited. What makes that safe is that
 * an outer link is rewritten as **two edits around its label** rather than one
 * over its whole span (see {@link labelSpan}), so the region a nested node
 * writes into is one neither edit touches.
 */
function collectLinkNodes(node: MdastNode, into: MdastNode[]): void {
  if (node.type === 'link' || node.type === 'image') into.push(node);
  for (const child of ('children' in node ? node.children : []) as MdastNode[]) {
    collectLinkNodes(child, into);
  }
}

/**
 * The display text a degraded link leaves behind.
 *
 * An `unresolved` or `unpublished` link is not rendered as an anchor — a live
 * anchor to nothing is a lie to the reader, and for `unpublished` the target
 * path is exactly the string the privacy model exists to keep out of the
 * artifact. What remains is what the author wrote for a human to read.
 *
 * Taken from the node's own child span rather than reconstructed, so inline
 * markup inside the label survives: `[**bold** text](gone.md)` degrades to
 * `**bold** text` and not to `bold text`. A wikilink with no display text has
 * its target as its label, which is what the parser gives and what a reader
 * would have seen.
 *
 * An image degrades to its alt text, which is the same rule applied to the
 * field images carry it in. An empty label degrades to nothing at all: `[](x)`
 * had nothing for a reader in the first place.
 */
function displayText(node: MdastNode, source: string): string {
  if (node.type === 'image') return node.alt ?? '';
  const children = 'children' in node ? node.children : [];
  const first = spanOf(children[0] as MdastNode | undefined);
  const last = spanOf(children.at(-1) as MdastNode | undefined);
  if (first === undefined || last === undefined) return '';
  return source.slice(first.start, last.end);
}

/**
 * The span a node's label occupies in the source, or `undefined` if it has none.
 *
 * The label is a **separate editable region** from the node itself, and that is
 * what makes a nested link safe to rewrite without deleting anything. Measured:
 * `[![logo](assets/logo.png)](index.md)` has the outer link at `[0,36)` and its
 * label — the image — at `[1,25)`; the two do not overlap once the outer node's
 * edit is split into "before the label" and "after the label".
 *
 * Without this, an outer link containing an unpublished image had two possible
 * treatments and both were wrong: rewrite the outer node whole and ship the
 * excluded path inside the anchor text, or drop the outer node whole and delete
 * prose the author wrote. Editing the label separately is the third option, and
 * it is the one that keeps both properties.
 */
function labelSpan(node: MdastNode): { start: number; end: number } | undefined {
  const children = 'children' in node ? node.children : [];
  const first = spanOf(children[0] as MdastNode | undefined);
  const last = spanOf(children.at(-1) as MdastNode | undefined);
  return first === undefined || last === undefined
    ? undefined
    : { start: first.start, end: last.end };
}

/**
 * A label safe to place inside `[…]`, with the two delimiters escaped.
 *
 * Text taken from one construct and written into another has to be re-escaped
 * for the construct it lands in, and this is the one place that happens: a
 * wikilink's display half and an image's `alt` are *not* link-label syntax, so
 * a `[` or `]` inside either is ordinary text there and a delimiter here.
 * Measured, all three from the same defect:
 *
 * ```
 * ![[t|before ] after]]  ->  [before ] after](/t/)     the link ends early
 * [![[a.png]]](t.md)     ->  [[](t.md)](/t/)           and the rest is prose
 * ```
 *
 * The second is the parser's own reading of an embed inside a link — it hands
 * back one image whose `alt` is `](t.md)` — and it is not a shape worth
 * special-casing, because escaping the delimiters fixes it and every other
 * spelling at once.
 *
 * Only `[` and `]`. A `(` or `)` in a label is harmless — the parser closes the
 * label at the `]` before the destination begins — and escaping more than the
 * two characters that can break the construct would put visible backslashes
 * into a reader's text.
 */
function escapeLabel(text: string): string {
  return text.replace(/[[\]]/g, (character) => `\\${character}`);
}

/**
 * The text a link to a **withheld** file degrades to.
 *
 * Plan §2.5: "the link's **display text only**, as plain text. The resolved path
 * never enters `markdown`." An authored label is ordinarily exactly that — a
 * string the author chose to publish — so the rule is not "shorten every label".
 * It is: **no part of the withheld path survives**, whatever produced the label.
 *
 * **Decided against the resolved path, never against the source syntax**, and
 * that is the whole of this function's history. A first version asked "did the
 * author write a label?" by reconstructing `[[…]]` from the label and comparing
 * against the source. It worked for the case it was written for and left two
 * spellings leaking, both measured:
 *
 * ```
 * [[drafts/secret plan|drafts/secret plan]]     -> "drafts/secret plan"
 * [drafts/secret plan](drafts/secret%20plan.md) -> "drafts/secret plan"
 * ```
 *
 * Both have an authored label, so the "an authored label is untouched"
 * exemption swallowed them — and the label happened to *be* the withheld path.
 * A privacy decision made by reconstructing input syntax will keep having
 * spellings nobody enumerated, and each one is a silent leak in a published
 * body. Comparing against the path the resolver actually found has no such
 * spellings: there is one path, and either the label discloses it or it does
 * not.
 *
 * What survives is the target's last segment — the name a reader would
 * recognise — with the directories removed, because the folder path is the part
 * that says *where in the user's tree* the withheld note lives. Where the label
 * merely *contains* the path, only that substring is reduced; the author's own
 * surrounding words are theirs and are kept.
 *
 * A subpath goes with it. It names a heading inside a note that was not
 * published, and there is nothing on this site for it to mean.
 */
function withheldLabel(label: string, path: string): string {
  // Every spelling the same file can be named by, longest first so a full path
  // is reduced before its own stem matches inside it. A wikilink writes the raw
  // form and usually without the extension; a Markdown href arrives
  // percent-encoded and usually with it.
  const stem = path.replace(/\.[^./]+$/, '');
  // The `/`-anchored spellings too. A link may be written `[[/drafts/x]]` — the
  // strict root anchor tier 4 documents — and reducing only the unanchored form
  // left `/secret plan`, a leading slash with a directory's worth of meaning
  // stripped out but its shape still announcing that one was there.
  const spellings = [path, stem, `/${path}`, `/${stem}`, encodeURI(path), encodeURI(stem)]
    .filter((form, index, all) => all.indexOf(form) === index)
    .sort((a, b) => b.length - a.length);

  // The **file's own name**, extension included. `a.png` reduces to `a.png` and
  // not to `a`: the extension is part of what a reader recognises, and it is
  // not the disclosing part — the directories are. `drafts/secret plan.md`
  // reduces to `secret plan.md`, which says a note exists and not where in the
  // user's tree it lives.
  const name = basename(path);
  let text = label;
  for (const spelling of spellings) {
    // The stem's replacement keeps whatever followed it, so `secret plan` inside
    // `drafts/secret plan.md` does not lose the `.md` a longer spelling already
    // handled.
    const replacement = spelling === stem || spelling === `/${stem}` ? basename(stem) : name;
    text = text.split(spelling).join(replacement);
  }

  // The subpath the target carried, if the label kept one — `note#Heading`
  // reduces to `note`, because the heading is inside a note nobody can read.
  return text.split('#')[0] ?? text;
}

/** POSIX basename, on the `/`-joined relative paths the walk produces. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Whether a node was written as a wikilink, decided from its own source span.
 *
 * The parser produces the identical node type for both syntaxes, so this is the
 * only place the distinction survives — and it matters twice: a wikilink is not
 * percent-encoded, so decoding one would corrupt a `%` an author typed, and the
 * rewritten text has to be the syntax the author used.
 *
 * Read from the source rather than inferred from the url, because a Markdown
 * link and a wikilink can carry byte-identical urls.
 */
function isWikilinkNode(node: MdastNode, source: string): boolean {
  const span = spanOf(node);
  if (span === undefined) return false;
  const text = source.slice(span.start, span.end);
  return text.startsWith('[[') || text.startsWith('![[');
}

/**
 * Replace spans, last first, refusing any overlap.
 *
 * Last-first so an earlier replacement cannot shift a later offset.
 *
 * **The overlap check no longer has a cause anyone can name, and that is the
 * point of keeping it.** It used to: a link containing an image yielded two
 * whole-node replacements over nested spans, and this threw — which meant a
 * repository containing a README badge could not build. That is fixed at the
 * source, by writing each rewrite as the two regions *around* a node's label
 * rather than over it, so nothing this module emits overlaps.
 *
 * What remains is an invariant with no known way to violate it, kept because
 * the cost of being wrong is asymmetric: a silent overlap splices one
 * replacement into text another already replaced, and ships a body that is
 * neither of the two things it was built from. A build that stops is
 * recoverable; a published note nobody can trace back to its source is not.
 */
function applyEdits(source: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let result = source;
  let boundary = source.length;
  for (const edit of ordered) {
    if (edit.end > boundary) {
      throw new Error(
        'two link nodes claimed overlapping source spans, so the rewritten body would be ' +
          'neither. Every rewrite is written around a node label rather than over it, so no ' +
          'input should reach this — the note that did is worth reporting.',
      );
    }
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    boundary = edit.start;
  }
  return result;
}

/**
 * A node's source span and its line, or `undefined` if the parser gave none.
 *
 * `offset` is **optional** in unist — `line` and `column` are the required pair
 * — so the three values are narrowed together here rather than asserted at four
 * call sites. Every construct measured against the installed parser carries
 * one; a parser that did not, and a fabricated `0`, would splice a replacement
 * at the top of the document instead of at the link.
 */
function spanOf(node: MdastNode | undefined): { start: number; end: number; line: number } | undefined {
  const position = node?.position;
  if (position === undefined) return undefined;
  const { start, end } = position;
  if (start.offset === undefined || end.offset === undefined) return undefined;
  return { start: start.offset, end: end.offset, line: start.line };
}

/**
 * Resolve every link in one note, rewriting the body and collecting the edges.
 *
 * @param markdown The note's body, frontmatter already stripped.
 * @param sourcePath The note's path relative to the content root, which tiers 2
 *   and 5 resolve against.
 * @param index The corpus index, built once for the whole build.
 * @param selfSlug The writing note's own slug, so a link to its own heading
 *   renders without producing the self-edge `checkCorpus` rejects.
 * @param routeFor The public route for a published slug. Injected rather than
 *   hardcoded for the same reason `renderMarkdown` injects it: this module does
 *   not own the route shape, and a later ticket moving notes under a prefix must
 *   not have to edit a traversal.
 */
export function resolveLinksIn(
  markdown: string,
  sourcePath: string,
  index: LinkIndex,
  selfSlug: string,
  routeFor: (slug: string) => string,
): TraversalResult {
  const tree = markdownToMdast(markdown, { features: { wikilinks: true, gfm: true } });
  const nodes: MdastNode[] = [];
  collectLinkNodes(tree as MdastNode, nodes);

  const edits: Edit[] = [];
  const findings: LinkFindingRow[] = [];
  const outgoing: string[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (node.type !== 'link' && node.type !== 'image') continue;
    // A node with no span cannot be edited and cannot be located in a report,
    // so it is left exactly as authored. `offset` is optional in unist —
    // `column` and `line` are the required pair — and every construct measured
    // here carries one, but a parser is free not to and a fabricated `0` would
    // splice text at the top of the document.
    const span = spanOf(node);
    if (span === undefined) continue;

    const isWikilink = isWikilinkNode(node, markdown);
    const written = markdown.slice(span.start, span.end);
    const label = displayText(node, markdown);

    // **The single resolution.** Everything below reads this one value: the
    // replacement text, the edge, and the finding. There is no second call and
    // no second decision.
    const resolution = resolveLink(node.url, sourcePath, index, isWikilink);

    if (resolution.kind === 'external') {
      // Left byte-for-byte, including a wikilink that turned out to be a bare
      // fragment — rewriting one would change a link this build has no opinion
      // about.
      continue;
    }

    // **Every edit is written around the label, never over it.** A node's label
    // is where a nested node writes, so an edit spanning it would overwrite
    // whatever that nested node produced — measured, `applyEdits` refused the
    // overlap and the build failed on `[![logo](logo.png)](gone.md)`. Splitting
    // each rewrite into the two regions on either side of the label is what
    // makes an outer node and a nested one both writable in one pass. A node
    // with no label span — an image, or a link the parser gave none — has
    // nothing nested to protect and is replaced whole.
    //
    // The whole-span form is also the only one that can escape its label: the
    // split form leaves the label's own bytes in place, which is what preserves
    // a nested node's rewrite. That is sound because a node *with* a label span
    // has a label the parser read as link-label syntax already — its brackets
    // are balanced by construction. An image's `alt` and a wikilink's display
    // half were never link-label syntax, and those are exactly the nodes with
    // no label span. See {@link escapeLabel}.
    const inner = node.type === 'link' ? labelSpan(node) : undefined;
    const rewrite = (before: string, after: string, fallbackLabel = label): void => {
      if (inner === undefined) {
        edits.push({
          start: span.start,
          end: span.end,
          text: before + escapeLabel(fallbackLabel) + after,
        });
        return;
      }
      edits.push({ start: span.start, end: inner.start, text: before });
      edits.push({ start: inner.end, end: span.end, text: after });
    };

    if (resolution.kind === 'unresolved' || resolution.kind === 'unpublished') {
      // Degraded to text. For `unpublished` the resolved path is deliberately
      // *not* written into the body: it is a path to a file the user chose not
      // to publish, and the artifact is the one place it may not appear. It goes
      // to the report, which lives where nothing can commit it. See
      // {@link withheldLabel} for the case where the *authored* text is itself
      // that path.
      //
      // A label the traversal must shorten cannot keep its label region — the
      // shortening *is* an edit over that region — so it is replaced whole.
      // Nothing nested is lost by that: a node whose label discloses a withheld
      // path has that path in its own text, not in a child the walk would
      // rewrite separately.
      const shortened =
        resolution.kind === 'unpublished' ? withheldLabel(label, resolution.path) : label;
      if (shortened === label) rewrite('', '');
      else edits.push({ start: span.start, end: span.end, text: shortened });
      findings.push({
        source: sourcePath,
        line: span.line,
        link: written,
        outcome: resolution.kind,
        ...(resolution.kind === 'unpublished' ? { candidates: [...resolution.candidates] } : {}),
      });
      continue;
    }

    // Resolved or ambiguous: both render, and both contribute an edge. An
    // ambiguous link is a link that *worked* — decision D1 makes ambiguity a
    // warning, because failing is worst exactly where it is most likely and a
    // stranger running this tool cannot always act on it. What separates the two
    // is that one is reported.
    //
    // **An `![[note]]` embed becomes a link, not an image.** Obsidian
    // transcludes it — the target note's content is rendered inline — and
    // nothing here does that: transclusion is a content decision (which
    // headings, how deep, what happens to a cycle) that no ticket has made. An
    // `<img src>` pointing at an HTML page is the one outcome that is certainly
    // wrong, so the embed degrades to an ordinary link to the note, and the
    // report says an embed was demoted rather than leaving the author to
    // discover a missing image. An embed of a *file* — the ordinary
    // `![[diagram.png]]` — never reaches here: an image is not a published note,
    // so it left as `unpublished` above.
    const embedDemoted = node.type === 'image';
    const href = `${routeFor(resolution.slug)}${resolution.anchor}`;
    // The slug is the fallback name for a node with no label at all — `[](x)`
    // and an image whose alt is empty — because `[](/route/)` renders an anchor
    // with no accessible name. A node that *has* a label keeps it, whatever it
    // contains.
    rewrite('[', `](${href})`, label || resolution.slug);

    if (embedDemoted) {
      findings.push({
        source: sourcePath,
        line: span.line,
        link: written,
        outcome: 'embed-not-transcluded',
      });
    }

    // A note linking to its own heading is ordinary, and `checkCorpus` rejects
    // an entry that lists itself in `outgoing`. The link still renders — the
    // anchor is real — and simply contributes no edge.
    if (resolution.slug !== selfSlug && !seen.has(resolution.slug)) {
      seen.add(resolution.slug);
      outgoing.push(resolution.slug);
    }

    if (resolution.kind === 'ambiguous') {
      findings.push({
        source: sourcePath,
        line: span.line,
        link: written,
        outcome: 'ambiguous',
        candidates: [...resolution.candidates],
        resolvedTo: resolution.path,
      });
    }
  }

  return { markdown: applyEdits(markdown, edits), outgoing, findings };
}
