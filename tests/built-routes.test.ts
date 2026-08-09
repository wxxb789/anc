/**
 * Assertions over the routes the build actually emitted.
 *
 * The route model's own logic is tested against synthetic fixtures in
 * `tests/route-model.test.ts`. What is checked here is that `dist/` contains
 * exactly the routes the model predicts from the real artifact, that no
 * in-content link points at a route that does not exist, and that the emitted
 * redirect map matches the artifact rather than a stale committed copy.
 *
 * Run `npm run build` before `npm test`; the suite fails loudly rather than
 * skipping when `dist/` is absent.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import { entries, getEntry } from '../src/lib/content.ts';
import { readArtifact } from '../src/lib/artifact-source.ts';
import { SCHEMA_VERSION } from '../src/lib/schema.ts';
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
  if (!exists(DIST)) assert.fail('dist/ is missing — run `npm run build` before `npm test`');
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
    const page = route.endsWith('.html') ? route.slice(1) : `${route.slice(1)}index.html`;
    const html = readFileSync(new URL(page, DIST), 'utf8');
    for (const [pattern, what] of forbidden) {
      assert.doesNotMatch(html, pattern, `${page}: discloses ${what} (${pattern})`);
    }
  }
});

// --- Multi-entry surfaces -----------------------------------------------------

/**
 * The corpus this build ran against carries more than one of everything.
 *
 * The assertions below are only evidence on such a corpus: a grid of one card
 * is not a grid, and an ordering of one note is not an ordering. On the
 * published one-note artifact they are skipped with a message naming the
 * command that runs them; under `npm run build:fixture` they all run, and every
 * layout claim in this repository is finally falsifiable.
 *
 * Skipping rather than asserting a weaker property is deliberate, and it is a
 * real limitation: on the default `npm run build && npm test` path these five
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

const multiEntry = { skip: MULTI_ENTRY ? false : 'corpus has one entry — run `npm run build:fixture`' };

test('the note grid renders one card per entry, with more than one', multiEntry, () => {
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

test('the backlinks aside renders every incoming link, and only those', multiEntry, () => {
  const hub = [...entries].sort((a, b) => b.backlinks.length - a.backlinks.length)[0]!;
  assert.ok(hub.backlinks.length > 1, 'no entry has more than one backlink to check');

  const html = readFileSync(new URL(`notes/${hub.slug}/index.html`, DIST), 'utf8');
  const aside = /<aside class="backlinks"[\s\S]*?<\/aside>/.exec(html);
  assert.ok(aside, `${hub.slug}: has ${hub.backlinks.length} backlinks but rendered no aside`);

  const linked = [...aside[0].matchAll(/href="\/notes\/([^/"]+)\//g)].map(([, slug]) => slug!);
  assert.deepEqual(
    [...linked].sort(),
    [...hub.backlinks].sort(),
    'the aside is not the exact backlink set',
  );

  // An orphan must render no aside at all rather than an empty heading.
  const orphan = entries.find((entry) => entry.backlinks.length === 0);
  assert.ok(orphan, 'the corpus has no orphan to check the empty case against');
  assert.doesNotMatch(
    readFileSync(new URL(`notes/${orphan.slug}/index.html`, DIST), 'utf8'),
    /<aside class="backlinks"/,
    `${orphan.slug}: has no backlinks but rendered the aside anyway`,
  );
});

test('every tag and collection page lists exactly its own notes', multiEntry, () => {
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

test('/recent/ renders in the model s order, most recently updated first', multiEntry, () => {
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

test('both document languages reach the built pages', multiEntry, () => {
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
