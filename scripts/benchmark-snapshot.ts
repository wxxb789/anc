/**
 * Transfer, startup, preview, query, and ordinary-reading measurement for the
 * snapshot runtime.
 *
 * This is goal 0008's **instrument**, not its acceptance. It measures a real
 * built candidate in a real browser and writes a private JSON report under
 * `<git-dir>/publish-report/`, but the maintainer's policy decision is external
 * and is not invented here. Every
 * report states its candidate identity, host, browser version, OS, throttling
 * (labeled simulation when used), cache definitions, sample counts, quantile
 * method, corpus generator seed, and fixture identity.
 * Every successful measured reply must supply finite `dispatchMs`, `operationMs`,
 * and `sqlMs`; cold measured success must also supply complete `phases`. Missing
 * telemetry is a workload failure, never an interpolated value.
 *
 * Each workload is one (size, topology) pair: a seeded corpus from
 * `scripts/generate-corpus.ts`, built by the CLI named on the command line
 * (`--cli`, default `bin/anc.mjs`; pass the installed package's bin to measure
 * the packaged-tarball candidate), served over loopback under the output's own
 * `_headers` with gzip negotiation, and driven in Chromium, Chrome, or Edge
 * through hover preview, the local-graph control, the tag browser, the site
 * graph, and a driver Worker constructed from the built chunk. A named
 * Playwright device profile applies the browser's mobile emulation settings to
 * every measured context.
 *
 * The SQLite-asset definition in section F is imported from
 * `tests/support/browser-site.ts` (`sqliteAssetRequests`,
 * `WORKER_CHUNK_PATTERN`) rather than restated, so this instrument cannot
 * drift from the gate that defines the class.
 *
 * Usage: `node scripts/benchmark-snapshot.ts [--sizes 100,1000,10000]
 * [--topologies sparse,hub] [--samples 30] [--throttle 4] [--cli bin/anc.mjs]
 * [--seed 7] [--browser chromium|chrome|edge] [--device "Pixel 7"]
 * [--out <report.json>]`
 *
 * `hub` names this harness's workload and maps to the generator's `skewed`
 * topology; `sparse` is the generator's `sparse`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { arch, cpus, release as osRelease, tmpdir, totalmem, type as osType } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import {
  GLOBAL_NODE_LIMIT,
  LOCAL_NODE_LIMIT,
  type SelectionEdge,
  type SelectionNode,
} from '../src/lib/graph-selection.ts';
import { MAX_PAGE_SIZE } from '../src/lib/snapshot-queries.ts';
import { TAG_PAGE_SIZE } from '../src/lib/tag-browser-model.ts';
import { SNAPSHOT_FILE_PATTERN } from '../src/lib/snapshot.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { previewFragment, previewTitle } from '../src/lib/preview-model.ts';
import type { LoadPhases } from '../src/lib/worker-protocol.ts';
import { sqliteAssetRequests, WORKER_CHUNK_PATTERN, workerScriptPath } from '../tests/support/browser-site.ts';
import {
  generateCorpus,
  type CorpusOptions,
  type CorpusTopology,
  type GeneratedCorpus,
} from './generate-corpus.ts';
import {
  benchmarkBrowserOptionsFromValues,
  parseBenchmarkOptions,
  resolveBenchmarkBrowser,
  type BenchmarkBrowser,
  type ResolvedBenchmarkBrowser,
} from './benchmark-browser.ts';
import {
  assertRepositoryIdentityStable,
  assertRepositoryIdentityClean,
  benchmarkReportDirectory,
  BenchmarkIdentityDriftError,
  repositoryIdentity,
  sha256File,
  type RepositoryIdentity,
} from './benchmark-identity.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILD_TIMEOUT_MS = 20 * 60_000;
const HOVER_TIMEOUT_MS = 30_000;
const WARM_PREVIEW_TIMEOUT_MS = 15_000;
const DRIVER_COLD_TIMEOUT_MS = 60_000;
const DRIVER_WARM_TIMEOUT_MS = 10_000;
const HEAP_POLL_INTERVAL_MS = 50;
const STEADY_SETTLE_MS = 1_000;
const MAX_WALK_PAGES = 500;
/** Total driver requests one cursor operation may spend across its repetitions. */
const WALK_REQUEST_BUDGET = 400;
/** Cloudflare Pages' default for a 200 no `_headers` rule names. */
const PLATFORM_REVALIDATION = 'public, max-age=0, must-revalidate';
const BENCHMARK_SNAPSHOT_OPTIONS = [
  'sizes',
  'topologies',
  'samples',
  'throttle',
  'cli',
  'seed',
  'browser',
  'device',
  'out',
] as const;

type Topology = 'sparse' | 'hub';

interface Options {
  sizes: number[];
  topologies: Topology[];
  samples: number;
  throttle: number;
  cli: string | undefined;
  seed: number;
  browser: BenchmarkBrowser;
  device: string | undefined;
  out: string | undefined;
}

/**
 * The generator request this harness sends, named as the generator's own
 * option fields so a renamed, removed, or retyped option is a type error here
 * rather than a silently ignored field.
 */
type GeneratorRequest = Required<Pick<CorpusOptions, 'notes' | 'seed' | 'topology' | 'metadata'>>;

export function parseSnapshotOptions(argv: readonly string[]): Options {
  const values = parseBenchmarkOptions(argv, BENCHMARK_SNAPSHOT_OPTIONS);
  const option = (name: string): string | undefined => values.get(name);
  const sizeTokens = (option('sizes') ?? '100,1000,10000').split(',').map((value) => value.trim());
  const sizes = sizeTokens.map(Number);
  if (sizeTokens.some((value) => value === '') || sizes.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('--sizes accepts only positive integers');
  }
  const requestedTopologies = (option('topologies') ?? 'sparse,hub').split(',').map((value) => value.trim());
  const topologies = requestedTopologies.filter(
    (value): value is Topology => value === 'sparse' || value === 'hub',
  );
  if (topologies.length !== requestedTopologies.length) {
    throw new Error('--topologies accepts only sparse and hub');
  }
  const samples = Number(option('samples') ?? '30');
  if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples needs a positive integer');
  const throttle = Number(option('throttle') ?? '4');
  if (!Number.isFinite(throttle) || throttle < 1) throw new Error('--throttle needs a number >= 1');
  const seed = Number(option('seed') ?? '7');
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const browserOptions = benchmarkBrowserOptionsFromValues(values);
  return {
    sizes,
    topologies,
    samples,
    throttle,
    cli: option('cli'),
    seed,
    ...browserOptions,
    out: option('out'),
  };
}

function generatorTopology(topology: Topology): CorpusTopology {
  return topology === 'hub' ? 'skewed' : 'sparse';
}

/** Host paths that must never reach stdout; registered per workload. */
const scrubPaths: string[] = [ROOT, tmpdir()];

function scrub(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const path of scrubPaths) text = text.split(path).join('<workspace>');
  return text;
}

function round(value: number, places: number): number {
  return Number(value.toFixed(places));
}

/** Nearest-rank percentile over the finite values; method stated in the report. */
function percentile(values: readonly number[], fraction: number): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return round(sorted[rank]!, 3);
}

interface Series {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  values: number[];
}

function seriesOf(values: readonly number[]): Series {
  const finite = values.filter((value) => Number.isFinite(value)).map((value) => round(value, 3));
  return {
    n: finite.length,
    min: percentile(finite, 0),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: percentile(finite, 1),
    values: finite,
  };
}

export interface NumericDistribution {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
  total: number | null;
}

function distributionOf(values: readonly number[]): NumericDistribution {
  const finite = values.filter((value) => Number.isFinite(value));
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    n: finite.length,
    min: percentile(finite, 0),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: percentile(finite, 1),
    mean: finite.length === 0 ? null : round(total / finite.length, 3),
    total: finite.length === 0 ? null : round(total, 3),
  };
}

export interface FieldLengthDistribution extends NumericDistribution {
  /** Values absent from their owning row or collection (not a zero-length value). */
  absent: number;
  /** Present values whose length is exactly zero. */
  empty: number;
}

/** Summarize string lengths while keeping missing and empty values distinct. */
export function fieldLengthDistribution(
  values: readonly (string | null | undefined)[],
  additionalAbsent = 0,
): FieldLengthDistribution {
  const present = values.filter((value): value is string => typeof value === 'string');
  return {
    ...distributionOf(present.map((value) => value.length)),
    absent: values.filter((value) => value === null || value === undefined).length + additionalAbsent,
    empty: present.filter((value) => value.length === 0).length,
  };
}

/** Fail closed when a UI operation did not produce exactly its expected events. */
export function assertExactEventCount(label: string, observed: number, expected: number): void {
  if (observed !== expected) throw new Error(`${label}: expected ${expected} events, observed ${observed}`);
}

export function assertExactSampleCount(label: string, observed: number, expected: number): void {
  if (observed !== expected) throw new Error(`${label}: expected ${expected} successful samples, observed ${observed}`);
}

export function assertExactlyOneControl(label: string, observed: number): void {
  if (observed !== 1) throw new Error(`${label}: expected exactly one control, observed ${observed}`);
}

/** The page count implied by the finalized tag membership, never a fixed cap. */
export function tagWalkPageBound(tagMembers: number, pageSize: number): number {
  if (!Number.isInteger(tagMembers) || tagMembers < 0) throw new Error('tag member count must be a non-negative integer');
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error('tag page size must be a positive integer');
  return Math.max(1, Math.ceil(tagMembers / pageSize));
}

export interface GraphSelectionShape {
  nodes: { slug: string; title: string; language: string }[];
  edges: { from: string; to: string }[];
  omitted: number;
}

