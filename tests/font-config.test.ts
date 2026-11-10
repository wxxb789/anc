/**
 * The font gate follows the *host's* font selection, not merely its `<dir>`
 * list: a fontconfig `<rejectfont>` that is not applied can turn a missing glyph
 * into a false coverage answer.
 *
 * This test builds a temporary HOME/XDG tree, gives fontconfig itself and this
 * module the same environment, and compares membership of the same font files
 * against fontconfig's accepted set. `fc-list` is deliberately not that set:
 * measured with fontconfig 2.15, `fc-list` lists a font rejected by
 * `<selectfont>` (it enumerates the configured directories and does not apply
 * filename selectors); `fc-match` applies the accept/reject rules. The module
 * follows the latter, which is what a font match can actually draw.
 *
 * The fixture exercises an XDG include of a `conf.d` directory, a `<dir>` inside
 * a user config, absolute file globs, an accept rule that overrides a broader
 * reject (fontconfig checks accepts first), a family-pattern reject, and a
 * legacy `~/.local/share/fonts` file that must not be admitted merely because it
 * is under HOME.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SANS = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const SERIF = '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf';
const MONO = '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf';
const SANS_LIBERATION = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf';
const SERIF_LIBERATION = '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf';

test('font discovery applies the host fontconfig reject and accept rules', () => {
  for (const font of [SANS, SERIF, MONO, SANS_LIBERATION, SERIF_LIBERATION]) {
    if (!existsSync(font)) throw new Error(`the test font is not installed on this host: ${font}`);
  }

  const root = mkdtempSync(join(tmpdir(), 'font-config-'));
  try {
    const home = join(root, 'home');
    const configHome = join(root, 'xdg-config');
    const dataHome = join(root, 'xdg-data');
    const cacheHome = join(root, 'xdg-cache');
    const hostFonts = join(root, 'host-fonts');
    const legacyFonts = join(home, '.local', 'share', 'fonts');
    mkdirSync(join(configHome, 'fontconfig', 'conf.d'), { recursive: true });
    mkdirSync(join(dataHome, 'fonts'), { recursive: true });
    mkdirSync(cacheHome, { recursive: true });
    mkdirSync(hostFonts, { recursive: true });
    mkdirSync(legacyFonts, { recursive: true });

    copyFileSync(SERIF, join(hostFonts, 'HostOnly.ttf'));
    copyFileSync(MONO, join(hostFonts, 'Rejected.ttf'));
    copyFileSync(SANS_LIBERATION, join(hostFonts, 'AcceptMe.ttf'));
    copyFileSync(SANS, join(hostFonts, 'FamilyRejected.ttf'));
    copyFileSync(SERIF_LIBERATION, join(legacyFonts, 'LegacyOnly.ttf'));

    writeFileSync(
      join(configHome, 'fontconfig', 'conf.d', '50-test.conf'),
      `<?xml version="1.0"?>
<fontconfig>
  <dir>${hostFonts}</dir>
  <selectfont><rejectfont><glob>${hostFonts}/Rejected.ttf</glob><glob>${hostFonts}/AcceptMe.ttf</glob></rejectfont></selectfont>
  <selectfont><acceptfont><glob>${hostFonts}/AcceptMe.ttf</glob></acceptfont></selectfont>
  <selectfont><rejectfont><pattern><patelt name="family"><string>DejaVu Sans</string></patelt></pattern></rejectfont></selectfont>
</fontconfig>
`,
      'utf8',
    );

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
    };
    delete environment['FONTCONFIG_FILE'];

    const cache = spawnSync('fc-cache', ['-f'], { env: environment, encoding: 'utf8' });
    assert.equal(cache.status, 0, `fc-cache failed: ${cache.stderr}`);

    const script =
      `import { discoverFonts } from ${JSON.stringify(join(ROOT, 'src/lib/font-coverage.ts'))};\n` +
      `process.stdout.write(JSON.stringify(discoverFonts()));\n`;
    const module = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: ROOT,
      env: environment,
      encoding: 'utf8',
    });
    assert.equal(module.status, 0, `the module child failed: ${module.stderr}`);
    const discovery = JSON.parse(module.stdout) as { files: string[]; includes: number; includeDirectories: number };
    assert.ok(discovery.includeDirectories >= 1, 'the XDG include directory was not followed');
    assert.ok(discovery.includes >= 1, 'no config include file was counted');

    const accepted = (family: string): Set<string> => {
      const result = spawnSync('fc-match', ['-s', '--format', '%{file}\n', family], {
        env: environment,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `fc-match ${family} failed: ${result.stderr}`);
      return new Set(result.stdout.split('\n').filter((line) => line !== ''));
    };
    const serif = accepted('DejaVu Serif');
    const mono = accepted('Liberation Mono');
    const sans = accepted('DejaVu Sans');
    const liberationSans = accepted('Liberation Sans');
    const liberationSerif = accepted('Liberation Serif');
    const offered = new Set(discovery.files);

    const check = (path: string, fontconfigSet: Set<string>, expected: boolean): void => {
      assert.equal(offered.has(path), expected, `our discovery ${expected ? 'lost' : 'admitted'} ${path}`);
      assert.equal(fontconfigSet.has(path), expected, `fc-match ${expected ? 'does not offer' : 'offers'} ${path}`);
    };
    check(join(hostFonts, 'HostOnly.ttf'), serif, true);
    check(join(hostFonts, 'Rejected.ttf'), mono, false);
    check(join(hostFonts, 'AcceptMe.ttf'), liberationSans, true);
    check(join(hostFonts, 'FamilyRejected.ttf'), sans, false);
    check(join(legacyFonts, 'LegacyOnly.ttf'), liberationSerif, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed included config is a skipped include, not a followed one', () => {
  const root = mkdtempSync(join(tmpdir(), 'font-config-bad-'));
  try {
    const home = join(root, 'home');
    const configHome = join(root, 'xdg-config');
    const dataHome = join(root, 'xdg-data');
    const cacheHome = join(root, 'xdg-cache');
    mkdirSync(join(configHome, 'fontconfig', 'conf.d'), { recursive: true });
    mkdirSync(join(dataHome, 'fonts'), { recursive: true });
    mkdirSync(cacheHome, { recursive: true });
    writeFileSync(join(configHome, 'fontconfig', 'conf.d', '50-broken.conf'), '<fontconfig><dir>', 'utf8');

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
    };
    delete environment['FONTCONFIG_FILE'];
    const script =
      `import { discoverFonts } from ${JSON.stringify(join(ROOT, 'src/lib/font-coverage.ts'))};\n` +
      `process.stdout.write(JSON.stringify(discoverFonts()));\n`;
    const module = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: ROOT,
      env: environment,
      encoding: 'utf8',
    });
    assert.equal(module.status, 0, `the module child failed: ${module.stderr}`);
    const discovery = JSON.parse(module.stdout) as { skippedIncludes: number };
    assert.ok(discovery.skippedIncludes >= 1, 'the malformed config was counted as followed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
