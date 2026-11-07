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
	s = New(func(context.Context, int64) ([]storage.IdentityRow, int64, error) {
		s.Promote(identity(t, b, pkB)) // commits after the query started
		return []storage.IdentityRow{{Node: a, PublicKey: base64.StdEncoding.EncodeToString(pkA), Since: time.Now(), RowID: 1}}, 1, nil
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

// A top-up reads from the read before last, adds nodes not yet known and
// never replaces a known node's first binding.
func TestRefreshAddsOnlyNewNodes(t *testing.T) {
	a, pkA := key(t)
	b, pkB := key(t)
	_, pkOther := key(t)
	enc := base64.StdEncoding.EncodeToString
	var afters []int64
	rows := []storage.IdentityRow{{Node: a, PublicKey: enc(pkA), RowID: 5}}
	maxID := int64(10)
	s := New(func(_ context.Context, after int64) ([]storage.IdentityRow, int64, error) {
		afters = append(afters, after)
		return rows, maxID, nil
	}, slog.Default())
	if err := s.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Later rows: a new node b, and a different key claimed for a (which
	// could not bind a's number anyway, but must not be looked at).
	rows = []storage.IdentityRow{{Node: b, PublicKey: enc(pkB), RowID: 12}, {Node: a, PublicKey: enc(pkOther), RowID: 13}}
	maxID = 20
	for range 2 {
		if err := s.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if got, ok := s.Lookup(a); !ok || got.RowID != 5 {
		t.Errorf("a: %+v %v", got, ok)
	}
	if _, ok := s.Lookup(b); !ok {
		t.Error("b not added")
	}
	if want := []int64{0, 10, 10}; len(afters) != 3 || afters[0] != want[0] || afters[1] != want[1] || afters[2] != want[2] {
		t.Errorf("reads after %v, want %v", afters, want)
	}
}

// Without retention notices (no Redis), the index still reloads fully now
// and then; between full reloads it is only topped up.
func TestRunReloadsFullyEveryFullEveryTicks(t *testing.T) {
	var full, top int // touched by the loader only (Run's goroutine)
	counts := make(chan [2]int, 1)
	running := false
	s := New(func(_ context.Context, after int64) ([]storage.IdentityRow, int64, error) {
		if !running {
			return nil, 1, nil // the startup reload
		}
		if after == 0 {
			full++
		} else {
			top++
		}
		if full+top == FullEvery {
			counts <- [2]int{full, top}
		}
		return nil, 1, nil
	}, slog.Default())
	if err := s.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	running = true
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx, time.Millisecond, nil)
	if c := <-counts; c != [2]int{1, FullEvery - 1} {
		t.Fatalf("%d full reloads and %d top-ups in %d ticks", c[0], c[1], FullEvery)
	}
}
