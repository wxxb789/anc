/**
 * Build-time hydration from the finalized snapshot.
 *
 * `snapshot-reader.ts` is the seam that decides whether the staged workspace is
 * this build's authority; `content.ts` is where that decision meets the entries.
 * These gates drive the real fixture through the real producer (`writeSnapshot`)
 * and then exercise the reader and the match predicate, with the negative
 * controls the failure mode needs: bytes that do not hash to their binding, a
 * binding beside no file, an added or removed node, and a changed edge set.
 *
 * The safe direction is the fallback, never a throw: a workspace that fails
 * either check describes some other corpus, and the artifact's producer-resolved
 * pairs are the only relationship data this process can prove belongs to the
 * content it is rendering.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { validateArtifact, type ContentArtifact, type ContentEntry } from '../src/lib/schema.ts';
import { tagFacets } from '../src/lib/routes.ts';
import { snapshotRoute } from '../src/lib/snapshot.ts';
import {
  hydrateEntriesWithSnapshot,
  loadSnapshotRelations,
  snapshotMatchesEntries,
} from '../src/lib/snapshot-reader.ts';
import { writeSnapshot } from '../scripts/write-snapshot.ts';

const FIXTURE = new URL('./fixtures/valid-corpus.json', import.meta.url);

/** The repository fixture, validated the way a build validates its artifact. */
function artifact(): ContentArtifact {
  return validateArtifact(JSON.parse(readFileSync(FIXTURE, 'utf8')), 'tests/fixtures/valid-corpus.json');
}

/** A scratch directory removed when the callback returns, however it returns. */
function withWorkspace<T>(body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'anc-hydration-'));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Stage a workspace the way `scripts/build-snapshot.ts` does: the finalized
 * file and the binding that names the digest of its bytes.
 */
function stage(directory: string, content: ContentArtifact): void {
  const written = writeSnapshot(content, join(directory, 'snapshot.sqlite'));
  writeFileSync(
    join(directory, 'binding.json'),
    `${JSON.stringify({ url: written.url, digest: written.digest }, null, 2)}\n`,
    'utf8',
  );
}

test('the reader returns the digest-bound edges and tag labels', () => {
  const content = artifact();
  // Authored tag order here is `Ops & SRE`, then `Node.js`; the reader's order
  // is canonical key order, so this also proves the tags came from SQLite and
  // not from the artifact's arrays.
  const note = content.entries.find((entry) => entry.slug === 'deterministic-builds')!;

  withWorkspace((directory) => {
    stage(directory, content);
    const relations = loadSnapshotRelations(directory);
    assert.ok(relations !== undefined, 'a staged, digest-bound snapshot did not load');

    assert.deepEqual(relations.outgoing.get(note.slug), ['content-contract']);
    assert.deepEqual(relations.backlinks.get(note.slug), [
      'backlink-invariant',
      'long-form-essay',
      'zh-gong-ju-lian',
    ]);

    // The projection is complete: one entry per node, each slug's labels in key
    // order, spelled exactly as `tagFacets` spells them.
    const expectedTags = new Map<string, string[]>(content.entries.map((entry) => [entry.slug, []]));
    for (const facet of tagFacets(content.entries)) {
      for (const member of facet.entries) expectedTags.get(member.slug)!.push(facet.label);
    }
    assert.equal(relations.tags.size, content.entries.length);
    for (const entry of content.entries) {
      assert.deepEqual(
        relations.tags.get(entry.slug),
        expectedTags.get(entry.slug),
        `tags for ${entry.slug} do not match the fixture projection`,
      );
    }
  });
});

test('a workspace whose bytes do not hash to its binding is refused', () => {
  withWorkspace((directory) => {
    stage(directory, artifact());
    // The binding is written only after the producer hashed the finalized file,
    // so a file rewritten since — an interrupted build, a stale workspace — is
    // not this build's authority even though the binding is present.
    appendFileSync(join(directory, 'snapshot.sqlite'), 'x');
    assert.equal(loadSnapshotRelations(directory), undefined);
  });

  withWorkspace((directory) => {
    stage(directory, artifact());
    // A binding naming a digest no file in the workspace carries: the previous
    // build's database beside a fresh binding.
    const digest = 'f'.repeat(64);
    writeFileSync(
      join(directory, 'binding.json'),
      `${JSON.stringify({ url: snapshotRoute(digest), digest })}\n`,
      'utf8',
    );
    assert.equal(loadSnapshotRelations(directory), undefined);
  });
});

