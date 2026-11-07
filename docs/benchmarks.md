# Benchmarks

Reproduce with `scripts/bench.sh [rows] [nodes]` (server; it also saves each window's rows to `frontend/.bench/`), `frontend/bench/engine.mjs` (the WebAssembly engine, on those rows or a real mesh's: see its header) and `frontend/e2e/perf.spec.ts` (browser).

## Environment (2026-11-07)

- Host: 16 CPUs, 31 GiB RAM, NVMe; Docker.
- PostgreSQL 16 container limited to **4 vCPU / 8 GiB** (the reference machine, [design.md](design.md) §9), `shared_buffers=2GB`; Redis 1 vCPU / 512 MiB.
- Backend: Go 1.26, the production query code via an in-process HTTP server (not CPU-limited). Engine: Node 22.
- Data: `meshmap seed`, 2 000 nodes (1 500 signing, 175 gateways, 487 unpositioned, 15 095 directed RF links), **2 000 000 observations** over 30 days through the production `Process` + COPY path (real CTR/CCM encryption and XEdDSA signatures). Table plus indexes, over its monthly partitions: 3.1 GB.

## Ingest

| Measure | Result |
| --- | --- |
| `seed` throughput (Process + verify + COPY, single writer) | 6 200–7 300 rows/s over two runs (≥ 62× the 100 msg/s reference burst) |
| Process per message (unit benchmark scale) | sub-millisecond; `meshmap_ingest_process_seconds` histogram in production |

## Fetching a window (`meshmap bench`, 8 fetches each, all pages, sequential)

Since D-041 the server only returns rows; a browser opening a window fetches every row of it once, then only what is new (the copy persists in IndexedDB).

| Window | Rows | Pages | Uncompressed | First page p50 | Whole window p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 24 h | 63 358 | 4 | 26 MiB | 29 ms | 0.24 s | 0.25 s |
| **72 h** | 190 210 | 10 | 78 MiB | 26 ms | **0.69 s** | 0.72 s |
| 168 h | 444 200 | 23 | 183 MiB | 28 ms | 1.59 s | 1.72 s |

Two runs agreed within 2 %. On 2026-10-31 a 72 h window took 1.60 s and its first page 119 ms; stored row encodings (D-046) and streamed pages (D-057) account for the difference. Pages are served by the `observed_at` index (D-038), so the time per row does not grow with retained history. Rows compress to roughly 57 bytes each with gzip (zstd slightly smaller), so a first visit to a 72 h window at reference density transfers about 11 MB; later visits transfer only rows newer than what is held. The browser fetches the rest of a range in four parallel time slices after the first page, so wall time is shorter than these sequential figures. Target for a 3-day window (design.md §9): ≤ 10 s from empty. **Met** (0.7 s server time, before network).

## Derivation (WebAssembly engine, `frontend/bench/engine.mjs`, Node 22)

Rows are loaded in 20 000-row pages, as the worker gets them. Each view is the median of 5 builds; node detail, packet log, traffic and health are for a built snapshot (as when a panel opens), node detail and packet log for the node that sent the most rows.

| Window | Rows | Load | Snapshot | Rebuild after a live batch | Traffic | Node detail | Packet log | Health | Snapshot JSON | Engine memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **72 h**, reference | 190 206 | 644 ms | **298 ms** | 188 ms | 5 ms | 2 ms | 4 ms | 41 ms | 6.2 MiB | 199 MiB |
| 168 h, reference | 444 200 | 1 033 ms | **400 ms** | 399 ms | 14 ms | 5 ms | 9 ms | 87 ms | 6.5 MiB | 216 MiB |
| 168 h, production (to 2026-11-07) | 104 564 | 283 ms | **106 ms** | 95 ms | 3 ms | 2 ms | 3 ms | 21 ms | 0.7 MiB | 96 MiB |

- The real mesh is lighter than the reference workload: 505 nodes and 1 616 links over 7 days (the last 72 h of it: snapshot 42 ms).
- The TypeScript implementation the engine replaced (D-040) built a 72 h snapshot of the reference workload in 1 609 ms with a 391 MiB heap, and 168 h in 6 235 ms with 823 MiB (2026-10-31).
- WebAssembly memory never shrinks; a range change that drops most rows moves them to a fresh instance (`freshEngine` in the worker). Since 2026-10-31 (139 / 249 MiB) the engine holds more per row for the views added since; 216 MiB for a week at reference density is within budget.
- All of this runs in the worker. The page's only cost per view is decoding and parsing the transferred JSON (6.2 MiB snapshot: 24 ms).
- Live updates rebuild the whole snapshot, debounced by window length: 2 s quiet / 5 s at most up to 6 h, 10 s / 15 s from 24 h (D-058), and never less than 20× / 30× the last snapshot build (D-083). At 0.1–0.4 s off the main thread, incremental aggregation would add a lot of complexity for little benefit at reference density; revisit if meshes grow well beyond it.

