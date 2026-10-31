package graph

import (
	"fmt"
	"testing"
	"time"
)

func id(n uint32) string   { return fmt.Sprintf("!%08x", n) }
func f(v float64) *float64 { return &v }

var t0 = time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)

func find(es []Edge, src, dst uint32) *Edge {
	for i := range es {
		if es[i].SrcNum == src && es[i].DstNum == dst {
			return &es[i]
		}
	}
	return nil
}

// §17 test 21: NeighborInfo A reporting B creates only B -> A with the
// float SNR unchanged; duplicates of one report count once.
func TestNeighborDirectionAndSNR(t *testing.T) {
	const A, B = 0xa, 0xb
	s := Sample{Src: B, Dst: A, Ev: Neighbor, T: t0, SNR: f(6.25), Key: "lp1"}
	es := Reduce([]Sample{s, s, s}, id)
	if len(es) != 1 || find(es, B, A) == nil || find(es, A, B) != nil {
		t.Fatalf("want only B->A, got %+v", es)
	}
	e := es[0]
	if *e.SNR.Median != 6.25 || e.Samples != 1 || e.Confidence != "high" {
		t.Fatalf("got %+v", e)
	}
}

// §17 test 22: forward and return traceroutes create correct adjacent
// directed edges with SNR/4 (already scaled by the decoder), no shortcut.
func TestTracerouteSegments(t *testing.T) {
	const O, R1, R2, D = 0x1, 0x2, 0x3, 0x4
	// Reply from D to O: forward O->R1->R2->D, back D->R2->R1->O.
	rec := TracerouteRecord{From: D, To: O, IsReply: true,
		Route: []Hop{{ID: R1}, {ID: R2}}, SNRTowards: []*float64{f(10), f(-2.5), f(4)},
		RouteBack: []Hop{{ID: R2}, {ID: R1}}, SNRBack: []*float64{f(3), f(1), f(-7.25)}, T: t0, Logical: "tr"}
	es := Reduce(TracerouteSamples(rec), id)
	want := map[[2]uint32]float64{{O, R1}: 10, {R1, R2}: -2.5, {R2, D}: 4, {D, R2}: 3, {R2, R1}: 1, {R1, O}: -7.25}
	if len(es) != len(want) {
		t.Fatalf("want %d edges, got %d: %+v", len(want), len(es), es)
	}
	for k, snr := range want {
		e := find(es, k[0], k[1])
		if e == nil || *e.SNR.Median != snr {
			t.Errorf("edge %x->%x: %+v, want SNR %v", k[0], k[1], e, snr)
		}
	}
	if find(es, O, D) != nil || find(es, D, O) != nil {
		t.Fatal("shortcut edge between origin and destination")
	}
}

// Request copies heard mid-path carry partial routes; the same segment from
// several copies of one traceroute counts once.
func TestTracerouteRequestCopies(t *testing.T) {
	const O, R1, R2, D = 0x1, 0x2, 0x3, 0x4
	c1 := TracerouteRecord{From: O, To: D, Route: []Hop{{ID: R1}}, SNRTowards: []*float64{f(5)}, T: t0, Logical: "tr"}
	c2 := TracerouteRecord{From: O, To: D, Route: []Hop{{ID: R1}, {ID: R2}}, SNRTowards: []*float64{f(5), f(2)}, T: t0, Logical: "tr"}
	es := Reduce(append(TracerouteSamples(c1), TracerouteSamples(c2)...), id)
	if len(es) != 2 || find(es, O, R1).Samples != 1 || find(es, R1, R2) == nil || find(es, R2, D) != nil {
		t.Fatalf("got %+v", es)
	}
}

// Unknown placeholder hops break the path: no edge touches them, and no
// edge bridges across them.
func TestTracerouteUnknownHop(t *testing.T) {
	const O, R1, R3, D = 0x1, 0x2, 0x5, 0x4
	rec := TracerouteRecord{From: D, To: O, IsReply: true,
		Route: []Hop{{ID: R1}, {ID: 0xFFFFFFFF, Unknown: true}, {ID: R3}}, SNRTowards: []*float64{f(1), nil, f(3), f(4)}, T: t0, Logical: "tr"}
	es := Reduce(TracerouteSamples(rec), id)
	if find(es, O, R1) == nil || find(es, R3, D) == nil || find(es, R1, R3) != nil || len(es) != 2 {
		t.Fatalf("got %+v", es)
	}
}

// §17 test 23: two candidates sharing the relay byte -> no edge.
func TestRelayAmbiguity(t *testing.T) {
	known := []uint32{0x11111142, 0x22222242, 0x33333333}
	c := NewRelayContext(known, nil, nil)
	if _, r := ResolveRelay(0x42, 0, 0, c); r != RelayAmbiguous {
		t.Fatal("ambiguous relay byte resolved")
	}
	if _, r := ResolveRelay(0, 0, 0, c); r != RelayUnmatched {
		t.Fatal("zero hint resolved")
	}
	if _, r := ResolveRelay(0x99, 0, 0, c); r != RelayUnmatched {
		t.Fatal("unmatched hint resolved")
	}
	// §17 test 24: unique match -> candidate; origin and gateway excluded.
	if n, r := ResolveRelay(0x33, 0, 0, c); r != RelayResolved || n != 0x33333333 {
		t.Fatal("unique relay byte not resolved")
	}
	if _, r := ResolveRelay(0x33, 0x33333333, 0, c); r != RelayUnmatched {
		t.Fatal("origin used as relay")
	}
	if _, r := ResolveRelay(0x33, 0, 0x33333333, c); r != RelayUnmatched {
		t.Fatal("gateway used as relay")
	}
}

