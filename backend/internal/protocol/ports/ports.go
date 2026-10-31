// Package ports decodes Meshtastic application payloads into the minimal,
// sanitised metadata stored in packet_log.decoded_metadata. Every decoder is
// pure: it never consults state outside the packet.
package ports

import (
	"errors"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol/pb"
)

// Packet types as stored in packet_log.packet_type.
const (
	TypeNodeInfo     = "nodeinfo"
	TypePosition     = "position"
	TypeTelemetry    = "telemetry"
	TypeNeighborInfo = "neighborinfo"
	TypeTraceroute   = "traceroute"
	TypeText         = "text"
	TypeRouting      = "routing"
	TypeMapReport    = "mapreport"
	TypeOther        = "other"
)

var (
	ErrInvalid = errors.New("invalid application payload")
	unmarshal  = proto.UnmarshalOptions{RecursionLimit: 8}
)

// Decoded is the result of decoding one Data payload.
type Decoded struct {
	Type         string
	NodeInfo     *NodeInfo     `json:"nodeinfo,omitempty"`
	Position     *Position     `json:"position,omitempty"`
	Telemetry    *Telemetry    `json:"telemetry,omitempty"`
	NeighborInfo *NeighborInfo `json:"neighborinfo,omitempty"`
	Traceroute   *Traceroute   `json:"traceroute,omitempty"`
	Text         *Text         `json:"text,omitempty"`
	Routing      *Routing      `json:"routing,omitempty"`
	MapReport    *MapReport    `json:"mapreport,omitempty"`
	Other        *Other        `json:"other,omitempty"`
}

// Decode dispatches on portnum. Known ports whose payload does not parse or
// validate return ErrInvalid; they are never reinterpreted as another type.
func Decode(d *pb.Data, from uint32) (Decoded, error) {
	switch d.GetPortnum() {
	case pb.PortNum_NODEINFO_APP:
		v, err := decodeNodeInfo(d.GetPayload())
		return Decoded{Type: TypeNodeInfo, NodeInfo: v}, err
	case pb.PortNum_POSITION_APP:
		v, err := decodePosition(d.GetPayload())
		return Decoded{Type: TypePosition, Position: v}, err
	case pb.PortNum_TELEMETRY_APP:
		v, err := decodeTelemetry(d.GetPayload())
		return Decoded{Type: TypeTelemetry, Telemetry: v}, err
	case pb.PortNum_NEIGHBORINFO_APP:
		v, err := decodeNeighborInfo(d.GetPayload(), from)
		return Decoded{Type: TypeNeighborInfo, NeighborInfo: v}, err
	case pb.PortNum_TRACEROUTE_APP:
		v, err := decodeTraceroute(d)
		return Decoded{Type: TypeTraceroute, Traceroute: v}, err
	case pb.PortNum_TEXT_MESSAGE_APP, pb.PortNum_TEXT_MESSAGE_COMPRESSED_APP, pb.PortNum_DETECTION_SENSOR_APP, pb.PortNum_ALERT_APP:
		// Bodies are never stored (§5): size and kind only.
		return Decoded{Type: TypeText, Text: &Text{Bytes: len(d.GetPayload()), Port: d.GetPortnum().String()}}, nil
	case pb.PortNum_ROUTING_APP:
		v, err := decodeRouting(d)
		return Decoded{Type: TypeRouting, Routing: v}, err
	case pb.PortNum_MAP_REPORT_APP:
		// The location is stored as an ordinary position so every position
		// consumer reads both packet types.
		v, pos, err := decodeMapReport(d.GetPayload())
		return Decoded{Type: TypeMapReport, MapReport: v, Position: pos}, err
	case pb.PortNum_UNKNOWN_APP:
		return Decoded{}, ErrInvalid
	}
	return Decoded{Type: TypeOther, Other: &Other{Port: int32(d.GetPortnum()), PortName: portName(d.GetPortnum()), Bytes: len(d.GetPayload())}}, nil
}

func portName(p pb.PortNum) string {
	if n, ok := pb.PortNum_name[int32(p)]; ok {
		return n
	}
	return ""
}

// CleanString strips control and format characters, trims, and truncates to
// max runes. Invalid UTF-8 is replaced.
func CleanString(s string, max int) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	var b strings.Builder
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if n == max {
			break
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}

func finite32(p *float32, lo, hi float64) *float64 {
	if p == nil {
		return nil
	}
	v := float64(*p)
	if math.IsNaN(v) || math.IsInf(v, 0) || v < lo || v > hi {
		return nil
	}
	v = math.Round(v*1000) / 1000
	return &v
}
