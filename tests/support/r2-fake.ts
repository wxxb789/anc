/**
 * A local S3/R2 protocol fake for the optional media publisher's failure gates.
 *
 * It speaks the three operations the design names — `HEAD`, `PUT`, `GET` — over
 * a real `node:http` server, so the publisher is exercised through its actual
 * request layer rather than a mocked `fetch`. Tests choose per-request
 * misbehaviour with the action callbacks; the default is a correct,
 * strongly-consistent bucket.
 *
 * The fake enforces the parts of the protocol the publisher relies on:
 * `If-None-Match: *` is required on `PUT`, the signature must name the expected
 * access key ID, `Content-MD5` must match the received bytes, and an existing
 * object answers `412` rather than being overwritten. Those checks are what let
 * a test distinguish "the publisher sent the right request" from "the test
 * believed it would".
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** What a `PUT` should do for one attempt. */
export type PutAction =
  | { readonly kind: 'store' }
  /** Commit, then destroy the connection before the response. */
  | { readonly kind: 'store-then-drop' }
  /** Destroy the connection without committing. */
  | { readonly kind: 'drop' }
  /** Commit, then leave the response open until the client times out. */
  | { readonly kind: 'store-then-hang' }
  /** Leave the response open without committing. */
  | { readonly kind: 'hang' }
  /** Read part of the body, then destroy the connection. */
  | { readonly kind: 'partial' }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'redirect'; readonly location: string }
  /** Store bytes other than the request body, under the requested key. */
  | { readonly kind: 'store-substitute'; readonly bytes: Buffer; readonly contentType: string };

/** What an S3 `GET` should do for one attempt. */
export type S3GetAction =
  | { readonly kind: 'normal' }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'drop' }
  | { readonly kind: 'redirect'; readonly location: string };

/** What a public custom-domain `GET` should do for one attempt. */
export type PublicAction =
  | { readonly kind: 'normal' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'wrong-bytes'; readonly bytes: Buffer }
  | { readonly kind: 'wrong-type'; readonly contentType: string }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'drop' };

/** One object as the fake holds it. */
export interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
}

/** One received request, reduced to what a test can assert without secrets. */
export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly ifNoneMatch: string | undefined;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly contentMd5: string | undefined;
  readonly bodyDigest: string | undefined;
}

/** A fake bucket with controllable failure points. */
export class R2Fake {
  readonly objects = new Map<string, StoredObject>();
  readonly requests: FakeRequest[] = [];
  readonly putBodies: string[] = [];

  /** The bucket name the S3 routes are scoped to. */
  readonly bucket: string;
  /** The access key ID the `Authorization` header must name. */
  readonly accessKeyId: string;

  /** Choose the action for a `PUT`; the default is `store`. */
  putAction: (objectPath: string, attempt: number) => PutAction = () => ({ kind: 'store' });
  /** Choose the action for an S3 `GET`; the default is `normal`. */
  s3GetAction: (objectPath: string, attempt: number) => S3GetAction = () => ({ kind: 'normal' });
  /** Choose the action for a public `GET`; the default is `normal`. */
  publicAction: (objectPath: string, attempt: number) => PublicAction = () => ({ kind: 'normal' });
  /** Answer every request with this status before routing, when set. */
  rejectStatus: number | undefined;

  private readonly attempts = new Map<string, number>();
  private readonly server: Server;
  private readonly hanging = new Set<ServerResponse>();
  private origin = '';

  constructor(options: { bucket: string; accessKeyId: string }) {
    this.bucket = options.bucket;
    this.accessKeyId = options.accessKeyId;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        // The client saw a dropped connection; the test's assertion is about
        // the publisher's behaviour, not this fake's error handling.
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('the fake did not bind a TCP port');
    this.origin = `http://127.0.0.1:${address.port}`;
    return this.origin;
  }

  get base(): string {
    return this.origin;
  }

