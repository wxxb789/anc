import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIELD_LIMITS,
  MAX_ENTRIES,
  RESERVED_SLUGS,
  SCHEMA_VERSION,
  ContentValidationError,
  validateArtifact,
  type ContentArtifact,
} from '../src/lib/schema.ts';
import { checkIndexProjection, projectIndex } from '../scripts/validate-content.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const INVALID = new URL('./fixtures/invalid/', import.meta.url);

function load(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** `assert.throws` returns nothing, so capture the error to inspect its issues. */
function expectRejection(run: () => unknown): ContentValidationError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ContentValidationError, `expected ContentValidationError, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected validation to throw');
}

function rejection(name: string): ContentValidationError {
  return expectRejection(() => validateArtifact(load(new URL(`${name}.json`, INVALID)), name));
}

test('minimal artifact passes the contract', () => {
  const artifact = validateArtifact(load(new URL('valid-minimal.json', FIXTURES)));
  assert.equal(artifact.version, SCHEMA_VERSION);
  assert.equal(artifact.entries.length, 1);
  assert.equal(artifact.entries[0]?.slug, 'first-note');
});

test('rich artifact round-trips with every optional field intact', () => {
  const source = load(new URL('valid-rich.json', FIXTURES));
  const artifact = validateArtifact(source);

  assert.deepEqual(artifact, source, 'validation must not mutate or drop fields');

  const alpha = artifact.entries.find((entry) => entry.slug === 'alpha-note');
  assert.ok(alpha);
  assert.equal(alpha.public_id, 'pub-0001');
  assert.equal(alpha.created, '2026-01-01');
  assert.equal(alpha.updated, '2026-08-06T12:00:00Z');
  assert.equal(alpha.language, 'en');
  assert.deepEqual(alpha.tags, ['gardening', 'synthetic']);
  assert.equal(alpha.collection, 'field-notes');
  assert.equal(alpha.status, 'published');
  assert.deepEqual(alpha.aliases, ['Alpha', 'alpha']);
  assert.equal(alpha.description, 'A synthetic description for the alpha note.');

  const beta = artifact.entries.find((entry) => entry.slug === 'beta-note');
  assert.equal(beta?.language, 'zh-CN', 'zh-CN language metadata survives validation');

  const gamma = artifact.entries.find((entry) => entry.slug === 'gamma-note');
  assert.equal(gamma?.status, 'tombstone');
  assert.match(gamma?.markdown ?? '', /data:image\/png;base64,/, 'allowlisted image data URI is permitted');
});

test('the real artifact and its public index satisfy the contract', () => {
  const artifact = validateArtifact(
    load(new URL('../src/data/content.json', import.meta.url)),
    'src/data/content.json',
  );
  const index = load(new URL('../public/content-index.json', import.meta.url));
  assert.deepEqual(checkIndexProjection(index, artifact), []);
});

test('the public index must stay an exact {slug, title, excerpt} projection', () => {
  const artifact = validateArtifact(load(new URL('valid-rich.json', FIXTURES))) as ContentArtifact;

  assert.deepEqual(checkIndexProjection(projectIndex(artifact), artifact), []);

  const leaked = projectIndex(artifact) as { entries: Record<string, unknown>[] };
  leaked.entries[0]!['markdown'] = artifact.entries[0]!.markdown;
  assert.equal(checkIndexProjection(leaked, artifact).length, 1, 'extra field is rejected');

  const stale = projectIndex(artifact);
  stale.entries.pop();
  assert.equal(checkIndexProjection(stale, artifact).length, 1, 'missing entry is rejected');

  const emptied = projectIndex(artifact);
  emptied.entries[0]!.title = 'Something Else';
  assert.equal(checkIndexProjection(emptied, artifact).length, 1, 'altered title is rejected');
});

/**
 * Each rejected invariant has a fixture, and each fixture must fail for the
 * stated reason rather than incidentally.
 */
const REJECTED: ReadonlyArray<readonly [string, RegExp]> = [
  ['artifact-unknown-field', /generatedAt: unknown field is not allowed/],
  ['artifact-wrong-version', /version: must be 1, got 2/],
  ['artifact-entries-not-array', /entries: must be an array/],
  ['entry-unknown-field', /\.sourcePath: unknown field is not allowed/],
  ['entry-missing-required-field', /\.markdown: is required and must be a string/],
  ['entry-missing-outgoing', /\.outgoing: is required/],
  ['slug-uppercase', /\.slug: must be lowercase/],
  ['slug-leading-hyphen', /\.slug: must be lowercase/],
  ['slug-trailing-hyphen', /\.slug: must be lowercase/],
  ['slug-illegal-character', /\.slug: must be lowercase/],
  ['slug-reserved-segment', /\.slug: collides with reserved route segment "tags"/],
  ['created-not-iso-date', /\.created: must be an ISO 8601 date when present/],
  ['language-not-bcp47', /\.language: must be a BCP 47 language tag when present/],
  ['status-unknown-value', /\.status: must be one of published, tombstone when present/],
  ['tag-contains-slash', /\.tags\[0\]: must not contain "\/" or a control character/],
  ['collection-not-slug', /\.collection: must be lowercase/],
  ['entry-self-link', /\.outgoing: must not link to itself/],
  ['outgoing-dangling-slug', /\.outgoing: "missing-note" does not resolve to a published entry/],
  ['backlink-dangling-slug', /\.backlinks: "missing-note" does not resolve to a published entry/],
  ['duplicate-slug', /entries: duplicate slug "one-note"/],
  ['backlinks-not-inverse-of-outgoing', /\.backlinks: must be the exact inverse of outgoing links/],
  ['outgoing-unsorted', /\.outgoing: must be sorted in ascending order/],
  ['outgoing-duplicate', /\.outgoing: must not contain duplicates/],
  ['backlinks-unsorted', /\.backlinks: must be sorted in ascending order/],
  ['backlinks-duplicate', /\.backlinks: must not contain duplicates/],
  ['alias-collides-with-other-entry', /alias "Shared Alias" is claimed by both/],
  ['privacy-msw-marker', /forbidden private "msw\/" path marker/],
  ['privacy-unresolved-wikilink', /forbidden unresolved \[\[wikilink\]\]/],
  ['privacy-absolute-local-path', /forbidden absolute local path/],
  ['privacy-file-url', /forbidden file:\/\/ URL/],
  ['privacy-javascript-url', /forbidden javascript: URL/],
  ['privacy-javascript-url-obfuscated', /forbidden javascript: URL/],
  ['privacy-javascript-url-entity-encoded', /forbidden javascript: URL/],
  ['privacy-vbscript-url', /forbidden vbscript: URL/],
  ['privacy-non-image-data-url', /forbidden non-image data: URL/],
  ['privacy-data-url-no-media-type', /forbidden non-image data: URL/],
  ['privacy-data-url-split-by-whitespace', /forbidden non-image data: URL/],
];

for (const [name, expected] of REJECTED) {
  test(`rejects ${name}`, () => {
    const error = rejection(name);
    assert.ok(
      error.issues.some((issue) => expected.test(issue)),
      `expected an issue matching ${expected}, got:\n${error.issues.join('\n')}`,
    );
  });
}

test('every invalid fixture is covered by a rejection test', () => {
  const files = readdirSync(INVALID)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
  assert.deepEqual(files, REJECTED.map(([name]) => name).sort());
});

test('validation errors name the offending entry and field', () => {
  const error = rejection('entry-unknown-field');
  assert.match(error.message, /entry-unknown-field: 1 content contract violation/);
  assert.match(error.message, /entries\[0\] \(slug "first-note"\)\.sourcePath/);
});

test('every entry-level violation is reported in one pass', () => {
  const error = expectRejection(() =>
    validateArtifact({
      version: 1,
      entries: [
        { slug: 'Bad Slug', title: '', excerpt: '', markdown: 'x', outgoing: [], backlinks: [] },
        { slug: 'also bad', title: 'Also Bad', excerpt: '', markdown: '', outgoing: [], backlinks: [] },
      ],
    }),
  );
  assert.ok(
    error.issues.some((issue) => issue.includes('entries[0]') && issue.includes('.slug')),
    'reports the first entry slug',
  );
  assert.ok(
    error.issues.some((issue) => issue.includes('entries[0]') && issue.includes('.title')),
    'reports the first entry title in the same pass',
  );
  assert.ok(
    error.issues.some((issue) => issue.includes('entries[1]')),
    'keeps checking later entries after an earlier one fails',
  );
});

test('corpus checks are deferred until every entry is structurally valid', () => {
  // A structurally broken entry would make cross-entry link errors misleading,
  // so link resolution runs only once each entry has passed its own checks.
  const broken = expectRejection(() =>
    validateArtifact({
      version: 1,
      entries: [
        { slug: 'Bad Slug', title: 'Bad', excerpt: '', markdown: 'x', outgoing: ['nope'], backlinks: [] },
      ],
    }),
  );
  assert.ok(!broken.issues.some((issue) => issue.includes('does not resolve')));

  const structurallyValid = expectRejection(() =>
    validateArtifact({
      version: 1,
      entries: [{ slug: 'good-slug', title: 'Good', excerpt: '', markdown: 'x', outgoing: ['nope'], backlinks: [] }],
    }),
  );
  assert.ok(structurallyValid.issues.some((issue) => issue.includes('"nope" does not resolve to a published entry')));
});

test('every reserved route segment is rejected as a slug', () => {
  for (const reserved of RESERVED_SLUGS) {
    const error = expectRejection(() =>
      validateArtifact({
        version: 1,
        entries: [
          {
            slug: reserved,
            title: 'Reserved',
            excerpt: '',
            markdown: '# Reserved\n',
            outgoing: [],
            backlinks: [],
          },
        ],
      }),
    );
    assert.ok(
      error.issues.some((issue) => issue.includes(`collides with reserved route segment "${reserved}"`)),
      `reserved slug "${reserved}" was not rejected`,
    );
  }
});

test('an empty corpus is valid', () => {
  assert.deepEqual(validateArtifact({ version: 1, entries: [] }).entries, []);
});

/** Build one valid single-entry artifact whose markdown is the string under test. */
function withMarkdown(markdown: string): unknown {
  return {
    version: 1,
    entries: [
      { slug: 'probe-note', title: 'Probe', excerpt: '', markdown, outgoing: [], backlinks: [] },
    ],
  };
}

test('privacy rules judge parsed strings, not the JSON encoding', () => {
  // A newline is "\" + "n" in JSON text, which once made ordinary prose ending in
  // a single letter and a colon look like the Windows drive path "A:\".
  for (const prose of [
    'Option A:\n- first\n- second\n',
    '## Q:\n\nAn answer.\n',
    'Column a:\tvalue\n',
    'Ends with a colon:\n',
  ]) {
    assert.doesNotThrow(() => validateArtifact(withMarkdown(prose)), `wrongly rejected: ${JSON.stringify(prose)}`);
  }
});

test('real Windows drive paths are still rejected', () => {
  for (const path of ['C:\\Users\\someone\\note.md', 'D:/repos/private/vault', 'see Z:\\share']) {
    const error = expectRejection(() => validateArtifact(withMarkdown(`Exported from ${path}\n`)));
    assert.ok(error.issues.some((issue) => issue.includes('absolute local path')), `missed: ${path}`);
  }
});

test('scheme rules stay strict even when that costs a prose false positive', () => {
  // Stripping whitespace is required to catch `java\tscript:` inside one URL, and
  // the same normalization joins two lines, so prose wrapping between "java" and
  // "script:" is rejected. The exporter applies the identical rule
  // (`reject_unsafe_scheme_tokens`), so such content cannot reach the artifact in
  // the first place. Documented here so the strictness is a choice, not a bug.
  const error = expectRejection(() => validateArtifact(withMarkdown('the word java\nscript: a heading\n')));
  assert.ok(error.issues.some((issue) => issue.includes('forbidden javascript: URL')));
});

test('whitespace-split unsafe schemes inside one value are still rejected', () => {
  const colon = String.fromCharCode(58);
  for (const href of [`java\tscript${colon}alert(1)`, `vb\nscript${colon}msgbox(1)`]) {
    const error = expectRejection(() => validateArtifact(withMarkdown(`<a href="${href}">x</a>\n`)));
    assert.ok(error.issues.some((issue) => /forbidden (java|vb)script: URL/.test(issue)), `missed: ${href}`);
  }
});

test('data: URLs are judged on the separator, not the media type', () => {
  const colon = String.fromCharCode(58);
  for (const url of [
    `data${colon},<h1>hi</h1>`,
    `data${colon};base64,PHNjcmlwdD4=`,
    `data${colon}text\t/html,x`,
    `data${colon}image/svg+xml,<svg/>`,
    `data${colon}text/html;charset="utf-8",<script>alert(1)</script>`,
    `data${colon}text/html;x=%,<b>`,
    `data${colon}*/*,<b>`,
    `data${colon}text/x_html,<b>`,
    `data${colon}text/html;x="a,b",<script>alert(1)</script>`,
    // A browser trims whitespace around the media type before parsing it, so
    // these resolve to text/html even though the space breaks a naive match.
    `data${colon} text/html,<script>alert(1)</script>`,
    `data${colon}text/html ,<script>alert(1)</script>`,
  ]) {
    const error = expectRejection(() => validateArtifact(withMarkdown(`<a href="${url}">x</a>\n`)));
    assert.ok(error.issues.some((issue) => issue.includes('non-image data: URL')), `missed: ${url}`);
  }

  // The allowlisted raster image form stays permitted, in any case.
  assert.doesNotThrow(() =>
    validateArtifact(withMarkdown(`![alt](data${colon}image/png;base64,iVBORw0KGgo=)\n`)),
  );
  assert.doesNotThrow(() =>
    validateArtifact(withMarkdown(`![alt](DATA${colon}IMAGE/PNG;BASE64,iVBORw0KGgo=)\n`)),
  );
});

test('prose containing "data:" is not mistaken for a data URL', () => {
  // A URL cannot contain a literal space, so a space must break the match:
  // otherwise any note mentioning data, a path, and a comma fails the build.
  const colon = String.fromCharCode(58);
  for (const prose of [
    `Sample data${colon} see docs/guide, then run it.\n`,
    `## Data${colon} collection method\n\nNotes live in notes/2026, and the export is a CSV.\n`,
    `metadata${colon} see the notes/index page, updated weekly\n`,
    `Field data${colon} 10 km/h, measured.\n`,
    `Response data${colon} see the table below.\n`,
  ]) {
    assert.doesNotThrow(() => validateArtifact(withMarkdown(prose)), `wrongly rejected: ${prose}`);
  }
});

test('invisible characters cannot hide a structural marker', () => {
  // These render as `msw/secret`, `[[link]]` and `C:\Users` in a browser, so the
  // markers must be found with the invisible characters removed.
  const zwj = String.fromCharCode(0x200d);
  const zwsp = String.fromCharCode(0x200b);
  const shy = String.fromCharCode(0x00ad);
  const bom = String.fromCharCode(0xfeff);

  for (const [markdown, expected] of [
    [`See msw${zwj}/secret for details.\n`, 'msw/'],
    [`See msw${zwsp}/secret for details.\n`, 'msw/'],
    [`A [${shy}[Hidden Link]] here.\n`, 'wikilink'],
    [`Exported from C${bom}:\\Users\\me\\note.md\n`, 'absolute local path'],
  ] as const) {
    const error = expectRejection(() => validateArtifact(withMarkdown(markdown)));
    assert.ok(
      error.issues.some((issue) => issue.includes(expected)),
      `missed hidden ${expected} in ${JSON.stringify(markdown)}`,
    );
  }
});

test('a deeply nested value fails validation instead of crashing the build', () => {
  let nested: unknown = 'leaf';
  for (let depth = 0; depth < 20000; depth += 1) nested = [nested];

  const error = expectRejection(() =>
    validateArtifact({
      version: 1,
      entries: [
        {
          slug: 'probe-note',
          title: 'Probe',
          excerpt: '',
          markdown: '# Probe\n',
          outgoing: [],
          backlinks: [],
          tags: nested,
        },
      ],
    }),
  );
  assert.ok(error.issues.some((issue) => issue.includes('.tags')));
});

test('a very wide array fails validation instead of crashing the build', () => {
  // Pushing a large array onto the traversal stack must not hit the spread
  // argument limit, which would surface as a RangeError rather than a contract
  // error and would abort the build with a stack trace.
  const wide = Array.from({ length: 200_000 }, (_, index) => `tag-${index}`);

  const error = expectRejection(() =>
    validateArtifact({
      version: 1,
      entries: [
        {
          slug: 'probe-note',
          title: 'Probe',
          excerpt: '',
          markdown: '# Probe\n',
          outgoing: [],
          backlinks: [],
          tags: wide,
          collection: 'Not A Slug',
        },
      ],
    }),
  );
  assert.ok(error.issues.some((issue) => issue.includes('.collection')));
});

test('file:// is rejected even when whitespace splits it', () => {
  const colon = String.fromCharCode(58);
  for (const href of [`file${colon}//host/vault/note.md`, `file${colon}/\t/host/vault/note.md`]) {
    const error = expectRejection(() => validateArtifact(withMarkdown(`<a href="${href}">x</a>\n`)));
    assert.ok(error.issues.some((issue) => issue.includes('file:// URL')), `missed: ${href}`);
  }

  // Ordinary words ending in "file" must not trip the rule.
  for (const prose of ['See the profile: //TODO revisit\n', 'makefile: // comment\n']) {
    assert.doesNotThrow(() => validateArtifact(withMarkdown(prose)), `wrongly rejected: ${prose}`);
  }
});

test('markers are found in every field, not only markdown', () => {
  const artifact = {
    version: 1,
    entries: [
      {
        slug: 'probe-note',
        title: 'Probe',
        excerpt: '',
        markdown: '# Probe\n',
        outgoing: [],
        backlinks: [],
        tags: ['msw/internal'],
      },
    ],
  };
  const error = expectRejection(() => validateArtifact(artifact));
  assert.ok(error.issues.some((issue) => issue.includes('msw/')));
});

test('tags and aliases reject invisible format characters', () => {
  const bidiOverride = String.fromCharCode(0x202e);
  const tagged = (tag: string) => ({
    version: 1,
    entries: [
      {
        slug: 'probe-note',
        title: 'Probe',
        excerpt: '',
        markdown: '# Probe\n',
        outgoing: [],
        backlinks: [],
        tags: [tag],
      },
    ],
  });

  const error = expectRejection(() => validateArtifact(tagged(`safe${bidiOverride}tag`)));
  assert.ok(error.issues.some((issue) => issue.includes('must not contain "/" or a control character')));

  // U+200D joins emoji sequences into one glyph and must stay allowed.
  const zwj = String.fromCharCode(0x200d);
  assert.doesNotThrow(() => validateArtifact(tagged(`\u{1f468}${zwj}\u{1f4bb}`)));
  assert.doesNotThrow(() => validateArtifact(tagged('\u{1f1e8}\u{1f1f3}')));
});

test('sorted-array checking compares elements, not a joined string', () => {
  // `['a a', 'a']` joins to the same text as its sorted form, so a join-based
  // check would miss it.
  const error = expectRejection(() =>
    validateArtifact({
      version: 1,
      entries: [
        {
          slug: 'probe-note',
          title: 'Probe',
          excerpt: '',
          markdown: '# Probe\n',
          outgoing: ['b-note', 'a-note'],
          backlinks: [],
        },
      ],
    }),
  );
  assert.ok(error.issues.some((issue) => issue.includes('must be sorted in ascending order')));
});

test('non-object artifacts are rejected without throwing a TypeError', () => {
  for (const value of [null, undefined, 42, 'content', [], true]) {
    assert.throws(() => validateArtifact(value), ContentValidationError);
  }
});

// --- Field bounds -------------------------------------------------------------

/** One valid entry with `overrides` applied, for probing a single limit. */
function probe(overrides: Record<string, unknown>): unknown {
  return {
    version: 1,
    entries: [
      {
        slug: 'probe-note',
        title: 'Probe',
        excerpt: '',
        markdown: '# Probe\n',
        outgoing: [],
        backlinks: [],
        ...overrides,
      },
    ],
  };
}

test('every bounded string field states its limit and rejects one character over it', () => {
  // Derived from the exported limits rather than restated, so a limit that
  // changes cannot leave this test asserting a number nobody enforces, and a
  // newly bounded field is covered the moment it is added.
  for (const [field, max] of Object.entries(FIELD_LIMITS.strings)) {
    const error = expectRejection(() => validateArtifact(probe({ [field]: 'x'.repeat(max + 1) })));
    assert.ok(
      error.issues.some(
        (issue) => issue.includes(`.${field}:`) && issue.includes(String(max)) && issue.includes('limit'),
      ),
      `${field}: an over-length value was not rejected with its stated limit:\n${error.issues.join('\n')}`,
    );
  }
});

test('a string field exactly at its limit is accepted', () => {
  // A bound that rejects its own boundary is an off-by-one nobody notices until
  // it rejects real content. Only `language` is exempt: a 35-character run of
  // `x` is not a BCP 47 tag, so it fails a shape rule rather than the bound.
  // `slug` and `collection` admit a long run of `x`, so both are checked.
  for (const [field, max] of Object.entries(FIELD_LIMITS.strings)) {
    if (field === 'language') continue;
    assert.doesNotThrow(
      () => validateArtifact(probe({ [field]: 'x'.repeat(max) })),
      `${field}: a value of exactly ${max} characters was rejected`,
    );
  }
});

test('a runaway markdown body is a contract error, not a slow build', () => {
  const max = FIELD_LIMITS.strings['markdown']!;
  const error = expectRejection(() => validateArtifact(probe({ markdown: 'x'.repeat(3_000_000) })));
  assert.ok(
    error.issues.some((issue) => issue.includes('.markdown:') && issue.includes(String(max))),
    `a 3 MB body was accepted:\n${error.issues.join('\n')}`,
  );
});

test('a tag list long enough to bury the site in routes is rejected', () => {
  // Every tag is a public route, so an unbounded tag list is an unbounded page
  // count on a single note.
  const max = FIELD_LIMITS.arrays['tags']!.items;
  const error = expectRejection(() =>
    validateArtifact(probe({ tags: Array.from({ length: 5000 }, (_, index) => `tag-${index}`) })),
  );
  assert.ok(
    error.issues.some((issue) => issue.includes('.tags:') && issue.includes(String(max))),
    `5,000 tags were accepted:\n${error.issues.join('\n')}`,
  );
});

test('a corpus larger than the entry ceiling fails before the build runs', () => {
  // The bound is checked at validation time, which is the first thing the build
  // chain runs, so an oversized artifact never reaches `astro build`.
  const entry = (index: number) => ({
    slug: `note-${index}`,
    title: `Note ${index}`,
    excerpt: '',
    markdown: 'x',
    outgoing: [],
    backlinks: [],
  });

  const error = expectRejection(() =>
    validateArtifact({ version: 1, entries: Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => entry(i)) }),
  );
  assert.ok(
    error.issues.some((issue) => issue.includes('entries:') && issue.includes(String(MAX_ENTRIES))),
    `an oversized corpus was accepted:\n${error.issues.slice(0, 3).join('\n')}`,
  );

  // The bound must stay under Cloudflare Pages' ceiling of 2,000 static
  // redirect rules at the two-rules-per-entry shape TK-04 used, which is the
  // headroom `MAX_ENTRIES` was chosen for. `REDIRECT_RULES` is a hand-written
  // literal today (TK-12), so nothing derives rules from the corpus and the
  // ceiling is not currently binding — this is the assertion that has to keep
  // holding if a stranded URL ever makes them derived again.
  assert.ok(
    MAX_ENTRIES * 2 <= 2000,
    `${MAX_ENTRIES} entries would emit ${MAX_ENTRIES * 2} rules, over the host's 2,000 rule ceiling`,
  );

  // And it must not reject a corpus the site is expected to serve.
  assert.doesNotThrow(() =>
    validateArtifact({ version: 1, entries: Array.from({ length: MAX_ENTRIES }, (_, i) => entry(i)) }),
  );
});

