import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertExactEventCount,
  assertExactSampleCount,
  assertExactlyOneControl,
  fieldLengthDistribution,
} from '../scripts/benchmark-stats.ts';
import {
  assertCandidateIdentityStable,
  candidateIdentity,
  type CandidateIdentity,
} from '../scripts/benchmark-candidate.ts';
import {
  compareGraphSelection,
  compareRenderedPreview,
  compareRenderedSelection,
  graphOracleSelection,
  selectionEdges,
  tagIdentityFailure,
} from '../scripts/benchmark-oracle.ts';
import {
  collectResources,
  measuredEventFailure,
  openMeasuredPage,
  startHeapPolling,
} from '../scripts/benchmark-page.ts';
import { dependencyFiles, dependencyTransferReports } from '../scripts/benchmark-transfer.ts';
import { measuredReplyFailure, tagWalkPageBound } from '../scripts/benchmark-driver.ts';
import { recordResponseCompletion, startStaticServer } from '../scripts/benchmark-server.ts';
import {
  captureCleanupFailure,
  WorkloadMeasurementError,
  type WorkloadReport,
} from '../scripts/benchmark-workload-report.ts';
import { parseSnapshotOptions } from '../scripts/benchmark-snapshot.ts';
import { repositoryIdentity, type RepositoryIdentity } from '../scripts/benchmark-identity.ts';
import { spawnNpm } from '../scripts/npm-command.ts';
import { GLOBAL_NODE_LIMIT } from '../src/lib/graph-selection.ts';

const scratchDirectories: string[] = [];

afterEach(async () => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratchDirectories.push(directory);
  return directory;
}

function secondsFromNanoseconds(value: bigint): string {
  const text = value.toString().padStart(10, '0');
  return `${text.slice(0, -9)}.${text.slice(-9)}`;
}

function fakeRepositoryIdentity(): RepositoryIdentity {
  return {
    sha256: 'a'.repeat(64),
    files: 1,
    scope: 'test repository',
    method: 'test digest',
    gitHead: 'b'.repeat(40),
    worktreeDirty: false,
  };
}

function packCandidate(packageDirectory: string, destination: string): string {
  const result = spawnNpm(['pack', '--ignore-scripts', '--pack-destination', destination], packageDirectory);
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`npm pack failed: ${result.stderr || result.stdout || String(result.error)}`);
  }
  return join(destination, 'anc-0.1.0.tgz');
}