  async close(): Promise<void> {
    for (const response of this.hanging) response.destroy();
    this.hanging.clear();
    // Fetch keeps idle sockets alive; `close()` alone would wait for the
    // keep-alive timeout after every test.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Every object path the fake was asked to store or replace. */
  putPaths(): string[] {
    return this.requests.filter((request) => request.method === 'PUT').map((request) => request.path);
  }

  /** The number of `PUT` requests for one object path. */
  putsFor(objectPath: string): number {
    return this.requests.filter(
      (request) => request.method === 'PUT' && decodePath(request.path, this.bucket) === objectPath,
    ).length;
  }

  private attempt(key: string): number {
    const count = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, count);
    return count;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin);
    const pathname = url.pathname;

    if (this.rejectStatus !== undefined) {
      this.record(request, pathname, undefined);
      await drain(request);
      response.statusCode = this.rejectStatus;
      response.end();
      return;
    }

    const bucketPrefix = `/${this.bucket}/`;
    if (pathname.startsWith(bucketPrefix)) {
      const objectPath = decodePath(pathname, this.bucket);
      if (objectPath === undefined) {
        await drain(request);
        response.statusCode = 400;
        response.end();
        return;
      }
      if (request.method === 'PUT') await this.handlePut(request, response, objectPath);
      else if (request.method === 'GET') await this.handleS3Get(request, response, objectPath, pathname);
      else if (request.method === 'HEAD') await this.handleHead(request, response, objectPath, pathname);
      else {
        this.record(request, pathname, undefined);
        await drain(request);
        response.statusCode = 405;
        response.end();
      }
      return;
    }

    const publicPath = decodeURIComponent(pathname);
    if (request.method === 'GET' || request.method === 'HEAD') {
      await this.handlePublic(request, response, publicPath, pathname);
      return;
    }

