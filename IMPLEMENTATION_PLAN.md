# Meshtastic MQTT Mesh Observatory — Implementation Plan

**Derived from:** `MESHTASTIC_MESH_MAP_SPEC.md` v1.0 (2026-10-31)
**Backend language:** Go (user preference; spec §13 permits Go when protocol support is demonstrably adequate and the architecture stays maintainable)
**Purpose:** Turn the spec into a concrete build plan: frameworks, libraries, module boundaries, programming patterns, data formats, test strategy and milestone task lists. Spec section numbers are referenced as `§n`.

Protocol facts below (signed-byte layout, CCM parameters, nonce layout, first-contact rule, topic structure) were checked on 2026-10-31 against upstream firmware `CryptoEngine.cpp` / `Router.cpp`, the Meshtastic encryption-technical reference, `mesh.proto` / `mqtt.proto`, and the MQTT integration docs. Re-verify against the pinned revision in M0 and record the result in `docs/protocol-compatibility.md`.

---

## 1. Decisions at a glance

| Area | Decision | Why |
| --- | --- | --- |
| Backend | Go 1.26, single module `github.com/<org>/meshmap`, one static binary `meshmap` with subcommands | Static multi-arch binaries, goroutine-per-broker concurrency, low memory, no interpreter in the image |
| HTTP API | `net/http` `ServeMux` (Go 1.22+ patterns) + **huma v2** (`humago` adapter) for typed handlers, validation and generated **OpenAPI 3.1**; huma `sse` package for streams | OpenAPI must match behaviour (§18); huma generates it from the Go types that actually serve requests |
| MQTT | `github.com/eclipse/paho.golang` (`autopaho`, MQTT 5) as default; `github.com/eclipse/paho.mqtt.golang` behind the same `BrokerClient` interface for brokers that only speak 3.1.1 | Spec requires v5 and v3.1.1 compatibility |
| Protobuf | `meshtastic/protobufs` git submodule pinned to tag **v2.8.2**; Go code generated with `buf generate` + `protoc-gen-go` into `internal/protocol/pb/` and committed; `google.golang.org/protobuf` runtime | Pinned bindings, reviewable upgrades; avoids third-party mirrors that lag |
| AES-CTR | stdlib `crypto/aes` + `cipher.NewCTR` | Standard library |
| AES-CCM | `github.com/pion/dtls/v3/pkg/crypto/ccm` (RFC 3610; nonce 7–13 B, even tag 4–16 B) with `NewCCM(block, 12, 13)` | Widely deployed (Pion DTLS), MIT, exact parameters Meshtastic needs |
| XEdDSA verify | Public-key conversion X25519→Ed25519 via `filippo.io/edwards25519/field` (`y = (u−1)/(u+1)`, sign bit cleared) + stdlib `crypto/ed25519.Verify`; **gated by an independent Go cross-check (stdlib `crypto/ed25519` + `golang.org/x/crypto/curve25519` key derivation) and real 2.8 captures** | No vetted pure-Go XEdDSA library exists. Verification needs only the birational map plus standard Ed25519; the map uses a vetted field implementation. Fallback if the gate fails: cgo binding to libxeddsa. Recorded in `docs/decisions.md` |
| Database | PostgreSQL 16, `github.com/jackc/pgx/v5` (`pgxpool`, `CopyFrom` for batch inserts, raw SQL, no ORM) | §5: one table, streaming reads, no object graphs |
| Cache | Redis 7 (`save ""`, `appendonly no`, `maxmemory` + `allkeys-lru`), `github.com/redis/go-redis/v9` | Ephemeral and rebuildable |
| Config | `github.com/caarlos0/env/v11` for env, `gopkg.in/yaml.v3` + validation for mounted broker/key files | Readable startup failures |
| CLI | `github.com/spf13/cobra`: `serve`, `ingest`, `api`, `maintenance`, `check-config`, `init-schema`, `demo-publish`, `gen-fixtures`, `seed`, `bench` | One image, several roles |
| Observability | `log/slog` JSON, `github.com/prometheus/client_golang` | Counters, never packet text |
| Numerics | `gonum.org/v1/gonum/mat` for the geolocation WLS / Levenberg–Marquardt solver | Small, dependency-light |
| Frontend | TypeScript 5, React 19, Vite, `maplibre-gl` 5, `deck.gl` 9 (`@deck.gl/mapbox` `MapboxOverlay`, interleaved), Zustand, TanStack Query, `comlink` workers, `uPlot`, Luxon, Radix UI, CSS Modules | Spec default; GPU layers; no runtime CDN |
| Basemap | **OpenMapTiles schema for both modes.** Online: OpenFreeMap (no key). Self-hosted: Planetiler → PMTiles served by Caddy; glyphs/sprites bundled. One custom dark style `web/styles/dark.json` with templated source URL | One style to maintain; `mountain_peak`, `place`, `transportation_name`, `boundary` layers provide the mandatory labels |
| Web | Caddy 2 (static assets, `/api` reverse proxy, PMTiles range requests, gzip/zstd) | Simple config |
| Tests | Go `testing` + `testify` + `pgregory.net/rapid` (property tests) + `testcontainers-go`; Vitest + Testing Library; Playwright; API load via `meshmap bench api` built on the `github.com/tsenart/vegeta/v12` library | §13/§17; all backend tooling is Go, no second scripting language |
| Packaging | Multi-arch (`linux/amd64`, `linux/arm64`) `distroless/static` images via `docker buildx`; `compose.yaml` with `demo` profile | §14 |

---

## 2. Repository layout

