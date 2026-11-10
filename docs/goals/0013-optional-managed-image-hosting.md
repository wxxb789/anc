# 0013 — Optional Cloudflare R2 media publishing

Status: in progress — implementation and local failure suite complete; live R2
and custom-domain round trip outstanding. Created: 2026-11-08. Source:
[media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Desired outcome

An author who needs an independent image host can explicitly publish
their already-authorized local images to **Cloudflare R2** and serve
them through a public custom-domain CDN URL without manually uploading
files or editing Markdown. Default GitHub Pages/Cloudflare Pages
same-origin image delivery remains **zero configuration**.

This is optional hosted publishing, not a new default and not a
general media-host management system. Existing HTTPS image links
already work without it.

## Prerequisite and accepted design

Requires [0009 — Zero-config static images](archive/0009-zero-config-static-images.md)
to be accepted. [0011 — WebP-first delivery](archive/0011-webp-first-image-delivery.md)
may reduce upload/storage cost but does not block R2 publishing correctness.

The [accepted media design](../core-design/media-pipeline.md#0013--opt-in-cloudflare-r2-image-publishing)
already selects **Cloudflare R2**, **pinned `aws4fetch` 1.0.20**, S3
signed operations, production custom-domain delivery, content-addressed
immutable object keys, environment-only credentials, atomic conditional
uploads and a publish-after-verification barrier. Implementation should
not reopen provider or dependency selection.

- Ordinary `anc build`, `anc preview`, `anc build --release`
  and their standard GitHub Action path remain offline and free from
  R2 dependencies, image-service accounts and surprise cloud charges.
  Only a deliberate opt-in release action can upload.
- First-provider scope is **R2 only**, not all S3-compatible services,
  ImageKit, Cloudinary, OSS or COS. Existing R2 bucket and public
  custom domain are required only for users who opt in; no default
  account creation or extra deploy infrastructure.
- Only public, explicitly permitted image content may cross the network.
  Preserved publication review, exact output inventory, security scanning
  and failed-output preservation must not be weakened.
- The existing site deployment remains separate; ANC guarantees
  correctly prepared media-bound static output, not one distributed
  transaction across GitHub/Cloudflare Pages and R2. A failed
  upload must never be mislabeled a successful deployable build.
  Do not automatically delete immutable objects used by past releases.

## Done when

1. A foreign-repository installed ANC product offers a clear opt-in R2
   release flow and documented bucket, account endpoint, custom domain
   and CI/environment credential setup. With no opt-in, all ordinary
   builds and previews remain offline, same-origin and unchanged.
2. An end-to-end exercise uploads only referenced authorized images
   under final-byte hash keys, verifies remote object identity and
   public HTTPS media reachability, and emits actual static HTML
   referencing correct remote URLs. Unchanged/repeated inputs reuse
   existing objects; changed inputs receive new paths without overwrites.
3. Concurrent writers, already-existing mismatched objects, rejected,
   delayed or ambiguously completed uploads, wrong MIME/size/checksum,
   missing public DNS/404 (including cached 404), lost credentials,
   unsafe endpoint redirects and upload timeouts are exercised through
   controlled failure tests. None may replace the preceding good
   output, leak tokens or private names, upload withheld assets, or
   publish a candidate with broken links.
4. The real packaged result uses normal browser HTTPS image loading
   with no new client JavaScript, DB/Worker/WASM work, public manifest,
   image proxy, mandatory image encoder, or additional site-hosting
   integration. Browser images work under the existing CSP.
5. Repeatable evidence records the installed dependency footprint,
   fresh/repeated API operations and bytes, orphan/withdrawal policy,
   working static output, and checks through the existing verification
   workflow. Claims about production R2 compatibility require a
   **real authorized R2 + custom-domain exercise**; absent credentials
   are a disclosed integration-evidence gap, not a fabricated test
   success. Comprehensive failure testing must run without any
   maintainer-owned cloud account.

The agent should implement and verify the committed contract with
reversible defaults. At the start, flag an indispensable
maintainer-only input if one is required to complete live provider
validation; otherwise use deterministic local protocol tests and
report the independent implementation evidence. Stop for irreversible
or out-of-scope choices. Report each completion item with measured
evidence, limitations and failures.

## Implementation progress

Branch `feat/0013-r2-media-publishing`, based on `origin/main` `7d27414`
(Goals 0009/0010/0011 present). The implementation and its failure suite are
complete on this tree. The goal is **not archived**: a live R2 bucket plus a
public custom-domain round trip was **not** performed, because this host has no
authorized Cloudflare account or bucket credentials. That is a disclosed
integration-evidence gap, not a passed production check and not a fabricated
result.

### What exists

- `anc build --release --media r2` is the only action that may write remotely.
  `--media` is refused without `--release`, and an ordinary build clears the
  delivery seam. `bin/anc.mjs` imports `scripts/publish-media.ts` only on that
  branch; that module imports `aws4fetch` only inside its publish function.
- `publish.config.yaml` has one optional `media:` table: `provider: r2`,
  `bucket`, `endpoint`, `public_base_url`, `access_key_id_env`, and
  `secret_access_key_env`. Unknown keys, wrong types, missing required keys,
  non-HTTPS or path-bearing URLs, userinfo, `r2.dev` hostnames, malformed bucket
  names, malformed environment names, and a repeated environment name are
  refused by `scripts/load-config.ts`. Credentials are read only from the two
  named environment variables.
- `scripts/publish-media.ts` plans objects only from the artifact's declared
  assets and their staged emitted bytes; the key is the canonical published
  `_assets/<sha256>-<name>` path, and the MIME type is the emitted extension's
  format (already checked against the bytes by the copy gate). It issues
  `PutObject` with `If-None-Match: *`, `Content-Type`, immutable `Cache-Control`
  and `Content-MD5`; a `412` reads and hashes the winner instead of overwriting;
  every retry is another conditional write. Existing objects are proven by
  reading and hashing their bytes, not by size, MIME, or ETag. All objects are
  made available before any public URL is fetched, and every public URL is then
  fetched over the custom domain and hashed before the candidate is promoted.
  Redirects are refused with `redirect: 'manual'` on both paths. Object size is
  bounded by the validated 32 MiB image budget; concurrency, attempts and
  request time are finite (4 workers, 3 attempts, 30 s per request).
- `src/lib/media-delivery.ts` and `src/lib/markdown.ts` rewrite an authorized
  asset's `src` to the configured bare HTTPS origin only when the opted-in build
  set the internal environment seam. The artifact, staged filename, object key,
  output inventory and local `dist/_assets/` copy all keep the same-origin path.
  No client JavaScript, manifest, Worker, SQLite field, image proxy or
  multi-provider abstraction was added; the existing `img-src 'self' data: https:`
  CSP is unchanged.
- `aws4fetch` is pinned to exactly `1.0.20` without a range, and
  `pnpm-workspace.yaml` records it as reviewed with build scripts denied.
- The binary sets `ASTRO_TELEMETRY_DISABLED=1` before any command imports Astro.
  Without that, an ordinary `preview` still posted to
  `https://telemetry.astro.build/api/v1/record`, so the shipped command was not
  actually offline even though this repository's CI set the variable.

### "Done when" → evidence

1. **Opt-in flow and setup.** `docs/adoption.md` documents the bucket, S3 API
   endpoint, public custom domain, API token, configuration table, exact
   `build --release --media r2` command, CI environment variables, failure
   semantics and orphan policy. `tests/media-r2-build.test.ts` proves
   `--media r2` without `--release` exits 1 before reading content, and that
   ordinary `build`, `preview` and `build --release` make zero traced network
   requests and resolve no `aws4fetch` module while the media table and
   credentials are present. The packaged smoke installs the tarball, reads
   `node_modules/aws4fetch/package.json` as version `1.0.20`, and runs the
   documented media release.
2. **End-to-end exercise.** `tests/media-r2-build.test.ts` first publishes one
   referenced image, observes `1 referenced, 1 uploaded, 0 already present, 1
   verified`, and reads the emitted absolute custom-domain URL from the actual
   HTML. The second run reports `0 uploaded, 1 already present, 1 verified`;
   changed source bytes produce a new content-addressed URL while the old object
   remains. The packaged smoke publishes the 7 unique assets of its foreign
   corpus, checks each remote object's bytes against `dist-r2/_assets`, and
   finds 10 absolute HTTPS `<img>` URLs. A withheld note's asset, a
   pattern-excluded draft's asset, and an excluded asset referenced by a
   published note are covered separately; the first two never reach the
   network, and the third fails before it.
3. **Controlled failure tests.** Each case below is a named test in
   `tests/media-r2.test.ts` or `tests/media-r2-build.test.ts`, against a local
   Node HTTP protocol fake that speaks HEAD, PUT and GET and validates the
   conditional header, authorization key and `Content-MD5`:
   - `the loader refuses every malformed media table the goal names`:
     provider, missing keys, HTTP, `r2.dev`, userinfo, paths, bucket, type,
     environment name, repeated name, eaten YAML tag.
   - `missing, rejected and under-privileged credentials fail without an
     upload`: 401 and 403, no object, no credential value on either stream.
   - `a wrong bucket, an unreachable endpoint and a redirect to another host
     fail closed`: 404, connection refused, and a 307 whose target server
     records zero requests.
   - `a 412 from a concurrent writer verifies the winner and never overwrites
     it`; `a 412 whose object holds different bytes fails instead of replacing
     it`; `a second publication reuses every existing object without uploading
     bytes`.
   - `an existing object with the wrong MIME, size or bytes behind the claimed
     digest is refused`.
   - `a dropped response after the server committed is retried conditionally
     and verified`; `a dropped response before the server committed is retried
     and uploaded`; the two withheld-response timeout cases cover commit and
     no-commit; `a partial upload is retried`, and persistent partial or
     withheld uploads fail after the bounded budget.
   - `a public 404 after a successful upload fails the run`; `a cached 404 that
     persists after a later successful PUT fails the run`; public wrong bytes,
     wrong length and wrong MIME fail; `a public redirect is refused rather than
     followed`.
   - `a staged digest mismatch, a missing file and an oversized object never
     reach the network`; `a repeated asset URL is deduplicated to one
     conditional write`.
   - `a failing upload in the middle of a set fails the run and leaves the
     previous output`: the earlier good `dist` is byte-identical afterwards,
     the already-uploaded object remains as an allowed orphan, and the failing
     object is not stored.
   - `assets referenced only by withheld or pattern-excluded notes are never
     uploaded`; `an excluded asset referenced by a published note fails before
     any request`.
4. **Packaged static result.** The packaged smoke's R2 phase serves its
   `dist-r2` under the generated `_headers` and loads it in Chromium with page
   scripts disabled; image requests to the custom-domain origin are fulfilled
   from the fake's stored bytes. It observes 10 images with non-zero
   `naturalWidth`, the unchanged `img-src 'self' data: https:` policy, no
   same-origin asset path in the media page, and no `r2.dev` URL. The ordinary
   browser phase continues to cover the same-origin default and its Worker,
   WASM, snapshot and preview surfaces.
5. **Repeatability and footprint.** The packaged smoke performs 8 fresh
   uploads, then a second release with `0 uploaded, 8 already present, 8
   verified`; it checks that all 8 objects still exist and match local emitted
   bytes. The local publisher tests assert Content-MD5 covers exactly the
   stored bytes, immutable cache metadata, finite limits, and stable reuse.
   Footprint measurements are recorded under "Footprint" below.

### Footprint

- `aws4fetch@1.0.20` installs **1 package**, **9 files**, **51,012 bytes** on
  disk (`du -sb`; npm reports 65,541 bytes of unpacked content including
  directory entries), with **zero transitive dependencies**. `pnpm-lock.yaml`
  gains exactly one resolved package entry; Astro/unstorage already listed it
  as an optional peer, so no other package entered the tree.
- The tarball declares the signer instead of bundling its files. Packing this
  tree produced **504,985 bytes** in **121 entries**, SHA-256
  `95e30784309cac1dc2045633906ea7d058990dfb1687f6270d54e6e4e3bfe39b` — 13,539
  bytes more than `main`'s 491,446-byte 0012 tarball, which covers this goal's
  own compiled modules plus the one manifest line.

### Review fixes

Two findings from the first review round are closed with locked tests:

- The `media:` table's unknown-key and eaten-tag diagnostics printed the
  user-authored *key text* into the public stderr message. Both now report only
  the member's line number and, where one exists, the known-key suggestion; the
  key itself stays in the private report — tested with a key shaped like a home
  path and a credential.
- Both verification reads buffered the whole body before the 32 MiB budget was
  checked, so a chunked response from a misconfigured domain could exhaust the
  build host's memory. Both paths now hash incrementally and cancel at the
  budget: measured by counting what the application itself pulled from the
  stream, a 40 MiB body stops at 33,568,949 bytes (public) and 33,605,319
  (existing object), i.e. one chunk past the budget rather than the whole body.

### Gates

- `pnpm exec vitest run tests/media-r2.test.ts tests/media-r2-build.test.ts
  --maxWorkers=1`: **2 files, 38 tests passed**.
- `pnpm run lint`: exit 0. `pnpm run check`: 243 files, 0 errors, 0 warnings,
  2 hints.
- `pnpm run build`: 10 pages; `output inventory ok: 150 files`; `residue scan ok:
  34 files, 0 findings`.
- `pnpm run pack:tarball`: compiled 84 TypeScript files, rewrote specifiers in
  24; tarball 504,985 bytes, 121 entries, SHA-256
  `95e30784309cac1dc2045633906ea7d058990dfb1687f6270d54e6e4e3bfe39b`.
- `pnpm run smoke:tarball`: exit 0, `tarball adoption smoke ok: 2 published
  notes, 2 withheld notes, 8 images`; the media phase asserted 8 fresh uploads,
  8 remote objects matching local emitted bytes, 10 absolute image URLs, 8
  reused on the second release, and a real Chromium decode of every absolute
  image under the generated CSP.
- `pnpm exec vitest run --maxWorkers=1`: **100 files, 1,252 tests passed, 35
  skipped** (1,287 total; 655.56 s) — `main`'s baseline plus this goal's two
  files and 38 tests.
- `node scripts/build-site.ts --scan-secrets` (verify's build link, with the
  pinned Gitleaks 8.30.1 on `PATH`, run before the rebase onto 0012): 10 pages;
  `output inventory ok: 150 files`;
  `secret scan ok: 150 files, 0 findings`; `residue scan ok: 34 files, 0
  findings`.
- `pnpm run lint`: exit 0.
- `pnpm run check` (`astro check`): 243 files, 0 errors, 0 warnings, 2 hints.

`pnpm run verify` was not invoked as one command on this 7 GB host: its test
phase runs `--maxWorkers=4` alongside the build chain, and a previous session
scope was killed by `systemd-oomd` at 94.7% memory while work overlapped. Its
components were run serially instead — lint, `astro check`, the build with the
pinned secret scan, and the test suite with one worker — and the observed counts
are recorded here.


### Limitations

- **No live R2/custom-domain exercise.** The publisher has been exercised
  against a real HTTP protocol fake, not against Cloudflare. DNS, token scope,
  bucket policy, custom-domain TLS, Cloudflare cache behaviour and R2's real
  response headers remain untested here. A maintainer with an authorized bucket
  and a connected custom domain must run the documented flow before production
  compatibility is claimed.
- The browser check for the R2 output intercepts the custom-domain requests and
  fulfills them from the protocol fake. It proves the absolute URL, CSP, `<img>`
  loading and emitted bytes, not Cloudflare's own delivery.
- Ordinary builds still write the local `_assets/` copies; the remote object is
  a second copy of one identity, not a removal of the local artifact. That is
  required by the artifact and the exact output inventory.
- Orphans are never deleted. Removing or changing a note/asset does not revoke
  cached copies or authorize automated remote deletion.
- `HEAD` is implemented by the test fake but not used by the publisher: size,
  MIME and ETag are not SHA-256 proof, so existing objects are read and hashed.
- Windows and macOS were not exercised on this host. The publisher uses Node's
  built-in fetch/WebCrypto and the pinned signer with no native binding; only
  Linux x64 was run here.
- Only Cloudflare R2 is implemented. Generic S3, OSS, COS, ImageKit, Cloudinary,
  an upload daemon, an upload manifest, a multi-provider adapter, a browser SDK
  and an image proxy are deliberately absent.
