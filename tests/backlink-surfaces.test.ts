/**
 * What a *page* does with an edge, over a site the real binary built.
 *
 * TK-27 owns the derivation — five link forms, one traversal, one typed
 * outcome — and `tests/link-traversal.test.ts` gates that. This file starts
 * where the artifact stops: the anchors inside the article, the two edge
 * lists, the empty states, and every rendered surface a withheld note could
 * reach after the artifact was written.
 *
 * ## Why this builds its own corpus instead of reading `dist/`
 *
 * Plan §2.6 asks that the `/notes/<slug>/` hrefs inside `<article class="prose">`
 * equal `entry.outgoing` mapped through `routeForSlug`, and that the fixture
 * carry all five link forms. **Neither existing corpus can satisfy that**, and
 * the reasons are structural rather than a matter of adding a note:
 *
 * - `tests/fixtures/valid-corpus.json` is *post-resolution*. Its bodies already
 *   read `](/content-contract/)` and it contains no wikilink at any layer —
 *   measured, `markdown.includes('[[')` is false for all 32 entries. Four of the
 *   five forms cannot appear in it by construction.
 * - It also already violates the equality, in three entries and all in the same
 *   direction: `garden-index` carries nine `outgoing` slugs its body never
 *   links, plus one each on `backlink-invariant` and `markdown-pipeline`. A
 *   gate asserting equality over it is red on arrival, and *editing the fixture
 *   to make it green* is how every other suite that reads it acquires a silent
 *   dependency on this ticket's edit.
 * - The published `src/data/content.json` is one note with zero internal links,
 *   so the gate is vacuously green there.
 *
 * So the corpus is written here, in Markdown, and the **real binary** builds it
 * — the same path a user takes. That is also the only way to reach the surfaces
 * increment 3 is about: `excerpt` becoming `<meta name="description">`, the
 * Pagefind index, the snapshot, and the graph SVG's labels exist only
 * after a full build, and a producer-level assertion cannot see any of them.
 *
 * Each build is 15-20 s here, so each gate carries an explicit timeout with
 * that as its reason. The scratch build never touches this repository's own
 * `dist/`: `--out` names a directory inside the scratch root.
 *
 * ## The corpus is written in natural document order
 *
 * It did not used to be, and the reason is worth keeping. `entry.outgoing` was
 * emitted in document order while `checkCorpus` requires it sorted, so a note
 * whose first link named a later-sorting slug **failed the build** — measured on
 * the shipped binary, `See [[zebra]] and [[apple]].` exited 1 while the same two
 * links swapped exited 0. This fixture was ordered by target slug to build at
 * all, which is the opposite of what a hostile corpus should be.
 *
 * `scripts/markdown-to-artifact.ts` now sorts, so the links below are written in
 * the order a person introduces them and the ordering contract is asserted
 * where it belongs — `tests/link-traversal.test.ts`, over a corpus whose
 * document order deliberately opposes its slug order.
 */

import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { WITHHELD_ROUTE, noteRoute } from '../src/lib/routes.ts';
import { translate } from '../src/lib/translations.ts';
import { snapshotSlugs } from './support/snapshot.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'anc.mjs');

/**
 * A full CLI build is 15-20 s on this host — the astro build dominates, and
 * Pagefind and the residue scan follow it. Vitest's file default is 30 s, which
 * a gate that builds *and* asserts can exceed on a cold process.
 */
const BUILD_TIMEOUT = 180_000;

