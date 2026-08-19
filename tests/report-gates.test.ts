/**
 * The gates the report's own properties rest on, and the one surface every
 * `dist/` gate in this tree could not read.
 *
 * TK-25 built the report file and gated it; TK-26 filled `dropped`; TK-27 filled
 * `links`. Those three tickets each verified their own addition, and what was
 * left over is the seam between them — the properties that are true of the
 * report *as a whole* and belong to no single ticket. This file holds those,
 * plus the residue scan's blind spot, which is here rather than in
 * `tests/verify.test.ts` because it is a privacy property measured over a
 * stranger's build rather than over this repository's own `dist/`.
 *
 * ## Why a built site rather than a hand-written one
 *
 * Every gate below runs `bin/thoughtscape-publish.mjs` over a synthetic corpus
 * and reads what landed on disk. `tests/verify.test.ts` already scans
 * hand-written scratch directories shaped like `dist/`, and that shape is the
 * right one for asking whether a *rule* fires. It is the wrong one for asking
 * whether a rule fires on *what this pipeline actually emits*, which is the
 * question here — and the difference is not academic. The leak in
 * {@link https://pagefind.app Pagefind}'s fragments below is invisible to a
 * hand-written fixture, because no hand-written fixture gzips anything.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { scanResidue } from '../scripts/scan-residue.ts';
import { STATE_REPORT_MAX_AGE_MS } from '../scripts/write-report.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BINARY = join(ROOT, 'bin', 'thoughtscape-publish.mjs');

/** A scratch directory removed when the callback returns, however it returns. */
function scratch<T>(prefix: string, body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every file under a directory, descending into dotted directories too. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(root, entry.name)) : [join(root, entry.name)],
  );
}

/**
 * Run the packaged binary the way a user does.
 *
 * `env` is threaded because two gates below need the state directory pointed at
 * a scratch path — a gate that wrote into the developer's real
 * `%LOCALAPPDATA%` would both pollute it and read whatever a previous run left
 * there. Every other gate passes nothing, because anything this helper sets is
 * help the real user does not have.
 */
function build(
  cwd: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv = {},
): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [BINARY, 'build', ...arguments_], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * A corpus exercising every drop reason at once, plus a note that publishes.
 *
 * One corpus rather than six, because the property under test is the *partition*
 * — and a partition is exactly the claim that no reason double-counts or misses
 * against the others. Six single-reason fixtures each satisfy the arithmetic
 * trivially and together prove nothing about their interaction.
 *
 * The collision direction is measured, not assumed: `buildArtifact` sorts the
 * listing and keeps the **first** file to claim a slug, and `ZZQ__X.md` sorts
 * before `Zzq X.md`, so the winner is the one in capitals. A fixture built on
 * the intuitive reading asserts the report names a file that was published.
 */
function corpusWithEveryDropReason(notes: string): void {
  mkdirSync(join(notes, 'drafts'), { recursive: true });
  writeFileSync(join(notes, 'publish.config.yaml'), 'exclude:\n  - "drafts/**"\n', 'utf8');
  writeFileSync(join(notes, 'README.md'), '# Repo readme\n\nAddresses the repository.\n', 'utf8');
  writeFileSync(join(notes, 'drafts', 'wip.md'), '# WIP\n\nprose.\n', 'utf8');
  writeFileSync(join(notes, 'private.md'), '---\npublish: false\n---\n\n# Private\n\nprose.\n', 'utf8');
  writeFileSync(join(notes, 'ZZQ__X.md'), '# Winner\n\nprose.\n', 'utf8');
  writeFileSync(join(notes, 'Zzq X.md'), '# Loser\n\nprose.\n', 'utf8');
  writeFileSync(join(notes, '___.md'), '# Nameless\n\nprose.\n', 'utf8');
  writeFileSync(join(notes, 'asset.pdf'), 'not markdown\n', 'utf8');
  writeFileSync(join(notes, 'alpha.md'), '# Alpha\n\nprose.\n', 'utf8');
}

