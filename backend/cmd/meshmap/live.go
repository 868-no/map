package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"

	"github.com/868-no/map/internal/cache"
)

// liveBacklog bounds the batches waiting for Redis. A browser that misses
// one fills the gap from its next sync, so a stalled Redis drops batches
// rather than holding up the writer that commits them.
const liveBacklog = 16

// livePublisher sends committed observations to API processes over Redis
// pub/sub as one JSON array per batch, as the pipeline encoded it. Publishing
// happens on its own goroutine: the pipeline's writer never waits on Redis.
type livePublisher struct {
	c      *cache.Client
	log    *slog.Logger
	queue  chan json.RawMessage
	failed atomic.Bool
}

// newLivePublisher starts the publishing goroutine, which runs until ctx ends.
func newLivePublisher(ctx context.Context, c *cache.Client, log *slog.Logger) *livePublisher {
	p := &livePublisher{c: c, log: log, queue: make(chan json.RawMessage, liveBacklog)}
	go p.run(ctx)
	return p
}

func (p *livePublisher) PublishLive(_ context.Context, batch json.RawMessage) {
	select {
	case p.queue <- batch:
	default:
		p.fail("live publish to Redis falling behind; dropping batches", nil)
	}
}

func (p *livePublisher) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-p.queue:
			if err := p.c.Publish(ctx, cache.LiveChannel, b); err != nil {
				p.fail("live publish to Redis failing", err)
				continue
			}
			p.failed.Store(false)
		}
	}
}

// fail logs the first failure of a run of them.
func (p *livePublisher) fail(msg string, err error) {
	if !p.failed.Swap(true) {
		p.log.Warn(msg+"; API-only processes see no live rows (this process serves its own)", "err", err)
	}
}
