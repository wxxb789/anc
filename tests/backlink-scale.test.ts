/**
 * A hub with 501 incoming links stays complete on its static page and in the
 * emitted SQLite projection.
 *
 * `src/lib/schema.ts` deleted the serialized-array ceiling of 500 backlinks:
 * the SQLite projection is the relationship authority, a graph drawing bound
 * must never reject a DB fact, and a hub with thousands of backlinks must stay
 * fully reachable. Goal 0002's "Static behavior" row states the same property
 * as a pass condition. This gate is the one that goes red if a count ceiling
 * returns — to the artifact pipeline, to the snapshot, or to the renderer.
 *
 * **501, not "more than 500".** The deleted ceiling refused the 501st member,
 * so one edge past it is the boundary that code could not cross, and every
 * number below is asserted equal rather than bounded below.
 *
 * **The corpus is built by the shipped binary in a scratch git repository**,
 * and the 501 peer files are counted on disk before the build, so a corpus
 * that failed to write and a page that failed to render cannot both look
 * green. The CLI is the same command the adoption path runs.
 *
 * The local graph on this page is bounded to `LOCAL_NODE_LIMIT` neighbours, so
 * the complete-list assertion is scoped to the backlinks `<aside>`; the graph
 * section is checked separately to prove it is a bounded *drawing* rather than
 * the only place the edges reached.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { LOCAL_NODE_LIMIT } from '../src/lib/graph.ts';
import { noteRoute } from '../src/lib/routes.ts';
import { translate } from '../src/lib/translations.ts';
import { openSnapshot, snapshotEdges, snapshotNotes } from './support/snapshot.ts';

const CLI = fileURLToPath(new URL('../bin/anc.mjs', import.meta.url));

/** One more edge than the 500-member serialized-array ceiling the old code kept. */
const PEER_COUNT = 501;

/** `peer-000` … `peer-500`, the exact slugs the artifact must publish. */
const PEER_SLUGS = Array.from({ length: PEER_COUNT }, (_, index) => `peer-${String(index).padStart(3, '0')}`);

/** Membership for the per-edge lookups below; the array itself stays ordered. */
const PEER_SLUG_SET = new Set(PEER_SLUGS);

/** The title written into `peer-<n>.md`, distinct per file. */
function peerTitle(index: number): string {
  return `Peer ${String(index).padStart(3, '0')}`;
}

/**
 * The backlinks section only, by the region it labels.
 *
 * The three relationship regions are one component rendered three times
 * (`src/components/LinkedNotes.astro`) and share a class, so `aria-labelledby`
 * is what tells them apart — the same locator `tests/built-routes.test.ts` and
 * `tests/backlink-surfaces.test.ts` use. The `<aside>` contains no nested
 * `</aside>`, so the first close is its own.
 */
function backlinksSection(html: string): string {
  const found = /<aside class="relations" aria-labelledby="backlinks-title">[\s\S]*?<\/aside>/.exec(html);
  assert.ok(found, 'the hub page has no backlinks relationship section');
  return found[0];
}

/** The note-graph region on the page, by the region it labels. */
function graphSection(html: string): string {
  const found = /<section class="graph-region"[^>]*aria-labelledby="note-graph-title"[^>]*>[\s\S]*?<\/section>/.exec(
    html,
  );
  assert.ok(found, 'the hub page has no note-graph region');
  return found[0];
}

/**
 * The language the built page declares, copied in shape from
 * `tests/built-routes.test.ts`: the chrome this gate reads is per-document, so
 * the expectation must be resolved from the page rather than pinned to English.
 */
function declaredLanguage(html: string): string {
  const lang = /<html lang="([^"]+)"/.exec(html)?.[1];
  assert.ok(lang !== undefined, 'the hub page declares no language at all');
  return lang;
}

/**
 * A label as it appears in built HTML.
 *
 * Copied in shape from `tests/built-routes.test.ts`. Today's sentences here
 * carry no character Astro escapes; comparing against the rendered form keeps
 * that from mattering if a translation ever adds one.
 */
function asRendered(label: string): string {
  return label.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** The hrefs a fragment of HTML carries, in document order. */
function hrefsIn(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href!);
}

