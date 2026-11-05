# Architecture

This page shows the components and where the code lives. The rules the system follows (ingest, storage, the derived views and the map) are in [design.md](design.md).

## Overview

```text
                 MQTT brokers (read-only subscriptions, v5 or v3.1.1, TLS optional)
                        │  msh/…/2/e/<channel>/<gateway>  (ServiceEnvelope protobuf)
                        ▼
┌──────────────────────────── backend (meshmap serve) ─────────────────────────────┐
│  mqtt clients ──► bounded queue ──► worker pool ──────────► batch writer         │
│  (observed_at      (drop+count       topic/envelope parse     COPY into          │
│   stamped here)     when full)       decrypt (CTR/CCM/plain)  packet_log, then:  │
│                                      port decode + sanitise   · dedupe marks     │
│                                      XEdDSA policy            · also_via updates │
│                                      dedupe claim             · identity promote │
│                                                               · live publish     │
│  identity index (in memory, rebuilt from packet_log)                             │
│                                                                                  │
│  HTTP API (huma, OpenAPI 3.1): capabilities, retention, observations (paged,     │
│  streamed rows), stream (SSE: every new row), nodes/{id}/public-key, trends,     │
│  weather · health · metrics                                                      │
│  query layer: every SQL via window.Predicate                                     │
└───────────────┬───────────────────────────────┬──────────────────────────────────┘
                │                               │
        PostgreSQL 16                     Redis 7 (ephemeral)
        packet_log (mesh data,            dedupe keys, live pub/sub,
        monthly partitions)               maintenance status
        weather_hour (weather, D-133)
        terrain_height (terrain, D-143)
                ▲
                │
   maintenance (meshmap maintenance)
   daily retention under advisory lock (drops whole months, trims weather_hour)

┌──────────── web (Caddy) :WEB_PORT ────────────┐
│  /            React app (MapLibre + deck.gl)  │
│               + derivation Web Worker running │
│               the WebAssembly engine (D-040): │
│               rows in IndexedDB, live via SSE │
│  /api, /health → backend:8000 (SSE flushed;   │
│    split upstreams in a scaled stack, D-157)  │
│  /tiles       self-hosted PMTiles (ranges)    │
│  /fonts, /styles  glyphs, dark + light styles │
└───────────────────────────────────────────────┘
```

Compose network: only `web` publishes a port. `backend:9100` serves Prometheus metrics inside the network. The `basemap` service builds `basemap.pmtiles` into the volume `web` serves `/tiles` from ([basemap.md](basemap.md)). The `demo` profile adds `mosquitto` (compose network only) and `demo-publisher`.

