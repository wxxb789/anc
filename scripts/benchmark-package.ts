/**
 * The installed candidate package around a `--cli` path: its manifest, its
 * runtime dependency closure, its lockfile, and the tarball it was installed
 * from.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fixtureIdentity, hashPart, walkFiles } from './benchmark-files.ts';
import { ROOT } from './benchmark-host.ts';

interface RuntimePackageManifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  bundledDependencies: string[];
}

interface RuntimePackageRecord {
  name: string;
  version: string;
  logicalPath: string;
  realPath: string;
}

interface RuntimeDependencyClosureIdentity {
  sha256: string;
  stateSha256: string;
  files: number;
  scope: string;
  method: string;
  stateScope: string;
  stateMethod: string;
}

const RUNTIME_DEPENDENCY_SCOPE =
  'installed runtime dependency closure rooted at the candidate package manifest; dependencies, optionalDependencies, and resolvable peerDependencies recursively included; distinct real package roots identified by package name/version/logical path; devDependencies excluded; node_modules and top-level .vite/.cache package paths excluded from file contents';
const RUNTIME_DEPENDENCY_METHOD =
  'sha256(runtime-dependency-closure-v1 + package name/version/logical path + regular package file relative path byte length + file byte length + file bytes), packages and files sorted by UTF-8 path bytes';
const RUNTIME_DEPENDENCY_STATE_SCOPE =
  'the same installed runtime dependency closure and package/file exclusions as the content digest; state covers package name/version/logical path plus every regular package file relative path, byte size, and high-resolution mtimeNs, but not file bytes';
const RUNTIME_DEPENDENCY_STATE_METHOD =
  'sha256(runtime-dependency-closure-state-v1 + package name/version/logical path + regular package file relative path byte length + file byte size + high-resolution mtimeNs), packages and files sorted by UTF-8 path bytes; a same-size content mutation whose mtime is restored may evade this change detector, so the final content SHA-256 remains authoritative';

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version === 'string') result[name] = version;
  }
  return result;
}

function runtimePackageManifest(directory: string, fallbackName?: string): RuntimePackageManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>;
    const name = typeof parsed['name'] === 'string' ? parsed['name'] : fallbackName;
    if (name === undefined) return null;
    return {
      name,
      version: typeof parsed['version'] === 'string' ? parsed['version'] : 'unknown',
      dependencies: stringMap(parsed['dependencies']),
      optionalDependencies: stringMap(parsed['optionalDependencies']),
      peerDependencies: stringMap(parsed['peerDependencies']),
      bundledDependencies: Array.isArray(parsed['bundledDependencies'])
        ? parsed['bundledDependencies'].filter((dependency): dependency is string => typeof dependency === 'string')
        : Array.isArray(parsed['bundleDependencies'])
          ? parsed['bundleDependencies'].filter((dependency): dependency is string => typeof dependency === 'string')
          : [],
    };
  } catch {
    return null;
  }
}

function runtimeDependencyNames(manifest: RuntimePackageManifest): { name: string; required: boolean }[] {
  const required = new Set([...Object.keys(manifest.dependencies), ...manifest.bundledDependencies]);
  const names = new Set([...required, ...Object.keys(manifest.optionalDependencies), ...Object.keys(manifest.peerDependencies)]);
  return [...names]
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
    .map((name) => ({ name, required: required.has(name) }));
}

/** Resolve one package name using Node's nearest-node_modules lookup. */
function resolveRuntimePackage(directory: string, name: string): string | null {
  let current = directory;
  while (true) {
    const candidate = join(current, 'node_modules', name);
    try {
      if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'package.json'))) return candidate;
    } catch {
      // A broken optional link is treated as an absent package.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function packageFiles(directory: string): string[] {
  const found: string[] = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || (prefix === '' && (entry.name === '.vite' || entry.name === '.cache'))) {
          continue;
        }
        visit(path, relativePath);
      } else if (entry.isFile()) {
        found.push(relativePath);
      }
    }
  };
  visit(directory, '');
  return found.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