## Engine build: size against speed (2026-11-05)

The production log's last 7 days (98 267 rows), Node 22, median of 3 runs. All builds strip the name section (debug names only, 180 KB) and use unstable sorts where ties cannot differ (one sort routine per call site was 276 KB of code); the release profile is opt-level 3 with `wasm-opt -O3` (`scripts/wasm.sh`): opt-level "s" saves 33 KB gzipped, once per engine version, but slows every live rebuild by 10-15 % and health by 35 %, so speed was chosen.

| Build | Raw | gzip | Load | Snapshot 72 h | Snapshot 168 h | Health 168 h | Live batch + rebuild 168 h |
| --- | --- | --- | --- | --- | --- | --- | --- |
| opt-level 3, before | 1 175 KB | 342 KB | 832 ms | 125 ms | 297 ms | 63 ms | 302 ms |
| **opt-level 3, `wasm-opt -O3`** | **927 KB** | **342 KB** | 832 ms | 136 ms | 293 ms | 68 ms | 300 ms |
| opt-level "s", `wasm-opt -Os` | 803 KB | 309 KB | 968 ms | 147 ms | 333 ms | 89 ms | 336 ms |
| opt-level "z", `wasm-opt -Oz` | 677 KB | 272 KB | 1 464 ms | 240 ms | 543 ms | 134 ms | 556 ms |

"s" sends about 10 % less for views 10–15 % slower (health 35 %), all in the worker; "z" halves view speed for another 10 %. These timings were taken with an earlier harness and are comparable only with each other; the current build (2026-11-07) is 953 KB raw, 352 KB gzipped, and its timings are in the derivation table above.

## Browser (Playwright, headless Chromium, software WebGL via SwiftShader, no GPU)

Synthetic observations at reference density (positions, NodeInfo and NeighborInfo for 2 000 nodes, 20 000 links) are served by request interception; the browser derives and renders them.

| Scene | JS heap after GC | Panning frame rate |
| --- | --- | --- |
| Empty mesh (basemap only) | 12 MiB | 24.5 fps |
| 2 000 nodes / 20 000 links | **35 MiB** | 9.4 fps |

Three runs each, 2026-11-07, against the local stack; the heap is read from DevTools (`Runtime.getHeapUsage`): `performance.memory` is coarse and cached, and gave the same figure for both scenes. The heap target (< 250 MiB) is met with a large margin; the browser never holds raw history. Frame rates here are CPU-rasterised (SwiftShader) and are **not representative of a desktop GPU**; they are useful as a relative measure. Level-of-detail rendering (best-supported 3 000 links below zoom 9, viewport-culled links above) raised the dense-scene rate from 4.7 to 11.4 fps under identical conditions (2026-10-31). The dense scene now runs at 9.4 fps; since D-186 every node draws a role glyph as well as its disc, which is a likely but unmeasured share of the difference. The 60 fps desktop target has not been verified on GPU hardware in this environment; measure it on target hardware with the same spec file in headed mode.

## Observations and follow-ups

- The engine's row representation could shrink further (about 560 bytes per row held, including the id index and vector growth); not needed at reference density.
- `packet_log_time_idx` serves every `/observations` page. The BRIN index was dropped in D-056: it was never scanned, and retention now drops whole monthly partitions. The two indexes that only served the retired server views were dropped (D-045); every remaining index serves a named query (see the comments in `schema.sql`).
- The JS heap figure excludes WebAssembly memory (see the derivation table).

## Streamed pages (2026-11-01, dev stack, live data)

One 7-day `/observations` page of 20 000 rows (8.4 MB, 1.2 MB with zstd), through Caddy, after D-057: time to first byte 2–4 ms (it was about 170 ms when the page was built in memory), whole response 34–41 ms uncompressed and 36–45 ms with zstd (2026-11-07; 60–100 ms on 2026-11-01). Engine rebuild of all five views on the same data (native, D-060): 20.4 → 19.6 ms.

