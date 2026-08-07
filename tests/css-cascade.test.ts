/**
 * Adversarial tests for the gate parsers.
 *
 * The parsers in `css-cascade.ts` decide whether the CSP and no-JavaScript
 * gates pass, so a wrong answer there is a gate that silently misses a real
 * defect. Every case below is an evasion an `xhigh` review actually landed
 * against an earlier version of these parsers, kept as a regression.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appliesByDefault,
  declaration,
  excludesDefaultScreen,
  fixedWidthOver,
  minWidthFloor,
  rules,
  specificity,
  splitSelectorList,
  startTags,
  wins,
  type Specificity,
} from './css-cascade.ts';

function tuple(selector: string): string {
  return specificity(selector).join(',');
}

test('a value that commits to a width wider than the limit is measured', () => {
  const over = (value: string) => fixedWidthOver(value, 320) !== undefined;

  // A fixed length in any absolute or root-relative unit.
  for (const value of ['400px', '400pt', '30rem', '50ch', '10cm', '5in']) {
    assert.ok(over(value), `${value} is wider than 320px and must be measured`);
  }
  // `max()` returns at least its largest argument; a `calc()` that adds to a
  // percentage is the classic overflow bug. Neither is flexible for containing
  // a `%`, which is what an earlier version of this check assumed.
  assert.ok(over('max(400px, 10%)'));
  assert.ok(over('calc(100% + 400px)'));
  assert.ok(over('calc(400px + 2rem)'));
});

test('a value that can shrink below the limit is not measured', () => {
  const over = (value: string) => fixedWidthOver(value, 320) !== undefined;

  for (const value of [
    '400px',
    '100%',
    'auto',
    'min(400px, 100%)',
    'clamp(1rem, 50%, 400px)',
    'calc(100% - 400px)',
    'calc(100vw - 400px)',
    'var(--width-page)',
    'fit-content',
    '320px',
    '20rem',
  ]) {
    if (value === '400px') continue; // The control: this one must be measured.
    assert.equal(over(value), false, `${value} cannot force overflow and must be skipped`);
  }
  assert.ok(over('400px'), 'the control case must still be measured');
});

test('a min-width condition reports its floor in pixels', () => {
  assert.equal(minWidthFloor('@media (min-width: 48rem)'), 768);
  assert.equal(minWidthFloor('@media (width >= 320px)'), 320);
  assert.equal(minWidthFloor('@media print'), 0);
  assert.equal(minWidthFloor('@supports (display: grid)'), 0);
});

test('a "}" inside a string does not end a rule early', () => {
  // A quote-blind `indexOf('}')` ends the rule inside the string, and the rest
  // of the sheet is then parsed as one garbage rule — every stylesheet gate
  // passes vacuously against a sheet that no longer exists.
  const parsed = rules('.a::after{content:"}"}.site-nav button{display:inline-flex}');
  assert.deepEqual(
    parsed.map((rule) => rule.selector),
    ['.a::after', '.site-nav button'],
  );
  assert.equal(parsed[1]?.body, 'display:inline-flex');
});

test('a brace inside url() does not end a rule early', () => {
  const parsed = rules(".a{background:url('x}y.png')}button{display:block}");
  assert.deepEqual(
    parsed.map((rule) => rule.selector),
    ['.a', 'button'],
  );
});

test('a declaration-only at-rule does not swallow the rule after it', () => {
  // `@font-face` holds declarations, not rules. Treating it as a container
  // leaves them unconsumed, and they become the next rule's selector.
  for (const atRule of [
    '@font-face{font-family:X;src:url(a.woff2)}',
    '@property --z{syntax:"<length>";inherits:false}',
    '@page{margin:1cm}',
    '@keyframes spin{from{opacity:0}to{opacity:1}}',
    '@counter-style x{system:cyclic}',
  ]) {
    const parsed = rules(`${atRule}button{display:inline-flex}`);
    assert.deepEqual(
      parsed.map((rule) => rule.selector),
      ['button'],
      atRule,
    );
    assert.deepEqual(parsed[0]?.conditions, [], atRule);
  }
});

test('a declaration-only at-rule does not strip the conditions from later rules', () => {
  // `@page{…}` before the print block made every print rule read as
  // unconditional, so the gate reasoned about a screen cascade that includes
  // `display: none` on the header.
  const parsed = rules('@page{margin:1cm}@media print{.site-header{display:none}}');
  assert.equal(parsed.length, 1);
  assert.equal(appliesByDefault(parsed[0]!), false);
});

test('a container at-rule keeps its nested rules', () => {
  const parsed = rules('@layer base{a{color:red}}@container (width>30em){b{color:blue}}');
  assert.deepEqual(
    parsed.map((rule) => [rule.selector, rule.conditions.length]),
    [
      ['a', 1],
      ['b', 1],
    ],
  );
});

test('legacy one-colon pseudo-elements count in the type column', () => {
  for (const name of ['before', 'after', 'first-line', 'first-letter']) {
    assert.equal(tuple(`.prose a:${name}`), '0,1,2', `:${name}`);
    assert.equal(tuple(`a:${name}`), '0,0,2', `:${name}`);
  }
});

test('an escaped character does not read as a new selector component', () => {
  assert.equal(tuple('.a\\.b'), '0,1,0');
  assert.equal(tuple('#a\\#b'), '1,0,0');
});

test('a quote inside a differently quoted value does not desync blanking', () => {
  // Two separate blanking passes let the double-quote pass open a phantom
  // region at the `"` inside a single-quoted value, swallowing the real
  // attributes after it and disarming the inline-handler gate.
  const [handler] = [...startTags(`<img alt='it"s' onerror="steal()">`)];
  assert.match(handler!, /\sonerror=/);

  const [style] = [...startTags(`<div title='a"b' style="width:9999px">`)];
  assert.match(style!, /\sstyle=/);
});

test('specificity counts each selector component in the right column', () => {
  const cases: [string, Specificity][] = [
    ['*', [0, 0, 0]],
    ['button', [0, 0, 1]],
    ['.site-nav', [0, 1, 0]],
    ['#main', [1, 0, 0]],
    ['[data-js-only]', [0, 1, 0]],
    ['.site-nav button', [0, 1, 1]],
    ['.site-nav button:hover', [0, 2, 1]],
    ["button[aria-pressed='true']", [0, 1, 1]],
    [":root:not([data-js='on']) [data-js-only]", [0, 3, 0]],
    ['a::after', [0, 0, 2]],
    ['.prose a::first-line', [0, 1, 2]],
    ['li:nth-child(2n)', [0, 1, 1]],
  ];
  for (const [selector, expected] of cases) {
    assert.deepEqual(specificity(selector), expected, selector);
  }
});

test('a pseudo-element counts as a type, not a class', () => {
  // `/:(?!:)[a-z-]+/` matches the second colon of `::after` and lands it in the
  // class column, which over-counts and produces a false failure.
  assert.equal(tuple('.site-nav button::after'), '0,1,2');
});

test('type selectors are matched case-insensitively', () => {
  // HTML type selectors are case-insensitive; a lowercase-only pattern reads
  // `BUTTON` as specificity zero, which under-counts — the dangerous direction.
  assert.equal(tuple('BUTTON'), tuple('button'));
  assert.equal(tuple('.site-nav BUTTON'), '0,1,1');
});

test(':is() and :not() take their most specific argument', () => {
  // The evasion: a comma inside :is() split the selector list, and each half
  // looked harmless on its own while the whole rule outranked the hiding rule.
  assert.equal(tuple(':is(#nav,.site-nav) [data-js-only]'), '1,1,0');
  assert.equal(tuple(':not(.a,#b) button'), '1,0,1');
  assert.equal(tuple(':is(.a,.b,.c)'), '0,1,0');
});

test(':where() contributes nothing', () => {
  assert.equal(tuple(':where(#nav, .anything) button'), '0,0,1');
  assert.equal(tuple(':where(body)'), '0,0,0');
});

test('an attribute value containing brackets or commas is one component', () => {
  assert.equal(tuple('[title="a,b]c"]'), '0,1,0');
  assert.equal(tuple('a[href*="?x=1,2"]'), '0,1,1');
});

test('a selector list splits only at top-level commas', () => {
  assert.deepEqual(splitSelectorList('.a, .b'), ['.a', '.b']);
  assert.deepEqual(splitSelectorList(':is(#nav,.site-nav) [data-js-only]'), [
    ':is(#nav,.site-nav) [data-js-only]',
  ]);
  assert.deepEqual(splitSelectorList('a[title="x,y"], b'), ['a[title="x,y"]', 'b']);
  assert.deepEqual(splitSelectorList(':is(.a,.b), :not(.c,.d)'), [':is(.a,.b)', ':not(.c,.d)']);
});

test('rules() records the at-rules enclosing each rule, at any depth', () => {
  const parsed = rules(`
    a { color: red }
    @media print { b { color: blue } }
    @media (min-width: 40rem) { @supports (display: grid) { c { color: green } } }
  `);
  assert.deepEqual(
    parsed.map((rule) => [rule.selector, rule.conditions.length]),
    [
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ],
  );
  assert.equal(parsed[2]?.conditions[0]?.startsWith('@media'), true);
  assert.equal(parsed[2]?.conditions[1]?.startsWith('@supports'), true);
});

test('a hiding rule nested inside a print block is not treated as a default rule', () => {
  // A one-level-nesting regex reads the inner rule as top-level, so a print-only
  // hiding rule would look like it hides the controls on screen. It does not.
  const [nested] = rules('@media print{@supports (display:grid){.x{display:none}}}');
  assert.ok(nested);
  assert.equal(appliesByDefault(nested), false);
});

test('a statement at-rule does not open a block', () => {
  const parsed = rules("@import 'tokens.css'; @charset 'utf-8'; a { color: red }");
  assert.deepEqual(
    parsed.map((rule) => [rule.selector, rule.conditions.length]),
    [['a', 0]],
  );
});

test('media conditions that can apply on screen are not discarded', () => {
  // Each of these was silently dropped by a substring match on "print" or
  // "prefers-reduced-motion", hiding whatever rule it contained. Reduced-motion
  // is kept too: this sheet's block is harmless, a future one need not be.
  for (const condition of [
    '@media (prefers-reduced-motion: no-preference)',
    '@media (prefers-reduced-motion: reduce)',
    '@media print, screen',
    '@media not print',
    '@media (min-width: 48rem)',
    '@media screen and (prefers-reduced-motion: reduce)',
  ]) {
    assert.equal(excludesDefaultScreen(condition), false, condition);
  }
});

test('print blocks are excluded from the screen cascade', () => {
  for (const condition of ['@media print', '@media  print ', '@media print and (min-width: 40rem)']) {
    assert.equal(excludesDefaultScreen(condition), true, condition);
  }
});

test('an @supports condition never excludes the default screen state', () => {
  assert.equal(excludesDefaultScreen('@supports (color: light-dark(#000, #fff))'), false);
});

test('declaration() reports the value and its importance', () => {
  assert.deepEqual(declaration('display:none', 'display'), { value: 'none', important: false });
  assert.deepEqual(declaration('display:inline-flex!important', 'display'), {
    value: 'inline-flex',
    important: true,
  });
  assert.deepEqual(declaration('color:red;display: none ! important', 'display'), {
    value: 'none',
    important: true,
  });
  assert.equal(declaration('color:red', 'display'), undefined);
  // `display` must not be matched inside another property's name or value.
  assert.equal(declaration('grid-auto-display:x', 'display'), undefined);
});

test('an important declaration beats a more specific normal one', () => {
  // Specificity alone would say the (0,3,0) rule wins; !important overrides it,
  // which is how a competing rule can re-show a control the gate thinks hidden.
  const hiding = { specificity: [0, 3, 0] as Specificity, important: false, order: 1 };
  const showing = { specificity: [0, 1, 1] as Specificity, important: true, order: 2 };
  assert.equal(wins(showing, hiding), true);
  assert.equal(wins(hiding, showing), false);
});

test('an equal-specificity tie is broken by document order', () => {
  const earlier = { specificity: [0, 3, 0] as Specificity, important: false, order: 1 };
  const later = { specificity: [0, 3, 0] as Specificity, important: false, order: 2 };
  assert.equal(wins(later, earlier), true);
  assert.equal(wins(earlier, later), false);
});

test('a ">" inside an attribute value does not end the tag', () => {
  // The evasion: matching `<[^>]*>` stops at the quoted ">", so an event
  // handler two attributes later is never seen by the inline-handler gate.
  const [tag] = [...startTags('<button title="a > b" onclick="steal()">go</button>')];
  assert.match(tag!, /\sonclick=/);
});

test("an apostrophe inside a double-quoted value does not desync blanking", () => {
  const [tag] = [...startTags(`<img alt="it's fine" onerror="steal()">`)];
  assert.match(tag!, /\sonerror=/);
});

test('attribute values are blanked so their contents cannot be read as attributes', () => {
  const [tag] = [...startTags('<meta name="description" content="see onclick= in prose">')];
  assert.equal(/\sonclick\s*=/.test(tag!), false);
  assert.match(tag!, /content=""/);
});

test('startTags finds every tag in a document, not only the first', () => {
  const tags = [...startTags('<a href="/x">one</a><b>two</b><i class="c">three</i>')];
  assert.equal(tags.length, 3);
  assert.equal(tags[2], '<i class="">');
});
