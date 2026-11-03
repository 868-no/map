# 868.no Map — design

This document describes the 868.no Map as it is built today: what it does, the rules behind every derived value and every map element, and the reasons for those rules where the reason helps. It is the reference that code comments cite as "design §n". Tags such as (D-073) mark the operator decisions behind a rule; code comments use the same tags, so searching for one leads here.

[architecture.md](architecture.md) has the component diagram and source layout, [operations.md](operations.md) the deployment and configuration detail, [protocol-compatibility.md](protocol-compatibility.md) the firmware facts the decoder relies on, [basemap.md](basemap.md) the basemap build, [benchmarks.md](benchmarks.md) the measurements, and [api-openapi.yaml](api-openapi.yaml) the API contract.

## Contents

1. [Purpose and principles](#1-purpose-and-principles)
2. [Ingest](#2-ingest)
3. [Storage and time](#3-storage-and-time)
4. [API](#4-api)
5. [The browser engine](#5-the-browser-engine)
6. [Derived mesh model](#6-derived-mesh-model)
7. [Map and user interface](#7-map-and-user-interface)
8. [Deployment and operations](#8-deployment-and-operations)
9. [Performance](#9-performance)
10. [Testing](#10-testing)
11. [Known limitations and open questions](#11-known-limitations-and-open-questions)

## 1 Purpose and principles

### 1.1 What it is

The 868.no Map is a web application for observing Meshtastic mesh networks using **only the traffic that reaches one or more MQTT brokers**. It decrypts channel traffic, verifies packet signatures, stores every accepted gateway reception, and lets anyone with a browser inspect the mesh for any time window in the retention period: nodes, evidence-backed radio links, positions and coarse location estimates, traffic, and live transmissions. It opens on a rolling three-day window and can slide back through six months.

It is built for the Norwegian community broker (`mqtt.868.no`) but hard-codes no region or community beyond its Norwegian defaults (start view, regions layer, basemap area).

The stack is Go (ingest and API), PostgreSQL (one table), Redis (ephemeral), a Rust engine compiled to WebAssembly running in a Web Worker in the browser, and a React + MapLibre GL + deck.gl frontend served by Caddy (D-001).

### 1.2 Invariants

These hold everywhere; a feature that would break one is not built.

1. **Only MQTT feeds mesh data.** No device API, serial link, node polling, other mesh feed or third-party topology service is used.
2. **One application table.** `packet_log` is the only persistent application table (its monthly partitions are not separate tables). No node, link, position, identity, snapshot, settings or migration table exists; Redis holds only ephemeral, rebuildable state.
3. **Strict window isolation.** Every mesh-derived output is scoped to the selected half-open interval `[start, end)`. No name, position, role, link, counter or chart is taken from outside it (§3.5).
4. **Nothing heard is dropped; what is private or untrustworthy is stripped (D-093).** Every packet with a parseable envelope is stored, but only what we may and can trust: a packet we cannot read (an end-to-end encrypted DM, a channel without our key) or cannot trust (failed decoding or verification) keeps only its cleartext header, never its content. Untrustworthy (`invalid`) rows count for nothing on the map, since their sender may be forged. Only duplicates (broker replays, JSON copies, re-deliveries) and unparseable envelopes are discarded. Plausible AES-CTR plaintext is never called authenticated.
5. **No imaginary edges or precise guesses.** Links and coordinates carry their provenance, confidence and uncertainty. Ambiguity produces nothing rather than a guess.
6. **The browser never loads the full log.** It loads the decoded rows of the selected window (at most 7 days) and live additions, and derives every view itself (D-031). Raw envelopes, payload bodies and keys never leave the server.
7. **One command deploys.** `docker compose up -d --build` starts the whole application after configuration, with no proprietary external service.

### 1.3 Honest data

The map shows what this service received over MQTT while it was running. Every timestamp is the server's receive time (`observed_at`), labelled as such, never an RF transmission time. Counts say what they count (distinct packets versus gateway receptions, node pairs versus directed links). Inferred values are marked as inferred, in the data and on screen: dashed links, hollow estimate markers, uncertainty circles, plain-word reasons in tooltips. Where the protocol cannot tell, the map says so instead of filling the gap.

### 1.4 Privacy, secrets and access

- **Public, no login.** The map has no accounts, cookies, analytics or third-party requests at runtime. Optional basic auth can be added at the proxy (operations.md).
- **No private content is stored.** Packets on channels whose key we lack, and end-to-end encrypted direct messages, keep only their cleartext header (sender, destination, packet id, gateway, channel name, hops, relay, size, signal), as `encrypted` and `direct_message` rows; the stored envelope has the payload zeroed (D-091, D-093). Only channels with a configured key, or the public default key (§2.3), are decoded.
- **No message bodies in decoded data or the API.** Text messages are recorded by type and size only. The raw envelope (`envelope_bytes`) is kept for re-decoding and audits; for a text message it still contains the message, encrypted with its channel key (readable with that key, e.g. the public default key) or in plain text when a gateway uplinked it decrypted. It is never served. The privacy policy and architecture.md say so; whether to keep envelopes is the operator's choice (D-051).
- **Uplink opt-out is honoured as far as possible.** A node that did not allow MQTT uplink is never named (§2.5).
- **Secrets** (MQTT credentials, channel PSKs, database password) come from mounted files or environment variables. They are never logged, stored, returned by the API or put in the browser bundle; `check-config` prints a redacted summary. The configuration revision that is part of the public data generation is an HMAC keyed with the database credentials, so it cannot be used to confirm guessed PSKs offline (D-083).
- **Visitors:** IP addresses live only in the rate limiter's memory (dropped after 10 idle minutes) and are never logged. Browser storage holds settings, the window's rows and the app shell. A static privacy policy at `/privacy.html` fills in the operator, contact, retention, geolocation and tile source from `/api/v1/capabilities` (D-051).
- **Location estimates** can be disabled, and nodes listed in `GEOLOCATION_EXCLUDE_NODE_IDS` are neither estimated nor used as anchors. The inputs are public, so exclusion is a display rule, not a secret (D-031).

### 1.5 Non-goals

Transmitting to the mesh, issuing traceroutes or controlling devices; decrypting PKI direct messages; predicting the route of arbitrary packets or claiming end-to-end routes from a broadcast's addresses; meter-scale positions from RSSI/SNR; showing or exporting message contents; user accounts.

## 2 Ingest

The backend binary `meshmap` runs ingest and the API in one process (`meshmap serve`). Ingest is a singleton: several processes subscribed to the same brokers would only produce duplicates.

### 2.1 MQTT input

- Any number of brokers, each with its own host, port, protocol (MQTT 5 via autopaho, or 3.1.1 via paho), TLS and CA, credentials, client id, topic filters and QoS. Configuration is YAML from mounted files or, in a Compose-only deployment, the `MQTT_BROKERS` and `CHANNEL_KEYS` environment variables, which replace the files when set (D-049).
- **Read-only.** The clients subscribe and never publish; a unit test fails if the `mqtt` package ever calls a `Publish` method. A broker counts as up (and in `/health/ready`) only once every topic filter was granted in the SUBACK; a refused filter, a missing SUBACK or a subscribe error leaves it down with a warning (D-083).
- **Topics:** `{root}/2/e/{channel}/{gateway}` (and legacy `/2/c/`), where `{root}` may have any depth (`msh/EU_868/NO/Østlandet`); the parser anchors on the last `/2/{e|c|json|map|stat}/` marker. `/2/map/` carries map reports (§2.5). `json` and `stat` topics are recognised and counted, not processed: protobuf is the canonical input, and a JSON copy would only duplicate a protobuf uplink.
- **Retained messages** are ignored by default (`accept_retained: false`), so a broker's retained copy never manufactures current activity.
- **Reconnect** with full-jitter exponential backoff from 1 s to 60 s and re-subscription on every connection.
- **Event time:** `observed_at` is stamped in the MQTT callback, before queuing (§3.4).

### 2.2 Decoding and input limits

- The payload is parsed as a `ServiceEnvelope` (`MeshPacket`, `channel_id`, `gateway_id`) with bindings generated from the pinned `meshtastic/protobufs` v2.8.2.
- **The topic names the channel.** Keys are chosen by the topic's channel segment, and the stored `channel_name`, the plaintext rule and the logical packet key use the same name. The envelope's `channel_id` is ignored: a replayed envelope could name another channel and so be decrypted under one name and stored under another. Map reports, whose topic names no channel, are stored without one. Rows stored earlier keep the name they were stored with; on real traffic the two agree (D-114).
- **Limits before and during parsing:** MQTT payload ≤ 4 096 bytes, service envelope ≤ 1 024 bytes, encrypted part ≤ 268 bytes (256 bytes plus PKI overhead), topic ≤ 512 characters, gateway id `!` plus 8 hex digits, channel id ≤ 64 characters, protobuf recursion limit, string lengths, ≤ 64 NeighborInfo entries, ≤ 8 traceroute hops, valid latitude/longitude and timestamps, and a key-attempt budget (`KEY_ATTEMPT_BUDGET`, default 4) that bounds the work per message; because it decides which packets decode when many keys are candidates, it is part of the configuration revision. A malformed protobuf never stops the subscriber; every rejection only increments `meshmap_ingest_rejected_total{category}`, and no payload bytes are logged. Failures past envelope parsing (keys, payload decoding, verification) are not rejections but header-only rows (§1.4).
- **Ports:** NodeInfo (sanitised names, hardware, role, public key), Position (zero coordinates mean none; `precision_bits == 0` means precision unknown, never an anchor), Telemetry (clamped), NeighborInfo, Traceroute, text (size only), routing (metadata only), map reports, node status (the status text a node broadcasts, sanitised like a name and removed for opt-out nodes), store-and-forward (message kind, heartbeat period, history size and a replayed text's size, never its content) (D-103), and well-formed unknown ports as `other`. Rows stored as `other` before node status and store-and-forward were decoded are labelled with their type when rows are encoded (kind `unknown`). An invalid payload is never interpreted as a known type.
- **NeighborInfo** SNR is a float in dB, stored unchanged. A report whose `node_id` is nonzero and differs from the packet sender is rejected (`payload_invalid`): it would let one node assert another's neighbours (D-008).
- **Traceroute** SNRs are integers × 4 and are divided by 4. Hops the firmware could not identify (`0xFFFFFFFF`, SNR −128) are kept as unknown placeholders; their SNR is null, and no link touches or bridges them.
- **Plaintext uplinks** (gateways uplinking decoded packets) go through the same schema validation and signature verification, with an inbound `xeddsa_signed` flag ignored, and are recorded as weaker crypto provenance. They are accepted for configured channel names (`accept_plaintext`, default true).
- **Minimum supported firmware is 2.7.** Older packets are decoded where possible; absent fields (`hop_start`, `transport_mechanism`, precision) never create evidence.
- **Direct RF** is decided at ingest: a reception is `direct_rf` when a gateway is present and is not the sender, the packet did not come via MQTT, the transport is LoRa, `hop_start == hop_limit > 0`, and RSSI or SNR is present. Otherwise the reason is recorded (relayed, via MQTT, non-RF, no metrics).

### 2.3 Decryption

- A channel is configured by **name and PSK(s)**, not a key pair, with a broker scope (`broker_ids`, `*` for all) and a mode: `ctr` (AES-CTR) or `ccm` (the AES-CCM channel AEAD of firmware 2.8.1+). PSKs are base64 or `hex:`; the one-byte shorthand expands to the public default key as in firmware. Several keys per channel allow rotation (current first). Any number of channels may be listed, and one name may appear with different broker scopes.
- **AES-CTR** uses the firmware nonce `LE64(packet_id) ‖ LE32(from) ‖ 0`. Success means the `Data` parses and its port handler accepts the payload; the status is `decrypted_unauthenticated`, because CTR has no tag.
- **AES-CCM** uses a 13-byte nonce prefix (L = 2), a 12-byte tag and AAD `LE32(from) ‖ LE32(to)`; a failed tag is rejected, with no CTR fallback. CCM proves possession of the channel key, not the sender's identity. The library is validated against RFC 3610 and the nonce/AAD construction matched to firmware source line by line; real AEAD traffic has not yet been observed, so CCM is verified against specification vectors only (D-004).
- The one-byte **channel hash** (XOR of name and key, `^ 0xAE` for AEAD) only orders candidate keys; it authenticates nothing.
- **Default-key fallback:** a packet on a channel name with no configured keys is tried with the default key (CTR and CCM) under the channel name its topic gives, but only when the channel hash matches the packet's channel byte, so a channel with its own key almost never gets an attempt. Configured names and PKI never fall back. Keys are derived per packet, not cached, because anyone who can publish chooses topic names. Such channels are readable by anyone with a Meshtastic radio, so decoding them adds nothing that is not already public. `DEFAULT_KEY_FALLBACK` (default true) is part of the configuration revision (D-065).
- **PKI direct messages** (PKI flag, or channel hash 0 with ciphertext) are never decrypted; channel PSKs are never tried on them. Their header is kept as a `direct_message` row: sender, recipient, packet id, hops, last relay, next hop, want-ack, size and the gateway's reception metrics, all sent in the clear on RF. The stored envelope has the payload replaced by zeros of the same length, so neither ciphertext nor a payload a recipient's gateway uplinked decoded is kept. They count as traffic and as link and relay evidence like any packet; without them a node's direct-message traffic and the receptions it proves were invisible, and the ACKs answering them (stored, since ACKs travel on the channel) could not be matched (D-091).
- Key rotation is a configuration change and a restart. Key material never reaches the API, logs, database or browser.

### 2.4 Signatures and identity

- **Verification** follows firmware: XEdDSA verification is Ed25519 verification under the Edwards form (sign bit 0) of the node's X25519 public key, using the vetted `filippo.io/edwards25519/field` for the map and stdlib `crypto/ed25519`; no curve arithmetic is hand-written. The conversion matches an independent derivation for ≥ 1 000 random keys, and mutations of header, payload or signature fail (D-002). Real firmware 2.8 captures from `mqtt.868.no`, committed as public fixtures, verify with zero signature rejections (D-003). The signing-buffer layout is in protocol-compatibility.md.
- **Per-packet status:** `verified`, `unsigned`, `unverifiable` or `not-applicable`. Never a blanket "secure" because a channel key decrypted.
- **First contact:** a signed NodeInfo from an unknown sender is promoted only if its public key is 32 bytes, its CRC-32 equals the node number, and the signature verifies under it; otherwise it is rejected, as firmware drops it.
- **Known signer:** the signature must verify against the authoritative key; a signed NodeInfo must also claim the key that signed it, and that key must hash to the sender. A mismatch is rejected. A malformed signature (length not 0 or 64) is rejected.
- **Header-only rows (D-093):** a failed check below keeps the packet as an `invalid` row with the reason (`iv`: `sig_invalid`, `sig_malformed`, `first_contact_invalid`, `nodeinfo_key_mismatch`, `strict_unverifiable`; also `payload_invalid`, `decode_failed`, `plaintext_unconfigured`). Its content is never stored, it never promotes an identity, and the engine's row filter drops it from every view except the sender's packet log, so it never counts as traffic, link, relay or ping evidence.
- **Unknown key:** other signed packets from a sender with no authoritative key are `unverifiable` and kept under `SIGNATURE_POLICY=balanced` (the default), rejected under `strict`. Strict does not drop unsigned packets as firmware Strict does: the map's job is visibility, and unsigned traffic is labelled (D-006).
- **Unsigned** traffic is kept and labelled. An unsigned NodeInfo never overwrites a known signing identity with a conflicting key; the conflict is counted and logged.
- **Traceroutes** are `not-applicable`: every hop rewrites the payload, so firmware exempts them, and the map never claims one verified nor treats the exemption as tampering.
- **Identity index:** the authoritative key per node lives in the ingest process's memory (`internal/identity`), rebuilt from verified NodeInfo rows in `packet_log` at startup, hourly and after every retention run. Node public keys are public data and are stored in `decoded_metadata`, so the rebuild needs no re-decryption (D-009). This is trust on first use, not a CA: when a key's announcements age out of retention, that trust lapses until the next valid signed NodeInfo.

### 2.5 OK-to-MQTT and map reports

- **OK to MQTT** (`Data.bitfield` bit 0): firmware withholds packets without the flag only from brokers with public addresses, so they can still reach us through a bridged local broker. A packet without the flag that a gateway other than its sender uplinked is kept and marked `not_ok_to_mqtt`; its **NodeInfo is kept without its names** (hardware, role and public key remain; the stored envelope's payload is zeroed), so the node is shown but never named (D-093). Its id, traffic and any reported position remain: a slight anonymisation, not a promise. A gateway uplinking its own packets is never filtered. No bitfield at all (firmware before 2.5) counts as allowed. Nodes with marked packets in the window carry `mqtt_opt_out` and get a permanent red ring (D-032). Opt-out nodes are never named, even if an older NodeInfo is in the window (D-087).
- **Map reports** (`…/2/map/`, `MAP_REPORT_APP`) are stored as packet type `mapreport` (crypto `mqtt_map_report`, signature not applicable), accepted only when published by the node they describe (sender = gateway). Their location is an ordinary reported position. Every report has packet id 0, so the logical key adds a 5-minute time bucket. Map reports never animate as pings (D-032).
- A map report's long and short name, hardware model and role are carried in rows. When the window holds no NodeInfo from a node, its latest named map report is its identity (`identity.source: "mapreport"`, and the panel says so instead of showing a signature); NodeInfo always wins (D-063).

### 2.6 Deduplication and broker provenance

- `logical_packet_key` identifies the RF packet: a truncated SHA-256 of sender, packet id, destination, channel, port and the canonical payload (re-marshalled with the signature cleared). Traceroutes exclude the payload, which every hop rewrites, so all partial-route copies share a logical key.
- `observation_key` identifies one reception: the logical key plus gateway, receive time, SNR, RSSI, hop limit and start, relay byte and payload hash. **Every distinct reception is its own row** — another gateway, relay, hop count, RF metrics or partial traceroute route. Brokers do not hear packets; gateways do.
- Only byte-identical re-deliveries of one gateway's upload (bridged brokers, a gateway publishing to several brokers, QoS retries) collapse. A worker first claims the key atomically in an in-process in-flight set, then checks committed keys (in-process TTL set, Redis, then the database). A claim is held only by observations already handed to the writer, which retries until commit, so a dropped message never suppresses a later copy (D-011). The dedupe window is 15 minutes.
- The first broker to deliver a reception is its `broker_id`; every other broker that delivers it is added to `decoded_metadata.also_via` (a debug aid): merged before the insert while the row is in memory, otherwise applied by the writer as one batched update per flush that never adds a broker already present. These updates are restricted to recent partitions (`observed_at ≥ now − (dedupe window + 24 h)`) so they never probe old months (D-013, D-083). `fillfactor = 90` leaves room for HOT updates.

### 2.7 Pipeline, backpressure and shutdown

- MQTT callback → bounded queue (`INGEST_QUEUE_SIZE`, default 20 000, several minutes at 100 msg/s) → worker pool (parse, decrypt, verify, normalise, dedupe claim) → one batch writer (up to `WRITER_BATCH_SIZE`, default 500 rows, or every 200 ms), which then marks dedupe keys, applies `also_via` updates, promotes identities and publishes live rows.
- Meshtastic topics arrive at QoS 0, so senders cannot be slowed. When the queue is full, messages are dropped and counted (`meshmap_ingest_dropped_total{reason="queue_full"}`); the writer retries database errors with backoff while the queue absorbs input. Broker disconnections lose whatever the broker does not retain.
- There is no per-message processing timeout: work is bounded by the key-attempt budget.
- **Bounded shutdown:** MQTT input stops first, then open live streams close, then the writer retries for at most 10 s before recording the remaining rows as a `shutdown_db_unavailable` gap and counting them as dropped (D-059).

## 3 Storage and time

### 3.1 The packet_log table

`packet_log` (`backend/internal/storage/schema.sql`) has one row per accepted gateway reception. Columns: `id`, `observed_at`, `broker_id`, `mqtt_topic`, `gateway_node_id`, `source_node_id`, `destination_node_id`, `packet_id`, `channel_name`, `portnum`, `packet_type`, `logical_packet_key`, `observation_key`, `rx_time`, `rx_snr`, `rx_rssi`, `hop_start`, `hop_limit`, `relay_hint`, `transport_kind`, `signature_status`, `decode_version`, `envelope_bytes`, `decoded_metadata`, `obs_row`, `obs_row_version`.

- **Partitions:** range-partitioned by calendar month (UTC) of `observed_at` (`packet_log_pYYYYMM`). `storage.EnsurePartitions` creates them at startup (last month to two months ahead), on each maintenance run, and from the insert path whenever a batch reaches a month the process has not seen, so imports and tests with old timestamps just work (D-056).
- **Ids** come from the sequence `packet_log_id_seq` (PostgreSQL 16 has no identity columns on partitioned tables); the primary key is `(id, observed_at)`, because every unique index must include the partition key.
- **One row per reception:** a unique index on `(observation_key, observed_at)`. Inserts COPY into a per-connection staging table, then `INSERT … ON CONFLICT DO NOTHING RETURNING id`, so a batch retried after a commit whose outcome was lost stores nothing twice and gets the ids of its first attempt (D-056).
- **Indexes:** `(observed_at DESC, id DESC)` serves every `/observations` page and the boundary-month retention delete (D-038); a partial index on `(source_node_id, id) WHERE packet_type = 'nodeinfo'` serves the identity rebuild and a node's latest public key, and is untouched by other inserts (D-083, D-089). Two partial indexes on `id` cover the rows the startup jobs still have to rewrite: `WHERE decode_version < {DecodeVersion}` (re-decoding, D-107) and `WHERE obs_row_version IS DISTINCT FROM {obsrow.Version}` (the encoding backfill, D-046). New rows carry both versions, so in steady state they are empty, no insert touches them, and each job finds nothing at once instead of walking every partition. A predicate must be a constant, so each index is named after its version (`packet_log_stale_decode_v3_idx`); `init-schema` builds the current ones and drops those of other versions, so a version bump costs one index build at startup, which holds off writes on `packet_log` for the length of one scan (D-116). Indexes that served only the retired server views, and the never-scanned BRIN index, were dropped (D-045, D-056); `init-schema` drops them idempotently. The schema version is in the table comment (`meshmap-schema:2`), not a migrations table; `init-schema` runs idempotent statements under an advisory lock and converts an unpartitioned schema-1 table in one transaction.
- **Decoding again (D-107):** when `ingest.DecodeVersion` is bumped, the ingest process re-runs ingest on the stored envelope of every older row in the background (newest first, 500 per batch, waiting for rows another worker holds rather than skipping them), so decoder improvements reach the whole retained log. A row gets the current type, signature status, decoded metadata and envelope (a row that is header-only now has its payload zeroed retroactively), keeps its keys and broker provenance, and has its client encoding rebuilt. A row the current decoder would reject is kept unchanged and only marked as checked, and no identity is promoted from old rows. Version 3 brought node status, store-and-forward and header-only rows.
- **Three forms of one packet, on purpose:** `envelope_bytes` re-decodes after decoder changes; `decoded_metadata` (minimal sanitised typed data incl. public keys and reception provenance) rebuilds `obs_row` after logic changes and feeds identity; `obs_row` is what pages serve (D-056).
- **Stored row encodings:** `obs_row` is the row exactly as `/observations` serves it, minus the id, and `obs_row_version` the `obsrow.Version` it was built with. Pages read `obs_row` when its version is current and build the row from the other columns otherwise. At startup `serve` rebuilds missing or outdated encodings in the background, newest first, 2 000 rows per transaction with `FOR UPDATE SKIP LOCKED`. It is a copy of the row's own data, never derived state across rows, so a logic change needs only the version bump (D-046).
- The table is append-mostly: only `decoded_metadata.also_via`, the stored encoding and, when the decoder improves, a row's decoding (type, signature status, decoded metadata, envelope; D-107) are ever updated.

### 3.2 What is never stored

Rejected input (malformed or oversize envelopes, duplicates, broker replays, JSON copies) — not even in a quarantine table; the contents of packets we cannot read or trust (PKI direct messages, channels without a usable key, failed decryption or verification), which are kept as header-only rows instead (D-091, D-093); decoded message bodies; PSKs and private keys; derived data across rows (nodes, links, positions, snapshots). Operational metrics are process counters, not packet history.

### 3.3 Retention and maintenance

- Rows older than `RETENTION_MONTHS` (default 6) calendar months are removed. The cutoff subtracts calendar months and clamps to the end of the target month (Aug 31 − 6 months = Feb 28/29), matching PostgreSQL interval semantics; rows exactly at the cutoff are kept. The API's earliest bound and the deleter use the same function (D-012).
- The `maintenance` service runs daily at 03:00 UTC and at startup if a run is overdue, under a PostgreSQL advisory lock. It drops partitions of months that end before the cutoff, deletes the remaining expired rows of the cutoff's month in 5 000-row transactions, vacuums only that partition, creates partitions ahead, stores the run's status (time, deleted rows, table size, shown in `/health/ready`) and notifies open browser sessions, which drop the expired rows.
- Backups are not automated; `pg_dump`/`pg_restore` are documented in operations.md (D-049).

### 3.4 Event time

`observed_at`, stamped in UTC when the MQTT message is accepted, is the only time used for windows. `rx_time` and payload timestamps are kept as auxiliary, untrusted fields. Forged, drifting or missing radio clocks therefore cannot move a packet across a window boundary. The consequence is that the map shows what the service observed: nothing from before it started or while it was disconnected. Each gateway's reception of one packet has its own `observed_at`.

### 3.5 Window semantics

- A window is the half-open UTC interval `[start, end)`. `internal/window` is its single definition, and all window-scoped SQL starts from `window.Predicate`; a test fails if any other code compares `observed_at` (allowlist: the ingest dedupe fallback and the retention delete).
- **Defaults and limits:** default rolling window 72 h (`DEFAULT_WINDOW_HOURS`), maximum 168 h (`MAX_WINDOW_HOURS`), minimum 1 h, earliest start the retention cutoff, latest end now. Omitting `start` and `end` selects `[now − duration, now)` with `now` floored to `LIVE_QUANTUM` (10 s) so clients share boundaries. One bound only, `end ≤ start`, an over-long window or a start before retention is rejected; the server never widens a request. The browser takes the limits from `/capabilities` and requests nothing before they arrive (D-083).
- **Nothing leaks in from outside the window.** A node shown in a window has at least one accepted observation, or a mention in NeighborInfo or a traceroute, inside it. Its name, role, hardware and position come from the latest applicable announcement **in the window**; without one it shows its id and "not reported in selected period". A node only mentioned by others is "only named" (referenced) and inherits nothing. A link or estimate needs in-window evidence and disappears when the evidence leaves the window.
- **Nothing leaks past the end.** A fixed window shows only what was observed before its end, however much has been stored since, and receives no live updates.
- A rolling window evicts evidence that ages out even when no new packet arrives (heartbeats carry the moving bounds).
- `/observations` returns exactly the rows inside the interval; the engine derives every field from those rows only. Both halves have isolation tests (§10).

### 3.6 Redis

Redis runs without persistence (`save ""`, no AOF), with a memory cap and LRU eviction. It holds only dedupe keys, live pub/sub and maintenance status, all rebuildable; wiping it loses nothing. When it is unreachable, readiness reports degraded, dedupe falls back to a database lookup, and `serve` fans live rows out in process. There is no result cache: views are built in the browser (D-041).

## 4 API

### 4.1 Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/capabilities` | Window defaults and limits, feature flags, map styles (`style_url`, `style_url_light`), tile source, geolocation settings, operator name and contact, retention. No secrets. |
| `GET /api/v1/retention` | Configured cutoff, earliest and latest retained `observed_at` (operational metadata, not mesh state), server time. |
| `GET /api/v1/observations` | The decoded rows of a window, paged (§4.2). |
| `GET /api/v1/stream` | SSE for the rolling window only (§4.3). |
| `GET /api/v1/trends?bucket=day\|week\|month&tz=` | Long-term summaries over the whole retained log, bucketed in the requested IANA time zone: nodes heard, gateways, nodes first heard in the bucket, distinct packets, receptions and packets by type; `invalid` rows never count. Views stop at a week of rows, so this is the one aggregate computed on the server (D-104). It is summed from per-UTC-hour summaries the API process keeps in memory (nodes and gateways as sets, packets, receptions and packets by type), so `packet_log` stays the only table: the first request after a start scans the log once, they are refreshed at most once a minute whatever bucket or zone is asked for, re-reading only the last two hours, hours holding rows not yet decoded by the current decoder, and none older than the retained log; trends never take a read slot from `/observations`. Buckets in any whole-hour time zone are unions of hours (a zone with a half-hour offset gets boundaries up to 30 minutes off; accepted, since the map serves Norway); a packet heard either side of an hour boundary counts in both. Responses are reused for a minute (D-112). |
| `GET /api/v1/nodes/{id}/public-key` | A node's public key from its newest retained NodeInfo carrying one, with its time and signature status, plus the trusted key (earliest retained verified NodeInfo, §2.4) and since when; 404 when none is retained. It spans the retained log, not a window: a key identifies a node. Fetched by the Details panel (D-089). |
| `GET /api/openapi.yaml` / `.json` | The OpenAPI 3.1 document, generated from the serving code and committed as `docs/api-openapi.yaml`. |
| `GET /health/live`, `/health/ready` | Liveness (no backend work); readiness covers database, schema version, Redis, ingest writer and queue, broker states and the last retention run. Probes are outside the API rate limit, so readiness reuses its database and Redis checks for 2 s and concurrent probes share one check; ingest and broker states are always current. |
| `GET /metrics` | Prometheus metrics on `backend:9100` inside the Compose network; on the public port only with `PUBLIC_METRICS_ENABLED=true`. |

The huma docs UI is disabled because it loads JavaScript from a CDN.

### 4.2 Observations

- `GET /api/v1/observations?start=&end=` or `?duration=`, with optional `since`/`until` that only narrow the window (clamped to it, never widening) and an opaque `cursor`. Pages are ordered by `(observed_at, id)`, which the time index serves directly however much older data is retained; the cursor (Unix microseconds plus id) only positions within the window (D-038). `limit` is at most 20 000 rows.
- Each row carries compact keys and only public decoded RF fields: header fields, radio metadata, signature status, topic root (`tp`), the reception reason, and the port fields the views use (identity, position, device telemetry, NeighborInfo, traceroute, map report incl. region, preset and names). Never envelope bytes, payload bodies, public keys or full MQTT topics (D-031, D-044). Public keys are public, but 32 random bytes on every NodeInfo row would add about 15 % to a compressed window, so they are served per node instead (D-089).
- Every response echoes the effective window (and whether it is rolling) and a `generation` = `d{decode_version}.r{obsrow.Version}.c{config_rev}`. A browser holding rows of another generation discards them and refetches; a key rotation or row-format change therefore costs one refetch (D-041, D-083).
- Pages are written from the database cursor straight to the response in 64 KiB chunks, never collected in memory. The query starts before anything is written, so errors up to the first row get a proper status; a failure mid-page aborts the connection, so the browser sees a truncated body, never a well-formed partial page (D-057). `Cache-Control: no-store`.
- A row whose stored metadata fails to decode is still sent without those fields, and counted and logged on the 1st, 2nd, 4th, 8th, … occurrence (D-083).

### 4.3 Live stream

`GET /api/v1/stream?duration=` accepts only rolling windows (fixed windows get 422 before the stream opens). Events: `delta` with `{id, t, row}`, where `row` is exactly the `/observations` row (the same encoder builds both, and an integration test compares them) (D-033); `heartbeat` every 15 s (and one on connect) with the current window bounds and server time; retention notices; and `status`. The stream does not filter; browsers filter (D-041). The hub encodes each delta once for all connections. A subscriber too slow for its 256-message buffer is flagged and sent `status {live: true, reason: "lagged"}` before the next delta, and the browser syncs at once (D-045). An API-only process gets live rows over Redis pub/sub; its subscriber pings an idle connection every 10 s, and any lost connection sends `status {live: false}`, then, once a fresh subscription is confirmed (reconnecting with backoff from 1 s to 30 s), `status {live: true}`, on which the browser syncs what the stream missed. Rows published while disconnected are never silently lost: the sync fetches them from the database (D-117).

### 4.4 Limits and protection

Per-client token bucket (`API_RATE_PER_SECOND` 20, `API_RATE_BURST` 60), request deadline `API_REQUEST_TIMEOUT` 20 s, live streams per client (`API_STREAMS_PER_CLIENT` 4) and in total (`API_STREAMS_TOTAL` 2 000), concurrent `/observations` reads per client (`API_READS_PER_CLIENT` 4; extra reads wait up to 5 s, then 429) and overall (`API_READ_SLOTS` 8, 503 after 5 s). A client is an IPv4 address or an IPv6 /64. The client address comes from `X-Forwarded-For` only through `TRUSTED_PROXIES`, walked right to left (D-014, D-059).

**Database pools.** API requests and ingest use separate connection pools, so readers can never take the connections the writer needs: `DB_API_CONNS` (default 12) serves every API request, health check and, in API-only mode, the encoding backfill; `DB_INGEST_CONNS` (default 6) serves the writer, the database dedupe fallback, `also_via` updates, identity reloads and the startup re-decode and backfill jobs, which hold one connection at a time. Each `/observations` read holds an API connection while it streams, so `API_READ_SLOTS` must be at most `DB_API_CONNS − 2`, leaving room for health checks, node keys, trends and capabilities; startup fails readably otherwise. Size `DB_API_CONNS` as read slots plus a few, `DB_INGEST_CONNS` as about the worker count when Redis may be down (each worker can wait on a dedupe lookup), and keep their sum, plus 2 for the maintenance process, under PostgreSQL's `max_connections` (D-115).

## 5 The browser engine

### 5.1 Structure

Views are derived in the browser (D-031). A Web Worker (`frontend/src/derive/`) owns the window's rows and drives a Rust engine compiled to WebAssembly (`frontend/engine`; serde, serde_json, wasm-bindgen; about 1.1 MB, 322 kB gzipped) (D-040). The server-built views, their Go link-graph and estimator code and the Redis result cache were retired once the engine matched them field by field on recorded live data; that recording is the golden fixture (D-041).

- **Rows never become JavaScript objects.** The worker stages each raw `/observations` page in the engine (staged batches can still be discarded by a fresh start), merges streamed rows as JSON text, and gets views back as UTF-8 bytes (`view_bytes`) that are transferred to the page and decoded once (D-083). Strings are interned and packet keys stored as integers.
- **Sync:** after a range's first page, the rest is split into four time slices fetched in parallel (D-040). A rolling window fetches only rows since the last sync, with a 2-minute overlap for late commits; a fixed window that overlaps what is held fetches only the missing ends. Rows more than 8 days older than the newest window are dropped, and the copy is capped at 750 000 rows. Live rows that arrive before the first sync are held and merged after it. Streamed rows do not advance the coverage mark, so a gap-filling sync (once a minute on a heartbeat, at once after a reconnect or a `lagged` status) fetches anything the stream missed (D-033).
- **Live merges append** in place when rows belong at the end; an out-of-order batch is a two-run merge (D-039).
- **One snapshot per rebuild:** a rolling window built in the browser ends just after the newest row held (or at the last sync, if later). Each view request carries the page's data revision, and the end is fixed by the first request of that revision: rows keep merging as they stream in, so this is what makes all views requested in one rebuild get the same window and share one memoised snapshot (D-039).
- **Persistence:** IndexedDB (database `meshmap-derive`, version 3) holds closed or back-filled hours as one gzip chunk each in the API row format, and the open hour as append-only deltas (rows since the last flush, 10-minute overlap) compacted when the hour closes, after 60 deltas or on the next load. The coverage record is written after the rows it describes, so a reload never believes it holds rows it does not. Writes are batched (2 s quiet, 5 s at most); large fetches, trims and resets flush at once (D-058). A reload therefore fetches only new rows, and offline the window is built from what is held. The copy is tied to both the server's generation and the engine build that wrote it (its content-hashed WebAssembly URL): rows are stored as that engine re-exports them, so a copy from another build, which may lack fields the new engine reads, is cleared and the window fetched afresh. Without this, a page still running an old build when the server's row format changed saved rows without the new fields under the new generation, and the next build trusted them (D-102).
- **Worker memo:** views are memoised per revision, older revisions dropped, capped at 24 MB of view bytes (D-045).
- **Failure is visible:** an engine that fails to start fails every view with the reason instead of leaving "Loading window…". A WebAssembly trap or worker script error restarts the worker, which syncs again; more than three restarts a minute stops retrying (D-083). Worker failures are typed (`not_found`, `bad_request`, `unavailable`, `upstream`, `internal`); a view's `meta` holds `window` and `data_until` (the newest instant the copy covers) (D-058).
- View types are hand-written in `src/derive/views.ts`; a type-checked test fits the golden output to them (D-058, D-083).

### 5.2 Views

| View | Argument | Contents |
| --- | --- | --- |
| `snapshot` | — | Nodes (identity, position, estimate, refined position, track, flags, counts), links (directed edges with evidence, statistics, confidence, 0-cost), MQTT edges, counts. At most 5 000 nodes and 20 000 radio edges (MQTT edges come on top; 0-cost, relaying, estimates and the link count use the kept radio edges). |
| `traffic` | — | Distinct packets and receptions per time bucket (§6.16). |
| `node` | node id | The node panel's data (§7.8). |
| `packetlog` | node id | Its own and relayed packets (§6.14). |
| `route` | packet key | One packet's routing graph (§6.15). |
| `reach` | node id, `|internet` | Simulated reach by hop limit (§6.8). |
| `health` | — | Known issues and the airtime estimate (§6.17). |
| `link` | `a|b` node ids | One link's measured readings over time, per direction (D-105). |
| transmissions | live rows | Ping attribution (§7.7). |

Engine rules that changed behaviour after the server views were frozen are options (`silent_rule`, `mqtt_links`, `move_rule`), all on by default and switched off only to compare with the retired server views in the first golden test (D-055, D-073).

### 5.3 Live rebuild cadence

Streamed rows reach the worker at once; views are rebuilt debounced. Rebuilds wait for the stream to pause for 2 s (at most 5 s) on rolling windows up to 6 h, 10 s (at most 15 s) from 24 h, linearly in between; fixed windows use 2 s / 5 s. The delays are at least 20× (quiet) and 30× (ceiling) the last snapshot build, so rebuilds stay around 5 % of the worker's time however large the window grows (D-058, D-083). Live-window React Query entries use `gcTime` 0, keeping only the previous view as a placeholder; fixed windows keep 5 minutes (D-058). Pings never wait for a rebuild.

## 6 Derived mesh model

Everything in this section is computed by the engine from the window's rows, after filters (§7.8). The link graph is directed and weighted; it is never stored.

### 6.1 Nodes

- **Heard** nodes sent something in the window or uplinked as a gateway. **Only named** (referenced) nodes appear only in others' NeighborInfo or traceroutes; they are coloured by when they were last named (`last_referenced`) (D-087).
- **Identity** is the latest in-window NodeInfo, else the latest named map report (§2.5). Without either, the node shows the last four hex digits of its id. NodeInfo rows marked with a key conflict are skipped.
- **Gateway** (`is_gateway`): the node uplinked a reception in the window.
- **Counts per node:** distinct packets it sent; receptions of them by other gateways and its own uplinks, kept apart (map reports count as own uplinks); signatures counted once per packet by its best copy's status (D-087).

### 6.2 Link evidence

Each sample is directed, transmitter → receiver, and kept per direction (D-015):

- **NeighborInfo** (observation): an entry "A hears B" is `B → A` with the reported float SNR. One sample per logical NeighborInfo packet however many gateways uplinked it. No reverse link is inferred.
- **Traceroute** (observation): each receiver appends its SNR (and itself unless it is the endpoint), so `snr[k]` is measured at the receiver of segment *k* of `[origin, route…]`; a trailing extra SNR adds the final segment to the endpoint. Requests run forward from `from`; replies have a forward path `to → route → from` and a return path `from → route_back → to`. Placeholder hops break the path. There is never an origin–destination shortcut. A segment's key is the path up to and including it with its SNRs, not the packet, so a reply that repeats its request's route and the partial copies of one traceroute count each hop once (D-087).
- **Direct reception** (observation): a `direct_rf` reception (§2.2) is `source → gateway`, with the gateway's SNR and RSSI.
- **Relay hint** (pointer, not observation): a relayed RF reception with RSSI/SNR whose last-hop byte resolves to exactly one node R (§6.3) is `R → gateway`, low confidence and inferred.

RSSI comes only from gateway receptions. A packet uplinked by MQTT without demonstrable RF reception never creates an RF link. Evidence from before either end's latest move is dropped first (§6.11).

### 6.3 Relay-byte resolution

`MeshPacket.relay_node` is only the last byte of a node number, so collisions are expected; but only nodes within radio range of the gateway can be the last hop. One resolver (`RelayContext::resolve`, `frontend/engine/src/graph.rs`) serves links, packet logs, routes, reliability and ping attribution alike (D-024, D-039):

1. Candidates: window nodes with that last byte, other than the originator and the gateway, and never a node whose role never rebroadcasts (CLIENT_MUTE) (D-040).
2. **Range:** drop candidates whose reported in-window position is farther from the gateway than the longest confirmed link in the window × 1.25, at least 50 km. Unpositioned candidates stay, because they cannot be ruled out; estimates are never used.
3. **Confirmed links:** if several remain, the single candidate with NeighborInfo, traceroute or direct evidence to the gateway wins. Relay-hint evidence never counts, so inferences cannot reinforce themselves.
4. Otherwise unresolved: no link, counted as ambiguous or unmatched.

A last-hop byte equal to the uplinking gateway's own low byte is the gateway itself and is ignored everywhere (D-036). A byte resolved only because one candidate already had a link to the gateway adds nothing to that same link: no circular corroboration (D-087). Against traceroute ground truth (378 copies, 72 h), narrowing raised correct resolutions from 87 to 355 with none wrong.

### 6.4 Link confidence and statistics

Confidence counts evidence, not only its kind (D-087):

- **High:** observed at least 3 times (`HIGH_OBSERVATIONS`), or observed in more than one way (NeighborInfo, traceroute hops, direct receptions).
- **Medium:** observed once or twice.
- **Low (inferred):** only relay-byte hints.

Each direction carries its evidence counts, a plain-words reason (shown as a tooltip), sample count, first and last time, and SNR and RSSI statistics (median, min, max, last, n) kept separate, never averaged into a "signal strength". Repeated uploads of one RF event never raise confidence, since samples are per logical packet or per reception, not per broker. Links expire at the window boundary, not after an invisible "recently heard" time.

### 6.5 Internet links and MQTT downlinks

A gateway with MQTT downlink enabled takes packets from the broker and transmits them; such packets carry `via_mqtt`, which gateways never uplink, so the flag never reaches us. They are found indirectly:

- **Downlinker:** traceroutes record the SNR each hop was received at, and a packet taken from MQTT has no radio reception, so it reads exactly 0 dB. Genuine readings round to 0 dB too (1–11 % of a node's traceroutes in seven days of data), while the known downlinking gateways were at 52–79 %. A node is a probable downlinker when at least 3 distinct in-window traceroutes reached it at exactly 0 dB, making up at least 25 % of those recording an SNR at it (`DOWNLINK_MIN`, `DOWNLINK_SHARE`). Being a gateway is not required. The node view reports the evidence as `mqtt_downlink {zero_snr, traceroutes}` (D-054).
- **Internet links:** a traceroute hop recorded at exactly 0 dB into a probable downlinker is an MQTT hop. Tying the rule to the downlinking node keeps stray genuine 0 dB readings radio and keeps the links consistent with the downlink arrows. These samples are split out before relay resolution; MQTT edges (`mqtt: true`) carry no SNR/RSSI statistics, say why in `reason`, and are excluded from estimates, relay resolution, the link count and the radio layers. A pair can have both a radio and an MQTT edge (D-055).
- **Downlinked copies:** a copy the gateway received flagged `via_mqtt` was transmitted by a downlinker that took it from MQTT. Firmware sends such packets with no hops left, so the gateway heard it straight from the last hop. The flag, not the hop limit, identifies them: a relayed copy with hop limit 0 and no flag is ordinary radio (the last relay spent the final hop). Packet routes draw origin → last hop dotted green and last hop → gateway as radio; packet-log hop counts leave such copies out and flag them "MQTT"; pings show only the last hop's transmission. Since gateways do not normally uplink flagged packets, such copies are rare (none in the current data) (D-087, D-088).

### 6.6 Gateways that uplink every copy

Today's firmware uplinks only the first copy a gateway hears; a future option uplinks every copy, each with its own last hop (and, for traceroutes, partial route). Storage already keeps such copies apart (§2.6). A gateway that reported more than one copy of the same packet for at least 3 packets in the window (`MULTI_UPLINK_MIN_PACKETS`), leaving out its own packets, map reports and copies via MQTT or non-RF, is flagged `multi_uplink`; an odd retry does not flag it. Every extra copy is already a radio sample for links, a hop for routes and a receiver for pings, and makes router reliability (§6.9) closer to the true rate (D-084).

### 6.7 0-cost links

Firmware (`Router::shouldDecrementHopLimit`) lets a ROUTER, ROUTER_LATE or CLIENT_BASE relay without spending a hop when the copy it heard came from one of its favourites that has one of those roles. The first hop, heard from the originator, always costs one. Favourites are one node's setting about another, so this is directional (D-068).

- **Evidence:** per packet, gateways report the hop limit each transmitter sent (the originator's for direct receptions, the resolved relay's for rebroadcasts). Packet copies are grouped once per snapshot with the transmitter each copy was heard from (`copies.rs`), shared with reliability (D-083). For a relay R and a transmitter U that R hears, R sending the same hop limit as U is a free hop for U → R; one less is a spent one. A packet counts only when exactly one transmitter R hears explains its value, and never when U is the originator. Transmitters with conflicting values in one packet are left out, as are pairs where a known role rules the rule out.
- **Threshold:** `zero_cost.likely` needs at least 3 free packets (`MIN_FREE`) making up at least 80 % of the evidence (`MIN_SHARE`), since a transmitter no gateway heard can mislead single packets. Edges carry `zero_cost {free, spent, likely}` whenever there is evidence.

### 6.8 Reach

When a node is selected, the Reach section of its panel simulates how far its packets get at each hop limit (D-069):

- A packet leaves with hop limit H. Nodes that hear the originator receive it with H left. A node relays only what it received with more than 0 left, spending a hop, except across a likely 0-cost link (§6.7); the first hop always costs. CLIENT_MUTE never relays. A shortest-path search over directed links (the receiving end heard the transmitting end) gives each node the smallest H that reaches it and the transmitter it hears it from. Inferred links stay out, as guesses; internet links stay out unless "Count internet links" is on.
- The slider runs 0–7 (`MAX_HOPS`), starting at the hop limit the node's own packets used. The panel shows the nodes reached, how many each step adds, and how many came through 0-cost links.
- "Show on the map" replaces the links with the reach paths up to the chosen limit, coloured by hop, and dims unreached nodes. A placed node is drawn from the nearest placed transmitter up its chain, dashed where unplaced relays were skipped. A new selection or a packet route clears it.
- The panel states the caveat: only links observed in the window count, intermittent links count as always there and unseen links are missing, so it sketches the mesh as observed rather than predicting coverage.

### 6.9 Router relaying

For each ROUTER and ROUTER_LATE, how often it is seen relaying what it should relay (D-078):

- **Expected:** a router rebroadcasts every packet it receives with hops left. It received a packet when it uplinked it itself as a gateway with hops left, or when a transmitter it hears on a high-confidence link (3 samples or more) sent it with hops left. Its own packets and packets addressed to it do not count.
- **Seen:** a gateway reports a copy whose last-hop byte resolves to it, or a traceroute lists it.
- **Observability:** a packet counts only where a witness (a gateway that hears the router directly, medium or high confidence) uplinked it at all. Gateways uplink only the first copy they hear, so the router's rebroadcast stays unseen whenever another copy reached the witness first. The share is a lower bound, comparable between routers of the same role and coverage, not an absolute reliability; ROUTER_LATE's copies are often second by design.
- **Shown:** seen of expected ("packets it probably received") and the share, the median for routers of its role when at least 3 have 10 or more expected packets, its witnesses, and how much rests on its own uplinks. Under 10 expected packets (`MIN_EXPECTED`) it says too few to judge, and no share is shown when nearly all receptions are inferred (D-087).

### 6.10 Positions

- **Reported positions** come from Position packets and map reports in the window; both feed every position consumer (latest position, history, anchors, movement). When a node has both, its latest Position and latest map report are compared: if their precision circles (worst-case error for each one's precision bits) overlap they agree and the more precise one is used (the newer on a tie); if not, or when either precision is unknown, the newer one is used. The chosen position reports its `source` (D-032).
- **Stale positions (D-094):** when a node's newest position report (Position packet or map report) is more than 24 h older than the window's latest observation (`STALE_POSITION_MS`), its reported position is stale: it is no anchor, plays no part in relay range checks, and the node is estimated like an unpositioned one (§6.12). When no estimate can be made, the node is left off the map (listed under "Without position"): a marker at an old place would draw misleading links. Either way it is reported as `stale_position`, and Details says the position is stale, with its time. The window's latest observation, not the clock, is the reference, so historical windows judge staleness within themselves.
- **Precision error** is half the diagonal of the reported precision cell (firmware reports the cell's centre): about 0.8 km at 15 bits at 63°N, 0 at 32 bits. It is shown as ± distance; altitude is above sea level.
- **Narrowing noisy positions (anchored nodes):** with at least 5 reports (one per packet) in the window, a node is anchored when its most reported place and the reports near it (within the move threshold, §6.11) hold at least half of its reports and at least two of its latest three, so it is home now. Precise readings (24 bits and finer) are averaged, with an error from their spread; for truncated cells, the most reported cell among the agreeing reports at the node's finest precision is chosen (ties: the latest); the latest report wins only when it is finer. The result is reported (`refined`) only when it narrows the position or sets reports aside; the map places the node there, the selected node's accuracy circle uses its error, it feeds relay range checks and estimates, and the panel says "Narrowed to … from N of M reports; K outlying ones set aside as noise" (D-077).
- **Never finer than shared.** Positions shared with reduced precision keep it: narrowing is never finer than the node's own finest report in the window, and no route (narrowing, estimates, combining sources) raises a node's effective public precision. Nodes coarser than the anchor threshold are never anchors (D-077).

### 6.11 Movement, trails and airborne nodes

- **Moving:** a node's reported positions in time order, one point per distinct place. Drift is measured from where the node last settled, so slow movers' short steps add up; it moved when the distance exceeds 300 m (`MOVE_M`) plus 1.5 times both positions' worst-case precision error, because a 13-bit position can jump a whole cell while the node stands still. Each move makes that position the new reference, and the latest move is `moved_at`. Movement is judged on the node's finest positions with at least two distinct places, so precise Position packets are not held to coarse map reports' threshold. An anchored node (§6.10) does not count as moving; for others, a single reading far from the ones either side (which agree) is a GPS spike, and an excursion needs two reports (D-073, D-077).
- **Links reset after a move:** radio evidence (NeighborInfo, traceroute hops, direct and relayed receptions) from before either end's latest move is dropped before links are built, so relay resolution and estimates use only current links too (D-073).
- **Trails:** moving nodes carry `track` (up to 100 points, `MAX_TRACK`). The map draws the last three places before the marker, fading towards the oldest, with chevrons pointing the way it is going ("Position trails", off by default; with a node selected, only its trail). The full track stays in the data for packet routes. The panel says when it last moved (D-073).
- **Airborne:** reported altitude above 750 m (`AIRBORNE_M`) **and** moving. Altitude alone would flag fixed mountain sites; noisy GPS alone would flag stationary nodes. The badge is an airplane at the marker's upper right (D-073).

### 6.12 Location estimates

An estimate is "somewhere around here", never GPS (D-016, D-025):

- **Targets:** nodes without an in-window reported position (coarse public positions are never refined). **Anchors:** in-window positions with known precision ≥ `GEOLOCATION_MIN_PRECISION_BITS` (default 15, the common coarse public setting), not in `GEOLOCATION_EXCLUDE_NODE_IDS` (excluded nodes are neither anchors nor targets). **Measurements:** links with NeighborInfo, traceroute or direct evidence; relay-only and internet links are excluded.
- **Gates:** ≥ 3 anchors, ≥ 5 samples, pairwise spacing ≥ 200 m, spread ≥ 500 m, minor/major axis ratio ≥ 0.2 (non-collinear); anchors more than 150 km from the median are dropped as outliers.
- **Uncalibrated (default):** SNR-weighted centroid of the anchors, `quality: very_low`, radius max(mean anchor distance, 2 km).
- **Calibrated** (`GEOLOCATION_CALIBRATION` YAML with `default: {p0_dbm, path_loss_exponent}`): Levenberg–Marquardt on log-distance ranges from RSSI with Huber weights; uncertainty from max(observed misfit, 6 dB) shadowing propagated through the model, floor 500 m; `quality: low`. In simulation (4 anchors, 4 dB shadowing) every placement fell within twice the reported radius.
- The largest anchor's precision error is added in full to the radius (worst case: every anchor shifted the same way), and the reasons say so. Coordinates are rounded to 0.001° and radii to 100 m. Every unpositioned node without an estimate carries an `estimate_note` explaining why (e.g. "no confirmed direct links to nodes reporting a position with at least 15-bit precision").
- Estimates are recomputed for every window and rebuild; settings come from `capabilities.geolocation` so the browser applies the operator's rules (D-031).

### 6.13 Channels, regions and presets

- **Region from the topic** (D-044): the segment after `msh`. Norway's `msh/EU_868/NO/...` allows either EU_868 or EU_N_868; other roots name one region. A node's summary keeps only regions every topic it was heard under allows, since everything on a radio link shares frequency settings; contradictions are reported. A node's own map report states its region exactly and is shown first.
- **Channels** (D-064): a gateway uplinks a reception under the name of its own channel whose hash the packet carried, so each reception names a channel the sender transmitted on (`sent`, distinct packets) and one the gateway has (`uplinked`). A map report names the node's primary channel. The panel lists channels, primary first.
- **Radio groups:** nodes that hear each other share modem settings. Direct receptions, NeighborInfo entries and traceroute hops join nodes into groups; relay bytes and 0 dB traceroute hops do not.
- **Preset, strongest evidence first:** the node's own map report, but only when `has_default_channel` confirms a preset is in use (firmware fills `modem_preset` even with `use_preset` off, and LONG_FAST is the zero value) (D-063); confirmed reports of its radio group (all agreeing, otherwise "conflict" with presets and counts); a channel it was heard on with a preset's default name (LongFast, NarrowFast, …, case-insensitive); the default channel names most of its group was heard on. The last two are hints, since a secondary channel can carry such a name. The panel separates direct radio contacts from the whole group and names the nodes the evidence rests on (D-064, D-087).

### 6.14 Packet logs

The selected node's panel lists its packets, built from the window's filtered rows (D-036): one combined log, newest first, up to 200 own and 200 relayed entries (`MAX_LOG`), 50 shown at first, with an "Include relayed" toggle (off by default).

- **Traceroute replies replayed (D-106):** a reply carries its request's id and records the way the request travelled (requester → route → target, with the SNR at each receiver). When a reply arrives live, that forward route animates as the request's transmissions. Every transmission names its packet as origin and id, so a replay is skipped when the request itself was already animated, and a late live copy of the request is skipped after its replay, within two minutes. Hops into a probable downlinker at exactly 0 dB went over the internet and are not animated.
- **Delivery (D-096):** an ACK proves its sender received the packet it answers, by whatever path. The packet's route gains a dashed mint "delivered" segment from its origin to each node that acknowledged it (unless a hop between them is already drawn), and the route note names them. A live ACK animates as a delivery: a mint line travelling from the original sender to the acknowledging node, which flashes twice on arrival; it is no radio transmission, so it draws no ring. Errors prove nothing and are not animated.
- **Delivery by recipient (D-109):** rows carry whether the sender asked for an acknowledgement (`wa`, row format 8). The Packets tab counts, per recipient, the node's direct packets that asked: how many were confirmed (with the share) by an ACK or by the recipient's reply (traceroutes ask for an ACK but are answered with their reply), answered with an error instead, and ACKed only after a retry (several ACKs for one packet). Only packets and ACKs a gateway reported count, so the numbers are lower bounds and a blank never means lost.
- **Delivery reports (D-092):** routing packets carry their outcome in rows (`rt`: ACK or error with the firmware reason, and the id of the packet answered). A routing packet is addressed to the original's sender and carries its packet id; an error can come from a relay, so the answering node need not be the original's destination. Own packets show ✓ (ACKs only) or ✗ (an error) in a Re column, with who answered and how often (a retrying sender gets each copy answered); a blank never means lost, since an ACK may reach no gateway. Routing packets show ✓ ACK or ✗ reason, in plain words, with ↩ to the answered packet when it is in the window. Routing packets and encrypted direct messages addressed to the node are listed as "to it". Details sums them up as "Delivery reports": ACKs and errors by reason, sent and received.
- **Own packets:** one entry per logical packet: time, type, destination, fewest hops any gateway saw, gateways, signature. Hops and gateways leave out its own uplink ("self" when only it uplinked); downlinked copies are left out of hop counts and flagged "MQTT" (D-087).
- **Relayed for others:** other nodes' packets it passed on, where a gateway's last-hop byte resolved to it (§6.3) or a traceroute's recorded route lists it. The uplinking gateway appends itself to the route it reports; that trailing entry only received the copy and is not counted.

### 6.15 Packet routes

Selecting a packet in the log draws its routing graph from every in-window reception of it (rows sharing its logical key), as directed transmitter → receiver segments (D-037):

- **Traceroute:** the recorded route, with the gateway appended unless it recorded itself.
- **Zero-hop reception:** sender → gateway.
- **Resolved relay:** relay → gateway, and sender → relay, solid only when one hop was spent by a relay whose known role cannot receive at zero cost (the ping rule, §7.7).
- **Unresolved relay byte:** sender → gateway, dashed.
- **Downlinked parts:** dotted green, "internet" (§6.5).
- Packets the sender uplinked itself and MQTT or non-radio transports add nothing.

A segment is **solid** when both nodes are known to be adjacent and **dashed** when nodes between them are missing (an unrecorded hop, an unknown relay, the unknown path from the sender to a relay); a solid segment wins over a dashed one, and hover says which case it is. Unplaced nodes are bridged: each placed node joins the nearest placed node before it in the route, dashed across those skipped, and the route note names the nodes without a position. A route carries when the packet was first heard (`at`); nodes that have moved since are drawn where they were then, with a ring there and a dashed line to their marker now (D-073). All links are hidden while a route is shown, and the map frames it once.

### 6.16 Traffic and counts

- **Traffic buckets:** distinct packets and gateway receptions per bucket, the bucket chosen from a fixed ladder (1 min, 5 min, 15 min, 1 h, 6 h) to stay within 600 buckets. Several gateways hearing one packet never inflate packet counts.
- **Header counters:** nodes heard, only named, positioned (reported in the window), estimated, links (node pairs, as drawn, whatever the link filters show), distinct packets and receptions; each has a tooltip saying what it counts (D-087).

### 6.17 Mesh health and airtime

Rules over the window's rows and snapshot flag known problems per node (`health` view, `engine/src/health.rs`, D-095). Each issue has a severity (problem, warning, notice), a one-line summary and an explanation. Rates use the span the rows cover when shorter than the window. Thresholds are constants in that file:

- **Traceroute flooding:** ≥ 4 requests/h and ≥ 10 in the window (warning), ≥ 10/h (problem).
- **Large airtime share:** its packets with their rebroadcasts cause ≥ 10 % of the estimated airtime (warning).
- **Busy channel:** reported channel utilisation ≥ 25 % (warning), ≥ 40 % (problem); transmit airtime ≥ 10 %, the EU hourly duty cycle (warning).
- **MQTT downlink:** a probable downlinker (§6.5) (warning).
- **Different preset than the mesh:** the mesh's preset is the one most rows' default channel names imply; a node heard only on another preset's channel, or confirming another in its map report (warning).
- **Hop limit higher than needed:** a hop limit of 6 or 7 at least 3 above the hops within which gateways heard 95 % of its packets (≥ 20 packets). Gateways are only part of the mesh, so this is a notice with a suggested limit.
- **Possible impersonation (D-108):** 3 or more packets claiming to come from a node that failed signature or key checks (`invalid` rows with a verification reason; decoding failures do not count), a warning naming the reasons and how many gateways reported them. When all of them announce a different key than the trusted one, the explanation says the node was most likely reset and has a new key.
- **Battery falling (D-099):** a least-squares trend over at least 8 device reports spanning at least a day, falling 5 % a day or faster; a warning at 50 % or below or when empty within a week at that rate, else a notice. The daily swing of a healthy solar node stays well under that.
- **Restarts (D-099):** uptime going backwards between reports, beyond what the time between them explains; a notice, a warning from 3 restarts. Constant zero uptime is not a restart.
- **Notices:** no other gateway reports it (≥ 10 packets, only its own uplinks); remote-admin requests refused by ≥ 2 nodes; uplinks arriving unencrypted; positions > 4/h (not when moving), NodeInfo > 1/h or device telemetry > 4/h; a stale position (§6.10); battery ≤ 15 %; a short name shared with another node.

**Airtime** is estimated per packet as one transmission by its sender plus one per distinct relay seen (resolved last hops, traceroute routes), each costing its estimated on-air size (16-byte header, payload, Data wrapper when decoded, 66 bytes when signed) plus about 20 bytes' worth of preamble. Only shares are reported: of the window's total by packet type, and per node the share its packets cause and the share it transmitted itself (its own packets and relays). Relays no gateway heard are missed, so it is a lower bound and a guide to proportions.

**Store and forward (D-103)** gets its own breakdown: its share of the airtime, packets and share by message kind (heartbeats, replayed broadcasts and direct messages, history announcements, requests, …), and per router its share, heartbeats per hour and history replays with their text size. A router whose store-and-forward takes 2 % of the airtime or more gets a notice.

The **Health panel** lists every issue grouped by kind, most severe first, with node links and the explanation on hover, then airtime by packet type and the ten nodes causing the most. **Details** shows the node's issues under its name and its airtime as a row.

## 7 Map and user interface

### 7.1 Layout

UI chrome floats over the map, which runs edge to edge and never resizes (checked in e2e) (D-029).

- **Header island** (top left): the wordmark, the live indicator (LIVE, LIVE (paused) or HISTORICAL with the window's length, and an updating spinner) on one line, the counters below; on phones the counters are hidden. It is a rounded card with the islands' border, blur and shadow. Its height is published as `--head-h`; MapLibre's zoom buttons, the fit control and banners sit below it, stacked above its shadow, and camera framing keeps content clear of it. Until the first snapshot arrives each counter shows a faint placeholder bar about as wide as a typical value (tabular figures), so the card keeps its size (D-082). Clicking the live indicator opens the Period panel; "Return to live" sits beside it while a fixed window is shown (D-067).
- **Trends** (D-104): the Trends panel, in the rail after Health: Daily, Weekly or Monthly bars for nodes heard (new ones highlighted), gateways, packets and receptions, packets by type over the whole period, and a table of every bucket, newest first, from `/api/v1/trends` in the viewer's time zone. It ignores the window and filters.
- **Tool rail** (right edge; on phones and narrow tablets, up to 820 px, a horizontal bar along the bottom edge with the same tools left to right, scrolling sideways when they don't fit; an end with more tools beyond it fades out under an arrow that scrolls to them, D-132): Nodes, Details, Health, Trends, Period, Filters, Layers, Legend, Settings. Icons carry short labels, which narrow screens drop (kept as accessible names and tooltips). The Filters button shows how many filters differ from the defaults (D-066, D-067); the Health button, how many problems and warnings the window has (D-095). The open panel can be resized by dragging its left edge (or arrow keys on that handle; double-click resets to 380 px), between 300 px and 900 px while leaving the map at least 220 px; the width is remembered in the browser. On phones the panel spans the width and has no handle (D-097).
- **Panel:** one at a time, docked beside the rail; its header names and closes it. Pressing the open panel's button again or Escape (unless typing) closes it. It is as tall as its content up to the bottom margin, scrolling inside past that; on phones it spans the width and sits on the bottom rail, its bottom edge on the rail's top edge, growing upwards to below the header, over the map controls (D-066, D-071, D-132).
- **Islands:** the rail and panel are translucent, blurred rounded cards inset 10 px from the map's edges (8 px on phones) (D-071). Two elevation tokens are the only drop shadows, `--elev-island` and `--elev-float` (banners, tooltips, map controls); labels on the map stay flat (D-081).
- **Map controls:** zoom, "Fit to data" and "Reset north" (icon buttons in a group under the zoom buttons; mouse drag never rotates the map, but a two-finger twist or Shift+arrow keys do, and the needle shows the bearing), scale bar, a coordinate readout on hover and the credits. The coordinates and credits stay in the bottom-right corner whatever opens; a panel may partly cover them (D-082). On phones they and the scale bar sit just above the bottom rail (D-132). Banners and camera framing keep clear of the open panel, telling the side panel from the phone panel by width; on phones, framing keeps clear of the bottom rail and places content above the panel when at least 160 px of map remain between it and the header, and banners lie beneath an open panel (D-071).

### 7.2 Basemap and layers

- **Basemap:** OpenMapTiles-schema vector tiles from a self-hosted PMTiles archive by default (basemap.md), dark and light styles with the same layers. MapLibre GL is pinned to 5.x: 6.x stops painting labels drawn after deck.gl's interleaved layers (D-017). MapLibre's attribution control is disabled and the required credits are static React text, so the vulnerable `DOM.sanitize()` of GHSA-jrc7-96c5-q579 is never called; the CSP is a second layer (D-019). Glyphs are Noto Sans Regular/Bold from the OpenMapTiles fonts release, one font per text stack (D-018).
- **Mesh layers** are interleaved beneath the basemap's label layers (`beforeId: labels-start`), so enabled names stay readable over nodes and links (D-018). Pings are a separate, non-interleaved overlay above everything (§7.7).
- **Layers panel, Mesh:** Router links, Client links, Internet links (all off by default) (D-047), Inferred links (on; modifies the router and client layers), Position accuracy (off), Node names (on), Position trails (off), Traffic (on, off under reduced motion). Names were chosen for plain language; code keeps internal names (`infraLinks`, `otherLinks`, `mqttLinks`) (D-062).
- **Layers panel, Map:** Borders, Major roads, Land cover and parks, Minor roads and rail, City and country names (on); Rivers and streams, Buildings, Local place names (villages, hamlets, suburbs, neighbourhoods), Peaks, Road names and numbers, Water names (off). Towns count as cities because OpenStreetMap classes most Norwegian cities as towns; the tiles carry no county names. Water and background are always drawn (D-022, D-083).
- **Regions (landsdeler)**, off by default: Nord-Norge (Nordland, Troms, Finnmark), Trøndelag, Vestlandet (Rogaland, Vestland, Møre og Romsdal), Østlandet (Oslo, Akershus, Østfold, Buskerud, Vestfold, Telemark, Innlandet) and Sørlandet (Agder), following Store norske leksikon and Wikipedia; the regions have no formal status, and moving a county is one line in `scripts/regions.js`. Kartverket's 2024 county boundaries (CC BY 4.0) are dissolved by `scripts/regions.sh` into `frontend/src/assets/regions.geojson`, fetched only once the layer is on. Each region is an unfilled outline drawn inset inside its own region (neighbours' borders run side by side), beneath everything and not pickable; names sit at hand-picked inland points and give way to node names from zoom 9. "© Kartverket" joins the credits while it is on (D-061).
- Every switch has a tooltip explaining its data. Choices and the theme are a per-viewer convenience in `localStorage` (`meshmap:toggles:v6`, bumped whenever defaults change; wrapped in try/catch, defaults apply without storage). The style is patched with the saved visibility before the map is created, so hidden layers never flash (D-022).

### 7.3 Node markers

- **Size by role:** ROUTER and ROUTER_LATE 8 px radius, CLIENT_BASE 6.5 px, any other or no role 5 px (D-021).
- **Colour by last heard:** the time between the node's last activity (or last mention, for referenced nodes) and the window's end, as a fraction of the window on a **logarithmic scale** with a 10-minute knee, so recent activity is spread out: in a 3-day window the stops fall near 0, 35 min, 3.3 h, 16 h and 72 h (D-087). **One ramp for both themes:** gold (226,152,0), orange (236,116,16), red (218,66,56), magenta (192,52,128), violet (130,68,190) at 0, ¼, ½, ¾ and 1. Lightness falls throughout, so it reads in order without colour vision; every stop has at least 3.2:1 contrast against the dark background and 2.1:1 against the light one. Against roads, water and land cover, the markers' dark outline and the estimated rings' dark halo carry the separation (D-085). The legend labels the stops in the current window's minutes, hours or days. Node list dots use the same colour (D-021).
- **Kinds:** filled marker for a reported (or narrowed) position; hollow ring in its last-heard colour, name in purple, for an estimate; no marker for unpositioned nodes, which are listed under "Without position" in the Nodes panel.
- **Gateways** have a blue ring; the selected node a white (dark in light theme) outline. Nodes that opted out of MQTT uplink have a permanent red ring (D-032).
- **Uplink glyph inside the marker:** ↑ a gateway that uplinks the first copy of each packet; a double chevron a gateway that uplinks every copy (§6.6). **Downlink arrow beside the marker:** a small ↓ at the lower right for a probable downlinker (§6.5), with either uplink glyph or none. There is no combined glyph: at client marker size an uplink and a downlink shape blur together, and enlarging markers would break the role-size rule (D-054, D-084). The airplane badge sits at the upper right (D-073).
- **Glyph drawing:** tinted icons drawn once onto a canvas atlas (font arrows vary between systems, and the CSP rejects `data:` icon URLs for deck.gl's fetches). The ink inside a marker is chosen by WCAG luminance (dark above 18 %), giving at least 4:1 at every age; hollow markers use the ring's colour (D-054, D-085).
- **Stacking:** markers without glyphs are drawn first, glyph nodes after them, so a plain node at the same spot never covers a gateway's glyph (D-084). Where glyph nodes overlap other markers, stacking levels computed from screen positions at the current zoom redraw higher markers above lower levels' glyphs (`nodes-over-N`, not pickable), so a glyph never shows through the marker of a node drawn after it. Overlaps are found on a grid, linear in node count, and recomputed on zoom changes (D-072).

### 7.4 Links on the map

- **One line per node pair.** Directed edges stay separate in the data and the panel; on the map a pair takes the better direction's confidence and is dashed only if every present direction is inferred. There are no arrowheads; direction is in hover text and the panel (D-021).
- **Classes:** router links (both ends announce ROUTER or ROUTER_LATE in the window) are 3 px bright blue; client links (any other combination, including no role) are 1.25 px grey-blue. Width never depends on sample count. Router links draw above client links (D-021).
- **Confidence** is opacity (high solid, medium fainter, low fainter still) plus dashes for inferred links.
- **Internet links** are dotted green, beneath the radio links, one per pair, in both themes. Their panel is titled "Internet link" with "Why internet", and says who passed what on (D-055, D-062, D-087).
- **0-cost:** a gold chevron on the link near the router that relays for free, pointing at it; a "0-cost" row in that direction of the link panel, ", 0-cost" in the hover text, and a legend entry (D-068).
- **Hover** names both ends by short name, one line per direction with confidence and sample count (the MQTT note on its own line), and says "hidden by the filters" rather than "no evidence" for a filtered direction (D-083, D-087). A selected link is drawn in the selection colour.
- **Level of detail:** below zoom 9 the best-supported 3 000 links (`LOW_ZOOM_LINKS`, by samples); from zoom 9 only links touching the viewport plus a 25 % margin. Counts and lists stay complete.

### 7.5 Selection and accuracy circles

- Clicking a node or link selects it and opens Details; clicking empty map clears the selection (D-027). Details **is** the selection: closing Details any way clears it, and a selection that opened Details closes it when cleared (D-066).
- A selected node shows only its own links, all of them, bypassing level of detail and viewport culling; clearing the selection restores the rest (D-026).
- With "Position accuracy" on, every estimated node shows its uncertainty circle while nothing is selected. A selected node shows only its own circle, whether the layer is on or not: its estimate's uncertainty, its narrowed error (§6.10), or for a coarse reported position its precision-cell error in a neutral colour (D-026, D-079).
- The map hands links, pings and the camera only the positions of markers actually drawn, so nothing points at a node that is not on screen (D-043).

### 7.6 Node names

Names (short name, full Unicode; else the last four hex digits) show from zoom 10 when "Node names" is on. Names whose label boxes would overlap are grouped into clusters (screen space, grid-bucketed). A collapsed cluster shows its most prominent node's name (routers first, then the busiest) plus "+N". It fans out while hovered (with a 400 ms grace period) or while one of its nodes is selected: names sit on the smallest ring on which no two boxes overlap, keep their markers' angular order, and have leader lines; clicking a fanned-out name selects that node. Hovering a clustered marker shows no tooltip; hovering a name shows its long name. Markers never move (D-035). Clustering runs only while names are shown (D-083).

### 7.7 Live pings

On a rolling window, each RF transmission attributable to a placed node is one expanding ring centred on the transmitter, growing until it encloses every placed node known to have heard that transmission directly; each receiver flashes as the ring reaches it, and a line grows from the transmitter to each direct receiver (D-023, D-042, D-053).

- **Attribution** (engine `transmissions`, the same relay resolver as links):
  - The originator always made the first broadcast (blue ring), keyed by logical packet and originator, so all copies share one ping.
  - `direct_rf` or hop count 0 (`hop_start − hop_limit`): the gateway heard the originator directly.
  - Otherwise the gateway heard a rebroadcast (amber ring) by the last hop, resolved from the relay byte; an unresolved byte attributes nothing.
  - Hop count 1 with a resolved relay whose known role is **not** ROUTER, ROUTER_LATE or CLIENT_BASE: that relay spent the only hop, so it heard the originator directly. With a 0-cost-capable or unknown role nothing is inferred (§6.7). A downlinked copy (§6.5) never makes the relay a receiver of the first broadcast.
  - Traceroutes use their recorded path: each adjacent pair of originator, route and gateway is one transmission heard directly, so every relay gets its own ring; unrecorded hops break the chain, and internet hops draw nothing.
  - A gateway uplinking its own packet, MQTT or non-radio receptions, or a transmission with no placed direct receiver, shows only a brief 1.5 s glow; a receiver arriving later grows a ring from it. Map reports never ping.
- **Timing:** grow 3 s (ease-out), linger 5 s, fade 2.5 s. Uploads of one packet arrive over several seconds (median spread 3.1 s, p90 8.8 s on `mqtt.868.no`), so a ping accepts receivers for its whole life (~10.5 s). A receiver outside the ring restarts growth from the current size and resets the linger; any new receiver revives a fading ring. Once a ping ends, late copies of that transmission do not ping again for 20 s. At most 80 pings run at once.
- **Waiting for upstream:** a transmission by X of packet P whose upstream ping lists X as a receiver stays hidden until that ring reaches X, then grows from nothing. Without upstream information it starts at once. A waiting ping starts no later than its own collection timeout, so after a pause it keeps its timing and mostly expires (D-028, D-048).
- **Drawing:** rings are sized in screen pixels, never smaller than 22 px, so co-located receivers stay visible. Rings have no outline; the fill (18 % at most) is a radial gradient in 16 bands: full at the transmitter, at each receiver's distance the opacity of its measured signal (gateway SNR −20…+10 dB, else RSSI −130…−70 dBm; 0.5 when unmeasured), transparent at the edge, never increasing outward (D-027). The line's head rides the ring's edge, so ring and line reach a receiver on the same frame; travelling it glows brightly, then settles thinner and fades with the ring (D-042).
- **Following the map:** each frame a ping looks up its transmitter and receivers among the markers drawn now; a moved receiver is followed, a vanished one dropped, and a ping whose transmitter is gone ends (D-043).
- **Only fresh traffic while painted:** pings are created only for rows handled while the page is visible and the packet is at most 10 s old by the server clock (offset from heartbeats). When the transmissions come back from the worker, they animate at once if a frame arrived within the last 2.5 s, else on the next frame if that comes while they are still under 10 s old: a slow frame on a busy machine delays a ping instead of losing it, and a covered window that gets no frames piles nothing up. Rows still reach the worker, so views stay complete; only the animation skips them, and a sleeping tab never resumes with a burst (D-034, D-048, D-113).
- **Own canvas:** pings live in a separate, non-interleaved deck.gl overlay covering the map, so animating them at 30 fps never redraws the basemap or mesh layers. The loop runs only while pings are alive; idle, it probes for a frame about once a second (D-083).
- Pings follow the Traffic switch, apply the filters, and are off under `prefers-reduced-motion`.

### 7.8 Panels

- **Nodes:** search by name or id (dimming non-matching nodes), positioned nodes and "Without position", each sorted by last heard with receptions by others shown (D-087). The search is cleared when the panel closes or another panel replaces it; picking a result opens Details and keeps the search (D-075).
- **Environment telemetry (D-099):** temperature, humidity and pressure travel in rows (`te`, row format 6).
- **Telemetry tab (D-100):** the node's latest device report (battery, voltage, channel use, own airtime, uptime) and environment readings, then one chart per metric with data: battery (0–100 %, external power noted instead), voltage, channel utilisation, own airtime, uptime, temperature, humidity (0–100 %) and pressure. Every chart spans the whole selected period, so charts line up and silences show as gaps (the line breaks where reports stop for more than 2 h or four times the usual interval); individual reports are dotted when there are few. Hovering or touching reads off the nearest report and its time; the value axis is labelled with its range, never negative for percentages and durations. Series keep one sample per packet, at most 500.
- **Details, node, layout (D-098):** the name with Share at its right, the id below it, then a line of tags (online or offline, gateway, downlink) and a compact health line (counts by severity, expanding to the issues) stay above five tabs: **Overview** (names, hardware, role, status text with earlier ones (D-103), identity, public key, position, movement, seen in window, traffic), **Links** (links in window, uplinked by gateways, reach, relaying), **Radio** (region, preset, channels, brokers, MQTT root topics, heard on), **Telemetry** (below) and **Packets** (airtime, delivery reports, signatures, packet log). The tabs are drawn as folder tabs without painting over the panel's translucent background: the baseline runs along the edges, gaps and inactive tabs, and the selected tab, with an accent top edge and no bottom border, opens into the content in exactly the panel's colour; inactive tabs carry a faint tint. Links and Packets show counts. The bar scrolls with the content (a sticky bar would need an opaque background) and sideways if a narrow panel cannot fit it; arrow keys move between tabs, and the chosen tab is kept when another node is selected.
- **Details, node:** id with a share button (§7.11); names and their source; hardware and role; public key (copyable, with when it was announced and whether it is the trusted key; a differing trusted key is shown with a warning; shown for opt-out nodes too) (D-089); position with precision (± distance), altitude and source, or the estimate with its reasons, or the narrowed position; movement; first and last heard; packets, receptions by others and own uplinks; brokers; for gateways, the MQTT root topic(s) from the topics of the rows it uplinked, busiest first with counts when there are several (D-090); signatures; region, channels and preset (§6.13); MQTT tags ("⏫ MQTT gateway, every copy", downlink evidence); relaying (§6.9); reach (§6.8); Links in window; Uplinked by gateways; the packet log (§6.14). Missing values say "not reported in selected period"; a node absent from the window shows "no data in the selected window".
- **Links in window:** one row per neighbour: its name and → on the first line, ← on the line below, aligned in one grid across the list. → the neighbour heard this node, ← this node heard the neighbour, each with confidence and median SNR, or "no evidence". Radio and internet links to one neighbour are separate rows. Sorted by the better direction's confidence, then median SNR, then name, internet links last; the heading counts neighbours. Clicking a row opens the link (D-086).
- **Uplinked by gateways:** gateways that heard the node, sorted the same way by the radio link from the node to the gateway, with a Link column showing that confidence (— when relayed only), and SNR and RSSI from direct receptions only, explained in column tooltips (D-086, D-087).
- **Details, link:** both directions with evidence types and counts, confidence and reason, sample count, SNR/RSSI statistics, time range, 0-cost evidence, and names when known in the window. Below them, **signal over time** (D-105): SNR and RSSI charts over the selected period with both directions as separate lines, from every measured reading of the link (each RF event once, as the statistics count them; at most 2,000 per direction). A selection remembers whether a radio or internet link was picked (D-055).
- **Period:** window length presets (1 h, 3 h, 6 h, 12 h, 24 h, 3 d, 7 d), start and end inputs in local time with the time-zone shown, ◀ slider ▶ to slide the window through retention (by half its length per step; the slider starts at the oldest observation), and the window's traffic strip (one bar per bucket, packets bright and receptions dim, with a key) (D-067, D-087).
- **Filters:** only nodes with reported positions; only online nodes, those heard within 3 h of the window's end (`ONLINE_MS`; nodes only named by others are offline), which Details marks as "● online" or "offline · last heard …" (D-101); link evidence types and minimum confidence (these change only what the map draws, not counts or details); packet types (including "map report", "direct message" and "encrypted" chips; `invalid` rows never pass), channel and broker (these restrict which observations count at all, for nodes, links, counts and details). A Reset appears when any filter is active (D-066, D-087).
- **Legend:** draws the actual marker sizes, glyph shapes, estimated rings, link classes and confidences, packet route styles (with direction chevrons), ping colours and signature badges, with the age ramp labelled for the current window (D-084, D-087).
- **Settings:** theme (Auto, Light, Dark), Install app when the browser offers it, links to the source code at the built commit, the licence and the privacy policy, the version (the short commit hash, linked to the commit; "development build" when the image was built without `SOURCE_REVISION`), and Reset (§7.14).

### 7.9 Period and live mode

The default is the server's default rolling window (72 h) in live mode. Choosing a preset keeps live mode; setting start or end, or sliding, switches to a fixed window, which never creeps forward. "Return to live" restores rolling mode. UTC is the internal representation; the UI shows local time with a visible zone and handles DST. Time controls, panels, counters and the traffic strip always reflect the same window. Rows that expire by retention during a session are dropped; an empty window shows a "no observed data" state. The live badge shows "paused" when the stream is down. Offline, a banner says "Offline: showing the data last received (time)".

### 7.10 Start view and camera

The map opens on mainland Norway's bounds (Lindesnes to Nordkapp, Utsira to Grense Jakobselv), padded clear of the header and tool rail, until the data arrives; then it zooms smoothly (1.2 s) to fit the drawn markers once, as "Fit to data" does, unless the view was moved meanwhile. The view (centre and zoom) is saved in the browser whenever the map stops moving and restored on the next visit; with a saved view there is no fit on load (D-111). Settings → Reset clears it with the rest. A permanent link to a node flies to that node instead. The box's centre lies over Sweden (Finnmark reaches 31°E), so the view keeps the zoom that fits the box but moves west towards 13.5°E as far as both ends of the country stay in view. The `DEFAULT_MAP_*` settings no longer set the start view. "Fit to data" fits the drawn markers again on demand (D-074). Fitting, flying to a node and framing a route keep content clear of the header and the open panel (D-082).

### 7.11 URL state and permanent links

The window, filters and selected node (`node=`) are in the URL, read before the first render so the first request is already for the right window; history entries are replaced, not pushed, so Back leaves the map (D-083). A **permanent node link** `/?node=!xxxxxxxx` carries the node alone, without window or filters, so it keeps working: opening it selects the node, opens Details and flies to it once placed; an id that is not `!` plus 8 hex digits is ignored. The panel's share button uses the phone's share sheet on touch devices, otherwise copies the link ("Link copied") (D-080).

### 7.12 Theming

Viewers choose Auto (follows the browser, the default), Light or Dark in Settings. `public/theme-boot.js` sets `data-theme` before the first paint, so there is no flash (a separate file, because the CSP blocks inline scripts). UI colours are CSS tokens with a light set. The light basemap style (`web/styles/light.json`, `MAP_STYLE_LIGHT_URL`) is generated from the dark one with the same layers, enforced by a unit test; a theme change copies its paint onto the live map instead of `setStyle`, which would drop the interleaved layers and visibility. Overlay colours come from a palette per theme (`map/palette.ts`); the age ramp, route and opt-out colours are the same in both (D-051, D-085).

### 7.13 Offline, caching and installation

- **HTTP caching (Caddy):** content-hashed `/assets/*` one year, immutable; fonts 30 days, immutable; icons 7 days; the map styles 5 minutes with 1-day stale-while-revalidate; the page, `sw.js` and the manifest `no-cache`, so a deploy is picked up on the next load. Tiles: 1 day with 7-day stale-while-revalidate and ETag, in the browser's HTTP cache only (D-030).
- **Service worker** (`frontend/sw/sw.js`, hand-written, versioned by content hash per build): precaches the build and the styles; pages are network-first with the cached shell as fallback, each cached under its own path; glyph ranges are cached as used; API GETs are network-first (8 s timeout), keeping successful responses within 30 MB (10 MB per entry, least recent evicted) and serving them offline marked `x-meshmap-offline`. Tiles, the live stream, health and metrics are network-only: no tile is ever stored by the worker. The window's rows come from IndexedDB (§5.1) (D-030, D-051).
- **Installable:** web app manifest (standalone, regular and maskable icons, Apple touch icon), mobile web-app meta tags, and Install app in Settings where the browser offers a prompt; on iOS, Add to Home Screen. Service workers and installation need HTTPS (localhost exempt).

### 7.14 Reset

Settings → "Reset and reload", after a confirmation, stops the derivation worker so its database can be deleted, clears local and session storage (layer choices, theme), deletes this site's IndexedDB databases, deletes the service worker's caches and unregisters it, then reloads without the query string, so the window and filters reset too. The privacy policy mentions it (D-076).

### 7.15 Accessibility and controls

Native, labelled HTML controls (buttons, range and datetime inputs, ARIA roles) rather than a component library; sparklines and the traffic strip are small SVGs (D-018). Essential controls work from the keyboard; Escape closes panels; colours are colourblind-safe and ordered by lightness; reduced motion disables pings and transitions. Loading, empty, offline and error states are explicit.

## 8 Deployment and operations

Detail is in [operations.md](operations.md); this is the outline.

- **Compose services:** `postgres`, `redis`, `backend` (`meshmap serve`), `maintenance`, `web` (Caddy: frontend, API proxy with SSE flushing, tiles, fonts, styles; the only published port) and `basemap` (Planetiler; builds `basemap.pmtiles` when missing and every 30 days, separate because a build needs Java and ~8 GB heap) (D-049). The optional `demo` profile adds a compose-only Mosquitto and a simulator with real encryption and signatures and deliberately bad input, which refuses non-private hosts.
- **Images:** `ghcr.io/868-no/map-backend`, `map-web`, `map-basemap` for `linux/amd64` and `linux/arm64`, built per pull request and published from `main` and version tags. `deploy/compose.production.yaml` is a complete stack on published images with configuration in the Compose file (D-049).
- **Configuration:** environment variables (see `.env.example` and `backend/internal/config/config.go`) plus broker and channel YAML from `secrets/` or env (§2.1, §2.3). Key settings: `RETENTION_MONTHS`, `DEFAULT_WINDOW_HOURS`, `MAX_WINDOW_HOURS`, `LIVE_QUANTUM`, `SIGNATURE_POLICY`, `DEFAULT_KEY_FALLBACK`, `GEOLOCATION_*`, `MAP_TILE_SOURCE`, `MAP_STYLE_URL`/`MAP_STYLE_LIGHT_URL`, `OPERATOR_NAME`/`OPERATOR_CONTACT`, `TRUSTED_PROXIES`, `API_*`, `DB_API_CONNS`/`DB_INGEST_CONNS`, `INGEST_QUEUE_SIZE`, `WRITER_BATCH_SIZE`, `KEY_ATTEMPT_BUDGET`, `PUBLIC_METRICS_ENABLED`. `check-config` validates and prints a redacted summary; invalid production configuration fails readably.
- **Security:** CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'` (WebAssembly compilation only, no JavaScript eval) with `connect-src 'self'` and no inline scripts; no runtime CDN; HTTPS terminated by a proxy in front of `web`.
- **Health and metrics:** §4.1; key series are listed in operations.md.
- **Licence:** GPL-3.0-only, because the backend's generated protocol code comes from Meshtastic's GPL-3.0 protobufs. Every dependency was checked for compatibility (Paho used under EDL); fonts, map data and images are listed in THIRD_PARTY_NOTICES.md. Visitors receive the compiled frontend, so the credits link to the source at the built commit (`SOURCE_REVISION`, or `SOURCE_URL` for a modified build) (D-050).

## 9 Performance

Targets are development budgets on a reference workload: 2 million retained observations, 2 000 nodes, 20 000 candidate edges, bursts of 100 MQTT messages/s, a 4 vCPU / 8 GiB database host. Results are in [benchmarks.md](benchmarks.md).

- **Ingest** keeps running during queries and retention, with bounded backlog and recovery after database outages; seeding through the production path runs at ~7 300 rows/s.
- **Opening a 3-day window:** ≤ 10 s from empty and ≤ 2 s when the browser already holds most of it. Pages are served by the time index independent of retained history (D-038), from stored encodings (D-046), streamed (D-057), compressed (gzip/zstd), and fetched in four parallel slices (D-040).
- **Client:** no raw history in the JavaScript heap (< 250 MiB target; rows live in WebAssembly memory), no React re-render per packet, batched GPU layers with memoised data that only recolour on selection, search or theme changes, a cursor readout that bypasses React state (D-058), and level of detail for links (§7.4). Pan and zoom target near 60 fps on a desktop GPU; pings are bounded (80, one per transmission) and run in their own canvas (D-083). Vendor code (MapLibre, deck.gl, React) is split into chunks that stay cached across app deploys (D-039).
- **Engine:** a 72 h reference snapshot builds in ~0.2 s off the main thread; shared passes (traceroute hop samples, packet copies, position groups) run once per rebuild (D-060, D-083). Incremental derivation is not worth its complexity at this scale.

## 10 Testing

### 10.1 Strategy

- **Backend unit tests** (`scripts/go.sh go test ./...`): crypto vectors and mutations, XEdDSA cross-checks, protocol limits and fuzzed garbage, ingest rules, window semantics, configuration, API contract (the committed `docs/api-openapi.yaml` must equal the generated document), and replay of committed **real captures** from `mqtt.868.no` through the production `Process`, which fails on any signature rejection of real traffic (D-003).
- **Integration tests** (`scripts/integration.sh`): throwaway Postgres, Redis and Mosquitto containers on a private network and `go test -tags integration` beside them, without Docker-socket access from the test container (D-010). They cover the pipeline, dedupe across brokers, partitions and migration, retention, time isolation on `/observations`, Redis independence, and that a streamed row equals the stored one (D-033, D-041).
- **Engine tests** (`scripts/wasm.sh test`): unit tests per module, an isolation test (every derived field comes only from in-window rows), and two **golden fixtures** from a recorded 12-hour live window (`frontend/engine/tests/fixtures/mesh-12h`): `expected.json` compares the engine with the retired server views, with the newer rules switched off (§5.2); `engine.json` locks the engine's own output with default options for every view kind (snapshot, traffic, a filtered snapshot, 10 node panels, 4 packet logs, 4 packet routes), including MQTT edges and downlink flags. Re-record with `UPDATE_GOLDEN=1 scripts/wasm.sh test` only after an intended behaviour change (D-041, D-060).
- **Frontend unit tests** (Vitest): row store, persistence, pings, labels, stacking, the colour model and ramp contrast (D-085), regions geometry, theme, URL state, and a type-checked test fitting the golden output to the view types (D-083).
- **End-to-end** (Playwright against a running stack built with the end-to-end hook, never in production builds): layout and overlays, selection, the period controls, labels via `queryRenderedFeatures`, attribution, pings through a mocked stream, privacy and Settings, reset, the start view, permanent links, PWA (offline reload, no tile in any worker cache) and a reference-density performance scene. Service workers are blocked by default and opted into for the PWA test (D-030). Screenshots are saved to `docs/screenshots/` for review (D-017). CI runs them on every push against the demo stack (simulated mesh on a local broker plus two days of seeded history, `MESHMAP_NO_BASEMAP` set, one retry); tests that need the self-hosted basemap skip themselves there and run against a full deployment (D-110).
- **CI** (`.github/workflows/tests.yml`) on every pull request and push: Go vet, gofmt and unit tests; integration tests; engine tests including the goldens; frontend type check, lint, unit tests and production build; and a check that `src/api/schema.d.ts` regenerates unchanged from `docs/api-openapi.yaml` (D-083). End-to-end tests need a running stack with a basemap and live traffic, so they run against a deployment.

### 10.2 Acceptance tests

Code comments cite these by number.

Crypto and ingestion:

1. A valid AES-CTR envelope with a configured channel name and PSK is decoded and stored once per distinct gateway reception.
2. The same packet with a wrong key is kept header-only as `encrypted`, a malformed protobuf is discarded; CTR parsing is never called integrity verification.
3. AES-CCM authenticates a valid packet and discards a modified ciphertext or tag.
4. A valid XEdDSA packet with a known authoritative key is stored `verified`; a one-byte mutation of the signed payload or signature is kept header-only as `invalid` (`sig_invalid`).
5. A correct first-contact signed NodeInfo is accepted after the self-consistency checks; a spoofed or conflicting identity is kept header-only as `invalid` and never promoted.
6. Unknown-key signatures never show as `verified`; unsigned packets are labelled accurately.
7. A traceroute's signature follows the documented exemption and is never marked authenticated.
8. A PKI-only DM is kept header-only as `direct_message`, its payload zeroed, and no channel PSK is tried on it.
9. Two brokers delivering the same gateway upload do not double-count it; two gateways hearing one packet are kept as two receptions but count as one packet.
10. Malformed and oversize payloads, repeated reconnects, missing topic segments and malicious strings do not crash the service.

Time isolation:

11. Node A named OldName at T1 and NewName at T3: a window covering only T2 shows neither name; one containing T1 but not T3 shows OldName; one containing T3 but not T1 shows NewName.
12. A node whose position is only before `start` is unpositioned in the window even if it sends in-window packets.
13. Evidence at `start − 1 ms` is never shown, evidence at `start` is, evidence at `end` is not.
14. A window ending before a later rename (or position, link, telemetry) shows only the earlier state.
15. Switching windows can never show results of the previous window: there is no server result cache, and the worker answers each request by id.
16. A rolling window drops expired evidence even when no packets arrive.
17. A fixed window receives nothing beyond its end despite continuing ingestion.
18. The API rejects a 7-days-plus-one-second window and a start before retention; it never returns extra history.
19. Rows deleted by retention cannot reappear from Redis or an open browser session.
20. A full restart with empty Redis reconstructs the same in-window results from `packet_log`.

Graph, radio and estimates:

21. NeighborInfo from A listing B creates only `B → A`, with the reported float SNR, not divided by four.
22. Forward and return traceroutes create the correct adjacent directed segments with SNR/4 and no origin–destination shortcut.
23. A relay byte matching two candidates produces no inferred link.
24. A unique relay byte, a genuine RF reception and consistent hops produce a low-confidence inferred link; otherwise none.
25. A packet received via MQTT without demonstrable RF reception creates no RF link.
26. Three well-spaced anchors with enough direct observations give a coarse, labelled estimate with uncertainty; two anchors, co-located anchors or conflicting samples give no estimate.
27. No estimate uses anchors or measurements outside the window; anchor precision error is part of the uncertainty radius.
28. Estimated and reported positions look different; unpositioned nodes are listed.

UI, performance and operations:

29. The default window is the server's rolling default; presets 1 h–7 d work; setting both bounds and sliding back to the retention limit works, with correct time zones across DST.
30. The theme follows the browser unless chosen and never flashes; borders, land cover, roads and city names show by default while local place names, peaks, road names and water names are hidden, and each appears in test areas once enabled; layer choices persist per viewer; every switch has a tooltip.
31. Selecting a node shows only its links and its accuracy circle; clicking empty map deselects; panels overlay the map without resizing it; API payloads never carry envelopes, ciphertext or message bodies; the app is installable and reopens offline with the last data received, while no tile is stored by the service worker.
32. With 2 million rows, 2 000 nodes and 20 000 candidate edges, benchmarks, browser memory and frame rate are measured and documented; the browser holds no raw history.
33. Retention runs daily and is safe to repeat; `packet_log` is the only application table; Redis can be wiped without data loss.
34. The stack comes up from a fresh checkout with example configuration and `docker compose up -d --build`; demo mode generates useful traffic without reaching public brokers.
35. Integration tests cover TLS broker reconnects, invalid credentials, gateway duplication, database unavailability, health signalling, the bounded queue and recovery after restart.

## 11 Known limitations and open questions

- **Coverage:** the map shows what this service received over MQTT while running; it is not a complete history. Queue overflow and broker disconnections lose data (§2.7).
- **Receive time only:** timestamps are `observed_at`, not transmission time.
- **Trust:** keys are trusted on first use and lapse when their announcements age out of retention. CTR decryption proves nothing about integrity; CCM proves channel membership, not sender. Topics, gateway ids and node ids are unauthenticated claims. Map report names and roles are unauthenticated too.
- **CCM** is verified only against specification vectors; no real AEAD traffic has been observed yet (D-004).
- **Relay bytes:** a unique match can still name the wrong node when the true relay was not seen in the window (§6.3).
- **Downlinks** are inferred from 0 dB traceroute readings; a node that downlinks but is never traced is not found, and a downlinked packet can still pass for a direct reception (D-054, D-064).
- **Router reliability** is a lower bound because gateways uplink only the first copy they hear (§6.9).
- **Estimates** are coarse ("somewhere among these anchors" uncalibrated, kilometres even calibrated). Small movements of nodes publishing 12–15-bit positions cannot be seen, since their cells are kilometres wide (D-073).
- **Reach** assumes intermittent links are always there and knows nothing of unseen links (§6.8).
- **Uplink opt-out** withholds names, not ids, traffic or positions (§2.5).
- **Envelopes** keep text messages readable to anyone with the channel key; whether to keep them is open for the operator (D-051).
- **MapLibre** stays on 5.x until deck.gl supports 6.x labels in interleaved mode; the GHSA-jrc7-96c5-q579 mitigation depends on the attribution control staying disabled (D-017, D-019).
- **Frame rates** have been measured only with software WebGL; the 60 fps desktop target is unverified on GPU hardware (benchmarks.md).
- **Name clustering** de-clutters names but node markers themselves are not clustered at low zoom.
- **Firmware:** minimum 2.7; behaviour that depends on newer fields degrades conservatively.
