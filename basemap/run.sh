#!/bin/sh
# Keeps a self-hosted OpenMapTiles-schema basemap in /data for the web
# service: builds /data/basemap.pmtiles with Planetiler when it is missing,
# and again when it is older than BASEMAP_MAX_AGE_DAYS (0: never). The new
# file replaces the old one in a single rename, so the map never sees a
# partial archive.
# OSM detail covers the area; ocean and Natural Earth cover BASEMAP_BOUNDS
# (default world), so zoomed-out views are not cut off at the area's edges.
# Data: © OpenStreetMap contributors (ODbL), Natural Earth, OSMData water polygons.
set -u
area="${BASEMAP_AREA:-norway}"
bounds="${BASEMAP_BOUNDS:-world}"
max_age="${BASEMAP_MAX_AGE_DAYS:-30}"
out=/data/basemap.pmtiles

build() {
  echo "basemap: building $area (downloads several GB, takes a while)"
  mkdir -p /data/sources /data/tmp
  # Fresh OpenStreetMap data on every build; water and Natural Earth stay cached.
  rm -f /data/sources/*.osm.pbf
  java "-Xmx${PLANETILER_HEAP:-8g}" -cp @/app/jib-classpath-file com.onthegomap.planetiler.Main \
    --area="$area" --bounds="$bounds" --download \
    --download_dir=/data/sources --tmpdir=/data/tmp \
    --output=/data/basemap.building.pmtiles --force \
    --maxzoom=14 --languages="${BASEMAP_LANGUAGES:-no,nb,nn,se,en}" || return 1
  mv -f /data/basemap.building.pmtiles "$out" || return 1
  rm -rf /data/tmp /data/sources/*.osm.pbf
  echo "basemap: ready ($(du -h "$out" | cut -f1))"
}

while :; do
  if [ ! -s "$out" ] || { [ "$max_age" -gt 0 ] && [ -n "$(find "$out" -mtime +"$max_age")" ]; }; then
    if ! build; then
      echo "basemap: build failed; retrying in an hour"
      rm -f /data/basemap.building.pmtiles
      sleep 3600
      continue
    fi
  fi
  [ "$max_age" -gt 0 ] || exec sleep infinity
  sleep 86400
done
