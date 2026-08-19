/**
 * Build gate for the generated content artifact pair.
 *
 * Runs before `astro build` so an invalid or privacy-violating artifact fails
 * with a precise message instead of a bundler stack trace. Also proves that
 * `public/content-index.json` is still an exact public projection of
 * `src/data/content.json`, since the index ships to the browser on its own.
 *
 * Everything downstream of `astro build` that can *throw* is exercised here
 * too. The build is a `&&` chain — validate, build, emit redirects, index with
 * Pagefind — so a throw in a later link leaves a `dist/` that is already
 * written and now permanently incomplete, which `pnpm run preview` serves
 * happily. Running those computations against the same artifact first means the
 * failure happens while `dist/` is still the last known good build.
 *
 * A fixture build (`CONTENT_ARTIFACT=…`, i.e. `pnpm run build:fixture`) reads
 * that artifact instead, as does a caller passing a candidate path. The
 * index-projection check is skipped there and only there:
 * `public/content-index.json` is the projection of the *published* artifact,
 * and comparing it against a fixture would fail for the one reason that is not
 * a defect. Every other gate still runs, and the skip is announced rather than
 * silent.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ContentValidationError, type ContentArtifact } from '../src/lib/schema.ts';
import { REDIRECT_RULES, collectionFacets, renderRedirects, tagFacets } from '../src/lib/routes.ts';
import {
  ARTIFACT_PATH,
  isPublishedArtifact,
  loadArtifact,
  readArtifact,
} from '../src/lib/artifact-source.ts';

const INDEX = new URL('../public/content-index.json', import.meta.url);

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The public preview index carries summary fields plus optional aliases. */
export function projectIndex(artifact: ContentArtifact) {
  return {
    version: artifact.version,
    entries: artifact.entries.map(({ slug, title, excerpt, aliases }) => ({
      slug,
      title,
      excerpt,
      ...(aliases === undefined ? {} : { aliases }),
    })),
  };
}

/**
 * The index ships to the browser on its own, so it must stay an exact projection
 * of the validated artifact rather than a separately generated file that could
 * drift. The comparison is key-order sensitive, which is the safe direction for
 * a privacy gate: a reordered index is a change in the exporter worth reviewing.
 */
export function checkIndexProjection(index: unknown, artifact: ContentArtifact): string[] {
  return JSON.stringify(index) === JSON.stringify(projectIndex(artifact))
    ? []
    : ['public/content-index.json: is not the exact public preview projection of src/data/content.json'];
}

/**
 * The artifact's content version: a hash of its bytes, so anything generated
 * from it can be tied back to the exact input (requirements section 20). The
 * artifact is already public, so its digest discloses nothing further.
 *
 * Exported because `emit-redirects.ts` stamps the same value into the file it
 * writes, and two independent hashes of the same bytes is one rename away from
 * two different stamps.
 */
export function contentVersion(source: string): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

/**
 * Run every artifact-derived computation that `astro build` and the steps after
 * it would otherwise run for the first time, and discard the results.
 *
 * `tagFacets` and `collectionFacets` throw on a label with no URL-safe route key
 * and on two labels colliding onto one key. Astro reaches them inside
 * `getStaticPaths()`, which is after `dist/` has been opened, so the failure
 * lands on a half-written directory. `renderRedirects` runs later still, in a
 * separate `&&` link after `astro build` has finished writing — and if it
 * throws, the chain stops before `pagefind --site dist` ever runs, leaving a
 * `dist/` with no search index that `pnpm run preview` serves happily.
 *
 * Running all three here moves every one of those failures ahead of the first
 * write, so a bad artifact leaves the previous good build intact.
 *
 * The results are deliberately unused: this is a gate, and recomputing what the
 * pages compute would make it a second source of truth for the route set.
 * `renderRedirects` has no failure path today — the rule set is empty and the
 * Cloudflare rule-count ceiling went with the legacy `/<slug>/` rules. It is
 * called anyway, because what this guards is the *ordering*: the emitter is a
 * separate link in the `&&` chain that runs after `dist/` is written, so the
 * day it can fail again is the day the guarantee is needed, and a call that
 * cannot throw costs a microsecond.
 */
export function checkDerivedRoutes(artifact: ContentArtifact, version: string): void {
  tagFacets(artifact.entries);
  collectionFacets(artifact.entries);
  renderRedirects(REDIRECT_RULES, { schema: artifact.version, content: version });
}

/**
 * Every gate this script runs, as one call, so a caller that is not the shell
 * enforces exactly what the shell does.
 *
 * `bin/thoughtscape-publish.mjs` runs the same chain in-process, and the failure
 * mode of letting it restate the steps is that the packaged build validates less
 * than this repository's own — a gate enforced on us and not on the people we
 * ship to. Calling one function means there is no second list to drift.
 *
 * @throws {ContentValidationError} or whichever error the derived-route
 *   computations raise, unchanged: the caller decides how to report it.
 */
export function validateBuildInputs(artifactPath: string = ARTIFACT_PATH): ContentArtifact {
  const artifact = loadArtifact(artifactPath);
  if (isPublishedArtifact(artifactPath)) {
    const issues = checkIndexProjection(readJson(INDEX), artifact);
    if (issues.length > 0) throw new ContentValidationError('public/content-index.json', issues);
  }
  checkDerivedRoutes(artifact, contentVersion(readArtifact(artifactPath)));
  return artifact;
}

/**
 * @param artifactPath Artifact to validate, repository-relative. Defaults to
 *   whichever one this build selected — `src/data/content.json` unless
 *   `CONTENT_ARTIFACT` names another. A caller passes a path so it can gate a
 *   candidate artifact without writing over `src/data/content.json`, which is
 *   exporter-owned generated content. The index projection is compared only
 *   when the artifact under test *is* the published one, since the index is its
 *   projection and nothing else's.
 */
function main(artifactPath: string = ARTIFACT_PATH): number {
  try {
    const artifact = validateBuildInputs(artifactPath);
    const published = isPublishedArtifact(artifactPath);
    console.log(
      `content ok: version=${artifact.version} entries=${artifact.entries.length}` +
        (published
          ? ''
          : ` source=${artifactPath} (not the published artifact; the content-index projection check does not apply)`),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
