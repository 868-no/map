package api

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
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
	for _, q := range []string{
		"lat1=60&lon1=10&lat2=70&lon2=10",         // too long
		"lat1=48.85&lon1=2.35&lat2=48.9&lon2=2.4", // abroad
		"lat1=78.2&lon1=15.6&lat2=78.3&lon2=15.6", // Svalbard
		"lat1=NaN&lon1=10&lat2=63&lon2=10",        // passes minimum and maximum
		"lat1=63&lon1=10&lat2=63.1&lon2=10&alt1=Inf",
	} {
		if rec := do(http.MethodGet, "/api/v1/terrain/profile?"+q, nil); rec.Code != 422 {
			t.Errorf("%s: %d %s", q, rec.Code, rec.Body.String())
		}
	}

	// Each link is classified as soon as its own heights are in: with the
	// worker stopped, a new link waits but the known one is not held back.
	// A link abroad is unknown and queues nothing.
	cancel()
	time.Sleep(20 * time.Millisecond)
	waiting := s.Terrain.Waiting()
	links = map[string]any{"links": []TerrainLink{
		{Lat1: 63.0, Lon1: 10.0, Lat2: 63.05, Lon2: 10.0},
		{Lat1: 64.0, Lon1: 11.0, Lat2: 64.05, Lon2: 11.0},
		{Lat1: 48.85, Lon1: 2.35, Lat2: 48.9, Lon2: 2.4},
	}}
	rec := do(http.MethodPost, "/api/v1/terrain/classes", links)
	c = TerrainClassesOutput{}
	json.Unmarshal(rec.Body.Bytes(), &c.Body) //nolint:errcheck
	if rec.Code != 200 || !c.Body.Incomplete || len(c.Body.Classes) != 3 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if got := []string{c.Body.Classes[0].Class, c.Body.Classes[1].Class, c.Body.Classes[2].Class}; got[0] != "grazing" || got[1] != "unknown" || got[2] != "unknown" {
		t.Fatalf("classes %v", got)
	}
	if n := len(terrain.Points(terrain.Point{Lat: 64.0, Lon: 11.0}, terrain.Point{Lat: 64.05, Lon: 11.0})); s.Terrain.Waiting()-waiting != n {
		t.Fatalf("queued %d, want the new link's %d", s.Terrain.Waiting()-waiting, n)
	}
}

// Non-finite numbers are refused; JSON cannot carry NaN, but a number too
// large for a float64 must not get through either.
func TestTerrainClassesRejectsBadNumbers(t *testing.T) {
	s := &Server{Log: slog.Default(), Now: time.Now}
	s.Terrain = terrain.New("http://unused.invalid", "test")
	mux := http.NewServeMux()
	s.NewHandler(mux)
	r := httptest.NewRequest(http.MethodPost, "/api/v1/terrain/classes",
		bytes.NewBufferString(`{"links":[{"lat1":63,"lon1":10,"lat2":63.1,"lon2":10,"alt1":1e400}]}`))
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	if rec.Code < 400 || rec.Code >= 500 || s.Terrain.Waiting() != 0 {
		t.Fatalf("%d %s, waiting %d", rec.Code, rec.Body.String(), s.Terrain.Waiting())
	}
}

// Links needing more than terrain.MaxPoints points are refused with 422 and
// queue nothing; a link abroad among them still counts for nothing.
func TestTerrainClassesTooManyPoints(t *testing.T) {
	s := &Server{Log: slog.Default(), Now: time.Now}
	s.Terrain = terrain.New("http://unused.invalid", "test")
	mux := http.NewServeMux()
	s.NewHandler(mux)
	links := []TerrainLink{{Lat1: 48.85, Lon1: 2.35, Lat2: 48.9, Lon2: 2.4}}
	for i := range maxTerrainLinks - 1 {
		lon := 8 + float64(i)*0.01
		links = append(links, TerrainLink{Lat1: 60, Lon1: lon, Lat2: 62.6, Lon2: lon})
	}
	body, _ := json.Marshal(map[string]any{"links": links})
	r := httptest.NewRequest(http.MethodPost, "/api/v1/terrain/classes", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	if rec.Code != 422 || !strings.Contains(rec.Body.String(), "more than 120000 terrain points") || s.Terrain.Waiting() != 0 {
		t.Fatalf("%d %s, waiting %d", rec.Code, rec.Body.String(), s.Terrain.Waiting())
	}
}

// Ends inside Norway and finite pass; NaN, infinities, and ends abroad or
// too far apart do not, and only NaN and infinities are not finite.
func TestTerrainEnds(t *testing.T) {
	nan, inf := math.NaN(), math.Inf(-1)
	for _, tc := range []struct {
		v      [6]float64
		finite bool
		ok     bool
	}{
		{[6]float64{63, 10, 0, 63.1, 10, 300}, true, true},
		{[6]float64{nan, 10, 0, 63.1, 10, 0}, false, false},
		{[6]float64{63, 10, 0, 63.1, 10, inf}, false, false},
		{[6]float64{63, 10, 0, 59.3, 18.1, 0}, true, false}, // Stockholm: in Coverage, but over 300 km
		{[6]float64{63, 10, 0, 40, 10, 0}, true, false},
	} {
		v := tc.v
		_, _, finite, bad := terrainEnds(v[0], v[1], v[2], v[3], v[4], v[5])
		if finite != tc.finite || (bad == "") != tc.ok {
			t.Errorf("%v: finite %v bad %q", v, finite, bad)
		}
	}
}
