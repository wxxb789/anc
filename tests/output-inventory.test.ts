import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { loadArtifact } from '../src/lib/artifact-source.ts';
import { readBuildBinding, snapshotWorkspace } from '../src/lib/snapshot-reader.ts';
import { snapshotFileName } from '../src/lib/snapshot.ts';
import { copySnapshotToOutput } from '../scripts/copy-snapshot.ts';
import { readStagedWasm } from '../scripts/copy-wasm.ts';
import { assertOutputInventory } from '../scripts/verify-output-inventory.ts';
import { BuildFailure } from '../scripts/write-report.ts';
import { stageBindings } from './support/snapshot.ts';

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
