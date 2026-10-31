package security

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"errors"

	"github.com/pion/dtls/v3/pkg/crypto/ccm"
)

// MaxCiphertext bounds the encrypted payload we will attempt to decrypt
// (firmware MAX_BLOCKSIZE is 256).
const MaxCiphertext = 256

// CCMTagSize is firmware CryptoEngine::AEAD_TAG_SIZE.
const CCMTagSize = 12

// ccmNonceSize follows from the firmware's hostap-derived CCM with fixed L=2:
// it copies the first 15-L = 13 bytes of the 16-byte packet nonce.
const ccmNonceSize = 13

var (
	ErrTooLarge   = errors.New("ciphertext exceeds maximum block size")
	ErrAuthFailed = errors.New("AEAD authentication failed")
	ErrShort      = errors.New("ciphertext shorter than AEAD tag")
)

// packetNonce mirrors CryptoEngine::initNonce for channel traffic (extraNonce
// is only used for PKI): LE64(packetId) || LE32(fromNode) || 0x00000000.
func packetNonce(from, packetID uint32) [16]byte {
	var n [16]byte
	binary.LittleEndian.PutUint64(n[0:8], uint64(packetID))
	binary.LittleEndian.PutUint32(n[8:12], from)
	return n
}

// DecryptCTR decrypts a channel packet with AES-CTR. CTR has no integrity
// protection: a successful call proves nothing about authenticity.
//
// Firmware uses a 4-byte big-endian counter in the last nonce bytes; Go's CTR
// increments the whole block big-endian. They agree because those bytes start
// at zero and a 256-byte payload needs at most 16 blocks.
func DecryptCTR(key []byte, from, packetID uint32, ct []byte) ([]byte, error) {
	if len(ct) > MaxCiphertext {
		return nil, ErrTooLarge
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	n := packetNonce(from, packetID)
	out := make([]byte, len(ct))
	cipher.NewCTR(block, n[:]).XORKeyStream(out, ct)
	return out, nil
}

// EncryptCTR is the inverse of DecryptCTR, used by the demo simulator and tests.
func EncryptCTR(key []byte, from, packetID uint32, pt []byte) ([]byte, error) {
	return DecryptCTR(key, from, packetID, pt)
}

func newCCM(key []byte) (ccm.CCM, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return ccm.NewCCM(block, CCMTagSize, ccmNonceSize)
}

// ccmAAD mirrors firmware initAad: LE32(from) || LE32(to).
func ccmAAD(from, to uint32) []byte {
	aad := make([]byte, 8)
	binary.LittleEndian.PutUint32(aad[0:4], from)
	binary.LittleEndian.PutUint32(aad[4:8], to)
	return aad
}

// DecryptCCM authenticates and decrypts a firmware 2.8.1+ AEAD channel packet
// laid out as ciphertext || 12-byte tag. Any tag mismatch is ErrAuthFailed.
func DecryptCCM(key []byte, from, to, packetID uint32, ctWithTag []byte) ([]byte, error) {
	if len(ctWithTag) > MaxCiphertext+CCMTagSize {
		return nil, ErrTooLarge
	}
	if len(ctWithTag) <= CCMTagSize {
		return nil, ErrShort
	}
	c, err := newCCM(key)
	if err != nil {
		return nil, err
	}
	n := packetNonce(from, packetID)
	pt, err := c.Open(nil, n[:ccmNonceSize], ctWithTag, ccmAAD(from, to))
	if err != nil {
		return nil, ErrAuthFailed
	}
	return pt, nil
}

// EncryptCCM produces ciphertext || tag; used by the demo simulator and tests.
func EncryptCCM(key []byte, from, to, packetID uint32, pt []byte) ([]byte, error) {
	if len(pt) > MaxCiphertext {
		return nil, ErrTooLarge
	}
	c, err := newCCM(key)
	if err != nil {
		return nil, err
	}
	n := packetNonce(from, packetID)
	return c.Seal(nil, n[:ccmNonceSize], pt, ccmAAD(from, to)), nil
}
