package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/ingest"
)

// livePublisher sends committed observations to API processes over Redis
// pub/sub as one JSON array per batch.
type livePublisher struct {
	c      *cache.Client
	log    *slog.Logger
	failed atomic.Bool
}

func (p *livePublisher) PublishLive(ctx context.Context, events []ingest.LiveEvent) {
	b, err := json.Marshal(events)
	if err != nil {
		return
	}
	if err := p.c.Publish(ctx, cache.LiveChannel, b); err != nil {
		if !p.failed.Swap(true) {
			p.log.Warn("live publish to Redis failing; API-only processes see no live rows (this process serves its own)", "err", err)
		}
		return
	}
	p.failed.Store(false)
}
