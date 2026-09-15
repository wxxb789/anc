/**
 * `anc preview` — serve a built site on loopback.
 *
 * A user who has run `build` has a directory of HTML and no way to look at it.
 * Opening `dist/index.html` with `file://` does not work: every page links
 * `/notes/x/`, a root-relative path that under `file://` resolves to the
 * filesystem root, and Pagefind fetches its index over HTTP. A server is the
 * only way to read one's own site before publishing it.
 *
 * ## Why a subcommand at all, when `astro preview` exists
 *
 * Because it is not there. `package.json` has an `astro preview` script and that
 * serves *this repository's* build; a stranger has this package in their
 * `node_modules` and their own `dist/`. Measured, with the real tarball from
 * `scripts/compile-package.ts` installed three ways:
 *
 * | Install | `node_modules/.bin/` | `astro preview` |
 * | --- | --- | --- |
 * | `npm install <tarball>` | `astro` present, hoisted | works |
 * | `pnpm add <tarball>` | `anc`, `esbuild`, `vite`, `yaml` | **`node_modules/astro` does not exist** |
 * | `npx <tarball> build` | nothing installed locally | nothing to run |
 *
 * So "run `astro preview`" is advice that holds for one of three install paths,
 * and the one it holds for holds by accident — npm's flat hoisting, not a
 * promise this package makes. The user always has the binary they just typed;
 * that is the only entry point this tool can rely on.
 *
 * ## Astro's `preview()` rather than a hand-written `node:http`
 *
 * `import('astro')` already resolves from the installed package — measured from
 * inside `node_modules/anc` under the pnpm layout, where the
 * *binary* is absent but the *module* resolves fine, because it is this
 * package's own dependency. It is an existing dependency doing a job it already
 * does, which beats forty lines of MIME table and traversal guard that would
 * duplicate what `tests/rendered-page.test.ts` already has for its own purposes.
 *
 * What it gives, all executed against a `dist/` outside the package:
 *
 * - `outDir` is served and `root` is not. `package.json`, `astro.config.mjs`,
 *   `tsconfig.json`, and `public/_headers` all 404 while sitting under the
 *   `root` that was passed in. So pointing the server at the user's build cannot
 *   serve this package's files.
 * - Traversal is refused: `/../secret.md`, `/%2e%2e/secret.md`, `/....//secret.md`,
 *   `/..\secret.md`, and `/../../<sibling>/secret.md` are 404 with a canary file
 *   present at each target, and `/..%2fsecret.md` is a 500 — Node's
 *   `fileURLToPath` throws on the encoded separator inside Astro's preview
 *   middleware before any file is read. No path escapes in any of the six, but
 *   the 500's body carries the throwing frame, which is a path inside this
 *   package's `node_modules`. That reaches an HTTP client rather than a stream,
 *   so this repository's disclosure rule does not govern it, and the server is
 *   bound to loopback with Vite refusing a foreign `Host:` — so the audience for
 *   it is a process already running as the user. Recorded rather than fixed:
 *   suppressing it means owning Astro's error middleware.
 * - `trailingSlash: 'always'` is honoured — `/notes/x` 404s, `/notes/x/` serves.
 * - A `Host:` header of `evil.example.com` is refused with 403 while
 *   `localhost`, `127.0.0.1`, and any `*.localhost` are served. That is Vite's
 *   DNS-rebinding guard, and it is a real protection a hand-written server would
 *   not have had unless someone remembered to write it.
 * - A taken port moves to the next free one rather than throwing.
 * - It does **not** daemonize when called as a function. The `astro preview` CLI
 *   does — it printed `Preview server already running (pid 26248)` and outlived
 *   its parent — but the API's `stop()` closes the port in this process, so the
 *   subcommand runs in the foreground and ends with Ctrl-C, which is what a
 *   preview should do.
 *
 * One thing it does not give, recorded so nobody reads more into a passing
 * preview than it says: **no `_headers`.** The built site ships a CSP and five
 * other security headers in that file, Cloudflare Pages applies them, and this
 * server sends none of them. So a preview cannot prove the deployed site's CSP
 * admits its own scripts — `tests/rendered-page.test.ts` covers that by serving
 * `dist/` itself with `public/_headers` parsed and applied, which is why that
 * file has its own server and this one does not reuse it. A preview shows the
 * content; the gate proves the headers.
 *
 * ## The refusal, which is the part that is not convenience
 *
 * `preview()` serves whatever directory it is given, and a directory of notes is
 * a directory. Measured, pointed at one holding `.env` and `private/salary.md`:
 *
 *     /.env               -> 200   SECRET=…
 *     /private/salary.md  -> 200   the note's contents
 *     /index.html         -> 404
 *
 * Note the third line, which is the sharp part: the directory is *obviously* not
 * a build — it has no index — and every file in it is served anyway. So `--dist .`
 * in a notes repository publishes the notes **and** the dotfiles on a port, which
 * for a tool whose entire premise is that excluded notes never ship is the worst
 * thing it could do.
 *
 * So the directory must carry exactly one regular `data/site.<sha256>.sqlite`,
 * matching SQLite magic, application ID, the reader's exact version, and the
 * digest in its own filename.
 *
 * **That file and not `index.html`, because the marker has to be something only
 * this tool writes.** An `index.html` is the most ordinary file on earth — a
 * user may plausibly have one lying around in a notes directory, a downloaded
 * page, or any other static site's output, and every one of those would satisfy
 * a guard written against it while being no build of ours. A digest-named
 * snapshot with ANC's own `application_id` is this tool's own projection of the
 * corpus and nothing else produces it. The guard is only as good as the marker's
 * exclusivity.
 *
 * **A matching filename is not enough; the bytes are checked.** A hand-made
 * `data/site.<64hex>.sqlite` still has to carry the SQLite header, the format
 * constants, and a SHA-256 equal to the digest in its name. That refuses the
 * ordinary accident (`--dist .`, a typo, a stale path, a truncated copy) without
 * turning recognition into a full correctness proof.
 *
 * It is a marker of "this tool built this", not a validity check — a
 * schema-valid snapshot with wrong content still previews. What it excludes is
 * the *category* error of aiming the server at a directory that was never a
 * build output.
 *
 * **Checked before anything binds.** `resolveArtifactDirectory` throws and
 * `startPreview` is the only thing that opens a socket; the binary calls them in
 * that order. A server that starts and then refuses has already opened the port.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import {
  SNAPSHOT_APPLICATION_ID,
  SNAPSHOT_DIRECTORY,
  SNAPSHOT_FILE_PATTERN,
  SNAPSHOT_USER_VERSION,
} from '../src/lib/snapshot.ts';
import { BuildFailure } from './write-report.ts';

/** The SQLite file header every valid snapshot starts with. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Astro's default preview port, and deliberately the same number.
 *
 * A user who has previewed an Astro site knows this port; a user who has not
 * reads it from the line the command prints. Choosing a different one would buy
 * nothing and cost the recognition.
 */
