/**
 * Build-time Markdown rendering for the public content artifact.
 *
 * One module owns the whole path from artifact Markdown to sanitized HTML plus
 * the structured metadata pages need. Two properties are load-bearing:
 *
 * 1. **Sanitization is last.** Every transform — highlighting, callouts, heading
 *    anchors, internal-link rewriting — happens before `sanitizeHtml` runs, and
 *    `sanitizeHtml` is the single exit from `renderMarkdown`. Nothing a transform
 *    emits, including a route returned by an injected `routeForSlug`, can reach
 *    the page without passing the allowlist.
 * 2. **Rendering is deterministic.** Identical Markdown yields byte-identical
 *    HTML: the slugger is per-render, no timestamps or random ids are emitted,
 *    and no transform depends on ambient state.
 *
 * Toolchain, all already present via Astro 7 and pinned as direct dependencies:
 * `satteri` (Astro 7's Markdown processor), `github-slugger`, `@astrojs/prism`,
 * and `prismjs` for its language manifest. Nothing new was installed.
 *
 * Prism rather than Shiki: Shiki's output carries inline `style` attributes,
 * which the target CSP (`style-src 'self'`, no `unsafe-inline`) blocks. Prism
 * emits class-only markup that the CSP allows unchanged.
 */

import { markdownToHtml, type Features, type HastNode, type HastPluginDefinition } from 'satteri';
import Slugger from 'github-slugger';
import sanitizeHtml from 'sanitize-html';
import { runHighlighterWithAstro } from '@astrojs/prism/dist/highlighter';
import prismComponents from 'prismjs/components.json' with { type: 'json' };
import { renderMath } from './math.ts';
import { renderDiagram } from './mermaid-render.ts';
import { DIAGRAM_MODE } from './diagram-mode.ts';
import { NAV_LANGUAGE, translate, type Translation } from './translations.ts';

/** A heading authored in the Markdown body, in document order. */
export interface Heading {
  /** 1 for `#`, 6 for `######`. */
  depth: number;
  /** Slugified anchor id, deduplicated within the document. */
  id: string;
  /** Plain text of the heading. */
  text: string;
}

/** A heading plus the headings nested beneath it. */
export interface TocEntry extends Heading {
  children: TocEntry[];
}

export interface RenderedNote {
  /** Sanitized HTML, safe to inject with `set:html`. */
  html: string;
  /** Every authored heading, flat and in document order. */
  headings: Heading[];
  /**
   * Nested heading tree for pages long enough to need navigation, empty below
   * {@link TOC_MIN_HEADINGS}. TK-05 renders it; an empty array means "no ToC".
   */
  toc: TocEntry[];
  /** The page has at least one fenced code block (math and Mermaid excluded). */
  hasCode: boolean;
  /** The page has at least one math expression, rendered as plain source. */
  hasMath: boolean;
  /** The page has at least one Mermaid block, rendered as plain source. */
  hasMermaid: boolean;
}

/**
 * The chrome this module emits *into* the article, in the document's language.
 *
 * Four strings, and only four: a heading anchor's accessible name, an untitled
 * diagram's caption, the footnote section's hidden heading, and each footnote
 * backref's accessible name. Everything else this module writes is the author's
 * Markdown. Named as a type rather than repeated as a `Pick` because three
 * functions here take it and `RenderOptions` declares it.
 */
export type ArticleChrome = Pick<
  Translation,
  'headingAnchorLabel' | 'diagramCaption' | 'footnotesHeading' | 'footnoteBackLabel'
>;

export interface RenderOptions {
  /**
   * The title the surrounding page renders as its own `<h1>`.
   *
   * Requirements section 9.2 puts the title, the public metadata, the summary,
   * and the table of contents *before* the article content, so the title cannot
   * live inside the body — and the exporter writes it there anyway, as a leading
   * `# Title`. Passing it here removes that one duplicate heading, so the page
   * renders the title once and the document has exactly one `<h1>`.
   *
   * **Only the leading heading, and only when its text matches.** Every other
   * heading is left exactly as authored, including an `h1`. Demoting one was
   * tried and is wrong: `# Part Two` followed by `## Section` would both become
   * `h2`, making the subsection a sibling of its own parent in the outline and
   * in the table of contents — text preserved, structure destroyed, silently.
   * A body that keeps an `h1` is an artifact shape this anatomy cannot express,
   * and it fails the "exactly one h1" gate in `tests/built-output.test.ts`
   * rather than shipping a rearranged outline. Every entry in every corpus opens
   * with a `# Title` matching its `title` field, so that gate has never fired.
   *
   * Omit this and nothing changes: the body keeps every heading it has. That is
   * what every caller who is not the note page wants, and it is why the removal
   * cannot affect a rendering that did not ask for it.
   */
  pageTitle?: string;
  /**
   * Maps a published slug to its canonical public route, used to rewrite
   * in-content hrefs of the form `/<slug>/`.
   *
   * Injected rather than hardcoded so TK-04 can move notes to `/notes/<slug>/`
   * without touching this module. Return `undefined` to leave an href alone —
   * that is how a caller holding the real slug set skips unknown targets.
   *
   * The returned route is still sanitized: a hostile or buggy mapping cannot
   * introduce a `javascript:` href, because the scheme allowlist runs after
   * this transform.
   */
  routeForSlug?: (slug: string) => string | undefined;
  /**
   * The chrome this renderer emits *into* the article, in the document's own
   * language.
   *
   * Two strings qualify and only two: a heading anchor's accessible name and an
   * untitled diagram's caption. Everything else this module writes is the
   * author's Markdown. They are injected rather than resolved here for the same
   * reason `routeForSlug` is: this module stays pure and corpus-free, and the
   * caller is the one that knows which document is being rendered — which since
   * TK-16 is also the only thing that knows its language.
   *
   * Omitted, they fall back to the navigation language, so a caller with no
   * document in hand renders exactly what it did before.
   */
  chrome?: ArticleChrome;
}

/**
 * Today's route shape, which the exporter already emits. Keeping it as the
 * default means rendering is unchanged until TK-04 injects its own mapping.
 */
export const defaultRouteForSlug = (slug: string): string => `/${slug}/`;

/**
 * Headings needed before a page gets a table of contents.
 *
 * TK-03 scope item 6 says "pages above a length threshold". Heading count is
 * used as that threshold rather than character count: a table of contents is
 * navigation, and what makes it useful is having several places to navigate to,
 * not having many words. A 5000-word essay with one heading gains nothing from
 * a one-item list, and a short page with four sections genuinely benefits.
 * Three is the point at which the list stops restating the page.
 */
export const TOC_MIN_HEADINGS = 3;

/**
 * Rendering policy, stated in one place because each flag is a decision:
 *
 * - `gfm` — tables, footnotes, strikethrough, and task lists (section 15.1).
 * - `frontmatter` off — the exporter strips frontmatter, so a leading `---` in
 *   the body is a thematic break. Leaving this on would silently eat content.
 * - `math` — display math parses; `$…$` does not, because a single `$` in
 *   technical prose is far more often currency (`$5 to $10`) than an equation,
 *   and misparsing it corrupts the sentence. TK-15 renders what does parse as
 *   native MathML; see `src/lib/math.ts`.
 * - `smartPunctuation` off — it rewrites `--` to an en-dash, which is wrong for
 *   the CLI flags this corpus is full of.
 * - `wikilinks` off — the exporter resolves public wikilinks to routes, and
 *   TK-01 rejects any artifact still carrying `[[`. Parsing them here would
 *   quietly render a link the projection never approved (section 15.2).
 * - `headingAttributes` off — `# text { #id .class }` would let body content
 *   choose its own ids and classes, defeating the anchor and class allowlists.
 */
