/**
 * Theme and reader-mode toggles.
 *
 * Bundled by Astro as an external module, so the built HTML carries no inline
 * script and no inline event handler. `theme-init.js` has already applied the
 * stored preferences before paint; this module only handles later changes.
 *
 * Both preferences are expressed as one attribute on `<html>` that CSS already
 * understands, so the toggles are the only JavaScript involved and their
 * absence degrades to the system theme rather than to a broken page.
 */

/* Astro concatenates these scripts into one bundle. An import makes this file a
   module with its own top-level scope, so TK-06 and TK-07 can each declare
   `root`, `dialog`, or `preview` without colliding with the other's file. It was
   a bare `export {}` until TK-16 gave the file a real import. */
import { THEME_NAMES, type ThemeName } from '../lib/translations.ts';

/*
 * These two keys are also read by `src/scripts/theme-init.js`, which cannot
 * import them: it must stay a classic, import-free script to load render-
 * blocking before first paint. Renaming either key here without changing it
 * there silently orphans the stored preference, so `tests/design-tokens.test.ts`
 * asserts the two files agree.
 */
const THEME_KEY = 'thoughtscape:theme';
const READER_KEY = 'thoughtscape:reader';

/**
 * `system` is the absence of a stored value, which is what lets CSS decide.
 *
 * Imported rather than restated. This is a *client* module, so an import here
 * ships whatever it pulls in — but `THEME_NAMES` is a three-string array with no
 * dependencies, and Rollup tree-shakes the locale tables beside it out of the
 * bundle. `tests/built-routes.test.ts` proves no chrome string reaches a shipped
 * script, so the claim is measured rather than assumed.
 */
const THEMES = THEME_NAMES;
type Theme = ThemeName;

/**
 * The `dataset` key carrying each theme's label.
 *
 * Written out rather than built from the theme name, and that is a fix rather
 * than a style: `dataset['label' + capitalize(theme)]` is a key spelled in two
 * places by two different rules, so a rename on either side yielded `undefined`
 * and the toggle silently fell back to rendering the raw English state name
 * inside Chinese chrome.
 *
 * Naming the keys does **not** make a typo a type error — `dataset[k]` is
 * `string | undefined` for any string `k`, so `labelSytem` compiles. What it
 * does is put both spellings where one diff shows them, and make the pairing
 * checkable: `tests/built-routes.test.ts` asserts every attribute this table
 * names is present and non-empty on every built page, which is the assertion
 * that actually fails on a rename. `search-dialog.ts` carries the same table
 * and is covered by the same gate.
 */
const THEME_DATASET: Readonly<Record<Theme, string>> = {
  system: 'labelSystem',
  light: 'labelLight',
  dark: 'labelDark',
};

const root = document.documentElement;

/** Storage can be unavailable or full; a failed write must not break the toggle. */
function persist(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Preference is not persisted; the current page still reflects the choice. */
  }
}

function currentTheme(): Theme {
  const value = root.dataset.theme;
  return THEMES.includes(value as Theme) ? (value as Theme) : 'system';
}

/**
 * The label carries the state in text, not only in the rendered colours.
 *
 * The three labels are read off the button's own `data-label-*` attributes,
 * which `Layout.astro` filled from the translation resolved for *this document*
 * — so a Chinese note's toggle cycles "主题：跟随系统 / 浅色 / 深色" and an
 * English one cycles "Theme: system / light / dark", from one shared script.
 * TK-16 could have shipped a locale table in the bundle instead; that would put
 * both languages on the wire for every reader and grow with each language added,
 * to say the same words the server already knew. The fallback keeps the toggle
 * operable rather than blank if the markup and this file ever disagree.
 */
function showTheme(theme: Theme, button: HTMLButtonElement): void {
  button.textContent = button.dataset[THEME_DATASET[theme]] ?? theme;
}

function showReader(on: boolean, button: HTMLButtonElement): void {
  button.setAttribute('aria-pressed', String(on));
}

function applyTheme(theme: Theme, button: HTMLButtonElement): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  persist(THEME_KEY, theme === 'system' ? null : theme);
  showTheme(theme, button);
}

function applyReader(on: boolean, button: HTMLButtonElement): void {
  if (on) root.dataset.reader = 'on';
  else delete root.dataset.reader;
  persist(READER_KEY, on ? 'on' : null);
  showReader(on, button);
}

/*
 * The initial sync only reads. `currentTheme()` reflects the DOM, not storage,
 * so if `theme-init.js` failed to load — a stale cached page against a rotated
 * asset hash, an extension, a CDN miss — it reports `system`. Routing that
 * through `applyTheme` would call `removeItem` and destroy a preference the
 * user actually set, rather than merely failing to apply it this once.
 */
const themeButton = document.querySelector<HTMLButtonElement>('#theme-toggle');
if (themeButton) {
  showTheme(currentTheme(), themeButton);
  themeButton.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length] ?? 'system';
    applyTheme(next, themeButton);
  });
}

const readerButton = document.querySelector<HTMLButtonElement>('#reader-toggle');
if (readerButton) {
  showReader(root.dataset.reader === 'on', readerButton);
  readerButton.addEventListener('click', () => {
    applyReader(root.dataset.reader !== 'on', readerButton);
  });
}
