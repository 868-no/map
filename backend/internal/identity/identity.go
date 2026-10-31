// Package identity is the ingestion-side index of authoritative node keys.
// It is ephemeral: rebuilt from verified NodeInfo rows in packet_log at
// startup and periodically, so no second durable identity store exists.
// It is used for signature verification only, never to fill historical views.
package identity

import (
	"context"
	"encoding/base64"
	"log/slog"
	"sync"
	"time"

	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
)

// Loader fetches verified bindings (storage.VerifiedIdentities in production).
type Loader func(ctx context.Context) ([]storage.IdentityRow, error)

// Store implements security.IdentityLookup.
type Store struct {
	mu   sync.RWMutex
	byID map[uint32]security.Identity
	// promoted records local commit time of recent promotions, so a reload
	// racing with a commit does not forget them.
	promoted map[uint32]time.Time
	load     Loader
	log      *slog.Logger
}

// New returns an empty store; call Reload before ingesting.
func New(load Loader, log *slog.Logger) *Store {
	return &Store{byID: map[uint32]security.Identity{}, promoted: map[uint32]time.Time{}, load: load, log: log}
}

// Lookup returns the authoritative identity for a node.
func (s *Store) Lookup(n uint32) (security.Identity, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.byID[n]
	return id, ok
}

// Len is the number of known identities.
func (s *Store) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.byID)
}

// Promote records a binding whose row has committed. First binding wins
// (TOFU): an existing authoritative key is never replaced here.
func (s *Store) Promote(id security.Identity) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.byID[id.Node]; ok {
		return false
	}
	s.byID[id.Node] = id
	s.promoted[id.Node] = time.Now()
	return true
}

// Reload replaces the index with the bindings still present in packet_log,
// dropping identities whose rows retention has deleted. Rows that fail
// conversion are skipped (they were verified at ingest, so this indicates
// corruption) and logged.
func (s *Store) Reload(ctx context.Context) error {
	start := time.Now()
	rows, err := s.load(ctx)
	if err != nil {
		return err
	}
	next := make(map[uint32]security.Identity, len(rows))
	for _, r := range rows {
		pk, err := base64.StdEncoding.DecodeString(r.PublicKey)
		if err != nil || !security.KeyBindsNode(pk, r.Node) {
			s.log.Warn("skipping invalid stored identity", "node", r.Node, "row", r.RowID)
			continue
		}
		id, err := security.NewIdentity(r.Node, pk)
		if err != nil {
			continue
		}
		id.Since, id.RowID = r.Since, r.RowID
		next[r.Node] = id
	}
	s.mu.Lock()
	// Keep promotions that committed after the load query started.
	for n, at := range s.promoted {
		if at.Before(start.Add(-time.Minute)) {
			delete(s.promoted, n)
			continue
		}
		if _, ok := next[n]; !ok {
			if id, ok := s.byID[n]; ok {
				next[n] = id
			}
		}
	}
	s.byID = next
	s.mu.Unlock()
	return nil
}

// Run reloads every interval and whenever trigger fires (retention events).
func (s *Store) Run(ctx context.Context, every time.Duration, trigger <-chan struct{}) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-trigger:
		}
		if err := s.Reload(ctx); err != nil && ctx.Err() == nil {
			s.log.Warn("identity reload failed", "err", err)
		}
	}
}
