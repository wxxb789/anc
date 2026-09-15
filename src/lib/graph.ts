/**
 * The graph, laid out at build time.
 *
 * This is the module behind the one capability a reader would experience as
 * *better* than Quartz rather than merely cleaner. Quartz's `Graph.tsx` emits
 * three empty `<div>`s and a `data-cfg` attribute — no nodes, no links, no text
 * in the HTML — and everything else arrives as roughly 525 KB brotli of d3 and
 * PixiJS from a third-party CDN. With scripting off a reader sees nothing.
 *
 * We can lay the graph out during the build for one structural reason: the
 * corpus is a **bounded allowlist**, and `checkCorpus` (`src/lib/schema.ts`) has
 * already proven every edge resolves to a published entry. Quartz cannot,
 * because server-rendering its view would mean laying out a whole *vault* per
 * page. So the layout below runs once per page over at most a few dozen nodes,
 * and what ships is inline SVG containing real `<a>` elements.
 *
 * Pure, like `routes.ts` and `relations.ts`: nothing here imports the artifact
 * and nothing here knows a chrome string exists. Callers pass the corpus in and
 * resolve every label through `translate()`, so every rule below is exercisable
 * against synthetic fixtures without building the site.
 *
 * **Determinism is a hard requirement, not a nicety.** The build is
 * reproducible and `tests/graph.test.ts` builds the same corpus twice and
 * compares bytes. Three things secure it: every ordering below ends in `slug`,
 * which is unique, so no comparator can leave a tie open; every coordinate goes
 * through {@link round}, so a trailing float artifact cannot reach the markup;
 * and no layout step iterates to a fixed point, so there is no starting state to
 * get wrong. That last one is why there is no force simulation here — a static
 * layout also needs no animation, which is how `prefers-reduced-motion` is
 * satisfied by construction rather than by a media query.
 */

import type { ContentEntry } from './schema.ts';
import { byTitleThenSlug } from './relations.ts';

/**
 * How an edge runs relative to the note the reader is on.
 *
 * `mutual` is one edge, not two. The artifact stores each direction separately —
 * `a.outgoing` names `b` and `b.backlinks` names `a` — and drawing both as
 * separate lines would put two overlapping segments between the same pair of
 * circles, which reads as one line and counts as two. One line with an arrowhead
 * at each end is the same fact drawn once.
 */
export type EdgeDirection = 'outgoing' | 'incoming' | 'mutual';

/** One note, drawn. */
export interface GraphNode {
  entry: ContentEntry;
  x: number;
  y: number;
  /** The label as drawn, truncated. `entry.title` is the accessible name. */
  label: string;
  /** How this note relates to the subject. Absent on a graph that has no subject. */
  direction?: EdgeDirection;
  /** Whether this is the note the reader is on. */
  isSubject: boolean;
  /** Edges touching this node inside the drawn set. */
  degree: number;
}

/** One authored relationship between two drawn notes. */
export interface GraphEdge {
  /** The note the arrow leaves. For a mutual edge, whichever end was seen first. */
  from: string;
  /** The note the arrow points at. */
  to: string;
  /** Whether each note links to the other, so the line carries two arrowheads. */
  isMutual: boolean;
  /**
   * How this edge runs relative to the subject, when it touches the subject.
   *
   * Absent on an edge between two neighbours, and on every edge of `/graph/` —
   * which has no subject, so there is no "incoming" without a somewhere to come
   * in to. The stylesheet draws an incoming edge dashed and an outgoing one
   * solid, which is requirements section 13.2's "visually distinguished" done as
   * a *shape* rather than a colour.
   */
  direction?: EdgeDirection;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A laid-out graph, ready to render. */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** `viewBox`, as the attribute's four numbers. */
  viewBox: string;
  /** Intrinsic width in CSS pixels, so the SVG has a size before the CSS loads. */
  width: number;
  height: number;
  /** Nodes the bound excluded. Stated to the reader rather than silently dropped. */
  omitted: number;
}

/**
 * How many notes the neighbourhood on an article page may draw.
 *
 * Requirements section 13.2 requires a bounded node count with an explicit
 * expansion action, and the bound is set by legibility rather than by the data.
 * Twelve neighbours sit on a ring of radius `NODE_GAP * 12 / 2π` ≈ 149, so the
 * figure is about 300 units across before labels — the widest that still reads
 * at 320 px inside its scroll container. Past that the labels are closer
 * together than they are tall.
 *
 * The snapshot's `edges` table has no count ceiling, so this is a real bound
 * rather than a theoretical one; the fixture corpus's busiest note has 10
 * neighbours and the published note has none. **Nothing is hidden by it**: the
 * outgoing and backlink lists immediately above the graph are complete and
 * unbounded, and the figure states how many notes it left out.
 */
