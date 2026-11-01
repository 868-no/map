# Benchmarks

Reproduce with `scripts/bench.sh [rows] [nodes]` (server; `meshmap bench --dump` also saves a window's rows for engine measurements) and `frontend/e2e/perf.spec.ts` (browser).

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

## Fetching a window (`meshmap bench`, 6 fetches each, all pages, sequential)

Since D-041 the server only returns rows; a browser opening a window fetches every row of it once, then only what is new (the copy persists in IndexedDB).

| Window | Rows | Pages | Uncompressed | First page p50 | Whole window p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| **72 h** | 188 799 | 10 | 72 MiB | 119 ms | **1.60 s** | 1.64 s |
| 168 h | 440 968 | 23 | 169 MiB | 156 ms | 3.74 s | 3.84 s |

These figures predate stored row encodings (D-046), which roughly halved whole-window time in a separate measurement (190k rows over 72 h, 9 sequential pages: p50 4.6 s → 2.5 s). Pages are served by the `observed_at` index (D-038), so the time per row does not grow with retained history. Rows compress to roughly 57 bytes each with gzip (zstd slightly smaller), so a first visit to a 72 h window at reference density transfers about 11 MB; later visits transfer only rows newer than what is held. The browser fetches the rest of a range in four parallel time slices after the first page, so wall time is shorter than these sequential figures. Spec target for a 3-day window: ≤ 10 s from empty. **Met** (1.6 s server time, before network).

## Derivation (WebAssembly engine vs the TypeScript it replaced, Node 22 / V8, same rows)

| Window | Engine load | Snapshot | Rebuild after a live batch | Traffic | Node detail | Packet log | Engine memory | TypeScript snapshot | TypeScript heap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **72 h** (188 863 rows) | 520 ms | **200 ms** | 179 ms | 19 ms | 6 ms | 4 ms | 139 MiB | 1 609 ms | 391 MiB |
| 168 h (441 030 rows) | 1 046 ms | **358 ms** | 364 ms | 42 ms | 12 ms | 10 ms | 249 MiB | 6 235 ms | 823 MiB |

- The engine builds a snapshot **8× (72 h) to 17× (168 h) faster** than the TypeScript implementation, in about a third of the memory. Loading costs the same as `JSON.parse` alone, and no JavaScript objects are created for rows.
- Engine memory is measured with page-sized loads (20 000 rows, as the app feeds it). WebAssembly memory never shrinks, so loading one huge string at once reserves more (286 / 604 MiB in that test).
- All of this runs in the worker. The page's only cost per view is decoding and parsing the transferred JSON (7.5 MiB snapshot: about 26 ms).
- Live updates rebuild the whole snapshot, debounced by window length: 2 s quiet / 5 s at most up to 6 h, 10 s / 15 s from 24 h (D-058). At 0.2–0.4 s off the main thread, incremental aggregation would add a lot of complexity for little benefit at reference density; revisit if meshes grow well beyond it.

## Browser (Playwright, headless Chromium, software WebGL via SwiftShader, no GPU)

Synthetic observations at reference density (positions, NodeInfo and NeighborInfo for 2 000 nodes, 20 000 links) are served by request interception; the browser derives and renders them.

| Scene | JS heap after GC | Panning frame rate |
| --- | --- | --- |
| Empty mesh (basemap only) | 15 MiB | 9.1 fps |
| 2 000 nodes / 20 000 links | **26 MiB** | 11.8 fps |

The heap target (< 250 MiB) is met with a large margin; the browser never holds raw history. Frame rates here are CPU-rasterised (SwiftShader) and are **not representative of a desktop GPU**. They are useful as a relative measure: level-of-detail rendering (best-supported 3 000 links below zoom 9, viewport-culled links above, arrowheads only from zoom 9) raised the dense-scene rate from 4.7 to 11.4 fps under identical conditions. The 60 fps desktop target has not been verified on GPU hardware in this environment; measure it on target hardware with the same spec file in headed mode.

## Observations and follow-ups

- The engine's row representation could shrink further (about 560 bytes per row held, including the id index and vector growth); not needed at reference density.
- `packet_log_time_idx` serves every `/observations` page. The BRIN index was dropped in D-056: it was never scanned, and retention now drops whole monthly partitions. The two indexes that only served the retired server views were dropped (D-045); every remaining index serves a named query (see the comments in `schema.sql`).
- The JS heap figure excludes WebAssembly memory (see the derivation table).

## Streamed pages (2026-11-01, dev stack, live data)

One 7-day `/observations` page of 17 162 rows (7.3 MB, 1.0 MB with zstd), through Caddy, after D-057: time to first byte about 5 ms (it was about 170 ms when the page was built in memory), whole response 60–65 ms uncompressed and 80–100 ms with zstd. Engine rebuild of all five views on the same data (native, D-060): 20.4 → 19.6 ms.

