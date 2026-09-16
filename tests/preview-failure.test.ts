/**
 * Failure and retry evidence for the lazy snapshot preview.
 *
 * Goal 0003's "Failure and retry" row (`docs/goals/archive/0003-reliable-lazy-previews.md`)
 * requires each failure path to be blocked *separately* — DB fetch, WASM, Worker
 * startup — and a deadline to be forced, with the static article staying usable
 * and a later explicit intent succeeding. `tests/snapshot-runtime.test.ts`
 * already blocks the DB fetch; this file covers the two startup paths it leaves
 * open — a blocked WASM download and a Worker constructor that throws — plus a
 * dispatched request the Worker never answers.
 *
 * The lifecycle contract exercised here is
 * `docs/core-design/build-and-runtime.md`, "Lazy Worker lifecycle" and "Failure,
 * accessibility, and security": a failure rejects waiting requests, clears the
 * failed initialization promise, keeps the static page and its links, and shows
 * no stale panel; a deadline may terminate an unresponsive Worker, and a later
 * intent may start a new one. There is no automatic retry loop, so the only
 * preview in flight is the one an explicit hover dispatched.
 *
 * A real Chromium against a real generated build under the shipped CSP headers;
 * a missing browser is a failure, not a skip.
 */

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, Locator, Page } from 'playwright';

import { WORKER_LIMITS } from '../src/lib/worker-protocol.ts';
import {
  buildAndServe,
  collectPageErrors,
  countWorkerTerminations,
  removeWorkspace,
  workerTerminations,
  type RunningSite,
} from './support/browser-site.ts';

const PANEL = '#link-preview';
const ALPHA_LINK = 'a[href="/notes/beta/"]';
const ALPHA_TEXT = 'Alpha body text.';

/** alpha links to beta; beta is a title and nothing else. */
const CORPUS = {
  'alpha.md': '# Alpha\n\nAlpha body text. Links to [[beta]].\n',
  'beta.md': '# Beta\n',
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
  removeWorkspace(site.workspace);
}, 180_000);

/** Fail with every collected error's message; an empty list is the pass condition. */
function assertNoPageErrors(errors: Error[]): void {
  assert.equal(errors.length, 0, `the page raised errors: ${errors.map((error) => error.message).join(' | ')}`);
}

/**
 * What every blocked phase owes the reader.
 *
 * The panel must stay hidden, the link must keep working as a plain anchor, and
 * the static article text must survive. `aria-describedby` is the stale-panel
 * check: `link-preview.ts` sets it only while the panel is shown and removes it
 * on hide, so a null attribute while the panel is hidden is the pass condition —
 * leaving it behind would announce a description that is not there.
 */
async function assertStaticFallback(page: Page, link: Locator, phase: string): Promise<void> {
  assert.equal(await page.locator(PANEL).isHidden(), true, `${phase}: a failed preview showed the panel`);
  assert.equal(await link.getAttribute('aria-describedby'), null, `${phase}: a hidden panel described the link`);
  assert.equal(await link.getAttribute('href'), '/notes/beta/', `${phase}: the anchor lost its static href`);
  assert.ok(
    ((await page.locator('article').textContent()) ?? '').includes(ALPHA_TEXT),
    `${phase}: the static article text was lost`,
  );
}

test('a blocked WASM download leaves the article usable and a later intent previews', async () => {
  const page = await browser.newPage();
  const errors = collectPageErrors(page);
  const navigations: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest()) navigations.push(new URL(request.url()).pathname);
  });

  // WASM alone: the Worker is constructed and the snapshot downloads, so this
  // exercises a different failure code than the DB gate in
  // `tests/snapshot-runtime.test.ts`, and the failed runtime import must settle
  // as "nothing to show" rather than reject past the awaiting caller.
  await page.route('**/wasm/**', (route) => route.abort());
  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
  const link = page.locator(ALPHA_LINK).first();
  assert.equal(await link.count(), 1, 'the corpus did not render the cross-note link, so these checks are vacuous');
  await link.hover();
  // Long enough for the 120 ms intent delay plus the failed Worker attempt to
  // settle, so the assertions below read the page after that failure.
  await page.waitForTimeout(1_500);
  await assertStaticFallback(page, link, 'blocked WASM');

  // A failed preview never replaces the link: following it must be a real
  // document navigation to beta, visible as a navigation request.
  await link.click();
  await page.waitForURL(/\/notes\/beta\/$/, { timeout: 10_000 });
  assert.ok(navigations.includes('/notes/beta/'), 'the anchor click was not a real document navigation');
  // beta's only content is `# Beta`, which the page renders as its heading
  // rather than article body, so the heading is what proves the new document.
  assert.ok(
    ((await page.locator('h1').first().textContent()) ?? '').includes('Beta'),
    'beta did not render after the click',
  );

  // Restore availability and load a fresh document: the failure did not outlive
  // its request, and the next explicit intent previews from the snapshot.
  await page.unroute('**/wasm/**');
  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
  const retryLink = page.locator(ALPHA_LINK).first();
  await retryLink.hover();
  const panel = page.locator(PANEL);
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  assert.ok(((await panel.textContent()) ?? '').includes('Beta'), 'a restored WASM did not produce a preview');
  // The positive control for the stale-description check above: the attribute
  // does appear, on exactly the link whose visible panel it names.
  assert.equal(
    await retryLink.getAttribute('aria-describedby'),
    'link-preview',
    'the visible panel is not the description the recovered link points at',
  );
  assertNoPageErrors(errors);
  await page.close();
}, 120_000);

