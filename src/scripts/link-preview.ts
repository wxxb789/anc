/**
 * Hover and focus link previews.
 *
 * A preview is a **projection lookup, not a page fetch**. The slug in the link's
 * path is looked up in the page's bound SQLite snapshot through the shared lazy
 * Worker, which returns the note's title, excerpt, author-ordered aliases, and
 * effective language. A link whose target is not in the snapshot previews
 * nothing, and there is no code path that could read anything else: no page is
 * fetched, no markup is parsed, and no field outside the snapshot's
 * `nodes`/`aliases` rows exists to show. That is the
 * property worth keeping — a scrape-the-target design previews whatever the
 * anchor happens to point at, which on a privacy projection is a hole rather
 * than an inconsistency.
 *
 * Everything the panel shows is already on the page it links to and in the
 * public snapshot, so a preview adds speed and never information (requirements
 * section 14: it never replaces the underlying link). A reader with no pointer,
 * no scripting, or no interest loses nothing.
 *
 * The placement arithmetic and the payload reader live in `preview-model.ts` so
 * they can be tested without a browser; this file is the event wiring.
 *
 * No motion, by construction: the panel appears and disappears with no
 * transition and no animation, so a reduced-motion reader has nothing to opt out
 * of. The global `@media (prefers-reduced-motion: reduce)` block in `global.css`
 * covers anything a later change adds.
 */

import { noteSlugFromPath } from '../lib/route-path.ts';
import { placePreview, previewFragment, previewTitle } from '../lib/preview-model.ts';
import type { NotePreview } from '../lib/snapshot-queries.ts';
import { requestPreview } from './snapshot-client.ts';

/**
 * Hover intent. Long enough that crossing a link on the way somewhere else costs
 * nothing, short enough that a reader who paused is not kept waiting.
 */
const OPEN_DELAY_MS = 120;

/**
 * The grace period between leaving the link and the panel closing.
 *
 * WCAG 2.2 SC 1.4.13 requires hover-triggered content to be *hoverable* — the
 * pointer must be able to reach it, which means crossing the gap between the
 * link and the panel without it vanishing. It applies only once the panel is
 * visible; before that, leaving cancels outright, which is what the ticket asks
 * for and what stops a panel appearing for a link the reader already left.
 */
const CLOSE_DELAY_MS = 160;

const panel = document.querySelector<HTMLElement>('#link-preview');
if (panel) install(panel);

/** A link that has passed every previewable check, with the slug that proved it. */
interface PreviewLink {
  link: HTMLAnchorElement;
  slug: string;
}

