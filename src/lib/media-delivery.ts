/**
 * Where a published image is delivered from, when the build was explicitly
 * opted into a managed image host.
 *
 * The artifact and the producer always speak the same-origin path
 * (`/_assets/<sha256>-<name>`); that path is the asset's identity. This module
 * is the only place the *delivery location* changes: when
 * `anc build --release --media r2` sets {@link MEDIA_BASE_URL_VARIABLE} before
 * Astro renders, `markdown.ts` prefixes each authorized asset with the
 * configured public custom-domain origin. No other consumer sees the absolute
 * form, so the output inventory, the artifact, the copy step, and the digest
 * checks keep comparing the one stable path.
 *
 * ## Why an environment variable
 *
 * `astro.config.mjs` and its pages are evaluated by Astro after the CLI has
 * changed the working directory to this package's root. The CLI already
 * crosses that boundary with `PUBLISH_CONFIG_DIR`, `CONTENT_ARTIFACT`, and
 * `SNAPSHOT_WORKSPACE`, and there is no function argument available for the
 * same reason: nothing in this repository calls the page module directly. An
 * environment variable is the seam, and it is set only for the opted-in build.
 *
 * ## Why the value is validated again
 *
 * It comes from a configuration table the loader already validated, so a
 * malformed value here is a defect rather than a user mistake. It is still
 * checked: a renderer that concatenated an arbitrary string into `src` would
 * be one environment variable away from emitting a `javascript:` URL or a
 * non-HTTPS image, and the image sanitizer's scheme allowlist runs *before*
 * this rewrite. Failing closed here is cheaper than teaching the sanitizer
 * about a second pass.
 */

/** The environment variable naming the public media origin, when opted in. */
export const MEDIA_BASE_URL_VARIABLE = 'PUBLISH_MEDIA_BASE_URL';

/**
 * The bare HTTPS origin images are delivered from, or `undefined` for the
 * ordinary same-origin build.
 *
 * Empty is absent: a shell unsets a variable for one command by setting it
 * empty, which is the same convention `artifact-source.ts` uses.
 */
export function mediaDeliveryOrigin(): string | undefined {
  const value = process.env[MEDIA_BASE_URL_VARIABLE];
  if (value === undefined || value === '') return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('the media delivery origin is not an absolute URL');
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('the media delivery origin must be a bare HTTPS origin with no credentials');
  }

  return url.origin;
}

/**
 * The absolute HTTPS URL a reader fetches for a published asset path.
 *
 * `assetPath` is the artifact's canonical `/_assets/...` path. Concatenation
 * rather than `new URL()` is deliberate: `URL` would normalize percent-encoded
 * bytes into a second spelling, and the path's canonical encoding is what the
 * object key, the staged filename, and the output inventory all agree on.
 */
export function deliveredMediaUrl(assetPath: string, origin: string): string {
  if (!assetPath.startsWith('/')) {
    throw new Error('a delivered media path must be root-absolute');
  }
  return `${origin}${assetPath}`;
}