export const LOCAL_NODE_LIMIT = 12;

/**
 * How many notes `/graph/` may draw.
 *
 * Requirements section 13.3 admits a global graph only while it "remains legible
 * at current node count", and a corpus now has **no ceiling at all** — the
 * 900-entry `MAX_ENTRIES` this comment used to cite was removed after it refused
 * an ordinary vault at 957 notes (`src/lib/schema.ts` records why). So the case
 * for this bound is stronger than when it was written, not weaker: an unbounded
 * global graph is a hairball for any corpus that grows, and nothing upstream
 * bounds the corpus any more. Sixty is the fifth ring of the
 * packing below (1 + 7 + 14 + 22 + 29 = 73 capacity), which is the last radius
 * at which a label still has room beside its neighbour on the same ring.
 *
 * The sixty are the **most connected** notes, so what the page shows is the
 * site's link structure rather than an alphabetical slice of it. The table under
 * the figure lists the same set, and the home page — linked as the expansion
 * action — lists every published note without exception.
 */
export const GLOBAL_NODE_LIMIT = 60;

/** Distance between two concentric rings, in user units. */
const RING_STEP = 92;

/** The shortest arc the layout will leave between two nodes on one ring. */
const NODE_GAP = 78;

/** Room outside the outermost ring for a label to sit in. */
const LABEL_SPACE = 136;

/**
 * Longest drawn label, in code points rather than UTF-16 units.
 *
 * Counted in code points because a title may be `🌿 Callouts, Checklists &
 * Other Furniture` — `String.prototype.slice` would cut an astral character in
 * half and emit a lone surrogate, which is a rendering fault in the markup
 * rather than a shortened label. The untruncated title is always the node's
 * accessible name, so nothing is lost to a screen reader.
 */
const LABEL_CHARS = 18;

/**
 * Radius of the note the reader is on, and of every other note.
 *
 * Exported because the markup draws the circles and this module trims every
 * edge to stop short of them: two numbers that must agree or an arrowhead lands
 * inside a circle instead of beside it. They were literals in the component
 * until a review found them, which is exactly the divergence that would ship
 * looking correct.
 */
export const SUBJECT_RADIUS = 9;
export const NODE_RADIUS = 6;

/** How much of the line the arrowhead occupies, so an edge stops short of it. */
const MARKER_LENGTH = 9;

/**
 * Two decimal places, with negative zero normalized away.
 *
 * `-0` is what `Math.sin(-Math.PI / 2) * 0` produces for the node at the centre,
 * and it serializes as the string `"-0"` — so without this line two builds of
 * the same corpus differ in the bytes of an attribute whose value is zero. That
 * is exactly the class of defect the determinism gate exists to catch, and it
 * was reachable from the published one-note corpus.
 */
function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * A title shortened to fit beside its node.
 *
 * The ellipsis is one character, so the drawn string is never longer than
 * {@link LABEL_CHARS}. Exported so `tests/graph.test.ts` can exercise the
 * truncation rule directly — the code-point boundary is the part that would
 * otherwise fail silently, by emitting a lone surrogate into the markup.
 */
export function truncateLabel(title: string): string {
  const characters = [...title];
  return characters.length <= LABEL_CHARS
    ? title
    : `${characters.slice(0, LABEL_CHARS - 1).join('').trimEnd()}…`;
}

/**
 * Place items evenly around a circle, starting at the top and going clockwise.
 *
 * The whole of the layout engine. It is a screen of code rather than a
 * dependency because the two things a graph library would add — iteration to a
 * stable configuration, and a runtime to run it in — are the two things a
 * bounded build-time corpus does not need. A force simulation would also have to
 * be seeded and pinned to stay reproducible, which is more work than not having
 * one.
 *
 * Starting at the top rather than at three o'clock so that a graph with one
 * neighbour puts it directly above the subject, which is where a reader looks
 * first, and so that reading order around the figure matches the tab order.
 */
function placeRing<T>(items: readonly T[], radius: number): { item: T; x: number; y: number }[] {
  return items.map((item, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / items.length;
    return { item, x: round(radius * Math.cos(angle)), y: round(radius * Math.sin(angle)) };
  });
}