describe('snapshot benchmark correctness guards', () => {
  it('rejects the whole requested size matrix when any token is invalid', () => {
    for (const value of ['100,bad,1000', '100,,1000', '100,1.5', '100,0', '100,-1']) {
      expect(() => parseSnapshotOptions(['--sizes', value])).toThrow(/sizes accepts only positive integers/);
    }
    expect(parseSnapshotOptions(['--sizes', '100,1000']).sizes).toEqual([100, 1000]);
  });

  it('fails when a required render-event series is short', () => {
    expect(() => assertExactEventCount('local graph render', 1, 2)).toThrow(/expected 2 events, observed 1/);
    expect(() => assertExactEventCount('local graph render', 2, 2)).not.toThrow();
  });

  it('fails closed on incomplete measured telemetry and sample summaries', () => {
    expect(
      measuredReplyFailure('preview', { dispatchMs: 1, operationMs: 2, sqlMs: undefined, phases: null }),
    ).toMatch(/non-finite sqlMs/);
    expect(
      measuredEventFailure('cold preview', { type: 'preview', ms: 1, operationMs: 2, sqlMs: 3, phases: null }, true),
    ).toMatch(/no complete phases/);
    const malformedPhases = {
      totalMs: '10',
      fetchMs: 4,
      digestMs: 1,
      wasmInitMs: 3,
      importMs: 2,
      wasmMemoryBytes: 8 * 1024 * 1024,
    } as never;
    expect(
      measuredReplyFailure(
        'cold preview',
        { dispatchMs: 1, operationMs: 2, sqlMs: 3, phases: malformedPhases },
        true,
      ),
    ).toMatch(/no complete phases/);
    expect(
      measuredEventFailure(
        'cold preview',
        { type: 'preview', ms: 1, operationMs: 2, sqlMs: 3, phases: malformedPhases },
        true,
      ),
    ).toMatch(/no complete phases/);
    const phasesWithText = {
      totalMs: 10,
      fetchMs: 4,
      digestMs: 1,
      wasmInitMs: 3,
      importMs: 2,
      wasmMemoryBytes: 8 * 1024 * 1024,
      path: 'C:\\private\\snapshot.sqlite',
    } as never;
    expect(
      measuredReplyFailure(
        'cold preview',
        { dispatchMs: 1, operationMs: 2, sqlMs: 3, phases: phasesWithText },
        true,
      ),
    ).toMatch(/no complete phases/);
    expect(
      measuredEventFailure(
        'cold preview',
        { type: 'preview', ms: 1, operationMs: 2, sqlMs: 3, phases: phasesWithText },
        true,
      ),
    ).toMatch(/no complete phases/);
    expect(() => assertExactSampleCount('preview SQL', 2, 3)).toThrow(/expected 3 successful samples, observed 2/);
  });

  it('requires exactly one local graph control, including the duplicate and absent branches', () => {
    expect(() => assertExactlyOneControl('local graph activation control', 0)).toThrow(/observed 0/);
    expect(() => assertExactlyOneControl('local graph activation control', 2)).toThrow(/observed 2/);
    expect(() => assertExactlyOneControl('local graph activation control', 1)).not.toThrow();
  });

  it('captures cleanup failures without replacing populated workload failures', async () => {
    const failures = [{ phase: 'driver', message: 'partial evidence' }];
    await captureCleanupFailure(failures, 'cleanup-browser', async () => {
      throw new Error('browser close failed');
    });
    expect(failures).toEqual([
      { phase: 'driver', message: 'partial evidence' },
      { phase: 'cleanup-browser', message: 'browser close failed' },
    ]);
  });

  it('records a server response only when finish or close fires', () => {
    const response = new EventEmitter();
    const completions: string[] = [];
    recordResponseCompletion(response as never, (completion) => completions.push(completion));

    expect(completions).toEqual([]);
    response.emit('finish');
    expect(completions).toEqual(['finished']);
    response.emit('close');
    expect(completions).toEqual(['finished']);
  });

  it('preserves populated workload evidence and its original failure', () => {
    const workload = {
      id: '100-sparse',
      fixture: { sha256: 'fixture' },
      build: { seconds: 1 },
      database: { file: 'site.sqlite' },
      failures: [{ phase: 'database', message: 'partial evidence' }],
    } as unknown as WorkloadReport;
    const cause = new Error('late setup failed');
    const failure = new WorkloadMeasurementError(workload, cause);

    expect(failure.workload).toBe(workload);
    expect(failure.originalError).toBe(cause);
    expect(failure.workload.fixture).toEqual({ sha256: 'fixture' });
    expect(failure.workload.build).toEqual({ seconds: 1 });
    expect(failure.workload.database).toEqual({ file: 'site.sqlite' });
    expect(failure.workload.failures).toEqual([
      { phase: 'database', message: 'partial evidence' },
      { phase: 'workload', message: 'late setup failed' },
    ]);
  });

  it('fails closed when page, Worker, or CDP telemetry cannot be read', async () => {
    await expect(
      collectResources(
        {
          evaluate: async () => {
            throw new Error('page probe failed');
          },
          workers: () => [],
        } as never,
        'page-probe',
        [],
      ),
    ).rejects.toThrow(/page-probe page resource timing failed: page probe failed/);

    await expect(
      collectResources(
        {
          evaluate: async () => [],
          workers: () => [
            {
              evaluate: async () => {
                throw new Error('worker probe failed');
              },
            },
          ],
        } as never,
        'worker-probe',
        [],
      ),
    ).rejects.toThrow(/worker-probe worker 1 resource timing failed: worker probe failed/);

    await expect(
      startHeapPolling({ send: async () => Promise.reject(new Error('metrics failed')) } as never).stop(),
    ).rejects.toThrow(/Performance.getMetrics failed: metrics failed/);
    await expect(startHeapPolling({ send: async () => ({ metrics: [] }) } as never).stop()).rejects.toThrow(
      /returned 0 usable JSHeapUsedSize samples; need at least 2/,
    );
    await expect(
      startHeapPolling({ send: async () => ({ metrics: [{ name: 'JSHeapUsedSize', value: 1234 }] }) } as never).stop(),
    ).rejects.toThrow(/returned 1 usable JSHeapUsedSize samples; need at least 2/);
    const polling = startHeapPolling({
      send: async () => ({ metrics: [{ name: 'JSHeapUsedSize', value: 1234 }] }),
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 110));
    await expect(polling.stop()).resolves.toMatchObject({ steadyJsHeapBytes: 1234, arrayBufferObserved: false });
  });

  it('configures the page target before a measured navigation can occur', async () => {
    const calls: string[] = [];
    const session = {
      send: async (method: string, params: unknown) => {
        calls.push(`${method}:${JSON.stringify(params)}`);
      },
    };
    const page = { close: async () => calls.push('close') };
    const context = {
      newPage: async () => {
        calls.push('newPage');
        return page;
      },
      newCDPSession: async () => {
        calls.push('newCDPSession');
        return session;
      },
    } as never;
    await openMeasuredPage(context, 4);
    expect(calls).toEqual(['newPage', 'newCDPSession', 'Emulation.setCPUThrottlingRate:{"rate":4}']);
  });

  it('derives a tag walk bound from the planned member count', () => {
    expect(tagWalkPageBound(10_000, 50)).toBe(200);
    expect(tagWalkPageBound(51, 50)).toBe(2);
    expect(tagWalkPageBound(0, 50)).toBe(1);
  });

  it('rejects a graph with a missing directed edge even when its node set is valid', () => {
    const expected = {
      nodes: [
        { slug: 'alpha', title: 'Alpha', language: 'en' },
        { slug: 'beta', title: 'Beta', language: 'en' },
      ],
      edges: [{ from: 'alpha', to: 'beta' }],
      omitted: 0,
    };
    const mismatch = compareGraphSelection(
      { nodes: expected.nodes, edges: [], omitted: 0 },
      expected,
      'globalGraph',
    );
    expect(mismatch).toMatch(/edges differ/);
  });

  it('binds rendered preview, node identities, and directed edges to exact oracle values', () => {
    const preview = {
      title: 'Alpha (A)',
      excerpt: 'Exact excerpt',
      fragment: '#section',
      titleLanguage: 'en',
      excerptLanguage: 'en',
    };
    expect(compareRenderedPreview(preview, preview, 'preview')).toBeNull();
    expect(compareRenderedPreview({ ...preview, excerpt: 'Stale excerpt' }, preview, 'preview')).toMatch(
      /rendered preview differs/,
    );

    const expected = {
      nodes: [
        { slug: 'alpha', title: 'Alpha', language: 'en' },
        { slug: 'beta', title: 'Beta', language: 'en' },
      ],
      edges: [{ from: 'alpha', to: 'beta' }],
    };
    expect(compareRenderedSelection(expected, expected, 'graph')).toBeNull();
    expect(
      compareRenderedSelection(
        { nodes: expected.nodes, edges: [{ from: 'beta', to: 'alpha' }] },
        expected,
        'graph',
      ),
    ).toMatch(/rendered edges differ/);
    expect(
      compareRenderedSelection(
        { nodes: [{ ...expected.nodes[0]!, slug: 'wrong' }, expected.nodes[1]!], edges: expected.edges },
        expected,
        'graph',
      ),
    ).toMatch(/rendered nodes differ/);
    expect(tagIdentityFailure({ key: 'garden', label: 'Garden' }, { key: 'garden', label: 'Garden' }, 'tag')).toBeNull();
    expect(tagIdentityFailure({ key: 'garden', label: 'Stale' }, { key: 'garden', label: 'Garden' }, 'tag')).toMatch(
      /tag identity differs/,
    );
  });

  it('derives ranked nodes and directed induced edges from the shared graph contract', () => {
    const oracle = graphOracleSelection(
      [
        { id: 1, slug: 'center', title: 'Center', language: 'en' },
        { id: 2, slug: 'alpha', title: 'Alpha', language: 'en' },
        { id: 3, slug: 'beta', title: 'Beta', language: 'en' },
      ],
      [
        { from: 'center', to: 'alpha' },
        { from: 'beta', to: 'center' },
        { from: 'alpha', to: 'beta' },
      ],
      { scope: 'local', centerSlug: 'center' },
    );
    expect(oracle.center).toBe('center');
    expect(oracle.selection.nodes.map((node) => node.slug)).toEqual(['alpha', 'beta']);
    expect(oracle.selection.edges).toEqual([
      { from: 'alpha', to: 'beta' },
      { from: 'beta', to: 'center' },
      { from: 'center', to: 'alpha' },
    ]);
  });

  it('derives a filtered global graph with deterministic ranking and directed edges', () => {
    const oracle = graphOracleSelection(
      [
        { id: 1, slug: 'alpha', title: 'Alpha', language: 'en' },
        { id: 2, slug: 'beta', title: 'Zulu', language: 'en' },
        { id: 3, slug: 'gamma', title: 'Beta', language: 'en' },
        { id: 4, slug: 'excluded', title: 'Excluded', language: 'en' },
      ],
      [
        { from: 'alpha', to: 'alpha' },
        { from: 'alpha', to: 'beta' },
        { from: 'beta', to: 'alpha' },
        { from: 'gamma', to: 'alpha' },
        { from: 'excluded', to: 'alpha' },
      ],
      { scope: 'global', candidateSlugs: new Set(['alpha', 'beta', 'gamma']) },
    );

    expect(oracle.center).toBeNull();
    expect(oracle.selection.nodes.map((node) => node.slug)).toEqual(['alpha', 'gamma', 'beta']);
    expect(oracle.selection.edges).toEqual([
      { from: 'alpha', to: 'beta' },
      { from: 'beta', to: 'alpha' },
      { from: 'gamma', to: 'alpha' },
    ]);
    expect(oracle.selection.omitted).toBe(0);
  });

  it('truncates the global graph at the shared limit and reports omitted nodes', () => {
    const nodes = Array.from({ length: GLOBAL_NODE_LIMIT + 1 }, (_, index) => ({
      id: index + 1,
      slug: `node-${String(index).padStart(2, '0')}`,
      title: 'Same title',
      language: 'en',
    }));

    const oracle = graphOracleSelection(nodes, [], { scope: 'global' });
    expect(oracle.selection.nodes).toHaveLength(GLOBAL_NODE_LIMIT);
    expect(oracle.selection.nodes.at(-1)?.slug).toBe(`node-${GLOBAL_NODE_LIMIT - 1}`);
    expect(oracle.selection.edges).toEqual([]);
    expect(oracle.selection.omitted).toBe(1);
  });

  it('reads directed edges without reserved-word SQL aliases', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`
        CREATE TABLE nodes (id INTEGER PRIMARY KEY, slug TEXT NOT NULL);
        CREATE TABLE edges (source_id INTEGER NOT NULL, target_id INTEGER NOT NULL);
        INSERT INTO nodes (id, slug) VALUES (1, 'beta'), (2, 'alpha');
        INSERT INTO edges (source_id, target_id) VALUES (1, 2);
      `);
      expect(selectionEdges(db)).toEqual([{ from: 'beta', to: 'alpha' }]);
    } finally {
      db.close();
    }
  });

  it('records absent and empty values in material field-length distributions', () => {
    expect(fieldLengthDistribution(['title', '', '中文', null, undefined])).toMatchObject({
      n: 3,
      min: 0,
      max: 5,
      absent: 2,
      empty: 1,
    });
  });

  it('includes the unique main-thread snapshot client in the dependency set', () => {
    const dist = scratch('anc-benchmark-dependencies-');
    mkdirSync(join(dist, 'data'), { recursive: true });
    mkdirSync(join(dist, 'wasm'), { recursive: true });
    mkdirSync(join(dist, '_astro'), { recursive: true });
    mkdirSync(join(dist, 'notes', 'alpha'), { recursive: true });
    writeFileSync(join(dist, 'data', `site.${'a'.repeat(64)}.sqlite`), 'db', 'utf8');
    writeFileSync(join(dist, 'wasm', 'sqlite-wasm.js'), 'export default {};', 'utf8');
    writeFileSync(join(dist, 'wasm', `sqlite3.${'b'.repeat(64)}.wasm`), 'wasm', 'utf8');
    writeFileSync(join(dist, '_astro', 'snapshot-worker-test.js'), 'self.onmessage = () => {};', 'utf8');
    writeFileSync(join(dist, '_astro', 'preload-test.js'), 'export const preload = true;', 'utf8');
    writeFileSync(
      join(dist, '_astro', 'layout-test.js'),
      'import "./preload-test.js"; new Worker(new URL("./snapshot-worker-test.js", import.meta.url), { type: "module" });',
      'utf8',
    );
    const entryHtml = join(dist, 'notes', 'alpha', 'index.html');
    writeFileSync(entryHtml, '<script type="module" src="/_astro/layout-test.js"></script>', 'utf8');

    expect(dependencyFiles(dist, entryHtml).map(({ kind, path }) => ({ kind, path }))).toContainEqual({
      kind: 'snapshot-client',
      path: '/_astro/layout-test.js',
    });
    expect(dependencyFiles(dist, entryHtml).map(({ kind, path }) => ({ kind, path }))).toContainEqual({
      kind: 'snapshot-client',
      path: '/_astro/preload-test.js',
    });
    writeFileSync(
      join(dist, '_astro', 'duplicate-client.js'),
      'new Worker(new URL("./snapshot-worker-test.js", import.meta.url));',
      'utf8',
    );
    expect(dependencyFiles(dist, entryHtml).filter((dependency) => dependency.kind === 'snapshot-client')).toHaveLength(2);
    writeFileSync(
      join(dist, '_astro', 'layout-test.js'),
      'import "./preload-test.js"; import "./duplicate-client.js"; new Worker(new URL("./snapshot-worker-test.js", import.meta.url));',
      'utf8',
    );
    expect(() => dependencyFiles(dist, entryHtml)).toThrow(/expected one snapshot client chunk, found 2/);
  });

  it('requires finished network and resource observations for runtime dependencies', () => {
    const dependency = {
      kind: 'snapshot-client' as const,
      path: '/_astro/client.js',
      file: 'client.js',
      decodedBytes: 100,
      gzipBytes: 70,
    };
    const aborted = {
      path: dependency.path,
      method: 'GET',
      status: 200,
      completion: 'aborted' as const,
      cacheControl: 'public, max-age=31536000, immutable',
      contentEncoding: 'gzip',
      contentLength: '70',
      bytesServed: null,
      startedAtMs: 0,
      endedAtMs: 1,
    };
    const finished = { ...aborted, completion: 'finished' as const, bytesServed: 70, endedAtMs: 2 };
    const resource = {
      source: 'page' as const,
      page: 'reading-page',
      path: dependency.path,
      encodedBodySize: 70,
      decodedBodySize: 100,
      transferSize: 120,
      duration: 1,
      responseStatus: 200,
      initiatorType: 'script',
    };

    const complete = dependencyTransferReports([dependency], [aborted, finished], [resource]);
    expect(complete.failures).toEqual([]);
    expect(complete.dependencies[0]).toMatchObject({ http: finished, requests: 2, cacheState: 'network' });

    const unusedGlue = {
      kind: 'wasm-glue' as const,
      path: '/wasm/sqlite3-opfs-async-proxy.js',
      file: 'sqlite3-opfs-async-proxy.js',
      decodedBytes: 10,
      gzipBytes: 8,
    };
    expect(dependencyTransferReports([unusedGlue], [], []).failures).toEqual([]);

    const incomplete = dependencyTransferReports([dependency], [aborted], []);
    expect(incomplete.dependencies[0]?.http).toBeNull();
    expect(incomplete.failures).toEqual([
      'snapshot-client /_astro/client.js has no finished HTTP 200 response',
      'snapshot-client /_astro/client.js has no cold browser resource-timing observation',
    ]);
  });

  it('binds packaged identity to runtime dependency bytes, versions, and a nearby tarball', () => {
    const root = scratch('anc-benchmark-candidate-');
    const packageDirectory = join(root, 'node_modules', 'anc');
    const dependencyDirectory = join(root, 'node_modules', 'runtime-dependency');
    mkdirSync(join(packageDirectory, 'bin'), { recursive: true });
    mkdirSync(dependencyDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: 'anc',
        version: '0.1.0',
        dependencies: { 'runtime-dependency': '1.0.0' },
        optionalDependencies: { 'optional-dependency': '1.0.0' },
        devDependencies: { 'dev-dependency': '1.0.0' },
      }) + '\n',
      'utf8',
    );
    const cli = join(packageDirectory, 'bin', 'anc.mjs');
    writeFileSync(cli, '#!/usr/bin/env node\n', 'utf8');
    mkdirSync(join(packageDirectory, 'src', 'pages', 'collections'), { recursive: true });
    writeFileSync(join(packageDirectory, 'src', 'pages', 'collections', '[slug].astro'), '<h1>literal path</h1>\n', 'utf8');
    writeFileSync(
      join(dependencyDirectory, 'package.json'),
      '{"name":"runtime-dependency","version":"1.0.0","dependencies":{"transitive-dependency":"1.0.0"},"peerDependencies":{"peer-dependency":"1.0.0"}}\n',
      'utf8',
    );
    writeFileSync(join(dependencyDirectory, 'index.js'), 'export const runtime = true;\n', 'utf8');
    const transitiveDirectory = join(root, 'node_modules', 'transitive-dependency');
    mkdirSync(transitiveDirectory, { recursive: true });
    writeFileSync(join(transitiveDirectory, 'package.json'), '{"name":"transitive-dependency","version":"1.0.0"}\n', 'utf8');
    writeFileSync(join(transitiveDirectory, 'index.js'), 'export const transitive = true;\n', 'utf8');
    const optionalDependencyDirectory = join(root, 'node_modules', 'optional-dependency');
    mkdirSync(optionalDependencyDirectory, { recursive: true });
    writeFileSync(join(optionalDependencyDirectory, 'package.json'), '{"name":"optional-dependency","version":"1.0.0"}\n', 'utf8');
    writeFileSync(join(optionalDependencyDirectory, 'index.js'), 'export const optional = true;\n', 'utf8');
    const peerDependencyDirectory = join(root, 'node_modules', 'peer-dependency');
    mkdirSync(peerDependencyDirectory, { recursive: true });
    writeFileSync(join(peerDependencyDirectory, 'package.json'), '{"name":"peer-dependency","version":"1.0.0"}\n', 'utf8');
    writeFileSync(join(peerDependencyDirectory, 'index.js'), 'export const peer = true;\n', 'utf8');
    const devDependencyDirectory = join(root, 'node_modules', 'dev-dependency');
    mkdirSync(devDependencyDirectory, { recursive: true });
    writeFileSync(join(devDependencyDirectory, 'package.json'), '{"name":"dev-dependency","version":"1.0.0"}\n', 'utf8');
    writeFileSync(join(devDependencyDirectory, 'index.js'), 'export const dev = true;\n', 'utf8');
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
    const tarball = packCandidate(packageDirectory, root);

    const dependencyFile = join(dependencyDirectory, 'index.js');
    utimesSync(dependencyFile, '1700000000.000000000', '1700000000.000000000');
    const candidate: CandidateIdentity = candidateIdentity(cli, fakeRepositoryIdentity());
    const forwardSlashCandidate = candidateIdentity(cli.replaceAll('\\', '/'), fakeRepositoryIdentity());
    expect(forwardSlashCandidate.installedPackage).toEqual({ name: 'anc', version: '0.1.0' });
    expect(candidate.runtime.node).toBe(process.version);
    expect(candidate.runtime.packageManager).not.toBeNull();
    expect(candidate.runtimeDependencyTree?.files).toBeGreaterThan(3);
    expect(candidate.lockfile?.basename).toBe('package-lock.json');
    expect(candidate.tarball).toMatchObject({
      basename: 'anc-0.1.0.tgz',
      bytes: readFileSync(tarball).byteLength,
      sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
    });
    expect(candidate.tarball?.state.method).toMatch(/mtimeNs/);
    expect(candidate.runtimeDependencyTree?.stateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.runtimeDependencyTree?.stateMethod).toMatch(/mtimeNs/);

    mkdirSync(join(root, 'node_modules', '.vite', 'deps'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.vite', 'deps', 'generated.js'), 'derived cache\n', 'utf8');
    const withGeneratedCache = candidateIdentity(cli, fakeRepositoryIdentity());
    expect(withGeneratedCache.runtimeDependencyTree).toEqual(candidate.runtimeDependencyTree);

    mkdirSync(join(packageDirectory, '.astro'), { recursive: true });
    mkdirSync(join(packageDirectory, '.vite', 'deps'), { recursive: true });
    mkdirSync(join(packageDirectory, 'node_modules', '.vite', 'deps'), { recursive: true });
    writeFileSync(join(packageDirectory, '.astro', 'content.d.ts'), 'generated types\n', 'utf8');
    writeFileSync(join(packageDirectory, '.vite', 'deps', 'generated.js'), 'package cache\n', 'utf8');
    writeFileSync(join(packageDirectory, 'node_modules', '.vite', 'deps', 'nested.js'), 'nested cache\n', 'utf8');
    const withPackageCaches = candidateIdentity(cli, fakeRepositoryIdentity());
    expect(withPackageCaches.installedPackageTree).toEqual(candidate.installedPackageTree);

    const identityCandidate = candidateIdentity(cli, repositoryIdentity(process.cwd()));
    const originalDependency = readFileSync(dependencyFile);
    const originalState = statSync(dependencyFile, { bigint: true });
    const mutatedDependency = Buffer.from(originalDependency);
    mutatedDependency[0] = mutatedDependency[0] === 0x65 ? 0x45 : 0x65;
    try {
      writeFileSync(dependencyFile, mutatedDependency);
      expect(() => assertCandidateIdentityStable(identityCandidate, cli, 'dependency state check', 'state')).toThrow(
        /benchmark identity drift detected at dependency state check/,
      );
      utimesSync(dependencyFile, secondsFromNanoseconds(originalState.atimeNs), secondsFromNanoseconds(originalState.mtimeNs));
      expect(() => assertCandidateIdentityStable(identityCandidate, cli, 'same-size state check', 'state')).not.toThrow();
      expect(() => assertCandidateIdentityStable(identityCandidate, cli, 'same-size full check', 'full')).toThrow(
        /benchmark identity drift detected at same-size full check/,
      );
    } finally {
      writeFileSync(dependencyFile, originalDependency);
      utimesSync(dependencyFile, secondsFromNanoseconds(originalState.atimeNs), secondsFromNanoseconds(originalState.mtimeNs));
    }

    writeFileSync(join(devDependencyDirectory, 'index.js'), 'export const dev = false;\n', 'utf8');
    const withChangedDevDependency = candidateIdentity(cli, fakeRepositoryIdentity());
    expect(withChangedDevDependency.runtimeDependencyTree).toEqual(candidate.runtimeDependencyTree);

    writeFileSync(join(peerDependencyDirectory, 'index.js'), 'export const peer = false;\n', 'utf8');
    const changedPeer = candidateIdentity(cli, fakeRepositoryIdentity());
    expect(changedPeer.runtimeDependencyTree?.sha256).not.toBe(candidate.runtimeDependencyTree?.sha256);

    writeFileSync(join(dependencyDirectory, 'index.js'), 'export const runtime = false;\n', 'utf8');
    const changed = candidateIdentity(cli, fakeRepositoryIdentity());
    expect(changed.runtimeDependencyTree?.sha256).not.toBe(candidate.runtimeDependencyTree?.sha256);

    writeFileSync(join(transitiveDirectory, 'index.js'), 'export const transitive = false;\n', 'utf8');
    const changedTransitive = candidateIdentity(cli, fakeRepositoryIdentity());
    expect(changedTransitive.runtimeDependencyTree?.sha256).not.toBe(changed.runtimeDependencyTree?.sha256);
  });

  it('keeps duplicate installed versions in the runtime closure', () => {
    const root = scratch('anc-benchmark-duplicate-');
    const packageDirectory = join(root, 'node_modules', 'anc');
    const firstDirectory = join(root, 'node_modules', 'duplicate-dependency');
    const parentDirectory = join(root, 'node_modules', 'nested-parent');
    const secondDirectory = join(parentDirectory, 'node_modules', 'duplicate-dependency');
    mkdirSync(join(packageDirectory, 'bin'), { recursive: true });
    mkdirSync(firstDirectory, { recursive: true });
    mkdirSync(secondDirectory, { recursive: true });
    mkdirSync(parentDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, 'package.json'),
      '{"name":"anc","version":"0.1.0","dependencies":{"duplicate-dependency":"1.0.0","nested-parent":"1.0.0"}}\n',
      'utf8',
    );
    writeFileSync(join(packageDirectory, 'bin', 'anc.mjs'), '#!/usr/bin/env node\n', 'utf8');
    writeFileSync(join(firstDirectory, 'package.json'), '{"name":"duplicate-dependency","version":"1.0.0"}\n', 'utf8');
    writeFileSync(join(firstDirectory, 'index.js'), 'export const version = 1;\n', 'utf8');
    writeFileSync(
      join(parentDirectory, 'package.json'),
      '{"name":"nested-parent","version":"1.0.0","dependencies":{"duplicate-dependency":"2.0.0"}}\n',
      'utf8',
    );
    writeFileSync(join(parentDirectory, 'index.js'), 'export const parent = true;\n', 'utf8');
    writeFileSync(join(secondDirectory, 'package.json'), '{"name":"duplicate-dependency","version":"2.0.0"}\n', 'utf8');
    writeFileSync(join(secondDirectory, 'index.js'), 'export const version = 2;\n', 'utf8');
    packCandidate(packageDirectory, root);

    const candidate = candidateIdentity(join(packageDirectory, 'bin', 'anc.mjs'), fakeRepositoryIdentity());
    expect(candidate.runtimeDependencyTree?.files).toBe(6);

    writeFileSync(join(secondDirectory, 'index.js'), 'export const version = 2.1;\n', 'utf8');
    const changed = candidateIdentity(join(packageDirectory, 'bin', 'anc.mjs'), fakeRepositoryIdentity());
    expect(changed.runtimeDependencyTree?.sha256).not.toBe(candidate.runtimeDependencyTree?.sha256);
  });

  it('follows pnpm-style package symlinks while hashing the real package root once', () => {
    const root = scratch('anc-benchmark-pnpm-');
    const packageDirectory = join(root, 'node_modules', 'anc');
    const virtualDirectory = join(root, 'node_modules', '.pnpm', 'runtime-dependency@1.0.0', 'node_modules', 'runtime-dependency');
    const transitiveVirtualDirectory = join(root, 'node_modules', '.pnpm', 'transitive-dependency@1.0.0', 'node_modules', 'transitive-dependency');
    mkdirSync(join(packageDirectory, 'bin'), { recursive: true });
    mkdirSync(virtualDirectory, { recursive: true });
    mkdirSync(transitiveVirtualDirectory, { recursive: true });
    mkdirSync(join(virtualDirectory, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(virtualDirectory, join(root, 'node_modules', 'runtime-dependency'), 'junction');
    symlinkSync(transitiveVirtualDirectory, join(virtualDirectory, 'node_modules', 'transitive-dependency'), 'junction');
    writeFileSync(
      join(packageDirectory, 'package.json'),
      '{"name":"anc","version":"0.1.0","dependencies":{"runtime-dependency":"1.0.0"}}\n',
      'utf8',
    );
    writeFileSync(join(packageDirectory, 'bin', 'anc.mjs'), '#!/usr/bin/env node\n', 'utf8');
    writeFileSync(
      join(virtualDirectory, 'package.json'),
      '{"name":"runtime-dependency","version":"1.0.0","dependencies":{"transitive-dependency":"1.0.0"}}\n',
      'utf8',
    );
    writeFileSync(join(virtualDirectory, 'index.js'), 'export const runtime = true;\n', 'utf8');
    writeFileSync(join(transitiveVirtualDirectory, 'package.json'), '{"name":"transitive-dependency","version":"1.0.0"}\n', 'utf8');
    writeFileSync(join(transitiveVirtualDirectory, 'index.js'), 'export const transitive = true;\n', 'utf8');
    packCandidate(packageDirectory, root);

    const candidate = candidateIdentity(join(packageDirectory, 'bin', 'anc.mjs'), fakeRepositoryIdentity());
    expect(candidate.runtimeDependencyTree?.files).toBe(4);
    mkdirSync(join(virtualDirectory, '.cache'), { recursive: true });
    writeFileSync(join(virtualDirectory, '.cache', 'generated.js'), 'cache\n', 'utf8');
    expect(candidateIdentity(join(packageDirectory, 'bin', 'anc.mjs'), fakeRepositoryIdentity()).runtimeDependencyTree).toEqual(
      candidate.runtimeDependencyTree,
    );
  });

  it('fails closed when a required runtime dependency is missing', () => {
    const root = scratch('anc-benchmark-required-dependency-');
    const packageDirectory = join(root, 'node_modules', 'anc');
    mkdirSync(join(packageDirectory, 'bin'), { recursive: true });
    writeFileSync(
      join(packageDirectory, 'package.json'),
      '{"name":"anc","version":"0.1.0","dependencies":{"missing-runtime":"1.0.0"},"optionalDependencies":{"missing-optional":"1.0.0"},"peerDependencies":{"missing-peer":"1.0.0"}}\n',
      'utf8',
    );
    const cli = join(packageDirectory, 'bin', 'anc.mjs');
    writeFileSync(cli, '#!/usr/bin/env node\n', 'utf8');
    packCandidate(packageDirectory, root);

    expect(() => candidateIdentity(cli, fakeRepositoryIdentity())).toThrow(
      /required runtime dependency is missing: missing-runtime/,
    );
  });

  it('rejects unrelated or missing packaged tarballs instead of binding false provenance', () => {
    const root = scratch('anc-benchmark-tarball-identity-');
    const packageDirectory = join(root, 'node_modules', 'anc');
    mkdirSync(join(packageDirectory, 'bin'), { recursive: true });
    writeFileSync(join(packageDirectory, 'package.json'), '{"name":"anc","version":"0.1.0"}\n', 'utf8');
    const cli = join(packageDirectory, 'bin', 'anc.mjs');
    writeFileSync(cli, '#!/usr/bin/env node\n', 'utf8');
    const tarball = packCandidate(packageDirectory, root);
    const previous = process.env['ANC_BENCHMARK_TARBALL'];
    try {
      writeFileSync(tarball, 'unrelated archive bytes\n', 'utf8');
      process.env['ANC_BENCHMARK_TARBALL'] = tarball;
      expect(() => candidateIdentity(cli, fakeRepositoryIdentity())).toThrow(/could not inspect candidate tarball/);
      rmSync(tarball);
      expect(() => candidateIdentity(cli, fakeRepositoryIdentity())).toThrow(/requires tarball anc-0\.1\.0\.tgz/);
    } finally {
      if (previous === undefined) delete process.env['ANC_BENCHMARK_TARBALL'];
      else process.env['ANC_BENCHMARK_TARBALL'] = previous;
    }
  });
});

