# Contributing

Read [`AGENTS.md`](AGENTS.md) first. It is the contributor contract: it names the
architecture authority, the verification gates, what runs where, and what is known
stale and whose it is.

## Before you start

```bash
pnpm install
pnpm run verify          # lint, check, build, inventory, secret/residue scans, tests
pnpm run build:fixture   # the multi-entry corpora the default build skips
```

`pnpm run verify` requires the exact Gitleaks version exported by
`scripts/scan-secrets.ts` on `PATH`.

## Pull requests

- Keep one independently assessable change per pull request.
- State the observable pass condition and the command or browser check you used
  to assess it. A list of implementation steps or an empty test run is not
  completion evidence.
- For an architecture or content-semantics change, update the owning document in
  [`docs/core-design/`](docs/core-design/README.md), the affected consumers, and
  the meaningful invariant tests together. ANC is pre-release and keeps no
  backward compatibility.
- Never commit personal notes, credentials, local identifiers, or a host
  filesystem path.

Report a security problem through [`SECURITY.md`](SECURITY.md), not a public issue.

## Releasing

The package is named `@wxxb789/anc` and registry publication is enabled in
`package.json`. The unscoped `anc` on npm is an unrelated third-party package;
never document or run bare `npx anc` outside a project that has this package
installed.

Publication runs in CI. Pushing a `vX.Y.Z` tag starts
[`release-npm.yml`](.github/workflows/release-npm.yml), which re-runs the release
gates and publishes the tarball the adoption smoke test installed. The job stores
no npm token: it exchanges a GitHub Actions OIDC identity for a short-lived
publish token ("trusted publishing"), so the repository holds no credential that
can publish, and npm records which repository and commit produced each tarball.

A release is one frozen commit that passes every gate, recorded in
[`CHANGELOG.md`](CHANGELOG.md), tagged, and published from the compiled tarball —
never from the repository root. Tagging and publishing are external side effects
and need the owner's explicit approval.

1. Move the `Unreleased` entries in `CHANGELOG.md` under a heading for the new
   version and date, set `version` in `package.json` to match, and commit.
2. On that commit, with a clean tree, run the gates:

   ```bash
   pnpm run verify
   pnpm run build:fixture
   pnpm run smoke:tarball                     # writes wxxb789-anc-<version>.tgz
   gh workflow run action-parity --ref main   # read the run; it is not in verify
   ```

   The tag workflow repeats the first three at the tagged commit, because a tag
   can point at a commit that never ran them. Running them locally first is what
   keeps a failure off the tag, where it costs the version rather than a re-run.
3. Tag the commit. The immutable tag names the exact version and is never moved;
   the major tag is the moving pointer an Action user may follow, and for 0.x
   that is `v0`:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git tag -f v0 "vX.Y.Z^{commit}"
   git push origin vX.Y.Z
   git push -f origin v0
   ```

   Documentation recommends pinning the Action to a full commit SHA; `@vX.Y.Z`
   is the readable exact pin and `@v0` is the convenience pointer.
4. That push is the approval. The workflow publishes and stops; it holds a
   read-only repository token and no npm credential beyond the exchange. Do not
   also run `npm publish` for the same version — the registry refuses the second
   one, and the workflow's is the one that carries provenance.

   If the job fails after the registry accepted the version, do not re-run it:
   republishing is refused. Fix forward with the next version.
5. Create the GitHub release from the tag, with that version's `CHANGELOG.md`
   section as its notes:

   ```bash
   gh release create vX.Y.Z --title vX.Y.Z --notes-file <(sed -n '/^## \[X\.Y\.Z\]/,/^## \[/p' CHANGELOG.md)
   ```

   That stays manual on purpose: generated notes would describe whatever GitHub
   infers between tags, and the moving `v0` pointer makes "the previous tag"
   ambiguous, so the reviewed section is the only notes file worth publishing.

### The first publish

A trusted publisher is configured on an existing package's settings page, so the
first version cannot come from CI: until `@wxxb789/anc` exists, the workflow's
publish fails with `ENEEDAUTH`. Publish that first version once from a clean
checkout, then configure the trusted publisher.

```bash
pnpm run pack:tarball
npm login --scope=@wxxb789
npm publish wxxb789-anc-<version>.tgz      # access: public is in publishConfig
```

The version published this way is not tagged: the registry refuses a version
twice, so the first tag the workflow handles is the next version. `0.0.1` in
`package.json` is the name reservation described in `AGENTS.md`, and it is the
version this step publishes.

Then, npmjs.com → the package → Settings → Trusted publisher → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `wxxb789` |
| Repository | `anc` |
| Workflow filename | `release-npm.yml` — the filename, not a path |
| Environment name | leave empty |
| Allowed actions | `npm publish` |

Keep "Allowed actions" on `npm publish`: `npm stage publish` is granted
automatically, and a direct publish is not. The workflow filename must match
exactly, because npm compares it against the workflow that ran; a mismatch
appears only at publish time, as `ENEEDAUTH`.

A new trusted-publisher configuration expires unless it completes its first
successful publish within two days, so configure it when the next tag is ready
rather than weeks ahead. Once that publish lands, set Settings → Publishing
access to "Require two-factor authentication and disallow tokens": the workflow's
OIDC identity keeps working, and nothing else can publish.

A bare `npm publish` or `npm pack` at the repository root is refused by the
`prepack` hook, because those ship TypeScript that Node cannot strip under
`node_modules`. Deployment remains a separate, explicitly approved step; building
and publishing the package do not deploy a site.
