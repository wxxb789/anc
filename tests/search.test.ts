/**
 * Search: the built markup, the load-state machine, and the keyboard contract.
 *
 * Split by what each property needs to be true. The language-partition helper is
 * a pure function and is tested as one. The markup gates read `dist/`. The
 * keyboard flow, the three load states, and the bilingual merge need a real
 * browser under the real policy — a jsdom `<dialog>` has no top layer, no
 * `showModal` focus contract, and no WebAssembly, so proving any of it there
 * would prove something about the harness rather than about the site.
 *
 * The browser gates skip when Chromium is absent, exactly as
 * `tests/rendered-page.test.ts` does and for the same reason: a fresh clone
 * still gets a green `pnpm test` rather than a failure it cannot act on.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, relative, sep } from 'node:path';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test, type TestContext } from 'vitest';

import type { AddressInfo } from 'node:net';
import type { Browser, ConsoleMessage, Page } from 'playwright';

import { otherLanguages } from '../src/scripts/search-dialog.ts';
import { MESSAGE_DATASET, translate, type Translation } from '../src/lib/translations.ts';

const ROOT = new URL('../', import.meta.url);
const DIST = fileURLToPath(new URL('dist/', ROOT));

/** Where the search bundle is served from, matching `src/scripts/search-dialog.ts`. */
const BUNDLE_PATH_SEGMENT = '/pagefind/';

/**
 * A word every corpus contains, so a query for it must return results.
 *
 * Used where the question is "does search still work", not "does this term
 * match" — a gate that measured a term the corpus lacks would be green for the
 * wrong reason.
 */
const PRIMARY_QUERY = 'the';

/* ------------------------------------------------------------------ pure -- */

/**
 * Which language partitions a page must merge to search the whole corpus.
 *
 * The defect this closes is silent and total: Pagefind partitions its index by
 * `<html lang>` and loads only the current document's partition, so on the
 * bilingual corpus every English note was unfindable from a Chinese page and
 * every Chinese note from an English one — reported to the reader as "no
 * results", which is a statement about the corpus that the corpus contradicts.
 *
 * The cases below mirror Pagefind's own `findIndex`, because the rule for which
 * partition to *exclude* has to be the rule it uses to *choose*. An earlier
 * version reasoned about tag shape instead, and encoded two bugs measured
 * against real `pagefind` output: with both `en` and `en-gb` indexed it merged
 * neither into the other, leaving half the corpus unfindable; and with a
 * document in a language indexed under no form it merged the primary index onto
 * itself, so every result rendered twice.
 */
test('every language partition except the one Pagefind loads is merged', () => {
  const entry = { languages: { en: {}, 'zh-cn': {} } };

  assert.deepEqual(otherLanguages(entry, 'en'), ['zh-cn']);
  assert.deepEqual(otherLanguages(entry, 'zh-CN'), ['en'], 'the comparison must be case-insensitive');
  // No `en-gb` partition exists, so Pagefind falls back to the base subtag and
  // loads `en` — which is therefore the one that must not be merged.
  assert.deepEqual(otherLanguages(entry, 'en-GB'), ['zh-cn'], 'en-GB falls back to the en index');
  assert.deepEqual(otherLanguages({ languages: { 'zh-cn': {} } }, 'zh'), [], 'zh falls back to the zh-cn index');

  // A sibling region tag *is* its own partition, and merging it is the whole
  // point: the base-subtag rule is Pagefind's fallback, not an equivalence.
  const withRegion = { languages: { en: {}, 'en-gb': {}, fr: {} } };
  assert.deepEqual(
    otherLanguages(withRegion, 'en').sort(),
    ['en-gb', 'fr'],
    'a sibling region partition must be merged, or half the corpus stays unfindable',
  );
  assert.deepEqual(
    otherLanguages(withRegion, 'en-GB').sort(),
    ['en', 'fr'],
    'an exact match wins over the base subtag, so en-gb must not exclude en',
  );

  // A document in a language indexed under no form: Pagefind loads the largest
  // partition, so that one — and only that one — must be excluded. Returning it
  // as "other" merges the index onto itself and doubles every result.
  assert.deepEqual(
    otherLanguages({ languages: { en: { page_count: 28 }, 'zh-cn': { page_count: 4 } } }, 'fr').sort(),
    ['zh-cn'],
    'the largest partition is already primary and must not be merged onto itself',
  );

  // A monolingual corpus merges nothing, so the common case costs no fetch.
  assert.deepEqual(otherLanguages({ languages: { en: {} } }, 'en'), []);
  assert.deepEqual(otherLanguages({ languages: { en: {} } }, 'fr'), [], 'the only partition is always primary');
  // A document with no language must not merge every index twice over.
  assert.deepEqual(otherLanguages({}, 'en'), [], 'an index-less entry file merges nothing');
});

/* ----------------------------------------------------------- built HTML -- */

function builtPages(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === 'pagefind') continue;
      const child = join(directory, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (name === 'index.html') found.push(child);
    }
  };
  // Returns empty rather than failing, and the gates below assert non-empty
  // themselves. Failing at module scope would take the pure `otherLanguages`
  // test down with it — a test that needs no build and would then be impossible
  // to run on a fresh clone, which is the opposite of what a missing `dist/`
  // should cost.
  try {
    walk(DIST);
  } catch {
    return [];
  }
  return found;
}

const PAGES = builtPages();

/** Every gate over built output needs one; say so once, in the same words. */
function requirePages(): string[] {
  assert.ok(PAGES.length > 0, 'dist/ is missing or empty — run `pnpm run build` before `pnpm test`');
  return PAGES;
}

/**
 * The route a built file is served at.
 *
 * `relative` rather than slicing by `DIST.length`: `fileURLToPath` returns a
 * trailing separator on a directory URL, so an off-by-one there silently
 * produces `/otes/…` and every route lookup misses. That is exactly the kind of
 * failure that reads as "the corpus has no Chinese page" rather than as a bug in
 * the test.
 */
