/**
 * The single producer-owned media decision: which bytes a referenced image
 * publishes, and under what public URL.
 *
 * Goal 0009's contract in one sentence: **an image is published because a
 * published note references it, at a URL its content digest names, as the exact
 * bytes the author wrote.** Everything in this module serves that sentence and
 * nothing else is allowed to decide any of it.
 *
 * ## What is deliberately *not* here
 *
 * - **No transcoding, resizing, or metadata rewriting.** The bytes copied are
 *   the bytes on disk. A photograph keeps its EXIF and GPS tags, because
 *   removing them is a metadata-sanitization policy this phase does not claim
 *   and a future one must state separately. Do not describe 0009 as scrubbing
 *   metadata; it does not.
 * - **No SVG.** An SVG can carry a script, and rasterization is Goal 0012's.
 *   `looksLikeSvg` exists only to give that refusal a diagnostic an author can
 *   act on, never to publish one.
 * - **No optimizer, no encoder, no dependency.** There is no image codec in
 *   this build; format detection reads signature bytes.
 *
 * ## Public identity is the digest, and the name is decoration
 *
 * The public path is `/_assets/<sha256>-<name>`, where `<name>` is the source
 * basename with a canonical extension. Two source files with identical bytes
 * therefore publish **one** asset (the digest collides and the first name in
 * deterministic order wins), and unchanged bytes republish the same URL on every
 * build. What a consumer may rely on is the digest prefix; the name after it
 * exists so a reader who saves an image gets a filename that says something, and
 * so an author grepping their own built site can find the picture they wrote.
 *
 * The name is percent-encoded and bounded before it enters a URL, because it is
 * the one part of the path the author controls and a Markdown destination, an
 * HTML attribute, a URL path segment, and a static host's file lookup do not all
 * agree about spaces, `(`, `#`, or non-ASCII.
 *
 * ## One resolver, two tiers, no basename fallback
 *
 * {@link resolveImageTarget} resolves an image reference **relative to the
 * writing note, then relative to the content root**, and it stops there. It
 * deliberately does *not* reproduce `resolveLink`'s five tiers: a note link
 * resolves against every file's basename because Obsidian does, and the same
 * behaviour applied to an image would turn `![draft](chart.png)` written beside
 * `chart.png` into the `chart.png` in some unrelated directory the moment the
 * note-relative file was renamed. A broken image is a build failure, so the
 * resolver must be able to say "nothing named that" rather than resolve to the
 * nearest plausible file.
 */

/** A raster format this build publishes unchanged. */
export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif';

interface ImageFormatInfo {
  /** Canonical extension, including the dot. Also what a static host maps to `mime`. */
  readonly extension: string;
  readonly mime: string;
}

/**
 * The formats, and the extension each one publishes under.
 *
 * The extension is **derived from the detected bytes rather than from the source
 * filename**, because a static host decides `Content-Type` from the extension.
 * `photo.jpeg` and `photo.jpg` are the same format and both publish as `.jpg`;
 * a PNG misnamed `diagram.jpg` publishes as `.png` rather than being served as
 * `image/jpeg` by every host that trusts the extension. The bytes are never
 * touched — only the name of the file they land in.
 */
const IMAGE_FORMATS: Readonly<Record<ImageFormat, ImageFormatInfo>> = {
  png: { extension: '.png', mime: 'image/png' },
  jpeg: { extension: '.jpg', mime: 'image/jpeg' },
  gif: { extension: '.gif', mime: 'image/gif' },
  webp: { extension: '.webp', mime: 'image/webp' },
  avif: { extension: '.avif', mime: 'image/avif' },
};

/** The extension a format publishes under, dot included. */
export function imageExtension(format: ImageFormat): string {
  return IMAGE_FORMATS[format].extension;
}

/** The MIME type a format publishes as. */
export function imageMimeType(format: ImageFormat): string {
  return IMAGE_FORMATS[format].mime;
}

/** The format a canonical published extension names, or `undefined`. */
export function formatForExtension(extension: string): ImageFormat | undefined {
  const wanted = extension.toLowerCase();
  for (const [format, info] of Object.entries(IMAGE_FORMATS)) {
    if (info.extension === wanted) return format as ImageFormat;
  }
  return undefined;
}

/** The public directory every emitted image lands in. */
export const ASSET_DIRECTORY = '_assets';

