package terrain

import (
	"context"
	"errors"
	"math"
	"testing"
)

func ptr(v float64) *float64 { return &v }

// Two antennas 20 km apart reporting 110 m, over flat ground at 0 m: the
// earth's bulge midway is about 5.9 m and the Fresnel radius about 41.5 m,
// so the line clears it. A ridge midway decides the class: 85 m leaves less
// than 60 % of the zone free, 120 m cuts the line.
func TestBuildClasses(t *testing.T) {
	a := End{Point{63.0, 10.0}, ptr(110)}
	b := End{Point{63.0 + 20_000.0/111_195, 10.0}, ptr(110)}
	mid := lerp(a.Point, b.Point, 0.5)
	for _, tc := range []struct {
		ridge float64
		want  string
	}{{0, "clear"}, {85, "grazing"}, {120, "blocked"}} {
		h := func(p Point) (float64, bool) {
			if Distance(p, mid) < 150 {
				return tc.ridge, true
			}
			return 0, true
		}
		p := Build(a, b, h)
		if p.Class != tc.want {
			t.Errorf("ridge %v m: %s (clearance %v at %v m), want %s", tc.ridge, p.Class, p.WorstClearance, p.WorstD, tc.want)
		}
		if *p.A.Height != 110 || p.A.Source != "reported" || *p.A.Ground != 0 || math.Abs(p.LengthM-20_000) > 50 || len(p.Samples) < 98 {
			t.Errorf("profile: antenna %+v length %v samples %d", p.A, p.LengthM, len(p.Samples))
		}
	}
	s := Build(a, b, func(Point) (float64, bool) { return 0, true }).Samples[49] // about midway
	if math.Abs(s.Bulge-5.9) > 0.1 || math.Abs(s.Fresnel-41.5) > 0.5 {
		t.Errorf("midway bulge %.2f fresnel %.2f", s.Bulge, s.Fresnel)
	}
}

// Without a reported altitude, the antenna is 2 m above the terrain.
func TestBuildAntennaOnTerrain(t *testing.T) {
	a, b := End{Point: Point{63.0, 10.0}}, End{Point{63.1, 10.0}, ptr(700)}
	p := Build(a, b, func(q Point) (float64, bool) { return 400, true })
	if p.A.Source != "terrain" || *p.A.Height != 402 || p.B.Source != "reported" || *p.B.Height != 700 {
		t.Fatalf("%+v %+v", p.A, p.B)
	}
	if p.Samples[0].Line <= 402 || p.Class != "clear" {
		t.Fatalf("line %v class %s", p.Samples[0].Line, p.Class)
	}
}

// Without an antenna height, or heights for most of the path, there is no class.
func TestBuildUnknown(t *testing.T) {
	a, b := End{Point: Point{63.0, 10.0}}, End{Point: Point{63.1, 10.0}}
	if p := Build(a, b, func(Point) (float64, bool) { return 0, false }); p.Class != "unknown" || p.A.Source != "none" {
		t.Fatalf("%+v", p)
	}
	a.Alt, b.Alt = ptr(100), ptr(100)
	half := func(q Point) (float64, bool) { return 0, q.Lat < 63.02 }
	if p := Build(a, b, half); p.Class != "unknown" {
		t.Fatalf("mostly unknown path: %s", p.Class)
	}
}

func TestKeyRoundTrip(t *testing.T) {
	p := Point{63.43021, 10.39507}
	k := keyOf(p)
	if q := k.point(); Distance(p, q) > 30 || keyOf(q) != k {
		t.Fatalf("%v → %v → %v", p, k, q)
	}
}

func TestCovered(t *testing.T) {
	for _, tc := range []struct {
		p    Point
		want bool
	}{
		{Point{63.43, 10.39}, true},       // Trondheim
		{Point{58.0, 7.05}, true},         // Lindesnes
		{Point{71.17, 25.78}, true},       // Nordkapp
		{Point{69.73, 30.05}, true},       // Kirkenes
		{Point{78.22, 15.65}, false},      // Svalbard
		{Point{48.85, 2.35}, false},       // Paris
		{Point{math.NaN(), 10}, false},    // not a position
		{Point{63, math.Inf(1)}, false},   // nor this
		{Point{-63.43, -10.39}, false},    // the other side of the world
		{Point{Coverage.MaxLat, 4}, true}, // the edge is in
		{Point{Coverage.MaxLat + 1e-9, 4}, false},
	} {
		if got := Covered(tc.p); got != tc.want {
			t.Errorf("Covered(%v) = %v, want %v", tc.p, got, tc.want)
		}
	}
}

