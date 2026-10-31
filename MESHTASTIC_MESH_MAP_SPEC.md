# Meshtastic MQTT Mesh Observatory

**Implementation specification for Claude Code**  
**Status:** Implemented; this revision describes the current implementation  
**Version:** 1.1 — 2026-10-31 (1.0 — 2026-10-31)  
**Deliverable:** Working, documented, tested Docker Compose application; not a mock-up.

> **Revision note (1.1, 2026-10-31).** Updated to match the implementation. The rationale for each change is recorded in `docs/decisions.md` (D-001…D-041). Main areas changed: in-window playback removed (sliding windows and live mode remain; §4.3, §9, §12, §15–17); basemap labels and most layers switchable and hidden by default (§10.1); map rendering — one line per node pair, infrastructure vs other links, node size by role and colour by last-heard age (§7.3, §10.2–10.3); live traffic as radar pings (§7.3); narrowed last-hop resolution (§7.1 D); coarse anchors with precision error for location estimates (§8); overlay UI layout (§10.1, §15); caching, offline use and installation (§10.4); result cache flushed on every deploy (§4.3, §5); Go backend (§13). Processing split (D-031, D-033, D-040, D-041): the backend is the packet log. It serves window-scoped decoded observations and streams each new one as it is stored; the browser derives every view in a WebAssembly engine in a Web Worker. The server-built views were retired.

## 0. Instructions to the implementation agent

Build the complete product described below. Treat **MUST** as mandatory, **SHOULD** as the preferred behavior, and **MAY** as optional. Do not silently relax any MUST requirement. Where the protocol makes a request impossible to satisfy reliably, implement the conservative behavior specified here, expose its limitations in the UI, and document the reason.

Work incrementally, with runnable code and tests at every milestone. Prefer an operational end-to-end vertical slice over isolated unfinished components. Make reasonable implementation decisions without interrupting for questions. Maintain an implementation checklist and record deviations in `docs/decisions.md`. Do not invent missing radio metadata, positions, routes, or packet authenticity.

## 1. Product objective

Create an interactive web application for observing and analyzing Meshtastic mesh networks using **only traffic ingested from one or more MQTT brokers**. It must reconstruct node state, observed RF links, inferred topology, traffic, and historical evolution from retained packets. Users must be able to open it and immediately inspect the previous three days, then slide the selected time window backwards throughout the retention period.

The primary product is a geographical, **permanently dark** map with informative overlays and restrained animation. The project is intended for a network that may contain many nodes and MQTT gateway duplicates, including Norwegian deployments, but must not hard-code one region or community.

### Product invariants

1. **Only MQTT is an input to live mesh data.** No Meshtastic device API, serial connection, node polling, APRS API, other mesh feed, or third-party network-topology service is required or used.
2. **Only one application-owned SQL table is permitted: `packet_log`.** It is an append-oriented record of accepted packet observations. No separate node, link, position, identity, snapshot, settings, or migration-history table. SQL indexes on `packet_log` are allowed. Redis or an equivalent *ephemeral*, rebuildable cache is allowed.
3. **Every mesh-derived output is strictly scoped to the selected half-open interval `[start, end)`.** No node names, last known positions, topology, historic metadata, counters, charts, animation, heatmaps, or links derived from records outside it may leak into the response or display.
4. **Do not persist or display packets that could not be decoded/decrypted as required.** Reject malformed content, failed authenticated decryption, and cryptographically verifiable bad signatures. Never represent plausible AES-CTR plaintext as cryptographically authenticated.
5. **No imaginary edges or precise position guesses.** Topology and coordinates must indicate their provenance, confidence, and uncertainty.
6. **The frontend never loads the full packet log.** It loads the decoded observations of the selected window (bounded by the 7-day maximum, paged, incrementally refreshed) plus live deltas, and derives every view itself (D-031). Raw envelopes, payload bodies and keys never leave the server.
7. `docker compose up -d --build` should start the entire application after environment configuration, without mandatory external proprietary services. External MQTT brokers are the intended sources. Basemap dependencies are specified separately below.

## 2. Scope

### Required

- Concurrent MQTT connections to multiple configurable brokers and subscription patterns.
- Meshtastic protobuf `ServiceEnvelope` decoding; channel-key decryption for supported channel encryption modes; optional acceptance of already-decoded protobuf packets that genuinely contain a valid `Data` payload.
- Proper verification of XEdDSA-signed packets when possible, with conservative behavior for unknown keys and known protocol exceptions.
- Discovery of nodes, identities, reported positions, telemetry, neighbor reports, traceroutes, and gateway observations.
- RF link graph with directional signal quality, evidence types, sample counts, ages, and confidence.
- Conservative approximate location estimates for otherwise unpositioned nodes using *genuine direct-link measurements* from multiple geographically known anchors.
- Live updating and historical sliding windows, selectable start and end, presets from 1 hour to 7 days, default 3 days. There is no in-window playback (play/pause/scrub).
- Retention and daily scheduled deletion, six calendar months by default.
- GPU-assisted map rendering, animated radar-ping traffic indicators, a time bar with traffic strip, node and edge details, filters, switchable map layers, and legend.
- An installable, offline-capable web app (PWA) that opens without a connection using the last data received; map tiles are never stored for offline use.
- Complete Docker Compose stack, automated tests, generated demo fixtures, operational documentation.

### Explicit non-goals for v1

- Transmitting to Meshtastic, issuing traceroute commands, changing device settings, or controlling hardware.
- Decrypting PKI-encrypted direct messages merely with a channel PSK. This is cryptographically impossible; unless an intentionally supported, separately configured recipient private key is available in a future revision, discard them.
- Predicting the physical route of arbitrary ordinary packets or connecting sender to final recipient with a supposedly confirmed RF link.
- Inferring a trustworthy meter-scale location from RSSI/SNR alone.
- Publicly displaying plaintext private conversations or silently exporting individual messages.
- User accounts and complex RBAC in the first release; provide reverse-proxy-friendly deployment and a simple optional access-control mechanism.

## 3. Protocol correctness and threat model

### 3.1 Message input and identity

- Subscribe to configurable Meshtastic protobuf paths such as `msh/REGION/2/e/CHANNELNAME/USERID`, including configurable root and legacy `/2/c/` matching where required. Parse the payload as a protobuf `ServiceEnvelope` containing `MeshPacket`, `channel_id`, and `gateway_id`.
- Do **not** assume `gateway_id`, the MQTT topic, or the node ID is authenticated merely because MQTT carried it. MQTT account authentication authenticates access to the broker, not each underlying radio sender.
- Preserve the source broker, topic, gateway ID, originator node number, message ID, packet timestamps if present, receiver radio metadata when present, hop metadata, and decoder/schema version.
- Respect packet-size bounds, valid protobuf wire formats, packet fields, and supported port types. A malformed protobuf must never terminate the subscriber.
- Support standard data types: `NODEINFO_APP`, `POSITION_APP`, `TELEMETRY_APP`, `NEIGHBORINFO_APP`, `TRACEROUTE_APP`, text metadata, routing/ACK metadata, and unknown-but-well-formed port types as a counted type `other`. Invalid or unrecognized *application payloads* are not silently interpreted as valid known types.
- Do not treat JSON uplinks as an additional independent observation when the corresponding protobuf uplink exists. Protobuf is the canonical v1 input; JSON compatibility may be added later behind a separate explicit setting and clearly reduced authenticity/metadata guarantees.
- MQTT `MapReport` messages (`…/2/map/`) are an explicitly named plaintext source (`mapreport`), accepted only from the node they describe; their location counts as a reported position under the same time-window rules (D-032).
- Packets sent without the OK-to-MQTT flag and uplinked by another gateway are kept but marked; their NodeInfo is rejected, so such nodes stay unnamed and render with a red ring. A gateway's own uplinks are exempt (D-032).

