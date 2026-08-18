/**
 * The preview server: what it serves, what it refuses to serve, and where it can
 * be reached from.
 *
 * The properties here divide into two kinds and the division matters, because
 * only one of them is this repository's to keep true.
 *
 * **Properties of `scripts/preview-site.ts`** — the refusal, the argument
 * parsing, the binary's dispatch. A regression in these is a regression here.
 *
 * **Properties of Astro's `preview()`** — that `outDir` is served and `root` is
 * not, that traversal is refused, that a foreign `Host:` header is rejected.
 * These are *assumed* by the module and are asserted anyway, because the module
 * chose that dependency on the strength of them: an Astro upgrade that starts
 * serving `root` would turn this package's own source into a stranger's preview,
 * and the failure would be silent. A gate over a dependency's behaviour is how a
 * decision made on measurement stays made.
 *
 * Every server here is stopped by the hook that started it. A daemonized preview
 * would outlive the suite — measured against the `astro preview` **CLI**, which
 * prints `Preview server already running (pid …)` and survives its parent — and
 * the API deliberately does not, which is itself one of the properties below.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer, get as httpGet } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, test } from 'vitest';

import {
  DEFAULT_PREVIEW_PORT,
  parsePreviewArguments,
  resolveArtifactDirectory,
  startPreview,
} from '../scripts/preview-site.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin/thoughtscape-publish.mjs');
const DIST = join(ROOT, 'dist');

/** Servers to stop however the test that started them ended. */
const running: { stop: () => Promise<void> }[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  // Stopping a Vite preview server, on the three gates that start their own.
  //
  // **This one was argued both ways and the measurement settled it.** Across six
  // full runs the worst was 5.2, 5.1, 5.7, 5.5, 6.5, and **12.9 s** — the last
  // over the 10 s default it inherited, on a run that otherwise passed. A first
  // draft raised it to 60 s on a 57% margin; that was reverted as raising an
  // unbroken bound, which was right on the evidence available at the time and
  // wrong once a sixth run existed.
  //
  // 45 s is ~3.5x the observed maximum. Lower than the 4x the browser hooks
  // take, because the distribution is narrower — 5-13 s against 1-43 s — and
  // because `server.stop()` is the product's own teardown path, so the bound is
  // still tight enough to catch it degrading. A timeout here fails the file
  // rather than a gate, and names a teardown rather than the test whose server
  // it was.
}, 45_000);

/** A temporary directory removed after the test, whatever it did. */
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'thoughtscape-preview-'));
  scratch.push(directory);
  return directory;
}

/** A directory carrying the marker, and nothing else that makes it a real build. */
function markedDirectory(): string {
  const directory = temporary();
  writeFileSync(join(directory, 'content-index.json'), '{"entries":[]}\n', 'utf8');
  return directory;
}

/**
 * Serve a directory other than `dist/` on its own port, stopped by `afterEach`.
 *
 * Only for a gate whose stimulus is *which* directory is served — everything
 * that just needs the built site on a port uses `sharedPort()`, which costs no
 * second Vite server.
 */
async function serve(directory: string): Promise<number> {
  const server = await startPreview(directory, 0, ROOT);
  running.push(server);
  return server.port;
}

/** One GET, with the body, over a client that normalises the path as a browser would. */
function fetchPath(port: number, path: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve) => {
    const request = httpGet(`http://127.0.0.1:${port}${path}`, { timeout: 8000 }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => { request.destroy(); resolve({ status: undefined, body: 'TIMEOUT' }); });
    request.on('error', (error) => resolve({ status: undefined, body: `ERR ${error.message}` }));
  });
}

/**
 * One request written onto the socket byte for byte.
 *
 * A `http.get` client resolves `..` in the path *before the request leaves*, so
 * it cannot measure whether the server refuses traversal — it measures its own
 * URL parser. Everything below that asks about a path the server should reject
 * uses this, and the difference is not cosmetic: `/../secret` through `http.get`
 * never reaches the wire as written.
 */
