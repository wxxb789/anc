/**
 * Exact route inventory plus tightly-owned build namespaces for the final site.
 *
 * Notes publish as HTML routes only. Static package assets are byte-compared to
 * public/, Astro owns only flat hashed JS/CSS under _astro/, and Pagefind's
 * content-addressed members must be referenced by its own metadata. Everything
 * else is an unexpected publication surface and fails before copy-out.
 */

import { gunzipSync } from 'node:zlib';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadArtifact } from '../src/lib/artifact-source.ts';
import { noteRoute, WITHHELD_ROUTE } from '../src/lib/route-path.ts';
import {
  COLLECTIONS_SEGMENT,
  FIXED_ROUTES,
  TAGS_SEGMENT,
  collectionFacets,
  tagFacets,
} from '../src/lib/routes.ts';
import type { ContentArtifact } from '../src/lib/schema.ts';
import { BuildFailure } from './write-report.ts';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

const GENERATED_FILES = ['_redirects', 'content-index.json', 'robots.txt', 'rss.xml', 'sitemap.xml'] as const;
const PAGEFIND_RUNTIME = [
  'pagefind/pagefind-entry.json',
  'pagefind/pagefind-highlight.js',
  'pagefind/pagefind-worker.js',
  'pagefind/pagefind.js',
  'pagefind/pagefind-ui.css',
  'pagefind/pagefind-ui.js',
  'pagefind/pagefind-modular-ui.css',
  'pagefind/pagefind-modular-ui.js',
  'pagefind/pagefind-component-ui.css',
  'pagefind/pagefind-component-ui.js',
  'pagefind/wasm.unknown.pagefind',
] as const;

function posix(path: string): string {
  return path.split(sep).join('/');
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else files.push(path);
    }
  }
  return files.map((path) => posix(relative(root, path))).sort();
}

function htmlFile(route: string): string {
  if (route === '/') return 'index.html';
  if (route.startsWith('/') && route.endsWith('.html')) return route.slice(1);
  if (!route.startsWith('/') || !route.endsWith('/')) {
    throw new BuildFailure(
      'output-inventory-route-invalid',
      'output inventory could not derive one static route',
      'route has no static output shape: ' + JSON.stringify(route),
    );
  }
  return route.slice(1) + 'index.html';
}

function expectedHtml(artifact: ContentArtifact): Set<string> {
  const routes = new Set<string>([...FIXED_ROUTES, WITHHELD_ROUTE, '/404.html']);
  for (const entry of artifact.entries) routes.add(noteRoute(entry.slug));
  for (const facet of tagFacets(artifact.entries)) routes.add('/' + TAGS_SEGMENT + '/' + facet.key + '/');
  for (const facet of collectionFacets(artifact.entries)) {
    routes.add('/' + COLLECTIONS_SEGMENT + '/' + facet.key + '/');
  }
  return new Set([...routes].map(htmlFile));
}

function inflateIfGzip(bytes: Buffer): Buffer {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}

function pagefindFiles(root: string, actual: readonly string[]): Set<string> {
  // These are Pagefind's fixed runtime distribution. Content-addressed members
  // are added only from pagefind-entry.json and the gzip metadata it names.
  const allowed = new Set<string>(PAGEFIND_RUNTIME);
  const entryPath = join(root, 'pagefind', 'pagefind-entry.json');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(entryPath, 'utf8'));
  } catch (error) {
    throw new BuildFailure(
      'output-inventory-pagefind-unreadable',
      'output inventory could not read the Pagefind manifest',
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BuildFailure(
      'output-inventory-pagefind-invalid',
      'output inventory found an invalid Pagefind manifest',
      'pagefind-entry.json is not an object',
    );
  }
  const languagesValue = (value as Record<string, unknown>)['languages'];
  if (languagesValue === null || typeof languagesValue !== 'object' || Array.isArray(languagesValue) ||
      Object.keys(languagesValue).length === 0) {
    throw new BuildFailure(
      'output-inventory-pagefind-invalid',
      'output inventory found an invalid Pagefind manifest',
      'pagefind-entry.json languages must be a non-empty object',
    );
  }

  const metadata: Buffer[] = [];
  for (const [name, member] of Object.entries(languagesValue)) {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) {
      throw new BuildFailure(
        'output-inventory-pagefind-invalid',
        'output inventory found an invalid Pagefind manifest',
        'invalid Pagefind language member: ' + JSON.stringify(name),
      );
    }
    const language = member as Record<string, unknown>;
    const wasm = language['wasm'];
    if (typeof language['hash'] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(language['hash']) ||
        (wasm !== null && (typeof wasm !== 'string' || !/^[A-Za-z0-9_-]+$/.test(wasm)))) {
      throw new BuildFailure(
        'output-inventory-pagefind-invalid',
        'output inventory found an invalid Pagefind manifest',
        'invalid Pagefind language references: ' + JSON.stringify(name),
      );
    }
    const meta = 'pagefind/pagefind.' + language['hash'] + '.pf_meta';
    allowed.add(meta);
    // null is Pagefind's declaration that this language uses the fixed
    // wasm.unknown.pagefind runtime already in PAGEFIND_RUNTIME.
    if (typeof wasm === 'string') allowed.add('pagefind/wasm.' + wasm + '.pagefind');
    try {
      metadata.push(inflateIfGzip(readFileSync(join(root, ...meta.split('/')))));
    } catch (error) {
      throw new BuildFailure(
        'output-inventory-pagefind-unreadable',
        'output inventory could not read Pagefind metadata',
        meta + ': ' + (error instanceof Error ? error.stack ?? error.message : String(error)),
      );
    }
  }

  for (const file of actual) {
    const match = /^pagefind\/(?:fragment|index)\/([A-Za-z0-9_-]+)\.(?:pf_fragment|pf_index)$/.exec(file);
    if (match === null) continue;
    const reference = Buffer.from(match[1]!);
    if (metadata.some((bytes) => bytes.includes(reference))) allowed.add(file);
  }
  return allowed;
}

