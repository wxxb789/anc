/**
 * The translation contract, and what it refuses to compile.
 *
 * Three properties, in the order they matter:
 *
 * 1. **A missing key is a build error.** That is the acceptance criterion, and
 *    it is not something a runtime assertion can prove — a test that reads every
 *    key off both locales would pass on a locale whose missing entry the compiler
 *    would have caught, because a locale that does not compile is never run.
 *    The gate below therefore invokes `tsc` on a mutated copy and asserts it
 *    fails, which is the only way to observe a type error from inside a test.
 * 2. **Resolution is per document.** `translate` on an entry's own `language`,
 *    with the fallback the artifact's optional field requires.
 * 3. **The two locales are actually different, in the places that carry
 *    grammar.** A locale filled in by copying the English is type-correct and
 *    useless; several assertions here exist to fail on exactly that.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  NAV_LANGUAGE,
  THEME_NAMES,
  type ThemeName,
  type Translation,
  partLanguage,
  translate,
} from '../src/lib/translations.ts';

const SOURCE = fileURLToPath(new URL('../src/lib/translations.ts', import.meta.url));

/** The two locales this site publishes, by a tag each resolves from. */
const LANGUAGES = ['en', 'zh-CN'] as const;

/**
 * Every function-valued entry, classified by what it takes.
 *
 * Written out rather than discovered, and that is the point: a new interpolated
 * key must be added to one of these three lists or the coverage assertion below
 * fails, so no function-valued entry can be added without also being exercised.
 * Calling every function with a number instead would "pass" on `themeLabel(0)`
 * rendering the string `undefined`.
 */
const COUNT_KEYS = ['noteCount', 'tagCount', 'collectionCount', 'publishedCount'] as const;
const TEXT_KEYS = [
  'publishedAt',
  'explorerIndex',
  'tagPageTitle',
  'tagPageDescription',
  'collectionPageTitle',
  'collectionPageDescription',
  'moreInCollection',
  'canonicalUrlLine',
  'headingAnchorLabel',
  'diagramCaption',
  'feedTitle',
  'socialCardAlt',
  'footnoteBackLabel',
] as const;
const THEME_KEYS = ['themeLabel'] as const;
/**
 * Entries taking two counts: a drawn number and a total.
 *
 * Their own list rather than folded into {@link COUNT_KEYS}, because a
 * single-argument call leaves the second interpolation `undefined` — and the
 * "renders undefined" assertion below would then be the only thing standing
 * between a half-exercised key and a page reading "Drawing 3 of undefined
 * notes". Sampling the pairs is what makes the coverage real.
 */
const COUNT_PAIR_KEYS = ['graphFigureLabel', 'graphBounded', 'graphBoundedLocal'] as const;
/** The one entry taking a title, a relationship, and a count. */
const NODE_KEYS = ['graphNodeLabel'] as const;

// --- Resolution ----------------------------------------------------------------

test('a document resolves the locale its own language names', () => {
  assert.equal(translate('en').uncollected, 'Uncollected');
  assert.equal(translate('zh-CN').uncollected, '未归入合集');
  // The tag is matched case-insensitively: `zh-cn`, `zh-CN`, and `ZH-CN` are one
  // language, and BCP 47 says so. An artifact is free to spell it any of those.
  for (const spelling of ['zh-cn', 'zh-CN', 'ZH-CN']) {
    assert.equal(translate(spelling).uncollected, '未归入合集', `${spelling} did not resolve`);
  }
});

test('a document with no language falls back to the navigation language', () => {
  // The published corpus is exactly this case — its single note declares no
  // `language` — so this is the resolution most built pages actually take.
  assert.deepEqual(translate(undefined), translate(NAV_LANGUAGE));
  assert.equal(translate(undefined).skipToContent, translate('en').skipToContent);
});

