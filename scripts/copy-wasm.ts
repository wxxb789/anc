/**
 * Copy the staged SQLite runtime into the built output under `/wasm/`.
 *
 * Mirrors `copy-snapshot.ts`: runs after Astro has rewritten the output, copies
 * every staged member, and re-hashes the WASM against the binding so the public
 * filename is proven about the published bytes.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWasmBinding, type WasmBinding } from '../src/lib/wasm-asset.ts';
import { snapshotWorkspace } from '../src/lib/snapshot-reader.ts';

/** Read the staged runtime binding, or `undefined` when this build staged none. */
export function readStagedWasm(workspace = snapshotWorkspace()): WasmBinding | undefined {
  try {
    return readWasmBinding(
      JSON.parse(readFileSync(resolve(workspace, 'wasm.json'), 'utf8')),
    );
  } catch {
    return undefined;
  }
}

/**
 * @returns The same-origin URL the copied WASM is bound to.
 * @throws when no binding exists or the copied bytes do not match the digest.
 */
export function copyWasmToOutput(outputDirectory: string, workspace = snapshotWorkspace()): string {
  const binding = readStagedWasm(workspace);
  if (binding === undefined) {
    throw new Error('no wasm binding: run the wasm build before copying it into the output');
  }
  const staging = resolve(workspace, 'wasm');
  for (const member of binding.members) {
    const name = member.split('/').at(-1)!;
    const target = resolve(outputDirectory, member);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(staging, name), target);
  }
  const digest = createHash('sha256').update(readFileSync(resolve(outputDirectory, binding.url.slice(1)))).digest('hex');
  if (digest !== binding.digest) {
    throw new Error('copied wasm bytes do not match the digest in their bound URL');
  }
  return binding.url;
}

function main(): number {
  const output = process.argv[2] ?? 'dist';
  try {
    console.log(`wasm bound: ${copyWasmToOutput(output)}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
