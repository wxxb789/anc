/**
 * Goal 0011: the WebP-preferred policy, one row at a time, over real bytes.
 *
 * The producer test next door proves the publication boundary and identity; this
 * file proves the encoder's own decisions. Every source here is a real encoded
 * image — committed fixtures for the stable cases, and sharp-generated JPEG/PNG
 * only where a fixture with the needed property (a candidate that loses, a
 * multi-frame animation, a decompression bomb) would be opaque bytes nobody
 * could edit.
 *
 * The controls matter as much as the acceptances. A policy row that keeps a
 * larger candidate, drops alpha, transposes an oriented photo, strips a colour
 * profile without converting it, or publishes bytes it could not decode is a
 * regression this file must fail on.
 */

import { crc32 } from 'node:zlib';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import sharp from 'sharp';

import {
  assertCompleteContainer,
  imageExtension,
  imageMimeType,
  pngCanUseLosslessWebp,
  sniffImageFormat,
} from '../src/lib/media.ts';
import {
  ENCODER_SETTINGS,
  MEDIA_LIMITS,
  WEBP_MAX_DIMENSION,
  prepareImage,
  type MediaLimits,
  type PreparedImage,
} from '../src/lib/media-codec.ts';
import {
  AVIF,
  AVIF_PRIMARY_IN_IDAT,
  AVIF_PRIMARY_IN_IDAT_DATA_REFERENCE,
  AVIF_PRIMARY_IN_IDAT_METHOD_2,
  AVIF_PRIMARY_IN_IDAT_NO_CONTAINER,
  AVIF_PRIMARY_IN_IDAT_OVERRUN,
  GIF_ANIMATED,
  JPEG,
  ORIENTED_JPEG,
  ORIENTED_PNG,
  ORIENTED_WEBP,
  PNG_SCREENSHOT,
  PNG_TRANSPARENT,
  PNG_UNICODE,
  WEBP_ANIMATED,
  WEBP_LOSSLESS,
  WEBP_LOSSY,
  progressiveJpeg,
} from './support/media.ts';

/** A small deterministic PRNG, so a generated fixture is the same bytes each run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

/** Raw RGB noise: a real image whose compressed bytes cannot be predicted. */
function noiseRgb(width: number, height: number, seed: number): Buffer {
  const random = seeded(seed);
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index++) raw[index] = Math.floor(random() * 256);
  return raw;
}

/** Encode raw RGB as a JPEG at a chosen quality, the way an author's export would. */
async function jpegFrom(raw: Buffer, width: number, height: number, quality: number): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality, chromaSubsampling: '4:2:0' })
    .toBuffer();
}

/** A pseudo-photograph: smooth structure plus grain, so q80 WebP has something to preserve. */
async function photograph(width = 640, height = 480): Promise<Buffer> {
  const random = seeded(0x5eed);
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      const u = x / width;
      const v = y / height;
      const structure = Math.sin(u * 12.5) * 0.12 + Math.cos(v * 9.3) * 0.1 + Math.sin((u + v) * 7) * 0.07;
      const grain = (random() - 0.5) * 0.06;
      const pixel = (value: number): number => Math.max(0, Math.min(255, Math.round(255 * value)));
      raw[index] = pixel(0.55 + 0.35 * v + structure + grain);
      raw[index + 1] = pixel(0.45 + 0.3 * (1 - v) + structure * 0.6 + grain);
      raw[index + 2] = pixel(0.3 + 0.4 * u + structure * 0.4 + grain);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** A deterministic tall image, for WebP's dimension boundary and above it. */
async function tallSource(width: number, height: number, format: 'jpeg' | 'png'): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      raw[index] = (x * 3 + y * 7) & 0xff;
      raw[index + 1] = (x * 11 + y * 5) & 0xff;
      raw[index + 2] = (x * 7 + y * 13) & 0xff;
    }
  }
  const source = sharp(raw, { raw: { width, height, channels: 3 } });
  return format === 'jpeg'
    ? source.jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
    : source.png().toBuffer();
}

