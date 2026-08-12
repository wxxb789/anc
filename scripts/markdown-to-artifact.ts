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
 * ambiguity reporting, no report file. Discovery is a non-recursive read of one
 * directory. A file whose name does not slugify cleanly is skipped rather than
 * resolved, because guessing is TK-26's decision to make with a specification
 * behind it.
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
 * Read one directory of Markdown into a validated artifact.
 *
 * `outgoing` and `backlinks` are empty for every entry: the contract requires
 * backlinks to be the exact inverse of outgoing links, and deriving either needs
 * the link resolution TK-27 specifies. Empty is the only pair that is honest and
 * that validates.
 */
export async function buildArtifact(contentDirectory: string) {
  const names = (await readdir(contentDirectory, { withFileTypes: true }))
    .filter((item) => item.isFile() && extname(item.name).toLowerCase() === '.md')
    .map((item) => item.name)
    .sort();

  const seen = new Set<string>();
  const entries = [];
  for (const name of names) {
    const slug = slugFor(name);
    // A duplicate slug fails the contract, so two files that collide would fail
    // the build with a schema error naming neither file. Skipping the second is
    // no better as an answer — TK-26 owns the real one, per plan D1 — but it
    // fails understandably here rather than confusingly.
    if (slug === undefined || seen.has(slug)) continue;
    seen.add(slug);

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

  if (entries.length === 0) {
    throw new Error(
      `no Markdown found in ${contentDirectory} — this build reads *.md from that directory`,
    );
  }

  return validateArtifact({ version: 1, entries }, contentDirectory);
}

/** Write the artifact where the build will read it. Returns the entry count. */
export async function writeArtifact(contentDirectory: string, destination: string): Promise<number> {
  const artifact = await buildArtifact(contentDirectory);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact.entries.length;
}
