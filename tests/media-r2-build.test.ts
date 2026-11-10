/**
 * Goal 0013 through the shipped binary: opt-in only, ordered, and reversible.
 *
 * These gates spawn `bin/anc.mjs` because the properties are about the command
 * a stranger runs — that `--media r2` is refused without `--release`, that an
 * ordinary build with credentials exported and a `media:` table present still
 * makes no request and loads no signer, and that a failed upload leaves the
 * previous good `dist/` in place.
 *
 * The child is instrumented by `tests/support/network-trace.mjs`: it records
 * every `fetch` and every `aws4fetch` resolution, and maps the two documentation
 * hostnames to the local protocol fake. The configuration therefore stays
 * HTTPS-valid while the bytes cross a real socket. `tests/media-r2.test.ts`
 * covers the same publisher directly, including the HTTPS rejection that this
 * seam avoids.
 */

import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { R2Fake } from './support/r2-fake.ts';
import { PNG_SCREENSHOT, PNG_SECOND } from './support/media.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'anc.mjs');
const PRELOAD = join(ROOT, 'tests', 'support', 'network-trace.mjs');
const BUCKET = 'my-images';
const ACCESS_KEY_ID = 'AKIDEXAMPLE';
const SECRET_ACCESS_KEY = 'not-a-real-secret';

/** The site and media configuration every fixture below starts from. */
const CONFIG = `title: Notes
origin: https://notes.example.org/
media:
  provider: r2
  bucket: ${BUCKET}
  endpoint: https://r2.invalid
  public_base_url: https://media.invalid
  access_key_id_env: R2_ACCESS_KEY_ID
  secret_access_key_env: R2_SECRET_ACCESS_KEY
`;

