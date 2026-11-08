package ports

import (
	"encoding/base64"
	"math"

	"github.com/868-no/map/internal/protocol/pb"
)

// NodeInfo carries the identity announcement. PublicKey is the node's X25519
// public key: public data, stored so the identity index can be rebuilt from
// packet_log without re-decrypting (plan amendment 3).
type NodeInfo struct {
	LongName    string `json:"long_name,omitempty"`
	ShortName   string `json:"short_name,omitempty"`
	HwModel     string `json:"hw_model,omitempty"`
	Role        string `json:"role,omitempty"`
	IsLicensed  bool   `json:"is_licensed,omitempty"`
	PublicKey   string `json:"public_key,omitempty"` // base64, 32 bytes
	KeyConflict bool   `json:"key_conflict,omitempty"`
	// IdentityUntrusted: unsigned NodeInfo from a node with an authoritative
	// key. Kept as traffic; never used for names, roles or keys.
	IdentityUntrusted bool `json:"identity_untrusted,omitempty"`

	publicKey []byte
}

// PublicKeyBytes returns the raw 32-byte key, or nil.
func (n *NodeInfo) PublicKeyBytes() []byte { return n.publicKey }

func decodeNodeInfo(b []byte) (*NodeInfo, error) {
	var u pb.User
	if err := decode(b, &u); err != nil {
		return nil, ErrInvalid
	}
	n := &NodeInfo{
		LongName:   CleanString(u.GetLongName(), 40),
		ShortName:  CleanString(u.GetShortName(), 8),
		HwModel:    u.GetHwModel().String(),
		Role:       u.GetRole().String(),
		IsLicensed: u.GetIsLicensed(),
	}
	switch len(u.GetPublicKey()) {
	case 0:
	case 32:
		n.publicKey = append([]byte(nil), u.GetPublicKey()...)
		n.PublicKey = base64.StdEncoding.EncodeToString(n.publicKey)
	default:
		return nil, ErrInvalid
	}
	return n, nil
}

// Position is a reported location. PrecisionKnown is false when the sender
// set precision_bits = 0 (not expected from firmware >= 2.7): the position is
// displayed with unknown precision and never used as a geolocation anchor.
type Position struct {
	Lat            float64 `json:"lat"`
	Lon            float64 `json:"lon"`
	Alt            *int32  `json:"alt,omitempty"`
	PrecisionBits  uint32  `json:"precision_bits"`
	PrecisionKnown bool    `json:"precision_known"`
	LocSource      string  `json:"loc_source,omitempty"`
	PosTime        uint32  `json:"pos_time,omitempty"` // sender clock, auxiliary only
}

// decodePosition returns (nil, nil) for a well-formed packet without usable
// coordinates (zero or missing lat/lon): stored, but with no position.
func decodePosition(b []byte) (*Position, error) {
	var p pb.Position
	if err := decode(b, &p); err != nil {
		return nil, ErrInvalid
	}
	if p.LatitudeI == nil || p.LongitudeI == nil || (p.GetLatitudeI() == 0 && p.GetLongitudeI() == 0) {
		return nil, nil
	}
	lat, lon := float64(p.GetLatitudeI())*1e-7, float64(p.GetLongitudeI())*1e-7
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return nil, ErrInvalid
	}
	if p.GetPrecisionBits() > 32 {
		return nil, ErrInvalid
	}
	out := &Position{
		Lat: lat, Lon: lon,
		PrecisionBits:  p.GetPrecisionBits(),
		PrecisionKnown: p.GetPrecisionBits() > 0,
		PosTime:        p.GetTime(),
	}
	if p.GetLocationSource() != pb.Position_LOC_UNSET {
		out.LocSource = p.GetLocationSource().String()
	}
	if p.Altitude != nil && p.GetAltitude() > -500 && p.GetAltitude() < 12000 {
		a := p.GetAltitude()
		out.Alt = &a
	}
	return out, nil
}