test('an unlisted region falls back to its primary subtag, not to a key name', () => {
  // `zh-Hans-CN` and `zh-TW` name no locale here. Falling back to `zh` is a
  // reader seeing Chinese chrome on a Chinese document; falling back to English
  // is the defect this ticket exists to close, reached from a valid artifact.
  //
  // This is what makes the bare `zh` key in `LOCALES` load-bearing rather than a
  // shadow of `zh-cn`: `translate` reduces to the *primary* subtag, so all three
  // of these become `zh` and nothing else would catch them. Deleting that key on
  // a reviewer's advice was tried, and this assertion is what reported it.
  // `zho` is ISO 639-2/T for the same language, and the schema admits a
  // three-letter primary subtag — so it is a spelling a valid artifact can
  // carry, and without its own key it resolved to English chrome on a Chinese
  // document. It also made the built-output gate self-contradictory, because
  // that gate picks "the other locale" by `startsWith('zh')`.
  for (const tag of ['zh-Hans-CN', 'zh-TW', 'zh-Hant', 'zho', 'zho-Hans', 'ZHO']) {
    assert.equal(translate(tag).uncollected, '未归入合集', `${tag} did not resolve to a zh locale`);
  }
  // A language with no locale at all resolves to the navigation language rather
  // than throwing or rendering an empty string. The schema admits any BCP 47
  // tag, so this is reachable from a valid artifact.
  assert.equal(translate('fr').uncollected, translate(NAV_LANGUAGE).uncollected);
  assert.equal(translate('de-AT').skipToContent, translate(NAV_LANGUAGE).skipToContent);
});

/**
 * Every form a key can render, given an argument of the kind it actually takes.
 *
 * A string entry renders itself; a function entry renders once per sample
 * argument. Feeding the wrong kind is how a survey of "every key" comes to
 * assert nothing: `themeLabel(0)` indexes a map with a number and produces the
 * string `undefined`, which is a passing value for every check below except the
 * one that happened to look for that word.
 */
function formsOf(locale: Translation, key: string): string[] {
  const value = (locale as unknown as Record<string, unknown>)[key];
  if (typeof value !== 'function') return [String(value)];
  if ((COUNT_KEYS as readonly string[]).includes(key)) {
    return [0, 1, 2, 11].map((n) => String((value as (n: number) => string)(n)));
  }
  if ((THEME_KEYS as readonly string[]).includes(key)) {
    return THEME_NAMES.map((theme) => String((value as (t: ThemeName) => string)(theme)));
  }
  if ((COUNT_PAIR_KEYS as readonly string[]).includes(key)) {
    // Both singular and plural on each side, and the 1-of-1 case, which is the
    // one an English rule gets wrong in two places at once.
    return ([[1, 1], [1, 9], [9, 12], [0, 3]] as const).map(([shown, total]) =>
      String((value as (a: number, b: number) => string)(shown, total)),
    );
  }
  if ((NODE_KEYS as readonly string[]).includes(key)) {
    return ([1, 0, 4] as const).map((degree) =>
      String((value as (a: string, b: string, c: number) => string)('Ops & SRE', 'linked', degree)),
    );
  }
  assert.ok(
    (TEXT_KEYS as readonly string[]).includes(key),
    `"${key}" is a function-valued entry in no sample list — add it to one, or it is exercised by nothing`,
  );
  return ['Ops & SRE'].map((text) => String((value as (s: string) => string)(text)));
}

test('every function-valued key is classified, so none goes unexercised', () => {
  const named = new Set<string>([
    ...COUNT_KEYS,
    ...TEXT_KEYS,
    ...THEME_KEYS,
    ...COUNT_PAIR_KEYS,
    ...NODE_KEYS,
  ]);
  const actual = Object.entries(translate('en'))
    .filter(([, value]) => typeof value === 'function')
    .map(([key]) => key);
  assert.deepEqual([...actual].sort(), [...named].sort(), 'the sample lists are not the function keys');
});

test('every key resolves to something a reader can read, in both locales', () => {
  for (const language of LANGUAGES) {
    const locale = translate(language);
    for (const key of Object.keys(locale)) {
      for (const rendered of formsOf(locale, key)) {
        assert.ok(rendered.trim() !== '', `${language}.${key} renders as nothing`);
        // A key name leaking into the page is the failure mode a runtime
        // fallback produces; there is no runtime fallback, and this proves none
        // crept in.
        assert.ok(!rendered.includes(key), `${language}.${key} renders its own key name`);
        assert.ok(
          !rendered.includes('undefined'),
          `${language}.${key} renders "undefined": ${rendered}`,
        );
      }
    }
  }
});

test('the two locales are genuinely different, not one copied over the other', () => {
  const en = translate('en');
  const zh = translate('zh-CN');
  const shared = Object.keys(en).filter(
    (key) => formsOf(en, key).join('|') === formsOf(zh, key).join('|'),
  );
  // Nothing is legitimately identical across these two languages: even the
  // arrow in `← All tags` sits beside translated words. A locale stubbed out by
  // copying the English would light this up immediately.
  assert.deepEqual(shared, [], 'these keys are byte-identical in both locales');
});

