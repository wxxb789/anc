/**
 * Copy the finalized snapshot into the built output under its digest name.
 *
 * Runs after Astro has emptied and rewritten the output directory, so a DB built
 * before the render is not deleted by the render. The copied bytes are re-hashed
 * against the binding: the public filename is a claim about the file, and this is
 * where the build proves it.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotFileName } from '../src/lib/snapshot.ts';
import { readBuildBinding, snapshotWorkspace } from '../src/lib/snapshot-reader.ts';

/**
 * @param outputDirectory Directory to copy into, absolute or cwd-relative.
 * @returns The same-origin URL the copied file is bound to.
 * @throws when no binding exists or the copied bytes do not match the digest.
 */
export function copySnapshotToOutput(outputDirectory: string, workspace = snapshotWorkspace()): string {
  const binding = readBuildBinding(workspace);
  if (binding === undefined) {
    throw new Error('no snapshot binding: run the snapshot build before copying it into the output');
  }
  const source = resolve(workspace, 'snapshot.sqlite');
  const target = resolve(outputDirectory, snapshotFileName(binding.digest));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);

  const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
  if (digest !== binding.digest) {
    throw new Error('copied snapshot bytes do not match the digest in its bound URL');
  }
  return binding.url;
}

function main(): number {
  const output = process.argv[2] ?? 'dist';
  try {
    const url = copySnapshotToOutput(output);
    console.log(`snapshot bound: ${url}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