/** Prefix of every published asset URL. */
export const ASSET_URL_PREFIX = `/${ASSET_DIRECTORY}/`;

/**
 * Longest name suffix an emitted asset may carry, in UTF-8 bytes.
 *
 * A published filename is `<64 hex>-<name>`, so 65 bytes plus this must stay
 * under the 255-byte name limit every common filesystem enforces, including
 * with room for the host's own temporary suffixes. The name is decoration —
 * truncating it changes nothing a digest-keyed identity depends on — so cutting
 * it is always safe and refusing an image because its author wrote a long name
 * would not be.
 */
export const ASSET_NAME_MAX_BYTES = 120;

/** A digest as this module and `schema.ts` both spell it. */
export const ASSET_DIGEST = /^[0-9a-f]{64}$/;

/** The parser for a published asset URL. See {@link parseAssetUrl}. */
const ASSET_URL = /^\/_assets\/([0-9a-f]{64})-(.+)$/;

/** Anything a URL parser would treat as an absolute scheme. */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Cut a string to a UTF-8 byte budget without splitting a character.
 *
 * Code points rather than UTF-16 units, for the reason the task-list label bound
 * gives: `slice` on a surrogate pair leaves half a character, which a reader and
 * a filesystem both see as a replacement glyph. A code point that does not fit is
 * dropped whole, so the result is always a prefix of the input in bytes.
 */
function truncateBytes(text: string, budget: number): string {
  let used = 0;
  let result = '';
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > budget) break;
    used += size;
    result += character;
  }
  return result;
}

/**
 * The name part of a published asset, from a source basename.
 *
 * Deterministic, bounded, and safe in a URL path segment and on disk:
 *
 * - control and format characters are removed (a filename may legally contain a
 *   newline or a bidi override, and neither belongs in a public path);
 * - `/` and `\` become `_`, so the name can never introduce a path segment;
 * - a stem that is empty, or only dots, becomes `image`;
 * - the source's own extension is replaced by the format's canonical one;
 * - the stem is truncated to {@link ASSET_NAME_MAX_BYTES}.
 */
export function assetFileName(sourceName: string, format: ImageFormat): string {
  const extension = imageExtension(format);
  const dot = sourceName.lastIndexOf('.');
  const rawStem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  const cleaned = rawStem
    .replace(/[\p{Cc}\p{Cf}]+/gu, '')
    .replace(/[\\/]+/gu, '_')
    .trim();
  const stem = cleaned === '' || /^\.+$/.test(cleaned) ? 'image' : cleaned;
  const budget = Math.max(1, ASSET_NAME_MAX_BYTES - byteLength(extension));
  return `${truncateBytes(stem, budget)}${extension}`;
}

/**
 * Percent-encode one asset name for a URL path segment.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped, and all four are hostile in at
 * least one of the contexts this string lands in: `(` and `)` close a Markdown
 * destination early, `'` is an attribute delimiter a host may quote with, and
 * `*` is a glob metacharacter for anything that matches published paths. So those
 * are escaped too, and what remains is unreserved characters and `%XX` only —
 * which is why {@link parseAssetUrl} can reject every alternative spelling.
 */
function encodeAssetName(name: string): string {
  return encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Whether a decoded name is one this build could have emitted.
 *
 * The extension must be the **canonical** one, not merely a supported format:
 * `.jpeg` and `.PNG` are real spellings of real formats, and accepting them would
 * give one asset several URLs. The parser rejects every non-canonical spelling,
 * so "the file this URL names" has exactly one answer.
 */
function isAssetFileName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (/[\\/]/.test(name) || /[\p{Cc}\p{Cf}]/u.test(name)) return false;
  if (byteLength(name) > ASSET_NAME_MAX_BYTES) return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  const format = formatForExtension(name.slice(dot));
  return format !== undefined && imageExtension(format) === name.slice(dot);
}

/**
 * The public URL for one asset: its digest, then its name.
 *
 * Throws on a digest that is not the shape this module and `schema.ts` agree
 * on, because a caller passing anything else is a producer defect rather than a
 * user's mistake, and a malformed identity is the one thing a content-addressed
 * URL cannot tolerate.
 */
