/**
 * Gates that need a laid-out page rather than a parsed stylesheet.
 *
 * TK-02 checked both of these syntactically, by reasoning about the CSS cascade
 * from the stylesheet text, and its own report named the 320 px check the
 * weakest evidence in that ticket. The parser that backed them had five bugs
 * that had silently disarmed real gates. Owner decision D3 settled the
 * replacement: measure the rendered result.
 *
 * Driven from Node through Playwright rather than through Vitest browser mode,
 * for two reasons that are properties of this site rather than preferences:
 *
 * 1. Browser mode runs the test *inside* the page, so it cannot express the
 *    no-scripting state at all — the only way to disable JavaScript is to own
 *    the browser context from outside, which is what `javaScriptEnabled: false`
 *    below does.
 * 2. Browser mode measures a page loaded into an iframe, and the policy this
 *    site ships sets `frame-ancestors 'none'`. The shipped CSP would have to be
 *    weakened for the harness to see the document — exactly backwards for a gate
 *    whose job is to check what ships. Verified, not assumed: framing a page
 *    served with the real `_headers` is blocked and `contentDocument` is null.
 *
 * The pages are served with the headers `public/_headers` actually declares,
 * parsed out of that file rather than restated, so the measurement happens under
 * the policy the site deploys.
 *
 * Playwright's browser binary is a large download and `pnpm install` does not
 * fetch it. When it is absent these tests skip with the command that installs
 * it, so a fresh clone still gets a green `pnpm test` rather than a failure it
 * cannot act on. Only that one case skips: any other launch failure is a real
 * fault and fails loudly, because a gate that turns itself off on an error it
 * cannot explain is worse than no gate.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test, type TestContext } from 'vitest';

import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright';

import { entries, getEntry } from '../src/lib/content.ts';
import { collectionNeighbours } from '../src/lib/relations.ts';
import { localGraph } from '../src/lib/graph.ts';
import { noteRoute } from '../src/lib/routes.ts';

const ROOT = new URL('../', import.meta.url);
const DIST = fileURLToPath(new URL('dist/', ROOT));

/** The narrowest viewport the design system commits to supporting. */
const NARROWEST_PX = 320;

const VIEWPORT_HEIGHT_PX = 800;

/**
 * The widths every cascade gate is checked at.
 *
 * One viewport is not enough, and this is not hypothetical: the stylesheet
 * ships a `@media (min-width: 48rem)` block, so a rule that re-shows a
 * JavaScript-only control above that breakpoint is invisible to a 320 px-only
 * check. The syntactic gate this replaced resolved every non-print rule at
 * once and would have caught it, so measuring one width would have been a real
 * loss of coverage rather than a like-for-like migration. 1280 px sits above
 * every breakpoint in `src/styles/global.css`.
 */
const CASCADE_WIDTHS_PX = [NARROWEST_PX, 1280] as const;

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The headers the site deploys, read from the file that deploys them.
 *
 * `tests/deployment.test.ts` asserts the contents of that file directive by
 * directive; what matters here is only that the browser sees the same bytes. It
 * parses the same grammar with the same strictness — a line that is not
 * `Name: value` is a fault in the file, not something to serve as a header with
 * an empty name.
 *
 * Only the first rule's headers are served. `deployment.test.ts` asserts there
 * is exactly one rule and that it matches `/*`, so reading further would serve
 * a policy the deployment gate has already forbidden.
 */
function shippedHeaders(): Record<string, string> {
  const text = readFileSync(new URL('public/_headers', ROOT), 'utf8');
  const headers: Record<string, string> = {};
  let hasSeenPattern = false;

  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      // A second path pattern: everything after it belongs to another rule.
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

/** Serve `dist/` on an ephemeral port with the shipped headers. */
function serveDist(): Promise<Server> {
  const headers = shippedHeaders();
  const server = createServer((request, response) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      // A malformed percent-escape must not throw out of the handler and hang
      // the request the browser is waiting on.
      response.writeHead(400, headers);
      response.end('bad request');
      return;
    }

    let file = join(DIST, normalize(path));
    // `join` already resolves `..`, so this compares the *resolved* path. A
    // request that escapes `dist/` reads nothing from the repository.
    if (file !== DIST.replace(/[/\\]$/, '') && !file.startsWith(DIST)) {
      response.writeHead(403, headers);
      response.end('forbidden');
      return;
    }

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
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Every route `dist/` serves, as the path a browser would request. */
function builtRoutes(): string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === 'pagefind') continue;
      const child = join(directory, name);
      if (statSync(child).isDirectory()) walk(child, `${prefix}${name}/`);
      else if (name === 'index.html') found.push(prefix === '' ? '/' : `/${prefix}`);
    }
  };
  walk(DIST, '');
  return found.sort();
}

/**
 * The browser, or the reason there is none.
 *
 * Only a missing browser binary resolves to a reason. Every other failure
 * throws, because skipping on an unrecognized error is how a gate silently
 * stops running: the suite stays green while nothing is measured. Playwright
 * names this case explicitly in its message, and `executablePath()` is checked
 * first so the common case does not depend on matching prose.
 */
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
let routes: string[] = [];

beforeAll(async () => {
  try {
    statSync(DIST);
  } catch {
    assert.fail('dist/ is missing or unreadable — run `pnpm run build` before `pnpm test`');
  }
  routes = builtRoutes();
  assert.ok(routes.length > 0, 'the build produced no pages to render');

  launched = await launch();
  if ('unavailable' in launched) return;

  server = await serveDist();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (launched !== undefined && 'browser' in launched) await launched.browser.close();
  server?.close();
  // Vitest's default hook timeout is 10 s, and closing Chromium costs far more
  // than that. Every *test* here already carries an explicit timeout; the hook
  // had none, so it was the one step that could redden a run in which all
  // sixteen tests passed. Observed doing exactly that.
  //
  // **The reason given here was wrong and is corrected.** It said the cost
  // "grows with how many contexts the suite opened — this file now opens
  // sixteen". Measured directly, `browser.close()` with 0 pages open ran 1.0 s
  // to 16.9 s over 12 rounds, and with 16 pages open 13.3 s to 25.4 s: the
  // ranges overlap and the page count does not order them. Loading this site's
  // own pages rather than `<p>x</p>` moved p50 from 8.5 s to 9.8 s, which is
  // inside the noise of either. It is process teardown competing for a
  // scheduler, and it is a spread, not a level.
  //
  // Under the suite's own contention — 15 workers on 16 CPUs — the same close
  // measured p50 22.4 s and max 43.3 s. This hook was observed at 51.6 s and
  // 115.9 s against the 120 s it used to carry: 97% of budget, on a run that
  // passed. 180 s is four times the contended max, matching `search.test.ts`
  // and `diagram-client.test.ts`, which close a browser for the same reason.
  // Raised here rather than in `hookTimeout`, which would relax every hook in
  // the repository to fix three that share one cost.
}, 180_000);

/** Skip with the install command when no browser is available. */
function requireBrowser(context: TestContext): Browser {
  assert.ok(launched !== undefined, 'the suite setup did not run, so no browser was prepared');
  if ('unavailable' in launched) return context.skip(launched.unavailable);
  return launched.browser;
}

/**
 * Load a built route and fail if the server did not serve it.
 *
 * `page.goto` resolves for a 404 as readily as for a page, so without this a
 * serving fault would render the "not found" body on every route — which
 * overflows nothing and hides nothing, so every gate here would pass while
 * measuring an empty document.
 *
 * Console errors and uncaught exceptions are both collected, because
 * `AGENTS.md` requires no browser console error and Playwright reports the two
 * through different events: a script that throws on load raises `pageerror` and
 * never appears in `console`. A CSP-blocked stylesheet is the case that makes
 * this load-bearing — it makes the page *narrower*, so it would pass the
 * overflow gate while the site was visibly broken.
 */
