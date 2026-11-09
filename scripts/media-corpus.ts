/**
 * Generate Goal 0011's measurement corpus, deterministically, under `.tmp`.
 *
 * This is a measurement input, not product code: it lives in `scripts/` because
 * that is where this repository keeps its runnable instruments, and it is
 * excluded from the published package. It uses sharp to *create* the sources —
 * SVG text, photographs, diagrams, transparency and animations — and then the
 * build reads only raster files from the generated directory. SVG support in the
 * product is Goal 0012's and is not exercised or claimed here.
 *
 * The corpus carries the cases the goal names rather than a convenient set:
 *
 * - two photographs whose JPEG source is larger than a q80 WebP candidate;
 * - a CJK/UI screenshot and a thin-line diagram, both PNG, where lossless WebP
 *   must be compared rather than assumed smaller;
 * - transparent artwork, for alpha;
 * - an already-compressed WebP and AVIF, which must pass through unchanged;
 * - animated GIF and WebP, which must keep every frame and delay.
 *
 * `manifest.json` records each source's path, detected format and byte length so
 * the report can say which published WebP came from which source rather than
 * inferring provenance from an extension.
 *
 * Usage: `node scripts/media-corpus.ts [directory]`, default
 * `.tmp/media-corpus`, prints the directory and a JSON summary.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { sniffImageFormat } from '../src/lib/media.ts';

/** A small deterministic PRNG, so two runs of this script write the same bytes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

/** Raw RGB with gradients, shapes and grain: compressible, but not a flat colour. */
export function photographicRgb(width: number, height: number, seed: number): Buffer {
  const random = seeded(seed);
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      const u = x / width;
      const v = y / height;
      const structure =
        Math.sin(u * 13.1) * 0.11 + Math.cos(v * 9.7) * 0.09 + Math.sin((u + v * 0.7) * 6.3) * 0.06;
      const grain = (random() - 0.5) * 0.055;
      const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(255 * value)));
      raw[index] = clamp(0.5 + 0.38 * v + structure + grain);
      raw[index + 1] = clamp(0.42 + 0.3 * (1 - v) + structure * 0.7 + grain);
      raw[index + 2] = clamp(0.28 + 0.42 * u + structure * 0.45 + grain);
    }
  }
  return raw;
}

/** A CJK and Latin UI screenshot: small text, rules and a heading bar. */
export function screenshotSvg(width: number, height: number): string {
  const lines = [
    '构建流水线：从 Markdown 到静态站点',
    '发布、排除、隐私、链接、图片与搜索索引。',
    'The quick brown fox jumps over the lazy dog.',
    '第 3 行：一个包含中文、English 与数字 1234567890 的句子。',
    '第 4 行：细线、表格边框和等宽代码 `const value = 42;`。',
    '第 5 行：透明背景与阴影不是这张截图的一部分。',
    '第 6 行：小字号在缩放后仍需清晰可读。',
  ];
  const rows = lines
    .map(
      (line, index) =>
        `<text x="48" y="${150 + index * 54}" font-family="Noto Sans CJK JP, Noto Sans, sans-serif" font-size="${index === 0 ? 32 : 24}" fill="#1c222a">${line}</text>` +
        (index > 0
          ? `<line x1="48" y1="${168 + index * 54}" x2="${48 + 900 + ((index * 53) % 160)}" y2="${168 + index * 54}" stroke="#b9c0c8" stroke-width="1"/>`
          : ''),
    )
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<rect x="24" y="24" width="${width - 48}" height="76" rx="8" fill="#161b21"/>`,
    `<circle cx="${width - 56}" cy="62" r="12" fill="#8ad884"/>`,
    rows,
    `<rect x="48" y="${height - 90}" width="${width - 96}" height="2" fill="#69737f"/>`,
    `</svg>`,
  ].join('');
}

/** A diagram: thin lines, arrow heads, a gradient and bilingual labels. */
export function diagramSvg(width: number, height: number): string {
  const boxes = [
    ['Markdown', 70, 120],
    ['Discovery', 330, 120],
    ['Producer', 590, 120],
    ['Static output', 850, 120],
    ['图片 / images', 330, 320],
    ['SQLite/WASM', 590, 320],
  ] as const;
  const boxMarkup = boxes
    .map(
      ([label, x, y]) =>
        `<rect x="${x}" y="${y}" width="190" height="78" rx="10" fill="#f4f7fa" stroke="#3c4652" stroke-width="1.2"/>` +
        `<text x="${x + 18}" y="${y + 46}" font-family="Noto Sans CJK JP, Noto Sans, sans-serif" font-size="20" fill="#161b21">${label}</text>`,
    )
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<defs><linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#86c8e6"/><stop offset="1" stop-color="#8ad884"/></linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="#fbfcfd"/>`,
    `<text x="70" y="62" font-family="Noto Sans CJK JP, Noto Sans, sans-serif" font-size="28" fill="#161b21">构建 → 发布 / build → publish</text>`,
    `<path d="M260 159 L330 159 M520 159 L590 159 M780 159 L850 159 M685 198 L520 320 M425 359 L330 359" stroke="url(#fade)" stroke-width="2" fill="none"/>`,
    `<path d="M325 154 L335 159 L325 164 Z M585 154 L595 159 L585 164 Z M845 154 L855 159 L845 164 Z" fill="#3c4652"/>`,
    boxMarkup,
    `</svg>`,
  ].join('');
}