/**
 * The residue scan reads the search index, and a marker split by markup is
 * caught rather than shipped.
 *
 * **This is the gate for a leak that was live and green.** `scan-residue.ts`
 * excluded `dist/pagefind/` entirely, on the stated argument that Pagefind
 * indexes exactly the `data-pagefind-body` subtree of HTML the scan reads in
 * full, so nothing could reach the index without first appearing in a scanned
 * page. That argument is false in the direction that matters, because a fragment
 * stores **extracted text, not markup**: decoded, with inline elements joined.
 *
 * Measured before the fix, on a real packaged build of the corpus below:
 * `residue scan ok: 25 files, 0 findings`, with the fragment carrying `msw/`,
 * `/home/someone/`, `javascript:` and `sourceMappingURL` — every marker class,
 * none of them present as a byte sequence anywhere in `dist/`. A reader typing
 * the marker into the site's own search box got the page back.
 *
 * The fixture writes each marker split by `**strong**` rather than plainly, and
 * that is the whole mechanism: `ms**w/s**ecret` renders as
 * `ms<strong>w/s</strong>ecret`, which no raw scan can match and which Pagefind
 * stores rejoined. A fixture planting `msw/secret` plainly would be caught by
 * the *page* rule and would prove nothing about the index.
 *
 * **Mutation watched fail:** restoring the blanket skip — `if
 * (where.split(sep)[0] === THIRD_PARTY) continue;` — turns this red on all four
 * needles, with the build exiting 0 and printing `residue scan ok`.
 */