function routeOf(file: string): string {
  return `/${relative(DIST, file).replaceAll(sep, '/').replace(/index\.html$/, '')}`;
}

/**
 * The dialog ships as HTML, not as a script that builds it.
 *
 * Two properties depend on this and neither is cosmetic. The `<input>` and its
 * `<label>` are a real pair in the document, rather than Pagefind's substitute
 * where the label is a `data-` attribute on a generated element. And the dialog
 * has something to focus the instant it opens, before the bundle has loaded —
 * otherwise the reader's first keystrokes land nowhere.
 */
test('every page ships the search dialog as markup', () => {
  for (const file of requirePages()) {
    const html = readFileSync(file, 'utf8');
    assert.match(html, /<dialog id="search-dialog"/, `${file}: no search dialog`);
    assert.match(html, /<label[^>]*for="search-input"/, `${file}: the search field has no label`);
    assert.match(html, /<input id="search-input"/, `${file}: no search field`);
    assert.match(html, /id="search-status"[^>]*role="status"/, `${file}: the status line is not a live region`);
    assert.match(html, /id="search-results"/, `${file}: no results container`);
  }
});

/**
 * The trigger announces its shortcut.
 *
 * Requirements section 11.4 asks for "a documented keyboard shortcut", and a
 * shortcut nobody can discover is not documented. `aria-keyshortcuts` is the
 * attribute that exists for this; a `title` would be announced by no screen
 * reader and discoverable by no keyboard user.
 */
test('the search trigger names its keyboard shortcut', () => {
  for (const file of requirePages()) {
    const html = readFileSync(file, 'utf8');
    const language = /<html lang="([^"]+)"/.exec(html)?.[1];
    assert.ok(language !== undefined, `${file}: the page declares no language`);
    const trigger = /<button id="search-toggle"[^>]*>/.exec(html)?.[0];
    assert.ok(trigger !== undefined, `${file}: no search trigger`);
    assert.match(trigger, /aria-keyshortcuts="\/"/, `${file}: the trigger does not name its shortcut`);
    // The accessible name is chrome, so since TK-16 it is in the page's own
    // language: an English page says "press slash" and a Chinese one says
    // "按斜杠键". Matching the English word would fail on every Chinese page,
    // and matching nothing would let the shortcut drop out of the name — so the
    // assertion is against the sentence this page's own locale resolves.
    // A literal comparison, not a pattern: the English label contains "(press
    // slash)", and a parenthesis in a regexp built from prose is a capture group
    // that matches the wrong thing rather than the text.
    assert.ok(
      trigger.includes(`aria-label="${translate(language).searchToggleLabel}"`),
      `${file}: the accessible name is not this page's own (lang="${language}"): ${trigger}`,
    );
    // And that sentence mentions the key, in whichever language it is written.
    // Stated over the locale rather than over the page, so a locale that dropped
    // the shortcut from the name fails here rather than shipping.
    assert.ok(
      /slash|斜杠/.test(translate(language).searchToggleLabel),
      `${file}: the "${language}" accessible name does not mention the shortcut key`,
    );
    // The trigger cannot work without scripting, so it must not render without
    // it. `tests/rendered-page.test.ts` proves the cascade actually hides it.
    assert.match(trigger, /data-js-only/, `${file}: a script-only control is offered unconditionally`);
  }
});

/**
 * The dialog is not in the search index.
 *
 * It is on every page, so without `data-pagefind-ignore` its chrome would be
 * indexed into all 32 notes — the same defect TK-12 fixed for the back link and
 * the heading anchors, and the one that made every result excerpt open with
 * `← All notes`. The attribute is asserted rather than the index decompressed:
 * the parity plan §7.3 rejects a decompression test, and this is the mechanism
 * that produces the property.
 */
test('the search dialog is excluded from the index', () => {
  for (const file of requirePages()) {
    const dialog = /<dialog id="search-dialog"[^>]*>/.exec(readFileSync(file, 'utf8'))?.[0];
    assert.ok(dialog !== undefined, `${file}: no search dialog`);
    assert.match(dialog, /data-pagefind-ignore/, `${file}: the dialog chrome would be indexed into every page`);
  }
});

/* ---------------------------------------------------------- the browser -- */

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The headers the site deploys, read from the file that deploys them.
 *
 * The whole point of these gates is that search works under the *shipped*
 * policy: `script-src 'self' 'wasm-unsafe-eval'; style-src 'self'`. Serving
 * anything looser would prove search works under a policy nobody deploys — and
 * TK-12's own report records that this is how the CSP block went unnoticed for
 * eleven tickets.
 */
function shippedHeaders(): Record<string, string> {
  const text = readFileSync(new URL('public/_headers', ROOT), 'utf8');
  const headers: Record<string, string> = {};
  let hasSeenPattern = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      if (hasSeenPattern) break;
      hasSeenPattern = true;
      continue;
    }
    const separator = line.indexOf(':');
    assert.ok(separator > 0, `public/_headers: not a "Name: value" header line: ${JSON.stringify(line)}`);
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  assert.ok(Object.keys(headers).length > 0, 'public/_headers declares no headers to serve');
  return headers;
}

/**
 * How the server should mistreat the search bundle, for the tests that need it.
 *
 * The two hostile conditions the load-state machine exists to survive, driven
 * for real rather than simulated by calling an internal function: a bundle that
 * never arrives, and one that arrives slowly. Without the delay the "loading"
 * state is unobservable on a loopback server — it is entered and left inside a
 * single millisecond, so a test that samples the status line reads the state
 * *after* it and concludes the site never had one.
 */
interface Interference {
  failPath?: string;
  /** Match `failPath` whole rather than as a substring. */
  exact?: boolean;
  slowPath?: string;
  delayMs?: number;
}

/**
 * Serve `dist/`, with hooks for making one path fail or crawl.
 *
 * This is what makes the third load state testable at all. "The index could not
 * be loaded" is the state most implementations collapse into "no results", and
 * the only honest way to check it is to break the fetch the way a flaky CDN
 * would.
 */
