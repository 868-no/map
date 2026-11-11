#!/usr/bin/env bash
# Render the self-hosted basemap (data/basemap/basemap.pmtiles) with the web
# map's own style into a raster PMTiles archive for Meshtastic UI (MUI >=
# 2.8.1), which reads only PNG raster tiles. Host needs only Docker.
#
#   scripts/mui_tiles.sh [options]
#     --style light|dark    web/styles/<style>.json (default light)
#     --name NAME           MUI style name, max 23 characters (default 868-<style>)
#     --maxzoom N           deepest zoom over Norway (default 12; data goes to 14)
#     --bbox W,S,E,N        also render this area deeper, e.g. around home
#     --bbox-maxzoom N      deepest zoom inside --bbox (default 15)
#     --show g1,g2          layer groups to show beyond the web map's defaults
#     --hide g1,g2          default layer groups to leave out
#                           (ids in frontend/src/map/layers.ts: peaks, localPlaces,
#                           roadNames, waterNames, waterways, buildings, ...)
#     --basemap FILE        PMTiles to render (default data/basemap/basemap.pmtiles)
#     --out DIR             output directory (default data/mui)
#     --workers N           parallel tile requests (default 2 x CPUs)
#     --dry-run             print tile counts per zoom and stop
#
# Tiles: the whole world to z5, the web map's Norway bounds to z7, then the
# tiles touching Norway's regions (frontend/src/assets/regions.geojson) plus
# one tile of margin. Layers: those the web map shows by default.
# Output: <out>/maps/<name>/<name>.pmtiles. Copy <out>/maps to the SD card's
# root and pick the style in MUI (long-press the Map button).
# A rerun resumes: rendered tiles are kept in <out>/work/<name>.mbtiles, and
# discarded when the style, layers or basemap changed.
# Data: © OpenMapTiles © OpenStreetMap contributors (ODbL).
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$repo/versions.env"

style=light name="" maxzoom=12 bbox="" bbox_maxzoom=15 show="" hide=""
basemap="$repo/data/basemap/basemap.pmtiles" out="$repo/data/mui"
workers=$(($(nproc) * 2)) dry_run=""
while [ $# -gt 0 ]; do
  case "$1" in
    --style) style="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --maxzoom) maxzoom="$2"; shift 2 ;;
    --bbox) bbox="$2"; shift 2 ;;
    --bbox-maxzoom) bbox_maxzoom="$2"; shift 2 ;;
    --show) show="$2"; shift 2 ;;
    --hide) hide="$2"; shift 2 ;;
    --basemap) basemap="$(realpath "$2")"; shift 2 ;;
    --out) out="$(realpath -m "$2")"; shift 2 ;;
    --workers) workers="$2"; shift 2 ;;
    --dry-run) dry_run=--dry-run; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
name="${name:-868-$style}"
[ -f "$repo/web/styles/$style.json" ] || { echo "no such style: web/styles/$style.json" >&2; exit 2; }
[ "${#name}" -le 23 ] || { echo "--name: MUI allows at most 23 characters" >&2; exit 2; }
[ -s "$basemap" ] || { echo "no basemap at $basemap (scripts/basemap_import.sh builds one)" >&2; exit 1; }
extra=()
[ -n "$bbox" ] && extra=(--extra-bbox "$bbox" --extra-maxzoom "$bbox_maxzoom")

# The web map's initial view (MapView.tsx NORWAY_BOUNDS) as W,S,E,N.
norway="$(sed -nE 's/^const NORWAY_BOUNDS[^=]*= \[\[([0-9.]+), ([0-9.]+)\], \[([0-9.]+), ([0-9.]+)\]\].*/\1,\2,\3,\4/p' \
  "$repo/frontend/src/map/MapView.tsx")"
[ -n "$norway" ] || { echo "NORWAY_BOUNDS not found in frontend/src/map/MapView.tsx" >&2; exit 1; }

work="$out/work"
if ! mkdir -p "$work/fonts" "$work/styles" "$work/pip" "$out/maps/$name"; then
  echo "cannot write $out: pass --out, or chown data to yourself (sudo chown \"\$(id -u):\$(id -g)\" data)" >&2
  exit 1
