#!/usr/bin/env bash
# Run the mesh derivation natively against a deployment's rows (the engine's
# probe, tools/probe): what the map would show, without a browser. Builds it
# with the host's cargo; release binaries for Linux, macOS and Windows need
# nothing else (.github/workflows/probe.yml).
#   scripts/probe.sh help
#   scripts/probe.sh node Gråkallen
#   scripts/probe.sh --hours 24 health
#   scripts/probe.sh --start 2026-11-14 --end 2026-11-15 view snapshot | jq .counts
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Release speed without the release binaries' whole-program link.
exec cargo run --quiet --locked --profile fast --manifest-path "$repo/tools/probe/Cargo.toml" -- "$@"
