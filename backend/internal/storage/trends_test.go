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
	b := th.Buckets("day", time.UTC, "")
	if len(b) != 2 {
		t.Fatalf("%d buckets", len(b))
	}
	if b[0].Nodes != 3 || b[0].NewNodes != 3 || b[0].Gateways != 1 || b[0].Packets != 5 || b[0].ByType["position"] != 4 {
		t.Fatalf("day 1: %+v", b[0])
	}
	if b[1].Nodes != 2 || b[1].NewNodes != 1 || b[1].Gateways != 1 {
		t.Fatalf("day 2: %+v", b[1])
	}
	if m := th.Buckets("month", time.UTC, ""); len(m) != 1 || m[0].Nodes != 4 || m[0].NewNodes != 4 {
		t.Fatalf("month: %+v", m)
	}
}

func TestBucketsForARegionCountOnlyItsRows(t *testing.T) {
	h0 := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	th := TrendHours{hours: map[time.Time]*HourSummary{
		h0: {Nodes: []int64{1, 2, 3}, Gateways: []int64{8, 9}, Packets: 6, Receptions: 9, ByType: map[string]int{"text": 6},
			Regions: map[string]RegionHour{"Vestlandet": {Nodes: []int64{1, 2}, Gateways: []int64{9}, Packets: 4, Receptions: 5}}},
		h0.Add(24 * time.Hour): {Nodes: []int64{2, 4}, Gateways: []int64{9}, Packets: 2, Receptions: 2,
			Regions: map[string]RegionHour{"Vestlandet": {Nodes: []int64{2, 4}, Gateways: []int64{9}, Packets: 2, Receptions: 2}}},
	}}
	b := th.Buckets("day", time.UTC, "Vestlandet")
	if len(b) != 2 || b[0].Nodes != 2 || b[0].Gateways != 1 || b[0].Packets != 4 || b[0].Receptions != 5 || len(b[0].ByType) != 0 || b[1].NewNodes != 1 {
		t.Fatalf("Vestlandet: %+v", b)
	}
	if o := th.Buckets("day", time.UTC, "Østlandet"); len(o) != 2 || o[0].Nodes != 0 || o[1].Packets != 0 {
		t.Fatalf("a region with no rows: %+v", o)
	}
}

// D-195: per-node figures are kept only when they align with Nodes, and
// clamped to their compact types.
func TestSetNodeFigures(t *testing.T) {
	s := HourSummary{Nodes: []int64{1, 2}}
	s.setNodeFigures([]int32{3, 70000}, []int32{9, 70000}, []int32{-1, 101})
	if s.NodePackets[1] != MaxNodeHourCount || s.NodeReceptions[0] != 9 || s.NodeBattery[0] != NoBattery || s.NodeBattery[1] != BatteryPowered {
		t.Fatalf("figures: %+v", s)
	}
	m := HourSummary{Nodes: []int64{1, 2}}
	m.setNodeFigures([]int32{3}, []int32{9}, []int32{-1})
	if m.NodePackets != nil {
		t.Fatalf("misaligned figures kept: %+v", m)
	}
}

// D-195: one node's hours, bucketed: from its first bucket to the newest
// hour, silent buckets zero, gateway hours counted whether or not it sent,
// and the lowest battery level, external power only when nothing lower.
func TestNodeBuckets(t *testing.T) {
	h0 := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	th := TrendHours{hours: map[time.Time]*HourSummary{
		h0.Add(-24 * time.Hour): {Nodes: []int64{2}, Gateways: []int64{9}, NodePackets: []uint16{1}, NodeReceptions: []uint16{1}, NodeBattery: []int8{NoBattery}},
		h0:                      {Nodes: []int64{1, 2}, Gateways: []int64{1, 9}, NodePackets: []uint16{4, 1}, NodeReceptions: []uint16{10, 1}, NodeBattery: []int8{BatteryPowered, NoBattery}},
		h0.Add(time.Hour):       {Nodes: []int64{1}, Gateways: []int64{9}, NodePackets: []uint16{2}, NodeReceptions: []uint16{2}, NodeBattery: []int8{80}},
		h0.Add(2 * time.Hour):   {Nodes: []int64{2}, Gateways: []int64{1}, NodePackets: []uint16{1}, NodeReceptions: []uint16{1}, NodeBattery: []int8{NoBattery}},
		h0.Add(24 * time.Hour):  {Nodes: []int64{2}, Gateways: []int64{9}, NodePackets: []uint16{1}, NodeReceptions: []uint16{1}, NodeBattery: []int8{NoBattery}},
		h0.Add(48 * time.Hour):  {Nodes: []int64{1}, Gateways: []int64{9}, NodePackets: []uint16{1}, NodeReceptions: []uint16{3}, NodeBattery: []int8{BatteryPowered}},
	}}
	b, ok := th.NodeBuckets(1, "day", time.UTC)
	if !ok || len(b) != 3 {
		t.Fatalf("%v %+v", ok, b)
	}
	if d := b[0]; !d.Start.Equal(time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)) || d.Hours != 3 || d.HoursHeard != 2 || d.HoursGateway != 2 || d.Packets != 6 || d.Receptions != 12 || d.Battery != 80 {
		t.Fatalf("day 1: %+v", d)
	}
	if d := b[1]; d.Hours != 1 || d.HoursHeard != 0 || d.Packets != 0 || d.Battery != NoBattery {
		t.Fatalf("silent day: %+v", d)
	}
	if d := b[2]; d.HoursHeard != 1 || d.Battery != BatteryPowered {
		t.Fatalf("day 3: %+v", d)
	}
	if m, _ := th.NodeBuckets(2, "month", time.UTC); len(m) != 1 || m[0].Hours != 6 || m[0].HoursHeard != 4 || m[0].Packets != 4 || m[0].HoursGateway != 0 {
		t.Fatalf("month of node 2: %+v", m)
	}
	if _, ok := th.NodeBuckets(3, "day", time.UTC); ok {
		t.Fatal("a node never heard has buckets")
	}
	// Heard only as a gateway: still a node with a history.
	if g, ok := th.NodeBuckets(9, "day", time.UTC); !ok || len(g) != 4 || g[0].HoursGateway != 1 || g[0].HoursHeard != 0 {
		t.Fatalf("gateway only: %v %+v", ok, g)
	}
}
