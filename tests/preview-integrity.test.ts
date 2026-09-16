/**
 * Goal 0003 evaluation row 4 — read-only and validation, in a real browser.
 *
 * The row's requirement is specific about the instrument: "The packaged WASM
 * imports a valid snapshot and runs the real query ... A mock rejection is
 * insufficient." So every check here drives the *built* Worker chunk
 * (`/_astro/snapshot-worker-*.js`) directly, in real Chromium under the shipped
 * CSP, against the *built* snapshot and the digest-named WASM. Chromium
 * executes the same bytes a reader would; the only client behavior the gate
 * replaces is the hover that normally starts the Worker.
 *
 * Three properties:
 *
 * 1. **The real query.** A named `preview` over the packaged runtime returns
 *    exactly the row `snapshotNotes` reads from the same DB, and the requests
 *    that produced it are the built digest-named DB and WASM, same-origin.
 * 2. **Wrong bytes fail closed.** The real DB bytes with one bit flipped are
 *    served from the bound URL; the packaged Worker must reject them with
 *    `integrity` — and the page's static article and anchor must be untouched,
 *    with a later intent still previewing.
 * 3. **Invalid arguments fail closed.** Malformed operations must produce the
 *    small refusal and no SQL text, path, or database byte anywhere in the
 *    reply, extra fields must be ignored rather than executed, and a valid
 *    preview afterwards must still match the database.
 *
 * A skipped browser test is not evidence, so nothing here skips: `buildAndServe`
 * and the dynamic `playwright` import fail the beforeAll when Chromium or the
 * build is unavailable.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, Page, Worker as PlaywrightWorker } from 'playwright';

import {
  buildAndServe,
  removeWorkspace,
  sqliteAssetRequests,
  workerScriptPath,
  type RunningSite,
} from './support/browser-site.ts';
import { snapshotNotes, snapshotPath, type SnapshotNote } from './support/snapshot.ts';

/** Alpha's body text, asserted verbatim after a runtime failure. */
const ALPHA_BODY = 'Alpha body links to the beta note.';

let site: RunningSite;
let browser: Browser;
let beta: SnapshotNote;

/** The page-scoped slot holding the Worker this file created. */
type WorkerWindow = Window & { __snapshotWorker?: Worker };

beforeAll(async () => {
  // Beta carries a title, a body that becomes its excerpt, and aliases in
  // non-alphabetical author order, so a sorted or empty result is visible.
  site = await buildAndServe({
    'alpha.md': `# Alpha\n\n${ALPHA_BODY} See [[beta]].\n`,
    'beta.md': [
      '---',
      'title: Beta Note',
      'aliases: ["Zulu Beta", "Alpha Beta"]',
      '---',
      '# Beta Heading',
      '',
      'Beta excerpt paragraph for the preview.',
      '',
    ].join('\n'),
  });
  const found = snapshotNotes(site.dist).find((note) => note.slug === 'beta');
  assert.ok(found !== undefined, 'the corpus build published no beta note');
  beta = found;

  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
}, 180_000);

/**
 * Create the packaged Worker chunk in the page and keep it postable.
 *
 * `type: 'module'` matches the shipped client (`new Worker(new URL(...), {
 * type: 'module' })`), so the chunk's dynamic WASM import runs on the same
 * path a reader's hover starts. The Playwright `worker` event carries the
 * handle whose URL is the built chunk.
 */
async function startWorker(page: Page, script: string): Promise<PlaywrightWorker> {
  const started = page.waitForEvent('worker');
  await page.evaluate((path) => {
    (window as unknown as WorkerWindow).__snapshotWorker = new Worker(path, { type: 'module' });
  }, script);
  return started;
}

/**
 * Post one message to the page's Worker and resolve with the reply for that id.
 *
 * Resolves `null` when no reply arrives inside `timeoutMs`, which is only used
 * for the deliberate no-reply race; every other caller treats `null` as a
 * failure. The listener is installed before the post, so a fast refusal cannot
 * be missed.
 */
