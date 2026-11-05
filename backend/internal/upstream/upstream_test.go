package upstream

import (
	"slices"
	"testing"
)

func drain(q *Queue[int]) (out []int) {
	for k, ok := q.Pop(); ok; k, ok = q.Pop() {
		if q.State(k) != None {
			out = append(out, k)
			q.Done(k)
		}
	}
	return out
}

// Visitors are served one key each in turn, before any background key; a
// key queued for a visitor while waiting in background is taken once.
func TestQueueTurnsAndCopies(t *testing.T) {
	q := NewQueue[int](10, 100, 0)
	for _, k := range []int{100, 101, 1} {
		q.PushBackground(k)
	}
	q.PushUrgent("a", 1)
	q.PushUrgent("a", 2)
	q.PushUrgent("b", 3)
	if q.PushUrgent("b", 1) || q.PushBackground(2) {
		t.Fatal("a key waiting already was queued again")
	}
	if got := drain(q); !slices.Equal(got, []int{1, 3, 2, 100, 101}) {
		t.Fatalf("order %v", got)
	}
	if q.Len() != 0 {
		t.Fatalf("%d left", q.Len())
	}
}

// A visitor holds at most maxPerClient; a full queue takes from the visitor
// holding the most, when that one holds at least two more.
func TestQueueFairShare(t *testing.T) {
	q := NewQueue[int](5, 6, 2)
	for k := range 10 {
		q.PushUrgent("greedy", k)
	}
	if q.ClientLen("greedy") != 5 {
		t.Fatalf("greedy holds %d", q.ClientLen("greedy"))
	}
	q.PushUrgent("other", 100)
	if !q.PushUrgent("other", 101) || q.ClientLen("greedy") != 4 || q.UrgentLen() != 6 {
		t.Fatalf("greedy %d, total %d", q.ClientLen("greedy"), q.UrgentLen())
	}
	if q.State(4) != None {
		t.Fatal("the key taken from greedy still counts as queued")
	}
	q.PushUrgent("other", 102) // greedy 4 = other 2 + 2: still makes room
	if q.PushUrgent("other", 103) {
		t.Fatal("other may not pass greedy")
	}
	q.PushBackground(200)
	q.PushBackground(201)
	if q.PushBackground(202) || q.BackgroundLen() != 2 {
		t.Fatal("background over its bound")
	}
}

func TestCacheDropsOldestTenth(t *testing.T) {
	c := NewCache[int, string](20)
	for k := range 20 {
		c.Put(k, "v")
	}
	c.Put(0, "again") // an update is not an insertion
	c.Put(20, "v")
	if c.Len() != 19 {
		t.Fatalf("%d held", c.Len())
	}
	if _, ok := c.Get(1); ok {
		t.Fatal("the oldest tenth stays")
	}
	if v, ok := c.Get(2); !ok || v != "v" {
		t.Fatal("a newer entry was dropped")
	}
}
