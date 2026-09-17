/**
 * Goal 0003's resource and CSP controls, exercised in a real browser.
 *
 * The transport half of the row — a missing, understated, or overstated
 * `Content-Length` cannot make the reader decode past its cap — is
 * `tests/snapshot-fetch-bounded.test.ts`, which drives `fetchBounded` against a
 * real HTTP stream and observes the server-side abort. This file fixes the
 * browser half of the same row:
 *
 * - oversized snapshot data rejects with `integrity` before any WASM import,
 *   and the static article stays readable and navigable;
 * - oversized WASM data is refused at its own download cap before any
 *   instantiation, and a later intent previews once it is served correctly;
 * - the failed attempt is delivered before the restore below, so the retry
 *   cannot be racing it, and the next intent in the same page previews from the
 *   restored snapshot with no poisoned initialization promise in the way;
 * - a misleading `Content-Length` in the browser — Chromium was measured
 *   delivering the fulfilled body whole while the header claims 64 bytes — does
 *   not bypass the cap, and a later intent retries;
 * - the served document carries the `public/_headers` policy and the policy is
 *   *enforced*: an injected inline script is blocked and reported, while the
 *   site's own lazy runtime produces no violation;
 * - every request the session makes is same-origin.
 *
 * The unbounded-request-queue half of the same row is
 * `tests/snapshot-client.test.ts`; it is not duplicated here.
 *
 * The site is served by `tests/support/browser-site.ts`, which applies the
 * shipped policy to every response. A policy file merely present on disk
 * enforces nothing; the served header is read from the response below. A
 * skipped run is not evidence, so this file fails when Chromium is absent
 * rather than skipping.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, Page, Worker as PlaywrightWorker } from 'playwright';

import { WORKER_LIMITS } from '../src/lib/worker-protocol.ts';
import {
  buildAndServe,
  removeWorkspace,
  shippedHeaders,
  sqliteAssetRequests,
  workerScriptPath,
  type RunningSite,
} from './support/browser-site.ts';
import { snapshotPath } from './support/snapshot.ts';

const NOTES: Record<string, string> = {
  'alpha.md': '# Alpha Note\n\nAlpha body links to [[beta]].\n',
  'beta.md': '# Beta Note\n\nBeta body text for the preview panel.\n',
};

let site: RunningSite;
let browser: Browser;
/** Shared by the oversized and restore cases: the retry needs the same page. */
let probePage: Page;
/** The valid snapshot bytes, restored after the oversized first case. */
let originalSnapshot: Buffer;

beforeAll(async () => {
  site = await buildAndServe(NOTES);
  originalSnapshot = readFileSync(snapshotPath(site.dist));
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  probePage = await browser.newPage();
}, 180_000);

afterAll(async () => {
  await probePage?.close();
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
}, 120_000);

/**
 * Record every reply the page's shared Worker sends.
 *
 * Waiting for a *reply* instead of sleeping is what keeps a retry deterministic:
 * a fixed pause can expire while the oversized body is still being read, and
 * the next hover would then join the in-flight load rather than retrying after
 * its failure. The wrapper is transparent — it constructs the real Worker and
 * only listens.
 */
async function captureWorkerReplies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { __workerReplies: { ok: boolean; code?: string }[] };
    state.__workerReplies = [];
    const Original = window.Worker;
    const wrapped = function (scriptURL: string | URL, options?: WorkerOptions): Worker {
      const worker = new Original(scriptURL, options);
      worker.addEventListener('message', (event: MessageEvent) => {
        const reply = event.data as { ok?: boolean; code?: string } | null;
        if (typeof reply?.ok === 'boolean') state.__workerReplies.push({ ok: reply.ok, code: reply.code });
      });
      return worker;
    };
    window.Worker = wrapped as unknown as typeof Worker;
  });
}