/** The panel and its pending/showing state, shared by the event handlers. */
interface PreviewState {
  panel: HTMLElement;
  /** The link whose preview is showing or scheduled. Unset means nothing is pending. */
  current: HTMLAnchorElement | undefined;
  openTimer: ReturnType<typeof setTimeout> | undefined;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The previewable note behind a link, or nothing.
 *
 * The origin comparison, rather than an `href^="/"` selector, is what makes
 * "same site" true instead of merely likely: `href="//example.com/notes/x/"`
 * starts with `/` and has a perfectly good-looking note `pathname`, so a prefix
 * test would hand a third-party origin a preview of one of *our* notes.
 * Asking for `.origin` puts the question to the browser's own URL parser, and
 * it also admits an absolute same-origin href, which is public and previewable
 * and which the prefix selector silently excluded.
 *
 * A link to the page already open is **not** previewable, and that guard is
 * load-bearing rather than tidy. Every `href="#section"` on a note page
 * resolves to that note's own `pathname`, so without it the table of contents,
 * all fifteen heading anchors, and — worst — the skip link all preview the note
 * the reader is currently reading. On the published note page that is 29 such
 * anchors, and the *first* Tab on the page opened a panel describing the page
 * itself and pointed the skip link's `aria-describedby` at it. A preview of the
 * open page is not information, it is noise in front of the one control a
 * keyboard reader meets first. `tests/rendered-page.test.ts` gates it over the
 * real anchors on real note pages — counted there rather than trusted from
 * here, and it fails when this line is deleted.
 *
 * The slug comes back with the link rather than being re-derived at display
 * time. One call to `noteSlugFromPath` is what makes this the single decision
 * about whether a link is previewable — a second copy downstream would make
 * each of them look optional, and a check nothing depends on is a check that
 * gets deleted.
 */
function previewTarget(node: EventTarget | null): PreviewLink | undefined {
  const link = node instanceof Element ? node.closest('a[href]') : undefined;
  if (!(link instanceof HTMLAnchorElement) || link.origin !== location.origin) return undefined;
  if (link.pathname === location.pathname) return undefined;
  // A link inside a `<dialog>` — the modal search dialog — is never previewed.
  // The panel lives behind the modal, so a preview would be covered by it,
  // `aria-describedby` would point at an element outside the reader's reach,
  // and arrowing through results would download the whole SQLite runtime for
  // nothing. `tests/preview-intent.test.ts` gates both effects.
  if (link.closest('dialog') !== null) return undefined;
  // Only a note route carries a previewable slug. Reading the route through the
  // shared helper is what keeps this from previewing `/tags/<tag>/` as though
  // the tag were a note, and it means the route model moves in one place.
  const slug = noteSlugFromPath(link.pathname);
  return slug === undefined ? undefined : { link, slug };
}

function hide(state: PreviewState): void {
  clearTimeout(state.openTimer);
  clearTimeout(state.closeTimer);
  state.openTimer = undefined;
  state.closeTimer = undefined;
  // Only while the panel is showing. A description pointing at a hidden element
  // announces nothing, so leaving the attribute behind would tell a screen
  // reader the link has a description that is not there.
  state.current?.removeAttribute('aria-describedby');
  state.current = undefined;
  state.panel.hidden = true;
}

/** Whether an event's target or `relatedTarget` is the panel or inside it. */
function isInPanel(panel: HTMLElement, node: EventTarget | null): boolean {
  return node instanceof Node && panel.contains(node);
}

/** The pointer came back to the link, or reached the panel. */
function keep(state: PreviewState): void {
  clearTimeout(state.closeTimer);
  state.closeTimer = undefined;
}

/**
 * The pointer left. A visible panel gets the grace period; a pending one does
 * not, so a reader who brushes past a link never sees it open at all.
 */
function leave(state: PreviewState): void {
  if (state.current === undefined) return;
  if (state.panel.hidden) hide(state);
  else if (state.closeTimer === undefined) state.closeTimer = setTimeout(() => hide(state), CLOSE_DELAY_MS);
}

/**
 * Fill and place the panel for a previewable link, if it is still the one
 * wanted.
 *
 * The re-check after the await is the reason this is not written inline: the
 * index fetch can resolve long after the pointer has moved on, and without it a
 * reader who brushed past a link gets a panel for it seconds later, anchored to
 * a rectangle that may have scrolled away in the meantime.
 */
async function show(state: PreviewState, { link, slug }: PreviewLink): Promise<void> {
  let entry;
  try {
    entry = (await requestPreview(slug)).preview;
  } catch {
    // A failed Worker, fetch, digest, or schema falls back to the static page:
    // the link stays usable and nothing stale is shown. The client clears its
    // failed initialization so a later intent can retry.
    entry = null;
  }
  if (state.current !== link) return;
  if (entry === null) {
    // Nothing to show: a failed index load, or a slug the projection does not
    // carry. `current` is released because it means "the link whose preview is
    // showing or scheduled", and after a miss neither is true. Leaving it set
    // makes the next `pointerover` on that same link take the "already here"
    // branch instead of retrying, and the preview never comes back.
    //
    // The gesture that reaches it is **moving between a link's own child
    // elements**. `pointerout` is correctly swallowed — the pointer has not
    // left the link — but crossing the internal boundary fires a fresh
    // `pointerover` for the same anchor, and that is the one this releases for.
    // An earlier version of this comment claimed no such gesture existed; it
    // was wrong, and the mistake was testing jitter *within* one element, which
    // fires no events at all. Reproduced on `/notes/accessibility-baseline/`
    // moving between the collection pager's two spans: without this line the
    // preview stays dead, with it the crossing re-arms.
    //
    // Not hypothetical markup: the collection pager in
    // `src/pages/notes/[slug].astro` wraps `<span class="pager-direction">`
    // and `<span class="pager-title">` in every anchor, and the fixture corpus
    // builds **50** of them. `tests/rendered-page.test.ts` gates it on those
    // real anchors.
    state.current = undefined;
    return;
  }

  renderPanel(state.panel, entry, link);
}

/**
 * Fill the panel with a preview entry and place it beside its link.
 *
 * Stateless: it reads only its arguments and the document's own geometry and
 * language, and the caller has already decided the entry is still wanted.
 */
function renderPanel(panel: HTMLElement, entry: NotePreview, link: HTMLAnchorElement): void {
  // Text nodes throughout — `textContent`, never `innerHTML` — so every string
  // from the snapshot stays data and is never parsed as markup.
  const pageLanguage = document.documentElement.lang || 'en';
  const markLanguage = (element: HTMLElement, language: string): void => {
    if (language.toLowerCase() !== pageLanguage.toLowerCase()) element.lang = language;
  };
  const title = document.createElement('strong');
  title.textContent = previewTitle(entry);
  markLanguage(title, entry.language);
  const excerpt = document.createElement('p');
  excerpt.textContent = entry.excerpt;
  markLanguage(excerpt, entry.language);
  const fragment = previewFragment(link.hash);
  if (fragment === undefined) panel.replaceChildren(title, excerpt);
  else {
    // A heading-target link says which section it lands on. The projection
    // carries nothing per heading, so this is the fragment itself rather than a
    // de-slugged guess at the heading's prose — see `previewFragment`.
    const section = document.createElement('span');
    section.className = 'preview-fragment';
    section.textContent = fragment;
    panel.replaceChildren(title, section, excerpt);
  }

  // Unhidden before measuring, because a `display: none` element has no size to
  // measure. Both happen inside this one task, so the browser paints the placed
  // panel and never the provisional position.
  panel.hidden = false;
  const { left, top } = placePreview(link.getBoundingClientRect(), panel.getBoundingClientRect(), {
    // Not `window.innerWidth`, which counts a classic scrollbar the panel
    // cannot occupy. `clientWidth`/`clientHeight` are the box a fixed-position
    // element is laid out in, so the arithmetic and the CSS agree on the edge.
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  });
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  link.setAttribute('aria-describedby', panel.id);
}

/**
 * Arm the intent delay for a link, replacing whatever was pending.
 *
 * The `current === link` branch is the pointer arriving somewhere it already
 * counts as being — onto a `<code>` or `<em>` inside the link it is already
 * over, or back from the panel — so it cancels a pending close rather than
 * restarting the open. Restarting would let a pointer drifting across a link's
 * inner elements postpone the preview indefinitely.
 */
function open(state: PreviewState, target: PreviewLink): void {
  if (state.current === target.link) {
    keep(state);
    return;
  }
  hide(state);
  state.current = target.link;
  state.openTimer = setTimeout(() => {
    state.openTimer = undefined;
    void show(state, target);
  }, OPEN_DELAY_MS);
}

function install(panel: HTMLElement): void {
  const state: PreviewState = { panel, current: undefined, openTimer: undefined, closeTimer: undefined };

  document.addEventListener('pointerover', (event) => {
    // Touch raises `pointerover` as part of the tap it precedes, so without this
    // a tap would flash a panel over the page it is navigating to. A pen hovers
    // like a mouse and is left alone.
    if (event.pointerType === 'touch') return;
    const target = previewTarget(event.target);
    if (target) open(state, target);
    else if (isInPanel(panel, event.target)) keep(state);
    else leave(state);
  });

  document.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'touch') return;
    // Moving deeper into the same link — a `<code>` or `<em>` inside it, or the
    // collection pager's two spans — is not leaving it, and neither is crossing
    // onto the panel. `relatedTarget` is the element being entered, and is null
    // when the pointer leaves the window.
    //
    // Belt and braces with `open`'s `keep()`, deliberately. In the ordering
    // browsers actually use — `pointerout` for the parent, then `pointerover`
    // for the child — either mechanism alone suffices, and mutation testing
    // confirms removing either one keeps the gate green. The pair matters for
    // the opposite ordering: `pointerover` first would call `keep()` with no
    // timer to clear, and the `pointerout` behind it would then arm a close
    // while the pointer was still inside the link. One line against an ordering
    // assumption is cheaper than the flicker it prevents.
    if (previewTarget(event.relatedTarget)?.link === state.current) return;
    if (isInPanel(panel, event.relatedTarget)) return;
    leave(state);
  });

  // `focusin`/`focusout` rather than `focus`/`blur`: the latter do not bubble, so
  // a document-level listener would never see them. This is the half Quartz does
  // not have at all — a keyboard reader tabbing through a backlinks list gets the
  // same preview a pointer does.
  //
  // `:focus-visible` is what keeps this from firing on touch. A tap focuses the
  // link too, so an unqualified `focusin` would flash a panel over the page the
  // tap is navigating to — the same defect the `pointerType` guards close on the
  // pointer path, arriving by the other door. The browser already decides whether
  // a focus deserves a visible indicator, and that decision is exactly the one
  // this needs: keyboard yes, touch and mouse no. Reusing it beats tracking the
  // last input type by hand, and it is the same signal the stylesheet's focus
  // ring uses, so a reader who sees the ring is the reader who gets the preview.
  document.addEventListener('focusin', (event) => {
    const target = previewTarget(event.target);
    if (target && target.link.matches(':focus-visible')) open(state, target);
    else hide(state);
  });

  document.addEventListener('focusout', (event) => {
    if (state.current !== undefined && previewTarget(event.target)?.link === state.current) hide(state);
  });

  document.addEventListener('keydown', (event) => {
    // Not `preventDefault`: Escape belongs to the reader. Consuming it would
    // break the search dialog's own dismissal on a page where both are open, and
    // dismissing a tooltip is not a reason to take the key away from everything
    // else.
    if (event.key === 'Escape' && state.current !== undefined) hide(state);
  });

  // `capture`, so a scroll inside any container dismisses rather than leaving the
  // panel pinned to a rectangle that has moved. Dismissing is cheaper and
  // steadier than re-placing on every scroll frame, and it is what a reader
  // expects: they moved the page, so the transient thing went away.
  //
  // A *pending* preview is deliberately left armed, and that is not a shortcut.
  // Tabbing to a link below the fold makes the browser scroll it into view, and
  // the scroll event lands after `focusin` — so dismissing unconditionally would
  // cancel the open timer and a keyboard reader would never see a preview for any
  // link that was off screen. Nothing is stale either way: the panel is placed
  // from a rectangle read when it is shown, not when it was scheduled.
  const dismissIfShowing = (): void => {
    if (!panel.hidden) hide(state);
  };
  window.addEventListener('scroll', dismissIfShowing, { passive: true, capture: true });
  window.addEventListener('resize', dismissIfShowing, { passive: true });
}
