#!/usr/bin/env bash
# Build the WebAssembly engine (frontend/engine) into frontend/src/engine/pkg
# inside the pinned Rust image, so the host needs only Docker.
#   scripts/wasm.sh            release build + wasm-bindgen
#   scripts/wasm.sh test       cargo test (native)
#   scripts/wasm.sh clippy     cargo clippy, warnings as errors (lints: Cargo.toml)
#   scripts/wasm.sh deny       cargo-deny: dependency advisories, bans, sources (deny.toml)
#   UPDATE_GOLDEN=1 scripts/wasm.sh test   re-record tests/fixtures/mesh-12h/engine.json
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$repo/versions.env"
image="${RUST_IMAGE:-rust:$RUST_VERSION-slim-bookworm}"
bindgen="$WASM_BINDGEN_VERSION" # must equal the wasm-bindgen crate version in Cargo.toml
deny="$CARGO_DENY_VERSION"
# Binaryen's wasm-opt optimises the bindgen output (-O3, as the release
# profile's opt-level 3) and strips the name section (debug names only). The image has no curl, so the
# release is fetched on the host, checked and cached outside the repo.
binaryen="$BINARYEN_VERSION"
binaryen_sha256="$BINARYEN_SHA256" # binaryen-$binaryen-x86_64-linux.tar.gz
# The cache: a named volume, or with MESHMAP_CACHE a directory under it
# (CI saves and restores it between runs on GitHub-hosted runners).
if [ -n "${MESHMAP_CACHE:-}" ]; then
  cache="$MESHMAP_CACHE/rust"
  binaryen_dir="$MESHMAP_CACHE/binaryen-$binaryen"
else
  cache=meshmap-rust-cache
  binaryen_dir="${XDG_CACHE_HOME:-$HOME/.cache}/meshmap/binaryen-$binaryen"
fi
tty_flag=()
[ -t 1 ] && tty_flag=(-t)
run() {
  docker run --rm "${tty_flag[@]}" -u "$(id -u):$(id -g)" \
    -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target -e HOME=/tmp -e UPDATE_GOLDEN="${UPDATE_GOLDEN:-}" \
    -v "$cache":/cache -v "$repo":/src -v "$binaryen_dir":/binaryen:ro -w /src/frontend/engine "$image" sh -c "$1"
}
if [ -n "${MESHMAP_CACHE:-}" ]; then
  mkdir -p "$cache/cargo" "$cache/target"
else
  docker run --rm -v "$cache":/cache "$image" sh -c "mkdir -p /cache/cargo /cache/target && chown -R $(id -u):$(id -g) /cache"
fi
mkdir -p "$binaryen_dir" # before Docker would create the mount point as root
case "${1:-build}" in
  # --locked: a Cargo.toml change without its lockfile fails here, not later in an image build.
  test) run "cargo test --locked --profile test-fast" ;;
  clippy) run "rustup component add clippy >/dev/null &&
      cargo clippy --locked --release --all-targets -- -D warnings" ;;
  # The full image: cargo-deny clones the advisory database with git, which slim lacks.
  deny) image="${RUST_FULL_IMAGE:-rust:$RUST_VERSION-bookworm}"
    run "[ -x /cache/cargo/bin/cargo-deny ] && /cache/cargo/bin/cargo-deny --version | grep -q $deny \
        || cargo install --locked cargo-deny --version $deny
      /cache/cargo/bin/cargo-deny check advisories bans sources" ;;
  build)
    if [ ! -x "$binaryen_dir/wasm-opt" ]; then
      # Into a directory of its own, then moved into place: jobs sharing the
      # cache (self-hosted runners) may fetch it at the same time.
      mkdir -p "$binaryen_dir"
      tmp="$(mktemp -d "$binaryen_dir/.fetch.XXXXXX")"
      curl -sSfL -o "$tmp/binaryen.tar.gz" "https://github.com/WebAssembly/binaryen/releases/download/$binaryen/binaryen-$binaryen-x86_64-linux.tar.gz"
      echo "$binaryen_sha256  $tmp/binaryen.tar.gz" | sha256sum -c --quiet -
      tar xzf "$tmp/binaryen.tar.gz" -C "$tmp" --strip-components=2 "binaryen-$binaryen/bin/wasm-opt"
      mv -f "$tmp/wasm-opt" "$binaryen_dir/wasm-opt"
      rm -r "$tmp"
    fi
    run "rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
      [ -x /cache/cargo/bin/wasm-bindgen ] && /cache/cargo/bin/wasm-bindgen --version | grep -q $bindgen \
        || cargo install --locked wasm-bindgen-cli --version $bindgen
      cargo build --locked --release --target wasm32-unknown-unknown
      /cache/cargo/bin/wasm-bindgen --target web --experimental-reset-state-function --out-dir /src/frontend/src/engine/pkg --out-name engine \
        /cache/target/wasm32-unknown-unknown/release/meshmap_engine.wasm
      /binaryen/wasm-opt -O3 --strip-debug --strip-producers \
        /src/frontend/src/engine/pkg/engine_bg.wasm -o /src/frontend/src/engine/pkg/engine_bg.wasm"
    ls -l "$repo/frontend/src/engine/pkg" ;;
  *) echo "usage: $0 [build|test|clippy|deny]" >&2; exit 2 ;;
esac
