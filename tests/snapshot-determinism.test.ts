/**
 * Determinism of the public snapshot producer.
 *
 * `docs/goals/archive/0002-consistent-static-relationships.md` requires the completed
 * goal to show that two fresh builds and shuffled discovery under one toolchain
 * produce identical DB bytes, while changed public metadata changes the
 * projection and a body-only edit may leave it unchanged. `writeSnapshot` is
 * the producer under test: it sorts entries by slug, assigns explicit IDs in
 * that order, and stores no timestamps or counters, so the authored order
 * cannot reach the bytes.
 *
 * Every comparison runs against a base snapshot written in the same workspace,
 * and every mutation is asserted to have changed its clone before the bytes are
 * compared. A no-op mutation — the fixture drifting under the test — would
 * otherwise leave a green byte comparison that measured nothing.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { validateArtifact, type ContentArtifact, type ContentEntry } from '../src/lib/schema.ts';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';

const FIXTURE = new URL('./fixtures/valid-corpus.json', import.meta.url);

/** The repository fixture, validated the way a build validates its artifact. */
function artifact(): ContentArtifact {
  return validateArtifact(JSON.parse(readFileSync(FIXTURE, 'utf8')), 'tests/fixtures/valid-corpus.json');
}

/** A scratch directory removed when the callback returns, however it returns. */
function withWorkspace<T>(body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'anc-determinism-'));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The digest `writeSnapshot` returns, recomputed from the bytes on disk. */
function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One table's row count, read back from a finalized snapshot. */
function countRows(path: string, table: 'nodes' | 'edges' | 'tags' | 'node_tags'): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
      | { count: number }
      | undefined;
    assert.ok(row !== undefined, `COUNT(*) over ${table} returned no row`);
    return row.count;
  } finally {
    database.close();
  }
}

/**
 * Validate one artifact and write it beside the base snapshot.
 *
 * Validation is part of the control: a byte difference must come from accepted
 * public metadata, not from a corpus the real loader would refuse.
 */
function writeVariant(
  directory: string,
  name: string,
  content: ContentArtifact,
): { path: string; bytes: Buffer } {
  const validated = validateArtifact(content, `tests/snapshot-determinism.test.ts variant "${name}"`);
  const written = writeSnapshot(validated, join(directory, `${name}.sqlite`));
  const bytes = readFileSync(written.path);
  assert.equal(written.size, bytes.length, `the size returned for "${name}" does not match its bytes`);
  return { path: written.path, bytes };
}

/** The named fixture entry, with its presence asserted before any mutation. */
function entryOf(content: ContentArtifact, slug: string): ContentEntry {
  const entry = content.entries.find((candidate) => candidate.slug === slug);
  assert.ok(entry !== undefined, `fixture no longer carries "${slug}"`);
  return entry;
}

test('two fresh snapshot builds of one corpus are byte-identical', () => {
  const content = artifact();

  withWorkspace((directory) => {
    const first = writeSnapshot(content, join(directory, 'first.sqlite'));
    const second = writeSnapshot(content, join(directory, 'second.sqlite'));
    const firstBytes = readFileSync(first.path);
    const secondBytes = readFileSync(second.path);

    assert.deepEqual(firstBytes, secondBytes, 'two fresh builds of one corpus differ');
    assert.equal(first.digest, digestOf(firstBytes), 'the first digest does not hash the written bytes');
    assert.equal(second.digest, digestOf(secondBytes), 'the second digest does not hash the written bytes');
    assert.equal(first.digest, second.digest, 'two fresh builds returned different digests');

    // Non-vacuity: the byte comparison is only evidence about a projection if
    // the file it compared actually carries one.
    assert.equal(
      countRows(first.path, 'nodes'),
      content.entries.length,
      'the snapshot node count does not match the corpus',
    );
    assert.ok(
      countRows(first.path, 'edges') > 0,
      'the fixture projects no edges, so byte identity proves nothing about relations',
    );
  });
});

test('shuffled discovery produces identical bytes', () => {
  const content = artifact();

  // A different, deterministic discovery order: shortest slug first, ties in
  // reverse. Only the array order differs; every entry keeps every field.
  const shuffled = structuredClone(content);
  shuffled.entries.sort((a, b) => a.slug.length - b.slug.length || (a.slug < b.slug ? 1 : -1));
  assert.notDeepEqual(
    shuffled.entries.map((entry) => entry.slug),
    content.entries.map((entry) => entry.slug),
    'the shuffle left discovery order unchanged, so the comparison would be vacuous',
  );

  withWorkspace((directory) => {
    const base = writeVariant(directory, 'base', content);
    // The shuffled artifact is still the same corpus — `writeVariant` runs the
    // real validator over it — and the producer must reach the same bytes.
    const reordered = writeVariant(directory, 'shuffled', shuffled);
    assert.deepEqual(reordered.bytes, base.bytes, 'discovery order reached the snapshot bytes');
  });
});

