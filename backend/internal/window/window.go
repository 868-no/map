// Package window is the single source of truth for time-window semantics:
// every mesh-derived result is scoped to the half-open UTC interval
// [Start, End) (design §3.5).
package window

import (
	"errors"
	"fmt"
	"time"
)

// Defaults and limits (design §3.5).
const (
	MinDuration     = time.Hour
	MaxDuration     = 7 * 24 * time.Hour
	DefaultDuration = 72 * time.Hour
	ClockSkew       = 5 * time.Second
)

// Window is an immutable, validated interval.
type Window struct {
	Start, End time.Time
	Rolling    bool // live window: boundaries were derived from server "now"
}

// Duration of the window.
func (w Window) Duration() time.Duration { return w.End.Sub(w.Start) }

// Contains reports whether t is inside [Start, End).
func (w Window) Contains(t time.Time) bool {
	return !t.Before(w.Start) && t.Before(w.End)
}

// Bounds are the server-side limits a window must respect.
type Bounds struct {
	Now         time.Time
	Cutoff      time.Time     // configured retention cutoff (now - RETENTION_MONTHS)
	MaxDuration time.Duration // usually MaxDuration
	LiveQuantum time.Duration // rolling windows are floored to this
}

// Error is a client-facing validation error (rendered as RFC 9457 problem).
type Error struct{ Field, Msg string }

func (e *Error) Error() string { return e.Field + ": " + e.Msg }

func bad(field, format string, args ...any) error {
	return &Error{Field: field, Msg: fmt.Sprintf(format, args...)}
}

// ErrInvalid matches any *Error with errors.As.
var ErrInvalid = errors.New("invalid window")

func (e *Error) Is(target error) bool { return target == ErrInvalid }

// Fixed validates an explicit window. It never widens or clamps: anything
// outside the bounds is rejected.
func Fixed(start, end time.Time, b Bounds) (Window, error) {
	start, end = start.UTC(), end.UTC()
	switch {
	case !end.After(start):
		return Window{}, bad("end", "must be after start")
	case end.Sub(start) > b.MaxDuration:
		return Window{}, bad("end", "window longer than %s", b.MaxDuration)
	case end.Sub(start) < MinDuration:
		return Window{}, bad("end", "window shorter than %s", MinDuration)
	case start.Before(b.Cutoff):
		return Window{}, bad("start", "before retention cutoff %s", b.Cutoff.Format(time.RFC3339))
	case end.After(b.Now.Add(ClockSkew)):
		return Window{}, bad("end", "in the future")
	}
	return Window{Start: start, End: end}, nil
}

// Rolling builds the live window [now-d, now) with now floored to the live
// quantum, so concurrent clients share boundaries and cache entries.
func Rolling(d time.Duration, b Bounds) (Window, error) {
	q := b.LiveQuantum
	if q <= 0 {
		q = 10 * time.Second
	}
	end := b.Now.UTC().Truncate(q)
	w, err := Fixed(end.Add(-d), end, Bounds{Now: end, Cutoff: b.Cutoff, MaxDuration: b.MaxDuration})
	if err != nil {
		return Window{}, err
	}
	w.Rolling = true
	return w, nil
}

// Predicate returns the one SQL predicate allowed to filter observed_at,
// with positional parameters for Start/End. All queries
// must use it (enforced by a test scanning the source tree).
func Predicate(startArg, endArg int) string {
	return fmt.Sprintf("observed_at >= $%d AND observed_at < $%d", startArg, endArg)
}

// Args returns the values matching Predicate.
func (w Window) Args() (time.Time, time.Time) { return w.Start, w.End }

// RetentionCutoff is now minus months calendar months, clamped to the end of
// the target month (Aug 31 - 6 months = Feb 28/29), matching PostgreSQL
// interval arithmetic. The API bound and the retention deleter both use it,
// so "older than retention" means the same thing everywhere.
func RetentionCutoff(now time.Time, months int) time.Time {
	now = now.UTC()
	y, m, d := now.Date()
	first := time.Date(y, m, 1, now.Hour(), now.Minute(), now.Second(), now.Nanosecond(), time.UTC).AddDate(0, -months, 0)
	last := time.Date(first.Year(), first.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	return first.AddDate(0, 0, min(d, last)-1)
}
