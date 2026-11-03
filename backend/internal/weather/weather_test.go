package weather

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCellAt(t *testing.T) {
	// Indices checked against the grid's own latitude/longitude arrays.
	c, ok := CellAt(63.4167, 10.2667)
	if !ok || c != (Cell{662, 1159}) {
		t.Fatalf("Trondheim: got %v %v, want {662 1159}", c, ok)
	}
	if _, ok := CellAt(48.85, 2.35); ok {
		t.Fatal("Paris is outside the grid")
	}
	if _, ok := CellAt(90, 0); ok {
		t.Fatal("the pole is outside the grid")
	}
	// A cell's centre lies in the cell, and maps onto the MEPS grid where its
	// own latitude/longitude arrays put Trondheim.
	lat, lon := analysis.centre(c)
	if back, _ := CellAt(lat, lon); back != c {
		t.Fatalf("centre %v,%v is in %v", lat, lon, back)
	}
	if m, ok := meps.cell(lat, lon); !ok || m != (Cell{330, 542}) {
		t.Fatalf("MEPS: %v %v, want {330 542}", m, ok)
	}
}

const sample = `Dataset {
    Grid {
    } air_temperature_2m;
} x.nc;
---------------------------------------------
air_temperature_2m.air_temperature_2m[1][1][1]
[0][0], 277.39926

air_temperature_2m.time[1]
1.7935344E9

precipitation_amount.precipitation_amount[1][1][1]
[0][0], 0.4

relative_humidity_2m.relative_humidity_2m[1][1][1]
[0][0], 0.873

cloud_area_fraction.cloud_area_fraction[1][1][1]
[0][0], 1.0

wind_speed_10m.wind_speed_10m[1][1][1]
[0][0], 3.25

precipitation_amount.time[1]
1.7935344E9
`

// fill asks until every hour is in, as a browser does.
func fill(t *testing.T, c *Client, cell Cell, start, end time.Time) []Hour {
	t.Helper()
	for i := 0; i < 200; i++ {
		hs, inc := c.Series(context.Background(), cell, start, end)
		if !inc {
			return hs
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("never complete")
	return nil
}

func TestSeries(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if strings.Contains(r.URL.Path, "/meps25epsarchive/") {
			gusts(t, w, r)
			return
		}
		if !strings.Contains(r.URL.RawQuery, "%5B1159%5D%5B662%5D") && !strings.Contains(r.URL.RawQuery, "[1159][662]") {
			t.Errorf("unexpected query %q", r.URL.RawQuery)
		}
		switch {
		case strings.Contains(r.URL.Path, "T11Z"):
			http.NotFound(w, r) // a gap in the archive
		case strings.Contains(r.URL.Path, "T12Z"):
			fmt.Fprint(w, strings.Replace(sample, "277.39926", "NaN", 1))
		default:
			fmt.Fprint(w, sample)
		}
	}))
	defer srv.Close()
	now := time.Date(2026, 11, 3, 15, 30, 0, 0, time.UTC)
	c := New(srv.URL, "test")
	c.Now, c.Interval = func() time.Time { return now }, time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	cell := Cell{662, 1159}
	start := time.Date(2026, 11, 1, 9, 30, 0, 0, time.UTC)
	end := start.Add(4 * time.Hour)
	if hs, inc := c.Series(context.Background(), cell, start, end); len(hs) != 0 || !inc {
		t.Fatal("nothing cached yet")
	}
	hs := fill(t, c, cell, start, end)
	// 10, 11 (missing), 12 (no temperature), 13.
	if len(hs) != 3 || hs[0].T.Hour() != 10 || hs[1].T.Hour() != 12 || hs[2].T.Hour() != 13 {
		t.Fatalf("hours: %+v", hs)
	}
	h := hs[0]
	if *h.TempC != 4.25 || *h.PrecipMM != 0.4 || *h.HumidityPct != 87.3 || *h.CloudPct != 100 || *h.WindMS != 3.25 || *h.GustMS != 5 || hs[1].TempC != nil {
		t.Fatalf("values: %+v %+v", hs[0], hs[1])
	}
	n := hits.Load()
	if _, inc := c.Series(context.Background(), cell, start, end); inc || hits.Load() != n {
		t.Fatalf("old hours, present or missing, are cached: %d -> %d", n, hits.Load())
	}
	// Hours not yet over are not asked for.
	if hs := fill(t, c, cell, now.Add(-90*time.Minute), now.Add(2*time.Hour)); len(hs) != 2 {
		t.Fatalf("up to now: %+v", hs)
	}
}

// gusts serves MEPS runs at 09Z and 12Z of 1 November (the 12Z run not
// archived yet), and checks which run and lead hour is asked for.
func gusts(t *testing.T, w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.Contains(r.URL.Path, "20261101T12Z"):
		http.NotFound(w, r)
		return
	case strings.Contains(r.URL.Path, "20261101T09Z"):
	case strings.Contains(r.URL.Path, "20261101"):
		t.Errorf("unexpected run %s", r.URL.Path)
		fallthrough
	default: // other days: not archived
		http.NotFound(w, r)
		return
	}
	// Hours 10, 12 and 13 come from the 09Z run's leads 1, 3 and 4, at the MEPS cell.
	if !strings.Contains(r.URL.RawQuery, "%5B0%5D%5B542%5D%5B330%5D") {
		t.Errorf("unexpected query %q", r.URL.RawQuery)
	}
	fmt.Fprint(w, "x_wind_gust_10m.x_wind_gust_10m[1][1][1][1]\n[0][0][0][0], 3\ny_wind_gust_10m.y_wind_gust_10m[1][1][1][1]\n[0][0][0][0], -4\n")
}

func TestExpiry(t *testing.T) {
	at := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	g := 5.0
	settled, noGust := Hour{T: at, GustMS: &g}, Hour{T: at}
	for _, c := range []struct {
		h       Hour
		after   time.Duration
		missing bool
		want    time.Duration // 0: never
	}{
		{settled, time.Hour, false, freshTTL},
		{settled, 4 * time.Hour, false, 0},
		{noGust, 4 * time.Hour, false, missingTTL}, // its MEPS run may still come
		{noGust, 13 * time.Hour, false, 0},
		{Hour{T: at}, time.Hour, true, missingTTL},
		{Hour{T: at}, 4 * time.Hour, true, goneTTL},
	} {
		fetched := at.Add(c.after)
		got := expiry(c.h, fetched, c.missing)
		if (c.want == 0) != got.IsZero() || (c.want != 0 && got.Sub(fetched) != c.want) {
			t.Errorf("%+v after %s missing %v: %v", c.h, c.after, c.missing, got)
		}
	}
}

func TestBackOffWhenAsked(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Retry-After", "60")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c := New(srv.URL, "")
	c.Interval = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	start := time.Now().Add(-48 * time.Hour)
	c.Series(context.Background(), Cell{1, 1}, start, start.Add(5*time.Hour))
	time.Sleep(50 * time.Millisecond)
	if n := hits.Load(); n != 1 {
		t.Fatalf("%d requests after a 429, want 1", n)
	}
	if _, inc := c.Series(context.Background(), Cell{1, 1}, start, start.Add(5*time.Hour)); !inc {
		t.Fatal("still incomplete")
	}
}
