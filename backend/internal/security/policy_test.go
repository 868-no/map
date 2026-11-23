package security

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/testutil"
)

type mapIDs map[uint32]Identity

func (m mapIDs) Lookup(n uint32) (Identity, bool) { id, ok := m[n]; return id, ok }

func nodeInfoData(t *testing.T, k testutil.XKey, pub []byte) *pb.Data {
	t.Helper()
	b, err := proto.Marshal(&pb.User{LongName: "Test", PublicKey: pub})
	if err != nil {
		t.Fatal(err)
	}
	return &pb.Data{Portnum: pb.PortNum_NODEINFO_APP, Payload: b}
}

func sign(k testutil.XKey, h PacketHeader, d *pb.Data) {
	d.XeddsaSignature = nil
	d.XeddsaSignature = ed25519.Sign(k.EdPriv, SigningBuffer(h.From, h.ID, h.To, d))
}

// design §10.2 test 5: first-contact signed NodeInfo accepted only when self-consistent.
func TestFirstContactNodeInfo(t *testing.T) {
	k := testutil.NewXKey(1)
	h := PacketHeader{From: k.NodeNum(), ID: 42, To: 0xffffffff}
	d := nodeInfoData(t, k, k.X25519Pub)
	sign(k, h, d)
	v, err := Evaluate(h, d, k.X25519Pub, mapIDs{}, PolicyBalanced, false)
	if err != nil || v.Status != SigVerified || v.Promote == nil || !bytes.Equal(v.Promote.Curve, k.X25519Pub) {
		t.Fatalf("valid first contact: %+v %v", v, err)
	}

	// Spoof: attacker signs with own key but claims a victim's node number.
	victim := testutil.NewXKey(2).NodeNum()
	hs := PacketHeader{From: victim, ID: 43, To: 0xffffffff}
	ds := nodeInfoData(t, k, k.X25519Pub)
	sign(k, hs, ds)
	if _, err := Evaluate(hs, ds, k.X25519Pub, mapIDs{}, PolicyBalanced, false); !errors.Is(err, ErrFirstContactInvalid) {
		t.Fatalf("spoofed node number: %v", err)
	}

	// Key that does not match the signature.
	other := testutil.NewXKey(3)
	ho := PacketHeader{From: other.NodeNum(), ID: 44, To: 0xffffffff}
	do := nodeInfoData(t, other, other.X25519Pub)
	sign(k, ho, do)
	if _, err := Evaluate(ho, do, other.X25519Pub, mapIDs{}, PolicyBalanced, false); !errors.Is(err, ErrFirstContactInvalid) {
		t.Fatalf("wrong signer: %v", err)
	}
}

// design §10.2 test 4: known key, verified; one-byte mutation discarded.
func TestKnownKeyVerification(t *testing.T) {
	k := testutil.NewXKey(4)
	id, _ := NewIdentity(k.NodeNum(), k.X25519Pub)
	ids := mapIDs{k.NodeNum(): id}
	h := PacketHeader{From: k.NodeNum(), ID: 7, To: 0xffffffff}
	d := &pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: []byte{1, 2, 3, 4}}
	sign(k, h, d)
	if v, err := Evaluate(h, d, nil, ids, PolicyBalanced, false); err != nil || v.Status != SigVerified {
		t.Fatalf("valid: %+v %v", v, err)
	}
	d.Payload[2] ^= 1
	if _, err := Evaluate(h, d, nil, ids, PolicyBalanced, false); !errors.Is(err, ErrSigInvalid) {
		t.Fatalf("mutated payload: %v", err)
	}
	d.Payload[2] ^= 1
	d.XeddsaSignature[0] ^= 1
	if _, err := Evaluate(h, d, nil, ids, PolicyBalanced, false); !errors.Is(err, ErrSigInvalid) {
		t.Fatalf("mutated signature: %v", err)
	}
}

