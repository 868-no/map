// Package testutil holds Go-only fixture builders shared by tests and the demo
// simulator. Key derivation here deliberately avoids the code under test
// (security.ConvertX25519PublicKey) so it can serve as an independent check.
package testutil

import (
	"crypto/ed25519"
	"crypto/sha512"
	"hash/crc32"

	"golang.org/x/crypto/curve25519"
)

// XKey is a node key pair usable for XEdDSA: the X25519 public key a
// Meshtastic node announces, plus the Ed25519 key that signs for it.
type XKey struct {
	Seed      []byte             // Ed25519 seed
	EdPriv    ed25519.PrivateKey // stdlib signing key
	EdPub     ed25519.PublicKey  // computed by stdlib Ed25519 scalar mult
	X25519Pub []byte             // computed by x/crypto X25519 scalar mult
}

// NodeNum is the node number a firmware 2.8 node derives from its key and
// that first-contact verification requires: CRC-32 (IEEE) of the public key.
func (k XKey) NodeNum() uint32 { return crc32.ChecksumIEEE(k.X25519Pub) }

// DeriveXKey derives both public keys from one Ed25519 seed. The Ed25519
// secret scalar is the clamped low half of SHA-512(seed); multiplying the
// Montgomery base point by the same scalar yields the matching X25519 key.
// ok is false when the Ed25519 public key has sign bit 1: XEdDSA signers
// always use the sign-bit-0 form, so such seeds cannot be used directly.
func DeriveXKey(seed []byte) (k XKey, ok bool) {
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	h := sha512.Sum512(seed)
	scalar := h[:32]
	scalar[0] &= 248
	scalar[31] &= 127
	scalar[31] |= 64
	xpub, err := curve25519.X25519(scalar, curve25519.Basepoint)
	if err != nil {
		return XKey{}, false
	}
	k = XKey{Seed: append([]byte(nil), seed...), EdPriv: priv, EdPub: pub, X25519Pub: xpub}
	return k, pub[31]&0x80 == 0
}

// NewXKey deterministically derives a usable (sign-bit-0) key from an index,
// for reproducible fixtures and demo nodes.
func NewXKey(index uint64) XKey {
	for ctr := uint64(0); ; ctr++ {
		var in [16]byte
		for i := 0; i < 8; i++ {
			in[i] = byte(index >> (8 * i))
			in[8+i] = byte(ctr >> (8 * i))
		}
		h := sha512.Sum512(append([]byte("meshmap-fixture-key"), in[:]...))
		if k, ok := DeriveXKey(h[:32]); ok {
			return k
		}
	}
}
