/**
 * Assertions over the routes the build actually emitted.
 *
 * The route model's own logic is tested against synthetic fixtures in
 * `tests/route-model.test.ts`. What is checked here is that `dist/` contains
 * exactly the routes the model predicts from the real artifact, that no
 * in-content link points at a route that does not exist, and that the emitted
 * redirect map matches the artifact rather than a stale committed copy.
 *
 * Run `pnpm run build` before `pnpm test`; the suite fails loudly rather than
 * skipping when `dist/` is absent.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'vitest';

import { entries, getEntry } from '../src/lib/content.ts';
import { readArtifact } from '../src/lib/artifact-source.ts';
import { SCHEMA_VERSION } from '../src/lib/schema.ts';
import { UNCOLLECTED_LABEL } from '../src/lib/collection-navigation.ts';
import {
  RELATED_DERIVATION,
  RELATED_LIMIT,
  collectionNeighbours,
  hasTagPeer,
  relatedNotes,
} from '../src/lib/relations.ts';
import {
  FIXED_ROUTES,
  REDIRECT_RULES,
  SITE_MAP,
  collectionFacets,
  collectionRoute,
  isRouteKey,
  noteRoute,
  noteSlugFromPath,
  noteTimestamp,
  recentFirst,
  renderRedirects,
  routeKey,
  tagFacets,
  tagRoute,
} from '../src/lib/routes.ts';

const DIST = new URL('../dist/', import.meta.url);

function exists(url: URL): boolean {
  try {
    statSync(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every route `dist/` serves, as the path a browser would request.
 *
 * Pagefind's own output is excluded: it is a third-party search bundle, not a
 * route this ticket's model owns.
 */
function builtRoutes(): string[] {
  const found: string[] = [];
  const walk = (dir: URL, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'pagefind') continue;
      const child = new URL(name, dir);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, dir), `${prefix}${name}/`);
      else if (name === 'index.html') found.push(prefix === '' ? '/' : `/${prefix}`);
      else if (name.endsWith('.html')) found.push(`/${prefix}${name}`);
    }
  };
  if (!exists(DIST)) assert.fail('dist/ is missing — run `pnpm run build` before `pnpm test`');
  walk(DIST, '');
  return found.sort();
}

/** The exact set of routes this artifact should produce. */
function expectedRoutes(): string[] {
  return [
    ...FIXED_ROUTES,
    // Not a route in the navigable sense: the host serves it for an unmatched
    // request. It is listed because it is a file `dist/` must contain.
    '/404.html',
    ...entries.map((entry) => noteRoute(entry.slug)),
    ...tagFacets(entries).map((facet) => tagRoute(facet.key)),
    ...collectionFacets(entries).map((facet) => collectionRoute(facet.key)),
  ].sort();
}

const ROUTES = builtRoutes();

/** The file in `dist/` a built route is served from. */
function pageFor(route: string): string {
  return route.endsWith('.html') ? route.slice(1) : `${route.slice(1)}index.html`;
}

test('the build emits exactly the expected route set, with no extras', () => {
  assert.deepEqual(ROUTES, expectedRoutes());
});

test('every published note is served from its canonical route', () => {
  for (const entry of entries) {
    assert.ok(ROUTES.includes(noteRoute(entry.slug)), `note "${entry.slug}" is not at its canonical route`);
  }
});

test('no note is served from a path other than its canonical route', () => {
  // The pre-TK-04 `/<slug>/` path must not be a second live copy of the note:
  // two live copies of one note is a duplicate-content and a withdrawal
  // problem. It is not a redirect either — see `REDIRECT_RULES`.
  for (const entry of entries) {
    assert.ok(!ROUTES.includes(`/${entry.slug}/`), `note "${entry.slug}" is served at a second path`);
  }
});

test('a static 404 is emitted for the host to serve', () => {
  assert.ok(exists(new URL('404.html', DIST)), 'dist/404.html is missing');
});

test('the served content index describes the corpus the site was built from', () => {
  // `public/` is copied verbatim, so a build from a different artifact than the
  // one that generated `public/content-index.json` serves an index describing a
  // corpus that is not on the site — and every hover preview silently finds
  // nothing, with no error anywhere. The first fixture build did exactly that:
  // one index entry alongside thirty-two note pages.
  const served = JSON.parse(readFileSync(new URL('content-index.json', DIST), 'utf8')) as {
    entries: { slug: string; title: string; excerpt: string }[];
  };
  assert.deepEqual(
    served.entries,
    entries.map(({ slug, title, excerpt }) => ({ slug, title, excerpt })),
    'dist/content-index.json is not the projection of the artifact this site was built from',
  );
});

/**
 * Every public route segment is drawn from the route vocabulary.
 *
 * This enumerates what the build actually wrote to disk rather than what the
 * model would produce, because the two are only the same while nothing writes a
 * path by another route. Tag keys are the reason it exists: they are the one
 * segment derived from free artifact text rather than from a validated slug, and
 * before TK-11 the only rejected key was the empty string — so a tag of
 * `🌱 seedling` published `/tags/-seedling/` and `---` published `/tags/---/`.
 *
 * Non-ASCII is deliberately allowed. `/tags/笔记/` is a correct public URL for a
 * corpus with Chinese tags, and requiring ASCII would mean percent-encoding
 * every CJK tag route into something unreadable.
 */
test('no public route contains a character outside the slug vocabulary', () => {
  const segments = new Set(
    ROUTES.flatMap((route) => route.replace(/\.html$/, '').split('/')).filter((part) => part !== ''),
  );
  assert.ok(segments.size > 0, 'no route segment was inspected');

  for (const segment of segments) {
    assert.ok(
      isRouteKey(segment),
      `built route segment "${segment}" is not an addressable public route segment`,
    );
  }
});

/**
 * The same property, stated over the bytes of a URL rather than its characters.
 *
 * `isRouteKey` admits any letter, which is right for `/tags/笔记/` and would
 * still admit a segment that is invisible, whitespace-bearing, or reserved by
 * URL syntax. These are the characters that would make a route ambiguous or
 * unlinkable regardless of script.
 */
test('no public route segment carries a character that breaks a URL', () => {
  // The `\[` is redundant inside a character class, but this is a reviewed
  // privacy gate and the escape is behaviour-identical; unescaping it is a
  // formatting change, which is TK-20's.
  // oxlint-disable-next-line no-useless-escape
  const FORBIDDEN = /[\s?#\[\]@!$&'()*+,;=%\\<>"^`{|}]/;
  for (const route of ROUTES) {
    assert.doesNotMatch(route, FORBIDDEN, `built route "${route}" carries a URL-unsafe character`);
    // A path that changes when a browser normalizes it is a path that resolves
    // somewhere other than where the build wrote it.
    assert.equal(
      new URL(route, 'https://example.invalid').pathname,
      encodeURI(route),
      `built route "${route}" is not stable under URL normalization`,
    );
  }
});

test('the emitted redirect map matches the route model exactly', () => {
  const file = new URL('_redirects', DIST);
  assert.ok(exists(file), 'dist/_redirects is missing — the build step did not run');

  // The version stamp is recomputed from the artifact bytes rather than read
  // out of the file, so a map generated from a different artifact than the one
  // `dist/` was built from fails here instead of shipping. The bytes come from
  // whichever artifact this build selected, so a fixture build compares against
  // the fixture rather than against the published corpus.
  //
  // Deliberately hashed here rather than through `contentVersion()`, which the
  // two scripts share: a gate that computes the expected value with the same
  // function the subject used cannot see that function go wrong. This is the
  // one place a second, independent implementation earns its keep.
  const source = readArtifact();
  const content = `sha256:${createHash('sha256').update(source).digest('hex')}`;

  assert.equal(
    readFileSync(file, 'utf8'),
    renderRedirects(REDIRECT_RULES, { schema: SCHEMA_VERSION, content }),
  );
});

test('every redirect target is a route the build actually emitted', () => {
  // Vacuous while `REDIRECT_RULES` is empty, which is the current and correct
  // state. It is the assertion that has to hold the first time a rule appears.
  for (const rule of REDIRECT_RULES) {
    assert.ok(ROUTES.includes(rule.to), `redirect ${rule.from} points at ${rule.to}, which was not built`);
    assert.ok(!ROUTES.includes(rule.from), `redirect source ${rule.from} is also a live page`);
  }
});

/** Every same-origin href in the built pages, with the page that carries it. */
function internalLinks(): { file: string; href: string }[] {
  const links: { file: string; href: string }[] = [];
  const walk = (dir: URL): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'pagefind') continue;
      const child = new URL(name, dir);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (name.endsWith('.html')) {
        const file = fileURLToPath(child);
        for (const [, href] of readFileSync(file, 'utf8').matchAll(/<a\b[^>]*\shref="([^"]*)"/gi)) {
          if (href!.startsWith('/') && !href!.startsWith('//')) links.push({ file, href: href! });
        }
      }
    }
  };
  walk(DIST);
  return links;
}

