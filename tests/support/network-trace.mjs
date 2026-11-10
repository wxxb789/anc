/**
 * Test-only process instrumentation for the optional R2 publishing path.
 *
 * Loaded with `node --import` into a child running `bin/anc.mjs`. It does two
 * things, both observable from the parent through one trace file:
 *
 * 1. Records any attempt to resolve `aws4fetch`, so a test can prove an
 *    ordinary build never loads the signer rather than asserting it in prose.
 * 2. Replaces `globalThis.fetch`, recording every outbound URL. With
 *    `ANC_FAKE_ORIGIN` set, the two documentation hostnames are mapped to the
 *    local protocol fake, which keeps the child's configuration HTTPS-valid
 *    while the bytes still cross a real socket. Without it, every fetch throws,
 *    so an ordinary build that reaches the network fails loudly.
 *
 * This is a test seam for the protocol layer, not a product feature. The fake
 * itself lives in `tests/support/r2-fake.ts`; the in-process publisher tests use
 * it directly over HTTP.
 */

import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const trace = process.env['ANC_NETWORK_TRACE'];
const fakeOrigin = process.env['ANC_FAKE_ORIGIN'];
const mappedHosts = new Set(['r2.invalid', 'media.invalid']);

function record(line) {
  if (trace !== undefined) appendFileSync(trace, `${line}\n`);
}

if (registerHooks !== undefined) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'aws4fetch') record('module:aws4fetch');
      return nextResolve(specifier, context);
    },
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  record(`fetch:${request.method}:${url.origin}${url.pathname}`);

  if (fakeOrigin === undefined || !mappedHosts.has(url.hostname)) {
    throw new TypeError(`network refused by the test preload: ${url.origin}`);
  }

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
  return realFetch(`${fakeOrigin}${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    ...(body === undefined ? {} : { body }),
    redirect: init?.redirect ?? 'manual',
    signal: init?.signal,
  });
};