function serveDist(interference: () => Interference): Promise<Server> {
  const headers = shippedHeaders();
  const server = createServer((request, response) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400, headers);
      response.end('bad request');
      return;
    }

    const { failPath, exact = false, slowPath, delayMs = 0 } = interference();
    if (failPath !== undefined && (exact ? path === failPath : path.includes(failPath))) {
      response.writeHead(503, headers);
      response.end('unavailable');
      return;
    }

    let file = join(DIST, normalize(path));
    if (file !== DIST.replace(/[/\\]$/, '') && !file.startsWith(DIST)) {
      response.writeHead(403, headers);
      response.end('forbidden');
      return;
    }

    const send = (): void => {
      try {
        if (statSync(file).isDirectory()) file = join(file, 'index.html');
        const body = readFileSync(file);
        response.writeHead(200, {
          ...headers,
          'Content-Type': TYPE_BY_EXTENSION[extname(file)] ?? 'application/octet-stream',
        });
        response.end(body);
      } catch {
        response.writeHead(404, headers);
        response.end('not found');
      }
    };

    if (slowPath !== undefined && path.includes(slowPath)) setTimeout(send, delayMs);
    else send();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch(): Promise<{ browser: Browser } | { unavailable: string }> {
  const { chromium } = await import('playwright');
  const install = 'run `pnpm exec playwright install chromium` to run the rendered gates';
  let executable: string;
  try {
    executable = chromium.executablePath();
  } catch (error) {
    return { unavailable: `no Playwright browser is installed — ${install} (${String(error)})` };
  }
  if (!existsSync(executable)) {
    return { unavailable: `no Playwright browser is installed at ${executable} — ${install}` };
  }
  return { browser: await chromium.launch() };
}

let server: Server | undefined;
let origin = '';
let launched: { browser: Browser } | { unavailable: string } | undefined;
/** Set by a test to make the search bundle fail or crawl; reset in its `finally`. */
let interference: Interference = {};

beforeAll(async () => {
  launched = await launch();
  if ('unavailable' in launched) return;
  server = await serveDist(() => interference);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (launched !== undefined && 'browser' in launched) await launched.browser.close();
  server?.close();
  // `browser.close()` is the whole cost here, and it is a **spread rather than a
  // level**. Measured directly, 12 rounds closing a browser with no page open at
  // all: min 1.0 s, p50 7.9 s, max 16.9 s. The same measurement with 2 and with
  // 16 pages open gave 31.4 s and 13.3 s respectively — so the sentence this
  // comment used to carry, that the cost "grows with how many contexts the suite
  // opened", is false. It is process teardown competing for a scheduler.
  //
  // Under the contention the suite creates — 15 workers, which is what
  // `isolate: true` gives 33 files on this 16-CPU host — the same close measured
  // p50 22.4 s, max 43.3 s. Observed in the run itself: 20.9 s, 32.0 s, and a
  // timeout at 60 s.
  //
  // 180 s is four times the contended max, and that multiple is deliberate. A
  // budget on a distribution this wide is not a claim about the mean; the tail
  // is unbounded upward by anything measurable here, and this hook failing costs
  // the whole file — all 12 gates report as one suite error naming none of them.
  // A hung Chromium still fails inside three minutes.
}, 180_000);

function requireBrowser(context: TestContext): Browser {
  assert.ok(launched !== undefined, 'the suite setup did not run, so no browser was prepared');
  if ('unavailable' in launched) return context.skip(launched.unavailable);
  return launched.browser;
}

/** One route a note lives at, for the tests that need a real article page. */
function anyNoteRoute(): string {
  const notes = readdirSync(join(DIST, 'notes'));
  assert.ok(notes.length > 0, 'the build produced no note pages');
  return `/notes/${notes[0]}/`;
}

/** Console errors and uncaught exceptions, which Playwright reports separately. */
function collectFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error: Error) => failures.push(`uncaught: ${error.message}`));
  return failures;
}

/**
 * Which `Translation` key holds each announceable state's sentence.
 *
 * The gates key by state, and `MESSAGE_DATASET` maps a state to the *dataset*
 * key the markup carries — `messageLoading`, not `searchLoading` — so it cannot
 * index the locale table. A rename in either direction is a type error here.
 */
const SEARCH_STATE_KEY = {
  idle: 'searchIdle',
  loading: 'searchLoading',
  empty: 'searchEmpty',
  failed: 'searchFailed',
} as const satisfies Record<keyof typeof MESSAGE_DATASET, keyof Translation>;

/**
 * The status sentence a page's own locale resolves for a state.
 *
 * Since TK-16 these four sentences are per-document chrome: `Layout.astro`
 * resolves them for the document's own language and writes them to
 * `#search-status` as `data-message-*`, and `search-dialog.ts` announces by
 * reading them back. A gate that hardcodes the English form asserts against a
 * sentence a zh-CN page never renders — `dist/notes/orphan-three-zh/` carries
 * `data-message-loading="正在加载搜索索引…"`, so an English literal makes
 * `openSearch` wait 20 s for text that page has no way to produce.
 *
 * Resolved through `translate()` rather than read back off the page's own
 * attribute, and the difference is what keeps these gates gates. Sourcing the
 * expectation from the element under test compares the page against itself: it
 * passes for whatever the page renders, including nothing at all, so the whole
 * i18n contract could regress green. This states the sentence `Layout.astro`
 * was supposed to write, from the same table it writes from.
 *
 * The language comes from `<html lang>` — the document's own, not a site-wide
 * constant — because per-document resolution is the property TK-16 establishes.
 */
async function statusMessage(page: Page, state: keyof typeof SEARCH_STATE_KEY): Promise<string> {
  const language = await page.getAttribute('html', 'lang');
  assert.ok(language !== null && language !== '', 'the page declares no lang, so no chrome language can be resolved');
  const sentence = translate(language)[SEARCH_STATE_KEY[state]];
  assert.ok(sentence !== '', `the "${language}" locale has no ${state} sentence for the dialog to announce`);
  return sentence;
}

