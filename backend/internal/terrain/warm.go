package terrain

import (
	"context"
	"log/slog"
	"time"
)

const (
	// WarmInterval is how often the warmer looks for infrastructure pairs
	// whose heights are not yet known. Terrain does not change, so after the
	// first pass only new or moved nodes add work.
	WarmInterval = time.Hour
	// WarmWindow is how far back a node's role and position are looked for.
	WarmWindow = 14 * 24 * time.Hour
	// warmQueue is how many points the warmer keeps waiting: it queues more
	// as the worker fetches them, rather than filling the queue at once.
	warmQueue = 10_000
)

// warmPoll is how often a warmer waiting for the queue to drain looks again.
var warmPoll = time.Second

// Warmer queues the heights between every pair of infrastructure nodes
// within MaxLengthM, so cross sections and the classes the engine's signal
// model needs are ready before anyone asks (D-144). It queues only points
// the store lacks, in the client's background queue behind every visitor's,
// a few thousand at a time as the worker drains them, and remembers the
// pairs found complete so later passes skip them (D-147).
type Warmer struct {
	Client   *Client
	Load     func(context.Context) ([]End, error) // the infrastructure nodes' ends
	Interval time.Duration
	Log      *slog.Logger

	done map[[2]Key]bool // pairs whose every height is stored, by their ends' grid points
}

// Run warms at once, then every Interval, until ctx ends.
func (w *Warmer) Run(ctx context.Context) {
	every := w.Interval
	if every <= 0 {
		every = WarmInterval
	}
	t := time.NewTimer(0)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.Once(ctx)
			t.Reset(every)
		}
	}
}

// Once queues every pair's missing heights and returns how many pairs it
// looked at and how many points it queued.
func (w *Warmer) Once(ctx context.Context) (pairs, points int) {
	ends, err := w.Load(ctx)
	if err != nil {
		w.warn("terrain warm: loading nodes failed", err)
		return 0, 0
	}
	done := map[[2]Key]bool{}
	defer func() { w.done = done }() // pairs gone since are forgotten
	for i := range ends {
		for j := i + 1; j < len(ends); j++ {
			a, b := ends[i].Point, ends[j].Point
			if !Covered(a) || !Covered(b) {
				continue
			}
			if d := Distance(a, b); d > MaxLengthM || d < 1 {
				continue
			}
			pairs++
			pk := [2]Key{keyOf(a), keyOf(b)}
			if w.done[pk] {
				done[pk] = true
				continue
			}
			for w.Client.backgroundWaiting() >= warmQueue {
				select {
				case <-ctx.Done():
					return pairs, points
				case <-time.After(warmPoll):
				}
			}
			if ctx.Err() != nil {
				return pairs, points
			}
			keys := dedupe(Points(a, b))
			missing, waiting, err := w.Client.missing(ctx, keys)
			if err != nil {
				w.warn("terrain warm: store read failed", err)
				continue
			}
			if len(missing) == 0 && waiting == 0 {
				done[pk] = true
				continue
			}
			points += w.Client.queueBackground(missing)
		}
	}
	if w.Log != nil {
		w.Log.Info("terrain warm queued", "nodes", len(ends), "pairs", pairs, "points", points, "waiting", w.Client.Waiting())
	}
	return pairs, points
}

func (w *Warmer) warn(msg string, err error) {
	if w.Log != nil {
		w.Log.Warn(msg, "err", err)
	}
}
