/**
 * `/rss.xml` — the Atom feed of every published note.
 *
 * An Astro endpoint rather than a build script, so the feed is part of the route
 * model and `Astro.site` reaches it the same way it reaches every page. The
 * `.xml.ts` name is what makes the emitted file `rss.xml`.
 *
 * `rss.xml` rather than `atom.xml` although the document is Atom 1.0: `rss` is
 * the reserved route segment TK-01 already set aside, `/rss.xml` is the path
 * readers and feed autodiscovery tools try first, and the `type` attribute on
 * the discovery link states the actual format. The filename is an address, not
 * a format declaration.
 *
 * The whole document, and the reasoning behind Atom over RSS 2.0, is in
 * `src/lib/site.ts`.
 */

import type { APIRoute } from 'astro';
import { entries } from '../lib/content.ts';
import { renderFeed } from '../lib/site.ts';

export const GET: APIRoute = ({ site }) =>
  new Response(renderFeed(site, entries), {
    headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' },
  });