/** Open the dialog and wait for the bundle to settle into a resting state. */
async function openSearch(page: Page): Promise<void> {
  const loading = await statusMessage(page, 'loading');
  await page.click('#search-toggle');
  await page.waitForFunction(
    (sentence) => {
      const status = document.querySelector('#search-status');
      return status !== null && status.textContent !== sentence;
    },
    loading,
    { timeout: 20_000 },
  );
}

/**
 * A query returns a result in a real browser under the shipped CSP.
 *
 * TK-06's first acceptance criterion, and TK-12's method: serve `dist/` with the
 * real `_headers`, drive a real browser, and require a clean console. The
 * console assertion is not decoration — a CSP violation is reported there and
 * nowhere else, and a search that silently returns nothing because its
 * WebAssembly was blocked looks identical to a search with no matches.
 */
test('a query returns a result under the shipped CSP, with a clean console', async (context) => {
  const browser = requireBrowser(context);
  const page = await browser.newPage();
  const failures = collectFailures(page);
  try {
    await page.goto(`${origin}/`);
    await openSearch(page);
    // A body word rather than a title word: this must prove the body index
    // works, not that the page's own title is on the page. `PRIMARY_QUERY`
    // rather than a term lifted from one corpus — a query hardcoded to the
    // published note's vocabulary passes `verify` and times out under
    // `build:fixture`, which is the same term measured against two different
    // corpora.
    await page.fill('#search-input', PRIMARY_QUERY);
    await page.waitForSelector('#search-results a', { timeout: 20_000 });

    const results = await page.$$eval('#search-results a', (links) =>
      links.map((link) => ({ href: link.getAttribute('href'), text: link.textContent })),
    );
    assert.ok(results.length > 0, 'a matching query returned no results');
    for (const result of results) {
      assert.match(result.href ?? '', /^\/notes\//, `a result links outside the note routes: ${result.href}`);
      assert.ok((result.text ?? '').trim() !== '', 'a result rendered with no title');
    }
    assert.deepEqual(failures, [], 'the page reported errors while searching');
  } finally {
    await page.close();
  }
}, 120_000);

/**
 * The three load states are three different sentences.
 *
 * This is the state machine the ticket singles out, and the failure it names is
 * specific: implementations collapse "still loading" and "failed to load" into
 * "no results", so a reader is told the site has nothing on a subject when in
 * fact the index never arrived. Each state is driven to for real — the failure
 * by breaking the fetch, not by calling an internal function — and all three
 * messages are required to differ from one another.
 */
test('no results, still loading, and load failure are told apart', async (context) => {
  const browser = requireBrowser(context);
  let page: Page | undefined;
  try {
    // The bundle is delayed so the loading state is observable at all. On a
    // loopback server it is otherwise entered and left inside one millisecond,
    // and a test that samples the status line then reads the state *after* it
    // and concludes the site never had one — which is how "still loading" ends
    // up quietly collapsed into "no results" in the first place.
    interference = { slowPath: 'pagefind-modular-ui.js', delayMs: 1_500 };
    page = await browser.newPage();
    await page.goto(`${origin}/`);

    // Each sentence is read before the state is driven to, so the comparison is
    // against what this document resolved rather than against English. Equality
    // rather than the `startsWith` these two once used: `announce` assigns the
    // attribute verbatim, so the whole sentence is the exact expected text, and
    // a prefix would also accept a state that merely began the same way.
    const loadingSentence = await statusMessage(page, 'loading');
    const emptySentence = await statusMessage(page, 'empty');

    await page.click('#search-toggle');
    await page.waitForFunction(
      (sentence) => document.querySelector('#search-status')?.textContent === sentence,
      loadingSentence,
      { timeout: 10_000 },
    );
    const loadingMessage = await page.textContent('#search-status');

    interference = {};
    await page.waitForFunction(
      (sentence) => document.querySelector('#search-status')?.textContent !== sentence,
      loadingSentence,
      { timeout: 20_000 },
    );
    const idleMessage = await page.textContent('#search-status');

    // A term no note contains. The corpus is real, so this has to be nonsense.
    await page.fill('#search-input', 'zzqqxwv');
    await page.waitForFunction(
      (sentence) => document.querySelector('#search-status')?.textContent === sentence,
      emptySentence,
      { timeout: 20_000 },
    );
    const emptyMessage = await page.textContent('#search-status');
    const rowsWhenEmpty = await page.$$eval('#search-results a', (links) => links.length);
    await page.close();
    page = undefined;

    // A second page, with the bundle unreachable. The state must be the failure
    // one, and must not be the empty one.
    interference = { failPath: BUNDLE_PATH_SEGMENT };
    const broken = await browser.newPage();
    try {
      await broken.goto(`${origin}/`);
      await broken.click('#search-toggle');
      await broken.waitForFunction(
        (sentence) => document.querySelector('#search-status')?.textContent === sentence,
        await statusMessage(broken, 'failed'),
        { timeout: 20_000 },
      );
      const failedMessage = await broken.textContent('#search-status');

      const messages = { loadingMessage, idleMessage, emptyMessage, failedMessage };
      for (const [name, message] of Object.entries(messages)) {
        assert.ok((message ?? '').trim() !== '', `${name} is empty, so that state says nothing to the reader`);
      }
      assert.equal(
        new Set(Object.values(messages)).size,
        4,
        `two states share a message, so the reader cannot tell them apart: ${JSON.stringify(messages)}`,
      );
      assert.equal(rowsWhenEmpty, 0, 'the empty state still rendered result rows');
      // The one property the ticket states outright: failure must leave the rest
      // of the page usable.
      assert.ok(
        await broken.isVisible('main'),
        'the page became unusable when the search index failed to load',
      );
      assert.ok(
        (await broken.$$eval('main a', (links) => links.length)) > 0,
        'no link on the page survived the search failure',
      );
    } finally {
      await broken.close();
    }
  } finally {
    // Reset in the outer `finally` so a failure anywhere above cannot leave the
    // shared server mistreating the bundle for every test that follows.
    interference = {};
    if (page !== undefined && !page.isClosed()) await page.close();
  }
}, 180_000);

/**
 * A partial outage is reported as a failure, not as a working empty search.
 *
 * Three separate assets can go missing independently, and each one used to
 * produce a *different* lie. Failing the whole `/pagefind/` prefix — which is
 * what the state-machine test above does — is the easy case, because it takes
 * the modular-UI script with it. These are the cases where the UI loads
 * perfectly and the index behind it is dead:
 *
 * - `pagefind.js`: Pagefind's own loader catches the failed import, logs, and
 *   then calls `.options()` on `undefined`. The status line sat on "Loading the
 *   search index…" forever and the Enter-retry was dead.
 * - `wasm.<lang>.pagefind`: `init()` resolves *anyway*, so the reader was shown
 *   "Type to search this site" over an index that could never answer.
 * - the metadata chunk: the same, failing later with "WASM Error (No pointer)".
 *
 * All three were live defects found by review and reproduced against the real
 * build before being fixed; this is what keeps them fixed. The status is required
 * to be the failure message specifically, since "not the loading message" would
 * pass for the second and third.
 *
 * The counterweight — that a *merged* language's loss must NOT fail the search —
 * is the separate test below, so that it can skip honestly on a corpus with one
 * language rather than looping zero times inside a green result.
 */
test('a broken search runtime reports failure rather than a working empty index', async (context) => {
  const browser = requireBrowser(context);
  const entry = JSON.parse(readFileSync(join(DIST, 'pagefind', 'pagefind-entry.json'), 'utf8')) as {
    languages?: Record<string, { hash?: string; wasm?: string | null }>;
  };
  const languages = Object.entries(entry.languages ?? {});
  assert.ok(languages.length > 0, 'the build produced no search index');

  // The partition the home page itself queries — the only one whose loss the
  // reader cannot search around.
  const homeLanguage = (/<html lang="([^"]+)"/.exec(readFileSync(join(DIST, 'index.html'), 'utf8'))?.[1] ?? '')
    .toLowerCase();
  const merged = new Set(otherLanguages({ languages: entry.languages }, homeLanguage));
  const primary = languages.find(([name]) => !merged.has(name));
  assert.ok(primary !== undefined, `no index partition serves a "${homeLanguage}" page`);
  const [, index] = primary;

  const asset = (name: string): string => `${BUNDLE_PATH_SEGMENT}${name}`;
  const fatal = [
    asset('pagefind.js'),
    asset(`wasm.${index.wasm ?? 'unknown'}.pagefind`),
    asset(`pagefind.${index.hash}.pf_meta`),
  ];

  /** Open search on the home page with one asset missing; return what it says. */
  async function withoutAsset(missing: string): Promise<{ status: string; rows: number; failed: string }> {
    interference = { failPath: missing, exact: true };
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/`);
      // Both sentences come from the page under test, and the failure one is
      // returned alongside the status so the caller compares like with like.
      const failed = await statusMessage(page, 'failed');
      await page.click('#search-toggle');
      await page
        .waitForFunction(
          (sentence) => {
            const text = document.querySelector('#search-status')?.textContent ?? '';
            return text !== '' && text !== sentence;
          },
          await statusMessage(page, 'loading'),
          { timeout: 20_000 },
        )
        .catch(() => undefined);
      const status = (await page.textContent('#search-status')) ?? '';
      // A query that must match in the *primary* index, so the measurement is
      // whether search still works rather than only what the status line claims.
      await page.fill('#search-input', PRIMARY_QUERY);
      await page.waitForTimeout(1_500);
      const rows = await page.$$eval('#search-results a', (links) => links.length);
      // Failure must never cost the reader the page they came for.
      assert.ok(await page.isVisible('main'), `${missing}: the page became unusable`);
      return { status, rows, failed };
    } finally {
      await page.close();
    }
  }

  try {
    for (const missing of fatal) {
      const { status, failed } = await withoutAsset(missing);
      assert.ok(
        status === failed,
        `with ${missing} unavailable the reader was told ${JSON.stringify(status)} ` +
          'instead of that the search index had failed',
      );
    }

  } finally {
    interference = {};
  }
}, 180_000);

/**
 * Losing a *merged* language's index does not fail the whole search.
 *
 * The counterweight to the gate above, and it is not symmetry for its own sake:
 * without this direction, the honest implementation and a paranoid one that
 * fails on any missing byte are indistinguishable. The reader still has the
 * index for the page they are on, and partial results beat none.
 *
 * The `rows > 0` assertion is the load-bearing one, and its absence is what made
 * an earlier version of this gate pass *because* of a defect. Pagefind registers
 * a merged instance synchronously — before its first await — and `search()`
 * flat-maps across every registered instance with no way to remove one, so a
 * partition that fails after registration poisons the working primary index for
 * the life of the page. With that bug present the status line read "Type to
 * search this site" while a query matching the healthy primary index returned
 * nothing: a green "did not report failure" over a search that was dead.
 */
test('a lost merged language leaves the rest of the search working', async (context) => {
  const browser = requireBrowser(context);
  const entry = JSON.parse(readFileSync(join(DIST, 'pagefind', 'pagefind-entry.json'), 'utf8')) as {
    languages?: Record<string, { hash?: string }>;
  };
  const homeLanguage = (/<html lang="([^"]+)"/.exec(readFileSync(join(DIST, 'index.html'), 'utf8'))?.[1] ?? '')
    .toLowerCase();
  const merged = otherLanguages({ languages: entry.languages }, homeLanguage);
  if (merged.length === 0) {
    return context.skip(
      `the corpus indexes one language, so there is no merged partition to lose — ` +
        'run `pnpm run build:fixture` for the bilingual gate',
    );
  }

  try {
    for (const language of merged) {
      const hash = entry.languages?.[language]?.hash;
      assert.ok(hash !== undefined, `the "${language}" partition declares no index hash`);
      interference = { failPath: `${BUNDLE_PATH_SEGMENT}pagefind.${hash}.pf_meta`, exact: true };

      const page = await browser.newPage();
      try {
        await page.goto(`${origin}/`);
        const failed = await statusMessage(page, 'failed');
        await page.click('#search-toggle');
        await page
          .waitForFunction(
            (sentence) => {
              const text = document.querySelector('#search-status')?.textContent ?? '';
              return text !== '' && text !== sentence;
            },
            await statusMessage(page, 'loading'),
            { timeout: 20_000 },
          )
          .catch(() => undefined);
        const status = (await page.textContent('#search-status')) ?? '';
        assert.ok(
          status !== failed,
          `losing the merged "${language}" index failed the whole search — the reader still has the ` +
            `"${homeLanguage}" index for the page they are on, and partial results beat none`,
        );

        await page.fill('#search-input', PRIMARY_QUERY);
        await page.waitForTimeout(1_500);
        const rows = await page.$$eval('#search-results a', (links) => links.length);
        assert.ok(
          rows > 0,
          `losing the merged "${language}" index left a query for ${JSON.stringify(PRIMARY_QUERY)} with no ` +
            `results, so a broken secondary partition has poisoned the working "${homeLanguage}" one`,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    interference = {};
  }
}, 180_000);

/**
 * The retry the failure message promises actually retries.
 *
 * "press Enter to try again" is a promise made to the reader, and it was a lie in
 * every mode: Pagefind memoises its runtime in a module-scoped variable, so a
 * second attempt reused the same dead object and re-fetched nothing. Measured
 * with the outage healed between attempts — Enter re-announced failure and
 * returned zero rows. The fixes are a `destroy()` before re-initialising and a
 * cache-busted URL for the UI script; this is what stops the message regressing
 * to something the reader cannot act on.
 *
 * The outage is healed *before* the retry, so what is measured is recovery, not
 * that the failure message reappears.
 *
 * **`pagefind.js` itself is deliberately excluded**, and the exclusion is the
 * documented ceiling rather than an oversight. The modular UI imports that exact
 * specifier, so this file must import it unbusted to share one runtime — which is
 * what makes the bilingual `mergeIndex` affect the UI's own searches at all. A
 * browser caches a failed module record for the life of the document, so that one
 * mode needs a page reload. Verified that busting it does fix the retry and does
 * break the merge: the merge landed on a second, separate runtime and a query
 * that had been returning results returned none. The trade is recorded in
 * `loadRuntime` as a `ponytail:` note.
 */
test('the retry offered on failure recovers once the outage clears', async (context) => {
  const browser = requireBrowser(context);
  const entry = JSON.parse(readFileSync(join(DIST, 'pagefind', 'pagefind-entry.json'), 'utf8')) as {
    languages?: Record<string, { hash?: string; wasm?: string | null }>;
  };
  const homeLanguage = (/<html lang="([^"]+)"/.exec(readFileSync(join(DIST, 'index.html'), 'utf8'))?.[1] ?? '')
    .toLowerCase();
  const merged = new Set(otherLanguages({ languages: entry.languages }, homeLanguage));
  const primary = Object.entries(entry.languages ?? {}).find(([name]) => !merged.has(name));
  assert.ok(primary !== undefined, `no index partition serves a "${homeLanguage}" page`);
  const [, index] = primary;

  // The loader, the WebAssembly, and the metadata chunk — three different caches
  // to defeat, each of which failed differently before the fix.
  const outages = [
    `${BUNDLE_PATH_SEGMENT}pagefind-modular-ui.js`,
    `${BUNDLE_PATH_SEGMENT}wasm.${index.wasm ?? 'unknown'}.pagefind`,
    `${BUNDLE_PATH_SEGMENT}pagefind.${index.hash}.pf_meta`,
  ];

  try {
    // The Enter that retries must not be the Enter that closes. The retry
    // handler calls `preventDefault`, and unscoped it also cancelled the Close
    // button's implicit `<form method="dialog">` submission — leaving the only
    // other focusable control in the failed state inert at exactly the moment
    // the dialog was telling the reader to press Enter.
    interference = { failPath: outages[0]!, exact: true };
    const closable = await browser.newPage();
    try {
      await closable.goto(`${origin}/`);
      const failedSentence = await statusMessage(closable, 'failed');
      await closable.click('#search-toggle');
      await closable.waitForFunction(
        (sentence) => document.querySelector('#search-status')?.textContent === sentence,
        failedSentence,
        { timeout: 20_000 },
      );
      await closable.focus('.search-close button');
      await closable.keyboard.press('Enter');
      await closable
        .waitForFunction(() => document.querySelector('dialog')?.open === false, undefined, { timeout: 10_000 })
        .catch(() => assert.fail('in the failed state, Enter on the Close button did not close the dialog'));

      // And the other direction, which the first version of the Close fix broke:
      // Enter must still retry from anywhere else in the dialog. Focus lands on
      // the dialog element itself after a click on any non-focusable part of it,
      // and scoping the retry to the input alone left the reader pressing Enter
      // against a message that promised it would work.
      await closable.click('#search-toggle');
      await closable.waitForFunction(
        (sentence) => document.querySelector('#search-status')?.textContent === sentence,
        failedSentence,
        { timeout: 20_000 },
      );
      //
      // Every status frame is recorded, rather than the `loading` one polled
      // for, and that is a fix rather than a refinement. `loading` is transient
      // and lasts as long as there is index left to fetch: on the published
      // one-note corpus it sits there long enough for `waitForFunction` to
      // sample it, and on the bilingual fixture corpus the merge finishes first
      // so the poll only ever sees the resting state that follows. The gate was
      // racing its own stimulus, and it lost 5 times in 5 under
      // `build:fixture`.
      //
      // Measured rather than inferred: a MutationObserver on this exact flow
      // records `["Loading the search index…", "Type to search this site."]` on
      // the corpus where the poll reported nothing at all — so the retry was
      // firing the whole time.
      //
      // The property asserted is unchanged: Enter with focus on the dialog
      // itself retries, and reaching `loading` is what proves it did. The
      // sentence comes from the page's own locale rather than from an English
      // literal — `Layout.astro` resolves those per document since TK-16.
      const loadingMessage = await statusMessage(closable, 'loading');
      await closable.evaluate(() => {
        const status = document.querySelector('#search-status')!;
        const seen: string[] = [];
        (globalThis as unknown as { retryStates: string[] }).retryStates = seen;
        new MutationObserver(() => seen.push(status.textContent ?? '')).observe(status, {
          characterData: true,
          childList: true,
          subtree: true,
        });
        (document.querySelector('#search-dialog') as HTMLElement).focus();
      });
      await closable.keyboard.press('Enter');
      await closable
        .waitForFunction(
          (text) =>
            (globalThis as unknown as { retryStates: string[] }).retryStates.includes(text),
          loadingMessage,
          { timeout: 10_000 },
        )
        .catch(() =>
          assert.fail('Enter with focus on the dialog itself did not retry, though the message says it would'),
        );
    } finally {
      await closable.close();
    }

    for (const missing of outages) {
      interference = { failPath: missing, exact: true };
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}/`);
        const failed = await statusMessage(page, 'failed');
        await page.click('#search-toggle');
        await page
          .waitForFunction(
            (sentence) => document.querySelector('#search-status')?.textContent === sentence,
            failed,
            { timeout: 20_000 },
          )
          .catch(() => assert.fail(`${missing}: search never reported failure, so there was nothing to retry`));

        interference = {};
        await page.focus('#search-input');
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          (sentence) => document.querySelector('#search-status')?.textContent !== sentence,
          failed,
          { timeout: 20_000 },
        ).catch(() => assert.fail(`${missing}: Enter did not retry after the outage cleared`));

        await page.fill('#search-input', PRIMARY_QUERY);
        await page
          .waitForSelector('#search-results a', { timeout: 20_000 })
          .catch(() =>
            assert.fail(
              `${missing}: the retry reported success but a query for ${JSON.stringify(PRIMARY_QUERY)} ` +
                'returned nothing, so the retry re-used the broken runtime rather than reloading it',
            ),
          );
      } finally {
        await page.close();
      }
    }
  } finally {
    interference = {};
  }
}, 240_000);