```text
868map/
  compose.yaml                   # postgres, redis, backend, maintenance, web (+ demo profile)
  compose.override.example.yaml
  .env.example
  README.md
  MESHTASTIC_MESH_MAP_SPEC.md
  IMPLEMENTATION_PLAN.md
  backend/
    Dockerfile                   # multi-stage: buf generate -> go build (CGO_ENABLED=0) -> distroless/static
    go.mod, go.sum, buf.yaml, buf.gen.yaml
    protobufs/                   # git submodule meshtastic/protobufs @ v2.8.2
    cmd/meshmap/main.go          # cobra root
    internal/
      config/                    # env + YAML models, validation, redaction
      observability/             # slog setup, prometheus registry, counters
      mqtt/                      # BrokerClient interface, autopaho impl, paho v3 impl, topic parser, backoff
      protocol/                  # pb/ (generated), envelope.go, ports/, normalize.go, limits.go
      security/                  # psk.go, aesctr.go, aesccm.go, xeddsa/, identity.go, policy.go
      ingest/                    # pipeline.go, stages.go, dedupe.go, writer.go
      storage/                   # schema.sql (embed), schema.go, repo.go, keyset.go
      cache/                     # redis.go, keys.go, singleflight.go, fallback.go
      window/                    # window.go, predicate.go, revision.go, cursor.go
      graph/                     # evidence.go, reducer.go, confidence.go, relay.go
      geo/                       # anchors.go, estimator.go, geometry.go, calibration.go
      query/                     # snapshot.go, traffic.go, nodes.go, edges.go, replay.go
      api/                       # server.go, routes_*.go, dto/, middleware/ (ratelimit, timeout, size), sse.go
      maintenance/               # retention.go, lock.go, runner.go
      demo/                      # simulator.go, scenario.go, publisher.go, fixtures.go
    test/
      fixtures/                  # real-format envelopes, captured signed packets, scenario JSON
      integration/ performance/ contract/
    internal/testutil/           # Go-only fixture builders, independent key derivation, scenario DSL
  frontend/
    Dockerfile                   # build stage; output copied into web image
    package.json, pnpm-lock.yaml, vite.config.ts, tsconfig.json
    src/
      api/        # openapi-generated types, fetch client, SSE client, cursors
      state/      # zustand stores: window, filters, selection, replay, live
      map/        # MapCanvas, deck layers, style loader, pmtiles protocol, clustering
      timeline/   # dual-handle range, presets, scrubber, traffic strip
      features/   # node-panel, edge-panel, unpositioned-list, legend, filters, search
      workers/    # replay-fold.worker.ts, cluster.worker.ts (comlink)
      components/ # Radix wrappers, uPlot charts, status banners
      lib/        # time (Luxon), geo math, color scales, a11y helpers
    tests/ (vitest)  e2e/ (playwright)
  web/
    Dockerfile                   # caddy + built frontend + styles + fonts + sprites
    Caddyfile
    styles/dark.json             # OpenMapTiles-schema dark style (source URL templated)
    assets/fonts/ assets/sprites/
  scripts/
    basemap_import.sh            # thin wrapper: runs the Planetiler container -> PMTiles for a configurable area
    bench.sh                     # thin wrapper: `meshmap seed` + `meshmap bench api` + `meshmap bench mqtt`
  docs/
    architecture.md decisions.md protocol-compatibility.md operations.md basemap.md benchmarks.md
    api-openapi.yaml             # exported by `meshmap api --dump-openapi`, diffed in CI
```

---

## 3. Backend architecture

### 3.1 Process model

One binary, one image. The compose `backend` service runs `meshmap serve`, which starts the ingest supervisor and the HTTP API **in one process** (§14 item 3) with a shared `context.Context` and `errgroup`. `meshmap ingest` and `meshmap api` run the roles separately for scale-out. Roles communicate only via PostgreSQL and Redis, so both layouts behave identically:

- Ingest publishes compact accepted-observation summaries on Redis pub/sub `meshmap:live`; API SSE handlers subscribe.
- If Redis is unavailable, `serve` mode falls back to an in-process fan-out channel; split mode reports `status: live-unavailable` on the SSE stream. Never stale data.

### 3.2 Ingest pipeline (pattern: staged pipeline of pure functions, one side-effecting writer)

```text
BrokerClient goroutine (per broker)
  -> RawMessage{BrokerID, Topic, Payload, Retain, ObservedAt}
  -> bounded channel (cap INGEST_QUEUE_SIZE; on full: drop + counter, never block the MQTT reader)
  -> worker pool (N = GOMAXPROCS):
       decode:    topic parse, ServiceEnvelope parse, size/structure limits            (pure)
       crypto:    candidate key selection, CTR or CCM, Data parse                      (pure, attempt budget)
       verify:    signature status, identity rules                                     (pure + identity cache read)
       normalize: port handler -> typed metadata, dedupe keys                          (pure)
       dedupe:    observation_key SETNX in Redis, DB fallback                          (I/O)
  -> writer goroutine: batch CopyFrom into packet_log, then dedupe-mark + identity-cache update + live publish
```

**Two input paths** after `decode`: `encrypted` → crypto stage; `decoded` (gateways uplinking unencrypted, discouraged but real) → the same `Data` schema validation and port handler, the **same signature verification** (inbound `xeddsa_signed` ignored), status `plaintext_uplink` recorded in `decoded_metadata.crypto` and surfaced in the UI as weaker provenance. Plaintext uplinks are accepted only for channels configured with `accept_plaintext: true` (default true for channels whose name matches a configured channel, otherwise counted as `plaintext_unconfigured` and dropped). PKI-flagged packets are rejected on both paths.

**Ingress backpressure (amendment 10).** MQTT brokers deliver QoS 0 for Meshtastic topics, so real backpressure to the sender is impossible. When the bounded queue is full, messages are dropped at ingress with `meshmap_ingest_dropped_total{reason="queue_full"}`; the writer retries DB errors with backoff while the queue absorbs up to `INGEST_QUEUE_SIZE` messages (default 20 000 ≈ several minutes at 100 msg/s). Ingest-gap intervals (queue-full or broker-disconnected periods) are kept in a bounded in-memory ring and Redis list (TTL = retention) and exposed as operational coverage hints; the loss window is documented in `docs/operations.md`.

