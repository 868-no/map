//go:build integration

package integration

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/868-no/map/internal/api"
	"github.com/868-no/map/internal/cache"
)

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// D-117: a lost Redis subscription is noticed and replaced. API-only live
// goes unavailable and back (browsers then sync what they missed), messages
// flow again after the reconnect, and cancelling stops the feed at once.
func TestRedisFeedReconnects(t *testing.T) {
	rc := redisClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hub := api.NewHub(false)
	fed := make(chan struct{})
	go func() { hub.FeedFromRedis(ctx, rc, true, quiet); close(fed) }()

	var mu sync.Mutex
	var ups, downs int
	var got []string
	listened := make(chan struct{})
	go func() {
		rc.Listen(ctx, []string{"meshmap:it"}, cache.Listener{
			Up:      func() { mu.Lock(); ups++; mu.Unlock() },
			Down:    func(error) { mu.Lock(); downs++; mu.Unlock() },
			Message: func(_, p string) { mu.Lock(); got = append(got, p); mu.Unlock() },
			Idle:    100 * time.Millisecond,
		})
		close(listened)
	}()
	state := func() (int, int, int) { mu.Lock(); defer mu.Unlock(); return ups, downs, len(got) }

	eventually(t, "live available", hub.Available)
	eventually(t, "listener up", func() bool { u, _, _ := state(); return u == 1 })
	// A quiet but healthy subscription is pinged, not counted lost.
	time.Sleep(time.Second)
	if u, d, _ := state(); u != 1 || d != 0 {
		t.Fatalf("idle subscription: %d ups, %d downs", u, d)
	}

	// The server drops every subscriber connection, as on a Redis restart.
	if err := rc.R.Do(ctx, "CLIENT", "KILL", "TYPE", "pubsub").Err(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live unavailable", func() bool { return !hub.Available() })
	eventually(t, "live available again", hub.Available)
	eventually(t, "listener up again", func() bool { u, d, _ := state(); return u == 2 && d == 1 })

	if err := rc.R.Publish(ctx, "meshmap:it", "after").Err(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "message after reconnect", func() bool { _, _, n := state(); return n == 1 })

	cancel()
	for _, done := range []chan struct{}{fed, listened} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("feed did not stop on cancel")
		}
	}
}
