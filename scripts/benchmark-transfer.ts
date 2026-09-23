/**
 * Transfer evidence: the complete SQLite dependency set a build wrote, and the
 * join of that set against server records and browser resource timings.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SNAPSHOT_FILE_PATTERN } from '../src/lib/snapshot.ts';
import { WORKER_CHUNK_PATTERN } from '../tests/support/browser-site.ts';
import type { ServerRecord } from './benchmark-server.ts';
import type { ResourceEntry } from './benchmark-page.ts';

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

export interface TransferReport {
  headersSource: string;
  definitions: string[];
  dependencies: DependencyReport[];
  serverRecords: ServerRecord[];
  resources: ResourceEntry[];
}

export type MeasuredDependency = DependencyFile & { decodedBytes: number; gzipBytes: number };

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