function rawRequest(port: number, path: string, host?: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host ?? `localhost:${port}`}\r\nConnection: close\r\n\r\n`);
    });
    let buffer = '';
    socket.setTimeout(8000, () => { socket.destroy(); resolve('TIMEOUT'); });
    socket.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); });
    socket.on('end', () => resolve(buffer));
    socket.on('error', (error) => resolve(`ERR ${error.message}`));
  });
}

/** The status line of a raw response, e.g. `HTTP/1.1 404 Not Found`. */
const statusOf = (response: string): string => response.split('\r\n')[0] ?? response;

/**
 * One server for every gate that only needs `dist/` on a port.
 *
 * Started once rather than per test, and the reason is a measured cost rather
 * than tidiness. Astro's cold start is 1.4 s to import plus 0.7 s for the first
 * `preview()`, and each later one is ~0.15 s *plus* a Vite server's worth of
 * work on a machine already running sixteen test workers. With one server per
 * test this file took 27 s alone and pushed an unrelated gate —
 * `tests/math-and-diagrams.test.ts`, which renders Mermaid — past its 30 s
 * timeout on the full run. Measured both ways: the suite is green without this
 * file and red with it, on a failure in a file this ticket never touched.
 *
 * Four gates share it. The three that do not are the ones whose stimulus *is*
 * the server: traversal needs a different directory served, the reported-port
 * gate needs a port it can see taken, and the stop gate has to stop one.
 */
let shared: { port: number; stop: () => Promise<void> } | undefined;

beforeAll(async () => {
  // Checked before the server is asked for, so a missing build fails as itself.
  // Without it `startPreview` throws Astro's own `The output directory … does
  // not exist. Did you run 'astro build'?` — measured, carrying an absolute host
  // path — and every gate in this file then fails at `sharedPort()` with no clue
  // which of them is the real problem. `tests/rendered-page.test.ts:204` guards
  // the same dependency the same way.
  assert.ok(
    existsSync(join(DIST, 'index.html')),
    'dist/ is missing or unbuilt — run `pnpm run build` before `pnpm test`',
  );
  shared = await startPreview(DIST, 0, ROOT);
  // Measured: 35.1 s alone, and 68.8 / 69.4 / 86.0 / 95.9 / 111.8 / 116.6 /
  // **187.2 s** across seven full runs. The cost is Astro's cold module graph
  // plus a Vite server, paid once, while fifteen other workers compete for the
  // same CPUs; the file's own comment above records why it is paid once rather
  // than sixteen times.
  //
  // 360 s is ~1.9x the observed maximum and ~10x the idle cost, and the second
  // multiple is the honest way to read it: **this hook's spread is the widest in
  // the suite**, 35 s to 187 s. The 187 s sample came from a host measured at
  // 2.4x degraded — an idle binary build costing 48 s where it costs 20 s — and
  // that is a plausible host, not a pathological one. A first draft set 240 s
  // from the 86 s worst then available, and that sample used 78% of it.
  //
  // A hung `preview()` still fails in six minutes, and it fails as itself: this
  // hook timing out reports all sixteen gates in the file as one error.
}, 360_000);

afterAll(async () => {
  await shared?.stop();
  // Measured at 0 ms across six full runs — `shared.stop()` on a server the
  // file's sixteen gates have finished with, where the `afterEach` above pays
  // the cost. It had no budget at all, which is the shape that cost a red run in
  // `tests/search.test.ts`. 45 s matches the `afterEach`, since it is the same
  // call on the same kind of server.
}, 45_000);

/** The shared server's port, with the reason it might be missing. */
function sharedPort(): number {
  assert.ok(shared !== undefined, 'the shared preview never started, so this gate measured nothing');
  return shared.port;
}

/**
 * A built site is what a preview serves.
 *
 * The control half is `dist/index.html` existing on disk: without it this gate
 * would pass against a preview of an empty directory and prove only that a
 * server answered.
 */
test('preview serves the built site', async () => {
  assert.ok(existsSync(join(DIST, 'index.html')), 'dist/ has no index.html, so this gate would measure nothing');

  const root = await fetchPath(sharedPort(), '/');

  assert.equal(root.status, 200, 'the preview did not serve the built index');
  assert.match(root.body, /<html/i, 'the preview served something that is not the built page');
});