/** Decode both images to their displayed RGBA pixels, applying EXIF orientation. */
async function displayedRgba(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).autoOrient().ensureAlpha().raw().toBuffer();
}

/**
 * Whether two RGBA buffers display identically.
 *
 * RGB under alpha 0 is not visible and is not preserved by every lossless
 * container; the alpha channel and every pixel with alpha > 0 must be exactly
 * equal. Comparing raw bytes instead would fail on a transparent background whose
 * colour nobody can see.
 */
function displayedEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 4) {
    if (left[index + 3] !== right[index + 3]) return false;
    if (left[index + 3] === 0) continue;
    if (left[index] !== right[index] || left[index + 1] !== right[index + 1] || left[index + 2] !== right[index + 2]) {
      return false;
    }
  }
  return true;
}

/** Peak-signal-to-noise ratio between two same-sized RGB buffers. */
function psnr(left: Buffer, right: Buffer): number {
  assert.equal(left.length, right.length, 'PSNR needs same-sized images');
  let squared = 0;
  for (let index = 0; index < left.length; index++) {
    const delta = left[index]! - right[index]!;
    squared += delta * delta;
  }
  const mse = squared / left.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

/** The accepted image, or a failed assertion naming the refusal. */
function accepted(result: Awaited<ReturnType<typeof prepareImage>>): PreparedImage {
  assert.ok(result.ok, `the encoder refused a valid image: ${result.ok ? '' : result.reason}`);
  return result.image;
}

/** A source whose candidate is deliberately larger than it. */
async function alreadyCompressedJpeg(): Promise<Buffer> {
  const raw = noiseRgb(32, 32, 7);
  const source = await jpegFrom(raw, 32, 32, 10);
  // The property the row needs is bytes, not a guess about the codec: assert the
  // fixture before asserting the decision, so a codec change cannot turn this
  // into a test of nothing.
  const candidate = await sharp(source).autoOrient().webp({ ...ENCODER_SETTINGS.lossy }).toBuffer();
  assert.ok(candidate.length >= source.length, 'the generated JPEG no longer has a larger WebP candidate');
  return source;
}

/** A PNG whose lossless WebP candidate is larger, found by measurement. */
async function alreadyOptimizedPng(): Promise<Buffer> {
  const raw = noiseRgb(8, 8, 11);
  const source = await sharp(raw, { raw: { width: 8, height: 8, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const candidate = await sharp(source).webp({ lossless: true, ...ENCODER_SETTINGS.lossless }).toBuffer();
  assert.ok(candidate.length >= source.length, 'the generated PNG no longer has a larger lossless WebP candidate');
  return source;
}

/**
 * PNG_SCREENSHOT with an `acTL` chunk inserted before its image data.
 *
 * Sharp reports no frame count for this shape, which is exactly the case the
 * APNG guard exists for; a real animated PNG carries `fcTL`/`fdAT` chunks the
 * guard does not need to parse to decide "do not flatten".
 */
function animatedPngShape(): Buffer {
  const source = Buffer.from(PNG_SCREENSHOT);
  const next = 8 + 25; // signature + IHDR length/type/data/CRC
  const data = Buffer.alloc(8);
  data.writeUInt32BE(1, 0);
  data.writeUInt32BE(0, 4);
  const type = Buffer.from('acTL');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 0);
  return Buffer.concat([source.subarray(0, next), length, type, data, checksum, source.subarray(next)]);
}

/** A PNG whose IHDR declares a chosen size but whose IDAT is tiny. */
function declaredSizePng(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG_UNICODE);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  const checksum = crc32(bytes.subarray(12, 29));
  bytes.writeUInt32BE(checksum >>> 0, 29);
  return bytes;
}

/** A three-frame GIF generated through sharp's own animation join. */
async function animatedGif(): Promise<Buffer> {
  const frames: Buffer[] = [];
  for (let frame = 0; frame < 3; frame++) {
    const raw = Buffer.alloc(8 * 8 * 3);
    for (let index = 0; index < raw.length; index += 3) {
      raw[index] = frame * 90;
      raw[index + 1] = 60;
      raw[index + 2] = 255 - frame * 80;
    }
    frames.push(await sharp(raw, { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer());
  }
  return sharp(frames, { join: { animated: true } }).gif().toBuffer();
}

/** Shrink exactly one limit, keeping the rest measured from the host. */
function withLimit(overrides: Partial<MediaLimits>): MediaLimits {
  return { ...MEDIA_LIMITS, ...overrides };
}

test('a JPEG photograph becomes a smaller lossy WebP, with no source metadata', async () => {
  const source = await photograph();
  const image = accepted(await prepareImage(source, 'jpeg'));

  assert.equal(image.transcoded, true, 'a photograph with a smaller candidate kept the JPEG');
  assert.equal(image.format, 'webp');
  assert.ok(image.bytes.length < source.length, 'the accepted candidate is not smaller');
  assert.equal(sniffImageFormat(image.bytes), 'webp', 'the emitted bytes are not WebP');
  assert.equal(imageExtension(image.format), '.webp', 'the filename extension would disagree with the bytes');
  assert.equal(imageMimeType(image.format), 'image/webp', 'the MIME type would disagree with the bytes');
  assert.deepEqual(image.dimensions, { width: 640, height: 480 }, 'the emitted header lost the displayed size');

  const metadata = await sharp(image.bytes).metadata();
  assert.equal(metadata.exif, undefined, 'a transcoded photograph kept source EXIF');
  assert.equal(metadata.orientation, undefined, 'a transcoded photograph kept an orientation tag');
  assert.equal(metadata.icc, undefined, 'a transcoded photograph carries a profile the design says it strips');

  // Quality is a qualification property, not a production comparison: record the
  // measured PSNR for this representative photograph and require it stays above
  // the threshold the fixture review accepted.
  const original = await displayedRgba(source);
  const published = await displayedRgba(image.bytes);
  const measured = psnr(original, published);
  assert.ok(measured > 32, `q80 WebP lost too much: PSNR ${measured.toFixed(2)} dB`);
});

test('a JPEG whose WebP candidate is larger keeps the JPEG, metadata and all', async () => {
  const source = await alreadyCompressedJpeg();
  const image = accepted(await prepareImage(source, 'jpeg'));

  assert.equal(image.transcoded, false, 'a larger candidate replaced the already-compressed JPEG');
  assert.equal(image.format, 'jpeg');
  assert.ok(image.bytes.equals(source), 'the retained JPEG is not the source bytes');
  assert.deepEqual(image.dimensions, { width: 32, height: 32 });
});

test('a PNG screenshot becomes lossless WebP, pixel-identical including alpha', async () => {
  for (const source of [PNG_SCREENSHOT, PNG_TRANSPARENT]) {
    const image = accepted(await prepareImage(Buffer.from(source), 'png'));
    assert.equal(image.transcoded, true, 'a PNG with a smaller candidate kept the PNG');
    assert.equal(image.format, 'webp');
    assert.equal(sniffImageFormat(image.bytes), 'webp');
    assert.ok(image.bytes.length < source.length, 'the accepted lossless candidate is not smaller');

    const original = await displayedRgba(Buffer.from(source));
    const published = await displayedRgba(image.bytes);
    assert.ok(displayedEqual(original, published), 'lossless conversion changed a displayed pixel or an alpha value');
  }
});

test('a PNG whose lossless candidate is larger keeps the PNG', async () => {
  const source = await alreadyOptimizedPng();
  const image = accepted(await prepareImage(source, 'png'));

  assert.equal(image.transcoded, false, 'a larger lossless candidate replaced the PNG');
  assert.equal(image.format, 'png');
  assert.ok(image.bytes.equals(source), 'the retained PNG is not the source bytes');
  assert.deepEqual(image.dimensions, { width: 8, height: 8 });
});

test('existing WebP and AVIF publish unchanged, EXIF included', async () => {
  for (const [bytes, format] of [
    [WEBP_LOSSY, 'webp'],
    [WEBP_LOSSLESS, 'webp'],
    [WEBP_ANIMATED, 'webp'],
    [AVIF, 'avif'],
  ] as const) {
    const image = accepted(await prepareImage(Buffer.from(bytes), format));
    assert.equal(image.transcoded, false, `${format} was re-encoded`);
    assert.equal(image.format, format);
    assert.ok(image.bytes.equals(Buffer.from(bytes)), `${format} was not byte-identical`);
  }

  // The passthrough privacy story, stated as a control: an unchanged WebP is
  // unchanged, so its EXIF orientation is still there.
  const oriented = accepted(await prepareImage(Buffer.from(ORIENTED_WEBP), 'webp'));
  const metadata = await sharp(oriented.bytes).metadata();
  assert.equal(metadata.orientation, 6, 'a passthrough WebP lost its EXIF orientation');
});

test('animated GIF and WebP are published unchanged, frames and timing intact', async () => {
  const sources: readonly (readonly [string, Buffer])[] = [
    ['gif', await animatedGif()],
    ['webp', Buffer.from(WEBP_ANIMATED)],
  ];
  for (const [format, source] of sources) {
    const before = await sharp(source).metadata();
    assert.ok((before.pages ?? 1) > 1, `${format}: the generated fixture is no longer animated`);
    const image = accepted(await prepareImage(source, format as 'gif' | 'webp'));
    assert.equal(image.transcoded, false, `${format}: an animated source was re-encoded`);
    assert.ok(image.bytes.equals(source), `${format}: an animated source changed bytes`);
    const after = await sharp(image.bytes).metadata();
    assert.equal(after.pages, before.pages, `${format}: the frame count changed`);
    assert.deepEqual(after.delay, before.delay, `${format}: frame timing changed`);
    assert.equal(after.loop, before.loop, `${format}: the loop count changed`);
  }
});

test('an animated PNG is preserved rather than flattened to one frame', async () => {
  const source = animatedPngShape();
  const image = accepted(await prepareImage(source, 'png'));
  assert.equal(image.transcoded, false, 'an APNG was converted to a still WebP');
  assert.ok(image.bytes.equals(source), 'the APNG bytes changed');
});

test('every intact supported container passes the structural completeness gate', () => {
  assert.doesNotThrow(() => assertCompleteContainer('png', Buffer.from(PNG_UNICODE)));
  assert.doesNotThrow(() => assertCompleteContainer('jpeg', Buffer.from(JPEG)));
  assert.doesNotThrow(() => assertCompleteContainer('gif', Buffer.from(GIF_ANIMATED), { pages: 3 }));
  assert.doesNotThrow(() => assertCompleteContainer('webp', Buffer.from(WEBP_LOSSY)));
  assert.doesNotThrow(() => assertCompleteContainer('avif', Buffer.from(AVIF)));
});

test('progressive JPEGs with multiple scans are accepted, truncated ones are corrupt', async () => {
  const progressive = Buffer.from(await progressiveJpeg());
  const metadata = await sharp(progressive).metadata();
  assert.equal(metadata.isProgressive, true, 'the generated fixture is not a progressive JPEG');
  assert.ok(progressive.length > Buffer.from(JPEG).length, 'the progressive fixture is not a multi-scan file');

  assert.doesNotThrow(() => assertCompleteContainer('jpeg', progressive));
  assert.doesNotThrow(() => assertCompleteContainer('jpeg', Buffer.from(JPEG)));

  const image = accepted(await prepareImage(progressive, 'jpeg'));
  assert.equal(image.transcoded, true, 'a progressive JPEG skipped the lossy-WebP policy row');
  assert.equal(image.format, 'webp');
  assert.ok(image.bytes.length < progressive.length, 'the accepted progressive candidate is not smaller');

  const truncated = progressive.subarray(0, progressive.length - 2);
  assert.throws(
    () => assertCompleteContainer('jpeg', truncated),
    /incomplete/,
    'a progressive JPEG without EOI passed the walk',
  );
  const refused = await prepareImage(Buffer.from(truncated), 'jpeg');
  assert.equal(refused.ok, false, 'a truncated progressive JPEG was accepted');
  if (!refused.ok) assert.equal(refused.reason, 'corrupt');
});

test('an AVIF primary item in meta/idat is accepted; overrun and no-container are not', async () => {
  const original = Buffer.from(AVIF);
  const relocated = Buffer.from(AVIF_PRIMARY_IN_IDAT);
  assert.equal(relocated.length, original.length + 2, 'the method-1 iloc did not gain its construction field');

  for (const [name, bytes] of [
    ['original', original],
    ['relocated', relocated],
  ] as const) {
    const stats = await sharp(bytes).stats();
    assert.equal(stats.channels.length, 3, `${name}: libheif did not decode the AVIF`);
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height], [8, 6], `${name}: decoded dimensions changed`);
    assert.doesNotThrow(() => assertCompleteContainer('avif', bytes), `${name}: the gate rejected a valid AVIF`);
  }

  const image = accepted(await prepareImage(relocated, 'avif'));
  assert.equal(image.transcoded, false, 'the method-1 AVIF was re-encoded');
  assert.equal(image.format, 'avif');
  assert.ok(image.bytes.equals(relocated), 'the method-1 AVIF was not published byte-identically');

  const refused: readonly (readonly [string, Buffer])[] = [
    ['extent past idat', Buffer.from(AVIF_PRIMARY_IN_IDAT_OVERRUN)],
    ['no container', Buffer.from(AVIF_PRIMARY_IN_IDAT_NO_CONTAINER)],
    ['non-zero data reference', Buffer.from(AVIF_PRIMARY_IN_IDAT_DATA_REFERENCE)],
    ['construction method 2', Buffer.from(AVIF_PRIMARY_IN_IDAT_METHOD_2)],
  ];
  for (const [name, bytes] of refused) {
    assert.throws(() => assertCompleteContainer('avif', bytes), /incomplete AVIF/, `${name}: the gate accepted it`);
    const result = await prepareImage(bytes, 'avif');
    assert.equal(result.ok, false, `${name} was accepted by the encoder`);
    if (!result.ok) assert.equal(result.reason, 'corrupt', `${name}: wrong reason`);
  }
});

test('truncated containers are refused before a decoder can report partial success', async () => {
  const gif = await animatedGif();
  const gifMetadata = await sharp(gif).metadata();
  assert.equal(gifMetadata.pages, 3, 'the GIF control is not a real three-frame animation');
  assert.equal(gif[gif.length - 1], 0x3b, 'the GIF control does not end at its trailer');
  const png = Buffer.from(PNG_SCREENSHOT);
  const avif = Buffer.from(AVIF);
  const mdat = avif.indexOf('mdat');
  assert.ok(mdat > 0, 'the AVIF control has no mdat to truncate');
  const mdatMidpoint = mdat + 4 + Math.floor((avif.length - (mdat + 4)) / 2);
  assert.ok(mdatMidpoint > mdat + 4 && mdatMidpoint < avif.length, 'the AVIF cut is not inside mdat');
  const webp = Buffer.from(WEBP_LOSSY);
  const riffSize = webp.readUInt32LE(4);
  webp.writeUInt32LE(riffSize - 1, 4);
  const gifWithTrailingByte = Buffer.concat([gif, Buffer.from([0x01])]);
  const pngWithTrailingByte = Buffer.concat([png, Buffer.from([0x00])]);
  const pngWithBadCrc = Buffer.from(png);
  const idat = pngWithBadCrc.indexOf('IDAT');
  assert.ok(idat > 0, 'the PNG control has no IDAT chunk');
  pngWithBadCrc[idat + 4] = pngWithBadCrc[idat + 4]! ^ 0xff;

  const rows: readonly (readonly [string, Buffer, 'png' | 'jpeg' | 'webp' | 'gif' | 'avif'])[] = [
    ['GIF at 90%', gif.subarray(0, Math.floor(gif.length * 0.9)), 'gif'],
    ['GIF at 75%', gif.subarray(0, Math.floor(gif.length * 0.75)), 'gif'],
    ['GIF at 50%', gif.subarray(0, Math.floor(gif.length * 0.5)), 'gif'],
    ['GIF without trailer', gif.subarray(0, gif.length - 1), 'gif'],
    ['GIF with a non-zero byte after trailer', gifWithTrailingByte, 'gif'],
    ['PNG minus 4 bytes', png.subarray(0, png.length - 4), 'png'],
    ['PNG minus 12 bytes', png.subarray(0, png.length - 12), 'png'],
    ['PNG minus 20 bytes', png.subarray(0, png.length - 20), 'png'],
    ['PNG at half', png.subarray(0, Math.floor(png.length / 2)), 'png'],
    ['PNG with a trailing byte after IEND', pngWithTrailingByte, 'png'],
    ['PNG with a damaged chunk CRC', pngWithBadCrc, 'png'],
    ['JPEG without EOI', Buffer.from(JPEG.subarray(0, JPEG.length - 2)), 'jpeg'],
    ['WebP with a shortened RIFF size', webp, 'webp'],
    ['AVIF truncated mid-mdat', avif.subarray(0, mdatMidpoint), 'avif'],
  ];
  for (const [name, bytes, format] of rows) {
    assert.throws(
      () => assertCompleteContainer(format, bytes, { pages: gifMetadata.pages }),
      /incomplete/,
      `${name}: the completeness gate accepted it`,
    );
    const result = await prepareImage(Buffer.from(bytes), format);
    assert.equal(result.ok, false, `${name} was accepted by the encoder`);
    if (!result.ok) assert.equal(result.reason, 'corrupt', `${name}: wrong reason`);
  }

  // The same bytes before each cut still pass, so the rows above measure the
  // truncation and not a fixture that was already incomplete.
  assert.doesNotThrow(() => assertCompleteContainer('gif', gif, { pages: gifMetadata.pages }));
  assert.doesNotThrow(() => assertCompleteContainer('png', png));
  assert.doesNotThrow(() => assertCompleteContainer('jpeg', Buffer.from(JPEG)));
  assert.doesNotThrow(() => assertCompleteContainer('webp', Buffer.from(WEBP_LOSSY)));
  assert.doesNotThrow(() => assertCompleteContainer('avif', avif));
});

test('a 16-bit PNG is published unchanged instead of being reduced to 8-bit', async () => {
  const source = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .toColourspace('rgb16')
    .png()
    .toBuffer();
  const sourceMetadata = await sharp(source).metadata();
  assert.equal(sourceMetadata.depth, 'ushort', 'the fixture is not a 16-bit PNG');
  assert.equal(pngCanUseLosslessWebp(source), false, 'the policy would transcode a 16-bit PNG');

  const image = accepted(await prepareImage(source, 'png'));
  assert.equal(image.transcoded, false, 'a 16-bit PNG was converted');
  assert.equal(image.format, 'png');
  assert.ok(image.bytes.equals(source), 'the 16-bit PNG bytes changed');

  // Non-vacuity: an 8-bit lossless candidate exists and is smaller, so the
  // passthrough is the depth rule and not the size comparison.
  const candidate = await sharp(source)
    .webp({ lossless: true, ...ENCODER_SETTINGS.lossless })
    .toBuffer();
  assert.equal(sniffImageFormat(candidate), 'webp');
  assert.equal((await sharp(candidate).metadata()).depth, 'uchar');
  assert.ok(candidate.length < source.length, 'the generated 16-bit fixture no longer proves the depth rule');
});

test('a source beyond WebP dimensions publishes unchanged; the boundary is exact', async () => {
  const tallJpeg = await tallSource(100, 20_000, 'jpeg');
  const tallPng = await tallSource(100, 20_000, 'png');
  assert.equal((await sharp(tallPng).metadata()).depth, 'uchar', 'the tall PNG is not 8-bit');

  for (const [source, format] of [
    [tallJpeg, 'jpeg'],
    [tallPng, 'png'],
  ] as const) {
    const image = accepted(await prepareImage(source, format));
    assert.equal(image.transcoded, false, `${format}: a source beyond WebP dimensions was encoded`);
    assert.equal(image.format, format);
    assert.ok(image.bytes.equals(source), `${format}: the unrepresentable source changed bytes`);
    assert.equal(image.dimensions?.height, 20_000);
  }

  for (const [name, source, format, cut] of [
    ['tall JPEG', tallJpeg, 'jpeg', 2],
    ['tall PNG', tallPng, 'png', 12],
  ] as const) {
    const truncated = source.subarray(0, source.length - cut);
    const result = await prepareImage(Buffer.from(truncated), format);
    assert.equal(result.ok, false, `${name} truncated to ${truncated.length} bytes was accepted`);
    if (!result.ok) assert.equal(result.reason, 'corrupt', `${name}: a truncated source was not corrupt`);
  }

  const atLimit = await tallSource(100, WEBP_MAX_DIMENSION, 'jpeg');
  const encoded = accepted(await prepareImage(atLimit, 'jpeg'));
  assert.equal(encoded.transcoded, true, 'the inclusive WebP dimension was treated as unrepresentable');
  assert.equal(encoded.format, 'webp');
  assert.equal(encoded.dimensions?.height, WEBP_MAX_DIMENSION);
  assert.ok(encoded.bytes.length < atLimit.length, 'the boundary source no longer has a smaller candidate');

  const overLimit = await tallSource(100, WEBP_MAX_DIMENSION + 1, 'jpeg');
  const retained = accepted(await prepareImage(overLimit, 'jpeg'));
  assert.equal(retained.transcoded, false, 'one pixel past WebP dimensions was sent to the encoder');
  assert.equal(retained.format, 'jpeg');
  assert.ok(retained.bytes.equals(overLimit), 'the over-limit JPEG changed bytes');
}, 30_000);

test('an EXIF-rotated JPEG publishes upright, at its displayed size', async () => {
  const image = accepted(await prepareImage(Buffer.from(ORIENTED_JPEG), 'jpeg'));
  assert.equal(image.transcoded, true);
  // Coded 8×6 with Orientation 6; displayed 6×8.
  assert.deepEqual(image.dimensions, { width: 6, height: 8 }, 'the declared pair is the coded frame, not the displayed one');
  const metadata = await sharp(image.bytes).metadata();
  assert.equal(metadata.width, 6);
  assert.equal(metadata.height, 8);
  assert.equal(metadata.orientation, undefined, 'the emitted image still needs a rotation tag');
  assert.equal(metadata.exif, undefined, 'orientation was preserved as metadata instead of applied');

  const original = await displayedRgba(Buffer.from(ORIENTED_JPEG));
  const published = await displayedRgba(image.bytes);
  assert.equal(original.length, published.length);
  assert.ok(psnr(original, published) > 32, 'the rotated candidate does not match the displayed source');
});

test('an EXIF-rotated PNG converts losslessly after orientation is applied', async () => {
  const source = Buffer.from(ORIENTED_PNG);
  const image = accepted(await prepareImage(source, 'png'));
  assert.equal(image.transcoded, true);
  assert.deepEqual(image.dimensions, { width: 6, height: 8 });
  const metadata = await sharp(image.bytes).metadata();
  assert.equal(metadata.orientation, undefined);
  assert.ok(displayedEqual(await displayedRgba(source), await displayedRgba(image.bytes)), 'the rotated lossless conversion changed pixels');
});

test('an embedded non-sRGB profile is converted to sRGB before metadata is removed', async () => {
  // The source is sRGB green re-encoded as Display-P3. Its stored P3 values are
  // far from its sRGB appearance, which is what makes stripping the profile
  // without converting it visible.
  const untagged = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 255, b: 0 } } })
    .jpeg({ quality: 95 })
    .toBuffer();
  const tagged = await sharp(untagged).withIccProfile('p3', { attach: true }).toBuffer();
  assert.ok((await sharp(tagged).metadata()).icc, 'the P3 source carries no profile');

  const image = accepted(await prepareImage(tagged, 'jpeg'));
  assert.equal(image.transcoded, true);
  const metadata = await sharp(image.bytes).metadata();
  assert.equal(metadata.icc, undefined, 'the transcoded output kept or attached an ICC profile');

  const intended = await sharp(tagged).raw().toBuffer();
  const stored = await sharp(tagged, { ignoreIcc: true }).raw().toBuffer();
  const published = await sharp(image.bytes).raw().toBuffer();
  let intendedDelta = 0;
  let storedDelta = 0;
  for (let index = 0; index < intended.length; index++) {
    intendedDelta = Math.max(intendedDelta, Math.abs(intended[index]! - published[index]!));
    storedDelta = Math.max(storedDelta, Math.abs(stored[index]! - published[index]!));
  }
  assert.ok(storedDelta > 100, 'the fixture no longer distinguishes stored P3 values from sRGB appearance');
  assert.ok(intendedDelta < 20, `the conversion lost the intended colour: max delta ${intendedDelta}`);
});

