/**
 * The measurement CLI's own refusal surface.
 *
 * `scripts/measure-media.ts` is a repository instrument, not product code, but a
 * silently ignored option would make a cost table describe a different run than
 * the command line says — `--qualtiy` would exit 0 with no quality check. The
 * allowlist is therefore a gate, not ergonomics.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { options } from '../scripts/measure-media.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('every documented option parses, including a bare flag', () => {
  const parsed = options(['--corpus', 'corpus', '--dist', 'dist', '--label', 'run', '--quality', '--json', 'report.json']);
  assert.equal(parsed.get('corpus'), 'corpus');
  assert.equal(parsed.get('dist'), 'dist');
  assert.equal(parsed.get('label'), 'run');
  assert.equal(parsed.get('quality'), 'true');
  assert.equal(parsed.get('json'), 'report.json');
});

test('an unknown option is refused instead of being stored and ignored', () => {
  assert.throws(
    () => options(['--qualtiy', 'report.json']),
    /unknown option --qualtiy/,
    'a misspelled option was accepted',
  );

  // The same refusal through the real CLI, because the parser being correct is
  // not the same as the command failing.
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'measure-media.ts'), '--qualtiy', 'report.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, `an unknown option exited ${result.status}: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /unknown option --qualtiy/, result.stderr);
});
