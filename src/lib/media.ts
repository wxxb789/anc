/**
 * The single producer-owned media decision: which bytes a referenced image
 * publishes, and under what public URL.
 *
 * Goal 0009's contract in one sentence: **an image is published because a
 * published note references it, at a URL its content digest names, as the exact
 * bytes the author wrote.** Goal 0011 keeps that authorization and identity
 * boundary but changes which bytes are emitted for an ordinary JPEG or 8-bit
 * PNG: a smaller WebP candidate may replace them. Everything in this module
 * serves the publication decision and nothing else is allowed to make it.
 *
 * ## What is deliberately *not* here
 *
 * - **No author-facing resize, crop, or metadata scrub.** The encoder may
 *   remove metadata only on a transcode, where orientation is applied first.
 *   Passthrough originals keep their EXIF and GPS tags. Do not describe
 *   passthrough as scrubbing metadata; it is not.
 * - **SVG is a source, never an output.** Goal 0012 accepts a static,
 *   self-contained SVG as build-only input: `svg-policy.ts` decides whether it is
 *   in the subset and `svg-render.ts` turns it into lossless WebP. The XML never
 *   reaches a public file. `looksLikeSvg` is the cheap signature that selects
 *   that path; it is not the policy.
 * - **One encoder decision.** `media-codec.ts` owns the WebP policy; this module
 *   owns format identity, structural completeness, dimensions, resolution and
 *   URL naming.
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

import type { SvgRefusalReason } from './svg-refusal.ts';

/** A raster format this build can publish. */
export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif';

interface ImageFormatInfo {
  /** Canonical extension, including the dot. Also what a static host maps to `mime`. */
  readonly extension: string;
  readonly mime: string;
}

/**
 * The formats, and the extension each one publishes under.
 *
 * The extension is **derived from the emitted bytes rather than from the source
 * filename**, because a static host decides `Content-Type` from the extension.
 * `photo.jpeg` and `photo.jpg` are the same format and both publish as `.jpg`;
 * a PNG misnamed `diagram.jpg` publishes as `.webp` when the policy keeps its
 * candidate, or `.png` when it is retained. A static host never serves
 * `image/jpeg` for bytes that are not JPEG.
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
 * validator — a truncated PNG is detected as PNG here. Structural completeness
 * is a separate gate, {@link assertCompleteContainer}, which runs before the
 * decoder can turn a partial container into pixels.
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
 * Whether the first 1024 bytes contain an SVG root element.
 *
 * Consulted *after* {@link sniffImageFormat} declined, to select Goal 0012's SVG
 * path rather than "unsupported type". Like the raster sniffers this is a
 * signature test, not a validator: it looks for `<svg>` (optionally namespaced) at
 * any position in the bounded head, so an XML declaration, comments, a DOCTYPE, or
 * processing instructions in the prologue still reach the policy and are refused
 * there with their own diagnostics instead of being misreported as a plain text
 * file. A UTF-16 document does not match this byte signature and is reported as an
 * unsupported file. It must not grow into a parser — the policy module owns that.
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 1024));
  return /<(?:[A-Za-z_][\w.-]*:)?svg(?=[\s/>])/i.test(head);
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

/** One PNG chunk's type and data bounds, from the chunk's length word. */
interface PngChunk {
  readonly type: string;
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly next: number;
}

/** The chunk at one offset, or `undefined` when its length/type header is absent. */
function pngChunkAt(bytes: Uint8Array, offset: number): PngChunk | undefined {
  if (offset + 8 > bytes.length) return undefined;
  const length = u32be(bytes, offset);
  const type = String.fromCharCode(
    bytes[offset + 4]!,
    bytes[offset + 5]!,
    bytes[offset + 6]!,
    bytes[offset + 7]!,
  );
  const dataStart = offset + 8;
  const dataEnd = dataStart + length;
  return { type, dataStart, dataEnd, next: dataEnd + 4 };
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
    const chunk = pngChunkAt(bytes, offset);
    if (chunk === undefined) break;
    if (chunk.dataEnd > bytes.length) {
      // A truncated metadata chunk is unreadable; a truncated file with no
      // eXIf encountered keeps its IHDR pair, exactly as Goal 0009 publishes it.
      return chunk.type === 'eXIf' ? undefined : dimensions;
    }
    if (chunk.type === 'eXIf') {
      const tiffStart = matchesAt(bytes, chunk.dataStart, 'Exif\0\0') ? chunk.dataStart + 6 : chunk.dataStart;
      const orientation = exifOrientation(bytes, tiffStart, chunk.dataEnd);
      if (orientation === 'malformed' || (orientation !== undefined && orientation !== 1)) return undefined;
    }
    if (chunk.type === 'IEND') break;
    offset = chunk.next;
  }
  return dimensions;
}

