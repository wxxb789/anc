/**
 * The removed public index, and the retired graph, adjacency, and
 * tag-membership payload shapes, are absent from the built output — by name, by
 * serialized relation shape, and by SQLite header.
 *
 * `assertOutputInventory` already rejects any unexpected file, and
 * `tests/output-inventory.test.ts` exercises it. This gate exists because the
 * goal's "Single output model" condition names the legacy payloads explicitly:
 * a green inventory alone would keep passing if its route model ever grew a
 * rule for `content-index.json` (say, a new generated file) and the retired
 * payload returned under its old name. So the names are a claim here, not a
 * side effect, and the inventory's refusal is positively controlled by
 * planting each name into a copy of the real output.
 *
 * **Measured over this repository's own `dist/` when this gate was added:**
 * 150 files inspected, exactly one `.json` (`pagefind/pagefind-entry.json`),
 * zero files with any legacy basename at any depth, and exactly
 * two files carrying the NUL-terminated SQLite header — the bound
 * `data/site.<64 hex>.sqlite` payload and `wasm/sqlite3.<64 hex>.wasm`, the
 * WASM build of SQLite itself. `sqlite-wasm.js` and `sqlite3-worker1.mjs` both
 * contain the string `SQLite format 3` *without* the trailing NUL (a quoted
 * format check in minified code), which is why this gate discriminates on the
 * full 16-byte header: a bare substring test would false-positive on them.
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { loadArtifact } from '../src/lib/artifact-source.ts';
import { SQLITE_MAGIC } from '../scripts/snapshot-rows.ts';
import { assertOutputInventory } from '../scripts/verify-output-inventory.ts';
import { BuildFailure } from '../scripts/write-report.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
const ARTIFACT = loadArtifact();

/**
 * Names a retired payload shape would plausibly return under. Only
 * `content-index.json` ever existed as a file, so these are guards against
 * shape, not a record of filenames that were once shipped.
 */
const LEGACY_PAYLOAD_NAMES = new Set([
  'content-index.json',
  'graph-manifest.json',
  'adjacency.json',
  'graph.json',
  'site.json',
  'index.json',
  'tags.json',
  'memberships.json',
]);

/** The public names the retired payloads referred to each other by. */
const RETIRED_PAYLOAD_NAMES = ['content-index.json', 'graph-manifest.json'] as const;

/** The relation-authority keys the removed public index serialized. */
const RELATION_AUTHORITY_KEYS = new Set(['outgoing', 'backlinks']);

/**
 * The only two members the build may ship with the SQLite header in them.
 *
 * The first is the bound public projection, whose exact name is asserted below.
 * The second is the WASM binary, which embeds the header string as data.
 * Anything else carrying the header is a second relational payload the output
 * model does not own.
 */
const BOUND_SQLITE_PAYLOAD = /^data\/site\.[0-9a-f]{64}\.sqlite$/;
const BOUND_WASM_MEMBER = /^wasm\/sqlite3\.[0-9a-f]{64}\.wasm$/;

function posix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Every file under `root`, relative and `/`-separated.
 *
 * The same walk shape as `scripts/verify-output-inventory.ts` uses, so the
 * names this gate checks are the names the inventory compares.
 */
function filesUnder(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else files.push(posix(relative(root, path)));
    }
  }
  return files.sort();
}

/** The legacy names a file list carries, at any depth, not only at the root. */
function legacyNamed(files: readonly string[]): string[] {
  return files.filter((file) => LEGACY_PAYLOAD_NAMES.has(basename(file)));
}

/** Every object key anywhere in a parsed JSON value, arrays included. */
function objectKeys(value: unknown): string[] {
  const keys: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current !== null && typeof current === 'object') {
      for (const [key, member] of Object.entries(current)) {
        keys.push(key);
        pending.push(member);
      }
    }
  }
  return keys;
}

/**
 * Why this JSON document is a legacy relation payload, or an empty list.
 *
 * Unparseable `.json` is itself a finding: Pagefind's binary members are
 * `.pf_meta`/`.pf_fragment` and never reach this function, so a `.json` the
 * detector cannot parse would otherwise let the key half of the check pass
 * without ever looking.
 */
function legacyJsonFinding(bytes: Buffer): string[] {
  const text = bytes.toString('utf8');
  const findings: string[] = [];
  for (const name of RETIRED_PAYLOAD_NAMES) {
    if (text.includes(name)) findings.push('mentions ' + name);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    findings.push('is not parseable as JSON: ' + (error instanceof Error ? error.message : String(error)));
    return findings;
  }
  for (const key of objectKeys(value)) {
    if (RELATION_AUTHORITY_KEYS.has(key)) findings.push('carries relation key ' + JSON.stringify(key));
  }
  return findings;
}

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
  const root = mkdtempSync(join(tmpdir(), 'legacy-payload-'));
  cpSync(DIST, root, { recursive: true });
  return root;
}

