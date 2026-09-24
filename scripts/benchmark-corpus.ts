/**
 * The seeded workload corpus: the generator request this harness sends, the
 * publication normalization that makes `size` mean published DB nodes, and the
 * Markdown text statistics recorded beside the DB.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import type { CorpusOptions, CorpusTopology, GeneratedCorpus } from './generate-corpus.ts';
import { walkFiles } from './benchmark-files.ts';
import { distributionOf, type NumericDistribution } from './benchmark-stats.ts';

export type Topology = 'sparse' | 'hub';

/**
 * The generator request this harness sends, named as the generator's own
 * option fields so a renamed, removed, or retyped option is a type error here
 * rather than a silently ignored field.
 */
export type GeneratorRequest = Required<Pick<CorpusOptions, 'notes' | 'seed' | 'topology' | 'metadata'>>;

function generatorTopology(topology: Topology): CorpusTopology {
  return topology === 'hub' ? 'skewed' : 'sparse';
}

/** Keep a small withheld slice while making `size` mean published DB nodes. */
function generatorNotesForPublishedSize(size: number): number {
  return size + Math.max(1, Math.ceil(size * 0.04));
}

export function generatorRequest(options: { seed: number }, size: number, topology: Topology): GeneratorRequest {
  return {
    notes: generatorNotesForPublishedSize(size),
    seed: options.seed,
    topology: generatorTopology(topology),
    metadata: true,
  };
}

export interface CorpusFinalization {
  result: GeneratedCorpus;
  promoted: number;
  demoted: number;
}

function markdownFiles(directory: string): { file: string; relativePath: string }[] {
  return walkFiles(directory)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, relativePath: relative(directory, file).split(sep).join('/') }))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

function hasPublishFalse(text: string): boolean {
  const frontmatter = /^(?:---\r?\n)([\s\S]*?)(?:\r?\n---\r?\n?)/.exec(text);
  return frontmatter !== null && /^publish:\s*false\s*$/m.test(frontmatter[1]!);
}

/** Toggle only the generator's publication flag, preserving authored content. */
function setPublishFalse(file: string, withheld: boolean): number {
  const before = readFileSync(file, 'utf8');
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (end < 0) {
    if (!withheld) throw new Error(`cannot publish a Markdown file without frontmatter: ${basename(file)}`);
    lines.unshift('---', 'publish: false', '---', '');
  } else {
    const flag = lines.findIndex((line, index) => index > 0 && index < end && /^publish:\s*false\s*$/.test(line));
    if (withheld && flag < 0) lines.splice(1, 0, 'publish: false');
    if (!withheld && flag >= 0) lines.splice(flag, 1);
  }
  const after = lines.join(newline);
  if (after !== before) writeFileSync(file, after, 'utf8');
  return Buffer.byteLength(after, 'utf8') - Buffer.byteLength(before, 'utf8');
}

/**
 * The generator's random withholding is useful coverage, but its count is not
 * a workload size contract. Normalize the publication flags after generation
 * so the finalized DB has exactly the requested published-node count while the
 * raw generator request and return value remain visible in the report.
 */
export function finalizeCorpus(
  directory: string,
  requestedPublished: number,
  generated: GeneratedCorpus,
): CorpusFinalization {
  const files = markdownFiles(directory);
  if (requestedPublished < 1 || requestedPublished >= files.length) {
    throw new Error(`requested ${requestedPublished} published notes from ${files.length} generated Markdown files`);
  }
  const classified = files.map((entry) => ({ ...entry, withheld: hasPublishFalse(readFileSync(entry.file, 'utf8')) }));
  const withheld = classified.filter((entry) => entry.withheld);
  const published = classified.filter((entry) => !entry.withheld);
  if (published.length !== generated.published || withheld.length !== generated.withheld) {
    throw new Error(
      `generator result ${generated.published}/${generated.withheld} disagrees with generated Markdown ${published.length}/${withheld.length}`,
    );
  }
  const promoted = Math.max(0, requestedPublished - generated.published);
  const demoted = Math.max(0, generated.published - requestedPublished);
  if (promoted > withheld.length || demoted > published.length) {
    throw new Error(
      `cannot finalize ${requestedPublished} published notes from generator result ${generated.published}/${generated.withheld}`,
    );
  }
  let bytes = generated.bytes;
  for (const { file } of withheld.slice(0, promoted)) bytes += setPublishFalse(file, false);
  for (const { file } of published.slice(0, demoted)) bytes += setPublishFalse(file, true);
  const result: GeneratedCorpus = {
    ...generated,
    published: requestedPublished,
    withheld: files.length - requestedPublished,
    bytes,
  };
  return { result, promoted, demoted };
}

/**
 * Note text statistics over the corpus Markdown.
 *
 * Scope is every `.md` file the generator wrote, withheld ones included, and
 * the method is recorded beside the numbers: this describes the workload the
 * build was handed, not a DB projection (a withheld note has no DB row).
 */
export function corpusTextStats(directory: string): {
  scope: string;
  files: number;
  noteBytes: NumericDistribution;
  paragraphs: NumericDistribution;
} {
  const markdown = walkFiles(directory).filter((file) => file.endsWith('.md'));
  const bytes: number[] = [];
  const paragraphs: number[] = [];
  for (const file of markdown) {
    const text = readFileSync(file, 'utf8');
    bytes.push(Buffer.byteLength(text, 'utf8'));
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    paragraphs.push(body.split(/\r?\n\s*\r?\n/).filter((block) => block.trim() !== '').length);
  }
  return {
    scope: 'all generator-written Markdown files, withheld included',
    files: markdown.length,
    noteBytes: distributionOf(bytes),
    paragraphs: distributionOf(paragraphs),
  };
}
