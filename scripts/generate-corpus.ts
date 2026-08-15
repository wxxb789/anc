/**
 * A synthetic notes repository of any size, deterministic from a seed.
 *
 * This exists because every performance claim in this project was made against
 * a 32-note fixture. A benchmark needs a corpus large enough to be evidence, and
 * a corpus of 10,000 identical notes is evidence of nothing: it collapses link
 * resolution to one bucket, gives Pagefind one document repeated, and hides
 * every cost that scales with *variety* rather than with count.
 *
 * So the shape below is chosen for what it stresses, and each choice is stated
 * where it is made. What matters most:
 *
 * - **The link graph is skewed, not uniform.** Most notes link a few others; a
 *   small number are hubs linking dozens. A uniform graph makes every backlink
 *   list the same length, and the one thing a backlink derivation can be
 *   quadratic in is a hub's in-degree.
 * - **Basenames collide across directories.** Link resolution buckets by
 *   lowercase basename, so a corpus of unique names never leaves tier 1 and
 *   never measures tiers 2 through 5. See {@link BASENAME_POOL}.
 * - **All five link forms appear**, because they take different paths through
 *   `resolveLink` — a wikilink is not percent-decoded, a rooted link can end
 *   resolution at tier 4, and a relative link rewrites its path before tiers 3
 *   and 5 see it.
 * - **Some links deliberately do not resolve.** A corpus where every link works
 *   never exercises the degrade-to-text rewrite, which is the branch that
 *   allocates.
 *
 * ## Nothing here names this project or this repository
 *
 * The tool is not for one person, so a fixture that encodes this repository's
 * layout measures this repository rather than the product. The vocabulary below
 * is deliberately generic — weather, terrain, and materials — and the directory
 * names are the shapes a notes repository generally has rather than the ones
 * this one does. A corpus is written to a caller-supplied directory, never
 * inside the repository.
 *
 * ## Determinism
 *
 * One seeded generator drives every choice, and the same seed and count produce
 * byte-identical files. That is what makes two benchmark runs comparable: a
 * corpus that varied between runs would put its own variance into every
 * measurement taken over it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * A small, fast, seeded PRNG (mulberry32).
 *
 * `Math.random` is unseedable, so it cannot produce the same corpus twice, and
 * a benchmark over a corpus that changes per run measures the corpus as much as
 * the code. Twelve lines of arithmetic rather than a dependency: the statistical
 * quality needed here is "spreads out and repeats", which this clears easily and
 * which no property of the benchmark depends on beyond reproducibility.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Directory names a notes repository plausibly has.
 *
 * Depth matters to resolution rather than to taste: tier 2 joins a relative
 * link onto the source's directory and tier 5 prefers candidates inside the
 * source's subtree, so a flat corpus leaves both inert. The nested entries here
 * are what give those tiers something to prefer.
 */
const DIRECTORIES: readonly string[] = [
  '',
  'notes',
  'notes/daily',
  'notes/reference',
  'projects',
  'projects/archive',
  'reading',
  'reading/papers',
  'inbox',
];

/**
 * The word pool every generated name and body is built from.
 *
 * Generic on purpose — see this file's header. Short and repetitive is also what
 * a real search index sees: Pagefind's cost is dominated by the number of
 * *distinct* terms, and a corpus of random unique strings would make its index
 * enormous in a way no real corpus is.
 */
const WORDS: readonly string[] = [
  'quiet', 'harbor', 'rolling', 'field', 'still', 'water', 'copper', 'lantern',
  'winter', 'thicket', 'shallow', 'creek', 'northern', 'ridge', 'open', 'meadow',
  'grey', 'stone', 'brief', 'thaw', 'salt', 'marsh', 'low', 'cloud',
  'iron', 'gate', 'long', 'shadow', 'first', 'frost', 'pale', 'ember',
];

/**
 * Basenames deliberately reused across directories.
 *
 * `indexCorpus` keys on the lowercase basename, so a corpus of globally unique
 * filenames puts exactly one candidate in every bucket and every link resolves
 * at tier 1 — the cheapest path, and the one that proves least. These names are
 * the ones a real vault repeats in every folder, and each one that appears in
 * two directories forces a link naming it through tiers 2 to 5 and makes it an
 * `ambiguous` finding rather than a `resolved` one.
 */
const BASENAME_POOL: readonly string[] = ['index', 'notes', 'readme', 'log', 'summary'];

/** Non-Markdown files, which discovery counts and drops rather than reads. */
const ASSET_EXTENSIONS: readonly string[] = ['.png', '.pdf', '.txt', '.canvas', '.json'];

/** What one generated corpus contains, for a benchmark to report against. */
export interface GeneratedCorpus {
  /** Total files written, Markdown and otherwise. */
  files: number;
  /** Markdown files expected to publish. */
  published: number;
  /** Markdown files carrying `publish: false`. */
  withheld: number;
  /** Files with a non-Markdown extension. */
  assets: number;
  /** Total bytes written. */
  bytes: number;
}

