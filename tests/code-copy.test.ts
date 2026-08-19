/** Code-copy behavior and styling share one selector contract. */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'vitest';

test('the inserted copy control has matching behavior and CSS selectors', () => {
  const script = readFileSync(new URL('../src/scripts/code-copy.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/code.css', import.meta.url), 'utf8');
  const className = /button\.className = '([^']+)'/.exec(script)?.[1];
  assert.equal(className, 'code-copy', 'the runtime no longer inserts the expected control class');
  assert.match(css, new RegExp(`\\.${className}(?:[:\\s,{])`));
  assert.ok(script.includes(`figure.querySelector('.${className}')`), 'duplicate insertion guard uses another selector');
});

test('the code-copy module is reached by a conditional dynamic import', () => {
  const layout = readFileSync(new URL('../src/layouts/Layout.astro', import.meta.url), 'utf8');
  assert.match(layout, /querySelector\('\.prose\[data-code-copy\] \.code-block'\)/);
  assert.match(layout, /import\('\.\.\/scripts\/code-copy\.ts'\)/);
});
