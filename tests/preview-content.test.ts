/**
 * Preview content against the built snapshot and the static pages.
 *
 * Goal 0003's evaluation row 2 ("Correct content"): every preview a real
 * Chromium opens from a hovered link must carry the title, excerpt, aliases,
 * and language of the row the built SQLite snapshot actually holds — including
 * an empty excerpt, author-ordered aliases that are deliberately not
 * alphabetical, CJK/emoji text, and the same alias claimed by two notes. The
 * target is checked against `snapshotNotes(dist)` — the shipped bytes, opened
 * read-only — rather than re-deriving what the pipeline should have written.
 *
 * The page is a real build served under the shipped CSP (see
 * `tests/support/browser-site.ts`), and the SQLite assets are real requests:
 * the test records them and asserts the panel's content came from a
 * `/data/site.*` fetch, so an equal-looking panel scraped from static markup
 * would not pass.
 *
 * The shared alias is part of the main corpus. `docs/core-design/content-
 * semantics.md` says "The same alias may belong to different notes" and that
 * aliases are "not ... globally unique names"; the producer follows that rule,
 * and the dedicated test below opens both notes' panels to show neither leaks
 * the other's private alias.
 *
 * The negative half keeps the same standard. A `/private/` link, a
 * `/notes/missing/` link, and an off-origin link must leave the panel hidden
 * and must not put unpublished metadata on any surface — asserted against the
 * snapshot's slug list and joined text, not against the absence of a payload
 * the page happened not to fetch. And because a negative assertion passes for a
 * script that is simply dead, each negative run first opens a known-good panel
 * from the same page.
 */

import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Browser, Page } from 'playwright';
import {
  buildAndServe,
  removeWorkspace,
  sqliteAssetRequests,
  type RunningSite,
} from './support/browser-site.ts';
import { snapshotNotes, snapshotSlugs, snapshotText, type SnapshotNote } from './support/snapshot.ts';

/** The alias the design-contract corpus deliberately gives to two different notes. */
const SHARED_ALIAS = 'shared';

/** Planted strings: they can only appear in output if the withheld note leaked. */
const WITHHELD_TITLE = 'WithheldTitleZZQ';
const WITHHELD_BODY = 'withheldbodyzzq';

/**
 * The corpus every content assertion below hovers from: non-alphabetical
 * aliases, CJK and emoji, an empty excerpt, the language fallback, and the
 * same alias on two notes (`emoji` and `shared`) — the case row 2 names and
 * `content-semantics.md` permits.
 */
const CORPUS: Record<string, string> = {
  // The page every preview is opened from. `[[withheld]]` becomes a live
  // `/private/` anchor and the external link keeps its off-origin URL. The
  // `[unknown](/notes/missing/)` link is here as the author wrote it, but the
  // producer degrades an unresolved Markdown link to plain text, so the
  // unknown-target check injects a probe anchor with that href and says so.
  'source.md': [
    '# Source',
    '',
    'Body links to [[zh]], [[emoji]], [[empty]], [[fallback]], [[shared]], and [[withheld]].',
    'Plus [unknown](/notes/missing/) and [external](https://example.com/notes/emoji/).',
    '',
  ].join('\n'),
  // A foreign-language note: its metadata must be marked with `lang` when the
  // panel is shown on the default-language page below.
  'zh.md': ['---', 'language: zh-CN', '---', '# 中文标题', '', '这是中文摘要正文。', ''].join('\n'),
  // Non-alphabetical aliases, including CJK, plus `shared`, which the shared
  // note below also claims. If any layer re-sorted by collation, `zulu` would
  // land last.
  'emoji.md': [
    '---',
    'aliases: ["zulu", "苹果", "Alpha", "shared"]',
    '---',
    '# Wave 🌊',
    '',
    'Emoji wave 🌊 and 中文 body text.',
    '',
  ].join('\n'),
  // Heading only: the excerpt must be empty, and the panel must still render a
  // (present, empty) excerpt paragraph rather than dropping it.
  'empty.md': ['# Empty', ''].join('\n'),
  // No language frontmatter: the DB stores the navigation fallback, so the
  // panel must not repeat the page's own language as a redundant `lang`.
  'fallback.md': ['# Fallback', '', 'Fallback body with no language field.', ''].join('\n'),
  'shared.md': [
    '---',
    'aliases: ["shared", "其他"]',
    '---',
    '# Shared alias note',
    '',
    'Body for the shared alias note.',
    '',
  ].join('\n'),
  'withheld.md': [
    '---',
    'publish: false',
    '---',
    `# ${WITHHELD_TITLE}`,
    '',
    WITHHELD_BODY,
    '',
  ].join('\n'),
};

/** The targets every content assertion hovers from `/notes/source/`. */
const TARGETS = ['zh', 'emoji', 'empty', 'fallback', 'shared'] as const;

