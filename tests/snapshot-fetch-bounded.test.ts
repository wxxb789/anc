/**
 * `fetchBounded` enforces the decoded-byte cap on a real HTTP stream.
 *
 * `docs/core-design/build-and-runtime.md` defines the property under test:
 * `Content-Length` "can be absent and can differ from the decoded body length.
 * It is an optional early hint, not a correctness prerequisite. The reader
 * enforces a decoded-byte limit while streaming and aborts excess data before
 * allocating WASM memory."
 *
 * Each case drives the exported `fetchBounded` from
 * `src/scripts/snapshot-worker.ts` against a real `node:http` server and
 * records what the *server* saw as well as what the promise did. That second
 * half is load-bearing: an implementation that buffered the whole response and
 * then refused it would satisfy a response-only assertion while still reading
 * and holding the excess, so the server-side abort is what distinguishes
 * "capped while streaming" from "refused after a full download".
 *
 * The browser half of goal 0003's resource row — the abort happens before any
 * WASM import, and a misleading `Content-Length` cannot bypass the cap in
 * Chromium — is `tests/preview-limits.test.ts`. The unbounded-request-queue
 * half of the same row is `tests/snapshot-client.test.ts`.
 *
 * Two cases execute behavior the HTTP client owns rather than this module, and
 * their comments say which verdict is expected and why:
 *
 * - `Content-Length` understating a larger body: undici frames the response by
 *   the declared length, so `fetchBounded` resolves with exactly the declared
 *   bytes and the server sees the reader hang up mid-stream. The worker's
 *   digest check refuses those bytes one layer up (`load` in
 *   `snapshot-worker.ts`), so the property that holds here is "the header
 *   cannot enlarge what the reader decodes", not "the cap rejected it".
 * - `Content-Length` overstating a shorter body: the response is truncated at
 *   the transport layer and undici rejects with a bare `TypeError`, so the
 *   assertion is a fail-closed rejection carrying no `SnapshotErrorCode`.
 *
 * Measured on Node v22.23.2 / undici and recorded in those cases because both
 * look like "the cap did not fire" and neither is.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, test } from 'vitest';

type FetchBounded = typeof import('../src/scripts/snapshot-worker.ts')['fetchBounded'];

let fetchBounded: FetchBounded;

beforeAll(async () => {
  // The Worker entry reads `self` at module scope; this stub is what lets the
  // module load in Node. Nothing here posts to it or listens through it.
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: { addEventListener() {}, postMessage() {} },
  });
  ({ fetchBounded } = await import('../src/scripts/snapshot-worker.ts'));
});

/**
 * One 256-byte write every 20 ms keeps the reader mid-stream while the cap
 * trips. That matters for the abort observation: with a fast writer the server
 * can finish before a localhost cancel propagates, and then "the server saw the
 * abort" would be a race instead of a measurement.
 */
const LIMIT = 1024;
const CHUNK = 256;
const CHUNK_DELAY_MS = 20;
const OVER_CAP_BYTES = LIMIT * 4;

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

/** A deterministic body so a truncated read can be compared to its prefix. */
function patterned(size: number): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, index) => index % 256));
}

/** What the server observed, for the abort assertions below. */
interface StreamStats {
  /** Bytes handed to `response.write`, whether or not the client read them. */
  written: number;
  /** The handler reached `response.end()` without the connection dying first. */
  finished: boolean;
  /** The connection closed before `finished`, i.e. the client aborted the read. */
  aborted: boolean;
}

