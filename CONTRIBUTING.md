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
`package.json`, but no version has been published yet and no release tag exists.
The unscoped `anc` on npm is an unrelated third-party package; never document or
run bare `npx anc` outside a project that has this package installed.

A release is one frozen commit that passes every gate, recorded in
[`CHANGELOG.md`](CHANGELOG.md), tagged, and then published from the compiled
tarball — never from the repository root. Tagging and publishing are external
side effects and need the owner's explicit approval.

1. Move the `Unreleased` entries in `CHANGELOG.md` under a heading for the new
   version and date, set `version` in `package.json` to match, and commit.
2. On that commit, with a clean tree, run the gates:

   ```bash
   pnpm run verify
   pnpm run build:fixture
   pnpm run smoke:tarball                     # writes wxxb789-anc-<version>.tgz
   gh workflow run action-parity --ref main   # read the run; it is not in verify
   ```

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

4. Publish the tarball the smoke test wrote:

   ```bash
   npm login --scope=@wxxb789
   npm publish wxxb789-anc-<version>.tgz      # access: public is in publishConfig
   ```

5. Create the GitHub release from the tag, with that version's `CHANGELOG.md`
   section as its notes.

A bare `npm publish` or `npm pack` at the repository root is refused by the `prepack`
hook, because those ship TypeScript that Node cannot strip under `node_modules`.
Deployment remains a separate, explicitly approved step; building and publishing the
package do not deploy a site.