function runtimePackagePath(installationRoot: string, directory: string): string {
  const path = relative(installationRoot, directory).split(sep).join('/');
  return path === '' ? '.' : path;
}

/** Hash only the installed runtime closure, without recursively hashing node_modules as package data. */
export function runtimeDependencyClosure(
  candidateDirectory: string,
  installationRoot: string,
  includeContent = true,
): RuntimeDependencyClosureIdentity {
  const rootManifest = runtimePackageManifest(candidateDirectory);
  if (rootManifest === null) throw new Error(`candidate package manifest is unreadable: ${basename(candidateDirectory)}`);

  const rootRealPath = realpathSync(candidateDirectory);
  const packages = new Map<string, RuntimePackageRecord>();
  const visited = new Set<string>();
  const visit = (directory: string): void => {
    let realPath: string;
    try {
      realPath = realpathSync(directory);
    } catch {
      return;
    }
    const realKey = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
    if (visited.has(realKey)) return;
    visited.add(realKey);
    const manifest = runtimePackageManifest(realPath);
    if (manifest === null) return;

    for (const { name: dependencyName, required } of runtimeDependencyNames(manifest)) {
      const logicalDirectory = resolveRuntimePackage(realPath, dependencyName);
      if (logicalDirectory === null) {
        if (required) throw new Error(`required runtime dependency is missing: ${dependencyName}`);
        continue;
      }
      let dependencyRealPath: string;
      try {
        dependencyRealPath = realpathSync(logicalDirectory);
      } catch {
        if (required) throw new Error(`required runtime dependency cannot be resolved: ${dependencyName}`);
        continue;
      }
      const dependencyRealKey = process.platform === 'win32' ? dependencyRealPath.toLowerCase() : dependencyRealPath;
      if (dependencyRealKey === (process.platform === 'win32' ? rootRealPath.toLowerCase() : rootRealPath)) continue;
      const dependencyManifest = runtimePackageManifest(dependencyRealPath, dependencyName);
      if (dependencyManifest === null) throw new Error(`runtime dependency manifest is unreadable: ${dependencyName}`);
      const logicalPath = runtimePackagePath(installationRoot, logicalDirectory);
      const existing = packages.get(dependencyRealKey);
      if (existing === undefined || logicalPath < existing.logicalPath) {
        packages.set(dependencyRealKey, {
          name: dependencyManifest.name,
          version: dependencyManifest.version,
          logicalPath,
          realPath: dependencyRealPath,
        });
      }
      visit(dependencyRealPath);
    }
  };
  visit(candidateDirectory);

  const orderedPackages = [...packages.values()].sort((left, right) => {
    const leftKey = `${left.name}\0${left.version}\0${left.logicalPath}`;
    const rightKey = `${right.name}\0${right.version}\0${right.logicalPath}`;
    return Buffer.compare(Buffer.from(leftKey, 'utf8'), Buffer.from(rightKey, 'utf8'));
  });
  const contentHash = includeContent ? createHash('sha256') : null;
  if (contentHash !== null) hashPart(contentHash, 'runtime-dependency-closure-v1');
  const stateHash = createHash('sha256');
  hashPart(stateHash, 'runtime-dependency-closure-state-v1');
  let files = 0;
  for (const packageRecord of orderedPackages) {
    if (contentHash !== null) {
      hashPart(contentHash, packageRecord.name);
      hashPart(contentHash, packageRecord.version);
      hashPart(contentHash, packageRecord.logicalPath);
    }
    hashPart(stateHash, packageRecord.name);
    hashPart(stateHash, packageRecord.version);
    hashPart(stateHash, packageRecord.logicalPath);
    for (const relativePath of packageFiles(packageRecord.realPath)) {
      const file = join(packageRecord.realPath, relativePath);
      const fileState = statSync(file, { bigint: true });
      hashPart(stateHash, relativePath);
      hashPart(stateHash, fileState.size.toString());
      hashPart(stateHash, fileState.mtimeNs.toString());
      if (contentHash !== null) {
        const contents = readFileSync(file);
        hashPart(contentHash, relativePath);
        hashPart(contentHash, contents);
      }
      files += 1;
    }
  }
  return {
    sha256: contentHash === null ? '' : contentHash.digest('hex'),
    stateSha256: stateHash.digest('hex'),
    files,
    scope: RUNTIME_DEPENDENCY_SCOPE,
    method: RUNTIME_DEPENDENCY_METHOD,
    stateScope: RUNTIME_DEPENDENCY_STATE_SCOPE,
    stateMethod: RUNTIME_DEPENDENCY_STATE_METHOD,
  };
}

