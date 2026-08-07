/**
 * Contrast is the one design-token property that a person cannot check by
 * reading the file, so it is recomputed here from the palette declarations in
 * `src/styles/tokens.css`. The documented ratios in that file's header cannot
 * drift from its values without this test failing.
 */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { rules } from './css-cascade.ts';

const TOKENS = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

/** WCAG 2.2: 4.5:1 for normal text, 3:1 for large text and non-text UI. */
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/**
 * Reads the `light-dark(<light>, <dark>)` palette out of the stylesheet, so the
 * ratios below are measured against what actually ships rather than a copy.
 */
function palette(): { light: Record<string, string>; dark: Record<string, string> } {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const declaration = /--color-([a-z-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi;
  for (const [, name, lightValue, darkValue] of TOKENS.matchAll(declaration)) {
    light[name!] = lightValue!;
    dark[name!] = darkValue!;
  }
  return { light, dark };
}

const THEMES = Object.entries(palette());

/** Every foreground that carries text, against every background it sits on. */
const TEXT_PAIRS = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface-alt'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface-alt'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent', 'surface-alt'],
  ['link', 'bg'],
  ['link', 'surface'],
  ['link', 'surface-alt'],
] as const;

/** Non-text UI: the focus ring and any border that carries information. */
const NON_TEXT_PAIRS = [
  ['focus', 'bg'],
  ['focus', 'surface'],
  ['focus', 'surface-alt'],
  ['line-strong', 'bg'],
  ['line-strong', 'surface'],
  ['line-strong', 'surface-alt'],
] as const;

test('both palettes are fully declared', () => {
  for (const [theme, colors] of THEMES) {
    for (const name of ['bg', 'surface', 'surface-alt', 'text', 'muted', 'line', 'line-strong', 'accent', 'link', 'focus']) {
      assert.ok(colors[name], `${theme}: --color-${name} must be declared as a light-dark() pair`);
    }
  }
});

test('text colors meet WCAG 2.2 AA in both themes', () => {
  for (const [theme, colors] of THEMES) {
    for (const [fg, bg] of TEXT_PAIRS) {
      const ratio = contrast(colors[fg]!, colors[bg]!);
      assert.ok(
        ratio >= AA_TEXT,
        `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the ${AA_TEXT}:1 AA text minimum`,
      );
    }
  }
});

test('focus ring and strong borders meet the 3:1 non-text minimum', () => {
  for (const [theme, colors] of THEMES) {
    for (const [fg, bg] of NON_TEXT_PAIRS) {
      const ratio = contrast(colors[fg]!, colors[bg]!);
      assert.ok(
        ratio >= AA_NON_TEXT,
        `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the ${AA_NON_TEXT}:1 non-text minimum`,
      );
    }
  }
});

test('the documented ratios match the palette they describe', () => {
  // The header comment is the human-readable record; drift between it and the
  // declarations is exactly the failure this ticket has to prevent.
  const rows = TOKENS.matchAll(
    /^ \* {3}([a-z-]+) +on +([a-z-]+) +([\d.]+) +([\d.]+)[ \t\r]*$/gm,
  );
  const documented = [...rows];
  assert.ok(documented.length >= 10, 'the token file must document its measured ratios');

  const themes = Object.fromEntries(THEMES);
  for (const [, fg, bg, lightValue, darkValue] of documented) {
    for (const [theme, expected] of [
      ['light', lightValue!],
      ['dark', darkValue!],
    ] as const) {
      const colors = themes[theme]!;
      assert.ok(colors[fg!], `documented row names unknown token --color-${fg}`);
      assert.ok(colors[bg!], `documented row names unknown token --color-${bg}`);
      const actual = contrast(colors[fg!]!, colors[bg!]!);
      assert.equal(
        actual.toFixed(2),
        Number(expected).toFixed(2),
        `${theme}: documented ${fg} on ${bg} = ${expected} but the palette measures ${actual.toFixed(2)}`,
      );
    }
  }
});

test('the documented table covers every text-bearing pair the palette is tested on', () => {
  // Otherwise the record documents less than the palette actually guarantees,
  // and a reader trusts a table that is quietly incomplete.
  const documented = new Set(
    [...TOKENS.matchAll(/^ \* {3}([a-z-]+) +on +([a-z-]+) +[\d.]+ +[\d.]+[ \t\r]*$/gm)].map(
      ([, fg, bg]) => `${fg} on ${bg}`,
    ),
  );
  for (const [fg, bg] of [...TEXT_PAIRS, ...NON_TEXT_PAIRS]) {
    assert.ok(documented.has(`${fg} on ${bg}`), `${fg} on ${bg} is tested but not documented`);
  }
});

test('mixed zh-CN and English line breaking is handled explicitly', () => {
  const global = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

  // Requirements section 16 asks for explicit CJK and mixed zh/en breaking.
  // `word-break: normal` keeps English words whole while CJK still breaks
  // between characters; `line-break: strict` stops a line starting with a
  // CJK closing bracket. Without both, bilingual prose breaks visibly wrong.
  assert.match(global, /word-break:\s*normal/, 'word-break must be set explicitly for mixed text');
  assert.match(global, /line-break:\s*strict/, 'line-break must be set explicitly for CJK');
  assert.match(global, /overflow-wrap:\s*break-word/, 'a long unbroken token must wrap');

  // Both font stacks need a CJK face, or mixed text falls back to a different
  // family mid-sentence.
  const CJK_FACES = /PingFang|Hiragino Sans GB|Microsoft YaHei|Noto Sans SC|Source Han|CJK/;
  for (const stack of ['--font-sans', '--font-mono']) {
    const declared = new RegExp(`${stack}:([^;]*)`).exec(TOKENS);
    assert.ok(declared, `${stack} must be declared`);
    assert.match(declared[1]!, CJK_FACES, `${stack} has no CJK fallback face`);
  }
});

test('the low-contrast divider token is never used to carry information', () => {
  // `--color-line` measures 1.33:1 / 1.48:1 — decorative only. A focus ring or
  // a table gridline drawn with it would fail WCAG 1.4.11.
  const global = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  for (const rule of rules(global)) {
    if (!/var\(--color-line\)/.test(rule.body)) continue;
    assert.ok(
      !/(?:^|[\s>+~,])(?:th|td)\b/.test(rule.selector) && !/focus/.test(rule.selector),
      `"${rule.selector}" draws an informational edge with the decorative --color-line`,
    );
  }
});

test('the pre-paint script and the toggle module agree on the storage keys', () => {
  // `theme-init.js` cannot import from `preferences.ts` — it must stay a
  // classic, import-free script to load before first paint — so the two files
  // duplicate the key strings. Nothing but this test stops a rename in one from
  // silently orphaning the preference the other reads.
  const scripts = new URL('../src/scripts/', import.meta.url);
  const init = readFileSync(new URL('theme-init.js', scripts), 'utf8');
  const toggles = readFileSync(new URL('preferences.ts', scripts), 'utf8');

  const keys = (source: string) =>
    new Set([...source.matchAll(/'(thoughtscape:[a-z-]+)'/g)].map(([, key]) => key!));

  assert.deepEqual(
    [...keys(init)].sort(),
    [...keys(toggles)].sort(),
    'theme-init.js and preferences.ts read and write different storage keys',
  );
});

test('reduced motion is honored globally, not per component', () => {
  const global = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  assert.match(global, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(global, /animation-duration: 0\.01ms !important/);
  assert.match(global, /transition-duration: 0\.01ms !important/);
});

test('prose is constrained to a readable measure in every mode', () => {
  // Reader mode overrides `--measure` in global.css, so both files are read:
  // an override that leaves the 65-80 character target is the same defect as a
  // bad default.
  const global = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const declared = [...`${TOKENS}\n${global}`.matchAll(/--measure:\s*(\d+)ch/g)];
  assert.ok(declared.length > 0, '--measure must be declared in ch units');

  for (const [, value] of declared) {
    const measure = Number(value);
    assert.ok(
      measure >= 65 && measure <= 80,
      `--measure is declared as ${measure}ch, outside the 65-80 character target`,
    );
  }
});
