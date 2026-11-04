package api

import (
	"errors"
	"log/slog"
	"strings"
	"testing"

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

func errDetails(m *huma.ErrorModel) (s string) {
	for _, d := range m.Errors {
		s += d.Message + ";"
	}
	return
}
