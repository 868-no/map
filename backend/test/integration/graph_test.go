//go:build integration

package integration

import (
	"context"
	"math"
	"net/url"
	"testing"
	"time"

	"github.com/868-no/map/internal/demo"
	"github.com/868-no/map/internal/geo"
	"github.com/868-no/map/internal/graph"
	"github.com/868-no/map/internal/identity"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/query"
	"github.com/868-no/map/internal/storage"
)

type graphSnap struct {
	Nodes []struct {
		ID       string        `json:"id"`
		Num      uint32        `json:"num"`
		Position *struct{}     `json:"position"`
		Estimate *geo.Estimate `json:"estimate"`
		Note     string        `json:"estimate_note"`
	} `json:"nodes"`
	Edges       []graph.Edge `json:"edges"`
	Diagnostics struct {
		RelayAmbiguous int `json:"relay_ambiguous"`
	} `json:"diagnostics"`
}

// §17 tests 21-28 on the demo mesh through ingest, storage and the API.
func TestTopologyAndGeolocation(t *testing.T) {
	pool := freshDB(t)
	ids := identity.New(func(ctx context.Context) ([]storage.IdentityRow, error) { return nil, nil }, quiet)
	p := newPipeline(t, pool, nil, ids)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	scen := demo.DefaultScenario()
	sim := demo.NewSimulator(scen, 5)
	start := time.Now().UTC().Truncate(time.Second)
	for i := 0; i < 1500; i++ {
		for _, m := range sim.Step() {
			p.Submit(ingest.RawMessage{BrokerID: "demo", Topic: m.Topic, Payload: m.Payload, ObservedAt: time.Now()})
		}
	}
	waitRows(t, pool, 500)
	cancel()
	<-done
	end := time.Now().UTC().Add(time.Second)

	c := newAPI(t, pool, nil, end.Add(31*time.Minute))
	c.s.Geo = query.GeoOptions{Enabled: true, MinPrecisionBits: 20, Exclude: map[uint32]bool{}, Params: geo.DefaultParams()}
	q := url.Values{"start": {start.Add(-30 * time.Minute).Format(time.RFC3339Nano)}, "end": {end.Add(30 * time.Minute).Format(time.RFC3339Nano)}}
	var s graphSnap
	if code := c.get("/api/v1/snapshot", q, &s); code != 200 {
		t.Fatalf("HTTP %d", code)
	}
	counts := map[string]int{}
	for _, e := range s.Edges {
		if e.SrcNum == 0xFFFFFFFF || e.DstNum == 0xFFFFFFFF || e.SrcNum == e.DstNum {
			t.Fatalf("invalid edge %+v", e)
		}
		if e.Evidence.Neighbor > 0 {
			counts["neighbor"]++
		}
		if e.Evidence.Traceroute > 0 {
			counts["traceroute"]++
		}
		if e.Evidence.DirectRF > 0 {
			counts["direct"]++
		}
		if e.Inferred {
			counts["inferred"]++
		}
		if e.Evidence.RelayHint > 0 {
			counts["relay"]++
		}
	}
	lowBytes := map[uint8]int{}
	for _, n := range scen.Nodes {
		lowBytes[uint8(n.Num)]++
	}
	dups := 0
	for _, c := range lowBytes {
		if c > 1 {
			dups++
		}
	}
	t.Logf("%d edges: %v; relay ambiguous: %d; scenario low-byte collisions: %d", len(s.Edges), counts, s.Diagnostics.RelayAmbiguous, dups)
	if counts["relay"] == 0 {
		t.Error("relay-hint inference never contributed")
	}
	for _, k := range []string{"neighbor", "traceroute", "direct"} {
		if counts[k] == 0 {
			t.Errorf("no %s edges", k)
		}
	}

	// Every edge must correspond to a real RF link in the scenario: no
	// imaginary edges (relay-hint inferences included).
	real := map[[2]uint32]bool{}
	for i, ls := range scen.Links {
		for _, l := range ls {
			real[[2]uint32{scen.Nodes[i].Num, scen.Nodes[l.Dst].Num}] = true
		}
	}
	for _, e := range s.Edges {
		if !real[[2]uint32{e.SrcNum, e.DstNum}] {
			t.Errorf("edge %s->%s (%s, %+v) has no RF link in the scenario", e.Src, e.Dst, e.Confidence, e.Evidence)
		}
	}

	// §17 test 23: colliding relay bytes never resolve.
	colliders := map[uint32]bool{scen.Nodes[16].Num: true, scen.Nodes[17].Num: true}
	if s.Diagnostics.RelayAmbiguous == 0 {
		t.Error("expected ambiguous relay hints from the scenario's byte collision")
	}
	for _, e := range s.Edges {
		if e.Inferred && colliders[e.SrcNum] {
			t.Errorf("inferred edge from colliding relay %s", e.Src)
		}
	}

	// §17 tests 26/28: unpositioned nodes get coarse labelled estimates or a
	// reason; reported and estimated positions never coexist.
	estimated := 0
	for _, n := range s.Nodes {
		if n.Estimate != nil {
			estimated++
			if n.Position != nil || n.Estimate.Quality != "very_low" || n.Estimate.UncertaintyM < 2000 || n.Estimate.AnchorCount < 3 {
				t.Errorf("%s: bad estimate %+v", n.ID, n.Estimate)
			}
			// Truth check against the scenario.
			for _, sn := range scen.Nodes {
				if sn.Num == n.Num {
					if d := distM(n.Estimate.Lat, n.Estimate.Lon, sn.Lat, sn.Lon); d > n.Estimate.UncertaintyM*1.5 {
						t.Errorf("%s estimate %.0f m from truth, radius %.0f m", n.ID, d, n.Estimate.UncertaintyM)
					} else {
						t.Logf("%s (%s) estimated within %.0f m (radius %.0f m, %d anchors)", n.ID, sn.Long, d, n.Estimate.UncertaintyM, n.Estimate.AnchorCount)
					}
				}
			}
		}
	}
	if estimated == 0 {
		for _, n := range s.Nodes {
			if n.Note != "" {
				t.Logf("%s: %s", n.ID, n.Note)
			}
		}
		t.Error("no estimates for the scenario's unpositioned nodes")
	}

	// §17 test 27: a window without in-window anchor positions yields no
	// estimate even though positions exist outside it.
	late := url.Values{"start": {end.Add(-time.Hour).Format(time.RFC3339Nano)}, "end": {end.Format(time.RFC3339Nano)},
		"type": {"telemetry,neighborinfo"}}
	var s2 graphSnap
	c.get("/api/v1/snapshot", late, &s2)
	for _, n := range s2.Nodes {
		if n.Estimate != nil {
			t.Errorf("%s estimated without in-window anchor positions", n.ID)
		}
	}

	// /edges filters.
	var eb struct {
		Edges []graph.Edge `json:"edges"`
		Total int          `json:"total"`
	}
	q.Set("min_confidence", "high")
	c.get("/api/v1/edges", q, &eb)
	for _, e := range eb.Edges {
		if e.Confidence != "high" {
			t.Fatalf("min_confidence filter: %+v", e)
		}
	}
	if eb.Total != len(s.Edges) || len(eb.Edges) == 0 || len(eb.Edges) >= eb.Total {
		t.Errorf("edges filter: %d of %d", len(eb.Edges), eb.Total)
	}
}

func distM(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371000.0
	dlat := (lat2 - lat1) * 3.141592653589793 / 180
	dlon := (lon2 - lon1) * 3.141592653589793 / 180 * cosDeg((lat1+lat2)/2)
	return R * sqrt(dlat*dlat+dlon*dlon)
}

func cosDeg(d float64) float64 { return math.Cos(d * math.Pi / 180) }
func sqrt(v float64) float64   { return math.Sqrt(v) }
