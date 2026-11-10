/**
 * Goal 0013: the opt-in R2 publisher and its configuration, over a real socket.
 *
 * The failure directions are the subject. A media publisher's bad outcome is
 * not "an error was thrown"; it is an object overwritten after a concurrent
 * writer won, a claimed digest accepted on the strength of a size or MIME
 * header, a token printed, or a site promoted with links the CDN does not
 * serve. Each case below makes the local protocol fake misbehave in the way the
 * goal names and asserts the publisher's answer.
 *
 * No cloud account is involved: `tests/support/r2-fake.ts` speaks HEAD, PUT and
 * GET over a real `node:http` server. The in-process tests below call the
 * publisher directly, which is why their endpoint is HTTP; production refuses a
 * non-HTTPS endpoint at configuration time, and `tests/media-r2-build.test.ts`
 * exercises the HTTPS-valid CLI path through the same fake.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { parseConfig, type MediaConfig } from '../scripts/load-config.ts';
import {
  MEDIA_PUBLISH_LIMITS,
  publishMedia,
  resolveMediaCredentials,
  type MediaPublishLimits,
  type MediaPublishResult,
} from '../scripts/publish-media.ts';
import { BuildFailure } from '../scripts/write-report.ts';
import { assetFileName, assetUrlFor } from '../src/lib/media.ts';
import { MEDIA_BASE_URL_VARIABLE, mediaDeliveryOrigin } from '../src/lib/media-delivery.ts';
import { renderMarkdown } from '../src/lib/markdown.ts';
import { JPEG, PNG_SCREENSHOT } from './support/media.ts';
import { R2Fake } from './support/r2-fake.ts';

const BUCKET = 'my-images';
const ACCESS_KEY_ID = 'AKIDEXAMPLE';
const SECRET_ACCESS_KEY = 'not-a-real-secret';
const FAKE_CONFIG = (origin: string): MediaConfig => ({
  provider: 'r2',
  bucket: BUCKET,
  endpoint: origin,
  publicBaseUrl: origin,
  accessKeyIdEnv: 'R2_ACCESS_KEY_ID',
  secretAccessKeyEnv: 'R2_SECRET_ACCESS_KEY',
});

/** A publisher budget small enough for fault injection to finish quickly. */
const FAST: MediaPublishLimits = {
  concurrency: 2,
  attempts: 3,
  requestTimeoutMs: 1_000,
  retryDelayMs: 1,
  maxObjectBytes: 4 * 1024 * 1024,
};

/** A root removed however its callback returns. */
async function scratch<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Stage one asset exactly as `writeArtifact` does, and return its public URL. */
function stage(directory: string, bytes: Uint8Array, sourceName: string, format: 'png' | 'jpeg'): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const name = assetFileName(sourceName, format);
  writeFileSync(join(directory, `${digest}-${name}`), bytes);
  return assetUrlFor(digest, name);
}

/** Run the publisher against a fake, closing the fake however it returns. */
async function withFake(
  body: (fake: R2Fake, origin: string) => Promise<void>,
): Promise<void> {
  const fake = new R2Fake({ bucket: BUCKET, accessKeyId: ACCESS_KEY_ID });
  const origin = await fake.start();
  try {
    await body(fake, origin);
  } finally {
    await fake.close();
  }
}

/** Publish one staged set with the test credentials. */
async function publish(
  origin: string,
  assetDirectory: string,
  assets: readonly string[],
  limits: MediaPublishLimits = FAST,
): Promise<MediaPublishResult> {
  return publishMedia(
    {
      assets: assets.map((url) => ({ url })),
      assetDirectory,
      config: FAKE_CONFIG(origin),
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    },
    limits,
  );
}

