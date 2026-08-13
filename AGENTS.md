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
pnpm run sync:content   # local-only: read allowlist from the sibling private vault
pnpm run build          # Astro static build + Pagefind + residue scan
pnpm run verify         # every gate: lint, type check, build, residue scan, tests
pnpm run pack:tarball   # compile TypeScript and produce the installable tarball
pnpm run preview        # local verification
```

pnpm is the only supported package manager **for this repository's own install**; `packageManager` in `package.json` pins the version. Its symlinked `node_modules` is a boundary, not a preference: a module that imports a package absent from `package.json` fails to resolve rather than silently borrowing it from a transitive dependency.

`pnpm run pack:tarball` is the one command that shells `npm`, and deliberately: it invokes `npm pack` inside the staging directory it has just built, which is no longer part of this workspace, and npm is what a consumer installs the result with. That is a carve-out for producing an artifact, not for managing this repository's dependencies.

The name is `pack:tarball` rather than `pack` because npm runs `pre`/`post` hooks around *any* script name. `package.json`'s `prepack` refuses a bare `npm pack` — which would otherwise ship this repository's `.ts` sources, which Node cannot strip under `node_modules`, plus a `package.json` naming the private vault's exporter path — and measured, a hook by that name fires for `npm run pack` too and never reaches the script's body. A refusing hook and a script called `pack` cannot coexist.

Cloudflare Pages builds this repository only and never receives access to the private vault.

## Verification

`pnpm run verify` is the gate. It runs lint, type check, build (which ends in the privacy residue scan), and the test suite, chained with `&&` so a failure anywhere aborts the run rather than letting a later step measure a half-written `dist/` and pass it. Run it before proposing a merge and report the pass count.

### What runs where

| Gate | `pnpm run verify` | `pnpm run build` | CI | Cloudflare Pages |
| --- | --- | --- | --- | --- |
| Oxlint | yes | — | yes | — |
| `astro check` | yes | — | yes | — |
| Content contract + derived-route validation | yes | yes | yes | yes |
| Astro build, redirects, Pagefind index | yes | yes | yes | yes |
| Residue scan over `dist/` — markers, paths, schemes, source maps | yes | yes | yes | yes |
| Test suite | yes | — | yes | — |
| Rendered-browser gates (Playwright) | when Chromium is installed | — | yes, always | — |

CI (`.github/workflows/verify.yml`) runs `pnpm run verify` rather than restating its steps, so the two cannot drift; `tests/verify.test.ts` fails if a gate is ever spelled out in the workflow instead. Cloudflare Pages runs `pnpm run build`, which is why the residue scan is a link of `build` and not only of `verify` — the host that publishes the artifact scans it.

**The repository has no git remote, so the workflow does not run yet.** Until one exists, every gate above is enforced only by running `pnpm run verify` on the host.

### Still manual

- Deployment. Requirements section 21.1 stage 13 makes it a separately approved action; CI deliberately cannot deploy and needs no secrets.
- Post-deploy smoke tests (stage 14), which need a deployed origin.
- Secret scanning (section 19.1's Gitleaks item), non-allowlisted titles and slugs, and unexpected routes or assets. The residue scan closes six of section 19.1's nine items; these are the other three. The last two are route-model properties that TK-09's deny-by-default assets gate owns.
- `pnpm run build:fixture`, the 32-note corpus that un-skips the five multi-entry gates. Not in `verify` because it builds the site twice.
- `pnpm run pack:tarball`, which compiles this package's TypeScript to JavaScript and packs the tarball. Not in `verify` because the artifact is a release step, not a gate — but the compile itself *is* gated: `tests/packaging.test.ts` stages a package on every run and asserts it carries no `.ts`, `.map`, or `.d.ts`, and no surviving `.ts` specifier.
- `git diff --check`, which reads the working tree rather than the artifact and so belongs to the commit step, not the build.
- `pnpm run sync:content`, which reads the private vault and by design never runs anywhere but a trusted host.

### Properties the gates assert

- Generated routes and `content-index.json` are readable.
- No horizontal overflow, browser console error, or broken internal link.
- Search opens and indexes published pages.
- Backlinks and hover previews contain only allowlisted page metadata.
- `dist/` carries no `msw/` marker, unresolved `[[wikilink]]`, absolute local path, unsafe URL scheme, non-image `data:` URL, or source-map reference — in raw, entity-decoded, or invisible-character-stripped form.
- Nothing the CLI writes to stdout or stderr changes when the corpus is renamed. A workflow log is world-readable and retained for 90 days, so a host filesystem path and the name of a file the build did not publish are both disclosures; the counts go to the stream and the names go to `content-report.json`, which is written under the git directory where no `git add` can reach it.

## Documentation

Astro documentation: https://docs.astro.build
Pagefind documentation: https://pagefind.app/docs/
Cloudflare Pages documentation: https://developers.cloudflare.com/pages/