/**
 * How many nodes ring `index` holds, from its own circumference.
 *
 * Derived rather than tabulated so the packing cannot disagree with the geometry
 * it describes: a ring holds as many nodes as fit at {@link NODE_GAP} apart
 * along its circumference, which is what keeps the gap between adjacent nodes
 * roughly constant as the figure grows outward. Ring 0 is the centre and holds
 * exactly one.
 */
function ringCapacity(index: number): number {
  if (index === 0) return 1;
  return Math.max(1, Math.floor((2 * Math.PI * index * RING_STEP) / NODE_GAP));
}

/** Every note this one is joined to by an authored edge, in either direction. */
function neighbourSlugs(entry: ContentEntry): string[] {
  return [...new Set([...entry.outgoing, ...entry.backlinks])];
}

/**
 * How `other` relates to `subject`, from the subject's own edge lists.
 *
 * Read from the subject's two arrays rather than from the other note's, because
 * they are the arrays the page is about — and `checkCorpus` proves the two views
 * agree, so there is no third answer to reconcile.
 */
export function edgeDirection(subject: ContentEntry, other: string): EdgeDirection | undefined {
  const isOutgoing = subject.outgoing.includes(other);
  const isIncoming = subject.backlinks.includes(other);
  if (isOutgoing && isIncoming) return 'mutual';
  if (isOutgoing) return 'outgoing';
  if (isIncoming) return 'incoming';
  return undefined;
}

/**
 * Every authored edge with both ends inside `nodes`, each drawn once.
 *
 * The *induced subgraph*, not a star. A neighbourhood drawn as spokes from the
 * subject would be a picture of a list the page already renders twice; what
 * makes it a graph is the edges between the neighbours themselves — ten of them
 * around the fixture corpus's busiest note. It is also what gives the gate over
 * `dist/` something to prove: "the rendered edges are exactly the artifact's
 * edges over this node set" is a real claim about a star only in the trivial
 * sense.
 *
 * `subject` is the note the figure is about, when it has one. An edge touching
 * it takes that note's own view of the relationship, which is what lets the
 * stylesheet draw an incoming edge differently from an outgoing one without
 * using colour. Edges between two neighbours have no direction relative to a
 * subject and carry none.
 *
 * Ordered by the pair of slugs, which is total because a slug is unique, so the
 * emitted markup does not depend on the order the artifact listed anything in.
 */
function inducedEdges(nodes: readonly GraphNode[], subject?: ContentEntry): GraphEdge[] {
  const drawn = new Map(nodes.map((node) => [node.entry.slug, node]));
  const pairs = new Map<string, { from: string; to: string; isMutual: boolean }>();

  for (const node of nodes) {
    for (const target of node.entry.outgoing) {
      if (!drawn.has(target)) continue;
      const from = node.entry.slug;
      // One key per unordered pair, so `a → b` and `b → a` meet here rather than
      // producing two overlapping lines. The first arrival fixes the arrow's
      // direction; the second only marks the pair mutual.
      const key = from < target ? `${from} ${target}` : `${target} ${from}`;
      const existing = pairs.get(key);
      if (existing === undefined) pairs.set(key, { from, to: target, isMutual: false });
      else if (existing.from !== from) existing.isMutual = true;
    }
  }

  return [...pairs.values()]
    .sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1))
    .map((pair) => {
      const from = drawn.get(pair.from)!;
      const to = drawn.get(pair.to)!;
      // Both ends stop short of the circle they touch, so an arrowhead is drawn
      // beside a node rather than underneath it. A mutual edge is trimmed at
      // both ends because it carries an arrowhead at both.
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const startTrim = radiusOf(from) + (pair.isMutual ? MARKER_LENGTH : 0);
      const endTrim = radiusOf(to) + MARKER_LENGTH;
      // Two nodes closer together than their own trim would produce a line that
      // runs backwards. The packing never places them that close, and a segment
      // pointing the wrong way is a defect nobody would look for, so it is
      // clamped rather than trusted.
      const scale = Math.min(startTrim, Math.max(0, (length - endTrim) / 2));
      // The far end of an edge touching the subject, seen from the subject.
      const other =
        subject === undefined
          ? undefined
          : pair.from === subject.slug
            ? pair.to
            : pair.to === subject.slug
              ? pair.from
              : undefined;
      return {
        ...pair,
        direction: other === undefined ? undefined : edgeDirection(subject!, other),
        x1: round(from.x + (dx / length) * scale),
        y1: round(from.y + (dy / length) * scale),
        x2: round(to.x - (dx / length) * Math.min(endTrim, length - scale)),
        y2: round(to.y - (dy / length) * Math.min(endTrim, length - scale)),
      };
    });
}

