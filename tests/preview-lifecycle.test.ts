/**
 * Shared-lifecycle evidence for the lazy preview Worker (goal 0003, row 3).
 *
 * The lifecycle contract (`docs/core-design/build-and-runtime.md`, "Lazy Worker
 * lifecycle") requires one Worker and one initialization promise per
 * document/snapshot, a dismissed preview whose late reply cannot attach to a
 * different link, a Worker released on teardown, and a snapshot change that
 * invalidates the old binding. Each test plants the race it needs and confirms
 * the plant was actually delivered before asserting the control worked: a
 * constructed hold is not an observed one (`docs/gate-reading.md`).
 *
 * Everything runs in a real Chromium against a corpus built and served with the
 * headers `public/_headers` declares, so the Worker, the WASM, and the snapshot
 * also run under the deployed CSP.
 *
 * Corpus: `alpha` links `beta` and `gamma`; `gamma` links `alpha` and `beta`.
 * The links on `gamma` are what make "dismiss A, focus B, deliver A late"
 * driveable from a page whose own route is neither A nor B — a link to the open
 * page is deliberately not previewable, so the alpha page cannot carry a link to
 * alpha.
 */

import { basename } from 'node:path';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';

import {
  buildAndServe,
  buildIn,
  buildSite,
  collectPageErrors,
  countWorkerTerminations,
  focusByTab,
  removeWorkspace,
  serveDist,
  sqliteAssetRequests,
  workerTerminations,
  workerScriptPath,
  type RunningSite,
} from './support/browser-site.ts';
import { snapshotPath } from './support/snapshot.ts';

/**
 * The corpus, parameterized by alpha's title so the snapshot-replacement test
 * can rebuild the same workspace with different bytes.
 */
function corpus(alphaTitle: string): Record<string, string> {
  return {
    'alpha.md': `---\ntitle: "${alphaTitle}"\n---\n\n# ${alphaTitle}\n\nAlpha links to [[beta]] and [[gamma]].\n`,
    'beta.md': '---\ntitle: "Beta One"\n---\n\n# Beta One\n\nBeta body text for previews.\n',
    'gamma.md': '---\ntitle: "Gamma"\n---\n\n# Gamma\n\nGamma links to [[alpha]] and [[beta]].\n',
  };
}

/** A panel visibility transition recorded from inside the page. */
interface PanelVisibleEntry {
  text: string;
  at: number;
}

let site: RunningSite;
let browser: Browser;

beforeAll(async () => {
  site = await buildAndServe(corpus('Alpha One'));
  const { chromium } = await import('playwright');
  // No skip when Chromium is missing: a skipped browser test is not goal
  // evidence, so a missing binary fails the file loudly.
  browser = await chromium.launch();
  // Goal 0003's completion evidence asks for the browser this was measured on.
  console.log(`browser: ${browser.browserType().name()} ${browser.version()}`);
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
}, 180_000);

/**
 * Hold every `preview` message for `alpha` inside the page until released.
 *
 * The patch keeps the *message*, not the fetch: the Worker is already
 * constructed by the time `show()` posts, so this plant exercises the
 * consumer's late-reply guard — the dismissed link is no longer `current` in
 * `link-preview.ts` — rather than a network delay. The release function is
 * exposed on `window` because the test must decide when the late reply lands.
 */
async function holdAlphaPreview(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as {
      __heldAlpha: boolean;
      __alphaDeliveredAt: number;
      __releaseHeldAlpha(): void;
      __restorePreviewPatch(): void;
    };
    state.__heldAlpha = false;
    state.__alphaDeliveredAt = -1;
    const original = Worker.prototype.postMessage;
    let held: { worker: Worker; message: unknown } | undefined;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]): void {
      const data = message as { type?: unknown; slug?: unknown };
      if (data.type === 'preview' && data.slug === 'alpha') {
        held = { worker: this, message };
        state.__heldAlpha = true;
        return;
      }
      (original as (this: Worker, ...args: unknown[]) => void).call(this, message, ...rest);
    };
    state.__releaseHeldAlpha = (): void => {
      if (held === undefined) return;
      state.__alphaDeliveredAt = performance.now();
      (original as (this: Worker, ...args: unknown[]) => void).call(held.worker, held.message);
      held = undefined;
    };
    state.__restorePreviewPatch = (): void => {
      Worker.prototype.postMessage = original;
    };
  });
}

