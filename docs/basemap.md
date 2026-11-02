# Basemap

The map has a dark and a light style (`web/styles/dark.json`, `web/styles/light.json`) on the **OpenMapTiles** vector schema. They have the same layers and differ only in paint: switching theme copies the other style's paint onto the live map, and a unit test keeps them in step. The light style is generated from the dark one by a colour table (keep both when editing layers). Required labels come from these layers: `place` (cities, towns, villages, country), `mountain_peak` (peaks with elevation, ▲), `transportation` and `transportation_name` (road hierarchy, names, route refs such as E6), and `boundary` (dashed national and county borders). Mesh overlays are drawn beneath the label layers, so names stay readable. Which groups start switched on (borders, land cover, roads, city and country names) and which start off (local place names, peaks, road names, water names, rivers, buildings) is described in [design.md](design.md) §7.2; viewers change them under Layers on the tool rail.

## Self-hosted PMTiles (default)

No external map requests at runtime: tiles, glyphs and style are served by the `web` service.

The `basemap` service (`ghcr.io/868-no/map-basemap`, `basemap/`) keeps the archive present and fresh in a volume shared with `web`. When `basemap.pmtiles` is missing it builds it, and it rebuilds it when the file is older than `BASEMAP_MAX_AGE_DAYS` (default 30; 0 never rebuilds). Between builds it idles. A failed build is retried after an hour. Settings:

| Variable | Default | |
|---|---|---|
| `BASEMAP_AREA` | `norway` | any Geofabrik area name |
| `BASEMAP_MAX_AGE_DAYS` | `30` | rebuild interval |
| `BASEMAP_LANGUAGES` | `no,nb,nn,se,en` | name languages kept |
| `PLANETILER_HEAP` | `8g` | Java heap while building |

`compose.yaml` passes these through from `.env`. Changing the area or languages does not rebuild an existing archive; delete `basemap.pmtiles` and restart the service. Progress is in `docker compose logs basemap`.

Norway takes about 10 minutes and writes about 1.7 GB. A build needs about 6 GB of free disk for downloads and temporary files; the OSM extract and temporary files are removed afterwards, while water polygons and Natural Earth stay cached for the next build.

To build by hand instead (e.g. on a development machine):

```sh
scripts/basemap_import.sh            # Norway (Geofabrik "norway")
scripts/basemap_import.sh sweden     # any Geofabrik area name
```

The script runs Planetiler (`ghcr.io/onthegomap/planetiler`, pinned via `PLANETILER_VERSION`, default 0.10.1). It downloads the OSM extract plus Natural Earth and OSMData water polygons into `data/basemap/sources/`, and writes `data/basemap/basemap.pmtiles`. The `web` service mounts `data/basemap` read-only at `/srv/tiles` and serves it with HTTP range requests. `MAP_TILE_SOURCE` defaults to `pmtiles:///tiles/basemap.pmtiles`.

Re-run the script to refresh OSM data; the archive is replaced atomically. Peak memory is set by `PLANETILER_HEAP` (default 8g); Norway needs about 4–6 GB.

## Online tiles (alternative)

Set `MAP_TILE_SOURCE` to a TileJSON URL serving the OpenMapTiles schema, e.g. `https://tiles.openfreemap.org/planet` (no key). Glyphs and the style are still served locally. Check the provider's terms for public deployments.

## Glyphs

Noto Sans Regular and Bold glyph ranges from the OpenMapTiles fonts release v2.0 (SIL Open Font License), downloaded and checksum-verified when the `web` image is built. Each text layer uses a single font: the static glyph server cannot combine font stacks.

## Attribution and licences

The map displays “© OpenMapTiles © OpenStreetMap contributors” (`sources.openmaptiles.attribution`). OSM data is ODbL, and tiles generated with the OpenMapTiles schema are CC-BY. Keep the attribution visible in any deployment. The fonts are SIL OFL 1.1; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for every component.

## Terrain

The OpenMapTiles schema has no hillshade. Mountainous context comes from glacier/ice landcover, water and peak labels with elevation. A `raster-dem` hillshade source can be added to the style if you self-host DEM tiles; it is off by default.