Patterns:
- Each stage returns `(Observation, error)` where errors are typed `RejectError{Category}`; rejections only increment `meshmap_ingest_rejected_total{category=...}` (`malformed_proto`, `no_key`, `ctr_parse_failed`, `ccm_auth_failed`, `sig_invalid`, `sig_malformed`, `pki_only`, `oversize`, `retained_ignored`, `duplicate_observation`, `limit_exceeded`, …). No payload bytes in logs.
- `ObservedAt = time.Now().UTC()` is captured in the MQTT callback, before queuing (§4.1).
- Per-message deadline via `context.WithTimeout`; key attempt budget (default 4).
- Writer: `pgx.CopyFrom` of up to `WRITER_BATCH_SIZE` rows or every 200 ms; on DB error, exponential backoff while the channel bound provides backpressure; readiness reports `degraded`.
- Shutdown: cancel context → clients unsubscribe → workers drain → writer flushes.

### 3.3 MQTT module

- `BrokerClient` interface: `Run(ctx) error`, `Messages() <-chan RawMessage`, `State() ConnState`. Implementations: `autopahoClient` (MQTT 5: `autopaho.NewConnection` with `ClientConfig{ServerUrls, TlsCfg, ConnectUsername/Password, CleanStartOnInitialConnection: true, SessionExpiryInterval: 0, KeepAlive: 30}`) and `pahoV3Client`.
- Reconnect: autopaho handles it; we add full-jitter backoff config (1 s → 60 s) and re-subscribe on `OnConnectionUp`. Connection state → gauge metric + readiness.
- Topic parser matches `{root}/2/e/{channel}/{gateway}` and optional legacy `{root}/2/c/{channel}/{gateway}`, where `{root}` may span **any number of segments** (e.g. `msh/EU_868/NO/Østlandet` on mqtt.868.no); the parser anchors on the last `/2/{e|c|json|map|stat}/` marker, not a fixed depth. Topic segments are UTF-8 and must not be ASCII-folded. `/json/`, `/map/` and `/stat/` are recognised and counted, not processed in v1 (§3.1).
- `Retain` flag → `retained_ignored` unless `accept_retained: true` for that broker.
- No publish capability compiled into the client wrapper.

### 3.4 Protocol module

- `pb/` generated by `buf generate` (`protoc-gen-go`, `paths=source_relative`, `nanopb.proto` vendored for options). A golden test compares `protoregistry` descriptors to a committed snapshot so protobuf upgrades are explicit.
- `envelope.go`: `ParseEnvelope([]byte) (Envelope, error)` with limits: payload ≤ 512 B, `encrypted` ≤ 256 B, `gateway_id` matches `^![0-9a-f]{8}$`, `channel_id` ≤ 64 chars; `proto.UnmarshalOptions{DiscardUnknown: false, RecursionLimit: 8}`.
- `ports/`: one file per port, pure `Decode(*pb.Data) (Metadata, error)`:
  - `nodeinfo.go` (`User`): names length-limited and control-char-stripped, `hw_model`, `role`, `public_key` (32 B or absent), `is_licensed`.
  - `position.go`: `latitude_i/longitude_i` × 1e-7, range-validated, `altitude`, `precision_bits`, `time`, `location_source`; zero lat/lon → `position_absent`. `precision_bits == 0` → stored as `precision_known=false`: displayed as "precision unknown", never a geolocation anchor (minimum supported firmware is 2.7, where this should not occur, but sender firmware is not observable over MQTT).
  - `telemetry.go`: device and environment metrics, clamped.
  - `neighborinfo.go`: `node_id`, `last_sent_by_id`, ≤ 64 neighbors, `snr` float dB **unchanged**, `last_rx_time`.
  - `traceroute.go` (`RouteDiscovery`): `route`, `snr_towards`, `route_back`, `snr_back` with SNR **/4**; validate lengths, loops, ≤ 8 hops; invalid → `Invalid`. Firmware `insertUnknownHops` fills hops it could not identify with `0xFFFFFFFF` (NODENUM_BROADCAST) and SNR `INT8_MIN` (−128): such hops are kept as `unknown` placeholders, **any segment touching one yields no edge**, and −128 SNR is stored as null, never −32 dB.
  - `text.go`: size only (no bodies stored by default, §5). `routing.go`: ACK/NAK metadata, `request_id`, `ack_proof` presence only. `other.go`: well-formed unknown ports → `packet_type='other'`.
- `normalize.go`: node IDs as `uint32`; `!%08x` helpers; broadcast `0xFFFFFFFF`; `rx_time` fixed32 seconds → nullable `time.Time`; `transport_kind` from enum name; `relay_hint = relay_node & 0xFF` if nonzero.

### 3.5 Security module

**PSK (`psk.go`)** — base64 (and optional hex) parsing; 1-byte shorthand: `0x00` → unencrypted (accepted only with `allow_unencrypted_channels`), `0x01` → default key `d4f1bb3a20290759f0bcffabcf4e6901`, `0x02..0xFF` → default key with last byte `+ (n−1)`; 16 B → AES-128, 32 B → AES-256, else config error. Channel hash = XOR(name bytes) ⊕ XOR(key bytes), ⊕ `0xAE` for AEAD channels; used only to order candidate keys. `KeyRef` has a `String()` that returns a label, never material.

**AES-CTR (`aesctr.go`)** — nonce (16 B) = `LE64(packet_id) || LE32(from) || 0x00000000`; `cipher.NewCTR(block, nonce)`. Success = `Data` unmarshals **and** the port handler accepts the payload. Status `decrypted_unauthenticated`.

**AES-CCM (`aesccm.go`)** — `ccm.NewCCM(aes, 12, 13)`; nonce = first **13 bytes** of the 16-byte nonce above (hostap-style CCM, L=2); AAD = `LE32(from) || LE32(to)`; input = ciphertext || 12-byte tag; `Open` failure → reject; **no CTR fallback** for channels configured `mode: ccm`. Confirm nonce truncation and AAD byte order against real 2.8.1+ AEAD traffic in M0.

