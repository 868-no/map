#!/usr/bin/env bash
# Checks that every copy of a version in versions.env agrees with it: the
# files that cannot read it (Dockerfiles, go.mod, Cargo.toml, package.json,
# the README's commands, the compose and stack files). Needs only bash and
# grep; CI runs it.
#   scripts/check-versions.sh
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$repo/versions.env"
fail=0

# expect FILE REGEX WANT: REGEX (extended) matches at least once in FILE,
# and every match is WANT.
expect() {
  local file="$1" pattern="$2" want="$3" found
  found="$(grep -oE -- "$pattern" "$repo/$file" | sort -u || true)"
  if [ -z "$found" ]; then
    echo "$file: nothing matches /$pattern/ (want: $want)"
    fail=1
    return
  fi
  while IFS= read -r got; do
    if [ "$got" != "$want" ]; then
      echo "$file: $got (versions.env: $want)"
      fail=1
    fi
  done <<<"$found"
}

expect backend/go.mod '^go [0-9.]+$' "go $GO_VERSION"
expect backend/Dockerfile 'golang:[^ ]+' "golang:$GO_VERSION-bookworm"
expect README.md 'golangci-lint@v[0-9.]+' "golangci-lint@$GOLANGCI_LINT_VERSION"
expect README.md 'govulncheck@v[0-9.]+' "govulncheck@$GOVULNCHECK_VERSION"

expect web/Dockerfile 'rust:[^ ]+' "rust:$RUST_VERSION-slim-bookworm"
expect frontend/engine/Cargo.toml '^wasm-bindgen = "[^"]*"' "wasm-bindgen = \"=$WASM_BINDGEN_VERSION\""
expect web/Dockerfile 'ARG WASM_BINDGEN=.*' "ARG WASM_BINDGEN=$WASM_BINDGEN_VERSION"
expect web/Dockerfile 'ARG BINARYEN=.*' "ARG BINARYEN=$BINARYEN_VERSION"
expect web/Dockerfile 'checksum=sha256:[0-9a-f]+' "checksum=sha256:$BINARYEN_SHA256"

expect web/Dockerfile 'node:[0-9][^ ]*' "node:$NODE_VERSION-bookworm"
expect frontend/package.json '"@playwright/test": "[^"]*"' "\"@playwright/test\": \"$PLAYWRIGHT_VERSION\""
expect README.md 'playwright:v[^ ]+' "playwright:v$PLAYWRIGHT_VERSION-noble"

expect web/Dockerfile '^FROM caddy:.*' "FROM $CADDY_IMAGE"
for file in compose.yaml deploy/compose.production.yaml deploy/stack.swarm.yaml; do
  expect "$file" 'image: postgres:.*' "image: $POSTGRES_IMAGE"
  expect "$file" 'image: redis:.*' "image: $REDIS_IMAGE"
done
expect compose.yaml 'image: eclipse-mosquitto:.*' "image: $MOSQUITTO_IMAGE"

if [ "$fail" -ne 0 ]; then
  echo "Copies differ from versions.env: change them to match (or versions.env, if it is the stale one)."
  exit 1
fi
echo "versions: every copy matches versions.env"