test('an absent or unreadable workspace falls back instead of throwing', () => {
  withWorkspace((directory) => {
    assert.equal(loadSnapshotRelations(directory), undefined);
  });
  withWorkspace((directory) => {
    // The file without its binding: nothing names these bytes as this build's,
    // so their mere presence is not authority.
    writeSnapshot(artifact(), join(directory, 'snapshot.sqlite'));
    assert.equal(loadSnapshotRelations(directory), undefined);
  });
  withWorkspace((directory) => {
    const digest = 'a'.repeat(64);
    writeFileSync(
      join(directory, 'binding.json'),
      `${JSON.stringify({ url: snapshotRoute(digest), digest })}\n`,
      'utf8',
    );
    assert.equal(loadSnapshotRelations(directory), undefined);
  });
});

test('the match check refuses a snapshot from a different corpus', () => {
  const content = artifact();
  withWorkspace((directory) => {
    stage(directory, content);
    const snapshot = loadSnapshotRelations(directory);
    assert.ok(snapshot !== undefined);

    assert.equal(
      snapshotMatchesEntries(content.entries, snapshot),
      true,
      'the snapshot does not match the artifact it was built from',
    );

    // A node missing on the entries' side: the artifact has dropped a note.
    const fewer = content.entries.filter((entry) => entry.slug !== 'garden-index');
    assert.equal(snapshotMatchesEntries(fewer, snapshot), false, 'a missing node did not refuse the snapshot');

    // A node missing on the snapshot's side: the artifact has gained one.
    const added: ContentEntry = {
      slug: 'later-note',
      title: 'Later note',
      excerpt: '',
      markdown: '',
      outgoing: [],
      backlinks: [],
    };
    assert.equal(
      snapshotMatchesEntries([...content.entries, added], snapshot),
      false,
      'an added node did not refuse the snapshot',
    );

    // Same nodes, one changed link: a defective or stale projection is refused.
    const edited = structuredClone(content.entries);
    edited.find((entry) => entry.slug === 'deterministic-builds')!.outgoing = ['alias-heavy'];
    assert.equal(snapshotMatchesEntries(edited, snapshot), false, 'a changed edge did not refuse the snapshot');

    // The packaged handoff: a stripped artifact's empty arrays are not a claim
    // that the corpus has no links, so the edge comparison is skipped and the
    // snapshot supplies the edges.
    const stripped = content.entries.map((entry) => ({ ...entry, outgoing: [], backlinks: [] }));
    assert.equal(
      snapshotMatchesEntries(stripped, snapshot),
      true,
      'the stripped packaged artifact was refused the snapshot it was built with',
    );
  });
});

test('hydration replaces edges and tags, and clears a slug the snapshot lacks', () => {
  const content = artifact();
  withWorkspace((directory) => {
    stage(directory, content);
    const snapshot = loadSnapshotRelations(directory);
    assert.ok(snapshot !== undefined);

    const hydrated = structuredClone(content.entries);
    const absent: ContentEntry = {
      slug: 'not-in-the-snapshot',
      title: 'Absent',
      excerpt: '',
      markdown: '',
      outgoing: ['content-contract'],
      backlinks: ['alias-heavy'],
      tags: ['Field Notes'],
    };
    hydrated.push(absent);
    hydrateEntriesWithSnapshot(hydrated, snapshot);

    const note = hydrated.find((entry) => entry.slug === 'deterministic-builds')!;
    assert.deepEqual(note.outgoing, ['content-contract']);
    assert.deepEqual(note.backlinks, ['backlink-invariant', 'long-form-essay', 'zh-gong-ju-lian']);
    assert.deepEqual(note.tags, ['Node.js', 'Ops & SRE']);

    assert.deepEqual(absent.outgoing, [], 'a slug the snapshot does not carry kept its IR edges');
    assert.deepEqual(absent.backlinks, []);
    assert.deepEqual(absent.tags, [], 'a slug the snapshot does not carry kept its IR tags');
  });
});