/**
 * Record every time the panel becomes visible, with its text and page time.
 *
 * A "still visible at the end" check cannot see a panel that flickered to the
 * wrong note in between; the observer can, and it also gives the keyboard path a
 * timestamp to compare against the released reply.
 */
async function installPanelTimeline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { __panelTimeline: PanelVisibleEntry[] };
    state.__panelTimeline = [];
    const panel = document.querySelector<HTMLElement>('#link-preview');
    if (panel === null) throw new Error('#link-preview is absent, so the panel timeline would measure nothing');
    new MutationObserver(() => {
      if (!panel.hidden) state.__panelTimeline.push({ text: panel.textContent ?? '', at: performance.now() });
    }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  });
}

async function panelTimeline(page: Page): Promise<PanelVisibleEntry[]> {
  return page.evaluate(() => (window as unknown as { __panelTimeline: PanelVisibleEntry[] }).__panelTimeline);
}

/** The page-side state the hold plant exposes. */
async function holdState(page: Page): Promise<{ held: boolean; deliveredAt: number }> {
  return page.evaluate(() => {
    const state = window as unknown as { __heldAlpha: boolean; __alphaDeliveredAt: number };
    return { held: state.__heldAlpha, deliveredAt: state.__alphaDeliveredAt };
  });
}

test('concurrent intent initializes one Worker and one snapshot download', async () => {
  const page = await browser.newPage();
  const requests = sqliteAssetRequests(page);
  const dbStarts: number[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/data/site.')) dbStarts.push(Date.now());
  });

  // The hold: the route handler parks inside `await held` and the browser's DB
  // fetch cannot complete until the test releases it. `routeEntered` resolves
  // only from inside that handler, so awaiting it proves the hold was delivered
  // rather than merely constructed.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markRouteEntered: () => void = () => {};
  const routeEntered = new Promise<void>((resolve) => {
    markRouteEntered = resolve;
  });
  await page.route('**/data/site.*', async (route) => {
    markRouteEntered();
    await held;
    await route.continue();
  });

  try {
    await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
    await page.locator('a[href="/notes/beta/"]').first().hover();

    const entered = await Promise.race([
      routeEntered.then(() => true),
      page.waitForTimeout(5_000).then(() => false),
    ]);
    assert.ok(entered, 'the held DB route never received the first request, so the race control is vacuous');
    assert.equal(dbStarts.length, 1, 'the first hover did not start exactly one snapshot download');

    // A second intent 250 ms later: its open delay has fired, and its request is
    // behind the same still-held download. One worker means the second request
    // must arrive on the first worker's queue, not start a second download.
    await page.locator('a[href="/notes/gamma/"]').first().hover();
    await page.waitForTimeout(250);
    assert.equal(dbStarts.length, 1, 'a concurrent preview intent started a second snapshot download');
    assert.equal(
      await page.locator('#link-preview').isHidden(),
      true,
      'a panel appeared while the snapshot download was still held, so the hold was not real',
    );

    release();
    const panel = page.locator('#link-preview');
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    const text = (await panel.textContent()) ?? '';
    assert.ok(text.includes('Gamma'), `the surviving intent did not preview gamma: ${JSON.stringify(text)}`);

    assert.equal(dbStarts.length, 1, 'the second reply triggered a second snapshot download');
    const wasm = requests.filter((url) => url.includes('/wasm/'));
    assert.equal(
      wasm.filter((url) => url.endsWith('.wasm')).length,
      1,
      'concurrent intent downloaded the WASM binary more than once',
    );
    assert.equal(
      wasm.filter((url) => url.endsWith('.js')).length,
      1,
      'concurrent intent imported the WASM module entry more than once',
    );
    assert.equal(
      requests.filter((url) => /\/_astro\/snapshot-worker-[\w-]+\.js$/.test(url)).length,
      1,
      'concurrent intent fetched the Worker chunk more than once',
    );
    assert.equal(
      page.workers().filter((worker) => worker.url().includes('snapshot-worker-')).length,
      1,
      'the document holds more than one snapshot Worker',
    );
  } finally {
    // Guarded release: a failing assertion above must not leave the route
    // hanging and turn a real failure into a timeout.
    release();
    await page.close();
  }
}, 120_000);

