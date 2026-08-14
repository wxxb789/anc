/**
 * Applies the stored display preferences before first paint.
 *
 * Kept a classic script with no imports or exports so `Layout.astro` can load
 * it render-blocking; see the comment there for why that matters. Ships to
 * every visitor in the critical path, so it stays short.
 */
(function () {
  var root = document.documentElement;

  /** Blocked storage throws on access, not on read. */
  function stored(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  // No attribute is the default: CSS then follows `prefers-color-scheme`
  // through `light-dark()`. These express only an explicit override.
  //
  // The `publish:` prefix is duplicated from `preferences.ts`, which this file
  // cannot import; `tests/design-tokens.test.ts` asserts the two agree. It names
  // what wrote the value rather than this project, so a stranger's visitor does
  // not carry the tool's name in their own browser storage.
  var theme = stored('publish:theme');
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;

  if (stored('publish:reader') === 'on') root.dataset.reader = 'on';

  // Reveals the controls that only work with scripting; without this they stay
  // hidden rather than rendering as buttons that do nothing.
  root.dataset.js = 'on';
})();