async function visit(page: Page, route: string): Promise<void> {
  const failures: string[] = [];
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  };
  const onPageError = (error: Error): void => {
    failures.push(`uncaught: ${error.message}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    const response = await page.goto(`${origin}${route}`, { waitUntil: 'load' });
    assert.ok(response, `${route}: the browser issued no response`);
    assert.equal(response.status(), 200, `${route}: served HTTP ${response.status()}, not the page`);
    assert.deepEqual(failures, [], `${route}: the page reported a script error`);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}

/**
 * Routes known to overflow, with the ticket that owns the fix.
 *
 * A wide Markdown table has no scroll container: one needs a wrapper element,
 * which is the Markdown pipeline's to emit, and styling `.prose table` with
 * `display: block` instead would strip the table's semantics. TK-02 recorded
 * that deferral as a `ponytail:` note in `src/styles/global.css`. This gate
 * found it the first time a corpus with wide tables was rendered — the
 * published one-note corpus has none, so `pnpm test` never sees it and only
 * `pnpm run build:fixture` does.
 *
 * Each entry names the element whose subtree may overflow, not just the route,
 * so an unrelated defect on the same page still fails: a wide `<table>` reports
 * its own `<thead>`, `<tr>`, and `<td>` as overflowing too, and all of those are
 * the one deferred defect, while a `<pre>` or a `<div>` on the same page is not.
 * The list is checked in both directions: an unlisted overflow fails, and a
 * listed route that has *stopped* overflowing also fails, so an exemption cannot
 * outlive the defect it records.
 *
 * `.prose table` rather than `table`: since TK-17 every note page carries a
 * second table — the graph's equivalent representation — and a bare type
 * selector would exempt that one too, on the two routes that carry both. The
 * exemption records one deferred defect in the article body, so it names the
 * article body.
 */
const KNOWN_OVERFLOW: Readonly<Record<string, string>> = {
  '/notes/content-contract/': '.prose table',
  '/notes/table-heavy-comparison/': '.prose table',
};

/** One element that extends past the viewport, as a reader would meet it. */
interface Overflow {
  scrollWidth: number;
  innerWidth: number;
  /** Overflowing elements that are neither exempt nor clipped — what the gate judges. */
  culprits: string[];
  /**
   * How many overflowing elements the **exemption** accounted for.
   *
   * Clipped elements are counted separately and deliberately: this number is
   * what the stale-exemption check reads to decide whether a recorded defect is
   * still present, so folding a correctly-clipping scroll container into it
   * would report every graph-bearing route as still overflowing and silently
   * disarm that check. Both exempt routes draw a graph, so that was not
   * hypothetical.
   */
  exemptCount: number;
  /** Overflowing elements a scrolling ancestor clips — a feature, not a defect. */
  clippedCount: number;
}

/**
 * Measure horizontal overflow on the page as currently laid out.
 *
 * `exempt` is a selector whose subtree carries a deferred, recorded defect. Its
 * elements are partitioned out *before* the list is truncated for the failure
 * message — truncating first would let a wide table's own rows fill the list and
 * hide a genuine defect further down the document, which is the exact shape of
 * bug this whole ticket exists to stop.
 */
function measureOverflow(page: Page, limit: number, exempt: string | undefined): Promise<Overflow | undefined> {
  return page.evaluate(
    ({ edge, exemptSelector }) => {
      const root = document.documentElement;
      if (root.scrollWidth <= window.innerWidth) return undefined;

      const overflowing = [...document.querySelectorAll<HTMLElement>('*')].filter(
        (element) => element.getBoundingClientRect().right > edge + 1,
      );
      /**
       * Whether a scrolling ancestor clips this element.
       *
       * An element inside `overflow-x: auto` **cannot** widen the document —
       * the container clips it and scrolls instead, which is the entire point
       * of a scroll container and the treatment a wide code fence, a wide
       * diagram, and a wide graph all get. Counting such an element as a
       * culprit reports the feature as the defect.
       *
       * This is not an exemption and does not weaken the gate: the container
       * itself is still measured, so a scroll region that genuinely pushes the
       * page wide still fails. What it removes is the case where the *content*
       * of a correctly-clipping container is named as the cause.
       */
      const isClipped = (element: HTMLElement): boolean => {
        for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
          const overflowX = getComputedStyle(parent).overflowX;
          if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden') {
            return parent.getBoundingClientRect().right <= edge + 1;
          }
        }
        return false;
      };
      const isExempt = (element: HTMLElement) =>
        exemptSelector !== undefined &&
        (element.matches(exemptSelector) || element.closest(exemptSelector) !== null);

      // Three disjoint groups, counted separately: what the exemption covers,
      // what a scroll container clips, and what is left — which is the only
      // group that is a defect. Merging the first two is what would let a
      // graph-bearing route report its recorded table defect as still present
      // after the table was fixed.
      const clipped = overflowing.filter((element) => !isExempt(element) && isClipped(element));
      const culprits = overflowing
        .filter((element) => !isExempt(element) && !isClipped(element))
        .map((element) => {
          const right = Math.round(element.getBoundingClientRect().right);
          const name = element.id !== '' ? `#${element.id}` : `.${element.className || '(no class)'}`;
          return `<${element.localName}${name}> extends to ${right}px`;
        });

      return {
        scrollWidth: root.scrollWidth,
        innerWidth: window.innerWidth,
        culprits: culprits.slice(0, 5),
        exemptCount: overflowing.length - culprits.length - clipped.length,
        clippedCount: clipped.length,
      };
    },
    { edge: limit, exemptSelector: exempt },
  );
}

/**
 * No page overflows horizontally at the narrowest supported viewport.
 *
 * This is the measurement TK-02 could not make and TK-12 made once by hand. It
 * lays out every built route at 320 px and compares the document's scroll width
 * with the viewport's, which is the property a reader actually experiences —
 * overflow caused by content, by a box-model property, by a fixed grid track, or
 * by any combination of rules, none of which a stylesheet scan can see.
 *
 * The overflowing element is named on failure. `scrollWidth` alone says the page
 * is too wide without saying what made it too wide, and that turns a one-minute
 * fix into an afternoon.
 */
test('no built page overflows horizontally at 320 px', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    const stillOverflowing = new Set<string>();

    for (const route of routes) {
      await visit(page, route);
      const exempt = KNOWN_OVERFLOW[route];
      const overflow = await measureOverflow(page, NARROWEST_PX, exempt);
      if (overflow === undefined) continue;

      // An exemption covers one element's subtree on one route. Anything
      // overflowing outside it is still a failure, so a new defect on an
      // exempt page cannot hide behind the recorded one.
      if (overflow.exemptCount > 0) stillOverflowing.add(route);
      if (overflow.culprits.length === 0 && overflow.exemptCount > 0) continue;

      assert.fail(
        `${route}: lays out ${overflow.scrollWidth}px wide in a ${overflow.innerWidth}px viewport — ` +
          // An overflow with no nameable element is still an overflow: text can
          // push the document wider without any element's box crossing the edge.
          // Reporting the widths alone beats discarding a proven defect.
          `${overflow.culprits.join('; ') || 'no element could be named as the cause'}` +
          // Named so a reader of the failure knows what was set aside and why.
          // A page whose only wide elements are inside a scroll container and
          // which *still* reports a document overflow has a different defect —
          // most likely the container itself — and this is the number that says
          // so rather than leaving it to be rediscovered.
          (overflow.clippedCount > 0
            ? ` (${overflow.clippedCount} further element(s) sit inside a scroll container and cannot widen the page)`
            : ''),
      );
    }

    // The other direction: an exemption for a defect that has since been fixed
    // would quietly disarm this gate for that route.
    for (const [route, element] of Object.entries(KNOWN_OVERFLOW)) {
      if (!routes.includes(route) || stillOverflowing.has(route)) continue;
      assert.fail(
        `${route} no longer overflows at ${NARROWEST_PX}px — delete its KNOWN_OVERFLOW entry ` +
          `(<${element}>, awaiting a scroll wrapper) so the gate protects it again`,
      );
    }
  } finally {
    await browserContext.close();
  }
}, 120_000);

/** Every `[data-js-only]` control on the page, with the display the cascade gives it. */
function jsOnlyControls(page: Page): Promise<{ name: string; display: string }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-js-only]')].map((element) => ({
      name: `<${element.localName}${element.id !== '' ? `#${element.id}` : ''}>`,
      display: getComputedStyle(element).display,
    })),
  );
}

/**
 * Walk every route at every checked width.
 *
 * The vacuity guard is per width, not a single total: a control that renders at
 * 1280 px and disappears at 320 px would otherwise leave a width unchecked while
 * the sum still looked healthy.
 */
async function forEachRenderedRoute(
  browserContext: BrowserContext,
  visitRoute: (page: Page, route: string, width: number) => Promise<number>,
): Promise<void> {
  const page = await browserContext.newPage();
  try {
    for (const width of CASCADE_WIDTHS_PX) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT_PX });
      let seen = 0;
      for (const route of routes) {
        await visit(page, route);
        seen += await visitRoute(page, route, width);
      }
      assert.ok(
        seen > 0,
        `no [data-js-only] control was rendered at ${width}px, so nothing was checked at that width`,
      );
    }
  } finally {
    await page.close();
  }
}

/**
 * The JavaScript-only controls do not render when scripting is unavailable.
 *
 * Otherwise a keyboard user meets three buttons that silently do nothing. TK-02
 * proved this by resolving the cascade from the stylesheet text — it had to,
 * because the defect is a *competing* rule winning over the hiding rule, which
 * a pattern match on the hiding rule alone cannot see. It caught exactly that
 * during implementation, when `[data-js-only]` (0,1,0) lost to `.site-nav
 * button` (0,1,1).
 *
 * A browser with scripting disabled answers the same question by rendering it:
 * the computed style is the cascade's actual verdict, with every stylesheet,
 * specificity, `!important`, and document-order tie already resolved by the
 * implementation that ships rather than by a reimplementation of it. Checked at
 * every width in `CASCADE_WIDTHS_PX`, because the rule that re-shows a control
 * may live inside a `min-width` block the narrow viewport never applies.
 */
test('JavaScript-only controls are hidden when scripting is unavailable', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });

  try {
    await forEachRenderedRoute(browserContext, async (page, route, width) => {
      const controls = await jsOnlyControls(page);
      for (const control of controls) {
        assert.equal(
          control.display,
          'none',
          `${route} at ${width}px: ${control.name} computes to "display: ${control.display}" with ` +
            `scripting disabled, so a control that cannot work is offered to the reader`,
        );
      }
      return controls.length;
    });
  } finally {
    await browserContext.close();
  }
}, 120_000);

/**
 * The table of contents works with JavaScript disabled.
 *
 * Requirements section 5.3 makes core reading and navigation work without
 * scripting, and a table of contents is navigation, not an enhancement. The
 * static assertions in `built-routes.test.ts` prove the list is in the HTML;
 * what they cannot prove is that it is *visible and operable* once the cascade
 * has run with no scripting — a `<details>` whose summary is `display: none`,
 * or a collapse that only opens on click, would satisfy every markup check and
 * still leave the reader with nothing.
 *
 * Measured on the widest and narrowest viewports, because the layout could
 * plausibly move the table of contents into a rail at one of them and not the
 * other (TK-05c), and a rail hidden below a breakpoint is the classic way this
 * regresses.
 */
test('the table of contents is visible and operable with scripting disabled', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    let checked = 0;
    for (const width of CASCADE_WIDTHS_PX) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT_PX });
      for (const route of routes.filter((candidate) => candidate.startsWith('/notes/'))) {
        await visit(page, route);
        const toc = await page.evaluate(() => {
          const nav = document.querySelector<HTMLElement>('nav.toc');
          if (nav === null) return undefined;
          const details = nav.querySelector('details');
          const summary = nav.querySelector<HTMLElement>('summary');
          const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
          return {
            navDisplay: getComputedStyle(nav).display,
            isOpen: details?.open ?? false,
            summaryDisplay: summary === null ? 'missing' : getComputedStyle(summary).display,
            // A link a reader cannot see is a link a reader cannot follow.
            visibleLinks: links.filter((link) => link.getBoundingClientRect().height > 0).length,
            linkCount: links.length,
            // Every entry must reach a real element on this page.
            // `getElementById`, not `querySelector`: a heading of "2024 Review"
            // slugs to `2024-review`, and `querySelector('#2024-review')`
            // throws a `SyntaxError` because that is not a valid CSS
            // identifier. The link works fine in a browser; only the gate would
            // break, and it would break as an opaque crash rather than a
            // failed assertion.
            resolved: links.filter(
              (link) => document.getElementById(link.getAttribute('href')!.slice(1)) !== null,
            ).length,
            nestedLists: nav.querySelectorAll('ol ol').length,
          };
        });
        if (toc === undefined) continue;

        checked += 1;
        assert.notEqual(toc.navDisplay, 'none', `${route} at ${width}px: the table of contents is hidden`);
        assert.equal(toc.isOpen, true, `${route} at ${width}px: the disclosure starts closed`);
        assert.notEqual(
          toc.summaryDisplay,
          'none',
          `${route} at ${width}px: the disclosure control is hidden, so a closed list could never reopen`,
        );
        assert.ok(toc.linkCount > 0, `${route} at ${width}px: the table of contents has no links`);
        assert.equal(
          toc.visibleLinks,
          toc.linkCount,
          `${route} at ${width}px: ${toc.linkCount - toc.visibleLinks} entries render at zero height`,
        );
        assert.equal(
          toc.resolved,
          toc.linkCount,
          `${route} at ${width}px: an entry points at a heading that is not on the page`,
        );
      }
    }
    assert.ok(checked > 0, 'no note page rendered a table of contents, so nothing was measured');
  } finally {
    await browserContext.close();
  }
}, 180_000);