test('a dismissed preview delivered late cannot open or replace the focused one', async () => {
  const page = await browser.newPage();
  await holdAlphaPreview(page);
  try {
    await page.goto(`${site.origin}/notes/gamma/`, { waitUntil: 'load' });
    await installPanelTimeline(page);

    // Intent A: hover the alpha link. Its message is captured inside the page.
    await page.locator('a[href="/notes/alpha/"]').first().hover();
    await page.waitForFunction(
      () => (window as unknown as { __heldAlpha?: boolean }).__heldAlpha === true,
      undefined,
      { timeout: 5_000 },
    );

    // Dismiss A: the pointer leaves and the intent is cancelled. The request is
    // still pending, which is the entire point — nothing has settled it.
    await page.mouse.move(0, 0);
    await page.locator('#link-preview').waitFor({ state: 'hidden', timeout: 5_000 });

    // Intent B: a real keyboard reader Tabs to the beta link. Programmatic
    // `focus()` is not equivalent: the client gates on `:focus-visible`, so the
    // test drives the same real presses a keyboard produces.
    const reached = await focusByTab(page, '/notes/beta/');
    assert.ok(reached, 'tabbing never reached the beta link, so the keyboard path was not measured');
    const panel = page.locator('#link-preview');
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    const beforeRelease = (await panel.textContent()) ?? '';
    assert.ok(beforeRelease.includes('Beta One'), `focusing beta did not preview it: ${JSON.stringify(beforeRelease)}`);

    // Deliver A late. The consumer's identity guard must drop it: `current` is
    // beta.
    await page.evaluate(() => (window as unknown as { __releaseHeldAlpha(): void }).__releaseHeldAlpha());
    await page.waitForTimeout(500);
    const afterRelease = (await panel.textContent()) ?? '';
    assert.equal(await panel.isVisible(), true, 'the late reply closed the focused preview');
    assert.ok(afterRelease.includes('Beta One'), `the late reply replaced the focused preview: ${JSON.stringify(afterRelease)}`);
    assert.ok(
      !afterRelease.includes('Alpha One'),
      `the dismissed preview's late reply opened over the focused one: ${JSON.stringify(afterRelease)}`,
    );

    const timeline = await panelTimeline(page);
    assert.ok(timeline.length >= 1, 'the panel never became visible, so the timeline is vacuous');
    const last = timeline.at(-1)!;
    assert.ok(last.text.includes('Beta One'), `the last visible panel was not beta: ${JSON.stringify(last.text)}`);
    assert.ok(
      timeline.every((entry) => !entry.text.includes('Alpha One')),
      'the dismissed preview became visible at some point despite the late guard',
    );

    const state = await holdState(page);
    assert.ok(state.deliveredAt > 0, 'the held alpha message was never delivered');
    const betaAppearedAt = timeline.find((entry) => entry.text.includes('Beta One'))!.at;
    assert.ok(
      state.deliveredAt > betaAppearedAt,
      'alpha was delivered before beta appeared, so the late-reply race was not actually run',
    );
  } finally {
    // Clean up the patch state so nothing survives into a later navigation on
    // this page.
    await page.evaluate(() => (window as unknown as { __restorePreviewPatch?(): void }).__restorePreviewPatch?.());
    await page.close();
  }
}, 120_000);

test('pagehide terminates the Worker, releases what it owed, and reinitializes on a later intent', async () => {
  const page = await browser.newPage();
  await countWorkerTerminations(page);
  const pageErrors = collectPageErrors(page);
  try {
    await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
    const panel = page.locator('#link-preview');
    await page.locator('a[href="/notes/beta/"]').first().hover();
    await panel.waitFor({ state: 'visible', timeout: 10_000 });

    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden', timeout: 5_000 });
    // The pointer must leave and come back: a second `hover()` on the still
    // hovered link would not produce a fresh `pointerover`, so there would be no
    // intent to retry at all.
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.waitForFunction(
      () => (window as unknown as { __terminateCount?: number }).__terminateCount === 1,
      undefined,
      { timeout: 5_000 },
    );

    // A later intent must reinitialize from scratch: the teardown may not leave
    // a poisoned state that refuses or hangs the retry.
    await page.locator('a[href="/notes/beta/"]').first().hover();
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    assert.ok(((await panel.textContent()) ?? '').includes('Beta One'), 'the reinitialized Worker did not preview');
    assert.equal(
      await workerTerminations(page),
      1,
      'the reinitialized preview terminated or reused a Worker without replacing it',
    );
    assert.deepEqual(pageErrors, [], 'pagehide lifecycle produced an uncaught page error');
  } finally {
    await page.close();
  }
}, 120_000);

