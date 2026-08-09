/**
 * Search dialog.
 *
 * TK-06 OWNS THIS FILE'S BEHAVIOUR. It was moved verbatim out of the inline
 * `<script>` in `Layout.astro` so the built HTML satisfies `script-src 'self'`
 * with no inline script. Nothing about how search works was redesigned here.
 *
 * TK-12 changed one thing: the Pagefind stylesheet was a render-blocking
 * `<link>` on every page — 2,599 B gzip, 26% of article first-paint transfer,
 * for a dialog most readers never open — and now loads here, with the bundle it
 * styles, on first open.
 *
 * Known gaps TK-06 must close (requirements section 11.4 and ticket TK-06):
 * migrate off the deprecated Pagefind Default UI, drop the dynamically injected
 * `<script>` in favour of a static import of the supported entry point, add a
 * focus trap and focus restoration, arrow-key result navigation, a documented
 * keyboard shortcut, and separate messaging for "no results", "still loading",
 * and "index failed to load".
 */

/* Astro concatenates these scripts into one bundle. `export {}` makes this file
   a module with its own top-level scope, so TK-06 and TK-07 can each declare
   `root`, `dialog`, or `preview` without colliding with the other's file. */
export {};

const trigger = document.querySelector<HTMLButtonElement>('#search-toggle');
const dialog = document.querySelector<HTMLDialogElement>('#search-dialog');

/** Append a same-origin `<link>` or `<script>` and resolve when it has loaded. */
function load(element: HTMLLinkElement | HTMLScriptElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = element.getAttribute('href') ?? element.getAttribute('src');
    element.addEventListener('load', () => resolve(), { once: true });
    element.addEventListener('error', () => reject(new Error(`failed to load ${source}`)), { once: true });
    document.head.append(element);
  });
}

/**
 * Fetch the Pagefind bundle once and mount its UI into `#search`.
 *
 * Three states have to stay distinct, and conflating any two is a bug:
 *
 * - **mounted** — the UI is in the DOM. Guarded by its own flag rather than by
 *   `window.PagefindUI`, which is set as soon as the *script* runs: two clicks
 *   during one in-flight load would both pass that check on resume and mount
 *   two stacked search UIs into the same element.
 * - **loading** — a fetch is in flight. Reused so a second click does not append
 *   a duplicate `<link>` and `<script>`, and cleared on failure so one transient
 *   error does not kill search for the page's lifetime.
 * - **failed** — the reader is told, and the next click retries.
 *
 * The stylesheet is awaited so the first frame is not unstyled, but its failure
 * is **not** fatal: the script is what search needs, and refusing to mount a
 * working index because its CSS 404'd would leave the reader with "unavailable"
 * on a search that works.
 */
if (trigger && dialog) {
  const target = document.querySelector<HTMLElement>('#search');
  let loading: Promise<void> | undefined;
  let mounted = false;

  /**
   * Start the fetch and return its promise.
   *
   * Deliberately not `async`, which `astro check` suggests as hint ts(80006) and
   * which would be wrong here: an async function's body runs when it is called,
   * so `loading ??= fetchBundle()` would have started the fetch before the
   * assignment landed, and two clicks in the same tick would each append their
   * own `<link>` and `<script>`. Returning the promise from a synchronous call
   * keeps the start atomic with the memoisation. The hint is the only one this
   * repository carries; it is recorded here rather than silenced.
   */
  const fetchBundle = (): Promise<void> => {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/pagefind/pagefind-ui.css';
    const script = document.createElement('script');
    script.src = '/pagefind/pagefind-ui.js';
    // Only the script's failure rejects. The `catch` on the stylesheet keeps a
    // missing sheet from failing the whole load *and* from surfacing as an
    // unhandled rejection.
    const styled = load(stylesheet).catch(() => undefined);
    return Promise.all([load(script), styled]).then(() => undefined);
  };

  trigger.addEventListener('click', async () => {
    dialog.showModal();
    if (mounted || !target) return;

    try {
      loading ??= fetchBundle();
      await loading;
      // Re-checked after the await, not only before it. Two clicks during one
      // in-flight load both pass the check at the top, both resume here, and the
      // second would clear the first's DOM and construct a second UI into the
      // same element. The check before the await is the cheap path; this one is
      // the correct one.
      if (mounted) return;
      // Pagefind attaches its constructor to `window` when the bundle loads, so
      // it is read after the await rather than before it.
      const PagefindUI = (window as typeof window & { PagefindUI?: new (options: unknown) => void })
        .PagefindUI;
      if (!PagefindUI) throw new Error('the Pagefind bundle loaded but exposed no UI');
      // Set before constructing rather than after: if the constructor itself
      // throws, the catch resets it, so a genuine failure still retries while a
      // concurrent resume cannot slip past.
      mounted = true;
      // Clear first: a failure message from an earlier attempt would otherwise
      // sit above the search input for the rest of the page's life.
      target.textContent = '';
      new PagefindUI({ element: '#search', showSubResults: true });
    } catch {
      // An unhandled rejection here would be a console error on a page that is
      // otherwise clean, and the reader would be left looking at an empty dialog
      // with no explanation. TK-06 owns the real messaging — separate states for
      // "no results", "still loading", and "index failed to load"; this is the
      // honest minimum until then.
      loading = undefined;
      mounted = false;
      target.textContent = 'Search is unavailable right now. Please try again.';
    }
  });
}
