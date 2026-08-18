/**
 * Hold the `dist/` lock for the whole suite run.
 *
 * `globalSetup` rather than `setupFiles`: setup files run once *per worker*, and
 * `isolate: true` gives every test file its own worker — so a lock taken there
 * would be taken thirty-one times and released whenever the first file finished.
 * This runs once in the parent process, before any worker starts, and its
 * teardown runs after the last one exits.
 *
 * `scripts/dist-lock.ts` records what actually collides and why this is a lock
 * rather than a second output directory.
 */

import { lockDist } from '../scripts/dist-lock.ts';

export default async function setup(): Promise<() => void> {
  return lockDist('the test suite');
}