export const DEFAULT_PREVIEW_PORT = 4321;

/**
 * Find and validate the one snapshot in a built output.
 *
 * @throws {BuildFailure} when the directory has no snapshot, more than one, a
 *   member whose digest does not match its bytes, or a file that is not ANC's
 *   SQLite format.
 */
function resolveSnapshot(directory: string): string {
  const dataDirectory = resolve(directory, SNAPSHOT_DIRECTORY);
  let candidates: string[] = [];
  try {
    candidates = existsSync(dataDirectory)
      ? readdirSync(dataDirectory).filter((name) => SNAPSHOT_FILE_PATTERN.test(name))
      : [];
  } catch {
    candidates = [];
  }

  if (candidates.length !== 1) {
    throw new BuildFailure(
      'preview-directory-not-an-artifact',
      'not a built site: the directory named by --dist does not carry exactly one ' +
        'data/site.<sha256>.sqlite snapshot, so it was not produced by this tool. ' +
        'Refusing to serve it — a directory of notes served on a port publishes every ' +
        'file in it. Name the build output directory instead; the default is `dist`.',
      `${dataDirectory}: ${candidates.length} snapshot candidate(s)`,
    );
  }

  const name = candidates[0]!;
  const path = resolve(dataDirectory, name);
  if (!statSync(path).isFile()) {
    throw new BuildFailure(
      'preview-directory-not-an-artifact',
      'not a built site: the snapshot candidate is not a regular file.',
      path,
    );
  }

  const match = SNAPSHOT_FILE_PATTERN.exec(name)!;
  const expected = match[1]!;
  const bytes = readFileSync(path);
  if (bytes.length < 100 || !bytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    throw new BuildFailure(
      'preview-snapshot-invalid',
      'the preview snapshot is not a SQLite database.',
      `${path}: missing SQLite header`,
    );
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new BuildFailure(
      'preview-snapshot-digest',
      'the preview snapshot bytes do not match the digest in their filename.',
      path,
    );
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new BuildFailure(
      'preview-snapshot-unreadable',
      'the preview snapshot could not be opened.',
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const applicationId = (database.prepare('PRAGMA application_id').get() as { application_id: number })
      .application_id;
    const userVersion = (database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (applicationId !== SNAPSHOT_APPLICATION_ID || userVersion !== SNAPSHOT_USER_VERSION) {
      throw new BuildFailure(
        'preview-snapshot-format',
        'the preview snapshot is not a snapshot this reader accepts.',
        `${path}: application_id=${applicationId}, user_version=${userVersion}`,
      );
    }
  } catch (error) {
    // `node:sqlite` opens a file whose header is valid and whose pages are not
    // lazily, so a corrupt snapshot fails here rather than at the constructor.
    // A `BuildFailure` is the format refusal above and must pass through.
    if (error instanceof BuildFailure) throw error;
    throw new BuildFailure(
      'preview-snapshot-unreadable',
      'the preview snapshot could not be read.',
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    database.close();
  }
  return path;
}

/**
 * Check a directory is one this tool built, and return its absolute path.
 *
 * Exported for the gates, which need to assert the refusal without standing up
 * a server. The path is returned rather than the caller re-resolving it, so the
 * thing checked and the thing served cannot drift apart.
 */
export function resolveArtifactDirectory(directory: string, from: string): string {
  const resolved = resolve(from, directory);

  if (!existsSync(resolved)) {
    throw new BuildFailure(
      'preview-directory-not-found',
      'preview directory not found: the directory named by --dist does not exist. ' +
        'Run the build first — its default output directory is `dist`.',
      resolved,
    );
  }

  resolveSnapshot(resolved);

  if (!existsSync(resolve(resolved, 'index.html'))) {
    // The path is not in the message. A user who typed `--dist clients/acme` is
    // looking at the command they typed, and the stream this reaches is one a
    // workflow log inherits — the same rule `bin/anc.mjs`
    // applies to every argv token it declines to echo.
    throw new BuildFailure(
      'preview-directory-not-an-artifact',
      'not a built site: the directory named by --dist has no entry page and no ' +
        'data/site.<sha256>.sqlite snapshot, so it was not produced by this tool. ' +
        'Refusing to serve it. Name the build output directory instead; the default is `dist`.',
      resolved,
    );
  }

  return resolved;
}

/**
 * Serve a built site until the process is interrupted.
 *
 * Resolves when the server is listening, and the returned handle is what a gate
 * uses to make requests and shut down. The binary never calls `stop()` — it
 * hands the process to the server and the user ends it with Ctrl-C.
 *
 * `host` is `127.0.0.1` and is not configurable. Every other choice publishes a
 * user's unpublished-by-default site to their network, and the flag that would
 * do it is a flag someone eventually passes. Astro's own default binds
 * `localhost`, which on this host resolves to `::1` — measured — and a literal
 * `127.0.0.1` is the same protection without depending on what a name resolves
 * to.
 */
export async function startPreview(
  artifactDirectory: string,
  port: number,
  packageRoot: string,
): Promise<{ port: number; stop: () => Promise<void> }> {
  // Dynamically imported, matching how `bin/anc.mjs` loads
  // every build step: a `preview` run must not pay for Astro's module graph
  // being resolved when the user typed `build`, and vice versa.
  //
  // **Through `import.meta.resolve` rather than as a bare specifier**, and the
  // reason is measured rather than stylistic. Astro's own Vite config aliases
  // `/^astro$/` to `astro/types/public/index.js` — `create-vite.js:216-220`,
  // read at astro 7.1.6 — so that `import { Type } from 'astro'` works in user
  // code. `vitest.config.ts` reuses that exact config through `getViteConfig`,
  // so under the test suite a bare `import('astro')` resolves to the *types*
  // module: measured, `Object.keys()` is empty and `preview` is `undefined`.
  // The shipped binary is unaffected, which is the trap — the module works in
  // production and cannot be tested, which is how a gate ends up asserting
  // something other than what ships.
  //
  // `import.meta.resolve` is Node's own resolver and no bundler rewrites its
  // result: measured under vitest, it returns the real `astro/dist/index.js`
  // and `preview` is a function. `tests/packaging.test.ts:549` already reaches
  // an Astro internal the same way for the same class of reason.
  const { preview } = await import(/* @vite-ignore */ import.meta.resolve('astro'));

  const server = await preview({
    // `root` is where `astro.config.mjs` lives — this package, never the user's
    // directory, for the reason `bin/anc.mjs` documents at
    // length for `build`. It contributes only the config; nothing under it is
    // served, which is measured rather than assumed.
    root: packageRoot,
    outDir: artifactDirectory,
    server: { port, host: '127.0.0.1' },
    // Astro's own listening line names a port that may not be the one it got,
    // and prints it before this function can compare. Silenced, and the caller
    // prints the real one from `server.port`.
    logLevel: 'silent',
    vite: { logLevel: 'silent' },
    // **Both loggers, because they are two loggers.** `logLevel` reaches
    // Astro's; the preview server is a Vite server and Vite logs through its
    // own, which `httpServerStart` uses for the port-in-use line. Measured with
    // only the Astro one set: `anc preview --port 47411` on a
    // held port printed `Port 47411 is in use, trying another one...` to stdout
    // ahead of this module's line — and that number is an argv token, which is
    // the class `parsePreviewArguments` refuses to echo forty lines below, on
    // the same stream a workflow log inherits. With this line the identical run
    // prints only the two lines the binary composes.

  });

  return { port: server.port, stop: () => server.stop() };
}

/**
 * Parse `preview`'s options.
 *
 * Deliberately its own parser rather than an extension of `build`'s: the two
 * share no flags, and a combined table would accept `--content` for a preview
 * and `--dist` for a build. Unknown flags are refused for the reason
 * `parseArguments` gives in `bin/anc.mjs` — a mistyped flag
 * that is silently ignored produces a plausible result the user did not ask for
 * — and, as there, the rejected token is never echoed.
 */
export function parsePreviewArguments(argv: readonly string[]): { dist: string; port: number } {
  let dist = 'dist';
  let port = DEFAULT_PREVIEW_PORT;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = argument === '--dist' ? 'dist' : argument === '--port' ? 'port' : undefined;
    if (key === undefined) {
      throw new BuildFailure('unknown-option', 'unrecognised option for preview', argument);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      // `argument` is one of this file's own two literals here, so printing it
      // is printing a string this source declares.
      throw new BuildFailure('missing-value', `${argument} needs a value`);
    }
    index += 1;

    if (key === 'dist') {
      dist = value;
      continue;
    }

    // **The decimal spelling is required before any coercion.** `parseInt` was
    // rejected first because it reads `4321abc` as 4321 — and `Number` alone has
    // the same defect in other spellings, measured: `''`, `'  '`, and `'\n'` all
    // become 0, `'0x10'` becomes 16, `'1e3'` becomes 1000, and `' 4321 '` becomes
    // 4321. The empty string is the one that is not a curiosity: `--port "$PORT"`
    // with `PORT` unset reaches here as `''`, survives the `startsWith('--')`
    // guard above, and would bind an ephemeral port while the user believes they
    // named one — a silently wrong result presented as success, which is the
    // failure class this whole parser exists to prevent.
    //
    // So the shape is checked as text first, and only a string of digits is
    // coerced. `Number.isInteger` then cannot fail, and is kept because a
    // 20-digit input is integral text and not a port.
    if (!/^\d+$/.test(value)) {
      // The value is not echoed. A port is not itself sensitive, but this is the
      // same stream, and the rule that a printed token must be one of this
      // tool's own spellings does not admit exceptions for values that look
      // harmless — `--port` is followed by whatever the shell expanded.
      throw new BuildFailure('invalid-port', '--port must be a whole number between 0 and 65535', value);
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed > 65535) {
      throw new BuildFailure('invalid-port', '--port must be a whole number between 0 and 65535', value);
    }
    port = parsed;
  }

  return { dist, port };
}