func TestSignedNodeInfoMustClaimSigningKey(t *testing.T) {
	k := testutil.NewXKey(5)
	id, _ := NewIdentity(k.NodeNum(), k.X25519Pub)
	ids := mapIDs{k.NodeNum(): id}
	h := PacketHeader{From: k.NodeNum(), ID: 8, To: 0xffffffff}
	other := testutil.NewXKey(6).X25519Pub
	d := nodeInfoData(t, k, other)
	sign(k, h, d)
	if _, err := Evaluate(h, d, other, ids, PolicyBalanced, false); !errors.Is(err, ErrNodeInfoKeyMismatch) {
		t.Fatalf("got %v", err)
	}
}

// design §10.2 test 6: unknown-key signatures never display as verified.
func TestUnknownKeyAndUnsigned(t *testing.T) {
	k := testutil.NewXKey(7)
	h := PacketHeader{From: k.NodeNum(), ID: 9, To: 0xffffffff}
	d := &pb.Data{Portnum: pb.PortNum_TELEMETRY_APP, Payload: []byte{1}}
	sign(k, h, d)
	if v, err := Evaluate(h, d, nil, mapIDs{}, PolicyBalanced, false); err != nil || v.Status != SigUnverifiable {
		t.Fatalf("unknown key: %+v %v", v, err)
	}
	if _, err := Evaluate(h, d, nil, mapIDs{}, PolicyStrict, false); !errors.Is(err, ErrStrictUnverifiable) {
		t.Fatalf("strict: %v", err)
	}
	// An AES-CCM channel's tag authenticates the packet: firmware never
	// applies Strict there (D-228).
	if v, err := Evaluate(h, d, nil, mapIDs{}, PolicyStrict, true); err != nil || v.Status != SigUnverifiable {
		t.Fatalf("strict on AES-CCM: %+v %v", v, err)
	}
	d.XeddsaSignature = nil
	if v, err := Evaluate(h, d, nil, mapIDs{}, PolicyStrict, false); err != nil || v.Status != SigUnsigned {
		t.Fatalf("unsigned: %+v %v", v, err)
	}
	d.XeddsaSignature = make([]byte, 63)
	if _, err := Evaluate(h, d, nil, mapIDs{}, PolicyBalanced, false); !errors.Is(err, ErrSigMalformed) {
		t.Fatalf("malformed: %v", err)
	}
}

func TestUnsignedNodeInfoCannotOverrideSigner(t *testing.T) {
	k := testutil.NewXKey(8)
	id, _ := NewIdentity(k.NodeNum(), k.X25519Pub)
	ids := mapIDs{k.NodeNum(): id}
	h := PacketHeader{From: k.NodeNum(), ID: 10, To: 0xffffffff}
	other := testutil.NewXKey(9).X25519Pub
	for _, aead := range []bool{false, true} {
		v, err := Evaluate(h, nodeInfoData(t, k, other), other, ids, PolicyBalanced, aead)
		if err != nil || v.Status != SigUnsigned || !v.IdentityUntrusted || !v.KeyConflict || v.Promote != nil {
			t.Fatalf("another key (aead %v): %+v %v", aead, v, err)
		}
		// No key at all: firmware drops it too ("Public Key mismatch").
		v, err = Evaluate(h, nodeInfoData(t, k, nil), nil, ids, PolicyBalanced, aead)
		if err != nil || v.Status != SigUnsigned || !v.IdentityUntrusted || v.KeyConflict || v.Promote != nil {
			t.Fatalf("no key (aead %v): %+v %v", aead, v, err)
		}
	}
}

