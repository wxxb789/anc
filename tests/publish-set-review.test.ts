import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import {
  assertPublishSetReviewed,
  PUBLISH_SET_REVIEW_FILE,
  writePublishSetReview,
} from '../scripts/publish-set-review.ts';
import { BuildFailure } from '../scripts/write-report.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function runGit(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'publish-set-review-'));
  roots.push(root);
  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.name', 'Review Test']);
  runGit(root, ['config', 'user.email', 'review@example.invalid']);
  return root;
}

function commitReview(root: string): void {
  runGit(root, ['add', '--', PUBLISH_SET_REVIEW_FILE]);
  runGit(root, ['commit', '--quiet', '-m', 'review publish set']);
}

function failure(action: () => void): BuildFailure {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof BuildFailure, 'expected a disclosure-checked BuildFailure');
    return error;
  }
  assert.fail('expected the publish-set review gate to fail');
}

test('review writes one sorted public-slug ledger and a committed exact set passes', () => {
  const root = repository();
  assert.equal(writePublishSetReview(root, ['zeta', 'alpha', 'alpha']), 2);
  assert.deepEqual(JSON.parse(readFileSync(join(root, PUBLISH_SET_REVIEW_FILE), 'utf8')), {
    version: 1,
    slugs: ['alpha', 'zeta'],
  });
  assert.equal(failure(() => assertPublishSetReviewed(root, ['alpha', 'zeta'])).code, 'publish-set-review-uncommitted');
  commitReview(root);
  assert.doesNotThrow(() => assertPublishSetReviewed(root, ['zeta', 'alpha']));
});

test('the ledger accepts Unicode slugs and stores them in canonical code point order', () => {
  // Red against the ASCII-only ledger grammar: `日记-今天` was refused as an
  // invalid slug, so a CJK note could never pass release review.
  const root = repository();
  const astral = '\u{20000}';
  assert.equal(writePublishSetReview(root, ['日记-今天', 'ａ', astral, 'projects-观点', 'alpha']), 5);
  assert.deepEqual(JSON.parse(readFileSync(join(root, PUBLISH_SET_REVIEW_FILE), 'utf8')).slugs, [
    'alpha',
    'projects-观点',
    '日记-今天',
    'ａ',
    astral,
  ]);
  commitReview(root);
  assert.doesNotThrow(() => assertPublishSetReviewed(root, [astral, '日记-今天', 'ａ', 'projects-观点', 'alpha']));
});

test('release fails closed when the ledger is missing, untracked, staged, or modified', () => {
  const root = repository();
  assert.equal(failure(() => assertPublishSetReviewed(root, ['alpha'])).code, 'publish-set-review-missing');

  writePublishSetReview(root, ['alpha']);
  assert.equal(failure(() => assertPublishSetReviewed(root, ['alpha'])).code, 'publish-set-review-uncommitted');
  commitReview(root);

  writeFileSync(join(root, PUBLISH_SET_REVIEW_FILE), '{\n  "version": 1,\n  "slugs": ["alpha"]\n}\n\n', 'utf8');
  assert.equal(failure(() => assertPublishSetReviewed(root, ['alpha'])).code, 'publish-set-review-uncommitted');
  runGit(root, ['add', '--', PUBLISH_SET_REVIEW_FILE]);
  assert.equal(failure(() => assertPublishSetReviewed(root, ['alpha'])).code, 'publish-set-review-uncommitted');
});

test('release reports only counts while private detail names additions and removals', () => {
  const root = repository();
  writePublishSetReview(root, ['alpha', 'formerly-public']);
  commitReview(root);

  const error = failure(() => assertPublishSetReviewed(root, ['alpha', 'newly-public']));
  assert.equal(error.code, 'publish-set-review-changed');
  assert.match(error.message, /1 added, 1 removed/);
  assert.ok(!error.message.includes('formerly-public'));
  assert.ok(!error.message.includes('newly-public'));
  assert.match(error.detail, /formerly-public/);
  assert.match(error.detail, /newly-public/);
});

test('shrinking the committed ledger makes a later re-inclusion a new addition', () => {
  const root = repository();
  writePublishSetReview(root, ['alpha', 'beta']);
  commitReview(root);

  const removal = failure(() => assertPublishSetReviewed(root, ['alpha']));
  assert.match(removal.message, /0 added, 1 removed/);

  writePublishSetReview(root, ['alpha']);
  commitReview(root);
  const reinclusion = failure(() => assertPublishSetReviewed(root, ['alpha', 'beta']));
  assert.match(reinclusion.message, /1 added, 0 removed/);
});

test('malformed ledgers fail as unreadable approval rather than as an empty set', () => {
  const root = repository();
  const invalid = [
    'not json',
    '{}',
    '{"version":2,"slugs":[]}',
    '{"version":1,"slugs":{},"extra":true}',
    '{"version":1,"slugs":["beta","alpha"]}',
    '{"version":1,"slugs":["alpha","alpha"]}',
    '{"version":1,"slugs":["Not-A-Slug"]}',
  ];
  for (const text of invalid) {
    writeFileSync(join(root, PUBLISH_SET_REVIEW_FILE), text, 'utf8');
    assert.equal(failure(() => assertPublishSetReviewed(root, [])).code, 'publish-set-review-invalid');
  }
});

test('review refuses an ignored ledger before claiming it was written', () => {
  const root = repository();
  writeFileSync(join(root, '.gitignore'), '*.json\n', 'utf8');
  const error = failure(() => writePublishSetReview(root, ['alpha']));
  assert.equal(error.code, 'publish-set-review-ignored');
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '*.json\n');
});

test('review refuses a directory where the ledger file must be', () => {
  const root = repository();
  mkdirSync(join(root, PUBLISH_SET_REVIEW_FILE));
  assert.equal(failure(() => writePublishSetReview(root, ['alpha'])).code, 'publish-set-review-invalid');
  assert.equal(failure(() => assertPublishSetReviewed(root, ['alpha'])).code, 'publish-set-review-invalid');
});

test('a review beside a nested content directory is tracked from the repository root', () => {
  const root = repository();
  const notes = join(root, 'notes');
  mkdirSync(notes);
  writePublishSetReview(notes, ['alpha']);
  runGit(root, ['add', '--', 'notes/' + PUBLISH_SET_REVIEW_FILE]);
  runGit(root, ['commit', '--quiet', '-m', 'review nested publish set']);
  assert.doesNotThrow(() => assertPublishSetReviewed(notes, ['alpha']));
});

test('review refuses a directory outside git because approval cannot be committed', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-set-no-git-'));
  roots.push(root);
  // A broken local gitfile stops discovery from borrowing any repository that
  // happens to contain the host's temporary directory.
  writeFileSync(join(root, '.git'), 'not a gitdir\n', 'utf8');
  assert.equal(failure(() => writePublishSetReview(root, ['alpha'])).code, 'publish-set-review-needs-git');
});
