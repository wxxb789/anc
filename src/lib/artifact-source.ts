/**
 * Which artifact file this build reads.
 *
 * The default is the exporter-generated `src/data/content.json`. Setting
 * `CONTENT_ARTIFACT` to another path — `npm run build:fixture` does exactly
 * that — builds the whole site from a different artifact without touching the
 * generated one, which the agent contract forbids editing by hand.
 *
 * Every consumer resolves the path through here rather than hardcoding it, so
 * the build gate, the redirect emitter, the pages, and the tests over `dist/`
 * can never end up reading two different artifacts and agreeing about it.
 *
 * The path is resolved against `process.cwd()` rather than against
 * `import.meta.url`, and that is load-bearing: Astro bundles this module into
 * `dist/.prerender/`, so `import.meta.url` points inside the build output at
 * the moment the pages actually read it. `npm` runs every script with the
 * working directory set to the directory holding `package.json`, and Astro
 * resolves its own project root the same way — so cwd is the one anchor all
 * three consumers agree on.
 *
 * ponytail: this means the build must be started from the repository root. It
 * already had to be — `astro build` finds `astro.config.mjs` the same way.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateArtifact, type ContentArtifact } from './schema.ts';

const DEFAULT_ARTIFACT = 'src/data/content.json';

/**
 * Repository-relative path of the artifact, suitable for an error message.
 *
 * `||` rather than `??`: an empty `CONTENT_ARTIFACT` is a caller who meant to
 * pass a path and passed nothing. With `??` it would read as a fixture build,
 * silently skipping the index-projection gate before failing on a directory
 * read — a security gate turned off by an empty string.
 */
export const ARTIFACT_PATH: string = process.env['CONTENT_ARTIFACT'] || DEFAULT_ARTIFACT;

/**
 * Whether this build reads a fixture corpus rather than the published one.
 *
 * Compared as resolved paths, not as strings: `./src/data/content.json` names
 * the published artifact while differing from the default spelling, and a
 * string comparison would call that a fixture build — silently skipping the
 * index-projection gate on the real artifact. That gate is a privacy check, so
 * the failure mode is a disabled privacy check with a reassuring log line.
 */
export const IS_FIXTURE_ARTIFACT: boolean =
  resolve(process.cwd(), ARTIFACT_PATH) !== resolve(process.cwd(), DEFAULT_ARTIFACT);

/**
 * Absolute filesystem path to the artifact, anchored at the repository root.
 *
 * `path.resolve` rather than a hand-built `file://` URL: a URL parses `#` and
 * `?` in the *directory* name as a fragment and a query, so a checkout under
 * `Q:/re#po` silently resolves to the drive root, and it percent-decodes, so a
 * literal `%20` in a path becomes a space. Neither is hypothetical on a machine
 * whose worktrees live under generated directory names.
 *
 * A function rather than a constant so a test can change `CONTENT_ARTIFACT` and
 * see the effect without re-importing the module.
 */
export function artifactPath(): string {
  return resolve(process.cwd(), ARTIFACT_PATH);
}

/**
 * The artifact's raw bytes, exactly as they are on disk.
 *
 * Returned as text rather than parsed because two callers need the bytes
 * themselves: `emit-redirects.ts` hashes them into the redirect map's
 * `content_version`, and `built-routes.test.ts` recomputes that hash to prove
 * the map came from the artifact `dist/` was built from.
 */
export function readArtifact(): string {
  return readFileSync(artifactPath(), 'utf8');
}

/**
 * The validated artifact, read from whichever file this build selected.
 *
 * One place where read, parse, and validate happen together, because three
 * callers were doing all three and a fourth would have got the error label
 * subtly wrong. Every caller sees an artifact that has already passed the
 * contract, and a violation names the file it actually came from.
 */
export function loadArtifact(): ContentArtifact {
  return validateArtifact(JSON.parse(readArtifact()), ARTIFACT_PATH);
}
