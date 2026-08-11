/**
 * Search dialog.
 *
 * Requirements section 11.4 and ticket TK-06. TK-12 made search *run* — it added
 * `'wasm-unsafe-eval'` to `script-src`, without which Pagefind's WebAssembly
 * never compiled. This file is the second half: the supported UI, the keyboard
 * contract section 17 requires, and three load states told apart.
 *
 * **Why the modular UI rather than the Default UI.** The Default UI is
 * deprecated and costs 29,579 B gzip; `pagefind-modular-ui.js` is 4,265 B and
 * was already sitting in `dist/` unused. Nothing here hand-rolls a result
 * renderer to save the remaining 4 KB — the parity plan §7.3 rejects that
 * outright, and writing our own keyboard navigation and excerpt markup would
 * cost more than it saves.
 *
 * **Everything loads on first open.** Not on first paint, not on hover — the
 * gate in `tests/built-output.test.ts` proves no page requests a `/pagefind/`
 * asset before the reader asks, which is the one budget assertion Quartz
 * structurally cannot pass.
 */

/* This file is a module — `otherLanguages` below is exported, and that is what
   gives it its own top-level scope. TK-06 and TK-07 can each declare `dialog`
   or `trigger` without colliding, because Astro concatenates these scripts into
   one bundle and a script without a top-level export would share that scope.
   TK-12 held the scope open with a bare `export {}`; a real export replaced it. */

/** Where the Pagefind bundle lives, as both a `<link>` href and an import base. */
const BUNDLE_PATH = '/pagefind/';

/**
 * The documented shortcut, matched on `event.key`.
 *
 * `/` rather than the more fashionable `Ctrl-K`: it needs no modifier, it is
 * what the trigger's own accessible name announces, and it collides with no
 * browser or screen-reader binding. It is suppressed while the reader is typing
 * — see `isTypingTarget` — because a reader filling in a field expects a slash.
 */
const SHORTCUT_KEY = '/';

/**
 * How long a secondary-language merge may take before it is abandoned.
 *
 * Generous, because it is not a performance budget: it exists only so a merge
 * that *hangs* rather than fails cannot hold the dialog on "Loading" over an
 * index that already works. Pagefind waits on internal state in `while` loops
 * with no timeout of its own, so this is the only bound there is.
 */
const MERGE_TIMEOUT_MS = 10_000;

/** Reject if `work` has not settled within `limit`, leaving `work` to its fate. */
function withTimeout<T>(work: Promise<T>, limit: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), limit)),
  ]);
}

/** Elements that swallow the shortcut: a slash typed into one of these is a slash. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** Append a same-origin `<link>` or `<script>` and resolve when it has loaded. */
function load(element: HTMLLinkElement | HTMLScriptElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = element.getAttribute('href') ?? element.getAttribute('src');
    element.addEventListener('load', () => resolve(), { once: true });
    element.addEventListener('error', () => reject(new Error(`failed to load ${source}`)), { once: true });
    document.head.append(element);
  });
}

/** The subset of the modular UI this file drives. */
interface PagefindInstance {
  add(component: unknown): void;
  on(event: 'results' | 'filters', handler: (payload: unknown) => void): void;
  triggerSearch(term: string): void;
}

interface ModularUI {
  Instance: new (options: Record<string, unknown>) => PagefindInstance;
  Input: new (options: Record<string, unknown>) => unknown;
  ResultList: new (options: Record<string, unknown>) => unknown;
  FilterPills: new (options: Record<string, unknown>) => unknown;
}

/** Pagefind's per-language partitioning, as `pagefind-entry.json` declares it. */
interface PagefindEntry {
  languages?: Record<string, { hash?: string; page_count?: number }>;
}

/**
 * The partition Pagefind will load for this document, by its own rule.
 *
 * Mirrors `findIndex` in `pagefind.js` exactly, and the order is the whole
 * point: an exact match on the full lowercased tag first, then the base subtag,
 * then — when neither exists — the partition with the most pages. Getting this
 * wrong in either direction is a real defect rather than a nicety, because it
 * decides which partition must *not* be merged.
 */