describe('snapshot benchmark static server', () => {
  it('serves identity, gzip, and revalidation responses with matching records', async () => {
    const dist = scratch('anc-benchmark-server-semantics-');
    const body = 'static server transfer semantics\n'.repeat(64);
    writeFileSync(
      join(dist, '_headers'),
      '/*\n  Cache-Control: public, max-age=0\n/asset.txt\n  Cache-Control: public, max-age=31536000, immutable\n',
      'utf8',
    );
    writeFileSync(join(dist, 'asset.txt'), body, 'utf8');

    const server = await startStaticServer(dist);
    try {
      expect(server.headersSource).toBe('dist/_headers');
      const identity = await fetch(`${server.origin}/asset.txt`, { headers: { 'Accept-Encoding': 'identity' } });
      const etag = identity.headers.get('etag');
      expect(identity.status).toBe(200);
      expect(identity.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(identity.headers.get('content-encoding')).toBeNull();
      expect(identity.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
      expect(etag).toBeTruthy();
      expect(await identity.text()).toBe(body);

      const gzip = await new Promise<{ status: number; headers: typeof identity.headers; body: Buffer }>((resolve, reject) => {
        const pending = request(
          `${server.origin}/asset.txt`,
          { headers: { 'Accept-Encoding': 'gzip' } },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: new Headers(response.headers as Record<string, string>),
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        pending.once('error', reject);
        pending.end();
      });
      expect(gzip.status).toBe(200);
      expect(gzip.headers.get('content-encoding')).toBe('gzip');
      expect(gzip.headers.get('vary')).toBe('Accept-Encoding');
      expect(gzip.headers.get('content-length')).toBe(String(gzip.body.length));
      expect(gunzipSync(gzip.body).toString('utf8')).toBe(body);

      const revalidated = await fetch(`${server.origin}/asset.txt`, { headers: { 'If-None-Match': etag! } });
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe('');

      const records = server.records.filter((record) => record.path === '/asset.txt');
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({
        status: 200,
        completion: 'finished',
        cacheControl: 'public, max-age=31536000, immutable',
        contentEncoding: null,
        contentLength: String(Buffer.byteLength(body)),
        bytesServed: Buffer.byteLength(body),
      });
      expect(records[1]).toMatchObject({
        status: 200,
        completion: 'finished',
        cacheControl: 'public, max-age=31536000, immutable',
        contentEncoding: 'gzip',
        contentLength: String(gzip.body.length),
        bytesServed: gzip.body.length,
      });
      expect(records[2]).toMatchObject({
        status: 304,
        completion: 'finished',
        cacheControl: 'public, max-age=31536000, immutable',
        contentEncoding: null,
        contentLength: null,
        bytesServed: 0,
      });
    } finally {
      await server.close();
    }
  });

  it('preserves request start/end offsets and routes listen errors to rejection', async () => {
    const dist = scratch('anc-benchmark-server-');
    writeFileSync(join(dist, '_headers'), '/*\n  Cache-Control: public, max-age=0\n', 'utf8');
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>ok</title>\n', 'utf8');

    const server = await startStaticServer(dist, { port: 0, responseDelayMs: 20 });
    try {
      const response = await fetch(`${server.origin}/`);
      expect(response.status).toBe(200);
      const record = server.records.find((entry) => entry.path === '/index.html');
      expect(record).toBeDefined();
      expect(record!.completion).toBe('finished');
      expect(record!.startedAtMs).toBeLessThanOrEqual(record!.endedAtMs);
      expect(record!.endedAtMs - record!.startedAtMs).toBeGreaterThanOrEqual(10);

      const port = Number(new URL(server.origin).port);
      await expect(startStaticServer(dist, { port })).rejects.toThrow(/EADDRINUSE|listen/);
    } finally {
      await server.close();
    }
  });

  it('records an aborted close separately when finish never fires', async () => {
    const dist = scratch('anc-benchmark-server-abort-');
    writeFileSync(join(dist, '_headers'), '/*\n  Cache-Control: public, max-age=0\n', 'utf8');
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>slow</title>\n', 'utf8');

    const server = await startStaticServer(dist, { port: 0, responseDelayMs: 100 });
    try {
      const controller = new AbortController();
      const pending = fetch(`${server.origin}/`, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort();
      await expect(pending).rejects.toThrow(/abort|cancel|fetch/i);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const record = server.records.find((entry) => entry.path === '/index.html');
      expect(record).toBeDefined();
      expect(record!.completion).toBe('aborted');
      expect(record!.status).toBeNull();
      expect(record!.bytesServed).toBeNull();
      expect(record!.endedAtMs).toBeGreaterThanOrEqual(record!.startedAtMs);

      const retry = await fetch(`${server.origin}/`, { headers: { 'Accept-Encoding': 'identity' } });
      expect(await retry.text()).toContain('<title>slow</title>');
      const attempts = server.records.filter((entry) => entry.path === '/index.html');
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({ completion: 'finished', status: 200 });
      expect(attempts[1]!.bytesServed).toBe(Buffer.byteLength('<!doctype html><title>slow</title>\n'));
    } finally {
      await server.close();
    }
  });
});
