package api

import (
	"bufio"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/868-no/map/internal/config"
)

func streamServer(t *testing.T, hub *Hub) *httptest.Server {
	t.Helper()
	s := &Server{Env: config.Env{MaxWindowHours: 336, DefaultWindowHours: 72, RetentionMonths: 6, LiveQuantum: 10 * time.Second},
		Log: slog.New(slog.DiscardHandler), Hub: hub}
	mux := http.NewServeMux()
	s.NewHandler(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(func() { s.CloseStreams(); srv.Close() })
	return srv
}

// A window the server would refuse is answered 400 before the stream opens,
// not with a 200 stream that closes at once (EventSource reconnects to that
// forever); a fixed window is refused before it too.
func TestStreamRefusesBadWindowsBeforeOpening(t *testing.T) {
	srv := streamServer(t, nil)
	for q, want := range map[string]int{
		"duration=10000h": http.StatusBadRequest,
		"duration=1m":     http.StatusBadRequest,
		"duration=banana": http.StatusBadRequest,
		"start=2026-11-01T00:00:00Z&end=2026-11-02T00:00:00Z": http.StatusUnprocessableEntity,
	} {
		res, err := http.Get(srv.URL + streamPath + "?" + q)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close() //nolint:errcheck
		if res.StatusCode != want || strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
			t.Errorf("%s: %d %s, want %d", q, res.StatusCode, res.Header.Get("Content-Type"), want)
		}
	}
	res, err := http.Get(srv.URL + streamPath + "?duration=24h")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close() //nolint:errcheck
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("a valid window: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
}

// The stream reports changes of live availability as they happen.
func TestStreamReportsAvailability(t *testing.T) {
	hub := NewHub(true)
	srv := streamServer(t, hub)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+streamPath, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close() //nolint:errcheck
	lines := bufio.NewScanner(res.Body)
	// next returns the data of the next status event.
	next := func() string {
		t.Helper()
		status := false
		for lines.Scan() {
			l := lines.Text()
			switch {
			case l == "event: status":
				status = true
			case status && strings.HasPrefix(l, "data: "):
				return strings.TrimPrefix(l, "data: ")
			}
		}
		t.Fatalf("stream ended: %v", lines.Err())
		return ""
	}
	if got := next(); got != `{"live":true}` {
		t.Fatalf("on connect: %s", got)
	}
	hub.setAvailable(false)
	if got := next(); got != `{"live":false}` {
		t.Fatalf("down: %s", got)
	}
	hub.setAvailable(true)
	if got := next(); got != `{"live":true}` {
		t.Fatalf("up: %s", got)
	}
}
