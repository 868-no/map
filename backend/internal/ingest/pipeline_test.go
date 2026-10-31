package ingest

import (
	"context"
	"errors"
	"github.com/868-no/map/internal/protocol/ports"
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
}

func (s *memSink) InsertBatch(_ context.Context, obs []*Observation) ([]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failNext > 0 {
		s.failNext--
		return nil, errors.New("db down")
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

func (s *memSink) AddAlsoVia(_ context.Context, byRow map[int64][]string) (int64, error) {
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

// §17 test 9 end to end through the pipeline, plus writer retry on DB
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

func TestLiveEventTraceroutePath(t *testing.T) {
	o := &Observation{Source: 1, PacketType: "traceroute"}
	o.Meta.Traceroute = &ports.Traceroute{Valid: true, Route: []ports.Hop{{ID: 0xa}}, RouteBack: []ports.Hop{{ID: 0xb}, {ID: 0xFFFFFFFF, Unknown: true}, {ID: 0xc}}}
	if p := toLive(o, 1).Path; len(p) != 1 || p[0] != "!0000000a" {
		t.Fatalf("request path %v", p)
	}
	o.Meta.Traceroute.IsReply = true
	if p := toLive(o, 1).Path; len(p) != 3 || p[0] != "!0000000b" || p[1] != "" || p[2] != "!0000000c" {
		t.Fatalf("reply path %v", p)
	}
	o.Meta.Traceroute.Valid = false
	if p := toLive(o, 1).Path; p != nil {
		t.Fatalf("invalid traceroute must carry no path, got %v", p)
	}
	if p := toLive(&Observation{Source: 1}, 1).Path; p != nil {
		t.Fatal("non-traceroute must carry no path")
	}
}