/**
 * Nothing under the package root reaches the wire.
 *
 * This is the property the whole design rests on: `preview()` is given this
 * package as its `root` because that is where `astro.config.mjs` lives, and if
 * anything under it were served, a stranger's preview would serve this package's
 * source, `package.json`, and `node_modules`.
 *
 * **Committed files, and no canary written into the working tree.** A canary in
 * `public/` was written first — that is the directory an Astro *build* copies
 * wholesale, so it is the likeliest thing a `root`-reading server would serve —
 * and it is removed in a `finally` that a Ctrl-C or a timeout does not run,
 * leaving an untracked file in a directory the build copies verbatim into
 * `dist/`. The files below are already there and are as diagnostic: each is
 * present under `root` at a path that would resolve, and each is checked for a
 * string only that file carries, so a 200 *and* the content are both wrong.
 */
test('the preview serves the artifact and never the package root', async () => {
  const port = sharedPort();

  // Path under the package root, and a string only that file holds. The control
  // is the first assertion of each pair: the file really is there to be served,
  // so a 404 is the server declining rather than the file being absent.
  const underRoot: readonly [string, string][] = [
    ['package.json', '"packageManager"'],
    ['astro.config.mjs', 'DEFAULT_ORIGIN'],
    ['tsconfig.json', 'erasableSyntaxOnly'],
    ['public/_headers', 'Content-Security-Policy'],
  ];

  for (const [file, marker] of underRoot) {
    const onDisk = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(onDisk.includes(marker), `${file} no longer contains ${marker}, so this gate would prove nothing`);

    // `/public/_headers` as well as `/_headers`: the first is the literal path
    // under `root`, the second is where it would land if `public/` were served
    // as a site root. Both must miss.
    for (const path of file === 'public/_headers' ? ['/public/_headers', '/_headers'] : [`/${file}`]) {
      const response = await fetchPath(port, path);
      assert.notEqual(response.status, 200, `the preview served ${path} out of the package root`);
      assert.ok(!response.body.includes(marker), `the preview served ${file}'s contents at ${path}`);
    }
  }
});

/**
 * A path that escapes the served directory reads nothing.
 *
 * Five spellings, because one is not a class: a percent-encoded separator, a
 * doubled dot-segment, and a backslash all defeat a guard written against the
 * literal `..`. The canary sits one level above the served directory, which is
 * exactly where a user's notes sit relative to their `dist/`.
 */
test('the preview refuses a path that escapes the served directory', async () => {
  const parent = temporary();
  const served = join(parent, 'dist');
  mkdirSync(served);
  writeFileSync(join(served, 'content-index.json'), '{"entries":[]}\n', 'utf8');
  writeFileSync(join(served, 'index.html'), '<h1>built</h1>\n', 'utf8');
  writeFileSync(join(parent, 'secret.md'), 'zzqtraversalcanary\n', 'utf8');

  const port = await serve(served);

  // The control: the served directory really is one level below the canary, and
  // the server really is answering. Without both, every assertion below passes
  // against a server that answers nothing.
  assert.equal((await fetchPath(port, '/')).status, 200, 'the preview is not serving, so the escapes below prove nothing');
  assert.ok(existsSync(join(parent, 'secret.md')), 'the canary is absent, so nothing could have leaked');

  for (const path of [
    '/../secret.md',
    '/..%2fsecret.md',
    '/%2e%2e/secret.md',
    '/....//secret.md',
    '/..\\secret.md',
  ]) {
    const response = await rawRequest(port, path);

    // Each request is checked to have *reached the server* before its body is
    // checked for the canary. `rawRequest` resolves `ERR …` or `TIMEOUT` on a
    // failed connection, and a `doesNotMatch` for the canary passes on those
    // strings — measured, all five assertions passed against port 1, where
    // nothing listens. The control above uses `fetchPath`, a different client on
    // a different socket, so it proves the server answers `http.get` and not
    // that these five requests reached the wire.
    //
    // A status line rather than "not an error", because it is the stronger
    // statement and the responses are known: four 404 and one 500. The 500 is
    // `/..%2fsecret.md`, where Node's `fileURLToPath` throws on the encoded
    // separator inside Astro's preview middleware before any file is read.
    assert.match(statusOf(response), /^HTTP\/1\.1 (40\d|500)\b/, `${path} did not reach the server`);
    assert.doesNotMatch(response, /zzqtraversalcanary/, `${path} escaped the served directory`);
  }
});

