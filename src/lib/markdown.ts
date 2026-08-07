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

import { markdownToHtml, type Features, type HastPluginDefinition } from 'satteri';
import Slugger from 'github-slugger';
import sanitizeHtml from 'sanitize-html';
import { runHighlighterWithAstro } from '@astrojs/prism/dist/highlighter';
import prismComponents from 'prismjs/components.json' with { type: 'json' };

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

export interface RenderOptions {
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
 *   and misparsing it corrupts the sentence. Math renders as plain source; see
 *   `MATH_LANGUAGE` below.
 * - `smartPunctuation` off — it rewrites `--` to an en-dash, which is wrong for
 *   the CLI flags this corpus is full of.
 * - `wikilinks` off — the exporter resolves public wikilinks to routes, and
 *   TK-01 rejects any artifact still carrying `[[`. Parsing them here would
 *   quietly render a link the projection never approved (section 15.2).
 * - `headingAttributes` off — `# text { #id .class }` would let body content
 *   choose its own ids and classes, defeating the anchor and class allowlists.
 */
const FEATURES: Features = {
  gfm: true,
  frontmatter: false,
  math: { singleDollarTextMath: false },
  smartPunctuation: false,
  wikilinks: false,
  headingAttributes: false,
};

/** Class satteri puts on math code nodes; also the fence language for math. */
const MATH_LANGUAGE = 'math';

/**
 * Fence languages that are never handed to the highlighter.
 *
 * `mermaid` is the recorded downgrade: rendering a diagram at build time would
 * cost a headless-browser-class dependency, and every runtime Mermaid renderer
 * needs `unsafe-eval`. Requirements section 15.2 permits rendering a downgraded
 * construct as plain source, so a Mermaid block ships as an escaped code block
 * tagged `data-diagram="mermaid"`. Math is excluded for the same reason: KaTeX
 * would be a heavyweight new dependency, so `$$…$$` ships as plain source.
 */
const UNHIGHLIGHTED_LANGUAGES: ReadonlySet<string> = new Set([MATH_LANGUAGE, 'mermaid']);

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
  hasCode: boolean;
  hasMath: boolean;
  hasMermaid: boolean;
}

/**
 * Stable anchor ids plus a visible, labelled link to each heading.
 *
 * Headings that already carry an id are generated structure (satteri's footnote
 * label), not authored content: they keep their id and stay out of the heading
 * tree.
 */
