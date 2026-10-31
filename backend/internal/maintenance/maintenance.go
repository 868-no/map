// Package maintenance runs retention: chunked deletion of rows older than the
// configured cutoff under an advisory lock, then VACUUM (ANALYZE) and cache
// invalidation. Safe to run repeatedly and from several processes.
package maintenance

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/868-no/map/internal/cache"
	"github.com/868-no/map/internal/observability"
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
	DeletedRows int64     `json:"deleted_rows"`
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
	Metrics  *observability.Metrics
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
	for {
		tag, err := conn.Exec(ctx, `DELETE FROM packet_log WHERE id IN (
			SELECT id FROM packet_log WHERE observed_at < $1 ORDER BY observed_at, id LIMIT $2)`, cutoff, chunkSize)
		if err != nil {
			return st, err
		}
		n := tag.RowsAffected()
		st.DeletedRows += n
		if r.Metrics != nil {
			r.Metrics.RetentionRows.Add(float64(n))
		}
		if n < chunkSize {
			break
		}
		select {
		case <-ctx.Done():
			return st, ctx.Err()
		case <-time.After(chunkPause):
		}
	}
	if st.DeletedRows > 0 {
		if _, err := conn.Exec(ctx, `VACUUM (ANALYZE) packet_log`); err != nil {
			r.Log.Warn("vacuum failed", "err", err)
		}
	}
	if err := conn.QueryRow(ctx, `SELECT pg_total_relation_size('packet_log')`).Scan(&st.TableBytes); err != nil {
		return st, err
	}
	st.LastRun = r.now().UTC()
	st.DurationMS = time.Since(start).Milliseconds()
	r.publish(ctx, st)
	r.Log.Info("retention complete", "cutoff", cutoff, "deleted", st.DeletedRows, "table_bytes", st.TableBytes)
	return st, nil
}

// publish invalidates caches (retention revision) and shares the status.
func (r *Runner) publish(ctx context.Context, st Status) {
	if r.Cache == nil {
		return
	}
	b, _ := json.Marshal(st)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if st.DeletedRows > 0 {
		if err := r.Cache.R.Incr(ctx, cache.RetentionRevKey).Err(); err != nil {
			r.Log.Warn("retention revision bump failed; caches expire by TTL", "err", err)
		}
	}
	if err := r.Cache.R.Set(ctx, cache.MaintStatusKey, b, 0).Err(); err != nil {
		r.Log.Warn("status store failed", "err", err)
	}
	_ = r.Cache.Publish(ctx, RetentionChannel, b)
}

// LastStatus reads the shared status (nil if unknown).
func LastStatus(ctx context.Context, c *cache.Client) (*Status, error) {
	if c == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	b, err := c.R.Get(ctx, cache.MaintStatusKey).Bytes()
	if err != nil {
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
		wait := r.Interval
		if !ok {
			wait = 5 * time.Minute // retry failed runs soon, not at the next daily slot
		} else if r.Interval == 24*time.Hour {
			now := r.now().UTC()
			next := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, time.UTC)
			if !next.After(now) {
				next = next.Add(24 * time.Hour)
			}
			wait = next.Sub(now)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
			ok = r.runLogged(ctx)
		}
	}
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
