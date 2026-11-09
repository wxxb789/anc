/**
 * Render an accepted static SVG to the one representation this build publishes:
 * lossless WebP with a transparent background.
 *
 * The input is **bytes**, never a path. Sharp's SVG loader is libvips' `svgload`,
 * which hands librsvg a memory buffer rather than a file, so librsvg has no base
 * URI against which to resolve a relative reference. That is a security
 * assumption, not a substitute for the policy: `tests/svg-security.test.ts`
 * renders a document that bypasses the policy entirely and proves neither a host
 * canary nor a listening socket is touched. Both layers are deliberate, and the
 * test exercises each one separately.
 *
 * ## Sizing
 *
 * The natural size is **measured**, not assumed. A metadata read at density 72
 * reports the size librsvg itself chose from the document's own `width`,
 * `height`, `viewBox` and units; sharp's `limitInputPixels` bounds that read, so
 * a declared 1,000,000-pixel square is refused before a surface is allocated.
 * Two measured facts decide the rest:
 *
 * - `px`, unitless, percentage and `em` dimensions scale **linearly** with
 *   density (`100px` renders 100 then 200 at 72/144).
 * - physical units scale with the **square** of the density factor, because
 *   librsvg evaluates them at the requested DPI and sharp scales again
 *   (`100mm` renders 283 then 1134 at 72/144).
 *
 * The author's logical size is taken from `width`/`height` when absolute, with
 * CSS's 96 dpi conversion for physical units, and from the article layout when
 * the document only has a `viewBox`. The render target is 2× that logical size,
 * then clamped proportionally by a finite output-pixel budget and a maximum side.
 * Nothing is cropped and the `viewBox` is never rewritten.
 *
 * ## Output gate
 *
 * The emitted WebP is read back: MIME, one frame, exact target dimensions, the
 * target aspect ratio, and at least one visible pixel. A fully transparent render
 * fails the build — a blank picture is worse than a stopped build. The padding
 * factor in the density request (8% + 4 px) guarantees the rasterizer produces at
 * least the target so the final resize is always a downscale.
 */

import sharp, { type Metadata, type SharpOptions, type Stats } from 'sharp';
import { ENCODER_SETTINGS, MEDIA_LIMITS, type PrepareResult } from './media-codec.ts';
import { imageDimensions, isPositiveDimension, type ImageDimensions } from './media.ts';
import { inspectSvg, requiredCharacters, type SvgSource } from './svg-policy.ts';
import type { SvgRefusal } from './svg-refusal.ts';
import { missingCodePoints } from './font-coverage.ts';

/**
 * A render failure: a policy refusal, or the one deadline that has no syntax.
 *
 * `prepareSvg` also produces `too-large` and `encode-failed` directly, because
 * those are about this phase rather than the document's shape.
 */
type RenderRefusal = SvgRefusal | { readonly reason: 'timeout'; readonly detail: string };

/** The render budgets and target-density policy for one SVG. */
export interface SvgRenderLimits {
  /** Target density: 2× the logical size, for high-density displays. */
  readonly density: number;
  /** Logical width a `viewBox`-only document is laid out at, in CSS pixels. */
  readonly logicalWidth: number;
  /** Post-scale output-pixel budget; a larger target is downscaled proportionally. */
  readonly maxOutputPixels: number;
  /** Maximum output side, below libwebp's 16,383-pixel representability limit. */
  readonly maxOutputSide: number;
  /** Maximum surface the rasterizer may allocate for one render. */
  readonly maxRenderPixels: number;
  /** Bytes; an SVG above this is refused before the parser runs. */
  readonly maxSourceBytes: number;
}

/**
 * The render policy, chosen from the measurements recorded in goal 0012.
 *
 * `logicalWidth` is the article's reading measure rather than a library default:
 * `docs/core-design/media-pipeline.md` fixes a `viewBox`-only picture to the
 * article layout, and the stylesheet's `--measure` resolves to 68 characters —
 * measured at 720 px for the body face on this corpus. 2× of that is 1,440 px,
 * which is what a diagram is rasterized at before any budget clamp.
 *
 * `maxOutputPixels` is 6,000,000 — comfortably above a 1,440-wide diagram and its
 * caption-sized height, and finite so a hostile `viewBox` cannot ask for an
 * unbounded surface. `maxRenderPixels` is four times that, the headroom the
 * density formula's 8% padding and rounding need.
 */
