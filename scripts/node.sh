#!/usr/bin/env bash
# Run Node tooling inside a pinned image so the host needs only Docker.
#   scripts/node.sh npm install          (cwd inside container: frontend/)
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${NODE_IMAGE:-node:22.21.1-bookworm}"
tty_flag=()
[ -t 1 ] && tty_flag=(-t)
# The cache: a named volume, or with MESHMAP_CACHE a directory under it
# (CI saves and restores it between runs on GitHub-hosted runners).
if [ -n "${MESHMAP_CACHE:-}" ]; then
  cache="$MESHMAP_CACHE/node"
  mkdir -p "$cache"
else
  cache=meshmap-node-cache
  # A fresh named volume is root-owned: hand it to the calling user first.
  docker run --rm -v "$cache":/cache "$image" sh -c "chown $(id -u):$(id -g) /cache"
fi
exec docker run --rm "${tty_flag[@]}" \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp/home -e npm_config_cache=/cache/npm \
  -v "$cache":/cache \
  -v "$repo":/src -w /src/frontend \
  --network "${NODE_NETWORK:-bridge}" \
  ${NODE_PORTS:+-p "$NODE_PORTS"} \
  "$image" "$@"