fi

# Python with Pillow, installed once into the work directory.
py() {
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e PYTHONPATH=/work/pip "$@"
}
pyimg="$MUI_PYTHON_IMAGE"
if [ ! -d "$work/pip/PIL" ]; then
  py -v "$work":/work "$pyimg" pip install -q --disable-pip-version-check --target /work/pip "pillow==$MUI_PILLOW_VERSION"
fi

# The glyphs the web image serves (web/Dockerfile's pinned OpenMapTiles fonts).
if [ ! -d "$work/fonts/Noto Sans Bold" ]; then
  fonts_url="$(sed -nE 's/^ARG FONTS_URL=(.*)/\1/p' "$repo/web/Dockerfile")"
  fonts_sha="$(sed -nE 's/^ARG FONTS_SHA256=(.*)/\1/p' "$repo/web/Dockerfile")"
  curl -fsSL -o "$work/fonts.zip" "$fonts_url"
  echo "$fonts_sha  $work/fonts.zip" | sha256sum -c --quiet -
  unzip -q -o "$work/fonts.zip" "Noto Sans Regular/*" "Noto Sans Bold/*" -d "$work/fonts"
  rm "$work/fonts.zip"
fi

py -v "$work":/work -v "$repo":/repo:ro "$pyimg" python /repo/scripts/mui_tiles.py style \
  --src "/repo/web/styles/$style.json" --layers /repo/frontend/src/map/layers.ts \
  --out /work/styles/style.json --show "$show" --hide "$hide"
cat >"$work/config.json" <<'EOF'
{
  "options": { "paths": { "root": "/work", "fonts": "fonts", "styles": "styles", "pmtiles": "/tiles" } },
  "styles": { "mui": { "style": "style.json" } },
  "data": { "basemap": { "pmtiles": "basemap.pmtiles" } }
}
EOF

source_id="$( { cat "$work/styles/style.json"; stat -c '%s %Y' "$basemap"; } | sha256sum | cut -c1-16)"

net="mui-tiles-$$"
docker network create "$net" >/dev/null
trap 'docker rm -f "$net-render" >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1' EXIT
if [ -z "$dry_run" ]; then
  docker run -d --name "$net-render" --network "$net" -u "$(id -u):$(id -g)" \
    -v "$work":/work:ro -v "$basemap":/tiles/basemap.pmtiles:ro \
    "$MUI_TILESERVER_IMAGE" -c /work/config.json >/dev/null
  echo "waiting for the renderer"
  for _ in $(seq 60); do
    docker run --rm --network "$net" "$pyimg" python -c \
      "import urllib.request; urllib.request.urlopen('http://$net-render:8080/health')" 2>/dev/null && break
    sleep 2
  done
fi

echo "rendering $name (basemap $(date -r "$basemap" +%F))"
py --network "$net" -v "$work":/work -v "$repo":/repo:ro "$pyimg" python /repo/scripts/mui_tiles.py render \
  --server "http://$net-render:8080/styles/mui" --regions /repo/frontend/src/assets/regions.geojson \
  --norway "$norway" --mbtiles "/work/$name.mbtiles" --name "$name" --source-id "$source_id" \
  --maxzoom "$maxzoom" --workers "$workers" ${extra[@]+"${extra[@]}"} $dry_run
[ -n "$dry_run" ] && exit 0

# MBTiles -> PMTiles: PNG tiles stored uncompressed, gzip directories, as MUI needs.
docker run --rm -u "$(id -u):$(id -g)" -v "$work":/work -v "$out/maps/$name":/dst \
  "$MUI_PMTILES_IMAGE" convert --force "/work/$name.mbtiles" "/dst/$name.pmtiles"
docker run --rm -v "$out/maps/$name":/dst:ro "$MUI_PMTILES_IMAGE" show "/dst/$name.pmtiles" \
  | grep -E 'tile type|compression|zoom|addressed'
echo "ready: $out/maps/$name/$name.pmtiles ($(du -h "$out/maps/$name/$name.pmtiles" | cut -f1)); copy $out/maps to the SD card's root"
