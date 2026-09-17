/**
 * G7: removing one source note removes every public projection on the next build.
 *
 * Both halves are load-bearing. The first build proves the deleted note and its
 * search token really reached every surface; the second proves they leave while
 * an unrelated retained note remains. Without the retained controls, a broken
 * empty build and a broken empty search index would look green.
 *
 * The fixture carries edges, tags, and an alias as well, because "the note is
 * gone" is not the same claim as "nothing that referenced it is still there":
 * the deleted note's incident edges and the tag only it used are rows of their
 * own, and a rebuild that dropped the node while keeping either would satisfy
 * every assertion the two-note fixture could make.
 *
 * The rebuild is also the combination goal 0006's "Withdrawal" row names, so it
 * carries two claims a single-build gate cannot make. The old digest-named
 * snapshot must be gone from `data/` — exactly one snapshot, named differently —
 * because an output directory that was not replaced wholesale would leave the
 * old database, and the deleted note's rows inside it, beside the new one. And a
 * note withheld by `publish: false`, linked from the surviving hub, must still
 * reach no reader surface: its body token is asserted absent from the raw bytes
 * of every published file, from every gzip member inflated, and from the
 * reconstructed snapshot text. The 2026-08-17 rule keeps the authored link
 * *label* by design, and `tests/backlink-surfaces.test.ts` owns that
 * label/anchor surface on a single build; this gate asserts the other half — the
 * target's own body — after the rebuild.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { isGzip } from '../scripts/snapshot-rows.ts';
import { snapshotEdges, snapshotMembers, snapshotSlugs, snapshotTags, snapshotText } from './support/snapshot.ts';

const CLI = fileURLToPath(new URL('../bin/anc.mjs', import.meta.url));

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

/**
 * One gzip member's inflated text, or a failed assertion.
 *
 * `tests/backlink-surfaces.test.ts` owns the same inflate-or-fail rule on a
 * single build: a gzip member scanned as undeflated bytes reports clean on
 * content the scan never looked at, so "could not inflate" must fail rather
 * than fall back to the raw bytes it could not read into.
 */
function inflated(file: string, bytes: Buffer, dist: string): string {
  try {
    return gunzipSync(bytes).toString('utf8');
  } catch (error) {
    return assert.fail(
      `${file.slice(dist.length + 1)} is gzipped and could not be inflated, so this gate ` +
        `cannot see whether withheld content is inside it: ${String(error)}`,
    );
  }
}