/** Transparent artwork with soft edges, where alpha must survive conversion. */
export function transparentSvg(width: number, height: number): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<defs><radialGradient id="glow"><stop offset="0" stop-color="#86c8e6" stop-opacity="0.9"/><stop offset="1" stop-color="#86c8e6" stop-opacity="0"/></radialGradient></defs>`,
    `<circle cx="${width / 2}" cy="${height / 2}" r="${height / 2 - 10}" fill="url(#glow)"/>`,
    `<rect x="80" y="80" width="${width / 2}" height="${height / 2}" fill="#8ad884" fill-opacity="0.55"/>`,
    `<path d="M80 ${height - 80} L${width / 2} 120 L${width - 80} ${height - 80} Z" fill="none" stroke="#f08c8c" stroke-width="3"/>`,
    `</svg>`,
  ].join('');
}

/** Six PNG frames, joined into one animated GIF or WebP. */
async function animationFrames(width: number, height: number): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for (let frame = 0; frame < 6; frame++) {
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 3;
        const phase = (x + frame * 24) % width;
        raw[index] = Math.round(255 * (phase / width));
        raw[index + 1] = Math.round(255 * (y / height));
        raw[index + 2] = frame * 35;
      }
    }
    frames.push(await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer());
  }
  return frames;
}

async function main(): Promise<number> {
  const root = resolve(process.argv[2] ?? join('.tmp', 'media-corpus'));
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'media'), { recursive: true });

  const media = join(root, 'media');
  const write = (name: string, bytes: Buffer): void => {
    writeFileSync(join(media, name), bytes);
  };

  write(
    'photo-forest.jpg',
    await sharp(photographicRgb(1600, 1200, 0x1234), { raw: { width: 1600, height: 1200, channels: 3 } })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
      .toBuffer(),
  );
  write(
    'photo-studio.jpg',
    await sharp(photographicRgb(1280, 960, 0x5678), { raw: { width: 1280, height: 960, channels: 3 } })
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
      .toBuffer(),
  );
  write('cjk-screenshot.png', await sharp(Buffer.from(screenshotSvg(1200, 800))).png({ compressionLevel: 9 }).toBuffer());
  write('diagram.png', await sharp(Buffer.from(diagramSvg(1100, 520))).png({ compressionLevel: 9 }).toBuffer());
  write('transparent.png', await sharp(Buffer.from(transparentSvg(800, 600))).png({ compressionLevel: 9 }).toBuffer());

  const compressed = await sharp(photographicRgb(800, 600, 0x9abc), {
    raw: { width: 800, height: 600, channels: 3 },
  })
    .webp({ quality: 55, effort: 4 })
    .toBuffer();
  write('already-compressed.webp', compressed);

  const still = await sharp(photographicRgb(640, 480, 0xdef0), {
    raw: { width: 640, height: 480, channels: 3 },
  })
    .avif({ quality: 50, effort: 4 })
    .toBuffer();
  write('already-compressed-avif.avif', still);

  const frames = await animationFrames(480, 320);
  write('animation.gif', await sharp(frames, { join: { animated: true } }).gif().toBuffer());
  write('animation-webp.webp', await sharp(frames, { join: { animated: true } }).webp({ quality: 70, effort: 4 }).toBuffer());

  const note = (title: string, body: string): string => `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
  const references = [
    '![a photograph](media/photo-forest.jpg "A forest photograph")',
    '![a second photograph](media/photo-studio.jpg)',
    '![a CJK and UI screenshot](media/cjk-screenshot.png "Small text must stay legible")',
    '![a thin-line diagram](media/diagram.png)',
    '![](media/transparent.png)',
    '![an already-compressed WebP](media/already-compressed.webp)',
    '![an already-compressed AVIF](media/already-compressed-avif.avif)',
    '![an animated GIF](media/animation.gif)',
    '![an animated WebP](media/animation-webp.webp)',
  ];
  writeFileSync(join(root, 'gallery.md'), note('Measurement gallery', references.join('\n\n')), 'utf8');
  writeFileSync(
    join(root, 'second.md'),
    note('Second measurement note', 'The first photograph again, from another note:\n\n![the shared photograph](media/photo-forest.jpg)'),
    'utf8',
  );

  // The producer reads commit dates for `created`/`updated`; an ordinary corpus
  // is a git repository, and the measurement should exercise that path.
  spawnSync('git', ['init', '--quiet'], { cwd: root });
  const staged = spawnSync('git', ['-c', 'user.name=Measurement', '-c', 'user.email=measurement@example.invalid', 'add', '--', '.'], { cwd: root });
  if (staged.status === 0) {
    spawnSync(
      'git',
      ['-c', 'user.name=Measurement', '-c', 'user.email=measurement@example.invalid', 'commit', '--quiet', '-m', 'corpus'],
      { cwd: root },
    );
  }

  const unique = [
    ...new Set(references.map((reference) => /\((?:<)?([^)>\s]+)(?:>)?(?:\s+"[^"]*")?\)/.exec(reference)![1]!)),
  ];
  const manifest = {
    version: 1,
    root,
    notes: ['gallery.md', 'second.md'],
    sources: unique.map((path) => {
      const bytes = readFileSync(join(root, path));
      return {
        path,
        name: basename(path),
        format: sniffImageFormat(bytes) ?? 'unknown',
        bytes: bytes.length,
      };
    }),
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const total = manifest.sources.reduce((sum, source) => sum + source.bytes, 0);
  console.log(JSON.stringify({ root, sources: manifest.sources.length, bytes: total }));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
