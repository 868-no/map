# Protocol compatibility

## Pinned upstream revisions

| Source | Revision | Use |
| --- | --- | --- |
| `meshtastic/protobufs` | tag `v2.8.2` (`ffd5ad428da6`) — git submodule `backend/protobufs` | Generated Go bindings in `backend/internal/protocol/pb` |
| `meshtastic/firmware` | `develop@332b5b0a2c4f` (2026-10-28) | Reference for crypto, signing and receive policy (read, not vendored) |

**Minimum supported firmware: 2.7.** Older nodes are decoded where possible, but behaviour that depends on newer fields (e.g. `precision_bits`, `hop_start`, `transport_mechanism`) degrades conservatively: absent fields never create evidence.

Regenerate bindings after bumping the submodule: `scripts/go.sh buf generate`, then run the full test suite and the capture replay (below).

## Verified facts (firmware source → implementation)

| Topic | Firmware | Implementation |
| --- | --- | --- |
| CTR nonce | `CryptoEngine::initNonce`: `LE64(packetId) ‖ LE32(from) ‖ 0x00000000` | `security.packetNonce` |
| CTR counter | rweather `CTR<AES*>` with `setCounterSize(4)` | Go `cipher.NewCTR` increments all 16 bytes; identical for ≤ 256-byte payloads (last 4 bytes start at 0, ≤ 16 blocks) |
| Default PSK | `defaultpsk = d4f1bb3a…4e6901`; 1-byte shorthand n → default key with last byte `+ (n-1)`, 0 → no crypto | `security.ExpandPSK` |
| Channel hash | `Channels::hashFor`: `xor(name) ^ xor(key)`, `^ 0xAE` if `use_aead` | `security.ChannelHash` (LongFast/default = 8, tested) |
| AEAD (CCM) | hostap-derived `aes_ccm_ae/ad`, fixed **L = 2** → first **13** nonce bytes; tag `AEAD_TAG_SIZE = 12`; AAD `LE32(from) ‖ LE32(to)`; output `ciphertext ‖ tag` | `security.DecryptCCM` via `pion/dtls/v3/pkg/crypto/ccm` (`NewCCM(block, 12, 13)`); library validated against RFC 3610 vector #1 |
| Signing buffer | `buildSigningBuffer`: `0x01 ‖ LE32 from, id, to, portnum, request_id, reply_id, emoji, (has_bitfield ? bitfield : 0) ‖ flags(bit0 want_response, bit1 has_bitfield) ‖ payload` | `security.SigningBuffer` |
| Key conversion | `curve_to_ed_pub`: RFC 7748 birational map, sign bit cleared | `security.ConvertX25519PublicKey` (`filippo.io/edwards25519/field`) |
| Verification | `ed25519Verify(signature, ed_pubkey, buf)` | stdlib `crypto/ed25519.Verify` |
| First contact | `verifyFirstContactNodeInfo`: `len(public_key)==32 && crc32(public_key)==from && verify` else **drop** | `security.Evaluate` |
| Known signer | verify against authoritative key, else drop; signed NodeInfo must claim the signing key and it must hash to `from` (`signedNodeInfoConsistent`) | `security.Evaluate` |
| Malformed signature | size ∉ {0, 64} → drop | `ErrSigMalformed` |
| Traceroute | signature ignored entirely (every hop rewrites `RouteDiscovery`) | status `not-applicable`, never `verified` |
| Inbound `xeddsa_signed` | cleared before evaluation, never trusted | ignored |
| Traceroute unknown hops | `TraceRouteModule::insertUnknownHops` writes `NODENUM_BROADCAST`; SNR `INT8_MIN` = unknown | `ports.Hop.Unknown`; SNR null; such segments yield no edge |
| Traceroute SNR | `int32` dB × 4 | divided by 4 |
| NeighborInfo SNR | `float` dB | stored unchanged |

## Ground truth from live traffic

The decoder, decryption and signature verification were replayed against a read-only capture of `mqtt.868.no` (Norwegian community broker, channel `NarrowFast`, default key) on 2026-10-31. See `backend/test/fixtures/README.md` for the capture procedure. Results are recorded in `docs/decisions.md` (D-003).

## Policy differences from firmware (deliberate)

- **Strict mode** (`SIGNATURE_POLICY=strict`) rejects signed packets whose key is unknown. Unlike firmware Strict it does **not** drop unsigned packets: the map's job is visibility, and unsigned traffic is labelled `unsigned`.
- Firmware exempts AES-CCM channels from Strict because the tag authenticates channel membership; we do the same implicitly (CCM does not change signature status) and record `ccm_authenticated` as crypto provenance — it authenticates the channel, not the sender.

## Topics

`{root}/2/{e|c}/{channel}/{gateway}` where `{root}` may have any depth (`msh/EU_868/NO/Østlandet`). `{root}/2/map/…` map reports are processed when the node published its own report (D-032). `json` and `stat` topics are recognised and counted but not processed. Retained messages are ignored by default.
