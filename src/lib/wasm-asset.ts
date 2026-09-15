/**
 * The pinned SQLite WASM runtime's public identity.
 *
 * The browser loads the official `@sqlite.org/sqlite-wasm` entry same-origin from
 * `/wasm/`, and its WASM binary under a digest-named file the Worker verifies
 * against the URL it bound. This module is pure data and string helpers so the
 * producer, the output inventory, the scanners, and the Worker share one
 * spelling of every name.
 */

/** Directory segment the SQLite runtime lives under. `wasm` is a reserved slug. */
export const WASM_DIRECTORY = 'wasm';

/** The package's browser entry, copied under a stable public name. */
export const WASM_MODULE_NAME = 'sqlite-wasm.js';

const DIGEST = /^[0-9a-f]{64}$/;

/** Matches the digest-named WASM member, capturing the digest. */
export const WASM_FILE_PATTERN = /^sqlite3\.([0-9a-f]{64})\.wasm$/;

export function isWasmDigest(value: string): boolean {
  return DIGEST.test(value);
}

/** Same-origin URL of the WASM named by its full digest. */
export function wasmRoute(digest: string): string {
  if (!isWasmDigest(digest)) throw new Error(`wasm digest is not 64 lowercase hex: ${digest}`);
  return `/${WASM_DIRECTORY}/sqlite3.${digest}.wasm`;
}

/** Output-relative file name, without a leading slash. */
export function wasmFileName(digest: string): string {
  return wasmRoute(digest).slice(1);
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
  if (moduleUrl !== `/${WASM_DIRECTORY}/${WASM_MODULE_NAME}`) return undefined;
  if (typeof url !== 'string' || typeof digest !== 'string' || !isWasmDigest(digest)) return undefined;
  if (url !== wasmRoute(digest)) return undefined;
  if (!Array.isArray(members) || members.some((member) => typeof member !== 'string')) return undefined;
  return { moduleUrl, url, digest, members: [...members] };
}
