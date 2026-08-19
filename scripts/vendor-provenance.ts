/**
 * Build-minted provenance for JavaScript chunks containing dependency code only.
 *
 * The final residue scan must keep reading every first-party chunk, while the
 * selected client runtimes emit dependency chunks containing byte sequences
 * that resemble residue. A basename cannot prove which is which. The bundler can: its chunk
 * interface carries every resolved module id before the bytes are written.
 *
 * The manifest lives beside, never inside, the output directory. It therefore
 * reaches the scanner in the next process without becoming a public asset. It
 * contains final output names only — never module ids or host paths.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { BuildFailure } from './write-report.ts';

export const VENDOR_PROVENANCE_VERSION = 2;
export const VENDOR_STATE_SUFFIX = '.publish-state';
export const VENDOR_PROVENANCE_FILE = 'vendored-chunks.json';
export const CLIENT_ASSET_PREFIX = '_astro/';

interface ChunkDescription {
  fileName: string;
  moduleIds: readonly string[];
}

interface VendorGrant {
  file: string;
  sha256: string;
}

interface VendorProvenance {
  version: typeof VENDOR_PROVENANCE_VERSION;
  chunks: VendorGrant[];
}

function slash(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/$/, '');
}

function canonical(path: string): string {
  const absolute = resolve(path);
  return slash(existsSync(absolute) ? realpathSync(absolute) : absolute).toLowerCase();
}

/** Package owners measured in the selected Mermaid and Temml client bundles. */
export const CLIENT_RUNTIME_PACKAGES: ReadonlySet<string> = new Set([
  '@braintree/sanitize-url',
  '@iconify/utils',
  '@mermaid-js/parser',
  '@upsetjs/venn.js',
  'cose-base',
  'cytoscape',
  'cytoscape-cose-bilkent',
  'cytoscape-fcose',
  'd3',
  'd3-array',
  'd3-axis',
  'd3-brush',
  'd3-color',
  'd3-dispatch',
  'd3-ease',
  'd3-format',
  'd3-hierarchy',
  'd3-interpolate',
  'd3-path',
  'd3-sankey',
  'd3-scale',
  'd3-scale-chromatic',
  'd3-selection',
  'd3-shape',
  'd3-time',
  'd3-time-format',
  'd3-timer',
  'd3-transition',
  'd3-zoom',
  'dagre-d3-es',
  'dayjs',
  'dompurify',
  'es-toolkit',
  'internmap',
  'katex',
  'khroma',
  'layout-base',
  'lodash-es',
  'marked',
  'mermaid',
  'roughjs',
  'stylis',
  'temml',
  'ts-dedent',
  'uuid',
]);

/** The one generated module measured inside an otherwise-vendored Rolldown chunk. */
const TRUSTED_BUNDLER_MODULES: ReadonlySet<string> = new Set(['\0rolldown/runtime.js']);

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function packageAt(entry: string): { root: string; manifest: PackageManifest; manifestPath: string } {
  let directory = dirname(entry);
  while (true) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
        if (typeof manifest.name === 'string') return { root: directory, manifest, manifestPath };
      } catch (error) {
        return refuse('could not read runtime package metadata: ' + String(error));
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return refuse('could not locate package metadata for a client runtime module');
    directory = parent;
  }
}

/**
 * Canonical roots in the installed Mermaid/Temml dependency closure that this
 * build is allowed to classify as vendored. Package names remain an explicit
 * review list; resolution supplies the stronger fact that a module came from
 * the exact package instance these runtimes load, not a same-named external tree.
 */
