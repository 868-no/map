# Basemap

The map uses one dark style (`web/styles/dark.json`) on the **OpenMapTiles** vector schema. Required labels come from these layers: `place` (cities, towns, villages, country), `mountain_peak` (peaks with elevation, ▲), `transportation` and `transportation_name` (road hierarchy, names, route refs such as E6), and `boundary` (dashed national and county borders). Mesh overlays are drawn beneath the label layers, so names stay readable.

## Self-hosted PMTiles (default)

No external map requests at runtime: tiles, glyphs and style are served by the `web` service.

```sh
scripts/basemap_import.sh            # Norway (Geofabrik "norway"), ~10 min, ~1.7 GB output
scripts/basemap_import.sh sweden     # any Geofabrik area name
```

The script runs Planetiler (`ghcr.io/onthegomap/planetiler`, pinned via `PLANETILER_VERSION`, default 0.10.1). It downloads the OSM extract plus Natural Earth and OSMData water polygons into `data/basemap/sources/`, and writes `data/basemap/basemap.pmtiles`. The `web` service mounts `data/basemap` read-only at `/srv/tiles` and serves it with HTTP range requests. `MAP_TILE_SOURCE` defaults to `pmtiles:///tiles/basemap.pmtiles`.

Re-run the script to refresh OSM data; the archive is replaced atomically. Peak memory is set by `PLANETILER_HEAP` (default 8g); Norway needs about 4–6 GB.

## Online tiles (alternative)

Set `MAP_TILE_SOURCE` to a TileJSON URL serving the OpenMapTiles schema, e.g. `https://tiles.openfreemap.org/planet` (no key). Glyphs and the style are still served locally. Check the provider's terms for public deployments.

## Glyphs

Noto Sans Regular and Bold glyph ranges from the OpenMapTiles fonts release v2.0 (SIL Open Font License), downloaded and checksum-verified when the `web` image is built. Each text layer uses a single font: the static glyph server cannot combine font stacks.

## Attribution and licences

The map displays “© OpenMapTiles © OpenStreetMap contributors” (`sources.openmaptiles.attribution`). OSM data is ODbL, and tiles generated with the OpenMapTiles schema are CC-BY. Keep the attribution visible in any deployment.

## Terrain

The OpenMapTiles schema has no hillshade. Mountainous context comes from glacier/ice landcover, water and peak labels with elevation. A `raster-dem` hillshade source can be added to the style if you self-host DEM tiles; it is off by default.
