package ingest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/868-no/map/internal/observability"
	"github.com/868-no/map/internal/security"
)

type memSink struct {
	mu       sync.Mutex
	rows     []*Observation
	failNext int
	refuse   func(*Observation) bool // rows the "database" cannot hold
	attempts int
}

type sqlStateErr string

func (e sqlStateErr) Error() string    { return "SQLSTATE " + string(e) }
func (e sqlStateErr) SQLState() string { return string(e) }

func (s *memSink) InsertBatch(_ context.Context, obs []*Observation) ([]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attempts++
	if s.failNext > 0 {
		s.failNext--
		return nil, errors.New("db down")
	}
	for _, o := range obs {
		if s.refuse != nil && s.refuse(o) {
			return nil, fmt.Errorf("copy: %w", sqlStateErr("22021"))
		}
	}
	ids := make([]int64, len(obs))
	for i, o := range obs {
		s.rows = append(s.rows, o)
		ids[i] = int64(len(s.rows))
	}
	return ids, nil
}

func (s *memSink) RecentObservation(_ context.Context, k [16]byte, since time.Time) (int64, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.rows {
		if r.ObservationKey == k && !r.ObservedAt.Before(since) {
			return int64(i + 1), true, nil
		}
	}
	return 0, false, nil
}

func (s *memSink) AddAlsoVia(_ context.Context, byRow map[int64][]string, _ time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for id, brokers := range byRow {
		r := s.rows[id-1]
		changed := false
		for _, b := range brokers {
			if b != r.BrokerID && !slices.Contains(r.Meta.AlsoVia, b) {
				r.Meta.AlsoVia = append(r.Meta.AlsoVia, b)
				changed = true
			}
		}
		if changed {
			n++
		}
	}
	return n, nil
}

func (s *memSink) row(i int) Observation { s.mu.Lock(); defer s.mu.Unlock(); return *s.rows[i] }

func (s *memSink) count() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.rows) }

type promoted struct {
	mu  sync.Mutex
	ids []security.Identity
}

func (p *promoted) Promote(id security.Identity) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ids = append(p.ids, id)
	return true
}