/** A scratch repository removed however its callback returns. */
async function scratch<T>(prefix: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** `git` with the ambient configuration neutralized. */
function git(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', ['-c', 'core.excludesFile=', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function mustGit(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );
  return result.stdout ?? '';
}

/** Write a file, creating its directories. */
function put(root: string, relativePath: string, body: string | Uint8Array): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** A committed notes repository whose publish-set review is current. */
function repository(root: string, files: Record<string, string | Uint8Array>, config = CONFIG): void {
  for (const [relativePath, body] of Object.entries(files)) put(root, relativePath, body);
  put(root, 'publish.config.yaml', config);

  mustGit(root, ['init', '--quiet']);
  mustGit(root, ['config', 'user.email', 'test@example.invalid']);
  mustGit(root, ['config', 'user.name', 'Test']);
  mustGit(root, ['add', '-A']);
  mustGit(root, ['commit', '--quiet', '-m', 'notes']);

  const review = spawnSync(process.execPath, [BINARY, 'review'], { cwd: root, encoding: 'utf8' });
  assert.equal(review.status, 0, `review failed:\n${review.stdout}\n${review.stderr}`);
  mustGit(root, ['add', '.publish-set.json']);
  mustGit(root, ['commit', '--quiet', '-m', 'publish set']);
}

/** Run the binary, allowing the fake server's event loop to keep serving. */
async function cli(
  cwd: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<{ status: number | null; output: string }> {
  const child = spawn(process.execPath, ['--import', PRELOAD, BINARY, ...args], {
    cwd,
    // Deliberately no ASTRO_TELEMETRY_DISABLED here: the binary itself must
    // disable Astro's telemetry, and this trace is the evidence.
    env: { ...process.env, ...environment },
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
  const [status] = (await once(child, 'exit')) as [number | null];
  return { status, output: Buffer.concat(chunks).toString('utf8') };
}

/** The media environment for a fake origin, with a trace path. */
function mediaEnvironment(origin: string, trace: string): Record<string, string> {
  return {
    R2_ACCESS_KEY_ID: ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
    ANC_FAKE_ORIGIN: origin,
    ANC_NETWORK_TRACE: trace,
  };
}

/** Every line the preload recorded, or none. */
function traceLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

/** The single `media:` count line a media build prints. */
function mediaLine(output: string): string {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith('media:'));
  assert.ok(line !== undefined, `the build printed no media line:\n${output}`);
  return line;
}

/** The published note's HTML. */
function noteHtml(root: string): string {
  return readFileSync(join(root, 'dist', 'notes', 'alpha', 'index.html'), 'utf8');
}

/** The absolute media path a note's HTML references, decoded for the fake's keys. */
function noteAssetPath(root: string, slug: string): string {
  const html = readFileSync(join(root, 'dist', 'notes', slug, 'index.html'), 'utf8');
  const url = /src="(https:\/\/media\.invalid\/_assets\/[^"]+)"/.exec(html)?.[1];
  assert.ok(url !== undefined, `the ${slug} note carried no absolute media URL:
${html}`);
  return decodeURIComponent(new URL(url).pathname);
}

/** SHA-256 of bytes, for matching recorded upload bodies without printing them. */
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Start a fake and close it however the callback returns. */
async function withFake(body: (fake: R2Fake) => Promise<void>): Promise<void> {
  const fake = new R2Fake({ bucket: BUCKET, accessKeyId: ACCESS_KEY_ID });
  await fake.start();
  try {
    await body(fake);
  } finally {
    await fake.close();
  }
}

test('ordinary build, preview and release stay offline with the media table and credentials present', async () => {
  await scratch('r2-offline-', async (root) => {
    repository(root, {
      'alpha.md': '# Alpha\n\nThis is a published note about the first subject, with enough prose for the search index.\n\n![Screenshot](photo.png)\n',
      'photo.png': PNG_SCREENSHOT,
    });
    const trace = join(root, 'network.trace');

    const build = await cli(root, ['build'], {
      R2_ACCESS_KEY_ID: ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
      ANC_NETWORK_TRACE: trace,
    });
    assert.equal(build.status, 0, build.output);
    assert.ok(noteHtml(root).includes('src="/_assets/'), 'the ordinary build did not stay same-origin');
    assert.deepEqual(traceLines(trace), [], 'an ordinary build reached the network or loaded the signer');

    const release = await cli(root, ['build', '--release'], {
      R2_ACCESS_KEY_ID: ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
      ANC_NETWORK_TRACE: trace,
    });
    assert.equal(release.status, 0, release.output);
    assert.ok(noteHtml(root).includes('src="/_assets/'), 'a release build without --media changed delivery');
    assert.deepEqual(traceLines(trace), [], 'a release build without --media reached the network');

    // Preview is a local server; it must neither load the signer nor fetch.
    const preview = spawn(
      process.execPath,
      ['--import', PRELOAD, BINARY, 'preview', '--dist', 'dist', '--port', '0'],
      {
        cwd: root,
        env: {
          ...process.env,
          R2_ACCESS_KEY_ID: ACCESS_KEY_ID,
          R2_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
          ANC_NETWORK_TRACE: trace,
        },
      },
    );
    let announced = '';
    preview.stdout.setEncoding('utf8');
    preview.stdout.on('data', (chunk: string) => {
      announced += chunk;
    });
    // A real child process announces its port asynchronously; fake timers
    // cannot advance another process's clock, so the bound is a genuine wait.
    // The event that ends it is the child's own line, not the elapsed time.
    const announcement = Promise.withResolvers<string>();
    let settled = false;
    const timer = setTimeout(
      () => announcement.reject(new Error(`preview announced nothing: ${announced}`)),
      30_000,
    );
    preview.stdout.on('data', () => {
      const match = /^preview: http:\/\/localhost:(\d+)\/$/m.exec(announced);
      if (match !== null && !settled) {
        settled = true;
        clearTimeout(timer);
        announcement.resolve(match[1]!);
      }
    });
    preview.once('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      announcement.reject(new Error(`preview exited before announcing: ${announced}`));
    });
    const port = await announcement.promise;
    const served = await fetch(`http://127.0.0.1:${port}/notes/alpha/`);
    assert.equal(served.status, 200);
    if (preview.exitCode === null && preview.signalCode === null) {
      preview.kill('SIGINT');
      await once(preview, 'exit');
    }
    assert.deepEqual(traceLines(trace), [], 'preview reached the network or loaded the signer');
  });
});

test('--media r2 without --release is refused before any content is read', async () => {
  await scratch('r2-no-release-', async (root) => {
    const run = await cli(root, ['build', '--media', 'r2']);
    assert.equal(run.status, 1);
    assert.ok(run.output.includes('only available with --release'), run.output);
    assert.ok(!run.output.includes('report:'), 'an argument refusal pointed at a report it never opened');
  });
});

