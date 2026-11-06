// Package ingest turns raw MQTT messages into accepted packet observations.
// Process is pure apart from identity lookups; persistence, deduplication
// and identity promotion happen in the writer after commit.
package ingest

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/protocol/ports"
	"github.com/868-no/map/internal/security"
)

// DecodeVersion is bumped whenever decoded_metadata semantics change; rows of
// an older version are decoded again from their envelopes (D-107). 4:
// channel_name and topic_root cleaned of control and format characters. 3: node
// status, store-and-forward, header-only rows instead of rejections.
// 2: map reports stored (mapreport), not_ok_to_mqtt marking (D-032).
const DecodeVersion = 4

// RawMessage is one MQTT delivery. ObservedAt is captured in the MQTT
// callback before queuing and is the authoritative event time (design §3.4).
type RawMessage struct {
	BrokerID   string
	Topic      string
	Payload    []byte
	Retained   bool
	ObservedAt time.Time
}

// Reject is a categorised rejection; Category is a metric label value.
type Reject struct{ Category string }

func (r *Reject) Error() string { return r.Category }

func reject(c string) error { return &Reject{Category: c} }

// Category extracts the rejection category from an error.
func Category(err error) string {
	var r *Reject
	if errors.As(err, &r) {
		return r.Category
	}
	return "internal"
}

// CryptoStatus records how the payload was obtained.
type CryptoStatus string

const (
	CryptoCTR        CryptoStatus = "ctr_unauthenticated" // decrypted, no integrity guarantee
	CryptoCCM        CryptoStatus = "ccm_authenticated"   // AEAD tag verified (channel membership, not sender)
	CryptoPlaintext  CryptoStatus = "plaintext_uplink"    // gateway uplinked decoded packet
	CryptoNone       CryptoStatus = "unencrypted_channel" // PSK shorthand 0x00
	CryptoMapReport  CryptoStatus = "mqtt_map_report"     // a node's own report to MQTT; never on RF
	CryptoPKI        CryptoStatus = "pki_unreadable"      // end-to-end encrypted direct message: header only (D-091)
	CryptoUnreadable CryptoStatus = "channel_unreadable"  // a channel we hold no working key for: header only (D-093)
)

// RxInfo is reception provenance used by the graph reducer (design §6.2).
type RxInfo struct {
	DirectRF bool   `json:"direct_rf"`
	Reason   string `json:"reason"`
}

// Metadata is packet_log.decoded_metadata.
type Metadata struct {
	ports.Decoded
	Crypto    CryptoStatus `json:"crypto"`
	ViaMQTT   bool         `json:"via_mqtt,omitempty"`
	WantAck   bool         `json:"want_ack,omitempty"`
	TopicRoot string       `json:"topic_root,omitempty"`
	Rx        RxInfo       `json:"rx"`
	NextHop   uint32       `json:"next_hop,omitempty"`
	// NotOKToMQTT: the sender did not allow MQTT uplink (Data.bitfield bit 0
	// clear) and a gateway other than the sender uplinked it anyway (e.g. a
	// private broker bridged to ours). Such packets are kept, but NodeInfo
	// is rejected so the node is never named (D-032).
	NotOKToMQTT bool `json:"not_ok_to_mqtt,omitempty"`
	Bytes       int  `json:"bytes"`
	// Invalid is why a header-only row's content was not kept: it failed
	// decoding or verification (sig_invalid, payload_invalid, ...). Its
	// sender may be forged, so it is never evidence (D-093).
	Invalid string `json:"invalid,omitempty"`
	// AlsoVia lists other brokers that delivered this same gateway upload
	// (bridged brokers, multi-broker gateways) before it was committed.
	// Debug aid only; never counted as additional receptions.
	AlsoVia []string `json:"also_via,omitempty"`
	// Imported: stored by import-envelopes from another collector's
	// recording (D-137), not received live. The import's default bound is
	// the broker's first live row, so a re-run resumes where it stopped (D-150).
	Imported bool `json:"imported,omitempty"`
}

// Observation is one accepted row for packet_log.
type Observation struct {
	ObservedAt      time.Time
	BrokerID        string
	Topic           string
	Gateway         *uint32
	Source          uint32
	Destination     *uint32
	PacketID        uint32
	Channel         string
	Portnum         int32
	PacketType      string
	LogicalKey      [16]byte
	ObservationKey  [16]byte
	RxTime          *time.Time
	RxSNR           *float32
	RxRSSI          *int32
	HopStart        *int16
	HopLimit        *int16
	RelayHint       *int32
	Transport       string
	SignatureStatus security.SignatureStatus
	EnvelopeBytes   []byte
	Meta            Metadata

	// Promote carries a new authoritative identity to record after commit.
	Promote *security.Identity

	meta, tail []byte // Encoded's result, until Meta changes
}

