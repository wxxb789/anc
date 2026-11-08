# 0013 — Optional managed image hosting

Status: provisional. Created: 2026-11-08. Source: [media RFC #31](https://github.com/wxxb789/anc/issues/31).

## Intended advance

An author who actually needs a separate image host can opt into a simple, reliable publishing workflow: write Markdown with local images, choose a supported storage/CDN provider, and publish without manually uploading or maintaining image URLs. The **default remains same-origin GitHub Pages / Cloudflare Pages static assets**, requiring no account, image key, provider SDK or additional configuration.

This is an optional publishing capability, not a mandate to introduce a media management system. Existing HTTPS remote-image URLs already work without a provider integration; simply preserving those URLs does **not** complete this goal.

## Prerequisite

Requires the accepted local-asset and publication-boundary outcome from [0009](0009-zero-config-static-images.md). Image optimization from [0011](0011-webp-first-image-delivery.md) can improve costs but need not block provider-independent publishing correctness. This is a later priority than local image display and automatic optimization.

## Material bounds already decided

- No automatic upload, network request or cloud cost as a side effect of an ordinary local `anc build`. Remote publication must be an explicitly authorized publishing action and must not replace the existing release qualification, deployment ownership or review gate.
- Only bytes authorized for publication may be uploaded. Publish an HTML version referencing remote media **after** the upload and accessibility/identity checks necessary to avoid broken links. A failed upload or remote verification must not silently publish broken image references or overwrite a valid previous site.
- Credentials remain outside source content and public artifacts/logs. Preserve content-based identities, deduplication, safe retries and a documented withdrawal/retention contract. Removing a reference from a generated site must not be misrepresented as immediately deleting third-party cached copies.
- Keep the integration narrow and dependency-light; do not mirror a vendor's media dashboard, transformation language or client SDK in ANC. S3-compatible storage / Cloudflare R2 is an initial candidate, with ImageKit, Cloudinary, OSS and COS considered based on real user demand—not a commitment to implement all providers.
- The same-origin zero-configuration path remains fully usable when no optional provider is configured or when the provider service is unavailable.

## Provisional completion basis

A later run should show an end-to-end publish from a foreign notes repository to **one justified provider**, where an explicitly authorized action makes exactly the permitted images accessible by stable CDN URLs and publishes correct referencing HTML; duplicate and unchanged inputs do not trigger unnecessary uploading. Failure, revoked permission, missing remote object, credential leakage and withheld-asset controls must be demonstrated with actual provider behavior or a clearly bounded test substitute, with no unverified live-deployment claim.

**Refine before activation:** establish real provider demand, the first provider/public URL contract, credentials or an authorized safe test environment, and the publication/rollback/withdrawal behavior that users expect. A product choice that only the maintainer can make must be resolved before marking this goal ready. Do not design a speculative generic adapter framework or create a second default publishing mode to satisfy a test.

This goal is **not ready to run yet**. Refine the goal against earlier evidence before creating a definitive `Done when` contract.
