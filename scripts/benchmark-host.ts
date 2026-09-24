/** Host identity and host-path scrubbing shared by the goal-0008 benchmark runners. */

import { arch, cpus, release as osRelease, tmpdir, totalmem, type as osType } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Host paths that must never reach stdout; registered per workload. */
const scrubPaths: string[] = [ROOT, tmpdir()];

export function scrub(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const path of scrubPaths) text = text.split(path).join('<workspace>');
  return text;
}

/** Register one more host path (a workload's temporary root) for scrubbing. */
export function registerScrubPath(path: string): void {
  scrubPaths.push(path);
}

/** The host facts every benchmark report records. */
export function hostIdentity(): {
  platform: string;
  osType: string;
  osRelease: string;
  arch: string;
  cpus: number;
  totalMemoryBytes: number;
} {
  return {
    platform: process.platform,
    osType: osType(),
    osRelease: osRelease(),
    arch: arch(),
    cpus: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}
