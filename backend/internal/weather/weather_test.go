package weather

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
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

integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time.integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time[1][1][1]
[0][0], 409000.0

precipitation_amount.time[1]
1.7935344E9
`

// fill asks until every hour is in, as a browser does.
func fill(t *testing.T, c *Client, cell Cell, start, end time.Time) []Hour {
	t.Helper()
	for i := 0; i < 2000; i++ {
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
	// Lead 1's gust: (3, -4) × 2/2.
	if *h.TempC != 4.25 || *h.PrecipMM != 0.4 || *h.HumidityPct != 87.3 || *h.CloudPct != 100 || *h.WindMS != 3.25 || *h.SunWM2 != 113.61 || *h.GustMS != 5 || hs[1].TempC != nil {
		t.Fatalf("values: %+v %+v", hs[0], hs[1])
	}
	if *hs[2].GustMS != 12.5 {
		t.Fatalf("lead 4's gust: %v", *hs[2].GustMS)
	}
	if n := gustRuns.Load(); n != 1 {
		t.Fatalf("%d requests for the 09Z run, want 1", n)
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
var gustRuns atomic.Int32

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
	// One request reads the 09Z run's first nine hours at the MEPS cell;
	// hours 10, 12 and 13 are its leads 1, 3 and 4.
	gustRuns.Add(1)
	if !strings.Contains(r.URL.RawQuery, "%5B0:8%5D%5B0%5D%5B542%5D%5B330%5D") {
		t.Errorf("unexpected query %q", r.URL.RawQuery)
	}
	var b strings.Builder
	for _, name := range []string{"x_wind_gust_10m", "y_wind_gust_10m"} {
		fmt.Fprintf(&b, "%s.%s[9][1][1][1]\n", name, name)
		for i := range 9 {
			v := map[string]float64{"x_wind_gust_10m": 3, "y_wind_gust_10m": -4}[name] * float64(i+1) / 2
			fmt.Fprintf(&b, "[%d][0][0], %g\n", i, v)
		}
		b.WriteString("\n")
	}
	fmt.Fprint(w, b.String())
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

// Keep fills the sites' cells in the background, and a visitor's request
// goes ahead of that backlog.
func TestKeepYieldsToVisitors(t *testing.T) {
	var mu sync.Mutex
	var order []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/meps25epsarchive/") {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		order = append(order, r.URL.RawQuery)
		mu.Unlock()
		fmt.Fprint(w, sample)
	}))
	defer srv.Close()
	now := time.Date(2026, 11, 3, 15, 30, 0, 0, time.UTC)
	c := New(srv.URL, "")
	c.Now, c.Interval = func() time.Time { return now }, time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	kept, other, visitor := Cell{100, 100}, Cell{150, 150}, Cell{200, 200}
	// The backlog is queued before the worker starts, so the visitor comes in behind it.
	go c.Keep(ctx, time.Hour, 48*time.Hour, func(context.Context) ([]Cell, error) { return []Cell{kept, other}, nil })
	for c.pending() < 96 {
		time.Sleep(time.Millisecond)
	}
	c.Series(ctx, visitor, now.Add(-3*time.Hour), now)
	go c.Run(ctx)
	fill(t, c, visitor, now.Add(-3*time.Hour), now)
	mu.Lock()
	first := append([]string(nil), order[:3]...)
	mu.Unlock()
	for _, q := range first {
		if !strings.Contains(q, "%5B200%5D%5B200%5D") {
			t.Fatalf("background work went first: %v", first)
		}
	}
	// Then a day at a time across the kept cells, newest first: both have
	// their last day before either goes further back.
	fill(t, c, other, now.Add(-24*time.Hour), now)
	mu.Lock()
	firsts := 0
	for _, q := range order {
		if strings.Contains(q, "%5B100%5D%5B100%5D") {
			firsts++
		}
	}
	mu.Unlock()
	if firsts > 25 {
		t.Fatalf("the first kept cell had %d hours fetched before the other's last day", firsts)
	}
	if hs := fill(t, c, kept, now.Add(-48*time.Hour), now); len(hs) != 48 {
		t.Fatalf("kept cell: %d hours", len(hs))
	}
}

// A browser re-polling an incomplete chart does not queue its hours again,
// but a visitor's hour waiting in the background queue moves up front.
func TestQueueOnce(t *testing.T) {
	now := time.Date(2026, 11, 3, 15, 30, 0, 0, time.UTC)
	c := New("http://127.0.0.1:0", "")
	c.Now = func() time.Time { return now }
	ctx := context.Background()
	kept, visitor := Cell{100, 100}, Cell{200, 200}
	c.series(ctx, "", kept, now.Add(-6*time.Hour), now, false)
	c.series(ctx, "", kept, now.Add(-6*time.Hour), now, false)
	for range 5 {
		c.Series(ctx, visitor, now.Add(-3*time.Hour), now)
	}
	if c.queue.UrgentLen() != 3 || c.queue.BackgroundLen() != 6 {
		t.Fatalf("urgent %d, background %d; want 3, 6", c.queue.UrgentLen(), c.queue.BackgroundLen())
	}
	c.Series(ctx, kept, now.Add(-2*time.Hour), now)
	c.Series(ctx, kept, now.Add(-2*time.Hour), now)
	if c.queue.UrgentLen() != 5 || c.queue.BackgroundLen() != 6 {
		t.Fatalf("after promotion: urgent %d, background %d; want 5, 6", c.queue.UrgentLen(), c.queue.BackgroundLen())
	}
}

// Visitors are served in turn (D-141): one asking for weeks of hours delays
// another's few by one fetch each, and holds at most maxPerClient. When the
// queue is full, the visitor holding the most makes room for others.
func TestVisitorsTakeTurns(t *testing.T) {
	now := time.Date(2026, 11, 3, 15, 30, 0, 0, time.UTC)
	c := New("http://127.0.0.1:0", "")
	c.Now = func() time.Time { return now }
	ctx := context.Background()
	for x := range 10 {
		c.SeriesFor(ctx, "greedy", Cell{x, 0}, now.Add(-30*24*time.Hour), now)
	}
	if n := c.queue.ClientLen("greedy"); n != maxPerClient {
		t.Fatalf("greedy holds %d hours, want the cap %d", n, maxPerClient)
	}
	c.SeriesFor(ctx, "visitor", Cell{0, 1}, now.Add(-3*time.Hour), now)
	var order []string
	for range 6 {
		k, _ := c.queue.Pop()
		id := "greedy"
		if k.c == (Cell{0, 1}) {
			id = "visitor"
		}
		order = append(order, id)
	}
	if want := []string{"greedy", "visitor", "greedy", "visitor", "greedy", "visitor"}; !slices.Equal(order, want) {
		t.Errorf("served %v, want %v", order, want)
	}

	// A full queue: a newcomer takes the greedy visitor's last hours.
	c = New("http://127.0.0.1:0", "")
	c.Now = func() time.Time { return now }
	for i := range maxQueue/maxPerClient + 1 {
		for x := range 10 {
			c.SeriesFor(ctx, fmt.Sprint("greedy", i), Cell{x, i}, now.Add(-30*24*time.Hour), now)
		}
	}
	if c.queue.UrgentLen() != maxQueue {
		t.Fatalf("%d hours queued, want the cap %d", c.queue.UrgentLen(), maxQueue)
	}
	if _, inc := c.SeriesFor(ctx, "visitor", Cell{0, 999}, now.Add(-3*time.Hour), now); !inc || c.queue.ClientLen("visitor") != 3 {
		t.Errorf("a newcomer to a full queue got %d of its 3 hours queued", c.queue.ClientLen("visitor"))
	}
	if c.queue.UrgentLen() != maxQueue || c.queue.Keys() != maxQueue {
		t.Errorf("queue %d, index %d after making room; want %d", c.queue.UrgentLen(), c.queue.Keys(), maxQueue)
	}
}

// A failed gust request keeps the analysis hour, without its gust.
func TestGustFailureKeepsHour(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/meps25epsarchive/") {
			http.Error(w, "broken", http.StatusInternalServerError)
			return
		}
		fmt.Fprint(w, sample)
	}))
	defer srv.Close()
	now := time.Date(2026, 11, 3, 15, 30, 0, 0, time.UTC)
	c := New(srv.URL, "")
	c.Now, c.Interval = func() time.Time { return now }, time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	cell := Cell{662, 1159}
	hs := fill(t, c, cell, now.Add(-8*time.Hour), now.Add(-6*time.Hour))
	if len(hs) != 2 || hs[0].TempC == nil || hs[0].GustMS != nil {
		t.Fatalf("hours: %+v", hs)
	}
}

// A failed gust request is not "no run has it": even an hour long past the
// MEPS delay is asked again soon, and gets its gust once the archive answers.
func TestGustFailureOnOldHourIsRetried(t *testing.T) {
	defer gustRuns.Store(gustRuns.Load())
	var failing atomic.Bool
	failing.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/meps25epsarchive/") {
			if failing.Load() {
				http.Error(w, "busy", http.StatusBadGateway)
				return
			}
			gusts(t, w, r)
			return
		}
		fmt.Fprint(w, sample)
	}))
	defer srv.Close()
	var now atomic.Int64
	now.Store(time.Date(2026, 11, 3, 15, 30, 0, 0, time.UTC).Unix())
	c := New(srv.URL, "")
	c.Now, c.Interval = func() time.Time { return time.Unix(now.Load(), 0).UTC() }, time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	cell := Cell{662, 1159}
	start := time.Date(2026, 11, 1, 9, 30, 0, 0, time.UTC) // hour 10, two days old
	end := start.Add(time.Hour)
	if hs := fill(t, c, cell, start, end); len(hs) != 1 || hs[0].TempC == nil || hs[0].GustMS != nil {
		t.Fatalf("while gusts fail: %+v", hs)
	}
	failing.Store(false)
	now.Add(int64((missingTTL + time.Minute) / time.Second))
	if _, inc := c.Series(context.Background(), cell, start, end); !inc {
		t.Fatal("an old hour whose gust request failed was kept as settled")
	}
	if hs := fill(t, c, cell, start, end); len(hs) != 1 || hs[0].GustMS == nil || *hs[0].GustMS != 5 {
		t.Fatalf("after the archive recovered: %+v", hs)
	}
}

// Only hours neither valid in memory nor queued are looked up in the store:
// a queued one was looked up when queued and stays queued until in memory.
func TestUnknownSkipsQueued(t *testing.T) {
	now := time.Date(2026, 11, 3, 15, 30, 0, 0, time.UTC)
	c := New("http://127.0.0.1:0", "")
	cell := Cell{1, 1}
	var ks []key
	for h := range 5 {
		ks = append(ks, key{cell, now.Unix()/3600 - 10 + int64(h)})
	}
	c.queue.PushUrgent("v", ks[0])
	c.queue.PushBackground(ks[4])
	c.cache.Put(ks[2], entry{expires: now.Add(time.Minute)})
	c.cache.Put(ks[3], entry{expires: now.Add(-time.Minute)}) // outdated
	if lo, hi, ok := c.unknown(ks, now); !ok || lo != ks[1] || hi != ks[3] {
		t.Fatalf("unknown [%v, %v] %v, want [%v, %v]", lo, hi, ok, ks[1], ks[3])
	}
	c.cache.Put(ks[1], entry{})
	c.queue.PushBackground(ks[3]) // outdated, but queued
	if _, _, ok := c.unknown(ks, now); ok {
		t.Fatal("every hour is cached or queued")
	}
}
