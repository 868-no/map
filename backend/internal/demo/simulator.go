package demo

import (
	"crypto/ed25519"
	"math/rand/v2"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/security"
)

// Demo channel configuration (fake keys; never used on a real mesh).
const (
	PublicChannel  = "LongFast"
	PrivateChannel = "DemoPrivate"
	TopicRoot      = "msh/EU_868/NO/Demo"
	// PrivatePSK is the demo AEAD channel key (base64 of bytes 0x00..0x1f).
	PrivatePSK = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
)

// Message is one MQTT publication produced by the simulator.
type Message struct {
	Topic   string
	Payload []byte
	Note    string // what this message exercises, for logs/tests
}

// Simulator advances the scenario and emits messages.
type Simulator struct {
	S       *Scenario
	r       *rand.Rand
	nextID  uint32
	tick    int
	privKey []byte
}

// NewSimulator is deterministic for a given seed.
func NewSimulator(s *Scenario, seed uint64) *Simulator {
	raw, _ := security.DecodePSK(PrivatePSK)
	return &Simulator{S: s, r: rand.New(rand.NewPCG(seed, 0x6d6170)), nextID: uint32(seed*7919) | 1, privKey: raw}
}

func (sim *Simulator) id() uint32 {
	sim.nextID = sim.nextID*1103515245 + 12345
	if sim.nextID == 0 {
		sim.nextID = 1
	}
	return sim.nextID
}

// Step produces the messages for one simulation tick. Each tick one node
// transmits one packet; every gateway that hears it (directly or via relays)
// uplinks its own reception.
func (sim *Simulator) Step() []Message {
	sim.tick++
	src := sim.tick % len(sim.S.Nodes)
	n := sim.S.Nodes[src]

	// Periodic adversarial / edge-case inputs (must all be rejected or
	// classified, never crash or be stored as genuine).
	switch sim.tick % 97 {
	case 13:
		return []Message{{Topic: sim.topic(PublicChannel, sim.S.Nodes[0]), Payload: []byte{0x0a, 0xff, 0xff, 0xff, 0x01}, Note: "malformed protobuf"}}
	case 41:
		return sim.forgedSignature()
	case 67:
		return sim.pkiDM()
	}

	var d *pb.Data
	to := protocol.Broadcast
	channel := PublicChannel
	switch k := sim.tick / len(sim.S.Nodes) % 6; {
	case k == 0 || sim.tick <= len(sim.S.Nodes):
		d = sim.nodeInfo(n)
	case k == 1:
		if !n.SharesPos {
			d = sim.telemetry()
		} else {
			d = sim.position(n)
		}
	case k == 2:
		d = sim.telemetry()
	case k == 3:
		d = sim.neighborInfo(src)
	case k == 4:
		return sim.traceroute(src)
	default:
		d = &pb.Data{Portnum: pb.PortNum_TEXT_MESSAGE_APP, Payload: []byte("hei fra demo")}
		if n.Private {
			channel = PrivateChannel
		}
	}
	return sim.flood(src, to, sim.id(), d, channel, 3, nil)
}

func (sim *Simulator) topic(channel string, gw *Node) string {
	return TopicRoot + "/2/e/" + channel + "/" + protocol.NodeID(gw.Num)
}

func (sim *Simulator) sign(n *Node, id, to uint32, d *pb.Data) {
	if n.Key == nil || d.GetPortnum() == pb.PortNum_TRACEROUTE_APP || len(d.XeddsaSignature) > 0 {
		return
	}
	d.XeddsaSignature = ed25519.Sign(n.Key.EdPriv, security.SigningBuffer(n.Num, id, to, d))
}

type hop struct {
	node, prev int
	depth      int
	link       Link
}

// reach returns every node that hears the packet: BFS over RF links, each
// node rebroadcasting once while hops remain.
func (sim *Simulator) reach(src, hopStart int) []hop {
	seen := map[int]bool{src: true}
	q := []hop{{node: src, prev: -1}}
	var out []hop
	for len(q) > 0 {
		h := q[0]
		q = q[1:]
		if h.depth > hopStart {
			continue
		}
		for _, l := range sim.S.Links[h.node] {
			if seen[l.Dst] {
				continue
			}
			// Weak links drop packets sometimes.
			if l.SNR < -10 && sim.r.Float64() < 0.5 {
				continue
			}
			seen[l.Dst] = true
			nh := hop{node: l.Dst, prev: h.node, depth: h.depth + 1, link: l}
			out = append(out, nh)
			if nh.depth < hopStart+1 {
				q = append(q, nh)
			}
		}
	}
	return out
}

