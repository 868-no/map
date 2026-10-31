package security

import (
	"crypto/ed25519"
	"encoding/binary"
	"errors"

	"filippo.io/edwards25519/field"

	"github.com/868-no/map/internal/protocol/pb"
)

// SignatureSize is firmware XEDDSA_SIGNATURE_SIZE.
const SignatureSize = 64

const (
	signingVersion   = 0x01 // XEDDSA_SIGNING_VERSION
	signedHeaderLen  = 1 + 8*4 + 1
	flagWantResponse = 0x01
	flagHasBitfield  = 0x02
)

var errBadCurveKey = errors.New("invalid X25519 public key")

// ConvertX25519PublicKey applies the RFC 7748 §4.1 birational map
// y = (u-1)/(u+1) and encodes the Ed25519 point with sign bit 0, the form
// XEdDSA normalises every signing key to (firmware curve_to_ed_pub).
//
// Like firmware fe_frombytes, the top bit of u is ignored; additionally we
// reject non-canonical u (>= p) and u = -1, which has no Edwards image.
func ConvertX25519PublicKey(u []byte) (ed25519.PublicKey, error) {
	if len(u) != 32 {
		return nil, errBadCurveKey
	}
	var masked [32]byte
	copy(masked[:], u)
	masked[31] &= 0x7f
	fu, err := new(field.Element).SetBytes(masked[:])
	if err != nil {
		return nil, errBadCurveKey
	}
	// SetBytes reduces mod p; reject inputs whose encoding was not canonical.
	if [32]byte(fu.Bytes()) != masked {
		return nil, errBadCurveKey
	}
	one := new(field.Element).One()
	num := new(field.Element).Subtract(fu, one)
	den := new(field.Element).Add(fu, one)
	if den.Equal(new(field.Element).Zero()) == 1 {
		return nil, errBadCurveKey
	}
	y := new(field.Element).Multiply(num, new(field.Element).Invert(den))
	out := y.Bytes()
	out[31] &= 0x7f
	return ed25519.PublicKey(out), nil
}

// SigningBuffer mirrors firmware buildSigningBuffer: a fixed-length
// little-endian header over the packet's identifying metadata followed by the
// Data payload. Hop fields, channel and dest/source are deliberately excluded.
func SigningBuffer(from, packetID, to uint32, d *pb.Data) []byte {
	buf := make([]byte, signedHeaderLen+len(d.GetPayload()))
	buf[0] = signingVersion
	le := binary.LittleEndian
	le.PutUint32(buf[1:], from)
	le.PutUint32(buf[5:], packetID)
	le.PutUint32(buf[9:], to)
	le.PutUint32(buf[13:], uint32(d.GetPortnum()))
	le.PutUint32(buf[17:], d.GetRequestId())
	le.PutUint32(buf[21:], d.GetReplyId())
	le.PutUint32(buf[25:], d.GetEmoji())
	var flags byte
	if d.GetWantResponse() {
		flags |= flagWantResponse
	}
	if d.Bitfield != nil {
		le.PutUint32(buf[29:], d.GetBitfield())
		flags |= flagHasBitfield
	}
	buf[33] = flags
	copy(buf[signedHeaderLen:], d.GetPayload())
	return buf
}

// VerifyXEdDSA checks a packet signature against a node's X25519 public key.
// XEdDSA verification is standard Ed25519 verification under the converted
// key, which is exactly what the firmware does (curve_to_ed_pub +
// ed25519Verify).
func VerifyXEdDSA(curvePub []byte, from, packetID, to uint32, d *pb.Data, sig []byte) bool {
	if len(sig) != SignatureSize {
		return false
	}
	edpk, err := ConvertX25519PublicKey(curvePub)
	if err != nil {
		return false
	}
	return ed25519.Verify(edpk, SigningBuffer(from, packetID, to, d), sig)
}

// VerifyXEdDSAEd is VerifyXEdDSA with a pre-converted Ed25519 key (identity
// cache hit path).
func VerifyXEdDSAEd(edpk ed25519.PublicKey, from, packetID, to uint32, d *pb.Data, sig []byte) bool {
	if len(sig) != SignatureSize || len(edpk) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(edpk, SigningBuffer(from, packetID, to, d), sig)
}
