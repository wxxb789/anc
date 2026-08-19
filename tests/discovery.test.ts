/**
 * Discovery and exclusion: what becomes a page, and what a mistake costs.
 *
 * TK-26's premise is that this tool runs on a repository nobody wrote for it.
 * The gates below hold four properties, each of which failed on a measurement
 * rather than on a worry:
 *
 * 1. **A repository never written for this tool builds.** Mixed link styles,
 *    two files sharing a basename, non-Markdown assets, a root `README.md`,
 *    `.obsidian/`, `LICENSE`, an extensionless file, and nested directories.
 * 2. **A user's pattern matching nothing fails; a structural ignore matching
 *    nothing does not.** `drafts/**` mistyped as `draft/**` is the mistype that
 *    publishes a draft, and it is the only mitigation default-publish has.
 * 3. **The same repository publishes the same set on Windows and Linux.** Not
 *    assumed — run, on both, against the same corpus.
 * 4. **`publish: false` is honoured, and every near-miss is loud.** `publish: no`
 *    parses to the string `'no'` under YAML 1.2, and a `=== false` test reads
 *    that as consent to publish.
 *
 * ## Why the cross-platform gate runs the walk twice rather than trusting one
 *
 * The measurement that forced it: on win32, `globSync('readme.md')` returns
 * `['readme.md']` in a directory whose only such file is `README.md`. It echoes
 * the pattern back as though it were a path — `readdirSync` does not contain
 * that name — while on Linux the same call returns `[]`. A gate that ran on one
 * platform would have called that agreement.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { discover, resolveCorpusLinks } from '../scripts/markdown-to-artifact.ts';
import { FIELD_LIMITS } from '../src/lib/schema.ts';
import { BuildFailure } from '../scripts/write-report.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** A scratch directory removed when the callback returns, however it returns. */
async function scratch<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Write a file, creating the directories above it. */
function put(root: string, relativePath: string, body: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

/**
 * A repository shaped like one somebody already had, with every fixture the
 * acceptance criteria name.
 *
 * Written once and used by three gates, including the cross-platform one — which
 * is the reason it is a function of a root rather than a constant. The
 * cross-platform gate materialises the identical tree inside WSL, so any drift
 * between the two spellings would be a difference the gate then attributes to
 * the platform.
 */
const CORPUS: readonly (readonly [string, string])[] = [
  // The two acceptance-criteria files that are not notes.
  ['README.md', '# The repository\n\nBadge, install steps, and a workflow snippet.\n'],
  ['LICENSE', 'MIT License\n\nCopyright.\n'],
  // Mixed link styles, in a note that must still build.
  ['root.md', '# Root\n\nA [markdown link](notes/alpha.md) and an ![image](notes/diagram.png).\n'],
  // Two files sharing a basename, in different directories: both publish,
  // because the slug carries the path.
  ['notes/alpha.md', '# Notes alpha\n\nprose\n'],
  ['projects/alpha.md', '# Projects alpha\n\nprose\n'],
  // Nested twice, which the non-recursive producer could not see at all.
  ['projects/deep/buried.md', '# Buried\n\nprose\n'],
  // A nested README is a folder index, which is prose.
  ['notes/README.md', '# Notes index\n\nprose\n'],
  // Non-Markdown assets, discovered and never emitted.
  ['notes/diagram.png', 'not really a png\n'],
  ['Makefile', 'all:\n\techo hi\n'],
  // Tool state, structurally ignored: in neither `discovered` nor `dropped`.
  ['.obsidian/workspace.json', '{"main":{}}\n'],
  ['.obsidian/plugins/x/data.json', '{}\n'],
  ['.github/workflows/publish.yml', 'name: publish\n'],
  ['node_modules/pkg/index.js', 'module.exports = 1\n'],
  ['.gitignore', 'dist/\n'],
];

function materialise(root: string): void {
  for (const [path, body] of CORPUS) put(root, path, body);
}

test('a repository never written for this tool is discovered whole', async () => {
  await scratch('tk26-real-', async (root) => {
    materialise(root);
    const found = await discover(root);

    // The published set, named exactly. A slug carries its path, so two files
    // sharing a basename do not collide — which is the acceptance criterion, and
    // asserting the set rather than a count is what makes it visible that
    // `notes-alpha` and `projects-alpha` are both here.
    assert.deepEqual(
      found.entries.map((entry) => entry.slug).sort(),
      ['notes-alpha', 'notes-readme', 'projects-alpha', 'projects-deep-buried', 'root'],
    );

    // Recursion, stated as its own assertion because it is what TK-25's report
    // recorded as invisible: `projects/deep/buried.md` is two levels down and
    // the previous producer never enumerated it.
    assert.ok(
      found.entries.some((entry) => entry.slug === 'projects-deep-buried'),
      'a note two directories deep was not discovered, so the walk is not recursive',
    );

    // The partition, which is the invariant that makes the three counts checkable
    // against each other rather than three independent numbers.
    assert.equal(
      found.counts.discovered,
      found.counts.published + found.counts.dropped,
      'discovered !== published + dropped, so a file was counted and never accounted for',
    );
    assert.deepEqual(found.counts, { discovered: 9, published: 5, dropped: 4 });

    // Every dropped file, with a reason from the closed set.
    assert.deepEqual(
      [...found.dropped].sort((a, b) => (a.path < b.path ? -1 : 1)),
      [
        { path: 'LICENSE', reason: 'not-markdown' },
        { path: 'Makefile', reason: 'not-markdown' },
        { path: 'README.md', reason: 'repository-readme' },
        { path: 'notes/diagram.png', reason: 'not-markdown' },
      ],
    );

    // Structural ignores are in *neither* column. This is the half a count
    // cannot express: `.obsidian/` holds two files and `node_modules/` one, so a
    // walk that enumerated them and dropped them would report `discovered: 12`
    // and still publish the right five.
    const mentioned = found.dropped.map((row) => row.path).join('\n');
    for (const ignored of ['.obsidian', '.github', 'node_modules', '.gitignore']) {
      assert.ok(
        !mentioned.includes(ignored),
        `${ignored} reached the dropped list, so it was enumerated rather than pruned`,
      );
    }
  });
});

test('a nested README is prose and the root README is not', async () => {
  // Split from the gate above because it is a rule about *one* name and the
  // rule is easy to implement as "any README", which that gate would not catch:
  // its corpus would still publish five entries and drop three.
  await scratch('tk26-readme-', async (root) => {
    put(root, 'README.md', '# Repo\n\nbadge\n');
    put(root, 'guides/README.md', '# Guides\n\nindex prose\n');
    put(root, 'note.md', '# Note\n\nprose\n');

    const found = await discover(root);
    assert.deepEqual(found.entries.map((entry) => entry.slug).sort(), ['guides-readme', 'note']);
    assert.deepEqual(found.dropped, [{ path: 'README.md', reason: 'repository-readme' }]);
  });
});

test('reserved route slugs fail together with source paths only in private detail', async () => {
  await scratch('reserved-slug-', async (directory) => {
    const conflicts = [
      ['about.md', 'about', '# Reserved\n'],
      ['renamed.md', 'search', '---\nslug: search\n---\n\n# Reserved\n'],
    ] as const;
    for (const [path, , body] of conflicts) put(directory, path, body);

    let failure: BuildFailure | undefined;
    try {
      await discover(directory);
    } catch (error) {
      assert.ok(error instanceof BuildFailure);
      failure = error;
    }
    assert.equal(failure?.code, 'reserved-slug');
    assert.equal(failure?.message, '2 published notes use reserved route slugs');
    for (const [path, slug] of conflicts) {
      assert.ok(failure.detail.includes(path));
      assert.ok(failure.detail.includes(`slug "${slug}" is reserved`));
    }
  });
});

test('a user pattern matching nothing fails the build and names where it came from', async () => {
  await scratch('tk26-zero-', async (root) => {
    put(root, 'drafts/one.md', '# One\n\nprose\n');
    put(root, 'keep.md', '# Keep\n\nprose\n');

    // The pattern that works, so the failure below is about the typo rather than
    // about the mechanism.
    const matched = await discover(root, { exclude: ['drafts/**'], excludeSource: 'publish.config.ts' });
    assert.deepEqual(matched.entries.map((entry) => entry.slug), ['keep']);
    assert.deepEqual(matched.dropped, [{ path: 'drafts/one.md', reason: 'excluded-by-pattern' }]);

    // The typo. `drafts/**` mistyped as `draft/**` matches nothing, and without
    // this rule the build is green and the drafts are live.
    const failure = await discover(root, {
      exclude: ['draft/**'],
      excludeSource: 'publish.config.ts',
    }).then(
      () => undefined,
      (error: unknown) => error as { code: string; message: string; detail: string },
    );

    assert.ok(failure, 'a pattern that matched nothing did not fail the build');
    assert.equal(failure.code, 'exclusion-pattern-matched-nothing');
    // The config location reaches the message; the pattern's own text does not.
    // A gitignore-style pattern may be a bare path, so echoing it on a
    // world-readable log re-admits the disclosure the report exists to withhold.
    assert.match(failure.message, /publish\.config\.ts/);
    assert.match(failure.message, /exclude\[0\]/);
    assert.ok(
      !failure.message.includes('draft/**'),
      `the public message echoed the pattern text: ${failure.message}`,
    );
    // And the text is in the report's private half, or the user cannot act on it.
    assert.match(failure.detail, /draft\/\*\*/);

    // A structural ignore matching nothing is silent, and this is the half that
    // makes the rule a *split* rather than a rule. The corpus below carries the
    // three shipped defaults' subjects — `.git/`, `.obsidian/`, `node_modules/`
    // — and none of them is a pattern, so none can be reported as matching
    // nothing. Under a uniform zero-match rule those three would fail every
    // first push, which is finding C3.
    await scratch('tk26-structural-', async (bare) => {
      put(bare, 'note.md', '# Note\n\nprose\n');
      put(bare, '.obsidian/workspace.json', '{}\n');
      put(bare, 'node_modules/pkg/index.js', '1\n');

      const quiet = await discover(bare, { exclude: ['*.md'], excludeSource: 'publish.config.ts' });
      assert.equal(quiet.counts.discovered, 1, 'a structurally ignored file was enumerated');
      assert.deepEqual(quiet.dropped, [{ path: 'note.md', reason: 'excluded-by-pattern' }]);
    });
  });
});

test('every discovered path is offered to every pattern, not only the Markdown', async () => {
  // Plan §2.3: "'Matched' means the pattern returned true for at least one
  // *discovered* path, whatever the final verdict was." Measured before this
  // was fixed: the `not-markdown` drop ran ahead of the pattern test, so
  // excluding an asset folder — the ordinary case in a notes repository —
  // matched nothing and failed the build.
  await scratch('tk26-assets-', async (root) => {
    put(root, 'note.md', '# Note\n\nprose\n');
    put(root, 'assets/logo.png', 'not really a png\n');
    put(root, 'assets/photo.jpg', 'nor this\n');

    for (const pattern of ['assets/**', '**/*.png']) {
      const found = await discover(root, { exclude: [pattern], excludeSource: 'publish.config.ts' });
      assert.deepEqual(
        found.entries.map((entry) => entry.slug),
        ['note'],
        `excluding ${pattern} did not build`,
      );
      // The asset is still `not-markdown` rather than `excluded-by-pattern`:
      // being offered to a pattern is not the same as being dropped by one, and
      // a non-note's reason is what it is regardless of the config.
      assert.deepEqual(
        [...found.dropped].sort((a, b) => (a.path < b.path ? -1 : 1)),
        [
          { path: 'assets/logo.png', reason: 'not-markdown' },
          { path: 'assets/photo.jpg', reason: 'not-markdown' },
        ],
        `excluding ${pattern} changed how a non-note is reported`,
      );
      assert.equal(found.counts.discovered, found.counts.published + found.counts.dropped);
    }
  });
});

test('a note opening with a thematic break is not frontmatter, however it parses', async () => {
  // Three shapes, and the middle two are why "must parse as a YAML mapping" was
  // not a sufficient discriminator. Measured under that rule: `Status: draft` IS
  // a mapping, so the note lost its head; and `**Bold** opener.` is not valid
  // YAML at all, so an ordinary note with no frontmatter **failed the build**.
  for (const [name, opener] of [
    ['a plain sentence', 'Opens with a break.'],
    ['a colon, which is a valid YAML mapping', 'Status: draft note'],
    ['bold, which is not valid YAML at all', '**Bold** opener.'],
    ['a block quote', '> quoted'],
  ] as const) {
    await scratch('tk26-break-', async (root) => {
      put(root, 'note.md', `---\n\n${opener}\n\n---\n\nAnd the rest.\n`);

      const found = await discover(root);
      assert.equal(found.entries.length, 1, `${name}: the note did not survive`);
      assert.ok(
        found.entries[0]!.markdown.includes(opener),
        `${name}: the note lost its head to a frontmatter strip`,
      );
      assert.match(found.entries[0]!.markdown, /And the rest/, name);
    });
  }

  // Non-vacuity: real frontmatter is still stripped, and a malformed *real*
  // block is still loud. Without this the gate above passes on an
  // implementation that never treats anything as frontmatter.
  await scratch('tk26-break-ok-', async (root) => {
    put(root, 'note.md', '---\ntitle: Real\npublish: true\n---\n\n# Body\n\nprose\n');
    const found = await discover(root);
    assert.ok(!found.entries[0]!.markdown.includes('title:'), 'real frontmatter was not stripped');
    assert.equal(found.entries[0]!.title, 'Real');
  });
});

test('frontmatter tags and the first folder become artifact facets', async () => {
  await scratch('producer-facets-', async (root) => {
    put(
      root,
      'Projects/deep/note.md',
      '---\ntags:\n  - Security\n  - field notes\naliases:\n  - Project Note\n  - 计划笔记\n---\n\n# Note\n',
    );
    put(root, 'root.md', '---\ntags: []\n---\n\n# Root\n');

    const found = await discover(root);
    const nested = found.entries.find((entry) => entry.slug === 'projects-deep-note');
    const rootEntry = found.entries.find((entry) => entry.slug === 'root');
    assert.deepEqual(nested?.tags, ['Security', 'field notes']);
    assert.deepEqual(nested?.aliases, ['Project Note', '计划笔记']);
    assert.equal(nested?.collection, 'projects');
    assert.equal(rootEntry?.tags, undefined);
    assert.equal(rootEntry?.collection, undefined);
  });
});

test('slug language and description come from frontmatter', async () => {
  await scratch('producer-frontmatter-fields-', async (root) => {
    put(
      root,
      '研究/简介.md',
      '---\nslug: zh-introduction\nlanguage: zh-CN\n' +
        'description: A concise public summary.\n---\n\n# 简介\n',
    );
    put(root, 'alternate.md', '---\nlang: EN-gb\nlanguage: en-GB\n---\n\n# Alternate\n');

    const found = await discover(root);
    const introduction = found.entries.find((entry) => entry.slug === 'zh-introduction');
    assert.equal(introduction?.language, 'zh-CN');
    assert.equal(introduction?.description, 'A concise public summary.');
    assert.equal(introduction?.collection, undefined);
    assert.equal(found.entries.find((entry) => entry.slug === 'alternate')?.language, 'en-GB');
  });
});

test('invalid remaining frontmatter fields fail with the source path only in detail', async () => {
  const cases = [
    ['slug', 'Bad Slug', 'invalid-slug-frontmatter'],
    ['slug', '[]', 'invalid-slug-frontmatter'],
    ['slug', '""', 'invalid-slug-frontmatter'],
    ['slug', '../private', 'invalid-slug-frontmatter'],
    ['language', 'not_a_locale', 'invalid-language-frontmatter'],
    ['description', '[]', 'invalid-description-frontmatter'],
    ['description', '"   "', 'invalid-description-frontmatter'],
    ['title', '[]', 'invalid-title-frontmatter'],
  ] as const;
  for (const [field, value, code] of cases) {
    await scratch('producer-frontmatter-invalid-', async (root) => {
      put(root, 'private-project.md', `---\n${field}: ${value}\n---\n\n# Note\n`);
      const failure = await discover(root).then(
        () => undefined,
        (error: unknown) => error as BuildFailure,
      );
      assert.equal(failure?.code, code);
      assert.ok(failure?.detail.includes('private-project.md'));
      assert.ok(!failure?.message.includes('private-project.md'));
    });
  }
});

test('frontmatter metadata limits fail at the source-path seam', async () => {
  const values = [
    ['slug', 'a'.repeat(FIELD_LIMITS.strings.slug + 1), 'invalid-slug-frontmatter'],
    [
      'language',
      `en-${Array.from({ length: 6 }, () => 'abcdef').join('-')}`,
      'invalid-language-frontmatter',
    ],
    [
      'description',
      'x'.repeat(FIELD_LIMITS.strings.description + 1),
      'invalid-description-frontmatter',
    ],
  ] as const;
  for (const [field, value, code] of values) {
    await scratch('producer-frontmatter-limit-', async (root) => {
      put(root, 'bounded.md', `---\n${field}: ${value}\n---\n\n# Note\n`);
      const failure = await discover(root).then(
        () => undefined,
        (error: unknown) => error as BuildFailure,
      );
      assert.equal(failure?.code, code);
      assert.ok(failure?.detail.includes('bounded.md'));
      assert.ok(!failure?.message.includes('bounded.md'));
    });
  }
});

test('a slug override colliding with a path slug keeps the sorted first source', async () => {
  await scratch('producer-slug-collision-', async (root) => {
    put(root, 'first.md', '---\nslug: shared\n---\n\n# First\n');
    put(root, 'shared.md', '# Shared\n');
    const found = await discover(root);
    assert.deepEqual(found.entries.map((entry) => entry.slug), ['shared']);
    assert.deepEqual(found.dropped, [
      { path: 'shared.md', reason: 'slug-collision', collidedWith: 'first.md' },
    ]);
  });
});

test('lang and language must agree when both are present', async () => {
  await scratch('producer-language-type-', async (root) => {
    put(root, 'note.md', '---\nlang: []\nlanguage: en\n---\n\n# Note\n');
    const failure = await discover(root).then(
      () => undefined,
      (error: unknown) => error as BuildFailure,
    );
    assert.equal(failure?.code, 'invalid-language-frontmatter');
  });

  await scratch('producer-language-conflict-', async (root) => {
    put(root, 'note.md', '---\nlang: en\nlanguage: zh-CN\n---\n\n# Note\n');
    const failure = await discover(root).then(
      () => undefined,
      (error: unknown) => error as BuildFailure,
    );
    assert.equal(failure?.code, 'conflicting-language-frontmatter');
    assert.equal(failure?.message, 'frontmatter lang and language must name the same locale');
    assert.ok(failure?.detail.includes('note.md'));
  });
});

test('a non-ASCII first folder stays publishable and uncollected', async () => {
  await scratch('producer-cjk-collection-', async (root) => {
    put(root, '研究/note.md', '# Note\n');
    const found = await discover(root);
    assert.deepEqual(found.entries.map((entry) => entry.slug), ['note']);
    assert.equal(found.entries[0]?.collection, undefined);
  });
});

test('producer limits and safety failures identify the source only in private detail', async () => {
  const tagLimit = FIELD_LIMITS.arrays.tags;
  const tagCases = [
    Array.from({ length: tagLimit.items + 1 }, (_, index) => `tag-${index}`),
    ['x'.repeat(tagLimit.itemChars + 1)],
    ['private/path'],
    [`safe${String.fromCharCode(0x202e)}name`],
  ];
  for (const tags of tagCases) {
    await scratch('producer-tag-limit-', async (root) => {
      const yaml = tags.map((tag) => `  - ${JSON.stringify(tag)}`).join('\n');
      put(root, 'bounded-tags.md', `---\ntags:\n${yaml}\n---\n\n# Note\n`);
      const failure = await discover(root).then(
        () => undefined,
        (error: unknown) => error as BuildFailure,
      );
      assert.equal(failure?.code, 'invalid-tags-frontmatter');
      assert.ok(failure?.detail.includes('bounded-tags.md'));
      assert.ok(!failure?.message.includes('bounded-tags.md'));
    });
  }

  await scratch('producer-description-safety-', async (root) => {
    put(root, 'bounded-description.md', '---\ndescription: "javascript:alert(1)"\n---\n\n# Note\n');
    const failure = await discover(root).then(
      () => undefined,
      (error: unknown) => error as BuildFailure,
    );
    assert.equal(failure?.code, 'invalid-description-frontmatter');
    assert.equal(failure?.message, 'frontmatter description must be valid public text');
    assert.ok(failure?.detail.includes('bounded-description.md'));
    assert.ok(!failure?.message.includes('bounded-description.md'));
  });

  await scratch('producer-title-limit-', async (root) => {
    put(root, 'bounded-title.md', `# ${'x'.repeat(FIELD_LIMITS.strings.title + 1)}\n`);
    const failure = await discover(root).then(
      () => undefined,
      (error: unknown) => error as BuildFailure,
    );
    assert.equal(failure?.code, 'title-too-long');
    assert.ok(failure?.detail.includes('bounded-title.md'));
    assert.ok(!failure?.message.includes('bounded-title.md'));
  });

  await scratch('producer-collection-limit-', async (root) => {
    const folder = 'x'.repeat(FIELD_LIMITS.strings.collection + 1);
    put(root, `${folder}/note.md`, '# Note\n');
    const failure = await discover(root).then(
      () => undefined,
      (error: unknown) => error as BuildFailure,
    );
    assert.equal(failure?.code, 'collection-folder-too-long');
    assert.ok(failure?.detail.includes('/note.md'));
    assert.ok(!failure?.message.includes('/note.md'));
  });
});

test('invalid alias lists fail with the source only in private detail', async () => {
  const limit = FIELD_LIMITS.arrays.aliases;
  const cases = [
    'Older Name',
    '["Same", "Same"]',
    '["private/path"]',
    JSON.stringify(['x'.repeat(limit.itemChars + 1)]),
    JSON.stringify(Array.from({ length: limit.items + 1 }, (_, index) => `alias-${index}`)),
  ];
  for (const aliases of cases) {
    await scratch('producer-alias-invalid-', async (root) => {
      put(root, 'private-alias.md', `---\naliases: ${aliases}\n---\n\n# Note\n`);
      const failure = await discover(root).then(
        () => undefined,
        (error: unknown) => error as BuildFailure,
      );
      assert.equal(failure?.code, 'invalid-aliases-frontmatter');
      assert.equal(failure?.message, 'frontmatter aliases must be a YAML list of non-empty text');
      assert.ok(failure?.detail.includes('private-alias.md'));
      assert.ok(!failure?.message.includes('private-alias.md'));
    });
  }
});

test('alias conflicts fail by count with both source paths only in private detail', async () => {
  for (const [secondSlug, secondAlias] of [
    ['second', 'Shared Name'],
    ['shared-name', 'first'],
  ] as const) {
    await scratch('producer-alias-conflict-', async (root) => {
      put(root, 'first.md', '---\naliases: ["Shared Name"]\n---\n\n# First\n');
      put(root, `${secondSlug}.md`, `---\naliases: [${JSON.stringify(secondAlias)}]\n---\n\n# Second\n`);
      const failure = await discover(root).then(
        () => undefined,
        (error: unknown) => error as BuildFailure,
      );
      assert.equal(failure?.code, 'alias-collision');
      assert.match(failure?.message ?? '', /^1 published alias claim conflicts$/);
      assert.ok(failure?.detail.includes('first.md'));
      assert.ok(failure?.detail.includes(`${secondSlug}.md`));
      assert.ok(!failure?.message.includes('Shared Name'));
      assert.ok(!failure?.message.includes('first.md'));
    });
  }
});

test('aliases remain metadata rather than wikilink targets', async () => {
  await scratch('producer-alias-link-', async (root) => {
    put(root, 'target.md', '---\naliases: ["Old Name"]\n---\n\n# Target\n');
    put(root, 'source.md', '# Source\n\n[[Old Name]]\n');
    const found = await discover(root);
    const findings = await resolveCorpusLinks(found);
    assert.deepEqual(found.entries.find((entry) => entry.slug === 'source')?.outgoing, []);
    assert.ok(findings.some((row) => row.outcome === 'unresolved' && row.link === '[[Old Name]]'));
  });
});

test('a path that derives no slug is dropped rather than published or failed', async () => {
  await scratch('producer-empty-slug-', async (root) => {
    put(root, '___.md', '# No route key\n');
    put(root, 'note.md', '# Note\n');
    const found = await discover(root);
    assert.deepEqual(found.entries.map((entry) => entry.slug), ['note']);
    assert.deepEqual(found.dropped, [{ path: '___.md', reason: 'empty-slug' }]);
  });
});

test('a scalar or empty frontmatter tag fails without naming the file publicly', async () => {
  for (const tags of ['Security', '[Security, ""]', '[" Security " ]']) {
    await scratch('producer-tags-', async (root) => {
      put(root, 'private-project.md', `---\ntags: ${tags}\n---\n\n# Note\n`);
      let failure: BuildFailure | undefined;
      try {
        await discover(root);
      } catch (error) {
        assert.ok(error instanceof BuildFailure);
        failure = error;
      }
      assert.equal(failure?.code, 'invalid-tags-frontmatter');
      assert.equal(failure?.message, 'frontmatter tags must be a YAML list of non-empty text');
      assert.ok(failure?.detail.includes('private-project.md'));
    });
  }
});

test('the root README is re-includable, as the plan says it is', async () => {
  // Plan §2.2: root `README.md` is "excluded by default, re-includable with
  // `!README.md`". Measured before this was fixed: the default was an
  // unconditional pre-pattern drop, so the documented spelling matched nothing
  // and failed the build — the one pattern the plan names by name.
  await scratch('tk26-reinclude-', async (root) => {
    put(root, 'README.md', '# The repository\n\nbadge\n');
    put(root, 'note.md', '# Note\n\nprose\n');

    const found = await discover(root, { exclude: ['!README.md'], excludeSource: 'publish.config.ts' });
    assert.deepEqual(found.entries.map((entry) => entry.slug).sort(), ['note', 'readme']);
    assert.deepEqual(found.dropped, []);
  });
});

test('a symlinked note is discovered rather than vanishing from both columns', async (context) => {
  // The partition is the report's whole claim, and this is the one path that
  // used to escape it silently. Measured on win32 (Node 24.18.1): a symlink to
  // a file reports `isFile() === false` and `isSymbolicLink() === true` under
  // `withFileTypes`, so an `isFile()`-only branch counted it in neither
  // `discovered` nor `dropped`. TK-25 §4.2 records the opposite as measured.
  await scratch('tk26-symlink-', async (root) => {
    put(root, 'real.md', '# Real\n\nprose\n');
    try {
      symlinkSync('real.md', join(root, 'link.md'), 'file');
    } catch {
      // Creating a symlink on win32 needs a privilege the runner may not hold.
      context.skip(true, 'this host cannot create a symlink');
      return;
    }

    const found = await discover(root);
    assert.equal(
      found.counts.discovered,
      found.counts.published + found.counts.dropped,
      'a symlinked note left the partition',
    );
    assert.equal(found.counts.discovered, 2, 'the symlinked note was not discovered');
    assert.deepEqual(found.entries.map((entry) => entry.slug).sort(), ['link', 'real']);
  });
});

test('an origin that is not a config filename never reaches the message', async () => {
  // The disclosure rule, applied to this module's one caller-supplied string.
  // "The caller passed it" is not a safety argument, for the same reason
  // `tests/disclosure.test.ts` records that "the user typed it" is not: a
  // withheld note's stem is a perfectly good string to pass here by accident.
  await scratch('tk26-origin-', async (root) => {
    put(root, 'note.md', '# Note\n\nprose\n');

    // The bare stem and the bare filename are the fixtures that matter: an
    // earlier `CONFIG_LOCATION` blocked only separators and spaces, so both of
    // these — a withheld note's name, and its stem — reached the stream while
    // the path-shaped fixtures below made the gate look green.
    for (const origin of [
      'zzq2026-layoffs',
      'zzqsecret-client.md',
      'zzqclients/acme/2026-renewal.md',
      'C:\\vault\\zzqsecret.md',
      'the zzq list',
    ]) {
      const failure = await discover(root, { exclude: ['draft/**'], excludeSource: origin }).then(
        () => undefined,
        (error: unknown) => error as { message: string },
      );
      assert.ok(failure, 'the zero-match rule did not fire');
      assert.ok(
        !failure.message.includes('zzq'),
        `a caller-supplied origin reached the stream: ${failure.message}`,
      );
    }

    // Non-vacuity: a real config filename *does* reach it, or the assertion
    // above would pass on an implementation that printed nothing at all.
    const named = await discover(root, {
      exclude: ['draft/**'],
      excludeSource: 'publish.config.ts',
    }).then(
      () => undefined,
      (error: unknown) => error as { message: string },
    );
    assert.match(named!.message, /publish\.config\.ts/);
  });
});

test('a pattern shadowed by a later rule still counts as matched', async () => {
  // Order-independence, stated as its own gate: "matched" means the pattern
  // returned true for at least one discovered path, whatever the final verdict
  // was. Without it a user whose second rule re-includes everything the first
  // excluded gets a build failure naming a pattern that did its job.
  await scratch('tk26-shadow-', async (root) => {
    put(root, 'drafts/one.md', '# One\n\nprose\n');
    put(root, 'keep.md', '# Keep\n\nprose\n');

    const found = await discover(root, {
      exclude: ['drafts/**', '!drafts/one.md'],
      excludeSource: 'publish.config.ts',
    });
    assert.deepEqual(found.entries.map((entry) => entry.slug).sort(), ['drafts-one', 'keep']);
    assert.equal(found.counts.dropped, 0);
  });
});

test('publish: false is honoured, and outranks a re-including pattern', async () => {
  await scratch('tk26-flag-', async (root) => {
    put(root, 'private.md', '---\npublish: false\n---\n\n# Private\n\nwithheld prose\n');
    put(root, 'open.md', '---\npublish: true\n---\n\n# Open\n\nprose\n');
    put(root, 'plain.md', '# Plain\n\nprose\n');

    const found = await discover(root);
    assert.deepEqual(found.entries.map((entry) => entry.slug).sort(), ['open', 'plain']);
    assert.deepEqual(found.dropped, [{ path: 'private.md', reason: 'excluded-by-frontmatter' }]);

    // The asymmetry, which is the whole design: the mechanism pointing toward
    // *not* publishing is the three words inside the file itself, and a `!`
    // re-include cannot resurrect it.
    const reincluded = await discover(root, {
      exclude: ['*.md', '!private.md', '!open.md', '!plain.md'],
      excludeSource: 'publish.config.ts',
    });
    assert.ok(
      !reincluded.entries.some((entry) => entry.slug === 'private'),
      'a `!` re-include resurrected a note that asked not to be published',
    );

    // The frontmatter never reaches the rendered body. Measured before this
    // ticket: a note carrying `publish: false` published *and* printed its own
    // frontmatter into the page, because the renderer runs with
    // `frontmatter: false` and a block left in `markdown` renders as content.
    const open = found.entries.find((entry) => entry.slug === 'open');
    assert.ok(open && !open.markdown.includes('publish:'), 'frontmatter leaked into the body');
    assert.ok(!open.excerpt.includes('publish:'), 'frontmatter leaked into the excerpt');
  });
});

test('a near-miss publish flag fails loudly rather than publishing', async () => {
  // H2's second half. YAML 1.2 dropped YAML 1.1's `no`/`off` booleans, so every
  // spelling below parses to a string or a number — and a `=== false` test reads
  // each of them as consent to publish the note.
  for (const spelling of ['no', 'No', 'off', '"false"', '0', 'nope']) {
    await scratch('tk26-nearmiss-', async (root) => {
      put(root, 'note.md', `---\npublish: ${spelling}\n---\n\n# Note\n\nwithheld prose\n`);

      const failure = await discover(root).then(
        () => undefined,
        (error: unknown) => error as { code: string; detail: string },
      );
      assert.ok(failure, `publish: ${spelling} was accepted, and the note published`);
      assert.equal(failure.code, 'non-boolean-publish-flag', `publish: ${spelling}`);
      assert.match(failure.detail, /note\.md/, 'the report cannot say which file');
    });
  }

  // Non-vacuity: the two real booleans are not caught by the same rule, or the
  // gate above would pass on an implementation that rejected every `publish:`.
  await scratch('tk26-nearmiss-ok-', async (root) => {
    put(root, 'yes.md', '---\npublish: true\n---\n\n# Yes\n\nprose\n');
    put(root, 'no.md', '---\npublish: false\n---\n\n# No\n\nprose\n');
    const found = await discover(root);
    assert.deepEqual(found.entries.map((entry) => entry.slug), ['yes']);
  });
});

test('malformed YAML anywhere in the frontmatter fails rather than publishing', async () => {
  // H2's first half, and the reason it is not a warning: a parse error takes
  // `publish: false` down with it silently. The field is never read, and the
  // note the user withheld is published.
  await scratch('tk26-badyaml-', async (root) => {
    put(root, 'note.md', '---\ntitle: [unclosed\npublish: false\n---\n\n# Note\n\nwithheld prose\n');

    const failure = await discover(root).then(
      () => undefined,
      (error: unknown) => error as { code: string; message: string; detail: string },
    );
    assert.ok(failure, 'malformed frontmatter was ignored, and the note published');
    assert.equal(failure.code, 'malformed-frontmatter');
    // The filename is in the report and not in the message: for a withheld note
    // the leaf *is* the disclosure, and this message reaches a workflow log.
    assert.match(failure.detail, /note\.md/);
    assert.ok(!failure.message.includes('note.md'), `the public message named the file: ${failure.message}`);
  });

  // A note that merely opens with a thematic break is not frontmatter, and must
  // still build. `export.py`'s regex ate everything up to the second `---`
  // wherever it was, so this is the defect that fixture exists for.
  await scratch('tk26-thematic-', async (root) => {
    put(root, 'note.md', '# Note\n\n---\n\nAfter the break.\n\n---\n\nAnd after the second.\n');
    const found = await discover(root);
    assert.equal(found.entries.length, 1);
    assert.match(found.entries[0]!.markdown, /After the break/);
    assert.match(found.entries[0]!.markdown, /And after the second/);
  });
});

/**
 * A runner for *the other* platform, or `undefined` if this host has none.
 *
 * The gate this serves compares two operating systems, so the runner has to be
 * a genuinely different one. On win32 that is WSL. On Linux there is no Windows
 * to reach, and running the corpus through a second local Node would compare
 * Linux against Linux — a gate that passes by construction and measures nothing.
 * So the Linux host skips, and says why.
 *
 * That leaves the pairing honest rather than reciprocal: this property is
 * proven on a developer machine with WSL, and CI (`ubuntu-latest`) contributes
 * the other half by running the whole suite natively on Linux. The two hosts
 * together are what make the claim, and neither alone does.
 *
 * **`bash -lc`, and the two reasons it is not `wsl -e node`.** Measured on this
 * host: `node` lives on a version-manager shim reached only by a login shell's
 * profile, so `wsl.exe -e node` reports `execvpe(node) failed`. And naming the
 * shim's absolute path does not help from git-bash — MSYS path conversion
 * rewrites `/home/…` into `C:/Program Files/Git/home/…` before WSL sees it, so
 * the argument that would fix the first problem is mangled by the second. A
 * login shell resolves the name on the far side of both.
 */
function linuxRunner(): ((script: string, corpus: string) => string) | undefined {
  if (process.platform !== 'win32') return undefined;

  const probe = spawnSync('wsl.exe', ['--', 'bash', '-lc', 'node --version'], { encoding: 'utf8' });
  if (probe.status !== 0 || !/^v\d/.test(probe.stdout.replace(/\0/g, '').trim())) return undefined;

  return (script, corpus) => {
    const result = spawnSync('wsl.exe', ['--', 'bash', '-lc', 'node -e "$TK26_SCRIPT"'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TK26_SCRIPT: script,
        // `WSLENV` is what carries these across the boundary at all, since WSL
        // does not inherit the Windows environment by default; the `/p` flag is
        // what translates a Windows path into one addressable on the far side.
        WSLENV: 'TK26_SCRIPT:TK26_ROOT/p:TK26_CORPUS/p',
        TK26_ROOT: ROOT,
        TK26_CORPUS: corpus,
      },
    });
    return `${result.stdout}${result.stderr}`.replace(/\0/g, '');
  };
}