/**
 * The controls *are* offered once scripting is available.
 *
 * The pairing matters as much as either half: a stylesheet that hid the controls
 * unconditionally would pass the gate above while shipping three buttons no
 * reader can ever reach.
 */
test('JavaScript-only controls are offered when scripting is available', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });

  try {
    await forEachRenderedRoute(browserContext, async (page, route, width) => {
      const controls = await jsOnlyControls(page);
      const hidden = controls.filter((control) => control.display === 'none').map((control) => control.name);
      assert.deepEqual(hidden, [], `${route} at ${width}px: control stays hidden with scripting enabled`);
      return controls.length;
    });
  } finally {
    await browserContext.close();
  }
}, 120_000);

/**
 * The relationship surfaces are readable and followable with scripting off.
 *
 * These are the sections requirements section 5.2 names as core reading
 * behaviour and section 13.1 states explicitly need no script and no database
 * fetch. The gate measures the three properties a reader actually depends on:
 * the section is visible, every link in it is visible and has a real hit area,
 * and the large-list treatment is a layout rather than a truncation — a list
 * that renders only its first few entries and hides the rest behind a control
 * would pass a markup gate and strand a no-script reader.
 *
 * Checked at both widths because the multi-column grid only engages at the
 * wider one, and a track floor that pushed the page past a narrow viewport is
 * exactly what the 320 px overflow gate above would report as somebody else's
 * problem.
 */
test('the relationship sections are readable and complete with scripting disabled', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    let sectionsChecked = 0;
    let linksChecked = 0;
    let pagersChecked = 0;

    for (const width of CASCADE_WIDTHS_PX) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT_PX });
      for (const route of routes.filter((candidate) => candidate.startsWith('/notes/'))) {
        await visit(page, route);
        const measured = await page.evaluate(() => {
          const box = (element: Element) => element.getBoundingClientRect();
          const sections = [...document.querySelectorAll<HTMLElement>('aside.relations')].map(
            (section) => {
              const links = [...section.querySelectorAll<HTMLAnchorElement>('a[href^="/notes/"]')];
              const items = [...section.querySelectorAll('li')];
              return {
                name: section.getAttribute('aria-labelledby') ?? '(unlabelled)',
                display: getComputedStyle(section).display,
                height: box(section).height,
                // A heading a reader cannot see cannot tell them what the list is.
                headingVisible: (() => {
                  const heading = section.querySelector('h2');
                  return heading !== null && box(heading).height > 0;
                })(),
                itemCount: items.length,
                linkCount: links.length,
                visibleLinks: links.filter((link) => {
                  const rect = box(link);
                  // Rendered at all, in both axes — not a target-size check.
                  // WCAG 2.2's 24 px minimum carries a spacing exception this
                  // measurement cannot evaluate, and no gate in this repository
                  // checks it: the axe audit is run out of band from
                  // `.tmp/axe-audit.mjs` against an `axe.min.js` on disk, and
                  // making it a release gate is TK-09's. What is checked here
                  // is the failure this gate exists for — a link that renders
                  // at zero size because a list was truncated or clipped.
                  return rect.height > 0 && rect.width > 0;
                }).length,
                // Every link must sit inside the section's own box: an item
                // clipped out of a collapsed container is invisible while still
                // reporting a height.
                containedLinks: links.filter((link) => {
                  const rect = box(link);
                  const outer = box(section);
                  return rect.top >= outer.top - 1 && rect.bottom <= outer.bottom + 1;
                }).length,
                emptyStateVisible: (() => {
                  const empty = section.querySelector('.empty-state');
                  return empty !== null && box(empty).height > 0;
                })(),
              };
            },
          );

          const pagerElement = document.querySelector<HTMLElement>('nav.collection-pager');
          const pager =
            pagerElement === null
              ? undefined
              : {
                  display: getComputedStyle(pagerElement).display,
                  links: [...pagerElement.querySelectorAll<HTMLAnchorElement>('a')].map((link) => ({
                    href: link.getAttribute('href') ?? '',
                    height: box(link).height,
                    // The accessible name a screen reader would announce, which
                    // must not be the bare direction word.
                    text: (link.textContent ?? '').replaceAll(/\s+/g, ' ').trim(),
                  })),
                };

          return { sections, pager };
        });

        assert.equal(
          measured.sections.length,
          3,
          `${route} at ${width}px: expected three relationship sections, saw ${measured.sections.length}`,
        );

        for (const section of measured.sections) {
          const where = `${route} at ${width}px, ${section.name}`;
          assert.notEqual(section.display, 'none', `${where}: the section is hidden`);
          assert.ok(section.height > 0, `${where}: the section renders at zero height`);
          assert.ok(section.headingVisible, `${where}: the heading is not visible`);

          if (section.itemCount === 0) {
            assert.ok(section.emptyStateVisible, `${where}: empty, and the empty state is not visible`);
          } else {
            assert.equal(
              section.linkCount,
              section.itemCount,
              `${where}: ${section.itemCount - section.linkCount} list items carry no link`,
            );
            assert.equal(
              section.visibleLinks,
              section.linkCount,
              `${where}: ${section.linkCount - section.visibleLinks} links render at zero size`,
            );
            assert.equal(
              section.containedLinks,
              section.linkCount,
              `${where}: ${section.linkCount - section.containedLinks} links fall outside the section box, ` +
                'so the list is being clipped rather than laid out',
            );
            linksChecked += section.linkCount;
          }
          sectionsChecked += 1;
        }

        if (measured.pager !== undefined) {
          assert.notEqual(measured.pager.display, 'none', `${route} at ${width}px: the pager is hidden`);
          assert.ok(measured.pager.links.length > 0, `${route} at ${width}px: the pager has no links`);
          for (const link of measured.pager.links) {
            assert.ok(link.height > 0, `${route} at ${width}px: a pager link renders at zero height`);
            assert.match(link.href, /^\/notes\//, `${route} at ${width}px: a pager link leaves the note routes`);
            assert.ok(
              !/^(Previous|Next)$/.test(link.text),
              `${route} at ${width}px: a pager link reads "${link.text}" and nothing else, ` +
                'so it is meaningless out of context',
            );
          }
          pagersChecked += 1;
        }
      }
    }

    assert.ok(sectionsChecked > 0, 'no relationship section was measured');
    // Vacuity, scaled to the corpus rather than asserted flat. The published
    // artifact is one note with two empty edge arrays and no tags, so every
    // section there is legitimately empty and the empty state is what got
    // measured; under `pnpm run build:fixture` populated lists and pagers both
    // exist and must have been reached. Asserting a flat "some link was seen"
    // would fail on a corpus where nothing is wrong.
    if (entries.some((entry) => entry.outgoing.length + entry.backlinks.length > 0)) {
      assert.ok(linksChecked > 0, 'the corpus has edges but no relationship link was measured');
    }
    if (entries.some((entry) => collectionNeighbours(entry, entries).next !== undefined)) {
      assert.ok(pagersChecked > 0, 'the corpus has a collection sequence but no pager was measured');
    }
  } finally {
    await browserContext.close();
  }
}, 180_000);

/**
 * The collection rail is complete and operable with scripting disabled.
 *
 * This is the Quartz explorer failure stated as a browser fact rather than as a
 * code reading: its trie is rebuilt in the browser, so with JavaScript off the
 * whole navigation is an empty `<ul>`. `built-routes.test.ts` proves the markup
 * is in the HTML; what it cannot prove is that the rail is *visible and
 * operable* once the cascade has run with no scripting — a `<details>` whose
 * summary is `display: none`, or a rail hidden below a breakpoint, satisfies
 * every markup check and leaves the reader with nothing.
 *
 * **Visibility is `checkVisibility()`, not a box measurement, and that is a
 * correctness fix rather than a preference.** A closed `<details>` hides its
 * content with `content-visibility: hidden` on the `::details-content`
 * pseudo-element — the element keeps a laid-out box, so
 * `getBoundingClientRect().height > 0` reports every link in every *collapsed*
 * group as visible. Measured on Chromium 151: a closed group's twelve links all
 * had non-zero height while being unreachable and unrendered.
 * `checkVisibility()` accounts for it, and the first version of this gate failed
 * on exactly that — the gate was wrong, the collapse was not.
 *
 * Four properties, at both widths:
 *
 * 1. The rail is visible and has a real box.
 * 2. Its disclosure control is visible, so a closed group can be opened.
 * 3. A closed group's links are genuinely hidden, and toggling it reveals them —
 *    with `javaScriptEnabled: false`, which is what makes this the native
 *    element rather than a script.
 * 4. Every link in the open group is visible and inside the rail's own box, so
 *    the list is laid out rather than clipped.
 */
