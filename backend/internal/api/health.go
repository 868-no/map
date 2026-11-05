// Package api serves the HTTP interface: health and metrics, the windowed
// observations API and live stream, trends and node public keys.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/maintenance"
	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/storage"
)

// IngestStatus is implemented by the ingest supervisor (nil in api-only mode).
type IngestStatus interface {
	Healthy() (bool, string)
	Brokers() map[string]string
}

// ReadyTTL is how long /health/ready reuses its database and Redis checks.
// Probes are unauthenticated and outside the API rate limit; within the TTL
// they cost no queries, and concurrent ones share a single check.
const ReadyTTL = 2 * time.Second

// Health serves /health/live and /health/ready.
type Health struct {
	Pool    *pgxpool.Pool
	Cache   *cache.Client
	Ingest  IngestStatus
	Started time.Time

	// probe checks the backends and reads the last maintenance status; nil
	// means the database and Redis (tests replace it).
	probe    func(context.Context) ([]probe, *maintenance.Status)
	mu       sync.Mutex
	probedAt time.Time
	probed   []probe
	maint    *maintenance.Status
}

// probe is one backend check's outcome; a failed fatal check makes the
// service unavailable, any other failure degraded.
type probe struct {
	name  string
	c     check
	fatal bool
}

type check struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

type readyBody struct {
	Status      string              `json:"status"` // ready, degraded, unavailable
	Checks      map[string]check    `json:"checks"`
	Brokers     map[string]string   `json:"brokers,omitempty"`
	Maintenance *maintenance.Status `json:"maintenance,omitempty"`
	UptimeSec   int64               `json:"uptime_s"`
}

func (h *Health) live(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"alive"}`))
}

// backends checks the database, schema and Redis, and reads the last
// maintenance status.
func (h *Health) backends(ctx context.Context) (out []probe, maint *maintenance.Status) {
	if err := h.Pool.Ping(ctx); err != nil {
		out = append(out, probe{"database", check{Detail: "unreachable"}, true})
	} else if err := storage.CheckSchema(ctx, h.Pool); err != nil {
		out = append(out, probe{"schema", check{Detail: err.Error()}, true})
	} else {
		out = append(out, probe{"database", check{OK: true}, true}, probe{"schema", check{OK: true, Detail: storage.SchemaVersion}, true})
	}
	if h.Cache == nil {
		out = append(out, probe{"cache", check{Detail: "not configured; dedupe uses the database"}, false})
	} else if err := h.Cache.Ping(ctx); err != nil {
		out = append(out, probe{"cache", check{Detail: "unreachable; dedupe falls back to the database"}, false})
	} else {
		out = append(out, probe{"cache", check{OK: true}, false})
		if st, err := maintenance.LastStatus(ctx, h.Cache); err == nil {
			maint = st
		}
	}
	return out, maint
}

// cachedProbes returns the backend checks, at most ReadyTTL old. Concurrent
// callers wait for one check instead of each running their own. The check
// does not use the request's context, so a probe that hangs up early cannot
// cache a failure.
func (h *Health) cachedProbes() ([]probe, *maintenance.Status) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.probed == nil || time.Since(h.probedAt) >= ReadyTTL {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		run := h.probe
		if run == nil {
			run = h.backends
		}
		h.probed, h.maint = run(ctx)
		h.probedAt = time.Now()
	}
	return h.probed, h.maint
}

func (h *Health) ready(w http.ResponseWriter, _ *http.Request) {
	b := readyBody{Status: "ready", Checks: map[string]check{}, UptimeSec: int64(time.Since(h.Started).Seconds())}
	fail := func(name, detail string, fatal bool) {
		b.Checks[name] = check{OK: false, Detail: detail}
		if fatal {
			b.Status = "unavailable"
		} else if b.Status == "ready" {
			b.Status = "degraded"
		}
	}
	probes, maint := h.cachedProbes()
	for _, p := range probes {
		if p.c.OK {
			b.Checks[p.name] = p.c
		} else {
			fail(p.name, p.c.Detail, p.fatal)
		}
	}
	b.Maintenance = maint
	// Ingest state is in memory: always current.
	if h.Ingest != nil {
		if ok, why := h.Ingest.Healthy(); !ok {
			fail("ingest", why, false)
		} else {
			b.Checks["ingest"] = check{OK: true}
		}
		b.Brokers = h.Ingest.Brokers()
	}
	w.Header().Set("Content-Type", "application/json")
	if b.Status == "unavailable" {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_ = json.NewEncoder(w).Encode(b)
}

// Register mounts health endpoints (and /metrics when public).
func (h *Health) Register(mux *http.ServeMux, m *observability.Metrics, publicMetrics bool) {
	mux.HandleFunc("GET /health/live", h.live)
	mux.HandleFunc("GET /health/ready", h.ready)
	if publicMetrics {
		mux.Handle("GET /metrics", promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{}))
	}
}

// MetricsHandler is served on the operator-only metrics listener.
func MetricsHandler(m *observability.Metrics) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{}))
	return mux
}