/** The first Worker reply this page saw, once one exists. */
async function firstWorkerReply(page: Page): Promise<{ ok: boolean; code?: string }> {
  await page.waitForFunction(
    () => ((window as unknown as { __workerReplies?: unknown[] }).__workerReplies ?? []).length > 0,
    undefined,
    { timeout: 30_000 },
  );
  return page.evaluate(
    () =>
      (window as unknown as { __workerReplies: { ok: boolean; code?: string }[] }).__workerReplies[0]!,
  );
}

/**
 * Run one direct `preview` through the built Worker while counting every
 * WebAssembly entry point.
 *
 * Constructing the Worker, patching WebAssembly, and posting the request in
 * that order is what makes a zero counter mean "the import never ran" rather
 * than "the patch was late"; the `patched` flag makes the same distinction for
 * the patch itself.
 */
async function probePreviewWithWasmCounter(
  page: Page,
  slug: string,
): Promise<{
  reply: { ok: boolean; code?: string };
  counter: { calls: number; patched: boolean };
}> {
  const workerCreated = page.waitForEvent('worker');
  await page.evaluate((script: string) => {
    const state = window as unknown as { __snapshotProbe?: Worker; __snapshotReplies?: unknown[] };
    const worker = new Worker(script, { type: 'module' });
    state.__snapshotProbe = worker;
    state.__snapshotReplies = [];
    worker.addEventListener('message', (event) => state.__snapshotReplies!.push(event.data));
  }, workerScriptPath(site.dist));
  const worker: PlaywrightWorker = await workerCreated;

  await worker.evaluate(() => {
    const scope = self as unknown as { __wasmCalls: number; __wasmPatched: boolean };
    scope.__wasmCalls = 0;
    scope.__wasmPatched = false;
    const wasm = WebAssembly as unknown as Record<string, unknown>;
    for (const name of ['instantiate', 'compile', 'instantiateStreaming']) {
      const original = wasm[name];
      if (typeof original !== 'function') continue;
      wasm[name] = function (this: unknown, ...args: unknown[]): unknown {
        scope.__wasmCalls += 1;
        return Reflect.apply(original as (...callArgs: unknown[]) => unknown, wasm, args);
      };
    }
    scope.__wasmPatched = true;
  });

  await page.evaluate((probeSlug: string) => {
    (window as unknown as { __snapshotProbe: Worker }).__snapshotProbe.postMessage({
      id: 1,
      type: 'preview',
      slug: probeSlug,
    });
  }, slug);
  await page.waitForFunction(
    () => ((window as unknown as { __snapshotReplies?: unknown[] }).__snapshotReplies ?? []).length > 0,
    undefined,
    { timeout: 30_000 },
  );
  const reply = await page.evaluate(
    () =>
      (window as unknown as { __snapshotReplies: { ok: boolean; code?: string }[] }).__snapshotReplies[0]!,
  );
  const counter = await worker.evaluate(() => {
    const scope = self as unknown as { __wasmCalls: number; __wasmPatched: boolean };
    return { calls: scope.__wasmCalls, patched: scope.__wasmPatched };
  });
  return { reply, counter };
}

test('oversized snapshot data rejects integrity before any WASM import', async () => {
  const page = probePage;
  writeFileSync(snapshotPath(site.dist), Buffer.alloc(WORKER_LIMITS.maxSnapshotBytes + 1, 0x41));
  await captureWorkerReplies(page);
  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });

  const link = page.locator('a[href="/notes/beta/"]').first();
  assert.equal(await link.count(), 1, 'the corpus did not render the alpha link to beta');

  // The client path first: a real hover starts the shared Worker, which fetches
  // the oversized snapshot and must fail closed. The reply is awaited before
  // the restore below so the retry cannot race an in-flight attempt.
  await link.hover();
  const clientReply = await firstWorkerReply(page);
  assert.equal(
    clientReply.ok,
    false,
    `the client preview succeeded against an oversized snapshot: ${JSON.stringify(clientReply)}`,
  );
  assert.equal(await page.locator('#link-preview').isHidden(), true, 'an oversized snapshot produced a preview panel');
  // Static fallback: the anchor is a real link and the article text is there.
  assert.equal(await link.getAttribute('href'), '/notes/beta/');
  assert.ok(
    ((await page.locator('article').textContent()) ?? '').includes('Alpha body links to'),
    'the static article text did not survive the failed preview',
  );
  await page.mouse.move(0, 0);

  // The direct Worker proves the abort happens before WASM. Patching first and
  // posting second is what makes a zero counter mean "the import never ran"
  // rather than "the patch was late".
  const probe = await probePreviewWithWasmCounter(page, 'beta');
  assert.equal(
    probe.reply.ok,
    false,
    `the direct Worker did not fail closed on oversized data: ${JSON.stringify(probe.reply)}`,
  );
  assert.equal(
    probe.reply.code,
    'integrity',
    `the direct Worker refused oversized data with the wrong verdict: ${JSON.stringify(probe.reply)}`,
  );
  assert.equal(probe.counter.patched, true, 'the WASM patch did not install, so a zero counter would prove nothing');
  assert.equal(probe.counter.calls, 0, 'the oversized snapshot reached WebAssembly despite the decoded-byte cap');
}, 120_000);