/**
 * Whether PNG bytes carry an `acTL` chunk, which makes them an animated PNG.
 *
 * Sharp's metadata does not report an APNG frame count (measured: `pages` is
 * absent for a PNG whose `acTL` chunk precedes `IDAT`), so a publisher that
 * inferred animation from `pages` would transcode the first frame and silently
 * drop the animation. The walk is structural — lengths and type names at the
 * same chunk boundaries {@link pngDimensions} uses — not a search for the four
 * bytes inside compressed image data.
 */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || bytes[0] !== 0x89 || !matchesAt(bytes, 1, 'PNG')) return false;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const chunk = pngChunkAt(bytes, offset);
    if (chunk === undefined || chunk.dataEnd > bytes.length) return false;
    if (chunk.type === 'acTL') return true;
    // `acTL` must precede the first image data; stopping here also bounds the
    // walk on a malformed length that would otherwise step past the buffer.
    if (chunk.type === 'IDAT' || chunk.type === 'IEND') return false;
    offset = chunk.next;
  }
  return false;
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
 * AVIF: the `ispe` property associated with the primary item.
 *
 * ISO BMFF boxes are sized and typed, so this walks the box tree rather than
 * searching for the four bytes `ispe` — a marker in a payload is not a box
 * boundary. The `ipco` container is a list of properties, not an item's
 * description: its first `ispe` may belong to a thumbnail or an unused item.
 * The only size this reader may report is the one `ipma` associates with the
 * item `pitm` names.
 *
 * The association table is deliberately resolved rather than approximated. No
 * `pitm`, more than one primary, no `ipma`, a duplicate primary row, a property
 * index outside `ipco`, or an association with no `ispe` all yield no answer.
 * That is the fail-open direction: a valid correlation is required before the
 * page reserves space; an unresolved header publishes with no `width`/`height`.
 *
 * An `irot` or `imir` property associated with the primary item transforms it
 * after `ispe`; this reader does not apply those transforms, so their presence
 * vetoes the pair. Properties associated with other items do not.
 */
interface IsoBox {
  readonly type: string;
  readonly payload: number;
  readonly end: number;
}

/** One ISO BMFF box at `offset`, bounded by `end`. */
function isoBoxAt(bytes: Uint8Array, offset: number, end: number): IsoBox | undefined {
  if (offset + 8 > end) return undefined;
  let size = u32be(bytes, offset);
  const type = String.fromCharCode(
    bytes[offset + 4]!,
    bytes[offset + 5]!,
    bytes[offset + 6]!,
    bytes[offset + 7]!,
  );
  let header = 8;
  if (size === 1) {
    if (offset + 16 > end) return undefined;
    const high = u32be(bytes, offset + 8);
    const low = u32be(bytes, offset + 12);
    size = high * 2 ** 32 + low;
    header = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < header || !Number.isSafeInteger(size) || offset + size > end) {
    return undefined;
  }
  return { type, payload: offset + header, end: offset + size };
}

