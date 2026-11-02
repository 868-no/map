package ingest

import (
	"crypto/ed25519"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/testutil"
)

type noIDs struct{}

func (noIDs) Lookup(uint32) (security.Identity, bool) { return security.Identity{}, false }

type mapIDs map[uint32]security.Identity

func (m mapIDs) Lookup(n uint32) (security.Identity, bool) { id, ok := m[n]; return id, ok }

func opts(t *testing.T, chs ...security.ChannelConfig) Options {
	t.Helper()
	kr, err := security.NewKeyring(chs)
	if err != nil {
		t.Fatal(err)
	}
	return Options{Keyring: kr, Identities: noIDs{}, KeyBudget: 4}
}

var longFast = security.ChannelConfig{Name: "LongFast", Mode: security.ModeCTR, PSKs: []string{"AQ=="}, AcceptPlaintext: true}

type pkt struct {
	from, id, to uint32
	gw           string
	data         *pb.Data
	hopStart     uint32
	hopLimit     uint32
	snr          float32
	rssi         int32
	relay        uint32
}

func envelope(t *testing.T, p pkt, key []byte, mode security.Mode, channel string) []byte {
	t.Helper()
	pt, err := proto.Marshal(p.data)
	if err != nil {
		t.Fatal(err)
	}
	var ct []byte
	if mode == security.ModeCCM {
		ct, err = security.EncryptCCM(key, p.from, p.to, p.id, pt)
	} else {
		ct, err = security.EncryptCTR(key, p.from, p.id, pt)
	}
	if err != nil {
		t.Fatal(err)
	}
	rssi := p.rssi
	mp := &pb.MeshPacket{
		From: p.from, To: p.to, Id: p.id, Channel: uint32(security.ChannelHash(channel, key, mode)),
		PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct},
		HopStart:       p.hopStart, HopLimit: p.hopLimit, RxSnr: p.snr, RxRssi: &rssi, RelayNode: p.relay,
		TransportMechanism: pb.MeshPacket_TRANSPORT_LORA,
	}
	b, err := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: channel, GatewayId: p.gw})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func posData(t *testing.T) *pb.Data {
	lat, lon := int32(634300000), int32(104000000)
	b, _ := proto.Marshal(&pb.Position{LatitudeI: &lat, LongitudeI: &lon, PrecisionBits: 32})
	return &pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: b}
}

func msg(topic string, payload []byte) RawMessage {
	return RawMessage{BrokerID: "a", Topic: topic, Payload: payload, ObservedAt: time.Unix(1_800_000_000, 0)}
}

const topicLF = "msh/EU_868/NO/Trøndelag/2/e/LongFast/!aabbccdd"

// design §10.2 test 1 (decode part) and design §2.2 direct-RF provenance.
func TestProcessCTRDirect(t *testing.T) {
	p := pkt{from: 0x11111111, id: 5, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 7.5, rssi: -90}
	obs, err := Process(msg(topicLF, envelope(t, p, security.DefaultPSK[:], security.ModeCTR, "LongFast")), opts(t, longFast))
	if err != nil {
		t.Fatal(err)
	}
	if obs.PacketType != "position" || obs.Meta.Crypto != CryptoCTR || obs.SignatureStatus != security.SigUnsigned {
		t.Fatalf("unexpected: %+v", obs)
	}
	if !obs.Meta.Rx.DirectRF || *obs.Gateway != 0xaabbccdd {
		t.Fatalf("direct RF not detected: %+v", obs.Meta.Rx)
	}
	if obs.Meta.TopicRoot != "msh/EU_868/NO/Trøndelag" {
		t.Fatalf("topic root %q", obs.Meta.TopicRoot)
	}
}

