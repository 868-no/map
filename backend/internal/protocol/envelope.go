// Package protocol parses Meshtastic MQTT topics and ServiceEnvelopes and
// decodes application payloads into minimal, sanitised metadata.
package protocol

import (
	"errors"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol/pb"
)

// Limits applied before and during envelope parsing (design §2.2).
const (
	MaxEnvelopeBytes  = 1024 // ServiceEnvelope: ≤256 B encrypted payload plus headers, ids and optional decoded fields
	MaxChannelIDLen   = 64
	MaxGatewayIDLen   = 16
	MaxDecodedPayload = 256 // Constants.DATA_PAYLOAD_LEN is 233; allow margin, firmware MAX_BLOCKSIZE is 256
)

var (
	ErrOversize     = errors.New("envelope exceeds size limit")
	ErrMalformed    = errors.New("malformed protobuf")
	ErrNoPacket     = errors.New("envelope has no packet")
	ErrBadGateway   = errors.New("invalid gateway id")
	ErrBadChannelID = errors.New("invalid channel id")
	ErrNoPayload    = errors.New("packet has neither encrypted nor decoded payload")
	ErrBadSender    = errors.New("invalid sender node number")
)

// PayloadKind says how the packet body arrived.
type PayloadKind uint8

const (
	PayloadEncrypted PayloadKind = iota // channel- or PKI-encrypted bytes
	PayloadDecoded                      // gateway uplinked plaintext Data (discouraged, but real)
)

// Envelope is a structurally validated ServiceEnvelope. None of its
// identifiers are authenticated by MQTT.
type Envelope struct {
	Raw       *pb.ServiceEnvelope
	Packet    *pb.MeshPacket
	ChannelID string
	Gateway   uint32 // 0 when absent
	Kind      PayloadKind
}

var unmarshal = proto.UnmarshalOptions{DiscardUnknown: false, RecursionLimit: 16}

// ParseEnvelope decodes and structurally validates a ServiceEnvelope.
func ParseEnvelope(b []byte) (Envelope, error) {
	if len(b) > MaxEnvelopeBytes {
		return Envelope{}, ErrOversize
	}
	var se pb.ServiceEnvelope
	if err := unmarshal.Unmarshal(b, &se); err != nil {
		return Envelope{}, ErrMalformed
	}
	p := se.GetPacket()
	if p == nil {
		return Envelope{}, ErrNoPacket
	}
	if !ValidNode(p.GetFrom()) {
		return Envelope{}, ErrBadSender
	}
	if len(se.GetChannelId()) > MaxChannelIDLen {
		return Envelope{}, ErrBadChannelID
	}
	env := Envelope{Raw: &se, Packet: p, ChannelID: se.GetChannelId()}
	if gw := se.GetGatewayId(); gw != "" {
		if len(gw) > MaxGatewayIDLen {
			return Envelope{}, ErrBadGateway
		}
		n, ok := ParseNodeID(gw)
		if !ok || !ValidNode(n) {
			return Envelope{}, ErrBadGateway
		}
		env.Gateway = n
	}
	switch v := p.GetPayloadVariant().(type) {
	case *pb.MeshPacket_Encrypted:
		if len(v.Encrypted) == 0 {
			return Envelope{}, ErrNoPayload
		}
		if len(v.Encrypted) > 256+12 {
			return Envelope{}, ErrOversize
		}
		env.Kind = PayloadEncrypted
	case *pb.MeshPacket_Decoded:
		if v.Decoded == nil {
			return Envelope{}, ErrNoPayload
		}
		if len(v.Decoded.GetPayload()) > MaxDecodedPayload {
			return Envelope{}, ErrOversize
		}
		env.Kind = PayloadDecoded
	default:
		return Envelope{}, ErrNoPayload
	}
	return env, nil
}

// ParseData decodes decrypted bytes as a Data message with payload bounds.
func ParseData(b []byte) (*pb.Data, error) {
	var d pb.Data
	if err := unmarshal.Unmarshal(b, &d); err != nil {
		return nil, ErrMalformed
	}
	if len(d.GetPayload()) > MaxDecodedPayload {
		return nil, ErrOversize
	}
	return &d, nil
}
