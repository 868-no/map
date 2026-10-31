package security

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"github.com/868-no/map/internal/protocol/pb"
	"github.com/868-no/map/internal/testutil"
)

// Gate 1: the Montgomery->Edwards conversion must agree byte-for-byte with
// two unrelated implementations (stdlib Ed25519 and x/crypto X25519).
func TestConvertX25519MatchesIndependentDerivation(t *testing.T) {
	checked := 0
	for checked < 1000 {
		seed := make([]byte, ed25519.SeedSize)
		if _, err := rand.Read(seed); err != nil {
			t.Fatal(err)
		}
		k, ok := testutil.DeriveXKey(seed)
		if !ok {
			// Sign-bit-1 keys convert to the negated point; must not match.
			got, err := ConvertX25519PublicKey(k.X25519Pub)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Equal(got, k.EdPub) {
				t.Fatalf("sign-bit-1 key unexpectedly matched")
			}
			if !bytes.Equal(got[:31], k.EdPub[:31]) || got[31] != k.EdPub[31]&0x7f {
				t.Fatalf("sign-bit-1 key differs in more than the sign bit")
			}
			continue
		}
		got, err := ConvertX25519PublicKey(k.X25519Pub)
		if err != nil {
			t.Fatalf("convert: %v", err)
		}
		if !bytes.Equal(got, k.EdPub) {
			t.Fatalf("conversion mismatch\n got %x\nwant %x", got, k.EdPub)
		}
		checked++
	}
}

func TestConvertRejectsInvalid(t *testing.T) {
	minusOne := make([]byte, 32) // p-1 = 2^255-20, little-endian
	for i := range minusOne {
		minusOne[i] = 0xff
	}
	minusOne[0] = 0xec
	minusOne[31] = 0x7f
	nonCanonical := make([]byte, 32) // p = 2^255-19
	copy(nonCanonical, minusOne)
	nonCanonical[0] = 0xed
	for name, u := range map[string][]byte{"short": make([]byte, 31), "u=-1": minusOne, "u=p": nonCanonical} {
		if _, err := ConvertX25519PublicKey(u); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func signedData(t *testing.T, k testutil.XKey, from, id, to uint32, d *pb.Data) []byte {
	t.Helper()
	return ed25519.Sign(k.EdPriv, SigningBuffer(from, id, to, d))
}

// Gate 2: round trip through the production verify path plus mutations.
func TestXEdDSARoundTripAndMutations(t *testing.T) {
	bf := uint32(1)
	for i := uint64(0); i < 50; i++ {
		k := testutil.NewXKey(i)
		from, id, to := k.NodeNum(), uint32(0x1000+i), uint32(0xffffffff)
		d := &pb.Data{
			Portnum:      pb.PortNum_POSITION_APP,
			Payload:      []byte{0x0d, 0x01, 0x02, 0x03, 0x04, byte(i)},
			WantResponse: i%2 == 0,
			RequestId:    uint32(i * 7),
			ReplyId:      uint32(i * 11),
			Emoji:        uint32(i % 3),
		}
		if i%3 == 0 {
			d.Bitfield = &bf
		}
		sig := signedData(t, k, from, id, to, d)
		if !VerifyXEdDSA(k.X25519Pub, from, id, to, d, sig) {
			t.Fatalf("key %d: valid signature rejected", i)
		}

		mutants := map[string]func() bool{
			"from": func() bool { return VerifyXEdDSA(k.X25519Pub, from^1, id, to, d, sig) },
			"id":   func() bool { return VerifyXEdDSA(k.X25519Pub, from, id^1, to, d, sig) },
			"to":   func() bool { return VerifyXEdDSA(k.X25519Pub, from, id, to^1, d, sig) },
			"portnum": func() bool {
				m := cloneData(d)
				m.Portnum = pb.PortNum_TEXT_MESSAGE_APP
				return VerifyXEdDSA(k.X25519Pub, from, id, to, m, sig)
			},
			"request": func() bool {
				m := cloneData(d)
				m.RequestId ^= 1
				return VerifyXEdDSA(k.X25519Pub, from, id, to, m, sig)
			},
			"reply": func() bool { m := cloneData(d); m.ReplyId ^= 1; return VerifyXEdDSA(k.X25519Pub, from, id, to, m, sig) },
			"emoji": func() bool { m := cloneData(d); m.Emoji ^= 1; return VerifyXEdDSA(k.X25519Pub, from, id, to, m, sig) },
			"wantrsp": func() bool {
				m := cloneData(d)
				m.WantResponse = !m.WantResponse
				return VerifyXEdDSA(k.X25519Pub, from, id, to, m, sig)
			},
			"bitfield": func() bool {
				m := cloneData(d)
				if m.Bitfield == nil {
					z := uint32(0)
					m.Bitfield = &z // present-but-zero must differ from absent
				} else {
					m.Bitfield = nil
				}
				return VerifyXEdDSA(k.X25519Pub, from, id, to, m, sig)
			},
			"payload": func() bool {
				m := cloneData(d)
				m.Payload[len(m.Payload)-1] ^= 1
				return VerifyXEdDSA(k.X25519Pub, from, id, to, m, sig)
			},
			"truncate": func() bool {
				m := cloneData(d)
				m.Payload = m.Payload[:len(m.Payload)-1]
				return VerifyXEdDSA(k.X25519Pub, from, id, to, m, sig)
			},
			"sig":      func() bool { s := bytes.Clone(sig); s[5] ^= 0x20; return VerifyXEdDSA(k.X25519Pub, from, id, to, d, s) },
			"sigshort": func() bool { return VerifyXEdDSA(k.X25519Pub, from, id, to, d, sig[:63]) },
			"otherkey": func() bool { return VerifyXEdDSA(testutil.NewXKey(i+1000).X25519Pub, from, id, to, d, sig) },
		}
		for name, f := range mutants {
			if f() {
				t.Fatalf("key %d: mutation %q verified", i, name)
			}
		}
	}
}

// A key whose Ed25519 form has sign bit 1 must not verify: XEdDSA signers
// negate such keys, so a signature by the un-negated key is not valid XEdDSA.
func TestXEdDSASignBitOneFails(t *testing.T) {
	for n := 0; n < 20; {
		seed := make([]byte, ed25519.SeedSize)
		_, _ = rand.Read(seed)
		k, ok := testutil.DeriveXKey(seed)
		if ok {
			continue
		}
		n++
		d := &pb.Data{Portnum: pb.PortNum_NODEINFO_APP, Payload: []byte("x")}
		sig := ed25519.Sign(k.EdPriv, SigningBuffer(1, 2, 3, d))
		if VerifyXEdDSA(k.X25519Pub, 1, 2, 3, d, sig) {
			t.Fatal("sign-bit-1 signature verified")
		}
	}
}

func cloneData(d *pb.Data) *pb.Data {
	m := &pb.Data{
		Portnum: d.Portnum, Payload: bytes.Clone(d.Payload), WantResponse: d.WantResponse,
		RequestId: d.RequestId, ReplyId: d.ReplyId, Emoji: d.Emoji,
	}
	if d.Bitfield != nil {
		v := *d.Bitfield
		m.Bitfield = &v
	}
	return m
}
