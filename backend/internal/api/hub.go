package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/maintenance"
)

// Hub fans live events out to SSE subscribers. In serve mode the ingest
// pipeline publishes into it directly; in API-only mode it is fed from
// Redis pub/sub. Slow subscribers lose events rather than blocking
// ingestion, and are told so on their next delivery (they then sync).
type Hub struct {
	mu        sync.Mutex
	subs      map[chan hubMsg]*subscriber
	available bool
}

type subscriber struct {
	dropped atomic.Bool // events were dropped since the last delivery
}

type hubMsg struct {
	delta     json.RawMessage // a LiveDelta, encoded once for every subscriber
	retention *maintenance.Status
	status    string // "live-available" / "live-unavailable"
}

// NewHub creates a hub; available reports whether live data flows.
func NewHub(available bool) *Hub {
	return &Hub{subs: map[chan hubMsg]*subscriber{}, available: available}
}

// PublishLive implements ingest.Publisher.
func (h *Hub) PublishLive(_ context.Context, events []ingest.LiveEvent) {
	h.publishEvents(events)
}

// publishEvents encodes a delta once; each subscriber only writes the bytes.
func (h *Hub) publishEvents(events []ingest.LiveEvent) {
	if len(events) == 0 {
		return
	}
	b, err := json.Marshal(LiveDelta{Events: events})
	if err != nil {
		return
	}
	h.broadcast(hubMsg{delta: b})
}

func (h *Hub) broadcast(m hubMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch, s := range h.subs {
		select {
		case ch <- m:
		default: // subscriber too slow: drop, and tell it next time
			s.dropped.Store(true)
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

func (h *Hub) subscribe() (chan hubMsg, *subscriber, func()) {
	ch := make(chan hubMsg, 256)
	s := &subscriber{}
	h.mu.Lock()
	h.subs[ch] = s
	h.mu.Unlock()
	return ch, s, func() {
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
					h.publishEvents(evs)
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