test('every internal link resolves to a built route', () => {
  const assets = new Set(['/favicon.svg', '/favicon.ico', '/robots.txt', '/content-index.json']);
  const links = internalLinks();
  assert.ok(links.length > 0, 'the build emitted no internal links to check');

  for (const { file, href } of links) {
    const [path] = href.split('#') as [string];
    if (path === '' || assets.has(path)) continue;
    assert.ok(ROUTES.includes(path), `${file}: link to "${href}" resolves to no built route`);
  }
});

test('no in-content link points at a bare /<slug>/ path', () => {
  // Vacuous on a corpus whose entries have no outgoing links, which is the
  // artifact as it stands. It is kept because it is the assertion that matters
  // once the corpus grows; `renderMarkdown` is exercised directly below so the
  // rewrite itself is proven either way.
  //
  // This matters more since TK-12 removed the `/<slug>/` redirect pair: such a
  // link is now a 404, not a hop. The gate above ("every internal link resolves
  // to a built route") would also catch it; this one names the cause.
  const bare = new Set(entries.map((entry) => `/${entry.slug}/`));
  for (const { file, href } of internalLinks()) {
    const [path] = href.split('#') as [string];
    assert.ok(!bare.has(path), `${file}: link to "${href}" skips the /notes/ segment`);
  }
});

test('the note page wires the renderer to the canonical route', async () => {
  // The gate above cannot see this today: no published entry links to another,
  // so no `/<slug>/` href ever reaches the renderer. This renders the mapping
  // the page actually passes, against markdown that does contain one.
  //
  // TK-03 owns the rewrite; what is proven here is that TK-04 wired it — a
  // published slug reaches its canonical route, an unpublished one is left
  // alone rather than pointed at a route that does not exist.
  const published = entries[0];
  assert.ok(published, 'the artifact has no entry to check the mapping against');

  const { renderMarkdown } = await import('../src/lib/markdown.ts');
  const { getEntry } = await import('../src/lib/content.ts');
  const { html } = await renderMarkdown(
    `[a](/${published.slug}/) [b](/${published.slug}/#section) [c](/no-such-note/)\n`,
    { routeForSlug: (slug) => (getEntry(slug) ? noteRoute(slug) : undefined) },
  );

  assert.ok(html.includes(`href="${noteRoute(published.slug)}"`), `not rewritten: ${html}`);
  assert.ok(html.includes(`href="${noteRoute(published.slug)}#section"`), `fragment lost: ${html}`);
  assert.ok(html.includes('href="/no-such-note/"'), `an unpublished slug was rewritten: ${html}`);
});

test('every page links every fixed route, so no route is an orphan', () => {
  // The footer site map is what makes this true; it survives reader mode.
  const byFile = new Map<string, Set<string>>();
  for (const { file, href } of internalLinks()) {
    const [path] = href.split('#') as [string];
    (byFile.get(file) ?? byFile.set(file, new Set()).get(file)!).add(path === '' ? '/' : path);
  }
  assert.ok(byFile.size > 0, 'no page was inspected');

  for (const [file, hrefs] of byFile) {
    for (const item of SITE_MAP) {
      assert.ok(hrefs.has(item.href), `${file}: does not link "${item.href}" (${item.label})`);
    }
  }
});

/**
 * A label as it appears in built HTML.
 *
 * Comparing a raw artifact label against the page is wrong the moment a label
 * contains a character Astro escapes: `Ops & SRE` renders as `Ops &amp; SRE`, so
 * the naive `includes` reported the facet missing from a page that lists it.
 * The check passed until now only because no label had ever contained an
 * ampersand — the corpus carried no tags at all.
 */
