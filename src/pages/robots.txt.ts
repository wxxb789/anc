/**
 * `/robots.txt` — the indexing policy, and where the sitemap is.
 *
 * Generated rather than the committed `public/robots.txt` it replaces. The
 * `Sitemap:` directive takes an absolute URL, so a static file would be a second
 * place this site's origin is written down — and the origin is a placeholder
 * until a domain is assigned, which makes "written once" the difference between
 * a one-line change and a search-and-replace across the tree.
 *
 * The policy itself is in `renderRobots`.
 */

import type { APIRoute } from 'astro';
import { renderRobots } from '../lib/site.ts';

export const GET: APIRoute = ({ site }) =>
  new Response(renderRobots(site), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