function primaryLanguage(entry: PagefindEntry, documentLanguage: string): string | undefined {
  const languages = entry.languages ?? {};
  const own = documentLanguage.toLowerCase();
  if (own in languages) return own;

  const base = own.split('-')[0]!;
  if (base in languages) return base;

  // Pagefind's own fallback when the document's language is indexed under
  // neither form: the largest partition becomes primary.
  let largest: string | undefined;
  for (const [language, index] of Object.entries(languages)) {
    if (largest === undefined || (index.page_count ?? 0) > (languages[largest]?.page_count ?? 0)) {
      largest = language;
    }
  }
  return largest;
}

/**
 * Every indexed partition except the one Pagefind has already loaded.
 *
 * Two failures live in the difference between this and the obvious prefix test,
 * and both were measured against real `pagefind` output:
 *
 * - **A sibling region tag is a separate partition.** Pagefind keys partitions on
 *   the exact lowercased `<html lang>`, so `en` and `en-gb` are two indexes with
 *   two hashes. A bidirectional prefix test excludes each from the other, and
 *   neither is ever merged — so on a corpus carrying both, half the notes stay
 *   unfindable, which is the exact defect this whole function exists to close.
 *   The base-subtag rule is only Pagefind's *fallback*, applied when no exact
 *   match exists; treating it as an equivalence is what hides the sibling.
 * - **A document whose language is indexed under no form merges the index onto
 *   itself.** `<html lang="fr">` against an `en`-only index makes `en` primary by
 *   Pagefind's largest-partition fallback — and a prefix test would also report
 *   `en` as "other", so every result appeared twice, once per URL form. The
 *   artifact's `language` is a free-form tag, so one note in a third language is
 *   all it takes.
 *
 * Deriving the exclusion from `primaryLanguage` rather than from string shape
 * makes both cases fall out of the same rule Pagefind is using.
 */
export function otherLanguages(entry: PagefindEntry, documentLanguage: string): string[] {
  const primary = primaryLanguage(entry, documentLanguage);
  return Object.keys(entry.languages ?? {}).filter((language) => language !== primary);
}

/**
 * The `mergeIndex` entries that make the *other* languages searchable.
 *
 * **The bilingual defect this closes.** Pagefind auto-partitions its index by
 * `<html lang>` and at query time loads exactly one partition — the current
 * document's. On a bilingual corpus that means every English note is unfindable
 * from a Chinese page and every Chinese note is unfindable from an English one,
 * in both directions, with no error and no empty-state distinction: the reader
 * is told "no results" about a note that exists.
 *
 * **The absolute URL is load-bearing.** Pagefind refuses a merge whose path is a
 * prefix of the primary index's path — the guard that stops a site merging
 * itself — and the primary path here *is* `/pagefind/`. Passing the relative
 * path logs "Skipping mergeIndex /pagefind/ that appears to be the same as the
 * primary index" and leaves the other language unsearchable, which from the
 * outside looks exactly like success. An absolute URL is not a prefix of
 * `/pagefind/`, so the merge proceeds against the very same files. Verified in a
 * browser in both directions against the 32-note bilingual fixture corpus.
 *
 * **Each partition is proven reachable before it is merged, and that is a
 * correctness requirement rather than an optimisation.** `mergeIndex` pushes its
 * new instance onto Pagefind's instance list *synchronously*, before its first
 * await, and every later `search()` flat-maps across that list. There is no way
 * to remove one. So a partition whose own metadata chunk 404s does not merely
 * fail to contribute results — it poisons the working primary index for the rest
 * of the page's life. Measured on the fixture corpus: with the `zh-cn` metadata
 * chunk returning 503, an English query on an English page returned **zero**
 * results while the status line read "Type to search this site", and the console
 * carried an uncaught "WASM Error (No pointer)". Catching the merge's rejection
 * does not help, because the damage is done before it rejects. Fetching the one
 * chunk first is the only point at which the decision is still reversible.
 *
 * Pagefind's documentation records that a merged index is queried using the
 * *primary* index's language support, so CJK segmentation could in principle
 * depend on which page the reader searched from. Measured on this corpus it does
 * not: `设计`, `花园`, `排版`, and `设计笔记` return the same pages from an
 * English page as from a Chinese one. The caveat is recorded because it is the
 * corpus that makes it harmless, not this code.
 */