function asRendered(label: string): string {
  return label
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

test('the tag and collection indexes render an honest empty state, never a 404', () => {
  for (const [route, marker] of [
    ['tags', 'carries no tags'],
    ['collections', 'carries no collections'],
  ] as const) {
    const html = readFileSync(new URL(`${route}/index.html`, DIST), 'utf8');
    const facets = route === 'tags' ? tagFacets(entries) : collectionFacets(entries);
    if (facets.length === 0) {
      assert.ok(html.includes(marker), `/${route}/ does not explain that the projection carries none`);
      assert.doesNotMatch(html, /class="facet-list"/, `/${route}/ rendered a list with no facets`);
    } else {
      assert.match(html, /class="facet-list"/, `/${route}/ has facets but rendered no list`);
      for (const facet of facets) {
        assert.ok(
          html.includes(asRendered(facet.label)),
          `/${route}/ omits the facet "${facet.label}"`,
        );
      }
    }
  }
});

/**
 * The page's main landmark only.
 *
 * A claim must be made to the reader, not hidden in a `<meta>` description.
 * Reading the whole document let a seeded "We use some analytics." pass,
 * because the layout's own description still carried the words the gate looked
 * for.
 */
function mainOf(route: string): string {
  const html = readFileSync(new URL(route, DIST), 'utf8');
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  assert.ok(main, `${route}: has no main landmark to read`);
  return main[1]!;
}

test('the about and privacy pages state the publication and tracking boundary', () => {
  const about = mainOf('about/index.html').toLowerCase();
  for (const claim of ['approved for publication', 'is not published', 'static file']) {
    assert.ok(about.includes(claim), `/about/ does not state "${claim}"`);
  }

  const privacy = mainOf('privacy/index.html').toLowerCase();
  for (const claim of [
    'no analytics on this site',
    'no comments',
    'no third-party tracking',
    'sets no cookies',
  ]) {
    assert.ok(privacy.includes(claim), `/privacy/ does not state "${claim}"`);
  }
});

test('no page this repository authors describes how the private source is organized', () => {
  // Scope is derived, not hand-picked: every built page that is NOT a note.
  // An earlier draft listed three pages by name, which is how a gate stops
  // being evidence — the list had been chosen to exclude a page that failed.
  //
  // Note bodies are excluded on principle, not convenience: they are reviewed,
  // allowlisted artifact content, already scanned by TK-01's privacy rules and
  // TK-03's residue test. Scanning them here would reject a published note for
  // telling a reader to `cd` into their own certificate directory.
  //
  // What is forbidden is *structure*: requirements section 10.2 lists private
  // vault paths, local machine paths, and raw frontmatter — not the fact that
  // a private source exists. TK-04 scope item 6 requires `/about/` to state the
  // publication boundary, which cannot be done without saying there is
  // something on the other side of it. So "vault" and "Obsidian" are
  // deliberately absent below; what would disclose organization is not.
  const forbidden: readonly [RegExp, string][] = [
    [/\bfolders?\b/i, 'a folder layout'],
    [/\bsubfolder/i, 'a folder layout'],
    [/\bdirector(?:y|ies)\b/i, 'a directory layout'],
    [/frontmatter/i, 'frontmatter fields'],
    [/publication manifest|allowlist file/i, 'the manifest mechanics'],
    [/msw\//i, 'a private path marker'],
    [/(?<![A-Za-z])[A-Za-z]:[\\/]/, 'an absolute local path'],
    [/\.(?:md|canvas)\b/i, 'a source filename'],
  ];

  const authored = ROUTES.filter((route) => noteSlugFromPath(route) === undefined);
  assert.ok(authored.length > 0, 'no authored page was inspected');
  assert.ok(
    authored.length < ROUTES.length || entries.length === 0,
    'every route looked authored — the note filter is not working',
  );

  for (const route of authored) {
    const page = pageFor(route);
    const html = readFileSync(new URL(page, DIST), 'utf8');
    for (const [pattern, what] of forbidden) {
      assert.doesNotMatch(html, pattern, `${page}: discloses ${what} (${pattern})`);
    }
  }
});

// --- Page anatomy -------------------------------------------------------------

/**
 * Every built note page, as `{slug, html}`.
 *
 * Fails rather than returning empty: every assertion below is a `for` over this
 * list, so an artifact with no entries would make all of them pass while
 * checking nothing. An empty corpus is a legitimate artifact — the tag and
 * collection indexes have an honest empty state for exactly that — but it is
 * not a state in which these gates are evidence.
 */
function notePages(): { slug: string; html: string }[] {
  assert.ok(entries.length > 0, 'the artifact has no notes, so no page anatomy can be checked');
  return entries.map((entry) => ({
    slug: entry.slug,
    html: readFileSync(new URL(`notes/${entry.slug}/index.html`, DIST), 'utf8'),
  }));
}

/**
 * One of the three relationship sections, by the region it labels.
 *
 * The three are one component rendered three times and share a class, so the
 * `aria-labelledby` id is what tells them apart — which is also what a screen
 * reader uses, so a gate that could not find a section by its accessible name
 * would be checking something a reader never meets.
 */
function relationSection(html: string, name: string): string | undefined {
  const pattern = new RegExp(`<aside class="relations" aria-labelledby="${name}-title">[\\s\\S]*?</aside>`);
  return pattern.exec(html)?.[0];
}

/** The note slugs a fragment of built HTML links to, in document order. */
function linkedSlugs(html: string): string[] {
  return [...html.matchAll(/href="\/notes\/([^/"]+)\//g)].map(([, slug]) => slug!);
}

/**
 * Requirements section 9.2 lists thirteen page elements. Five later tickets own
 * five of them, and this asserts what TK-05a is responsible for rather than the
 * whole list — a gate that asserted the absent regions would either fail or,
 * worse, be satisfied by an empty stub.
 */
test('every note page carries the anatomy this ticket owns', () => {
  for (const { slug, html } of notePages()) {
    assert.match(html, /<nav class="breadcrumbs" aria-label="Breadcrumb">/, `${slug}: no breadcrumbs`);
    assert.match(html, /<h1 class="note-title">/, `${slug}: no page title`);
    assert.match(html, /<article class="prose" data-pagefind-body>/, `${slug}: no article body`);
    assert.match(html, /<footer class="note-footer">/, `${slug}: no provenance footer`);
    assert.ok(
      // TK-05a emitted the route here and said TK-08 would upgrade it once
      // `site:` was configured; it now carries the absolute canonical URL, which
      // is what makes a printed or quoted page findable again. The origin is
      // matched rather than restated — `tests/metadata.test.ts` owns the
      // assertion that it is the configured one, in one place.
      new RegExp(`Canonical URL: https?://[^/<]+${noteRoute(slug)}<`).test(html),
      `${slug}: the footer does not carry the canonical URL`,
    );
  }
});

/**
 * The three relationship sections are on every note page, populated or not.
 *
 * Scope item 6: an empty state is explicit, never a silently omitted section.
 * The published corpus is one note with two empty edge arrays and no tags, so
 * all three are empty there — which is exactly the case a reader would
 * otherwise be unable to distinguish from a site that has no such sections.
 */
test('every note page carries all three relationship sections', () => {
  for (const { slug, html } of notePages()) {
    for (const name of ['outgoing', 'backlinks', 'related']) {
      const section = relationSection(html, name);
      assert.ok(section, `${slug}: no "${name}" section`);
      assert.match(section, /<h2 id="[^"]+-title">/, `${slug}: the "${name}" section has no heading`);
      const populated = /<ul class="relations-list">/.test(section);
      const empty = /<p class="empty-state">/.test(section);
      assert.ok(
        populated !== empty,
        `${slug}: the "${name}" section renders ${populated ? 'both a list and' : 'neither a list nor'} an empty state`,
      );
    }
  }
});

/**
 * The rendered edge lists are the artifact's edge sets exactly.
 *
 * Both directions, on every page rather than on one hub: a section that listed
 * a note the artifact does not name would be a fabricated relationship, and one
 * that omitted a named note would be a link a reader cannot follow.
 *
 * **This gate does not claim the page's links are complete.** The exporter
 * derives `outgoing` from wikilinks only, so the edge set and the body's own
 * links can disagree in either direction: a plain Markdown link in a body
 * produces a live `<a>` with no edge behind it, and — the direction the fixture
 * corpus actually contains, in three entries — an edge exists for a note the
 * body never links in prose. What is asserted is that the section matches the
 * artifact, which is the property this repository can be responsible for. The
 * exporter contract is TK-19's.
 */
test('the outgoing and backlink sections match the artifact edges exactly', () => {
  for (const { slug, html } of notePages()) {
    const entry = getEntry(slug)!;
    for (const [name, expected] of [
      ['outgoing', entry.outgoing],
      ['backlinks', entry.backlinks],
    ] as const) {
      const section = relationSection(html, name)!;
      assert.deepEqual(
        linkedSlugs(section).sort(),
        [...expected].sort(),
        `${slug}: the "${name}" section is not the artifact's edge set`,
      );
    }
  }
});

/**
 * Every relationship link is a title that resolves, and the two edge lists are
 * in title order.
 *
 * Order is the requirement (section 13.1 asks for a stable sort order) and
 * titles are the reason it is not the artifact's own order: both edge arrays
 * are stored sorted by slug, which is a URL segment a reader never sees.
 *
 * The related list is deliberately excluded from the ordering half: it is
 * ranked by relevance, and title order there would discard the ranking. Its own
 * order is pinned against the derivation in the multi-entry gate below.
 */
test('relationship links carry the destination title, and edge lists are in title order', () => {
  let orderedLists = 0;

  for (const { slug, html } of notePages()) {
    for (const name of ['outgoing', 'backlinks', 'related']) {
      const section = relationSection(html, name)!;
      const rendered = [...section.matchAll(/href="\/notes\/([^/"]+)\/">([^<]*)<\/a>/g)];
      const titles: string[] = [];
      for (const [, target, title] of rendered) {
        const destination = getEntry(target!);
        assert.ok(destination, `${slug}: the "${name}" section links "${target}", which is not published`);
        // Compared through `asRendered`, because a title carrying `&` reaches
        // the page escaped. Ordering is checked on the artifact's own title, so
        // the escaping cannot move an entry in the sort.
        assert.equal(title, asRendered(destination.title), `${slug}: "${target}" is not linked by its title`);
        titles.push(destination.title);
      }
      if (name === 'related') continue;
      assert.deepEqual(titles, [...titles].sort(), `${slug}: the "${name}" section is not in title order`);
      // An ordering of one is not an ordering, and on a corpus where every list
      // is empty the loop above asserts nothing at all.
      if (titles.length > 1) orderedLists += 1;
    }
  }

  // Vacuity, scaled to the corpus rather than asserted flat: the published
  // artifact is one note with two empty edge arrays, where an empty list is the
  // correct output and there is genuinely nothing to order. Under
  // `pnpm run build:fixture` there is, and it must have been reached.
  if (entries.some((entry) => entry.outgoing.length > 1 || entry.backlinks.length > 1)) {
    assert.ok(orderedLists > 0, 'the corpus has a multi-edge list but none was checked for order');
  }
});

/**
 * The title is rendered once, by the page, and the body's own copy of it is
 * gone.
 *
 * The exporter writes the title into the Markdown as a leading `# Title`, so
 * without the renderer's `pageTitle` handling every note would show its title
 * twice and carry two `h1` elements — the second of which the heading-order
 * gate in `built-output.test.ts` would reject. Both halves are checked here
 * because they are one behaviour: exactly one `h1`, and it is the page's.
 */
test('the note title is rendered once, above the article', () => {
  for (const { slug, html } of notePages()) {
    const entry = getEntry(slug)!;
    const headings = [...html.matchAll(/<h1\b[^>]*>/g)];
    assert.equal(headings.length, 1, `${slug}: has ${headings.length} h1 elements, not 1`);
    assert.match(headings[0]![0], /class="note-title"/, `${slug}: the h1 is not the page title`);

    const article = /<article\b[^>]*>([\s\S]*?)<\/article>/.exec(html);
    assert.ok(article, `${slug}: has no article`);
    assert.doesNotMatch(article[1]!, /<h1\b/, `${slug}: the article body still carries an h1`);
    assert.ok(
      html.includes(`<h1 class="note-title">${asRendered(entry.title)}</h1>`),
      `${slug}: the page title is not the artifact's title`,
    );
  }
});

/**
 * Breadcrumbs are built from public fields only.
 *
 * The trail is `Home / Notes / <collection>? / <title>`, and the last item is
 * the current page and is not a link. What the assertion is really protecting
 * is the requirement that a breadcrumb never reflects a private folder name:
 * every href must be a route the build emitted, which a path fragment could not
 * be.
 */
test('the breadcrumb trail is public routes and the page title, in order', () => {
  for (const { slug, html } of notePages()) {
    const entry = getEntry(slug)!;
    const trail = /<nav class="breadcrumbs"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
    assert.ok(trail, `${slug}: no breadcrumb nav`);

    const items = [...trail[1]!.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, item]) => item!);
    const expectedDepth = entry.collection === undefined ? 3 : 4;
    assert.equal(items.length, expectedDepth, `${slug}: trail is ${items.length} deep, expected ${expectedDepth}`);

    // Everything but the last is a link to a route the build emitted.
    for (const item of items.slice(0, -1)) {
      const href = /href="([^"]*)"/.exec(item)?.[1];
      assert.ok(href, `${slug}: a breadcrumb before the last is not a link: ${item}`);
      const [path] = href.split('#') as [string];
      assert.ok(ROUTES.includes(path), `${slug}: breadcrumb links "${href}", which is not a built route`);
    }

    // The last is the current page: named, not linked.
    const last = items.at(-1)!;
    assert.doesNotMatch(last, /<a\b/, `${slug}: the current page is linked to itself`);
    assert.match(last, /aria-current="page"/, `${slug}: the current page is not marked`);
    assert.ok(last.includes(asRendered(entry.title)), `${slug}: the last crumb is not the title`);

    if (entry.collection !== undefined) {
      assert.ok(
        items[2]!.includes(`href="${collectionRoute(entry.collection)}"`),
        `${slug}: the collection crumb does not link the collection route`,
      );
    }
  }
});

