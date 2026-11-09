/**
 * Host font coverage for the SVG text gate.
 *
 * Goal 0012 refuses a document whose visible text the host cannot draw. The
 * renderer cannot answer that question: Pango, when no font covers a character,
 * draws a **hex box** containing the code point rather than nothing, so a
 * missing CJK label is not a blank region and an ink check cannot see it.
 * Measured on this Linux host: U+10FFF0 renders a box reading `10FFF0`, U+E000 a
 * box reading `E000`, and `口` renders its own glyph — all three have ink.
 *
 * This module therefore answers the question Pango asks fontconfig: **is this
 * code point in the `cmap` of any installed font?** It reads the sfnt table
 * directory and only the `cmap` table of each font file, so a 250-font host is
 * scanned by reading a few hundred kilobytes per file rather than the fonts
 * themselves. Coverage is cached per process, because it is a property of the
 * host and not of a build.
 *
 * ## What this is not
 *
 * It is not a font fallback engine and does not choose a family. Pango falls
 * back through the host's font set per character — measured, CJK under
 * `font-family="DejaVu Sans"` renders identically to the default stack — so the
 * only question whose answer decides a reader's outcome is whether *any* font
 * covers the character. It is also not a claim about other hosts: coverage is
 * recomputed on the machine that builds the site, and byte identity across
 * machines is explicitly not promised.
 *
 * If **no font files are discoverable at all**, every code point is reported
 * missing. A host that cannot draw text cannot publish a diagram containing it,
 * and a clear failure is better than an unverified success.
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { SaxesParser } from 'saxes';

/** Font containers fontconfig enumerates that carry an sfnt `cmap`. */
const FONT_EXTENSIONS: Readonly<Record<string, true>> = {
  '.ttf': true,
  '.otf': true,
  '.ttc': true,
  '.otc': true,
};

/** A `cmap` larger than this is not a font this gate will read. */
const MAX_CMAP_BYTES = 16 * 1024 * 1024;

/** Directory recursion depth; deeper trees are configuration, not fonts. */
const MAX_DIRECTORY_DEPTH = 8;

/** Fontconfig `<include>` nesting; fontconfig itself has no useful deeper chain. */
const MAX_CONFIG_INCLUDE_DEPTH = 8;

/** Faces in one collection; real `.ttc` files carry a handful. */
const MAX_COLLECTION_FACES = 64;

/** Tables in one font directory. */
const MAX_TABLES = 4_096;

/** Per-process coverage, so a multi-SVG build reads each font once. */
const coverageCache = new Map<number, boolean>();

/** The directories searched on this host, cached with the discovery itself. */
export interface FontDiscovery {
  readonly directories: readonly string[];
  readonly files: readonly string[];
  /** Fontconfig `<include>` files followed, for the measurement report. */
  readonly includes: number;
  /** Includes seen but not followed: missing, unresolvable, repeated or too deep. */
  readonly skippedIncludes: number;
}

/** Read a slice of an open file, or `undefined` when it cannot be read. */
function readSlice(fd: number, position: number, length: number): Buffer | undefined {
  if (length <= 0 || length > MAX_CMAP_BYTES) return undefined;
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    let count: number;
    try {
      count = readSync(fd, buffer, read, length - read, position + read);
    } catch {
      return undefined;
    }
    if (count === 0) return undefined;
    read += count;
  }
  return buffer;
}

/** Discovery state shared by a config file and the includes it follows. */
interface FontConfigState {
  readonly directories: string[];
  readonly visited: Set<string>;
  includes: number;
  skippedIncludes: number;
}

/**
 * Resolve a fontconfig `<dir>` or `<include>` path.
 *
 * `base` is the including file's directory for `<include>`; `<dir>` passes
 * `undefined`, which preserves the old policy of not guessing where a relative
 * font directory points.
 */
function resolveConfigPath(value: string, prefix: string | undefined, base: string | undefined): string | undefined {
  const path = value.trim();
  if (path === '') return undefined;
  if (prefix === 'cwd') return undefined;
  if (prefix === 'xdg') {
    return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), path);
  }
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (isAbsolute(path)) return path;
  // A relative `<include>` is relative to the file that contains it. A relative
  // `<dir>` has no such carrier here and is skipped, as before.
  return base === undefined ? undefined : resolve(base, path);
}