export function clientRuntimePackageRoots(packageRoot: string): string[] {
  const roots = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string, importer: string, required: boolean): void => {
    let entry: string;
    try {
      entry = createRequire(importer).resolve(name);
    } catch (error) {
      // Some browser-only packages deliberately expose no Node main. The package
      // manager link beside the importing package still identifies the exact
      // installed instance Vite resolves; use its manifest, never a name search
      // elsewhere in the tree.
      const linkedManifest = join(dirname(dirname(importer)), ...name.split('/'), 'package.json');
      if (existsSync(linkedManifest)) entry = linkedManifest;
      else {
        if (!required) return;
        return refuse('could not resolve selected client runtime ' + name + ': ' + String(error));
      }
    }
    const resolved = packageAt(entry);
    const packageRoot = canonical(resolved.root);
    if (visited.has(packageRoot)) return;
    visited.add(packageRoot);
    if (resolved.manifest.name !== undefined && CLIENT_RUNTIME_PACKAGES.has(resolved.manifest.name)) {
      roots.add(packageRoot);
    }
    for (const dependency of Object.keys(resolved.manifest.dependencies ?? {})) {
      visit(dependency, resolved.manifestPath, false);
    }
    for (const dependency of Object.keys(resolved.manifest.optionalDependencies ?? {})) {
      visit(dependency, resolved.manifestPath, false);
    }
  };

  const importer = join(resolve(packageRoot), 'package.json');
  visit('mermaid', importer, true);
  visit('temml', importer, true);
  return [...roots].sort();
}

/** Every non-virtual module must be inside one exact resolved runtime root. */
export function isVendoredChunk(moduleIds: readonly string[], trustedRoots: readonly string[]): boolean {
  if (moduleIds.length === 0) return false;
  let packages = 0;
  for (const id of moduleIds) {
    const withoutQuery = id.split('?')[0]!;
    if (withoutQuery.startsWith('\0')) {
      if (!TRUSTED_BUNDLER_MODULES.has(withoutQuery)) return false;
      continue;
    }
    const modulePath = canonical(withoutQuery);
    if (!trustedRoots.some((root) => modulePath === root || modulePath.startsWith(root + '/'))) return false;
    packages += 1;
  }
  return packages > 0;
}

/** Final client chunk names whose module ownership is dependency-only. */
export function vendoredClientChunks(
  chunks: readonly ChunkDescription[],
  trustedRoots: readonly string[],
): string[] {
  return [...new Set(
    chunks
      .filter((chunk) => chunk.fileName.startsWith(CLIENT_ASSET_PREFIX))
      .filter((chunk) => isVendoredChunk(chunk.moduleIds, trustedRoots))
      .map((chunk) => chunk.fileName),
  )].sort();
}

interface BundleOutput {
  type: 'asset' | 'chunk';
  fileName: string;
  moduleIds?: readonly string[];
}

/**
 * Vite/Rolldown adapter that writes exact provenance after client chunks exist.
 *
 * Astro invokes output hooks for more than one bundle. State is isolated by
 * output directory and only a bundle carrying client JavaScript can write, so a
 * later server bundle cannot erase the client result. Repeated client outputs
 * union rather than replace their observations.
 */
export function vendorProvenancePlugin(packageRoot: string): {
  name: string;
  apply: 'build';
  enforce: 'post';
  writeBundle: (
    options: { dir?: string },
    bundle: Record<string, BundleOutput>,
  ) => void;
} {
  const byOutDir = new Map<string, Map<string, ChunkDescription>>();
  let trustedRoots: string[] | undefined;
  return {
    name: 'publish:vendor-provenance',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      const clientChunks = Object.values(bundle).filter(
        (output): output is BundleOutput & { type: 'chunk'; moduleIds: readonly string[] } =>
          output.type === 'chunk' &&
          output.fileName.startsWith(CLIENT_ASSET_PREFIX) &&
          Array.isArray(output.moduleIds),
      );
      if (clientChunks.length === 0) return;
      if (options.dir === undefined) return refuse('the client bundle declares no output directory');

      const outDir = resolve(options.dir);
      const observed = byOutDir.get(outDir) ?? new Map<string, ChunkDescription>();
      byOutDir.set(outDir, observed);
      for (const chunk of clientChunks) {
        observed.set(chunk.fileName, { fileName: chunk.fileName, moduleIds: chunk.moduleIds });
      }
      trustedRoots ??= clientRuntimePackageRoots(packageRoot);
      writeVendorProvenance(outDir, vendoredClientChunks([...observed.values()], trustedRoots));
    },
  };
}