/**
 * The public metadata rendered is exactly what the artifact carries.
 *
 * Both directions, because both are defects: a field present in the artifact
 * and missing from the page loses information the projection approved, and a
 * row rendered for an absent field is fabricated metadata. The published corpus
 * carries none of these, so this is only evidence under `pnpm run build:fixture`
 * — but it runs unconditionally, because "no note has a date" is a correct
 * result for it, not a skip.
 */
test('note metadata renders every field the artifact carries, and no other', () => {
  for (const { slug, html } of notePages()) {
    const entry = getEntry(slug)!;
    const meta = /<dl class="note-meta">([\s\S]*?)<\/dl>/.exec(html)?.[1];

    const expected = [
      ['Published', entry.created],
      ['Updated', entry.updated],
      ['Collection', entry.collection],
    ] as const;
    const carriesAny = expected.some(([, value]) => value !== undefined) || (entry.tags?.length ?? 0) > 0;
    assert.equal(
      meta !== undefined,
      carriesAny,
      `${slug}: metadata block ${meta === undefined ? 'missing' : 'present'} but the entry carries ` +
        `${carriesAny ? 'fields' : 'none'}`,
    );
    if (meta === undefined) continue;

    for (const [label, value] of expected) {
      assert.equal(
        meta.includes(`<dt>${label}</dt>`),
        value !== undefined,
        `${slug}: "${label}" row does not match the artifact`,
      );
    }
    // A date is machine readable as well as human readable.
    for (const value of [entry.created, entry.updated]) {
      if (value === undefined) continue;
      assert.ok(meta.includes(`datetime="${value}"`), `${slug}: date ${value} has no <time datetime>`);
    }
    for (const tag of entry.tags ?? []) {
      assert.ok(
        meta.includes(`href="${tagRoute(routeKey(tag))}"`) && meta.includes(asRendered(tag)),
        `${slug}: tag "${tag}" is not rendered as a link to its facet page`,
      );
    }
  }
});

/**
 * The optional summary renders exactly when the artifact carries a
 * `description`, and carries it verbatim.
 *
 * Verbatim is the assertion that matters. An earlier version suppressed the
 * summary when it matched `excerpt`, on a false premise — the layout receives
 * `excerpt` as the meta description, not `description`, so the two are never
 * the same field and a note whose author wrote one sentence into both simply
 * lost its summary. Without this gate that suppression could return silently.
 */
test('the optional summary renders exactly when the artifact carries one', () => {
  let rendered = 0;
  for (const { slug, html } of notePages()) {
    const entry = getEntry(slug)!;
    const summary = /<p class="note-summary">([\s\S]*?)<\/p>/.exec(html);
    assert.equal(
      summary !== null,
      entry.description !== undefined,
      `${slug}: summary ${summary === null ? 'missing' : 'present'} but description is ` +
        `${entry.description === undefined ? 'absent' : 'present'}`,
    );
    if (summary === null) continue;
    rendered += 1;
    assert.equal(
      summary[1],
      asRendered(entry.description!),
      `${slug}: the rendered summary is not the artifact's description`,
    );
  }

  // Only the fixture corpus carries `description`; on the published one-note
  // artifact the negative case above is the whole check, which is correct
  // rather than vacuous — but say so rather than implying it was exercised.
  if (entries.some((entry) => entry.description !== undefined)) {
    assert.ok(rendered > 0, 'an entry carries a description but no page rendered a summary');
  }
});

