/**
 * Stage the pinned SQLite browser runtime into the private build workspace.
 *
 * The package is **not** bundled by Vite: bundling it inlined its Emscripten glue
 * into the Worker chunk, which both mixed a third-party runtime into ANC's own
 * provenance and made the residue scan read the library's `[[` and `file://`
 * strings as findings. Instead the package's browser entry and its WASM are
 * copied verbatim under `/wasm/`, and the Worker imports the entry by URL at
 * runtime (`import(/* @vite-ignore *\/ …)`), so it stays external and same-origin.
 *
 * The WASM is digest-named and the Worker verifies the bytes it downloads; the
 * entry keeps its stable name because the package resolves `sqlite3.wasm`
 * relative to itself, and `locateFile` redirects that to the hashed copy.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASM_DIRECTORY, wasmRoute, type WasmBinding } from '../src/lib/wasm-asset.ts';
import { snapshotWorkspace } from '../src/lib/snapshot-reader.ts';

const require = createRequire(import.meta.url);

/** The package's browser ESM entry, copied under a stable public name. */
export const WASM_MODULE_NAME = 'sqlite-wasm.js';

/** Members copied verbatim beside the entry, keeping the package's own names. */
const STABLE_MEMBERS = ['sqlite3-worker1.mjs', 'sqlite3-opfs-async-proxy.js'] as const;

export interface StagedWasm extends WasmBinding {
  /** Public-relative members the output inventory admits. */
  members: string[];
  /** Same-origin URL of the copied browser entry. */
  moduleUrl: string;
  /** Size of the WASM binary in bytes. */
  size: number;
}

function packageDist(): string {
  const manifest = require.resolve('@sqlite.org/sqlite-wasm/package.json');
  return join(dirname(manifest), 'dist');
}

/**
 * Resolve, hash, and stage the browser runtime.
 *
 * @param workspace Absolute private directory. Defaults to `SNAPSHOT_WORKSPACE`.
 */
export function buildWasm(workspace: string = snapshotWorkspace()): StagedWasm {
  const dist = packageDist();
  const wasmBytes = readFileSync(join(dist, 'sqlite3.wasm'));
  const digest = createHash('sha256').update(wasmBytes).digest('hex');

  const staging = resolve(workspace, WASM_DIRECTORY);
  mkdirSync(staging, { recursive: true });
  copyFileSync(join(dist, 'index.mjs'), resolve(staging, WASM_MODULE_NAME));
  for (const member of STABLE_MEMBERS) copyFileSync(join(dist, member), resolve(staging, member));
  const wasmName = `sqlite3.${digest}.wasm`;
  copyFileSync(join(dist, 'sqlite3.wasm'), resolve(staging, wasmName));

  const binding = {
    moduleUrl: `/${WASM_DIRECTORY}/${WASM_MODULE_NAME}`,
    url: wasmRoute(digest),
    digest,
    members: [`${WASM_DIRECTORY}/${WASM_MODULE_NAME}`, ...STABLE_MEMBERS.map((m) => `${WASM_DIRECTORY}/${m}`), `${WASM_DIRECTORY}/${wasmName}`],
    size: wasmBytes.length,
  };
  writeFileSync(
    resolve(workspace, 'wasm.json'),
    `${JSON.stringify(
      { moduleUrl: binding.moduleUrl, url: binding.url, digest: binding.digest, members: binding.members },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return binding;
}

function main(): number {
  try {
    const staged = buildWasm();
    console.log(`wasm ok: bytes=${staged.size} sha256=${staged.digest} members=${staged.members.length}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