test('the Chinese locale uses Chinese script and full-width punctuation', () => {
  const zh = translate('zh-CN');
  const HAN = /\p{Script=Han}/u;
  for (const key of Object.keys(zh)) {
    for (const rendered of formsOf(zh, key)) {
      assert.match(rendered, HAN, `zh-CN.${key} contains no Han character: ${rendered}`);
    }
  }
  // A colon or comma in Chinese prose is `：` and `，`; the ASCII forms read as a
  // typographic error. Asserted on the entries that carry one rather than
  // globally, because a URL inside a sentence legitimately carries `://`.
  for (const rendered of [zh.themeLabel('dark'), zh.tagPageTitle('x'), zh.collectionPageTitle('x')]) {
    assert.match(rendered, /：/, `zh-CN uses an ASCII colon: ${rendered}`);
    assert.ok(!rendered.includes(': '), `zh-CN uses an ASCII colon: ${rendered}`);
  }
});

// --- Counts --------------------------------------------------------------------

/**
 * English pluralises, Chinese does not, and the contract lets each say so.
 *
 * The naive shared implementation — `count === 1 ? singular : plural` applied to
 * both — is what this asserts against: it produces "1 篇笔记" / "2 篇笔记s" or
 * forces the Chinese into an English shape. The function-valued entry is what
 * makes both correct without a plural-rules library.
 */
test('English pluralises a count and Chinese does not', () => {
  const en = translate('en');
  assert.equal(en.noteCount(0), '0 notes');
  assert.equal(en.noteCount(1), '1 note');
  assert.equal(en.noteCount(2), '2 notes');
  assert.equal(en.tagCount(1), '1 tag');
  assert.equal(en.tagCount(3), '3 tags');
  assert.equal(en.collectionCount(1), '1 collection');
  assert.equal(en.collectionCount(4), '4 collections');

  const zh = translate('zh-CN');
  // One form for every count. Stated as a set rather than three equalities so
  // the property under test is "invariant in number", not "these three strings".
  for (const format of [zh.noteCount, zh.tagCount, zh.collectionCount, zh.publishedCount]) {
    const forms = new Set([0, 1, 2, 11, 100].map((n) => format(n).replace(/\d+/g, '#')));
    assert.equal(forms.size, 1, `a zh-CN count varies with the number: ${[...forms].join(' / ')}`);
  }
  assert.equal(zh.noteCount(1), '1 篇笔记');
  assert.equal(zh.noteCount(2), '2 篇笔记');

  // The count itself reaches the string in both languages, or the "invariant"
  // check above would pass on a formatter that dropped the number entirely.
  for (const language of LANGUAGES) {
    const locale = translate(language);
    for (const n of [0, 1, 7, 42]) {
      assert.ok(locale.noteCount(n).includes(String(n)), `${language}: noteCount(${n}) lost the number`);
      assert.ok(
        locale.publishedCount(n).includes(String(n)),
        `${language}: publishedCount(${n}) lost the number`,
      );
    }
  }
});

test('an interpolated entry carries its value through unchanged', () => {
  // Artifact text — a collection name, a tag, a URL — is the author's and is
  // never rewritten by chrome. `Ops & SRE` and `设计 · Design` are real fixture
  // labels; the URL is what the printed footer carries.
  for (const language of LANGUAGES) {
    const locale = translate(language);
    for (const value of ['Ops & SRE', '设计 · Design', 'security', '笔记']) {
      for (const [name, rendered] of [
        ['explorerIndex', locale.explorerIndex(value)],
        ['moreInCollection', locale.moreInCollection(value)],
        ['tagPageTitle', locale.tagPageTitle(value)],
        ['tagPageDescription', locale.tagPageDescription(value)],
        ['collectionPageTitle', locale.collectionPageTitle(value)],
        ['collectionPageDescription', locale.collectionPageDescription(value)],
      ] as const) {
        assert.ok(
          rendered.includes(value),
          `${language}.${name}(${JSON.stringify(value)}) did not carry the value: ${rendered}`,
        );
      }
    }
    // A stand-in origin, never the configured one: `tests/metadata.test.ts`
    // proves the real origin appears in `astro.config.mjs` and nowhere else.
    const url = 'https://example.test/notes/a/';
    assert.ok(locale.publishedAt(url).includes(url), `${language}: publishedAt lost the URL`);
    assert.ok(locale.canonicalUrlLine(url).includes(url), `${language}: canonicalUrlLine lost the URL`);
  }
});