    this.record(request, pathname, undefined);
    await drain(request);
    response.statusCode = 405;
    response.end();
  }

  private record(request: IncomingMessage, path: string, bodyDigest: string | undefined): void {
    this.requests.push({
      method: request.method ?? '',
      path,
      authorization: String(request.headers['authorization'] ?? ''),
      ifNoneMatch:
        typeof request.headers['if-none-match'] === 'string' ? request.headers['if-none-match'] : undefined,
      contentType:
        typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : undefined,
      cacheControl:
        typeof request.headers['cache-control'] === 'string' ? request.headers['cache-control'] : undefined,
      contentMd5:
        typeof request.headers['content-md5'] === 'string' ? request.headers['content-md5'] : undefined,
      bodyDigest,
    });
  }

  private async handlePut(
    request: IncomingMessage,
    response: ServerResponse,
    objectPath: string,
  ): Promise<void> {
    const attempt = this.attempt(objectPath);
    const action = this.putAction(objectPath, attempt);

    // A partial upload is the one action that must interrupt the body, so it
    // decides before the fake waits for a complete request.
    if (action.kind === 'partial') {
      this.record(request, request.url ?? objectPath, undefined);
      request.once('data', () => request.socket.destroy());
      request.resume();
      return;
    }

    const body = await readBody(request);
    const digest = createHash('sha256').update(body).digest('hex');
    this.record(request, request.url ?? objectPath, digest);
    this.putBodies.push(digest);

    // The three request properties the publisher is required to send. The fake
    // answers as a real bucket would rather than accepting a request that would
    // not have worked against R2.
    if (!String(request.headers['authorization'] ?? '').includes(`Credential=${this.accessKeyId}/`)) {
      response.statusCode = request.headers['authorization'] === undefined ? 401 : 403;
      response.end();
      return;
    }
    if (request.headers['if-none-match'] !== '*') {
      response.statusCode = 428;
      response.end();
      return;
    }
    const declared = request.headers['content-md5'];
    const expected = createHash('md5').update(body).digest('base64');
    if (typeof declared !== 'string' || declared !== expected) {
      response.statusCode = 400;
      response.end();
      return;
    }

    switch (action.kind) {
      case 'status':
        response.statusCode = action.status;
        response.end();
        return;
      case 'redirect':
        response.statusCode = 307;
        response.setHeader('Location', action.location);
        response.end();
        return;
      case 'drop':
        request.socket.destroy();
        return;
      case 'hang':
        this.hang(response);
        return;
      case 'store-then-drop':
        this.store(objectPath, body, request);
        request.socket.destroy();
        return;
      case 'store-then-hang':
        this.store(objectPath, body, request);
        this.hang(response);
        return;
      case 'store-substitute':
        this.objects.set(objectPath, {
          bytes: action.bytes,
          contentType: action.contentType,
          cacheControl: String(request.headers['cache-control'] ?? ''),
        });
        response.statusCode = 200;
        response.end();
        return;
      case 'store':
        if (this.objects.has(objectPath)) {
          response.statusCode = 412;
          response.end();
          return;
        }
        this.store(objectPath, body, request);
        response.statusCode = 200;
        response.end();
        return;
    }
  }

  private store(objectPath: string, body: Buffer, request: IncomingMessage): void {
    this.objects.set(objectPath, {
      bytes: Buffer.from(body),
      contentType: String(request.headers['content-type'] ?? 'application/octet-stream'),
      cacheControl: String(request.headers['cache-control'] ?? ''),
    });
  }

  private hang(response: ServerResponse): void {
    this.hanging.add(response);
    response.once('close', () => this.hanging.delete(response));
  }

  private async handleS3Get(
    request: IncomingMessage,
    response: ServerResponse,
    objectPath: string,
    path: string,
  ): Promise<void> {
    this.record(request, path, undefined);
    const attempt = this.attempt(`get:${objectPath}`);
    const action = this.s3GetAction(objectPath, attempt);
    if (action.kind === 'status') {
      response.statusCode = action.status;
      response.end();
      return;
    }
    if (action.kind === 'drop') {
      request.socket.destroy();
      return;
    }
    if (action.kind === 'redirect') {
      response.statusCode = 307;
      response.setHeader('Location', action.location);
      response.end();
      return;
    }
    this.sendStored(response, objectPath);
  }

  private async handleHead(
    request: IncomingMessage,
    response: ServerResponse,
    objectPath: string,
    path: string,
  ): Promise<void> {
    this.record(request, path, undefined);
    const object = this.objects.get(objectPath);
    if (object === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', object.contentType);
    response.setHeader('Cache-Control', object.cacheControl);
    response.setHeader('Content-Length', String(object.bytes.length));
    response.end();
  }

  private async handlePublic(
    request: IncomingMessage,
    response: ServerResponse,
    objectPath: string,
    path: string,
  ): Promise<void> {
    this.record(request, path, undefined);
    const attempt = this.attempt(`public:${objectPath}`);
    const action = this.publicAction(objectPath, attempt);
    switch (action.kind) {
      case 'not-found':
        response.statusCode = 404;
        response.end();
        return;
      case 'drop':
        request.socket.destroy();
        return;
      case 'redirect':
        response.statusCode = 302;
        response.setHeader('Location', action.location);
        response.end();
        return;
      case 'wrong-bytes': {
        const object = this.objects.get(objectPath);
        response.statusCode = 200;
        response.setHeader('Content-Type', object?.contentType ?? 'application/octet-stream');
        response.setHeader('Content-Length', String(action.bytes.length));
        response.end(request.method === 'HEAD' ? undefined : action.bytes);
        return;
      }
      case 'wrong-type': {
        const object = this.objects.get(objectPath);
        response.statusCode = object === undefined ? 404 : 200;
        response.setHeader('Content-Type', action.contentType);
        if (object !== undefined) {
          response.setHeader('Content-Length', String(object.bytes.length));
          response.end(request.method === 'HEAD' ? undefined : object.bytes);
        } else {
          response.end();
        }
        return;
      }
      case 'normal':
        this.sendStored(response, objectPath, request.method === 'HEAD');
        return;
    }
  }

  private sendStored(response: ServerResponse, objectPath: string, head = false): void {
    const object = this.objects.get(objectPath);
    if (object === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', object.contentType);
    response.setHeader('Cache-Control', object.cacheControl);
    response.setHeader('Content-Length', String(object.bytes.length));
    response.end(head ? undefined : object.bytes);
  }
}

/** Read a request body completely. */
async function readBody(request: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error('the fake received a body over its test bound');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Drain a request body without keeping it. */
async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // Discard: this request is being refused.
  }
}

/** The S3 object path from a bucket-scoped URL path, decoded once. */
function decodePath(pathname: string, bucket: string): string | undefined {
  const prefix = `/${bucket}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  try {
    return `/${decodeURIComponent(pathname.slice(prefix.length))}`;
  } catch {
    return undefined;
  }
}
