# Architecture

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
│  HTTP API (huma, OpenAPI 3.1): capabilities, retention, observations (paged     │
│  decoded rows), stream (SSE: every new row) · health · metrics                  │
│  query layer: every SQL via window.Predicate                                    │
└───────────────┬───────────────────────────────┬──────────────────────────────────┘
                │                               │
        PostgreSQL 16                     Redis 7 (ephemeral)
        packet_log (only table)           dedupe keys, live pub/sub,
                ▲                         maintenance status
                │
   maintenance (meshmap maintenance)
   daily retention under advisory lock

┌──────────── web (Caddy) :WEB_PORT ────────────┐
│  /            React app (MapLibre + deck.gl)  │
│               + derivation Web Worker running │
│               the WebAssembly engine (D-040): │
│               rows in IndexedDB, live via SSE │
│  /api, /health → backend:8000 (SSE flushed)   │
│  /tiles       self-hosted PMTiles (ranges)    │
│  /fonts, /styles  glyphs, dark + light styles │
└───────────────────────────────────────────────┘
```

Compose network: only `web` publishes a port. `backend:9100` serves Prometheus metrics inside the network. The `basemap` service builds `basemap.pmtiles` into the volume `web` serves `/tiles` from ([basemap.md](basemap.md)). The `demo` profile adds `mosquitto` (compose network only) and `demo-publisher`.

## Data model

One application table, `packet_log` (`backend/internal/storage/schema.sql`): one row per accepted gateway reception. The row is append-mostly; only `decoded_metadata.also_via` (broker provenance, D-013) and the stored row encoding below are ever updated. Keys:

- `logical_packet_key`: the RF packet (sender, packet id, destination, channel, port, canonical payload — payload excluded for traceroutes, which every hop rewrites).
- `observation_key`: one gateway's reception (logical key + gateway + receive metadata + payload hash). Unique per row in practice; it is the dedupe key.
- `observed_at`: server receive time, the only time used for windows.

`decoded_metadata` holds minimal, sanitised typed data (NodeInfo incl. public key, position, telemetry, neighbours, traceroute route/SNR, reception provenance). Message bodies are never decoded into it. `envelope_bytes` keeps the raw envelope for re-decoding and audits; it is never returned by the API. For text messages that envelope still holds the message: encrypted with its channel key, or in plain text when a gateway uplinked it decrypted (the privacy policy says so).

`obs_row` holds the row exactly as `/observations` serves it (minus its id), and `obs_row_version` the `ObsRowVersion` it was built with (D-046). Pages use it when the version is current and build the row from the other columns when it is not. At startup `serve` rebuilds missing or outdated encodings in the background, newest first. It is a cache of the row's own data, not derived state across rows.

## Time isolation

`internal/window` is the single definition of the interval `[start, end)`. All window-scoped SQL is built by `query.where()`, which starts with `window.Predicate`; a test fails if any other code compares `observed_at` (allowlist: ingestion dedupe fallback and the retention delete). `/observations` returns exactly the rows inside the interval; the `cursor` only positions within it (D-038).

The browser's engine computes node identity, positions, telemetry, links, estimates, counts and traffic buckets from the rows inside the selected window only; its isolation test covers the derived fields (D-041). `/observations` reports a `generation` (decoder version, `ObsRowVersion` and configuration hash); a browser holding rows of another generation discards them and refetches. The server keeps no cache of results.

## Trust model

- MQTT authentication authenticates broker access, not radio senders. Topics, gateway ids and node ids are unauthenticated claims.
- AES-CTR channel decryption proves nothing about integrity. AES-CCM proves channel-key possession, not sender identity.
- XEdDSA signatures are verified per firmware rules (`docs/protocol-compatibility.md`); keys are trusted on first use via the CRC-32 node-number binding. After a key's announcement ages out of retention, that trust is gone (the next valid signed NodeInfo re-establishes it).
- Inferred links and estimated locations carry explicit provenance, confidence and uncertainty.

## Source layout

```text
backend/
  cmd/meshmap/            CLI: serve, maintenance, check-config, init-schema, demo-publish, inspect,
                          healthcheck, openapi, seed, bench
  internal/config         env + YAML, validation, redaction, config revision
  internal/mqtt           read-only broker clients (autopaho v5, paho v3.1.1)
  internal/protocol       topic + envelope parsing; ports/ payload decoders; pb/ generated bindings
  internal/security       PSK, AES-CTR, AES-CCM, XEdDSA, signature policy, keyring
  internal/ingest         Process (pure), pipeline (queue, workers, writer, dedupe, provenance)
  internal/identity       in-memory authoritative key index (rebuilt from packet_log)
  internal/storage        schema, COPY batches, ingestion lookups, stored row encodings (D-046)
  internal/window         window semantics, retention cutoff
  internal/query          /observations paging (window-scoped SQL)
  internal/geo            location-estimate settings (the estimator runs in the browser)
  internal/cache          Redis wrapper (dedupe, live pub/sub, maintenance status)
  internal/api            huma handlers, SSE hub, health, rate limits, client IP
  internal/maintenance    retention runner
  internal/observability  logging and Prometheus metrics
  internal/demo           simulator, scenarios, demo publisher
  test/integration        Postgres/Redis/Mosquitto integration tests
  test/fixtures           real MQTT captures (public RF traffic) replayed by unit tests
frontend/                 React + MapLibre GL 5 + deck.gl 9 (Vite); e2e/ Playwright
  engine/                 Rust → WebAssembly: row store, links, location estimates, traffic,
                          node details, packet logs and routes, ping attribution (D-040)
  src/derive/             Web Worker: sync and coverage, IndexedDB chunks, drives the engine
web/                      Caddyfile, dark OpenMapTiles style, image build (fonts)
basemap/                  basemap service image: Planetiler + run.sh (builds and refreshes basemap.pmtiles)
deploy/                   compose.production.yaml, Mosquitto config for the demo, caddy-auth snippets
scripts/                  go.sh, node.sh, wasm.sh, integration.sh, bench.sh, basemap_import.sh
```
