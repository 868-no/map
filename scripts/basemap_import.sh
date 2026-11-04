#!/usr/bin/env bash
# Build a self-hosted OpenMapTiles-schema PMTiles basemap with Planetiler.
#   scripts/basemap_import.sh [area]      area: Geofabrik name, default "norway"
# Output: data/basemap/basemap.pmtiles (served by the web service at /tiles/).
# Data: © OpenStreetMap contributors (ODbL), Natural Earth, OSMData water polygons.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
area="${1:-${BASEMAP_AREA:-norway}}"
version="${PLANETILER_VERSION:-0.10.1}"
out="$repo/data/basemap"
mkdir -p "$out/sources" "$out/tmp"
docker run --rm -u "$(id -u):$(id -g)" \
  -e JAVA_TOOL_OPTIONS="-Xmx${PLANETILER_HEAP:-8g}" \
  -v "$out":/data \
  "ghcr.io/onthegomap/planetiler:$version" \
  --area="$area" --bounds="${BASEMAP_BOUNDS:-world}" --download \
  --download_dir=/data/sources --tmpdir=/data/tmp \
  --output=/data/basemap.building.pmtiles --force \
  --maxzoom=14 --languages="${BASEMAP_LANGUAGES:-no,nb,nn,se,en}"
mv -f "$out/basemap.building.pmtiles" "$out/basemap.pmtiles"
rm -rf "$out/tmp"
echo "basemap ready: $out/basemap.pmtiles ($(du -h "$out/basemap.pmtiles" | cut -f1))"