/**
 * A directory this tool did not build is refused before a socket opens.
 *
 * The measurement behind it: `preview()` pointed at a plain directory served
 * `/.env` and `/private/salary.md` at 200. A user who types `--dist .` in their
 * notes repository would publish their notes on a port, which is the one failure
 * a tool built around an exclusion list may not have.
 */
test('preview refuses a directory this tool did not build', () => {
  const notes = temporary();
  mkdirSync(join(notes, 'private'));
  writeFileSync(join(notes, '.env'), 'SECRET=zzq\n', 'utf8');
  writeFileSync(join(notes, 'private', 'salary.md'), '# private\n', 'utf8');

  // The control: this is a plausible notes directory, not an empty one, and it
  // does not carry the marker.
  assert.ok(existsSync(join(notes, '.env')), 'the fixture is empty, so the refusal below is not about a notes directory');
  assert.ok(!existsSync(join(notes, 'content-index.json')), 'the fixture carries the marker, so it is not the case under test');

  assert.throws(
    () => resolveArtifactDirectory(notes, ROOT),
    (error: Error & { code?: string }) => error.code === 'preview-directory-not-an-artifact',
    'a directory of notes was accepted as a built site',
  );

  // Refused *before* anything binds, which is the half a code check does not
  // cover: a server that starts and then declines has already opened the port.
  // `startPreview` is the only thing here that opens a socket, so asserting the
  // throw came from the resolve — with no server handle to clean up — is the
  // ordering assertion.
  assert.equal(running.length, 0, 'a server was started before the directory was refused');

  // And the same directory becomes acceptable once it carries the marker, which
  // is what makes the refusal about the marker rather than about the fixture.
  writeFileSync(join(notes, 'content-index.json'), '{"entries":[]}\n', 'utf8');
  assert.equal(resolveArtifactDirectory(notes, ROOT), notes, 'a marked directory was still refused');
});

/**
 * What the refusal is worth: without it, that directory is served.
 *
 * The refusal gate above asserts a throw, and a throw proves the guard fires —
 * not that anything bad happens without it. This is the other half, and it is
 * the reason the guard is not decoration: `startPreview` does not consult the
 * marker, so pointing it at a notes directory is exactly what the binary would
 * do with the guard removed.
 *
 * Asserted on the token in the file, not on a status code: a 200 says the server
 * answered and only the bytes say what it answered with. The dotfile is the
 * sharp case — the directory has no `index.html` at all, so it is obviously not
 * a build, and every file in it is served anyway.
 */
test('without the marker check, a notes directory would be served', async () => {
  const notes = temporary();
  mkdirSync(join(notes, 'private'));
  writeFileSync(join(notes, '.env'), 'SECRET=zzqdotenvtoken\n', 'utf8');
  writeFileSync(join(notes, 'private', 'salary.md'), '# zzqsalarytoken\n', 'utf8');

  const port = await serve(notes);

  // The control: there is no index, so nothing here resembles a build output.
  assert.equal((await fetchPath(port, '/index.html')).status, 404, 'the fixture has an index, so it is not the case under test');

  for (const [path, token] of [['/.env', 'zzqdotenvtoken'], ['/private/salary.md', 'zzqsalarytoken']] as const) {
    const response = await fetchPath(port, path);
    assert.ok(
      response.body.includes(token),
      `${path} was not served, so this gate no longer shows what the marker check prevents`,
    );
  }
});

/**
 * A missing directory is a different error from an unmarked one.
 *
 * They have different fixes — run the build, versus name the right directory —
 * and a single code would send half the users to the wrong one.
 */
test('preview distinguishes a missing directory from an unbuilt one', () => {
  const absent = join(temporary(), 'never-created');
  assert.ok(!existsSync(absent), 'the fixture exists, so this is not the missing-directory case');

  assert.throws(
    () => resolveArtifactDirectory(absent, ROOT),
    (error: Error & { code?: string }) => error.code === 'preview-directory-not-found',
    'a missing directory did not report itself as missing',
  );
});

