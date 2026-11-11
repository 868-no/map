# Basemap

The map has a dark and a light style (`web/styles/dark.json`, `web/styles/light.json`) on the **OpenMapTiles** vector schema. They have the same layers and differ only in paint: switching theme copies the other style's paint onto the live map, and a unit test keeps them in step. The light style is generated from the dark one by a colour table (keep both when editing layers). Required labels come from these layers: `place` (cities, towns, villages, country), `mountain_peak` (peaks with elevation, ▲), `transportation` and `transportation_name` (road hierarchy, names, route refs such as E6), and `boundary` (dashed national and county borders). Mesh overlays are drawn beneath the label layers, so names stay readable. Which groups start switched on (borders, land cover, roads, city and country names) and which start off (local place names, peaks, road names, water names, rivers, buildings) is described in [design.md](design.md) §7.2; viewers change them under Layers on the tool rail.

## Self-hosted PMTiles (default)

No external map requests at runtime: tiles, glyphs and style are served by the `web` service.

The `basemap` service (`ghcr.io/868-no/map-basemap`, `basemap/`) keeps the archive present and fresh in a volume shared with `web`. When `basemap.pmtiles` is missing it builds it, and it rebuilds it when the file is older than `BASEMAP_MAX_AGE_DAYS` (default 30; 0 never rebuilds). Between builds it idles. A failed build is retried after an hour. Settings:

| Variable | Default | |
|---|---|---|
| `BASEMAP_AREA` | `norway` | any Geofabrik area name: the extent of OSM detail |
| `BASEMAP_BOUNDS` | `world` | extent of ocean and Natural Earth: `world` or `minlon,minlat,maxlon,maxlat` |
| `BASEMAP_MAX_AGE_DAYS` | `30` | rebuild interval |
| `BASEMAP_LANGUAGES` | `no,nb,nn,se,en` | name languages kept |
| `PLANETILER_HEAP` | `8g` | Java heap while building |

`compose.yaml` passes these through from `.env`. There the service runs as `BASEMAP_USER` (default `1000:1000`; set it to `$(id -u):$(id -g)`), not root, so `data/basemap` stays yours: create the directory before the first start (`mkdir -p data/basemap`; Docker would create it owned by root), and after running an older version, which wrote as root, `sudo chown -R "$(id -u):$(id -g)" data/basemap`. Changing the area, bounds or languages does not rebuild an existing archive; delete `basemap.pmtiles` and restart the service. Progress is in `docker compose logs basemap`.

Without the bounds, Planetiler clips every layer to the area's bounding box, and zoomed-out views show nothing beyond it. With `world`, oceans, coastlines and Natural Earth's countries cover the globe and roads and places come from the area only; this costs build time and archive size over the area alone. Norway with `world` bounds takes about 12 minutes after the downloads on 4 cores (the ocean polygons about 4 of them) and writes about 2.3 GB; Norway alone writes about 1.8 GB. A build needs about 6 GB of free disk for downloads and temporary files; the OSM extract and temporary files are removed afterwards, while water polygons and Natural Earth stay cached for the next build.

To build by hand instead (e.g. on a development machine):

```sh
scripts/basemap_import.sh            # Norway (Geofabrik "norway")
scripts/basemap_import.sh sweden     # any Geofabrik area name
```

The script runs Planetiler (`ghcr.io/onthegomap/planetiler`, pinned via `PLANETILER_VERSION`, default 0.10.1). It downloads the OSM extract plus Natural Earth and OSMData water polygons into `data/basemap/sources/`, and writes `data/basemap/basemap.pmtiles`. The `web` service mounts `data/basemap` read-only at `/srv/tiles` and serves it with HTTP range requests. `MAP_TILE_SOURCE` defaults to `pmtiles:///tiles/basemap.pmtiles`.

Re-run the script to refresh OSM data; the archive is replaced atomically. Peak memory is set by `PLANETILER_HEAP` (default 8g); Norway needs about 4–6 GB.

## Online tiles (alternative)

Set `MAP_TILE_SOURCE` to a TileJSON URL serving the OpenMapTiles schema, e.g. `https://tiles.openfreemap.org/planet` (no key). Glyphs and the style are still served locally. Check the provider's terms for public deployments.

The browser fetches the TileJSON and the tiles itself, which the default CSP (`connect-src 'self'`) blocks. Allow the provider's host by setting `CSP_CONNECT_EXTRA` (in `.env`, or the stack's environment for `compose.production.yaml` and `stack.swarm.yaml`; the Compose files pass it to `web`, empty by default), e.g. `CSP_CONNECT_EXTRA=https://tiles.openfreemap.org`; it is appended to `connect-src` and may list several space-separated sources, including any other host the TileJSON's `tiles` URLs point to (D-167).

Privacy: visitors' browsers then contact the tile host directly, which receives their IP addresses and the map areas they view. The privacy policy page says so when the tile source is remote.

## Meshtastic UI tiles

`scripts/mui_tiles.sh` turns the same basemap into map tiles for Meshtastic UI (MUI 2.8.1 or later). MUI reads PMTiles only when they hold PNG raster tiles, so the script renders the vector archive with the web map's style (tileserver-gl), using the layers the web map shows by default and the fonts the `web` image serves. It reduces each tile to an 8-bit palette, as MUI's maps README recommends, and packs the result as `maps/<name>/<name>.pmtiles`: uncompressed PNG tiles with gzip directories, which is what MUI accepts. Coverage is the whole world to z5, the web map's Norway bounds to z7, then Norway's regions plus one tile of margin down to `--maxzoom` (default 12: about 35,000 tiles and 260 MB). `--bbox` renders an area such as home deeper (`--bbox-maxzoom`, default 15). `--style dark` uses the dark theme, and `--show`/`--hide` take layer group ids from `frontend/src/map/layers.ts`. Copy the output's `maps` folder to the SD card's root and pick the style in MUI by long-pressing the Map button. Image versions are in `versions.env` (`MUI_*`); see `scripts/mui_tiles.sh --help`.

## Glyphs

Noto Sans Regular and Bold glyph ranges from the OpenMapTiles fonts release v2.0 (SIL Open Font License), downloaded and checksum-verified when the `web` image is built. Each text layer uses a single font: the static glyph server cannot combine font stacks.

## Attribution and licences

The map displays “© OpenMapTiles © OpenStreetMap contributors” (`sources.openmaptiles.attribution`). OSM data is ODbL, and tiles generated with the OpenMapTiles schema are CC-BY. Keep the attribution visible in any deployment. The fonts are SIL OFL 1.1; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for every component.

## Terrain

The OpenMapTiles schema has no hillshade. Mountainous context comes from glacier/ice landcover, water and peak labels with elevation. A `raster-dem` hillshade source can be added to the style if you self-host DEM tiles; it is off by default.