/**
 * The table of contents is complete in the HTML, nested, and every entry
 * resolves.
 *
 * "Complete in the HTML" is the load-bearing half: requirements section 5.3
 * makes reading and navigation work without JavaScript, and this is navigation.
 * `built-output.test.ts` separately proves every `href="#x"` on every page has a
 * matching `id`, so a dangling entry fails there; what is proven here is that
 * the list is the renderer's heading tree rather than a subset of it, and that
 * the nesting is real markup rather than a flat list with a depth class.
 */
test('the table of contents is server-rendered, nested, and complete', async () => {
  const { renderMarkdown, TOC_MIN_HEADINGS } = await import('../src/lib/markdown.ts');

  let withToc = 0;
  let nested = 0;
  for (const { slug, html } of notePages()) {
    const entry = getEntry(slug)!;
    const { toc } = await renderMarkdown(entry.markdown, { pageTitle: entry.title });
    const rendered = /<nav class="toc"[\s\S]*?<\/nav>/.exec(html)?.[0];

    if (toc.length === 0) {
      assert.equal(rendered, undefined, `${slug}: renders a table of contents below the threshold`);
      continue;
    }
    withToc += 1;
    assert.ok(rendered, `${slug}: has ${toc.length} root headings but rendered no table of contents`);

    // Collapse is native: a `<details>`, open by default, and no script.
    assert.match(rendered, /<details class="toc-details" open>/, `${slug}: collapse is not a <details>`);

    const flatten = (items: readonly { id: string; children: readonly unknown[] }[]): string[] =>
      items.flatMap((item) => [
        item.id,
        ...flatten(item.children as readonly { id: string; children: readonly unknown[] }[]),
      ]);
    const expected = flatten(toc);
    const listed = [...rendered.matchAll(/href="#([^"]+)"/g)].map(([, id]) => id!);
    assert.deepEqual(listed, expected, `${slug}: the table of contents is not the heading tree, in order`);

    // Real nesting, not a flat list with a depth class: a page with a child
    // heading must emit a list inside a list item.
    if (toc.some((root) => root.children.length > 0)) {
      nested += 1;
      assert.match(
        rendered,
        /<ol class="toc-list">[\s\S]*<li>[\s\S]*<ol class="toc-list">/,
        `${slug}: has nested headings but rendered a flat list`,
      );
    }
  }

  assert.ok(withToc > 0, `no note reached ${TOC_MIN_HEADINGS} headings, so nothing was checked`);
  assert.ok(nested > 0, 'no note had a nested heading, so the nesting was never exercised');
});

/**
 * Owner decision 7, made observable: the syntax-highlighting stylesheet reaches
 * only the pages that contain a code fence.
 *
 * Two independent properties, because the first alone would just restate the
 * renderer to itself:
 *
 * 1. The `<link>` is present exactly when `hasCode` is — the mandated gate.
 * 2. **Every page carrying `token-*` markup links the stylesheet.** This is the
 *    one a reader experiences: unlinked token spans render as undifferentiated
 *    plain text, which is the defect TK-12 fixed and which a gate reading only
 *    the flag would not see. It is not the converse of (1): `hasCode` is true
 *    for *any* fence, and a ` ```text `, an unlabelled, or an unknown-language
 *    fence produces zero tokens, so the two conditions genuinely differ.
 */
test('the code stylesheet is linked only by pages that contain a code fence', async () => {
  const { renderMarkdown } = await import('../src/lib/markdown.ts');

  let gated = 0;
  let highlighted = 0;
  for (const { slug, html } of notePages()) {
    const entry = getEntry(slug)!;
    const { hasCode } = await renderMarkdown(entry.markdown, { pageTitle: entry.title });
    const linked = /<link\b[^>]*href="\/_astro\/code\.[^"]*\.css"/.test(html);
    assert.equal(
      linked,
      hasCode,
      `${slug}: hasCode is ${hasCode} but the code stylesheet is ${linked ? 'linked' : 'absent'}`,
    );

    if (/class="token[ "]/.test(html)) {
      highlighted += 1;
      assert.ok(linked, `${slug}: ships highlighted markup with no stylesheet — it renders as plain text`);
    }
    if (hasCode) gated += 1;
  }

  assert.ok(gated > 0, 'no note contains a code fence, so the gate was never exercised');
  assert.ok(highlighted > 0, 'no note ships highlighted markup, so the reader-facing half proved nothing');
  // The negative direction among *note* pages needs a corpus containing a note
  // with no code, which the published one-note artifact cannot provide — its
  // single note is a shell guide. Demanded only where it is available, rather
  // than asserted weakly everywhere. The seven fixed routes give the negative
  // case on both corpora; that is the test below.
  if (entries.length > 1) {
    assert.ok(
      gated < entries.length,
      'every note in a multi-note corpus contains code, so the negative case was never exercised',
    );
  }
});

test('no page outside the note route links the code stylesheet', () => {
  // The conditional link is emitted from the note page only. A layout-level
  // import would put it on all seven fixed routes, which is the regression this
  // catches.
  for (const route of ROUTES) {
    if (noteSlugFromPath(route) !== undefined) continue;
    const page = pageFor(route);
    assert.doesNotMatch(
      readFileSync(new URL(page, DIST), 'utf8'),
      /href="\/_astro\/code\.[^"]*\.css"/,
      `${page}: links the code stylesheet on a route that renders no code`,
    );
  }
});

// --- Multi-entry surfaces -----------------------------------------------------

/**
 * The corpus this build ran against carries more than one of everything.
 *
 * The assertions below are only evidence on such a corpus: a grid of one card
 * is not a grid, and an ordering of one note is not an ordering. On the
 * published one-note artifact they are skipped with a message naming the
 * command that runs them; under `pnpm run build:fixture` they all run, and every
 * layout claim in this repository is finally falsifiable.
 *
 * Skipping rather than asserting a weaker property is deliberate, and it is a
 * real limitation: on the default `pnpm run build && pnpm test` path these five
 * gates do not execute, so the evidence exists only when someone runs the
 * fixture build. Making them mandatory needs a `verify` script or CI, which is
 * TK-14's. What is avoided in the meantime is the worse option — a gate that
 * passes on one entry and therefore proves nothing while looking green.
 */
const MULTI_ENTRY =
  entries.length > 1 &&
  tagFacets(entries).length > 1 &&
  collectionFacets(entries).length > 1 &&
  entries.some((entry) => entry.backlinks.length > 1);

/**
 * Skip with the reason attached, rather than with Vitest's boolean `skip`
 * option, which would report these five as skipped without saying why. The
 * dynamic form is what carries the message naming the command that runs them —
 * the same message `node --test` printed before the migration.
 */
function requireMultiEntry(context: TestContext): void {
  context.skip(!MULTI_ENTRY, 'corpus has one entry — run `pnpm run build:fixture`');
}

test('the note grid renders one card per entry, with more than one', (context) => {
  requireMultiEntry(context);
  const html = readFileSync(new URL('index.html', DIST), 'utf8');
  const cards = html.match(/<article class="note-card">/g) ?? [];
  assert.equal(cards.length, entries.length, 'the home grid does not carry one card per published note');
  assert.ok(cards.length > 1, 'a grid of one card proves nothing about a grid');
  assert.match(html, /class="note-grid"/, 'the grid container is missing');
  assert.doesNotMatch(html, /class="empty-state"/, 'a populated corpus rendered the empty state');

  for (const entry of entries) {
    assert.ok(
      html.includes(`href="${noteRoute(entry.slug)}"`),
      `the home grid omits "${entry.slug}"`,
    );
  }
});

