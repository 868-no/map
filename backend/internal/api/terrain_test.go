package api

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/868-no/map/internal/terrain"
)

// A fake height API: flat ground at 50 m; 429 on the first request. Over
// 5.5 km of flat ground, antennas 2 m up leave the line in the ground's
// Fresnel zone; one reported at 300 m clears it.
func fakeHeights(t *testing.T, calls *atomic.Int32) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		var pts [][2]float64
		if err := json.Unmarshal([]byte(r.URL.Query().Get("punkter")), &pts); err != nil || len(pts) > 50 {
			t.Errorf("punkter %q: %v", r.URL.Query().Get("punkter"), err)
		}
		type pt struct {
			X, Y, Z float64
		}
		out := struct {
			Punkter []pt `json:"punkter"`
		}{}
		for _, p := range pts {
			out.Punkter = append(out.Punkter, pt{p[0], p[1], 50})
		}
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	}))
}

func TestTerrainEndpoints(t *testing.T) {
	var calls atomic.Int32
	up := fakeHeights(t, &calls)
	defer up.Close()
	s := &Server{Log: slog.Default(), Now: time.Now}
	s.Terrain = terrain.New(up.URL, "test")
	s.Terrain.Interval = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Terrain.Run(ctx)
	mux := http.NewServeMux()
	s.NewHandler(mux)
	do := func(method, path string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			json.NewEncoder(&buf).Encode(body) //nolint:errcheck
		}
		r := httptest.NewRequest(method, path, &buf)
		r.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		return rec
	}
	var p TerrainProfileBody
	for i := 0; ; i++ {
		rec := do(http.MethodGet, "/api/v1/terrain/profile?lat1=63.0&lon1=10.0&lat2=63.05&lon2=10.0&alt2=300", nil)
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		p = TerrainProfileBody{}
		json.Unmarshal(rec.Body.Bytes(), &p) //nolint:errcheck
		if i == 0 && (!p.Incomplete || p.Class != "unknown" || rec.Header().Get("Cache-Control") != "no-store") {
			t.Fatalf("first answer: %+v", p)
		}
		if !p.Incomplete {
			break
		}
		if i > 500 {
			t.Fatal("never complete")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if p.Class != "clear" || *p.A.Height != 52 || *p.B.Height != 300 || len(p.Samples) == 0 || p.Attribution == "" {
		t.Fatalf("%+v", p.Profile)
	}
	// Classes: the same link is known; a nearby one may still be fetched.
	links := map[string]any{"links": []TerrainLink{{Lat1: 63.0, Lon1: 10.0, Lat2: 63.05, Lon2: 10.0}, {Lat1: 63.0, Lon1: 10.0, Lat2: 70.0, Lon2: 10.0}}}
	var c TerrainClassesOutput
	for i := 0; ; i++ {
		rec := do(http.MethodPost, "/api/v1/terrain/classes", links)
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		json.Unmarshal(rec.Body.Bytes(), &c.Body) //nolint:errcheck
		if !c.Body.Incomplete || i > 500 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(c.Body.Classes) != 2 || c.Body.Classes[0].Class != "grazing" || c.Body.Classes[1].Class != "unknown" {
		t.Fatalf("%+v", c.Body)
	}
	if rec := do(http.MethodGet, "/api/v1/terrain/profile?lat1=60&lon1=10&lat2=70&lon2=10", nil); rec.Code != 422 {
		t.Fatalf("too long: %d", rec.Code)
	}
}
