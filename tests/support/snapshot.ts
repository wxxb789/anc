/**
 * Test access to the built snapshot.
 *
 * The public preview index this suite used to read is gone: relationship and
 * preview data now lives in the digest-named SQLite file. These helpers open the
 * real built artifact the same way a reader would, so a test asserts against the
 * shipped bytes rather than a reimplementation of them.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/lib/sqlite.ts';
import { SNAPSHOT_FILE_PATTERN } from '../../src/lib/snapshot.ts';

/** The one snapshot file in a built output. */
export function snapshotPath(dist: string): string {
  const directory = join(dist, 'data');
  const candidates = existsSync(directory)
    ? readdirSync(directory).filter((name) => SNAPSHOT_FILE_PATTERN.test(name))
    : [];
  if (candidates.length !== 1) {
    throw new Error(`expected one snapshot in ${directory}, found ${candidates.length}`);
  }
  return join(directory, candidates[0]!);
}

export interface SnapshotNote {
  slug: string;
  title: string;
  excerpt: string;
  language: string;
  aliases: string[];
}

/** Open the built snapshot read-only. Callers must close it. */
export function openSnapshot(dist: string): DatabaseSync {
  return new DatabaseSync(snapshotPath(dist), { readOnly: true });
}

/** Every published note, with authored-order aliases. */
export function snapshotNotes(dist: string): SnapshotNote[] {
  const database = openSnapshot(dist);
  try {
    const notes = database
      .prepare('SELECT id, slug, title, excerpt, language FROM nodes ORDER BY slug')
      .all() as unknown as { id: number; slug: string; title: string; excerpt: string; language: string }[];
    const aliases = database
      .prepare('SELECT node_id, alias FROM aliases ORDER BY node_id, ordinal')
      .all() as unknown as { node_id: number; alias: string }[];
    const aliasByNode = new Map<number, string[]>();
    for (const row of aliases) {
      (aliasByNode.get(row.node_id) ?? aliasByNode.set(row.node_id, []).get(row.node_id)!).push(row.alias);
    }
    return notes.map((note) => ({
      slug: note.slug,
      title: note.title,
      excerpt: note.excerpt,
      language: note.language,
      aliases: aliasByNode.get(note.id) ?? [],
    }));
  } finally {
    database.close();
  }
}

/** Every published slug, sorted. */
export function snapshotSlugs(dist: string): string[] {
  const database = openSnapshot(dist);
  try {
    return (database.prepare('SELECT slug FROM nodes ORDER BY slug').all() as unknown as { slug: string }[]).map(
      (row) => row.slug,
    );
  } finally {
    database.close();
  }
}

/** Every text value the snapshot stores, joined, for absence/presence checks. */
export function snapshotText(dist: string): string {
  const database = openSnapshot(dist);
  try {
    const values: string[] = [];
    for (const table of ['nodes', 'aliases', 'tags']) {
      for (const row of database.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<string, unknown>[]) {
        for (const value of Object.values(row)) if (typeof value === 'string') values.push(value);
      }
    }
    return values.join('\n');
  } finally {
    database.close();
  }
}

/** Directed edges as `[source, target]` pairs, sorted. */
export function snapshotEdges(dist: string): [string, string][] {
  const database = openSnapshot(dist);
  try {
    const rows = database
      .prepare(
        `SELECT s.slug AS source, t.slug AS target
         FROM edges AS e
         JOIN nodes AS s ON s.id = e.source_id
         JOIN nodes AS t ON t.id = e.target_id
         ORDER BY source, target`,
      )
      .all() as unknown as { source: string; target: string }[];
    return rows.map((row) => [row.source, row.target]);
  } finally {
    database.close();
  }
}

/** Canonical tags and their member slugs, key order. */
export function snapshotTags(dist: string): { key: string; label: string; members: string[] }[] {
  const database = openSnapshot(dist);
  try {
    const tags = database
      .prepare('SELECT id, key, label FROM tags ORDER BY key')
      .all() as unknown as { id: number; key: string; label: string }[];
    const memberships = database
      .prepare(
        `SELECT nt.tag_id AS tag, n.slug AS slug
         FROM node_tags AS nt JOIN nodes AS n ON n.id = nt.node_id
         ORDER BY nt.tag_id, n.slug`,
      )
      .all() as unknown as { tag: number; slug: string }[];
    const byTag = new Map<number, string[]>();
    for (const row of memberships) (byTag.get(row.tag) ?? byTag.set(row.tag, []).get(row.tag)!).push(row.slug);
    return tags.map((tag) => ({ key: tag.key, label: tag.label, members: byTag.get(tag.id) ?? [] }));
  } finally {
    database.close();
  }
}

/**
 * Copy a real built snapshot into a destination directory as the recognition
 * marker, for tests that stand up a served directory.
 */
export function installSnapshotMarker(destination: string, source: string): string {
  const targetDirectory = join(destination, 'data');
  mkdirSync(targetDirectory, { recursive: true });
  const name = snapshotPath(source).split('/').at(-1)!;
  copyFileSync(snapshotPath(source), join(targetDirectory, name));
  return join('data', name);
}