test('the same repository publishes the same set on Windows and Linux', async (context) => {
  const linux = linuxRunner();
  if (linux === undefined) {
    // Skipped rather than failed, matching how this repository already degrades
    // a host-dependent gate — AGENTS.md's table runs the browser gates "when
    // Chromium is installed". A hard failure here would make `pnpm run verify`
    // red on any host without WSL, and on CI, which is Linux and has no Windows
    // to compare against; that is a gate deleted rather than fixed.
    context.skip(true, 'no second platform to compare against on this host');
    return;
  }

  await scratch('tk26-platform-', async (root) => {
    materialise(root);
    // The case-divergence fixture, which is the whole reason this gate exists.
    // Measured: `globSync('readme.md')` on win32 returns `['readme.md']` when
    // only `README.md` is on disk — the pattern echoed back as a path — while on
    // Linux it returns `[]`. Discovery therefore never calls `globSync`, and
    // this pair proves the two platforms agree about which of them is a note.
    put(root, 'guides/CaseNote.md', '# Case\n\nprose\n');
    // The extension in the other case, which is where the two platforms actually
    // diverge. Measured: `globSync('**\/*.MD')` returns all three Markdown files
    // on win32 and `[]` on Linux, so an extension test that lowercases — or any
    // discovery built on a glob — publishes this file here and drops it in CI.
    // Byte-exact `.md` gives one answer on both, and this is the file that
    // proves the gate can see the difference.
    put(root, 'guides/upper.MD', '# Upper extension\n\nprose\n');

    const here = await discover(root);
    const mine = {
      published: here.entries.map((entry) => entry.slug).sort(),
      dropped: here.dropped.map((row) => `${row.path}:${row.reason}`).sort(),
      counts: here.counts,
    };

    // Run the *same* module under the other platform's Node, against the same
    // bytes on disk. `WSLENV`'s `/p` flag translates both paths on the way
    // across, so the module and the corpus are addressable on the far side.
    const script =
      `const {pathToFileURL}=require('node:url');` +
      `const {join}=require('node:path');` +
      `import(pathToFileURL(join(process.env.TK26_ROOT,'scripts','markdown-to-artifact.ts')).href)` +
      `.then(async (m) => {` +
      `const d = await m.discover(process.env.TK26_CORPUS);` +
      `console.log(JSON.stringify({` +
      `published: d.entries.map((e) => e.slug).sort(),` +
      `dropped: d.dropped.map((r) => r.path + ':' + r.reason).sort(),` +
      `counts: d.counts}));` +
      `}).catch((e) => { console.log(JSON.stringify({error: String((e && e.message) || e)})); });`;

    const output = linux(script, root);
    const lastLine = output.trim().split('\n').at(-1) ?? '';
    let theirs: typeof mine & { error?: string };
    try {
      theirs = JSON.parse(lastLine) as typeof mine & { error?: string };
    } catch {
      assert.fail(`the Linux run produced no result:\n${output}`);
    }
    assert.ok(!theirs.error, `the Linux run failed: ${theirs.error}`);

    assert.deepEqual(
      theirs.published,
      mine.published,
      'the two platforms publish different sets from the same repository',
    );
    assert.deepEqual(theirs.dropped, mine.dropped, 'the two platforms drop different files');
    assert.deepEqual(theirs.counts, mine.counts, 'the two platforms count differently');

    // Non-vacuity: the comparison must be over a non-empty set, or two failed
    // runs would agree perfectly.
    assert.ok(mine.published.length >= 5, 'the corpus published too little to compare');
  });
  // Two full discovery passes over the same corpus, one of them **through WSL**
  // — a second Node on the other side of an interop boundary, importing the
  // producer and paying its own cold module graph.
  //
  // Measured across six full runs: 39, 40, 53, 63, 64, and **108 s**. The last
  // is 90% of the 120 s this carried, and it crossed on a seventh run measured
  // on a host 2.4x degraded. A gate whose worst observed sample uses nine-tenths
  // of its bound is not bounded, it is coincident.
  //
  // 300 s is ~2.8x the observed maximum. The multiple is high for a cost that
  // looks deterministic because the WSL half is not: it crosses a process, a
  // filesystem translation, and a second Node's startup, none of which this side
  // schedules. A hung interop call still fails in five minutes.
}, 300_000);

