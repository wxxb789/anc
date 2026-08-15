/**
 * Whose site a build produces.
 *
 * **The property is one sentence: a stranger's build carries nobody's identity
 * but their own.** This tool is not one person's website generator — any user
 * runs it on their own notes repository, which is plan decision D2 — and the
 * way that claim fails is silent. A site built with somebody else's name in the
 * browser tab, their origin in every canonical link, and their social card on
 * every share renders perfectly. Nothing about it looks wrong. It is simply
 * about the wrong person, and only a reader who already knew would notice.
 *
 * So the gates here are built from measurement rather than from reading, which
 * is how TK-24 found the social card: it built a package, looked at what came
 * out, and found a leak the manifest did not describe. Every assertion below
 * runs `bin/thoughtscape-publish.mjs` over a corpus that has nothing to do with
 * this repository and reads what it produced.
 *
 * ## Both halves, always
 *
 * An absence assertion is worth exactly as much as the evidence that it could
 * have failed. `assert(token not in dist)` passes identically when the token
 * was never in play — the "0 because none" versus "0 because I never looked"
 * ambiguity this repository has been bitten by more than once. So no absence is
 * claimed here without a companion measurement that the scan making the claim
 * can see what it is looking for, or that the configured value did arrive.
 *
 * **Getting that companion right is harder than it looks, and the first attempt
 * got it wrong.** It asserted the token appears somewhere under `src/` — which
 * it does, in remark plugin names and doc comments, none of which can reach
 * `dist/`. The guard was satisfied by a population that had no path to the
 * output at all, so it would have stayed green with every real identity
 * constant deleted. A positive *control* — plant the name, build, confirm the
 * same scan finds it — measures the instrument instead of a coincidence.
 *
 * ## Why over the binary rather than over the modules
 *
 * The identity a user gets is a property of the command they type. Every
 * constant read in-process here would be this repository's, evaluated with this
 * repository's working directory, which is the one configuration that cannot
 * reproduce a stranger's. The two leaks TK-24 measured — the shipped social
 * card and the `/about/` page — were both invisible to a module-level test and
 * obvious in a built site.
 */

import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { CONFIG_FILENAME } from '../scripts/load-config.ts';
import { DEFAULT_SITE_TITLE, SITE_TITLE_VARIABLE } from '../src/lib/site.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * This project's own name, read from the package manifest rather than spelled.
 *
 * Spelling it would make this file the very thing it forbids: a place the name
 * is written down, which a rename would leave stale while every gate here went
 * on passing against a token nothing uses. The manifest is the one place a
 * package's identity is unambiguous.
 *
 * The scope is `@thoughtscape/publish`, so the token is the scope's own name.
 */
const OWN_NAME = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string }
).name.replace(/^@/, '').split('/')[0]!;

/**
 * The host an unconfigured build falls back to, read out of `astro.config.mjs`.
 *
 * Never spelled here. `tests/metadata.test.ts` fails on any file under `src/`,
 * `scripts/`, `tests/`, or `public/` that writes this host literally — the gate
 * that keeps the origin to exactly one home — so a copy in this file would break
 * it, and would additionally stop tracking the real default the moment it moved.
 */
const DEFAULT_HOST = (() => {
  const origin = /DEFAULT_ORIGIN = '([^']+)'/.exec(readFileSync(join(ROOT, 'astro.config.mjs'), 'utf8'))?.[1];
  assert.ok(origin, 'astro.config.mjs declares no default origin for these gates to read');
  return new URL(origin).hostname;
})();

/** A scratch directory, removed however the body ends. */
function scratch<T>(prefix: string, body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every file under a directory, recursively. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(root, entry.name)) : [join(root, entry.name)],
  );
}

/**
 * A corpus that is nobody's: two notes, one linking to the other.
 *
 * Deliberately not this repository's fixture. The fixture is *ours*, and a gate
 * asserting "our name is absent" over our own corpus is measuring a corpus that
 * had every reason to be clean. Two files with neutral text is what a stranger
 * actually has on their first run.
 */
