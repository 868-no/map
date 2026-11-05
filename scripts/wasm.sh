#!/usr/bin/env bash
# Build the WebAssembly engine (frontend/engine) into frontend/src/engine/pkg
# inside the pinned Rust image, so the host needs only Docker.
#   scripts/wasm.sh            release build + wasm-bindgen
#   scripts/wasm.sh test       cargo test (native)
#   scripts/wasm.sh clippy     cargo clippy, warnings as errors
#   UPDATE_GOLDEN=1 scripts/wasm.sh test   re-record tests/fixtures/mesh-12h/engine.json
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${RUST_IMAGE:-rust:1.99.1-slim-bookworm}"
bindgen="0.2.129" # must equal the wasm-bindgen crate version in Cargo.toml
# Binaryen's wasm-opt optimises the bindgen output (-O3, as the release
# profile's opt-level 3) and strips the name section (debug names only). The image has no curl, so the
# release is fetched on the host, checked and cached outside the repo.
binaryen="version_133"
binaryen_sha256="2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489" # binaryen-version_133-x86_64-linux.tar.gz
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
  test) run "cargo test --release" ;;
  clippy) run "rustup component add clippy >/dev/null &&
      cargo clippy --release --all-targets -- -D warnings" ;;
  build)
    if [ ! -x "$binaryen_dir/wasm-opt" ]; then
      mkdir -p "$binaryen_dir"
      tgz="$binaryen_dir/binaryen.tar.gz"
      curl -sSfL -o "$tgz" "https://github.com/WebAssembly/binaryen/releases/download/$binaryen/binaryen-$binaryen-x86_64-linux.tar.gz"
      echo "$binaryen_sha256  $tgz" | sha256sum -c --quiet -
      tar xzf "$tgz" -C "$binaryen_dir" --strip-components=2 "binaryen-$binaryen/bin/wasm-opt"
      rm "$tgz"
    fi
    run "rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
      [ -x /cache/cargo/bin/wasm-bindgen ] && /cache/cargo/bin/wasm-bindgen --version | grep -q $bindgen \
        || cargo install --locked wasm-bindgen-cli --version $bindgen
      cargo build --release --target wasm32-unknown-unknown
      /cache/cargo/bin/wasm-bindgen --target web --out-dir /src/frontend/src/engine/pkg --out-name engine \
        /cache/target/wasm32-unknown-unknown/release/meshmap_engine.wasm
      /binaryen/wasm-opt -O3 --strip-debug --strip-producers \
        /src/frontend/src/engine/pkg/engine_bg.wasm -o /src/frontend/src/engine/pkg/engine_bg.wasm"
    ls -l "$repo/frontend/src/engine/pkg" ;;
  *) echo "usage: $0 [build|test|clippy]" >&2; exit 2 ;;
esac