/** Every sibling box from `start` to `end`; `undefined` if one overruns. */
function isoBoxes(bytes: Uint8Array, start: number, end: number): IsoBox[] | undefined {
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset < end) {
    const box = isoBoxAt(bytes, offset, end);
    if (box === undefined) return undefined;
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

function avifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const top = isoBoxes(bytes, 0, bytes.length);
  if (top === undefined) return undefined;
  const metaBoxes = top.filter((box) => box.type === 'meta');
  if (metaBoxes.length !== 1) return undefined;
  const meta = metaBoxes[0]!;
  // `meta` is a full box. Its version and reserved flags describe the box
  // layout, so an unknown version is not a container this reader can trust.
  if (meta.payload + 4 > meta.end || bytes[meta.payload] !== 0) return undefined;
  if (bytes[meta.payload + 1] !== 0 || bytes[meta.payload + 2] !== 0 || bytes[meta.payload + 3] !== 0) {
    return undefined;
  }
  const metaChildren = isoBoxes(bytes, meta.payload + 4, meta.end);
  if (metaChildren === undefined) return undefined;

  const pitms = metaChildren.filter((box) => box.type === 'pitm');
  if (pitms.length !== 1) return undefined;
  const pitm = pitms[0]!;
  if (pitm.payload + 4 > pitm.end) return undefined;
  if (bytes[pitm.payload + 1] !== 0 || bytes[pitm.payload + 2] !== 0 || bytes[pitm.payload + 3] !== 0) {
    return undefined;
  }
  const pitmVersion = bytes[pitm.payload]!;
  let primaryItem: number;
  if (pitmVersion === 0) {
    if (pitm.payload + 6 !== pitm.end) return undefined;
    primaryItem = u16be(bytes, pitm.payload + 4);
  } else if (pitmVersion === 1) {
    if (pitm.payload + 8 !== pitm.end) return undefined;
    primaryItem = u32be(bytes, pitm.payload + 4);
  } else {
    return undefined;
  }
  if (primaryItem === 0) return undefined;

  const iprps = metaChildren.filter((box) => box.type === 'iprp');
  if (iprps.length !== 1) return undefined;
  const iprp = iprps[0]!;
  const iprpChildren = isoBoxes(bytes, iprp.payload, iprp.end);
  if (iprpChildren === undefined) return undefined;

  const ipcos = iprpChildren.filter((box) => box.type === 'ipco');
  const ipmas = iprpChildren.filter((box) => box.type === 'ipma');
  if (ipcos.length !== 1 || ipmas.length !== 1) return undefined;
  const ipco = ipcos[0]!;
  const ipma = ipmas[0]!;
  const properties = isoBoxes(bytes, ipco.payload, ipco.end);
  if (properties === undefined) return undefined;

  if (ipma.payload + 4 > ipma.end) return undefined;
  const ipmaVersion = bytes[ipma.payload]!;
  const ipmaFlags =
    (bytes[ipma.payload + 1]! << 16) |
    (bytes[ipma.payload + 2]! << 8) |
    bytes[ipma.payload + 3]!;
  // Version selects the item-ID width; bit 0 selects the 15-bit property-index
  // field. No other flag or version has a layout this reader knows.
  if (ipmaVersion > 1 || (ipmaFlags & ~1) !== 0) return undefined;
  let offset = ipma.payload + 4;
  if (offset + 4 > ipma.end) return undefined;
  const entryCount = u32be(bytes, offset);
  offset += 4;
  const itemIdWidth = ipmaVersion === 0 ? 2 : 4;
  const associationWidth = (ipmaFlags & 1) === 0 ? 1 : 2;
  let primaryAssociations: number[] | undefined;
  let primarySeen = false;
  const indices: number[] = [];

  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + itemIdWidth > ipma.end) return undefined;
    const itemId = itemIdWidth === 2 ? u16be(bytes, offset) : u32be(bytes, offset);
    offset += itemIdWidth;
    if (offset + 1 > ipma.end) return undefined;
    const associationCount = bytes[offset]!;
    offset += 1;
    if (offset + associationCount * associationWidth > ipma.end) return undefined;

    const associations: number[] = [];
    for (let association = 0; association < associationCount; association += 1) {
      const raw =
        associationWidth === 2 ? u16be(bytes, offset) : bytes[offset]!;
      offset += associationWidth;
      // The high bit is the essential flag; the rest is the 1-based property
      // index. Index 0 means "no property" and is skipped when resolving.
      const index = associationWidth === 2 ? raw & 0x7fff : raw & 0x7f;
      associations.push(index);
      indices.push(index);
    }

    if (itemId === primaryItem) {
      if (primarySeen) return undefined;
      primarySeen = true;
      primaryAssociations = associations;
    }
  }

  if (offset !== ipma.end || primaryAssociations === undefined) return undefined;
  if (indices.some((index) => index > properties.length)) return undefined;

  let ispe: IsoBox | undefined;
  let transformed = false;
  for (const index of primaryAssociations) {
    if (index === 0) continue;
    const property = properties[index - 1]!;
    if (property.type === 'irot' || property.type === 'imir') {
      transformed = true;
    } else if (property.type === 'ispe') {
      if (ispe !== undefined) return undefined;
      ispe = property;
    }
  }

  if (transformed || ispe === undefined) return undefined;
  if (ispe.payload + 12 > ispe.end || bytes[ispe.payload] !== 0) return undefined;
  return positive(
    u32be(bytes, ispe.payload + 4),
    u32be(bytes, ispe.payload + 8),
  );
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

