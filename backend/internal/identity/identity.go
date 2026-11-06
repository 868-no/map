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

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/security"
	"github.com/868-no/map/internal/storage"
)

// Loader fetches the verified bindings among rows with an id above `after`
// (0: all; storage.VerifiedIdentities in production), and the highest row
// id stored when it began.
type Loader func(ctx context.Context, after int64) (rows []storage.IdentityRow, maxID int64, err error)

// StorageLoader is the production Loader.
func StorageLoader(pool *pgxpool.Pool) Loader {
	return func(ctx context.Context, after int64) ([]storage.IdentityRow, int64, error) {
		maxID, err := storage.MaxRowID(ctx, pool)
		if err != nil {
			return nil, 0, err
		}
		rows, err := storage.VerifiedIdentities(ctx, pool, nil, after)
		return rows, maxID, err
	}
}

// Store implements security.IdentityLookup.
type Store struct {
	mu   sync.RWMutex
	byID map[uint32]security.Identity
	// promoted records local commit time of recent promotions, so a reload
	// racing with a commit does not forget them.
	promoted map[uint32]time.Time
	load     Loader
	log      *slog.Logger
	// The highest row id when the last read began, and when the one before
	// it began: a top-up reads from the older, so a row whose id was taken
	// but not yet committed at the last read is still read.
	seen, older int64
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
// dropping identities whose rows retention has deleted.
func (s *Store) Reload(ctx context.Context) error {
	start := time.Now()
	rows, maxID, err := s.load(ctx, 0)
	if err != nil {
		return err
	}
	next := make(map[uint32]security.Identity, len(rows))
	s.convert(rows, func(id security.Identity) { next[id.Node] = id })
	s.mu.Lock()
	s.seen, s.older = maxID, maxID
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

// convert turns stored bindings into identities. Rows that fail conversion
// are skipped (they were verified at ingest, so this indicates corruption)
// and logged.
func (s *Store) convert(rows []storage.IdentityRow, add func(security.Identity)) {
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
		add(id)
	}
}

// Refresh adds the bindings stored since the read before last for nodes
// not yet known. Ids come from a sequence, so a newer row never displaces
// a node's first binding (TOFU), and the read is an index range over the
// newest rows instead of the whole log. Deletions (retention) and an
// import's older history wait for Reload.
func (s *Store) Refresh(ctx context.Context) error {
	s.mu.RLock()
	after := s.older
	s.mu.RUnlock()
	rows, maxID, err := s.load(ctx, after)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.convert(rows, func(id security.Identity) {
		if _, ok := s.byID[id.Node]; !ok {
			s.byID[id.Node] = id
		}
	})
	s.older, s.seen = s.seen, maxID
	return nil
}

// Run tops the index up every interval (Refresh) and reloads it whenever
// trigger fires (retention events, which delete rows).
func (s *Store) Run(ctx context.Context, every time.Duration, trigger <-chan struct{}) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		var err error
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			err = s.Refresh(ctx)
		case <-trigger:
			err = s.Reload(ctx)
		}
		if err != nil && ctx.Err() == nil {
			s.log.Warn("identity reload failed", "err", err)
		}
	}
}