/** The refusal a promise produced, or a failed assertion. */
async function refusalOf(promise: Promise<unknown>): Promise<BuildFailure> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BuildFailure, `expected a BuildFailure, got ${String(error)}`);
    return error;
  }
  assert.fail('the publisher accepted a case the goal says must fail');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const VALID_MEDIA = `media:
  provider: r2
  bucket: my-images
  endpoint: https://account.r2.cloudflarestorage.com
  public_base_url: https://media.example.org
  access_key_id_env: R2_ACCESS_KEY_ID
  secret_access_key_env: R2_SECRET_ACCESS_KEY
`;

test('the media table is one validated shape and normalizes both origins', () => {
  assert.deepEqual(parseConfig(VALID_MEDIA).media, {
    provider: 'r2',
    bucket: 'my-images',
    endpoint: 'https://account.r2.cloudflarestorage.com',
    publicBaseUrl: 'https://media.example.org',
    accessKeyIdEnv: 'R2_ACCESS_KEY_ID',
    secretAccessKeyEnv: 'R2_SECRET_ACCESS_KEY',
  });
  assert.equal(parseConfig('title: Notes\n').media, undefined, 'an absent media table is not an empty one');
});

test('the loader refuses every malformed media table the goal names', () => {
  const rows: { name: string; text: string; expected: string }[] = [
    {
      name: 'unknown provider',
      text: VALID_MEDIA.replace('provider: r2', 'provider: s3'),
      expected: 'must be "r2"',
    },
    {
      name: 'missing bucket',
      text: VALID_MEDIA.replace('  bucket: my-images\n', ''),
      expected: 'media.bucket: is required',
    },
    {
      name: 'missing endpoint',
      text: VALID_MEDIA.replace('  endpoint: https://account.r2.cloudflarestorage.com\n', ''),
      expected: 'media.endpoint: is required',
    },
    {
      name: 'missing public base',
      text: VALID_MEDIA.replace('  public_base_url: https://media.example.org\n', ''),
      expected: 'media.public_base_url: is required',
    },
    {
      name: 'plain HTTP endpoint',
      text: VALID_MEDIA.replace('https://account.r2.cloudflarestorage.com', 'http://account.example.org'),
      expected: 'must use the https scheme',
    },
    {
      name: 'r2.dev public base',
      text: VALID_MEDIA.replace('https://media.example.org', 'https://bucket.r2.dev'),
      expected: 'must not use r2.dev',
    },
    {
      name: 'credentials in the endpoint',
      text: VALID_MEDIA.replace(
        'https://account.r2.cloudflarestorage.com',
        'https://user:secret@account.r2.cloudflarestorage.com',
      ),
      expected: 'must not carry a username or password',
    },
    {
      name: 'a path on the public base',
      text: VALID_MEDIA.replace('https://media.example.org', 'https://media.example.org/images'),
      expected: 'bare origin with no path',
    },
    {
      name: 'a query on the endpoint',
      text: VALID_MEDIA.replace(
        'https://account.r2.cloudflarestorage.com',
        'https://account.r2.cloudflarestorage.com/?x=1',
      ),
      expected: 'bare origin with no path',
    },
    {
      name: 'uppercase bucket',
      text: VALID_MEDIA.replace('bucket: my-images', 'bucket: My-Images'),
      expected: 'lowercase letters',
    },
    {
      name: 'bucket too short',
      text: VALID_MEDIA.replace('bucket: my-images', 'bucket: ab'),
      expected: '3–63',
    },
    {
      name: 'unknown nested key',
      text: `${VALID_MEDIA}  region: auto\n`,
      expected: 'media.region',
    },
    {
      name: 'wrong value type',
      text: VALID_MEDIA.replace('bucket: my-images', 'bucket: 12'),
      expected: 'must be a string',
    },
    {
      name: 'bad environment name',
      text: VALID_MEDIA.replace('R2_ACCESS_KEY_ID', 'R2-KEY'),
      expected: 'environment variable name',
    },
    {
      name: 'the same environment variable twice',
      text: VALID_MEDIA.replace('R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID'),
      expected: 'must name a different environment variable',
    },
    {
      name: 'an eaten YAML tag',
      text: VALID_MEDIA.replace('bucket: my-images', 'bucket: ! my-images'),
      expected: 'carries a "!" tag',
    },
  ];

  for (const row of rows) {
    assert.throws(
      () => parseConfig(row.text),
      (error: unknown) => {
        assert.ok(error instanceof BuildFailure, `${row.name}: not a BuildFailure`);
        assert.ok(
          error.message.includes(row.expected),
          `${row.name}: refusal did not say ${JSON.stringify(row.expected)}:\n${error.message}`,
        );
        return true;
      },
      row.name,
    );
  }
});

