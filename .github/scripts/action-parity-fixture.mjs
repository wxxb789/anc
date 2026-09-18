#!/usr/bin/env node
/**
 * Build the synthetic notes repository the Action-parity workflow publishes.
 *
 * This script and its sibling `assert-action-artifact.mjs` live in the
 * generator's own repository; the workflow checks that repository out under
 * `generator/` and runs them with `node` beside the notes it wrote. Everything
 * here is a literal, and it writes only inside the directory it is given.
 *
 * The corpus is deliberately the smallest one that still exercises the release
 * gates: two published notes with tags and a link between them, one note
 * withheld by frontmatter, one path excluded by pattern. The withheld bodies
 * carry markers the assertion step scans the finished `dist/` for, raw and
 * gzip-inflated.
 *
 * The reviewed ledger is written through the producer's own
 * `scripts/publish-set-review.ts`, not by hand: its schema, version, sorting,
 * and serialization get one home, and its dependency chain is Node builtins, so
 * importing it here does not need the install the Action performs later. The
 * `anc review` command itself is still not run here, because that CLI imports
 * the generator's dependencies; the tarball smoke (`scripts/smoke-tarball.ts`)
 * installs the package with npm and runs the real `init`/`review` commands. The
 * ledger remains a real gate: the Action always builds `--release`, whose
 * exact-set comparison refuses a ledger that does not name precisely the slugs
 * the producer computes.
 *
 * `git init` rather than a clone is what makes the shallow-clone refusal a
 * separate job: this repository has full history for the date derivation, and
 * the refusal control builds its own shallow clone on purpose.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePublishSetReview } from '../../scripts/publish-set-review.ts';

/** The repository root the workflow runs this against. */
const root = process.argv[2] ?? process.cwd();

function git(...args) {
  execFileSync('git', args, { cwd: root, stdio: 'inherit' });
}

function write(relative, lines) {
  writeFileSync(join(root, relative), lines.join('\n') + '\n', 'utf8');
}

write('publish.config.yaml', [
  'title: Parity Garden',
  'origin: https://notes.example.org/',
  'exclude:',
  '  - "generator/**"',
  '  - "drafts/**"',
]);

write('welcome.md', [
  '---',
  'tags: [garden]',
  '---',
  '# Welcome',
  '',
  'A public note linking to [[second]] and to [[private]].',
  '',
  'PARITY-PUBLISHED-WELCOME-BODY',
]);

write('second.md', [
  '---',
  'tags: [garden, tools]',
  '---',
  '# Second Note',
  '',
  'PARITY-PUBLISHED-SECOND-BODY',
  '',
  'Links back to [[welcome]].',
]);

write('private.md', [
  '---',
  'publish: false',
  '---',
  '# Private',
  '',
  'PARITY-PRIVATE-BODY-MUST-NOT-SHIP',
]);

mkdirSync(join(root, 'drafts'), { recursive: true });
write('drafts/roadmap.md', [
  '# Draft',
  '',
  'PARITY-DRAFT-BODY-MUST-NOT-SHIP',
]);

git('init', '--quiet');
git('config', 'user.name', 'Action Parity');
git('config', 'user.email', 'action-parity@example.invalid');

// Sorted public slugs only, exactly what `anc review` writes: no source paths
// and no withheld names. The release build recomputes the set and refuses any
// difference, so a wrong entry here fails the workflow rather than passing it.
const reviewed = writePublishSetReview(root, ['second', 'welcome']);

// Explicit paths, not `git add -A`: the generator checkout beside this corpus
// carries its own `.git`, and adding a gitlink here would make the fixture
// repository depend on something the workflow does not publish.
git(
  'add',
  '--',
  'welcome.md',
  'second.md',
  'private.md',
  'drafts',
  'publish.config.yaml',
  '.publish-set.json',
);
git('commit', '--quiet', '-m', 'notes: the synthetic notes repository');

console.log(`synthetic notes repository created: ${reviewed} published, 2 withheld`);