/** A scratch directory removed when the callback returns, however it returns. */
function scratch<T>(prefix: string, body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** Write a file, creating the directories above it. */
function put(root: string, relativePath: string, body: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

/** Every file under a directory, descending into dotted directories too. */
function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

/**
 * The token this fixture's withheld note is named and written with.
 *
 * One string per disclosing part, each distinctive enough that a hit is
 * attributable: an English word would match the fixture's own prose and the
 * assertion would be measuring a coincidence.
 */
const WITHHELD_DIRECTORY = 'zzqclients';
const WITHHELD_SUBDIRECTORY = 'zzqacme';

/**
 * The accented segment of the NFD fixture note, in both normalisations.
 *
 * Written as escapes rather than as literal characters, deliberately: the two
 * forms are visually identical in every editor, so a literal pair is one
 * well-meaning "fix my encoding" save away from becoming the same string — and
 * this gate would then be green while testing nothing. The escapes cannot be
 * normalised by an editor.
 *
 * `NFD_NAME` is what goes on disk (`e` + U+0301 combining acute); `NFC_NAME` is
 * what `hub.md` writes in its link (U+00E9). They are canonically equivalent and
 * are not equal as strings, which the gate asserts before relying on it.
 */
const NFD_NAME = 'caf\u0065\u0301';
const NFC_NAME = 'caf\u00e9';

/**
 * The links `hub.md` writes, as `[source form, target slug]`.
 *
 * **In natural document order**, the way a person introduces the forms — see
 * this file's header for why it was slug-ordered until the producer sorted.
 * The expected edge set is written out separately below rather than derived
 * from this table, per plan §2.6's second property: both the anchors and
 * `outgoing` are producer output, so comparing them only against each other is
 * the same self-comparison trap `expectedRoutes()` falls into.
 */
const HUB_LINKS: readonly (readonly [string, string])[] = [
  ['Form 1, shortest path: [[alpha]].', 'alpha'],
  ['Form 2, vault root: [[/deep/beta]].', 'deep-beta'],
  ['Form 3, explicit relative: [[./gamma]].', 'gamma'],
  ['Form 3, prefix-less multi-segment relative: [[deep/beta]].', 'deep-beta'],
  ['Form 4, standard Markdown: [delta](delta.md).', 'delta'],
  ['Form 5, display text: [[gamma|shown differently]].', 'gamma'],
  ['An ambiguous target: [[shared]].', 'one-shared'],
  // Written NFC, against a filename stored decomposed. The two are canonically
  // equivalent and unequal as strings, so this resolves only because
  // `indexCorpus` normalises the corpus side as well as the link side.
  [`An NFC link to a decomposed filename: [[zzqcafe-${NFC_NAME}]].`, 'zzqcafe-cafe'],
];

/**
 * The corpus, and every §2.6 case it is required to contain.
 *
 * Every case §2.6 names is here, and each is *linked from* `hub.md` rather than
 * merely present — a fixture case no assertion depends on is decoration. A
 * same-basename pair in two folders (`one/shared.md`, `two/shared.md`, reached
 * by `[[shared]]`); an NFC/NFD pair; an unprefixed multi-segment relative link
 * (`[[deep/beta]]`); two `/`-anchored misses that fail at *different* tiers; a
 * link to this page's own heading; and a link to a note withheld by
 * `publish: false`, which reaches `unpublished` through a different door than a
 * missing file does.
 *
 * The case-only pair is the one exception and says so at its own definition: it
 * collides on slug before resolution ever sees it, so it is a corpus hazard
 * rather than a resolution one and no gate may depend on its cardinality.
 */
function writeCorpus(notes: string): void {
  put(
    notes,
    'hub.md',
    [
      '# Hub',
      '',
      ...HUB_LINKS.map(([line]) => line),
      '',
      'An embed of a note, which nothing transcludes: ![[alpha]].',
      `A link to a withheld note: [[${WITHHELD_DIRECTORY}/${WITHHELD_SUBDIRECTORY}/zzqrenewal]].`,
      // Two /-anchored misses, because they fail at different tiers and only
      // one of them is §2.6's named case. `[[/nope]]` names nothing at all and
      // dies at tier 0, indistinguishable from any typo. `[[/beta]]` names a
      // file that *exists* at `deep/beta.md` — tier 3's exact-root test misses,
      // and tier 4 then refuses the fuzzy fallback precisely because the author
      // wrote a leading slash. Without the second, tier 4's branch
      // (`src/lib/link-resolution.ts:494`) is never executed by this fixture.
      'A /-anchored link that misses: [[/nope]].',
      'A /-anchored link to a file that exists deeper: [[/beta]].',
      // A link to this page's own heading. It renders — the anchor is real —
      // and contributes no edge, because `checkCorpus` rejects an entry listing
      // itself. That is the third reason the heading still reads "Links to",
      // and it is why the article-href gate excludes this page's own slug.
      'A link to my own heading: [[hub#Hub]].',
      'An external link: [example](https://example.invalid/).',
      '',
      '```text',
      'A fence documenting the syntax: [[alpha]] and [delta](delta.md).',
      '```',
    ].join('\n') + '\n',
  );

  for (const [path, title] of [
    ['alpha.md', 'Alpha'],
    ['gamma.md', 'Gamma'],
    ['delta.md', 'Delta'],
    ['deep/beta.md', 'Beta'],
    ['one/shared.md', 'Shared One'],
    ['two/shared.md', 'Shared Two'],
  ] as const) {
    put(notes, path, `# ${title}\n\nOrdinary prose.\n`);
  }

  // The case-only pair, in a subdirectory of its own.
  //
  // **It is a corpus hazard here, not a resolution one, and the distinction is
  // what an earlier draft of this file got wrong.** `slugFor` lowercases every
  // segment, so `Casey.md` and `casey.md` both slug to `casey` — on a
  // case-*sensitive* filesystem both files exist and the second is dropped as
  // `slug-collision`, never reaching the resolver at all. On this host
  // (measured: case-insensitive) the second write lands on the first file and
  // there is one note.
  //
  // So the pair's *cardinality* differs by platform and no gate here may depend
  // on it — including indirectly, through a total count of dropped files, which
  // is exactly what turned an earlier version of the withheld-note gate red on a
  // case-sensitive runner while passing locally.
  put(notes, 'zzqcase/Casey.md', '# Casey Upper\n\nOrdinary prose.\n');
  put(notes, 'zzqcase/casey.md', '# Casey Lower\n\nOrdinary prose.\n');

  // The NFC/NFD pair, and it is a *pair* rather than two files that happen to
  // carry an accent. Both names normalise to the same NFC string and differ only
  // in their stored bytes, which is the case `indexCorpus` normalises both sides
  // for. Measured on this host: NTFS keeps both byte sequences as distinct names,
  // so both files exist and neither shadows the other.
  //
  // `hub.md` links this target in **NFC** while the file is stored
  // **decomposed** — the one spelling where normalising the link and not the
  // filename changes the answer. Without that link the normalisation would be
  // present in the fixture and exercised by nothing.
  put(notes, `zzqcafe-${NFD_NAME}.md`, '# Cafe Decomposed\n\nOrdinary prose.\n');

  // Withheld by frontmatter, not by a glob: `publish: false` is rank 1 and
  // reaches `unpublished` through a different door than a missing file. Both
  // the path and the body carry distinctive tokens, so the absence assertions
  // below can tell a leaked *path* from leaked *content*.
  put(
    notes,
    `${WITHHELD_DIRECTORY}/${WITHHELD_SUBDIRECTORY}/zzqrenewal.md`,
    '---\npublish: false\n---\n\n# Renewal\n\nzzqwithheldbody prose that no reader may see.\n',
  );
}

/** Build the fixture with the real binary, and return where it landed. */
function buildFixture(root: string): { notes: string; out: string; stdout: string } {
  const notes = join(root, 'notes');
  const out = join(root, 'out');
  mkdirSync(notes, { recursive: true });
  writeCorpus(notes);

  // The NFC/NFD pair is only a pair if the two forms really are canonically
  // equivalent and really are different strings. Asserted here rather than
  // trusted, because an editor that normalised this source file would make them
  // equal and every gate reading them would stay green while measuring a plain
  // ASCII lookup. This is the one property of the fixture that a well-meaning
  // save can silently delete.
  assert.notEqual(NFD_NAME, NFC_NAME, 'the NFD and NFC fixture names are the same string');
  assert.equal(
    NFD_NAME.normalize('NFC'),
    NFC_NAME,
    'the NFD and NFC fixture names are not canonically equivalent, so the link below is ' +
      'simply a broken link rather than a normalisation test',
  );

  const probe = spawnSync(process.execPath, [BINARY, 'build', '--content', notes, '--out', out], {
    cwd: root,
    encoding: 'utf8',
  });
  // `signal` and `error` as well as the two streams. This gate has failed
  // intermittently with **both streams empty** — roughly one run in six under
  // `pnpm run verify`, never reproduced in isolation (4 runs) or under
  // deliberate CPU load (12 spawns). An empty message means the process died
  // without writing to either stream, and the three states that produce it are
  // indistinguishable from `status` alone: killed by a signal, `spawnSync`
  // failing before exec, and an exit that genuinely printed nothing.
  //
  // Diagnostic only. Nothing is fixed here, because the fault is not understood
  // — see `.tmp/staging-collision-report.md` §7. When it next fires, this
  // message says which of the three it was.
  assert.equal(
    probe.status,
    0,
    `the fixture build failed (status ${probe.status}, signal ${probe.signal}` +
      `${probe.error ? `, error ${probe.error.message}` : ''}):\n` +
      `stdout: ${probe.stdout || '(empty)'}\nstderr: ${probe.stderr || '(empty)'}`,
  );
  return { notes, out, stdout: probe.stdout };
}

/** One built page. */
function page(out: string, slug: string): string {
  return readFileSync(join(out, 'notes', slug, 'index.html'), 'utf8');
}

/**
 * The article body, which is the region §2.6 names.
 *
 * Delimited already by `src/pages/notes/[slug].astro`, and the delimitation is
 * what makes the gate meaningful: it excludes the outgoing list, the backlinks
 * aside, and the graph SVG, all of which link the same notes. A gate over the
 * whole page would be green on a page whose article had no links at all.
 */
function article(html: string): string {
  const found = /<article class="prose"[^>]*>[\s\S]*?<\/article>/.exec(html);
  assert.ok(found, 'the page has no <article class="prose"> region');
  return found[0];
}

/** One of the three relationship sections, by the region it labels. */
function relationSection(html: string, name: string): string {
  const found = new RegExp(
    `<aside class="relations" aria-labelledby="${name}-title">[\\s\\S]*?</aside>`,
  ).exec(html);
  assert.ok(found, `the page has no "${name}" relationship section`);
  return found[0];
}

/** The note slugs a fragment of built HTML links to, in document order. */
function linkedSlugs(html: string): string[] {
  return [...html.matchAll(/href="\/notes\/([^/"]+)\//g)].map(([, slug]) => slug!);
}

// --- §2.6: the article's hrefs are the edge set -----------------------------------

/**
 * Every `/notes/<slug>/` href inside the article equals `outgoing` mapped
 * through `routeForSlug`.
 *
 * **The expected value is written down here**, per plan §2.6's second property.
 * Both the anchors and `outgoing` are producer output, and comparing them
 * against each other proves consistency rather than correctness — the same trap
 * `expectedRoutes()` falls into. This table was derived by reading the corpus
 * above, not by running the build.
 *
 * Asserted as a **set**, not a count: §2.6's first property is that two wrong
 * edges of the same cardinality is the failure this catches. The count is
 * checked separately, and only to prove the set is not empty.
 *
 * Five forms are represented and the two that are on the page but not in the
 * set are the whole reason the heading still reads "Links to": the external
 * link renders and is never an edge, and the `/`-anchored miss degrades to
 * text. Both are asserted below rather than left implied.
 *
 * **Mutation watched fail:** removing `[[deep/beta]]` from `HUB_LINKS` — one of
 * the two spellings reaching that target — left the article's href set
 * unchanged (the vault-root form still reaches it) and this gate stayed green,
 * correctly: it is a set gate and the set did not change. Removing *both*
 * spellings turned it red with `deep-beta` missing from the actual. Recorded
 * because the first result is the "you mutated something inert" case: the
 * property is the set, so only a mutation that changes the set can test it.
 */
test('the article hrefs are exactly the artifact edge set, over all five forms', () => {
  scratch('tk28-article-', (root) => {
    const { out } = buildFixture(root);
    const html = page(out, 'hub');

    // Hand-written from the corpus. Six link forms reach five distinct notes;
    // `one-shared` is the ambiguous target's winner and `zzqcafe-cafe` is the
    // decomposed filename an NFC link found, and both render like any other
    // resolved link.
    const expected = ['alpha', 'deep-beta', 'delta', 'gamma', 'one-shared', 'zzqcafe-cafe'];

    // **This page's own slug is excluded, and that is the property rather than
    // a convenience.** `[[hub#Hub]]` renders a real anchor *inside the article*
    // and contributes no edge, because `checkCorpus` rejects an entry that
    // lists itself — so the raw href set is `expected` plus `hub`, and the
    // equality §2.6 states is true only of the links that point elsewhere. A
    // gate that omitted the self-link from the fixture would state a simpler
    // property than the one that holds.
    const inArticle = [...new Set(linkedSlugs(article(html)))].filter((slug) => slug !== 'hub').sort();
    assert.deepEqual(
      inArticle,
      expected,
      'the article body does not link exactly the notes the edge set names',
    );

    // The self-link is present, or the exclusion above is silently doing
    // nothing and this gate is the simpler one it claims not to be.
    assert.ok(
      article(html).includes(`href="${noteRoute('hub')}#`),
      "the article carries no link to this page's own heading, so the exclusion above is inert",
    );

    // The same set, in the outgoing aside, mapped through the route helper —
    // which is what makes this a statement about `routeForSlug` rather than
    // about a string shape spelled twice.
    const outgoing = [...new Set(linkedSlugs(relationSection(html, 'outgoing')))].sort();
    assert.deepEqual(outgoing, expected, 'the outgoing list is not the article edge set');
    for (const slug of expected) {
      assert.ok(
        article(html).includes(`href="${noteRoute(slug)}"`),
        `the article does not carry ${slug} at the route noteRoute() defines`,
      );
    }
  });
}, BUILD_TIMEOUT);

/**
 * The two link forms that are on the page and are correctly *not* edges.
 *
 * This is the heading decision, gated. "Links to" is kept over "every link on
 * this page" precisely because these exist, so the claim needs evidence rather
 * than a comment: an external link renders as a live anchor and is never an
 * edge, and a `/`-anchored link that misses degrades to text with no anchor at
 * all.
 *
 * **Mutation watched fail:** replacing the `unresolved` branch in
 * `scripts/resolve-links.ts` with the resolved rewrite turned the second half
 * red — `/nope` became an anchor. Noted as the "mutation broader than the
 * property" case from TK-27 §7.3: that edit also changes what every other
 * unresolved link does, so it proves the branch is live rather than proving
 * this spelling specifically. The first half is mutated separately, by
 * `isExternal` returning false, which turned it red with the external URL
 * rewritten to a note route.
 */
test('an external link renders without an edge, and a /-anchored miss renders no anchor', () => {
  scratch('tk28-nonedge-', (root) => {
    const { out } = buildFixture(root);
    const body = article(page(out, 'hub'));

    assert.ok(
      body.includes('href="https://example.invalid/"'),
      'the external link did not survive into the article',
    );
    // The miss degrades to *text*, keeping the slash the author typed — the
    // degradation is "not a link", not "rewritten prose". So the assertion is
    // that no anchor points at it, which is the property; a substring test for
    // `/nope` would be red on correct output. Measured: the article reads
    // `Anchored miss /nope.` with no `<a>` around it.
    assert.ok(
      !/href="[^"]*nope/.test(body),
      'the /-anchored miss rendered as a live anchor rather than degrading to text',
    );
    assert.ok(body.includes('/nope'), "the author's own words were deleted rather than unlinked");

    // **Tier 4, which is the case §2.6 actually names**, and it is a different
    // event from `[[/nope]]`: `deep/beta.md` *exists*, and `[[beta]]` without
    // the slash resolves to it through tier 5. Written with a leading slash the
    // author asked for one exact root path, tier 3 missed it, and tier 4
    // refuses the fuzzy fallback rather than guessing
    // (`src/lib/link-resolution.ts:494`). So the same target is a live link
    // under one spelling and plain text under the other, in one body.
    //
    // The article-href gate cannot see this — `deep-beta` is in its set either
    // way, reached by the two spellings that do resolve — which is why the
    // assertion lives here, where degradation is the observable.
    assert.ok(
      body.includes('/beta.'),
      'the /-anchored link to an existing deeper file did not degrade to text, so tier 4 ' +
        'accepted a fuzzy match for a strict root anchor',
    );
    // And the non-anchored spelling of that same file *is* a link, or the
    // assertion above passes on a corpus where nothing could have resolved.
    assert.ok(
      body.includes(`href="${noteRoute('deep-beta')}"`),
      'no spelling of the deeper file resolved, so its /-anchored miss proves nothing',
    );
  });
}, BUILD_TIMEOUT);

/**
 * A fenced code block documenting link syntax is neither rewritten nor an edge.
 *
 * TK-27 makes this unrepresentable rather than merely tested — a `[[X]]` in a
 * fence is a `code` node and the walk visits only `link` and `image` nodes — so
 * this asserts the *page* half of it: the fence still reads as the author wrote
 * it, and the article's edge set (above) never counted it.
 *
 * **Mutation watched fail, and the first attempt was inert.** Adding `'code'`
 * and `'inlineCode'` to the node types `collectLinkNodes` pushes came back
 * *green* — the loop's own guard at `scripts/resolve-links.ts:350`
 * (`node.type !== 'link' && node.type !== 'image'`) re-excludes them, so the
 * mutation never reached the rewriter. That is TK-27 §7.3's first case exactly:
 * a green result meaning something inert was mutated. The mutation that
 * actually reaches this pushes each `code` node re-typed as a `link`, and it
 * turned this red — the fence was consumed and no `<pre>` survived in the
 * article at all.
 */
test('a fence documenting link syntax survives as text, and adds no edge', () => {
  scratch('tk28-fence-', (root) => {
    const { out } = buildFixture(root);
    const body = article(page(out, 'hub'));

    const fence = /<pre[\s\S]*?<\/pre>/.exec(body);
    assert.ok(fence, 'the article has no fenced block');
    assert.ok(
      fence[0].includes('[[alpha]]'),
      `the fence's wikilink was rewritten rather than published as content: ${fence[0]}`,
    );
    assert.ok(
      !/href="\/notes\//.test(fence[0]),
      'the fence contains a note link, so its documented syntax became a real link',
    );
  });
}, BUILD_TIMEOUT);

// --- Increment 4: ambiguous and embed-not-transcluded, on the page ---------------

/**
 * An ambiguous link renders as an ordinary resolved link, and an embed of a
 * note becomes a link rather than an image.
 *
 * Both are outcomes TK-27 records and neither had anything asserted about what
 * a *page* does with it. The answers are deliberate and worth pinning:
 *
 * - **Ambiguity renders.** Decision D1 makes it a warning rather than a build
 *   failure — failing is worst exactly where it is most likely, and a stranger
 *   running this tool on their own repository cannot always act on it. So the
 *   page shows a working link to the winner, and the report names every
 *   candidate. A reader meets a link, not a diagnostic; the diagnostic is for
 *   the author, in a file `git add` cannot reach.
 * - **An embed is a link.** `![[alpha]]` is Obsidian transclusion and nothing
 *   here transcludes. The one certainly-wrong outcome is an `<img src>`
 *   pointing at an HTML page, so it degrades to an ordinary link.
 *
 * **Mutations watched fail, in three attempts, two of which measured the wrong
 * thing.** Returning `unresolved` for the `ambiguous` case in `resolveLink`
 * turned the first half red — `one-shared` left the edge set and the link
 * degraded to text. For the embed half, making `collectLinkNodes` skip `image`
 * nodes turned the gate red *via a build failure* rather than via this
 * assertion: the residue scan caught the surviving `![[alpha]]` first, which is
 * a broader instrument answering a different question. TK-27 §7.3's second case
 * — a red result from a mutation wider than the property claimed. The mutation
 * that isolates this one rewrites the embed as `<img src=…>` and leaves
 * everything else intact; it turned this red on `an embed of a note rendered as
 * an image`, which is the property itself.
 */
test('an ambiguous link renders as a link, and an embed of a note is not an image', () => {
  scratch('tk28-outcomes-', (root) => {
    const { out } = buildFixture(root);
    const html = page(out, 'hub');
    const body = article(html);

    // Ambiguity: a real anchor to the winner, chosen by the total tiebreak.
    assert.ok(
      body.includes(`href="${noteRoute('one-shared')}"`),
      'the ambiguous link did not render as a link to its winner',
    );

    // The embed. No `<img>` anywhere in the article — the outcome that would be
    // certainly wrong — and the target is reached by an anchor instead.
    assert.ok(!body.includes('<img'), 'an embed of a note rendered as an image');
    assert.ok(
      body.includes(`href="${noteRoute('alpha')}"`),
      'the embed did not become a link to the note it named',
    );
    // And it left no literal embed syntax behind, which is what a reader would
    // otherwise meet as raw punctuation.
    assert.ok(!body.includes('![['), 'the embed syntax survived into the page as text');
  });
}, BUILD_TIMEOUT);

/**
 * The empty states are true, which is what TK-27 changed about them.
 *
 * `outgoingEmpty` reads "This note links to no other published note", and
 * before one traversal produced both the href and the edge, that sentence was
 * printed for a note whose body was full of Markdown-syntax links. The claim
 * was reachable-false; now it is not. **Nothing gated it before this test** —
 * `tests/built-routes.test.ts:585` asserts a section renders *either* a list or
 * an empty state, never that the sentence is true.
 *
 * Asserted in both directions on one built site: a note that links nothing
 * prints the empty state, and a note that links something does not.
 *
 * **Mutation watched fail:** changing `[slug].astro`'s `empty={t.outgoingEmpty}`
 * to `t.backlinksEmpty` turned this red on the wording. Changing `entries={outgoing}`
 * to `entries={[]}` turned it red on the hub, which is the direction that
 * matters — a page claiming it links to nothing while its body links five notes.
 */
test('the outgoing empty state is printed only where it is true', () => {
  scratch('tk28-empty-', (root) => {
    const { out } = buildFixture(root);
    const t = translate('en');

    // `alpha` is linked *from* the hub and links nothing itself, so its
    // outgoing section is the empty case and its backlinks section is not.
    const alpha = page(out, 'alpha');
    const alphaOutgoing = relationSection(alpha, 'outgoing');
    assert.ok(
      alphaOutgoing.includes(t.outgoingEmpty),
      `a note that links nothing did not print the empty state: ${alphaOutgoing}`,
    );
    assert.deepEqual(linkedSlugs(alphaOutgoing), [], 'the empty outgoing section still linked a note');
    assert.deepEqual(
      linkedSlugs(relationSection(alpha, 'backlinks')),
      ['hub'],
      'the backlink from the hub did not reach the target page',
    );

    // And the hub, which links five notes, must not print it.
    const hubOutgoing = relationSection(page(out, 'hub'), 'outgoing');
    assert.ok(
      !hubOutgoing.includes(t.outgoingEmpty),
      'a note linking five others claims it links to none',
    );
    assert.ok(
      hubOutgoing.includes(t.backlinksEmpty) === false,
      'the outgoing section printed the backlinks empty state',
    );
  });
}, BUILD_TIMEOUT);

// --- Increment 3: the withheld path, over every rendered surface -----------------

/**
 * A withheld note's **body** reaches no published file, and its **path** now
 * deliberately does.
 *
 * **This gate held the opposite of its second half until 2026-08-17**, and the
 * assertion that went read:
 *
 *     for (const token of [WITHHELD_DIRECTORY, WITHHELD_SUBDIRECTORY])
 *       assert.deepEqual(published.filter(carries(token)), [])
 *
 * — no directory of a withheld note in any file the build publishes, over
 * `dist/` decompressed. What it protected is the fact that a reader of the
 * published site, or a crawler, could not recover the shape of the author's
 * private tree. The owner reversed that: a withheld link keeps its full label,
 * a wikilink's label is its path, so `zzqclients/zzqacme` ships. The loop is
 * gone rather than narrowed — there is no narrower true version of it.
 *
 * **Everything else here survives, and the machinery is why this gate is worth
 * more now than before.** Scanning every published file with gzip members
 * inflated is exactly what is needed to hold the line the decision did *not*
 * move: the note's own prose. A build that published the withheld body would
 * now be much harder to notice by reading a page, because the path being
 * present is no longer a signal that something went wrong.
 *
 * **The Pagefind index is gzipped, and a raw text scan cannot see into it.**
 * Measured: the token `Introduction` from a published note is absent from
 * `.pf_fragment` read as text and present after `gunzipSync`. A gate that reads
 * those bytes as UTF-8 is therefore *structurally blind* to the one surface
 * TK-30's report says the leak actually went through — it would be green on a
 * real disclosure. So every file is decompressed first where its magic bytes
 * say to.
 *
 * **Mutation watched fail (body half):** deleting the `published === false`
 * branch in `scripts/markdown-to-artifact.ts` turns this red with
 * `zzqwithheldbody` found in six published files, four of them reachable only
 * after inflating.
 *
 * **Mutation watched fail (link half):** making the `unpublished` branch in
 * `scripts/resolve-links.ts` take the `unresolved` path — `const live = false`
 * — turns the anchor assertion red: the withheld link degrades to text and no
 * `href="/private/"` appears in the built page.
 */
test('a withheld note ships its path in a live link and its body nowhere', () => {
  scratch('tk28-withheld-', (root) => {
    const { notes, out } = buildFixture(root);

    // Half one: the tokens really are in the corpus on disk. Without this the
    // assertions below pass on a fixture that never contained them.
    const corpusFiles = filesUnder(notes);
    for (const token of [WITHHELD_DIRECTORY, WITHHELD_SUBDIRECTORY]) {
      const carrying = corpusFiles.filter(
        (file) => file.includes(token) || readFileSync(file, 'utf8').includes(token),
      );
      assert.ok(
        carrying.length > 0,
        `the fixture never carries "${token}", so the assertions below prove nothing`,
      );
    }
    // And the *link* to it is in a body, so the build had to make a decision
    // about it rather than never meeting one.
    assert.ok(
      readFileSync(join(notes, 'hub.md'), 'utf8').includes(WITHHELD_DIRECTORY),
      'no note links the withheld file, so no withheld path was ever at risk',
    );

    // Half two: every file, decompressed where the bytes are gzip — which is
    // what lets this see into the Pagefind index.
    const readable = (file: string): string => {
      const bytes = readFileSync(file);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        try {
          return gunzipSync(bytes).toString('utf8');
        } catch (error) {
          // **Thrown, not fallen back from.** Scanning undeflated gzip bytes
          // for a UTF-8 token *is* reporting clean, so a silent fallback here
          // would be the blindness this whole function exists to remove,
          // wearing a comment that says otherwise. A member this Node cannot
          // inflate is a file the gate could not look inside, and "could not
          // look" must not be spelled the same way as "looked and found
          // nothing".
          return assert.fail(
            `${file.slice(out.length + 1)} is gzipped and could not be inflated, so this gate ` +
              `cannot see whether a withheld name is inside it: ${String(error)}`,
          );
        }
      }
      return bytes.toString('utf8');
    };

    const published = filesUnder(out);

    // **The withheld note's own prose ships nowhere.** This is the line the
    // 2026-08-17 decision did not move, and it is the one that separates "the
    // link discloses where the note lives" from "the note was published".
    const bodyLeaks = published.filter((file) => readable(file).includes('zzqwithheldbody'));
    assert.deepEqual(
      bodyLeaks.map((file) => file.slice(out.length + 1).replaceAll('\\', '/')),
      [],
      "the withheld note's own prose reached the published site",
    );

    // **And the path ships, in a live anchor, on the page that linked it.**
    // Asserted rather than merely permitted: a rule nobody checks is a rule the
    // next refactor silently reverts, and this is the surface the owner decided
    // about. The anchor and the path are asserted together — the path present
    // *without* the anchor would mean the rewrite emitted the target as prose.
    const hub = readFileSync(join(out, 'notes', 'hub', 'index.html'), 'utf8');
    assert.match(
      hub,
      new RegExp(`<a href="${WITHHELD_ROUTE}">${WITHHELD_DIRECTORY}/${WITHHELD_SUBDIRECTORY}/[^<]*</a>`),
      `the hub page does not carry the withheld target as a live link to ${WITHHELD_ROUTE}`,
    );
    // And that route is a page the host can serve, so the link is not a 404.
    assert.ok(
      existsSync(join(out, WITHHELD_ROUTE.slice(1, -1), 'index.html')),
      `${WITHHELD_ROUTE} is linked from a note body but was not built`,
    );

    // Non-vacuity for the decompression itself. If no published file were
    // gzipped, the `gunzipSync` branch above would be dead and this gate would
    // silently be a plain text scan — which is the exact blindness it exists to
    // remove.
    const compressed = published.filter((file) => {
      const bytes = readFileSync(file);
      return bytes[0] === 0x1f && bytes[1] === 0x8b;
    });
    assert.ok(
      compressed.length > 0,
      'no published file is gzipped, so the decompression branch never ran and this gate ' +
        'is a plain text scan claiming to be more',
    );
    // And the decompression actually yields the text it should: a published
    // note's own words, readable only after inflating.
    assert.ok(
      compressed.some((file) => readable(file).includes('Ordinary prose')),
      'no compressed file yielded a published note\'s text, so the inflate step is not ' +
        'reaching the search index this gate claims to cover',
    );
  });
}, BUILD_TIMEOUT);

