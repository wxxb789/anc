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
import { WITHHELD_LINK_TEXT, WITHHELD_ROUTE } from '../src/lib/route-path.ts';
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
 * Node types that render as an anchor, so nothing inside one may open another.
 *
 * Wider than the two types this walk rewrites, deliberately — see
 * {@link collectLinkNodes}. `footnoteReference` renders as an anchor too and is
 * childless, so it can contain nothing and costs nothing to omit; every
 * *container* HTML forbids an `<a>` inside is here.
 */
const CONTAINS_LINK: ReadonlySet<string> = new Set([
  'link',
  'image',
  'linkReference',
  'imageReference',
]);

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
 *
 * `nested` receives every node that has a link-bearing ancestor, because the one
 * rewrite that cannot be split is the one that would put an anchor inside an
 * anchor — see the `unpublished` branch in {@link resolveLinksIn}. Recorded
 * during the walk rather than recovered from spans afterwards: the tree states
 * containment directly, and a span comparison would restate it.
 *
 * **The ancestor test is {@link CONTAINS_LINK} and not the two types this walk
 * rewrites**, which is a distinction that cost a defect. `linkReference` is
 * mdast's reference-style link — `[![build](badge.png)][ci]` with `[ci]:` on its
 * own line, the badge idiom half of every README uses — and it is neither `link`
 * nor `image`, so a version testing only those two left a withheld image inside
 * one unmarked. Measured through the shipped renderer: it emitted
 * `<p>Badge: [<a href="/private/">build</a>]<a href="https://ci.example/">ci</a></p>`
 * — the nested anchor this set exists to prevent, the outer reference link
 * destroyed, and its label `ci` rendered as prose. The reference forms are not
 * *pushed* into `into`, because this walk does not resolve them; they only have
 * to be recognised as things a rewrite may not open an anchor inside.
 */
function collectLinkNodes(node: MdastNode, into: MdastNode[], nested: Set<MdastNode>, inside = false): void {
  const isLinkNode = node.type === 'link' || node.type === 'image';
  if (isLinkNode) {
    into.push(node);
    if (inside) nested.add(node);
  }
  for (const child of ('children' in node ? node.children : []) as MdastNode[]) {
    collectLinkNodes(child, into, nested, inside || CONTAINS_LINK.has(node.type));
  }
}

/**
 * The display text a link with no live target leaves behind.
 *
 * An `unresolved` link is not rendered as an anchor — a live anchor to nothing
 * is a lie to the reader. What remains is what the author wrote for a human to
 * read.
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
 *
 * **`unpublished` no longer routes through here**, and did until 2026-08-17.
 * See the `unpublished` branch in {@link resolveLinksIn} for the decision that
 * changed and what it cost.
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
 * **Only `[` and `]`, and the set is measured rather than assumed.** Every
 * candidate was run through both rewrite paths and the shipped renderer
 * (`.tmp/probe-labels.mjs`); `(`, `)`, a backtick, and a lone backslash all
 * round-trip intact, because the parser closes a label at its `]` before a
 * destination begins and nothing else in a label is delimiter syntax. Escaping
 * more than the two characters that can break the construct would put visible
 * backslashes into a reader's text.
 */
function escapeLabel(text: string): string {
  return text.replace(/[[\]]/g, (character) => `\\${character}`);
}

/**
 * The edits that make a label's own text safe to sit inside `[…]`.
 *
 * **This is the split rewrite's half of {@link escapeLabel}, and it existed as a
 * defect for as long as the split rewrite has.** An outer link is rewritten as
 * two edits *around* its label so a nested node can write into the middle
 * (see {@link labelSpan}) — which means the label's bytes are copied through
 * untouched, escaper included. Measured on `2405cb2` and still live at
 * `ebd53ff`:
 *
 * ```
 * [[beta|has ] bracket]]  ->  [has ] bracket](/beta/)   no anchor at all
 * [[beta|has [ bracket]]  ->  [has [ bracket](/beta/)   anchor text " bracket"
 * ```
 *
 * The first renders as literal text — the label closes at the author's `]` and
 * `](/beta/)` becomes prose. The second silently loses the first half of the
 * author's own words. Both are what a *reader* gets, which is why the gates
 * assert rendered HTML rather than the intermediate Markdown.
 *
 * **The escape operates on the source bytes and touches nothing else**, which is
 * the property the first two attempts both got wrong and is worth stating as a
 * rule: *a label with no bracket in it must come out byte-identical to what the
 * author wrote.*
 *
 * The first attempt escaped the source slice with a plain `[` / `]` replace, so
 * an author's own `\]` became `\\]` — a literal backslash and then an unescaped
 * delimiter, which renders a backslash and closes the label. Worse than the
 * defect, because the input was already correct.
 *
 * The second attempt escaped the parser's `value` instead, which fixes that case
 * and breaks three others, because `value` is not the source with escapes
 * resolved — it is the source with *everything* resolved. Measured, and found by
 * review rather than by any gate:
 *
 * ```
 * [[t|ends with \]]              ->  [ends with \](/t/)     zero anchors
 * [the \*star\* file](t.md)      ->  <a>the <em>star</em> file</a>
 * [label &lt;img src=…&gt;](t)  ->  <a>label <img src=…></a>
 * ```
 *
 * The third is the serious one: an author who wrote `&lt;img&gt;` as *displayed
 * text* would have shipped a live third-party request out of a build whose whole
 * subject is not making requests the author did not ask for. The predicate was
 * "did the parser decode anything", which is a far larger set than "does this
 * need escaping".
 *
 * So: escape the **unescaped** brackets in the source slice, and leave every
 * other byte alone. A bracket is already escaped exactly when an odd number of
 * backslashes precedes it, which is what the capture group counts.
 *
 * **Only `text` descendants are escaped, and the exclusions are each measured.**
 *
 * - An `inlineCode` node is skipped: a `]` inside backticks cannot close a label
 *   (measured — `[code \`has ] bracket\` here](/t/)` renders as one anchor
 *   containing a `<code>`), and escaping there would put a visible backslash
 *   inside code the author wrote.
 * - A `text` node under a **nested** `link` or `image` is skipped, because those
 *   bytes are the region that node's own rewrite writes into.
 *
 * **The nested exclusion is reachable, and a first version of this comment said
 * it was not.** A GFM autolink is a `link` node *inside* a link's children —
 * `[[t|see <https://example.invalid/a> b]]` parses with `link[8,35)` under
 * `link[0,39)` — so a bracket inside an autolink URL does reach here. Without
 * the guard, `[[t|a ] b <https://x.invalid/p]q> c]]` ships
 * `href="https://x.invalid/p%5C%5Dq"`: a backslash spliced into somebody's URL.
 * The probe that concluded "unreachable" enumerated only `[…](…)` and `![…](…)`
 * shapes and never an autolink, which is `docs/gate-reading.md` case 5 — a
 * fixture encoding what its author believed the parser emits.
 *
 * Emitted as one edit per text node rather than one over the whole label, for
 * the same reason the outer rewrite is split: any span a nested node owns has to
 * be left alone.
 */
