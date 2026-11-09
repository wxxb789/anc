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
 * So each `link` and `image` node, and each `linkReference` and `imageReference`
 * through its definition, is resolved **exactly once**, and that single
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
import sanitizeHtml from 'sanitize-html';
import { resolveLink, type LinkIndex } from '../src/lib/link-resolution.ts';
import {
  type ImagePublisher,
  type MediaFailureReason,
} from '../src/lib/media.ts';
import { WITHHELD_LINK_TEXT, WITHHELD_ROUTE } from '../src/lib/route-path.ts';
import type { LinkFindingRow } from './write-report.ts';

/**
 * One image reference this note carries that the build refuses to publish.
 *
 * The row exists so the *report* can name it — the source file, the line, the
 * reference as authored — while the stream carries a count. An image reference
 * is never degraded: a broken `<img>`, a `/private/` link, and a silently
 * dropped element are all outcomes Goal 0009 forbids, so the producer collects
 * every failure and the build stops.
 */
export interface MediaFailureRow {
  /** The writing file's path, relative to the content directory. */
  readonly source: string;
  /** 1-indexed line within that file. */
  readonly line: number;
  /** The reference exactly as authored, so it can be searched for. */
  readonly link: string;
  readonly reason: MediaFailureReason;
}

/** What one note's traversal produced. */
export interface TraversalResult {
  /** The body with every internal link rewritten. Every other byte unchanged. */
  readonly markdown: string;
  /** Published slugs this note links to, deduplicated, in document order. */
  readonly outgoing: readonly string[];
  /** Everything the report needs from this note. */
  readonly findings: readonly LinkFindingRow[];
  /**
   * Image references the build must refuse. Non-empty means the caller stops the
   * build; the body above has already degraded them to their authored alt text so
   * the value is self-consistent, but it is never written.
   */
  readonly mediaFailures: readonly MediaFailureRow[];
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
 * Every link-bearing node, in document order, including nested ones, and every
 * `definition` node beside them.
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
 * destroyed, and its label `ci` rendered as prose.
 *
 * **The reference forms are now resolved as well, and were not until
 * 2026-09-23.** Skipping them was a bypass rather than a neutral choice: with
 * `[x]: drafts/secret.md` a withheld note, `[s][x]` rendered
 * `<a href="drafts/secret.md">s</a>` — neither `/private/` nor text — and with
 * `[y]: b.md` published, `[b][y]` rendered a live anchor that contributed no
 * edge, breaking "article hrefs equal DB edges". Each reference is now resolved
 * through the first definition for its identifier and rewritten inline, exactly
 * as `[s](drafts/secret.md)` would be; `tests/reference-links.test.ts` gates it.
 */
function collectLinkNodes(
  node: MdastNode,
  into: MdastNode[],
  nested: Set<MdastNode>,
  definitions: MdastNode[],
  raw: MdastNode[],
  inside = false,
): void {
  if (CONTAINS_LINK.has(node.type)) {
    into.push(node);
    if (inside) nested.add(node);
  } else if (node.type === 'definition') {
    definitions.push(node);
  } else if (node.type === 'html') {
    // Raw HTML is the one image form the node walk cannot see: `<img>` written
    // by hand is an `html` node, not an `image` node. Collected here so the
    // producer can refuse a local one before a broken element ships; see
    // `rawImageSources`.
    raw.push(node);
  }
  for (const child of ('children' in node ? node.children : []) as MdastNode[]) {
    collectLinkNodes(child, into, nested, definitions, raw, inside || CONTAINS_LINK.has(node.type));
  }
}

/**
 * The first definition for each identifier, which is the one CommonMark uses.
 *
 * Measured against the installed parser: `[b]: first.md` followed by
 * `[B]: second.md` renders `[t][b]` as `href="first.md"`, and both nodes carry
 * the normalised identifier `b`. The walk is in document order, so the first
 * one seen is the one kept.
 */
function definitionsById(definitions: readonly MdastNode[]): Map<string, MdastNode> {
  const byId = new Map<string, MdastNode>();
  for (const definition of definitions) {
    if (definition.type !== 'definition') continue;
    if (!byId.has(definition.identifier)) byId.set(definition.identifier, definition);
  }
  return byId;
}

/**
 * A definition rewritten to point at `destination`, its label bytes kept.
 *
 * The label ends at its first unescaped `]` — a link label cannot contain one —
 * and everything after it (the destination, an optional title, and whatever
 * line breaks or container prefixes sit between them) is replaced. The title is
 * dropped for the same reason an inline link's is: every reference to this
 * definition has already been rewritten inline, so nothing reads it.
 */
function rewriteDefinition(written: string, destination: string): string | undefined {
  let slashes = 0;
  for (let index = 1; index < written.length; index += 1) {
    const character = written[index];
    if (character === ']' && slashes % 2 === 0) return `${written.slice(0, index + 1)}: ${destination}`;
    slashes = character === '\\' ? slashes + 1 : 0;
  }
  return undefined;
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
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
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
 * Decoded text → Markdown inline source. **The only place that conversion
 * happens**, for both an image's `alt` and its `title`.
 *
 * The rule, in one sentence: escape every decoded character that Markdown or
 * the renderer can interpret, encode a line feed or carriage return as a numeric
 * character reference, and emit everything else unchanged. The escaped set is
 *
 * | escaped | why leaving it raw changes the text |
 * | --- | --- |
 * | `\` | the escape introducer: **every** decoded backslash is emitted as `\\`, unconditionally |
 * | `"` | the title's delimiter (a label never needs it, but one uniform set is the point) |
 * | `` ` `` | a code span, which discards its delimiters |
 * | `*`, `_` | emphasis and strong, which discard their markers |
 * | `[`, `]` | a label's own delimiters, and nested link/image syntax |
 * | `<` | raw HTML and autolinks, which reprocess the text as markup |
 * | `&` | a character reference, which decodes the text a second time |
 * | `~` | GFM strikethrough |
 * | `\|` | a GFM table cell separator, when the image sits in a table |
 * | `$` | the math feature's delimiters (`$$…$$`) |
 *
 * **A decoded backslash is always doubled; there is no conditional run logic.**
 * The round-2 rule doubled a run only before punctuation, a line break, or the
 * end of the label. That is wrong for a run before ordinary text: two decoded
 * backslashes emitted raw re-parse as one, because each pair escapes itself.
 * Emitting `2n` bytes for `n` decoded backslashes decodes back to `n` in every
 * position — before a letter, a space, punctuation, a bracket, or the closing
 * delimiter — so the uniform rule is also the simpler one. Measured before this
 * change:
 *
 * ```
 * alt "ends with \\"  emitted raw "ends with \\"  ->  alt "ends with \"
 * ```
 *
 * LF/CR cannot be backslash-escaped, and a raw one would let the next line start
 * a block construct or a blank line end it, so both are emitted as `&#10;` /
 * `&#13;`; the parser decodes them back to the same character. Everything else —
 * letters, digits, spaces, `\u00a0`, `!`, `(`, `)`, `+`, `%`, `#`, `:`, `/`,
 * `.`, `>` — is ordinary text in a label and a title, so it is emitted
 * unchanged; an unescaped `!` cannot form an image because the `[` after it is
 * escaped.
 *
 * The two fields this serves are an image's `alt` and its `title`, and they
 * differ only in the title's surrounding quotes (added by {@link inlineTitle}).
 * The title path used to carry a second copy of the escaping rule, and it
 * decoded a second time for exactly the reason this function exists:
 *
 * ```
 * title "literal &copy;"  emitted raw inside quotes  ->  title "literal ©"
 * ```
 *
 * **Compared with {@link escapeLabelEdits}, this is a different input, not a
 * second rule.** That function receives *source* bytes, where the author's own
 * escapes are already present, so it must add a byte only to an unescaped
 * bracket; escaping anything else there would corrupt text that was already
 * Markdown. This function receives decoded text, where every construct-forming
 * character has to be reintroduced. There is no decoded text anywhere else in
 * this module that is turned back into Markdown.
 *
 * The alternative — copy the label's source span — is what the split rewrite
 * does for an anchor's label, and it is not available here: an image's `alt`
 * arrives as the parser's decoded string with no span of its own inside the
 * node, and recovering that span would need a second bracket-aware scanner in
 * this function. The decoded form is the one the rewrite already has, so it is
 * the one re-encoded.
 *
 * Text taken from one construct and written into another has to be re-escaped
 * for the construct it lands in: a wikilink's display half and an image's `alt`
 * are *not* link-label syntax, so a `[` or `]` inside either is ordinary text
 * there and a delimiter here. Measured, from the same defect:
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
 */

/**
 * Every character that begins or participates in Markdown/HTML syntax.
 *
 * A record rather than a `Set` because the table is static: each key names one
 * construct above, and a reader can audit the whole rule in one place.
 */
const MARKDOWN_SYNTAX: Readonly<Record<string, true>> = {
  '\\': true,
  '"': true,
  '`': true,
  '*': true,
  _: true,
  '[': true,
  ']': true,
  '<': true,
  '&': true,
  '~': true,
  '|': true,
  $: true,
};

function serializeText(text: string): string {
  let result = '';
  for (const character of text) {
    if (character === '\n') result += '&#10;';
    else if (character === '\r') result += '&#13;';
    else if (MARKDOWN_SYNTAX[character] === true) result += `\\${character}`;
    else result += character;
  }
  return result;
}

/**
 * The edits that make a label's own text safe to sit inside `[…]`.
 *
 * **This is the source-byte counterpart of {@link serializeText}, and it
 * existed as a defect for as long as the split rewrite has.** An outer link is
 * rewritten as two edits *around* its label so a nested node can write into the
 * middle (see {@link labelSpan}) — which means the label's bytes are copied
 * through untouched, escaper included. Measured on `2405cb2` and still live at
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
 * Whether a reference names a file other than a note.
 *
 * The one question that decides whether an `![[…]]` embed is the media
 * pipeline's business or the note resolver's. A wikilink embed with no extension
 * is Obsidian's transclusion syntax for a note (`![[beta]]`, `![[A note]]`); one
 * carrying an extension names a file (`![[chart.png]]`, `![[report.pdf]]`), and
 * Goal 0009's boundary is that a referenced file which is not a note must be
 * published or fail. `.md` is excluded because `![[note.md]]` is still a note.
 */
function namesNonNoteFile(reference: string): boolean {
  const cut = reference.indexOf('#');
  const path = cut === -1 ? reference : reference.slice(0, cut);
  const slash = path.lastIndexOf('/');
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  return base.slice(dot).toLowerCase() !== '.md';
}

/**
 * Whether an `<img src>` is one this build leaves alone.
 *
 * Remote images and inline rasters predate Goal 0009 and keep working unchanged;
 * everything else names a local form the accepted resolver does not cover. The
 * test is `has a scheme or is protocol-relative`, not "is relative", so a
 * `file:` URL and a `javascript:` URL fall to the refusal rather than to the
 * sanitizer's later filter — they are local forms the producer must report.
 */
function isExternalImageSource(source: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source) || source.startsWith('//');
}

/**
 * Every `src` a fragment of raw HTML gives an `<img>`, in document order.
 *
 * Parsed by `sanitize-html` — the same parser that later decides whether an
 * element reaches the page — rather than matched with a regex, because the
 * question is what a *browser* would fetch and a regex over `[^>]*` stops at the
 * first `>` inside a quoted attribute. Measured shape: `<img alt="a > b"
 * src="x.png">` is one tag with one src, and a search that truncates at `>` sees
 * none.
 *
 * Returns `undefined` when the fragment mentions `<img` but the parser found no
 * element, which is malformed raw HTML rather than a remote image. The caller
 * treats that as a failure too: an `<img>` this build cannot read is not one it
 * can certify as remote.
 */
function rawImageSources(html: string): string[] | undefined {
  const sources: string[] = [];
  sanitizeHtml(html, {
    allowedTags: ['img'],
    // Not a security decision — the renderer's sanitizer owns that. The
    // attributes are only needed long enough for the transform to read `src`.
    allowedAttributes: { img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding', 'srcset', 'sizes'] },
    // Schemes are read, not filtered, here.
    allowedSchemes: [],
    allowProtocolRelative: true,
    transformTags: {
      img: (tagName, attribs) => {
        sources.push(typeof attribs['src'] === 'string' ? attribs['src'] : '');
        return { tagName, attribs };
      },
    },
  });
  return sources.length === 0 ? undefined : sources;
}

/**
 * An image title, quoted and serialised from the parser's decoded value.
 *
 * Only reached when an image is republished under its asset URL and the author
 * wrote a title, inline or on the reference's definition. The parsed title is
 * the author's text with character references and escapes already resolved, so
 * it goes through the same {@link serializeText} the label does; the only
 * title-specific part is the surrounding `"`. Whitespace is **not** collapsed
 * or trimmed: the parser preserved it, and the old collapse changed titles like
 * ` a  b ` and turned a decoded `&copy;` into `©` a second time.
 */
function inlineTitle(title: string | null | undefined): string {
  if (typeof title !== 'string' || title === '') return '';
  return ` "${serializeText(title)}"`;
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
 * @param media The asset publisher. Required rather than defaulted, because a
 *   default that ignored images is the fail-open shape this module exists to
 *   avoid: every local image reference must either publish or be recorded as a
 *   failure, and the caller is the only one that can say which.
 */
export function resolveLinksIn(
  markdown: string,
  sourcePath: string,
  index: LinkIndex,
  selfSlug: string,
  routeFor: (slug: string) => string,
  media: ImagePublisher,
): TraversalResult {
  const tree = markdownToMdast(markdown, { features: { wikilinks: true, gfm: true } });
  const nodes: MdastNode[] = [];
  const nestedNodes = new Set<MdastNode>();
  const definitionNodes: MdastNode[] = [];
  const rawNodes: MdastNode[] = [];
  collectLinkNodes(tree as MdastNode, nodes, nestedNodes, definitionNodes, rawNodes);
  const definitions = definitionsById(definitionNodes);

  const edits: Edit[] = [];
  const findings: LinkFindingRow[] = [];
  const mediaFailures: MediaFailureRow[] = [];
  /**
   * Definitions an image reference republished through, and the URL it became.
   *
   * The definition's own rewrite runs after the node loop, and without this it
   * would resolve the *source path* against the corpus and find no note, leaving
   * `[ref]: chart.png` in the body of the note that published it. No reader sees
   * a definition, but the body handed onward would still carry the one path the
   * asset pipeline replaced.
   */
  const publishedDefinitions = new Map<MdastNode, string>();
  const outgoing: string[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    // A reference resolves through its definition's destination, and is then
    // rewritten exactly as the inline form with that destination would be — see
    // {@link rewriteDefinition} for the definition's own half.
    let url: string;
    let definition: MdastNode | undefined;
    if (node.type === 'link' || node.type === 'image') url = node.url;
    else if (node.type === 'linkReference' || node.type === 'imageReference') {
      definition = definitions.get(node.identifier);
      // The parser only emits a reference node when a matching definition
      // exists, so this is unreachable; a reference with nothing to resolve is
      // left as authored rather than guessed at.
      if (definition?.type !== 'definition') continue;
      url = definition.url;
    } else continue;
    // A node with no span cannot be edited and cannot be located in a report,
    // so it is left exactly as authored. `offset` is optional in unist —
    // `column` and `line` are the required pair — and every construct measured
    // here carries one, but a parser is free not to and a fabricated `0` would
    // splice text at the top of the document.
    const span = spanOf(node);
    if (span === undefined) continue;

    // A reference's destination is a definition's, which is always Markdown
    // syntax — and `[[a] b][x]` starts with `[[` without being a wikilink.
    const isWikilink = (node.type === 'link' || node.type === 'image') && isWikilinkNode(node, markdown);
    const written = markdown.slice(span.start, span.end);
    const label = displayText(node, markdown);
    const nested = nestedNodes.has(node);

    // **Image references are the media pipeline's, not the note resolver's.**
    // Markdown image syntax is unambiguous; an `![[…]]` embed is the media
    // pipeline's only when it names a file rather than a note (`![[chart.png]]`
    // versus `![[beta]]`), which is what keeps Obsidian's note transclusion
    // syntax — and its existing demote-to-link behaviour — intact. Handing an
    // image to the note resolver would degrade it to text, to a `/private/` link,
    // or to a link to a note the author meant to display; none of which is a
    // picture.
    //
    // Decided before the resolver runs, and by the reference's own shape: the
    // ownership question has nothing to do with which note a path might name, and
    // asking it first means an image never pays for the five note-link tiers.
    const isImage = node.type === 'image' || node.type === 'imageReference';
    const mediaOwned = isImage && (!isWikilink || namesNonNoteFile(url));

    if (mediaOwned) {
      const outcome = media.publish({ notePath: sourcePath, target: url, isWikilink });
      const title =
        node.type === 'image' ? node.title : definition?.type === 'definition' ? definition.title : null;
      if (outcome.kind === 'external') continue;
      if (outcome.kind === 'published') {
        // The destination is replaced and the alt text kept — the author's words
        // are the only description a reader without the image has. Written as an
        // inline image even when the source was a reference, because the
        // reference's destination is a source path this build never publishes.
        edits.push({
          start: span.start,
          end: span.end,
          text: `![${serializeText(label)}](${outcome.url}${inlineTitle(title)})`,
        });
        if (definition !== undefined) publishedDefinitions.set(definition, outcome.url);
        continue;
      }
      mediaFailures.push({ source: sourcePath, line: span.line, link: written, reason: outcome.reason });
      // Degraded to its own alt text so the returned body is self-consistent.
      // The caller stops the build; this value is never written.
      edits.push({ start: span.start, end: span.end, text: serializeText(label) });
      continue;
    }

    // **The single resolution, for everything that is not an image.** The
    // replacement text, the edge, and the finding all read this one value. There
    // is no second call and no second decision.
    const resolution = resolveLink(url, sourcePath, index, isWikilink);

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
    // *through* {@link serializeText}: the split form leaves the label's own
    // bytes in place, which is what preserves a nested node's rewrite. So the
    // split form escapes its label separately, in edits scoped to the label's
    // own text nodes — see {@link escapeLabelEdits}, which is where that had
    // been missing for as long as the split form existed.
    const inner = node.type === 'link' || node.type === 'linkReference' ? labelSpan(node) : undefined;
    const rewrite = (before: string, after: string, fallbackLabel = label): void => {
      if (inner === undefined) {
        edits.push({
          start: span.start,
          end: span.end,
          text: before + serializeText(fallbackLabel) + after,
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
    // The image node reaching this point is a wikilink embed of a note — the
    // media branch above owns every file reference — and it is demoted to a
    // link for the reason this branch states. `isImage` is the same test made
    // before that branch, so control-flow narrowing cannot hide it.
    const embedDemoted = isImage;
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

  // **Every internal definition is rewritten too, used or not.** No reference
  // reads it any more — each one was rewritten inline above — so this changes
  // nothing a reader sees; it keeps the author's withheld destination out of the
  // body handed onward, which has no reason to carry a path nothing renders.
  // It contributes no edge and no finding: a definition renders nothing, and an
  // edge exists exactly where a rendered anchor does. An unresolved destination
  // names no file this build knows of, so it is left as written.
  //
  // A definition an image reference published through points at the asset URL,
  // not at the withheld route: the source path it held is exactly what the
  // pipeline replaced, and `resolveLink` cannot see a file the media map owns.
  for (const definition of definitionNodes) {
    if (definition.type !== 'definition') continue;
    const span = spanOf(definition);
    if (span === undefined) continue;
    const published = publishedDefinitions.get(definition);
    let destination: string;
    if (published !== undefined) destination = published;
    else {
      const resolution = resolveLink(definition.url, sourcePath, index, false);
      if (resolution.kind === 'resolved' || resolution.kind === 'ambiguous') {
        destination = `${routeFor(resolution.slug)}${resolution.anchor}`;
      } else if (resolution.kind === 'unpublished') destination = WITHHELD_ROUTE;
      else continue;
    }
    const text = rewriteDefinition(markdown.slice(span.start, span.end), destination);
    if (text !== undefined) edits.push({ start: span.start, end: span.end, text });
  }

  // **Raw-HTML `<img>` is refused unless it is remote or an inline raster.**
  // The Markdown walk cannot see it — `<img src="chart.png">` is an `html` node
  // — so without this it would bypass asset authorization entirely and ship a
  // broken element. The accepted resolver covers Markdown images, reference-style
  // images, and image wikilinks; an HTML form outside that set fails the build,
  // which is what the goal requires rather than a silently dropped picture.
  //
  // Remote and `data:` sources are left alone: they predate this goal, they are
  // never fetched by the build, and their form did not change.
  for (const node of rawNodes) {
    if (node.type !== 'html') continue;
    // HTML comments are inert, and a comment is how a note *documents* markup
    // without rendering it. A commented-out `<img>` asks the browser for nothing,
    // so it is stripped before the detection — otherwise a note explaining how to
    // embed an image would fail its own build.
    const value = node.value.replace(/<!--[\s\S]*?-->/g, '');
    if (!/<img[\s/>]/i.test(value)) continue;
    const span = spanOf(node);
    const sources = rawImageSources(value);
    const offenders = sources === undefined ? [''] : sources.filter((source) => !isExternalImageSource(source));
    if (offenders.length === 0) continue;
    mediaFailures.push({
      source: sourcePath,
      line: span?.line ?? 1,
      link: value.trim(),
      reason: 'html-form',
    });
  }

  return { markdown: applyEdits(markdown, edits), outgoing, findings, mediaFailures };
}