test('the theme label names all three states, in each language', () => {
  for (const language of LANGUAGES) {
    const locale = translate(language);
    const labels = THEME_NAMES.map((theme) => locale.themeLabel(theme));
    assert.equal(new Set(labels).size, THEME_NAMES.length, `${language}: two themes share a label`);
    for (const label of labels) assert.ok(label.trim() !== '', `${language}: an empty theme label`);
  }
  // The English label is the raw state name; the Chinese one is not, because
  // "Theme: system" transliterated leaves an English word in Chinese chrome.
  assert.equal(translate('en').themeLabel('dark'), 'Theme: dark');
  assert.equal(translate('zh-CN').themeLabel('dark'), '主题：深色');
  for (const theme of THEME_NAMES) {
    assert.ok(
      !translate('zh-CN').themeLabel(theme).includes(theme),
      `zh-CN theme label for "${theme}" leaves the English state name in the string`,
    );
  }
});

// --- Marking a foreign title ---------------------------------------------------

test('a listed title is marked with its own language only when it differs', () => {
  // WCAG 2.2 AA 3.1.2 is about parts of a page, and a mixed list is that case:
  // an unmarked Chinese title on an English page is read in an English voice.
  assert.equal(partLanguage('zh-CN', 'en'), 'zh-CN');
  assert.equal(partLanguage('en', 'zh-CN'), 'en');
  // Same language: no attribute, so a single-language corpus carries none.
  assert.equal(partLanguage('en', 'en'), undefined);
  assert.equal(partLanguage('zh-CN', 'zh-CN'), undefined);
  // An entry declaring nothing is the navigation language, which is what
  // `translate` already assumes — so the published corpus's English page
  // listing its own note emits no attribute rather than a redundant `lang="en"`.
  assert.equal(partLanguage(undefined, NAV_LANGUAGE), undefined);
  assert.equal(partLanguage(undefined, 'zh-CN'), NAV_LANGUAGE);
  // BCP 47 tags are case-insensitive, and `translate` lowercases before
  // resolving — so these must agree, or a page renders Chinese chrome while
  // marking its own Chinese titles as foreign on every row of every list.
  assert.equal(partLanguage('ZH-CN', 'zh-CN'), undefined);
  assert.equal(partLanguage('zh-cn', 'zh-CN'), undefined);
  assert.equal(partLanguage('EN', 'en'), undefined);
});

// --- The compile-time gate -----------------------------------------------------

/**
 * A missing key fails type checking, and so does an unknown one.
 *
 * This is the ticket's acceptance criterion and the reason the locales end
 * `as const satisfies Translation`. It cannot be asserted from inside the
 * running program: a locale with a missing key does not type-check, so the
 * module holding it never runs, so no runtime assertion ever observes it. The
 * only honest gate is to compile a mutated copy and require a failure.
 *
 * `tsc` on a single file rather than `astro check` over the tree: the copy lives
 * outside `src/`, so a project-wide check would either not see it or would drag
 * in the whole program. The flags mirror `astro/tsconfigs/base.json` in the
 * three respects that matter to this file — `strict`, ESNext modules, and
 * bundler resolution.
 *
 * Both directions are checked. A missing key is the criterion; an *extra* key is
 * the other half of the same guarantee, and it is what `satisfies` adds over a
 * plain type annotation — with `const EN: Translation` the value would be
 * widened and `translate('en').noteCount` would lose its literal types, while a
 * typo'd extra key would still be caught. Requiring both is what pins the
 * `as const satisfies` shape specifically.
 */
