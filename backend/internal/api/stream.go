package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/sse"

	"github.com/868-no/map/internal/maintenance"
	"github.com/868-no/map/internal/obsrow"
)

// HeartbeatEvery is the SSE heartbeat interval.
const HeartbeatEvery = 15 * time.Second

// StreamInput: live updates exist only for the rolling window, so start/end
// are rejected.
type StreamInput struct {
	Start    string `query:"start" doc:"Not allowed: live updates apply only to the rolling window"`
	End      string `query:"end" doc:"Not allowed: live updates apply only to the rolling window"`
	Duration string `query:"duration" doc:"Rolling window length; default 72h" example:"72h"`
}

// Resolve rejects fixed windows before the stream opens.
func (in *StreamInput) Resolve(huma.Context) []error {
	if in.Start != "" || in.End != "" {
		return []error{&huma.ErrorDetail{Location: "query.start", Message: "live stream requires the rolling window; fixed historical windows receive no live updates"}}
	}
	if in.Duration != "" {
		if _, err := time.ParseDuration(in.Duration); err != nil {
			return []error{&huma.ErrorDetail{Location: "query.duration", Message: "invalid duration"}}
		}
	}
	return nil
}

// streamPath is the live stream, which Protect caps per client.
const streamPath = "/api/v1/stream"

// LaggedReason in a status event: the server dropped events for this client
// (it was too slow); the client should fetch what it missed.
const LaggedReason = "lagged"

// LiveEvent announces an accepted observation (ingest.LiveEvent, whose row
// travels pre-encoded; this is its documented form).
type LiveEvent struct {
	ID  int64         `json:"id"`
	T   time.Time     `json:"t"`
	Row obsrow.ObsRow `json:"row"`
}

// LiveDelta carries newly accepted receptions.
type LiveDelta struct {
	Events []LiveEvent     `json:"events"`
	raw    json.RawMessage // already encoded by the hub: written as-is
}

// MarshalJSON writes the hub's encoding when there is one, so a delta is
// encoded once for all subscribers rather than once per connection.
func (d LiveDelta) MarshalJSON() ([]byte, error) {
	if d.raw != nil {
		return d.raw, nil
	}
	type plain LiveDelta
	return json.Marshal(plain(d))
}

// Heartbeat carries server time and the current rolling window; clients
// evict evidence older than window.start even when no packets arrive.
type Heartbeat struct {
	Now    time.Time  `json:"now"`
	Window WindowEcho `json:"window"`
}

// LiveStatus reports whether live data flows.
type LiveStatus struct {
	Live   bool   `json:"live"`
	Reason string `json:"reason,omitempty"`
}

func (s *Server) registerStream(api huma.API) {
	sse.Register(api, huma.Operation{
		OperationID: "stream", Method: http.MethodGet, Path: streamPath,
		Summary: "Live updates for the rolling window (SSE)", Tags: []string{"live"},
		Description: "Events: `delta` (new observations, each with its full row), `heartbeat` (every 15 s, current window bounds), " +
			"`retention` (rows deleted; refetch), `status` (live availability).",
	}, map[string]any{
		"delta":     LiveDelta{},
		"heartbeat": Heartbeat{},
		"retention": maintenance.Status{},
		"status":    LiveStatus{},
	}, s.stream)
}

func (s *Server) stream(ctx context.Context, in *StreamInput, send sse.Sender) {
	wp := WindowParams{Duration: in.Duration}
	heartbeat := func() bool {
		w, err := s.parseWindow(wp)
		if err != nil {
			return false
		}
		return send.Data(Heartbeat{Now: s.now(), Window: echo(w)}) == nil
	}
	if !heartbeat() {
		_ = send.Data(LiveStatus{Live: false, Reason: "invalid window"})
		return
	}
	if s.Hub == nil {
		_ = send.Data(LiveStatus{Live: false, Reason: "live updates not available in this deployment"})
		return
	}
	ch, sub, unsub := s.Hub.subscribe()
	defer unsub()
	_ = send.Data(LiveStatus{Live: s.Hub.Available()})
	t := time.NewTicker(HeartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.closing:
			return
		case <-t.C:
			// Events lost in a burst followed by quiet: told now, not with
			// a next delta that may be long in coming.
			if sub.dropped.Swap(false) && send.Data(LiveStatus{Live: s.Hub.Available(), Reason: LaggedReason}) != nil {
				return
			}
			if !heartbeat() {
				return
			}
		case <-sub.status:
			// Availability changed, perhaps more than once: the current
			// state, after an "unavailable" when live went down meanwhile,
			// so the client syncs what it missed.
			live := s.Hub.Available()
			if sub.wentDown.Swap(false) && live && send.Data(LiveStatus{Live: false}) != nil {
				return
			}
			if send.Data(LiveStatus{Live: live}) != nil {
				return
			}
		case m := <-ch:
			var err error
			switch {
			case m.retention != nil:
				err = send.Data(*m.retention)
			case len(m.delta) > 0:
				if sub.dropped.Swap(false) {
					// Events were lost while this client was slow: it syncs.
					if err = send.Data(LiveStatus{Live: s.Hub.Available(), Reason: LaggedReason}); err != nil {
						return
					}
				}
				err = send.Data(LiveDelta{raw: m.delta})
			}
			if err != nil {
				return
			}
		}
	}
}