test('different sources that encode to the same bytes produce one candidate', async () => {
  const pixels = await photograph(128, 96);
  const first = await sharp(pixels).jpeg({ quality: 92 }).withExif({ IFD0: { Copyright: 'first author' } }).toBuffer();
  const second = await sharp(pixels).jpeg({ quality: 92 }).withExif({ IFD0: { Copyright: 'second author' } }).toBuffer();
  assert.ok(!first.equals(second), 'the two sources differ only in metadata, but are byte-identical');

  const one = accepted(await prepareImage(first, 'jpeg'));
  const two = accepted(await prepareImage(second, 'jpeg'));
  assert.equal(one.transcoded, true);
  assert.equal(two.transcoded, true);
  assert.ok(one.bytes.equals(two.bytes), 'metadata-only source differences survived the transcode');
});

test('two preparations of unchanged bytes are byte-identical', async () => {
  for (const [source, format] of [
    [await photograph(96, 64), 'jpeg'],
    [Buffer.from(PNG_TRANSPARENT), 'png'],
    [Buffer.from(WEBP_ANIMATED), 'webp'],
  ] as const) {
    const first = accepted(await prepareImage(source, format));
    const second = accepted(await prepareImage(source, format));
    assert.ok(first.bytes.equals(second.bytes), `${format}: two preparations disagreed`);
    assert.deepEqual(first.dimensions, second.dimensions, `${format}: two preparations declared different sizes`);
  }
});

