#!/usr/bin/env bash
# Lists dependencies with newer releases, per ecosystem. Only reports: it
# changes nothing, and finding updates never fails. Upgrades are made by hand
# when there is time for them (a release at least two weeks old, then the
# full test suite), not on every new version.
#   scripts/outdated.sh
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== Go modules (backend/go.mod, direct dependencies)"
"$repo/scripts/go.sh" go list -m -u \
  -f '{{if and .Update (not .Indirect) (not .Main)}}{{.Path}} {{.Version}} -> {{.Update.Version}}{{end}}' all |
  sed '/^$/d'

echo
echo "== npm packages (frontend/package.json)"
# npm outdated exits 1 when anything is outdated: a report, not a failure.
"$repo/scripts/node.sh" npm outdated || true

echo
echo "== Rust crates (frontend/engine/Cargo.toml, pinned with =)"
sed -n '/^\[dependencies\]/,/^\[/p' "$repo/frontend/engine/Cargo.toml" |
  sed -nE 's/^([a-z0-9_-]+) = .*"=([0-9][^"]*)".*/\1 \2/p' |
  while read -r name pinned; do
    latest="$(curl -fsS -A '868-map outdated.sh (github.com/868-no/map)' "https://crates.io/api/v1/crates/$name" |
      python3 -c 'import json,sys; print(json.load(sys.stdin)["crate"]["max_stable_version"])' 2>/dev/null)"
    if [ -z "$latest" ]; then
      echo "$name $pinned -> (crates.io lookup failed)"
    elif [ "$latest" != "$pinned" ]; then
      echo "$name $pinned -> $latest"
    fi
  done

echo
echo "Toolchains and tools are pinned in versions.env; check those by hand when upgrading,"
echo "then run scripts/check-versions.sh to find the copies that must change with them."
