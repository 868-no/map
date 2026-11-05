package storage

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/window"
)

// The history revision (D-158) counts changes to past rows that neither the
// decoder nor the row format accounts for: imports of recorded history
// (D-137). It is part of the /observations generation, so browsers and the
// shared day cache never keep a day from before an import. An import bumps
// it when it starts (a crashed import still invalidates what it touched) and
// when it ends (what was read while it ran is not reused), and holds a shared
// advisory lock while it runs, released by PostgreSQL even if the process
// dies, so no day is marked immutable meanwhile.
const (
	historyLockClass = 868 // advisory lock key (two int4 keys: classid, objid)
	historyLockObj   = 1
)

// HistoryState is the history revision and whether an import is running.
type HistoryState struct {
	Rev       int64
	Importing bool
}

// History reads the history revision and whether an import holds the lock.
// A sequence that was never advanced reads as 0.
func History(ctx context.Context, pool *pgxpool.Pool) (HistoryState, error) {
	var s HistoryState
	err := pool.QueryRow(ctx, fmt.Sprintf(`SELECT (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM packet_log_history_rev),
		EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = %d AND objid = %d AND objsubid = 2)`,
		historyLockClass, historyLockObj)).Scan(&s.Rev, &s.Importing)
	return s, err
}

// BeginHistoryChange marks the start of an import of past rows: it takes the
// shared import lock on a connection of its own and bumps the revision.
// finish bumps it again and releases the lock; call it however the import
// ends.
func BeginHistoryChange(ctx context.Context, pool *pgxpool.Pool) (finish func() error, err error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	lock := fmt.Sprintf(`SELECT pg_advisory_lock_shared(%d, %d)`, historyLockClass, historyLockObj)
	if _, err := conn.Exec(ctx, lock); err != nil {
		conn.Release()
		return nil, err
	}
	bump := func(ctx context.Context) error {
		_, err := conn.Exec(ctx, `SELECT nextval('packet_log_history_rev')`)
		return err
	}
	if err := bump(ctx); err != nil {
		conn.Exec(context.WithoutCancel(ctx), fmt.Sprintf(`SELECT pg_advisory_unlock_shared(%d, %d)`, historyLockClass, historyLockObj)) //nolint:errcheck
		conn.Release()
		return nil, fmt.Errorf("history revision (run init-schema or start serve once): %w", err)
	}
	return func() error {
		ctx := context.WithoutCancel(ctx)
		err := bump(ctx)
		_, uerr := conn.Exec(ctx, fmt.Sprintf(`SELECT pg_advisory_unlock_shared(%d, %d)`, historyLockClass, historyLockObj))
		conn.Release()
		return errors.Join(err, uerr)
	}, nil
}

// DaySettled reports whether a past day's rows are final for this decoder
// (D-159): no row in day is still waiting to be decoded again (D-107; served
// by the partial index on stale rows, D-116), and the writer has committed a
// row observed in after, which shows it got past the end of the day, since it
// commits in arrival order and retries a failed batch before taking more.
// Stored encodings of an older version do not matter: such rows are served
// from their columns, to the same content.
func DaySettled(ctx context.Context, pool *pgxpool.Pool, day, after window.Window) (bool, error) {
	var stale, later bool
	err := pool.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM packet_log WHERE `+staleDecodePred+` AND `+window.Predicate(1, 2)+`),
		EXISTS (SELECT 1 FROM packet_log WHERE `+window.Predicate(3, 4)+`)`,
		day.Start, day.End, after.Start, after.End).Scan(&stale, &later)
	return !stale && later, err
}