// flood encrypts one packet and emits an uplink from each gateway that
// hears it, with correct hop_limit and relay_node for its reception.
func (sim *Simulator) flood(src int, to, id uint32, d *pb.Data, channel string, hopStart uint32, mutate func(*pb.MeshPacket)) []Message {
	n := sim.S.Nodes[src]
	if channel == PrivateChannel && !n.Private {
		channel = PublicChannel
	}
	sim.sign(n, id, to, d)
	pt, _ := proto.Marshal(d)
	var ct []byte
	var hash uint8
	if channel == PrivateChannel {
		ct, _ = security.EncryptCCM(sim.privKey, n.Num, to, id, pt)
		hash = security.ChannelHash(channel, sim.privKey, security.ModeCCM)
	} else {
		ct, _ = security.EncryptCTR(security.DefaultPSK[:], n.Num, id, pt)
		hash = security.ChannelHash(channel, security.DefaultPSK[:], security.ModeCTR)
	}
	var msgs []Message
	emit := func(gw *Node, mp *pb.MeshPacket, note string) {
		if mutate != nil {
			mutate(mp)
		}
		if gw.Plaintext {
			mp.PayloadVariant = &pb.MeshPacket_Decoded{Decoded: d}
			note += " (plaintext uplink)"
		}
		if channel == PrivateChannel && !gw.Private {
			return // gateway cannot decrypt, so it does not uplink this channel
		}
		b, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: channel, GatewayId: protocol.NodeID(gw.Num)})
		msgs = append(msgs, Message{Topic: sim.topic(channel, gw), Payload: b, Note: note})
	}
	base := func() *pb.MeshPacket {
		return &pb.MeshPacket{From: n.Num, To: to, Id: id, Channel: uint32(hash), HopStart: hopStart,
			PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct}, TransportMechanism: pb.MeshPacket_TRANSPORT_LORA}
	}
	if n.Gateway {
		mp := base()
		mp.HopLimit = hopStart
		mp.TransportMechanism = pb.MeshPacket_TRANSPORT_INTERNAL
		emit(n, mp, "own packet")
	}
	now := uint32(time.Now().Unix())
	for _, h := range sim.reach(src, int(hopStart)) {
		gw := sim.S.Nodes[h.node]
		if !gw.Gateway {
			continue
		}
		mp := base()
		mp.HopLimit = hopStart - uint32(h.depth-1)
		mp.RelayNode = sim.S.Nodes[h.prev].Num & 0xff
		mp.RxSnr = h.link.SNR
		rssi := h.link.RSSI
		mp.RxRssi = &rssi
		mp.RxTime = &now
		emit(gw, mp, "reception")
		// Occasionally the broker delivers the same upload twice (QoS retry / bridge).
		if sim.r.IntN(20) == 0 {
			emit(gw, proto.Clone(mp).(*pb.MeshPacket), "duplicate delivery")
		}
	}
	return msgs
}

func (sim *Simulator) nodeInfo(n *Node) *pb.Data {
	u := &pb.User{Id: protocol.NodeID(n.Num), LongName: n.Long, ShortName: n.Short, HwModel: n.HW, Role: n.Role}
	if n.Key != nil {
		u.PublicKey = n.Key.X25519Pub
	}
	b, _ := proto.Marshal(u)
	return &pb.Data{Portnum: pb.PortNum_NODEINFO_APP, Payload: b}
}

func (sim *Simulator) position(n *Node) *pb.Data {
	lat, lon := int32(n.Lat*1e7), int32(n.Lon*1e7)
	alt := n.Alt
	prec := uint32(32)
	if n.Short == "MELH" || n.Short == "SELB" {
		prec = 13 // coarse, public-precision position: never an anchor
	}
	b, _ := proto.Marshal(&pb.Position{LatitudeI: &lat, LongitudeI: &lon, Altitude: &alt, PrecisionBits: prec,
		LocationSource: pb.Position_LOC_MANUAL, Time: uint32(time.Now().Unix())})
	return &pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: b}
}

