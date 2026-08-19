import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { loadArtifact } from '../src/lib/artifact-source.ts';
import { assertOutputInventory } from '../scripts/verify-output-inventory.ts';
import { BuildFailure } from '../scripts/write-report.ts';

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
    Object.values(named.languages)[0]!.wasm = 'zzq-missing';
    writeFileSync(namedPath, JSON.stringify(named), 'utf8');
    const namedError = mismatch(namedRoot);
    assert.match(namedError.message, /1 unexpected, 1 missing, 0 altered/);
    assert.match(namedError.detail, /wasm\.zzq-missing\.pagefind/);
    assert.match(namedError.detail, /wasm\.en\.pagefind/);
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
    rmSync(join(missingRoot, 'notes', 'reading-a-build-log', 'index.html'));
    const missing = mismatch(missingRoot);
    assert.match(missing.message, /0 unexpected, 1 missing, 0 altered/);
    assert.match(missing.detail, /notes\/reading-a-build-log\/index\.html/);

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
