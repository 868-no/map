#!/usr/bin/env bash
# Build the WebAssembly engine (frontend/engine) into frontend/src/engine/pkg
# inside the pinned Rust image, so the host needs only Docker.
#   scripts/wasm.sh            release build + wasm-bindgen
#   scripts/wasm.sh test       cargo test (native)
#   UPDATE_GOLDEN=1 scripts/wasm.sh test   re-record tests/fixtures/mesh-12h/engine.json
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${RUST_IMAGE:-rust:1.99.1-slim-bookworm}"
bindgen="0.2.129" # must equal the wasm-bindgen crate version in Cargo.toml
tty_flag=()
[ -t 1 ] && tty_flag=(-t)
run() {
  docker run --rm "${tty_flag[@]}" -u "$(id -u):$(id -g)" \
    -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target -e HOME=/tmp -e UPDATE_GOLDEN="${UPDATE_GOLDEN:-}" \
    -v meshmap-rust-cache:/cache -v "$repo":/src -w /src/frontend/engine "$image" sh -c "$1"
}
docker run --rm -v meshmap-rust-cache:/cache "$image" sh -c "mkdir -p /cache/cargo /cache/target && chown -R $(id -u):$(id -g) /cache"
case "${1:-build}" in
  test) run "cargo test --release" ;;
  build)
    run "rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
      [ -x /cache/cargo/bin/wasm-bindgen ] && /cache/cargo/bin/wasm-bindgen --version | grep -q $bindgen \
        || cargo install --locked wasm-bindgen-cli --version $bindgen
      cargo build --release --target wasm32-unknown-unknown
      /cache/cargo/bin/wasm-bindgen --target web --out-dir /src/frontend/src/engine/pkg --out-name engine \
        /cache/target/wasm32-unknown-unknown/release/meshmap_engine.wasm"
    ls -l "$repo/frontend/src/engine/pkg" ;;
  *) echo "usage: $0 [build|test]" >&2; exit 2 ;;
esac