**XEdDSA (`xeddsa/`)**
- `ConvertX25519PublicKey(u [32]byte) (ed25519.PublicKey, error)`: `fe.SetBytes(u)`; `y = (u − 1) · (u + 1)⁻¹` via `field.Element.Subtract/Add/Invert/Multiply`; encode `y.Bytes()` with bit 255 cleared; reject `u + 1 == 0` and non-canonical inputs. Result cached per node in the identity index.
- `Verify(pk, from, id, to uint32, d *pb.Data, sig []byte) bool`: build buffer `0x01 | LE32(from) | LE32(id) | LE32(to) | LE32(portnum) | LE32(request_id) | LE32(reply_id) | LE32(emoji) | LE32(bitfield or 0) | flags | payload` with `flags` bit0 = `want_response`, bit1 = `has_bitfield`; `ed25519.Verify(edpk, buf, sig)`.
- Signature field rules: empty → `unsigned`; length ≠ 64 → `sig_malformed` reject; `TRACEROUTE_APP` → `not-applicable` (documented exemption); inbound `xeddsa_signed` flag ignored.
- **Acceptance gate for this implementation (M0), Go only:**
  1. *Independent conversion cross-check* (`internal/testutil/xkeys.go`): generate Ed25519 seeds with stdlib `crypto/ed25519`; derive the matching X25519 private scalar as the clamped first 32 bytes of `SHA-512(seed)` and the X25519 public key with `curve25519.X25519(scalar, curve25519.Basepoint)`; keep only seeds whose Ed25519 public key has sign bit 0 (XEdDSA's canonical form). For ≥ 1 000 such keys, `ConvertX25519PublicKey(x25519Pub)` must equal the stdlib Ed25519 public key byte-for-byte. This exercises the Montgomery→Edwards map against two unrelated implementations (stdlib Ed25519 scalar multiplication and x/crypto X25519) without touching the code under test.
  2. *Signature round-trip*: sign the firmware-layout buffer with stdlib `ed25519.Sign` using those seeds and verify through the production `Verify` path; byte-flip the payload, each header field and the signature → must fail; keys with sign bit 1 → must fail.
  3. *Ground truth*: at least one captured signed NodeInfo and one Position from a real firmware 2.8 node verify; the same capture with the signature zeroed is `unsigned`, with one flipped bit is rejected.
  If any gate fails and cannot be fixed, switch to a cgo libxeddsa binding (documented fallback) before claiming production readiness (§13).
- The same key derivation is used by the demo simulator to produce verifiable signed packets (node number = CRC-32 of the X25519 public key), so demo traffic exercises the real verification path.

**Identity (`identity.go`)** — mirrors firmware `Router.cpp` `checkXeddsaReceivePolicy` (verified 2026-10-31 at firmware `332b5b0`):
- First contact: signed `NODEINFO_APP` from an unknown sender is promoted only if `len(public_key)==32`, `crc32.ChecksumIEEE(public_key) == from`, and the signature verifies under that key; a signed first-contact NodeInfo that fails these checks is **rejected** (firmware drops it). Other signed packets from an unknown sender → `unverifiable` (default) or rejected under `SIGNATURE_POLICY=strict`.
- Known signer: signature must verify, and a signed NodeInfo must additionally claim the **same** key that signed it and that key must hash to `from` (`signedNodeInfoConsistent`); otherwise reject.
- Node public keys are public data and are stored in `decoded_metadata.public_key` (base64) on accepted NodeInfo rows, so the identity index rebuilds from `packet_log` with plain SQL — no re-decryption, unaffected by PSK rotation. PSKs and private keys never touch the DB.
- Index: Redis hash `meshmap:ident:{node}` → `{pubkey, edpk, since, row_id}`, TTL = retention; rebuilt lazily on miss and on startup (`packet_type='nodeinfo' AND signature_status='verified'`, earliest-retained verified binding per node). Unsigned conflicting NodeInfo is stored with `decoded_metadata.key_conflict=true` and counted; it never overwrites, and query-layer name/role selection skips `key_conflict` rows.

**PKI DMs** — `pki_encrypted=true` or channel hash 0 with `encrypted` → `pki_only` reject; PSKs never tried.

### 3.6 Storage module

- `schema.sql` (embedded with `embed.FS`) exactly as §5 plus `CREATE INDEX IF NOT EXISTS packet_log_brin ON packet_log USING BRIN (observed_at)` (keep/drop after M5 benchmark). Schema version in the **table comment** (`COMMENT ON TABLE packet_log IS 'meshmap-schema:1'`, read via `obj_description`); `init-schema` runs under `pg_advisory_lock(hashtext('meshmap:schema'))` with idempotent statements. No migration table.
- `decoded_metadata` Go structs (JSON-tagged, versioned by `decode_version`), minimal:
  - nodeinfo `{long_name, short_name, hw_model, role, has_public_key, key_conflict}` (key material only in `envelope_bytes` + ephemeral identity index)
  - position `{lat, lon, alt, precision_bits, loc_source, pos_time}`
  - telemetry `{kind, battery, voltage, ch_util, air_util, uptime, temp, humidity, pressure}`
  - neighborinfo `{reporter, neighbors:[{id, snr, last_rx}], interval}`
  - traceroute `{route, snr_towards, route_back, snr_back, request_id, is_reply, valid}`
  - common `{via_mqtt, want_ack, rx:{direct_rf, reason}}` — `direct_rf` precomputed at ingest (§7.1 C)
- `repo.go` functions accept a `window.Window` only; streaming via `pgx.Rows` iteration; keyset pagination on `(observed_at, id)`.
- Dedupe (`ingest/dedupe.go`), SHA-256 truncated to 16 B:
  - `logical_packet_key = H(from, packet_id, to, channel_name, portnum, canonical_payload)` where canonical payload is the decrypted `Data` re-marshalled deterministically with `xeddsa_signature` cleared; mutable header fields excluded. **Exception:** for `TRACEROUTE_APP` the payload is excluded (every hop rewrites the `RouteDiscovery`), so all partial-route copies of one traceroute share a logical key.
  - `observation_key = H(logical_packet_key, gateway, rx_time, rx_snr, rx_rssi, hop_limit, hop_start, relay_hint, payload_hash)`. Every distinct reception — different gateway, different relay, different hop count, different partial traceroute route — is a separate row and separate RF evidence. Only byte-identical re-deliveries of the same gateway's upload (second broker / bridge / QoS retry) are suppressed.
  - Suppression (amendments 7, D-011, D-013): workers atomically claim the `observation_key` in an in-process in-flight set, then check committed keys (in-process TTL set → Redis `meshmap:obs:{key}` → DB when Redis is down). The writer marks Redis only after commit; a claimed observation is retried until it commits, so a dropped message never suppresses a later copy. Copies of the same gateway upload from another broker are recorded in `decoded_metadata.also_via` — merged before insert while in flight, otherwise applied as a batched UPDATE by row id (fillfactor 90 for HOT updates) — a debug aid, never extra receptions (D-013).

### 3.7 Cache module

- Key: `meshmap:v{decode_version}:{config_rev}:{retention_rev}:{kind}:{start_ms}:{end_ms}:{at_ms}:{filters_hash}`; `config_rev` = hash of channel/key config + policy flags; `retention_rev` = counter bumped by maintenance.
- Lives in the **backend** (Redis). Rolling/live windows are quantized server-side (amendment 6): `end = floor(now, LIVE_QUANTUM)` (default 10 s), `start = end − duration`; the effective window is echoed so the client uses identical boundaries and its TanStack Query keys hit too. Fixed windows are used as given (ms precision).
- TTL: `end < now − 60 s` → immutable, 1 h; live windows → `LIVE_QUANTUM` plus `golang.org/x/sync/singleflight` in-process and a Redis lock across processes.
- Every cache call wrapped by `fallback.go`: error → metric + direct compute.

### 3.8 Window and time module (pattern: value object + single predicate)

```go
type Window struct { Start, End time.Time; At *time.Time } // UTC
func Parse(start, end, at string, bounds Retention, maxDur time.Duration) (Window, error)
func (w Window) EffectiveEnd() time.Time
func Predicate(argStart, argEnd int) string // "observed_at >= $n AND observed_at < $m"
```

- `Parse` rejects `end <= start`, duration > 7 d, `start < cutoff`, `end > now + skew`, `at ∉ [start,end]` with RFC 9457 problem details (huma default). Never widens.
- A test scans `internal/**/*.go` for SQL containing `observed_at` and fails unless it goes through `Predicate`; integration tests implement §17 tests 11–20.
- `revision.go`: `{decode_version}.{config_rev}.{retention_rev}.{max_id_in_window}`.
- `cursor.go`: base64url(JSON `{s,e,a,f,r,o,i}`) + HMAC-SHA256; mismatch with the request's window/filters/revision → 400. Secret (amendment 8): `API_CURSOR_SECRET` if set; otherwise generated once and stored in Redis `meshmap:cursor_secret` via `SET NX` (shared by all API replicas, survives restarts while Redis lives); if Redis is unreachable at boot, a per-process random secret is used and readiness reports it. `meshmap ingest`/`api` split mode with >1 API replica requires `API_CURSOR_SECRET` (`check-config` enforces). Losing the secret only invalidates in-flight cursors (clients restart from the window start).

### 3.9 Query layer (SQL groups, Go folds)

- `snapshot.go` for `[start, EffectiveEnd)`: node presence (`GROUP BY source_node_id`, `COUNT(DISTINCT logical_packet_key)`), latest in-window NodeInfo and Position (`DISTINCT ON (source_node_id) … ORDER BY source_node_id, observed_at DESC, id DESC`), edge-evidence stream (`neighborinfo`, `traceroute`, `rx.direct_rf`, `relay_hint`) folded by `graph.Reducer`, referenced-only nodes, geolocation estimates, unique-vs-reception counts.
- `traffic.go`: `date_bin($bucket, observed_at, $start)` with a fixed bucket ladder (1 m, 5 m, 15 m, 1 h, 6 h) capped at ~600 buckets.
- `replay.go`: compact deltas `{t, kind, node, gw, type, sig, rf:{snr,rssi}, pos?, name?, edge?}`, `limit ≤ 2000`, keyset cursor; checkpoints every `max(duration/48, 15 min)` computed on demand via snapshot with `at`, cached.
- Bounds: ≤ 5 000 nodes, ≤ 20 000 edges per response; beyond that, top-N by sample count with `truncated: true`.

### 3.10 Graph module

```go
type Evidence uint8 // Neighbor, Traceroute, DirectRF, RelayHint
type Sample struct { T time.Time; SNR *float32; RSSI *int16; Ev Evidence; RowID int64; Logical [16]byte }
type Edge struct { Src, Dst uint32; Samples []Sample; Confidence Confidence; Reason string }
```

- `reducer.go` folds evidence rows into `map[[2]uint32]*Edge` per §7.1: NeighborInfo A lists B → `B→A` (float SNR as reported); traceroute adjacent pairs forward and back separately, SNR/4; direct RF `A→G` when `rx.direct_rf` (gateway published, `via_mqtt=false`, `hop_start==hop_limit`, LoRa transport, `from≠gateway`, rx metrics present); relay hint via `relay.go`: in-window IDs with `id&0xFF == hint`, exactly one candidate, `hop_start−hop_limit ≥ 1`, proven RF receiver → low-confidence `relay→G`, else nothing (reason recorded).
- Per-evidence dedupe by logical key so multi-broker uploads count once per direction; for traceroutes, each directed segment is counted once per logical traceroute even when several partial-route copies contain it, while the copies themselves remain individual observations.
- `confidence.go`: `high|medium|low` from evidence set, independent samples, contradictions; SNR/RSSI stats `{median,min,max,last,n}` per direction.

### 3.11 Geolocation module

- Anchors: in-window reported positions with `precision_bits ≥ GEOLOCATION_MIN_PRECISION_BITS` (default 15, see D-025), not excluded, with single-hop samples to/from the target.
- Gates: ≥ 3 anchors, pairwise ≥ 200 m, convex-hull area and Jacobian condition number thresholds, ≥ 5 independent samples, robust residual consistency.
- Estimator: local ENU around anchor centroid; log-distance path loss `rssi = P0 − 10·n·log10(d)` with per-site `P0`,`n` from static YAML when present; Levenberg–Marquardt with Huber weights on `gonum/mat`. Uncalibrated fallback: weighted geometric centroid, `quality: very_low`, radius `max(2 km, mean anchor distance)`.
- Output `{lat, lon, uncertainty_radius_m (floor 500 m), method, quality, anchor_count, sample_count, evidence_time_range, reasons}`; recomputed per window/cursor; never persisted.

### 3.12 API module

- huma operations map 1:1 to §12 endpoints; every input struct embeds `WindowParams` resolved by a huma resolver calling `window.Parse`.
- Client IP (amendment 9): `TRUSTED_PROXIES` CIDR list (default: the compose network's private ranges). `X-Forwarded-For` is walked right-to-left, skipping trusted hops; the first untrusted address is the client. Requests from untrusted peers ignore the header. Caddy sets `X-Forwarded-For` and strips client-supplied values (`trusted_proxies` configured for upstream TLS terminators per `docs/operations.md`).
- Middleware: token-bucket rate limit per client IP (Redis, in-memory fallback), per-endpoint concurrency semaphores, `http.TimeoutHandler`-style deadlines (20 s), `http.MaxBytesReader`, response-size caps.
- `sse.go`: `/api/v1/stream?mode=live` requires a rolling window; subscribes to `meshmap:live`, filters by channel/broker, emits `delta`, `heartbeat {now,start,end}` every 15 s, `window`, `retention`, `status`. Fixed historical windows → 400.
- Every response carries `window {start,end,at}` and `revision`. DTOs include examples for positioned / estimated / referenced / absent nodes and all signature statuses.
- `/health/live`, `/health/ready` (DB, Redis-or-fallback, schema, ingest queue saturation), `/metrics` (gated by `PUBLIC_METRICS_ENABLED`).
- `meshmap api --dump-openapi` writes `docs/api-openapi.yaml`; CI diffs it.

### 3.13 Maintenance module

- `meshmap maintenance run`: run on start if `meshmap:maint:last` older than `MAINTENANCE_INTERVAL_HOURS`; then `time.Ticker` aligned to 03:00 UTC.
- `pg_try_advisory_lock(hashtext('meshmap:maintenance'))`; skip if held.
- Cutoff `now() − make_interval(months => RETENTION_MONTHS)`; chunked `DELETE … WHERE id IN (SELECT id … WHERE observed_at < $1 ORDER BY observed_at, id LIMIT 5000)` in short transactions with pauses; `VACUUM (ANALYZE) packet_log` afterwards.
- Then `INCR meshmap:retention_rev`, prune identity entries whose row is gone, publish `retention`, store `{last_run, deleted_rows, table_bytes}` for `/health/ready` and `/api/v1/retention` (which reports `configured_cutoff` and `earliest_retained_observed_at` separately).

---

## 4. Frontend architecture

### 4.1 Libraries

| Concern | Choice |
| --- | --- |
| App | React 19, Vite, TypeScript strict, `pnpm` |
| Map | `maplibre-gl` 5 owned imperatively by `MapCanvas`; `pmtiles` protocol registered at startup |
| GPU layers | `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/mapbox` (`MapboxOverlay`, `interleaved: true`) |
| State | Zustand (`subscribeWithSelector`); URL sync of `start,end,at,preset,filters` |
| Server data | TanStack Query v5, keys `[endpoint, start, end, at, filtersHash]`, `AbortSignal`, generation guard on `revision`/window |
| API types | `openapi-typescript` + `openapi-fetch` from `docs/api-openapi.yaml` |
| Live | `EventSource` wrapper with reconnect + heartbeat watchdog |
| Workers | `comlink`: `replay-fold.worker.ts` (checkpoint + deltas → typed arrays), `cluster.worker.ts` (`supercluster`) |
| Charts | `uPlot` |
| Time | Luxon; UTC internally, local display with visible zone badge, DST-safe |
| UI | Radix UI primitives, `lucide-react`, `@tanstack/react-virtual` |
| Styling | CSS Modules + dark-only custom properties; `color-scheme: dark` and inline background in `index.html` (no light flash) |
| Tests | Vitest + Testing Library; Playwright |

### 4.2 Rendering layers

- `NodeLayer` (`ScatterplotLayer`, kind-coded: reported / estimated / stale), `UncertaintyLayer` (meter-radius translucent circles with dashed outline), `EdgeLayer` (`LineLayer`/`PathLayer` with dash extension; width/opacity by sample count, colorblind-safe confidence ramp, optional arrowheads), `PulseLayer` (`TripsLayer`-style, only segments that carried the event; disabled under reduced motion or hidden tab), `ClusterLayer` at low zoom.
- Deck layers interleaved **below** `place`/`mountain_peak` symbol layers (`beforeId`) so labels stay visible.

### 4.3 Time controls

- `TimelineRange`: dual-handle, pan handle preserving duration, keyboard + ARIA slider semantics, clamped to `[retention cutoff, now]`.
- Presets 1h…7d; custom 1 h–7 d; “Return to live” → rolling mode re-evaluated on heartbeat.
- Replay: Play/Pause/Restart/Speed 1/4/16/64/Scrub. Worker folds from nearest checkpoint ≤ `at`; `snapshot?at=` refetched (debounced) for authoritative state.
- Retention events / heartbeats clamp expired windows with a banner.

### 4.4 Panels

Node panel per §10.2 with “not reported in selected period” placeholders and provenance badges; edge panel with per-direction stats and confidence reason; virtualized unpositioned list with SVG inset graph; legend; filters; toggles (inferred links, uncertainty, animation, overlay).

---

## 5. Basemap plan (`docs/basemap.md`)

- OpenMapTiles schema. Labels from `place`, `mountain_peak`, `transportation_name`, `boundary` (admin levels 2/4). Optional `raster-dem` hillshade slot, off by default.
- `web/styles/dark.json` authored from the BSD-licensed Dark Matter / OpenFreeMap dark styles, retuned (charcoal, peak labels with triangle icon from z9, road hierarchy, dashed national borders). Source URL templated via Caddy `templates` from `MAP_TILE_SOURCE`.
- Online default: `https://tiles.openfreemap.org/planet` (no key). Fonts and sprites always served from `web/assets`. Attribution: OpenStreetMap contributors, OpenMapTiles, OpenFreeMap.
- Self-hosted: `scripts/basemap_import.sh` runs `ghcr.io/onthegomap/planetiler --area=${AREA:-norway} --download --output=/data/basemap.pmtiles` into the `basemap` volume; Caddy serves it with range requests; `MAP_TILE_SOURCE=pmtiles:///tiles/basemap.pmtiles`.
- e2e exposes `window.__meshmap.queryLabels()` over `queryRenderedFeatures` so Playwright asserts peaks/places/roads/borders at test viewports in addition to screenshots.

---

## 6. Compose and configuration

1. `postgres` — `postgres:16-alpine`, volume `pgdata`, `pg_isready`, tuned flags.
2. `redis` — `redis:7-alpine --save "" --appendonly no --maxmemory ${REDIS_MAXMEMORY} --maxmemory-policy allkeys-lru`.
3. `backend` — `meshmap serve`; entrypoint runs `init-schema` then `check-config`; healthcheck `/health/ready`; secrets read-only under `/run/secrets/`.
4. `maintenance` — same image, `meshmap maintenance run`.
5. `web` — Caddy with built frontend; `${WEB_PORT}:80`; proxies `/api/*`, `/health/*`; optional `basic_auth`; TLS-fronting examples in `docs/operations.md`.
6. `profiles: [demo]` — `mosquitto` (anonymous, compose network only) + `demo-publisher` (`meshmap demo-publish --scenario default --rate 5`), refusing non-internal hosts without an explicit override.

Config files (examples with fake values):

```yaml
# mqtt-brokers.yaml
brokers:
  - id: public-eu
    host: mqtt.example.org
    port: 8883
    protocol: v5            # or v311
    tls: { enabled: true, ca_file: /run/secrets/ca.pem, insecure_skip_verify: false }
    username: user
    password: pass
    client_id: meshmap-ingest-1
    topics: [{ filter: "msh/EU_868/2/e/+/+", qos: 0 }]
    accept_retained: false
# channel-keys.yaml
channels:
  - { name: LongFast, broker_ids: ["*"], mode: ctr, psks: ["AQ=="] }
  - { name: Private,  broker_ids: ["public-eu"], mode: ccm, psks: ["<base64-32B-current>", "<base64-32B-previous>"] }
```

Env (`.env.example`) as §14 plus `MQTT_ACCEPT_RETAINED`, `SIGNATURE_POLICY`, `GEOLOCATION_MIN_PRECISION_BITS`, `API_CURSOR_SECRET`, `MAP_TILE_SOURCE`, `INGEST_QUEUE_SIZE`, `WRITER_BATCH_SIZE`, `KEY_ATTEMPT_BUDGET`, `LIVE_QUANTUM`, `TRUSTED_PROXIES`, `MIN_FIRMWARE=2.7` (documentation/diagnostics only), `LOG_LEVEL`.

---

## 7. Test strategy (maps to §17)

| Spec tests | Where | How |
| --- | --- | --- |
| 1–8 crypto | `internal/security/...` unit tests | Go-only vectors: CTR/CCM round-trips built with stdlib `crypto/aes` + Pion CCM in `internal/testutil` and checked against captured real envelopes decrypted with the default key; XEdDSA cross-check and round-trip as in §3.5; real public-channel captures (NodeInfo/Position only); byte-flip mutations of payload/tag/signature |
| 9–10 ingestion | `test/integration/ingest` | `testcontainers-go` Postgres + Redis + Mosquitto; publish fixtures; assert rows, dedupe, no crash under `rapid`-generated garbage |
| 11–20 temporal | `test/integration/window` | Seeded `observed_at`; property test: all returned timestamps ∈ `[start,end)`; cache generation; Redis wipe reconstruction |
| 21–28 graph/geo | `internal/graph`, `internal/geo` | Scenario DSL → rows; relay-collision and anchor-geometry negatives; localization error stats → `docs/benchmarks.md` |
| 29–31 UI | `frontend/e2e` | Playwright on demo profile: presets, DST (`timezoneId: Europe/Oslo`), scrub, `queryLabels`, request interception proving no `envelope_bytes`/ciphertext |
| 32 performance | `test/performance`, `scripts/bench.sh` | `meshmap seed` 2M rows / 2 000 nodes / 20 000 edges; `meshmap bench api` (vegeta library) p50/p95 cold/warm; `meshmap bench mqtt --rate 100`; browser heap via Playwright CDP; results in `docs/benchmarks.md` with hardware |
| 33–35 ops | `test/integration/ops` | Maintenance idempotency, single-table assertion via `information_schema`, Redis flush, TLS/bad-cred reconnect, DB outage + bounded queue + recovery |

Contract: committed `docs/api-openapi.yaml` must equal `meshmap api --dump-openapi` output. `golangci-lint` + `go vet` + `govulncheck` in CI.

---

## 8. Milestone task lists

### M0 — Protocol and contract spike (gate: fixtures accept/reject correctly; XEdDSA gate passes)
1. Module scaffold, cobra root, submodule at `v2.8.2`, `buf generate`, descriptor golden test, Dockerfile skeleton (`CGO_ENABLED=0`, distroless).
2. `security/`: PSK, CTR, CCM, XEdDSA conversion + verify, identity rules; `internal/testutil` key derivation and fixture builders; cross-check, round-trip and mutation tests; obtain real 2.8 signed captures; traceroute exemption test. Decide and record XEdDSA approach (pure Go vs cgo fallback) in `docs/decisions.md`.
3. `protocol/`: envelope, port handlers, limits, `rapid` fuzz tests.
4. `docs/protocol-compatibility.md`: firmware commit verified against, CCM nonce/AAD findings, traceroute SNR semantics, `TransportMechanism` values.
5. `schema.sql`, `window.Window`, API DTOs with examples, TS types.

### M1 — Runnable data pipeline (gate: compose up + demo populates only `packet_log`)
1. Config loading + `check-config` with redaction.
2. MQTT clients (v5 + v311), bounded channel, backoff, metrics.
3. Pipeline stages, dedupe, `CopyFrom` writer, identity cache, live publish.
4. `init-schema`, health endpoints, slog.
5. Maintenance loop with advisory lock and chunked delete.
6. Demo profile: Mosquitto + deterministic simulator (positions, nodeinfo, telemetry, neighborinfo, traceroutes, signed packets, duplicate gateways, one CCM channel).
7. Integration tests 1–10, 33, 35 (partial).

### M2 — Time-window backend (gate: no cross-window leakage; cold start from DB)
1. `repo.go` queries, keyset pagination; `snapshot`, `traffic`, `nodes/{id}`, `retention`, `capabilities`.
2. Cache keys/TTL/singleflight/fallback; `revision`; HMAC cursors; `replay` + checkpoints.
3. SSE stream with heartbeat/window/retention/status events.
4. Rate limits, timeouts, size caps; OpenAPI dump + contract test.
5. Tests 11–20, Redis-wipe reconstruction.

### M3 — Topology, provenance, inference (gate: positive/negative fixtures pass)
1. Evidence reducer, confidence, per-direction stats.
2. `edges` endpoint with bbox, filters, truncation flag.
3. Geolocation estimator, calibration YAML, floors, exclusions.
4. Tests 21–28; synthetic localization benchmark.

### M4 — Interactive map and timeline (gate: Playwright verifies behaviour + labels)
1. Vite shell, dark tokens, no-flash HTML, stores, URL sync.
2. MapLibre + style loader (online/PMTiles), deck.gl overlay, layers, cluster worker, label ordering.
3. Timeline, replay controls, worker fold, SSE wiring with generation guards.
4. Panels, filters, legend, unpositioned list/inset, search, a11y.
5. Caddy image, style templating, fonts/sprites, `basemap_import.sh`, `docs/basemap.md`.
6. Vitest units; Playwright suites 29–31 with screenshot baselines.

### M5 — Hardening and delivery (gate: acceptance matrix complete)
1. `meshmap seed`/`bench`; EXPLAIN-driven SQL tuning; BRIN decision; `pprof` on reducer and estimator; WASM only with evidence (unlikely needed with a Go backend).
2. Overload/reconnect/resume, TLS/bad-credential, DB-outage tests.
3. Security review: secrets never in API/logs/bundle, Caddy headers, rate limits, cursor tampering, `govulncheck`.
4. Docs: README (quick start, brokers/keys, tiles, tests, backup/restore via `pg_dump`, troubleshooting, production checklist), `architecture.md` with network diagram, final `decisions.md`.
5. Multi-arch build in CI; fresh-checkout `docker compose up -d --build` smoke test.

---

## 9. Amendments after plan review (2026-10-31)

Protocol facts in §3.5 were re-checked against firmware `develop@332b5b0` (2026-10-28) and protobufs `v2.8.2`: signing buffer layout, first-contact CRC-32 rule, CCM (L=2 → 13-byte nonce prefix, 12-byte tag, LE `from‖to` AAD), `0xAE` AEAD channel-hash XOR, CTR nonce and the traceroute signature exemption all match. The XEdDSA approach (birational map + standard Ed25519 verify) is exactly the firmware's `curve_to_ed_pub` + `ed25519Verify`; this answers the spec's "no generic Ed25519 substitution" wording and is recorded in `docs/decisions.md`.

Folded into the sections above:
1. Traceroute unknown-hop placeholders and `INT8_MIN` SNR → no edge / null SNR (§3.4).
2. Traceroute logical key excludes payload; every distinct reception and partial route is kept as evidence (§3.6).
3. Node public keys stored in `decoded_metadata`; known-signer NodeInfo key-consistency rule (§3.5).
4. Plaintext (`decoded`) uplink path with identical validation and verification (§3.2).
5. Minimum supported firmware **2.7**; `precision_bits == 0` → precision unknown, never an anchor (§3.4).
6. Backend Redis cache; live windows quantized to `LIVE_QUANTUM` (§3.7).
7. Dedupe mark after commit (§3.6).
8. ~~Shared cursor secret via env or Redis (§3.8).~~ Superseded by 12.
9. Trusted-proxy client IP resolution (§3.12).
10. Queue-full loss window counted, exposed as coverage hint, documented (§3.2).
11. Topic roots of arbitrary depth (observed on mqtt.868.no) (§3.3).
12. **In-window playback removed** by the operator (D-020): no `at` cursor, no `/api/v1/replay`, no cursor secret, no play/pause/scrub. Sliding the window back stays. Plan text below that mentions replay, cursors, `replay.go`, `cursor.go`, the scrubber or the replay worker is superseded.

Test broker for captures and integration smoke tests: `mqtt.868.no:1883` (read-only subscription, credentials supplied by the operator, kept out of Git).

## 10. Risks and open points to resolve during M0

1. **XEdDSA in Go.** No vetted pure-Go XEdDSA library exists; the plan uses a vetted field implementation for the public-key map plus stdlib Ed25519, gated by the Go-only cross-check in §3.5 and real 2.8 captures. The cross-check proves the conversion against stdlib Ed25519 and x/crypto X25519; the captures prove the message layout against the firmware. If either gate fails and cannot be fixed, fall back to a cgo libxeddsa binding (costs `CGO_ENABLED=1` and a libsodium layer in the image). Tracked as a release blocker per §13.
2. **CCM parameters.** 13-byte nonce (L=2), 12-byte tag, AAD `LE32(from)||LE32(to)` must be confirmed on real 2.8.1+ AEAD traffic; otherwise ship CCM as `experimental`, off by default.
3. **Traceroute SNR array semantics** and origin/destination representation in `route`: pin to generated proto comments and app behaviour.
4. **`TransportMechanism` values / `via_mqtt`** across firmware versions drive the direct-RF rule; absent fields → no edge.
5. **MQTT 3.1.1-only brokers** need the second client implementation; keep it behind the interface and test both against Mosquitto.
6. **OpenFreeMap terms** for public deployments; self-hosted PMTiles is the documented fallback.
7. **Replay density** beyond client budget → server coalesces per node per bucket and the UI labels reduced resolution.
8. **Identity after retention.** Verified keys older than retention vanish; document TOFU limitation and expose `identity_since`.