test('restoring the snapshot previews on the next intent in the same page', async () => {
  writeFileSync(snapshotPath(site.dist), originalSnapshot);
  const link = probePage.locator('a[href="/notes/beta/"]').first();
  await probePage.mouse.move(0, 0);
  await probePage.waitForTimeout(200);
  await link.hover();
  const panel = probePage.locator('#link-preview');
  await panel.waitFor({ state: 'visible', timeout: 15_000 });
  const text = (await panel.textContent()) ?? '';
  assert.ok(text.includes('Beta Note'), `the restored snapshot did not preview the target title: ${text}`);
  assert.ok(text.includes('Beta body text'), `the restored snapshot did not preview the target excerpt: ${text}`);
}, 120_000);

test('oversized WASM data rejects integrity before instantiation and a later intent previews', async () => {
  const page = await browser.newPage();
  try {
    // The second download limit: the pinned WASM binary is fetched and capped
    // exactly like the snapshot. A body one page over `maxWasmBytes` must be
    // refused while the connection is still being read, so `initSqlite` never
    // runs for it.
    const body = Buffer.alloc(WORKER_LIMITS.maxWasmBytes + 4096, 0x57);
    let fulfilled = 0;
    await page.route('**/wasm/sqlite3.*.wasm', async (route) => {
      fulfilled += 1;
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/wasm' }, body });
    });
    await captureWorkerReplies(page);
    await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });

    const link = page.locator('a[href="/notes/beta/"]').first();
    assert.equal(await link.count(), 1, 'the corpus did not render the alpha link to beta');

    // The client path: the hover starts the shared Worker, whose WASM download
    // is oversized. Await its reply so the direct Worker below cannot race it.
    await link.hover();
    const clientReply = await firstWorkerReply(page);
    assert.equal(
      clientReply.ok,
      false,
      `the client preview succeeded against an oversized WASM: ${JSON.stringify(clientReply)}`,
    );
    assert.equal(
      clientReply.code,
      'integrity',
      `the WASM cap failed with the wrong verdict: ${JSON.stringify(clientReply)}`,
    );
    assert.equal(await page.locator('#link-preview').isHidden(), true, 'an oversized WASM produced a preview panel');
    assert.equal(await link.getAttribute('href'), '/notes/beta/', 'static navigation was not intact');
    await page.mouse.move(0, 0);

    // The direct Worker proves the abort happens before instantiation, with the
    // patch installed before the request so a zero counter cannot be lateness.
    const probe = await probePreviewWithWasmCounter(page, 'beta');
    assert.equal(
      probe.reply.code,
      'integrity',
      `the direct Worker refused oversized WASM with the wrong verdict: ${JSON.stringify(probe.reply)}`,
    );
    assert.equal(fulfilled > 0, true, 'the route never served the oversized WASM, so this case is vacuous');
    assert.equal(probe.counter.patched, true, 'the WASM patch did not install, so a zero counter would prove nothing');
    assert.equal(probe.counter.calls, 0, 'the oversized WASM reached WebAssembly despite the decoded-byte cap');

    // Restore availability; the next explicit intent previews rather than
    // staying poisoned.
    await page.unroute('**/wasm/sqlite3.*.wasm');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await link.hover();
    const panel = page.locator('#link-preview');
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    assert.ok(
      ((await panel.textContent()) ?? '').includes('Beta Note'),
      'a later intent after the oversized WASM did not preview',
    );
  } finally {
    await page.close();
  }
}, 120_000);