test('the collection rail is complete and operable with scripting disabled', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  /** Links inside the rail's groups that a reader can actually see. */
  const visibleLinksIn = (selector: string): Promise<number> =>
    page.evaluate(
      (query) =>
        [...document.querySelectorAll<HTMLAnchorElement>(query)].filter((link) =>
          link.checkVisibility(),
        ).length,
      selector,
    );

  try {
    let checked = 0;
    let toggled = 0;

    for (const width of CASCADE_WIDTHS_PX) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT_PX });
      for (const route of routes) {
        await visit(page, route);

        const measured = await page.evaluate(() => {
          const rail = document.querySelector<HTMLElement>('nav.explorer');
          if (rail === null) return undefined;
          const box = (element: Element) => element.getBoundingClientRect();
          const outer = box(rail);
          const open = rail.querySelector<HTMLDetailsElement>('details[open]');
          const links = open === null ? [] : [...open.querySelectorAll<HTMLAnchorElement>('a[href]')];
          return {
            display: getComputedStyle(rail).display,
            height: outer.height,
            groupCount: rail.querySelectorAll('details').length,
            hasOpenGroup: open !== null,
            // A summary a reader cannot see is a collapse they can never undo.
            hiddenSummaries: [...rail.querySelectorAll<HTMLElement>('summary')].filter(
              (summary) => !summary.checkVisibility(),
            ).length,
            openLinks: links.length,
            visibleLinks: links.filter((link) => link.checkVisibility()).length,
            // Inside the boxes that contain it, on **both** axes.
            //
            // The vertical bound is measured against the open `<details>`, not
            // against the rail, and it is what catches a collapse that never
            // actually opens: `checkVisibility()` stays true for a link inside
            // a zero-height `::details-content`, so a group whose open state
            // renders nothing reports all twelve links visible. Measured under
            // exactly that mutation — 12 links "visible", the group 51 px tall,
            // and **0** of them inside it. The horizontal bound against the
            // rail catches the other shape, a list clipped sideways out of a
            // container that scrolls.
            containedLinks: links.filter((link) => {
              const rect = box(link);
              const group = box(open!);
              return (
                rect.left >= outer.left - 1 &&
                rect.right <= outer.right + 1 &&
                rect.top >= group.top - 1 &&
                rect.bottom <= group.bottom + 1
              );
            }).length,
          };
        });
        if (measured === undefined) continue;

        const where = `${route} at ${width}px`;
        checked += 1;
        assert.notEqual(measured.display, 'none', `${where}: the collection rail is hidden`);
        assert.ok(measured.height > 0, `${where}: the rail renders at zero height`);
        assert.ok(measured.groupCount > 0, `${where}: the rail renders no groups`);
        assert.equal(
          measured.hiddenSummaries,
          0,
          `${where}: ${measured.hiddenSummaries} disclosure controls are not visible, ` +
            'so a closed group could never be opened',
        );
        if (measured.hasOpenGroup) {
          assert.ok(measured.openLinks > 0, `${where}: the open group renders no links`);
          assert.equal(
            measured.visibleLinks,
            measured.openLinks,
            `${where}: ${measured.openLinks - measured.visibleLinks} links in the open group are ` +
              'not visible to the reader',
          );
          assert.equal(
            measured.containedLinks,
            measured.openLinks,
            `${where}: ${measured.openLinks - measured.containedLinks} rail links fall outside the ` +
              'boxes that should contain them — the open group renders at no height, or the list ' +
              'is being clipped rather than laid out',
          );
        }
      }

      // The disclosure itself, with no scripting: a closed group hides its links
      // and opening it reveals them. This is the whole reason the collapse is a
      // `<details>` — a script-driven one would be inert in this context, which
      // is precisely Quartz's failure.
      const first = routes[0];
      if (first === undefined) continue;
      await visit(page, first);
      const closed = page.locator('nav.explorer details:not([open]) > summary').first();
      if ((await closed.count()) === 0) continue;

      assert.equal(
        await visibleLinksIn('nav.explorer details:not([open]) a[href]'),
        0,
        `at ${width}px: a closed group's links are visible while it is closed, ` +
          'so the collapse hides nothing',
      );
      await closed.click();
      // Polled from Node, **not** `page.waitForFunction`, and that is a
      // correctness fix rather than a style choice: `waitForFunction` schedules
      // its predicate inside the page, so with `javaScriptEnabled: false` it
      // never runs and the call always times out. Measured — it timed out after
      // 5,005 ms on a document where `page.evaluate` reported all 12 links
      // visible. Polling is also what keeps the assertion off a fixed sleep
      // against a transition duration the stylesheet owns.
      let revealed = 0;
      for (let attempt = 0; attempt < 25 && revealed === 0; attempt += 1) {
        revealed = await visibleLinksIn('nav.explorer details[open] a[href]');
        if (revealed === 0) await page.waitForTimeout(40);
      }
      assert.ok(
        revealed > 0,
        `at ${width}px: opening a group with scripting disabled revealed no links — ` +
          'the collapse is not the native disclosure',
      );
      toggled += 1;
    }

    // Scaled to the corpus rather than asserted flat: the published artifact is
    // one note, where the rail deliberately does not render at all.
    if (entries.length > 1) {
      assert.ok(checked > 0, 'the corpus has notes to browse but no rail was measured');
      assert.ok(toggled > 0, 'no closed group was ever toggled, so the collapse was not exercised');
    }
  } finally {
    await browserContext.close();
  }
}, 180_000);

/**
 * The link preview opens on hover and on keyboard focus, and stays on screen.
 *
 * TK-07's acceptance criteria are browser properties: a preview reached by
 * keyboard, a panel that never leaves the viewport, and a link that still
 * navigates whatever the preview does. None is observable from the HTML, and the
 * unit gates in `tests/preview-model.test.ts` prove the placement arithmetic
 * without proving it is the arithmetic the page runs.
 *
 * Driven from the first built route that carries a note link rather than from a
 * named one. On the published one-note corpus that is `/`; under
 * `pnpm run build:fixture` it is every route. Finding it measures both corpora
 * with no exemption list and no route that silently stops existing.
 *
 * Checked at 320 px, where the clamp has the least room and where a panel wider
 * than the viewport is a horizontal overflow rather than a cosmetic error.
 */
test('the link preview opens on hover and on focus, and never leaves the viewport', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  /** The panel's box and contents, as a reader would meet them. */
  const panelState = () =>
    page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('#link-preview');
      if (panel === null) return undefined;
      const rect = panel.getBoundingClientRect();
      return {
        isHidden: panel.hidden,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        title: panel.querySelector('strong')?.textContent ?? '',
        excerpt: panel.querySelector('p')?.textContent ?? '',
        // Every node in the panel, so an `innerHTML` regression that let the
        // payload introduce markup shows up as an unexpected element.
        elements: [...panel.querySelectorAll('*')].map((node) => node.localName).sort(),
      };
    });

  const waitForPanel = (shown: boolean) =>
    page.waitForFunction(
      (expected) => document.querySelector<HTMLElement>('#link-preview')?.hidden === !expected,
      shown,
      { timeout: 5_000 },
    );

  try {
    let route: string | undefined;
    let target = '';
    for (const candidate of routes) {
      await visit(page, candidate);
      const href = await page.evaluate(
        () => document.querySelector<HTMLAnchorElement>('a[href^="/notes/"]')?.getAttribute('href') ?? '',
      );
      if (href !== '') {
        route = candidate;
        target = href;
        break;
      }
    }
    assert.ok(route !== undefined, 'no built route carries a note link, so no preview could be opened');

    await visit(page, route);
    const link = page.locator(`a[href="${target}"]`).first();

    // --- Hover ---------------------------------------------------------------
    await link.hover();
    await waitForPanel(true);
    const hovered = (await panelState())!;
    assert.ok(hovered.title.length > 0, 'the preview opened with no title');
    assert.deepEqual(
      hovered.elements,
      ['p', 'strong'],
      'the preview rendered nodes other than the constructed title and excerpt',
    );
    assert.ok(hovered.left >= 0, `the panel starts at ${hovered.left}px, off the left of the viewport`);
    assert.ok(hovered.top >= 0, `the panel starts at ${hovered.top}px, above the viewport`);
    assert.ok(
      hovered.right <= NARROWEST_PX,
      `the panel ends at ${hovered.right}px in a ${NARROWEST_PX}px viewport`,
    );
    assert.ok(
      hovered.bottom <= VIEWPORT_HEIGHT_PX,
      `the panel ends at ${hovered.bottom}px in a ${VIEWPORT_HEIGHT_PX}px viewport`,
    );
    assert.equal(
      await link.getAttribute('aria-describedby'),
      'link-preview',
      'the previewed link is not described by the panel a screen reader would read',
    );

    // --- Escape --------------------------------------------------------------
    await page.keyboard.press('Escape');
    await waitForPanel(false);
    assert.equal(
      await link.getAttribute('aria-describedby'),
      null,
      'the dismissed panel is still announced as the link description',
    );

    // --- Keyboard focus ------------------------------------------------------
    // The acceptance criterion: focus produces the same preview as hover. Driven
    // with real `Tab` presses rather than `link.focus()`, because the two are not
    // equivalent here: the script gates on `:focus-visible` so a tap cannot open
    // a panel over the page it is navigating to, and programmatic focus does not
    // always set that state. A gate that focused directly would pass while every
    // real keyboard reader got nothing.
    await page.mouse.move(0, 0);
    let reached = false;
    for (let press = 0; press < 40 && !reached; press += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(
        (href) => document.activeElement?.getAttribute('href') === href,
        target,
      );
    }
    assert.ok(reached, `tabbing never reached ${target}, so the keyboard path was not measured`);
    await waitForPanel(true);
    const focused = (await panelState())!;
    assert.equal(focused.title, hovered.title, 'focus and hover produced different previews');
    assert.equal(focused.excerpt, hovered.excerpt, 'focus and hover produced different previews');

    // --- Scroll --------------------------------------------------------------
    await page.mouse.wheel(0, 200);
    await waitForPanel(false);

    // --- A heading target ----------------------------------------------------
    // Scope item 3. Neither corpus contains a `/notes/<slug>/#heading` link —
    // the exporter derives edges from wikilinks and discards their fragments —
    // so the link is injected rather than searched for, and the gate says so
    // instead of quietly measuring nothing. The panel names the section as the
    // fragment itself: the projection carries `{slug, title, excerpt}` and
    // nothing per heading, so a de-slugged guess at the heading's prose would be
    // a fabrication, while the fragment is what the address bar shows on arrival.
    await page.evaluate((href) => {
      const link = document.createElement('a');
      link.href = `${href}#introduction`;
      link.id = 'probe-heading-target';
      link.textContent = 'probe';
      document.querySelector('main')!.append(link);
    }, target);
    await page.locator('#probe-heading-target').hover();
    await waitForPanel(true);
    const withHeading = (await panelState())!;
    assert.equal(withHeading.title, hovered.title, 'a heading target previewed a different note');
    assert.deepEqual(
      withHeading.elements,
      ['p', 'span', 'strong'],
      'a heading-target preview did not add the section line, or added something else',
    );
    assert.equal(
      await page.evaluate(
        () => document.querySelector('#link-preview .preview-fragment')?.textContent ?? '',
      ),
      '#introduction',
      'the section line does not name the heading the link lands on',
    );
    await page.keyboard.press('Escape');
    await waitForPanel(false);

    // --- The link still works ------------------------------------------------
    // Requirements section 14: a preview never replaces the underlying link.
    await link.click();
    await page.waitForURL(`**${target}`, { timeout: 10_000 });
    assert.match(new URL(page.url()).pathname, /^\/notes\//, 'following a previewed link did not navigate');
  } finally {
    await browserContext.close();
  }
}, 180_000);

