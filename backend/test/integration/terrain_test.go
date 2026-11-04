//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/terrain"
)

// The warmer's nodes (D-144): a node's newest role decides, positions come
// from Position packets and map reports, the newest wins, a reported
// altitude of 0 means none, and nothing older than the window counts.
func TestInfraPositions(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	if err := storage.EnsurePartitions(ctx, pool, now.AddDate(0, 0, -45), now); err != nil {
		t.Fatal(err)
	}
	key := 0
	row := func(node int, typ string, ago time.Duration, meta string) {
		t.Helper()
		key++
		if _, err := pool.Exec(ctx, `INSERT INTO packet_log (observed_at, broker_id, mqtt_topic, source_node_id, packet_type,
			logical_packet_key, observation_key, signature_status, decode_version, envelope_bytes, decoded_metadata)
			VALUES ($1, 'a', 't', $2, $3, $4, $4, 'unsigned', 1, '\x00', $5::jsonb)`,
			now.Add(-ago), node, typ, []byte{byte(key)}, meta); err != nil {
			t.Fatal(err)
		}
	}
	router := `{"nodeinfo": {"role": "ROUTER"}}`
	pos := func(lat, lon float64, alt int) string {
		b, _ := json.Marshal(map[string]any{"position": map[string]any{"lat": lat, "lon": lon, "alt": alt}})
		return string(b)
	}
	row(1, "nodeinfo", time.Hour, router)
	row(1, "position", time.Hour, pos(63.26, 10.36, 708))
	row(2, "nodeinfo", time.Hour, `{"nodeinfo": {"role": "CLIENT"}}`) // not infrastructure
	row(2, "position", time.Hour, pos(63.3, 10.4, 50))
	row(3, "mapreport", time.Hour, `{"mapreport": {"role": "ROUTER_LATE"}, "position": {"lat": 63.39, "lon": 10.22, "alt": 0}}`)
	row(4, "nodeinfo", 3*time.Hour, router) // a router once, a client now
	row(4, "nodeinfo", time.Hour, `{"nodeinfo": {"role": "CLIENT"}}`)
	row(4, "position", time.Hour, pos(63.5, 10.5, 10))
	row(5, "nodeinfo", time.Hour, `{"nodeinfo": {"role": "CLIENT_BASE"}}`)
	row(5, "position", 3*time.Hour, pos(60.0, 5.0, 10)) // moved since
	row(5, "position", time.Hour, pos(63.34, 10.69, 20))
	row(6, "nodeinfo", 20*24*time.Hour, router) // older than the 14-day window
	row(6, "position", 20*24*time.Hour, pos(63.0, 10.0, 10))

	got, err := storage.InfraPositions(ctx, pool, now.Add(-terrain.WarmWindow))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %+v, want nodes 1, 3 and 5", got)
	}
	if n := got[0]; n.Node != 1 || n.Lat != 63.26 || n.Alt == nil || *n.Alt != 708 {
		t.Fatalf("node 1: %+v", n)
	}
	if n := got[1]; n.Node != 3 || n.Lat != 63.39 || n.Alt != nil {
		t.Fatalf("node 3 (map report, no altitude): %+v", n)
	}
	if n := got[2]; n.Node != 5 || n.Lat != 63.34 {
		t.Fatalf("node 5 (newest position): %+v", n)
	}
}

// Fetched heights are kept in terrain_height (D-143): a new client, as after
// a restart, builds the same cross section without asking Kartverket again.
// Points the model has no height for are kept as such.
func TestTerrainStore(t *testing.T) {
	pool := freshDB(t)
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		var pts [][2]float64
		json.Unmarshal([]byte(r.URL.Query().Get("punkter")), &pts) //nolint:errcheck
		type pt struct {
			Z *float64 `json:"z"`
		}
		var out struct {
			Punkter []pt `json:"punkter"`
		}
		for _, p := range pts {
			z := 300 - 1000*(p[1]-63)
			if p[0] > 10.5 {
				out.Punkter = append(out.Punkter, pt{}) // abroad
			} else {
				out.Punkter = append(out.Punkter, pt{&z})
			}
		}
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	}))
	defer up.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := func() *terrain.Client {
		c := terrain.New(up.URL, "test")
		c.Interval, c.Store = time.Millisecond, &terrain.Store{Pool: pool}
		go c.Run(ctx)
		return c
	}
	a, b := terrain.End{Point: terrain.Point{Lat: 63.0, Lon: 10.0}}, terrain.End{Point: terrain.Point{Lat: 63.1, Lon: 10.0}}
	c := client()
	var first terrain.Profile
	for i := 0; ; i++ {
		var inc bool
		if first, inc = c.Profile(ctx, a, b); !inc {
			break
		}
		if i > 400 {
			t.Fatal("never complete")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if first.Class == "unknown" || *first.A.Height != 302 {
		t.Fatalf("%+v", first)
	}
	// Abroad: stored as no height, and not asked for again.
	far := terrain.Point{Lat: 63.0, Lon: 10.6}
	for i := 0; ; i++ {
		if _, inc := c.Heights(ctx, []terrain.Point{far}); !inc {
			break
		}
		if i > 400 {
			t.Fatal("never complete")
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond) // the last write
	before := hits.Load()
	c2 := client()
	again, inc := c2.Profile(ctx, a, b)
	if inc || again.Class != first.Class || again.WorstClearance != first.WorstClearance {
		t.Fatalf("from the store: %v %+v", inc, again)
	}
	if h, inc := c2.Heights(ctx, []terrain.Point{far}); inc {
		t.Fatal("abroad not stored")
	} else if _, ok := h(far); ok {
		t.Fatal("abroad has a height")
	}
	if hits.Load() != before {
		t.Fatalf("asked again: %d requests after the store had them", hits.Load()-before)
	}
}