function escapeLabelEdits(node: MdastNode, source: string, into: Edit[]): void {
  const walk = (current: MdastNode, insideNested: boolean): void => {
    for (const child of ('children' in current ? current.children : []) as MdastNode[]) {
      const nested = insideNested || CONTAINS_LINK.has(child.type);
      if (child.type === 'text' && !nested) {
        const span = spanOf(child);
        if (span !== undefined) {
          const written = source.slice(span.start, span.end);
          const escaped = written.replace(/(\\*)([[\]])/g, (_, slashes: string, bracket: string) =>
            slashes.length % 2 === 1 ? `${slashes}${bracket}` : `${slashes}\\${bracket}`,
          );
          if (escaped !== written) into.push({ start: span.start, end: span.end, text: escaped });
        }
      }
      walk(child, nested);
    }
  };
  walk(node, false);
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
  const nestedNodes = new Set<MdastNode>();
  collectLinkNodes(tree as MdastNode, nodes, nestedNodes);

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
    const nested = nestedNodes.has(node);

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
    // The whole-span form is also the only one that could escape its label
    // *through* {@link escapeLabel}: the split form leaves the label's own bytes
    // in place, which is what preserves a nested node's rewrite. So the split
    // form escapes its label separately, in edits scoped to the label's own text
    // nodes — see {@link escapeLabelEdits}, which is where that had been missing
    // for as long as the split form existed.
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
      // Only where an anchor is actually opened. An `unresolved` link degrades
      // to plain text, and text is not a construct a `]` can break — escaping
      // there would ship the author a visible backslash in prose.
      if (before !== '') escapeLabelEdits(node, markdown, edits);
    };

    if (resolution.kind === 'unresolved' || resolution.kind === 'unpublished') {
      // **`unpublished` keeps the author's label whole and becomes a live link
      // to {@link WITHHELD_ROUTE}.** Owner decision, 2026-08-17, reversing the
      // 2026-08-14 rule that reduced the label to the target's last segment.
      //
      // What changed, measured on the same input:
      //
      //     See [[clients/acme/2026-renewal]] for the numbers.
      //     before:  See 2026-renewal for the numbers.
      //     after:   See [clients/acme/2026-renewal](/private/) for the numbers.
      //
      // **What it costs, stated because the code cannot state it later.** A
      // wikilink's label *is* its target, so the full path of every withheld
      // note a published note links now enters `dist/`. One `grep` over the
      // built site lists the directory structure the author excluded. That is
      // the intended consequence rather than an oversight; the owner heard it
      // and kept the rule. The withheld note's *body* still never ships, which
      // is a different fact and is gated separately.
      //
      // `unresolved` still degrades to text: there is no honest destination for
      // a link to nothing, and `/private/` would claim the target exists.
      //
      // **A withheld node nested inside a link stays text**, and that is forced
      // rather than chosen: CommonMark has no nested anchor, so emitting one
      // produces `[[chart](/private/)](/target/)` — measured through the shipped
      // renderer as `[<a href="/private/">chart</a>](/notes-beta/)`, an anchor
      // to the withheld page with the outer link destroyed and its closing
      // syntax spilled into the prose. A `link` inside a `link` is
      // unrepresentable in mdast (measured), so the containers this has to
      // survive are the image and the two *reference* forms — see
      // {@link CONTAINS_LINK}, which is where omitting `linkReference` put the
      // nested anchor back.
      //
      // The label a nested node keeps is its own text, which for an image is
      // the alt the author wrote. That is usually not the path — but
      // `![[private/chart.png]]` has an alt *equal to* the path, so this drops
      // the path in some spellings and keeps it in others. Neither is a privacy
      // property any more; what decides it is only whether an anchor can open
      // here.
      const live = resolution.kind === 'unpublished' && !nested;
      // The slug is not available on an `unpublished` resolution — there is no
      // published note to name — so an empty label falls back to the withheld
      // page's own title. `[](x.md)` and `![](x.png)` otherwise emit
      // `<a href="/private/"></a>`, an anchor with no accessible name, which is
      // the defect the resolved branch below already guards against with
      // `label || resolution.slug`. Under the previous rule these degraded to
      // nothing at all, so the shape did not exist to guard.
      if (live) rewrite('[', `](${WITHHELD_ROUTE})`, label || WITHHELD_LINK_TEXT);
      else rewrite('', '');
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
