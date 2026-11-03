//go:build integration

package integration

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/obsrow"
	"github.com/868-no/map/internal/storage"
)

// D-116: partial indexes on rows the startup jobs still have to rewrite,
// on every partition, named after the version they serve; the job queries
// use them instead of walking the table.
func TestStaleRowIndexes(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	decodeIdx := fmt.Sprintf("packet_log_stale_decode_v%d_idx", ingest.DecodeVersion)
	obsIdx := fmt.Sprintf("packet_log_stale_obsrow_v%d_idx", obsrow.Version)

	parts := count(t, pool, `SELECT count(*) FROM pg_inherits WHERE inhparent = 'packet_log'::regclass`)
	for _, idx := range []string{decodeIdx, obsIdx} {
		if n := count(t, pool, `SELECT count(*) FROM pg_inherits WHERE inhparent = to_regclass($1)`, idx); parts == 0 || n != parts {
			t.Fatalf("%s on %d of %d partitions", idx, n, parts)
		}
	}

	// Another version's index is dropped; the current one is kept.
	if _, err := pool.Exec(ctx, `CREATE INDEX packet_log_stale_decode_v1_idx ON packet_log (id) WHERE decode_version < 1`); err != nil {
		t.Fatal(err)
	}
	if err := storage.InitSchema(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if n := count(t, pool, `SELECT count(*) FROM pg_indexes WHERE tablename = 'packet_log' AND indexname LIKE 'packet_log_stale_%'`); n != 2 ||
		count(t, pool, `SELECT count(*) FROM pg_inherits WHERE inhparent = to_regclass($1)`, decodeIdx) != parts {
		t.Fatalf("%d stale-row indexes, want the current 2", n)
	}

	// With current rows and one stale one, each job's query uses its index.
	f := newFixture(t, pool)
	for i := range 300 {
		f.position(base.Add(time.Duration(i)*time.Minute), nodeA, gw1, 63.0)
	}
	if _, err := pool.Exec(ctx, `UPDATE packet_log SET decode_version = 1, obs_row_version = NULL WHERE id = (SELECT min(id) FROM packet_log)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ANALYZE packet_log`); err != nil {
		t.Fatal(err)
	}
	for idx, where := range map[string]string{
		decodeIdx: fmt.Sprintf("decode_version < %d", ingest.DecodeVersion),
		obsIdx:    fmt.Sprintf("obs_row_version IS DISTINCT FROM %d", obsrow.Version),
	} {
		rows, err := pool.Query(ctx, `EXPLAIN SELECT id FROM packet_log WHERE id < $1 AND `+where+` ORDER BY id DESC LIMIT 500 FOR UPDATE`, int64(1)<<62)
		if err != nil {
			t.Fatal(err)
		}
		var plan strings.Builder
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			plan.WriteString(line + "\n")
		}
		rows.Close()
		// The plan names the partitions' own indexes.
		used := false
		children, err := pool.Query(ctx, `SELECT inhrelid::regclass::text FROM pg_inherits WHERE inhparent = to_regclass($1)`, idx)
		if err != nil {
			t.Fatal(err)
		}
		for children.Next() {
			var name string
			if err := children.Scan(&name); err != nil {
				t.Fatal(err)
			}
			used = used || strings.Contains(plan.String(), " "+name+" ")
		}
		if children.Close(); !used { // empty partitions may be scanned, at no cost
			t.Fatalf("%s not used:\n%s", idx, plan.String())
		}
	}
}