function writeForeignCorpus(notes: string, config?: string): void {
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'alpha.md'), '# Alpha\n\nThe first note, which links to [[beta]].\n', 'utf8');
  writeFileSync(join(notes, 'beta.md'), '# Beta\n\nThe second note.\n', 'utf8');
  if (config !== undefined) writeFileSync(join(notes, CONFIG_FILENAME), config, 'utf8');
}

/**
 * Build a corpus with the shipped command, and return where the site landed.
 *
 * **No environment is passed, and that is the point.** The property every gate
 * here measures is what a *user* gets from the command they type, so anything
 * this helper sets is help the user does not have. An earlier version passed
 * `PUBLISH_CONFIG_DIR` because the CLI did not set it — the configured-value
 * gate was then green while a real `publish.config.yaml` was silently ignored
 * end to end, which is the exact failure shape that makes a wiring gap survive a
 * passing suite.
 */
function build(directory: string, notes: string): string {
  // Named after the corpus rather than a fixed `out`, so two builds in one
  // scratch directory do not overwrite each other — the positive-control gate
  // builds twice and would otherwise measure the second build's output twice.
  const out = `${notes}-out`;
  const probe = spawnSync(
    process.execPath,
    [join(ROOT, 'bin/thoughtscape-publish.mjs'), 'build', '--content', notes, '--out', out],
    { cwd: directory, encoding: 'utf8' },
  );
  assert.equal(probe.status, 0, `the build failed:\n${probe.stdout}\n${probe.stderr}`);
  return out;
}

/**
 * The site a user who has configured nothing gets carries nobody's name.
 *
 * **This is TK-31's headline acceptance criterion**, and it is asserted in both
 * directions because either alone is worthless: the name is absent from every
 * byte a stranger's build produced, *and* the scan that says so is a scan that
 * finds this name when a build really does carry it. The second half is a
 * positive control rather than a source-tree search — see the comment at it for
 * why the search version was measuring the wrong population.
 *
 * **Every file, not the pages.** The measured leak surface before this ticket
 * was 126 occurrences across 15 files, and only nine of them were `.html`: the
 * rest were `robots.txt`, `rss.xml`, `sitemap.xml`, and two JavaScript bundles
 * carrying the `localStorage` prefix. A gate reading `dist/**\/*.html` would
 * have called four of those clean.
 *
 * **Mutations watched fail:** restoring `SITE_NAME = 'thoughtscape'` turned this
 * red with 11 files; restoring the `thoughtscape:` storage prefix turned it red
 * with the two bundles alone, which is the case a page-only scan misses.
 */
test('a build of a foreign corpus with no configuration carries no occurrence of this project’s name', () => {
  scratch('tk31-anon-', (directory) => {
    const notes = join(directory, 'notes');
    writeForeignCorpus(notes);
    const out = build(directory, notes);

    // Read as bytes and lowercased, so a token escapes by neither case nor
    // encoding: `dist/` carries minified JavaScript, XML, and JSON as well as
    // HTML, and each spells its strings differently.
    const carriers = (root: string): string[] =>
      filesUnder(root)
        .filter((file) => readFileSync(file, 'latin1').toLowerCase().includes(OWN_NAME))
        .map((file) => file.slice(root.length + 1).replaceAll('\\', '/'));

    assert.deepEqual(
      carriers(out),
      [],
      `a stranger's unconfigured build carries this project's name. Every occurrence is a surface ` +
        'a reader or a crawler meets, and the site renders correctly while being wrong about ' +
        `whose it is:\n  ${carriers(out).join('\n  ')}`,
    );

    // **The positive control, and it is the half that makes the assertion above
    // mean something.** An absence is worth exactly as much as the evidence that
    // it could have failed, and the first version of this guard got that wrong
    // in an instructive way: it asserted the token appears somewhere under
    // `src/` or `scripts/`. It does — in eight remark plugin names inside
    // `markdown.ts`, in doc comments, in a comment about the prefix this ticket
    // *removed* — and not one of those has a path to `dist/`. So the guard was
    // satisfied by files that could never have leaked, and would have stayed
    // green with every real identity constant deleted.
    //
    // What is checked instead is the search itself: plant the token in the
    // corpus, build, and confirm the same scan finds it. That exercises the
    // thing the assertion above depends on — that a build carrying this name
    // *would* be caught — rather than a population that happens to share a
    // spelling with it.
    const planted = join(directory, 'planted');
    writeForeignCorpus(planted);
    writeFileSync(join(planted, 'named.md'), `# Named\n\nBuilt with ${OWN_NAME}.\n`, 'utf8');
    assert.ok(
      carriers(build(directory, planted)).length > 0,
      `a corpus that names "${OWN_NAME}" in a note body produced a site the scan found it in ` +
        'nowhere, so the scan cannot see this token and the absence above proves nothing',
    );
  });
}, 300_000);

