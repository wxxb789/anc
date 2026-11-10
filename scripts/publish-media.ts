/**
 * Opt-in publication of already-authorized images to Cloudflare R2.
 *
 * Goal 0013's publisher, and the only module in this repository that may write
 * to a network service. Nothing reaches it unless `anc build --release --media
 * r2` ran: ordinary `build`, `preview`, and `build --release` never import this
 * file, and this file imports `aws4fetch` only inside {@link publishMedia}, so
 * even a caller holding the planning helpers never loads the signer.
 *
 * ## What it is allowed to publish
 *
 * Exactly the artifact's declared `assets` list — the producer's one
 * published representation per referenced image. A draft-only attachment, an
 * excluded file, and a note's source path never reach this module: the artifact
 * does not carry them and the staging directory beside it was already checked
 * by the copy step. The object path is the canonical same-origin asset path
 * (`/_assets/<sha256>-<name>`), so a local file and its remote object are one
 * identity rather than two schemes to keep in step. No note slug, source
 * directory, or private report name is used to form a key.
 *
 * ## Ordering and what "done" means
 *
 * Plan every object from staged bytes and hashes first, then upload/reuse all
 * of them, then read every object back through the public custom domain and
 * hash it. The caller promotes the candidate site only after this returns, so a
 * failed upload, a mismatched existing object, or a CDN that serves the wrong
 * bytes leaves the last good local output in place. A `PUT` that succeeds but
 * whose response was lost is retried *conditionally*; a `404` read is never
 * treated as proof that such a write will not commit.
 *
 * ## Why `HEAD` is not used
 *
 * Size, MIME, and an S3 ETag are not SHA-256 proof, and a `HEAD` before a
 * conditional `PUT` either repeats a check the `412` path already performs or
 * invites treating metadata as evidence. Existing objects are proven by reading
 * and hashing their bytes.
 */

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { formatForExtension, imageMimeType, parseAssetUrl } from '../src/lib/media.ts';
import type { MediaConfig } from './load-config.ts';
import { BuildFailure } from './write-report.ts';

/** Credentials read from the environment, never from YAML and never logged. */
export interface MediaCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The finite bounds this publisher runs under.
 *
 * `maxObjectBytes` matches the image codec's source-byte budget: an emitted
 * asset cannot be larger than the validated source it came from in any way this
 * build produces, so a larger staged or remote object is a defect rather than a
 * bigger picture. The request timeout is generous for a 32 MiB object on a slow
 * link but finite; retries are bounded and only ever re-issue a conditional
 * write.
 */
export interface MediaPublishLimits {
  readonly concurrency: number;
  readonly attempts: number;
  readonly requestTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly maxObjectBytes: number;
}

export const MEDIA_PUBLISH_LIMITS: MediaPublishLimits = Object.freeze({
  concurrency: 4,
  attempts: 3,
  requestTimeoutMs: 30_000,
  retryDelayMs: 250,
  maxObjectBytes: 32 * 1024 * 1024,
});

/** One declared asset, as the artifact names it. */
export interface PublishableAsset {
  readonly url: string;
}

/** Everything the publisher needs, after the CLI has resolved the opt-in. */
export interface MediaPublishInput {
  readonly assets: readonly PublishableAsset[];
  /** The directory `writeArtifact` staged the emitted bytes into. */
  readonly assetDirectory: string;
  readonly config: MediaConfig;
  readonly credentials: MediaCredentials;
}

/** Counts only. No key, source path, or credential appears in this result. */
export interface MediaPublishResult {
  readonly referenced: number;
  readonly uploaded: number;
  readonly reused: number;
  readonly verified: number;
  readonly bytesUploaded: number;
}

/** A signer with the one method this module uses; keeps `aws4fetch`'s type out of the public surface. */
interface Signer {
  sign(input: string, init: RequestInit): Promise<Request>;
}

