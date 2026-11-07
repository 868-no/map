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
# The dependencies, built against an empty crate in a layer of their own, so
# a change to the engine's sources rebuilds only the engine: the layer cache
# is what CI keeps between runs (cache mounts are not exported with it).
# The empty crate's own outputs are removed, so its build is never mistaken
# for the real one.
RUN mkdir src && touch src/lib.rs  && cargo build --release --locked --target wasm32-unknown-unknown  && rm -r src target/wasm32-unknown-unknown/release/.fingerprint/meshmap-engine-*           target/wasm32-unknown-unknown/release/deps/*meshmap_engine*           target/wasm32-unknown-unknown/release/*meshmap_engine*
COPY frontend/engine/src ./src
# Binaryen's wasm-opt, as scripts/wasm.sh runs it: -O3 (as the release
# profile's opt-level 3) and no name or producers sections. Its release has
# x86_64 Linux binaries; another build machine strips the sections only.
ARG BINARYEN=version_133
ADD --checksum=sha256:2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489 \
    https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN}/binaryen-${BINARYEN}-x86_64-linux.tar.gz /tmp/binaryen.tar.gz
ARG BUILDARCH
RUN cargo build --release --locked --target wasm32-unknown-unknown \
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
# What vite builds from only: tests and the engine's sources would rebuild it for nothing.
COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json ./
COPY frontend/public ./public
COPY frontend/sw ./sw
COPY frontend/src ./src
COPY --from=engine /out ./src/engine/pkg
COPY docs/api-openapi.yaml /src/docs/api-openapi.yaml
# true only for end-to-end test stacks: compiles in the window.__meshmap hook.
ARG E2E_HOOKS=false
# The page links to its source code (GPL-3.0): set these when building a fork.
ARG SOURCE_URL=https://github.com/868-no/map
ARG SOURCE_REVISION=
RUN VITE_E2E_HOOKS=$E2E_HOOKS VITE_SOURCE_URL=$SOURCE_URL VITE_SOURCE_REVISION=$SOURCE_REVISION npx vite build # typechecked in CI's frontend job

# Map glyphs: OpenMapTiles fonts v2.0 (SIL OFL), pinned by checksum.
FROM --platform=$BUILDPLATFORM alpine:3.24 AS fonts
ARG FONTS_URL=https://github.com/openmaptiles/fonts/releases/download/v2.0/v2.0.zip
ARG FONTS_SHA256=3a7a6c2dcd940a840aa6ffac8f39758252a667a0b329945b071fb44bf00e7f47
RUN apk add --no-cache curl unzip && curl -fsSL -o /fonts.zip "$FONTS_URL" \
 && echo "$FONTS_SHA256  /fonts.zip" | sha256sum -c - \
 && mkdir -p /out && unzip -q /fonts.zip "Noto Sans Regular/*" "Noto Sans Bold/*" -d /out \
 && mkdir -p /dirs/etc/caddy/auth /dirs/srv/tiles

FROM caddy:2.10-alpine
# No RUN in this stage: every image builds without emulating its platform.
COPY --from=fonts /dirs/ /
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=app /src/frontend/dist /srv/app
COPY --from=fonts /out /srv/fonts
COPY web/styles /srv/styles
# Unprivileged, still on port 80: Docker lets any user bind ports below 1024
# in a container's own network namespace (net.ipv4.ip_unprivileged_port_start
# is 0 there), and the image's caddy binary has cap_net_bind_service besides.
# Keeping 80 keeps every proxy, tunnel and compose file that reaches web:80.
# Caddy's state directories (XDG_DATA_HOME=/data/caddy, XDG_CONFIG_HOME=
# /config/caddy) are writable by any user in the base image. Mounted files
# (/srv/tiles, /etc/caddy/auth) must be readable by this user.
USER 65532:65532
EXPOSE 80