/** Compare every public graph field, including directed edge identity and order. */
export function compareGraphSelection(
  actual: GraphSelectionShape,
  expected: GraphSelectionShape,
  label: string,
): string | null {
  if (JSON.stringify(actual.nodes) !== JSON.stringify(expected.nodes)) {
    return `${label}: nodes differ (actual ${JSON.stringify(actual.nodes)}, expected ${JSON.stringify(expected.nodes)})`;
  }
  if (JSON.stringify(actual.edges) !== JSON.stringify(expected.edges)) {
    return `${label}: edges differ (actual ${JSON.stringify(actual.edges)}, expected ${JSON.stringify(expected.edges)})`;
  }
  if (actual.omitted !== expected.omitted) {
    return `${label}: omitted differs (actual ${actual.omitted}, expected ${expected.omitted})`;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function walkFiles(root: string): string[] {
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

interface FixtureIdentity {
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
function fixtureIdentity(directory: string, ignore: (relativePath: string) => boolean = () => false): FixtureIdentity {
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
function fixtureStateIdentity(directory: string, ignore: (relativePath: string) => boolean = () => false): FixtureStateIdentity {
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

function hashPart(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  hash.update(`${bytes.byteLength}:`, 'utf8');
  hash.update(bytes);
}

function runtimePackagePath(installationRoot: string, directory: string): string {
  const path = relative(installationRoot, directory).split(sep).join('/');
  return path === '' ? '.' : path;
}

/** Hash only the installed runtime closure, without recursively hashing node_modules as package data. */
function runtimeDependencyClosure(
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

/** Keep a small withheld slice while making `size` mean published DB nodes. */
function generatorNotesForPublishedSize(size: number): number {
  return size + Math.max(1, Math.ceil(size * 0.04));
}

function generatorRequest(options: Options, size: number, topology: Topology): GeneratorRequest {
  return {
    notes: generatorNotesForPublishedSize(size),
    seed: options.seed,
    topology: generatorTopology(topology),
    metadata: true,
  };
}

interface CorpusFinalization {
  result: GeneratedCorpus;
  promoted: number;
  demoted: number;
}

function markdownFiles(directory: string): { file: string; relativePath: string }[] {
  return walkFiles(directory)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, relativePath: relative(directory, file).split(sep).join('/') }))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

function hasPublishFalse(text: string): boolean {
  const frontmatter = /^(?:---\r?\n)([\s\S]*?)(?:\r?\n---\r?\n?)/.exec(text);
  return frontmatter !== null && /^publish:\s*false\s*$/m.test(frontmatter[1]!);
}

/** Toggle only the generator's publication flag, preserving authored content. */
function setPublishFalse(file: string, withheld: boolean): number {
  const before = readFileSync(file, 'utf8');
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (end < 0) {
    if (!withheld) throw new Error(`cannot publish a Markdown file without frontmatter: ${basename(file)}`);
    lines.unshift('---', 'publish: false', '---', '');
  } else {
    const flag = lines.findIndex((line, index) => index > 0 && index < end && /^publish:\s*false\s*$/.test(line));
    if (withheld && flag < 0) lines.splice(1, 0, 'publish: false');
    if (!withheld && flag >= 0) lines.splice(flag, 1);
  }
  const after = lines.join(newline);
  if (after !== before) writeFileSync(file, after, 'utf8');
  return Buffer.byteLength(after, 'utf8') - Buffer.byteLength(before, 'utf8');
}

/**
 * The generator's random withholding is useful coverage, but its count is not
 * a workload size contract. Normalize the publication flags after generation
 * so the finalized DB has exactly the requested published-node count while the
 * raw generator request and return value remain visible in the report.
 */
function finalizeCorpus(
  directory: string,
  requestedPublished: number,
  generated: GeneratedCorpus,
): CorpusFinalization {
  const files = markdownFiles(directory);
  if (requestedPublished < 1 || requestedPublished >= files.length) {
    throw new Error(`requested ${requestedPublished} published notes from ${files.length} generated Markdown files`);
  }
  const classified = files.map((entry) => ({ ...entry, withheld: hasPublishFalse(readFileSync(entry.file, 'utf8')) }));
  const withheld = classified.filter((entry) => entry.withheld);
  const published = classified.filter((entry) => !entry.withheld);
  if (published.length !== generated.published || withheld.length !== generated.withheld) {
    throw new Error(
      `generator result ${generated.published}/${generated.withheld} disagrees with generated Markdown ${published.length}/${withheld.length}`,
    );
  }
  const promoted = Math.max(0, requestedPublished - generated.published);
  const demoted = Math.max(0, generated.published - requestedPublished);
  if (promoted > withheld.length || demoted > published.length) {
    throw new Error(
      `cannot finalize ${requestedPublished} published notes from generator result ${generated.published}/${generated.withheld}`,
    );
  }
  let bytes = generated.bytes;
  for (const { file } of withheld.slice(0, promoted)) bytes += setPublishFalse(file, false);
  for (const { file } of published.slice(0, demoted)) bytes += setPublishFalse(file, true);
  const result: GeneratedCorpus = {
    ...generated,
    published: requestedPublished,
    withheld: files.length - requestedPublished,
    bytes,
  };
  return { result, promoted, demoted };
}

/**
 * Note text statistics over the corpus Markdown.
 *
 * Scope is every `.md` file the generator wrote, withheld ones included, and
 * the method is recorded beside the numbers: this describes the workload the
 * build was handed, not a DB projection (a withheld note has no DB row).
 */
function corpusTextStats(directory: string): {
  scope: string;
  files: number;
  noteBytes: NumericDistribution;
  paragraphs: NumericDistribution;
} {
  const markdown = walkFiles(directory).filter((file) => file.endsWith('.md'));
  const bytes: number[] = [];
  const paragraphs: number[] = [];
  for (const file of markdown) {
    const text = readFileSync(file, 'utf8');
    bytes.push(Buffer.byteLength(text, 'utf8'));
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    paragraphs.push(body.split(/\r?\n\s*\r?\n/).filter((block) => block.trim() !== '').length);
  }
  return {
    scope: 'all generator-written Markdown files, withheld included',
    files: markdown.length,
    noteBytes: distributionOf(bytes),
    paragraphs: distributionOf(paragraphs),
  };
}

// --- Static server ---------------------------------------------------------------

interface HeaderRule {
  matcher: RegExp;
  headers: Record<string, string>;
}

/**
 * Parse the Cloudflare Pages `_headers` grammar, exactly as
 * `tests/support/browser-site.ts` does: an unindented line is a path pattern,
 * an indented `Name: value` line attaches to it, `#` starts a comment. Keeping
 * the rules per path is what makes the server under test the deployment's
 * policy rather than one flattened header set.
 */
function headerRules(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      rules.push({
        matcher: new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/:\w+/g, '[^/]+')}$`),
        headers: {},
      });
      continue;
    }
    const rule = rules.at(-1);
    if (rule === undefined) continue;
    const trimmed = line.trim();
    const separator = trimmed.indexOf(':');
    if (separator > 0) rule.headers[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).trim();
  }
  return rules;
}

function applyHeaderRules(rules: readonly HeaderRule[], pathname: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.matcher.test(pathname)) continue;
    Object.assign(headers, rule.headers);
  }
  return headers;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.sqlite': 'application/octet-stream',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface ServerRecord {
  path: string;
  method: string;
  status: number | null;
  completion: 'finished' | 'aborted';
  cacheControl: string;
  contentEncoding: string | null;
  contentLength: string | null;
  bytesServed: number | null;
  startedAtMs: number;
  endedAtMs: number;
}

export interface StaticServer {
  origin: string;
  headersSource: string;
  records: ServerRecord[];
  close(): Promise<void>;
}

export interface StaticServerOptions {
  /** Use a fixed port in focused tests; production keeps the ephemeral default. */
  port?: number;
  /** Test-only delay that makes a non-zero request duration observable. */
  responseDelayMs?: number;
}

/** Record exactly one terminal server-response event. */
export function recordResponseCompletion(
  response: Pick<ServerResponse, 'once'>,
  record: (completion: ServerRecord['completion']) => void,
): void {
  let completed = false;
  const finish = (completion: ServerRecord['completion']): void => {
    if (completed) return;
    completed = true;
    record(completion);
  };
  response.once('finish', () => finish('finished'));
  response.once('close', () => finish('aborted'));
}

interface PreparedAsset {
  body: Buffer;
  gzip: Buffer;
}

function preparedAssets(root: string): Map<string, PreparedAsset> {
  const assets = new Map<string, PreparedAsset>();
  for (const file of walkFiles(root)) {
    const body = readFileSync(file);
    assets.set(file, { body, gzip: gzipSync(body) });
  }
  return assets;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function listenServer(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, '127.0.0.1');
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Serve `dist/` on loopback with per-path `_headers`, gzip negotiation, and a
 * response log.
 *
 * gzip is applied whenever the request's `Accept-Encoding` names it. Bodies are
 * compressed once during server setup, before browser timing begins, and the
 * request callback only selects the cached bytes. `Content-Length` is always
 * the bytes of the body actually written.
 */
export async function startStaticServer(dist: string, options: StaticServerOptions = {}): Promise<StaticServer> {
  const outputHeaders = join(dist, '_headers');
  const headersSource = existsSync(outputHeaders) ? 'dist/_headers' : 'public/_headers';
  const rules = headerRules(readFileSync(existsSync(outputHeaders) ? outputHeaders : join(ROOT, 'public', '_headers'), 'utf8'));
  const records: ServerRecord[] = [];
  const root = resolve(dist);
  // Compress before the browser starts. Request callbacks only select a cached
  // body, so host-side gzip CPU cannot enter a timed cold intent.
  const assets = preparedAssets(root);
  const serverStart = Date.now();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestStartedAtMs = Date.now() - serverStart;
    let recordRegistered = false;
    const registerRecord = (
      path: string,
      headers: Record<string, string>,
      status: number,
      bodyBytes: number,
      contentEncoding: string | null,
      started: number,
    ): void => {
      if (recordRegistered) return;
      recordRegistered = true;
      const cacheControl = headers['Cache-Control'] ?? '';
      const contentLength = headers['Content-Length'] ?? null;
      recordResponseCompletion(response, (completion) => {
        records.push({
          path,
          method: request.method ?? 'GET',
          status: response.headersSent ? response.statusCode : completion === 'finished' ? status : null,
          completion,
          cacheControl,
          contentEncoding,
          contentLength,
          bytesServed: completion === 'finished' ? bodyBytes : null,
          startedAtMs: started,
          endedAtMs: Date.now() - serverStart,
        });
      });
    };
    void (async (): Promise<void> => {
      const startedAtMs = requestStartedAtMs;
      const responseDelayMs = options.responseDelayMs ?? 0;
      const waitBeforeResponse = async (): Promise<void> => {
        if (responseDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, responseDelayMs));
      };
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      registerRecord(request.url ?? '/', { 'Cache-Control': PLATFORM_REVALIDATION }, 400, 0, null, startedAtMs);
      response.writeHead(400);
      response.end('bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const headers = applyHeaderRules(rules, pathname);
    if (headers['Cache-Control'] === undefined) headers['Cache-Control'] = PLATFORM_REVALIDATION;
    const file = resolve(root, `.${pathname}`);
    // Directory boundary, not a string prefix: `/tmp/x/dist2/...` starts with
    // `/tmp/x/dist`, so a prefix test would serve a sibling's bytes.
    if (file !== root && !file.startsWith(root + sep)) {
      registerRecord(pathname, headers, 403, 0, null, startedAtMs);
      response.writeHead(403, headers);
      response.end('forbidden');
      return;
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      registerRecord(pathname, headers, 404, 0, null, startedAtMs);
      response.writeHead(404, headers);
      response.end('not found');
      return;
    }
    const asset = assets.get(file);
    if (asset === undefined) {
      registerRecord(pathname, headers, 500, 0, null, startedAtMs);
      response.writeHead(500, headers);
      response.end('asset changed while serving');
      return;
    }
    const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    if (request.headers['if-none-match'] === etag) {
      headers['ETag'] = etag;
      registerRecord(pathname, headers, 304, 0, null, startedAtMs);
      response.writeHead(304, headers);
      response.end();
      return;
    }
    let body: Buffer = asset.body;
    let contentEncoding: string | null = null;
    if ((request.headers['accept-encoding'] ?? '').includes('gzip')) {
      body = asset.gzip;
      contentEncoding = 'gzip';
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    }
    headers['Content-Type'] = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    headers['Content-Length'] = String(body.length);
    headers['ETag'] = etag;
    registerRecord(pathname, headers, 200, body.length, contentEncoding, startedAtMs);
    await waitBeforeResponse();
    response.writeHead(200, headers);
    response.end(body);
    })().catch((error: unknown) => {
      if (!recordRegistered) {
        registerRecord(request.url ?? '/', { 'Cache-Control': PLATFORM_REVALIDATION }, 500, 0, null, requestStartedAtMs);
      }
      if (!response.headersSent) {
        response.writeHead(500);
        response.end('internal server error');
      }
      process.stderr.write(`benchmark static server request failed: ${scrub(error)}\n`);
    });
  });
  try {
    await listenServer(server, options.port ?? 0);
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    headersSource,
    records,
    close(): Promise<void> {
      return closeServer(server);
    },
  };
}

// --- Database analysis -----------------------------------------------------------

interface DegreeRow {
  slug: string;
  degree: number;
}

interface DatabaseIdentity {
  file: string;
  sha256: string;
  digestMatchesFileName: boolean;
  rows: { nodes: number; edges: number; aliases: number; tags: number; nodeTags: number };
  notesPublished: number;
  notesWithheld: number | null;
  inDegree: { distribution: NumericDistribution; top: DegreeRow[] };
  outDegree: { distribution: NumericDistribution; top: DegreeRow[] };
  fieldLengths: {
    title: FieldLengthDistribution;
    excerpt: FieldLengthDistribution;
    language: FieldLengthDistribution;
    aliases: FieldLengthDistribution;
    tagKeys: FieldLengthDistribution;
    tagLabels: FieldLengthDistribution;
  };
  corpus: ReturnType<typeof corpusTextStats>;
}

interface WorkloadPlan {
  pageSlug: string;
  previewSlug: string;
  backlinkAnchor: string;
  outgoingAnchor: string;
  localCenter: string;
  tagKey: string | null;
  tagLabel: string | null;
  tagMembers: number;
  nodeCount: number;
  edgeCount: number;
}

interface DatabaseAnalysis {
  identity: DatabaseIdentity;
  plan: WorkloadPlan;
  inDegree: Map<string, number>;
  outDegree: Map<string, number>;
  nodes: (SelectionNode & { id: number })[];
  edges: SelectionEdge[];
}

export interface GraphOracleSelection {
  center: string | null;
  selection: GraphSelectionShape;
}

function oracleNodeOrder(a: SelectionNode, b: SelectionNode): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

function oracleInducedEdges(selected: ReadonlySet<string>, edges: readonly SelectionEdge[]): SelectionEdge[] {
  const seen = new Set<string>();
  const result: SelectionEdge[] = [];
  for (const edge of edges) {
    if (edge.from === edge.to || !selected.has(edge.from) || !selected.has(edge.to)) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ from: edge.from, to: edge.to });
  }
  return result.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** Independently derive the expected ranked graph from finalized DB rows and edges. */
type GraphOracleRequest =
  | { scope: 'local'; centerSlug: string }
  | { scope: 'global'; candidateSlugs?: ReadonlySet<string> };

export function graphOracleSelection(
  nodes: readonly (SelectionNode & { id: number })[],
  edges: readonly SelectionEdge[],
  request: GraphOracleRequest,
): GraphOracleSelection {
  if (request.scope === 'local') {
    const { centerSlug } = request;
    const center = nodes.find((node) => node.slug === centerSlug);
    if (center === undefined) throw new Error(`local graph oracle center is unknown: ${centerSlug}`);
    const neighbourSlugs = new Set<string>();
    for (const edge of edges) {
      if (edge.from === centerSlug) neighbourSlugs.add(edge.to);
      if (edge.to === centerSlug) neighbourSlugs.add(edge.from);
    }
    const candidates = nodes
      .filter((node) => node.slug !== centerSlug && neighbourSlugs.has(node.slug))
      .sort(oracleNodeOrder);
    const drawn = candidates.slice(0, LOCAL_NODE_LIMIT);
    const selectedSlugs = new Set([center.slug, ...drawn.map((node) => node.slug)]);
    return {
      center: center.slug,
      selection: {
        nodes: drawn.map(({ slug, title, language }) => ({ slug, title, language: language ?? '' })),
        edges: oracleInducedEdges(selectedSlugs, edges),
        omitted: candidates.length - drawn.length,
      },
    };
  }
  const { candidateSlugs } = request;
  const candidates = candidateSlugs === undefined ? [...nodes] : nodes.filter((node) => candidateSlugs.has(node.slug));
  const candidateSet = new Set(candidates.map((node) => node.slug));
  const candidateEdges = edges.filter((edge) => candidateSet.has(edge.from) && candidateSet.has(edge.to));
  const neighbours = new Map(candidates.map((node) => [node.slug, new Set<string>()]));
  for (const edge of candidateEdges) {
    if (edge.from === edge.to) continue;
    neighbours.get(edge.from)!.add(edge.to);
    neighbours.get(edge.to)!.add(edge.from);
  }
  const ranked = candidates.sort((a, b) => {
    const degree = neighbours.get(b.slug)!.size - neighbours.get(a.slug)!.size;
    return degree === 0 ? oracleNodeOrder(a, b) : degree;
  });
  const drawn = ranked.slice(0, GLOBAL_NODE_LIMIT);
  const selectedSlugs = new Set(drawn.map((node) => node.slug));
  return {
    center: null,
    selection: {
      nodes: drawn.map(({ slug, title, language }) => ({ slug, title, language: language ?? '' })),
      edges: oracleInducedEdges(selectedSlugs, candidateEdges),
      omitted: ranked.length - drawn.length,
    },
  };
}

function queryRows<T>(db: DatabaseSync, sql: string, params: readonly (string | number | null)[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function queryValue(
  db: DatabaseSync,
  sql: string,
  params: readonly (string | number | null)[] = [],
): unknown {
  const row = queryRows<Record<string, unknown>>(db, sql, params)[0];
  return row === undefined ? undefined : Object.values(row)[0];
}

/** Read directed graph edges without using SQLite keyword-shaped aliases. */
export function selectionEdges(db: DatabaseSync): SelectionEdge[] {
  return queryRows<{ sourceSlug: string; targetSlug: string }>(
    db,
    `SELECT s.slug AS sourceSlug, t.slug AS targetSlug
     FROM edges AS e
     JOIN nodes AS s ON s.id = e.source_id
     JOIN nodes AS t ON t.id = e.target_id
     ORDER BY s.slug, t.slug`,
  ).map((edge) => ({ from: edge.sourceSlug, to: edge.targetSlug }));
}

function topDegrees(degrees: ReadonlyMap<string, number>, nodes: readonly string[]): DegreeRow[] {
  return [...nodes]
    .map((slug) => ({ slug, degree: degrees.get(slug) ?? 0 }))
    .sort((a, b) => (b.degree !== a.degree ? b.degree - a.degree : a.slug < b.slug ? -1 : 1))
    .slice(0, 5);
}

/** Everything section A asks about the finalized DB, plus the plan the runs use. */
function analyseDatabase(
  db: DatabaseSync,
  fileName: string,
  fileDigest: string,
  corpus: ReturnType<typeof corpusTextStats>,
  finalized: GeneratedCorpus | null,
): DatabaseAnalysis {
  const rows = {
    nodes: Number(queryValue(db, 'SELECT COUNT(*) FROM nodes') ?? 0),
    edges: Number(queryValue(db, 'SELECT COUNT(*) FROM edges') ?? 0),
    aliases: Number(queryValue(db, 'SELECT COUNT(*) FROM aliases') ?? 0),
    tags: Number(queryValue(db, 'SELECT COUNT(*) FROM tags') ?? 0),
    nodeTags: Number(queryValue(db, 'SELECT COUNT(*) FROM node_tags') ?? 0),
  };
  const nodeRows = queryRows<{ id: number; slug: string; title: string; language: string; excerpt: string | null }>(
    db,
    'SELECT id, slug, title, excerpt, language FROM nodes ORDER BY slug',
  );
  const nodes = nodeRows.map((row) => row.slug);
  const selectionNodes = nodeRows.map((row) => ({
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    language: row.language,
  }));
  const edges = selectionEdges(db);
  // Seed every published node so isolated nodes contribute zero to the
  // distribution, not only to the top-list fallback.
  const inDegree = new Map<string, number>(nodes.map((slug): [string, number] => [slug, 0]));
  const outDegree = new Map<string, number>(nodes.map((slug): [string, number] => [slug, 0]));
  for (const row of queryRows<{ slug: string; degree: number }>(
    db,
    `SELECT n.slug AS slug, COUNT(*) AS degree
     FROM edges AS e JOIN nodes AS n ON n.id = e.target_id
     GROUP BY n.id`,
  )) {
    inDegree.set(row.slug, Number(row.degree));
  }
  for (const row of queryRows<{ slug: string; degree: number }>(
    db,
    `SELECT n.slug AS slug, COUNT(*) AS degree
     FROM edges AS e JOIN nodes AS n ON n.id = e.source_id
     GROUP BY n.id`,
  )) {
    outDegree.set(row.slug, Number(row.degree));
  }
  const total = new Map<string, number>();
  for (const slug of nodes) total.set(slug, (inDegree.get(slug) ?? 0) + (outDegree.get(slug) ?? 0));
  const byTotal = [...nodes].sort((a, b) =>
    (total.get(b) ?? 0) !== (total.get(a) ?? 0) ? (total.get(b) ?? 0) - (total.get(a) ?? 0) : a < b ? -1 : 1,
  );
  const byIn = [...nodes].sort((a, b) =>
    (inDegree.get(b) ?? 0) !== (inDegree.get(a) ?? 0) ? (inDegree.get(b) ?? 0) - (inDegree.get(a) ?? 0) : a < b ? -1 : 1,
  );
  const byOut = [...nodes].sort((a, b) =>
    (outDegree.get(b) ?? 0) !== (outDegree.get(a) ?? 0) ? (outDegree.get(b) ?? 0) - (outDegree.get(a) ?? 0) : a < b ? -1 : 1,
  );
  const busiestTag = queryRows<{ key: string; label: string; members: number }>(
    db,
    `SELECT t.key AS key, t.label AS label, COUNT(*) AS members
     FROM tags AS t JOIN node_tags AS nt ON nt.tag_id = t.id
     GROUP BY t.id
     ORDER BY members DESC, t.key ASC
     LIMIT 1`,
  )[0];
  const aliases = queryRows<{ nodeId: number; alias: string | null }>(
    db,
    'SELECT node_id AS nodeId, alias FROM aliases ORDER BY node_id, ordinal',
  );
  const tags = queryRows<{ id: number; key: string | null; label: string | null }>(
    db,
    'SELECT id, key, label FROM tags ORDER BY id',
  );
  const taggedNodeIds = new Set(
    queryRows<{ nodeId: number }>(db, 'SELECT DISTINCT node_id AS nodeId FROM node_tags').map((row) => Number(row.nodeId)),
  );
  const aliasNodeIds = new Set(aliases.map((row) => Number(row.nodeId)));
  const pageSlug = byTotal[0];
  if (pageSlug === undefined) throw new Error('the finalized DB has no published nodes');
  const digestMatch = /^site\.([0-9a-f]{64})\.sqlite$/.exec(fileName);
  return {
    identity: {
      file: `/data/${fileName}`,
      sha256: fileDigest,
      digestMatchesFileName: digestMatch?.[1] === fileDigest,
      rows,
      notesPublished: rows.nodes,
      notesWithheld: finalized === null ? null : finalized.withheld,
      inDegree: { distribution: distributionOf([...inDegree.values()]), top: topDegrees(inDegree, nodes) },
      outDegree: { distribution: distributionOf([...outDegree.values()]), top: topDegrees(outDegree, nodes) },
      fieldLengths: {
        title: fieldLengthDistribution(nodeRows.map((row) => row.title)),
        excerpt: fieldLengthDistribution(nodeRows.map((row) => row.excerpt)),
        language: fieldLengthDistribution(nodeRows.map((row) => row.language)),
        aliases: fieldLengthDistribution(
          aliases.map((row) => row.alias),
          rows.nodes - aliasNodeIds.size,
        ),
        tagKeys: fieldLengthDistribution(
          tags.map((row) => row.key),
          rows.nodes - taggedNodeIds.size,
        ),
        tagLabels: fieldLengthDistribution(
          tags.map((row) => row.label),
          rows.nodes - taggedNodeIds.size,
        ),
      },
      corpus,
    },
    plan: {
      pageSlug,
      previewSlug: pageSlug,
      backlinkAnchor: byIn[0] ?? pageSlug,
      outgoingAnchor: byOut[0] ?? pageSlug,
      localCenter: pageSlug,
      tagKey: busiestTag?.key ?? null,
      tagLabel: busiestTag?.label ?? null,
      tagMembers: Number(busiestTag?.members ?? 0),
      nodeCount: rows.nodes,
      edgeCount: rows.edges,
    },
    inDegree,
    outDegree,
    nodes: selectionNodes,
    edges,
  };
}

export interface DependencyFile {
  kind: 'snapshot' | 'snapshot-client' | 'wasm-binary' | 'wasm-glue' | 'worker-chunk';
  path: string;
  file: string;
}

interface PageModuleGraph {
  reachable: Set<string>;
  staticImports: Map<string, string[]>;
}

function reachablePageModules(dist: string, entryHtml: string): PageModuleGraph {
  const html = readFileSync(entryHtml, 'utf8');
  const roots = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)]
    .map((match) => match[1]!)
    .filter((path) => path.startsWith('/_astro/') && path.endsWith('.js'));
  const reachable = new Set<string>();
  const staticImports = new Map<string, string[]>();
  const pending = [...roots];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (reachable.has(path)) continue;
    const file = join(dist, path.slice(1));
    if (!existsSync(file)) throw new Error(`page module is missing from the build: ${path}`);
    reachable.add(path);
    const source = readFileSync(file, 'utf8');
    const staticSpecifiers = [
      ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
      ...source.matchAll(/\b(?:import|export)\b[^"'()]*?\bfrom\s*["']([^"']+)["']/g),
    ].map((match) => match[1]!);
    const resolveSpecifier = (specifier: string): string | null => {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
      const imported = new URL(specifier, `https://benchmark.invalid${path}`).pathname;
      return imported.startsWith('/_astro/') && imported.endsWith('.js') ? imported : null;
    };
    const staticPaths = staticSpecifiers.map(resolveSpecifier).filter((value): value is string => value !== null);
    staticImports.set(path, staticPaths);
    const dynamicPaths = [...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)]
      .map((match) => resolveSpecifier(match[1]!))
      .filter((value): value is string => value !== null);
    for (const imported of [...staticPaths, ...dynamicPaths]) {
      if (!reachable.has(imported)) pending.push(imported);
    }
  }
  return { reachable, staticImports };
}

/** The complete SQLite dependency set the build wrote, classified by kind. */
export function dependencyFiles(dist: string, entryHtml: string): DependencyFile[] {
  const found: DependencyFile[] = [];
  const dataDirectory = join(dist, 'data');
  if (existsSync(dataDirectory)) {
    for (const name of readdirSync(dataDirectory).filter((entry) => SNAPSHOT_FILE_PATTERN.test(entry))) {
      found.push({ kind: 'snapshot', path: `/data/${name}`, file: join(dataDirectory, name) });
    }
  }
  const wasmDirectory = join(dist, 'wasm');
  if (existsSync(wasmDirectory)) {
    for (const name of readdirSync(wasmDirectory)) {
      found.push({
        kind: name.endsWith('.wasm') ? 'wasm-binary' : 'wasm-glue',
        path: `/wasm/${name}`,
        file: join(wasmDirectory, name),
      });
    }
  }
  const snapshots = found.filter((dependency) => dependency.kind === 'snapshot');
  if (snapshots.length !== 1) throw new Error(`expected one snapshot dependency, found ${snapshots.length}`);
  const wasmBinaries = found.filter((dependency) => dependency.kind === 'wasm-binary');
  if (wasmBinaries.length !== 1) throw new Error(`expected one SQLite WASM binary, found ${wasmBinaries.length}`);
  const wasmModules = found.filter(
    (dependency) => dependency.kind === 'wasm-glue' && basename(dependency.path) === 'sqlite-wasm.js',
  );
  if (wasmModules.length !== 1) throw new Error(`expected one SQLite WASM module, found ${wasmModules.length}`);
  const astroDirectory = join(dist, '_astro');
  if (existsSync(astroDirectory)) {
    for (const name of readdirSync(astroDirectory)) {
      if (WORKER_CHUNK_PATTERN.test(`/_astro/${name}`)) {
        found.push({ kind: 'worker-chunk', path: `/_astro/${name}`, file: join(astroDirectory, name) });
      }
    }
  }
  const workerChunks = found.filter((dependency) => dependency.kind === 'worker-chunk');
  if (workerChunks.length !== 1) throw new Error(`expected one snapshot Worker chunk, found ${workerChunks.length}`);
  const workerBasename = basename(workerChunks[0]!.file);
  const pageModules = reachablePageModules(dist, entryHtml);
  const clientChunks = [...pageModules.reachable].filter((path) =>
    readFileSync(join(dist, path.slice(1)), 'utf8').includes(workerBasename),
  );
  if (clientChunks.length !== 1) throw new Error(`expected one snapshot client chunk, found ${clientChunks.length}`);
  const clientChunk = clientChunks[0]!;
  const clientDependencies = new Set<string>();
  const pendingClientDependencies = [clientChunk];
  while (pendingClientDependencies.length > 0) {
    const path = pendingClientDependencies.pop()!;
    if (clientDependencies.has(path)) continue;
    clientDependencies.add(path);
    for (const imported of pageModules.staticImports.get(path) ?? []) pendingClientDependencies.push(imported);
  }
  for (const path of [...clientDependencies].sort()) {
    found.push({ kind: 'snapshot-client', path, file: join(dist, path.slice(1)) });
  }
  return found;
}

// --- Page-side recorder and driver ----------------------------------------------

type WorkerPhases = LoadPhases;

function normalizePhases(value: unknown): WorkerPhases | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const durationFields = ['totalMs', 'fetchMs', 'digestMs', 'wasmInitMs', 'importMs'] as const;
  const fields = [...durationFields, 'wasmMemoryBytes'] as const;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key as (typeof fields)[number]))) {
    return null;
  }
  const durations = durationFields.map((field) => {
    const candidate = record[field];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
  });
  if (durations.some((duration) => duration === null)) return null;
  const wasmMemoryBytes = record['wasmMemoryBytes'];
  if (
    wasmMemoryBytes !== null &&
    !(typeof wasmMemoryBytes === 'number' && Number.isFinite(wasmMemoryBytes) && wasmMemoryBytes >= 0)
  ) {
    return null;
  }
  return {
    totalMs: durations[0]!,
    fetchMs: durations[1]!,
    digestMs: durations[2]!,
    wasmInitMs: durations[3]!,
    importMs: durations[4]!,
    wasmMemoryBytes,
  };
}

