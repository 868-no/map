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
	for range cap(slow) + 5 { // the slow subscriber never reads
		h.PublishLive(context.Background(), ev)
		<-fast
	}
	if !slowSub.dropped.Load() {
		t.Fatal("dropped events not flagged")
	}
}

// A change of availability reaches a subscriber whose event queue is full,
// and one that went down and up again before the stream looked is flagged,
// so the stream reports the outage and the client syncs.
func TestHubStatusBypassesAFullQueue(t *testing.T) {
	h := NewHub(true)
	ch, sub, unsub := h.subscribe()
	defer unsub()
	ev, _ := json.Marshal([]ingest.LiveEvent{{ID: 1, T: time.UnixMilli(1_800_000_000_000).UTC(), Row: json.RawMessage(`{}`)}})
	for range cap(ch) + 1 {
		h.PublishLive(context.Background(), ev)
	}
	if !sub.dropped.Load() {
		t.Fatal("queue not full")
	}
	h.setAvailable(false)
	select {
	case <-sub.status:
	default:
		t.Fatal("going down not signalled to a full subscriber")
	}
	if h.Available() || !sub.wentDown.Load() {
		t.Fatal("outage not recorded")
	}
	h.setAvailable(true)
	h.setAvailable(true) // no change: no second signal
	select {
	case <-sub.status:
	default:
		t.Fatal("coming back not signalled")
	}
	select {
	case <-sub.status:
		t.Fatal("signalled without a change")
	default:
	}
	if !h.Available() || !sub.wentDown.Swap(false) {
		t.Fatal("the outage meanwhile was forgotten")
	}
}

// The pipeline's hand-encoded live batch reads exactly as the documented
// LiveEvent would encode, so the two types cannot drift apart.
func TestLiveBatchMatchesDocumentedEvent(t *testing.T) {
	g, snr := uint32(7), float32(-4.25)
	rows := []obsrow.ObsRow{
		{ID: 1, T: 1_700_000_000_123, Broker: "b", Gateway: &g, Source: 5, Type: "position", Logical: "0a", Reception: "0b", SNR: &snr},
		{ID: 2, T: 1_700_000_000_456, Broker: "b", Source: 6, Type: "text", Logical: "0c", Reception: "0d"},
	}
	at := []time.Time{time.UnixMilli(1_700_000_000_123).UTC(), time.Date(2026, 11, 6, 10, 0, 0, 500, time.FixedZone("x", 3600))}
	var events []ingest.LiveEvent
	var want []LiveEvent
	for i, r := range rows {
		b, err := json.Marshal(r)
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, ingest.LiveEvent{ID: r.ID, T: at[i], Row: b})
		want = append(want, LiveEvent{ID: r.ID, T: at[i], Row: r})
	}
	exp, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if got := ingest.EncodeLiveBatch(events); string(got) != string(exp) {
		t.Fatalf("batch\n got %s\nwant %s", got, exp)
	}
	if got := ingest.EncodeLiveBatch(nil); string(got) != "[]" {
		t.Fatalf("empty batch: %s", got)
	}
}
