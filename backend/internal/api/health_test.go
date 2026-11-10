package api

import (
	"context"
	"encoding/json"
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
	h := &Health{Started: time.Now(), probe: func(context.Context) ([]probe, statuses) {
		calls.Add(1)
		time.Sleep(20 * time.Millisecond)
		return []probe{{"database", check{Detail: "unreachable"}, true}}, statuses{}
	}}
	mux := http.NewServeMux()
	h.Register(mux, nil, false)
	get := func(path string) int {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
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

type fakeIngest struct{ last map[string]time.Time }

func (fakeIngest) Healthy() (bool, string)              { return true, "" }
func (fakeIngest) Brokers() map[string]string           { return map[string]string{"no868": "up"} }
func (f fakeIngest) LastMessages() map[string]time.Time { return f.last }

// The production monitor reads how long ago each broker last delivered, and
// the backup service's status (D-206, D-207).
func TestReadyReportsLastMessageAndBackup(t *testing.T) {
	ok := time.Date(2026, 11, 10, 2, 0, 0, 0, time.UTC)
	h := &Health{Started: time.Now(), Ingest: fakeIngest{map[string]time.Time{"no868": time.Now().Add(-90 * time.Second)}},
		probe: func(context.Context) ([]probe, statuses) {
			return []probe{{"database", check{OK: true}, true}}, statuses{backup: &maintenance.BackupStatus{LastSuccess: &ok, Bytes: 42}}
		}}
	mux := http.NewServeMux()
	h.Register(mux, nil, false)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	var body struct {
		LastMessageSec map[string]int64 `json:"last_message_s"`
		Backup         struct {
			LastSuccess time.Time `json:"last_success"`
			Bytes       int64     `json:"bytes"`
		} `json:"backup"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if s := body.LastMessageSec["no868"]; s < 89 || s > 91 {
		t.Fatalf("last_message_s = %v, want 90", body.LastMessageSec)
	}
	if !body.Backup.LastSuccess.Equal(ok) || body.Backup.Bytes != 42 {
		t.Fatalf("backup = %+v", body.Backup)
	}
}
