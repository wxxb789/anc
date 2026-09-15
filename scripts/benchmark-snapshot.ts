/**
 * Transfer, startup, preview, and query-cost measurement for the snapshot runtime.
 *
 * This is goal 0008's **instrument**, not its acceptance. It measures the real
 * packaged build in a real browser and writes a private JSON report under
 * `<git-dir>/publish-report/`, but the named physical mobile device and the
 * maintainer's policy decision are external and are not invented here. Every
 * report states its host, browser, throttling (simulation when used), sample
 * count, and quantile method, and labels JS-heap-only memory as such.
 *
 * Usage: `node scripts/benchmark-snapshot.ts [--sizes 100,1000,10000]
 * [--topologies sparse,hub] [--samples 30] [--throttle 4]`
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { cpus, tmpdir, totalmem } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'anc.mjs');

interface Options {
  sizes: number[];
  topologies: ('sparse' | 'hub')[];
  samples: number;
  throttle: number;
}

function parseOptions(argv: readonly string[]): Options {
  const option = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : fallback;
  };
  return {
    sizes: option('sizes', '100,1000,10000').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0),
    topologies: option('topologies', 'sparse,hub').split(',') as Options['topologies'],
    samples: Number(option('samples', '30')),
    throttle: Number(option('throttle', '4')),
  };
}

function headers(): Record<string, string> {
  const text = readFileSync(join(ROOT, 'public', '_headers'), 'utf8');
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(' ') || line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const trimmed = line.trim();
    const separator = trimmed.indexOf(':');
    if (separator > 0) found[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).trim();
  }
  return found;
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
};

function startServer(dist: string): Promise<Server> {
  const applied = headers();
  const server = createServer((request, response) => {
    let pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(dist, `.${pathname}`);
    if (!file.startsWith(dist)) {
      response.writeHead(403, applied);
      response.end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, { ...applied, 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404, applied);
      response.end('not found');
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

/** Nearest-rank percentile over an unsorted sample; method stated in the report. */
function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Number(sorted[rank]!.toFixed(2));
}

interface Corpus {
  directory: string;
  slug: string;
  notes: number;
  edges: number;
  tags: number;
}

function generateCorpus(root: string, size: number, topology: 'sparse' | 'hub'): Corpus {
  const notes = join(root, 'notes');
  mkdirSync(notes, { recursive: true });
  const slugFor = (index: number): string => `note-${String(index).padStart(6, '0')}`;
  const hubCount = topology === 'hub' ? Math.max(1, Math.round(size / 1000) * 3 + 3) : 0;
  let edges = 0;
  for (let index = 0; index < size; index += 1) {
    const links: string[] = [];
    if (topology === 'sparse') {
      links.push(`[[${slugFor((index + 1) % size)}]]`);
    } else if (index < hubCount) {
      // A hub links to a slice of the corpus.
      const span = Math.max(1, Math.floor(size / hubCount));
      for (let offset = 1; offset <= Math.min(span, 40); offset += 1) links.push(`[[${slugFor((index + offset * 7) % size)}]]`);
    } else {
      links.push(`[[${slugFor(index % hubCount)}]]`);
    }
    edges += new Set(links).size;
    const tag = index % 10 === 0 ? 'field-notes' : index % 7 === 0 ? '笔记' : 'gardening';
    const cjk = index % 25 === 0 ? '星图与笔记：中英混排' : `Note ${index}`;
    writeFileSync(
      join(notes, `${slugFor(index)}.md`),
      `---\ntags: [${tag}]\naliases: ["alias-${index}"]\n---\n\n# ${cjk}\n\nBody for note ${index}. ${links.join(' ')}\n`,
      'utf8',
    );
  }
  // Hub notes sort first, so note 0 is the busiest center in that topology;
  // the sparse ring starts there too, so either topology has a neighbor.
  const center = slugFor(0);
  return { directory: root, slug: center, notes: size, edges, tags: 3 };
}

const HOVER_DELAY_MS = 120;

interface Sample {
  size: number;
  topology: 'sparse' | 'hub';
  notes: number;
  edges: number;
  buildSeconds: number;
  dbDecodedBytes: number;
  dbGzipBytes: number;
  wasmBytes: number;
  jsHeapUsedBytes: number | null;
  hoverDelayMs: number;
  coldPreviewMs: number | null;
  warmPreviewMs: number | null;
  localGraphMs: number[];
  ordinaryReadingSqliteRequests: number;
}