/**
 * The withheld note is not a route, not an index entry, and not a graph node.
 *
 * The gate above proves no *token* leaked. This proves the note is absent as an
 * entity — a build could withhold every spelling of the path while still
 * publishing the note under its slug, which is the same disclosure wearing a
 * different name.
 *
 * **Mutation watched fail:** removing the `published === false` branch from
 * `scripts/markdown-to-artifact.ts` turned this red — the withheld note gained
 * the route `zzqclients-zzqacme-zzqrenewal`, and its title and excerpt entered
 * the snapshot.
 */
test('a note withheld by frontmatter is absent as a route, an index entry, and a node', () => {
  scratch('tk28-absent-', (root) => {
    const { out, stdout } = buildFixture(root);

    // The stimulus: something was actually withheld. **A count, not *the*
    // count** — an earlier version asserted `/1 dropped/` and was red on every
    // case-sensitive runner, because `zzqcase/Casey.md` and `zzqcase/casey.md`
    // both exist there, collide on one slug, and make it two. The number is a
    // property of the platform; that it is nonzero is a property of the corpus.
    const dropped = /(\d+) dropped/.exec(stdout);
    assert.ok(dropped, `the build printed no drop count:\n${stdout}`);
    assert.ok(
      Number(dropped[1]) > 0,
      `the build dropped nothing, so nothing was withheld:\n${stdout}`,
    );

    // No route. **The withheld note's own slug**, which is what `slugFor`
    // makes of its path — not its stem. An earlier version asserted the stem
    // was not a route, which no build could produce however broken: every
    // segment is joined, so `zzqrenewal` alone is not a route this producer can
    // emit and the assertion measured nothing.
    const routes = readdirSync(join(out, 'notes')).sort();
    assert.ok(
      !routes.includes('zzqclients-zzqacme-zzqrenewal'),
      'the withheld note was published as a route',
    );
    assert.ok(
      !routes.some((route) => route.includes('zzqclients')),
      'a route carries the withheld directory',
    );
    // Non-vacuity: the route set is populated, so the absences above are a real
    // filter rather than an empty directory.
    assert.ok(routes.length > 0, 'the build published no routes at all');

    // Not in the snapshot the browser fetches.
    const slugs = snapshotSlugs(out);
    assert.ok(
      !slugs.some((slug) => slug.includes('zzqrenewal')),
      'the withheld note has a row in the snapshot',
    );
    // Non-vacuity: the snapshot is populated, so the absence above is a real
    // filter rather than an empty table.
    assert.ok(slugs.length > 0, 'the snapshot stores no nodes, so its absence check is vacuous');

    // And no graph anywhere draws it. The node label is a *title*, so the
    // assertion is on the withheld note's title rather than on its stem: the
    // stem ships as degraded link text by design (see the gate above), and
    // asserting its absence here would be red on correct output. A graph node
    // for the withheld note would carry `Renewal` and a `/notes/` href.
    for (const file of filesUnder(out).filter((path) => path.endsWith('.html'))) {
      const html = readFileSync(file, 'utf8');
      assert.ok(
        !/href="\/notes\/[^"]*zzqrenewal/.test(html),
        `${file.slice(out.length + 1)} links the withheld note as a route`,
      );
      assert.ok(
        !html.includes('zzqwithheldbody'),
        `${file.slice(out.length + 1)} carries the withheld note's prose`,
      );
    }
  });
}, BUILD_TIMEOUT);

