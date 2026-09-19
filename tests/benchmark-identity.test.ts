import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertRepositoryIdentityClean,
  assertRepositoryIdentityStable,
  benchmarkReportDirectory,
  repositoryIdentity,
} from '../scripts/benchmark-identity.ts';

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function git(directory: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.excludesFile=', ...args], {
    cwd: directory,
    stdio: 'ignore',
  });
}

function repositoryFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'anc-benchmark-identity-'));
  scratchDirectories.push(directory);
  git(directory, 'init', '--quiet');
  git(directory, 'config', 'user.email', 'benchmark@example.invalid');
  git(directory, 'config', 'user.name', 'Benchmark Test');
  writeFileSync(join(directory, '.gitignore'), 'ignored.txt\n', 'utf8');
  mkdirSync(join(directory, 'tests', 'support'), { recursive: true });
  writeFileSync(join(directory, 'tests', 'support', 'browser-site.ts'), 'export const asset = true;\n', 'utf8');
  git(directory, 'add', '.gitignore', 'tests/support/browser-site.ts');
  git(directory, 'commit', '--quiet', '-m', 'fixture');
  return directory;
}

describe('benchmark repository identity', () => {
  it('resolves the private report directory through Git', () => {
    const directory = repositoryFixture();
    const gitPath = execFileSync('git', ['rev-parse', '--git-path', 'publish-report'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim();

    expect(benchmarkReportDirectory(directory)).toBe(resolve(directory, gitPath));
  });

  it('covers tracked helpers and nonignored untracked files while excluding ignored files', () => {
    const directory = repositoryFixture();
    writeFileSync(join(directory, 'untracked-support.ts'), 'export const support = true;\n', 'utf8');
    writeFileSync(join(directory, 'ignored.txt'), 'ignored before\n', 'utf8');

    const first = repositoryIdentity(directory);

    expect(first.files).toBe(3);
    expect(first.worktreeDirty).toBe(true);
    expect(first.scope).toMatch(/tracked files and nonignored untracked regular files/);

    writeFileSync(join(directory, 'ignored.txt'), 'ignored after\n', 'utf8');
    expect(repositoryIdentity(directory).sha256).toBe(first.sha256);

    writeFileSync(join(directory, 'tests', 'support', 'browser-site.ts'), 'export const asset = false;\n', 'utf8');
    expect(repositoryIdentity(directory).sha256).not.toBe(first.sha256);
  });

  it('refuses a dirty identity before any goal-qualified workload', () => {
    const directory = repositoryFixture();
    writeFileSync(join(directory, 'untracked-support.ts'), 'export const support = true;\n', 'utf8');

    expect(() => assertRepositoryIdentityClean(repositoryIdentity(directory))).toThrow(
      /clean repository identity before workloads/,
    );
  });

  it('refuses a dirty-tree identity change at a named material boundary', () => {
    const directory = repositoryFixture();
    const baseline = repositoryIdentity(directory);

    expect(assertRepositoryIdentityClean(baseline)).toBe(baseline);
    expect(() => assertRepositoryIdentityStable(baseline, directory, 'before build')).not.toThrow();

    writeFileSync(join(directory, 'tests', 'support', 'browser-site.ts'), 'export const asset = false;\n', 'utf8');

    expect(() => assertRepositoryIdentityStable(baseline, directory, 'after build')).toThrow(
      /benchmark identity drift detected at after build/,
    );
  });
});