/**
 * Whether an 8-bit PNG's colour model is one WebP lossless carries faithfully.
 *
 * WebP lossless is an 8-bit format. A 16-bit PNG — or any depth other than 8 —
 * would be reduced by the encoder, changing visible values, so the policy
 * publishes those bytes unchanged. The palette and grayscale colour types are
 * still 8-bit samples; converting them to RGB8 preserves every displayed value.
 */
export function pngCanUseLosslessWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 26 || bytes[0] !== 0x89 || !matchesAt(bytes, 1, 'PNG')) return false;
  if (u32be(bytes, 8) !== 13 || !matchesAt(bytes, 12, 'IHDR')) return false;
  if (bytes[24] !== 8) return false;
  return [0, 2, 3, 4, 6].includes(bytes[25]!);
}

/**
 * What a completeness gate knows after its caller read the container header.
 *
 * GIF is the one format whose structural walk can be cross-checked against a
 * decoded count: libvips reports how many image descriptors it saw, and a
 * truncated animation reports fewer than the file's trailer promises. Other
 * formats are structurally self-describing and need no expectation.
 */
export interface ContainerExpectation {
  /** The page count the decoder reported; required for GIF's count check. */
  readonly pages?: number;
}

/** The CRC-32 table PNG chunks use, built once. */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 over `[start, end)`, as PNG computes it over chunk type and data. */
function crc32Of(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function failIncomplete(what: string): never {
  throw new Error(`incomplete ${what} container`);
}

/**
 * PNG: every chunk fits, each CRC-32 matches, and a zero-length `IEND` is the
 * final chunk with no trailing bytes.
 *
 * This is what makes a truncated PNG a build failure rather than a plausible
 * decode. Measured, libvips decodes a 96×96 PNG with its final 20 bytes missing
 * and reports success; the chunk walk sees a short stream before libvips is
 * asked. APNG still passes this walk: `fdAT` frames are chunks like any other,
 * and their animation semantics remain 0011's disclosed limit.
 */
function pngComplete(bytes: Uint8Array): void {
  if (bytes.length < 8 || bytes[0] !== 0x89 || !matchesAt(bytes, 1, 'PNG')) failIncomplete('PNG');
  let offset = 8;
  let first = true;
  while (offset < bytes.length) {
    const chunk = pngChunkAt(bytes, offset);
    if (chunk === undefined || chunk.dataEnd > bytes.length || chunk.next > bytes.length) {
      failIncomplete('PNG chunk');
    }
    if (first && (chunk.type !== 'IHDR' || chunk.dataEnd - chunk.dataStart !== 13)) {
      failIncomplete('PNG header');
    }
    first = false;
    if (crc32Of(bytes, offset + 4, chunk.dataEnd) !== u32be(bytes, chunk.dataEnd)) {
      failIncomplete('PNG chunk CRC');
    }
    if (chunk.type === 'IEND') {
      if (chunk.dataEnd !== chunk.dataStart) failIncomplete('PNG IEND');
      if (chunk.next !== bytes.length) failIncomplete('PNG trailing');
      return;
    }
    offset = chunk.next;
  }
  failIncomplete('PNG without IEND');
}

/**
 * GIF: walk the block stream to the trailer and count image descriptors.
 *
 * A truncated GIF often keeps a decodable prefix; libvips then reports fewer
 * pages and `raw()` agrees, so neither is evidence of completeness. The walk
 * refuses a block that does not fit, a missing trailer, a trailer followed by a
 * non-zero byte, and — when the caller supplies the decoder's page count — a
 * descriptor count that disagrees with it.
 */
function gifComplete(bytes: Uint8Array, expectedPages: number | undefined): void {
  if (bytes.length < 13) failIncomplete('GIF header');
  if (!matchesAt(bytes, 0, 'GIF87a') && !matchesAt(bytes, 0, 'GIF89a')) failIncomplete('GIF signature');
  const packed = bytes[10]!;
  let offset = 13;
  if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1));
  if (offset > bytes.length) failIncomplete('GIF colour table');

  let descriptors = 0;
  while (offset < bytes.length) {
    const block = bytes[offset++]!;
    if (block === 0x3b) {
      for (let index = offset; index < bytes.length; index += 1) {
        if (bytes[index] !== 0) failIncomplete('GIF after trailer');
      }
      if (descriptors === 0) failIncomplete('GIF without image');
      if (expectedPages !== undefined && descriptors !== expectedPages) {
        failIncomplete('GIF frame stream');
      }
      return;
    }
    if (block === 0x00) continue;
    if (block === 0x21) {
      if (offset >= bytes.length) failIncomplete('GIF extension');
      offset += 1; // extension label
      while (true) {
        if (offset >= bytes.length) failIncomplete('GIF extension data');
        const length = bytes[offset++]!;
        if (length === 0) break;
        if (offset + length > bytes.length) failIncomplete('GIF extension data');
        offset += length;
      }
      continue;
    }
    if (block !== 0x2c) failIncomplete('GIF block');
    if (offset + 9 > bytes.length) failIncomplete('GIF image descriptor');
    const localPacked = bytes[offset + 8]!;
    offset += 9;
    if ((localPacked & 0x80) !== 0) offset += 3 * (1 << ((localPacked & 0x07) + 1));
    if (offset > bytes.length) failIncomplete('GIF local colour table');
    if (offset >= bytes.length) failIncomplete('GIF image data');
    offset += 1; // LZW minimum code size
    while (true) {
      if (offset >= bytes.length) failIncomplete('GIF image data');
      const length = bytes[offset++]!;
      if (length === 0) break;
      if (offset + length > bytes.length) failIncomplete('GIF image data');
      offset += length;
    }
    descriptors += 1;
  }
  failIncomplete('GIF without trailer');
}

