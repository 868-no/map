# 868.no Map — design

This document describes the 868.no Map as it is built today: what it does, the rules behind every derived value and every map element, and the reasons for those rules where the reason helps.
It is the reference that code comments cite as "design §n".
Tags such as (D-073) mark the operator decisions behind a rule; code comments use the same tags, so searching for one leads here.

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

The 868.no Map is a web application for observing Meshtastic mesh networks using **only the traffic that reaches one or more MQTT brokers**.
It decrypts channel traffic, verifies packet signatures, stores every accepted gateway reception, and lets anyone with a browser inspect the mesh for any time window in the retention period: nodes, evidence-backed radio links, positions and coarse location estimates, traffic, and live transmissions.
It opens on a rolling three-day window and can slide back through six months.

It is built for the Norwegian community broker (`mqtt.868.no`) but hard-codes no region or community beyond its Norwegian defaults (start view, regions layer, basemap area).

The stack is Go (ingest and API), PostgreSQL (one table of mesh data, plus weather, terrain heights and place names, §3), Redis (ephemeral), a Rust engine compiled to WebAssembly running in a Web Worker in the browser, and a React + MapLibre GL + deck.gl frontend served by Caddy (D-001).

### 1.2 Invariants

These hold everywhere; a feature that would break one is not built.

1. **Only MQTT feeds mesh data.** No device API, serial link, node polling, other mesh feed or third-party topology service is used.
2. **One table of mesh data.** `packet_log` is the only table holding mesh data (its monthly partitions are not separate tables).
   No node, link, position, identity, snapshot, settings or migration table exists.
   Four other application tables hold no mesh data: `weather_hour`, weather fetched from MET Norway, which nothing on the map is derived from (§6.18, D-133), `terrain_height`, terrain heights from Kartverket for line-of-sight cross sections (§6.19, D-143), and `place_name` with `place_key`, Kartverket's place-name register for the map's search (§3.9, D-193).
   Redis holds only ephemeral, rebuildable state.
3. **Strict window isolation.** Every mesh-derived output is scoped to the selected half-open interval `[start, end)`.
   No name, position, role, link, counter or chart is taken from outside it (§3.5).
4. **Nothing heard is dropped; what is private or untrustworthy is stripped (D-093).** Every packet with a parseable envelope is stored, but only what we may and can trust: a packet we cannot read (an end-to-end encrypted DM, a channel without our key) or cannot trust (failed decoding or verification) keeps only its cleartext header, never its content.
   Untrustworthy (`invalid`) rows count for nothing on the map, since their sender may be forged.
   Only duplicates (broker replays, JSON copies, re-deliveries) and unparseable envelopes are discarded.
   Plausible AES-CTR plaintext is never called authenticated.
5. **No imaginary edges or precise guesses.** Links and coordinates carry their provenance, confidence and uncertainty.
   Ambiguity produces nothing rather than a guess.
6. **The browser never loads the full log.** It loads the decoded rows of the selected window (at most 14 days, D-183) and live additions, and derives every view itself (D-031).
   Raw envelopes and payload bodies never leave the server; public keys are served one node at a time (D-089).
7. **One command deploys.** `docker compose up -d --build` starts the whole application after configuration, with no proprietary external service.

### 1.3 Honest data

The map shows what this service received over MQTT while it was running.
Every timestamp is the server's receive time (`observed_at`), labelled as such, never an RF transmission time.
Counts say what they count (distinct packets versus gateway receptions, node pairs versus directed links).
Inferred values are marked as inferred, in the data and on screen: dashed links, hollow estimate markers, uncertainty circles, plain-word reasons in tooltips.
Where the protocol cannot tell, the map says so instead of filling the gap.

### 1.4 Privacy, secrets and access

- **Public, no login.** The map has no accounts, cookies, analytics or third-party requests at runtime.
  Weather is fetched by the server, which sends MET Norway only grid cells (§6.18).
  Optional basic auth can be added at the proxy (operations.md).
- **No private content is stored.** Packets on channels whose key we lack, and end-to-end encrypted direct messages, keep only their cleartext header (sender, destination, packet id, gateway, channel name, hops, relay, size, signal), as `encrypted` and `direct_message` rows; the stored envelope has the payload zeroed (D-091, D-093).
  Only channels with a configured key, or the public default key (§2.3), are decoded.
- **No message bodies in decoded data or the API.** Text messages are recorded by type and size only.
  The raw envelope (`envelope_bytes`) is kept for re-decoding and audits; for a text message it still contains the message, encrypted with its channel key (readable with that key, e.g. the public default key) or in plain text when a gateway uplinked it decrypted.
  It is never served.
  The privacy policy and architecture.md say so; whether to keep envelopes is the operator's choice (D-051).
- **Uplink opt-out is honoured as far as possible.** A node that did not allow MQTT uplink is never named (§2.5).
- **Secrets** (MQTT credentials, channel PSKs, database password) come from mounted files or environment variables.
  They are never logged, stored, returned by the API or put in the browser bundle; `check-config` prints a redacted summary.
  The configuration revision that is part of the public data generation is an HMAC keyed with the database credentials, so it cannot be used to confirm guessed PSKs offline (D-083).
- **Visitors:** IP addresses live only in the rate limiter's memory (dropped after 10 idle minutes) and are never logged.
  Browser storage holds settings, the window's rows and the app shell.
  A static privacy policy at `/privacy.html` fills in the operator, contact, retention, geolocation and tile source from `/api/v1/capabilities` (D-051).
  A static page at `/api-docs.html` documents the public API: it renders the server's own OpenAPI description (`/api/openapi.json`) as text, with no script from elsewhere, so it always matches the running server (D-185).
- **Location estimates** can be disabled, and nodes listed in `GEOLOCATION_EXCLUDE_NODE_IDS` are neither estimated nor used as anchors.
  The inputs are public, so exclusion is a display rule, not a secret (D-031).

### 1.5 Non-goals

Transmitting to the mesh, issuing traceroutes or controlling devices; decrypting PKI direct messages; predicting the route of arbitrary packets or claiming end-to-end routes from a broadcast's addresses; meter-scale positions from RSSI/SNR; showing or exporting message contents; user accounts.

## 2 Ingest

The backend binary `meshmap` runs ingest and the API in one process (`meshmap serve`).
Ingest is a singleton: several processes subscribed to the same brokers would only produce duplicates.

### 2.1 MQTT input

- Any number of brokers, each with its own host, port, protocol (MQTT 5 via autopaho, or 3.1.1 via paho), TLS and CA, credentials, client id, topic filters and QoS.
  Configuration is YAML from mounted files or, in a Compose-only deployment, the `MQTT_BROKERS` and `CHANNEL_KEYS` environment variables, which replace the files when set (D-049).
- **Read-only.** The clients subscribe and never publish; a unit test fails if the `mqtt` package ever calls a `Publish` method.
  A broker counts as up (and in `/health/ready`) only once every topic filter was granted in the SUBACK; a refused filter, a missing SUBACK or a subscribe error leaves it down with a warning (D-083).
- **Topics:** `{root}/2/e/{channel}/{gateway}` (and legacy `/2/c/`), where `{root}` may have any depth (`msh/EU_868/NO/Østlandet`); the parser anchors on the last `/2/{e|c|json|map|stat}/` marker.
  `/2/map/` carries map reports (§2.5).
  `json` and `stat` topics are recognised and counted, not processed: protobuf is the canonical input, and a JSON copy would only duplicate a protobuf uplink.
- **Retained messages** are ignored by default (`accept_retained: false`), so a broker's retained copy never manufactures current activity.
- **Reconnect** and re-subscription on every connection.
  MQTT 5 waits a full-jitter backoff whose cap doubles from 1 s to 60 s, plus 0.5 s (so 0.5–60.5 s); MQTT 3.1.1 retries the first connection every 5 s and then reconnects with paho's own doubling backoff, capped at 1 minute, without jitter.
- **Packet size:** MQTT 5 clients send Maximum Packet Size 8 KiB in CONNECT, so the broker discards larger publishes instead of making the client buffer them (a full 4 096-byte payload, a 512-character topic and headers fit with ~3.5 KiB to spare for properties).
  MQTT 3.1.1 has no such limit: the whole packet is read before the payload limit drops it (D-165).