// A signer's unsigned NodeInfo announcing its own key names it, as under
// firmware's default Compatible policy: 2.8.2 stopped signing there, and
// firmware before 2.8 strips signatures when it relays (D-228).
func TestUnsignedNodeInfoWithSignersKey(t *testing.T) {
	k := testutil.NewXKey(11)
	id, _ := NewIdentity(k.NodeNum(), k.X25519Pub)
	ids := mapIDs{k.NodeNum(): id}
	h := PacketHeader{From: k.NodeNum(), ID: 12, To: 0xffffffff}
	for _, p := range []Policy{PolicyBalanced, PolicyStrict} {
		v, err := Evaluate(h, nodeInfoData(t, k, k.X25519Pub), k.X25519Pub, ids, p, false)
		if err != nil || v.Status != SigUnsigned || v.IdentityUntrusted || v.KeyConflict || v.Promote != nil {
			t.Fatalf("policy %d: %+v %v", p, v, err)
		}
	}
}

// Firmware 2.8.0 signed another layout; such signatures are recognised as
// that, not as forgeries, and still kept out (D-229).
func TestSignedBy280(t *testing.T) {
	k := testutil.NewXKey(12)
	sign280 := func(h PacketHeader, d *pb.Data) {
		d.XeddsaSignature = nil
		d.XeddsaSignature = ed25519.Sign(k.EdPriv, LegacySigningBuffer(h.From, h.ID, d))
	}

	// First contact: its NodeInfo, the key deriving its node id.
	h := PacketHeader{From: k.NodeNum(), ID: 13, To: 0xffffffff}
	d := nodeInfoData(t, k, k.X25519Pub)
	sign280(h, d)
	if _, err := Evaluate(h, d, k.X25519Pub, mapIDs{}, PolicyBalanced, false); !errors.Is(err, ErrSig280) {
		t.Fatalf("first contact: %v", err)
	}
	// Under a key that does not derive the sender's id it proves nothing.
	victim := PacketHeader{From: testutil.NewXKey(13).NodeNum(), ID: 14, To: 0xffffffff}
	sign280(victim, d)
	if _, err := Evaluate(victim, d, k.X25519Pub, mapIDs{}, PolicyBalanced, false); !errors.Is(err, ErrFirstContactInvalid) {
		t.Fatalf("other node's id: %v", err)
	}

	// Known key.
	id, _ := NewIdentity(k.NodeNum(), k.X25519Pub)
	ids := mapIDs{k.NodeNum(): id}
	p := &pb.Data{Portnum: pb.PortNum_POSITION_APP, Payload: []byte{1, 2, 3, 4}}
	hp := PacketHeader{From: k.NodeNum(), ID: 15, To: 0xffffffff}
	sign280(hp, p)
	if _, err := Evaluate(hp, p, nil, ids, PolicyBalanced, false); !errors.Is(err, ErrSig280) {
		t.Fatalf("known key: %v", err)
	}
	// Altered in transit: a forgery, not 2.8.0.
	p.Payload[1] ^= 1
	if _, err := Evaluate(hp, p, nil, ids, PolicyBalanced, false); !errors.Is(err, ErrSigInvalid) {
		t.Fatalf("altered: %v", err)
	}
}

// design §10.2 test 7: traceroute signatures are never claimed verified.
func TestTracerouteExemption(t *testing.T) {
	k := testutil.NewXKey(10)
	id, _ := NewIdentity(k.NodeNum(), k.X25519Pub)
	h := PacketHeader{From: k.NodeNum(), ID: 11, To: 0x01020304}
	d := &pb.Data{Portnum: pb.PortNum_TRACEROUTE_APP, Payload: []byte{0x0d, 1, 2, 3, 4}}
	sign(k, h, d)
	d.Payload = append(d.Payload, 0x0d, 9, 9, 9, 9) // a hop appended itself
	for _, sig := range [][]byte{d.XeddsaSignature, nil, make([]byte, 5)} {
		d.XeddsaSignature = sig
		v, err := Evaluate(h, d, nil, mapIDs{k.NodeNum(): id}, PolicyStrict, false)
		if err != nil || v.Status != SigNotApplicable {
			t.Fatalf("traceroute: %+v %v", v, err)
		}
	}
}
