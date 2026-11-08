# 0013 — Optional Cloudflare R2 media publishing

Status: ready. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

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

Requires [0009 — Zero-config static images](0009-zero-config-static-images.md)
to be accepted. [0011 — WebP-first delivery](0011-webp-first-image-delivery.md)
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
