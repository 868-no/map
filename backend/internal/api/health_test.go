package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/868-no/map/internal/maintenance"
)

// Readiness probes are unthrottled: within ReadyTTL they reuse one backend
// check, and concurrent probes share it. Liveness never checks backends.
func TestReadyCachesBackendChecks(t *testing.T) {
	var calls atomic.Int32
	h := &Health{Started: time.Now(), probe: func(context.Context) ([]probe, *maintenance.Status) {
		calls.Add(1)
		time.Sleep(20 * time.Millisecond)
		return []probe{{"database", check{Detail: "unreachable"}, true}}, nil
	}}
	mux := http.NewServeMux()
	h.Register(mux, nil, false)
	get := func(path string) int {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec.Code
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code := get("/health/ready"); code != http.StatusServiceUnavailable {
				t.Errorf("ready: HTTP %d, want 503", code)
			}
		}()
	}
	wg.Wait()
	if get("/health/live") != http.StatusOK {
		t.Fatal("liveness must not depend on the backends")
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("%d backend checks for 20 probes within the TTL, want 1", n)
	}
	h.mu.Lock()
	h.probedAt = time.Now().Add(-ReadyTTL)
	h.mu.Unlock()
	get("/health/ready")
	if n := calls.Load(); n != 2 {
		t.Fatalf("%d backend checks after the TTL, want 2", n)
	}
}
