/**
 * Gitleaks over the exact bytes readers receive, including inflated gzip members.
 *
 * The external scanner owns the credential rule set and false-positive policy.
 * This wrapper owns reproducibility, fail-closed process handling, redaction, and
 * the public-count/private-path split used by every other publication gate.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { BuildFailure } from './write-report.ts';

export const GITLEAKS_VERSION = '8.30.1';
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

export interface SecretScanOptions {
  executable?: string;
  expectedVersion?: string;
}

interface GitleaksFinding {
  Match?: unknown;
  Secret?: unknown;
  RuleID?: unknown;
  Description?: unknown;
  File?: unknown;
  StartLine?: unknown;
  EndLine?: unknown;
  StartColumn?: unknown;
  EndColumn?: unknown;
}

function processText(value: string | null): string {
  return value ?? '';
}

function scanProcessDetail(
  result: SpawnSyncReturns<string>,
  findings: readonly Record<string, unknown>[] = [],
): string {
  return JSON.stringify({
    status: result.status,
    error: result.error?.message,
    stdoutBytes: Buffer.byteLength(processText(result.stdout), 'utf8'),
    stderrBytes: Buffer.byteLength(processText(result.stderr), 'utf8'),
    findings,
  });
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else {
        throw new BuildFailure(
          'secret-scan-input-invalid',
          'secret scan found a non-file output member',
          path,
        );
      }
    }
  }
  return files.sort();
}

function projection(source: string, target: string): number {
  const files = filesUnder(source);
  if (files.length === 0) {
    throw new BuildFailure('secret-scan-input-empty', 'secret scan refused an empty output', source);
  }
  for (const path of files) {
    const relativePath = relative(source, path);
    const bytes = readFileSync(path);
    const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const destination = join(target, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
    if (gzip) {
      try {
        writeFileSync(destination + '.inflated', gunzipSync(bytes));
      } catch (error) {
        throw new BuildFailure(
          'secret-scan-input-unreadable',
          'secret scan could not inflate one output member',
          path + ': ' + (error instanceof Error ? error.stack ?? error.message : String(error)),
        );
      }
    }
  }
  return files.length;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function projectedPath(file: string | undefined, projectionRoot: string): string | undefined {
  if (file === undefined) return undefined;
  const absolute = isAbsolute(file) ? resolve(file) : resolve(process.cwd(), file);
  const path = relative(projectionRoot, absolute);
  if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) return '<outside projection>';
  return path.split(sep).join('/');
}

function sanitize(findings: unknown, projectionRoot: string): Record<string, unknown>[] {
  if (!Array.isArray(findings)) {
    throw new BuildFailure(
      'secret-scanner-failed',
      'secret scan failed to produce a valid report',
      'Gitleaks JSON report is not an array',
    );
  }
  return findings.map((value, index) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BuildFailure(
        'secret-scanner-failed',
        'secret scan failed to produce a valid report',
        'Gitleaks finding ' + index + ' is not an object',
      );
    }
    const finding = value as GitleaksFinding;
    if (
      finding.Secret !== 'REDACTED' ||
      typeof finding.Match !== 'string' ||
      !finding.Match.includes('REDACTED')
    ) {
      throw new BuildFailure(
        'secret-scanner-failed',
        'secret scan report was not fully redacted',
        'Gitleaks finding ' + index + ' did not redact Match and Secret',
      );
    }
    const projected = projectedPath(cleanString(finding.File), projectionRoot);
    return {
      rule: cleanString(finding.RuleID),
      description: cleanString(finding.Description),
      file: projected,
      startLine: cleanNumber(finding.StartLine),
      endLine: cleanNumber(finding.EndLine),
      startColumn: cleanNumber(finding.StartColumn),
      endColumn: cleanNumber(finding.EndColumn),
    };
  });
}

function scannerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment['GITLEAKS_CONFIG'];
  delete environment['GITLEAKS_CONFIG_TOML'];
  return environment;
}

/** Run the pinned scanner without forwarding its path-bearing process streams. */
export function scanSecrets(root: string, options: SecretScanOptions = {}): number {
  const executable = options.executable ?? 'gitleaks';
  const expectedVersion = options.expectedVersion ?? GITLEAKS_VERSION;
  const environment = scannerEnvironment();
  const version = spawnSync(executable, ['version'], {
    encoding: 'utf8',
    env: environment,
    timeout: 30_000,
    windowsHide: true,
  });
  if (
    version.status !== 0 ||
    processText(version.stdout).trim() !== expectedVersion ||
    processText(version.stderr).trim() !== ''
  ) {
    throw new BuildFailure(
      'secret-scanner-unavailable',
      'secret scan requires Gitleaks ' + expectedVersion,
      scanProcessDetail(version),
    );
  }

  const temporary = mkdtempSync(join(tmpdir(), 'anc-secret-scan-'));
  const scanRoot = join(temporary, 'artifact');
  const report = join(temporary, 'report.json');
  const ignore = join(temporary, 'empty.gitleaksignore');
  const config = join(temporary, 'gitleaks.toml');
  const run = (): number => {
    mkdirSync(scanRoot);
    writeFileSync(ignore, '', 'utf8');
    writeFileSync(config, '[extend]\nuseDefault = true\n', 'utf8');
    const scanned = projection(root, scanRoot);
    const result = spawnSync(executable, [
      'dir',
      '--no-banner',
      '--no-color',
      '--redact=100',
      '--log-level', 'error',
      '--ignore-gitleaks-allow',
      '--gitleaks-ignore-path', ignore,
      '--config', config,
      // Gzip is projected explicitly above. One encoding layer still catches
      // wrapped credentials; depth five spent ~80 seconds on Mermaid bundles.
      '--max-archive-depth', '0',
      '--max-decode-depth', '1',
      // Zero disables size-based skipping: a large output member must be read.
      '--max-target-megabytes', '0',
      '--timeout', '120',
      '--exit-code', '7',
      '--report-format', 'json',
      '--report-path', report,
      scanRoot,
    ], { encoding: 'utf8', env: environment, timeout: 130_000, windowsHide: true });

    let rawReport: unknown;
    try {
      rawReport = JSON.parse(readFileSync(report, 'utf8'));
    } catch (error) {
      throw new BuildFailure(
        'secret-scanner-failed',
        'secret scan failed to produce a readable report',
        scanProcessDetail(result) + '\n' + String(error),
      );
    }
    const findings = sanitize(rawReport, scanRoot);
    // At error log level, any stderr means Gitleaks could not read something.
    if (processText(result.stderr).trim() !== '' || (result.status !== 0 && result.status !== 7)) {
      throw new BuildFailure(
        'secret-scanner-failed',
        'secret scan did not inspect the complete output',
        scanProcessDetail(result, findings),
      );
    }
    const hasFindings = findings.length > 0;
    if ((result.status === 7) !== hasFindings) {
      throw new BuildFailure(
        'secret-scanner-failed',
        'secret scan status disagreed with its redacted report',
        scanProcessDetail(result, findings),
      );
    }
    if (hasFindings) {
      throw new BuildFailure(
        'secret-scan-findings',
        'secret scan found ' + findings.length + ' finding' + (findings.length === 1 ? '' : 's'),
        JSON.stringify({ findings }),
      );
    }
    return scanned;
  };

  let outcome = 0;
  let failure: unknown;
  try {
    outcome = run();
  } catch (error) {
    failure = error;
  }
  try {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (cleanupError) {
    const detail = cleanupError instanceof Error ? cleanupError.stack ?? cleanupError.message : String(cleanupError);
    failure = failure instanceof BuildFailure
      ? new BuildFailure(failure.code, failure.message, failure.detail + '\n' + detail)
      : new BuildFailure(
          'secret-scan-cleanup-failed',
          'secret scan could not remove its temporary projection',
          detail,
        );
  }
  if (failure instanceof BuildFailure) throw failure;
  if (failure !== undefined) {
    throw new BuildFailure(
      'secret-scanner-failed',
      'secret scan failed before inspecting the complete output',
      failure instanceof Error ? failure.stack ?? failure.message : String(failure),
    );
  }
  return outcome;
}

/** Own-repository command; the packaged binary imports scanSecrets directly. */
export function runSecretScanCommand(): number {
  try {
    console.log('secret scan ok: ' + scanSecrets(DIST) + ' files, 0 findings');
    return 0;
  } catch (error) {
    console.error(error instanceof BuildFailure ? error.message : 'secret scan failed');
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(runSecretScanCommand());