export function assetUrlFor(digest: string, fileName: string): string {
  if (!ASSET_DIGEST.test(digest)) {
    throw new Error(`an asset digest must be 64 lowercase hex characters, got ${JSON.stringify(digest)}`);
  }
  if (!isAssetFileName(fileName)) {
    throw new Error(`not a publishable asset name: ${JSON.stringify(fileName)}`);
  }
  return `${ASSET_URL_PREFIX}${digest}-${encodeAssetName(fileName)}`;
}

/**
 * The digest and on-disk name a published asset URL names, or `undefined`.
 *
 * Canonical form only: the name must re-encode to exactly the bytes in the URL,
 * so `%41` is not an acceptable spelling of `A` and one asset cannot be reached
 * through two paths. This is what lets the copy step and the output inventory
 * treat "the file named by this URL" as a single, unambiguous question.
 */
export function parseAssetUrl(url: string): { digest: string; fileName: string } | undefined {
  const match = ASSET_URL.exec(url);
  if (match === null) return undefined;
  const encoded = match[2]!;
  let fileName: string;
  try {
    fileName = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (!isAssetFileName(fileName) || encodeAssetName(fileName) !== encoded) return undefined;
  return { digest: match[1]!, fileName };
}

/** Whether a URL names the asset namespace at all, valid or not. */
export function isAssetUrl(url: string): boolean {
  return url.startsWith(ASSET_URL_PREFIX);
}

/* ------------------------------------------------------------------------- *
 * Raw image sources
 * ------------------------------------------------------------------------- */

/** The schemes the producer must report instead of leaving to the sanitizer. */
const REFUSED_IMAGE_SCHEMES: Readonly<Record<string, true>> = {
  file: true,
  javascript: true,
  vbscript: true,
};

/** What a raw `<img src>` is, as one answer for both the producer and renderer. */
export type ImageSourceClass = 'remote' | 'refused' | 'local';

/**
 * Classify one raw-HTML `<img src>`: remote, refused, or local.
 *
 * **One classifier, two callers.** `scripts/resolve-links.ts` uses it to decide
 * whether a raw `<img>` is an `html-form` failure, and `src/lib/markdown.ts`
 * uses it to decide whether the renderer may skip the published-asset check.
 * Before this function the producer tested the raw bytes while the renderer
 * stripped whitespace first, so `<img src=" https://example.test/pic.png">`
 * failed the build but rendered unchanged: one URL, two answers.
 *
 * The rule is the renderer's (and `sanitize-html`'s `launder`): remove **every**
 * character at or below U+0020, then a URL is **remote** when it begins with an
 * RFC 3986 scheme or with a protocol-relative `//` (or the `\\` spelling the
 * renderer already accepts). Within that set, `file:`, `javascript:` and
 * `vbscript:` are **refused** rather than remote: the producer must report them
 * as the local/script forms Goal 0009 names, while the renderer still treats
 * them as non-local, so the sanitizer keeps deciding their fate and removes the
 * attribute exactly as before. Everything else — a bare relative path, an
 * all-whitespace value, the empty string — is **local**.
 *
 * The refused set is a deny list rather than an allow list. Other schemes
 * (`ftp:`, `mailto:`) were accepted by the producer before this function and
 * are still accepted here; the renderer's scheme policy already removes them
 * from the page, and turning that into a new build failure would widen this
 * fix past the local/script forms the goal names.
 */
export function classifyImageSource(source: string): ImageSourceClass {
  // The value `sanitize-html`'s `launder` reads: every character at or below
  // U+0020 removed. A filter rather than a control-character range in a regex
  // keeps the raw control classes banned by lint out of this file.
  const cleaned = Array.from(source, (character) => (character <= ' ' ? '' : character)).join('');
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(cleaned)?.[1]?.toLowerCase();
  const remote = scheme !== undefined || /^[/\\]{2}/.test(cleaned);
  if (!remote) return 'local';
  if (scheme !== undefined && REFUSED_IMAGE_SCHEMES[scheme] === true) return 'refused';
  return 'remote';
}

/* ------------------------------------------------------------------------- *
 * Format detection
 * ------------------------------------------------------------------------- */

function matchesAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * The raster format the bytes actually are, or `undefined`.
 *
 * Signature bytes, not the extension. Goal 0009 must serve the *intended* content
 * type, and every static host infers that from the extension, so a file whose
 * name disagrees with its bytes has to be identified by the bytes to publish
 * under an extension that is true. It is also what makes the SVG refusal total:
 * an SVG named `diagram.png` is not a PNG.
 *
 * The signatures are the formats' own, and the function is deliberately not a
 * validator — a truncated PNG is detected as PNG here. Nothing in this phase
 * decodes the image (there is no codec), and the goal is passthrough, so the only
 * question asked is "which type is this to serve as".
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && matchesAt(bytes, 1, 'PNG')) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (matchesAt(bytes, 0, 'GIF87a') || matchesAt(bytes, 0, 'GIF89a')) return 'gif';
  if (matchesAt(bytes, 0, 'RIFF') && matchesAt(bytes, 8, 'WEBP')) return 'webp';

  // AVIF is ISO BMFF: a `ftyp` box whose major or compatible brand is `avif` or
  // `avis`. Some encoders write `mif1` as the major brand and `avif` among the
  // compatible ones, so the brand list is scanned rather than only offset 8.
  if (bytes.length >= 16 && matchesAt(bytes, 4, 'ftyp')) {
    const size = u32be(bytes, 0);
    if (size >= 16 && size <= 256 && size <= bytes.length) {
      for (let offset = 8; offset + 4 <= size; offset += 4) {
        if (matchesAt(bytes, offset, 'avif') || matchesAt(bytes, offset, 'avis')) return 'avif';
      }
    }
  }

  return undefined;
}

