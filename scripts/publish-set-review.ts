/**
 * A committed review of the exact public note set used by release builds.
 *
 * The ledger contains public slugs, never source paths or withheld names. Exact
 * equality is deliberate: a note that is published, excluded, then re-included
 * must become an addition again instead of inheriting stale authorization.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BuildFailure } from './write-report.ts';

export const PUBLISH_SET_REVIEW_FILE = '.publish-set.json';
const REVIEW_VERSION = 1;
const MAX_REVIEW_BYTES = 1_048_576;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface PublishSetReview {
  version: 1;
  slugs: string[];
}

function canonicalSlugs(slugs: readonly string[]): string[] {
  const unique = [...new Set(slugs)];
  for (const slug of unique) {
    if (!SLUG.test(slug)) {
      throw new BuildFailure(
        'publish-set-review-invalid',
        'publish-set review is invalid; run thoughtscape-publish review again',
        'computed publish set contains an invalid slug: ' + JSON.stringify(slug),
      );
    }
  }
  return unique.sort();
}

function invalidReview(detail: string): never {
  throw new BuildFailure(
    'publish-set-review-invalid',
    'release blocked: .publish-set.json is invalid; run thoughtscape-publish review again',
    detail,
  );
}

function parseReview(text: string): PublishSetReview {
  if (Buffer.byteLength(text, 'utf8') > MAX_REVIEW_BYTES) invalidReview('publish-set review exceeds 1 MiB');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalidReview('publish-set review is not JSON: ' + String(error));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidReview('publish-set review must be an object');
  }
  const table = value as Record<string, unknown>;
  const keys = Object.keys(table).sort();
  if (keys.length !== 2 || keys[0] !== 'slugs' || keys[1] !== 'version') {
    invalidReview('publish-set review must contain exactly version and slugs');
  }
  if (table['version'] !== REVIEW_VERSION) invalidReview('publish-set review has an unsupported version');
  if (!Array.isArray(table['slugs'])) invalidReview('publish-set review slugs must be an array');
  const slugs = table['slugs'];
  if (!slugs.every((slug): slug is string => typeof slug === 'string' && SLUG.test(slug))) {
    invalidReview('publish-set review contains an invalid slug');
  }
  const canonical = canonicalSlugs(slugs);
  if (canonical.length !== slugs.length || canonical.some((slug, index) => slug !== slugs[index])) {
    invalidReview('publish-set review slugs must be sorted and unique');
  }
  return { version: REVIEW_VERSION, slugs };
}

function git(directory: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
}

function gitDetail(command: string, result: SpawnSyncReturns<string>): string {
  return [
    command,
    'status=' + String(result.status),
    result.error?.stack ?? '',
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n');
}

function assertGitRepository(directory: string): void {
  const result = git(directory, ['rev-parse', '--is-inside-work-tree']);
  if (result.status !== 0 || result.stdout.trim() !== 'true') {
    throw new BuildFailure(
      'publish-set-review-needs-git',
      'publish-set review requires a git repository so approval can be committed',
      gitDetail('git rev-parse --is-inside-work-tree', result),
    );
  }
}

function assertReviewNotIgnored(directory: string): void {
  const result = git(directory, ['check-ignore', '--quiet', '--', PUBLISH_SET_REVIEW_FILE]);
  if (result.status === 0) {
    throw new BuildFailure(
      'publish-set-review-ignored',
      'publish-set review is ignored by git; unignore .publish-set.json before reviewing',
      gitDetail('git check-ignore', result),
    );
  }
  if (result.status !== 1) {
    throw new BuildFailure(
      'publish-set-review-needs-git',
      'publish-set review could not verify git ignore rules',
      gitDetail('git check-ignore', result),
    );
  }
}

function reviewFileIsRegular(directory: string): boolean {
  try {
    return lstatSync(join(directory, PUBLISH_SET_REVIEW_FILE)).isFile();
  } catch {
    return false;
  }
}

function assertCommitted(directory: string): void {
  const tracked = git(directory, ['ls-files', '--error-unmatch', '--', PUBLISH_SET_REVIEW_FILE]);
  const unstaged = git(directory, ['diff', '--quiet', '--', PUBLISH_SET_REVIEW_FILE]);
  const staged = git(directory, ['diff', '--cached', '--quiet', '--', PUBLISH_SET_REVIEW_FILE]);
  if (tracked.status !== 0 || unstaged.status !== 0 || staged.status !== 0) {
    throw new BuildFailure(
      'publish-set-review-uncommitted',
      'release blocked: .publish-set.json must be committed and unchanged',
      [
        gitDetail('git ls-files', tracked),
        gitDetail('git diff', unstaged),
        gitDetail('git diff --cached', staged),
      ].join('\n'),
    );
  }
}

/** Write the current candidate set. A release still refuses it until committed. */
export function writePublishSetReview(directory: string, slugs: readonly string[]): number {
  assertGitRepository(directory);
  assertReviewNotIgnored(directory);
  const path = join(directory, PUBLISH_SET_REVIEW_FILE);
  try {
    const state = lstatSync(path);
    if (!state.isFile()) invalidReview('publish-set review path is not a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const review: PublishSetReview = { version: REVIEW_VERSION, slugs: canonicalSlugs(slugs) };
  writeFileSync(join(directory, PUBLISH_SET_REVIEW_FILE), JSON.stringify(review, null, 2) + '\n', 'utf8');
  return review.slugs.length;
}

/** Require one committed ledger exactly equal to the computed public note set. */
export function assertPublishSetReviewed(directory: string, slugs: readonly string[]): void {
  assertGitRepository(directory);
  if (!reviewFileIsRegular(directory)) {
    try {
      lstatSync(join(directory, PUBLISH_SET_REVIEW_FILE));
      invalidReview('publish-set review path is not a regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let reviewText: string;
  try {
    reviewText = readFileSync(join(directory, PUBLISH_SET_REVIEW_FILE), 'utf8');
  } catch (error) {
    throw new BuildFailure(
      'publish-set-review-missing',
      'release blocked: no reviewed publish set; run thoughtscape-publish review and commit it',
      'could not read ' + PUBLISH_SET_REVIEW_FILE + ': ' + String(error),
    );
  }
  const reviewed = parseReview(reviewText).slugs;
  const current = canonicalSlugs(slugs);
  const reviewedSet = new Set(reviewed);
  const currentSet = new Set(current);
  const added = current.filter((slug) => !reviewedSet.has(slug));
  const removed = reviewed.filter((slug) => !currentSet.has(slug));
  if (added.length > 0 || removed.length > 0) {
    throw new BuildFailure(
      'publish-set-review-changed',
      'release blocked: publish set changed (' + added.length + ' added, ' + removed.length +
        ' removed); run thoughtscape-publish review, inspect the diff, and commit it',
      JSON.stringify({ added, removed }),
    );
  }
  assertCommitted(directory);
}
