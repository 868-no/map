package cache

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

// Results caches computed, window-scoped API results. Keys always include
// the exact window, filters and data revision (see api.cacheKey), so an
// entry can never answer a different window. When Redis is unavailable
// callers compute directly; concurrent identical requests are coalesced
// in-process either way.
type Results struct {
	c     *Client // may be nil
	group singleflight.Group
	onErr func(op string)
}

// NewResults wraps an optional Redis client.
func NewResults(c *Client, onErr func(op string)) *Results {
	if onErr == nil {
		onErr = func(string) {}
	}
	return &Results{c: c, onErr: onErr}
}

// RetentionRev returns the retention revision (bumped when rows are deleted).
// ok is false when Redis is unavailable; callers then skip caching.
func (r *Results) RetentionRev(ctx context.Context) (int64, bool) {
	if r.c == nil {
		return 0, false
	}
	ctx, cancel := ctxT(ctx)
	defer cancel()
	v, err := r.c.R.Get(ctx, RetentionRevKey).Int64()
	if errors.Is(err, redis.Nil) {
		return 0, true
	}
	if err != nil {
		r.onErr("retention_rev")
		return 0, false
	}
	return v, true
}

// Get returns a cached value or computes, stores and returns it. When
// useCache is false (e.g. Redis down) it only coalesces.
func Get[T any](ctx context.Context, r *Results, key string, ttl time.Duration, useCache bool, compute func(context.Context) (T, error)) (T, error) {
	var zero T
	if useCache && r.c != nil {
		gctx, cancel := ctxT(ctx)
		b, err := r.c.R.Get(gctx, key).Bytes()
		cancel()
		if err == nil {
			var v T
			if json.Unmarshal(b, &v) == nil {
				return v, nil
			}
		} else if !errors.Is(err, redis.Nil) {
			r.onErr("result_get")
			useCache = false
		}
	}
	v, err, _ := r.group.Do(key, func() (any, error) {
		v, err := compute(context.WithoutCancel(ctx))
		if err != nil {
			return nil, err
		}
		if useCache && r.c != nil {
			if b, err := json.Marshal(v); err == nil {
				sctx, cancel := ctxT(ctx)
				if err := r.c.R.Set(sctx, key, b, ttl).Err(); err != nil {
					r.onErr("result_set")
				}
				cancel()
			}
		}
		return v, nil
	})
	if err != nil {
		return zero, err
	}
	return v.(T), nil
}

// ResultKeyPrefix prefixes every computed-result key (see api.cacheKey).
const ResultKeyPrefix = "meshmap:res:"

// Flush deletes every cached result. Called at startup: a deploy may change
// how results are derived, and cache keys do not encode code versions.
// Dedupe keys and the retention revision are untouched.
func (r *Results) Flush(ctx context.Context) (int, error) {
	if r.c == nil {
		return 0, nil
	}
	n := 0
	iter := r.c.R.Scan(ctx, 0, ResultKeyPrefix+"*", 500).Iterator()
	var batch []string
	for iter.Next(ctx) {
		batch = append(batch, iter.Val())
		if len(batch) == 500 {
			if err := r.c.R.Unlink(ctx, batch...).Err(); err != nil {
				return n, err
			}
			n += len(batch)
			batch = batch[:0]
		}
	}
	if err := iter.Err(); err != nil {
		return n, err
	}
	if len(batch) > 0 {
		if err := r.c.R.Unlink(ctx, batch...).Err(); err != nil {
			return n, err
		}
		n += len(batch)
	}
	return n, nil
}