test('the walk is ordered, so a slug collision has a predictable winner', async () => {
  // `readdir` order is unspecified and measured different between platforms, and
  // the collision winner is decided by it. Without the sort the same repository
  // publishes a different note's *body* under the same slug on the two
  // platforms — which the cross-platform gate above cannot see, because both
  // runs report the same slug either way.
  await scratch('tk26-order-', async (root) => {
    put(root, 'Zeta note.md', '# Zeta\n\nprose\n');
    put(root, 'zeta-note.md', '# Lowercase\n\nprose\n');

    const found = await discover(root);
    assert.equal(found.entries.length, 1);
    assert.deepEqual(found.dropped, [
      { path: 'zeta-note.md', reason: 'slug-collision', collidedWith: 'Zeta note.md' },
    ]);
    // The winner is the first in the sorted walk, and its *body* is what shipped.
    assert.match(found.entries[0]!.markdown, /# Zeta/);
  });
});

test('the producer imports no package absent from the manifest', () => {
  // pnpm's symlinked `node_modules` makes this a real failure mode rather than a
  // style rule: a module importing a package that is only a transitive
  // dependency resolves here and fails in a consumer's install. `yaml` is a new
  // direct dependency of this ticket, and this is what pins it as one.
  const source = readFileSync(join(ROOT, 'scripts', 'markdown-to-artifact.ts'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };

  const imports = [...source.matchAll(/from '([^']+)'/g)]
    .map((match) => match[1]!)
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'));

  assert.ok(imports.includes('yaml'), 'the frontmatter parser is no longer imported here');
  for (const specifier of imports) {
    assert.ok(
      specifier in manifest.dependencies,
      `${specifier} is imported but is not a direct dependency, so it resolves here and not in an install`,
    );
  }
});