test.runIf(entries.length > 1)(
  'a code fence gains a working copy control only with scripting',
  async (context) => {
    const browser = requireBrowser(context);
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              const state = window as typeof window & { __copiedCode?: string; __copyFails?: boolean };
              if (state.__copyFails) {
                state.__copyFails = false;
                throw new Error('simulated clipboard denial');
              }
              state.__copiedCode = text;
            },
          },
        });
        (window as typeof window & { __copyFails?: boolean }).__copyFails = true;
      });
      await visit(page, '/notes/code-heavy-shell-recipes/');
      const button = page.locator('.code-copy').first();
      const code = page.locator('.code-block > pre > code').first();
      assert.ok((await button.count()) > 0, 'a code page has no runtime copy control');
      const expected = await code.textContent();
      const copiedLabel = await page.getAttribute('.prose', 'data-code-copied');
      const failedLabel = await page.getAttribute('.prose', 'data-code-copy-failed');
      assert.ok(copiedLabel !== null && copiedLabel !== '');
      assert.ok(failedLabel !== null && failedLabel !== '');
      await button.click();
      await page.waitForFunction(
        (label) => document.querySelector('.code-copy')?.textContent === label,
        failedLabel,
      );
      assert.equal(await page.textContent('.code-block [role="status"]'), failedLabel);
      await button.click();
      await page.waitForFunction(
        (label) => document.querySelector('.code-copy')?.textContent === label,
        copiedLabel,
      );
      const copied = await page.evaluate(
        () => (window as typeof window & { __copiedCode?: string }).__copiedCode,
      );
      assert.equal(copied, expected);
      assert.equal(await page.textContent('.code-block [role="status"]'), copiedLabel);

      const noScriptContext = await browser.newContext({ javaScriptEnabled: false });
      try {
        const noScriptPage = await noScriptContext.newPage();
        await noScriptPage.goto(`${origin}/notes/code-heavy-shell-recipes/`);
        assert.equal(await noScriptPage.locator('.code-copy').count(), 0);
      } finally {
        await noScriptContext.close();
      }
    } finally {
      await page.close();
    }
  },
  120_000,
);

test.runIf(entries.some((entry) => (entry.aliases?.length ?? 0) > 0))(
  'a hover preview includes the target note aliases as text',
  async (context) => {
    const target = entries.find((entry) => entry.slug === 'alias-heavy');
    assert.ok(target?.aliases !== undefined && target.aliases.length > 0);
    const browser = requireBrowser(context);
    const page = await browser.newPage();
    try {
      await visit(page, '/');
      // This fixture intentionally keeps alias-heavy isolated. Injecting one real
      // note-route anchor isolates the preview payload branch without inventing
      // a relationship edge that would violate the backlink contract.
      await page.evaluate(() => {
        const link = document.createElement('a');
        link.id = 'alias-preview-probe';
        link.href = '/notes/alias-heavy/';
        link.textContent = 'alias preview probe';
        document.querySelector('main')!.append(link);
      });
      const link = page.locator('#alias-preview-probe');
      await link.hover();
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>('#link-preview')?.hidden === false,
        undefined,
        { timeout: 5_000 },
      );
      const title = await page.textContent('#link-preview strong');
      assert.equal(title, `${target.title} (${target.aliases.join(', ')})`);
    } finally {
      await page.close();
    }
  },
  120_000,
);

/**
 * No link on a note page previews the note the reader is already reading.
 *
 * This is a defect review found in the first implementation, and it is the one
 * that mattered most: every `href="#section"` on a note page resolves to that
 * note's own `pathname`, so a preview keyed on the path alone previewed the open
 * page from all of them. Measured before the fix on the published note page —
 * **29 such anchors**: the table of contents, fifteen heading anchors, and the
 * skip link. The *first* `Tab` a keyboard reader presses landed on
 * `<a class="skip-link" href="#main">` and opened a panel describing the page
 * they were already on, with `aria-describedby` pointing at it.
 *
 * It is gated over the real anchors rather than an injected probe, because an
 * injected probe is exactly what let the first implementation ship: the
 * heading-target case was proven with a link the test itself created, so the 29
 * real ones were never hovered.
 */
test('no link previews the page it is already on', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: 1280, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    let checked = 0;
    for (const route of routes.filter((candidate) => candidate.startsWith('/notes/')).slice(0, 4)) {
      await visit(page, route);

      const selfLinks = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
          .filter((link) => link.pathname === location.pathname)
          .map((link) => link.getAttribute('href') ?? ''),
      );
      assert.ok(
        selfLinks.length > 0,
        `${route}: no same-page link was found, so this gate measured nothing — ` +
          'a note page carries at least a skip link and its heading anchors',
      );

      // The skip link first and by name: it is the first thing a keyboard reader
      // reaches, so a panel over it is the worst instance of this defect.
      await page.keyboard.press('Tab');
      await page.waitForTimeout(400);
      const first = await page.evaluate(() => ({
        focused: document.activeElement?.getAttribute('href') ?? '',
        isHidden: document.querySelector<HTMLElement>('#link-preview')?.hidden !== false,
        describedBy: document.activeElement?.getAttribute('aria-describedby'),
      }));
      assert.ok(
        first.isHidden,
        `${route}: the first Tab (onto "${first.focused}") opened a preview of the page being read`,
      );
      assert.equal(
        first.describedBy,
        null,
        `${route}: the first focusable control is described by a preview panel`,
      );

      for (const href of selfLinks.slice(0, 8)) {
        const link = page.locator(`a[href="${href}"]`).first();
        // A heading anchor is revealed on hover, so it may not be hittable; the
        // event path is what this gate is about either way.
        try {
          await link.hover({ timeout: 2_000 });
        } catch {
          continue;
        }
        await page.waitForTimeout(300);
        assert.ok(
          await page.evaluate(() => document.querySelector<HTMLElement>('#link-preview')?.hidden !== false),
          `${route}: hovering "${href}" previewed the page the reader is already on`,
        );
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'no same-page link was hovered, so nothing was measured');
  } finally {
    await browserContext.close();
  }
}, 180_000);

/**
 * A tap opens no preview.
 *
 * Scope item 7's "do not interfere with touch interaction", and it needs both
 * doors closed rather than one: the pointer listeners skip `pointerType ===
 * 'touch'`, but a tap also *focuses* the link, so an unqualified `focusin` would
 * flash a panel over the page the tap is navigating to. That second door was open
 * in the first implementation and review found it. The script now gates focus on
 * `:focus-visible`, which is the browser's own "this focus deserves an indicator"
 * decision — keyboard yes, tap no. Traced on a real touch context: a tap fires
 * `pointerover(touch)`, `focusin` with `:focus-visible` false, then `click`.
 *
 * The tap's navigation is suppressed for the measurement, and that is what makes
 * this gate work rather than a shortcut. Left to navigate, the page unloads
 * before the open delay elapses and the assertion lands on a *fresh* document
 * whose panel is hidden because nothing has happened on it yet — so the gate
 * would pass no matter what the script did. Verified: with the `:focus-visible`
 * gate removed, the navigating version still passed and this version fails.
 * The tap's navigation is then measured separately, without suppression.
 */
test('a tap opens no preview', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: 390, height: 780 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await browserContext.newPage();

  try {
    let route: string | undefined;
    let target = '';
    for (const candidate of routes) {
      await visit(page, candidate);
      const href = await page.evaluate(
        () => document.querySelector<HTMLAnchorElement>('a[href^="/notes/"]')?.getAttribute('href') ?? '',
      );
      if (href !== '') {
        route = candidate;
        target = href;
        break;
      }
    }
    assert.ok(route !== undefined, 'no built route carries a note link to tap');

    // --- The event path, with the page held still ----------------------------
    await visit(page, route);
    await page.evaluate(() => {
      document.addEventListener('click', (event) => event.preventDefault(), true);
      const panel = document.querySelector<HTMLElement>('#link-preview')!;
      const counter = { shown: 0 };
      (window as typeof window & { tapShown: { shown: number } }).tapShown = counter;
      new MutationObserver(() => {
        if (!panel.hidden) counter.shown += 1;
      }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    });

    const box = (await page.locator(`a[href="${target}"]`).first().boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    // Several times the open delay, so a panel that was going to appear has.
    await page.waitForTimeout(600);
    assert.equal(
      await page.evaluate(() => (window as typeof window & { tapShown: { shown: number } }).tapShown.shown),
      0,
      'a tap opened a preview over the page it was navigating to',
    );
    // The tap really did reach the link: without this, a mistargeted tap would
    // satisfy the assertion above by touching nothing at all.
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('href') ?? ''),
      target,
      'the tap did not land on the link, so the touch path was not measured',
    );

    // --- And the tap still follows the link ----------------------------------
    // Re-measured after the reload rather than reusing `box`. The first pass
    // suppressed the click and dispatched a `MutationObserver` into the page, but
    // it is the *reload* that matters: font metrics and image sizing settle at
    // slightly different times on a fresh document, so the link's box can sit a
    // few pixels from where it was, and a tap at the stale centre lands next to
    // it. That is a coordinate flake, not a preview defect — measured at roughly
    // 2 failures in 8 runs before this change, always as a `waitForURL` timeout
    // on a tap that hit nothing.
    await visit(page, route);
    const link = page.locator(`a[href="${target}"]`).first();
    await link.scrollIntoViewIfNeeded();
    const settled = (await link.boundingBox())!;
    await page.touchscreen.tap(settled.x + settled.width / 2, settled.y + settled.height / 2);
    await page.waitForURL(`**${target}`, { timeout: 10_000 });
    assert.match(new URL(page.url()).pathname, /^\/notes\//, 'the tap did not follow the link');
  } finally {
    await browserContext.close();
  }
}, 120_000);