/**
 * JPEG: walk every marker segment and require `EOI` exactly at the end.
 *
 * The scan's entropy-coded bytes are walked with stuffing and restart markers
 * understood, so a `0xFFD9` inside compressed data is not a false end marker.
 * A file missing its final two bytes fails here even when libvips decodes it.
 */
function jpegComplete(bytes: Uint8Array): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) failIncomplete('JPEG header');
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) failIncomplete('JPEG marker');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) failIncomplete('JPEG marker');
    const marker = bytes[offset++]!;
    if (marker === 0xd9) {
      if (offset !== bytes.length) failIncomplete('JPEG trailing');
      return;
    }
    if (marker === 0x00 || marker === 0xd8) failIncomplete('JPEG marker');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) failIncomplete('JPEG segment');
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) failIncomplete('JPEG segment');
    if (marker === 0xda) {
      offset += length;
      let nextSegment = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let after = offset + 1;
        while (after < bytes.length && bytes[after] === 0xff) after += 1;
        if (after >= bytes.length) failIncomplete('JPEG scan');
        const next = bytes[after]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset = after + 1;
          continue;
        }
        if (next === 0xd9) {
          if (after + 1 !== bytes.length) failIncomplete('JPEG trailing');
          return;
        }
        // Resume at the marker's 0xFF prefix, not at the code byte `after`.
        // The outer loop's invariant is `bytes[offset] === 0xff`; progressive
        // JPEGs have several scans, so another DHT/SOS segment follows here.
        offset = after - 1;
        nextSegment = true;
        break;
      }
      if (!nextSegment) failIncomplete('JPEG without EOI');
      continue;
    }
    offset += length;
  }
  failIncomplete('JPEG without EOI');
}