interface SnapshotEvent {
  type: string;
  ms: number | null;
  operationMs: number | null;
  sqlMs: number | null;
  phases: WorkerPhases | null;
}

interface GraphRenderEvent {
  scope: string;
  ms: number | null;
}

interface PreviewObservation {
  intentAt: number;
  href: string;
  slug: string | null;
  visibleAt: number | null;
  text: string | null;
}

interface RecorderState {
  snapshot: SnapshotEvent[];
  graphRender: GraphRenderEvent[];
  preview: PreviewObservation[];
}

/**
 * Arm the page-side instrument on every document in a context.
 *
 * `__snapshotMeasurement` is the runtime's existing armed flag; the recorder's
 * listeners are passive and carry no corpus data. The preview observer records
 * the `pointerover` intent and the panel's own unhide on the page's clock, so
 * the hover delay is observed rather than a constant subtracted from the
 * harness's timing.
 */
async function installRecorder(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const state = window as unknown as {
      __snapshotMeasurement?: boolean;
      __benchSnapshot: SnapshotEvent[];
      __benchGraphRender: GraphRenderEvent[];
      __benchPreview: PreviewObservation[];
    };
    state.__snapshotMeasurement = true;
    state.__benchSnapshot = [];
    state.__benchGraphRender = [];
    state.__benchPreview = [];

    const slugOf = (href: string): string | null => {
      try {
        const match = /^\/notes\/([^/]+)\/$/.exec(new URL(href, location.origin).pathname);
        return match === null ? null : match[1]!;
      } catch {
        return null;
      }
    };
    const eligible = (link: HTMLAnchorElement): boolean => {
      try {
        const url = new URL(link.href, location.origin);
        return url.origin === location.origin && url.pathname !== location.pathname && slugOf(url.pathname) !== null;
      } catch {
        return false;
      }
    };

    document.addEventListener(
      'pointerover',
      (event) => {
        const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!(target instanceof HTMLAnchorElement) || !eligible(target)) return;
        const href = target.getAttribute('href') ?? '';
        state.__benchPreview.push({ intentAt: performance.now(), href, slug: slugOf(href), visibleAt: null, text: null });
      },
      true,
    );

    document.addEventListener(
      'snapshot-result',
      (event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        state.__benchSnapshot.push({
          type: typeof detail['type'] === 'string' ? detail['type'] : 'unknown',
          ms: typeof detail['ms'] === 'number' ? detail['ms'] : null,
          operationMs: typeof detail['operationMs'] === 'number' ? detail['operationMs'] : null,
          sqlMs: typeof detail['sqlMs'] === 'number' ? detail['sqlMs'] : null,
          phases: (detail['phases'] ?? null) as WorkerPhases | null,
        });
      },
      true,
    );

    document.addEventListener(
      'graph-render',
      (event) => {
        const detail = (event as CustomEvent<Record<string, unknown>>).detail;
        state.__benchGraphRender.push({
          scope: typeof detail['scope'] === 'string' ? detail['scope'] : 'unknown',
          ms: typeof detail['ms'] === 'number' ? detail['ms'] : null,
        });
      },
      true,
    );

    const observer = new MutationObserver(() => {
      const panel = document.querySelector<HTMLElement>('#link-preview');
      if (panel === null || panel.hidden) return;
      const last = state.__benchPreview.at(-1);
      if (last === undefined || last.visibleAt !== null) return;
      last.visibleAt = performance.now();
      last.text = (panel.textContent ?? '').slice(0, 2000);
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  });
}

/** Read one page's recorder arrays as plain data. */
async function readRecorder(page: Page): Promise<RecorderState> {
  const recorded = await page.evaluate(() => {
    const state = window as unknown as {
      __benchSnapshot?: SnapshotEvent[];
      __benchGraphRender?: GraphRenderEvent[];
      __benchPreview?: PreviewObservation[];
    };
    return {
      snapshot: state.__benchSnapshot ?? [],
      graphRender: state.__benchGraphRender ?? [],
      preview: state.__benchPreview ?? [],
    };
  });
  return {
    ...recorded,
    snapshot: recorded.snapshot.map((event) => ({ ...event, phases: normalizePhases(event.phases) })),
  };
}

/** Read only newly appended snapshot events so paginated walks stay linear. */
async function readSnapshotEvents(page: Page, offset: number): Promise<{ events: SnapshotEvent[]; total: number }> {
  const batch = await page.evaluate((from) => {
    const state = window as unknown as { __benchSnapshot?: SnapshotEvent[] };
    const all = state.__benchSnapshot ?? [];
    return {
      events: all.slice(from),
      total: all.length,
    };
  }, offset);
  return {
    events: batch.events.map((event) => ({ ...event, phases: normalizePhases(event.phases) })),
    total: batch.total,
  };
}

export interface RenderedSelectionShape {
  nodes: GraphSelectionShape['nodes'];
  edges: GraphSelectionShape['edges'];
}

export interface RenderedPreviewShape {
  title: string;
  excerpt: string;
  fragment: string | null;
  titleLanguage: string;
  excerptLanguage: string;
}

interface TagIdentity {
  key: string;
  label: string;
}

export function tagIdentityFailure(
  actual: TagIdentity | null,
  expected: TagIdentity,
  label: string,
): string | null {
  return actual?.key === expected.key && actual.label === expected.label
    ? null
    : `${label}: tag identity differs (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`;
}

export function compareRenderedPreview(
  actual: RenderedPreviewShape,
  expected: RenderedPreviewShape,
  label: string,
): string | null {
  const comparable = (value: RenderedPreviewShape): RenderedPreviewShape => ({
    ...value,
    titleLanguage: value.titleLanguage.toLowerCase(),
    excerptLanguage: value.excerptLanguage.toLowerCase(),
  });
  return JSON.stringify(comparable(actual)) === JSON.stringify(comparable(expected))
    ? null
    : `${label}: rendered preview differs (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`;
}

export async function readRenderedPreview(page: Page): Promise<RenderedPreviewShape> {
  return page.locator('#link-preview').evaluate((panel) => {
    const title = panel.querySelector<HTMLElement>(':scope > strong');
    const excerpt = panel.querySelector<HTMLElement>(':scope > p');
    if (title === null || excerpt === null) throw new Error('the rendered preview has no title or excerpt');
    const documentLanguage = document.documentElement.lang || 'en';
    return {
      title: title.textContent ?? '',
      excerpt: excerpt.textContent ?? '',
      fragment: panel.querySelector<HTMLElement>(':scope > .preview-fragment')?.textContent ?? null,
      titleLanguage: title.getAttribute('lang') ?? documentLanguage,
      excerptLanguage: excerpt.getAttribute('lang') ?? documentLanguage,
    };
  });
}

function orderedEdges(edges: readonly SelectionEdge[]): SelectionEdge[] {
  return [...edges].sort((left, right) =>
    left.from !== right.from
      ? left.from < right.from
        ? -1
        : 1
      : left.to < right.to
        ? -1
        : left.to > right.to
          ? 1
          : 0,
  );
}

export function compareRenderedSelection(
  actual: RenderedSelectionShape,
  expected: RenderedSelectionShape,
  label: string,
): string | null {
  const comparableNodes = (nodes: GraphSelectionShape['nodes']): GraphSelectionShape['nodes'] =>
    nodes.map((node) => ({ ...node, language: node.language.toLowerCase() }));
  if (JSON.stringify(comparableNodes(actual.nodes)) !== JSON.stringify(comparableNodes(expected.nodes))) {
    return `${label}: rendered nodes differ (actual ${JSON.stringify(actual.nodes)}, expected ${JSON.stringify(expected.nodes)})`;
  }
  const actualEdges = orderedEdges(actual.edges);
  const expectedEdges = orderedEdges(expected.edges);
  if (JSON.stringify(actualEdges) !== JSON.stringify(expectedEdges)) {
    return `${label}: rendered edges differ (actual ${JSON.stringify(actualEdges)}, expected ${JSON.stringify(expectedEdges)})`;
  }
  return null;
}

