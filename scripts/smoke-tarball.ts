/**
 * Release smoke: install the packed product into a foreign notes repository,
 * run its public init/build path, and inspect what a stranger receives.
 *
 * This is intentionally not part of verify. npm installs the full production
 * dependency tree and may need the registry cache/network; that is a release
 * qualification cost, not a source gate. The fixture is synthetic, so failure
 * diagnostics may print it without disclosing anybody's notes.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { spawnNpm } from './npm-command.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const TARBALL = join(ROOT, 'anc-' + MANIFEST.version + '.tgz');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      command + ' ' + args.join(' ') + ' failed with status ' + String(result.status) + '\n' +
      result.stdout + '\n' + result.stderr,
    );
  }
  return result.stdout;
}

function runNpm(args: string[], cwd: string): string {
  const result = spawnNpm(args, cwd);
  if (result.status !== 0) {
    throw new Error(
      'npm ' + args.join(' ') + ' failed with status ' + String(result.status) + '\n' +
      result.stdout + '\n' + result.stderr,
    );
  }
  return result.stdout;
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

function artifactText(path: string): { text: string; inflated: boolean } {
  const bytes = readFileSync(path);
  const inflated = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return {
    text: inflated ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8'),
    inflated,
  };
}

function main(): void {
  const packOutput = run(process.execPath, [join(ROOT, 'scripts', 'compile-package.ts')], ROOT);
  assert(
    packOutput.includes('tarball: ' + TARBALL),
    'packing current sources did not produce the expected tarball',
  );
  assert(existsSync(TARBALL), 'packing current sources wrote no tarball');
  const scratch = mkdtempSync(join(tmpdir(), 'publish-adoption-'));
  try {
    mkdirSync(join(scratch, 'drafts'), { recursive: true });
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'foreign-notes', version: '1.0.0', private: true }, null, 2) + '\n',
      'utf8',
    );
    writeFileSync(
      join(scratch, 'welcome.md'),
      [
        '# Welcome',
        '',
        'A public note linking to [[private]] with math $$x^2$$.',
        '',
        'INDEX-CONTROL-**JOINED**-TEXT',
        '',
        '~~~mermaid',
        'graph TD',
        '  A[Write] --> B[Publish]',
        '~~~',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(scratch, 'private.md'),
      '---\npublish: false\n---\n\n# Private\n\nPRIVATE-BODY-MUST-NOT-SHIP\n',
      'utf8',
    );
    writeFileSync(
      join(scratch, 'drafts', 'roadmap.md'),
      '# Draft\n\nDRAFT-BODY-MUST-NOT-SHIP\n',
      'utf8',
    );

    run('git', ['init', '--quiet'], scratch);
    run('git', ['config', 'user.name', 'Release Smoke'], scratch);
    run('git', ['config', 'user.email', 'release-smoke@example.invalid'], scratch);
    runNpm(['install', TARBALL, '--no-audit', '--no-fund'], scratch);

    const binary = join(scratch, 'node_modules', ...MANIFEST.name.split('/'), 'bin', 'anc.mjs');
    assert(existsSync(binary), 'npm did not install the shipped binary');
    const initOutput = run(process.execPath, [binary, 'init'], scratch);
    assert(initOutput.includes('publish.config.yaml: written'), 'init did not create its configuration template');
    assert(readFileSync(join(scratch, '.gitignore'), 'utf8').includes('/dist/'), 'init did not ignore the build output');

    writeFileSync(
      join(scratch, 'publish.config.yaml'),
      'title: Foreign Garden\norigin: https://notes.example.org/\nexclude:\n  - "drafts/**"\n',
      'utf8',
    );
    const reviewOutput = run(process.execPath, [binary, 'review'], scratch);
    assert(reviewOutput.includes('publish set review written: 1 notes'), 'review did not record the public set');
    run('git', ['add', '--', '.publish-set.json'], scratch);
    run('git', ['commit', '--quiet', '-m', 'review publish set'], scratch);
    const buildOutput = run(process.execPath, [binary, 'build', '--release'], scratch);
    const lines = buildOutput.trim().split(/\r?\n/);
    assert(lines.length === 5, 'release build wrote more or fewer than its five documented lines: ' + buildOutput);
    assert(lines[0]?.startsWith('secret scan ok:'), 'release build did not finish its secret scan');
    assert(lines[1]?.startsWith('residue scan ok:'), 'build did not finish its residue scan');
    assert(lines[2] === 'site written', 'build did not report a written site');
    assert(lines[3]?.includes('1 published'), 'build did not publish exactly the public fixture note');
    assert(lines[4]?.startsWith('report:'), 'build did not point to its private report');

    const dist = join(scratch, 'dist');
    const welcome = readFileSync(join(dist, 'notes', 'welcome', 'index.html'), 'utf8');
    assert(welcome.includes('Welcome · Foreign Garden'), 'configured title did not reach the note page');
    assert(welcome.includes('href="/private/"'), 'the withheld-note link is not live');
    assert(welcome.includes('language-math'), 'client math fallback did not ship');
    assert(welcome.includes('language-mermaid'), 'client diagram fallback did not ship');
    assert(!welcome.includes('PRIVATE-BODY-MUST-NOT-SHIP'), 'withheld body reached its linking page');

    assert(
      !welcome.includes('INDEX-CONTROL-JOINED-TEXT'),
      'the Pagefind control degraded into a raw HTML substring',
    );
    let inflatedText = '';
    const outputText = filesUnder(dist)
      .filter((file) => !/\.(?:avif|ico|jpe?g|png|webp|woff2?)$/i.test(file))
      .map((file) => {
        const artifact = artifactText(file);
        if (artifact.inflated) inflatedText += artifact.text + '\n';
        return artifact.text;
      })
      .join('\n');
    assert(
      inflatedText.includes('INDEX-CONTROL-JOINED-TEXT'),
      'no inflated Pagefind member carried its joined-text positive control',
    );
    for (const forbidden of ['PRIVATE-BODY-MUST-NOT-SHIP', 'DRAFT-BODY-MUST-NOT-SHIP']) {
      assert(!outputText.includes(forbidden), 'foreign artifact contains forbidden marker ' + forbidden);
    }

    const index = JSON.parse(readFileSync(join(dist, 'content-index.json'), 'utf8')) as {
      entries: { slug: string }[];
    };
    assert(index.entries.length === 1 && index.entries[0]?.slug === 'welcome', 'content index is not the reviewed public set');

    const reportPath = join(scratch, '.git', 'publish-report', 'content-report.json');
    const report = JSON.parse(
      readFileSync(reportPath, 'utf8'),
    ) as {
      status: string;
      dropped: { path: string; reason: string }[];
    };
    assert(report.status === 'complete', 'publication report did not complete');
    assert(
      report.dropped.some((item) => item.path === 'private.md' && item.reason === 'excluded-by-frontmatter'),
      'frontmatter exclusion is absent from the private report',
    );
    assert(
      report.dropped.some((item) => item.path === 'drafts/roadmap.md' && item.reason === 'excluded-by-pattern'),
      'pattern exclusion is absent from the private report',
    );

    const planted = 'ghp_4fJ9xQ2mN7vL5sT8yR1cW6kP3dH0bA9eZ7uC';
    const sourcePath = join(scratch, 'welcome.md');
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8') + `\ntoken=${planted}\n`, 'utf8');
    const rejected = spawnSync(process.execPath, [binary, 'build', '--release'], {
      cwd: scratch,
      encoding: 'utf8',
    });
    assert(rejected.status !== 0, 'a release carrying a credential passed the scan');
    const rejectedStreams = rejected.stdout + rejected.stderr;
    assert(
      /secret scan found [1-9]\d* findings?/.test(rejectedStreams),
      'release failure did not report a finding count: ' + rejectedStreams.replaceAll(planted, '<REDACTED>'),
    );
    assert(!rejectedStreams.includes(planted), 'release failure printed the matched credential');
    assert(!rejectedStreams.includes('welcome.md'), 'release failure printed the source filename');
    const failedReport = readFileSync(reportPath, 'utf8');
    assert(!failedReport.includes(planted), 'private report preserved the matched credential');
    assert(failedReport.includes('github-pat'), 'private report omitted the sanitized rule id');
    assert(readFileSync(join(dist, 'notes', 'welcome', 'index.html'), 'utf8') === welcome, 'failed release replaced the last good output');

    console.log('tarball adoption smoke ok: 1 published note, 2 withheld notes');
    console.log('tarball: ' + basename(TARBALL));
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main();
