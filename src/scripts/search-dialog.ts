/**
 * Search dialog.
 *
 * TK-06 OWNS THIS FILE'S BEHAVIOUR. It was moved verbatim out of the inline
 * `<script>` in `Layout.astro` so the built HTML satisfies `script-src 'self'`
 * with no inline script. Nothing about how search works was redesigned here.
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

if (trigger && dialog) {
  trigger.addEventListener('click', async () => {
    dialog.showModal();
    // Pagefind attaches its UI constructor to `window` when the bundle loads,
    // so it must be re-read after the await rather than reused from before it.
    const pagefindUI = () =>
      (window as typeof window & { PagefindUI?: new (options: unknown) => void }).PagefindUI;
    if (!pagefindUI()) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/pagefind/pagefind-ui.js';
        script.addEventListener('load', resolve, { once: true });
        script.addEventListener('error', reject, { once: true });
        document.head.append(script);
      });
      const PagefindUI = pagefindUI();
      if (PagefindUI) new PagefindUI({ element: '#search', showSubResults: true });
    }
  });
}
