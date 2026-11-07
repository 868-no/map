//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/weather"
	"github.com/868-no/map/internal/window"
)

// Fetched weather hours are kept in weather_hour (D-133): a new client, as
// after a restart, serves them without asking MET Norway again.
func TestWeatherStore(t *testing.T) {
	pool := freshDB(t)
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		fmt.Fprint(w, "air_temperature_2m.air_temperature_2m[1][1][1]\n[0][0], 270.65\n\nprecipitation_amount.precipitation_amount[1][1][1]\n[0][0], 0.3\n")
	}))
	defer up.Close()
	now := time.Date(2026, 11, 3, 12, 30, 0, 0, time.UTC)
	start, end := now.Add(-6*time.Hour), now
	cell := weather.Cell{X: 662, Y: 1159}
	client := func() *weather.Client {
		c := weather.New(up.URL, "test")
		c.Now, c.Interval, c.Store = func() time.Time { return now }, time.Millisecond, &weather.Store{Pool: pool}
		return c
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := client()
	go c.Run(ctx)
	var hs []weather.Hour
	for i := 0; ; i++ {
		var inc bool
		if hs, inc = c.Series(ctx, cell, start, end); !inc {
			break
		}
		if i > 400 {
			t.Fatal("never complete")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(hs) != 6 || *hs[0].TempC != -2.5 || *hs[0].PrecipMM != 0.3 {
		t.Fatalf("%+v", hs)
	}
	eventually(t, "the last write", func() bool { return count(t, pool, `SELECT count(*) FROM weather_hour`) == 6 })
	if n := count(t, pool, `SELECT count(*) FROM weather_hour`); n != 6 {
		t.Fatalf("%d rows stored", n)
	}
	n := hits.Load()
	// A fresh client (no worker running): settled hours come from the table;
	// the last three hours were fresh when fetched, but are still within their 20 minutes.
	hs, inc := client().Series(ctx, cell, start, end)
	if inc || len(hs) != 6 || *hs[5].TempC != -2.5 || hits.Load() != n {
		t.Fatalf("after a restart: %d hours, incomplete %v, %d more fetches", len(hs), inc, hits.Load()-n)
	}
	// Rows stored by an older version lack later quantities: due again.
	if _, err := pool.Exec(ctx, `UPDATE weather_hour SET version = 1, sun_wm2 = NULL WHERE valid_at = $1`, hs[0].T); err != nil {
		t.Fatal(err)
	}
	if _, inc := client().Series(ctx, cell, start, end); !inc {
		t.Fatal("an old row was served as complete")
	}
}

// A queued hour is not looked up in the store again while it waits (it was
// not there when queued); a stored row never replaces a still-valid hour in
// memory, such as one whose gust request failed and was deliberately not
// stored, so that hour is not fetched again on every poll.
func TestWeatherStoreLookups(t *testing.T) {
	pool := freshDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	now := time.Date(2026, 11, 3, 12, 30, 0, 0, time.UTC)
	cell := weather.Cell{X: 662, Y: 1159}
	store := func(at time.Time, version int) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO weather_hour (cell_x, cell_y, valid_at, temp_c, gust_ms, fetched_at, version)
			VALUES ($1, $2, $3, 1, 2, $4, $5) ON CONFLICT (cell_x, cell_y, valid_at) DO UPDATE SET version = EXCLUDED.version`,
			cell.X, cell.Y, at, now, version); err != nil {
			t.Fatal(err)
		}
	}
	// Queued (no worker runs), then stored by someone else: not looked up.
	a := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	idle := weather.New("http://127.0.0.1:0", "test")
	idle.Now, idle.Store = func() time.Time { return now }, &weather.Store{Pool: pool}
	if _, inc := idle.Series(ctx, cell, a, a.Add(time.Hour)); !inc {
		t.Fatal("an unknown hour is complete")
	}
	store(a, 2)
	if _, inc := idle.Series(ctx, cell, a, a.Add(time.Hour)); !inc {
		t.Fatal("a queued hour was looked up in the store again")
	}

	// The archive's gusts fail: hour b is kept in memory, not stored. The
	// store holds an older row for it (an older version: due again).
	var bHits atomic.Int32
	b := time.Date(2026, 11, 1, 14, 0, 0, 0, time.UTC)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/meps25epsarchive/") {
			http.Error(w, "busy", http.StatusBadGateway)
			return
		}
		if strings.Contains(r.URL.Path, b.Format("20060102T15Z")) {
			bHits.Add(1)
		}
		fmt.Fprint(w, "air_temperature_2m.air_temperature_2m[1][1][1]\n[0][0], 270.65\n\nprecipitation_amount.precipitation_amount[1][1][1]\n[0][0], 0.3\n")
	}))
	defer up.Close()
	store(b, 1)
	c := weather.New(up.URL, "test")
	c.Now, c.Interval, c.Store = func() time.Time { return now }, time.Millisecond, &weather.Store{Pool: pool}
	go c.Run(ctx)
	fill := func(start, end time.Time) {
		t.Helper()
		for i := 0; ; i++ {
			if _, inc := c.Series(ctx, cell, start, end); !inc {
				return
			}
			if i > 400 {
				t.Fatal("never complete")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	fill(b, b.Add(time.Hour))
	if bHits.Load() != 1 {
		t.Fatalf("hour b fetched %d times", bHits.Load())
	}
	// A wider range reads the store again (for the hours around b): b's old
	// row must not replace what memory holds.
	fill(b.Add(-time.Hour), b.Add(2*time.Hour))
	if bHits.Load() != 1 {
		t.Fatalf("hour b fetched again (%d) after its old stored row replaced it in memory", bHits.Load())
	}
}

// Only routers heard lately have their weather kept (D-133): a router that
// fell silent, a node that stopped being a router, a client and a router
// without a position drop out; the latest role and position count.
func TestLiveRouters(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	if err := storage.EnsurePartitions(ctx, pool, now.AddDate(0, 0, -8), now); err != nil {
		t.Fatal(err)
	}
	n := 0
	row := func(node int, typ string, ago time.Duration, meta string) {
		n++
		if _, err := pool.Exec(ctx, `INSERT INTO packet_log (observed_at, broker_id, mqtt_topic, source_node_id, packet_type, logical_packet_key, observation_key, signature_status, decode_version, envelope_bytes, decoded_metadata)
			VALUES ($1, 't', 't', $2, $3, '\x00', $4, 'unsigned', 1, '\x00', $5::jsonb)`, now.Add(-ago), node, typ, []byte(fmt.Sprint(n)), meta); err != nil {
			t.Fatal(err)
		}
	}
	role := func(r string) string { return `{"nodeinfo": {"role": "` + r + `"}}` }
	pos := func(lat, lon float64) string { return fmt.Sprintf(`{"position": {"lat": %g, "lon": %g}}`, lat, lon) }
	// 1: a live router, moved: its latest position counts.
	row(1, "nodeinfo", 48*time.Hour, role("ROUTER"))
	row(1, "position", 40*time.Hour, pos(63.1, 10.1))
	row(1, "position", 2*time.Hour, pos(63.4, 10.4))
	// 2: a router silent for two days.
	row(2, "nodeinfo", 50*time.Hour, role("ROUTER"))
	row(2, "position", 50*time.Hour, pos(63.2, 10.2))
	// 3: a router, now a client.
	row(3, "nodeinfo", 50*time.Hour, role("ROUTER_LATE"))
	row(3, "position", 3*time.Hour, pos(63.3, 10.3))
	row(3, "nodeinfo", time.Hour, role("CLIENT"))
	// 4: a live ROUTER_LATE that announced itself in a map report, with its position.
	row(4, "mapreport", 5*time.Hour, `{"mapreport": {"role": "ROUTER_LATE"}, "position": {"lat": 63.5, "lon": 10.5}}`)
	// 5: a live router without a position; 6: one heard only as invalid.
	row(5, "nodeinfo", time.Hour, role("ROUTER"))
	row(6, "nodeinfo", 30*time.Hour, role("ROUTER"))
	row(6, "position", 30*time.Hour, pos(63.6, 10.6))
	row(6, "invalid", time.Hour, `{}`)
	week := window.Window{Start: now.Add(-7 * 24 * time.Hour), End: now}
	day := window.Window{Start: now.Add(-24 * time.Hour), End: now}
	nodes, err := storage.Infrastructure(ctx, pool, week, day.Start)
	if err != nil {
		t.Fatal(err)
	}
	type site struct {
		Node     uint32
		Lat, Lon float64
	}
	var got []site
	for _, n := range nodes {
		if n.Router() && n.Heard {
			got = append(got, site{n.Node, n.Lat, n.Lon})
		}
	}
	want := []site{{1, 63.4, 10.4}, {4, 63.5, 10.5}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if cells := weather.Cells(nodes); len(cells) != 2 {
		t.Fatalf("cells %v, want the two live routers'", cells)
	}
}