- **Event time:** `observed_at` is stamped in the MQTT callback, before queuing (§3.4).
- **Persistent sessions (D-205):** a broker with `session_expiry` (whole seconds, at most 24 h) is joined without a clean start and with that session expiry (MQTT 3.1.1: clean session off, the broker's own expiry), so a broker that queues for offline sessions hands over on reconnect what arrived while the backend was down; QoS 1 redeliveries are byte-identical and deduplicated (§2.6), and a message held this way is stamped when it finally arrives, seconds late.
  Without it (the default), every connection starts clean.
  The production stacks run `mqtt-buffer`, a pinned Mosquitto bridged to the real broker (clean session upstream, `topic msh/# in 0`) with `queue_qos0_messages` and up to 100 000 queued messages, and point the backend at it with `session_expiry: 1h` and QoS 1.
  An app deploy recreates the backend but leaves the buffer running, since neither its image nor its definition changed, so a deploy no longer loses the traffic of the restart: mqtt.868.no itself keeps nothing for an offline QoS 0 subscriber (tested 2026-11-10: no backlog after 30 s away, where the buffer delivered 40 s of traffic at once).
  The buffer's own restart, or its link to the real broker going down, still loses traffic, and the backend then counts its broker as up while nothing arrives (§8 alerts on that).

### 2.2 Decoding and input limits

- The payload is parsed as a `ServiceEnvelope` (`MeshPacket`, `channel_id`, `gateway_id`) with bindings generated from the pinned `meshtastic/protobufs` v2.8.2.
- **The topic names the channel.** Keys are chosen by the topic's channel segment, and the stored `channel_name`, the plaintext rule and the logical packet key use the same name.
  The envelope's `channel_id` is ignored: a replayed envelope could name another channel and so be decrypted under one name and stored under another.
  Map reports, whose topic names no channel, are stored without one.
  Rows stored earlier keep the name they were stored with; on real traffic the two agree (D-114).
- **Limits before and during parsing:** MQTT payload ≤ 4 096 bytes, service envelope ≤ 1 024 bytes, encrypted part ≤ 268 bytes (256 bytes plus PKI overhead), topic ≤ 512 characters without control characters (C0, DEL, C1; Postgres text cannot hold NUL), gateway id `!` plus 8 hex digits or a decimal node number (≤ 16 characters), channel id ≤ 64 characters, protobuf recursion limit, string lengths, ≤ 64 NeighborInfo entries, ≤ 8 traceroute hops, valid latitude/longitude and timestamps, and a key-attempt budget (`KEY_ATTEMPT_BUDGET`, default 4) that bounds the work per message; because it decides which packets decode when many keys are candidates, it is part of the configuration revision.
  A malformed protobuf never stops the subscriber; every rejection only increments `meshmap_ingest_rejected_total{category}`, and no payload bytes are logged.
  Failures past envelope parsing (keys, payload decoding, verification) are not rejections but header-only rows (§1.4).
- **Ports:** NodeInfo (sanitised names, hardware, role, public key), Position (zero coordinates mean none; `precision_bits == 0` means precision unknown, never an anchor), Telemetry (clamped; device and environment metrics, and local statistics: the noise floor the node measures, kept from −150 to −30 dBm since firmware sends 0 when it has none, and its radio counters, stored with decoder version 5; other variants as kind `other`), NeighborInfo, Traceroute, text (size only), routing (metadata only), map reports, node status (the status text a node broadcasts, sanitised like a name and removed for opt-out nodes), store-and-forward (message kind, heartbeat period, history size and a replayed text's size, never its content) (D-103), and well-formed unknown ports as `other`.
  Rows stored as `other` before node status and store-and-forward were decoded are labelled with their type when rows are encoded (kind `unknown`).
  An invalid payload is never interpreted as a known type.
- **NeighborInfo** SNR is a float in dB, stored unchanged.
  A report whose `node_id` is nonzero and differs from the packet sender is rejected (`payload_invalid`): it would let one node assert another's neighbours (D-008).
- **Traceroute** SNRs are integers × 4 and are divided by 4.
  Hops the firmware could not identify (`0xFFFFFFFF`, SNR −128) are kept as unknown placeholders; their SNR is null, and no link touches or bridges them.
- **Plaintext uplinks** (gateways uplinking decoded packets) go through the same schema validation and signature verification, with an inbound `xeddsa_signed` flag ignored, and are recorded as weaker crypto provenance.
  They are accepted for configured channel names (`accept_plaintext`, default true).
- **Minimum supported firmware is 2.7.** Older packets are decoded where possible; absent fields (`hop_start`, `transport_mechanism`, precision) never create evidence.
- **Direct RF** is decided at ingest: a reception is `direct_rf` when a gateway is present and is not the sender, the packet did not come via MQTT, the transport is LoRa, `hop_start == hop_limit > 0`, and RSSI or SNR is present.
  Otherwise the reason is recorded (relayed, via MQTT, non-RF, no metrics).

### 2.3 Decryption

- A channel is configured by **name and PSK(s)**, not a key pair, with a broker scope (`broker_ids`, `*` for all) and a mode: `ctr` (AES-CTR) or `ccm` (the AES-CCM channel AEAD of firmware 2.8.1+).
  PSKs are base64 or `hex:`; the one-byte shorthand expands to the public default key as in firmware.
  Several keys per channel allow rotation (current first).
  Any number of channels may be listed, and one name may appear with different broker scopes.
- **AES-CTR** uses the firmware nonce `LE64(packet_id) ‖ LE32(from) ‖ 0`.
  Success means the `Data` parses and its port handler accepts the payload; the crypto status is `ctr_unauthenticated`, because CTR has no tag.
- **AES-CCM** uses a 13-byte nonce prefix (L = 2), a 12-byte tag and AAD `LE32(from) ‖ LE32(to)`; a failed tag means the key does not fit: there is no CTR fallback, and the packet is kept header-only as `encrypted` (D-093).
  CCM proves possession of the channel key, not the sender's identity.
  The library is validated against RFC 3610 and the nonce/AAD construction matched to firmware source line by line; real AEAD traffic has not yet been observed, so CCM is verified against specification vectors only (D-004).
- The one-byte **channel hash** (XOR of name and key, `^ 0xAE` for AEAD) only orders candidate keys; it authenticates nothing.
- **Default-key fallback:** a packet on a channel name with no configured keys is tried with the default key (CTR and CCM) under the channel name its topic gives, but only when the channel hash matches the packet's channel byte, so a channel with its own key almost never gets an attempt.
  Configured names and PKI never fall back.
  Keys are derived per packet, not cached, because anyone who can publish chooses topic names.
  Such channels are readable by anyone with a Meshtastic radio, so decoding them adds nothing that is not already public.
  `DEFAULT_KEY_FALLBACK` (default true) is part of the configuration revision (D-065).
- **PKI direct messages** (PKI flag, or channel hash 0 with ciphertext addressed to one node; firmware never PKI-encrypts a broadcast, so a broadcast with hash 0 is tried with channel keys (D-165)) are never decrypted; channel PSKs are never tried on them.
  Their header is kept as a `direct_message` row: sender, recipient, packet id, hops, last relay, next hop, want-ack, size and the gateway's reception metrics, all sent in the clear on RF.
  The stored envelope has the payload replaced by zeros of the same length, so neither ciphertext nor a payload a recipient's gateway uplinked decoded is kept.
  They count as traffic and as link and relay evidence like any packet; without them a node's direct-message traffic and the receptions it proves were invisible, and the ACKs answering them (stored, since ACKs travel on the channel) could not be matched (D-091).
- Key rotation is a configuration change and a restart.
  Key material never reaches the API, logs, database or browser.

### 2.4 Signatures and identity

- **Verification** follows firmware: XEdDSA verification is Ed25519 verification under the Edwards form (sign bit 0) of the node's X25519 public key, using the vetted `filippo.io/edwards25519/field` for the map and stdlib `crypto/ed25519`; no curve arithmetic is hand-written.
  The conversion matches an independent derivation for ≥ 1 000 random keys, and mutations of header, payload or signature fail (D-002).
  Real firmware 2.8 captures from `mqtt.868.no`, committed as public fixtures, verify with zero signature rejections (D-003).
  The signing-buffer layout is in protocol-compatibility.md.
- **Per-packet status:** `verified`, `unsigned`, `unverifiable` or `not-applicable`.
  Never a blanket "secure" because a channel key decrypted.
- **First contact:** a signed NodeInfo from an unknown sender is promoted only if its public key is 32 bytes, its CRC-32 equals the node number, and the signature verifies under it; otherwise it is rejected, as firmware drops it.
- **Known signer:** the signature must verify against the authoritative key; a signed NodeInfo must also claim the key that signed it, and that key must hash to the sender (CRC-32 of the key: firmware 2.8 and later derive the node id from it, so an upgrade from 2.7 with the key kept is a new id, and a reset without restoring the key another, D-142).
  A mismatch is rejected.
  A malformed signature (length not 0 or 64) is rejected.
- **Header-only rows (D-093):** a failed check below keeps the packet as an `invalid` row with the reason (`iv`: `sig_invalid`, `sig_malformed`, `first_contact_invalid`, `nodeinfo_key_mismatch`, `strict_unverifiable`; also `payload_invalid`, `decode_failed`, `plaintext_unconfigured`).
  Its content is never stored, it never promotes an identity, and the engine's row filter drops it from every view except the sender's packet log, so it never counts as traffic, link, relay or ping evidence.
- **Unknown key:** other signed packets from a sender with no authoritative key are `unverifiable` and kept under `SIGNATURE_POLICY=balanced` (the default); under `strict` they become header-only `invalid` rows (`iv=strict_unverifiable`).
  Strict does not drop unsigned packets as firmware Strict does: the map's job is visibility, and unsigned traffic is labelled (D-006).
- **Unsigned** traffic is kept and labelled.
  An unsigned NodeInfo never overwrites a known signing identity with a conflicting key; the conflict is counted and logged.
- **Traceroutes** are `not-applicable`: every hop rewrites the payload, so firmware exempts them, and the map never claims one verified nor treats the exemption as tampering.
- **Identity index:** the authoritative key per node lives in the ingest process's memory (`internal/identity`), rebuilt from verified NodeInfo rows in `packet_log` at startup and after every retention run that deleted rows, and topped up hourly from the rows stored since (row ids rise, so a newer row never displaces a first binding).
  Node public keys are public data and are stored in `decoded_metadata`, so the rebuild needs no re-decryption (D-009).
  This is trust on first use, not a CA: when a key's announcements age out of retention, that trust lapses until the next valid signed NodeInfo.

### 2.5 OK-to-MQTT and map reports

- **OK to MQTT** (`Data.bitfield` bit 0): firmware withholds packets without the flag only from brokers with public addresses, so they can still reach us through a bridged local broker.
  A packet without the flag that a gateway other than its sender uplinked is kept and marked `not_ok_to_mqtt`; its **NodeInfo is kept without its names** (hardware, role and public key remain; the stored envelope's payload is zeroed), so the node is shown but never named (D-093).
  Its id, traffic and any reported position remain: a slight anonymisation, not a promise.
  A gateway uplinking its own packets is never filtered.
  No bitfield at all (firmware before 2.5) counts as allowed.
  Nodes with marked packets in the window carry `mqtt_opt_out` and get a permanent red ring (D-032).
  Opt-out nodes are never named, even if an older NodeInfo is in the window (D-087).
- **Map reports** (`…/2/map/`, `MAP_REPORT_APP`) are stored as packet type `mapreport` (crypto `mqtt_map_report`, signature not applicable), accepted only when published by the node they describe (sender = gateway).
  Their location is an ordinary reported position.
  Every report has packet id 0, so the logical key adds a 5-minute bucket of `observed_at`.
  Copies of one report delivered by several brokers share the bucket, and so the key, unless they arrive on either side of a bucket boundary (`observed_at` truncated to 5 minutes, UTC): then the report is stored once per side, as rows identical but for broker and time.
  Nothing more stable is available to key on: a report's envelope carries only sender, destination and payload (no packet id, no `rx_time`), and the report itself no time.
  The odds are the brokers' delivery spread over 5 minutes (a second apart: about 1 in 300), and a doubled report only repeats the same identity and position (the node's packet log lists it twice).
  Map reports never animate as pings (D-032).
- A map report's long and short name, hardware model and role are carried in rows.
  When the window holds no NodeInfo from a node, its latest named map report is its identity (`identity.source: "mapreport"`, and the panel says so instead of showing a signature); NodeInfo always wins (D-063).

### 2.6 Deduplication and broker provenance

- `logical_packet_key` identifies the RF packet: a truncated SHA-256 of sender, packet id, destination, channel, port and the canonical payload (re-marshalled with the signature cleared).
  Traceroutes exclude the payload, which every hop rewrites, so all partial-route copies share a logical key.
- `observation_key` identifies one reception: the logical key plus gateway, receive time, SNR, RSSI, hop limit and start, relay byte and payload hash. **Every distinct reception is its own row** — another gateway, relay, hop count, RF metrics or partial traceroute route.
  Brokers do not hear packets; gateways do.
- Only byte-identical re-deliveries of one gateway's upload (bridged brokers, a gateway publishing to several brokers, QoS retries) collapse.
  A worker first claims the key atomically in an in-process in-flight set, then checks committed keys (in-process TTL set, Redis, then the database).
  Redis and the database are asked only while the TTL set may lack a key: for one dedupe window after start (the keys of the process before) and after it evicted a key still in the window for room (it holds 200 000); otherwise, as ingest is a singleton, a key the set lacks was not stored lately, and asking would only cost a round trip per reception.
  A claim is held only by observations already handed to the writer, which retries until commit, so a dropped message never suppresses a later copy (D-011).
  The dedupe window is 15 minutes.
- The first broker to deliver a reception is its `broker_id`; every other broker that delivers it is added to `decoded_metadata.also_via` (a debug aid): merged before the insert while the row is in memory, otherwise applied by the writer as one batched update per flush that never adds a broker already present.
  These updates are restricted to recent partitions (`observed_at ≥ now − (dedupe window + 24 h)`) so they never probe old months (D-013, D-083).
  `fillfactor = 90` leaves room for HOT updates.

### 2.7 Pipeline, backpressure and shutdown

- MQTT callback → bounded queue (`INGEST_QUEUE_SIZE`, default 20 000, several minutes at 100 msg/s) → worker pool (parse, decrypt, verify, normalise, dedupe claim) → one batch writer (up to `WRITER_BATCH_SIZE`, default 500 rows, or every 200 ms), which then marks dedupe keys, applies `also_via` updates, promotes identities and publishes live rows.
- Meshtastic topics arrive at QoS 0, so senders cannot be slowed.
  When the queue is full, messages are dropped and counted (`meshmap_ingest_dropped_total{reason="queue_full"}`); the writer retries database errors with backoff while the queue absorbs input.
  Errors on the data itself (SQLSTATE class 22 or 23, except a missing partition) cannot be told by their code from a database out of step with every row (a schema mismatch during a deploy), so a refused row is dropped only once the database has taken another row after refusing it: the batch is halved until the refused rows stand alone, and if any other row is stored they are dropped and counted as `meshmap_ingest_rejected_total{category="db_refused_row"}`, so one bad row cannot stall ingest.
  When every row is refused (at live rates most batches hold one row) they are kept and retried with backoff like an outage, the writer reports degraded, and rows arriving meanwhile are tried on their own as they come (at most every 250 ms): once one is stored, the held rows' refusal is their own and they are dropped; without new rows the held ones are halved again once a minute.
  A row that cannot be encoded at all is dropped before any insert (`unencodable_row`) (D-165).
  Broker disconnections lose whatever the broker does not retain, which with a persistent session (§2.1) is what arrives after the session expired or past the broker's queue limit.
- There is no per-message processing timeout: work is bounded by the key-attempt budget.
- **Bounded shutdown:** MQTT input stops first, then open live streams close, then the writer retries for at most 10 s before recording the remaining rows as a `shutdown_db_unavailable` gap and counting them as dropped (D-059).
  Rows the drain commits are still published to Redis for API-only processes: the publisher stops only after the drain, sending what waits for at most 3 s more.

## 3 Storage and time

### 3.1 The packet_log table

`packet_log` (`backend/internal/storage/schema.sql`) has one row per accepted gateway reception.
Columns: `id`, `observed_at`, `broker_id`, `mqtt_topic`, `gateway_node_id`, `source_node_id`, `destination_node_id`, `packet_id`, `channel_name`, `portnum`, `packet_type`, `logical_packet_key`, `observation_key`, `rx_time`, `rx_snr`, `rx_rssi`, `hop_start`, `hop_limit`, `relay_hint`, `transport_kind`, `signature_status`, `decode_version`, `envelope_bytes`, `decoded_metadata`, `obs_row`, `obs_row_version`.

- **Partitions:** range-partitioned by calendar month (UTC) of `observed_at` (`packet_log_pYYYYMM`).
  `storage.EnsurePartitions` creates them at startup (last month to two months ahead), on each maintenance run, and from the insert path whenever a batch reaches a month the process has not seen, so imports and tests with old timestamps just work (D-056).
- **Ids** come from the sequence `packet_log_id_seq` (PostgreSQL 16 has no identity columns on partitioned tables); the primary key is `(id, observed_at)`, because every unique index must include the partition key.
- **One row per reception:** a unique index on `(observation_key, observed_at)`.
  Inserts COPY into a per-connection staging table, then `INSERT … ON CONFLICT DO NOTHING RETURNING id`, so a batch retried after a commit whose outcome was lost stores nothing twice and gets the ids of its first attempt (D-056).
- **Indexes:** `(observed_at DESC, id DESC)` serves every `/observations` page and the boundary-month retention delete (D-038); a partial index on `(source_node_id, id) WHERE packet_type = 'nodeinfo'` serves the identity rebuild and a node's latest public key, and is untouched by other inserts (D-083, D-089).
  Two partial indexes on `id` cover the rows the startup jobs still have to rewrite: `WHERE decode_version < {DecodeVersion}` (re-decoding, D-107) and `WHERE obs_row_version IS DISTINCT FROM {obsrow.Version}` (the encoding backfill, D-046).
  New rows carry both versions, so in steady state they are empty, no insert touches them, and each job finds nothing at once instead of walking every partition.
  A predicate must be a constant, so each index is named after its version (`packet_log_stale_decode_v3_idx`); `init-schema` builds the current ones and drops those of other versions, so a version bump costs one index build at startup, which holds off writes on `packet_log` for the length of one scan (D-116).
  Indexes that served only the retired server views, and the never-scanned BRIN index, were dropped (D-045, D-056); `init-schema` drops them idempotently.
  The schema version is in the table comment (`meshmap-schema:5`), not a migrations table; `init-schema` runs idempotent statements under an advisory lock and converts an unpartitioned schema-1 table in one transaction.
  `packet_log`'s indexes are created from Go (`storage/stale.go`) and only when `pg_indexes` lacks them: `CREATE INDEX IF NOT EXISTS` on the partitioned table takes a SHARE lock on every partition before it sees the index exists, so on every start it would queue behind a VACUUM or backfill and hold up the inserts queued behind it (D-166).
- **Decoding again (D-107):** when `ingest.DecodeVersion` is bumped, the ingest process re-runs ingest on the stored envelope of every older row in the background (newest first, 500 per batch, waiting for rows another worker holds rather than skipping them), so decoder improvements reach the whole retained log.
  A row gets the current type, signature status, decoded metadata and envelope (a row that is header-only now has its payload zeroed retroactively), keeps its keys and broker provenance, and has its client encoding rebuilt.
  A row the current decoder would reject is kept unchanged and only marked as checked, and no identity is promoted from old rows.
  So is a fully decoded row that today's keys, signature policy or identities would read less of (header-only or invalid now, or no longer `verified`: a removed PSK, `SIGNATURE_POLICY=strict`, a signer's key aged out); such rows are counted in the log (D-166).
  Re-decoding brings decoder improvements, not a configuration's losses; opt-out stripping is still applied.
  Version 3 brought node status, store-and-forward and header-only rows; version 4 cleans stored channel names and topic roots (control and format characters, length), also on rows kept unchanged (D-152), and keeps an imported row's `imported` mark.
- **Three forms of one packet, on purpose:** `envelope_bytes` re-decodes after decoder changes; `decoded_metadata` (minimal sanitised typed data incl. public keys and reception provenance) rebuilds `obs_row` after logic changes and feeds identity; `obs_row` is what pages serve (D-056).
- **Importing history (D-137):** `meshmap import-envelopes` replays MQTT payloads recorded by another collector (Meshstellar's `service_envelopes`: receive time and raw payload, no topic) through `ingest.Process` as live traffic, so imported rows are decoded, keyed, verified and stripped exactly as if received live; an integration test holds a real capture with topics thrown away and rebuilt to the rows live ingest stores, reception for reception.
  The topic is rebuilt from the envelope: its `channel_id` (in real traffic always the topic's channel) and gateway, under the gateway's own root from its live rows where known.
  Only envelopes inside retention and before the broker's first live row are imported (imported rows carry `decoded_metadata.imported` and never move that bound, so a re-run with the default bound resumes an interrupted import, D-150), since two collectors stamp the same upload at slightly different times and `(observation_key, observed_at)` would not join them; uploads delivered twice within 15 minutes are stored once.
  Rows go in through the normal batch insert, so a re-run adds nothing; a row the database refuses on its data is skipped, counted and logged, the rest of its batch stored (a batch refused whole stops the import, as the database rather than the data is then at fault); identities learned along the way are promoted after their rows commit, as at ingest, and the backend is restarted afterwards to rebuild its identity index (trends pick up imported rows by themselves, D-151).
  An import advances the history revision (the sequence `packet_log_history_rev`) when it starts and when it ends, and holds a shared advisory lock while it runs; the revision is part of the generation, so every browser refetches the history it held and no cached day outlives an import, even one that crashed (D-158).
- **Stored row encodings:** `obs_row` is the row exactly as `/observations` serves it, minus the id, and `obs_row_version` the `obsrow.Version` it was built with.
  Pages read `obs_row` when its version is current and build the row from the other columns otherwise.
  At startup `serve` rebuilds missing or outdated encodings in the background, newest first, 2 000 rows per transaction with `FOR UPDATE SKIP LOCKED`.
  It is a copy of the row's own data, never derived state across rows, so a logic change needs only the version bump (D-046).
- The table is append-mostly: only `decoded_metadata.also_via`, the stored encoding and, when the decoder improves, a row's decoding (type, signature status, decoded metadata, envelope; D-107) are ever updated.

### 3.2 What is never stored

Rejected input (malformed or oversize envelopes, duplicates, broker replays, JSON copies) — not even in a quarantine table; the contents of packets we cannot read or trust (PKI direct messages, channels without a usable key, failed decryption or verification), which are kept as header-only rows instead (D-091, D-093); decoded message bodies; PSKs and private keys; derived data across rows (nodes, links, positions, snapshots).
Operational metrics are process counters, not packet history.

### 3.3 Retention and maintenance

- Rows older than `RETENTION_MONTHS` (default 6) calendar months are removed.
  The cutoff subtracts calendar months and clamps to the end of the target month (Aug 31 − 6 months = Feb 28/29), matching PostgreSQL interval semantics; rows exactly at the cutoff are kept.
  The API's earliest bound and the deleter use the same function (D-012).
- The `maintenance` service runs every `MAINTENANCE_INTERVAL_HOURS` (24 by default: daily at 03:00 UTC) and at startup if a run is overdue, under a PostgreSQL advisory lock.
  It drops partitions of months that end before the cutoff (rows counted by the planner's estimate), deletes the remaining expired rows of the cutoff's month in 5 000-row transactions, vacuums only that partition, trims `weather_hour` to the same cutoff (§3.7), creates partitions ahead, stores the run's status (time, deleted rows, table size, shown in `/health/ready`) and, when it deleted rows, announces the run over Redis: serve processes reload their identity index and tell open browser sessions, which re-read `/retention` for the new earliest bound.
  A run that deleted nothing is not announced.
- Creating and dropping partitions takes ACCESS EXCLUSIVE on `packet_log`; queued behind a long read it would stall every insert queued behind it.
  That DDL therefore runs with `lock_timeout` 5 s and is tried three times, 2 s apart, before failing as before (a failed maintenance run is retried; D-166).
  The schema statements and index changes `init-schema` makes at every start run under the same timeout and retries; a start that still cannot get its locks fails and is restarted.
- The production stacks back the database up nightly (`backup`, §8, D-206); with `compose.yaml` backups are not automated, and `pg_dump`/`pg_restore` are documented in operations.md (D-049).

### 3.4 Event time

`observed_at`, stamped in UTC when the MQTT message is accepted, is the only time used for windows.
`rx_time` and payload timestamps are kept as auxiliary, untrusted fields.
Forged, drifting or missing radio clocks therefore cannot move a packet across a window boundary.
The consequence is that the map shows what the service observed: nothing from before it started or while it was disconnected.
Messages a persistent session held while the backend restarted (§2.1) are stamped on arrival, as late as the restart took.
Each gateway's reception of one packet has its own `observed_at`.

### 3.5 Window semantics

- A window is the half-open UTC interval `[start, end)`.
  `internal/window` is its single definition, and all window-scoped SQL starts from `window.Predicate`; a test fails if any other code compares `observed_at` (allowlist: the ingest dedupe fallback and the retention delete).
- **Defaults and limits:** default rolling window 72 h (`DEFAULT_WINDOW_HOURS`), maximum 336 h (`MAX_WINDOW_HOURS`; 14 days, raised from 7 in D-183: at observed traffic about 15 000 rows a day, so about 200 000 in the browser), minimum 1 h, earliest start the retention cutoff, latest end now.
  Omitting `start` and `end` selects `[now − duration, now)` with `now` floored to `LIVE_QUANTUM` (10 s) so clients share boundaries.
  One bound only, `end ≤ start`, an over-long window or a start before retention is rejected; the server never widens a request.
  The browser takes the limits from `/capabilities` and requests nothing before they arrive (D-083).
- **Nothing leaks in from outside the window.** A node shown in a window has at least one accepted observation, or a mention in NeighborInfo or a traceroute, inside it.
  Its name, role, hardware and position come from the latest applicable announcement **in the window**; without one it shows its id and "not reported in selected period".
  A node only mentioned by others is "only named" (referenced) and inherits nothing.
  A link or estimate needs in-window evidence and disappears when the evidence leaves the window.
- **Nothing leaks past the end.** A fixed window shows only what was observed before its end, however much has been stored since, and receives no live updates.
- A rolling window evicts evidence that ages out even when no new packet arrives (heartbeats carry the moving bounds).
- `/observations` returns exactly the rows inside the interval; the engine derives every field from those rows only.
  Both halves have isolation tests (§10).

### 3.6 Redis

Redis runs without persistence (`save ""`, no AOF), with a memory cap and LRU eviction.
It holds only dedupe keys, live pub/sub and maintenance status, all rebuildable; wiping it loses nothing.
When it is unreachable, readiness reports degraded, dedupe falls back to a database lookup (after a Redis error ingest leaves Redis alone for 30 s, so an unanswering Redis does not cost every message a timeout; D-166), and `serve` fans live rows out in process.
There is no result cache: views are built in the browser (D-041).
The one shared copy of rows is of whole final days (§4.2, D-158): compressed bodies under `meshmap:obsday:{generation}:{date}` (gzip) and `…:{date}:br` (brotli, D-168) for 15 days (the longest window and its first, partly covered day), at most 16 MB each, and short build locks beside them; without Redis each process builds its own.

### 3.7 The weather_hour table

`weather_hour` (same schema file) holds MET Norway's analysis per grid cell and hour: `cell_x`, `cell_y`, `valid_at` (the primary key), `temp_c`, `precip_mm`, `humidity_pct`, `cloud_pct`, `sun_wm2`, `wind_ms`, `gust_ms` (from MEPS, NULL until its run is archived), `missing` (the archive had no file for that hour when asked), `fetched_at` and `version` (what the row holds; older rows are fetched again).
Columns added later are added by `init-schema` with `ADD COLUMN IF NOT EXISTS`.
Rows are upserted as the weather worker fetches hours and deleted by the daily retention run when `valid_at` is before the retention cutoff, like the mesh data they sit beside.
It holds no node ids, so it says nothing about the mesh; it is not window-scoped, and `/observations` never reads it (§6.18, D-133).
The schema version became `meshmap-schema:3` with it.

### 3.8 The terrain_height table

`terrain_height` (same schema file) holds terrain heights from Kartverket's terrain model on a grid of 0.0005° (about 55 m north–south and 25 m east–west in Norway): `lat_k` and `lon_k`, the grid indices (`round(lat / 0.0005)`, the primary key), and `z`, the height in metres, NULL where the model has none (abroad).
Rows are inserted as the terrain worker fetches heights and never deleted: terrain does not change, and the table holds no node ids or times, so it says nothing about the mesh and retention leaves it (§6.19, D-143).
The schema version became `meshmap-schema:4` with it, and `CheckSchema` accepts exactly the three tables.

### 3.9 The place_name and place_key tables

`place_name` (same schema file) holds Kartverket's place-name register for common use (Sentralt stedsnavnregister, CC BY 4.0) for the map's search (D-193): one row per name in use, since a place can have several (names in Sami or Kven beside the Norwegian one, other spellings in use), with `name` and its folded form `name_lc` (`places.Fold`: lower case, the punctuation that separates words in names, such as hyphens, full stops, slashes and brackets, turned into spaces, apostrophes dropped, spaces collapsed), `kind` (Kartverket's display name of its type, e.g. Bydel), `rank` (how this server orders kinds, §6), `importance` (Kartverket's `sortering`, 0 for viktighetA; higher is more important, a county or city 12), `place_id` (Kartverket's place number, shared by a place's names), `alt` (not its main name), `municipality`, `county` and one point, `lat` and `lon`.
`place_key` holds each folded name's word starts (`key`, byte-ordered so a `LIKE 'abc%'` uses its index) and the name's `name_id`, so a search matches any word of a name.
A search is folded the same way, so punctuation never decides a match: "nord fron" and "nord-fron" find Nord-Fron, as "fron" does, and "st olav" finds St.
Olavs gate.
A search reads a bounded number of rows however short: it first counts its matching keys, up to 20 000 (an index range scan); fewer are all ranked, while a search matching more (two letters can match a large share of a million names) takes the names equal to it and walks `place_name` in ranking order (`place_name_rank_idx`, which a load builds) testing word starts on `name_lc`, stopping at 200 matches: the same answer, since every one of the 200 best either equals the search or is among the first 200 matches in that order.
Both queries are planned for their values each time (a cached statement's generic plan cannot use the key index for `LIKE $1`).
At most 4 searches run at once per process; one that waits 2 s for a turn is answered 503.
Both tables are loaded whole by `places.Load` into tables of a schema of their own (`places_load`) and swapped in one transaction at the end, so searches use the old names until then; when it ran, and under which version of the folding (`fold=N`, `places.FoldVersion`; none recorded counts as 1), is the comment on `place_name`.
A register loaded under another version is loaded again at the next check, however recent, so a change to the folding reaches loaded names without waiting `PLACES_MAX_AGE_DAYS`; until that load ends, searches are folded the new way against the old keys.
They hold no node ids or times, so they say nothing about the mesh, and retention leaves them.
The schema version became `meshmap-schema:5` with them, and `CheckSchema` accepts exactly the five tables.

## 4 API

### 4.1 Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/capabilities` | Window defaults and limits, feature flags, map styles (`style_url`, `style_url_light`), tile source, geolocation settings, operator name and contact, retention. No secrets. |
| `GET /api/v1/retention` | Configured cutoff, earliest and latest retained `observed_at` (operational metadata, not mesh state), server time, and the current `generation` (D-170). |
| `GET /api/v1/observations` | The decoded rows of a window, paged (§4.2). |
| `GET /api/v1/observations/day/{date}?generation=` | Every row of one UTC day as one body, immutable and shared by every visitor once the day is final (§4.2, D-158). |
| `GET /api/v1/stream` | SSE for the rolling window only (§4.3). |
| `GET /api/v1/trends?bucket=day\|week\|month&tz=&region=` | Long-term summaries over the whole retained log, bucketed in the requested IANA time zone: nodes heard, gateways, nodes first heard in the bucket, distinct packets, receptions and packets by type; `invalid` rows never count. Views stop at the longest window's rows (14 days), so this, a node's history and what the nodes run from the same sums (next rows) are the only aggregates computed on the server (D-104). It is summed from per-UTC-hour summaries the API process keeps in memory (nodes and gateways as sets, packets, receptions and packets by type, per node heard its own packets, their receptions and its lowest battery, D-195, and what it said about itself and its radio evidence, D-198), so no table of summaries is added: the first request after a start scans the log once, they are refreshed at most once every 5 minutes whatever bucket or zone is asked for, re-reading only the last two hours, hours holding rows not yet decoded by the current decoder and hours that gained rows since the refresh before last, found by `id` (a sequence) above the id seen then, so imported history is summed wherever it lands (D-151), and none older than the retained log; trends never take a read slot from `/observations`. One refresh runs at a time, outliving the request that started it (for at most 2 minutes), and the sums stay readable while it runs: a request waits for it only within its own deadline, and at most 2 s when a completed refresh's sums can answer instead (then sent `no-store` and not reused); with none to answer, a request out of time gets 503. Buckets in any whole-hour time zone are unions of hours (a zone with a half-hour offset gets boundaries up to 30 minutes off; accepted, since the map serves Norway); a packet heard either side of an hour boundary counts in both. Sums are taken from a snapshot of the hours without holding their lock (an hour re-read is replaced, never changed), and requests missing the same answer at once compute it once. Responses are reused for 5 minutes, keyed by the zone's UTC offsets over the retained span rather than its name (zones with the same rules share an answer, so cycling zone names cannot force a new sum each time), and may be cached by browsers and shared caches for an hour, and served up to a day longer while revalidating (`max-age=3600, stale-while-revalidate=86400`): only the newest bucket can lag, by about an hour, which months of day, week and month buckets do not show (D-112). With `region` (a landsdel), only rows uplinked under a topic root naming it count, from per-hour sets kept beside the others, and packets are not split by type (D-194). |
| `GET /api/v1/trends/node/{id}?bucket=day\|week\|month&tz=` | One node's history over the whole retained log, from the same hourly summaries (D-195), for questions a 14-day window cannot answer ("has my router got worse since I moved it?"). The id is `!xxxxxxxx` or decimal, as for `/nodes/{id}/public-key`. Per bucket: the hours in which anything at all was logged (hours the collector heard nothing are not held against the node), the hours the node sent anything in and the hours it uplinked anything as a gateway, its distinct packets, their receptions by other gateways (its own uplinks of them left out, as in Details) and receptions per packet (how many other gateways heard each, on average: the reach of its signal, absent without packets), and the lowest battery level its device telemetry reported (101: only external power; absent when none). Buckets run from the one it was first heard in, as a sender or a gateway, to the newest, silent ones included. `invalid` rows never count. Bucketing, refresh, waiting, 503 and caching are as for `/trends` (`max-age=3600, stale-while-revalidate=86400`, reused for 5 minutes in a memo of its own, at most 512 answers, so browsing nodes never pushes the mesh-wide answers out); 400 for an invalid id or zone, 404 for a node in no summarised hour. |
| `GET /api/v1/trends/fleet?bucket=day\|week\|month&tz=` | The mesh's nodes by firmware, hardware model, role and modem preset per bucket over the whole retained log, from the same hourly summaries (D-198): the Regions panel counts a region's nodes over the window (D-196), the Trends panel graphs the whole mesh over everything kept. Per dimension (`firmware`, `hardware`, `role`, `preset`) a list of `values` (`name`, `kind` `value`, `others` or `unknown`; firmware values also `basis`: `reported` for a major.minor line the nodes' own map reports state, else the inferred generation `key`, `hardware` or `no_hop_start`, never a version), and per bucket its `start`, `nodes` (distinct senders, as `/trends` counts them) and, per dimension, the nodes with each value in that order, summing to `nodes`. Bounded: each dimension keeps its 8 largest values over the whole range (most node-buckets, then by name), firmware its 5 largest reported lines (newest first, ties to the newer) and the three inferred generations, the rest summed as `others` (with how many it sums, `folded`) and `unknown` last; a 9th value is kept rather than folded alone. A node counts in each bucket it was heard in, with the values it had then (D-198). `invalid` rows never count, nor a NodeInfo marked `identity_untrusted`. Bucketing, refresh, waiting, 503 and caching are as for `/trends` (`max-age=3600, stale-while-revalidate=86400`, reused for 5 minutes in a memo of its own); 400 for an unknown zone. |
| `GET /api/v1/places?q=` | Norwegian places with a name word starting with `q` (2–64 characters), from Kartverket's place-name register as loaded into the database, best match first, at most 8, with attribution; cached a day, 404 when `PLACES_ENABLED=false`, 503 until the register is loaded (D-193). |
| `GET /api/v1/terrain/profile?lat1=&lon1=&lat2=&lon2=[&alt1=&alt2=]` | The terrain cross section between two points and its line-of-sight class (§6.19): samples every 200 m with terrain height, earth bulge, line height and Fresnel radius, and each end's antenna. `alt1`/`alt2` are altitudes the ends report (0 or absent: none). Not mesh data. Heights not yet fetched are fetched in the background and the answer says `incomplete`; a complete answer is cached for a day, one whose class is `unknown` for 5 minutes. 404 when `TERRAIN_ENABLED=false`, 422 for ends over 300 km apart, outside the covered area (§6.19) or not finite (D-143, D-147). |
| `POST /api/v1/terrain/classes` | Line-of-sight classes of up to 400 links, given as the positions (and reported altitudes) of their ends, in one lookup; `incomplete` while heights are fetched, and a link's class is `unknown` until all of its own heights are in. A link over 300 km or with an end outside the covered area is `unknown` and not looked up; 422 for numbers that are not finite or more than 120 000 distinct grid points in all (D-143, D-147). |
| `GET /api/v1/weather?lat=&lon=&start=&end=` | Hourly weather at a point from MET Norway (§6.18): air temperature, precipitation, relative humidity, cloud cover, sunlight, wind speed and gusts. Not mesh data and not window-scoped; the span is at most the longest window plus two hours, starting no earlier than the retention cutoff. Cached hours are returned at once; the rest are fetched in the background and the answer says `incomplete`, so the browser asks again. 404 when `WEATHER_ENABLED=false`, 422 outside the analysis grid (D-133). |
| `GET /api/v1/nodes/{id}/public-key` | A node's public key from its newest retained NodeInfo carrying one, with its time and signature status, plus the trusted key (first stored verified NodeInfo, §2.4) and since when; 404 when none is retained. It spans the retained log, not a window: a key identifies a node. Fetched by the Details panel (D-089). |
| `GET /api/openapi.yaml` / `.json` | The OpenAPI 3.1 document, generated from the serving code and committed as `docs/api-openapi.yaml`. |
| `GET /health/live`, `/health/ready` | Liveness (no backend work); readiness covers database, schema version, Redis, ingest writer and queue, broker states and the last retention run. Probes are outside the API rate limit, so readiness reuses its database and Redis checks for 2 s and concurrent probes share one check; ingest and broker states are always current. |
| `GET /metrics` | Prometheus metrics on `backend:9100` inside the Compose network; on the public port only with `PUBLIC_METRICS_ENABLED=true`. |

The huma docs UI is disabled because it loads JavaScript from a CDN.

### 4.2 Observations

- `GET /api/v1/observations?start=&end=` or `?duration=`, with optional `since`/`until` that only narrow the window (clamped to it, never widening) and an opaque `cursor`.
  Pages are ordered by `(observed_at, id)`, which the time index serves directly however much older data is retained; the cursor (Unix microseconds plus id) only positions within the window (D-038).
  `limit` is at most 20 000 rows.
- Each row carries compact keys and only public decoded RF fields: header fields, radio metadata, signature status, topic root (`tp`), the reception reason, and the port fields the views use (identity, position, device telemetry, NeighborInfo, traceroute, map report incl. region, preset, names and firmware version).
  Never envelope bytes, payload bodies, public keys or full MQTT topics (D-031, D-044).
  Public keys are public, but 32 random bytes on every NodeInfo row would add about 15 % to a compressed window, so they are served per node instead (D-089).
  A NodeInfo row carries `key_id` instead: the node id its key derives, CRC-32 of the key, as firmware 2.8 and later compute it (§2.4).
  It equals the sender's id on 2.8 and later; on 2.7 and earlier the id comes from the hardware.
  The browser tells firmware generations apart and finds shared keys with it without holding any key (D-142).
  A map report row carries its firmware version cut to major.minor.patch (`mr.firmware_version`, row format 10; the build hash, the same on every node of a release, is dropped, and a version not starting with three numbers is left out) for the firmware breakdown (D-196).
  Local statistics telemetry carries only its noise floor (`te.noise_floor`, dBm, row format 11), for telling a noisier site from a weaker antenna; its radio counters stay in the database.
- Every response echoes the effective window (and whether it is rolling) and a `generation` = `d{decode_version}.r{obsrow.Version}.c{config_rev}.h{history_rev}`.
  A browser holding rows of another generation discards them and refetches; a key rotation, row-format change or import of history therefore costs one refetch (D-041, D-083, D-158).
- Pages are written from the database cursor straight to the response in 64 KiB chunks, never collected in memory.
  The query starts before anything is written, so errors up to the first row get a proper status; a failure mid-page aborts the connection, so the browser sees a truncated body, never a well-formed partial page (D-057).
  `Cache-Control: no-store`: a window's bounds are its visitor's own, so pages never coincide between visitors.
- **Whole days (D-158):** `/observations/day/{date}?generation=` serves the rows of `[date, date + 24 h)` UTC in the same body (`more` false), so pages and days share one parser.
  The URL names the generation, so a cached body can never stand for another: a different one is answered 409 (`no-store`, the current generation in the problem's `errors[0].value`).
  A day is **final** (D-159) when it ended at least 30 minutes ago, lies wholly within retention, no import holds the lock, no row of it still awaits decoding by the current decoder (the partial index of D-116 makes this an index probe), and some row observed at least 15 minutes after it has been committed (the writer commits in arrival order and retries a failed batch before taking more, so it is past the day; also after an outage).
  Late `also_via` updates do not matter: they are not part of a row as served; nor do stored encodings of an older version, which are served from their columns to the same content.
  A final day is answered `Cache-Control: public, max-age=31536000, immutable` with a strong ETag (`If-None-Match` gets 304), so browsers and Cloudflare keep it; its compressed body goes to Redis.
  A request that finds no copy builds one under a read slot: one build per day per process (singleflight), and one across replicas through a Redis lock (`SET NX`, 2 minutes, as long as a build may run), whose holders' peers poll for the result for up to 10 seconds and then build their own.
  The import state is read again after the rows, so an import that started meanwhile leaves the copy uncached.
  Otherwise the history revision and import state (a look through `pg_locks`) are read at most once a second per process, shared by every page, day (304s included) and `/retention`: a second-old state only names a generation a second late, and the read after a build is never shared.
  Anything not final (today up to now, a day the retention cutoff cuts into, served from the cutoff, a day with stale rows or an import running) is served from the database with `no-store` and stored nowhere (a day not final by the clock or while importing is streamed as read, gzipped on the fly when the client accepts it, never held whole); days wholly before retention or not yet begun are 400.
  Retention only deletes before the cutoff, and a final day lies wholly after it, so no cached day holds a row retention has removed; the browser builds windows that start at or after the cutoff, so rows of older days it still holds are never shown (D-160).
  Days are bodies the server compresses once, as gzip and as brotli (quality 9, in the same pass over the rows: on a real 6.1 MB day 0.8 s for 598 KB against gzip's 808 KB; quality 10 took 9 s, too long to hold a read slot) (D-168).
  A client accepting br (q > 0) gets the brotli copy, else one accepting gzip the gzip copy, both sent as stored (`Content-Encoding`, which Caddy's `encode` and Cloudflare pass through untouched), else the body decompressed; each encoding has its own ETag (`.br`, `.gz`, none), and `If-None-Match` with any of them is answered 304.
  A copy stored before brotli has no br copy and goes out as gzip.
  Days not final are only ever gzipped on the fly.
  A final day whose build outgrows 64 MB compressed is streamed `no-store` like a day not final; the process remembers it, and a marker beside the day's key in Redis tells the other replicas, so later requests stream at once instead of building and discarding it again.
- A row whose stored metadata fails to decode is still sent without those fields, and counted and logged on the 1st, 2nd, 4th, 8th, … occurrence (D-083).

### 4.3 Live stream

`GET /api/v1/stream?duration=` accepts only rolling windows (fixed windows get 422, and a duration outside the server's limits 400 as on `/observations`, before the stream opens: a stream that opened only to report a bad window would be reconnected to forever by EventSource).
Events: `delta` with `{id, t, row}`, where `row` is exactly the `/observations` row (the same encoder builds both, and an integration test compares them) (D-033); `heartbeat` every 15 s (and one on connect) with the current window bounds and server time; retention notices; and `status`.
The stream does not filter; browsers filter (D-041).
The hub encodes each delta once for all connections.
A subscriber too slow for its 256-message buffer is flagged and sent `status {live, reason: "lagged"}` (with live's current availability) before the next delta or at the next heartbeat, and the browser syncs at once (D-045).
An API-only process gets live rows over Redis pub/sub; its subscriber pings an idle connection every 10 s, and any lost connection sends `status {live: false}`, then, once a fresh subscription is confirmed (reconnecting with backoff from 1 s to 30 s), `status {live: true}`, on which the browser syncs what the stream missed.
Changes of availability never queue behind deltas and are never dropped for a slow subscriber: each subscriber is signalled and its stream sends the current state, preceded by `status {live: false}` when live went down and came back before the stream got to it, so a client is never told live is up while it is down, nor misses an outage.
Rows published while disconnected are never silently lost: the sync fetches them from the database (D-117).

### 4.4 Limits and protection

Per-client token bucket (`API_RATE_PER_SECOND` 20, `API_RATE_BURST` 60), request deadline `API_REQUEST_TIMEOUT` 20 s (a request out of time is answered 503, to be asked again), live streams per client (`API_STREAMS_PER_CLIENT` 4) and in total (`API_STREAMS_TOTAL` 2 000), concurrent `/observations` reads per client, whole days included (`API_READS_PER_CLIENT` 4; extra reads wait up to 5 s, then 429) and overall (`API_READ_SLOTS` 8, 503 after 5 s).
A client is an IPv4 address or an IPv6 /64.
The client address comes from `X-Forwarded-For` only through `TRUSTED_PROXIES`, walked right to left (D-014, D-059).

**Database pools.** API requests and ingest use separate connection pools, so readers can never take the connections the writer needs: `DB_API_CONNS` (default 12) is split in two: 2 connections form a background pool for the API process's own work (trend summary refreshes, one of which may hold a connection for minutes; the roster the terrain warmer and weather keeper read; in API-only mode the encoding backfill), so however busy that work is it never takes the connections requests and health checks need, and the rest serve every API request and health check (the terrain and weather fetchers' short, one-at-a-time store reads and writes among them); `DB_INGEST_CONNS` (default 6) serves the writer, the database dedupe fallback, `also_via` updates, identity reloads and the startup re-decode and backfill jobs, which hold one connection at a time.
Each `/observations` read holds an API connection while it streams, so `API_READ_SLOTS` must be at most `DB_API_CONNS − 4` (the background pool's 2, and 2 left for health checks, the history state, node keys, retention bounds, place searches and terrain and weather lookups); startup fails readably otherwise.
Size `DB_API_CONNS` as read slots plus a few, `DB_INGEST_CONNS` as about the worker count when Redis may be down (each worker can wait on a dedupe lookup), and keep their sum, plus 2 for the maintenance process, under PostgreSQL's `max_connections` (D-115).

## 5 The browser engine

### 5.1 Structure

Views are derived in the browser (D-031).
A Web Worker (`frontend/src/derive/`) owns the window's rows and drives a Rust engine compiled to WebAssembly (`frontend/engine`; serde, serde_json, wasm-bindgen; about 1.2 MB, 430 kB gzipped) (D-040).
The server-built views, their Go link-graph and estimator code and the Redis result cache were retired once the engine matched them field by field on recorded live data; that recording is the golden fixture (D-041).

- **Rows never become JavaScript objects.** The worker stages each raw `/observations` page in the engine (staged batches can still be discarded by a fresh start), merges streamed rows as JSON text, and gets views back as UTF-8 bytes (`view_bytes`) that are transferred to the page and decoded once (D-083).
  Strings are interned and packet keys stored as integers.
- **Sync:** after a range's first page, the rest is split into four time slices fetched in parallel (D-040).
  Every UTC day a range touches that ended at least 30 minutes ago comes whole from `/observations/day` (D-158), however little of it the window needs, its rows outside the window held but never shown: whole days come from shared caches (the browser's, Cloudflare, Redis), so only what is not settled yet (today) reaches the database, paged (D-184).
  The order: the part after the last whole day first (it tells the window and the generation the days are asked under), then the days, its remaining slices and the part before the first whole day together, at most four requests at a time (the server's per-client read limit). **Generation hint (D-170):** `/retention` also reports the generation (the page passes it to the worker, never from an offline copy, and each range's first page updates it), so the days are asked under it together with the first request instead of after it; their texts are staged once that request answered and only when it names the same generation, else they are dropped (a stale generation is answered 409) and asked again under its generation.
  Before the engine is ready, as soon as the worker has the hint and the first window and the saved copy is not of that generation, the window's days are fetched ahead (buffered as text) and the first sync takes them; whatever it does not take is dropped.
  Without a hint the order is as above.
  A 409 refetches the range once under the new generation.
  Days go to the browser's HTTP cache (D-160) and into the read-through cache (below).
  A rolling window fetches only rows since the last sync, with a 2-minute overlap for late commits; a fixed window that overlaps what is held fetches only the missing ends.
  Rows more than 15 days older than the newest window are dropped, and the copy is capped at 750 000 rows. **Giving memory back (D-183):** the engine's WebAssembly memory only grows, so dropping rows frees nothing to the browser.
  When a window does not contain the last one synced (a shorter one, or one earlier, later or only partly overlapping; a rolling window that keeps or grows its length contains its earlier self), the store keeps only the rows the new window can use, and the worker copies them into a new instance of the engine (wasm-bindgen's `--experimental-reset-state-function`), re-applying its settings; the old instance's memory is released when the browser collects it.
  The row cap takes the same path.
  The cache below keeps what the engine lets go.
  Live rows that arrive before the first sync are held and merged after it.
  Streamed rows do not advance the coverage mark, so a gap-filling sync (once a minute on a heartbeat, at once after a reconnect or a `lagged` status) fetches anything the stream missed (D-033).
  Syncs run one at a time, and views of the same window and epoch share one.
  A sync is for the views waiting on it: once the page has given all of them up (a newer window, filter or node), a queued sync is skipped and a running one aborted with its requests: a superseded window that has not begun syncing copies nothing (D-183), and one under way fetches nothing further.
- **Live merges append** in place when rows belong at the end; an out-of-order batch is a two-run merge (D-039).
- **One snapshot per rebuild:** a rolling window built in the browser ends just after the newest row held (or at the last sync, if later).
  Each view request carries the page's data revision, and the end is fixed by the first request of that revision: rows keep merging as they stream in, so this is what makes all views requested in one rebuild get the same window and share one memoised snapshot (D-039).
  What health, the node view and the packet log need of the whole window is kept with it rather than redone per request: every packet's radio copies with their transmitters, traceroute hops and downlinks, and (made on first use) radio groups with preset evidence and the routing-reply index.
  They refer to rows by position in the window's filtered rows, which are memoised under the same key.
  The node view takes the node itself (identity, position and staleness, anchor, movement, estimate, counts) from that snapshot, so every per-node rule has one implementation; it builds its own only for a node the snapshot's node cap left out.
- **Read-through cache (D-184):** IndexedDB (database `meshmap-cache`) sits in front of `/observations`, inside the range fetch.
  It keeps whole past days as `/observations/day` sent them, keyed by date: a stored day is complete, since days never change within a generation, so a date is either there or fetched (and then stored as soon as it arrives: a range that fails, as a 14-day window on a poor link may, keeps the days it got, and the next attempt asks only for the rest; the paged part joins the stretch only once the whole range came).
  The 31 most recently used days are kept, and a day not used for 30 days is dropped when the cache opens (a read saves when its day was used, at most once a day), so a visitor back after a long absence finds no stale days.
  A rolling window's paged part (not settled yet: today) is kept as the pages that brought it, one stretch with the range it holds completely; a later range whose paged part starts inside the stretch asks only for rows after it (with the usual 2-minute overlap) and takes the rest from the cache.
  Pieces of the stretch are merged once there are 30, and rows of days that have since settled leave it (they come as whole days).
  Texts are the API's own, read by whichever engine build loads them; each carries its generation, and a text of another generation, or a hint (D-170) that differs from the cache's, empties it and the range is fetched afresh.
  Each write stores its texts and the record describing them in one transaction, so a failed write (quota) claims nothing; the stretch's range and texts are read in one transaction too, and a merge (compressed outside any transaction) is written only if the stretch is still the one it read, so a tab starting the stretch over meanwhile keeps it; another tab closing the database (Settings → Reset) leaves the worker without a cache.
  Nothing is loaded at start: a reload reads the window's days and the stretch through the cache and asks the server only for what is newer, and a longer window after a shorter one (D-183) reads its older days back.
  Offline, with nothing held, the window is built from the cache alone, from its start as far as stored days and the stretch follow one another.
  The cache replaces the copy of the engine's rows kept before (database `meshmap-derive`, deleted on open), which mirrored the engine, was loaded whole at start and had to be tied to the engine build that wrote it (D-102).
- **Worker memo:** views are memoised per revision, older revisions dropped, capped at 24 MB of view bytes (D-045).
- **Failure is visible:** an engine that fails to start fails every view with the reason instead of leaving "Loading window…".
  A WebAssembly trap or worker script error restarts the worker, which syncs again; more than three restarts a minute stops retrying (D-083).
  Worker failures are typed (`not_found`, `bad_request`, `unavailable`, `upstream`, `internal`); a view's `meta` holds `window` and `data_until` (the newest instant the copy covers) (D-058).
- **View types are generated (D-202):** `src/derive/views.gen.ts` holds the TypeScript type of every struct a view serialises, generated from the Rust structs by ts-rs (a dev-dependency: the shipped wasm does not carry it) when the engine's tests run, and committed; CI fails when it is not current.
  Views reach JavaScript as JSON text (serde_json), so the types follow serde's attributes: a field serde leaves out (`skip_serializing_if`) carries `ts(optional)` and is `field?:`, integers are numbers as serde_json writes them, flattened and renamed fields come out as sent, and the snapshot's nodes are its slim form (`MeshNode`).
  Strings the UI narrows to their values (severities, statuses, signature states, route segment kinds) name them beside the field (`ts(type = ...)`).
  `src/derive/views.ts` keeps only what is the worker's own (the `meta` block, typed failures) and builds each view's type from the generated body plus `meta`; a type-checked test fits the golden output to them (D-058, D-083).

### 5.2 Views

| View | Argument | Contents |
| --- | --- | --- |
| `snapshot` | — | Nodes (identity, position, estimate, refined position, track, flags, counts), links (directed edges with evidence, statistics, confidence, 0-cost), MQTT edges, counts. At most 5 000 nodes by default (the most active, by packets sent plus receptions uplinked; each viewer can change it under Settings, D-182) and 20 000 radio edges (MQTT edges come on top; 0-cost, relaying, estimates and the link count use the kept radio edges). |
| `traffic` | — | Distinct packets and receptions per time bucket (§6.16). |
| `node` | node id | The node panel's data (§7.8); for a router, its link quality to other routers per time bin (`router_links`, D-197). |
| `packetlog` | node id | Its own and relayed packets (§6.14). |
| `route` | packet key | One packet's routing graph (§6.15). |
| `reach` | node id, `|internet` | Simulated reach by hop limit (§6.8). |
| `health` | — | Known issues and the airtime estimate (§6.17). |
| `link` | `a|b` node ids | One link's measured readings over time, per direction (D-105), and each end's noise floor when it sends local statistics (D-199). |
| `watch` | node ids, comma-separated | The watchlist's nodes: last heard, quiet, battery, gateways (§7.2, D-192). |
| `regions` | — | The window per landsdel with its nodes' breakdown (§7.8, D-194, D-196). |
| transmissions | live rows | Ping attribution (§7.7). |

Engine rules that changed behaviour after the server views were frozen are options (`silent_rule`, `mqtt_links`, `move_rule`, `signal_rule`, `range_rule`, `origin_rule`), all on by default and switched off only to compare with the retired server views in the first golden test (D-055, D-073, D-136, D-177, D-179).

### 5.3 Live rebuild cadence

Streamed rows reach the worker at once; views are rebuilt debounced.
Rebuilds wait for the stream to pause for 2 s (at most 5 s) on rolling windows up to 6 h, 10 s (at most 15 s) from 24 h, linearly in between; fixed windows use 2 s / 5 s. The delays are at least 20× (quiet) and 30× (ceiling) the last snapshot build, so rebuilds stay around 5 % of the worker's time however large the window grows (D-058, D-083).
Live-window React Query entries use `gcTime` 0, keeping only the previous view as a placeholder; fixed windows keep 5 minutes (D-058).
Pings never wait for a rebuild.

## 6 Derived mesh model

Everything in this section is computed by the engine from the window's rows, after filters (§7.8).
The link graph is directed and weighted; it is never stored.

### 6.1 Nodes

- **Heard** nodes sent something in the window or uplinked as a gateway. **Only named** (referenced) nodes appear only in others' NeighborInfo or traceroutes; they are coloured by when they were last named (`last_referenced`) (D-087).
- **Latest means the newest packet (D-180):** a node's latest identity, position or device telemetry is the packet it sent most recently, by when that packet was first heard (its latest copy is the one shown).
  A gateway uplinking an old packet again later (seen 36 hours on) adds a copy, not a newer packet: its contents are as old as the packet, so it never stands in for the node's current state.
- **Identity** is the latest in-window NodeInfo, else the latest named map report (§2.5).
  Without either, the node shows the last four hex digits of its id.
  NodeInfo rows marked with a key conflict are skipped.
- **Gateway** (`is_gateway`): the node uplinked a reception in the window.
- **Counts per node:** distinct packets it sent; receptions of them by other gateways and its own uplinks, kept apart (map reports count as own uplinks); signatures counted once per packet by its best copy's status (D-087).

### 6.2 Link evidence

Each sample is directed, transmitter → receiver, and kept per direction (D-015):

- **NeighborInfo** (observation): an entry "A hears B" is `B → A` with the reported float SNR.
  One sample per logical NeighborInfo packet however many gateways uplinked it.
  No reverse link is inferred.
- **Traceroute** (observation): each receiver appends its SNR (and itself unless it is the endpoint), so `snr[k]` is measured at the receiver of segment *k* of `[origin, route…]`; a trailing extra SNR adds the final segment to the endpoint.
  Requests run forward from `from`; replies have a forward path `to → route → from` and a return path `from → route_back → to`.
  Placeholder hops break the path.
  There is never an origin–destination shortcut.
  A segment's key is the path up to and including it with its SNRs, not the packet, so a reply that repeats its request's route and the partial copies of one traceroute count each hop once (D-087).
- **Direct reception** (observation): a `direct_rf` reception (§2.2) is `source → gateway`, with the gateway's SNR and RSSI.
- **Relay hint** (pointer, not observation): a relayed RF reception with RSSI/SNR whose last-hop byte resolves to exactly one node R (§6.3) is `R → gateway`, low confidence and inferred.

RSSI comes only from gateway receptions.
A packet uplinked by MQTT without demonstrable RF reception never creates an RF link.
Evidence from before either end's latest move is dropped first (§6.11).

### 6.3 Relay-byte resolution

`MeshPacket.relay_node` is only the last byte of a node number, so collisions are expected; but only nodes within radio range of the gateway can be the last hop.
One resolver (`RelayContext::resolve`, `frontend/engine/src/graph.rs`) serves links, packet logs, routes, reliability and ping attribution alike (D-024, D-039).
So does the gate in front of it: one classifier (`Row::heard_from`) reads the reception reason (hop fields only for rows without one) as direct, relayed (with its byte), downlinked, not radio, or unknown (no hop start), and only relayed or downlinked copies have a byte to resolve:

1. Candidates: window nodes with that last byte, other than the originator and the gateway, and never a node whose role never rebroadcasts (CLIENT_MUTE) (D-040).
   Such a node is left out only if every role it reported in the window was one: a router that turned CLIENT_MUTE relayed while it was a router, and stays a candidate (D-177).
   A byte equal to the originator's own is the originator, or any relay that left the byte as it was: the originator counts as one more candidate that is never ruled out and has no confirmed link, so such a byte resolves only by a confirmed link (step 4).
   Excluding it had let the one other node with that byte take the copy: a Kongsberg router credited at a Sogndal gateway 206 km away, from copies of a node whose own byte it shared, read at −58 to −73 dBm (the signal rule removes it only above about −70 dBm, and not at all while the router has no position in the window).
   Over 72 h of the community mesh 3 % of relayed copies carry the originator's byte; this removes four guessed links of 132 to 303 km into that gateway and a few short guessed ones, and keeps every observed link (D-179).
2. **Range:** drop candidates whose reported in-window position is farther from the gateway than the longest confirmed link in the window × 1.25, at least 50 km.
   Only links seen at least twice, between nodes that did not move in the window, set it: one NeighborInfo report from a node since moved 275 km away once widened it enough to credit a relay 296 km from the gateway, because the true relay, a router turned CLIENT_MUTE, had been left out (D-177).
   Unpositioned candidates stay, because they cannot be ruled out; estimates are never used.
3. **Signal:** the gateway's RSSI of the copy measures the relay's own transmission, so it bounds how far away the relay can be: no farther than where free-space path loss at 869.5 MHz uses up a 70 dB link budget (1 W transmitted, 10 dBi antennas at both ends, 20 dB for an amplified receiver).
   Free space is the best case and the budget is far above legal and typical setups, so no real link is ruled out: −50 dBm allows 27 km, −60 dBm 87 km, −70 dBm 275 km, and below −80 dBm the bound never applies.
   It never goes below 15 km, because a position shared at reduced precision can be kilometres off at both ends (two neighbours read at −17 dBm stood 0.7 km apart by their shared positions, beyond the 0.6 km free space allows).
   Measured against the direct gateway receptions in the log (54 links with known distance), every one lies within it, the closest at 9 % (43 km at −75 dBm into an amplified gateway).
   It caught a relay byte read at −49 to −58 dBm that was resolved to a router 250 km away, because one reading from a travelling node had stretched the range bound to 270 km; such a copy is now left unresolved rather than guessed.
   Copies without RSSI keep the range bound alone (D-136).
   A relay or gateway that moved in the window (§6.11) is unpositioned for this bound: its latest position need not be where it was when the copy was heard, and a mover dropped by it would leave a parked node with the same byte to take the copy, a fabricated link; the range bound still applies (D-153).
4. **Confirmed links:** if several remain, the single candidate with NeighborInfo, traceroute or direct evidence to the gateway wins.
   Relay-hint evidence never counts, so inferences cannot reinforce themselves.
5. Otherwise unresolved: no link, counted as ambiguous or unmatched.

A last-hop byte equal to the uplinking gateway's own low byte is the gateway itself and is ignored everywhere (D-036).
A node whose number ends in 0x00 goes by byte 0xFF, as firmware writes it (0 means "no relay") (D-164).
A byte resolved only because one candidate already had a link to the gateway adds nothing to that same link: no circular corroboration (D-087).
Against traceroute ground truth (378 copies, 72 h), narrowing raised correct resolutions from 87 to 355 with none wrong.

### 6.4 Link confidence and statistics

Confidence counts evidence, not only its kind (D-087):

- **High:** observed at least 3 times (`HIGH_OBSERVATIONS`), or observed in more than one way (NeighborInfo, traceroute hops, direct receptions).
- **Medium:** observed once or twice.
- **Low (inferred):** only relay-byte hints.

Each direction carries its evidence counts, a plain-words reason (shown as a tooltip), sample count, first and last time, and SNR and RSSI statistics (median, min, max, last, n) kept separate, never averaged into a "signal strength".
Repeated uploads of one RF event never raise confidence, since samples are per logical packet or per reception, not per broker.
Links expire at the window boundary, not after an invisible "recently heard" time.

### 6.5 Internet links and MQTT downlinks

A gateway with MQTT downlink enabled takes packets from the broker and transmits them; such packets carry `via_mqtt`, which gateways never uplink, so the flag never reaches us.
They are found indirectly:

- **Downlinker:** traceroutes record the SNR each hop was received at, and a packet taken from MQTT has no radio reception, so it reads exactly 0 dB.
  Genuine readings round to 0 dB too (1–11 % of a node's traceroutes in seven days of data), while the known downlinking gateways were at 52–79 %.
  A node is a probable downlinker when at least 3 distinct in-window traceroutes reached it at exactly 0 dB, making up at least 25 % of those recording an SNR at it (`DOWNLINK_MIN`, `DOWNLINK_SHARE`).
  Being a gateway is not required.
  The node view reports the evidence as `mqtt_downlink {zero_snr, traceroutes}` (D-054).
- **Internet links:** a traceroute hop recorded at exactly 0 dB into a probable downlinker is an MQTT hop.
  Tying the rule to the downlinking node keeps stray genuine 0 dB readings radio and keeps the links consistent with the downlink arrows.
  These samples are split out before relay resolution; MQTT edges (`mqtt: true`) carry no SNR/RSSI statistics, say why in `reason`, and are excluded from estimates, relay resolution, the link count and the radio layers.
  A pair can have both a radio and an MQTT edge (D-055).
- **Downlinked copies:** a copy the gateway received flagged `via_mqtt` was transmitted by a downlinker that took it from MQTT.
  Firmware sends such packets with no hops left, so the gateway heard it straight from the last hop.
  The flag, not the hop limit, identifies them: a relayed copy with hop limit 0 and no flag is ordinary radio (the last relay spent the final hop).
  Packet routes draw origin → last hop dotted green and last hop → gateway as radio; packet-log hop counts leave such copies out and flag them "MQTT"; pings show only the last hop's transmission.
  Since gateways do not normally uplink flagged packets, such copies are rare (none in the current data) (D-087, D-088).

### 6.6 Gateways that uplink every copy

Today's firmware uplinks only the first copy a gateway hears; a future option uplinks every copy, each with its own last hop (and, for traceroutes, partial route).
Storage already keeps such copies apart (§2.6).
A gateway that reported more than one copy of the same packet for at least 3 packets in the window (`MULTI_UPLINK_MIN_PACKETS`), leaving out its own packets, map reports and copies via MQTT or non-RF, is flagged `multi_uplink`; an odd retry does not flag it.
Every extra copy is already a radio sample for links, a hop for routes and a receiver for pings, and makes router reliability (§6.9) closer to the true rate (D-084).

### 6.7 0-cost links

Firmware (`Router::shouldDecrementHopLimit`) lets a ROUTER, ROUTER_LATE or CLIENT_BASE relay without spending a hop when the copy it heard came from one of its favourites that has one of those roles.
The first hop, heard from the originator, always costs one.
Favourites are one node's setting about another, so this is directional (D-068).

- **Evidence:** per packet, gateways report the hop limit each transmitter sent (the originator's for direct receptions, the resolved relay's for rebroadcasts).
  Packet copies are grouped once per snapshot with the transmitter each copy was heard from (`copies.rs`), shared with reliability and health's airtime estimate (D-083).
  For a relay R and a transmitter U that R hears, R sending the same hop limit as U is a free hop for U → R; one less is a spent one.
  A packet counts only when exactly one transmitter R hears explains its value, and never when U is the originator.
  Transmitters with conflicting values in one packet are left out, as are pairs where a known role rules the rule out.
- **Threshold:** `zero_cost.likely` needs at least 3 free packets (`MIN_FREE`) making up at least 80 % of the evidence (`MIN_SHARE`), since a transmitter no gateway heard can mislead single packets.
  Edges carry `zero_cost {free, spent, likely}` whenever there is evidence.

### 6.8 Reach

When a node is selected, the Reach section of its panel simulates how far its packets get at each hop limit (D-069):

- A packet leaves with hop limit H. Nodes that hear the originator receive it with H left.
  A node relays only what it received with more than 0 left, spending a hop, except across a likely 0-cost link (§6.7); the first hop always costs.
  CLIENT_MUTE never relays.
  A shortest-path search over directed links (the receiving end heard the transmitting end) gives each node the smallest H that reaches it and the transmitter it hears it from.
  Inferred links stay out, as guesses; internet links stay out unless "Count internet links" is on.
- The slider runs 0–7 (`MAX_HOPS`), starting at the hop limit the node's own packets used.
  The panel shows the nodes reached, how many each step adds, and how many came through 0-cost links.
- "Show on the map" replaces the links with the reach paths up to the chosen limit, coloured by hop, and dims unreached nodes.
  A placed node is drawn from the nearest placed transmitter up its chain, dashed where unplaced relays were skipped.
  A new selection or a packet route clears it.
- The panel states the caveat: only links observed in the window count, intermittent links count as always there and unseen links are missing, so it sketches the mesh as observed rather than predicting coverage.

### 6.9 Router relaying

For each ROUTER and ROUTER_LATE, how often it is seen relaying what it should relay (D-078):

- **Expected:** a router rebroadcasts every packet it receives with hops left.
  It received a packet when it uplinked it itself as a gateway with hops left, or when a transmitter it hears on a high-confidence link (3 samples or more) sent it with hops left.
  Its own packets and packets addressed to it do not count.
- **Seen:** a gateway reports a copy whose last-hop byte resolves to it, or a traceroute lists it.
- **Observability:** a packet counts only where a witness (a gateway that hears the router directly, medium or high confidence) uplinked it at all.
  Gateways uplink only the first copy they hear, so the router's rebroadcast stays unseen whenever another copy reached the witness first.
  The share is a lower bound, comparable between routers of the same role and coverage, not an absolute reliability; ROUTER_LATE's copies are often second by design.
- **Shown:** seen of expected ("packets it probably received") and the share, the median for routers of its role when at least 3 have 10 or more expected packets, its witnesses, and how much rests on its own uplinks.
  Under 10 expected packets (`MIN_EXPECTED`) it says too few to judge, and no share is shown when nearly all receptions are inferred (D-087).

### 6.10 Positions

- **Reported positions** come from Position packets and map reports in the window; both feed every position consumer (latest position, history, anchors, movement).
  When a node has both, its latest Position and latest map report are compared: if their precision circles (worst-case error for each one's precision bits) overlap they agree and the more precise one is used (the newer on a tie); if not, or when either precision is unknown, the newer one is used.
  The chosen position reports its `source` (D-032).
- **Impossible positions (D-178):** a Position packet heard directly by a gateway is no farther from that gateway than the signal rule's free-space bound for the copy's RSSI (§6.3: 70 dB budget, never below 15 km), widened by how far either shared place may be off at its precision.
  The gateway's place is its own position report nearest in time to the reception.
  When most gateways that heard a packet directly and have a place put its reported position beyond the bound, the packet is no position at all: no place, staleness, history, anchor, movement, link range or estimate uses it, and the node keeps an earlier report or is estimated.
  One gateway with a wrong place of its own cannot outvote the rest.
  Health warns (`position_contradicted`) and the node panel says which gateway ruled it out.
  Seen: a node's first position, 63.3930, 63.3930 (latitude repeated as longitude, 2,560 km east), heard directly at −43 dBm by a gateway at 63.3930, 10.4268; and a report 76 km south of where the same node reported three minutes later, heard directly at −53 dBm 77 km from the gateway (bound 45 km).
  In 29 days of the community mesh no other report was ruled out.
  Map reports travel over MQTT and are never judged.
  Off with the signal rule.
- **Stale positions (D-094):** when a node's newest position report (Position packet or map report) is more than 24 h older than the window's latest observation (`STALE_POSITION_MS`), or 7 days for a fixed node (`STALE_FIXED_POSITION_MS`), its reported position is stale.
  A node is fixed when none of its reports in the window disagree (no farther apart than a move, so GPS noise does not count, §6.11) and it either announces a role that sits in one place (ROUTER, ROUTER_LATE, CLIENT_BASE) or has agreeing reports at least 6 h apart: mountain-top routers may report their position only every day or two while their links stay current, and a day's limit left whole router chains off the map (D-138).
  A stale position is no anchor, plays no part in relay range checks, is never narrowed (§6.10 narrowing applies only to a current position), and the node is estimated like an unpositioned one (§6.12).
  When no estimate can be made, the node is left off the map (listed under "Without position"): a marker at an old place would draw misleading links.
  Either way it is reported as `stale_position`, and Details says the position is stale, with its time.
  The window's latest observation, not the clock, is the reference, so historical windows judge staleness within themselves.
- **Precision error** is half the diagonal of the reported precision cell (firmware reports the cell's centre): about 0.8 km at 15 bits at 63°N, 0 at 32 bits.
  It is shown as ± distance; altitude is above sea level.
- **Narrowing noisy positions (anchored nodes):** with at least 5 reports (one per packet) in the window, a node is anchored when its most reported place and the reports near it (within the move threshold, §6.11) hold at least half of its reports and at least two of its latest three, so it is home now.
  Precise GPS readings never repeat exactly, so for a fixed node (a ROUTER, ROUTER_LATE or CLIENT_BASE) with no repeated place the report nearest all the others (the medoid) stands in for the most reported place; other nodes keep the most reported place, since a slow, steady mover's readings cluster around their middle too (D-139).
  Precise readings (24 bits and finer) are averaged, with an error from their spread; for truncated cells, the most reported cell among the agreeing reports at the node's finest precision is chosen (ties: the latest); the latest report wins only when it is finer.
  The result is reported (`refined`) only when it narrows the position or sets reports aside; the map places the node there, the selected node's accuracy circle uses its error, it feeds relay range checks and estimates, and the panel says "Narrowed to … from N of M reports; K outlying ones set aside as noise" (D-077).
- **Arriving from a trip (D-181):** an anchored node's reports away from home are noise, except a trip: at least two reports in a row, before its current stay, farther from its place than 5 move thresholds (5 × (300 m + 1.5 × both errors): about 25 km at 14 bits, 1.6 km for precise GPS).
  Then it moved: `moved_at` is its first report after the trip, so links keep only evidence from its stay (§6.11), it keeps its narrowed place, and it is never airborne, being at rest.
  One far report alone stays a spike.
  Seen: a node that ran traceroutes from an aircraft descending into Oslo (9,949 m, 323 km away) and then settled at a place it reports at 818 m drew those contacts from where it sat afterwards, as no movement was judged for an anchored node.
  In 29 days of the community mesh 14 nodes arrived this way, all from trips of 14 to 490 km.
- **Never finer than shared.** Positions shared with reduced precision keep it: narrowing is never finer than the node's own finest report in the window, and no route (narrowing, estimates, combining sources) raises a node's effective public precision.
  Nodes coarser than the anchor threshold are never anchors (D-077).

### 6.11 Movement, trails and airborne nodes

- **Moving:** a node's reported positions in time order, one point per distinct place.
  Drift is measured from where the node last settled, so slow movers' short steps add up; it moved when the distance exceeds 300 m (`MOVE_M`), or 2 km for a fixed node (`FIXED_MOVE_M`: an unstable GPS on a router wanders hundreds of metres, and routers rarely move; D-139), plus 1.5 times both positions' worst-case precision error, because a 13-bit position can jump a whole cell while the node stands still.
  Each move makes that position the new reference, and the latest move is `moved_at`.
  Movement is judged on the node's finest positions with at least two distinct places, so precise Position packets are not held to coarse map reports' threshold.
  An anchored node (§6.10) does not count as moving; for others, a single reading far from the ones either side (which agree) is a GPS spike, and an excursion needs two reports (D-073, D-077).
- **Links reset after a move:** radio evidence (NeighborInfo, traceroute hops, direct and relayed receptions) from before either end's latest move is dropped before links are built, so relay resolution and estimates use only current links too (D-073).
- **Trails:** moving nodes carry `track` (up to 100 points, `MAX_TRACK`).
  The map draws the last three places before the marker, fading towards the oldest, with chevrons pointing the way it is going ("Position trails", off by default; with a node selected, only its trail).
  The full track stays in the data for packet routes.
  The panel says when it last moved (D-073).
- **Airborne:** reported altitude above 750 m (`AIRBORNE_M`) **and** moving.
  Altitude alone would flag fixed mountain sites; noisy GPS alone would flag stationary nodes.
  The badge is an airplane at the marker's upper left, clear of a gateway's uplink badge (D-073, D-186).

### 6.12 Location estimates

An estimate is "somewhere around here", never GPS (D-016, D-025):

- **Targets:** nodes without an in-window reported position (coarse public positions are never refined). **Anchors:** in-window positions with known precision ≥ `GEOLOCATION_MIN_PRECISION_BITS` (default 15, the common coarse public setting), not in `GEOLOCATION_EXCLUDE_NODE_IDS` (excluded nodes are neither anchors nor targets). **Measurements:** links with NeighborInfo, traceroute or direct evidence; relay-only and internet links are excluded.
- **Gates:** ≥ 3 anchor sites, ≥ 5 samples, spread ≥ 500 m, minor/major axis ratio ≥ 0.2 (non-collinear); anchors more than 150 km from the median are dropped as outliers.
- **Sites (D-175):** anchors less than 200 m apart (`min_anchor_spacing_m`) are devices at one site, one viewpoint: they are merged into one anchor rather than counted twice, and they never block the estimate (one shared roof used to refuse a node however many other anchors heard it).
  The site's position is the sample-weighted mean of theirs, its imprecision covers each of theirs from there, its samples add up, and its SNR and RSSI are sample-weighted means; the estimate says which were merged.
- **Uncalibrated (default):** SNR-weighted centroid of the anchors, `quality: very_low`, radius max(mean anchor distance, 2 km).
- **Calibrated** (`GEOLOCATION_CALIBRATION` YAML with `default: {p0_dbm, path_loss_exponent}`): Levenberg–Marquardt on log-distance ranges from RSSI with Huber weights; uncertainty from max(observed misfit, 6 dB) shadowing propagated through the model, floor 500 m; `quality: low`.
  In simulation (4 anchors, 4 dB shadowing) every placement fell within twice the reported radius.
- The largest anchor's precision error is added in full to the radius (worst case: every anchor shifted the same way), and the reasons say so.
  Coordinates are rounded to 0.001° and radii to 100 m. Every unpositioned node without an estimate carries an `estimate_note` explaining why (e.g. "no confirmed direct links to nodes reporting a position with at least 15-bit precision").
- **Ranging, for one-sided anchors (D-143):** a weighted centroid cannot leave its anchors' hull, so a node heard only from one side is placed too close to them.
  The engine fits SNR = a + b·log10(km) over the window's router-to-router links between anchors whose cross section is clear (§6.19): per link, the mean of its two directions' median SNR, links heard one way only left out; at least 8 links, and b must be negative.
  When the uncalibrated centroid leaves more than 135° without an anchor, seen from the centroid, it is moved to where the anchors' distances best match the ranges their SNR gives (least squares in log distance, grid search), each range capped at the anchors' mean distance from the centroid: a weak link may say "not close", never "very far".
  A best fit within 100 m of the centroid is no move, and the centroid stands.
  The method is then `ranged_centroid`, still `quality: very_low`, and the reasons give the widest gap, how far it moved and the fit.
  On the production data (32 days) links scatter about 6 dB around the trend, so a range is good to a factor of about 2; the cap keeps a wrong one from throwing the estimate far.
  A node surrounded by anchors is never moved.
- Estimates are recomputed for every window and rebuild; settings come from `capabilities.geolocation` so the browser applies the operator's rules (D-031).

### 6.13 Channels, regions and presets

- **Region from the topic** (D-044): the segment after `msh`.
  Norway's `msh/EU_868/NO/...` allows either EU_868 or EU_N_868; other roots name one region.
  A node's summary keeps only regions every topic it was heard under allows, since everything on a radio link shares frequency settings; contradictions are reported.
  A node's own map report states its region exactly and is shown first.
- **Channels** (D-064): a gateway uplinks a reception under the name of its own channel whose hash the packet carried, so each reception names a channel the sender transmitted on (`sent`, distinct packets) and one the gateway has (`uplinked`).
  A map report names the node's primary channel.
  The panel lists channels, primary first.
- **Radio groups:** nodes that hear each other share modem settings.
  Direct receptions, NeighborInfo entries and traceroute hops join nodes into groups; relay bytes and 0 dB traceroute hops do not.
- **Preset, strongest evidence first:** the node's own map report, but only when `has_default_channel` confirms a preset is in use (firmware fills `modem_preset` even with `use_preset` off, and LONG_FAST is the zero value) (D-063); confirmed reports of its radio group (all agreeing, otherwise "conflict" with presets and counts); a channel it was heard on with a preset's default name (LongFast, NarrowFast, …, case-insensitive); the default channel names most of its group was heard on (ties go to the first by name).
  The last two are hints, since a secondary channel can carry such a name.
  The panel separates direct radio contacts from the whole group and names the nodes the evidence rests on (D-064, D-087).

### 6.14 Packet logs

The selected node's panel lists its packets, built from the window's filtered rows (D-036): one combined log, newest first, up to 200 own and 200 relayed entries (`MAX_LOG`), 50 shown at first, with an "Include relayed" toggle (off by default).
While the window is live, a packet involving the node shows in the log as soon as it arrives, before the views are rebuilt (§5.3): its own packets and those addressed to it from the streamed row, and packets it relayed from the same attribution that draws its ping, so a row appears as the ring plays.
Such a row is dimmed, with "…" for the details, until the next rebuild replaces it with the full entry (or drops it, when the rebuild finds otherwise).
Rows that arrive while the log is open slide in under a fading highlight (the highlight alone with reduced motion); what is there when the log opens, or appears with the relayed toggle, does not.
Its columns can be resized by dragging the right edge of a header (or arrow keys on that handle; double-click or Home resets the column); the widths are remembered in the browser and cleared by Settings → Reset.

- **Traceroute replies replayed (D-106):** a reply carries its request's id and records the way the request travelled (requester → route → target, with the SNR at each receiver).
  When a reply arrives live, that forward route animates as the request's transmissions.
  Every transmission names its packet as origin and id.
  When the request was already seen travelling live, its copies show only the way to the gateways that heard it, so the replay adds just the hops they did not show (D-174): a hop shown live is skipped, a hop from a transmitter whose live ring is still on the map joins that ring as a new receiver (the ring grows on to it), and any other hop plays as a replayed ring that waits for the live ring reaching its transmitter.
  A late live copy of the request is skipped after its replay, within two minutes.
  Hops into a probable downlinker at exactly 0 dB went over the internet and travel as a dotted gap (D-173).
  The reply's own way back leaves the target only once the request's ring or gap, replayed or seen live, has reached it, however far the request is still spreading elsewhere, so the request is always drawn arriving before the answer sets off.
  A ring waiting for another counts its time limit from when that ring starts, so a long replayed route plays hop by hop to the end.
- **Delivery (D-096):** an ACK proves its sender received the packet it answers, by whatever path.
  The packet's route gains a dashed mint "delivered" segment from its origin to each node that acknowledged it (unless a hop between them is already drawn), and the route note names them.
  A live ACK animates as a delivery: a mint line travelling from the original sender to the acknowledging node, which flashes twice on arrival; it is no radio transmission, so it draws no ring.
  Both ways are drawn, one after the other (D-172).
  First the answered packet's way, from its in-window copies of the last 15 minutes: the way there through its routing graph (§6.15) to the acknowledging node, known hops preferred over dashed ones.
  When no hop of the graph reaches that node, which is the rule for a node that is no gateway, where it heard the packet from is not known, and the line runs dashed straight from the sender, as the graph's delivered segment.
  A packet already animated (live or replayed, within 2 minutes) does not travel a second time: the ACK goes back once that packet's pings have arrived (no ring still growing, no rebroadcast or gap still waiting, at most the collection time), and one that travels this way counts as animated, so a late live copy of it pings no more.
  Once the packet has arrived, the ACK goes back along its own routing graph, from its copies so far, to the sender, again dashed where that part is not known (from wherever the gateway heard it on, unless the sender is a gateway itself); a later copy of the ACK can still extend that way until it starts.
  Each hop is solid, dashed or dotted as the graph draws it, the head moves along each way at one pace (a few hops take a little longer, at most 5 s each), each end flashes as a line reaches it, and unplaced nodes on the way are bridged, dashed.
  Errors prove nothing and are not animated.
- **Delivery by recipient (D-109):** rows carry whether the sender asked for an acknowledgement (`wa`, row format 8).
  The Packets tab counts, per recipient, the node's direct packets that asked: how many were confirmed (with the share) by an ACK or by the recipient's reply (traceroutes ask for an ACK but are answered with their reply), answered with an error instead, and ACKed only after a retry (several ACKs for one packet).
  Only packets and ACKs a gateway reported count, so the numbers are lower bounds and a blank never means lost.
- **Delivery reports (D-092):** routing packets carry their outcome in rows (`rt`: ACK or error with the firmware reason, and the id of the packet answered).
  A routing packet is addressed to the original's sender and carries its packet id; an error can come from a relay, so the answering node need not be the original's destination.
  Own packets show ✓ (ACKs only) or ✗ (an error) in a Re column, with who answered and how often (a retrying sender gets each copy answered); a blank never means lost, since an ACK may reach no gateway.
  Routing packets show ✓ ACK or ✗ reason, in plain words, with ↩ to the answered packet when it is in the window.
  Routing packets and encrypted direct messages addressed to the node are listed as "to it".
  Details sums them up as "Delivery reports": ACKs and errors by reason, sent and received.
- **Own packets:** one entry per logical packet: time, type, destination, fewest hops any gateway saw, gateways, signature.
  Hops and gateways leave out its own uplink ("self" when only it uplinked); downlinked copies are left out of hop counts and flagged "MQTT" (D-087).
  A packet it sent in answer to another node's (a traceroute reply, an ACK or error) says so in the From column: "own, in response to" that node, linked; it did not send it of its own accord.
- **Relayed for others:** other nodes' packets it passed on, where a gateway's last-hop byte resolved to it (§6.3) or a traceroute's recorded route lists it.
  The uplinking gateway appends itself to the route it reports; that trailing entry only received the copy and is not counted.

### 6.15 Packet routes

Selecting a packet in the log draws its routing graph from every in-window reception of it (rows sharing its logical key), as directed transmitter → receiver segments (D-037):

- **Traceroute:** the recorded route, with the gateway appended unless it recorded itself.
  A request's copies end where each was uplinked, so the request also gets the route its replies recorded (requester → route → target, the reply's record of the way there): its whole way to the target, when a reply was heard.
  A traceroute is drawn both ways, each segment tagged with its `leg`: the way there (`forward`: the request's copies and the route each reply recorded) in pink, the way back (`back`: the replies' copies, ending where each was uplinked) in blue, neither in the orange of other routes.
  A reply's own route has both legs too.
  Each leg is drawn beside the line between two nodes, to the right of its own direction, so a hop taken both ways shows twice, and unplaced nodes are bridged within a leg, never across the two (D-134).
- **Zero-hop reception:** sender → gateway.
- **Resolved relay:** relay → gateway, and sender → relay, solid only when one hop was spent by a relay whose known role cannot receive at zero cost (the ping rule, §7.7).
- **Unresolved relay byte:** sender → gateway, dashed.
- **Downlinked parts:** dotted green, "internet" (§6.5).
- Packets the sender uplinked itself and MQTT or non-radio transports add nothing.

A segment is **solid** when both nodes are known to be adjacent and **dashed** when nodes between them are missing (an unrecorded hop, an unknown relay, the unknown path from the sender to a relay); a solid segment wins over a dashed one, and hover says which case it is.
Unplaced nodes are bridged: each placed node joins the nearest placed node before it in the route, dashed across those skipped, and the route note names the nodes without a position.
A route carries when the packet was first heard (`at`); nodes that have moved since are drawn where they were then, with a ring there and a dashed line to their marker now (D-073).
All links are hidden while a route is shown, and the map frames it once.

### 6.16 Traffic and counts

- **Traffic buckets:** distinct packets and gateway receptions per bucket, the bucket chosen from a fixed ladder (1 min, 5 min, 15 min, 1 h, 6 h) to stay within 600 buckets.
  Several gateways hearing one packet never inflate packet counts.
- **Header counters:** nodes heard, only named, positioned (reported in the window), estimated, links (node pairs, as drawn, whatever the link filters show), distinct packets and receptions; each has a tooltip saying what it counts (D-087).

### 6.17 Mesh health and airtime

Rules over the window's rows and snapshot flag known problems per node (`health` view, `engine/src/health/`, one module per rule or family of rules, D-095).
Each issue has a severity (problem, warning, notice), a one-line summary and an explanation.
Rates use the span the rows cover when shorter than the window.
Thresholds are constants in each rule's module, re-exported from `health/mod.rs`:

- **Traceroute flooding:** ≥ 4 requests/h and ≥ 10 in the window (warning), ≥ 10/h (problem).
- **Large airtime share:** its packets with their rebroadcasts cause ≥ 10 % of the estimated airtime (warning).
- **Busy channel:** reported channel utilisation ≥ 25 % (warning), ≥ 40 % (problem); transmit airtime ≥ 10 %, the EU hourly duty cycle (warning).
- **MQTT downlink:** a probable downlinker (§6.5) (warning).
- **Moving gateway (D-161):** a gateway that moved in the window (`moved_at`, §6.11) (warning): gateways' receptions place nodes and draw links, so evidence from one on the move is weaker, and its topic root, set for one region, travels with it.
- **Topic root and region (D-161):** a gateway with a current reported position in one of the regions (landsdeler, the Regions layer's outlines in `frontend/src/assets/regions.geojson`; the worker fetches that same content-hashed, precached file once and hands it to the engine, which skips this rule until it has; a point within 15 km outside every outline counts for the nearest, since the outlines are simplified and drop islets) that uplinked in the window under a root naming another region (warning), misspelling one (warning, naming the exact spelling) or naming none (notice).
  A root names a region only when one of its segments is exactly `Nord-Norge`, `Trøndelag`, `Vestlandet`, `Østlandet` or `Sørlandet`: case counts, and no substitute for æ, ø or å is accepted, so `Ostlandet`, `trøndelag` or `NordNorge` name no region and are reported as misspelt.
  Gateways abroad or without a reported position are not judged.
- **Different preset than the mesh:** the mesh's preset is the one most packets' default channel names imply (each packet once per name); a node the panel's preset inference (§6.13) puts on another, by its own or its radio group's confirmed map reports, or by a channel name when it has at least 3 packets and none was heard on a channel named for the mesh's preset (warning).
  Health and the panel share the one inference, so they never disagree.
- **Hop limit higher than needed:** a hop limit of 6 or 7 at least 3 above the hops within which gateways heard 95 % of its packets (≥ 20 packets).
  Gateways are only part of the mesh, so this is a notice with a suggested limit.
- **Possible impersonation (D-108):** 3 or more packets claiming to come from a node that failed signature or key checks (`invalid` rows with a verification reason; decoding failures do not count), a warning naming the reasons and how many gateways reported them.
  When all of them announce a different key than the trusted one, the explanation says the node was most likely reset and has a new key.
- **Battery falling (D-099):** for routers and base stations only (ROUTER, ROUTER_LATE, CLIENT_BASE; a handheld drains and is charged as it is used), a least-squares trend over at least 8 device reports spanning at least a day, falling 5 % a day or faster; a warning at 50 % or below or when empty within a week at that rate, else a notice.
  The daily swing of a healthy solar node stays well under that.
- **Shared public key (D-142):** ids whose identities announce the same key (the same `key_id`) with their own packets overlapping by at least 30 minutes: devices set up from one backup or a copied key, which can read each other's direct messages and on 2.8 take the same id.
  Anyone can announce any key in an unsigned NodeInfo, so a node whose NodeInfo verified (it proved holding the key) is never flagged; an id announcing its key is, a warning, also when it overlaps only another such id while the holder is silent.
  When none proved it (firmware 2.7 and earlier cannot), a copy cannot be told from a forged claim, and each id gets a notice saying so.
  A key passed on, by an upgrade to 2.8 or a restore onto new hardware, leaves the old id silent first and is not flagged.
  Both ids must also take turns sending at least 4 times in time order: an upgrade followed by a rollback to 2.7 (or a second upgrade) spans the new id's time with the old id's but switches at most three times, and is not flagged (D-154).
- **Silent infrastructure (D-188):** a router (ROUTER, ROUTER_LATE, ROUTER_CLIENT, REPEATER) or gateway heard in the window that has not been heard since for at least 3 hours and 4 times its usual gap between transmissions or uplinks (the median gap, from at least 4 events a minute or more apart; its own packets count once each, at their first copy, so a late copy is not the node speaking again), measured to the newest data in the window, not the wall clock, so an outage of the service itself flags nothing (warning).
  Its events come from all the window's valid rows, whatever the type, channel and broker filters: they choose what the views show, not whether a node is alive.
  Nodes that moved in the window are left out: they come and go by design.
  The Health panel lists them longest silence first; the explanation gives the last device telemetry (battery, voltage, uptime) and, for a gateway, that its uplinks stopped too.
  A node silent for the whole window is not in it at all, so it cannot be listed (§3.5).
- **Router role review (D-189):** notices from the window's radio links (medium confidence or better, not inferred, not over MQTT), which show only what gateways reported, so each says to check on site. *Routers covering the same nodes:* a ROUTER or ROUTER_LATE with at least 5 radio neighbours, 90 % or more of them also neighbours of another router it hears; of two that cover each other only the one with fewer neighbours is named. *Routers with little reach:* exactly one radio neighbour over at least 20 of its own packets (with none, nothing is known of its reach and the isolated rule speaks for it). *Several relays at one site:* nodes that rebroadcast (any role but CLIENT_MUTE), not moving, reporting positions precise to 18 bits or better within 100 m of each other; all but one (a router first, then the most radio neighbours) are suggested for CLIENT_MUTE, which still sends its own packets.
  A site forms around the relay to keep, taking the nearest free nodes within 100 m of every member so far, so all its members are within 100 m of each other and a chain of relays 90 m apart is several sites, not one long one.
  On three days of production data the thresholds named 11 overlapping routers with 3 or more neighbours, 7 with 5 or more; the higher bar was kept.
- **Router link drop (D-197):** a sudden, lasting fall in the SNR of a router's (ROUTER, ROUTER_LATE, not moving) radio links to other routers, a warning.
  Prompted by Vassfjellet (!997b0449), whose links fell about 12 dB both ways between 05:00 and 07:30 UTC on 1 Nov 2026 (antenna or cable after rain and gusts; no restart, no move) and never recovered, with no rule noticing.
  The readings are the `link` view's (D-105): each RF event once, radio only (MQTT hops are links of their own), from NeighborInfo, traceroute hops, direct gateway receptions and relay hints (the resolved relay's SNR at the gateway), as an edge's SNR median counts them (§6.4).
  Each link direction is compared only with itself, before and after one change point, so a change in which partners happen to be heard cannot fake a drop. *Change point:* every 15 min from 3 h after the router's first reading to 6 h before the newest data in the window, the sum over link directions with at least 5 readings each side of (mean after − mean before) × n_before·n_after / n, so dense links place it and one with a handful of readings cannot; the lowest sum is refined to the reading within 3 h of it where the links' medians over 6 h either side fall most (at least 3 readings each side), which must still be 6 h or more before the newest data. *Flagged* when, of at least 2 link directions with 5 or more readings each side, at least half fell by 6 dB or more (median after − median before; the upper median of those changes is the drop reported), the ones that fell reach at least 2 other routers, and over the last half of the time since the change the links were still 3 dB or more down (the upper median, over link directions with at least 3 readings then).
  A rise never flags, nor does a dip that recovered, a fall only hours old, or a fall on the links to one partner alone (that path or that partner).
  Links lost altogether (partners heard before, none after) are not flagged: which routers show up in traceroutes changes with who runs them.
  Thresholds are `LINK_DROP_*` in `health/link_drop.rs`.
  The summary gives the drop and its time ("Router links 9 dB weaker since Nov 01 06:44" for a viewer in Norway): the engine knows no time zone, so it writes a time as a mark (`{{t:<Unix ms>}}`, `util::time_mark`) that the page writes in the viewer's zone wherever issue text is shown, watchlist notifications included (`localizeTimes`); the explanation lists each link direction judged with its medians before and after and their readings, and advises checking the antenna, cable, connectors and mount, noting that icing can do the same until it melts.
  The coarse search is one sweep over prefix sums, linear in the readings; medians are taken only for routers whose links' means fell 3 dB or more. *Calibration* on production rows from 28 Oct to 8 Nov 2026 (160 000 rows, 53 routers), in 26 windows (72 h and 168 h, every 12 h): Vassfjellet was flagged in all 15 windows holding its change with 6 h or more after it, always at 05:44 UTC, about half an hour before its first weak reading (06:19; the last strong one came at 05:51), 8–10 dB down (in the week to 4 Nov: heard by Bringebærpai +10.0 → +1.5 dB, by Smv Risvollan +6.2 → −5.2, by NVE1308 +5.5 → −6.6; hearing Oftenåsen +2.0 → −9.2, Gråkallen +6.9 → −3.2, NVE1308 +10.2 → +3.0).
  The only other router flagged, NVE1309 (3 windows, 6–7 dB since 3 Nov about 03:00 UTC), had four link directions to three routers fall about 12 dB for some 15 hours and stay 4–5 dB down for two more days: a real, temporary loss of the kind weather causes.
  In a prototype of the rule, a threshold of −4 dB added one router (−4.2 dB on two links), and without the two-partner and still-down checks it also flagged a partner's fall seen from the other end and a day-night swing on one link.
  On 192 h of production rows (110 000) health takes about 30 ms, 2–3 ms more than without the rule.
- **Burst (D-209):** 15 or more of a node's own packets (first copy each) within any 15 minutes, of any type and moving or not, a warning: one a minute or faster, kept up.
  Conversation is not counted (text and direct messages, and the routing ACKs and NAKs they get), nor traceroute replies, which answer others' requests; encrypted packets on channels without a key are.
  The summary gives the densest run's count; the explanation its packets by type, average gap and times, and what to check (position, telemetry and NodeInfo intervals, the smart broadcast minimum interval, a restart loop).
  Prompted by !04414588, a phone sending a position about every 30 s while driving, which the hourly rates missed: 0.4 positions an hour over two weeks, and moving nodes are exempt from that rule.
  On production rows from 27 Oct to 10 Nov 2026 (210 000 rows) it flags 9 nodes: that phone (29), two nodes sending encrypted packets on private channels every 30 s (25, 24), a boot loop (NodeInfo and telemetry every minute and a half, uptime resetting; 20), manual traceroute runs (15–18) and bursts of NodeInfo; counting conversation as well, people chatting topped the list with up to 65.
- **Restarts (D-099):** uptime going backwards between reports, beyond what the time between them explains; a notice, a warning from 3 restarts.
  Constant zero uptime is not a restart.
- **Notices:** no other gateway reports it (≥ 10 packets, only its own uplinks); remote-admin requests refused by ≥ 2 nodes; uplinks arriving unencrypted; positions > 4/h (not when moving), NodeInfo > 1/h or device telemetry > 4/h; a stale position (§6.10); battery ≤ 15 %; a short name shared with another node (not between ids announcing the same key, which are one device, §6.17 shared public key).

**Airtime** is estimated per packet as one transmission by its sender plus one per distinct relay seen (resolved last hops, traceroute routes), each costing its estimated on-air size (16-byte header, payload, Data wrapper when decoded, 66 bytes when signed) plus about 20 bytes' worth of preamble.
Only shares are reported: of the window's total by packet type, and per node the share its packets cause and the share it transmitted itself (its own packets and relays).
Relays no gateway heard are missed, so it is a lower bound and a guide to proportions.

**Store and forward (D-103)** gets its own breakdown: its share of the airtime, packets and share by message kind (heartbeats, replayed broadcasts and direct messages, history announcements, requests, …), and per router its share, heartbeats per hour and history replays with their text size.
A router whose store-and-forward takes 2 % of the airtime or more gets a notice.

The **Health panel** lists every issue grouped by kind, most severe first, with node links, other nodes named in the text, and each issue's explanation opening under it (▾; also on hover), then airtime by packet type and the ten nodes causing the most. **Details** shows the node's issues under its name and its airtime as a row.

### 6.18 Weather

Weather explains readings that radio evidence cannot: a router's enclosure warming in the sun, a link's SNR dropping in heavy rain or snow (D-133).

- **Source:** MET Norway's MET Nordic analysis, hourly on a 1 km grid over the Nordic countries, archived since 2012 and served over OPeNDAP without a key (CC BY 4.0): air temperature, precipitation, relative humidity, cloud cover, wind speed and sunlight (downwelling shortwave radiation reaching the ground, so lowered by cloud as it actually was; the hour's mean in W/m²).
  It is an analysis of observations, not a forecast, so past windows get the weather that was.
  It has no gusts; those come from MEPS, MET Norway's 2.5 km forecast model, as the strongest gust in the hour from the newest archived run that covers the hour within its first hours (runs start every 3 h and reach the archive a few hours late, so an hour without a gust is asked again for up to 12 hours; one whose gust request failed is asked again after 10 minutes whatever its age, and is not stored until it succeeds, D-152).
  One request reads a run's first nine hours at a cell, and the hours after reuse it.
  Outside the grids there is none.
- **Which nodes:** ROUTER and ROUTER_LATE nodes with a current reported position (§6.10); the narrowed position is used when there is one.
  They are few and stay put, so each hour of each site is fetched once.
  Whether a router moved is not checked: none did in practice, and one that does gets the weather at its latest position.
- **Kept ready:** every 20 minutes the server lists the live routers from the log itself: from the router roster it shares with the terrain warmer (§6.19; nodes whose latest NodeInfo or map report in the longer of the longest window and 14 days says ROUTER or ROUTER_LATE, unsigned NodeInfo marked `identity_untrusted` not counting (§2.4), at their latest reported position, 0,0 being none; read at most every 20 minutes, `storage.Roster`), those that sent anything other than an `invalid` row in the last 24 hours.
  It queues the hours of their cells over the longest window that it has not got, so visitors find the weather ready.
  Routers that fall silent or stop being routers drop out, so their sites are no longer fetched.
- **Fetching:** the browser asks `/api/v1/weather` for a site's hours over the window, rounded out to whole hours.
  The server turns the point into a grid cell and sends MET Norway only the cell's indices.
  Hours come from memory (at most 200 000), then from `weather_hour` (§3.7), and only then from MET Norway, so a restart or a second API process fetches nothing twice.
  The archive answers 429 to parallel requests, so one worker fetches queued hours in turn, newest first, pausing 100 ms between requests and waiting when asked to, and stores each one.
  Visitors' hours go ahead of those queued to keep routers ready.
  Each visitor (the client the rate limits count: an address, or an IPv6 /64) has its own queue, and the worker takes one hour from each in turn, so a client asking for every cell over months delays another's few hours by one fetch each.
  A visitor may have 5 000 hours waiting; when all visitors' queues together hold 20 000, a newcomer's hour displaces the last hour of the visitor holding the most.
  The endpoint is not limited to router sites: the browser places a site at the engine's refined position, and historic windows show routers that have since moved or fallen silent (D-141).
  Settled hours are kept for good, unless stored by an older version that lacked a quantity added since (`weather_hour.version`), which is fetched again; an hour fetched within three hours of its time is asked for again after 20 minutes, since it may be re-analysed, and one not yet published after 10 minutes.
  Until every hour is in, the answer says `incomplete` and the browser asks again, every 4 s at first, backing off to once a minute and giving up after 25 tries; until the first hours arrive, the charts say the weather is loading.
- **Shown:** on a router's Telemetry tab, the weather at its site behind its own readings: air temperature behind its temperature and relative humidity behind its humidity, each as a shaded area on the same axis, and, behind its voltage (solar nodes), cloud cover as a grey area on a 0–100 % scale of its own and sunlight as a yellow area on a scale of its own (drawn mid-hour), with night shaded over them: when the sun is below the horizon at the node's position (sunset to sunrise, worked out in the browser from the sun's position, for any node with a position); a chart whose readings the node does not report shows the weather alone.
  A Wind chart shows wind speed and gusts as two lines.
  On a link's SNR chart, precipitation per hour as bars on their own scale (maximum labelled), the mean of the ends that qualify.
  Hovering reads off the weather for that hour beside the reading.
  Each chart with weather credits MET Norway.

### 6.19 Terrain and line of sight

Cross sections of the earth between two points, from Kartverket's terrain model (DTM, via Geonorge's height API; CC BY 4.0), and whether a radio link between them has line of sight (D-143):

- **Antennas:** an end's antenna is at the altitude its node reports with its position; a node that reports none (Meshtastic sends 0) gets the terrain at its reported position plus 2 m. Positions are the reported ones (refined when they jump around one place, §6.10); estimated positions never get a cross section.
- **Path:** a sample every 200 m along the straight line, each with the terrain height, the earth's bulge there with the usual 4/3 earth radius for radio (d1·d2 / 2kR), the height of the straight line between the antennas and the radius of the first Fresnel zone at 869.5 MHz (√(λ·d1·d2 / d)).
- **Class:** the least free part of the first Fresnel zone along the path, in Fresnel radii: **clear** at 0.6 or more, **grazing** from 0 (the line is free, the zone is not), **blocked** below 0 (terrain cuts the line), **unknown** when the model covers less than half the path or an end has no height.
  At sea the model gives the sea floor as negative heights; the surface is used, 0 m.
- **Fetching:** heights are looked up on a 0.0005° grid, in memory (at most 2 million), then in `terrain_height` (§3.8), and only then from Geonorge, so each is fetched once.
  One worker asks for 50 points per request (the API's limit), 250 ms apart, and waits when told to (429 or 503, honouring `Retry-After`, else 30 s).
  Only points inside the covered area are looked up: 57.5–71.5° N, 4–31.5° E, mainland Norway and its waters with the border strips of Sweden, Finland and Russia a link may cross (heights there are none); Svalbard and Jan Mayen are left out, as the model does not cover them.
  One lookup may ask for at most 120 000 distinct grid points.
  As for weather (§6.18, D-141), each visitor has its own queue, the worker takes one point from each in turn, and the warmer's points fill what is left of a request: a visitor may have 20 000 points waiting, and when visitors together hold 200 000 a newcomer's point displaces the last of the visitor holding the most.
  Only visitors' points are kept in memory, which drops its oldest tenth when full; the warmer's go to the store alone (D-147).
  Until every height of a cross section is in, the answer says `incomplete` and the browser asks again, every 4 s at first, backing off to once a minute and giving up after 25 tries.
- **Warming (D-144):** the backend does not wait to be asked.
  On start, and then hourly, it reads every node whose newest role in the last 14 days (or the longest window, if longer) is ROUTER or ROUTER_LATE (unsigned NodeInfo marked `identity_untrusted` not counting, §2.4) and that reports a position (`storage.Infrastructure`, from Position packets and map reports, through the roster the weather keeper shares, §6.18), and queues the heights for every pair within 300 km, so their cross sections and the engine's ranging classes (§6.12) are ready before a visitor opens them.
  Both ends must be in the covered area.
  It asks the store which of a pair's points it lacks and queues only those, in the background queue behind every visitor's, keeping at most 10 000 waiting and adding more as the worker drains them; pairs found complete are remembered and skipped by later passes, so after the first pass only new or moved nodes add work (D-147), and each backend replica warming its own queue is harmless.
  These are the pairs the page asks classes for (router to router, below), and a superset of its links (the warmer does not know which pairs are actual links); the extra heights are permanent and shared between nearby paths.
  Base stations (CLIENT_BASE) were warmed too until the page was found never to ask for them.
  Off when `TERRAIN_ENABLED=false`.
- **Router links:** the page asks `/terrain/classes` for every router-to-router radio link (ROUTER and ROUTER_LATE) whose ends both report a position, at most 400, and hands the classes to the engine, which uses the clear ones for ranging (§6.12).
  The same set of links asks once.
  Views are rebuilt when the classes arrive.
- **Link panel:** with both ends reporting positions, a radio link's panel shows its class and the cross section: terrain raised by the curvature, the line between the antennas, the Fresnel zone with its 60 % line, and, when the link is not clear, where it is worst.
  Hovering the chart reads out the distance, ground, line and how much of the zone is free there, and marks the point on the map's line.

## 7 Map and user interface

### 7.1 Layout

UI chrome floats over the map, which runs edge to edge and never resizes (checked in e2e) (D-029).

- **Header island** (top left): the wordmark, the live indicator (LIVE, LIVE (paused) or HISTORICAL with the window's length, and an updating spinner) on one line, the counters below; on phones the counters are hidden.
  It is a rounded card with the islands' border, blur and shadow.
  Its height is published as `--head-h`; MapLibre's zoom buttons, the fit control and banners sit below it, stacked above its shadow, and camera framing keeps content clear of it.
  Until the first snapshot arrives each counter shows a faint placeholder bar about as wide as a typical value (tabular figures), so the card keeps its size (D-082).
  Clicking the live indicator opens the Period panel; "Return to live" sits beside it while a fixed window is shown (D-067).
- **Trends** (D-104): the Trends panel, in the rail after Regions: Daily, Weekly or Monthly bars for nodes heard (new ones highlighted), gateways, packets and receptions, packets by type over the whole period, what the nodes run (D-198) and a table of every bucket, newest first, from `/api/v1/trends` (and `/api/v1/trends/fleet`) in the viewer's time zone.
  It ignores the window and filters.
- **Node history (D-195):** the window shows a node over at most 14 days, while a maintainer asking whether a router got worse after a move, or whether a solar node's battery sags in winter, needs months.
  So the hourly summaries behind trends (D-112) also keep, per node heard in the hour and aligned with the hour's sorted node set, its distinct packets, their receptions by other gateways (both 16-bit, capped at 65 535 an hour) and the lowest battery level its device telemetry reported (one byte: none, 0–100, or 101 for external power, kept only when it reported nothing lower, as the engine reads it); hours as a gateway follow from the gateway set.
  They come from one more CTE over the rows the refresh already reads, so the log is scanned no more often.
  Parallel arrays rather than maps keep it to 5 bytes per node and hour: at about 400 nodes heard an hour over six months (4 400 hours) some 9 MB beside the 14 MB the node sets already take.
  `/api/v1/trends/node/{id}` sums them per bucket.
  In Details, the Overview tab ends with a collapsed **History, everything kept** section, fetched only when opened: Daily, Weekly (the default) or Monthly bars for the share of logged hours it was heard in (its uptime as the mesh saw it), its packets, gateways per packet, the share of hours it uplinked as a gateway (when it ever did) and its lowest battery (when it reported one; no bar where it reported none or only external power), each explained on hover, and a table of every bucket, newest first.
  It says that it covers everything the server keeps and ignores the window and filters, waits and asks again while the server is still counting after a start (503), and says so plainly for a node not yet in the summaries (404).
- **Tool rail** (right edge, starting below the header so the header keeps its full width and shape whatever panel is open; on phones and narrow tablets, up to 820 px, a horizontal bar along the bottom edge with the same tools left to right, centred when they fit and scrolling sideways when they don't; an end with more tools beyond it fades out under an arrow that scrolls to them, D-132): Nodes, Details, Health, Regions, Trends, Period, Filters, Layers, Legend, Settings.
  Icons carry short labels, which narrow screens drop (kept as accessible names and tooltips).
  The Filters button shows how many filters differ from the defaults (D-066, D-067); the Health button, how many problems and warnings the window has (D-095).
  The open panel can be resized by dragging its left edge (or arrow keys on that handle; double-click resets to 380 px), between 300 px and 900 px while leaving the map at least 220 px; the width is remembered in the browser.
  On phones the panel spans the width and has no handle (D-097).
- **Panel:** one at a time, docked beside the rail, from the same top below the header; its header names and closes it.
  Pressing the open panel's button again or Escape (unless typing) closes it.
  It is as tall as its content, ending at most as far above the bottom edge as it starts below the top (the header's height plus two gaps), scrolling inside past that; on phones it spans the width and sits on the bottom rail, its bottom edge on the rail's top edge, growing upwards to below the header, over the map controls (D-066, D-071, D-132).
- **Islands:** the rail and panel are translucent, blurred rounded cards inset 10 px from the map's edges (8 px on phones) (D-071).
  Two elevation tokens are the only drop shadows, `--elev-island` and `--elev-float` (banners, tooltips, map controls); labels on the map stay flat (D-081).
- **Map controls:** zoom, "Fit to data" and "Reset north" (icon buttons in a group under the zoom buttons; mouse drag never rotates the map; Settings → "Keep north up", on by default and kept with the layer choices, stops a two-finger twist and Shift+arrow keys from rotating it too, turns a rotated map back to north up and hides "Reset north"; switched off, those gestures rotate it and the needle shows the bearing, D-200), scale bar, a coordinate readout on hover and the credits.
  The coordinates and credits stay in the bottom-right corner whatever opens; a panel may partly cover them (D-082).
  On phones they and the scale bar sit just above the bottom rail (D-132).
  Banners and camera framing keep clear of the open panel, telling the side panel from the phone panel by width; on phones, framing keeps clear of the bottom rail and places content above the panel when at least 160 px of map remain between it and the header, and banners lie beneath an open panel (D-071).

### 7.2 Basemap and layers

- **Basemap:** OpenMapTiles-schema vector tiles from a self-hosted PMTiles archive by default (basemap.md), dark and light styles with the same layers.
  MapLibre GL is on 6.x, with deck.gl's overlay from `@deck.gl/maplibre` (6.x dropped the `map.transform` that `@deck.gl/mapbox` reads); MapLibre's worker is bundled by Vite and named with `setWorkerUrl`.
  It was held on 5.x while 6.x stopped painting labels drawn after deck.gl's interleaved layers (D-017), until 6.15 and the MapLibre overlay drew them again.
  MapLibre's attribution control is disabled and the required credits are static React text; 6.4.1 and later fix GHSA-jrc7-96c5-q579, so this and the CSP are now defence in depth (D-019).
  Glyphs are Noto Sans Regular/Bold from the OpenMapTiles fonts release, one font per text stack (D-018).
- **Mesh layers** are interleaved beneath the basemap's label layers (`beforeId: labels-start`), so enabled names stay readable over nodes and links (D-018).
  Pings are a separate, non-interleaved overlay above everything (§7.7).
- **Layers panel, Mesh:** Router links, Client links, Internet links (all off by default) (D-047), Inferred links (on; modifies the router and client layers), Position accuracy (off), Node names (on), Position trails (off), Traffic (on, off under reduced motion).
  Names were chosen for plain language; code keeps internal names (`infraLinks`, `otherLinks`, `mqttLinks`) (D-062).
- **Watchlist (D-192):** a viewer can watch nodes (☆ Watch in a node's Details, at most 30), kept in that browser's storage only and shared by its tabs (each change starts from the stored list, and a save in one tab shows in the others at once).
  They are listed at the top of the Nodes panel from the `watch` engine view, which takes their ids: when each was last heard (its own packets or its uplinks), whether it has been quiet for at least an hour and 4 times its usual gap before the newest data (events and gaps as the silent-infrastructure rule counts them, by the same code and from all the window's valid rows whatever the filters, D-188), its last battery and voltage, and how many gateways got its packets; nodes not in the window say so.
  Problems and warnings from Health are counted on the line.
  With *Notify me while this page is open*, the browser shows a notification when a watched node goes quiet, is heard again, gets a new problem or warning, or its battery drops to 20 %: only in a live period, only while the page is open (nothing runs on the server, and no push service is used), and never for the first data after a page load or a window change.
- **Place search (D-193):** the Nodes panel's search also finds places (while it matches no node, it dims none on the map, so typing a place leaves the map as it is): two characters or more, after 300 ms, ask `GET /api/v1/places?q=`, which looks it up in Kartverket's place-name register as loaded into the database (`place_name`, `place_key`, §3.9): names with a word starting with the search ("galdh" finds Vesle Galdhøpiggen, "fron" Nord-Fron), ranked exact names first, then towns, municipalities and counties, districts and built-up areas, hamlets, villages and housing estates, other features, and last farms, roads, bridges and buildings, then by Kartverket's importance, a place's main name before its others and shorter names first; each place once, by its best-matching name (Oslo, not also Oslo suohkan), and one per name and municipality, at most 8.
  The register is Geonorge's GML download for common use (about 140 MB zipped, a million names): the maintenance process imports it when none is loaded and again once it is `PLACES_MAX_AGE_DAYS` (30) old, checking daily, hourly after a failure; `meshmap import-places` loads it at once, from `PLACES_URL` or a local file.
  Only names in public use and not historical count, with approved, adopted, international, private or unassessed spellings; a place without a position is left out, and one known by points, a line or an outline takes the coordinate nearest their mean, so its point lies on it.
  Until the first import completes, place search answers 503.
  The first five are listed under Places; picking one moves the map there, at a zoom by kind (a county 7, a town 11, a peak 12), and rings it until the search is cleared.
  A search asks no one outside this server (`PLACES_ENABLED`).
  Attribution: "Place names: © Kartverket" (CC BY 4.0).
- **Layers panel, Map:** Borders, Major roads, Land cover and parks, Minor roads and rail, City and country names (on); Rivers and streams, Buildings, Local place names (villages, hamlets, suburbs, neighbourhoods), Peaks, Road names and numbers, Water names (off).
  Towns count as cities because OpenStreetMap classes most Norwegian cities as towns; the tiles carry no county names.
  Water and background are always drawn (D-022, D-083).
- **Regions (landsdeler)**, off by default: Nord-Norge (Nordland, Troms, Finnmark), Trøndelag, Vestlandet (Rogaland, Vestland, Møre og Romsdal), Østlandet (Oslo, Akershus, Østfold, Buskerud, Vestfold, Telemark, Innlandet) and Sørlandet (Agder), following Store norske leksikon and Wikipedia; the regions have no formal status, and moving a county is one line in `scripts/regions.js`.
  Kartverket's 2024 county boundaries (CC BY 4.0) are dissolved by `scripts/regions.sh` into `frontend/src/assets/regions.geojson`, fetched only once the layer is on.
  Each region is an unfilled outline drawn inset inside its own region (neighbours' borders run side by side), beneath everything and not pickable; names sit at hand-picked inland points and give way to node names from zoom 9.
  "© Kartverket" joins the credits while it is on (D-061).
- Every switch has a tooltip explaining its data.
  Choices and the theme are a per-viewer convenience in `localStorage` (`meshmap:toggles:v6`, bumped whenever defaults change; wrapped in try/catch, defaults apply without storage).
  The style is patched with the saved visibility before the map is created, so hidden layers never flash (D-022).

### 7.3 Node markers

- **Icon by role (D-186):** every node is a 20 px disc with a glyph inside that says its role: ROUTER the broadcast mark (a dot between two arcs), ROUTER_LATE the same arcs around an hourglass (a router that waits), CLIENT_BASE a house, and every other role, or none, a handheld device with a screen.
  One size for all, no smaller than the old router marker (16 px; clients were 10 px): sizes by role could not be told apart at a glance, and a glyph needs about 20 px to read.
  The glyph geometry lives in `frontend/src/map/roleIcons.ts`, shared by the map's icon atlas and the legend.
  Replaces sizes by role (D-021).
- **Colour by last heard:** the time between the node's last activity (or last mention, for referenced nodes) and the window's end, as a fraction of the window on a **logarithmic scale** with a 10-minute knee, so recent activity is spread out: in a 3-day window the stops fall near 0, 35 min, 3.3 h, 16 h and 72 h (D-087). **One ramp for both themes:** gold (226,152,0), orange (236,116,16), red (218,66,56), magenta (192,52,128), violet (130,68,190) at 0, ¼, ½, ¾ and 1.
  Lightness falls throughout, so it reads in order without colour vision; every stop has at least 3.2:1 contrast against the dark background and 2.1:1 against the light one.
  Against roads, water and land cover, the markers' dark outline and the estimated rings' dark halo carry the separation (D-085).
  The legend labels the stops in the current window's minutes, hours or days.
  Node list dots use the same colour (D-021).
- **Kinds:** filled marker for a reported (or narrowed) position; hollow ring in its last-heard colour, its glyph in the same colour, name in purple, for an estimate; no marker for unpositioned nodes, which are listed under "Without position" in the Nodes panel.
- **Gateways** have a blue ring; the selected node a white (dark in light theme) outline.
  Nodes that opted out of MQTT uplink have a permanent red ring (D-032).
- **Uplink badge on the rim:** a small blue disc at the upper right of a gateway's marker holds ↑ for a gateway that uplinks the first copy of each packet, or a double chevron for one that uplinks every copy (§6.6); the inside of the marker is the role glyph's (D-186). **Downlink arrow beside the marker:** a small ↓ at the lower right for a probable downlinker (§6.5), with either uplink badge or none (D-054, D-084).
  The airplane badge sits at the upper left (D-073).
- **Glyph drawing:** tinted icons drawn once onto a canvas atlas (font arrows vary between systems, and the CSP rejects `data:` icon URLs for deck.gl's fetches).
  The role glyphs are drawn into the same atlas from `roleIcons.ts`, the client's screen cut out so the disc shows through.
  The ink of a role glyph is chosen by WCAG luminance (dark above 18 %), giving at least 4:1 at every age; hollow markers use the ring's colour (D-054, D-085, D-186).
- **Stacking:** clients are drawn first, then home stations, then routers, so infrastructure is on top where markers overlap.
  Markers are one layer and their glyphs (role, badges) another, so each instance is moved towards the camera by its place in that order, a disc at 2k and its glyphs at 2k + 1, and the depth test draws a glyph above its own disc and below every marker drawn after it, in two layers at any zoom.
  The map is never pitched, so the shift moves nothing on screen; fully transparent fragments (a hollow marker's inside) write no depth, and the layers drawn above markers (opt-out rings, labels, the terrain probe) skip the depth test.
  Replaces stacking levels redrawn per overlap (`nodes-over-N`, D-072), which with a glyph on every marker grew to dozens of layers at country zoom (D-187).
- **Clusters below zoom 10 (D-204):** markers that overlap on screen (centres closer than two marker radii plus 2 px of outline) are drawn as one cluster, so the country-wide start view is not a pile of overlapping discs.
  Clustering is grid-bucketed and greedy in order of prominence (routers first, then reported before estimated positions, then the busiest): a marker that overlaps an existing cluster's disc joins it, and otherwise it takes in every unassigned marker overlapping its own, so clusters never chain across the map.
  It is recomputed when the zoom settles, never per frame or pan.
  From zoom 10, where names take over (§7.6), every marker is drawn on its own.
- **A cluster invents no position (D-204):** it is drawn at its most prominent member's real position, as a disc like a marker's but larger (radius 13 px, 14 px from 10 members, 16 px from 100), with the member count where a marker has its role glyph and an outer ring in its colour that marks it as several nodes.
  Its fill is the most recently heard member's colour on the last-heard ramp, and the count takes the role glyph's ink (D-085, D-186).
  When the representative's position is an estimate the disc is dark with a coloured ring, as estimates are hollow.
  It is dimmed when no member matches the search or the drawn reach.
- **Clusters in the depth order (D-204):** cluster discs sit beneath every marker drawn on its own, by depth as in D-187 (the most prominent cluster on top), and their counts at the markers' base depth, above every cluster disc and beneath every marker.
- **Never hidden in a cluster (D-204):** the selected node, both ends of the selected link, watched nodes (D-192), nodes matching the search and the nodes of a drawn packet route are always drawn on their own.
  A place picked from the search (D-193) is a ring of its own and hides nothing.
  Hovering a cluster lists its members, most prominent first, in at most eight lines; clicking it zooms to fit its members, to at least zoom 10, and selects nothing.
  Counts and lists (the header counters, the Nodes panel) stay complete.

### 7.4 Links on the map

- **One line per node pair.** Directed edges stay separate in the data and the panel; on the map a pair takes the better direction's confidence and is dashed only if every present direction is inferred.
  There are no arrowheads; direction is in hover text and the panel (D-021).
- **Classes:** router links (both ends announce ROUTER or ROUTER_LATE in the window) are 3 px bright blue, or violet when either end is a ROUTER_LATE, so links that wait before relaying stand out; client links (any other combination, including no role) are 1.25 px grey-blue.
  Width never depends on sample count.
  Router links draw above client links (D-021).
- **Confidence** is opacity (high solid, medium fainter, low fainter still) plus dashes for inferred links.
- **Internet links** are dotted green, beneath the radio links, one per pair, in both themes.
  Their panel is titled "Internet link" with "Why internet", and says who passed what on (D-055, D-062, D-087).
- **0-cost:** a gold chevron on the link near the router that relays for free, pointing at it; a "0-cost" row in that direction of the link panel, ", 0-cost" in the hover text, and a legend entry (D-068).
- **Hover** names both ends by short name, one line per direction with confidence and sample count (the MQTT note on its own line), and says "hidden by the filters" rather than "no evidence" for a filtered direction (D-083, D-087).
  A selected link is drawn in the selection colour, on top of the others, and always: whatever the filters, link toggles and level of detail leave out, the link open in Details is on the map (between its ends' markers, even where a filter hides a marker).
- **Level of detail:** below zoom 9 the best-supported 3 000 links (`LOW_ZOOM_LINKS`, by samples); from zoom 9 only links touching the viewport plus a 25 % margin.
  Counts and lists stay complete.

### 7.5 Selection and accuracy circles

- Clicking a node or link selects it and opens Details; clicking empty map clears the selection (D-027).
  A click is MapLibre's (no time limit between press and release, only a movement one), then deck.gl picks what lies under it: deck.gl's own click must end within 250 ms of when the page handled its start, so one slow frame in between (a slow phone, software rendering) lost it.
  Picking is given a tolerance of `PICK_RADIUS` pixels (hover and click alike, via deck.gl's `pickingRadius`), so the thin links — client links thinnest — have a clickable band far wider than the drawn line; a direct hit still wins, because the pointer's own pixel is tested before the ring around it (D-146).
  Closing Details any way (its button, ×, Escape) keeps the selection on the map, still highlighted and in the address bar, so a phone user can see the map again without losing what they picked; clicking it again or the Details button reopens Details.
  A selection that opened Details closes it when cleared (D-066).
- A selected node shows only its own links, all of them, bypassing level of detail and viewport culling; clearing the selection restores the rest (D-026).
- With "Position accuracy" on, every estimated node shows its uncertainty circle while nothing is selected.
  A selected node shows only its own circle, whether the layer is on or not: its estimate's uncertainty, its narrowed error (§6.10), or for a coarse reported position its precision-cell error in a neutral colour (D-026, D-079).
- The map hands links, pings and the camera only the positions of markers actually drawn, so nothing points at a node that is not on screen (D-043).
  A node inside a marker cluster is drawn at its cluster's disc: its links, reach paths and pings start and end there, and links between two members of one cluster are not drawn (D-204).
  Accuracy circles, trails and opt-out rings are drawn only for markers drawn on their own (a selected node always is); the camera's fit to data uses the nodes' own positions.

### 7.6 Node names

Names (short name, full Unicode; else the last four hex digits) show from zoom 10 when "Node names" is on.
Names whose label boxes would overlap are grouped into clusters (screen space, grid-bucketed).
A collapsed cluster shows its most prominent node's name (routers first, then the busiest) plus "+N".
It fans out while hovered (with a 400 ms grace period) or while one of its nodes is selected: names sit on the smallest ring on which no two boxes overlap, keep their markers' angular order, and have leader lines; clicking a fanned-out name selects that node.
A fan names at most 12 nodes (`FAN_MAX`; clusters join transitively, so one in a dense town can hold hundreds): the most prominent, and the selected node when it is one of them, with "+N more" under the ring, which zooms in on the cluster when clicked.
Hovering a clustered marker shows no tooltip; hovering a name shows its long name.
Markers never move (D-035).
Clustering runs only while names are shown (D-083).

### 7.7 Live pings

On a rolling window, each RF transmission attributable to a placed node is one expanding ring centred on the transmitter, growing until it encloses every placed node known to have heard that transmission directly; each receiver flashes as the ring reaches it, and a line grows from the transmitter to each direct receiver (D-023, D-042, D-053).

- **Attribution** (engine `transmissions`, the same relay resolver as links):
  - The originator always made the first broadcast (blue ring), keyed by logical packet and originator, so all copies share one ping.
  - `direct_rf` or hop count 0 (`hop_start − hop_limit`): the gateway heard the originator directly.
  - Otherwise the gateway heard a rebroadcast (amber ring) by the last hop, resolved from the relay byte; an unresolved byte attributes no rebroadcast.
  - Hop count 1 with a resolved relay whose known role is **not** ROUTER, ROUTER_LATE or CLIENT_BASE: that relay spent the only hop, so it heard the originator directly.
    With a 0-cost-capable or unknown role nothing is inferred (§6.7).
    A downlinked copy (§6.5) never makes the relay a receiver of the first broadcast.
  - Traceroutes use their recorded path: each adjacent pair of originator, route and gateway is one transmission heard directly, so every relay gets its own ring; unrecorded hops and internet hops are no radio transmission.
  - **Gaps (D-173):** a stretch of the way whose hops are not known travels as a line instead of a ring, drawn as the packet's routing graph draws it (§6.15): dashed from the sender to a resolved relay that did not hear it directly, dashed from the sender to the gateway when the relay byte is unresolved or missing, dashed across a traceroute's unrecorded hops (from the last known node to the next), and dotted green over the internet (a downlinked copy, a traceroute hop into a downlinker).
    It grows at a ring's pace, its receiver flashes when it arrives, and a ring beyond it waits for it as for an upstream ring.
    Both ends must be placed.
  - A gateway uplinking its own packet, MQTT or non-radio receptions, or a transmission with no placed direct receiver, shows only a brief 1.5 s glow; a receiver arriving later grows a ring from it.
    Map reports never ping.
- **Timing:** grow 3 s (ease-out), linger 5 s, fade 2.5 s. Uploads of one packet arrive over several seconds (median spread 3.1 s, p90 8.8 s on `mqtt.868.no`), so a ping accepts receivers for its whole life (~10.5 s).
  A receiver outside the ring restarts growth from the current size and resets the linger; any new receiver revives a fading ring.
  Once a ping ends, late copies of that transmission do not ping again for 20 s. At most 80 pings run at once.
- **Waiting for upstream:** a transmission by X of packet P whose upstream ping (or gap) lists X as a receiver stays hidden until that ring (or line) reaches X, then grows from nothing.
  Without upstream information it starts at once.
  A waiting ping starts no later than its own collection timeout, so after a pause it keeps its timing and mostly expires (D-028, D-048).
- **Drawing:** rings are sized in screen pixels, never smaller than 22 px, so co-located receivers stay visible.
  Rings have no outline; the fill (18 % at most) is a radial gradient in 16 bands: full at the transmitter, at each receiver's distance the opacity of its measured signal (gateway SNR −20…+10 dB, else RSSI −130…−70 dBm; 0.5 when unmeasured), transparent at the edge, never increasing outward (D-027).
  The line's head rides the ring's edge, so ring and line reach a receiver on the same frame; travelling it glows brightly, then settles thinner and fades with the ring (D-042).
- **Following the map:** each frame a ping looks up its transmitter and receivers among the markers drawn now; a moved receiver is followed, a vanished one dropped, and a ping whose transmitter is gone ends (D-043).
- **Only fresh traffic while painted:** pings are created only for rows handled while the page is visible and the packet is at most 10 s old by the server clock (offset from heartbeats and the retention call).
  Readings arrive late, never early, so the highest offset wins at once and a lower one takes over only after persisting for 20 s of local time: a frozen background tab that thaws handles its backlog of minutes-old heartbeats in one go, and taken at face value they would set the server's clock back and make the backlog's rows look fresh (D-176).
  When the transmissions come back from the worker, they animate at once if a frame arrived within the last 2.5 s, else on the next frame if that comes while they are still under 10 s old, each started back when it arrived: a slow frame on a busy machine shows a ping a little way in instead of losing it, and a covered window that gets no frames does not play its last seconds of traffic all at once when it gets frames again, only as far along as they would be, mostly fading.
  Rows still reach the worker, so views stay complete; only the animation skips them, and a sleeping tab never resumes with a burst (D-034, D-048, D-113).
- **Own canvas:** pings live in a separate, non-interleaved deck.gl overlay covering the map, so animating them at 30 fps never redraws the basemap or mesh layers.
  The loop runs only while pings are alive; idle, it probes for a frame about once a second (D-083).
- Pings follow the Traffic switch, apply the filters, and are off under `prefers-reduced-motion`.

### 7.8 Panels

- **Nodes:** search by name or id (dimming non-matching nodes), positioned nodes and "Without position", each sorted by last heard with receptions by others shown (D-087).
  The active node filters (position, online, role) narrow the list as they narrow the map, with an alert when they hide any (D-145).
  The search is cleared when the panel closes or another panel replaces it; picking a result opens Details and keeps the search (D-075).
- **Environment telemetry (D-099):** temperature, humidity and pressure travel in rows (`te`, row format 6).
- **Telemetry tab (D-100):** the node's latest device report (battery, voltage, channel use, own airtime, uptime) and environment readings, then one chart per metric with data: battery (0–100 %, external power noted instead), voltage, channel utilisation, own airtime, uptime, temperature, humidity (0–100 %) and pressure, and the noise floor it measures (dBm, from local statistics, D-199) when it sent any.
  Every chart spans the whole selected period, so charts line up and silences show as gaps (the line breaks where reports stop for more than 2 h or four times the usual interval); individual reports are dotted when there are few.
  Hovering or touching reads off the nearest report and its time, in every chart of the tab at once (a link's signal charts likewise): each shows its own report nearest the moment pointed at, within an hour or 2 % of the period, else "no reading" there (D-135); the value axis is labelled with its range, never negative for percentages and durations.
  Series keep one sample per packet, at most the newest 500.
  Stationary routers' charts carry the weather behind them (temperature, humidity, and cloud cover and sunlight behind voltage), with a Wind chart added (§6.18).
- **Details, node, layout (D-098):** the name with Share at its right, the id below it, then a line of tags (online or offline, gateway, downlink) and a compact health line (counts by severity, expanding to the issues) stay above five tabs: **Overview** (names, hardware, role, status text with earlier ones (D-103), identity, node id (from its key, firmware 2.8 or newer, or from its hardware, 2.7 or older, with the id it takes on 2.8, or a link to that id when it is heard in the window too; D-142), public key, position, movement, seen in window, traffic, and its history over everything kept, collapsed, D-195), **Links** (links in window, uplinked by gateways, relaying, router links, reach), **Radio** (region, preset, channels, brokers, MQTT root topics, heard on), **Telemetry** (below) and **Packets** (airtime, delivery reports, delivery by recipient, signatures, packet log).
  The tabs are drawn as folder tabs without painting over the panel's translucent background: the baseline runs along the edges, gaps and inactive tabs, and the selected tab, with an accent top edge and no bottom border, opens into the content in exactly the panel's colour; inactive tabs carry a faint tint.
  Links and Packets show counts.
  The bar scrolls with the content (a sticky bar would need an opaque background) and sideways if a narrow panel cannot fit it; arrow keys move between tabs, and the chosen tab is kept when another node is selected.
- **Details, node:** id with a share button (§7.11); names and their source; hardware and role; public key (copyable, with when it was announced and whether it is the trusted key; a differing trusted key is shown with a warning; shown for opt-out nodes too) (D-089); position with precision (± distance), altitude and source, or the estimate with its reasons, or the narrowed position; movement; first and last heard; packets, receptions by others and own uplinks; brokers; for gateways, the MQTT root topic(s) from the topics of the rows it uplinked, busiest first with counts when there are several (D-090); signatures; region, channels and preset (§6.13); MQTT tags ("⏫ MQTT gateway, every copy", downlink evidence); relaying (§6.9); reach (§6.8); Links in window; Uplinked by gateways; the packet log (§6.14).
  Missing values say "not reported in selected period"; a node absent from the window shows "no data in the selected window".
- **Links in window:** one row per neighbour: its name and → on the first line, ← on the line below, aligned in one grid across the list. → the neighbour heard this node, ← this node heard the neighbour, each with confidence and median SNR, or "no evidence".
  Radio and internet links to one neighbour are separate rows.
  Sorted by the better direction's confidence, then median SNR, then name, internet links last; the heading counts neighbours.
  Clicking a row opens the link (D-086).
- **Uplinked by gateways:** gateways that heard the node, sorted the same way by the radio link from the node to the gateway, with a Link column showing that confidence (— when relayed only), and SNR and RSSI from direct receptions only, explained in column tooltips (D-086, D-087).
- **Router link quality (D-197):** a router's (ROUTER, ROUTER_LATE) Links tab charts the SNR of its radio links to other routers over the selected period, from the readings the router link drop rule uses (§6.17): per time bin, the median SNR of every reading of its transmissions at another router (*heard by other routers*) and of other routers' transmissions at it (*hearing other routers*), with the readings behind each bin (read out on hover, summed in the legend).
  Bins start at the window's start, the narrowest of 15 min, 30 min, 1 h, 2 h, 3 h, 6 h and 12 h giving at most 72: 30 min for 24 h, 1 h for 72 h, 3 h for 7 days, 6 h for 14 days.
  A bin mixes whichever partners were heard in it, so a bin where only a distant router was heard sits lower without anything having changed; each link's own history is under the link.
  A router with no reading to or from another router says so; other roles show nothing.
  The `node` view carries it as `router_links {bin_ms, heard, hearing}`, each bin with readings as [bin middle (ms), median dB, readings]: about 2–3 KB for a busy router over 72 h or 11 days.
  A router that sends local statistics also gets its own noise floor in the chart, binned alike (`floor`, median dBm), as a dashed line on a dBm scale of its own at the right (D-199).
- **Noise floor (D-199):** some nodes send local statistics telemetry with the noise floor they measure (dBm, row format 11): the background radio noise at the node, which rises with interference near it, while a weaker antenna or cable lowers the signals it hears but not its floor.
  Whether any node on the mesh sends it is not known, so everything here appears only where readings exist and is absent otherwise.
  The engine keeps one reading per packet (its first copy) per node, made on first use per build (`views::noise`), and the views carry it where signal is charted, each field left out when the node sent none: the `node` view's `noise_floor_series` ([ms, dBm], time order, the newest 500 like the other series) for a **Noise floor** chart in the Telemetry tab, with a line saying what it is; the `link` view's `floor_a` and `floor_b` (each end's, the newest 2 000), drawn in the link's RSSI chart (same unit, same axis) as dashed lines labelled with the end's short name, in the colour of the direction that end receives, and only when the chart has RSSI to set them beside; and `router_links.floor`, the router's own floor binned like its link medians ([bin middle, median dBm, readings]).
  The router chart's SNR is in dB and the floor in dBm, so the floor gets a second value scale at the right, its range in its own colour, dashed, read out in dBm on hover and marked "(dBm, right)" in the legend; it never makes the chart appear on its own.
  A second axis was chosen over a small chart beneath because the floor matters beside the SNR measured at the router (*hearing other routers*), whose colour it shares, and one hover readout covers both.
  Partners' floors are left out of it: a bin mixes partners, and their lines would crowd a chart meant to show one router's change.
  The floors are context, not a threshold: LoRa decodes signals below the noise floor (negative SNR), so no reading is marked by how close it is to a floor.
  The demo's routers send local stats beside their device telemetry, Gråkallen the noisiest.
- **Details, link:** both directions with evidence types and counts, confidence and reason, sample count, SNR/RSSI statistics, time range, 0-cost evidence, and names when known in the window.
  Below them, **signal over time** (D-105): SNR and RSSI charts over the selected period with both directions as separate lines, from every measured reading of the link (each RF event once, as the statistics count them; at most 2,000 per direction), with precipitation behind the SNR when an end is a stationary router (§6.18), and in the RSSI chart the noise floor of each end that sends local statistics (D-199).
  Above the directions, a radio link between two nodes that report positions shows its **line of sight**: the class and the terrain cross section, which marks the hovered point on the map (§6.19, D-143).
  A selection remembers whether a radio or internet link was picked (D-055).
- **Regions (D-194):** the window per landsdel, for whoever looks after the mesh there, from the `regions` engine view.
  The list gives each region's nodes (placed by reported position or estimate, the outlines of the map's Regions layer), gateways, routers, median channel use (the median of each node's median channel utilisation from its device telemetry in the window, each report counted once however many gateways heard it) and its nodes' problems and warnings; a region's page adds home stations, the nodes and gateways in rows uplinked under a topic root naming it (wherever they are), the busiest channel, its nodes' issues grouped by kind (notices on request), *Show on the map* (the Regions layer on, the map over the region) and its growth week by week over everything the server keeps: `GET /api/v1/trends?region=` counts only rows uplinked under a topic root naming the region, kept per hour beside the mesh-wide sums (D-112) with no packet types.
  *Show on the map* centres the map on the region's centre of mass (its area's centroid on an equal-area projection, stored beside the label positions and checked against the boundaries by a test), not on its hand-placed name, and shows the Regions layer while the panel stays open: if the layer was off, closing the panel or opening another hides it again, and it is never saved with the layer choices; if the viewer had it on, it stays on (D-201).
  The page is a link (`?region=`, with the period and filters), and *Share* copies it without any selected node; a link naming both a region and a node opens the region's page; leaving the panel drops it from the URL.
  Until the worker has the outlines the panel waits, and they arrive with the regions health rule's (D-161).
  Each region's page ends with what its nodes run (D-196, below); the list says that the whole mesh's is in Trends, over everything kept (D-198).
- **Hardware and firmware (D-196):** for maintainers deciding on an update or a preset change: a region's nodes heard in the window by firmware, hardware model, role and modem preset, on its page, from the same `regions` engine view (module `fleet`).
  A region counts the nodes the region's own count places in it; nodes only named by others (`referenced`) count nowhere, and like the region counts these include nodes past the node limit and follow the filters.
  The whole mesh's breakdown was first shown on the Regions list over the window too; it moved to the Trends panel, over everything the server keeps and graphed per day, week or month (D-198), so the list and the engine view no longer count it.
  Role and hardware come from the node's identity (its latest NodeInfo, else its own map report; empty or `UNSET` is "unknown"), and the UI names the protobuf enum readably (a short table of common boards, else the words capitalised: `HELTEC_V3` "Heltec V3", `RAK4631` as is).
  The preset is the node panel's inference (§6.13, `channels::infer`), so the two never disagree: its own map report only when `has_default_channel` proves the preset, else confirmed reports of its radio group, else default channel names; "unknown" without evidence or on conflict.
  Firmware is exact only where the node's latest map report in the window states a version (`mr.firmware_version`, row format 10); those are grouped by major.minor, newest first, with the exact versions on request.
  Every other node gets a generation the window shows, labelled *inferred* and never shown as a version: its node id derived from its key, 2.8 or later; from its hardware while it announces a key, 2.7 or earlier (D-142); none of its packets carrying a hop start, before 2.3; else "unknown".
  Most nodes send no map report (only MQTT-connected ones can), so the inferred buckets are the bulk on a real mesh.
  Each list shows its largest values, folding all past the sixth into "n others" (expandable) when that saves more than one row, with "unknown" last; firmware is shown whole.
  The text says the counts are of nodes heard in the selected period.
- **What the nodes run, over everything kept (D-198):** the window answers what the mesh runs this week; whether an update is spreading, or a preset change took, needs months.
  So the hourly summaries behind trends (D-112) also keep, per node heard in the hour and aligned with its sorted node set, one byte of radio evidence (whether its packets, map reports aside, carried a hop start, and the preset whose default channel name it was heard on most that hour, ties to the first by name) and two bytes naming what it said about itself that hour: the newest NodeInfo not marked `identity_untrusted` (role, hardware, and whether its node id comes from its key, from `public_key` as `key_id` is, D-142), the newest map report naming it (role, hardware), the version of the newest map report stating one (cut to major.minor.patch as the row format does) and the preset of the newest map report proving it with `has_default_channel`.
  The two bytes index a table of these combinations, interned (nodes say the same few things hour after hour; it only grows, by the combinations ever seen, a few thousand).
  They come from more CTEs over the rows the refresh already reads, so the log is scanned no more often, and since they live in the hours they are re-read, replaced and dropped with them.
  A per-node timeline of changes alone would be smaller, but an hour re-read (late copies, a newer decoder, an import) could not be taken out of it again, so the evidence stays per hour and the timeline is walked from it per request.
  At about 400 nodes heard an hour over six months (4 400 hours) the 3 bytes per node and hour are some 5 MB, and the table well under 1 MB, beside the 23 MB the node sets and D-195's figures take.
  `/api/v1/trends/fleet` counts each node heard in a bucket with what it had then, by fleet.rs's rules as far as hours hold them: role and hardware from its identity, its NodeInfo, else its named map report, the newest up to the bucket's end, or when it said none by then the oldest after (hardware and roles rarely change, and a node heard before its first NodeInfo, sent every few hours, would otherwise count unknown, above all at the start of the retained log); firmware, the major.minor of the newest version stated up to the bucket's end, never a later one (that would date an upgrade back); else the generation its identity's key shows; else, when none of its packets in the bucket carried a hop start, before 2.3; else unknown; the preset, its newest proven one up to the bucket's end, else the preset of the default channel name it was heard on in most of its hours in the bucket (ties to the first by name), else unknown.
  The table of default channel names is the engine's `radio::PRESETS`, repeated in Go (`protocol.Presets`) and compared with it by a test.
  It differs from the browser's window breakdown in three ways (the Trends panel's notes say how each dimension is found, and that presets do not consult the nodes around one): the window's newest map report and NodeInfo are the bucket's newest up to its end (with the identity fallback above); channel names count per hour rather than per row; and the preset has two steps only, the node's own proof and its own channel names, where `channels::infer` also uses its radio group's confirmed reports and channel names, which hours do not keep (radio contacts are not summarised), so on the server more nodes' presets are unknown.
  In the Trends panel, after its bar charts, **What the nodes run** has a Firmware, Hardware, Role and Preset switch (Firmware first) and one stacked bar per bucket of the panel's Daily, Weekly or Monthly choice, in the viewer's time zone.
  The bars are shares (each the full height, split by value), not counts: the number of nodes heard is already charted above, and a partial first or current bucket would otherwise read as a fall; the readout gives the counts.
  The values keep the server's order, the first on top, coloured from a fixed categorical palette of eight (`--series-1`…`8`, each theme its own steps, checked for colour-vision deficiencies against the chart background), `others` and `unknown` in greys; firmware's inferred generations keep their own three colours whatever the number of reported lines, so a colour never changes meaning with the period.
  The legend lists the values with the hovered bucket's (else the newest's) nodes and share, and so doubles as the readout and the table; hovering dims the other bars.
  Labels are the Regions panel's: hardware, roles and presets named readably, firmware lines as "2.7" and the inferred generations as "2.8 or later (inferred)" and so on, each explained on hover.
  The text says it covers everything the server keeps, each node with what it ran then, and per dimension how the values are found and where the server's rules differ from a node's Radio tab; per-region breakdowns over the selected period stay on the region pages (D-196).
- **Period:** window length presets (1 h, 3 h, 6 h, 12 h, 24 h, 3 d, 7 d, 14 d), start and end inputs in local time with the time-zone shown, ◀ slider ▶ to slide the window through retention (by half its length per step; the slider starts at the oldest observation), and the window's traffic strip (one bar per bucket, packets bright and receptions dim, with a key) (D-067, D-087).
- **Filters:** only nodes with reported positions; only online nodes, those heard within 3 h of the window's end (`ONLINE_MS`; nodes only named by others are offline), which Details marks as "● online" or "offline · last heard …" (D-101); only nodes whose latest reported role is one of those selected (D-145: the roles present in the window are offered as chips, with any still-selected role that has left the window; a node announcing no role is hidden while any role is chosen).
  These three node filters are a single predicate (`passesNodeFilters`) applied to both the map and the Nodes list, so the two agree; the list shows an alert counting the nodes they hide, with a "Show all" that clears them (D-145).
  They do not change the header counts or a node's details.
  Also: link evidence types and minimum confidence (these change only what the map draws); packet types (including "map report", "direct message" and "encrypted" chips; `invalid` rows never pass), channel and broker (these restrict which observations count at all, for nodes, links, counts and details).
  A Reset appears when any filter is active (D-066, D-087).
- **Legend:** draws the actual role icons and uplink badges (from the same geometry as the map, D-186), estimated rings, link classes and confidences, packet route styles (with direction chevrons), ping colours and signature badges, with the age ramp labelled for the current window (D-084, D-087).
- **Settings:** theme (Auto, Light, Dark), interface size (85, 100, 115, 130 or 150 %: the header, tool rail, panels and banners, not the map; `index.css` sizes everything in rem from one root size, `--ui-scale`, with hairline borders, outlines, shadows and layout breakpoints left in px; kept with the theme in the browser and applied by `theme-boot.js` before the first paint), nodes on the map, Install app when the browser offers it, links to the source code at the built commit, the API documentation, the licence and the privacy policy, the version (the short commit hash, linked to the commit; "development build" when the image was built without `SOURCE_REVISION`), and Reset (§7.14).
- **Nodes on the map (D-182):** the snapshot keeps the window's most active nodes, by packets sent plus receptions uplinked, 5 000 by default (`MAX_NODES`).
  Each viewer can set 100 to 100 000 in Settings, kept in browser storage with the layer choices; the derivation worker applies it to the engine (`max_nodes`) and every view is rebuilt.
  Everything built before the cut uses every node: link evidence, relay resolution, estimates, movement, 0-cost, relaying and the header's counts.
  Nodes beyond it get no marker (so their links are not drawn), are not in the node list or search, and get no health checks; their panel still builds when one is selected by URL.
  When nodes are left out a banner says so and how many are shown.
  More nodes cost worker memory, a larger snapshot crossing to the page on every rebuild, and more markers; the default suits a national mesh, and the setting is there to find what a larger one needs.

### 7.9 Period and live mode

The default is the server's default rolling window (72 h) in live mode.
Choosing a preset keeps live mode; setting start or end, or sliding, switches to a fixed window, which never creeps forward.
"Return to live" restores rolling mode.
UTC is the internal representation; the UI shows local time with a visible zone and handles DST: a typed local time that occurs twice (fall-back) means the earlier instant and is flagged, one skipped by spring-forward is moved forward by the jump.
Time controls, panels, counters and the traffic strip always reflect the same window.
A fixed window that retention's cutoff overtakes during a session is moved clear of it once the 5-minute `/retention` poll reports the new cutoff, so rows retention removed are never shown (a rolling window, at most 14 days, never meets a cutoff at least a month back; the stream's retention notice, sent after every maintenance run, only has the page read `/retention` again); an empty window shows a "no observed data" state.
The live badge shows "paused" when the stream is down.
Offline, a banner says "Offline: showing the data last received (time)".

### 7.10 Start view and camera

The map opens on mainland Norway's bounds (Lindesnes to Nordkapp, Utsira to Grense Jakobselv), padded clear of the header and tool rail, until the data arrives; then it zooms smoothly (1.2 s) to fit the drawn markers once, as "Fit to data" does, unless the view was moved meanwhile.
The view (centre and zoom) is saved in the browser whenever the map stops moving and restored on the next visit; with a saved view there is no fit on load (D-111).
Settings → Reset clears it with the rest.
A permanent link to a node flies to that node instead.
The box's centre lies over Sweden (Finnmark reaches 31°E), so the view keeps the zoom that fits the box but moves west towards 13.5°E as far as both ends of the country stay in view.
The `DEFAULT_MAP_*` settings no longer set the start view.
"Fit to data" fits the drawn markers again on demand (D-074).
Fitting, flying to a node and framing a route keep content clear of the header and the open panel (D-082).
While a node stays selected, the view follows it when its position changes (a new reported position, a refined estimate): it pans by the node's move, so the node stays where it was on screen, wherever the viewer had panned it; a move that lands while the view is moving (a drag, the first flight) is followed when the movement ends (D-210).

### 7.11 URL state and permanent links

The window, filters and selected node (`node=`) are in the URL, read before the first render so the first request is already for the right window; history entries are replaced, not pushed, so Back leaves the map (D-083).
A **permanent node link** `/?node=!xxxxxxxx` carries the node alone, without window or filters, so it keeps working: opening it selects the node, opens Details and flies to it once placed; an id that is not `!` plus 8 hex digits is ignored.
The panel's share button uses the phone's share sheet on touch devices, otherwise copies the link ("Copied") (D-080).

### 7.12 Theming

Viewers choose Auto (follows the browser, the default), Light or Dark in Settings.
`public/theme-boot.js` sets `data-theme` before the first paint, so there is no flash (a separate file, because the CSP blocks inline scripts).
UI colours are CSS tokens with a light set.
The light basemap style (`web/styles/light.json`, `MAP_STYLE_LIGHT_URL`) is generated from the dark one with the same layers, enforced by a unit test; a theme change copies its paint onto the live map instead of `setStyle`, which would drop the interleaved layers and visibility.
Overlay colours come from a palette per theme (`map/palette.ts`); the age ramp, route and opt-out colours are the same in both (D-051, D-085).

### 7.13 Offline, caching and installation

- **HTTP caching (Caddy):** content-hashed `/assets/*` one year, immutable; fonts 30 days, immutable; icons 7 days; the map styles 5 minutes with 1-day stale-while-revalidate; the page, `sw.js` and the manifest `no-cache`, so a deploy is picked up on the next load.
  Tiles: 1 day with 7-day stale-while-revalidate and ETag, in the browser's HTTP cache only (D-030).
- **Service worker** (`frontend/sw/sw.js`, hand-written, versioned by content hash per build): registered 4 s after the page's `load` event, at the next idle moment (at most 5 s later), so its install never competes with the first visit's data and tiles (D-169); precaches the build and the styles; pages are network-first with the cached shell as fallback, each cached under its own path, and served from the cache when the network has not answered within 5 s (a late answer still refreshes it); content-hashed build files (`/assets/`) are cache-first, while the unhashed entry files (`theme-boot.js`, the pages' scripts, the manifest, icons), served `no-cache`, are network-first like pages, so the first load after a deploy, still under the old worker, never runs the old build's copies; glyph ranges are cached as used; API GETs are network-first (8 s timeout), keeping successful responses within 30 MB (10 MB per entry, least recent evicted) and serving them offline, or when the proxy answers 502, 503 or 504 (the backend down or restarting; not the backend's own problem+json errors, D-156), marked `x-meshmap-offline`.
  Tiles, the live stream, health, metrics and observations (pages and whole days, which the HTTP cache keeps as immutable, D-158) are network-only: no tile is ever stored by the worker.
  The window's rows come from IndexedDB (§5.1) (D-030, D-051).
- **Backend down:** the derivation worker treats a page of rows that fails to arrive (network error, no answer within 30 s, or a proxy's 502, 503 or 504) as offline and builds the window from the saved rows; other error statuses are the API's answer and are shown as errors, except 429 and the backend's own 503 "server busy, retry shortly", which are retried after `Retry-After`, else backing off from 1 s (at most 10 s, 3 times).
  A 502, 503 or 504 with an `application/problem+json` body is the backend answering, not a proxy, so neither the worker nor the service worker takes it for down (D-156).
  The banner then says the server is not answering.
  An answer from the saved copy is not reused, so the next view request tries the API again: a restarted backend sends no `online` event, and the live stream's watchdog reconnects within 40 s (D-140).
  A fixed window has no stream: while the banner shows, the next live answer to `/retention` (polled every 5 minutes) has the page ask its views again.
- **Installable:** web app manifest (standalone, regular and maskable icons, Apple touch icon), mobile web-app meta tags, and Install app in Settings where the browser offers a prompt; on iOS, Add to Home Screen.
  Service workers and installation need HTTPS (localhost exempt).

### 7.14 Reset

Settings → "Reset and reload", after a confirmation, stops the derivation worker so its database can be deleted, clears local and session storage (layer choices, theme), deletes this site's IndexedDB databases, deletes the service worker's caches and unregisters it, then reloads without the query string, so the window and filters reset too.
The privacy policy mentions it (D-076).

### 7.15 Accessibility and controls

Native, labelled HTML controls (buttons, range and datetime inputs, ARIA roles) rather than a component library; sparklines and the traffic strip are small SVGs (D-018).
Essential controls work from the keyboard; Escape closes panels; colours are colourblind-safe and ordered by lightness; reduced motion disables pings and transitions.
Loading, empty, offline and error states are explicit.

## 8 Deployment and operations

Detail is in [operations.md](operations.md); this is the outline.

- **Compose services:** `postgres`, `redis`, `backend` (`meshmap serve`), `maintenance`, `web` (Caddy: frontend, API proxy with SSE flushing, tiles, fonts, styles; the only published port, on the host's loopback unless `WEB_BIND` says otherwise; Caddy runs unprivileged) and `basemap` (Planetiler; builds `basemap.pmtiles` when missing and every 30 days, separate because a build needs Java and ~8 GB heap) (D-049).
  The production stacks (`deploy/compose.production.yaml`, `deploy/stack.swarm.yaml`) also run `mqtt-buffer`, a Mosquitto bridged to the real broker that holds traffic for the backend across deploys (§2.1, D-205), and `backup` (§8, D-206).
  The optional `demo` profile adds a compose-only Mosquitto and a simulator with real encryption and signatures and deliberately bad input, which refuses non-private hosts.
- **Images:** `ghcr.io/868-no/map-backend`, `map-web`, `map-basemap` for `linux/amd64` and `linux/arm64`, built per pull request and published from `main` and version tags: each build pushes its `sha-<commit>` tag, and the shared tags (`latest`, `main`, versions) move to all three together once every build has succeeded.
  After a push to `main` publishes them, the `deploy` job calls the production Portainer stack's webhook (its URL in the `DEPLOY_WEBHOOK_URL` repository secret), which pulls the new images and recreates the stack, and then waits until the site serves the new commit (`/version.txt`) and `/health/ready` answers 200; deploys run one at a time, in push order.
  `deploy/compose.production.yaml` is a complete stack on published images with configuration in the Compose file (D-049).
- **Scaling out (D-157):** `deploy/stack.swarm.yaml` runs the API as several `serve --no-ingest` replicas beside one `serve` that alone ingests (§2), fetches weather and terrain (§6.18, §6.19) and reports broker health; `web` sends weather, terrain, capabilities and health to that process (`FETCH_UPSTREAM`) and the rest of `/api/*` to the replicas (`API_UPSTREAM`), both `backend:8000` by default.
  Per-visitor limits (§4.4) are per process, so they loosen with the replica count; Postgres connections are the shared budget.
- **Configuration:** environment variables (see `.env.example` and `backend/internal/config/config.go`) plus broker and channel YAML from `secrets/` or env (§2.1, §2.3).
  Key settings: `RETENTION_MONTHS`, `DEFAULT_WINDOW_HOURS`, `MAX_WINDOW_HOURS`, `LIVE_QUANTUM`, `SIGNATURE_POLICY`, `DEFAULT_KEY_FALLBACK`, `GEOLOCATION_*`, `MAP_TILE_SOURCE`, `MAP_STYLE_URL`/`MAP_STYLE_LIGHT_URL`, `OPERATOR_NAME`/`OPERATOR_CONTACT`, `TRUSTED_PROXIES`, `API_*`, `DB_API_CONNS`/`DB_INGEST_CONNS`, `INGEST_QUEUE_SIZE`, `WRITER_BATCH_SIZE`, `KEY_ATTEMPT_BUDGET`, `PUBLIC_METRICS_ENABLED`, `WEATHER_ENABLED`/`WEATHER_URL`, `TERRAIN_ENABLED`/`TERRAIN_URL`, `MAINTENANCE_INTERVAL_HOURS`.
  `check-config` validates and prints a redacted summary; invalid production configuration fails readably.
- **Security:** CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'` (WebAssembly compilation only, no JavaScript eval) with `connect-src 'self'` (plus `CSP_CONNECT_EXTRA`, empty by default, for an online basemap's host; D-167) and no inline scripts; no runtime CDN; HTTPS terminated by a proxy in front of `web`.
- **One address (D-211):** with `APP_URL` set on `web` (an origin, checked by the image's entrypoint, which refuses anything else), a request for any other host is redirected there with its path and query (308); `/health/*` and `/version.txt` are answered on every host, for the deploy job, the monitor and probes. Unset, nothing is redirected.
- **Health and metrics:** §4.1; key series are listed in operations.md.
  `/health/ready` also gives the seconds since each broker last delivered a message (`last_message_s`) and the backup service's last status (`backup`), both for the monitor (D-206, D-207).
- **Backups (D-206):** the production stacks' `backup` service (the pinned Postgres image and a short shell loop) dumps the whole database with `pg_dump -Fc` at 02:00 UTC, before retention at 03:00, and at start when the newest dump is a day old or missing.
  A dump replaces its `.partial` file only after `pg_restore --list` reads it; dumps older than `BACKUP_KEEP_DAYS` (default 7) are deleted after a good one, and a run is skipped as failed when the disk has less than twice the last dump's size free, so backups never fill the database's disk.
  The status (last success and attempt, file, size, whether the last attempt failed) goes to Redis after every run and hourly, so a Redis restart forgets it for at most an hour.
  It runs beside the backend rather than in it because the backend image is distroless, without `pg_dump`.
  The `backups` volume is on the host (Compose) or an NFS export (Swarm); keeping it on another disk or machine is the operator's choice.
- **Monitoring (D-207):** `.github/workflows/monitor.yml` runs `scripts/check-production.py` against `PRODUCTION_URL` every 15 minutes: a status other than ready, a broker not up, a broker silent for 15 minutes (after the backend's first 5), retention not run for 30 hours, or no good backup for 30 hours, each seen twice 2 minutes apart so a deploy does not count.
  A problem opens a GitHub issue labelled `production-alert` and fails that run, so GitHub notifies; while it lasts the issue's body is kept current without failing again, and the first clean check comments and closes it.
  Silence is the only sign of a stalled bridge (§2.1), since the backend's own broker connection stays up.
- **Licence:** GPL-3.0-only, because the backend's generated protocol code comes from Meshtastic's GPL-3.0 protobufs.
  Every dependency was checked for compatibility (Paho used under EDL); fonts, map data and images are listed in THIRD_PARTY_NOTICES.md.
  Visitors receive the compiled frontend, so the credits link to the source at the built commit (`SOURCE_REVISION`, or `SOURCE_URL` for a modified build) (D-050).

## 9 Performance

Targets are development budgets on a reference workload: 2 million retained observations, 2 000 nodes, 20 000 candidate edges, bursts of 100 MQTT messages/s, a 4 vCPU / 8 GiB database host.
Results are in [benchmarks.md](benchmarks.md).

- **Ingest** keeps running during queries and retention, with bounded backlog and recovery after database outages; seeding through the production path runs at 6 200–7 300 rows/s.
- **Opening a 3-day window:** ≤ 10 s from empty and ≤ 2 s when the browser already holds most of it.
  Pages are served by the time index independent of retained history (D-038), from stored encodings (D-046), streamed (D-057), compressed (gzip/zstd; cached whole days also brotli, D-168), and fetched in four parallel slices (D-040).
  `index.html` preloads `/api/v1/capabilities` and `/api/v1/retention` (`as="fetch"`, `crossorigin="anonymous"`) while the bundle loads; the app's `fetch()` of the same URL (cors mode, same-origin credentials) reuses them, also under the service worker, which sees one request per URL (D-169).
  A build plugin adds `<link rel="modulepreload">` for the derivation worker's script and `<link rel="prefetch">` for the engine's WebAssembly (content-hashed names known only from the bundles), so both download beside the main bundles; the module worker and its `fetch()` take them from the HTTP cache, also while still in flight, with one download each.
  Measured (Chromium, cold cache, 9 Mbit/s shared link, 150 ms RTT, empty data): the worker script done at 0.63 s instead of 1.39 s, the engine at 1.42 s instead of 1.95 s, the 3-day window's rows (with D-170) at 1.78 s instead of 2.31 s; the main bundles finish about 0.25 s later on a link shared equally (the prefetch is lowest priority where the link honours priorities).
  `<link rel="preload" as="fetch">` for the engine works the same but draws Chrome's "preloaded but not used" warning (the document never uses it); `as="worker"` is not supported (D-171).
- **Client:** no raw history in the JavaScript heap (< 250 MiB target; rows live in WebAssembly memory), no React re-render per packet, batched GPU layers with memoised data that only recolour on selection, search or theme changes, a cursor readout that bypasses React state (D-058), level of detail for links (§7.4), and marker clusters below zoom 10, recomputed only when the zoom settles (§7.3, D-204).
  Pan and zoom target at least 30 fps on a desktop GPU (lowered from 60, D-208); pings are bounded (80, one per transmission) and run in their own canvas (D-083).
  Vendor code (MapLibre, deck.gl, React) is split into chunks that stay cached across app deploys (D-039).
- **Engine:** a 72 h reference snapshot builds in ~0.2 s off the main thread; shared passes (traceroute hop samples, packet copies, position groups, radio groups, routing replies) run once per rebuild (D-060, D-083).
  One pass sorts out the rows of the packet types that single-type passes need (NodeInfo, map reports, positions, telemetry, NeighborInfo, traceroutes); what a view asks of an interned string (signature rank, decoded crypto, a channel name's preset) is worked out once when it is interned; per-packet work reuses scratch lists instead of allocating maps.
  After rows are dropped (trimming, the row cap, a fresh start), interned strings no row holds any more are dropped once the interner has doubled since it was last compacted, so names, status texts and ping rows' strings do not pile up over a long session; the row cap trims in place, without copying the kept rows.
  Health's airtime list keeps every node, since the panel shows any node's share.
  Incremental derivation is not worth its complexity at this scale.

## 10 Testing

### 10.1 Strategy

- **Backend unit tests** (`scripts/go.sh go test ./...`): crypto vectors and mutations, XEdDSA cross-checks, protocol limits and fuzzed garbage, ingest rules, window semantics, configuration, API contract (the committed `docs/api-openapi.yaml` must equal the generated document), and replay of committed **real captures** from `mqtt.868.no` through the production `Process`, which fails on any signature rejection of real traffic (D-003).
- **Integration tests** (`scripts/integration.sh`): throwaway Postgres, Redis and Mosquitto containers on a private network and `go test -tags integration` beside them, without Docker-socket access from the test container (D-010).
  They cover the pipeline, dedupe across brokers, partitions and migration, retention, time isolation on `/observations`, Redis independence, and that a streamed row equals the stored one (D-033, D-041).
- **Engine tests** (`scripts/wasm.sh test`): unit tests per module, an isolation test (every derived field comes only from in-window rows), and two **golden fixtures** from a recorded 12-hour live window (`frontend/engine/tests/fixtures/mesh-12h`): `expected.json` compares the engine with the retired server views, with the newer rules switched off (§5.2); `engine.json` locks the engine's own output with default options for every view kind (snapshot, traffic, a filtered snapshot, 10 node panels, 4 packet logs, 4 packet routes, health, reach from 2 nodes, 1 link history, a watchlist and the regions), including MQTT edges and downlink flags; `frontend/tests/viewTypes.test.ts` type-checks every one against the view types generated from the engine's structs (`frontend/src/derive/views.gen.ts`, built on in `views.ts`, D-202), and the engine's tests regenerate that file, which CI requires to be unchanged.
  Re-record with `UPDATE_GOLDEN=1 scripts/wasm.sh test` only after an intended behaviour change (D-041, D-060).
- **Frontend unit tests** (Vitest): row store, persistence, pings, labels, draw order, the colour model and ramp contrast (D-085), regions geometry, theme, URL state, and a type-checked test fitting the golden output to the view types (D-083).
- **End-to-end** (Playwright against a running stack built with the end-to-end hook, never in production builds): layout and overlays, selection, the period controls, labels via `queryRenderedFeatures`, attribution, pings through a mocked stream, privacy and Settings, reset, the start view, permanent links, PWA (offline reload, no tile in any worker cache) and a reference-density performance scene.
  Service workers are blocked by default and opted into for the PWA test (D-030).
  Documentation screenshots are taken only with `UPDATE_SCREENSHOTS=1`, into `docs/screenshots/` for review (D-017): they assert nothing, and a software-rendered full-page screenshot is slow.
  CI runs them on pull requests and on pushes to `main` and version tags, against the demo stack (simulated mesh on a local broker plus two days of seeded history, `MESHMAP_NO_BASEMAP` set, one retry), split test by test (`fullyParallel`) across four parallel jobs (Playwright shards), one test at a time in each (two at once on a runner made the map take clicks for long presses); one job builds the stack's images once, with layers cached between runs, and hands them to the shards as an artifact; tests that need the self-hosted basemap skip themselves there and run against a full deployment (D-110).
- **CI** (`.github/workflows/tests.yml`) on every pull request and on pushes to `main` and version tags (the full list of checks is in operations.md): Go vet, gofmt and unit tests; integration tests; engine tests including the goldens; frontend type check, lint, unit tests and production build; and a check that `src/api/schema.d.ts` regenerates unchanged from `docs/api-openapi.yaml` (D-083); then the end-to-end tests on the demo stack in four shards, as above.
  The images are built only after all of these pass, end-to-end included.

### 10.2 Acceptance tests

Code comments cite these by number.

Crypto and ingestion:

1. A valid AES-CTR envelope with a configured channel name and PSK is decoded and stored once per distinct gateway reception.
2. The same packet with a wrong key is kept header-only as `encrypted`, a malformed protobuf is discarded; CTR parsing is never called integrity verification.
3. AES-CCM authenticates a valid packet; a modified ciphertext or tag is never decoded and is kept header-only as `encrypted`.
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
18. The API rejects a 14-days-plus-one-second window and a start before retention; it never returns extra history.
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

29. The default window is the server's rolling default; presets 1 h–14 d work; setting both bounds and sliding back to the retention limit works, with correct time zones across DST.
30. The theme follows the browser unless chosen and never flashes; borders, land cover, roads and city names show by default while local place names, peaks, road names and water names are hidden, and each appears in test areas once enabled; layer choices persist per viewer; every switch has a tooltip.
31. Selecting a node shows only its links and its accuracy circle; clicking empty map deselects; panels overlay the map without resizing it; API payloads never carry envelopes, ciphertext or message bodies; the app is installable and reopens offline with the last data received, while no tile is stored by the service worker.
32. With 2 million rows, 2 000 nodes and 20 000 candidate edges, benchmarks, browser memory and frame rate are measured and documented; the browser holds no raw history.
33. Retention runs daily and is safe to repeat; `packet_log` is the only table of mesh data and `weather_hour`, `terrain_height`, `place_name` and `place_key` the only other tables; retention trims `packet_log` and `weather_hour` and leaves terrain, which does not change; Redis can be wiped without data loss.
34. The stack comes up from a fresh checkout with example configuration and `docker compose up -d --build`; demo mode generates useful traffic without reaching public brokers.
35. Integration tests cover TLS broker reconnects, invalid credentials, gateway duplication, database unavailability, health signalling, the bounded queue and recovery after restart.

## 11 Known limitations and open questions

- **Coverage:** the map shows what this service received over MQTT while running; it is not a complete history.
  Queue overflow and broker disconnections lose data (§2.7).
- **Receive time only:** timestamps are `observed_at`, not transmission time.
- **Trust:** keys are trusted on first use and lapse when their announcements age out of retention.
  CTR decryption proves nothing about integrity; CCM proves channel membership, not sender.
  Topics, gateway ids and node ids are unauthenticated claims.
  Map report names and roles are unauthenticated too.
- **CCM** is verified only against specification vectors; no real AEAD traffic has been observed yet (D-004).
- **Relay bytes:** a unique match can still name the wrong node when the true relay was not seen in the window (§6.3).
- **Downlinks** are inferred from 0 dB traceroute readings; a node that downlinks but is never traced is not found, and a downlinked packet can still pass for a direct reception (D-054, D-064).
- **Router reliability** is a lower bound because gateways uplink only the first copy they hear (§6.9).
- **Estimates** are coarse ("somewhere among these anchors" uncalibrated, kilometres even calibrated).
  Small movements of nodes publishing 12–15-bit positions cannot be seen, since their cells are kilometres wide (D-073).
- **Reach** assumes intermittent links are always there and knows nothing of unseen links (§6.8).
- **Uplink opt-out** withholds names, not ids, traffic or positions (§2.5).
- **Envelopes** keep text messages readable to anyone with the channel key; whether to keep them is open for the operator (D-051).
- **Frame rates** have been measured only with software WebGL; the 30 fps desktop target is unverified on GPU hardware (benchmarks.md).
- **Marker clusters** follow one fixed screen-space rule; links between two clusters are drawn once per member pair, on top of each other, and a cluster's count does not say which members are linked (D-204).
- **Firmware:** minimum 2.7; behaviour that depends on newer fields degrades conservatively.