function radiusOf(node: GraphNode): number {
  return node.isSubject ? SUBJECT_RADIUS : NODE_RADIUS;
}

/** Wrap placed nodes and their edges in a box that contains every label. */
function frame(nodes: GraphNode[], omitted: number, subject?: ContentEntry): Graph {
  const reach = Math.max(0, ...nodes.map((node) => Math.hypot(node.x, node.y)));
  const half = Math.ceil(reach + LABEL_SPACE);
  return {
    nodes,
    edges: inducedEdges(nodes, subject),
    viewBox: `${-half} ${-half} ${half * 2} ${half * 2}`,
    width: half * 2,
    height: half * 2,
    omitted,
  };
}

/**
 * The one-hop neighbourhood of one note: requirements section 9.2 item 11.
 *
 * The subject sits at the centre and every note it is joined to sits on one
 * ring around it, because they are all exactly one hop away and a layout that
 * put some of them further out would be drawing a distance the data does not
 * have. The ring's radius grows with the number of neighbours rather than being
 * fixed, so the arc between two adjacent notes stays at {@link NODE_GAP}
 * whether there are two of them or twelve.
 *
 * **Neighbours are ordered by title, then slug** — the same order
 * `notesForSlugs` puts the outgoing and backlink lists in, a few lines up the
 * page. That is what makes the documented keyboard traversal order true of the
 * whole region rather than of one component: a reader tabbing through the
 * neighbourhood meets the notes in the order the lists above named them. It is
 * also the order the bound truncates in, so which notes a busy page omits does
 * not depend on the artifact's own ordering.
 */
export function localGraph(
  entry: ContentEntry,
  lookup: (slug: string) => ContentEntry | undefined,
  limit: number = LOCAL_NODE_LIMIT,
): Graph {
  const neighbours = neighbourSlugs(entry)
    .map(lookup)
    .filter((candidate): candidate is ContentEntry => candidate !== undefined)
    .sort(byTitleThenSlug);

  const drawn = neighbours.slice(0, limit);
  // The ring is never tighter than one step out, so a single neighbour does not
  // sit on top of the subject.
  const radius = Math.max(RING_STEP, Math.ceil((NODE_GAP * drawn.length) / (2 * Math.PI)));

  const subject: GraphNode = {
    entry,
    x: 0,
    y: 0,
    label: truncateLabel(entry.title),
    isSubject: true,
    degree: 0,
  };

  const nodes: GraphNode[] = [
    subject,
    ...placeRing(drawn, radius).map(({ item, x, y }) => ({
      entry: item,
      x,
      y,
      label: truncateLabel(item.title),
      direction: edgeDirection(entry, item.slug),
      isSubject: false,
      degree: 0,
    })),
  ];

  return withDegrees(frame(nodes, neighbours.length - drawn.length, entry));
}

/**
 * The site-wide graph: requirements section 9.1's `/graph/` route.
 *
 * Notes are ordered by how many other **drawn** notes they touch, then by title,
 * then by slug, and packed onto concentric rings from the inside out. The
 * ordering is the layout: the most connected note is at the centre, the next
 * seven on the first ring, and an unlinked note lands on the outermost ring
 * where it belongs. A reader gets the site's shape — hubs in the middle, leaves
 * around the edge — from the geometry alone.
 *
 * **Why not a force simulation.** It is the obvious answer and it is the wrong
 * one here for three reasons: it needs a runtime library or a reimplementation
 * of one, it needs a seed and a pinned iteration count to stay reproducible, and
 * the configuration it converges to is not one anybody can predict from the
 * data — so a layout regression would be invisible. Ranked packing has none of
 * those properties and is fifteen lines. Edges cross; the table under the figure
 * carries the same data exactly, and that is what requirements section 17 asks
 * for.
 *
 * **Degree is measured over the drawn set, and the ranking is not.** Ranking
 * uses each note's degree in the *whole* corpus, because that is the question
 * "which notes matter most here" asks; the `degree` reported on a node counts
 * only edges the figure actually draws, because that is what the node's
 * accessible name states and a name claiming links the picture does not show
 * would be false.
 */
