/**
 * The client diagram runtime, in a real browser.
 *
 * **This file exists because `src/lib/diagram-mode.ts` claims the client path
 * "was verified end to end at 0 CSP violations in both themes", and two defects
 * had made that false with every static gate still green.** Both are invisible
 * outside a browser: one is an XML namespace error that only a real DOMParser
 * raises, the other is a DOM event nothing else fires.
 *
 * It runs whatever `DIAGRAM_MODE` says, deliberately. The subject is
 * `src/scripts/diagram.ts` — the runtime the later flip will turn on — not the
 * build's output, so skipping in build-time mode would leave the flip depending
 * on a file no gate had executed since the day it was written.
 *
 * The corpus is bundled and served here rather than read from `dist/`, for the
 * same reason `tests/backlink-surfaces.test.ts` builds its own: build-time mode
 * emits no client runtime at all, so there is nothing in `dist/` to drive.
 */

import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test, type TestContext } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Two cold Mermaid imports plus eight renders, in a browser. */
const BROWSER_TIMEOUT = 300_000;

/**
 * The corpus. `c4` is the case defect 1 was about and is the only one of the
 * eight that reproduced it — it is the only type that emits `<image xlink:href>`
 * — so a fixture without it measures the fix over seven diagrams that were
 * never broken.
 */
const NL = String.fromCharCode(10);
const DIAGRAMS: readonly (readonly [string, string])[] = [
  ['flowchart', ['graph TD', '  A[Start] --> B{Choice}', '  B -->|yes| C[Do]'].join(NL)],
  ['sequence', ['sequenceDiagram', '  Alice->>Bob: Hello', '  Bob-->>Alice: Hi'].join(NL)],
  ['state', ['stateDiagram-v2', '  [*] --> Idle', '  Idle --> Busy', '  Busy --> [*]'].join(NL)],
  ['c4', ['C4Context', '  title System', '  Person(u, "User", "a user")'].join(NL)],
];

let server: Server | undefined;
let origin = '';
let scratch = '';
let launched: { browser: unknown } | { unavailable: string } | undefined;
/** Mermaid's own package directory, served so the browser can import it. */
let mermaidDir = '';



