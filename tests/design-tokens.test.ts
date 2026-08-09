/**
 * Contrast is the one design-token property that a person cannot check by
 * reading the file, so it is recomputed here from the palette declarations in
 * `src/styles/tokens.css`. The documented ratios in that file's header cannot
 * drift from its values without this test failing.
 */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { appliesByDefault, declaration, rules, specificity, splitSelectorList, wins } from './css-cascade.ts';

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
  // Syntax tokens sit on `surface-alt` in practice; all three are covered so a
  // later ticket moving the code block cannot silently drop one below AA.
  ['syntax-keyword', 'bg'],
  ['syntax-keyword', 'surface'],
  ['syntax-keyword', 'surface-alt'],
  ['syntax-literal', 'bg'],
  ['syntax-literal', 'surface'],
  ['syntax-literal', 'surface-alt'],
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
    for (const name of [
      'bg', 'surface', 'surface-alt', 'text', 'muted', 'line', 'line-strong', 'accent', 'link',
      'focus', 'syntax-keyword', 'syntax-literal',
    ]) {
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

test('no syntax token is distinguished by colour alone', () => {
  // WCAG 1.4.1. Colour is the primary channel for highlighting, so the two roles
  // a reader most needs to separate from ordinary code — a comment, which is
  // prose to skip, and a keyword, which is structure — carry a second signal in
  // weight or style. Without one, a code block is undifferentiated for a reader
  // with a colour vision deficiency and on a printed page.
  const global = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  for (const marker of ['token-comment', 'token-keyword']) {
    const rule = rules(global).find((candidate) => candidate.selector.includes(`.${marker}`));
    assert.ok(rule, `no rule styles .${marker}`);
    assert.match(
      rule.body,
      /font-(?:weight|style):/,
      `.${marker} is distinguished by colour alone; add a weight or style`,
    );
  }
});

test('prose rules do not outrank the markdown classes they contain', () => {
  // The trap TK-02 documented for `[data-js-only]` losing to `.site-nav button`,
  // in a second place: `.prose a` and `.prose blockquote` are (0,1,1), so a bare
  // `.heading-anchor` or `.callout` rule at (0,1,0) loses and the declaration
  // silently does nothing. It shipped that way — the heading anchor's `#` was
  // underlined by `.prose a` — and a rule that exists but never applies is worse
  // than a missing one, because the coverage gate counts it as styled.
  const global = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const declared = rules(global).filter(appliesByDefault);

  for (const [marker, property, container] of [
    ['heading-anchor', 'text-decoration', '.prose a'],
    ['data-footnote-backref', 'text-decoration', '.prose a'],
    ['callout', 'color', '.prose blockquote'],
  ] as const) {
    const contender = declared.find(
      (rule) => rule.selector.includes(`.${marker}`) && declaration(rule.body, property),
    );
    assert.ok(contender, `no rule sets ${property} on .${marker}`);
    const loser = {
      specificity: specificity(contender.selector),
      important: declaration(contender.body, property)!.important,
      order: contender.order,
    };

    for (const rule of declared) {
      if (!rule.selector.includes(container) || !declaration(rule.body, property)) continue;
      for (const selector of splitSelectorList(rule.selector)) {
        if (!selector.includes(container)) continue;
        const winner = {
          specificity: specificity(selector),
          important: declaration(rule.body, property)!.important,
          order: rule.order,
        };
        assert.ok(
          !wins(winner, loser),
          `"${selector}" (${winner.specificity}) beats "${contender.selector}" (${loser.specificity}) ` +
            `on ${property}, so the markdown class's rule never applies`,
        );
      }
    }
  }
});

test('every named font face is one the reader already has', () => {
  // `Inter` was in the sans stack with no `@font-face` and no font file
  // anywhere in the repository, so it resolved to nothing on almost every
  // machine — a name that looked like a design decision and was not one.
  // Naming a face means shipping it: a family that is neither a generic, nor a
  // system UI keyword, nor a face that ships with a major OS needs an
  // `@font-face` and a same-origin file, which is also what `font-src 'self'`
  // in `public/_headers` commits to.
  const SYSTEM_FACES = new Set([
    // CSS generics and system keywords.
    'sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
    '-apple-system',
    // Bundled with Windows, macOS, iOS, or Android.
    'Segoe UI', 'Roboto', 'Helvetica Neue', 'Cascadia Code', 'SFMono-Regular', 'Menlo', 'Consolas',
    'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', 'Noto Sans Mono CJK SC',
    'Source Han Sans SC',
  ]);

  const selfHosted = new Set(
    [...TOKENS.matchAll(/@font-face[^}]*font-family:\s*'?([^;'"]+)'?/g)].map(([, name]) => name!.trim()),
  );

  for (const stack of ['--font-sans', '--font-mono']) {
    const declared = new RegExp(`${stack}:([^;]*)`).exec(TOKENS);
    assert.ok(declared, `${stack} must be declared`);
    for (const face of declared[1]!.split(',')) {
      const name = face.trim().replace(/^'|'$/g, '');
      if (name === '') continue;
      assert.ok(
        SYSTEM_FACES.has(name) || selfHosted.has(name),
        `${stack} names "${name}", which is neither a system face nor self-hosted with an @font-face`,
      );
    }
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
