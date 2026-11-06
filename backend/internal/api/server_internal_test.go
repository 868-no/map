package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
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
// by the driver) is answered 499 and not logged as an error; a deadline is.
func TestClientGoneIsNotAnError(t *testing.T) {
	hideInternalErrors(slog.New(slog.DiscardHandler))
	for _, err := range []error{context.Canceled, fmt.Errorf("query: %w", context.Canceled)} {
		if s := huma.NewError(500, "unexpected error occurred", err).GetStatus(); s != statusClientClosed {
			t.Errorf("%v: status %d", err, s)
		}
	}
	if s := huma.NewError(500, "unexpected error occurred", context.DeadlineExceeded).GetStatus(); s != 500 {
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