interface CandidatePackageContext {
  installedPackage: { name: string; version: string } | null;
  candidatePackageDirectory: string;
  packageRoot: string;
}


export function findLockfile(directory: string): string | null {
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const file = join(directory, name);
    if (existsSync(file)) return file;
  }
  return null;
}

interface TarballEntry {
  member: string;
  type: 'file' | 'directory';
}

interface TarballPayloadIdentity {
  sha256: string;
  files: number;
}

/**
 * Run `tar` over one archive supplied on stdin, in `cwd`.
 *
 * GNU tar reads an argument containing a colon as `host:path` and tries a
 * remote tape, so an absolute Windows path (`Q:\...`) fails under Git's tar,
 * for the archive and for `-C` alike. `--force-local` would fix GNU tar but
 * bsdtar rejects it; passing no path at all (`-f -`, extraction into `cwd`)
 * works under both.
 */
function tarOutput(
  tarball: string,
  args: readonly string[],
  encoding: BufferEncoding | undefined = 'utf8',
  cwd?: string,
): string | Buffer {
  const argv = [...args, '-f', '-'];
  const options = { cwd, input: readFileSync(tarball), maxBuffer: 256 * 1024 * 1024 };
  const result = encoding === undefined ? spawnSync('tar', argv, options) : spawnSync('tar', argv, { ...options, encoding });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('could not inspect candidate tarball');
  }
  return result.stdout;
}

function safeTarballMember(member: string): string | null {
  const normalized = member.replace(/\\/g, '/');
  if (!normalized.startsWith('package/')) throw new Error(`candidate tarball contains an unsafe member ${JSON.stringify(member)}`);
  const relativePath = normalized.slice('package/'.length);
  if (relativePath === '') return null;
  const parts = relativePath.replace(/\/$/, '').split('/');
  if (relativePath.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`candidate tarball contains an unsafe member ${JSON.stringify(member)}`);
  }
  if (relativePath.endsWith('/')) return null;
  return relativePath;
}

function tarballEntries(tarball: string): TarballEntry[] {
  const names = String(tarOutput(tarball, ['-tz']))
    .split(/\r?\n/)
    .filter((line) => line !== '');
  const details = String(tarOutput(tarball, ['-tvz']))
    .split(/\r?\n/)
    .filter((line) => line !== '');
  if (names.length !== details.length) throw new Error(`candidate tarball listing is inconsistent: ${basename(tarball)}`);
  return names.map((member, index) => {
    const type = details[index]?.[0];
    if (type === 'd') return { member, type: 'directory' };
    if (type !== '-') throw new Error(`candidate tarball contains unsupported member ${JSON.stringify(member)}`);
    return { member, type: 'file' };
  });
}

