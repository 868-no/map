// Package observability sets up structured logging and Prometheus metrics.
// Metrics and logs carry categories and counts only — never packet text,
// payload bytes or key material.
package observability

import (
	"log/slog"
	"os"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// NewLogger returns a JSON slog logger at the given level.
func NewLogger(level string) *slog.Logger {
	var l slog.Level
	switch strings.ToLower(level) {
	case "debug":
		l = slog.LevelDebug
	case "warn":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

// Metrics is the process-wide metric set.
type Metrics struct {
	Registry *prometheus.Registry

	Received          *prometheus.CounterVec // broker
	Accepted          *prometheus.CounterVec // packet_type, signature_status
	Rejected          *prometheus.CounterVec // category
	Dropped           *prometheus.CounterVec // reason
	DupDeliveries     *prometheus.CounterVec // broker that delivered an already-seen upload
	ProvenanceUpdates *prometheus.CounterVec // result: updated, failed
	QueueDepth        prometheus.Gauge
	BrokerUp          *prometheus.GaugeVec // broker
	BrokerConnects    *prometheus.CounterVec
	WriterBatches     prometheus.Counter
	WriterRows        prometheus.Counter
	WriterErrors      prometheus.Counter
	WriterLatency     prometheus.Histogram
	ProcessLatency    prometheus.Histogram
	Identities        prometheus.Gauge
	KeyConflicts      prometheus.Counter
	CacheErrors       *prometheus.CounterVec // op
	RetentionRows     prometheus.Counter
	DayRequests       *prometheus.CounterVec // result: not_modified, hit, waited, built, uncached, large
}

// NewMetrics registers all metrics on a fresh registry.
func NewMetrics() *Metrics {
	r := prometheus.NewRegistry()
	r.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	f := func(c prometheus.Collector) { r.MustRegister(c) }
	m := &Metrics{
		Registry:          r,
		Received:          prometheus.NewCounterVec(prometheus.CounterOpts{Name: "meshmap_mqtt_received_total", Help: "MQTT messages received"}, []string{"broker"}),
		Accepted:          prometheus.NewCounterVec(prometheus.CounterOpts{Name: "meshmap_ingest_accepted_total", Help: "Accepted packet observations"}, []string{"packet_type", "signature_status"}),
		Rejected:          prometheus.NewCounterVec(prometheus.CounterOpts{Name: "meshmap_ingest_rejected_total", Help: "Rejected messages by category"}, []string{"category"}),
		Dropped:           prometheus.NewCounterVec(prometheus.CounterOpts{Name: "meshmap_ingest_dropped_total", Help: "Messages dropped before processing"}, []string{"reason"}),
		DupDeliveries:     prometheus.NewCounterVec(prometheus.CounterOpts{Name: "meshmap_ingest_duplicate_deliveries_total", Help: "Same gateway upload delivered again by another broker (bridges, multi-broker gateways)"}, []string{"broker"}),
		ProvenanceUpdates: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "meshmap_ingest_provenance_updates_total", Help: "Rows whose also_via was extended by a late cross-broker delivery"}, []string{"result"}),
		QueueDepth:        prometheus.NewGauge(prometheus.GaugeOpts{Name: "meshmap_ingest_queue_depth", Help: "Messages waiting for processing"}),
		BrokerUp:          prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "meshmap_mqtt_connected", Help: "1 when the broker connection is up"}, []string{"broker"}),
		BrokerConnects:    prometheus.NewCounterVec(prometheus.CounterOpts{Name: "meshmap_mqtt_connects_total", Help: "Successful broker connections"}, []string{"broker"}),
		WriterBatches:     prometheus.NewCounter(prometheus.CounterOpts{Name: "meshmap_writer_batches_total", Help: "Committed batches"}),
		WriterRows:        prometheus.NewCounter(prometheus.CounterOpts{Name: "meshmap_writer_rows_total", Help: "Committed rows"}),
		WriterErrors:      prometheus.NewCounter(prometheus.CounterOpts{Name: "meshmap_writer_errors_total", Help: "Failed batch writes (retried)"}),
		WriterLatency:     prometheus.NewHistogram(prometheus.HistogramOpts{Name: "meshmap_writer_batch_seconds", Help: "Batch commit latency", Buckets: prometheus.DefBuckets}),
		ProcessLatency:    prometheus.NewHistogram(prometheus.HistogramOpts{Name: "meshmap_ingest_process_seconds", Help: "Per-message processing time", Buckets: []float64{.0001, .0005, .001, .005, .01, .05, .1}}),
		Identities:        prometheus.NewGauge(prometheus.GaugeOpts{Name: "meshmap_identities", Help: "Authoritative node keys in the identity index"}),
		KeyConflicts:      prometheus.NewCounter(prometheus.CounterOpts{Name: "meshmap_identity_key_conflicts_total", Help: "Unsigned NodeInfo announcing a key different from the authoritative one"}),
		CacheErrors:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "meshmap_cache_errors_total", Help: "Redis errors (fallback used)"}, []string{"op"}),
		RetentionRows:     prometheus.NewCounter(prometheus.CounterOpts{Name: "meshmap_retention_deleted_rows_total", Help: "Rows deleted by retention"}),
		DayRequests:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "meshmap_api_day_requests_total", Help: "Whole-day observation requests by how they were answered (D-158)"}, []string{"result"}),
	}
	for _, c := range []prometheus.Collector{m.Received, m.Accepted, m.Rejected, m.Dropped, m.DupDeliveries, m.ProvenanceUpdates, m.QueueDepth, m.BrokerUp, m.BrokerConnects,
		m.WriterBatches, m.WriterRows, m.WriterErrors, m.WriterLatency, m.ProcessLatency, m.Identities, m.KeyConflicts, m.CacheErrors, m.RetentionRows, m.DayRequests} {
		f(c)
	}
	return m
}
