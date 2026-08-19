/**
 * The renderer-owned marker, exercised in the client configuration that uses
 * it as a residue exemption.
 *
 * This file mocks only the selected rendering adapters. The production defaults
 * stay in their mode modules; the mocks let the same renderer, scanner, and
 * budget gate run their otherwise dormant client branches without rewriting a
 * source file during the suite. That matters here: the earlier gate grepped
 * those files and four behavior-changing implementations still satisfied it.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

vi.mock('../src/lib/math-mode.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/math-mode.ts')>();
  return { ...actual, MATH_MODE: 'client' as const };
});
vi.mock('../src/lib/diagram-mode.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/diagram-mode.ts')>();
  return { ...actual, DIAGRAM_MODE: 'client' as const };
});

import { renderMarkdown } from '../src/lib/markdown.ts';
import { DIAGRAM_MODE } from '../src/lib/diagram-mode.ts';
import { MATH_MODE } from '../src/lib/math-mode.ts';
import {
  MARKED_ROOT,
  RENDERED_DIAGRAM,
  RENDERED_MARKER,
  RENDERED_MATH,
} from '../src/lib/rendered-marker.ts';
import { indexWithPagefind } from '../scripts/run-pagefind.ts';
import { scanResidue } from '../scripts/scan-residue.ts';
import { BASE_SCRIPT_BUDGET_BYTES, scriptBudgetFor } from './support/runtime-budget.ts';

const HOST_PATH = String.raw`C:\Users\alice\private.md`;

/** Use one complete built-site shape and remove it after the assertion. */
function withSite<T>(prefix: string, body: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** Async sibling that does not remove the site before its promise settles. */
async function withAsyncSite<T>(prefix: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** Scan one rendered article through the same entry point the build calls. */
function findingsFor(html: string): string[] {
  return withSite('client-marker-scan-', (root) => {
    writeFileSync(join(root, 'index.html'), `<!doctype html><main>${html}</main>`, 'utf8');
    return scanResidue(root).findings;
  });
}

/** Every file under a directory, including Pagefind's nested fragments. */
function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

test('only genuinely rendered client math receives the path exemption', async () => {
  assert.equal(MATH_MODE, 'client', 'the client math adapter was not selected');
  assert.equal(DIAGRAM_MODE, 'client', 'the client diagram adapter was not selected');

  // Each stimulus goes through Markdown, the sanitizer, marker substitution, and
  // the scanner. These are the author-reachable shapes that defeated the old
  // language-class key or weaker drafts of the marker predicate.
  const forgeries = [
    ['a language-math fence', `\`\`\`language-math\n${HOST_PATH}\n\`\`\`\n`],
    ['raw HTML carrying the old class', `<code class="language-math">${HOST_PATH}</code>`],
    ['the marker attribute itself', `<code ${RENDERED_MARKER}="${RENDERED_MATH}">${HOST_PATH}</code>`],
    ['the marker as ordinary prose', `The text ${RENDERED_MARKER}="${RENDERED_MATH}" precedes ${HOST_PATH}.`],
    [
      'the marker inside another attribute value',
      `<code title="${RENDERED_MARKER}=&quot;${RENDERED_MATH}&quot;">${HOST_PATH}</code>`,
    ],
    ['an attributed code element with no marker', `<code title="ordinary">${HOST_PATH}</code>`],
  ] as const;

  for (const [what, markdown] of forgeries) {
    const { html } = await renderMarkdown(markdown, { pageTitle: 'x' });
    assert.ok(html.includes(HOST_PATH), `${what}: the path never reached the scanner, so the stimulus proves nothing: ${html}`);
    assert.ok(
      !MARKED_ROOT(RENDERED_MATH).test(html),
      `${what}: author content forged a marker in an element attribute: ${html}`,
    );
    const findings = findingsFor(html);
    assert.ok(
      findings.some((finding) => finding.includes('absolute local path')),
      `${what}: a forged region disabled the path rule: ${findings.join('; ')}`,
    );
    assert.deepEqual(scriptBudgetFor(html).earned, [], `${what}: author content earned a client-runtime allowance`);
    assert.equal(scriptBudgetFor(html).ceiling, BASE_SCRIPT_BUDGET_BYTES, `${what}: forged content raised the script ceiling`);
  }

  // Positive control: the same path-shaped bytes are ordinary TeX and are clean
  // only after the client renderer minted the attribute after sanitization.
  const genuine = await renderMarkdown(String.raw`$$
f:\mathbb{R}
$$
`, { pageTitle: 'x' });
  assert.match(genuine.html, MARKED_ROOT(RENDERED_MATH), 'genuine client math received no rendered marker');
  assert.ok(genuine.html.includes(String.raw`f:\mathbb`), `the path-shaped TeX did not reach the page: ${genuine.html}`);
  assert.deepEqual(findingsFor(genuine.html), [], 'genuine client math was not exempted from the path-shaped TeX false positive');
  assert.deepEqual(scriptBudgetFor(genuine.html).earned, ['math'], 'genuine client math earned no math-runtime allowance');

  const diagram = await renderMarkdown('```mermaid\ngraph TD\n  A --> B\n```\n', { pageTitle: 'x' });
  assert.match(diagram.html, MARKED_ROOT(RENDERED_DIAGRAM), 'genuine client diagram received no rendered marker');
  assert.deepEqual(
    scriptBudgetFor(diagram.html).earned,
    ['a diagram'],
    'genuine client diagram earned no diagram-runtime allowance',
  );

  // Negative control outside math: the exemption must not become a general
  // prose exemption merely because client mode is active. Highlighted code is
  // covered below at the Pagefind surface, which joins Prism's inline spans.
  const leaked = await renderMarkdown(`A leaked path: ${HOST_PATH}.`, { pageTitle: 'x' });
  assert.ok(
    findingsFor(leaked.html).some((finding) => finding.includes('absolute local path')),
    `a real path outside math was exempted: ${leaked.html}`,
  );
});

test('Pagefind indexes the rendered page text but not its marker attribute', async () => {
  const rendered = await renderMarkdown(
    `See $$x^2$$ beside markerindexsentinel.\n\n\`\`\`bash\ncd ${HOST_PATH}\n\`\`\`\n`,
    { pageTitle: 'x' },
  );
  assert.match(rendered.html, MARKED_ROOT(RENDERED_MATH), 'the indexed fixture carries no marker, so absence would prove nothing');

  await withAsyncSite('client-marker-index-', async (root) => {
    writeFileSync(
      join(root, 'index.html'),
      `<!doctype html><html lang="en"><body data-pagefind-body>${rendered.html}</body></html>`,
      'utf8',
    );
    assert.equal(await indexWithPagefind(root), 1, 'Pagefind indexed no page');

    const fragments = filesUnder(join(root, 'pagefind')).filter((file) => file.endsWith('.pf_fragment'));
    assert.ok(fragments.length > 0, 'Pagefind wrote no fragment, so there is no index surface to inspect');
    const indexed = fragments.map((file) => gunzipSync(readFileSync(file)).toString('utf8')).join('\n');
    assert.ok(indexed.includes('markerindexsentinel'), 'the fragment carries none of the page text, so marker absence is vacuous');
    assert.ok(!indexed.includes(RENDERED_MARKER), 'Pagefind indexed the renderer-owned marker attribute');

    // Prism splits every backslash in the bash path into a punctuation span, so
    // the HTML byte scan cannot see the contiguous path. Pagefind's text
    // extraction rejoins it; this positive control proves both that the index
    // was inspected and that the final residue scan catches the real leak there.
    const indexedPath = HOST_PATH.replaceAll('\\', '\\\\');
    assert.ok(indexed.includes(indexedPath), `Pagefind did not rejoin the highlighted path: ${indexed}`);
    assert.ok(
      scanResidue(root).findings.some(
        (finding) => finding.includes('the search index') && finding.includes('absolute local path'),
      ),
      'the highlighted host path passed the final scan after Pagefind rejoined it',
    );
  });
}, 90_000);
