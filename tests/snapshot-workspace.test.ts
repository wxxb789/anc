/**
 * One workspace resolution for the build config and the reader.
 *
 * `astro.config.mjs` reads the staged binding from `SNAPSHOT_WORKSPACE` while
 * `snapshot-reader.ts` loads the relationship edges from the same directory, and
 * the two used to disagree on an empty value: `??` in the config (empty resolved
 * to the working directory) versus `||` in the reader (empty fell back to
 * `.astro/snapshot`). Reproduced before the fix with `SNAPSHOT_WORKSPACE=''`:
 * the reader resolved the planted `.astro/snapshot` while `vite.define`
 * substituted the literal string `null` for the binding, so the Worker failed
 * closed and the lazy runtime never started — with no build error.
 *
 * `snapshot.ts` now owns the empty-as-unset choice in one function, and both
 * sites call it. The config half has to be evaluated in a child process: it
 * reads the environment and the working directory once at module scope, so one
 * process cannot see both an empty and a set value.
 *
 * **Mutation:** restoring `??` in `astro.config.mjs` (or whatever single site
 * stops calling `configuredSnapshotWorkspace`) turns the empty case red at the
 * binding assertion, because the config then reads a `binding.json` that is not
 * there while the probe's reader still names `.astro/snapshot`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { DEFAULT_SNAPSHOT_WORKSPACE, configuredSnapshotWorkspace } from '../src/lib/snapshot.ts';

const CONFIG_URL = new URL('../astro.config.mjs', import.meta.url).href;
const READER_URL = new URL('../src/lib/snapshot-reader.ts', import.meta.url).href;

/** A well-formed binding, distinct per caller so the two cases cannot alias. */
function bindingFor(letter: string): { url: string; digest: string } {
  const hex = letter.repeat(64);
  return { url: `/data/site.${hex}.sqlite`, digest: hex };
}

/** A scratch directory removed when the callback returns, however it returns. */
function scratch<T>(prefix: string, body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface Probe {
  /** The directory the reader resolved. */
  workspace: string;
  /** The `vite.define` substitution, still JSON-encoded as the config writes it. */
  binding: string;
}

/**
 * Evaluate the config and the reader in one child process whose working
 * directory is `directory`, and report what each resolved.
 *
 * `PUBLISH_CONFIG_DIR` is pointed at the same scratch directory so no
 * repository config can reach the probe; a directory with no config file is the
 * "unconfigured" case the loader already handles.
 */
function probe(directory: string, workspace: string): Probe {
  const script = `Promise.all([import(${JSON.stringify(CONFIG_URL)}), import(${JSON.stringify(READER_URL)})]).then(
  ([config, reader]) => {
    console.log(JSON.stringify({
      workspace: reader.snapshotWorkspace(),
      binding: config.default.vite.define.__ANC_SNAPSHOT_BINDING__,
    }));
  },
);`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '-e', script], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, SNAPSHOT_WORKSPACE: workspace, PUBLISH_CONFIG_DIR: directory },
  });
  assert.equal(child.status, 0, `evaluating astro.config.mjs failed:\n${child.stderr}`);
  const line = child.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Probe;
}

test('the shared resolver treats empty as unset and passes a set value through', () => {
  assert.equal(configuredSnapshotWorkspace(''), DEFAULT_SNAPSHOT_WORKSPACE);
  assert.equal(configuredSnapshotWorkspace(undefined), DEFAULT_SNAPSHOT_WORKSPACE);
  assert.equal(configuredSnapshotWorkspace('/custom/workspace'), '/custom/workspace');
  assert.equal(configuredSnapshotWorkspace('relative/workspace'), 'relative/workspace');
});

test('an empty SNAPSHOT_WORKSPACE resolves to the default in both the config and the reader', () => {
  scratch('anc-workspace-empty-', (directory) => {
    const binding = bindingFor('a');
    const staged = join(directory, DEFAULT_SNAPSHOT_WORKSPACE);
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'binding.json'), JSON.stringify(binding), 'utf8');

    const result = probe(directory, '');

    assert.equal(result.workspace, resolve(directory, DEFAULT_SNAPSHOT_WORKSPACE));
    assert.deepEqual(
      JSON.parse(result.binding),
      binding,
      'the config did not read the workspace the reader resolves; the Worker would silently never start',
    );
  });
});

test('a set SNAPSHOT_WORKSPACE still selects the named directory at both sites', () => {
  scratch('anc-workspace-set-', (directory) => {
    const binding = bindingFor('b');
    const workspace = 'staged-elsewhere';
    mkdirSync(join(directory, workspace), { recursive: true });
    writeFileSync(join(directory, workspace, 'binding.json'), JSON.stringify(binding), 'utf8');

    const result = probe(directory, workspace);

    assert.equal(result.workspace, resolve(directory, workspace));
    assert.deepEqual(JSON.parse(result.binding), binding);
  });
});
