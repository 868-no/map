package api

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/868-no/map/internal/query"
)

// An empty page streams the same document the buffered body used to be.
func TestWriteObservationsEmptyPage(t *testing.T) {
	at := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	head := ObservationsBody{Window: WindowEcho{Start: at.Add(-time.Hour), End: at, Rolling: true}, Since: at.Add(-time.Hour), Until: at, Generation: "d1.r2.cx", Now: at}
	var buf bytes.Buffer
	cur := &query.Cursor{At: at.Add(-time.Minute), ID: 42}
	if err := writeObservations(&buf, head, nil, cur); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON %s: %v", buf.String(), err)
	}
	if rows, ok := got["rows"].([]any); !ok || len(rows) != 0 || got["more"] != false || got["next_cursor"] != cur.String() || got["generation"] != "d1.r2.cx" {
		t.Fatalf("unexpected body %s", buf.String())
	}
	buf.Reset()
	_ = writeObservations(&buf, head, nil, nil)
	if bytes.Contains(buf.Bytes(), []byte("next_cursor")) {
		t.Fatalf("no cursor expected: %s", buf.String())
	}
}
