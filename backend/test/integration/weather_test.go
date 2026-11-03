//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/868-no/map/internal/weather"
)

// Fetched weather hours are kept in weather_hour (D-133): a new client, as
// after a restart, serves them without asking MET Norway again.
func TestWeatherStore(t *testing.T) {
	pool := freshDB(t)
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		fmt.Fprint(w, "air_temperature_2m.air_temperature_2m[1][1][1]\n[0][0], 270.65\nprecipitation_amount.precipitation_amount[1][1][1]\n[0][0], 0.3\n")
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