test('the built output ships no legacy public index, graph manifest, or adjacency payload', () => {
  assert.ok(existsSync(DIST), 'the real built output is absent, so this gate would measure nothing');
  const files = filesUnder(DIST);
  assert.ok(files.length > 0, 'the output walk inspected no file');

  // Named absence, at any depth. The eight names are the public-index,
  // manifest, adjacency, and tag-membership shapes a retired payload would
  // return under; the planted-sample control below fires on each.
  assert.deepEqual(legacyNamed(files), [], 'a retired payload name reappeared in the output');

  // Serialized relation shape. Only `.json` files are parsed: Pagefind's
  // `.pf_meta` and `.pf_fragment` members are binary, not JSON.
  const jsonFiles = files.filter((file) => file.endsWith('.json'));
  assert.ok(jsonFiles.length > 0, 'no JSON file was inspected, so the relation-key check would be vacuous');
  const findings: string[] = [];
  for (const file of jsonFiles) {
    for (const finding of legacyJsonFinding(readFileSync(join(DIST, ...file.split('/'))))) {
      findings.push(file + ' ' + finding);
    }
  }
  assert.deepEqual(findings, [], 'a JSON payload carries the removed relation authority');

  // The SQLite header, as bytes and NUL-terminated, so minified code that
  // mentions the format string is not mistaken for a database. The inventory
  // proves the DB's digest is the bound one; this proves it is the only
  // relational payload in the output.
  const strayMagic = files.filter((file) => {
    const hasMagic = readFileSync(join(DIST, ...file.split('/'))).includes(SQLITE_MAGIC);
    return hasMagic && !BOUND_SQLITE_PAYLOAD.test(file) && !BOUND_WASM_MEMBER.test(file);
  });
  assert.deepEqual(strayMagic, [], 'a file other than the bound payload carries the SQLite header');

  const databases = files.filter((file) => BOUND_SQLITE_PAYLOAD.test(file));
  assert.equal(databases.length, 1, 'the output does not ship exactly one bound SQLite payload');
  assert.ok(
    readFileSync(join(DIST, ...databases[0]!.split('/'))).includes(SQLITE_MAGIC),
    'the bound SQLite payload does not carry the SQLite header, so the header check measured nothing',
  );
  assert.ok(
    files.some((file) => BOUND_WASM_MEMBER.test(file)),
    'the bound wasm member is absent, so its header allowance is untested',
  );
});

/**
 * The detectors' own control: the sample carries both key spellings and one of
 * the retired names, and the name predicate catches a nested payload. Run the
 * same functions the absence assertions above run — no reimplementation.
 */
test('the legacy-payload detectors fire on planted samples, so the absence above cannot be vacuous', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-payload-control-'));
  try {
    const sample = join(root, 'sample.json');
    writeFileSync(sample, JSON.stringify({
      artifact: {
        relations: {
          backlinks: { 'notes/a': [] },
          outgoing: { 'notes/a': ['notes/b'] },
        },
      },
      builtFrom: 'graph-manifest.json',
    }), 'utf8');
    const findings = legacyJsonFinding(readFileSync(sample)).sort();
    assert.deepEqual(findings, [
      'carries relation key "backlinks"',
      'carries relation key "outgoing"',
      'mentions graph-manifest.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  assert.deepEqual(
    legacyNamed([
      'content-index.json',
      'notes/deep/graph-manifest.json',
      'tags.json',
      'notes/deep/memberships.json',
      'index.html',
    ]),
    ['content-index.json', 'notes/deep/graph-manifest.json', 'tags.json', 'notes/deep/memberships.json'],
    'the name predicate missed a legacy name outside the output root',
  );
  assert.deepEqual(legacyNamed(['index.html', 'pagefind/pagefind-entry.json']), []);
});

/**
 * The positive control for the inventory: if either named payload reappeared
 * at the output root, the exact inventory would refuse it by count, would keep
 * the path off the public stream, and would name it in the private detail.
 */
test('the inventory gate refuses a planted legacy payload by count, with the name only in private detail', () => {
  const root = copyDist();
  try {
    assert.ok(
      assertOutputInventory(root, ARTIFACT) > 0,
      'the untouched copy was refused, so the refusals below would not be the plants',
    );
    const plants = [
      {
        path: 'content-index.json',
        payload: { entries: [], outgoing: { 'notes/a': ['notes/b'] }, backlinks: { 'notes/a': [] } },
      },
      { path: 'graph-manifest.json', payload: { nodes: [], edges: [] } },
    ];
    for (const plant of plants) {
      const path = join(root, plant.path);
      writeFileSync(path, JSON.stringify(plant.payload), 'utf8');
      const error = mismatch(root);
      assert.match(error.message, /1 unexpected, 0 missing, 0 altered/);
      assert.ok(!error.message.includes(plant.path), 'public inventory message disclosed the planted name');
      assert.ok(error.detail.includes(plant.path), 'private inventory detail omitted the planted name');
      rmSync(path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
