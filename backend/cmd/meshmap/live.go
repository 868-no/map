package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/868-no/map/internal/cache"
)

// liveBacklog bounds the batches waiting for Redis. A browser that misses
// one fills the gap from its next sync, so a stalled Redis drops batches
// rather than holding up the writer that commits them.
const liveBacklog = 16

// livePublisher sends committed observations to API processes over Redis
// pub/sub as one JSON array per batch, as the pipeline encoded it. Publishing
// happens on its own goroutine: the pipeline's writer never waits on Redis.
// It lives until close, after the pipeline's shutdown drain, so rows that
// drain commits are published too.
type livePublisher struct {
	publish func(context.Context, json.RawMessage) error
	log     *slog.Logger
	mu      sync.RWMutex // PublishLive sends under the read lock; close closes queue under the write lock
	closed  bool
	queue   chan json.RawMessage
	done    chan struct{}
	failed  atomic.Bool
}

// newLivePublisher starts the publishing goroutine, which runs until close.
func newLivePublisher(c *cache.Client, log *slog.Logger) *livePublisher {
	return startLivePublisher(func(ctx context.Context, b json.RawMessage) error {
		return c.Publish(ctx, cache.LiveChannel, b) // under the client's own deadline
	}, log)
}

func startLivePublisher(publish func(context.Context, json.RawMessage) error, log *slog.Logger) *livePublisher {
	p := &livePublisher{publish: publish, log: log, queue: make(chan json.RawMessage, liveBacklog), done: make(chan struct{})}
	go p.run()
	return p
}

func (p *livePublisher) PublishLive(_ context.Context, batch json.RawMessage) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed {
		return
	}
	select {
	case p.queue <- batch:
	default:
		p.fail("live publish to Redis falling behind; dropping batches", nil)
	}
}

func (p *livePublisher) run() {
	defer close(p.done)
	for b := range p.queue {
		if err := p.publish(context.Background(), b); err != nil {
			p.fail("live publish to Redis failing", err)
			continue
		}
		p.failed.Store(false)
	}
}

// close publishes the batches still waiting, for at most wait, then stops.
// Call it once the pipeline has stopped publishing.
func (p *livePublisher) close(wait time.Duration) {
	p.mu.Lock()
	if !p.closed {
		p.closed = true
		close(p.queue)
	}
	p.mu.Unlock()
	select {
	case <-p.done:
	case <-time.After(wait):
		p.log.Warn("live publish to Redis still busy at shutdown; the last batches may be lost")
	}
}

// fail logs the first failure of a run of them.
func (p *livePublisher) fail(msg string, err error) {
	if !p.failed.Swap(true) {
		p.log.Warn(msg+"; API-only processes see no live rows (this process serves its own)", "err", err)
	}
}