test('every bounded array states its limit for both count and member length', () => {
  for (const [field, { items, itemChars }] of Object.entries(FIELD_LIMITS.arrays)) {
    const tooMany = Array.from({ length: items + 1 }, (_, index) => `member-${index}`);
    const error = expectRejection(() => validateArtifact(probe({ [field]: tooMany })));
    assert.ok(
      error.issues.some((issue) => issue.includes(`.${field}:`) && issue.includes(String(items))),
      `${field}: an over-long array was not rejected with its stated limit`,
    );

    // `outgoing` and `backlinks` bound only their count: each member must
    // already resolve to a published slug, so member length is bounded
    // transitively by the slug ceiling.
    if (itemChars === undefined) continue;
    const tooLong = expectRejection(() =>
      validateArtifact(probe({ [field]: ['x'.repeat(itemChars + 1)] })),
    );
    assert.ok(
      tooLong.issues.some((issue) => issue.includes(`.${field}[0]:`) && issue.includes(String(itemChars))),
      `${field}: an over-long member was not rejected with its stated limit`,
    );
  }
});

test('the shipped artifact and the fixture corpus are both inside every bound', () => {
  // A bound is wrong if the corpus it exists to admit exceeds it.
  for (const name of ['../src/data/content.json', './fixtures/valid-corpus.json']) {
    assert.doesNotThrow(
      () => validateArtifact(load(new URL(name, import.meta.url)), name),
      `${name} violates a field bound`,
    );
  }
});
