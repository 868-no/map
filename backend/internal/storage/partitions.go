package storage

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// packet_log is partitioned by calendar month (UTC) of observed_at (D-056).
// A month's partition is packet_log_pYYYYMM.

// Month is the first instant (UTC) of t's month.
func Month(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// PartitionName is the partition holding month m.
func PartitionName(m time.Time) string {
	return fmt.Sprintf("packet_log_p%04d%02d", m.Year(), int(m.Month()))
}

var partitionRe = regexp.MustCompile(`^packet_log_p(\d{4})(\d{2})$`)

// execer is a pool, connection or transaction.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// known caches months whose partition this process created or saw, so
// inserts check the catalog only when a batch reaches a new month.
var known sync.Map // time.Time -> struct{}

// forgetPartitions drops the cache (after an insert failed, perhaps because
// retention dropped a month another process still remembered).
func forgetPartitions() { known.Clear() }

// EnsurePartitions creates the monthly partitions covering [from, to].
// Concurrent callers serialise on an advisory lock; existing partitions are
// left alone.
func EnsurePartitions(ctx context.Context, db execer, from, to time.Time) error {
	var missing []time.Time
	for m := Month(from); !m.After(Month(to)); m = m.AddDate(0, 1, 0) {
		if _, ok := known.Load(m); !ok {
			missing = append(missing, m)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	for _, m := range missing {
		// One statement per month: the transaction-scoped lock is taken in
		// the same implicit transaction as the CREATE.
		_, err := db.Exec(ctx, fmt.Sprintf(`SELECT pg_advisory_xact_lock(hashtext('meshmap:partitions'));
			CREATE TABLE IF NOT EXISTS %s PARTITION OF packet_log
			FOR VALUES FROM ('%s') TO ('%s') WITH (fillfactor = 90)`,
			PartitionName(m), m.Format(time.RFC3339), m.AddDate(0, 1, 0).Format(time.RFC3339)))
		if err != nil {
			return fmt.Errorf("partition %s: %w", PartitionName(m), err)
		}
		known.Store(m, struct{}{})
	}
	return nil
}

// Partitions lists packet_log's partitions by month, oldest first.
func Partitions(ctx context.Context, db execer) ([]time.Time, error) {
	rows, err := db.Query(ctx, `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
		WHERE i.inhparent = 'packet_log'::regclass`)
	if err != nil {
		return nil, err
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	var out []time.Time
	for _, n := range names {
		p := partitionRe.FindStringSubmatch(n)
		if p == nil {
			return nil, fmt.Errorf("unexpected packet_log partition %q", n)
		}
		// Atoi, not Sscan: Sscan reads "08" as a malformed octal number.
		y, _ := strconv.Atoi(p[1])
		mo, _ := strconv.Atoi(p[2])
		out = append(out, time.Date(y, time.Month(mo), 1, 0, 0, 0, 0, time.UTC))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Before(out[j]) })
	return out, nil
}

// DropPartition removes a whole month, returning how many rows it held.
func DropPartition(ctx context.Context, db execer, m time.Time) (int64, error) {
	var n int64
	rows, err := db.Query(ctx, fmt.Sprintf(`SELECT count(*) FROM %s`, PartitionName(m)))
	if err != nil {
		return 0, err
	}
	if rows.Next() {
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return 0, err
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if _, err := db.Exec(ctx, fmt.Sprintf(`DROP TABLE IF EXISTS %s`, PartitionName(m))); err != nil {
		return 0, err
	}
	known.Delete(m)
	return n, nil
}

// TableBytes is packet_log's size on disk: all partitions with indexes and
// TOAST (the parent itself holds nothing).
func TableBytes(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var n int64
	err := pool.QueryRow(ctx, `SELECT COALESCE(sum(pg_total_relation_size(inhrelid)), 0)::bigint
		FROM pg_inherits WHERE inhparent = 'packet_log'::regclass`).Scan(&n)
	return n, err
}

// migrateUnpartitioned converts a schema-1 packet_log (a plain table with an
// identity id) into the partitioned table in one transaction: the old table
// is renamed, the new one created by schema.sql, rows copied with their ids
// (one per observation key and time, D-056) and the sequence moved past them.
// It does nothing when packet_log is already partitioned or absent.
func migrateUnpartitioned(ctx context.Context, conn *pgxpool.Conn, schema string) (int64, error) {
	var kind string
	err := conn.QueryRow(ctx, `SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.packet_log')`).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && kind != "r") {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx)) //nolint:errcheck
	var lo, hi *time.Time
	var maxID int64
	if err := tx.QueryRow(ctx, `SELECT min(observed_at), max(observed_at), COALESCE(max(id), 0) FROM packet_log`).Scan(&lo, &hi, &maxID); err != nil {
		return 0, err
	}
	// Free every name the new table uses: the identity sequence, the
	// primary key and the indexes.
	for _, q := range []string{
		`ALTER TABLE packet_log RENAME TO packet_log_schema1`,
		`ALTER TABLE packet_log_schema1 ALTER COLUMN id DROP IDENTITY IF EXISTS`,
		`ALTER TABLE packet_log_schema1 DROP CONSTRAINT IF EXISTS packet_log_pkey`,
		`DROP INDEX IF EXISTS packet_log_time_idx, packet_log_source_time_idx, packet_log_observation_idx,
			packet_log_type_time_idx, packet_log_brin, packet_log_gateway_time_idx, packet_log_logical_idx`,
	} {
		if _, err := tx.Exec(ctx, q); err != nil {
			return 0, fmt.Errorf("%s: %w", q, err)
		}
	}
	if _, err := tx.Exec(ctx, schema); err != nil {
		return 0, fmt.Errorf("create partitioned table: %w", err)
	}
	if lo != nil {
		if err := EnsurePartitions(ctx, tx, *lo, *hi); err != nil {
			forgetPartitions() // the transaction may roll back
			return 0, err
		}
	}
	cols := "id, " + joinColumns()
	tag, err := tx.Exec(ctx, `INSERT INTO packet_log (`+cols+`)
		SELECT DISTINCT ON (observation_key, observed_at) `+cols+` FROM packet_log_schema1
		ORDER BY observation_key, observed_at, id`)
	if err != nil {
		forgetPartitions()
		return 0, fmt.Errorf("copy rows: %w", err)
	}
	if maxID > 0 {
		if _, err := tx.Exec(ctx, `SELECT setval('packet_log_id_seq', $1)`, maxID); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, `DROP TABLE packet_log_schema1`); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		forgetPartitions()
		return 0, err
	}
	return tag.RowsAffected(), nil
}
