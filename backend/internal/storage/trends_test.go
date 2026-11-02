package storage

import (
	"testing"
	"time"
)

func TestBucketStart(t *testing.T) {
	oslo, _ := time.LoadLocation("Europe/Oslo")
	at := time.Date(2026, 11, 4, 22, 30, 0, 0, time.UTC) // Thursday 23:30 in Oslo
	cases := []struct {
		unit string
		want time.Time
	}{
		{"day", time.Date(2026, 11, 4, 0, 0, 0, 0, oslo)},
		{"week", time.Date(2026, 11, 2, 0, 0, 0, 0, oslo)}, // Monday
		{"month", time.Date(2026, 11, 1, 0, 0, 0, 0, oslo)},
	}
	for _, c := range cases {
		if got := bucketStart(at, c.unit, oslo); !got.Equal(c.want) {
			t.Errorf("%s: %v, want %v", c.unit, got, c.want)
		}
	}
	// 23:30 UTC is already the next day in Oslo.
	if got := bucketStart(time.Date(2026, 11, 4, 23, 30, 0, 0, time.UTC), "day", oslo); !got.Equal(time.Date(2026, 11, 5, 0, 0, 0, 0, oslo)) {
		t.Errorf("local midnight: %v", got)
	}
	// 25 October 2026, when summer time ends, is a 25-hour day in Oslo: its
	// first and last UTC hours share the bucket, and the next hour starts the 26th.
	first, lastH := bucketStart(time.Date(2026, 10, 24, 22, 0, 0, 0, time.UTC), "day", oslo), bucketStart(time.Date(2026, 10, 25, 22, 59, 0, 0, time.UTC), "day", oslo)
	if !first.Equal(lastH) || !first.Equal(time.Date(2026, 10, 25, 0, 0, 0, 0, oslo)) {
		t.Errorf("DST day: %v and %v", first, lastH)
	}
	if next := bucketStart(time.Date(2026, 10, 25, 23, 0, 0, 0, time.UTC), "day", oslo); !next.Equal(time.Date(2026, 10, 26, 0, 0, 0, 0, oslo)) {
		t.Errorf("after the DST day: %v", next)
	}
}

func TestBucketsUnionNodesAndCountNewOnce(t *testing.T) {
	h0 := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	th := TrendHours{hours: map[time.Time]*HourSummary{
		h0:                     {Nodes: []int64{1, 2}, Gateways: []int64{9}, Packets: 3, Receptions: 5, ByType: map[string]int{"position": 3}},
		h0.Add(time.Hour):      {Nodes: []int64{2, 3}, Gateways: []int64{9}, Packets: 2, Receptions: 2, ByType: map[string]int{"position": 1, "text": 1}},
		h0.Add(24 * time.Hour): {Nodes: []int64{1, 4}, Gateways: []int64{8}, Packets: 1, Receptions: 1, ByType: map[string]int{"text": 1}},
	}}
	b := th.Buckets("day", time.UTC)
	if len(b) != 2 {
		t.Fatalf("%d buckets", len(b))
	}
	if b[0].Nodes != 3 || b[0].NewNodes != 3 || b[0].Gateways != 1 || b[0].Packets != 5 || b[0].ByType["position"] != 4 {
		t.Fatalf("day 1: %+v", b[0])
	}
	if b[1].Nodes != 2 || b[1].NewNodes != 1 || b[1].Gateways != 1 {
		t.Fatalf("day 2: %+v", b[1])
	}
	if m := th.Buckets("month", time.UTC); len(m) != 1 || m[0].Nodes != 4 || m[0].NewNodes != 4 {
		t.Fatalf("month: %+v", m)
	}
}
