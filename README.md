# Meshtastic MQTT Mesh Observatory

An interactive, permanently dark map for observing Meshtastic mesh networks using only traffic from one or more MQTT brokers. It decrypts channel traffic, verifies XEdDSA packet signatures and stores each accepted gateway reception in one PostgreSQL table (`packet_log`). From that table it reconstructs nodes, evidence-backed RF links, traffic and coarse location estimates for any time window in the retention period. Nothing from outside the selected window ever leaks into a view.

![Live overview](docs/screenshots/live-overview.png)

- **Time windows:** default rolling 3 days, presets from 1 h to 7 d, custom start/end, slide the window back through 6 months. Live updates arrive over SSE.
- **Honest topology:** links come from NeighborInfo, traceroute segments, proven direct gateway receptions, and uniquely resolved relay bytes (low confidence, dashed). Every link shows provenance, per-direction SNR/RSSI statistics and a confidence reason.
- **Honest positions:** reported positions only from in-window packets. Estimates need ≥ 3 well-spaced anchors and are drawn as hollow markers with an uncertainty circle; there are no guessed pins.
- **Crypto:** AES-CTR and firmware 2.8.1+ AES-CCM channels, firmware-compatible XEdDSA verification with trust-on-first-use, and per-packet status (`verified`, `unsigned`, `unverifiable`, `not-applicable`). Verified against real firmware 2.8 traffic.
- **Installable and offline-capable:** add it to a phone's home screen; without a connection it opens with the last data it received (map tiles are not stored offline).
- **Self-hosted:** Docker Compose, a self-hosted PMTiles basemap with switchable layers (place, peak, road and border labels; most names hidden by default), no external services at runtime.

## Quick start (offline demo)

Requires Docker with Compose.

```sh
cp .env.example .env          # set POSTGRES_PASSWORD and DEMO_MODE=true
scripts/basemap_import.sh     # self-hosted Norway basemap (~10 min, 1.7 GB), once
docker compose --profile demo up -d --build
open http://localhost:8080
```

The `demo` profile adds a local Mosquitto broker (compose network only) and a simulator for a 22-node mesh in Trøndelag. The simulator uses real encryption and signatures, flood relaying via several gateways, traceroutes, NeighborInfo, plaintext uplinks, unpositioned nodes, a relay-byte collision, and deliberately bad input (forged signatures, PKI DMs, malformed protobufs) that must be rejected. It refuses to publish to non-private hosts.

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

The default is a self-hosted PMTiles archive (`scripts/basemap_import.sh [geofabrik-area]`) served by the `web` service. To use an online OpenMapTiles-schema provider instead, set `MAP_TILE_SOURCE` to a TileJSON URL. See [docs/basemap.md](docs/basemap.md).

## Tests

The host needs only Docker; Go and Node run in containers.

```sh
scripts/go.sh go test ./...           # backend unit tests (incl. real-capture replay)
scripts/integration.sh                # Postgres/Redis/Mosquitto integration tests (spec §17 tests 1-35)
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

Health at `/health/ready`, metrics at `backend:9100/metrics`. Retention runs daily (6 calendar months by default). Backups use `pg_dump` of `packet_log`; Redis is disposable. See [docs/operations.md](docs/operations.md) for deployment behind HTTPS, access control, data-loss windows, troubleshooting and the production security checklist.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Components, network diagram, data model, time isolation, trust model |
| [docs/protocol-compatibility.md](docs/protocol-compatibility.md) | Pinned upstream revisions; crypto, signing and traceroute facts verified against firmware |
| [docs/decisions.md](docs/decisions.md) | Decisions and deviations from the spec and plan |
| [docs/operations.md](docs/operations.md) | Deploy, configure, monitor, back up, troubleshoot |
| [docs/basemap.md](docs/basemap.md) | Basemap build, style, glyphs, licences |
| [docs/benchmarks.md](docs/benchmarks.md) | Reference-workload results |
| [docs/api-openapi.yaml](docs/api-openapi.yaml) | OpenAPI 3.1, generated from the serving code (also at `/api/openapi.yaml`) |

## Limitations

- The map shows what this service received over MQTT while it was running. It is not a complete history; gaps occur while brokers or the service are down.
- Timestamps are receive times (`observed_at`), not RF transmission times.
- Trust in node keys is trust-on-first-use; it lapses when a key's announcement ages out of retention.
- AES-CTR decryption proves nothing about integrity. Unsigned and unverifiable packets are labelled, not authenticated.
- Relay hints are single bytes: ambiguous matches produce no link. RF-based location estimates are coarse; uncalibrated estimates only say "somewhere among these anchors".
- Minimum supported firmware: 2.7.

Map data © OpenStreetMap contributors, © OpenMapTiles.
