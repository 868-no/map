package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/maintenance"
)

// Hub fans live events out to SSE subscribers. In serve mode the ingest
// pipeline publishes into it directly; in API-only mode it is fed from
// Redis pub/sub. Slow subscribers lose events (and are told so) rather than
// blocking ingestion.
type Hub struct {
	mu        sync.Mutex
	subs      map[chan hubMsg]struct{}
	available bool
}

type hubMsg struct {
	events    []ingest.LiveEvent
	retention *maintenance.Status
	status    string // "live-available" / "live-unavailable"
}

// NewHub creates a hub; available reports whether live data flows.
func NewHub(available bool) *Hub { return &Hub{subs: map[chan hubMsg]struct{}{}, available: available} }

// PublishLive implements ingest.Publisher.
func (h *Hub) PublishLive(_ context.Context, events []ingest.LiveEvent) {
	h.broadcast(hubMsg{events: events})
}

func (h *Hub) broadcast(m hubMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- m:
		default: // subscriber too slow: drop
		}
	}
}

func (h *Hub) setAvailable(ok bool) {
	h.mu.Lock()
	changed := h.available != ok
	h.available = ok
	h.mu.Unlock()
	if changed {
		s := "live-unavailable"
		if ok {
			s = "live-available"
		}
		h.broadcast(hubMsg{status: s})
	}
}

// Available reports whether live updates currently flow.
func (h *Hub) Available() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.available
}

func (h *Hub) subscribe() (chan hubMsg, func()) {
	ch := make(chan hubMsg, 256)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
	}
}

// FeedFromRedis subscribes to live and retention channels (API-only mode,
// or retention notifications in serve mode when live is in-process).
func (h *Hub) FeedFromRedis(ctx context.Context, c *cache.Client, live bool, log *slog.Logger) {
	channels := []string{maintenance.RetentionChannel}
	if live {
		channels = append(channels, cache.LiveChannel)
	}
	for ctx.Err() == nil {
		sub := c.R.Subscribe(ctx, channels...)
		if _, err := sub.Receive(ctx); err != nil {
			if live {
				h.setAvailable(false)
			}
			_ = sub.Close()
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}
		if live {
			h.setAvailable(true)
		}
		for m := range sub.Channel() {
			switch m.Channel {
			case cache.LiveChannel:
				var evs []ingest.LiveEvent
				if json.Unmarshal([]byte(m.Payload), &evs) == nil {
					h.broadcast(hubMsg{events: evs})
				}
			case maintenance.RetentionChannel:
				var st maintenance.Status
				if json.Unmarshal([]byte(m.Payload), &st) == nil {
					h.broadcast(hubMsg{retention: &st})
				}
			}
		}
		_ = sub.Close()
		if live {
			h.setAvailable(false)
			log.Warn("live feed from Redis lost; retrying")
		}
	}
}