test('tagFacets over hydrated entries is the snapshot projection', () => {
  const content = artifact();
  withWorkspace((directory) => {
    stage(directory, content);
    const snapshot = loadSnapshotRelations(directory);
    assert.ok(snapshot !== undefined);

    const hydrated = structuredClone(content.entries);
    hydrateEntriesWithSnapshot(hydrated, snapshot);

    const project = (entries: readonly ContentEntry[]) =>
      tagFacets(entries).map((facet) => ({
        key: facet.key,
        label: facet.label,
        members: facet.entries.map((member) => member.slug),
      }));
    assert.deepEqual(project(hydrated), project(content.entries));

    // The label survives: the route key is `field-notes` while the page renders
    // the author's `Field Notes`, exactly what the browser's `tags.label` row
    // shows. Hydrating keys instead would put the two surfaces back in
    // disagreement.
    const fieldNotes = project(hydrated).find((facet) => facet.key === 'field-notes');
    assert.ok(fieldNotes !== undefined, 'the fixture no longer carries a field-notes tag');
    assert.equal(fieldNotes.label, 'Field Notes');
  });
});

const CONTENT_URL = new URL('../src/lib/content.ts', import.meta.url).href;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface ObservedEntry {
  outgoing: string[];
  backlinks: string[];
  tags: string[] | null;
}

/**
 * Read selected entries through `content.ts` in a child process.
 *
 * `content.ts` hydrates at module scope, so one process sees one decision, and
 * the artifact/workspace environment must be set before the import — which is
 * why this is a child rather than an in-process import. Same mechanism as
 * `tests/snapshot-workspace.test.ts`'s config/reader probe.
 */
function observeEntries(
  artifactPath: string,
  workspace: string,
  slugs: readonly string[],
): Record<string, ObservedEntry | null> {
  const script = `import(${JSON.stringify(CONTENT_URL)}).then((content) => {
  const slugs = ${JSON.stringify(slugs)};
  console.log(JSON.stringify(Object.fromEntries(slugs.map((slug) => {
    const entry = content.getEntry(slug);
    return [slug, entry === undefined ? null : {
      outgoing: entry.outgoing,
      backlinks: entry.backlinks,
      tags: entry.tags ?? null,
    }];
  }))));
});`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CONTENT_ARTIFACT: artifactPath, SNAPSHOT_WORKSPACE: workspace },
  });
  assert.equal(child.status, 0, `reading content.ts failed:\n${child.stderr}`);
  const line = child.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Record<string, ObservedEntry | null>;
}

test('content.ts hydrates only when the staged snapshot matches the artifact', () => {
  const content = artifact();
  withWorkspace((staged) => {
    stage(staged, content);
    const observed = observeEntries('tests/fixtures/valid-corpus.json', staged, ['deterministic-builds']);
    // The snapshot's key order is visible in the tags, so this value can only
    // be the hydrated one.
    assert.deepEqual(
      observed['deterministic-builds']?.tags,
      ['Node.js', 'Ops & SRE'],
      'a matching snapshot did not hydrate the entry',
    );
  });

  withWorkspace((staged) => {
    // A valid, digest-bound snapshot of the same nodes with one changed edge:
    // current in the bytes sense, stale in the corpus sense — the window a dev
    // server can actually open.
    const edited = structuredClone(content);
    edited.entries.find((entry) => entry.slug === 'deterministic-builds')!.outgoing = ['alias-heavy'];
    stage(staged, edited);
    const observed = observeEntries('tests/fixtures/valid-corpus.json', staged, ['deterministic-builds']);
    assert.deepEqual(
      observed['deterministic-builds']?.outgoing,
      ['content-contract'],
      'a snapshot for a different corpus replaced the artifact edges',
    );
    assert.deepEqual(
      observed['deterministic-builds']?.tags,
      ['Ops & SRE', 'Node.js'],
      'tags came from a snapshot that does not match the artifact',
    );
  });
});