export async function readRenderedGraph(page: Page): Promise<RenderedSelectionShape> {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[data-graph-region]');
    if (region === null) throw new Error('the rendered graph region is missing');
    const svg = region.querySelector<SVGSVGElement>('[data-graph-canvas] svg');
    const table = region.querySelector<HTMLElement>('[data-graph-body]');
    if (svg === null || table === null) throw new Error('the rendered graph surfaces are missing');

    const slugOf = (href: string): string => {
      const match = /^\/notes\/([^/]+)\/$/.exec(new URL(href, location.origin).pathname);
      if (match === null) throw new Error(`rendered graph link is not a note route: ${href}`);
      return match[1]!;
    };
    const documentLanguage = document.documentElement.lang || 'en';
    const nodes = [...table.querySelectorAll<HTMLTableRowElement>(':scope > tr')].map((row) => {
      const link = row.querySelector<HTMLAnchorElement>('th a[href]');
      if (link === null) throw new Error('a rendered graph row has no identity link');
      return {
        slug: slugOf(link.href),
        title: link.textContent ?? '',
        language: link.getAttribute('lang') ?? documentLanguage,
      };
    });

    const points = [...svg.querySelectorAll<SVGAElement>('.graph-nodes a[href]')].map((anchor) => {
      const circle = anchor.querySelector<SVGCircleElement>('circle');
      const x = circle?.getAttribute('cx');
      const y = circle?.getAttribute('cy');
      if (circle === null || x === null || y === null || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
        throw new Error('a rendered graph node has no finite coordinates');
      }
      return { slug: slugOf(anchor.href.baseVal), x: Number(x), y: Number(y) };
    });
    if (JSON.stringify(points.map((point) => point.slug)) !== JSON.stringify(nodes.map((node) => node.slug))) {
      throw new Error('the rendered graph table and figure expose different node identities');
    }
    const closest = (x: number, y: number): string => {
      const nearest = points
        .map((point) => ({ point, distance: Math.hypot(point.x - x, point.y - y) }))
        .sort((left, right) => left.distance - right.distance)[0];
      if (nearest === undefined) throw new Error('a rendered graph edge has no node endpoint');
      return nearest.point.slug;
    };
    const edges: SelectionEdge[] = [];
    for (const line of svg.querySelectorAll<SVGLineElement>('.graph-edges line')) {
      const coordinates = ['x1', 'y1', 'x2', 'y2'].map((name) => Number(line.getAttribute(name)));
      if (coordinates.some((value) => !Number.isFinite(value))) {
        throw new Error('a rendered graph edge has no finite coordinates');
      }
      const from = closest(coordinates[0]!, coordinates[1]!);
      const to = closest(coordinates[2]!, coordinates[3]!);
      if (from === to) throw new Error(`a rendered graph edge maps both endpoints to ${from}`);
      edges.push({ from, to });
      if (line.hasAttribute('marker-start')) edges.push({ from: to, to: from });
    }
    return { nodes, edges };
  });
}

export async function readRenderedNotes(page: Page, selector: string): Promise<GraphSelectionShape['nodes']> {
  return page.locator(selector).evaluateAll((links) => {
    const documentLanguage = document.documentElement.lang || 'en';
    return links.map((element) => {
      if (!(element instanceof HTMLAnchorElement)) throw new Error('rendered note identity is not an anchor');
      const match = /^\/notes\/([^/]+)\/$/.exec(element.pathname);
      if (match === null) throw new Error(`rendered note link is not a note route: ${element.href}`);
      return {
        slug: match[1]!,
        title: element.textContent ?? '',
        language: element.getAttribute('lang') ?? documentLanguage,
      };
    });
  });
}

/** Open a measured page and arm its page target before any navigation occurs. */
export async function openMeasuredPage(
  context: BrowserContext,
  throttle: number,
): Promise<{ page: Page; session: CDPSession }> {
  const page = await context.newPage();
  try {
    const session = await context.newCDPSession(page);
    if (throttle > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    return { page, session };
  } catch (error) {
    try {
      await page.close();
    } catch {
      // The caller records the original page-setup failure; best-effort cleanup is enough here.
    }
    throw error;
  }
}

/**
 * Mark and return the first previewable note link on the page.
 *
 * Eligibility mirrors `link-preview.ts`: same origin, not the page's own
 * route, and a `/notes/<slug>/` path. The link is marked with a data attribute
 * so the hover target is one element rather than a selector re-derived from a
 * value that could be quoted.
 */
async function firstEligibleLink(page: Page): Promise<{ href: string; slug: string } | null> {
  return page.evaluate(() => {
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (link.origin !== location.origin) continue;
      const match = /^\/notes\/([^/]+)\/$/.exec(link.pathname);
      if (match === null || link.pathname === location.pathname) continue;
      link.setAttribute('data-bench-target-link', '');
      return { href: link.getAttribute('href') ?? '', slug: match[1]! };
    }
    return null;
  });
}

/** The installed class definition, imported from the gate that owns it. */
function sqliteAssetDefinition(): string {
  return "url includes '/data/site.', '/wasm/', or matches WORKER_CHUNK_PATTERN (/\\/_astro\\/snapshot-worker-[\\w-]+\\.js$/); imported from tests/support/browser-site.ts";
}

interface RenderTiming {
  domContentLoadedEventEnd: number | null;
  loadEventEnd: number | null;
  firstContentfulPaint: number | null;
  transferredBytes: number | null;
  documentTransferBytes: number | null;
  resourceTransferBytes: number | null;
  resourceCount: number;
}

async function navigationTiming(page: Page): Promise<RenderTiming> {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint');
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const resourceTransfer = resources.reduce((sum, entry) => sum + (entry.transferSize ?? 0), 0);
    const documentTransfer = navigation?.transferSize ?? 0;
    return {
      domContentLoadedEventEnd: navigation?.domContentLoadedEventEnd ?? null,
      loadEventEnd: navigation?.loadEventEnd ?? null,
      firstContentfulPaint: paint === undefined ? null : paint.startTime ?? null,
      transferredBytes: documentTransfer + resourceTransfer,
      documentTransferBytes: documentTransfer,
      resourceTransferBytes: resourceTransfer,
      resourceCount: resources.length,
    };
  });
}

export interface ResourceEntry {
  source: 'page' | 'worker';
  page: string;
  path: string;
  encodedBodySize: number | null;
  decodedBodySize: number | null;
  transferSize: number | null;
  duration: number | null;
  responseStatus: number | null;
  initiatorType: string | null;
}

/**
 * Collect the page's and its workers' resource timings.
 *
 * The page's own timeline carries the Worker chunk (a page-initiated
 * construction) but not the DB, WASM binary, or glue, because those are
 * fetched *inside* the Worker and Chrome attributes them to the worker's own
 * timeline; both are collected here under `source` so the dependency table can
 * use the real numbers instead of a page-side absence reported as zero.
 */
export async function collectResources(page: Page, label: string, out: ResourceEntry[]): Promise<void> {
  const readEntries = (): Omit<ResourceEntry, 'source' | 'page'>[] => {
    return (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((entry) => {
      let path: string;
      try {
        path = new URL(entry.name).pathname;
      } catch {
        path = entry.name;
      }
      return {
        path,
        encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
        decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
        transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
        duration: Number.isFinite(entry.duration) ? entry.duration : null,
        responseStatus:
          typeof (entry as { responseStatus?: unknown }).responseStatus === 'number'
            ? ((entry as { responseStatus: number }).responseStatus)
            : null,
        initiatorType: entry.initiatorType ?? null,
      };
    });
  };
  let pageEntries: Omit<ResourceEntry, 'source' | 'page'>[];
  try {
    pageEntries = await page.evaluate(readEntries);
  } catch (error) {
    throw new Error(`${label} page resource timing failed: ${scrub(error)}`);
  }
  for (const entry of pageEntries) {
    out.push({ source: 'page', page: label, ...entry });
  }
  for (const [index, worker] of page.workers().entries()) {
    let workerEntries: Omit<ResourceEntry, 'source' | 'page'>[];
    try {
      workerEntries = await worker.evaluate(readEntries);
    } catch (error) {
      throw new Error(`${label} worker ${index + 1} resource timing failed: ${scrub(error)}`);
    }
    for (const entry of workerEntries) {
      out.push({ source: 'worker', page: label, ...entry });
    }
  }
}

interface HeapSummary {
  samples: number;
  arrayBufferObserved: boolean;
  peakJsHeapBytes: number | null;
  steadyJsHeapBytes: number | null;
  peakArrayBufferBytes: number | null;
  steadyArrayBufferBytes: number | null;
}

/** Poll CDP `Performance.getMetrics` until stopped; the last sample is steady. */
export function startHeapPolling(session: CDPSession): { stop: () => Promise<HeapSummary> } {
  const values: { jsHeap: number | null; arrayBuffer: number | null }[] = [];
  let stopped = false;
  let failure: { error: unknown } | null = null;
  const loop = (async () => {
    while (!stopped) {
      try {
        const metrics = await session.send('Performance.getMetrics');
        const find = (name: string): number | null => {
          const metric = metrics.metrics.find((entry) => entry.name === name);
          return metric === undefined || !Number.isFinite(metric.value) ? null : Math.round(metric.value);
        };
        values.push({ jsHeap: find('JSHeapUsedSize'), arrayBuffer: find('ArrayBufferBytes') });
      } catch (error) {
        failure = { error };
        break;
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, HEAP_POLL_INTERVAL_MS));
    }
  })();
  return {
    async stop(): Promise<HeapSummary> {
      stopped = true;
      await loop;
      if (failure !== null) throw new Error(`CDP Performance.getMetrics failed: ${scrub(failure.error)}`);
      const jsHeap = values.map((sample) => sample.jsHeap).filter((value): value is number => value !== null);
      const arrayBuffer = values.map((sample) => sample.arrayBuffer).filter((value): value is number => value !== null);
      if (jsHeap.length < 2) {
        throw new Error(`CDP Performance.getMetrics returned ${jsHeap.length} usable JSHeapUsedSize samples; need at least 2`);
      }
      return {
        samples: values.length,
        arrayBufferObserved: values.some((sample) => sample.arrayBuffer !== null),
        peakJsHeapBytes: jsHeap.length === 0 ? null : Math.max(...jsHeap),
        steadyJsHeapBytes: jsHeap.at(-1) ?? null,
        peakArrayBufferBytes: arrayBuffer.length === 0 ? null : Math.max(...arrayBuffer),
        steadyArrayBufferBytes: arrayBuffer.at(-1) ?? null,
      };
    },
  };
}

// --- Driver Worker ----------------------------------------------------------------

interface DriverReply {
  id?: number;
  ok: boolean;
  code?: string;
  result?: {
    type: string;
    known?: boolean;
    page?: {
      known?: boolean;
      tag?: TagIdentity;
      notes: { slug: string; title: string; language: string }[];
      nextCursor: string | null;
    };
    preview?: { slug: string; title: string; excerpt: string } | null;
    graph?: {
      center?: { slug: string };
      nodes: { slug: string; title: string; language: string }[];
      edges: { from: string; to: string }[];
      omitted: number;
    } | null;
  };
  operationMs?: number;
  sqlMs?: number;
  phases?: unknown;
  dispatchMs: number;
}

async function installDriver(page: Page, workerPath: string): Promise<void> {
  await page.evaluate((script: string) => {
    const state = window as unknown as {
      __benchDriver?: {
        request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
      };
    };
    if (state.__benchDriver !== undefined) return;
    const pending = new Map<number, (reply: unknown) => void>();
    let nextId = 1;
    const worker = new Worker(script, { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent) => {
      const reply = event.data as { id?: unknown };
      if (typeof reply?.id !== 'number') return;
      const settle = pending.get(reply.id);
      if (settle === undefined) return;
      pending.delete(reply.id);
      settle(reply);
    });
    state.__benchDriver = {
      request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
        const id = nextId;
        nextId += 1;
        const started = performance.now();
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ id, ok: false, code: 'timeout', dispatchMs: performance.now() - started });
          }, timeoutMs);
          pending.set(id, (reply) => {
            clearTimeout(timer);
            resolve({ ...(reply as Record<string, unknown>), dispatchMs: performance.now() - started });
          });
          worker.postMessage({ ...message, id, measure: true });
        });
      },
    };
  }, workerPath);
}

function driverRequest(
  page: Page,
  type: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<DriverReply> {
  return page.evaluate(
    async (input: { type: string; args: Record<string, unknown>; timeoutMs: number }) => {
      const driver = (
        window as unknown as {
          __benchDriver?: { request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown> };
        }
      ).__benchDriver;
      if (driver === undefined) return { ok: false, code: 'no-driver', dispatchMs: 0 };
      return (await driver.request({ type: input.type, ...input.args }, input.timeoutMs)) as {
        ok: boolean;
        code?: string;
        result?: unknown;
        operationMs?: number;
        sqlMs?: number;
        phases?: unknown;
        dispatchMs: number;
      };
    },
    { type, args, timeoutMs },
  ) as Promise<DriverReply>;
}

interface OperationTiming {
  repetitions: number;
  dispatchMs: number[];
  operationMs: number[];
  sqlMs: number[];
  phases: WorkerPhases | null;
  dispatchSummary: Series;
  opSummary: Series;
}

function timingOf(): OperationTiming {
  return { repetitions: 0, dispatchMs: [], operationMs: [], sqlMs: [], phases: null, dispatchSummary: seriesOf([]), opSummary: seriesOf([]) };
}

export function measuredReplyFailure(
  label: string,
  reply: Pick<DriverReply, 'dispatchMs' | 'operationMs' | 'sqlMs' | 'phases'>,
  requirePhases = false,
): string | null {
  if (!Number.isFinite(reply.dispatchMs)) return `${label}: measured reply has non-finite dispatchMs`;
  if (!Number.isFinite(reply.operationMs)) return `${label}: measured reply has non-finite operationMs`;
  if (!Number.isFinite(reply.sqlMs)) return `${label}: measured reply has non-finite sqlMs`;
  if (requirePhases && normalizePhases(reply.phases) === null) return `${label}: cold measured reply has no complete phases`;
  return null;
}

export function measuredEventFailure(label: string, event: SnapshotEvent, requirePhases = false): string | null {
  if (!Number.isFinite(event.ms)) return `${label}: measured reply has non-finite dispatchMs`;
  if (!Number.isFinite(event.operationMs)) return `${label}: measured reply has non-finite operationMs`;
  if (!Number.isFinite(event.sqlMs)) return `${label}: measured reply has non-finite sqlMs`;
  if (requirePhases && normalizePhases(event.phases) === null) return `${label}: cold measured reply has no complete phases`;
  return null;
}

function absorbTiming(timing: OperationTiming, reply: DriverReply): void {
  const failure = measuredReplyFailure('driver', reply);
  if (failure !== null) throw new Error(failure);
  timing.dispatchMs.push(round(reply.dispatchMs, 3));
  timing.operationMs.push(round(reply.operationMs!, 3));
  timing.sqlMs.push(round(reply.sqlMs!, 3));
  if (timing.phases === null && reply.phases != null) timing.phases = normalizePhases(reply.phases);
}

function finalizeTiming(
  timing: OperationTiming,
  repetitions: number,
  successfulReplies: number,
  label: string,
): OperationTiming {
  timing.repetitions = repetitions;
  assertExactSampleCount(`${label} dispatch telemetry`, timing.dispatchMs.length, successfulReplies);
  assertExactSampleCount(`${label} operation telemetry`, timing.operationMs.length, successfulReplies);
  assertExactSampleCount(`${label} SQL telemetry`, timing.sqlMs.length, successfulReplies);
  timing.dispatchSummary = seriesOf(timing.dispatchMs);
  timing.opSummary = seriesOf(timing.operationMs);
  return timing;
}

interface WalkOutcome {
  timing: OperationTiming;
  pagesPerWalk: number;
  notes: { slug: string; title: string; language: string }[];
  tag: TagIdentity | null;
  failures: string[];
}

/** Drive one cursor operation across repetitions, walking `nextCursor` to null. */
async function driveWalk(
  page: Page,
  type: 'backlinks' | 'outgoing' | 'byTag',
  args: Record<string, unknown>,
  pageSize: number,
  repetitions: number,
  maxPages: number = MAX_WALK_PAGES,
): Promise<WalkOutcome> {
  const timing = timingOf();
  const failures: string[] = [];
  const notes: { slug: string; title: string; language: string }[] = [];
  let tag: TagIdentity | null = null;
  let pagesPerWalk = 0;
  let successfulReplies = 0;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const reply = await driverRequest(page, type, { ...args, cursor, pageSize }, DRIVER_WARM_TIMEOUT_MS);
      if (!reply.ok || reply.result === undefined) {
        failures.push(`${type} repetition ${repetition} page ${pages}: ${reply.code ?? 'failed'}`);
        break;
      }
      successfulReplies += 1;
      const telemetryFailure = measuredReplyFailure(`${type} repetition ${repetition} page ${pages}`, reply);
      if (telemetryFailure !== null) {
        failures.push(telemetryFailure);
        break;
      }
      absorbTiming(timing, reply);
      const walkPage = reply.result.page;
      if (walkPage === undefined) {
        failures.push(`${type} repetition ${repetition}: reply carried no page`);
        break;
      }
      if (walkPage.notes.length > pageSize) {
        failures.push(`${type} returned ${walkPage.notes.length} notes for page size ${pageSize}`);
      }
      if (type === 'byTag') {
        const observed = walkPage.known === true && walkPage.tag !== undefined ? walkPage.tag : null;
        if (observed === null) failures.push(`byTag repetition ${repetition} page ${pages}: reply carried no tag identity`);
        else if (tag === null) tag = observed;
        else {
          const mismatch = tagIdentityFailure(observed, tag, `byTag repetition ${repetition} page ${pages}`);
          if (mismatch !== null) failures.push(mismatch);
        }
      }
      if (repetition === 0) notes.push(...walkPage.notes);
      cursor = walkPage.nextCursor;
      pages += 1;
      if (cursor === null) break;
      if (pages >= maxPages) {
        failures.push(`${type} cursor did not terminate within ${maxPages} pages`);
        break;
      }
    }
    if (repetition === 0) pagesPerWalk = pages;
  }
  try {
    finalizeTiming(timing, repetitions, successfulReplies, type);
  } catch (error) {
    failures.push(scrub(error));
    timing.dispatchSummary = seriesOf([]);
    timing.opSummary = seriesOf([]);
  }
  return { timing, pagesPerWalk, notes, tag, failures };
}

