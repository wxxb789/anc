#!/usr/bin/env bash
set -euo pipefail

# SHA-256 values are from the checksums asset attached to this exact release.
# https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1
version='8.30.1'
base_url="https://github.com/gitleaks/gitleaks/releases/download/v${version}"

if [[ "$(uname -s)" != 'Linux' ]]; then
  echo 'Gitleaks setup supports Linux runners only' >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    archive="gitleaks_${version}_linux_x64.tar.gz"
    checksum='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
    ;;
  aarch64|arm64)
    archive="gitleaks_${version}_linux_arm64.tar.gz"
    checksum='e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'
    ;;
  *)
    echo 'Gitleaks setup does not support this runner architecture' >&2
    exit 1
    ;;
esac

destination="${RUNNER_TEMP:?RUNNER_TEMP is required}/thoughtscape-gitleaks-${version}"
mkdir -p "$destination"
if [[ ! -x "$destination/gitleaks" ]] ||
   [[ "$("$destination/gitleaks" version 2>/dev/null || true)" != "$version" ]]; then
  curl --fail --location --silent --show-error --retry 3 \
    "$base_url/$archive" --output "$destination/$archive"
  printf '%s  %s\n' "$checksum" "$destination/$archive" | sha256sum --check --status
  tar --extract --gzip --file "$destination/$archive" --directory "$destination" gitleaks
  chmod 0755 "$destination/gitleaks"
fi

if [[ "$("$destination/gitleaks" version)" != "$version" ]]; then
  echo 'Gitleaks setup produced the wrong version' >&2
  exit 1
fi

printf '%s\n' "$destination" >> "${GITHUB_PATH:?GITHUB_PATH is required}"
