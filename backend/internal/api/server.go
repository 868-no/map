package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/protocol"
	"github.com/868-no/map/internal/query"
	"github.com/868-no/map/internal/window"
)

// Version is the API version reported in OpenAPI.
const Version = "1.0.0"

// Server holds API dependencies.
type Server struct {
	Pool      *pgxpool.Pool
	Results   *cache.Results
	Hub       *Hub
	Env       config.Env
	ConfigRev string // hash of channel/key config and policy flags (no secrets)
	Metrics   *observability.Metrics
	Log       *slog.Logger
	Now       func() time.Time
	Geo       query.GeoOptions

	heavy chan struct{}
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

// WindowParams select the interval. Omit start and end for the rolling
// live window [now - duration, now).
type WindowParams struct {
	Start    string `query:"start" doc:"Inclusive start, RFC 3339 (UTC recommended). Omit start and end for the rolling live window." example:"2026-10-28T00:00:00Z"`
	End      string `query:"end" doc:"Exclusive end, RFC 3339." example:"2026-10-31T00:00:00Z"`
	Duration string `query:"duration" doc:"Rolling window length (1h to 168h); default 72h." example:"72h"`
}

// FilterParams narrow contributing observations (comma-separated lists).
type FilterParams struct {
	Channel string `query:"channel" doc:"Channel names, comma-separated"`
	Broker  string `query:"broker" doc:"Broker ids, comma-separated"`
	Gateway string `query:"gateway" doc:"Gateway node ids (!xxxxxxxx), comma-separated"`
	Type    string `query:"type" doc:"Packet types (nodeinfo, position, mapreport, telemetry, neighborinfo, traceroute, text, routing, other), comma-separated"`
}

// WindowEcho is the effective window every response reports.
type WindowEcho struct {
	Start   time.Time `json:"start"`
	End     time.Time `json:"end"`
	Rolling bool      `json:"rolling"`
}

// Meta accompanies every historical response.
type Meta struct {
	Window      WindowEcho    `json:"window"`
	Revision    string        `json:"revision" doc:"Data generation; changes when in-window data, retention or configuration change"`
	Filters     query.Filters `json:"filters"`
	GeneratedAt time.Time     `json:"generated_at"`
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (f FilterParams) parse() (query.Filters, error) {
	q := query.Filters{Channels: splitList(f.Channel), Brokers: splitList(f.Broker), Types: splitList(f.Type)}
	for _, g := range splitList(f.Gateway) {
		n, ok := protocol.ParseNodeID(g)
		if !ok || !protocol.ValidNode(n) {
			return q, huma.Error400BadRequest(fmt.Sprintf("invalid gateway id %q", g))
		}
		q.Gateways = append(q.Gateways, n)
	}
	for _, l := range [][]string{q.Channels, q.Brokers, q.Types} {
		if len(l) > 32 {
			return q, huma.Error400BadRequest("too many filter values")
		}
	}
	return q, nil
}

func parseTime(field, v string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return time.Time{}, huma.Error400BadRequest(fmt.Sprintf("%s: not an RFC 3339 timestamp", field))
	}
	return t.UTC(), nil
}

// Bounds returns the current window limits.
func (s *Server) Bounds() window.Bounds {
	now := s.now()
	return window.Bounds{Now: now, Cutoff: window.RetentionCutoff(now, s.Env.RetentionMonths),
		MaxDuration: time.Duration(s.Env.MaxWindowHours) * time.Hour, LiveQuantum: s.Env.LiveQuantum}
}

// parseWindow validates parameters; it never widens a request.
func (s *Server) parseWindow(p WindowParams) (window.Window, error) {
	b := s.Bounds()
	var w window.Window
	var err error
	switch {
	case p.Start == "" && p.End == "":
		d := time.Duration(s.Env.DefaultWindowHours) * time.Hour
		if p.Duration != "" {
			if d, err = time.ParseDuration(p.Duration); err != nil {
				return window.Window{}, huma.Error400BadRequest("duration: invalid, use e.g. 72h")
			}
		}
		w, err = window.Rolling(d, b)
	case p.Start == "" || p.End == "":
		return window.Window{}, huma.Error400BadRequest("give both start and end, or neither for the rolling window")
	default:
		var st, en time.Time
		if st, err = parseTime("start", p.Start); err != nil {
			return window.Window{}, err
		}
		if en, err = parseTime("end", p.End); err != nil {
			return window.Window{}, err
		}
		w, err = window.Fixed(st, en, b)
	}
	if err != nil {
		var we *window.Error
		if errors.As(err, &we) {
			return window.Window{}, huma.Error400BadRequest(we.Error())
		}
		return window.Window{}, err
	}
	return w, nil
}

func echo(w window.Window) WindowEcho {
	return WindowEcho{Start: w.Start, End: w.End, Rolling: w.Rolling}
}

// generation identifies decoder, configuration and retention state.
func (s *Server) generation(ctx context.Context) (string, bool) {
	rr, ok := s.Results.RetentionRev(ctx)
	return fmt.Sprintf("d%d.c%s.r%d", ingest.DecodeVersion, s.ConfigRev, rr), ok
}

// revision adds the newest in-window row id: any new row in the window
// yields a new revision (and cache key).
func (s *Server) revision(ctx context.Context, w window.Window) (rev string, useCache bool, err error) {
	gen, ok := s.generation(ctx)
	maxID, err := query.MaxID(ctx, s.Pool, w)
	if err != nil {
		return "", false, err
	}
	return fmt.Sprintf("%s.m%d", gen, maxID), ok, nil
}

func cacheKey(kind string, w window.Window, f query.Filters, rev string, extra string) string {
	return fmt.Sprintf(cache.ResultKeyPrefix+"%s:%s:%d:%d:%s:%s", kind, rev, w.Start.UnixMilli(), w.End.UnixMilli(), f.Hash(), extra)
}

func (s *Server) ttl(w window.Window) time.Duration {
	if w.End.Before(s.now().Add(-time.Minute)) {
		return time.Hour // fixed past window: immutable apart from revision changes
	}
	return s.Env.LiveQuantum
}

// acquire limits concurrent heavy computations.
func (s *Server) acquire(ctx context.Context) (func(), error) {
	select {
	case s.heavy <- struct{}{}:
		return func() { <-s.heavy }, nil
	case <-time.After(5 * time.Second):
		return nil, huma.Error503ServiceUnavailable("server busy, retry shortly")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Server) meta(w window.Window, rev string, f query.Filters) Meta {
	return Meta{Window: echo(w), Revision: rev, Filters: f, GeneratedAt: s.now()}
}

// NewHandler builds the HTTP handler for /api and returns the huma API (for
// OpenAPI export).
func (s *Server) NewHandler(mux *http.ServeMux) huma.API {
	s.heavy = make(chan struct{}, 8)
	cfg := huma.DefaultConfig("Meshtastic MQTT Mesh Observatory API", Version)
	cfg.Info.Description = "Time-isolated views of a Meshtastic mesh reconstructed from MQTT observations. " +
		"Every mesh-derived field is computed only from observations inside the requested half-open interval [start, end). " +
		"Timestamps are observed_at: when this service " +
		"received the MQTT message, not RF transmission time."
	cfg.OpenAPIPath = "/api/openapi"
	cfg.DocsPath = "" // no CDN-loaded docs UI
	cfg.SchemasPath = "/api/schemas"
	api := humago.New(mux, cfg)
	s.register(api)
	return api
}

func (s *Server) register(api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "capabilities", Method: http.MethodGet, Path: "/api/v1/capabilities",
		Summary: "Supported windows, presets, feature flags and map defaults (no secrets)", Tags: []string{"meta"}}, s.capabilities)
	huma.Register(api, huma.Operation{OperationID: "retention", Method: http.MethodGet, Path: "/api/v1/retention",
		Summary: "Retention cutoff, earliest/latest retained observation and server time", Tags: []string{"meta"}}, s.retention)
	huma.Register(api, huma.Operation{OperationID: "snapshot", Method: http.MethodGet, Path: "/api/v1/snapshot",
		Summary: "Time-isolated nodes, positions and counts for a window", Tags: []string{"mesh"}, Errors: []int{400, 503}}, s.snapshot)
	huma.Register(api, huma.Operation{OperationID: "traffic", Method: http.MethodGet, Path: "/api/v1/traffic",
		Summary: "Unique packets vs gateway receptions in time buckets", Tags: []string{"mesh"}, Errors: []int{400, 503}}, s.traffic)
	huma.Register(api, huma.Operation{OperationID: "node", Method: http.MethodGet, Path: "/api/v1/nodes/{id}",
		Summary: "One node's in-window details and bounded evidence", Tags: []string{"mesh"}, Errors: []int{400, 404, 503}}, s.node)
	huma.Register(api, huma.Operation{OperationID: "edges", Method: http.MethodGet, Path: "/api/v1/edges",
		Summary: "Evidence-backed directed links with provenance and per-direction radio statistics", Tags: []string{"mesh"}, Errors: []int{400, 503}}, s.edges)
	huma.Register(api, huma.Operation{OperationID: "observations", Method: http.MethodGet, Path: "/api/v1/observations",
		Summary: "Decoded observations of a window, paged, for deriving views in the browser", Tags: []string{"mesh"}, Errors: []int{400, 503}}, s.observations)
	s.registerStream(api)
}