// design §10.2 test 25: relayed or MQTT-carried packets do not claim direct RF.
func TestProcessNotDirect(t *testing.T) {
	p := pkt{from: 0x11111111, id: 5, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 2, snr: 7.5, rssi: -90, relay: 0x42}
	obs, err := Process(msg(topicLF, envelope(t, p, security.DefaultPSK[:], security.ModeCTR, "LongFast")), opts(t, longFast))
	if err != nil {
		t.Fatal(err)
	}
	if obs.Meta.Rx.DirectRF || obs.Meta.Rx.Reason != "relayed" || *obs.RelayHint != 0x42 {
		t.Fatalf("got %+v relay=%v", obs.Meta.Rx, obs.RelayHint)
	}
}

// design §10.2 test 2: wrong key / malformed protobuf discarded.
func TestProcessWrongKeyAndMalformed(t *testing.T) {
	wrong := make([]byte, 16)
	wrong[0] = 9
	// Same channel hash as the default key, so the candidate is tried and must fail.
	p := pkt{from: 0x11111111, id: 5, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3}
	b := envelope(t, p, wrong, security.ModeCTR, "LongFast")
	var se pb.ServiceEnvelope
	_ = proto.Unmarshal(b, &se)
	se.Packet.Channel = uint32(security.ChannelHash("LongFast", security.DefaultPSK[:], security.ModeCTR))
	b, _ = proto.Marshal(&se)
	if _, err := Process(msg(topicLF, b), opts(t, longFast)); Category(err) != "decrypt_failed" {
		t.Fatalf("wrong key: %v", err)
	}
	if _, err := Process(msg(topicLF, []byte{0xff, 0xff, 0x01}), opts(t, longFast)); Category(err) != "malformed_proto" {
		t.Fatalf("malformed: %v", err)
	}
}

// design §10.2 test 3: CCM authenticates; modified ciphertext/tag is discarded.
func TestProcessCCM(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	psk := "hex:" + func() string {
		const h = "0123456789abcdef"
		s := ""
		for _, b := range key {
			s += string(h[b>>4]) + string(h[b&15])
		}
		return s
	}()
	ch := security.ChannelConfig{Name: "Private", Mode: security.ModeCCM, PSKs: []string{psk}}
	p := pkt{from: 0x22222222, id: 77, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3}
	b := envelope(t, p, key, security.ModeCCM, "Private")
	topic := "msh/EU_868/2/e/Private/!aabbccdd"
	obs, err := Process(msg(topic, b), opts(t, ch))
	if err != nil || obs.Meta.Crypto != CryptoCCM {
		t.Fatalf("valid CCM: %v", err)
	}
	var se pb.ServiceEnvelope
	_ = proto.Unmarshal(b, &se)
	enc := se.Packet.GetEncrypted()
	enc[len(enc)-1] ^= 1
	b2, _ := proto.Marshal(&se)
	if _, err := Process(msg(topic, b2), opts(t, ch)); Category(err) != "ccm_auth_failed" {
		t.Fatalf("tampered tag: %v", err)
	}
}

// design §10.2 test 8: PKI DMs discarded without trying PSKs.
func TestProcessPKI(t *testing.T) {
	mp := &pb.MeshPacket{From: 0x11111111, To: 0x22222222, Id: 1, Channel: 0, PkiEncrypted: true,
		PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: make([]byte, 40)}}
	b, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: "PKI", GatewayId: "!aabbccdd"})
	if _, err := Process(msg("msh/EU_868/2/e/PKI/!aabbccdd", b), opts(t, longFast)); Category(err) != "pki_only" {
		t.Fatalf("got %v", err)
	}
}

