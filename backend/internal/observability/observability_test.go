package observability

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

func TestLoggerLevels(t *testing.T) {
	ctx := context.Background()
	for level, lowest := range map[string]slog.Level{
		"debug": slog.LevelDebug, "DEBUG": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn,
		"error": slog.LevelError, "": slog.LevelInfo, "verbose": slog.LevelInfo,
	} {
		l := NewLogger(level)
		if !l.Enabled(ctx, lowest) || (lowest > slog.LevelDebug && l.Enabled(ctx, lowest-4)) {
			t.Errorf("%q: does not log from %v exactly", level, lowest)
		}
	}
}

// Every metric is registered once, on the process's own registry, under
// this service's prefix, and is gathered with the values recorded.
func TestMetricsAreRegistered(t *testing.T) {
	m := NewMetrics()
	m.Received.WithLabelValues("b").Inc()
	m.DayRequests.WithLabelValues("hit").Add(2)
	m.QueueDepth.Set(7)
	var d dto.Metric
	if err := m.DayRequests.WithLabelValues("hit").(prometheus.Metric).Write(&d); err != nil || d.GetCounter().GetValue() != 2 {
		t.Fatalf("day requests %v %v", d.GetCounter().GetValue(), err)
	}
	fams, err := m.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	ours := map[string]bool{}
	for _, f := range fams {
		if strings.HasPrefix(f.GetName(), "meshmap_") {
			ours[f.GetName()] = true
		}
	}
	for _, name := range []string{"meshmap_mqtt_received_total", "meshmap_ingest_queue_depth", "meshmap_api_day_requests_total", "meshmap_rows_bad_metadata_total"} {
		if !ours[name] {
			t.Errorf("%s not gathered (have %v)", name, ours)
		}
	}
	if !ours["meshmap_mqtt_received_total"] || len(ours) < 10 {
		t.Errorf("only %d metrics of ours gathered", len(ours))
	}
	// A second set registers on its own registry: no duplicate registration.
	if NewMetrics().Registry == m.Registry {
		t.Fatal("registries shared")
	}
}