export interface CorpusOptions {
  /** How many Markdown notes to write, withheld ones included. */
  notes: number;
  /** Seeds the generator; the same seed and count give identical bytes. */
  seed?: number;
}

/**
 * How many of a note's own words become links, by note rank.
 *
 * A power-law-ish skew rather than a constant: in a real vault a handful of
 * index notes link most of the corpus and the long tail links two or three
 * things. The two ends cost differently — a hub's out-edges become every
 * target's backlinks, so the hubs are what make backlink derivation expensive —
 * and a uniform graph measures neither end.
 */
function outDegreeFor(rank: number, total: number, random: () => number): number {
  // The first 1% of notes are hubs. `Math.max(1, …)` so a tiny corpus still has
  // one, which is what keeps a 100-note run comparable to a 10,000-note one
  // rather than differing in kind.
  const hubs = Math.max(1, Math.floor(total * 0.01));
  if (rank < hubs) return 20 + Math.floor(random() * 40);
  if (rank < total * 0.1) return 4 + Math.floor(random() * 6);
  return Math.floor(random() * 4);
}

/**
 * A note's body length in paragraphs, skewed the way real notes are.
 *
 * Most notes are short; a few are long. The long ones matter twice over: the
 * Markdown renderer's cost is per byte, and `STRING_LIMITS.markdown` caps a note
 * at 200,000 characters — so a corpus of uniformly short notes would never come
 * near a limit the contract actually enforces.
 */
function paragraphsFor(random: () => number): number {
  const roll = random();
  if (roll < 0.6) return 1 + Math.floor(random() * 3);
  if (roll < 0.95) return 4 + Math.floor(random() * 10);
  return 20 + Math.floor(random() * 40);
}

/** A sentence of pool words, capitalised. */
function sentence(random: () => number, words: number): string {
  const picked = Array.from({ length: words }, () => WORDS[Math.floor(random() * WORDS.length)]!);
  const text = picked.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * Every note's path, decided before any body is written.
 *
 * Two passes are forced rather than chosen: a note's links name *other notes*,
 * so the full path set has to exist before the first body can reference it.
 * That mirrors the pipeline itself, where link resolution runs after the whole
 * walk for the same reason.
 */
function planPaths(count: number, random: () => number): string[] {
  const paths: string[] = [];
  const taken = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    let directory = DIRECTORIES[Math.floor(random() * DIRECTORIES.length)]!;
    // One note in twelve takes a pooled basename, which is what puts more than
    // one candidate in a resolution bucket. The rest get a unique name, so the
    // corpus stays mostly unambiguous the way a real one is.
    const pooled = random() < 1 / 12;
    const stem = pooled
      ? BASENAME_POOL[Math.floor(random() * BASENAME_POOL.length)]!
      : `${WORDS[Math.floor(random() * WORDS.length)]}-${WORDS[Math.floor(random() * WORDS.length)]}-${index}`;

    // A pooled name is never placed at the corpus root, and this is a
    // measurement rather than a preference: a root-level `notes.md` slugifies to
    // `notes`, which is in `RESERVED_SLUGS`, and the contract refuses the whole
    // artifact over it. That is a real defect in the product — a two-note
    // repository containing `notes.md` does not build — but it is not a *scale*
    // defect, and a benchmark that trips it measures nothing at any size. It is
    // reported separately rather than worked around silently. Nesting is also
    // the more realistic placement: a repeated basename is a folder index.
    if (pooled && directory === '') directory = DIRECTORIES[1]!;

    let path = directory === '' ? `${stem}.md` : `${directory}/${stem}.md`;
    // A pooled name can collide inside one directory, and two files at one path
    // is one file. Disambiguating by index keeps the count exact while leaving
    // the *cross-directory* collisions this pool exists to create.
    if (taken.has(path)) path = path.replace(/\.md$/, `-${index}.md`);
    taken.add(path);
    paths.push(path);
  }
  return paths;
}

/** The relative path from one note's directory to another's, for tier 2. */
function relativePath(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let shared = 0;
  while (shared < fromParts.length && fromParts[shared] === toParts[shared]) shared += 1;
  const up = Array.from({ length: fromParts.length - shared }, () => '..');
  const down = toParts.slice(shared);
  const joined = [...up, ...down].join('/');
  // A path with no `../` prefix must still be written `./x` to be a *relative*
  // link — without the prefix `isExternal` never sees one and tier 2 is skipped,
  // so the form this branch exists to generate would not be generated.
  return joined.startsWith('..') ? joined : `./${joined}`;
}

/**
 * One link, in one of the five forms the resolver accepts.
 *
 * Rotated by index rather than chosen at random, so every form appears in
 * proportion at any corpus size — a random choice would leave the rarest form
 * absent from a 100-note run and present at 10,000, which is a difference
 * between the two measurements that has nothing to do with scale.
 *
 * The `.md` extension is dropped from the wikilink forms because that is how
 * they are written in practice, and tier 0 appends it.
 */
