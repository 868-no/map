package storage

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/ingest"
	"github.com/868-no/map/internal/obsrow"
)

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

// ensureStaleIndexes creates the current versions' partial indexes and drops
// those of other versions. On the partitioned parent, so every partition
// (and every partition created later) gets them. Idempotent.
func ensureStaleIndexes(ctx context.Context, conn *pgxpool.Conn) error {
	rows, err := conn.Query(ctx, `SELECT indexname::text FROM pg_indexes
		WHERE schemaname = 'public' AND tablename = 'packet_log'
		  AND (indexname LIKE 'packet\_log\_stale\_decode\_v%' OR indexname LIKE 'packet\_log\_stale\_obsrow\_v%')`)
	if err != nil {
		return err
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, n := range names {
		if n != staleDecodeIdx && n != staleObsRowIdx {
			if _, err := conn.Exec(ctx, `DROP INDEX IF EXISTS `+pgx.Identifier{n}.Sanitize()); err != nil {
				return err
			}
		}
	}
	for _, s := range []string{
		fmt.Sprintf(`CREATE INDEX IF NOT EXISTS %s ON packet_log (id) WHERE %s`, staleDecodeIdx, staleDecodePred),
		fmt.Sprintf(`CREATE INDEX IF NOT EXISTS %s ON packet_log (id) WHERE %s`, staleObsRowIdx, staleObsRowPred),
	} {
		if _, err := conn.Exec(ctx, s); err != nil {
			return err
		}
	}
	return nil
}
