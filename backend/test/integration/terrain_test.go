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

	"github.com/868-no/map/internal/terrain"
)

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