/**
 * Neither refusal puts a path on the stream.
 *
 * `--dist` may name a withheld directory — `clients/acme/2026-renewal` is the
 * spelling `bin/thoughtscape-publish.mjs` records as measured — and this message
 * reaches a workflow log. The path belongs on `detail`, which nothing prints.
 */
test('a preview refusal names no path on the surface a log inherits', () => {
  const notes = temporary();
  const absent = join(notes, 'zzqwithheldname');

  for (const directory of [absent, notes]) {
    let thrown: (Error & { detail?: string }) | undefined;
    try {
      resolveArtifactDirectory(directory, ROOT);
    } catch (error) {
      thrown = error as Error & { detail?: string };
    }

    assert.ok(thrown !== undefined, 'the directory was accepted, so there is no message to check');
    assert.doesNotMatch(thrown.message, /zzqwithheldname/, 'the refusal echoed the directory the user named');
    assert.doesNotMatch(thrown.message, /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/, 'the refusal put an absolute host path on the stream');
    assert.ok(thrown.detail?.includes(directory), 'the path reached neither the stream nor the detail, so it is lost');
  }
});

/**
 * The options, and what each way of getting them wrong costs.
 *
 * `--port 4321abc` is the case that motivates `Number` over `parseInt`: the
 * latter reads it as 4321 and serves on a port the user did not name.
 */
test('preview parses its options and refuses the rest', () => {
  assert.deepEqual(parsePreviewArguments([]), { dist: 'dist', port: DEFAULT_PREVIEW_PORT });
  assert.deepEqual(parsePreviewArguments(['--dist', 'out', '--port', '8080']), { dist: 'out', port: 8080 });

  for (const [argv, code] of [
    [['--outdir', 'out'], 'unknown-option'],
    [['--dist'], 'missing-value'],
    [['--dist', '--port'], 'missing-value'],
    [['--port', '4321abc'], 'invalid-port'],
    [['--port', '70000'], 'invalid-port'],
    [['--port', '1.5'], 'invalid-port'],
    [['--port', '-1'], 'invalid-port'],
    // Every one of these is a number to `Number` and none is a port the user
    // typed. The empty string is the one that is not a curiosity: `--port
    // "$PORT"` with `PORT` unset arrives here as `''`, and `Number('')` is 0 —
    // a valid ephemeral-port request. Measured before the shape check went in:
    // it was accepted and the server bound a random port while the user
    // believed they had named one.
    [['--port', ''], 'invalid-port'],
    [['--port', '  '], 'invalid-port'],
    [['--port', '0x10'], 'invalid-port'],
    [['--port', '1e3'], 'invalid-port'],
    [['--port', ' 4321 '], 'invalid-port'],
  ] as const) {
    assert.throws(
      () => parsePreviewArguments([...argv]),
      (error: Error & { code?: string }) => error.code === code,
      `${argv.join(' ')} was not refused as ${code}`,
    );
  }
});

/**
 * A rejected preview flag is never echoed.
 *
 * The same rule `bin/thoughtscape-publish.mjs` applies to `build`, and it is
 * here because a second parser is a second place to forget it: a withheld note's
 * stem wearing two dashes is still a disclosure.
 */
test('an unrecognised preview flag is not printed back', () => {
  let thrown: (Error & { detail?: string }) | undefined;
  try {
    parsePreviewArguments(['--zzqclientsacmerenewal', 'x']);
  } catch (error) {
    thrown = error as Error & { detail?: string };
  }

  assert.ok(thrown !== undefined, 'the flag was accepted');
  assert.doesNotMatch(thrown.message, /zzqclientsacmerenewal/, 'the refusal echoed the token the user typed');
  assert.equal(thrown.detail, '--zzqclientsacmerenewal', 'the token reached neither the stream nor the detail');
});

/**
 * A request carrying somebody else's hostname is refused.
 *
 * Vite's DNS-rebinding guard, and the reason this module did not hand-write a
 * `node:http` server: a page on a public site can point a name it controls at
 * 127.0.0.1 and read a preview through the browser of whoever is running it.
 * A hand-written server would have this protection only if someone remembered.
 *
 * `*.localhost` passing is asserted in the same breath because it is the half
 * that would break silently — a stricter upgrade that allowed only the literal
 * `localhost` would still pass a test that only checked the refusal.
 */