/**
 * Whether the bytes begin an SVG document.
 *
 * Only ever consulted *after* {@link sniffImageFormat} declined, to turn "not a
 * supported raster" into the diagnostic an author needs: SVG is a real image
 * format that this phase refuses on purpose, and "unsupported type" alone would
 * read like a bug. It is not a parser and must not become one — Goal 0012's
 * static-subset analysis is the parser, and it ships with the rasterizer.
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = Array.from(bytes.subarray(0, 1024), (byte) => String.fromCharCode(byte)).join('');
  return /^(?:\uFEFF)?\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(
    head,
  );
}

/* ------------------------------------------------------------------------- *
 * Intrinsic dimensions
 * ------------------------------------------------------------------------- */

/** The pixel size a raster's own header declares. */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/**
 * Whether a value is a positive whole pixel count.
 *
 * Shared by the header readers here and the artifact-contract check in
 * `schema.ts`, so “a usable dimension” has one definition rather than two
 * spellings that can drift.
 */
export function isPositiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function positive(width: number, height: number): ImageDimensions | undefined {
  return isPositiveDimension(width) && isPositiveDimension(height) ? { width, height } : undefined;
}

/** A TIFF/EXIF orientation value, or why it could not be trusted. */
type ExifOrientation = number | 'malformed' | undefined;

function tiffU16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian ? u16le(bytes, offset) : u16be(bytes, offset);
}

function tiffU32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian ? u32le(bytes, offset) : u32be(bytes, offset);
}

/**
 * The IFD0 `Orientation` tag from one TIFF/EXIF payload, or `undefined` when the
 * payload has no such tag.
 *
 * A present-but-unreadable tag, a malformed TIFF header, or an IFD that runs out
 * of bounds returns `'malformed'`: the orientation is then unknown, and the
 * caller must emit no dimensions rather than a pair that describes the coded
 * pixels instead of the displayed ones. Only a value of 1 is safe to pass
 * through; every other EXIF value transforms the displayed image.
 */
function exifOrientation(bytes: Uint8Array, start: number, end: number): ExifOrientation {
  if (start + 8 > end) return 'malformed';
  const littleEndian = matchesAt(bytes, start, 'II');
  if (!littleEndian && !matchesAt(bytes, start, 'MM')) return 'malformed';
  if (tiffU16(bytes, start + 2, littleEndian) !== 42) return 'malformed';
  const ifdOffset = tiffU32(bytes, start + 4, littleEndian);
  if (ifdOffset < 8 || start + ifdOffset + 2 > end) return 'malformed';
  const entryCount = tiffU16(bytes, start + ifdOffset, littleEndian);
  const entriesStart = start + ifdOffset + 2;
  if (entriesStart + entryCount * 12 > end) return 'malformed';
  for (let index = 0; index < entryCount; index += 1) {
    const entry = entriesStart + index * 12;
    if (tiffU16(bytes, entry, littleEndian) !== 0x0112) continue;
    const type = tiffU16(bytes, entry + 2, littleEndian);
    const count = tiffU32(bytes, entry + 4, littleEndian);
    if (type !== 3 || count !== 1) return 'malformed';
    return tiffU16(bytes, entry + 8, littleEndian);
  }
  return undefined;
}

