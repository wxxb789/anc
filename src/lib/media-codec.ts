/**
 * Goal 0011's one encoder: a build-time WebP candidate for already-authorized
 * raster bytes.
 *
 * This module is deliberately **not** a publication authority. It receives bytes
 * the producer has already resolved, authorized and sniffed, and it returns
 * either a byte buffer the build may publish or a bounded failure reason. It
 * never reads a path, never sees a filename, and has no way to reach a source
 * file the walk did not approve. `src/lib/media.ts` remains the module that
 * identifies formats and public identity.
 *
 * ## The policy, exactly as `docs/core-design/media-pipeline.md` states it
 *
 * | Validated input | Candidate | Keep it only when |
 * | --- | --- | --- |
 * | JPEG | lossy WebP, quality 80, effort 4 | its bytes are smaller than the JPEG's |
 * | 8-bit PNG | lossless WebP, effort 4 | its bytes are smaller than the PNG's; pixels are not compared here |
 * | 16-bit or other-depth PNG | none | the original bytes are published unchanged |
 * | WebP / AVIF | none | the original bytes are published unchanged |
 * | animated GIF / animated WebP | none | ditto; no first frame is extracted |
 * | static GIF | none | no policy row selects an encoder for it |
 * | corrupt / over budget | none | the build fails; there is no fallback to the input |
 *
 * The comparison is **candidate emitted bytes vs source bytes**, never an
 * estimate and never a perceptual score. Lossy quality is a qualification
 * property (tests and the measurement corpus), not a runtime knob.
 *
 * ## Order of operations that must not be swapped
 *
 * `.autoOrient()` is applied before output. Sharp then strips source metadata on
 * a transcode, so the published pixels are the displayed pixels and the emitted
 * header carries the displayed size. Callers read dimensions from the *emitted*
 * bytes with 0010's reader, which is why a rotated JPEG does not leak its coded
 * frame into `width`/`height`.
 *
 * `.withIccProfile('srgb', { attach: false })` converts an embedded colour
 * profile to sRGB and attaches none. Without it, stripping the ICC profile from a
 * Display-P3 photo would change the colours a browser shows; with it, the
 * conversion happens and the output stays metadata-free.
 *
 * ## Bounds
 *
 * Every operation runs under a byte cap, a decoded-pixel cap and a wall-clock
 * deadline. `unlimited` is never set. The caps are chosen from the measured
 * corpus and hostile controls recorded in goal 0011; they are finite because a
 * build on a personal-notes host must fail on a decompression bomb rather than
 * be killed by the operating system.
 */

import sharp, { type Metadata, type SharpOptions } from 'sharp';
import {
  assertCompleteContainer,
  imageDimensions,
  isAnimatedPng,
  isPositiveDimension,
  pngCanUseLosslessWebp,
  type ImageDimensions,
  type ImageFormat,
  type MediaProcessingFailureReason,
} from './media.ts';

/**
 * The fixed encoder settings for each format.
 *
 * The producer's cache is keyed by source digest alone because these are module
 * constants for the lifetime of one build; changing a quality or effort here is
 * a code change, not a per-build input. There is no author-facing knob and no
 * configuration key.
 */
export const ENCODER_SETTINGS = Object.freeze({
  /** Lossy WebP for JPEG photographs. */
  lossy: Object.freeze({ quality: 80, effort: 4 }),
  /** Lossless WebP for PNG screenshots, diagrams and alpha. */
  lossless: Object.freeze({ effort: 4 }),
  /** Converted-to-sRGB, metadata-free transcodes. */
  colourspace: 'srgb',
});

/**
 * libwebp's maximum supported dimension, `WEBP_MAX_DIMENSION` in
 * `webp/encode.h`: 16383 pixels per side, inclusive.
 *
 * A source at or below this bound may have a WebP candidate; a valid image with
 * either side above it cannot, so it must take the passthrough path rather than
 * being mislabeled `corrupt` by the encoder. This is the library's format
 * boundary, not a second project budget.
 */
export const WEBP_MAX_DIMENSION = 16_383;