test('a misleading Content-Length does not bypass the cap and a later intent previews', async () => {
  const page = await browser.newPage();
  try {
    // One allocation, reused for every fulfilled request. Chromium was
    // measured delivering this body whole while the response claims 64 bytes,
    // so the running decoded-byte cap is the only thing that can stop it.
    const body = Buffer.alloc(WORKER_LIMITS.maxSnapshotBytes + 4096, 0x42);
    let fulfilled = 0;
    await page.route('**/data/site.*', async (route) => {
      fulfilled += 1;
      await route.fulfill({
        status: 200,
        headers: { 'Content-Length': '64', 'Content-Type': 'application/octet-stream' },
        body,
      });
    });
    await captureWorkerReplies(page);
    await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });

    const link = page.locator('a[href="/notes/beta/"]').first();
    await link.hover();
    const reply = await firstWorkerReply(page);
    // Measured: Chromium delivers the whole body despite the header and the
    // reply is `{ ok: false, code: 'integrity' }` — the running cap refuses it.
    // This case asserts only that the attempt failed rather than previewed,
    // because the decoded-byte cap's own verdict is `snapshot-fetch-bounded`'s.
    await page.waitForTimeout(2_000);
    assert.equal(fulfilled > 0, true, 'the route never served the misleading response, so this case is vacuous');
    assert.equal(
      reply.ok,
      false,
      `a lying Content-Length produced a preview: ${JSON.stringify(reply)}`,
    );
    const panel = page.locator('#link-preview');
    assert.equal(await panel.isHidden(), true, 'a response with a lying Content-Length produced a preview panel');
    assert.equal(await link.getAttribute('href'), '/notes/beta/', 'static navigation was not intact');
    assert.ok(
      ((await page.locator('article').textContent()) ?? '').includes('Alpha body links to'),
      'the static article text did not survive the failed preview',
    );

    // Restore availability the way a deployment would: the route is gone, and
    // the next explicit intent must retry rather than stay poisoned.
    await page.unroute('**/data/site.*');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await link.hover();
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    assert.ok(
      ((await panel.textContent()) ?? '').includes('Beta Note'),
      'a later intent after the misleading response did not preview',
    );
  } finally {
    await page.close();
  }
}, 120_000);