interface StreamServer {
  url: string;
  stats: StreamStats;
  close(): Promise<void>;
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, stats: StreamStats) => Promise<void>,
): Promise<StreamServer> {
  const stats: StreamStats = { written: 0, finished: false, aborted: false };
  const server: Server = createServer((request, response) => {
    // 'close' fires for a completed response *and* for a connection torn down
    // mid-response; only the second means the reader hung up, and `finished` is
    // what separates them.
    response.on('close', () => {
      if (!stats.finished) stats.aborted = true;
    });
    void handler(request, response, stats);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/snapshot`,
    stats,
    close(): Promise<void> {
      // A keep-alive socket from the happy path would otherwise hold the
      // server open past the test.
      server.closeAllConnections();
      return new Promise((done) => server.close(() => done()));
    },
  };
}

/**
 * Stream a body slowly, stopping the moment the connection is gone.
 *
 * `stopAfter` is what makes the abort observation deterministic. A writer that
 * keeps trickling while the client's cancel propagates writes a
 * scheduler-dependent number of extra chunks — the first full-suite run measured
 * 1536 bytes against an expected 1280 — and that overshoot is not a property
 * worth asserting. Stopping at cap + one chunk leaves the response open, so the
 * reader's cancel is the only thing that closes it and the byte count is exact.
 */
async function trickle(
  response: ServerResponse,
  stats: StreamStats,
  body: Buffer,
  stopAfter = body.length,
): Promise<void> {
  for (let written = 0; written < body.length && written < stopAfter && !response.destroyed; written += CHUNK) {
    const slice = body.subarray(written, written + CHUNK);
    response.write(slice);
    stats.written += slice.length;
    await delay(CHUNK_DELAY_MS);
  }
  if (stats.written >= body.length && !response.destroyed && !response.writableEnded) {
    response.end();
    stats.finished = true;
  }
}

/** Poll, because the server learns of the client's cancel asynchronously. */
async function observed(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return predicate();
}

test('a chunked response over the cap rejects integrity and the server sees the abort', async () => {
  const server = await serve(async (_request, response, stats) => {
    // No Content-Length at all: the running total is the only bound the reader
    // has, which is the case the design's "can be absent" sentence names.
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    await trickle(response, stats, patterned(OVER_CAP_BYTES), LIMIT + CHUNK);
  });
  try {
    await assert.rejects(
      fetchBounded(server.url, LIMIT),
      (error: Error & { code?: string }) => error.code === 'integrity',
      'an over-cap chunked response was not rejected as an integrity failure',
    );
    assert.equal(
      await observed(() => server.stats.aborted),
      true,
      'the server finished writing, so the cap was reported only after a full download',
    );
    assert.equal(
      server.stats.written,
      LIMIT + CHUNK,
      `the server wrote ${server.stats.written} bytes instead of stopping at cap + one chunk`,
    );
  } finally {
    await server.close();
  }
}, 120_000);

test('an understated Content-Length bounds the decoded body and the server sees the abort', async () => {
  // Measured: undici frames the response by the declared length. The reader
  // decodes the declared 8 bytes and the connection is then torn down, so a
  // header claiming less than the server sends **cannot enlarge** what is
  // decoded. The worker's digest check (`load`) is what refuses bytes like
  // these; this case pins the transport property instead: the full body is
  // never delivered and the cap is not the thing that has to catch it.
  const declared = 8;
  const body = patterned(OVER_CAP_BYTES);
  const server = await serve(async (_request, response, stats) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(declared) });
    await trickle(response, stats, body);
  });
  try {
    const bytes = await fetchBounded(server.url, LIMIT);
    assert.deepEqual(
      Buffer.from(bytes),
      body.subarray(0, declared),
      `the reader decoded ${bytes.byteLength} bytes, not the declared ${declared}`,
    );
    assert.ok(bytes.byteLength <= LIMIT, 'the declared body exceeded the cap it was supposed to fit under');
    assert.ok(
      server.stats.written < OVER_CAP_BYTES,
      `the server wrote its whole ${OVER_CAP_BYTES}-byte body, so the connection was not cut short`,
    );
    assert.equal(
      await observed(() => server.stats.aborted),
      true,
      'the server finished writing the whole body, so the misleading header did not stop the read early',
    );
  } finally {
    await server.close();
  }
}, 120_000);

test('a Content-Length between the cap and the body does not hold the cap back', async () => {
  // The header still lies (2048 declared, 4096 offered), but the declaration is
  // larger than the cap, so the reader must trip on the running total while the
  // real body is still arriving. This is the case a reader that trusted the
  // header would pass through: it would admit up to 2048 bytes before noticing.
  const declared = LIMIT * 2;
  const server = await serve(async (_request, response, stats) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(declared) });
    await trickle(response, stats, patterned(OVER_CAP_BYTES), LIMIT + CHUNK);
  });
  try {
    await assert.rejects(
      fetchBounded(server.url, LIMIT),
      (error: Error & { code?: string }) => error.code === 'integrity',
      'a stream that outran a lying Content-Length was not rejected at the cap',
    );
    assert.equal(await observed(() => server.stats.aborted), true, 'the server finished writing before the read stopped');
    assert.equal(
      server.stats.written,
      LIMIT + CHUNK,
      `the server wrote ${server.stats.written} bytes instead of stopping at cap + one chunk`,
    );
  } finally {
    await server.close();
  }
}, 120_000);

test('an honest Content-Length over the cap rejects integrity with a bounded read', async () => {
  const server = await serve(async (_request, response, stats) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(OVER_CAP_BYTES) });
    await trickle(response, stats, patterned(OVER_CAP_BYTES), LIMIT + CHUNK);
  });
  try {
    await assert.rejects(
      fetchBounded(server.url, LIMIT),
      (error: Error & { code?: string }) => error.code === 'integrity',
      'an over-cap response was not rejected as an integrity failure',
    );
    assert.equal(await observed(() => server.stats.aborted), true, 'the server finished writing before the read stopped');
    assert.equal(
      server.stats.written,
      LIMIT + CHUNK,
      `the server wrote ${server.stats.written} bytes instead of stopping at cap + one chunk`,
    );
  } finally {
    await server.close();
  }
}, 120_000);

test('a body within the cap resolves byte-identical', async () => {
  const body = patterned(768);
  const server = await serve(async (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
    });
    response.end(body);
  });
  try {
    const bytes = await fetchBounded(server.url, LIMIT);
    assert.deepEqual(Buffer.from(bytes), body, 'a within-cap body did not round-trip byte-identically');
  } finally {
    await server.close();
  }
}, 120_000);

test('a non-2xx response rejects as a fetch failure', async () => {
  const server = await serve(async (_request, response) => {
    response.writeHead(500, { 'Content-Type': 'text/plain' });
    response.end('boom');
  });
  try {
    await assert.rejects(
      fetchBounded(server.url, LIMIT),
      (error: Error & { code?: string }) => error.code === 'fetch',
      'a 500 response did not reject as a fetch failure',
    );
  } finally {
    await server.close();
  }
}, 120_000);

test('a redirect rejects as a fetch failure rather than being followed', async () => {
  // `/real` is a body a follower would accept, so removing `redirect: 'error'`
  // makes this test resolve and fail instead of failing for an unrelated reason.
  const server = await serve(async (request, response) => {
    if (request.url === '/snapshot') {
      response.writeHead(302, { Location: '/real' });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(patterned(64));
  });
  try {
    await assert.rejects(
      fetchBounded(server.url, LIMIT),
      (error: Error & { code?: string }) => error.code === 'fetch',
      'a redirect was followed or rejected with the wrong code',
    );
  } finally {
    await server.close();
  }
}, 120_000);

test('an over-claiming Content-Length fails closed on the truncated transport', async () => {
  // The design calls Content-Length "an optional early hint, not a correctness
  // prerequisite". Measured, an over-claim is not something the reader can
  // resolve: undici reports the response as truncated (a bare TypeError) once
  // the connection closes short of the declared length. What the reader must do
  // is fail closed, which is what this asserts; the absence of a
  // `SnapshotErrorCode` is recorded deliberately, because the Worker's
  // `codeOf` then maps it to the generic `sql` code rather than to `fetch`.
  // `fetchBounded` never inspects the header, and a complete body under a
  // truthful or absent header is the within-cap case above.
  const server = await serve(async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '9999' });
    response.end(patterned(512));
  });
  try {
    await assert.rejects(
      fetchBounded(server.url, LIMIT),
      (error: Error & { code?: string }) => error.code === undefined,
      'a truncated response resolved or was assigned a SnapshotErrorCode it does not carry',
    );
  } finally {
    await server.close();
  }
}, 120_000);

test('an aborted signal cancels the read mid-stream and the server sees the abort', async () => {
  // `load` passes one controller to both downloads, so whichever fails first
  // aborts the other. This drives that seam directly: the cap is deliberately
  // far above the body, so the abort is the only thing that can stop the read.
  const server = await serve(async (_request, response, stats) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    await trickle(response, stats, patterned(OVER_CAP_BYTES));
  });
  try {
    const controller = new AbortController();
    const aborted = assert.rejects(
      fetchBounded(server.url, LIMIT * 100, controller.signal),
      (error: Error) => error.name === 'AbortError',
      'an aborted fetch did not reject with AbortError',
    );
    await delay(CHUNK_DELAY_MS * 2);
    controller.abort();
    await aborted;
    assert.equal(
      await observed(() => server.stats.aborted),
      true,
      'the server finished writing, so the signal did not cancel the read',
    );
    assert.ok(
      server.stats.written < OVER_CAP_BYTES,
      `the server wrote its whole ${OVER_CAP_BYTES}-byte body, so the abort did not cut the response short`,
    );
  } finally {
    await server.close();
  }
}, 120_000);

test('a response without a readable stream enforces the cap on the buffered body', async () => {
  // Some engines do not expose `Response.body`; the fallback buffers the whole
  // body and then applies the same limit. It is the one branch the streaming
  // cases above cannot reach, and it must still refuse over-cap data.
  const exact = (buffer: Buffer): ArrayBuffer =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const realFetch = globalThis.fetch;
  try {
    const over = patterned(OVER_CAP_BYTES);
    const within = patterned(256);
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => ({
      ok: true,
      body: null,
      arrayBuffer: async () => exact(url.endsWith('/within') ? within : over),
    });
    await assert.rejects(
      fetchBounded('http://runtime.test/over', LIMIT),
      (error: Error & { code?: string }) => error.code === 'integrity',
      'an over-cap buffered body was not refused as an integrity failure',
    );
    const bytes = await fetchBounded('http://runtime.test/within', LIMIT);
    assert.deepEqual(Buffer.from(bytes), within, 'a within-cap buffered body did not round-trip');
  } finally {
    globalThis.fetch = realFetch;
  }
}, 120_000);