test('a declared huge frame fails on the decoded-pixel limit, bounded and fast', async () => {
  const bomb = declaredSizePng(50_000, 50_000);
  const started = performance.now();
  const result = await prepareImage(bomb, 'png');
  const elapsed = performance.now() - started;
  assert.equal(result.ok, false, 'a 2.5-gigapixel PNG was accepted');
  if (!result.ok) assert.equal(result.reason, 'too-large', 'a bomb was classified as a data error');
  assert.ok(elapsed < 5_000, `the pixel limit took ${elapsed.toFixed(0)} ms; it did not fail boundedly`);

  // The same input under an injected lower limit, so the control does not rely
  // on the host's default alone.
  const small = declaredSizePng(100, 100);
  const limited = await prepareImage(small, 'png', withLimit({ maxPixels: 1_000 }));
  assert.equal(limited.ok, false, 'an over-limit frame was accepted');
  if (!limited.ok) assert.equal(limited.reason, 'too-large');
});

test('the source-byte, total-animation and time limits are finite and enforced', async () => {
  const jpeg = await photograph(64, 48);

  const byteLimited = await prepareImage(jpeg, 'jpeg', withLimit({ maxSourceBytes: 16 }));
  assert.equal(byteLimited.ok, false);
  if (!byteLimited.ok) assert.equal(byteLimited.reason, 'too-large');

  const animated = await animatedGif();
  const animationLimited = await prepareImage(animated, 'gif', withLimit({ maxAnimationPixels: 1 }));
  assert.equal(animationLimited.ok, false, 'an animation above the total-pixel budget was accepted');
  if (!animationLimited.ok) assert.equal(animationLimited.reason, 'too-large');

  const timed = await prepareImage(await photograph(1_600, 1_200), 'jpeg', withLimit({ encodeTimeoutMs: 1 }));
  assert.equal(timed.ok, false, 'a 1 ms encode deadline did not stop the encode');
  if (!timed.ok) assert.equal(timed.reason, 'timeout');
});