/** The per-call budgets one prepare invocation obeys. Tests inject smaller ones. */
export interface MediaLimits {
  readonly maxSourceBytes: number;
  readonly maxPixels: number;
  readonly maxAnimationPixels: number;
  readonly decodeTimeoutMs: number;
  readonly encodeTimeoutMs: number;
}

/**
 * Finite limits for one image, in the units each one bounds.
 *
 * - `maxSourceBytes` stops a absurdly large file before libvips parses it.
 * - `maxPixels` is sharp's `limitInputPixels`; a single decoded frame above it
 *   is refused by libvips before allocation.
 * - `maxAnimationPixels` bounds the stack of all frames when an animated file is
 *   decode-validated, because the full-animation check is the one place this
 *   build decodes more than the frame it displays.
 * - The deadlines bound wall time per operation. libvips has no cancellable
 *   decode, so a deadline abandons the promise and fails the build; the worker's
 *   thread is left to finish, which is why the operation count is also bounded.
 *
 * Measured on the 4 vCPU / 8 GB qualification host rather than guessed; the goal
 * record carries the throughput, peak-RSS and hostile-input results.
 */
export const MEDIA_LIMITS: MediaLimits = Object.freeze({
  maxSourceBytes: 32 * 1024 * 1024,
  maxPixels: 50_000_000,
  maxAnimationPixels: 50_000_000,
  decodeTimeoutMs: 20_000,
  encodeTimeoutMs: 20_000,
});

/** The bytes and facts a publisher needs after a successful preparation. */
export interface PreparedImage {
  /** Exactly the bytes that would be published. */
  readonly bytes: Buffer;
  /** The format those bytes are; `webp` when a candidate was accepted. */
  readonly format: ImageFormat;
  /** Intrinsic size read from {@link bytes}, when a header could be read. */
  readonly dimensions?: ImageDimensions;
  /** Whether the candidate replaced the source bytes. */
  readonly transcoded: boolean;
}

/** What preparing one authorized image produced. */
export type PrepareResult =
  | { readonly ok: true; readonly image: PreparedImage }
  | { readonly ok: false; readonly reason: MediaProcessingFailureReason };

/** A rejected operation whose classification the caller needs. */
class MediaLimitError extends Error {
  readonly reason: MediaProcessingFailureReason;