function featuresFor(chrome: ArticleChrome): Features {
  return {
    // GFM's footnote section carries two strings of its own — the visually
    // hidden `<h2>` and each backref's `aria-label` — and they are English
    // defaults unless supplied. A Chinese article with a footnote therefore
    // announced "Back to reference 1" to a screen reader, which is the same
    // defect as an English heading anchor and is fixed the same way. satteri
    // takes them directly, so this costs no dependency and no parsing.
    //
    // `{reference}` is satteri's placeholder, substituted with `1` or `1-2`; the
    // locale receives it as the interpolated value, so a locale is free to put
    // the number wherever its grammar wants it.
    gfm: {
      footnotes: {
        label: chrome.footnotesHeading,
        backLabel: chrome.footnoteBackLabel('{reference}'),
      },
    },
    frontmatter: false,
    math: { singleDollarTextMath: false },
    smartPunctuation: false,
    wikilinks: false,
    headingAttributes: false,
  };
}

/** Class satteri puts on math code nodes; also the fence language for math. */
const MATH_LANGUAGE = 'math';

/** The fence language that carries a diagram. */
const MERMAID_LANGUAGE = 'mermaid';

/**
 * Fence languages that are never handed to the highlighter.
 *
 * Both are rendered rather than highlighted. Math becomes native MathML via
 * Temml (`src/lib/math.ts`), and a Mermaid fence becomes either a build-time
 * SVG or a client-rendered diagram depending on `DIAGRAM_MODE` — in the client
 * case its source ships as escaped text for the runtime to read, which is also
 * what a reader without JavaScript is left with.
 */
const UNHIGHLIGHTED_LANGUAGES: ReadonlySet<string> = new Set([MATH_LANGUAGE, MERMAID_LANGUAGE]);

/**
 * Every language id and alias Prism ships a grammar for, read from Prism's own
 * manifest rather than hand-listed, so the set never drifts from the installed
 * version.
 *
 * Asking Prism for a language it lacks makes it log two console lines per block
 * and return the source unhighlighted. Gating on this set keeps the build log
 * readable and, more usefully, lets `highlight` map a near-miss alias (`cmd` →
 * `batch`) onto a grammar that does exist instead of silently giving up.
 */
const PRISM_LANGUAGES: ReadonlySet<string> = new Set(
  Object.entries(prismComponents.languages).flatMap(([id, meta]) =>
    id === 'meta' ? [] : [id, ...[((meta as { alias?: string | string[] }).alias ?? [])].flat()],
  ),
);

/**
 * Prism languages that permanently rewrite *another* language's grammar when
 * loaded — `jsdoc` enriches `javascript`, `css-extras` enriches `css`, and
 * `css`/`javascript` themselves enrich `markup`.
 *
 * Prism's registry is a process-wide singleton and its loader is lazy, so
 * without this the same `js` fence highlights differently depending on whether
 * some *other* page in the same build happened to pull in `jsdoc` first. That
 * is a real determinism break, not a theoretical one: `/** @param a *\/` renders
 * as `token comment` before and `token doc-comment comment` after.
 *
 * Loading every modifier once at module init settles the registry before the
 * first render, so grammar state no longer depends on page order. The list is
 * derived from the manifest's own `modify` field rather than hand-written, and
 * costs about 30 ms once per build.
 */
const GRAMMAR_MODIFIERS: readonly string[] = Object.entries(prismComponents.languages)
  .filter(([id, meta]) => id !== 'meta' && 'modify' in (meta as object))
  .map(([id]) => id);

/**
 * Settle Prism's global grammar registry exactly once, before any render reads
 * it. Awaited by every call to {@link highlight}, so no render can observe a
 * half-loaded registry.
 *
 * `loadLanguages` is Prism's own bulk loader and resolves each component's
 * dependencies itself. It is used directly rather than through the highlighter
 * because five of these components (`css-extras`, `js-extras`, `js-templates`,
 * `php-extras`, `xml-doc`) only patch another grammar and register none of their
 * own, which the highlighter would report as a load failure.
 */
const grammarsReady: Promise<void> = (async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  require('prismjs');
  const loadLanguages = require('prismjs/components/index.js') as (langs: readonly string[]) => void;
  loadLanguages(GRAMMAR_MODIFIERS);
})();

