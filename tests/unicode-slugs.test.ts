/**
 * A repository of CJK-named notes, built end to end by the shipped binary.
 *
 * The owner decision this holds: note slugs are Unicode, derived per path
 * segment, with a deterministic hash for a name that yields no addressable
 * slug. Every consumer of the slug grammar has to agree, and the only place
 * they all meet is a real build — the producer derives the slug, the resolver
 * links to it, Astro writes the page, the sitemap and canonical link encode it,
 * the snapshot stores it, and the browser parses it back out of an encoded
 * pathname. Red against the ASCII-only grammar at the first assertion: the
 * CJK notes were dropped as `empty-slug` and no page existed.
 *
 * The same build carries the site-language default: `language: zh-CN` in the
 * configuration must reach `<html lang>`, `nodes.language`, and Pagefind's
 * index for a note that declares no language of its own.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { DatabaseSync } from '../src/lib/sqlite.ts';
import { noteSlugFromPath } from '../src/lib/route-path.ts';
import { renderMarkdown } from '../src/lib/markdown.ts';
import { noteRoute } from '../src/lib/routes.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'anc.mjs');

function put(root: string, relativePath: string, body: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

test('an internal href is rewritten whether the renderer emits it raw or percent-encoded', async () => {
  // `satteri` percent-encodes a non-ASCII href. Red against the ASCII-only
  // INTERNAL_HREF: the encoded form never matched, so `/日记-今天/` stayed a
  // root-relative 404 instead of becoming `/notes/日记-今天/`.
  const { html } = await renderMarkdown('[a](/日记-今天/) [b](/%E6%97%A5%E8%AE%B0-%E4%BB%8A%E5%A4%A9/#h) [c](/Upper/)\n', {
    routeForSlug: (slug) => (slug === '日记-今天' ? noteRoute(slug) : undefined),
  });
  assert.equal((html.match(/href="\/notes\/日记-今天\/"/g) ?? []).length, 1, html);
  assert.equal((html.match(/href="\/notes\/日记-今天\/#h"/g) ?? []).length, 1, html);
  assert.ok(html.includes('href="/Upper/"'), `a non-slug href was rewritten: ${html}`);
});

test('a CJK corpus builds with Unicode slugs, encoded URLs, and the configured site language', () => {
  const root = mkdtempSync(join(tmpdir(), 'unicode-slugs-'));
  try {
    const content = join(root, 'notes');
    put(content, 'publish.config.yaml', 'language: zh-CN\n');
    put(content, '日记/今天.md', '# 今天\n\n今天我们讨论番茄的种植方法和浇水频率。\n');
    put(content, '日记/明天.md', '# 明天\n\n明天继续。\n');
    put(content, 'Projects/观点.md', '# 观点\n\n见 [[今天]] 和 [明天](../日记/明天.md)。\n');
    put(content, '🌱.md', '---\nlanguage: en\n---\n\n# Seedling\n\nAn English note with an emoji name.\n');
    spawnSync('git', ['init', '-q', '.'], { cwd: root });
    const run = spawnSync(process.execPath, [BINARY, 'build', '--content', 'notes', '--out', 'out'], {
      cwd: root,
      encoding: 'utf8',
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /content: 5 discovered, 4 published, 1 dropped \(1 not-markdown\)/, output);

    const out = join(root, 'out');
    const seed = `note-${createHash('sha256').update('🌱.md', 'utf8').digest('hex').slice(0, 10)}`;
    const slugs = ['projects-观点', '日记-今天', '日记-明天', seed];
    for (const slug of slugs) {
      assert.ok(existsSync(join(out, 'notes', slug, 'index.html')), `no page on disk for ${slug}`);
    }

    // Sitemap `<loc>` and the canonical link are percent-encoded URIs.
    const sitemap = readFileSync(join(out, 'sitemap.xml'), 'utf8');
    const today = `/notes/${encodeURIComponent('日记-今天')}/`;
    assert.ok(sitemap.includes(`${today}</loc>`), `the sitemap does not carry an encoded <loc>:\n${sitemap}`);
    for (const [, loc] of sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)) {
      assert.match(loc!, /^[\x21-\x7e]+$/, `a sitemap <loc> is not an ASCII URI: ${loc}`);
      assert.doesNotThrow(() => new URL(loc!));
    }
    const page = readFileSync(join(out, 'notes', '日记-今天', 'index.html'), 'utf8');
    assert.match(page, new RegExp(`<link rel="canonical" href="[^"]*${today}">`));

    // The link resolved to the CJK note, not to `/private/`.
    const source = readFileSync(join(out, 'notes', 'projects-观点', 'index.html'), 'utf8');
    assert.ok(source.includes('href="/notes/日记-今天/"'), 'the wikilink did not reach the CJK note');
    assert.ok(source.includes('href="/notes/日记-明天/"'), 'the relative link did not reach the CJK note');

    // The browser's encoded pathname parses back to the slug the page was built from.
    assert.equal(noteSlugFromPath(today), '日记-今天');

    // The configured language is the fallback, and a note's own wins.
    assert.match(page, /<html lang="zh-CN"/);
    assert.match(readFileSync(join(out, 'notes', seed, 'index.html'), 'utf8'), /<html lang="en"/);
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /<html lang="zh-CN"/, 'chrome ignored the site language');
    const pagefind = JSON.parse(readFileSync(join(out, 'pagefind', 'pagefind-entry.json'), 'utf8')) as {
      languages: Record<string, { page_count: number }>;
    };
    assert.equal(pagefind.languages['zh-cn']?.page_count, 3, JSON.stringify(pagefind.languages));

    // And the snapshot carries the same slugs, in canonical order, with the effective language.
    const file = readdirSync(join(out, 'data')).find((name) => name.endsWith('.sqlite'))!;
    const database = new DatabaseSync(join(out, 'data', file), { readOnly: true });
    try {
      const nodes = database.prepare('SELECT id, slug, language FROM nodes ORDER BY id').all() as {
        id: number;
        slug: string;
        language: string;
      }[];
      assert.deepEqual(nodes.map((node) => node.slug), [seed, 'projects-观点', '日记-今天', '日记-明天']);
      const bySlug = database.prepare('SELECT slug FROM nodes ORDER BY slug').all() as { slug: string }[];
      assert.deepEqual(bySlug.map((row) => row.slug), nodes.map((node) => node.slug), 'ORDER BY id and ORDER BY slug disagree');
      assert.deepEqual(
        Object.fromEntries(nodes.map((node) => [node.slug, node.language])),
        { [seed]: 'en', 'projects-观点': 'zh-CN', '日记-今天': 'zh-CN', '日记-明天': 'zh-CN' },
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 180_000);
