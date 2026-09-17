import { createHash } from 'node:crypto';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { loadArtifact } from '../src/lib/artifact-source.ts';
import { readBuildBinding, snapshotWorkspace } from '../src/lib/snapshot-reader.ts';
import { snapshotFileName, snapshotRoute } from '../src/lib/snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { copySnapshotToOutput } from '../scripts/copy-snapshot.ts';
import { readStagedWasm } from '../scripts/copy-wasm.ts';
import { assertOutputInventory } from '../scripts/verify-output-inventory.ts';
import { BuildFailure } from '../scripts/write-report.ts';
import { stageBindings, snapshotPath } from './support/snapshot.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
const ARTIFACT = loadArtifact();

function mismatch(root: string): BuildFailure {
  try {
    assertOutputInventory(root, ARTIFACT);
  } catch (error) {
    assert.ok(error instanceof BuildFailure, 'inventory failure lost its disclosure-checked type');
    assert.equal(error.code, 'output-inventory-mismatch');
    return error;
  }
  assert.fail('expected output inventory to fail');
}

/** A BuildFailure from an explicit workspace, whatever code it carries. */
function workspaceFailure(root: string, workspace: string): BuildFailure {
  try {
    assertOutputInventory(root, ARTIFACT, workspace);
  } catch (error) {
    assert.ok(error instanceof BuildFailure, 'inventory failure lost its disclosure-checked type');
    return error;
  }
  assert.fail('expected output inventory to fail');
}

/** Flip one byte away from the file's start, so the digest is what changed. */
function flipByte(path: string): void {
  const bytes = readFileSync(path);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(path, bytes);
}

function copyDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'output-inventory-'));
  cpSync(DIST, root, { recursive: true });
  return root;
}

/** Every file under a root with its byte size, for artifact-unchanged checks. */
function fileTree(root: string): string[] {
  const entries: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) {
        entries.push(name + '/');
        pending.push(path);
      } else {
        entries.push(name + ' ' + statSync(path).size);
      }
    }
  }
  return entries.sort();
}

/**
 * A dist copy whose root is deep enough that SQLite refuses to open the member.
 *
 * The inventory's unreadable branch wraps the driver open, and measured,
 * `node:sqlite` does not reach it for non-database bytes: the constructor
 * returns lazily and the first `PRAGMA` raises "file is not a database", which
 * the inventory reports as the refused-schema code. A member path past
 * SQLite's own pathname cap is a driver-level open failure a readable file
 * tree can produce while `readFileSync` still reads the same path.
 */
function copyDistDeep(): string {
  const base = mkdtempSync(join(tmpdir(), 'output-inventory-deep-'));
  const segments: string[] = [];
  // Comfortably past SQLite's 512-byte cap and comfortably under the host's
  // PATH_MAX; the probe pattern only needs the same shape as the bound member.
  while (join(base, ...segments, ...snapshotFileName('0'.repeat(64)).split('/')).length <= 1024) {
    segments.push('d'.repeat(200));
  }
  const root = join(base, ...segments);
  mkdirSync(root, { recursive: true });
  cpSync(DIST, root, { recursive: true });
  return root;
}

test('the real built output matches the exact route and generated-asset inventory', () => {
  const inspected = assertOutputInventory(DIST, ARTIFACT);
  assert.ok(inspected > 0, 'the inventory accepted a build without inspecting a file');
});