test('the backlinks aside renders every incoming link, and only those', (context) => {
  requireMultiEntry(context);
  const hub = [...entries].sort((a, b) => b.backlinks.length - a.backlinks.length)[0]!;
  assert.ok(hub.backlinks.length > 1, 'no entry has more than one backlink to check');

  const html = readFileSync(new URL(`notes/${hub.slug}/index.html`, DIST), 'utf8');
  const aside = relationSection(html, 'backlinks');
  assert.ok(aside, `${hub.slug}: has ${hub.backlinks.length} backlinks but rendered no aside`);

  const linked = linkedSlugs(aside);
  assert.deepEqual(
    [...linked].sort(),
    [...hub.backlinks].sort(),
    'the aside is not the exact backlink set',
  );

  // An orphan renders the section with its empty state rather than omitting it:
  // a missing section and an empty one are indistinguishable to a reader who
  // cannot know the site has such a section at all.
  const orphan = entries.find((entry) => entry.backlinks.length === 0);
  assert.ok(orphan, 'the corpus has no orphan to check the empty case against');
  const orphanSection = relationSection(
    readFileSync(new URL(`notes/${orphan.slug}/index.html`, DIST), 'utf8'),
    'backlinks',
  );
  assert.ok(orphanSection, `${orphan.slug}: rendered no backlinks section at all`);
  assert.match(orphanSection, /class="empty-state"/, `${orphan.slug}: has no backlinks and no empty state`);
  assert.doesNotMatch(orphanSection, /href="\/notes\//, `${orphan.slug}: an empty section still links a note`);
});

/**
 * The related-note list on the page is the rule `relations.ts` computes.
 *
 * `tests/relations.test.ts` pins the rule itself against synthetic corpora.
 * What this adds is that the page renders that rule's output rather than some
 * other list — including the ordering, which is where a template that mapped
 * over `entries` instead of over the derivation would look identical until read
 * carefully.
 */
test('the related list is the derivation, in the derivation s order', (context) => {
  requireMultiEntry(context);
  let withSuggestions = 0;

  for (const entry of entries) {
    const html = readFileSync(new URL(`notes/${entry.slug}/index.html`, DIST), 'utf8');
    const section = relationSection(html, 'related')!;
    const rendered = linkedSlugs(section);
    const expected = relatedNotes(entry, entries).map((note) => note.slug);
    assert.deepEqual(rendered, expected, `${entry.slug}: the related list is not the derivation`);
    assert.ok(rendered.length <= RELATED_LIMIT, `${entry.slug}: the related list is unbounded`);

    // The rule's own exclusions, checked against what shipped rather than
    // against the function that produced it.
    const linked = new Set([entry.slug, ...entry.outgoing, ...entry.backlinks]);
    for (const suggested of rendered) {
      assert.ok(!linked.has(suggested), `${entry.slug}: suggests "${suggested}", which is already linked`);
    }
    if (rendered.length > 0) withSuggestions += 1;

    // The derived list states its rule where it has one to state, and states
    // the module's rule rather than some other sentence. The two edge lists
    // must not: an authored edge needs no explanation, and printing one would
    // suggest those were derived too.
    if (rendered.length > 0) {
      assert.ok(
        section.includes(asRendered(RELATED_DERIVATION)),
        `${entry.slug}: the related list does not state the derivation rule`,
      );
    }
    for (const other of ['outgoing', 'backlinks']) {
      assert.doesNotMatch(
        relationSection(html, other)!,
        /class="relations-derivation"/,
        `${entry.slug}: the "${other}" section claims a derivation, but its edges are authored`,
      );
    }
  }

  assert.ok(withSuggestions > 1, 'no note rendered a related list, so this gate checked nothing');
  // And the empty case must be reachable, or "degrades honestly" is untested.
  const untagged = entries.find((entry) => (entry.tags?.length ?? 0) === 0);
  assert.ok(untagged, 'the corpus has no untagged note to check the empty related state against');
  assert.match(
    relationSection(readFileSync(new URL(`notes/${untagged.slug}/index.html`, DIST), 'utf8'), 'related')!,
    /class="empty-state"/,
    `${untagged.slug}: has no tags but rendered related suggestions`,
  );
});

/**
 * The empty related list says which of the two reasons it is empty.
 *
 * There are two, and they are different facts: a note with no tag-sharer
 * anywhere, and a note whose every tag-sharer is already rendered in the two
 * sections above. Telling a reader "nothing shares a tag" in the second case is
 * a claim the artifact contradicts, and the exclusion rule makes it reachable.
 *
 * Neither corpus reaches the second case today — every fixture note either has
 * a suggestion or has no tag at all — so this is *asserted from the model*
 * rather than by finding a note in each state. The first branch is genuinely
 * covered, which is what makes it a gate: swapping the two strings, or reading
 * the wrong field, fails here. The second is pinned so that a future corpus
 * reaching it cannot ship the wrong sentence unnoticed.
 */
test('the empty related state names the right reason', () => {
  const REASONS = {
    linked: 'Every note sharing a tag with this one is already listed above.',
    none: 'No other published note shares a tag with this one.',
  } as const;
  assert.notEqual(REASONS.linked, REASONS.none, 'the two reasons are the same sentence');

  let checkedEmpty = 0;
  for (const { slug, html } of notePages()) {
    if (relatedNotes(getEntry(slug)!, entries).length > 0) continue;
    const section = relationSection(html, 'related')!;
    const expected = hasTagPeer(getEntry(slug)!, entries) ? REASONS.linked : REASONS.none;
    assert.ok(
      section.includes(expected),
      `${slug}: the empty related state does not give the reason the model computes`,
    );
    assert.ok(
      !section.includes(hasTagPeer(getEntry(slug)!, entries) ? REASONS.none : REASONS.linked),
      `${slug}: the empty related state gives both reasons at once`,
    );
    checkedEmpty += 1;
  }
  assert.ok(checkedEmpty > 0, 'no note rendered an empty related state, so no reason was checked');
});

/**
 * The collection pager exists exactly where a sequence does, and walks it in
 * the order the collection index lists.
 *
 * "Where meaningful" is the requirement, so both directions matter: a pager on
 * a note with no collection would be chrome pointing nowhere, and a missing one
 * inside a populated collection would strand the reader.
 */
test('the collection pager appears exactly where there is a sequence', (context) => {
  requireMultiEntry(context);
  let withPager = 0;
  let withoutPager = 0;

  for (const entry of entries) {
    const html = readFileSync(new URL(`notes/${entry.slug}/index.html`, DIST), 'utf8');
    const pager = /<nav class="collection-pager"[\s\S]*?<\/nav>/.exec(html)?.[0];
    const { previous, next } = collectionNeighbours(entry, entries);
    const expected = [previous, next].filter((note) => note !== undefined);

    if (expected.length === 0) {
      assert.equal(pager, undefined, `${entry.slug}: has no collection sequence but rendered a pager`);
      withoutPager += 1;
      continue;
    }

    assert.ok(pager, `${entry.slug}: is inside a collection sequence but rendered no pager`);
    assert.match(pager, /<a\b/, `${entry.slug}: rendered an empty pager, which is a landmark pointing nowhere`);
    assert.deepEqual(
      linkedSlugs(pager),
      expected.map((note) => note.slug),
      `${entry.slug}: the pager does not point at its collection neighbours, in order`,
    );
    // The link carries the destination's title, so it is meaningful out of
    // context — four identical "Previous" links is what a screen reader's link
    // list would otherwise show.
    for (const note of expected) {
      assert.ok(
        pager.includes(`>${asRendered(note.title)}<`),
        `${entry.slug}: the pager omits the title of "${note.slug}"`,
      );
    }
    assert.match(pager, /aria-label="[^"]+"/, `${entry.slug}: the pager nav has no accessible name`);
    withPager += 1;
  }

  assert.ok(withPager > 1, 'no note rendered a pager, so this gate checked nothing');
  assert.ok(withoutPager > 0, 'every note rendered a pager, so the "where meaningful" case is untested');
});

test('every tag and collection page lists exactly its own notes', (context) => {
  requireMultiEntry(context);
  for (const [facets, route] of [
    [tagFacets(entries), tagRoute],
    [collectionFacets(entries), collectionRoute],
  ] as const) {
    assert.ok(facets.length > 1, 'one facet proves nothing about facet pages');

    for (const facet of facets) {
      const html = readFileSync(new URL(`${route(facet.key).slice(1)}index.html`, DIST), 'utf8');
      const listed = [...html.matchAll(/<article class="note-card">[\s\S]*?href="\/notes\/([^/"]+)\//g)].map(
        ([, slug]) => slug!,
      );
      assert.deepEqual(
        listed,
        facet.entries.map((entry) => entry.slug),
        `${route(facet.key)}: does not list exactly its own notes, in order`,
      );
    }

    // At least one facet must be genuinely shared, or "lists its own notes" is
    // satisfied by every page listing everything.
    assert.ok(
      facets.some((facet) => facet.entries.length > 1),
      'no facet groups more than one note',
    );
    assert.ok(
      facets.some((facet) => facet.entries.length < entries.length),
      'every facet contains the whole corpus — grouping is not being exercised',
    );
  }
});

