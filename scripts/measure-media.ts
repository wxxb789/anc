/**
 * Goal 0011's measurement report: published image bytes, per source/emitted
 * format, transcode count and asset count, from an actual built `dist/`.
 *
 * The measurement is deliberately an independent reader of the output rather
 * than a hook inside the producer. It re-hashes every `/_assets/` file against
 * the digest its name claims, detects the emitted format from the bytes, and
 * maps each asset back to the corpus source that produced it by the sanitized
 * stem in its name. That keeps the numbers about the artifact a reader gets, and
 * it means a producer that lied about identity cannot make this report agree.
 *
 * Usage:
 *   node scripts/measure-media.ts --corpus .tmp/media-corpus \
 *     --dist .tmp/measure/optimized-dist --label optimized [--json report.json] [--quality]
 *
 * `--quality` additionally decodes each transcoded source and candidate with
 * sharp and reports whether a lossless conversion is pixel-identical (alpha
 * included) or, for a lossy conversion, the PSNR of the displayed pixels. That is
 * a qualification measurement, not a per-build comparison.
 *
 * The report has no timing or memory claim: those are measured by wrapping the
 * whole build in `/usr/bin/time -v` in the goal record, because this process
 * cannot observe a build it did not run.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { imageExtension, parseAssetUrl, sniffImageFormat } from '../src/lib/media.ts';

interface SourceRow {
  readonly path: string;
  readonly name: string;
  readonly format: string;
  readonly bytes: number;
}

interface Manifest {
  readonly sources: readonly SourceRow[];
}

/** Every file under a directory, as paths relative to it. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path).map((child) => join(name, child)));
    else found.push(name);
  }
  return found;
}

const ALLOWED_OPTIONS = new Set(['corpus', 'dist', 'label', 'json', 'quality']);

/**
 * Parse `--name value` pairs, refusing an unknown or repeated option.
 *
 * The allowlist is the point: without it a typo such as `--qualtiy` is stored
 * under a name nothing reads, so the command exits 0 having silently skipped the
 * check the caller asked for.
 */
export function options(argv: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === undefined || !key.startsWith('--')) throw new Error('options start with --: ' + argv.join(' '));
    const name = key.slice(2);
    if (!ALLOWED_OPTIONS.has(name)) {
      throw new Error(`unknown option ${key}; expected one of ${[...ALLOWED_OPTIONS].join(', ')}`);
    }
    if (parsed.has(name)) throw new Error(`option ${key} appears twice`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed.set(name, 'true');
      continue;
    }
    parsed.set(name, next);
    index += 1;
  }
  return parsed;
}

/** Decode a picture to displayed RGBA, applying EXIF orientation. */
async function displayedRgba(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).autoOrient().ensureAlpha().raw().toBuffer();
}

/** The source stem a published asset name carries, for provenance. */
function stemOf(name: string): string {
  return parse(name).name;
}

/** Percentage saved, rounded to one decimal without inventing a value at zero. */
function savingPercent(sourceBytes: number, emittedBytes: number): number {
  return sourceBytes === 0 ? 0 : Number((100 * (1 - emittedBytes / sourceBytes)).toFixed(1));
}