  constructor(reason: MediaProcessingFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Sharp's error text for libvips' pixel-limit refusal, across versions. */
const PIXEL_LIMIT_ERROR = /pixel limit|exceeds.*limit/i;

/**
 * Configure libvips once for this process.
 *
 * The cache is off because the producer already caches per source digest and a
 * second, opaque cache inside libvips would only retain buffers; the thread count
 * is explicit so a build's resource use is not whatever the host's CPU count
 * happens to be. Both settings are process-wide and therefore not per-image
 * budgets; every sharp consumer in this repository shares them.
 */
const SHARP_CONCURRENCY = 4;
sharp.cache(false);
sharp.concurrency(SHARP_CONCURRENCY);

/** Raise the timeout classification above the generic sharp wrapper. */
function classify(error: unknown): MediaProcessingFailureReason {
  if (error instanceof MediaLimitError) return error.reason;
  if (error instanceof Error && PIXEL_LIMIT_ERROR.test(error.message)) return 'too-large';
  return 'corrupt';
}

/**
 * Run one libvips operation under a deadline.
 *
 * `Promise.race` rather than an abort signal because sharp exposes none: the
 * winning promise is settled and the loser's rejection is still observed by the
 * race's own handler, so it cannot become an unhandled rejection. On timeout the
 * build fails with a bounded reason; it does not fall back to publishing bytes
 * this process could not read.
 */
async function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new MediaLimitError('timeout', 'operation exceeded its deadline')),
    milliseconds,
  );
  try {
    return await Promise.race([work, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** The constructor options every operation on untrusted bytes uses. */
function inputOptions(limits: MediaLimits, animated = false): SharpOptions {
  return {
    // Sharp's strict default: a warning is a failure, not a partially decoded image.
    failOn: 'warning',
    limitInputPixels: limits.maxPixels,
    // Never lifted: this is the decompression-bomb boundary.
    unlimited: false,
    // The bytes are a buffer, so sequential access is the truthful hint.
    sequentialRead: true,
    ...(animated ? { animated: true } : {}),
  };
}

/** Read a source's own header without trusting its filename. */
async function readMetadata(bytes: Buffer, limits: MediaLimits, animated: boolean): Promise<Metadata> {
  return withDeadline(
    sharp(bytes, inputOptions(limits, animated)).metadata(),
    limits.decodeTimeoutMs,
  );
}

/** The displayed pixel size after `autoOrient`, from the coded frame and its tag. */
function displayedDimensions(metadata: Metadata): ImageDimensions {
  const { width, height, orientation } = metadata;
  if (!isPositiveDimension(width) || !isPositiveDimension(height)) {
    throw new MediaLimitError('corrupt', 'the image header declares no positive pixel size');
  }
  const transposed = orientation !== undefined && orientation >= 5 && orientation <= 8;
  return transposed ? { width: height, height: width } : { width, height };
}

/**
 * Fully decode a passthrough image once, so a corrupt or truncated file fails
 * the build instead of reaching a reader.
 *
 * A header read is not decode validation: measured, a JPEG truncated to 10% of
 * its bytes still yields valid metadata. `stats()` decodes the visible frame. An
 * animated file's first metadata read already used `animated: true`, so the
 * stacked height and frame count are available without opening the file twice;
 * the raw decode checks every frame under the separate total-pixel budget.
 */
async function validateDecode(bytes: Buffer, metadata: Metadata, limits: MediaLimits): Promise<void> {
  const pages = metadata.pages ?? 1;
  if (pages > 1) {
    const { width, height } = metadata;
    if (!isPositiveDimension(width) || !isPositiveDimension(height)) {
      throw new MediaLimitError('corrupt', 'the animated image header declares no positive pixel size');
    }
    // With `animated: true` sharp reports a stacked image: `height` is already
    // the sum of every frame, so multiplying by `pages` would count the frames
    // twice. Measured on animated WebP and GIF, both of which also expose
    // `pageHeight`; the bound is the actual decoded surface.
    if (width * height > limits.maxAnimationPixels) {
      throw new MediaLimitError('too-large', 'the animated image exceeds the total decoded-pixel budget');
    }
    await withDeadline(
      sharp(bytes, inputOptions(limits, true)).raw().toBuffer(),
      limits.decodeTimeoutMs,
    );
    return;
  }
  await withDeadline(
    sharp(bytes, inputOptions(limits)).stats(),
    limits.decodeTimeoutMs,
  );
}

/** The one `.webp()` option object for a policy row. */
function webpOptions(format: 'jpeg' | 'png'): Record<string, number | boolean> {
  return format === 'jpeg' ? ENCODER_SETTINGS.lossy : { lossless: true, ...ENCODER_SETTINGS.lossless };
}

/**
 * Encode one validation-passing candidate and prove what came back is what the
 * policy says it should be.
 *
 * Returning `undefined` means "no candidate": the encoder produced bytes but the
 * output failed validation. That is a build failure, never a silent fallback,
 * because a codec that returned something unreadable is exactly the case in which
 * publishing the original would hide the defect.
 */
async function transcode(
  bytes: Buffer,
  format: 'jpeg' | 'png',
  metadata: Metadata,
  limits: MediaLimits,
): Promise<Buffer | undefined> {
  const expected = displayedDimensions(metadata);
  const encoded = await withDeadline(
    sharp(bytes, inputOptions(limits))
      .autoOrient()
      .withIccProfile(ENCODER_SETTINGS.colourspace, { attach: false })
      .webp(webpOptions(format))
      .toBuffer(),
    limits.encodeTimeoutMs,
  );
  if (encoded.length === 0) return undefined;

  const produced = await readMetadata(encoded, limits, false);
  if (produced.format !== 'webp') return undefined;
  if (produced.orientation !== undefined && produced.orientation !== 1) return undefined;
  if (produced.pages !== undefined && produced.pages > 1) return undefined;
  if (produced.width !== expected.width || produced.height !== expected.height) return undefined;
  return encoded;
}

/**
 * Prepare the one published representation of an authorized image.
 *
 * @param bytes The exact bytes the walk authorized; never re-read from a path.
 * @param format The format `sniffImageFormat` detected, which the walk already
 *   used to classify the file; the encoder does not second-guess it.
 */
export async function prepareImage(
  bytes: Buffer,
  format: ImageFormat,
  limits: MediaLimits = MEDIA_LIMITS,
): Promise<PrepareResult> {
  if (bytes.length > limits.maxSourceBytes) {
    return { ok: false, reason: 'too-large' };
  }

  // A successful header read is not a complete container: measured, libvips
  // decodes a 96x96 PNG with its last 20 bytes missing and a GIF truncated to
  // 90% with a garbage tail. The structural gate runs before any sharp call, so
  // an incomplete source never reaches libvips at all. GIF's one cross-check
  // that needs decoded metadata is repeated after the header read below.
  try {
    assertCompleteContainer(format, bytes);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }

  // Animation is a property of the already-sniffed container, not a second
  // decode: choosing it here makes the first metadata read sufficient.
  const animated = format === 'gif' || format === 'webp' || format === 'avif';
  let metadata: Metadata;
  try {
    metadata = await readMetadata(bytes, limits, animated);
  } catch (error) {
    return { ok: false, reason: classify(error) };
  }

  // The descriptor walk above counted frames, but only the decoder can say how
  // many pages it accepted. Requiring the two numbers to agree catches a stream
  // whose descriptors are structurally present but whose page table disagrees.
  if (format === 'gif') {
    try {
      assertCompleteContainer(format, bytes, { pages: metadata.pages });
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
  }

  const sourceResult = (): PrepareResult => ({
    ok: true,
    image: {
      bytes,
      format,
      dimensions: imageDimensions(bytes, format),
      transcoded: false,
    },
  });

  const passthrough = async (): Promise<PrepareResult> => {
    try {
      await validateDecode(bytes, metadata, limits);
    } catch (error) {
      return { ok: false, reason: classify(error) };
    }
    return sourceResult();
  };

  // The policy table has no encoding row for these formats, and an animation is
  // preserved rather than flattened.
  if (format === 'gif' || format === 'webp' || format === 'avif') return passthrough();
  const pages = metadata.pages ?? 1;
  if (pages > 1) return passthrough();
  // APNG is a PNG whose animation sharp does not report as pages. Preserve the
  // source exactly rather than publishing its first frame as a still WebP.
  // A PNG whose depth or colour model WebP lossless cannot carry faithfully
  // (16-bit and other depths) is likewise published unchanged, even when an
  // 8-bit candidate would be smaller: that candidate is a visible reduction.
  if (format === 'png' && (isAnimatedPng(bytes) || !pngCanUseLosslessWebp(bytes))) {
    return passthrough();
  }

  // WebP cannot represent a side above libwebp's 16,383-pixel limit. The source
  // is valid, so publish it unchanged instead of asking the encoder for a
  // candidate that cannot exist; the metadata read above already supplies the
  // displayed dimensions, so this does not decode again.
  let sourceDimensions: ImageDimensions;
  try {
    sourceDimensions = displayedDimensions(metadata);
  } catch (error) {
    return { ok: false, reason: classify(error) };
  }
  if (sourceDimensions.width > WEBP_MAX_DIMENSION || sourceDimensions.height > WEBP_MAX_DIMENSION) {
    return passthrough();
  }

  let candidate: Buffer | undefined;
  try {
    candidate = await transcode(bytes, format, metadata, limits);
  } catch (error) {
    return { ok: false, reason: classify(error) };
  }
  if (candidate === undefined) return { ok: false, reason: 'encode-failed' };

  // The only automatic comparison in this pass: emitted candidate bytes against
  // the bytes the source would have published. A larger or equal candidate is
  // discarded, not shipped for the sake of a `.webp` name.
  if (candidate.length >= bytes.length) return sourceResult();

  // 0010's reader owns the pair the artifact publishes, and it reads the emitted
  // bytes.
  const emitted = imageDimensions(candidate, 'webp');
  if (emitted === undefined) return { ok: false, reason: 'encode-failed' };
  return {
    ok: true,
    image: {
      bytes: candidate,
      format: 'webp',
      dimensions: emitted,
      transcoded: true,
    },
  };
}
