package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/obsrow"
)

// A delta is encoded once and delivered as those bytes to every subscriber;
// a subscriber that falls behind loses events and is flagged so the stream
// tells it to sync.
func TestHubEncodesOnceAndFlagsDrops(t *testing.T) {
	h := NewHub(true)
	fast, _, unsubFast := h.subscribe()
	defer unsubFast()
	slow, slowSub, unsubSlow := h.subscribe()
	defer unsubSlow()
	row, _ := json.Marshal(obsrow.ObsRow{ID: 7, Source: 1, Type: "text"})
	ev, _ := json.Marshal([]ingest.LiveEvent{{ID: 7, T: time.UnixMilli(1_800_000_000_000).UTC(), Row: row}})
	h.PublishLive(context.Background(), ev)
	a, b := <-fast, <-slow
	if string(a.delta) != string(b.delta) || len(a.delta) == 0 {
		t.Fatalf("deltas differ or empty: %s / %s", a.delta, b.delta)
	}
	var got LiveDelta
	if err := json.Unmarshal(a.delta, &got); err != nil || len(got.Events) != 1 || got.Events[0].Row.ID != 7 {
		t.Fatalf("delta %s: %v", a.delta, err)
	}
	if out, _ := json.Marshal(LiveDelta{raw: a.delta}); string(out) != string(a.delta) {
		t.Fatalf("raw delta re-encoded: %s", out)
	}
	for i := 0; i < cap(slow)+5; i++ { // the slow subscriber never reads
		h.PublishLive(context.Background(), ev)
		<-fast
	}
	if !slowSub.dropped.Load() {
		t.Fatal("dropped events not flagged")
	}
}