/**
 * The backlink surface carries only published metadata, on a real built site.
 *
 * `AGENTS.md` lists "backlinks and hover previews contain only allowlisted page
 * metadata" among the properties the gates assert, and over a foreign corpus
 * nothing held it: the published fixture has one note and zero edges, so every
 * backlink gate in this tree has been vacuous for the shape this tool exists to
 * serve.
 *
 * **The assertion is an allowlist, not a list of forbidden strings**, and the
 * first version was the latter and was measured near-vacuous. It said "the
 * aside does not contain `Ordinary prose`" — and a mutation rendering
 * `{entry.excerpt}` beside every title came back **green**, because the hub's
 * excerpt happens not to contain that phrase. A gate naming the strings its
 * author thought of is the same shape TK-30's disclosure gate had to abandon:
 * it cannot see the leak nobody enumerated.
 *
 * So the aside is reduced twice, against two separate allowlists, because the
 * two halves of an element leak differently. **Text** is reduced to each linked
 * note's title plus this locale's own chrome. **Attributes** are checked by
 * *name*, and anything outside the allowed set fails whatever it holds — which
 * is the half a first draft of this reduction missed. Blanking tags erases
 * their attribute values along with them, so `title="<the source's excerpt>"`
 * reduced to `""` and the gate was green on a real disclosure. That is not
 * hypothetical: `src/scripts/link-preview.ts` already builds a hover panel from
 * `{title, excerpt}`, so an excerpt reaching an attribute on this element is
 * one component edit away.
 *
 * **Mutations watched fail:** rendering `{entry.excerpt}` as *text* beside the
 * title — the mutation the forbidden-string version missed — turns the text
 * half red with the leftover named. Rendering it into a `title=` attribute
 * turns the attribute half red; against the text half alone it was green, which
 * is why there are two. Rendering `{entry.markdown}` is red too, but *via a
 * build failure* rather than either assertion: the body carries the `[[alpha]]`
 * fence and the residue scan rejects an unresolved wikilink outside a code
 * region. Recorded as TK-27 §7.3's second case — a broader instrument
 * answering first.
 */