test('a missing credential variable is named by key, and no value is printed', () => {
  const config = FAKE_CONFIG('https://account.r2.cloudflarestorage.com');
  assert.throws(
    () => resolveMediaCredentials(config, {}),
    (error: unknown) => {
      assert.ok(error instanceof BuildFailure);
      assert.equal(error.code, 'media-credentials-missing');
      assert.ok(error.message.includes('media.access_key_id_env'));
      assert.ok(!error.message.includes(SECRET_ACCESS_KEY));
      assert.ok(!error.detail.includes(SECRET_ACCESS_KEY));
      return true;
    },
  );

  assert.deepEqual(
    resolveMediaCredentials(config, {
      R2_ACCESS_KEY_ID: ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
    }),
    { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  );
});

// ---------------------------------------------------------------------------
// The ordinary upload path
// ---------------------------------------------------------------------------

test('publishes declared assets conditionally with immutable metadata and verifies them publicly', async () => {
  await scratch('r2-upload-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      const jpeg = stage(directory, JPEG, 'photo.jpg', 'jpeg');
      const result = await publish(origin, directory, [png, jpeg]);

      assert.deepEqual(
        { referenced: result.referenced, uploaded: result.uploaded, reused: result.reused, verified: result.verified },
        { referenced: 2, uploaded: 2, reused: 0, verified: 2 },
      );
      assert.equal(result.bytesUploaded, PNG_SCREENSHOT.length + JPEG.length);

      const puts = fake.requests.filter((request) => request.method === 'PUT');
      assert.equal(puts.length, 2);
      for (const put of puts) {
        assert.equal(put.ifNoneMatch, '*');
        assert.equal(put.cacheControl, 'public, max-age=31536000, immutable');
        assert.ok(['image/png', 'image/jpeg'].includes(put.contentType ?? ''));
        // The payload-integrity header the fake itself validates. A request
        // that omitted or miscomputed it would have been refused with 400, but
        // asserting the value proves it covers exactly the stored bytes.
        const objectPath = decodeURIComponent(new URL(put.path, origin).pathname).slice(`/${BUCKET}`.length);
        const stored = fake.objects.get(objectPath);
        assert.ok(stored !== undefined);
        assert.equal(put.contentMd5, createHash('md5').update(stored.bytes).digest('base64'));
      }
      assert.deepEqual(
        [...fake.objects.keys()].sort(),
        [png, jpeg].sort(),
        'the objects were not stored under the canonical asset paths',
      );
      assert.deepEqual(Buffer.from(fake.objects.get(png)!.bytes), Buffer.from(PNG_SCREENSHOT));
      assert.deepEqual(Buffer.from(fake.objects.get(jpeg)!.bytes), Buffer.from(JPEG));

      // Every object is read back through the public route after all uploads.
      const publicGets = fake.requests.filter(
        (request) => request.method === 'GET' && !request.path.startsWith(`/${BUCKET}/`),
      );
      assert.equal(publicGets.length, 2);
    });
  });
});

