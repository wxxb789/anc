/**
 * The measured static server: `dist/` on loopback under the output's own
 * `_headers`, with gzip negotiation and a per-response completion log.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { applyRules, headerRules } from '../tests/support/browser-site.ts';
import { walkFiles } from './benchmark-files.ts';
import { ROOT, scrub } from './benchmark-host.ts';

/** Cloudflare Pages' default for a 200 no `_headers` rule names. */
const PLATFORM_REVALIDATION = 'public, max-age=0, must-revalidate';

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.sqlite': 'application/octet-stream',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface ServerRecord {
  path: string;
  method: string;
  status: number | null;
  completion: 'finished' | 'aborted';
  cacheControl: string;
  contentEncoding: string | null;
  contentLength: string | null;
  bytesServed: number | null;
  startedAtMs: number;
  endedAtMs: number;
}

export interface StaticServer {
  origin: string;
  headersSource: string;
  records: ServerRecord[];
  close(): Promise<void>;
}

export interface StaticServerOptions {
  /** Use a fixed port in focused tests; production keeps the ephemeral default. */
  port?: number;
  /** Test-only delay that makes a non-zero request duration observable. */
  responseDelayMs?: number;
}

/** Record exactly one terminal server-response event. */
export function recordResponseCompletion(
  response: Pick<ServerResponse, 'once'>,
  record: (completion: ServerRecord['completion']) => void,
): void {
  let completed = false;
  const finish = (completion: ServerRecord['completion']): void => {
    if (completed) return;
    completed = true;
    record(completion);
  };
  response.once('finish', () => finish('finished'));
  response.once('close', () => finish('aborted'));
}

interface PreparedAsset {
  body: Buffer;
  gzip: Buffer;
}

function preparedAssets(root: string): Map<string, PreparedAsset> {
  const assets = new Map<string, PreparedAsset>();
  for (const file of walkFiles(root)) {
    const body = readFileSync(file);
    assets.set(file, { body, gzip: gzipSync(body) });
  }
  return assets;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Await one loopback listen and surface bind errors to the caller. */
export function listenServer(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, '127.0.0.1');
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Serve `dist/` on loopback with per-path `_headers`, gzip negotiation, and a
 * response log.
 *
 * gzip is applied whenever the request's `Accept-Encoding` names it. Bodies are
 * compressed once during server setup, before browser timing begins, and the
 * request callback only selects the cached bytes. `Content-Length` is always
 * the bytes of the body actually written.
 */
export async function startStaticServer(dist: string, options: StaticServerOptions = {}): Promise<StaticServer> {
  const outputHeaders = join(dist, '_headers');
  const headersSource = existsSync(outputHeaders) ? 'dist/_headers' : 'public/_headers';
  const rules = headerRules(readFileSync(existsSync(outputHeaders) ? outputHeaders : join(ROOT, 'public', '_headers'), 'utf8'));
  const records: ServerRecord[] = [];
  const root = resolve(dist);
  // Compress before the browser starts. Request callbacks only select a cached
  // body, so host-side gzip CPU cannot enter a timed cold intent.
  const assets = preparedAssets(root);
  const serverStart = Date.now();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestStartedAtMs = Date.now() - serverStart;
    let recordRegistered = false;
    const registerRecord = (
      path: string,
      headers: Record<string, string>,
      status: number,
      bodyBytes: number,
      contentEncoding: string | null,
      started: number,
    ): void => {
      if (recordRegistered) return;
      recordRegistered = true;
      const cacheControl = headers['Cache-Control'] ?? '';
      const contentLength = headers['Content-Length'] ?? null;
      recordResponseCompletion(response, (completion) => {
        records.push({
          path,
          method: request.method ?? 'GET',
          status: response.headersSent ? response.statusCode : completion === 'finished' ? status : null,
          completion,
          cacheControl,
          contentEncoding,
          contentLength,
          bytesServed: completion === 'finished' ? bodyBytes : null,
          startedAtMs: started,
          endedAtMs: Date.now() - serverStart,
        });
      });
    };
    void (async (): Promise<void> => {
      const startedAtMs = requestStartedAtMs;
      const responseDelayMs = options.responseDelayMs ?? 0;
      const waitBeforeResponse = async (): Promise<void> => {
        if (responseDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, responseDelayMs));
      };
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      registerRecord(request.url ?? '/', { 'Cache-Control': PLATFORM_REVALIDATION }, 400, 0, null, startedAtMs);
      response.writeHead(400);
      response.end('bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const headers = applyRules(rules, pathname);
    if (headers['Cache-Control'] === undefined) headers['Cache-Control'] = PLATFORM_REVALIDATION;
    const file = resolve(root, `.${pathname}`);
    // Directory boundary, not a string prefix: `/tmp/x/dist2/...` starts with
    // `/tmp/x/dist`, so a prefix test would serve a sibling's bytes.
    if (file !== root && !file.startsWith(root + sep)) {
      registerRecord(pathname, headers, 403, 0, null, startedAtMs);
      response.writeHead(403, headers);
      response.end('forbidden');
      return;
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      registerRecord(pathname, headers, 404, 0, null, startedAtMs);
      response.writeHead(404, headers);
      response.end('not found');
      return;
    }
    const asset = assets.get(file);
    if (asset === undefined) {
      registerRecord(pathname, headers, 500, 0, null, startedAtMs);
      response.writeHead(500, headers);
      response.end('asset changed while serving');
      return;
    }
    const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    if (request.headers['if-none-match'] === etag) {
      headers['ETag'] = etag;
      registerRecord(pathname, headers, 304, 0, null, startedAtMs);
      response.writeHead(304, headers);
      response.end();
      return;
    }
    let body: Buffer = asset.body;
    let contentEncoding: string | null = null;
    if ((request.headers['accept-encoding'] ?? '').includes('gzip')) {
      body = asset.gzip;
      contentEncoding = 'gzip';
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    }
    headers['Content-Type'] = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    headers['Content-Length'] = String(body.length);
    headers['ETag'] = etag;
    registerRecord(pathname, headers, 200, body.length, contentEncoding, startedAtMs);
    await waitBeforeResponse();
    response.writeHead(200, headers);
    response.end(body);
    })().catch((error: unknown) => {
      if (!recordRegistered) {
        registerRecord(request.url ?? '/', { 'Cache-Control': PLATFORM_REVALIDATION }, 500, 0, null, requestStartedAtMs);
      }
      if (!response.headersSent) {
        response.writeHead(500);
        response.end('internal server error');
      }
      process.stderr.write(`benchmark static server request failed: ${scrub(error)}\n`);
    });
  });
  try {
    await listenServer(server, options.port ?? 0);
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    headersSource,
    records,
    close(): Promise<void> {
      return closeServer(server);
    },
  };
}