export function globalGraph(
  entries: readonly ContentEntry[],
  limit: number = GLOBAL_NODE_LIMIT,
): Graph {
  const ranked = [...entries]
    .sort((a, b) => {
      const left = neighbourSlugs(a).length;
      const right = neighbourSlugs(b).length;
      if (left !== right) return right - left;
      return byTitleThenSlug(a, b);
    })
    .slice(0, limit);

  const nodes: GraphNode[] = [];
  for (let ring = 0, placed = 0; placed < ranked.length; ring += 1) {
    const slice = ranked.slice(placed, placed + ringCapacity(ring));
    for (const { item, x, y } of placeRing(slice, ring * RING_STEP)) {
      nodes.push({
        entry: item,
        x,
        y,
        label: truncateLabel(item.title),
        isSubject: false,
        degree: 0,
      });
    }
    placed += slice.length;
  }

  return withDegrees(frame(nodes, entries.length - ranked.length));
}

/**
 * Count each node's drawn edges, once the edges are known.
 *
 * A second pass rather than a field computed during placement, because the
 * number that belongs in a node's accessible name is how many lines the reader
 * can see touching it — which is not knowable until the induced edge set exists.
 * A mutual edge counts once, for the same reason it is drawn once.
 */
function withDegrees(graph: Graph): Graph {
  const degrees = new Map<string, number>();
  for (const edge of graph.edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  for (const node of graph.nodes) node.degree = degrees.get(node.entry.slug) ?? 0;
  return graph;
}

/**
 * The notes each drawn node is joined to, within the figure.
 *
 * The edge set as a per-node adjacency, which is what the equivalent table
 * needs: requirements section 17 asks for the *graph data* as a list or table,
 * and a table carrying only each node's degree states how many lines touch it
 * while withholding which notes they run to. On `/graph/` that is the whole
 * edge set missing, because no node there has a relationship to a subject to
 * describe instead.
 *
 * Keyed by slug and ordered by title then slug, so the row reads in the same
 * order as every other list of notes on the site.
 */
export function drawnNeighbours(graph: Graph): Map<string, ContentEntry[]> {
  const byslug = new Map(graph.nodes.map((node) => [node.entry.slug, node.entry]));
  const joined = new Map<string, ContentEntry[]>(graph.nodes.map((node) => [node.entry.slug, []]));
  for (const edge of graph.edges) {
    joined.get(edge.from)?.push(byslug.get(edge.to)!);
    joined.get(edge.to)?.push(byslug.get(edge.from)!);
  }
  for (const list of joined.values()) list.sort(byTitleThenSlug);
  return joined;
}

/**
 * The two numbers the bound sentence states: how many notes are drawn, and how
 * many there are.
 *
 * **Here rather than in the component**, and that placement is the whole point.
 * The sentence reads "Drawing N of M *neighbouring notes*", and a note is not
 * one of its own neighbours — so neither number may count the subject. Two
 * versions shipped getting this wrong: the first passed the raw node count as
 * both bases and would have rendered "13 of 16" where the truth was 12 of 15;
 * the second corrected only the total and rendered "13 of 15", where the
 * numerator exceeded the notes actually drawn.
 *
 * Neither was catchable, and a test *restating* the arithmetic did not catch
 * the second either — reverting the component's fix left the suite green,
 * because the test compared the model against a copy of the expression rather
 * than against the component. Neither corpus reaches {@link LOCAL_NODE_LIMIT},
 * so no built page renders the sentence at all and the gate over `dist/` cannot
 * see it.
 *
 * So the numbers live here, the component interpolates what this returns, and
 * `tests/graph.test.ts` asserts on this function. One source, and a change to
 * it moves the page and the gate together.
 */
export function boundCounts(graph: Graph): { shown: number; total: number } {
  // `/graph/` draws no subject node, so the count is zero there and this is the
  // identity — which is why it needs no flag distinguishing the two surfaces.
  const shown = graph.nodes.length - graph.nodes.filter((node) => node.isSubject).length;
  return { shown, total: shown + graph.omitted };
}

/**
 * Whether there is a graph worth drawing at all.
 *
 * A figure of one circle and no lines states nothing a reader could not have
 * read in the sentence above it, and the published corpus is exactly that case —
 * one note, no edges. The page renders an honest sentence instead, the same way
 * the three relationship sections render their empty states rather than omitting
 * themselves.
 */
export function hasDrawableGraph(graph: Graph): boolean {
  return graph.edges.length > 0;
}
