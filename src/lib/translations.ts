/**
 * Every chrome string the site renders, in both public languages.
 *
 * **Chrome, never content.** A title, an excerpt, a tag, a collection name, and
 * an article body are the author's words in the author's language, and they are
 * reproduced verbatim on every page regardless of which locale resolved around
 * them. A tag reading `security` stays `security` on a Chinese page. What lives
 * here is the interface the site wraps that content in — the words this
 * repository authored rather than the ones the artifact carried.
 *
 * **Per document, not per site.** {@link translate} is keyed on one document's
 * own `language` field, so a zh-CN note renders Chinese chrome and an English
 * note renders English chrome *in the same build*. That is the structural
 * difference from Quartz, whose `cfg.locale` is a single global read by every
 * plugin: there a zh-CN document renders `lang="zh"` around English chrome,
 * because the document's language and the interface language cannot disagree
 * when only one of them exists. Here `language` is a per-entry field on a
 * validated contract (`src/lib/schema.ts`), so the two are separate facts and
 * the interface follows the document.
 *
 * **Which routes are documents.** A route that renders exactly one artifact
 * entry — `/notes/<slug>/` — resolves its chrome from that entry. Every other
 * route resolves to {@link NAV_LANGUAGE}: the home page, `/recent/`, the tag and
 * collection indexes, a facet page, and the 404 each aggregate many entries or
 * none, so there is no single document language to read. Picking one member's
 * language would make the chrome of `/tags/gardening/` depend on which note
 * sorts first, which is a public page changing language because an unrelated
 * note was published.
 *
 * **The contract is compile-checked.** Each locale ends `as const satisfies
 * Translation`, so a key added to {@link Translation} and forgotten in either
 * locale is a type error at `pnpm run check` — never a runtime fallback that
 * renders the key name to a reader. `tests/translations.test.ts` proves that
 * property by type-checking a locale with a key removed.
 *
 * **No ICU runtime, and none needed.** The strings that carry a count are
 * functions. English pluralises and Chinese does not, and a function-valued
 * entry expresses both without a plural-rules library — and without the defect a
 * shared `count === 1 ? singular : plural` helper would bake in, which is that
 * it produces nonsense the moment it is applied to a language with no plural.
 * Each locale states its own rule.
 *
 * **Zero client-side locale lookup.** Resolution happens during the build. The
 * scripts that write text — theme, search status, and code copy — read strings
 * the build already resolved out of `data-` attributes, so none ships a locale
 * table or knows a locale exists.
 */