// --- Workload measurement ---------------------------------------------------------

interface GeneratorIdentity {
  name: string;
  seed: number;
  options: GeneratorRequest;
  result: GeneratedCorpus | null;
  finalized: CorpusFinalization | null;
}

interface BuildIdentity {
  seconds: number | null;
  cli: { basename: string; sha256: string };
}

interface FailoverRecord {
  phase: string;
  message: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface PreviewSample {
  intentToVisibleMs: number | null;
  hoverDelayMs: number | null;
  hoverDelaySource: string;
  visible: boolean;
  nonEmpty: boolean;
  targetSlug: string | null;
  targetTitle: string | null;
  titleMatched: boolean | null;
  panelTextSample: string | null;
  error: string | null;
}

interface PreviewReport {
  targetFromDb: { slug: string; title: string } | null;
  cold: PreviewSample;
  warm: PreviewSample;
}

interface StartupReport {
  instrument: string;
  blindSpots: string[];
  heap: HeapSummary | null;
  heapPeakNote: string;
  worker: {
    firstReplyMs: number | null;
    phases: WorkerPhases | null;
    phasesNote: string | null;
    wasmMemoryBytes: number | null;
  };
}

interface UiLocalGraphReport {
  activations: number;
  dispatchMs: number[];
  operationMs: number[];
  sqlMs: number[];
  phases: WorkerPhases | null;
  renderMs: number[];
  dispatchSummary: Series;
}

interface TagBrowseReport {
  tagKey: string;
  pages: number;
  notesShown: number;
  dispatchMs: number[];
  operationMs: number[];
  sqlMs: number[];
  phases: WorkerPhases | null;
  dispatchSummary: Series;
}

interface GlobalGraphUiReport {
  unfilteredMs: number[];
  filteredMs: number[];
  operationMs: number[];
  renderMs: number[];
  phases: WorkerPhases | null;
  filteredTag: string | null;
}

interface DriverOperationReport extends OperationTiming {
  pagesPerWalk?: number;
  notesWalked?: number;
  failures: string[];
}

interface QueriesReport {
  definitions: string[];
  ui: {
    localGraph: UiLocalGraphReport | null;
    tagBrowse: TagBrowseReport | null;
    globalGraph: GlobalGraphUiReport | null;
  };
  driver: Record<string, DriverOperationReport | null>;
  driverColdStart: {
    ok: boolean;
    code: string | null;
    dispatchMs: number | null;
    operationMs: number | null;
    sqlMs: number | null;
    phases: WorkerPhases | null;
  } | null;
  seam: { sqlMsObserved: boolean; phasesObserved: boolean };
}

export interface DependencyReport {
  kind: DependencyFile['kind'];
  path: string;
  decodedBytes: number;
  gzipBytes: number;
  http: ServerRecord | null;
  /**
   * The cold observation: the resource-timing entry whose `transferSize`
   * includes the encoded body. Cache-hit observations (reported as a
   * header-only `transferSize` on Chromium) are counted separately rather
   * than replacing it.
   */
  resource: ResourceEntry | null;
  resourceObservations: number;
  cacheHitObservations: number;
  requests: number;
  cacheState: 'network' | 'revalidated' | 'cache' | 'not-requested' | 'unknown';
}

interface TransferReport {
  headersSource: string;
  definitions: string[];
  dependencies: DependencyReport[];
  serverRecords: ServerRecord[];
  resources: ResourceEntry[];
}

type MeasuredDependency = DependencyFile & { decodedBytes: number; gzipBytes: number };

function requiresColdTransfer(dependency: DependencyFile): boolean {
  return dependency.kind !== 'wasm-glue' || basename(dependency.path) === 'sqlite-wasm.js';
}

export function dependencyTransferReports(
  dependencies: readonly MeasuredDependency[],
  serverRecords: readonly ServerRecord[],
  resources: readonly ResourceEntry[],
): { dependencies: DependencyReport[]; failures: string[] } {
  const failures: string[] = [];
  const reports = dependencies.map((dependency): DependencyReport => {
    const attempts = serverRecords.filter((record) => record.path === dependency.path);
    const http =
      attempts.find((record) => record.completion === 'finished' && record.status === 200) ??
      attempts.find((record) => record.completion === 'finished' && record.status === 304) ??
      null;
    const observed = resources.filter((entry) => entry.path === dependency.path);
    const resource =
      observed.find(
        (entry) => (entry.encodedBodySize ?? 0) > 0 && (entry.transferSize ?? 0) >= (entry.encodedBodySize ?? 0),
      ) ?? null;
    const cacheHits = observed.filter(
      (entry) => (entry.transferSize ?? 0) < (entry.encodedBodySize ?? 0),
    ).length;
    let cacheState: DependencyReport['cacheState'] = 'not-requested';
    if (http?.status === 200) cacheState = 'network';
    else if (http?.status === 304) cacheState = 'revalidated';
    else if (observed.some((entry) => (entry.transferSize ?? 0) < (entry.encodedBodySize ?? 0))) cacheState = 'cache';
    else if (attempts.length > 0 || observed.length > 0) cacheState = 'unknown';

    if (requiresColdTransfer(dependency) && http?.status !== 200) {
      failures.push(`${dependency.kind} ${dependency.path} has no finished HTTP 200 response`);
    }
    if (requiresColdTransfer(dependency) && resource === null) {
      failures.push(`${dependency.kind} ${dependency.path} has no cold browser resource-timing observation`);
    }

    return {
      kind: dependency.kind,
      path: dependency.path,
      decodedBytes: dependency.decodedBytes,
      gzipBytes: dependency.gzipBytes,
      http,
      resource,
      resourceObservations: observed.length,
      cacheHitObservations: cacheHits,
      requests: attempts.length,
      cacheState,
    };
  });
  return { dependencies: reports, failures };
}

interface ReadingReport {
  definition: string;
  zeroRequests: {
    readingPage: { beforeIntent: boolean; urls: string[] };
    mainPage: { beforeIntent: boolean; urls: string[] };
  };
  active: RenderTiming | null;
  inactiveJavaScript: RenderTiming | null;
  delta: {
    domContentLoadedEventEnd: number | null;
    loadEventEnd: number | null;
    firstContentfulPaint: number | null;
    transferredBytes: number | null;
  };
  regressionNote: string;
}

export interface WorkloadReport {
  id: string;
  size: number;
  topology: Topology;
  generator: GeneratorIdentity;
  fixture: FixtureIdentity | null;
  build: BuildIdentity | null;
  database: DatabaseIdentity | null;
  transfer: TransferReport | null;
  startup: StartupReport | null;
  preview: PreviewReport | null;
  queries: QueriesReport | null;
  reading: ReadingReport | null;
  checks: CheckResult[];
  failures: FailoverRecord[];
  elapsedSeconds: number;
}

export class WorkloadMeasurementError extends Error {
  readonly workload: WorkloadReport;
  readonly originalError: unknown;

  constructor(workload: WorkloadReport, originalError: unknown) {
    super(scrub(originalError));
    this.name = 'WorkloadMeasurementError';
    this.workload = workload;
    this.originalError = originalError;
    workload.failures.push({
      phase: originalError instanceof BenchmarkIdentityDriftError ? 'identity' : 'workload',
      message: scrub(originalError),
    });
  }
}

function emptyPreviewSample(): PreviewSample {
  return {
    intentToVisibleMs: null,
    hoverDelayMs: null,
    hoverDelaySource:
      'page observer: pointerover on the eligible link to #link-preview unhidden with text; no constant subtracted',
    visible: false,
    nonEmpty: false,
    targetSlug: null,
    targetTitle: null,
    titleMatched: null,
    panelTextSample: null,
    error: null,
  };
}

async function withFailure(
  workload: WorkloadReport,
  phase: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    workload.failures.push({ phase, message: scrub(error) });
  }
}

export async function captureCleanupFailure(
  failures: FailoverRecord[],
  phase: string,
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push({ phase, message: scrub(error) });
  }
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The browser version the workload runs observed; the report records one. */
let observedBrowserVersion: string | null = null;

/**
 * Measure one (size, topology) workload end to end.
 *
 * A failure inside a phase is recorded on the workload and later phases still
 * run, because a benchmark that stops at the first timeout measures less than
 * the one failure. The corpus directory is removed in `finally`; the report
 * keeps only its hash.
 */
