import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_CONTROL_IDS,
  assertPacedBodyBound,
  benchmarkExitCode,
  assertSaturatedPage,
  createLimitsReportSkeleton,
  elapsedFromIntent,
  loadSiteHeaders,
  parseLimitsOptions,
  parseVitestJsonResult,
  readTagMemberCounts,
  recordLimitsFailure,
  scrubBenchmarkFailure,
  startSite,
} from '../scripts/benchmark-limits.ts';
import { listenServer } from '../scripts/benchmark-server.ts';

describe('benchmark-limits exit status', () => {
  it('requires the exact unique browser control set and the client-bound test to pass', () => {
    const clientBoundTest = { status: 'pass' as const };
    const passing = REQUIRED_CONTROL_IDS.map((id) => ({ id, status: 'pass' as const }));

    expect(benchmarkExitCode([], clientBoundTest)).toBe(1);
    expect(benchmarkExitCode(passing.slice(1), clientBoundTest)).toBe(1);
    expect(
      benchmarkExitCode(
        [...passing.slice(0, -1), { id: REQUIRED_CONTROL_IDS[0], status: 'pass' as const }],
        clientBoundTest,
      ),
    ).toBe(1);
    expect(benchmarkExitCode([...passing, { id: 'unexpected-control', status: 'pass' as const }], clientBoundTest)).toBe(1);
    expect(benchmarkExitCode(passing, clientBoundTest)).toBe(0);
    expect(benchmarkExitCode(passing.map((control, index) => (index === 0 ? { ...control, status: 'fail' as const } : control)), clientBoundTest)).toBe(1);
    expect(benchmarkExitCode(passing, { status: 'fail' })).toBe(1);
  });

  it('starts deadline timing at the intercepted intent rather than hover setup', () => {
    expect(elapsedFromIntent(125.5, 725.75)).toBeCloseTo(600.25);
    expect(() => elapsedFromIntent(undefined, 725.75)).toThrow(/request intent/);
    expect(() => elapsedFromIntent(725.75, 125.5)).toThrow(/preceded/);
  });

  it('binds header parsing and its digest to the candidate dist output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'anc-limits-headers-'));
    const dist = join(directory, 'dist');
    const checkoutHeaders = join(directory, 'checkout-_headers');
    mkdirSync(dist);
    const candidateText = '/* candidate */\n/*\n  Content-Security-Policy: default-src \'none\'\n*/\n';
    const checkoutText = '/* checkout */\n';
    writeFileSync(join(dist, '_headers'), candidateText, 'utf8');
    writeFileSync(checkoutHeaders, checkoutText, 'utf8');
    try {
      const loaded = loadSiteHeaders(dist);
      expect(loaded.source).toBe('dist/_headers');
      expect(loaded.sha256).toBe(createHash('sha256').update(candidateText).digest('hex'));
      expect(loaded.sha256).not.toBe(createHash('sha256').update(checkoutText).digest('hex'));
      expect(() => loadSiteHeaders(join(directory, 'missing-dist'))).toThrow(/ENOENT|no such file/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serves the candidate emitted headers when a packaged-style dist is selected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'anc-limits-site-'));
    const dist = join(directory, 'dist');
    mkdirSync(dist);
    const candidateText = '/*\n  X-Candidate-Policy: emitted\n';
    writeFileSync(join(dist, '_headers'), candidateText, 'utf8');
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>candidate</title>', 'utf8');
    const site = await startSite(dist);
    try {
      const response = await fetch(`${site.origin}/index.html`);
      expect(response.headers.get('x-candidate-policy')).toBe('emitted');
      expect(site.headers).toEqual({
        source: 'dist/_headers',
        sha256: createHash('sha256').update(candidateText).digest('hex'),
      });
    } finally {
      await site.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('streams a paced repeated body without storing the full payload', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'anc-limits-paced-site-'));
    const dist = join(directory, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, '_headers'), '/*\n  Cache-Control: no-store\n', 'utf8');
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>candidate</title>', 'utf8');
    const site = await startSite(dist);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const delivery = {
      bodyBytes: 10,
      bytesWritten: 0,
      chunksWritten: 0,
      peerAborted: false,
      completed: false,
      settled,
      settle,
    };
    site.routes.set('/paced.bin', {
      kind: 'paced-body',
      bodyBytes: 10,
      fill: 0x41,
      contentType: 'application/octet-stream',
      pace: { chunkBytes: 4, delayMs: 0 },
      delivery,
    });
    try {
      const response = await fetch(`${site.origin}/paced.bin`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.alloc(10, 0x41));
      await settled;
      expect(delivery).toMatchObject({
        bodyBytes: 10,
        bytesWritten: 10,
        chunksWritten: 3,
        peerAborted: false,
        completed: true,
      });
    } finally {
      await site.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects digest-only over-limit evidence that did not abort near the cap', () => {
    expect(() =>
      assertPacedBodyBound(
        { bodyBytes: 1_000, bytesWritten: 1_000, chunksWritten: 1, peerAborted: false, completed: true },
        500,
      ),
    ).toThrow(/full oversized body|peer did not observe/);
    expect(() =>
      assertPacedBodyBound(
        { bodyBytes: 1_000, bytesWritten: 600, chunksWritten: 2, peerAborted: true, completed: false },
        500,
      ),
    ).not.toThrow();
  });

  it('starts with structured identity, host, profile, and failure slots', () => {
    const report = createLimitsReportSkeleton();

    expect(report.instrument.repository).toBeNull();
    expect(report.candidate.cli).toBeNull();
    expect(report.candidate.assets).toBeNull();
    expect(report.host.platform).toBe(process.platform);
    expect(report.host.osType).toBeTypeOf('string');
    expect(report.host.osRelease).toBeTypeOf('string');
    expect(report.host.arch).toBeTypeOf('string');
    expect(report.host.cpus).toBeGreaterThan(0);
    expect(report.host.totalMemoryBytes).toBeGreaterThan(0);
    expect(report.browser.profile).toBeNull();
    expect(report.failures).toEqual([]);
  });

  it('keeps exact CLI and built-asset identity fields in the report contract', () => {
    const report = createLimitsReportSkeleton();
    const assets = {
      snapshot: { name: 'site.abc.sqlite', sha256: 'a'.repeat(64), bytes: 101 },
      wasm: { name: 'sqlite.wasm', sha256: 'b'.repeat(64), bytes: 202 },
      worker: { name: 'snapshot-worker-def.js', sha256: 'c'.repeat(64), bytes: 303 },
    };
    report.candidate.cli = {
      basename: 'anc.mjs',
      bytes: 101,
      sha256: 'd'.repeat(64),
      scope: 'sha256 of the --cli executable file bytes only',
      state: {
        bytes: 101,
        mtimeNs: '123',
        scope: 'test file state',
        method: 'test state digest',
      },
    };
    report.candidate.assets = assets;

    expect(JSON.parse(JSON.stringify(report)).candidate).toMatchObject({
      cli: { basename: 'anc.mjs', sha256: 'd'.repeat(64) },
      assets,
    });
  });

  it('preserves a scrubbed setup failure in the private report shape', () => {
    const report = createLimitsReportSkeleton();
    const message = 'failed to launch C:\\Users\\person\\AppData\\Local\\msedge.exe from Q:/workspace/site';

    recordLimitsFailure(report, 'browser-launch', new Error(message), [
      'C:\\Users\\person\\AppData\\Local\\msedge.exe',
      'Q:/workspace/site',
    ]);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.phase).toBe('browser-launch');
    expect(report.failures[0]?.message).not.toContain('C:\\Users');
    expect(report.failures[0]?.message).not.toContain('Q:/workspace/site');
    expect(report.failures[0]?.message).toContain('<host-path>');
    expect(scrubBenchmarkFailure('plain launch failure')).toBe('plain launch failure');
  });

  it('parses a strict --cli alongside browser and device options', () => {
    const options = parseLimitsOptions(
      ['--cli', 'candidate/bin/anc.mjs', '--browser', 'edge', '--device', 'Pixel 7'],
      process.cwd(),
    );

    expect(options).toEqual({
      cli: expect.stringMatching(/[\\/]candidate[\\/]bin[\\/]anc\.mjs$/),
      browser: 'edge',
      device: 'Pixel 7',
    });
    expect(() => parseLimitsOptions(['--cli', 'one', '--cli', 'two'])).toThrow(/duplicate option: --cli/);
    expect(() => parseLimitsOptions(['--sizes', '100'])).toThrow(/unknown option: --sizes/);
  });

  it('fails closed when Vitest JSON is absent, malformed, unsuccessful, or incomplete', () => {
    const validReport = {
      success: true,
      numTotalTests: 7,
      numPassedTests: 7,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          name: 'tests/snapshot-client.test.ts',
          status: 'passed',
          assertionResults: Array.from({ length: 7 }, () => ({ status: 'passed' })),
        },
      ],
    };
    const valid = JSON.stringify(validReport);

    expect(parseVitestJsonResult({ status: 0, stdout: valid })).toMatchObject({
      status: 'pass',
      total: 7,
      passed: 7,
      failed: 0,
    });
    for (const stdout of ['', 'not json', '{"success":true}', '{"success":false,"numTotalTests":7}']) {
      expect(parseVitestJsonResult({ status: 0, stdout })).toMatchObject({ status: 'fail', total: null, passed: null, failed: null });
    }
    expect(parseVitestJsonResult({ status: 1, stdout: valid })).toMatchObject({
      status: 'fail',
      total: 7,
      passed: 7,
      failed: 0,
    });
  });

  it('rejects zero-test, skipped, pending, todo, and wrong-file Vitest evidence', () => {
    const report = {
      success: true,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          name: 'tests/snapshot-client.test.ts',
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
      ],
    };
    const parse = (overrides: Record<string, unknown>) =>
      parseVitestJsonResult({ status: 0, stdout: JSON.stringify({ ...report, ...overrides }) });

    expect(
      parse({
        numTotalTests: 0,
        numPassedTests: 0,
        testResults: [{ ...report.testResults[0], assertionResults: [] }],
      }),
    ).toMatchObject({ status: 'fail', total: 0, passed: 0, failed: 0 });
    expect(parse({ numPassedTests: 0, numPendingTests: 1 })).toMatchObject({ status: 'fail' });
    expect(parse({ numSkippedTests: 1 })).toMatchObject({ status: 'fail' });
    expect(
      parse({
        testResults: [{ ...report.testResults[0], assertionResults: [{ status: 'skipped' }] }],
      }),
    ).toMatchObject({ status: 'fail' });
    expect(parse({ numPassedTests: 0, numTodoTests: 1 })).toMatchObject({ status: 'fail' });
    expect(
      parse({
        testResults: [{ ...report.testResults[0], name: 'tests/other.test.ts' }],
      }),
    ).toMatchObject({ status: 'fail' });
  });

  it('rejects unsaturated pagination evidence before an over-limit request can pass', () => {
    expect(() => assertSaturatedPage({ notes: Array.from({ length: 3 }), nextCursor: null }, 3)).toThrow(/did not saturate/);
    expect(() => assertSaturatedPage({ notes: Array.from({ length: 3 }), nextCursor: 'next' }, 3)).not.toThrow();
  });

  it('reads the saturated tag total from the finalized database instead of the site total', () => {
    const directory = mkdtempSync(join(tmpdir(), 'anc-limits-tag-count-'));
    const file = join(directory, 'site.sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        CREATE TABLE tags (id INTEGER PRIMARY KEY, key TEXT NOT NULL);
        CREATE TABLE node_tags (node_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
        INSERT INTO tags (id, key) VALUES (1, 'shared'), (2, 'small');
        INSERT INTO node_tags (node_id, tag_id) VALUES (1, 1), (2, 1), (3, 2);
      `);
    } finally {
      db.close();
    }
    try {
      expect(readTagMemberCounts(file)).toEqual(
        new Map([
          ['shared', 2],
          ['small', 1],
        ]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects server listen errors into the caller rather than leaving an unhandled error', async () => {
    const occupied = createServer();
    const contender = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', () => resolve());
      });
      const port = (occupied.address() as { port: number }).port;
      await expect(listenServer(contender, port)).rejects.toThrow(/listen|address|EADDRINUSE/i);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
      await new Promise<void>((resolve) => contender.close(() => resolve()));
    }
  });
});
