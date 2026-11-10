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

const FIXTURE_CODE_POINT = 0xe000;

/**
 * A minimal sfnt carrying one format-12 `cmap` for a private-use code point.
 *
 * The new tests must not depend on which fonts this host has, so the font that
 * stands in for a "system-only" font is built here. Only the `cmap` table is
 * needed: discovery reads extensions and the coverage scan reads that table.
 */
function syntheticFont(codePoint: number): Buffer {
  const subtable = Buffer.alloc(28);
  subtable.writeUInt16BE(12, 0); // format 12
  subtable.writeUInt32BE(28, 4); // subtable length
  subtable.writeUInt32BE(1, 12); // one group
  subtable.writeUInt32BE(codePoint, 16); // startCharCode
  subtable.writeUInt32BE(codePoint, 20); // endCharCode
  subtable.writeUInt32BE(1, 24); // startGlyphID

  const cmap = Buffer.alloc(12 + subtable.length);
  cmap.writeUInt16BE(1, 2); // one encoding record
  cmap.writeUInt32BE(12, 8); // subtable offset
  subtable.copy(cmap, 12);

  const offset = 28;
  const file = Buffer.alloc(offset + cmap.length);
  file.writeUInt32BE(0x00010000, 0); // sfnt version
  file.writeUInt16BE(1, 4); // one table
  file.write('cmap', 12, 'latin1');
  file.writeUInt32BE(offset, 20);
  file.writeUInt32BE(cmap.length, 24);
  cmap.copy(file, offset);
  return file;
}

/** Run discovery in a child process, so each test starts with an empty cache. */
function discoveryWith(environment: NodeJS.ProcessEnv): {
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly missing: readonly number[];
} {
  const script =
    `import { discoverFonts, missingCodePoints } from ${JSON.stringify(join(ROOT, 'src/lib/font-coverage.ts'))};\n` +
    `const discovery = discoverFonts();\n` +
    `process.stdout.write(JSON.stringify({ directories: discovery.directories, files: discovery.files, missing: missingCodePoints([${FIXTURE_CODE_POINT}]).missing }));\n`;
  const module = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: ROOT,
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(module.status, 0, `the module child failed: ${module.stderr}`);
  return JSON.parse(module.stdout) as {
    directories: readonly string[];
    files: readonly string[];
    missing: readonly number[];
  };
}

/** A HOME/XDG tree of its own, with both fontconfig path variables unset. */
function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
  };
  delete environment['FONTCONFIG_FILE'];
  delete environment['FONTCONFIG_PATH'];
  return environment;
}

