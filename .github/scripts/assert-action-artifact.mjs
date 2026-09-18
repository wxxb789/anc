#!/usr/bin/env node
/**
 * Assert the artifact the Action-parity workflow just produced.
 *
 * The workflow's build step is the shipped composite action and nothing else;
 * this script only reads what it wrote. It re-derives the properties the
 * release gates promise rather than trusting the action's exit status: the
 * reviewed public set is exactly the snapshot's nodes, the snapshot's filename
 * digest is the digest of its bytes, the runtime assets are present, the
 * private report recorded both exclusion kinds, and no withheld body reached
 * any published file in raw or gzip-inflated form.
 *
 * It runs every check and exits non-zero if any failed, printing every failure,
 * so one run reports all of them rather than only the first.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { SNAPSHOT_FILE_PATTERN } from '../../src/lib/snapshot.ts';
import { DatabaseSync } from '../../src/lib/sqlite.ts';
import { WASM_MODULE_NAME, wasmMemberName } from '../../src/lib/wasm-asset.ts';
import { isGzip } from '../../scripts/snapshot-rows.ts';

const root = resolve(process.argv[2] ?? process.cwd());
const dist = join(root, 'dist');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function read(relative) {
  try {
    return readFileSync(join(dist, relative), 'utf8');
  } catch {
    failures.push(`dist/${relative} is missing`);
    return '';
  }
}

function entries(relative) {
  try {
    return readdirSync(join(dist, relative));
  } catch {
    failures.push(`dist/${relative}/ is missing`);
    return [];
  }
}

function filesUnder(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

/** One `_headers` document's `Content-Security-Policy` value. */
function cspOf(text) {
  return /^\s*Content-Security-Policy:\s*(.+)$/m.exec(text)?.[1] ?? '';
}

// --- The reviewed set and the routes it produced -------------------------

const ledgerPath = join(root, '.publish-set.json');
let ledger = { version: 1, slugs: [] };
try {
  ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
} catch (error) {
  failures.push('.publish-set.json is missing or unreadable: ' + String(error));
}
check(ledger.version === 1, '.publish-set.json is not version 1');
check(Array.isArray(ledger.slugs), '.publish-set.json carries no slug array');
const reviewed = [...(ledger.slugs ?? [])].sort();
check(
  JSON.stringify(reviewed) === JSON.stringify(['second', 'welcome']),
  `the reviewed set is not the two published notes: ${JSON.stringify(reviewed)}`,
);

const welcome = read('notes/welcome/index.html');
const second = read('notes/second/index.html');
check(welcome.includes('PARITY-PUBLISHED-WELCOME-BODY'), 'the welcome note body did not reach its page');
check(second.includes('PARITY-PUBLISHED-SECOND-BODY'), 'the second note body did not reach its page');
check(welcome.includes('href="/notes/second/"'), 'the published wikilink did not become a route');
check(welcome.includes('href="/private/"'), 'the withheld wikilink is not the live /private/ anchor');
check(welcome.includes('href="/tags/garden/"'), 'the note did not link its tag route');

const headers = read('_headers');
check(
  cspOf(headers).includes("script-src 'self' 'wasm-unsafe-eval'"),
  'dist/_headers does not carry the shipped CSP with its WASM allowance',
);

// --- The snapshot is the reviewed set, bound by its own bytes ------------

const snapshotNames = entries('data').filter((name) => SNAPSHOT_FILE_PATTERN.test(name));
check(snapshotNames.length === 1, `dist/data carries ${snapshotNames.length} snapshots, not exactly one`);
if (snapshotNames.length === 1) {
  const name = snapshotNames[0];
  const bytes = readFileSync(join(dist, 'data', name));
  const digest = createHash('sha256').update(bytes).digest('hex');
  check(SNAPSHOT_FILE_PATTERN.exec(name)?.[1] === digest, 'the snapshot filename is not the digest of its bytes');
  const database = new DatabaseSync(join(dist, 'data', name), { readOnly: true });
  try {
    const slugs = database
      .prepare('SELECT slug FROM nodes ORDER BY slug')
      .all()
      .map((row) => row.slug);
    check(
      JSON.stringify(slugs) === JSON.stringify(reviewed),
      `the snapshot nodes are not the reviewed set: ${JSON.stringify(slugs)}`,
    );
  } finally {
    database.close();
  }
}

// --- The runtime assets the browser binds to ------------------------------

const wasmNames = entries('wasm');
check(wasmNames.includes(WASM_MODULE_NAME), 'dist/wasm carries no stable SQLite browser entry');
const wasmMember = wasmNames.find((name) => /^sqlite3\.[0-9a-f]{64}\.wasm$/.test(name));
check(wasmMember !== undefined, 'dist/wasm carries no digest-named WASM member');
if (wasmMember !== undefined) {
  const digest = createHash('sha256').update(readFileSync(join(dist, 'wasm', wasmMember))).digest('hex');
  check(wasmMember === wasmMemberName(digest), 'the WASM member name is not the digest of its bytes');
}
check(
  entries('_astro').some((name) => /^snapshot-worker-[\w-]+\.js$/.test(name)),
  'dist/_astro carries no snapshot Worker chunk',
);

// --- The private report recorded both exclusion kinds ---------------------

let reportPath = '.git/publish-report/content-report.json';
try {
  reportPath = execFileSync('git', ['rev-parse', '--git-path', 'publish-report/content-report.json'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
} catch (error) {
  failures.push('the workspace is not a git repository: ' + String(error));
}
let report = { status: 'missing', dropped: [] };
try {
  report = JSON.parse(readFileSync(resolve(root, reportPath), 'utf8'));
} catch (error) {
  failures.push('the private report is missing or unreadable: ' + String(error));
}
check(report.status === 'complete', `the private report is ${JSON.stringify(report.status)}, not complete`);
const dropped = new Map((report.dropped ?? []).map((item) => [item.path, item.reason]));
check(dropped.get('private.md') === 'excluded-by-frontmatter', 'the report lost the frontmatter exclusion');
check(dropped.get('drafts/roadmap.md') === 'excluded-by-pattern', 'the report lost the pattern exclusion');

// --- No withheld body reached any published file, raw or inflated ---------

const forbidden = ['PARITY-PRIVATE-BODY-MUST-NOT-SHIP', 'PARITY-DRAFT-BODY-MUST-NOT-SHIP'];
let publishedSeen = false;
let distFiles = [];
try {
  distFiles = filesUnder(dist);
} catch {
  failures.push('dist/ is missing');
}
for (const file of distFiles) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  // Byte-level, not decoded text: the markers are ASCII, and the WASM and
  // SQLite members are not UTF-8; decoding them first only made large copies.
  if (bytes.includes('PARITY-PUBLISHED-')) publishedSeen = true;
  const payloads = [bytes];
  if (isGzip(bytes)) {
    try {
      payloads.push(gunzipSync(bytes));
    } catch {
      // An unreadable gzip member with no forbidden marker in its raw bytes is
      // not a disclosure; the release gate owns corrupt-member refusal.
    }
  }
  for (const marker of forbidden) {
    check(!payloads.some((payload) => payload.includes(marker)), `${file.slice(root.length + 1)} carries ${marker}`);
  }
}
check(publishedSeen, 'the published-body positive control is absent, so the absence checks prove nothing');

if (failures.length > 0) {
  console.error('action-parity artifact check failed:');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('action-parity artifact ok: routes, snapshot, runtime assets, report, and absence checks');