Scaled out (`deploy/stack.swarm.yaml`, D-157), the one process above becomes two services: `ingest` (`meshmap serve`, exactly one: MQTT ingest, the weather and terrain fetching and warming, broker health) and `backend` (`meshmap serve --no-ingest`, several replicas: the API, weather and terrain off, live rows over Redis pub/sub). `web` sends `/api/v1/weather`, `/api/v1/terrain*`, `/api/v1/capabilities` and `/health/*` to `FETCH_UPSTREAM` and the rest of `/api/*` to `API_UPSTREAM`; both default to `backend:8000`. See [operations.md](operations.md#scaling-horizontally-swarm).

## Data model

One table of mesh data, `packet_log` (`backend/internal/storage/schema.sql`), and one of weather, `weather_hour` (MET Norway's analysis per grid cell and hour, for chart bands; design §3.7, D-133). `packet_log`: one row per accepted gateway reception, range-partitioned by calendar month of `observed_at` (D-056). Partitions are created ahead by `storage.EnsurePartitions` and dropped whole by retention. The row is append-mostly; only `decoded_metadata.also_via` (broker provenance, D-013) and the stored row encoding below are ever updated. Keys:

- `logical_packet_key`: the RF packet (sender, packet id, destination, channel, port, canonical payload — payload excluded for traceroutes, which every hop rewrites).
- `observation_key`: one gateway's reception (logical key + gateway + receive metadata + payload hash). It is the dedupe key; a unique index on `(observation_key, observed_at)` makes a retried batch store nothing twice (D-056).
- `observed_at`: server receive time, the only time used for windows.

`decoded_metadata` holds minimal, sanitised typed data (NodeInfo incl. public key, position, telemetry, neighbours, traceroute route/SNR, reception provenance). Message bodies are never decoded into it. `envelope_bytes` keeps the raw envelope for re-decoding and audits; it is never returned by the API. For text messages that envelope still holds the message: encrypted with its channel key, or in plain text when a gateway uplinked it decrypted (the privacy policy says so).

`obs_row` holds the row exactly as `/observations` serves it (minus its id), and `obs_row_version` the `obsrow.Version` it was built with (D-046). Pages use it when the version is current and build the row from the other columns when it is not. At startup `serve` rebuilds missing or outdated encodings in the background, newest first. It is a cache of the row's own data, not derived state across rows.

## Time isolation

`internal/window` is the single definition of the interval `[start, end)`. All window-scoped SQL is built by `query.where()`, which starts with `window.Predicate`; a test fails if any other code compares `observed_at` (allowlist: ingestion dedupe fallback and the retention delete). `/observations` returns exactly the rows inside the interval; the `cursor` only positions within it (D-038). Pages are streamed from the database cursor, never collected in memory (D-057).

The browser's engine computes node identity, positions, telemetry, links, estimates, counts and traffic buckets from the rows inside the selected window only; its isolation test covers the derived fields (D-041). `/observations` reports a `generation` (decoder version, `obsrow.Version` and configuration hash); a browser holding rows of another generation discards them and refetches. Whole past days are the one cached result: `/observations/day/{date}` keeps each settled day gzipped in Redis and answers it immutable, so browsers and Cloudflare keep it too (D-158); imports advance a history revision that is part of the generation.

## Trust model

- MQTT authentication authenticates broker access, not radio senders. Topics, gateway ids and node ids are unauthenticated claims.
- AES-CTR channel decryption proves nothing about integrity. AES-CCM proves channel-key possession, not sender identity.
- XEdDSA signatures are verified per firmware rules (`docs/protocol-compatibility.md`); keys are trusted on first use via the CRC-32 node-number binding. After a key's announcement ages out of retention, that trust is gone (the next valid signed NodeInfo re-establishes it).
- Inferred links and estimated locations carry explicit provenance, confidence and uncertainty.

## Source layout

```text
backend/
  cmd/meshmap/            CLI: serve, maintenance, check-config, init-schema, demo-publish, inspect,
                          import-envelopes, healthcheck, openapi, seed, bench
  internal/config         env + YAML, validation, redaction, config revision
  internal/mqtt           read-only broker clients (autopaho v5, paho v3.1.1)
  internal/protocol       topic + envelope parsing; ports/ payload decoders; pb/ generated bindings
  internal/security       PSK, AES-CTR, AES-CCM, XEdDSA, signature policy, keyring
  internal/ingest         Process (pure), pipeline (queue, workers, writer, dedupe, provenance)
  internal/obsrow         the row format clients receive (/observations, live stream, obs_row)
  internal/identity       in-memory authoritative key index (rebuilt from packet_log)
  internal/storage        schema and migration, monthly partitions, batch inserts, ingestion lookups,
                          stored row encodings (D-046)
  internal/window         window semantics, retention cutoff
  internal/query          streamed /observations pages (window-scoped SQL)
  internal/geo            location-estimate settings (the estimator runs in the browser)
  internal/cache          Redis wrapper (dedupe, live pub/sub, maintenance status, cached days)
  internal/api            huma handlers, SSE hub, health, per-client limits, client IP
  internal/maintenance    retention runner (drops expired months, trims the boundary month and weather_hour)
  internal/weather        MET Norway client (OPeNDAP, grid cells), weather_hour store, fetch queue
  internal/terrain        Kartverket height client, terrain_height store, cross sections and line-of-sight classes
  internal/envimport      import-envelopes: replays recorded MQTT history through ingest.Process (D-137)
  internal/observability  logging and Prometheus metrics
  internal/demo           simulator, scenarios, demo publisher
  test/integration        Postgres/Redis/Mosquitto integration tests
  test/fixtures           real MQTT captures (public RF traffic) replayed by unit tests
frontend/                 React + MapLibre GL 5 + deck.gl 9 (Vite); e2e/ Playwright
  engine/                 Rust → WebAssembly: row store, links, location estimates, traffic,
                          node details, packet logs and routes, ping attribution (D-040)
  src/derive/             Web Worker: sync and coverage, IndexedDB chunks and deltas, drives the engine;
                          view types (views.ts)
  src/state/              store, window queries, live stream (live.ts)
web/                      Caddyfile, dark and light OpenMapTiles styles, image build (fonts)
basemap/                  basemap service image: Planetiler + run.sh (builds and refreshes basemap.pmtiles)
deploy/                   compose.production.yaml, stack.swarm.yaml (split for Swarm), Mosquitto config for the demo, caddy-auth snippets
scripts/                  go.sh, node.sh, wasm.sh, integration.sh, bench.sh, basemap_import.sh, regions.sh/regions.js
```
