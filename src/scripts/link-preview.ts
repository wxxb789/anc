/**
 * Hover link preview.
 *
 * TK-07 OWNS THIS FILE'S BEHAVIOUR. It was moved verbatim out of the inline
 * `<script>` in `Layout.astro` so the built HTML satisfies `script-src 'self'`
 * with no inline script. Nothing about how the preview works was redesigned
 * here, including its gaps.
 *
 * Known gaps TK-07 must close (requirements section 14 and ticket TK-07):
 * trigger on keyboard focus as well as hover, add an open delay with
 * cancellation, clamp to all four viewport edges and flip above the link when
 * there is no room below, dismiss on Escape/scroll/resize, support
 * heading-target previews, and fail silently on a fetch error, a malformed
 * payload, or an unknown slug.
 */

/* Astro concatenates these scripts into one bundle. `export {}` makes this file
   a module with its own top-level scope, so TK-06 and TK-07 can each declare
   `root`, `dialog`, or `preview` without colliding with the other's file. */
export {};

const preview = document.querySelector<HTMLElement>('#link-preview');
type PreviewIndex = { entries: { slug: string; title: string; excerpt: string }[] };
let indexPromise: Promise<PreviewIndex> | undefined;
const loadIndex = (): Promise<PreviewIndex> =>
  (indexPromise ||= fetch('/content-index.json').then(
    (response) => response.json() as Promise<PreviewIndex>,
  ));

document.addEventListener('pointerover', async (event) => {
  const link = (event.target as Element | null)?.closest('a[href^="/"]');
  if (!(link instanceof HTMLAnchorElement) || !preview || link.classList.contains('brand')) return;
  const slug = link.pathname.split('/').filter(Boolean)[0];
  const data = await loadIndex();
  const item = data.entries.find((entry) => entry.slug === slug);
  if (!item) return;
  const title = document.createElement('strong');
  const excerpt = document.createElement('p');
  title.textContent = item.title;
  excerpt.textContent = item.excerpt;
  preview.replaceChildren(title, excerpt);
  preview.hidden = false;
  const rect = link.getBoundingClientRect();
  preview.style.left = `${Math.min(rect.left, window.innerWidth - 360)}px`;
  preview.style.top = `${rect.bottom + 8}px`;
});

document.addEventListener('pointerout', (event) => {
  if ((event.target as Element | null)?.closest('a[href^="/"]') && preview) preview.hidden = true;
});
