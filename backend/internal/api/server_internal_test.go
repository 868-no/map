package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// A 5xx says what failed, never why: the cause (here a made-up database
// error) is logged, not sent. Client errors keep their details.
func TestInternalErrorsAreNotSent(t *testing.T) {
	hideInternalErrors(slog.New(slog.DiscardHandler))
	e := huma.NewError(500, "query failed", errors.New(`pq: relation "secret_table" does not exist at host db.internal`))
	if m := e.(*huma.ErrorModel); strings.Contains(m.Detail+errDetails(m), "secret_table") {
		t.Fatalf("500 carries the cause: %+v", m)
	}
	e = huma.NewError(400, "bad start", errors.New("start: not RFC 3339"))
	if m := e.(*huma.ErrorModel); !strings.Contains(errDetails(m), "RFC 3339") {
		t.Fatalf("400 lost its detail: %+v", m)
	}
}

// A request whose client went away (its context canceled, possibly wrapped
// by the driver) is answered 499 and not logged as an error; one out of
// time is answered 503, to be asked again.
func TestClientGoneIsNotAnError(t *testing.T) {
	hideInternalErrors(slog.New(slog.DiscardHandler))
	for _, err := range []error{context.Canceled, fmt.Errorf("query: %w", context.Canceled)} {
		if s := huma.NewError(500, "unexpected error occurred", err).GetStatus(); s != statusClientClosed {
			t.Errorf("%v: status %d", err, s)
		}
	}
	if s := huma.NewError(500, "unexpected error occurred", fmt.Errorf("query: %w", context.DeadlineExceeded)).GetStatus(); s != 503 {
		t.Errorf("deadline: status %d", s)
	}
}

func errDetails(m *huma.ErrorModel) (s string) {
	for _, d := range m.Errors {
		s += d.Message + ";"
	}
	return
}

// The trends memo keeps at most trendsMemoMax entries, dropping expired
// ones first and then the oldest.
func TestTrendsMemoIsBounded(t *testing.T) {
	var c trendsCache
	t0 := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	c.put("stale", TrendsBody{Computed: t0.Add(-TrendsTTL)})
	for i := 1; i < trendsMemoMax; i++ {
		c.put(fmt.Sprint("z", i), TrendsBody{Computed: t0.Add(time.Duration(i) * time.Second)})
	}
	c.put("new", TrendsBody{Computed: t0.Add(time.Minute)})
	if _, ok := c.byKey["stale"]; ok || len(c.byKey) != trendsMemoMax {
		t.Fatalf("stale kept or size %d", len(c.byKey))
	}
	c.put("newer", TrendsBody{Computed: t0.Add(2 * time.Minute)})
	if _, ok := c.byKey["z1"]; ok || len(c.byKey) != trendsMemoMax {
		t.Fatalf("oldest kept or size %d", len(c.byKey))
	}
}

// A request waits for a running trends refresh only as long as its own
// context allows (503 when out of time, with no earlier sums to answer),
// while the refresh carries on and is shared by every waiter.
func TestTrendsWaitersRespectTheirDeadline(t *testing.T) {
	gate := make(chan struct{})
	var runs atomic.Int32
	s := &Server{Log: slog.New(slog.DiscardHandler), trendsRefresh: func(context.Context) error { runs.Add(1); <-gate; return nil }}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := s.refreshTrends(ctx)
	var se huma.StatusError
	if !errors.As(err, &se) || se.GetStatus() != 503 || time.Since(start) > time.Second {
		t.Fatalf("out of time: %v after %v", err, time.Since(start))
	}
	// The refresh the first request started is still running, and a second
	// request joins it rather than starting another.
	done := make(chan bool)
	go func() { fresh, err := s.refreshTrends(context.Background()); done <- fresh && err == nil }()
	select {
	case <-done:
		t.Fatal("answered before the refresh ended")
	case <-time.After(50 * time.Millisecond):
	}
	if n := runs.Load(); n != 1 {
		t.Fatalf("%d refreshes running", n)
	}
	close(gate)
	if !<-done {
		t.Fatal("the refresh did not answer its waiter")
	}
}
