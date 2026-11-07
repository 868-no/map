// Package maintenance runs retention under an advisory lock: months wholly
// before the configured cutoff are dropped as partitions (D-056), the rest of
// the expired rows (in the oldest kept month) are deleted in chunks and that
// partition vacuumed, upcoming months get their partitions, and, when rows
// were deleted, serve processes and open browsers are notified. Safe to run
// repeatedly and from several processes.
package maintenance

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/storage"
	"github.com/868-no/map/internal/window"
)

const (
	chunkSize  = 5000
	chunkPause = 50 * time.Millisecond
	// RetentionChannel notifies API/ingest processes that rows were deleted.
	RetentionChannel = "meshmap:retention"
)

// Status is the last run summary, shared through Redis for /health/ready.
type Status struct {
	LastRun     time.Time `json:"last_run"`
	Cutoff      time.Time `json:"cutoff"`
	DeletedRows int64     `json:"deleted_rows"` // dropped months by estimate (D-166)
	TableBytes  int64     `json:"table_bytes"`
	DurationMS  int64     `json:"duration_ms"`
}

// ErrLocked means another process holds the maintenance lock.
var ErrLocked = errors.New("maintenance already running elsewhere")

// Runner performs retention.
type Runner struct {
	Pool     *pgxpool.Pool
	Cache    *cache.Client // may be nil
	Months   int
	Interval time.Duration
	Log      *slog.Logger
	Now      func() time.Time
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// RunOnce deletes expired rows in short transactions.
func (r *Runner) RunOnce(ctx context.Context) (Status, error) {
	start := r.now()
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return Status{}, err
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext('meshmap:maintenance'))`).Scan(&got); err != nil {
		return Status{}, err
	}
	if !got {
		return Status{}, ErrLocked
	}
	defer conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtext('meshmap:maintenance'))`) //nolint:errcheck

	cutoff := window.RetentionCutoff(start, r.Months)
	st := Status{Cutoff: cutoff}
	now := r.now()
	if err := storage.EnsurePartitions(ctx, conn, now, now.AddDate(0, 2, 0)); err != nil {
		return st, err
	}
	months, err := storage.Partitions(ctx, conn)
	if err != nil {
		return st, err
	}
	for _, m := range months {
		if m.AddDate(0, 1, 0).After(cutoff) {
			break
		}
		n, err := storage.DropPartition(ctx, conn, m)
		if err != nil {
			return st, err
		}
		st.DeletedRows += n
		r.Log.Info("retention dropped a month", "partition", storage.PartitionName(m), "rows", n)
	}
	var trimmed int64
	for {
		// By (id, observed_at), the primary key: the delete reaches only the
		// partition the rows are in, not every partition's index.
		tag, err := conn.Exec(ctx, `DELETE FROM packet_log WHERE (id, observed_at) IN (
			SELECT id, observed_at FROM packet_log WHERE observed_at < $1 ORDER BY observed_at, id LIMIT $2)`, cutoff, chunkSize)
		if err != nil {
			return st, err
		}
		n := tag.RowsAffected()
		trimmed += n
		if n < chunkSize {
			break
		}
		select {
		case <-ctx.Done():
			return st, ctx.Err()
		case <-time.After(chunkPause):
		}
	}
	st.DeletedRows += trimmed
	// Weather is kept as long as the mesh data it sits beside (D-133).
	if _, err := conn.Exec(ctx, `DELETE FROM weather_hour WHERE valid_at < $1`, cutoff); err != nil {
		return st, err
	}
	if trimmed > 0 {
		// Only the month the cutoff falls in had rows deleted.
		if _, err := conn.Exec(ctx, `VACUUM (ANALYZE) `+storage.PartitionName(storage.Month(cutoff))); err != nil {
			r.Log.Warn("vacuum failed", "err", err)
		}
	}
	if st.TableBytes, err = storage.TableBytes(ctx, r.Pool); err != nil {
		return st, err
	}
	st.LastRun = r.now().UTC()
	st.DurationMS = time.Since(start).Milliseconds()
	r.publish(ctx, st)
	r.Log.Info("retention complete", "cutoff", cutoff, "deleted", st.DeletedRows, "table_bytes", st.TableBytes)
	return st, nil
}

// publish stores the status (for /health/ready) on every run, and announces
// a run that deleted rows: serve processes reload their identity index (a
// key's announcements may be gone) and tell open browsers, which re-read
// /retention for the new earliest bound. A run that deleted nothing changes
// neither, so it is not announced.
func (r *Runner) publish(ctx context.Context, st Status) {
	if r.Cache == nil {
		return
	}
	b, _ := json.Marshal(st)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := r.Cache.SetBlob(ctx, cache.MaintStatusKey, b, 0); err != nil {
		r.Log.Warn("status store failed", "err", err)
	}
	if st.DeletedRows == 0 {
		return
	}
	// Lost, open browsers keep the old earliest bound until they next read
	// /retention, and serve processes their identities until the next reload.
	if err := r.Cache.Publish(ctx, RetentionChannel, b); err != nil {
		r.Log.Warn("retention notice not published", "err", err)
	}
}

// LastStatus reads the shared status (nil if unknown).
func LastStatus(ctx context.Context, c *cache.Client) (*Status, error) {
	if c == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	b, err := c.GetBlob(ctx, cache.MaintStatusKey)
	if err != nil || b == nil {
		return nil, err
	}
	var st Status
	return &st, json.Unmarshal(b, &st)
}

// Loop runs immediately if overdue (or status unknown), then daily at
// 03:00 UTC when Interval is 24 h, otherwise every Interval.
func (r *Runner) Loop(ctx context.Context) error {
	ok := true
	if st, err := LastStatus(ctx, r.Cache); err != nil || st == nil || r.now().Sub(st.LastRun) >= r.Interval {
		ok = r.runLogged(ctx)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(nextRun(r.now(), r.Interval, ok)):
			ok = r.runLogged(ctx)
		}
	}
}

// nextRun is how long to wait after a run at now: 5 minutes after a failed
// one, retried soon rather than at the next daily slot; otherwise until
// 03:00 UTC when the interval is a day, or the interval.
func nextRun(now time.Time, interval time.Duration, ok bool) time.Duration {
	switch {
	case !ok:
		return 5 * time.Minute
	case interval != 24*time.Hour:
		return interval
	}
	now = now.UTC()
	next := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, time.UTC)
	if !next.After(now) {
		next = next.Add(24 * time.Hour)
	}
	return next.Sub(now)
}

// runLogged reports false only for failures worth retrying soon.
func (r *Runner) runLogged(ctx context.Context) bool {
	if _, err := r.RunOnce(ctx); err != nil {
		if errors.Is(err, ErrLocked) {
			r.Log.Info("maintenance skipped: lock held elsewhere")
			return true
		}
		if ctx.Err() == nil {
			r.Log.Error("maintenance failed", "err", err)
		}
		return false
	}
	return true
}