async function main(): Promise<number> {
  const parsed = options(process.argv.slice(2));
  const corpus = resolve(parsed.get('corpus') ?? '.tmp/media-corpus');
  const dist = resolve(parsed.get('dist') ?? '.tmp/measure/optimized-dist');
  const label = parsed.get('label') ?? 'build';
  const manifest = JSON.parse(readFileSync(join(corpus, 'manifest.json'), 'utf8')) as Manifest;

  const sourcesByStem = new Map<string, { source: SourceRow; digest: string }>();
  for (const source of manifest.sources) {
    const stem = stemOf(basename(source.path));
    if (sourcesByStem.has(stem)) throw new Error(`the corpus has two sources named ${stem}; provenance would be ambiguous`);
    sourcesByStem.set(stem, {
      source,
      digest: createHash('sha256').update(readFileSync(join(corpus, source.path))).digest('hex'),
    });
  }
  const sourceTotal = manifest.sources.reduce((sum, source) => sum + source.bytes, 0);

  const quality = parsed.has('quality');
  const assetDirectory = join(dist, '_assets');
  const assetFiles = readdirSync(assetDirectory).sort();
  const byEmitted = new Map<string, { files: number; bytes: number }>();
  const bySource = new Map<string, { files: number; sourceBytes: number; emittedBytes: number }>();
  let imageBytes = 0;
  let transcoded = 0;
  let passthrough = 0;
  const perSource: {
    source: string;
    sourceFormat: string;
    sourceBytes: number;
    emittedFormat: string;
    emittedBytes: number;
    savingPercent: number;
    transcoded: boolean;
    quality?: { alphaIdentical: boolean; visiblePixelsIdentical: boolean; psnr: number | null };
  }[] = [];

  for (const file of assetFiles) {
    const bytes = readFileSync(join(assetDirectory, file));
    const parsedUrl = parseAssetUrl(`/_assets/${file}`);
    if (parsedUrl === undefined) throw new Error(`${file} is not a canonical asset name`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== parsedUrl.digest) throw new Error(`${file} does not hash to its own digest`);
    const format = sniffImageFormat(bytes);
    if (format === undefined) throw new Error(`${file} is not a supported emitted image`);
    const extension = file.slice(file.lastIndexOf('.'));
    if (imageExtension(format) !== extension) throw new Error(`${file} extension disagrees with its bytes`);

    const emitted = byEmitted.get(format) ?? { files: 0, bytes: 0 };
    emitted.files += 1;
    emitted.bytes += bytes.length;
    byEmitted.set(format, emitted);
    imageBytes += bytes.length;

    const stem = stemOf(parsedUrl.fileName);
    const match = sourcesByStem.get(stem);
    if (match === undefined) throw new Error(`${file} has no source in the corpus manifest`);
    const source = match.source;
    const sourceRow = bySource.get(source.format) ?? { files: 0, sourceBytes: 0, emittedBytes: 0 };
    sourceRow.files += 1;
    sourceRow.sourceBytes += source.bytes;
    sourceRow.emittedBytes += bytes.length;
    bySource.set(source.format, sourceRow);

    const isPassthrough = digest === match.digest;
    if (isPassthrough) passthrough += 1;
    else transcoded += 1;
    perSource.push({
      source: source.path,
      sourceFormat: source.format,
      sourceBytes: source.bytes,
      emittedFormat: format,
      emittedBytes: bytes.length,
      savingPercent: savingPercent(source.bytes, bytes.length),
      transcoded: !isPassthrough,
    });
    if (quality && !isPassthrough && (source.format === 'png' || source.format === 'jpeg')) {
      const original = await displayedRgba(readFileSync(join(corpus, source.path)));
      const published = await displayedRgba(bytes);
      // Displayed pixels, not stored bytes: a fully transparent pixel's RGB is
      // not visible, and WebP is free not to preserve it. The alpha channel and
      // every pixel with alpha > 0 must match exactly for a lossless conversion.
      let alphaIdentical = original.length === published.length;
      let visiblePixelsIdentical = alphaIdentical;
      let squared = 0;
      let visibleSamples = 0;
      if (alphaIdentical) {
        for (let index = 0; index < original.length; index += 4) {
          if (original[index + 3] !== published[index + 3]) {
            alphaIdentical = false;
            visiblePixelsIdentical = false;
          }
          if (original[index + 3] === 0) continue;
          for (let channel = 0; channel < 3; channel++) {
            const delta = original[index + channel]! - published[index + channel]!;
            if (delta !== 0) visiblePixelsIdentical = false;
            squared += delta * delta;
            visibleSamples += 1;
          }
        }
      }
      let psnr: number | null = null;
      if (!visiblePixelsIdentical && visibleSamples > 0) {
        const mse = squared / visibleSamples;
        psnr = Number((10 * Math.log10((255 * 255) / mse)).toFixed(2));
      }
      perSource[perSource.length - 1]!.quality = { alphaIdentical, visiblePixelsIdentical, psnr };
    }
  }

  const distBytes = filesUnder(dist).reduce((sum, file) => sum + statSync(join(dist, file)).size, 0);
  const report = {
    label,
    corpus,
    dist,
    assets: assetFiles.length,
    sources: manifest.sources.length,
    images: {
      bytes: imageBytes,
      distBytes,
      bytesSaved: sourceTotal - imageBytes,
      sourceBytes: sourceTotal,
      transcoded,
      passthrough,
    },
    byEmittedFormat: Object.fromEntries([...byEmitted].sort()),
    perSource: perSource.sort((left, right) => (left.source < right.source ? -1 : left.source > right.source ? 1 : 0)),
    bySourceFormat: Object.fromEntries(
      [...bySource]
        .sort()
        .map(([format, row]) => [
          format,
          {
            ...row,
            savedBytes: row.sourceBytes - row.emittedBytes,
            savingPercent: savingPercent(row.sourceBytes, row.emittedBytes),
          },
        ]),
    ),
    assetFiles,
  };
  if (parsed.has('json')) writeFileSync(resolve(parsed.get('json')!), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
