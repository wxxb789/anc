/**
 * The corpus and hand-computed oracles for `tests/graph-runtime.test.ts`.
 *
 * Goal 0005's browser gate needs specific shapes in one real build: a hub with
 * more than twelve neighbours so the local bound truncates, a reciprocal pair,
 * a three-cycle crossing a neighbour-to-neighbour edge, an isolated note, two
 * identically titled degree-1 notes (slug tiebreak), a zh-CN note, a tag subset
 * whose top-ranked member is not the corpus-wide top, and enough degree-0 notes
 * that the global bound drops some. The corpus below is exactly that.
 *
 * **The expectations here are computed by hand, not by calling the selection,
 * layout, or snapshot modules.** A gate that asks the implementation what it
 * should draw restates it. Where the build's output disagrees with a value
 * here, the disagreement is the finding.
 *
 * Note counts: 1 hub + 15 peers + 2 ties + 1 zh-CN note + 1 plain note +
 * 1 island + 44 fillers = 65.
 */

/** A note slug with a two-digit ordinal, from 1 through `count`. */
function ordinal(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`);
}

/** `peer-01` .. `peer-15`. */
export const PEERS: readonly string[] = ordinal('peer', 15);
/** `filler-01` .. `filler-44`. */
export const FILLERS: readonly string[] = ordinal('filler', 44);
/** Every corpus slug, in the order the builder writes the groups. */
export const CORPUS_SLUGS: readonly string[] = [
  'hub',
  ...PEERS,
  'tie-alpha',
  'tie-zeta',
  'zh-note',
  'plain-note',
  'island',
  ...FILLERS,
];
/** The number of notes in the corpus; the global limit draws 60 of them. */
export const CORPUS_SIZE = 65;

export const HUB_TITLE = 'Hub';
export const TIE_TITLE = 'Tie';
export const ZH_NOTE_TITLE = '中文笔记';
export const PLAIN_NOTE_TITLE = 'Plain Note';
export const ISLAND_TITLE = 'Island';

/** `peer-01` renders the title `Peer 01`; the same rule for fillers. */
export function peerTitle(slug: string): string {
  return `Peer ${slug.slice('peer-'.length)}`;
}

export function fillerTitle(slug: string): string {
  return `Filler ${slug.slice('filler-'.length)}`;
}

/** hub's authored outgoing links, in the order the builder writes them. */
export const HUB_NEIGHBOURS: readonly string[] = [...PEERS, 'tie-alpha', 'tie-zeta'];

/** The team tag's members; the garden tag's are `island`, `peer-04`, `plain-note`. */
export const TEAM_PEERS: readonly string[] = ['peer-01', 'peer-02', 'peer-03'];
export const GARDEN_SLUGS: readonly string[] = ['peer-04', 'plain-note', 'island'];

/** The authored outgoing links of peers 01-04; every other peer has none. */
const PEER_LINKS: Readonly<Record<string, readonly string[]>> = {
  'peer-01': ['peer-02', 'zh-note'],
  'peer-02': ['peer-01', 'peer-03'],
  'peer-03': ['peer-01'],
  'peer-04': ['peer-02'],
};

/**
 * The 65-note corpus, keyed by path relative to the content root.
 *
 * Every note's title is its leading `# Heading`; frontmatter carries tags and
 * the one declared language. The links are wikilinks by slug, which is the
 * form the existing corpus uses and `scripts/resolve-links.ts` resolves.
 */
export function graphCorpus(): Record<string, string> {
  const notes: Record<string, string> = {};
  const write = (slug: string, title: string, body: string, frontmatter: readonly string[] = []): void => {
    const head = frontmatter.length === 0 ? '' : `---\n${frontmatter.join('\n')}\n---\n\n`;
    notes[`${slug}.md`] = `${head}# ${title}\n\n${body}\n`;
  };
  const links = (slugs: readonly string[]): string => slugs.map((slug) => `[[${slug}]]`).join(' ');

  write('hub', HUB_TITLE, links(HUB_NEIGHBOURS));
  for (const peer of PEERS) {
    const frontmatter = TEAM_PEERS.includes(peer)
      ? ['tags: [team]']
      : GARDEN_SLUGS.includes(peer)
        ? ['tags: [garden]']
        : [];
    const outgoing = PEER_LINKS[peer] ?? [];
    const body = outgoing.length === 0 ? 'Body.' : `Body.\n\n${links(outgoing)}`;
    write(peer, peerTitle(peer), body, frontmatter);
  }
  write('tie-alpha', TIE_TITLE, 'No links. Identical title to tie-zeta on purpose.');
  write('tie-zeta', TIE_TITLE, 'No links. Identical title to tie-alpha on purpose.');
  write('zh-note', ZH_NOTE_TITLE, links(['plain-note']), ['language: zh-CN']);
  write('plain-note', PLAIN_NOTE_TITLE, 'No outgoing links.', ['tags: [garden]']);
  write('island', ISLAND_TITLE, 'No links, one tag.', ['tags: [garden]']);
  for (const filler of FILLERS) write(filler, fillerTitle(filler), 'Isolated.');
  return notes;
}

// --- /notes/hub/ -----------------------------------------------------------------

/**
 * The static note page before any activation.
 *
 * hub has 17 neighbours (peer-01..peer-15, tie-alpha, tie-zeta), the local
 * bound draws 12 of them, and the figure/table therefore hold 13 entries. The
 * static bound sentence states 12 of 17, and the outgoing relations list names
 * all 17 because it is the complete authored list, not the bounded drawing.
 */
export const HUB_STATIC = {
  figureNodes: 13,
  tableRows: 13,
  /** What `graphBoundedLocal` interpolates: drawn neighbours and the total. */
  shown: 12,
  total: 17,
  outgoingLinks: 17,
} as const;

/**
 * The hub page's live table after activation, hand-checked cell by cell.
 *
 * The drawn set is `HUB_LOCAL_DRAWN`, so the rows are hub then peer-01..peer-12
 * in that order. hub is the subject and its twelve drawn lines all leave it.
 * peer-01's three merged lines are hub -> peer-01, peer-01 <-> peer-02, and
 * peer-03 -> peer-01, so its joined list is hub, peer-02, peer-03 in title
 * order. peer-05 carries only the single line from hub, which is the degree-1
 * state whose accessible name uses the singular template.
 */
export const HUB_TABLE = {
  rows: HUB_STATIC.tableRows,
  hub: { relation: 'subject', degree: 12 },
  'peer-01': { relation: 'outgoing', degree: 3, joined: ['hub', 'peer-02', 'peer-03'] },
  'peer-05': { relation: 'outgoing', degree: 1 },
} as const;

/**
 * The drawn local selection's neighbour order after activation and at each
 * re-center. The first entry is always the center; the rest are the candidates
 * sorted by title then slug (the bound keeps the first twelve).
 */
export const HUB_LOCAL_DRAWN: readonly string[] = ['hub', ...PEERS.slice(0, 12)];

/** One merged SVG line, resolved to authored direction by its endpoints. */
export interface GraphEdgeOracle {
  from: string;
  to: string;
  /** Both directions authored; drawn with an arrowhead at each end. */
  mutual: boolean;
  /** The edge runs from a neighbour into the subject. None here: hub only sends. */
  incoming: boolean;
}

/**
 * The exact merged edge set for hub's local selection, in the layout's sort
 * order (`from`, then `to`).
 *
 * hub sends to each of the twelve drawn peers. Among the drawn peers the
 * authored edges are peer-01 <-> peer-02 (one mutual line), peer-02 -> peer-03,
 * peer-03 -> peer-01, and peer-04 -> peer-02. peer-01 -> zh-note is authored but
 * zh-note is not a neighbour of hub, so it is not drawn — which is the
 * neighbour-to-neighbour and outside-endpoint property this list pins.
 */
export const HUB_LOCAL_EDGES: readonly GraphEdgeOracle[] = [
  ...PEERS.slice(0, 12).map((peer) => ({ from: 'hub', to: peer, mutual: false, incoming: false })),
  { from: 'peer-01', to: 'peer-02', mutual: true, incoming: false },
  { from: 'peer-02', to: 'peer-03', mutual: false, incoming: false },
  { from: 'peer-03', to: 'peer-01', mutual: false, incoming: false },
  { from: 'peer-04', to: 'peer-02', mutual: false, incoming: false },
];

/** One activation or re-center step: which control to press, and what it draws. */
export interface RecenterStep {
  /** The slug to re-center on, or `null` for the first activation from hub. */
  center: string | null;
  drawn: readonly string[];
}

/**
 * hub -> peer-01 -> peer-02 -> peer-03 -> peer-01 -> peer-02, crossing the
 * three-cycle twice so a client that caches or accumulates is caught.
 */
export const RECENTER_SEQUENCE: readonly RecenterStep[] = [
  { center: null, drawn: HUB_LOCAL_DRAWN },
  { center: 'peer-01', drawn: ['peer-01', 'hub', 'peer-02', 'peer-03', 'zh-note'] },
  { center: 'peer-02', drawn: ['peer-02', 'hub', 'peer-01', 'peer-03', 'peer-04'] },
  { center: 'peer-03', drawn: ['peer-03', 'hub', 'peer-01', 'peer-02'] },
  { center: 'peer-01', drawn: ['peer-01', 'hub', 'peer-02', 'peer-03', 'zh-note'] },
  { center: 'peer-02', drawn: ['peer-02', 'hub', 'peer-01', 'peer-03', 'peer-04'] },
];

/**
 * One merged line as the browser gate reads it: endpoints resolved to slugs,
 * direction classes, and both marker ends.
 *
 * Extends the authored-direction oracle with the two attributes the drawing
 * adds, because a class regression that dropped `graph-edge-incoming` would
 * leave every `GraphEdgeOracle` field intact.
 */
export interface DrawnEdgeOracle extends GraphEdgeOracle {
  markerStart: boolean;
  markerEnd: boolean;
}

/**
 * The merged edge set for peer-01's local selection (`RECENTER_SEQUENCE[1]`:
 * peer-01, hub, peer-02, peer-03, zh-note), hand-computed from the corpus links
 * and the layout's `(from, to)` sort order.
 *
 * Authored edges among the five: hub -> peer-01, hub -> peer-02, hub ->
 * peer-03, peer-01 <-> peer-02, peer-02 -> peer-03, peer-03 -> peer-01, and
 * peer-01 -> zh-note. Only the lines that touch the subject carry a direction
 * on this page: hub -> peer-01 and peer-03 -> peer-01 arrive (`incoming`,
 * dashed), peer-01 <-> peer-02 is one mutual line, and peer-01 -> zh-note
 * leaves. The three neighbour-to-neighbour lines (hub -> peer-02, hub ->
 * peer-03, peer-02 -> peer-03) have no direction relative to the subject.
 * Every line points at its target; only the mutual line points at both ends.
 */
export const PEER01_LOCAL_EDGES: readonly DrawnEdgeOracle[] = [
  { from: 'hub', to: 'peer-01', mutual: false, incoming: true, markerStart: false, markerEnd: true },
  { from: 'hub', to: 'peer-02', mutual: false, incoming: false, markerStart: false, markerEnd: true },
  { from: 'hub', to: 'peer-03', mutual: false, incoming: false, markerStart: false, markerEnd: true },
  { from: 'peer-01', to: 'peer-02', mutual: true, incoming: false, markerStart: true, markerEnd: true },
  { from: 'peer-01', to: 'zh-note', mutual: false, incoming: false, markerStart: false, markerEnd: true },
  { from: 'peer-02', to: 'peer-03', mutual: false, incoming: false, markerStart: false, markerEnd: true },
  { from: 'peer-03', to: 'peer-01', mutual: false, incoming: true, markerStart: false, markerEnd: true },
];

/**
 * Every `localGraph` reply the merged hub page session asks for, by the center
 * each carries, in order: the keyboard activation, the keyboard reset (which
 * returns to the origin), then each step of `RECENTER_SEQUENCE`.
 *
 * Hand-listed, because the point of the assertion is that exactly one reply
 * reaches the screen per intent — no redraw from a cached selection, no reply
 * silently dropped. A list read back from the page could not say that.
 */
export const HUB_REPLY_CENTERS: readonly string[] = [
  'hub',
  'hub',
  'peer-01',
  'peer-02',
  'peer-03',
  'peer-01',
  'peer-02',
];

// --- /graph/ ---------------------------------------------------------------------

/**
 * The unfiltered global drawing: 60 of 65, ranked by degree descending then
 * title/slug.
 *
 * Degrees: hub 17; peer-01/peer-02 4; peer-03 3; peer-04 and zh-note 2;
 * peer-05..peer-15, plain-note, tie-alpha, and tie-zeta 1; fillers and island
 * 0. The title `中文笔记` sorts after `Peer 04` by code unit, and `Tie` breaks
 * its two-way tie on slug (alpha < zeta).
 */
export const GLOBAL_DRAWN: readonly string[] = [
  'hub',
  'peer-01',
  'peer-02',
  'peer-03',
  'peer-04',
  'zh-note',
  ...PEERS.slice(4),
  'plain-note',
  'tie-alpha',
  'tie-zeta',
  ...FILLERS.slice(0, 40),
];

/** The five the global bound drops: the four lowest-ranked fillers and island. */
export const GLOBAL_OMITTED: readonly string[] = [...FILLERS.slice(40), 'island'];

/** team's in-tag degrees are all 2 and the induced edges all touch members. */
export const TEAM_DRAWN: readonly string[] = ['peer-01', 'peer-02', 'peer-03'];
export const TEAM_EDGE_COUNT = 3;

/** garden's three members have no edge among them; title order decides. */
export const GARDEN_DRAWN: readonly string[] = ['island', 'peer-04', 'plain-note'];
export const GARDEN_EDGE_COUNT = 0;

// --- Mixed-language expansion ----------------------------------------------------

/** One rendered anchor's slug and `lang` attribute, with `null` for absent. */
export interface AnchorLanguage {
  slug: string;
  lang: string | null;
}

/**
 * peer-01's local selection is English chrome around a Chinese neighbour.
 * `partLanguage` marks only the title whose own language differs from the
 * page's, so three of the page's anchors carry `lang="zh-CN"`: the zh-note
 * figure node, the zh-note table row head, and the zh-note entry in peer-01's
 * joined list.
 */
export const PEER01_DRAWN: readonly string[] = ['peer-01', 'hub', 'peer-02', 'peer-03', 'zh-note'];
export const PEER01_FIGURE_LANGS: readonly AnchorLanguage[] = [
  { slug: 'peer-01', lang: null },
  { slug: 'hub', lang: null },
  { slug: 'peer-02', lang: null },
  { slug: 'peer-03', lang: null },
  { slug: 'zh-note', lang: 'zh-CN' },
];
/**
 * The table anchors in DOM order: each row's head link, then its joined list.
 * peer-01's row joins hub, peer-02, peer-03, zh-note; hub's row joins its three
 * drawn peers in this selection (peer-01, peer-02, peer-03 — not the twelve it
 * joins on its own page); peer-02's joins hub, peer-01, peer-03; peer-03's
 * joins hub, peer-01, peer-02; zh-note's joins peer-01. 19 anchors, two of them
 * zh-CN: the zh-note entry in peer-01's joined list (the fifth) and zh-note's
 * own row head (the eighteenth).
 */
export const PEER01_TABLE_LANGS: readonly AnchorLanguage[] = [
  { slug: 'peer-01', lang: null },
  { slug: 'hub', lang: null },
  { slug: 'peer-02', lang: null },
  { slug: 'peer-03', lang: null },
  { slug: 'zh-note', lang: 'zh-CN' },
  { slug: 'hub', lang: null },
  { slug: 'peer-01', lang: null },
  { slug: 'peer-02', lang: null },
  { slug: 'peer-03', lang: null },
  { slug: 'peer-02', lang: null },
  { slug: 'hub', lang: null },
  { slug: 'peer-01', lang: null },
  { slug: 'peer-03', lang: null },
  { slug: 'peer-03', lang: null },
  { slug: 'hub', lang: null },
  { slug: 'peer-01', lang: null },
  { slug: 'peer-02', lang: null },
  { slug: 'zh-note', lang: 'zh-CN' },
  { slug: 'peer-01', lang: null },
];

/**
 * zh-note's page is Chinese chrome. Its only neighbour from the page is
 * peer-01, and plain-note is reached from that drawn set; neither declares a
 * language, so both are the navigation language `en` and carry `lang="en"` on
 * a zh-CN document. The center needs none.
 */
export const ZH_NOTE_DRAWN: readonly string[] = ['zh-note', 'peer-01', 'plain-note'];
export const ZH_NOTE_FIGURE_LANGS: readonly AnchorLanguage[] = [
  { slug: 'zh-note', lang: null },
  { slug: 'peer-01', lang: 'en' },
  { slug: 'plain-note', lang: 'en' },
];
export const ZH_NOTE_TABLE_LANGS: readonly AnchorLanguage[] = [
  { slug: 'zh-note', lang: null },
  { slug: 'peer-01', lang: 'en' },
  { slug: 'plain-note', lang: 'en' },
  { slug: 'peer-01', lang: 'en' },
  { slug: 'zh-note', lang: null },
  { slug: 'plain-note', lang: 'en' },
  { slug: 'zh-note', lang: null },
];
