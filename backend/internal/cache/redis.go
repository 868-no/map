// Package cache wraps Redis, an ephemeral and fully rebuildable cache
// (design §3.6). Every call degrades gracefully: callers get an error and fall
// back to computing from packet_log.
package cache

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Keys used by ingestion.
const (
	LiveChannel    = "meshmap:live"
	obsPrefix      = "meshmap:obs:"
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
	// Each call's context deadline bounds its socket reads and writes (go-redis
	// ignores it otherwise): opTimeout for small operations, blobTimeout for a
	// day. The socket timeouts are only the ceiling, for calls without one.
	opt.ContextTimeoutEnabled = true
	opt.ReadTimeout = blobTimeout
	opt.WriteTimeout = blobTimeout
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
// (after commit only), for the dedupe window ttl.
func (c *Client) MarkObservations(ctx context.Context, keys [][16]byte, ids []int64, ttl time.Duration) error {
	ctx, cancel := ctxT(ctx)
	defer cancel()
	pipe := c.R.Pipeline()
	for i, k := range keys {
		pipe.Set(ctx, obsPrefix+string(k[:]), ids[i], ttl)
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

// blobTimeout bounds one operation on a large value (a cached day of rows,
// several MB): longer than opTimeout, still far below a database read.
const blobTimeout = 3 * time.Second

// GetBlob returns the value at key; nil without error when there is none.
func (c *Client) GetBlob(ctx context.Context, key string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, blobTimeout)
	defer cancel()
	b, err := c.R.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	return b, err
}

// SetBlob stores val at key for ttl.
func (c *Client) SetBlob(ctx context.Context, key string, val []byte, ttl time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, blobTimeout)
	defer cancel()
	return c.R.Set(ctx, key, val, ttl).Err()
}

// Lock takes key for ttl unless someone holds it, with token as its value.
func (c *Client) Lock(ctx context.Context, key, token string, ttl time.Duration) (bool, error) {
	ctx, cancel := ctxT(ctx)
	defer cancel()
	return c.R.SetNX(ctx, key, token, ttl).Result()
}

// unlock deletes a lock only while it still holds the caller's token: one
// that expired and was taken by another is left alone.
var unlock = redis.NewScript(`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`)

// Unlock releases a lock taken with token.
func (c *Client) Unlock(ctx context.Context, key, token string) error {
	ctx, cancel := ctxT(ctx)
	defer cancel()
	return unlock.Run(ctx, c.R, []string{key}, token).Err()
}