// Options configures Process.
type Options struct {
	Keyring        *security.Keyring
	Identities     security.IdentityLookup
	Policy         security.Policy
	KeyBudget      int
	AcceptRetained func(broker string) bool
}

// Longest channel name and topic root stored (runes): Meshtastic channel
// names are at most 11 bytes; roots are a few segments.
const (
	MaxShownChannel = 64
	MaxShownRoot    = 160
)

// Process validates, decrypts, verifies and normalises one message.
func Process(m RawMessage, o Options) (Observation, error) {
	if m.Retained && (o.AcceptRetained == nil || !o.AcceptRetained(m.BrokerID)) {
		return Observation{}, reject("retained_ignored")
	}
	topic := protocol.ParseTopic(m.Topic)
	switch topic.Kind {
	case protocol.TopicEncrypted, protocol.TopicLegacyC, protocol.TopicMap:
	case protocol.TopicUnknown:
		return Observation{}, reject("topic_unrecognised")
	default:
		return Observation{}, reject("topic_" + topic.Kind.String())
	}
	env, err := protocol.ParseEnvelope(m.Payload)
	if err != nil {
		switch {
		case errors.Is(err, protocol.ErrOversize):
			return Observation{}, reject("oversize")
		case errors.Is(err, protocol.ErrMalformed):
			return Observation{}, reject("malformed_proto")
		}
		return Observation{}, reject("invalid_envelope")
	}
	p := env.Packet
	// The topic names the channel: keys are chosen by it, so the stored name,
	// the plaintext rule and the logical key use it too. The envelope's
	// channel_id is ignored; a replay could set it to another channel's name.
	// Map topics name none.
	channelName := topic.Channel
	// What is stored and shown is cleaned like node names: no control or
	// format characters (bidi overrides), bounded length. Decoding and the
	// packet's keys use the topic as published.
	shownChannel, shownRoot := ports.CleanString(channelName, MaxShownChannel), ports.CleanString(topic.Root, MaxShownRoot)

	var (
		data   *pb.Data
		crypto CryptoStatus
		dec    ports.Decoded
		vetted bool // dec already decoded (by decrypt, to vet the key)
	)
	mapReport := topic.Kind == protocol.TopicMap
	if mapReport {
		// Map reports are plaintext by design and published by the node itself.
		if env.Kind != protocol.PayloadDecoded || p.GetDecoded().GetPortnum() != pb.PortNum_MAP_REPORT_APP || env.Gateway == 0 || env.Gateway != p.GetFrom() {
			return Observation{}, reject("map_report_invalid")
		}
		data, crypto = p.GetDecoded(), CryptoMapReport
	} else if env.Kind == protocol.PayloadDecoded {
		if p.GetPkiEncrypted() {
			return headerOnly(m, topic, env, channelName, ports.TypeDirectMessage, CryptoPKI, ""), nil
		}
		if !o.Keyring.AcceptsPlaintext(m.BrokerID, channelName) {
			return headerOnly(m, topic, env, channelName, ports.TypeInvalid, CryptoPlaintext, "plaintext_unconfigured"), nil
		}
		data, crypto = p.GetDecoded(), CryptoPlaintext
	} else {
		// PKI DMs travel with channel hash 0 and cannot be read with a PSK.
		// Firmware uses PKI for unicast only: a broadcast with hash 0 is on a
		// channel whose hash happens to be 0, so it gets the channel keys.
		if p.GetPkiEncrypted() || (p.GetChannel() == 0 && p.GetTo() != protocol.Broadcast) {
			return headerOnly(m, topic, env, channelName, ports.TypeDirectMessage, CryptoPKI, ""), nil
		}
		if p.GetChannel() > 0xFF {
			return Observation{}, reject("invalid_envelope")
		}
		data, crypto, dec, vetted, err = decrypt(m.BrokerID, channelName, p, o)
		if err != nil {
			// A channel we hold no working key for: who sent what to whom
			// is in the clear on RF, its content is not (D-093).
			return headerOnly(m, topic, env, channelName, ports.TypeEncrypted, CryptoUnreadable, ""), nil
		}
	}
	if data.GetPortnum() == pb.PortNum_UNKNOWN_APP {
		return headerOnly(m, topic, env, channelName, ports.TypeInvalid, crypto, "decode_failed"), nil
	}
	if !vetted {
		if dec, err = ports.Decode(data, p.GetFrom()); err != nil {
			return headerOnly(m, topic, env, channelName, ports.TypeInvalid, crypto, "payload_invalid"), nil
		}
	}
	if !mapReport && dec.Type == ports.TypeMapReport {
		return Observation{}, reject("map_report_invalid") // only the map topic carries them
	}

	// OK to MQTT: absent on firmware before 2.5 (no preference expressed).
	// A gateway uplinking its own packets chose to; anything else without the
	// flag reached us despite the sender's choice. Keep the traffic, never
	// the identity.
	notOK := data.Bitfield != nil && data.GetBitfield()&1 == 0 && env.Gateway != p.GetFrom()
	stored := m.Payload
	if notOK && dec.NodeInfo != nil {
		// Kept without its names (D-032, D-093): hardware, role and key
		// remain. The stored envelope loses its payload, which holds them.
		dec.NodeInfo.LongName, dec.NodeInfo.ShortName = "", ""
		stored = zeroPayload(env, len(data.GetPayload()), false)
	}
	if notOK && dec.NodeStatus != nil {
		// Its status text is as personal as a name (D-103).
		dec.NodeStatus.Status = ""
		stored = zeroPayload(env, len(data.GetPayload()), false)
	}

	var announced []byte
	if dec.NodeInfo != nil {
		announced = dec.NodeInfo.PublicKeyBytes()
	}
	verdict := security.Verdict{Status: security.SigNotApplicable}
	if !mapReport {
		// Map reports carry no signature and are published unauthenticated,
		// like the gateway id itself.
		if verdict, err = security.Evaluate(security.HeaderOf(p), data, announced, o.Identities, o.Policy); err != nil {
			// Failed verification: its content cannot be trusted, and its
			// sender may be forged. Header only, never used as evidence.
			return headerOnly(m, topic, env, channelName, ports.TypeInvalid, crypto, err.Error()), nil
		}
	}
	if dec.NodeInfo != nil {
		dec.NodeInfo.IdentityUntrusted = verdict.IdentityUntrusted
		dec.NodeInfo.KeyConflict = verdict.KeyConflict
	}

	obs := Observation{
		ObservedAt:      m.ObservedAt.UTC(),
		BrokerID:        m.BrokerID,
		Topic:           m.Topic,
		Source:          p.GetFrom(),
		PacketID:        p.GetId(),
		Channel:         shownChannel,
		Portnum:         int32(data.GetPortnum()),
		PacketType:      dec.Type,
		Transport:       transportName(p.GetTransportMechanism()),
		SignatureStatus: verdict.Status,
		EnvelopeBytes:   stored,
		Promote:         verdict.Promote,
		Meta: Metadata{
			Decoded: dec, Crypto: crypto, ViaMQTT: p.GetViaMqtt(), WantAck: p.GetWantAck(),
			TopicRoot: shownRoot, NextHop: p.GetNextHop(), Bytes: len(data.GetPayload()), NotOKToMQTT: notOK,
		},
	}
	setHeader(&obs, p, env.Gateway)
	obs.LogicalKey = logicalKey(p, channelName, data)
	if mapReport {
		// Every report has packet id 0: tell periodic reports apart by
		// time, while copies delivered by several brokers still collide.
		obs.LogicalKey = h16(obs.LogicalKey[:], u32(uint32(obs.ObservedAt.Truncate(5*time.Minute).Unix())))
	}
	obs.ObservationKey = observationKey(obs, env.Gateway, data)
	return obs, nil
}

