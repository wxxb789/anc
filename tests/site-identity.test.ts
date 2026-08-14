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

import { CONFIG_DIRECTORY_VARIABLE, CONFIG_FILENAME } from '../scripts/load-config.ts';
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
 * `PUBLISH_CONFIG_DIR` is passed explicitly rather than relied upon, and the
 * reason is a real gap rather than a convenience: `bin/thoughtscape-publish.mjs`
 * loads the config for its *exclusions* but does not set this variable, so a
 * configured `title` and `origin` reach `astro.config.mjs` only when the caller
 * sets it. Measured — without it, a `publish.config.yaml` naming a title builds
 * a site titled `Notes`, silently. Setting it here keeps the configured-value
 * gate honest about what it is testing: the wiring from the variable onward,
 * which is this ticket's, and not the last inch at the call site, which is not.
 */
function build(directory: string, notes: string, environment: Record<string, string> = {}): string {
  // Named after the corpus rather than a fixed `out`, so two builds in one
  // scratch directory do not overwrite each other — the positive-control gate
  // builds twice and would otherwise measure the second build's output twice.
  const out = `${notes}-out`;
  const probe = spawnSync(
    process.execPath,
    [join(ROOT, 'bin/thoughtscape-publish.mjs'), 'build', '--content', notes, '--out', out],
    { cwd: directory, encoding: 'utf8', env: { ...process.env, ...environment } },
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
 * A configured title and origin reach every surface that once held a literal.
 *
 * The complement of the gate above: proving the old identity is gone says
 * nothing about whether the user's own arrives. Both are needed, and this one
 * is what would catch a build that answered the first by shipping no identity
 * at all.
 *
 * The surfaces are named individually rather than by searching `dist/` for the
 * value, because "the title appears somewhere" is satisfied by one page while
 * the feed and the sitemap still carry a default. Each row below was a
 * hardcoded literal before this ticket.
 *
 * **Mutation watched fail:** dropping `process.env['PUBLISH_SITE_TITLE']` from
 * `astro.config.mjs` turned this red on the four title rows, which are then all
 * `Notes`; changing `site:` to ignore `config.origin` turned it red on the
 * four origin rows.
 */
test('a configured title and origin reach the title, feed, sitemap, and robots.txt', () => {
  scratch('tk31-configured-', (directory) => {
    const notes = join(directory, 'notes');
    const title = 'Foundry Field Notes';
    const origin = 'https://notes.example.org/';
    writeForeignCorpus(notes, `title: ${JSON.stringify(title)}\norigin: ${JSON.stringify(origin)}\n`);
    const out = build(directory, notes, { [CONFIG_DIRECTORY_VARIABLE]: notes });

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
 * The shipped social card carries no name.
 *
 * **This is the leak TK-24 found by looking rather than by reading, and it is
 * the one a text search cannot find.** `public/og-card.png` is in the tarball's
 * `files`, every packaged build serves it as `og:image`, and until this ticket
 * it showed the wordmark `thoughtscape` over "A reviewed public projection from
 * a private knowledge garden". No grep over `dist/` sees that: the name is
 * *pixels*. The gate above would have passed on it for ever.
 *
 * So this asserts over the generator instead, which is the one place the card's
 * content is legible to a machine. Two properties, and the second is the one
 * that matters longest:
 *
 * 1. The card's markup carries **no text node** — no `<h1>`, no `<p>`. A card
 *    with no words cannot name anybody.
 * 2. It imports **neither** `SITE_NAME` nor the locale table. This is stronger
 *    than it looks and is not redundant with the first: since TK-31, `SITE_NAME`
 *    resolves from whatever configuration the person *running the script* has on
 *    disk, so a contributor with their own `publish.config.yaml` would silently
 *    commit their site's name as the default card every user then ships. The
 *    import is the mechanism; forbidding it forecloses the whole class.
 *
 * What this deliberately does **not** assert is that the PNG matches the script.
 * The image is committed and hand-regenerated, so proving they agree means
 * rasterizing in a gate — Playwright, ~2 s, and a devDependency CI installs but
 * a consumer does not. Named rather than half-built: the honest limit is that
 * this holds the *source* of the card, and a hand-edited PNG would pass it.
 *
 * **Three mutations watched fail, and each was caught by a different half —
 * which is what says the three are not one assertion written out three times.**
 * Restoring `<h1>` with the site name in it fired the text-node half; moving the
 * same interpolation into a CSS comment, where no element exists, fired the
 * interpolation half; leaving only the bare `import` fired the import half.
 * The second is the case worth naming: a name can enter the card without any
 * element being added, so a gate that looked for `<h1>` alone would have passed
 * on it.
 */
test('the shipped social card names nobody, and cannot come to name somebody', () => {
  const source = readFileSync(join(ROOT, 'scripts/render-og-card.ts'), 'utf8');

  // The template literal the card is built from, not the whole file: this
  // module's own documentation legitimately discusses the wordmark it removed,
  // and a scan over prose would flag the explanation as the defect.
  const card = /const CARD = `([\s\S]*?)`;/.exec(source)?.[1];
  assert.ok(card, 'scripts/render-og-card.ts declares no CARD template for this gate to read');

  for (const element of ['h1', 'h2', 'p', 'span', 'title']) {
    assert.ok(
      !new RegExp(`<${element}[\\s>]`).test(card),
      `the social card renders a <${element}>, so it carries text — and a shipped card is served ` +
        "as og:image by every build, which puts whatever it says on every user's site",
    );
  }

  // Interpolation of any kind: `${...}` in the template is how a name gets in
  // without an element being added, and the two dimensions the card is built
  // from are the only legitimate ones.
  const interpolations = [...card.matchAll(/\$\{([^}]*)\}/g)].map(([, expression]) => expression!.trim());
  assert.deepEqual(
    interpolations.filter((expression) => expression !== 'WIDTH_PX' && expression !== 'HEIGHT_PX'),
    [],
    'the social card interpolates something other than its own dimensions',
  );

  for (const forbidden of ['site.ts', 'translations.ts']) {
    assert.ok(
      !source.includes(forbidden),
      `scripts/render-og-card.ts imports ${forbidden}. The card is committed and regenerated by ` +
        "hand, so reading the site name here bakes whichever config the author had on disk into " +
        'the default card every user ships',
    );
  }

  // And the card exists, because the metadata gate points `og:image` at it
  // unconditionally: a build that shipped no card would 404 its own social image
  // on every route.
  assert.ok(existsSync(join(ROOT, 'public/og-card.png')), 'the shipped social card is missing');
});

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