beforeAll(async () => {
  const { chromium } = (await import('playwright')) as { chromium: { launch: () => Promise<unknown> } };
  try {
    launched = { browser: await chromium.launch() };
  } catch (error) {
    launched = { unavailable: `no browser: ${error instanceof Error ? error.message : String(error)}` };
    return;
  }

  scratch = mkdtempSync(join(tmpdir(), 'diagram-client-'));
  const site = join(scratch, 'site');

  // **The runtime is served as its own source with an import map, not bundled.**
  // Bundling needed rolldown, which is a *transitive* dependency — pnpm's
  // symlinked tree gives it no top-level entry, so reaching it meant a literal
  // `node_modules/.pnpm/rolldown@1.2.2/...` path. `CLAUDE.md` names that
  // boundary exactly: "a module that imports a package absent from
  // `package.json` fails to resolve rather than silently borrowing it from a
  // transitive dependency." Verified — a bare `import('rolldown')` inside vitest
  // fails with `Cannot find package`.
  //
  // `mermaid` *is* declared, and ships `mermaid.esm.min.mjs`: no bare imports,
  // loading its own chunks by relative path. So the browser resolves the one
  // bare specifier through an import map and the server hands it the real
  // package directory. The runtime under test is served as TypeScript-free
  // source with its types stripped by the same `tsc`-less path Node uses.
  mkdirSync(site, { recursive: true });

  // `module.stripTypeScriptTypes` is Node's own transform — the same one that
  // runs `.ts` files in this repository — so no bundler and no dependency is
  // needed to put the real runtime in a browser.
  const { stripTypeScriptTypes } = await import('node:module');
  writeFileSync(
    join(site, 'diagram.js'),
    // The one bare specifier the runtime imports, rewritten to the path this
    // server hands mermaid's real package directory at. An import map was the
    // first attempt and is inert here: a map is an *inline* script, which the
    // served CSP's `script-src 'self'` blocks outright — measured, the browser
    // reported `Executing inline script violates ...` and nothing rendered.
    // Same trap as the inline `<style>` above, one element along.
    stripTypeScriptTypes(readFileSync(join(ROOT, 'src', 'scripts', 'diagram.ts'), 'utf8'), {
      mode: 'strip',
    })
      .split("'mermaid'")
      .join("'/mermaid/mermaid.esm.min.mjs'")
      .split('"mermaid"')
      .join("'/mermaid/mermaid.esm.min.mjs'"),
    'utf8',
  );
  mermaidDir = dirname(createRequire(join(ROOT, 'package.json')).resolve('mermaid'));

  // **A linked stylesheet, not an inline `<style>`.** The page is served under
  // the site's own CSP, whose `style-src` is `'self'` — an inline block is
  // blocked, every custom property is unset, and `currentThemeVariables()`
  // resolves the whole palette to `rgb(0, 0, 0)` in both themes. Measured: the
  // first version of this fixture did exactly that and reported the theme gate
  // red against a runtime that was working.
  writeFileSync(
    join(site, 'probe.css'),
    `:root { color-scheme: light dark;
  --color-bg: light-dark(#fbfaf7, #10141a);
  --color-surface: light-dark(#ffffff, #161b21);
  --color-surface-alt: light-dark(#f2f0ea, #1d232b);
  --color-text: light-dark(#1b1f24, #e6e9ee);
  --color-line-strong: light-dark(#767d87, #8b939e); }
:root[data-theme="dark"] { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }`,
    'utf8',
  );

  const figures = DIAGRAMS.map(
    ([name, source]) =>
      `<figure class="diagram" data-diagram="mermaid"><pre class="diagram-source">${source}</pre>` +
      `<figcaption>${name} diagram</figcaption></figure>`,
  ).join('');
  writeFileSync(
    join(site, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>diagram probe</title>` +
      `<link rel="stylesheet" href="/probe.css">` +
      `</head><body>${figures}` +
      `<script type="module" src="/diagram.js"></script></body></html>`,
    'utf8',
  );

  // The shipped policy, read from the file that ships it rather than restated.
  const headers = readFileSync(join(ROOT, 'public', '_headers'), 'utf8');
  const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1]?.trim();
  assert.ok(csp, 'public/_headers declares no CSP, so this gate would test no policy');

  const types: Record<string, string> = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.html': 'text/html',
    '.css': 'text/css',
  };
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]!;
    const file = path.startsWith('/mermaid/')
      ? join(mermaidDir, path.slice('/mermaid/'.length))
      : join(site, path === '/' ? 'index.html' : path);
    if (!existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': csp,
    });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, BROWSER_TIMEOUT);

afterAll(async () => {
  if (launched !== undefined && 'browser' in launched) {
    await (launched.browser as { close: () => Promise<void> }).close();
  }
  server?.close();
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
  // `browser.close()`, measured under the suite's own contention at p50 22.4 s
  // and max 43.3 s, and observed in this hook at 15.8 s, 40.2 s, and 55.8 s.
  // 180 s is four times the contended max; `tests/search.test.ts:368` carries
  // the full measurement and the reason a spread this wide is not budgeted from
  // its mean.
}, 180_000);

/** A loaded page with every diagram drawn, or a skip when no browser exists. */
async function drawn(context: TestContext): Promise<{
  page: { evaluate: (fn: unknown, arg?: unknown) => Promise<never>; waitForTimeout: (ms: number) => Promise<void>; close: () => Promise<void> };
}> {
  assert.ok(launched !== undefined, 'the suite setup did not run');
  if ('unavailable' in launched) return context.skip(launched.unavailable) as never;
  const browser = launched.browser as { newPage: (o?: unknown) => Promise<never> };
  const page = (await browser.newPage({ colorScheme: 'light' })) as never as {
    goto: (url: string, o?: unknown) => Promise<void>;
    evaluate: (fn: unknown, arg?: unknown) => Promise<never>;
    waitForTimeout: (ms: number) => Promise<void>;
    close: () => Promise<void>;
  };
  await page.goto(origin, { waitUntil: 'networkidle' });
  // The runtime renders behind an `IntersectionObserver` with a 200px margin,
  // and Mermaid's import is ~1.4 s cold. Polled rather than slept, so a fast
  // machine does not wait and a slow one does not fail.
  await page.evaluate(() => {
    const done = (): boolean =>
      [...document.querySelectorAll('figure.diagram')].every(
        (figure) => figure.querySelector('.diagram-canvas') !== null || figure.querySelector('.diagram-source') === null,
      );
    return new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = (): void => {
        if (done() || Date.now() - started > 90_000) resolve();
        else setTimeout(tick, 200);
      };
      tick();
    });
  });
  return { page: page as never };
}

/**
 * Every diagram type draws; none falls back to its source.
 *
 * **The assertion is the absence of the fallback, not the presence of an SVG.**
 * A `parsererror` document still has a root element, so a gate asking "is there
 * an `<svg>`" passes on the failure this exists to catch. What distinguishes
 * them is the `<pre class="diagram-source">`: `renderInto` replaces it only on
 * success, so a figure still holding one is a figure that failed.
 *
 * **Mutation watched fail:** removing the `xmlns:xlink` declaration from
 * `src/scripts/diagram.ts` turns this red on `c4` alone — measured, with the
 * other three unaffected, because C4 is the only type that emits
 * `<image xlink:href>`. The browser's own message is
 * `Namespace prefix xlink for href on image is not defined`.
 */
test('every diagram type renders in the browser rather than falling back to source', async (context) => {
  const { page } = await drawn(context);
  try {
    const figures = await page.evaluate(() =>
      [...document.querySelectorAll('figure.diagram')].map((figure) => ({
        name: figure.querySelector('figcaption')?.textContent ?? '?',
        drawn: figure.querySelector('.diagram-canvas') !== null,
        fellBack: figure.querySelector('.diagram-source') !== null,
      })),
    );

    assert.equal(
      (figures as unknown as unknown[]).length,
      DIAGRAMS.length,
      'the fixture did not reach the browser, so this gate measured nothing',
    );
    for (const figure of figures as unknown as { name: string; drawn: boolean; fellBack: boolean }[]) {
      assert.ok(figure.drawn, `${figure.name}: did not render`);
      assert.ok(!figure.fellBack, `${figure.name}: fell back to its source, so the render failed`);
    }
  } finally {
    await page.close();
  }
}, BROWSER_TIMEOUT);

/**
 * A drawn diagram follows the theme toggle.
 *
 * Mermaid bakes the palette into the SVG, so this is a re-render rather than a
 * restyle — which is why build-time mode, whose `light-dark()` values the
 * browser re-resolves, never had the problem.
 *
 * **Asserted on the colours Mermaid wrote, not on computed style.** The
 * palette arrives as `fill`/`stroke` attributes and inline `style`, and a
 * computed-style read returns the same resolved value either way once the SVG
 * is in the document — measured, 0 of 60 samples differed even on a working
 * runtime, because the attribute is what changes.
 *
 * **Mutation watched fail:** deleting the `configure(mermaid)` call from the
 * redraw turns this red with 0 colours changed — the diagram re-renders and
 * draws the same palette, since `initialize` is what installs it.
 */
test('a drawn diagram re-renders when the theme changes', async (context) => {
  const { page } = await drawn(context);
  try {
    const palette = (): Promise<string[]> =>
      page.evaluate(() =>
        [...document.querySelectorAll('figure.diagram svg *')]
          .map((node) => `${node.getAttribute('fill') ?? ''}|${node.getAttribute('stroke') ?? ''}`)
          .filter((value) => /#|rgb/i.test(value)),
      ) as never;

    const before = (await palette()) as unknown as string[];
    assert.ok(
      before.length > 0,
      'no drawn shape carries a colour, so a change in colour could not be observed',
    );

    await page.evaluate(() => {
      document.documentElement.dataset['theme'] = 'dark';
    });
    // The redraw is async: a Mermaid re-render per figure.
    await page.evaluate(() => {
      const started = Date.now();
      return new Promise<void>((resolve) => {
        const tick = (): void => {
          const pending = document.querySelectorAll('figure.diagram .diagram-source').length;
          if ((pending === 0 && Date.now() - started > 1500) || Date.now() - started > 90_000) resolve();
          else setTimeout(tick, 200);
        };
        tick();
      });
    });
    const after = (await palette()) as unknown as string[];

    // **The gate would pass on total destruction without this**, and review
    // caught it: if every figure fell back to its source, `after` is `[]`,
    // every `after[index]` is `undefined`, and the index-wise comparison counts
    // *all* of them as changed. Executed — `before.length 4, after.length 0,
    // changed 4` — a green result reporting the worst possible outcome, which
    // is `docs/gate-reading.md` case 6 in this file's own instrument.
    //
    // Equal lengths are also what makes the index-wise comparison meaningful at
    // all: it assumes the two palettes enumerate the same elements in the same
    // order, and nothing else here checks that.
    assert.equal(
      after.length,
      before.length,
      `the theme change left ${after.length} coloured shapes where there were ${before.length} — ` +
        'the diagrams were destroyed rather than re-rendered',
    );

    const changed = before.filter((value, index) => value !== after[index]).length;
    assert.ok(
      changed > 0,
      `the theme changed and ${before.length} drawn colours all stayed the same, so the diagram ` +
        'is still showing its light-mode palette',
    );

    // And nothing fell back to source, which the count above cannot see once
    // the lengths match.
    const fellBack = await page.evaluate(() => document.querySelectorAll('figure.diagram .diagram-source').length);
    assert.equal(fellBack as unknown as number, 0, 'a figure fell back to its source during the re-render');
  } finally {
    await page.close();
  }
}, BROWSER_TIMEOUT);