test('a real navigation fires pagehide, terminates the Worker, and a later intent reinitializes', async () => {
  const page = await browser.newPage();
  const pageErrors = collectPageErrors(page);
  // `countWorkerTerminations` keeps its count on `window`, which dies with the
  // document a real navigation tears down. `sessionStorage` survives same-origin
  // navigations, so the teardown the browser performs is still observable from
  // the document that replaces it.
  await page.addInitScript(() => {
    const original = Worker.prototype.terminate;
    Worker.prototype.terminate = function (this: Worker): void {
      const count = Number(sessionStorage.getItem('__terminations') ?? '0');
      sessionStorage.setItem('__terminations', String(count + 1));
      original.call(this);
    };
  });
  try {
    await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
    const panel = page.locator('#link-preview');
    await page.locator('a[href="/notes/beta/"]').first().hover();
    await panel.waitFor({ state: 'visible', timeout: 10_000 });

    // A real document navigation, not a synthetic `PageTransitionEvent`: the
    // browser fires `pagehide` on the outgoing document, which is the teardown
    // the client hangs `dispose()` on.
    await page.goto(`${site.origin}/notes/beta/`, { waitUntil: 'load' });
    assert.equal(
      await page.evaluate(() => Number(sessionStorage.getItem('__terminations') ?? '0')),
      1,
      'a real navigation did not terminate the preview Worker',
    );

    // Back to the first route. Whether Chromium rebuilt or bfcache-restored the
    // document, the terminated Worker cannot be reused, so the next explicit
    // intent must start a fresh one and preview from it.
    await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
    await page.locator('a[href="/notes/beta/"]').first().hover();
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    assert.ok(
      ((await panel.textContent()) ?? '').includes('Beta One'),
      'the Worker after a real navigation did not preview',
    );
    assert.equal(
      await page.evaluate(() => Number(sessionStorage.getItem('__terminations') ?? '0')),
      1,
      'the reinitialized preview terminated a Worker without replacing it',
    );
    assert.deepEqual(pageErrors, [], 'real-navigation teardown produced an uncaught page error');
  } finally {
    await page.close();
  }
}, 120_000);

test('pagehide while a preview is held settles it without ever showing a panel', async () => {
  const page = await browser.newPage();
  await countWorkerTerminations(page);
  await holdAlphaPreview(page);
  const pageErrors = collectPageErrors(page);
  try {
    await page.goto(`${site.origin}/notes/gamma/`, { waitUntil: 'load' });
    await installPanelTimeline(page);
    await page.locator('a[href="/notes/alpha/"]').first().hover();
    await page.waitForFunction(
      () => (window as unknown as { __heldAlpha?: boolean }).__heldAlpha === true,
      undefined,
      { timeout: 5_000 },
    );

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.waitForFunction(
      () => (window as unknown as { __terminateCount?: number }).__terminateCount === 1,
      undefined,
      { timeout: 5_000 },
    );

    // Deliver the message teardown already cancelled. The client must drop it:
    // the pending entry was rejected, and the message's Worker is gone.
    await page.evaluate(() => (window as unknown as { __releaseHeldAlpha(): void }).__releaseHeldAlpha());
    await page.waitForTimeout(500);
    assert.equal(
      await page.locator('#link-preview').isHidden(),
      true,
      'a preview held across pagehide became visible after teardown',
    );
    assert.deepEqual(await panelTimeline(page), [], 'the panel flickered visible even though teardown cancelled the intent');
    assert.deepEqual(pageErrors, [], 'the cancelled late reply produced an uncaught page error');
  } finally {
    await page.evaluate(() => (window as unknown as { __restorePreviewPatch?(): void }).__restorePreviewPatch?.());
    await page.close();
  }
}, 120_000);

