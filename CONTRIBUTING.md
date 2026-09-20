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