/**
 * A configured title and origin reach every surface that once held a literal —
 * **through the command a user types, with nothing else set.**
 *
 * The complement of the gate above: proving the old identity is gone says
 * nothing about whether the user's own arrives. Both are needed, and this one is
 * what would catch a build that answered the first by shipping no identity at
 * all.
 *
 * **This is an end-to-end gate over the binary, and it has to be.** The unit
 * beneath it — `configForBuild()` reading `PUBLISH_CONFIG_DIR` — was correct and
 * fully tested for the whole interval in which a real configured build ignored
 * both values, because nothing called it: the CLI never set the variable, and
 * its `process.cwd()` fallback could not rescue it either, since the CLI
 * `chdir`s to the package root before Astro starts. Measured at the time: a
 * `publish.config.yaml` naming `title` and `origin` produced a site carrying
 * neither, and the build reported success. **A passing unit test for an unreached
 * unit is the shape this gate exists against**, which is why it runs the shipped
 * command and reads files off disk rather than calling anything.
 *
 * The surfaces are named individually rather than by searching `dist/` for the
 * value, because "the title appears somewhere" is satisfied by one page while
 * the feed and the sitemap still carry a default. Each row below was a hardcoded
 * literal before this ticket.
 *
 * **Mutations watched fail:** deleting
 * `process.env[CONFIG_DIRECTORY_VARIABLE] = contentDirectory` from
 * `bin/thoughtscape-publish.mjs` turned this red on **every** row, title and
 * origin alike, with the placeholder half naming the leaked host; dropping
 * `process.env['PUBLISH_SITE_TITLE']` from `astro.config.mjs` turned it red on
 * the title rows alone; changing `site:` to ignore `config.origin` turned it red
 * on the origin rows alone. Three distinct mutations, three distinct signatures.
 */
