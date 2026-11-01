# Third-party notices

This project is licensed under the GNU General Public License v3.0 only (`GPL-3.0-only`, see [LICENSE](LICENSE)). It must be: the backend's protocol code is generated from Meshtastic's protobuf definitions, which are GPL-3.0. Everything else it uses or ships is under licenses compatible with GPL-3.0, listed below.

## Source code compiled into the project

| Component | Where | License |
|---|---|---|
| [Meshtastic protobufs](https://github.com/meshtastic/protobufs) | `backend/protobufs` (git submodule); Go code generated from it in `backend/internal/protocol/pb` | GPL-3.0 |
| Go modules (`backend/go.mod`) | backend binary | MIT, BSD-2/3-Clause, Apache-2.0 |
| [Eclipse Paho](https://github.com/eclipse/paho.golang) MQTT clients | backend binary | EPL-2.0 or EDL-1.0 (BSD-3-Clause); used under EDL-1.0 |
| npm packages shipped in the frontend bundle (`frontend/package-lock.json`, non-dev) | web image | MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD |
| Rust crates in the WebAssembly engine (`frontend/engine/Cargo.lock`) | web image | MIT, Apache-2.0, Unlicense, Unicode-3.0 (dual-licensed crates used under MIT) |

Each dependency's license text is in its source distribution (the Go module cache, `node_modules`, the Cargo registry).

## Fonts, map data and container bases

| Component | Where | License |
|---|---|---|
| Noto Sans glyphs from [OpenMapTiles fonts](https://github.com/openmaptiles/fonts) v2.0 | web image, `/srv/fonts` | SIL Open Font License 1.1 |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) data in the self-hosted basemap | built at runtime by the basemap service; not in the repository or images | ODbL 1.0, attribution "© OpenStreetMap contributors" |
| [OpenMapTiles](https://openmaptiles.org/) vector tile schema | basemap tiles | CC-BY 4.0, attribution "© OpenMapTiles" |
| [Natural Earth](https://www.naturalearthdata.com/) | basemap, low zooms | Public domain |
| [OSMData water polygons](https://osmdata.openstreetmap.de/) | basemap | ODbL 1.0 |
| [Kartverket](https://www.kartverket.no/) county boundaries (2024), via [robhop/fylker-og-kommuner](https://github.com/robhop/fylker-og-kommuner), dissolved into regions by `scripts/regions.sh` | `frontend/src/assets/regions.geojson` (regions layer) | CC BY 4.0, attribution "© Kartverket" |
| [Planetiler](https://github.com/onthegomap/planetiler) | basemap image base (`ghcr.io/onthegomap/planetiler`) | Apache-2.0 |
| [Caddy](https://caddyserver.com/) | web image base | Apache-2.0 |

The map shows the OpenStreetMap and OpenMapTiles attributions at all times, and the Kartverket attribution while the regions layer is on, next to a link to this project's source code.

## Test fixtures

RF captures under `backend/test/fixtures` and `frontend/engine/tests/fixtures` are packets broadcast publicly over the air and uplinked to a public MQTT broker.

## Trademarks

Meshtastic® is a registered trademark of Meshtastic LLC. This project is not affiliated with or endorsed by Meshtastic LLC.
