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
npm install
npm run sync:content
npm run build
npm run preview
```

The generated `src/data/content.json` and `public/content-index.json` are committed to this public repository. Cloudflare builds only this repository; it never receives the private vault.

## Cloudflare Pages

```text
Framework preset: Astro
Build command: npm run build
Build output: dist
Node version: 24
```

Add D1 or R2 only after a measured requirement cannot be satisfied statically. Publication remains an explicit external side effect; syncing content does not deploy.
