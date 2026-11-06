/**
 * `scripts/release-changelog.ts` rewrites the one file a release must change
 * besides the manifest, on the one click that cannot know its version ahead of
 * time. The property that matters is narrowness: a release commit should be one
 * heading and one link, so a reviewer reading the diff sees the notes that ship
 * and nothing else.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { promoteUnreleased } from '../scripts/release-changelog.ts';

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Changed',
  '',
  '- The release job writes this section.',
  '',
  '## [0.0.1] - 2026-01-02',
  '',
  '- First version.',
  '',
  '[Unreleased]: https://github.com/owner/repo/commits/main',
  '[0.0.1]: https://github.com/owner/repo/commit/abc1234',
  '',
].join('\n');

const PROMOTION = { version: '0.0.2', date: '2026-02-03', url: 'https://github.com/owner/repo' };

test('the released body stays where it was and a new empty Unreleased stays above it', () => {
  const promoted = promoteUnreleased(CHANGELOG, PROMOTION);

  assert.ok(
    promoted.includes('## [Unreleased]\n\n## [0.0.2] - 2026-02-03\n\n### Changed\n\n- The release job writes this section.'),
    `the section was not promoted in place:\n${promoted}`,
  );
  assert.ok(promoted.includes('## [0.0.1] - 2026-01-02'), 'the previous release heading moved');
  assert.ok(promoted.includes('- First version.'), 'the previous release body moved');
});

test('a compare link is added between Unreleased and the previous release', () => {
  const lines = promoteUnreleased(CHANGELOG, PROMOTION).split('\n');
  const unreleased = lines.indexOf('[Unreleased]: https://github.com/owner/repo/commits/main');

  assert.equal(
    lines[unreleased + 1],
    '[0.0.2]: https://github.com/owner/repo/compare/v0.0.1...v0.0.2',
    'the new version link does not compare from the previous release',
  );
  assert.equal(lines[unreleased + 2], '[0.0.1]: https://github.com/owner/repo/commit/abc1234');
});

test('the first release links to its tag rather than a comparison', () => {
  const first = [
    '## [Unreleased]',
    '',
    '- First release.',
    '',
    '[Unreleased]: https://github.com/owner/repo/commits/main',
    '',
  ].join('\n');

  assert.ok(
    promoteUnreleased(first, PROMOTION).includes(
      '[0.0.2]: https://github.com/owner/repo/releases/tag/v0.0.2',
    ),
    'a first release invented a previous version to compare against',
  );
});

test('nothing but the heading and the link definition changes', () => {
  const promoted = promoteUnreleased(CHANGELOG, PROMOTION).split('\n');
  const heading = promoted.indexOf('## [0.0.2] - 2026-02-03');
  assert.ok(heading > 0, 'the promotion produced no heading');

  promoted.splice(heading, 2);
  const link = promoted.findIndex((line) => line.startsWith('[0.0.2]:'));
  assert.ok(link > 0, 'the promotion produced no link definition');
  promoted.splice(link, 1);

  assert.equal(promoted.join('\n'), CHANGELOG, 'the promotion touched a line it should have left alone');
});

test('a CHANGELOG that cannot be promoted fails rather than releasing nothing', () => {
  assert.throws(() => promoteUnreleased(CHANGELOG.replace('## [Unreleased]', '## Notes'), PROMOTION), /no "## \[Unreleased\]" heading/);

  const empty = CHANGELOG.replace('- The release job writes this section.', 'Nothing to say.');
  assert.throws(() => promoteUnreleased(empty, PROMOTION), /no entries/);

  const already = CHANGELOG.replace('## [0.0.1]', '## [0.0.2]');
  assert.throws(() => promoteUnreleased(already, PROMOTION), /already has a section for 0\.0\.2/);
});