test('the preview refuses a foreign Host header and accepts loopback names', async () => {
  const port = sharedPort();

  const foreign = await rawRequest(port, '/', 'evil.example.com');
  assert.match(statusOf(foreign), /403/, 'a foreign Host header was served');

  // `notes.localhost` rather than the configured default origin's host. The
  // property under test is "any `*.localhost` subdomain is accepted", and
  // `tests/metadata.test.ts` fails if any file outside `astro.config.mjs`
  // spells that host — correctly, since a second copy of the origin is exactly
  // what that gate exists to prevent. Measured: this file named it and that
  // gate went red. An arbitrary subdomain tests the class better anyway.
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `notes.localhost:${port}`]) {
    const response = await rawRequest(port, '/', host);
    assert.match(statusOf(response), /200/, `a loopback name was refused: ${host}`);
  }
});

/**
 * The server binds loopback and nothing else.
 *
 * An unpublished-by-default site must not be reachable from the network the
 * user is on. Asserted by reading the bound address rather than by attempting a
 * remote connection, which would measure the host's firewall.
 */
test('the preview binds loopback only', async () => {
  const port = sharedPort();

  const response = await rawRequest(port, '/');
  assert.match(statusOf(response), /200/, 'the loopback bind is not serving');

  // A server bound to `0.0.0.0` or `::` answers on a non-loopback address of
  // this host. Every such address is tried; none may answer.
  //
  // Tried concurrently, because the *expected* result on each is a timeout and a
  // serial loop pays that in full per address — measured, 4 s for the two
  // addresses on this host. Concurrency does not weaken the assertion: a real
  // bind is a connect that succeeds, which the `0.0.0.0` mutation showed at
  // 66 ms, so the 2 s budget is generous either way.
  const { networkInterfaces } = await import('node:os');
  const external = Object.values(networkInterfaces())
    .flat()
    .flatMap((entry) => (entry !== undefined && !entry.internal && entry.family === 'IPv4' ? [entry.address] : []));

  const reachability = await Promise.all(
    external.map(
      (address) =>
        new Promise<{ address: string; reachable: boolean }>((resolve) => {
          const socket = connect({ port, host: address, timeout: 2000 });
          socket.on('connect', () => { socket.destroy(); resolve({ address, reachable: true }); });
          socket.on('timeout', () => { socket.destroy(); resolve({ address, reachable: false }); });
          socket.on('error', () => resolve({ address, reachable: false }));
        }),
    ),
  );

  for (const { address, reachable } of reachability) {
    assert.equal(reachable, false, `the preview answered on ${address}, which is not loopback`);
  }
});

/**
 * The port the command prints is the port the server got.
 *
 * `preview()` moves off a taken port rather than throwing — measured, a held
 * 4580 became 4581 — so a command that echoed the *requested* port would print a
 * URL nothing is listening on, on the one run where the user most needs it.
 */
test('the preview reports the port it actually bound', async () => {
  const blocker = createHttpServer((_request, response) => response.end('holding'));
  await new Promise<void>((done) => blocker.listen(0, '127.0.0.1', () => done()));
  const taken = (blocker.address() as { port: number }).port;

  try {
    const server = await startPreview(DIST, taken, ROOT);
    running.push(server);

    // The control: the port really is taken, so the server really did have to
    // move. Without this the assertion below passes on a free port.
    assert.notEqual(server.port, taken, 'the preview claimed a port another server holds');
    assert.match(statusOf(await rawRequest(server.port, '/')), /200/,
      'the reported port is not the one serving');
  } finally {
    // Awaited: an unawaited `close()` lets the next test observe the port
    // mid-release, which is a flake that would arrive blamed on that test.
    await new Promise<void>((done) => blocker.close(() => done()));
  }
});

/**
 * The server stops when it is told to, in this process.
 *
 * The `astro preview` CLI daemonizes — measured, it printed `Preview server
 * already running at http://localhost:4321 (pid 26248)` on a second invocation
 * and the first had outlived its parent shell. The API must not, or the
 * subcommand would leave a server the user cannot see holding a port, and this
 * suite would leak one per test.
 */