test('a marker that only the search index carries fails the build', () => {
  scratch('tk29-fragment-', (directory) => {
    const notes = join(directory, 'notes');
    mkdirSync(notes, { recursive: true });
    // Padded, so nothing under test lands in the meta description or the
    // content-index excerpt — both of which a raw scan reads, and either of
    // which would make this gate pass for the wrong reason.
    const padding = Array.from(
      { length: 40 },
      (_, index) => `Filler sentence ${index} of ordinary prose.`,
    ).join(' ');
    writeFileSync(
      join(notes, 'planted.md'),
      [
        '# Planted',
        '',
        padding,
        '',
        'A marker ms**w/s**ecret here.',
        '',
        'A home /**h**ome/someone/vault/note.md here.',
        '',
        'A scheme java**scr**ipt:alert(1) here.',
        '',
        'A map source**Mapping**URL=app.js.map here.',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(notes, 'beta.md'), '# Beta\n\nThe second note.\n', 'utf8');

    const run = build(directory, ['--content', 'notes', '--out', 'out']);

    assert.equal(run.status, 1, `a build carrying four markers in its search index succeeded:\n${run.output}`);
    for (const rule of [
      'private "msw/" path marker',
      'absolute home-directory path',
      'javascript: URL',
      'source map reference',
    ]) {
      assert.ok(
        run.output.includes(rule),
        `the scan did not report ${JSON.stringify(rule)}, so it is not reading the search index:\n${run.output}`,
      );
    }

    // Non-vacuity: the findings name the search index rather than a page, which
    // is what distinguishes "the scan reads fragments" from "the markers were
    // caught in the HTML anyway". The gate below establishes the stronger
    // property — that the index carries a marker no page does — over a corpus
    // planting one marker rather than four; this is the cheap half, asserted
    // here so a regression in the location shows up on the gate that owns it.
    assert.ok(
      run.output.includes('the search index (pagefind/)'),
      'no finding names the search index, so these markers were caught in the pages and this gate ' +
        `says nothing about the index:\n${run.output}`,
    );
  });
}, 180_000);

/**
 * The marker in the search index is invisible to every raw read of the output.
 *
 * The companion measurement to the gate above, and the one that states *why*
 * scanning fragments was necessary rather than merely thorough. A gate asserting
 * "the scan found it" is satisfied by a scan that found it in the HTML; this one
 * establishes there is nothing in the HTML to find.
 *
 * **The token is `msw/` split by emphasis**, which means this build *fails* — so
 * the measurement is taken over the scan's own report rather than over `--out`,
 * which a failing build deliberately never writes. That ordering is the
 * pipeline's, not this gate's: the scan runs before the copy so a rejected build
 * leaves the user's `dist/` holding whatever last passed.
 *
 * Using the real marker rather than a synthetic one is not incidental. A token
 * of pure letters and digits survives Pagefind's stemmer and lands in
 * `.pf_meta`, which a raw read *can* see — measured, `zzqsplittoken` appeared
 * there — so a synthetic fixture would assert invisibility that a real marker
 * does not have, and would be measuring the wrong thing in the safe direction.
 * A marker containing `/` is dropped by the stemmer and survives only in the
 * fragment, which is exactly the surface at issue.
 *
 * **Mutation watched fail:** writing the marker plainly (`msw/secret`) rather
 * than split makes the page carry it, so the finding names `notes/planted/…`
 * instead of a fragment and the first assertion goes red — which is the correct
 * behaviour on that input and the reason the fixture splits.
 */
test('the marker the scan caught is one no page carries', () => {
  scratch('tk29-invisible-', (directory) => {
    const notes = join(directory, 'notes');
    mkdirSync(notes, { recursive: true });
    const padding = Array.from(
      { length: 40 },
      (_, index) => `Filler sentence ${index} of ordinary prose.`,
    ).join(' ');
    writeFileSync(
      join(notes, 'planted.md'),
      `# Planted\n\n${padding}\n\nA marker ms**w/s**ecret here.\n`,
      'utf8',
    );
    writeFileSync(join(notes, 'beta.md'), '# Beta\n\nThe second note.\n', 'utf8');

    const run = build(directory, ['--content', 'notes', '--out', 'out']);
    assert.equal(run.status, 1, `a build carrying a marker in its search index succeeded:\n${run.output}`);

    // Exactly one finding, and it names a fragment. Two findings would mean a
    // page carried the marker too, which is the case this gate must exclude —
    // the whole claim is that the index holds something no page does.
    const findings = run.output
      .split('\n')
      .filter((line) => line.trim().startsWith('- '))
      .map((line) => line.trim());
    assert.equal(
      findings.length,
      1,
      `expected the fragment alone to carry the marker, got:\n${findings.join('\n')}`,
    );
    assert.match(
      findings[0]!,
      /the search index \(pagefind\/\): contains private "msw\/" path marker/,
      'the single finding does not name the search index, so the marker was caught in a page and ' +
        'this gate says nothing about the index',
    );

    // **And the finding names no fragment file.** Measured: Pagefind names each
    // fragment for a digest of the text inside it, so two corpora differing only
    // in a note's body produce different filenames — which makes the name a
    // function of content this stream may not carry. `tests/disclosure.test.ts`
    // holds that property globally, by a rename differential; this pins it at
    // the one line that would break it, so a failure here names the cause.
    assert.ok(
      !/\.pf_fragment/.test(run.output),
      `the stream named a search-index fragment, whose filename is a digest of the note text in ` +
        `it:\n${run.output}`,
    );
  });
}, 180_000);

/**
 * The fragment scan does not break a note that documents wikilink syntax.
 *
 * The companion to the gate above, and the reason the narrowing is a *set* of
 * rules rather than all nine. A fragment carries no markup, so the `<code>`
 * exemption that lets `` `[[syntax]]` `` publish has nothing to bite on there —
 * measured, the fragment for a fenced example reads
 * `"content":"Obsidian writes a link as: [[not a link]]"` while the page reads
 * `<code class="language-text">[[not a link]]</code>`.
 *
 * Applying the wikilink rule to fragments would therefore fail the build on a
 * note about Obsidian syntax, with no spelling available that escapes it. That
 * is a false build failure on legitimate content, and it is why `[[` — alone
 * among the nine — is dropped for fragments.
 *
 * **Mutation watched fail:** deleting the `FRAGMENT_EXEMPT` guard from the rule
 * loop turns this red with `pagefind/fragment/…: contains unresolved
 * [[wikilink]]`, on a corpus whose only offence is documenting a syntax.
 *
 * **Both authored forms, because for a long time only one of them worked.** The
 * inline spelling failed the build end to end while the fenced one passed, and
 * the asymmetry was invisible to the gate that existed: `tests/verify.test.ts`
 * asserts this rule over *hand-written* scratch HTML, where an inline
 * `<code>[[inline]]</code>` is trivially exempt. Through the real pipeline the
 * excerpt is derived from the raw body and re-emitted into
 * `<meta name="description">`, `content-index.json` and `rss.xml`, none of which
 * carry a `<code>` element for the exemption to find — so the page failed on its
 * own meta tag while its body was correctly exempt. Fixed in `excerptFor`; gated
 * here, over the binary, because that is the only place the difference shows.
 */
test('a note documenting wikilink syntax builds, fenced or inline', () => {
  scratch('tk29-fence-', (directory) => {
    const notes = join(directory, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(
      join(notes, 'syntax.md'),
      ['# Syntax', '', 'Obsidian writes a link as:', '', '```text', '[[not a link]]', '```', ''].join('\n'),
      'utf8',
    );
    // The inline form, in its own note so a failure names which spelling broke.
    writeFileSync(join(notes, 'inline.md'), '# Inline\n\nInline `[[syntax]]` is how you write it.\n', 'utf8');
    writeFileSync(join(notes, 'beta.md'), '# Beta\n\nThe second note.\n', 'utf8');

    const run = build(directory, ['--content', 'notes', '--out', 'out']);
    assert.equal(run.status, 0, `a note documenting wikilink syntax did not build:\n${run.output}`);

    // Non-vacuity: the fragment really does carry the brackets, so the clean
    // build above is the exemption working rather than the corpus being empty
    // of the thing the exemption covers. Without this the gate passes on a
    // build whose search index was never written.
    const carried = filesUnder(join(directory, 'out'))
      .filter((file) => file.endsWith('.pf_fragment'))
      .filter((file) => gunzipSync(readFileSync(file)).toString('utf8').includes('[['));
    assert.ok(
      carried.length > 0,
      'no search-index fragment carries `[[`, so this gate is not exercising the exemption it ' +
        'exists for — the corpus may not have been indexed at all',
    );

    // **The excerpt of the inline note lost the code span rather than keeping
    // its brackets**, which is where the fix landed and is the half a reader of
    // this gate would otherwise have to infer. `content-index.json` ships the
    // excerpt to the browser verbatim, so it is the cheapest place to read it.
    const index = JSON.parse(
      readFileSync(join(directory, 'out', 'content-index.json'), 'utf8'),
    ) as { entries: { slug: string; excerpt: string }[] };
    const inline = index.entries.find((entry) => entry.slug === 'inline');
    assert.ok(inline, 'the inline note did not publish, so its excerpt proves nothing');
    assert.equal(
      inline.excerpt,
      'Inline is how you write it.',
      'the excerpt is not the prose with the code span removed',
    );
  });
}, 180_000);

/**
 * A wikilink the producer failed to degrade still fails the build.
 *
 * The other half of the gate above, and the one that keeps the repair from
 * becoming a hole. `[[` over `dist/` is not a privacy marker — it is a producer
 * self-check, kept deliberately in `02b51c0`: the traversal resolves every
 * wikilink *node*, so a `[[` reaching output from prose means the degradation
 * failed. A fix for the documented-syntax false positive that also let a
 * genuinely unresolved link through would have closed one instance and opened
 * the class.
 *
 * **The fixture is a built page, not a note**, and that is forced rather than
 * chosen: there is no note body that produces this defect, because the producer
 * degrades every `[[…]]` in prose — measured, `A bare [[nowhere]] in prose`
 * becomes `A bare nowhere in prose` in both the excerpt and the body, while the
 * backticked span beside it survives. The defect this rule exists to catch is a
 * *producer regression*, so the only way to exhibit it is to present the
 * scanner with what a broken producer would have emitted.
 *
 * **The layer matters and was measured rather than assumed.** This gate was
 * first written against `scripts/validate-content.ts`, on the assumption that an
 * undegraded link is caught before a page is written. It is not: `02b51c0`
 * deleted the wikilink rule from the artifact schema deliberately, because at
 * that layer it cannot tell a documented syntax from a defect. The residue scan
 * over `dist/` is the only thing holding this property, which is exactly why
 * `02b51c0` kept it there — and why weakening it would leave nothing.
 *
 * **Mutation watched fail:** widening `excerptFor`'s strip from `` `…` `` to
 * anything that also removes bare brackets turns this red — which is the
 * outcome that matters, since that is precisely the "make the failure go away"
 * repair this gate exists to refuse.
 */
test('a wikilink that reached output from prose is still residue', () => {
  scratch('tk29-genuine-', (directory) => {
    // Shaped like a built site, with the undegraded link in the two places the
    // excerpt reaches that carry no `<code>` element — a meta tag and the
    // browser-facing index — plus a page whose body is correctly exempt. All
    // three in one fixture, because the property is that the exemption
    // distinguishes them rather than that it fires or does not.
    writeFileSync(
      join(directory, 'index.html'),
      '<html><head><meta name="description" content="A link: [[nowhere]] in prose."></head>' +
        '<body><p>Documented <code>[[syntax]]</code> here.</p></body></html>',
      'utf8',
    );
    writeFileSync(
      join(directory, 'content-index.json'),
      JSON.stringify({ version: 1, entries: [{ slug: 'x', title: 'X', excerpt: 'A link: [[nowhere]].' }] }),
      'utf8',
    );

    const { findings } = scanResidue(directory);
    assert.equal(
      findings.filter((finding) => finding.includes('wikilink')).length,
      2,
      `both surfaces carrying an undegraded link must be reported, and the exempt body must not ` +
        `be:\n${findings.join('\n')}`,
    );

    // The discrimination, which is the whole point: the page's `<code>` span is
    // exempt, so a gate that simply reported every `[[` would give three.
    writeFileSync(
      join(directory, 'index.html'),
      '<html><body><p>Documented <code>[[syntax]]</code> here.</p></body></html>',
      'utf8',
    );
    assert.deepEqual(
      scanResidue(directory).findings.filter((finding) => finding.includes('index.html')),
      [],
      'a page whose only `[[` is inside a code element was reported, so documenting the syntax ' +
        'still cannot publish',
    );
  });
});

/**
 * The excerpt strips a code span and keeps a bare wikilink.
 *
 * The gate above holds the *scanner*; this holds the **producer**, and the two
 * are not the same property. A `dist/`-level gate plants its own marker, so it
 * stays green under a repair that stops the marker being produced at all —
 * measured: widening `excerptFor` to also drop `[[…]]` leaves every gate in this
 * file passing while `A bare [[nowhere]] in prose.` yields the excerpt
 * `A bare in prose.`, with the producer regression erased before anything can
 * scan for it.
 *
 * That is the shape this repository keeps meeting from a new angle: an
 * assertion cannot see a defect that its own fixture supplies. So this asserts
 * over `excerptFor`'s real output, on the two inputs whose treatment must
 * differ, and it is the only gate here that would catch the tempting repair.
 *
 * `discover()` rather than the full pipeline, deliberately: it runs *before*
 * `resolveCorpusLinks`, so the entry it returns carries the body exactly as
 * authored — which is the state a producer regression leaves and the only state
 * in which this distinction is observable.
 *
 * **Mutation watched fail:** adding `.replace(/\[\[[^\]]*\]\]/g, '')` to
 * `excerptFor` turns this red on the second assertion. Removing the code-span
 * strip turns it red on the first.
 */
test('the excerpt drops a code span and keeps a bare wikilink', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tk29-excerpt-'));
  try {
    const notes = join(directory, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(
      join(notes, 'a.md'),
      '# A\n\nA bare [[nowhere]] in prose, and `[[documented]]` in code.\n',
      'utf8',
    );

    const { discover } = await import('../scripts/markdown-to-artifact.ts');
    const found = await discover(notes, {});
    const entry = found.entries.find((candidate) => candidate.slug === 'a');
    assert.ok(entry, 'the fixture note did not become an entry, so its excerpt proves nothing');

    // The code span is gone, which is the false positive this repair closed.
    assert.ok(
      !entry.excerpt.includes('documented'),
      `the excerpt kept its code span, so a note documenting the syntax fails the build: ` +
        `${JSON.stringify(entry.excerpt)}`,
    );
    // And the bare link is still there, which is the producer defect the residue
    // rule exists to catch. A repair that removed both would close the false
    // positive by destroying the evidence.
    assert.ok(
      entry.excerpt.includes('[[nowhere]]'),
      `the excerpt swallowed an undegraded wikilink, so a producer regression now reaches ` +
        `dist/ with nothing left for the residue scan to find: ${JSON.stringify(entry.excerpt)}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * An unreadable fragment is a finding, not a silent skip.
 *
 * The failure this closes is the one the whole ticket is about: "I looked and it
 * was clean" and "I could not look" arriving as the same output. A `try`/`catch`
 * around the inflate that `continue`d would turn every fragment Pagefind's
 * format changes under into an unscanned file reporting nothing — which is
 * precisely the state the blanket exclusion was in, reintroduced as an
 * accident rather than as a decision.
 *
 * Asserted over a hand-written directory rather than a build, because a real
 * Pagefind never emits a corrupt fragment and the point is what happens when one
 * arrives anyway.
 *
 * **Mutation watched fail:** replacing the `report(...)` in the catch with a
 * bare `continue` turns this red — the scan returns no findings at all for a
 * file it could not read.
 */
test('a fragment that cannot be inflated is reported rather than skipped', () => {
  scratch('tk29-corrupt-', (directory) => {
    writeFileSync(join(directory, 'index.html'), '<h1>home</h1>', 'utf8');
    mkdirSync(join(directory, 'pagefind', 'fragment'), { recursive: true });
    // Gzip magic bytes and nothing valid after them, which is what a truncated
    // write leaves behind.
    writeFileSync(join(directory, 'pagefind', 'fragment', 'en_x.pf_fragment'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some((finding) => finding.includes('could not be inflated')),
      `an unreadable fragment produced no finding, so it shipped unscanned: ${findings.join('; ')}`,
    );
    // The public half names the surface rather than the file, for the reason the
    // gate above pins: a fragment's filename is a digest of its own text.
    assert.ok(
      !findings.some((finding) => finding.includes('.pf_fragment')),
      `the printable finding named a fragment file: ${findings.join('; ')}`,
    );
  });
});

/**
 * A `.pf_fragment` outside the bundle is not treated as one.
 *
 * The fragment branch skips the fail-closed classifier — a fragment has no
 * business being in `TEXT_EXTENSIONS` — so the test for "is this a fragment"
 * must be the bundle *and* the extension, never the extension alone. A user with
 * a file of that name in their notes, or a future build step emitting one
 * elsewhere, would otherwise be exempted from the unclassified-file rule that is
 * property 1 of `scan-residue.ts`'s own header, and then reported under a
 * location naming Pagefind — sending the reader somewhere the file is not.
 *
 * **Mutation watched fail:** `const isFragment = extension ===
 * FRAGMENT_EXTENSION` — the extension alone, which is how this was first
 * written — turns this red: the stray file is silently accepted and no
 * `unscanned` finding is produced.
 */
test('a fragment-named file outside the search index fails closed', () => {
  scratch('tk29-stray-', (directory) => {
    writeFileSync(join(directory, 'index.html'), '<h1>home</h1>', 'utf8');
    mkdirSync(join(directory, 'assets'), { recursive: true });
    writeFileSync(join(directory, 'assets', 'note.pf_fragment'), 'ordinary bytes', 'utf8');

    const { findings } = scanResidue(directory);
    assert.ok(
      findings.some((finding) => finding.includes('unscanned') && finding.includes('assets')),
      `a stray .pf_fragment did not fail the scan by name: ${findings.join('; ')}`,
    );
    // And it is not described as part of the search index, which is the half a
    // reader acts on.
    assert.ok(
      !findings.some((finding) => finding.includes('the search index')),
      `a file outside the bundle was reported as the search index: ${findings.join('; ')}`,
    );
  });
});

/**
 * `discovered === published + dropped`, over a corpus exercising every reason.
 *
 * The report's central claim is that its three counts are a *partition* rather
 * than three independently maintained numbers, and the way that claim fails is a
 * reason that forgets to increment — which is invisible on any corpus not
 * carrying that reason. So this builds one corpus that triggers all six at once
 * and checks the arithmetic against the rows, not against a literal.
 *
 * `tests/discovery.test.ts` asserts each reason's row in isolation and
 * `tests/disclosure.test.ts` checks the arithmetic on a three-file corpus
 * carrying three reasons. Neither would notice a seventh reason landing in
 * `dropped` without reaching `counts.dropped`.
 *
 * **Mutations watched fail:** dropping `repository-readme` from the corpus makes
 * the reason-set assertion red without touching the arithmetic — which is the
 * point, since it shows the two halves measure different things.
 */
test('the report’s counts partition every discovered file, whatever dropped it', () => {
  scratch('tk29-partition-', (directory) => {
    writeFileSync(join(directory, '.git'), 'not a gitdir\n', 'utf8');
    const state = join(directory, 'state');
    mkdirSync(state, { recursive: true });
    const notes = join(directory, 'notes');
    corpusWithEveryDropReason(notes);

    // No git directory here on purpose: this is also the only gate over the
    // state-directory branch end to end, and both properties want the same run.
    const run = build(directory, ['--content', 'notes', '--out', 'out'], {
      LOCALAPPDATA: state,
      XDG_STATE_HOME: state,
    });
    assert.equal(run.status, 0, `the fixture did not build:\n${run.output}`);

    const keys = readdirSync(join(state, 'publish-report'));
    assert.deepEqual(keys.length, 1, `expected one state key, got ${keys.join(', ')}`);
    const report = JSON.parse(
      readFileSync(join(state, 'publish-report', keys[0]!, 'content-report.json'), 'utf8'),
    ) as {
      status: string;
      counts: { discovered: number; published: number; dropped: number };
      dropped: { path: string; reason: string }[];
    };

    assert.equal(report.status, 'complete');
    assert.equal(
      report.counts.discovered,
      report.counts.published + report.counts.dropped,
      `the counts do not partition: ${JSON.stringify(report.counts)}`,
    );
    // And the rows agree with the count, which is the half that catches a reason
    // incrementing the counter without recording a row.
    assert.equal(
      report.dropped.length,
      report.counts.dropped,
      'the dropped rows and the dropped count disagree, so one of them is derived from the other ' +
        'rather than both from the walk',
    );

    // Every reason the type declares, seen in one run. A reason that stops
    // firing is a file silently published, which is the direction that matters.
    assert.deepEqual(
      [...new Set(report.dropped.map((row) => row.reason))].sort(),
      [
        'empty-slug',
        'excluded-by-frontmatter',
        'excluded-by-pattern',
        'not-markdown',
        'repository-readme',
        'slug-collision',
      ],
      'the corpus no longer exercises every drop reason, so the partition is checked over a subset',
    );

    // Non-vacuity: something was actually published, or a corpus that dropped
    // everything would satisfy the arithmetic with `published` at zero.
    assert.ok(report.counts.published > 0, 'nothing was published, so the partition is trivial');
  });
}, 180_000);

/**
 * The no-git fallback writes outside the invocation directory, and says so
 * without naming a path.
 *
 * Two properties in one run, because they are two halves of one decision.
 * `write-report.ts` chooses a user state directory when git cannot answer,
 * precisely so that a later `git init && git add -A` cannot reach a report an
 * earlier run wrote — and the pointer line for that branch is a fixed literal,
 * because the path it would otherwise name is the user's own home directory.
 *
 * Neither half was gated end to end before. `tests/disclosure.test.ts` exercises
 * the git branch throughout and asserts the *other* pointer spelling; nothing
 * built a corpus with no repository and looked at where the report landed.
 *
 * **Mutation watched fail:** replacing `stateDirectory()` with the invocation
 * directory turns the second assertion red, with the report found under the
 * user's own tree.
 */
test('with no repository, the report lands outside the invocation directory', () => {
  scratch('tk29-nogit-', (directory) => {
    writeFileSync(join(directory, '.git'), 'not a gitdir\n', 'utf8');
    const state = join(directory, 'state');
    mkdirSync(state, { recursive: true });
    // A real stale fallback report, so this end-to-end gate proves the binary
    // reaches retention rather than only the unit helper doing so.
    const old = new Date(Date.now() - STATE_REPORT_MAX_AGE_MS - 60_000);
    for (const key of ['0000000000000001', '0000000000000002']) {
      const expired = join(state, 'publish-report', key);
      const expiredReport = join(expired, 'content-report.json');
      mkdirSync(expired, { recursive: true });
      writeFileSync(expiredReport, '{}\n', 'utf8');
      utimesSync(expiredReport, old, old);
      utimesSync(expired, old, old);
    }
    const notes = join(directory, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'alpha.md'), '# Alpha\n\nprose.\n', 'utf8');

    const run = build(directory, ['--content', 'notes', '--out', 'out'], {
      LOCALAPPDATA: state,
      XDG_STATE_HOME: state,
    });
    assert.equal(run.status, 0, `the fixture did not build:\n${run.output}`);
    for (const key of ['0000000000000001', '0000000000000002']) {
      assert.ok(
        !existsSync(join(state, 'publish-report', key)),
        `the binary left expired fallback report ${key} in state`,
      );
    }

    // The pointer is the fallback spelling, and it names no path.
    assert.match(
      run.output,
      /report: no git directory here; written under the user state directory/,
      `the no-git run did not print the fallback pointer:\n${run.output}`,
    );
    assert.ok(!run.output.includes(state), `the stream named the state directory:\n${run.output}`);
    assert.ok(!run.output.includes(directory), `the stream named the invocation directory:\n${run.output}`);

    // The report exists, at exactly one place, and that place is not under the
    // directory the user ran the command in. Walking rather than asking, for the
    // reason `tests/disclosure.test.ts` gives about its own equivalent: a
    // "convenience copy" satisfies every existence check.
    const inState = filesUnder(state).filter((file) => file.endsWith('content-report.json'));
    assert.equal(inState.length, 1, `expected one report under the state directory, got ${inState.length}`);
    assert.deepEqual(
      filesUnder(notes)
        .concat(filesUnder(join(directory, 'out')))
        .filter((file) => file.endsWith('content-report.json'))
        .map((file) => relative(directory, file)),
      [],
      'a report was written into the corpus or the output, where `git add -A` would reach it after ' +
        'a later `git init`',
    );

    // Non-vacuity: the report at that path is the real one, not an empty file.
    const report = JSON.parse(readFileSync(inState[0]!, 'utf8')) as { counts: { published: number } };
    assert.equal(report.counts.published, 1, 'the report under the state directory describes no build');
  });
}, 180_000);
