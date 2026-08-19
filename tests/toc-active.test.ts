/** Active TOC behavior, styling, and lazy loading share one contract. */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'vitest';

test('active TOC state is wired through aria-current location', () => {
  const script = readFileSync(new URL('../src/scripts/toc-active.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  assert.ok(script.includes("setAttribute('aria-current', 'location')"));
  assert.ok(script.includes("removeAttribute('aria-current')"));
  assert.ok(script.includes('getComputedStyle(document.documentElement).scrollPaddingTop'));
  assert.ok(!script.includes("addEventListener('hashchange'"));
  assert.ok(css.includes(".toc-list a[aria-current='location']"));
});

test('the TOC tracker is lazy-loaded only when a static TOC exists', () => {
  const layout = readFileSync(new URL('../src/layouts/Layout.astro', import.meta.url), 'utf8');
  assert.ok(layout.includes("querySelector('.toc')"));
  assert.ok(layout.includes("import('../scripts/toc-active.ts')"));
});