test('a configured title and origin reach the title, feed, sitemap, and robots.txt', () => {
  scratch('tk31-configured-', (directory) => {
    const notes = join(directory, 'notes');
    const title = 'Foundry Field Notes';
    const origin = 'https://notes.example.org/';
    writeForeignCorpus(notes, `title: ${JSON.stringify(title)}\norigin: ${JSON.stringify(origin)}\n`);
    const out = build(directory, notes);

    const read = (relative: string): string => {
      const file = join(out, relative);
      assert.ok(existsSync(file), `the build produced no ${relative}`);
      return readFileSync(file, 'utf8');
    };

    const home = read('index.html');
    assert.match(home, new RegExp(`<title>${title}</title>`), 'the home page title is not the configured one');
    assert.match(home, /<meta property="og:site_name" content="Foundry Field Notes">/, home.slice(0, 400));
    assert.match(
      read('notes/alpha/index.html'),
      new RegExp(`<title>Alpha · ${title}</title>`),
      'a note page does not carry the configured site name as its title suffix',
    );

    // The origin, on each of the four artifacts that state it absolutely. These
    // are the ones a crawler and a feed reader consume, where a wrong value is
    // not a cosmetic defect but a link to somebody else's site.
    assert.match(home, new RegExp(`<link rel="canonical" href="${origin}">`), 'the canonical link is wrong');
    assert.match(read('robots.txt'), new RegExp(`Sitemap: ${origin}sitemap\\.xml`), 'robots.txt is wrong');
    assert.match(read('sitemap.xml'), new RegExp(`<loc>${origin}</loc>`), 'the sitemap is wrong');

    const feed = read('rss.xml');
    assert.match(feed, new RegExp(`<id>${origin}</id>`), 'the feed id is wrong');
    assert.match(feed, new RegExp(`<title>${title}</title>`), 'the feed title is not the configured one');

    // **The other half: the defaults are gone, not merely joined.** Every
    // assertion above is a *presence* check, and presence is satisfied by a
    // build that emits the configured value somewhere while still carrying the
    // package's own placeholder elsewhere — which is precisely what a partially
    // wired config produces. The measured failure had `<title>Notes</title>`
    // beside `https://thoughtscape.invalid`, and a presence-only gate for a
    // *different* surface would have passed on it.
    //
    // Both defaults, because they arrive through different mechanisms and can
    // fail independently: the title crosses on `PUBLISH_SITE_TITLE`, the origin
    // through `site:`.
    //
    // `DEFAULT_SITE_TITLE` is deliberately **not** in this list, and the reason
    // is worth stating rather than leaving to be rediscovered: it is `Notes`,
    // which is also the English nav label and the home page's section heading.
    // A correct configured build renders both, so forbidding the string would
    // fail on working output — a gate that cannot distinguish the default site
    // name from an ordinary English word is measuring the word. The `<title>`
    // and feed-title rows above already pin that surface positively, which is
    // where a leaked default title would actually show.
    const defaults = [OWN_NAME, DEFAULT_HOST];
    const residue = filesUnder(out).flatMap((file) => {
      const text = readFileSync(file, 'latin1');
      return defaults
        .filter((value) => text.includes(value))
        .map((value) => `${file.slice(out.length + 1).replaceAll('\\', '/')} carries ${JSON.stringify(value)}`);
    });
    assert.deepEqual(
      residue,
      [],
      `a configured build still carries this package's own defaults, so the configuration is only ` +
        `partly wired:\n  ${residue.join('\n  ')}`,
    );
  });
}, 180_000);

/**
 * The unconfigured default is legible rather than empty.
 *
 * The failure this catches is the lazy answer to the gate above: removing the
 * identity instead of replacing it. A site whose `<title>` is blank, or whose
 * Atom `atom:title` is an empty required element, is "carrying nobody's name"
 * and is also broken — and every gate that searches for a *forbidden* string
 * passes on it.
 *
 * **Mutation watched fail:** setting `DEFAULT_SITE_TITLE` to `''` turned this
 * red. Both halves independently — the module assertion first, and, with that
 * line removed to check it was not carrying the gate alone, the built `<title>`
 * row as well. That second measurement is the one worth having: it proves the
 * property is held over what a reader actually receives rather than over a
 * constant this file could read without ever building anything.
 */
test('an unconfigured build still names itself, rather than shipping an empty title', () => {
  assert.notEqual(DEFAULT_SITE_TITLE.trim(), '', 'the default site title is empty');

  scratch('tk31-default-', (directory) => {
    const notes = join(directory, 'notes');
    writeForeignCorpus(notes);
    const out = build(directory, notes);

    const home = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(
      home,
      new RegExp(`<title>${DEFAULT_SITE_TITLE}</title>`),
      'the unconfigured home page does not carry the default title',
    );

    // The feed's `atom:title` has cardinality exactly 1, so an empty one is a
    // document no conforming reader accepts — the shape a "remove the name"
    // fix produces while satisfying every absence gate.
    assert.match(
      readFileSync(join(out, 'rss.xml'), 'utf8'),
      new RegExp(`<title>${DEFAULT_SITE_TITLE}</title>`),
      'the feed carries no title, or not the default one',
    );
  });
}, 180_000);