test('/recent/ renders in the model s order, most recently updated first', (context) => {
  requireMultiEntry(context);
  const html = readFileSync(new URL('recent/index.html', DIST), 'utf8');
  const rendered = [...html.matchAll(/<article class="note-card">[\s\S]*?href="\/notes\/([^/"]+)\//g)].map(
    ([, slug]) => slug!,
  );
  const expected = recentFirst(entries).map((entry) => entry.slug);

  assert.deepEqual(rendered, expected, '/recent/ is not in the order the route model computes');
  assert.ok(rendered.length > 1, 'an ordering of one note is not an ordering');

  // The order must be non-alphabetical, or "sorted by date" is indistinguishable
  // from the undated fallback and the assertion above proves nothing.
  assert.notDeepEqual(rendered, [...rendered].sort(), '/recent/ is in slug order, so dates were not applied');

  // Dated notes precede undated ones, and the undated tail is in slug order.
  const undatedAt = expected.findIndex((slug) => noteTimestamp(getEntry(slug)!) === undefined);
  assert.ok(undatedAt > 0, 'the corpus has no dated/undated boundary to check');
  const tail = expected.slice(undatedAt);
  assert.ok(tail.length > 1, 'the undated tail has nothing to order');
  assert.deepEqual(tail, [...tail].sort(), 'undated notes are not in slug order');
  for (const slug of expected.slice(0, undatedAt)) {
    assert.notEqual(noteTimestamp(getEntry(slug)!), undefined, 'an undated note sorted above a dated one');
  }
});

test('both document languages reach the built pages', (context) => {
  requireMultiEntry(context);
  // The artifact carries `language` per document and the layout threads it, so
  // a mixed corpus must produce more than one `<html lang>` across the site.
  const langs = new Set(
    entries.map((entry) => {
      const html = readFileSync(new URL(`notes/${entry.slug}/index.html`, DIST), 'utf8');
      return /<html[^>]*\slang="([^"]+)"/.exec(html)?.[1];
    }),
  );
  assert.ok(langs.size > 1, `every note page declared the same language: ${[...langs].join(', ')}`);
  for (const entry of entries) {
    if (entry.language === undefined) continue;
    const html = readFileSync(new URL(`notes/${entry.slug}/index.html`, DIST), 'utf8');
    assert.match(
      html,
      new RegExp(`<html[^>]*\\slang="${entry.language}"`),
      `${entry.slug}: does not declare its own language`,
    );
  }
});

/* ----------------------------------------------------------- explorer -- */

/** The rail's markup on a built page, or nothing where it does not render. */
function explorer(html: string): string | undefined {
  return /<nav class="explorer"[\s\S]*?<\/nav>/.exec(html)?.[0];
}

/** Every note route the rail links, in document order. */
function explorerSlugs(rail: string): string[] {
  return [...rail.matchAll(/<li><a href="\/notes\/([^/"]+)\//g)].map(([, slug]) => slug!);
}

/**
 * The rail is complete in the server-rendered HTML, on every route.
 *
 * This is the property Quartz's explorer does not have: its trie is rebuilt in
 * the browser from `contentIndex.json`, so with JavaScript disabled the whole
 * navigation is an empty `<ul>`. Asserted against the artifact rather than
 * against a count, because "found nothing" and "could not look" report the same
 * cardinality — a rail listing thirty-one of thirty-two notes has the right
 * order of magnitude and one note nobody can reach.
 *
 * Every built route, not one: the rail is layout chrome, so a page that lost it
 * would be a page where the site's navigation silently ends.
 */
test('the explorer lists every published note, on every route', (context) => {
  requireMultiEntry(context);
  const expected = entries.map((entry) => entry.slug).sort();

  for (const route of ROUTES) {
    const page = pageFor(route);
    const rail = explorer(readFileSync(new URL(page, DIST), 'utf8'));
    assert.ok(rail, `${route}: renders no collection explorer`);
    assert.deepEqual(
      explorerSlugs(rail).sort(),
      expected,
      `${route}: the explorer is not the published corpus`,
    );
  }
});

/**
 * The rail's groups are the collection facets, plus the uncollected notes.
 *
 * Built from `collectionFacets` and the artifact — deliberately *not* from
 * `collectionNavigation`, which is the model that rendered the page. See the
 * comment in the body: a page compared against its own model proves only
 * faithful transcription, not correct grouping.
 */
test('the explorer groups match the collection model, in its order', (context) => {
  requireMultiEntry(context);
  const html = readFileSync(new URL('index.html', DIST), 'utf8');
  const rail = explorer(html)!;

  const rendered = [...rail.matchAll(/<span class="explorer-label">([^<]*)<\/span>/g)].map(
    ([, label]) => label!,
  );
  const counts = [...rail.matchAll(/<span class="explorer-count">(\d+)<\/span>/g)].map(([, n]) =>
    Number(n),
  );

  // Against the artifact and `collectionFacets`, not against
  // `collectionNavigation`. Comparing the page to the model that rendered it
  // proves only that the component transcribed the model faithfully — a wrong
  // grouping would be transcribed just as faithfully, and both this gate and
  // the model's own unit test would stay green. The independent expectation is
  // the collection index's own facet list, in its own order, plus one final
  // group for the notes that carry no collection.
  const facets = collectionFacets(entries);
  const uncollected = entries.filter((entry) => entry.collection === undefined);
  const expectedLabels = facets.map((facet) => asRendered(facet.label));
  const expectedCounts = facets.map((facet) => facet.entries.length);
  if (uncollected.length > 0) {
    expectedLabels.push(asRendered(UNCOLLECTED_LABEL));
    expectedCounts.push(uncollected.length);
  }

  assert.deepEqual(rendered, expectedLabels, 'the rail is not the collection index, in its order');
  // Each count is the group's own size, derived from the artifact rather than
  // from the number the page happens to print.
  assert.deepEqual(counts, expectedCounts, 'a group count is not the number of notes in it');
  // And every note is accounted for, so a group cannot be right while the whole
  // is missing one.
  assert.equal(
    expectedCounts.reduce((total, count) => total + count, 0),
    entries.length,
    'the rail’s groups do not cover the corpus exactly once',
  );
});

