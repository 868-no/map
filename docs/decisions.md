# Decisions and deviations

Each entry: context, decision, consequence. Spec = `MESHTASTIC_MESH_MAP_SPEC.md`, Plan = `IMPLEMENTATION_PLAN.md`.

## D-001 Go backend (2026-10-31)

Spec §13 recommends Python and permits Go "if XEdDSA and protocol support are demonstrably better". The operator chose Go. Protocol support is adequate: generated `google.golang.org/protobuf` bindings from the pinned upstream protos, stdlib AES-CTR, Pion's RFC 3610 CCM, stdlib Ed25519. XEdDSA: see D-002.

## D-002 XEdDSA verification without a dedicated XEdDSA library (2026-10-31)

Spec §3.3 forbids "generic Ed25519 verification" as a substitute and §13 forbids implementing XEdDSA from scratch. XEdDSA *verification* is, by definition, Ed25519 verification under the Edwards form (sign bit 0) of the Montgomery public key. Firmware does exactly this (`CryptoEngine::curve_to_ed_pub` + `ed25519Verify`). We do the same with vetted primitives: `filippo.io/edwards25519/field` for the birational map and stdlib `crypto/ed25519.Verify`. No new curve arithmetic is written.

Acceptance gates (Plan §3.5):
1. Conversion matches stdlib Ed25519 + `x/crypto/curve25519` for ≥ 1 000 random keys — **pass** (`TestConvertX25519MatchesIndependentDerivation`).
2. Signature round trip and header/payload/signature mutations — **pass** (`TestXEdDSARoundTripAndMutations`, `TestXEdDSASignBitOneFails`).
3. Real firmware 2.8 captures verify — see D-003.

The cgo libxeddsa fallback is not needed.

## D-003 Ground truth from mqtt.868.no (2026-10-31) — gate 3 passed

Read-only captures of the Norwegian community broker, run through the production `ingest.Process` (`meshmap inspect`), with keys learned strictly in arrival order (production semantics):
- 30-minute capture: 15 signed first-contact NodeInfo packets from real firmware 2.8 nodes verified with the CRC-32 key binding; signed Telemetry verified against learned keys.
- ~2.5-hour capture (1 062 messages): 49 verified NodeInfo; **8 signed Position packets verified against keys learned from earlier NodeInfo** in strict arrival order (13 when keys from the whole capture are used, `--two-pass`), plus verified Telemetry and NeighborInfo; 29 identities.
- **Zero** `sig_invalid`, `sig_malformed`, `first_contact_invalid` or `nodeinfo_key_mismatch` rejections on real traffic.

Both captures are committed under `backend/test/fixtures/captured/` (the operator considers RF broadcasts public) and replayed by `internal/ingest/captured_test.go`, which fails on any signature rejection of real traffic.

## D-004 CCM cross-check method (2026-10-31)

The plan considered compiling firmware `aes-ccm.cpp` to emit reference vectors. Instead the CCM library is validated against RFC 3610 (the firmware file is the hostap RFC 3610 implementation with L = 2), and nonce/AAD construction is matched to firmware source line by line. Real AEAD traffic has not yet been observed on the test broker; when it is, add a captured fixture. Until then CCM is supported but marked "verified against spec vectors only" in this document.

## D-005 Plan amendments after review (2026-10-31)

Recorded in Plan §9: traceroute placeholders, traceroute logical key, public keys in `decoded_metadata`, plaintext uplink path, firmware ≥ 2.7 and precision-unknown positions, quantized live windows, dedupe-after-commit, shared cursor secret, trusted proxies, queue-full loss accounting, multi-level topic roots.

## D-006 Strict policy scope (2026-10-31)

`SIGNATURE_POLICY=strict` rejects unverifiable signatures only (spec §3.3), not unsigned packets as firmware Strict does. See `docs/protocol-compatibility.md`.

## D-007 Additional index (2026-10-31)

`packet_log_type_time_idx (packet_type, observed_at DESC)` added beyond spec §5: snapshot queries select NodeInfo/Position/evidence rows by type inside a window. To be confirmed or dropped by the M5 benchmark together with the BRIN index.
- (Since D-041 there are no snapshot queries; the index now serves the identity rebuild at startup. The BRIN index was dropped in D-056.)

## D-008 NeighborInfo node_id mismatch (2026-10-31)

A NeighborInfo whose `node_id` is nonzero and differs from the packet sender is rejected as `payload_invalid`: it would otherwise let one node assert another node's neighbours.

## D-009 Identity index in process memory (2026-10-31)

Plan §3.5 put the authoritative-key index in a Redis hash. Ingest is a singleton (several ingest processes subscribed to the same brokers would only produce duplicates), so the index lives in the ingest process (`internal/identity`), rebuilt from verified NodeInfo rows in `packet_log` at startup, hourly and on every retention event. It remains ephemeral and fully reconstructible; no second durable store exists. Verified by `TestPipelineDemoStream` (rebuilt index equals live index).

## D-010 Integration test harness (2026-10-31)

Plan §7 named testcontainers-go. Integration tests instead run via `scripts/integration.sh`, which starts throwaway Postgres, Redis and Mosquitto containers on a private network and runs `go test -tags integration` in the Go container beside them. Same coverage, no Docker-socket access from inside the test container.

## D-011 Observation dedupe: in-flight claim (2026-10-31)

Plan amendment 7 marked keys only after commit and accepted a "narrow race". The integration test showed the race is not narrow: two brokers delivering the same upload milliseconds apart is the common case (202 duplicates in a burst). Workers now atomically claim the observation key in an in-process in-flight set before checking committed keys (in-process TTL set → Redis → database). This keeps amendment 7's guarantee — a claim is only held by observations already handed to the writer, which retries until commit, so a dropped message never suppresses a later copy — and removes the race.

## D-012 Retention cutoff definition (2026-10-31)

`window.RetentionCutoff` subtracts calendar months and clamps to the end of the target month (Aug 31 − 6 months = Feb 28/29), matching PostgreSQL interval semantics. Go's `AddDate` would normalise to Mar 3. The deleter and the API bound both use this one function; rows exactly at the cutoff are kept (`observed_at < cutoff` is deleted).

## D-013 Broker provenance for duplicate deliveries (2026-10-31)

The same gateway upload can reach us through several brokers (bridged brokers, or a gateway publishing to more than one broker). Such copies are byte-identical and carry no new RF information, so they remain one row per gateway reception (deduplicated by `observation_key`); `broker_id` is the first broker to deliver it. Every other broker that delivers it is recorded in `decoded_metadata.also_via` (debug aid):
- copies arriving while the row is still in memory (claimed, not yet committed) are merged before the INSERT, re-checked on every insert retry;
- copies arriving after commit are queued by primary key (row ids are remembered in the in-process recent set and in Redis for the 15-minute dedupe window, or found via the DB fallback) and applied by the writer as one batched `UPDATE … FROM unnest(…)` per flush. The SQL never adds a broker already present (first broker or existing entry) and skips rows needing no change; same-broker replays cause no update.
- `meshmap_ingest_duplicate_deliveries_total{broker}` counts cross-broker copies; `meshmap_ingest_provenance_updates_total{result}` counts row updates.

`packet_log` is therefore append-mostly: only `decoded_metadata.also_via` is ever updated. `fillfactor = 90` leaves room for HOT updates (no index writes). Measured (`TestBridgedBrokerLag`, bridge delay exponential with 150 ms mean): 92 % of rows needed a post-commit update (rows usually commit within ~100 ms, so the in-memory merge rarely wins), and 84 % of those updates were HOT. Worst case (every row updated in large batches long after insert): ~12 % HOT, because a page's free space fits only about one new row version per transaction. Revisit the fillfactor in the M5 benchmark against real broker topologies.

Distinct receptions — different gateway, relay ("last hop"), hop count, RF metrics or partial traceroute route — are always separate rows. Brokers do not hear packets; gateways do.

## D-014 API shape and window parameters (2026-10-31)