test('a Worker-startup failure settles, and a later intent starts a real Worker', async () => {
  const page = await browser.newPage();
  const errors = collectPageErrors(page);

  // What a CSP refusal or an unsupported engine does: the constructor throws
  // before a single message can be sent. The client must catch it and settle the
  // awaiting request, and must keep no half-created Worker behind.
  await page.addInitScript(() => {
    const state = window as unknown as { __RealWorker?: typeof Worker };
    state.__RealWorker = window.Worker;
    class BlockedWorker {
      constructor() {
        throw new Error('Worker startup blocked by the preview failure gate');
      }
    }
    window.Worker = BlockedWorker as unknown as typeof Worker;
  });

  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
  const link = page.locator(ALPHA_LINK).first();
  assert.equal(await link.count(), 1, 'the corpus did not render the cross-note link, so these checks are vacuous');
  await link.hover();
  await page.waitForTimeout(1_500);
  await assertStaticFallback(page, link, 'blocked Worker startup');
  assertNoPageErrors(errors);

  // Restore the real constructor: the failed attempt cached nothing, so a later
  // explicit intent constructs a Worker that actually works.
  await page.evaluate(() => {
    (window as unknown as { Worker: typeof Worker }).Worker = (
      window as unknown as { __RealWorker: typeof Worker }
    ).__RealWorker;
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await link.hover();
  const panel = page.locator(PANEL);
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  assert.ok(
    ((await panel.textContent()) ?? '').includes('Beta'),
    'a later intent did not recover from Worker-startup failure',
  );
  assert.equal(
    await link.getAttribute('aria-describedby'),
    'link-preview',
    'the visible panel is not the description the recovered link points at',
  );
  assertNoPageErrors(errors);
  await page.close();
}, 120_000);

test('a request the Worker never answers hits its deadline and a later intent starts a live Worker', async () => {
  const page = await browser.newPage();
  const errors = collectPageErrors(page);

  // The seam that makes a stuck request reproducible: swallow a dispatched
  // `preview` message before the Worker sees it, so no reply can ever come.
  // Terminations are counted by the shared wrapper, which reads which stop the
  // client chose.
  await countWorkerTerminations(page);
  await page.addInitScript(() => {
    const state = window as unknown as { __dropPreviews: boolean; __droppedCount: number };
    state.__dropPreviews = false;
    state.__droppedCount = 0;
    const realPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]): void {
      if (state.__dropPreviews && (message as { type?: string } | null)?.type === 'preview') {
        state.__droppedCount += 1;
        return;
      }
      (realPostMessage as (this: Worker, message: unknown, ...rest: unknown[]) => void).call(this, message, ...rest);
    };
  });

  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
  const link = page.locator(ALPHA_LINK).first();

  // One successful hover first, so the client is initialized and the planted
  // request is judged by the request deadline rather than the startup one.
  await link.hover();
  const panel = page.locator(PANEL);
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  await page.mouse.move(0, 0);
  await panel.waitFor({ state: 'hidden', timeout: 5_000 });

  await page.evaluate(() => {
    (window as unknown as { __dropPreviews: boolean }).__dropPreviews = true;
  });
  await link.hover();
  // Confirm the planted drop is actually delivered before declaring the control
  // effective: a hover that dispatched nothing would leave this at zero and the
  // gate would be waiting on a request that never happened.
  await page.waitForFunction(
    () => (window as unknown as { __droppedCount: number }).__droppedCount > 0,
    undefined,
    { timeout: 10_000 },
  );
  assert.equal(await panel.isHidden(), true, 'the dropped request showed a panel before its deadline');

  // Real time past the finite deadline, plus a margin for the terminate and the
  // rejected promise to settle; no `page.clock`, so the deadline is the real one.
  await page.waitForTimeout(WORKER_LIMITS.requestDeadlineMs + 2_000);
  await assertStaticFallback(page, link, 'deadline');
  assert.equal(
    await workerTerminations(page),
    1,
    'the request deadline did not terminate the unresponsive Worker exactly once',
  );
  assert.equal(
    await page.evaluate(() => (window as unknown as { __droppedCount: number }).__droppedCount),
    1,
    'a second preview was dispatched without an explicit intent, so something retried automatically',
  );

  // Restore dispatch: the termination must leave a recoverable state, so a later
  // explicit intent starts a fresh, live Worker — and does not terminate it.
  await page.evaluate(() => {
    (window as unknown as { __dropPreviews: boolean }).__dropPreviews = false;
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await link.hover();
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  assert.ok(((await panel.textContent()) ?? '').includes('Beta'), 'a later intent did not recover after a deadline');
  assert.equal(
    await workerTerminations(page),
    1,
    'recovery needed a termination, or reused the terminated Worker',
  );
  assertNoPageErrors(errors);
  await page.close();
}, 180_000);