### 3.2 Encryption and decoding

A channel is configured by its **channel name and pre-shared key (PSK)**, not an asymmetric key pair. Support base64-encoded PSKs (including Meshtastic's one-byte default-key shorthand), and optionally hex; never log secrets. Map channel configurations by broker/topic root, channel name, and key, while allowing multiple candidates for collision/rotation scenarios.

- Support AES-CTR channel encryption with the Meshtastic-defined nonce and key expansion; use upstream test vectors and implementation source, not improvised cryptography.
- Support the opt-in AES-CCM **channel AEAD** format introduced in firmware 2.8.1. Configure the channel's AEAD mode explicitly or through a documented, safe negotiation rule. Verify its authentication tag before accepting data; CTR and CCM are not interchangeable.
- Handle already-decrypted `MeshPacket.decoded` payloads only after full schema validation. A pre-populated `xeddsa_signed`/verification flag obtained from MQTT must **never** be trusted by itself.
- For AES-CTR, validate successful protobuf parsing, expected structure and payload semantics; recognize that CTR has no authentication tag and successful decoding does *not* prove integrity or correct sender identity.
- Channel hash is only a weak one-byte key-selection hint, not an authentication mechanism. Try only relevant configured keys, with a strict attempt budget.
- Discard packets for which decryption fails, authenticated decryption fails, no configured key is suitable, required decoded content is invalid, or the packet is PKI-only encrypted without an authorized way to decode it. Do not insert them in `packet_log` or show them in the map.
- Support key rotation via configuration changes and restarts; never put raw key material in the API, browser bundle, logs, database record, or snapshots.
- Use maintained crypto libraries; pin Meshtastic protobuf versions and add upgrade compatibility tests.

### 3.3 Packet signatures and node public keys

Meshtastic 2.8 introduced XEdDSA signing for eligible broadcasts. Implement actual payload signature verification using Meshtastic's firmware-compatible message construction and node public keys (typically learned from valid NodeInfo packets). Do not substitute generic Ed25519 verification or a trust flag. Follow the current upstream verification/first-contact rules and test fixtures.

- If a packet carries a structurally valid signature and the sender has a known authoritative public key, **reject it if verification fails**; do not persist it, count it as accepted traffic, or use it for graph/position inference.
- Reject malformed nonempty signatures (including invalid lengths) for packet types on which the signature format applies.
- For a first-contact signed NodeInfo, verify a self-consistent public key, signature, and node-number binding before promoting it to a known signer; never bootstrap an identity merely from an arbitrary unverified claimed key.
- If a signature exists but the public key is unknown and cannot be established securely, mark verification `unverifiable` and do not claim authentication. A configurable `strict` option may reject such packets; default should prioritize useful network visibility without pretending they are verified.
- Unsigned traffic is not automatically rejected: older firmware and packets too large to sign exist. Mark it `unsigned` or `not-applicable`. Do not allow unsigned NodeInfo to silently overwrite a known, trusted signing identity with a conflicting key; surface a key conflict in diagnostic logging.
- **Traceroute exception:** intermediary nodes can rewrite traceroute payloads, which prevents ordinary end-to-end signature verification after forwarding. Mirror the protocol's documented verification exemption: never claim a mutated traceroute signature was verified, never treat this exemption as proof of tampering, and derive links only from its valid structural data. Document the exception.
- Trust on first use (TOFU) is a limitation, not a public CA. Store the accepted public-key announcements as packet-log rows, keep the current retained authoritative binding in an ephemeral index in the ingest process, and rebuild it from the retained log at startup, periodically and after retention deletions. No second durable identity table. After identity announcements age out, historic trust cannot be guaranteed; document this.
- Record and expose per-packet **verification status** (`verified`, `unsigned`, `unverifiable`, `not-applicable`), never a blanket “secure” designation just because a channel key decrypted.

### 3.4 Input hardening

- MQTT connection TLS, credentials, distinct broker IDs, and optional CA certificates; all secrets supplied by environment variables or mounted secrets.
- Reconnect with exponential backoff/jitter; clean restarts, subscription recovery, bounded queues, database retry, backpressure, readiness checks, and graceful shutdown.
- Subscriber uses read-only subscriptions and does not publish to radio topics.
- Strict decoding limits: payload size, nesting, string lengths, number of neighbors/hops, valid latitude/longitude, timestamps, per-message processing time, and packet/key attempt budgets.
- Reject stale MQTT retained messages that cannot be attributed to an actual new RF observation; retained broker messages must not manufacture current mesh activity. Make retained handling configurable and default to ignoring retained uplink observations.
- Log failures with categories and counts (not packet text or PSKs), with metrics available to operators, not as time-unbounded information inside the public historical map.

## 4. Event time, deduplication, and window isolation

### 4.1 Authoritative event time

Use an immutable server-side `observed_at` timestamp when the MQTT event is accepted, measured in UTC, as the **authoritative filter timestamp**. Keep `rx_time` and payload-generated timestamps as nullable auxiliary fields and never automatically assume they are accurate. This prevents forged, drifting, missing or gateway-dependent timestamps from moving events across historical boundaries.

Consequences: the application can show what **its ingestion service observed**, not packets from before the service was started or periods when it was disconnected. MQTT is not a general-purpose historical archive. Clearly label coverage gaps and ingest start time where supported by in-window records. For the same RF packet observed at multiple gateways, each gateway's received observation has its own `observed_at` and quality information.

### 4.2 Deduplication

- Identify a **logical RF packet** by a stable fingerprint of meaningful immutable packet data, not solely a 32-bit packet ID. Include sender, message ID, destination/channel, and canonical payload bytes/hash; account for relays rewriting mutable headers.
- Represent **gateway reception/observation** separately within the same `packet_log` table: different gateways' receptions of the same logical packet are useful RF measurements and MUST NOT be globally discarded.
- Suppress duplicate delivery of the **same gateway observation**, including broker bridges and MQTT QoS retries, using a bounded fingerprint/time rule with a unique database-supported dedupe key where feasible. Do not drop genuine repeat receptions with distinct receive metadata and times.
- Store both `logical_packet_key` and `observation_key`; report packet counts and reception counts separately, and do not inflate traffic charts when several gateways hear one packet.
- Normalize endianness, node ID formats, signed/unsigned integer encodings, and field presence before computing identifiers. Document collision handling and timestamp tolerance.

### 4.3 Exact time semantics

- API interval is always `[start, end)` and evaluated in UTC. **Every** SQL query, cache key, aggregation, edge evidence, inferred position, and live event must use this predicate. No `last known` join to a record before `start`, even for names or coordinates.
- Nodes shown in a window must have at least one accepted observation or direct mention in evidence **within** that window. For nodes only mentioned by in-window neighbor/traceroute reports, render them as “referenced, not directly observed” and do not inherit outside-of-window details.
- A node's display name, role, hardware model, and location come from the **latest applicable in-window announcement**, not the latest known announcement globally. Without one, show its ID and `position unknown`.
- An inferred edge needs in-window evidence and must disappear when its evidence exits the window. An inferred location also needs in-window anchors, anchor positions and RF observations, or it must disappear.
- **No leakage past the window end:** a window ending at `end` shows only state derived from observations before `end`. A rename, position or link observed at or after `end` must not appear, even if it is already stored; a fixed historic window is unaffected by later ingestion.
- Cache results only by fully qualified boundaries plus decoder/config/data-generation revision; never reuse unscoped global node-state caches as a response. Because cache keys do not encode code versions, the backend flushes all cached results at startup (every deploy). Internal cached keys/identities may be used for *ingestion verification only*, never to fill a historical view outside its interval.
- Invalid ranges are rejected with a useful error, not silently expanded to include older data. Range requests beyond retention are constrained in the UI and rejected by the backend rather than returning secretly out-of-range data.

## 5. Database: one packet-log table

Use PostgreSQL 16+ (or another current supported version), with exactly **one application-created persistent table**, `packet_log`. Schema may be refined, but cover these concepts:

```sql
CREATE TABLE packet_log (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    observed_at         TIMESTAMPTZ NOT NULL,
    broker_id           TEXT NOT NULL,
    mqtt_topic          TEXT NOT NULL,
    gateway_node_id     BIGINT,
    source_node_id      BIGINT NOT NULL,
    destination_node_id BIGINT,
    packet_id           BIGINT,
    channel_name        TEXT,
    portnum             INTEGER,
    packet_type         TEXT NOT NULL,
    logical_packet_key  BYTEA NOT NULL,
    observation_key     BYTEA NOT NULL,
    rx_time             TIMESTAMPTZ,
    rx_snr              REAL,
    rx_rssi             INTEGER,
    hop_start           SMALLINT,
    hop_limit           SMALLINT,
    relay_hint          INTEGER,
    transport_kind      TEXT,
    signature_status    TEXT NOT NULL,
    decode_version      INTEGER NOT NULL,
    envelope_bytes      BYTEA NOT NULL,
    decoded_metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX packet_log_time_idx ON packet_log(observed_at DESC, id DESC);
CREATE INDEX packet_log_source_time_idx ON packet_log(source_node_id, observed_at DESC);
CREATE INDEX packet_log_gateway_time_idx ON packet_log(gateway_node_id, observed_at DESC);
CREATE INDEX packet_log_logical_idx ON packet_log(logical_packet_key, observed_at DESC);
CREATE INDEX packet_log_observation_idx ON packet_log(observation_key, observed_at DESC);
```

Use a database-supported dedupe constraint only if it correctly models the bounded reception semantics; do not make a global `observation_key` unique in a way that discards legitimate reception at a later time. A BRIN time index may be beneficial for very large append-oriented tables. Keep normal indexes modest; benchmark them. If an index/layout change is needed, document it and add it through idempotent startup SQL or version-aware schema inspection **without a separate migration table**.

`decoded_metadata` stores the **minimal sanitized typed data** needed for reconstruction (NodeInfo, position, telemetry, neighbor entries, traceroute paths/SNR, reception provenance, etc.), not a sprawling materialized node or edge record. Keep raw `envelope_bytes` for reproducible re-decoding and audits, but never return it to the normal frontend. Do not store decrypted text bodies or private DMs by default; preserve only relevant message type, size, and routing metadata. Add a documented opt-in for message-content retention only if future requirements justify it.

All rows represent accepted packet observations. Invalid/decrypt-failed/signature-failed input is **not stored**, even in a quarantine table. Log only aggregate rejection diagnostics in process metrics. No second persistent data store, ORM migrations table, Redis persistence file, or materialized node/edge tables.

### Query strategy

- Restrict by `observed_at >= :start AND observed_at < :end` at the SQL level before deriving any graph or state.
- The server reads only the requested window's rows (never the entire six-month log); grouped counts, latest-in-window announcements, positions, links and time buckets are derived from those rows in the browser.
- Order and bound per-view row reads by `(observed_at, id)`; do not use large `OFFSET` scans.
- Views are derived in the browser (D-041), so the server keeps no result cache. Redis holds only ephemeral, rebuildable state: dedupe keys, live pub/sub and maintenance status.
- Limit RAM via bounded queues, batch processing, compressed output where beneficial, and streaming reads. Avoid full in-process table scans and ORM object graphs.

## 6. Retention and scheduled maintenance

- Default retention: **six calendar months** from current UTC time (`RETENTION_MONTHS=6`), configurable.
- A dedicated `maintenance` Compose service or scheduled job runs daily and on startup if overdue. Deletion must be chunked/batched with short transactions to avoid prolonged table locks or exploding write amplification. Use a Postgres advisory lock to prevent simultaneous cleanup.
- Delete only rows with `observed_at < now() - interval '6 months'` (or the configured equivalent). Treat exactly-on-boundary rows consistently.
- Vacuum/analyze and index maintenance as appropriate; do not schedule aggressive blocking VACUUM FULL.
- Evict or invalidate affected caches immediately. Update API retention boundaries as rows disappear. Expose configured oldest allowable selection bound and actual earliest retained event, keeping their meanings distinct.
- Health output reports last successful cleanup time, deleted row count, and storage size; operational metrics are not packet history and need not be included in the user-facing time-filtered map.
- If a user is viewing a historical window that expires during an open session, notify them, clamp/reject as appropriate, and never continue showing expired cached data.

## 7. Mesh topology and evidence model

Build a **time-bounded, weighted, directed graph**; the map draws one line per node pair while keeping each direction's evidence separate. The graph is a derived result, never a second database table. Every edge or segment carries source evidence, time, confidence, RF metrics and direction.

### 7.1 Evidence priority

**A. Neighbor Info (high confidence):** each valid entry saying node A directly hears B is directed evidence `B -> A` with the actual reported floating-point SNR in dB where available; do **not** apply traceroute’s divide-by-four scale to this field. Do not infer a symmetrical reverse link from this alone. Parse sender and neighbor IDs, report freshness, and all supported fields; use only entries from selected in-window packets. A single report is an observation, not proof of a permanent connection.

**B. Traceroute (high confidence for the captured route):** parse `RouteDiscovery` forward and return paths, including `snr_towards` / `snr_back` values **scaled by 4**. Derive only actual adjacent path segments in the correct order and direction. Do not conflate forward and reverse paths; correlate requests and replies by protocol identifiers when available and only within the selected interval. A traceroute is a sample of a particular path, not a universal routing table. Detect malformed path lengths, loops and impossible hop structures; omit invalid segments and record diagnostic counters.

**C. Direct receiver observations (medium confidence):** when gateway G was demonstrably the RF receiver of an unrelayed packet originating at A, infer `A -> G`, with the gateway's reception RSSI/SNR. Only use this when hop/transport metadata actually proves direct RF reception; do not mistake an MQTT-forwarded packet for a radio hop.

**D. Last-hop / relay hint (low confidence):** `MeshPacket.relay_node` is often **only the last byte of a node number**, not a full unique identity. Given a trusted RF receiver G and a nonzero relay hint, find matching full node IDs **among nodes known within the selected window**, other than the originator and G. Narrow the candidates: drop those whose reported in-window position is farther from G than the radio-range bound (the longest confirmed link in the window × 1.25, at least 50 km; unpositioned candidates stay because they cannot be ruled out; estimates are never used); if several remain, prefer the single candidate with confirmed (NeighborInfo, traceroute or direct-RF, never relay-hint) evidence with G. Infer a candidate `relay -> G` *only* if exactly one candidate remains, gateway reception is genuinely over RF, packet hop data is consistent, and no contradictory evidence exists. Ambiguous/missing/all-zero/sentinel hints must yield **no edge**. Do not create `origin -> G` merely because G published the packet. Record the hint and an uncertainty reason for possible diagnostics.

### 7.2 Link consistency filters

- Reject self-links, zero/invalid node IDs, ambiguous relay IDs, impossible hop paths, unauthenticated MQTT-as-RF interpretations, and invalid/missing radio measurements.
- RF range alone is not a reliable proof of impossibility; exceptionally long LoS links exist. Use conservative anomaly detection based on elevation/geometry if reliable data is available, never a simplistic low distance threshold.
- Link RF quality may be asymmetric. Show RSSI (dBm) and SNR (dB) separately and correctly; do not average them into an unexplained “signal strength.” Use median, sample count, min/max, and last in-window sample, with separate directed measurements where possible.
- Merge repeated observations without falsely increasing confidence because one RF event was uploaded to many brokers.
- Confidence order and provenance are visible to users: `neighbor`, `traceroute`, `direct gateway RF`, `inferred last hop`. Multiple independent evidence types can strengthen confidence; contradictory evidence can lower it.
- A graph edge expires at the selected interval boundary, not on an invisible global “recently heard” lifetime. Additional styling may indicate stale *within* the interval but cannot use outside evidence.

### 7.3 Path and flow graphics

- **One line per node pair.** Directed edges stay separate in the API and the details panel; on the map a pair takes the better direction's confidence and is dashed only if every present direction is inferred. No arrowheads: direction is shown in hover text and the details panel.
- **Link classes:** infrastructure links (both ends announce ROUTER or ROUTER_LATE in the window) are 3 px bright blue; all other links (including router ↔ non-router and nodes with no role in the window) are 1.25 px grey-blue. Width never depends on sample count. Confidence is opacity (high solid, medium fainter, low fainter still) plus dashes for inferred links. Each class is its own switchable layer; infrastructure draws on top. A selected link is white.
- **Live traffic as radar pings** (rolling window only): each RF transmission attributable to a positioned node is one expanding ring centred on the transmitter, growing until it encloses every placeable node known to have heard that transmission directly; each such receiver flashes as the ring reaches it. First broadcasts by the originator are blue; rebroadcasts by a relay are amber. Attribution per gateway reception:
  - The originator always made the first broadcast; all copies of one logical packet share its ping.
  - `direct_rf` or hop count 0 (`hop_start − hop_limit`): the gateway heard the originator directly.
  - Otherwise the gateway heard a rebroadcast by the last hop, resolved from the relay byte by the same rules as §7.1 D; an unresolved byte attributes nothing.
  - Hop count 1 with a resolved relay whose known role is **not** ROUTER, ROUTER_LATE or CLIENT_BASE: that relay spent the only hop (Meshtastic's favourite-router 0-cost rule applies only to those roles), so it heard the originator directly. With a zero-cost-capable or unknown role, nothing is inferred.
  - Traceroutes use their recorded path instead (live events carry it): each adjacent pair of originator, path and gateway is one transmission heard directly; unrecorded hops break the chain without inventing receivers.
- **Ping timing:** grow 3 s (ease-out), linger 5 s, fade 2.5 s; a ping accepts receivers while on the map (~10.5 s). A receiver outside the ring restarts growth from the current size and resets the linger; any new receiver revives a fading ring. A rebroadcast whose upstream transmission is on the map waits until that ring reaches the relay. Rings never draw smaller than 22 px so co-located receivers stay visible. The fill is a radial gradient: opaque at the transmitter, at each receiver's distance the opacity of its measured signal (SNR −20…+10 dB, else RSSI), transparent at the edge, never increasing outward. Transmissions with no placeable receiver show only a brief soft glow. At most 80 pings run at once; late copies never re-ping. Pings are off with reduced motion or the "Animated traffic" switch.
- Never imply a verified end-to-end route from source to destination based solely on a broadcast's addresses. Timestamps are `observed_at` (receive time), labelled as such, not RF transmission time.
- Edge hover shows both directions with confidence and sample counts; clicking opens the pair, with each direction's evidence source, sample count, confidence reason, SNR/RSSI statistics and in-window time range, and names when known in the window.

## 8. Approximate geolocation of unpositioned nodes

This is an **estimate**, not triangulation in the GPS sense. LoRa SNR/RSSI depends strongly on terrain, antennas, power, bandwidth, obstacles and receiver noise. Without calibration the observations do not provide defensible exact distances. The UI must never show a precise pin pretending otherwise.

### Required estimator behavior

1. Collect geographically positioned **anchor nodes** whose positions were actually announced within the selected interval with known precision of at least `GEOLOCATION_MIN_PRECISION_BITS` (default 15), together with unambiguous direct RF quality samples involving the unknown node. Gateway reception, NeighborInfo and valid traceroute segments can contribute; multi-hop source-to-gateway measurements cannot.
2. Require at least **three distinct, spatially separated anchors** and enough independent samples with non-degenerate geometry for a two-dimensional point estimate. Reject collinear/clustered anchors and wildly inconsistent observations. An optional fourth anchor can substantially strengthen the result.
3. Use a robust propagation-based estimator (e.g. weighted least-squares/log-distance-loss model with calibrated parameters) where calibration is available. Permit site/antenna parameters from static configuration without writing additional DB tables. If uncalibrated, a guarded weighted geometric estimate is permitted **only with very-low-confidence labeling and a broad uncertainty region**; an insufficiently constrained estimate should be suppressed entirely.
4. Produce `latitude`, `longitude`, `uncertainty_radius_m` or uncertainty polygon, `method`, `quality`, `anchor_count`, `sample_count`, `evidence_time_range`, and diagnostic reasons. Add each anchor's own position error (half the diagonal of its reported precision cell, ~0.8 km at 15 bits) in full to the radius and state it in the reasons. Every unpositioned node without an estimate carries an `estimate_note` explaining why. Apply conservative minimum uncertainty floors; do not output meter-scale precision, and do not snap estimated positions to named peaks/roads or user-provided geographic expectations.
5. Recompute separately for each selected window. Do not use anchors or RF observations from before `start` or at/after `end`.
6. Differentiate on the map: exact/reported coordinates use a normal node marker; approximate coordinates use a distinct hollow marker and explicit “Estimated location”. Accuracy circles (estimate uncertainty) are off by default and switchable; the selected node always shows its circle — the estimate's uncertainty, or for a coarse reported position its precision-cell error. No best-effort invented position for missing evidence.
7. Respect positions intentionally shared with reduced precision: preserve indicated precision, do not silently increase effective public precision by a different route, and expose a configurable `GEOLOCATION_EXCLUDE_NODE_IDS` list for operators to omit particular nodes from inference. Positions coarser than the anchor threshold are never anchors; coarser-than-exact anchors at or above it count only with their precision error added to the uncertainty.
8. Test with simulated known placements and realistically noisy measurements, measure localization error and calibration sensitivity, and include a negative test for impossible/underdetermined cases.

## 9. Sliding window and live mode

### 9.1 Date-range interface

- Default `[now - 3 days, now)` in **rolling live mode**.
- Preset durations: **1h, 3h, 6h, 12h, 24h, 3d, 7d**. Custom window durations allowed from 1 hour through 7 days (no accidental cap on how *far back* the window can be shifted).
- Start and end are individually selectable via date/time controls and a draggable dual-handle timeline. Include a “move whole window”/pan control that preserves duration while sliding back through the retention period.
- UTC is the internal representation; UI shows the user's local timezone with a visible timezone indicator. Handle DST transitions and ambiguous local times.
- The earliest selection is bounded by retention; the latest is now. Fixed historic windows do not silently creep forward. “Return to live” restores rolling mode.
- Time controls, node/edge detail panels, counters and chart buckets consistently reflect exactly the same selected interval.
- The time bar overlays the bottom of the map. Collapsed, only its first row shows (live/historical badge, presets, start/end inputs, time zone); hover, keyboard focus or a tap slides up the rest (range slider with move-back/forward buttons, traffic strip, window readout). The map never resizes.

### 9.2 Loading and live semantics

- On initial load, fetch the selected range's decoded observations (paged, parallel time slices) and derive the full state in the browser (a WebAssembly engine in a Web Worker), so users see the state immediately without leaving the browser connected for days. The browser keeps its copy in IndexedDB and later fetches only what is new. There is no in-window playback.
- Send compact decoded rows, **not raw protobuf packets**, envelopes or payload bodies. Do not persist derived state in another table.
- On a rolling live window, incoming accepted packets update state via SSE or WebSocket. Also remove evidence that has rolled out of the beginning of the window, even if no new packet arrives.
- On a fixed historical window, live updates after its end are not displayed, counted, streamed, or applied to its state (the live stream accepts only rolling windows).
- Changing start/end or filters that affect the graph cancels obsolete requests; server and client must discard stale results. Include request IDs or generation identifiers to prevent cross-window UI contamination.
- Provide a visible “no observed data for this interval” state, and identify partial observation coverage when a broker was offline if that information is available from bounded operational telemetry (do not invent uptime history).

## 10. Frontend requirements

### 10.1 Map and visual style

- **Dark mode only.** No light-theme toggle and no light-theme flash during loading.
- Use **MapLibre GL JS** for vector basemap and **deck.gl** or equivalent GPU/WebGL layers for scalable node/link rendering. A canvas/WebGL-only implementation with similar capability is acceptable with evidence of superior performance.
- Available cartography at appropriate zoom levels: **place names, mountain peak names, major and minor roads, road names and numbers, water names, rivers, buildings, land cover, and administrative/national borders**, each verified to render when enabled. A **Layers** panel switches basemap groups and mesh overlays; every switch has a tooltip explaining its data. To keep the map calm, only borders and land cover start on; roads, place names, peaks, road names, water names, rivers and buildings start off. Water and background are always drawn. Choices are a per-viewer convenience kept in browser storage. Mesh layers draw beneath basemap labels so enabled names stay readable.
- Basemap colors: dark charcoal/slate, restrained terrain/hillshade, legible location labels, contrasting border/road hierarchy. Keep topographic context readable in mountainous Norway. Do not fake peak names with static screenshots; they must be genuine geographic labels tied to features.
- Bundle a working dark style definition and needed web assets. Support a configurable no-key public vector-tile provider for normal online deployment, plus a documented **self-hosted PMTiles/vector-tile option** served by the stack for deployments requiring independence from external map providers. In self-hosted mode, include/serve matching glyphs and sprites. Do not bundle a multi-gigabyte country extract in Git; document an automated, license-compliant import/download process. The app services themselves must not require a hosted SaaS API.
- Attribute OpenStreetMap and any other tile source as required. Make start map center and zoom configurable with a sensible Norwegian default; the map starts at “fit to data” once the first positions arrive, and a fit-to-data button sits in the zoom control group. Base-map features are geographic context and are not treated as time-filtered mesh observations.
- Support pan, zoom, search/filter by in-window node ID/name, hover tooltips, click selection, side-panel details, legend, and a visible timestamp/window readout, plus a scale bar and map coordinates on hover. Clicking empty map clears the selection.
- UI chrome overlays the map and never resizes it. The side panel (Nodes, Details, Filters, Legend) starts hidden, toggles from the top bar, and opens on Details when a node or link is selected; if the selection opened it, clearing the selection hides it again. It overlays the right edge (a bottom sheet on narrow screens); map controls and framing (fit, fly-to-selection) stay clear of it.

### 10.2 Node rendering and details

- Distinguish reported position, estimated position (hollow marker) and unpositioned/reference-only node. **Size by role:** ROUTER and ROUTER_LATE largest, CLIENT_BASE medium, any other or unreported role normal. **Colour by last heard:** the node's age as a fraction of the selected window, on a colourblind-safe ramp from pale yellow (heard at the window end) to dark magenta (heard only near its start); the legend labels the ramp in the current window's hours or days. Gateways have a blue ring; the selected node a white outline. Node names (short name, full Unicode) show from zoom 10 and are on by default.
- Unpositioned nodes must be discoverable in a **separate list or non-geographic graph inset**, not placed at random map coordinates or silently omitted.
- Node panel includes, when available *from the selected interval*: node number (`!xxxxxxxx`), long/short names, hardware model, role, reported latitude/longitude/altitude and precision, estimated position/confidence, first and last observation **in window**, number of unique packets and gateway receptions, source broker/gateways, public-key/signature verification indicator, power/battery/telemetry samples, direct neighbors, observed traceroutes, RF link quality, and timeline mini-charts.
- Clearly show “not reported in selected period” for missing values. Never import a name, device model, position or battery status from outside the selected interval merely to make the panel look complete.
- Default to not showing message bodies. Traffic lists can show message type, counts, size, sender/receiver if known, and in-window timestamps, with pagination.

### 10.3 Traffic and topology rendering

- Visualize observed links as one line per node pair, styled by class and confidence (§7.3), with a legend, on-hover details and radar-ping traffic.
- Allow filters for port type, channel, broker, evidence type, minimum confidence, and only nodes with positions.
- Layer switches for infrastructure links, other links, inferred links, accuracy circles, node names and animated traffic; defaults favour legibility (accuracy circles off, the rest on).
- Selecting a node shows only links involving it (all of them) and its accuracy circle; clearing the selection restores the rest.
- Throttle link geometry: below zoom 9 draw the best-supported 3 000 links, above it only links touching the viewport, using batched GPU geometries while keeping correct global counts from the server. Node marker clustering at low zoom is deferred.
- Provide keyboard accessibility for essential controls, colorblind-friendly signal colors, reduced-motion support, and meaningful loading/error states.

### 10.4 Caching, offline use and installation

- **HTTP caching:** content-hashed build assets are cached for a year (immutable); glyph fonts 30 days; icons 7 days; the map style 5 minutes with stale-while-revalidate. The page, service worker and manifest always revalidate so a deploy is picked up on the next load. Tiles are cached by the browser's HTTP cache (1 day, stale-while-revalidate 7 days, ETag), never by the service worker.
- **Service worker:** precaches the app shell (all build output except source maps, plus the map style); serves pages network-first with the cached shell as fallback; stores glyph ranges as used; serves API GETs network-first (8 s timeout) and keeps successful responses within a size cap (30 MB total, 10 MB per entry, least recent evicted). Offline, the last copy for the same URL is served marked as offline and the app shows “Offline: showing the data last received (time)”; a never-seen view returns an error. Tiles, the live stream, health and metrics are network-only. Each build gets a fresh shell cache.
- **Installable:** a web app manifest (standalone, dark theme, regular and maskable icons, Apple touch icon), mobile web-app meta tags, and an “Install app” button where the browser offers an install prompt; on iOS, Add to Home Screen. Service workers and installation require HTTPS in production.

## 11. Performance targets and implementation strategy

These targets are development acceptance budgets, not promises about unlimited public traffic. Benchmark with reproducible synthetic workloads and report the hardware/browser used.

**Reference workload:** at least 2 million accepted packet observations retained, 2,000 nodes, 20,000 distinct candidate edges over an interval, and burst ingestion of 100 MQTT messages/second on a 4 vCPU / 8 GiB machine. Test larger data sets as time permits.

- Ingestion continues while historical queries and retention cleanup are running; backlog remains bounded and recovers after temporary DB outages.
- 3-day window at reference workload: target <= 2 seconds to fetch a window the browser already holds most of, and <= 10 seconds from empty, under normal local network conditions (track p50/p95). Render initial useful map incrementally rather than blocking the UI on all ancillary charts.
- Pan/zoom target near 60 FPS on a desktop for normal density; >= 30 FPS during supported dense animation scenarios. Stop animations on hidden tabs and reduced-motion preference.
- Client must remain responsive and not load entire raw historical logs into JS heap. Target < 250 MiB sustained heap for reference density, excluding browser basemap tile cache and other browser overhead; instrument and report actual results.
- Render links/points using instancing or batched GPU buffers, memoized derived views and level of detail; add Web Workers for client transforms if profiling shows main-thread hotspots (none are used yet; a service worker provides offline support). Avoid React rerenders per packet or DOM markers per node at scale.
- Use downsampled fixed-resolution server aggregations for long windows; maintain detail through drilldown and bounded queries. Bound event animations (at most 80 concurrent pings; one ping per transmission however many copies arrive).
- **WASM is permitted but not mandatory.** First profile SQL, backend reducers, and main-thread/client hotspots. Add WASM only if benchmarking demonstrates a material gain for expensive parsing, geometry or inference. Do not use WASM to compensate for an unbounded architecture.
- Size API pagination, WebSocket/SSE batches, cache, and ingest queues explicitly; add overload behavior, heartbeat and retry logic.

## 12. Backend API contract

Use an OpenAPI-documented REST API plus SSE for live deltas. JSON is sufficient initially; compact binary transport can be added if profiled. Every historical response must echo the **effective start/end** (and whether the window is rolling) and report its data revision/generation. Omitting both `start` and `end` selects the rolling live window `[now − duration, now)` (`duration` default 72 h, `now` quantized so clients share cache entries); giving only one bound is an error.

Suggested endpoints (paths may change, semantics may not):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/capabilities` | Supported intervals, window duration limits, feature flags, viewport defaults; no secrets |
| `GET /api/v1/retention` | Retention cutoff, earliest/latest available `observed_at` and server UTC now |
| `GET /api/v1/observations?start=&end=` or `?duration=`, optional `since`/`until` (narrowing only) and `cursor` | The decoded observations of the window, paged in `(observed_at, id)` order: compact rows with header fields, radio metadata, signature status and the decoded fields views need (identity, position, device telemetry, NeighborInfo, traceroute, map report). Browsers derive every view from them (D-031, D-041) |
| `GET /api/v1/stream?duration=` | SSE live updates for a rolling window only (fixed windows rejected): each new observation with its full row, as `/observations` returns it, plus heartbeats with the current window bounds and retention notices |
| `GET /api/openapi.yaml` | The OpenAPI document (also committed as `docs/api-openapi.yaml`) |
| `GET /health/live` and `/health/ready` | Container orchestration health; readiness checks DB, cache, and startup status |
| `GET /metrics` | Optional operator-only metrics, not openly browsable mesh-derived history |

Rules:

- Never include full protobuf envelopes, ciphertext, channel PSKs, private keys, unsanitized message bodies, or unrestricted in-memory logs in public API payloads.
- Validate/filter/limit all query params. Strict maximum window length 7 days unless explicitly changed in a future spec. Reject open-ended queries and cross-retention requests.
- Protect against expensive query abuse: rate limits, concurrent request caps, response-size bounds, server timeouts, and documented proxy limits.
- Publish an OpenAPI schema, with examples of positioned, estimated, referenced/unpositioned and absent nodes; verified/unsigned/unverifiable packets; confirmed/inferred graph links.
- Use gzip or Brotli where useful and implement graceful cache fallback if Redis is unavailable.

## 13. Proposed implementation stack

Implemented stack (the original recommendation was Python/FastAPI; Go was chosen, see `docs/decisions.md` D-001):

- **Ingest and backend:** Go with huma (OpenAPI 3.1), Eclipse Paho MQTT clients (v5 and v3.1.1), pgx, go-redis, generated pinned Meshtastic protobuf bindings, stdlib AES-CTR, RFC 3610 CCM, and XEdDSA verification as the firmware does it (birational map with a vetted field library plus stdlib Ed25519; no new curve arithmetic). Separate units for MQTT, decryption, verification, event normalization, persistence, graph reducer, geolocation, historical querying and API. **Do not implement XEdDSA from scratch**; if verification cannot be made reliable, treat it as a release blocker rather than falsely accepting it.
- **Database:** PostgreSQL, only `packet_log` as application table.
- **Cache:** Redis in non-persistent mode (`save ""`, appendonly disabled); entirely rebuildable from the packet table. Prefer one instance and bounded key TTLs.
- **Frontend:** TypeScript, React + Vite, MapLibre GL JS (pinned to 5.x while deck.gl's interleaved mode breaks 6.x label rendering) and deck.gl; a hand-written service worker for offline use; Web Workers if profiling requires them.
- **Web serving:** Caddy or Nginx fronting static frontend assets and `/api` on the Docker network. Use no JavaScript CDN at runtime; bundle dependencies.
- **Maintenance:** lightweight separate Compose service invoking the backend project's scheduled cleanup command, with a single leader/advisory lock.
- **Testing:** `go test` (unit, real-capture replay, and Docker-based integration tests); Vitest for UI logic; Playwright for end-to-end and screenshot assertions against a stack built with the end-to-end test hook (never present in production builds); ESLint for the frontend. Deterministic scenario packet generators and load benchmarks.

The entire service must run on common Linux `amd64` Docker hosts; `arm64` is desirable.

### Suggested repository layout

```text
868map/
  compose.yaml
  .env.example
  README.md
  MESHTASTIC_MESH_MAP_SPEC.md
  backend/
    Dockerfile
    cmd/meshmap/
    internal/{mqtt,protocol,security,ingest,identity,storage,cache,window,query,graph,geo,api,maintenance,demo}/
    test/{fixtures,integration}/
  frontend/
    src/{api,map,features,timeline,state,components,lib}/
    sw/sw.js
    public/{manifest.webmanifest,icons/}
    tests/  e2e/
  web/
    Dockerfile
    Caddyfile
    styles/dark.json
  scripts/
    generate_test_packets.*
    benchmark.*
    basemap_import.*
  docs/
    architecture.md
    decisions.md
    protocol-compatibility.md
    operations.md
    basemap.md
    api-openapi.yaml
```

## 14. Docker Compose and configuration

`compose.yaml` MUST include:

1. `postgres`: persistent named volume, health checks, conservative tuning for local operation.
2. `redis`: no durable persistence, bounded memory with explicit eviction policy and health checks.
3. `backend`: MQTT subscribers and HTTP API, DB migrations/idempotent schema initialization, health checks and suitable restart policy.
4. `maintenance`: scheduled retention task, same application build, no concurrent duplicate work.
5. `web`: static frontend and reverse proxy to backend, exposes one configurable HTTP port, with examples for HTTPS behind Traefik/Caddy/Nginx.
6. An **optional**, clearly separated `demo` profile with a local Mosquitto broker and deterministic packet replay tool for testing without real credentials. It must not accidentally publish to live Meshtastic networks.

`.env.example` documents settings without real credentials:

```dotenv
WEB_PORT=8080
POSTGRES_DB=meshmap
POSTGRES_USER=meshmap
POSTGRES_PASSWORD=CHANGE_ME
REDIS_MAXMEMORY=256mb
RETENTION_MONTHS=6
DEFAULT_WINDOW_HOURS=72
MAX_WINDOW_HOURS=168
MAINTENANCE_INTERVAL_HOURS=24
DEFAULT_MAP_LAT=63.43
DEFAULT_MAP_LON=10.40
DEFAULT_MAP_ZOOM=7
MAP_STYLE_URL=/styles/dark.json
LIVE_QUANTUM=10s
GEOLOCATION_ENABLED=true
GEOLOCATION_EXCLUDE_NODE_IDS=
GEOLOCATION_MIN_PRECISION_BITS=15
PUBLIC_METRICS_ENABLED=false
SIGNATURE_POLICY=balanced
TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8
DEMO_MODE=false
MQTT_BROKERS_CONFIG=/run/secrets/mqtt-brokers.yaml
CHANNEL_KEYS_CONFIG=/run/secrets/channel-keys.yaml
E2E_HOOKS=false   # true only for end-to-end test stacks
```

Use mounted YAML/JSON secret config for a **list** of brokers and a **list** of channel/PSK definitions, with per-broker TLS, username/password, client ID, topics, and subscription QoS. Clearly distinguish channel PSKs from node public keys. Supply example files with fake values. Configuration files should support multiple channel names and one or more historical keys where rotations occur. Docker `.env` values are defaults; secret contents are not checked into Git.

Provide a startup validation command, schema check, backup and restore instructions, logs, container status, network diagrams, and optional sample reverse-proxy configuration. The app must boot with no MQTT sources in demo mode, and fail readably on invalid production configuration. Do not require a separately deployed message queue, separate SQL DB for aggregates, proprietary map API account, or manual package installation on host apart from Docker/Compose.

## 15. UI wireframe and behavior

Desktop layout:

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Mesh Observatory  nodes · positioned · estimated · links · packets  [Install app] [Nodes & details] │
├──────────────────────────────────────────────────────────────────────────────────┤
│ [+][−][⤢ fit]                                           [Layers]  ┌─────────────┐ │
│                                                                    │ side panel  │ │
│   DARK GEOGRAPHIC MAP (full width, never resized)                  │ (overlay,   │ │
│   ● markers: size = role, colour = last heard                      │ hidden by   │ │
│   ○ estimated positions (accuracy circle when selected/enabled)    │ default)    │ │
│   ━ infrastructure links (blue)   ─ other links (grey-blue)        │ Nodes /     │ │
│   ╌ inferred links                ◎ radar pings                    │ Details /   │ │
│                                                                    │ Filters /   │ │
│                                                                    │ Legend      │ │
├─ time bar (overlay; collapsed to its first row, expands on hover/focus/tap) ─────┤
│ ● LIVE [Return to live] [1h][3h][6h][12h][24h][3d][7d] Start [..] End [..] zone   │
│ [◀] |<───────── dual-handle window within retention ─────────>| [▶]               │
│ traffic strip: unique packets / receptions          window readout               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Mobile layout: map fills screen; the side panel becomes a bottom sheet; the collapsed time bar stays accessible without blocking pan. Node details show provenance badges and caveats beside estimated location or inferred links. Use a consistent time-window indicator on all pages.

## 16. Milestones and implementation order

### M0 — Protocol and contract spike

- Pin upstream protobuf version, validate envelope parsing, get known good AES-CTR and AES-CCM fixtures, XEdDSA verification vectors including tampered payloads and first-contact NodeInfo, traceroute and neighbor examples.
- Write the event-time/dedupe policy, SQL schema, API examples and UI data types. Demonstrate that no hidden identity or snapshot table is needed.
- **Gate:** tests correctly accept/reject real-format fixtures; crypto blockers solved before claiming production readiness.

### M1 — Runnable data pipeline

- Compose services, broker configuration, ingestion, decrypt/verify/parse, packet-log storage, duplicate handling, reconnect/restart, metrics, maintenance and demo publisher.
- **Gate:** a clean `docker compose up` plus demo script populates only the packet-log table; bad input cannot crash the stack or enter storage.

### M2 — Time-window backend

- Window-isolated observations (server) and window-isolated NodeInfo/positions, traffic buckets and links (engine), retention, live stream and API/OpenAPI tests.
- **Gate:** switching windows never reveals metadata from previous/next windows; cold start reconstructs from existing DB rows without waiting for MQTT.

### M3 — Topology, provenance and inference

- NeighborInfo, traceroute forward/back SNR, direct gateway observations, guarded relay hints, weighted graph, per-edge evidence and coarse geolocation with uncertainty.
- **Gate:** positive/negative inference fixtures pass; no false links on last-byte collisions; no precise guessed positions.

### M4 — Interactive map and timeline

- Permanent dark basemap with switchable labels and layers, performant markers and GPU edges, details, filter UI, interactive time controls, sliding historic windows, live streaming, radar-ping animation, overlay layout, offline support and installability.
- **Gate:** Playwright verifies map, selection, selected-window state, sliding windows and return to live, and detail correctness; screenshots and label queries prove roads/borders/places/peaks render when enabled and are hidden by default.

### M5 — Hardening and delivery

- Reference-workload benchmarks, overload/reconnect/resume tests, security review, secrets/backup guidance, documentation and reproducible deployment.
- **Gate:** complete acceptance matrix below; no mocks in primary production path, no failing critical tests, no unbounded memory behavior.

## 17. Required automated acceptance tests

Write tests as executable behavior, not assertions about whether a function was called.

### Crypto and ingestion

1. Valid AES-CTR envelope with configured channel name/PSK is decoded and persisted once per distinct gateway observation.
2. Same packet with wrong key or malformed protobuf is discarded; AES-CTR parsing is **not** called cryptographic integrity verification.
3. AES-CCM authenticates valid packet and discards an intentionally modified ciphertext/tag.
4. Valid XEdDSA packet with known authoritative key is stored `verified`; one-byte mutation of signed payload or signature with same known key is **discarded**.
5. Correct first-contact signed NodeInfo is accepted after self-consistency checks; spoofed/conflicting identity is rejected for identity updates.
6. Unknown-key signatures never display as `verified`, and unsigned compatible packets are labeled accurately.
7. Mutated-in-transit traceroute signature is treated according to the documented protocol exception, not incorrectly marked authenticated.
8. PKI-only DM without a suitable key is discarded, and channel PSK is not incorrectly tried as a DM private key.
9. Two brokers feeding the same gateway observation do not double-count it; two gateways hearing the same radio packet are retained as independent observations, but count as one logical packet for unique-traffic statistics.
10. Malformed payloads, oversize payloads, repeated reconnects, missing topic segments, and malicious strings do not crash the service.

### Temporal isolation

11. Node A named `OldName` at T1, renamed `NewName` at T3: window covering only T2 (no NodeInfo) must show neither name; window containing T1 but not T3 shows `OldName`; reverse for T3.
12. Node with position only before `start` appears unpositioned in the selected window even if it sends in-window packets.
13. Link evidence at `start - 1 ms` is never displayed. Evidence at `start` is displayed. Evidence at `end` is excluded.
14. A window ending before a later rename (or position, link, telemetry) shows only the earlier state; nothing observed at or after `end` appears.
15. Switching window while a query is in flight cannot flash stale data from the previous window; cached endpoints are scoped by period and generation.
16. Rolling last-three-days window ejects expired evidence even when no packets arrive.
17. Fixed historic window receives no new events beyond end time, despite continuing MQTT ingestion.
18. API rejects a seven-days-plus-one-second request and a request earlier than retention; it does not silently return extra history.
19. After retention deletion, deleted evidence cannot reappear from Redis or an open browser session.
20. A full backend restart + empty Redis reconstructs the same in-window results from `packet_log`.

### Graph, radio, estimates

21. NeighborInfo A reporting B creates only measured direction `B -> A`, preserving the reported floating-point SNR in dB (unlike traceroute integer SNR, it is **not** divided by four).
22. Forward and return traceroutes create correct adjacent directed edges and SNR/4; no shortcut edge from origin to final gateway.
23. Relay low-byte matching two candidate node IDs produces **zero** inferred links.
24. A unique relay byte, valid RF receiver metadata and consistent hops produce a **low-confidence** inferred segment; otherwise no segment.
25. MQTT-received packet without demonstrable RF receiver must not create an RF edge.
26. Three well-spaced anchored nodes with sufficient independent radio observations permit a **coarse labeled estimate with uncertainty**, while two anchors, collocated anchors and multipath-conflicting samples yield no bogus precise pin.
27. No geolocation estimate may use anchors or RF measurements outside the current window; anchor precision error is included in the uncertainty radius.
28. Estimated and reported positions are visually distinct; unpositioned nodes are still accessible in a list.

### UI, performance and operations

29. Default window is rolling 3 days; presets from 1h through 7d work; selecting both bounds and sliding the window backward works to retention limit, with correct timezone behavior across DST.
30. Dark style is permanent; basemap names are hidden by default, and real place names, mountain peak labels, roads and borders appear in relevant map test areas and zooms once enabled; layer choices persist per viewer; every layer switch has an explanatory tooltip.
31. Selecting a node shows only its links and its accuracy circle; clicking empty map deselects; the side panel and time bar overlay the map without resizing it and the page never scrolls; API payloads never carry envelopes, ciphertext or message bodies; the app is installable and, offline, reopens with the last data received while no tile is stored by the service worker.
32. With 2 million DB rows and 2,000 nodes/20,000 candidate edges, perform and document benchmark results, browser memory and frame rate; no full raw-history browser buffer.
33. Daily cleanup runs and is safe to repeat; DB has only `packet_log` as application persistent table; Redis can be wiped without data loss.
34. Full stack comes up from fresh checkout, mounted example config and `docker compose up -d --build`; demo mode generates useful mesh traffic without reaching public MQTT brokers.
35. Integration tests verify TLS broker reconnect, invalid credentials, gateway duplication, database unavailability, health signaling, bounded queue, and recovery after restart.

## 18. Definition of done

The project is complete only when:

- All five implementation milestones have runnable, committed code with critical tests passing.
- No mandatory requirement is represented only by a placeholder, screenshot, TODO, or fake sample response.
- One-command Compose deployment works with a real broker and can be demonstrated offline using a local demo broker; reverse proxy and retention operate automatically.
- The map and time interface work across live and historical data, and the backend strictly prevents cross-window data leakage.
- Crypto, graph inference, and estimated positions expose real validation/confidence rather than claiming certainty they cannot provide.
- Performance tests and remaining limitations are documented honestly, including limitations of MQTT historical coverage, cryptographic trust, ambiguous relay hints, and RF-based geolocation.
- `README.md` contains quick start, how to specify multiple brokers and keys, how to import/select map tiles, how to run tests, backup/restore, troubleshooting and production security checklist.
- `docs/architecture.md`, `docs/decisions.md`, `docs/protocol-compatibility.md`, and the generated OpenAPI specification exist and match actual behavior.

## 19. Protocol references and implementation sources

Check the exact upstream revision used in the implementation. These are reference material, **not** alternative data sources for production node information:

- Meshtastic MQTT integration and topics: https://meshtastic.org/docs/software/integrations/mqtt/
- MQTT protobuf definitions, including `ServiceEnvelope`: https://github.com/meshtastic/protobufs/blob/master/meshtastic/mqtt.proto
- Main protobuf definitions (`MeshPacket`, `Data`, `RouteDiscovery`, `User`): https://github.com/meshtastic/protobufs/blob/master/meshtastic/mesh.proto
- Meshtastic encryption and XEdDSA signing behavior: https://meshtastic.org/docs/overview/encryption/
- Meshtastic 2.8.1+ channel AEAD setting: https://meshtastic.org/docs/configuration/radio/channels/
- Firmware signature verification and traceroute exception (`Router.cpp`): https://github.com/meshtastic/firmware/blob/develop/src/mesh/Router.cpp
- Neighbor Info module semantics: https://meshtastic.org/docs/configuration/module/neighbor-info/
- Traceroute semantics: https://meshtastic.org/docs/software/apple/user/traceroute/
- Current generated protobuf `RouteDiscovery` field representation: https://docs.rs/meshtastic/latest/meshtastic/protobufs/struct.RouteDiscovery.html
- MapLibre and deck.gl integration: https://deck.gl/docs/api-reference/maplibre/overview
- Protomaps MapLibre basemap assets/self-hosting: https://docs.protomaps.com/basemaps/maplibre

---

**Implementation priority:** protocol-correct ingestion and time isolation first; evidence-backed mesh topology and conservative location inference second; visual polish and animation third. A visually attractive but misleading topology or an API that leaks out-of-window node state is not an acceptable implementation.
