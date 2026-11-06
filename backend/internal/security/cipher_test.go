package security

import (
	"bytes"
	"encoding/hex"
	"errors"
	"testing"
)

func TestExpandPSKShorthand(t *testing.T) {
	k, err := ExpandPSK([]byte{1})
	if err != nil || !bytes.Equal(k, DefaultPSK[:]) {
		t.Fatalf("AQ== must expand to the default key, got %x %v", k, err)
	}
	k, _ = ExpandPSK([]byte{3})
	if k[15] != DefaultPSK[15]+2 || !bytes.Equal(k[:15], DefaultPSK[:15]) {
		t.Fatalf("shorthand 3: got %x", k)
	}
	if k, _ := ExpandPSK([]byte{0}); k != nil {
		t.Fatal("shorthand 0 must mean unencrypted")
	}
	if _, err := ExpandPSK(make([]byte, 7)); err == nil {
		t.Fatal("7-byte PSK must be rejected")
	}
}

func TestDecodePSKFormats(t *testing.T) {
	for _, s := range []string{"AQ==", "AQ", "hex:01"} {
		b, err := DecodePSK(s)
		if err != nil || !bytes.Equal(b, []byte{1}) {
			t.Errorf("%q: got %x %v", s, b, err)
		}
	}
}

func TestKeyStringHidesMaterial(t *testing.T) {
	k, err := NewKey("LongFast", "LongFast#0", "AQ==", ModeCTR)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{k.String(), k.GoString()} {
		if bytes.Contains([]byte(s), []byte(hex.EncodeToString(DefaultPSK[:]))) || bytes.Contains([]byte(s), DefaultPSK[:]) {
			t.Fatalf("key material leaked in %q", s)
		}
	}
}

// Firmware: LongFast with the default key has channel hash 8 (well known from
// MQTT traffic), and AEAD flips it with 0xAE.
func TestChannelHash(t *testing.T) {
	if h := ChannelHash("LongFast", DefaultPSK[:], ModeCTR); h != 8 {
		t.Fatalf("LongFast hash = %d, want 8", h)
	}
	if h := ChannelHash("LongFast", DefaultPSK[:], ModeCCM); h != 8^0xAE {
		t.Fatalf("AEAD hash = %d", h)
	}
}

func TestCTRRoundTrip(t *testing.T) {
	pt := bytes.Repeat([]byte{0x42}, 200)
	ct, err := EncryptCTR(DefaultPSK[:], 0x12345678, 0xdeadbeef, pt)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(ct, pt) {
		t.Fatal("no encryption happened")
	}
	got, _ := DecryptCTR(DefaultPSK[:], 0x12345678, 0xdeadbeef, ct)
	if !bytes.Equal(got, pt) {
		t.Fatal("round trip failed")
	}
	if wrong, _ := DecryptCTR(DefaultPSK[:], 0x12345679, 0xdeadbeef, ct); bytes.Equal(wrong, pt) {
		t.Fatal("nonce does not bind the sender")
	}
	if _, err := DecryptCTR(DefaultPSK[:], 1, 1, make([]byte, MaxCiphertext+1)); !errors.Is(err, ErrTooLarge) {
		t.Fatal("oversize ciphertext accepted")
	}
}

func TestCCMAuthenticates(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	pt := []byte("position payload")
	ct, err := EncryptCCM(key, 0xa1b2c3d4, 0xffffffff, 99, pt)
	if err != nil {
		t.Fatal(err)
	}
	if len(ct) != len(pt)+CCMTagSize {
		t.Fatalf("ciphertext length %d", len(ct))
	}
	got, err := DecryptCCM(key, 0xa1b2c3d4, 0xffffffff, 99, ct)
	if err != nil || !bytes.Equal(got, pt) {
		t.Fatalf("valid packet rejected: %v", err)
	}
	for i := range ct {
		m := bytes.Clone(ct)
		m[i] ^= 1
		if _, err := DecryptCCM(key, 0xa1b2c3d4, 0xffffffff, 99, m); !errors.Is(err, ErrAuthFailed) {
			t.Fatalf("flip at byte %d not rejected", i)
		}
	}
	if _, err := DecryptCCM(key, 0xa1b2c3d4, 0x00000001, 99, ct); !errors.Is(err, ErrAuthFailed) {
		t.Fatal("AAD (to) not authenticated")
	}
	if _, err := DecryptCCM(key, 0xa1b2c3d5, 0xffffffff, 99, ct); !errors.Is(err, ErrAuthFailed) {
		t.Fatal("from not authenticated")
	}
}

// RFC 3610 Packet Vector #1 (13-byte nonce, L=2, 8-byte AAD, M=8) proves the
// CCM library implements standard CCM with the firmware's L=2 framing.
func TestCCMRFC3610Vector1(t *testing.T) {
	mustHex := func(s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	key := mustHex("c0c1c2c3c4c5c6c7c8c9cacbcccdcecf")
	nonce := mustHex("00000003020100a0a1a2a3a4a5")
	aad := mustHex("0001020304050607")
	pt := mustHex("08090a0b0c0d0e0f101112131415161718191a1b1c1d1e")
	want := mustHex("588c979a61c663d2f066d0c2c0f989806d5f6b61dac384" + "17e8d12cfdf926e0")
	block, _ := aesNewCipher(key)
	c, err := ccmNew(block, 8, 13)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Seal(nil, nonce, pt, aad); !bytes.Equal(got, want) {
		t.Fatalf("RFC 3610 #1 mismatch\n got %x\nwant %x", got, want)
	}
}