test('stopping the preview releases the port in this process', async () => {
  const server = await startPreview(DIST, 0, ROOT);
  const { port } = server;

  assert.match(statusOf(await rawRequest(port, '/')), /200/, 'the server never served, so stopping proves nothing');
  await server.stop();

  const afterStop = await new Promise<string>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1', timeout: 2000 });
    socket.on('connect', () => { socket.destroy(); resolve('STILL LISTENING'); });
    socket.on('timeout', () => { socket.destroy(); resolve('TIMEOUT'); });
    socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'ERROR'));
  });

  assert.equal(afterStop, 'ECONNREFUSED', 'the port still answers after stop(), so the server outlived the call');
});

/**
 * The binary dispatches `preview`, and its help names it.
 *
 * This is the gate for the failure mode the ticket names: three tickets in a row
 * shipped a unit nothing called from the shipped path. It runs the real binary
 * as a user would, from a directory that is not this repository.
 *
 * The refusal is what is measured rather than a served page, because a
 * successful preview does not exit — so a test that started one would have to
 * kill it, and killing a process is not evidence about which code path it took.
 * A `preview` that reached `parsePreviewArguments` and `resolveArtifactDirectory`
 * is a `preview` the dispatch found.
 */
test('the binary has a preview command and its help says so', () => {
  const help = spawnSync(process.execPath, [BINARY, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, `--help failed:\n${help.stderr}`);
  assert.match(help.stdout, /thoughtscape-publish preview/, 'the usage text does not name the preview command');
  assert.match(help.stdout, /--dist/, 'the usage text does not name --dist');
  assert.match(help.stdout, /--port/, 'the usage text does not name --port');

  const elsewhere = temporary();

  // The control: an unrecognised command is refused with a usage dump, so a
  // `preview` that produced *that* would mean the dispatch never matched.
  const unknown = spawnSync(process.execPath, [BINARY, 'zzqnotacommand'], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(unknown.status, 1, 'an unrecognised command did not fail');
  assert.match(unknown.stderr, /unrecognised command/, 'the control did not take the unrecognised path');

  // `preview` in a directory with no build: it must fail as *preview*, naming
  // the build, rather than as an unrecognised command.
  const noBuild = spawnSync(process.execPath, [BINARY, 'preview'], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(noBuild.status, 1, 'preview without a build did not fail');
  assert.doesNotMatch(noBuild.stderr, /unrecognised command/, 'preview was not dispatched — it fell through to the refusal');
  assert.match(noBuild.stderr, /preview directory not found/, 'preview did not report a missing build');

  // And it opens no report, so nothing announces a corpus this run never read.
  //
  // Matched on `content:` and `report:`, which are the two line prefixes
  // `announce` prints, rather than on `discovered`. Measured: a mutation that
  // opened a report inside `preview` printed `content: discovery did not
  // finish` — the aborted-run literal, which contains no such word — so the
  // narrower assertion stayed green while a preview announced a build report
  // for a corpus it never read.
  assert.doesNotMatch(noBuild.stdout, /^content:/m, 'preview announced a build report summary');
  assert.doesNotMatch(noBuild.stdout, /^report:/m, 'preview pointed at a build report');
});

/**
 * A running preview prints two lines and nothing else.
 *
 * The stream a workflow log inherits, and the rule the whole binary is built
 * around: nothing on it may be a string this tool did not compose. Measured
 * before `vite: { logLevel: 'silent' }` went in — `preview --port <held>` printed
 * `Port <held> is in use, trying another one...` from Vite's own logger, ahead
 * of this module's line, echoing the argv token `parsePreviewArguments` refuses
 * to echo. `logLevel: 'silent'` silences Astro's logger, and the preview server
 * is a Vite server logging through a second one.
 *
 * Run on a *held* port deliberately: that is the branch the leak lives on, and a
 * free port never reaches it.
 */
test('a running preview prints only the lines the binary composes', async () => {
  const blocker = createHttpServer((_request, response) => response.end('holding'));
  await new Promise<void>((done) => blocker.listen(0, '127.0.0.1', () => done()));
  const taken = (blocker.address() as { port: number }).port;

  // From the repository root with an explicit `--dist`, because the default is
  // `<cwd>/dist` — running *in* `dist/` looks for `dist/dist` and the command
  // refuses before it ever starts a server, which is a green-looking red.
  const child = spawn(process.execPath, [BINARY, 'preview', '--dist', DIST, '--port', String(taken)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  try {
    // Waited for, not slept through. A fixed 9 s sleep failed 2 runs in 6 —
    // spawning Node and paying Astro's cold start is not a bounded cost on a
    // machine running sixteen test workers, and the failure read as "the preview
    // never announced a URL", which blames the property for the clock. This
    // resolves the moment the second line lands and gives the whole budget to a
    // command that is genuinely stuck.
    //
    // Then one further beat, because the *leak* would arrive before the announce
    // — Vite logs the port-in-use line ahead of it — so waiting for the announce
    // is already sufficient to have captured it. The extra pause is only so a
    // late writer on either stream is not missed.
    await new Promise<void>((done, fail) => {
      // **25 s was the inner bound and it is what actually failed**, not the
      // outer one: run 2 of three full runs reported `the preview never
      // announced a URL in 25 s` with an empty stdout, on a gate that passed
      // alone at 23.8 s. That is the whole margin — the idle cost *is* the
      // budget, so any contention at all crosses it.
      //
      // Measured: 23.8 s alone, 19.7 s / 25.2 s / 21.3 s across three full runs.
      // The cost is spawning Node and paying Astro's cold start twice over —
      // once for the module graph, once for `preview()` — while fifteen other
      // workers compete, and `startPreview` in the shared `beforeAll` measures
      // the same thing at 35-86 s.
      //
      // 90 s is ~3.6x the observed maximum, under a 150 s outer that keeps the
      // inner bound the one that fires. This resolves the moment the second line
      // lands, so the budget is paid only by a command that is genuinely stuck.
      const budget = setTimeout(() => fail(new Error(`the preview never announced a URL in 90 s: ${stdout}`)), 90_000);
      const check = (): void => {
        if (!/press Ctrl-C to stop/.test(stdout)) return;
        clearTimeout(budget);
        setTimeout(done, 500);
      };
      child.stdout.on('data', check);
      check();
    });

    // The control: the command really got as far as serving, so the silence
    // below is a silent success rather than a command that died before logging.
    assert.match(stdout, /^preview: http:\/\/localhost:\d+\/$/m, 'the preview never announced a URL');

    // And the port it announced is not the held one, which is what puts this run
    // on the branch that used to leak.
    const announced = Number(/localhost:(\d+)/.exec(stdout)?.[1]);
    assert.notEqual(announced, taken, 'the port was not actually taken, so the leaking branch never ran');

    const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
    assert.deepEqual(
      lines,
      [`preview: http://localhost:${announced}/`, 'press Ctrl-C to stop'],
      'the preview printed a line the binary did not compose',
    );
    assert.equal(stderr.trim(), '', 'the preview wrote to stderr');
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((done) => blocker.close(() => done()));
  }
  // 150 s, so the inner 90 s wait above is the bound that fires and reports what
  // was stuck. 40 s was below its own inner wait plus the 500 ms settle, which
  // is the shape `vitest.config.ts` and the across-processes gate in
  // `tests/math-and-diagrams.test.ts` both record: a gate whose outer clock can
  // beat its inner one cannot fail with its own message.
}, 150_000);

/**
 * The preview subcommand's own flags are refused by its own parser.
 *
 * `--content` belongs to `build`; a combined table would accept it here and
 * silently ignore it.
 */
test('preview refuses build flags, through the binary', () => {
  const elsewhere = markedDirectory();
  const probe = spawnSync(process.execPath, [BINARY, 'preview', '--content', 'notes'], {
    cwd: elsewhere,
    encoding: 'utf8',
  });

  assert.equal(probe.status, 1, '`preview --content` was accepted');
  assert.match(probe.stderr, /unrecognised option for preview/, 'the refusal did not come from the preview parser');
});