/** The staged bytes and public identity of one object. */
interface PlannedObject {
  /** Canonical same-origin path; also the object path under the bucket. */
  readonly path: string;
  readonly publicUrl: string;
  readonly digest: string;
  readonly mime: string;
  /**
   * A fresh, non-shared byte view. `readFile` returns an ordinary `Buffer`, and
   * the narrower type is what lets the bytes be passed as a `BodyInit` without
   * a second copy on every retry.
   */
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** A status that may succeed on a later identical attempt. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** The cache metadata for an immutable, content-addressed object. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * Read the two credentials named by the configuration.
 *
 * The names are config values, so the public message is a key location and the
 * report carries the name. Values are never read into a message: the failure is
 * "unset", which is a boolean about the environment rather than the secret.
 */
export function resolveMediaCredentials(
  config: MediaConfig,
  environment: NodeJS.ProcessEnv = process.env,
): MediaCredentials {
  const accessKeyId = environment[config.accessKeyIdEnv];
  const secretAccessKey = environment[config.secretAccessKeyEnv];
  const missing: string[] = [];
  if (typeof accessKeyId !== 'string' || accessKeyId === '') missing.push('media.access_key_id_env');
  if (typeof secretAccessKey !== 'string' || secretAccessKey === '') missing.push('media.secret_access_key_env');
  if (missing.length > 0) {
    throw new BuildFailure(
      'media-credentials-missing',
      `media credentials missing: ${missing.join(' and ')} ${
        missing.length === 1 ? 'names an environment variable that is' : 'name environment variables that are'
      } unset or empty`,
      `unset: ${[config.accessKeyIdEnv, config.secretAccessKeyEnv].filter((name) => !environment[name]).join(', ')}`,
    );
  }
  return { accessKeyId: accessKeyId as string, secretAccessKey: secretAccessKey as string };
}

/**
 * Read, hash, and type every declared asset before touching the network.
 *
 * Failing here is a message about the private candidate, never a partial
 * upload. The staged filename is the decoded `<digest>-<name>`; the public path
 * is the canonical encoded URL from the artifact. They are two spellings of one
 * identity, which is why both are derived from `parseAssetUrl` rather than
 * recomputed from a filename pattern.
 */
async function planObjects(
  input: MediaPublishInput,
  limits: MediaPublishLimits,
): Promise<PlannedObject[]> {
  const planned: PlannedObject[] = [];
  const seen = new Set<string>();
  for (const asset of [...input.assets].sort((left, right) => (left.url < right.url ? -1 : left.url > right.url ? 1 : 0))) {
    // Repeated references are one object. The artifact's schema already
    // requires a unique list, so this is the boundary that keeps a caller
    // holding a repeated list from issuing a second conditional write for a
    // key it has already proved.
    if (seen.has(asset.url)) continue;
    seen.add(asset.url);
    const parsed = parseAssetUrl(asset.url);
    if (parsed === undefined) {
      throw new BuildFailure(
        'media-asset-url',
        'a declared image asset is not a canonical /_assets/<sha256>-<name> path',
        `artifact asset URL was ${JSON.stringify(asset.url)}`,
      );
    }
    const format = formatForExtension(parsed.fileName.slice(parsed.fileName.lastIndexOf('.')));
    if (format === undefined) {
      throw new BuildFailure(
        'media-asset-url',
        'a declared image asset has an extension no published image format names',
        `artifact asset URL was ${JSON.stringify(asset.url)}`,
      );
    }

    const staged = join(input.assetDirectory, `${parsed.digest}-${parsed.fileName}`);
    let info;
    try {
      info = await lstat(staged);
    } catch {
      throw new BuildFailure(
        'media-asset-staged',
        'a declared image asset is missing from the private staging directory',
        `absent staged file for ${asset.url}`,
      );
    }
    if (!info.isFile()) {
      throw new BuildFailure(
        'media-asset-staged',
        'a declared image asset is not a regular file in the private staging directory',
        `not a regular file: staged entry for ${asset.url}`,
      );
    }

    // `readFile` allocates an ordinary, non-shared buffer; the cast records that
    // for `BodyInit` rather than copying the whole asset to satisfy a generic.
    const bytes = (await readFile(staged)) as Buffer<ArrayBuffer>;
    if (bytes.length === 0) {
      throw new BuildFailure(
        'media-asset-staged',
        'a declared image asset is empty in the private staging directory',
        `empty staged file for ${asset.url}`,
      );
    }
    if (bytes.length > limits.maxObjectBytes) {
      throw new BuildFailure(
        'media-asset-too-large',
        'a declared image asset exceeds the validated image size budget',
        `${asset.url}: ${bytes.length} bytes, budget ${limits.maxObjectBytes}`,
      );
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== parsed.digest) {
      throw new BuildFailure(
        'media-asset-staged',
        'a declared image asset does not hash to the digest its content address names',
        `${asset.url}: expected ${parsed.digest}, found ${digest}`,
      );
    }

    planned.push({
      path: asset.url,
      publicUrl: `${input.config.publicBaseUrl}${asset.url}`,
      digest,
      mime: imageMimeType(format),
      bytes,
    });
  }
  return planned;
}

/** Release a response body without reading it. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that is already closed or errored has nothing left to release.
  }
}

/** The media type of a `Content-Type` header, without parameters. */
function mediaType(header: string | null): string | undefined {
  if (header === null) return undefined;
  const type = header.split(';', 1)[0]?.trim().toLowerCase();
  return type === undefined || type === '' ? undefined : type;
}

/** What a bounded body read retained: a digest and a count, never the bytes. */
interface BoundedBody {
  readonly digest: string;
  readonly bytes: number;
}

/**
 * Hash and count a response body without ever holding more than one chunk.
 *
 * A public domain or storage endpoint can answer with a chunked body and no
 * `Content-Length`. Buffering that body and comparing its length afterwards
 * would let a remote response exhaust this host's memory before the intended
 * budget failure could fire. This reads one chunk at a time, hashes it, and
 * cancels the stream the moment the running count passes `limit`, so retained
 * bytes stay bounded by one chunk plus the hash state. The caller checks a
 * declared length first; this is the second, authoritative check.
 *
 * A `null` body has no stream to cancel. The runtime offers no other read, so
 * that case buffers — but only after the caller's declared-length refusal —
 * and still refuses on the measured count.
 */
async function readBoundedBody(
  response: Response,
  limit: number,
  overBudget: (bytes: number) => BuildFailure,
): Promise<BoundedBody> {
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw overBudget(bytes.length);
    return { digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }

  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // The budget failure is the one to report; an already-closed or
        // errored stream has nothing left to cancel.
        await reader.cancel().catch(() => {});
        throw overBudget(total);
      }
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { digest: hash.digest('hex'), bytes: total };
}