func newTestPipeline(t *testing.T, sink *memSink, queue int) (*Pipeline, *promoted) {
	pr := &promoted{}
	p := New(Config{QueueSize: queue, Workers: 2, BatchSize: 10, FlushEvery: 10 * time.Millisecond, ProcessOpts: opts(t, longFast)},
		sink, nil, nil, pr, observability.NewMetrics(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	return p, pr
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timeout")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// design §10.2 test 9 end to end through the pipeline, plus writer retry on DB
// failure: one row per gateway reception; a copy from another broker is
// recorded in also_via, a same-broker retry only counted.
func TestPipelineDedupeAndRetry(t *testing.T) {
	sink := &memSink{failNext: 2}
	p, _ := newTestPipeline(t, sink, 100)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	pk := pkt{from: 0x11111111, id: 5, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
	b := envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")
	for _, broker := range []string{"a", "b", "a"} { // same upload via two brokers + QoS retry
		m := msg(topicLF, b)
		m.BrokerID = broker
		p.Submit(m)
	}
	pk.gw, pk.snr = "!ccddeeff", -2
	p.Submit(msg("msh/EU_868/NO/Trøndelag/2/e/LongFast/!ccddeeff", envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")))

	waitFor(t, func() bool { return sink.count() == 2 })
	time.Sleep(50 * time.Millisecond)
	if sink.count() != 2 {
		t.Fatalf("want 2 observations (one per gateway), got %d", sink.count())
	}
	if sink.rows[0].LogicalKey != sink.rows[1].LogicalKey {
		t.Fatal("both gateways heard the same logical packet")
	}
	var gw1 *Observation
	for _, r := range sink.rows {
		if *r.Gateway == 0xaabbccdd {
			gw1 = r
		}
	}
	// Either broker may win the race; the other must be in also_via.
	brokers := append([]string{gw1.BrokerID}, gw1.Meta.AlsoVia...)
	slices.Sort(brokers)
	if !slices.Equal(brokers, []string{"a", "b"}) {
		t.Fatalf("broker provenance: first=%s also_via=%v", gw1.BrokerID, gw1.Meta.AlsoVia)
	}
	cancel()
	<-done
}

// A copy from another broker long after commit extends the row's also_via
// by primary key; a same-broker replay changes nothing.
func TestPipelineLateCrossBrokerProvenance(t *testing.T) {
	sink := &memSink{}
	p, _ := newTestPipeline(t, sink, 100)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	pk := pkt{from: 0x11111111, id: 9, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
	b := envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")
	send := func(broker string) {
		m := msg(topicLF, b)
		m.BrokerID = broker
		p.Submit(m)
	}
	send("a")
	waitFor(t, func() bool { return sink.count() == 1 })
	time.Sleep(50 * time.Millisecond)
	send("a") // replay on the same broker
	send("c")
	send("b")
	send("c")
	waitFor(t, func() bool { return len(sink.row(0).Meta.AlsoVia) == 2 })
	time.Sleep(100 * time.Millisecond)
	r := sink.row(0)
	got := append([]string(nil), r.Meta.AlsoVia...)
	slices.Sort(got)
	if sink.count() != 1 || r.BrokerID != "a" || !slices.Equal(got, []string{"b", "c"}) {
		t.Fatalf("rows=%d first=%s also_via=%v", sink.count(), r.BrokerID, r.Meta.AlsoVia)
	}
	cancel()
	<-done
}

func TestPipelineQueueFullDrops(t *testing.T) {
	sink := &memSink{}
	p, _ := newTestPipeline(t, sink, 2)
	for i := 0; i < 10; i++ { // not running: queue fills
		p.Submit(msg(topicLF, []byte{1}))
	}
	gaps := p.Gaps()
	if len(gaps) != 1 || gaps[0].Dropped != 8 || gaps[0].Reason != "queue_full" {
		t.Fatalf("gaps %+v", gaps)
	}
}

func TestPipelinePromotesAfterCommit(t *testing.T) {
	sink := &memSink{}
	p, pr := newTestPipeline(t, sink, 10)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	p.Submit(msg(topicLF, signedNodeInfoEnvelope(t, 1)))
	waitFor(t, func() bool { pr.mu.Lock(); defer pr.mu.Unlock(); return len(pr.ids) == 1 })
	if pr.ids[0].RowID != 1 {
		t.Fatalf("promotion must carry the committed row id, got %d", pr.ids[0].RowID)
	}
	cancel()
	<-done
}

func TestLiveEventCarriesTheRow(t *testing.T) {
	o := &Observation{Source: 7, PacketType: "position", ObservedAt: time.UnixMilli(1_800_000_000_123)}
	e := toLive(o, 42)
	if e.ID != 42 || e.Row == nil || e.Row.ID != 42 || e.Row.Source != 7 || e.Row.T != 1_800_000_000_123 || e.Row.Type != "position" {
		t.Fatalf("live event %+v row %+v", e, e.Row)
	}
}

// A shutdown during a database outage gives up after DrainTimeout instead
// of retrying until the process is killed; the lost rows become a gap.
func TestShutdownDuringOutageIsBounded(t *testing.T) {
	sink := &memSink{failNext: 1 << 30}
	p := New(Config{QueueSize: 10, Workers: 1, BatchSize: 10, FlushEvery: 5 * time.Millisecond, DrainTimeout: 300 * time.Millisecond, ProcessOpts: opts(t, longFast)},
		sink, nil, nil, nil, observability.NewMetrics(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	pk := pkt{from: 0x11111111, id: 9, to: 0xffffffff, gw: "!aabbccdd", data: posData(t), hopStart: 3, hopLimit: 3, snr: 5, rssi: -80}
	p.Submit(msg(topicLF, envelope(t, pk, security.DefaultPSK[:], security.ModeCTR, "LongFast")))
	waitFor(t, func() bool { return p.degraded.Load() })
	start := time.Now()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown hung while the database was down")
	}
	if d := time.Since(start); d < 250*time.Millisecond {
		t.Fatalf("gave up after %s, before the drain timeout", d)
	}
	if g := p.Gaps(); len(g) != 1 || g[0].Reason != "shutdown_db_unavailable" || g[0].Dropped != 1 {
		t.Fatalf("gaps %+v", g)
	}
}

// Copies of a committed reception arriving from two other brokers at once
// both end up as provenance, even when one arrives while the other is
// briefly claimed for the committed-check (it used to be dropped with that
// claim; seen as a flaky TestPipelineLateCrossBrokerProvenance in CI).
func TestConcurrentLateCopiesKeepProvenance(t *testing.T) {
	p, _ := newTestPipeline(t, &memSink{}, 10)
	for i := 0; i < 3000; i++ {
		var k [16]byte
		k[0], k[1] = byte(i), byte(i>>8)
		p.recent.add(k, 1, []string{"a"}, time.Now())
		var wg sync.WaitGroup
		for _, b := range []string{"b", "c"} {
			wg.Add(1)
			go func() { defer wg.Done(); p.claim(Observation{ObservationKey: k, BrokerID: b}) }()
		}
		wg.Wait()
		p.pendMu.Lock()
		got := append([]string(nil), p.pending[1]...)
		p.pending = map[int64][]string{}
		p.pendMu.Unlock()
		slices.Sort(got)
		if !slices.Equal(got, []string{"b", "c"}) {
			t.Fatalf("iteration %d: provenance %v, want [b c]", i, got)
		}
	}
}

// A row the database refuses (SQLSTATE class 22/23) is isolated and dropped
// instead of retrying its batch forever; the rest of the batch is stored.
func TestFlushDropsRowsTheDatabaseRefuses(t *testing.T) {
	sink := &memSink{refuse: func(o *Observation) bool { return o.Topic == "bad" }}
	p, _ := newTestPipeline(t, sink, 10)
	batch := make([]*Observation, 9)
	for i := range batch {
		batch[i] = &Observation{Topic: "ok", BrokerID: "a", ObservedAt: time.Now()}
		batch[i].ObservationKey[0] = byte(i)
		p.inflight[batch[i].ObservationKey] = "a"
	}
	batch[3].Topic, batch[7].Topic = "bad", "bad"
	done := make(chan struct{})
	go func() { p.flush(batch); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("flush kept retrying a batch the database refuses")
	}
	if sink.count() != 7 {
		t.Fatalf("stored %d rows, want 7", sink.count())
	}
	if len(p.inflight) != 0 {
		t.Fatalf("claims left in flight: %d", len(p.inflight))
	}
	if sink.attempts > 20 {
		t.Fatalf("%d insert attempts for 9 rows", sink.attempts)
	}
	// Transient and partition errors stay retryable.
	if permanent(errors.New("db down")) || permanent(sqlStateErr("08006")) || permanent(fmt.Errorf("no partition of relation \"packet_log\" found for row: %w", sqlStateErr("23514"))) {
		t.Fatal("transient error classed as permanent")
	}
	if !permanent(sqlStateErr("23502")) {
		t.Fatal("integrity error classed as transient")
	}
}