// Telemetry keeps device and environment samples needed for node panels.
type Telemetry struct {
	Kind     string   `json:"kind"`
	Battery  *float64 `json:"battery,omitempty"`
	Voltage  *float64 `json:"voltage,omitempty"`
	ChUtil   *float64 `json:"ch_util,omitempty"`
	AirUtil  *float64 `json:"air_util,omitempty"`
	Uptime   *uint32  `json:"uptime,omitempty"`
	Temp     *float64 `json:"temp,omitempty"`
	Humidity *float64 `json:"humidity,omitempty"`
	Pressure *float64 `json:"pressure,omitempty"`
	// Local statistics (kind "local"): the node's own radio counters, and the
	// noise floor it measures, which tells a noisier site from a weaker antenna.
	NoiseFloor      *int32  `json:"noise_floor,omitempty"` // dBm
	PacketsTx       *uint32 `json:"packets_tx,omitempty"`
	PacketsRx       *uint32 `json:"packets_rx,omitempty"`
	PacketsRxBad    *uint32 `json:"packets_rx_bad,omitempty"`
	RxDupe          *uint32 `json:"rx_dupe,omitempty"`
	TxRelay         *uint32 `json:"tx_relay,omitempty"`
	TxRelayCanceled *uint32 `json:"tx_relay_canceled,omitempty"`
	TxDropped       *uint32 `json:"tx_dropped,omitempty"`
	OnlineNodes     *uint32 `json:"online_nodes,omitempty"`
	TotalNodes      *uint32 `json:"total_nodes,omitempty"`
}

// NoiseFloorRange bounds a plausible noise floor, dBm: firmware sends 0 when
// it has not measured one, and a LoRa receiver's floor lies well inside this.
var NoiseFloorRange = [2]int32{-150, -30}

func decodeTelemetry(b []byte) (*Telemetry, error) {
	var t pb.Telemetry
	if err := decode(b, &t); err != nil {
		return nil, ErrInvalid
	}
	switch v := t.GetVariant().(type) {
	case *pb.Telemetry_DeviceMetrics:
		m := v.DeviceMetrics
		out := &Telemetry{Kind: "device"}
		if m.BatteryLevel != nil && *m.BatteryLevel <= 101 {
			f := float64(*m.BatteryLevel)
			out.Battery = &f
		}
		out.Voltage = finite32(m.Voltage, 0, 60)
		out.ChUtil = finite32(m.ChannelUtilization, 0, 100)
		out.AirUtil = finite32(m.AirUtilTx, 0, 100)
		out.Uptime = m.UptimeSeconds
		return out, nil
	case *pb.Telemetry_EnvironmentMetrics:
		m := v.EnvironmentMetrics
		return &Telemetry{
			Kind:     "environment",
			Temp:     finite32(m.Temperature, -90, 90),
			Humidity: finite32(m.RelativeHumidity, 0, 100),
			Pressure: finite32(m.BarometricPressure, 300, 1100),
			Voltage:  finite32(m.Voltage, 0, 60),
		}, nil
	case *pb.Telemetry_LocalStats:
		m := v.LocalStats
		u := func(x uint32) *uint32 { return &x }
		out := &Telemetry{Kind: "local", Uptime: u(m.UptimeSeconds),
			ChUtil: finite32(&m.ChannelUtilization, 0, 100), AirUtil: finite32(&m.AirUtilTx, 0, 100),
			PacketsTx: u(m.NumPacketsTx), PacketsRx: u(m.NumPacketsRx), PacketsRxBad: u(m.NumPacketsRxBad), RxDupe: u(m.NumRxDupe),
			TxRelay: u(m.NumTxRelay), TxRelayCanceled: u(m.NumTxRelayCanceled), TxDropped: u(m.NumTxDropped),
			OnlineNodes: u(m.NumOnlineNodes), TotalNodes: u(m.NumTotalNodes)}
		if n := m.NoiseFloor; n >= NoiseFloorRange[0] && n <= NoiseFloorRange[1] {
			out.NoiseFloor = &n
		}
		return out, nil
	case nil:
		return nil, ErrInvalid
	default:
		return &Telemetry{Kind: "other"}, nil
	}
}

