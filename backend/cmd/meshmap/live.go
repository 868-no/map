package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"

	"github.com/868-no/map/internal/cache"
)

// livePublisher sends committed observations to API processes over Redis
// pub/sub as one JSON array per batch, as the pipeline encoded it.
type livePublisher struct {
	c      *cache.Client
	log    *slog.Logger
	failed atomic.Bool
}

func (p *livePublisher) PublishLive(ctx context.Context, batch json.RawMessage) {
	if err := p.c.Publish(ctx, cache.LiveChannel, []byte(batch)); err != nil {
		if !p.failed.Swap(true) {
			p.log.Warn("live publish to Redis failing; API-only processes see no live rows (this process serves its own)", "err", err)
		}
		return
	}
	p.failed.Store(false)
}
