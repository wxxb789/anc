/**
 * Every tracked Markdown file's relative links must resolve.
 *
 * A goal or design move rewrites the moved file's own links, but nothing in the
 * toolchain walks the files that point *at* it. The 0002 archive move left six
 * active goals and two test comments pointing at a path that had moved under
 * `archive/`, and no gate noticed — the defect was found by a human review.
 * This is that missing gate.
 *
 * **Scope: every tracked `*.md` except `tests/fixtures/`.** The two fixture
 * documents under `tests/fixtures/markdown/` are deliberately hostile input
 * (`javascript:` URLs, `file://` paths, an image that does not exist); the
 * renderer's treatment of them is gated by `tests/markdown.test.ts`, so they
 * must not be graded here. Everything else a reader can open is in scope.
 *
 * **What counts.** Inline and reference-free image/link syntax
 * (`[text](target)`, `![alt](target)`, angle-bracketed `<a file.md>`), with an
 * optional title. Skipped: `scheme:` URLs, protocol-relative `//host` targets,
 * pure fragments, and anything inside a fenced or inline code span, because a
 * document that *shows* link syntax is not linking. A link split across two
 * source lines is not detected; no document in this repository contains one,
 * and the gate's control records the shapes it does see.
 *
 * **The detector has its own control.** The second test drives
 * {@link relativeTargets} over a sample carrying one of every shape above and
 * asserts exactly which targets are found, so a green absence on the real tree
 * cannot come from a detector that stopped matching.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Deliberately broken fixture input, excluded by the file-level contract above. */
const EXCLUDED_PREFIX = 'tests/fixtures/';

/** One link or image target found in a document, with its 1-based source line. */
interface LinkTarget {
  line: number;
  target: string;
}

/**
 * Whether a target leaves the repository or the file system: anything with a
 * URI scheme (`https:`, `mailto:`, `javascript:`, `file:`), a protocol-relative
 * host, or a same-document fragment. None of these names a repository file.
 */
function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#');
}

/** Remove inline code spans, so link syntax shown in backticks is not a link. */
function withoutInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, '');
}

/**
 * The relative link and image targets in one Markdown document.
 *
 * Fenced code is tracked by its own marker so a `~~~` block cannot be closed
 * by a ``` line it contains. The target pattern takes an angle-bracketed path
 * (which may contain spaces) before the bare form, and an optional quoted
 * title after either.
 */
function relativeTargets(markdown: string): LinkTarget[] {
  const found: LinkTarget[] = [];
  let fence: string | undefined;
  for (const [index, line] of markdown.split('\n').entries()) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch !== null) {
      if (fence === undefined) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;

    const pattern = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^)"]*["'])?\s*\)/g;
    for (const match of withoutInlineCode(line).matchAll(pattern)) {
      const target = match[1] ?? match[2]!;
      if (!isExternal(target)) found.push({ line: index + 1, target });
    }
  }
  return found;
}

/** The repository-relative path a target names, from the document that holds it. */
function resolveTarget(document: string, target: string): string {
  const withoutFragment = target.split('#')[0]!;
  const base = withoutFragment.startsWith('/') ? ROOT : dirname(join(ROOT, document));
  return resolve(base, withoutFragment.replace(/^\//, ''));
}

/** Every tracked Markdown file outside the deliberately broken fixture input. */
function trackedMarkdown(): string[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout
    .split('\0')
    .filter((path) => path.length > 0 && !path.startsWith(EXCLUDED_PREFIX))
    .sort();
}

test('every tracked Markdown link resolves to a file that exists', () => {
  const documents = trackedMarkdown();
  // Non-vacuity: the walk found documents and the detector found links in them;
  // an empty enumeration or a broken pattern would pass every assertion below.
  assert.ok(documents.length > 20, `only ${documents.length} tracked Markdown files were inspected`);
  assert.ok(
    !documents.some((path) => path.startsWith(EXCLUDED_PREFIX)),
    'the deliberately broken fixture markdown reached the link gate',
  );

  const broken: string[] = [];
  let inspected = 0;
  for (const document of documents) {
    const targets = relativeTargets(readFileSync(join(ROOT, document), 'utf8'));
    inspected += targets.length;
    for (const { line, target } of targets) {
      if (!existsSync(resolveTarget(document, target))) {
        broken.push(`${document}:${line} -> ${target}`);
      }
    }
  }
  assert.ok(inspected > 0, 'no relative link target was found in any tracked Markdown file');

  assert.deepEqual(broken, [], `dangling Markdown links:\n${broken.join('\n')}`);
});

test('the link detector fires on every shape it must and skips the ones it must not', () => {
  const sample = [
    '# Sample', // 1
    '[good](docs/exists.md)', // 2
    '[bad](docs/missing.md)', // 3
    '[external](https://example.com/missing.md)', // 4
    '[fragment](#section)', // 5
    '[protocol](//example.com/missing.md)', // 6
    '![image](assets/missing.png)', // 7
    '', // 8
    '```', // 9
    '[fenced](docs/fenced-missing.md)', // 10
    '```', // 11
    '', // 12
    'Inline `[code](docs/inline-missing.md)` is code.', // 13
    '', // 14
    '[spaced](<docs/a file.md>)', // 15
    '[titled](docs/titled.md "the title")', // 16
    '~~~', // 17
    '[tilde](docs/tilde-missing.md)', // 18
    '~~~', // 19
  ].join('\n');

  assert.deepEqual(relativeTargets(sample), [
    { line: 2, target: 'docs/exists.md' },
    { line: 3, target: 'docs/missing.md' },
    { line: 7, target: 'assets/missing.png' },
    { line: 15, target: 'docs/a file.md' },
    { line: 16, target: 'docs/titled.md' },
  ]);
});