test(
  'a hub with 501 backlinks is complete in the emitted DB and on its static page',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'backlink-scale-'));
    const dist = join(root, 'dist');
    try {
      const git = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
      assert.equal(git.status, 0, `git init failed: ${git.stderr}`);

      writeFileSync(join(root, 'hub.md'), '# Hub\n\nA note many others link to.\n', 'utf8');
      for (const [index, slug] of PEER_SLUGS.entries()) {
        writeFileSync(join(root, `${slug}.md`), `# ${peerTitle(index)}\n\n[[hub]]\n`, 'utf8');
      }

      // Non-vacuity before the build consumes anything: the directory really
      // holds 501 distinct peer files. A loop that wrote 500 files, or that
      // overwrote one name, would otherwise shrink the corpus silently and
      // every exact 501 below would be measuring the wrong premise.
      const peerFiles = readdirSync(root).filter((name) => /^peer-\d{3}\.md$/.test(name));
      assert.equal(
        peerFiles.length,
        PEER_COUNT,
        `the scratch corpus holds ${peerFiles.length} peer files, expected ${PEER_COUNT}`,
      );
      assert.equal(
        new Set(peerFiles).size,
        PEER_COUNT,
        'two peer files share a name, so one peer would not exist to be linked',
      );

      const started = Date.now();
      const build = spawnSync(process.execPath, [CLI, 'build'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 240_000,
      });
      const wallMs = Date.now() - started;
      assert.equal(
        build.status,
        0,
        `the ${PEER_COUNT + 1}-note build failed after ${wallMs} ms` +
          `${build.error ? ` (${build.error.message})` : ''}:\n` +
          `stdout: ${build.stdout || '(empty)'}\nstderr: ${build.stderr || '(empty)'}`,
      );
      // Read the build's own wall time out of the run rather than assuming it;
      // the reported number is what a reader can compare against the budget.
      console.log(`backlink-scale: ${PEER_COUNT + 1}-note build wall time ${wallMs} ms`);

      // --- The emitted DB -------------------------------------------------

      const notes = snapshotNotes(dist);
      assert.equal(
        notes.length,
        PEER_COUNT + 1,
        `the snapshot carries ${notes.length} notes, expected ${PEER_COUNT + 1} (hub plus every peer)`,
      );
      assert.deepEqual(
        notes.map((note) => note.slug).sort(),
        ['hub', ...PEER_SLUGS].sort(),
        'the snapshot note set is not the authored corpus',
      );

      const edges = snapshotEdges(dist);
      assert.equal(edges.length, PEER_COUNT, `the snapshot carries ${edges.length} edges, expected ${PEER_COUNT}`);
      for (const [source, target] of edges) {
        assert.equal(target, 'hub', `edge "${source}" -> "${target}" does not point at the hub`);
        assert.ok(PEER_SLUG_SET.has(source), `edge "${source}" -> "${target}" starts at a slug the corpus never wrote`);
      }
      // Set equality, not just the count: 501 edges with a duplicate source
      // and a missing peer would satisfy the count and fail a reader.
      assert.deepEqual(
        [...new Set(edges.map(([source]) => source))].sort(),
        [...PEER_SLUGS].sort(),
        'the 501 edges do not carry the 501 distinct peer slugs',
      );

      // The reverse-index query named by the SQLite contract, run against the
      // shipped file rather than re-derived from `snapshotEdges`: a list can be
      // complete while the query a reader's page resolves through is not.
      let reverseIndex = 0;
      const database = openSnapshot(dist);
      try {
        const row = database
          .prepare(
            "SELECT COUNT(*) AS count FROM edges WHERE target_id = (SELECT id FROM nodes WHERE slug = 'hub')",
          )
          .get() as { count: number };
        assert.equal(
          row.count,
          PEER_COUNT,
          `the backlink reverse-index query returned ${row.count} edges, expected ${PEER_COUNT}`,
        );
        reverseIndex = row.count;
      } finally {
        database.close();
      }

      // --- The static page ------------------------------------------------

      const hubHtml = readFileSync(join(dist, 'notes', 'hub', 'index.html'), 'utf8');
      const section = backlinksSection(hubHtml);
      const t = translate(declaredLanguage(hubHtml));

      // The visible count is the list's own count, not a "500+" summary: it
      // must read 501. The wording comes from the contract, so it is read
      // rather than restated here.
      assert.ok(
        section.includes(asRendered(t.noteCount(PEER_COUNT))),
        `the backlinks section does not state "${PEER_COUNT} notes" in this page's own language`,
      );

      // Exact hrefs, one per peer, no duplicates and no extras. `noteRoute` is
      // the route model rather than a string shape spelled here, so `peer-1`
      // cannot match the route of `peer-10` or `peer-100`.
      const expectedRoutes = new Set(PEER_SLUGS.map((slug) => noteRoute(slug)));
      const hrefs = hrefsIn(section);
      assert.equal(
        hrefs.length,
        PEER_COUNT,
        `the backlinks section carries ${hrefs.length} anchors, expected exactly ${PEER_COUNT}`,
      );
      const seen = new Map<string, number>();
      for (const href of hrefs) {
        assert.ok(
          expectedRoutes.has(href),
          `the backlinks section links "${href}", which is not one of the ${PEER_COUNT} peer routes`,
        );
        seen.set(href, (seen.get(href) ?? 0) + 1);
      }
      for (const slug of PEER_SLUGS) {
        const route = noteRoute(slug);
        assert.equal(
          seen.get(route),
          1,
          `peer "${slug}" is linked ${seen.get(route) ?? 0} times, expected exactly once`,
        );
      }

      // The graph section is a bounded *drawing*, not a second complete list:
      // it must link some of the same peers (or the aside could be some other
      // list), and at most `LOCAL_NODE_LIMIT` distinct ones. This is what makes
      // the 501-anchor assertion above a statement about the backlinks list
      // rather than "the page links every peer somewhere".
      const graph = graphSection(hubHtml);
      const graphPeers = new Set(hrefsIn(graph).filter((href) => expectedRoutes.has(href)));
      assert.ok(graphPeers.size > 0, 'the graph region links none of the peers, so its bound was never exercised');
      assert.ok(
        graphPeers.size <= LOCAL_NODE_LIMIT,
        `the graph draws ${graphPeers.size} distinct peers, over the ${LOCAL_NODE_LIMIT}-neighbour bound`,
      );

      // And it states its omission honestly: with 501 neighbours and a
      // 12-neighbour drawing the truncation sentence is rendered, and its
      // second sentence promises "the lists above name every one of them" —
      // which the 501-link assertion has just made true.
      const bounded = t.graphBoundedLocal(Math.min(PEER_COUNT, LOCAL_NODE_LIMIT), PEER_COUNT);
      assert.ok(
        graph.includes(asRendered(bounded)),
        `the graph drops ${PEER_COUNT - LOCAL_NODE_LIMIT} neighbours without stating it: expected "${bounded}"`,
      );

      // The observed numbers, so a passing run reports what it measured rather
      // than leaving a reader to infer counts from equality assertions.
      console.log(
        `backlink-scale: observed ${notes.length} notes, ${edges.length} edges, ` +
          `reverse-index ${reverseIndex}, backlinks anchors ${hrefs.length}, ` +
          `graph peer links ${graphPeers.size}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
  300_000,
);