test('a second publication reuses every existing object without uploading bytes', async () => {
  await scratch('r2-repeat-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      const first = await publish(origin, directory, [png]);
      assert.equal(first.uploaded, 1);

      const second = await publish(origin, directory, [png]);
      assert.deepEqual(
        { uploaded: second.uploaded, reused: second.reused, verified: second.verified, bytes: second.bytesUploaded },
        { uploaded: 0, reused: 1, verified: 1, bytes: 0 },
      );
      assert.equal(fake.putsFor(png), 2, 'the second run did not issue a conditional PUT');
      assert.equal(fake.objects.size, 1);
    });
  });
});

test('a 412 from a concurrent writer verifies the winner and never overwrites it', async () => {
  await scratch('r2-412-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      // Another writer committed the same content-addressed object first.
      fake.objects.set(png, {
        bytes: Buffer.from(PNG_SCREENSHOT),
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      const result = await publish(origin, directory, [png]);
      assert.equal(result.reused, 1);
      assert.equal(result.uploaded, 0);
      assert.equal(fake.putsFor(png), 1);
      assert.deepEqual(Buffer.from(fake.objects.get(png)!.bytes), Buffer.from(PNG_SCREENSHOT));
    });
  });
});

test('a 412 whose object holds different bytes fails instead of replacing it', async () => {
  await scratch('r2-412-mismatch-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.objects.set(png, {
        bytes: Buffer.from(JPEG),
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-object-mismatch');
      assert.deepEqual(Buffer.from(fake.objects.get(png)!.bytes), Buffer.from(JPEG), 'the object was overwritten');
    });
  });
});

test('an existing object with the wrong MIME, size or bytes behind the claimed digest is refused', async () => {
  await scratch('r2-existing-mismatch-', async (directory) => {
    const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');

    await withFake(async (fake, origin) => {
      fake.objects.set(png, {
        bytes: Buffer.from(PNG_SCREENSHOT),
        contentType: 'text/html',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-object-mismatch');
      assert.match(failure.detail, /image\/png/);
    });

    await withFake(async (fake, origin) => {
      fake.objects.set(png, {
        bytes: Buffer.from(PNG_SCREENSHOT.subarray(0, 32)),
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-object-mismatch');
    });

    await withFake(async (fake, origin) => {
      const substituted = Buffer.from(PNG_SCREENSHOT);
      substituted[substituted.length - 1] = (substituted[substituted.length - 1]! + 1) % 256;
      fake.objects.set(png, {
        bytes: substituted,
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-object-mismatch');
    });
  });
});

// ---------------------------------------------------------------------------
// Ambiguous completion, partial uploads, timeouts and status codes
// ---------------------------------------------------------------------------

test('a dropped response after the server committed is retried conditionally and verified', async () => {
  await scratch('r2-drop-commit-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.putAction = (_path, attempt) => (attempt === 1 ? { kind: 'store-then-drop' } : { kind: 'store' });
      const result = await publish(origin, directory, [png]);
      assert.equal(result.reused, 1, 'the retry did not take the 412 verification path');
      assert.equal(result.uploaded, 0);
      assert.equal(fake.putsFor(png), 2);
      assert.deepEqual(Buffer.from(fake.objects.get(png)!.bytes), Buffer.from(PNG_SCREENSHOT));
    });
  });
});

test('a dropped response before the server committed is retried and uploaded', async () => {
  await scratch('r2-drop-no-commit-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.putAction = (_path, attempt) => (attempt === 1 ? { kind: 'drop' } : { kind: 'store' });
      const result = await publish(origin, directory, [png]);
      assert.equal(result.uploaded, 1);
      assert.equal(fake.putsFor(png), 2);
      assert.deepEqual(Buffer.from(fake.objects.get(png)!.bytes), Buffer.from(PNG_SCREENSHOT));
    });
  });
});

test('a withheld response after the commit times out, retries conditionally and verifies', async () => {
  await scratch('r2-hang-commit-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.putAction = (_path, attempt) => (attempt === 1 ? { kind: 'store-then-hang' } : { kind: 'store' });
      const result = await publish(origin, directory, [png], { ...FAST, requestTimeoutMs: 80 });
      assert.equal(result.reused, 1);
      assert.equal(fake.putsFor(png), 2);
    });
  });
});

