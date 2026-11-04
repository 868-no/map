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
	// warmChunk bounds each lookup: points per Heights call.
	warmChunk = 1000
)

// Warmer queues the heights between every pair of infrastructure nodes
// within MaxLengthM, so cross sections and the classes the engine's signal
// model needs are ready before anyone asks (D-144). It only fills the
// client's queue; the client's worker fetches at its own pace, and points
// already known (memory or store) are never queued again.
type Warmer struct {
	Client   *Client
	Load     func(context.Context) ([]End, error) // the infrastructure nodes' ends
	Interval time.Duration
	Log      *slog.Logger
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

// Once queues every pair's missing heights and returns how many pairs and
// points it looked at.
func (w *Warmer) Once(ctx context.Context) (pairs, points int) {
	ends, err := w.Load(ctx)
	if err != nil {
		if w.Log != nil {
			w.Log.Warn("terrain warm: loading nodes failed", "err", err)
		}
		return 0, 0
	}
	var batch []Point
	flush := func() {
		if len(batch) > 0 {
			w.Client.Heights(ctx, batch)
			points += len(batch)
			batch = batch[:0]
		}
	}
	for i := range ends {
		for j := i + 1; j < len(ends); j++ {
			if ctx.Err() != nil {
				return pairs, points
			}
			a, b := ends[i].Point, ends[j].Point
			if d := Distance(a, b); d > MaxLengthM || d < 1 {
				continue
			}
			pairs++
			batch = append(batch, Points(a, b)...)
			if len(batch) >= warmChunk {
				flush()
			}
		}
	}
	flush()
	if w.Log != nil {
		w.Log.Info("terrain warm queued", "nodes", len(ends), "pairs", pairs, "points", points, "waiting", w.Client.Waiting())
	}
	return pairs, points
}
