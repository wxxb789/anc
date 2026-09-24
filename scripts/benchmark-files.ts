/** Deterministic regular-file walks and length-framed tree digests. */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  visit(root);
  return found;
}

export interface FixtureIdentity {
  sha256: string;
  files: number;
  method: string;
}

interface FixtureStateIdentity {
  stateSha256: string;
  files: number;
  stateScope: string;
  stateMethod: string;
}

/** SHA-256 over every regular file with length-framed paths and contents. */
export function fixtureIdentity(directory: string, ignore: (relativePath: string) => boolean = () => false): FixtureIdentity {
  const relativePaths = walkFiles(directory)
    .map((file) => relative(directory, file).split(sep).join('/'))
    .filter((path) => !ignore(path))
    .sort();
  const hash = createHash('sha256');
  for (const path of relativePaths) {
    const contents = readFileSync(join(directory, path));
    hash.update(`${Buffer.byteLength(path, 'utf8')}:`, 'utf8');
    hash.update(path, 'utf8');
    hash.update(`${contents.byteLength}:`, 'utf8');
    hash.update(contents);
  }
  return {
    sha256: hash.digest('hex'),
    files: relativePaths.length,
    method: 'sha256(path byte length + path bytes + file byte length + file bytes), regular files sorted by relative path',
  };
}

const FIXTURE_STATE_SCOPE =
  'the same regular-file tree and exclusions as the content digest; state covers each relative path, byte size, and high-resolution mtimeNs, but not file bytes';
const FIXTURE_STATE_METHOD =
  'sha256(fixture-state-v1 + regular file relative path byte length + file byte size + high-resolution mtimeNs), files sorted by UTF-8 path bytes; a same-size content mutation whose mtime is restored may evade this change detector, so the final content SHA-256 remains authoritative';

/** Read only directory entries and metadata for an intermediate identity check. */
export function fixtureStateIdentity(directory: string, ignore: (relativePath: string) => boolean = () => false): FixtureStateIdentity {
  const relativePaths = walkFiles(directory)
    .map((file) => relative(directory, file).split(sep).join('/'))
    .filter((path) => !ignore(path))
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  const hash = createHash('sha256');
  hashPart(hash, 'fixture-state-v1');
  for (const path of relativePaths) {
    const fileState = statSync(join(directory, path), { bigint: true });
    hashPart(hash, path);
    hashPart(hash, fileState.size.toString());
    hashPart(hash, fileState.mtimeNs.toString());
  }
  return {
    stateSha256: hash.digest('hex'),
    files: relativePaths.length,
    stateScope: FIXTURE_STATE_SCOPE,
    stateMethod: FIXTURE_STATE_METHOD,
  };
}

export function hashPart(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  hash.update(`${bytes.byteLength}:`, 'utf8');
  hash.update(bytes);
}