/**
 * The full keyboard flow, including focus restoration.
 *
 * Requirements section 17 requires a dialog focus trap and restoration; the
 * ticket adds arrow-key result navigation and a documented shortcut. Every step
 * here is driven through the keyboard alone — clicking the trigger and then
 * asserting focus would skip the part a keyboard reader actually depends on.
 */
test('search is fully operable from the keyboard', async (context) => {
  const browser = requireBrowser(context);
  const page = await browser.newPage();
  const failures = collectFailures(page);
  try {
    await page.goto(`${origin}/`);

    // The shortcut opens the dialog and puts the caret in the field.
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === true, undefined, { timeout: 10_000 });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'search-input', 'the field is not focused');
    // The slash that opened the dialog must not also be typed into the field.
    assert.equal(await page.inputValue('#search-input'), '', 'the shortcut key was typed into the field');

    await page.waitForFunction(
      (sentence) => document.querySelector('#search-status')?.textContent !== sentence,
      await statusMessage(page, 'loading'),
      { timeout: 20_000 },
    );
    await page.fill('#search-input', PRIMARY_QUERY);
    await page.waitForSelector('#search-results a', { timeout: 20_000 });

    // Down enters the list; up from the first returns to the field rather than
    // wrapping to the last result. Asserted by *containment*, not by "the focused
    // element has an href" — every result is a link, so an href-only check passes
    // for any focused link anywhere on the page, and `?.` on nothing focused
    // yields `undefined`, which is not `null`, so it would pass for that too.
    await page.keyboard.press('ArrowDown');
    assert.ok(
      await page.evaluate(() => {
        const active = document.activeElement;
        return active !== null && document.querySelector('#search-results')?.contains(active) === true;
      }),
      'ArrowDown did not move focus into the results',
    );
    await page.keyboard.press('ArrowUp');
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'search-input',
      'ArrowUp from the first result did not return to the field',
    );

    // The trap: focus never leaves the dialog, however many times Tab is pressed.
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => document.querySelector('#search-dialog')?.contains(document.activeElement));
      assert.ok(inside, `focus left the dialog after ${press + 1} Tab presses`);
    }

    // Escape closes, and focus returns to the control that opened it — the
    // property a keyboard reader loses most often, because it strands them at
    // the top of the document with no idea where they were.
    //
    // Waited for rather than sampled. `dialog.open` flips synchronously inside
    // the browser's own close steps, while the `close` event that restores focus
    // is dispatched afterwards, so reading `activeElement` the instant `open`
    // goes false is a race — measured, it caught the pre-restoration state on
    // one run in five. The wait is on the property under test, so a genuine
    // regression still fails here rather than timing out somewhere else.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === false, undefined, { timeout: 10_000 });
    await page.waitForFunction(() => document.activeElement?.id === 'search-toggle', undefined, { timeout: 10_000 }).catch(
      () => assert.fail('focus was not restored to the trigger after the dialog closed'),
    );

    // The shortcut must not fire while the reader is typing into a field, and
    // must not swallow the slash they meant to type.
    //
    // Driven with real key events on a field *outside* the dialog. `page.fill`
    // dispatches no `keydown` at all, and with the dialog already open the
    // handler returns on `dialog.open` before `isTypingTarget` is ever reached —
    // so the obvious version of this test passes for two reasons that have
    // nothing to do with the behaviour under test. A field is grafted onto the
    // page because no route ships one; what is being checked is the handler's
    // guard, not the site's forms.
    await page.evaluate(() => {
      const field = document.createElement('input');
      field.id = 'typing-probe';
      document.querySelector('main')?.append(field);
      field.focus();
    });
    await page.keyboard.type('a/b');
    assert.equal(
      await page.inputValue('#typing-probe'),
      'a/b',
      'a slash typed into a text field was swallowed by the search shortcut',
    );
    assert.equal(
      await page.evaluate(() => document.querySelector('dialog')?.open),
      false,
      'the search shortcut fired while the reader was typing into a field',
    );

    // And it does still fire when the reader is not typing — the pairing matters
    // as much as either half, since a guard that never lets the shortcut through
    // would satisfy the assertion above.
    await page.evaluate(() => (document.querySelector('#typing-probe') as HTMLElement).blur());
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === true, undefined, { timeout: 10_000 });

    assert.deepEqual(failures, [], 'the page reported errors during the keyboard flow');
  } finally {
    await page.close();
  }
}, 180_000);

