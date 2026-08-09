# thoughtscape-publish

A static public projection from the private `ob-flow` vault.

## Architecture

- Astro static output; Cloudflare Pages build output is `dist/`.
- Content is an explicit allowlist exported by `ob-flow/.harness/publish/`.
- Backlinks and hover previews are generated at build time.
- Pagefind provides static search.
- No D1, R2, Functions, or private-vault access is required at runtime.

## Local workflow

```bash
pnpm install
pnpm run sync:content
pnpm run build
pnpm run preview
```

`packageManager` in `package.json` pins the pnpm version, which Corepack honours when it is enabled (`corepack enable`). Dependencies install into a symlinked `node_modules`, so a package that is not declared in `package.json` does not resolve.

The generated `src/data/content.json` and `public/content-index.json` are committed to this public repository. Cloudflare builds only this repository; it never receives the private vault.

## Cloudflare Pages

```text
Framework preset: Astro
Build command: pnpm run build
Build output: dist
Node version: 24
PNPM_VERSION: 11.18.0
```

`PNPM_VERSION` is set explicitly because the v3 build image documents that it infers a pnpm version from neither `pnpm-lock.yaml` nor `package.json` → `engines`. Whether it reads `packageManager` is not documented either way, which is reason enough to set the variable rather than depend on it. Setting it is what keeps the host on the version this lockfile was written by.

An unset variable is a degraded build rather than a broken one, but not an equivalent one. The image's own default is pnpm 10, which reads `lockfileVersion: '9.0'` and — since v10 — runs no dependency install script unless one is approved, so the tree still installs and `esbuild` still stays denied. What is lost is the *reviewed* denial: `allowBuilds` arrived in pnpm 10.26, and an older pnpm knows only `onlyBuiltDependencies`/`ignoredBuiltDependencies`, so on such a version the denial comes from the default rather than from a decision recorded in `pnpm-workspace.yaml` — and a future package that genuinely needs its build script would fail quietly instead of loudly. This is documented rather than worked around because no Pages build has been run: deployment needs explicit approval and is outside this ticket.

Add D1 or R2 only after a measured requirement cannot be satisfied statically. Publication remains an explicit external side effect; syncing content does not deploy.