func (sim *Simulator) telemetry() *pb.Data {
	batt := uint32(40 + sim.r.IntN(61))
	v := float32(3.6 + sim.r.Float64()*0.6)
	cu := float32(sim.r.Float64() * 25)
	au := float32(sim.r.Float64() * 5)
	up := uint32(3600 + sim.r.IntN(864000))
	b, _ := proto.Marshal(&pb.Telemetry{Time: uint32(time.Now().Unix()), Variant: &pb.Telemetry_DeviceMetrics{DeviceMetrics: &pb.DeviceMetrics{
		BatteryLevel: &batt, Voltage: &v, ChannelUtilization: &cu, AirUtilTx: &au, UptimeSeconds: &up}}})
	return &pb.Data{Portnum: pb.PortNum_TELEMETRY_APP, Payload: b}
}

// neighborInfo reports nodes the sender hears: SNR measured at the sender,
// i.e. links whose Dst is the sender.
func (sim *Simulator) neighborInfo(src int) *pb.Data {
	n := sim.S.Nodes[src]
	ni := &pb.NeighborInfo{NodeId: n.Num, NodeBroadcastIntervalSecs: 900}
	for i := range sim.S.Nodes {
		for _, l := range sim.S.Links[i] {
			if l.Dst == src && len(ni.Neighbors) < 10 {
				ni.Neighbors = append(ni.Neighbors, &pb.Neighbor{NodeId: sim.S.Nodes[i].Num, Snr: l.SNR})
			}
		}
	}
	b, _ := proto.Marshal(ni)
	return &pb.Data{Portnum: pb.PortNum_NEIGHBORINFO_APP, Payload: b}
}

// path returns the BFS shortest path src..dst (node indexes) or nil.
func (sim *Simulator) path(src, dst int) []int {
	prev := map[int]int{src: -1}
	q := []int{src}
	for len(q) > 0 {
		c := q[0]
		q = q[1:]
		if c == dst {
			break
		}
		for _, l := range sim.S.Links[c] {
			if _, ok := prev[l.Dst]; !ok {
				prev[l.Dst] = c
				q = append(q, l.Dst)
			}
		}
	}
	if _, ok := prev[dst]; !ok {
		return nil
	}
	var p []int
	for c := dst; c != -1; c = prev[c] {
		p = append([]int{c}, p...)
	}
	return p
}

func (sim *Simulator) linkSNR(a, b int) int32 {
	for _, l := range sim.S.Links[a] {
		if l.Dst == b {
			return int32(l.SNR * 4)
		}
	}
	return -128
}

// traceroute emits partial-route request copies heard by gateways along the
// way, then the reply carrying route, route_back and SNR (x4) arrays. One
// hop in the reply is sometimes an unidentified relay (NODENUM_BROADCAST).
func (sim *Simulator) traceroute(src int) []Message {
	var dst int
	var p []int
	for tries := 0; tries < 10; tries++ {
		dst = sim.r.IntN(len(sim.S.Nodes))
		p = sim.path(src, dst)
		if len(p) >= 3 && len(p) <= 5 {
			break
		}
		p = nil
	}
	if p == nil {
		return nil
	}
	srcN, dstN := sim.S.Nodes[src], sim.S.Nodes[dst]
	reqID := sim.id()
	var msgs []Message
	// Request copies: each relay appends itself, so later copies carry longer routes.
	var route []uint32
	var snrT []int32
	for i := 1; i < len(p); i++ {
		snrT = append(snrT, sim.linkSNR(p[i-1], p[i]))
		if i < len(p)-1 {
			route = append(route, sim.S.Nodes[p[i]].Num)
		}
		b, _ := proto.Marshal(&pb.RouteDiscovery{Route: append([]uint32(nil), route...), SnrTowards: append([]int32(nil), snrT[:len(route)]...)})
		d := &pb.Data{Portnum: pb.PortNum_TRACEROUTE_APP, Payload: b, WantResponse: true}
		msgs = append(msgs, sim.copyAt(p[i], p[i-1], srcN, dstN.Num, reqID, d, uint32(i))...)
	}
	// Reply travels back along the reverse path.
	var back []uint32
	var snrB []int32
	for i := len(p) - 1; i > 0; i-- {
		snrB = append(snrB, sim.linkSNR(p[i], p[i-1]))
		if i > 1 {
			back = append(back, sim.S.Nodes[p[i-1]].Num)
		}
	}
	fwd := append([]uint32(nil), route...)
	if len(fwd) >= 2 && sim.r.IntN(3) == 0 {
		fwd[len(fwd)-1] = protocol.Broadcast // relay that did not record itself
		snrT[len(fwd)-1] = -128
	}
	b, _ := proto.Marshal(&pb.RouteDiscovery{Route: fwd, SnrTowards: snrT, RouteBack: back, SnrBack: snrB})
	reply := &pb.Data{Portnum: pb.PortNum_TRACEROUTE_APP, Payload: b, RequestId: reqID}
	msgs = append(msgs, sim.flood(dst, srcN.Num, sim.id(), reply, PublicChannel, 3, nil)...)
	return msgs
}