function tarballPayloadIdentity(tarball: string): { manifest: { name: string; version: string }; payload: TarballPayloadIdentity } {
  const entries = tarballEntries(tarball);
  const expectedFiles = new Set<string>();
  for (const entry of entries) {
    const relativePath = safeTarballMember(entry.member);
    if (entry.type !== 'file' || relativePath === null || isPackageGeneratedPath(relativePath)) continue;
    if (expectedFiles.has(relativePath)) {
      throw new Error(`candidate tarball contains duplicate member ${JSON.stringify(entry.member)}`);
    }
    expectedFiles.add(relativePath);
  }
  const extractionRoot = mkdtempSync(join(tmpdir(), 'anc-benchmark-tarball-'));
  try {
    tarOutput(tarball, ['-xz'], 'utf8', extractionRoot);
    const packageDirectory = join(extractionRoot, 'package');
    const actualFiles = walkFiles(packageDirectory)
      .map((file) => relative(packageDirectory, file).split(sep).join('/'))
      .filter((path) => !isPackageGeneratedPath(path))
      .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    const expected = [...expectedFiles].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    if (JSON.stringify(actualFiles) !== JSON.stringify(expected)) {
      throw new Error(`candidate tarball extraction does not match its validated member list: ${basename(tarball)}`);
    }
    let parsed: { name?: unknown; version?: unknown };
    try {
      parsed = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
    } catch {
      throw new Error(`candidate tarball package.json is unreadable: ${basename(tarball)}`);
    }
    if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
      throw new Error(`candidate tarball package.json has no name/version: ${basename(tarball)}`);
    }
    const payload = fixtureIdentity(packageDirectory, isPackageGeneratedPath);
    return { manifest: { name: parsed.name, version: parsed.version }, payload };
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export function expectedTarballBasename(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

export function validateCandidateTarball(
  tarball: string,
  installedPackage: { name: string; version: string },
  packageDirectory: string,
): void {
  const expectedBasename = expectedTarballBasename(installedPackage.name, installedPackage.version);
  if (basename(tarball) !== expectedBasename) {
    throw new Error(
      `candidate tarball basename ${JSON.stringify(basename(tarball))} does not match ${JSON.stringify(expectedBasename)}`,
    );
  }
  const inspected = tarballPayloadIdentity(tarball);
  if (inspected.manifest.name !== installedPackage.name || inspected.manifest.version !== installedPackage.version) {
    throw new Error(
      `candidate tarball package identity ${inspected.manifest.name}@${inspected.manifest.version} does not match ${installedPackage.name}@${installedPackage.version}`,
    );
  }
  const installed = fixtureIdentity(packageDirectory, isPackageGeneratedPath);
  if (inspected.payload.sha256 !== installed.sha256 || inspected.payload.files !== installed.files) {
    throw new Error(`candidate tarball payload does not match installed package ${installedPackage.name}@${installedPackage.version}`);
  }
}

export function findTarball(directory: string, packageName: string | null, version: string | null): string | null {
  const configured = process.env['ANC_BENCHMARK_TARBALL'];
  if (configured !== undefined) {
    const configuredPath = resolve(configured);
    if (!existsSync(configuredPath)) return null;
    if (!statSync(configuredPath).isFile()) throw new Error(`configured benchmark tarball is not a regular file: ${basename(configuredPath)}`);
    return configuredPath;
  }
  if (packageName === null || version === null || !existsSync(directory)) return null;
  const expected = expectedTarballBasename(packageName, version);
  const candidate = readdirSync(directory)
    .filter((name) => name === expected)
    .map((name) => join(directory, name))
    .find((file) => statSync(file).isFile());
  return candidate ?? null;
}

export function candidatePackageContext(cliPath: string): CandidatePackageContext {
  let installedPackage: CandidatePackageContext['installedPackage'] = null;
  let packageRoot = ROOT;
  let candidatePackageDirectory = ROOT;
  const normalizedCliPath = resolve(cliPath);
  const pathParts = normalizedCliPath.split(sep);
  if (pathParts.includes('node_modules')) {
    let directory = dirname(normalizedCliPath);
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        let parsed: { name?: unknown; version?: unknown };
        try {
          parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown };
        } catch {
          // A manifest that cannot be read leaves the version unknown.
          break;
        }
        if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
          installedPackage = { name: parsed.name, version: parsed.version };
          candidatePackageDirectory = directory;
          const packageParent = dirname(directory);
          const packageNodeModules = basename(packageParent).startsWith('@') ? dirname(packageParent) : packageParent;
          packageRoot = dirname(packageNodeModules);
        }
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return { installedPackage, candidatePackageDirectory, packageRoot };
}

export function isPackageGeneratedPath(path: string): boolean {
  return (
    /^(?:\.astro|\.vite|\.cache)(?:\/|$)/.test(path) ||
    /(?:^|\/)node_modules(?:\/|$)/.test(path)
  );
}

