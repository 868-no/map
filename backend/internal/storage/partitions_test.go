package storage

import (
	"testing"
	"time"
)

func TestPartitionNamesRoundTrip(t *testing.T) {
	for mo := time.January; mo <= time.December; mo++ {
		m := time.Date(2026, mo, 1, 0, 0, 0, 0, time.UTC)
		p := partitionRe.FindStringSubmatch(PartitionName(m))
		if p == nil || p[1] != "2026" {
			t.Fatalf("%s: %v", PartitionName(m), p)
		}
		if got := Month(m.Add(17*24*time.Hour + 5*time.Hour)); !got.Equal(m) {
			t.Fatalf("Month: %s, want %s", got, m)
		}
	}
	// Months are UTC: 23:30 on 31 Oct in UTC-2 is already November.
	if got := Month(time.Date(2026, 10, 31, 23, 30, 0, 0, time.FixedZone("x", -2*3600))); got.Month() != time.November {
		t.Fatalf("Month in UTC: %s", got)
	}
}
