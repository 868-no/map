// Package upstream holds what the terrain and weather clients share in
// front of their rate-limited APIs (D-141, D-147): a queue of keys to fetch
// that serves visitors in turn before background work, and a bounded
// in-memory cache. Neither is safe for concurrent use: callers hold their
// own lock around every call.
package upstream

// State is where a key waits in a Queue.
type State uint8

const (
	None       State = iota // not queued
	Background              // queued by background work
	Urgent                  // queued for a visitor (possibly in background too)
)

// Queue holds keys to fetch: visitors' first, one key from each in turn,
// then background keys in order. A key may wait in both queues; its State
// is the furthest forward, and the worker skips whichever copy it pops
// second (Pop's caller checks State, and Done forgets the key).
type Queue[K comparable] struct {
	maxPerClient, maxUrgent, maxBackground int

	urgent     map[string][]K // per visitor, in asking order
	turns      []string       // visitors with keys waiting, next first
	nUrgent    int            // keys in urgent
	background []K
	inBack     map[K]struct{} // keys with a copy in background
	state      map[K]State
}

// NewQueue makes a queue holding at most maxPerClient keys per visitor and
// maxUrgent across visitors; maxBackground bounds the background queue (0:
// unbounded).
func NewQueue[K comparable](maxPerClient, maxUrgent, maxBackground int) *Queue[K] {
	return &Queue[K]{maxPerClient: maxPerClient, maxUrgent: maxUrgent, maxBackground: maxBackground,
		urgent: map[string][]K{}, inBack: map[K]struct{}{}, state: map[K]State{}}
}

// State is where k waits.
func (q *Queue[K]) State(k K) State { return q.state[k] }

// PushUrgent queues k for a visitor, unless it already waits for one or the
// visitor may queue no more (room). It reports whether k was queued.
func (q *Queue[K]) PushUrgent(client string, k K) bool {
	if q.state[k] == Urgent || !q.room(client) {
		return false
	}
	if len(q.urgent[client]) == 0 {
		q.turns = append(q.turns, client)
	}
	q.urgent[client] = append(q.urgent[client], k)
	q.nUrgent++
	q.state[k] = Urgent
	return true
}

// PushBackground queues k behind every visitor's, unless it waits already
// or the background queue is full. It reports whether k was queued.
func (q *Queue[K]) PushBackground(k K) bool {
	if q.state[k] != None || (q.maxBackground > 0 && len(q.background) >= q.maxBackground) {
		return false
	}
	q.background = append(q.background, k)
	q.inBack[k] = struct{}{}
	q.state[k] = Background
	return true
}

// room reports whether a visitor may queue another key: it holds fewer
// than maxPerClient, and the visitors' queue has room, or makes room by
// taking the last key of the visitor holding the most, when that one holds
// at least two more (D-141).
func (q *Queue[K]) room(client string) bool {
	mine := len(q.urgent[client])
	if mine >= q.maxPerClient {
		return false
	}
	if q.nUrgent < q.maxUrgent {
		return true
	}
	big, n := "", 0
	for id, ks := range q.urgent {
		if len(ks) > n {
			big, n = id, len(ks)
		}
	}
	if n < mine+2 {
		return false
	}
	k := q.urgent[big][n-1]
	q.urgent[big] = q.urgent[big][:n-1] // n ≥ 2: never emptied, so still in turns
	q.nUrgent--
	if q.state[k] == Urgent {
		// It still waits where background work put it, if it did.
		if _, ok := q.inBack[k]; ok {
			q.state[k] = Background
		} else {
			delete(q.state, k)
		}
	}
	return true
}

// Pop takes the next key: the oldest of the next visitor in turn (who goes
// to the back of the line), else the oldest background key. A popped key
// keeps its State until Done; one whose State is None was dropped (room)
// or done through its other copy, and is to be skipped.
func (q *Queue[K]) Pop() (k K, ok bool) {
	switch {
	case q.nUrgent > 0:
		id := q.turns[0]
		ks := q.urgent[id]
		k, ks = ks[0], ks[1:]
		q.nUrgent--
		q.turns = q.turns[1:]
		if len(ks) == 0 {
			delete(q.urgent, id)
		} else {
			q.urgent[id] = ks
			q.turns = append(q.turns, id)
		}
		return k, true
	case len(q.background) > 0:
		k, q.background = q.background[0], q.background[1:]
		delete(q.inBack, k)
		return k, true
	}
	return k, false
}

// Done forgets k: fetched, failed or no longer wanted.
func (q *Queue[K]) Done(k K) { delete(q.state, k) }

// Len is how many keys wait (copies counted).
func (q *Queue[K]) Len() int { return q.nUrgent + len(q.background) }

// UrgentLen is how many keys wait for visitors.
func (q *Queue[K]) UrgentLen() int { return q.nUrgent }

// BackgroundLen is how many keys wait for background work.
func (q *Queue[K]) BackgroundLen() int { return len(q.background) }

// Keys is how many distinct keys wait.
func (q *Queue[K]) Keys() int { return len(q.state) }

// ClientLen is how many keys wait for one visitor.
func (q *Queue[K]) ClientLen(client string) int { return len(q.urgent[client]) }

// Cache is a map bounded to max entries: when full, the oldest tenth by
// first insertion is dropped.
type Cache[K comparable, V any] struct {
	max   int
	m     map[K]V
	order []K // first insertion order, for eviction
}

// NewCache makes a cache of at most max entries.
func NewCache[K comparable, V any](max int) *Cache[K, V] {
	return &Cache[K, V]{max: max, m: map[K]V{}}
}

// Get returns k's value.
func (c *Cache[K, V]) Get(k K) (V, bool) {
	v, ok := c.m[k]
	return v, ok
}

// Put sets k's value, dropping the oldest tenth first when full.
func (c *Cache[K, V]) Put(k K, v V) {
	if _, ok := c.m[k]; !ok {
		if len(c.order) >= c.max {
			drop := max(c.max/10, 1)
			for _, old := range c.order[:drop] {
				delete(c.m, old)
			}
			c.order = append(c.order[:0], c.order[drop:]...)
		}
		c.order = append(c.order, k)
	}
	c.m[k] = v
}

// Len is how many entries are held.
func (c *Cache[K, V]) Len() int { return len(c.m) }