// grid is n distinct grid points in Trøndelag.
func grid(n int) []Point {
	pts := make([]Point, n)
	for i := range pts {
		pts[i] = Key{Lat: 126_000 + int32(i/1000), Lon: 20_000 + int32(i%1000)}.point()
	}
	return pts
}

// One visitor asking for much cannot crowd out another: each may have
// maxPerClient points waiting, and the worker takes one from each in turn
// (D-147). Duplicates count once, and over MaxPoints is refused.
func TestHeightsForQueuesPerVisitor(t *testing.T) {
	c := New("http://unused.invalid", "test")
	ctx := context.Background()
	big := grid(maxPerClient + 5_000)
	if _, inc, err := c.HeightsFor(ctx, "greedy", append(big, big...)); err != nil || !inc {
		t.Fatalf("greedy: %v %v", inc, err)
	}
	if c.Waiting() != maxPerClient {
		t.Fatalf("greedy has %d waiting, want %d", c.Waiting(), maxPerClient)
	}
	small := []Point{{64.0, 11.0}, {64.0, 11.0}, {64.1, 11.0}}
	l, inc, err := c.HeightsFor(ctx, "other", small)
	if err != nil || !inc || l.Known(small[0]) {
		t.Fatalf("other: %v %v", inc, err)
	}
	if c.Waiting() != maxPerClient+2 {
		t.Fatalf("waiting %d, want the other's 2 distinct points too", c.Waiting())
	}
	c.mu.Lock()
	batch, _ := c.next()
	c.mu.Unlock()
	if len(batch) != perRequest {
		t.Fatalf("batch of %d", len(batch))
	}
	mine := 0
	for _, k := range batch {
		if k == keyOf(small[0]) || k == keyOf(small[2]) {
			mine++
		}
	}
	if mine != 2 {
		t.Fatalf("the first batch holds %d of the other visitor's 2 points", mine)
	}
	before := c.Waiting()
	if _, _, err := c.HeightsFor(ctx, "huge", grid(MaxPoints+1)); !errors.Is(err, ErrTooManyPoints) || c.Waiting() != before {
		t.Fatalf("over MaxPoints: %v, waiting %d", err, c.Waiting())
	}
}

// Visitors' points go before the warmer's, and with a store only theirs are
// kept in memory (D-147).
func TestVisitorsBeforeWarmer(t *testing.T) {
	c := New("http://unused.invalid", "test")
	bg := grid(100)
	c.queueBackground(dedupe(bg))
	visitor := []Point{{64.0, 11.0}, {64.1, 11.0}, bg[0]} // bg[0] is promoted
	if _, _, err := c.HeightsFor(context.Background(), "v", visitor); err != nil {
		t.Fatal(err)
	}
	c.Store = &Store{} // next only asks whether there is one
	c.mu.Lock()
	batch, keep := c.next()
	c.mu.Unlock()
	if len(batch) != perRequest {
		t.Fatalf("batch of %d", len(batch))
	}
	for i, k := range batch {
		want := i < 3
		if keep[k] != want {
			t.Fatalf("batch[%d] = %v kept %v, want %v (visitors first)", i, k, keep[k], want)
		}
	}
	if keyOf(visitor[2]) != batch[2] {
		t.Fatalf("promoted point not in front: %v", batch[:3])
	}
	for _, k := range batch[3:] {
		if k == keyOf(bg[0]) {
			t.Fatal("promoted point fetched twice")
		}
	}
}

// A full cache drops its oldest tenth, not everything.
func TestPutEvictsOldest(t *testing.T) {
	c := New("http://unused.invalid", "test")
	c.order = make([]Key, 0, maxEntries)
	for i := range maxEntries {
		k := Key{Lat: int32(i), Lon: 0}
		c.cache[k] = Height{}
		c.order = append(c.order, k)
	}
	c.put(Key{Lat: -1}, Height{Z: 1, OK: true})
	if len(c.cache) != maxEntries-maxEntries/10+1 {
		t.Fatalf("%d cached", len(c.cache))
	}
	if _, ok := c.cache[Key{Lat: 0}]; ok {
		t.Fatal("oldest kept")
	}
	if _, ok := c.cache[Key{Lat: maxEntries - 1}]; !ok {
		t.Fatal("newest dropped")
	}
}
