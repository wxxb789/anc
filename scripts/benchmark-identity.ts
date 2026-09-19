import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** A path-framed digest over one deterministic set of regular files. */
export interface FileTreeIdentity {
  sha256: string;
  files: number;
  scope: string;
  method: string;
}

/** The repository state that can influence a benchmark process or its builds. */
export interface RepositoryIdentity extends FileTreeIdentity {
  gitHead: string | null;
  worktreeDirty: boolean;
}

export class BenchmarkIdentityDriftError extends Error {
  readonly boundary: string;

  constructor(boundary: string) {
    super(`benchmark identity drift detected at ${boundary}`);
    this.name = 'BenchmarkIdentityDriftError';
    this.boundary = boundary;
  }
}

export class BenchmarkIdentityDirtyError extends Error {
  constructor() {
    super('benchmark requires a clean repository identity before workloads');
    this.name = 'BenchmarkIdentityDirtyError';
  }
}

const IDENTITY_METHOD =
  'sha256(path byte length + path bytes + file byte length + file bytes), regular files sorted by UTF-8 path bytes';
const IDENTITY_SCOPE =
  'tracked files and nonignored untracked regular files under the repository root';

function git(directory: string, args: readonly string[]): Buffer {
  const result = spawnSync('git', ['-c', 'core.excludesFile=', ...args], {
    cwd: directory,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error('unable to collect benchmark repository identity');
  }
  return result.stdout;
}

function gitHead(directory: string): string | null {
  const result = spawnSync('git', ['-c', 'core.excludesFile=', 'rev-parse', '--verify', 'HEAD'], {
    cwd: directory,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error !== undefined) return null;
  const value = result.stdout.toString('utf8').trim();
  return value === '' ? null : value;
}

function worktreeDirty(directory: string): boolean {
  return git(directory, ['status', '--porcelain=v1', '--untracked-files=all']).byteLength > 0;
}

/** Git's NUL-delimited path list, filtered to regular files that exist now. */
function repositoryFiles(directory: string): string[] {
  const output = git(directory, ['ls-files', '--cached', '--others', '--exclude-standard', '--full-name', '-z']);
  const paths = new Set<string>();
  for (const entry of output.toString('utf8').split('\0')) {
    if (entry === '') continue;
    const path = entry.replaceAll('\\', '/');
    try {
      if (lstatSync(resolve(directory, path)).isFile()) paths.add(path);
    } catch {
      // A deleted tracked file is absent from the regular-file set and therefore
      // changes the digest relative to the committed tree.
    }
  }
  return [...paths].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

function digestFiles(directory: string, paths: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of paths) {
    const pathBytes = Buffer.from(path, 'utf8');
    const contents = readFileSync(resolve(directory, path));
    hash.update(`${pathBytes.byteLength}:`, 'utf8');
    hash.update(pathBytes);
    hash.update(`${contents.byteLength}:`, 'utf8');
    hash.update(contents);
  }
  return hash.digest('hex');
}

/**
 * Identify the repository bytes that are available to the benchmark and its
 * spawned CLI builds. The path set is Git-defined, while the digest is over
 * the bytes on disk so dirty tracked files and nonignored untracked helpers are
 * part of the identity.
 */
export function repositoryIdentity(directory: string): RepositoryIdentity {
  const root = resolve(directory);
  const paths = repositoryFiles(root);
  return {
    sha256: digestFiles(root, paths),
    files: paths.length,
    scope: IDENTITY_SCOPE,
    method: IDENTITY_METHOD,
    gitHead: gitHead(root),
    worktreeDirty: worktreeDirty(root),
  };
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Resolve the private report directory through Git's worktree-aware path rules. */
export function benchmarkReportDirectory(repositoryRoot: string): string {
  const root = resolve(repositoryRoot);
  const result = spawnSync('git', ['rev-parse', '--git-path', 'publish-report'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const path = result.status === 0 && result.error === undefined ? result.stdout.trim() : '';
  return path === '' ? join(root, '.publish-report') : resolve(root, path);
}

/** Goal-qualified workload matrices must start from identified clean bytes. */
export function assertRepositoryIdentityClean(identity: RepositoryIdentity): RepositoryIdentity {
  if (identity.worktreeDirty) throw new BenchmarkIdentityDirtyError();
  return identity;
}

function sameIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.files === right.files &&
    left.gitHead === right.gitHead &&
    left.worktreeDirty === right.worktreeDirty
  );
}

/** Re-read the tree at a material boundary and fail without exposing paths. */
export function assertRepositoryIdentityStable(
  expected: RepositoryIdentity,
  directory: string,
  boundary: string,
): RepositoryIdentity {
  const observed = repositoryIdentity(directory);
  if (!sameIdentity(expected, observed)) throw new BenchmarkIdentityDriftError(boundary);
  return observed;
}
