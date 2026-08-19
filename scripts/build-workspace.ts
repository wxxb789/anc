/** Retention for packaged-build workspaces left by interruption or deferred cleanup. */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const STALE_BUILD_WORKSPACE_AGE_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_NAME = /^\.thoughtscape-build-[A-Za-z0-9]{6}$/;

/** Remove one completed workspace without replacing the build result on failure. */
export async function removeBuildWorkspace(
  directory: string,
  remove: (target: string) => Promise<void> = (target) =>
    rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
): Promise<boolean> {
  try {
    await remove(directory);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort removal of this tool's stale sibling workspaces.
 *
 * Workspaces must live beside the package so Astro's staging and output stay on
 * one device. A killed process never reaches its `finally`, and Windows may hold
 * a just-written file past the final retry, so a later run converges the state.
 * The 24-hour age bound keeps concurrent workspaces out of the candidate set.
 * Symlinks, junctions, files, and unfamiliar names are never traversed or removed.
 */
export async function pruneStaleBuildWorkspaces(root: string, now: number = Date.now()): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!WORKSPACE_NAME.test(entry.name) || !entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    try {
      const metadata = await stat(directory);
      if (now - metadata.mtimeMs <= STALE_BUILD_WORKSPACE_AGE_MS) continue;
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed += 1;
    } catch {
      // Cleanup must never replace or prevent the build the user requested.
    }
  }
  return removed;
}