/**
 * Read one fontconfig XML file and its `<include>` chain.
 *
 * `<dir>` entries and the `prefix` attribute are honoured. An `<include>` is
 * followed relative to the including file (or by `prefix`), up to
 * {@link MAX_CONFIG_INCLUDE_DEPTH}; repeated, missing, unresolvable and
 * too-deep includes are counted in `skippedIncludes`, never silently dropped
 * from the count. A directory include (fontconfig's `conf.d`) is skipped here
 * because the Linux branch enumerates `conf.d` directly. Malformed XML keeps
 * whatever was parsed before the error.
 */
function parseFontConfig(path: string, depth: number, state: FontConfigState): boolean {
  let resolvedPath: string;
  try {
    resolvedPath = resolve(path);
    if (!statSync(resolvedPath).isFile()) return false;
  } catch {
    return false;
  }
  if (state.visited.has(resolvedPath)) return false;
  state.visited.add(resolvedPath);

  let text: string;
  try {
    text = readTextFile(resolvedPath);
  } catch {
    return false;
  }

  const parser = new SaxesParser();
  let directory: string | undefined;
  let directoryPrefix: string | undefined;
  let include: string | undefined;
  let includePrefix: string | undefined;

  parser.on('opentag', (tag) => {
    if (tag.name.toLowerCase() === 'dir') {
      directory = '';
      directoryPrefix = tag.attributes['prefix'];
    } else if (tag.name.toLowerCase() === 'include') {
      include = '';
      includePrefix = tag.attributes['prefix'];
    }
  });
  parser.on('text', (value) => {
    if (directory !== undefined) directory += value;
    else if (include !== undefined) include += value;
  });
  parser.on('closetag', (tag) => {
    const name = tag.name.toLowerCase();
    if (name === 'dir' && directory !== undefined) {
      const target = resolveConfigPath(directory, directoryPrefix, undefined);
      directory = undefined;
      directoryPrefix = undefined;
      if (target !== undefined) state.directories.push(target);
    } else if (name === 'include' && include !== undefined) {
      const target = resolveConfigPath(include, includePrefix, dirname(resolvedPath));
      include = undefined;
      includePrefix = undefined;
      if (target === undefined || depth >= MAX_CONFIG_INCLUDE_DEPTH) {
        state.skippedIncludes += 1;
      } else if (parseFontConfig(target, depth + 1, state)) {
        state.includes += 1;
      } else {
        state.skippedIncludes += 1;
      }
    }
  });

  try {
    parser.write(text).close();
  } catch {
    // A malformed config is the host's, not the site's; keep what parsed.
  }
  return true;
}

function readTextFile(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const stat = statSync(path);
    return readSlice(fd, 0, Math.min(stat.size, 4 * 1024 * 1024))?.toString('utf8') ?? '';
  } finally {
    closeSync(fd);
  }
}

/** The host's font directories and the config includes followed to find them. */
function fontDirectories(): {
  readonly directories: string[];
  readonly includes: number;
  readonly skippedIncludes: number;
} {
  const state: FontConfigState = {
    directories: [],
    visited: new Set(),
    includes: 0,
    skippedIncludes: 0,
  };
  if (process.platform === 'linux') {
    parseFontConfig('/etc/fonts/fonts.conf', 0, state);
    try {
      for (const name of readdirSync('/etc/fonts/conf.d').sort()) {
        if (name.endsWith('.conf')) parseFontConfig(join('/etc/fonts/conf.d', name), 0, state);
      }
    } catch {
      // No conf.d is ordinary; the base file and the per-user directories remain.
    }
    state.directories.push(join(homedir(), '.fonts'), join(homedir(), '.local', 'share', 'fonts'));
  } else if (process.platform === 'darwin') {
    state.directories.push(
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      join(homedir(), 'Library', 'Fonts'),
    );
  } else if (process.platform === 'win32') {
    const windir = process.env['WINDIR'] ?? 'C:\\Windows';
    state.directories.push(join(windir, 'Fonts'));
    const local = process.env['LOCALAPPDATA'];
    if (local !== undefined) state.directories.push(join(local, 'Microsoft', 'Windows', 'Fonts'));
  }
  return {
    directories: [...new Set(state.directories)],
    includes: state.includes,
    skippedIncludes: state.skippedIncludes,
  };
}