function build(root: string): void {
  const result = spawnSync(process.execPath, [CLI, 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.equal(result.status, 0, 'foreign build failed:\n' + result.stdout + '\n' + result.stderr);
}

function searchText(dist: string): string {
  const fragments = filesUnder(join(dist, 'pagefind')).filter((file) => file.endsWith('.pf_fragment'));
  assert.ok(fragments.length > 0, 'Pagefind wrote no fragment, so search deletion would be vacuous');
  return fragments.map((file) => gunzipSync(readFileSync(file)).toString('utf8')).join('\n');
}

function assertSurface(text: string, token: string, present: boolean, surface: string): void {
  assert.equal(text.includes(token), present, surface + (present ? ' lost ' : ' retained ') + token);
}

function projectionPattern(surface: 'feed' | 'sitemap', slug: string): RegExp {
  if (surface === 'feed') {
    return new RegExp('<link rel="alternate" type="text/html" href="[^"]*/notes/' + slug + '/"/>');
  }
  return new RegExp('<loc>[^<]*/notes/' + slug + '/</loc>');
}

function assertProjection(text: string, slug: string, present: boolean, surface: 'feed' | 'sitemap'): void {
  assert.equal(
    projectionPattern(surface, slug).test(text),
    present,
    surface + (present ? ' lost entry for ' : ' retained entry for ') + slug,
  );
}

test('deleting a note removes its route, feed, sitemap, snapshot, search record, edges, and unused metadata, and the rebuild leaves no old snapshot or withheld body', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-deletion-'));
  const dist = join(root, 'dist');
  const deleted = join(root, 'deleted-nebula.md');
  const retained = join(root, 'retained-asterism.md');
  const hub = join(root, 'hub.md');
  // A note withheld by `publish: false`, linked from the surviving hub so the
  // rebuild has to make the accepted withheld-link decision rather than never
  // meeting a withheld target. Nothing here asserts its label — the 2026-08-17
  // rule keeps the authored label by design and `tests/backlink-surfaces.test.ts`
  // owns that surface; what this fixture exists for is the body token below,
  // which must reach no surface at all.
  const withheld = join(root, 'withheld-note.md');
  const deletedToken = 'zzqdeletednebula';
  const retainedToken = 'zzqretainedasterism';
  const withheldToken = 'zzqwithhelduniquebody';
  // The tag only the deleted note carries, so its row has no surviving member
  // and must be gone from the rebuilt snapshot rather than left empty.
  const deletedOnlyTag = 'deleted-only-tag';
  // Carried by all three notes before the deletion and by both retained notes
  // after, so a build that dropped every tag row fails as loudly here as one
  // that kept the unused row.
  const sharedTag = 'shared-retained-tag';
  // The dropped note's alias, which reaches the snapshot's `aliases` table and
  // therefore `snapshotText`; nothing retained carries its text.
  const deletedAlias = 'Nebula Alias';
  try {
    const git = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    // The deleted note points at the retained hub, the retained note points at
    // both hub and the note that will be deleted, and the hub points back at the
    // retained note and at the withheld note. The withheld link is not an edge —
    // a withheld target contributes none — so after the deletion only
    // retained-asterism -> hub (and hub -> retained-asterism) may remain.
    writeFileSync(
      deleted,
      '---\ntags:\n  - ' + deletedOnlyTag + '\n  - ' + sharedTag +
        '\naliases:\n  - ' + deletedAlias +
        '\n---\n\n# Deleted Nebula\n\n' + deletedToken + ' [[hub]]\n',
      'utf8',
    );
    writeFileSync(
      retained,
      '---\ntags:\n  - ' + sharedTag + '\n---\n\n# Retained Asterism\n\n' +
        retainedToken + ' [[hub]] and [[deleted-nebula]]\n',
      'utf8',
    );
    writeFileSync(hub, '---\ntags:\n  - ' + sharedTag + '\n---\n\n# Hub\n\n[[retained-asterism]] and [[withheld-note]]\n', 'utf8');
    writeFileSync(
      withheld,
      '---\npublish: false\n---\n\n# Withheld Relic\n\n' + withheldToken + ' prose that no reader may see.\n',
      'utf8',
    );

    // The withheld note and the link to it are in the corpus on disk, so the
    // build had to decide about both rather than never meeting them. Without
    // this the absence checks below pass on a fixture that never contained the
    // token, which is the "empty output is not green" case from
    // `docs/gate-reading.md`.
    assert.ok(
      readFileSync(withheld, 'utf8').includes(withheldToken),
      'the withheld fixture never carries its body token, so the absence checks below prove nothing',
    );
    assert.ok(
      readFileSync(hub, 'utf8').includes('[[withheld-note]]'),
      'no note links the withheld file, so no withheld link was ever at risk',
    );

    build(root);
    assert.equal(existsSync(join(dist, 'notes', 'deleted-nebula', 'index.html')), true, 'first build never emitted the deleted route');
    assert.equal(existsSync(join(dist, 'notes', 'retained-asterism', 'index.html')), true, 'first build never emitted the retained control route');
    // The snapshot this build published, by exact digest-named basename. The
    // rebuild below must leave no copy of it anywhere in `dist/`: the build
    // replaces the output directory wholesale, and one that instead merged into
    // the existing output would leave this database beside the new one, still
    // carrying the deleted note's rows. Capturing the name here is what makes
    // "the old snapshot is gone" a statement about a specific file rather than
    // about the count.
    const firstSnapshots = snapshotMembers(dist);
    assert.equal(
      firstSnapshots.length,
      1,
      `the first build left ${firstSnapshots.length} digest-named snapshots in data/, expected exactly one`,
    );
    const oldSnapshot = firstSnapshots[0]!;
    const firstSlugs = snapshotSlugs(dist);
    assert.ok(firstSlugs.length > 0, 'first snapshot stores no nodes, so its absence checks would be vacuous');
    assertSurface(firstSlugs.join('\n'), 'deleted-nebula', true, 'first snapshot');
    assertSurface(firstSlugs.join('\n'), 'retained-asterism', true, 'first snapshot');
    const firstText = snapshotText(dist);
    assertSurface(firstText, deletedToken, true, 'first snapshot');
    assertSurface(firstText, retainedToken, true, 'first snapshot');
    assertSurface(firstText, deletedAlias, true, 'first snapshot');
    // Edges by content, not count: the two incident pairs and the control pair
    // must each be exactly the pair they are named, because two wrong edges of
    // the right cardinality pass a length check.
    const firstEdges = snapshotEdges(dist);
    assert.ok(
      firstEdges.some(([source, target]) => source === 'deleted-nebula' && target === 'hub'),
      "first snapshot lost the deleted note's outgoing edge: " + JSON.stringify(firstEdges),
    );
    assert.ok(
      firstEdges.some(([source, target]) => source === 'retained-asterism' && target === 'deleted-nebula'),
      'first snapshot lost the retained edge into the note that will be deleted: ' + JSON.stringify(firstEdges),
    );
    assert.ok(
      firstEdges.some(([source, target]) => source === 'retained-asterism' && target === 'hub'),
      'first snapshot lost the control edge between the two retained notes: ' + JSON.stringify(firstEdges),
    );
    // The deleted-only tag is its own facet with the deleted note as its only
    // member, and the shared tag keeps all three members — asserted as contents
    // so a facet that exists but lists the wrong notes fails here.
    const firstTags = snapshotTags(dist);
    assert.deepEqual(
      firstTags.find((tag) => tag.key === deletedOnlyTag),
      { key: deletedOnlyTag, label: deletedOnlyTag, members: ['deleted-nebula'] },
      'first snapshot does not carry the deleted-only tag as a single-member facet',
    );
    assert.deepEqual(
      firstTags.find((tag) => tag.key === sharedTag)?.members,
      ['deleted-nebula', 'hub', 'retained-asterism'],
      'first snapshot does not carry the shared tag with all three members',
    );
    for (const [surface, file] of [
      ['feed', 'rss.xml'],
      ['sitemap', 'sitemap.xml'],
    ] as const) {
      const text = readFileSync(join(dist, file), 'utf8');
      assertProjection(text, 'deleted-nebula', true, surface);
      assertProjection(text, 'retained-asterism', true, surface);
    }
    const firstSearch = searchText(dist);
    assertSurface(firstSearch, deletedToken, true, 'first search index');
    assertSurface(firstSearch, retainedToken, true, 'first search index');

    // Mutation watched fail: replacing this removal with a no-op leaves the
    // route present and fails below with "deleted route survived the rebuild".
    rmSync(deleted);
    build(root);
    assert.equal(existsSync(join(dist, 'notes', 'deleted-nebula', 'index.html')), false, 'deleted route survived the rebuild');
    assert.equal(existsSync(join(dist, 'notes', 'retained-asterism', 'index.html')), true, 'retained control route vanished');
    const secondSlugs = snapshotSlugs(dist);
    assert.ok(secondSlugs.length > 0, 'rebuilt snapshot stores no nodes, so its absence checks would be vacuous');
    assertSurface(secondSlugs.join('\n'), 'deleted-nebula', false, 'rebuilt snapshot');
    assertSurface(secondSlugs.join('\n'), 'retained-asterism', true, 'rebuilt snapshot');
    const secondText = snapshotText(dist);
    assertSurface(secondText, deletedToken, false, 'rebuilt snapshot');
    assertSurface(secondText, retainedToken, true, 'rebuilt snapshot');
    assertSurface(secondText, deletedAlias, false, 'rebuilt snapshot');
    assertSurface(secondText, deletedOnlyTag, false, 'rebuilt snapshot');
    // No incident edge at all remains, and the control edge between the two
    // retained notes is still exact. The absence is by content on both ends, so
    // an edge from or to any other node cannot mask one incident to the deleted
    // note.
    const secondEdges = snapshotEdges(dist);
    assert.ok(
      !secondEdges.some(([source, target]) => source === 'deleted-nebula' || target === 'deleted-nebula'),
      'an edge incident to the deleted note survived the rebuild: ' + JSON.stringify(secondEdges),
    );
    assert.ok(
      secondEdges.some(([source, target]) => source === 'retained-asterism' && target === 'hub'),
      'the control edge between the two retained notes vanished: ' + JSON.stringify(secondEdges),
    );
    // The unused tag row is eliminated rather than left memberless, and the
    // shared tag keeps exactly its retained members.
    const secondTags = snapshotTags(dist);
    assert.equal(
      secondTags.some((tag) => tag.key === deletedOnlyTag),
      false,
      'the tag only the deleted note used survived the rebuild: ' + JSON.stringify(secondTags),
    );
    assert.deepEqual(
      secondTags.find((tag) => tag.key === sharedTag)?.members,
      ['hub', 'retained-asterism'],
      'the shared tag did not keep exactly its retained members: ' + JSON.stringify(secondTags),
    );
    for (const [surface, file] of [
      ['feed', 'rss.xml'],
      ['sitemap', 'sitemap.xml'],
    ] as const) {
      const text = readFileSync(join(dist, file), 'utf8');
      assertProjection(text, 'deleted-nebula', false, surface);
      assertProjection(text, 'retained-asterism', true, surface);
    }
    const secondSearch = searchText(dist);
    assertSurface(secondSearch, deletedToken, false, 'rebuilt search index');
    assertSurface(secondSearch, retainedToken, true, 'rebuilt search index');

    // --- Goal 0006 "Withdrawal": the rebuild-after-removal combination -------
    //
    // Everything above is a claim about one projection of the rebuilt artifact.
    // What this section adds is the combination the withdrawal row names: the
    // surfaces below were produced by a *fresh rebuild after a removal*, not by
    // a single build, and two claims live only in that combination.
    //
    // First, the old snapshot must be gone. An output directory that was not
    // replaced wholesale would keep the previous digest-named database beside
    // the new one; that file still carries the deleted note's rows, so "one
    // snapshot, named differently" is the property, not a count of pages.
    //
    // Second, the withheld note linked from the surviving hub must still reach
    // no reader surface. The 2026-08-17 rule keeps the authored link *label* by
    // design and `tests/backlink-surfaces.test.ts` owns that label/anchor
    // surface on a single build; this gate asserts the half a rebuild could
    // regress differently — the target's own body — across raw bytes, gzip
    // members inflated, and the reconstructed snapshot text.
    const rebuiltSnapshots = snapshotMembers(dist);
    assert.equal(
      rebuiltSnapshots.length,
      1,
      `the rebuild left ${rebuiltSnapshots.length} digest-named snapshots in data/, expected exactly one`,
    );
    assert.notEqual(
      rebuiltSnapshots[0],
      oldSnapshot,
      'the rebuild reused the old snapshot file name, so its bytes did not change with the corpus',
    );
    assert.equal(
      existsSync(join(dist, 'data', oldSnapshot)),
      false,
      `the old digest-named snapshot survived the rebuild at data/${oldSnapshot}`,
    );

    // Every file the rebuild published, read once, so the raw and inflated
    // checks below all describe the same bytes.
    const published = filesUnder(dist).map((file) => {
      const bytes = readFileSync(file);
      return { name: file.slice(dist.length + 1), file, bytes, gzipped: isGzip(bytes) };
    });
    assert.ok(published.length > 0, 'the rebuilt output is empty, so the absence checks below are vacuous');

    // Surface one: the raw bytes of every published file. This is the scan that
    // sees an uncompressed page or a database page without decoding it.
    const rawLeaks = published.filter((entry) => entry.bytes.includes(withheldToken));
    assert.deepEqual(
      rawLeaks.map((entry) => entry.name),
      [],
      'the withheld body token is in the raw bytes of the rebuilt output',
    );
    // Positive control: a published note's own token really is in those bytes,
    // so the filter above is reading the artifact rather than comparing nothing.
    assert.ok(
      published.some((entry) => entry.bytes.includes(retainedToken)),
      "no raw file carries a published note's token, so the raw scan is not reading the artifact",
    );

    // Surface two: every gzip member, inflated or failed. Inflating rather than
    // skipping is what reaches the Pagefind index; `inflated` fails on a member
    // it cannot open, so "could not look" fails instead of reading as clean.
    const gzipped = published.filter((entry) => entry.gzipped);
    assert.ok(
      gzipped.length > 0,
      'no rebuilt file is gzipped, so the inflate half never ran and this is a plain text scan ' +
        'claiming to be more',
    );
    const inflatedEntries = gzipped.map((entry) => ({
      ...entry,
      text: inflated(entry.file, entry.bytes, dist),
    }));
    const inflatedLeaks = inflatedEntries.filter((entry) => entry.text.includes(withheldToken));
    assert.deepEqual(
      inflatedLeaks.map((entry) => entry.name),
      [],
      'the withheld body token is inside a gzip member of the rebuilt output',
    );
    assert.ok(
      inflatedEntries.some((entry) => entry.text.includes(retainedToken)),
      "no inflated gzip member carries a published note's token, so the inflate half is not " +
        'reaching the search index',
    );

    // Surface three: the reconstructed snapshot text, which decodes every stored
    // value in `nodes`, `aliases`, and `tags`. `secondText` is
    // `snapshotText(dist)` over the rebuilt database, and the published control
    // token asserted present in it above keeps this absence non-vacuous.
    assertSurface(secondText, withheldToken, false, 'rebuilt snapshot');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 240_000);
