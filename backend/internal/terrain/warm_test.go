package terrain

import (
	"context"
	"errors"
	"testing"
)

// The warmer queues the points of every pair within MaxLengthM, once each:
// a pair too far apart is skipped, points already queued are not queued
// again, and a failed load queues nothing (D-144).
func TestWarmerQueuesInfrastructurePairs(t *testing.T) {
	ends := []End{
		{Point: Point{Lat: 63.26, Lon: 10.36}},
		{Point: Point{Lat: 63.39, Lon: 10.22}}, // ~15 km from the first
		{Point: Point{Lat: 63.34, Lon: 10.69}}, // ~18 km from the first
		{Point: Point{Lat: 69.65, Lon: 18.96}}, // Tromsø: over 300 km from the rest
	}
	c := New("http://unused.invalid", "test")
	w := &Warmer{Client: c, Load: func(context.Context) ([]End, error) { return ends, nil }}
	pairs, points := w.Once(context.Background())
	if pairs != 3 {
		t.Fatalf("pairs = %d, want the 3 among the Trøndelag nodes", pairs)
	}
	want := 0
	for _, p := range [][2]int{{0, 1}, {0, 2}, {1, 2}} {
		want += len(Points(ends[p[0]].Point, ends[p[1]].Point))
	}
	if points != want {
		t.Fatalf("points = %d, want %d", points, want)
	}
	queued := c.Waiting()
	if queued == 0 || queued > want {
		t.Fatalf("queued %d grid points, want between 1 and %d", queued, want)
	}
	// A second pass finds them all queued already.
	w.Once(context.Background())
	if c.Waiting() != queued {
		t.Fatalf("second pass queued %d, want %d", c.Waiting(), queued)
	}

	failed := &Warmer{Client: New("http://unused.invalid", "test"), Load: func(context.Context) ([]End, error) { return nil, errors.New("db down") }}
	if p, n := failed.Once(context.Background()); p != 0 || n != 0 || failed.Client.Waiting() != 0 {
		t.Fatalf("failed load queued %d pairs, %d points", p, n)
	}
}