/**
 * WebP: RIFF's size is the whole file less 8 bytes, every chunk fits with its
 * pad byte, and at least one bitstream chunk is present.
 */
function webpComplete(bytes: Uint8Array): void {
  if (bytes.length < 12 || !matchesAt(bytes, 0, 'RIFF') || !matchesAt(bytes, 8, 'WEBP')) {
    failIncomplete('WebP header');
  }
  if (u32le(bytes, 4) + 8 !== bytes.length) failIncomplete('WebP RIFF size');
  let offset = 12;
  let image = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) failIncomplete('WebP chunk');
    const type = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const size = u32le(bytes, offset + 4);
    const dataEnd = offset + 8 + size;
    const next = dataEnd + (size & 1);
    if (dataEnd > bytes.length || next > bytes.length) failIncomplete('WebP chunk');
    if (type === 'VP8 ' || type === 'VP8L' || type === 'VP8X') image = true;
    offset = next;
  }
  if (offset !== bytes.length || !image) failIncomplete('WebP image chunk');
}

/** The primary item ID `pitm` names, or `undefined` when the box is unusable. */
function avifPrimaryItem(bytes: Uint8Array, meta: IsoBox): number | undefined {
  const children = isoBoxes(bytes, meta.payload + 4, meta.end);
  if (children === undefined) return undefined;
  const pitms = children.filter((box) => box.type === 'pitm');
  if (pitms.length !== 1) return undefined;
  const pitm = pitms[0]!;
  if (pitm.payload + 4 > pitm.end) return undefined;
  if (bytes[pitm.payload + 1] !== 0 || bytes[pitm.payload + 2] !== 0 || bytes[pitm.payload + 3] !== 0) {
    return undefined;
  }
  const version = bytes[pitm.payload]!;
  if (version === 0) {
    if (pitm.payload + 6 !== pitm.end) return undefined;
    return u16be(bytes, pitm.payload + 4);
  }
  if (version === 1) {
    if (pitm.payload + 8 !== pitm.end) return undefined;
    return u32be(bytes, pitm.payload + 4);
  }
  return undefined;
}

interface AvifExtent {
  readonly method: number;
  readonly offset: number;
  readonly length: number;
}

/**
 * The primary item's `iloc` extents, with absolute file offsets.
 *
 * `iloc` versions 0-2 share a layout except for item-ID width and the optional
 * construction method. Sizes are read as unsigned big-endian fields of the
 * widths the box declares; an absent field (size 0) contributes zero.
 * Construction method 0 addresses the file directly; method 1 addresses the
 * payload of `meta/idat`. An item naming a non-zero data reference points at
 * data outside this file and is not addressable by this gate.
 */