// setHeader copies the cleartext MeshPacket header and the gateway's
// reception metrics into obs, with reception provenance.
func setHeader(obs *Observation, p *pb.MeshPacket, gw uint32) {
	if gw != 0 {
		g := gw
		obs.Gateway = &g
	}
	if to := p.GetTo(); to != 0 {
		obs.Destination = &to
	}
	if p.RxTime != nil && p.GetRxTime() != 0 {
		t := time.Unix(int64(p.GetRxTime()), 0).UTC()
		obs.RxTime = &t
	}
	if s := p.GetRxSnr(); s != 0 && !math.IsNaN(float64(s)) && s > -40 && s < 40 {
		obs.RxSNR = &s
	}
	if p.RxRssi != nil && p.GetRxRssi() < 0 && p.GetRxRssi() > -200 {
		r := p.GetRxRssi()
		obs.RxRSSI = &r
	}
	if p.GetHopStart() > 0 && p.GetHopStart() <= 7 && p.GetHopLimit() <= p.GetHopStart() {
		hs, hl := int16(p.GetHopStart()), int16(p.GetHopLimit())
		obs.HopStart, obs.HopLimit = &hs, &hl
	}
	if r := p.GetRelayNode() & 0xFF; r != 0 {
		ri := int32(r)
		obs.RelayHint = &ri
	}
	obs.Meta.Rx = directRF(p, gw, obs.RxSNR, obs.RxRSSI)
}