// A last-hop byte equal to the gateway's own low byte is the gateway, never
// another node that happens to share the byte.
func TestRelayByteOfGatewayIgnored(t *testing.T) {
	const gw, other = 0x0000aa42, 0x11111142
	c := NewRelayContext([]uint32{gw, other}, nil, nil)
	if n, r := ResolveRelay(0x42, 0x0000bb01, gw, c); r != RelayUnmatched {
		t.Fatalf("gateway byte resolved to %x", n)
	}
}

func TestRelayNarrowedByRange(t *testing.T) {
	const gw, near, far, unplaced = 0x0000aa01, 0x11111142, 0x22222242, 0x33333342
	pos := map[uint32]LatLon{gw: {63.43, 10.40}, near: {63.50, 10.50}, far: {59.91, 10.75}} // far: Oslo, ~390 km
	c := NewRelayContext([]uint32{gw, near, far}, pos, nil)
	if n, r := ResolveRelay(0x42, 0, gw, c); r != RelayResolved || n != near {
		t.Fatalf("out-of-range candidate not excluded: %x %v", n, r)
	}
	// An unpositioned candidate cannot be ruled out.
	c = NewRelayContext([]uint32{gw, near, far, unplaced}, pos, nil)
	if _, r := ResolveRelay(0x42, 0, gw, c); r != RelayAmbiguous {
		t.Fatal("unpositioned candidate silently dropped")
	}
	// A proven long link widens the range bound.
	long := []Sample{{Src: gw, Dst: far, Ev: Neighbor}}
	c = NewRelayContext([]uint32{gw, near, far}, pos, long)
	if c.MaxRangeM < DistanceM(pos[gw], pos[far]) {
		t.Fatal("range bound below a confirmed link")
	}
}

func TestRelayNarrowedByConfirmedLinks(t *testing.T) {
	const gw, a, b = 0x0000aa01, 0x11111142, 0x22222242
	c := NewRelayContext([]uint32{gw, a, b}, nil, []Sample{{Src: b, Dst: gw, Ev: Neighbor}})
	if n, r := ResolveRelay(0x42, 0, gw, c); r != RelayResolved || n != b {
		t.Fatalf("confirmed link did not disambiguate: %x %v", n, r)
	}
	// Relay-hint evidence never confirms a pair (no self-reinforcement).
	c = NewRelayContext([]uint32{gw, a, b}, nil, []Sample{{Src: b, Dst: gw, Ev: RelayHint}})
	if _, r := ResolveRelay(0x42, 0, gw, c); r != RelayAmbiguous {
		t.Fatal("relay-hint evidence used to confirm a relay")
	}
	// Two confirmed candidates stay ambiguous.
	c = NewRelayContext([]uint32{gw, a, b}, nil, []Sample{{Src: a, Dst: gw, Ev: DirectRF}, {Src: gw, Dst: b, Ev: Traceroute}})
	if _, r := ResolveRelay(0x42, 0, gw, c); r != RelayAmbiguous {
		t.Fatal("two confirmed candidates resolved")
	}
}

func TestConfidenceLevels(t *testing.T) {
	es := Reduce([]Sample{
		{Src: 1, Dst: 2, Ev: RelayHint, T: t0, Key: "a"},
		{Src: 3, Dst: 4, Ev: DirectRF, T: t0, SNR: f(5), RSSI: f(-90), Key: "b"},
		{Src: 5, Dst: 6, Ev: DirectRF, T: t0, Key: "c"},
		{Src: 5, Dst: 6, Ev: Neighbor, T: t0, Key: "d"},
	}, id)
	if e := find(es, 1, 2); e.Confidence != "low" || !e.Inferred {
		t.Errorf("relay-only: %+v", e)
	}
	if e := find(es, 3, 4); e.Confidence != "medium" || e.Inferred || *e.RSSI.Median != -90 {
		t.Errorf("direct: %+v", e)
	}
	if e := find(es, 5, 6); e.Confidence != "high" {
		t.Errorf("corroborated: %+v", e)
	}
}

func TestSelfAndInvalidLinksDropped(t *testing.T) {
	es := Reduce([]Sample{{Src: 1, Dst: 1, Ev: Neighbor}, {Src: 0, Dst: 2, Ev: Neighbor}, {Src: 2, Dst: 0xFFFFFFFF, Ev: Neighbor}}, id)
	if len(es) != 0 {
		t.Fatalf("got %+v", es)
	}
}