/**
 * Fence languages this corpus uses that Prism names differently. Kept tiny and
 * explicit: a wrong guess mislabels a code block, so only unambiguous synonyms
 * belong here.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  cmd: 'batch',
  ps1: 'powershell',
  text: 'plaintext',
};

/** Mirrors the slug shape TK-01 enforces in `schema.ts`. */
const INTERNAL_HREF = /^\/([a-z0-9]+(?:-+[a-z0-9]+)*)\/(#[^\s]*)?$/;

/**
 * Placeholders that survive sanitization and are replaced with rendered markup
 * afterwards.
 *
 * Two constructs — MathML and diagram SVG — cannot pass through
 * `sanitize-html`. Both `math` and `svg` are on its `nonTextTags` list, and
 * they are there deliberately: an SVG can carry a script, and widening the
 * allowlist to admit *this* SVG would admit every raw-HTML `<svg>` a note body
 * chose to write. Requirements §15.2 rejects exactly that.
 *
 * So each is rendered by a module that has already established its own, much
 * narrower guarantee — Temml emits a closed element set from a parsed TeX tree;
 * `mermaid-render.ts` strips scripts, handlers, styles, and external references
 * and fails the build rather than passing one through — and the sanitized HTML
 * carries a marker where it goes.
 *
 * **The marker's safety is what makes this sound**, and it rests on three
 * properties rather than on the string being unusual:
 *
 * 1. The token contains no character `escapeHtml` rewrites and none that is
 *    special in HTML, so it passes through the sanitizer's text handling
 *    byte-for-byte — asserted by test rather than assumed.
 * 2. It is emitted as a **text node**, so a note body that writes the literal
 *    token in its prose gets it escaped… no: a text node is escaped on output
 *    only for `&<>`, which the token has none of. The real protection is (3).
 * 3. Substitution is **positional and exhausting**: each token is replaced
 *    exactly once, in index order, and `substituteDiagrams` fails if the count
 *    of markers found does not equal the count of renders requested. A body that
 *    writes the token itself therefore fails the build loudly instead of
 *    receiving somebody else's diagram — and cannot inject markup either way,
 *    since the replacement text is chosen by index from this render's own list.
 */
const DIAGRAM_TOKEN_PREFIX = 'thoughtscapeDiagramPlaceholder';
const DIAGRAM_TOKEN_SUFFIX = 'End';
const MATH_TOKEN_PREFIX = 'thoughtscapeMathPlaceholder';
const MATH_TOKEN_SUFFIX = 'End';

interface DiagramRequest {
  source: string;
  token: string;
}

interface MathRequest {
  tex: string;
  isDisplay: boolean;
  token: string;
}

/** A hast node this module constructs. satteri's own content type. */
type DiagramNode = HastNode;

/**
 * The id shapes satteri generates for GFM footnotes, plus its footnote-section
 * heading. These are structural, not authored, so they are recognized by shape
 * rather than collected.
 */
const FOOTNOTE_ID = /^(?:user-content-fn(?:ref)?-[^\s"]+|footnote-label)$/;

/**
 * An inline image TK-01's artifact scanner already allows: a base64 raster
 * type, and nothing else. `image/svg+xml` is deliberately excluded — an SVG can
 * carry a script — as are every non-image type and the bare `data:,` form.
 * Mirrors `DISALLOWED_DATA_URI` in `schema.ts`; the two must agree, or the
 * exporter admits an image this renderer then silently drops.
 */
const SAFE_IMAGE_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]*$/i;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * Highlighted markup for one code block.
 *
 * Anything without a Prism grammar is escaped here rather than handed over:
 * Prism returns its input *verbatim* when it cannot highlight, so a fence such
 * as ```` ```nosuchlang ```` would otherwise put raw, unescaped HTML into the
 * document. The identity check afterwards is a second guard for a grammar that
 * exists but tokenizes nothing. Sanitization is still the last line of defence,
 * not the first.
 *
 * Prism's token classes are namespaced to `token-*` on the way out. Prism's
 * vocabulary is large and open-ended (`comment`, `keyword`, `section`, `title`,
 * `code-block`, …), and several of its names collide with real layout classes,
 * so an allowlist wide enough to admit them would also admit any lowercase
 * class a note body invented. Namespacing lets the allowlist close to exactly
 * `token` plus `token-*`. Rewriting is safe because Prism has already escaped
 * the code, so the only `class="…"` left in this string is Prism's own.
 */
function namespaceTokenClasses(html: string): string {
  return html.replace(/class="([^"]*)"/g, (_match, list: string) => {
    const namespaced = list
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => (name === 'token' ? name : `token-${name}`));
    return `class="${namespaced.join(' ')}"`;
  });
}

async function highlight(code: string, language: string): Promise<string> {
  const grammar = LANGUAGE_ALIASES[language] ?? language;
  if (UNHIGHLIGHTED_LANGUAGES.has(language) || !PRISM_LANGUAGES.has(grammar)) return escapeHtml(code);
  await grammarsReady;
  const { html } = await runHighlighterWithAstro(grammar, code);
  return html === code ? escapeHtml(code) : namespaceTokenClasses(html);
}

interface Collected {
  headings: Heading[];
  /**
   * Every `id` written as raw HTML in the body, counted by value.
   *
   * Collected so `sanitize()` can *deny* them, not merely so `headingPlugin`
   * can avoid them. Avoiding is enough for heading anchors, whose ids are minted
   * after the raw node is seen — but not for satteri's generated footnote ids
   * (`footnote-label`, `user-content-fn-*`), which are recognized by shape at
   * sanitize time and so would be handed to whichever element claimed them
   * first. A raw `<a id="footnote-label">` before a footnote took the id, left
   * the real `<h2 class="sr-only">` without one, and pointed the reference's
   * `aria-describedby` at the decoy.
   *
   * Counted rather than a set because a decoy and the genuine element share the
   * id string: denying the string outright would strip the footnote's own id too
   * and leave `href="#user-content-fn-a"` dangling.
   */
  rawIds: Map<string, number>;
  hasCode: boolean;
  hasMath: boolean;
  hasMermaid: boolean;
}

/**
 * The tags `POLICY` grants an `id`, and therefore the only tags on which a
 * raw-HTML id can survive to the page. Derived from the allowlist rather than
 * restated, so the two cannot disagree.
 *
 * A function, not a `const`: `POLICY` is declared further down the module, so an
 * eagerly evaluated binding here reads it inside its temporal dead zone and the
 * module throws on import. Computed once on first call and cached — every render
 * hits this per raw node.
 */
let idBearingTags: ReadonlySet<string> | undefined;

function isIdBearing(tagName: string): boolean {
  idBearingTags ??= new Set(
    Object.entries(POLICY.allowedAttributes ?? {})
      .filter(([, allowed]) => (allowed as readonly unknown[]).includes('id'))
      .map(([tag]) => tag),
  );
  return idBearingTags.has(tagName);
}

/**
 * Every `id` in a fragment of raw HTML that could actually reach the page.
 *
 * Parsed rather than pattern-matched. A regex over the raw text gets this wrong
 * in both directions, and both directions are defects:
 *
 * - It *misses* ids. An attribute value is entity-decoded before it becomes an
 *   id, and `_` — a slug character — has named references (`&lowbar;`,
 *   `&UnderBar;`). `<a id="foo&lowbar;bar">` is the id `foo_bar`, and a decoder
 *   that handles only numeric references reads it as the literal
 *   `foo&lowbar;bar`, reserves the wrong string, and lets the decoy take
 *   `## Foo_Bar`'s anchor — exactly the defect this exists to close.
 * - It *over-matches*. `\bid\s*=` fires inside an HTML comment, inside
 *   `data-id=`, and inside a `title="id=x"` value, so text that never renders
 *   would push a real heading from `#introduction` to `#introduction-1` and
 *   silently move a published deep link.
 *
 * `sanitize-html` is already this module's parser and its allowlist, so using it
 * here costs no dependency and cannot disagree with the sanitizer about what an
 * id *is*. But parsing alone is still too generous, because the question here is
 * not "is this an id" — it is "can this id shadow a heading anchor", and only an
 * id that survives `sanitize()` can. So the same two filters the real pass
 * applies are applied here:
 *
 * - `nonTextTags` from `POLICY`, so an id inside a discarded subtree written as
 *   one raw block (`<form><a id="x">y</a></form>`) reserves nothing. Passed
 *   explicitly because the library's default list is a different, shorter one.
 * - {@link isIdBearing}, so `<div id="introduction">` — which ships as a `div`
 *   with its id dropped — cannot push `## Introduction` to `#introduction-1`.
 *
 * An empty `id=""` is skipped: a browser treats it as no id at all, and
 * reserving `''` would consume the slugger's empty-slug fallback and leave a
 * punctuation-only heading with `id="-1"` instead of `section`.
 *
 * ponytail: satteri delivers raw HTML as *per-tag fragments* when the block
 * spans lines — `<xmp>`, `<a id="x">`, `</a>`, `</xmp>` are four separate raw
 * nodes — so a nested container's context is not visible here and `nonTextTags`
 * cannot see it. The residue is one shape: an `<a id>`, `<li id>`, or heading id
 * nested inside a discarded container across several lines still reserves its
 * slug, so a heading of the same text gets `-1`. That is a *conservative* miss —
 * it can cost a heading its preferred anchor, never let a decoy steal one — and
 * closing it means tracking open tags across raw nodes, which is a second HTML
 * parser for a construct no published note contains. Revisit if a real note
 * ever writes one.
 */
function rawHtmlIds(html: string): string[] {
  const ids: string[] = [];
  sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: POLICY.nonTextTags,
    transformTags: {
      '*': (tagName, attribs) => {
        const id = attribs['id'];
        if (typeof id === 'string' && id !== '' && isIdBearing(tagName)) ids.push(id);
        return { tagName, attribs };
      },
    },
  });
  return ids;
}

/**
 * Stable anchor ids plus a visible, labelled link to each heading.
 *
 * Headings that already carry an id are generated structure (satteri's footnote
 * label), not authored content: they keep their id and stay out of the heading
 * tree.
 *
 * Raw HTML in the body reaches the tree as opaque `raw` nodes that the element
 * visitor never sees, and `sanitize()` drops every id it did not generate. That
 * drop happens too late on its own: a raw `<a id="introduction">` written before
 * `## Introduction` would already have claimed the heading's anchor, leaving the
 * deep link, the future table of contents entry, and the Pagefind anchor all
 * resolving to the decoy. Reserving each raw id in this slugger *as it is
 * encountered* is what makes generated ids disjoint from authored ones, so the
 * heading gets a free id and the decoy is dropped with nothing to shadow.
 *
 * `pageTitle` resolves the one structural conflict between the artifact and
 * requirements section 9.2: the exporter writes the title into the body as a
 * leading `# Title`, and the anatomy renders the title itself, above the
 * article. See {@link RenderOptions.pageTitle}. When it is given, a leading
 * `h1` whose text matches is removed — and nothing else changes, because every
 * alternative to removal rearranges an outline the author wrote.
 */
