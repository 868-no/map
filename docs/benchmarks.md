# Benchmarks

Reproduce with `scripts/bench.sh [rows] [nodes]` (server) and `frontend/e2e/perf.spec.ts` (browser).

## Environment (2026-10-31)

- Host: 16 CPUs, 31 GiB RAM, NVMe; Docker.
- PostgreSQL 16 container limited to **4 vCPU / 8 GiB** (the spec's reference machine), `shared_buffers=2GB`; Redis 1 vCPU / 512 MiB.
- Backend: Go 1.26, the production query code via an in-process HTTP server (not CPU-limited).
- Data: `meshmap seed`, 2 000 nodes (1 500 signing, 175 gateways, 487 unpositioned, 15 095 directed RF links), **2 000 000 observations** over 30 days through the production `Process` + COPY path (real CTR/CCM encryption and XEdDSA signatures). Table plus indexes: 2.5 GB.

## Ingest

| Measure | Result |
| --- | --- |
| `seed` throughput (Process + verify + COPY, single writer) | 7 300 rows/s (≈ 73× the 100 msg/s reference burst) |
| Process per message (unit benchmark scale) | sub-millisecond; `meshmap_ingest_process_seconds` histogram in production |

## API latency (8 requests each; cold = Redis flushed and a distinct window per request)

| Endpoint | Window | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Payload |
| --- | --- | --- | --- | --- | --- | --- |
| snapshot | 24 h | 569 ms | 599 ms | 136 ms | 144 ms | 7.1 MiB |
| snapshot | **72 h** | **1.50 s** | **1.63 s** | **143 ms** | **144 ms** | 7.6 MiB |
| snapshot | 168 h | 4.69 s | 6.94 s | 158 ms | 341 ms | 7.9 MiB |
| edges | 72 h | 1.49 s | 1.50 s | 144 ms | 147 ms | 6.0 MiB |
| traffic | 72 h | 219 ms | 238 ms | 20 ms | 21 ms | 27 KiB |
| traffic | 168 h | 444 ms | 658 ms | 21 ms | 35 ms | 16 KiB |

Spec targets for the 3-day snapshot: ≤ 2 s warm, ≤ 10 s cold. **Met** (143 ms / 1.6 s at p95). Payloads are uncompressed JSON; the `web` service compresses them with zstd/gzip. Warm latency is dominated by JSON (de)serialisation of the cached ~7 MiB result.

## Browser (Playwright, headless Chromium, software WebGL via SwiftShader, no GPU)

A synthetic snapshot at reference density is injected via request interception; the real frontend renders it.

| Scene | JS heap after GC | Panning frame rate |
| --- | --- | --- |
| Empty mesh (basemap only) | 16 MiB | 24.5 fps |
| 2 000 nodes / 20 000 edges | **28 MiB** | 11.4 fps |

The heap target (< 250 MiB) is met with a large margin; the browser never holds raw history. Frame rates here are CPU-rasterised (SwiftShader) and are **not representative of a desktop GPU**. They are useful as a relative measure: level-of-detail rendering (best-supported 3 000 links below zoom 9, viewport-culled links above, arrowheads only from zoom 9) raised the dense-scene rate from 4.7 to 11.4 fps under identical conditions. The 60 fps desktop target has not been verified on GPU hardware in this environment; measure it on target hardware with the same spec file in headed mode.

## Observations and follow-ups

- The 168 h cold snapshot (p95 6.9 s) is the slowest path; `EXPLAIN` shows window scans dominated by the reception query for edges (direct RF/relay rows). Candidate optimisations if needed: a partial index on receptions with RF metrics, or pre-aggregating per (src, gateway) in SQL instead of streaming rows.
- `packet_log_type_time_idx` is used by NodeInfo/Position/evidence queries; keep it. The BRIN index costs little and speeds retention deletes; keep it.
- Snapshot payloads are a few MiB at reference density; the client caps work by level of detail rather than by downloading less, which keeps counts exact.
