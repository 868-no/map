//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/868-no/map/internal/query"
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
	time.Sleep(50 * time.Millisecond) // the last write
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
}

// Only routers heard lately have their weather kept (D-133): a router that
// fell silent, a node that stopped being a router, a client and a router
// without a position drop out; the latest role and position count.
func TestRouterSites(t *testing.T) {
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
	sites, err := query.RouterSites(ctx, pool, week, day)
	if err != nil {
		t.Fatal(err)
	}
	want := []query.RouterSite{{Node: 1, Lat: 63.4, Lon: 10.4}, {Node: 4, Lat: 63.5, Lon: 10.5}}
	if !slices.Equal(sites, want) {
		t.Fatalf("got %+v, want %+v", sites, want)
	}
}