/**
 * Every indexed language is reachable from every page.
 *
 * The defect: Pagefind partitions by `<html lang>` and queries one partition, so
 * a bilingual corpus is two disjoint search engines that each report the other's
 * pages as absent. This drives the real thing rather than asserting `mergeIndex`
 * was called, because the call has a silent failure mode — a relative bundle
 * path is rejected as same-as-primary and logged, not thrown, so a merge that
 * never happened looks exactly like one that did.
 *
 * The assertion is that a query run from a page in one language returns a result
 * belonging to *another* language's partition. Nothing weaker would do: matching
 * the query against results in the page's own language is what a broken build
 * already does.
 *
 * Skipped on a corpus with one language: `pnpm test` runs against the published
 * one-note artifact, and only `pnpm run build:fixture` has both.
 */
test('a query reaches every indexed language from any page', async (context) => {
  const browser = requireBrowser(context);
  const entry = JSON.parse(readFileSync(join(DIST, 'pagefind', 'pagefind-entry.json'), 'utf8')) as {
    languages?: Record<string, unknown>;
  };
  const languages = Object.keys(entry.languages ?? {});
  if (languages.length < 2) {
    return context.skip(
      `the corpus has ${languages.length} indexed language — run \`pnpm run build:fixture\` for the bilingual gate`,
    );
  }

  /** Each note route, and the language its page declares. */
  const languageByRoute = new Map<string, string>();
  for (const file of requirePages()) {
    const language = /<html lang="([^"]+)"/.exec(readFileSync(file, 'utf8'))?.[1]?.toLowerCase();
    if (language === undefined) continue;
    languageByRoute.set(routeOf(file), language);
  }

  /** One page to search *from*, per language. */
  const pageByLanguage = new Map<string, string>();
  for (const [route, language] of languageByRoute) {
    if (route.startsWith('/notes/') && !pageByLanguage.has(language)) pageByLanguage.set(language, route);
  }
  assert.ok(pageByLanguage.size >= 2, 'the fixture corpus does not carry a note page in two languages');

  const page = await browser.newPage();
  try {
    for (const [from, route] of pageByLanguage) {
      await page.goto(`${origin}${route}`);
      await openSearch(page);

      // A single letter of each script. What matters is not which pages match
      // but that pages from a *foreign* partition can appear at all.
      const reachedLanguages = new Set<string>();
      for (const term of ['e', '的', 'a', '一']) {
        await page.fill('#search-input', '');
        await page.fill('#search-input', term);
        // Pagefind debounces at 300 ms; this waits past that plus the query.
        await page.waitForTimeout(700);
        const hrefs = await page.$$eval('#search-results a', (links) =>
          links.map((link) => link.getAttribute('href') ?? ''),
        );
        for (const href of hrefs) {
          // Pagefind returns whatever `meta.url` holds, which the browser
          // resolves — so compare pathnames rather than raw hrefs.
          const path = new URL(href, `${origin}${route}`).pathname;
          assert.match(path, /^\/notes\//, `${route}: a result left the note routes: ${href}`);
          const language = languageByRoute.get(path);
          if (language !== undefined) reachedLanguages.add(language);
        }
      }

      const foreign = [...reachedLanguages].filter((language) => language !== from);
      assert.ok(
        foreign.length > 0,
        `searching from a "${from}" page (${route}) reached only "${from}" pages — the other language ` +
          `partition was not merged, so every note in it is unfindable from here. Reached: ` +
          `${JSON.stringify([...reachedLanguages])}`,
      );
    }
  } finally {
    await page.close();
  }
}, 240_000);