- Omitting both `start` and `end` selects the rolling live window `[now − duration, now)` (`duration` default 72 h), with `now` floored to `LIVE_QUANTUM` so clients share boundaries and cache entries. Giving only one bound is an error. Every response echoes the effective window and a `revision`.
- `revision` = `d{decode_version}.c{config_rev}.r{retention_rev}.m{max id in window}`. Any new row inside the window, any retention deletion, or a configuration change produces a new revision and therefore a new cache key; stale entries are never served. `config_rev` hashes channel/policy settings and reveals nothing about keys.
- (Superseded by D-041: the result cache and the retention revision are gone. `/observations` reports `generation` = `d{decode_version}.r{obs_row_version}.c{config_rev}`, and the server caches nothing.)
- (Replay cursors and the replay endpoint were removed; see D-020.)
- `/api/v1/stream` (SSE) accepts only the rolling window (fixed windows are rejected with 422 before the stream opens). Heartbeats every 15 s carry the current window bounds so clients evict aged-out evidence without new packets.
- Whole-table bounds in `/api/v1/retention` (earliest/latest observation) are operational metadata, not mesh-derived state.
- Protection: per-client token bucket (20 req/s, burst 60), max 4 concurrent streams per client, max 8 concurrent heavy computations (503 after 5 s), 20 s request deadline. Client IP from `X-Forwarded-For` only via `TRUSTED_PROXIES`.
- The huma docs UI is disabled (it loads JavaScript from a CDN); the OpenAPI document is served at `/api/openapi.yaml`/`.json` and committed as `docs/api-openapi.yaml` (contract test).

## D-015 Topology inference rules (2026-10-31)

(Since D-040/D-041 these rules live in the browser engine, `frontend/engine/src/graph.rs`; `internal/graph`, `internal/query/edges.go` and `graph.ResolveRelay` are gone. The rules themselves stand.)

Implemented in `internal/graph` (pure) and `internal/query/edges.go` (in-window evidence loading):
- **NeighborInfo** entry "A hears B" → `B → A`, reported float SNR unchanged; one sample per logical NeighborInfo packet regardless of how many gateways uplinked it. Reports whose `node_id` differs from the sender are rejected at ingest (D-008).
- **Traceroute**: each receiver appends its SNR (and itself unless endpoint), so `snr[k]` is measured at the receiver of segment *k* of `[origin, route…]`; a trailing extra SNR adds the final segment to the endpoint. Requests: forward origin = `from`. Replies: forward path `to → route → from`, return path `from → route_back → to`. Placeholder hops break the path (no edge touches or bridges them). Each segment counts once per logical traceroute across partial-route copies. No origin–destination shortcut.
- **Direct RF**: `rx.direct_rf` (decided at ingest: gateway present and not the sender, not via MQTT, LoRa transport, `hop_start == hop_limit > 0`, RSSI or SNR present) → `source → gateway`.
- **Relay hint**: relayed RF reception with RSSI/SNR. The last-byte hint is resolved by `graph.ResolveRelay` against nodes observed or referenced *in the same window*, excluding gateway and source (see D-024). Exactly one candidate → low-confidence `relay → gateway`, else no edge (counted as ambiguous/unmatched in diagnostics).
- **Confidence**: NeighborInfo/traceroute → high; direct RF → medium; relay-hint only → low and `inferred: true`. Statistics are per direction (median/min/max/last/n; RSSI only from gateway receptions).
- Verified on the demo mesh: every derived edge corresponds to a real simulated RF link; colliding relay bytes never resolve.

## D-016 Geolocation estimator (2026-10-31)

(Since D-040/D-041 the estimator runs in the browser engine, `frontend/engine/src/geo.rs`; `internal/geo` keeps only its settings.)

`internal/geo`: targets are nodes without an in-window reported position (never refining coarse public positions). Anchors: in-window positions with known precision ≥ `GEOLOCATION_MIN_PRECISION_BITS` (default 15 since D-025; was 20), not in `GEOLOCATION_EXCLUDE_NODE_IDS` (excluded nodes are neither anchors nor targets). Measurements: edges with NeighborInfo/traceroute/direct-RF evidence (relay-only links excluded). Gates: ≥ 3 anchors, ≥ 5 samples, pairwise spacing ≥ 200 m, spread ≥ 500 m, minor/major axis ≥ 0.2 (non-collinear), outlier anchors > 150 km from the median dropped.
- Uncalibrated (default): SNR-weighted centroid of anchors, `quality: very_low`, radius = max(mean anchor distance, 2 km). Honest meaning: "somewhere among these anchors".
- Calibrated (`GEOLOCATION_CALIBRATION` YAML with `default: {p0_dbm, path_loss_exponent}`): Levenberg–Marquardt on log-distance ranges from RSSI with Huber weights; uncertainty from max(observed misfit, 6 dB) shadowing propagated through the model, floor 500 m; `quality: low`. Simulation (4 anchors, 4 dB shadowing, 200 placements): mean error ≈ 2.5 km, 100 % within 2× reported radius — deliberately conservative.
- Coordinates rounded to 0.001° (~100 m) and radius to 100 m; never meter-scale. Suppressed estimates carry `estimate_note` with the reason.

## D-017 MapLibre 5 instead of 6 (2026-10-31)

MapLibre GL JS 6.x (6.14.0) breaks label rendering when deck.gl 9.4 is interleaved (`MapboxOverlay({interleaved: true})`): every symbol layer drawn after a deck layer is placed (queryRenderedFeatures reports it) but not painted. Removing the overlay restores labels, and MapLibre 5.24.0 with the same deck.gl works correctly. The frontend pins `maplibre-gl@5.24.0` (deck.gl 9.4 targets MapLibre 5). Revisit when deck.gl declares MapLibre 6 support. MapLibre 6 additionally ships its worker as a separate ES module that bundlers must emit (`setWorkerUrl`), which MapLibre 5 does not require. Found by Playwright screenshots, not by label queries — the e2e suite now saves screenshots for review (`docs/screenshots/`).

## D-018 Frontend scope choices (2026-10-31)

- Plan §4.1 listed Radix UI, uPlot and comlink workers. The UI uses native, labelled HTML controls (buttons, range/datetime inputs, `role` attributes) instead of Radix; sparklines and the traffic strip are small SVGs instead of uPlot; no Web Workers yet — client transforms are linear passes over server-bounded payloads (≤ 5 000 nodes, ≤ 20 000 edges). Add workers if M5 profiling shows main-thread hotspots. (Superseded: views are derived in a Web Worker since D-031, by a WebAssembly engine since D-040.)
- Labels: mesh layers are interleaved beneath the basemap's label layers (`beforeId: labels-start`), so place, peak and road names stay readable over nodes and links.
- While a new window loads, the previous result is shown only when it cannot leak data (same rolling window moving forward); otherwise a loading state is shown. Responses whose echoed window differs from the request are discarded. (Removed in D-058: the worker answers each request by id, so a mismatch cannot happen.)
- (Pulse animation replaced by radar pings; see D-023.)
- Map glyphs: OpenMapTiles fonts v2.0 (Noto Sans Regular/Bold, SIL OFL), downloaded at image build time and checksum-verified; one font per text stack because the static glyph server cannot combine stacks.

## D-019 MapLibre advisory GHSA-jrc7-96c5-q579 (2026-10-31)

`npm audit` reports a critical XSS sanitizer bypass in MapLibre's `DOM.sanitize()` for versions ≤ 6.4.0, fixed in 6.16.0. 6.16.0 still breaks label rendering with the interleaved deck.gl overlay (re-tested; D-017), so the frontend stays on 5.24.0 with a mitigation. In 5.24.0, `DOM.sanitize` has exactly one call site: the AttributionControl's `innerHTML`. The app disables MapLibre's attribution control and renders the required OpenMapTiles/OSM credit as static React text (e2e `attribution.spec.ts` asserts the control is absent). The vulnerable function is therefore never called, and the app uses no Popup HTML. The CSP (`script-src 'self'`) is a second layer. Upgrade to MapLibre ≥ 6.16 as soon as deck.gl supports it, or replace the deck layers with native MapLibre layers.

`govulncheck`: `golang.org/x/net` updated to v0.62.0 (two advisories, not reachable from our code). One `golang.org/x/crypto` advisory has no fix and is not reachable (`govulncheck` reports 0 affecting vulnerabilities).

## D-020 In-window playback removed (2026-10-31)

The operator descoped spec §9.2 (Play / Pause / Restart / Speed / Scrub) and the related parts of §4.3 (replay cursor `t`), §10 (`at=` parameters, `GET /api/v1/replay`, tamper-resistant pagination cursors) and §17 tests 14, 15 (replay cursor half) and 31. The intent was only that the frontend loads the past hours or days on first load; sliding the selected window back through the retention period (§9.1) stays.

Removed: the `at` parameter and `window.at` echo, `/api/v1/replay`, HMAC cursors and `API_CURSOR_SECRET`, the Redis cursor secret, and the timeline's playback controls and replay pulses. Every view is now scoped to exactly `[start, end)`. Test 14 is covered as "a window ending before a later rename shows the earlier name"; test 15 by window switching only.

## D-021 Map styling: uniform links, one line per pair, role size, last-heard colour (2026-10-31)

