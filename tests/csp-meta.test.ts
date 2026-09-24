/**
 * The Content-Security-Policy reaches a host that ignores `_headers`.
 *
 * `public/_headers` is Cloudflare Pages' format. GitHub Pages — the documented
 * zero-secret path — and any plain static server ignore it, so without a
 * `<meta http-equiv>` those hosts serve the site with no policy at all. This
 * file gates both halves of the fix:
 *
 * 1. **Equality.** Every built page carries exactly one meta policy, placed
 *    before any script or stylesheet, equal to the `/*` rule's policy in
 *    `public/_headers` minus the directives CSP3 forbids in a meta element
 *    (`frame-ancestors`, `report-uri`, `report-to`, `sandbox`). The expected
 *    value is computed here from the file, not copied from the layout.
 * 2. **Enforcement.** The site is served with **no headers at all**, and the
 *    page still runs — theme init, the search dialog, a lazy preview through
 *    the Worker and WASM — with no CSP violation. A page with an inline script
 *    injected into its built HTML reports that script blocked, which is the
 *    control proving the meta element, not the server, is what enforces it.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, Page } from 'playwright';

import { buildSite, removeWorkspace, serveDist, shippedHeaders, type BuiltSite, type ServedSite } from './support/browser-site.ts';

const META_UNSUPPORTED = ['frame-ancestors', 'report-uri', 'report-to', 'sandbox'];

const CORPUS = {
  'alpha.md': '# Alpha\n\nLinks to [[beta]].\n',
  'beta.md': '# Beta\n\nBeta body text.\n',
};

let built: BuiltSite;
let server: ServedSite;
let browser: Browser;
let emptyHeaders = '';

function expectedPolicy(): string {
  const header = shippedHeaders()['Content-Security-Policy'];
  assert.ok(header, 'public/_headers declares no site-wide Content-Security-Policy');
  const directives = header.split(';').map((directive) => directive.trim()).filter(Boolean);
  // The control that keeps the subtraction meaningful: the header has to carry
  // at least one directive a meta policy cannot, or "minus" subtracts nothing.
  assert.ok(
    directives.some((directive) => META_UNSUPPORTED.includes(directive.split(/\s+/)[0]!)),
    'the shipped header carries no meta-unsupported directive, so the subtraction is untested',
  );
  return directives.filter((directive) => !META_UNSUPPORTED.includes(directive.split(/\s+/)[0]!)).join('; ');
}

function htmlFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'pagefind') found.push(...htmlFiles(path));
    } else if (name.endsWith('.html')) found.push(path);
  }
  return found;
}

/** Collect every CSP violation the page reports, from before its first byte. */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { __violations: string[] };
    state.__violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      state.__violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
}

beforeAll(async () => {
  built = buildSite(CORPUS);
  // A host that ignores `_headers`: the server applies an empty rule file.
  emptyHeaders = join(built.workspace, 'no-headers');
  writeFileSync(emptyHeaders, '', 'utf8');
  server = await serveDist(built.dist, { headersFile: emptyHeaders });
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (built !== undefined) removeWorkspace(built.workspace);
}, 180_000);

test('every built page carries the _headers policy as a meta element, minus what meta cannot carry', () => {
  const expected = expectedPolicy();
  const pages = htmlFiles(built.dist);
  assert.ok(pages.length > 0, 'the build produced no HTML, so this gate read nothing');
  for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/gi)];
    assert.equal(metas.length, 1, `${file}: expected exactly one meta CSP, found ${metas.length}`);
    const content = metas[0]![1]!.replaceAll('&#39;', "'").replaceAll('&apos;', "'");
    assert.equal(content, expected, `${file}: the meta policy differs from public/_headers`);
    for (const directive of META_UNSUPPORTED) {
      assert.ok(!content.includes(directive), `${file}: the meta policy carries ${directive}, which meta ignores`);
    }
    // A meta policy governs only what the parser meets after it.
    const at = metas[0]!.index!;
    const firstResource = html.search(/<script\b|<link\b[^>]*rel="stylesheet"|<style\b/i);
    assert.ok(firstResource === -1 || at < firstResource, `${file}: a script or stylesheet precedes the meta CSP`);
  }
});

test('served with no headers, the page runs under the meta policy and blocks an injected inline script', async () => {
  const page = await browser.newPage();
  await recordViolations(page);
  const response = await page.goto(`${server.origin}/notes/alpha/`, { waitUntil: 'load' });
  assert.equal(
    response?.headers()['content-security-policy'],
    undefined,
    'the server sent a CSP header, so this does not measure a host that ignores _headers',
  );
  // Theme init is the render-blocking external script; it sets `data-js`.
  assert.equal(await page.evaluate(() => document.documentElement.dataset['js']), 'on', 'theme init did not run');
  // The Worker, WASM, and snapshot run under `worker-src`, `script-src
  // 'wasm-unsafe-eval'`, and `connect-src` — the directives most likely to bite.
  await page.locator('article a[href="/notes/beta/"]').first().hover();
  await page.locator('#link-preview').waitFor({ state: 'visible', timeout: 15_000 });
  await page.keyboard.press('/');
  await page.locator('#search-dialog').waitFor({ state: 'visible', timeout: 10_000 });
  await page.fill('#search-input', 'Beta');
  await page.locator('#search-results a').first().waitFor({ state: 'visible', timeout: 20_000 });
  assert.deepEqual(await violations(page), [], 'the shipped site violates its own meta policy');
  await page.close();

  // The control: an inline script injected after the meta element must be
  // blocked by it. Without the meta element nothing would block it here.
  const file = join(built.dist, 'notes', 'beta', 'index.html');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('</head>', '<script>window.__inlineRan = true;</script></head>'), 'utf8');
  try {
    const probe = await browser.newPage();
    await recordViolations(probe);
    await probe.goto(`${server.origin}/notes/beta/`, { waitUntil: 'load' });
    assert.equal(
      await probe.evaluate(() => (window as unknown as { __inlineRan?: boolean }).__inlineRan ?? false),
      false,
      'an inline script ran on a page served without headers, so the meta policy is not enforced',
    );
    assert.ok(
      (await violations(probe)).some((entry) => entry.startsWith('script-src')),
      'the blocked inline script reported no script-src violation',
    );
    await probe.close();
  } finally {
    writeFileSync(file, original, 'utf8');
  }
}, 120_000);