test('a withheld response before the commit times out and the retry uploads', async () => {
  await scratch('r2-hang-no-commit-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.putAction = (_path, attempt) => (attempt === 1 ? { kind: 'hang' } : { kind: 'store' });
      const result = await publish(origin, directory, [png], { ...FAST, requestTimeoutMs: 80 });
      assert.equal(result.uploaded, 1);
      assert.equal(fake.putsFor(png), 2);
    });
  });
});

test('a partial upload is retried, and a persistently partial upload fails with no object', async () => {
  await scratch('r2-partial-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.putAction = (_path, attempt) => (attempt === 1 ? { kind: 'partial' } : { kind: 'store' });
      const result = await publish(origin, directory, [png]);
      assert.equal(result.uploaded, 1);
      assert.equal(fake.putsFor(png), 2);
    });

    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.putAction = () => ({ kind: 'partial' });
      const failure = await refusalOf(publish(origin, directory, [png], { ...FAST, attempts: 2 }));
      assert.equal(failure.code, 'media-object-upload-failed');
      assert.equal(fake.objects.size, 0);
    });
  });
});

test('a persistently withheld upload fails after the bounded retry budget', async () => {
  await scratch('r2-timeout-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.putAction = () => ({ kind: 'hang' });
      const failure = await refusalOf(
        publish(origin, directory, [png], { ...FAST, attempts: 2, requestTimeoutMs: 60 }),
      );
      assert.equal(failure.code, 'media-object-upload-failed');
      assert.equal(fake.objects.size, 0);
    });
  });
});

test('missing, rejected and under-privileged credentials fail without an upload', async () => {
  await scratch('r2-credentials-', async (directory) => {
    const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');

    // No credentials reach the publisher: the CLI resolves them first.
    assert.throws(() => resolveMediaCredentials(FAKE_CONFIG('https://r2.invalid'), {}));

    await withFake(async (fake, origin) => {
      fake.rejectStatus = 401;
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-credentials-rejected');
      assert.ok(!failure.message.includes(SECRET_ACCESS_KEY));
      assert.ok(!failure.detail.includes(SECRET_ACCESS_KEY));
      assert.equal(fake.objects.size, 0);
    });

    await withFake(async (fake, origin) => {
      fake.rejectStatus = 403;
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-credentials-rejected');
      assert.equal(fake.objects.size, 0);
    });
  });
});

test('a wrong bucket, an unreachable endpoint and a redirect to another host fail closed', async () => {
  await scratch('r2-endpoint-', async (directory) => {
    const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');

    await withFake(async (fake, origin) => {
      fake.rejectStatus = 404;
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-bucket-not-found');
    });

    // Nothing listens on this port; the failure is bounded and touches no other
    // origin. Port 1 is never a test server.
    const unreachable = await refusalOf(
      publish('http://127.0.0.1:1', directory, [png], {
        ...FAST,
        attempts: 2,
        requestTimeoutMs: 200,
      }),
    );
    assert.equal(unreachable.code, 'media-object-upload-failed');

    await withFake(async (fake, origin) => {
      const stolen: string[] = [];
      const evil = createServer((_request, response) => {
        stolen.push('request');
        response.statusCode = 200;
        response.end();
      });
      await new Promise<void>((resolve) => evil.listen(0, '127.0.0.1', () => resolve()));
      const address = evil.address();
      assert.ok(address !== null && typeof address !== 'string');
      try {
        fake.putAction = () => ({
          kind: 'redirect',
          location: `http://127.0.0.1:${address.port}/steal`,
        });
        const failure = await refusalOf(publish(origin, directory, [png]));
        assert.equal(failure.code, 'media-endpoint-redirect');
        assert.deepEqual(stolen, [], 'a signed request reached the redirect target');
      } finally {
        await new Promise<void>((resolve) => evil.close(() => resolve()));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Public custom-domain verification
// ---------------------------------------------------------------------------

test('a public 404 after a successful upload fails the run', async () => {
  await scratch('r2-public-404-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.publicAction = () => ({ kind: 'not-found' });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-public-unreachable');
      assert.ok(fake.objects.has(png), 'the upload did not succeed before the public check');
    });
  });
});

test('a cached 404 that persists after a later successful PUT fails the run', async () => {
  await scratch('r2-public-cached-404-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      // The object is committed on the first PUT; the public route keeps serving
      // the negative response a cache would have pinned.
      fake.publicAction = () => ({ kind: 'not-found' });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-public-unreachable');
      assert.match(failure.message, /cached negative/);
      assert.deepEqual(Buffer.from(fake.objects.get(png)!.bytes), Buffer.from(PNG_SCREENSHOT));
    });
  });
});

