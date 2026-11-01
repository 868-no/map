# Meshtastic MQTT Mesh Observatory

An interactive map, in light and dark themes, for observing Meshtastic mesh networks using only traffic from one or more MQTT brokers. It decrypts channel traffic, verifies XEdDSA packet signatures and stores each accepted gateway reception in one PostgreSQL table (`packet_log`). From that table the browser reconstructs nodes, evidence-backed RF links, traffic and coarse location estimates for any time window in the retention period. Nothing from outside the selected window ever leaks into a view.

![Live overview](docs/screenshots/live-overview.png)

- **Time windows:** default rolling 3 days, presets from 1 h to 7 d, custom start/end, slide the window back through 6 months. Live updates arrive over SSE.
- **Honest topology:** links come from NeighborInfo, traceroute segments, proven direct gateway receptions, and uniquely resolved relay bytes (low confidence, dashed). Every link shows provenance, per-direction SNR/RSSI statistics and a confidence reason.
- **Live pings:** each transmission heard live animates as a ring at the transmitter and a line to each direct receiver (D-053). The link layers start switched off.
- **MQTT bridges:** a glyph inside the marker shows which way a node moves packets between the mesh and MQTT: ↑ uplinks (a gateway), ↓ probably downlinks (its traceroute hops read exactly 0 dB, as packets taken from the broker do), ↕ both (D-054). Hops into downlinking nodes recorded at exactly 0 dB are MQTT links, drawn dotted green in their own layer and never counted as radio links (D-055).
- **Honest positions:** reported positions only from in-window packets. Estimates need ≥ 3 well-spaced anchors and are drawn as hollow markers with an uncertainty circle; there are no guessed pins.
- **Crypto:** AES-CTR and firmware 2.8.1+ AES-CCM channels, firmware-compatible XEdDSA verification with trust-on-first-use, and per-packet status (`verified`, `unsigned`, `unverifiable`, `not-applicable`). Verified against real firmware 2.8 traffic.
- **Light and dark themes:** follows the browser's setting by default (Auto); viewers can pick Light or Dark in the menu (☰).
- **Privacy:** no accounts, cookies, analytics or third-party requests; a [privacy policy](frontend/public/privacy.html) at `/privacy.html` fills in the deployment's operator, contact and retention from the API.
- **Installable and offline-capable:** add it to a phone's home screen; without a connection it opens with the last data it received (map tiles are not stored offline).
- **Self-hosted:** Docker Compose, a self-hosted PMTiles basemap with switchable layers (place, peak, road and border labels; most names hidden by default), no external services at runtime apart from the basemap service's OpenStreetMap downloads when it builds.

## Quick start (demo)

Requires Docker with Compose.

```sh
cp .env.example .env          # set POSTGRES_PASSWORD and DEMO_MODE=true
docker compose --profile demo up -d --build
open http://localhost:8080
```

The `demo` profile adds a local Mosquitto broker (compose network only) and a simulator for a 22-node mesh in Trøndelag. The simulator uses real encryption and signatures, flood relaying via several gateways, traceroutes, NeighborInfo, plaintext uplinks, unpositioned nodes, a relay-byte collision, and deliberately bad input (forged signatures, PKI DMs, malformed protobufs) that must be rejected. It refuses to publish to non-private hosts.

The `basemap` service starts too and downloads several GB of OpenStreetMap data for its first build; the map works without tiles until it finishes. Add `--scale basemap=0` to skip it.

## Real brokers and keys

```sh
mkdir -p secrets && cp config/examples/*.yaml secrets/
# edit secrets/mqtt-brokers.yaml  (several brokers: TLS/CA, credentials, client id, topic filters, v5 or v311)
# edit secrets/channel-keys.yaml  (several channels: name, mode ctr|ccm, PSKs current-first for rotation)
# .env: DEMO_MODE=false, strong POSTGRES_PASSWORD
docker compose run --rm backend check-config     # redacted summary or readable errors
docker compose up -d --build
```

