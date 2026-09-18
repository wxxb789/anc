/**
 * Host cache policy and runtime MIME over real HTTP (goal 0007, rows "Host
 * snapshot policy" and "Recognition and transport").
 *
 * `public/_headers` is the only place the cache policy is written down, and
 * `tests/deployment.test.ts` reads it as a document. That proves what the file
 * says, not what a response does. This file serves a real build through the
 * same per-path policy and asserts the exchanges a reader's browser actually
 * performs: HTML and stable-named assets revalidate with a validator, only the
 * content-hashed `/_astro/*` output is immutable, the digest-named snapshot
 * revalidates like the rest, and the runtime's three asset classes carry the
 * MIME types the host documents for them.
 *
 * The harness (`tests/support/browser-site.ts`) stands in for the host: it
 * emulates the platform default — `public, max-age=0, must-revalidate` plus an
 * `ETag` — for paths `public/_headers` names no rule for, and its
 * conditional-GET handling is what makes "revalidates" a measurable exchange
 * rather than a string comparison. The MIME assertions are that harness's
 * extension mappings, which stand in for the host's documented mappings; they
 * do not pretend Chromium consumes the Worker, WASM, and DB from them. Real
 * runtime consumption under the shipped CSP is gated in the browser suite
 * (`tests/preview-limits.test.ts`, `tests/snapshot-runtime.test.ts`).
 *
 * No Chromium is needed here: every assertion is an HTTP exchange, so this
 * file also runs where the browser suite cannot.
 */

import assert from 'node:assert/strict';
import { appendFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';

import {
  buildAndServe,
  removeWorkspace,
  workerScriptPath,
  type RunningSite,
} from './support/browser-site.ts';
import { snapshotPath } from './support/snapshot.ts';

/**
 * Two notes are enough for every claim here; the per-path policy is what is
 * under test, not corpus content.
 */
const CORPUS: Record<string, string> = {
  'alpha.md': '---\ntitle: "Alpha One"\n---\n\n# Alpha One\n\nAlpha links to [[beta]].\n',
  'beta.md': '---\ntitle: "Beta One"\n---\n\n# Beta One\n\nBeta body text for previews.\n',
};

/**
 * The platform's revalidating default for every path `public/_headers` does not
 * name. `public/_headers` deliberately does not restate it; the harness writes
 * it down once and this gate holds it to that value.
 */
const REVALIDATION = 'public, max-age=0, must-revalidate';

/**
 * The one immutable cache rule, granted by `/_astro/*` to content-hashed
 * output. A changed file there is a changed URL, so a cached copy can never be
 * stale — the only condition under which `immutable` is safe.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

let site: RunningSite;

beforeAll(async () => {
  site = await buildAndServe(CORPUS);
}, 180_000);

afterAll(async () => {
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
}, 180_000);

/** Fetch one path from the served site, following nothing. */
async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${site.origin}${path}`, init);
}

interface Revalidating {
  /** The validator the 200 carried, usable as `If-None-Match`. */
  etag: string;
  /** The bytes of the first 200, for callers that compare after a change. */
  body: string;
}

/**
 * Assert the whole revalidation contract on one path: an unconditional GET
 * returns non-empty bytes with the platform's revalidating `Cache-Control` and
 * a validator; a conditional GET with that validator answers 304 with an empty
 * body and the same policy; and a stale validator still yields the bytes.
 *
 * The non-empty first GET is the control that keeps the 304s from being
 * vacuous: an empty artifact would make "empty 304 body" indistinguishable from
 * "the route serves nothing". The stale validator is the second direction — a
 * server that answered 304 to every `If-None-Match` would otherwise pass.
 */
async function assertRevalidating(path: string): Promise<Revalidating> {
  const first = await get(path);
  assert.equal(first.status, 200, `${path}: expected 200 from an unconditional GET, got ${first.status}`);
  assert.equal(
    first.headers.get('cache-control'),
    REVALIDATION,
    `${path}: a path no _headers rule names must carry the host's revalidating default rather than a cache rule`,
  );
  const etag = first.headers.get('etag');
  assert.ok(etag, `${path}: no ETag, so a returning reader could only refetch the whole artifact`);
  const body = await first.text();
  assert.ok(
    body.length > 0,
    `${path}: the first GET returned no bytes, so the conditional exchanges below would prove nothing`,
  );

  const conditional = await get(path, { headers: { 'If-None-Match': etag } });
  assert.equal(conditional.status, 304, `${path}: a matching If-None-Match did not revalidate to 304`);
  assert.equal(
    conditional.headers.get('cache-control'),
    REVALIDATION,
    `${path}: the 304 did not repeat the revalidating policy, so the response's caching state would change mid-conversation`,
  );
  assert.equal(await conditional.text(), '', `${path}: the 304 carried a body`);

  const stale = await get(path, { headers: { 'If-None-Match': '"stale-validator"' } });
  assert.equal(stale.status, 200, `${path}: a stale validator produced a ${stale.status} instead of the full response`);
  assert.equal(await stale.text(), body, `${path}: a stale validator produced different bytes than the first 200`);

  return { etag, body };
}

test('an HTML note route revalidates and is never immutable', async () => {
  // HTML is rewritten on every build at a stable URL, so the host default
  // (revalidate) is what keeps a returning reader's page fresh. Marking it
  // immutable would pin last build's markup — including a stale snapshot
  // binding — for a year. The route must also still be the document itself:
  // a 304 conversation about an error page would satisfy the header checks
  // while serving nothing.
  const { body } = await assertRevalidating('/notes/alpha/');
  assert.match(body, /^<!DOCTYPE html>/i, '/notes/alpha/: the note route did not serve an HTML document');
});