function headingPlugin(
  collected: Collected,
  pageTitle: string | undefined,
  label: Translation['headingAnchorLabel'],
): HastPluginDefinition {
  const slugger = new Slugger();
  let isFirstHeading = true;
  return {
    name: 'thoughtscape-headings',
    // Raw HTML is visited in document order alongside elements, so an id
    // written before a heading is reserved before that heading is slugged.
    // `slug()` registers the value whether or not it was already taken, which
    // is exactly the reservation wanted here.
    raw(node) {
      for (const id of rawHtmlIds(node.value)) {
        collected.rawIds.set(id, (collected.rawIds.get(id) ?? 0) + 1);
        slugger.slug(id);
      }
    },
    element: {
      filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      visit(node, ctx) {
        if (typeof node.properties?.['id'] === 'string') return;
        const text = ctx.textContent(node);
        const wasFirst = isFirstHeading;
        isFirstHeading = false;

        // The body's own restatement of the title the page already renders.
        // Removed before an id is minted, so it never enters `headings` and the
        // table of contents cannot carry an entry whose anchor is not on the
        // page. Nothing is reserved in the slugger either: a later heading
        // genuinely titled the same thing gets the clean id.
        if (pageTitle !== undefined && wasFirst && node.tagName === 'h1' && text.trim() === pageTitle.trim()) {
          ctx.removeNode(node);
          return;
        }

        // Text that is only punctuation or invisibles slugs to "", which would
        // give several headings the same empty id and a useless `href="#"`.
        // The fallback is re-slugged rather than used literally so that it is
        // registered as taken: otherwise a later heading actually titled
        // "Section" would collide with it.
        const id = slugger.slug(text.trim()) || slugger.slug('section');
        collected.headings.push({ depth: Number.parseInt(node.tagName[1] ?? '1', 10), id, text });
        ctx.setProperty(node, 'id', id);
        ctx.appendChild(node, {
          type: 'element',
          tagName: 'a',
          properties: {
            className: ['heading-anchor'],
            href: `#${id}`,
            'aria-label': label(text),
          },
          children: [{ type: 'text', value: '#' }],
        });
      },
    },
  };
}

/**
 * Obsidian callouts (`> [!note] Title`) become a labelled blockquote.
 *
 * The marker is stripped from the rendered text and the title, if any, is
 * promoted to a `<strong>`; a callout without a title keeps only its kind. The
 * kind lands on `data-callout` so TK-02 can style it without parsing classes,
 * and it is lowercased and length-bounded so body content cannot use it as an
 * unbounded attribute channel.
 */
function calloutPlugin(): HastPluginDefinition {
  return {
    name: 'thoughtscape-callouts',
    element: {
      filter: ['blockquote'],
      visit(node) {
        const children = [...(node.children ?? [])];
        const index = children.findIndex((child) => child.type === 'element' && child.tagName === 'p');
        const paragraph = index === -1 ? undefined : children[index];
        if (!paragraph || paragraph.type !== 'element') return;

        const [lead, ...rest] = paragraph.children ?? [];
        if (!lead || lead.type !== 'text') return;
        // The optional [+-] is Obsidian's fold marker; it has no static meaning.
        const marker = /^\[!([A-Za-z][A-Za-z0-9-]{0,23})\][+-]?[ \t]*/.exec(lead.value);
        if (!marker) return;

        const kind = marker[1]!.toLowerCase();
        const remainder = lead.value.slice(marker[0].length);
        const breakAt = remainder.indexOf('\n');
        const title = breakAt === -1 ? remainder : remainder.slice(0, breakAt);
        const body = breakAt === -1 ? '' : remainder.slice(breakAt + 1);

        children[index] = {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            ...(title
              ? [
                  {
                    type: 'element' as const,
                    tagName: 'strong',
                    properties: { className: ['callout-title'] },
                    children: [{ type: 'text' as const, value: title }],
                  },
                  { type: 'text' as const, value: '\n' },
                ]
              : []),
            ...(body ? [{ type: 'text' as const, value: body }] : []),
            ...rest,
          ],
        };

        return {
          type: 'element',
          tagName: 'blockquote',
          properties: { className: ['callout', `callout-${kind}`], 'data-callout': kind },
          children,
        };
      },
    },
  };
}

/**
 * Code fences become `figure > pre > code` with build-time highlighting; math
 * and Mermaid fences become rendered content instead.
 *
 * No copy button. TK-03 emitted one `hidden`, for a handler that was never
 * written: it had no CSS and no script, and the word `Copy` was welded into
 * every code block Pagefind indexed. TK-12 deleted it. TK-05a may reintroduce
 * it in the same commit as its handler and its styling — the point at which it
 * stops being dead code.
 *
 * Math reaches this visitor too — satteri renders `$$…$$` as
 * `pre > code.language-math` with no fence language — and is handled by
 * `mathPlugin` rather than here, so it never acquires a highlighting shell.
 */
function codePlugin(
  collected: Collected,
  diagrams: DiagramRequest[],
  caption: Translation['diagramCaption'],
): HastPluginDefinition {
  return {
    name: 'thoughtscape-code',
    element: [
      {
        filter: ['pre'],
        async visit(node, ctx) {
          const code = node.children?.find((child) => child.type === 'element' && child.tagName === 'code');
          if (!code || code.type !== 'element') return;
          if (asClassList(code.properties?.['className']).includes(`language-${MATH_LANGUAGE}`)) return;

          // An unlabelled fence has no `data.lang`. It is still a code block and
          // still gets the same shell, so a reader can copy it.
          const language = fenceLanguage(code.data) ?? 'plaintext';
          const source = ctx.textContent(code).replace(/\n$/, '');

          if (language === MERMAID_LANGUAGE) {
            collected.hasMermaid = true;
            return diagramFigure(source, diagrams, caption);
          }
          collected.hasCode = true;

          return {
            type: 'element',
            tagName: 'figure',
            properties: {
              className: ['code-block'],
              'data-code-language': language,
            },
            children: [
              {
                type: 'element',
                tagName: 'pre',
                properties: {},
                children: [
                  {
                    type: 'element',
                    tagName: 'code',
                    properties: { className: [`language-${language}`] },
                    children: [{ type: 'raw', value: await highlight(source, language) }],
                  },
                ],
              },
            ],
          };
        },
      },
    ],
  };
}

/**
 * A `<figure>` holding one diagram, in whichever form the mode calls for.
 *
 * The two modes differ only inside the figure; the figure, its caption, and its
 * accessible name are the same either way, so a reader meets the same structure
 * and the page's outline does not depend on a build flag.
 *
 * **Build-time mode** emits a placeholder that {@link substituteDiagrams} fills
 * with rendered SVG after sanitization. The SVG cannot go through the sanitizer
 * — its allowlist has no `svg`, and widening it to admit one would admit every
 * raw-HTML `<svg>` a note body cared to write, which is precisely the hole
 * §15.2 closes. So the diagram is rendered by a module that has already
 * sanitized it (`mermaid-render.ts` strips scripts, handlers, styles, and
 * external references, and fails the build rather than passing one through) and
 * is spliced in afterwards, at a marker the sanitizer itself produced.
 *
 * **Client mode** ships the diagram source as escaped text inside a `<pre>`,
 * which `src/scripts/diagram.ts` reads and replaces. That is also the
 * no-JavaScript rendering: a reader without scripting sees the diagram's source,
 * which is legible and honest, rather than an empty box.
 */