Operator request:
- **Links** have a fixed width per class, never by sample count: infrastructure links (both ends ROUTER or ROUTER_LATE in the window's NodeInfo) 3 px, all other links 1.25 px, including router ↔ non-router and links to nodes with no reported role. Each class is its own pair of map layers (solid and dashed) with its own switch in Layers; infrastructure links draw on top. The classes also differ in **colour**: infrastructure bright blue (76, 201, 240), other links neutral grey-blue (150, 163, 184). Colour therefore no longer encodes confidence; confidence is opacity (high solid, medium fainter) plus dashes for inferred links. Selection is shown in white, never by width.
- **One line per node pair.** Directed edges stay separate in the API and in the details panel (each direction's evidence, confidence, SNR/RSSI and time range). On the map the pair takes the better direction's confidence (shown as opacity), is dashed only if every present direction is inferred. No arrowheads; direction is shown in the details panel and hover text.
- **Marker size by role** (`identity.role` from in-window NodeInfo): ROUTER and ROUTER_LATE 8 px radius, CLIENT_BASE 6.5 px, everything else (or no role in the window) 5 px. Gateways keep their blue ring; selection is a white outline.
- **Marker colour by last heard**, as a fraction of the selected window: age = (window end − last_seen) / window length, mapped onto a reversed, clipped inferno ramp (pale yellow = heard at the window end, dark magenta = heard only near its start). The legend labels the stops in hours or days of the current window, so the scale changes with the window. This replaces the "stale" grey (not heard in the last quarter). Node list dots use the same colour.

## D-022 Toggleable map layers, names hidden by default (2026-10-31)

Operator request: the map was too dense. A **Layers** button on the map opens switches for:
- **Mesh:** infrastructure links, other links, inferred links, uncertainty circles, node names (zoom ≥ 10, 18 px, full Unicode glyph set) and animated traffic. Node names start on. deck.gl's CollisionFilterExtension hid every label in interleaved mode, so overlapping names are not de-cluttered yet.
- **Basemap groups** (`frontend/src/map/layers.ts`, ids from `web/styles/dark.json`). Borders, and land cover and parks start on. Major roads, minor roads and rail, rivers and streams, buildings, place names, peaks, road names and numbers, and water names start off. Water and the background are always drawn.

Choices are a per-viewer convenience stored in `localStorage` (`meshmap:toggles:v3`; bumped whenever defaults change, wrapped in try/catch; defaults apply when storage is unavailable). The style is patched with the saved visibility before the map is created, so hidden layers never flash.

This deviates from the spec's "mandatory labels" (§11 and the M4 gate). The labels still exist and render when switched on, and the e2e suite checks both that they are hidden by default and that place, peak, road and border labels appear once enabled.

## D-023 Live traffic as radar pings (2026-10-31)

Operator request: the moving-dot pulses were rare and easy to miss. Each RF transmission we can attribute to a node is now one expanding ring centred on the transmitter, growing until it encloses every node known to have heard that transmission directly. Each of those nodes flashes as the ring reaches it. Logic is in `frontend/src/map/pings.ts` (unit-tested).

Attribution, per live gateway reception:
- The originator always made the **first broadcast** (blue ring), keyed by logical packet + originator, so all copies of one packet share one ping.
- `direct_rf`, or hop count 0 (`hop_start − hop_limit`, now included in live events as `hops`): the gateway heard the first broadcast directly.
- Otherwise the gateway heard a **rebroadcast** (amber ring) by the last hop, resolved from the relay byte exactly as the backend does (D-024). An unresolved byte attributes nothing to any relay.
- **Traceroutes** use their recorded path instead (live events carry `path`: `route` for requests, `route_back` for replies; "" for an unrecorded hop). Chain = originator, path, then the gateway if it did not append itself. Each adjacent pair is one transmission by the first node heard directly by the second, so every relay on the route gets its own ring. Unrecorded hops break the chain without inventing receivers.
- **Hop count** (`hop_start − hop_limit`, the hops spent). The first hop always spends one. Later receivers skip spending only under Meshtastic's 0-cost rule: the receiver is ROUTER, ROUTER_LATE or CLIENT_BASE, and the last hop was another of those roles that it has favourited. So:
  - Count 0: the gateway heard the originator (matched the route in 99 of 99 traceroute copies).
  - Count 1 with a resolved relay whose role is known and **not** zero-cost-capable: that relay spent the only hop, so it was the first hop and heard the originator directly. It joins the first broadcast's ring.
  - Count 1 with a zero-cost-capable or unknown relay role: nothing is inferred. On mqtt.868.no traceroutes, 41 of 178 count-1 copies had 2–5 relays, and every one ended at a zero-cost-capable role, which is consistent with the rule.
- A gateway uplinking its own packet, or a transmission with no placeable direct receiver, shows only a brief 1.5 s soft glow, deliberately unlike a ring. It stays open for receivers for the full collection time, about 10.5 s, and a receiver arriving later grows a ring from nothing.
- Rings are drawn in screen pixels: max(distance to the farthest receiver at the current zoom, 22 px). The 22 px floor grows in with the ring. Without it, co-located receivers were invisible: the most common relay→gateway pair on mqtt.868.no, NORb → North GW, reports identical positions (0 m). Receiver flashes use the same pixel radius, so they fire when the visible ring reaches them.
- Verified against live traffic (4-minute capture: 7 of 18 drawable pings had a placeable receiver) and with an injected sequence (grow, linger, grow again, flash, fade).

Timing: a ping grows for 3 s (ease-out), lingers at full size for 5 s, then fades over 2.5 s. Uploads of one packet arrive over several seconds (measured on mqtt.868.no: median spread 3.1 s, p90 8.8 s), so a ping accepts receivers for as long as it is on the map, about 10.5 s, which covers roughly 90 % of packets. A receiver outside the ring starts a new 3 s growth from the ring's current size, with no jump, and resets the linger. Any new receiver brings a lingering or fading ring back to full strength. Once a ping has ended, late copies of that transmission do not ping again for 20 s. At most 80 pings run at once. Transmitters or receivers without a position are skipped. Pings follow the "Animated traffic" switch and are off under prefers-reduced-motion.

## D-024 Narrowing the last-hop byte (2026-10-31)

The last-hop byte has only 256 values, so collisions are expected, but only nodes within radio range of the gateway can be the last hop. `graph.ResolveRelay` (backend) and `resolveRelay` in `frontend/src/map/pings.ts` (the same rules) narrow the candidates:
1. Candidates: window nodes with that last byte, other than the originator and the gateway.
2. **Range:** drop candidates whose reported in-window position is farther from the gateway than the bound: the longest confirmed link in the window × 1.25, at least 50 km (184 km on mqtt.868.no). Unpositioned candidates stay, because they cannot be ruled out. Estimates are never used.
3. **Confirmed links:** if several remain, the single candidate with NeighborInfo, traceroute or direct-RF evidence to the gateway wins. Relay-hint evidence never counts, so inferences cannot reinforce themselves.
4. Otherwise unresolved.

Measured on 72 h of mqtt.868.no traffic:
- Ambiguous relay bytes fell from 1,292 to 116, and resolved relay samples rose from 625 to 1,799.
- Against traceroute ground truth (the route names the true last relay), 378 copies: before 87 correct, 0 wrong, 291 unresolved; after 355 correct, 0 wrong, 23 unresolved. Some confirmed links come from the same traceroutes, which favours step 3; step 2 is independent of them.

## D-025 Coarse anchors for location estimates (2026-10-31)

Operator decision: the anchor threshold `GEOLOCATION_MIN_PRECISION_BITS` drops from 20 to **15**. On mqtt.868.no only 10 of 65 positioned nodes report ≥ 20 bits; 55 report 12–16 bits, the common coarse public setting. With 20 bits there was 1 estimate; with 15 there are 7.

Anchor imprecision is now part of the uncertainty. `geo.PrecisionErrorM(bits, lat)` is the half-diagonal of the reported precision cell; firmware reports the centre of the cell. That is about 0.8 km for 15 bits at 63°N and 0 for 32 bits. The largest anchor error is added in full to the radius (worst case: every anchor shifted the same way), and the estimate's reasons say so. Estimates remain coarse: radii on live data are 5–69 km, the honest "somewhere among these anchors" of the uncalibrated method.

Every unpositioned node now carries an `estimate_note`, including "no confirmed direct links to nodes reporting a position with at least 15-bit precision". Previously, nodes without any anchor link had no explanation.

## D-026 Selection focus and a collapsible side panel (2026-10-31)

Operator request:
- **Accuracy circles** are off by default (Layers → "Accuracy circles"). The selected node always shows its circle: the estimate's uncertainty, or for a coarse reported position the precision-cell error (`precisionErrorM`, mirroring the backend's `geo.PrecisionErrorM`, drawn in neutral white instead of estimate purple).
- **Selecting a node** shows only links that involve it: all of them, bypassing the level-of-detail cap and viewport culling. Clearing the selection restores every link.
- **The side panel** (Nodes, Details, Filters, Legend) starts hidden; the map takes the full width. A top-bar button ("Nodes & details" / "Hide panel") toggles it. Selecting a node or link opens it on Details. If the selection opened it, closing the details hides it again; if the viewer opened it, it stays open.

The layer-choice storage key moved to `meshmap:toggles:v4` so the new circle default applies.

## D-027 Ping fill gradient, deselect on empty click, initial fit (2026-10-31)

- **Ping rings** have a radial fill whose opacity follows the observed signal. It is full at the transmitter; at each receiver's on-screen distance it equals that receiver's measured strength (gateway SNR mapped from −20…+10 dB to 0…1, else RSSI −130…−70 dBm); and it fades to transparent at the edge. The profile never increases outward. Receivers known only from a traceroute path or the hop-count rule carry no measurement and count as 0.5. Measurements attach only to the gateway that reported them. deck.gl circles have no radial gradients, so the fill is drawn as 16 abutting concentric bands (`ringProfile`, `RING_BANDS`).
- **Clicking empty map** clears the selection (and so hides an auto-opened side panel).
- **The map starts at "Fit to data"** once the first snapshot with positions arrives, unless the view has already moved from the configured start.

## D-028 Rebroadcasts wait for the upstream ring (2026-10-31)

A ping for a transmission by X of packet P checks whether another ping for P lists X as a receiver; X then heard P from that transmitter. If so, X's ping stays hidden until the upstream ring reaches X (the moment X flashes), then grows from nothing. This applies to the originator's first broadcast and to traceroute relays in sequence. Without upstream information (no upstream ping on the map, or X not a known receiver of it), the rebroadcast pings immediately. A waiting ping starts anyway if the upstream ping disappears or the collection time (~10.5 s) passes. Upstream information that arrives only after a rebroadcast has started cannot delay it retroactively.

## D-029 Overlays instead of layout shifts (2026-10-31)

Operator request: opening UI must not resize the map.
- The **side panel** overlays the right edge (a bottom sheet on narrow screens). While it is open, map buttons, coordinates and attribution move clear of it, and "Fit to data" plus the zoom-to-selected-node pad or offset for the covered area.
- The **time bar** overlays the bottom of the map. Collapsed, only its first row shows (live badge, presets, start/end, time zone); hover, keyboard focus or a tap slides the rest up (0.25 s; instant with reduced motion). The visible height is published as `--tl-peek` so the panel, scale bar, coordinates and attribution sit above it.
- **"Fit to data"** is an icon button in the zoom control group (top left); its accessible name is still "Fit to data".

The map canvas keeps the same size whatever opens or animates (checked in e2e).

## D-030 Caching, offline use and installation (2026-10-31)

Operator request: cache static assets and tiles, make as much as possible work offline without downloading tiles, use a (service) worker, and make the app installable on phones.
- **HTTP caching (Caddy):** `/assets/*` (content-hashed) `max-age=1y, immutable`; fonts 30 d immutable; icons 7 d; the map style 5 min plus a 1-day stale-while-revalidate. The page, `sw.js` and the manifest are `no-cache`, so a deploy is picked up on the next load. Tiles: `max-age=1d, stale-while-revalidate=7d`, with ETag/Last-Modified from the file server; the browser's HTTP cache handles the PMTiles range requests.
- **Service worker** (`frontend/sw/sw.js`, hand-written; the `meshmap-sw` Vite plugin injects the file list and a content-hash version, so every build gets a fresh cache and old ones are deleted on activation):
  - Precache: everything in the build except source maps, plus `/styles/dark.json`.
  - Pages: network first, falling back to the cached shell, so the app opens offline.
  - API GETs: network first (8 s timeout); successful responses are kept (at most 60). Offline, the last copy for the same URL is served with `x-meshmap-offline: 1`, and the app shows "Offline: showing the data last received (time)". A view never seen before returns a 503 problem response.
  - Fonts (glyph ranges): cache first, stored as used. Style: stale-while-revalidate.
  - Network only, never stored by the worker: `/tiles/*`, `/api/v1/stream`, health and metrics.
- **Installable:** `manifest.webmanifest` (standalone, dark theme, 192/512 icons plus a maskable 512 and an Apple touch icon), mobile web-app meta tags, and an "Install app" button wherever the browser offers an install prompt (Chrome/Edge/Android). On iOS: Share → Add to Home Screen.
- Service workers and installation require HTTPS in production (localhost is exempt); see operations.
- Playwright blocks service workers by default (request interception cannot see worker fetches); `e2e/pwa.spec.ts` opts in to check the manifest, icons, headers, offline reload with the same nodes, and that no tile is in any worker cache.

## D-031 Views derived in the browser (2026-10-31; partly superseded by D-038, D-040, D-041)

Operator decision: the backend should be a packet log; processing belongs in the frontend. The server-side views stay in place for now, in case the change is reverted.

(Later changes: paging is by an `(observed_at, id)` cursor, not `after` (D-038); the TypeScript ports were replaced by the WebAssembly engine (D-040); the server views, the parity test and `?derive=server` were removed (D-041); live refreshes come from the stream (D-033).)
- **New endpoint** `GET /api/v1/observations`: the decoded rows of a window, in id order, paged (`after`, `limit` ≤ 20 000). Same window validation as every view; `since`/`until` only narrow the bounds (they are clamped to the window, never widen it). Each row carries compact keys and only public decoded RF fields: header fields, radio metadata, signature status, and the port fields the views use (NodeInfo identity, position, device telemetry, NeighborInfo, traceroute). Never envelope bytes, payload bodies, public keys or MQTT topics. `generation` (decoder + configuration) tells the browser when its copy is stale. `Cache-Control: no-store`; the service worker does not store it.
- **Derivation worker** (`frontend/src/derive/`): a Web Worker holds the rows for one contiguous time range and builds snapshot, traffic and node detail with the same output shapes as the API. It ports `query`, `graph` and `geo` one to one. A rolling window only fetches rows since the last sync (with a 2-minute overlap for late commits); a fixed window that overlaps what is held fetches only the missing ends. Rows older than 8 days before the newest window are dropped, and the copy is capped at 750 000 rows. Live refreshes run every 10 s (30 s for server views).
- **IndexedDB** keeps the copy across reloads, so a reload fetches only new rows, and offline the window is built from what is held. This replaces the offline API copies for these views.
- **Geolocation settings** (enabled, minimum precision bits, excluded nodes, gates, calibration) are published in `capabilities.geolocation` so the browser applies the operator's rules. Excluded nodes stay excluded, but the inputs are public, so exclusion is a display rule, not a secret.
- **Parity:** `tests/parity.test.ts` (run with `PARITY_BASE=<url>`) derives snapshot, filtered snapshot, traffic and node details from `/observations` and compares them field by field with the server's views for the same window. To make the comparison exact, the server now reads traceroute copies in time order and sorts geolocation measurements by anchor. Both were sources of nondeterminism.
- `?derive=server` (remembered per browser) switches back to the server's views; `?derive=client` returns to the default.

## D-032 OK-to-MQTT and map reports (2026-10-31)

Operator decisions.
- **OK to MQTT** (`Data.bitfield` bit 0). Firmware withholds packets without the flag only from brokers with a public address, so they can reach us through a local broker bridged to ours. Measured on 2026-10-31: 3 of 5,218 rows lacked the flag, all a gateway's own NodeInfo.
  - A packet without the flag that a gateway other than its sender uplinked is kept and marked `not_ok_to_mqtt`. Its **NodeInfo is rejected** (`not_ok_to_mqtt_nodeinfo`), so the node is shown as present but never named. This is a slight anonymisation, not a promise: its id, traffic and any reported position remain.
  - A **gateway uplinking its own packets** is never filtered, whatever the flag: it chose to uplink.
  - No bitfield at all (firmware before 2.5) means no preference was expressed: treated as allowed.
  - Nodes with marked packets in the window carry `mqtt_opt_out` and render with a permanent red ring (not a switchable layer); the tooltip, node panel and legend explain it.
- **Map reports** (`…/2/map/`, `MAP_REPORT_APP`) are stored as packet type `mapreport` (crypto `mqtt_map_report`, signature not applicable). Only reports published by the node they describe (sender = gateway) are accepted. Their location is stored as an ordinary position, and every position consumer (latest position, position history, geolocation anchors at ≥ 15 bits) reads `position` and `mapreport` packets alike. When a node has both in the window, its latest Position packet and latest map report are compared: if their precision circles (the worst-case error for each one's precision bits) overlap, they agree and the more precise one is used (the newer on a tie); if not, the node may have moved and the newer one is used, as it is when either precision is unknown. The chosen position reports its `source`. Every report has packet id 0, so the logical key adds a 5-minute time bucket. Their names and role are stored but not used for identity: they are unauthenticated MQTT claims, like the gateway id. Map reports never animate as radio pings.
- `DecodeVersion` 2. Rows decoded before this change carry neither map reports nor the marking. The 3 unflagged rows found were all self-uplinks, which stay as they are.

## D-033 Full rows over the live stream (2026-10-31)

Operator decision. Each `delta` event's live event now also carries `row`: the same compact row `/observations` returns. Both paths build it with `ingest.NewObsRow`, and an integration test checks a streamed row equals the stored one. The summary fields stay for `?derive=server`.
- The page forwards streamed rows to the derivation worker, which merges them at once. Views are rebuilt debounced: once the stream has been quiet for 2 s, and at least every 5 s while it keeps flowing. Pings never wait for a rebuild. Views then rebuild without any request.
- A rolling window built in the browser ends just after the newest row held, or at the last sync if later (D-039). A streamed row counts as soon as it is merged, instead of at the next 10 s window step.
- The stream is opened without filters when views are built in the browser (the store needs every row); filters apply locally, to views and pings alike. Pings are built from the rows.
- Fetching `/observations` is now only a gap filler: once a minute on a heartbeat, and immediately when the stream reconnects after an interruption. Streamed rows do not advance the store's coverage mark, so anything the stream missed is fetched then. Rows that arrive before the first sync are held and merged after it.

## D-034 No ping bursts after a sleeping tab (2026-10-31)

Browsers throttle or freeze background tabs, and on resume they deliver the stream's backlog at once, which produced a burst of pings. Pings are now created only for packets handled while the page is visible and at most 10 s old by the server clock (offset from stream heartbeats; the stream sends one on connect). Rows still reach the derivation worker regardless, so views stay complete; only the animation skips them.

## D-035 Clustered node names (2026-10-31)

Operator request: names of nodes close together overlapped; markers must stay put.
- Names whose label boxes would overlap at the current zoom are grouped into a cluster (screen space, grid-bucketed). A collapsed cluster shows the most prominent node's name — routers first, then the busiest — plus "+N".
- A cluster fans out while hovered (marker or name; a 400 ms grace period lets the mouse reach the names) and while one of its nodes is selected. Names sit on the smallest ring around the cluster on which no two label boxes overlap. They keep their markers' angular order and have a leader line to their marker. Clicking a fanned-out name selects that node.
- Hovering a clustered marker shows no tooltip, since its names are already fanned out; hovering a name shows its long name.

## D-036 Per-node packet logs (2026-10-31)

Operator request: the selected node's panel shows its packets, built by the derivation worker from the window's rows (filters apply). One combined log, newest first, with an "Include relayed" toggle (off by default since 2026-11-01; it was on); up to 200 own and 200 relayed entries, 50 shown at first.
- **Own packets:** one entry per logical packet the node sent: time, type, destination, fewest hops any gateway saw, gateways, signature.
- **Relayed for others:** other nodes' packets this node passed on, from two kinds of evidence:
  - a gateway's last-hop byte resolved to it, with the same narrowing and context as links (D-022);
  - it appears in a traceroute's recorded route (`route` for requests, `route_back` for replies).

  The uplinking gateway appends itself to the route it reports. That trailing entry only received the copy and is not counted (found on real data: a CLIENT_MUTE gateway was credited with 135 relays).
- (`?derive=server`, which offered only the own log, was removed in D-041.)
- A last-hop byte equal to the uplinking gateway's own low byte is the gateway itself: it is ignored everywhere (links, this log, pings) instead of resolving to another node sharing that byte (4 of 4,245 relayed receptions on 2026-10-31).
- Limitation: a unique last-hop byte match can still name the wrong node when the true relay was not seen in the window. On 2026-10-31, one CLIENT_MUTE node (which never rebroadcasts) was credited with 2 relays this way.

## D-037 Packet routes on the map (2026-10-31)

Operator request. Selecting a packet in the log draws its routing graph and hides every link while it is shown. Clicking the row again, selecting another node or clearing the selection removes it. The map frames the route once when it is drawn.
- The graph comes from every in-window reception of the packet (rows sharing its logical key), as directed transmitter → receiver segments:
  - **Traceroute:** the recorded route, with the gateway appended unless it already recorded itself.
  - **Zero-hop reception:** sender → gateway.
  - **Resolved relay:** relay → gateway. Sender → relay too, solid only when one hop was spent by a relay whose known role cannot receive at zero cost (the same rule as the pings, D-027).
  - **Relay byte resolving to nobody:** sender → gateway.
  - Packets the sender uplinked itself, and MQTT or non-radio transports, add nothing.
- **Solid** when both nodes of a hop are known to be adjacent. **Dashed** when nodes between them are missing: an unrecorded traceroute hop, an unknown relay, or the unknown path from the sender to a relay. A solid segment wins over a dashed one for the same hop. Hovering a segment says which case it is.
- A segment whose end has no position (reported or estimated) cannot be drawn; the panel counts those. Routes need views built in the browser.

## D-038 Time-ordered paging for /observations (2026-10-31)

`/observations` paged by row id (`id > after ORDER BY id`). At scale PostgreSQL served that by walking the primary key from the oldest row: on 500 000 seeded rows over 30 days, the first page of a 168 h window discarded 390 000 out-of-window rows (84 ms), and with 6 months of retention almost the whole table would be scanned per first page. Pages are now ordered by `(observed_at, id)` with an opaque `cursor` (`next_cursor`, Unix microseconds plus id), which the existing `observed_at` index serves directly: 24 ms for the same first page and 9 ms for later ones, independent of how much older data is retained. The cursor only positions within the window; `window.Predicate` still bounds every query.

## D-039 Browser performance and structure (2026-10-31)

- **One relay resolver.** The ping animation used its own copy of relay-byte resolution, separate from the worker's, and the two had drifted. It now uses `derive/graph.ts` with the same context the links were built from (`contextFromSnapshot`). `ZERO_COST_ROLES` moved there too, so `derive/` no longer imports from `map/`. (Since D-040 the one resolver is the engine's, `frontend/engine/src/graph.rs`.)
- **One snapshot per rebuild.** A rolling window ended at the clock, so every view requested in one rebuild (snapshot, traffic, packet log, route) had a slightly different window and rebuilt the snapshot itself. The window now ends just after the newest row held (or at the last sync, at least once a minute), so the requests share one memoised snapshot.
- **Live merges append.** Each streamed batch copied and re-sorted the whole row store. Rows that belong at the end, nearly all of them, are now appended in place.
- **Batched IndexedDB writes.** Live rows were written in one transaction per batch, several a second. They are now batched (2 s quiet, 5 s at most); large fetched batches, trims, resets and coverage updates flush immediately, in order.
- **Vendor chunks.** The bundle was one 2.1 MB file, so every deploy invalidated all of it. MapLibre (1.0 MB), deck.gl (0.9 MB) and React (0.2 MB) are now separate chunks that stay cached across app deploys; the app's own code is 139 kB (46 kB compressed).

## D-040 A WebAssembly engine for the browser's hot paths (2026-10-31)

Operator request: rewrite the client's hot paths in something that compiles to WebAssembly. **Rust** (`frontend/engine`, crates serde, serde_json and wasm-bindgen, pinned): no garbage collector, a small module (617 kB, 194 kB compressed), and mature tooling. The toolchain runs in a pinned Docker image (`scripts/wasm.sh`; the web image has its own Rust stage).
- **What moved:** the row store, snapshot (nodes, links, relay resolution, location estimates, counts), traffic, node detail, packet log, packet route, and live ping attribution. The TypeScript ports were removed. Views keep their shapes (now typed by hand in `src/derive/views.ts`, D-058).
- **Rows never become JavaScript objects.** The worker stages each raw `/observations` page in the engine (staged batches let a fresh start still discard them), merges streamed rows as JSON text, and gets views back as JSON text. Those go to the page as transferred UTF-8 bytes rather than a structured clone of a large object graph. Strings are interned and packet keys stored as integers; the engine indexes relay candidates by low byte.
- **Fetching:** after a range's first page, the rest is split into four time slices fetched in parallel into one batch.
- **Persistence:** hourly gzip-compressed chunks in the API's row format (IndexedDB v2); only changed hours are rewritten. The coverage record is written after the rows it describes, so a reload never believes it holds rows it does not.
- **Pings:** the page decides which live rows to animate (visible, recent, filtered, not map reports); the worker returns their transmissions.
- **CSP:** `script-src` gains `'wasm-unsafe-eval'`, which allows WebAssembly compilation only, not JavaScript eval.
- **Relay rule:** a relay byte never resolves to a node whose role never rebroadcasts (CLIENT_MUTE). This removed the false relays credited to "stro" (D-036).
- **Tests:** Rust unit tests (including the ported ping attribution and position choice), a golden test against the retired server views, and an isolation test; the page's tests use a fake backend for the row store.

## D-041 Server-built views retired (2026-10-31)

Operator decision, after the engine matched the server views field by field (snapshot, filtered snapshot, traffic, 18 node panels on live data; then frozen as the golden fixture `frontend/engine/tests/fixtures/mesh-12h`).
- **Removed:** `/snapshot`, `/traffic`, `/nodes/{id}`, `/edges`, the query code behind them, the Go link-graph and estimator packages (the estimator's settings types stay for configuration), the Redis result cache and its flush on start, the retention revision, `?derive=server`, and the summary fields of live events. Live events are now `{id, t, row}`. The stream no longer filters; browsers filter.
- **Server tests** check the server's half of time isolation on `/observations`: exact `[start, end)` rows, millisecond boundaries, rolling eviction, fixed windows unaffected by later data, deletions by retention, and responses independent of Redis. The engine's isolation test covers derived fields.
- `meshmap bench` now times full-window `/observations` fetches.

## D-042 Lighter pings, animated links (2026-10-31)

Operator request. Rings have no outline (first drawn at 60 % opacity, then removed on request): the signal-strength fill (18 %, was 30 %) shows the reach, and the animated links' heads mark the edge. Each direct receiver's link is animated: a line grows from the transmitter toward the receiver with a bright head. The head's fraction of the way equals the ring's radius over the receiver's distance, both in screen pixels (the same test that marks the receiver reached, and interpolated in Web Mercator space so the head sits exactly on the ring's edge). Ring and line therefore arrive on the same frame. The line then stays, fainter, while the ring lingers and fades. While travelling it is drawn to stand out: a 10 px soft glow under a 3.5 px core lifted toward white, at full strength, with a haloed head; after arrival it settles to a 2 px core and fades with the ring. `e2e/pings.spec.ts` sends one live reception through a mocked stream and checks the link mid-flight and on arrival.

## D-043 Pings follow the markers drawn now (2026-10-31)

Reported by the operator: a link animation ran to a place with no node. A live check matched every animated link's end against the drawn markers for 4 minutes, and found the mismatches were estimated nodes. Their estimates are recomputed on every rebuild (every few seconds under traffic) and can shift or vanish, but a ping kept the positions its receivers had when it started. The "positioned nodes only" filter had the same flaw: estimated nodes were hidden but still used by pings and links. Now:
- The map hands pings (and links and the camera) only the positions of markers actually drawn.
- Each frame, a ping looks up its transmitter and receivers there. A moved receiver is followed, and the ring regrows if needed; one no longer drawn is dropped; a ping whose transmitter is gone ends.

After the fix, the same check found every link ending at a marker (14 link ends, 3 of them estimated nodes).

## D-044 Region and LoRa preset per node (2026-10-31)

Operator request. Node details show where a node's own packets were heard, as every (MQTT topic root, channel name) combination with reception counts. One node can be heard several ways because each gateway uplinks with its own configuration.
- **Region from the topic:** the segment after `msh`. Norway uses `msh/EU_868/NO/...` for both EU_868 and EU_N_868, so that root allows either; other roots name one region. The summary keeps only regions that every topic allows, since a node has one region and everything on a radio link shares frequency settings. If the topics contradict each other, the summary says so.
- **Preset from the channel name:** a preset is shown when the name is that preset's default channel name (LongFast, NarrowFast, LongMod, VLongSlow, …, case-insensitive). Otherwise it is unknown, with the channel named.
- **Map reports:** a node's own map report states region and preset exactly; when present it is shown first and marked as reported by the node.
- **Data:** API rows carry the topic root (`tp`, already stored per row) and map reports' region and preset (`mr`). `ObsRowVersion` (2) is now part of the generation `/observations` reports, so browsers holding rows in the old format refetch.
- On 2026-10-31, 12 busy nodes resolved to EU_N_868 (heard also on `msh/EU_N_868`, or from their map report), EU_868 or EU_N_868 (Norwegian topics only), or EU_868 / Long Fast (one node's map report).

## D-045 Second architecture and performance review (2026-10-31)

Fixed:
- **Unused indexes dropped.** `packet_log_gateway_time_idx` and `packet_log_logical_idx` served only the retired server views; every insert still maintained them. `schema.sql` drops them (idempotently) at startup. The remaining indexes each serve a named query (comments in the schema).
- **Live deltas encoded once.** Each SSE connection re-encoded every delta, so CPU grew with the number of viewers. The hub now encodes a delta once and every connection writes the same bytes (`LiveDelta` carries the pre-encoded form; its schema is unchanged).
- **Lagging clients are told.** A subscriber too slow for its 256-message buffer lost events silently, despite the comment saying otherwise. The hub now flags it, the stream sends `status {live: true, reason: "lagged"}` before the next delta, and the browser syncs immediately instead of at the next one-minute gap fill.
- **Worker view cache bounded.** It kept 24 views as JSON text; under live traffic every rebuild is a new revision, so it filled with stale multi-MB snapshots (about 180 MB at reference density). Entries of older revisions are now dropped, and the total is capped at 24 M characters.

Measured, left to the operator: serving a full 72 h window at reference density costs about 3–4 s of server time when busy (1.6 s idle). A CPU profile attributes about 44 % to decoding each row's stored metadata with `encoding/json`, 16 % to encoding the response, and 15 % to garbage collection.

## D-046 Stored row encodings (2026-10-31)

Operator decision on the D-045 item: extra data may be stored next to the original packet data, but no tables of derived data that go stale when logic changes. `packet_log` gains two columns:
- `obs_row`: the row exactly as `/observations` serves it, minus its id, which the insert assigns (`obsrow.EncodeTail`, formerly in `ingest`; `WithID` adds the id back). Written on insert.
- `obs_row_version`: the `ObsRowVersion` it was built with.

Pages select `obs_row` only when its version is current, and `decoded_metadata` only when it is not. Rows without a current encoding are built per request as before. At startup, `serve` rebuilds missing or outdated encodings in the background, newest first, 2000 rows per transaction (`FOR UPDATE SKIP LOCKED`, so replicas don't collide). A logic change only needs the `ObsRowVersion` bump it already required. `also_via` updates don't touch it, since `also_via` is not in the row.

Measured on 190k synthetic rows over 3 days (16 CPUs, idle):
- 72 h window, 170k rows in 9 sequential pages: p50 4.6 s → 2.5 s; first page 445 → 198 ms.
- Postgres spends about 0.1 s per page; the rest is scanning, transfer and HTTP.
- Encodings add 68 MB to a 285 MB table; rebuilding all of them took 20 s.

## D-047 Link animations only for unicast; links off by default (2026-10-31; animation part reverted by D-053)

Operator request. Both link layers (infrastructure and other links) now start switched off. The stored-toggles key was bumped to v5, so earlier saved choices reset once. A ping's link animation (D-042) now runs only for packets addressed to one node. Broadcasts show only the radar ring. The engine marks each transmission `unicast` when the row's destination is set and is neither 0 nor broadcast (0xffffffff).

## D-048 No pings while the page isn't painted (2026-10-31)

Reported by the operator: animations still piled up while the tab was unfocused. A covered or minimised window can stop getting animation frames while `document.hidden` stays false (Linux compositors, for example). So the hidden-tab gate (D-034) let pings in, but no frames ran to play or expire them. Rebroadcast pings waiting for their upstream ring then all started at once on the first frame back, because "upstream gone" meant "start now".
- The animation loop records each frame. Live rows get pings only when a frame arrived within the last second (`painting()`), as well as the tab being visible and the packet at most 10 s old.
- A waiting rebroadcast starts no later than its own collection timeout, so after a pause it keeps its original timing and mostly expires instead of starting late.

## D-049 Compose-only configuration and a basemap service (2026-10-31)

Operator requirements for production:
- **Behind a reverse proxy:** the proxy terminates HTTPS. Nothing changes; `web` already trusts forwarded addresses from private ranges only.
- **Configuration in the Compose stack:** the backend also reads broker and channel configuration from the `MQTT_BROKERS` and `CHANNEL_KEYS` env vars. They hold the same YAML as the files and replace them when set. Configuration errors name the variable. `check-config` redacts them like the files, and nothing logs the env. `deploy/compose.production.yaml` is a complete stack on published images, with secrets filled in from the stack's environment.
- **Basemap built by an image:** a new `basemap` service, `ghcr.io/868-no/map-basemap`, is Planetiler plus `basemap/run.sh`. It builds `basemap.pmtiles` into a volume shared with `web` when the file is missing, and rebuilds it every 30 days. The new file replaces the old one with a single rename. A failed build is retried after an hour. It is a separate service rather than part of the `web` image because a build needs Java and about 8 GB of heap, which shouldn't sit in the web server. Tested end to end with the Monaco extract.
- **Backups:** the operator won't run backups. The `pg_dump` and `pg_restore` commands stay documented, and the docs now say they are not automated.

## D-050 License: GPL-3.0-only (2026-10-31)

Operator request: publish an accurate license, compatible with Meshtastic's protobufs.
- **Why GPL-3.0:** the protobufs are GPL-3.0, and the backend's committed Go code in `internal/protocol/pb` is generated from them, so the combined work must be GPL-3.0. Before this, the repository had no top-level license, and the engine's `Cargo.toml` claimed MIT.
- **Files and metadata:** `LICENSE` is the unmodified FSF text (sha256 `3972dc97…`, identical to the copy in the submodule). `GPL-3.0-only` is declared in `Cargo.toml`, `package.json` and the images' `org.opencontainers.image.licenses` label.
- **Dependencies:** every dependency was checked:
  - Go modules: MIT, BSD and Apache-2.0. Paho is dual EPL-2.0/EDL-1.0 and is used under EDL, the BSD-style option.
  - Shipped npm packages: MIT, ISC, BSD, Apache-2.0 and 0BSD.
  - Rust crates: MIT, Apache-2.0, Unlicense and Unicode-3.0.

  All are GPL-3.0-compatible. Fonts (OFL), map data (ODbL, CC-BY, public domain) and the container base images are listed in `THIRD_PARTY_NOTICES.md`, with a Meshtastic trademark disclaimer.
- **Source link:** visitors' browsers receive the compiled frontend, which counts as distributing it, so the attribution bar links to the source. CI builds the web image with the commit hash (`SOURCE_REVISION`); a modified build can set `SOURCE_URL`. AGPL-3.0 would also have been compatible and would additionally cover the backend as a network service; GPL-3.0 matches upstream.

## D-051 Light theme, repository link, privacy policy (2026-11-01)

Operator request. This reverses the spec's dark-only design.
- **Themes:** viewers choose Follow browser (the default), Light or Dark under Layers; the choice is stored with the other layer settings.
  - `public/theme-boot.js` sets `data-theme` on `<html>` before the first paint, so there's no flash. It has to be a separate file because the CSP blocks inline scripts.
  - UI colours are CSS tokens with a light set.
  - The basemap has a light style, `web/styles/light.json`. It is generated from `dark.json` and has the same layers; a unit test enforces that. A theme change copies its paint properties onto the live map instead of calling `setStyle`, which would drop the interleaved deck.gl layers and the layer visibility.
  - Overlay colours come from a palette per theme (`map/palette.ts`). The node age ramp, route and opt-out colours stay the same in both.
  - `MAP_STYLE_LIGHT_URL` configures the light style; capabilities report it as `map.style_url_light`.
- **Repository link:** a GitHub icon in the top bar, next to the existing "Source (GPL-3.0)" link (D-050).
- **Privacy policy:** a static page, `/privacy.html`, linked from the attribution bar. It is readable without the app and linkable. `privacy.js` fills in this deployment's operator (`OPERATOR_NAME`, `OPERATOR_CONTACT`, new in capabilities), retention, geolocation and tile source. What it says about visitors was checked against the code: IPs are held only in the rate limiter's memory, dropped after 10 idle minutes, and never logged; the Caddy image keeps no access log; there are no cookies; browser storage holds settings, data and the app shell. The service worker used to cache every navigation as `/index.html`, which would have stored the policy as the offline app; precached pages are now cached under their own path.
- **Found while writing it:** "message bodies are never stored" was only true of `decoded_metadata`. `envelope_bytes` keeps the raw envelope: encrypted text messages, readable with the public default key, and plain text from gateways that uplink decrypted packets. The policy and `architecture.md` now say so; whether to keep it is the operator's decision.

## D-052 One home for app controls (2026-11-01)

Operator feedback: the GitHub link, privacy, license, Layers and the side panel toggle were scattered over the top bar, the map and its credit line, and Theme had ended up among the map layers. Now:
- **Top bar, right:** every app control sits together. Layers (map layers only), the side panel toggle (Nodes & details / Hide panel), and a menu (☰). Each has an icon and a label; phones show the icons only.
- **Menu:** Theme (Auto, Light, Dark; Auto follows the browser), Install app when the browser offers it, and About links: source code on GitHub (at the built commit), license (GNU GPL v3) and privacy policy. It also shows the version.
- **Popovers:** Layers and the menu drop from the top bar over the map and the side panel. Only one is open at a time, and Escape or a click elsewhere closes it.
- **Map:** keeps only map controls (zoom, fit, scale). Its credit line is back to the required OpenMapTiles and OpenStreetMap credits.

## D-053 Link animations for all traffic again (2026-11-01)

Operator request. This reverses the unicast-only part of D-047: every ping again animates a line to each placed direct receiver, broadcast or not, as in D-042. The engine's `unicast` flag on transmissions was removed with it. The link layers still start switched off.

## D-054 Uplink and downlink glyphs in node markers (2026-11-01)

Operator request, after traceroutes from JimCKF to Oftenåsen kept showing a roughly 75 km first hop from Bringebærpai to tms4_c0ae or tms_base, and none of JimCKF's packets were ever uplinked from the north. The TMS operator confirmed MQTT downlink was enabled on both gateways. They took the request from the broker and transmitted it in the north. Downlinked packets carry `via_mqtt`, which gateways never uplink, so the flag never reaches us.
- **Uplink (↑):** the node uplinked a reception in the window (`is_gateway`).
- **Downlink (↓):** traceroutes record the SNR each hop received at, and a packet taken from MQTT has no radio reception, so it reads exactly 0 dB. Genuine readings round to 0 dB too: 1–11% of a node's traceroutes in seven days of data (Gråkallen 24 of 787, Bringebærpai 5 of 448). The three downlinking TMS gateways were at 52–79%. A node is flagged when at least 3 distinct in-window traceroutes reached it at exactly 0 dB, making up at least 25% of those recording an SNR at it. Being a gateway is not required: a node can downlink without uplinking. The engine reports the evidence as `mqtt_downlink {zero_snr, traceroutes}`, shown in the node panel.
- **Both (↕):** both apply.
- **Drawing:** the glyph is a tinted arrow icon centred in the marker: dark on light fills, light on dark ones, and the ring's colour on hollow estimate markers. The icons are drawn once onto a canvas atlas. Font arrows varied too much between systems, and deck.gl fetches icon URLs, which the CSP's `connect-src 'self'` rejects for `data:` URLs.
- **Not changed:** the 0 dB hops still count as radio links in the links layer (changed by D-055).

## D-055 MQTT links in their own layer (2026-11-01)

Operator request: traceroute hops that went over MQTT are flagged, drawn in a distinct style in a separate layer, and kept out of the two radio link layers.
- **Which hops:** a traceroute hop recorded at exactly 0 dB into a node flagged as probably downlinking (D-054). An earlier version also flagged pairs where a quarter of the hop's readings were 0 dB. In three days of data that picked up seven one-off pairs, each a single genuine 0 dB reading (for example OeK6 → Marsteinsvola). Tying the rule to the downlinking node keeps those stray readings radio, and keeps the links consistent with the ↓ glyphs.
- **Engine:** `graph::split_mqtt` moves those samples out before relay resolution. MQTT edges (`mqtt: true`) carry no SNR or RSSI statistics and say why in `reason`. They are appended after the radio edges and excluded from position estimates, relay-byte resolution and the link count. A pair can have both a radio edge and an MQTT edge; on 2026-11-01, tms_base–Marsteinsvola had 74 radio samples and 3 MQTT hops.
- **Rules:** the CLIENT_MUTE relay rule and this split are now `views::Rules`. The golden test switches both off (`silent_rule`, `mqtt_links`) to compare with the retired server views.
- **Map:** a new switch, "MQTT links (dotted)", off by default like the radio link layers. The lines are dotted green beneath the radio links, one per node pair, in both themes. The link panel is titled "MQTT link" and explains it is not radio. The node panel's link list tags these links MQTT, and a selection remembers which kind of link was picked.

## D-056 Monthly partitions and one row per reception (2026-11-01)

From the third review. Retention deleted expired rows in chunks and then vacuumed the whole table, and nothing in the schema stopped a batch from being stored twice when its commit succeeded but the writer saw an error and retried.
- **Partitions:** `packet_log` is range-partitioned by calendar month (UTC) of `observed_at`, one partition per month (`packet_log_pYYYYMM`). It is still the only application table; partitions are not counted as tables. Retention drops months that end before the cutoff, then deletes the remaining expired rows in the month the cutoff falls in and vacuums only that partition. `storage.EnsurePartitions` creates partitions: at startup (last month to two months ahead), on each maintenance run, and from `InsertBatch` whenever a batch reaches a month this process has not seen (so imports, benchmarks and tests with old timestamps just work).
- **Ids:** PostgreSQL 16 has no identity columns on partitioned tables, so `id` takes its default from the sequence `packet_log_id_seq`. The primary key is `(id, observed_at)`, since every unique index must include the partition key.
- **One row per reception:** a unique index on `(observation_key, observed_at)` replaces the plain dedupe index. Inserts COPY into a per-connection staging table, then `INSERT … ON CONFLICT DO NOTHING RETURNING id`; rows already present return their existing ids, so a retried batch gets the ids of its first attempt. This also removed the `max(id)` read before every batch.
- **Migration:** startup converts a schema-1 table in one transaction under the schema lock. It renames the old table, creates the partitioned one, copies every row with its id (keeping the first of any duplicate receptions), moves the sequence past them and drops the old table. The dev database's 17,160 rows took under a second. The schema version is now `meshmap-schema:2`.
- **BRIN index dropped:** it was never scanned (`pg_stat_user_indexes`), and dropping partitions replaces the range pruning it was meant for.
- `decoded_metadata`, `envelope_bytes` and `obs_row` stay. They hold the same packet three ways on purpose: the envelope re-decodes after decoder changes, the metadata rebuilds `obs_row` after logic changes (D-046) and feeds identities and provenance, and `obs_row` is what pages serve.

## D-057 Streamed /observations pages (2026-11-01)

The handler built each page in memory as a list of pre-encoded rows, and huma then validated and compacted every row again while encoding the response. On live data, about 85 % of a page's server time went there.
- Rows are now written from the database cursor straight to the response in 64 KiB chunks (`query.Page`). The JSON document is the same, and so is the declared schema (`ObservationsBody` on the operation). The query starts before anything is written, so errors up to the first row still get a proper status. A failure mid-page aborts the connection, and the browser sees a truncated body, never a well-formed partial page.
- Rows whose `obs_row` is current are read as `id`, `observed_at` and that encoding only. The other columns come back only for rows that still need rebuilding.
- Measured on the dev stack (one 7-day page, 17,162 rows, 7.3 MB, about 1 MB with zstd): time to first byte went from about 170 ms to about 5 ms, and the whole response takes about 90 ms through Caddy with zstd.

## D-058 Browser memory, cadence and structure (2026-11-01)

From the third review:
- **Live rebuild cadence scales with window length.** Rebuild notices from streamed rows wait for a 2 s pause (5 s at most) for rolling windows up to 6 h, a 10 s pause (15 s at most) from 24 h, and scale linearly in between. Fixed windows use 2 s / 5 s. Pings are never delayed.
- **No dead live views in memory.** Every live rebuild is a new React Query key. Live-window queries now use `gcTime` 0 instead of the default 5 minutes, which kept dozens of parsed views. The previous view stays as placeholder until the new one lands. Fixed windows keep 5 minutes, where revisiting a node is a real cache hit.
- **Incremental IndexedDB persistence (store version 3).** Closed or back-filled hours are one gzip chunk each, as before. The open hour gets append-only deltas under `[hour, seq]` in a `deltas` store: rows since the last flush, with a 10-minute overlap. They are compacted into the hour's chunk when the hour closes, after 60 deltas, or on the next load. Version 2 chunks and coverage are kept on upgrade.
- **No HTTP emulation in the derivation worker** (follows D-031/D-041). Worker failures are typed (`not_found`, `bad_request`, `unavailable`, `upstream`, `internal`) instead of fake 400/404/503 statuses. A view's `meta` holds only `window` and `data_until` (the newest instant the browser's copy covers, shown in the offline banner). The stale-window guard was removed, since responses are matched to requests by id. View types live in `src/derive/views.ts` (`SnapshotView`, `TrafficView`, `NodeView`, `ViewMeta`).
- **Mesh layer data is memoised.** Each deck.gl layer's data array is kept while its inputs are unchanged. Selection, search and theme changes only recolour, through `updateTriggers`. The icon mapping is a module constant. The cursor coordinate readout bypasses React state, so mouse moves no longer re-render the map component.
- The live-stream wiring moved from `App.tsx` into `useLiveStream` (`src/state/live.ts`). The packet log and the selected-link lookup are memoised.

## D-059 API limits and shutdown (2026-11-01)

From the third review:
- **Limits are configuration** (`API_RATE_PER_SECOND`, `API_RATE_BURST`, `API_REQUEST_TIMEOUT`, `API_STREAMS_PER_CLIENT`, `API_STREAMS_TOTAL`, `API_READS_PER_CLIENT`, `API_READ_SLOTS`; defaults 20/s, 60, 20 s, 4, 2000, 4, 8). A client is an IPv4 address or an IPv6 /64, since one subscriber line usually holds a whole /64. Each client may run at most `API_READS_PER_CLIENT` `/observations` reads at once. Its extra reads wait up to 5 s, then get 429, so one client cannot take every read slot (the browser runs four in parallel). Live streams are capped overall as well as per client.
- **Shutdown is bounded.** The batch writer retried a failing insert forever, so a shutdown during a database outage lasted until Docker killed the process. After shutdown begins, it now retries for at most 10 s (`DrainTimeout`), then records the rows as a `shutdown_db_unavailable` gap and counts them as dropped. MQTT input stops first, then open live streams are closed, so HTTP shutdown no longer waits its full 10 s for SSE clients.
- **No processing timeout.** It was checked after `Process` had finished, then threw a valid result away. `Process` is bounded by its key-attempt budget.
- **Row format package.** `ObsRow`, its encoding (`EncodeTail`, `WithID`) and `Version` moved from `ingest` to `internal/obsrow`, which storage, query, API and ingest import. Type names keep the `Obs` prefix because they name the OpenAPI schemas.

## D-060 Engine structure and a second golden (2026-11-01)

From the third review:
- **Modules:** the engine's views moved from one 1,050-line `views.rs` into `frontend/engine/src/views/` (filters, node, downlinks, edges, snapshot, estimate, traffic, detail), re-exported from `views` so paths are unchanged.
- **Shared work:** one snapshot rebuild computes the traceroute hop samples once, for both downlink detection (D-054) and links (D-055). The views of one rebuild share the filtered window's rows (cached as indices into the store, by window, filters and store version). The store keeps its newest id up to date instead of scanning the window, and relay resolution computes each node pair's distance once. Together these save about 4 % of a rebuild, which `build_snapshot` dominates.
- **Second golden:** `tests/fixtures/mesh-12h/engine.json` locks the engine's own output with default options and engine-only fields, for every view kind: snapshot, traffic, a filtered snapshot, 10 node panels, 4 packet logs and 4 packet routes. It includes MQTT edges and downlink flags. The first golden (`expected.json`) still compares against the retired server views with the newer rules switched off. Re-record with `UPDATE_GOLDEN=1 scripts/wasm.sh test` only after an intended behaviour change.

## D-061 Norway's regions as a map layer (2026-11-01)

Operator request: a layer that splits Norway into its named regions (landsdeler): Nord-Norge, Trøndelag, Vestlandet, Østlandet and Sørlandet.
- **Which counties:** Nord-Norge is Nordland, Troms and Finnmark; Vestlandet is Rogaland, Vestland and Møre og Romsdal; Østlandet is Oslo, Akershus, Østfold, Buskerud, Vestfold, Telemark and Innlandet; Sørlandet is Agder. This is the usual division. Telemark is sometimes counted as Sørlandet and Rogaland as Sørlandet or Vestlandet; changing it is one line in `scripts/regions.js`.
- **Data:** Kartverket's 2024 county boundaries (CC BY 4.0), clipped to the coastline and simplified by github.com/robhop/fylker-og-kommuner (pinned commit). `scripts/regions.sh` dissolves them into regions with mapshaper (pinned) and writes `frontend/src/assets/regions.geojson` (98 kB). Islands under 2 km² are dropped. The file is a hashed build asset, so the service worker precaches it, but the page only fetches it once the layer is switched on.
- **Drawing:** a faint tint and an outline per region, beneath everything else and under the basemap's labels. Names sit at hand-picked inland points away from the busiest node clusters (a unit test checks each falls inside its own region), scale with zoom and give way to node names from zoom 9. The layer is not pickable, so it never takes a click or hover from the mesh.
- **Switch:** "Regions (landsdeler)" under Map in the layers panel, off by default. "© Kartverket" joins the attribution while it is on.