export const SVG_RENDER_LIMITS: SvgRenderLimits = Object.freeze({
  density: 2,
  logicalWidth: 720,
  maxOutputPixels: 6_000_000,
  maxOutputSide: 8_000,
  maxRenderPixels: 24_000_000,
  maxSourceBytes: 8 * 1024 * 1024,
});

/** Sharp's own density ceiling, from its input options validation. */
const SHARP_MAX_DENSITY = 100_000;

/**
 * Sharp's error text for a libvips budget refusal, across versions.
 *
 * Both the pixel limit and a zero-sized vector surface appear here: a document
 * whose natural size rounds to nothing cannot be rendered at all, and reporting
 * that as a corrupt file would send the author looking for the wrong fault.
 */
const RENDER_BUDGET_ERROR = /pixel limit|exceeds.*limit|zero-sized|not a valid (?:image|svg)/i;

/** A rejection this module classifies for the publisher. */
class SvgRenderError extends Error {
  readonly refusal: RenderRefusal;

  constructor(refusal: RenderRefusal) {
    super(refusal.detail);
    this.refusal = refusal;
  }
}

/** A rejection, as the publisher's `PrepareResult` spells it. */
function failed(refusal: RenderRefusal): PrepareResult {
  return { ok: false, reason: refusal.reason, detail: refusal.detail };
}