function headingPlugin(collected: Collected): HastPluginDefinition {
  const slugger = new Slugger();
  return {
    name: 'thoughtscape-headings',
    element: {
      filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      visit(node, ctx) {
        if (typeof node.properties?.['id'] === 'string') return;
        const text = ctx.textContent(node);
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
            'aria-label': `Link to section: ${text}`,
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
 * Code fences become `figure > pre > code` with build-time highlighting and a
 * copy affordance.
 *
 * The button ships `hidden` and does nothing on its own: with the target CSP
 * there is no inline handler to attach, so an external module (TK-02's script
 * scope) unhides and wires it. Shipping it hidden keeps the no-JavaScript page
 * free of a dead control.
 *
 * Math reaches this visitor too — satteri renders `$$…$$` as
 * `pre > code.language-math` with no fence language — and is skipped so it stays
 * plain, escaped source rather than acquiring a copy button for an equation.
 */
function codePlugin(collected: Collected): HastPluginDefinition {
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
          const isMermaid = language === 'mermaid';
          if (isMermaid) collected.hasMermaid = true;
          else collected.hasCode = true;

          return {
            type: 'element',
            tagName: 'figure',
            properties: {
              className: ['code-block'],
              'data-code-language': language,
              ...(isMermaid ? { 'data-diagram': 'mermaid' } : {}),
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
              {
                type: 'element',
                tagName: 'button',
                properties: { className: ['copy-code'], 'data-copy-code': '' },
                children: [{ type: 'text', value: 'Copy' }],
              },
            ],
          };
        },
      },
      {
        filter: ['code'],
        visit(node) {
          if (asClassList(node.properties?.['className']).includes(`language-${MATH_LANGUAGE}`)) {
            collected.hasMath = true;
          }
        },
      },
    ],
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
   * tr ul`, plus `figure`, `button`, and `span` from the code-block transform.
   *
   * The remainder are reachable only through raw HTML in a note body. They are
   * kept because requirements 15.1 promises a "safe HTML subset", and because a
   * bilingual technical corpus has real uses for them — `ruby`/`rt`/`rp` for
   * CJK annotation, `bdi`/`bdo` for bidirectional text, `wbr` for the long
   * unbroken tokens section 16 calls out, `kbd`/`samp`/`var` for technical
   * prose. Every one of them is inert: none is granted an attribute below
   * beyond the few named there, so none can carry a URL, a handler, or a style.
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
    'a', 'img', 'input', 'button',
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
    span: ['class'],
    li: ['id', 'class'],
    ul: ['class'],
    ol: ['class', 'start'],
    section: ['class', 'data-footnotes'],
    blockquote: ['class', 'cite', 'data-callout'],
    figure: ['class', 'data-code-language', 'data-diagram'],
    button: ['type', 'class', 'hidden', 'aria-label', 'data-copy-code'],
    input: ['type', 'checked', 'disabled'],
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
    code: ['language-*', 'math-inline', 'math-display'],
    // Namespaced by `namespaceTokenClasses`, so this stays closed.
    span: ['token', 'token-*'],
    h2: ['sr-only'],
    li: ['task-list-item'],
    ul: ['contains-task-list'],
    ol: [],
    section: ['footnotes'],
    blockquote: ['callout', 'callout-*'],
    figure: ['code-block'],
    button: ['copy-code'],
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
): string {
  // Raw HTML reaches the hast tree as an opaque `raw` node, so a
  // `<h2 id="introduction">` written by hand never passes through the slugger
  // and never gets deduplicated. Consuming each id on first use is what keeps
  // it from shadowing the real heading's anchor.
  const unusedIds = new Set(generatedIds);
  const usedFootnoteIds = new Set<string>();

  return sanitizeHtml(html, {
    ...POLICY,
    transformTags: {
      // Element ids are page-global names, and the layout owns hooks such as
      // `#search-toggle`. Only ids this pipeline generated survive, and each
      // survives exactly once: the heading anchors collected during rendering,
      // and satteri's own footnote ids. Everything else is dropped. This runs
      // on every tag, so no future `id` grant can reopen the channel.
      '*': (tagName, attribs) => {
        const id = attribs['id'];
        if (id !== undefined) {
          if (unusedIds.delete(id)) return { tagName, attribs };
          if (FOOTNOTE_ID.test(id) && !usedFootnoteIds.has(id)) {
            usedFootnoteIds.add(id);
            return { tagName, attribs };
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
      input: (tagName, attribs) => ({
        tagName,
        attribs: {
          type: 'checkbox',
          disabled: '',
          ...('checked' in attribs ? { checked: '' } : {}),
        },
      }),
      // A raw-HTML `<button>` defaults to type="submit"; pin it so it can never
      // act as one. `hidden` is forced rather than set upstream because
      // `sanitize-html` treats it as non-boolean and drops a valueless
      // `hidden`, and because a raw-HTML button must be inert too.
      button: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, type: 'button', hidden: 'hidden' },
      }),
    },
  });
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
  const collected: Collected = { headings: [], hasCode: false, hasMath: false, hasMermaid: false };

  const { html } = await markdownToHtml(markdown, {
    features: FEATURES,
    hastPlugins: [
      headingPlugin(collected),
      calloutPlugin(),
      codePlugin(collected),
      tablePlugin(),
    ],
  });

  return {
    html: sanitize(html, routeForSlug, new Set(collected.headings.map((heading) => heading.id))),
    headings: collected.headings,
    toc: collected.headings.length >= TOC_MIN_HEADINGS ? buildToc(collected.headings) : [],
    hasCode: collected.hasCode,
    hasMath: collected.hasMath,
    hasMermaid: collected.hasMermaid,
  };
}