test('changed public metadata changes the projection, and a body-only edit does not', () => {
  const content = artifact();

  withWorkspace((directory) => {
    const base = writeVariant(directory, 'base', content);

    // Title: a stored node column.
    const retitled = structuredClone(content);
    const titleEntry = entryOf(retitled, 'minimal-note');
    const originalTitle = titleEntry.title;
    titleEntry.title = `${originalTitle} (revised)`;
    assert.notEqual(titleEntry.title, originalTitle, 'the title mutation was a no-op');
    assert.notDeepEqual(
      writeVariant(directory, 'retitled', retitled).bytes,
      base.bytes,
      'a changed title left the snapshot bytes unchanged',
    );

    // Excerpt: the other stored prose column.
    const reexcerpted = structuredClone(content);
    const excerptEntry = entryOf(reexcerpted, 'minimal-note');
    const originalExcerpt = excerptEntry.excerpt;
    excerptEntry.excerpt = 'A different summary of the same note.';
    assert.notEqual(excerptEntry.excerpt, originalExcerpt, 'the excerpt mutation was a no-op');
    assert.notDeepEqual(
      writeVariant(directory, 'reexcerpted', reexcerpted).bytes,
      base.bytes,
      'a changed excerpt left the snapshot bytes unchanged',
    );

    // Language: `minimal-note` carries none, so the producer stores the
    // fallback; an explicit tag must change the stored row.
    const translated = structuredClone(content);
    const languageEntry = entryOf(translated, 'minimal-note');
    assert.equal(
      languageEntry.language,
      undefined,
      'minimal-note now declares a language, so this no longer exercises the fallback',
    );
    languageEntry.language = 'fr';
    assert.notDeepEqual(
      writeVariant(directory, 'translated', translated).bytes,
      base.bytes,
      'a changed language left the snapshot bytes unchanged',
    );

    // Aliases: the same set in a different order must still change the bytes,
    // because storage is ordinal and the authored sequence is the metadata.
    const realiased = structuredClone(content);
    const aliasEntry = entryOf(realiased, 'garden-index');
    const originalAliases = [...(aliasEntry.aliases ?? [])];
    assert.ok(originalAliases.length >= 2, 'garden-index no longer carries two aliases to reorder');
    aliasEntry.aliases = [...originalAliases].reverse();
    assert.deepEqual(
      [...aliasEntry.aliases].sort(),
      [...originalAliases].sort(),
      'the alias set changed, not just the order, so this is not an ordinal test',
    );
    assert.notDeepEqual(aliasEntry.aliases, originalAliases, 'the alias reorder was a no-op');
    assert.notDeepEqual(
      writeVariant(directory, 'realiased', realiased).bytes,
      base.bytes,
      'a reordered alias set left the snapshot bytes unchanged',
    );

    // Tag removal: one membership disappears; the label survives on the other
    // notes that carry it, so the tags table is unchanged.
    const detagged = structuredClone(content);
    const detaggedEntry = entryOf(detagged, 'table-heavy-comparison');
    const originalTags = [...(detaggedEntry.tags ?? [])];
    assert.ok(originalTags.length >= 2, 'table-heavy-comparison no longer carries two tags to remove one of');
    detaggedEntry.tags = originalTags.slice(0, -1);
    assert.notDeepEqual(detaggedEntry.tags, originalTags, 'the tag removal was a no-op');
    const detaggedSnapshot = writeVariant(directory, 'detagged', detagged);
    assert.notDeepEqual(
      detaggedSnapshot.bytes,
      base.bytes,
      'a removed tag left the snapshot bytes unchanged',
    );
    assert.equal(
      countRows(detaggedSnapshot.path, 'node_tags'),
      countRows(base.path, 'node_tags') - 1,
      'the removed membership is not exactly one node_tags row',
    );
    assert.equal(
      countRows(detaggedSnapshot.path, 'tags'),
      countRows(base.path, 'tags'),
      'removing one membership from a shared label changed the tags table',
    );

    // Tag addition: a brand-new label on an untagged entry adds both the tag
    // row and its membership.
    const tagged = structuredClone(content);
    const taggedEntry = entryOf(tagged, 'minimal-note');
    assert.equal(taggedEntry.tags, undefined, 'minimal-note no longer starts without tags');
    taggedEntry.tags = ['Determinism Probe'];
    const taggedSnapshot = writeVariant(directory, 'tagged', tagged);
    assert.notDeepEqual(taggedSnapshot.bytes, base.bytes, 'an added tag left the snapshot bytes unchanged');
    assert.equal(
      countRows(taggedSnapshot.path, 'tags'),
      countRows(base.path, 'tags') + 1,
      'the added label did not add one tags row',
    );
    assert.equal(
      countRows(taggedSnapshot.path, 'node_tags'),
      countRows(base.path, 'node_tags') + 1,
      'the added label did not add one node_tags row',
    );

    // Markdown never reaches the projection, so a body-only edit is invisible
    // to the bytes...
    const reworded = structuredClone(content);
    const bodyEntry = entryOf(reworded, 'deterministic-builds');
    const originalMarkdown = bodyEntry.markdown;
    bodyEntry.markdown = `${originalMarkdown}\nA sentence added outside every projected field.\n`;
    assert.notEqual(bodyEntry.markdown, originalMarkdown, 'the body edit was a no-op');
    assert.deepEqual(
      writeVariant(directory, 'reworded', reworded).bytes,
      base.bytes,
      'a body-only edit changed the snapshot bytes',
    );

    // ...and the control on the same entry: one stored field does change them,
    // so the identical result above is evidence about markdown, not about a
    // comparison that cannot see differences at all.
    const control = structuredClone(content);
    const controlEntry = entryOf(control, 'deterministic-builds');
    controlEntry.title = `${controlEntry.title} (revised)`;
    assert.notEqual(controlEntry.title, bodyEntry.title, 'the control title mutation was a no-op');
    assert.notDeepEqual(
      writeVariant(directory, 'control', control).bytes,
      base.bytes,
      'the control title change did not change the bytes, so the body-only result proves nothing',
    );
  });
});
