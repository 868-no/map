// Package api serves the HTTP interface. M1 provides health and metrics;
// the time-windowed REST API and SSE stream are added in M2.
package api

import (
	"context"
	"encoding/json"
	"net/http"
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

// Health serves /health/live and /health/ready.
type Health struct {
	Pool    *pgxpool.Pool
	Cache   *cache.Client
	Ingest  IngestStatus
	Started time.Time
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

func (h *Health) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	b := readyBody{Status: "ready", Checks: map[string]check{}, UptimeSec: int64(time.Since(h.Started).Seconds())}
	fail := func(name, detail string, fatal bool) {
		b.Checks[name] = check{OK: false, Detail: detail}
		if fatal {
			b.Status = "unavailable"
		} else if b.Status == "ready" {
			b.Status = "degraded"
		}
	}
	if err := h.Pool.Ping(ctx); err != nil {
		fail("database", "unreachable", true)
	} else if err := storage.CheckSchema(ctx, h.Pool); err != nil {
		fail("schema", err.Error(), true)
	} else {
		b.Checks["database"] = check{OK: true}
		b.Checks["schema"] = check{OK: true, Detail: storage.SchemaVersion}
	}
	if h.Cache == nil {
		fail("cache", "not configured; direct computation", false)
	} else if err := h.Cache.Ping(ctx); err != nil {
		fail("cache", "unreachable; falling back to direct computation", false)
	} else {
		b.Checks["cache"] = check{OK: true}
		if st, err := maintenance.LastStatus(ctx, h.Cache); err == nil {
			b.Maintenance = st
		}
	}
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