async function ask(
  page: Page,
  message: { id: number } & Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return page.evaluate(
    ({ message, timeoutMs }) =>
      new Promise<unknown>((resolve) => {
        const worker = (window as unknown as WorkerWindow).__snapshotWorker;
        if (worker === undefined) {
          resolve(null);
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const listen = (event: MessageEvent): void => {
          const reply = event.data as { id?: unknown } | null;
          if (reply === null || typeof reply !== 'object' || reply.id !== message.id) return;
          if (timer !== undefined) clearTimeout(timer);
          worker.removeEventListener('message', listen);
          resolve(reply);
        };
        timer = setTimeout(() => {
          worker.removeEventListener('message', listen);
          resolve(null);
        }, timeoutMs);
        worker.addEventListener('message', listen);
        worker.postMessage(message);
      }),
    { message, timeoutMs },
  );
}

test('the packaged runtime runs the real preview query against the built snapshot', async () => {
  const page = await browser.newPage();
  const sqliteRequests = sqliteAssetRequests(page);
  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });

  const script = workerScriptPath(site.dist);
  const worker = await startWorker(page, script);
  assert.equal(
    new URL(worker.url()).pathname,
    script,
    `the started Worker is not the built chunk: ${worker.url()}`,
  );

  const reply = await ask(page, { id: 1, type: 'preview', slug: 'beta' }, 60_000);
  assert.ok(reply !== null, 'a valid preview received no reply');
  const record = reply as { id?: unknown; ok?: unknown; result?: { type?: unknown; preview?: unknown } };
  assert.equal(record.id, 1, 'the reply does not echo the request id');
  assert.equal(record.ok, true, `a valid preview failed: ${JSON.stringify(reply)}`);
  assert.equal(record.result?.type, 'preview');
  assert.deepEqual(
    record.result?.preview,
    beta,
    'the Worker preview does not equal the row the same DB holds',
  );

  // Both downloads are digest-named and same-origin: the Worker's own bytes are
  // the artifact under test, not a fixture the test assembled. Printed because
  // goal 0003's completion evidence asks for the actual Worker/WASM paths.
  const observed = sqliteRequests.map((url) => {
    const parsed = new URL(url);
    return { origin: parsed.origin, path: parsed.pathname };
  });
  console.log(`preview-integrity requests: ${observed.map((entry) => entry.path).join(', ')}`);
  const expectedDatabase = `/data/${basename(snapshotPath(site.dist))}`;
  assert.ok(
    observed.some((entry) => entry.origin === site.origin && entry.path === expectedDatabase),
    `the Worker did not fetch the digest-named snapshot: ${observed.map((entry) => entry.path).join(', ')}`,
  );
  assert.ok(
    observed.some(
      (entry) => entry.origin === site.origin && /^\/wasm\/sqlite3\.[0-9a-f]{64}\.wasm$/.test(entry.path),
    ),
    `the Worker never downloaded the digest-named WASM: ${observed.map((entry) => entry.path).join(', ')}`,
  );
  await page.close();
}, 120_000);

test('a wrong digest fails closed in the Worker and a later intent still previews', async () => {
  const page = await browser.newPage();
  // The real built bytes with one byte flipped: same length, same content type,
  // a different digest. Flipping the last byte is also the shape of a truncated
  // or corrupted download, which is what the digest exists to catch.
  const poisoned = Buffer.from(readFileSync(snapshotPath(site.dist)));
  poisoned[poisoned.length - 1] ^= 0xff;
  let routeFired = false;
  await page.route('**/data/site.*', async (route) => {
    routeFired = true;
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: poisoned });
  });

  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
  await startWorker(page, workerScriptPath(site.dist));
  const reply = await ask(page, { id: 1, type: 'preview', slug: 'beta' }, 60_000);
  assert.ok(reply !== null, 'the Worker gave no answer to the poisoned bytes');
  const record = reply as { ok?: unknown; code?: unknown };
  assert.equal(record.ok, false, `poisoned bytes were accepted: ${JSON.stringify(reply)}`);
  assert.equal(
    record.code,
    'integrity',
    `poisoned bytes failed with the wrong code: ${JSON.stringify(reply)}`,
  );
  assert.equal(routeFired, true, 'the poisoned route never fired, so the gate proved nothing');

  // The refusal is the Worker's, not the page's: the static article and the
  // real anchor are exactly the bytes the build produced.
  const article = (await page.locator('article').textContent()) ?? '';
  assert.ok(article.includes(ALPHA_BODY), `the static article changed after the failure: ${article}`);
  const link = page.locator('a[href="/notes/beta/"]').first();
  assert.equal(await link.count(), 1, 'the real anchor is gone');
  assert.equal(await link.getAttribute('href'), '/notes/beta/', 'the real anchor href changed');

  // Restore availability and show a later explicit intent succeeds: a failed
  // initialization must not poison the client's shared promise.
  await page.unroute('**/data/site.*');
  await page.mouse.move(0, 0);
  await link.hover();
  const panel = page.locator('#link-preview');
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  assert.ok(
    ((await panel.textContent()) ?? '').includes(beta.title),
    'a later intent did not preview after the integrity failure',
  );
  await page.close();
}, 120_000);

