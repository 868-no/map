# syntax=docker/dockerfile:1.7
# Build context: repository root.
# Build stages run natively on the build machine; their output is platform independent.

# The WebAssembly engine (frontend/engine): every view is derived in the browser.
FROM --platform=$BUILDPLATFORM rust:1.99.1-slim-bookworm AS engine
# Must equal the wasm-bindgen crate version in frontend/engine/Cargo.toml (and bindgen in scripts/wasm.sh).
# --experimental-reset-state-function: the worker recreates the engine instance to give memory back (D-183).
ARG WASM_BINDGEN=0.2.130
RUN rustup target add wasm32-unknown-unknown \
 && cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN"
WORKDIR /src/engine
COPY frontend/engine/Cargo.toml frontend/engine/Cargo.lock ./
COPY frontend/engine/src ./src
# Binaryen's wasm-opt, as scripts/wasm.sh runs it: -O3 (as the release
# profile's opt-level 3) and no name or producers sections. Its release has
# x86_64 Linux binaries; another build machine strips the sections only.
ARG BINARYEN=version_133
ADD --checksum=sha256:2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489 \
    https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN}/binaryen-${BINARYEN}-x86_64-linux.tar.gz /tmp/binaryen.tar.gz
ARG BUILDARCH
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/engine/target \
    cargo build --release --locked --target wasm32-unknown-unknown \
 && wasm-bindgen --target web --experimental-reset-state-function --out-dir /out --out-name engine target/wasm32-unknown-unknown/release/meshmap_engine.wasm \
 && if [ "$BUILDARCH" = amd64 ]; then \
      tar xzf /tmp/binaryen.tar.gz -C /usr/local/bin --strip-components=2 "binaryen-${BINARYEN}/bin/wasm-opt" \
      && wasm-opt -O3 --strip-debug --strip-producers /out/engine_bg.wasm -o /out/engine_bg.wasm; \
    else \
      wasm-bindgen --target web --experimental-reset-state-function --remove-name-section --remove-producers-section --out-dir /out --out-name engine target/wasm32-unknown-unknown/release/meshmap_engine.wasm; \
    fi

FROM --platform=$BUILDPLATFORM node:22.21.1-bookworm AS app
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/ ./
COPY --from=engine /out ./src/engine/pkg
COPY docs/api-openapi.yaml /src/docs/api-openapi.yaml
# true only for end-to-end test stacks: compiles in the window.__meshmap hook.
ARG E2E_HOOKS=false
# The page links to its source code (GPL-3.0): set these when building a fork.
ARG SOURCE_URL=https://github.com/868-no/map
ARG SOURCE_REVISION=
RUN VITE_E2E_HOOKS=$E2E_HOOKS VITE_SOURCE_URL=$SOURCE_URL VITE_SOURCE_REVISION=$SOURCE_REVISION npm run build

# Map glyphs: OpenMapTiles fonts v2.0 (SIL OFL), pinned by checksum.
FROM --platform=$BUILDPLATFORM alpine:3.24 AS fonts
ARG FONTS_URL=https://github.com/openmaptiles/fonts/releases/download/v2.0/v2.0.zip
ARG FONTS_SHA256=3a7a6c2dcd940a840aa6ffac8f39758252a667a0b329945b071fb44bf00e7f47
RUN apk add --no-cache curl unzip && curl -fsSL -o /fonts.zip "$FONTS_URL" \
 && echo "$FONTS_SHA256  /fonts.zip" | sha256sum -c - \
 && mkdir -p /out && unzip -q /fonts.zip "Noto Sans Regular/*" "Noto Sans Bold/*" -d /out

FROM caddy:2.10-alpine
COPY web/Caddyfile /etc/caddy/Caddyfile
RUN mkdir -p /etc/caddy/auth /srv/tiles
COPY --from=app /src/frontend/dist /srv/app
COPY --from=fonts /out /srv/fonts
COPY web/styles /srv/styles
EXPOSE 80
