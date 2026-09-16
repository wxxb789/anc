/**
 * Goal 0003 evaluation row 1 — intent and lazy cost, in a real browser.
 *
 * Proves both halves of that row against an actual generated site served under
 * the shipped CSP, so the Worker, WASM, and snapshot are exercised under the
 * policy they ship with:
 *
 * 1. **Ordinary reading is free.** Loading an article and scrolling through the
 *    whole document — including the graph region — must request zero SQLite
 *    bytes, no Worker chunk, no WASM, and no snapshot DB. The defect this
 *    prevents is a reader paying for a database they never asked for, which is
 *    the lazy lifecycle `docs/core-design/build-and-runtime.md` states: reading
 *    and scrolling alone are not database intent, and a scroll past a graph
 *    does not start it.
 * 2. **Only intent starts it.** An eligible hover after its delay, and real
 *    keyboard focus on an eligible link, must start the shared Worker and show
 *    the target; and the link must still be a real anchor that navigates. The
 *    defect this prevents is the opposite one: an enhancement that is lazy to
 *    the point of never starting, or that intercepts the click it decorates.
 *
 * The instrument is `sqliteAssetRequests` from `tests/support/browser-site.ts`,
 * which counts the Worker chunk as well as the DB and WASM. A filter over the
 * DB alone would report zero for a page that eagerly started its Worker, so the
 * lazy claim is only as strong as the instrument's coverage — which is why this
 * gate also asserts the instrument is not vacuous, using the exact Worker path
 * this build emitted, an intent-triggered preview, and then navigation.
 *
 * A skipped browser test is not evidence (goal 0003 says so), so nothing here
 * skips: `buildAndServe` and the dynamic `playwright` import fail the beforeAll
 * when Chromium or the build is unavailable.
 */

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser } from 'playwright';

import {
  buildAndServe,
  focusByTab,
  removeWorkspace,
  sqliteAssetRequests,
  workerScriptPath,
  type RunningSite,
} from './support/browser-site.ts';

/**
 * Alpha links two notes, so its page draws a graph — which the scroll half of
 * the gate needs. Gamma has no body on purpose: an empty excerpt must not stop
 * the focus path from opening a panel.
 */
const CORPUS = {
  'alpha.md': '# Alpha\n\nLinks to [[beta]] and [[gamma]].\n',
  'beta.md': '# Beta\n\nBeta body text.\n',
  'gamma.md': '# Gamma\n',
};

let site: RunningSite;
let browser: Browser;

beforeAll(async () => {
  site = await buildAndServe(CORPUS);
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
}, 180_000);