/**
 * PNG: signature, then a 13-byte `IHDR` chunk whose width and height are
 * big-endian.
 *
 * Chunks are also walked for `eXIf` so a stored EXIF orientation can veto the
 * pair. An orientation other than 1 means the browser will display the image
 * rotated or mirrored relative to the IHDR pixels, and omitting the attributes
 * is the only honest fail-open answer.
 */
function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  // Signature, the IHDR length/type word pair, the 13 data bytes, and its CRC.
  // Stopping at the height would read a chunk the file never finished writing.
  if (bytes.length < 33 || !matchesAt(bytes, 12, 'IHDR')) return undefined;
  if (u32be(bytes, 8) !== 13) return undefined;
  const dimensions = positive(u32be(bytes, 16), u32be(bytes, 20));
  if (dimensions === undefined) return undefined;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = u32be(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) {
      // A truncated metadata chunk is unreadable; a truncated file with no
      // eXIf encountered keeps its IHDR pair, exactly as Goal 0009 publishes it.
      return type === 'eXIf' ? undefined : dimensions;
    }
    if (type === 'eXIf') {
      const tiffStart = matchesAt(bytes, dataStart, 'Exif\0\0') ? dataStart + 6 : dataStart;
      const orientation = exifOrientation(bytes, tiffStart, dataEnd);
      if (orientation === 'malformed' || (orientation !== undefined && orientation !== 1)) return undefined;
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  return dimensions;
}

/**
 * JPEG: walk marker segments through the frame header and any EXIF APP1, then
 * stop at the start of scan.
 *
 * The frame header is a length-prefixed segment; its payload is precision,
 * height, width. Markers with no length are skipped. A frame header after SOS is
 * entropy-coded data, not a header, so SOS ends the walk. An EXIF `Orientation`
 * other than 1 makes the coded frame disagree with the displayed image, so the
 * caller gets no attributes rather than a transposed pair.
 */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  let dimensions: ImageDimensions | undefined;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) return undefined;
    // TEM and the restart markers carry no length; skip them without reading one.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // The entropy-coded scan begins here. Stop before reading the SOS length.
    if (marker === 0xda) return dimensions;
    if (offset + 2 > bytes.length) return undefined;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    const payloadStart = offset + 2;
    const payloadEnd = offset + length;
    if (marker === 0xe1 && payloadStart + 6 <= payloadEnd && matchesAt(bytes, payloadStart, 'Exif\0\0')) {
      const orientation = exifOrientation(bytes, payloadStart + 6, payloadEnd);
      if (orientation === 'malformed' || (orientation !== undefined && orientation !== 1)) return undefined;
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame && dimensions === undefined) {
      if (length < 7) return undefined;
      const precision = bytes[offset + 2]!;
      const height = u16be(bytes, offset + 3);
      const width = u16be(bytes, offset + 5);
      if (precision === 0) return undefined;
      dimensions = positive(width, height);
      if (dimensions === undefined) return undefined;
    }
    offset += length;
  }
  return dimensions;
}

/** GIF: the logical screen descriptor, little-endian, immediately after the header. */
function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined;
  return positive(u16le(bytes, 6), u16le(bytes, 8));
}

/**
 * WebP: RIFF chunks name the bitstream and any EXIF metadata.
 *
 * `VP8X` carries the canvas size as 24-bit minus-one fields; `VP8L` packs both
 * minus-one dimensions into 32 bits; `VP8 ` is a lossy keyframe whose 3-byte
 * frame tag, 3-byte start code, and 2+2 dimension fields follow the chunk
 * header. An `EXIF` chunk with an orientation other than 1 vetoes the pair.
 */