test('FONTCONFIG_FILE replaces the master configuration instead of adding to it', () => {
  const root = mkdtempSync(join(tmpdir(), 'font-config-file-'));
  try {
    const fonts = join(root, 'fonts');
    const other = join(root, 'other-fonts');
    mkdirSync(fonts);
    mkdirSync(other);
    // The fixture is reachable through a directory the custom master does not
    // name, standing in for a font inside /usr/share/fonts: it must stay
    // uncredited when the master excludes that directory.
    writeFileSync(join(fonts, 'Fixture.ttf'), syntheticFont(FIXTURE_CODE_POINT));
    const master = join(root, 'fonts.conf');
    writeFileSync(master, `<?xml version="1.0"?><fontconfig><dir>${other}</dir></fontconfig>`, 'utf8');

    const environment = isolatedEnvironment(root);
    environment['FONTCONFIG_FILE'] = master;
    const discovery = discoveryWith(environment);
    assert.deepEqual(discovery.files, [], 'a custom master inherited the default font directories');
    assert.ok(
      discovery.missing.includes(FIXTURE_CODE_POINT),
      'a font outside the master configuration was credited',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('FONTCONFIG_FILE can add a directory the default configuration does not scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'font-config-add-'));
  try {
    const fonts = join(root, 'fonts');
    mkdirSync(fonts);
    const font = join(fonts, 'Fixture.ttf');
    writeFileSync(font, syntheticFont(FIXTURE_CODE_POINT));
    const master = join(root, 'fonts.conf');
    writeFileSync(master, `<?xml version="1.0"?><fontconfig><dir>${fonts}</dir></fontconfig>`, 'utf8');

    const environment = isolatedEnvironment(root);
    environment['FONTCONFIG_FILE'] = master;
    const discovery = discoveryWith(environment);
    assert.deepEqual(discovery.files, [font], 'the master directory was not the only one scanned');
    assert.ok(
      !discovery.missing.includes(FIXTURE_CODE_POINT),
      'a font named by the master configuration was not read',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing FONTCONFIG_FILE contributes no coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'font-config-missing-'));
  try {
    const environment = isolatedEnvironment(root);
    environment['FONTCONFIG_FILE'] = join(root, 'does-not-exist.conf');
    const discovery = discoveryWith(environment);
    assert.deepEqual(discovery.files, [], 'a missing master fell back to the default directories');
    assert.ok(discovery.missing.includes(FIXTURE_CODE_POINT), 'a missing master still credited a font');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a relative FONTCONFIG_FILE resolves through FONTCONFIG_PATH like fontconfig', () => {
  const absoluteMaster = '/etc/fonts/fonts.conf';
  assert.equal(existsSync(absoluteMaster), true, `this host has no ${absoluteMaster}`);
  const root = mkdtempSync(join(tmpdir(), 'font-config-relative-'));
  try {
    const relativeEnvironment = isolatedEnvironment(root);
    relativeEnvironment['FONTCONFIG_FILE'] = 'fonts.conf';
    relativeEnvironment['FONTCONFIG_PATH'] = '/etc/fonts';
    const relative = discoveryWith(relativeEnvironment);

    const absoluteEnvironment = isolatedEnvironment(root);
    absoluteEnvironment['FONTCONFIG_FILE'] = absoluteMaster;
    const absolute = discoveryWith(absoluteEnvironment);

    assert.deepEqual(relative.directories, absolute.directories, 'the relative master read different directories');
    assert.equal(relative.files.length, absolute.files.length, 'the relative master counted a different font set');
    assert.ok(relative.files.length > 0, 'the resolved master discovered no fonts at all');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a relative FONTCONFIG_FILE is found in a FONTCONFIG_PATH component', () => {
  const root = mkdtempSync(join(tmpdir(), 'font-config-search-'));
  try {
    const fonts = join(root, 'fonts');
    const config = join(root, 'config');
    mkdirSync(fonts);
    mkdirSync(config);
    const font = join(fonts, 'Fixture.ttf');
    writeFileSync(font, syntheticFont(FIXTURE_CODE_POINT));
    writeFileSync(
      join(config, 'anc-relative-master.conf'),
      `<?xml version="1.0"?><fontconfig><dir>${fonts}</dir></fontconfig>`,
      'utf8',
    );

    const environment = isolatedEnvironment(root);
    environment['FONTCONFIG_FILE'] = 'anc-relative-master.conf';
    // The first component does not exist; the second is the one that carries
    // the master, proving the components are tried in order rather than only
    // the last.
    environment['FONTCONFIG_PATH'] = `${join(root, 'absent')}:${config}`;
    const discovery = discoveryWith(environment);
    assert.deepEqual(discovery.directories, [fonts], 'the master was not resolved through its component');
    assert.deepEqual(discovery.files, [font], 'the master directory was not scanned');
    assert.ok(
      !discovery.missing.includes(FIXTURE_CODE_POINT),
      'a font named by the component master was not read',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a relative FONTCONFIG_FILE that exists nowhere contributes no coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'font-config-nowhere-'));
  try {
    const environment = isolatedEnvironment(root);
    environment['FONTCONFIG_FILE'] = 'anc-no-such-master.conf';
    environment['FONTCONFIG_PATH'] = `${join(root, 'absent-a')}:${join(root, 'absent-b')}`;
    const discovery = discoveryWith(environment);
    assert.deepEqual(discovery.directories, [], 'an unresolved master borrowed a system directory');
    assert.deepEqual(discovery.files, [], 'an unresolved master credited a font');
    assert.ok(discovery.missing.includes(FIXTURE_CODE_POINT), 'an unresolved master still credited coverage');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
