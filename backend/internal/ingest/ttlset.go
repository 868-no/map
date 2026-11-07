package ingest

import (
	"slices"
	"sync"
	"time"
)

// recentEntry is a committed observation: its packet_log row id and the
// brokers known to have delivered it (first broker plus also_via).
type recentEntry struct {
	at      time.Time
	id      int64
	brokers []string
}

// ttlSet is a bounded in-process index of recently committed observation
// keys. It backs up Redis for dedupe and lets late duplicates from another
// broker be attached to the existing row by primary key.
type ttlSet struct {
	mu    sync.Mutex
	ttl   time.Duration
	max   int
	items map[[16]byte]*recentEntry
	// order is insertion order for eviction, one entry per item. Evicting
	// reslices it from the front, which shrinks its capacity too, so the
	// next append that outgrows it copies the live entries to a new array:
	// it never holds more than about twice max.
	order [][16]byte
	// whole is when the set holds every observation committed within the
	// TTL: one TTL after it was made (earlier rows came from another
	// process), and one TTL after the newest entry evicted for room.
	whole time.Time
}

func newTTLSet(ttl time.Duration, max int) *ttlSet {
	return &ttlSet{ttl: ttl, max: max, items: make(map[[16]byte]*recentEntry, max), whole: time.Now().Add(ttl)}
}

// complete reports whether a key the set lacks was not committed within
// the TTL by this process, nor by one before it.
func (s *ttlSet) complete(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !now.Before(s.whole)
}

// get returns the row id of a recent observation.
func (s *ttlSet) get(k [16]byte, now time.Time) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.items[k]
	if !ok || now.Sub(e.at) >= s.ttl {
		return 0, false
	}
	return e.id, true
}

// addBroker records that broker delivered k; it reports whether the broker
// is new for this observation (and therefore needs a provenance update).
func (s *ttlSet) addBroker(k [16]byte, broker string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.items[k]
	if !ok {
		return true // unknown here (e.g. found via Redis/DB): let SQL decide
	}
	if slices.Contains(e.brokers, broker) {
		return false
	}
	e.brokers = append(e.brokers, broker)
	return true
}

func (s *ttlSet) add(k [16]byte, id int64, brokers []string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.items[k]; !ok {
		s.order = append(s.order, k)
	}
	s.items[k] = &recentEntry{at: now, id: id, brokers: brokers}
	for len(s.order) > 0 && (len(s.items) > s.max || now.Sub(s.items[s.order[0]].at) >= s.ttl) {
		old := s.items[s.order[0]]
		if until := old.at.Add(s.ttl); until.After(now) && until.After(s.whole) {
			s.whole = until // evicted for room while still within the TTL
		}
		delete(s.items, s.order[0])
		s.order = s.order[1:]
	}
}