/** Recursively collect font containers under one directory. */
function fontFilesUnder(directory: string, depth: number, into: string[]): void {
  if (depth > MAX_DIRECTORY_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(directory).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      fontFilesUnder(path, depth + 1, into);
    } else if (FONT_EXTENSIONS[extname(entry).toLowerCase()] === true) {
      into.push(path);
    }
  }
}

/** One discovery walk per process: a build cannot change the host font set. */
let discoveryCache: FontDiscovery | undefined;

/** The font files this host would offer fontconfig, deterministically ordered. */
export function discoverFonts(): FontDiscovery {
  if (discoveryCache !== undefined) return discoveryCache;
  const { directories, includes, skippedIncludes } = fontDirectories();
  const files: string[] = [];
  for (const directory of directories) fontFilesUnder(directory, 0, files);
  files.sort();
  return (discoveryCache = { directories, files, includes, skippedIncludes });
}

/** Offset tables of the faces in one sfnt container. */
function faceDirectories(buffer: Buffer): number[] {
  if (buffer.length < 12) return [];
  if (buffer.toString('latin1', 0, 4) === 'ttcf') {
    const count = Math.min(buffer.readUInt32BE(8), MAX_COLLECTION_FACES);
    const faces: number[] = [];
    for (let index = 0; index < count; index++) {
      const at = 12 + index * 4;
      if (at + 4 > buffer.length) break;
      faces.push(buffer.readUInt32BE(at));
    }
    return faces;
  }
  return [0];
}

/** Whether one code point has a non-zero glyph in a single `cmap` table. */
function coveredBySubtable(cmap: Buffer, offset: number, codePoint: number): boolean {
  if (offset + 2 > cmap.length) return false;
  const format = cmap.readUInt16BE(offset);
  if (format === 0) {
    if (codePoint > 0xff || offset + 6 + 256 > cmap.length) return false;
    return cmap[offset + 6 + codePoint] !== 0;
  }
  if (format === 4) {
    if (codePoint > 0xffff || offset + 14 > cmap.length) return false;
    const segments = cmap.readUInt16BE(offset + 6) >> 1;
    const endBase = offset + 14;
    const startBase = endBase + segments * 2 + 2;
    const deltaBase = startBase + segments * 2;
    const rangeBase = deltaBase + segments * 2;
    if (rangeBase + segments * 2 > cmap.length) return false;
    let low = 0;
    let high = segments - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const end = cmap.readUInt16BE(endBase + middle * 2);
      if (end < codePoint) low = middle + 1;
      else high = middle - 1;
    }
    if (low >= segments) return false;
    const start = cmap.readUInt16BE(startBase + low * 2);
    if (start > codePoint) return false;
    const delta = cmap.readInt16BE(deltaBase + low * 2);
    const rangeOffset = cmap.readUInt16BE(rangeBase + low * 2);
    if (rangeOffset === 0) return ((codePoint + delta) & 0xffff) !== 0;
    const glyphAt = rangeBase + low * 2 + rangeOffset + (codePoint - start) * 2;
    if (glyphAt + 2 > cmap.length) return false;
    const glyph = cmap.readUInt16BE(glyphAt);
    return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
  }
  if (format === 6) {
    if (offset + 10 > cmap.length) return false;
    const first = cmap.readUInt16BE(offset + 6);
    const count = cmap.readUInt16BE(offset + 8);
    if (codePoint < first || codePoint >= first + count) return false;
    const glyphAt = offset + 10 + (codePoint - first) * 2;
    return glyphAt + 2 <= cmap.length && cmap.readUInt16BE(glyphAt) !== 0;
  }
  if (format === 12) {
    if (offset + 16 > cmap.length) return false;
    const groups = Math.min(cmap.readUInt32BE(offset + 12), 1_000_000);
    const groupsBase = offset + 16;
    if (groupsBase + groups * 12 > cmap.length) return false;
    let low = 0;
    let high = groups - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const at = groupsBase + middle * 12;
      const start = cmap.readUInt32BE(at);
      const end = cmap.readUInt32BE(at + 4);
      if (codePoint < start) high = middle - 1;
      else if (codePoint > end) low = middle + 1;
      else {
        const glyph = cmap.readUInt32BE(at + 8) + (codePoint - start);
        return glyph !== 0;
      }
    }
    return false;
  }
  return false;
}

