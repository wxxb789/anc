/**
 * Which artifact file this build reads.
 *
 * The default is the exporter-generated `src/data/content.json`. Setting
 * `CONTENT_ARTIFACT` to another path — `pnpm run build:fixture` does exactly
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
 * the moment the pages actually read it. `pnpm` runs every script with the
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
 * Whether a path names the published artifact rather than a substitute.
 *
 * Compared as resolved paths, not as strings: `./src/data/content.json` names
 * the published artifact while differing from the default spelling, and a
 * string comparison would call that a substitute — silently skipping the
 * index-projection gate on the real artifact. That gate is a privacy check, so
 * the failure mode is a disabled privacy check with a reassuring log line.
 *
 * Takes a path rather than reading {@link ARTIFACT_PATH} only, because a build
 * selects its artifact through the environment while `validate-content.ts` may
 * also be pointed at a candidate file by argument. Both are the same question,
 * and answering it in two places is how the two answers drift apart.
 */
export function isPublishedArtifact(path: string = ARTIFACT_PATH): boolean {
  return resolve(process.cwd(), path) === resolve(process.cwd(), DEFAULT_ARTIFACT);
}

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
export function artifactPath(path: string = ARTIFACT_PATH): string {
  return resolve(process.cwd(), path);
}

/**
 * The artifact's raw bytes, exactly as they are on disk.
 *
 * Returned as text rather than parsed because two callers need the bytes
 * themselves: `emit-redirects.ts` hashes them into the redirect map's
 * `content_version`, and `built-routes.test.ts` recomputes that hash to prove
 * the map came from the artifact `dist/` was built from.
 */
export function readArtifact(path: string = ARTIFACT_PATH): string {
  return readFileSync(artifactPath(path), 'utf8');
}

/**
 * The validated artifact, read from whichever file this build selected.
 *
 * One place where read, parse, and validate happen together, because three
 * callers were doing all three and a fourth would have got the error label
 * subtly wrong. Every caller sees an artifact that has already passed the
 * contract, and a violation names the file it actually came from.
 */
export function loadArtifact(path: string = ARTIFACT_PATH): ContentArtifact {
  return validateArtifact(JSON.parse(readArtifact(path)), path);
}