// MaxNeighbors bounds NeighborInfo entries (firmware sends at most 10).
const MaxNeighbors = 64

// Neighbor is one NeighborInfo entry: the reporter heard ID at SNR dB.
// SNR is the reported float, NOT scaled (unlike traceroute).
type Neighbor struct {
	ID     uint32   `json:"id"`
	SNR    *float64 `json:"snr,omitempty"`
	LastRx uint32   `json:"last_rx,omitempty"`
}

// NeighborInfo is a node's report of nodes it directly hears.
type NeighborInfo struct {
	Reporter  uint32     `json:"reporter"`
	Interval  uint32     `json:"interval,omitempty"`
	Neighbors []Neighbor `json:"neighbors"`
	Dropped   int        `json:"dropped,omitempty"` // invalid entries omitted
}

func decodeNeighborInfo(b []byte, from uint32) (*NeighborInfo, error) {
	var n pb.NeighborInfo
	if err := decode(b, &n); err != nil {
		return nil, ErrInvalid
	}
	if len(n.GetNeighbors()) > MaxNeighbors {
		return nil, ErrInvalid
	}
	// The report describes the sender; a report claiming another node_id is
	// not evidence about that node from this sender.
	if n.GetNodeId() != 0 && n.GetNodeId() != from {
		return nil, ErrInvalid
	}
	out := &NeighborInfo{Reporter: from, Interval: n.GetNodeBroadcastIntervalSecs(), Neighbors: []Neighbor{}}
	seen := map[uint32]bool{}
	for _, nb := range n.GetNeighbors() {
		id := nb.GetNodeId()
		if id == 0 || id == 0xFFFFFFFF || id == from || seen[id] {
			out.Dropped++
			continue
		}
		seen[id] = true
		e := Neighbor{ID: id, LastRx: nb.GetLastRxTime()}
		if s := float64(nb.GetSnr()); !math.IsNaN(s) && !math.IsInf(s, 0) && s > -40 && s < 40 {
			s = math.Round(s*100) / 100
			e.SNR = &s
		}
		out.Neighbors = append(out.Neighbors, e)
	}
	return out, nil
}

// Text records only that a message-like packet existed (design §3.2: no bodies).
type Text struct {
	Port  string `json:"port"`
	Bytes int    `json:"bytes"`
}

// Routing records ACK/NAK metadata only.
type Routing struct {
	Kind      string `json:"kind"` // ack, error, route_request, route_reply
	Error     string `json:"error,omitempty"`
	RequestID uint32 `json:"request_id,omitempty"`
	AckProof  bool   `json:"ack_proof,omitempty"`
}

func decodeRouting(d *pb.Data) (*Routing, error) {
	var r pb.Routing
	if err := decode(d.GetPayload(), &r); err != nil {
		return nil, ErrInvalid
	}
	out := &Routing{RequestID: d.GetRequestId(), AckProof: len(r.GetAckProof()) > 0}
	switch v := r.GetVariant().(type) {
	case *pb.Routing_ErrorReason:
		if v.ErrorReason == pb.Routing_NONE {
			out.Kind = "ack"
		} else {
			out.Kind = "error"
			out.Error = v.ErrorReason.String()
		}
	case *pb.Routing_RouteRequest:
		out.Kind = "route_request"
	case *pb.Routing_RouteReply:
		out.Kind = "route_reply"
	default:
		out.Kind = "ack"
	}
	return out, nil
}

// Other is a well-formed packet on a port we do not interpret.
type Other struct {
	Port     int32  `json:"port"`
	PortName string `json:"port_name,omitempty"`
	Bytes    int    `json:"bytes"`
}
