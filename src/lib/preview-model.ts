/**
 * The pure half of the hover preview: what may be shown, and where it goes.
 *
 * Split out of `src/scripts/link-preview.ts` for one reason — the placement
 * arithmetic is the part most likely to be subtly wrong, and a browser test can
 * only prove it for the link positions a corpus happens to contain. Nothing
 * here touches the DOM, so every edge, every flip, and every malformed payload
 * is reachable from a unit test at `tests/preview-model.test.ts`.
 *
 * This module is imported into the browser bundle, so it keeps the same
 * discipline as `route-path.ts`: no artifact import, no site map, nothing a
 * reader would download and never use.
 */

/** A published note as the public preview payload describes it. */
export interface PreviewEntry {
  title: string;
  excerpt: string;
}

/**
 * The preview payload, keyed by slug.
 *
 * A `Map` rather than an object, and that is not a style choice: the keys come
 * from a fetched document, and an object would let a `__proto__` key reach
 * `Object.prototype`. A `Map` has no such key.
 */
export type PreviewIndex = ReadonlyMap<string, PreviewEntry>;

/** Between the link and the panel, and between the panel and the viewport edge. */
export const PREVIEW_GAP_PX = 8;
export const VIEWPORT_MARGIN_PX = 8;

/**
 * How much of a `#heading` fragment the panel will show.
 *
 * A fragment is a heading slug this pipeline generated, so it is already short;
 * the bound exists because nothing in the artifact contract constrains it and an
 * unbounded string in a fixed-width panel is a layout defect waiting for one
 * long heading.
 */
export const FRAGMENT_LIMIT = 80;

/**
 * The section a `/notes/<slug>/#heading` link points at, as the panel shows it.
 *
 * Shown **verbatim**, decoded and bounded, rather than turned back into prose.
 * The payload carries a note's title and excerpt and nothing per-heading, so the
 * heading's real text is not available here; de-slugging `reading-a-build-log`
 * into something title-like would be a guess rendered in the shape of a fact.
 * The fragment is what the address bar will show on arrival, so it is the one
 * thing that is certainly true about the target.
 *
 * `decodeURIComponent` throws on a malformed escape, which a hand-written href
 * can contain. That is a "fail silently" case, not a broken preview: the raw
 * fragment is still an honest label.
 */
export function previewFragment(hash: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') return undefined;
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    text = raw;
  }
  return `#${text.length > FRAGMENT_LIMIT ? `${text.slice(0, FRAGMENT_LIMIT)}…` : text}`;
}

/** The part of a rectangle placement needs. Matches `DOMRect`'s field names. */
export interface PreviewAnchor {
  left: number;
  top: number;
  bottom: number;
}

export interface PreviewSize {
  width: number;
  height: number;
}

export interface PreviewPlacement {
  left: number;
  top: number;
}

/**
 * Read the fetched payload, keeping only entries that carry the public preview
 * fields as strings.
 *
 * Every failure is silent by construction: a payload that is not an object, an
 * `entries` that is not an array, and an entry missing a field all end as a
 * lookup that finds nothing, which the caller already handles as "no preview".
 *
 * The slug is not validated here. The only slugs ever looked up come from
 * `noteSlugFromPath`, which enforces the shape `schema.ts` enforces, so an
 * entry whose slug is malformed is simply never asked for. Checking it twice
 * would put a second copy of the slug grammar in the browser bundle.
 */
export function readPreviewIndex(payload: unknown): PreviewIndex {
  const index = new Map<string, PreviewEntry>();
  if (typeof payload !== 'object' || payload === null) return index;
  const { entries } = payload as { entries?: unknown };
  if (!Array.isArray(entries)) return index;

  for (const candidate of entries as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { slug, title, excerpt } = candidate as Record<string, unknown>;
    if (typeof slug !== 'string' || typeof title !== 'string' || typeof excerpt !== 'string') continue;
    index.set(slug, { title, excerpt });
  }
  return index;
}

/**
 * Keep a coordinate inside its bounds, with the low edge winning a tie.
 *
 * `lowest` is applied last deliberately. When the panel is larger than the
 * space available, `highest` falls below `lowest` and one of the two edges has
 * to be given up; giving up the far edge keeps the panel's top-left corner —
 * where the title is, and where reading starts — on screen.
 */
function clamp(desired: number, lowest: number, highest: number): number {
  return Math.max(lowest, Math.min(desired, highest));
}

/**
 * Where the panel goes, in viewport coordinates, for a link at `anchor`.
 *
 * Below the link by default, flipped above it when the panel does not fit below
 * *and* there is more room above — the second condition matters, because a link
 * near the top of a tall page has no room either way and flipping it there
 * would trade a clipped bottom for a clipped top. Both coordinates are then
 * clamped, so all four viewport edges hold whatever the link's position and the
 * panel's size turn out to be.
 *
 * Viewport coordinates because the panel is `position: fixed`; that is the same
 * space `getBoundingClientRect` reports in, so no scroll offset enters the
 * arithmetic and there is nothing to keep in sync while the page scrolls.
 */
export function placePreview(
  anchor: PreviewAnchor,
  panel: PreviewSize,
  viewport: PreviewSize,
): PreviewPlacement {
  const roomBelow = viewport.height - VIEWPORT_MARGIN_PX - (anchor.bottom + PREVIEW_GAP_PX);
  const roomAbove = anchor.top - PREVIEW_GAP_PX - VIEWPORT_MARGIN_PX;
  const isAbove = panel.height > roomBelow && roomAbove > roomBelow;

  return {
    left: clamp(
      anchor.left,
      VIEWPORT_MARGIN_PX,
      viewport.width - VIEWPORT_MARGIN_PX - panel.width,
    ),
    top: clamp(
      isAbove ? anchor.top - PREVIEW_GAP_PX - panel.height : anchor.bottom + PREVIEW_GAP_PX,
      VIEWPORT_MARGIN_PX,
      viewport.height - VIEWPORT_MARGIN_PX - panel.height,
    ),
  };
}