func TestProcessPlaintextUplink(t *testing.T) {
	k := testutil.NewXKey(3)
	d := posData(t)
	d.XeddsaSignature = make([]byte, 64)
	mp := &pb.MeshPacket{From: k.NodeNum(), To: 0xffffffff, Id: 9, PayloadVariant: &pb.MeshPacket_Decoded{Decoded: d}, XeddsaSigned: true}
	b, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: "LongFast", GatewayId: "!aabbccdd"})
	id, _ := security.NewIdentity(k.NodeNum(), k.X25519Pub)
	o := opts(t, longFast)
	o.Identities = mapIDs{k.NodeNum(): id}
	// Inbound xeddsa_signed=true with a garbage signature must be rejected, not trusted.
	if _, err := Process(msg(topicLF, b), o); Category(err) != "sig_invalid" {
		t.Fatalf("forged flag: %v", err)
	}
	d.XeddsaSignature = ed25519.Sign(k.EdPriv, security.SigningBuffer(k.NodeNum(), 9, 0xffffffff, d))
	b, _ = proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: "LongFast", GatewayId: "!aabbccdd"})
	obs, err := Process(msg(topicLF, b), o)
	if err != nil || obs.Meta.Crypto != CryptoPlaintext || obs.SignatureStatus != security.SigVerified {
		t.Fatalf("plaintext verified: %+v %v", obs.Meta.Crypto, err)
	}
	other := security.ChannelConfig{Name: "Other", PSKs: []string{"AQ=="}}
	if _, err := Process(msg(topicLF, b), opts(t, other)); Category(err) != "plaintext_unconfigured" {
		t.Fatalf("unconfigured plaintext: %v", err)
	}
}

func TestProcessRetainedIgnored(t *testing.T) {
	m := msg(topicLF, nil)
	m.Retained = true
	if _, err := Process(m, opts(t, longFast)); Category(err) != "retained_ignored" {
		t.Fatal(err)
	}
}