/** Assert every final file belongs to one public route or one generated namespace. */
export function assertOutputInventory(root: string, artifact: ContentArtifact): number {
  let actual: string[];
  try {
    actual = filesUnder(root);
  } catch (error) {
    throw new BuildFailure(
      'output-inventory-unreadable',
      'output inventory could not be read',
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
  }

  let staticPublic: string[];
  try {
    const generatedFiles = new Set<string>(GENERATED_FILES);
    staticPublic = filesUnder(PUBLIC).filter((file) => !generatedFiles.has(file));
    if (staticPublic.length === 0) throw new Error('package public assets are empty');
    for (const file of staticPublic) {
      if (!lstatSync(join(PUBLIC, ...file.split('/'))).isFile()) {
        throw new Error('package public member is not a regular file: ' + file);
      }
    }
  } catch (error) {
    throw new BuildFailure(
      'output-inventory-source-unreadable',
      'output inventory could not read package public assets',
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
  }

  const html = expectedHtml(artifact);
  const exact = new Set<string>([
    ...html,
    ...staticPublic,
    ...GENERATED_FILES,
    ...PAGEFIND_RUNTIME,
  ]);
  const pagefind = pagefindFiles(root, actual);
  const unexpected: string[] = [];
  const altered: string[] = [];

  for (const file of actual) {
    const path = join(root, ...file.split('/'));
    if (!lstatSync(path).isFile()) {
      unexpected.push(file);
      continue;
    }
    if (exact.has(file) || pagefind.has(file) || /^_astro\/[A-Za-z0-9._-]+\.[A-Za-z0-9_-]{8,}\.(?:css|js)$/.test(file)) continue;
    unexpected.push(file);
  }

  for (const file of staticPublic) {
    if (!actual.includes(file)) continue;
    const built = readFileSync(join(root, ...file.split('/')));
    const source = readFileSync(join(PUBLIC, ...file.split('/')));
    if (!built.equals(source)) altered.push(file);
  }

  const expected = new Set([...exact, ...pagefind]);
  const actualSet = new Set(actual);
  const missing = [...expected].filter((file) => !actualSet.has(file));
  const uniqueMissing = [...new Set(missing)].sort();
  if (unexpected.length > 0 || uniqueMissing.length > 0 || altered.length > 0) {
    throw new BuildFailure(
      'output-inventory-mismatch',
      'output inventory mismatch: ' + unexpected.length + ' unexpected, ' + uniqueMissing.length +
        ' missing, ' + altered.length + ' altered',
      JSON.stringify({ unexpected: unexpected.sort(), missing: uniqueMissing, altered: altered.sort() }),
    );
  }
  return actual.length;
}

/**
 * This repository's own build may print private detail. The packaged binary
 * imports only assertOutputInventory and routes its BuildFailure message to the
 * public stream while the detail goes to the private build report.
 */
function main(): number {
  try {
    console.log('output inventory ok: ' + assertOutputInventory(DIST, loadArtifact()) + ' files');
    return 0;
  } catch (error) {
    console.error(error instanceof BuildFailure ? error.detail : error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