/**
 * A link with child elements behaves as one link, in both directions.
 *
 * Two properties, on the same real anchors:
 *
 * 1. Moving between a link's own children does not dismiss its preview. The
 *    pointer has not left the link, so `pointerout` must be swallowed.
 * 2. After a failed index load, crossing that same internal boundary **retries**.
 *    This is the half that was broken and the half nobody found by reasoning:
 *    `pointerout` is correctly swallowed, so nothing clears `current`, but the
 *    crossing still fires a fresh `pointerover` for the same anchor — which the
 *    "already here" branch would swallow too, leaving the preview permanently
 *    dead. `show` releases `current` on a miss for exactly this.
 *
 * Driven from **real** nested anchors rather than an injected probe, at the
 * reviewer's and the coordinator's insistence, and they were right to insist:
 * an injected probe is what let the `href="#section"` self-preview defect through
 * this file's own gate earlier in the ticket. Both searches for such markup had
 * also looked in the wrong place — no Markdown link label in either corpus
 * carries inline markup, but the collection pager in
 * `src/pages/notes/[slug].astro` wraps two `<span>`s in every anchor, and the
 * fixture corpus builds 50 of them. (Not `LinkedNotes.astro`, which this comment
 * named until review checked: that component emits
 * `<li><a href=…>{title}</a></li>`, a bare text anchor with no child element.)
 *
 * The published corpus has no collection sequence and so no pager, which is why
 * this skips rather than fails there — the same shape as the other corpus-scaled
 * vacuity guards in this file.
 */
test('a link with child elements is one link, and an internal crossing retries after a failure', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: 1280, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  /** The first built route whose pager anchor wraps child elements. */
  async function findNested(): Promise<{ route: string; children: number } | undefined> {
    for (const route of routes.filter((candidate) => candidate.startsWith('/notes/'))) {
      await visit(page, route);
      const children = await page.evaluate(
        () =>
          document.querySelector<HTMLAnchorElement>('nav.collection-pager a[href^="/notes/"]')?.children
            .length ?? 0,
      );
      if (children > 1) return { route, children };
    }
    return undefined;
  }

  try {
    const found = await findNested();
    if (found === undefined) {
      return context.skip(
        'no built route carries a link with child elements — the published corpus has no ' +
          'collection sequence, so no pager renders; `pnpm run build:fixture` exercises this',
      );
    }

    // The pager link must be in the served index, or every assertion below reads
    // "no preview" as a pass. This is not hypothetical: a `dist/` built from the
    // fixture artifact while `public/content-index.json` is still the published
    // one-note projection serves 32 note pages against a 1-entry index, and this
    // gate then fails at its first wait with a bare timeout. `build-fixture.ts`
    // overwrites the index for exactly this reason; the check is here so that a
    // `dist/` assembled any other way says what is wrong instead of timing out.
    const targetSlug = await page.evaluate(
      () =>
        document
          .querySelector<HTMLAnchorElement>('nav.collection-pager a[href^="/notes/"]')
          ?.pathname.replace(/^\/notes\/|\/$/g, '') ?? '',
    );
    const isIndexed = await page.evaluate(async (slug) => {
      const response = await fetch('/content-index.json');
      const payload = (await response.json()) as { entries?: { slug?: string }[] };
      return (payload.entries ?? []).some((entry) => entry.slug === slug);
    }, targetSlug);
    assert.ok(
      isIndexed,
      `${found.route}: its pager links to "${targetSlug}", which the served ` +
        '/content-index.json does not carry — dist/ was built from one artifact and the index ' +
        'copied from another, so no preview could open and this gate would measure nothing',
    );

    const first = page.locator('nav.collection-pager a .pager-direction').first();
    const second = page.locator('nav.collection-pager a .pager-title').first();
    // The pager sits at the foot of the article; an element outside the viewport
    // has a box the pointer can never reach.
    await first.scrollIntoViewIfNeeded();
    const from = (await first.boundingBox())!;
    const to = (await second.boundingBox())!;
    const centre = (box: { x: number; y: number; width: number; height: number }) =>
      [box.x + box.width / 2, box.y + box.height / 2] as const;

    // --- 1. The crossing does not dismiss, even momentarily ------------------
    await page.mouse.move(...centre(from));
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('#link-preview')?.hidden === false,
      undefined,
      { timeout: 5_000 },
    );

    // Every transition of `hidden` from here on. Asserting the *end* state after
    // a wait is not enough and this gate proved it: dismissing on the crossing
    // and re-opening 120 ms later ends with the panel visible, so an end-state
    // check passes while the reader watches it blink. A flicker is the defect.
    await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('#link-preview')!;
      const counter = { hides: 0 };
      (window as typeof window & { crossing: { hides: number } }).crossing = counter;
      new MutationObserver(() => {
        if (panel.hidden) counter.hides += 1;
      }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    });

    await page.mouse.move(...centre(to));
    // Comfortably longer than both the close grace period and the open delay, so
    // a hide-then-reopen cycle has had time to complete and be counted.
    await page.waitForTimeout(700);

    assert.equal(
      await page.evaluate(() => (window as typeof window & { crossing: { hides: number } }).crossing.hides),
      0,
      "moving between a link's own children hid its preview — the link is not being treated as one link",
    );
    assert.ok(
      await page.evaluate(() => document.querySelector<HTMLElement>('#link-preview')?.hidden === false),
      "moving between a link's own children left its preview dismissed",
    );

    // --- 2. The crossing retries after a failed load --------------------------
    let isFailing = true;
    await page.route('**/content-index.json', (route) =>
      isFailing ? route.fulfill({ status: 500, body: 'nope' }) : route.fallback(),
    );
    // A fresh document, so the index is fetched again under the stub.
    await page.goto(`${origin}${found.route}`, { waitUntil: 'load' });
    await first.scrollIntoViewIfNeeded();

    await page.mouse.move(...centre((await first.boundingBox())!));
    await page.waitForTimeout(500);
    assert.ok(
      await page.evaluate(() => document.querySelector<HTMLElement>('#link-preview')?.hidden !== false),
      'a failed index request still opened a preview',
    );

    isFailing = false;
    await page.mouse.move(...centre((await second.boundingBox())!));
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('#link-preview')?.hidden === false,
      undefined,
      { timeout: 5_000 },
    ).catch(() => {
      assert.fail(
        'after a failed index load, crossing between the link\'s own children never retried — ' +
          'the preview is permanently dead for that link and no pointer gesture short of ' +
          'leaving it can recover',
      );
    });
  } finally {
    await browserContext.close();
  }
}, 180_000);

/**
 * A link that is not a published note previews nothing and requests nothing.
 *
 * The privacy property as a browser fact rather than as a code reading: the
 * panel is a projection lookup, so an off-site target has nothing to find — but a
 * hover that still *requested* something would be either a needless fetch or,
 * under a scrape-the-target design, the hole this ticket exists to avoid. The
 * request log is what tells the two apart.
 *
 * The first probe is the one that matters and the reason the others are not
 * enough. `//example.invalid/notes/<published-slug>/` is an off-site URL whose
 * `pathname` is a *real* note route on this site, so an `href^="/"` test — the
 * shape this file shipped before — resolves it, finds the slug in the index, and
 * shows one of our previews for a third party's link. Mutation-tested: replacing
 * the origin comparison with the prefix test fails on this probe alone, and
 * passes every other assertion here.
 *
 * The links are injected rather than found. The published corpus does carry three
 * external links (chocolatey.org, openssl.org, slproweb.com) and the fixture
 * corpus carries none — but neither carries the shape that matters here, an
 * off-site URL wearing one of *our* note paths, and a gate that hunted for one
 * would measure nothing on the fixture corpus at all.
 */
test('a link that is not a published note previews nothing and requests nothing', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    await visit(page, '/');

    const published = await page.evaluate(
      () => document.querySelector<HTMLAnchorElement>('a[href^="/notes/"]')?.getAttribute('href') ?? '',
    );
    assert.notEqual(published, '', '/ carries no note link, so the off-site probe has no real slug to borrow');

    // Three shapes a naive `href^="/"` test gets wrong, hardest first: an
    // off-site URL wearing a published note's own path, an ordinary off-site
    // URL, and a same-origin route that is not a note.
    const probes = [`//example.invalid${published}`, 'https://example.invalid/x', '/tags/probe/'];
    // The other half of scope item 6, and deliberately separate: a same-origin
    // note route whose slug is not in the projection — a stale link to a note
    // that is no longer published. It is the one probe that legitimately *does*
    // load the index, since answering "is this slug published?" is what the
    // index is for, so it is held out of the no-request assertion below.
    const unknownSlug = '/notes/not-a-published-note/';
    const probeId = (href: string) => `probe-${href.replaceAll(/\W/g, '')}`;

    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));

    await page.evaluate((hrefs) => {
      const main = document.querySelector('main')!;
      for (const href of hrefs) {
        const link = document.createElement('a');
        link.href = href;
        link.id = `probe-${href.replaceAll(/\W/g, '')}`;
        link.textContent = 'probe';
        main.append(link);
      }
    }, [...probes, unknownSlug]);

    for (const href of probes) {
      await page.locator(`#${probeId(href)}`).hover();
      // Comfortably longer than the open delay, so a preview that was going to
      // appear has appeared.
      await page.waitForTimeout(400);
      assert.ok(
        await page.evaluate(() => document.querySelector<HTMLElement>('#link-preview')?.hidden !== false),
        `hovering ${href} opened a preview`,
      );
    }

    assert.deepEqual(
      requested.filter((url) => !url.startsWith(`${origin}/`)),
      [],
      'hovering a link that is not a published note issued an off-origin request',
    );
    // Scope item 5 is "never *fetch* a non-public target", not only "never show
    // one". The index is the only thing a hover can request, and none of the
    // probes above is a note route on this origin, so none should have cost even
    // that. Asserted before the unknown-slug probe, which legitimately loads it.
    assert.deepEqual(
      requested.filter((url) => url.endsWith('/content-index.json')),
      [],
      'hovering a link that is not a note route on this origin fetched the preview index',
    );

    // Scope item 6's unknown slug: a well-formed note route the projection does
    // not list. The index is consulted — that is the question it answers — and
    // the answer is "nothing to show", silently.
    await page.locator(`#${probeId(unknownSlug)}`).hover();
    await page.waitForTimeout(600);
    assert.ok(
      await page.evaluate(() => document.querySelector<HTMLElement>('#link-preview')?.hidden !== false),
      `hovering ${unknownSlug} previewed a slug that is not in the projection`,
    );
  } finally {
    await browserContext.close();
  }
}, 120_000);

