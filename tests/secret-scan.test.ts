import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { GITLEAKS_VERSION, scanSecrets } from '../scripts/scan-secrets.ts';
import { BuildFailure } from '../scripts/write-report.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
const INSTALLER = readFileSync(join(ROOT, '.github', 'scripts', 'install-gitleaks.sh'), 'utf8');
const ACTION = readFileSync(join(ROOT, 'action.yml'), 'utf8');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'verify.yml'), 'utf8');
const BINARY = readFileSync(join(ROOT, 'bin', 'anc.mjs'), 'utf8');
const BUILD_SITE = readFileSync(join(ROOT, 'scripts', 'build-site.ts'), 'utf8');
const SCRIPTS = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

function failure(action: () => void): BuildFailure {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof BuildFailure, 'secret scanner failure lost disclosure checking');
    return error;
  }
  assert.fail('expected secret scan to fail');
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'secret-scan-test-'));
}

test('CI and the Action install the same checksum-pinned scanner before gated builds', () => {
  assert.ok(INSTALLER.includes(`version='${GITLEAKS_VERSION}'`));
  assert.match(INSTALLER, /linux_x64\.tar\.gz/);
  assert.match(INSTALLER, /linux_arm64\.tar\.gz/);
  assert.equal((INSTALLER.match(/[a-f0-9]{64}/g) ?? []).length, 2, 'installer does not pin both archive hashes');
  assert.ok(INSTALLER.indexOf('sha256sum --check') < INSTALLER.indexOf('tar --extract'));
  const versionCheck = INSTALLER.lastIndexOf('gitleaks" version');
  assert.ok(versionCheck >= 0 && versionCheck < INSTALLER.indexOf('GITHUB_PATH'));
  assert.ok(ACTION.indexOf('install-gitleaks.sh') < ACTION.indexOf('Build the site'));
  assert.ok(WORKFLOW.indexOf('install-gitleaks.sh') < WORKFLOW.indexOf('- run: pnpm run verify'));
  assert.ok(!ACTION.includes(GITLEAKS_VERSION), 'Action duplicates the scanner version');
  assert.ok(!WORKFLOW.includes(GITLEAKS_VERSION), 'workflow duplicates the scanner version');
});

test('verify and release scan while ordinary preview builds do not require Gitleaks', () => {
  const verify = SCRIPTS['verify'] ?? '';
  assert.match(verify, /node scripts\/build-site\.ts --scan-secrets/);
  assert.ok(verify.indexOf('--scan-secrets') < verify.indexOf('test'));
  assert.ok(!(SCRIPTS['build'] ?? '').includes('scan-secrets'));
  assert.match(BUILD_SITE, /STEPS\.slice\(0, -1\), SECRET_STEP, STEPS\.at\(-1\)!/);
  assert.match(BUILD_SITE, /const release = await lockDist\([^;]+\);\s*try \{\s*return runSteps\(includeSecrets\);\s*\} finally \{\s*release\(\)/);
  assert.match(BINARY, /if \(release\) \{[\s\S]*?scanSecrets\(staging\)/);
  assert.ok(BINARY.indexOf('scanSecrets(staging)') < BINARY.indexOf('cp(staging, outDirectory'));
});

test('the pinned scanner accepts a complete clean projection', () => {
  const root = scratch();
  try {
    writeFileSync(join(root, 'index.html'), '<h1>clean</h1>\n', 'utf8');
    assert.equal(scanSecrets(root), 1);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('raw, gzip-inflated, and allow-commented secrets fail by count without secret disclosure', () => {
  const root = scratch();
  const first = 'ghp_4fJ9xQ2mN7vL5sT8yR1cW6kP3dH0bA9eZ7uC';
  const second = 'ghp_8nR2vD6yK1mQ5sT9xF4cH7bL0pW3aE6jU2zG';
  const previousConfig = process.env['GITLEAKS_CONFIG_TOML'];
  process.env['GITLEAKS_CONFIG_TOML'] =
    '[[rules]]\nid = "nothing"\ndescription = "matches nothing"\nregex = \'\'\'ZZQ_NEVER_MATCH\'\'\'\n';
  try {
    writeFileSync(join(root, 'index.html'), 'token=' + first + ' # gitleaks:allow\n', 'utf8');
    writeFileSync(
      join(root, '.gitleaks.toml'),
      '[[rules]]\nid = "nothing"\ndescription = "matches nothing"\nregex = \'\'\'ZZQ_NEVER_MATCH\'\'\'\n',
      'utf8',
    );
    mkdirSync(join(root, 'pagefind'));
    writeFileSync(join(root, 'pagefind', 'fragment.pf_fragment'), gzipSync('token=' + second));

    const error = failure(() => scanSecrets(root));
    assert.equal(error.code, 'secret-scan-findings');
    assert.match(error.message, /secret scan found 2 findings/);
    assert.ok(!error.message.includes('index.html'));
    assert.ok(!error.message.includes(first));
    assert.ok(!error.detail.includes(first));
    assert.ok(!error.detail.includes(second));
    assert.match(error.detail, /index\.html/);
    assert.match(error.detail, /fragment\.pf_fragment\.inflated/);
    assert.match(error.detail, /github-pat/);
  } finally {
    if (previousConfig === undefined) delete process.env['GITLEAKS_CONFIG_TOML'];
    else process.env['GITLEAKS_CONFIG_TOML'] = previousConfig;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('missing and mismatched scanner versions fail before scanning', () => {
  const missing = failure(() => scanSecrets(DIST, { executable: 'gitleaks-does-not-exist' }));
  assert.equal(missing.code, 'secret-scanner-unavailable');
  assert.ok(!missing.message.includes('gitleaks-does-not-exist'));

  const mismatch = failure(() => scanSecrets(DIST, { expectedVersion: '0.0.0-test' }));
  assert.equal(mismatch.code, 'secret-scanner-unavailable');
  assert.match(mismatch.message, /Gitleaks 0\.0\.0-test/);
  assert.ok(!mismatch.detail.includes(GITLEAKS_VERSION));
  assert.match(mismatch.detail, /stdoutBytes/);
});

test('empty and unreadable compressed output cannot pass as clean', () => {
  const empty = scratch();
  const broken = scratch();
  try {
    assert.equal(failure(() => scanSecrets(empty)).code, 'secret-scan-input-empty');
    writeFileSync(join(broken, 'member.gz'), Buffer.from([0x1f, 0x8b, 0x00]));
    assert.equal(failure(() => scanSecrets(broken)).code, 'secret-scan-input-unreadable');
  } finally {
    rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(broken, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
