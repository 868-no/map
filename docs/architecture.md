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
│  decoded rows), snapshot, traffic, nodes/{id}, edges, stream (SSE) · health     │
│  query layer: every SQL via window.Predicate → graph reducer → geolocation       │
└───────────────┬───────────────────────────────┬──────────────────────────────────┘
                │                               │
        PostgreSQL 16                     Redis 7 (ephemeral)
        packet_log (only table)           dedupe keys, result cache,
                ▲                         retention revision, live pub/sub,
                │                         maintenance status
   maintenance (meshmap maintenance)
   daily retention under advisory lock

┌──────────── web (Caddy) :WEB_PORT ────────────┐
│  /            React app (MapLibre + deck.gl)  │
│               + derivation Web Worker         │
│               (rows in IndexedDB, D-031;      │
│               live rows via SSE, D-033)       │
│  /api, /health → backend:8000 (SSE flushed)   │
│  /tiles       self-hosted PMTiles (ranges)    │
│  /fonts, /styles  bundled glyphs + dark style │
└───────────────────────────────────────────────┘
```

Compose network: only `web` publishes a port. `backend:9100` serves Prometheus metrics inside the network. The `demo` profile adds `mosquitto` (compose network only) and `demo-publisher`.

## Data model

One application table, `packet_log` (`backend/internal/storage/schema.sql`): one row per accepted gateway reception. The row is append-mostly; only `decoded_metadata.also_via` is ever updated, for broker provenance (D-013). Keys:

- `logical_packet_key`: the RF packet (sender, packet id, destination, channel, port, canonical payload — payload excluded for traceroutes, which every hop rewrites).
- `observation_key`: one gateway's reception (logical key + gateway + receive metadata + payload hash). Unique per row in practice; it is the dedupe key.
- `observed_at`: server receive time, the only time used for windows.

`decoded_metadata` holds minimal, sanitised typed data (NodeInfo incl. public key, position, telemetry, neighbours, traceroute route/SNR, reception provenance). Message bodies are never stored. `envelope_bytes` keeps the raw envelope for re-decoding and audits; it is never returned by the API.

## Time isolation

`internal/window` is the single definition of the interval `[start, end)`. All window-scoped SQL is built by `query.where()`, which starts with `window.Predicate`; a test fails if any other code compares `observed_at` (allowlist: ingestion dedupe fallback and the retention delete). Node identity, positions, telemetry, edges, estimates, counts and traffic buckets are all computed from rows inside that interval only.

Cache keys and revisions include the exact window, filter hash, decoder version, configuration hash, retention revision and the newest in-window row id (D-014), so a cached result can never answer a different window or outlive deleted data.

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
  internal/storage        schema, COPY batches, ingestion lookups
  internal/window         window semantics, retention cutoff
  internal/query          snapshot, traffic, node detail, edges (window-scoped SQL)
  internal/graph          evidence → directed edges, confidence
  internal/geo            location estimates with uncertainty
  internal/cache          Redis wrapper, result cache with singleflight
  internal/api            huma handlers, SSE hub, health, rate limits, client IP
  internal/maintenance    retention runner
  internal/demo           simulator, scenarios, demo publisher
  test/integration        Postgres/Redis/Mosquitto integration tests
frontend/                 React + MapLibre GL 5 + deck.gl 9 (Vite); e2e/ Playwright
  src/derive/             Web Worker: row store (incremental sync, IndexedDB) and ports of
                          query/graph/geo that build every view in the browser (D-031)
web/                      Caddyfile, dark OpenMapTiles style, image build (fonts)
scripts/                  go.sh, node.sh, integration.sh, bench.sh, basemap_import.sh
```
