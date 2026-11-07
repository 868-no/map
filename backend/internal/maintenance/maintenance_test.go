package maintenance

import (
	"context"
	"testing"
	"time"
)

// Daily runs land at 03:00 UTC whatever the local zone, a failed run is
// retried after 5 minutes, and other intervals are kept as given.
func TestNextRun(t *testing.T) {
	oslo, err := time.LoadLocation("Europe/Oslo")
	if err != nil {
		t.Skip("no time zone data:", err)
	}
	day := 24 * time.Hour
	for _, c := range []struct {
		now      time.Time
		interval time.Duration
		ok       bool
		want     time.Duration
	}{
		{time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC), day, true, 2 * time.Hour},
		{time.Date(2026, 11, 8, 3, 0, 0, 0, time.UTC), day, true, day}, // just ran: tomorrow
		{time.Date(2026, 11, 8, 3, 0, 1, 0, time.UTC), day, true, day - time.Second},
		{time.Date(2026, 11, 8, 23, 30, 0, 0, time.UTC), day, true, 3*time.Hour + 30*time.Minute},
		{time.Date(2026, 11, 8, 3, 30, 0, 0, oslo), day, true, 30 * time.Minute}, // 02:30 UTC
		{time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC), day, false, 5 * time.Minute},
		{time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC), 6 * time.Hour, true, 6 * time.Hour},
		{time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC), 6 * time.Hour, false, 5 * time.Minute},
	} {
		if got := nextRun(c.now, c.interval, c.ok); got != c.want {
			t.Errorf("nextRun(%s, %s, %v) = %s, want %s", c.now, c.interval, c.ok, got, c.want)
		}
	}
}

// Without Redis there is no shared status, and nothing to announce to.
func TestNoCache(t *testing.T) {
	if st, err := LastStatus(context.Background(), nil); st != nil || err != nil {
		t.Fatalf("LastStatus without Redis: %v, %v", st, err)
	}
	(&Runner{}).publish(context.Background(), Status{DeletedRows: 5}) // must not panic
}