test('unexpected routes, assets, namespaces, and unreferenced Pagefind members fail by count only', () => {
  const root = copyDist();
  try {
    const mutations: { path: string; bytes: string }[] = [
      { path: 'surprise/index.html', bytes: '<h1>unexpected route</h1>' },
      { path: 'private-attachment.pdf', bytes: 'unreviewed bytes' },
      { path: '_astro/unhashed.js', bytes: 'export default 1' },
      { path: '_astro/nested/leak.js', bytes: 'export default 1' },
      { path: 'pagefind/fragment/zzq_unreferenced.pf_fragment', bytes: 'not in metadata' },
    ];
    for (const mutation of mutations) {
      const path = join(root, ...mutation.path.split('/'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, mutation.bytes, 'utf8');
      const error = mismatch(root);
      assert.match(error.message, /1 unexpected, 0 missing, 0 altered/);
      assert.ok(!error.message.includes(mutation.path), 'public inventory message disclosed a path');
      assert.ok(error.detail.includes(mutation.path), 'private inventory detail omitted the unexpected path');
      rmSync(path, { force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('Pagefind manifest failures are distinct and a null WASM uses its fixed fallback', () => {
  const unreadableRoot = copyDist();
  const invalidRoot = copyDist();
  const fallbackRoot = copyDist();
  const absentRoot = copyDist();
  const namedRoot = copyDist();
  try {
    writeFileSync(join(unreadableRoot, 'pagefind', 'pagefind-entry.json'), '{', 'utf8');
    let unreadable: BuildFailure | undefined;
    try {
      assertOutputInventory(unreadableRoot, ARTIFACT);
    } catch (error) {
      assert.ok(error instanceof BuildFailure);
      unreadable = error;
    }
    assert.equal(unreadable?.code, 'output-inventory-pagefind-unreadable');
    assert.ok(!unreadable?.message.includes('pagefind-entry.json'));

    writeFileSync(join(invalidRoot, 'pagefind', 'pagefind-entry.json'), '{"languages":[]}', 'utf8');
    let invalid: BuildFailure | undefined;
    try {
      assertOutputInventory(invalidRoot, ARTIFACT);
    } catch (error) {
      assert.ok(error instanceof BuildFailure);
      invalid = error;
    }
    assert.equal(invalid?.code, 'output-inventory-pagefind-invalid');

    const fallbackPath = join(fallbackRoot, 'pagefind', 'pagefind-entry.json');
    const entry = JSON.parse(readFileSync(fallbackPath, 'utf8')) as {
      languages: Record<string, { hash: string; wasm: string | null; page_count: number }>;
    };
    const source = Object.values(entry.languages)[0]!;
    entry.languages['fallback'] = { ...source, wasm: null };
    writeFileSync(fallbackPath, JSON.stringify(entry), 'utf8');
    assert.ok(assertOutputInventory(fallbackRoot, ARTIFACT) > 0);

    const absentPath = join(absentRoot, 'pagefind', 'pagefind-entry.json');
    const absent = JSON.parse(readFileSync(absentPath, 'utf8')) as typeof entry;
    delete (Object.values(absent.languages)[0] as { wasm?: string | null }).wasm;
    writeFileSync(absentPath, JSON.stringify(absent), 'utf8');
    let absentError: BuildFailure | undefined;
    try {
      assertOutputInventory(absentRoot, ARTIFACT);
    } catch (error) {
      assert.ok(error instanceof BuildFailure);
      absentError = error;
    }
    assert.equal(absentError?.code, 'output-inventory-pagefind-invalid');

    const namedPath = join(namedRoot, 'pagefind', 'pagefind-entry.json');
    const named = JSON.parse(readFileSync(namedPath, 'utf8')) as typeof entry;
    const namedLanguage = Object.values(named.languages).find((language) => typeof language.wasm === 'string');
    assert.ok(namedLanguage, 'the real Pagefind manifest has no named WASM branch to mutate');
    const originalWasm = namedLanguage.wasm!;
    namedLanguage.wasm = 'zzq-missing';
    writeFileSync(namedPath, JSON.stringify(named), 'utf8');
    const namedError = mismatch(namedRoot);
    assert.match(namedError.message, /1 unexpected, 1 missing, 0 altered/);
    assert.match(namedError.detail, /wasm\.zzq-missing\.pagefind/);
    assert.ok(namedError.detail.includes(`wasm.${originalWasm}.pagefind`));
  } finally {
    rmSync(unreadableRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(invalidRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(fallbackRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(absentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(namedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a symlinked output directory is unexpected and never traversed', () => {
  const root = copyDist();
  try {
    symlinkSync(join(root, 'notes'), join(root, 'linked-notes'), 'junction');
    const error = mismatch(root);
    assert.match(error.message, /1 unexpected, 0 missing, 0 altered/);
    assert.match(error.detail, /linked-notes/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a missing route and an altered package asset fail in distinct directions', () => {
  const missingRoot = copyDist();
  const alteredRoot = copyDist();
  try {
    const removedRoute = `notes/${ARTIFACT.entries[0]!.slug}/index.html`;
    rmSync(join(missingRoot, ...removedRoute.split('/')));
    const missing = mismatch(missingRoot);
    assert.match(missing.message, /0 unexpected, 1 missing, 0 altered/);
    assert.ok(missing.detail.includes(removedRoute));

    const favicon = join(alteredRoot, 'favicon.svg');
    writeFileSync(favicon, readFileSync(favicon, 'utf8') + '\n<!-- changed -->\n', 'utf8');
    const altered = mismatch(alteredRoot);
    assert.match(altered.message, /0 unexpected, 0 missing, 1 altered/);
    assert.match(altered.detail, /favicon\.svg/);
  } finally {
    rmSync(missingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(alteredRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/**
 * A corrupted or missing bound snapshot or wasm member fails by its own code.
 *
 * The inventory's digest claims over the two binding-driven members — the
 * digest-named snapshot and the digest-named WASM binary — are what the release
 * artifact's URL is supposed to be proven against, and until this gate the only
 * mutations the suite planted were to routes, package assets, and Pagefind
 * members, so deleting either comparison or either missing-member branch left
 * the suite green.
 *
 * **Measured, one mutation at a time:** replacing the snapshot digest
 * comparison with `false` reds the flipped-snapshot case because the corrupted
 * file is then accepted outright; renaming the missing-snapshot code reds the
 * deleted-member case at the code assertion; and the same two edits in
 * `wasmOutput` red the wasm cases. The fixture is the real build: the bindings
 * are copied byte for byte out of the staged workspace `bin/anc.mjs` passes to
 * `assertOutputInventory`, and each mutation changes exactly one member of a
 * copy of the real `dist/`.
 */
test('a corrupted or missing bound snapshot or wasm member fails by its own code', () => {
  const workspace = stageBindings(mkdtempSync(join(tmpdir(), 'output-inventory-bindings-')));
  const roots: string[] = [];
  try {
    const binding = readBuildBinding(workspace);
    const wasm = readStagedWasm(workspace);
    assert.ok(binding, 'the staged workspace has no snapshot binding, so this gate would measure nothing');
    assert.ok(wasm, 'the staged workspace has no wasm binding, so this gate would measure nothing');
    const snapshotMember = snapshotFileName(binding.digest);
    const wasmMember = wasm.members.find((member) => member.endsWith('.wasm'));
    assert.ok(wasmMember, 'the staged wasm binding names no .wasm member, so this gate would measure nothing');

    // The control: an untouched copy is accepted through the same call with the
    // same workspace argument, so each refusal below is the mutation.
    const control = copyDist();
    roots.push(control);
    assert.ok(assertOutputInventory(control, ARTIFACT, workspace) > 0, 'the fixture was refused before it was mutated');

    const digestRoot = copyDist();
    roots.push(digestRoot);
    flipByte(join(digestRoot, ...snapshotMember.split('/')));
    assert.equal(workspaceFailure(digestRoot, workspace).code, 'output-inventory-snapshot-digest');

    const missingRoot = copyDist();
    roots.push(missingRoot);
    rmSync(join(missingRoot, ...snapshotMember.split('/')));
    assert.equal(workspaceFailure(missingRoot, workspace).code, 'output-inventory-snapshot-missing');

    const wasmDigestRoot = copyDist();
    roots.push(wasmDigestRoot);
    flipByte(join(wasmDigestRoot, ...wasmMember.split('/')));
    assert.equal(workspaceFailure(wasmDigestRoot, workspace).code, 'output-inventory-wasm-digest');

    const wasmMissingRoot = copyDist();
    roots.push(wasmMissingRoot);
    rmSync(join(wasmMissingRoot, ...wasmMember.split('/')));
    assert.equal(workspaceFailure(wasmMissingRoot, workspace).code, 'output-inventory-wasm-missing');
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/**
 * The copy step's digest comparison is what proves the public filename.
 *
 * `copySnapshotToOutput` copies the staged database under its bound digest name
 * and then re-reads the copied bytes against the binding; before this gate only
 * the inventory's comparison (a different file) was exercised, so deleting this
 * one left the suite green. **Measured:** mutating the digest comparison to
 * `false` accepts the flipped staged bytes and the `assert.throws` below is what
 * fails, so the gate names the comparison it exists for.
 */
test('the copy step refuses staged bytes that do not hash to the bound digest', () => {
  const workspace = stageBindings(mkdtempSync(join(tmpdir(), 'copy-snapshot-')));
  const outputs: string[] = [];
  try {
    copyFileSync(join(snapshotWorkspace(), 'snapshot.sqlite'), join(workspace, 'snapshot.sqlite'));
    const binding = readBuildBinding(workspace);
    assert.ok(binding, 'the staged workspace has no snapshot binding, so this gate would measure nothing');

    // The control: the untouched staged pair copies and reports its bound URL.
    const output = mkdtempSync(join(tmpdir(), 'copy-snapshot-out-'));
    outputs.push(output);
    assert.equal(copySnapshotToOutput(output, workspace), binding.url);

    // The mutation: the same staged pair, with the source bytes altered.
    flipByte(join(workspace, 'snapshot.sqlite'));
    assert.throws(
      () => copySnapshotToOutput(output, workspace),
      /do not match the digest/,
      'the copy step accepted bytes that do not hash to the bound URL',
    );
  } finally {
    for (const output of outputs) rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/**
 * A second snapshot member is unexpected, whatever its name looks like.
 *
 * The bound digest is the only `data/site.<digest>.sqlite` the output may
 * carry; a differently named copy — still 64 lowercase hex, so nothing about
 * its shape is invalid — is a second publication surface and fails by count.
 * The name reaches the private detail only.
 */
test('a second digest-named snapshot member is unexpected and named only in the detail', () => {
  const root = copyDist();
  try {
    const binding = readBuildBinding(snapshotWorkspace());
    assert.ok(binding, 'the staged workspace has no snapshot binding, so this gate would measure nothing');
    const bound = snapshotFileName(binding.digest);
    // A real digest of different bytes: valid-looking and different from the
    // bound one, so the refusal is membership rather than naming.
    const planted = snapshotFileName(createHash('sha256').update(`second member of ${binding.digest}`).digest('hex'));
    assert.notEqual(planted, bound, 'the second name must differ from the bound member');
    copyFileSync(join(root, ...bound.split('/')), join(root, ...planted.split('/')));

    const error = mismatch(root);
    assert.match(error.message, /1 unexpected, 0 missing, 0 altered/);
    assert.ok(!error.message.includes(planted), 'public inventory message disclosed a path');
    assert.ok(error.detail.includes(planted), 'private inventory detail omitted the unexpected snapshot');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/**
 * The inventory's snapshot-schema refusal, over bytes its binding names.
 *
 * The digest fixtures stop at the hash comparison above these branches; this
 * fixture rebinds a staged workspace to mutated bytes so the digest check
 * passes first and the row validator is what refuses. The mutation is
 * `DROP INDEX edges_by_target`: SQLite still opens the file, so only the
 * contract's explicit-index comparison can see it.
 */
test('a digest-consistent snapshot whose schema is refused fails by its own code', () => {
  const workspace = stageBindings(mkdtempSync(join(tmpdir(), 'output-inventory-schema-')));
  const roots: string[] = [];
  try {
    copyFileSync(join(snapshotWorkspace(), 'snapshot.sqlite'), join(workspace, 'snapshot.sqlite'));
    const binding = readBuildBinding(workspace);
    assert.ok(binding, 'the staged workspace has no snapshot binding, so this gate would measure nothing');
    const bound = snapshotFileName(binding.digest);

    // The control and the refused fixture are one copy: the untouched output is
    // accepted through the same call before the workspace is mutated, so the
    // refusal below is the mutation rather than the fixture.
    const root = copyDist();
    roots.push(root);
    assert.ok(assertOutputInventory(root, ARTIFACT, workspace) > 0, 'the fixture was refused before it was mutated');

    const database = new DatabaseSync(join(workspace, 'snapshot.sqlite'));
    try {
      database.exec('DROP INDEX edges_by_target');
    } finally {
      database.close();
    }
    const mutated = readFileSync(join(workspace, 'snapshot.sqlite'));
    const digest = createHash('sha256').update(mutated).digest('hex');
    const member = snapshotFileName(digest);
    writeFileSync(join(workspace, 'binding.json'), JSON.stringify({ url: snapshotRoute(digest), digest }), 'utf8');

    rmSync(join(root, ...bound.split('/')));
    writeFileSync(join(root, ...member.split('/')), mutated);

    const error = workspaceFailure(root, workspace);
    assert.equal(error.code, 'output-inventory-snapshot-schema');
    assert.ok(error.detail.includes(member), 'the schema refusal did not name the member it inspected');
    assert.match(error.detail, /edges_by_target/, 'the refusal came from a check other than the dropped index');
    assert.ok(!error.message.includes(member), 'public schema message disclosed a path');
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/**
 * The inventory's snapshot-unreadable refusal and the artifact-unchanged
 * invariant, measured around the failed call.
 *
 * The requested fixture — non-SQLite bytes under their own bound digest — does
 * not reach the open refusal: measured, `node:sqlite` opens a non-database
 * lazily, the constructor returns, and the first `PRAGMA` raises "file is not a
 * database", which `snapshotOutput` reports as the refused-schema code. The
 * open refusal needs a driver-level failure, so the fixture that reaches it is
 * a copy of the real output under a root deep enough that SQLite's pathname cap
 * refuses the member while `readFileSync` reads the same path. Both fixtures
 * are kept, each asserted at the code it actually produces.
 */
test('an unopenable snapshot member fails unreadable without changing the artifact', () => {
  const workspace = stageBindings(mkdtempSync(join(tmpdir(), 'output-inventory-unreadable-')));
  const roots: string[] = [];
  try {
    copyFileSync(join(snapshotWorkspace(), 'snapshot.sqlite'), join(workspace, 'snapshot.sqlite'));
    const binding = readBuildBinding(workspace);
    assert.ok(binding, 'the staged workspace has no snapshot binding, so this gate would measure nothing');
    const bound = snapshotFileName(binding.digest);

    // The control: the untouched staged workspace against a normal-depth copy.
    const control = copyDist();
    roots.push(control);
    assert.ok(assertOutputInventory(control, ARTIFACT, workspace) > 0, 'the fixture was refused before it was mutated');

    const deepRoot = copyDistDeep();
    roots.push(deepRoot);
    assert.ok(
      join(deepRoot, ...bound.split('/')).length > 512,
      'the deep fixture did not exceed SQLite pathname cap, so this gate would measure nothing',
    );
    const before = fileTree(deepRoot);
    const unreadable = workspaceFailure(deepRoot, workspace);
    assert.equal(unreadable.code, 'output-inventory-snapshot-unreadable');
    assert.match(unreadable.detail, /unable to open database file/, 'the refusal was not the driver open');
    assert.ok(unreadable.detail.includes(bound), 'the open refusal did not name the member it inspected');
    assert.ok(!unreadable.message.includes(bound), 'public open message disclosed a path');
    assert.deepEqual(fileTree(deepRoot), before, 'the refused call changed the artifact or left a sidecar');

    // Non-SQLite bytes, bound to their own digest: refused, but by the row
    // reader rather than the constructor, so the code is the schema refusal.
    const garbage = Buffer.from('not a sqlite database at all');
    const garbageDigest = createHash('sha256').update(garbage).digest('hex');
    const garbageMember = snapshotFileName(garbageDigest);
    writeFileSync(join(workspace, 'snapshot.sqlite'), garbage);
    writeFileSync(
      join(workspace, 'binding.json'),
      JSON.stringify({ url: snapshotRoute(garbageDigest), digest: garbageDigest }),
      'utf8',
    );
    const garbageRoot = copyDist();
    roots.push(garbageRoot);
    rmSync(join(garbageRoot, ...bound.split('/')));
    writeFileSync(join(garbageRoot, ...garbageMember.split('/')), garbage);
    const garbageBefore = fileTree(garbageRoot);
    const garbageError = workspaceFailure(garbageRoot, workspace);
    assert.equal(garbageError.code, 'output-inventory-snapshot-schema');
    assert.match(garbageError.detail, /file is not a database/, 'the garbage refusal was not the driver header read');
    assert.deepEqual(fileTree(garbageRoot), garbageBefore, 'the refused call changed the artifact or left a sidecar');
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/**
 * Source maps, unbound wasm, and the private build files are refused even when
 * their names look valid.
 *
 * Goal 0006's exact-output row names "unexpected JS/WASM, source map, private
 * IR or legacy JSON" separately from routes and package assets, so each is
 * planted one at a time over the real output: the hash-shaped map proves the
 * `.map` refusal is not just a shape rejection, and the root-level
 * `binding.json`, `content.json`, and `content-report.json` prove the private
 * build surfaces never count as output members. Counts stay public; the member
 * name reaches the private detail only.
 */
test('unexpected wasm, source maps, and private build files fail by count with the name only in the detail', () => {
  const root = copyDist();
  try {
    const mutations: { path: string; bytes: string }[] = [
      { path: 'wasm/sqlite3.unexpected.wasm', bytes: 'not a bound wasm member' },
      { path: '_astro/unhashed.map', bytes: '{}' },
      { path: '_astro/app.0123456789abcdef.map', bytes: '{}' },
      { path: 'content.json', bytes: '{}' },
      { path: 'binding.json', bytes: '{}' },
      { path: 'content-report.json', bytes: '{}' },
    ];
    for (const mutation of mutations) {
      const path = join(root, ...mutation.path.split('/'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, mutation.bytes, 'utf8');
      const error = mismatch(root);
      assert.match(error.message, /1 unexpected, 0 missing, 0 altered/);
      assert.ok(!error.message.includes(mutation.path), 'public inventory message disclosed a path');
      assert.ok(error.detail.includes(mutation.path), 'private inventory detail omitted the unexpected path');
      rmSync(path, { force: true });
    }

    // Journal siblings of the bound snapshot are unexpected members in their
    // own right: a `-wal`/`-shm` pair means a WAL database, and the accepted
    // artifact is exactly one rollback-journal file. The scanners refuse a WAL
    // header inside the database itself (`tests/snapshot-rows.test.ts` and
    // `tests/secret-scan-database.test.ts`); this is the sibling-file half —
    // output that carried the sidecars must fail inventory even when the main
    // file still looks like a snapshot.
    const snapshotName = basename(snapshotPath(root));
    const snapshotFile = join(root, 'data', snapshotName);
    const snapshotBytes = readFileSync(snapshotFile);
    const dataMembers = join(root, 'data');
    const membersBefore = readdirSync(dataMembers).sort();
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const member = `data/${snapshotName}${suffix}`;
      writeFileSync(join(root, ...member.split('/')), 'journal bytes', 'utf8');
      let error: BuildFailure | undefined;
      try {
        assertOutputInventory(root, ARTIFACT);
      } catch (thrown) {
        assert.ok(thrown instanceof BuildFailure, 'inventory failure lost its disclosure-checked type');
        error = thrown;
      }
      // A sidecar is refused by name before the driver opens the database.
      // Measured before this check existed: a `-wal` sibling made the read-only
      // open recover, fail with "attempt to write a readonly database", and
      // leave a generated `-shm` file inside the directory being inspected.
      assert.equal(
        error?.code,
        'output-inventory-snapshot-format',
        `a ${suffix} sidecar was not refused as a format problem`,
      );
      assert.ok(!error!.message.includes(snapshotName), 'public inventory message disclosed the snapshot name');
      assert.ok(error!.detail.includes(snapshotName + suffix), 'private inventory detail omitted the sidecar name');
      assert.deepEqual(
        readdirSync(join(root, 'data')).sort(),
        [...membersBefore, snapshotName + suffix].sort(),
        'the refusal generated or removed a file in the artifact directory',
      );
      assert.ok(snapshotBytes.equals(readFileSync(snapshotFile)), 'the refusal changed the snapshot bytes');
      rmSync(join(root, ...member.split('/')));
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