/**
 * Whether one code point has a glyph in an accepted Unicode subtable of one
 * `cmap`.
 *
 * Exported for the synthetic Macintosh-cmap test; the scan itself uses this
 * function directly.
 */
export function coveredByCmap(cmap: Buffer, codePoint: number): boolean {
  if (cmap.length < 4) return false;
  const tables = cmap.readUInt16BE(2);
  for (let index = 0; index < tables; index++) {
    const record = 4 + index * 8;
    if (record + 8 > cmap.length) break;
    const platform = cmap.readUInt16BE(record);
    const encoding = cmap.readUInt16BE(record + 2);
    // Pango and fontconfig ask the Unicode charmaps. A Macintosh or symbol
    // record indexed as Unicode would report a glyph the renderer never draws.
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const offset = cmap.readUInt32BE(record + 4);
    if (coveredBySubtable(cmap, offset, codePoint)) return true;
  }
  return false;
}

/** The `cmap` tables of every face in one font file. */
function cmapsOfFile(fd: number, size: number): Buffer[] {
  let header = readSlice(fd, 0, 12);
  if (header === undefined) return [];
  // A collection's offset array lives past the 12-byte preamble, so the first
  // read is extended before the faces are enumerated. Reading only 12–16 bytes
  // would silently see face 0 and miss a glyph that lives in a sibling face of a
  // `.ttc`, which is exactly how Noto CJK is distributed.
  if (header.toString('latin1', 0, 4) === 'ttcf') {
    const count = Math.min(header.readUInt32BE(8), MAX_COLLECTION_FACES);
    const extended = readSlice(fd, 0, 12 + count * 4);
    if (extended !== undefined) header = extended;
  }
  const cmaps: Buffer[] = [];
  for (const base of faceDirectories(header)) {
    const directory = readSlice(fd, base, 12);
    if (directory === undefined || directory.length < 12) continue;
    const tables = Math.min(directory.readUInt16BE(4), MAX_TABLES);
    const records = readSlice(fd, base + 12, tables * 16);
    if (records === undefined) continue;
    for (let index = 0; index < tables; index++) {
      const at = index * 16;
      if (at + 16 > records.length) break;
      if (records.toString('latin1', at, at + 4) !== 'cmap') continue;
      const offset = records.readUInt32BE(at + 8);
      const length = records.readUInt32BE(at + 12);
      if (offset + length > size) break;
      const cmap = readSlice(fd, offset, Math.min(length, MAX_CMAP_BYTES));
      if (cmap !== undefined) cmaps.push(cmap);
      break;
    }
  }
  return cmaps;
}

/**
 * The code points this host cannot draw, with the fonts that were consulted.
 *
 * One pass over the font files, not one pass per code point: each file's `cmap`
 * tables are read once and answer every still-unresolved code point, and the
 * scan stops as soon as none remain. Latin text therefore normally stops at the
 * first font, while CJK text reaches the CJK families.
 *
 * @param codePoints Distinct code points a document's text uses.
 * @returns the missing subset in input order, plus the discovery count for the
 *   private diagnostic.
 */
export function missingCodePoints(codePoints: readonly number[]): {
  readonly missing: readonly number[];
  readonly fonts: number;
} {
  const { files } = discoverFonts();
  const remaining = new Set<number>();
  for (const codePoint of codePoints) {
    if (coverageCache.get(codePoint) !== true) remaining.add(codePoint);
  }

  for (const file of files) {
    if (remaining.size === 0) break;
    let fd: number;
    let size: number;
    try {
      fd = openSync(file, 'r');
      size = statSync(file).size;
    } catch {
      continue;
    }
    let cmaps: Buffer[];
    try {
      cmaps = cmapsOfFile(fd, size);
    } finally {
      closeSync(fd);
    }
    if (cmaps.length === 0) continue;
    for (const codePoint of remaining) {
      if (cmaps.some((cmap) => coveredByCmap(cmap, codePoint))) {
        coverageCache.set(codePoint, true);
        remaining.delete(codePoint);
      }
    }
  }

  const missing = codePoints.filter((codePoint) => coverageCache.get(codePoint) !== true);
  return { missing, fonts: files.length };
}
