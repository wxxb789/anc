/**
 * Build the public snapshot for a content artifact and bind it for the build.
 *
 * Writes two private files into the snapshot workspace: `snapshot.sqlite`, the
 * finalized database, and `binding.json`, the digest-named URL the Astro build
 * and the output copy step read. Neither is public output; only the copied,
 * digest-named file under `dist/data/` is.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DatabaseSync } from '../src/lib/sqlite.ts';
import type { ContentEntry } from '../src/lib/schema.ts';
import { ARTIFACT_PATH, loadArtifact } from '../src/lib/artifact-source.ts';
import { snapshotWorkspace } from '../src/lib/snapshot-reader.ts';
import { writeSnapshot, type WrittenSnapshot } from './write-snapshot.ts';

export interface BuiltSnapshot extends WrittenSnapshot {
  /** Absolute private workspace directory holding the DB and its binding. */
  workspace: string;
  /** Number of published nodes in the snapshot. */
  nodes: number;
  /** Number of directed edges in the snapshot. */
  edges: number;
  /** Number of canonical tags in the snapshot. */
  tags: number;
}

/**
 * Build the snapshot from the producer's in-memory entries and write the binding.
 *
 * The packaged build calls this directly: its serialized artifact deliberately
 * omits `outgoing`/`backlinks`, so the edge authorities reach the snapshot
 * builder as the transient producer result rather than through a file.
 */
export function buildSnapshotFromEntries(
  entries: readonly ContentEntry[],
  workspace: string = snapshotWorkspace(),
): BuiltSnapshot {
  mkdirSync(workspace, { recursive: true });
  const written = writeSnapshot({ version: 1, entries: [...entries] }, resolve(workspace, 'snapshot.sqlite'));
  writeFileSync(
    resolve(workspace, 'binding.json'),
    `${JSON.stringify(
      // The header constants live in code; the binding names the bytes.
      { url: written.url, digest: written.digest },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const database = loadSnapshotCounts(written.path);
  return { ...written, workspace, ...database };
}

/**
 * Build the snapshot and write the binding beside it.
 *
 * @param artifactPath Repository-relative artifact to read; defaults to the one
 *   this build selected (`CONTENT_ARTIFACT` or `src/data/content.json`).
 * @param workspace Absolute private directory. Defaults to `SNAPSHOT_WORKSPACE`
 *   or `.astro/snapshot`.
 */
export function buildSnapshot(
  artifactPath: string = ARTIFACT_PATH,
  workspace: string = snapshotWorkspace(),
): BuiltSnapshot {
  return buildSnapshotFromEntries(loadArtifact(artifactPath).entries, workspace);
}

/** Read the finalized file back, so the reported counts are the published rows. */
function loadSnapshotCounts(path: string): { nodes: number; edges: number; tags: number } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      nodes: (database.prepare('SELECT count(*) AS c FROM nodes').get() as { c: number }).c,
      edges: (database.prepare('SELECT count(*) AS c FROM edges').get() as { c: number }).c,
      tags: (database.prepare('SELECT count(*) AS c FROM tags').get() as { c: number }).c,
    };
  } finally {
    database.close();
  }
}

function main(): number {
  try {
    const built = buildSnapshot();
    console.log(
      `snapshot ok: nodes=${built.nodes} edges=${built.edges} tags=${built.tags} bytes=${built.size} sha256=${built.digest}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());