/** The theme names the toggle cycles through, in cycle order. */
export const THEME_NAMES = ['system', 'light', 'dark'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/**
 * The `dataset` key carrying each theme's label, and each search state's
 * sentence, on the element the build writes them to.
 *
 * These pair a *script's* lookup with an *attribute* in the markup, and neither
 * side type-checks the other: `dataset[key]` is `string | undefined` for any
 * string, so a rename on either side is a toggle rendering the raw English state
 * name inside Chinese chrome, or a status line that silently goes blank.
 *
 * They live here, in the module with no DOM, rather than beside the scripts that
 * index them, for two reasons. The gate over `dist/` has to read *these objects*
 * to check the pairing, and importing a client script under Node runs its
 * top-level `document` access. And the layout writes its attributes from the
 * same values through {@link datasetAttribute}, so the two spellings are now
 * derived from one string rather than written twice — a rename here changes
 * both sides together, which is what makes the divergence impossible rather
 * than merely detectable.
 *
 * Restating the keys in the test instead was tried and is not equivalent: it
 * catches a rename in the markup and misses one in the script, which is the
 * direction that ships the defect. Verified by mutation.
 */
export const THEME_DATASET: Readonly<Record<ThemeName, string>> = {
  system: 'labelSystem',
  light: 'labelLight',
  dark: 'labelDark',
};

/**
 * The attribute name the DOM maps a `dataset` key from: `messageIdle` becomes
 * `data-message-idle`.
 *
 * The layout writes attributes through this and the scripts read the keys
 * directly, so the two spellings are derived from one value rather than written
 * twice — which is what makes a rename impossible to get half-right.
 */
export function datasetAttribute(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** The four announceable search states. `ready` renders no sentence — see `announce`. */
export const MESSAGE_DATASET = {
  idle: 'messageIdle',
  loading: 'messageLoading',
  empty: 'messageEmpty',
  failed: 'messageFailed',
} as const;

/** The tag browser's live-status sentences, carried from the build as data attributes. */
export const TAG_BROWSE_DATASET = {
  loading: 'tagBrowseLoading',
  empty: 'tagBrowseEmpty',
  exhausted: 'tagBrowseExhausted',
  unknown: 'tagBrowseUnknown',
  failed: 'tagBrowseFailed',
} as const;

/**
 * The site navigation language: what a route that is not one document renders,
 * and what a document carrying no `language` falls back to.
 *
 * The published corpus is exactly that fallback case — its single note declares
 * no language — so this is the resolution most pages actually take.
 */
export const NAV_LANGUAGE = 'en';

/**
 * Every string the interface says to a reader.
 *
 * Grouped by the surface that renders it, which is also the order the surfaces
 * appear in the document. A string used by two surfaces is named for what it
 * says rather than for either one.
 */
export interface Translation {
  // --- Document shell --------------------------------------------------------
  skipToContent: string;
  /** Accessible name of the header's `<nav>`. */
  primaryNavLabel: string;
  /** Accessible name of the footer's `<nav>`. */
  siteMapLabel: string;
  siteSubtitle: string;
  /** The `<meta name="description">` a page falls back to when it has none. */
  siteDescription: string;
  /** The printed page's own address, since a printed page has no address bar. */
  publishedAt: (url: string) => string;
  /**
   * The feed's name, as the `<link rel="alternate">` in every page's head states
   * it. A reader's feed client shows this when subscribing, so it is chrome that
   * reaches a person even though no page renders it visibly.
   */
  feedTitle: (siteName: string) => string;
  /**
   * Alternative text for the social card image.
   *
   * The card is one rendering of the site's own mark, identical on every route,
   * so the text says what it *is* rather than describing the page. It is read
   * aloud by a client that cannot show the image, which makes it chrome a person
   * meets in whatever language the document is in.
   */
  socialCardAlt: (siteName: string) => string;

  // --- Navigation labels -----------------------------------------------------
  // `routes.ts` holds the hrefs and names one of these keys per item; the label
  // itself is resolved here so a route is not also a string in one language.
  navHome: string;
  navNotes: string;
  navRecent: string;
  navTags: string;
  navCollections: string;
  navGraph: string;
  navAbout: string;
  navPrivacy: string;

  // --- Toggles ---------------------------------------------------------------
  searchToggle: string;
  /** Accessible name of the search trigger; states the keyboard shortcut. */
  searchToggleLabel: string;
  themeLabel: (theme: ThemeName) => string;
  readerToggle: string;

  // --- Search dialog ---------------------------------------------------------
  searchDialogLabel: string;
  searchClose: string;
  searchFieldLabel: string;
  searchIdle: string;
  searchLoading: string;
  searchEmpty: string;
  searchFailed: string;

  // --- Explorer rail ---------------------------------------------------------
  explorerHeading: string;
  /** Link to a collection's own index, from inside its group. */
  explorerIndex: (collection: string) => string;
  /** The group holding notes that carry no collection. */
  uncollected: string;
  /**
   * What a windowed group states: how many of its notes the rail drew.
   *
   * The same shape `graphBounded` uses, for the same reason — a bounded view has
   * to say it is bounded, or the count beside the label and the rows under it
   * are a contradiction the reader has to resolve. `GROUP_WINDOW` carries why
   * the rail is bounded at all.
   */
  explorerBounded: (shown: number, total: number) => string;
  /**
   * The expansion action on a group with no collection index to link.
   *
   * The uncollected group has no route of its own. Root-level notes still land
   * there because the producer derives collections only from a first folder, so
   * a bounded group needs a way out. It points at the home page, which lists
   * every published note.
   */
  explorerExpand: string;
  explorerExpandLabel: string;

  // --- Note lists ------------------------------------------------------------
  readNote: string;
  noNotesYet: string;
  noteCount: (count: number) => string;

  // --- Home ------------------------------------------------------------------
  homeDescription: string;
  homeEyebrow: string;
  homeHeading: string;
  homeIntro: string;
  homeNotesHeading: string;
  publishedCount: (count: number) => string;

  // --- Recent ----------------------------------------------------------------
  recentTitle: string;
  recentDescription: string;
  /** How the list is ordered, when the artifact carries dates. */
  recentOrderedByDate: string;
  /** How it is ordered when it does not, said plainly rather than implied. */
  recentOrderedBySlug: string;

  // --- Tag and collection indexes -------------------------------------------
  tagsTitle: string;
  tagsDescription: string;
  tagCount: (count: number) => string;
  tagsEmpty: string;
  /** Heading over the in-page tag browser. */
  tagBrowseHeading: string;
  /** Visible text of the control that starts an enumeration. */
  tagBrowseStart: string;
  /** Accessible label of the tag chooser. */
  tagBrowseSelectLabel: string;
  /** The chooser's placeholder option, before a tag is chosen. */
  tagBrowsePrompt: string;
  /** Visible text of the next-page control. */
  tagBrowseMore: string;
  /** Status while a page is in flight. */
  tagBrowseLoading: string;
  /** A canonical tag the snapshot carries but whose page is empty. */
  tagBrowseEmpty: string;
  /** Every result page has been delivered. */
  tagBrowseExhausted: string;
  /** The snapshot carries no such canonical tag. */
  tagBrowseUnknown: string;
  /** A page could not be delivered; the static list remains. */
  tagBrowseFailed: string;
  collectionsTitle: string;
  collectionsDescription: string;
  collectionCount: (count: number) => string;
  collectionsEmpty: string;
  /** Why the collections here are not a private folder structure. */
  collectionsNote: string;

  // --- Facet pages -----------------------------------------------------------
  tagPageTitle: (tag: string) => string;
  tagPageDescription: (tag: string) => string;
  allTags: string;
  collectionPageTitle: (collection: string) => string;
  collectionPageDescription: (collection: string) => string;
  allCollections: string;

  // --- Note page -------------------------------------------------------------
  breadcrumbLabel: string;
  metaPublished: string;
  metaUpdated: string;
  metaCollection: string;
  metaTags: string;
  metaAliases: string;
  tocHeading: string;
  /**
   * Accessible name of a heading's own anchor link.
   *
   * Rendered by the Markdown pipeline into the *article*, once per heading, and
   * it is chrome rather than content: the heading text inside it is the
   * author's, the words around it are this repository's. `renderMarkdown` takes
   * it as an option, which is why it reaches a per-document locale at all.
   */
  headingAnchorLabel: (heading: string) => string;
  codeCopy: string;
  codeCopied: string;
  codeCopyFailed: string;
  /**
   * The heading that opens the footnotes section, which GFM emits at the end of
   * an article that has any. Visually hidden, so a screen reader is the only
   * reader who meets it — which makes its language an accessibility property.
   */
  footnotesHeading: string;
  /**
   * Accessible name of the arrow that returns from a footnote to the passage
   * citing it. `reference` is the citation's number, or `n-K` where one footnote
   * is cited more than once; it is a positional label, not prose, so it is
   * interpolated rather than described.
   */
  footnoteBackLabel: (reference: string) => string;
  /**
   * A diagram's caption when the diagram declares no title of its own.
   *
   * The kind — "Flowchart", "Sequence" — comes from the Mermaid fence and stays
   * as written; only the noun after it is chrome. A page with three untitled
   * diagrams would otherwise give a screen reader three identically named
   * figures, which is the defect the caption exists to avoid.
   */
  diagramCaption: (kind: string) => string;
  outgoingHeading: string;
  outgoingEmpty: string;
  backlinksHeading: string;
  backlinksEmpty: string;
  relatedHeading: string;
  /** How the related list was derived, since nobody authored it. */
  relatedDerivation: string;
  /** Nothing shares a tag with this note. */
  relatedNoTagPeer: string;
  /** Everything that shares a tag is already rendered above. */
  relatedAlreadyListed: string;
  /** Accessible name of the collection pager. */
  moreInCollection: (collection: string) => string;
  pagerPrevious: string;
  pagerNext: string;
  noteProvenance: string;
  canonicalUrlLine: (url: string) => string;

  // --- Graph -----------------------------------------------------------------
  // The figure is inline SVG with real links, so every one of these is read by
  // somebody: as a heading, as an accessible name inside the SVG, or as a
  // column in the equivalent table requirements section 17 requires.
  graphHeading: string;
  graphTitle: string;
  graphDescription: string;
  /** How the picture was built, since a reader cannot see a layout rule. */
  graphLocalDerivation: string;
  graphGlobalDerivation: string;
  /**
   * Accessible name of the figure itself, naming what it draws.
   *
   * An `<svg role="group">` needs a name or a screen reader announces an
   * unnamed container and the counts go unsaid. It states them because the
   * picture's size is the first thing a sighted reader takes in and the one
   * thing a non-visual reader cannot.
   */
  graphFigureLabel: (nodes: number, edges: number) => string;
  /**
   * A node's accessible name: the note, how it relates, and how many links the
   * figure draws touching it.
   *
   * `relation` is one of the three direction words below, already resolved.
   * Assembled by the locale rather than concatenated at the call site because
   * Chinese puts the relation before the title and English after it.
   */
  graphNodeLabel: (title: string, relation: string, degree: number) => string;
  /** The note the reader is on, which has no direction relative to itself. */
  graphSubjectRelation: string;
  graphOutgoingRelation: string;
  graphIncomingRelation: string;
  graphMutualRelation: string;
  /** No direction at all: `/graph/` has no subject to be relative to. */
  graphLinkedRelation: string;
  // --- Interactive graph explorer (goal 0005). Templates for the client. ---
  /** Visible text of the control that starts live exploration. */
  graphExplorerOpen: string;
  /** Visible text of the reset control. */
  graphExplorerReset: string;
  /** Visible text of a re-center control. */
  graphExplorerRecenter: string;
  /**
   * Accessible name of a re-center control, naming the note it acts on.
   *
   * The visible text is identical on every row, so a table of these controls
   * gives a screen-reader user one "Re-center" after another with nothing to
   * choose between them; the note's own title is what distinguishes them.
   * `{title}` is an ordinary interpolated token, like the status sentences:
   * both locales place it among their own words, `NoteGraph.astro` emits the
   * template, and the client fills each row's title — so the build resolves
   * the word order and the browser bundle still ships no locale table.
   */
  graphExplorerRecenterLabel: string;
  /** Accessible label of the tag filter chooser. */
  graphExplorerFilterLabel: string;
  /** The filter's "no filter" option. */
  graphExplorerFilterAll: string;
  /** Live status: local scope. `{shown}` and `{total}` are numbers. */
  graphExplorerStatusLocal: string;
  /** Live status: global scope. */
  graphExplorerStatusGlobal: string;
  /** Live status: tag-filtered global scope. `{tag}` is artifact text. */
  graphExplorerStatusFiltered: string;
  /** A live graph could not be produced; the static figure remains. */
  graphExplorerFailed: string;
  /** The requested center is not in the snapshot. */
  graphExplorerUnknownCenter: string;
  /** A tag filter matched nothing. */
  graphExplorerEmptyFilter: string;
  /** Enhanced node label, plural. `{title}`, `{relation}`, `{degree}`. */
  graphExplorerNodeLabel: string;
  /** Enhanced node label, singular (degree 1). */
  graphExplorerNodeLabelOne: string;
  /** The equivalent table's caption and column headers. */
  graphTableCaption: string;
  graphColumnNote: string;
  graphColumnRelation: string;
  graphColumnLinks: string;
  /**
   * The column naming the notes at the other end of each row's lines.
   *
   * This column is what makes the table *equivalent* rather than a summary
   * (requirements section 17): without it a non-visual reader gets each node's
   * degree — how many lines touch it — and never which notes they run to. On
   * `/graph/`, where no node has a relationship to a subject, it is the only
   * place the edge set appears at all.
   */
  graphColumnLinkedTo: string;
  /** A drawn node joined to nothing else drawn. Said, not left blank. */
  graphNoLinks: string;
  /**
   * The bound, stated on its face, with the expansion action beside it.
   *
   * Two sentences because the two graphs truncate on different rules and a
   * shared one would misdescribe whichever it was not written for: the
   * neighbourhood keeps the alphabetically first notes, and `/graph/` keeps the
   * most linked. Each names its own rule, and each links to the surface that
   * has no bound at all — the neighbourhood to `/graph/`, and `/graph/` to the
   * home page's complete listing. That is requirements section 13.2's explicit
   * expansion action.
   */
  graphBoundedLocal: (shown: number, total: number) => string;
  graphBounded: (shown: number, total: number) => string;
  graphExpandLocal: string;
  graphExpandLocalLabel: string;
  graphExpand: string;
  graphExpandLabel: string;
  /** Nothing to draw: the published corpus's own case. */
  graphEmpty: string;
  graphSiteEmpty: string;

  // --- 404 -------------------------------------------------------------------
  notFoundTitle: string;
  notFoundDescription: string;
  notFoundBody: string;
  notFoundWhereTo: string;

  // --- Withheld ---------------------------------------------------------------
  // One page, reached by every link whose target this build did not publish.
  // Every string here is written to say what is true of *any* such target
  // without naming one: this page has no subject, because it is the same static
  // document whichever link led to it.
  withheldTitle: string;
  withheldDescription: string;
  /** What happened, in the first sentence a reader meets. */
  withheldBody: string;
  /**
   * That it will not change, said plainly.
   *
   * A page saying only "not published" invites a reader to come back and check.
   * Nothing here schedules a publication, and implying one would be a promise
   * the tool cannot keep on the author's behalf.
   */
  withheldPermanence: string;
  // The heading over the way out is `notFoundWhereTo`, reused rather than
  // duplicated: this page and the 404 offer the identical list for the identical
  // reason, and a second key holding the same sentence is one that can drift
  // into a different sentence with nothing to notice. `tests/translations.test.ts`
  // compares across locales, not within one, so a within-locale duplicate is
  // invisible to it.
}

const EN = {
  skipToContent: 'Skip to content',
  primaryNavLabel: 'Primary',
  siteMapLabel: 'Site map',
  siteSubtitle: 'Notes, published as a static site.',
  siteDescription: 'A collection of notes, published as static pages.',
  publishedAt: (url) => `Published at ${url}`,
  feedTitle: (siteName) => `${siteName} — all notes`,
  socialCardAlt: (siteName) => `${siteName} — a collection of notes`,

  navHome: 'Home',
  navNotes: 'Notes',
  navRecent: 'Recent',
  navTags: 'Tags',
  navCollections: 'Collections',
  navGraph: 'Graph',
  navAbout: 'About',
  navPrivacy: 'Privacy',

  searchToggle: 'Search',
  searchToggleLabel: 'Search this site (press slash)',
  themeLabel: (theme) => `Theme: ${theme}`,
  readerToggle: 'Reader mode',

  searchDialogLabel: 'Search',
  searchClose: 'Close search',
  searchFieldLabel: 'Search this site',
  searchIdle: 'Type to search this site.',
  searchLoading: 'Loading the search index…',
  searchEmpty: 'No results. Try a different word.',
  searchFailed:
    'The search index could not be loaded. The rest of this page still works — press Enter to try again.',

  explorerHeading: 'Browse collections',
  explorerIndex: (collection) => `All ${collection} notes`,
  explorerBounded: (shown, total) => `Showing ${shown} of ${total}.`,
  explorerExpand: 'See every published note →',
  explorerExpandLabel: 'See every published note, including those this rail does not list',
  uncollected: 'Uncollected',

  readNote: 'Read note →',
  noNotesYet: 'No notes are published yet.',
  noteCount: (count) => `${count} ${count === 1 ? 'note' : 'notes'}`,

  homeDescription: 'A collection of notes, published as static pages.',
  homeEyebrow: 'NOTES',
  homeHeading: 'Notes, in the open.',
  homeIntro:
    'Written as plain Markdown and published as static pages. Notes link to each other, and every ' +
    'link that appears here leads to a note that is published.',
  homeNotesHeading: 'Notes',
  publishedCount: (count) => `${count} published`,

  recentTitle: 'Recent',
  recentDescription: 'Published notes in order of when they last changed.',
  recentOrderedByDate:
    'Ordered by when each note was last updated, most recent first. Notes with no recorded date ' +
    'follow, in alphabetical order by slug.',
  recentOrderedBySlug:
    'These notes carry no publication dates, so they are listed in alphabetical order by slug. ' +
    'This page will order by update date as soon as any note records one.',

  tagsTitle: 'Tags',
  tagsDescription: 'Every tag on a published note.',
  tagCount: (count) => `${count} ${count === 1 ? 'tag' : 'tags'}`,
  tagsEmpty: 'No published note carries a tag yet. This page lists every tag as soon as one does.',
  tagBrowseHeading: 'Browse this tag here',
  tagBrowseStart: 'Load notes from the live index',
  tagBrowseSelectLabel: 'Tag to browse',
  tagBrowsePrompt: 'Choose a tag\u2026',
  tagBrowseMore: 'Load more',
  tagBrowseLoading: 'Loading notes\u2026',
  tagBrowseEmpty: 'No published note carries this tag in the live index.',
  tagBrowseExhausted: 'All matching notes are shown.',
  tagBrowseUnknown: 'That tag is not in the live index.',
  tagBrowseFailed: 'The live index could not be loaded. The static list above is complete.',
  collectionsTitle: 'Collections',
  collectionsDescription: 'The collections published notes are grouped into.',
  collectionCount: (count) => `${count} ${count === 1 ? 'collection' : 'collections'}`,
  collectionsEmpty:
    'No published note belongs to a collection yet, so every note lives in one flat namespace. ' +
    'This page lists each collection as soon as one does.',
  collectionsNote:
    'Collections group notes for reading. They are a property of what is published here and do ' +
    'not reflect how anything is organized elsewhere.',

  tagPageTitle: (tag) => `Tag: ${tag}`,
  tagPageDescription: (tag) => `Published notes tagged ${tag}.`,
  allTags: '← All tags',
  collectionPageTitle: (collection) => `Collection: ${collection}`,
  collectionPageDescription: (collection) => `Published notes in the ${collection} collection.`,
  allCollections: '← All collections',

  breadcrumbLabel: 'Breadcrumb',
  metaPublished: 'Published',
  metaUpdated: 'Updated',
  metaCollection: 'Collection',
  metaTags: 'Tags',
  metaAliases: 'Also known as',
  tocHeading: 'On this page',
  headingAnchorLabel: (heading) => `Link to section: ${heading}`,
  codeCopy: 'Copy code',
  codeCopied: 'Copied',
  codeCopyFailed: 'Copy failed',
  footnotesHeading: 'Footnotes',
  footnoteBackLabel: (reference) => `Back to reference ${reference}`,
  diagramCaption: (kind) => `${kind} diagram`,
  outgoingHeading: 'Links to',
  outgoingEmpty: 'This note links to no other published note.',
  backlinksHeading: 'Linked from',
  backlinksEmpty: 'No published note links here yet.',
  relatedHeading: 'Related notes',
  relatedDerivation:
    'Suggested by shared tags, the tag grouping fewest notes first. Notes already listed above ' +
    'are excluded.',
  relatedNoTagPeer: 'No other published note shares a tag with this one.',
  relatedAlreadyListed: 'Every note sharing a tag with this one is already listed above.',
  moreInCollection: (collection) => `More in the ${collection} collection`,
  pagerPrevious: 'Previous',
  pagerNext: 'Next',
  noteProvenance:
    'Published from a note written in Markdown, and served as a static page. Links here lead only ' +
    'to notes that are published.',
  canonicalUrlLine: (url) => `Canonical URL: ${url}`,

  graphHeading: 'Nearby notes',
  graphTitle: 'Graph',
  graphDescription: 'How the published notes link to each other.',
  graphLocalDerivation:
    'Every note one link away from this one, drawn with the links between them. Laid out when the ' +
    'site was built, so it needs no scripting.',
  graphGlobalDerivation:
    'The most linked notes on the site, most connected at the centre. Laid out when the site was ' +
    'built, so it needs no scripting.',
  graphFigureLabel: (nodes, edges) =>
    `Link graph: ${nodes} ${nodes === 1 ? 'note' : 'notes'}, ${edges} ${edges === 1 ? 'link' : 'links'}`,
  graphNodeLabel: (title, relation, degree) =>
    `${title} — ${relation}, ${degree} ${degree === 1 ? 'link' : 'links'} drawn`,
  graphSubjectRelation: 'this note',
  graphOutgoingRelation: 'linked from this note',
  graphIncomingRelation: 'links to this note',
  graphMutualRelation: 'linked both ways',
  graphLinkedRelation: 'published note',
  graphExplorerOpen: 'Explore interactively',
  graphExplorerReset: 'Reset',
  graphExplorerRecenter: 'Re-center',
  graphExplorerRecenterLabel: 'Re-center on {title}',
  graphExplorerFilterLabel: 'Tag',
  graphExplorerFilterAll: 'All notes',
  graphExplorerStatusLocal: 'Live graph: {shown} of {total} neighbouring notes drawn.',
  graphExplorerStatusGlobal: 'Live graph: {shown} of {total} published notes drawn.',
  graphExplorerStatusFiltered: 'Live graph for tag {tag}: {shown} of {total} matching notes drawn.',
  graphExplorerFailed: 'The live graph could not be loaded. The static figure above is complete.',
  graphExplorerUnknownCenter: 'That note is not in the live index.',
  graphExplorerEmptyFilter: 'No published note carries that tag.',
  graphExplorerNodeLabel: '{title} — {relation}, {degree} links drawn',
  graphExplorerNodeLabelOne: '{title} — {relation}, {degree} link drawn',
  graphTableCaption: 'The same notes and links, as a table',
  graphColumnNote: 'Note',
  graphColumnRelation: 'Relationship',
  graphColumnLinks: 'Links drawn',
  graphColumnLinkedTo: 'Linked to',
  graphNoLinks: 'Nothing else drawn here',
  graphBoundedLocal: (shown, total) =>
    `Drawing ${shown} of ${total} neighbouring notes, in alphabetical order. The lists above name ` +
    'every one of them.',
  graphBounded: (shown, total) => `Drawing ${shown} of ${total} notes, the most linked first.`,
  graphExpandLocal: 'See the whole graph →',
  graphExpandLocalLabel: 'See the whole graph of every published note',
  graphExpand: 'See every published note →',
  graphExpandLabel: 'See every published note, including those this graph does not draw',
  graphEmpty:
    'No published note links to this one and it links to none, so there is no neighbourhood to draw.',
  graphSiteEmpty:
    'No two published notes link to each other yet, so there is no graph to draw. This page fills ' +
    'in as more notes link to each other.',

  notFoundTitle: 'Page not found',
  notFoundDescription: 'That page is not part of this site.',
  notFoundBody:
    'That address does not match a published page. It may have been withdrawn, moved, or never ' +
    'have existed here. Use one of the current destinations below.',
  notFoundWhereTo: 'Where to go instead',

  withheldTitle: 'Not published',
  withheldDescription: 'The note this link points at is not part of this site.',
  withheldBody:
    'A published note links here, and the note it names was not published. Its text, its title, ' +
    'and everything else about it are absent from this site — the link you followed is the only ' +
    'trace of it here, and the words in that link were written by the author of the note you came ' +
    'from.',
  withheldPermanence:
    'This is not a page that fills in later. Nothing about the excluded note is scheduled for ' +
    'publication, and this address will say the same thing whenever you return to it.',
} as const satisfies Translation;

/**
 * Simplified Chinese.
 *
 * Three things differ from a transliteration of the English, and each is a
 * property of the language rather than a stylistic choice:
 *
 * 1. **No plural.** `noteCount`, `tagCount`, `collectionCount`, and
 *    `publishedCount` take a measure word and are invariant in number. Applying
 *    English's `count === 1` rule here would produce a form the language does
 *    not have.
 * 2. **Full-width punctuation.** `：`, `，`, and `。` are the Chinese forms; the
 *    ASCII ones read as a typographic error. The em dash in `searchFailed`
 *    becomes a comma, because a Chinese sentence does not use one for that
 *    clause boundary.
 * 3. **Modifier before head.** `explorerIndex` and `moreInCollection` place the
 *    collection name before the noun with `的` rather than after it, so the
 *    interpolated value cannot be assembled by the same template as English.
 */
const ZH_CN = {
  skipToContent: '跳到正文',
  primaryNavLabel: '主导航',
  siteMapLabel: '站点地图',
  siteSubtitle: '笔记，以静态站点的形式发布。',
  siteDescription: '一组以静态页面形式发布的笔记。',
  publishedAt: (url) => `本页地址：${url}`,
  feedTitle: (siteName) => `${siteName} — 全部笔记`,
  socialCardAlt: (siteName) => `${siteName} — 一组笔记`,

  navHome: '首页',
  navNotes: '笔记',
  navRecent: '最近更新',
  navTags: '标签',
  navCollections: '合集',
  navGraph: '关系图',
  navAbout: '关于',
  navPrivacy: '隐私',

  searchToggle: '搜索',
  searchToggleLabel: '搜索本站（按斜杠键）',
  themeLabel: (theme) => `主题：${{ system: '跟随系统', light: '浅色', dark: '深色' }[theme]}`,
  readerToggle: '阅读模式',

  searchDialogLabel: '搜索',
  searchClose: '关闭搜索',
  searchFieldLabel: '搜索本站',
  searchIdle: '输入内容以搜索本站。',
  searchLoading: '正在加载搜索索引…',
  searchEmpty: '没有匹配的结果，换一个词试试。',
  searchFailed: '搜索索引加载失败。本页其余内容仍可正常使用，按回车键重试。',

  explorerHeading: '浏览合集',
  explorerIndex: (collection) => `${collection} 的全部笔记`,
  explorerBounded: (shown, total) => `共 ${total} 篇，此处列出 ${shown} 篇。`,
  explorerExpand: '查看全部公开笔记 →',
  explorerExpandLabel: '查看全部公开笔记，包括本导航栏未列出的部分',
  uncollected: '未归入合集',

  readNote: '阅读全文 →',
  noNotesYet: '目前还没有公开的笔记。',
  noteCount: (count) => `${count} 篇笔记`,

  homeDescription: '一组以静态页面形式发布的笔记。',
  homeEyebrow: '笔记',
  homeHeading: '公开的笔记。',
  homeIntro:
    '以纯 Markdown 写成，并以静态页面发布。笔记之间相互链接，站内出现的每一个链接都指向' +
    '一篇已公开的笔记。',
  homeNotesHeading: '笔记',
  publishedCount: (count) => `已公开 ${count} 篇`,

  recentTitle: '最近更新',
  recentDescription: '按最后修改时间排列的公开笔记。',
  recentOrderedByDate:
    '按每篇笔记最后更新的时间排列，最新的在前。没有记录日期的笔记排在其后，' +
    '并按 slug 的字母顺序排列。',
  recentOrderedBySlug:
    '这些笔记没有记录发布日期，因此按 slug 的字母顺序排列。' +
    '一旦有笔记记录了日期，本页将改为按更新时间排序。',

  tagsTitle: '标签',
  tagsDescription: '公开笔记上的全部标签。',
  tagCount: (count) => `${count} 个标签`,
  tagsEmpty: '目前还没有公开笔记带有标签。一旦有笔记带上标签，本页将逐个列出。',
  tagBrowseHeading: '在此浏览这个标签',
  tagBrowseStart: '从实时索引加载笔记',
  tagBrowseSelectLabel: '要浏览的标签',
  tagBrowsePrompt: '选择一个标签\u2026',
  tagBrowseMore: '加载更多',
  tagBrowseLoading: '正在加载笔记\u2026',
  tagBrowseEmpty: '实时索引中没有公开笔记带有这个标签。',
  tagBrowseExhausted: '已显示全部匹配的笔记。',
  tagBrowseUnknown: '实时索引中没有这个标签。',
  tagBrowseFailed: '实时索引加载失败；上方静态列表仍然完整。',
  collectionsTitle: '合集',
  collectionsDescription: '公开笔记所归入的合集。',
  collectionCount: (count) => `${count} 个合集`,
  collectionsEmpty:
    '目前还没有公开笔记归入合集，因此所有笔记都位于同一个扁平命名空间中。' +
    '一旦有笔记归入合集，本页将逐个列出。',
  collectionsNote:
    '合集用于组织阅读。它们只反映本站公开内容的归类方式，并不反映其他地方的组织方式。',

  tagPageTitle: (tag) => `标签：${tag}`,
  tagPageDescription: (tag) => `带有 ${tag} 标签的公开笔记。`,
  allTags: '← 全部标签',
  collectionPageTitle: (collection) => `合集：${collection}`,
  collectionPageDescription: (collection) => `${collection} 合集中的公开笔记。`,
  allCollections: '← 全部合集',

  breadcrumbLabel: '面包屑导航',
  metaPublished: '发布于',
  metaUpdated: '更新于',
  metaCollection: '所属合集',
  metaTags: '标签',
  metaAliases: '别名',
  tocHeading: '本页目录',
  headingAnchorLabel: (heading) => `跳转到章节：${heading}`,
  codeCopy: '复制代码',
  codeCopied: '已复制',
  codeCopyFailed: '复制失败',
  footnotesHeading: '脚注',
  footnoteBackLabel: (reference) => `返回正文引用 ${reference}`,
  diagramCaption: (kind) => `${kind} 图示`,
  outgoingHeading: '链出笔记',
  outgoingEmpty: '这篇笔记没有链接到其他公开笔记。',
  backlinksHeading: '链入笔记',
  backlinksEmpty: '目前还没有公开笔记链接到这里。',
  relatedHeading: '相关笔记',
  relatedDerivation: '依据共同标签推荐，标签所含笔记最少的优先。上文已列出的笔记不再重复。',
  relatedNoTagPeer: '没有其他公开笔记与这篇共享标签。',
  relatedAlreadyListed: '与这篇共享标签的笔记都已在上文列出。',
  moreInCollection: (collection) => `${collection} 合集中的更多笔记`,
  pagerPrevious: '上一篇',
  pagerNext: '下一篇',
  noteProvenance:
    '本页由一篇以 Markdown 写成的笔记发布，并以静态页面提供。页内的链接只会指向' +
    '已公开的笔记。',
  canonicalUrlLine: (url) => `规范链接：${url}`,

  graphHeading: '相邻笔记',
  graphTitle: '关系图',
  graphDescription: '公开笔记之间的链接关系。',
  graphLocalDerivation:
    '与这篇笔记相隔一条链接的全部笔记，并画出它们彼此之间的链接。' + '布局在构建站点时完成，因此无需脚本。',
  graphGlobalDerivation:
    '站内链接最多的笔记，连接越多越靠近中心。布局在构建站点时完成，因此无需脚本。',
  graphFigureLabel: (nodes, edges) => `链接关系图：${nodes} 篇笔记，${edges} 条链接`,
  graphNodeLabel: (title, relation, degree) => `${title} — ${relation}，图中有 ${degree} 条链接`,
  graphSubjectRelation: '本篇',
  graphOutgoingRelation: '本篇链接到它',
  graphIncomingRelation: '它链接到本篇',
  graphMutualRelation: '互相链接',
  graphLinkedRelation: '公开笔记',
  graphExplorerOpen: '交互探索',
  graphExplorerReset: '重置',
  graphExplorerRecenter: '以此为中心',
  graphExplorerRecenterLabel: '{title}，以此为中心',
  graphExplorerFilterLabel: '标签',
  graphExplorerFilterAll: '全部笔记',
  graphExplorerStatusLocal: '实时图：已画出 {total} 篇相邻笔记中的 {shown} 篇。',
  graphExplorerStatusGlobal: '实时图：已画出 {total} 篇公开笔记中的 {shown} 篇。',
  graphExplorerStatusFiltered: '标签 {tag} 的实时图：已画出 {total} 篇匹配笔记中的 {shown} 篇。',
  graphExplorerFailed: '实时图加载失败；上方静态图仍然完整。',
  graphExplorerUnknownCenter: '实时索引中没有这篇笔记。',
  graphExplorerEmptyFilter: '没有公开笔记带有这个标签。',
  graphExplorerNodeLabel: '{title} — {relation}，已绘制 {degree} 条连线',
  graphExplorerNodeLabelOne: '{title} — {relation}，已绘制 {degree} 条连线',
  graphTableCaption: '同样的笔记与链接，以表格呈现',
  graphColumnNote: '笔记',
  graphColumnRelation: '关系',
  graphColumnLinks: '图中链接数',
  graphColumnLinkedTo: '链接到',
  graphNoLinks: '图中没有与它相连的笔记',
  graphBoundedLocal: (shown, total) =>
    `共有 ${total} 篇相邻笔记，此处按字母顺序画出其中 ${shown} 篇。上文的列表已列出全部。`,
  graphBounded: (shown, total) => `共 ${total} 篇笔记，此处画出链接最多的 ${shown} 篇。`,
  graphExpandLocal: '查看整站关系图 →',
  graphExpandLocalLabel: '查看整站关系图，包含全部公开笔记',
  graphExpand: '查看全部公开笔记 →',
  graphExpandLabel: '查看全部公开笔记，包括本图未画出的部分',
  graphEmpty: '没有公开笔记链接到这篇，这篇也没有链接到其他笔记，因此没有可绘制的相邻关系。',
  graphSiteEmpty: '目前还没有两篇公开笔记互相链接，因此没有可绘制的关系图。随着笔记之间的链接增多，本页会逐步充实。',

  notFoundTitle: '页面未找到',
  notFoundDescription: '该页面不属于本站。',
  notFoundBody: '该地址不对应任何已公开的页面。它可能已被撤回、迁移，或从未存在于此。请从下方选择当前可用的页面。',
  notFoundWhereTo: '可以去这些地方',

  withheldTitle: '未公开',
  withheldDescription: '此链接指向的笔记不属于本站。',
  withheldBody:
    '一篇已公开的笔记链接到了这里，而它所指向的那篇笔记并未公开。它的正文、标题以及其余内容' +
    '都不在本站之中 — 你刚才点击的那个链接是它在此处留下的唯一痕迹，而链接里的文字出自你' +
    '来时那篇笔记的作者之手。',
  withheldPermanence:
    '本页不会在日后补上内容。那篇未公开的笔记没有任何发布安排，无论何时回到这个地址，' +
    '它都会是同样的说明。',
} as const satisfies Translation;

/**
 * The keys `routes.ts` may name for a navigation label.
 *
 * Narrowed to the seven `nav*` entries rather than all of {@link Translation},
 * so a route cannot point at `searchFailed` and render a sentence in the header.
 * It is also what keeps the indexed lookup in `Layout.astro` typed as a string:
 * a key admitting a function-valued entry would not be.
 */
export type NavLabelKey = Extract<keyof Translation, `nav${string}`>;

/**
 * The locale each tag resolves to, keyed by the lowercased tag.
 *
 * The bare `zh` key is **not** redundant with the `zh-cn` one, and removing it
 * was tried: {@link translate} falls back to the *primary subtag*, so `zh-TW`,
 * `zh-Hant`, and `zh-Hans-CN` all reduce to `zh` — which without a key of its
 * own falls through to English, putting English chrome around a Chinese
 * document. That is the exact defect this ticket exists to close, reached from a
 * schema-valid artifact.
 *
 * What it means is that a Traditional-script document renders Simplified chrome.
 * A known limit, stated rather than hidden: this tool ships two locales, and
 * Simplified chrome around a Traditional document is a closer answer than
 * English. A Traditional locale is one more entry here and nothing else.
 */
const LOCALES: Readonly<Record<string, Translation>> = {
  en: EN,
  'zh-cn': ZH_CN,
  zh: ZH_CN,
  // ISO 639-2/T. `src/lib/schema.ts` admits a two- *or three*-letter primary
  // subtag, so `zho` is a valid artifact spelling of the same language `zh`
  // names, and without this key it resolved to English chrome on a Chinese
  // document — the exact defect this ticket closes, reachable from a
  // schema-valid artifact. `cmn` and `yue` are deliberately absent: they name
  // Mandarin and Cantonese specifically, and mapping either onto this Simplified
  // locale would be a guess about script rather than a spelling of a tag this
  // site already publishes.
  zho: ZH_CN,
};

/**
 * The chrome for one document, from its own `language` field.
 *
 * Resolution is the exact-tag-then-primary-subtag order `search-dialog.ts`
 * already uses for Pagefind's index partitions, so the two agree about what
 * `zh-Hans-CN` is: the full lowercased tag first, then the primary subtag. A
 * document declaring a language this site has no locale for — `fr`, or the
 * `zh-TW` a traditional-script note would carry — resolves to the closest
 * locale it does have rather than to a key name, and `undefined` resolves to
 * {@link NAV_LANGUAGE}, which is the published corpus's own case.
 */
export function translate(language: string | undefined): Translation {
  const tag = (language ?? NAV_LANGUAGE).toLowerCase();
  return LOCALES[tag] ?? LOCALES[tag.split('-')[0]!] ?? EN;
}

/**
 * The `lang` attribute a listed title needs, or `undefined` when it needs none.
 *
 * WCAG 2.2 AA success criterion 3.1.2 is about *parts* of a page, and a list of
 * notes is exactly that case: an English home page listing four Chinese titles
 * is read out in an English voice by a screen reader unless each of those titles
 * says what it is. The attribute is emitted only when the entry's language
 * differs from the page's, so an all-English list carries no redundant markup.
 *
 * `entryLanguage` is the artifact's optional field, so an entry declaring none
 * is treated as the navigation language — the same fallback {@link translate}
 * applies, and for the same reason.
 */
export function partLanguage(
  entryLanguage: string | undefined,
  pageLanguage: string,
): string | undefined {
  const own = entryLanguage ?? NAV_LANGUAGE;
  // Compared case-insensitively, as BCP 47 says language tags are: `zh-CN` and
  // `zh-cn` name one language, so an artifact that spells one entry's tag
  // differently from another's must not make the two look foreign to each other
  // and put a redundant `lang` on every title. `translate` lowercases for the
  // same reason, and the two must agree or a page resolves Chinese chrome while
  // marking its own Chinese titles as foreign.
  return own.toLowerCase() === pageLanguage.toLowerCase() ? undefined : own;
}
