package security

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"hash/crc32"
	"time"

	"github.com/868-no/map/internal/protocol/pb"
)

// SignatureStatus is the per-packet verification status stored in
// packet_log.signature_status. Decrypting with a channel key never implies
// "verified".
type SignatureStatus string

const (
	SigVerified      SignatureStatus = "verified"
	SigUnsigned      SignatureStatus = "unsigned"
	SigUnverifiable  SignatureStatus = "unverifiable"   // signed, but no authoritative key
	SigNotApplicable SignatureStatus = "not-applicable" // traceroute: rewritten by every hop
)

// Policy selects how unverifiable signatures are treated.
type Policy uint8

const (
	PolicyBalanced Policy = iota // default: accept unverifiable, never call it verified
	PolicyStrict                 // reject signed packets whose key is unknown
)

// ParsePolicy accepts "balanced" (default) or "strict".
func ParsePolicy(s string) (Policy, error) {
	switch s {
	case "", "balanced":
		return PolicyBalanced, nil
	case "strict":
		return PolicyStrict, nil
	}
	return 0, errors.New("SIGNATURE_POLICY must be balanced or strict")
}

// Rejection categories (metric label values). A packet failing these checks
// is stored as a header-only invalid row, never its contents (D-093).
var (
	ErrSigMalformed        = errors.New("sig_malformed")
	ErrSigInvalid          = errors.New("sig_invalid")
	ErrFirstContactInvalid = errors.New("first_contact_invalid")
	ErrNodeInfoKeyMismatch = errors.New("nodeinfo_key_mismatch")
	ErrStrictUnverifiable  = errors.New("strict_unverifiable")
	// ErrSig280: a signature that fails, but verifies in firmware 2.8.0's
	// signing layout under the same key. Kept out as firmware 2.8.1 and
	// later keep it out, under a reason of its own (D-229).
	ErrSig280 = errors.New("sig_2_8_0")
)

// Identity is an authoritative node key binding.
type Identity struct {
	Node  uint32
	Curve []byte            // X25519 public key as announced
	Ed    ed25519.PublicKey // converted once, cached
	Since time.Time         // observed_at of the binding row
	RowID int64             // packet_log id of the binding row (0 until stored)
}

// NewIdentity converts and validates an announced key.
func NewIdentity(node uint32, curve []byte) (Identity, error) {
	ed, err := ConvertX25519PublicKey(curve)
	if err != nil {
		return Identity{}, err
	}
	return Identity{Node: node, Curve: bytes.Clone(curve), Ed: ed}, nil
}

// KeyBindsNode is the firmware first-contact binding: a 2.8 node's number is
// the CRC-32 of its public key.
func KeyBindsNode(curve []byte, node uint32) bool {
	return len(curve) == 32 && crc32.ChecksumIEEE(curve) == node
}

// IdentityLookup returns the authoritative key for a node, if any.
type IdentityLookup interface {
	Lookup(node uint32) (Identity, bool)
}

// Verdict is the outcome for an accepted packet.
type Verdict struct {
	Status SignatureStatus
	// Promote is set when this packet establishes a new authoritative
	// binding (verified first-contact NodeInfo). The ingest writer records it
	// only after the row commits.
	Promote *Identity
	// IdentityUntrusted marks an unsigned NodeInfo from a node with an
	// authoritative key that does not announce that same key (firmware's
	// NodeDB::updateUser drops it: "Public Key mismatch"); KeyConflict
	// additionally means it announced a different key. Such rows are stored
	// as traffic but never used for names/roles/keys (D-228).
	IdentityUntrusted bool
	KeyConflict       bool
}

// PacketHeader is the subset of MeshPacket the signature covers.
type PacketHeader struct {
	From, ID, To uint32
}

// HeaderOf extracts the signed header fields.
func HeaderOf(p *pb.MeshPacket) PacketHeader {
	return PacketHeader{From: p.GetFrom(), ID: p.GetId(), To: p.GetTo()}
}

// Evaluate applies firmware Router.cpp checkXeddsaReceivePolicy semantics to
// a decoded packet. announcedKey is the NodeInfo payload's public key (nil
// for other ports or keyless NodeInfo). aead is set when the packet came on
// an AES-CCM channel, whose tag authenticates it: firmware then never applies
// Strict. An inbound xeddsa_signed flag is never consulted.
func Evaluate(h PacketHeader, d *pb.Data, announcedKey []byte, ids IdentityLookup, policy Policy, aead bool) (Verdict, error) {
	isNodeInfo := d.GetPortnum() == pb.PortNum_NODEINFO_APP

	// Every hop rewrites a traceroute, so a signature on one cannot verify
	// past its first hop: ignore it entirely (firmware does the same).
	if d.GetPortnum() == pb.PortNum_TRACEROUTE_APP {
		return Verdict{Status: SigNotApplicable}, nil
	}

	sig := d.GetXeddsaSignature()
	known, haveKey := ids.Lookup(h.From)

	switch {
	case len(sig) == SignatureSize:
		if haveKey {
			if !VerifyXEdDSAEd(known.Ed, h.From, h.ID, h.To, d, sig) {
				if SignedBy280(known.Ed, h.From, h.ID, d, sig) {
					return Verdict{}, ErrSig280
				}
				return Verdict{}, ErrSigInvalid
			}
			// A signed NodeInfo must claim the key that signed it, and that
			// key must hash to the sender (signedNodeInfoConsistent).
			if isNodeInfo && len(announcedKey) == 32 &&
				(!bytes.Equal(announcedKey, known.Curve) || !KeyBindsNode(announcedKey, h.From)) {
				return Verdict{}, ErrNodeInfoKeyMismatch
			}
			return Verdict{Status: SigVerified}, nil
		}
		if isNodeInfo {
			// First contact: self-consistent key, binding and signature, or drop.
			if !KeyBindsNode(announcedKey, h.From) {
				return Verdict{}, ErrFirstContactInvalid
			}
			if !VerifyXEdDSA(announcedKey, h.From, h.ID, h.To, d, sig) {
				// 2.8.0 already derived its node id from its key, so the
				// binding holds; only the signing layout differs.
				if ed, err := ConvertX25519PublicKey(announcedKey); err == nil && SignedBy280(ed, h.From, h.ID, d, sig) {
					return Verdict{}, ErrSig280
				}
				return Verdict{}, ErrFirstContactInvalid
			}
			id, err := NewIdentity(h.From, announcedKey)
			if err != nil {
				return Verdict{}, ErrFirstContactInvalid
			}
			return Verdict{Status: SigVerified, Promote: &id}, nil
		}
		if policy == PolicyStrict && !aead {
			return Verdict{}, ErrStrictUnverifiable
		}
		return Verdict{Status: SigUnverifiable}, nil

	case len(sig) != 0:
		return Verdict{}, ErrSigMalformed
	}

	// Unsigned. Accepted (old firmware, packets too large to sign, signers on
	// firmware's default Compatible policy, which stopped signing in 2.8.2,
	// and signed packets relayed by firmware before 2.8, which strips the
	// signature). A known signer's unsigned NodeInfo names it as long as it
	// announces the signer's own key, as with firmware's default policy; one
	// announcing no key or another key never overrides the identity (D-228).
	v := Verdict{Status: SigUnsigned}
	if isNodeInfo && haveKey && !bytes.Equal(announcedKey, known.Curve) {
		v.IdentityUntrusted = true
		v.KeyConflict = len(announcedKey) == 32
	}
	return v, nil
}
