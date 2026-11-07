package cache

import (
	"context"
	"net"
	"testing"
	"time"
)

// A Redis that accepts connections and never answers costs a call its own
// deadline, not the client's socket timeout (go-redis ignores context
// deadlines unless told to use them).
func TestCallsKeepTheirOwnDeadlines(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = c.Close() }) // held open, never answered
		}
	}()
	c, err := New("redis://" + ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.R.Close() })
	start := time.Now()
	if err := c.Ping(context.Background()); err == nil {
		t.Fatal("ping answered by a silent server")
	}
	if d := time.Since(start); d > 700*time.Millisecond {
		t.Fatalf("ping took %s, want about %s", d, opTimeout)
	}
}