test('a replaced served snapshot changes the bound digest and the previewed title', async () => {
  // The file's beforeAll already built this corpus; only the replacement build
  // below is new. Serving the existing dist again avoids a second identical
  // `anc build` merely to get a `serve()` handle.
  const running = await serveDist(site.dist);
  let firstContext: BrowserContext | undefined;
  let secondContext: BrowserContext | undefined;
  try {
    const digestA = basename(snapshotPath(running.dist));

    firstContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    const firstRequests = sqliteAssetRequests(firstPage);
    await firstPage.goto(`${running.origin}/notes/gamma/`, { waitUntil: 'load' });
    const firstPanel = firstPage.locator('#link-preview');
    await firstPage.locator('a[href="/notes/alpha/"]').first().hover();
    await firstPanel.waitFor({ state: 'visible', timeout: 10_000 });
    assert.ok(
      ((await firstPanel.textContent()) ?? '').includes('Alpha One'),
      'the first build did not preview its own title',
    );
    assert.ok(
      firstRequests.some((url) => url.endsWith(digestA)),
      'the first page never fetched the digest it was bound to, so the digest observation is vacuous',
    );
    await firstContext.close();
    firstContext = undefined;

    // A static document cannot change its binding in place: the snapshot URL is
    // compiled into the page (and the Worker chunk), so a snapshot change is a
    // new build served at the same origin. Rebuild the same workspace, then
    // replace what the server hands out.
    const rebuilt = buildIn(site.workspace, corpus('Alpha Two'), 'dist2');
    const digestB = basename(snapshotPath(rebuilt.dist));
    assert.notEqual(digestB, digestA, 'the rebuilt snapshot has the same digest, so the replacement was not a change');
    running.serve(rebuilt.dist);

    // Fresh context: the second load must prove its own binding rather than
    // inherit the first load's cached bytes.
    secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    const secondRequests = sqliteAssetRequests(secondPage);
    await secondPage.goto(`${running.origin}/notes/gamma/`, { waitUntil: 'load' });
    const secondPanel = secondPage.locator('#link-preview');
    await secondPage.locator('a[href="/notes/alpha/"]').first().hover();
    await secondPanel.waitFor({ state: 'visible', timeout: 10_000 });
    assert.ok(
      ((await secondPanel.textContent()) ?? '').includes('Alpha Two'),
      'the replaced build previewed a stale title',
    );

    const secondDatabaseUrls = secondRequests.filter((url) => url.includes('/data/site.'));
    assert.equal(secondDatabaseUrls.length, 1, 'the second load did not fetch exactly one snapshot');
    assert.ok(
      secondDatabaseUrls[0]!.endsWith(digestB),
      `the second load fetched ${secondDatabaseUrls[0]!}, not its own binding ${digestB}`,
    );
    assert.ok(
      !secondDatabaseUrls.some((url) => url.endsWith(digestA)),
      'the second load fetched the replaced snapshot, so the old binding survived the change',
    );
  } finally {
    await firstContext?.close();
    await secondContext?.close();
    // The workspace belongs to `site` and its afterAll; `running` only owns the
    // server it opened over the same bytes.
    await running.close();
  }
}, 180_000);