/** Run one libvips operation under a deadline. */
async function withinDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new SvgRenderError({ reason: 'timeout', detail: 'the operation exceeded its deadline' })),
    milliseconds,
  );
  try {
    return await Promise.race([work, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Classify a sharp/libvips failure. */
function classifyRenderError(error: unknown): RenderRefusal {
  if (error instanceof SvgRenderError) return error.refusal;
  const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
  if (RENDER_BUDGET_ERROR.test(message)) {
    return { reason: 'svg-workload', detail: `the rasterizer refused the render: ${message}` };
  }
  return { reason: 'svg-render', detail: `the rasterizer failed: ${message}` };
}

/**
 * The constructor options every operation on untrusted SVG bytes uses.
 *
 * `density` is the only size lever and `limitInputPixels` is never lifted. The
 * options are the same ones the raster path uses, minus animation, because an SVG
 * has one surface. Sharp does not cap input bytes itself, so `prepareSvg` checks
 * the source length before calling.
 */
function renderOptions(density: number, limits: SvgRenderLimits): SharpOptions {
  return {
    density,
    failOn: 'warning',
    limitInputPixels: limits.maxRenderPixels,
    unlimited: false,
    sequentialRead: true,
  };
}

/** The natural size librsvg chooses at 72 dpi, bounded by the render budget. */
async function naturalSize(
  bytes: Buffer,
  limits: SvgRenderLimits,
): Promise<ImageDimensions | RenderRefusal> {
  try {
    const metadata = await withinDeadline(
      sharp(bytes, renderOptions(72, limits)).metadata(),
      MEDIA_LIMITS.decodeTimeoutMs,
    );
    if (!isPositiveDimension(metadata.width) || !isPositiveDimension(metadata.height)) {
      return { reason: 'svg-invalid', detail: 'the rasterizer reports no positive size for this document' };
    }
    return { width: metadata.width, height: metadata.height };
  } catch (error) {
    return classifyRenderError(error);
  }
}

/**
 * The logical size the published picture should have, in CSS pixels.
 *
 * An absolute author size wins; a `viewBox`-only document is laid out at the
 * article width with its own aspect ratio. The natural size supplies the aspect
 * for a document that declares only one side.
 */
function logicalSize(source: SvgSource, natural: ImageDimensions, limits: SvgRenderLimits): ImageDimensions {
  const aspect = natural.width / natural.height;
  if (source.declaredSize) {
    const width = source.width ?? source.height! * aspect;
    const height = source.height ?? source.width! / aspect;
    return { width, height };
  }
  return { width: limits.logicalWidth, height: limits.logicalWidth / aspect };
}

/**
 * The output size: 2× logical, then proportionally clamped.
 *
 * Floor rather than round, so the product can only shrink; `Math.max(1, …)`
 * keeps a degenerate aspect from producing a zero-pixel side. There is no crop
 * and no independent axis decision — both sides take one scale factor.
 */
function outputSize(logical: ImageDimensions, limits: SvgRenderLimits): ImageDimensions {
  const desiredWidth = logical.width * limits.density;
  const desiredHeight = logical.height * limits.density;
  const scale = Math.min(
    1,
    Math.sqrt(limits.maxOutputPixels / (desiredWidth * desiredHeight)),
    limits.maxOutputSide / Math.max(desiredWidth, desiredHeight),
  );
  return {
    width: Math.max(1, Math.floor(desiredWidth * scale)),
    height: Math.max(1, Math.floor(desiredHeight * scale)),
  };
}

/**
 * Whether every visible character has a host glyph.
 *
 * Pango draws a hex box containing the code point when no font covers it, so a
 * missing label is neither blank nor pixel-comparable across code points: measured
 * on this host, U+10FFF0 and U+E000 render boxes reading `10FFF0` and `E000`.
 * `font-coverage.ts` therefore asks the same question fontconfig answers — is the
 * code point in any installed font's `cmap` — and this function turns its answer
 * into the private diagnostic.
 */
function fontCoverageRefusal(characters: readonly string[]): SvgRefusal | undefined {
  if (characters.length === 0) return undefined;
  const codePoints = characters.map((character) => character.codePointAt(0)!);
  const coverage = missingCodePoints(codePoints);
  if (coverage.missing.length === 0) return undefined;
  const labels = coverage.missing
    .slice(0, 5)
    .map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
  const more = coverage.missing.length > labels.length ? ` and ${coverage.missing.length - labels.length} more` : '';
  const fonts = coverage.fonts === 0
    ? 'no font files were found on this host'
    : `${coverage.fonts} installed font files were searched`;
  return {
    reason: 'svg-font',
    detail: `no installed font covers ${labels.join(', ')}${more}; ${fonts}. Install a font with those glyphs or convert the labels to outlines.`,
  };
}

/** The render density that makes librsvg produce at least `targetWidth` pixels. */
function densityFor(targetWidth: number, natural: ImageDimensions, source: SvgSource): number {
  if (source.sizeScale === 'physical') {
    // render = natural × (density / 72)²
    return 72 * Math.sqrt(targetWidth / natural.width);
  }
  return (72 * targetWidth) / natural.width;
}

/**
 * Render one accepted SVG document and publish its lossless WebP bytes.
 *
 * @param bytes The exact bytes the walk authorized; never re-read from a path.
 */
export async function prepareSvg(
  bytes: Buffer,
  limits: SvgRenderLimits = SVG_RENDER_LIMITS,
): Promise<PrepareResult> {
  if (bytes.length > limits.maxSourceBytes) {
    return { ok: false, reason: 'too-large', detail: `the SVG is larger than ${limits.maxSourceBytes} bytes` };
  }

  const inspection = inspectSvg(bytes);
  if (!inspection.ok) return failed(inspection.refusal);
  const source = inspection.source;

  const natural = await naturalSize(bytes, limits);
  if ('reason' in natural) return failed(natural);

  const characters = requiredCharacters(source);
  if (!Array.isArray(characters)) return failed(characters);
  const coverage = fontCoverageRefusal(characters);
  if (coverage !== undefined) return failed(coverage);

  const logical = logicalSize(source, natural, limits);
  const output = outputSize(logical, limits);
  const logicalAspect = logical.width / logical.height;
  // Flooring each side can cost at most one pixel, and the target is the
  // author's logical size — not the 72-dpi measurement, whose physical-unit
  // rounding is a coarse approximation that grows with the output. A genuine
  // shape change misses both bounds by far more than one pixel.
  const heightError = Math.abs(output.height - output.width / logicalAspect);
  const widthError = Math.abs(output.width - output.height * logicalAspect);
  if (heightError > 1 + output.height * 0.01 && widthError > 1 + output.width * 0.01) {
    return failed({
      reason: 'svg-workload',
      detail: `the clamped output ${output.width}×${output.height} would change the document's aspect ratio`,
    });
  }

  // Over-render by 8% + 4 px so the final resize is always a downscale; rounding
  // in librsvg's own size report cannot turn the target into an upscale.
  const targetRenderWidth = output.width * 1.08 + 4;
  const density = densityFor(targetRenderWidth, natural, source);
  if (!Number.isFinite(density) || density < 1 || density > SHARP_MAX_DENSITY) {
    return failed({
      reason: 'svg-workload',
      detail: `a density of ${density.toFixed(2)} is outside sharp's 1–${SHARP_MAX_DENSITY} range`,
    });
  }
  const predictedRenderPixels = targetRenderWidth * targetRenderWidth * (natural.height / natural.width);
  if (predictedRenderPixels > limits.maxRenderPixels) {
    return failed({
      reason: 'svg-workload',
      detail: `the render surface would exceed ${limits.maxRenderPixels} pixels`,
    });
  }

  let encoded: Buffer;
  try {
    encoded = await withinDeadline(
      sharp(bytes, renderOptions(density, limits))
        .resize(output.width, output.height, { fit: 'fill' })
        .ensureAlpha()
        .webp({ lossless: true, ...ENCODER_SETTINGS.lossless })
        .toBuffer(),
      MEDIA_LIMITS.encodeTimeoutMs,
    );
  } catch (error) {
    return failed(classifyRenderError(error));
  }
  if (encoded.length === 0) {
    return { ok: false, reason: 'encode-failed', detail: 'the encoder returned no bytes' };
  }

  let emitted: Metadata;
  try {
    emitted = await withinDeadline(sharp(encoded).metadata(), MEDIA_LIMITS.decodeTimeoutMs);
  } catch (error) {
    return failed(classifyRenderError(error));
  }
  if (emitted.format !== 'webp') {
    return { ok: false, reason: 'encode-failed', detail: `the encoder emitted ${emitted.format}, not WebP` };
  }
  if (emitted.width !== output.width || emitted.height !== output.height) {
    return {
      ok: false,
      reason: 'encode-failed',
      detail: `the encoder emitted ${emitted.width}×${emitted.height}, not ${output.width}×${output.height}`,
    };
  }
  if ((emitted.pages ?? 1) > 1) {
    return { ok: false, reason: 'encode-failed', detail: 'the encoder emitted an animation' };
  }
  if (emitted.orientation !== undefined && emitted.orientation !== 1) {
    return { ok: false, reason: 'encode-failed', detail: 'the encoder emitted a rotated image' };
  }

  // WebP lossless drops the alpha channel when every pixel is opaque, so a
  // decoded image with three channels is fully visible. A decoded image with four
  // channels whose alpha mean is zero is a render that drew nothing — an
  // intentionally empty SVG is refused here rather than published as a blank.
  // Only an image that carries alpha needs the extra decode.
  if (emitted.hasAlpha === true) {
    let stats: Stats;
    try {
      stats = await withinDeadline(sharp(encoded).stats(), MEDIA_LIMITS.decodeTimeoutMs);
    } catch (error) {
      return failed(classifyRenderError(error));
    }
    const alpha = stats.channels[3];
    if (alpha === undefined || alpha.mean === 0) {
      return failed({ reason: 'svg-empty', detail: 'every rendered pixel is fully transparent' });
    }
  }

  // 0010's reader owns the published pair, and it reads the emitted bytes. The
  // layout size is the emitted pair divided by the target density: a 600-pixel
  // diagram is published as a 1,200-pixel WebP and laid out at 600 CSS pixels, so
  // a 2× display uses the extra pixels instead of doubling the picture. When the
  // output budget clamps the raster, the layout shrinks with it (the emitted
  // pair / 2), never upscales it.
  const dimensions = imageDimensions(encoded, 'webp');
  if (dimensions === undefined) {
    return { ok: false, reason: 'encode-failed', detail: 'the emitted WebP declares no readable size' };
  }
  const displayDimensions = {
    width: Math.max(1, Math.round(dimensions.width / limits.density)),
    height: Math.max(1, Math.round(dimensions.height / limits.density)),
  };
  return {
    ok: true,
    image: {
      bytes: encoded,
      format: 'webp',
      dimensions,
      displayDimensions,
      transcoded: true,
    },
  };
}