test('a backlink names its source by title and route, and carries nothing else', () => {
  scratch('tk28-backlink-', (root) => {
    const { out } = buildFixture(root);
    const section = relationSection(page(out, 'alpha'), 'backlinks');
    const t = translate('en');
    const sources = linkedSlugs(section);

    // The two fields a backlink may carry, and the hub is the only source.
    assert.deepEqual(sources, ['hub'], 'the backlink set is not the artifact inverse');
    assert.ok(section.includes('>Hub</a>'), 'the backlink does not name its source by title');

    // Half one: the text. `replaceAll` and a replacer function rather than a
    // literal — a translated chrome string is prose, and `String.replace` reads
    // `$&` in a *replacement* as a substitution, so a locale that ever contains
    // one would corrupt the reduction rather than fail it. The count is derived
    // from the rendered set rather than pinned at one, so a second backlink
    // fails on what it carries instead of on its own grammar.
    const residue = ['Hub', t.backlinksHeading, t.noteCount(sources.length)]
      .reduce((text, allowed) => text.replaceAll(allowed, ' '), section.replace(/<[^>]*>/g, ' '))
      .trim();
    assert.equal(
      residue,
      '',
      `the backlink aside carries text that is neither a linked title nor this locale's ` +
        `own chrome: "${residue}"`,
    );

    // Half two: the attributes — **by name, and then by the shape of what each
    // one holds.**
    //
    // The name check alone was measured insufficient, and it failed the same
    // way the version before it did, one indirection down. Blanking tags hid
    // attribute values entirely; checking names hid values wearing an allowed
    // name. Measured: `class={entry.excerpt}` on the anchor ships the whole
    // excerpt into the built page and **both halves stay green** — no
    // disallowed name, and the text reduction never sees inside a tag.
    //
    // So each allowed attribute is checked against what it may *contain*. A
    // value allowlist rather than a second name list, deliberately: a second
    // list would be the same mistake a third time, closing this instance and
    // leaving the class open. What these five may hold is knowable and narrow —
    // a route this build produced, a BCP 47 tag, an identifier this template
    // constructs, a class token from the stylesheet's vocabulary. An artifact
    // field is free prose and matches none of them.
    const TAG = /<([a-z][a-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
    const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    /**
     * What each attribute a backlink may carry is allowed to hold.
     *
     * `href` is compared against the routes this build actually produced rather
     * than a route-shaped pattern, which is the sharper test: a well-formed
     * route to a note that is not in this aside is still wrong.
     */
    const shapes: Readonly<Record<string, RegExp>> = {
      // A note route, and the section's own links are checked against the edge
      // set separately — this bounds the syntax so free text cannot pass.
      href: /^\/notes\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/,
      // Space-separated class tokens, as the stylesheet spells them.
      class: /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/,
      // The ids this template constructs are `<region>-title`, and
      // `aria-labelledby` points at one of them.
      id: /^[a-z][a-z0-9-]*$/,
      'aria-labelledby': /^[a-z][a-z0-9-]*$/,
      // A BCP 47 tag, which is what `partLanguage` returns.
      lang: /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*$/,
    };
    const seen: string[] = [];
    for (const [, tag, attributes] of section.matchAll(TAG)) {
      for (const [, attribute, quoted, single, bare] of (attributes ?? '').matchAll(ATTRIBUTE)) {
        if (attribute === undefined || attribute === '/') continue;
        const name = attribute.toLowerCase();
        seen.push(name);
        const shape = shapes[name];
        assert.ok(
          shape !== undefined,
          `the backlink aside carries a "${attribute}" attribute on <${tag}>, which is not one ` +
            'of the attributes a backlink may carry — an artifact field reaching an attribute ' +
            'is invisible to a text reduction',
        );
        // A boolean attribute has no value at all, which is its own answer.
        const value = quoted ?? single ?? bare;
        if (value === undefined) continue;
        assert.ok(
          shape.test(value),
          `<${tag} ${name}="${value}"> in the backlink aside does not hold what a ${name} may ` +
            'hold — an artifact field wearing an allowed attribute name is the leak a ' +
            'name-only check cannot see',
        );
      }
    }

    // Non-vacuity, both halves. The reduction must have had something to
    // reduce, and the attribute scan must have *found* the attributes this
    // markup carries — a regexp matching nothing satisfies a loop that never
    // runs, and `seen` is the instrument confirming it looked. `href` in
    // particular: if the tag pattern ever stops parsing this markup, the anchor
    // is the first thing it loses.
    assert.ok(
      section.includes('Hub') && section.includes(t.backlinksHeading),
      'the aside carried neither the title nor the heading, so the reduction proves nothing',
    );
    assert.ok(
      seen.includes('href') && seen.includes('class') && seen.includes('aria-labelledby'),
      `the attribute scan found ${JSON.stringify(seen)} in an aside that carries at least an ` +
        'href, a class, and an aria-labelledby — so its pattern is not reading this markup',
    );
  });
}, BUILD_TIMEOUT);