async function mergeEntries(): Promise<{ bundlePath: string; language: string }[]> {
  // Every fetch here is bounded. Nothing in this function is required for the
  // page's own index to work, so a request that *hangs* rather than fails must
  // not hold the dialog on "Loading" — which is worse than a plain failure,
  // because the state never reaches `failed` and the Enter-retry is dead with
  // it. `AbortSignal.timeout` rejects the fetch itself rather than merely
  // abandoning a promise, so the connection is dropped too.
  const bounded = (url: string): Promise<Response> =>
    fetch(url, { signal: AbortSignal.timeout(MERGE_TIMEOUT_MS) });

  try {
    const response = await bounded(`${BUNDLE_PATH}pagefind-entry.json`);
    if (!response.ok) return [];
    const entry = (await response.json()) as PagefindEntry;
    const bundlePath = new URL(BUNDLE_PATH, location.href).href;
    const wanted = otherLanguages(entry, document.documentElement.lang);

    const reachable = await Promise.all(
      wanted.map(async (language) => {
        const hash = entry.languages?.[language]?.hash;
        if (hash === undefined) return undefined;
        try {
          const meta = await bounded(`${BUNDLE_PATH}pagefind.${hash}.pf_meta`);
          return meta.ok ? { bundlePath, language } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return reachable.filter((entryOrNot) => entryOrNot !== undefined);
  } catch {
    // One language's worth of results beats none: the reader still has the index
    // for the page they are on. This is why the failure is swallowed here rather
    // than propagating into the `failed` state.
    return [];
  }
}

/**
 * Prove the search runtime is actually reachable, before any UI is built.
 *
 * **This is the difference between a failure state and a lie.** Pagefind's own
 * loader catches a failed `import('/pagefind/pagefind.js')`, logs it, and carries
 * on to call `.options()` on `undefined` — so the error surfaces as an uncaught
 * `TypeError` from inside a promise this file never sees, the dialog sits on
 * "Loading the search index…" forever, and the reader is told to wait for
 * something that will never arrive. Awaiting only the modular-UI script is not
 * enough, because that script loads fine; it is the runtime it pulls in
 * afterwards that fails. Measured against the real build: with only
 * `/pagefind/pagefind.js` returning 503, the status line never left "Loading"
 * and the Enter-retry was dead, because `isMounted` was already true.
 *
 * The same is true one layer down, and worse. A working `pagefind.js` whose
 * WebAssembly is missing or corrupt does **not** fail `init()`: Pagefind records
 * the error and resolves anyway, rethrowing only when something first needs the
 * index. Verified by serving a 503 for `wasm.en.pagefind` — `options()` and
 * `init()` both resolved, and the reader was shown "Type to search this site"
 * over an index that could never answer. A 503 on the metadata chunk behaves the
 * same way, failing later with "WASM Error (No pointer)".
 *
 * So the runtime is imported *and exercised* here, where a rejection is a value
 * this file can act on. `filters()` is the cheapest call that reaches the index —
 * measured to reject on both failure modes above — and its result is needed
 * anyway to decide which filter pills to build, so proving the index works costs
 * nothing extra.
 *
 * `init()`'s own rejection is swallowed rather than propagated, and that is not
 * laziness: Pagefind rejects the *same* WebAssembly failure from both `init()`
 * and the next real call, so letting both surface would report one fault twice —
 * once here and once as an unhandled rejection in the console of a page the site
 * requires to stay clean. The later rejection is the one that carries the fault
 * for every mode, including the two where `init()` resolves regardless, so it is
 * the one worth keeping.
 *
 * **`destroy()` before re-initialising, which is what makes a retry real.**
 * Pagefind memoises its wrapper in a module-scoped `var`, so a second `import()`
 * hands back the same object with the same dead state; `destroy()` clears it and
 * the next call rebuilds and re-fetches. It is a no-op on the first attempt.
 *
 * **The specifier is deliberately *not* cache-busted, and that is load-bearing.**
 * The modular UI imports `${bundlePath}pagefind.js` itself, so this file and the
 * UI share one module record and therefore one runtime — which is precisely why a
 * `mergeIndex` performed here changes what the UI's own `search()` returns. Adding
 * a query string here creates a second, separate module: measured, the merge then
 * landed on this file's copy while the UI searched its own, and a query that had
 * been returning results returned none.
 *
 * ponytail: the cost is that a failed *fetch* of `pagefind.js` cannot be retried
 * within the page — a browser caches a failed module record for the life of the
 * document, so the retry re-throws without touching the network. The other three
 * failure modes (the UI script, the WebAssembly, the metadata chunk) all recover,
 * and this one is one reload away. Making it recover would mean giving up the
 * shared runtime, which costs the bilingual merge — a working feature traded for
 * a rarer recovery. Revisit only if Pagefind exposes an injectable runtime.
 */
async function loadRuntime(): Promise<PagefindRuntime> {
  const runtime = (await import(/* @vite-ignore */ `${BUNDLE_PATH}pagefind.js`)) as PagefindRuntime;
  await runtime.destroy().catch(() => undefined);
  await runtime.options({});
  await runtime.init().catch(() => undefined);
  return runtime;
}

/** The subset of Pagefind's core API this file drives. */
interface PagefindRuntime {
  options(options: Record<string, unknown>): Promise<void>;
  init(): Promise<void>;
  destroy(): Promise<void>;
  mergeIndex(path: string, options: Record<string, unknown>): Promise<void>;
  filters(): Promise<Record<string, Record<string, number>>>;
}

/**
 * The filter regions the dialog reserves.
 *
 * `selectMultiple` reflects the artifact: a note carries several tags, so those
 * combine, and at most one collection, so those are exclusive. Each entry is
 * spread straight into `FilterPills`, which takes exactly these three keys.
 */
const FILTER_REGIONS = [
  { filter: 'tag', containerElement: '#search-filter-tag', selectMultiple: true },
  { filter: 'collection', containerElement: '#search-filter-collection', selectMultiple: false },
] as const;

/**
 * The `dataset` key holding each announceable state's sentence.
 *
 * Written out rather than derived from the state name: `dataset['messageIdle']`
 * is `data-message-idle` in the markup, and nothing but this table records that
 * the two are meant to be the same thing.
 *
 * It is not a type error if one side is misspelled — `dataset[k]` is
 * `string | undefined` for any `k`, so the status line would simply go blank.
 * What makes the pairing checkable is the gate over `dist/`:
 * `tests/built-routes.test.ts` asserts every attribute named here is present and
 * non-empty on every built page. `preferences.ts` carries the same table for the
 * same reason and is covered by the same gate.
 */
const MESSAGE_DATASET = {
  idle: 'messageIdle',
  loading: 'messageLoading',
  empty: 'messageEmpty',
  failed: 'messageFailed',
} as const;

/**
 * `globalThis.document?.` rather than a bare `document.`: this module exports
 * `otherLanguages`, and `tests/search.test.ts` imports it under Node to check
 * the region-tag cases a browser gate cannot reach without a third fixture
 * language. In a browser `document` always exists, so the optional chain never
 * short-circuits there and every branch below is unchanged; under Node it
 * yields `undefined` and the whole setup block is skipped, which is exactly what
 * a module with no DOM should do.
 */
const trigger = globalThis.document?.querySelector<HTMLButtonElement>('#search-toggle');
const dialog = globalThis.document?.querySelector<HTMLDialogElement>('#search-dialog');

if (trigger != null && dialog != null) {
  const status = document.querySelector<HTMLElement>('#search-status');
  const results = document.querySelector<HTMLElement>('#search-results');
  const input = document.querySelector<HTMLInputElement>('#search-input');
  /** The one control inside the dialog whose Enter must stay the browser's. */
  const closeButton = dialog.querySelector<HTMLButtonElement>('.search-close button');

  /**
   * The states the ticket requires be told apart.
   *
   * Collapsing `loading` into `empty` is the mistake this type exists to
   * prevent: "no results" while the index is still downloading is a false
   * statement about the corpus, and "no results" when the index failed to load
   * is a lie the reader cannot act on. Each renders its own sentence, and only
   * `failed` offers a retry.
   */
  type State = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

  let state: State = 'idle';
  let loading: Promise<{ ui: ModularUI; runtime: PagefindRuntime }> | undefined;
  let isMounted = false;
  /** How many times the bundle has been asked for; 0 is the ordinary first load. */
  let attempt = 0;

  /**
   * Announce a state, in the language of the document the dialog is on.
   *
   * The four sentences are read off `#search-status`'s own `data-message-*`
   * attributes, which `Layout.astro` filled from the translation resolved for
   * this document. That is what makes the search dialog bilingual at zero added
   * bytes: a locale table in this bundle would put every language on the wire
   * for every reader, to say what the build already knew — and it would grow
   * with each language, on a script that ships on every page.
   *
   * `ready` is not among them: results are on screen and the list is the
   * message, so a sentence there would sit above the rows contradicting them.
   * It is the empty string, and it is the only state that is.
   *
   * `textContent`, never `innerHTML`: this is a live region, and what goes into
   * it is now attribute text rather than a literal in this file — so it stays
   * data throughout. The strings are chrome the build authored rather than
   * artifact content, but the rule does not depend on that being true.
   */
  function announce(next: State): void {
    state = next;
    if (status === null) return;
    status.textContent = next === 'ready' ? '' : (status.dataset[MESSAGE_DATASET[next]] ?? '');
  }

  /**
   * Fetch the modular UI bundle and its stylesheet.
   *
   * Deliberately not `async`, which `astro check` suggests as hint ts(80006) and
   * which would be wrong here: an async function's body runs when it is called,
   * so `loading ??= fetchBundle()` would have started the fetch before the
   * assignment landed, and two opens in the same tick would each append their
   * own `<link>` and `<script>`. Returning the promise from a synchronous call
   * keeps the start atomic with the memoisation. The hint is the only one this
   * repository carries; it is recorded here rather than silenced.
   *
   * The stylesheet is awaited so the first frame is not unstyled, but its
   * failure is **not** fatal: the script is what search needs, and refusing to
   * mount a working index because its CSS 404'd would tell the reader search is
   * broken when it works.
   *
   * `attempt` cache-busts a retry: a script the browser already failed to fetch
   * stays failed for the life of the document unless the URL differs. It is empty
   * on the first load, so the ordinary request is a plain one the CDN caches
   * normally. The `<script>` left by a failed attempt stays in the head — it
   * executed nothing, and removing a script element does not unload it anyway.
   *
   * `pagefind.js` deliberately does *not* get the same treatment; `loadRuntime`
   * records why, and it is the reason that one failure mode needs a page reload.
   */
  const fetchBundle = (): Promise<{ ui: ModularUI; runtime: PagefindRuntime }> => {
    const cacheBust = attempt === 0 ? '' : `?retry=${attempt}`;
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = `${BUNDLE_PATH}pagefind-modular-ui.css${cacheBust}`;
    const script = document.createElement('script');
    script.src = `${BUNDLE_PATH}pagefind-modular-ui.js${cacheBust}`;
    const styled = load(stylesheet).catch(() => undefined);
    // The runtime is loaded alongside the UI rather than left to Pagefind, and
    // both are awaited: see `loadRuntime` for why a failure there is otherwise
    // invisible. They start together because neither needs the other.
    return Promise.all([load(script), loadRuntime(), styled]).then(([, runtime]) => {
      const ui = (window as typeof window & { PagefindModularUI?: ModularUI }).PagefindModularUI;
      if (ui === undefined) throw new Error('the Pagefind bundle loaded but exposed no modular UI');
      return { ui, runtime };
    });
  };

  /**
   * Build the search UI into the dialog's regions.
   *
   * `Input` is handed the existing `<input>` rather than a container, so the
   * markup keeps its own `<label>` and the element the dialog focuses on open is
   * the element Pagefind drives. Letting Pagefind mint the field instead would
   * put an `action="javascript:void(0);"` form into a document whose CSP sets
   * `form-action 'none'`, and would replace a labelled control with one whose
   * label is a `data-` attribute.
   *
   * `showImages: false` because no artifact field carries a per-result image;
   * leaving it on renders an empty thumbnail box beside every result.
   *
   * **Filter pills are added only once the index proves it has values for them**,
   * and that is a bug fix rather than an optimisation. `FilterPills` initialises
   * its `available` to `{}` and replaces it with an array only on a `filters`
   * event carrying its own key; when the key is absent it logs a warning,
   * returns early, and leaves `available` an object — after which `update()`
   * calls `this.available.map` and throws. The throw lands inside Pagefind's
   * synchronous hook dispatch, which aborts the rest of the hook list: on a
   * corpus with no tags, the pills crash took out the `results` handler
   * registered after it and the reader never saw the "no results" state at all.
   * One unpopulated filter silently disabled the whole state machine.
   *
   * Registering from inside the `filters` event is what makes the ticket's
   * "when those fields exist" conditional real: the artifact's `tags` and
   * `collection` are both optional, the published corpus has neither, and the
   * fixture corpus has both.
   *
   * **Pagefind's `loading` event is deliberately not subscribed to.** It fires at
   * the top of every `__search__`, not only while the index is downloading — so
   * mapping it to the `loading` state made "Loading the search index…" flash on
   * every keystroke, long after the index was loaded. That is the load-state
   * machine lying in the other direction, and it is why the `loading` state is
   * driven only by `ensureMounted`, which is the only place an index is ever
   * actually being fetched.
   */
  function mount(ui: ModularUI, filters: Record<string, Record<string, number>>): PagefindInstance {
    const instance = new ui.Instance({
      bundlePath: BUNDLE_PATH,
      // Pagefind escapes everything in an excerpt except its own `<mark>`, and
      // the excerpt is drawn from `data-pagefind-body` — the sanitized article —
      // so it can only ever be public text. Verified against a body containing a
      // literal `<img onerror=…>`: it comes back entity-encoded.
      excerptLength: 24,
    });
    instance.add(new ui.Input({ inputElement: '#search-input' }));
    instance.add(new ui.ResultList({ containerElement: '#search-results', showImages: false }));
    for (const region of FILTER_REGIONS) {
      if (Object.keys(filters[region.filter] ?? {}).length === 0) continue;
      // ponytail: Pagefind writes this component's own two strings itself — an
      // sr-only "Filter results by <filter>" label and an "All" pill — and they
      // are English literals inside its bundle, with no option to supply them.
      // So a pill that mounted on a zh-CN page would carry English chrome the
      // TK-16 contract cannot reach. Not reachable today and measured, not
      // assumed: `pagefind` reports "Indexed 0 filters" on both corpora, because
      // nothing in the built HTML carries `data-pagefind-filter`, so this branch
      // never runs. It becomes live the moment a ticket adds that attribute —
      // at which point the fix is to relabel the two nodes after mounting, or to
      // render the pills from the artifact's own facets rather than from
      // Pagefind's.
      instance.add(new ui.FilterPills({ ...region }));
    }
    return instance;
  }

  /**
   * Load, merge, and mount — once per page, and retried after a failure.
   *
   * The `isMounted` re-check after the await is not redundant with the one
   * before it: two opens during a single in-flight load both pass the cheap
   * check at the top and both resume here, and the second would build a second
   * search UI into the same elements.
   */
  async function ensureMounted(): Promise<void> {
    if (isMounted) return;
    announce('loading');
    try {
      // `loading` is cleared on failure, so a `??=` that assigns here is exactly
      // a retry — and the counter it reads is what makes that retry re-fetch
      // rather than replay a cached failure.
      if (loading === undefined) {
        loading = fetchBundle();
        attempt += 1;
      }
      const [{ ui, runtime }, mergeIndex] = await Promise.all([loading, mergeEntries()]);
      // The call that proves the page's own index can actually answer — see
      // `loadRuntime`. It runs *before* any merge, and that order is
      // load-bearing rather than tidy: Pagefind's `mergeIndex` waits on the
      // primary index's WebAssembly in an unbounded `while (wasm === null)`
      // loop, so merging onto a primary whose WebAssembly failed never resolves
      // and never rejects. The dialog would sit on "Loading the search index…"
      // for the life of the page. Validating first turns that hang into the
      // failure state, which is a sentence the reader can act on.
      //
      // Bounded for the same reason, one layer down. Pagefind's `getPtr` spins
      // `while (raw_ptr === null)` and its own fetches carry no abort signal, so
      // a chunk that is *accepted and never answered* — a stalled connection
      // rather than a 503 — leaves this promise permanently pending. Measured:
      // holding the WebAssembly chunk open left the status on "Loading the
      // search index…" past 45 s with a dead retry, because `loading` never
      // settles and `ensureMounted` awaits it forever. The timeout is what makes
      // that a `failed` state the reader can retry out of.
      //
      // The result is also what decides which filter pills exist, so proving the
      // index works asks nothing of Pagefind twice.
      let filters = await withTimeout(runtime.filters(), MERGE_TIMEOUT_MS);

      // Merged onto the runtime this file loaded, rather than passed to the UI
      // as a constructor option: the UI would import a *second* copy of
      // `pagefind.js` and merge into that one, leaving the copy whose failure
      // `loadRuntime` can actually see doing nothing.
      let hasMerged = false;
      for (const entry of mergeIndex) {
        const { bundlePath, ...options } = entry;
        // Not fatal, and deliberately so: the reader still has the index for the
        // page they are on, and one language's worth of results beats none. Only
        // the *primary* index's failure above is fatal.
        //
        // Bounded rather than merely caught. A merge whose own assets 404 can
        // hang inside Pagefind rather than reject, and an unbounded await on it
        // would hold the whole dialog on "Loading" over a search that is
        // already working — the enhancement blocking the feature it enhances.
        await withTimeout(runtime.mergeIndex(bundlePath, options), MERGE_TIMEOUT_MS)
          .then(() => {
            hasMerged = true;
          })
          .catch(() => undefined);
      }
      // A merge contributes its own filter values, so the pills are decided
      // after the last one rather than before the first.
      if (hasMerged) filters = await runtime.filters().catch(() => filters);
      if (isMounted) return;
      // Set before constructing rather than after: if the constructor throws,
      // the catch resets it, so a genuine failure still retries while a
      // concurrent resume cannot slip past.
      isMounted = true;
      const instance = mount(ui, filters);

      instance.on('results', (payload: unknown) => {
        const found = (payload as { results?: unknown[] } | undefined)?.results?.length ?? 0;
        // An empty field is the reader having cleared it, not a corpus with
        // nothing in it. `idle` says so; `empty` would accuse the site.
        if (input !== null && input.value.trim() === '') announce('idle');
        else announce(found === 0 ? 'empty' : 'ready');
      });

      announce('idle');
      // A query typed while the bundle was still downloading. Pagefind's `Input`
      // component only binds its listener when it is constructed, so anything
      // already in the field was never searched — the reader would be looking at
      // their own query above an empty list and the words "Type to search this
      // site", which is the same class of lie as collapsing the load states.
      // Measured: typing during a 2.5 s delayed bundle left the field full and
      // the results empty for as long as the dialog stayed open.
      const pending = input?.value.trim() ?? '';
      if (pending !== '') instance.triggerSearch(pending);
    } catch {
      // An unhandled rejection here would be a console error on a page that is
      // otherwise clean, and the reader would be left looking at an empty dialog
      // with no explanation. Clearing `loading` is what makes the next attempt a
      // real retry rather than an await on the promise that already rejected.
      loading = undefined;
      isMounted = false;
      results?.replaceChildren();
      announce('failed');
    }
  }

  /**
   * Move focus through the result links.
   *
   * The results are a list of links, so the arrow keys move *focus* rather than
   * maintaining a parallel `aria-activedescendant`: focus is what `Enter`
   * already follows, what the browser already scrolls into view, and what a
   * screen reader already announces.
   *
   * From the input, `ArrowDown` enters the list; from the first result, `ArrowUp`
   * returns to the input rather than wrapping to the last, because the input is
   * where a reader wants to be when they change their mind about the query.
   */
  function moveSelection(step: number): void {
    const links = [...dialog!.querySelectorAll<HTMLAnchorElement>('#search-results a')];
    if (links.length === 0) return;
    const current = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (current === -1) {
      (step > 0 ? links[0] : links[links.length - 1])?.focus();
      return;
    }
    const next = current + step;
    if (next < 0) input?.focus();
    else links[Math.min(next, links.length - 1)]?.focus();
  }

  /** Focusable elements inside the dialog, in tab order. */
  function focusables(): HTMLElement[] {
    return [
      ...dialog!.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.offsetParent !== null || element === document.activeElement);
  }

  function open(): void {
    if (dialog!.open) return;
    // `showModal` puts the dialog in the top layer, which makes the rest of the
    // document inert and gives `Escape` its close behaviour without a handler.
    dialog!.showModal();
    input?.focus();
    void ensureMounted();
  }

  trigger.addEventListener('click', open);

  document.addEventListener('keydown', (event) => {
    if (event.key !== SHORTCUT_KEY || event.ctrlKey || event.metaKey || event.altKey) return;
    if (dialog.open || isTypingTarget(event.target)) return;
    // Only once the shortcut is certain to act: a `preventDefault` on a slash
    // the reader meant to type would be a broken keyboard.
    event.preventDefault();
    open();
  });

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === 'Enter' && state === 'failed' && event.target !== closeButton) {
      // The failure message tells the reader Enter retries. This is that.
      //
      // Scoped by exclusion rather than by naming the field, and the difference
      // is a real one in both directions. Gating on `event.target === input`
      // made the retry unreachable whenever focus sat on the dialog itself —
      // which is where it lands after a click on any non-focusable part of it,
      // with the message still promising that Enter retries. Not scoping at all
      // cancelled the Close button's implicit `<form method="dialog">`
      // submission through the `preventDefault` below, leaving the only other
      // focusable control in the failed state inert. Excluding exactly that one
      // control leaves Enter meaning "retry" everywhere else in the dialog.
      event.preventDefault();
      void ensureMounted();
      return;
    }
    if (event.key !== 'Tab') return;

    // The focus trap. `showModal` already confines focus to the dialog in every
    // current browser, so this is the belt to that braces — cheap enough to be
    // worth having, because the failure it prevents is a keyboard reader tabbing
    // into a page they cannot see.
    const elements = focusables();
    if (elements.length === 0) return;
    const first = elements[0]!;
    const last = elements[elements.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // A modal dialog restores focus to whatever opened it, but only while that
  // element is still focusable — and the trigger is `[data-js-only]`, a class of
  // element this site has already had disappear under a competing rule once.
  // Restoring explicitly costs one line.
  dialog.addEventListener('close', () => trigger.focus());
}
