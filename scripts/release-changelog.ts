/**
 * Promotes `CHANGELOG.md`'s `[Unreleased]` section to the version being released.
 *
 * The one-click release (`.github/workflows/release.yml`) derives the version
 * from a bump level, so the heading cannot be written by hand before the click:
 * whoever starts the run has not yet decided whether it is 0.0.2 or 0.1.0. This
 * module closes that gap.
 *
 * It is a module rather than a `node -e` in the YAML for two reasons. The same
 * promotion runs twice — once in the read-only job with `--check`, so a bad
 * CHANGELOG stops the run before anything reaches `main`, and once in the job
 * that holds the write token — and duplication is how two copies disagree. And
 * the shape it produces is a property worth holding still:
 * `tests/release-changelog.test.ts` asserts that nothing but the heading and one
 * link definition moves.
 *
 * Two refusals are deliberate. An `[Unreleased]` section with no `- ` entry
 * fails, because a release with no notes is a mistake rather than an empty
 * changelog. A version that already has a heading fails, because the run is
 * then promoting a release that exists.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHANGELOG = join(ROOT, 'CHANGELOG.md');
const UNRELEASED = '## [Unreleased]';
const RELEASED_HEADING = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/;

export interface Promotion {
  /** The version being released, without the `v` prefix. */
  version: string;
  /** The release date, `YYYY-MM-DD`. */
  date: string;
  /** Repository base URL, no trailing slash: `https://github.com/owner/repo`. */
  url: string;
}

/**
 * Return `text` with `[Unreleased]` promoted to `version`, or throw.
 *
 * The new heading sits directly under an empty `[Unreleased]`, and the released
 * body stays exactly where it was — the diff a reviewer reads is one heading
 * plus one link, not a reordered file.
 */
export function promoteUnreleased(text: string, promotion: Promotion): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === UNRELEASED);
  if (start < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" heading`);

  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith('## [')) end += 1;
  const body = lines.slice(start + 1, end);

  if (!body.some((line) => line.startsWith('- '))) {
    throw new Error('the Unreleased section has no entries, so there is nothing to release');
  }
  if (text.includes(`## [${promotion.version}]`)) {
    throw new Error(`CHANGELOG.md already has a section for ${promotion.version}`);
  }

  const previous = RELEASED_HEADING.exec(lines.slice(end).join('\n'))?.[1];
  const promoted = [
    ...lines.slice(0, start),
    UNRELEASED,
    '',
    `## [${promotion.version}] - ${promotion.date}`,
    ...body,
    ...lines.slice(end),
  ];

  const link = promoted.findIndex((line) => line.startsWith('[Unreleased]:'));
  if (link < 0) throw new Error('CHANGELOG.md has no "[Unreleased]:" link definition');
  promoted.splice(
    link + 1,
    0,
    previous === undefined
      ? `[${promotion.version}]: ${promotion.url}/releases/tag/v${promotion.version}`
      : `[${promotion.version}]: ${promotion.url}/compare/v${previous}...v${promotion.version}`,
  );

  return promoted.join('\n');
}

/** The repository URL a CHANGELOG link can be built from. */
function repositoryUrl(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    repository?: { url?: string };
  };
  const raw = manifest.repository?.url;
  if (raw === undefined) {
    throw new Error('package.json has no repository.url, so the CHANGELOG link has no base');
  }
  return raw.replace(/^git\+/, '').replace(/\.git$/, '');
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const version = args.find((argument) => !argument.startsWith('--'));
  try {
    if (version === undefined || !SEMVER.test(version)) {
      throw new Error('usage: node scripts/release-changelog.ts <version> [--check]');
    }
    const promoted = promoteUnreleased(readFileSync(CHANGELOG, 'utf8'), {
      version,
      date: new Date().toISOString().slice(0, 10),
      url: repositoryUrl(),
    });
    if (check) {
      console.log(`changelog ok: ${version} would be promoted out of Unreleased`);
    } else {
      writeFileSync(CHANGELOG, promoted, 'utf8');
      console.log(`changelog promoted to ${version}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