/**
 * No social card ships, and no page claims one.
 *
 * **This is the leak TK-24 found by looking rather than by reading, and it was
 * the one a text search could never find.** `public/og-card.png` sat in the
 * tarball's `files`, every packaged build served it as `og:image`, and it showed
 * the wordmark `thoughtscape` over "A reviewed public projection from a private
 * knowledge garden". No grep over `dist/` sees that — the name is *pixels* — so
 * the headline gate above would have passed on it for ever.
 *
 * **The fix is deletion rather than a nameless replacement**, and the
 * intermediate step is worth recording because it looked like the answer. A card
 * carrying only the mark passes every text search and is still an artefact
 * belonging to *this package* appearing on a stranger's site: every site built
 * with the tool would serve one identical meaningless image. That is the same
 * defect in a different costume. Plan §4.2 chose "no card unless the user
 * supplies one", and the argument TK-24 used to keep the card — a broken card is
 * worse than a bland one — is sound against a *dangling* `og:image` and says
 * nothing against an *absent* one, which every consumer already handles by
 * falling back to the title and description.
 *
 * Three assertions, each closing a different way the card could come back:
 *
 * 1. **Nothing ships.** No image file in the package's `public/`, which is what
 *    `files` copies into the tarball verbatim.
 * 2. **No page claims one.** A build emits none of `og:image`, `og:image:alt`,
 *    or `twitter:card` — read off a real foreign build rather than off the
 *    component, because the component is a template and the output is the thing
 *    a consumer parses.
 * 3. **The generator is gone.** `scripts/render-og-card.ts` read `SITE_NAME` to
 *    render the wordmark, and after this ticket that constant resolves from
 *    whatever configuration the person *running the script* has on disk — so
 *    keeping it would mean a contributor could silently commit their own site's
 *    name as the default card for every user. Deleting the script forecloses
 *    that whole class rather than gating it.
 *
 * **Mutations watched fail:** restoring `SOCIAL_CARD_PATH = '/og-card.png'`
 * turned assertion 2 red on every page; putting any `.png` back under `public/`
 * turned assertion 1 red; restoring the generator turned assertion 3 red.
 */
test('no social card ships, and no page claims one', () => {
  const shipped = readdirSync(join(ROOT, 'public')).filter((name) => /\.(png|jpe?g|webp|avif)$/i.test(name));
  assert.deepEqual(
    shipped,
    [],
    `these images ship inside the package and would appear on every site built with it:\n  ${shipped.join('\n  ')}`,
  );

  assert.ok(
    !existsSync(join(ROOT, 'scripts/render-og-card.ts')),
    'the card generator is back, and it renders the configured site name into a committed image — ' +
      "so whoever runs it bakes their own site's name into every user's default card",
  );

  scratch('tk31-card-', (directory) => {
    const notes = join(directory, 'notes');
    writeForeignCorpus(notes);
    const out = build(directory, notes);

    const claimed = filesUnder(out)
      .filter((file) => file.endsWith('.html'))
      .flatMap((file) => {
        const html = readFileSync(file, 'utf8');
        return ['og:image', 'twitter:card']
          .filter((tag) => html.includes(tag))
          .map((tag) => `${file.slice(out.length + 1).replaceAll('\\', '/')} declares ${tag}`);
      });

    assert.deepEqual(
      claimed,
      [],
      `pages declare a social card while none is configured, so each points at nothing:\n  ${claimed.join('\n  ')}`,
    );
  });
}, 180_000);

/**
 * The seam's two spellings agree.
 *
 * `src/lib/site.ts` reads the configured title from an environment variable and
 * `astro.config.mjs` writes it, and the config spells the name as a literal
 * rather than importing the constant — deliberately, because importing it would
 * evaluate that module before the variable is set and give one process two
 * module instances disagreeing about the site's name. The cost is a second copy,
 * and this is what stops a rename applying to one half.
 *
 * The same shape `tests/design-tokens.test.ts` uses for `theme-init.js`, which
 * cannot import its keys either, and for the same class of reason.
 *
 * **Mutation watched fail:** renaming the variable in `astro.config.mjs` alone
 * turned this red; it also turns the configured-title gate above red, which is
 * the useful redundancy — this one names the cause.
 */
test('the config writes the site-title variable the site module reads', () => {
  const config = readFileSync(join(ROOT, 'astro.config.mjs'), 'utf8');
  assert.ok(
    config.includes(`process.env['${SITE_TITLE_VARIABLE}']`),
    `astro.config.mjs does not write process.env['${SITE_TITLE_VARIABLE}'], which src/lib/site.ts ` +
      'reads the configured site name from — so a configured title reaches nothing',
  );
});
