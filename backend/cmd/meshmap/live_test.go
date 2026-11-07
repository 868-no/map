package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

// Batches handed over up to the end of the pipeline's shutdown drain are
// published before close returns; later ones are ignored, not a panic.
func TestLivePublisherPublishesUntilClosed(t *testing.T) {
	var mu sync.Mutex
	var got []string
	release := make(chan struct{})
	p := startLivePublisher(func(_ context.Context, b json.RawMessage) error {
		<-release // Redis slower than the writer: batches wait in the queue
		mu.Lock()
		defer mu.Unlock()
		got = append(got, string(b))
		return nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, b := range []string{"[1]", "[2]", "[3]"} {
		p.PublishLive(context.Background(), json.RawMessage(b))
	}
	close(release)
	p.close(5 * time.Second)
	p.PublishLive(context.Background(), json.RawMessage("[4]"))
	p.close(time.Second) // a second close is harmless
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 || got[0] != "[1]" || got[2] != "[3]" {
		t.Fatalf("published %v, want [1] [2] [3]", got)
	}
}

// A stalled Redis neither blocks the writer nor holds up shutdown for
// longer than close's bound.
func TestLivePublisherDoesNotBlock(t *testing.T) {
	stall := make(chan struct{})
	defer close(stall)
	p := startLivePublisher(func(context.Context, json.RawMessage) error { <-stall; return nil },
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	start := time.Now()
	for range 10 * liveBacklog {
		p.PublishLive(context.Background(), json.RawMessage("[]"))
	}
	p.close(100 * time.Millisecond)
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("publishing to a stalled Redis took %s", d)
	}
}