/**
 * Brushing past a link opens nothing, and leaving a shown panel closes it.
 *
 * The two halves of the hover-intent requirement, and neither is visible from a
 * final state: a preview that opens instantly and then closes when the pointer
 * moves on ends up hidden, exactly like one that was correctly never opened. The
 * `MutationObserver` is what tells them apart — it records every transition of
 * the panel's `hidden` attribute, so "it appeared and went away again" is a
 * different observation from "it never appeared".
 *
 * Mutation-tested: dropping the open delay fails the first half, and dropping
 * the close timer fails the second.
 */
test('a link brushed past opens no preview, and a shown preview closes when the pointer leaves', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    let route: string | undefined;
    let target = '';
    for (const candidate of routes) {
      await visit(page, candidate);
      const href = await page.evaluate(
        () => document.querySelector<HTMLAnchorElement>('a[href^="/notes/"]')?.getAttribute('href') ?? '',
      );
      if (href !== '') {
        route = candidate;
        target = href;
        break;
      }
    }
    assert.ok(route !== undefined, 'no built route carries a note link to hover');

    await visit(page, route);
    // Count every time the panel becomes visible, from now until it is read.
    await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('#link-preview')!;
      const counter = { shown: 0 };
      (window as typeof window & { previewShown: { shown: number } }).previewShown = counter;
      new MutationObserver(() => {
        if (!panel.hidden) counter.shown += 1;
      }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    });
    const shownCount = () =>
      page.evaluate(() => (window as typeof window & { previewShown: { shown: number } }).previewShown.shown);

    // --- Brushed past --------------------------------------------------------
    // Over the link and away again faster than the open delay, which is what
    // crossing a link on the way somewhere else looks like.
    //
    // Dispatched inside the page rather than driven through `page.mouse`, and
    // that is a correctness fix rather than a shortcut: two `mouse.move` calls
    // are two round trips, and on a loaded machine the gap between them can
    // exceed the open delay — so the gate would report a preview that opened
    // *because the harness was slow*, which is a flake in the direction of a
    // false failure. Timed in the page, the dwell is the thing under test rather
    // than the round-trip time. Hit testing is not what this gate is about and is
    // covered by the hover gate above, which drives a real pointer.
    //
    // The dwell is real rather than zero, so the events land in two separate
    // tasks. In one task a delay of zero would be indistinguishable from a
    // correct one — the timer could not have fired yet either way — and the gate
    // would pass for a preview that opens instantly.
    const BRUSH_DWELL_MS = 40;
    await page.evaluate(
      async ({ selector, dwell }) => {
        const link = document.querySelector<HTMLAnchorElement>(selector)!;
        const main = document.querySelector('main')!;
        const options = { bubbles: true, pointerType: 'mouse' };
        link.dispatchEvent(new PointerEvent('pointerover', { ...options, relatedTarget: main }));
        await new Promise((resolve) => setTimeout(resolve, dwell));
        link.dispatchEvent(new PointerEvent('pointerout', { ...options, relatedTarget: main }));
      },
      { selector: `a[href="${target}"]`, dwell: BRUSH_DWELL_MS },
    );
    // Several times the open delay, so a preview that was going to open has.
    await page.waitForTimeout(600);
    assert.equal(await shownCount(), 0, 'a link the pointer only crossed opened a preview anyway');

    // --- Shown, then left ----------------------------------------------------
    await page.locator(`a[href="${target}"]`).first().hover();
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('#link-preview')?.hidden === false,
      undefined,
      { timeout: 5_000 },
    );
    await page.mouse.move(1, VIEWPORT_HEIGHT_PX - 1);
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('#link-preview')?.hidden === true,
      undefined,
      { timeout: 5_000 },
    );
  } finally {
    await browserContext.close();
  }
}, 120_000);

/**
 * The payload is data at every step, never markup.
 *
 * Requirements section 14 forbids raw `innerHTML`, and the panel is built with
 * `document.createElement` plus `textContent` for exactly that reason. The gate
 * cannot see which method was called, so it feeds the payload a string that only
 * an HTML parser would treat as an element and asserts that no element appeared
 * and that the text survived verbatim. Mutation-tested: `textContent` swapped for
 * `innerHTML` fails here, and passes every other gate in this file.
 *
 * The payload is stubbed rather than authored into a corpus: the artifact
 * contract rejects markup like this, so the only honest way to prove the reader
 * is robust to it is to hand the reader a payload the contract would never emit.
 */
test('the preview renders its payload as text, never as markup', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  const EXCERPT = '<img src=x onerror="throw new Error(1)"><b>bold</b> & plain';
  const TITLE = '<i>Title</i>';
  const ALIAS = '<em>Older</em>';

  try {
    let route: string | undefined;
    let target = '';
    for (const candidate of routes) {
      await visit(page, candidate);
      const href = await page.evaluate(
        () => document.querySelector<HTMLAnchorElement>('a[href^="/notes/"]')?.getAttribute('href') ?? '',
      );
      if (href !== '') {
        route = candidate;
        target = href;
        break;
      }
    }
    assert.ok(route !== undefined, 'no built route carries a note link to hover');

    const slug = target.replaceAll(/^\/notes\/|\/$/g, '');
    await page.route('**/content-index.json', (route_) =>
      route_.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          entries: [{ slug, title: TITLE, excerpt: EXCERPT, aliases: [ALIAS] }],
        }),
      }),
    );

    await visit(page, route);
    await page.locator(`a[href="${target}"]`).first().hover();
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('#link-preview')?.hidden === false,
      undefined,
      { timeout: 5_000 },
    );

    const rendered = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('#link-preview')!;
      return {
        elements: [...panel.querySelectorAll('*')].map((node) => node.localName).sort(),
        title: panel.querySelector('strong')?.textContent ?? '',
        excerpt: panel.querySelector('p')?.textContent ?? '',
      };
    });

    assert.deepEqual(
      rendered.elements,
      ['p', 'strong'],
      'a payload string became elements in the panel, so it was parsed as markup',
    );
    assert.equal(rendered.title, `${TITLE} (${ALIAS})`, 'the title and alias were not rendered verbatim');
    assert.equal(rendered.excerpt, EXCERPT, 'the excerpt was not rendered verbatim');
  } finally {
    await browserContext.close();
  }
}, 120_000);

/**
 * A failed index request fails silently, and the next hover retries.
 *
 * The defect this replaces was the memoisation itself: `indexPromise ||= fetch()`
 * with no `catch` stored the *rejected* promise, so one failed request disabled
 * previews for the page's lifetime and logged an unhandled rejection on a site
 * whose gates require a clean console. Both halves are measured.
 */
test('a failed index request fails silently and is retried', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    let isFailing = true;
    await page.route('**/content-index.json', (route) =>
      isFailing ? route.fulfill({ status: 500, body: 'nope' }) : route.fallback(),
    );

    // `visit` fails the run on any console error, which is the very thing this
    // gate exists to prove absent — so the navigation is done directly and the
    // console is judged below rather than by the shared helper.
    //
    // Exactly one message is excluded: the browser's own transport log for the
    // stubbed request. Chromium prints "Failed to load resource: … 500" for any
    // failed request, from the network stack and before a line of page script
    // runs, and no application code can suppress it. It is matched by the URL it
    // is reported against, so a failure logged for anything else still fails.
    // What this gate is really about is the *second* message the old code
    // produced — an unhandled rejection from the memoised rejected promise —
    // which arrives as a `pageerror` and is collected here in full.
    const noise: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (message.location().url.endsWith('/content-index.json')) return;
      noise.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => noise.push(`uncaught: ${error.message}`));

    let route: string | undefined;
    let target = '';
    for (const candidate of routes) {
      await page.goto(`${origin}${candidate}`, { waitUntil: 'load' });
      const href = await page.evaluate(
        () => document.querySelector<HTMLAnchorElement>('a[href^="/notes/"]')?.getAttribute('href') ?? '',
      );
      if (href !== '') {
        route = candidate;
        target = href;
        break;
      }
    }
    assert.ok(route !== undefined, 'no built route carries a note link to hover');

    const link = page.locator(`a[href="${target}"]`).first();
    await link.hover();
    await page.waitForTimeout(600);
    assert.ok(
      await page.evaluate(() => document.querySelector<HTMLElement>('#link-preview')?.hidden !== false),
      'a failed index request still opened a preview',
    );
    assert.deepEqual(noise, [], 'a failed index request reported an error to the console');
    // The link the reader actually needs is untouched by the failure.
    assert.equal(await link.getAttribute('href'), target);

    // And the failure is not permanent: pointing at the link again retries.
    //
    // `mouse.move` off and back rather than `hover()` twice, because Playwright's
    // `hover` is a move to the element's centre and a move to where the pointer
    // already is dispatches nothing at all — the second call would be a no-op and
    // this gate would time out against correct code.
    isFailing = false;
    const box = (await link.boundingBox())!;
    await page.mouse.move(0, 0);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('#link-preview')?.hidden === false,
      undefined,
      { timeout: 5_000 },
    );
    assert.deepEqual(noise, [], 'the retry reported an error to the console');
  } finally {
    await browserContext.close();
  }
}, 120_000);

/**
 * The graph is complete and operable with scripting disabled.
 *
 * **This is the gate the whole ticket exists to pass.** Quartz's graph is three
 * empty `<div>`s plus roughly 525 KB brotli of d3 and PixiJS from a
 * third-party CDN, so with JavaScript off a reader sees nothing at all. Here
 * the figure is laid out at build time and every node is a real `<a>`, so
 * `javaScriptEnabled: false` must change nothing about it.
 *
 * What is measured, and why each half is needed:
 *
 * - The SVG renders at a real size. A figure present in the markup and laid out
 *   at zero height is invisible to a reader while passing every markup gate.
 * - Every node link has a real hit area and a resolvable `href`. A node drawn
 *   but not clickable is a picture, which is precisely what this replaces.
 * - The equivalent table opens and lists rows. Requirements section 17 requires
 *   it, and `<details>` is the native disclosure — so it must work with no
 *   script, which is the property the collection rail's own gate established.
 *
 * Checked at both widths because the figure sits in a scroll container: a
 * `max-width` that failed to engage would push the page past 320 px, and the
 * overflow gate above would then report it as somebody else's problem.
 */
