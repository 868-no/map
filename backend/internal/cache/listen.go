package cache

import (
	"context"
	"errors"
	"net"
	"time"

	"github.com/redis/go-redis/v9"
)

// Listener receives a Listen subscription's events.
type Listener struct {
	// Up is called once the subscription is confirmed, after every
	// (re)connect. Messages published while it was down are lost.
	Up func()
	// Down is called when an established subscription is lost.
	Down func(err error)
	// Message is called for each message, in order.
	Message func(channel, payload string)
	// Idle is how long a quiet subscription waits before pinging, and then
	// for the reply before counting the connection lost; default 10 s.
	Idle time.Duration
}

const (
	listenBackoffMin = time.Second
	listenBackoffMax = 30 * time.Second
)

// Listen subscribes to channels until ctx ends, reconnecting with
// exponential backoff. go-redis reconnects pub/sub connections by itself
// without telling anyone, so messages published meanwhile vanish unnoticed;
// here every lost connection is a Down and a fresh subscription an Up, so the
// caller knows when it may have missed messages.
func (c *Client) Listen(ctx context.Context, channels []string, l Listener) {
	backoff := listenBackoffMin
	for ctx.Err() == nil {
		up, err := c.listenOnce(ctx, channels, l)
		if ctx.Err() != nil {
			return
		}
		if up {
			backoff = listenBackoffMin
			if l.Down != nil {
				l.Down(err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(2*backoff, listenBackoffMax)
	}
}

// listenOnce runs one subscription until it fails; up reports whether it
// was ever confirmed.
func (c *Client) listenOnce(ctx context.Context, channels []string, l Listener) (up bool, err error) {
	sub := c.R.Subscribe(ctx, channels...)
	// Closing unblocks a pending receive at once when ctx ends.
	stop := context.AfterFunc(ctx, func() { _ = sub.Close() })
	defer func() {
		stop()
		_ = sub.Close()
	}()
	if _, err := sub.Receive(ctx); err != nil {
		return false, err
	}
	if l.Up != nil {
		l.Up()
	}
	idle := l.Idle
	if idle <= 0 {
		idle = 10 * time.Second
	}
	pinged := false
	for {
		msg, err := sub.ReceiveTimeout(ctx, idle)
		var ne net.Error
		switch {
		case err == nil:
			pinged = false
		case errors.As(err, &ne) && ne.Timeout() && !pinged:
			pctx, cancel := context.WithTimeout(ctx, time.Second)
			err := sub.Ping(pctx)
			cancel()
			if err != nil {
				return true, err
			}
			pinged = true
			continue
		default:
			return true, err
		}
		// Subscription confirmations and pongs only prove the link alive.
		if m, ok := msg.(*redis.Message); ok && l.Message != nil {
			l.Message(m.Channel, m.Payload)
		}
	}
}
