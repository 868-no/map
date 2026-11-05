package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProbeAddr(t *testing.T) {
	for in, want := range map[string]string{
		"":              "127.0.0.1:8000",
		":9000":         "127.0.0.1:9000",
		"0.0.0.0:8080":  "127.0.0.1:8080",
		"[::]:8080":     "127.0.0.1:8080",
		"10.0.0.5:8000": "10.0.0.5:8000",
		"backend:8000":  "backend:8000",
	} {
		if got := probeAddr(in); got != want {
			t.Errorf("probeAddr(%q) = %q, want %q", in, got, want)
		}
	}
}

// With the database down /health/ready answers 503 while /health/live still
// answers: --live keeps the ingest task healthy through the outage.
func TestHealthcheckLive(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health/live":
			w.Write([]byte(`{"status":"alive"}`)) //nolint:errcheck
		case "/health/ready":
			http.Error(w, `{"status":"unavailable"}`, http.StatusServiceUnavailable)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")
	run := func(args ...string) error {
		cmd := healthcheckCmd()
		cmd.SetArgs(append([]string{"--addr", addr}, args...))
		cmd.SilenceUsage, cmd.SilenceErrors = true, true
		return cmd.Execute()
	}
	if err := run(); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("readiness probe: %v", err)
	}
	if err := run("--live"); err != nil {
		t.Fatalf("liveness probe: %v", err)
	}
}