test('the shipped CSP is served and enforced in the document', async () => {
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      const state = window as unknown as {
        __cspViolations: { blockedURI: string; violatedDirective: string }[];
        __cspInlineRan?: boolean;
      };
      state.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        state.__cspViolations.push({ blockedURI: event.blockedURI, violatedDirective: event.violatedDirective });
      });
    });

    const response = await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
    assert.ok(response, 'the document navigation returned no response');
    const served = response.headers()['content-security-policy'];
    const shipped = shippedHeaders()['Content-Security-Policy'];
    assert.ok(shipped, 'public/_headers declares no Content-Security-Policy');
    assert.equal(served, shipped, 'the served document does not carry the shipped policy verbatim');

    // Per-path rule fidelity, both directions: the document must not inherit
    // the `/_astro/*` immutable rule, and the hashed Worker chunk must still
    // receive it. A flattened header map would fail one of these two. The
    // document value is the platform's revalidating default that the harness
    // stands in for; `public/_headers` itself names no rule for HTML.
    assert.equal(
      response.headers()['cache-control'],
      'public, max-age=0, must-revalidate',
      'the document response does not revalidate under the per-path policy',
    );
    const chunk = await page.request.get(`${site.origin}${workerScriptPath(site.dist)}`);
    assert.match(
      chunk.headers()['cache-control'] ?? '',
      /immutable/,
      'the hashed Worker chunk did not receive the cache rule `public/_headers` grants it',
    );

    assert.ok(
      served!.includes("script-src 'self' 'wasm-unsafe-eval'"),
      'the served policy does not allow the pinned WASM the runtime needs',
    );
    assert.ok(served!.includes("worker-src 'self'"), 'the served policy does not allow the same-origin Worker');
    assert.ok(served!.includes("connect-src 'self'"), 'the served policy does not allow the same-origin snapshot fetch');
    // The one allowance SQLite needs is the narrow `wasm-unsafe-eval` token; any
    // other `unsafe-eval` grant would let the page eval arbitrary source.
    assert.doesNotMatch(served!, /(?<!wasm-)'unsafe-eval'/, 'the served policy grants unsafe-eval');
    const scriptSrc = /(?:^|;\s*)script-src\s+([^;]+)/.exec(served ?? '')?.[1] ?? '';
    assert.ok(scriptSrc.length > 0, 'the served policy declares no script-src directive to check');
    assert.ok(!scriptSrc.includes('unsafe-inline'), 'script-src grants unsafe-inline');

    // Positive control: the policy is only evidenced as *enforced* if a
    // disallowed script actually fails and reports. A policy that is merely
    // present in a header would let this run.
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__cspInlineRan = true';
      document.body.append(script);
    });
    await page.waitForTimeout(100);
    const afterInline = await page.evaluate(() => ({
      ran: (window as unknown as { __cspInlineRan?: boolean }).__cspInlineRan,
      events: (window as unknown as { __cspViolations: { blockedURI: string; violatedDirective: string }[] })
        .__cspViolations,
    }));
    assert.equal(afterInline.ran, undefined, 'the injected inline script executed, so script-src is not enforced');
    assert.ok(
      afterInline.events.some((event) => event.violatedDirective.includes('script-src')),
      `the inline script was blocked without a script-src violation event, so this control cannot see enforcement: ${JSON.stringify(afterInline.events)}`,
    );

    // Then the site's own lazy runtime under the same policy: a Worker, a WASM
    // import, and a same-origin snapshot fetch. `connect-src`/`worker-src`
    // regressions surface here as recorded violations even when the preview
    // still renders.
    const link = page.locator('a[href="/notes/beta/"]').first();
    await link.hover();
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 15_000 });
    const runtimeViolations = await page.evaluate(
      (seen: number) => (window as unknown as { __cspViolations: unknown[] }).__cspViolations.slice(seen),
      afterInline.events.length,
    );
    assert.deepEqual(
      runtimeViolations,
      [],
      `the lazy runtime produced CSP violations: ${JSON.stringify(runtimeViolations)}`,
    );
  } finally {
    await page.close();
  }
}, 120_000);

test('the whole session requests same-origin assets only', async () => {
  const page = await browser.newPage();
  try {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    // Non-vacuity instrument: reports the Worker chunk, the WASM, and the DB
    // requests the origin check below is meant to police.
    const assets = sqliteAssetRequests(page);
    await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
    const link = page.locator('a[href="/notes/beta/"]').first();
    await link.hover();
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(300);

    const offOrigin = requests
      .filter((url) => url.startsWith('http://') || url.startsWith('https://'))
      .filter((url) => new URL(url).origin !== site.origin);
    assert.deepEqual(offOrigin, [], `the session requested off-origin assets: ${offOrigin.join(', ')}`);
    assert.ok(
      !requests.some((url) => url.startsWith('https://example.com/')),
      'a request went to example.com',
    );

    assert.ok(assets.some((url) => url.includes('/data/site.')), 'no snapshot request was observed');
    assert.ok(assets.some((url) => url.includes('/wasm/')), 'no WASM request was observed');
    assert.ok(
      assets.some((url) => /\/_astro\/snapshot-worker-/.test(url)),
      'no Worker request was observed, so the origin check never saw the runtime it exists for',
    );
  } finally {
    await page.close();
  }
}, 120_000);
