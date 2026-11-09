/**
 * Copy the artifact's image assets into the built output.
 *
 * Goal 0009's emission step, and deliberately the only one: the producer decides
 * *which* images publish (it reads, authorizes, hashes and rewrites them), and
 * this step asks the artifact for the resulting URL list and moves those bytes
 * into `dist/_assets/`. No second decision lives here — no image is inferred from
 * a directory, no reference is re-parsed out of Markdown, and nothing is
 * transformed.
 *
 * ## Why the bytes come from beside the artifact
 *
 * The artifact carries public URLs only. Its bytes live in
 * `<artifact directory>/assets/<digest>-<name>` — the published filename — so this
 * step runs identically for the packaged build (a temporary workspace) and for
 * this repository's fixture build (a committed directory) without either being
 * told where the author's notes are. That is also what keeps the content root out
 * of every gate downstream of the producer: the output inventory never learns a
 * source path.
 *
 * ## What it refuses
 *
 * - a declared asset whose bytes are absent, non-regular (a symlink), of a
 *   different content digest, or of a format its extension does not name — a
 *   content-addressed URL that no longer describes its bytes is the one property
 *   this scheme cannot tolerate;
 * - a source directory holding files the artifact does not declare, because that
 *   is a stale asset from another build sitting where a publication step reads;
 * - silently copying fewer files than declared. The returned count is the
 *   assertion the tests and the inventory both use.
 *
 * The public half of every failure is a count and a literal; the file is the
 * report's. A staged asset name is already public — it is the URL a reader
 * fetches — but the rule is kept uniform rather than reasoned per message.
 */

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_DIRECTORY, imageExtension, parseAssetUrl, sniffImageFormat } from '../src/lib/media.ts';
import { artifactPath, loadArtifact } from '../src/lib/artifact-source.ts';
import type { ContentArtifact } from '../src/lib/schema.ts';
import { BuildFailure } from './write-report.ts';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/**
 * The directory the artifact's bytes are staged beside, under the published name.
 *
 * A fixed sibling name rather than a field in the artifact: the pair
 * `<artifact>.json` plus `assets/` is the contract, and one name in one place is
 * what lets the producer, the emission step, and every test agree without a
 * lookup table.
 */
export function assetSourceDirectory(artifactFile: string): string {
  return join(dirname(artifactFile), 'assets');
}

/** The published filename one declared asset URL names. */
function publishedName(url: string): { digest: string; fileName: string; file: string } {
  const parsed = parseAssetUrl(url);
  if (parsed === undefined) {
    throw new Error(`the artifact declares an asset URL this build cannot parse: ${url}`);
  }
  return { ...parsed, file: `${parsed.digest}-${parsed.fileName}` };
}

/**
 * Copy every declared asset into `<root>/_assets/` and return how many were written.
 *
 * @param root The built output directory.
 * @param artifact The validated artifact, whose `assets` list is the exact set.
 * @param sourceDirectory Where the producer staged the bytes; see
 *   {@link assetSourceDirectory}.
 */
export function copyAssetsToOutput(root: string, artifact: ContentArtifact, sourceDirectory: string): number {
  const assets = artifact.assets ?? [];
  if (assets.length === 0) return 0;

  const declared = assets.map((url) => ({ url, ...publishedName(url) }));
  const accepted = new Set(declared.map((asset) => asset.file));

  let present: string[];
  try {
    present = readdirSync(sourceDirectory);
  } catch (error) {
    throw new BuildFailure(
      'asset-source-missing',
      `the build declares ${assets.length} image asset${assets.length === 1 ? '' : 's'} but staged none`,
      `could not read the asset staging directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // A file the artifact does not declare is a stale asset from an earlier build
  // sitting in the one directory a publication step reads. Refused rather than
  // ignored: the next reader would be the output inventory, and the finding would
  // name the output instead of the stale input.
  const extra = present.filter((name) => !accepted.has(name));
  if (extra.length > 0) {
    throw new BuildFailure(
      'asset-source-mismatch',
      `${extra.length} staged image file${extra.length === 1 ? '' : 's'} match no asset this build publishes`,
      extra.sort().join('\n'),
    );
  }

  const directory = join(root, ASSET_DIRECTORY);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  let written = 0;
  for (const asset of declared) {
    const path = join(sourceDirectory, asset.file);
    let bytes: Buffer;
    try {
      if (!lstatSync(path).isFile()) {
        throw new BuildFailure(
          'asset-source-missing',
          'a declared image asset is not a regular file in the staging directory',
          `${asset.file}: not a regular file`,
        );
      }
      bytes = readFileSync(path);
    } catch (error) {
      if (error instanceof BuildFailure) throw error;
      throw new BuildFailure(
        'asset-source-missing',
        'the build declares an image asset its staging directory does not contain',
        asset.file,
      );
    }

    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== asset.digest) {
      throw new BuildFailure(
        'asset-source-digest',
        'a staged image does not hash to the digest its published URL names',
        `${asset.file}: expected ${asset.digest}, found ${digest}`,
      );
    }
    const format = sniffImageFormat(bytes);
    const extension = asset.fileName.slice(asset.fileName.lastIndexOf('.'));
    if (format === undefined || imageExtension(format) !== extension) {
      throw new BuildFailure(
        'asset-source-format',
        'a staged image is not the format its published URL names',
        `${asset.file}: detected ${format ?? 'no supported image format'}, URL extension ${extension}`,
      );
    }
    writeFileSync(join(directory, asset.file), bytes);
    written += 1;
  }
  return written;
}

/** This repository's own build may print a count; see `verify-output-inventory.ts`. */
function main(): number {
  try {
    const artifact = loadArtifact();
    const count = copyAssetsToOutput(DIST, artifact, assetSourceDirectory(artifactPath()));
    console.log(`image assets ok: ${count} files`);
    return 0;
  } catch (error) {
    console.error(error instanceof BuildFailure ? error.detail : error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
