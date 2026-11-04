package terrain

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The warmer queues the points of every pair within MaxLengthM and inside
// Coverage, once each, in the background queue: a pair too far apart or
// abroad is skipped, points already queued are not queued again, a pair
// whose heights are all in is skipped by later passes, and a failed load
// queues nothing (D-144, D-147).
func TestWarmerQueuesInfrastructurePairs(t *testing.T) {
	ends := []End{
		{Point: Point{Lat: 63.26, Lon: 10.36}},
		{Point: Point{Lat: 63.39, Lon: 10.22}}, // ~15 km from the first
		{Point: Point{Lat: 63.34, Lon: 10.69}}, // ~18 km from the first
		{Point: Point{Lat: 69.65, Lon: 18.96}}, // Tromsø: over 300 km from the rest
		{Point: Point{Lat: 78.22, Lon: 15.65}}, // Svalbard: outside Coverage
	}
	c := New("http://unused.invalid", "test")
	w := &Warmer{Client: c, Load: func(context.Context) ([]End, error) { return ends, nil }}
	pairs, points := w.Once(context.Background())
	if pairs != 3 {
		t.Fatalf("pairs = %d, want the 3 among the Trøndelag nodes", pairs)
	}
	var all []Point
	for _, p := range [][2]int{{0, 1}, {0, 2}, {1, 2}} {
		all = append(all, Points(ends[p[0]].Point, ends[p[1]].Point)...)
	}
	want := len(dedupe(all))
	if points != want || c.Waiting() != want || c.backgroundWaiting() != want {
		t.Fatalf("queued %d (waiting %d, background %d), want %d distinct grid points", points, c.Waiting(), c.backgroundWaiting(), want)
	}
	// A second pass finds them all queued already, and no pair done.
	if _, n := w.Once(context.Background()); n != 0 || c.Waiting() != want || len(w.done) != 0 {
		t.Fatalf("second pass queued %d, done %d", n, len(w.done))
	}
	// Once fetched, every pair is done and later passes skip them.
	c.mu.Lock()
	batch, keep := c.next()
	for len(batch) > 0 {
		for _, k := range batch {
			if !keep[k] {
				t.Fatal("without a store, warmed points must be kept in memory")
			}
			c.put(k, Height{Z: 1, OK: true})
			delete(c.queued, k)
		}
		batch, keep = c.next()
	}
	c.mu.Unlock()
	if _, n := w.Once(context.Background()); n != 0 || len(w.done) != 3 {
		t.Fatalf("after fetching: queued %d, done %d", n, len(w.done))
	}

	failed := &Warmer{Client: New("http://unused.invalid", "test"), Load: func(context.Context) ([]End, error) { return nil, errors.New("db down") }}
	if p, n := failed.Once(context.Background()); p != 0 || n != 0 || failed.Client.Waiting() != 0 {
		t.Fatalf("failed load queued %d pairs, %d points", p, n)
	}
}

// The warmer queues no more than warmQueue at a time: with the background
// queue full, it waits for the worker rather than adding to it.
func TestWarmerWaitsForTheQueueToDrain(t *testing.T) {
	old := warmPoll
	warmPoll = time.Millisecond
	defer func() { warmPoll = old }()
	c := New("http://unused.invalid", "test")
	var full []Key
	for i := range warmQueue {
		full = append(full, Key{Lat: 140_000, Lon: int32(20_000 + i)})
	}
	c.queueBackground(full)
	w := &Warmer{Client: c, Load: func(context.Context) ([]End, error) {
		return []End{{Point: Point{Lat: 63.26, Lon: 10.36}}, {Point: Point{Lat: 63.39, Lon: 10.22}}}, nil
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, n := w.Once(ctx); n != 0 || c.Waiting() != warmQueue {
		t.Fatalf("queued %d into a full queue (waiting %d)", n, c.Waiting())
	}
}
