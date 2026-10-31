# syntax=docker/dockerfile:1.7
# Build context: repository root.
# Build stages run natively on the build machine; their output is platform independent.

# The WebAssembly engine (frontend/engine): every view is derived in the browser.
FROM --platform=$BUILDPLATFORM rust:1.99.1-slim-bookworm AS engine
# Must equal the wasm-bindgen crate version in frontend/engine/Cargo.toml.
ARG WASM_BINDGEN=0.2.129
RUN rustup target add wasm32-unknown-unknown \
 && cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN"
WORKDIR /src/engine
COPY frontend/engine/Cargo.toml frontend/engine/Cargo.lock ./
COPY frontend/engine/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/engine/target \
    cargo build --release --locked --target wasm32-unknown-unknown \
 && wasm-bindgen --target web --out-dir /out --out-name engine target/wasm32-unknown-unknown/release/meshmap_engine.wasm

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
FROM --platform=$BUILDPLATFORM alpine:3.20 AS fonts
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
