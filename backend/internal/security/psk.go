// Package security implements Meshtastic channel decryption (AES-CTR and
// AES-CCM AEAD), XEdDSA packet-signature verification and the identity rules
// that decide which node public keys are authoritative.
//
// Behaviour mirrors meshtastic/firmware src/mesh/CryptoEngine.cpp,
// Channels.cpp and Router.cpp; see docs/protocol-compatibility.md for the
// verified upstream revision.
package security

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// DefaultPSK is Meshtastic's well-known default channel key (firmware
// Channels.cpp defaultpsk), selected by the one-byte PSK shorthand 0x01.
var DefaultPSK = [16]byte{
	0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59,
	0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01,
}

// Mode is the channel encryption mode.
type Mode uint8

const (
	ModeCTR Mode = iota // legacy AES-CTR, no authentication tag
	ModeCCM             // firmware 2.8.1+ channel AEAD (use_aead)
)

func (m Mode) String() string {
	if m == ModeCCM {
		return "ccm"
	}
	return "ctr"
}

// ParseMode accepts "ctr" or "ccm".
func ParseMode(s string) (Mode, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "ctr":
		return ModeCTR, nil
	case "ccm", "aead":
		return ModeCCM, nil
	}
	return 0, fmt.Errorf("unknown channel mode %q (want ctr or ccm)", s)
}

// Key is a resolved channel key. Its String method never reveals key bytes.
type Key struct {
	Channel string
	Label   string // operator-facing identifier, e.g. "LongFast#0"
	Mode    Mode
	bytes   []byte // nil means the channel is unencrypted (shorthand 0x00)
	hash    uint8
}

// Bytes returns the raw key material. Callers must never log or persist it.
func (k Key) Bytes() []byte { return k.bytes }

// Unencrypted reports whether the PSK shorthand selected "no encryption".
func (k Key) Unencrypted() bool { return k.bytes == nil }

func (k Key) String() string { return fmt.Sprintf("key(%s,%s)", k.Label, k.Mode) }

// GoString keeps %#v from printing key material.
func (k Key) GoString() string { return k.String() }

var errPSKLength = errors.New("PSK must decode to 0, 1, 16 or 32 bytes")

// DecodePSK decodes a PSK string. Base64 (standard or URL alphabet, padding
// optional) is the default; a "hex:" prefix selects hexadecimal.
func DecodePSK(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if rest, ok := strings.CutPrefix(s, "hex:"); ok {
		b, err := hex.DecodeString(rest)
		if err != nil {
			return nil, fmt.Errorf("invalid hex PSK: %w", err)
		}
		return b, nil
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("invalid base64 PSK")
}

// ExpandPSK applies firmware Channels::getKey semantics: a one-byte PSK is an
// index into well-known keys (0 = no crypto, 1 = default key, n = default key
// with the last byte incremented by n-1); 16 and 32 bytes select AES-128/256.
// It returns nil for "no encryption".
func ExpandPSK(raw []byte) ([]byte, error) {
	switch len(raw) {
	case 0:
		return nil, nil
	case 1:
		if raw[0] == 0 {
			return nil, nil
		}
		k := DefaultPSK
		k[len(k)-1] += raw[0] - 1
		return k[:], nil
	case 16, 32:
		return append([]byte(nil), raw...), nil
	}
	return nil, errPSKLength
}

func xorHash(b []byte) uint8 {
	var h uint8
	for _, c := range b {
		h ^= c
	}
	return h
}

// ChannelHash mirrors firmware Channels::hashFor: XOR of the channel name
// bytes, XOR of the expanded key bytes, and 0xAE for AEAD channels.
func ChannelHash(name string, key []byte, mode Mode) uint8 {
	h := xorHash([]byte(name)) ^ xorHash(key)
	if mode == ModeCCM {
		h ^= 0xAE
	}
	return h
}

// NewKey builds a Key from a channel name, an encoded PSK and a mode.
func NewKey(channel, label, psk string, mode Mode) (Key, error) {
	raw, err := DecodePSK(psk)
	if err != nil {
		return Key{}, fmt.Errorf("channel %q (%s): %w", channel, label, err)
	}
	k, err := ExpandPSK(raw)
	if err != nil {
		return Key{}, fmt.Errorf("channel %q (%s): %w", channel, label, err)
	}
	if k == nil && mode == ModeCCM {
		return Key{}, fmt.Errorf("channel %q (%s): AEAD requires a non-empty PSK", channel, label)
	}
	return Key{Channel: channel, Label: label, Mode: mode, bytes: k, hash: ChannelHash(channel, k, mode)}, nil
}