function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 20) return undefined;
  let offset = 12;
  let dimensions: ImageDimensions | undefined;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const size = u32le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) return undefined;
    if (type === 'EXIF') {
      const tiffStart = matchesAt(bytes, dataStart, 'Exif\0\0') ? dataStart + 6 : dataStart;
      const orientation = exifOrientation(bytes, tiffStart, dataEnd);
      if (orientation === 'malformed' || (orientation !== undefined && orientation !== 1)) return undefined;
    } else if (dimensions === undefined && type === 'VP8X') {
      // Flags, three reserved bytes, then two 24-bit minus-one canvas fields.
      if (size < 10) return undefined;
      dimensions = positive(u24le(bytes, dataStart + 4) + 1, u24le(bytes, dataStart + 7) + 1);
      if (dimensions === undefined) return undefined;
    } else if (dimensions === undefined && type === 'VP8L') {
      // Signature byte, then both minus-one dimensions packed into 32 bits.
      if (size < 5 || bytes[dataStart] !== 0x2f) return undefined;
      const packed = u32le(bytes, dataStart + 1);
      dimensions = positive((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
      if (dimensions === undefined) return undefined;
    } else if (dimensions === undefined && type === 'VP8 ') {
      // Three-byte frame tag, three-byte keyframe start code, then 2+2 dimensions.
      if (size < 10 || !matchesAt(bytes, dataStart + 3, '\x9d\x01\x2a')) return undefined;
      dimensions = positive(u16le(bytes, dataStart + 6) & 0x3fff, u16le(bytes, dataStart + 8) & 0x3fff);
      if (dimensions === undefined) return undefined;
    }
    offset = dataEnd + (size & 1);
  }
  return dimensions;
}

/**
 * AVIF: the `ispe` property box inside `meta/iprp/ipco`.
 *
 * ISO BMFF boxes are sized and typed, so this walks the box tree rather than
 * searching for the four bytes `ispe` — a marker in a payload is not a box
 * boundary. Only the containers that can hold the image-spatial-extents
 * property are descended into, each bounded by its own declared size, so a
 * truncated or hostile header yields no answer rather than an unchecked read.
 *
 * An `irot` or `imir` property transforms the item after `ispe`; this reader
 * does not apply those transforms, so their presence vetoes the pair and the
 * image fails open to no `width`/`height`.
 */
function avifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  let dimensions: ImageDimensions | undefined;
  let transformed = false;
  let malformed = false;

  const scan = (start: number, end: number, depth: number): void => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = u32be(bytes, offset);
      const type = String.fromCharCode(
        bytes[offset + 4]!,
        bytes[offset + 5]!,
        bytes[offset + 6]!,
        bytes[offset + 7]!,
      );
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) {
          malformed = true;
          return;
        }
        const high = u32be(bytes, offset + 8);
        const low = u32be(bytes, offset + 12);
        size = high * 2 ** 32 + low;
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || !Number.isSafeInteger(size) || offset + size > end) {
        malformed = true;
        return;
      }
      if (type === 'irot' || type === 'imir') {
        transformed = true;
      } else if (type === 'ispe') {
        if (size >= header + 12 && dimensions === undefined) {
          dimensions = positive(
            u32be(bytes, offset + header + 4),
            u32be(bytes, offset + header + 8),
          );
        }
      } else if (depth < 4 && (type === 'meta' || type === 'iprp' || type === 'ipco')) {
        // `meta` is a full box: its version/flags word follows the header.
        const childStart = offset + header + (type === 'meta' ? 4 : 0);
        if (childStart < offset + size) scan(childStart, offset + size, depth + 1);
        if (malformed) return;
      }
      offset += size;
    }
  };

  scan(0, bytes.length, 0);
  if (malformed || transformed) return undefined;
  return dimensions;
}

/**
 * The intrinsic pixel dimensions a supported raster's header declares.
 *
 * This is header reading, not decoding: it runs on the bytes Goal 0009 already
 * authorized and publishes, so a layout attribute never becomes a reason to
 * fetch a remote URL, load a third-party decoder, or read past the file. A
 * malformed, truncated, or internally inconsistent header returns `undefined`
 * and the image still publishes; the page then omits `width`/`height` rather
 * than guessing, which is the only safe direction for a fallible hint.
 *
 * `format` is the answer {@link sniffImageFormat} already gave for these exact
 * bytes. The type cannot enforce that pairing, so the caller is trusted to pass
 * the format it just sniffed; this function does not sniff again.
 */
export function imageDimensions(bytes: Uint8Array, format: ImageFormat): ImageDimensions | undefined {
  switch (format) {
    case 'png':
      return pngDimensions(bytes);
    case 'jpeg':
      return jpegDimensions(bytes);
    case 'gif':
      return gifDimensions(bytes);
    case 'webp':
      return webpDimensions(bytes);
    case 'avif':
      return avifDimensions(bytes);
  }
}