test('stable-named Pagefind metadata revalidates and is never immutable', async () => {
  // `pagefind-entry.json` and `wasm.*.pagefind` are stable-named and rewritten
  // by every build, while only `pagefind/index/*` and `pagefind/fragment/*`
  // carry content hashes. `public/_headers` deliberately does not name
  // `/pagefind/*`: an immutable rule there would hand a frequent reader an
  // entry file pointing at index chunks the next publish deletes, breaking
  // search silently. This asserts the HTTP behavior that comment promises.
  const names = readdirSync(join(site.dist, 'pagefind'));
  const wasmName = names.filter((name) => /^wasm\..+\.pagefind$/.test(name)).sort()[0];
  assert.ok(
    wasmName,
    `no wasm.*.pagefind under ${join(site.dist, 'pagefind')}, so the stable Pagefind half would only be text: ${names.join(', ')}`,
  );
  await assertRevalidating('/pagefind/pagefind-entry.json');
  await assertRevalidating(`/pagefind/${wasmName}`);
});

test('the hashed Worker chunk is cached immutably', async () => {
  // `/_astro/*` is exactly Astro's content-hashed output, and the Worker chunk
  // embeds the snapshot binding, so a rebuild changes its bytes and its URL.
  // Immutable caching here is what lets a returning reader's cached page
  // reconstruct its Worker without a conditional request. It is also the
  // negative's twin: without this rule the chunk would fall back to the
  // revalidating default that every other path asserts, so only the two
  // together say which asset classes the policy actually separates.
  const path = workerScriptPath(site.dist);
  const response = await get(path);
  assert.equal(response.status, 200, `${path}: the hashed Worker chunk was not served`);
  assert.equal(
    response.headers.get('cache-control'),
    IMMUTABLE,
    `${path}: the content-hashed Worker chunk did not receive the immutable rule public/_headers grants /_astro/*`,
  );
  await response.body?.cancel();
});

test('the digest-named snapshot revalidates and is never immutable', async () => {
  // The DB URL contains the full SHA-256 of its bytes, but the bytes still
  // revalidate at the host default: a reader whose page predates a new
  // deployment must be told the snapshot is gone, not served some other
  // build's DB. A host-level immutable rule would ask the browser to reuse a
  // cached copy blindly; this asserts the response keeps the ETag conversation
  // open.
  const name = basename(snapshotPath(site.dist));
  assert.match(name, /^site\.[0-9a-f]{64}\.sqlite$/, `the built snapshot is not digest-named: ${name}`);
  await assertRevalidating(`/data/${name}`);
});

test('the runtime asset classes carry the MIME types the host documents', async () => {
  // These are the host's documented extension mappings, which the harness
  // stands in for: `.js` -> `text/javascript`, `.wasm` -> `application/wasm`,
  // `.sqlite` -> `application/octet-stream`. The browser suite proves Chromium
  // consumes the Worker, WASM, and DB under these plus the shipped CSP, so
  // this test owns only the transport metadata a deployment must reproduce.
  // A wrong type here is the classic failure: `nosniff` then refuses the
  // asset, and the static fallback is all a reader ever gets.
  const worker = await get(workerScriptPath(site.dist));
  assert.equal(
    worker.headers.get('content-type'),
    'text/javascript',
    'the Worker chunk was not served as text/javascript',
  );
  await worker.body?.cancel();

  const wasmNames = readdirSync(join(site.dist, 'wasm')).filter((name) => name.endsWith('.wasm')).sort();
  assert.ok(wasmNames.length > 0, `no .wasm under ${join(site.dist, 'wasm')}, so the WASM MIME claim is untested`);
  const wasm = await get(`/wasm/${wasmNames[0]!}`);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm', `the WASM binary ${wasmNames[0]} was mistyped`);
  await wasm.body?.cancel();

  const dbName = basename(snapshotPath(site.dist));
  const database = await get(`/data/${dbName}`);
  assert.equal(
    database.headers.get('content-type'),
    'application/octet-stream',
    `the snapshot ${dbName} was not served as application/octet-stream`,
  );
  await database.body?.cancel();
});

/**
 * The control on the validator itself, declared last because it mutates the
 * served output: if the ETag never changed, every 304 above would pass for a
 * server that answered 304 to any `If-None-Match` at all.
 */
test('a changed served file gets a new validator and the old one stops revalidating', async () => {
  const path = '/notes/beta/';
  const before = await assertRevalidating(path);

  // Appending bytes is deterministic: the harness's validator includes the
  // file size, so this changes it even if the rewrite lands in the same
  // millisecond as the original build.
  appendFileSync(join(site.dist, 'notes', 'beta', 'index.html'), '\n<!-- host snapshot policy mutation probe -->\n');

  const after = await get(path);
  assert.equal(after.status, 200, `${path}: the changed file stopped being served`);
  const afterEtag = after.headers.get('etag');
  assert.ok(afterEtag, `${path}: the changed file was served without a validator`);
  assert.notEqual(afterEtag, before.etag, `${path}: the ETag survived the file's bytes changing`);

  const stale = await get(path, { headers: { 'If-None-Match': before.etag } });
  assert.equal(stale.status, 200, `${path}: the old validator still revalidated after the file changed`);
  assert.equal(await stale.text(), await after.text(), `${path}: the stale conditional returned different bytes than a fresh GET`);
});