function diagramFigure(
  source: string,
  diagrams: DiagramRequest[],
  format: Translation['diagramCaption'],
): DiagramNode {
  const caption = diagramCaption(source, format);

  if (DIAGRAM_MODE === 'build-time') {
    const token = `${DIAGRAM_TOKEN_PREFIX}${diagrams.length}${DIAGRAM_TOKEN_SUFFIX}`;
    diagrams.push({ source, token });
    return {
      type: 'element',
      tagName: 'figure',
      properties: { className: ['diagram'], 'data-diagram': MERMAID_LANGUAGE },
      children: [
        // A `div` rather than the bare token, so the marker has an element to
        // be a child of and cannot end up adjacent to the caption text.
        // The scroll container is a keyboard stop, for exactly the reason a
        // `<pre>` is: a diagram wider than the measure scrolls horizontally at
        // 320 px, and a scrollable region must be reachable by keyboard (axe
        // `scrollable-region-focusable`, WCAG 2.1.1). Display math gets the
        // same treatment a few lines up.
        {
          type: 'element',
          tagName: 'div',
          properties: { className: ['diagram-canvas'], tabindex: '0' },
          children: [{ type: 'text', value: token }],
        },
        { type: 'element', tagName: 'figcaption', properties: {}, children: [{ type: 'text', value: caption }] },
      ],
    };
  }

  return {
    type: 'element',
    tagName: 'figure',
    properties: { className: ['diagram'], 'data-diagram': MERMAID_LANGUAGE },
    children: [
      {
        type: 'element',
        tagName: 'pre',
        properties: { className: ['diagram-source'] },
        children: [
          {
            type: 'element',
            tagName: 'code',
            properties: { className: [`language-${MERMAID_LANGUAGE}`] },
            children: [{ type: 'text', value: source }],
          },
        ],
      },
      { type: 'element', tagName: 'figcaption', properties: {}, children: [{ type: 'text', value: caption }] },
    ],
  };
}

/**
 * The diagram's accessible name, taken from its own source.
 *
 * A diagram is content, not decoration, so it needs a name — and axe reports an
 * unnamed `role="graphics-document"` as a violation. The name has to come from
 * somewhere the author controls, and Mermaid's own `title` directive (`title:`
 * in front matter, `pie title X`, `gantt title X`) is the only such field. When
 * the diagram declares one it is used verbatim; when it does not, the diagram's
 * *kind* is the honest fallback — "Flowchart diagram" says what the reader is
 * looking at without inventing a description of content this renderer cannot
 * summarize.
 *
 * Deliberately not a fixed literal such as "Diagram": a page with three of them
 * would give a screen reader three identically named figures, which is the same
 * defect as an unnamed one.
 */