// headerOnly keeps only a packet's cleartext header (D-091, D-093): who
// sent it to whom, its id, hops, relay, size and the gateway's reception
// metrics, which travel in the clear on RF. Used for end-to-end encrypted
// direct messages, channels we cannot read, and packets that failed
// decoding or verification (ty invalid, with the reason). Its content is
// never stored: the stored envelope has the payload replaced by zeros of
// the same length, so re-decoding yields this row and nothing more.
func headerOnly(m RawMessage, topic protocol.Topic, env protocol.Envelope, channelName, ty string, crypto CryptoStatus, invalid string) Observation {
	p := env.Packet
	size := len(p.GetEncrypted())
	if d := p.GetDecoded(); d != nil {
		size = len(d.GetPayload())
	}
	obs := Observation{
		ObservedAt:      m.ObservedAt.UTC(),
		BrokerID:        m.BrokerID,
		Topic:           m.Topic,
		Source:          p.GetFrom(),
		PacketID:        p.GetId(),
		Channel:         ports.CleanString(channelName, MaxShownChannel),
		PacketType:      ty,
		Transport:       transportName(p.GetTransportMechanism()),
		SignatureStatus: security.SigNotApplicable,
		EnvelopeBytes:   zeroPayload(env, size, ty == ports.TypeDirectMessage),
		Meta: Metadata{
			Decoded: ports.Decoded{Type: ty}, Crypto: crypto, ViaMQTT: p.GetViaMqtt(), WantAck: p.GetWantAck(),
			TopicRoot: ports.CleanString(topic.Root, MaxShownRoot), NextHop: p.GetNextHop(), Bytes: size, Invalid: invalid,
		},
	}
	setHeader(&obs, p, env.Gateway)
	empty := &pb.Data{}
	obs.LogicalKey = logicalKey(p, channelName, empty)
	obs.ObservationKey = observationKey(obs, env.Gateway, empty)
	return obs
}

// zeroPayload re-encodes the envelope with its payload replaced by size
// zero bytes (at least one, so it still parses); pki keeps it a PKI packet.
func zeroPayload(env protocol.Envelope, size int, pki bool) []byte {
	stripped := proto.Clone(env.Raw).(*pb.ServiceEnvelope)
	sp := stripped.GetPacket()
	sp.PayloadVariant = &pb.MeshPacket_Encrypted{Encrypted: make([]byte, max(size, 1))}
	if pki {
		sp.PkiEncrypted = true
	}
	raw, _ := deterministic.Marshal(stripped)
	return raw
}

// Without an authentication tag, the port decoding that vetted the key is
// returned too (vetted), so the caller need not decode the payload again.
func decrypt(broker, topicChannel string, p *pb.MeshPacket, o Options) (*pb.Data, CryptoStatus, ports.Decoded, bool, error) {
	cands := o.Keyring.Candidates(broker, topicChannel, uint8(p.GetChannel()), o.KeyBudget)
	if len(cands) == 0 {
		return nil, "", ports.Decoded{}, false, reject("no_key")
	}
	ct := p.GetEncrypted()
	authFailed := false
	for _, k := range cands {
		var (
			pt     []byte
			err    error
			status CryptoStatus
		)
		switch {
		case k.Unencrypted():
			pt, status = ct, CryptoNone
		case k.Mode == security.ModeCCM:
			pt, err = security.DecryptCCM(k.Bytes(), p.GetFrom(), p.GetTo(), p.GetId(), ct)
			status = CryptoCCM
			if err != nil {
				authFailed = true
				continue // no CTR fallback for AEAD channels
			}
		default:
			pt, err = security.DecryptCTR(k.Bytes(), p.GetFrom(), p.GetId(), ct)
			status = CryptoCTR
			if err != nil {
				continue
			}
		}
		d, err := protocol.ParseData(pt)
		if err != nil || d.GetPortnum() == pb.PortNum_UNKNOWN_APP {
			continue
		}
		// Without a tag, "success" means only that the plaintext is
		// structurally valid, so the port decoder must accept it before this
		// key is chosen. A CCM tag already proved the key; a bad payload
		// there is rejected by the caller as payload_invalid.
		if status != CryptoCCM {
			dec, err := ports.Decode(d, p.GetFrom())
			if err != nil {
				continue
			}
			return d, status, dec, true, nil
		}
		return d, status, ports.Decoded{}, false, nil
	}
	if authFailed {
		return nil, "", ports.Decoded{}, false, reject("ccm_auth_failed")
	}
	return nil, "", ports.Decoded{}, false, reject("decrypt_failed")
}

