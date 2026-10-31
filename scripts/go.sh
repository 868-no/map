#!/usr/bin/env bash
# Run Go tooling inside the pinned golang image so the host needs only Docker.
# Usage: scripts/go.sh go test ./...      (cwd inside container: backend/)
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${GO_IMAGE:-golang:1.26-bookworm}"
tty_flag=()
[ -t 1 ] && tty_flag=(-t)
exec docker run --rm "${tty_flag[@]}" \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp/home -e GOCACHE=/cache/build -e GOMODCACHE=/cache/mod -e GOFLAGS="${GOFLAGS:-}" \
  -e PATH=/cache/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -e GOBIN=/cache/bin \
  -v meshmap-go-cache:/cache \
  -v "$repo":/src -w /src/backend \
  --network "${GO_NETWORK:-bridge}" \
  "$image" "$@"
