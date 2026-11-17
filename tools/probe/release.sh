#!/usr/bin/env bash
# Publish the probe's binaries (built by .github/workflows/probe.yml, in DIR)
# as a GitHub release, with their SHA-256 sums, the probe's README, its
# third-party notices and the license. Run by CI with GH_TOKEN set:
#   tools/probe/release.sh main SHA DIR      replace the rolling pre-release probe-main
#   tools/probe/release.sh probe-vX.Y.Z SHA DIR   a versioned release of that tag
set -euo pipefail
kind="$1" sha="$2" dist="$3"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${GITHUB_REPOSITORY:?}"

cp "$repo/tools/probe/README.md" "$repo/tools/probe/THIRD_PARTY_NOTICES.md" "$repo/LICENSE" "$dist/"
cd "$dist"
chmod +x probe-linux-* probe-macos
sha256sum probe-* > SHA256SUMS
cat SHA256SUMS

if [ "$kind" = main ]; then
  tag=probe-main
  title="probe (main, ${sha::7})"
  what="Built from main at $sha, after its tests passed and it was deployed: the engine map.868.no runs. Replaced whenever the engine or the probe changes on main; for a fixed version take a probe-v release."
else
  tag="$kind"
  title="probe ${kind#probe-v}"
  what="Built from $sha."
fi

cat > notes.md <<EOF
The map's mesh derivation, run natively against a deployment's rows: what map.868.no would show, without a browser. One file per platform, nothing to install; run \`probe help\`. $what

| Platform | File |
| --- | --- |
| Linux x86_64 (static) | \`probe-linux-x86_64\` |
| Linux arm64 (static) | \`probe-linux-arm64\` |
| macOS (Apple silicon and Intel) | \`probe-macos\` |
| Windows x86_64 | \`probe-windows-x86_64.exe\` |

The binaries are not signed. macOS: \`xattr -d com.apple.quarantine probe-macos\` before the first run (or allow it in System Settings → Privacy & Security). Windows: SmartScreen may ask to confirm (More info → Run anyway).

Usage, options and caching: README.md. GPL-3.0-only (LICENSE); the third-party crates and data compiled in, with their license texts: THIRD_PARTY_NOTICES.md. Source: https://github.com/$GITHUB_REPOSITORY/tree/$sha/tools/probe
EOF

files=(probe-* SHA256SUMS README.md THIRD_PARTY_NOTICES.md LICENSE)
if [ "$kind" = main ]; then
  # Replaced whole, its tag moved to the new commit: the next run on main
  # compares with that commit to see whether the binary needs building.
  gh release delete probe-main --repo "$GITHUB_REPOSITORY" --cleanup-tag --yes || true
  gh release create probe-main --repo "$GITHUB_REPOSITORY" --target "$sha" --prerelease \
    --title "$title" --notes-file notes.md "${files[@]}"
else
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --target "$sha" --title "$title" --notes-file notes.md "${files[@]}"
fi