/**
 * Send one signed request with `redirect: 'manual'`.
 *
 * Manual redirects are the security property, not a convenience: a `3xx` from
 * the storage endpoint is refused before the runtime can forward an
 * `Authorization` header to a different host. The public URL is fetched the
 * same way for the same class of reason.
 */
async function signedFetch(
  signer: Signer,
  config: MediaConfig,
  path: string,
  init: RequestInit,
  limits: MediaPublishLimits,
): Promise<Response> {
  const signed = await signer.sign(`${config.endpoint}/${config.bucket}${path}`, init);
  return fetch(signed, {
    redirect: 'manual',
    signal: AbortSignal.timeout(limits.requestTimeoutMs),
  });
}

/** Map an upload response status to the failure it represents, or `undefined` to retry. */
function uploadFailure(status: number, path: string): BuildFailure | undefined {
  if (status === 401 || status === 403) {
    return new BuildFailure(
      'media-credentials-rejected',
      'media credentials were rejected by the storage endpoint',
      `${path}: status ${status}`,
    );
  }
  if (status === 404) {
    return new BuildFailure(
      'media-bucket-not-found',
      'the configured media bucket was not found at the storage endpoint',
      `${path}: status ${status}`,
    );
  }
  if (status >= 300 && status < 400) {
    return new BuildFailure(
      'media-endpoint-redirect',
      'the storage endpoint answered with a redirect, which is refused so signed headers cannot be forwarded',
      `${path}: status ${status}`,
    );
  }
  if (RETRYABLE_STATUS.has(status)) return undefined;
  return new BuildFailure(
    'media-object-upload-failed',
    'a media object could not be uploaded',
    `${path}: status ${status}`,
  );
}

/**
 * Read one object from the storage API and prove its bytes against the digest.
 *
 * This is the path a `412` takes and the path a second publication of unchanged
 * content takes. A `404` here is reported rather than interpreted: by the time
 * this runs, a conditional write may have committed even if the client never
 * saw its response, and R2's consistency documentation states that a negative
 * read does not wait for or cancel an in-flight write.
 */
