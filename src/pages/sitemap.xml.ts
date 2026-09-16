/**
 * `/sitemap.xml` — every public route, for crawlers.
 *
 * Hand-emitted rather than `@astrojs/sitemap`, and that is a correctness
 * decision rather than a dependency-count one. The integration enumerates what
 * Astro emitted, which would include `/404.html` and this file's siblings and
 * would need a filter to exclude them; and it has no access to the artifact, so
 * `<lastmod>` would either be absent or be the build clock — the second of which
 * breaks the determinism this ticket is measured on. Reading the artifact
 * directly gives the right URL set and a real modification date, in the same
 * thirty lines.
 *
 * `tests/metadata.test.ts` proves the route set here is exactly the set the
 * build wrote to `dist/`, so this cannot drift from what is actually served.
 */

import type { APIRoute } from 'astro';
import { entries, tagFacets } from '../lib/content.ts';
import { publicRoutes, renderSitemap } from '../lib/site.ts';

export const GET: APIRoute = ({ site }) =>
  new Response(renderSitemap(site, publicRoutes(entries, tagFacets())), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
