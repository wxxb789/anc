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
  /** Fontconfig `<include>` directories followed, for the measurement report. */
  readonly includeDirectories: number;
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
  readonly followedDirectories: Set<string>;
  readonly rules: FontRule[];
  includes: number;
  includeDirectories: number;
  skippedIncludes: number;
}

/** One fontconfig `<rejectfont>`/`<acceptfont>` matcher, in configuration order. */
interface FontRule {
  readonly action: 'accept' | 'reject';
  readonly glob?: string;
  readonly family?: string;
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
    // Fontconfig resolves an XDG *directory* against XDG_DATA_HOME and an
    // XDG *include* against XDG_CONFIG_HOME. Using the data directory for an
    // include silently missed ~/.config/fontconfig/fonts.conf.
    const xdg =
      base === undefined
        ? (process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'))
        : (process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'));
    return join(xdg, path);
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
  let action: FontRule['action'] | undefined;
  let globText: string | undefined;
  let patternFamilies: string[] | undefined;
  let pateltName: string | undefined;
  let stringText: string | undefined;

  parser.on('opentag', (tag) => {
    const name = tag.name.toLowerCase();
    if (name === 'dir') {
      directory = '';
      directoryPrefix = tag.attributes['prefix'];
    } else if (name === 'include') {
      include = '';
      includePrefix = tag.attributes['prefix'];
    } else if (name === 'rejectfont') {
      action = 'reject';
    } else if (name === 'acceptfont') {
      action = 'accept';
    } else if (name === 'glob') {
      globText = '';
    } else if (name === 'pattern') {
      patternFamilies = [];
    } else if (name === 'patelt') {
      pateltName = tag.attributes['name']?.toLowerCase();
    } else if (name === 'string') {
      stringText = '';
    }
  });
  const collect = (value: string): void => {
    if (directory !== undefined) directory += value;
    else if (include !== undefined) include += value;
    else if (globText !== undefined) globText += value;
    else if (stringText !== undefined) stringText += value;
  };
  parser.on('text', collect);
  parser.on('cdata', collect);
  parser.on('closetag', (tag) => {
    const name = tag.name.toLowerCase();
    if (name === 'dir' && directory !== undefined) {
      const target = resolveConfigPath(directory, directoryPrefix, undefined);
      directory = undefined;
      directoryPrefix = undefined;
      if (target !== undefined) state.directories.push(target);
    } else if (name === 'glob' && globText !== undefined) {
      const glob = globText.trim();
      globText = undefined;
      if (action !== undefined && glob !== '') state.rules.push({ action, glob });
    } else if (name === 'string' && stringText !== undefined) {
      const text = stringText.trim();
      stringText = undefined;
      if (patternFamilies !== undefined && pateltName === 'family' && text !== '') {
        patternFamilies.push(text);
      }
    } else if (name === 'patelt') {
      pateltName = undefined;
    } else if (name === 'pattern') {
      if (action !== undefined && patternFamilies !== undefined) {
        for (const family of patternFamilies) state.rules.push({ action, family });
      }
      patternFamilies = undefined;
    } else if (name === 'rejectfont' || name === 'acceptfont') {
      action = undefined;
    } else if (name === 'include' && include !== undefined) {
      const target = resolveConfigPath(include, includePrefix, dirname(resolvedPath));
      include = undefined;
      includePrefix = undefined;
      if (target === undefined || depth >= MAX_CONFIG_INCLUDE_DEPTH) {
        state.skippedIncludes += 1;
      } else {
        let targetIsDirectory = false;
        try {
          targetIsDirectory = statSync(target).isDirectory();
        } catch {
          state.skippedIncludes += 1;
          return;
        }
        if (targetIsDirectory) {
          const directory = resolve(target);
          state.followedDirectories.add(directory);
          state.includeDirectories += 1;
          let entries: string[];
          try {
            entries = readdirSync(directory).sort();
          } catch {
            state.skippedIncludes += 1;
            return;
          }
          for (const name of entries) {
            if (!/^[0-9].*\.conf$/i.test(name)) continue;
            if (parseFontConfig(join(directory, name), depth + 1, state)) state.includes += 1;
            else state.skippedIncludes += 1;
          }
        } else if (parseFontConfig(target, depth + 1, state)) {
          state.includes += 1;
        } else {
          state.skippedIncludes += 1;
        }
      }
    }
  });

  let malformed = false;
  try {
    parser.write(text).close();
  } catch {
    // A malformed config is the host's, not the site's; keep what parsed and
    // report the file as skipped rather than as a followed include.
    malformed = true;
  }
  return !malformed;
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

/**
 * The master configuration fontconfig would read, and every candidate tried.
 *
 * An absolute name is used as written. Every other name — the implicit
 * `fonts.conf` and an explicitly supplied relative `FONTCONFIG_FILE` alike — is
 * searched through each colon-separated `FONTCONFIG_PATH` component in order and
 * then `/etc/fonts`, with the first existing file winning. This is fontconfig's
 * own search-list semantics: the path is a list of directories, not one
 * directory whose name happens to contain colons.
 *
 * When no candidate exists the last one is returned, so the caller reads a path
 * that does not exist and discovers nothing. An explicitly configured search
 * list is not an invitation to borrow the default tree.
 *
 * Exported so the font-config test can lock the order of the candidates, not
 * only the files that happen to be found at the end.
 */
export function resolveFontConfigMaster(
  name: string,
  configuredPath: string | undefined,
): { readonly master: string; readonly tried: readonly string[] } {
  if (isAbsolute(name)) {
    const absolute = resolve(name);
    return { master: absolute, tried: [absolute] };
  }
  const roots = (configuredPath ?? '').split(':').filter((component) => component !== '');
  roots.push('/etc/fonts');
  const tried: string[] = [];
  for (const root of roots) {
    const candidate = join(root, name);
    tried.push(candidate);
    try {
      if (statSync(candidate).isFile()) return { master: candidate, tried };
    } catch {
      // Not in this component; try the next one.
    }
  }
  return { master: tried[tried.length - 1]!, tried };
}

/** The host's font directories and the config includes followed to find them. */
function fontDirectories(): {
  readonly directories: string[];
  readonly rules: readonly FontRule[];
  readonly includes: number;
  readonly includeDirectories: number;
  readonly skippedIncludes: number;
} {
  const state: FontConfigState = {
    directories: [],
    visited: new Set(),
    followedDirectories: new Set(),
    rules: [],
    includes: 0,
    includeDirectories: 0,
    skippedIncludes: 0,
  };
  if (process.platform === 'linux') {
    // Read exactly the master configuration fontconfig reads. FONTCONFIG_FILE
    // names it directly; otherwise the implicit `fonts.conf` is searched through
    // FONTCONFIG_PATH (default /etc/fonts). Both use the same resolution routine,
    // so a colon-separated path is a search list for either spelling. A custom
    // master is followed as written, including its `<include>` and `<dir>` chain;
    // a missing candidate contributes no fonts rather than borrowing the default
    // tree.
    const configuredFile = process.env['FONTCONFIG_FILE'];
    const configuredPath = process.env['FONTCONFIG_PATH'];
    const customMaster = configuredFile !== undefined && configuredFile !== '';
    const { master } = resolveFontConfigMaster(customMaster ? configuredFile : 'fonts.conf', configuredPath);
    // /etc/fonts/conf.d is part of the *default* configuration, not of every
    // configuration: the stock fonts.conf includes it as a directory, and the
    // legacy loop keeps a host whose default fonts.conf omits that include
    // working. The default is identified by the master it resolved to, so
    // FONTCONFIG_PATH=/absent:/etc/fonts is the same configuration as no path at
    // all, while a master found elsewhere never gains /etc/fonts/conf.d.
    const defaultConfig = !customMaster && master === resolve('/etc/fonts/fonts.conf');
    parseFontConfig(master, 0, state);
    if (defaultConfig) {
      const confDirectory = resolve('/etc/fonts/conf.d');
      if (!state.followedDirectories.has(confDirectory)) {
        try {
          for (const name of readdirSync(confDirectory).sort()) {
            if (/^[0-9].*\.conf$/i.test(name)) {
              if (!parseFontConfig(join(confDirectory, name), 0, state)) state.skippedIncludes += 1;
            }
          }
        } catch {
          // No conf.d is ordinary; the base file and the per-user directories remain.
        }
      }
    }
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
    rules: state.rules,
    includes: state.includes,
    includeDirectories: state.includeDirectories,
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

/** Expand a fontconfig glob's home or relative spelling to a complete path. */
function globPath(pattern: string): string {
  if (pattern === '~') return homedir();
  if (pattern.startsWith('~/')) return join(homedir(), pattern.slice(2));
  return resolve(pattern);
}

/** Fontconfig `<glob>` semantics: a shell pattern over the complete file path. */
function globMatchesFile(pattern: string, file: string): boolean {
  return globMatches(globPath(pattern), resolve(file));
}

/** Fontconfig's glob subset: `*`, `?`, and every other character literally. */
function globMatches(pattern: string, value: string): boolean {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  source += '$';
  try {
    return new RegExp(source, 'u').test(value);
  } catch {
    return false;
  }
}

/** Decode a UTF-16BE name-table string without allocating a swapped copy. */
function decodeUtf16Be(bytes: Buffer): string {
  let text = '';
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    text += String.fromCharCode(bytes.readUInt16BE(index));
  }
  return text;
}

/** Family names (IDs 1 and 16) from one sfnt `name` table. */
function familiesOfNameTable(table: Buffer): string[] {
  if (table.length < 6) return [];
  const count = table.readUInt16BE(2);
  const stringOffset = table.readUInt16BE(4);
  const families: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 12;
    if (at + 12 > table.length) break;
    const platform = table.readUInt16BE(at);
    const encoding = table.readUInt16BE(at + 2);
    const nameId = table.readUInt16BE(at + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = table.readUInt16BE(at + 8);
    const offset = table.readUInt16BE(at + 10);
    const start = stringOffset + offset;
    if (start + length > table.length) continue;
    const raw = table.subarray(start, start + length);
    let family: string | undefined;
    if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) {
      family = decodeUtf16Be(raw);
    } else if (platform === 1 && encoding === 0) {
      family = raw.toString('latin1');
    }
    const trimmed = family?.replace(/\0/g, '').trim();
    if (trimmed !== undefined && trimmed !== '') families.push(trimmed);
  }
  return [...new Set(families)];
}

/** Read the family names of every face in one font file. */
function familiesOfFile(file: string): readonly string[] {
  let fd: number;
  let size: number;
  try {
    fd = openSync(file, 'r');
    size = statSync(file).size;
  } catch {
    return [];
  }
  try {
    let header = readSlice(fd, 0, 12);
    if (header === undefined) return [];
    if (header.toString('latin1', 0, 4) === 'ttcf') {
      const count = Math.min(header.readUInt32BE(8), MAX_COLLECTION_FACES);
      const extended = readSlice(fd, 0, 12 + count * 4);
      if (extended !== undefined) header = extended;
    }
    const families: string[] = [];
    for (const base of faceDirectories(header)) {
      const directory = readSlice(fd, base, 12);
      if (directory === undefined || directory.length < 12) continue;
      const tables = Math.min(directory.readUInt16BE(4), MAX_TABLES);
      const records = readSlice(fd, base + 12, tables * 16);
      if (records === undefined) continue;
      for (let index = 0; index < tables; index += 1) {
        const at = index * 16;
        if (at + 16 > records.length) break;
        if (records.toString('latin1', at, at + 4) !== 'name') continue;
        const offset = records.readUInt32BE(at + 8);
        const length = records.readUInt32BE(at + 12);
        if (offset + length > size) break;
        const table = readSlice(fd, offset, Math.min(length, MAX_CMAP_BYTES));
        if (table !== undefined) families.push(...familiesOfNameTable(table));
        break;
      }
    }
    return [...new Set(families)];
  } finally {
    closeSync(fd);
  }
}

/**
 * Filter the discovered files through fontconfig's `<rejectfont>` and
 * `<acceptfont>` rules. Rules are applied in configuration order and the last
 * matching rule wins, so a later accept re-admits a glob rejected earlier. A
 * `<glob>` matches the file's basename; a `<pattern>` is matched against family
 * names parsed from the font's `name` table (IDs 1 and 16).
 */
function applyFontRules(files: readonly string[], rules: readonly FontRule[]): string[] {
  // An accept rule of either kind can only protect a font from a reject rule;
  // with no reject rule it cannot remove anything, and evaluating it would read
  // every name table for no change.
  if (!rules.some((rule) => rule.action === 'reject')) return [...files];
  const families = new Map<string, readonly string[]>();
  const matchesPattern = (file: string, rule: FontRule): boolean => {
    if (rule.family === undefined) return false;
    let names = families.get(file);
    if (names === undefined) {
      names = familiesOfFile(file);
      families.set(file, names);
    }
    const expected = rule.family.toLowerCase();
    return names.some((name) => name.toLowerCase() === expected);
  };

  const acceptGlobs = rules.filter((rule) => rule.action === 'accept' && rule.glob !== undefined);
  const rejectGlobs = rules.filter((rule) => rule.action === 'reject' && rule.glob !== undefined);
  const acceptPatterns = rules.filter((rule) => rule.action === 'accept' && rule.family !== undefined);
  const rejectPatterns = rules.filter((rule) => rule.action === 'reject' && rule.family !== undefined);
  const filenameAccepted = (path: string): boolean => {
    if (acceptGlobs.some((rule) => globMatchesFile(rule.glob!, path))) return true;
    return !rejectGlobs.some((rule) => globMatchesFile(rule.glob!, path));
  };
  const directoryRejected = (file: string): boolean => {
    let directory = dirname(resolve(file));
    const ancestors: string[] = [];
    while (directory !== dirname(directory)) {
      ancestors.unshift(directory);
      directory = dirname(directory);
    }
    return ancestors.some((ancestor) => !filenameAccepted(ancestor));
  };

  return files.filter((file) => {
    // fontconfig applies filename selectors to each scanned directory before it
    // considers the font file, then to the file; a rejected directory is never
    // searched, so no file accept can rescue a font inside it.
    if (directoryRejected(file)) return false;
    if (!filenameAccepted(file)) return false;
    // Pattern selectors run after the filename selectors, with the accept set
    // checked first. They cannot override a filename reject.
    if (acceptPatterns.some((rule) => matchesPattern(file, rule))) return true;
    return !rejectPatterns.some((rule) => matchesPattern(file, rule));
  });
}

/** One discovery walk per process: a build cannot change the host font set. */
let discoveryCache: FontDiscovery | undefined;

/** The font files this host would offer fontconfig, deterministically ordered. */
export function discoverFonts(): FontDiscovery {
  if (discoveryCache !== undefined) return discoveryCache;
  const { directories, rules, includes, includeDirectories, skippedIncludes } = fontDirectories();
  const files: string[] = [];
  for (const directory of directories) fontFilesUnder(directory, 0, files);
  files.sort();
  const offered = applyFontRules(files, rules);
  return (discoveryCache = {
    directories,
    files: offered,
    includes,
    includeDirectories,
    skippedIncludes,
  });
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