function avifPrimaryExtents(bytes: Uint8Array, meta: IsoBox, primary: number): AvifExtent[] | undefined {
  const children = isoBoxes(bytes, meta.payload + 4, meta.end);
  if (children === undefined) return undefined;
  const ilocs = children.filter((box) => box.type === 'iloc');
  if (ilocs.length !== 1) return undefined;
  const iloc = ilocs[0]!;
  if (iloc.payload + 6 > iloc.end) return undefined;
  const version = bytes[iloc.payload]!;
  if (version > 2) return undefined;
  const offsetSize = bytes[iloc.payload + 4]! >>> 4;
  const lengthSize = bytes[iloc.payload + 4]! & 0x0f;
  const baseSize = bytes[iloc.payload + 5]! >>> 4;
  const indexSize = version === 0 ? 0 : bytes[iloc.payload + 5]! & 0x0f;
  if (offsetSize > 8 || lengthSize > 8 || baseSize > 8 || indexSize > 8) return undefined;

  let cursor = iloc.payload + 6;
  const take = (width: number): number | undefined => {
    if (width === 0) return 0;
    if (cursor + width > iloc.end) return undefined;
    let value = 0;
    for (let index = 0; index < width; index += 1) value = value * 256 + bytes[cursor++]!;
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const countWidth = version === 2 ? 4 : 2;
  if (cursor + countWidth > iloc.end) return undefined;
  const itemCount = countWidth === 2 ? u16be(bytes, cursor) : u32be(bytes, cursor);
  cursor += countWidth;
  const itemIdWidth = version === 2 ? 4 : 2;
  const found: AvifExtent[] = [];

  for (let item = 0; item < itemCount; item += 1) {
    if (cursor + itemIdWidth > iloc.end) return undefined;
    const itemId = itemIdWidth === 2 ? u16be(bytes, cursor) : u32be(bytes, cursor);
    cursor += itemIdWidth;
    let method = 0;
    if (version !== 0) {
      if (cursor + 2 > iloc.end) return undefined;
      method = u16be(bytes, cursor) & 0x0f;
      cursor += 2;
    }
    if (cursor + 2 > iloc.end) return undefined;
    const dataReferenceIndex = u16be(bytes, cursor);
    cursor += 2;
    if (itemId === primary && dataReferenceIndex !== 0) return undefined;
    const base = take(baseSize);
    if (base === undefined || cursor + 2 > iloc.end) return undefined;
    const extentCount = u16be(bytes, cursor);
    cursor += 2;
    // Every item's extents are walked even when it is not the primary one:
    // stopping early would leave the cursor inside this item's record and make
    // a valid multi-item `iloc` look truncated.
    for (let extent = 0; extent < extentCount; extent += 1) {
      if (version !== 0 && indexSize > 0) {
        if (cursor + indexSize > iloc.end) return undefined;
        cursor += indexSize;
      }
      const relative = take(offsetSize);
      const length = take(lengthSize);
      if (relative === undefined || length === undefined) return undefined;
      if (!Number.isSafeInteger(base + relative)) return undefined;
      if (itemId === primary) found.push({ method, offset: base + relative, length });
    }
  }
  if (cursor !== iloc.end) return undefined;
  return found;
}

/**
 * AVIF: top-level boxes consume the file exactly, and each primary-item extent
 * lies inside a container that its construction method names: a top-level
 * `mdat` for method 0, or `meta/idat`'s payload for method 1. A file with
 * neither container is incomplete; an extent may not span two containers.
 */
function avifComplete(bytes: Uint8Array): void {
  const top = isoBoxes(bytes, 0, bytes.length);
  if (top === undefined) failIncomplete('AVIF box stream');
  const metas = top.filter((box) => box.type === 'meta');
  if (metas.length !== 1) failIncomplete('AVIF meta box');
  const meta = metas[0]!;
  if (meta.payload + 4 > meta.end || bytes[meta.payload] !== 0) failIncomplete('AVIF meta header');
  if (bytes[meta.payload + 1] !== 0 || bytes[meta.payload + 2] !== 0 || bytes[meta.payload + 3] !== 0) {
    failIncomplete('AVIF meta header');
  }
  const primary = avifPrimaryItem(bytes, meta);
  if (primary === undefined || primary === 0) failIncomplete('AVIF primary item');
  const mdats = top.filter((box) => box.type === 'mdat');
  const metaChildren = isoBoxes(bytes, meta.payload + 4, meta.end);
  if (metaChildren === undefined) failIncomplete('AVIF meta children');
  const idats = metaChildren.filter((box) => box.type === 'idat');
  const extents = avifPrimaryExtents(bytes, meta, primary);
  if (extents === undefined || extents.length === 0) failIncomplete('AVIF item location');
  for (const extent of extents) {
    if (extent.method !== 0 && extent.method !== 1) failIncomplete('AVIF item location method');
    // Method 0 offsets are file-relative; method 1 offsets are relative to the
    // idat payload the spec names. Both must end inside that same container;
    // an extent never spans two.
    const inside =
      extent.method === 0
        ? mdats.some(
            (mdat) =>
              extent.offset >= mdat.payload &&
              extent.offset + extent.length <= mdat.end &&
              Number.isSafeInteger(extent.offset + extent.length),
          )
        : idats.some((idat) => {
            const start = idat.payload + extent.offset;
            return (
              start >= idat.payload &&
              start + extent.length <= idat.end &&
              Number.isSafeInteger(start + extent.length)
            );
          });
    if (!inside) failIncomplete(extent.method === 0 ? 'AVIF mdat' : 'AVIF idat');
  }
}

/**
 * Refuse a structurally incomplete image container before a pixel decoder or
 * encoder sees it.
 *
 * This is the gate that separates "the header parsed" from "the file is
 * complete". Each format's own self-description is walked: PNG chunks and their
 * CRCs, the GIF block stream and its descriptor count, JPEG markers through EOI,
 * WebP's RIFF size and chunks, and AVIF's box tree with the primary item's
 * `mdat` or `meta/idat` extent. A failure is the existing `corrupt` reason; no
 * caller may publish the bytes anyway.
 *
 * An unreadable *dimension* header is still a different case: a complete
 * container whose header this module cannot interpret publishes without
 * `width`/`height` and does not fail the build. The distinction is between a
 * missing hint and missing bytes.
 */
export function assertCompleteContainer(
  format: ImageFormat,
  bytes: Uint8Array,
  expectation: ContainerExpectation = {},
): void {
  switch (format) {
    case 'png':
      pngComplete(bytes);
      return;
    case 'jpeg':
      jpegComplete(bytes);
      return;
    case 'gif':
      gifComplete(bytes, expectation.pages);
      return;
    case 'webp':
      webpComplete(bytes);
      return;
    case 'avif':
      avifComplete(bytes);
      return;
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
 * - `unsupported` — a file whose bytes are not PNG/JPEG/GIF/WebP/AVIF or an SVG.
 * - `html-form` — an `<img>` written as raw HTML, which the accepted resolver
 *   does not cover.
 * - `corrupt` — bytes of a supported format that the decoder could not read.
 * - `too-large` — the source exceeds the encoder's finite byte or decoded-pixel
 *   budget. Goal 0011's bound, stated rather than discovered as an OOM.
 * - `timeout` — a decode or encode exceeded its deadline.
 * - `encode-failed` — the encoder returned bytes this build cannot publish and
 *   cannot explain by the input alone. Never a silent fallback to the source.
 * - the `svg-*` members — Goal 0012's static-subset refusals, defined in
 *   `svg-refusal.ts`. Each names a distinct construct an author can fix.
 */
export type MediaProcessingFailureReason =
  | 'corrupt'
  | 'too-large'
  | 'timeout'
  | 'encode-failed'
  | SvgRefusalReason;

export type MediaFailureReason =
  | 'missing'
  | 'outside'
  | 'excluded'
  | 'unsupported'
  | 'html-form'
  | MediaProcessingFailureReason;

/** What publishing one local reference produced. */
export type ImageOutcome =
  | { readonly kind: 'external' }
  | { readonly kind: 'published'; readonly url: string }
  | {
      readonly kind: 'failed';
      readonly reason: MediaFailureReason;
      /**
       * The private, actionable half of the reason.
       *
       * It is read from the source file (an element name, an attribute, a code
       * point), so it belongs in the private report for the same reason a
       * withheld path does. The public stream carries only the counted label.
       */
      readonly detail?: string;
    };

/**
 * The traversal's view of the asset pipeline, injected.
 *
 * `resolveLinksIn` owns *where* an image reference sits in a note; the publisher
 * owns *which bytes* it publishes and under what URL. Keeping the split means
 * the traversal stays a Markdown rewrite a test can drive without a filesystem,
 * while the one function that reads bytes lives with the producer that owns the
 * publication boundary.
 *
 * `publish` is asynchronous because Goal 0011's encoder is: producing a WebP
 * candidate cannot be done synchronously, and blocking the traversal on a
 * second thread would replace one clear await with a deadlock risk.
 */
export interface ImagePublisher {
  publish(request: {
    readonly notePath: string;
    readonly target: string;
    readonly isWikilink: boolean;
  }): Promise<ImageOutcome>;
}