test('an opted-in release uploads only referenced images and emits absolute HTTPS URLs', async () => {
  await scratch('r2-publish-', async (root) => {
    repository(root, {
      'alpha.md': '# Alpha\n\nThis is a published note about the first subject, with enough prose for the search index.\n\n![Screenshot](public.png "A screenshot")\n',
      'public.png': PNG_SCREENSHOT,
      'drafts/hidden.md': '---\npublish: false\n---\n\n# Hidden\n\n![Secret](secret.png)\n',
      'secret.png': PNG_SECOND,
    });
    const trace = join(root, 'network.trace');

    await withFake(async (fake) => {
      const first = await cli(root, ['build', '--release', '--media', 'r2'], {
        ...mediaEnvironment(fake.base, trace),
      });
      assert.equal(first.status, 0, first.output);
      assert.equal(mediaLine(first.output), 'media: 1 referenced, 1 uploaded, 0 already present, 1 verified');

      const html = noteHtml(root);
      const assetUrl = /src="(https:\/\/media\.invalid\/_assets\/[^"]+)"/.exec(html)?.[1];
      assert.ok(assetUrl !== undefined, `the HTML carried no absolute media URL:\n${html}`);
      assert.ok(!html.includes('src="/_assets/'), 'the opted-in HTML kept a same-origin image path');

      // The local content-addressed copy still exists and is the same identity:
      // 0011 may have emitted WebP, so the emitted bytes — not the PNG fixture —
      // are what the URL, the staged file, and the object share.
      const firstPath = decodeURIComponent(new URL(assetUrl).pathname);
      const localName = firstPath.slice('/_assets/'.length);
      const localBytes = readFileSync(join(root, 'dist', '_assets', localName));
      assert.equal(`/_assets/${localName}`, firstPath);
      assert.match(readFileSync(join(root, 'dist', '_headers'), 'utf8'), /img-src 'self' data: https:/);

      // Only the published note's image crossed the network: one object, one
      // upload body. A withheld note's image would make either count larger.
      assert.deepEqual([...fake.objects.keys()], [firstPath]);
      assert.deepEqual(fake.putBodies, [digest(localBytes)]);

      const lines = traceLines(trace);
      assert.ok(lines.includes('module:aws4fetch'), 'the opted-in build did not load the signer');
      assert.ok(
        lines.some((line) => line.startsWith('fetch:PUT:https://r2.invalid/')),
        `no signed upload was recorded: ${lines.join(', ')}`,
      );
      assert.ok(
        lines.some((line) => line.startsWith('fetch:GET:https://media.invalid/_assets/')),
        `the public URL was not verified through the custom domain: ${lines.join(', ')}`,
      );

      // A second publication reuses every object.
      const second = await cli(root, ['build', '--release', '--media', 'r2'], {
        ...mediaEnvironment(fake.base, trace),
      });
      assert.equal(second.status, 0, second.output);
      assert.equal(mediaLine(second.output), 'media: 1 referenced, 0 uploaded, 1 already present, 1 verified');
      assert.equal(fake.putsFor(firstPath), 2);
      assert.equal(fake.objects.size, 1);
      assert.deepEqual(Buffer.from(fake.objects.get(firstPath)!.bytes), localBytes);

      // Changed bytes are a new content address, not an overwrite.
      put(root, 'public.png', PNG_SECOND);
      const third = await cli(root, ['build', '--release', '--media', 'r2'], {
        ...mediaEnvironment(fake.base, trace),
      });
      assert.equal(third.status, 0, third.output);
      assert.equal(mediaLine(third.output), 'media: 1 referenced, 1 uploaded, 0 already present, 1 verified');
      assert.equal(fake.objects.size, 2, 'the old content-addressed object was deleted or overwritten');
      assert.ok(fake.objects.has(firstPath), 'the previous object vanished');

      const changedUrl = /src="(https:\/\/media\.invalid\/_assets\/[^"]+)"/.exec(noteHtml(root))?.[1];
      assert.ok(changedUrl !== undefined);
      const changedPath = decodeURIComponent(new URL(changedUrl).pathname);
      assert.notEqual(changedPath, firstPath, 'changed image bytes kept the old URL');
      assert.ok(fake.objects.has(changedPath), 'the changed image did not publish under its new digest');
      assert.deepEqual(
        Buffer.from(fake.objects.get(changedPath)!.bytes),
        readFileSync(join(root, 'dist', '_assets', changedPath.slice('/_assets/'.length))),
      );
    });
  });
});

test('a failing upload in the middle of a set fails the run and leaves the previous output', async () => {
  await scratch('r2-mid-fail-', async (root) => {
    repository(root, {
      'alpha.md': '# Alpha\n\nThis is the first published note, with enough prose for the search index.\n\n![One](one.png)\n',
      'beta.md': '# Beta\n\nThis is the second published note, with enough prose for the search index.\n\n![Two](two.png)\n',
      'one.png': PNG_SCREENSHOT,
      'two.png': PNG_SECOND,
    });

    // First build succeeds against an empty bucket, and becomes the output a
    // later failure must not replace.
    const firstTrace = join(root, 'first.trace');
    await withFake(async (fake) => {
      const first = await cli(root, ['build', '--release', '--media', 'r2'], {
        ...mediaEnvironment(fake.base, firstTrace),
      });
      assert.equal(first.status, 0, first.output);
      assert.equal(fake.objects.size, 2);
    });
    const goodHtml = noteHtml(root);
    const onePath = noteAssetPath(root, 'alpha');
    const twoPath = noteAssetPath(root, 'beta');

    // A fresh bucket: one object uploads, the other cannot, and the run stops.
    const secondTrace = join(root, 'second.trace');
    await withFake(async (fake) => {
      fake.putAction = (path) => (path === twoPath ? { kind: 'status', status: 500 } : { kind: 'store' });

      const failed = await cli(root, ['build', '--release', '--media', 'r2'], {
        ...mediaEnvironment(fake.base, secondTrace),
      });
      assert.equal(failed.status, 1, failed.output);
      assert.ok(!failed.output.includes('site written'), 'a failed run reported a written site');

      assert.equal(noteHtml(root), goodHtml, 'the failed run replaced the previous good output');
      assert.ok(
        fake.objects.has(onePath),
        'the in-flight good upload did not remain as a harmless orphan',
      );
      assert.ok(!fake.objects.has(twoPath), 'the failing object was stored after all');
    });
  });
});