async function verifyStoredObject(
  signer: Signer,
  config: MediaConfig,
  object: PlannedObject,
  limits: MediaPublishLimits,
): Promise<void> {
  for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
    let response: Response;
    try {
      response = await signedFetch(signer, config, object.path, { method: 'GET' }, limits);
    } catch (error) {
      if (attempt === limits.attempts) {
        throw new BuildFailure(
          'media-object-missing',
          'a media object could not be read back from the storage endpoint',
          `${object.path}: ${String((error as Error).message ?? error)}`,
        );
      }
      await delay(limits.retryDelayMs * attempt);
      continue;
    }

    if (response.status === 200) {
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > limits.maxObjectBytes) {
        await discard(response);
        throw new BuildFailure(
          'media-object-mismatch',
          'a media object already present at its content address exceeds the validated image size budget',
          `${object.path}: content-length ${declared}`,
        );
      }
      const body = await readBoundedBody(
        response,
        limits.maxObjectBytes,
        (bytes) =>
          new BuildFailure(
            'media-object-mismatch',
            'a media object already present at its content address exceeds the validated image size budget',
            `${object.path}: read ${bytes} bytes`,
          ),
      );
      if (body.digest !== object.digest || body.bytes !== object.bytes.length) {
        throw new BuildFailure(
          'media-object-mismatch',
          'a media object already present at its content address holds different bytes',
          `${object.path}: expected ${object.digest}/${object.bytes.length} bytes, ` +
            `found ${body.digest}/${body.bytes} bytes`,
        );
      }
      const storedType = mediaType(response.headers.get('content-type'));
      if (storedType !== object.mime) {
        throw new BuildFailure(
          'media-object-mismatch',
          'a media object already present at its content address has the wrong content type',
          `${object.path}: expected ${object.mime}, found ${storedType ?? 'none'}`,
        );
      }
      return;
    }

    if (response.status === 401 || response.status === 403) {
      await discard(response);
      throw new BuildFailure(
        'media-credentials-rejected',
        'media credentials were rejected by the storage endpoint',
        `${object.path}: status ${response.status}`,
      );
    }
    if (response.status === 404) {
      await discard(response);
      throw new BuildFailure(
        'media-object-missing',
        'a media object could not be read back at its content address',
        `${object.path}: status 404 — a negative read is not proof that an ambiguous PUT will not commit`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw new BuildFailure(
        'media-endpoint-redirect',
        'the storage endpoint answered with a redirect, which is refused so signed headers cannot be forwarded',
        `${object.path}: status ${response.status}`,
      );
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt === limits.attempts) {
      await discard(response);
      throw new BuildFailure(
        'media-object-missing',
        'a media object could not be read back from the storage endpoint',
        `${object.path}: status ${response.status}`,
      );
    }
    await discard(response);
    await delay(limits.retryDelayMs * attempt);
  }
}

/**
 * Make one object available with create-once semantics.
 *
 * Every attempt is a conditional `PUT`, including a retry after a timeout or a
 * dropped connection. `412` means another writer — possibly this client's own
 * earlier ambiguous attempt — owns the key; the object is then read and hashed
 * rather than overwritten. Success means the bucket accepted this exact
 * payload; the public read later proves what a reader receives.
 */
async function ensureObject(
  signer: Signer,
  config: MediaConfig,
  object: PlannedObject,
  limits: MediaPublishLimits,
): Promise<'uploaded' | 'reused'> {
  const headers = {
    'If-None-Match': '*',
    'Content-Type': object.mime,
    'Cache-Control': IMMUTABLE_CACHE,
    // Transport integrity, not security: the server can reject truncated or
    // corrupted bytes. `UNSIGNED-PAYLOAD` remains the signature form R2
    // documents for `aws4fetch`, so this is the payload check the API offers.
    'Content-MD5': createHash('md5').update(object.bytes).digest('base64'),
  };

  for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
    let response: Response;
    try {
      response = await signedFetch(
        signer,
        config,
        object.path,
        // `Uint8Array` rather than a stream: the bytes are already in memory and
        // a retry must replay exactly the same payload.
        { method: 'PUT', headers, body: object.bytes },
        limits,
      );
    } catch (error) {
      if (attempt === limits.attempts) {
        throw new BuildFailure(
          'media-object-upload-failed',
          'a media object could not be uploaded after bounded retries',
          `${object.path}: ${String((error as Error).message ?? error)}`,
        );
      }
      await delay(limits.retryDelayMs * attempt);
      continue;
    }

    if (response.status === 200 || response.status === 201 || response.status === 204) {
      await discard(response);
      return 'uploaded';
    }
    if (response.status === 412) {
      await discard(response);
      await verifyStoredObject(signer, config, object, limits);
      return 'reused';
    }

    const known = uploadFailure(response.status, object.path);
    if (known !== undefined) {
      await discard(response);
      throw known;
    }
    await discard(response);
    if (attempt < limits.attempts) await delay(limits.retryDelayMs * attempt);
  }

  throw new BuildFailure(
    'media-object-upload-failed',
    'a media object could not be uploaded after bounded retries',
    `${object.path}: retry budget exhausted`,
  );
}

/**
 * Fetch the public custom-domain URL and prove what a reader actually gets.
 *
 * This runs only after every object is available. A `404` is never retried: the
 * design forbids probing an absent object before upload precisely because
 * Cloudflare caches negative responses, and a cached `404` that survives a
 * successful `PUT` is a real failure the operator must purge or fix rather than
 * something this run should paper over.
 */
