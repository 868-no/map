package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"sync"
	"sync/atomic"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"

	"github.com/868-no/map/internal/config"
	"github.com/868-no/map/internal/geo"
	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/terrain"
	"github.com/868-no/map/internal/weather"
	"github.com/868-no/map/internal/window"
)

// Version is the API version reported in OpenAPI.
const Version = "1.0.0"

// GeoOptions are the operator's location-estimate settings, published in
// /capabilities for browsers to apply (the estimator runs there).
type GeoOptions struct {
	Enabled          bool
	MinPrecisionBits uint32
	Exclude          map[uint32]bool
	Params           geo.Params
}

// Server holds API dependencies.
type Server struct {
	Pool      *pgxpool.Pool
	Hub       *Hub
	Env       config.Env
	ConfigRev string // hash of channel/key config and policy flags (no secrets)
	Metrics   *observability.Metrics
	Log       *slog.Logger
	Now       func() time.Time
	Geo       GeoOptions
	// HeavySlots bounds concurrent /observations reads (database
	// connections held while rows stream); default 8.
	HeavySlots int
	// Weather serves /weather (D-133); nil when disabled.
	Weather *weather.Client
	// Terrain serves /terrain (D-143); nil when disabled.
	Terrain *terrain.Client
	// DayCache shares whole days of rows between replicas (D-158); nil
	// without Redis.
	DayCache BlobStore

	db         rowsDB // the database as the day endpoint reads it; nil: Pool
	dayFlight  singleflight.Group
	dayLarge   sync.Map     // keys of final days too large to build (noteLargeDay)
	dayLargeN  atomic.Int32 // entries in dayLarge, to bound it
	heavy      chan struct{}
	closing    chan struct{}
	trendsMemo trendsCache
	trendHours storage.TrendHours // hourly summaries for trends (D-112)
	once       sync.Once
}

// CloseStreams ends every open live stream, so a shutdown need not wait
// for SSE clients to leave.
func (s *Server) CloseStreams() { s.once.Do(func() { close(s.closing) }) }

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

// WindowEcho is the effective window every response reports.
type WindowEcho struct {
	Start   time.Time `json:"start"`
	End     time.Time `json:"end"`
	Rolling bool      `json:"rolling"`
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

// NewHandler builds the HTTP handler for /api and returns the huma API (for
// OpenAPI export).
// publicErrors makes huma's 5xx responses say only what failed, not why:
// the underlying errors (database, driver, SQL) are logged instead of sent.
var publicErrors sync.Once

// statusClientClosed is nginx's 499: the client closed the connection
// before the answer; what access logs and metrics record instead of a 500.
const statusClientClosed = 499

func hideInternalErrors(log *slog.Logger) {
	publicErrors.Do(func() {
		orig := huma.NewError
		huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
			if status >= 500 && len(errs) > 0 {
				err := errors.Join(errs...)
				if errors.Is(err, context.Canceled) {
					// The client went away (its request's context ended):
					// not a fault, and nobody reads the answer.
					return orig(statusClientClosed, "client closed request")
				}
				log.Error("api error", "status", status, "msg", msg, "err", err)
				return orig(status, msg)
			}
			return orig(status, msg, errs...)
		}
	})
}

func (s *Server) NewHandler(mux *http.ServeMux) huma.API {
	log := s.Log
	if log == nil {
		log = slog.Default()
	}
	hideInternalErrors(log)
	if s.HeavySlots <= 0 {
		s.HeavySlots = 8
	}
	s.heavy = make(chan struct{}, s.HeavySlots)
	s.closing = make(chan struct{})
	cfg := huma.DefaultConfig("868.no Map API", Version)
	cfg.Info.Description = "The packet log of a Meshtastic mesh observed over MQTT: decoded observations of a requested " +
		"half-open interval [start, end), paged, plus a live stream of new ones. Browsers derive every mesh view " +
		"(nodes, links, location estimates, traffic) from these rows themselves. Timestamps are observed_at: when " +
		"this service received the MQTT message, not RF transmission time."
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
	huma.Register(api, huma.Operation{OperationID: "observations", Method: http.MethodGet, Path: "/api/v1/observations",
		Summary: "Decoded observations of a window, paged, for deriving views in the browser", Tags: []string{"mesh"}, Errors: []int{400, 503},
		Responses: map[string]*huma.Response{"200": {Description: "OK", Content: map[string]*huma.MediaType{
			"application/json": {Schema: api.OpenAPI().Components.Schemas.Schema(reflect.TypeOf(ObservationsBody{}), true, "ObservationsBody")}}}}}, s.observations)
	huma.Register(api, huma.Operation{OperationID: "observations-day", Method: http.MethodGet, Path: "/api/v1/observations/day/{date}",
		Summary: "Every decoded observation of one UTC day, cached and immutable once the day is final (D-158)",
		Description: "The rows /observations returns for [date, date + 24 h), as one body of the same shape (more is false). " +
			"Once the day ended at least 30 minutes ago, lies wholly within retention, has no row awaiting a new decoding, and no " +
			"import of history is running, the answer is Cache-Control: public, max-age=31536000, immutable with a strong ETag; " +
			"otherwise no-store (a day the retention cutoff cuts into, or today, is served from the cutoff or up to now). " +
			"The URL names the generation, so a cached body can never stand for another: a different one is answered 409.",
		Tags: []string{"mesh"}, Errors: []int{400, 409, 503},
		Responses: map[string]*huma.Response{
			"200": {Description: "OK", Content: map[string]*huma.MediaType{
				"application/json": {Schema: api.OpenAPI().Components.Schemas.Schema(reflect.TypeOf(ObservationsBody{}), true, "ObservationsBody")}}},
			"304": {Description: "Not modified: the copy named by If-None-Match is still the day's rows"}}}, s.observationsDay)
	huma.Register(api, huma.Operation{OperationID: "node-public-key", Method: http.MethodGet, Path: "/api/v1/nodes/{id}/public-key",
		Summary: "A node's announced and trusted public keys from the retained log", Tags: []string{"mesh"}, Errors: []int{400, 404}}, s.nodeKey)
	huma.Register(api, huma.Operation{OperationID: "trends", Method: http.MethodGet, Path: "/api/v1/trends",
		Summary: "Daily, weekly or monthly summaries over the whole retained log", Tags: []string{"mesh"}, Errors: []int{400, 503}}, s.trends)
	huma.Register(api, huma.Operation{OperationID: "weather", Method: http.MethodGet, Path: "/api/v1/weather",
		Summary: "Hourly weather at a point from MET Norway's analysis (temperature, precipitation)", Tags: []string{"meta"}, Errors: []int{400, 404, 422}}, s.weather)
	huma.Register(api, huma.Operation{OperationID: "terrain-profile", Method: http.MethodGet, Path: "/api/v1/terrain/profile",
		Summary: "Cross section of the terrain between two points and its line-of-sight class (Kartverket)", Tags: []string{"meta"}, Errors: []int{400, 404, 422}}, s.terrainProfile)
	huma.Register(api, huma.Operation{OperationID: "terrain-classes", Method: http.MethodPost, Path: "/api/v1/terrain/classes",
		Summary: "Line-of-sight classes of links between pairs of points", Tags: []string{"meta"}, Errors: []int{400, 404}}, s.terrainClasses)
	s.registerStream(api)
}
