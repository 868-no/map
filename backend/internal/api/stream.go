package api

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/sse"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/maintenance"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/query"
)

// HeartbeatEvery is the SSE heartbeat interval.
const HeartbeatEvery = 15 * time.Second

// StreamInput: live updates exist only for the rolling window, so start/end
// are rejected.
type StreamInput struct {
	Start    string `query:"start" doc:"Not allowed: live updates apply only to the rolling window"`
	End      string `query:"end" doc:"Not allowed: live updates apply only to the rolling window"`
	Duration string `query:"duration" doc:"Rolling window length; default 72h" example:"72h"`
	FilterParams
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

// LiveDelta carries newly accepted receptions.
type LiveDelta struct {
	Events []ingest.LiveEvent `json:"events"`
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
		OperationID: "stream", Method: http.MethodGet, Path: "/api/v1/stream",
		Summary: "Live updates for the rolling window (SSE)", Tags: []string{"live"},
		Description: "Events: `delta` (new receptions), `heartbeat` (every 15 s, current window bounds), " +
			"`retention` (rows deleted; refetch), `status` (live availability).",
	}, map[string]any{
		"delta":     LiveDelta{},
		"heartbeat": Heartbeat{},
		"retention": maintenance.Status{},
		"status":    LiveStatus{},
	}, s.stream)
}

func (s *Server) stream(ctx context.Context, in *StreamInput, send sse.Sender) {
	f, err := in.FilterParams.parse()
	if err != nil {
		_ = send.Data(LiveStatus{Live: false, Reason: "invalid filters"})
		return
	}
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
	ch, unsub := s.Hub.subscribe()
	defer unsub()
	_ = send.Data(LiveStatus{Live: s.Hub.Available()})
	t := time.NewTicker(HeartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if !heartbeat() {
				return
			}
		case m := <-ch:
			var err error
			switch {
			case m.status != "":
				err = send.Data(LiveStatus{Live: m.status == "live-available"})
			case m.retention != nil:
				err = send.Data(*m.retention)
			case len(m.events) > 0:
				if evs := filterLive(m.events, f); len(evs) > 0 {
					err = send.Data(LiveDelta{Events: evs})
				}
			}
			if err != nil {
				return
			}
		}
	}
}

func filterLive(evs []ingest.LiveEvent, f query.Filters) []ingest.LiveEvent {
	if len(f.Channels)+len(f.Brokers)+len(f.Gateways)+len(f.Types) == 0 {
		return evs
	}
	out := evs[:0:0]
	for _, e := range evs {
		if len(f.Channels) > 0 && !slices.Contains(f.Channels, e.Channel) {
			continue
		}
		if len(f.Brokers) > 0 && !slices.Contains(f.Brokers, e.Broker) {
			continue
		}
		if len(f.Types) > 0 && !slices.Contains(f.Types, e.Type) {
			continue
		}
		if len(f.Gateways) > 0 {
			gw, ok := protocol.ParseNodeID(e.Gateway)
			if !ok || !slices.Contains(f.Gateways, gw) {
				continue
			}
		}
		out = append(out, e)
	}
	return out
}