async function measureWorkload(
  options: Options,
  browserSettings: ResolvedBenchmarkBrowser,
  cliPath: string,
  size: number,
  topology: Topology,
  expectedCandidate: CandidateIdentity,
): Promise<WorkloadReport> {
  const startedAt = Date.now();
  const id = `${size}-${topology}`;
  const request = generatorRequest(options, size, topology);
  const workload: WorkloadReport = {
    id,
    size,
    topology,
    generator: {
      name: 'scripts/generate-corpus.ts#generateCorpus',
      seed: options.seed,
      options: request,
      result: null,
      finalized: null,
    },
    fixture: null,
    build: null,
    database: null,
    transfer: null,
    startup: null,
    preview: null,
    queries: null,
    reading: null,
    checks: [],
    failures: [],
    elapsedSeconds: 0,
  };
  let root: string | undefined;
  let escapedFailure: { error: unknown } | null = null;
  let server: StaticServer | undefined;
  let browser: Browser | undefined;
  let db: DatabaseSync | undefined;
  const cleanup = (phase: string, action: () => void | Promise<void>): Promise<void> =>
    captureCleanupFailure(workload.failures, phase, action);
  try {
    root = mkdtempSync(join(tmpdir(), `anc-bench-${id}-`));
    scrubPaths.push(root);
    const contentDirectory = join(root, 'notes');
    mkdirSync(contentDirectory, { recursive: true });
    const generated = await generateCorpus(contentDirectory, workload.generator.options);
    workload.generator.result = {
      files: generated.files,
      published: generated.published,
      withheld: generated.withheld,
      assets: generated.assets,
      bytes: generated.bytes,
    };
    const corpusFinalization = finalizeCorpus(contentDirectory, size, workload.generator.result);
    workload.generator.finalized = corpusFinalization;
    workload.fixture = fixtureIdentity(contentDirectory);
    const corpusText = corpusTextStats(contentDirectory);

    assertCandidateIdentityStable(expectedCandidate, cliPath, `workload ${id} before build`, 'state');

    const buildStarted = Date.now();
    const build = spawnSync(process.execPath, [cliPath, 'build', '--content', 'notes', '--out', 'dist'], {
      cwd: root,
      encoding: 'utf8',
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    assertCandidateIdentityStable(expectedCandidate, cliPath, `workload ${id} after build`, 'state');
    workload.build = {
      seconds: round((Date.now() - buildStarted) / 1000, 2),
      cli: { basename: basename(cliPath), sha256: sha256File(cliPath) },
    };
    if (build.status !== 0) {
      throw new Error(`build exited ${String(build.status)}: ${(build.stderr || build.stdout).slice(0, 4000)}`);
    }

    const dist = join(root, 'dist');
    const dataDirectory = join(dist, 'data');
    const snapshots = existsSync(dataDirectory)
      ? readdirSync(dataDirectory).filter((name) => SNAPSHOT_FILE_PATTERN.test(name))
      : [];
    if (snapshots.length !== 1) throw new Error(`expected one finalized snapshot, found ${snapshots.length}`);
    const fileName = snapshots[0]!;
    const fileDigest = sha256File(join(dataDirectory, fileName));
    db = new DatabaseSync(join(dataDirectory, fileName), { readOnly: true });
    const finalized = corpusFinalization.result;
    const analysis = analyseDatabase(db, fileName, fileDigest, corpusText, finalized);
    workload.database = analysis.identity;
    if (!analysis.identity.digestMatchesFileName) {
      workload.failures.push({ phase: 'database', message: 'snapshot file name digest does not match its bytes' });
    }
    if (finalized.published !== analysis.identity.rows.nodes) {
      workload.failures.push({
        phase: 'database',
        message: `finalized corpus published ${finalized.published}, DB nodes ${analysis.identity.rows.nodes}`,
      });
    }
    if (size !== analysis.identity.rows.nodes) {
      workload.failures.push({
        phase: 'database',
        message: `requested ${size} published notes, DB nodes ${analysis.identity.rows.nodes}`,
      });
    }
    const plan = analysis.plan;
    const tagNodes =
      plan.tagKey === null
        ? []
        : queryRows<{ slug: string; title: string; language: string }>(
            db,
            `SELECT n.slug AS slug, n.title AS title, n.language AS language
             FROM tags AS t
             JOIN node_tags AS nt ON nt.tag_id = t.id
             JOIN nodes AS n ON n.id = nt.node_id
             WHERE t.key = ?
             ORDER BY n.slug`,
            [plan.tagKey],
          );

    const dependencies = dependencyFiles(dist, join(dist, 'notes', plan.pageSlug, 'index.html')).map((dependency) => {
      const bytes = readFileSync(dependency.file);
      return { ...dependency, decodedBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
    });
    const workerChunk = (() => {
      try {
        return workerScriptPath(dist);
      } catch {
        return null;
      }
    })();

    server = await startStaticServer(dist);
    const resources: ResourceEntry[] = [];
    const { chromium } = await import('playwright');
    browser = await chromium.launch(browserSettings.launchOptions);
    observedBrowserVersion = browser.version();
    const pageUrl = `${server.origin}/notes/${plan.pageSlug}/`;

    // --- F. Ordinary reading: inactive first, in its own fresh context ---
    const reading: ReadingReport = {
      definition: sqliteAssetDefinition(),
      zeroRequests: {
        readingPage: { beforeIntent: false, urls: [] },
        mainPage: { beforeIntent: false, urls: [] },
      },
      active: null,
      inactiveJavaScript: null,
      delta: {
        domContentLoadedEventEnd: null,
        loadEventEnd: null,
        firstContentfulPaint: null,
        transferredBytes: null,
      },
      regressionNote:
        'positive delta = the enhancement build renders later than the no-JS build under the same host, viewport, and throttle; the enhancements are lazy by contract, so a material positive delta implicates script download/evaluation rather than SQLite work',
    };
    workload.reading = reading;

    const inactiveContext = await browser.newContext({
      ...browserSettings.contextOptions,
      javaScriptEnabled: false,
    });
    try {
      const { page } = await openMeasuredPage(inactiveContext, options.throttle);
      await page.goto(pageUrl, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      reading.inactiveJavaScript = await navigationTiming(page);
    } finally {
      await cleanup('cleanup-inactive-context', () => inactiveContext.close());
    }

    const context = await browser.newContext(browserSettings.contextOptions);
    await installRecorder(context);
    try {
      // Active initial render, no intent of any kind, under the same throttle
      // as the inactive measurement so the delta is one variable.
      const { page: readingPage } = await openMeasuredPage(context, options.throttle);
      const readingRequests = sqliteAssetRequests(readingPage);
      await readingPage.goto(pageUrl, { waitUntil: 'load' });
      await readingPage.waitForTimeout(300);
      await readingPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await readingPage.waitForTimeout(300);
      reading.active = await navigationTiming(readingPage);
      reading.zeroRequests.readingPage = {
        beforeIntent: readingRequests.length === 0,
        urls: readingRequests.map(urlPath),
      };
      const delta = (active: number | null, inactive: number | null): number | null =>
        active === null || inactive === null ? null : round(active - inactive, 3);
      reading.delta = {
        domContentLoadedEventEnd: delta(reading.active.domContentLoadedEventEnd, reading.inactiveJavaScript?.domContentLoadedEventEnd ?? null),
        loadEventEnd: delta(reading.active.loadEventEnd, reading.inactiveJavaScript?.loadEventEnd ?? null),
        firstContentfulPaint: delta(reading.active.firstContentfulPaint, reading.inactiveJavaScript?.firstContentfulPaint ?? null),
        transferredBytes: delta(reading.active.transferredBytes, reading.inactiveJavaScript?.transferredBytes ?? null),
      };
      if (readingRequests.length > 0) {
        workload.failures.push({
          phase: 'ordinary-reading',
          message: `reading page requested SQLite assets before intent: ${readingRequests.map(urlPath).join(', ')}`,
        });
      }
      await collectResources(readingPage, 'reading-page', resources);
      await readingPage.close();

      let mainPage: Page | undefined;
      // --- B/C/D/E on the main page ---
      await withFailure(workload, 'preview-and-startup', async () => {
        const { page, session } = await openMeasuredPage(context, options.throttle);
        mainPage = page;
        await session.send('Performance.enable');
        const pageRequests = sqliteAssetRequests(page);
        const startup: StartupReport = {
          instrument:
            'CDP Performance.getMetrics on the page target: JSHeapUsedSize (main-thread JS heap) and ArrayBufferBytes when the browser reports it',
          blindSpots: [
            'main-thread JS heap only; not process RSS, not the Worker heap, not WASM linear memory',
            'the Worker target is not surfaced by Performance.getMetrics on the page session, so its heap and WASM memory are only visible through the runtime seam (phases.wasmMemoryBytes)',
            'CPU throttling (CDP Emulation.setCPUThrottlingRate) applies to the page target; the Worker target is not independently throttled, so this is simulation, never a physical device',
          ],
          heap: null,
          heapPeakNote: 'peak over the cold-intent polling window; steady is the last sample after the settle',
          worker: {
            firstReplyMs: null,
            phases: null,
            phasesNote: null,
            wasmMemoryBytes: null,
          },
        };
        workload.startup = startup;

        await page.goto(pageUrl, { waitUntil: 'load' });
        await page.waitForTimeout(300);
        reading.zeroRequests.mainPage = {
          beforeIntent: pageRequests.length === 0,
          urls: pageRequests.map(urlPath),
        };
        if (pageRequests.length > 0) {
          workload.failures.push({
            phase: 'ordinary-reading',
            message: `main page requested SQLite assets before intent: ${pageRequests.map(urlPath).join(', ')}`,
          });
        }

        workload.preview = { targetFromDb: null, cold: emptyPreviewSample(), warm: emptyPreviewSample() };
        workload.queries = {
          definitions: [
            'dispatch→result: armed request posted to observed successful snapshot-result on the page clock (event.ms)',
            'operationMs: the Worker reply’s own named-operation span after initialization',
            'sqlMs: required finite inner-SQL telemetry on every successful measured reply; cold replies also require complete phases',
            'graph render: the graph client’s graph-render event, reported apart from query and messaging cost',
          ],
          ui: { localGraph: null, tagBrowse: null, globalGraph: null },
          driver: {},
          driverColdStart: null,
          seam: { sqlMsObserved: false, phasesObserved: false },
        };
        await withFailure(workload, 'cold-warm-preview', async () => {
        const target = await firstEligibleLink(page);
        if (target === null) throw new Error('no eligible published note link on the measured page');
        const previewNode = queryRows<{ id: number; title: string; excerpt: string; language: string }>(
          db!,
          'SELECT id, title, excerpt, language FROM nodes WHERE slug = ?',
          [target.slug],
        )[0];
        if (previewNode === undefined) throw new Error(`preview target is absent from the DB: ${target.slug}`);
        const previewAliases = queryRows<{ alias: string }>(
          db!,
          'SELECT alias FROM aliases WHERE node_id = ? ORDER BY ordinal',
          [previewNode.id],
        ).map((row) => row.alias);
        const expectedPreview: RenderedPreviewShape = {
          title: previewTitle({ title: previewNode.title, excerpt: previewNode.excerpt, aliases: previewAliases }),
          excerpt: previewNode.excerpt,
          fragment: previewFragment(new URL(target.href, pageUrl).hash) ?? null,
          titleLanguage: previewNode.language,
          excerptLanguage: previewNode.language,
        };
        const polling = startHeapPolling(session);
        let coldSample = emptyPreviewSample();
        try {
          const coldStarted = Date.now();
          await page.locator('[data-bench-target-link]').hover();
          await page.locator('#link-preview').waitFor({ state: 'visible', timeout: HOVER_TIMEOUT_MS });
          coldSample.intentToVisibleMs = Date.now() - coldStarted;
          const coldRecorder = await readRecorder(page);
          const coldVisible =
            coldRecorder.preview.filter((observation) => observation.visibleAt !== null).at(-1) ?? null;
          if (coldVisible === null || coldVisible.slug !== target.slug) {
            throw new Error('the cold hover did not produce an observed preview for the marked link');
          }
          const coldMismatch = compareRenderedPreview(await readRenderedPreview(page), expectedPreview, 'cold preview');
          if (coldMismatch !== null) throw new Error(coldMismatch);
          const coldText = coldVisible.text ?? '';
          coldSample = {
            ...coldSample,
            hoverDelayMs: round(coldVisible.visibleAt! - coldVisible.intentAt, 3),
            visible: true,
            nonEmpty: coldText.trim() !== '',
            targetSlug: coldVisible.slug,
            targetTitle: previewNode.title,
            titleMatched: true,
            panelTextSample: coldText.slice(0, 200),
          };
          const coldReplies = coldRecorder.snapshot.filter((event) => event.type === 'preview');
          const firstReply = coldReplies.at(-1) ?? null;
          if (firstReply === null) throw new Error('cold preview produced no measured preview reply');
          const telemetryFailure = measuredEventFailure('cold preview', firstReply, true);
          if (telemetryFailure !== null) throw new Error(telemetryFailure);
          startup.worker.firstReplyMs = firstReply.ms;
          const phasesEvent = firstReply;
          startup.worker.phases = normalizePhases(phasesEvent.phases);
          startup.worker.wasmMemoryBytes = startup.worker.phases?.wasmMemoryBytes ?? null;
          startup.worker.phasesNote =
            'phases from the first armed snapshot-result detail';
        } catch (error) {
          coldSample.error = scrub(error);
          workload.failures.push({ phase: 'preview-cold', message: coldSample.error });
          startup.worker.phasesNote ??= 'the cold preview failed before any measured reply was observed';
        } finally {
          await page.waitForTimeout(STEADY_SETTLE_MS);
          startup.heap = await polling.stop();
        }

        // Warm preview: the same link after readiness.
        const warmSample = emptyPreviewSample();
        try {
          const panel = page.locator('#link-preview');
          if (!(await panel.isVisible())) throw new Error('the warm hover did not start from a visible cold panel');
           await page.mouse.move(0, 0);
            await panel.waitFor({ state: 'hidden', timeout: 5_000 });
            const hiddenRecorder = await readRecorder(page);
            const hiddenPreviewCount = hiddenRecorder.preview.length;
           await page.waitForTimeout(200);
           const warmStarted = Date.now();
           await page.locator('[data-bench-target-link]').hover();
           await panel.waitFor({ state: 'visible', timeout: WARM_PREVIEW_TIMEOUT_MS });
           warmSample.intentToVisibleMs = Date.now() - warmStarted;
           const warmRecorder = await readRecorder(page);
           const warmReplies = warmRecorder.snapshot.slice(hiddenRecorder.snapshot.length).filter((event) => event.type === 'preview');
           const warmReply = warmReplies.at(-1) ?? null;
           if (warmReply === null) throw new Error('warm preview produced no measured preview reply');
           const telemetryFailure = measuredEventFailure('warm preview', warmReply);
           if (telemetryFailure !== null) throw new Error(telemetryFailure);
           const warmVisible =
             warmRecorder.preview
               .slice(hiddenPreviewCount)
              .filter((observation) => observation.visibleAt !== null && observation.slug === target.slug)
              .at(-1) ?? null;
          if (warmVisible === null) {
            throw new Error(`the warm hover produced no fresh observed preview for ${target.slug}`);
          }
          const warmMismatch = compareRenderedPreview(await readRenderedPreview(page), expectedPreview, 'warm preview');
          if (warmMismatch !== null) throw new Error(warmMismatch);
          warmSample.hoverDelayMs = round(warmVisible.visibleAt! - warmVisible.intentAt, 3);
          warmSample.visible = true;
          warmSample.nonEmpty = (warmVisible.text ?? '').trim() !== '';
          warmSample.targetSlug = warmVisible.slug;
          warmSample.targetTitle = previewNode.title;
          warmSample.titleMatched = true;
          warmSample.panelTextSample = (warmVisible.text ?? '').slice(0, 200);
        } catch (error) {
          warmSample.error = scrub(error);
          workload.failures.push({ phase: 'preview-warm', message: warmSample.error });
        }
        workload.preview = { targetFromDb: null, cold: coldSample, warm: warmSample };
        });

        // --- E(1) real UI flow: repeated local-graph activation ---
        await withFailure(workload, 'ui-local-graph', async () => {
        const localGraph = {
          activations: 0,
          dispatchMs: [] as number[],
          operationMs: [] as number[],
          sqlMs: [] as number[],
          phases: null as WorkerPhases | null,
          renderMs: [] as number[],
          dispatchSummary: seriesOf([]),
        };
        const activate = page.locator('[data-graph-activate]');
        const activationCount = await activate.count();
        assertExactlyOneControl('local graph activation control', activationCount);
        const localOracle = graphOracleSelection(analysis.nodes, analysis.edges, {
          scope: 'local',
          centerSlug: plan.localCenter,
        });
        const localCenterNode = analysis.nodes.find((node) => node.slug === localOracle.center);
        if (localCenterNode === undefined) throw new Error(`local graph center is absent from the DB: ${plan.localCenter}`);
        const expectedRenderedLocal: RenderedSelectionShape = {
          nodes: [
            {
              slug: localCenterNode.slug,
              title: localCenterNode.title,
              language: localCenterNode.language ?? '',
            },
            ...localOracle.selection.nodes,
          ],
          edges: localOracle.selection.edges,
        };
        for (let index = 0; index < options.samples; index += 1) {
          try {
            await activate.click();
            await page.waitForFunction(
              (expected) =>
                ((window as unknown as { __benchSnapshot?: { type: string; ms: number | null }[] }).__benchSnapshot ?? [])
                  .filter((event) => event.type === 'localGraph' && event.ms !== null).length >= expected,
              index + 1,
              { timeout: 15_000 },
            );
            await page.waitForFunction(
              (expected) =>
                ((window as unknown as { __benchGraphRender?: { scope: string }[] }).__benchGraphRender ?? []).filter(
                  (event) => event.scope === 'local',
                ).length >= expected,
              index + 1,
              { timeout: 5_000 },
            );
            const mismatch = compareRenderedSelection(
              await readRenderedGraph(page),
              expectedRenderedLocal,
              `local graph sample ${index + 1}`,
            );
            if (mismatch !== null) throw new Error(mismatch);
            localGraph.activations += 1;
          } catch (error) {
            workload.failures.push({
              phase: 'ui-local-graph',
              message: `activation ${index + 1} failed: ${scrub(error)}`,
            });
            break;
          }
        }
        // A render follows its reply; wait with a bound for the drawings to
        // catch up rather than reading early and dropping the slowest draw.
        await page.waitForFunction(
          (expected) =>
            ((window as unknown as { __benchGraphRender?: { scope: string }[] }).__benchGraphRender ?? []).filter(
              (event) => event.scope === 'local',
            ).length >= expected,
          localGraph.activations,
          { timeout: 5_000 },
        );
        const events = await readRecorder(page);
        const localReplies = events.snapshot.filter((entry) => entry.type === 'localGraph');
        assertExactEventCount('local graph snapshot replies', localReplies.length, localGraph.activations);
        const localRenders = events.graphRender.filter((event) => event.scope === 'local');
        assertExactEventCount('local graph render', localRenders.length, localGraph.activations);
        if (localRenders.some((event) => event.ms === null || !Number.isFinite(event.ms))) {
          throw new Error('local graph render series contains a missing duration');
        }
        for (const [index, event] of localReplies.entries()) {
          const telemetryFailure = measuredEventFailure(`local graph sample ${index + 1}`, event);
          if (telemetryFailure !== null) throw new Error(telemetryFailure);
          localGraph.dispatchMs.push(round(event.ms!, 3));
          localGraph.operationMs.push(round(event.operationMs!, 3));
          localGraph.sqlMs.push(round(event.sqlMs!, 3));
          if (localGraph.phases === null && event.phases !== null) localGraph.phases = normalizePhases(event.phases);
        }
        assertExactSampleCount('local graph dispatch samples', localGraph.dispatchMs.length, localReplies.length);
        assertExactSampleCount('local graph operation samples', localGraph.operationMs.length, localReplies.length);
        assertExactSampleCount('local graph SQL samples', localGraph.sqlMs.length, localReplies.length);
        localGraph.renderMs = localRenders.map((event) => round(event.ms!, 3));
        localGraph.dispatchSummary = seriesOf(localGraph.dispatchMs);
        workload.queries!.ui.localGraph =
          localGraph.activations === 0 && localGraph.dispatchMs.length === 0 ? null : localGraph;
        workload.queries!.seam = {
          sqlMsObserved: localGraph.sqlMs.length > 0,
          phasesObserved: localGraph.phases !== null,
        };
        });
      });

      // --- E(1) real UI flow: tag browser on its own page ---
      await withFailure(workload, 'ui-tag-browse', async () => {
        if (plan.tagKey === null || plan.tagLabel === null || workload.queries === null) {
          throw new Error('the corpus has no tag to browse');
        }
        const { page } = await openMeasuredPage(context, options.throttle);
        try {
          await page.goto(`${server!.origin}/tags/`, { waitUntil: 'load' });
          await page.waitForSelector('#tag-browser-select', { timeout: 15_000 });
          const dispatchMs: number[] = [];
          const operationMs: number[] = [];
          const sqlMs: number[] = [];
          let phases: WorkerPhases | null = null;
          // A page's recorder accumulates every reply; each read absorbs only
          // the events that arrived since the last one, or a ten-page walk would
          // re-record page one ten times and report its duration as a trend.
          let absorbed = 0;
          let byTagTotal = 0;
          const assertRenderedPage = async (pageCount: number): Promise<void> => {
            const identity = await page.evaluate(() => {
              const select = document.querySelector<HTMLSelectElement>('#tag-browser-select');
              const current = document.querySelector<HTMLElement>('#tag-browser-current');
              return select === null || current === null || current.hidden
                ? null
                : { key: select.value, label: current.textContent ?? '' };
            });
            const identityMismatch = tagIdentityFailure(
              identity,
              { key: plan.tagKey!, label: plan.tagLabel! },
              `tag browser page ${pageCount}`,
            );
            if (identityMismatch !== null) throw new Error(identityMismatch);
            const expected = tagNodes.slice(0, Math.min(pageCount * TAG_PAGE_SIZE, tagNodes.length));
            await page.waitForFunction(
              (count) => document.querySelectorAll('#tag-browser-results li > a[href]').length >= count,
              expected.length,
              { timeout: 15_000 },
            );
            const mismatch = compareRenderedSelection(
              { nodes: await readRenderedNotes(page, '#tag-browser-results li > a[href]'), edges: [] },
              { nodes: expected, edges: [] },
              `tag browser ${plan.tagKey} page ${pageCount}`,
            );
            if (mismatch !== null) throw new Error(mismatch);
          };
          const absorb = (batch: { events: SnapshotEvent[]; total: number }): void => {
            for (const event of batch.events) {
              if (event.type !== 'byTag') continue;
              byTagTotal += 1;
              const telemetryFailure = measuredEventFailure(`tag browser sample ${byTagTotal}`, event, byTagTotal === 1);
              if (telemetryFailure !== null) throw new Error(telemetryFailure);
              dispatchMs.push(round(event.ms!, 3));
              operationMs.push(round(event.operationMs!, 3));
              sqlMs.push(round(event.sqlMs!, 3));
              if (phases === null && event.phases !== null) phases = normalizePhases(event.phases);
            }
            absorbed = batch.total;
          };
          await page.selectOption('#tag-browser-select', plan.tagKey);
          await page.waitForFunction(
            () =>
              ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).some(
                (event) => event.type === 'byTag',
              ),
            undefined,
            { timeout: 30_000 },
          );
          absorb(await readSnapshotEvents(page, absorbed));
          await assertRenderedPage(1);
          const tagPageBound = tagWalkPageBound(plan.tagMembers, TAG_PAGE_SIZE);
          const more = page.locator('#tag-browse-more');
          let pages = 1;
          while (await more.isVisible()) {
            if (pages >= tagPageBound) {
              throw new Error(
                `tag walk exposed More after the derived ${tagPageBound}-page bound for ${plan.tagMembers} members`,
              );
            }
            await more.click();
            await page.waitForFunction(
              (count) =>
                ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).length > count,
              absorbed,
              { timeout: 15_000 },
            );
            absorb(await readSnapshotEvents(page, absorbed));
            pages += 1;
            await assertRenderedPage(pages);
          }
          const notesShown = await page.locator('#tag-browser-results li').count();
          assertExactEventCount('tag browser page replies', byTagTotal, pages);
          if (pages > tagPageBound) {
            throw new Error(`tag browser walked ${pages} pages beyond derived bound ${tagPageBound}`);
          }
          if (notesShown !== plan.tagMembers) {
            throw new Error(`tag browser showed ${notesShown} notes; DB plan requires ${plan.tagMembers}`);
          }
          if (await more.isVisible()) throw new Error('tag browser More control remained visible after enumeration');
          assertExactSampleCount('tag browser dispatch samples', dispatchMs.length, byTagTotal);
          assertExactSampleCount('tag browser operation samples', operationMs.length, byTagTotal);
          assertExactSampleCount('tag browser SQL samples', sqlMs.length, byTagTotal);
          workload.queries!.ui.tagBrowse = {
            tagKey: plan.tagKey,
            pages,
            notesShown,
            dispatchMs,
            operationMs,
            sqlMs,
            phases,
            dispatchSummary: seriesOf(dispatchMs),
          };
          await collectResources(page, 'ui-tag-browse', resources);
        } finally {
          await page.close();
        }
      });

      // --- E(1) real UI flow: site graph, unfiltered then tag-filtered ---
      await withFailure(workload, 'ui-global-graph', async () => {
        if (workload.queries === null) throw new Error('query report was not initialized');
        const { page } = await openMeasuredPage(context, options.throttle);
        try {
          await page.goto(`${server!.origin}/graph/`, { waitUntil: 'load' });
          const activate = page.locator('[data-graph-activate]');
          if ((await activate.count()) === 0) throw new Error('the site graph exposes no activation control');
          await activate.click();
          await page.waitForFunction(
            () =>
              ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).some(
                (event) => event.type === 'globalGraph',
              ),
            undefined,
            { timeout: 30_000 },
          );
          await page.waitForFunction(
            () =>
              ((window as unknown as { __benchGraphRender?: { scope: string }[] }).__benchGraphRender ?? []).some(
                (event) => event.scope === 'global',
              ),
            undefined,
            { timeout: 5_000 },
          );
          const globalOracle = graphOracleSelection(analysis.nodes, analysis.edges, { scope: 'global' });
          const globalMismatch = compareRenderedSelection(
            await readRenderedGraph(page),
            globalOracle.selection,
            'global graph UI',
          );
          if (globalMismatch !== null) throw new Error(globalMismatch);
          if (plan.tagKey !== null) {
            await page.selectOption('[data-graph-tag]', plan.tagKey);
            await page.waitForFunction(
              () =>
                ((window as unknown as { __benchSnapshot?: { type: string }[] }).__benchSnapshot ?? []).filter(
                  (event) => event.type === 'globalGraph',
                ).length >= 2,
              undefined,
              { timeout: 30_000 },
            );
            await page.waitForFunction(
              () =>
                ((window as unknown as { __benchGraphRender?: { scope: string }[] }).__benchGraphRender ?? []).filter(
                  (event) => event.scope === 'global',
                ).length >= 2,
              undefined,
              { timeout: 5_000 },
            );
            const filteredOracle = graphOracleSelection(analysis.nodes, analysis.edges, {
              scope: 'global',
              candidateSlugs: new Set(tagNodes.map((node) => node.slug)),
            });
            const filteredMismatch = compareRenderedSelection(
              await readRenderedGraph(page),
              filteredOracle.selection,
              `global graph UI (${plan.tagKey})`,
            );
            if (filteredMismatch !== null) throw new Error(filteredMismatch);
          }
          const expectedGlobalReplies = plan.tagKey === null ? 1 : 2;
          const events = await readRecorder(page);
          const globals = events.snapshot.filter((event) => event.type === 'globalGraph');
          assertExactEventCount('global graph snapshot replies', globals.length, expectedGlobalReplies);
          for (const [index, event] of globals.entries()) {
            const telemetryFailure = measuredEventFailure(`global graph sample ${index + 1}`, event, index === 0);
            if (telemetryFailure !== null) throw new Error(telemetryFailure);
          }
          const globalRenders = events.graphRender.filter((event) => event.scope === 'global');
          assertExactEventCount('global graph render', globalRenders.length, expectedGlobalReplies);
          if (globalRenders.some((event) => event.ms === null || !Number.isFinite(event.ms))) {
            throw new Error('global graph render series contains a missing duration');
          }
          const globalDispatchMs = globals.map((event) => round(event.ms!, 3));
          const globalOperationMs = globals.map((event) => round(event.operationMs!, 3));
          assertExactSampleCount('global graph dispatch samples', globalDispatchMs.length, globals.length);
          assertExactSampleCount('global graph operation samples', globalOperationMs.length, globals.length);
          workload.queries!.ui.globalGraph = {
            unfilteredMs: globalDispatchMs.slice(0, 1),
            filteredMs: globalDispatchMs.slice(1),
            operationMs: globalOperationMs,
            renderMs: globalRenders.map((event) => round(event.ms!, 3)),
            phases: globals.find((event) => event.phases !== null)?.phases ?? null,
            filteredTag: plan.tagKey,
          };
          await collectResources(page, 'ui-global-graph', resources);
        } finally {
          await page.close();
        }
      });

      // --- E(2) driver Worker: armed named operations, cursor walks, invariants ---
      await withFailure(workload, 'driver', async () => {
        if (mainPage === undefined || workload.queries === null) throw new Error('the main page was not measured');
        if (workerChunk === null) throw new Error('the build carries no snapshot-worker chunk');
        await installDriver(mainPage, workerChunk);
        const driverReports: Record<string, DriverOperationReport | null> = {};
        const pageSize = MAX_PAGE_SIZE;

        const cold = await driverRequest(mainPage, 'preview', { slug: plan.previewSlug }, DRIVER_COLD_TIMEOUT_MS);
        workload.queries.driverColdStart = {
          ok: cold.ok,
          code: cold.code ?? null,
          dispatchMs: Number.isFinite(cold.dispatchMs) ? round(cold.dispatchMs, 3) : null,
          operationMs: numberOrNull(cold.operationMs),
          sqlMs: numberOrNull(cold.sqlMs),
          phases: normalizePhases(cold.phases),
        };
        if (!cold.ok) workload.failures.push({ phase: 'driver', message: `cold driver preview failed: ${cold.code ?? 'unknown'}` });
        else {
          const telemetryFailure = measuredReplyFailure('cold driver preview', cold, true);
          if (telemetryFailure !== null) workload.failures.push({ phase: 'driver', message: telemetryFailure });
        }
        if (cold.phases != null && workload.startup !== null && workload.startup.worker.phases === null) {
          workload.startup.worker.phases = normalizePhases(cold.phases);
          workload.startup.worker.wasmMemoryBytes = workload.startup.worker.phases?.wasmMemoryBytes ?? null;
          workload.startup.worker.phasesNote = 'phases from the driver Worker’s first armed reply (the page Worker’s seam was absent)';
        }

        const single = async (
          type: 'preview' | 'localGraph' | 'globalGraph',
          args: Record<string, unknown>,
          repetitions: number,
        ): Promise<{ timing: OperationTiming; first: DriverReply; failures: string[] }> => {
          const timing = timingOf();
          const failures: string[] = [];
          let first: DriverReply = cold;
          let successfulReplies = 0;
          for (let index = 0; index < repetitions; index += 1) {
            const reply = await driverRequest(mainPage!, type, args, DRIVER_WARM_TIMEOUT_MS);
            if (!reply.ok || reply.result === undefined) {
              failures.push(`${type} repetition ${index}: ${reply.code ?? 'failed'}`);
            } else {
              successfulReplies += 1;
              const telemetryFailure = measuredReplyFailure(`${type} repetition ${index}`, reply);
              if (telemetryFailure !== null) failures.push(telemetryFailure);
              else absorbTiming(timing, reply);
            }
            if (index === 0) first = reply;
          }
          try {
            finalizeTiming(timing, repetitions, successfulReplies, type);
          } catch (error) {
            failures.push(scrub(error));
            timing.dispatchSummary = seriesOf([]);
            timing.opSummary = seriesOf([]);
          }
          return { timing, first, failures };
        };

        const preview = await single('preview', { slug: plan.previewSlug }, options.samples);
        driverReports['preview'] = { ...preview.timing, failures: preview.failures };

        const backlinkRepetitions = Math.max(
          1,
          Math.min(options.samples, Math.floor(WALK_REQUEST_BUDGET / Math.max(1, Math.ceil(((analysis.inDegree.get(plan.backlinkAnchor) ?? 0) + 1) / pageSize)))),
        );
        const backlinks = await driveWalk(mainPage, 'backlinks', { slug: plan.backlinkAnchor }, pageSize, backlinkRepetitions);
        driverReports['backlinks'] = { ...backlinks.timing, pagesPerWalk: backlinks.pagesPerWalk, notesWalked: backlinks.notes.length, failures: backlinks.failures };

        const outgoingRepetitions = Math.max(
          1,
          Math.min(options.samples, Math.floor(WALK_REQUEST_BUDGET / Math.max(1, Math.ceil(((analysis.outDegree.get(plan.outgoingAnchor) ?? 0) + 1) / pageSize)))),
        );
        const outgoing = await driveWalk(mainPage, 'outgoing', { slug: plan.outgoingAnchor }, pageSize, outgoingRepetitions);
        driverReports['outgoing'] = { ...outgoing.timing, pagesPerWalk: outgoing.pagesPerWalk, notesWalked: outgoing.notes.length, failures: outgoing.failures };

        let tagWalk: WalkOutcome | null = null;
        if (plan.tagKey !== null) {
          const tagRepetitions = Math.max(
            1,
            Math.min(options.samples, Math.floor(WALK_REQUEST_BUDGET / Math.max(1, Math.ceil((plan.tagMembers + 1) / pageSize)))),
          );
          tagWalk = await driveWalk(
            mainPage,
            'byTag',
            { tagKey: plan.tagKey },
            pageSize,
            tagRepetitions,
            tagWalkPageBound(plan.tagMembers, pageSize),
          );
          driverReports['byTag'] = { ...tagWalk.timing, pagesPerWalk: tagWalk.pagesPerWalk, notesWalked: tagWalk.notes.length, failures: tagWalk.failures };
        } else {
          driverReports['byTag'] = null;
        }

        const local = await single('localGraph', { slug: plan.localCenter }, options.samples);
        driverReports['localGraph'] = { ...local.timing, failures: local.failures };
        const global = await single('globalGraph', {}, options.samples);
        driverReports['globalGraph'] = { ...global.timing, failures: global.failures };
        const globalTag = plan.tagKey === null ? null : await single('globalGraph', { tagKey: plan.tagKey }, options.samples);
        driverReports['globalGraphTag'] = globalTag === null ? null : { ...globalTag.timing, failures: globalTag.failures };

        workload.queries.driver = driverReports;
        for (const [operation, driverReport] of Object.entries(driverReports)) {
          if (driverReport === null) continue;
          for (const failure of driverReport.failures) {
            workload.failures.push({ phase: `driver-${operation}`, message: failure });
          }
        }
        workload.queries.seam = {
          sqlMsObserved: Object.values(driverReports).some(
            (report) => report !== null && report.sqlMs.length > 0,
          ),
          phasesObserved:
            Object.values(driverReports).some((report) => report !== null && report.phases !== null) ||
            workload.startup?.worker.phases !== null,
        };

        // Structural invariants and DB spot-checks, recorded rather than thrown.
        const check = (name: string, ok: boolean, detail: string): void => {
          workload.checks.push({ name, ok, detail });
          if (!ok) workload.failures.push({ phase: `check:${name}`, message: detail });
        };
        const dbTitle = (slug: string): string | null => {
          const value = queryValue(db!, 'SELECT title FROM nodes WHERE slug = ?', [slug]);
          return value === undefined ? null : String(value);
        };
        const dbSlugs = (sql: string, params: readonly (string | number | null)[]): string[] =>
          queryRows<{ slug: string }>(db!, sql, params).map((row) => row.slug);

        const previewReply = preview.first;
        if (previewReply.result?.preview != null) {
          const returned = previewReply.result.preview;
          check(
            'driver-preview',
            returned.slug === plan.previewSlug && returned.title === dbTitle(plan.previewSlug),
            `preview returned ${JSON.stringify(returned.slug)} / ${JSON.stringify(returned.title)} for ${plan.previewSlug}`,
          );
        } else {
          check('driver-preview', false, `preview returned no entry for ${plan.previewSlug}`);
        }

        const backlinkDb = dbSlugs(
          `SELECT s.slug AS slug FROM edges AS e
           JOIN nodes AS n ON n.id = e.target_id JOIN nodes AS s ON s.id = e.source_id
           WHERE n.slug = ? ORDER BY s.slug`,
          [plan.backlinkAnchor],
        );
        check(
          'driver-backlinks-walk',
          backlinks.failures.length === 0 &&
            backlinks.notes.length === backlinkDb.length &&
            backlinks.notes.every((note, index) => note.slug === backlinkDb[index]) &&
            backlinks.pagesPerWalk >= 1,
          `backlinks walk returned ${backlinks.notes.length} over ${backlinks.pagesPerWalk} pages; DB has ${backlinkDb.length}` +
            (backlinks.failures.length === 0 ? '' : `; ${backlinks.failures.join('; ')}`),
        );
        const outgoingDb = dbSlugs(
          `SELECT t.slug AS slug FROM edges AS e
           JOIN nodes AS n ON n.id = e.source_id JOIN nodes AS t ON t.id = e.target_id
           WHERE n.slug = ? ORDER BY t.slug`,
          [plan.outgoingAnchor],
        );
        check(
          'driver-outgoing-walk',
          outgoing.failures.length === 0 &&
            outgoing.notes.length === outgoingDb.length &&
            outgoing.notes.every((note, index) => note.slug === outgoingDb[index]),
          `outgoing walk returned ${outgoing.notes.length} over ${outgoing.pagesPerWalk} pages; DB has ${outgoingDb.length}` +
            (outgoing.failures.length === 0 ? '' : `; ${outgoing.failures.join('; ')}`),
        );

        if (tagWalk !== null && plan.tagKey !== null) {
          const tagMismatch = tagIdentityFailure(
            tagWalk.tag,
            { key: plan.tagKey, label: plan.tagLabel ?? '' },
            'driver byTag',
          );
          const memberMismatch = compareRenderedSelection(
            { nodes: tagWalk.notes, edges: [] },
            { nodes: tagNodes, edges: [] },
            'driver byTag members',
          );
          check(
            'driver-byTag-walk',
            tagWalk.failures.length === 0 &&
              tagMismatch === null &&
              memberMismatch === null,
            `byTag walk returned ${tagWalk.notes.length} over ${tagWalk.pagesPerWalk} pages for ${plan.tagKey}; DB has ${tagNodes.length}` +
              (tagMismatch === null ? '' : `; ${tagMismatch}`) +
              (memberMismatch === null ? '' : `; ${memberMismatch}`) +
              (tagWalk.failures.length === 0 ? '' : `; ${tagWalk.failures.join('; ')}`),
          );
        }

        const graphShape = (graph: NonNullable<NonNullable<DriverReply['result']>['graph']>): GraphSelectionShape => ({
          nodes: graph.nodes.map(({ slug, title, language }) => ({ slug, title, language })),
          edges: graph.edges,
          omitted: graph.omitted,
        });
        const localReply = local.first;
        const localGraph = localReply.result?.graph ?? null;
        if (localGraph !== null) {
          const oracle = graphOracleSelection(analysis.nodes, analysis.edges, {
            scope: 'local',
            centerSlug: plan.localCenter,
          });
          const mismatch = compareGraphSelection(graphShape(localGraph), oracle.selection, 'localGraph');
          const center = localGraph.center?.slug ?? null;
          check(
            'driver-localGraph',
            center === oracle.center && mismatch === null,
            mismatch ??
              `localGraph center ${String(center)} matched the DB-derived oracle with ` +
                `${localGraph.nodes.length}/${LOCAL_NODE_LIMIT} drawn nodes`,
          );
        } else {
          check('driver-localGraph', false, `localGraph returned no selection for ${plan.localCenter}`);
        }

        const globalReply = global.first;
        if (globalReply.ok && globalReply.result?.graph != null) {
          const graph = globalReply.result.graph;
          const oracle = graphOracleSelection(analysis.nodes, analysis.edges, { scope: 'global' });
          const mismatch = compareGraphSelection(graphShape(graph), oracle.selection, 'globalGraph');
          check(
            'driver-globalGraph',
            mismatch === null,
            mismatch ?? `globalGraph matched the DB-derived oracle with ${graph.nodes.length}/${GLOBAL_NODE_LIMIT} drawn nodes`,
          );
        } else {
          check('driver-globalGraph', false, `globalGraph did not answer: ${globalReply.code ?? 'unknown'}`);
        }

        if (globalTag !== null) {
          const graph = globalTag.first.result?.graph ?? null;
          if (graph !== null) {
            const members = new Set(
              dbSlugs(
                `SELECT n.slug AS slug FROM tags AS t
                 JOIN node_tags AS nt ON nt.tag_id = t.id JOIN nodes AS n ON n.id = nt.node_id
                 WHERE t.key = ? ORDER BY n.slug`,
                [plan.tagKey!],
              ),
            );
            const oracle = graphOracleSelection(analysis.nodes, analysis.edges, {
              scope: 'global',
              candidateSlugs: members,
            });
            const mismatch = compareGraphSelection(graphShape(graph), oracle.selection, `globalGraph(${plan.tagKey})`);
            check(
              'driver-globalGraphTag',
              mismatch === null,
              mismatch ??
                `globalGraph(${plan.tagKey}) matched the DB-derived oracle with ` +
                  `${graph.nodes.length}/${GLOBAL_NODE_LIMIT} drawn nodes from ${members.size} members`,
            );
          } else {
            check('driver-globalGraphTag', false, `tag-filtered globalGraph returned no selection`);
          }
        }

        // The visible panel was compared field-for-field at each timed completion.
        const previewReport = workload.preview;
        if (previewReport !== null) {
          const targetSlug = previewReport.cold.targetSlug;
          const title = targetSlug === null ? null : dbTitle(targetSlug);
          previewReport.targetFromDb = targetSlug === null || title === null ? null : { slug: targetSlug, title };
          for (const [label, sample] of [
            ['cold', previewReport.cold],
            ['warm', previewReport.warm],
          ] as const) {
            sample.targetTitle ??= title;
            if (sample.visible && !sample.nonEmpty) {
              workload.failures.push({ phase: 'preview', message: `${label} preview panel was empty` });
            }
            if (sample.visible && sample.titleMatched !== true) {
              workload.failures.push({
                phase: 'preview',
                message: `${label} preview was visible without an exact DB-backed field comparison`,
              });
            }
          }
        }

      });

      // Resource timings belong to the transfer evidence, so a driver failure
      // must not take them with it.
      await withFailure(workload, 'main-page-resources', async () => {
        if (mainPage !== undefined) await collectResources(mainPage, 'main-page', resources);
      });

      const transferEvidence = dependencyTransferReports(dependencies, server.records, resources);
      for (const message of transferEvidence.failures) workload.failures.push({ phase: 'transfer', message });
      workload.transfer = {
        headersSource: server.headersSource,
        definitions: [
          'fresh browser + context per workload: empty HTTP cache at every cold measurement',
          'the page Worker is shared within the document for preview, graph, and tag consumers; each document gets its own Worker, so a first UI operation on a later page includes that Worker’s cold start',
          'cacheState network = a 200 the server wrote to the wire; revalidated = a 304; cache = a resource-timing transferSize of 0 with decoded bytes',
          'dependency `resource` is the cold observation whose transferSize includes the encoded body; Chromium reports a cache hit as a header-only transferSize, and those observations are counted in cacheHitObservations',
        ],
        dependencies: transferEvidence.dependencies,
        serverRecords: server!.records,
        resources,
      };
    } finally {
      await cleanup('cleanup-context', () => context.close());
    }
  } catch (error) {
    escapedFailure = { error };
  } finally {
    workload.elapsedSeconds = round((Date.now() - startedAt) / 1000, 2);
    await cleanup('cleanup-db', () => db?.close());
    await cleanup('cleanup-browser', () => browser?.close());
    await cleanup('cleanup-server', () => server?.close());
    if (root !== undefined) {
      const workspace = root;
      await cleanup('cleanup-workspace', () =>
        rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
      );
    }
  }
  if (escapedFailure !== null) throw new WorkloadMeasurementError(workload, escapedFailure.error);
  return workload;
}

// --- Report and entry point -------------------------------------------------------

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

interface CandidatePackageContext {
  installedPackage: { name: string; version: string } | null;
  candidatePackageDirectory: string;
  packageRoot: string;
}

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

function findLockfile(directory: string): string | null {
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

function tarOutput(args: readonly string[], encoding: BufferEncoding | undefined = 'utf8'): string | Buffer {
  const result =
    encoding === undefined
      ? spawnSync('tar', args, { maxBuffer: 256 * 1024 * 1024 })
      : spawnSync('tar', args, { encoding, maxBuffer: 256 * 1024 * 1024 });
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
  const names = String(tarOutput(['-tzf', tarball]))
    .split(/\r?\n/)
    .filter((line) => line !== '');
  const details = String(tarOutput(['-tvzf', tarball]))
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
    tarOutput(['-xzf', tarball, '-C', extractionRoot]);
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

function expectedTarballBasename(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

function validateCandidateTarball(
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

function findTarball(directory: string, packageName: string | null, version: string | null): string | null {
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

function candidatePackageContext(cliPath: string): CandidatePackageContext {
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

function isPackageGeneratedPath(path: string): boolean {
  return (
    /^(?:\.astro|\.vite|\.cache)(?:\/|$)/.test(path) ||
    /(?:^|\/)node_modules(?:\/|$)/.test(path)
  );
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

interface BenchmarkReport {
  kind: 'anc-snapshot-benchmark';
  goal: '0008-acceptable-browser-cost';
  note: string;
  generatedAt: string;
  instrument: {
    sources: RepositoryIdentity | null;
  };
  candidate: CandidateIdentity | null;
  host: {
    platform: string;
    osType: string;
    osRelease: string;
    arch: string;
    cpus: number;
    totalMemoryBytes: number;
  };
  browser: string | null;
  browserProfile: ResolvedBenchmarkBrowser['report'];
  viewport: { width: number; height: number };
  network: { origin: string; throttling: string };
  throttling: { cpuRate: number; label: string } | null;
  quantileMethod: 'nearest-rank';
  cacheDefinitions: string[];
  measurementSeam: { requested: string; observed: { sqlMs: boolean; phases: boolean } | null };
  workloads: WorkloadReport[];
  failures: string[];
  elapsedSeconds: number;
}

function kib(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? 'n/a' : `${(bytes / 1024).toFixed(1)}KiB`;
}

/** One line per workload on stdout: counts and durations only, never a path. */
function printWorkload(workload: WorkloadReport): void {
  const dependencies = workload.transfer?.dependencies ?? [];
  const snapshot = dependencies.find((dependency) => dependency.kind === 'snapshot');
  const cold = workload.preview?.cold.intentToVisibleMs ?? null;
  const warm = workload.preview?.warm.intentToVisibleMs ?? null;
  const local = workload.queries?.ui.localGraph;
  const driverLocal = workload.queries?.driver['localGraph'] ?? null;
  const readingDelta = workload.reading?.delta.transferredBytes ?? null;
  process.stdout.write(
    `${workload.id}: published=${workload.database?.notesPublished ?? 'n/a'} ` +
      `withheld=${workload.database?.notesWithheld ?? 'n/a'} ` +
      `nodes=${workload.database?.rows.nodes ?? 'n/a'} edges=${workload.database?.rows.edges ?? 'n/a'} ` +
      `db=${kib(snapshot?.decodedBytes)} gzip=${kib(snapshot?.gzipBytes)} ` +
      `build=${workload.build?.seconds ?? 'n/a'}s coldPreview=${cold ?? 'n/a'}ms warmPreview=${warm ?? 'n/a'}ms ` +
      `uiLocalGraph p50=${local?.dispatchSummary.p50 ?? 'n/a'}ms p95=${local?.dispatchSummary.p95 ?? 'n/a'}ms n=${local?.dispatchMs.length ?? 0} ` +
      `driverLocalGraph p50=${driverLocal?.dispatchSummary.p50 ?? 'n/a'}ms p95=${driverLocal?.dispatchSummary.p95 ?? 'n/a'}ms n=${driverLocal?.dispatchMs.length ?? 0} ` +
      `readingTransferDelta=${readingDelta ?? 'n/a'}B failures=${workload.failures.length}\n`,
  );
}

async function main(): Promise<number> {
  const options = parseSnapshotOptions(process.argv.slice(2));
  const { devices } = await import('playwright');
  const browserSettings = resolveBenchmarkBrowser(options.browser, options.device, devices);
  const out =
    options.out ??
    join(benchmarkReportDirectory(ROOT), `benchmark-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const report: BenchmarkReport = {
    kind: 'anc-snapshot-benchmark',
    goal: '0008-acceptable-browser-cost',
    note:
      'This is goal 0008’s measurement instrument, not the recorded maintainer decision. A named device field is Chrome-family mobile emulation, and null means no device profile was requested. Null runtime measurements are never invented zeros.',
    generatedAt: new Date().toISOString(),
    instrument: {
      sources: null,
    },
    candidate: null,
    host: {
      platform: process.platform,
      osType: osType(),
      osRelease: osRelease(),
      arch: arch(),
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    browser: null,
    browserProfile: browserSettings.report,
    viewport: browserSettings.report.viewport,
    network: {
      origin: 'loopback static server',
      throttling: 'none; HTTP cache state and gzip negotiation are measured separately',
    },
    throttling:
      options.throttle > 1
        ? {
            cpuRate: options.throttle,
            label:
              'simulation (CDP Emulation.setCPUThrottlingRate on the page target only); device emulation does not emulate physical CPU hardware',
          }
        : null,
    quantileMethod: 'nearest-rank',
    cacheDefinitions: [
      'cold: fresh browser and fresh context for the workload, so the HTTP cache is empty when intent begins',
      'warm: the same ready Worker and imported snapshot within the same document',
      'each page gets its own Worker; the Worker is shared within one document across preview, tag, and graph consumers',
    ],
    measurementSeam: {
      requested:
        'armed requests carry measure: true; successful measured replies carry finite { dispatchMs, operationMs, sqlMs }; cold replies also carry complete phases = { totalMs, fetchMs, digestMs, wasmInitMs, importMs, wasmMemoryBytes }',
      observed: null,
    },
    workloads: [],
    failures: [],
    elapsedSeconds: 0,
  };
  const startedAt = Date.now();
  let exitCode = 0;
  let expectedCandidate: CandidateIdentity | null = null;
  let candidateCliPath: string | null = null;
  let identityFailureRecorded = false;
  try {
    const cliPath = options.cli === undefined ? join(ROOT, 'bin', 'anc.mjs') : resolve(process.cwd(), options.cli);
    candidateCliPath = cliPath;
    if (!existsSync(cliPath)) throw new Error(`--cli does not exist: ${basename(cliPath)}`);
    if (extname(cliPath).toLowerCase() === '.tgz') {
      throw new Error('--cli must point to an executable CLI, not a .tgz package archive');
    }
    const repository = repositoryIdentity(ROOT);
    report.instrument.sources = repository;
    expectedCandidate = candidateIdentity(cliPath, repository);
    report.candidate = expectedCandidate;
    assertRepositoryIdentityClean(repository);
    workloadLoop: for (const size of options.sizes) {
      for (const topology of options.topologies) {
        process.stdout.write(`benchmark ${size}/${topology}: generating and measuring\n`);
        try {
          const workload = await measureWorkload(options, browserSettings, cliPath, size, topology, expectedCandidate);
          try {
            assertCandidateIdentityStable(expectedCandidate, cliPath, `workload ${workload.id} after measurement`, 'state');
          } catch (error) {
            const message = scrub(error);
            workload.failures.push({ phase: 'identity', message });
            report.workloads.push(workload);
            report.failures.push(`${workload.id}: ${message}`);
            identityFailureRecorded = true;
            exitCode = 1;
            break workloadLoop;
          }
          report.workloads.push(workload);
          if (workload.failures.length > 0) exitCode = 1;
          printWorkload(workload);
        } catch (error) {
          const originalError = error instanceof WorkloadMeasurementError ? error.originalError : error;
          const failure: WorkloadReport =
            error instanceof WorkloadMeasurementError
              ? error.workload
              : {
                  id: `${size}-${topology}`,
                  size,
                  topology,
                  generator: {
                    name: 'scripts/generate-corpus.ts#generateCorpus',
                    seed: options.seed,
                    options: generatorRequest(options, size, topology),
                    result: null,
                    finalized: null,
                  },
                  fixture: null,
                  build: null,
                  database: null,
                  transfer: null,
                  startup: null,
                  preview: null,
                  queries: null,
                  reading: null,
                  checks: [],
                  failures: [{ phase: 'workload', message: scrub(originalError) }],
                  elapsedSeconds: 0,
                };
          report.workloads.push(failure);
          report.failures.push(`${failure.id}: ${scrub(originalError)}`);
          exitCode = 1;
          printWorkload(failure);
          if (originalError instanceof BenchmarkIdentityDriftError) {
            identityFailureRecorded = true;
            break workloadLoop;
          }
        }
      }
    }
    assertCandidateIdentityStable(expectedCandidate, cliPath, 'report finalization', 'full');
  } catch (error) {
    report.failures.push(scrub(error));
    if (error instanceof BenchmarkIdentityDriftError) identityFailureRecorded = true;
    exitCode = 1;
    process.stderr.write(`benchmark: ${scrub(error)}\n`);
  } finally {
    report.elapsedSeconds = round((Date.now() - startedAt) / 1000, 2);
    report.browser = observedBrowserVersion;
    const workloads = report.workloads;
    report.measurementSeam.observed = {
      sqlMs: workloads.some((workload) => workload.queries?.seam.sqlMsObserved === true),
      phases: workloads.some((workload) => workload.queries?.seam.phasesObserved === true || workload.startup?.worker.phases !== null),
    };
    try {
      if (!identityFailureRecorded && expectedCandidate !== null) {
        try {
          if (candidateCliPath !== null) {
            assertCandidateIdentityStable(expectedCandidate, candidateCliPath, 'report write', 'state');
          }
        } catch (error) {
          report.failures.push(scrub(error));
          exitCode = 1;
        }
      }
      const body = `${JSON.stringify(report, null, 2)}\n`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, body, 'utf8');
      const digest = createHash('sha256').update(body).digest('hex').slice(0, 12);
      const failureCount = report.workloads.reduce((sum, workload) => sum + workload.failures.length, 0) + report.failures.length;
      console.log(`benchmark: ${report.workloads.length} workloads, ${failureCount} failures, report sha256=${digest}`);
    } catch (error) {
      process.stderr.write(`benchmark: report write failed: ${scrub(error)}\n`);
      exitCode = 1;
    }
  }
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(scrub(error));
      process.exit(1);
    },
  );
}