/**
 * Collapse is native, and the reader's own group is the open one.
 *
 * Two halves, and the second is the one a reader experiences: a rail whose
 * groups all start closed makes a reader open a disclosure to find where they
 * already are, and a rail with every group open is a wall of every title on the
 * site. Exactly one `<details open>`, and it is the group holding the page.
 */
test('the explorer opens exactly the group holding the page being read', (context) => {
  requireMultiEntry(context);

  let checkedCollected = 0;
  let checkedUncollected = 0;
  for (const entry of entries) {
    const html = readFileSync(new URL(`notes/${entry.slug}/index.html`, DIST), 'utf8');
    const rail = explorer(html)!;

    // Native `<details>`, so the collapse costs no JavaScript at all.
    assert.match(rail, /<details class="explorer-group"/, `${entry.slug}: the collapse is not a <details>`);

    const groups = [...rail.matchAll(/<details class="explorer-group"( open)?>([\s\S]*?)<\/details>/g)];
    const open = groups.filter(([, isOpen]) => isOpen !== undefined);
    assert.equal(open.length, 1, `${entry.slug}: ${open.length} groups are open, expected exactly one`);
    assert.ok(
      explorerSlugs(open[0]![2]!).includes(entry.slug),
      `${entry.slug}: the open group does not contain the page being read`,
    );

    if (entry.collection === undefined) checkedUncollected += 1;
    else checkedCollected += 1;
  }

  assert.ok(checkedCollected > 0, 'no note in a collection was checked');
  assert.ok(
    checkedUncollected > 0,
    'no note outside a collection was checked, so the uncollected group was never the open one',
  );
});

/**
 * The page being read is marked in the rail, and marked once.
 *
 * `aria-current="page"` is what a screen reader announces; the stylesheet adds
 * a weight and a rule so the mark is not carried by colour alone. Zero marks
 * strands a reader with no sense of place, and two is a lie about where they
 * are.
 */
test('the explorer marks the current note, and only it', (context) => {
  requireMultiEntry(context);
  for (const entry of entries) {
    const rail = explorer(readFileSync(new URL(`notes/${entry.slug}/index.html`, DIST), 'utf8'))!;
    const marked = [...rail.matchAll(/href="\/notes\/([^/"]+)\/" aria-current="page"/g)].map(
      ([, slug]) => slug!,
    );
    assert.deepEqual(marked, [entry.slug], `${entry.slug}: the rail marks the wrong note, or none`);
  }

  // And a route that is not a note marks nothing: a collection index is not one
  // of its own notes.
  for (const facet of collectionFacets(entries)) {
    const rail = explorer(readFileSync(new URL(`collections/${facet.key}/index.html`, DIST), 'utf8'))!;
    assert.doesNotMatch(rail, /aria-current="page"/, `/collections/${facet.key}/: marks a note as current`);
  }
});

/**
 * The rail is not indexed as page content.
 *
 * It renders on every page, so without `data-pagefind-ignore` every note's
 * search record would carry the title of every other note — the same defect
 * TK-12 fixed for the back link and the heading anchors, at the largest
 * possible scale. Both halves are asserted: the attribute is on the element,
 * and a title from another collection does not appear in this page's indexed
 * body.
 */
test('the explorer is excluded from the search index', (context) => {
  requireMultiEntry(context);
  const html = readFileSync(new URL(`notes/${entries[0]!.slug}/index.html`, DIST), 'utf8');
  assert.match(
    explorer(html)!,
    /<nav class="explorer"[^>]*\sdata-pagefind-ignore/,
    'the explorer is indexed as page content',
  );

  // The article body must not contain the rail: `data-pagefind-body` is on the
  // article, so a rail rendered inside it would be indexed whatever the
  // attribute said.
  const body = /<article class="prose" data-pagefind-body>[\s\S]*?<\/article>/.exec(html)?.[0];
  assert.ok(body, 'the note page has no indexed article body');
  assert.doesNotMatch(body, /class="explorer/, 'the explorer renders inside the indexed article body');
});

/**
 * A corpus too small to browse renders no rail at all.
 *
 * The published artifact is one note: a disclosure whose only content is the
 * page already open is chrome describing nothing, and the footer site map
 * already reaches every fixed route. Asserted on the corpus that has it —
 * the fixture corpus proves the opposite direction above, so both are covered
 * across the two builds rather than only the convenient one.
 */
test('a corpus with nothing to browse renders no explorer', (context) => {
  context.skip(entries.length > 1, 'corpus has more than one note — this is the published-corpus case');
  for (const route of ROUTES) {
    const page = pageFor(route);
    assert.equal(
      explorer(readFileSync(new URL(page, DIST), 'utf8')),
      undefined,
      `${route}: renders an explorer for a corpus with one note`,
    );
  }
});

/**
 * The rail costs no JavaScript, measured in the shipped bundle.
 *
 * The whole design rests on this: `<details>` for collapse, `position: sticky`
 * for the follow, `aria-current` for the location. A script added later to
 * "improve" any of the three would be invisible to every other gate in this
 * file, since the markup would be unchanged.
 *
 * **Filename matching is not enough, and that is the whole reason this reads the
 * bundle.** Astro concatenates the layout's `<script>` imports into one chunk
 * named after `Layout.astro`, so an `import '../scripts/explorer.ts'` added to
 * that existing block ships inside a file whose name says nothing about it — the
 * exact path a name check would wave through. What is asserted instead is the
 * property a reader pays for: no shipped script mentions the rail's markup, and
 * the total JavaScript on the page has not grown a rail's worth. The byte
 * ceiling is deliberately loose, because it is guarding against a *feature*
 * appearing, not policing the existing scripts' size — TK-09 owns budgets.
 */
test('no script is loaded for the explorer', () => {
  /** Selectors and identifiers a rail script would have to name to do anything. */
  const RAIL_MARKERS = /explorer|collection-navigation|details\[open\]|explorer-group/i;
  /** Total shipped JavaScript, over which a rail script would be a visible jump. */
  const SCRIPT_BUDGET_BYTES = 40_000;

  let inspected = 0;
  for (const route of ROUTES) {
    const page = pageFor(route);
    const html = readFileSync(new URL(page, DIST), 'utf8');
    let bytes = 0;

    for (const [, source] of html.matchAll(/<script\b[^>]*\ssrc="([^"]*)"/gi)) {
      const file = new URL(source!.slice(1), DIST);
      if (!exists(file)) continue;
      const code = readFileSync(file, 'utf8');
      bytes += code.length;
      inspected += 1;
      // The bundle's *contents*, not its name: this is what catches a rail
      // script hidden inside the layout's existing chunk.
      assert.doesNotMatch(
        code,
        RAIL_MARKERS,
        `${route}: the shipped script "${source}" references the explorer — ` +
          'the rail is meant to need no JavaScript at all',
      );
    }

    assert.ok(
      bytes <= SCRIPT_BUDGET_BYTES,
      `${route}: ships ${bytes} B of JavaScript, over the ${SCRIPT_BUDGET_BYTES} B ceiling`,
    );
  }

  // Non-vacuity: some script was read and scanned, so a build that emitted none
  // cannot pass this by having nothing to inspect.
  assert.ok(inspected > 0, 'no shipped script was read, so this gate inspected nothing');
});
