/**
 * Build-time globals substituted by `vite.define` from the private snapshot
 * workspace (`readStaged` in `astro.config.mjs`).
 *
 * They carry the digest-named same-origin binding for the snapshot and the
 * SQLite WASM, or `null` when a build staged none, so the Worker fails closed
 * and fetches nothing. Declared here rather than in a `.d.ts` because
 * `scripts/compile-package.ts` builds its TypeScript program from `src` and
 * `scripts` sources, not from ambient declaration files.
 */

import type { SnapshotBinding } from './snapshot.ts';
import type { WasmBinding } from './wasm-asset.ts';

declare global {
  const __ANC_SNAPSHOT_BINDING__: SnapshotBinding | null;
  const __ANC_WASM_BINDING__: WasmBinding | null;
  const __ANC_WASM_MODULE_URL__: string;
}

export {};
