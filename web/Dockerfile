# syntax=docker/dockerfile:1.7
# Build context: repository root.
# Build stages run natively on the build machine; their output is platform independent.
FROM --platform=$BUILDPLATFORM node:22.21.1-bookworm AS app
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/ ./
COPY docs/api-openapi.yaml /src/docs/api-openapi.yaml
# true only for end-to-end test stacks: compiles in the window.__meshmap hook.
ARG E2E_HOOKS=false
RUN VITE_E2E_HOOKS=$E2E_HOOKS npm run build

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