/* ------------------------------------------------------------------------- *
 * Resolution
 * ------------------------------------------------------------------------- */

/**
 * What one authored image reference names.
 *
 * The members discriminate on what a producer must do with the node, which is the
 * only question the traversal asks:
 *
 * - `external` — a remote URL, a `data:` URI, or a same-page fragment. Left
 *   byte-for-byte; this build never fetches it and never mirrors it.
 * - `local` — an exact content-root-relative path the walk found. Whether the
 *   build *may* publish it is a separate authorization question; see the
 *   publisher in `scripts/markdown-to-artifact.ts`.
 * - `outside` — the reference climbs above the content root (`../..`), so no
 *   file inside the authorized tree is named.
 * - `missing` — nothing by that name inside the content root.
 */
export type ImageTarget =
  | { readonly kind: 'external' }
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'outside' }
  | { readonly kind: 'missing' };

/** POSIX dirname on a corpus-relative path; `''` at the root. */
function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * Join a relative reference onto a directory, or `undefined` if it escapes.
 *
 * Written out rather than delegated to `path.posix.join`, for the reason
 * `link-resolution.ts` gives: every path here is already a `/`-joined relative
 * path, and `join`'s platform behaviour is a second variable this does not want.
 * A `..` that climbs above the root is not silently dropped — that is the whole
 * difference between a path that is missing and one that points outside the tree
 * the author authorized, and the two have different fixes.
 */
function joinRelative(directory: string, reference: string): string | undefined {
  const parts = directory === '' ? [] : directory.split('/');
  for (const segment of reference.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? undefined : parts.join('/');
}

/**
 * Percent-decode the path half of one Markdown image destination, exactly once.
 *
 * `decodeURIComponent` rather than `decodeURI`, because this decodes a *filename*
 * after the fragment has already been split off: `%23`, `%26`, `%3F` and `%25`
 * are the only spellings a file whose name carries `#`, `&`, `?` or `%` can be
 * referenced by, and `decodeURI` deliberately leaves all four encoded — which
 * asked the filesystem for the escape text and made such an image unresolvable.
 * `link-resolution.ts` still uses `decodeURI` because a link decodes before it
 * splits at `#`; here the split has already happened, so a decoded `#` is a
 * filename byte rather than a fragment.
 *
 * **One pass, never two.** `%2523` decodes to the literal three characters
 * `%23`, which is how a file *named* `chart%23one.png` is addressed. So
 * `chart%23one.png` wins for the file named `chart#one.png`, and
 * `chart%2523one.png` wins for the file named `chart%23one.png`; both may exist
 * in one corpus, and each spelling resolves to exactly one of them.
 *
 * A decoded `/` is refused rather than treated as a separator: `%2F` is a byte
 * inside one segment, `/` is the separator {@link joinRelative} owns, and a
 * reference must not be able to name a path its author did not write. A
 * malformed escape is left as written, matching the link resolver: a literal `%`
 * in a filename is legal, and a typo then resolves to nothing instead of
 * crashing the build.
 *
 * @returns the decoded path, or `undefined` when a segment decodes to contain a
 *   separator and therefore names no single file.
 */
function decodeReferencePath(path: string): string | undefined {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment;
    }
    if (decoded.includes('/')) return undefined;
    segments.push(decoded);
  }
  return segments.join('/');
}

/**
 * Resolve one image reference against the writing note and the content root.
 *
 * Two tiers, in this order and no third:
 *
 * 1. **Note-relative.** `../img/a.png` from `notes/today.md` is
 *    `img/a.png`. An explicitly relative reference (`./` or `../`) stops here
 *    whether or not it resolved: falling through would let a reference the author
 *    anchored to their own directory silently name a different file at the
 *    content root.
 * 2. **Content-root-relative.** A bare or multi-segment reference (`a.png`,
 *    `img/a.png`) that missed the note's directory is looked up at the root, which
 *    is what makes `![chart](charts/q3.png)` work from a note in a subdirectory.
 *
 * A reference beginning `/` is an explicit content-root anchor and takes tier 2
 * only, mirroring the note resolver's treatment of a leading slash as a strict
 * root test rather than a fuzzy one.
 *
 * `locate` answers "which file on disk does this name?" and returns its actual
 * spelling, or `undefined` when nothing inside the authorized tree has that name.
 * The traversal passes the set of paths the walk found, so "inside the content
 * root" is not a filesystem question asked here but a fact the caller already
 * established — which is what keeps a symlink outside the tree, a directory
 * symlink, and a structurally ignored name from ever being *found*. The candidate
 * it receives is NFC-normalised, and it is expected to compare normalised too:
 * a macOS filesystem stores names decomposed while an author types them composed,
 * so a byte-exact comparison answers differently on two machines for the same two
 * strings. The answer is the on-disk spelling, because that is what a later read
 * needs.
 */