test('public bytes, size or MIME that disagree with the content address fail the run', async () => {
  await scratch('r2-public-mismatch-', async (directory) => {
    const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');

    await withFake(async (fake, origin) => {
      fake.publicAction = () => ({ kind: 'wrong-bytes', bytes: Buffer.from(JPEG) });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-public-mismatch');
    });

    await withFake(async (fake, origin) => {
      const shorter = Buffer.from(PNG_SCREENSHOT.subarray(0, 40));
      fake.publicAction = () => ({ kind: 'wrong-bytes', bytes: shorter });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-public-mismatch');
    });

    await withFake(async (fake, origin) => {
      fake.publicAction = () => ({ kind: 'wrong-type', contentType: 'text/html' });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-public-type');
    });
  });
});

test('a public redirect is refused rather than followed', async () => {
  await scratch('r2-public-redirect-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      fake.publicAction = () => ({ kind: 'redirect', location: 'https://elsewhere.invalid/image.png' });
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-public-unreachable');
    });
  });
});

// ---------------------------------------------------------------------------
// The private candidate is validated before the network
// ---------------------------------------------------------------------------

test('a staged digest mismatch, a missing file and an oversized object never reach the network', async () => {
  await scratch('r2-staged-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      const stagedName = `${createHash('sha256').update(PNG_SCREENSHOT).digest('hex')}-screenshot.png`;
      writeFileSync(join(directory, stagedName), Buffer.from(PNG_SCREENSHOT.subarray(1)));

      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-asset-staged');
      assert.equal(fake.requests.length, 0, 'a defective staged asset reached the network');
    });

    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      rmSync(join(directory, `${createHash('sha256').update(PNG_SCREENSHOT).digest('hex')}-screenshot.png`));
      const failure = await refusalOf(publish(origin, directory, [png]));
      assert.equal(failure.code, 'media-asset-staged');
      assert.equal(fake.requests.length, 0);
    });

    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      const failure = await refusalOf(
        publish(origin, directory, [png], { ...FAST, maxObjectBytes: 16 }),
      );
      assert.equal(failure.code, 'media-asset-too-large');
      assert.equal(fake.requests.length, 0);
    });
  });
});

test('a repeated asset URL is deduplicated to one conditional write', async () => {
  await scratch('r2-dedupe-', async (directory) => {
    await withFake(async (fake, origin) => {
      const png = stage(directory, PNG_SCREENSHOT, 'screenshot.png', 'png');
      const result = await publish(origin, directory, [png, png, png]);
      assert.equal(result.referenced, 1);
      assert.equal(result.uploaded, 1);
      assert.equal(fake.putsFor(png), 1);
      assert.equal(fake.requests.filter((request) => request.method === 'PUT').length, 1);
    });
  });
});