async function verifyPublicObject(
  object: PlannedObject,
  limits: MediaPublishLimits,
): Promise<void> {
  for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(object.publicUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(limits.requestTimeoutMs),
      });
    } catch (error) {
      if (attempt === limits.attempts) {
        throw new BuildFailure(
          'media-public-unreachable',
          'a published media URL could not be fetched from the public custom domain',
          `${object.publicUrl}: ${String((error as Error).message ?? error)}`,
        );
      }
      await delay(limits.retryDelayMs * attempt);
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw new BuildFailure(
        'media-public-unreachable',
        'the public media URL answered with a redirect, which is refused',
        `${object.publicUrl}: status ${response.status}`,
      );
    }
    if (response.status === 404) {
      await discard(response);
      throw new BuildFailure(
        'media-public-unreachable',
        'the public media URL returned 404 after the object was uploaded — a cached negative response stays until the cache TTL expires or is purged',
        `${object.publicUrl}: status 404`,
      );
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < limits.attempts) {
      await discard(response);
      await delay(limits.retryDelayMs * attempt);
      continue;
    }
    if (response.status !== 200) {
      await discard(response);
      throw new BuildFailure(
        'media-public-unreachable',
        'the public media URL did not return a successful response',
        `${object.publicUrl}: status ${response.status}`,
      );
    }

    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > limits.maxObjectBytes) {
      await discard(response);
      throw new BuildFailure(
        'media-public-mismatch',
        'the public media URL served a body larger than the validated image size budget',
        `${object.publicUrl}: content-length ${declared}`,
      );
    }
    const body = await readBoundedBody(
      response,
      limits.maxObjectBytes,
      (bytes) =>
        new BuildFailure(
          'media-public-mismatch',
          'the public media URL served a body larger than the validated image size budget',
          `${object.publicUrl}: read ${bytes} bytes`,
        ),
    );
    if (body.digest !== object.digest || body.bytes !== object.bytes.length) {
      throw new BuildFailure(
        'media-public-mismatch',
        'the public media URL served bytes that do not match its content address',
        `${object.publicUrl}: expected ${object.digest}/${object.bytes.length} bytes, ` +
          `found ${body.digest}/${body.bytes} bytes`,
      );
    }
    const servedType = mediaType(response.headers.get('content-type'));
    if (servedType !== object.mime) {
      throw new BuildFailure(
        'media-public-type',
        'the public media URL served an unexpected content type',
        `${object.publicUrl}: expected ${object.mime}, found ${servedType ?? 'none'}`,
      );
    }
    return;
  }
}

/**
 * Run `worker` over `items` with bounded concurrency and stop *scheduling* after
 * the first failure. Started requests are awaited so no promise is left behind;
 * the first failure is the one reported, which is the one a user can act on.
 */
async function forEachLimited<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed: unknown;
  let failureSeen = false;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (!failureSeen && next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await worker(item);
      } catch (error) {
        if (!failureSeen) {
          failed = error;
          failureSeen = true;
        }
      }
    }
  });
  await Promise.all(runners);
  if (failureSeen) throw failed;
}

/**
 * Publish every declared asset and verify what the public domain serves.
 *
 * The signer is imported here, not at module scope: this module's planning
 * helpers are testable without evaluating `aws4fetch`, and a process that never
 * calls this function never loads it at all.
 */
export async function publishMedia(
  input: MediaPublishInput,
  limits: MediaPublishLimits = MEDIA_PUBLISH_LIMITS,
): Promise<MediaPublishResult> {
  const objects = await planObjects(input, limits);
  if (objects.length === 0) {
    return { referenced: 0, uploaded: 0, reused: 0, verified: 0, bytesUploaded: 0 };
  }

  const { AwsClient } = await import('aws4fetch');
  const signer: Signer = new AwsClient({
    accessKeyId: input.credentials.accessKeyId,
    secretAccessKey: input.credentials.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  let uploaded = 0;
  let reused = 0;
  let bytesUploaded = 0;
  await forEachLimited(objects, limits.concurrency, async (object) => {
    const outcome = await ensureObject(signer, input.config, object, limits);
    if (outcome === 'uploaded') {
      uploaded += 1;
      bytesUploaded += object.bytes.length;
    } else {
      reused += 1;
    }
  });

  await forEachLimited(objects, limits.concurrency, (object) =>
    verifyPublicObject(object, limits),
  );

  return {
    referenced: objects.length,
    uploaded,
    reused,
    verified: objects.length,
    bytesUploaded,
  };
}