export function resolveImageTarget(
  reference: string,
  notePath: string,
  locate: (path: string) => string | undefined,
  isWikilink: boolean,
): ImageTarget {
  const written = reference.trim();
  if (written === '') return { kind: 'missing' };

  // A fragment on an image URL selects nothing this build serves; the path before
  // it is the reference. The cut happens on the **authored** spelling, before any
  // decoding, because the two characters must stay distinguishable: a literal `#`
  // ends the path, while `%23` is a filename byte that only becomes `#` below.
  // A bare fragment points inside the page, which is likewise not an image file.
  const cut = written.indexOf('#');
  const authored = cut === -1 ? written : written.slice(0, cut);
  if (authored === '') return { kind: 'external' };

  // A scheme or a protocol-relative host is not a file this build owns.
  if (HAS_SCHEME.test(authored) || authored.startsWith('//')) return { kind: 'external' };

  // A wikilink target is an Obsidian path, not a URL, so it is used exactly as
  // written — the same asymmetry the resolver always had. A Markdown destination
  // is percent-decoded once; see {@link decodeReferencePath}.
  const path = isWikilink ? authored : decodeReferencePath(authored);
  if (path === undefined) return { kind: 'missing' };

  const located = (candidate: string): ImageTarget => {
    const found = locate(candidate.normalize('NFC'));
    return found === undefined ? { kind: 'missing' } : { kind: 'local', path: found };
  };

  if (path.startsWith('/')) {
    const root = joinRelative('', path.replace(/^\/+/, ''));
    return root === undefined ? { kind: 'outside' } : located(root);
  }

  const explicit = path.startsWith('./') || path.startsWith('../');
  const joined = joinRelative(dirname(notePath), path);
  if (joined !== undefined) {
    const near = located(joined);
    if (near.kind === 'local') return near;
  }
  if (explicit) {
    // Climbing above the root is a different fault from naming nothing: the
    // first points at a file the author did not authorize, the second at a file
    // that is not there.
    return joined === undefined ? { kind: 'outside' } : { kind: 'missing' };
  }

  const root = joinRelative('', path);
  return root === undefined ? { kind: 'outside' } : located(root);
}

/**
 * Why an image reference could not be published.
 *
 * A closed set of stable identifiers, never prose, for the reason every other
 * closed set in this build gives: it is counted on the public stream, sorted in
 * the private report, and switched on by the tests. Renaming a member is a
 * breaking change to both surfaces.
 *
 * - `missing` — nothing by that name inside the content root.
 * - `outside` — the reference (or the symlink it names) leaves the authorized
 *   tree, so its bytes were never read.
 * - `excluded` — a real file the author's own exclusion rules withhold.
 * - `svg` — an SVG, which this phase refuses rather than shipping active content.
 * - `unsupported` — a file whose bytes are not PNG/JPEG/GIF/WebP/AVIF.
 * - `html-form` — an `<img>` written as raw HTML, which the accepted resolver
 *   does not cover.
 */
export type MediaFailureReason = 'missing' | 'outside' | 'excluded' | 'svg' | 'unsupported' | 'html-form';

/** What publishing one local reference produced. */
export type ImageOutcome =
  | { readonly kind: 'external' }
  | { readonly kind: 'published'; readonly url: string }
  | { readonly kind: 'failed'; readonly reason: MediaFailureReason };

/**
 * The traversal's view of the asset pipeline, injected.
 *
 * `resolveLinksIn` owns *where* an image reference sits in a note; the publisher
 * owns *which bytes* it publishes and under what URL. Keeping the split means
 * the traversal stays a pure Markdown rewrite a test can drive without a
 * filesystem, while the one function that reads bytes lives with the producer
 * that owns the publication boundary.
 */
export interface ImagePublisher {
  publish(request: {
    readonly notePath: string;
    readonly target: string;
    readonly isWikilink: boolean;
  }): ImageOutcome;
}
