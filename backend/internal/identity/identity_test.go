package identity

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"hash/crc32"
	"log/slog"
	"testing"
	"time"

	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
)

// key makes an X25519 key and the node number it binds.
func key(t *testing.T) (uint32, []byte) {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pk := k.PublicKey().Bytes()
	return crc32.ChecksumIEEE(pk), pk
}

func identity(t *testing.T, n uint32, pk []byte) security.Identity {
	t.Helper()
	id, err := security.NewIdentity(n, pk)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// A promotion that commits while the load query runs is missing from its
// rows but kept; an old promotion whose row is gone (retention) is dropped.
func TestReloadKeepsPromotionsDuringLoad(t *testing.T) {
	a, pkA := key(t)
	b, pkB := key(t)
	old, pkOld := key(t)
	var s *Store
	s = New(func(context.Context) ([]storage.IdentityRow, error) {
		s.Promote(identity(t, b, pkB)) // commits after the query started
		return []storage.IdentityRow{{Node: a, PublicKey: base64.StdEncoding.EncodeToString(pkA), Since: time.Now(), RowID: 1}}, nil
	}, slog.Default())
	s.Promote(identity(t, old, pkOld))
	s.promoted[old] = time.Now().Add(-2 * time.Minute)
	if err := s.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Lookup(a); !ok {
		t.Error("loaded identity missing")
	}
	if _, ok := s.Lookup(b); !ok {
		t.Error("promotion during the load forgotten")
	}
	if _, ok := s.Lookup(old); ok {
		t.Error("old promotion without a row kept")
	}
	if s.Len() != 2 {
		t.Errorf("%d identities, want 2", s.Len())
	}
}
