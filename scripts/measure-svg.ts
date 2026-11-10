/**
 * Goal 0012's measurement instrument: source and published bytes, per-SVG
 * latency, two clean-build wall times and peak RSS, determinism, and the host's
 * font inventory.
 *
 * The corpus is built from the committed fixture set, so the numbers describe the
 * same documents the gates do rather than a convenient second corpus. Timing and
 * memory are measured by wrapping the shipped binary in `/usr/bin/time -v`
 * because this process cannot observe a child's peak RSS itself; that is also
 * why the builds are separate processes rather than calls inside this one.
 *
 * Usage:
 *   node scripts/measure-svg.ts [--root .tmp/svg-measure] [--json report.json]
 *                               [--iterations 3] [--skip-build]
 *
 * Everything it cannot measure is printed as `unverified` rather than inferred.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { discoverFonts, missingCodePoints } from '../src/lib/font-coverage.ts';
import type { PrepareResult } from '../src/lib/media-codec.ts';
import { prepareSvg } from '../src/lib/svg-render.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'svg', 'benign');
const BINARY = join(ROOT, 'bin', 'anc.mjs');

/** The 0011 baseline this goal is compared against. */
const BASELINE = Object.freeze({
  imageBytes: 728_778,
  distBytes: 9_037_872,
  tarballBytes: 452_005,
  note: 'Goal 0011 measurement, recorded in its goal record; not re-measured by this script.',
});