/** The panel as a reader and a test can both observe it. */
interface PanelContent {
  title: string;
  excerpt: string;
  /** Whether the `p` exists at all, so an empty excerpt cannot hide a missing node. */
  hasExcerpt: boolean;
  titleLang: string | null;
  excerptLang: string | null;
  elements: string[];
}

let site: RunningSite;
let browser: Browser;
let db: Map<string, SnapshotNote>;

/** The built snapshot's own row for a slug, or a failure naming the corpus. */
function note(slug: string): SnapshotNote {
  const found = db.get(slug);
  assert.ok(found !== undefined, `the built snapshot has no \`${slug}\` node, so this check is vacuous`);
  return found;
}

/** Read the panel out of the live DOM, including attribute absence. */
function readPanel(page: Page): Promise<PanelContent> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#link-preview');
    if (panel === null) throw new Error('the page carries no #link-preview element');
    const strong = panel.querySelector('strong');
    const paragraph = panel.querySelector('p');
    return {
      title: strong?.textContent ?? '',
      excerpt: paragraph?.textContent ?? '',
      hasExcerpt: paragraph !== null,
      titleLang: strong?.getAttribute('lang') ?? null,
      excerptLang: paragraph?.getAttribute('lang') ?? null,
      elements: [...panel.querySelectorAll('*')].map((child) => child.localName),
    };
  });
}

/** Move the pointer off every link and wait out the close delay. */
async function dismiss(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.locator('#link-preview').waitFor({ state: 'hidden', timeout: 5_000 });
}

/**
 * The DB title verbatim, then every DB alias in stored ordinal order.
 *
 * Occurrence order, not mere presence: searching each alias after the previous
 * one fails when a layer re-sorted the list. `snapshotNotes` selects
 * `ORDER BY node_id, ordinal`, so a collation sort anywhere in the projection
 * or the panel is caught.
 */
function assertTitleCarriesAliases(title: string, expected: SnapshotNote, label: string): void {
  assert.ok(
    title.startsWith(expected.title),
    `${label}: the panel title does not start with the DB title ${JSON.stringify(expected.title)}: ${JSON.stringify(title)}`,
  );
  if (expected.aliases.length === 0) {
    assert.equal(title, expected.title, `${label}: a note with no DB aliases gained text in the panel title`);
    return;
  }
  let cursor = expected.title.length;
  for (const alias of expected.aliases) {
    const at = title.indexOf(alias, cursor);
    assert.ok(
      at >= cursor,
      `${label}: DB alias ${JSON.stringify(alias)} is missing from the panel or out of stored ordinal order: ${JSON.stringify(title)}`,
    );
    cursor = at + alias.length;
  }
}

/** Code points, for the explicit CJK/emoji survival checks below. */
function codePoints(text: string): number[] {
  return [...text].map((character) => character.codePointAt(0)!);
}

beforeAll(async () => {
  site = await buildAndServe(CORPUS);
  // Opened once: the snapshot is immutable for the life of the build, so every
  // comparison below reads the artifact the browser is being served.
  db = new Map(snapshotNotes(site.dist).map((entry) => [entry.slug, entry]));
  for (const slug of [...TARGETS, 'source']) note(slug);
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (site !== undefined) removeWorkspace(site.workspace);
}, 120_000);