// copyAt emits a request copy if the node at index at is a gateway.
func (sim *Simulator) copyAt(at, prev int, src *Node, to, id uint32, d *pb.Data, depth uint32) []Message {
	gw := sim.S.Nodes[at]
	if !gw.Gateway {
		return nil
	}
	pt, _ := proto.Marshal(d)
	ct, _ := security.EncryptCTR(security.DefaultPSK[:], src.Num, id, pt)
	rssi := int32(-100)
	now := uint32(time.Now().Unix())
	mp := &pb.MeshPacket{From: src.Num, To: to, Id: id, Channel: uint32(security.ChannelHash(PublicChannel, security.DefaultPSK[:], security.ModeCTR)),
		HopStart: 3, HopLimit: 3 - (depth - 1), RelayNode: sim.S.Nodes[prev].Num & 0xff, RxSnr: float32(sim.linkSNR(prev, at)) / 4, RxRssi: &rssi, RxTime: &now,
		PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct}, TransportMechanism: pb.MeshPacket_TRANSPORT_LORA}
	b, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: PublicChannel, GatewayId: protocol.NodeID(gw.Num)})
	return []Message{{Topic: sim.topic(PublicChannel, gw), Payload: b, Note: "traceroute request copy"}}
}

// forgedSignature: a signing node's position with one payload byte flipped
// after signing. Must be rejected as sig_invalid once the key is known.
func (sim *Simulator) forgedSignature() []Message {
	for i, n := range sim.S.Nodes {
		if n.Key == nil || !n.SharesPos {
			continue
		}
		d := sim.position(n)
		id := sim.id()
		sim.sign(n, id, protocol.Broadcast, d)
		d.Payload = append([]byte(nil), d.Payload...)
		d.Payload[2] ^= 0x01                                                   // inside latitude_i: still a valid Position, wrong signature
		msgs := sim.flood(i, protocol.Broadcast, id, d, PublicChannel, 3, nil) // keeps the stale signature
		for j := range msgs {
			msgs[j].Note = "forged signature (header only)"
		}
		return msgs
	}
	return nil
}

// pkiDM: a PKI-encrypted direct message (channel hash 0); only its header is kept (D-091).
func (sim *Simulator) pkiDM() []Message {
	a, b := sim.S.Nodes[1], sim.S.Nodes[2]
	ct := make([]byte, 48)
	for i := range ct {
		ct[i] = byte(sim.r.IntN(256))
	}
	gw := sim.S.Nodes[0]
	rssi := int32(-95)
	mp := &pb.MeshPacket{From: a.Num, To: b.Num, Id: sim.id(), Channel: 0, PkiEncrypted: true, HopStart: 3, HopLimit: 2, RxRssi: &rssi,
		PayloadVariant: &pb.MeshPacket_Encrypted{Encrypted: ct}}
	env, _ := proto.Marshal(&pb.ServiceEnvelope{Packet: mp, ChannelId: "PKI", GatewayId: protocol.NodeID(gw.Num)})
	return []Message{{Topic: TopicRoot + "/2/e/PKI/" + protocol.NodeID(gw.Num), Payload: env, Note: "PKI DM (header only)"}}
}