async function measure(corpus: Corpus, size: number, topology: 'sparse' | 'hub', options: Options, buildSeconds: number): Promise<Sample> {
  const { chromium } = await import('playwright');
  const server = await startServer(join(corpus.directory, 'dist'));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  if (options.throttle > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: options.throttle });
  const sqliteRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/data/site.') || request.url().includes('/wasm/')) sqliteRequests.push(request.url());
  });
  const localMs: number[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __snapshotMeasurement?: boolean }).__snapshotMeasurement = true;
    (window as unknown as { __ancLocalGraphMs: number[] }).__ancLocalGraphMs = [];
    document.addEventListener('snapshot-result', (event) => {
      const detail = (event as CustomEvent<{ type: string; ms: number }>).detail;
      if (detail.type === 'localGraph') (window as unknown as { __ancLocalGraphMs: number[] }).__ancLocalGraphMs.push(detail.ms);
    });
  });

  let coldPreviewMs: number | null = null;
  let warmPreviewMs: number | null = null;
  let jsHeapUsedBytes: number | null = null;

  try {
    await page.goto(`${origin}/notes/${corpus.slug}/`, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const beforeIntent = sqliteRequests.length;

    // Cold preview: intent to a visible, correct panel, minus the hover delay.
    const link = page.locator('.graph-region, article').locator('a[href^="/notes/"]').first();
    const hoverLink = (await link.count()) > 0 ? link : page.locator('a[href^="/notes/"]').first();
    const started = Date.now();
    await hoverLink.hover();
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 30_000 });
    // Intent to a correct panel, with the client's own hover delay removed so
    // the number describes the runtime rather than the gesture's timer.
    coldPreviewMs = Math.max(0, Date.now() - started - HOVER_DELAY_MS);

    // Warm preview: a later intent after the Worker is ready.
    await page.mouse.move(0, 0);
    await page.locator('#link-preview').waitFor({ state: 'hidden', timeout: 5_000 });
    await page.waitForTimeout(200);
    const warmStarted = Date.now();
    await hoverLink.hover();
    await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 10_000 });
    warmPreviewMs = Math.max(0, Date.now() - warmStarted - HOVER_DELAY_MS);

    // Warm local-neighbourhood: repeated operations on the ready snapshot.
    const activate = page.locator('[data-graph-activate]');
    if ((await activate.count()) > 0) {
      await page.mouse.move(0, 0);
      await activate.click();
      await page.waitForFunction(
        () => ((window as unknown as { __ancLocalGraphMs: number[] }).__ancLocalGraphMs ?? []).length > 0,
        undefined,
        { timeout: 30_000 },
      );
      for (let index = 0; index < options.samples; index += 1) {
        const count = await page.evaluate(
          () => ((window as unknown as { __ancLocalGraphMs: number[] }).__ancLocalGraphMs ?? []).length,
        );
        await activate.click();
        await page.waitForFunction(
          (n) => ((window as unknown as { __ancLocalGraphMs: number[] }).__ancLocalGraphMs ?? []).length > n,
          count,
          { timeout: 15_000 },
        );
      }
      localMs.push(
        ...(await page.evaluate(() => (window as unknown as { __ancLocalGraphMs: number[] }).__ancLocalGraphMs)),
      );
    }

    // JS heap after readiness; explicitly not total memory or WASM memory.
    await session.send('Performance.enable');
    const metrics = await session.send('Performance.getMetrics');
    const heap = metrics.metrics.find((entry) => entry.name === 'JSHeapUsedSize');
    jsHeapUsedBytes = heap === undefined ? null : Math.round(heap.value);

    const dataDirectory = join(corpus.directory, 'dist', 'data');
    const snapshot = readdirSync(dataDirectory).find((name) => name.endsWith('.sqlite'))!;
    const dbBytes = readFileSync(join(dataDirectory, snapshot));
    const wasmDirectory = join(corpus.directory, 'dist', 'wasm');
    const wasm = readdirSync(wasmDirectory).find((name) => name.endsWith('.wasm'))!;
    const wasmBytes = readFileSync(join(wasmDirectory, wasm)).length;

    return {
      size,
      topology,
      notes: corpus.notes,
      edges: corpus.edges,
      buildSeconds,
      dbDecodedBytes: dbBytes.length,
      dbGzipBytes: gzipSync(dbBytes).length,
      wasmBytes,
      jsHeapUsedBytes,
      hoverDelayMs: HOVER_DELAY_MS,
      coldPreviewMs,
      warmPreviewMs,
      localGraphMs: localMs,
      ordinaryReadingSqliteRequests: beforeIntent,
    };
  } finally {
    await browser.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

function gitReportDirectory(): string {
  const probe = spawnSync('git', ['rev-parse', '--git-path', 'publish-report'], { encoding: 'utf8' });
  const path = probe.stdout.trim();
  return path === '' ? join(ROOT, '.publish-report') : resolve(ROOT, path);
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const started = Date.now();
  const samples: Sample[] = [];
  for (const size of options.sizes) {
    for (const topology of options.topologies) {
      const root = mkdtempSync(join(tmpdir(), `anc-bench-${size}-${topology}-`));
      try {
        const corpus = generateCorpus(root, size, topology);
        const buildStarted = Date.now();
        const build = spawnSync(process.execPath, [BINARY, 'build', '--content', 'notes', '--out', 'dist'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 20 * 60_000,
        });
        if (build.status !== 0) throw new Error(`build failed for ${size}/${topology}: ${build.stdout}${build.stderr}`);
        const sample = await measure(corpus, size, topology, options, Number(((Date.now() - buildStarted) / 1000).toFixed(2)));
        samples.push(sample);
        const locals = sample.localGraphMs;
        process.stdout.write(
          `${size}/${topology}: build=${sample.buildSeconds}s db=${sample.dbDecodedBytes}B gzip=${sample.dbGzipBytes}B ` +
            `coldPreview=${sample.coldPreviewMs}ms warmPreview=${sample.warmPreviewMs}ms ` +
            `localGraph p50=${percentile(locals, 0.5)}ms p95=${percentile(locals, 0.95)}ms n=${locals.length}\n`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  const report = {
    kind: 'anc-snapshot-benchmark',
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length, totalMemoryBytes: totalmem() },
    browser: 'chromium',
    throttling: options.throttle > 1 ? { cpuRate: options.throttle, label: 'simulation, not a physical mobile device' } : null,
    quantileMethod: 'nearest-rank',
    memoryInstrument: 'CDP Performance.getMetrics JSHeapUsedSize (JS heap only, not total or WASM memory)',
    samples,
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
  };

  const directory = gitReportDirectory();
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `benchmark-snapshot-${Date.now()}.json`);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(file, body, 'utf8');
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 12);
  // Counts only on the stream; the report path and names stay private.
  console.log(`benchmark: ${samples.length} workloads, report sha256=${digest}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