test('every preview carries the DB title, author-ordered aliases, and exact excerpt', async () => {
  const page = await browser.newPage();
  const sqliteRequests = sqliteAssetRequests(page);
  try {
    await page.goto(`${site.origin}/notes/source/`, { waitUntil: 'load' });
    const panel = page.locator('#link-preview');
    const pageLanguage = (await page.getAttribute('html', 'lang')) ?? '';
    const panels = new Map<string, PanelContent>();

    for (const slug of TARGETS) {
      const expected = note(slug);
      const link = page.locator(`a[href="/notes/${slug}/"]`).first();
      assert.equal(await link.count(), 1, `the source page has no link to ${slug}, so its preview was not measured`);

      await link.hover();
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      const shown = await readPanel(page);
      panels.set(slug, shown);

      assertTitleCarriesAliases(shown.title, expected, slug);
      assert.deepEqual(
        shown.elements,
        ['strong', 'p'],
        `${slug}: the panel rendered something other than a strong title and a p excerpt`,
      );

      // The `p` must exist even when the excerpt is empty, and its text must be
      // the DB excerpt — no trimming, no fallback to a title or page summary.
      assert.equal(shown.hasExcerpt, true, `${slug}: the panel rendered no excerpt paragraph`);
      assert.equal(
        shown.excerpt,
        expected.excerpt,
        `${slug}: the panel excerpt differs from the DB excerpt ${JSON.stringify(expected.excerpt)}`,
      );

      // Language: the DB stores the effective note language, and the panel adds
      // `lang` only when it differs from the page's. The source page is the
      // default, so `zh` must be marked and the fallback note must not be.
      const foreign = expected.language.toLowerCase() !== pageLanguage.toLowerCase();
      assert.equal(
        shown.titleLang,
        foreign ? expected.language : null,
        `${slug}: the panel title carries the wrong lang (DB language ${JSON.stringify(expected.language)}, page language ${JSON.stringify(pageLanguage)})`,
      );
      assert.equal(
        shown.excerptLang,
        foreign ? expected.language : null,
        `${slug}: the panel excerpt carries the wrong lang (DB language ${JSON.stringify(expected.language)}, page language ${JSON.stringify(pageLanguage)})`,
      );

      await dismiss(page);
    }

    // The fixture exercises what row 2 names, rather than passing on ASCII that
    // happens to equal itself. These read the DB, not hand-typed copies.
    assert.equal(note('zh').language, 'zh-CN', 'the zh note did not store its frontmatter language');
    for (const slug of ['emoji', 'empty', 'fallback', 'shared'] as const) {
      assert.equal(note(slug).language, 'en', `${slug}: the navigation-language fallback was not stored in the DB`);
    }
    assert.equal(note('empty').excerpt, '', 'the heading-only note did not store an empty excerpt');
    assert.ok(
      codePoints(note('emoji').title).some((point) => point > 0xffff),
      'the emoji note title has no astral code point, so the emoji half of this gate measured nothing',
    );
    assert.ok(
      /\p{Script=Han}/u.test(note('emoji').excerpt) && codePoints(note('emoji').excerpt).some((point) => point > 0xffff),
      'the emoji note excerpt has no CJK or no astral code point, so its half of this gate measured nothing',
    );
    assert.ok(/\p{Script=Han}/u.test(note('zh').excerpt), 'the zh note excerpt has no CJK, so its half of this gate measured nothing');

    // Exact code points, compared against the DB strings: strict string
    // equality already implies this, and stating it in code points is what
    // keeps a future refactor from normalizing one side silently.
    assert.deepEqual(
      codePoints(panels.get('emoji')!.excerpt),
      codePoints(note('emoji').excerpt),
      'the emoji note excerpt did not survive as the same code points',
    );
    assert.deepEqual(
      codePoints(panels.get('zh')!.excerpt),
      codePoints(note('zh').excerpt),
      'the zh note excerpt did not survive as the same code points',
    );

    // The values above were produced by a projection query, not by markup that
    // happened to read well: the first hover downloaded the built DB.
    assert.ok(
      sqliteRequests.some((url) => url.includes('/data/site.')),
      'no snapshot request was observed, so the panel content was not proven to come from the built DB',
    );
  } finally {
    await page.close();
  }
}, 120_000);

test('static note pages carry the same DB title and author-ordered aliases', async () => {
  // Node fetch against the same origin the browser used: the preview is only
  // "correct content" if the static page a reader would land on agrees with the
  // DB the preview read. Titles are plain text (no markup), so containment is
  // exact rather than an escaping guess.
  for (const slug of TARGETS) {
    const expected = note(slug);
    const response = await fetch(`${site.origin}/notes/${slug}/`);
    assert.equal(response.status, 200, `/notes/${slug}/ returned ${response.status}`);
    const html = await response.text();

    assert.ok(
      html.includes(expected.title),
      `${slug}: the static page does not contain the DB title ${JSON.stringify(expected.title)}`,
    );
    const heading = /<h1\b[^>]*\bnote-title\b[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    assert.ok(heading !== null, `${slug}: the static page has no note-title heading`);
    assert.equal(heading[1]!.trim(), expected.title, `${slug}: the static heading is not the DB title`);

    const aliasList = /<ul\b[^>]*\bnote-aliases\b[^>]*>([\s\S]*?)<\/ul>/.exec(html);
    if (expected.aliases.length === 0) {
      assert.equal(aliasList, null, `${slug}: the page rendered an alias list for a note the DB gives none`);
      continue;
    }
    assert.ok(aliasList !== null, `${slug}: the DB has aliases but the static page rendered no alias list`);
    const rendered = [...aliasList[1]!.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]!.trim());
    assert.deepEqual(
      rendered,
      expected.aliases,
      `${slug}: the static page's alias sequence disagrees with the DB ordinal order (non-alphabetical order must not be re-sorted)`,
    );
  }
}, 120_000);

