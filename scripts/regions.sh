#!/usr/bin/env bash
# Build frontend/src/assets/regions.geojson: Norway's five regions
# (landsdeler) dissolved from the 2024 county boundaries, inside the pinned
# Node image so the host needs only Docker.
#   scripts/regions.sh
#
# Source: Kartverket's administrative units (CC BY 4.0), clipped to the
# coastline and simplified by github.com/robhop/fylker-og-kommuner (pinned
# below). Regions by county number:
#   Nord-Norge  18 Nordland, 55 Troms, 56 Finnmark
#   Trøndelag   50 Trøndelag
#   Vestlandet  11 Rogaland, 46 Vestland, 15 Møre og Romsdal
#   Østlandet   03 Oslo, 31 Østfold, 32 Akershus, 33 Buskerud, 34 Innlandet,
#               39 Vestfold, 40 Telemark
#   Sørlandet   42 Agder
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$repo/versions.env"
src_commit="ae8782500090144c2b74d6bb2a89365a7ff2236d"
mapshaper="mapshaper@0.7.86"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -sSfL -o "$work/fylker.geojson" \
  "https://raw.githubusercontent.com/robhop/fylker-og-kommuner/$src_commit/Fylker-M.geojson"
cp "$repo/scripts/regions.js" "$work/regions.js"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npm \
  -v "$work":/work -w /work "${NODE_IMAGE:-node:$NODE_VERSION-bookworm}" \
  npx -y "$mapshaper" fylker.geojson \
    -require regions.js alias=r \
    -each 'region = r.region(fylkesnummer)' \
    -filter 'region != null' \
    -dissolve region \
    -simplify 12% keep-shapes \
    -filter-slivers min-area=2km2 \
    -each 'id = r.id(region)' \
    -o format=geojson precision=0.0001 regions.geojson
cp "$work/regions.geojson" "$repo/frontend/src/assets/regions.geojson"
ls -l "$repo/frontend/src/assets/regions.geojson"