function diagramCaption(source: string, caption: Translation['diagramCaption']): string {
  const declared = /^\s*(?:---[\s\S]*?\btitle:\s*(.+?)$|(?:pie|gantt|journey|xychart-beta|quadrantChart|radar-beta)\s+title\s+(.+?)$)/m.exec(source);
  const title = (declared?.[1] ?? declared?.[2])?.trim().replace(/^["']|["']$/g, '');
  if (title !== undefined && title !== '') return boundLabel(title);

  const kind = /^\s*(?:---[\s\S]*?---\s*)?([A-Za-z][\w-]*)/.exec(source)?.[1] ?? 'Mermaid';
  return caption(DIAGRAM_KIND_NAMES[kind.toLowerCase()] ?? kind);
}

/**
 * Readable names for the fence keywords a reader would not recognize.
 *
 * Only the ones whose keyword is not already the English word: `sequenceDiagram`
 * reads as "sequenceDiagram diagram" without help, and `graph` means flowchart.
 * A keyword absent here is used as written, so a new Mermaid diagram type gets a
 * serviceable name rather than none.
 *
 * ponytail: these names are English, so an untitled diagram on a Chinese page
 * reads "Flowchart 图示" — the noun follows the document and the kind does not.
 * Deliberate, and the smaller wrong of the two available: the alternative is a
 * per-locale table of Mermaid diagram kinds, and a reader who meets a Mermaid
 * diagram is more likely to recognize "Flowchart" than a translation of it. A
 * diagram that declares its own `title` bypasses this entirely and is the
 * authored path. Move these into `Translation` if a corpus ever ships untitled
 * diagrams on Chinese pages at any volume.
 */
const DIAGRAM_KIND_NAMES: Readonly<Record<string, string>> = {
  graph: 'Flowchart',
  flowchart: 'Flowchart',
  'flowchart-v2': 'Flowchart',
  sequencediagram: 'Sequence',
  classdiagram: 'Class',
  'statediagram-v2': 'State',
  statediagram: 'State',
  erdiagram: 'Entity-relationship',
  journey: 'User journey',
  gitgraph: 'Git graph',
  'xychart-beta': 'XY chart',
  'sankey-beta': 'Sankey',
  'block-beta': 'Block',
  'packet-beta': 'Packet',
  'architecture-beta': 'Architecture',
  'treemap-beta': 'Treemap',
  'radar-beta': 'Radar',
  quadrantchart: 'Quadrant',
  requirementdiagram: 'Requirement',
  c4context: 'C4 context',
  mindmap: 'Mind map',
  kanban: 'Kanban',
  timeline: 'Timeline',
  gantt: 'Gantt',
  pie: 'Pie',
};

/**
 * Math becomes MathML, replacing the `pre > code.language-math` shell satteri
 * emits.
 *
 * The MathML is spliced in after sanitization for the same reason the diagram
 * SVG is: `math` is on the sanitizer's `nonTextTags` list, so admitting it
 * through the allowlist would admit every raw-HTML `<math>` element a note body
 * wrote. Temml's output is generated from a parsed TeX tree by a renderer that
 * emits a closed set of elements and attributes, which is a different and much
 * narrower trust question than "any MathML in the body".
 */
function mathPlugin(collected: Collected, maths: MathRequest[]): HastPluginDefinition {
  return {
    name: 'thoughtscape-math',
    element: {
      filter: ['code'],
      visit(node, ctx) {
        const classes = asClassList(node.properties?.['className']);
        if (!classes.includes(`language-${MATH_LANGUAGE}`)) return;
        collected.hasMath = true;

        const isDisplay = classes.includes('math-display');
        const token = `${MATH_TOKEN_PREFIX}${maths.length}${MATH_TOKEN_SUFFIX}`;
        maths.push({ tex: ctx.textContent(node), isDisplay, token });

        // Display math replaces the whole `pre`; inline math replaces the
        // `code`. Leaving the `pre` in place around a `<math display="block">`
        // would put a scrollable preformatted box around an element that lays
        // itself out, and would announce a preformatted-text region a reader
        // then has to step through to reach the expression.
        //
        // Display math keeps the `tabindex` the `pre` would have carried, and
        // for the same reason: a long derivation does not wrap, so the wrapper
        // scrolls horizontally, and a scrollable region must be reachable by
        // keyboard (axe `scrollable-region-focusable`, WCAG 2.1.1). Inline math
        // sits in the text flow and never scrolls, so it gets none.
        const parent = ctx.parent(node);
        const target = parent?.type === 'element' && parent.tagName === 'pre' ? parent : node;
        ctx.replaceNode(target, {
          type: 'element',
          tagName: 'span',
          properties: {
            className: [isDisplay ? 'math-display' : 'math-inline'],
            ...(isDisplay ? { tabindex: '0' } : {}),
          },
          children: [{ type: 'text', value: token }],
        });
      },
    },
  };
}

/**
 * A task-list checkbox is named by the text of its own list item.
 *
 * axe reports an unnamed checkbox as a `label` violation at critical impact —
 * four nodes on the fixture corpus — and it is right: a screen reader
 * encountering the input alone announces "checkbox, checked" with nothing
 * saying what is checked.
 *
 * The name is lifted from the item's text rather than being a fixed string.
 * Both alternatives are worse. A literal such as `"Task"` names four checkboxes
 * identically, so it silences the tool without helping a reader, and it would
 * be an English chrome string minted in the renderer — outside the components
 * TK-16's bilingual sweep covers, so a zh-CN note would announce it in English.
 * The item's own text is content, so it is already in the document's language
 * and it is already distinct per item.
 *
 * The value is bounded and whitespace-collapsed: an `aria-label` is announced
 * in full with no structure, so a task item carrying a paragraph would be read
 * as one unbroken run before the reader learns whether it is checked. Past the
 * bound the name is truncated and the full text still follows in the item
 * itself, which is where a reader gets it either way.
 */
const TASK_LABEL_LIMIT = 120;

/** One line, collapsed and length-bounded, suitable as an `aria-label`. */
function boundLabel(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  // Split on code points, not UTF-16 units: `slice` on a surrogate pair leaves
  // half a character, which renders as a replacement glyph and is announced as
  // one. The limit is a readability bound, so counting characters is also the
  // honest unit for it.
  const characters = [...collapsed];
  return characters.length > TASK_LABEL_LIMIT
    ? `${characters.slice(0, TASK_LABEL_LIMIT).join('')}…`
    : collapsed;
}

/**
 * One task item's own text and its own checkbox, excluding any nested list.
 *
 * Both halves have to skip the same subtree, and both are defects otherwise:
 *
 * - `ctx.textContent(li)` on a parent item returns its children's text too, so
 *   `- [ ] Parent` with two sub-tasks names the parent checkbox
 *   "Parent Child A Child B" — a screen reader reads the whole subtree as the
 *   parent's name and then reads each child again.
 * - the checkbox is not always a direct child. A *loose* list — one with a
 *   blank line between items — wraps each item's content in a `<p>`, so a
 *   direct-children search finds nothing and the item silently keeps the
 *   unnamed checkbox this plugin exists to name.
 *
 * The walk therefore descends through wrappers and stops at `ul`/`ol`, which is
 * exactly the boundary between "this item" and "the items under it".
 */
function taskItemContent(node: { children?: readonly unknown[] }): {
  checkbox: { type: string; tagName?: string } | undefined;
  text: string;
} {
  let checkbox: { type: string; tagName?: string } | undefined;
  let text = '';

  const walk = (children: readonly unknown[]): void => {
    for (const child of children) {
      const item = child as { type: string; tagName?: string; value?: string; children?: unknown[] };
      if (item.type === 'text') {
        text += item.value ?? '';
        continue;
      }
      if (item.type !== 'element') continue;
      if (item.tagName === 'ul' || item.tagName === 'ol') continue;
      if (item.tagName === 'input') {
        checkbox ??= item;
        continue;
      }
      if (item.children !== undefined) walk(item.children);
    }
  };
  walk(node.children ?? []);

  return { checkbox, text };
}

function taskListPlugin(): HastPluginDefinition {
  return {
    name: 'thoughtscape-task-lists',
    element: {
      filter: ['li'],
      visit(node, ctx) {
        if (!asClassList(node.properties?.['className']).includes('task-list-item')) return;
        const { checkbox, text } = taskItemContent(node);
        if (checkbox === undefined) return;
        const label = boundLabel(text);
        if (label === '') return;
        ctx.setProperty(checkbox as Parameters<typeof ctx.setProperty>[0], 'aria-label', label);
      },
    },
  };
}

/**
 * Table alignment moves from an inline `style` to `data-align`.
 *
 * satteri emits GFM column alignment as `style="text-align: left"`, which
 * `style-src 'self'` blocks and the sanitizer drops anyway — losing the
 * alignment the author asked for. A data attribute survives both.
 */
function tablePlugin(): HastPluginDefinition {
  return {
    name: 'thoughtscape-tables',
    element: {
      filter: ['th', 'td'],
      visit(node, ctx) {
        const style = node.properties?.['style'];
        if (typeof style !== 'string') return;
        const align = /text-align:\s*(left|center|right)/i.exec(style);
        ctx.setProperty(node, 'style', null);
        if (align) ctx.setProperty(node, 'data-align', align[1]!.toLowerCase());
      },
    },
  };
}

/** hast stores `class` as a string or an array; normalize before inspecting. */
function asClassList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? value.split(/\s+/) : [];
}

/**
 * The fence info string satteri records on a code node, or `undefined` for an
 * unlabelled fence. hast's `ElementData` is an open record with no declared
 * `lang`, so the read is narrowed here rather than asserted at the call site.
 */
function fenceLanguage(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const lang = (data as Record<string, unknown>)['lang'];
  return typeof lang === 'string' ? lang : undefined;
}

/**
 * Explicit sanitization allowlist, replacing `sanitize-html`'s permissive
 * defaults.
 *
 * Deliberately absent, per requirements section 15.2: `script`, `style`,
 * `iframe`, `object`, `embed`, `form`, `svg`, `math`, `base`, `link`, `meta`,
 * and every media element. Nothing grants a `style` attribute or any `on*`
 * handler — an explicit allowlist excludes them by construction rather than by
 * blocklist, so a new handler attribute cannot appear by omission.
 *
 * `allowedSchemesAppliedToAttributes` is deliberately left at the library
 * default, which covers far more URL sinks (`action`, `formaction`, `poster`,
 * `xlink:href`, …) than the three attributes this allowlist grants. Narrowing
 * it would only remove protection.
 */
const POLICY: sanitizeHtml.IOptions = {
  /**
   * satteri and this module's own plugins emit only: `a blockquote code del em
   * h1`–`h6 hr img input li ol p pre section strong sup table tbody td th thead
   * tr ul`, plus `figure` and `span` from the code-block transform.
   *
   * The remainder are reachable only through raw HTML in a note body. They are
   * kept because requirements 15.1 promises a "safe HTML subset", and because a
   * bilingual technical corpus has real uses for them — `ruby`/`rt`/`rp` for
   * CJK annotation, `bdi`/`bdo` for bidirectional text, `wbr` for the long
   * unbroken tokens section 16 calls out, `kbd`/`samp`/`var` for technical
   * prose. Every one of them is inert: none is granted an attribute below
   * beyond the few named there, so none can carry a URL, a handler, or a style.
   *
   * `button` is deliberately absent. Nothing this pipeline emits is a button,
   * and a note body has no use for a control that cannot be wired to anything:
   * the reader would meet a dead affordance. A raw-HTML `<button>` keeps its
   * text and loses the element.
   */
  allowedTags: [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 'del', 's', 'ins', 'mark', 'sup', 'sub',
    'abbr', 'small', 'span', 'q', 'cite', 'kbd', 'samp', 'var', 'time',
    'bdi', 'bdo', 'wbr', 'ruby', 'rt', 'rp', 'dfn',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'blockquote', 'pre', 'code', 'figure', 'figcaption', 'section', 'div',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'input',
  ],
  allowedAttributes: {
    a: [
      'href', 'title', 'class', 'rel', 'aria-label', 'aria-describedby',
      'data-footnote-ref', 'data-footnote-backref', 'id',
    ],
    img: ['src', 'alt', 'title'],
    h1: ['id'],
    h2: ['id', 'class'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
    code: ['class'],
    pre: ['tabindex', 'class'],
    // `tabindex` for the display-math wrapper, which scrolls. Pinned to `0` by
    // the `span` transform below, so a raw-HTML span cannot claim a tab order.
    span: ['class', 'tabindex'],
    li: ['id', 'class'],
    ul: ['class'],
    ol: ['class', 'start'],
    section: ['class', 'data-footnotes'],
    blockquote: ['class', 'cite', 'data-callout'],
    figure: ['class', 'data-code-language', 'data-diagram'],
    figcaption: ['class'],
    div: ['class', 'tabindex'],
    input: ['type', 'checked', 'disabled', 'aria-label'],
    th: ['colspan', 'rowspan', 'scope', 'data-align'],
    td: ['colspan', 'rowspan', 'data-align'],
    col: ['span'],
    colgroup: ['span'],
    time: ['datetime'],
    abbr: ['title'],
    dfn: ['title'],
    bdo: ['dir'],
    q: ['cite'],
  },
  /**
   * `class` is a styling channel into the site's own stylesheet, so only the
   * classes this pipeline emits are allowed through. Every entry is a closed
   * literal or a namespaced prefix — no open pattern that would admit an
   * arbitrary lowercase class such as `site-header` and let body content
   * overlay page chrome. Any tag granted `class` above must appear here, or
   * `sanitize-html` passes its class value through unfiltered.
   */
  allowedClasses: {
    // `data-footnote-backref` is genuinely both: satteri emits it as an
    // attribute *and* as a class value on the same anchor.
    a: ['heading-anchor', 'data-footnote-backref'],
    code: ['language-*'],
    // Namespaced by `namespaceTokenClasses`, so this stays closed.
    span: ['token', 'token-*', 'math-inline', 'math-display'],
    h2: ['sr-only'],
    li: ['task-list-item'],
    ul: ['contains-task-list'],
    ol: [],
    section: ['footnotes'],
    blockquote: ['callout', 'callout-*'],
    // `diagram` is the figure a rendered diagram sits in; `code-block` the one a
    // fence sits in. `diagram-canvas` and `diagram-source` are the two shapes a
    // diagram takes, one per mode.
    figure: ['code-block', 'diagram'],
    figcaption: [],
    div: ['diagram-canvas'],
    pre: ['diagram-source'],
    strong: ['callout-title'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  /**
   * `data:` is granted to `img[src]` alone so an inline raster image survives,
   * matching what TK-01's scanner already permits in the artifact and what
   * requirements 19.3 sets as `img-src 'self' data: https:`. The scheme grant is
   * necessary but not sufficient: the `img` transform additionally requires the
   * URI to be a base64 raster type, so `data:image/svg+xml` and `data:text/html`
   * never reach this check with a payload intact.
   */
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  /**
   * Without this, a disallowed container leaks its text: `<iframe>secret
   * </iframe>` renders as `secret`. Discarding the subtree is the honest
   * behavior for a construct the policy rejects outright.
   */
  nonTextTags: [
    'script', 'style', 'textarea', 'option', 'noscript', 'template',
    'iframe', 'object', 'embed', 'form', 'svg', 'math', 'title',
  ],
};

/**
 * The rendering policy's terminal step. Transforms that must observe *every*
 * anchor and image live here rather than in a hast plugin, because raw HTML in
 * the Markdown body reaches the hast tree as opaque `raw` nodes that element
 * visitors never see — a link rewriter upstream would silently skip
 * `<a href="/other/">` written as raw HTML. `sanitize-html` parses the final
 * HTML, so it sees all of them, and its allowlist runs after `transformTags`.
 */
function sanitize(
  html: string,
  routeForSlug: (slug: string) => string | undefined,
  generatedIds: ReadonlySet<string>,
  rawIds: ReadonlyMap<string, number>,
): string {
  // Each generated id survives exactly once. `headingPlugin` has already made
  // the generated set disjoint from every raw-HTML id, so this no longer
  // arbitrates a collision — it only stops a raw duplicate of a generated id
  // (`&#105;ntroduction` for `introduction`, say) from being emitted twice.
  const unusedIds = new Set(generatedIds);
  const usedFootnoteIds = new Set<string>();
  // One deny token per raw-HTML claim on that id; see the note below.
  const denials = new Map(rawIds);

  return sanitizeHtml(html, {
    ...POLICY,
    transformTags: {
      // Element ids are page-global names, and the layout owns hooks such as
      // `#search-toggle`. Only ids this pipeline generated survive, and each
      // survives exactly once: the heading anchors collected during rendering,
      // and satteri's own footnote ids.
      //
      // Restricted to tags the allowlist actually grants an `id`. On every other
      // tag the id is already dropped by `allowedAttributes` a moment later —
      // `tests/markdown.test.ts` proves that across every allowed tag — so this
      // is not the control that closes the channel, and running it there did
      // real harm: a raw `<div id="introduction">` consumed `introduction` from
      // `unusedIds` before the real heading was reached, and the heading shipped
      // with no id and an anchor pointing nowhere. `headingPlugin` reserves
      // against this same predicate, so the two passes agree on which ids exist.
      //
      // Raw-HTML claims are denied first, and by *count* rather than by
      // membership. Heading anchors need no such help — they are minted after
      // the raw node is seen, so they never collide — but satteri's footnote ids
      // are recognized by *shape*, so a raw `<a id="footnote-label">` would be
      // handed the id simply for appearing first, leaving the real footnote
      // heading without one and pointing the reference's `aria-describedby` at
      // the decoy. A count rather than a set because the raw claim and the
      // genuine element share the id string: denying the string outright would
      // take the id from the footnote too and leave `href="#user-content-fn-a"`
      // dangling. Spending one token per raw claim denies exactly the decoys.
      //
      // ponytail: document order decides which occurrence spends a token, so an
      // interleaving of decoy, real element, decoy would deny the real one. That
      // needs a note to write two raw ids straddling a generated one; the corpus
      // has zero raw ids and zero footnotes, and the bias is toward dropping an
      // id rather than granting a decoy. Revisit if raw HTML ever appears.
      '*': (tagName, attribs) => {
        const id = attribs['id'];
        if (id !== undefined && isIdBearing(tagName)) {
          const owed = denials.get(id) ?? 0;
          if (owed > 0) denials.set(id, owed - 1);
          else {
            if (unusedIds.delete(id)) return { tagName, attribs };
            if (FOOTNOTE_ID.test(id) && !usedFootnoteIds.has(id)) {
              usedFootnoteIds.add(id);
              return { tagName, attribs };
            }
          }
          const { id: _dropped, ...rest } = attribs;
          return { tagName, attribs: rest };
        }
        return { tagName, attribs };
      },
      a: (tagName, attribs) => {
        const match = INTERNAL_HREF.exec(attribs['href'] ?? '');
        if (!match) return { tagName, attribs };
        const route = routeForSlug(match[1]!);
        // An empty or absent route means "not a published slug"; leave the href
        // untouched so a dead link stays visible rather than becoming "/".
        if (!route) return { tagName, attribs };
        return { tagName, attribs: { ...attribs, href: `${route}${match[2] ?? ''}` } };
      },
      // Requirements section 15.1 requires explicit alt text. Missing alt means
      // decorative, which is `alt=""` — never an absent attribute, which makes
      // a screen reader announce the filename.
      //
      // `data:` is allowed on `img[src]` only (see `allowedSchemesByTag`), and
      // only for the base64 raster types TK-01's artifact scanner allowlists.
      // The scheme allowlist alone is too coarse: it would also admit
      // `data:image/svg+xml`, which can carry a script, and `data:text/html`.
      img: (tagName, attribs) => {
        const source = attribs['src'];
        const src =
          source !== undefined && /^data:/i.test(source) && !SAFE_IMAGE_DATA_URI.test(source)
            ? undefined
            : source;
        return {
          tagName,
          attribs: {
            ...attribs,
            ...(src === undefined ? { src: '' } : { src }),
            alt: typeof attribs['alt'] === 'string' ? attribs['alt'] : '',
          },
        };
      },
      // Task-list checkboxes are visual state, not controls. Forcing the shape
      // here also neutralizes any other raw-HTML input (a text field, a hidden
      // field) instead of relying on the tag allowlist alone. `checked` and
      // `disabled` are boolean attributes, so an empty value emits the bare
      // form; `sanitize-html` treats `hidden` as non-boolean and needs a value.
      //
      // `aria-label` is preserved when `taskListPlugin` set one — it is the
      // item's own text, and dropping it here would reinstate the axe `label`
      // violation this shape otherwise causes.
      //
      // Re-bounded rather than trusted. Raw HTML in a note body reaches this
      // transform too, and by the time the final HTML is parsed a label the
      // plugin wrote is indistinguishable from one a raw `<input>` carried — so
      // without this, body content has an unbounded attribute channel, which is
      // the same hazard `calloutPlugin` bounds its `data-callout` against. The
      // limit is `taskListPlugin`'s own, so the plugin's labels pass through
      // unchanged and only an over-long one is cut.
      input: (tagName, attribs) => {
        const label = attribs['aria-label'];
        return {
          tagName,
          attribs: {
            type: 'checkbox',
            disabled: '',
            ...(typeof label === 'string' && label !== ''
              ? { 'aria-label': boundLabel(label) }
              : {}),
            ...('checked' in attribs ? { checked: '' } : {}),
          },
        };
      },
      // A `<pre>` scrolls horizontally when a line is longer than the measure,
      // and a scrollable region must be reachable by keyboard — axe
      // `scrollable-region-focusable`, WCAG 2.1.1. `tabindex="0"` is the whole
      // fix: the browser then scrolls it with the arrow keys. No `role`, because
      // `<pre>` already conveys preformatted text, and no `aria-label`, which
      // would make a screen reader announce a name for every fence.
      //
      // Forced here rather than set in `codePlugin` so it reaches *every* `pre`:
      // the highlighted code fences, the client-mode diagram source, and any
      // raw-HTML one. Forcing also pins the value — a raw `tabindex="5"` would
      // otherwise hijack the document's tab order.
      pre: (tagName, attribs) => ({ tagName, attribs: { ...attribs, tabindex: '0' } }),
      // The display-math wrapper is the one `span` this pipeline gives a
      // `tabindex`, because it scrolls. Pinning the value here rather than
      // trusting the plugin closes the same channel `pre` closes above: by the
      // time the final HTML is parsed, a raw-HTML `<span tabindex="5">` is
      // indistinguishable from one the plugin wrote, and it would hijack the
      // document's tab order. A `span` with any other class keeps none.
      span: (tagName, attribs) => {
        const { tabindex: _dropped, ...rest } = attribs;
        const isScrollable = (attribs['class'] ?? '').split(/\s+/).includes('math-display');
        return { tagName, attribs: isScrollable ? { ...rest, tabindex: '0' } : rest };
      },
      // The diagram's scroll container, by the same rule and for the same
      // reason: it is the one `div` this pipeline gives a `tabindex`, and the
      // value is pinned here so a raw-HTML `<div tabindex="5">` cannot claim a
      // place in the document's tab order.
      div: (tagName, attribs) => {
        const { tabindex: _dropped, ...rest } = attribs;
        const isScrollable = (attribs['class'] ?? '').split(/\s+/).includes('diagram-canvas');
        return { tagName, attribs: isScrollable ? { ...rest, tabindex: '0' } : rest };
      },
    },
  });
}

/**
 * Replace each placeholder with the markup it stands for.
 *
 * Positional and exhausting, which is what makes it safe to splice
 * sanitizer-exempt markup into sanitized HTML. Each token is looked for exactly
 * once and by its exact string; the replacement is chosen by the token's own
 * index in the list this render built, so no property of the *document* selects
 * what gets inserted. A count mismatch — the shape a note body writing the
 * literal token would produce — throws rather than resolving to something.
 *
 * `split`/`join` rather than `replace`: a `$` in the replacement is a
 * substitution pattern to `String.replace`, and rendered MathML and SVG both
 * contain `$` in base64 payloads and TeX text. `replaceAll` with a string
 * replacement has the same hazard.
 */
function substituteRendered(
  html: string,
  replacements: readonly { token: string; markup: string }[],
): string {
  let result = html;
  for (const { token, markup } of replacements) {
    const parts = result.split(token);
    if (parts.length !== 2) {
      throw new Error(
        `rendering placeholder appeared ${parts.length - 1} times, expected exactly once. ` +
          'A note body that writes the placeholder text itself causes this; the text is ' +
          `"${token}".`,
      );
    }
    result = parts.join(markup);
  }

  // Every marker is now spent. A body that wrote one this render never minted —
  // a different index, or the diagram form on a page with only math — would
  // otherwise ship it as visible gibberish, while the *same* body on a page
  // whose indices happened to match failed the build. Checking the shape rather
  // than the exact strings makes the invariant total, so the two cases behave
  // alike and neither can reach a reader.
  const residue = new RegExp(`${DIAGRAM_TOKEN_PREFIX}|${MATH_TOKEN_PREFIX}`).exec(result);
  if (residue !== null) {
    throw new Error(
      `a rendering placeholder survived substitution: "${residue[0]}". A note body that ` +
        'writes the placeholder text itself causes this.',
    );
  }

  return result;
}

/** Nest a flat, document-order heading list by depth. */
function buildToc(headings: readonly Heading[]): TocEntry[] {
  const roots: TocEntry[] = [];
  const open: TocEntry[] = [];
  for (const heading of headings) {
    const entry: TocEntry = { ...heading, children: [] };
    while (open.length > 0 && open[open.length - 1]!.depth >= entry.depth) open.pop();
    (open[open.length - 1]?.children ?? roots).push(entry);
    open.push(entry);
  }
  return roots;
}

/**
 * Render one artifact entry's Markdown to sanitized HTML and page metadata.
 *
 * @param markdown Body Markdown from a validated content entry.
 * @param options Injected rendering seams; see {@link RenderOptions}.
 */
export async function renderMarkdown(markdown: string, options: RenderOptions = {}): Promise<RenderedNote> {
  const routeForSlug = options.routeForSlug ?? defaultRouteForSlug;
  // The document's own chrome, or the navigation language for a caller that
  // renders no particular document. See `RenderOptions.chrome`.
  const chrome = options.chrome ?? translate(NAV_LANGUAGE);
  const collected: Collected = {
    headings: [],
    rawIds: new Map(),
    hasCode: false,
    hasMath: false,
    hasMermaid: false,
  };
  const diagrams: DiagramRequest[] = [];
  const maths: MathRequest[] = [];

  const { html } = await markdownToHtml(markdown, {
    features: featuresFor(chrome),
    hastPlugins: [
      headingPlugin(collected, options.pageTitle, chrome.headingAnchorLabel),
      calloutPlugin(),
      mathPlugin(collected, maths),
      codePlugin(collected, diagrams, chrome.diagramCaption),
      taskListPlugin(),
      tablePlugin(),
    ],
  });

  const sanitized = sanitize(
    html,
    routeForSlug,
    new Set(collected.headings.map((heading) => heading.id)),
    collected.rawIds,
  );

  // Rendered after sanitization, at markers the sanitizer preserved. Both
  // renderers are the trust boundary for their own output; see the note on
  // `DIAGRAM_TOKEN_PREFIX`. A render failure throws and stops the build, which
  // is the intended behaviour for a construct that cannot be shown safely.
  const replacements = [
    ...maths.map((request) => ({
      token: request.token,
      markup: renderMath(request.tex, request.isDisplay),
    })),
    // `diagramIdFor` namespaces element ids by the diagram's position, so two
    // diagrams on one page cannot both define `#arrowhead`.
    ...(await Promise.all(
      diagrams.map(async (request, index) => ({
        token: request.token,
        markup: await renderDiagram(
          request.source,
          `diagram-${index}`,
          diagramCaption(request.source, chrome.diagramCaption),
        ),
      })),
    )),
  ];

  return {
    html: substituteRendered(sanitized, replacements),
    headings: collected.headings,
    toc: collected.headings.length >= TOC_MIN_HEADINGS ? buildToc(collected.headings) : [],
    hasCode: collected.hasCode,
    hasMath: collected.hasMath,
    hasMermaid: collected.hasMermaid,
  };
}