test('assets referenced only by withheld or pattern-excluded notes are never uploaded', async () => {
  await scratch('r2-withheld-', async (root) => {
    repository(
      root,
      {
        'alpha.md': '# Alpha\n\nThis published note has enough prose for the search index and no images.\n',
        'drafts/hidden.md': '---\npublish: false\n---\n\n# Hidden\n\n![Secret](secret.png)\n',
        'drafts/roadmap.md': '# Roadmap\n\nA draft excluded by pattern.\n\n![Draft](draft.png)\n',
        'secret.png': PNG_SCREENSHOT,
        'draft.png': PNG_SECOND,
      },
      `${CONFIG}exclude:\n  - "drafts/**"\n`,
    );
    const trace = join(root, 'withheld.trace');

    await withFake(async (fake) => {
      const run = await cli(root, ['build', '--release', '--media', 'r2'], {
        ...mediaEnvironment(fake.base, trace),
      });
      assert.equal(run.status, 0, run.output);
      assert.equal(mediaLine(run.output), 'media: 0 referenced, 0 uploaded, 0 already present, 0 verified');
      assert.equal(fake.requests.length, 0, 'a withheld-only asset reached the network');
      assert.ok(!traceLines(trace).includes('module:aws4fetch'), 'an empty asset set loaded the signer');
    });
  });
});

test('an excluded asset referenced by a published note fails before any request', async () => {
  await scratch('r2-excluded-', async (root) => {
    repository(
      root,
      {
        'alpha.md': '# Alpha\n\nThis note has enough prose for the search index and references a withheld image.\n\n![Secret](assets/secret.png)\n',
        'assets/secret.png': PNG_SCREENSHOT,
      },
      `${CONFIG}exclude:\n  - "assets/**"\n`,
    );

    await withFake(async (fake) => {
      const run = await cli(root, ['build', '--release', '--media', 'r2'], {
        ...mediaEnvironment(fake.base, join(root, 'excluded.trace')),
      });
      assert.equal(run.status, 1, run.output);
      assert.equal(fake.requests.length, 0, 'a build that failed its content gate reached the network');
      assert.ok(!existsSync(join(root, 'dist', 'notes', 'alpha', 'index.html')), 'a failed build produced a page');
    });
  });
});

test('missing credentials fail after the local gates and preserve the previous output', async () => {
  await scratch('r2-missing-creds-', async (root) => {
    repository(root, {
      'alpha.md': '# Alpha\n\nThis is a published note about the first subject, with enough prose for the search index.\n\n![Screenshot](photo.png)\n',
      'photo.png': PNG_SCREENSHOT,
    });
    const trace = join(root, 'creds.trace');

    await withFake(async (fake) => {
      const good = await cli(root, ['build', '--release', '--media', 'r2'], {
        ...mediaEnvironment(fake.base, trace),
      });
      assert.equal(good.status, 0, good.output);
      const goodHtml = noteHtml(root);

      const missing = await cli(root, ['build', '--release', '--media', 'r2'], {
        ANC_FAKE_ORIGIN: fake.base,
        ANC_NETWORK_TRACE: trace,
      });
      assert.equal(missing.status, 1, missing.output);
      assert.ok(!missing.output.includes(SECRET_ACCESS_KEY), 'the failure printed a credential value');
      assert.ok(!missing.output.includes(ACCESS_KEY_ID), 'the failure printed the access key ID');
      assert.equal(noteHtml(root), goodHtml, 'the failed run replaced the previous good output');

      const report = JSON.parse(
        readFileSync(join(root, '.git', 'publish-report', 'content-report.json'), 'utf8'),
      ) as { failure: { code: string; detail: string } | null };
      assert.equal(report.failure?.code, 'media-credentials-missing');
      assert.ok(!report.failure?.detail.includes(SECRET_ACCESS_KEY));
      assert.ok(!report.failure?.detail.includes(ACCESS_KEY_ID));
    });
  });
});
