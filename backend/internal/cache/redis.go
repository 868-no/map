// Package cache wraps Redis, an ephemeral and fully rebuildable cache
// (spec §5). Every call degrades gracefully: callers get an error and fall
// back to computing from packet_log.
package cache

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Keys used by ingestion.
const (
	LiveChannel    = "meshmap:live"
	obsPrefix      = "meshmap:obs:"
	ObservationTTL = 15 * time.Minute
	opTimeout      = 250 * time.Millisecond
	MaintStatusKey = "meshmap:maint:status"
)

// Client is a thin Redis wrapper with short per-operation timeouts.
type Client struct {
	R *redis.Client
}

// New parses a redis:// URL. It does not connect eagerly.
func New(url string) (*Client, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	opt.DialTimeout = 2 * time.Second
	opt.ReadTimeout = time.Second
	opt.WriteTimeout = time.Second
	opt.PoolSize = 32
	return &Client{R: redis.NewClient(opt)}, nil
}

func ctxT(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, opTimeout)
}

// Ping checks connectivity.
func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := ctxT(ctx)
	defer cancel()
	return c.R.Ping(ctx).Err()
}

// LookupObservations returns the packet_log row id stored for each
// recently committed observation key (0 when not seen).
func (c *Client) LookupObservations(ctx context.Context, keys [][16]byte) ([]int64, error) {
	ctx, cancel := ctxT(ctx)
	defer cancel()
	names := make([]string, len(keys))
	for i, k := range keys {
		names[i] = obsPrefix + string(k[:])
	}
	vals, err := c.R.MGet(ctx, names...).Result()
	if err != nil {
		return nil, err
	}
	out := make([]int64, len(keys))
	for i, v := range vals {
		if s, ok := v.(string); ok {
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil || n <= 0 {
				n = -1 // seen, id unknown
			}
			out[i] = n
		}
	}
	return out, nil
}

// MarkObservations records committed observation keys with their row ids
// (after commit only).
func (c *Client) MarkObservations(ctx context.Context, keys [][16]byte, ids []int64) error {
	ctx, cancel := ctxT(ctx)
	defer cancel()
	pipe := c.R.Pipeline()
	for i, k := range keys {
		pipe.Set(ctx, obsPrefix+string(k[:]), ids[i], ObservationTTL)
	}
	_, err := pipe.Exec(ctx)
	return err
}

// Publish sends a live event to API processes.
func (c *Client) Publish(ctx context.Context, channel string, payload []byte) error {
	ctx, cancel := ctxT(ctx)
	defer cancel()
	return c.R.Publish(ctx, channel, payload).Err()
}

// Close releases connections.
func (c *Client) Close() error { return c.R.Close() }