function linkTo(form: number, sourcePath: string, targetPath: string): string {
  const stem = targetPath.replace(/\.md$/, '');
  const basename = stem.slice(stem.lastIndexOf('/') + 1);
  switch (form % 5) {
    case 0:
      return `[[${basename}]]`;
    case 1:
      return `[[/${stem}]]`;
    case 2:
      return `[[${relativePath(sourcePath, stem)}]]`;
    case 3:
      // Percent-encoded, which is the only difference between a Markdown href
      // and a wikilink anywhere in the resolver.
      return `[a note](${encodeURI(relativePath(sourcePath, targetPath))})`;
    default:
      return `[[${basename}|see the other note]]`;
  }
}

/** One note's Markdown, links included. */
function noteBody(
  index: number,
  path: string,
  paths: readonly string[],
  random: () => number,
  withheld: boolean,
): string {
  const title = sentence(random, 3 + Math.floor(random() * 3)).replace(/\.$/, '');
  const lines: string[] = [];

  // Frontmatter on roughly a third of notes, and on every withheld one. Parsing
  // and stripping it is per-note work the walk pays for, and a corpus with none
  // would leave `frontmatterOf` measuring its own early return.
  if (withheld || random() < 0.3) {
    lines.push('---');
    if (withheld) lines.push('publish: false');
    else lines.push(`title: ${title}`);
    lines.push('---', '');
  }

  lines.push(`# ${title}`, '');

  const degree = outDegreeFor(index, paths.length, random);
  for (let paragraph = 0, total = paragraphsFor(random); paragraph < total; paragraph += 1) {
    const parts = [sentence(random, 6 + Math.floor(random() * 14))];

    // Links are spread across the note's paragraphs rather than listed at the
    // end, so the traversal's edits land throughout the body. `applyEdits`
    // replaces spans last-to-first, and a body whose links all sit in one region
    // would not exercise that ordering across a realistic span distribution.
    if (paragraph < degree) {
      const target = paths[Math.floor(random() * paths.length)]!;
      if (target !== path) parts.push(linkTo(index + paragraph, path, target));
      // One link in twenty names nothing at all. This is the degrade-to-text
      // branch, which allocates a replacement where a resolved link does not,
      // and a corpus without it never runs.
      if (random() < 0.05) parts.push(`[[${WORDS[Math.floor(random() * WORDS.length)]}-${index}-absent]]`);
    }

    lines.push(parts.join(' '), '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Write a corpus of `notes` Markdown files, plus assets, into `directory`.
 *
 * The directory is the caller's to create and to clean up. Nothing is written
 * anywhere else, and no path is derived from this repository's own layout.
 */
export async function generateCorpus(
  directory: string,
  options: CorpusOptions,
): Promise<GeneratedCorpus> {
  const random = seededRandom(options.seed ?? 1);
  const paths = planPaths(options.notes, random);

  const result: GeneratedCorpus = {
    files: 0,
    published: 0,
    withheld: 0,
    assets: 0,
    bytes: 0,
  };

  // Directories are created once rather than per file: `mkdir recursive` on
  // 10,000 files is 10,000 syscalls measuring the filesystem instead of the
  // build.
  const created = new Set<string>();
  const ensure = async (path: string): Promise<void> => {
    const parent = dirname(path);
    if (created.has(parent)) return;
    await mkdir(parent, { recursive: true });
    created.add(parent);
  };

  for (const [index, path] of paths.entries()) {
    // One note in twenty-five withholds itself. That exercises rank 1 of the
    // exclusion precedence and, more usefully for a benchmark, creates link
    // targets that resolve to a real file this build did not publish — the
    // `unpublished` outcome, which is the branch that rewrites a label rather
    // than just replacing a span.
    const withheld = random() < 0.04;
    const body = noteBody(index, path, paths, random, withheld);
    const destination = join(directory, path);
    await ensure(destination);
    await writeFile(destination, body, 'utf8');

    result.files += 1;
    result.bytes += Buffer.byteLength(body, 'utf8');
    if (withheld) result.withheld += 1;
    else result.published += 1;
  }

  // Assets at one per twenty notes, which is the order a notes repository runs
  // at. They are discovered and dropped as `not-markdown`, and every one is
  // offered to every exclusion pattern first — so they are not inert filler,
  // they are what the pattern-matching loop actually spends its time on.
  const assets = Math.max(1, Math.floor(options.notes / 20));
  for (let index = 0; index < assets; index += 1) {
    const directoryName = DIRECTORIES[Math.floor(random() * DIRECTORIES.length)]!;
    const extension = ASSET_EXTENSIONS[index % ASSET_EXTENSIONS.length]!;
    const name = `asset-${index}${extension}`;
    const path = join(directory, directoryName === '' ? name : `${directoryName}/${name}`);
    await ensure(path);
    // Bytes rather than an empty file: discovery does not read a non-Markdown
    // file, and an empty one would let a regression that started reading them
    // go unmeasured.
    const contents = `${sentence(random, 40)}\n`;
    await writeFile(path, contents, 'utf8');
    result.files += 1;
    result.assets += 1;
    result.bytes += Buffer.byteLength(contents, 'utf8');
  }

  return result;
}