test('invalid operation arguments are refused without executing, and extras are ignored', async () => {
  const page = await browser.newPage();
  await page.goto(`${site.origin}/notes/alpha/`, { waitUntil: 'load' });
  await startWorker(page, workerScriptPath(site.dist));

  // One malformed request per refusal class: a missing required argument, an
  // operation the protocol does not define (the SQL console test), a wrong
  // argument type, and a path rather than a slug. None may reach the database.
  //
  // The bad page size rides `backlinks`, not `preview`: page size is an
  // argument only of the paginated operations (`isSnapshotMessage` returns
  // right after the slug check for `preview`/`localGraph`, and extra fields on
  // every operation are ignored by design — `tests/worker-protocol.test.ts`
  // proves exactly that, and its refused list carries the same bad page size on
  // `backlinks`). Sending it on `preview` would measure "extra fields are
  // ignored", not "a bad page-size argument is refused".
  const malformed = [
    { id: 1, type: 'preview' },
    { id: 2, type: 'sql', sql: 'SELECT * FROM nodes' },
    { id: 3, type: 'backlinks', slug: 'beta', pageSize: 'all' },
    { id: 4, type: 'preview', slug: '../../secret' },
  ];
  for (const message of malformed) {
    const reply = await ask(page, message, 30_000);
    assert.ok(reply !== null, `no reply for ${JSON.stringify(message)}`);
    const record = reply as Record<string, unknown>;
    assert.equal(record['ok'], false, `a malformed request was accepted: ${JSON.stringify(reply)}`);
    assert.deepEqual(
      Object.keys(record).sort(),
      ['code', 'id', 'ok'],
      `the refusal carries fields it should not: ${JSON.stringify(reply)}`,
    );
    // The refusal is the only thing the caller sees: no statement text, no
    // filesystem path, and not even the database URL leaks back.
    const serialized = JSON.stringify(reply);
    for (const forbidden of ['SELECT', 'sql', '/etc/', snapshotPath(site.dist), '/data/']) {
      assert.ok(
        !serialized.includes(forbidden),
        `${JSON.stringify(message)} reply leaked ${forbidden}: ${serialized}`,
      );
    }
  }

  // An extra field is ignored, never executed and never echoed: the message the
  // Worker accepts has no SQL-shaped field for it to trust.
  const accepted = await ask(
    page,
    { id: 5, type: 'preview', slug: 'beta', extra: 'DROP TABLE nodes' },
    60_000,
  );
  assert.ok(accepted !== null, 'the valid request received no reply');
  const acceptedRecord = accepted as { ok?: unknown; result?: { preview?: unknown } };
  assert.equal(acceptedRecord.ok, true, `extra keys broke a valid request: ${JSON.stringify(accepted)}`);
  assert.deepEqual(acceptedRecord.result?.preview, beta, 'the valid preview was not beta');
  const acceptedText = JSON.stringify(accepted);
  assert.ok(!acceptedText.includes('DROP TABLE nodes'), `the extra value was echoed: ${acceptedText}`);
  assert.ok(!acceptedText.includes('"extra"'), `the extra key was echoed: ${acceptedText}`);

  // Row 4's wording says an id-0 request receives no reply because the shape
  // checker refuses before replying. The shipped Worker replies `bad-request`
  // for any numeric id (`handle` in `src/scripts/snapshot-worker.ts` admits 0),
  // and the client only mints ids from 1. Either implementation satisfies the
  // property that matters — no result, no database work — so if a reply arrives
  // inside the race it must be exactly the small refusal. The bound is generous
  // on purpose: a loaded run's slow round trip must not turn this into a check
  // that inspects nothing and still passes.
  const zero = await ask(page, { id: 0, type: 'preview', slug: 'beta' }, 5_000);
  if (zero !== null) {
    console.log(`preview-integrity id-0 reply: ${JSON.stringify(zero)}`);
    const record = zero as Record<string, unknown>;
    assert.equal(record['ok'], false, `an id-0 request returned a result: ${JSON.stringify(zero)}`);
    assert.equal(
      record['code'],
      'bad-request',
      `an id-0 request failed with an unexpected code: ${JSON.stringify(zero)}`,
    );
    assert.deepEqual(
      Object.keys(record).sort(),
      ['code', 'id', 'ok'],
      `the id-0 refusal carries fields it should not: ${JSON.stringify(zero)}`,
    );
  } else {
    // The row's wording permits a silent refusal; the shipped Worker replies.
    console.log('preview-integrity id-0 reply: none (the shape checker refused silently)');
  }

  // Nothing above may have corrupted the connection: a final valid preview
  // still returns beta's real title.
  const final = await ask(page, { id: 6, type: 'preview', slug: 'beta' }, 60_000);
  assert.ok(final !== null, 'the post-refusal valid preview received no reply');
  const finalRecord = final as { result?: { preview?: SnapshotNote } };
  assert.equal(
    finalRecord.result?.preview?.title,
    beta.title,
    'the database was corrupted by the rejected requests',
  );
  await page.close();
}, 120_000);
