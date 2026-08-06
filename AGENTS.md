# thoughtscape-publish Agent Contract

> `AGENTS.md` is canonical. `CLAUDE.md` is a symlink to this file.

## Goal

Build a static, privacy-preserving public projection from an explicit allowlist in the private ob-flow vault.

## Boundaries

- This repository is public-facing. Never copy the private vault, `msw/`, source archives, credentials, local identifiers, or unpublished notes into it.
- `src/data/content.json` and `public/content-index.json` are generated only by the reviewed exporter in `ob-flow/.harness/publish/`.
- Publication and deployment are external side effects requiring explicit approval. A successful local build is not deployment authorization.
- Keep runtime static. D1, R2, Functions, analytics, comments, or other stateful services require a measured need and a separate design decision.

## Workflow

```bash
npm run sync:content   # local-only: read allowlist from the sibling private vault
npm run build          # Astro static build + Pagefind
npm run preview        # local verification
```

Cloudflare Pages builds this repository only and never receives access to the private vault.

## Verification

- `npm run build` passes.
- Generated routes and `content-index.json` are readable.
- No horizontal overflow, browser console error, or broken internal link.
- Search opens and indexes published pages.
- Backlinks and hover previews contain only allowlisted page metadata.
- `git diff --check` passes and generated output contains no `msw/` or unresolved `[[wikilinks]]`.

## Documentation

Astro documentation: https://docs.astro.build
Pagefind documentation: https://pagefind.app/docs/
Cloudflare Pages documentation: https://developers.cloudflare.com/pages/
