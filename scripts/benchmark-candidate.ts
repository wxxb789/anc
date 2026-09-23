/**
 * Candidate identity: the exact CLI, installed package, runtime dependency
 * closure, lockfile, and tarball a benchmark measured, plus the cheap state
 * and full content checks that detect drift at each material boundary.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fixtureIdentity, fixtureStateIdentity } from './benchmark-files.ts';
import { ROOT } from './benchmark-host.ts';
import {
  assertRepositoryIdentityStable,
  BenchmarkIdentityDriftError,
  sha256File,
  type RepositoryIdentity,
} from './benchmark-identity.ts';
import {
  candidatePackageContext,
  expectedTarballBasename,
  findLockfile,
  findTarball,
  isPackageGeneratedPath,
  runtimeDependencyClosure,
  validateCandidateTarball,
} from './benchmark-package.ts';

interface CandidateFileState {
  bytes: number;
  mtimeNs: string;
  scope: string;
  method: string;
}

interface CandidateFileIdentity {
  basename: string;
  sha256: string;
  bytes: number;
  state: CandidateFileState;
}

const CANDIDATE_FILE_STATE_SCOPE = 'one candidate file; state covers byte size and high-resolution mtimeNs, but not file bytes';
const CANDIDATE_FILE_STATE_METHOD =
  'stat(byte size + high-resolution mtimeNs); a same-size content mutation whose mtime is restored may evade this change detector, so the final content SHA-256 remains authoritative';

export interface CandidateIdentity {
  repositoryHead: { commit: string | null; scope: string };
  repositoryTree: RepositoryIdentity;
  cli: { basename: string; bytes: number; sha256: string; scope: string; state: CandidateFileState };
  installedPackage: { name: string; version: string } | null;
  installedPackageTree: {
    sha256: string;
    stateSha256: string;
    files: number;
    scope: string;
    method: string;
    stateScope: string;
    stateMethod: string;
  } | null;
  runtimeDependencyTree: {
    sha256: string;
    stateSha256: string;
    files: number;
    scope: string;
    method: string;
    stateScope: string;
    stateMethod: string;
  } | null;
  lockfile: CandidateFileIdentity | null;
  tarball: CandidateFileIdentity | null;
  runtime: {
    node: string;
    packageManager: { name: string; version: string } | null;
  };
}

type CandidateIdentityCheck = 'state' | 'full';


function runtimePackageManager(): { name: string; version: string } | null {
  const userAgent = process.env['npm_config_user_agent'];
  const fromUserAgent = userAgent?.match(/(?:^|\s)([a-z][a-z0-9_-]*)\/([^\s]+)/i);
  if (fromUserAgent !== undefined && fromUserAgent !== null) {
    return { name: fromUserAgent[1]!, version: fromUserAgent[2]! };
  }
  for (const name of ['pnpm', 'npm', 'yarn']) {
    const result = spawnSync(name, ['--version'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status === 0 && result.error === undefined) {
      const version = result.stdout.trim();
      if (version !== '') return { name, version };
    }
  }
  try {
    const declared = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { packageManager?: unknown };
    if (typeof declared.packageManager === 'string') {
      const separator = declared.packageManager.lastIndexOf('@');
      if (separator > 0) {
        return {
          name: declared.packageManager.slice(0, separator),
          version: declared.packageManager.slice(separator + 1),
        };
      }
    }
  } catch {
    // Keep the runtime identity explicit as unknown when no package manager can be resolved.
  }
  return null;
}

function candidateFileIdentity(file: string): CandidateFileIdentity {
  const state = candidateFileState(file);
  return {
    basename: basename(file),
    bytes: state.bytes,
    sha256: sha256File(file),
    state,
  };
}

function candidateFileState(file: string): CandidateFileState {
  const fileState = statSync(file, { bigint: true });
  return {
    bytes: Number(fileState.size),
    mtimeNs: fileState.mtimeNs.toString(),
    scope: CANDIDATE_FILE_STATE_SCOPE,
    method: CANDIDATE_FILE_STATE_METHOD,
  };
}

export function candidateIdentity(cliPath: string, repository: RepositoryIdentity): CandidateIdentity {
  const packageContext = candidatePackageContext(cliPath);
  let installedPackageTree: CandidateIdentity['installedPackageTree'] = null;
  if (packageContext.installedPackage !== null) {
    const tree = fixtureIdentity(packageContext.candidatePackageDirectory, isPackageGeneratedPath);
    const state = fixtureStateIdentity(packageContext.candidatePackageDirectory, isPackageGeneratedPath);
    installedPackageTree = {
      sha256: tree.sha256,
      stateSha256: state.stateSha256,
      files: tree.files,
      scope:
        'installed package payload, recursively hashed regular files; dependency node_modules and package-local build-generated .astro/.vite/.cache directories excluded',
      method: tree.method,
      stateScope: state.stateScope,
      stateMethod: state.stateMethod,
    };
  }
  const runtimeTree = runtimeDependencyClosure(packageContext.candidatePackageDirectory, packageContext.packageRoot);
  const runtimeDependencyTree: CandidateIdentity['runtimeDependencyTree'] = {
    sha256: runtimeTree.sha256,
    stateSha256: runtimeTree.stateSha256,
    files: runtimeTree.files,
    scope: runtimeTree.scope,
    method: runtimeTree.method,
    stateScope: runtimeTree.stateScope,
    stateMethod: runtimeTree.stateMethod,
  };
  const lockfilePath = findLockfile(packageContext.packageRoot);
  const tarballPath = findTarball(
    packageContext.packageRoot,
    packageContext.installedPackage?.name ?? null,
    packageContext.installedPackage?.version ?? null,
  );
  if (packageContext.installedPackage !== null) {
    if (tarballPath === null) {
      throw new Error(
        `packaged candidate requires tarball ${expectedTarballBasename(packageContext.installedPackage.name, packageContext.installedPackage.version)}`,
      );
    }
    validateCandidateTarball(tarballPath, packageContext.installedPackage, packageContext.candidatePackageDirectory);
  }
  return {
    repositoryHead: {
      commit: repository.gitHead,
      scope: 'benchmark harness repository HEAD; paired with repositoryTree for the exact on-disk candidate bytes',
    },
    repositoryTree: repository,
    cli: {
      ...candidateFileIdentity(cliPath),
      scope: 'sha256 of the --cli executable file bytes only',
    },
    installedPackage: packageContext.installedPackage,
    installedPackageTree,
    runtimeDependencyTree,
    lockfile: lockfilePath === null ? null : candidateFileIdentity(lockfilePath),
    tarball: tarballPath === null ? null : candidateFileIdentity(tarballPath),
    runtime: {
      node: process.version,
      packageManager: runtimePackageManager(),
    },
  };
}

function candidateContentIdentity(candidate: CandidateIdentity): unknown {
  const fileContent = (file: CandidateFileIdentity | null): unknown =>
    file === null ? null : { basename: file.basename, bytes: file.bytes, sha256: file.sha256 };
  const treeContent = (
    tree: CandidateIdentity['installedPackageTree'] | CandidateIdentity['runtimeDependencyTree'],
  ): unknown =>
    tree === null
      ? null
      : {
          sha256: tree.sha256,
          files: tree.files,
          scope: tree.scope,
          method: tree.method,
        };
  return {
    repositoryHead: candidate.repositoryHead,
    repositoryTree: candidate.repositoryTree,
    cli: {
      basename: candidate.cli.basename,
      bytes: candidate.cli.bytes,
      sha256: candidate.cli.sha256,
      scope: candidate.cli.scope,
    },
    installedPackage: candidate.installedPackage,
    installedPackageTree: treeContent(candidate.installedPackageTree),
    runtimeDependencyTree: treeContent(candidate.runtimeDependencyTree),
    lockfile: fileContent(candidate.lockfile),
    tarball: fileContent(candidate.tarball),
    runtime: candidate.runtime,
  };
}

function cheapRepositoryState(): Pick<RepositoryIdentity, 'gitHead' | 'worktreeDirty'> | null {
  const head = spawnSync('git', ['-c', 'core.excludesFile=', 'rev-parse', '--verify', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const status = spawnSync('git', ['-c', 'core.excludesFile=', 'status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (head.status !== 0 || head.error !== undefined || status.status !== 0 || status.error !== undefined) return null;
  return {
    gitHead: head.stdout.trim() === '' ? null : head.stdout.trim(),
    worktreeDirty: status.stdout.trim() !== '',
  };
}

function assertCandidateIdentityStateStable(expected: CandidateIdentity, cliPath: string, boundary: string): void {
  const repository = cheapRepositoryState();
  if (
    repository === null ||
    repository.gitHead !== expected.repositoryTree.gitHead ||
    repository.worktreeDirty !== expected.repositoryTree.worktreeDirty
  ) {
    throw new BenchmarkIdentityDriftError(boundary);
  }

  const packageContext = candidatePackageContext(cliPath);
  if (JSON.stringify(packageContext.installedPackage) !== JSON.stringify(expected.installedPackage)) {
    throw new BenchmarkIdentityDriftError(boundary);
  }

  const runtimeTree = runtimeDependencyClosure(packageContext.candidatePackageDirectory, packageContext.packageRoot, false);
  const expectedRuntimeTree = expected.runtimeDependencyTree;
  if (
    expectedRuntimeTree === null ||
    runtimeTree.stateSha256 !== expectedRuntimeTree.stateSha256 ||
    runtimeTree.files !== expectedRuntimeTree.files
  ) {
    throw new BenchmarkIdentityDriftError(boundary);
  }

  if (expected.installedPackageTree === null) {
    if (packageContext.installedPackage !== null) throw new BenchmarkIdentityDriftError(boundary);
  } else {
    if (packageContext.installedPackage === null) throw new BenchmarkIdentityDriftError(boundary);
    const state = fixtureStateIdentity(packageContext.candidatePackageDirectory, isPackageGeneratedPath);
    if (
      state.stateSha256 !== expected.installedPackageTree.stateSha256 ||
      state.files !== expected.installedPackageTree.files
    ) {
      throw new BenchmarkIdentityDriftError(boundary);
    }
  }

  const currentCliState = candidateFileState(cliPath);
  if (
    currentCliState.bytes !== expected.cli.state.bytes ||
    currentCliState.mtimeNs !== expected.cli.state.mtimeNs
  ) {
    throw new BenchmarkIdentityDriftError(boundary);
  }

  const compareFileState = (expectedFile: CandidateFileIdentity | null, currentPath: string | null): void => {
    if (expectedFile === null) {
      if (currentPath !== null) throw new BenchmarkIdentityDriftError(boundary);
      return;
    }
    if (currentPath === null) throw new BenchmarkIdentityDriftError(boundary);
    const state = candidateFileState(currentPath);
    if (
      basename(currentPath) !== expectedFile.basename ||
      state.bytes !== expectedFile.state.bytes ||
      state.mtimeNs !== expectedFile.state.mtimeNs
    ) {
      throw new BenchmarkIdentityDriftError(boundary);
    }
  };
  const lockfilePath = findLockfile(packageContext.packageRoot);
  const tarballPath = findTarball(
    packageContext.packageRoot,
    packageContext.installedPackage?.name ?? null,
    packageContext.installedPackage?.version ?? null,
  );
  compareFileState(expected.lockfile, lockfilePath);
  compareFileState(expected.tarball, tarballPath);
}

export function assertCandidateIdentityStable(
  expected: CandidateIdentity,
  cliPath: string,
  boundary: string,
  check: CandidateIdentityCheck = 'full',
): CandidateIdentity {
  if (check === 'state') {
    assertCandidateIdentityStateStable(expected, cliPath, boundary);
    return expected;
  }
  const observedRepository = assertRepositoryIdentityStable(expected.repositoryTree, ROOT, boundary);
  const observed = candidateIdentity(cliPath, observedRepository);
  if (JSON.stringify(candidateContentIdentity(expected)) !== JSON.stringify(candidateContentIdentity(observed))) {
    throw new BenchmarkIdentityDriftError(boundary);
  }
  return observed;
}

/** Refuse a `--cli` that does not exist, is not a file (when required), or is an archive. */
export function assertCandidateCliPath(cliPath: string, requireFile = false): void {
  if (!existsSync(cliPath)) throw new Error(`--cli does not exist: ${basename(cliPath)}`);
  if (requireFile && !statSync(cliPath).isFile()) throw new Error(`--cli is not a file: ${basename(cliPath)}`);
  if (extname(cliPath).toLowerCase() === '.tgz') {
    throw new Error('--cli must point to an executable CLI, not a .tgz package archive');
  }
}