test('a page bound to a snapshot that vanished falls back without fetching the replacement', async () => {
  // Two independent builds in their own workspaces: the page's compiled
  // binding names A's digest, and the replacement deployment B has a different
  // one. `serve` then swaps what the origin hands out, which is what a
  // redeploy at a fixed origin is from the browser's side.
  const siteA = buildSite({
    'alpha.md': '---\ntitle: "Alpha One"\n---\n\n# Alpha One\n\nAlpha links to [[beta]].\n',
    'beta.md': '---\ntitle: "Beta One"\n---\n\n# Beta One\n\nBeta body text for previews.\n',
  });
  const siteB = buildSite({
    'alpha.md': '---\ntitle: "Alpha Two"\n---\n\n# Alpha Two\n\nAlpha Two links to [[beta]].\n',
    'beta.md': '---\ntitle: "Beta Two"\n---\n\n# Beta Two\n\nDifferent bytes, so a different digest.\n',
  });
  const running = await serveDist(siteA.dist);
  const digestA = basename(snapshotPath(siteA.dist));
  const digestB = basename(snapshotPath(siteB.dist));
  assert.notEqual(
    digestB,
    digestA,
    'both builds produced the same snapshot digest, so replacing the output changed nothing',
  );

  const page = await browser.newPage();
  const requests = sqliteAssetRequests(page);
  // The runtime recorder only sees SQLite assets; the full stream makes "no
  // request ever names digestB" literal across everything the page asks for.
  const everyRequest: string[] = [];
  page.on('request', (request) => everyRequest.push(request.url()));

  try {
    await page.goto(`${running.origin}/notes/alpha/`, { waitUntil: 'load' });
    await installPanelTimeline(page);

    // A returning reader's cache, made observable rather than assumed. The
    // Worker chunk is content-hashed and served under `/_astro/*`'s immutable
    // rule, so a reader who visited A before the redeploy still has it locally;
    // its bytes embed A's snapshot URL, so B's rebuild gives it a different
    // name and it 404s at the origin. Measured: without this warm-up the Worker
    // never starts, the page issues zero `/data/site.` requests, and the
    // "never substitute a different DB" rule below would be asserted against
    // nothing. The warm GET's status is asserted so a cache state that was
    // never established cannot pass as one.
    const chunk = workerScriptPath(siteA.dist);
    const warmStatus = await page.evaluate(async (url: string) => (await fetch(url)).status, chunk);
    assert.equal(
      warmStatus,
      200,
      `the Worker chunk warm-up for ${chunk} returned ${warmStatus}, so the cached-page premise is not established`,
    );

    // The redeploy. A's files are gone from the origin; B's are now served.
    running.serve(siteB.dist);

    // Environment controls from the test process, not the page: A's snapshot
    // must actually 404 and B's must actually exist, or the scenario is not
    // the one the assertions below describe. These probes are not page
    // requests and cannot satisfy either recorder.
    const gone = await fetch(`${running.origin}/data/${digestA}`);
    assert.equal(gone.status, 404, `A's snapshot still answered ${gone.status} after the replacement`);
    await gone.body?.cancel();
    const present = await fetch(`${running.origin}/data/${digestB}`);
    assert.equal(present.status, 200, `B's snapshot answered ${present.status}, so there was no replacement to find`);
    await present.body?.cancel();

    // One explicit intent after the redeploy. The page still binds A; a
    // runtime that resolved "latest DB" or retried against a sibling URL would
    // fetch B here.
    const dbAnswer = page.waitForResponse((response) => response.url().includes('/data/site.'), {
      timeout: 15_000,
    });
    await page.locator('a[href="/notes/beta/"]').first().hover();
    const answer = await dbAnswer;
    assert.equal(
      answer.status(),
      404,
      `the page's bound snapshot answered ${answer.status()}, so failure fallback was not exercised`,
    );

    // Let the Worker's failure settle through the client before judging the UI.
    await page.waitForTimeout(500);

    const panel = page.locator('#link-preview');
    assert.equal(await panel.isHidden(), true, 'the preview panel opened from a snapshot that no longer exists');
    assert.deepEqual(
      await panelTimeline(page),
      [],
      'the panel flickered visible at some point even though the bound snapshot was gone',
    );
    const article = (await page.locator('article').textContent()) ?? '';
    assert.ok(article.includes('Alpha links to'), 'the static article text did not survive the failed preview');
    assert.equal(
      await page.locator('a[href="/notes/beta/"]').first().getAttribute('href'),
      '/notes/beta/',
      'the anchor stopped being a normal static link',
    );

    const dbRequests = requests.filter((url) => url.includes('/data/site.'));
    assert.equal(
      dbRequests.length,
      1,
      `expected exactly one snapshot request (the page's own binding), saw ${dbRequests.length}: ${dbRequests.join(', ')}`,
    );
    assert.ok(
      dbRequests[0]!.endsWith(digestA),
      `the page fetched ${dbRequests[0]!}, not its own binding ${digestA}`,
    );
    assert.ok(
      !everyRequest.some((url) => url.includes(digestB)),
      `a request named the replacement snapshot ${digestB}: ${everyRequest.filter((url) => url.includes(digestB)).join(', ')}`,
    );
  } finally {
    await page.close();
    await running.close();
    removeWorkspace(siteA.workspace);
    removeWorkspace(siteB.workspace);
  }
}, 180_000);