test('the graph is drawn, linked, and operable with scripting disabled', async (context) => {
  const browser = requireBrowser(context);
  const browserContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: NARROWEST_PX, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    let figuresChecked = 0;
    let emptyStatesChecked = 0;

    for (const width of CASCADE_WIDTHS_PX) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT_PX });
      for (const route of routes.filter(
        (candidate) => candidate.startsWith('/notes/') || candidate === '/graph/',
      )) {
        await visit(page, route);
        const measured = await page.evaluate(() => {
          const box = (element: Element) => element.getBoundingClientRect();
          const region = document.querySelector<HTMLElement>('section.graph-region');
          if (region === null) return undefined;

          const svg = region.querySelector<SVGSVGElement>('svg.graph-svg');
          const emptyState = region.querySelector<HTMLElement>('.empty-state');
          if (svg === null) {
            return {
              hasFigure: false,
              emptyVisible: emptyState !== null && box(emptyState).height > 0,
              nodes: [],
              rows: 0,
              tableOpens: false,
              svgWidth: 0,
              svgHeight: 0,
            };
          }

          // The disclosure is opened the way a reader without scripting does:
          // by setting the attribute the browser itself toggles. Reading the
          // rows while it is shut would measure a collapsed subtree.
          const details = region.querySelector<HTMLDetailsElement>('details.graph-table');
          if (details !== null) details.open = true;

          return {
            hasFigure: true,
            emptyVisible: false,
            svgWidth: box(svg).width,
            svgHeight: box(svg).height,
            nodes: [...region.querySelectorAll<SVGAElement>('a.graph-node')].map((node) => {
              const rect = box(node);
              return {
                href: node.getAttribute('href') ?? '',
                name: node.getAttribute('aria-label') ?? '',
                width: rect.width,
                height: rect.height,
              };
            }),
            rows: region.querySelectorAll('details.graph-table tbody tr').length,
            tableOpens:
              details !== null &&
              [...details.querySelectorAll<HTMLElement>('tbody tr')].every(
                (row) => box(row).height > 0,
              ),
          };
        });

        assert.ok(measured !== undefined, `${route} at ${width}px: no graph region at all`);
        const where = `${route} at ${width}px`;

        if (!measured.hasFigure) {
          // A note with no neighbourhood says so. That is the published
          // corpus's own shape, so it is the state most readers of this site
          // actually meet — and it must be visible rather than a blank gap.
          assert.ok(measured.emptyVisible, `${where}: no figure and no visible empty state`);
          emptyStatesChecked += 1;
          continue;
        }

        assert.ok(measured.svgWidth > 0 && measured.svgHeight > 0, `${where}: the graph lays out at zero size`);
        assert.ok(measured.nodes.length > 0, `${where}: the graph draws no node links`);

        for (const node of measured.nodes) {
          assert.match(node.href, /^\/notes\/[^/]+\/$/, `${where}: node href "${node.href}" is not a note route`);
          assert.ok(node.name.trim() !== '', `${where}: a node link has no accessible name`);
          // Rendered at all, in both axes. Not a target-size check: WCAG 2.2's
          // 24 px minimum carries a spacing exception this measurement cannot
          // evaluate. What is caught here is a node that renders at zero size,
          // which is a link nobody can reach.
          assert.ok(
            node.width > 0 && node.height > 0,
            `${where}: the node "${node.name}" renders at zero size, so it cannot be clicked`,
          );
        }

        assert.ok(
          measured.rows === measured.nodes.length,
          `${where}: the table has ${measured.rows} rows for ${measured.nodes.length} drawn nodes`,
        );
        assert.ok(measured.tableOpens, `${where}: the equivalent table does not open without scripting`);
        figuresChecked += 1;
      }
    }

    // Both states must have been reached, or this gate is measuring one branch
    // and reporting on two. The published corpus has only the empty case, so
    // the figure half is asserted against the corpus rather than unconditionally.
    assert.ok(emptyStatesChecked > 0 || figuresChecked > 0, 'no graph region was inspected at all');
    assert.ok(
      figuresChecked > 0 || entries.every((entry) => localGraph(entry, getEntry).edges.length === 0),
      'no drawn graph was inspected and the corpus is not edge-free',
    );
  } finally {
    await browserContext.close();
  }
}, 180_000);

/**
 * Keyboard traversal reaches every node, in the documented order.
 *
 * The acceptance criterion says "a documented order", and the order is the
 * model's own: the subject first, then its neighbours by title then slug — the
 * same order `notesForSlugs` puts the outgoing and backlink lists in a few
 * inches up the page. That is what makes it documentable rather than incidental:
 * a reader tabbing through the figure meets the notes in the order the lists
 * above already named them.
 *
 * Driven with real `Tab` presses rather than by reading `tabindex`, because the
 * question is what the browser does. The expected order is resolved from the
 * model, never from the DOM being checked.
 */
test('the keyboard reaches every graph node, in the order the layout documents', async (context) => {
  const browser = requireBrowser(context);
  const drawn = entries.filter((entry) => localGraph(entry, getEntry).edges.length > 0);
  context.skip(
    drawn.length === 0,
    'no note draws a graph on this corpus — run `pnpm run build:fixture` for the traversal gate',
  );

  const browserContext = await browser.newContext({
    viewport: { width: CASCADE_WIDTHS_PX.at(-1)!, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    // One note is enough for a tab-order gate and the suite runs per built
    // route elsewhere; the busiest graph is the one where an ordering defect
    // would show. Chosen by drawn degree so the choice does not depend on the
    // corpus's own listing order.
    const subject = [...drawn].sort((a, b) => {
      const left = localGraph(a, getEntry).nodes.length;
      const right = localGraph(b, getEntry).nodes.length;
      return left !== right ? right - left : a.slug < b.slug ? -1 : 1;
    })[0]!;
    const expected = localGraph(subject, getEntry).nodes.map((node) => noteRoute(node.entry.slug));

    await visit(page, noteRoute(subject.slug));
    // Start from the scroll container that precedes the first node, so the
    // first `Tab` lands on a node rather than somewhere earlier in the page.
    await page.focus('.graph-canvas');

    const reached: string[] = [];
    for (let step = 0; step < expected.length + 2; step += 1) {
      await page.keyboard.press('Tab');
      const href = await page.evaluate(() => {
        const active = document.activeElement;
        return active !== null && active.classList.contains('graph-node')
          ? active.getAttribute('href')
          : undefined;
      });
      if (href === undefined || href === null) break;
      reached.push(href);
    }

    assert.deepEqual(
      reached,
      expected,
      `${subject.slug}: tabbing through the graph does not reach every node in the documented order`,
    );
  } finally {
    await browserContext.close();
  }
}, 120_000);

/**
 * The equivalent table is on the printed page, disclosure or not.
 *
 * Requirements section 17 asks for the graph's data as an equivalent list or
 * table. On screen that table is a `<details>`, because the same data twice in
 * a row is a long page — but a closed disclosure **prints closed**, which would
 * drop the equivalent representation from paper entirely and leave a printed
 * page carrying a picture and nothing a non-visual reader could use.
 *
 * **Measured with `checkVisibility()` under `media: print`, never with a box.**
 * A closed `<details>` hides its content with `content-visibility: hidden` on
 * `::details-content`, and such an element keeps a laid-out box — so
 * `getBoundingClientRect().height > 0` reports a hidden table as present. That
 * is not hypothetical here: two versions of the print rule shipped claiming in
 * a comment to open the table while leaving it hidden, and one of them was
 * "verified" by exactly that box measurement. The collection rail's gate above
 * records the same trap; this is the second element to meet it.
 *
 * Both directions, so the rule cannot pass by opening the table everywhere: on
 * screen the disclosure must still hide its content, or the `<details>` has
 * stopped being one.
 */
test('the graph table prints even when its disclosure is closed', async (context) => {
  const browser = requireBrowser(context);
  const drawn = entries.filter((entry) => localGraph(entry, getEntry).edges.length > 0);
  context.skip(
    drawn.length === 0,
    'no note draws a graph on this corpus — run `pnpm run build:fixture` for the print gate',
  );

  const browserContext = await browser.newContext({
    viewport: { width: CASCADE_WIDTHS_PX.at(-1)!, height: VIEWPORT_HEIGHT_PX },
  });
  const page = await browserContext.newPage();

  try {
    let inspected = 0;

    for (const route of [noteRoute(drawn[0]!.slug), '/graph/']) {
      if (!routes.includes(route)) continue;
      await visit(page, route);

      const measure = () =>
        page.evaluate(() => {
          const details = document.querySelector<HTMLDetailsElement>('details.graph-table');
          if (details === null) return undefined;
          const rows = [...details.querySelectorAll<HTMLElement>('tbody tr')];
          const summary = details.querySelector('summary');
          return {
            isOpen: details.open,
            rows: rows.length,
            visibleRows: rows.filter((row) => row.checkVisibility()).length,
            summaryVisible: summary?.checkVisibility() ?? false,
            marker: summary === null ? '' : getComputedStyle(summary).listStyleType,
          };
        });

      // Screen first: the disclosure must genuinely hide its content, or the
      // print assertion below proves nothing.
      const onScreen = await measure();
      if (onScreen === undefined) continue;
      assert.equal(onScreen.isOpen, false, `${route}: the table starts open, so the print case is untested`);
      assert.ok(onScreen.rows > 0, `${route}: the table has no rows to hide or print`);
      assert.ok(onScreen.summaryVisible, `${route}: the disclosure control is not visible to open`);
      assert.equal(
        onScreen.visibleRows,
        0,
        `${route}: a closed disclosure still shows its rows — it is not collapsing at all`,
      );

      await page.emulateMedia({ media: 'print' });
      const onPaper = await measure();
      assert.ok(onPaper !== undefined, `${route}: the table disappeared under print media`);
      assert.equal(
        onPaper.visibleRows,
        onPaper.rows,
        `${route}: ${onPaper.rows - onPaper.visibleRows} of ${onPaper.rows} table rows are absent from ` +
          'the printed page — the equivalent representation section 17 requires is not on paper',
      );
      // The caption stays: it names what the table is, and a printed page has
      // no other way to say so. Only its marker goes, which is what the print
      // rule's `list-style: none` does — a disclosure triangle on paper points
      // at an interaction nobody can perform.
      assert.ok(onPaper.summaryVisible, `${route}: the table's caption is missing from the printed page`);
      assert.equal(onPaper.marker, 'none', `${route}: the printed page shows a disclosure marker`);
      await page.emulateMedia({ media: 'screen' });
      inspected += 1;
    }

    assert.ok(inspected > 0, 'no graph table was inspected under print media');
  } finally {
    await browserContext.close();
  }
}, 120_000);
