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
 * Playwright's browser binary is a large download and `npm install` does not
 * fetch it. When it is absent these tests skip with the command that installs
 * it, so a fresh clone still gets a green `npm test` rather than a failure it
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

  const install = 'run `npx playwright install chromium` to run the rendered gates';
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
    assert.fail('dist/ is missing or unreadable — run `npm run build` before `npm test`');
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
});

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
 * published one-note corpus has none, so `npm test` never sees it and only
 * `npm run build:fixture` does.
 *
 * Each entry names the element whose subtree may overflow, not just the route,
 * so an unrelated defect on the same page still fails: a wide `<table>` reports
 * its own `<thead>`, `<tr>`, and `<td>` as overflowing too, and all of those are
 * the one deferred defect, while a `<pre>` or a `<div>` on the same page is not.
 * The list is checked in both directions: an unlisted overflow fails, and a
 * listed route that has *stopped* overflowing also fails, so an exemption cannot
 * outlive the defect it records.
 */
const KNOWN_OVERFLOW: Readonly<Record<string, string>> = {
  '/notes/content-contract/': 'table',
  '/notes/table-heavy-comparison/': 'table',
};

/** One element that extends past the viewport, as a reader would meet it. */
interface Overflow {
  scrollWidth: number;
  innerWidth: number;
  /** Overflowing elements outside the exempt subtree — what the gate judges. */
  culprits: string[];
  /** How many overflowing elements the exemption accounted for. */
  exemptCount: number;
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
      const isExempt = (element: HTMLElement) =>
        exemptSelector !== undefined &&
        (element.matches(exemptSelector) || element.closest(exemptSelector) !== null);

      const culprits = overflowing
        .filter((element) => !isExempt(element))
        .map((element) => {
          const right = Math.round(element.getBoundingClientRect().right);
          const name = element.id !== '' ? `#${element.id}` : `.${element.className || '(no class)'}`;
          return `<${element.localName}${name}> extends to ${right}px`;
        });

      return {
        scrollWidth: root.scrollWidth,
        innerWidth: window.innerWidth,
        culprits: culprits.slice(0, 5),
        exemptCount: overflowing.length - culprits.length,
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
          `${overflow.culprits.join('; ') || 'no element could be named as the cause'}`,
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
