package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/maintenance"
)

// Hub fans live events out to SSE subscribers. In serve mode the ingest
// pipeline publishes into it directly; in API-only mode it is fed from
// Redis pub/sub. Slow subscribers lose events rather than blocking
// ingestion, and are told so on their next delivery (they then sync).
// Changes of availability are never lost that way: they bypass the event
// queue (subscriber.status), so a client that fell behind still learns that
// live went down, and is never told it is up while it is not.
type Hub struct {
	mu        sync.Mutex
	subs      map[chan hubMsg]*subscriber
	available bool
}

type subscriber struct {
	dropped atomic.Bool // events were dropped since the last delivery
	// status is signalled (never blocking) when availability changed since
	// the stream last reported it; the stream then reports the hub's
	// current state, so only the latest counts.
	status chan struct{}
	// wentDown: live was unavailable at some point since the stream last
	// reported it, so the client must sync even if live is back by then.
	wentDown atomic.Bool
}

type hubMsg struct {
	delta     json.RawMessage // a LiveDelta, encoded once for every subscriber
	retention *maintenance.Status
}

// NewHub creates a hub; available reports whether live data flows.
func NewHub(available bool) *Hub {
	return &Hub{subs: map[chan hubMsg]*subscriber{}, available: available}
}

// PublishLive implements ingest.Publisher.
func (h *Hub) PublishLive(_ context.Context, batch json.RawMessage) {
	h.publishBatch(batch)
}

// publishBatch wraps an encoded event array as a delta, once; each
// subscriber only writes the bytes.
func (h *Hub) publishBatch(batch []byte) {
	if len(batch) == 0 {
		return
	}
	b := make([]byte, 0, len(batch)+len(`{"events":}`))
	b = append(append(append(b, `{"events":`...), batch...), '}')
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
	defer h.mu.Unlock()
	if h.available == ok {
		return
	}
	h.available = ok
	for _, s := range h.subs {
		if !ok {
			s.wentDown.Store(true)
		}
		select {
		case s.status <- struct{}{}:
		default: // already signalled: the stream reads the state when it gets to it
		}
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
	s := &subscriber{status: make(chan struct{}, 1)}
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
// or retention notifications in serve mode when live is in-process) until ctx
// ends. In API-only mode a lost subscription makes live unavailable and a new
// one available again: browsers see live go false then true, and sync what
// they missed meanwhile (§4.3, D-117). Retention notices missed while disconnected
// only concern rows months older than any window, which the next sync drops.
func (h *Hub) FeedFromRedis(ctx context.Context, c *cache.Client, live bool, log *slog.Logger) {
	channels := []string{maintenance.RetentionChannel}
	if live {
		channels = append(channels, cache.LiveChannel)
	}
	c.Listen(ctx, channels, cache.Listener{
		Up: func() {
			if live {
				h.setAvailable(true)
			}
		},
		Down: func(err error) {
			if live {
				h.setAvailable(false)
				log.Warn("live feed from Redis lost; reconnecting", "err", err)
			}
		},
		Message: func(channel, payload string) {
			switch channel {
			case cache.LiveChannel:
				// The pipeline's own encoding: only checked, never decoded.
				if b := []byte(payload); len(b) > 0 && b[0] == '[' && json.Valid(b) {
					h.publishBatch(b)
				}
			case maintenance.RetentionChannel:
				var st maintenance.Status
				if json.Unmarshal([]byte(payload), &st) == nil {
					h.broadcast(hubMsg{retention: &st})
				}
			}
		},
	})
}