/**
 * A note page's own route is findable by a word from its body.
 *
 * The end-to-end property behind every gate above: the index contains published
 * pages, the excerpt is drawn from the sanitized article, and the result links
 * back to a route that exists. `anyNoteRoute` picks a real note rather than a
 * fixed slug so the gate survives a corpus change.
 */
test('a result excerpt carries public body text and links to a real route', async (context) => {
  const browser = requireBrowser(context);
  const page = await browser.newPage();
  try {
    const route = anyNoteRoute();
    await page.goto(`${origin}${route}`);
    // A word certain to be in an article body on both corpora.
    await openSearch(page);
    await page.fill('#search-input', 'the');
    await page.waitForSelector('#search-results a', { timeout: 20_000 });

    const excerpts = await page.$$eval('.pagefind-modular-list-excerpt', (nodes) =>
      nodes.map((node) => node.textContent ?? ''),
    );
    assert.ok(excerpts.length > 0, 'no result rendered an excerpt');
    for (const excerpt of excerpts) {
      // The privacy properties the residue scan enforces over `dist/`, restated
      // for the one string the search UI puts on screen that no other gate sees.
      assert.ok(!excerpt.includes('msw/'), `an excerpt carries a private marker: ${excerpt}`);
      assert.ok(!excerpt.includes('[['), `an excerpt carries an unresolved wikilink: ${excerpt}`);
      assert.ok(!/[A-Za-z]:\\/.test(excerpt), `an excerpt carries a local path: ${excerpt}`);
      // The dialog's own chrome must never appear in an excerpt: it is on every
      // page, so if `data-pagefind-ignore` ever came off, every result would
      // open with it.
      assert.ok(!excerpt.includes('Close search'), `an excerpt carries the dialog chrome: ${excerpt}`);
    }
  } finally {
    await page.close();
  }
}, 120_000);