/** The non-public, output-specific manifest paired with one output directory. */
export function vendorProvenancePath(outDir: string): string {
  return join(resolve(outDir) + VENDOR_STATE_SUFFIX, VENDOR_PROVENANCE_FILE);
}

function refuse(detail: string): never {
  throw new BuildFailure(
    'vendor-provenance-invalid',
    'vendored chunk provenance is invalid — rebuild the site before scanning it',
    detail,
  );
}

function validateChunkPath(path: unknown): string {
  if (typeof path !== 'string' || !/^_astro\/[^/]+\.js$/.test(path)) {
    return refuse('vendored chunk provenance carries an invalid output name: ' + JSON.stringify(path));
  }
  return path;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validateGrant(value: unknown): VendorGrant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('vendored chunk provenance carries a non-object grant');
  }
  const grant = value as Record<string, unknown>;
  if (Object.keys(grant).sort().join(',') !== 'file,sha256') {
    return refuse('vendored chunk provenance grant does not have exactly file and sha256');
  }
  const file = validateChunkPath(grant['file']);
  if (typeof grant['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(grant['sha256'])) {
    return refuse('vendored chunk provenance carries an invalid SHA-256 digest');
  }
  return { file, sha256: grant['sha256'] };
}

/** Write one complete, deterministic, content-bound manifest. */
export function writeVendorProvenance(outDir: string, chunks: readonly string[]): void {
  const path = vendorProvenancePath(outDir);
  const files = [...new Set(chunks.map(validateChunkPath))].sort();
  const grants = files.map((file): VendorGrant => {
    const candidate = join(outDir, ...file.split('/'));
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      return refuse('cannot grant a vendored chunk that is not in this output');
    }
    return { file, sha256: sha256(candidate) };
  });
  const body: VendorProvenance = { version: VENDOR_PROVENANCE_VERSION, chunks: grants };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(body, null, 2) + '\n', 'utf8');
  renameSync(temporary, path);
}

/**
 * Read and validate the manifest paired with root.
 *
 * Missing means no exemption, which is fail closed. Malformed, unsorted, stale,
 * or non-file entries are a build failure rather than an empty set: those shapes
 * say a producer attempted to grant an exemption and the scanner could not
 * establish what it granted.
 */
export interface VendorProvenanceReadOptions {
  path?: string;
  required?: boolean;
}

export function readVendorProvenance(
  root: string,
  options: VendorProvenanceReadOptions = {},
): ReadonlySet<string> {
  const path = options.path ?? vendorProvenancePath(root);
  if (!existsSync(path)) {
    if (options.required === true) return refuse('the client build wrote no vendored chunk provenance');
    return new Set();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return refuse('could not parse ' + path + ': ' + (error instanceof Error ? error.message : String(error)));
  }
  if (
    typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'chunks,version'
  ) {
    return refuse(path + ' does not have exactly the version and chunks keys');
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== VENDOR_PROVENANCE_VERSION || !Array.isArray(record['chunks'])) {
    return refuse(path + ' has an unsupported version or a non-array chunks value');
  }
  const grants = record['chunks'].map(validateGrant);
  const files = grants.map((grant) => grant.file);
  if (new Set(files).size !== files.length || [...files].sort().some((value, index) => value !== files[index])) {
    return refuse(path + ' chunk names are duplicated or not sorted');
  }
  if (options.required === true && grants.length === 0) {
    return refuse(path + ' grants no chunks to a client diagram build');
  }
  for (const grant of grants) {
    const candidate = join(root, ...grant.file.split('/'));
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      return refuse(path + ' names a file that is not in the built site');
    }
    const relative = candidate.slice(resolve(root).length + 1);
    if (relative.split(sep).join('/') !== grant.file) {
      return refuse(path + ' names a file that does not resolve inside the built site');
    }
    if (sha256(candidate) !== grant.sha256) {
      return refuse(path + ' does not describe the bytes in this build');
    }
  }
  return new Set(files);
}