interface TimedRender {
  readonly name: string;
  readonly sourceBytes: number;
  readonly emittedBytes: number;
  readonly width: number;
  readonly height: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly coldMs: number;
  readonly medianMs: number;
  readonly runsMs: readonly number[];
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function totalBytes(directory: string): number {
  let total = 0;
  for (const hash of readdirSync(directory)) {
    const path = join(directory, hash);
    if (statSync(path).isDirectory()) total += totalBytes(path);
    else total += statSync(path).size;
  }
  return total;
}

/** Materialize a corpus from the committed fixtures. */
function corpus(root: string): { directory: string; files: string[] } {
  const directory = join(root, 'corpus');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(join(directory, 'media'), { recursive: true });
  const files = readdirSync(FIXTURES).sort();
  for (const name of files) writeFileSync(join(directory, 'media', name), readFileSync(join(FIXTURES, name)));
  const references = files.map((name) => `![${name}](media/${name})`).join('\n\n');
  writeFileSync(join(directory, 'gallery.md'), `# Gallery\n\nA measurement page.\n\n${references}\n`, 'utf8');
  writeFileSync(
    join(directory, 'shared.md'),
    '# Shared\n\nThe same picture from another note:\n\n![shared](media/shared.svg)\n',
    'utf8',
  );
  return { directory, files };
}

/** Run `/usr/bin/time -v` around one packaged build, returning wall ms and peak RSS KiB. */
function timedBuild(corpusDirectory: string, out: string): {
  status: number;
  wallMs: number;
  peakRssKiB?: number;
  log: string;
} {
  const started = performance.now();
  const result = spawnSync(
    '/usr/bin/time',
    ['-v', process.execPath, BINARY, 'build', '--content', corpusDirectory, '--out', out],
    { cwd: ROOT, encoding: 'utf8', timeout: 900_000 },
  );
  const wallMs = Math.round(performance.now() - started);
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const peak = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(log)?.[1];
  return {
    status: result.status ?? 1,
    wallMs,
    ...(peak === undefined ? {} : { peakRssKiB: Number(peak) }),
    log,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const root = resolve(option(argv, 'root') ?? join('.tmp', 'svg-measure'));
  const iterations = Math.max(1, Number(option(argv, 'iterations') ?? '3'));
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const { directory, files } = corpus(root);

  const renders: TimedRender[] = [];
  const emittedBytes = new Map<string, Buffer>();
  for (const name of files) {
    const bytes = readFileSync(join(directory, 'media', name));
    const runs: number[] = [];
    let last: PrepareResult | undefined;
    for (let run = 0; run < iterations; run++) {
      const started = performance.now();
      last = await prepareSvg(bytes);
      runs.push(performance.now() - started);
    }
    const result = required(last, `${name} render`);
    if (!result.ok) throw new Error(`${name}: ${result.reason} ${result.detail ?? ''}`);
    const css = required(result.image.displayDimensions, `${name} display dimensions`);
    emittedBytes.set(name, result.image.bytes);
    renders.push({
      name,
      sourceBytes: bytes.length,
      emittedBytes: result.image.bytes.length,
      width: result.image.dimensions!.width,
      height: result.image.dimensions!.height,
      cssWidth: css.width,
      cssHeight: css.height,
      coldMs: Number(runs[0]!.toFixed(1)),
      medianMs: Number(median(runs).toFixed(1)),
      runsMs: runs.map((value) => Number(value.toFixed(1))),
    });
  }

  const skipBuild = argv.includes('--skip-build');
  const builds: {
    label: string;
    status: number;
    wallMs: number;
    peakRssKiB?: number;
    distBytes: number;
    assets: Record<string, string>;
  }[] = [];
  if (!skipBuild) {
    for (const label of ['first', 'second']) {
      const out = join(root, `dist-${label}`);
      const result = timedBuild(directory, out);
      const assetsDirectory = join(out, '_assets');
      const assets: Record<string, string> = {};
      if (existsSync(assetsDirectory)) {
        for (const name of readdirSync(assetsDirectory).sort()) {
          assets[name] = createHash('sha256').update(readFileSync(join(assetsDirectory, name))).digest('hex');
        }
      }
      builds.push({
        label,
        status: result.status,
        wallMs: result.wallMs,
        ...(result.peakRssKiB === undefined ? {} : { peakRssKiB: result.peakRssKiB }),
        distBytes: existsSync(out) ? totalBytes(out) : 0,
        assets,
      });
    }
  }

  const [first, second] = builds;
  const deterministic = first !== undefined && second !== undefined ? JSON.stringify(first.assets) === JSON.stringify(second.assets) : undefined;

  // The same pictures, already raster: this is the "before" side of the build
  // cost. It isolates SVG policy and rasterization from the rest of the build,
  // which is otherwise dominated by Astro, Pagefind and the SQLite snapshot.
  let rasterBuild: { status: number; wallMs: number; peakRssKiB?: number; distBytes: number } | undefined;
  if (!skipBuild && renders.length > 0) {
    const rasterCorpus = join(root, 'corpus-raster');
    rmSync(rasterCorpus, { recursive: true, force: true });
    mkdirSync(join(rasterCorpus, 'media'), { recursive: true });
    const references: string[] = [];
    for (const row of renders) {
      const stem = row.name.replace(/\.svg$/, '');
      const bytes = required(emittedBytes.get(row.name), `${row.name} emitted bytes`);
      writeFileSync(join(rasterCorpus, 'media', `${stem}.webp`), bytes);
      references.push(`![${row.name}](media/${stem}.webp)`);
    }
    writeFileSync(join(rasterCorpus, 'gallery.md'), `# Gallery\n\nA measurement page.\n\n${references.join('\n\n')}\n`, 'utf8');
    writeFileSync(
      join(rasterCorpus, 'shared.md'),
      '# Shared\n\nThe same picture from another note:\n\n![shared](media/shared.webp)\n',
      'utf8',
    );
    const out = join(root, 'dist-raster');
    const result = timedBuild(rasterCorpus, out);
    rasterBuild = {
      status: result.status,
      wallMs: result.wallMs,
      ...(result.peakRssKiB === undefined ? {} : { peakRssKiB: result.peakRssKiB }),
      distBytes: existsSync(out) ? totalBytes(out) : 0,
    };
  }

  const fonts = discoverFonts();
  const families = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8' });
  const familyList =
    families.status === 0
      ? [...new Set((families.stdout ?? '').split('\n').flatMap((line) => line.split(',').map((entry) => entry.trim())).filter((entry) => entry !== ''))]
          .sort()
      : undefined;
  const cjkCovered = missingCodePoints([0x6784, 0x5efa, 0x56fe, 0x7247]).missing.length === 0;
  const tofu = missingCodePoints([0x10fffd]).missing.length > 0;

  const packageBytes = (name: string): number | undefined => {
    const linked = join(ROOT, 'node_modules', name);
    if (existsSync(linked)) return totalBytes(realpathSync(linked));
    // A transitive dependency is not linked at the top level under pnpm; its
    // store directory is the installed bytes all the same.
    const store = join(ROOT, 'node_modules', '.pnpm');
    const entry = readdirSync(store).find((candidate) => candidate.startsWith(`${name}@`));
    if (entry === undefined) return undefined;
    const resolved = join(store, entry, 'node_modules', name);
    return existsSync(resolved) ? totalBytes(realpathSync(resolved)) : undefined;
  };

  const tarballs = readdirSync(ROOT).filter((name) => name.endsWith('.tgz')).sort();
  const tarball = tarballs.at(-1);

  const report = {
    root,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      sharp: sharp.versions.sharp,
      vips: sharp.versions.vips,
      fontFiles: fonts.files.length,
      fontDirectories: fonts.directories,
      fontConfigIncludes: fonts.includes,
      fontConfigIncludeDirectories: fonts.includeDirectories,
      fontConfigIncludesSkipped: fonts.skippedIncludes,
    },
    fonts: {
      families: familyList ?? 'unverified: fc-list unavailable',
      cjkCovered,
      plane16PrivateUseMissing: tofu,
      fontsDiscovered: fonts.files.length,
      configIncludes: fonts.includes,
      configIncludeDirectories: fonts.includeDirectories,
      configIncludesSkipped: fonts.skippedIncludes,
    },
    renders,
    rendersTotals: {
      sourceBytes: renders.reduce((sum, row) => sum + row.sourceBytes, 0),
      emittedBytes: renders.reduce((sum, row) => sum + row.emittedBytes, 0),
      coldMs: Number(renders.reduce((sum, row) => sum + row.coldMs, 0).toFixed(1)),
      medianMs: Number(renders.reduce((sum, row) => sum + row.medianMs, 0).toFixed(1)),
    },
    builds,
    rasterBuild: rasterBuild ?? 'unverified: builds skipped',
    buildCost: {
      svgWallMs: first?.wallMs,
      rasterWallMs: rasterBuild?.wallMs,
      svgOverheadMs:
        first === undefined || rasterBuild === undefined ? 'unverified' : first.wallMs - rasterBuild.wallMs,
      svgPeakRssKiB: first?.peakRssKiB,
      rasterPeakRssKiB: rasterBuild?.peakRssKiB,
      note: 'The same corpus twice: once with SVG sources, once with the same pictures pre-rendered to WebP.',
    },
    determinism:
      deterministic === undefined ? 'unverified: builds skipped' : deterministic ? 'identical asset hashes' : 'DIFFERENT asset hashes',
    tarballBytes: tarball === undefined ? 'unverified: run pnpm run pack:tarball' : statSync(join(ROOT, tarball)).size,
    tarballName: tarball,
    dependencyBytes: {
      saxes: packageBytes('saxes'),
      'css-tree': packageBytes('css-tree'),
      // `saxes` declares `xmlchars`; it is not a third chosen package, but it is
      // part of what an install adds and leaving it out would understate the
      // delta. `css-tree` has no runtime dependencies.
      xmlchars: packageBytes('xmlchars'),
      total: [packageBytes('saxes'), packageBytes('css-tree'), packageBytes('xmlchars')].reduce<number>(
        (sum, value) => sum + (value ?? 0),
        0,
      ),
      note: 'pnpm-linked package directory sizes for the two added packages and saxes\' one transitive dependency.',
    },
    baseline: BASELINE,
    deltas: {
      tarballBytes: tarball === undefined ? 'unverified' : statSync(join(ROOT, tarball)).size - BASELINE.tarballBytes,
      repoDistBytes:
        'unverified: the 0011 baseline and this repository dist are different corpora',
      imageBytes: 'unverified: the 0011 corpus and this SVG corpus are different pictures',
      buildWallMs: 'unverified: goal 0011 did not record a comparable cold-build wall time on this host',
    },
    scope:
      'Latency is in-process prepareSvg over the committed fixtures; the first run of each fixture includes any one-off font scan. Build wall time and peak RSS are the shipped binary under /usr/bin/time -v on this host, SVG corpus versus the same pictures pre-rendered. distBytes here is the measurement corpus, not this repository\'s own dist/.',
  };
  if (option(argv, 'json') !== undefined) {
    writeFileSync(resolve(required(option(argv, 'json'), '--json')), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

process.exit(await main());