// design §10.2 test 9 (key part): two brokers delivering the same gateway upload
// share an observation key; two gateways share only the logical key.
func TestDedupeKeys(t *testing.T) {
	p := pkt{from: 0x11111111, id: 5, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
	b := envelope(t, p, security.DefaultPSK[:], security.ModeCTR, "LongFast")
	a1, _ := Process(msg(topicLF, b), opts(t, longFast))
	m2 := msg(topicLF, b)
	m2.BrokerID = "b"
	a2, _ := Process(m2, opts(t, longFast))
	if a1.ObservationKey != a2.ObservationKey {
		t.Fatal("same upload via two brokers must collide")
	}
	p.gw, p.snr, p.rssi = "!ccddeeff", -3, -110
	c, _ := Process(msg("msh/EU_868/NO/Trøndelag/2/e/LongFast/!ccddeeff", envelope(t, p, security.DefaultPSK[:], security.ModeCTR, "LongFast")), opts(t, longFast))
	if c.LogicalKey != a1.LogicalKey || c.ObservationKey == a1.ObservationKey {
		t.Fatal("second gateway must share logical key but not observation key")
	}
}

func TestTracerouteCopiesShareLogicalKey(t *testing.T) {
	r1, _ := proto.Marshal(&pb.RouteDiscovery{Route: []uint32{0x33333333}})
	r2, _ := proto.Marshal(&pb.RouteDiscovery{Route: []uint32{0x33333333, 0x44444444}})
	mk := func(r []byte) Observation {
		p := pkt{from: 0x11111111, id: 6, to: 0x55555555, gw: "!aabbccdd", data: &pb.Data{Portnum: pb.PortNum_TRACEROUTE_APP, Payload: r}, hopStart: 3, hopLimit: 2}
		o, err := Process(msg(topicLF, envelope(t, p, security.DefaultPSK[:], security.ModeCTR, "LongFast")), opts(t, longFast))
		if err != nil {
			t.Fatal(err)
		}
		return o
	}
	a, b := mk(r1), mk(r2)
	if a.LogicalKey != b.LogicalKey || a.ObservationKey == b.ObservationKey {
		t.Fatal("partial-route copies: same logical packet, distinct observations")
	}
	if a.SignatureStatus != security.SigNotApplicable {
		t.Fatal("traceroute must be not-applicable")
	}
}

func signedNodeInfoEnvelope(t *testing.T, idx uint64) []byte {
	t.Helper()
	k := testutil.NewXKey(idx)
	u, _ := proto.Marshal(&pb.User{LongName: "Node", ShortName: "N", PublicKey: k.X25519Pub})
	d := &pb.Data{Portnum: pb.PortNum_NODEINFO_APP, Payload: u}
	from, id, to := k.NodeNum(), uint32(1000+idx), uint32(0xffffffff)
	d.XeddsaSignature = ed25519.Sign(k.EdPriv, security.SigningBuffer(from, id, to, d))
	return envelope(t, pkt{from: from, id: id, to: to, gw: "!aabbccdd", data: d, hopStart: 3, hopLimit: 3, snr: 1, rssi: -100}, security.DefaultPSK[:], security.ModeCTR, "LongFast")
}

func withBitfield(d *pb.Data, bf uint32) *pb.Data {
	c := proto.Clone(d).(*pb.Data)
	c.Bitfield = &bf
	return c
}

func nodeInfoData(t *testing.T) *pb.Data {
	b, _ := proto.Marshal(&pb.User{Id: "!11111111", LongName: "Private Person", ShortName: "PP"})
	return &pb.Data{Portnum: pb.PortNum_NODEINFO_APP, Payload: b}
}

// D-032: packets without OK-to-MQTT uplinked by another gateway are kept
// and marked, except NodeInfo (the node stays unnamed). A gateway's own
// packets are never filtered: it chose to uplink them.
func TestOKToMQTT(t *testing.T) {
	o := opts(t, longFast)
	run := func(from uint32, gw string, d *pb.Data) (Observation, error) {
		p := pkt{from: from, id: 9, to: 0xffffffff, gw: gw, data: d, hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
		return Process(msg(topicLF, envelope(t, p, security.DefaultPSK[:], security.ModeCTR, "LongFast")), o)
	}
	if _, err := run(0x11111111, "!aabbccdd", withBitfield(nodeInfoData(t), 0)); Category(err) != "not_ok_to_mqtt_nodeinfo" {
		t.Fatalf("relayed not-OK NodeInfo: %v", err)
	}
	obs, err := run(0x11111111, "!aabbccdd", withBitfield(posData(t), 0))
	if err != nil || !obs.Meta.NotOKToMQTT {
		t.Fatalf("relayed not-OK position must be kept and marked: %v %+v", err, obs.Meta)
	}
	// Self-uplink: kept, named, unmarked.
	obs, err = run(0xaabbccdd, "!aabbccdd", withBitfield(nodeInfoData(t), 0))
	if err != nil || obs.Meta.NotOKToMQTT || obs.Meta.NodeInfo == nil {
		t.Fatalf("self-uplinked NodeInfo: %v %+v", err, obs.Meta)
	}
	// OK set, or no bitfield at all (pre-2.5 firmware): nothing special.
	for _, d := range []*pb.Data{withBitfield(nodeInfoData(t), 1), nodeInfoData(t)} {
		if obs, err := run(0x11111111, "!aabbccdd", d); err != nil || obs.Meta.NotOKToMQTT {
			t.Fatalf("OK NodeInfo: %v %+v", err, obs.Meta)
		}
	}
}

func mapReportEnvelope(t *testing.T, from uint32, gw string, lat, lon int32, prec uint32) []byte {
	t.Helper()
	b, _ := proto.Marshal(&pb.MapReport{LongName: "Hilltop", ShortName: "HT", Role: pb.Config_DeviceConfig_ROUTER, LatitudeI: lat, LongitudeI: lon,
		Altitude: 903, PositionPrecision: prec, FirmwareVersion: "2.8.1", HasOptedReportLocation: true})
	env := &pb.ServiceEnvelope{ChannelId: "NarrowFast", GatewayId: gw, Packet: &pb.MeshPacket{From: from, To: 0xffffffff,
		PayloadVariant: &pb.MeshPacket_Decoded{Decoded: &pb.Data{Portnum: pb.PortNum_MAP_REPORT_APP, Payload: b}}}}
	out, _ := proto.Marshal(env)
	return out
}

const topicMap = "msh/EU_868/NO/Østlandet/2/map/"

// Map reports are stored with their location as a position; periodic
// reports (all packet id 0) stay distinct packets.
func TestMapReport(t *testing.T) {
	o := opts(t, longFast)
	m := msg(topicMap, mapReportEnvelope(t, 0x3b8a98be, "!3b8a98be", 603324416, 94765056, 14))
	obs, err := Process(m, o)
	if err != nil {
		t.Fatal(err)
	}
	if obs.PacketType != "mapreport" || obs.Meta.Crypto != CryptoMapReport || obs.SignatureStatus != security.SigNotApplicable {
		t.Fatalf("unexpected: %s %s %s", obs.PacketType, obs.Meta.Crypto, obs.SignatureStatus)
	}
	pos := obs.Meta.Position
	if pos == nil || pos.PrecisionBits != 14 || !pos.PrecisionKnown || pos.Lat < 60.33 || pos.Lat > 60.34 || pos.Alt == nil || *pos.Alt != 903 {
		t.Fatalf("position %+v", pos)
	}
	if obs.Meta.MapReport == nil || obs.Meta.MapReport.Role != "ROUTER" || obs.Meta.MapReport.FirmwareVersion != "2.8.1" {
		t.Fatalf("report %+v", obs.Meta.MapReport)
	}
	later := m
	later.ObservedAt = m.ObservedAt.Add(time.Hour)
	obs2, _ := Process(later, o)
	if obs2.LogicalKey == obs.LogicalKey {
		t.Fatal("reports an hour apart must be distinct packets")
	}
	again, _ := Process(m, o)
	if again.LogicalKey != obs.LogicalKey || again.ObservationKey != obs.ObservationKey {
		t.Fatal("the same delivery must deduplicate")
	}
	// No location: stored without a position.
	if obs, err := Process(msg(topicMap, mapReportEnvelope(t, 0x3b8a98be, "!3b8a98be", 0, 0, 0)), o); err != nil || obs.Meta.Position != nil {
		t.Fatalf("no-location report: %v %+v", err, obs.Meta.Position)
	}
	// A report about another node than the publisher is not a self-report.
	if _, err := Process(msg(topicMap, mapReportEnvelope(t, 0x11111111, "!3b8a98be", 1, 1, 14)), o); Category(err) != "map_report_invalid" {
		t.Fatalf("mismatched publisher: %v", err)
	}
}

// D-065: a channel that is not configured is tried with the public default
// key under the topic's channel name, unless the fallback is off; a channel
// with a custom key still fails.
func TestProcessDefaultKeyFallback(t *testing.T) {
	p := pkt{from: 0xae609008, id: 77, to: 0xffffffff, gw: "!ae609008", data: posData(t), hopStart: 3, hopLimit: 3, snr: 4, rssi: -90}
	const topic = "msh/EU_868/NO/Trøndelag/2/e/Custom/!ae609008"
	b := envelope(t, p, security.DefaultPSK[:], security.ModeCTR, "Custom")
	o := opts(t, longFast)
	if _, err := Process(msg(topic, b), o); Category(err) != "no_key" {
		t.Fatalf("fallback off: %v, want no_key", err)
	}
	o.Keyring.DefaultFallback = true
	obs, err := Process(msg(topic, b), o)
	if err != nil {
		t.Fatalf("fallback on: %v", err)
	}
	if obs.Channel != "Custom" || obs.PacketType != "position" {
		t.Fatalf("decoded %q on %q", obs.PacketType, obs.Channel)
	}
	// AEAD channels with the default key too.
	bc := envelope(t, p, security.DefaultPSK[:], security.ModeCCM, "Custom")
	if obs, err := Process(msg(topic, bc), o); err != nil || obs.PacketType != "position" {
		t.Fatalf("ccm fallback: %v", err)
	}
	secret := make([]byte, 32)
	secret[0] = 9
	bs := envelope(t, p, secret, security.ModeCTR, "Custom")
	if _, err := Process(msg(topic, bs), o); err == nil {
		t.Fatal("a custom-key channel must not decode with the default key")
	}
}