func transportName(t pb.MeshPacket_TransportMechanism) string {
	if t == pb.MeshPacket_TRANSPORT_INTERNAL {
		return ""
	}
	return t.String()
}

// directRF decides whether the gateway demonstrably received this packet
// over RF directly from its originator (design §2.2). Absent fields -> false.
func directRF(p *pb.MeshPacket, gw uint32, snr *float32, rssi *int32) RxInfo {
	switch {
	case gw == 0:
		return RxInfo{Reason: "no_gateway"}
	case gw == p.GetFrom():
		return RxInfo{Reason: "own_packet"}
	case p.GetViaMqtt():
		return RxInfo{Reason: "via_mqtt"}
	case p.GetTransportMechanism() == pb.MeshPacket_TRANSPORT_MQTT ||
		p.GetTransportMechanism() == pb.MeshPacket_TRANSPORT_MULTICAST_UDP ||
		p.GetTransportMechanism() == pb.MeshPacket_TRANSPORT_UNICAST_UDP ||
		p.GetTransportMechanism() == pb.MeshPacket_TRANSPORT_API:
		return RxInfo{Reason: "non_rf_transport"}
	case p.GetHopStart() == 0:
		return RxInfo{Reason: "no_hop_start"}
	case p.GetHopLimit() != p.GetHopStart():
		return RxInfo{Reason: "relayed"}
	case snr == nil && rssi == nil:
		return RxInfo{Reason: "no_rx_metrics"}
	}
	return RxInfo{DirectRF: true, Reason: "zero_hop_rf"}
}

func h16(parts ...[]byte) [16]byte {
	h := sha256.New()
	for _, b := range parts {
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(len(b)))
		h.Write(l[:])
		h.Write(b)
	}
	var out [16]byte
	copy(out[:], h.Sum(nil))
	return out
}

func u32(v uint32) []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, v); return b }

var deterministic = proto.MarshalOptions{Deterministic: true}

// logicalKey identifies the RF packet independent of which gateway heard
// it. Mutable headers are excluded. Traceroute payloads are rewritten by
// every hop, so they are excluded too: all partial-route copies of one
// traceroute share a logical key while staying separate observations.
func logicalKey(p *pb.MeshPacket, channel string, d *pb.Data) [16]byte {
	var payload []byte
	if d.GetPortnum() != pb.PortNum_TRACEROUTE_APP {
		c := proto.Clone(d).(*pb.Data)
		c.XeddsaSignature = nil
		payload, _ = deterministic.Marshal(c)
	}
	return h16([]byte("lp1"), u32(p.GetFrom()), u32(p.GetId()), u32(p.GetTo()), []byte(channel), u32(uint32(d.GetPortnum())), payload)
}

// observationKey identifies one gateway's reception. Different gateways,
// relays, hop counts, RF metrics or partial traceroute routes are distinct;
// only byte-identical re-deliveries (bridges, second brokers, QoS retries)
// collide.
func observationKey(o Observation, gw uint32, d *pb.Data) [16]byte {
	opt := func(present bool, b []byte) []byte {
		if !present {
			return nil
		}
		return b
	}
	var rxt, snr, rssi []byte
	if o.RxTime != nil {
		rxt = u32(uint32(o.RxTime.Unix()))
	}
	if o.RxSNR != nil {
		snr = u32(math.Float32bits(*o.RxSNR))
	}
	if o.RxRSSI != nil {
		rssi = u32(uint32(*o.RxRSSI))
	}
	var hops []byte
	if o.HopStart != nil {
		hops = []byte{byte(*o.HopStart), byte(*o.HopLimit)}
	}
	var relay []byte
	if o.RelayHint != nil {
		relay = []byte{byte(*o.RelayHint)}
	}
	ph := sha256.Sum256(d.GetPayload())
	return h16([]byte("ob1"), o.LogicalKey[:], u32(gw), opt(rxt != nil, rxt), opt(snr != nil, snr), opt(rssi != nil, rssi), hops, relay, ph[:])
}