Channel PSKs are symmetric channel keys, not node public keys. Secrets live in `./secrets` (mounted read-only); they are never logged, stored or returned by the API.

## Map tiles

The default is a self-hosted PMTiles archive, built on first start (and refreshed monthly) by the `basemap` service and served by the `web` service. To use an online OpenMapTiles-schema provider instead, set `MAP_TILE_SOURCE` to a TileJSON URL. See [docs/basemap.md](docs/basemap.md).

## Tests

The host needs only Docker; Go and Node run in containers.

```sh
scripts/go.sh go test ./...           # backend unit tests (incl. real-capture replay)
scripts/integration.sh                # Postgres/Redis/Mosquitto integration tests (time isolation, pipeline, retention)
scripts/node.sh npx vitest run        # frontend unit tests
scripts/wasm.sh test                  # engine (Rust) tests, incl. the golden 12 h fixture
scripts/wasm.sh                       # build the engine to WebAssembly (needed before frontend tests/builds)
docker run --rm --network host --ipc=host -v "$PWD":/src -w /src/frontend \
  mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test     # e2e against a running stack
                                      # (add -e UPDATE_SCREENSHOTS=1 to refresh docs/screenshots)
scripts/bench.sh                      # 2M-row reference benchmark
```

Every view is built in the browser, by a WebAssembly engine (`frontend/engine`, Rust) in a Web Worker, from the decoded rows of `/api/v1/observations` and the live stream (D-031, D-040, D-041).

## Operations

Health at `/health/ready`, metrics at `backend:9100/metrics`. Retention runs daily (6 calendar months by default). Backups (not automated) use `pg_dump` of `packet_log`; Redis is disposable. See [docs/operations.md](docs/operations.md) for deployment behind HTTPS, access control, data-loss windows, troubleshooting and the production security checklist.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Components, network diagram, data model, time isolation, trust model |
| [docs/protocol-compatibility.md](docs/protocol-compatibility.md) | Pinned upstream revisions; crypto, signing and traceroute facts verified against firmware |
| [docs/decisions.md](docs/decisions.md) | Decisions and deviations from the spec and plan |
| [docs/operations.md](docs/operations.md) | Deploy, configure, monitor, back up, troubleshoot |
| [docs/basemap.md](docs/basemap.md) | Basemap build, style, glyphs, licences |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Licenses of dependencies, fonts and map data |
| [docs/benchmarks.md](docs/benchmarks.md) | Reference-workload results |
| [docs/api-openapi.yaml](docs/api-openapi.yaml) | OpenAPI 3.1, generated from the serving code (also at `/api/openapi.yaml`) |

## Limitations

- The map shows what this service received over MQTT while it was running. It is not a complete history; gaps occur while brokers or the service are down.
- Timestamps are receive times (`observed_at`), not RF transmission times.
- Trust in node keys is trust-on-first-use; it lapses when a key's announcement ages out of retention.
- AES-CTR decryption proves nothing about integrity. Unsigned and unverifiable packets are labelled, not authenticated.
- Relay hints are single bytes: ambiguous matches produce no link. RF-based location estimates are coarse; uncalibrated estimates only say "somewhere among these anchors".
- Minimum supported firmware: 2.7.

## License

[GNU General Public License v3.0](LICENSE) (`GPL-3.0-only`). The backend's protocol code is generated from [Meshtastic's protobuf definitions](https://github.com/meshtastic/protobufs), which are GPL-3.0, so the whole project is too. Distributing it, including serving the frontend to visitors' browsers, means offering the corresponding source: the map links to the source it was built from (set `SOURCE_URL` when building the web image of a modified version). Third-party components, fonts and map data, and their licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Map data © OpenStreetMap contributors, © OpenMapTiles.

Meshtastic® is a registered trademark of Meshtastic LLC. This project is not affiliated with or endorsed by Meshtastic LLC.