test('an empty declared set makes no request and returns zero counts', async () => {
  await scratch('r2-empty-', async (directory) => {
    await withFake(async (fake, origin) => {
      const result = await publish(origin, directory, []);
      assert.deepEqual(result, {
        referenced: 0,
        uploaded: 0,
        reused: 0,
        verified: 0,
        bytesUploaded: 0,
      });
      assert.equal(fake.requests.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('an opted-in render emits absolute HTTPS asset URLs and keeps layout facts', async () => {
  const previous = process.env[MEDIA_BASE_URL_VARIABLE];
  try {
    process.env[MEDIA_BASE_URL_VARIABLE] = 'https://media.example.org';
    assert.equal(mediaDeliveryOrigin(), 'https://media.example.org');

    const asset = assetUrlFor('a'.repeat(64), 'screenshot.png');
    const rendered = await renderMarkdown(`![A picture](/assets-placeholder)\n`.replace('/assets-placeholder', asset), {
      publishedAssets: new Set([asset]),
      assetDimensions: new Map([[asset, { width: 480, height: 120 }]]),
    });
    assert.ok(
      rendered.html.includes(`src="https://media.example.org${asset}"`),
      `the renderer did not deliver the published asset from the custom domain:\n${rendered.html}`,
    );
    assert.ok(rendered.html.includes('width="480" height="120"'), 'layout facts were lost in the rewrite');
    assert.ok(rendered.html.includes('loading="eager"'));
  } finally {
    if (previous === undefined) delete process.env[MEDIA_BASE_URL_VARIABLE];
    else process.env[MEDIA_BASE_URL_VARIABLE] = previous;
  }
});

test('without the opt-in the same render keeps the same-origin path', async () => {
  const previous = process.env[MEDIA_BASE_URL_VARIABLE];
  try {
    delete process.env[MEDIA_BASE_URL_VARIABLE];
    assert.equal(mediaDeliveryOrigin(), undefined);
    const asset = assetUrlFor('b'.repeat(64), 'screenshot.png');
    const rendered = await renderMarkdown(`![A picture](${asset})\n`, {
      publishedAssets: new Set([asset]),
    });
    assert.ok(rendered.html.includes(`src="${asset}"`), rendered.html);
    assert.ok(!rendered.html.includes('https://media.example.org'));
  } finally {
    if (previous !== undefined) process.env[MEDIA_BASE_URL_VARIABLE] = previous;
  }
});

test('a malformed delivery origin fails closed, and remote images are never rewritten', async () => {
  const previous = process.env[MEDIA_BASE_URL_VARIABLE];
  try {
    for (const value of [
      'http://media.example.org',
      'https://user:pass@media.example.org',
      'https://media.example.org/prefix',
      'not a url',
    ]) {
      process.env[MEDIA_BASE_URL_VARIABLE] = value;
      assert.throws(() => mediaDeliveryOrigin(), Error, value);
    }

    process.env[MEDIA_BASE_URL_VARIABLE] = 'https://media.example.org';
    const rendered = await renderMarkdown('![Remote](https://elsewhere.invalid/a.png)\n', {
      publishedAssets: new Set(),
    });
    assert.ok(rendered.html.includes('src="https://elsewhere.invalid/a.png"'), rendered.html);
  } finally {
    if (previous === undefined) delete process.env[MEDIA_BASE_URL_VARIABLE];
    else process.env[MEDIA_BASE_URL_VARIABLE] = previous;
  }
});

// Keep the default limits visible in this file: a test that silently inherited a
// different budget would not be testing the shipped one.
test('the shipped publisher budget is finite and bounded', () => {
  assert.equal(MEDIA_PUBLISH_LIMITS.maxObjectBytes, 32 * 1024 * 1024);
  assert.ok(MEDIA_PUBLISH_LIMITS.concurrency > 0 && MEDIA_PUBLISH_LIMITS.concurrency <= 8);
  assert.ok(MEDIA_PUBLISH_LIMITS.attempts > 0 && MEDIA_PUBLISH_LIMITS.attempts <= 5);
  assert.ok(MEDIA_PUBLISH_LIMITS.requestTimeoutMs > 0);
});