test('unknown, withheld, and external targets stay panel-free and unpublished', async () => {
  const page = await browser.newPage();
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'example.com') externalRequests.push(request.url());
  });
  try {
    await page.goto(`${site.origin}/notes/source/`, { waitUntil: 'load' });
    const panel = page.locator('#link-preview');

    // Positive control: this page and this runtime can open a panel. Without
    // it, a hidden panel below would also pass for a script that never ran.
    const known = page.locator('a[href="/notes/zh/"]').first();
    assert.equal(await known.count(), 1, 'the source page has no published link, so the control is vacuous');
    await known.hover();
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    await dismiss(page);

    /** Hover a link that must not preview, and assert the panel stays hidden. */
    async function assertNoPanel(label: string, href: string): Promise<void> {
      const link = page.locator(`a[href="${href}"]`).first();
      assert.equal(await link.count(), 1, `${label}: the source page has no ${href} link, so this check is vacuous`);
      assert.equal(await panel.isHidden(), true, `${label}: the panel was already showing before the hover`);
      await link.hover();
      // Longer than the 120 ms intent delay plus a warm query, so a panel that
      // was going to appear has appeared.
      await page.waitForTimeout(400);
      assert.equal(await panel.isHidden(), true, `${label}: hovering ${href} produced a preview panel`);
      await page.mouse.move(0, 0);
    }

    // Withheld: the link is the accepted live `/private/` anchor, and the
    // snapshot carries no row for it — checked before the hover so a hidden
    // panel is not the only evidence.
    const slugs = snapshotSlugs(site.dist);
    assert.ok(!slugs.includes('withheld'), 'the snapshot published the withheld note');
    await assertNoPanel('withheld', '/private/');

    // Unknown: a note route the build never published. The producer degrades
    // the corpus's `[unknown](/notes/missing/)` to plain text (`resolve-links.ts`:
    // "unresolved still degrades to text: there is no honest destination"), so
    // the property is measured with a probe anchor injected into the live page —
    // the same idiom `rendered-page.test.ts` uses for a heading target the
    // corpus does not contain.
    assert.ok(!slugs.includes('missing'), 'the snapshot carries a `missing` node that the corpus never wrote');
    await page.evaluate(() => {
      const probe = document.createElement('a');
      probe.href = '/notes/missing/';
      probe.id = 'probe-unknown-target';
      probe.textContent = 'probe';
      document.querySelector('main')!.append(probe);
    });
    await assertNoPanel('unknown', '/notes/missing/');

    // External: a different origin is not previewable, and hovering it must not
    // fire a request to that origin (a preview that fetched the target page
    // would be the scrape-the-target design this projection exists to avoid).
    await assertNoPanel('external', 'https://example.com/notes/emoji/');
    assert.deepEqual(externalRequests, [], 'hovering the external link sent a request to its origin');

    // The withheld note's own metadata and body must not be in the projection
    // at all. `snapshotText` is a positive control first: it reads real values.
    const text = snapshotText(site.dist);
    assert.ok(text.includes(note('zh').title), 'snapshotText returned nothing, so the absence checks below are vacuous');
    assert.ok(!text.includes(WITHHELD_TITLE), 'the withheld title reached the snapshot');
    assert.ok(!text.includes(WITHHELD_BODY), 'the withheld body reached the snapshot');
  } finally {
    await page.close();
  }
}, 120_000);

/**
 * Shared aliases, per `docs/core-design/content-semantics.md`.
 *
 * The same alias belongs to both `emoji` and `shared`. Each panel must show
 * the name it shares and must not gain the other note's private aliases: a
 * consumer that keyed aliases by text alone would fail one of the two halves.
 */
test('the same alias on two notes previews from both without cross-contamination', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${site.origin}/notes/source/`, { waitUntil: 'load' });
    const panel = page.locator('#link-preview');
    const panels = new Map<string, PanelContent>();
    for (const slug of ['emoji', 'shared'] as const) {
      const link = page.locator(`a[href="/notes/${slug}/"]`).first();
      assert.equal(await link.count(), 1, `the source page has no link to ${slug}, so its panel was not measured`);
      await link.hover();
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      panels.set(slug, await readPanel(page));
      await dismiss(page);
    }

    const emojiPanel = panels.get('emoji')!.title;
    const sharerPanel = panels.get('shared')!.title;
    assert.ok(emojiPanel.includes(SHARED_ALIAS), 'the emoji panel dropped the alias it shares with the shared note');
    assert.ok(sharerPanel.includes(SHARED_ALIAS), 'the shared panel dropped the alias it shares with the emoji note');
    assert.ok(emojiPanel.includes('苹果'), 'the emoji panel dropped its own CJK alias');
    assert.ok(!sharerPanel.includes('苹果'), "the shared panel leaked the emoji note's CJK alias");
    assert.ok(sharerPanel.includes('其他'), 'the shared panel dropped its own CJK alias');
    assert.ok(!emojiPanel.includes('其他'), "the emoji panel leaked the shared note's CJK alias");
    for (const slug of ['emoji', 'shared'] as const) {
      assertTitleCarriesAliases(panels.get(slug)!.title, note(slug), slug);
    }
  } finally {
    await page.close();
  }
}, 120_000);
