//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/868-no/map/internal/storage"
)

// dayAnswer is a /observations/day answer: status, cache headers and rows.
type dayAnswer struct {
	code       int
	cc, etag   string
	generation string
	rows       []json.RawMessage
}

func (c *apiClient) day(date, gen string) dayAnswer {
	c.t.Helper()
	resp, err := http.Get(c.srv.URL + "/api/v1/observations/day/" + date + "?" + url.Values{"generation": {gen}}.Encode())
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	a := dayAnswer{code: resp.StatusCode, cc: resp.Header.Get("Cache-Control"), etag: resp.Header.Get("ETag")}
	if resp.StatusCode == http.StatusOK {
		var b struct {
			Generation string            `json:"generation"`
			Rows       []json.RawMessage `json:"rows"`
			More       bool              `json:"more"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&b); err != nil {
			c.t.Fatal(err)
		}
		if b.More {
			c.t.Fatal("a day is one body")
		}
		a.generation, a.rows = b.Generation, b.Rows
	}
	return a
}

// rawRows fetches every page of a window from /observations as raw rows,
// with the generation they came with.
func (c *apiClient) rawRows(q url.Values) ([]json.RawMessage, string) {
	c.t.Helper()
	var all []json.RawMessage
	var gen string
	for {
		var page struct {
			Generation string            `json:"generation"`
			Rows       []json.RawMessage `json:"rows"`
			More       bool              `json:"more"`
			NextCursor string            `json:"next_cursor"`
		}
		if code := c.get("/api/v1/observations", q, &page); code != 200 {
			c.t.Fatalf("observations: HTTP %d", code)
		}
		all, gen = append(all, page.Rows...), page.Generation
		if !page.More {
			return all, gen
		}
		q.Set("cursor", page.NextCursor)
	}
}

func sameRows(a, b []json.RawMessage) bool {
	return slices.EqualFunc(a, b, func(x, y json.RawMessage) bool { return string(x) == string(y) })
}

// A whole day (D-158) is exactly the rows /observations returns for it; once
// final it is immutable and shared through Redis. Rows awaiting a new
// decoding keep it uncached, and an import of history moves the generation
// on both ends and keeps every day uncached while it runs (D-159).
func TestDayMatchesObservations(t *testing.T) {
	pool := freshDB(t)
	rc := redisClient(t)
	ctx := context.Background()
	f := newFixture(t, pool)
	d1 := base                                             // 2026-10-30
	d2 := base.Add(24 * time.Hour)                         // 2026-10-31
	now := base.Add(72 * time.Hour)                        // 2026-11-02 00:00
	f.nodeInfo(d1.Add(-time.Minute), nodeB, gw1, "Before") // the evening before: not in d1
	f.nodeInfo(d1, nodeA, gw1, "Alpha")                    // exactly at midnight: in d1
	f.position(d1.Add(5*time.Hour), nodeA, gw1, 63.4)
	f.telemetry(d1.Add(24*time.Hour-time.Millisecond), nodeA, gw1, 70)
	f.nodeInfo(d2.Add(3*time.Hour), nodeB, gw1, "Bravo")
	f.position(d2.Add(25*time.Hour), nodeB, gw1, 63.5) // the writer got past d2
	c := newAPI(t, pool, rc, now)

	want, gen := c.rawRows(win(d1, d2))
	if len(want) != 3 {
		t.Fatalf("observations of d1: %d rows", len(want))
	}
	// /retention names the same generation, so days can start before /observations (D-170).
	var ret struct {
		Generation string `json:"generation"`
	}
	if code := c.get("/api/v1/retention", nil, &ret); code != 200 || ret.Generation != gen {
		t.Fatalf("retention: HTTP %d, generation %q (want %q)", code, ret.Generation, gen)
	}
	a := c.day("2026-10-30", gen)
	if a.code != 200 || !sameRows(a.rows, want) || a.generation != gen {
		t.Fatalf("day: HTTP %d, %d rows, generation %q (want %q)", a.code, len(a.rows), a.generation, gen)
	}
	if a.cc != "public, max-age=31536000, immutable" || a.etag == "" {
		t.Fatalf("a final day must be immutable: %q %q", a.cc, a.etag)
	}
	if n, err := rc.R.Exists(ctx, "meshmap:obsday:"+gen+":2026-10-30", "meshmap:obsday:"+gen+":2026-10-30:br").Result(); err != nil || n != 2 {
		t.Fatalf("not in Redis: %d %v", n, err)
	}
	// Served from Redis: the same rows even though the database changed under it
	// (it cannot for a final day; this shows the copy is what answers).
	if _, err := pool.Exec(ctx, `DELETE FROM packet_log WHERE source_node_id = $1 AND packet_type = 'telemetry'`, int64(nodeA)); err != nil {
		t.Fatal(err)
	}
	if b := c.day("2026-10-30", gen); b.code != 200 || !sameRows(b.rows, want) {
		t.Fatalf("second answer: HTTP %d, %d rows", b.code, len(b.rows))
	}

	// d2 with a row still decoded by an older decoder: served, not cached.
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET decode_version = decode_version - 1 WHERE source_node_id = $1 AND packet_type = 'nodeinfo'`, int64(nodeB)); err != nil {
		t.Fatal(err)
	}
	want2, _ := c.rawRows(win(d2, d2.Add(24*time.Hour)))
	if b := c.day("2026-10-31", gen); b.code != 200 || b.cc != "no-store" || b.etag != "" || !sameRows(b.rows, want2) || len(want2) != 1 {
		t.Fatalf("stale day: HTTP %d %q, %d rows (want %d)", b.code, b.cc, len(b.rows), len(want2))
	}
	if n, _ := rc.R.Exists(ctx, "meshmap:obsday:"+gen+":2026-10-31").Result(); n != 0 {
		t.Fatal("a day with rows awaiting a new decoding was cached")
	}
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET decode_version = decode_version + 1 WHERE source_node_id = $1 AND packet_type = 'nodeinfo'`, int64(nodeB)); err != nil {
		t.Fatal(err)
	}

	// An import: the generation moves when it starts, days are not final
	// while it runs, and it moves again when it ends.
	before, err := storage.History(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	finish, err := storage.BeginHistoryChange(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	during, err := storage.History(ctx, pool)
	if err != nil || !during.Importing || during.Rev != before.Rev+1 {
		t.Fatalf("during an import: %+v (before %+v) %v", during, before, err)
	}
	if b := c.day("2026-10-31", gen); b.code != http.StatusConflict {
		t.Fatalf("old generation during an import: HTTP %d", b.code)
	}
	_, gen2 := c.rawRows(win(d2, d2.Add(time.Hour)))
	if gen2 == gen {
		t.Fatal("the generation did not move")
	}
	if code := c.get("/api/v1/retention", nil, &ret); code != 200 || ret.Generation != gen2 {
		t.Fatalf("retention during an import: HTTP %d, generation %q (want %q)", code, ret.Generation, gen2)
	}
	if b := c.day("2026-10-31", gen2); b.code != 200 || b.cc != "no-store" {
		t.Fatalf("during an import: HTTP %d %q", b.code, b.cc)
	}
	if err := finish(); err != nil {
		t.Fatal(err)
	}
	after, err := storage.History(ctx, pool)
	if err != nil || after.Importing || after.Rev != before.Rev+2 {
		t.Fatalf("after the import: %+v %v", after, err)
	}
	_, gen3 := c.rawRows(win(d2, d2.Add(time.Hour)))
	if b := c.day("2026-10-31", gen3); gen3 == gen2 || b.code != 200 || b.cc != "public, max-age=31536000, immutable" || !sameRows(b.rows, want2) {
		t.Fatalf("after the import: HTTP %d %q, generation %q", b.code, b.cc, gen3)
	}
	// Today is served up to now and never cached; a day before retention is refused.
	c2 := newAPI(t, pool, rc, d2.Add(26*time.Hour))
	if b := c2.day("2026-11-01", gen3); b.code != 200 || b.cc != "no-store" || len(b.rows) != 1 {
		t.Fatalf("today: HTTP %d %q, %d rows", b.code, b.cc, len(b.rows))
	}
	if b := c2.day("2026-01-01", gen3); b.code != http.StatusBadRequest {
		t.Fatalf("before retention: HTTP %d", b.code)
	}
}
