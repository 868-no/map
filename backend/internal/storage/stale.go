package storage

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/obsrow"
)

// packetLogIndexes are packet_log's indexes by name, on the partitioned
// parent so every partition (and every partition created later) gets them.
// They are created from Go, and only when missing: CREATE INDEX IF NOT
// EXISTS on a partitioned table takes a SHARE lock on every partition before
// it finds the index there, so on every start it would wait behind VACUUM or
// a backfill and hold up the inserts queued behind it.
var packetLogIndexes = []struct {
	name   string
	unique bool
	on     string
}{
	// Serves every /observations page ((observed_at, id) keyset order,
	// D-038) and the retention delete inside the oldest kept month.
	{"packet_log_time_idx", false, `(observed_at DESC, id DESC)`},
	// NodeInfo rows per node in id order: the identity rebuild (verified
	// rows) and a node's latest announced public key. Partial, so other
	// inserts never touch it. It replaces two full indexes on
	// (source_node_id, observed_at) and (packet_type, observed_at), and a
	// narrower verified-only one (dropped by schema.sql).
	{"packet_log_nodeinfo_idx", false, `(source_node_id, id) WHERE packet_type = 'nodeinfo'`},
	// One row per reception (D-056): a batch retried after a commit whose
	// outcome was lost inserts nothing twice. Also the ingest dedupe lookup.
	{"packet_log_observation_key", true, `(observation_key, observed_at)`},
	{staleDecodeIdx, false, `(id) WHERE ` + staleDecodePred},
	{staleObsRowIdx, false, `(id) WHERE ` + staleObsRowPred},
}

// Partial indexes on the rows the startup jobs still have to rewrite: rows
// decoded by an older ingest.DecodeVersion (Redecode) and rows without the
// current obsrow.Version encoding (BackfillObsRows). New rows carry both
// versions, so in steady state the indexes are empty, no insert touches them,
// and each job finds nothing without walking the table (D-116).
//
// A partial index predicate must be a constant, so each is named after the
// version it was built for: a version bump builds the new one (once, at
// init-schema) and drops the old. The job queries repeat the predicate with
// the same literal, so the planner can prove it and use the index.
var (
	staleDecodePred = fmt.Sprintf("decode_version < %d", ingest.DecodeVersion)
	staleObsRowPred = fmt.Sprintf("obs_row_version IS DISTINCT FROM %d", obsrow.Version)
	staleDecodeIdx  = fmt.Sprintf("packet_log_stale_decode_v%d_idx", ingest.DecodeVersion)
	staleObsRowIdx  = fmt.Sprintf("packet_log_stale_obsrow_v%d_idx", obsrow.Version)
)

// ensureIndexes creates packet_log's missing indexes and drops the stale-row
// indexes of other versions, each under the partition DDL's lock timeout
// (D-166). Idempotent; with every index in place it takes no lock at all.
func ensureIndexes(ctx context.Context, db execer) error {
	rows, err := db.Query(ctx, `SELECT indexname::text FROM pg_indexes
		WHERE schemaname = 'public' AND tablename = 'packet_log'`)
	if err != nil {
		return err
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	have := map[string]bool{}
	for _, n := range names {
		have[n] = true
		stale := strings.HasPrefix(n, "packet_log_stale_decode_v") || strings.HasPrefix(n, "packet_log_stale_obsrow_v")
		if stale && n != staleDecodeIdx && n != staleObsRowIdx {
			if err := execDDL(ctx, db, `DROP INDEX IF EXISTS `+pgx.Identifier{n}.Sanitize()); err != nil {
				return err
			}
		}
	}
	for _, ix := range packetLogIndexes {
		if have[ix.name] {
			continue
		}
		kind := "INDEX"
		if ix.unique {
			kind = "UNIQUE INDEX"
		}
		if err := execDDL(ctx, db, fmt.Sprintf(`CREATE %s IF NOT EXISTS %s ON packet_log %s`, kind, ix.name, ix.on)); err != nil {
			return fmt.Errorf("index %s: %w", ix.name, err)
		}
	}
	return nil
}