test('ordinary reading and scrolling past a graph stay lazy, and intent starts the preview', async () => {
  const page = await browser.newPage();
  // Goal 0003's completion evidence asks for the browser this was measured on.
  console.log(`browser: ${browser.browserType().name()} ${browser.version()}`);

  // Two instruments over one request stream. The SQLite one starts before the
  // first navigation, because an eager runtime would show up on the load
  // itself; the all-requests one is for the same-origin check at the end.
  const sqlite = sqliteAssetRequests(page);
  const allRequests: string[] = [];
  page.on('request', (request) => allRequests.push(request.url()));

  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  assert.deepEqual(sqlite, [], 'an ordinary article load requested SQLite assets before any intent');

  // Positive control for the scroll below: without a drawn graph on this page,
  // "scrolling past a graph costs nothing" would measure an empty page and pass
  // for the wrong reason. Waiting rather than sampling once, because the graph
  // client arrives as a runtime dynamic import.
  const activate = page.locator('[data-graph-activate]');
  await activate.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(
    await activate.isVisible(),
    true,
    'the article offers no graph explorer, so the scroll check would be vacuous',
  );

  // Scroll through the whole document, including the graph region, and back.
  // `dismissIfShowing` runs on every scroll and must dismiss only a shown panel;
  // it must not start the runtime, which is what the empty list below holds.
  const documentHeight = await page.evaluate(() => document.body.scrollHeight);
  const scrollSteps = 8;
  let graphRegionSeen = false;
  for (let step = 1; step <= scrollSteps; step += 1) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.round((documentHeight * step) / scrollSteps));
    graphRegionSeen ||= await page.evaluate(() => {
      const region = document.querySelector('.graph-region');
      if (region === null) return false;
      const rect = region.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });
  }
  assert.equal(
    graphRegionSeen,
    true,
    'the scroll never reached the graph region, so passing over it was not measured',
  );
  for (let step = scrollSteps - 1; step >= 0; step -= 1) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.round((documentHeight * step) / scrollSteps));
  }
  await page.waitForTimeout(300);
  assert.deepEqual(sqlite, [], 'scrolling past the graph started the SQLite runtime without intent');

  // --- Intent starts the enhancement ---------------------------------------
  // The instrument could be blind as easily as the page could be lazy, so the
  // same list has to fill with the exact runtime after one hover. The Worker
  // chunk is what proves no eager Worker hid behind a DB-shaped filter.
  const betaLinks = page.locator('a[href="/notes/beta/"]');
  assert.ok((await betaLinks.count()) >= 1, 'the corpus did not render the beta link');
  const beta = betaLinks.first();
  assert.equal(sqlite.length, 0, 'SQLite assets were requested before the hover');
  await beta.hover();
  const panel = page.locator('#link-preview');
  await panel.waitFor({ state: 'visible', timeout: 10_000 });

  const workerPath = workerScriptPath(site.dist);
  const observed = sqlite.map((url) => {
    const parsed = new URL(url);
    return { origin: parsed.origin, path: parsed.pathname };
  });
  // Printed so the actual Worker, WASM, and snapshot paths of this build are in
  // the run's output, which goal 0003's completion evidence asks to record.
  console.log(`snapshot runtime requests: ${observed.map((entry) => entry.path).join(', ')}`);
  assert.ok(
    observed.some((entry) => entry.origin === site.origin && entry.path === workerPath),
    `the shared Worker chunk ${workerPath} was not requested: ${observed.map((entry) => entry.path).join(', ')}`,
  );
  assert.ok(
    observed.some((entry) => entry.origin === site.origin && /^\/data\/site\.[0-9a-f]{64}\.sqlite$/.test(entry.path)),
    `no digest-named snapshot was requested: ${observed.map((entry) => entry.path).join(', ')}`,
  );
  assert.ok(
    observed.some((entry) => entry.origin === site.origin && /^\/wasm\/.+\.wasm$/.test(entry.path)),
    `no WASM module was requested: ${observed.map((entry) => entry.path).join(', ')}`,
  );

  // --- The hover delay is a delay, not a euphemism --------------------------
  // A panel that ignores `OPEN_DELAY_MS` (120 ms) flashes over the page every
  // time the pointer crosses a link on the way somewhere else. 60 ms must not
  // open it; the bounded wait after that is the proof it does open.
  await page.mouse.move(0, 0);
  await panel.waitFor({ state: 'hidden', timeout: 5_000 });
  await beta.hover();
  await page.waitForTimeout(60);
  assert.equal(await panel.isHidden(), true, 'the panel opened inside the 120 ms hover-intent delay');
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  assert.ok(
    ((await panel.textContent()) ?? '').includes('Beta'),
    'the hover preview did not show the target note after its delay',
  );

  // --- Keyboard focus is intent too -----------------------------------------
  // Real `Tab` presses rather than `locator.focus()`, mirroring the recipe
  // verified in `tests/rendered-page.test.ts`: the client gates on
  // `:focus-visible`, and programmatic focus does not set it, so a gate that
  // focused directly would pass while every keyboard reader got nothing.
  await page.mouse.move(0, 0);
  await panel.waitFor({ state: 'hidden', timeout: 5_000 });
  const reached = await focusByTab(page, '/notes/gamma/', 60);
  assert.ok(reached, 'tabbing never reached the gamma link, so the keyboard path was not measured');
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  assert.ok(
    ((await panel.textContent()) ?? '').includes('Gamma'),
    'keyboard focus did not preview the focused link',
  );

  // --- A preview never replaces the link ------------------------------------
  // Escape first, so the click cannot be intercepted by a panel that happens to
  // be open: what navigates has to be the anchor's own action.
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden', timeout: 5_000 });
  await beta.click();
  await page.waitForURL('**/notes/beta/', { timeout: 10_000 });
  assert.equal(
    page.url(),
    `${site.origin}/notes/beta/`,
    'following a previewed link did not navigate to its exact target URL',
  );
  assert.ok(
    ((await page.locator('article').textContent()) ?? '').includes('Beta body text.'),
    'the navigation did not land on the target note',
  );

  // --- Everything the runtime touched is on this site's own origin ----------
  // The contract is same-origin assets under `connect-src 'self'`: an off-origin
  // Worker, WASM, or snapshot would violate the policy this site claims to run
  // under. Asserted non-empty so a stream that recorded nothing cannot pass.
  assert.ok(allRequests.length > 0, 'no request was recorded, so the same-origin check proves nothing');
  for (const url of allRequests) {
    assert.equal(new URL(url).origin, site.origin, `a request left the site origin: ${url}`);
  }

  await page.close();
}, 120_000);