test('a locale missing a key, or carrying an unknown one, fails type checking', () => {
  const source = readFileSync(SOURCE, 'utf8');
  // A real key, taken from the file rather than hardcoded, so this cannot rot
  // into mutating a line that no longer exists and compiling clean.
  const marker = "  uncollected: 'Uncollected',\n";
  assert.ok(source.includes(marker), 'the mutation target is not in translations.ts');

  const scratch = mkdtempSync(join(tmpdir(), 'tk16-contract-'));
  const compile = (name: string, contents: string) => {
    const file = join(scratch, name);
    writeFileSync(file, contents, 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/typescript/lib/tsc.js', import.meta.url)),
        '--noEmit',
        '--strict',
        '--target',
        'esnext',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        file,
      ],
      { encoding: 'utf8' },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  try {
    // Unmutated first. Without this the two failures below prove only that the
    // harness reports errors, not that the mutation caused them — the trap this
    // repository has hit before, where "found nothing" and "could not look"
    // report the same way.
    const clean = compile('clean.ts', source);
    assert.equal(clean.status, 0, `the unmutated contract does not compile:\n${clean.output}`);

    const missing = compile('missing.ts', source.replace(marker, ''));
    assert.notEqual(missing.status, 0, 'a locale missing a key compiled clean');
    assert.match(
      missing.output,
      /uncollected/,
      `the failure does not name the missing key:\n${missing.output}`,
    );

    const extra = compile('extra.ts', source.replace(marker, `${marker}  notAKey: 'x',\n`));
    assert.notEqual(extra.status, 0, 'a locale carrying an unknown key compiled clean');
    assert.match(extra.output, /notAKey/, `the failure does not name the unknown key:\n${extra.output}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

/**
 * The contract is the only place a chrome string is written down.
 *
 * A second copy is how the two languages drift: a sentence edited in one place
 * and not in the locale renders one language correctly and the other silently
 * stale — and nothing else in the suite would notice, because the English page
 * would still read correctly. A live instance existed until review found it,
 * `UNCOLLECTED_LABEL` in `collection-navigation.ts`, which an earlier version of
 * this gate could not see because it walked a hand-kept list of files.
 *
 * So it walks the tree instead. `src/` minus this contract, minus the two static
 * prose pages: `about.astro` and `privacy.astro` are documents rather than
 * chrome — long-form text this repository wrote, on two navigation-language
 * routes, that no locale key describes. They are excluded by name and with a
 * reason rather than by being left off a list nobody would notice was short.
 *
 * Matched as a *complete* literal — `'Collection'`, `"Collection"`, or the JSX
 * text `>Collection<` — never as a substring, because a bare substring reports
 * `import CollectionExplorer from './CollectionExplorer.astro'` as a hardcoded
 * "Collection". The cost of that precision is that a sentence reintroduced as
 * JSX text broken across several lines would slip through; the form this guards
 * against is the one every string here had before TK-16, which is a literal on
 * one line.
 */
test('no module outside the contract holds a chrome string of its own', () => {
  const root = new URL('../src/', import.meta.url);

  /**
   * Long-form prose pages, not chrome.
   *
   * Excluded by name so adding a third is a deliberate act. Both are static
   * documents on navigation-language routes; translating them is a content
   * decision this ticket does not own.
   */
  const PROSE_PAGES = new Set(['about.astro', 'privacy.astro']);

  const files: string[] = [];
  const walk = (directory: URL, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      const child = new URL(name, directory);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, directory), `${prefix}${name}/`);
      // The contract itself, obviously, and the artifact it would otherwise read.
      else if (name === 'translations.ts' || PROSE_PAGES.has(name)) continue;
      else if (/\.(astro|ts)$/.test(name)) files.push(`${prefix}${name}`);
    }
  };
  walk(root, '');
  // The `src/data/` artifact is exporter-generated content, not chrome.
  const scanned = files.filter((name) => !name.startsWith('data/'));
  assert.ok(scanned.length > 20, `only ${scanned.length} modules were scanned`);

  const en = translate('en');
  // Every string-valued key, not a hand-kept list of the ones that moved: a list
  // is a thing to forget to add to, and the point is that *no* chrome string has
  // a second home.
  const literals = Object.keys(en)
    .map((key) => [key, (en as unknown as Record<string, unknown>)[key]] as const)
    .filter((pair): pair is readonly [string, string] => typeof pair[1] === 'string');
  assert.ok(literals.length > 30, 'the contract has fewer string keys than expected');

  for (const name of scanned) {
    const source = readFileSync(new URL(name, root), 'utf8');
    // Comments are prose about the code and legitimately quote a string — this
    // file's own reasoning does exactly that — so the check is over what the
    // module *renders*. Block comments cover both `/* */` in a frontmatter and
    // `{/* */}` in markup.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [key, value] of literals) {
      for (const form of [`'${value}'`, `"${value}"`, `\`${value}\``, `>${value}<`]) {
        assert.ok(
          !code.includes(form),
          `src/${name} holds the literal for "${key}" (${JSON.stringify(value)}) — ` +
            'resolve it from the contract instead',
        );
      }
    }
  }
});
