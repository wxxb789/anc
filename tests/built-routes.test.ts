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

import { entries } from '../src/lib/content.ts';
import { SCHEMA_VERSION } from '../src/lib/schema.ts';
import {
  FIXED_ROUTES,
  REDIRECT_RULES,
  SITE_MAP,
  collectionFacets,
  collectionRoute,
  noteRoute,
  noteSlugFromPath,
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

test('the emitted redirect map matches the route model exactly', () => {
  const file = new URL('_redirects', DIST);
  assert.ok(exists(file), 'dist/_redirects is missing — the build step did not run');

  // The version stamp is recomputed from the artifact bytes rather than read
  // out of the file, so a map generated from a different artifact than the one
  // `dist/` was built from fails here instead of shipping.
  //
  // Deliberately hashed here rather than through `contentVersion()`, which the
  // two scripts share: a gate that computes the expected value with the same
  // function the subject used cannot see that function go wrong. This is the
  // one place a second, independent implementation earns its keep.
  const source = readFileSync(new URL('../src/data/content.json', import.meta.url), 'utf8');
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
        assert.ok(html.includes(facet.label), `/${route}/ omits the facet "${facet.label}"`);
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
