/**
 * **Temporary. TK-26 replaces this file entirely.**
 *
 * The narrowest bridge from a directory of `.md` files to the artifact shape
 * `src/lib/schema.ts` already validates, so TK-24's acceptance test — pack,
 * install into an empty directory holding three Markdown files, run the binary,
 * get a site — can run end to end. TK-24 is packaging; producing an artifact
 * from arbitrary Markdown is TK-26's ticket, and this file deliberately does not
 * attempt it.
 *
 * What it does *not* do, each of which is a named TK-26 deliverable rather than
 * an oversight: no exclusion rules, no frontmatter parsing, no git timestamps,
 * no link resolution in any of the five forms, no backlink derivation, no
 * ambiguity reporting. Discovery is a non-recursive read of one directory. A
 * file whose name does not slugify cleanly is skipped rather than resolved,
 * because guessing is TK-26's decision to make with a specification behind it.
 *
 * It does now say *which* files it skipped, and why — TK-25 added that, because
 * the alternative was the state it found: three files dropped in silence on a
 * build that exits 0. The reasons go to the caller as data rather than to a
 * stream, and `scripts/write-report.ts` owns where they land.
 *
 * The one property it does hold is the one the acceptance test measures: what it
 * writes passes `validateArtifact` unmodified. Everything downstream of the
 * schema is therefore exercised for real — the renderer, the design system, the
 * route model, the residue scan — which is what makes the gate evidence about
 * packaging rather than about this file.
 */

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { validateArtifact } from '../src/lib/schema.ts';
import { BuildFailure, type DroppedFile } from './write-report.ts';

/** Mirrors the slug shape `schema.ts` enforces: lowercase, single hyphens. */
function slugFor(filename: string): string | undefined {
  const slug = filename
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? undefined : slug;
}

/**
 * The first heading's text, or the filename.
 *
 * A title is required and must be non-empty, and the renderer removes a leading
 * `# Title` that matches the page title — so taking it from the body is what
 * makes an ordinary note render with its heading once rather than twice.
 */
function titleFor(markdown: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || fallback;
}

/** Prose, collapsed and bounded, for the card and the meta description. */
function excerptFor(markdown: string): string {
  const prose = markdown
    .replace(/^#.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return prose.length > 200 ? `${prose.slice(0, 200).trimEnd()}…` : prose;
}

/**
 * Read one directory of Markdown, and say what it dropped.
 *
 * Discovery only: the artifact is **not** validated here, because the caller has
 * to be able to record what was discovered before the contract can reject any of
 * it. That ordering is the whole reason a run which fails the contract still
 * leaves a report naming the files it dropped.
 *
 * `outgoing` and `backlinks` are empty for every entry: the contract requires
 * backlinks to be the exact inverse of outgoing links, and deriving either needs
 * the link resolution TK-27 specifies. Empty is the only pair that is honest and
 * that validates.
 *
 * **Enumerate first, classify inside.** The `.md` test used to sit on the
 * `readdir` filter, which meant a `.pdf` never entered the loop and so could be
 * neither counted nor reported — the report would have claimed a `discovered`
 * total that silently excluded exactly the files a user is most likely to be
 * surprised about. The `isFile()` predicate stays where it is and is the
 * classifier: a subdirectory is not a file and appears in neither `discovered`
 * nor `dropped`, because "the tool declined to recurse" is not a fact about a
 * file the user wrote. A symlink to a file reports `isFile() === true`, so it is
 * counted and published like any other file, which is the existing behaviour.
 *
 * A nested `.md` file is invisible rather than dropped: discovery is
 * non-recursive, so `sub/nested.md` is never enumerated. Recording it would
 * require walking to find it, which is TK-26's recursion. When that lands the
 * same definition holds over the deeper walk and no schema change follows.
 */
export async function discover(contentDirectory: string): Promise<Discovery> {
  const names = (await readdir(contentDirectory, { withFileTypes: true }))
    .filter((item) => item.isFile())
    .map((item) => item.name)
    .sort();

  /** Slug to the name that claimed it, so a collision can name its winner. */
  const claimed = new Map<string, string>();
  const dropped: DroppedFile[] = [];
  const entries = [];

  for (const name of names) {
    if (extname(name).toLowerCase() !== '.md') {
      dropped.push({ path: name, reason: 'not-markdown' });
      continue;
    }

    const slug = slugFor(name);
    if (slug === undefined) {
      dropped.push({ path: name, reason: 'empty-slug' });
      continue;
    }

    // A duplicate slug fails the contract, so two files that collide would fail
    // the build with a schema error naming neither file. Skipping the second is
    // no better as an answer — TK-26 owns the real one, per plan D1 — but it
    // fails understandably here rather than confusingly, and the report now says
    // which file lost and to which.
    const winner = claimed.get(slug);
    if (winner !== undefined) {
      dropped.push({ path: name, reason: 'slug-collision', collidedWith: winner });
      continue;
    }
    claimed.set(slug, name);

    const markdown = (await readFile(join(contentDirectory, name), 'utf8')).replace(/\r\n/g, '\n');
    entries.push({
      slug,
      title: titleFor(markdown, slug),
      excerpt: excerptFor(markdown),
      markdown,
      outgoing: [],
      backlinks: [],
    });
  }

  return {
    entries,
    counts: { discovered: names.length, published: entries.length, dropped: dropped.length },
    dropped,
  };
}

/**
 * What one directory yielded: the entries to validate, and what was left out.
 *
 * `entries` is deliberately the unvalidated shape. Discovery does not call
 * `validateArtifact`, because the caller has to be able to record what was
 * discovered *before* the contract can reject any of it — that ordering is the
 * whole reason a run which fails the contract still leaves a report naming the
 * files it dropped.
 */
export interface Discovery {
  entries: ContentEntryInput[];
  counts: { discovered: number; published: number; dropped: number };
  dropped: DroppedFile[];
}

/** One candidate entry, before the contract has judged it. */
interface ContentEntryInput {
  slug: string;
  title: string;
  excerpt: string;
  markdown: string;
  outgoing: string[];
  backlinks: string[];
}

/**
 * Validate what discovery produced, and write it where the build will read it.
 *
 * Split from {@link discover} rather than taking a callback, so the caller can
 * put its own work between the two — which is exactly what the report needs: a
 * caller records the counts and the dropped rows, and only then asks for the
 * artifact. A callback would have hidden that ordering inside this module,
 * where nothing depends on it.
 */
export async function writeArtifact(discovery: Discovery, destination: string): Promise<void> {
  if (discovery.entries.length === 0) {
    // Thrown here rather than at the end of `discover`, and that ordering is
    // load-bearing: a directory holding only a `.pdf` and a filename that
    // slugifies to nothing is exactly the corpus the report exists for, and
    // throwing before the caller could record the counts left that run's report
    // saying `aborted` with three zeroes — the one shape a reader cannot act on.
    //
    // No path in the message: the content directory is a host path the user did
    // not type in this form, and this reaches a workflow log. The flag spelling
    // is a literal of this tool's own source, identical in every run.
    throw new BuildFailure(
      'no-markdown-found',
      'no Markdown found — this build reads *.md from the directory named by --content',
    );
  }

  // A source literal, not the content directory: `ContentValidationError`
  // prefixes its message with this, and that message reaches a stream.
  const artifact = validateArtifact({ version: 1, entries: discovery.entries }, 'content directory');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
