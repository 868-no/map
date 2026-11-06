package window

import (
	"errors"
	"testing"
	"time"
)

var now = time.Date(2026, 10, 31, 12, 0, 7, 0, time.UTC)

func bounds() Bounds {
	return Bounds{Now: now, Cutoff: now.AddDate(0, -6, 0), MaxDuration: MaxDuration, LiveQuantum: 10 * time.Second}
}

// design §10.2 test 13: start inclusive, end exclusive.
func TestHalfOpen(t *testing.T) {
	w, err := Fixed(now.Add(-24*time.Hour), now, bounds())
	if err != nil {
		t.Fatal(err)
	}
	if !w.Contains(w.Start) || w.Contains(w.Start.Add(-time.Millisecond)) || w.Contains(w.End) {
		t.Fatal("interval must be [start, end)")
	}
}

// design §10.2 test 18: 14 days + 1 s and pre-retention requests are rejected.
func TestRejections(t *testing.T) {
	b := bounds()
	cases := map[string]func() error{
		"14d+1s":    func() error { _, err := Fixed(now.Add(-MaxDuration-time.Second), now, b); return err },
		"retention": func() error { _, err := Fixed(b.Cutoff.Add(-time.Second), b.Cutoff.Add(time.Hour), b); return err },
		"reversed":  func() error { _, err := Fixed(now, now.Add(-time.Hour), b); return err },
		"future":    func() error { _, err := Fixed(now.Add(-time.Hour), now.Add(time.Minute), b); return err },
		"short":     func() error { _, err := Fixed(now.Add(-time.Minute), now, b); return err },
	}
	for name, f := range cases {
		if err := f(); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: want ErrInvalid, got %v", name, err)
		}
	}
	if _, err := Fixed(now.Add(-MaxDuration), now, b); err != nil {
		t.Errorf("exactly 14d must be accepted: %v", err)
	}
}

func TestRollingQuantized(t *testing.T) {
	w, err := Rolling(72*time.Hour, bounds())
	if err != nil {
		t.Fatal(err)
	}
	if !w.End.Equal(time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)) || w.Duration() != 72*time.Hour || !w.Rolling {
		t.Fatalf("got %v..%v", w.Start, w.End)
	}
}

func TestPredicate(t *testing.T) {
	if p := Predicate(1, 2); p != "observed_at >= $1 AND observed_at < $2" {
		t.Fatal(p)
	}
}

func TestRetentionCutoffClampsMonthEnd(t *testing.T) {
	cases := map[time.Time]time.Time{
		time.Date(2026, 8, 31, 3, 0, 0, 0, time.UTC):   time.Date(2026, 2, 28, 3, 0, 0, 0, time.UTC),
		time.Date(2028, 8, 31, 3, 0, 0, 0, time.UTC):   time.Date(2028, 2, 29, 3, 0, 0, 0, time.UTC),
		time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC): time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC):   time.Date(2025, 9, 15, 0, 0, 0, 0, time.UTC),
	}
	for in, want := range cases {
		if got := RetentionCutoff(in, 6); !got.Equal(want) {
			t.Errorf("%s: got %s want %s", in, got, want)
		}
	}
}
