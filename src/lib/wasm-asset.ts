/**
 * The pinned SQLite WASM runtime's public identity.
 *
 * The browser loads the official `@sqlite.org/sqlite-wasm` entry same-origin from
 * `/wasm/`, and its WASM binary under a digest-named file the Worker verifies
 * against the URL it bound. This module is pure data and string helpers so the
 * producer, the output inventory, the scanners, and the Worker share one
 * spelling of every name.
 */

import { isHexDigest } from './snapshot.ts';

/** Directory segment the SQLite runtime lives under. `wasm` is a reserved slug. */
export const WASM_DIRECTORY = 'wasm';

/** The package's browser entry, copied under a stable public name. */
export const WASM_MODULE_NAME = 'sqlite-wasm.js';

/** Same-origin URL of the browser entry the Worker imports at runtime. */
export function wasmModuleUrl(): string {
  return `/${WASM_DIRECTORY}/${WASM_MODULE_NAME}`;
}

/** The digest-named WASM member name, without a directory. */
export function wasmMemberName(digest: string): string {
  if (!isHexDigest(digest)) throw new Error(`wasm digest is not 64 lowercase hex: ${digest}`);
  return `sqlite3.${digest}.wasm`;
}

/** Same-origin URL of the WASM named by its full digest. */
export function wasmRoute(digest: string): string {
  return `/${WASM_DIRECTORY}/${wasmMemberName(digest)}`;
}

/** The runtime binding a build writes and the Worker verifies. */
export interface WasmBinding {
  /** Same-origin URL of the browser entry the Worker imports at runtime. */
  moduleUrl: string;
  /** Digest-named WASM URL, verified against the downloaded bytes. */
  url: string;
  digest: string;
  /** Every public member the output inventory admits, output-relative. */
  members: string[];
}

/** Validate an untrusted runtime binding. */
export function readWasmBinding(value: unknown): WasmBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const moduleUrl = record['moduleUrl'];
  const url = record['url'];
  const digest = record['digest'];
  const members = record['members'];
  if (moduleUrl !== wasmModuleUrl()) return undefined;
  if (typeof url !== 'string' || typeof digest !== 'string' || !isHexDigest(digest)) return undefined;
  if (url !== wasmRoute(digest)) return undefined;
  if (!Array.isArray(members) || members.some((member) => typeof member !== 'string')) return undefined;
  return { moduleUrl, url, digest, members: [...members] };
}
